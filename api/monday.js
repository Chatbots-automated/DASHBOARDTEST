/**
 * /api/monday.js
 * Fetch *all* items that live in groups new_group50055 / new_group89286,
 * bucket them by “status6” (B2C / B2B), and return totals + raw rows.
 */
export default async function handler(req, res) {
  /* –– CORS –– */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* –– ENV –– */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  /* –– IDs & labels –– */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286']; // <- target groups
  const TYPE_COL   = 'status6';           // B2C / B2B
  const EUR_COL    = 'formula_mkmp4x00';  // €
  const DATE_COL   = 'date8';
  const ACCEPTED   = new Set(['B2C','B2B']);

  /* –– tiny gql helper w/ back-off –– */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  async function gql(query){
    while (true) {
      const r  = await fetch('https://api.monday.com/v2',
                  {method:'POST',headers:HEADERS,body:JSON.stringify({query})});
      if (r.status === 429) {                        // minute-rate hit
        const wait = (+r.headers.get('Retry-After')||1)*1000;
        await new Promise(t=>setTimeout(t,wait));    // back-off
        continue;
      }
      const j = await r.json();
      if (j.errors){
        const code = j.errors[0]?.extensions?.code || '';
        if (code.includes('Complexity') || code.includes('Rate')) {
          // wait 1 s – lets the sliding window refill
          await new Promise(t=>setTimeout(t, 1100));
          continue;
        }
        console.error(j.errors); throw new Error('Monday API error');
      }
      return j.data;
    }
  }

  const euro = raw => !raw||raw==='No result'
                        ? null
                        : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /* –– 1️⃣  gather every item-id in the two groups –– */
  async function gatherIds() {
    const ids = [];

    // literal list of group ids inside the rule ↓
    const rule   = GROUP_IDS.map(g=>`"${g}"`).join(',');

    /* first page */
    let page = await gql(`
      query {
        boards(ids:${BOARD_ID}) {
          items_page(
            limit:500,
            query_params:{rules:[
              {column_id:"group",compare_value:[${rule}],operator:any_of}
            ]}
          ){
            cursor
            items{ id }
          }
        }
      }`).boards[0].items_page;

    ids.push(...page.items.map(i=>i.id));
    let cursor = page.cursor;

    /* follow the board-level cursor until null */
    while (cursor) {
      page = await gql(`
        query{
          next_items_page(limit:500,cursor:"${cursor}"){
            cursor items{ id }
          }
        }`).next_items_page;
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
    }
    return ids;
  }

  /* –– 2️⃣  hydrate in 100-id batches –– */
  async function hydrate(allIds){
    const bucket = {B2C:[], B2B:[]};

    for (let i=0;i<allIds.length;i+=100){
      const slice = allIds.slice(i,i+100).join(',');
      const d = await gql(`
        query{
          items(ids:[${slice}]){
            id name
            column_values(ids:["${EUR_COL}","${TYPE_COL}","${DATE_COL}"]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`);
      for (const it of d.items){
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const type = cv[TYPE_COL]?.label;
        if (!ACCEPTED.has(type)) continue;

        const num = euro(cv[EUR_COL]?.display_value);
        if (num==null) continue;

        bucket[type].push({
          id:it.id,
          name:it.name,
          type,
          installation_date:cv[DATE_COL]?.date ?? null,
          sum_eur:num
        });
      }
    }

    const wrap = t=>{
      const arr = bucket[t], tot = arr.reduce((s,r)=>s+r.sum_eur,0);
      return { meta:{type:t,total_items:arr.length,total_sum_eur:+tot.toFixed(2)}, items:arr };
    };
    return { b2c:wrap('B2C'), b2b:wrap('B2B') };
  }

  /* –– RUN –– */
  try{
    const ids   = await gatherIds();          // 👈 now truly every item
    const data  = await hydrate(ids);
    res.status(200).json(data);
  }catch(e){
    res.status(500).json({error:'Monday API error',details:e.message||e});
  }
}
