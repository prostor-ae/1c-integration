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
      price: "1.00",
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
