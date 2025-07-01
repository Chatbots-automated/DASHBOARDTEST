/**
 * /api/monday.js
 * Pull EVERY item from groups  new_group50055 / new_group89286,
 * bucket them by “status6” (B2C / B2B), return totals + rows.
 */
export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV ──────────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  /* ── IDs ──────────────────────────────────── */
  const BOARD_ID  = 1645436514;
  const GROUP_IDS = ['new_group50055','new_group89286'];

  const TYPE_ID   = 'status6';            // B2C | B2B
  const EUR_ID    = 'formula_mkmp4x00';   // €
  const DATE_ID   = 'date8';              // install date

  const TYPE_LABELS = { B2C:'B2C', B2B:'B2B' }; // accepted labels

  /* ── tiny gql helper ─────────────────────── */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  async function gql (query, vars={}) {
    const r = await fetch('https://api.monday.com/v2',{
      method:'POST',headers:HEADERS,body:JSON.stringify({query,variables:vars})
    });
    const j = await r.json();
    if (j.errors){ console.error(j.errors); throw new Error('Monday API error'); }
    return j.data;
  }

  /* ── 1️⃣ collect ALL IDs inside a group ──── */
  async function collectIds(groupId){
    const ids = [];

    /* first page – variable type is **[ID!]!**  ✅ */
    const first = await gql(/* GraphQL */`
      query($bid:[ID!]!, $gid:String!){
        boards(ids:$bid){
          groups(ids:[$gid]){
            items_page(limit:500){
              cursor items{ id }
            }
          }
        }
      }`, { bid:[BOARD_ID], gid:groupId });

    const entry = first?.boards?.[0]?.groups?.[0]?.items_page;
    if (!entry) return ids;                   // no items at all

    ids.push(...entry.items.map(i=>i.id));
    let cursor = entry.cursor;

    /* paginate with next_items_page */
    while (cursor){
      const step = await gql(/* GraphQL */`
        query($cursor:String!){
          next_items_page(limit:500,cursor:$cursor){
            cursor items{ id }
          }
        }`,{cursor});
      const page = step.next_items_page;
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
    }
    return ids;
  }

  /* ── 2️⃣ hydrate IDs & bucket by type ─────── */
  const euro = raw =>
    !raw||raw==='No result' ? null
      : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  async function hydrate(allIds){
    const out = {B2C:[], B2B:[]};

    for(let i=0;i<allIds.length;i+=100){
      const slice = allIds.slice(i,i+100);
      const d = await gql(/* GraphQL */`
        query($ids:[ID!]!){
          items(ids:$ids){
            id name
            column_values(ids:["${EUR_ID}","${TYPE_ID}","${DATE_ID}"]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`,{ids:slice});

      for(const it of d.items||[]){
        const cv = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const lbl= cv[TYPE_ID]?.label;
        if (!TYPE_LABELS[lbl]) continue;

        const num = euro(cv[EUR_ID]?.display_value);
        if (num==null) continue;

        out[lbl].push({
          id:it.id, name:it.name, type:lbl,
          installation_date:cv[DATE_ID]?.date??null,
          sum_eur:num
        });
      }
    }

    /* build meta */
    const make = k => {
      const arr = out[k];
      const tot = arr.reduce((s,r)=>s+r.sum_eur,0);
      return { meta:{type:k,total_items:arr.length,total_sum_eur:+tot.toFixed(2)}, items:arr };
    };
    return { b2c:make('B2C'), b2b:make('B2B') };
  }

  /* ── RUN ──────────────────────────────────── */
  try{
    const idSets = await Promise.all(GROUP_IDS.map(collectIds));
    const unique = [...new Set(idSets.flat())];     // deduplicate if an item lives in both groups
    const data   = await hydrate(unique);
    res.status(200).json(data);
  }catch(e){
    res.status(500).json({error:'Monday API error',details:e.message||e});
  }
}
