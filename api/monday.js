/**
 * /api/monday.js
 * Fetch every item that lives in groups new_group50055 / new_group89286
 * and bucket them by status6 →  B2C • B2B • Other
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

  /* ── IDs & constants ──────────────────────── */
  const BOARD_ID  = 1645436514;
  const GROUP_IDS = ['new_group50055','new_group89286'];      // ← scope
  const TYPE_COL  = 'status6';           // holds B2C / B2B label
  const EUR_COL   = 'formula_mkmp4x00';  // €
  const DATE_COL  = 'date8';             // installation date
  const VALID     = new Set(['B2C','B2B']);

  /* ── helpers ──────────────────────────────── */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};

  async function gql(query, variables = undefined) {
    const body = variables ? { query, variables } : { query };
    while (true) {
      const r = await fetch('https://api.monday.com/v2',
                 {method:'POST', headers:HEADERS, body:JSON.stringify(body)});
      if (r.status === 429) {                         // minute-limit ⇒ back-off
        const wait = (+r.headers.get('Retry-After') || 1)*1000;
        await new Promise(t=>setTimeout(t, wait));
        continue;
      }
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors,null,2));
      return j.data;
    }
  }

  const euro = raw =>
    !raw || raw === 'No result'
      ? null
      : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /* ── 1️⃣  collect EVERY id in the groups ──── */
  async function collectIds() {
    const groupRule = GROUP_IDS.map(g=>`"${g}"`).join(',');
    const ids = [];

    let page = await gql(`
      query{
        boards(ids:${BOARD_ID}){
          items_page(
            limit:500
            query_params:{rules:[
              {column_id:"group",compare_value:[${groupRule}],operator:any_of}
            ]}
          ){
            cursor items{ id }
          }
        }
      }`).boards?.[0]?.items_page;

    if (!page) return ids;
    ids.push(...page.items.map(i=>i.id));

    while (page.cursor) {
      page = await gql(`
        query{
          next_items_page(limit:500,cursor:"${page.cursor}"){
            cursor items{ id }
          }
        }`).next_items_page;
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i=>i.id));
    }
    return ids;
  }

  /* ── 2️⃣  hydrate & bucket ─────────────────── */
  async function hydrate(allIds) {
    const bucket = { B2C:[], B2B:[], Other:[] };

    for (let i = 0; i < allIds.length; i += 100) {
      const slice = allIds.slice(i, i+100);
      const d = await gql(`
        query($ids:[ID!]!){
          items(ids:$ids){
            id name
            column_values(ids:["${EUR_COL}","${TYPE_COL}","${DATE_COL}"]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`, { ids: slice });

      for (const it of d.items || []) {
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const rawT = cv[TYPE_COL]?.label;
        const type = VALID.has(rawT) ? rawT : 'Other';      // 🔹 default bucket
        const rawN = euro(cv[EUR_COL]?.display_value);
        const num  = rawN != null ? rawN : 0;               // 🔹 default 0

        bucket[type].push({
          id  : it.id,
          name: it.name,
          type,
          installation_date: cv[DATE_COL]?.date ?? null,
          sum_eur: num
        });
      }
    }

    /* build response */
    const pack = t=>{
      const arr=bucket[t], tot=arr.reduce((s,r)=>s+r.sum_eur,0);
      return { meta:{type:t,total_items:arr.length,total_sum_eur:+tot.toFixed(2)}, items:arr };
    };
    return { b2c:pack('B2C'), b2b:pack('B2B'), other:pack('Other') };
  }

  /* ── RUN ───────────────────────────────────── */
  try {
    const ids  = await collectIds();                  // get every id (no skips)
    const data = await hydrate(ids);                  // hydrate & bucket
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({error:'Monday API error', details:e.message||e});
  }
}
