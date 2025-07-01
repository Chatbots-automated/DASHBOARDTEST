/**
 * /api/monday.js
 * Fetch every item from groups new_group50055 / new_group89286,
 * bucket them by status6 → B2C • B2B • Other, return totals + rows.
 */
export default async function handler (req, res) {
  /* –– CORS –– */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* –– ENV –– */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY missing' });

  /* –– IDs & columns –– */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055', 'new_group89286'];
  const TYPE_COL   = 'status6';      // B2C / B2B
  const NUMBER_COL = 'numbers';      // deal value (no VAT)
  const DATE_COL   = 'date8';        // installation date
  const VALID      = new Set(['B2C', 'B2B']);

  /* –– tiny gql helper with basic 429 back-off –– */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };
  const gql = async (label, query, variables = undefined) => {
    const body = variables ? { query, variables } : { query };
    let backoff = 1;
    for (;;) {
      const rsp = await fetch('https://api.monday.com/v2',
        { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });

      if (rsp.status === 429) {                     // minute-rate
        await new Promise(t => setTimeout(t, backoff * 1_000));
        backoff = Math.min(backoff + 1, 8);
        continue;
      }
      const j = await rsp.json();
      if (j.errors) throw new Error(`${label}: ${JSON.stringify(j.errors)}`);
      return j.data;
    }
  };

  /* –– 1️⃣  fetch *all* items for one group –– */
  const fetchGroupItems = async (gid) => {
    const items = [];

    /* first page inside the group */
    let page = (await gql(
      `first items_page for ${gid}`,
      `
      query ($bid: [ID!]!, $gid: String!) {
        boards(ids: $bid) {
          groups(ids: [$gid]) {
            items_page(limit: 500) {
              cursor
              items {
                id name
                column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]) {
                  id
                  ... on NumbersValue { number text }
                  ... on StatusValue  { label }
                  ... on DateValue    { date }
                }
              }
            }
          }
        }
      }`, { bid: [BOARD_ID], gid })
    ).boards[0].groups[0].items_page;

    items.push(...page.items);
    while (page.cursor) {
      page = (await gql(
        `next_items_page ${gid}`,
        `
        query ($c: String!) {
          next_items_page(limit: 500, cursor: $c) {
            cursor
            items {
              id name
              column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]) {
                id
                ... on NumbersValue { number text }
                ... on StatusValue  { label }
                ... on DateValue    { date }
              }
            }
          }
        }`, { c: page.cursor })
      ).next_items_page;
      items.push(...page.items);
    }
    console.log(`✅  ${gid}: pulled ${items.length} rows`);
    return items;
  };

  /* –– 2️⃣  gather from all groups and bucket –– */
  const bucket = { B2C: [], B2B: [], Other: [] };

  for (const gid of GROUP_IDS) {
    const groupItems = await fetchGroupItems(gid);

    for (const it of groupItems) {
      const cv = Object.fromEntries(it.column_values.map(c => [c.id, c]));
      const lbl = cv[TYPE_COL]?.label;
      const type = VALID.has(lbl) ? lbl : 'Other';

      const num = cv[NUMBER_COL]?.number ?? Number(cv[NUMBER_COL]?.text ?? 0);

      bucket[type].push({
        id  : it.id,
        name: it.name,
        type,
        installation_date: cv[DATE_COL]?.date ?? null,
        sum_eur: num
      });
    }
  }

  /* –– 3️⃣  pack response –– */
  const pack = k => {
    const arr = bucket[k];
    const tot = arr.reduce((s, r) => s + r.sum_eur, 0);
    return { meta: { type: k, total_items: arr.length, total_sum_eur: +tot.toFixed(2) }, items: arr };
  };

  res.status(200).json({ b2c: pack('B2C'), b2b: pack('B2B'), other: pack('Other') });
}
