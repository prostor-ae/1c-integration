import { ApiError } from "next/dist/server/api-utils";
import { sendBulkOpTimeoutAlert } from "./alerts";
import { SHOPIFY_API_VERSION } from "./config";
import {
  getShopifyCredentials,
  getShopifyCredentialsForStoreId,
  getShopifyLogContext,
  normalizeShopifyDomain,
} from "./shopify-env";
import { parseShopifyWeightMetafieldKg } from "./product-weight";
import { logSyncEvent } from "./sync-logging";
import type { SyncMode } from "./sync-types";

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

type ShopifyCallOptions = {
  signal?: AbortSignal;
  credentials?: { domain: string; token: string };
  logContext?: Record<string, unknown>;
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
  signal?: AbortSignal,
  credentials?: { domain: string; token: string },
) {
  const { domain, token } = credentials ?? getShopifyEnv(isTest);
  const SHOPIFY_GRAPHQL_URL = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(SHOPIFY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    signal,
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
  if (isAbortError(error)) return false;
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

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { name?: string }).name === "AbortError" ||
        (error as { name?: string }).name === "TimeoutError" ||
        (error as { code?: string }).code === "ABORT_ERR"),
  );
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function callShopify(
  query: string,
  variables = {},
  isTest: boolean = false,
  options: ShopifyCallOptions = {},
) {
  let lastError: any = null;
  const operationName = getGraphQLOperationName(query);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await shopifyFetch(
        query,
        variables,
        isTest,
        options.signal,
        options.credentials,
      );

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
          ...(options.logContext ?? getShopifyLogContext(isTest)),
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
          ...(options.logContext ?? getShopifyLogContext(isTest)),
          error: describeShopifyError(error),
        }),
      );
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * attempt;
        await sleepWithSignal(backoffMs, options.signal);
      }
    }
  }
  throw new Error(
    `Shopify retries exhausted after ${MAX_ATTEMPTS} attempts: ${formatShopifyErrorForMessage(lastError)}`,
  );
}

async function callShopifyForStoreId(
  storeId: string,
  query: string,
  variables = {},
  signal?: AbortSignal,
) {
  const { domain, token, isTest } = getShopifyCredentialsForStoreId(storeId);
  return await callShopify(query, variables, isTest, {
    signal,
    credentials: { domain, token },
    logContext: {
      shopifyApiVersion: API_VERSION,
      shopifyTarget: isTest ? "test" : "production",
      shopifyDomain: domain,
      shopifyDomainValid: true,
      shopifyCredentialsConfigured: true,
      shopifyTargetSource: "sync_store_alias",
    },
  });
}

export async function assertNoActiveBulkOperation(
  mode: "stock" | "prices" | "costs",
  signal?: AbortSignal,
): Promise<void> {
  const query = `
    query {
      currentBulkOperation(type: MUTATION) {
        id
        status
      }
    }
  `;
  const data = await callShopify(query, {}, false, { signal });
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

export async function getCurrentBulkOperation(
  signal?: AbortSignal,
  storeId?: string,
): Promise<{ id: string; status: string } | null> {
  const query = `query currentBulkOperation { currentBulkOperation(type: MUTATION) { id status } }`;
  const data = storeId
    ? await callShopifyForStoreId(storeId, query, {}, signal)
    : await callShopify(query, {}, false, { signal });
  const operation = data?.data?.currentBulkOperation;
  if (!operation?.id || !operation?.status) return null;
  return { id: operation.id, status: operation.status };
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
  signal?: AbortSignal,
  storeId?: string,
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
  const data = storeId
    ? await callShopifyForStoreId(storeId, query, { id }, signal)
    : await callShopify(query, { id }, false, { signal });
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

export type CostUpdateBulkMutationInput = {
  inventoryItemId: string;
  cost: number;
};

export const COST_UPDATE_BULK_MUTATION = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        unitCost {
          amount
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export function buildCostUpdateBulkMutationJsonl(
  updates: CostUpdateBulkMutationInput[],
  maxBytes = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const update of updates) {
    const line = JSON.stringify({
      id: update.inventoryItemId,
      input: {
        cost: update.cost,
      },
    });
    bytes += Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
    if (bytes > maxBytes) {
      throw new Error(`sync bulk manifest exceeds ${maxBytes} byte limit`);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export async function runCostUpdateBulkMutation(
  updates: CostUpdateBulkMutationInput[],
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
  const jsonl = buildCostUpdateBulkMutationJsonl(updates);

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
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "costs",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
      },
      "error",
    );
    throw new Error(
      `Failed to upload cost mutation manifest (HTTP ${uploadResponse.status})`,
    );
  }
  console.log("Successfully uploaded JSONL file for bulk mutation.");
  logSyncEvent("shopify_bulk_mutation_jsonl_uploaded", {
    mode: "costs",
    updateCount: updates.length,
    jsonlLineCount: updates.length,
    filename: "bulk-update-costs.jsonl",
  });

  // 3. Run the bulk mutation
  const bulkMutationQuery = COST_UPDATE_BULK_MUTATION;

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
  excludeFrom1cStatusSync: boolean;
  variants: {
    id: string;
    barcode: string;
    sku?: string | null;
    price: string;
    compareAtPrice: string | null;
  }[];
};

type ShopifyMetafieldValue = {
  type?: unknown;
  value?: unknown;
} | null | undefined;

export function parseExcludeFrom1cStatusSyncMetafield(
  metafield: ShopifyMetafieldValue,
): boolean {
  return metafield?.type === "boolean" && metafield.value === "true";
}

export type ShopifyProductPage = {
  products: ShopifyProductInfo[];
  endCursor: string | null;
  hasNextPage: boolean;
  truncatedProductIds: string[];
};

export class ShopifyProductVariantsTruncatedError extends Error {
  readonly code = "shopify_product_variants_truncated";
  readonly productIds: string[];

  constructor(
    productIds: string[],
    samples: Array<{ id: string; handle: string }> = [],
  ) {
    const bounded = productIds.slice(0, 25);
    const detail = samples.length > 0
      ? samples
          .slice(0, 25)
          .map(({ id, handle }) => `${handle} (${id})`)
          .join(", ")
      : bounded.join(", ");
    super(`${"shopify_product_variants_truncated"}: ${detail}`);
    this.name = "ShopifyProductVariantsTruncatedError";
    this.productIds = bounded;
  }
}

function mapShopifyProductNode(node: any): ShopifyProductInfo {
  return {
    id: node.id,
    handle: node.handle,
    status: node.status,
    weightKg: parseShopifyWeightMetafieldKg(node.weightMetafield),
    excludeFrom1cStatusSync: parseExcludeFrom1cStatusSyncMetafield(
      node.excludeFrom1cStatusSyncMetafield,
    ),
    variants: node.variants.edges.map((vEdge: any) => ({
      ...vEdge.node,
      barcode: vEdge.node.barcode ?? "",
      sku: vEdge.node.sku ?? null,
    })),
  };
}

export async function fetchShopifyProductPage(
  after: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<ShopifyProductPage> {
  const query = `
    query products($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            handle
            status
            weightMetafield: metafield(namespace: "custom", key: "weight") {
              value
            }
            excludeFrom1cStatusSyncMetafield: metafield(
              namespace: "custom"
              key: "exclude_from_1c_status_sync"
            ) {
              type
              value
            }
            variants(first: 100) {
              pageInfo { hasNextPage }
              edges {
                node { id barcode sku price compareAtPrice }
              }
            }
          }
        }
      }
    }
  `;
  const data = await callShopify(
    query,
    { cursor: after },
    false,
    { signal: options.signal },
  );
  const connection = data.data.products;
  const truncatedProductIds = connection.edges
    .filter((edge: any) => edge.node.variants?.pageInfo?.hasNextPage === true)
    .map((edge: any) => String(edge.node.id))
    .slice(0, 25);
  return {
    products: connection.edges.map((edge: any) =>
      mapShopifyProductNode(edge.node),
    ),
    endCursor: connection.pageInfo.endCursor ?? null,
    hasNextPage: connection.pageInfo.hasNextPage === true,
    truncatedProductIds,
  };
}

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
  let cursor: string | null = null;
  let hasNextPage = true;

  console.log("Fetching all Shopify products and variants...");

  while (hasNextPage) {
    const page = await fetchShopifyProductPage(cursor);
    if (page.truncatedProductIds.length > 0) {
      throw new ShopifyProductVariantsTruncatedError(page.truncatedProductIds);
    }
    page.products.forEach((product) => products.set(product.id, product));

    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    console.log(`Fetched page of products, total fetched: ${products.size}`);
  }

  console.log(`Finished fetching all products. Total: ${products.size}`);
  return products;
}

export async function fetchShopifyProductsAndVariantsByIdentifiers(
  identifiers: string[],
  signal?: AbortSignal,
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
              excludeFrom1cStatusSyncMetafield: metafield(
                namespace: "custom"
                key: "exclude_from_1c_status_sync"
              ) {
                type
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
      const data = await callShopify(
        query,
        { query: searchQuery, cursor },
        false,
        { signal },
      );
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
          excludeFrom1cStatusSync: parseExcludeFrom1cStatusSyncMetafield(
            productNode.excludeFrom1cStatusSyncMetafield,
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
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "prices",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
      },
      "error",
    );
    throw new Error(
      `Failed to upload price mutation manifest (HTTP ${uploadResponse.status})`,
    );
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
  maxBytes = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const u of updates) {
    const line = JSON.stringify({
        productId: u.productId,
        variants: [
          {
            id: u.variantId,
            price: u.price,
            compareAtPrice: u.compareAtPrice,
          },
        ],
      });
    bytes += Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
    if (bytes > maxBytes) throw new Error(`sync bulk manifest exceeds ${maxBytes} byte limit`);
    lines.push(line);
  }
  return lines.join("\n");
}

export type StatusUpdateBulkMutationInput = {
  productId: string;
  status: "ACTIVE" | "DRAFT";
};

export const STATUS_UPDATE_BULK_MUTATION = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

export function buildStatusUpdateBulkMutationJsonl(
  updates: StatusUpdateBulkMutationInput[],
  maxBytes = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const update of updates) {
    const line = JSON.stringify({
        input: { id: update.productId, status: update.status },
      });
    bytes += Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
    if (bytes > maxBytes) throw new Error(`sync bulk manifest exceeds ${maxBytes} byte limit`);
    lines.push(line);
  }
  return lines.join("\n");
}

export async function createAndUploadBulkMutationManifest({
  mode,
  jsonl,
  stagedUploadAttempt,
  signal,
}: {
  mode: SyncMode;
  jsonl: string;
  stagedUploadAttempt: number;
  signal?: AbortSignal;
}): Promise<{ stagedUploadPath: string }> {
  const filename = `${mode}-updates-${stagedUploadAttempt}.jsonl`;
  const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url parameters { name value } }
        userErrors { field message }
      }
    }
  `;
  const result = await callShopify(
    stagedUploadsQuery,
    {
      input: [{
        resource: "BULK_MUTATION_VARIABLES",
        filename,
        mimeType: "application/jsonl",
        httpMethod: "POST",
      }],
    },
    false,
    { signal },
  );
  const payload = result.data.stagedUploadsCreate;
  if (payload.userErrors?.length) {
    throw new Error(`Failed to create staged upload: ${JSON.stringify(payload.userErrors)}`);
  }
  const target = payload.stagedTargets?.[0];
  if (!target?.url || !Array.isArray(target.parameters)) {
    throw new Error("Shopify staged upload target was missing required fields");
  }
  const key = target.parameters.find(
    (parameter: { name: string; value: string }) => parameter.name === "key",
  )?.value;
  if (!key) throw new Error("Shopify staged upload target was missing key");

  const formData = new FormData();
  target.parameters.forEach(
    (parameter: { name: string; value: string }) =>
      formData.append(parameter.name, parameter.value),
  );
  formData.append("file", new Blob([jsonl], { type: "application/jsonl" }));
  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: formData,
    signal,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload ${mode} manifest: HTTP ${uploadResponse.status}`,
    );
  }
  logSyncEvent("shopify_bulk_manifest_uploaded", {
    mode,
    stagedUploadAttempt,
    byteLength: Buffer.byteLength(jsonl),
  });
  return { stagedUploadPath: key };
}

export async function launchPreparedBulkMutation({
  mode,
  stagedUploadPath,
  clientIdentifier,
  signal,
}: {
  mode: SyncMode;
  stagedUploadPath: string;
  clientIdentifier: string;
  signal?: AbortSignal;
}): Promise<{ id: string; status: string }> {
  const mutation = `
    mutation bulkOperationRunMutation(
      $mutation: String!
      $stagedUploadPath: String!
      $clientIdentifier: String!
    ) {
      bulkOperationRunMutation(
        mutation: $mutation
        stagedUploadPath: $stagedUploadPath
        clientIdentifier: $clientIdentifier
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;
  const result = await callShopify(
    mutation,
    {
      mutation:
        mode === "costs"
          ? COST_UPDATE_BULK_MUTATION
          : mode === "prices"
            ? PRICE_UPDATE_BULK_MUTATION
            : STATUS_UPDATE_BULK_MUTATION,
      stagedUploadPath,
      clientIdentifier,
    },
    false,
    { signal },
  );
  const payload = result.data.bulkOperationRunMutation;
  if (payload.userErrors?.length) {
    throw new Error(`Failed to start ${mode} bulk operation: ${JSON.stringify(payload.userErrors)}`);
  }
  const operation = payload.bulkOperation;
  if (!operation?.id || !operation?.status) {
    throw new Error(`Shopify returned malformed ${mode} bulk operation response`);
  }
  return operation;
}

export async function updateProductStatus(
  productId: string,
  status: "ACTIVE" | "DRAFT",
  signal?: AbortSignal,
) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id, status }
        userErrors { field, message }
      }
    }
  `;
  const result = await callShopify(
    mutation,
    {
      input: {
        id: productId,
        status,
      },
    },
    false,
    { signal },
  );
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
    logSyncEvent(
      "shopify_bulk_mutation_jsonl_upload_failed",
      {
        mode: "stock",
        updateCount: updates.length,
        uploadStatus: uploadResponse.status,
        uploadStatusText: uploadResponse.statusText,
      },
      "error",
    );
    throw new Error(
      `Failed to upload status mutation manifest (HTTP ${uploadResponse.status})`,
    );
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
