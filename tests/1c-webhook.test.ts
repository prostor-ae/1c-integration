import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as oneCWebhookPost } from "../src/app/api/webhooks/1c/route";
import {
  parseOneCWebhookItems,
  processOneCWebhookItems,
} from "../src/app/lib/1c-webhook";
import type { MissingBarcodeAlertArgs } from "../src/app/lib/alerts";
import type { ShopifyProductInfo } from "../src/app/lib/shopify-client";

beforeEach(() => {
  delete process.env.ONE_C_WEBHOOK_KEY;
  process.env.NODE_ENV = "test";
});

function product(
  id: string,
  status: ShopifyProductInfo["status"],
  barcode: string,
  sku?: string,
): ShopifyProductInfo {
  return {
    id,
    handle: id.toLowerCase(),
    status,
    variants: [
      {
        id: `${id}-variant`,
        barcode,
        sku,
        price: "1.00",
        compareAtPrice: null,
      },
    ],
  };
}

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
          parsed.body === "not-json" &&
          parsed.bodyLength === 8
        );
      }),
    );
  } finally {
    console.log = originalLog;
  }
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
