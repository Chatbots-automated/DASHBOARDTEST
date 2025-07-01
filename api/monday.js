/**
 * /api/monday.js
 * – returns every B2C / B2B item whose main status is
 *   “Įrengta” or “Atsiskaityta su partneriu”.
 */
export default async function handler (req, res) {
  /* ── CORS ───────────────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV / BOARD CONFIG ─────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  const BOARD_ID           = 1645436514;
  const STATUS_COL_ID      = 'status';        // main status
  const TYPE_COL_ID        = 'status6';       // B2C/B2B
  const FORMULA_COL_ID     = 'formula_mkmp4x00';
  const DATE_COL_ID        = 'date8';

  const LABELS_STATUS      = ['Įrengta', 'Atsiskaityta su partneriu'];
  const LABELS_TYPE        = { 1:'B2C', 2:'B2B' };

  /* ── GraphQL helper ─────────────────────────────────── */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  async function gql (query, variables={}) {
    const r = await fetch('https://api.monday.com/v2',{
      method:'POST', headers:HEADERS,
      body:JSON.stringify({query,variables})
    });
    const t = await r.text();
    const j = JSON.parse(t);
    if (j.errors) {
      console.error(j.errors);
      throw new Error('Monday API error');
    }
    return j.data;
  }

  /* ── 1️⃣  collect IDs for a client-type ─────────────── */
  async function collectIds (typeLabel){
    let ids=[], cursor=null;
    do{
      const q = await gql(/* GraphQL */`
        query ($board:ID!,$cursor:String){
          items_page_by_column_values(
            board_id:$board, limit:500, cursor:$cursor,
            columns:[
              {column_id:"${STATUS_COL_ID}", column_values:${JSON.stringify(LABELS_STATUS)}},
              {column_id:"${TYPE_COL_ID}",   column_values:["${typeLabel}"]}
            ]
          ){
            cursor
            items{ id }
          }
        }`,{board:BOARD_ID,cursor});
      const page = q.items_page_by_column_values;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
    }while(cursor);
    return ids;
  }

  /* ── 2️⃣  hydrate details in 100-ID batches ──────────── */
  function toFloat(raw){
    if(!raw || raw==='No result') return null;
    return parseFloat(
      raw.replace(/[.\s\u00A0]/g,'').replace(',','.')
    );
  }

  async function hydrate(ids,label){
    const rows=[];
    for(let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100);
      const d = await gql(/* GraphQL */`
        query ($ids:[Int!]){
          items(ids:$ids){
            id name
            column_values(ids:[
              "${FORMULA_COL_ID}",
              "${STATUS_COL_ID}",
              "${TYPE_COL_ID}",
              "${DATE_COL_ID}"
            ]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`,{ids:slice});

      for(const it of d.items){
        const cv = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const num = toFloat(cv[FORMULA_COL_ID]?.display_value);
        if(num==null) continue;
        rows.push({
          id:it.id,
          name:it.name,
          status:cv[STATUS_COL_ID]?.label??null,
          type:label,
          installation_date:cv[DATE_COL_ID]?.date??null,
          sum_eur:num
        });
      }
    }
    const total = rows.reduce((s,r)=>s+r.sum_eur,0);
    return {meta:{type:label,total_items:rows.length,
                  total_sum_eur:+total.toFixed(2)},items:rows};
  }

  /* ── RUN ─────────────────────────────────────────────── */
  try{
    const [b2cIds,b2bIds] = await Promise.all([
      collectIds(LABELS_TYPE[1]),           // "B2C"
      collectIds(LABELS_TYPE[2])            // "B2B"
    ]);
    const [b2c,b2b]   = await Promise.all([
      hydrate(b2cIds,'B2C'),
      hydrate(b2bIds,'B2B')
    ]);
    res.status(200).json({b2c,b2b});
  }catch(e){
    res.status(500).json({error:'monday API error',details:e.message||e});
  }
}
