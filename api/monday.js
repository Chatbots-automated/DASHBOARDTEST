export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const STATUS_COLUMN_ID = "status";     // Įrengta = 1, Atsiskaityta = 6
  const TYPE_COLUMN_ID = "status6";      // B2C = 1, B2B = 2
  const FORMULA_COLUMN_ID = "formula_mkmp4x00";
  const DATE_COLUMN_ID = "date8";        // Installation time

  async function fetchItems(typeIndex) {
    let allItems = [];
    let cursor = null;

    const initialQuery = `
      query {
        items_page_by_column_values(
          board_id: ${BOARD_ID},
          limit: 500,
          columns: [
            { column_id: "${STATUS_COLUMN_ID}", column_values: ["Įrengta", "Atsiskaityta"] },
            { column_id: "${TYPE_COLUMN_ID}", column_values: ["${typeIndex === 1 ? 'B2C' : 'B2B'}"] }
          ]
        ) {
          cursor
          items { id name }
        }
      }
    `;

    const resPage = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: initialQuery }),
    });

    const text = await resPage.text();
    const json = JSON.parse(text);
    const pageData = json?.data?.items_page_by_column_values;

    if (pageData?.items?.length) {
      allItems.push(...pageData.items);
      cursor = pageData.cursor;
    }

    while (cursor) {
      const cursorQuery = `
        query {
          next_items_page(cursor: "${cursor}", limit: 500) {
            cursor
            items { id name }
          }
        }
      `;

      const resNext = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: {
          Authorization: API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: cursorQuery }),
      });

      const textNext = await resNext.text();
      const jsonNext = JSON.parse(textNext);
      const nextData = jsonNext?.data?.next_items_page;

      if (!nextData?.items?.length) break;

      allItems.push(...nextData.items);
      cursor = nextData.cursor;
    }

    return allItems.map((item) => item.id);
  }

  async function fetchItemDetails(ids, typeLabel) {
    const BATCH_SIZE = 100;
    const results = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const query = `
        query {
          items(ids: [${batch.join(",")}]) {
            id
            name
            column_values(ids: ["${FORMULA_COLUMN_ID}", "${STATUS_COLUMN_ID}", "${TYPE_COLUMN_ID}", "${DATE_COLUMN_ID}"]) {
              id
              type
              ... on FormulaValue { display_value }
              ... on StatusValue { label }
              ... on DateValue { date }
            }
          }
        }
      `;

      const formulaRes = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: {
          Authorization: API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      const raw = await formulaRes.text();
      const data = JSON.parse(raw);

      const batchResults = data?.data?.items?.map((item) => {
        const formula = item.column_values.find((col) => col.id === FORMULA_COLUMN_ID);
        const status = item.column_values.find((col) => col.id === STATUS_COLUMN_ID);
        const date = item.column_values.find((col) => col.id === DATE_COLUMN_ID);
        return {
          id: item.id,
          name: item.name,
          status: status?.label || null,
          type: typeLabel,
          installation_date: date?.date || null,
          total_sum: formula?.display_value ?? null,
        };
      }) || [];

      results.push(...batchResults);
    }

    const cleanItems = results
      .map((item) => {
        const raw = item.total_sum;
        if (!raw || raw === "No result") return null;
        const dotCount = (raw.match(/\./g) || []).length;
        const normalized =
          dotCount >= 2 ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(",", ".");
        const parsed = parseFloat(normalized);
        if (isNaN(parsed)) return null;

        return {
          id: item.id,
          name: item.name,
          status: item.status,
          type: item.type,
          installation_date: item.installation_date,
          sum_eur: parsed,
        };
      })
      .filter((i) => i !== null);

    const totalSum = cleanItems.reduce((acc, item) => acc + item.sum_eur, 0);

    return {
      meta: {
        type: typeLabel,
        total_items: cleanItems.length,
        total_sum_eur: parseFloat(totalSum.toFixed(2)),
      },
      items: cleanItems,
    };
  }

  const b2cIds = await fetchItems(1);
  const b2c = await fetchItemDetails(b2cIds, "B2C");

  const b2bIds = await fetchItems(2);
  const b2b = await fetchItemDetails(b2bIds, "B2B");

  return res.status(200).json({ b2c, b2b });
}
