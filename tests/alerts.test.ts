import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ALERT_EMAIL_FROM,
  ALERT_EMAIL_RECIPIENT,
  ALERT_EMAIL_RECIPIENTS,
  sendAlert,
  sendMissingBarcodeAlert,
} from "../src/app/lib/alerts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
});

test("alert emails use the hardcoded Resend sender and recipient", () => {
  assert.equal(ALERT_EMAIL_FROM, "notification@morlavi92.uk");
  assert.equal(ALERT_EMAIL_RECIPIENT, "chepiga.lev@gmail.com");
  assert.deepEqual(ALERT_EMAIL_RECIPIENTS, [
    "chepiga.lev@gmail.com",
    "sergei.vasilev@alqithara.ae",
  ]);
});

test("alert emails no longer require sender or recipient environment variables", async () => {
  delete process.env.ALERT_FROM;
  delete process.env.ALERT_RECIPIENTS;
  delete process.env.RESEND_API_KEY;

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };

  try {
    await assert.doesNotReject(() =>
      sendAlert({ subject: "test subject", body: "test body" })
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  const logged = JSON.parse(errors[0]);
  assert.equal(logged.event, "alert_send_failed");
  assert.match(logged.error, /RESEND_API_KEY env var is not set/);
  assert.doesNotMatch(logged.error, /ALERT_FROM|ALERT_RECIPIENTS/);
});

test("unknown barcode alert sends one aggregated Resend email", async () => {
  process.env.RESEND_API_KEY = "re_test";
  let email: Record<string, unknown> | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(typeof init?.body, "string");
    email = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "email_unknown_barcodes" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await sendMissingBarcodeAlert({
    received: 3,
    matched: 1,
    unknown: 2,
    unchanged: 0,
    proposed: 1,
    applied: 1,
    unknownBarcodes: ["UNKNOWN-1", "UNKNOWN-2"],
  });

  assert.equal(
    email?.subject,
    "[1c-integration] 1C webhook unknown Shopify barcodes (2)",
  );
  assert.deepEqual(email?.to, ALERT_EMAIL_RECIPIENTS);
  assert.match(String(email?.text), /UNKNOWN-1/);
  assert.match(String(email?.text), /UNKNOWN-2/);
});
