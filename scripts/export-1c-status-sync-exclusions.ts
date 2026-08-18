/**
 * Read-only export of Shopify products carrying the
 * custom.exclude_from_1c_status_sync metafield.
 *
 * Run via: npm run export:1c-status-sync-exclusions -- --target=test
 *
 * Products with this metafield set to boolean true are skipped by the 1C status
 * sync (see src/app/lib/sync.ts and src/app/lib/1c-webhook.ts), so this export
 * answers "which products does 1C never activate or deactivate?".
 *
 * The script only issues GraphQL read queries. It never mutates Shopify.
 * Output is an Excel workbook with two sheets:
 * - Summary: catalog totals and the metafield/status breakdown
 * - Excluded products: one row per product with the flag set to true
 */

import fs from "node:fs";
import path from "node:path";
import { parseExcludeFrom1cStatusSyncMetafield } from "../src/app/lib/shopify-client";
import {
  toCsv,
  writeExcelWorkbook,
  type CsvRow,
  type ExcelSheet,
} from "./lib/xlsx";

type Target = "test" | "production";

type CliOptions = {
  target: Target;
  envFile: string | null;
  output: string | null;
  outputDir: string;
  csv: boolean;
};

type ExcludedProduct = {
  productId: string;
  handle: string;
  title: string;
  status: string;
  totalInventory: number | null;
  variantCount: number;
  skus: string;
  barcodes: string;
};

type ExportResult = {
  domain: string;
  apiVersion: string;
  target: Target;
  generatedAt: string;
  scannedProducts: number;
  excluded: ExcludedProduct[];
  metafieldStates: Map<string, number>;
  excludedByStatus: Map<string, number>;
  includedByStatus: Map<string, number>;
};

const DEFAULT_API_VERSION = "2026-04";
const DEFAULT_OUTPUT_DIR = path.join("reports", "1c-status-sync-exclusions");
const PAGE_SIZE = 100;
const MAX_VARIANTS_PER_PRODUCT = 100;

const PRODUCTS_QUERY = `
  query exclusionExport($cursor: String, $pageSize: Int!, $variantLimit: Int!) {
    products(first: $pageSize, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          status
          totalInventory
          excludeFrom1cStatusSyncMetafield: metafield(
            namespace: "custom"
            key: "exclude_from_1c_status_sync"
          ) {
            type
            value
          }
          variants(first: $variantLimit) {
            pageInfo { hasNextPage }
            edges { node { sku barcode } }
          }
        }
      }
    }
  }
`;

const excludedSheetHeaders = [
  "productId",
  "handle",
  "title",
  "status",
  "totalInventory",
  "variantCount",
  "skus",
  "barcodes",
];

const summarySheetHeaders = ["metric", "value"];

function printUsage(): void {
  console.log(
    `Usage: npm run export:1c-status-sync-exclusions -- --target=test|production [options]

Options:
  --target=test|production    Which Shopify store to read. Required.
  --output=path.xlsx          Write the workbook to this exact path.
  --output-dir=path           Directory for the generated workbook.
                              Default: ${DEFAULT_OUTPUT_DIR}
  --csv                       Also write the excluded products as a .csv
                              next to the workbook.
  --env-file=path             Load env vars from this file first.
                              Default: .env.local
  --no-env-file               Do not load an env file.
  --help                      Show this message.

Required env:
  test        SHOPIFY_STORE_DOMAIN_TEST + SHOPIFY_ADMIN_TOKEN_TEST
  production  SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN
  optional    SHOPIFY_API_VERSION (default ${DEFAULT_API_VERSION})`,
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  const options: CliOptions = {
    target: "test",
    envFile: ".env.local",
    output: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    csv: false,
  };
  let targetSeen = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return null;
    } else if (arg.startsWith("--target=")) {
      const raw = arg.slice("--target=".length).trim().toLowerCase();
      if (raw !== "test" && raw !== "production") {
        throw new Error(
          `Invalid --target value: ${raw}. Expected "test" or "production".`,
        );
      }
      options.target = raw;
      targetSeen = true;
    } else if (arg === "--csv") {
      options.csv = true;
    } else if (arg === "--no-env-file") {
      options.envFile = null;
    } else if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!targetSeen) {
    throw new Error(
      'Missing --target. Pass --target=test or --target=production.',
    );
  }

  return options;
}

function loadEnvFile(envFile: string): void {
  const resolved = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(resolved)) return;

  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
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

function getShopifyCredentials(target: Target): {
  domain: string;
  token: string;
  apiVersion: string;
} {
  const domainEnv =
    target === "test" ? "SHOPIFY_STORE_DOMAIN_TEST" : "SHOPIFY_STORE_DOMAIN";
  const tokenEnv =
    target === "test" ? "SHOPIFY_ADMIN_TOKEN_TEST" : "SHOPIFY_ADMIN_TOKEN";

  const rawDomain = process.env[domainEnv];
  const token = process.env[tokenEnv];
  if (!rawDomain || !token) {
    throw new Error(`Missing ${domainEnv} and/or ${tokenEnv} for --target=${target}.`);
  }

  return {
    domain: rawDomain
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, ""),
    token,
    apiVersion: process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION,
  };
}

async function shopifyGraphQL(
  domain: string,
  token: string,
  apiVersion: string,
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
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables }),
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
      }
      if (!res.ok) {
        throw Object.assign(
          new Error(`Shopify HTTP ${res.status}: ${await res.text()}`),
          { fatal: true },
        );
      }

      const payload = await res.json();
      if (payload.errors) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
      }
      return payload.data;
    } catch (error: any) {
      if (error?.fatal) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }

  throw lastError ?? new Error("Shopify request failed");
}

function increment(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function describeMetafieldState(metafield: any): string {
  if (!metafield) return "absent";
  return `${metafield.type ?? "unknown"}:${String(metafield.value)}`;
}

export async function collectExclusions(
  target: Target,
): Promise<ExportResult> {
  const { domain, token, apiVersion } = getShopifyCredentials(target);
  const result: ExportResult = {
    domain,
    apiVersion,
    target,
    generatedAt: new Date().toISOString(),
    scannedProducts: 0,
    excluded: [],
    metafieldStates: new Map(),
    excludedByStatus: new Map(),
    includedByStatus: new Map(),
  };

  const truncated: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(domain, token, apiVersion, {
      cursor,
      pageSize: PAGE_SIZE,
      variantLimit: MAX_VARIANTS_PER_PRODUCT,
    });
    const connection = data.products;

    for (const edge of connection.edges) {
      const node = edge.node;
      result.scannedProducts += 1;

      const metafield = node.excludeFrom1cStatusSyncMetafield;
      const excluded = parseExcludeFrom1cStatusSyncMetafield(metafield);
      increment(
        result.metafieldStates,
        excluded ? "true" : describeMetafieldState(metafield),
      );
      increment(
        excluded ? result.excludedByStatus : result.includedByStatus,
        node.status,
      );
      if (!excluded) continue;

      if (node.variants.pageInfo.hasNextPage) truncated.push(node.id);
      const variants = node.variants.edges.map((variantEdge: any) => variantEdge.node);
      result.excluded.push({
        productId: node.id,
        handle: node.handle,
        title: node.title,
        status: node.status,
        totalInventory: node.totalInventory ?? null,
        variantCount: variants.length,
        skus: variants
          .map((variant: any) => variant.sku ?? "")
          .filter(Boolean)
          .join(" | "),
        barcodes: variants
          .map((variant: any) => variant.barcode ?? "")
          .filter(Boolean)
          .join(" | "),
      });
    }

    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
  }

  if (truncated.length > 0) {
    console.warn(
      `Warning: ${truncated.length} product(s) have more than ${MAX_VARIANTS_PER_PRODUCT} variants; ` +
        `their sku/barcode columns are truncated: ${truncated.slice(0, 10).join(", ")}`,
    );
  }

  return result;
}

export function excludedRowsForExport(result: ExportResult): CsvRow[] {
  return result.excluded.map((product) => ({ ...product }));
}

export function summaryRowsForExport(result: ExportResult): CsvRow[] {
  const excludedCount = result.excluded.length;
  const includedCount = result.scannedProducts - excludedCount;
  const share =
    result.scannedProducts === 0
      ? "0.0%"
      : `${((excludedCount / result.scannedProducts) * 100).toFixed(1)}%`;

  const rows: CsvRow[] = [
    { metric: "generatedAt", value: result.generatedAt },
    { metric: "target", value: result.target },
    { metric: "shopifyDomain", value: result.domain },
    { metric: "shopifyApiVersion", value: result.apiVersion },
    { metric: "totalProducts", value: result.scannedProducts },
    { metric: "excludedFrom1cStatusSync", value: excludedCount },
    { metric: "notExcluded", value: includedCount },
    { metric: "excludedShareOfCatalog", value: share },
  ];

  for (const [status, count] of Array.from(result.excludedByStatus).sort()) {
    rows.push({ metric: `excluded.status.${status}`, value: count });
  }
  for (const [status, count] of Array.from(result.includedByStatus).sort()) {
    rows.push({ metric: `notExcluded.status.${status}`, value: count });
  }
  for (const [state, count] of Array.from(result.metafieldStates).sort()) {
    rows.push({ metric: `metafieldState.${state}`, value: count });
  }

  return rows;
}

function defaultOutputPath(options: CliOptions, result: ExportResult): string {
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  return path.join(
    options.outputDir,
    `1c-status-sync-exclusions-${result.target}-${stamp}.xlsx`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  if (options.envFile) loadEnvFile(options.envFile);

  const result = await collectExclusions(options.target);
  const summaryRows = summaryRowsForExport(result);
  const excludedRows = excludedRowsForExport(result);

  const outputPath = path.resolve(
    process.cwd(),
    options.output ?? defaultOutputPath(options, result),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sheets: ExcelSheet[] = [
    { name: "Summary", headers: summarySheetHeaders, rows: summaryRows },
    {
      name: "Excluded products",
      headers: excludedSheetHeaders,
      rows: excludedRows,
    },
  ];
  writeExcelWorkbook(outputPath, sheets);

  console.log(
    `Store ${result.domain} (${result.target}): ${result.excluded.length} of ` +
      `${result.scannedProducts} products have exclude_from_1c_status_sync = true.`,
  );
  for (const row of summaryRows) {
    console.log(`  ${row.metric}: ${row.value}`);
  }
  console.log(`Workbook: ${outputPath}`);

  if (options.csv) {
    const csvPath = outputPath.replace(/\.xlsx$/i, "") + ".csv";
    fs.writeFileSync(csvPath, toCsv(excludedSheetHeaders, excludedRows), "utf8");
    console.log(`CSV: ${csvPath}`);
  }
}

const isDirectRun = process.argv[1]?.includes("export-1c-status-sync-exclusions");
if (isDirectRun) {
  main().catch((error: any) => {
    console.error(
      `export-1c-status-sync-exclusions failed: ${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  });
}
