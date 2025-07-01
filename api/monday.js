async function fetchItems(typeIndex) {
  let allItems = [];
  let cursor = null;

  const filterBlock = `
    query_params: {
      rules: [
        { column_id: "${STATUS_COLUMN_ID}", compare_value: [1, 6], operator: any_of },
        { column_id: "${TYPE_COLUMN_ID}", compare_value: [${typeIndex}], operator: any_of }
      ]
    }
  `;

  while (true) {
    const query = `
      query {
        boards(ids: ${BOARD_ID}) {
          items_page(
            limit: 500,
            ${cursor ? `cursor: "${cursor}"` : filterBlock}
          ) {
            cursor
            items { id name }
          }
        }
      }
    `;

    const resPage = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const text = await resPage.text();
    const json = JSON.parse(text);
    const data = json?.data?.boards?.[0]?.items_page;

    if (!data?.items?.length) break;

    allItems.push(...data.items);
    if (!data.cursor) break;

    cursor = data.cursor;
  }

  return allItems.map((item) => item.id);
}
