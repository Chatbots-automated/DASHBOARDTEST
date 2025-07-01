/**
 * /api/monday.js  –  everything, every time.
 * Groups: new_group50055  |  new_group89286
 * Buckets by status6      →  B2C · B2B · Other
 * Returns: { b2c, b2b, other }  each with meta + raw rows
 */
export default async function handler (req, res) {
  /* ── CORS ─────────────────────────────── */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── ENV ──────────────────────────────── */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY)
    return res.status(500).json({ error: 'MONDAY_API_KEY missing' });

  /* ── IDs / columns ────────────────────── */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055', 'new_group89286'];
  const TYPE_COL   = 'status6';           // “B2C” / “B2B”
  const NUMBER_COL = 'numbers';           // deal value (No-VAT)
  const DATE_COL   = 'date8';             // install date
  const VALID_TYPES = new Set(['B2C', 'B2B']);

  /* ── low-level gql helper ─────────────── */
  const HEADERS = { Authorization: API_KEY, 'Content-Type': 'application/json' };
  async function gql (label, query, variables) {
    const body = variables ? { query, variables } : { query };
    let wait = 1_000;                     // start with 1 s back-off
    for (;;) {
      const r = await fetch('https://api.monday.com/v2', {
        method: 'POST', headers: HEADERS, body: JSON.stringify(body)
      });
      const j = await r.json();

      /* retry bucket – complexity, minute, daily */
      const err = j.errors?.[0];
      const code = err?.extensions?.code || '';
      if (code.includes('Complexity') ||
          code.includes('DAILY_LIMIT') ||
          code.includes('MINUTE_LIMIT') ||
          r.status === 429) {
        console.warn(`⏳  ${label}: rate-limited (${code||r.status}) – retry in ${wait/1000}s`);
        await new Promise(t => setTimeout(t, wait));
        wait = Math.min(wait * 2, 30_000);   // cap at 30 s
        continue;
      }
      if (j.errors) {                       // unknown error → bail
        console.error(`💥  ${label} failed`, JSON.stringify(j.errors,null,2));
        throw new Error('monday API fatal');
      }
      return j.data;
    }
  }

  /* ── helper: safe number parse ─────────── */
  const toNumber = (n, txt) =>
    typeof n === 'number'
      ? n
      : (Number(txt?.replace(/[^\d.,-]/g,'').replace(',','.')) || 0);

  /* ── 1️⃣  get every item (and sub-item) from one group ───────── */
  async function fetchGroupItems (gid) {
    let page = await gql(
      `first items_page ${gid}`,
      `
      query($bid:[ID!]!,$gid:String!){
        boards(ids:$bid){
          groups(ids:[$gid]){
            items_page(limit:500){
              cursor
              items{
                id name
                column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                  id
                  ... on NumbersValue{number text}
                  ... on StatusValue {label}
                  ... on DateValue   {date}
                  text
                }
                subitems{
                  id name
                  column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
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
      }`, { bid:[BOARD_ID], gid });

    const buf = [];

    function harvest(list){
      for (const it of list){
        buf.push(it);
        if (it.subitems?.length) buf.push(...it.subitems);
      }
    }
    harvest(page.boards[0].groups[0].items_page.items);

    /* follow cursor until empty */
    let cursor = page.boards[0].groups[0].items_page.cursor;
    while (cursor) {
      page = await gql(
        `next_items_page ${gid}`,
        `
        query($c:String!){
          next_items_page(limit:500,cursor:$c){
            cursor
            items{
              id name
              column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                id
                ... on NumbersValue{number text}
                ... on StatusValue {label}
                ... on DateValue   {date}
                text
              }
              subitems{
                id name
                column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
                  id
                  ... on NumbersValue{number text}
                  ... on StatusValue {label}
                  ... on DateValue   {date}
                  text
                }
              }
            }
          }
        }`, { c: cursor });
      const step = page.next_items_page;
      harvest(step.items);
      cursor = step.cursor;
    }

    console.log(`✅  ${gid} – total rows (incl. subitems): ${buf.length}`);
    return buf;
  }

  /* ── 2️⃣  pull every group, bucket on the fly ────────────────── */
  const bucket = { B2C: [], B2B: [], Other: [] };
  const seen   = new Set();               // dedupe across groups, just in case

  for (const gid of GROUP_IDS) {
    const rows = await fetchGroupItems(gid);

    for (const it of rows) {
      if (seen.has(it.id)) continue;      // dup guard
      seen.add(it.id);

      const cv   = Object.fromEntries(it.column_values.map(c=>[c.id,c]));
      const lbl  = cv[TYPE_COL]?.label;
      const type = VALID_TYPES.has(lbl) ? lbl : 'Other';

      const num  = toNumber(cv[NUMBER_COL]?.number, cv[NUMBER_COL]?.text);

      bucket[type].push({
        id  : it.id,
        name: it.name,
        type,
        installation_date: cv[DATE_COL]?.date ?? null,
        sum_eur: num
      });
    }
  }

  /* ── 3️⃣  pack & send ───────────────────── */
  const pack = key => {
    const arr = bucket[key];
    const tot = arr.reduce((s,r)=>s+r.sum_eur,0);
    return {
      meta : { type:key, total_items:arr.length, total_sum_eur:+tot.toFixed(2) },
      items: arr
    };
  };

  res.status(200).json({
    b2c  : pack('B2C'),
    b2b  : pack('B2B'),
    other: pack('Other')
  });
}
