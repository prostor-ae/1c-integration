import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, beforeEach } from "node:test";
import { verifyShopifyWebhookHmac } from "../src/app/lib/shopify-webhooks";

beforeEach(() => {
  process.env.SHOPIFY_WEBHOOK_SECRET = "test-secret";
});

test("verifyShopifyWebhookHmac accepts valid Shopify HMAC", () => {
  const raw = JSON.stringify({ admin_graphql_api_id: "gid://shopify/BulkOperation/1" });
  const hmac = createHmac("sha256", "test-secret").update(raw, "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(raw, hmac), true);
});

test("verifyShopifyWebhookHmac rejects invalid HMAC", () => {
  assert.equal(verifyShopifyWebhookHmac("{}", "bad"), false);
});
