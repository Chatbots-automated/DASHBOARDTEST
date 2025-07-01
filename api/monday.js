export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV CHECK ────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) {
    console.error('❌  env var MONDAY_API_KEY is missing');
    return res.status(500).json({error:'MONDAY_API_KEY missing'});
  }

  /* ── CONSTANTS ────────────────────────────── */
  const BOARD_ID   = 1645436514;
  const GROUPS     = ['new_group50055','new_group89286'];      // 🎯
  const TYPE_COL   = 'status6';      // B2C / B2B label
  const NUM_COL    = 'numbers';      // deal value w/o VAT
  const DATE_COL   = 'date8';        // installation date
  const VALID_TYPE = new Set(['B2C','B2B']);

  /* ── tiny GraphQL helper w/ back-off + logs ─ */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  async function gql (query, variables = undefined) {
    const body = variables ? { query, variables } : { query };
    while (true) {
      const rsp = await fetch('https://api.monday.com/v2',
                  {method:'POST', headers:HEADERS, body:JSON.stringify(body)});
      if (rsp.status === 429) {                     // minute-limit
        const wait = (+rsp.headers.get('Retry-After') || 1)*1000;
        console.warn(`🔄  429 received – waiting ${wait/1000}s`);
        await new Promise(t=>setTimeout(t, wait));
        continue;
      }
      const json = await rsp.json();
      if (json.errors) {
        console.error('⛔️ Monday error', JSON.stringify(json.errors,null,2));
        throw new Error('Monday API error');
      }
      return json.data;
    }
  }

  /* ── util: EU-number → float, blank → null ─ */
  const parseNum = raw =>
      !raw || raw === 'No result'
        ? null
        : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /* ── 1️⃣  collect every ID in ONE group ───── */
  async function idsFromGroup(gid){
    console.log(`\n🔍  Collecting IDs for group ${gid}`);
    const all = [];

    /* page 0 */
    let page = await gql(`
      query {
        boards(ids:${BOARD_ID}) {
          groups(ids:["${gid}"]) {
            items_page(limit:500) {
              cursor
              items { id }
            }
          }
        }
      }`).boards?.[0]?.groups?.[0]?.items_page;

    if (!page) { console.warn(`⚠️  group ${gid} not found / empty`); return all; }

    all.push(...page.items.map(i=>i.id));
    console.log(`   • page 0 → +${page.items.length} (total ${all.length})`);
    let cursor = page.cursor;

    /* follow cursor chain */
    let p = 1;
    while (cursor) {
      page = await gql(`
        query{
          next_items_page(limit:500,cursor:"${cursor}"){
            cursor items{ id }
          }
        }`).next_items_page;

      const got = page?.items?.length ?? 0;
      if (!got) break;

      all.push(...page.items.map(i=>i.id));
      console.log(`   • page ${p} → +${got} (total ${all.length})`);
      cursor = page.cursor;
      p += 1;
    }
    console.log(`✅  group ${gid} done – ${all.length} IDs\n`);
    return all;
  }

  /* ── 2️⃣  hydrate & bucket ─────────────────── */
  async function hydrate(ids){
    const bucket = {B2C:[], B2B:[], Other:[]};

    for (let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100);
      console.log(`📦  batch ${i/100} → fetching ${slice.length} items`);

      const d = await gql(`
        query($ids:[ID!]!){
          items(ids:$ids){
            id name
            column_values(ids:["${NUM_COL}","${TYPE_COL}","${DATE_COL}"]){
              id
              ... on NumbersValue { number }     # use .number for true numeric!
              ... on StatusValue  { label }
              ... on DateValue    { date }
            }
          }
        }`, { ids: slice });

      console.log(`     ↳ API returned ${d.items.length} items`);

      for (const it of d.items){
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const type = VALID_TYPE.has(cv[TYPE_COL]?.label) ? cv[TYPE_COL].label : 'Other';
        const num  = cv[NUM_COL]?.number ?? 0;            // ← NumbersValue.number
        bucket[type].push({
          id:it.id, name:it.name, type,
          installation_date:cv[DATE_COL]?.date ?? null,
          sum_eur:num
        });
      }
      console.log(`     ↳ bucket sizes now:`,
                  Object.fromEntries(Object.keys(bucket).map(k=>[k,bucket[k].length])));
    }

    /* summarise */
    const summarise = k =>{
      const arr=bucket[k], tot=arr.reduce((s,r)=>s+r.sum_eur,0);
      return {meta:{type:k,total_items:arr.length,total_sum_eur:+tot.toFixed(2)},items:arr};
    };
    return {b2c:summarise('B2C'), b2b:summarise('B2B'), other:summarise('Other')};
  }

  /* ── RUN ───────────────────────────────────── */
  try {
    /* 1. gather IDs from both groups */
    const idGroups = await Promise.all(GROUPS.map(idsFromGroup));
    const unique   = [...new Set(idGroups.flat())];
    console.log(`🧮  TOTAL unique IDs collected: ${unique.length}\n`);

    /* 2. hydrate & bucket */
    const result = await hydrate(unique);
    res.status(200).json(result);

  } catch (err) {
    console.error('💥  Fatal', err);
    res.status(500).json({error:'Monday API error',details:err.message||err});
  }
}
