import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { runSync } from "../src/app/lib/sync";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body === "string") return init.body;
  return "";
}

beforeEach(() => {
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";
  process.env.RESEND_API_KEY = "re_test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
  delete process.env.RESEND_API_KEY;
});

test("prices sync skips and alerts before Shopify mutations when 1C discounts Items is missing", async () => {
  const shopifyGraphqlBodies: string[] = [];
  const resendEmailBodies: any[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const body = requestBody(init);

    if (url.includes("test-shop.myshopify.com/admin/api/")) {
      shopifyGraphqlBodies.push(body);
      const parsed = JSON.parse(body);
      const query = String(parsed.query ?? "");

      assert.doesNotMatch(query, /products\s*\(/);
      assert.doesNotMatch(query, /stagedUploadsCreate/);
      assert.doesNotMatch(query, /bulkOperationRunMutation/);
      assert.doesNotMatch(query, /productVariantsBulkUpdate/);

      if (query.includes("currentBulkOperation")) {
        return jsonResponse({ data: { currentBulkOperation: null } });
      }
    }

    if (url.includes("ProstorDatabasePrices")) {
      return jsonResponse({ Items: { "4607065580261": 5.6 } });
    }

    if (url.includes("ProstorDatabaseDiscounts")) {
      return jsonResponse({});
    }

    if (url === "https://api.resend.com/emails") {
      resendEmailBodies.push(JSON.parse(body));
      return jsonResponse({ id: "email_test_1" });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  const result = await runSync({ modes: ["prices"] });

  assert.deepEqual(result.prices, {
    proposed: 0,
    applied: 0,
    skipped: "1C Discounts payload empty",
  });
  assert.equal(shopifyGraphqlBodies.length, 1);
  assert.equal(resendEmailBodies.length, 1);
  assert.equal(
    resendEmailBodies[0].subject,
    "[1c-integration] 1C payload empty (prices/Discounts)",
  );
  assert.match(resendEmailBodies[0].text, /empty or missing Items map/);
  assert.match(resendEmailBodies[0].text, /prices mode was skipped/);
});
