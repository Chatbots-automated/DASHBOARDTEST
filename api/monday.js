/**
 * /api/monday.js
 * Pull every item that lives in groups new_group50055 / new_group89286,
 * bucket them by status6 →  B2C • B2B • Other, and spit out totals + rows.
 * — now with VERBOSE LOGGING so we can see where things blow up 🙂
 */
export default async function handler (req, res) {
  /* –– CORS –– */
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* –– ENV –– */
  const API_KEY = process.env.MONDAY_API_KEY;
  if (!API_KEY) return res.status(500).json({error:'MONDAY_API_KEY missing'});

  /* –– IDs & constants –– */
  const BOARD_ID   = 1645436514;
  const GROUP_IDS  = ['new_group50055','new_group89286'];      // scope
  const TYPE_COL   = 'status6';           // B2C / B2B
  const NUMBER_COL = 'numbers';           // Deal value (plain number)
  const DATE_COL   = 'date8';             // Actual Installation
  const VALID      = new Set(['B2C','B2B']);

  /* –– helpers –– */
  const HEADERS = {Authorization:API_KEY,'Content-Type':'application/json'};

  /** Small helper to pretty-print *part* of a JSON for the logs */
  const peek = (obj, n = 2) =>
    JSON.stringify(
      Array.isArray(obj) ? obj.slice(0, n) : obj,
      null, 2
    ).substring(0, 800);                // don’t flood the logs

  async function gql(label, query, variables = undefined) {
    const body = variables ? { query, variables } : { query };
    /* make the request (w/ simple 429 back-off just in case) */
    while (true) {
      const r = await fetch('https://api.monday.com/v2', {
        method: 'POST', headers: HEADERS, body: JSON.stringify(body)
      });

      if (r.status === 429) {                 // minute-rate → wait + retry
        const wait = (+r.headers.get('Retry-After') || 1) * 1000;
        console.warn(`⏳  ${label} hit 429 – retrying in ${wait} ms`);
        await new Promise(t => setTimeout(t, wait));
        continue;
      }

      const j = await r.json();
      if (j.errors) {
        console.error(`💥  ${label} returned errors:\n`,
                      JSON.stringify(j.errors, null, 2));
        throw new Error('Monday API error');
      }

      console.log(`📨  ${label} OK – payload preview:\n${peek(j.data)}`);
      return j.data;
    }
  }

  /* –– 1️⃣  collect EVERY id in the two groups –– */
  async function collectIds () {
    const ids = [];

    /* ---------- first page (board-level filter by group) ---------- */
    const groupRule = GROUP_IDS.map(g => `"${g}"`).join(',');
    let page = (await gql(
      'first items_page',
      `
      query {
        boards(ids:${BOARD_ID}) {
          items_page(
            limit: 500
            query_params: {
              rules: [
                { column_id:"group",
                  compare_value:[${groupRule}],
                  operator: any_of }
              ]
            }
          ) {
            cursor
            items { id }
          }
        }
      }`
    )).boards?.[0]?.items_page;

    console.log(`🔍  first page items: ${page?.items?.length || 0}`);
    ids.push(...(page?.items || []).map(i => i.id));

    /* ---------- follow the cursor chain ---------- */
    while (page?.cursor) {
      page = (await gql(
        `next_items_page (${ids.length} accumulated so far)`,
        `
        query ($c: String!) {
          next_items_page(limit: 500, cursor:$c) {
            cursor
            items { id }
          }
        }`,
        { c: page.cursor }
      )).next_items_page;

      console.log(`🔍  next page items: ${page?.items?.length || 0}`);
      if (!page?.items?.length) break;
      ids.push(...page.items.map(i => i.id));
    }

    console.log(`🧮  TOTAL unique IDs collected: ${ids.length}`);
    return ids;
  }

  /* –– 2️⃣  hydrate & bucket –– */
  const parseNumber = raw =>
    raw == null || raw === '' ? 0 : Number(raw);

  async function hydrate (allIds) {
    const bucket = { B2C: [], B2B: [], Other: [] };

    for (let i = 0; i < allIds.length; i += 100) {
      const slice = allIds.slice(i, i + 100);

      const resp = await gql(
        `items slice ${i}–${i + slice.length}`,
        `
        query ($ids:[ID!]!) {
          items(ids:$ids){
            id name
            column_values(ids:["${NUMBER_COL}","${TYPE_COL}","${DATE_COL}"]){
              id
              ... on NumbersValue { number }
              ... on StatusValue  { label }
              ... on DateValue    { date }
              text               # fallback when nothing else
            }
          }
        }`,
        { ids: slice }
      );

      for (const it of resp.items || []) {
        const cv   = Object.fromEntries(it.column_values.map(c => [c.id, c]));
        const rawT = cv[TYPE_COL]?.label;
        const type = VALID.has(rawT) ? rawT : 'Other';

        /* prefer the typed “number” field; fall back to text */
        const rawN = cv[NUMBER_COL]?.number ??
                     parseNumber(cv[NUMBER_COL]?.text) ?? 0;

        bucket[type].push({
          id  : it.id,
          name: it.name,
          type,
          installation_date: cv[DATE_COL]?.date ?? null,
          sum_eur: rawN
        });
      }

      console.log(`✅  processed slice ${i}–${i + slice.length}`);
    }

    /* build response */
    const pack = t => {
      const arr = bucket[t];
      const tot = arr.reduce((s, r) => s + r.sum_eur, 0);
      return {
        meta: { type: t, total_items: arr.length, total_sum_eur: +tot.toFixed(2) },
        items: arr
      };
    };

    return { b2c: pack('B2C'), b2b: pack('B2B'), other: pack('Other') };
  }

  /* –– RUN –– */
  try {
    const ids  = await collectIds();   // <- logs will show exactly what we got
    const data = await hydrate(ids);
    res.status(200).json(data);
  } catch (e) {
    console.error('🚨  FINAL ERROR:', e);
    res.status(500).json({ error:'Monday API error', details:e.message || e });
  }
}
