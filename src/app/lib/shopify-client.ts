import { ApiError } from "next/dist/server/api-utils";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN as string;
const API_VERSION = process.env.API_VERSION || "2024-07";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error(
    "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN environment variables."
  );
}

const SHOPIFY_GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyFetch(query: string, variables: any) {
  const res = await fetch(SHOPIFY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status,
      `Shopify API Error: ${res.statusText} - ${text}`
    );
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new ApiError(
      400,
      "Shopify GraphQL Error: " + JSON.stringify(json.errors)
    );
  }
  return json;
}

export async function callShopify(query: string, variables = {}) {
  while (true) {
    try {
      const data = await shopifyFetch(query, variables);

      if (!data.extensions || !data.extensions.cost) {
        return data;
      }

      const cost = data.extensions.cost;
      const bucket = cost.throttleStatus;
      const shortfall = cost.requestedQueryCost - bucket.currentlyAvailable;

      if (shortfall > 0) {
        const waitMs = (shortfall / bucket.restoreRate) * 1000 + 100; // +100 ms buffer
        console.log(`Throttled, waiting ${waitMs.toFixed(2)}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return data;
    } catch (error: any) {
      console.error("Error in callShopify:", error.message);
      if (error instanceof ApiError && error.statusCode === 429) {
        console.log("Rate limit error detected, retrying in 5s...");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // For other errors, re-throw after a delay
      await new Promise((r) => setTimeout(r, 5000));
      throw error;
    }
  }
}
