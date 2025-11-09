import { callShopify } from "./client";

const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "sort_order";

// Helper function to safely access nested properties
function getNestedProperty(obj: any, path: string) {
  return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

// Helper to handle Shopify's pagination (cursor-based)
async function fetchAllNodes(
  query: string,
  variables: Record<string, any>,
  dataKey: string
) {
  let allNodes: any[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await callShopify(query, { ...variables, after: cursor });
    const connection = getNestedProperty(response.data, dataKey);

    if (!connection || !connection.nodes) {
      throw new Error(
        `Could not find nodes at key "${dataKey}" in the API response.`
      );
    }

    allNodes = allNodes.concat(connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return allNodes;
}

// Main function to sort all collections
export async function sortAllCollections() {
  console.log("Starting process to sort all collections...");

  // 1. Fetch all collection IDs
  const collectionsQuery = `
    query getCollections($after: String) {
      collections(first: 50, after: $after) {
        nodes {
          id
          handle
          sortOrder
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const allCollections = await fetchAllNodes(
    collectionsQuery,
    {},
    "collections"
  );

  console.log(`Found ${allCollections.length} collections to process.`);

  // 2. Process each collection sequentially
  for (let i = 0; i < allCollections.length; i++) {
    const collection = allCollections[i];
    console.log(
      `--- Processing collection ${i + 1} / ${allCollections.length}: ${
        collection.handle
      } ---`
    );
    await processCollection(collection.id);
  }

  console.log("--- All collections have been processed successfully! ---");
}

// Processes a single collection
export async function processCollection(collectionId: string) {
  // First, get the collection details, since we only have the ID now.
  const collectionDetailsQuery = `
    query getCollectionDetails($id: ID!) {
      collection(id: $id) {
        id
        handle
        sortOrder
      }
    }
  `;
  const collectionResponse = await callShopify(collectionDetailsQuery, {
    id: collectionId,
  });
  const collection = collectionResponse.data.collection;

  if (!collection) {
    console.error(`Could not find collection with ID: ${collectionId}`);
    return;
  }

  try {
    // 1. Ensure collection is set to manual sorting
    if (collection.sortOrder !== "MANUAL") {
      console.log("Updating collection sort order to MANUAL...");
      const updateMutation = `
        mutation collectionUpdate($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            collection { id }
            userErrors { field message }
          }
        }
      `;
      await callShopify(updateMutation, {
        input: { id: collection.id, sortOrder: "MANUAL" },
      });
    }

    // 2. Fetch all products in the collection with their sort order metafield
    const productsQuery = `
      query getCollectionProducts($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 100, after: $after) {
            nodes {
              id
              metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
                value
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;
    const allProducts = await fetchAllNodes(
      productsQuery,
      { id: collection.id },
      "collection.products"
    );

    if (allProducts.length === 0) {
      console.log("Collection has no products to sort. Skipping.");
      return;
    }

    // 3. Sort products based on the metafield value
    const sortedProducts = allProducts.sort((a, b) => {
      const sortA = a.metafield ? parseInt(a.metafield.value, 10) : Infinity;
      const sortB = b.metafield ? parseInt(b.metafield.value, 10) : Infinity;
      return sortA - sortB;
    });

    const sortedProductIds = sortedProducts.map((p) => p.id);

    // 4. Reorder the products in the collection
    console.log(`Reordering ${sortedProductIds.length} products...`);
    const reorderMutation = `
      mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }
    `;
    // The `collectionReorderProducts` mutation requires you to specify the new position of each product.
    // The simplest way is to send the full list of IDs in the new order.
    const moves = sortedProductIds.map((id, index) => ({
      id,
      newPosition: String(index),
    }));

    // This mutation can fail if the list is too long. Let's chunk it.
    const chunkSize = 250;
    for (let i = 0; i < moves.length; i += chunkSize) {
      const chunk = moves.slice(i, i + chunkSize);
      await callShopify(reorderMutation, { id: collection.id, moves: chunk });
    }

    console.log("✅ Successfully reordered products.");
  } catch (error: any) {
    console.error(
      `❌ Failed to process collection ${collection.handle}:`,
      error.message
    );
  }
}
