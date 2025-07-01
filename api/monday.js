// /api/monday.ts
export default async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ---------- CONFIG ---------- */
  const API_KEY          = process.env.MONDAY_API_KEY!;
  const BOARD_ID         = 1645436514;
  const STATUS_COLUMN_ID = 'status';          // Įrengta = 1, Atsiskaityta = 6
  const TYPE_COLUMN_ID   = 'status6';         // B2C = 1, B2B = 2
  const FORMULA_COLUMN_ID= 'formula_mkmp4x00';// €
  const DATE_COLUMN_ID   = 'date8';           // installation date

  const HEADERS = {
    Authorization : API_KEY,
    'Content-Type': 'application/json',
  };

  /* ---------- tiny helper ---------- */
  const gql = async (query:string) => {
    const r = await fetch('https://api.monday.com/v2', {
      method:'POST', headers:HEADERS, body:JSON.stringify({query})
    });
    const t = await r.text();
    const j = JSON.parse(t);
    if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2));
    return j.data;
  };

  /* ---------- 1️⃣  get every item-id for a client-type ---------- */
  async function collectIds(typeIdx:number):Promise<string[]>{
    const ids:string[] = [];

    // first page (with filters)
    let data = await gql(`
      query{
        boards(ids:${BOARD_ID}){
          items_page(
            limit:500,
            query_params:{rules:[
              {column_id:"${STATUS_COLUMN_ID}",compare_value:[1,6],operator:any_of},
              {column_id:"${TYPE_COLUMN_ID}",compare_value:[${typeIdx}],operator:any_of}
            ]}
          ){
            cursor
            items{ id }
          }
        }
      }`).boards[0].items_page;

    ids.push(...data.items.map((it:any)=>it.id));
    let cursor = data.cursor;

    // remaining pages (cursor only)
    while(cursor){
      const next = await gql(`
        query{
          next_items_page(limit:500, cursor:"${cursor}"){
            cursor
            items{ id }
          }
        }`).next_items_page;
      ids.push(...next.items.map((it:any)=>it.id));
      cursor = next.cursor;
    }
    return ids;
  }

  /* ---------- 2️⃣  fetch details in 100-item batches ---------- */
  async function hydrate(ids:string[], label:'B2C'|'B2B'){
    const results:any[] = [];
    for(let i=0;i<ids.length;i+=100){
      const slice = ids.slice(i,i+100).join(',');
      const items = await gql(`
        query{
          items(ids:[${slice}]){
            id name
            column_values(ids:["${FORMULA_COLUMN_ID}","${STATUS_COLUMN_ID}","${TYPE_COLUMN_ID}","${DATE_COLUMN_ID}"]){
              id
              ... on FormulaValue{display_value}
              ... on StatusValue {label}
              ... on DateValue   {date}
            }
          }
        }`).items;

      for(const it of items){
        const cols = Object.fromEntries(it.column_values.map((c:any)=>[c.id,c]));
        const raw  = cols[FORMULA_COLUMN_ID]?.display_value ?? '';
        if(!raw || raw==='No result') continue;

        /* normalise EU -> JS number */
        const num = parseFloat(
          (raw.match(/\./g)||[]).length>=2 ? raw.replace(/\./g,'').replace(',','.')
                                           : raw.replace(',','.')
        );
        if(Number.isNaN(num)) continue;

        results.push({
          id : it.id,
          name : it.name,
          status : cols[STATUS_COLUMN_ID]?.label ?? null,
          type   : label,
          installation_date : cols[DATE_COLUMN_ID]?.date ?? null,
          sum_eur : num,
        });
      }
    }
    const total = results.reduce((s,i)=>s+i.sum_eur,0);
    return {
      meta : { type:label, total_items:results.length,
               total_sum_eur:+total.toFixed(2) },
      items: results,
    };
  }

  /* ---------- RUN ---------- */
  try{
    const [b2cIds,b2bIds] = await Promise.all([collectIds(1),collectIds(2)]);
    const [b2c,b2b]       = await Promise.all([hydrate(b2cIds,'B2C'),hydrate(b2bIds,'B2B')]);
    res.status(200).json({b2c,b2b});
  }catch(err:any){
    console.error(err);
    res.status(500).json({error:'monday API error',details:err.message||err});
  }
}
