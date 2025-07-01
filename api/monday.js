export default async function handler(req, res) {
  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 1645436514;
  const ALLOWED_STATUSES = ["Įrengta", "Atsiskaityta su partneriais."];
  const TOTAL_SUM_COLUMN_ID = "lookup_mks65gxc";

  const query = `
    query {
      boards(ids: [${BOARD_ID}]) {
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
  `;

  console.log("📡 Sending Monday.com GraphQL query...");
  console.log("🔑 API_KEY:", API_KEY ? "✅ Loaded" : "❌ Missing");
  console.log("📋 BOARD_ID:", BOARD_ID);
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

    const items = data.data.boards[0].items;
    console.log(`📦 Found ${items.length} items`);

    const filteredItems = items.filter((item) => {
      const statusCol = item.column_values.find(
        (col) => col.type === "color" && ALLOWED_STATUSES.includes(col.label)
      );
      return Boolean(statusCol);
    });

    console.log(`✅ Filtered ${filteredItems.length} items matching status`);

    const result = filteredItems.map((item) => {
      const statusCol = item.column_values.find(
        (col) => col.type === "color" && ALLOWED_STATUSES.includes(col.label)
      );

      const totalSumCol = item.column_values.find(
        (col) => col.id === TOTAL_SUM_COLUMN_ID
      );

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
