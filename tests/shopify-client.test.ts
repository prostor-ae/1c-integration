import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostUpdateBulkMutationJsonl,
  buildPriceUpdateBulkMutationJsonl,
  buildVariantIdentifierSearchQuery,
  callShopify,
  COST_UPDATE_BULK_MUTATION,
  describeShopifyError,
  getShopifyLogContext,
  isPositiveShopifyPrice,
  normalizeShopifyDomain,
  PRICE_UPDATE_BULK_MUTATION,
  fetchShopifyProductPage,
  parseExcludeFrom1cStatusSyncMetafield,
} from "../src/app/lib/shopify-client";
import {
  applyShopifyWeight,
  parseShopifyWeightKg,
  parseShopifyWeightMetafieldKg,
} from "../src/app/lib/product-weight";
import {
  isActiveOneCStockAmount,
  isSyncableOneCDiscount,
  isSyncableOneCPrice,
} from "../src/app/lib/one-c-values";
import { getStoreId } from "../src/app/lib/config";

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

test("Shopify retry backoff stops immediately for TimeoutError", async () => {
  const originalFetch = globalThis.fetch;
  const originalDomain = process.env.SHOPIFY_STORE_DOMAIN_TEST;
  const originalToken = process.env.SHOPIFY_ADMIN_TOKEN_TEST;
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("temporary network failure");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => callShopify("query products { products(first: 1) { nodes { id } } }", {}, false, { signal: controller.signal }),
      (error: any) => error?.name === "TimeoutError",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
    else process.env.SHOPIFY_STORE_DOMAIN_TEST = originalDomain;
    if (originalToken === undefined) delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
    else process.env.SHOPIFY_ADMIN_TOKEN_TEST = originalToken;
  }
});

function withShopifyTargetEnv(fn: () => void): void {
  const previous = {
    SHOPIFY_TARGET: process.env.SHOPIFY_TARGET,
    SHOPIFY_FORCE_TEST: process.env.SHOPIFY_FORCE_TEST,
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
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("getShopifyLogContext defaults to safe test target without exposing token", () => {
  withShopifyTargetEnv(() => {
    delete process.env.SHOPIFY_TARGET;
    delete process.env.SHOPIFY_FORCE_TEST;

    const context = getShopifyLogContext(false);

    assert.equal(context.shopifyRequestedTarget, "production");
    assert.equal(context.shopifyTarget, "test");
    assert.equal(context.shopifyTargetSource, "default_safe_test");
    assert.equal(context.shopifyForcedTest, true);
    assert.equal(context.shopifyDomain, "test-shop.myshopify.com");
    assert.equal(getStoreId(), "test-shop.myshopify.com");
    assert.equal(context.shopifyCredentialsConfigured, true);
    assert.equal(JSON.stringify(context).includes("test-token"), false);
    assert.equal(JSON.stringify(context).includes("prod-token"), false);
  });
});

test("SHOPIFY_TARGET=production selects production shop and store id", () => {
  withShopifyTargetEnv(() => {
    process.env.SHOPIFY_TARGET = "production";
    delete process.env.SHOPIFY_FORCE_TEST;

    const context = getShopifyLogContext(false);

    assert.equal(context.shopifyTarget, "production");
    assert.equal(context.shopifyTargetSource, "SHOPIFY_TARGET");
    assert.equal(context.shopifyForcedTest, false);
    assert.equal(context.shopifyDomain, "prod-shop.myshopify.com");
    assert.equal(getStoreId(), "prod-shop.myshopify.com");
  });
});

test("SHOPIFY_FORCE_TEST=false is a legacy production opt-in", () => {
  withShopifyTargetEnv(() => {
    delete process.env.SHOPIFY_TARGET;
    process.env.SHOPIFY_FORCE_TEST = "false";

    const context = getShopifyLogContext(false);

    assert.equal(context.shopifyTarget, "production");
    assert.equal(context.shopifyTargetSource, "SHOPIFY_FORCE_TEST");
    assert.equal(context.shopifyForcedTest, false);
    assert.equal(context.shopifyDomain, "prod-shop.myshopify.com");
    assert.equal(getStoreId(), "prod-shop.myshopify.com");
  });
});

test("explicit Shopify targets fail closed when the selected store domain is missing", () => {
  withShopifyTargetEnv(() => {
    process.env.SHOPIFY_TARGET = "test";
    delete process.env.SHOPIFY_STORE_DOMAIN_TEST;

    assert.throws(() => getStoreId(), /Missing SHOPIFY_STORE_DOMAIN_TEST/);
  });

  withShopifyTargetEnv(() => {
    process.env.SHOPIFY_TARGET = "production";
    delete process.env.SHOPIFY_STORE_DOMAIN;

    assert.throws(() => getStoreId(), /Missing SHOPIFY_STORE_DOMAIN/);
  });
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

test("large JSONL manifests build incrementally and fail at the byte boundary", () => {
  const updates = Array.from({ length: 20_000 }, (_, index) => ({
    productId: `gid://shopify/Product/${index}`,
    variantId: `gid://shopify/ProductVariant/${index}`,
    price: "12.34",
    compareAtPrice: null,
  }));
  const jsonl = buildPriceUpdateBulkMutationJsonl(updates, 8 * 1024 * 1024);
  assert.equal(jsonl.split("\n").length, updates.length);
  assert.throws(
    () => buildPriceUpdateBulkMutationJsonl(updates, 1_024),
    /bulk manifest exceeds 1024 byte limit/,
  );
});

test("cost bulk mutation uses inventoryItemUpdate id and input variables", () => {
  assert.match(COST_UPDATE_BULK_MUTATION, /inventoryItemUpdate/);
  assert.match(COST_UPDATE_BULK_MUTATION, /\$id: ID!/);
  assert.match(COST_UPDATE_BULK_MUTATION, /\$input: InventoryItemInput!/);
  assert.match(
    COST_UPDATE_BULK_MUTATION,
    /inventoryItemUpdate\(id: \$id, input: \$input\)/,
  );
  assert.match(COST_UPDATE_BULK_MUTATION, /unitCost\s*\{\s*amount\s*\}/);
  assert.doesNotMatch(
    COST_UPDATE_BULK_MUTATION,
    /inventoryItemUpdate\(input: \$input\)/,
  );
  assert.doesNotMatch(COST_UPDATE_BULK_MUTATION, /\n\s*cost\s*\n/);

  const jsonl = buildCostUpdateBulkMutationJsonl([
    {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      cost: 12.34,
    },
    {
      inventoryItemId: "gid://shopify/InventoryItem/2",
      cost: 20,
    },
  ]);

  const rows = jsonl.split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, [
    {
      id: "gid://shopify/InventoryItem/1",
      input: {
        cost: 12.34,
      },
    },
    {
      id: "gid://shopify/InventoryItem/2",
      input: {
        cost: 20,
      },
    },
  ]);
  assert.equal("id" in rows[0].input, false);
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

test("1C price helpers treat non-positive prices and invalid compare-at prices as not syncable", () => {
  assert.equal(isSyncableOneCPrice(139.65), true);
  assert.equal(isSyncableOneCPrice(0), false);
  assert.equal(isSyncableOneCPrice(-1), false);
  assert.equal(isSyncableOneCDiscount(30, 20), true);
  assert.equal(isSyncableOneCDiscount(0, 30), false);
  assert.equal(isSyncableOneCDiscount(30, 30), false);
  assert.equal(isSyncableOneCDiscount(20, 30), false);
  assert.equal(isSyncableOneCDiscount("not-a-number", 30), false);
});

test("Shopify price helper accepts only finite positive prices", () => {
  assert.equal(isPositiveShopifyPrice("0.01"), true);
  assert.equal(isPositiveShopifyPrice("0.00"), false);
  assert.equal(isPositiveShopifyPrice(0), false);
  assert.equal(isPositiveShopifyPrice(-1), false);
  assert.equal(isPositiveShopifyPrice("not-a-number"), false);
  assert.equal(isPositiveShopifyPrice(undefined), false);
});

test("1C stock helper treats only amounts above 0.1 as active", () => {
  assert.equal(isActiveOneCStockAmount(0.11), true);
  assert.equal(isActiveOneCStockAmount("0.11"), true);
  assert.equal(isActiveOneCStockAmount(0.1), false);
  assert.equal(isActiveOneCStockAmount(0), false);
  assert.equal(isActiveOneCStockAmount(-1), false);
  assert.equal(isActiveOneCStockAmount("not-a-number"), false);
  assert.equal(isActiveOneCStockAmount(null), false);
  assert.equal(isActiveOneCStockAmount(undefined), false);
});

test("status-sync exclusion metafield parser is strict", () => {
  assert.equal(
    parseExcludeFrom1cStatusSyncMetafield({ type: "boolean", value: "true" }),
    true,
  );
  assert.equal(
    parseExcludeFrom1cStatusSyncMetafield({ type: "boolean", value: "false" }),
    false,
  );
  assert.equal(
    parseExcludeFrom1cStatusSyncMetafield({ type: "single_line_text_field", value: "true" }),
    false,
  );
  assert.equal(
    parseExcludeFrom1cStatusSyncMetafield({ type: "boolean", value: "TRUE" }),
    false,
  );
  assert.equal(parseExcludeFrom1cStatusSyncMetafield(null), false);
});

test("product page maps opaque cursors, protection, and nested truncation", async () => {
  const previous = {
    SHOPIFY_STORE_DOMAIN_TEST: process.env.SHOPIFY_STORE_DOMAIN_TEST,
    SHOPIFY_ADMIN_TOKEN_TEST: process.env.SHOPIFY_ADMIN_TOKEN_TEST,
    fetch: globalThis.fetch,
  };
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";
  let variables: any;
  globalThis.fetch = (async (_input, init) => {
    variables = JSON.parse(String(init?.body)).variables;
    return new Response(JSON.stringify({
      data: {
        products: {
          pageInfo: { hasNextPage: true, endCursor: "opaque==cursor" },
          edges: [{ node: {
            id: "gid://shopify/Product/1",
            handle: "one",
            status: "ACTIVE",
            weightMetafield: null,
            excludeFrom1cStatusSyncMetafield: { type: "boolean", value: "true" },
            variants: {
              pageInfo: { hasNextPage: true },
              edges: [{ node: { id: "v1", barcode: "b", sku: "s", price: "1.00", compareAtPrice: null } }],
            },
          }}],
        },
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const page = await fetchShopifyProductPage("previous-opaque");
    assert.deepEqual(variables, { cursor: "previous-opaque" });
    assert.equal(page.endCursor, "opaque==cursor");
    assert.equal(page.hasNextPage, true);
    assert.deepEqual(page.truncatedProductIds, ["gid://shopify/Product/1"]);
    assert.equal(page.products[0].excludeFrom1cStatusSync, true);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.SHOPIFY_STORE_DOMAIN_TEST === undefined) delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
    else process.env.SHOPIFY_STORE_DOMAIN_TEST = previous.SHOPIFY_STORE_DOMAIN_TEST;
    if (previous.SHOPIFY_ADMIN_TOKEN_TEST === undefined) delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
    else process.env.SHOPIFY_ADMIN_TOKEN_TEST = previous.SHOPIFY_ADMIN_TOKEN_TEST;
  }
});
