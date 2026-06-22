import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ALERT_EMAIL_FROM,
  ALERT_EMAIL_RECIPIENT,
  ALERT_EMAIL_RECIPIENTS,
  sendAlert,
} from "../src/app/lib/alerts";

afterEach(() => {
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
