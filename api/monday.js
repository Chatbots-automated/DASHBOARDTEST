export default async function handler(req, res) {
  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const STATUS_COLUMN_ID = "status"; // change this if your column ID is different
  const TOTAL_SUM_COLUMN_ID = "lookup_mks65gxc";

  const query = `
    query {
      boards(ids: ${BOARD_ID}) {
        items_page(
          limit: 500,
          query_params: {
            rules: [
              {
                column_id: "${STATUS_COLUMN_ID}",
                compare_value: ["Įrengta", "Atsiskaityta su partneriais."],
                operator: any_of
              }
            ]
          }
        ) {
          cursor
          items {
            id
            name
            column_values {
              id
              text
              type
              ... on StatusValue {
                label
              }
              ... on FormulaValue {
                text
              }
            }
          }
        }
      }
    }
  `;

  console.log("📡 Sending Monday.com GraphQL query...");
  console.log("🔑 API_KEY:", API_KEY ? "✅ Loaded" : "❌ Missing");
  console.log("📤 QUERY:", query);

  try {
    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const raw = await response.text();
    console.log("📨 Raw response:", raw.slice(0, 3000));
    const data = JSON.parse(raw);

    if (data.errors) {
      console.error("❌ GraphQL Error:", data.errors);
      return res.status(500).json({ error: data.errors });
    }

    const items = data.data.boards[0].items_page.items;
    console.log(`📦 Found ${items.length} filtered items`);

    const result = items.map((item) => {
      const statusCol = item.column_values.find((col) => col.type === "color");
      const totalSumCol = item.column_values.find((col) => col.id === TOTAL_SUM_COLUMN_ID);

      return {
        id: item.id,
        name: item.name,
        status: statusCol?.label || null,
        total_sum: totalSumCol?.text ?? null,
      };
    });

    return res.status(200).json({ items: result });
  } catch (err) {
    console.error("💥 Fetch failed:", err);
    return res.status(500).json({
      error: "Failed to fetch Monday.com data",
      details: err.message,
    });
  }
}
