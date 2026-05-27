import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDiffReport,
  renderConsoleOverview,
  writeReportFiles,
} from "../scripts/diff-shopify-1c";

test("buildDiffReport reports Shopify test-store drift and barcode data gaps", () => {
  const report = buildDiffReport({
    generatedAt: "2026-05-08T00:00:00.000Z",
    shopifyDomain: "test-shop.myshopify.com",
    apiVersion: "2026-04",
    modes: ["prices", "stock", "costs"],
    products: [
      {
        id: "gid://shopify/Product/1",
        handle: "shirt",
        title: "Shirt",
        status: "ACTIVE",
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/1",
            title: null,
            sku: "SHIRT",
            barcode: "111",
            price: "10.00",
            compareAtPrice: null,
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1",
              unitCost: { amount: "3.00", currencyCode: "AED" },
            },
          },
        ],
      },
      {
        id: "gid://shopify/Product/2",
        handle: "pants",
        title: "Pants",
        status: "ACTIVE",
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/2",
            title: null,
            sku: "PANTS",
            barcode: "222",
            price: "20.00",
            compareAtPrice: null,
            inventoryItem: {
              id: "gid://shopify/InventoryItem/2",
              unitCost: { amount: "5.00", currencyCode: "AED" },
            },
          },
        ],
      },
      {
        id: "gid://shopify/Product/3",
        handle: "blank-barcode",
        title: "Blank barcode",
        status: "DRAFT",
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/3",
            title: null,
            sku: "BLANK",
            barcode: "",
            price: "1.00",
            compareAtPrice: null,
            inventoryItem: null,
          },
        ],
      },
      {
        id: "gid://shopify/Product/4",
        handle: "duplicate-a",
        title: "Duplicate A",
        status: "DRAFT",
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/4",
            title: null,
            sku: "DUP-A",
            barcode: "dup",
            price: "2.00",
            compareAtPrice: null,
            inventoryItem: null,
          },
        ],
      },
      {
        id: "gid://shopify/Product/5",
        handle: "duplicate-b",
        title: "Duplicate B",
        status: "DRAFT",
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/5",
            title: null,
            sku: "DUP-B",
            barcode: "dup",
            price: "2.00",
            compareAtPrice: null,
            inventoryItem: null,
          },
        ],
      },
    ],
    oneC: {
      prices: { "111": 12, dup: 2 },
      discounts: { "111": 9, "333": 1 },
      stock: { "111": 1, "222": 0, "999": 5 },
      alqitharaCosts: { "111": 4, "333": 7 },
      localCosts: { "111": 6 },
      invalidValues: [{ source: "prices", barcode: "bad", value: "not-a-number" }],
    },
  });

  assert.equal(report.summary.priceDifferences, 1);
  assert.deepEqual(report.differences.prices[0], {
    barcode: "111",
    productHandle: "shirt",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    sku: "SHIRT",
    current: { price: "10.00", compareAtPrice: null },
    expected: { price: "9.00", compareAtPrice: "12.00" },
    oneC: { price: 12, discount: 9 },
  });

  assert.equal(report.summary.stockStatusDifferences, 1);
  assert.equal(report.differences.stockStatuses[0].productHandle, "pants");
  assert.equal(report.differences.stockStatuses[0].expectedStatus, "DRAFT");

  assert.equal(report.summary.costDifferences, 1);
  assert.deepEqual(report.differences.costs[0], {
    barcode: "111",
    productHandle: "shirt",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    inventoryItemId: "gid://shopify/InventoryItem/1",
    currentCost: "3.00",
    expectedCost: "6.00",
    source: "Local",
  });
  assert.equal("oneCCost" in report.differences.costs[0], false);

  assert.equal(report.summary.blankShopifyBarcodeVariants, 1);
  assert.equal(report.summary.duplicateShopifyBarcodeGroups, 1);
  assert.equal(report.summary.shopifyBarcodesMissingIn1cPrices, 1);
  assert.equal(report.summary.discountBarcodesWithoutBasePrice, 1);
  assert.equal(report.summary.oneCBarcodesMissingInShopify, 3);
  assert.equal(report.summary.invalidOneCValues, 1);
  assert.equal(report.summary.totalDifferences, 11);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shopify-1c-diff-test-"));
  try {
    const manifest = writeReportFiles(report, tempDir);
    const overview = renderConsoleOverview(report, manifest);

    assert.match(overview, /Price differences: 1/);
    assert.match(overview, /Report files:/);
    assert.doesNotMatch(overview, /current price=10\.00/);
    assert.doesNotMatch(overview, /shirt \|/);

    assert.ok(fs.existsSync(path.join(tempDir, "overview.txt")));
    assert.ok(fs.existsSync(path.join(tempDir, "json", "overview.json")));
    assert.ok(fs.existsSync(path.join(tempDir, "json", "full-report.json")));
    assert.ok(fs.existsSync(path.join(tempDir, "json", "price-differences.json")));
    assert.ok(fs.existsSync(path.join(tempDir, "json", "stock-status-differences.json")));
    assert.ok(fs.existsSync(path.join(tempDir, "json", "cost-differences.json")));
    assert.ok(
      fs.existsSync(path.join(tempDir, "json", "one-c-stock-barcodes-missing-in-shopify.json")),
    );
    assert.ok(fs.existsSync(path.join(tempDir, "csv", "overview.csv")));
    assert.ok(fs.existsSync(path.join(tempDir, "csv", "price-differences.csv")));
    assert.ok(fs.existsSync(path.join(tempDir, "csv", "stock-status-differences.csv")));
    assert.ok(fs.existsSync(path.join(tempDir, "csv", "cost-differences.csv")));
    assert.ok(
      fs.existsSync(path.join(tempDir, "csv", "one-c-stock-barcodes-missing-in-shopify.csv")),
    );
    assert.ok(fs.existsSync(path.join(tempDir, "excel", "shopify-1c-diff.xlsx")));

    const overviewJson = JSON.parse(
      fs.readFileSync(path.join(tempDir, "json", "overview.json"), "utf8"),
    );
    assert.equal(overviewJson.summary.totalDifferences, 11);
    assert.ok(overviewJson.jsonDirectory.endsWith("/json"));
    assert.ok(overviewJson.csvDirectory.endsWith("/csv"));
    assert.ok(overviewJson.excelDirectory.endsWith("/excel"));
    assert.ok(overviewJson.files.json["cost-differences.json"].endsWith("json/cost-differences.json"));
    assert.ok(overviewJson.files.csv["cost-differences.csv"].endsWith("csv/cost-differences.csv"));
    assert.ok(
      overviewJson.files.excel["shopify-1c-diff.xlsx"].endsWith(
        "excel/shopify-1c-diff.xlsx",
      ),
    );

    const priceRows = JSON.parse(
      fs.readFileSync(path.join(tempDir, "json", "price-differences.json"), "utf8"),
    );
    assert.equal(priceRows.length, 1);
    assert.equal(priceRows[0].barcode, "111");

    const costRows = JSON.parse(
      fs.readFileSync(path.join(tempDir, "json", "cost-differences.json"), "utf8"),
    );
    assert.equal(costRows.length, 1);
    assert.equal("oneCCost" in costRows[0], false);

    const costCsv = fs.readFileSync(path.join(tempDir, "csv", "cost-differences.csv"), "utf8");
    assert.match(costCsv, /^barcode,productHandle,productId,variantId,inventoryItemId,currentCost,expectedCost,source\n/);
    assert.match(costCsv, /111,shirt/);
    assert.doesNotMatch(costCsv, /oneCCost/);

    const excelWorkbook = fs.readFileSync(
      path.join(tempDir, "excel", "shopify-1c-diff.xlsx"),
    );
    const excelEntries = readZipEntryNames(excelWorkbook);
    assert.ok(excelEntries.includes("[Content_Types].xml"));
    assert.ok(excelEntries.includes("xl/workbook.xml"));
    assert.ok(excelEntries.includes("xl/worksheets/sheet1.xml"));

    const excelText = excelWorkbook.toString("utf8");
    assert.match(excelText, /^PK/);
    assert.match(excelText, /price-differences/);
    assert.match(excelText, /stock-status-differences/);
    assert.match(excelText, /cost-differences/);
    assert.match(excelText, /expectedCost/);
    assert.doesNotMatch(excelText, /oneCCost/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildDiffReport applies product custom.weight to 1C prices, discounts, and costs", () => {
  const report = buildDiffReport({
    generatedAt: "2026-05-08T00:00:00.000Z",
    shopifyDomain: "test-shop.myshopify.com",
    apiVersion: "2026-04",
    modes: ["prices", "costs"],
    products: [
      {
        id: "gid://shopify/Product/weighted",
        handle: "weighted-coffee",
        title: "Weighted Coffee",
        status: "ACTIVE",
        weightKg: 0.5,
        variantsTruncated: false,
        variants: [
          {
            id: "gid://shopify/ProductVariant/weighted",
            title: null,
            sku: "WEIGHTED",
            barcode: "W-1",
            price: "30.00",
            compareAtPrice: null,
            inventoryItem: {
              id: "gid://shopify/InventoryItem/weighted",
              unitCost: { amount: "30.00", currencyCode: "AED" },
            },
          },
        ],
      },
    ],
    oneC: {
      prices: { "W-1": 30 },
      discounts: { "W-1": 20 },
      stock: {},
      alqitharaCosts: { "W-1": 30 },
      localCosts: {},
      invalidValues: [],
    },
  });

  assert.equal(report.summary.priceDifferences, 1);
  assert.deepEqual(report.differences.prices[0].expected, {
    price: "10.00",
    compareAtPrice: "15.00",
  });
  assert.equal(report.summary.costDifferences, 1);
  assert.equal(report.differences.costs[0].expectedCost, "15.00");
});

function readZipEntryNames(zip: Buffer): string[] {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1);

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let index = 0; index < entryCount; index++) {
    assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    const nameStart = centralOffset + 46;
    const nameEnd = nameStart + nameLength;
    names.push(zip.toString("utf8", nameStart, nameEnd));
    centralOffset = nameEnd + extraLength + commentLength;
  }

  return names;
}
