import { ApiError } from "next/dist/server/api-utils";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN as string;

const SHOPIFY_STORE_DOMAIN_TEST = process.env.SHOPIFY_STORE_DOMAIN_TEST;
const SHOPIFY_ADMIN_TOKEN_TEST = process.env.SHOPIFY_ADMIN_TOKEN_TEST as string;

const API_VERSION = process.env.API_VERSION || "2024-07";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error(
    "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN environment variables."
  );
}

async function shopifyFetch(
  query: string,
  variables: any,
  isTest: boolean = false
) {
  const SHOPIFY_GRAPHQL_URL = `https://${
    isTest ? SHOPIFY_STORE_DOMAIN_TEST : SHOPIFY_STORE_DOMAIN
  }/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(SHOPIFY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": isTest
        ? SHOPIFY_ADMIN_TOKEN_TEST
        : SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status,
      `Shopify API Error: ${res.statusText} - ${text}`
    );
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new ApiError(
      400,
      "Shopify GraphQL Error: " + JSON.stringify(json.errors)
    );
  }
  return json;
}

export async function callShopify(
  query: string,
  variables = {},
  isTest: boolean = false
) {
  while (true) {
    try {
      const data = await shopifyFetch(query, variables);

      if (!data.extensions || !data.extensions.cost) {
        return data;
      }

      const cost = data.extensions.cost;
      const bucket = cost.throttleStatus;
      const shortfall = cost.requestedQueryCost - bucket.currentlyAvailable;

      if (shortfall > 0) {
        const waitMs = (shortfall / bucket.restoreRate) * 1000 + 100; // +100 ms buffer
        console.log(`Throttled, waiting ${waitMs.toFixed(2)}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return data;
    } catch (error: any) {
      console.error("Error in callShopify:", error.message);
      if (error instanceof ApiError && error.statusCode === 429) {
        console.log("Rate limit error detected, retrying in 5s...");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // For other errors, re-throw after a delay
      await new Promise((r) => setTimeout(r, 5000));
      throw error;
    }
  }
}

export async function fetchAllShopifyVariants() {
  const variants = new Map<string, { inventoryItemId: string; cost: string }>();
  let cursor = null;
  let hasNextPage = true;

  console.log("Fetching all Shopify product variants...");

  while (hasNextPage) {
    const query = `
      query productVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              barcode
              inventoryItem {
                id
                unitCost {
                  amount
                }
              }
            }
          }
        }
      }
    `;
    const variables = { cursor };
    const data = await callShopify(query, variables);

    data.data.productVariants.edges.forEach((edge: any) => {
      if (edge.node.barcode && edge.node.inventoryItem) {
        variants.set(edge.node.barcode, {
          inventoryItemId: edge.node.inventoryItem.id,
          cost: edge.node.inventoryItem.unitCost?.amount,
        });
      }
    });

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    cursor = data.data.productVariants.pageInfo.endCursor;
    console.log(`Fetched page of variants, total fetched: ${variants.size}`);
  }

  console.log(`Finished fetching all variants. Total: ${variants.size}`);
  return variants;
}

export async function runCostUpdateBulkMutation(
  updates: { inventoryItemId: string; cost: number }[]
) {
  console.log(`Preparing bulk mutation for ${updates.length} cost updates.`);
  // 1. Create staged upload
  const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const jsonl = updates
    .map((u) =>
      JSON.stringify({
        input: {
          id: u.inventoryItemId,
          cost: u.cost.toString(),
        },
      })
    )
    .join("\n");

  const stagedUploadsInput = {
    input: [
      {
        resource: "BULK_MUTATION_VARIABLES",
        filename: "bulk-update-costs.jsonl",
        mimeType: "application/jsonl",
        httpMethod: "POST",
      },
    ],
  };

  const stagedUploadsResult = await callShopify(
    stagedUploadsQuery,
    stagedUploadsInput
  );
  const target = stagedUploadsResult.data.stagedUploadsCreate.stagedTargets[0];
  const { url, parameters } = target;

  // 2. Upload the file
  const formData = new FormData();
  parameters.forEach(({ name, value }: { name: string; value: string }) => {
    formData.append(name, value);
  });
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));

  const uploadResponse = await fetch(url, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload to staged target: ${errorText}`);
  }
  console.log("Successfully uploaded JSONL file for bulk mutation.");

  // 3. Run the bulk mutation
  const bulkMutationQuery = `
    mutation inventoryItemUpdate($input: InventoryItemInput!) {
      inventoryItemUpdate(input: $input) {
        inventoryItem {
          id
          cost
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const bulkOperationRunMutation = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const key = parameters.find((p: any) => p.name === "key").value;
  const bulkOperationResult = await callShopify(bulkOperationRunMutation, {
    mutation: bulkMutationQuery,
    stagedUploadPath: key,
  });

  if (bulkOperationResult.data.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(
      `Failed to start bulk operation: ${JSON.stringify(
        bulkOperationResult.data.bulkOperationRunMutation.userErrors
      )}`
    );
  }

  console.log("Bulk mutation started successfully.");
  return bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
}

export type ShopifyProductInfo = {
  id: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  variants: {
    id: string;
    barcode: string;
    price: string;
    compareAtPrice: string | null;
  }[];
};

export async function fetchAllShopifyProductsAndVariants(): Promise<
  Map<string, ShopifyProductInfo>
> {
  const products = new Map<string, ShopifyProductInfo>();
  let cursor = null;
  let hasNextPage = true;

  console.log("Fetching all Shopify products and variants...");

  while (hasNextPage) {
    const query = `
      query products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              status
              variants(first: 100) {
                edges {
                  node {
                    id
                    barcode
                    price
                    compareAtPrice
                  }
                }
              }
            }
          }
        }
      }
    `;
    const variables = { cursor };
    const data = await callShopify(query, variables);

    data.data.products.edges.forEach((edge: any) => {
      products.set(edge.node.id, {
        id: edge.node.id,
        status: edge.node.status,
        variants: edge.node.variants.edges.map((vEdge: any) => vEdge.node),
      });
    });

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
    console.log(`Fetched page of products, total fetched: ${products.size}`);
  }

  console.log(`Finished fetching all products. Total: ${products.size}`);
  return products;
}

export async function runPriceUpdateBulkMutation(
  updates: {
    variantId: string;
    price: string;
    compareAtPrice: string | null;
  }[]
) {
  console.log(`Preparing bulk mutation for ${updates.length} price updates.`);
  const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url, parameters { name, value } }
        userErrors { field, message }
      }
    }
  `;
  const jsonl = updates
    .map((u) =>
      JSON.stringify({
        input: {
          id: u.variantId,
          price: u.price,
          compareAtPrice: u.compareAtPrice,
        },
      })
    )
    .join("\n");

  // Steps 1 & 2: Staged Upload
  const stagedUploadsInput = {
    input: [
      {
        resource: "BULK_MUTATION_VARIABLES",
        filename: "price-updates.jsonl",
        mimeType: "application/jsonl",
        httpMethod: "POST",
      },
    ],
  };
  const stagedUploadsResult = await callShopify(
    stagedUploadsQuery,
    stagedUploadsInput
  );
  const target = stagedUploadsResult.data.stagedUploadsCreate.stagedTargets[0];
  const { url, parameters } = target;
  const formData = new FormData();
  parameters.forEach(({ name, value }: any) => formData.append(name, value));
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));
  const uploadResponse = await fetch(url, { method: "POST", body: formData });
  if (!uploadResponse.ok)
    throw new Error(
      `Failed to upload to staged target: ${await uploadResponse.text()}`
    );
  console.log("Successfully uploaded JSONL for price update bulk mutation.");

  // Step 3: Run the bulk mutation
  const bulkMutationQuery = `
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant { id, price, compareAtPrice }
        userErrors { field, message }
      }
    }
  `;
  const bulkOperationRunMutation = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id, status }
        userErrors { field, message }
      }
    }
  `;
  const key = parameters.find((p: any) => p.name === "key").value;
  const bulkOperationResult = await callShopify(bulkOperationRunMutation, {
    mutation: bulkMutationQuery,
    stagedUploadPath: key,
  });
  if (bulkOperationResult.data.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(
      `Failed to start price bulk operation: ${JSON.stringify(
        bulkOperationResult.data.bulkOperationRunMutation.userErrors
      )}`
    );
  }

  console.log("Price update bulk mutation started successfully.");
  return bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
}

export async function runStatusUpdateBulkMutation(
  updates: { productId: string; status: "ACTIVE" | "DRAFT" }[]
) {
  console.log(`Preparing bulk mutation for ${updates.length} status updates.`);
  const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url, parameters { name, value } }
        userErrors { field, message }
      }
    }
  `;
  const jsonl = updates
    .map((u) =>
      JSON.stringify({
        input: {
          id: u.productId,
          status: u.status,
        },
      })
    )
    .join("\n");

  // Steps 1 & 2: Staged Upload
  const stagedUploadsInput = {
    input: [
      {
        resource: "BULK_MUTATION_VARIABLES",
        filename: "status-updates.jsonl",
        mimeType: "application/jsonl",
        httpMethod: "POST",
      },
    ],
  };
  const stagedUploadsResult = await callShopify(
    stagedUploadsQuery,
    stagedUploadsInput
  );
  const target = stagedUploadsResult.data.stagedUploadsCreate.stagedTargets[0];
  const { url, parameters } = target;
  const formData = new FormData();
  parameters.forEach(({ name, value }: any) => formData.append(name, value));
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));
  const uploadResponse = await fetch(url, { method: "POST", body: formData });
  if (!uploadResponse.ok)
    throw new Error(
      `Failed to upload to staged target: ${await uploadResponse.text()}`
    );
  console.log("Successfully uploaded JSONL for status update bulk mutation.");

  // Step 3: Run the bulk mutation
  const bulkMutationQuery = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id, status }
        userErrors { field, message }
      }
    }
  `;
  const bulkOperationRunMutation = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id, status }
        userErrors { field, message }
      }
    }
  `;
  const key = parameters.find((p: any) => p.name === "key").value;
  const bulkOperationResult = await callShopify(bulkOperationRunMutation, {
    mutation: bulkMutationQuery,
    stagedUploadPath: key,
  });
  if (bulkOperationResult.data.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(
      `Failed to start status bulk operation: ${JSON.stringify(
        bulkOperationResult.data.bulkOperationRunMutation.userErrors
      )}`
    );
  }

  console.log("Status update bulk mutation started successfully.");
  return bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
}
