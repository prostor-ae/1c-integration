import { SHOPIFY_API_VERSION } from "./config";

const FORCE_TEST_SHOPIFY = true;

type ShopifyEnvSelector = {
  requestedIsTest: boolean;
  effectiveIsTest: boolean;
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
  const effectiveIsTest = FORCE_TEST_SHOPIFY || isTest;
  return {
    requestedIsTest: isTest,
    effectiveIsTest,
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
      } environment variables.`,
    );
  }

  return {
    domain: normalizeShopifyDomain(env.rawDomain),
    token: env.token,
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
    shopifyForcedTest: FORCE_TEST_SHOPIFY,
    shopifyDomain: domain,
    shopifyDomainValid: domainValid,
    shopifyCredentialsConfigured: Boolean(env.rawDomain && env.token),
  };
}
