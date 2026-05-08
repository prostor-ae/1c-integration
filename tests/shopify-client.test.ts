import assert from "node:assert/strict";
import test from "node:test";
import {
  describeShopifyError,
  normalizeShopifyDomain,
} from "../src/app/lib/shopify-client";

test("normalizeShopifyDomain accepts bare domains and full URLs", () => {
  assert.equal(
    normalizeShopifyDomain("prostor-test.myshopify.com"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("https://prostor-test.myshopify.com"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("https://prostor-test.myshopify.com/admin"),
    "prostor-test.myshopify.com",
  );
  assert.equal(
    normalizeShopifyDomain("  http://prostor-test.myshopify.com/path  "),
    "prostor-test.myshopify.com",
  );
});

test("normalizeShopifyDomain rejects empty values", () => {
  assert.throws(
    () => normalizeShopifyDomain("https:///"),
    /Shopify store domain is empty/,
  );
});

test("describeShopifyError includes fetch failure cause details", () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND bad-shop.myshopify.com"), {
    code: "ENOTFOUND",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: "bad-shop.myshopify.com",
  });
  const error = Object.assign(new TypeError("fetch failed"), { cause });

  assert.deepEqual(describeShopifyError(error), {
    name: "TypeError",
    message: "fetch failed",
    causeName: "Error",
    causeMessage: "getaddrinfo ENOTFOUND bad-shop.myshopify.com",
    code: "ENOTFOUND",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: "bad-shop.myshopify.com",
    address: undefined,
    port: undefined,
  });
});
