import { ApiError } from "next/dist/server/api-utils";
import { sendBulkOpTimeoutAlert } from "./alerts";
import { SHOPIFY_API_VERSION } from "./config";

const API_VERSION = SHOPIFY_API_VERSION;

function getShopifyEnv(isTest: boolean): { domain: string; token: string } {
  const domain = isTest
    ? process.env.SHOPIFY_STORE_DOMAIN_TEST
    : process.env.SHOPIFY_STORE_DOMAIN;
  const token = isTest
    ? process.env.SHOPIFY_ADMIN_TOKEN_TEST
    : process.env.SHOPIFY_ADMIN_TOKEN;

  if (!domain || !token) {
    throw new Error(
      `Missing ${
        isTest ? "SHOPIFY_STORE_DOMAIN_TEST/SHOPIFY_ADMIN_TOKEN_TEST" : "SHOPIFY_STORE_DOMAIN/SHOPIFY_ADMIN_TOKEN"
      } environment variables.`
    );
  }
  return { domain, token };
}

async function shopifyFetch(
  query: string,
  variables: any,
  isTest: boolean = false
) {
  const { domain, token } = getShopifyEnv(isTest);
  const SHOPIFY_GRAPHQL_URL = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(SHOPIFY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
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
    // Inspect for THROTTLED so callShopify can decide to retry vs re-throw.
    throw new ApiError(
      400,
      "Shopify GraphQL Error: " + JSON.stringify(json.errors)
    );
  }
  return json;
}

const MAX_ATTEMPTS = 5;

function isThrottledGraphQLError(error: any): boolean {
  // Detect THROTTLED extension code by string-matching the serialized errors payload.
  const msg = error?.message ?? "";
  return (
    typeof msg === "string" &&
    msg.includes("Shopify GraphQL Error") &&
    msg.includes("THROTTLED")
  );
}

function isRetryableError(error: any): boolean {
  // Network error from fetch shows up as a TypeError (no statusCode).
  if (error instanceof TypeError) return true;
  if (error instanceof ApiError) {
    const code = error.statusCode;
    if (code === 429) return true;
    if (code >= 500 && code <= 599) return true;
    if (isThrottledGraphQLError(error)) return true;
    return false;
  }
  // Unknown error shape — be conservative, don't retry.
  return false;
}

export async function callShopify(
  query: string,
  variables = {},
  isTest: boolean = false
) {
  let lastError: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await shopifyFetch(query, variables, isTest);

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
      lastError = error;
      if (!isRetryableError(error)) {
        // Permanent error — re-throw immediately, no sleep.
        throw error;
      }
      console.error(
        `callShopify attempt ${attempt}/${MAX_ATTEMPTS} failed (retryable): ${error.message}`
      );
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * attempt;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(
    `Shopify retries exhausted after ${MAX_ATTEMPTS} attempts: ${
      lastError?.message ?? "unknown error"
    }`
  );
}

export async function assertNoActiveBulkOperation(
  mode: "stock" | "prices" | "costs"
): Promise<void> {
  const query = `
    query {
      currentBulkOperation {
        id
        status
      }
    }
  `;
  const data = await callShopify(query, {});
  const op = data?.data?.currentBulkOperation;
  if (!op) return;
  const status = op.status;
  if (status === "RUNNING" || status === "CREATED") {
    throw new Error(
      JSON.stringify({
        error: "prior_bulk_op_active",
        mode,
        op_id: op.id,
        status,
      })
    );
  }
}

export async function pollBulkOperation(
  opId: string,
  mode: "stock" | "prices" | "costs"
): Promise<{ status: string; partialDataUrl: string | null }> {
  const POLL_INTERVAL_MS = 5000;
  // 50 attempts × 5s = 250s, leaving 50s headroom under route maxDuration=300s
  // for surrounding work (snapshot fetch, JSONL upload, second mode in a combined run).
  const MAX_POLL_ATTEMPTS = 50;
  const startedAt = Date.now();

  const pollQuery = `
    query {
      currentBulkOperation {
        id
        status
        partialDataUrl
        errorCode
      }
    }
  `;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    // Query first, sleep at end of iteration — terminal status is detected
    // without an extra POLL_INTERVAL_MS tax when the op has already finished.
    const data = await callShopify(pollQuery, {});
    const op = data?.data?.currentBulkOperation;
    const status: string = op?.status ?? "UNKNOWN";
    const partialDataUrl: string | null = op?.partialDataUrl ?? null;
    const errorCode: string | null = op?.errorCode ?? null;

    if (status === "COMPLETED") {
      const durationMs = Date.now() - startedAt;
      console.log(
        JSON.stringify({
          event: "bulk_op_completed",
          id: opId,
          mode,
          durationMs,
          partialDataUrl,
        })
      );
      if (partialDataUrl) {
        try {
          const head = await fetch(partialDataUrl, { method: "HEAD" });
          const lengthHeader = head.headers.get("content-length");
          const contentLength = lengthHeader ? parseInt(lengthHeader, 10) : null;
          if (contentLength !== null && contentLength > 10 * 1024 * 1024) {
            console.warn(
              "partialDataUrl response too large to count, skipping"
            );
          } else {
            const resp = await fetch(partialDataUrl);
            const text = await resp.text();
            const lineCount = text.split("\n").filter((l) => l.length > 0).length;
            console.log(
              JSON.stringify({
                event: "bulk_op_partial_errors",
                mode,
                lineCount,
              })
            );
          }
        } catch (err: any) {
          console.warn(
            `Failed to fetch partialDataUrl for mode=${mode}: ${err?.message ?? err}`
          );
        }
      }
      return { status, partialDataUrl };
    }

    if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
      throw new Error(
        `Bulk op ${opId} ended with ${status}, code=${errorCode ?? "null"}`
      );
    }

    if (attempt < MAX_POLL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.error(
    JSON.stringify({ event: "bulk_op_timeout", mode, opId })
  );
  await sendBulkOpTimeoutAlert({ mode, opId });
  throw new Error(
    `Bulk op ${opId} (${mode}) did not reach a terminal status within polling budget`
  );
}


export type ShopifyBulkOperationStatus = {
  id: string;
  status: string;
  errorCode: string | null;
  type: "MUTATION" | "QUERY" | string | null;
  url: string | null;
  partialDataUrl: string | null;
};

export async function getBulkOperationById(
  id: string
): Promise<ShopifyBulkOperationStatus | null> {
  const query = `
    query bulkOperationStatus($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          status
          errorCode
          type
          url
          partialDataUrl
        }
      }
    }
  `;
  const data = await callShopify(query, { id });
  const op = data?.data?.node;
  if (!op) return null;
  return {
    id: op.id,
    status: op.status,
    errorCode: op.errorCode ?? null,
    type: op.type ?? null,
    url: op.url ?? null,
    partialDataUrl: op.partialDataUrl ?? null,
  };
}

export async function fetchAllShopifyVariants() {
  const variants = new Map<
    string,
    { inventoryItemId: string; cost: string | null }
  >();
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
          cost: edge.node.inventoryItem.unitCost?.amount ?? null,
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
  handle: string;
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
              handle
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
        handle: edge.node.handle,
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
