import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, beforeEach } from "node:test";
import { POST as bulkWebhookPost } from "../src/app/api/webhooks/shopify/bulk-operations/route";
import {
  getWebhookIdempotencyValue,
  verifyShopifyWebhookHmac,
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

function signedWebhookRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", "test-secret")
    .update(raw, "utf8")
    .digest("base64");
  return new Request(
    "https://example.test/api/webhooks/shopify/bulk-operations",
    {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-topic": "bulk_operations/finish",
        "content-type": "application/json",
      },
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
