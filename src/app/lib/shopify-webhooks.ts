import { createHmac, timingSafeEqual } from "crypto";
import { getWebhookSecret } from "./config";
import { markIdempotent } from "./sync-state";

export type ShopifyBulkOperationWebhook = {
  admin_graphql_api_id?: string;
  status?: string;
  error_code?: string | null;
  type?: string;
};

export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  const secret = getWebhookSecret();
  if (!secret || !hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const digestBuffer = Buffer.from(digest, "utf8");
  const headerBuffer = Buffer.from(hmacHeader, "utf8");
  return digestBuffer.length === headerBuffer.length && timingSafeEqual(digestBuffer, headerBuffer);
}

export function parseBulkOperationWebhook(rawBody: string): ShopifyBulkOperationWebhook {
  return JSON.parse(rawBody) as ShopifyBulkOperationWebhook;
}

export async function recordWebhookIdempotency({
  topic,
  operationId,
  status,
}: {
  topic: string;
  operationId: string;
  status: string;
}): Promise<boolean> {
  return markIdempotent(`${topic}:${operationId}:${status}`, new Date().toISOString());
}
