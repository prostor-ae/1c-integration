import { ApiError } from "next/dist/server/api-utils";
import { sendBulkOpTimeoutAlert } from "./alerts";
import { SHOPIFY_API_VERSION } from "./config";
import {
  getShopifyCredentials,
  getShopifyLogContext,
  normalizeShopifyDomain,
} from "./shopify-env";
import { parseShopifyWeightMetafieldKg } from "./product-weight";
import { logSyncEvent } from "./sync-logging";

const API_VERSION = SHOPIFY_API_VERSION;

export { getShopifyLogContext, normalizeShopifyDomain };

type ShopifyErrorDetails = {
  name: string;
  message: string;
  causeName?: string;
  causeMessage?: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: string | number;
};

function getShopifyEnv(isTest: boolean): { domain: string; token: string } {
  return getShopifyCredentials(isTest);
}

function getGraphQLOperationName(query: string): string | null {
  const match = query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
  return match?.[2] ?? null;
}

function truncateForLog(value: string, maxLength = 2000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function formatShopifyGraphQLError(json: any): string {
  const errors = Array.isArray(json?.errors)
    ? json.errors.map((error: any) => ({
        message: error?.message,
        path: error?.path,
        code: error?.extensions?.code,
        field: error?.extensions?.field,
      }))
    : json?.errors;
  const cost = json?.extensions?.cost;
  const payload = cost ? { errors, cost } : { errors };
  return `Shopify GraphQL Error: ${truncateForLog(JSON.stringify(payload))}`;
}

export function describeShopifyError(error: any): ShopifyErrorDetails {
  const cause = error?.cause;
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    causeName: cause?.name,
    causeMessage: cause?.message,
    code: cause?.code ?? error?.code,
    errno: cause?.errno ?? error?.errno,
    syscall: cause?.syscall ?? error?.syscall,
    hostname: cause?.hostname ?? error?.hostname,
    address: cause?.address ?? error?.address,
    port: cause?.port ?? error?.port,
  };
}

function formatShopifyErrorForMessage(error: any): string {
  if (!error) {
    return "no retryable error details were captured";
  }
  const details = describeShopifyError(error);
  const parts = [details.message || details.name || String(error)];
  if (details.causeMessage) parts.push(`cause=${details.causeMessage}`);
  if (details.code) parts.push(`code=${details.code}`);
  if (details.hostname) parts.push(`hostname=${details.hostname}`);
  if (details.syscall) parts.push(`syscall=${details.syscall}`);
  return parts.join("; ");
}

async function shopifyFetch(
  query: string,
  variables: any,
  isTest: boolean = false,
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
      `Shopify API Error: ${res.statusText} - ${text}`,
    );
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    // Include sanitized GraphQL cost/throttle details so retry-exhaustion
    // emails explain whether Shopify throttling, schema/userErrors, or another
    // GraphQL failure caused the async Vercel sync continuation to fail.
    throw new ApiError(400, formatShopifyGraphQLError(json));
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
  isTest: boolean = false,
) {
  let lastError: any = null;
  const operationName = getGraphQLOperationName(query);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await shopifyFetch(query, variables, isTest);

      if (!data.extensions || !data.extensions.cost) {
        return data;
      }

      const cost = data.extensions.cost;
      const bucket = cost.throttleStatus;
      const currentAvailable = Number(bucket?.currentlyAvailable);
      const requestedQueryCost = Number(cost?.requestedQueryCost);

      if (
        Number.isFinite(currentAvailable) &&
        Number.isFinite(requestedQueryCost) &&
        currentAvailable < requestedQueryCost
      ) {
        logSyncEvent("shopify_call_low_throttle_budget_after_success", {
          operationName,
          ...getShopifyLogContext(isTest),
          requestedQueryCost,
          actualQueryCost: cost.actualQueryCost ?? null,
          currentlyAvailable: currentAvailable,
          restoreRate: bucket?.restoreRate,
        });
      }

      return data;
    } catch (error: any) {
      lastError = error;
      if (!isRetryableError(error)) {
        // Permanent error — re-throw immediately, no sleep.
        throw error;
      }
      console.error(
        JSON.stringify({
          event: "shopify_call_retry",
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          retryable: true,
          operationName,
          ...getShopifyLogContext(isTest),
          error: describeShopifyError(error),
        }),
      );
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * attempt;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(
    `Shopify retries exhausted after ${MAX_ATTEMPTS} attempts: ${formatShopifyErrorForMessage(lastError)}`,
  );
}

export async function assertNoActiveBulkOperation(
  mode: "stock" | "prices" | "costs",
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
      }),
    );
  }
}

export async function pollBulkOperation(
  opId: string,
  mode: "stock" | "prices" | "costs",
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
        }),
      );
      if (partialDataUrl) {
        try {
          const head = await fetch(partialDataUrl, { method: "HEAD" });
          const lengthHeader = head.headers.get("content-length");
          const contentLength = lengthHeader
            ? parseInt(lengthHeader, 10)
            : null;
          if (contentLength !== null && contentLength > 10 * 1024 * 1024) {
            console.warn(
              "partialDataUrl response too large to count, skipping",
            );
          } else {
            const resp = await fetch(partialDataUrl);
            const text = await resp.text();
            const lineCount = text
              .split("\n")
              .filter((l) => l.length > 0).length;
            console.log(
              JSON.stringify({
                event: "bulk_op_partial_errors",
                mode,
                lineCount,
              }),
            );
          }
        } catch (err: any) {
          console.warn(
            `Failed to fetch partialDataUrl for mode=${mode}: ${err?.message ?? err}`,
          );
        }
      }
      return { status, partialDataUrl };
    }

    if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
      throw new Error(
        `Bulk op ${opId} ended with ${status}, code=${errorCode ?? "null"}`,
      );
    }

    if (attempt < MAX_POLL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.error(JSON.stringify({ event: "bulk_op_timeout", mode, opId }));
  await sendBulkOpTimeoutAlert({ mode, opId });
  throw new Error(
    `Bulk op ${opId} (${mode}) did not reach a terminal status within polling budget`,
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
  id: string,
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
    { inventoryItemId: string; cost: string | null; weightKg: number | null }
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
              product {
                weightMetafield: metafield(namespace: "custom", key: "weight") {
                  value
                }
              }
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
          weightKg: parseShopifyWeightMetafieldKg(
            edge.node.product?.weightMetafield,
          ),
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
  updates: { inventoryItemId: string; cost: number }[],
) {
  console.log(`Preparing bulk mutation for ${updates.length} cost updates.`);
  logSyncEvent("shopify_bulk_mutation_prepare", {
    mode: "costs",
    updateCount: updates.length,
    filename: "bulk-update-costs.jsonl",
  });
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
      }),
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
    stagedUploadsInput,
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
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "costs",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
        error: errorText.slice(0, 1000),
      },
      "error",
    );
    throw new Error(`Failed to upload to staged target: ${errorText}`);
  }
  console.log("Successfully uploaded JSONL file for bulk mutation.");
  logSyncEvent("shopify_bulk_mutation_jsonl_uploaded", {
    mode: "costs",
    updateCount: updates.length,
    jsonlLineCount: updates.length,
    filename: "bulk-update-costs.jsonl",
  });

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

  const userErrors =
    bulkOperationResult.data.bulkOperationRunMutation.userErrors;
  if (userErrors.length > 0) {
    logSyncEvent(
      "shopify_bulk_mutation_start_failed",
      {
        mode: "costs",
        updateCount: updates.length,
        userErrors,
      },
      "error",
    );
    throw new Error(
      `Failed to start bulk operation: ${JSON.stringify(userErrors)}`,
    );
  }

  console.log("Bulk mutation started successfully.");
  const bulkOperation =
    bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
  logSyncEvent("shopify_bulk_mutation_started", {
    mode: "costs",
    updateCount: updates.length,
    opId: bulkOperation?.id,
    opStatus: bulkOperation?.status,
  });
  return bulkOperation;
}

export type ShopifyProductInfo = {
  id: string;
  handle: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  weightKg: number | null;
  variants: {
    id: string;
    barcode: string;
    sku?: string | null;
    price: string;
    compareAtPrice: string | null;
  }[];
};

function uniqueNonEmptyValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values.map((value) => value.trim()).filter((value) => value !== ""),
    ),
  );
}

function formatShopifySearchValue(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildVariantIdentifierSearchQuery(
  identifiers: string[],
): string {
  return uniqueNonEmptyValues(identifiers)
    .flatMap((identifier) => {
      const value = formatShopifySearchValue(identifier);
      return [`barcode:${value}`, `sku:${value}`];
    })
    .join(" OR ");
}

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
              weightMetafield: metafield(namespace: "custom", key: "weight") {
                value
              }
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
        weightKg: parseShopifyWeightMetafieldKg(edge.node.weightMetafield),
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

export async function fetchShopifyProductsAndVariantsByIdentifiers(
  identifiers: string[],
): Promise<Map<string, ShopifyProductInfo>> {
  const uniqueIdentifiers = uniqueNonEmptyValues(identifiers);
  const products = new Map<string, ShopifyProductInfo>();
  if (uniqueIdentifiers.length === 0) return products;

  logSyncEvent("shopify_variant_identifier_lookup_started", {
    identifierCount: uniqueIdentifiers.length,
  });

  const query = `
    query productVariantsByIdentifier($query: String!, $cursor: String) {
      productVariants(first: 100, after: $cursor, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            barcode
            sku
            price
            compareAtPrice
            product {
              id
              handle
              status
              weightMetafield: metafield(namespace: "custom", key: "weight") {
                value
              }
            }
          }
        }
      }
    }
  `;

  const chunkSize = 25;
  let matchedVariants = 0;
  for (let i = 0; i < uniqueIdentifiers.length; i += chunkSize) {
    const chunk = uniqueIdentifiers.slice(i, i + chunkSize);
    const searchQuery = buildVariantIdentifierSearchQuery(chunk);
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await callShopify(query, { query: searchQuery, cursor });
      const connection = data.data.productVariants;

      connection.edges.forEach((edge: any) => {
        const node = edge.node;
        const productNode = node.product;
        if (!productNode?.id) return;

        const product: ShopifyProductInfo = products.get(productNode.id) ?? {
          id: productNode.id,
          handle: productNode.handle,
          status: productNode.status,
          weightKg: parseShopifyWeightMetafieldKg(
            productNode.weightMetafield,
          ),
          variants: [],
        };

        if (!product.variants.some((variant) => variant.id === node.id)) {
          product.variants.push({
            id: node.id,
            barcode: node.barcode ?? "",
            sku: node.sku ?? null,
            price: node.price,
            compareAtPrice: node.compareAtPrice,
          });
          matchedVariants += 1;
        }

        products.set(product.id, product);
      });

      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor;
    }
  }

  logSyncEvent("shopify_variant_identifier_lookup_completed", {
    identifierCount: uniqueIdentifiers.length,
    matchedProductCount: products.size,
    matchedVariantCount: matchedVariants,
  });

  return products;
}

export async function runPriceUpdateBulkMutation(
  updates: PriceUpdateBulkMutationInput[],
) {
  console.log(`Preparing bulk mutation for ${updates.length} price updates.`);
  logSyncEvent("shopify_bulk_mutation_prepare", {
    mode: "prices",
    updateCount: updates.length,
    filename: "price-updates.jsonl",
  });
  const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url, parameters { name, value } }
        userErrors { field, message }
      }
    }
  `;
  const jsonl = buildPriceUpdateBulkMutationJsonl(updates);

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
    stagedUploadsInput,
  );
  const target = stagedUploadsResult.data.stagedUploadsCreate.stagedTargets[0];
  const { url, parameters } = target;
  const formData = new FormData();
  parameters.forEach(({ name, value }: any) => formData.append(name, value));
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));
  const uploadResponse = await fetch(url, { method: "POST", body: formData });
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "prices",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
        error: errorText.slice(0, 1000),
      },
      "error",
    );
    throw new Error(`Failed to upload to staged target: ${errorText}`);
  }
  console.log("Successfully uploaded JSONL for price update bulk mutation.");
  logSyncEvent("shopify_bulk_mutation_jsonl_uploaded", {
    mode: "prices",
    updateCount: updates.length,
    jsonlLineCount: updates.length,
    filename: "price-updates.jsonl",
  });

  // Step 3: Run the bulk mutation
  const bulkMutationQuery = PRICE_UPDATE_BULK_MUTATION;
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
  const userErrors =
    bulkOperationResult.data.bulkOperationRunMutation.userErrors;
  if (userErrors.length > 0) {
    logSyncEvent(
      "shopify_bulk_mutation_start_failed",
      {
        mode: "prices",
        updateCount: updates.length,
        userErrors,
      },
      "error",
    );
    throw new Error(
      `Failed to start price bulk operation: ${JSON.stringify(userErrors)}`,
    );
  }

  console.log("Price update bulk mutation started successfully.");
  const bulkOperation =
    bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
  logSyncEvent("shopify_bulk_mutation_started", {
    mode: "prices",
    updateCount: updates.length,
    opId: bulkOperation?.id,
    opStatus: bulkOperation?.status,
  });
  return bulkOperation;
}

export type PriceUpdateBulkMutationInput = {
  productId: string;
  variantId: string;
  price: string;
  compareAtPrice: string | null;
};

export const PRICE_UPDATE_BULK_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id }
      productVariants { id price compareAtPrice }
      userErrors { field, message }
    }
  }
`;

export function buildPriceUpdateBulkMutationJsonl(
  updates: PriceUpdateBulkMutationInput[],
): string {
  return updates
    .map((u) =>
      JSON.stringify({
        productId: u.productId,
        variants: [
          {
            id: u.variantId,
            price: u.price,
            compareAtPrice: u.compareAtPrice,
          },
        ],
      }),
    )
    .join("\n");
}

export async function updateProductStatus(
  productId: string,
  status: "ACTIVE" | "DRAFT",
) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id, status }
        userErrors { field, message }
      }
    }
  `;
  const result = await callShopify(mutation, {
    input: {
      id: productId,
      status,
    },
  });
  const userErrors = result.data.productUpdate.userErrors;
  if (userErrors.length > 0) {
    throw new Error(
      `Failed to update product status: ${JSON.stringify(userErrors)}`,
    );
  }
  return result.data.productUpdate.product as {
    id: string;
    status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  };
}

export async function runStatusUpdateBulkMutation(
  updates: { productId: string; status: "ACTIVE" | "DRAFT" }[],
) {
  console.log(`Preparing bulk mutation for ${updates.length} status updates.`);
  logSyncEvent("shopify_bulk_mutation_prepare", {
    mode: "stock",
    updateCount: updates.length,
    filename: "status-updates.jsonl",
  });
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
      }),
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
    stagedUploadsInput,
  );
  const target = stagedUploadsResult.data.stagedUploadsCreate.stagedTargets[0];
  const { url, parameters } = target;
  const formData = new FormData();
  parameters.forEach(({ name, value }: any) => formData.append(name, value));
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));
  const uploadResponse = await fetch(url, { method: "POST", body: formData });
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "stock",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
        error: errorText.slice(0, 1000),
      },
      "error",
    );
    throw new Error(`Failed to upload to staged target: ${errorText}`);
  }
  console.log("Successfully uploaded JSONL for status update bulk mutation.");
  logSyncEvent("shopify_bulk_mutation_jsonl_uploaded", {
    mode: "stock",
    updateCount: updates.length,
    jsonlLineCount: updates.length,
    filename: "status-updates.jsonl",
  });

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
  const userErrors =
    bulkOperationResult.data.bulkOperationRunMutation.userErrors;
  if (userErrors.length > 0) {
    logSyncEvent(
      "shopify_bulk_mutation_start_failed",
      {
        mode: "stock",
        updateCount: updates.length,
        userErrors,
      },
      "error",
    );
    throw new Error(
      `Failed to start status bulk operation: ${JSON.stringify(userErrors)}`,
    );
  }

  console.log("Status update bulk mutation started successfully.");
  const bulkOperation =
    bulkOperationResult.data.bulkOperationRunMutation.bulkOperation;
  logSyncEvent("shopify_bulk_mutation_started", {
    mode: "stock",
    updateCount: updates.length,
    opId: bulkOperation?.id,
    opStatus: bulkOperation?.status,
  });
  return bulkOperation;
}
