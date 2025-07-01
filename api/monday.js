/**
 * /api/monday.js   ──  DEBUG build ───────────────────────────────
 */
export default async function handler(req, res) {
  /*──────────────────── CORS */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /*──────────────────── ENV check */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) {
    console.error('⛔️  env MONDAY_API_KEY missing');
    return res.status(500).json({error:'MONDAY_API_KEY missing'});
  }

  /*──────────────────── IDs */
  const BOARD_ID  = 1645436514;
  const GROUP_IDS = ['new_group50055','new_group89286'];

  const TYPE_COL  = 'status6';          // B2C / B2B
  const EUR_COL   = 'formula_mkmp4x00'; // €
  const DATE_COL  = 'date8';
  const ACCEPTED  = new Set(['B2C','B2B']);

  /*──────────────────── helpers */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};

  async function gql(query, variables = undefined) {
    console.log('→ gql:', query.replace(/\s+/g,' ').slice(0,120)+'…');
    const body = variables ? { query, variables } : { query };
    while (true) {
      const r = await fetch('https://api.monday.com/v2',
                {method:'POST', headers:HEADERS, body:JSON.stringify(body)});
      if (r.status === 429) {                         // minute-rate
        const wait = (+r.headers.get('Retry-After') || 1)*1000;
        console.log(`⚠️  429 – waiting ${wait}ms`);
        await new Promise(t=>setTimeout(t, wait));
        continue;
      }
      const txt = await r.text();
      console.log('← raw json:', txt.slice(0,200)+'…');
      const j   = JSON.parse(txt);
      if (j.errors) {
        const code = j.errors[0]?.extensions?.code;
        console.error('⛔️  GraphQL error', j.errors);
        if (code?.includes('Complexity') || code?.includes('Rate')) {
          await new Promise(t=>setTimeout(t,1100));   // back-off
          continue;
        }
        throw new Error('Monday API error');
      }
      return j.data;
    }
  }

  const euro = raw => !raw||raw==='No result'
                       ? null
                       : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /*──────────────────── 1️⃣ gather ALL ids from both groups */
  async function gatherIds() {
    const rule = GROUP_IDS.map(g=>`"${g}"`).join(',');
    const first = await gql(`
      query {
        complexity { before after query }         # debug
        boards(ids:${BOARD_ID}) {
          items_page(
            limit:500
            query_params:{rules:[
              {column_id:"group",compare_value:[${rule}],operator:any_of}
            ]}
          ){
            cursor
            items { id }
          }
        }
      }`);
    const page0 = first?.boards?.[0]?.items_page;
    if (!page0) {
      console.error('⚠️  No items_page returned'); return [];
    }
    const ids = page0.items.map(i=>i.id);
    console.log(`page-0 : got ${ids.length} ids`);
    let cursor = page0.cursor;

    while (cursor) {
      const next = await gql(`
        query { next_items_page(limit:500, cursor:"${cursor}") {
          cursor items { id } } }`);
      const page = next.next_items_page;
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i=>i.id));
      console.log(`page-n : +${page.items.length}  (total ${ids.length})`);
      cursor = page.cursor;
    }
    return ids;
  }

  /*──────────────────── 2️⃣ hydrate & bucket */
  async function hydrate(allIds) {
    const bucket = {B2C:[], B2B:[]};

    for (let i=0;i<allIds.length;i+=100) {
      const slice = allIds.slice(i,i+100);
      console.log(`hydrating IDs ${i}‒${i+slice.length-1}`);
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
        }`, {ids: slice});

      for (const it of d.items || []) {
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const type = cv[TYPE_COL]?.label;
        if (!ACCEPTED.has(type)) continue;
        const num  = euro(cv[EUR_COL]?.display_value);
        if (num==null) continue;

        bucket[type].push({
          id:it.id, name:it.name, type,
          installation_date:cv[DATE_COL]?.date ?? null,
          sum_eur:num
        });
      }
    }
    const pack = t=>{
      const arr=bucket[t], tot=arr.reduce((s,r)=>s+r.sum_eur,0);
      return {meta:{type:t,total_items:arr.length,total_sum_eur:+tot.toFixed(2)},items:arr};
    };
    return {b2c:pack('B2C'), b2b:pack('B2B')};
  }

  /*──────────────────── RUN */
  try {
    const ids  = await gatherIds();
    console.log(`◎ gathered total ids: ${ids.length}`);
    const data = await hydrate(ids);
    res.status(200).json(data);
  } catch (e) {
    console.error('💥 top-level catch', e);
    res.status(500).json({error:'Monday API error',details:e.message||e});
  }
}
