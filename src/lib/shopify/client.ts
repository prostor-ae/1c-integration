import axios from "axios";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";

// Create an axios instance pre-configured for Shopify Admin API
export const shopifyApi = axios.create({
  baseURL: `https:///${SHOPIFY_STORE}/admin/api/2024-07`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  },
});

export async function callShopify(query: string, variables = {}) {
  while (true) {
    try {
      const { data, status } = await shopifyApi.post("/graphql.json", {
        query,
        variables,
      });

      if (status !== 200) {
        throw new Error(`Shopify HTTP ${status}`);
      }

      if (data.errors?.length) {
        console.error("🛑 Shopify GQL error:", data.errors);
        throw new Error(data.errors[0].message || "GraphQL error");
      }

      if (!data.extensions || !data.extensions.cost) {
        return data;
      }

      const cost = data.extensions.cost;
      const bucket = cost.throttleStatus;
      const shortfall = cost.requestedQueryCost - bucket.currentlyAvailable;

      if (shortfall > 0) {
        const waitMs = (shortfall / bucket.restoreRate) * 1000 + 100; // +100 ms buffer
        console.log(`Throttled, waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return data;
    } catch (error: any) {
      console.error("Error in callShopify:", error.message);
      // Wait for a bit before retrying on network errors etc.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
  }
}
