import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as oneCWebhookPost } from "../src/app/api/webhooks/1c/route";
import {
  parseOneCWebhookItems,
  processOneCWebhookItems,
} from "../src/app/lib/1c-webhook";
import type { MissingBarcodeAlertArgs } from "../src/app/lib/alerts";
import type { ShopifyProductInfo } from "../src/app/lib/shopify-client";
import {
  ONE_C_STATUS_MUTATION_DEADLINE_MS,
  setOneCWebhookRouteDepsForTests,
} from "../src/app/lib/1c-webhook-route-deps";
import {
  __resetMemorySyncStateForTests,
  saveBulkQuarantine,
} from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.ONE_C_WEBHOOK_KEY;
  Object.assign(process.env, { NODE_ENV: "test" });
  __resetMemorySyncStateForTests();
  setOneCWebhookRouteDepsForTests(null);
});

function product(
  id: string,
  status: ShopifyProductInfo["status"],
  barcode: string,
  sku?: string,
  excludeFrom1cStatusSync = false,
  price = "1.00",
): ShopifyProductInfo {
  return {
    id,
    handle: id.toLowerCase(),
    status,
    weightKg: 1,
    excludeFrom1cStatusSync,
    variants: [
      {
        id: `${id}-variant`,
        barcode,
        sku,
        price,
        compareAtPrice: null,
      },
    ],
  };
}

test("protected webhook matches remain known without status updates", async () => {
  const protectedProduct = product(
    "gid://shopify/Product/protected",
    "ACTIVE",
    "KNOWN-BARCODE",
    "KNOWN-SKU",
    true,
  );
  const updates: string[] = [];
  const result = await processOneCWebhookItems(
    { "KNOWN-BARCODE": "No", "KNOWN-SKU": "No", UNKNOWN: "Yes" },
    {
      fetchProductsByIdentifiers: async () =>
        new Map([[protectedProduct.id, protectedProduct]]),
      updateProductStatus: async (productId, status) => {
        updates.push(productId);
        return { id: productId, status };
      },
    },
  );

  assert.deepEqual(updates, []);
  assert.deepEqual(result.unknownBarcodes, ["UNKNOWN"]);
  assert.equal(result.matched, 2);
  assert.equal(result.protectedProductsSkipped, 1);
  assert.equal(result.proposed, 0);
  assert.equal(result.applied, 0);
});

test("duplicate identifier remains known and only eligible product updates", async () => {
  const protectedProduct = product("protected", "ACTIVE", "DUP", undefined, true);
  const eligibleProduct = product("eligible", "ACTIVE", "DUP");
  const updates: string[] = [];
  const result = await processOneCWebhookItems(
    { DUP: "No" },
    {
      fetchProductsByIdentifiers: async () =>
        new Map([
          [protectedProduct.id, protectedProduct],
          [eligibleProduct.id, eligibleProduct],
        ]),
      updateProductStatus: async (productId, status) => {
        updates.push(productId);
        return { id: productId, status };
      },
    },
  );

  assert.deepEqual(updates, ["eligible"]);
  assert.equal(result.matched, 1);
  assert.equal(result.unknown, 0);
  assert.equal(result.protectedProductsSkipped, 1);
});

test("webhook does not activate a zero-priced draft but still allows deactivation", async () => {
  const zeroPricedDraft = product(
    "zero-priced-draft",
    "DRAFT",
    "ACTIVATE",
    undefined,
    false,
    "0.00",
  );
  const zeroPricedActive = product(
    "zero-priced-active",
    "ACTIVE",
    "DEACTIVATE",
    undefined,
    false,
    "0.00",
  );
  const capturedUpdates: Array<{
    productId: string;
    status: "ACTIVE" | "DRAFT";
  }> = [];

  const result = await processOneCWebhookItems(
    { ACTIVATE: "Yes", DEACTIVATE: "No" },
    {
      fetchProductsByIdentifiers: async () =>
        new Map([
          [zeroPricedDraft.id, zeroPricedDraft],
          [zeroPricedActive.id, zeroPricedActive],
        ]),
      updateProductStatus: async (productId, status) => {
        capturedUpdates.push({ productId, status });
        return { id: productId, status };
      },
    },
  );

  assert.deepEqual(capturedUpdates, [
    { productId: "zero-priced-active", status: "DRAFT" },
  ]);
  assert.equal(result.unchanged, 1);
  assert.equal(result.proposed, 1);
  assert.equal(result.applied, 1);
});

function webhookRequest(headers: HeadersInit, body: string) {
  return new Request("https://example.test/api/webhooks/1c", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("1C webhook rejects requests when webhook key is not configured", async () => {
  const response = await oneCWebhookPost(
    webhookRequest(
      { "x-api-key": "secret" },
      JSON.stringify({ Items: { "481": "Yes" } }),
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, "one_c_webhook_key_not_configured");
});

test("1C webhook rejects missing or wrong x-api-key", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";

  const missing = await oneCWebhookPost(
    webhookRequest({}, JSON.stringify({ Items: { "481": "Yes" } })),
  );
  assert.equal(missing.status, 401);

  const wrong = await oneCWebhookPost(
    webhookRequest(
      { "x-api-key": "wrong" },
      JSON.stringify({ Items: { "481": "Yes" } }),
    ),
  );
  assert.equal(wrong.status, 401);
});

test("1C webhook rejects invalid JSON before Shopify processing", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: any) => {
    logs.push(String(message));
  };

  try {
    const response = await oneCWebhookPost(
      webhookRequest({ "x-api-key": "secret" }, "not-json"),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "invalid_json");
    assert.ok(
      logs.some((line) => {
        const parsed = JSON.parse(line);
        return (
          parsed.event === "1c_webhook_request_body" &&
          parsed.bodyLength === 8 &&
          parsed.body === "not-json"
        );
      }),
    );
  } finally {
    console.log = originalLog;
  }
});

test("1C webhook logs the authenticated request body with its barcodes", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  setOneCWebhookRouteDepsForTests({ acquireLock: async () => null });
  const rawBody = JSON.stringify({
    Items: { "4607065580261": "Yes", "4760062100297": "No" },
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: any) => {
    logs.push(String(message));
  };

  try {
    const response = await oneCWebhookPost(
      webhookRequest({ "x-api-key": "secret" }, rawBody),
    );

    assert.equal(response.status, 503);
    assert.ok(
      logs.some((line) => {
        const parsed = JSON.parse(line);
        return (
          parsed.event === "1c_webhook_request_body" &&
          parsed.bodyLength === rawBody.length &&
          parsed.body === rawBody
        );
      }),
    );
  } finally {
    console.log = originalLog;
  }
});

test("1C webhook returns retryable 503 while an ambiguous launch is quarantined", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  await saveBulkQuarantine({
    schemaVersion: 1,
    storeId: "default-shop",
    runId: "run-ambiguous",
    mode: "stock",
    quarantineToken: "token-1234567890",
    manifestHash: "a".repeat(64),
    clientIdentifier: "sync-client",
    knownOperationId: null,
    status: "ambiguous_launch",
    reason: "response lost",
    launchRequestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [],
  });
  const response = await oneCWebhookPost(
    webhookRequest({ "x-api-key": "secret" }, JSON.stringify({ Items: { B1: "No" } })),
  );
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(body.error, "ambiguous_bulk_quarantine");
});

test("1C webhook holds the sync lock and a fence injected after reads causes zero writes", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  let released = false;
  let blockerReads = 0;
  let writes = 0;
  setOneCWebhookRouteDepsForTests({
    acquireLock: async () => "race-token",
    releaseLock: async (token) => {
      assert.equal(token, "race-token");
      released = true;
    },
    getAdmissionBlocker: async () => {
      blockerReads += 1;
      const launchFence = blockerReads === 1
        ? null
        : {
            schemaVersion: 1 as const,
            storeId: "default-shop",
            runId: "racing-run",
            mode: "stock" as const,
            manifestHash: "a".repeat(64),
            clientIdentifier: "sync-race",
            knownOperationId: null,
            createdAt: new Date().toISOString(),
          };
      return launchFence
        ? { storeId: launchFence.storeId, quarantine: null, launchFence }
        : null;
    },
    processItems: async (_items, overrides) => {
      // Simulate the Shopify read/diff phase before the route-provided mutation boundary.
      await overrides?.beforeMutations?.();
      writes += 1;
      throw new Error("unreachable");
    },
  });
  const response = await oneCWebhookPost(
    webhookRequest({ "x-api-key": "secret" }, JSON.stringify({ Items: { B1: "No" } })),
  );
  assert.equal(response.status, 503);
  assert.equal(writes, 0);
  assert.equal(released, true);
});

test("1C webhook returns retryable 503 when the shared sync lock is busy", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  setOneCWebhookRouteDepsForTests({ acquireLock: async () => null });
  const response = await oneCWebhookPost(
    webhookRequest({ "x-api-key": "secret" }, JSON.stringify({ Items: { B1: "Yes" } })),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "sync_lock_busy");
});

test("1C webhook aborts mutation work inside the lock lease margin and releases its token", async () => {
  process.env.ONE_C_WEBHOOK_KEY = "secret";
  assert.ok(ONE_C_STATUS_MUTATION_DEADLINE_MS <= 240_000);
  assert.ok(ONE_C_STATUS_MUTATION_DEADLINE_MS < 300_000);
  const controller = new AbortController();
  controller.abort(new DOMException("deadline", "TimeoutError"));
  let mutations = 0;
  let releasedToken: string | null = null;
  setOneCWebhookRouteDepsForTests({
    acquireLock: async () => "deadline-owner",
    releaseLock: async (token) => { releasedToken = token; },
    getAdmissionBlocker: async () => null,
    createMutationSignal: () => controller.signal,
    processItems: async (_items, overrides) => {
      overrides?.signal?.throwIfAborted();
      mutations += 1;
      throw new Error("unreachable");
    },
  });
  const response = await oneCWebhookPost(
    webhookRequest({ "x-api-key": "secret" }, JSON.stringify({ Items: { B1: "Yes" } })),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "status_mutation_deadline_exceeded");
  assert.equal(mutations, 0);
  assert.equal(releasedToken, "deadline-owner");
});

test("parseOneCWebhookItems requires a non-empty Items object with exact Yes/No values", () => {
  assert.throws(
    () => parseOneCWebhookItems({}),
    /items_must_be_non_empty_object/,
  );
  assert.throws(
    () => parseOneCWebhookItems({ Items: {} }),
    /items_must_be_non_empty_object/,
  );
  assert.throws(
    () => parseOneCWebhookItems({ Items: { "481": "yes" } }),
    /item_values_must_be_yes_or_no/,
  );
  assert.throws(
    () => parseOneCWebhookItems({ Items: { "": "Yes" } }),
    /barcode_must_be_non_empty/,
  );

  assert.deepEqual(
    parseOneCWebhookItems({ Items: { "481": "Yes", "482": "No" } }),
    {
      "481": "Yes",
      "482": "No",
    },
  );
});

test("processOneCWebhookItems maps barcode Yes/No to direct product ACTIVE/DRAFT updates", async () => {
  const products = new Map<string, ShopifyProductInfo>([
    [
      "gid://shopify/Product/1",
      product("gid://shopify/Product/1", "DRAFT", "481"),
    ],
    [
      "gid://shopify/Product/2",
      product("gid://shopify/Product/2", "ACTIVE", "482"),
    ],
    [
      "gid://shopify/Product/3",
      product("gid://shopify/Product/3", "DRAFT", "483"),
    ],
    [
      "gid://shopify/Product/4",
      product("gid://shopify/Product/4", "ACTIVE", "absent"),
    ],
  ]);
  const capturedUpdates: Array<{
    productId: string;
    status: "ACTIVE" | "DRAFT";
  }> = [];
  const capturedAlerts: MissingBarcodeAlertArgs[] = [];
  let requestedIdentifiers: string[] = [];

  const result = await processOneCWebhookItems(
    { "481": "Yes", "482": "No", "483": "No", unknown: "Yes" },
    {
      fetchProductsByIdentifiers: async (identifiers) => {
        requestedIdentifiers = identifiers;
        return products;
      },
      updateProductStatus: async (productId, status) => {
        capturedUpdates.push({ productId, status });
        return { id: productId, status };
      },
      sendMissingBarcodeAlert: async (args) => {
        capturedAlerts.push(args);
      },
    },
  );

  assert.deepEqual(requestedIdentifiers, ["481", "482", "483", "unknown"]);
  assert.deepEqual(capturedUpdates, [
    { productId: "gid://shopify/Product/1", status: "ACTIVE" },
    { productId: "gid://shopify/Product/2", status: "DRAFT" },
  ]);
  assert.equal(result.received, 4);
  assert.equal(result.matched, 3);
  assert.equal(result.unknown, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.proposed, 2);
  assert.deepEqual(result.unknownBarcodes, ["unknown"]);
  assert.equal(result.applied, 2);
  assert.equal(capturedAlerts.length, 1);
  assert.deepEqual(capturedAlerts[0], {
    received: 4,
    matched: 3,
    unknown: 1,
    unchanged: 1,
    proposed: 2,
    applied: 2,
    unknownBarcodes: ["unknown"],
  });
  assert.deepEqual(result.updatedProducts, [
    { id: "gid://shopify/Product/1", status: "ACTIVE" },
    { id: "gid://shopify/Product/2", status: "DRAFT" },
  ]);
});

test("processOneCWebhookItems does not run a Shopify mutation when all matches are no-ops or unknown", async () => {
  const products = new Map<string, ShopifyProductInfo>([
    [
      "gid://shopify/Product/1",
      product("gid://shopify/Product/1", "ACTIVE", "481"),
    ],
  ]);
  let mutationCalled = false;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };

  try {
    const result = await processOneCWebhookItems(
      { "481": "Yes", unknown: "No" },
      {
        fetchProductsByIdentifiers: async () => products,
        updateProductStatus: async () => {
          mutationCalled = true;
          return { id: "should-not-run", status: "ACTIVE" };
        },
        sendMissingBarcodeAlert: async () => {
          throw new Error("resend unavailable");
        },
      },
    );

    assert.equal(mutationCalled, false);
    assert.equal(result.proposed, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(result.unknown, 1);
    assert.equal(result.applied, 0);
    assert.deepEqual(result.updatedProducts, []);
    assert.equal(errors.length, 1);
    const logged = JSON.parse(errors[0]);
    assert.equal(logged.event, "missing_barcode_alert_failed");
    assert.match(logged.error, /resend unavailable/);
  } finally {
    console.error = originalError;
  }
});

test("processOneCWebhookItems also matches payload keys against SKU", async () => {
  const products = new Map<string, ShopifyProductInfo>([
    [
      "gid://shopify/Product/1",
      product("gid://shopify/Product/1", "DRAFT", "", "SKU-481"),
    ],
  ]);
  const capturedUpdates: Array<{
    productId: string;
    status: "ACTIVE" | "DRAFT";
  }> = [];
  let missingBarcodeAlertCalled = false;

  const result = await processOneCWebhookItems(
    { "SKU-481": "Yes" },
    {
      fetchProductsByIdentifiers: async () => products,
      updateProductStatus: async (productId, status) => {
        capturedUpdates.push({ productId, status });
        return { id: productId, status };
      },
      sendMissingBarcodeAlert: async () => {
        missingBarcodeAlertCalled = true;
      },
    },
  );

  assert.deepEqual(capturedUpdates, [
    { productId: "gid://shopify/Product/1", status: "ACTIVE" },
  ]);
  assert.equal(result.received, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.unknown, 0);
  assert.equal(result.proposed, 1);
  assert.equal(result.applied, 1);
  assert.equal(missingBarcodeAlertCalled, false);
});

test("realtime abort stops later status mutations and propagates one signal to reads and writes", async () => {
  const controller = new AbortController();
  const products = new Map<string, ShopifyProductInfo>([
    ["p1", product("p1", "DRAFT", "B1")],
    ["p2", product("p2", "DRAFT", "B2")],
  ]);
  const writes: string[] = [];
  await assert.rejects(
    processOneCWebhookItems(
      { B1: "Yes", B2: "Yes" },
      {
        signal: controller.signal,
        fetchProductsByIdentifiers: async (_identifiers, signal) => {
          assert.equal(signal, controller.signal);
          return products;
        },
        updateProductStatus: async (productId, status, signal) => {
          assert.equal(signal, controller.signal);
          writes.push(productId);
          controller.abort(new DOMException("deadline", "TimeoutError"));
          return { id: productId, status };
        },
      },
    ),
    (error: any) => error?.name === "TimeoutError",
  );
  assert.deepEqual(writes, ["p1"]);
});
