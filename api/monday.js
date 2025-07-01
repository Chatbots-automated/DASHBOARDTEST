export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV ──────────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  /* ── IDs ──────────────────────────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286'];

  const TYPE_COL   = 'status6';           // B2C / B2B
  const EUR_COL    = 'formula_mkmp4x00';  // €
  const DATE_COL   = 'date8';             // install date

  /* ── helpers ─────────────────────────────── */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};
  const gql = async (query,variables={})=>{
    const r = await fetch('https://api.monday.com/v2',{
      method:'POST',headers:HEADERS,body:JSON.stringify({query,variables})
    });
    const j = await r.json();
    if (j.errors){ console.error(j.errors); throw new Error('Monday API error'); }
    return j.data;
  };

  const deEuro = raw =>
    !raw||raw==='No result' ? null
      : parseFloat(raw.replace(/[.\s\u00A0]/g,'').replace(',','.'));

  /* ── 1️⃣ collect **all** IDs in one group ─── */
  async function collectIds(groupId){
    const ids = [];

    /* initial page (filtered by group) */
    const first = await gql(/* GraphQL */`
      query ($bid:[ID!]!, $gid:String!){
        boards(ids:$bid){
          items_page(
            limit:500,
            query_params:{rules:[
              {column_id:"group", compare_value:[$gid], operator:any_of}
            ]}
          ){
            cursor items{ id }
          }
        }
      }`,{bid:[BOARD_ID],gid:groupId});

    const entry = first?.boards?.[0]?.items_page;
    if (!entry) return ids;

    ids.push(...entry.items.map(i=>i.id));
    let cursor = entry.cursor;

    /* walk the cursor chain */
    while(cursor){
      const step = await gql(/* GraphQL */`
        query($c:String!){
          next_items_page(limit:500,cursor:$c){
            cursor items{ id }
          }
        }`,{c:cursor});
      const page = step.next_items_page;
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i=>i.id));
      cursor = page.cursor;
    }
    return ids;
  }

  /* ── 2️⃣ hydrate IDs & bucket by type ─────── */
  async function hydrate(allIds){
    const buckets = {B2C:[],B2B:[]};

    for(let i=0;i<allIds.length;i+=100){
      const slice = allIds.slice(i,i+100);
      const d = await gql(/* GraphQL */`
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
        }`,{ids:slice});

      for(const it of d.items||[]){
        const cv  = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
        const lbl = cv[TYPE_COL]?.label;
        if (lbl!=='B2C' && lbl!=='B2B') continue;   // ignore anything else

        const num = deEuro(cv[EUR_COL]?.display_value);
        if (num==null) continue;

        buckets[lbl].push({
          id:it.id,
          name:it.name,
          type:lbl,
          installation_date:cv[DATE_COL]?.date??null,
          sum_eur:num
        });
      }
    }

    const meta = k=>{
      const a=buckets[k], tot=a.reduce((s,r)=>s+r.sum_eur,0);
      return {meta:{type:k,total_items:a.length,total_sum_eur:+tot.toFixed(2)},items:a};
    };
    return {b2c:meta('B2C'), b2b:meta('B2B')};
  }

  /* ── RUN ─────────────────────────────────── */
  try{
    /* gather IDs from every required group */
    const idSets = await Promise.all(GROUP_IDS.map(collectIds));
    const unique = [...new Set(idSets.flat())];   // deduplicate
    const data   = await hydrate(unique);
    res.status(200).json(data);
  }catch(e){
    res.status(500).json({error:'Monday API error',details:e.message||e});
  }
}
