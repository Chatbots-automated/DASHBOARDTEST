/**
 * /api/monday.js  – pulls EVERY-thing every call
 * Groups new_group50055 | new_group89286
 * Buckets status6 →  B2C · B2B · Other
 * Returns { fetched_at, b2c, b2b, other }
 */
export default async function handler (req, res) {
  /* CORS, no-cache */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Cache-Control','no-store'); res.setHeader('Pragma','no-cache');

  /* simple shared-secret */
  const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
  const supplied = (req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)?.[1]
                || req.headers.authorization
                || req.headers['x-api-key'];
  if (!CLIENT_API_KEY || supplied !== CLIENT_API_KEY)
    return res.status(401).json({ error:'Unauthorized' });

  /* monday token */
  const MONDAY_KEY = process.env.MONDAY_API_KEY;
  if (!MONDAY_KEY) return res.status(500).json({ error:'MONDAY_API_KEY missing' });

  /* board / column IDs */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286'];
  const TYPE_COL   = 'status6';
  const NUMBER_COL = 'numbers';
  const DATE_COL   = 'date8';
  const SAVIK_COL  = 'formula_mkmc9vc5';
  const PROFIT_COL = 'formula_mkmgcexy';
  const HOUSE_COL  = 'status_12';
  const INST_COL   = 'naujas_montuotojai';
  const VALID_TYPES = new Set(['B2C','B2B']);

  const COL_IDS = [
    NUMBER_COL, TYPE_COL, DATE_COL,
    SAVIK_COL, PROFIT_COL,
    HOUSE_COL, INST_COL
  ];

  /* low-level GQL helper with back-off (+ field-limit) */
  const HEADERS = { Authorization: MONDAY_KEY, 'Content-Type':'application/json' };
  const gql = async (label, query, variables) => {
    let wait = 1_000;
    for (;;) {
      const r = await fetch('https://api.monday.com/v2',{
        method:'POST', headers:HEADERS,
        body:JSON.stringify(variables?{query,variables}:{query})
      });
      if (r.status === 429) {              // HTTP-level throttle
        await new Promise(t=>setTimeout(t,wait)); wait=Math.min(wait*2,30_000); continue;
      }
      const j = await r.json();
      const e = j.errors?.[0]; const code=e?.extensions?.code||'';
      if (code==='FIELD_MINUTE_RATE_LIMIT_EXCEEDED') {
        await new Promise(t=>setTimeout(t,(+e.extensions.retry_in_seconds||5)*1000));
        continue;
      }
      if (code.match(/Complexity|MINUTE_LIMIT|DAILY_LIMIT/)) {
        await new Promise(t=>setTimeout(t,wait)); wait=Math.min(wait*2,30_000); continue;
      }
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      return j.data;
    }
  };

  const toNumber = (n,t='')=>typeof n==='number'?n:Number(t.replace(/[^\d.,-]/g,'').replace(',','.'))||0;

  /* dynamic query strings */
  const COL_LIST = COL_IDS.map(c=>`"${c}"`).join(',');
  const BASE_FRAGMENT = `
        id
        ... on NumbersValue  { number text }
        ... on FormulaValue  { display_value }
        ... on StatusValue   { label }
        ... on DropdownValue { text values { name } }
        ... on DateValue     { date }
        text`;
  const Q_FIRST = `
    query ($bid:[ID!]!, $gid:String!){
      boards(ids:$bid){
        groups(ids:[$gid]){
          items_page(limit:500){
            cursor
            items{
              id name
              column_values(ids:[${COL_LIST}]){ ${BASE_FRAGMENT} }
              subitems{
                id name
                column_values(ids:[${COL_LIST}]){ ${BASE_FRAGMENT} }
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
          column_values(ids:[${COL_LIST}]){ ${BASE_FRAGMENT} }
          subitems{
            id name
            column_values(ids:[${COL_LIST}]){ ${BASE_FRAGMENT} }
          }
        }
      }
    }`;

  /* pull one group */
  const fetchGroup = async gid => {
    const out=[], add=l=>l.forEach(i=>{out.push(i); if(i.subitems)out.push(...i.subitems);});
    let p=(await gql(`first ${gid}`,Q_FIRST,{bid:[BOARD_ID],gid})).boards[0].groups[0].items_page;
    add(p.items);
    while(p.cursor){ p=(await gql(`next ${gid}`,Q_NEXT,{c:p.cursor})).next_items_page; add(p.items); }
    return out;
  };

  /* aggregate */
  const bucket={B2C:[],B2B:[],Other:[]}, seen=new Set();
  for (const gid of GROUP_IDS){
    for (const it of await fetchGroup(gid)){
      if(seen.has(it.id)) continue; seen.add(it.id);
      const cv=Object.fromEntries(it.column_values.map(c=>[c.id,c]));
      const lbl=cv[TYPE_COL]?.label, type=VALID_TYPES.has(lbl)?lbl:'Other';
      bucket[type].push({
        id:it.id, name:it.name, type,
        installation_date:cv[DATE_COL]?.date??null,
        sum_eur      :toNumber(cv[NUMBER_COL]?.number,cv[NUMBER_COL]?.text),
        savikaina_eur:toNumber(null,cv[SAVIK_COL ]?.display_value),
        profit_pct   :toNumber(null,cv[PROFIT_COL]?.display_value),
        household_type:cv[HOUSE_COL]?.label??null,
        installer     :cv[INST_COL]?.values?.[0]?.name     // first dropdown label
                     ?? cv[INST_COL]?.text                 // whole text string
                     ?? null
      });
    }
  }

  const pack=k=>{const a=bucket[k],t=a.reduce((s,r)=>s+r.sum_eur,0);
    return{meta:{type:k,total_items:a.length,total_sum_eur:+t.toFixed(2)},items:a}};
  res.status(200).json({fetched_at:new Date().toISOString(),
                        b2c:pack('B2C'),b2b:pack('B2B'),other:pack('Other')});
}
