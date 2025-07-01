export default async function handler (req, res) {
  /* CORS -------------------------------------------------------- */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* CONFIG ------------------------------------------------------ */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  const BOARD_ID           = 1645436514;
  const STATUS_COLUMN_ID   = 'status';          // 1 (Įrengta), 6 (Atsiskaityta)
  const TYPE_COL_ID        = 'status6';         // 1 = B2C, 2 = B2B
  const FORMULA_COL_ID     = 'formula_mkmp4x00';// €
  const DATE_COL_ID        = 'date8';           // install date

  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};

  /* tiny helper ------------------------------------------------- */
  async function gql (query, variables = {}) {
    const r  = await fetch('https://api.monday.com/v2',{
      method:'POST', headers:HEADERS,
      body  : JSON.stringify({query, variables})
    });
    const t  = await r.text();
    const j  = JSON.parse(t);
    if (j.errors) {
      console.error('\n⛔️ GraphQL error\n',JSON.stringify(j.errors,null,2));
      throw new Error('monday GraphQL failed');
    }
    return j.data;
  }

  /* 1️⃣  Collect ALL IDs for a type via items_page_by_column_values ---- */
  async function collectIds (typeIdx){
    let ids    = [];
    let cursor = null;

    do {
      const PAGE = await gql(/* GraphQL */`
        query GetPage($board:ID!,$cursor:String){
          items_page_by_column_values(
            board_id:$board, limit:500, cursor:$cursor,
            columns:[
              {column_id:"${STATUS_COLUMN_ID}", column_values:["1","6"]},
              {column_id:"${TYPE_COL_ID}",   column_values:["${typeIdx}"]}
            ]
          ){
            cursor
            items{ id }
          }
        }
      `,{board:BOARD_ID, cursor});

      const page  = PAGE.items_page_by_column_values;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
      console.log(`→ type ${typeIdx}: accumulated ${ids.length} IDs`);
    } while (cursor);

    return ids;
  }

  /* 2️⃣  Hydrate details (100-item batches, 4× parallel) -------------- */
  function euStrToFloat(raw){
    if(!raw || raw==='No result') return null;
    // kill thousand separators then swap comma
    return parseFloat(
      raw.replace(/[.\s\u00A0]/g,'').replace(',','.')
    );
  }

  async function hydrate(ids, label){
    const limitConcurrency = (max, fns) => {
      const pool = new Array(max).fill(Promise.resolve());
      return Promise.all(fns.map((fn,i)=>
        (pool[i%max]=pool[i%max].then(fn))
      ));
    };

    const jobs = [];
    for(let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100);
      jobs.push(async ()=>{
        const DATA = await gql(/* GraphQL */`
          query Hydrate($ids:[Int]){
            items(ids:$ids){
              id name
              column_values(ids:[
                "${FORMULA_COL_ID}",
                "${STATUS_COLUMN_ID}",
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

        return DATA.items.map(it=>{
          const cv  = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
          const val = euStrToFloat(cv[FORMULA_COL_ID]?.display_value);
          if(val==null || Number.isNaN(val)) return null;
          return {
            id : it.id,
            name : it.name,
            status : cv[STATUS_COLUMN_ID]?.label ?? null,
            type : label,
            installation_date : cv[DATE_COL_ID]?.date ?? null,
            sum_eur : val
          };
        }).filter(Boolean);
      });
    }

    const rows = (await limitConcurrency(4, jobs)).flat();

    const total = rows.reduce((s,r)=>s+r.sum_eur,0);
    return {
      meta : { type:label, total_items:rows.length,
               total_sum_eur:+total.toFixed(2)},
      items: rows
    };
  }

  /* RUN --------------------------------------------------------- */
  try{
    const [b2cIds, b2bIds] = await Promise.all([collectIds(1), collectIds(2)]);
    const [b2c, b2b]       = await Promise.all([hydrate(b2cIds,'B2C'),
                                               hydrate(b2bIds,'B2B')]);
    res.status(200).json({b2c,b2b});
  }catch(err){
    console.error(err);
    res.status(500).json({error:'monday API error',details:err.message||err});
  }
}
