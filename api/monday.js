/**
 * /api/monday.js  – pulls EVERYTHING every call
 * Groups new_group50055 | new_group89286
 * Buckets status6 →  B2C · B2B · Other
 * Returns: { fetched_at, b2c, b2b, other }
 */
export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── NEVER CACHE ───────────────────────── */
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Pragma','no-cache');

  /* ── API-key guard ─────────────────────── */
  const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
  const rawAuth   = req.headers['authorization'] ?? '';
  const bearerKey = rawAuth.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied  = bearerKey || rawAuth || req.headers['x-api-key'];

  if (!CLIENT_API_KEY || supplied !== CLIENT_API_KEY) {
    console.warn('🔒  bad / missing CLIENT_API_KEY (got "%s")', supplied);
    return res.status(401).json({ error:'Unauthorized' });
  }

  /* ── monday.com token ─────────────────── */
  const MONDAY_KEY = process.env.MONDAY_API_KEY;
  if (!MONDAY_KEY) return res.status(500).json({ error:'MONDAY_API_KEY missing' });

  /* ── IDs / column aliases ─────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286'];

  const TYPE_COL   = 'status6';            // B2C / B2B
  const NUMBER_COL = 'numbers';            // €
  const DATE_COL   = 'date8';              // install
  const SAVIK_COL  = 'formula_mkmc9vc5';   // savikaina €
  const PROFIT_COL = 'formula_mkmgcexy';   // profit %
  const HOUSE_COL  = 'status_12';          // household type
  const INST_COL   = 'naujas_montuotojai'; // installer

  const VALID_TYPES = new Set(['B2C','B2B']);

  /* one place – every column we pull */
  const COL_IDS = [
    NUMBER_COL, TYPE_COL, DATE_COL,
    SAVIK_COL,  PROFIT_COL,
    HOUSE_COL,  INST_COL
  ];

  /* ── mini helpers ─────────────────────── */
  const HEADERS = { Authorization: MONDAY_KEY, 'Content-Type':'application/json' };

  const gql = async (label, query, variables) => {
    let wait = 1_000;
    for (;;) {
      const rsp = await fetch('https://api.monday.com/v2',{
        method:'POST', headers:HEADERS,
        body:JSON.stringify(variables ? {query,variables}:{query})
      });
      if (rsp.status === 429) {                       // HTTP-level
        console.warn(`⏳ ${label} 429 – ${wait/1e3}s`);
        await new Promise(t=>setTimeout(t,wait));
        wait = Math.min(wait*2, 30_000);
        continue;
      }
      const j = await rsp.json();
      const code = j.errors?.[0]?.extensions?.code || '';
      if (code.match(/Complexity|MINUTE_LIMIT|DAILY_LIMIT/)) {
        console.warn(`⏳ ${label} ${code} – ${wait/1e3}s`);
        await new Promise(t=>setTimeout(t,wait));
        wait = Math.min(wait*2, 30_000);
        continue;
      }
      if (j.errors) {
        console.error(`💥 ${label}`, JSON.stringify(j.errors,null,2));
        throw new Error('monday API fatal');
      }
      return j.data;
    }
  };

  const toNumber = (n, txt='') =>
    typeof n === 'number' ? n
                          : Number(txt.replace(/[^\d.,-]/g,'').replace(',','.')) || 0;

  /* ── build the GQL snippets *after* COL_IDS exists ── */
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

  const Q_NEXT = `
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
  const fetchGroupItems = async gid => {
    const items=[];
    const harvest = arr => arr.forEach(it=>{
      items.push(it); if (it.subitems?.length) items.push(...it.subitems);
    });

    let page = (await gql(`first ${gid}`, Q_FIRST, { bid:[BOARD_ID], gid }))
                  .boards[0].groups[0].items_page;
    harvest(page.items);

    while (page.cursor){
      page = (await gql(`next ${gid}`, Q_NEXT, { c:page.cursor })).next_items_page;
      harvest(page.items);
    }
    return items;
  };

  /* ── aggregate & bucket ─────────────────── */
  const bucket = { B2C:[], B2B:[], Other:[] };
  const seen   = new Set();

  for (const gid of GROUP_IDS){
    const rows = await fetchGroupItems(gid);
    for (const it of rows){
      if (seen.has(it.id)) continue; seen.add(it.id);

      const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
      const lbl  = cv[TYPE_COL]?.label;
      const type = VALID_TYPES.has(lbl) ? lbl : 'Other';

      bucket[type].push({
        id  : it.id,
        name: it.name,
        type,
        installation_date : cv[DATE_COL]?.date ?? null,

        sum_eur       : toNumber(cv[NUMBER_COL]?.number, cv[NUMBER_COL]?.text),
        savikaina_eur : toNumber(null, cv[SAVIK_COL ]?.display_value),
        profit_pct    : toNumber(null, cv[PROFIT_COL]?.display_value),

        household_type: cv[HOUSE_COL]?.label ?? null,
        installer     : cv[INST_COL ]?.label ?? null
      });
    }
  }

  /* ── respond ───────────────────────────── */
  const pack = k=>{
    const arr=bucket[k];
    return {
      meta : {
        type:k,
        total_items:arr.length,
        total_sum_eur:+arr.reduce((s,r)=>s+r.sum_eur,0).toFixed(2)
      },
      items:arr
    };
  };

  res.status(200).json({
    fetched_at:new Date().toISOString(),
    b2c:pack('B2C'), b2b:pack('B2B'), other:pack('Other')
  });
}
