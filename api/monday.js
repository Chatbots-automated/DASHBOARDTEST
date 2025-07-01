/**
 * /api/monday.js  –  pulls EVERYTHING every time
 * Groups: new_group50055 | new_group89286
 * Buckets status6 → B2C · B2B · Other
 * Returns: { fetched_at, b2c, b2b, other }
 */
export default async function handler (req, res) {
  /* ── CORS ───────────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── NEVER CACHE THIS RESPONSE ──────────────── */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma',        'no-cache');

  /* ── ENV ────────────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MONDAY_API_KEY missing' });
  }

  /* ── IDs / columns ─────────────────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055', 'new_group89286'];

  const TYPE_COL   = 'status6';   // “B2C” / “B2B”
  const NUMBER_COL = 'numbers';   // deal value (no-VAT)
  const DATE_COL   = 'date8';     // installation date

  const VALID_TYPES = new Set(['B2C', 'B2B']);

  /* ── low-level GraphQL helper with rate-limit back-off ── */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  async function gql (label, query, variables) {
    const body = variables ? { query, variables } : { query };
    let wait = 1_000;                                 // 1 s -> 2 s -> … → 30 s
    for (;;) {
      const rsp = await fetch('https://api.monday.com/v2', {
        method: 'POST', headers: HEADERS, body: JSON.stringify(body)
      });

      /* plain 429 */
      if (rsp.status === 429) {
        console.warn(`⏳  ${label}: HTTP 429 – retry in ${wait/1000}s`);
        await new Promise(t => setTimeout(t, wait));
        wait = Math.min(wait * 2, 30_000);
        continue;
      }

      const j = await rsp.json();

      /* GraphQL-level rate limits */
      const err  = j.errors?.[0];
      const code = err?.extensions?.code || '';
      if (code.includes('Complexity') ||
          code.includes('DAILY_LIMIT') ||
          code.includes('MINUTE_LIMIT')) {
        console.warn(`⏳  ${label}: ${code} – retry in ${wait/1000}s`);
        await new Promise(t => setTimeout(t, wait));
        wait = Math.min(wait * 2, 30_000);
        continue;
      }

      if (j.errors) {
        console.error(`💥  ${label} failed`, JSON.stringify(j.errors, null, 2));
        throw new Error('monday API fatal');
      }

      return j.data;
    }
  }

  /* ── helper: robust number parser ───────────── */
  const toNumber = (numField, textField) =>
    typeof numField === 'number'
      ? numField
      : Number(textField?.replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;

  /* ── 1️⃣  fetch every item (and its sub-items) inside one group ── */
  async function fetchGroupItems (gid) {
    const items = [];

    const HARVEST = list => {
      for (const it of list) {
        items.push(it);
        if (it.subitems?.length) items.push(...it.subitems);
      }
    };

    /* first page */
    let page = (await gql(
      `first items_page ${gid}`,
      `query ($bid:[ID!]!, $gid:String!){
         boards(ids:$bid){
           groups(ids:[$gid]){
             items_page(limit:500){
               cursor
               items{
                 id name
                 column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                   id
                   ... on NumbersValue { number text }
                   ... on StatusValue  { label }
                   ... on DateValue    { date }
                   text
                 }
                 subitems{
                   id name
                   column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                     id
                     ... on NumbersValue { number text }
                     ... on StatusValue  { label }
                     ... on DateValue    { date }
                     text
                   }
                 }
               }
             }
           }
         }
       }`,
      { bid:[BOARD_ID], gid }
    )).boards[0].groups[0].items_page;

    HARVEST(page.items);

    /* follow the cursor chain */
    while (page.cursor) {
      page = (await gql(
        `next_items_page ${gid}`,
        `query ($c:String!){
           next_items_page(limit:500, cursor:$c){
             cursor
             items{
               id name
               column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                 id
                 ... on NumbersValue { number text }
                 ... on StatusValue  { label }
                 ... on DateValue    { date }
                 text
               }
               subitems{
                 id name
                 column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                   id
                   ... on NumbersValue { number text }
                   ... on StatusValue  { label }
                   ... on DateValue    { date }
                   text
                 }
               }
             }
           }
         }`,
        { c: page.cursor }
      )).next_items_page;

      HARVEST(page.items);
    }

    console.log(`✅  ${gid}: total rows (incl. subitems) → ${items.length}`);
    return items;
  }

  /* ── 2️⃣  pull the two groups & bucket on the fly ───────────── */
  const bucket = { B2C: [], B2B: [], Other: [] };
  const seen   = new Set();                       // de-dup across groups

  for (const gid of GROUP_IDS) {
    const rows = await fetchGroupItems(gid);

    for (const it of rows) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);

      const cv   = Object.fromEntries(it.column_values.map(c => [c.id, c]));
      const lbl  = cv[TYPE_COL]?.label;
      const type = VALID_TYPES.has(lbl) ? lbl : 'Other';

      const num = toNumber(cv[NUMBER_COL]?.number, cv[NUMBER_COL]?.text);

      bucket[type].push({
        id  : it.id,
        name: it.name,
        type,
        installation_date: cv[DATE_COL]?.date ?? null,
        sum_eur: num
      });
    }
  }

  /* ── 3️⃣  pack & respond ───────────────────── */
  const pack = t => {
    const arr = bucket[t];
    const tot = arr.reduce((s, r) => s + r.sum_eur, 0);
    return {
      meta : { type: t, total_items: arr.length, total_sum_eur: +tot.toFixed(2) },
      items: arr
    };
  };

  res.status(200).json({
    fetched_at: new Date().toISOString(),   // diagnostic
    b2c  : pack('B2C'),
    b2b  : pack('B2B'),
    other: pack('Other')
  });
}
