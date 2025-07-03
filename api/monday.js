/**
 * /api/monday.js  –  pulls EVERYTHING every time
 * Groups: new_group50055 | new_group89286
 * Buckets status6 → B2C · B2B · Other
 * Returns: { fetched_at, b2c, b2b, other }
 */
export default async function handler(req, res) {
  /* ── CORS ───────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── NEVER CACHE ───────────────────────── */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma',        'no-cache');

  /* ── SHARED-SECRET GUARD ───────────────── */
  const CLIENT_API_KEY = process.env.CLIENT_API_KEY;          // <-- set in .env
  const suppliedKey    = req.headers['authorization'] || req.headers['x-api-key'];
  if (!CLIENT_API_KEY || suppliedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized – bad or missing API key' });
  }

  /* ── MONDAY TOKEN ──────────────────────── */
  const MONDAY_KEY = process.env.MONDAY_API_KEY;
  if (!MONDAY_KEY) {
    return res.status(500).json({ error: 'MONDAY_API_KEY missing' });
  }

  /* ── IDs / columns ─────────────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055', 'new_group89286'];
  const TYPE_COL   = 'status6';
  const NUMBER_COL = 'numbers';
  const DATE_COL   = 'date8';
  const VALID_TYPES = new Set(['B2C', 'B2B']);

  /* ── GQL helper with back-off ──────────── */
  const HEADERS = { Authorization: MONDAY_KEY, 'Content-Type': 'application/json' };
  async function gql(label, query, variables) {
    const body = variables ? { query, variables } : { query };
    let wait = 1_000;
    for (;;) {
      const r = await fetch('https://api.monday.com/v2', { method:'POST', headers:HEADERS, body:JSON.stringify(body) });
      if (r.status === 429) {                       // HTTP-level rate limit
        console.warn(`⏳ ${label} 429 – retry in ${wait/1e3}s`);
        await new Promise(t => setTimeout(t, wait));
        wait = Math.min(wait * 2, 30_000);
        continue;
      }
      const j = await r.json();
      const err = j.errors?.[0];
      const code = err?.extensions?.code || '';
      if (code.includes('Complexity') || code.includes('MINUTE_LIMIT') || code.includes('DAILY_LIMIT')) {
        console.warn(`⏳ ${label} ${code} – retry in ${wait/1e3}s`);
        await new Promise(t => setTimeout(t, wait));
        wait = Math.min(wait * 2, 30_000);
        continue;
      }
      if (j.errors) {
        console.error(`💥 ${label}`, JSON.stringify(j.errors, null, 2));
        throw new Error('monday API fatal');
      }
      return j.data;
    }
  }

  /* ── utils ─────────────────────────────── */
  const toNumber = (n, txt) =>
    typeof n === 'number' ? n : Number(txt?.replace(/[^\d.,-]/g,'').replace(',','.')) || 0;

  /* ── 1️⃣ fetch one group (items + subitems) ─ */
  async function fetchGroupItems(gid) {
    const items = [];
    const HARVEST = arr => arr.forEach(it => {
      items.push(it);
      if (it.subitems?.length) items.push(...it.subitems);
    });

    let page = (await gql(
      `first items_page ${gid}`,
      QUERY_FIRST_PAGE,
      { bid:[BOARD_ID], gid }
    )).boards[0].groups[0].items_page;
    HARVEST(page.items);

    while (page.cursor) {
      page = (await gql(
        `next_items_page ${gid}`,
        QUERY_NEXT_PAGE,
        { c: page.cursor }
      )).next_items_page;
      HARVEST(page.items);
    }
    return items;
  }

  /* ── 2️⃣ aggregate & bucket ─────────────── */
  const bucket = { B2C:[], B2B:[], Other:[] };
  const seen = new Set();

  for (const gid of GROUP_IDS) {
    const rows = await fetchGroupItems(gid);
    for (const it of rows) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);

      const cv = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
      const lbl = cv[TYPE_COL]?.label;
      const type = VALID_TYPES.has(lbl) ? lbl : 'Other';
      const num  = toNumber(cv[NUMBER_COL]?.number, cv[NUMBER_COL]?.text);

      bucket[type].push({
        id: it.id,
        name: it.name,
        type,
        installation_date: cv[DATE_COL]?.date ?? null,
        sum_eur: num
      });
    }
  }

  /* ── 3️⃣ respond ───────────────────────── */
  const pack = t => {
    const arr = bucket[t];
    const tot = arr.reduce((s,r)=>s+r.sum_eur,0);
    return { meta:{type:t,total_items:arr.length,total_sum_eur:+tot.toFixed(2)}, items:arr };
  };

  res.status(200).json({
    fetched_at: new Date().toISOString(),
    b2c  : pack('B2C'),
    b2b  : pack('B2B'),
    other: pack('Other')
  });
}

/* ---------- GraphQL payloads (for tests / inspection) ---------- */
export const QUERY_FIRST_PAGE = `
  query ($bid:[ID!]!, $gid:String!){
    boards(ids:$bid){
      groups(ids:[$gid]){
        items_page(limit:500){
          cursor
          items{
            id name
            column_values(ids:["numbers","status6","date8"]){
              id
              ... on NumbersValue{number text}
              ... on StatusValue {label}
              ... on DateValue   {date}
              text
            }
            subitems{
              id name
              column_values(ids:["numbers","status6","date8"]){
                id
                ... on NumbersValue{number text}
                ... on StatusValue {label}
                ... on DateValue   {date}
                text
              }
            }
          }
        }
      }
    }
  }`;

export const QUERY_NEXT_PAGE = `
  query ($c:String!){
    next_items_page(limit:500, cursor:$c){
      cursor
      items{
        id name
        column_values(ids:["numbers","status6","date8"]){
          id
          ... on NumbersValue{number text}
          ... on StatusValue {label}
          ... on DateValue   {date}
          text
        }
        subitems{
          id name
          column_values(ids:["numbers","status6","date8"]){
            id
            ... on NumbersValue{number text}
            ... on StatusValue {label}
            ... on DateValue   {date}
            text
          }
        }
      }
    }
  }`;
