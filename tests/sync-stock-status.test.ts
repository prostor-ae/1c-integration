import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockStatusDiff,
  type StockStatusUpdate,
} from "../src/app/lib/sync";
import type { ShopifyProductInfo } from "../src/app/lib/shopify-client";

function product(
  id: string,
  status: ShopifyProductInfo["status"],
  barcodes: string[],
  excludeFrom1cStatusSync = false,
  prices: string[] = [],
): ShopifyProductInfo {
  return {
    id: `gid://shopify/Product/${id}`,
    handle: `product-${id}`,
    status,
    weightKg: null,
    excludeFrom1cStatusSync,
    variants: barcodes.map((barcode, index) => ({
      id: `gid://shopify/ProductVariant/${id}-${index}`,
      barcode,
      price: prices[index] ?? "1.00",
      compareAtPrice: null,
    })),
  };
}

test("stock status diff uses >0.1 threshold for manual and daily shared stock sync", () => {
  const products = new Map<string, ShopifyProductInfo>(
    [
      product("active-above-threshold", "DRAFT", ["above"]),
      product("draft-at-threshold", "ACTIVE", ["at-threshold"]),
      product("draft-missing", "ACTIVE", ["missing"]),
      product("draft-invalid", "ACTIVE", ["invalid"]),
      product("multi-any-active", "DRAFT", ["zero", "multi-active"]),
    ].map((entry) => [entry.id, entry]),
  );

  const diff = buildStockStatusDiff(products, {
    above: 0.11,
    "at-threshold": 0.1,
    invalid: "not-a-number",
    zero: 0,
    "multi-active": 0.11,
  });

  const updates = diff.updates
    .map((update): StockStatusUpdate => ({
      productId: update.productId.replace("gid://shopify/Product/", ""),
      status: update.status,
    }))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  assert.deepEqual(updates, [
    { productId: "active-above-threshold", status: "ACTIVE" },
    { productId: "draft-at-threshold", status: "DRAFT" },
    { productId: "draft-invalid", status: "DRAFT" },
    { productId: "draft-missing", status: "DRAFT" },
    { productId: "multi-any-active", status: "ACTIVE" },
  ]);
  assert.equal(diff.currentlyActive, 3);
  assert.equal(diff.proposedDraftFlips, 3);
});

test("stock status diff excludes protected products from updates and safety math", () => {
  const entries = [
    product("protected-active", "ACTIVE", ["missing"], true),
    product("protected-draft", "DRAFT", ["available"], true),
    product("eligible-active", "ACTIVE", ["available"]),
    product("eligible-draft", "DRAFT", ["missing"]),
  ];
  const products = new Map(entries.map((entry) => [entry.id, entry]));

  const diff = buildStockStatusDiff(products, { available: 1 });

  assert.deepEqual(diff.updates, []);
  assert.equal(diff.currentlyActive, 1);
  assert.equal(diff.proposedDraftFlips, 0);
  assert.equal(diff.protectedProductsSkipped, 2);
  assert.deepEqual(diff.flippedToDraftSamples, []);
});

test("stock status diff does not activate a draft without an available positive-priced variant", () => {
  const entries = [
    product("zero-price", "DRAFT", ["zero-price"], false, ["0.00"]),
    product(
      "positive-price-out-of-stock",
      "DRAFT",
      ["zero-price-in-stock", "positive-price-out-of-stock"],
      false,
      ["0.00", "5.00"],
    ),
    product(
      "positive-price-in-stock",
      "DRAFT",
      ["zero-price-in-stock-2", "positive-price-in-stock"],
      false,
      ["0.00", "5.00"],
    ),
    product("zero-price-deactivation", "ACTIVE", ["out-of-stock"], false, [
      "0.00",
    ]),
  ];
  const products = new Map(entries.map((entry) => [entry.id, entry]));

  const diff = buildStockStatusDiff(products, {
    "zero-price": 1,
    "zero-price-in-stock": 1,
    "positive-price-out-of-stock": 0,
    "zero-price-in-stock-2": 1,
    "positive-price-in-stock": 1,
    "out-of-stock": 0,
  });

  assert.deepEqual(diff.updates, [
    {
      productId: "gid://shopify/Product/positive-price-in-stock",
      status: "ACTIVE",
    },
    {
      productId: "gid://shopify/Product/zero-price-deactivation",
      status: "DRAFT",
    },
  ]);
});
