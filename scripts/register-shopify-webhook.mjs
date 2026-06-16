import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function readEnv(key) {
  const line = envText
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return process.env[key] || "";
  let value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function normalizeDomain(rawDomain) {
  return rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
}

function readFlag(raw) {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "test"].includes(value)) return true;
  if (["0", "false", "no", "off", "production", "prod"].includes(value))
    return false;
  return null;
}

function configuredTarget() {
  const target = readEnv("SHOPIFY_TARGET").trim().toLowerCase();
  if (target) {
    if (target === "production" || target === "prod") return "production";
    if (target === "test") return "test";
    throw new Error(
      `Invalid SHOPIFY_TARGET=${JSON.stringify(target)}. Expected production or test.`,
    );
  }

  const forceTest = readEnv("SHOPIFY_FORCE_TEST").trim();
  if (forceTest) {
    const parsed = readFlag(forceTest);
    if (parsed === null)
      throw new Error(
        `Invalid SHOPIFY_FORCE_TEST=${JSON.stringify(forceTest)}. Expected true or false.`,
      );
    return parsed ? "test" : "production";
  }

  // Match app runtime's backward-compatible safe default.
  return "test";
}

function parseTargetArg() {
  const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
  if (!targetArg) return configuredTarget();
  const target = targetArg.slice("--target=".length).trim().toLowerCase();
  if (["test", "production", "prod", "both"].includes(target)) {
    return target === "prod" ? "production" : target;
  }
  throw new Error(
    "Usage: node scripts/register-shopify-webhook.mjs [--target=test|production|both] [--dry-run]",
  );
}

function shopConfig(target) {
  const suffix = target === "test" ? "_TEST" : "";
  const rawDomain = readEnv(`SHOPIFY_STORE_DOMAIN${suffix}`);
  const token = readEnv(`SHOPIFY_ADMIN_TOKEN${suffix}`);
  const domain = normalizeDomain(rawDomain);
  if (!domain || !token) {
    throw new Error(
      `Missing SHOPIFY_STORE_DOMAIN${suffix} or SHOPIFY_ADMIN_TOKEN${suffix} in .env.local`,
    );
  }
  return { target, domain, token };
}

const apiVersion = readEnv("SHOPIFY_API_VERSION") || "2026-04";
const targetUri =
  readEnv("SHOPIFY_BULK_OPERATIONS_WEBHOOK_URI") ||
  "https://1c-integration.vercel.app/api/webhooks/shopify/bulk-operations";
const targetArg = parseTargetArg();
const dryRun = process.argv.includes("--dry-run");
const shops =
  targetArg === "both"
    ? [shopConfig("production"), shopConfig("test")]
    : [shopConfig(targetArg)];

async function graphql(shop, query, variables = {}) {
  const response = await fetch(
    `https://${shop.domain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shop.token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const listQuery = `#graphql
  query ExistingBulkOperationFinishWebhooks {
    webhookSubscriptions(first: 50, topics: [BULK_OPERATIONS_FINISH]) {
      nodes {
        id
        topic
        uri
        format
      }
    }
  }
`;

const createMutation = `#graphql
  mutation CreateBulkOperationFinishWebhook($subscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(
      topic: BULK_OPERATIONS_FINISH
      webhookSubscription: $subscription
    ) {
      webhookSubscription { id topic uri format }
      userErrors { field message }
    }
  }
`;

const updateMutation = `#graphql
  mutation UpdateBulkOperationFinishWebhook($id: ID!, $subscription: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(
      id: $id
      webhookSubscription: $subscription
    ) {
      webhookSubscription { id topic uri format }
      userErrors { field message }
    }
  }
`;

function assertNoUserErrors(result, operation) {
  const userErrors = result?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`${operation} userErrors: ${JSON.stringify(userErrors)}`);
  }
  if (!result?.webhookSubscription) {
    throw new Error(`${operation} returned no webhookSubscription`);
  }
}

async function registerShop(shop) {
  const before = (await graphql(shop, listQuery)).webhookSubscriptions.nodes;
  let action = "already_present";
  let subscription = before.find((node) => node.uri === targetUri);

  if (!subscription) {
    const firstExisting = before[0];
    const subscriptionInput = { uri: targetUri, format: "JSON" };
    if (dryRun) {
      action = firstExisting ? "would_update_existing" : "would_create";
      subscription = firstExisting ?? null;
    } else if (firstExisting) {
      const result = (
        await graphql(shop, updateMutation, {
          id: firstExisting.id,
          subscription: subscriptionInput,
        })
      ).webhookSubscriptionUpdate;
      assertNoUserErrors(result, "webhookSubscriptionUpdate");
      action = "updated_existing";
      subscription = result.webhookSubscription;
    } else {
      const result = (
        await graphql(shop, createMutation, { subscription: subscriptionInput })
      ).webhookSubscriptionCreate;
      assertNoUserErrors(result, "webhookSubscriptionCreate");
      action = "created";
      subscription = result.webhookSubscription;
    }
  }

  const after = dryRun
    ? before
    : (await graphql(shop, listQuery)).webhookSubscriptions.nodes;
  const matching = after.filter((node) => node.uri === targetUri);
  return {
    target: shop.target,
    shop: shop.domain,
    action,
    subscription,
    matchingCount: matching.length,
    allBulkOperationFinishSubscriptions: after,
  };
}

const results = [];
for (const shop of shops) {
  results.push(await registerShop(shop));
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun,
      selectedTarget: targetArg,
      apiVersion,
      targetUri,
      results,
    },
    null,
    2,
  ),
);
