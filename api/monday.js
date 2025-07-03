/**
 * /api/monday.js  – pulls EVERY-thing every call
 * Groups  new_group50055 | new_group89286
 * Buckets status6  →  B2C · B2B · Other
 * Returns  { fetched_at, b2c, b2b, other }
 */
export default async function handler (req, res) {
  /* ── CORS & no-cache ─────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Cache-Control','no-store, max-age=0');  // disable any cache
  res.setHeader('Pragma','no-cache');

  /* ── simple shared-secret guard ──────── */
  const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
  const hdr            = req.headers['authorization'] ?? '';
  const suppliedKey    = hdr.match(/^Bearer\s+(.+)$/i)?.[1]
                      || hdr
                      || req.headers['x-api-key'];
  if (!CLIENT_API_KEY || suppliedKey !== CLIENT_API_KEY)
    return res.status(401).json({ error:'Unauthorized' });

  /* ── monday token ────────────────────── */
  const MONDAY_KEY = process.env.MONDAY_API_KEY;
  if (!MONDAY_KEY)
    return res.status(500).json({ error:'MONDAY_API_KEY missing' });

  /* ── Board & column IDs ──────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286'];

  const TYPE_COL   = 'status6';            // B2C / B2B
  const NUMBER_COL = 'numbers';            // deal € (no VAT)
  const DATE_COL   = 'date8';              // install date
  const SAVIK_COL  = 'formula_mkmc9vc5';   // savikaina €
  const PROFIT_COL = 'formula_mkmgcexy';   // profit %
  const HOUSE_COL  = 'status_12';          // household type
  const INST_COL   = 'naujas_montuotojai'; // installer

  const VALID_TYPES = new Set(['B2C','B2B']);

  const COL_IDS = [
    NUMBER_COL, TYPE_COL, DATE_COL,
    SAVIK_COL,  PROFIT_COL,
    HOUSE_COL,  INST_COL
  ];

  /* ── helpers ─────────────────────────── */
  const HEADERS = { Authorization: MONDAY_KEY, 'Content-Type':'application/json' };

  const gql = async (label, query, variables) => {
    let wait = 1_000;
    for (;;) {
      const r = await fetch('https://api.monday.com/v2',{
        method:'POST', headers:HEADERS,
        body:JSON.stringify(variables?{query,variables}:{query})
      });

      if (r.status === 429) {                       // HTTP-level
        console.warn(`⏳ ${label} 429 – retry ${wait/1e3}s`);
        await new Promise(t=>setTimeout(t,wait));
        wait = Math.min(wait*2,30_000); continue;
      }
      const j = await r.json();

      /* field-level formula limit */
      const err0 = j.errors?.[0];
      if (err0?.extensions?.code === 'FIELD_MINUTE_RATE_LIMIT_EXCEEDED') {
        const sec = +err0.extensions.retry_in_seconds || 5;
        console.warn(`⏳ ${label} formula limit – retry ${sec}s`);
        await new Promise(t=>setTimeout(t, sec*1000));
        continue;
      }

      const code = err0?.extensions?.code || '';
      if (code.match(/Complexity|MINUTE_LIMIT|DAILY_LIMIT/)) {
        console.warn(`⏳ ${label} ${code} – retry ${wait/1e3}s`);
        await new Promise(t=>setTimeout(t,wait));
        wait = Math.min(wait*2,30_000); continue;
      }
      if (j.errors) {
        console.error(`💥 ${label}`,JSON.stringify(j.errors,null,2));
        throw new Error('monday API fatal');
      }
      return j.data;
    }
  };

  const toNumber = (n, txt='') =>
    typeof n === 'number'
      ? n
      : Number(txt.replace(/[^\d.,-]/g,'').replace(',','.')) || 0;

  /* ── dynamic queries (built after COL_IDS exists) ── */
  const COL_LIST = COL_IDS.map(c=>`"${c}"`).join(',');
  const Q_FIRST = `
    query ($bid:[ID!]!, $gid:String!){
      boards(ids:$bid){
        groups(ids:[$gid]){
          items_page(limit:500){
            cursor
            items{
              id name
              column_values(ids:[${COL_LIST}]){
                id
                ... on NumbersValue { number text }
                ... on FormulaValue { display_value }
                ... on StatusValue  { label }
                ... on DateValue    { date }
                text
              }
              subitems{
                id name
                column_values(ids:[${COL_LIST}]){
                  id
                  ... on NumbersValue { number text }
                  ... on FormulaValue { display_value }
                  ... on StatusValue  { label }
                  ... on DateValue    { date }
                  text
                }
              }
            }
          }
        }
      }
    }`;
  const Q_NEXT  = `
    query ($c:String!){
      next_items_page(limit:500, cursor:$c){
        cursor
        items{
          id name
          column_values(ids:[${COL_LIST}]){
            id
            ... on NumbersValue { number text }
            ... on FormulaValue { display_value }
            ... on StatusValue  { label }
            ... on DateValue    { date }
            text
          }
          subitems{
            id name
            column_values(ids:[${COL_LIST}]){
              id
              ... on NumbersValue { number text }
              ... on FormulaValue { display_value }
              ... on StatusValue  { label }
              ... on DateValue    { date }
              text
            }
          }
        }
      }
    }`;

  /* ── fetch all items + subitems for a group ── */
  const fetchGroup = async gid => {
    const out=[];
    const harvest = l=>l.forEach(it=>{
      out.push(it); if (it.subitems?.length) out.push(...it.subitems);
    });

    let page = (await gql(`first ${gid}`,Q_FIRST,{bid:[BOARD_ID],gid}))
                .boards[0].groups[0].items_page;
    harvest(page.items);

    while (page.cursor){
      page = (await gql(`next ${gid}`,Q_NEXT,{c:page.cursor})).next_items_page;
      harvest(page.items);
    }
    return out;
  };

  /* ── aggregate & bucket ─────────────────── */
  const bucket={B2C:[],B2B:[],Other:[]};
  const seen=new Set();

  for (const gid of GROUP_IDS){
    const rows=await fetchGroup(gid);
    for (const it of rows){
      if (seen.has(it.id)) continue; seen.add(it.id);
      const cv=Object.fromEntries(it.column_values.map(c=>[c.id,c]));
      const lbl = cv[TYPE_COL]?.label;
      const t   = VALID_TYPES.has(lbl)?lbl:'Other';
      bucket[t].push({
        id:it.id,
        name:it.name,
        type:t,
        installation_date:cv[DATE_COL]?.date ?? null,
        sum_eur      :toNumber(cv[NUMBER_COL]?.number, cv[NUMBER_COL]?.text),
        savikaina_eur:toNumber(null,cv[SAVIK_COL]?.display_value),
        profit_pct   :toNumber(null,cv[PROFIT_COL]?.display_value),
        household_type:cv[HOUSE_COL]?.label ?? null,
        installer     :cv[INST_COL ]?.label ?? null
      });
    }
  }

  /* ── respond ───────────────────────────── */
  const pack = k=>{
    const a=bucket[k], tot=a.reduce((s,r)=>s+r.sum_eur,0);
    return { meta:{type:k,total_items:a.length,total_sum_eur:+tot.toFixed(2)}, items:a };
  };
  res.status(200).json({
    fetched_at:new Date().toISOString(),
    b2c:pack('B2C'), b2b:pack('B2B'), other:pack('Other')
  });
}
