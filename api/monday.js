// api/monday.js
export default async function handler(req, res) {
  const API_KEY = process.env.MONDAY_API_KEY;
  const BOARD_ID = 20114622;

  const query = `
    query {
      boards(ids: ${BOARD_ID}) {
        name
        items {
          id
          name
          column_values {
            id
            text
            title
            value
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Authorization": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (data.errors) {
      return res.status(500).json({ error: data.errors });
    }

    return res.status(200).json(data.data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch Monday.com data", details: err.message });
  }
}
