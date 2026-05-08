import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as triggerPost } from "../src/app/api/sync/trigger/route";
import { GET as cronGet } from "../src/app/api/cron/daily-sync/route";
import { GET as reconcileCronGet } from "../src/app/api/cron/reconcile-sync/route";
import { __resetMemorySyncStateForTests } from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.CRON_SECRET;
  process.env.NODE_ENV = "test";
  process.env.DISABLE_SYNC_KICKOFF = "1";
  process.env.INTERNAL_API_KEY = "secret";
  __resetMemorySyncStateForTests();
});

test("manual sync trigger quick-acks accepted run", async () => {
  const response = await triggerPost(
    new Request("https://example.test/api/sync/trigger", {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body: JSON.stringify({ modes: ["stock", "prices"] }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.deepEqual(body.modes, ["prices", "stock"]);
  assert.ok(body.runId);
});

test("daily cron quick-acks accepted run", async () => {
  const response = await cronGet(
    new Request("https://example.test/api/cron/daily-sync", {
      headers: { "x-api-key": "secret" },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.deepEqual(body.modes, ["prices", "stock"]);
});

test("production daily cron accepts Vercel CRON_SECRET bearer auth before sync config checks", async () => {
  process.env.VERCEL_ENV = "production";
  process.env.CRON_SECRET = "cron-secret";

  const response = await cronGet(
    new Request("https://example.test/api/cron/daily-sync", {
      headers: { authorization: "Bearer cron-secret" },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "redis_required");
});

test("production cron rejects legacy cron header when CRON_SECRET is configured", async () => {
  process.env.VERCEL_ENV = "production";
  process.env.CRON_SECRET = "cron-secret";

  const response = await cronGet(
    new Request("https://example.test/api/cron/daily-sync", {
      headers: { "x-vercel-cron": "1" },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.message, "Unauthorized");
});

test("production reconcile cron accepts Vercel CRON_SECRET bearer auth before sync config checks", async () => {
  process.env.VERCEL_ENV = "production";
  process.env.CRON_SECRET = "cron-secret";

  const response = await reconcileCronGet(
    new Request("https://example.test/api/cron/reconcile-sync", {
      headers: { authorization: "Bearer cron-secret" },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "redis_required");
});
