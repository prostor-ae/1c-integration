/**
 * Standalone audit script. Lists Shopify variants with blank or duplicate barcodes.
 *
 * Run via: npx tsx scripts/audit-barcodes.ts
 *
 * Reads SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN from env.
 * Always exits 0 (informational only, no mutation).
 */

const API_VERSION = process.env.API_VERSION || "2024-07";

type VariantRow = {
  variantId: string;
  barcode: string | null;
  productHandle: string;
};

async function shopifyGraphQL(
  domain: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify HTTP ${res.status}: ${res.statusText} - ${text}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error("Shopify GraphQL Error: " + JSON.stringify(json.errors));
  }
  return json;
}

async function fetchAllVariants(
  domain: string,
  token: string,
): Promise<VariantRow[]> {
  const rows: VariantRow[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const query = `
      query products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              handle
              variants(first: 100) {
                edges {
                  node {
                    id
                    barcode
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data: any = await shopifyGraphQL(domain, token, query, { cursor });
    for (const edge of data.data.products.edges) {
      const handle = edge.node.handle;
      for (const vEdge of edge.node.variants.edges) {
        rows.push({
          variantId: vEdge.node.id,
          barcode: vEdge.node.barcode ?? null,
          productHandle: handle,
        });
      }
    }
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
    console.error(`Fetched page; total variants so far: ${rows.length}`);
  }
  return rows;
}

async function main() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error(
      "SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN env vars are required",
    );
  }

  const variants = await fetchAllVariants(domain, token);

  const blank: VariantRow[] = [];
  const byBarcode = new Map<string, VariantRow[]>();
  for (const v of variants) {
    if (!v.barcode || v.barcode.trim() === "") {
      blank.push(v);
      continue;
    }
    const list = byBarcode.get(v.barcode) ?? [];
    list.push(v);
    byBarcode.set(v.barcode, list);
  }

  const duplicates: Array<[string, VariantRow[]]> = [];
  byBarcode.forEach((list, barcode) => {
    if (list.length > 1) duplicates.push([barcode, list]);
  });

  console.log(`Variants with blank barcode: ${blank.length}.`);
  for (const v of blank.slice(0, 100)) {
    console.log(`  ${v.productHandle} | ${v.variantId}`);
  }
  if (blank.length > 100) {
    console.log(`  ... (${blank.length - 100} more not shown)`);
  }
  console.log("");

  console.log(`Duplicate barcodes: ${duplicates.length}`);
  for (const [barcode, list] of duplicates) {
    const ids = list.map((v) => v.variantId).join(", ");
    console.log(`  ${barcode} -> [${ids}]`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`audit-barcodes failed: ${err?.message ?? err}`);
    process.exit(0);
  });
