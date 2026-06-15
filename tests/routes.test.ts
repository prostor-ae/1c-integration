import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as triggerPost } from "../src/app/api/sync/trigger/route";
import { GET as statusGet } from "../src/app/api/sync/status/route";
import { GET as cronGet } from "../src/app/api/cron/daily-sync/route";
import { GET as reconcileCronGet } from "../src/app/api/cron/reconcile-sync/route";
import {
  __resetMemorySyncStateForTests,
  createSyncRun,
  getSyncRun,
  saveSyncRun,
} from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.CRON_SECRET;
  Object.assign(process.env, { NODE_ENV: "test" });
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

test("sync status endpoint rejects missing API key", async () => {
  const response = await statusGet(
    new Request("https://example.test/api/sync/status?runId=run-1"),
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.message, "Unauthorized");
});

test("sync status endpoint returns idle status when no runs exist", async () => {
  const response = await statusGet(
    new Request("https://example.test/api/sync/status", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.running, false);
  assert.equal(body.run, null);
});

test("sync status endpoint returns 404 for unknown run", async () => {
  const response = await statusGet(
    new Request("https://example.test/api/sync/status?runId=missing", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, "sync_run_not_found");
  assert.equal(body.runId, "missing");
});

test("sync status endpoint returns sanitized run state", async () => {
  const triggerResponse = await triggerPost(
    new Request("https://example.test/api/sync/trigger", {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body: JSON.stringify({ modes: ["stock", "prices"] }),
    }),
  );
  const triggerBody = await triggerResponse.json();

  const response = await statusGet(
    new Request(
      `https://example.test/api/sync/status?runId=${triggerBody.runId}`,
      { headers: { "x-api-key": "secret" } },
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.running, true);
  assert.equal(body.run.runId, triggerBody.runId);
  assert.equal(body.run.status, "queued");
  assert.deepEqual(body.run.requestedModes, ["prices", "stock"]);
  assert.equal(body.run.currentMode, "prices");
  assert.equal("storeId" in body.run, false);
  assert.equal("version" in body.run, false);
  assert.equal("fencingToken" in body.run, false);
  assert.equal("lockUntil" in body.run, false);
});

test("sync status endpoint defaults to the active run without runId", async () => {
  const triggerResponse = await triggerPost(
    new Request("https://example.test/api/sync/trigger", {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body: JSON.stringify({ modes: ["stock"] }),
    }),
  );
  const triggerBody = await triggerResponse.json();

  const response = await statusGet(
    new Request("https://example.test/api/sync/status", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.running, true);
  assert.equal(body.run.runId, triggerBody.runId);
  assert.equal(body.run.status, "queued");
});

test("sync status endpoint defaults to the latest run when nothing is active", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "completed";
  run.currentMode = null;
  run.currentIndex = run.requestedModes.length;
  run.completedAt = new Date().toISOString();
  await saveSyncRun(run);

  const response = await statusGet(
    new Request("https://example.test/api/sync/status", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.running, false);
  assert.equal(body.run.runId, accepted.runId);
  assert.equal(body.run.status, "completed");
});

test("sync status endpoint returns the newest completed run without runId", async () => {
  const first = await createSyncRun({ modes: ["stock"], source: "manual" });
  const firstRun = await getSyncRun(first.runId);
  assert.ok(firstRun);
  firstRun.createdAt = "2026-01-01T00:00:00.000Z";
  firstRun.status = "completed";
  firstRun.currentMode = null;
  firstRun.currentIndex = firstRun.requestedModes.length;
  firstRun.completedAt = new Date().toISOString();
  await saveSyncRun(firstRun);

  const second = await createSyncRun({ modes: ["prices"], source: "cron" });
  const secondRun = await getSyncRun(second.runId);
  assert.ok(secondRun);
  secondRun.createdAt = "2026-01-02T00:00:00.000Z";
  secondRun.status = "completed";
  secondRun.currentMode = null;
  secondRun.currentIndex = secondRun.requestedModes.length;
  secondRun.completedAt = new Date().toISOString();
  await saveSyncRun(secondRun);

  const response = await statusGet(
    new Request("https://example.test/api/sync/status", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.running, false);
  assert.equal(body.run.runId, second.runId);
  assert.equal(body.run.source, "cron");
  assert.deepEqual(body.run.requestedModes, ["prices"]);
});

test("sync status endpoint redacts sensitive failure details", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "failed";
  run.failureReason =
    "Fetch https://user:pass@example.test/path?token=secret failed with Authorization: Bearer abc123 and X-Shopify-Access-Token: shpat_12345";
  await saveSyncRun(run);

  const response = await statusGet(
    new Request(
      `https://example.test/api/sync/status?runId=${accepted.runId}`,
      { headers: { "x-api-key": "secret" } },
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(body.run.failureReason, /example\.test\/path/);
  assert.doesNotMatch(body.run.failureReason, /user:pass|abc123|secret|shpat_12345/);
  assert.match(body.run.failureReason, /\[redacted\]/);
});

test("production sync status endpoint fails closed without Redis", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.VERCEL_ENV = "production";

  const response = await statusGet(
    new Request("https://example.test/api/sync/status", {
      headers: { "x-api-key": "secret" },
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "redis_required");
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
