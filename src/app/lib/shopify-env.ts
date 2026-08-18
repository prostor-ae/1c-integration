import { SHOPIFY_API_VERSION, getShopifyTargetConfig } from "./config";

type ShopifyEnvSelector = {
  requestedIsTest: boolean;
  effectiveIsTest: boolean;
  targetSource: string;
  forceTest: boolean;
  rawDomain: string | undefined;
  token: string | undefined;
};

export function normalizeShopifyDomain(rawDomain: string): string {
  const domain = rawDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  if (!domain) {
    throw new Error("Shopify store domain is empty after normalization.");
  }

  return domain;
}

function selectShopifyEnv(isTest = false): ShopifyEnvSelector {
  const configured = getShopifyTargetConfig();
  const effectiveIsTest = isTest || configured.target === "test";
  return {
    requestedIsTest: isTest,
    effectiveIsTest,
    targetSource: configured.source,
    forceTest: configured.forceTest,
    rawDomain: effectiveIsTest
      ? process.env.SHOPIFY_STORE_DOMAIN_TEST
      : process.env.SHOPIFY_STORE_DOMAIN,
    token: effectiveIsTest
      ? process.env.SHOPIFY_ADMIN_TOKEN_TEST
      : process.env.SHOPIFY_ADMIN_TOKEN,
  };
}

export function getShopifyCredentials(isTest = false): {
  domain: string;
  token: string;
} {
  const env = selectShopifyEnv(isTest);

  if (!env.rawDomain || !env.token) {
    throw new Error(
      `Missing ${
        env.effectiveIsTest
          ? "SHOPIFY_STORE_DOMAIN_TEST/SHOPIFY_ADMIN_TOKEN_TEST"
          : "SHOPIFY_STORE_DOMAIN/SHOPIFY_ADMIN_TOKEN"
      } environment variables. Effective Shopify target source: ${env.targetSource}.`,
    );
  }

  return {
    domain: normalizeShopifyDomain(env.rawDomain),
    token: env.token,
  };
}

export function getShopifyCredentialsForStoreId(storeId: string): {
  domain: string;
  token: string;
  isTest: boolean;
} {
  const normalizedStoreId = normalizeShopifyDomain(storeId);
  const candidates = [
    {
      isTest: true,
      domain: process.env.SHOPIFY_STORE_DOMAIN_TEST,
      token: process.env.SHOPIFY_ADMIN_TOKEN_TEST,
    },
    {
      isTest: false,
      domain: process.env.SHOPIFY_STORE_DOMAIN,
      token: process.env.SHOPIFY_ADMIN_TOKEN,
    },
  ];
  const matched = candidates.find(
    (candidate) =>
      candidate.domain &&
      normalizeShopifyDomain(candidate.domain) === normalizedStoreId,
  );
  if (!matched?.domain || !matched.token) {
    throw new Error(
      `Missing Shopify credentials for sync store alias ${normalizedStoreId}.`,
    );
  }
  return {
    domain: normalizeShopifyDomain(matched.domain),
    token: matched.token,
    isTest: matched.isTest,
  };
}

export function getShopifyLogContext(isTest = false) {
  const env = selectShopifyEnv(isTest);
  let domain: string | undefined;
  let domainValid = false;

  if (env.rawDomain) {
    try {
      domain = normalizeShopifyDomain(env.rawDomain);
      domainValid = true;
    } catch {
      domain = env.rawDomain;
    }
  }

  return {
    shopifyApiVersion: SHOPIFY_API_VERSION,
    shopifyRequestedTarget: env.requestedIsTest ? "test" : "production",
    shopifyTarget: env.effectiveIsTest ? "test" : "production",
    shopifyTargetSource: env.targetSource,
    shopifyForcedTest: env.forceTest,
    shopifyDomain: domain,
    shopifyDomainValid: domainValid,
    shopifyCredentialsConfigured: Boolean(env.rawDomain && env.token),
  };
}
