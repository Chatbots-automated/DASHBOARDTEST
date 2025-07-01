/**
 * /api/monday.js    –– DEBUG: list groups first
 */
export default async function handler (req, res) {
  /*  CORS  */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /*  ENV  */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  /*  CONFIG  */
  const BOARD_ID  = 1645436514;                  //  ← double-check
  const WANTED    = new Set(['new_group50055','new_group89286']);

  const TYPE_COL  = 'status6';                   // B2C / B2B
  const NUM_COL   = 'numbers';                   // deal € w/o VAT
  const DATE_COL  = 'date8';
  const VALID     = new Set(['B2C','B2B']);

  /*  tiny GraphQL helper with back-off  */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  const gql = async (query, variables=undefined) => {
    const body = variables ? { query, variables } : { query };
    while (true) {
      const r = await fetch('https://api.monday.com/v2',
                 {method:'POST',headers:HEADERS,body:JSON.stringify(body)});
      if (r.status === 429) {
        const wait=(+r.headers.get('Retry-After')||1)*1000;
        console.warn(` ↺ 429 – wait ${wait/1000}s`); await new Promise(t=>setTimeout(t,wait));
        continue;
      }
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors,null,2));
      return j.data;
    }
  };

  const parseNum = raw =>
    !raw || raw === 'No result'
      ? 0
      : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /*  STEP 0 – list groups, keep the ones we need  */
  async function discoverGroups () {
    const data = await gql(`
      query {
        boards(ids:[${BOARD_ID}]){
          groups { id title }
        }
      }`);
    const groups = data?.boards?.[0]?.groups ?? [];
    console.log('\n📋  Groups on board', BOARD_ID);
    groups.forEach(g=>console.log(`   • ${g.id.padEnd(15)}  ${g.title}`));

    const usable = groups.filter(g=>WANTED.has(g.id));
    if (!usable.length) {
      console.warn('\n⚠️  None of the requested group IDs exist on this board.');
    } else {
      console.log('\n✅  Will fetch items from:',
                  usable.map(g=>`${g.id} (${g.title})`).join(', '));
    }
    return usable.map(g=>g.id);
  }

  /*  collect all IDs from ONE group  */
  async function idsFromGroup (gid) {
    const ids=[];
    let page = await gql(`
      query {
        boards(ids:[${BOARD_ID}]){
          groups(ids:["${gid}"]){
            items_page(limit:500){ cursor items{ id } }
          }
        }
      }`).boards?.[0]?.groups?.[0]?.items_page;

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

  /*  hydrate → bucket  */
  async function hydrate (allIds) {
    const bucket={B2C:[],B2B:[],Other:[]};
    for (let i=0;i<allIds.length;i+=100){
      const slice = allIds.slice(i,i+100);
      const d = await gql(`
        query($ids:[ID!]!){
          items(ids:$ids){
            id name
            column_values(ids:["${NUM_COL}","${TYPE_COL}","${DATE_COL}"]){
              id
              ... on NumbersValue { number }
              ... on StatusValue  { label }
              ... on DateValue    { date }
            }
          }
        }`,{ids:slice});

      for (const it of d.items){
        const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const type = VALID.has(cv[TYPE_COL]?.label) ? cv[TYPE_COL].label : 'Other';
        const num  = cv[NUM_COL]?.number ?? 0;
        bucket[type].push({
          id:it.id,name:it.name,type,
          installation_date:cv[DATE_COL]?.date??null,
          sum_eur:num
        });
      }
    }
    const pack=t=>{
      const a=bucket[t], tot=a.reduce((s,r)=>s+r.sum_eur,0);
      return {meta:{type:t,total_items:a.length,total_sum_eur:+tot.toFixed(2)},items:a};
    };
    return {b2c:pack('B2C'), b2b:pack('B2B'), other:pack('Other')};
  }

  /*  RUN  */
  try {
    const targetGroups = await discoverGroups();
    if (!targetGroups.length) {
      return res.status(200).json({error:'No matching groups on board'});
    }

    const idSets = await Promise.all(targetGroups.map(idsFromGroup));
    const unique = [...new Set(idSets.flat())];
    console.log(`\n🧮  Total unique item IDs: ${unique.length}\n`);

    const data = await hydrate(unique);
    res.status(200).json(data);
  } catch (err) {
    console.error('💥', err);
    res.status(500).json({error:'Monday API error',details:err.message||err});
  }
}
