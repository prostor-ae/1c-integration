export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

export type RedisConfig = {
  url: string | null;
  required: boolean;
};

export type ShopifyTarget = "production" | "test";

export type ShopifyTargetConfig = {
  target: ShopifyTarget;
  source: "SHOPIFY_TARGET" | "SHOPIFY_FORCE_TEST" | "default_safe_test";
  forceTest: boolean;
};

const TRUTHY = new Set(["1", "true", "yes", "on", "test"]);
const FALSY = new Set(["0", "false", "no", "off", "production", "prod"]);

function normalizeStoreDomain(rawDomain: string): string {
  return rawDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function parseShopifyTarget(raw: string): ShopifyTarget | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "test") return "test";
  if (normalized === "production" || normalized === "prod") return "production";
  return null;
}

function parseShopifyForceTest(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return null;
}

function shopifyDomainEnvNameForTarget(target: ShopifyTarget): string {
  return target === "test"
    ? "SHOPIFY_STORE_DOMAIN_TEST"
    : "SHOPIFY_STORE_DOMAIN";
}

export function getShopifyTargetConfig(): ShopifyTargetConfig {
  const target = process.env.SHOPIFY_TARGET;
  if (target !== undefined && target.trim() !== "") {
    const parsed = parseShopifyTarget(target);
    if (!parsed) {
      throw new Error(
        `Invalid SHOPIFY_TARGET=${JSON.stringify(target)}. Expected "production" or "test".`,
      );
    }
    return {
      target: parsed,
      source: "SHOPIFY_TARGET",
      forceTest: parsed === "test",
    };
  }

  const forceTest = process.env.SHOPIFY_FORCE_TEST;
  if (forceTest !== undefined && forceTest.trim() !== "") {
    const parsed = parseShopifyForceTest(forceTest);
    if (parsed === null) {
      throw new Error(
        `Invalid SHOPIFY_FORCE_TEST=${JSON.stringify(forceTest)}. Expected true/false.`,
      );
    }
    return {
      target: parsed ? "test" : "production",
      source: "SHOPIFY_FORCE_TEST",
      forceTest: parsed,
    };
  }

  // Backward-compatible safe default: this repository historically forced test
  // Shopify writes. Use SHOPIFY_TARGET=production to opt into production writes.
  return { target: "test", source: "default_safe_test", forceTest: true };
}

export function getRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || null,
    required:
      process.env.VERCEL_ENV === "production" ||
      process.env.NODE_ENV === "production",
  };
}

export function getLegacyStoreId(): string {
  return process.env.SHOPIFY_STORE_DOMAIN
    ? normalizeStoreDomain(process.env.SHOPIFY_STORE_DOMAIN)
    : "default-shop";
}

export function getStoreId(): string {
  const config = getShopifyTargetConfig();
  const rawDomain =
    config.target === "test"
      ? process.env.SHOPIFY_STORE_DOMAIN_TEST
      : process.env.SHOPIFY_STORE_DOMAIN;
  if (rawDomain) return normalizeStoreDomain(rawDomain);

  const requiredEnvName = shopifyDomainEnvNameForTarget(config.target);
  if (
    config.source !== "default_safe_test" ||
    process.env.SHOPIFY_STORE_DOMAIN
  ) {
    throw new Error(
      `Missing ${requiredEnvName} for effective Shopify target ${config.target} (${config.source}).`,
    );
  }

  return getLegacyStoreId();
}

export function getStoreIdAliases(): string[] {
  const aliases = [getStoreId(), getLegacyStoreId()];
  if (process.env.SHOPIFY_STORE_DOMAIN_TEST) {
    aliases.push(normalizeStoreDomain(process.env.SHOPIFY_STORE_DOMAIN_TEST));
  }
  return Array.from(new Set(aliases));
}

export function getWebhookSecret(): string | null {
  return (
    process.env.SHOPIFY_WEBHOOK_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    process.env.SHOPIFY_CLIENT_SECRET ||
    null
  );
}
