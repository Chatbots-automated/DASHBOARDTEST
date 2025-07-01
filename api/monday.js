export default async function handler(req, res) {
  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const STATUS_COLUMN_ID = "status";
  const FORMULA_COLUMN_ID = "formula_mkmp4x00";

  console.log("✅ Handler invoked");

 const statusFilterQuery = `
  query {
    boards(ids: ${BOARD_ID}) {
      items_page(
        limit: 500,
        query_params: {
          rules: [
            {
              column_id: "${STATUS_COLUMN_ID}",
              compare_value: [1],
              operator: any_of
            }
          ]
        }
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



  console.log("📡 STEP 1: Fetching item IDs with status = Įrengta");
  console.log("📝 STEP 1 QUERY:\n", statusFilterQuery);

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
    console.log("📨 STEP 1 Raw Response:", filterRaw.slice(0, 1000));
    const filtered = JSON.parse(filterRaw);
    const items = filtered?.data?.boards?.[0]?.items_page?.items;

    if (!items || !items.length) {
      console.warn("⚠️ STEP 1: No items matched Įrengta");
      return res.status(200).json({ items: [] });
    }

    const itemIds = items.map((i) => i.id);
    console.log(`🔢 STEP 1: Found ${itemIds.length} item(s):`, itemIds);

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
    console.log("📝 STEP 2 QUERY:\n", formulaQuery);

    const formulaRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: formulaQuery }),
    });

    const formulaRaw = await formulaRes.text();
    console.log("📨 STEP 2 Raw Response:", formulaRaw.slice(0, 1000));
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

    console.log(`✅ STEP 2: Returning ${results.length} result(s)`);
    return res.status(200).json({ items: results });

  } catch (err) {
    console.error("💥 UNHANDLED ERROR:", err);
    return res.status(500).json({
      error: "Unhandled exception occurred",
      details: err.message || err,
    });
  }
}
