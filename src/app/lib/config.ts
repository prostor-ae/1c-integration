export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

export type RedisConfig = {
  url: string | null;
  required: boolean;
};

export function getRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || null,
    required: process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production",
  };
}

export function getStoreId(): string {
  return process.env.SHOPIFY_STORE_DOMAIN || "default-shop";
}

export function getWebhookSecret(): string | null {
  return (
    process.env.SHOPIFY_WEBHOOK_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    process.env.SHOPIFY_CLIENT_SECRET ||
    null
  );
}
