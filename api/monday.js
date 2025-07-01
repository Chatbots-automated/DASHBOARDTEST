/**
 * /api/monday.js
 * Get every B2C / B2B item whose main status is
 * “Įrengta” or “Atsiskaityta su partneriu”.
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
    return res.status(500).json({error:'MONDAY_API_KEY missing'});
  }

  /* ── IDs & labels ─────────────────────────── */
  const BOARD_ID  = 1645436514;
  const STATUS_ID = 'status';      // main status
  const TYPE_ID   = 'status6';     // B2C / B2B
  const EUR_ID    = 'formula_mkmp4x00';
  const DATE_ID   = 'date8';

  const STATUS_LABELS = ['Įrengta', 'Atsiskaityta su partneriu'];
  const TYPE_LABELS   = { 1:'B2C', 2:'B2B' };

  /* ── tiny GraphQL helper ───────────────────── */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  async function gql (query, variables = {}) {
    const r = await fetch('https://api.monday.com/v2', {
      method:'POST', headers:HEADERS,
      body:JSON.stringify({query,variables})
    });
    const j = await r.json();
    if (j.errors) {
      console.error(j.errors);
      throw new Error('Monday API error');
    }
    return j.data;
  }

  /* ── 1️⃣  collect every item-ID for a type ── */
  async function collectIds (typeLabel) {
    const ids   = [];

    /* initial filtered page */
    const first = await gql(/* GraphQL */`
      query ($board:ID!){
        items_page_by_column_values(
          board_id:$board, limit:500,
          columns:[
            {column_id:"${STATUS_ID}", column_values:${JSON.stringify(STATUS_LABELS)}},
            {column_id:"${TYPE_ID}",   column_values:["${typeLabel}"]}
          ]
        ){
          cursor
          items{ id }
        }
      }`, {board:BOARD_ID});

    const start = first.items_page_by_column_values;
    if (!start) return ids;

    ids.push(...start.items.map(i=>i.id));
    let cursor = start.cursor;

    /* follow cursor with next_items_page */
    while (cursor) {
      const step = await gql(/* GraphQL */`
        query ($cursor:String!){
          next_items_page(limit:500,cursor:$cursor){
            cursor
            items{ id }
          }
        }`, {cursor});
      const page = step.next_items_page;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;          // null when done
    }
    return ids;
  }

  /* ── 2️⃣  hydrate in 100-ID batches ───────── */
  function euroToFloat(raw){
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
              "${EUR_ID}",
              "${STATUS_ID}",
              "${TYPE_ID}",
              "${DATE_ID}"
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
        const num = euroToFloat(cv[EUR_ID]?.display_value);
        if(num==null) continue;
        rows.push({
          id:it.id,
          name:it.name,
          status:cv[STATUS_ID]?.label??null,
          type:label,
          installation_date:cv[DATE_ID]?.date??null,
          sum_eur:num
        });
      }
    }
    const total = rows.reduce((s,r)=>s+r.sum_eur,0);
    return {meta:{type:label,total_items:rows.length,
                  total_sum_eur:+total.toFixed(2)},items:rows};
  }

  /* ── RUN ───────────────────────────────────── */
  try{
    const [b2cIds,b2bIds] = await Promise.all([
      collectIds(TYPE_LABELS[1]),   // "B2C"
      collectIds(TYPE_LABELS[2])    // "B2B"
    ]);

    const [b2c,b2b] = await Promise.all([
      hydrate(b2cIds,'B2C'),
      hydrate(b2bIds,'B2B')
    ]);

    res.status(200).json({b2c,b2b});
  }catch(err){
    res.status(500).json({error:'Monday API error',details:err.message||err});
  }
}
