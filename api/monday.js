// /api/monday.js   –  no TS-only syntax
export default async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ---------- CONFIG ---------- */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) {
    console.error('env var MONDAY_API_KEY is missing');
    return res.status(500).json({error:'Server mis-config'});
  }

  const BOARD_ID          = 1645436514;
  const STATUS_COLUMN_ID  = 'status';        // Įrengta = 1, Atsiskaityta = 6
  const TYPE_COLUMN_ID    = 'status6';       // B2C = 1, B2B = 2
  const FORMULA_COLUMN_ID = 'formula_mkmp4x00';
  const DATE_COLUMN_ID    = 'date8';

  const HEADERS = {
    Authorization : API_KEY,
    'Content-Type': 'application/json'
  };

  /* ---------- helper to run GraphQL ---------- */
  async function gql(query){
    const r  = await fetch('https://api.monday.com/v2',
      {method:'POST', headers:HEADERS, body:JSON.stringify({query})});
    const txt = await r.text();
    const json= JSON.parse(txt);
    if (json.errors) throw new Error(JSON.stringify(json.errors,null,2));
    return json.data;
  }

  /* ---------- 1️⃣  collect *all* item IDs for a type ---------- */
  async function collectIds(typeIdx){
    const ids = [];

    // first filtered page
    let page = await gql(`
      query{
        boards(ids:${BOARD_ID}){
          items_page(limit:500,
            query_params:{rules:[
              {column_id:"${STATUS_COLUMN_ID}",compare_value:[1,6],operator:any_of},
              {column_id:"${TYPE_COLUMN_ID}",compare_value:[${typeIdx}],operator:any_of}
            ]}
          ){
            cursor items{ id }
          }
        }
      }`).boards[0].items_page;

    ids.push(...page.items.map(i=>i.id));
    let cursor = page.cursor;

    // follow the cursor until null
    while(cursor){
      const next = await gql(`
        query{
          next_items_page(limit:500, cursor:"${cursor}"){
            cursor items{ id }
          }
        }`).next_items_page;
      ids.push(...next.items.map(i=>i.id));
      cursor = next.cursor;
    }
    return ids;
  }

  /* ---------- 2️⃣  fetch details in 100-item batches ---------- */
  async function hydrate(ids,label){
    const rows = [];
    for(let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100).join(',');
      const items = await gql(`
        query{
          items(ids:[${slice}]){
            id name
            column_values(ids:[
              "${FORMULA_COLUMN_ID}",
              "${STATUS_COLUMN_ID}",
              "${TYPE_COLUMN_ID}",
              "${DATE_COLUMN_ID}"
            ]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`).items;

      for(const it of items){
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const raw  = cv[FORMULA_COLUMN_ID]?.display_value ?? '';
        if (!raw || raw==='No result') continue;

        // normalise EU number “1.234.567,89”  /  “123,45”
        const num = parseFloat(
          (raw.match(/\./g)||[]).length>=2
            ? raw.replace(/\./g,'').replace(',','.')
            : raw.replace(',','.')
        );
        if (Number.isNaN(num)) continue;

        rows.push({
          id : it.id,
          name : it.name,
          status : cv[STATUS_COLUMN_ID]?.label ?? null,
          type   : label,
          installation_date : cv[DATE_COLUMN_ID]?.date ?? null,
          sum_eur : num
        });
      }
    }
    const total = rows.reduce((s,r)=>s+r.sum_eur,0);
    return {
      meta : { type:label, total_items:rows.length,
               total_sum_eur:+total.toFixed(2) },
      items: rows
    };
  }

  /* ---------- RUN ---------- */
  try{
    const [b2cIds,b2bIds] = await Promise.all([collectIds(1),collectIds(2)]);
    const [b2c,b2b]       = await Promise.all([hydrate(b2cIds,'B2C'),
                                               hydrate(b2bIds,'B2B')]);
    res.status(200).json({b2c,b2b});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'monday API error',details:e.message||e});
  }
}
