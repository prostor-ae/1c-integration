import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPriceUpdateBulkMutationJsonl,
  buildVariantIdentifierSearchQuery,
  callShopify,
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
import {
  isSyncableOneCDiscount,
  isSyncableOneCPrice,
} from "../src/app/lib/one-c-values";

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

test("callShopify returns successful responses even when post-call throttle bucket is low", async () => {
  const previous = {
    SHOPIFY_STORE_DOMAIN_TEST: process.env.SHOPIFY_STORE_DOMAIN_TEST,
    SHOPIFY_ADMIN_TOKEN_TEST: process.env.SHOPIFY_ADMIN_TOKEN_TEST,
    fetch: globalThis.fetch,
  };

  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        data: { products: { edges: [], pageInfo: { hasNextPage: false } } },
        extensions: {
          cost: {
            requestedQueryCost: 75,
            actualQueryCost: 40,
            throttleStatus: {
              maximumAvailable: 2000,
              currentlyAvailable: 10,
              restoreRate: 100,
            },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await callShopify(
      "query products($cursor: String) { products(first: 50, after: $cursor) { edges { node { id } } pageInfo { hasNextPage } } }",
      { cursor: null },
    );

    assert.equal(calls, 1);
    assert.deepEqual(result.data.products.edges, []);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.SHOPIFY_STORE_DOMAIN_TEST === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN_TEST =
        previous.SHOPIFY_STORE_DOMAIN_TEST;
    }
    if (previous.SHOPIFY_ADMIN_TOKEN_TEST === undefined) {
      delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
    } else {
      process.env.SHOPIFY_ADMIN_TOKEN_TEST = previous.SHOPIFY_ADMIN_TOKEN_TEST;
    }
  }
});

test("callShopify retry exhaustion includes GraphQL throttle cost details", async () => {
  const previous = {
    SHOPIFY_STORE_DOMAIN_TEST: process.env.SHOPIFY_STORE_DOMAIN_TEST,
    SHOPIFY_ADMIN_TOKEN_TEST: process.env.SHOPIFY_ADMIN_TOKEN_TEST,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };

  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        errors: [
          {
            message: "Throttled",
            extensions: { code: "THROTTLED" },
          },
        ],
        extensions: {
          cost: {
            requestedQueryCost: 2500,
            actualQueryCost: null,
            throttleStatus: {
              maximumAvailable: 2000,
              currentlyAvailable: 50,
              restoreRate: 100,
            },
          },
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  (globalThis as any).setTimeout = (callback: () => void) => {
    callback();
    return 0;
  };

  try {
    await assert.rejects(
      () =>
        callShopify(
          "query products { products(first: 1) { edges { node { id } } } }",
        ),
      (error: any) => {
        assert.match(
          error.message,
          /Shopify retries exhausted after 5 attempts/,
        );
        assert.match(error.message, /THROTTLED/);
        assert.match(error.message, /requestedQueryCost/);
        assert.match(error.message, /currentlyAvailable/);
        assert.doesNotMatch(error.message, /: null$/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    if (previous.SHOPIFY_STORE_DOMAIN_TEST === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN_TEST =
        previous.SHOPIFY_STORE_DOMAIN_TEST;
    }
    if (previous.SHOPIFY_ADMIN_TOKEN_TEST === undefined) {
      delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
    } else {
      process.env.SHOPIFY_ADMIN_TOKEN_TEST = previous.SHOPIFY_ADMIN_TOKEN_TEST;
    }
  }
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

test("1C price helpers treat non-positive prices and discounts as not syncable", () => {
  assert.equal(isSyncableOneCPrice(139.65), true);
  assert.equal(isSyncableOneCPrice(0), false);
  assert.equal(isSyncableOneCPrice(-1), false);
  assert.equal(isSyncableOneCDiscount(20, 30), true);
  assert.equal(isSyncableOneCDiscount(0, 30), false);
  assert.equal(isSyncableOneCDiscount(30, 30), false);
});
