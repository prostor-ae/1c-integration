import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { continueSyncRun } from "../src/app/lib/sync";
import { canonicalizeModes } from "../src/app/lib/sync-types";
import {
  __resetMemorySyncStateForTests,
  acquireSyncLock,
  createSyncRun,
  getSyncRun,
  isMissingRedisConfig,
  releaseSyncLock,
  saveSyncRun,
} from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  Object.assign(process.env, { NODE_ENV: "test" });
  __resetMemorySyncStateForTests();
});

test("canonicalizeModes preserves costs -> prices -> stock subset order", () => {
  assert.deepEqual(canonicalizeModes(["stock", "costs"]), ["costs", "stock"]);
  assert.deepEqual(canonicalizeModes(["stock", "prices"]), ["prices", "stock"]);
});

test("createSyncRun returns existing active run instead of starting parallel run", async () => {
  const first = await createSyncRun({
    modes: ["stock", "prices"],
    source: "manual",
  });
  const second = await createSyncRun({ modes: ["costs"], source: "manual" });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.status, "already_running");
  assert.equal(second.runId, first.runId);
});

test("target switch preserves legacy active run idempotency", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_FORCE_TEST = "false";

  const first = await createSyncRun({ modes: ["stock"], source: "manual" });

  delete process.env.SHOPIFY_FORCE_TEST;
  const second = await createSyncRun({ modes: ["costs"], source: "manual" });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.status, "already_running");
  assert.equal(second.runId, first.runId);
});

test("production target switch preserves open test run idempotency", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";

  const first = await createSyncRun({ modes: ["stock"], source: "manual" });

  process.env.SHOPIFY_TARGET = "production";
  const second = await createSyncRun({ modes: ["costs"], source: "manual" });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.status, "already_running");
  assert.equal(second.runId, first.runId);
});

test("explicit test target without test domain fails closed before creating sync state", async () => {
  process.env.SHOPIFY_TARGET = "test";
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;

  await assert.rejects(
    () => createSyncRun({ modes: ["stock"], source: "manual" }),
    /Missing SHOPIFY_STORE_DOMAIN_TEST/,
  );
});

test("target switch can continue legacy-store runs without lock mismatch", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_FORCE_TEST = "false";

  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "queued";
  run.currentIndex = run.requestedModes.length;
  run.currentMode = null;
  await saveSyncRun(run);

  delete process.env.SHOPIFY_FORCE_TEST;
  const continued = await continueSyncRun(accepted.runId, "manual");

  assert.equal(continued?.status, "completed");
  assert.equal(continued?.storeId, "prod-shop.myshopify.com");
});

test("memory lock is first-writer-wins", async () => {
  const firstToken = await acquireSyncLock("shop-a");
  const secondToken = await acquireSyncLock("shop-a");

  assert.ok(firstToken);
  assert.equal(secondToken, null);

  await releaseSyncLock(firstToken!, "shop-a");
  assert.ok(await acquireSyncLock("shop-a"));
});

test("later lock owners can save runs after a prior owner releases", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });

  const firstToken = await acquireSyncLock();
  assert.ok(firstToken);
  const firstRun = await getSyncRun(accepted.runId);
  assert.ok(firstRun);
  firstRun.status = "running";
  await saveSyncRun(firstRun, firstToken!);
  await releaseSyncLock(firstToken!);

  const secondToken = await acquireSyncLock();
  assert.ok(secondToken);
  const secondRun = await getSyncRun(accepted.runId);
  assert.ok(secondRun);
  secondRun.status = "queued";
  await saveSyncRun(secondRun, secondToken!);
  await releaseSyncLock(secondToken!);

  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "queued");
  assert.equal(saved?.fencingToken, secondToken);
});

test("released fencing tokens cannot save a sync run", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const token = await acquireSyncLock();
  assert.ok(token);
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  await releaseSyncLock(token!);

  await assert.rejects(
    () => saveSyncRun(run, token!),
    new RegExp(`fencing token mismatch for sync run ${accepted.runId}`),
  );
});

test("production without REDIS_URL fails closed", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.VERCEL_ENV = "production";

  await assert.rejects(
    () => createSyncRun({ modes: ["stock"], source: "manual" }),
    (error) => isMissingRedisConfig(error),
  );
});
