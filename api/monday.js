export default async function handler(req, res) {
  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const STATUS_COLUMN_ID = "status";
  const FORMULA_COLUMN_ID = "formula_mkmp4x00"; // the real one you want to read

  console.log("📡 STEP 1: Fetching item IDs by status...");

  const statusFilterQuery = `
    query {
      boards(ids: ${BOARD_ID}) {
        items_page(
          limit: 500,
          query_params: {
            rules: [
              {
                column_id: "${STATUS_COLUMN_ID}",
                compare_value: ["Įrengta", "Atsiskaityta su partneriu"],
                operator: any_of
              }
            ]
          }
        ) {
          items {
            id
            name
          }
        }
      }
    }
  `;

  try {
    const filterRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: statusFilterQuery }),
    });

    const filterRaw = await filterRes.text();
    console.log("📨 STEP 1 raw:", filterRaw.slice(0, 3000));
    const filtered = JSON.parse(filterRaw);
    const items = filtered.data.boards[0].items_page.items;

    if (!items.length) {
      return res.status(200).json({ items: [] });
    }

    const itemIds = items.map((i) => i.id);
    console.log(`🔢 STEP 1: Found ${itemIds.length} matching items`);

    // STEP 2: Fetch formula values
    const formulaQuery = `
      query {
        items(ids: [${itemIds.join(",")}]) {
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

    console.log("📡 STEP 2: Fetching formula values...");
    const formulaRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: formulaQuery }),
    });

    const formulaRaw = await formulaRes.text();
    console.log("📨 STEP 2 raw:", formulaRaw.slice(0, 3000));
    const formulaData = JSON.parse(formulaRaw);

    const results = formulaData.data.items.map((item) => {
      const formulaCol = item.column_values.find((col) => col.id === FORMULA_COLUMN_ID);
      const statusCol = item.column_values.find((col) => col.id === STATUS_COLUMN_ID);

      return {
        id: item.id,
        name: item.name,
        status: statusCol?.label || null,
        total_sum: formulaCol?.display_value ?? null,
      };
    });

    return res.status(200).json({ items: results });
  } catch (err) {
    console.error("💥 Fetch failed:", err);
    return res.status(500).json({
      error: "Failed to fetch Monday.com data",
      details: err.message,
    });
  }
}
