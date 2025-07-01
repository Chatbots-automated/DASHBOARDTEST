/**
 * /api/monday.js
 * Pull every item from groups new_group50055 / new_group89286,
 * bucket them by status6 → B2C • B2B • Other, return totals + rows.
 */
export default async function handler(req, res) {
  /* ── CORS ── */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV ── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY missing' });

  /* ── IDs & consts ── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055', 'new_group89286'];
  const TYPE_COL   = 'status6';
  const NUMBER_COL = 'numbers';
  const DATE_COL   = 'date8';
  const VALID      = new Set(['B2C', 'B2B']);   // accepted labels

  /* ── tiny gql helper ── */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };
  const gql = async (query, variables = undefined) => {
    const body = variables ? { query, variables } : { query };
    let backoff = 1;
    for (;;) {
      const rsp = await fetch('https://api.monday.com/v2',
        { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });

      if (rsp.status === 429) {                     // minute limit
        await new Promise(t => setTimeout(t, backoff * 1_000));
        backoff = Math.min(backoff + 1, 8);
        continue;
      }
      const j = await rsp.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      return j.data;
    }
  };

  /* ── 1️⃣ pull *all* items of one group ── */
  const fetchGroupItems = async (gid) => {
    let page = 1, more = true, out = [];
    while (more) {
      const data = await gql(`
        query ($bid: ID!, $gid: String!, $page: Int!) {
          boards(ids: [$bid]) {
            groups(ids: [$gid]) {
              items(limit: 2000, page: $page) {
                id name
                column_values(ids: ["${NUMBER_COL}", "${TYPE_COL}", "${DATE_COL}"]) {
                  id
                  ... on NumbersValue { number text }
                  ... on StatusValue  { label }
                  ... on DateValue    { date }
                }
              }
            }
          }
        }`, { bid: BOARD_ID, gid, page });

      const items = data.boards[0].groups[0].items;
      out.push(...items);
      more = items.length === 2000;   // 2000 => there *could* be another page
      page += 1;
    }
    return out;
  };

  /* ── 2️⃣  hydrate & bucket ── */
  const bucket = { B2C: [], B2B: [], Other: [] };

  for (const gid of GROUP_IDS) {
    const items = await fetchGroupItems(gid);
    for (const it of items) {
      const cv   = Object.fromEntries(it.column_values.map(c => [c.id, c]));
      const rawT = cv[TYPE_COL]?.label;
      const type = VALID.has(rawT) ? rawT : 'Other';

      const num = cv[NUMBER_COL]?.number ??
                  Number(cv[NUMBER_COL]?.text ?? 0);

      bucket[type].push({
        id : it.id,
        name : it.name,
        type,
        installation_date : cv[DATE_COL]?.date ?? null,
        sum_eur : num
      });
    }
  }

  const pack = (t) => {
    const arr = bucket[t];
    const tot = arr.reduce((s, r) => s + r.sum_eur, 0);
    return { meta: { type: t, total_items: arr.length, total_sum_eur: +tot.toFixed(2) }, items: arr };
  };

  res.status(200).json({ b2c: pack('B2C'), b2b: pack('B2B'), other: pack('Other') });
}
