/**
 * /api/monday.js  – Vercel / Next API Route
 *
 * ❶ grab *all* IDs from the two sales groups (cursor pagination)
 * ❷ hydrate those IDs in 100-item chunks
 * ❸ bucket the rows by “status6” = B2C / B2B
 * ❹ return
 */
export default async function handler(req, res) {
  /* –––––– CORS –––––– */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* –––––– ENV / CONSTANTS –––––– */
  const API_KEY  = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY missing' });

  const BOARD_ID  = 1645436514;
  const GROUP_IDS = ['new_group50055', 'new_group89286'];

  const TYPE_COL  = 'status6';          // B2C / B2B
  const EUR_COL   = 'formula_mkmp4x00'; // €
  const DATE_COL  = 'date8';            // installation date

  const ACCEPTED_TYPES = new Set(['B2C', 'B2B']);

  /* –––––– tiny GQL helper –––––– */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };
  const gql = async (query) => {
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: HEADERS,
      body  : JSON.stringify({ query })
    });
    const j = await r.json();
    if (j.errors) {
      console.error('⛔️ Monday API error\n', JSON.stringify(j.errors, null, 2));
      throw new Error('Monday API error');
    }
    return j.data;
  };

  /* –––––– utils –––––– */
  const deEuro = (raw) =>
    !raw || raw === 'No result'
      ? null
      : parseFloat(raw.replace(/[.\s\u00A0]/g, '').replace(',', '.')); // “1.234.567,89” → 1234567.89

  /* –––––– ❶ gather every ID inside one group (500-item pages) –––––– */
  async function collectIds(groupId) {
    const ids = [];

    // first page
    let data = await gql(`
      query {
        boards(ids: ${BOARD_ID}) {
          groups(ids: ["${groupId}"]) {
            items_page(limit: 500) {
              cursor
              items { id }
            }
          }
        }
      }
    `);
    data = data?.boards?.[0]?.groups?.[0]?.items_page;
    if (!data) return ids;              // empty / invalid group

    ids.push(...data.items.map((i) => i.id));
    let cursor = data.cursor;

    // keep following the cursor until it’s null
    while (cursor) {
      let next = await gql(`
        query {
          next_items_page(limit: 500, cursor: "${cursor}") {
            cursor
            items { id }
          }
        }
      `);
      next = next.next_items_page;
      if (!next?.items?.length) break;
      ids.push(...next.items.map((i) => i.id));
      cursor = next.cursor;             // becomes null when done
    }
    return ids;
  }

  /* –––––– ❷ hydrate → ❸ bucket –––––– */
  async function hydrate(allIds) {
    const buckets = { B2C: [], B2B: [] };

    for (let i = 0; i < allIds.length; i += 100) {
      const slice = allIds.slice(i, i + 100).join(',');
      const data  = await gql(`
        query {
          items(ids: [${slice}]) {
            id
            name
            column_values(ids: ["${EUR_COL}", "${TYPE_COL}", "${DATE_COL}"]) {
              id
              ... on FormulaValue { display_value }
              ... on StatusValue  { label }
              ... on DateValue    { date }
            }
          }
        }
      `);

      for (const item of data.items || []) {
        const cv   = Object.fromEntries(item.column_values.map((c) => [c.id, c]));
        const type = cv[TYPE_COL]?.label;
        if (!ACCEPTED_TYPES.has(type)) continue;

        const num = deEuro(cv[EUR_COL]?.display_value);
        if (num === null) continue;

        buckets[type].push({
          id   : item.id,
          name : item.name,
          type,
          installation_date: cv[DATE_COL]?.date ?? null,
          sum_eur: num
        });
      }
    }

    /* –– build meta –– */
    const out = {};
    for (const key of Object.keys(buckets)) {
      const arr  = buckets[key];
      const total= arr.reduce((s, r) => s + r.sum_eur, 0);
      out[key.toLowerCase()] = {
        meta : {
          type          : key,
          total_items   : arr.length,
          total_sum_eur : +total.toFixed(2)
        },
        items: arr
      };
    }
    return out;   // { b2c:{meta,…}, b2b:{meta,…} }
  }

  /* –––––– RUN –––––– */
  try {
    /* 1. get every ID from the required groups */
    const idSets = await Promise.all(GROUP_IDS.map(collectIds));
    const uniqueIds = [...new Set(idSets.flat())];   // deduplicate

    /* 2. hydrate + bucket */
    const result = await hydrate(uniqueIds);

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Monday API error', details: err.message || err });
  }
}
