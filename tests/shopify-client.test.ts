import assert from "node:assert/strict";
import test from "node:test";
import {
  describeShopifyError,
  getShopifyLogContext,
  normalizeShopifyDomain,
} from "../src/app/lib/shopify-client";

test("normalizeShopifyDomain accepts bare domains and full URLs", () => {
  assert.equal(
    normalizeShopifyDomain("prostor-test.myshopify.com"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("https://prostor-test.myshopify.com"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("https://prostor-test.myshopify.com/admin"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("  http://prostor-test.myshopify.com/path  "),
    "prostor-test.myshopify.com",
  );
});

test("normalizeShopifyDomain rejects empty values", () => {
  assert.throws(
    () => normalizeShopifyDomain("https:///"),
    /Shopify store domain is empty/,
  );
});

test("describeShopifyError includes fetch failure cause details", () => {
  const cause = Object.assign(
    new Error("getaddrinfo ENOTFOUND bad-shop.myshopify.com"),
    {
      code: "ENOTFOUND",
      errno: -3008,
      syscall: "getaddrinfo",
      hostname: "bad-shop.myshopify.com",
    },
  );
  const error = Object.assign(new TypeError("fetch failed"), { cause });

  assert.deepEqual(describeShopifyError(error), {
    name: "TypeError",
    message: "fetch failed",
    causeName: "Error",
    causeMessage: "getaddrinfo ENOTFOUND bad-shop.myshopify.com",
    code: "ENOTFOUND",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: "bad-shop.myshopify.com",
    address: undefined,
    port: undefined,
  });
});

test("getShopifyLogContext reports forced test target without exposing token", () => {
  const previous = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_TOKEN: process.env.SHOPIFY_ADMIN_TOKEN,
    SHOPIFY_STORE_DOMAIN_TEST: process.env.SHOPIFY_STORE_DOMAIN_TEST,
    SHOPIFY_ADMIN_TOKEN_TEST: process.env.SHOPIFY_ADMIN_TOKEN_TEST,
  };

  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN = "prod-token";
  process.env.SHOPIFY_STORE_DOMAIN_TEST =
    "https://test-shop.myshopify.com/admin";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";

  try {
    const context = getShopifyLogContext(false);

    assert.equal(context.shopifyRequestedTarget, "production");
    assert.equal(context.shopifyTarget, "test");
    assert.equal(context.shopifyForcedTest, true);
    assert.equal(context.shopifyDomain, "test-shop.myshopify.com");
    assert.equal(context.shopifyCredentialsConfigured, true);
    assert.equal(JSON.stringify(context).includes("test-token"), false);
    assert.equal(JSON.stringify(context).includes("prod-token"), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
