/**
 * Read-only local diff script for comparing the Shopify test store against 1C.
 *
 * Run via: npm run diff:shopify-1c
 *
 * The script never mutates Shopify or 1C. It fetches current data from:
 * - Shopify test store: SHOPIFY_STORE_DOMAIN_TEST + SHOPIFY_ADMIN_TOKEN_TEST
 * - 1C endpoints: ONE_C_* variables, with the same defaults used by the app
 */

import fs from "node:fs";
import path from "node:path";
import {
  applyShopifyWeight,
  parseShopifyWeightMetafieldKg,
} from "../src/app/lib/product-weight";

type Mode = "prices" | "stock" | "costs";

type OneCSource = "prices" | "discounts" | "stock" | "alqitharaCosts" | "localCosts";

type OneCValueMap = Record<string, number>;

type InvalidOneCValue = {
  source: OneCSource;
  barcode: string;
  value: unknown;
};

type ShopifyVariantSnapshot = {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  inventoryItem: {
    id: string;
    unitCost: {
      amount: string;
      currencyCode: string;
    } | null;
  } | null;
};

type ShopifyProductSnapshot = {
  id: string;
  handle: string;
  title: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | string;
  weightKg?: number | null;
  variants: ShopifyVariantSnapshot[];
  variantsTruncated: boolean;
};

type ShopifyVariantRef = {
  productId: string;
  productHandle: string;
  productTitle: string | null;
  productStatus: ShopifyProductSnapshot["status"];
  variantId: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string;
  price: string | null;
  compareAtPrice: string | null;
  inventoryItemId: string | null;
  cost: string | null;
  costCurrencyCode: string | null;
  weightKg: number | null;
};

export type PriceDifference = {
  barcode: string;
  productHandle: string;
  productId: string;
  variantId: string;
  sku: string | null;
  current: {
    price: string | null;
    compareAtPrice: string | null;
  };
  expected: {
    price: string;
    compareAtPrice: string | null;
  };
  oneC: {
    price: number;
    discount: number | null;
  };
};

export type StockStatusDifference = {
  productHandle: string;
  productId: string;
  currentStatus: ShopifyProductSnapshot["status"];
  expectedStatus: "ACTIVE" | "DRAFT";
  barcodes: string[];
  oneCStockByBarcode: Record<string, number | null>;
};

export type CostDifference = {
  barcode: string;
  productHandle: string;
  productId: string;
  variantId: string;
  inventoryItemId: string | null;
  currentCost: string | null;
  expectedCost: string;
  source: "Alqithara" | "Local";
};

export type MissingShopifyBarcode = {
  productHandle: string;
  productId: string;
  variantId: string;
  sku: string | null;
};

export type DuplicateShopifyBarcode = {
  barcode: string;
  variants: MissingShopifyBarcode[];
};

export type ShopifyBarcodeMissingPrice = {
  barcode: string;
  productHandle: string;
  productId: string;
  variantId: string;
  sku: string | null;
};

export type DiffReport = {
  generatedAt: string;
  shopify: {
    domain: string;
    apiVersion: string;
    productCount: number;
    variantCount: number;
    uniqueBarcodeCount: number;
  };
  oneC: {
    counts: Record<OneCSource, number>;
    invalidValues: InvalidOneCValue[];
  };
  modes: Mode[];
  summary: {
    priceDifferences: number;
    stockStatusDifferences: number;
    costDifferences: number;
    blankShopifyBarcodeVariants: number;
    duplicateShopifyBarcodeGroups: number;
    shopifyBarcodesMissingIn1cPrices: number;
    discountBarcodesWithoutBasePrice: number;
    oneCBarcodesMissingInShopify: number;
    truncatedShopifyProducts: number;
    invalidOneCValues: number;
    totalDifferences: number;
  };
  differences: {
    prices: PriceDifference[];
    stockStatuses: StockStatusDifference[];
    costs: CostDifference[];
  };
  dataGaps: {
    blankShopifyBarcodeVariants: MissingShopifyBarcode[];
    duplicateShopifyBarcodes: DuplicateShopifyBarcode[];
    shopifyBarcodesMissingIn1cPrices: ShopifyBarcodeMissingPrice[];
    discountBarcodesWithoutBasePrice: string[];
    oneCBarcodesMissingInShopify: {
      prices: string[];
      discounts: string[];
      stock: string[];
      costs: string[];
    };
    truncatedShopifyProducts: Array<{
      productId: string;
      productHandle: string;
      note: string;
    }>;
  };
};

type CostExpectation = {
  cost: number;
  source: "Alqithara" | "Local";
};

type DiffInput = {
  shopifyDomain: string;
  apiVersion: string;
  products: ShopifyProductSnapshot[];
  oneC: {
    prices: OneCValueMap;
    discounts: OneCValueMap;
    stock: OneCValueMap;
    alqitharaCosts: OneCValueMap;
    localCosts: OneCValueMap;
    invalidValues?: InvalidOneCValue[];
  };
  modes?: Mode[];
  generatedAt?: string;
};

type CliOptions = {
  envFile: string | null;
  json: boolean;
  output: string | null;
  outputDir: string | null;
  summaryOnly: boolean;
  failOnDiff: boolean;
  limit: number | null;
  modes: Mode[];
  verbose: boolean;
};

export type ReportFileManifest = {
  outputDir: string;
  jsonDir: string;
  csvDir: string;
  excelDir: string;
  files: {
    json: Record<string, string>;
    csv: Record<string, string>;
    excel: Record<string, string>;
    text: Record<string, string>;
  };
};

const DEFAULT_API_VERSION = "2026-04";
const DEFAULT_MODES: Mode[] = ["prices", "stock", "costs"];
const DEFAULT_REPORT_DIR = path.join("reports", "shopify-1c-diff");

function getOneCEndpoints(): Record<OneCSource, string> {
  return {
    prices:
      process.env.ONE_C_PRICES_URL ||
      "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabasePrices",
    discounts:
      process.env.ONE_C_DISCOUNTS_URL ||
      "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseDiscounts",
    stock:
      process.env.ONE_C_STOCK_URL ||
      "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseStockBalances",
    alqitharaCosts:
      process.env.ONE_C_URL_1 ||
      "https://crm.prostor.ae/prostor/hs/Integration/AlqitharaDatabaseCosts",
    localCosts:
      process.env.ONE_C_URL_2 ||
      "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseLocalCosts",
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    envFile: ".env.local",
    json: false,
    output: null,
    outputDir: null,
    summaryOnly: false,
    failOnDiff: false,
    limit: null,
    modes: DEFAULT_MODES,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary-only") {
      options.summaryOnly = true;
    } else if (arg === "--fail-on-diff") {
      options.failOnDiff = true;
    } else if (arg === "--no-env-file") {
      options.envFile = null;
    } else if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid --limit value: ${raw}`);
      }
      options.limit = parsed;
    } else if (arg.startsWith("--modes=")) {
      const rawModes = arg
        .slice("--modes=".length)
        .split(",")
        .map((mode) => mode.trim())
        .filter(Boolean);
      const invalid = rawModes.filter((mode) => !isMode(mode));
      if (invalid.length) {
        throw new Error(`Invalid mode(s): ${invalid.join(", ")}. Use prices,stock,costs.`);
      }
      const uniqueModes = DEFAULT_MODES.filter((mode) => rawModes.includes(mode));
      if (!uniqueModes.length) {
        throw new Error("--modes must include at least one of prices,stock,costs.");
      }
      options.modes = uniqueModes;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function isMode(value: string): value is Mode {
  return value === "prices" || value === "stock" || value === "costs";
}

function printHelpAndExit(): never {
  console.log(`Read-only Shopify test-store ↔ 1C diff

Usage:
  npm run diff:shopify-1c -- [options]

Options:
  --modes=prices,stock,costs  Compare selected modes only. Default: all.
  --json                      Print the overview as JSON instead of text.
  --output-dir=path           Write report files to this directory.
                              Default: reports/shopify-1c-diff/<timestamp>.
  --output=path               Also write the full JSON report to this file.
  --fail-on-diff              Exit with code 2 when differences are found.
  --env-file=path             Load env vars from this file first. Default: .env.local.
  --no-env-file               Do not load an env file.
  --verbose                   Show fetch progress on stderr.

Generated files:
  overview.txt at the report root, JSON files under json/, CSV files under
  csv/, and one Excel workbook under excel/. Console output is overview-only.

Required Shopify test-store env:
  SHOPIFY_STORE_DOMAIN_TEST
  SHOPIFY_ADMIN_TOKEN_TEST

1C env:
  ONE_C_USERNAME / ONE_C_PASSWORD are optional Basic Auth credentials.
  ONE_C_*_URL variables are optional and default to the app's current endpoints.
`);
  process.exit(0);
}

function loadEnvFile(filePath: string | null): void {
  if (!filePath) return;

  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) return;

  const contents = fs.readFileSync(absolutePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const equalsAt = withoutExport.indexOf("=");
    if (equalsAt <= 0) continue;

    const key = withoutExport.slice(0, equalsAt).trim();
    let value = withoutExport.slice(equalsAt + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function shopifyGraphQL(
  domain: string,
  token: string,
  apiVersion: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const url = `https://${domain}/admin/api/${apiVersion}/graphql.json`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Shopify HTTP ${res.status}: ${res.statusText} - ${text}`);
      }

      const json = JSON.parse(text);
      if (json.errors && json.errors.length) {
        const serialized = JSON.stringify(json.errors);
        if (serialized.includes("THROTTLED")) {
          throw new RetryableError(`Shopify GraphQL throttled: ${serialized}`);
        }
        throw new Error(`Shopify GraphQL Error: ${serialized}`);
      }

      return json;
    } catch (error: any) {
      const baseError = error instanceof Error ? error : new Error(String(error));
      const cause = (baseError as Error & { cause?: { message?: string } }).cause;
      lastError = cause?.message
        ? new Error(`${baseError.message}: ${cause.message}`)
        : baseError;
      const retryable =
        error instanceof RetryableError ||
        error instanceof TypeError ||
        /Shopify HTTP (429|5\d\d)/.test(lastError.message);
      if (!retryable || attempt === 5) break;
      await sleep(1000 * attempt);
    }
  }

  throw lastError ?? new Error("Unknown Shopify request failure");
}

class RetryableError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchShopifyTestStoreProducts({
  verbose,
}: {
  verbose: boolean;
}): Promise<{
  domain: string;
  apiVersion: string;
  products: ShopifyProductSnapshot[];
}> {
  const rawDomain = process.env.SHOPIFY_STORE_DOMAIN_TEST;
  const token = process.env.SHOPIFY_ADMIN_TOKEN_TEST;
  const apiVersion =
    process.env.SHOPIFY_API_VERSION || process.env.API_VERSION || DEFAULT_API_VERSION;

  if (!rawDomain || !token) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN_TEST / SHOPIFY_ADMIN_TOKEN_TEST environment variables.",
    );
  }
  const domain = normalizeShopifyDomain(rawDomain);

  const products: ShopifyProductSnapshot[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              handle
              title
              status
              weightMetafield: metafield(namespace: "custom", key: "weight") {
                value
              }
              variants(first: 100) {
                pageInfo { hasNextPage }
                edges {
                  node {
                    id
                    title
                    sku
                    barcode
                    price
                    compareAtPrice
                    inventoryItem {
                      id
                      unitCost {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await shopifyGraphQL(domain, token, apiVersion, query, { cursor });
    for (const edge of data.data.products.edges) {
      products.push({
        id: edge.node.id,
        handle: edge.node.handle,
        title: edge.node.title ?? null,
        status: edge.node.status,
        weightKg: parseShopifyWeightMetafieldKg(edge.node.weightMetafield),
        variants: edge.node.variants.edges.map((variantEdge: any) => ({
          id: variantEdge.node.id,
          title: variantEdge.node.title ?? null,
          sku: variantEdge.node.sku ?? null,
          barcode: variantEdge.node.barcode ?? null,
          price: variantEdge.node.price ?? null,
          compareAtPrice: variantEdge.node.compareAtPrice ?? null,
          inventoryItem: variantEdge.node.inventoryItem
            ? {
                id: variantEdge.node.inventoryItem.id,
                unitCost: variantEdge.node.inventoryItem.unitCost
                  ? {
                      amount: variantEdge.node.inventoryItem.unitCost.amount,
                      currencyCode: variantEdge.node.inventoryItem.unitCost.currencyCode,
                    }
                  : null,
              }
            : null,
        })),
        variantsTruncated: Boolean(edge.node.variants.pageInfo.hasNextPage),
      });
    }

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
    if (verbose) console.error(`Fetched Shopify products: ${products.length}`);
  }

  return { domain, apiVersion, products };
}

function normalizeShopifyDomain(rawDomain: string): string {
  const domain = rawDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  if (!domain) {
    throw new Error("SHOPIFY_STORE_DOMAIN_TEST is empty after normalization.");
  }

  return domain;
}

async function fetchOneCData(
  source: OneCSource,
  url: string,
  verbose: boolean,
): Promise<{ items: OneCValueMap; invalidValues: InvalidOneCValue[] }> {
  const username = process.env.ONE_C_USERNAME;
  const password = process.env.ONE_C_PASSWORD;
  const headers = new Headers();

  if (username && password) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    );
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch ${source} from 1C: ${res.status} ${res.statusText} - ${text}`);
  }

  const json = await res.json();
  const rawItems = isRecord(json?.Items) ? json.Items : {};
  const items: OneCValueMap = {};
  const invalidValues: InvalidOneCValue[] = [];

  Object.entries(rawItems).forEach(([barcode, value]) => {
    const numeric = Number(value);
    if (!barcode || !Number.isFinite(numeric)) {
      invalidValues.push({ source, barcode, value });
      return;
    }
    items[barcode] = numeric;
  });

  if (verbose) console.error(`Fetched 1C ${source}: ${Object.keys(items).length}`);
  return { items, invalidValues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchOneCSnapshot(
  modes: Mode[],
  verbose = false,
): Promise<DiffInput["oneC"]> {
  const endpoints = getOneCEndpoints();
  const wantsPrices = modes.includes("prices");
  const wantsStock = modes.includes("stock");
  const wantsCosts = modes.includes("costs");

  const entries: Array<[OneCSource, Promise<{ items: OneCValueMap; invalidValues: InvalidOneCValue[] }>]> = [];

  if (wantsPrices) {
    entries.push(["prices", fetchOneCData("prices", endpoints.prices, verbose)]);
    entries.push(["discounts", fetchOneCData("discounts", endpoints.discounts, verbose)]);
  }
  if (wantsStock) {
    entries.push(["stock", fetchOneCData("stock", endpoints.stock, verbose)]);
  }
  if (wantsCosts) {
    entries.push([
      "alqitharaCosts",
      fetchOneCData("alqitharaCosts", endpoints.alqitharaCosts, verbose),
    ]);
    entries.push(["localCosts", fetchOneCData("localCosts", endpoints.localCosts, verbose)]);
  }

  const oneC: DiffInput["oneC"] = {
    prices: {},
    discounts: {},
    stock: {},
    alqitharaCosts: {},
    localCosts: {},
    invalidValues: [],
  };

  const results = await Promise.all(
    entries.map(async ([source, promise]) => [source, await promise] as const),
  );

  results.forEach(([source, result]) => {
    oneC[source] = result.items;
    oneC.invalidValues?.push(...result.invalidValues);
  });

  return oneC;
}

export function buildDiffReport(input: DiffInput): DiffReport {
  const modes = input.modes ?? DEFAULT_MODES;
  const wantsPrices = modes.includes("prices");
  const wantsStock = modes.includes("stock");
  const wantsCosts = modes.includes("costs");

  const variantCount = input.products.reduce(
    (count, product) => count + product.variants.length,
    0,
  );
  const index = buildShopifyBarcodeIndex(input.products);
  const costs = mergeCosts(input.oneC.alqitharaCosts, input.oneC.localCosts);

  const priceDifferences = wantsPrices
    ? buildPriceDifferences(index.byBarcode, input.oneC.prices, input.oneC.discounts)
    : [];
  const stockStatusDifferences = wantsStock
    ? buildStockStatusDifferences(input.products, input.oneC.stock)
    : [];
  const costDifferences = wantsCosts ? buildCostDifferences(index.byBarcode, costs) : [];

  const shopifyBarcodesMissingIn1cPrices = wantsPrices
    ? Array.from(index.byBarcode.keys())
        .filter((barcode) => input.oneC.prices[barcode] === undefined)
        .sort()
        .map((barcode) => toMissingPriceRow(index.byBarcode.get(barcode)![0]))
    : [];

  const discountBarcodesWithoutBasePrice = wantsPrices
    ? Object.keys(input.oneC.discounts)
        .filter((barcode) => input.oneC.prices[barcode] === undefined)
        .sort()
    : [];

  const oneCBarcodesMissingInShopify = {
    prices: wantsPrices ? missingInShopify(input.oneC.prices, index.byBarcode) : [],
    discounts: wantsPrices ? missingInShopify(input.oneC.discounts, index.byBarcode) : [],
    stock: wantsStock ? missingInShopify(input.oneC.stock, index.byBarcode) : [],
    costs: wantsCosts
      ? Array.from(costs.keys())
          .filter((barcode) => !index.byBarcode.has(barcode))
          .sort()
      : [],
  };

  const truncatedShopifyProducts = input.products
    .filter((product) => product.variantsTruncated)
    .map((product) => ({
      productId: product.id,
      productHandle: product.handle,
      note: "Only first 100 variants were fetched for this product.",
    }));

  const oneCMissingTotal =
    oneCBarcodesMissingInShopify.prices.length +
    oneCBarcodesMissingInShopify.discounts.length +
    oneCBarcodesMissingInShopify.stock.length +
    oneCBarcodesMissingInShopify.costs.length;

  const invalidOneCValues = input.oneC.invalidValues ?? [];
  const summary = {
    priceDifferences: priceDifferences.length,
    stockStatusDifferences: stockStatusDifferences.length,
    costDifferences: costDifferences.length,
    blankShopifyBarcodeVariants: index.blankBarcodeVariants.length,
    duplicateShopifyBarcodeGroups: index.duplicateBarcodes.length,
    shopifyBarcodesMissingIn1cPrices: shopifyBarcodesMissingIn1cPrices.length,
    discountBarcodesWithoutBasePrice: discountBarcodesWithoutBasePrice.length,
    oneCBarcodesMissingInShopify: oneCMissingTotal,
    truncatedShopifyProducts: truncatedShopifyProducts.length,
    invalidOneCValues: invalidOneCValues.length,
    totalDifferences:
      priceDifferences.length +
      stockStatusDifferences.length +
      costDifferences.length +
      index.blankBarcodeVariants.length +
      index.duplicateBarcodes.length +
      shopifyBarcodesMissingIn1cPrices.length +
      discountBarcodesWithoutBasePrice.length +
      oneCMissingTotal +
      truncatedShopifyProducts.length +
      invalidOneCValues.length,
  };

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    shopify: {
      domain: input.shopifyDomain,
      apiVersion: input.apiVersion,
      productCount: input.products.length,
      variantCount,
      uniqueBarcodeCount: index.byBarcode.size,
    },
    oneC: {
      counts: {
        prices: Object.keys(input.oneC.prices).length,
        discounts: Object.keys(input.oneC.discounts).length,
        stock: Object.keys(input.oneC.stock).length,
        alqitharaCosts: Object.keys(input.oneC.alqitharaCosts).length,
        localCosts: Object.keys(input.oneC.localCosts).length,
      },
      invalidValues: invalidOneCValues,
    },
    modes,
    summary,
    differences: {
      prices: priceDifferences,
      stockStatuses: stockStatusDifferences,
      costs: costDifferences,
    },
    dataGaps: {
      blankShopifyBarcodeVariants: index.blankBarcodeVariants,
      duplicateShopifyBarcodes: index.duplicateBarcodes,
      shopifyBarcodesMissingIn1cPrices,
      discountBarcodesWithoutBasePrice,
      oneCBarcodesMissingInShopify,
      truncatedShopifyProducts,
    },
  };
}

function buildShopifyBarcodeIndex(products: ShopifyProductSnapshot[]): {
  byBarcode: Map<string, ShopifyVariantRef[]>;
  blankBarcodeVariants: MissingShopifyBarcode[];
  duplicateBarcodes: DuplicateShopifyBarcode[];
} {
  const byBarcode = new Map<string, ShopifyVariantRef[]>();
  const blankBarcodeVariants: MissingShopifyBarcode[] = [];

  products.forEach((product) => {
    product.variants.forEach((variant) => {
      const barcode = variant.barcode?.trim() ?? "";
      if (!barcode) {
        blankBarcodeVariants.push({
          productHandle: product.handle,
          productId: product.id,
          variantId: variant.id,
          sku: variant.sku,
        });
        return;
      }

      const ref: ShopifyVariantRef = {
        productId: product.id,
        productHandle: product.handle,
        productTitle: product.title,
        productStatus: product.status,
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        barcode,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        inventoryItemId: variant.inventoryItem?.id ?? null,
        cost: variant.inventoryItem?.unitCost?.amount ?? null,
        costCurrencyCode: variant.inventoryItem?.unitCost?.currencyCode ?? null,
        weightKg: product.weightKg ?? null,
      };
      const variants = byBarcode.get(barcode) ?? [];
      variants.push(ref);
      byBarcode.set(barcode, variants);
    });
  });

  const duplicateBarcodes = Array.from(byBarcode.entries())
    .filter(([, variants]) => variants.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([barcode, variants]) => ({
      barcode,
      variants: variants.map((variant) => ({
        productHandle: variant.productHandle,
        productId: variant.productId,
        variantId: variant.variantId,
        sku: variant.sku,
      })),
    }));

  return { byBarcode, blankBarcodeVariants, duplicateBarcodes };
}

function buildPriceDifferences(
  byBarcode: Map<string, ShopifyVariantRef[]>,
  prices: OneCValueMap,
  discounts: OneCValueMap,
): PriceDifference[] {
  const rows: PriceDifference[] = [];

  byBarcode.forEach((variants, barcode) => {
    const price = prices[barcode];
    if (price === undefined) return;

    const discount = discounts[barcode];
    variants.forEach((variant) => {
      const weightedPrice = applyShopifyWeight(price, variant.weightKg);
      const priceStr = money(weightedPrice);
      const hasValidDiscount = discount !== undefined && discount < price;
      const expectedPrice = hasValidDiscount
        ? money(applyShopifyWeight(discount, variant.weightKg))
        : priceStr;
      const expectedCompareAtPrice = hasValidDiscount ? priceStr : null;
      const currentPrice = moneyOrNull(variant.price);
      const currentCompareAtPrice = moneyOrNull(variant.compareAtPrice);
      if (
        currentPrice !== expectedPrice ||
        currentCompareAtPrice !== expectedCompareAtPrice
      ) {
        rows.push({
          barcode,
          productHandle: variant.productHandle,
          productId: variant.productId,
          variantId: variant.variantId,
          sku: variant.sku,
          current: {
            price: currentPrice,
            compareAtPrice: currentCompareAtPrice,
          },
          expected: {
            price: expectedPrice,
            compareAtPrice: expectedCompareAtPrice,
          },
          oneC: {
            price,
            discount: hasValidDiscount ? discount : null,
          },
        });
      }
    });
  });

  return rows.sort(sortByBarcodeHandle);
}

function buildStockStatusDifferences(
  products: ShopifyProductSnapshot[],
  stock: OneCValueMap,
): StockStatusDifference[] {
  const rows: StockStatusDifference[] = [];

  products.forEach((product) => {
    const barcodes = product.variants
      .map((variant) => variant.barcode?.trim() ?? "")
      .filter(Boolean);
    const uniqueBarcodes = Array.from(new Set(barcodes)).sort();

    let productInStock = false;
    const stockByBarcode: Record<string, number | null> = {};

    uniqueBarcodes.forEach((barcode) => {
      const stockBalance = stock[barcode];
      stockByBarcode[barcode] = stockBalance ?? null;
      if (stockBalance !== undefined && stockBalance > 0) {
        productInStock = true;
      }
    });

    const expectedStatus: "ACTIVE" | "DRAFT" = productInStock ? "ACTIVE" : "DRAFT";
    if (product.status !== expectedStatus) {
      rows.push({
        productHandle: product.handle,
        productId: product.id,
        currentStatus: product.status,
        expectedStatus,
        barcodes: uniqueBarcodes,
        oneCStockByBarcode: stockByBarcode,
      });
    }
  });

  return rows.sort((a, b) => a.productHandle.localeCompare(b.productHandle));
}

function buildCostDifferences(
  byBarcode: Map<string, ShopifyVariantRef[]>,
  costs: Map<string, CostExpectation>,
): CostDifference[] {
  const rows: CostDifference[] = [];

  costs.forEach((expected, barcode) => {
    const variants = byBarcode.get(barcode);
    if (!variants) return;

    variants.forEach((variant) => {
      const currentCost = moneyOrNull(variant.cost);
      const expectedCost = money(
        applyShopifyWeight(expected.cost, variant.weightKg),
      );
      if (currentCost !== expectedCost) {
        rows.push({
          barcode,
          productHandle: variant.productHandle,
          productId: variant.productId,
          variantId: variant.variantId,
          inventoryItemId: variant.inventoryItemId,
          currentCost,
          expectedCost,
          source: expected.source,
        });
      }
    });
  });

  return rows.sort(sortByBarcodeHandle);
}

function mergeCosts(
  alqitharaCosts: OneCValueMap,
  localCosts: OneCValueMap,
): Map<string, CostExpectation> {
  const merged = new Map<string, CostExpectation>();

  Object.entries(alqitharaCosts).forEach(([barcode, cost]) => {
    merged.set(barcode, { cost, source: "Alqithara" });
  });

  Object.entries(localCosts).forEach(([barcode, cost]) => {
    merged.set(barcode, { cost, source: "Local" });
  });

  return merged;
}

function missingInShopify(
  items: OneCValueMap,
  byBarcode: Map<string, ShopifyVariantRef[]>,
): string[] {
  return Object.keys(items)
    .filter((barcode) => !byBarcode.has(barcode))
    .sort();
}

function toMissingPriceRow(variant: ShopifyVariantRef): ShopifyBarcodeMissingPrice {
  return {
    barcode: variant.barcode,
    productHandle: variant.productHandle,
    productId: variant.productId,
    variantId: variant.variantId,
    sku: variant.sku,
  };
}

function money(value: string | number): string {
  return Number(value).toFixed(2);
}

function moneyOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : null;
}

function sortByBarcodeHandle<
  T extends { barcode: string; productHandle: string; variantId: string },
>(a: T, b: T): number {
  return (
    a.barcode.localeCompare(b.barcode) ||
    a.productHandle.localeCompare(b.productHandle) ||
    a.variantId.localeCompare(b.variantId)
  );
}

export function buildOverview(report: DiffReport, manifest?: ReportFileManifest) {
  return {
    generatedAt: report.generatedAt,
    shopify: {
      domain: report.shopify.domain,
      apiVersion: report.shopify.apiVersion,
      productCount: report.shopify.productCount,
      variantCount: report.shopify.variantCount,
      uniqueBarcodeCount: report.shopify.uniqueBarcodeCount,
    },
    oneCCounts: report.oneC.counts,
    modes: report.modes,
    summary: report.summary,
    outputDirectory: manifest?.outputDir,
    jsonDirectory: manifest?.jsonDir,
    csvDirectory: manifest?.csvDir,
    excelDirectory: manifest?.excelDir,
    files: manifest?.files,
  };
}

export function renderConsoleOverview(
  report: DiffReport,
  manifest?: ReportFileManifest,
): string {
  const lines: string[] = [];

  lines.push("Shopify test-store ↔ 1C diff overview");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Shopify: ${report.shopify.domain} (API ${report.shopify.apiVersion})`);
  lines.push(
    `Checked: products=${report.shopify.productCount}, variants=${report.shopify.variantCount}, uniqueBarcodes=${report.shopify.uniqueBarcodeCount}`,
  );
  lines.push(`Modes: ${report.modes.join(", ")}`);
  if (manifest) lines.push(`Report files: ${manifest.outputDir}`);
  lines.push("");
  lines.push("Mismatches/data gaps:");
  lines.push(`  Price differences: ${report.summary.priceDifferences}`);
  lines.push(`  Stock/status differences: ${report.summary.stockStatusDifferences}`);
  lines.push(`  Cost differences: ${report.summary.costDifferences}`);
  lines.push(`  Blank Shopify barcodes: ${report.summary.blankShopifyBarcodeVariants}`);
  lines.push(`  Duplicate Shopify barcode groups: ${report.summary.duplicateShopifyBarcodeGroups}`);
  lines.push(`  Shopify barcodes missing in 1C prices: ${report.summary.shopifyBarcodesMissingIn1cPrices}`);
  lines.push(`  1C barcodes missing in Shopify: ${report.summary.oneCBarcodesMissingInShopify}`);
  lines.push(`  Discount barcodes without base price: ${report.summary.discountBarcodesWithoutBasePrice}`);
  lines.push(`  Truncated Shopify products: ${report.summary.truncatedShopifyProducts}`);
  lines.push(`  Invalid 1C values: ${report.summary.invalidOneCValues}`);
  lines.push(`  Total differences/data gaps: ${report.summary.totalDifferences}`);

  return lines.join("\n");
}

type CsvCell = string | number | boolean | null | undefined;
type CsvRow = Record<string, CsvCell>;
type ExcelSheet = {
  name: string;
  headers: string[];
  rows: CsvRow[];
};
type ZipEntry = {
  name: string;
  data: Buffer;
};

const overviewCsvHeaders = ["metric", "value"];
const priceCsvHeaders = [
  "barcode",
  "productHandle",
  "productId",
  "variantId",
  "sku",
  "currentPrice",
  "currentCompareAtPrice",
  "expectedPrice",
  "expectedCompareAtPrice",
  "oneCPrice",
  "oneCDiscount",
];
const stockStatusCsvHeaders = [
  "productHandle",
  "productId",
  "currentStatus",
  "expectedStatus",
  "barcodes",
  "oneCStockByBarcode",
];
const costCsvHeaders = [
  "barcode",
  "productHandle",
  "productId",
  "variantId",
  "inventoryItemId",
  "currentCost",
  "expectedCost",
  "source",
];
const missingShopifyBarcodeCsvHeaders = ["productHandle", "productId", "variantId", "sku"];
const duplicateShopifyBarcodeCsvHeaders = [
  "barcode",
  "productHandle",
  "productId",
  "variantId",
  "sku",
];
const shopifyBarcodeMissingPriceCsvHeaders = [
  "barcode",
  "productHandle",
  "productId",
  "variantId",
  "sku",
];
const barcodeCsvHeaders = ["barcode"];
const truncatedProductCsvHeaders = ["productId", "productHandle", "note"];
const invalidOneCValueCsvHeaders = ["source", "barcode", "value"];

function toCsv(headers: string[], rows: CsvRow[]): string {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const rowLines = rows.map((row) =>
    headers.map((header) => escapeCsvCell(row[header])).join(","),
  );
  return `${[headerLine, ...rowLines].join("\n")}\n`;
}

function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function overviewRowsForCsv(report: DiffReport): CsvRow[] {
  return [
    { metric: "generatedAt", value: report.generatedAt },
    { metric: "shopifyDomain", value: report.shopify.domain },
    { metric: "shopifyApiVersion", value: report.shopify.apiVersion },
    { metric: "shopifyProductCount", value: report.shopify.productCount },
    { metric: "shopifyVariantCount", value: report.shopify.variantCount },
    { metric: "shopifyUniqueBarcodeCount", value: report.shopify.uniqueBarcodeCount },
    { metric: "modes", value: report.modes.join(",") },
    { metric: "oneCPricesCount", value: report.oneC.counts.prices },
    { metric: "oneCDiscountsCount", value: report.oneC.counts.discounts },
    { metric: "oneCStockCount", value: report.oneC.counts.stock },
    { metric: "oneCAlqitharaCostsCount", value: report.oneC.counts.alqitharaCosts },
    { metric: "oneCLocalCostsCount", value: report.oneC.counts.localCosts },
    ...Object.entries(report.summary).map(([metric, value]) => ({ metric, value })),
  ];
}

function priceRowsForCsv(rows: PriceDifference[]): CsvRow[] {
  return rows.map((row) => ({
    barcode: row.barcode,
    productHandle: row.productHandle,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
    currentPrice: row.current.price,
    currentCompareAtPrice: row.current.compareAtPrice,
    expectedPrice: row.expected.price,
    expectedCompareAtPrice: row.expected.compareAtPrice,
    oneCPrice: row.oneC.price,
    oneCDiscount: row.oneC.discount,
  }));
}

function stockStatusRowsForCsv(rows: StockStatusDifference[]): CsvRow[] {
  return rows.map((row) => ({
    productHandle: row.productHandle,
    productId: row.productId,
    currentStatus: row.currentStatus,
    expectedStatus: row.expectedStatus,
    barcodes: row.barcodes.join("|"),
    oneCStockByBarcode: JSON.stringify(row.oneCStockByBarcode),
  }));
}

function costRowsForCsv(rows: CostDifference[]): CsvRow[] {
  return rows.map((row) => ({
    barcode: row.barcode,
    productHandle: row.productHandle,
    productId: row.productId,
    variantId: row.variantId,
    inventoryItemId: row.inventoryItemId,
    currentCost: row.currentCost,
    expectedCost: row.expectedCost,
    source: row.source,
  }));
}

function missingShopifyBarcodeRowsForCsv(rows: MissingShopifyBarcode[]): CsvRow[] {
  return rows.map((row) => ({
    productHandle: row.productHandle,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
  }));
}

function duplicateShopifyBarcodeRowsForCsv(rows: DuplicateShopifyBarcode[]): CsvRow[] {
  return rows.flatMap((row) =>
    row.variants.map((variant) => ({
      barcode: row.barcode,
      productHandle: variant.productHandle,
      productId: variant.productId,
      variantId: variant.variantId,
      sku: variant.sku,
    })),
  );
}

function shopifyBarcodeMissingPriceRowsForCsv(
  rows: ShopifyBarcodeMissingPrice[],
): CsvRow[] {
  return rows.map((row) => ({
    barcode: row.barcode,
    productHandle: row.productHandle,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
  }));
}

function barcodeRowsForCsv(barcodes: string[]): CsvRow[] {
  return barcodes.map((barcode) => ({ barcode }));
}

function truncatedProductRowsForCsv(
  rows: DiffReport["dataGaps"]["truncatedShopifyProducts"],
): CsvRow[] {
  return rows.map((row) => ({
    productId: row.productId,
    productHandle: row.productHandle,
    note: row.note,
  }));
}

function invalidOneCValueRowsForCsv(rows: InvalidOneCValue[]): CsvRow[] {
  return rows.map((row) => ({
    source: row.source,
    barcode: row.barcode,
    value: JSON.stringify(row.value),
  }));
}

function writeExcelWorkbook(filePath: string, sheets: ExcelSheet[]): void {
  const workbookSheets = toExcelWorkbookSheets(sheets);
  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(contentTypesXml(workbookSheets.length), "utf8"),
    },
    { name: "_rels/.rels", data: Buffer.from(rootRelationshipsXml(), "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(workbookSheets), "utf8") },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(workbookRelationshipsXml(workbookSheets.length), "utf8"),
    },
  ];

  workbookSheets.forEach((sheet, index) => {
    files.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(worksheetXml(sheet.headers, sheet.rows), "utf8"),
    });
  });

  fs.writeFileSync(filePath, createStoredZip(files));
}

function toExcelWorkbookSheets(sheets: ExcelSheet[]): ExcelSheet[] {
  const used = new Set<string>();

  return sheets.map((sheet, index) => {
    const baseName = normalizeExcelSheetName(sheet.name) || `Sheet ${index + 1}`;
    let name = baseName;
    let suffix = 2;

    while (used.has(name.toLowerCase())) {
      const suffixText = ` ${suffix}`;
      name = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }

    used.add(name.toLowerCase());
    return { ...sheet, name };
  });
}

function normalizeExcelSheetName(name: string): string {
  return name
    .replace(/\.csv$/i, "")
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
}

function contentTypesXml(sheetCount: number): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;
    return `<Override PartName="/xl/worksheets/sheet${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }).join("");

  return xmlDeclaration(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      worksheetOverrides +
      `</Types>`,
  );
}

function rootRelationshipsXml(): string {
  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
}

function workbookXml(sheets: ExcelSheet[]): string {
  const sheetXml = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${
          index + 1
        }"/>`,
    )
    .join("");

  return xmlDeclaration(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheetXml}</sheets>` +
      `</workbook>`,
  );
}

function workbookRelationshipsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;
    return `<Relationship Id="rId${sheetNumber}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNumber}.xml"/>`;
  }).join("");

  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      relationships +
      `</Relationships>`,
  );
}

function worksheetXml(headers: string[], rows: CsvRow[]): string {
  const worksheetRows = [
    headers,
    ...rows.map((row) => headers.map((header) => row[header])),
  ];

  const sheetData = worksheetRows
    .map((values, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = values
        .map((value, columnIndex) => excelCellXml(value, columnIndex + 1, rowNumber))
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return xmlDeclaration(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${sheetData}</sheetData>` +
      `</worksheet>`,
  );
}

function excelCellXml(value: CsvCell, columnNumber: number, rowNumber: number): string {
  const cellRef = `${excelColumnName(columnNumber)}${rowNumber}`;
  const text = value === null || value === undefined ? "" : String(value);
  const preserveSpace = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";

  return `<c r="${cellRef}" t="inlineStr"><is><t${preserveSpace}>${escapeXmlText(
    text,
  )}</t></is></c>`;
}

function excelColumnName(columnNumber: number): string {
  let name = "";
  let current = columnNumber;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}

function xmlDeclaration(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const flags = 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  });

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]);
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index++) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function writeReportFiles(
  report: DiffReport,
  outputDir = defaultReportOutputDir(report),
): ReportFileManifest {
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
  const jsonDir = path.join(resolvedOutputDir, "json");
  const csvDir = path.join(resolvedOutputDir, "csv");
  const excelDir = path.join(resolvedOutputDir, "excel");
  fs.mkdirSync(jsonDir, { recursive: true });
  fs.mkdirSync(csvDir, { recursive: true });
  fs.mkdirSync(excelDir, { recursive: true });

  const manifest: ReportFileManifest = {
    outputDir: resolvedOutputDir,
    jsonDir,
    csvDir,
    excelDir,
    files: {
      json: {},
      csv: {},
      excel: {},
      text: {},
    },
  };
  const excelSheets: ExcelSheet[] = [];

  const writeJson = (filename: string, value: unknown) => {
    const filePath = path.join(jsonDir, filename);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    manifest.files.json[filename] = filePath;
  };

  const writeCsv = (filename: string, headers: string[], rows: CsvRow[]) => {
    const filePath = path.join(csvDir, filename);
    fs.writeFileSync(filePath, toCsv(headers, rows), "utf8");
    manifest.files.csv[filename] = filePath;
    excelSheets.push({ name: filename, headers, rows });
  };

  writeJson("full-report.json", report);
  writeJson("price-differences.json", report.differences.prices);
  writeCsv("price-differences.csv", priceCsvHeaders, priceRowsForCsv(report.differences.prices));
  writeJson("stock-status-differences.json", report.differences.stockStatuses);
  writeCsv(
    "stock-status-differences.csv",
    stockStatusCsvHeaders,
    stockStatusRowsForCsv(report.differences.stockStatuses),
  );
  writeJson("cost-differences.json", report.differences.costs);
  writeCsv("cost-differences.csv", costCsvHeaders, costRowsForCsv(report.differences.costs));
  writeJson("blank-shopify-barcode-variants.json", report.dataGaps.blankShopifyBarcodeVariants);
  writeCsv(
    "blank-shopify-barcode-variants.csv",
    missingShopifyBarcodeCsvHeaders,
    missingShopifyBarcodeRowsForCsv(report.dataGaps.blankShopifyBarcodeVariants),
  );
  writeJson("duplicate-shopify-barcodes.json", report.dataGaps.duplicateShopifyBarcodes);
  writeCsv(
    "duplicate-shopify-barcodes.csv",
    duplicateShopifyBarcodeCsvHeaders,
    duplicateShopifyBarcodeRowsForCsv(report.dataGaps.duplicateShopifyBarcodes),
  );
  writeJson(
    "shopify-barcodes-missing-in-1c-prices.json",
    report.dataGaps.shopifyBarcodesMissingIn1cPrices,
  );
  writeCsv(
    "shopify-barcodes-missing-in-1c-prices.csv",
    shopifyBarcodeMissingPriceCsvHeaders,
    shopifyBarcodeMissingPriceRowsForCsv(report.dataGaps.shopifyBarcodesMissingIn1cPrices),
  );
  writeJson(
    "one-c-price-barcodes-missing-in-shopify.json",
    report.dataGaps.oneCBarcodesMissingInShopify.prices,
  );
  writeCsv(
    "one-c-price-barcodes-missing-in-shopify.csv",
    barcodeCsvHeaders,
    barcodeRowsForCsv(report.dataGaps.oneCBarcodesMissingInShopify.prices),
  );
  writeJson(
    "one-c-discount-barcodes-missing-in-shopify.json",
    report.dataGaps.oneCBarcodesMissingInShopify.discounts,
  );
  writeCsv(
    "one-c-discount-barcodes-missing-in-shopify.csv",
    barcodeCsvHeaders,
    barcodeRowsForCsv(report.dataGaps.oneCBarcodesMissingInShopify.discounts),
  );
  writeJson(
    "one-c-stock-barcodes-missing-in-shopify.json",
    report.dataGaps.oneCBarcodesMissingInShopify.stock,
  );
  writeCsv(
    "one-c-stock-barcodes-missing-in-shopify.csv",
    barcodeCsvHeaders,
    barcodeRowsForCsv(report.dataGaps.oneCBarcodesMissingInShopify.stock),
  );
  writeJson(
    "one-c-cost-barcodes-missing-in-shopify.json",
    report.dataGaps.oneCBarcodesMissingInShopify.costs,
  );
  writeCsv(
    "one-c-cost-barcodes-missing-in-shopify.csv",
    barcodeCsvHeaders,
    barcodeRowsForCsv(report.dataGaps.oneCBarcodesMissingInShopify.costs),
  );
  writeJson(
    "discount-barcodes-without-base-price.json",
    report.dataGaps.discountBarcodesWithoutBasePrice,
  );
  writeCsv(
    "discount-barcodes-without-base-price.csv",
    barcodeCsvHeaders,
    barcodeRowsForCsv(report.dataGaps.discountBarcodesWithoutBasePrice),
  );
  writeJson("truncated-shopify-products.json", report.dataGaps.truncatedShopifyProducts);
  writeCsv(
    "truncated-shopify-products.csv",
    truncatedProductCsvHeaders,
    truncatedProductRowsForCsv(report.dataGaps.truncatedShopifyProducts),
  );
  writeJson("invalid-one-c-values.json", report.oneC.invalidValues);
  writeCsv(
    "invalid-one-c-values.csv",
    invalidOneCValueCsvHeaders,
    invalidOneCValueRowsForCsv(report.oneC.invalidValues),
  );
  writeCsv("overview.csv", overviewCsvHeaders, overviewRowsForCsv(report));

  const excelFilename = "shopify-1c-diff.xlsx";
  const excelPath = path.join(excelDir, excelFilename);
  writeExcelWorkbook(excelPath, excelSheets);
  manifest.files.excel[excelFilename] = excelPath;

  writeJson("overview.json", buildOverview(report, manifest));

  const overviewTextPath = path.join(resolvedOutputDir, "overview.txt");
  fs.writeFileSync(overviewTextPath, `${renderConsoleOverview(report, manifest)}\n`, "utf8");
  manifest.files.text["overview.txt"] = overviewTextPath;

  return manifest;
}

function defaultReportOutputDir(report: DiffReport): string {
  return path.join(DEFAULT_REPORT_DIR, toFileTimestamp(report.generatedAt));
}

function toFileTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnvFile(options.envFile);

  const [shopify, oneC] = await Promise.all([
    fetchShopifyTestStoreProducts({ verbose: options.verbose }),
    fetchOneCSnapshot(options.modes, options.verbose),
  ]);

  const report = buildDiffReport({
    shopifyDomain: shopify.domain,
    apiVersion: shopify.apiVersion,
    products: shopify.products,
    oneC,
    modes: options.modes,
  });

  const manifest = writeReportFiles(report, options.outputDir ?? undefined);

  if (options.output) {
    fs.writeFileSync(
      path.resolve(process.cwd(), options.output),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  if (options.json) {
    console.log(JSON.stringify(buildOverview(report, manifest), null, 2));
  } else {
    console.log(renderConsoleOverview(report, manifest));
  }

  if (options.failOnDiff && report.summary.totalDifferences > 0) {
    process.exitCode = 2;
  }
}

function isDirectRun(): boolean {
  return typeof require !== "undefined" && require.main === module;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`diff-shopify-1c failed: ${error?.message ?? error}`);
    process.exit(1);
  });
}
