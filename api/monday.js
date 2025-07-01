/**
 * /api/monday.js
 * Fetch ALL items inside the two “sales” groups, separate them
 * into B2C / B2B by the `status6` column, and return totals + rows.
 */
export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV ──────────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error:'MONDAY_API_KEY missing' });
  }

  /* ── board / column / group IDs ───────────── */
  const BOARD_ID      = 1645436514;
  const TYPE_ID       = 'status6';          // B2C | B2B labels
  const EUR_ID        = 'formula_mkmp4x00'; // € column
  const DATE_ID       = 'date8';            // installation date

  const GROUP_IDS     = ['new_group50055','new_group89286']; // ← only these groups
  const TYPE_LABELS   = { 'B2C':'B2C', 'B2B':'B2B' };        // accepted labels

  /* ── GraphQL helper ───────────────────────── */
  const HEADERS = { Authorization:API_KEY, 'Content-Type':'application/json' };
  async function gql (query, variables = {}) {
    const rsp = await fetch('https://api.monday.com/v2', {
      method:'POST', headers:HEADERS, body:JSON.stringify({query,variables})
    });
    const json = await rsp.json();
    if (json.errors) {
      console.error('⛔️ Monday API error\n', JSON.stringify(json.errors,null,2));
      throw new Error('Monday API error');
    }
    return json.data;
  }

  /* ── 1️⃣ collect ALL item-IDs in each group ─ */
  async function collectGroupIds (groupId) {
    const ids   = [];

    /* first page */
    const first = await gql(/* GraphQL */`
      query ($board:ID!, $gid:String!){
        boards(ids:$board){
          groups(ids:[$gid]){
            items_page(limit:500){
              cursor
              items{ id }
            }
          }
        }
      }`, { board:BOARD_ID, gid:groupId });

    const entry = first?.boards?.[0]?.groups?.[0]?.items_page;
    if (!entry) return ids;

    ids.push(...entry.items.map(i=>i.id));
    let cursor = entry.cursor;

    /* keep paginating with next_items_page */
    while (cursor) {
      const step = await gql(/* GraphQL */`
        query ($cursor:String!){
          next_items_page(limit:500, cursor:$cursor){
            cursor items{ id }
          }
        }`, { cursor });

      const page = step.next_items_page;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
    }
    return ids;
  }

  /* ── 2️⃣ hydrate IDs, categorise & normalise € ─ */
  function euroToFloat(raw){
    if (!raw || raw==='No result') return null;
    return parseFloat(
      raw.replace(/[.\s\u00A0]/g,'').replace(',','.')
    );
  }

  async function hydrate(ids){
    const buckets = { B2C:[], B2B:[] };

    for (let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100);

      const data = await gql(/* GraphQL */`
        query ($ids:[ID!]!){
          items(ids:$ids){
            id name
            column_values(ids:[
              "${EUR_ID}",
              "${TYPE_ID}",
              "${DATE_ID}"
            ]){
              id
              ... on FormulaValue {display_value}
              ... on StatusValue  {label}
              ... on DateValue    {date}
            }
          }
        }`, { ids:slice });

      for (const it of (data.items || [])){
        const cv  = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const typeLabel = TYPE_LABELS[cv[TYPE_ID]?.label] ?? null;
        if (!typeLabel) continue;                    // skip unknown types

        const num = euroToFloat(cv[EUR_ID]?.display_value);
        if (num==null) continue;

        buckets[typeLabel].push({
          id  : it.id,
          name: it.name,
          type: typeLabel,
          installation_date : cv[DATE_ID]?.date ?? null,
          sum_eur : num
        });
      }
    }
    /* build meta */
    const result = {};
    for (const key of Object.keys(buckets)){
      const arr = buckets[key];
      const total = arr.reduce((s,r)=>s+r.sum_eur,0);
      result[key.toLowerCase()] = {
        meta : {
          type : key,
          total_items   : arr.length,
          total_sum_eur : +total.toFixed(2)
        },
        items: arr
      };
    }
    return result;
  }

  /* ── RUN ──────────────────────────────────── */
  try{
    /* gather IDs from both groups */
    const groupIdsArrays = await Promise.all(GROUP_IDS.map(collectGroupIds));
    const allIds         = [...new Set(groupIdsArrays.flat())];   // dedup

    const dataByType = await hydrate(allIds);

    res.status(200).json(dataByType);
  }catch(err){
    res.status(500).json({ error:'Monday API error', details:err.message||err });
  }
}
