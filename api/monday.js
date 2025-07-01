export default async function handler(req, res) {
  // ✅ Add CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // ✅ Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const STATUS_COLUMN_ID = "status";
  const FORMULA_COLUMN_ID = "formula_mkmp4x00";

  console.log("✅ Handler invoked");

  // STEP 1: Paginate all matching items
  let allItems = [];
  let cursor = null;
  let page = 1;

  console.log("📡 STEP 1: Fetching ALL items with status = Įrengta (index 1)");

  while (true) {
    const query = `
      query {
        boards(ids: ${BOARD_ID}) {
          items_page(
            limit: 500,
            ${cursor ? `cursor: "${cursor}"` : `query_params: {
              rules: [
                {
                  column_id: "${STATUS_COLUMN_ID}",
                  compare_value: [1],
                  operator: any_of
                }
              ]
            }`}
          ) {
            cursor
            items {
              id
              name
            }
          }
        }
      }
    `;

    console.log(`📄 STEP 1.${page}: Sending paginated request... cursor = ${cursor}`);
    const resPage = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const text = await resPage.text();
    console.log(`📨 STEP 1.${page} response:`, text.slice(0, 1000));
    const json = JSON.parse(text);
    const data = json?.data?.boards?.[0]?.items_page;

    if (!data?.items?.length) break;

    allItems.push(...data.items);
    if (!data.cursor) break;

    cursor = data.cursor;
    page++;
  }

  console.log(`✅ STEP 1 done: Total matching items = ${allItems.length}`);
  if (!allItems.length) return res.status(200).json({ items: [] });

  // STEP 2: Fetch formula values in batches
  const itemIds = allItems.map((i) => i.id);
  const BATCH_SIZE = 100;
  const results = [];

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batchIds = itemIds.slice(i, i + BATCH_SIZE);
    const query = `
      query {
        items(ids: [${batchIds.join(",")}]) {
          id
          name
          column_values(ids: ["${FORMULA_COLUMN_ID}", "${STATUS_COLUMN_ID}"]) {
            id
            type
            ... on FormulaValue {
              display_value
            }
            ... on StatusValue {
              label
            }
          }
        }
      }
    `;

    console.log(`📡 STEP 2.${i / BATCH_SIZE + 1}: Fetching formula values for ${batchIds.length} items`);
    const formulaRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const raw = await formulaRes.text();
    console.log("📨 STEP 2 raw:", raw.slice(0, 1000));
    const data = JSON.parse(raw);

    const batchResults = data?.data?.items?.map((item) => {
      const formula = item.column_values.find((col) => col.id === FORMULA_COLUMN_ID);
      const status = item.column_values.find((col) => col.id === STATUS_COLUMN_ID);
      return {
        id: item.id,
        name: item.name,
        status: status?.label || null,
        total_sum: formula?.display_value ?? null,
      };
    }) || [];

    results.push(...batchResults);
  }

  console.log(`✅ STEP 2 complete: ${results.length} items fetched`);

  // STEP 3: Clean and structure data
  const cleanItems = results
    .map((item) => {
      const raw = item.total_sum;
      if (!raw || raw === "No result") return null;

      const dotCount = (raw.match(/\./g) || []).length;
      const normalized =
        dotCount >= 2
