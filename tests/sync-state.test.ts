import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { canonicalizeModes } from "../src/app/lib/sync-types";
import {
  __resetMemorySyncStateForTests,
  acquireSyncLock,
  createSyncRun,
  isMissingRedisConfig,
  releaseSyncLock,
} from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = "test";
  __resetMemorySyncStateForTests();
});

test("canonicalizeModes preserves costs -> prices -> stock subset order", () => {
  assert.deepEqual(canonicalizeModes(["stock", "costs"]), ["costs", "stock"]);
  assert.deepEqual(canonicalizeModes(["stock", "prices"]), ["prices", "stock"]);
});

test("createSyncRun returns existing active run instead of starting parallel run", async () => {
  const first = await createSyncRun({ modes: ["stock", "prices"], source: "manual" });
  const second = await createSyncRun({ modes: ["costs"], source: "manual" });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.status, "already_running");
  assert.equal(second.runId, first.runId);
});

test("memory lock is first-writer-wins", async () => {
  const firstToken = await acquireSyncLock("shop-a");
  const secondToken = await acquireSyncLock("shop-a");

  assert.ok(firstToken);
  assert.equal(secondToken, null);

  await releaseSyncLock(firstToken!, "shop-a");
  assert.ok(await acquireSyncLock("shop-a"));
});

test("production without REDIS_URL fails closed", async () => {
  process.env.NODE_ENV = "production";
  process.env.VERCEL_ENV = "production";

  await assert.rejects(
    () => createSyncRun({ modes: ["stock"], source: "manual" }),
    (error) => isMissingRedisConfig(error)
  );
});
