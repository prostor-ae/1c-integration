import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPriceUpdateBulkMutationJsonl,
  buildVariantIdentifierSearchQuery,
  describeShopifyError,
  getShopifyLogContext,
  normalizeShopifyDomain,
  PRICE_UPDATE_BULK_MUTATION,
} from "../src/app/lib/shopify-client";
import {
  applyShopifyWeight,
  parseShopifyWeightKg,
  parseShopifyWeightMetafieldKg,
} from "../src/app/lib/product-weight";

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

test("buildVariantIdentifierSearchQuery targets barcode and SKU fields", () => {
  assert.equal(
    buildVariantIdentifierSearchQuery(["481", "SKU-1", "481", "ABC 123"]),
    'barcode:481 OR sku:481 OR barcode:SKU-1 OR sku:SKU-1 OR barcode:"ABC 123" OR sku:"ABC 123"',
  );
});

test("price bulk mutation uses productVariantsBulkUpdate variables", () => {
  assert.match(PRICE_UPDATE_BULK_MUTATION, /productVariantsBulkUpdate/);
  assert.doesNotMatch(PRICE_UPDATE_BULK_MUTATION, /productVariantUpdate/);
  assert.match(PRICE_UPDATE_BULK_MUTATION, /\$productId: ID!/);
  assert.match(
    PRICE_UPDATE_BULK_MUTATION,
    /\$variants: \[ProductVariantsBulkInput!\]!/,
  );

  const jsonl = buildPriceUpdateBulkMutationJsonl([
    {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/2",
      price: "12.34",
      compareAtPrice: "15.00",
    },
    {
      productId: "gid://shopify/Product/3",
      variantId: "gid://shopify/ProductVariant/4",
      price: "20.00",
      compareAtPrice: null,
    },
  ]);

  const rows = jsonl.split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, [
    {
      productId: "gid://shopify/Product/1",
      variants: [
        {
          id: "gid://shopify/ProductVariant/2",
          price: "12.34",
          compareAtPrice: "15.00",
        },
      ],
    },
    {
      productId: "gid://shopify/Product/3",
      variants: [
        {
          id: "gid://shopify/ProductVariant/4",
          price: "20.00",
          compareAtPrice: null,
        },
      ],
    },
  ]);
});

test("product weight helpers parse positive decimal kg values and fallback on invalid values", () => {
  assert.equal(parseShopifyWeightKg("0.5"), 0.5);
  assert.equal(parseShopifyWeightMetafieldKg({ value: "1.25" }), 1.25);
  assert.equal(parseShopifyWeightKg(""), null);
  assert.equal(parseShopifyWeightKg("0"), null);
  assert.equal(parseShopifyWeightKg("not-a-number"), null);
  assert.equal(applyShopifyWeight(30, 0.5), 15);
  assert.equal(applyShopifyWeight(30, null), 30);
});
