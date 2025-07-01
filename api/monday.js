/**
 * /api/monday.js
 * Grabs ALL items (no limit) in both B2C and B2B,
 * filters for statuses 1 & 6, and returns per-type totals + raw rows.
 */
export default async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ---------- env ---------- */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY missing' });

  /* ---------- board/column IDs ---------- */
  const BOARD_ID           = 1645436514;
  const STATUS_COLUMN_ID   = 'status';          // Įrengta = 1, Atsiskaityta = 6
  const TYPE_COLUMN_ID     = 'status6';         // B2C = 1, B2B = 2
  const FORMULA_COLUMN_ID  = 'formula_mkmp4x00';// €
  const DATE_COLUMN_ID     = 'date8';           // installation date

  /* ---------- GraphQL helper ---------- */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };
  async function gql(query) {
    const rsp  = await fetch('https://api.monday.com/v2', {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ query })
    });
    const txt  = await rsp.text();
    const json = JSON.parse(txt);
    if (json.errors) {
      console.error('⛔️ monday API error\nQuery:\n', query,
                    '\nErrors:\n', JSON.stringify(json.errors, null, 2));
      throw new Error('monday API returned errors');
    }
    return json.data;
  }

  /* ---------- 1️⃣  get *all* item-IDs for one client-type ---------- */
  async function collectIds(typeIdx) {
    const ids = [];

    /* first (filtered) page */
    const first = await gql(`
      query{
        boards(ids:${BOARD_ID}){
          items_page(limit:500,
            query_params:{rules:[
              {column_id:"${STATUS_COLUMN_ID}",compare_value:[1,6],operator:any_of},
              {column_id:"${TYPE_COLUMN_ID}",compare_value:[${typeIdx}],operator:any_of}
            ]}
          ){
            cursor items{ id }
          }
        }
      }`);
    const start = first?.boards?.[0]?.items_page;
    if (!start) return ids;
    ids.push(...start.items.map(i => i.id));

    /* follow the cursor chain */
    let cursor = start.cursor;
    while (cursor) {
      const next = await gql(`
        query{
          next_items_page(limit:500, cursor:"${cursor}"){
            cursor items{ id }
          }
        }`);
      const page = next?.next_items_page;
      if (!page) break;
      ids.push(...page.items.map(i => i.id));
      cursor = page.cursor;                 // becomes null at the end
    }
    return ids;
  }

  /* ---------- 2️⃣  hydrate details & fix number format ---------- */
  function toFloat(raw) {
    if (!raw || raw === 'No result') return null;
    // EU style?  (comma exists)
    if (raw.includes(',')) {
      return parseFloat(
        raw.replace(/[.\s\u00A0]/g, '')    // kill thousands sep (“.” / spaces / NBSP)
           .replace(',', '.')              // decimal comma -> dot
      );
    }
    // US style already
    return parseFloat(raw.replace(/[ \u00A0]/g, ''));
  }

  async function hydrate(ids, label) {
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100).join(',');
      const data  = await gql(`
        query{
          items(ids:[${slice}]){
            id name
            column_values(ids:[
              "${FORMULA_COLUMN_ID}",
              "${STATUS_COLUMN_ID}",
              "${TYPE_COLUMN_ID}",
              "${DATE_COLUMN_ID}"
            ]){
              id
              ... on FormulaValue {display_value}
              ... on StatusValue  {label}
              ... on DateValue    {date}
            }
          }
        }`);

      for (const it of (data.items || [])) {
        const cv  = Object.fromEntries(it.column_values.map(c => [c.id, c]));
        const num = toFloat(cv[FORMULA_COLUMN_ID]?.display_value);
        if (num === null || Number.isNaN(num)) continue;

        rows.push({
          id   : it.id,
          name : it.name,
          status: cv[STATUS_COLUMN_ID]?.label ?? null,
          type  : label,
          installation_date: cv[DATE_COLUMN_ID]?.date ?? null,
          sum_eur: num
        });
      }
    }
    const total = rows.reduce((s, r) => s + r.sum_eur, 0);
    return {
      meta: {
        type: label,
        total_items: rows.length,
        total_sum_eur: +total.toFixed(2)
      },
      items: rows
    };
  }

  /* ---------- RUN ---------- */
  try {
    const [b2cIds, b2bIds] = await Promise.all([collectIds(1), collectIds(2)]);
    const [b2c, b2b]       = await Promise.all([hydrate(b2cIds, 'B2C'),
                                               hydrate(b2bIds, 'B2B')]);
    res.status(200).json({ b2c, b2b });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'monday API error', details: err.message || err });
  }
}
