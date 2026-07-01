import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetch1cDiscounts, fetch1cPrices } from "../src/app/lib/1c-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("1C prices network failures include the 1C source in the error message", async () => {
  const networkError = new TypeError("fetch failed");
  globalThis.fetch = (async () => {
    throw networkError;
  }) as typeof fetch;

  await assert.rejects(fetch1cPrices(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "1C Prices fetch failed: fetch failed");
    assert.equal(error.cause, networkError);
    return true;
  });
});

test("1C discounts HTTP failures include the 1C source and status", async () => {
  globalThis.fetch = (async () =>
    new Response("temporary outage", {
      status: 503,
      statusText: "Service Unavailable",
    })) as typeof fetch;

  await assert.rejects(fetch1cDiscounts(), {
    message: "1C Discounts fetch failed: HTTP 503 Service Unavailable",
  });
});
