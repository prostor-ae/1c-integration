/**
 * Read-only preflight for the nested variants(first: 100) runtime guard.
 *
 * Run via: npm run audit:variant-pagination
 * Exits 2 when any product has more than 100 variants. It never mutates Shopify
 * and never prints product-page cursors.
 */
import { fetchShopifyProductPage } from "../src/app/lib/shopify-client";

const targetArgument = process.argv.find((argument) => argument.startsWith("--target="));
const target = targetArgument?.slice("--target=".length);
if (target !== "test" && target !== "production") {
  console.error("Usage: npm run audit:variant-pagination -- --target=test|production");
  process.exitCode = 1;
} else {
  process.env.SHOPIFY_TARGET = target;
}

async function main(): Promise<void> {
  if (process.exitCode) return;
  let cursor: string | null = null;
  let hasNextPage = true;
  const truncated: Array<{ id: string; handle: string }> = [];

  while (hasNextPage) {
    const page = await fetchShopifyProductPage(cursor);
    const ids = new Set(page.truncatedProductIds);
    for (const product of page.products) {
      if (ids.has(product.id) && truncated.length < 25) {
        truncated.push({ id: product.id, handle: product.handle });
      }
    }
    cursor = page.endCursor;
    hasNextPage = page.hasNextPage;
  }

  if (truncated.length > 0) {
    console.error("Products exceeding the 100-variant nested page limit:");
    truncated.forEach((product) =>
      console.error(`  ${product.handle} | ${product.id}`),
    );
    process.exitCode = 2;
    return;
  }
  console.log(`Variant pagination preflight passed for ${target}: no truncated products found.`);
}

main().catch((error: any) => {
  console.error(
    `audit-shopify-variant-pagination failed: ${error?.message ?? String(error)}`,
  );
  process.exitCode = 1;
});
