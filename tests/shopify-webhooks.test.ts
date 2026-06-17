import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, beforeEach } from "node:test";
import { POST as bulkWebhookPost } from "../src/app/api/webhooks/shopify/bulk-operations/route";
import {
  getWebhookIdempotencyValue,
  verifyShopifyWebhookHmac,
  verifyShopifyWebhookHmacWithDiagnostics,
} from "../src/app/lib/shopify-webhooks";
import {
  __resetQstashSyncForTests,
  __setSyncContinuationPublisherForTests,
  type SyncContinuationPublishRequest,
} from "../src/app/lib/qstash-sync";
import { __resetMemorySyncStateForTests } from "../src/app/lib/sync-state";

let publishedContinuations: SyncContinuationPublishRequest[] = [];

function assertSafeBulkFinishDeduplicationId(
  request: SyncContinuationPublishRequest,
): void {
  assert.match(
    request.deduplicationId ?? "",
    /^sync-bulk-finish-[a-f0-9]{64}$/,
  );
  assert.equal(request.deduplicationId?.includes(":"), false);
  assert.equal(request.deduplicationId?.includes("/"), false);
}

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  delete process.env.SHOPIFY_WEBHOOK_SECRET_TEST;
  delete process.env.SHOPIFY_API_SECRET_KEY_TEST;
  delete process.env.SHOPIFY_CLIENT_SECRET_TEST;
  delete process.env.SHOPIFY_WEBHOOK_SECRET_PRODUCTION;
  delete process.env.SHOPIFY_API_SECRET_KEY_PRODUCTION;
  delete process.env.SHOPIFY_CLIENT_SECRET_PRODUCTION;
  delete process.env.SHOPIFY_API_SECRET_KEY;
  delete process.env.SHOPIFY_CLIENT_SECRET;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.SHOPIFY_WEBHOOK_SECRET = "test-secret";
  process.env.SYNC_CONTINUATION_BASE_URL = "https://sync.example.test";
  __resetMemorySyncStateForTests();
  __resetQstashSyncForTests();
  publishedContinuations = [];
  __setSyncContinuationPublisherForTests(async (request) => {
    assert.equal(request.deduplicationId?.includes(":"), false);
    assert.equal(request.deduplicationId?.includes("/"), false);
    publishedContinuations.push(request);
    return {
      messageId: `msg_${publishedContinuations.length}`,
      url: request.url,
    };
  });
});

function signedWebhookRequest(
  body: unknown,
  {
    secret = "test-secret",
    shopDomain,
  }: { secret?: string; shopDomain?: string } = {},
): Request {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", secret)
    .update(raw, "utf8")
    .digest("base64");
  const headers: Record<string, string> = {
    "x-shopify-hmac-sha256": hmac,
    "x-shopify-topic": "bulk_operations/finish",
    "content-type": "application/json",
  };
  if (shopDomain) headers["x-shopify-shop-domain"] = shopDomain;
  return new Request(
    "https://example.test/api/webhooks/shopify/bulk-operations",
    {
      method: "POST",
      headers,
      body: raw,
    },
  );
}

test("verifyShopifyWebhookHmac accepts valid Shopify HMAC", () => {
  const raw = JSON.stringify({
    admin_graphql_api_id: "gid://shopify/BulkOperation/1",
  });
  const hmac = createHmac("sha256", "test-secret")
    .update(raw, "utf8")
    .digest("base64");
  assert.equal(verifyShopifyWebhookHmac(raw, hmac), true);
});

test("verifyShopifyWebhookHmac rejects invalid HMAC", () => {
  assert.equal(verifyShopifyWebhookHmac("{}", "bad"), false);
});

test("webhook HMAC diagnostics choose test-specific secret from shop domain header", () => {
  process.env.SHOPIFY_TARGET = "production";
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_WEBHOOK_SECRET = "legacy-secret";
  process.env.SHOPIFY_WEBHOOK_SECRET_TEST = "test-specific-secret";

  const raw = JSON.stringify({
    admin_graphql_api_id: "gid://shopify/BulkOperation/target-secret",
  });
  const hmac = createHmac("sha256", "test-specific-secret")
    .update(raw, "utf8")
    .digest("base64");

  const result = verifyShopifyWebhookHmacWithDiagnostics(raw, hmac, {
    shopDomainHeader: "test-shop.myshopify.com",
  });

  assert.equal(result.ok, true);
  assert.equal(result.webhookSecretTarget, "test");
  assert.equal(result.webhookSecretTargetSource, "shop_domain_header");
  assert.equal(result.matchedSecretSource, "SHOPIFY_WEBHOOK_SECRET_TEST");
  assert.deepEqual(result.candidateSecretSources, [
    "SHOPIFY_WEBHOOK_SECRET_TEST",
    "SHOPIFY_WEBHOOK_SECRET",
  ]);
  assert.deepEqual(result.configuredSecretSources, [
    "SHOPIFY_WEBHOOK_SECRET_TEST",
    "SHOPIFY_WEBHOOK_SECRET",
  ]);
});

test("webhook HMAC diagnostics expose safe mismatch metadata without secret values", () => {
  process.env.SHOPIFY_TARGET = "test";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_WEBHOOK_SECRET_TEST = "expected-secret";

  const result = verifyShopifyWebhookHmacWithDiagnostics(
    "{}",
    createHmac("sha256", "wrong-secret").update("{}", "utf8").digest("base64"),
    { shopDomainHeader: "test-shop.myshopify.com" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "digest_mismatch");
  assert.equal(result.webhookSecretTarget, "test");
  assert.deepEqual(result.candidateSecretSources, [
    "SHOPIFY_WEBHOOK_SECRET_TEST",
    "SHOPIFY_WEBHOOK_SECRET",
  ]);
  assert.equal(JSON.stringify(result).includes("expected-secret"), false);
  assert.equal(JSON.stringify(result).includes("wrong-secret"), false);
});

test("bulk-operation webhook publishes QStash continuation before final 2xx", async () => {
  const response = await bulkWebhookPost(
    signedWebhookRequest({
      admin_graphql_api_id: "gid://shopify/BulkOperation/1",
      status: "completed",
      error_code: null,
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(publishedContinuations.length, 1);
  assert.deepEqual(publishedContinuations[0].body, {
    kind: "bulk-finish",
    opId: "gid://shopify/BulkOperation/1",
    status: "COMPLETED",
    errorCode: null,
    source: "shopify-webhook",
  });
  assertSafeBulkFinishDeduplicationId(publishedContinuations[0]);
  const storedMarker = await getWebhookIdempotencyValue({
    topic: "bulk_operations/finish",
    operationId: "gid://shopify/BulkOperation/1",
    status: "COMPLETED",
  });
  assert.match(storedMarker ?? "", /^[a-f0-9]{32}$/);
});

test("bulk-operation webhook accepts test-specific secret when legacy secret is different", async () => {
  process.env.SHOPIFY_TARGET = "test";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_WEBHOOK_SECRET = "legacy-prod-secret";
  process.env.SHOPIFY_WEBHOOK_SECRET_TEST = "test-specific-secret";

  const response = await bulkWebhookPost(
    signedWebhookRequest(
      {
        admin_graphql_api_id: "gid://shopify/BulkOperation/test-secret",
        status: "completed",
        error_code: null,
      },
      {
        secret: "test-specific-secret",
        shopDomain: "test-shop.myshopify.com",
      },
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(publishedContinuations.length, 1);
  assert.deepEqual(publishedContinuations[0].body, {
    kind: "bulk-finish",
    opId: "gid://shopify/BulkOperation/test-secret",
    status: "COMPLETED",
    errorCode: null,
    source: "shopify-webhook",
  });
});

test("webhook publish failure leaves retry available, then duplicate after success is safe", async () => {
  __setSyncContinuationPublisherForTests(async () => {
    throw new Error("publish failed");
  });

  const first = await bulkWebhookPost(
    signedWebhookRequest({
      admin_graphql_api_id: "gid://shopify/BulkOperation/2",
      status: "completed",
      error_code: null,
    }),
  );
  const firstBody = await first.json();

  assert.equal(first.status, 500);
  assert.equal(firstBody.ok, false);
  assert.equal(
    await getWebhookIdempotencyValue({
      topic: "bulk_operations/finish",
      operationId: "gid://shopify/BulkOperation/2",
      status: "COMPLETED",
    }),
    null,
  );

  publishedContinuations = [];
  __setSyncContinuationPublisherForTests(async (request) => {
    publishedContinuations.push(request);
    return { messageId: "msg_retry", url: request.url };
  });

  const retry = await bulkWebhookPost(
    signedWebhookRequest({
      admin_graphql_api_id: "gid://shopify/BulkOperation/2",
      status: "completed",
      error_code: null,
    }),
  );
  const retryBody = await retry.json();

  assert.equal(retry.status, 200);
  assert.equal(retryBody.ok, true);
  assert.equal(retryBody.duplicate, false);
  assert.equal(publishedContinuations.length, 1);

  const duplicate = await bulkWebhookPost(
    signedWebhookRequest({
      admin_graphql_api_id: "gid://shopify/BulkOperation/2",
      status: "completed",
      error_code: null,
    }),
  );
  const duplicateBody = await duplicate.json();

  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.ok, true);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(publishedContinuations.length, 1);
});
