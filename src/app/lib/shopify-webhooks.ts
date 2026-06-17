import { createHmac, timingSafeEqual } from "crypto";
import { getShopifyTargetConfig } from "./config";
import { getIdempotencyValue, markIdempotent } from "./sync-state";

export type ShopifyBulkOperationWebhook = {
  admin_graphql_api_id?: string;
  status?: string;
  error_code?: string | null;
  type?: string;
};

type ShopifyWebhookSecretSource =
  | "SHOPIFY_WEBHOOK_SECRET_TEST"
  | "SHOPIFY_API_SECRET_KEY_TEST"
  | "SHOPIFY_CLIENT_SECRET_TEST"
  | "SHOPIFY_WEBHOOK_SECRET_PRODUCTION"
  | "SHOPIFY_API_SECRET_KEY_PRODUCTION"
  | "SHOPIFY_CLIENT_SECRET_PRODUCTION"
  | "SHOPIFY_WEBHOOK_SECRET"
  | "SHOPIFY_API_SECRET_KEY"
  | "SHOPIFY_CLIENT_SECRET";

type ShopifyWebhookTarget = "test" | "production";

type ShopifyWebhookSecretCandidate = {
  source: ShopifyWebhookSecretSource;
  value: string;
};

export type ShopifyWebhookHmacVerification = {
  ok: boolean;
  reason: "matched" | "missing_hmac" | "missing_secret" | "digest_mismatch";
  matchedSecretSource?: ShopifyWebhookSecretSource;
  candidateSecretSources: ShopifyWebhookSecretSource[];
  configuredSecretSources: ShopifyWebhookSecretSource[];
  webhookSecretTarget: ShopifyWebhookTarget;
  webhookSecretTargetSource: "shop_domain_header" | "SHOPIFY_TARGET";
  shopDomainHeader?: string;
  hmacHeaderLength: number;
  rawBodyBytes: number;
};

const TEST_SECRET_SOURCES: ShopifyWebhookSecretSource[] = [
  "SHOPIFY_WEBHOOK_SECRET_TEST",
  "SHOPIFY_API_SECRET_KEY_TEST",
  "SHOPIFY_CLIENT_SECRET_TEST",
];

const PRODUCTION_SECRET_SOURCES: ShopifyWebhookSecretSource[] = [
  "SHOPIFY_WEBHOOK_SECRET_PRODUCTION",
  "SHOPIFY_API_SECRET_KEY_PRODUCTION",
  "SHOPIFY_CLIENT_SECRET_PRODUCTION",
];

const LEGACY_SECRET_SOURCES: ShopifyWebhookSecretSource[] = [
  "SHOPIFY_WEBHOOK_SECRET",
  "SHOPIFY_API_SECRET_KEY",
  "SHOPIFY_CLIENT_SECRET",
];

const ALL_SECRET_SOURCES: ShopifyWebhookSecretSource[] = [
  ...TEST_SECRET_SOURCES,
  ...PRODUCTION_SECRET_SOURCES,
  ...LEGACY_SECRET_SOURCES,
];

function normalizeShopDomain(rawDomain: string | null | undefined): string {
  return (rawDomain ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function configuredSecretSources(): ShopifyWebhookSecretSource[] {
  return ALL_SECRET_SOURCES.filter((source) => Boolean(process.env[source]));
}

function selectWebhookSecretTarget(
  shopDomainHeader?: string | null,
): Pick<
  ShopifyWebhookHmacVerification,
  "webhookSecretTarget" | "webhookSecretTargetSource" | "shopDomainHeader"
> {
  const normalizedShopHeader = normalizeShopDomain(shopDomainHeader);
  const testDomain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN_TEST);
  const productionDomain = normalizeShopDomain(
    process.env.SHOPIFY_STORE_DOMAIN,
  );

  if (normalizedShopHeader && normalizedShopHeader === testDomain) {
    return {
      webhookSecretTarget: "test",
      webhookSecretTargetSource: "shop_domain_header",
      shopDomainHeader: normalizedShopHeader,
    };
  }

  if (normalizedShopHeader && normalizedShopHeader === productionDomain) {
    return {
      webhookSecretTarget: "production",
      webhookSecretTargetSource: "shop_domain_header",
      shopDomainHeader: normalizedShopHeader,
    };
  }

  return {
    webhookSecretTarget: getShopifyTargetConfig().target,
    webhookSecretTargetSource: "SHOPIFY_TARGET",
    shopDomainHeader: normalizedShopHeader || undefined,
  };
}

function webhookSecretCandidates(
  target: ShopifyWebhookTarget,
): ShopifyWebhookSecretCandidate[] {
  const targetSources =
    target === "test" ? TEST_SECRET_SOURCES : PRODUCTION_SECRET_SOURCES;
  return [...targetSources, ...LEGACY_SECRET_SOURCES].flatMap((source) => {
    const value = process.env[source];
    return value ? [{ source, value }] : [];
  });
}

export function verifyShopifyWebhookHmacWithDiagnostics(
  rawBody: string,
  hmacHeader: string | null,
  options: { shopDomainHeader?: string | null } = {},
): ShopifyWebhookHmacVerification {
  const target = selectWebhookSecretTarget(options.shopDomainHeader);
  const candidates = webhookSecretCandidates(target.webhookSecretTarget);
  const baseResult = {
    ...target,
    candidateSecretSources: candidates.map((candidate) => candidate.source),
    configuredSecretSources: configuredSecretSources(),
    hmacHeaderLength: hmacHeader?.length ?? 0,
    rawBodyBytes: Buffer.byteLength(rawBody, "utf8"),
  };

  if (!hmacHeader) {
    return { ...baseResult, ok: false, reason: "missing_hmac" };
  }

  if (candidates.length === 0) {
    return { ...baseResult, ok: false, reason: "missing_secret" };
  }

  const headerBuffer = Buffer.from(hmacHeader, "utf8");
  for (const candidate of candidates) {
    const digest = createHmac("sha256", candidate.value)
      .update(rawBody, "utf8")
      .digest("base64");
    const digestBuffer = Buffer.from(digest, "utf8");
    const matched =
      digestBuffer.length === headerBuffer.length &&
      timingSafeEqual(digestBuffer, headerBuffer);
    if (matched) {
      return {
        ...baseResult,
        ok: true,
        reason: "matched",
        matchedSecretSource: candidate.source,
      };
    }
  }

  return { ...baseResult, ok: false, reason: "digest_mismatch" };
}

export function verifyShopifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null,
): boolean {
  return verifyShopifyWebhookHmacWithDiagnostics(rawBody, hmacHeader).ok;
}

export function parseBulkOperationWebhook(
  rawBody: string,
): ShopifyBulkOperationWebhook {
  return JSON.parse(rawBody) as ShopifyBulkOperationWebhook;
}

export async function recordWebhookIdempotency({
  topic,
  operationId,
  status,
  value = new Date().toISOString(),
}: {
  topic: string;
  operationId: string;
  status: string;
  value?: string;
}): Promise<boolean> {
  return markIdempotent(`${topic}:${operationId}:${status}`, value);
}

export async function getWebhookIdempotencyValue({
  topic,
  operationId,
  status,
}: {
  topic: string;
  operationId: string;
  status: string;
}): Promise<string | null> {
  return await getIdempotencyValue(`${topic}:${operationId}:${status}`);
}
