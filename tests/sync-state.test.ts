import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  buildPriceUpdateTargetFromOneC,
  continueSyncRun,
} from "../src/app/lib/sync";
import { canonicalizeModes } from "../src/app/lib/sync-types";
import {
  __resetMemorySyncStateForTests,
  __expireMemorySyncLockForTests,
  __setRedisClientForTests,
  acquireSyncLock,
  adoptStrandedLaunchFence,
  associateBulkOperationAtomically,
  createSyncRun,
  deleteBulkQuarantine,
  failPendingNextContinuationIfCurrent,
  getBulkLaunchFence,
  getBulkQuarantine,
  getDiffChunk,
  getInputSnapshot,
  getLaunchIntent,
  getModeCheckpoint,
  getSyncRun,
  isMissingRedisConfig,
  releaseSyncLock,
  markLaunchRequestedWithFence,
  updateBulkLaunchFenceKnownOperation,
  saveBulkQuarantine,
  saveBulkQuarantineIfCurrent,
  saveDiffChunk,
  saveInputSnapshotIfAbsent,
  saveLaunchIntent,
  saveModeCheckpoint,
  savePendingNextContinuation,
  saveSyncRun,
} from "../src/app/lib/sync-state";

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  delete process.env.INTERNAL_API_KEY;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.SYNC_ARTIFACT_PREVIOUS_KEYS;
  Object.assign(process.env, { NODE_ENV: "test" });
  __resetMemorySyncStateForTests();
  __setRedisClientForTests(null);
});

test("canonicalizeModes preserves costs -> prices -> stock subset order", () => {
  assert.deepEqual(canonicalizeModes(["stock", "costs"]), ["costs", "stock"]);
  assert.deepEqual(canonicalizeModes(["stock", "prices"]), ["prices", "stock"]);
});

test("price sync target uses 1C prices as final price and discounts as compare-at price", () => {
  assert.deepEqual(
    buildPriceUpdateTargetFromOneC({
      priceRaw: 5.6,
      compareAtRaw: 7,
      weightKg: null,
    }),
    { price: "5.60", compareAtPrice: "7.00" },
  );

  assert.deepEqual(
    buildPriceUpdateTargetFromOneC({
      priceRaw: 20,
      compareAtRaw: undefined,
      weightKg: null,
    }),
    { price: "20.00", compareAtPrice: null },
  );

  assert.deepEqual(
    buildPriceUpdateTargetFromOneC({
      priceRaw: 20,
      compareAtRaw: 20,
      weightKg: null,
    }),
    { price: "20.00", compareAtPrice: null },
  );

  assert.deepEqual(
    buildPriceUpdateTargetFromOneC({
      priceRaw: 20,
      compareAtRaw: 30,
      weightKg: 0.5,
    }),
    { price: "10.00", compareAtPrice: "15.00" },
  );

  assert.equal(
    buildPriceUpdateTargetFromOneC({
      priceRaw: 0,
      compareAtRaw: 30,
      weightKg: null,
    }),
    null,
  );
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

test("concurrent createSyncRun calls admit exactly one open run", async () => {
  const results = await Promise.all([
    createSyncRun({ modes: ["prices"], source: "manual" }),
    createSyncRun({ modes: ["stock"], source: "cron" }),
  ]);

  const accepted = results.filter((result) => result.accepted);
  const rejected = results.filter((result) => !result.accepted);

  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.status, "already_running");
  assert.equal(rejected[0]?.runId, accepted[0]?.runId);
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

test("canonical admission rejects quarantine stored under a configured alias", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_TARGET = "test";
  await saveBulkQuarantine({ schemaVersion: 1, storeId: "prod-shop.myshopify.com",
    runId: "legacy-run", mode: "prices", quarantineToken: "legacy-token",
    manifestHash: "a".repeat(64), clientIdentifier: "legacy-client", knownOperationId: null,
    status: "ambiguous_launch", reason: "ambiguous", launchRequestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), noActiveCheckTimestamps: [] });
  const result = await createSyncRun({ modes: ["stock"], source: "manual" });
  assert.equal(result.status, "quarantined");
  assert.equal(result.runId, "legacy-run");
});

test("canonical admission rejects a launch fence stored under a configured alias", async () => {
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_TARGET = "production";
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock("prod-shop.myshopify.com"); const run = await getSyncRun(accepted.runId);
  assert.ok(token && run); run.status = "running"; await saveSyncRun(run, token!);
  await markLaunchRequestedWithFence({ schemaVersion: 1, version: 1, runId: run.runId,
    mode: "prices", manifestHash: "b".repeat(64), proposedCount: 1, byteLength: 1,
    clientIdentifier: "alias-fence", stagedUploadIdentity: "upload", stagedUploadAttempt: 1,
    uploadedAt: new Date().toISOString(), phase: "launch_requested", launchRequestedAt: new Date().toISOString(),
    operationId: null, failureReason: null }, run.storeId, token!, run.version, run.currentIndex);
  await releaseSyncLock(token!, run.storeId);
  process.env.SHOPIFY_TARGET = "test";
  const rejected = await createSyncRun({ modes: ["stock"], source: "manual" });
  assert.equal(rejected.status, "quarantined"); assert.equal(rejected.runId, run.runId);
});

test("pending continuation failure applies only to the exact durable snapshot", async () => {
  const accepted = await createSyncRun({ modes: ["prices", "stock"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "queued"; run.currentIndex = 1; run.currentMode = "stock";
  await saveSyncRun(run, token!); await releaseSyncLock(token!);
  const current = await getSyncRun(run.runId); assert.ok(current);
  const pending = { opId: "completed-op", runId: current.runId, currentIndex: 1,
    currentMode: "stock" as const, runVersion: current.version, state: "pending" as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    qstashCorrelationId: null, qstashMessageId: null };
  await savePendingNextContinuation(pending);
  assert.equal(await failPendingNextContinuationIfCurrent({ expected: pending, reason: "enqueue failed" }), "applied");
  assert.equal((await getSyncRun(run.runId))?.status, "failed");
  const stale = { ...pending, opId: "stale-op" }; await savePendingNextContinuation(stale);
  assert.equal(await failPendingNextContinuationIfCurrent({ expected: stale, reason: "stale" }), "stale");
  assert.equal((await getSyncRun(run.runId))?.failureReason, "enqueue failed");
});

test("conditional failure rejects hidden concurrent identity changes", async () => {
  for (const mismatch of ["version", "state", "correlation", "message"] as const) {
    __resetMemorySyncStateForTests();
    const accepted = await createSyncRun({ modes: ["prices", "stock"], source: "manual" });
    const token = await acquireSyncLock(); const run = await getSyncRun(accepted.runId); assert.ok(token && run);
    run.status = "queued"; run.currentIndex = 1; run.currentMode = "stock";
    await saveSyncRun(run, token!); await releaseSyncLock(token!);
    const current = await getSyncRun(run.runId); assert.ok(current);
    const expected = { opId: "op", runId: current.runId, currentIndex: 1, currentMode: "stock" as const,
      runVersion: current.version, state: "pending" as const, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), qstashCorrelationId: null, qstashMessageId: null };
    if (mismatch === "version") {
      const nextToken = await acquireSyncLock(); const newer = await getSyncRun(run.runId); assert.ok(nextToken && newer);
      await saveSyncRun(newer, nextToken!); await releaseSyncLock(nextToken!); await savePendingNextContinuation(expected);
    } else {
      await savePendingNextContinuation({ ...expected,
        state: mismatch === "state" ? "enqueued" : expected.state,
        qstashCorrelationId: mismatch === "correlation" ? "new-correlation" : null,
        qstashMessageId: mismatch === "message" ? "new-message" : null });
    }
    assert.equal(await failPendingNextContinuationIfCurrent({ expected, reason: "stale" }), "stale");
    assert.notEqual((await getSyncRun(run.runId))?.status, "failed");
  }
});

test("Redis admission checks every alias blocker and bounds the launch fence TTL", async () => {
  const values = new Map<string, string>();
  const calls: Array<{ kind: string; key?: string; options?: any; script?: string; keys?: string[] }> = [];
  const fake: any = {
    isOpen: true, connect: async () => {}, on: () => {},
    get: async (key: string) => values.get(key) ?? null,
    persist: async (key: string) => { calls.push({ kind: "persist", key }); return 1; },
    del: async (key: string) => { values.delete(key); return 1; },
    set: async (key: string, value: string, options?: any) => {
      calls.push({ kind: "set", key, options });
      if (options?.NX && values.has(key)) return null;
      values.set(key, value); return "OK";
    },
    eval: async (script: string, input: { keys: string[]; arguments: string[] }) => {
      calls.push({ kind: "eval", script, keys: input.keys });
      if (script.includes("status = 'accepted'")) {
        for (const key of input.keys) {
          const raw = values.get(key);
          if (raw && (key.includes("bulk-quarantine") || key.includes("bulk-launch-fence"))) {
            return JSON.stringify({ status: "quarantined", runId: JSON.parse(raw).runId });
          }
        }
        const runKeyIndex = Number(input.arguments[6]) - 1;
        values.set(input.keys[runKeyIndex], input.arguments[1]);
        return JSON.stringify({ status: "accepted" });
      }
      if (script.includes("current.quarantineToken")) return 1;
      return 1;
    },
  };
  process.env.REDIS_URL = "redis://fake";
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_TARGET = "test";
  __setRedisClientForTests(fake);
  values.set("sync:bulk-launch-fence:prod-shop.myshopify.com", JSON.stringify({ runId: "fenced-alias" }));
  const rejected = await createSyncRun({ modes: ["prices"], source: "manual" });
  assert.equal(rejected.status, "quarantined"); assert.equal(rejected.runId, "fenced-alias");
  const admission = calls.find((call) => call.script?.includes("status = 'accepted'"))!;
  assert.ok(admission.keys!.includes("sync:bulk-quarantine:prod-shop.myshopify.com"));
  assert.ok(admission.keys!.includes("sync:bulk-quarantine:test-shop.myshopify.com"));
  assert.ok(admission.keys!.includes("sync:bulk-launch-fence:prod-shop.myshopify.com"));
  assert.ok(admission.keys!.includes("sync:bulk-launch-fence:test-shop.myshopify.com"));

  values.delete("sync:bulk-launch-fence:prod-shop.myshopify.com");
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock(); const run = await getSyncRun(accepted.runId); assert.ok(token && run);
  run.status = "running"; await saveSyncRun(run, token!);
  const intent = { schemaVersion: 1 as const, version: 1, runId: run.runId, mode: "prices" as const,
    manifestHash: "e".repeat(64), proposedCount: 1, byteLength: 1, clientIdentifier: "redis-fence",
    stagedUploadIdentity: "upload", stagedUploadAttempt: 1, uploadedAt: new Date().toISOString(),
    phase: "launch_requested" as const, launchRequestedAt: new Date().toISOString(), operationId: null, failureReason: null };
  await markLaunchRequestedWithFence(intent, run.storeId, token!, run.version, run.currentIndex);
  await updateBulkLaunchFenceKnownOperation(run.storeId, run.runId, "operation-id");
  // The fence is bounded rather than immortal: an unbounded fence can block every
  // future run with no recovery path. Rewrites must keep that TTL, not drop it.
  assert.ok(calls.some((call) =>
    /redis\.call\('SET', KEYS\[4\], ARGV\[7\], 'EX', ARGV\[11\]\)/.test(call.script ?? "")));
  assert.ok(calls.filter((call) => call.script?.includes("cjson.encode(fence)")).every((call) =>
    /cjson\.encode\(fence\), 'KEEPTTL'\)/.test(call.script!)));

  const quarantine = { schemaVersion: 1 as const, storeId: "test-shop.myshopify.com", runId: "q-run",
    mode: "prices" as const, quarantineToken: "q-token", manifestHash: "c".repeat(64),
    clientIdentifier: "client", knownOperationId: null, status: "ambiguous_launch" as const,
    reason: "ambiguous", launchRequestedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [] };
  await saveBulkQuarantine(quarantine);
  await saveBulkQuarantineIfCurrent(quarantine, "q-run", "q-token");
  await saveLaunchIntent({ schemaVersion: 1, version: 1, runId: "q-run", mode: "prices",
    manifestHash: "d".repeat(64), proposedCount: 1, byteLength: 1, clientIdentifier: "client",
    stagedUploadIdentity: "upload", stagedUploadAttempt: 1, uploadedAt: null, phase: "prepared",
    launchRequestedAt: null, operationId: null, failureReason: null });
  const blockerSet = calls.filter((call) => call.kind === "set" && call.key?.includes("bulk-quarantine"));
  assert.ok(blockerSet.every((call) => !call.options?.EX && !call.options?.PX && !call.options?.EXAT && !call.options?.PXAT));
  assert.ok(calls.some((call) => call.kind === "set" && call.key?.includes("launch:") && call.options?.EX));
  __setRedisClientForTests(null);
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

test("stale owner release cannot delete a replacement lock after expiry", async () => {
  const ownerA = await acquireSyncLock("shop-aba");
  assert.ok(ownerA);
  __expireMemorySyncLockForTests();
  const ownerB = await acquireSyncLock("shop-aba");
  assert.ok(ownerB);
  assert.notEqual(ownerA, ownerB);

  await releaseSyncLock(ownerA!, "shop-aba");
  assert.equal(await acquireSyncLock("shop-aba"), null);

  await releaseSyncLock(ownerB!, "shop-aba");
  assert.ok(await acquireSyncLock("shop-aba"));
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

test("adaptive artifacts preserve immutable inputs and idempotent chunks", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const snapshot = {
    schemaVersion: 1 as const,
    inputVersion: 1 as const,
    mode: "prices" as const,
    createdAt: new Date().toISOString(),
    payload: { prices: { B1: 10 }, discounts: { B1: 0 } },
  };
  assert.equal(await saveInputSnapshotIfAbsent(accepted.runId, snapshot), true);
  assert.equal(
    await saveInputSnapshotIfAbsent(accepted.runId, {
      ...snapshot,
      payload: { prices: { B1: 99 }, discounts: {} },
    }),
    false,
  );
  assert.deepEqual((await getInputSnapshot(accepted.runId, "prices"))?.payload, snapshot.payload);

  await saveDiffChunk(accepted.runId, "prices", 0, [{ id: "first" }]);
  const chunkMetadata = await saveDiffChunk(accepted.runId, "prices", 0, [{ id: "replacement" }]);
  assert.deepEqual(await getDiffChunk(accepted.runId, "prices", 0), [
    { id: "replacement" },
  ]);

  await saveModeCheckpoint({
    schemaVersion: 1,
    runId: accepted.runId,
    mode: "prices",
    currentIndex: 0,
    sequence: 1,
    phase: "scanning",
    cursor: "enc:v1:not-actually-sealed",
    inputSnapshotKey: `sync:input:${accepted.runId}:prices`,
    diffChunkSequences: [0],
    diffChunks: [chunkMetadata],
    pageCount: 1,
    productCount: 1,
    variantCount: 1,
    counters: { proposed: 1 },
    continuationState: "needed",
    continuationIdentity: null,
    updatedAt: new Date().toISOString(),
  });
  assert.equal((await getModeCheckpoint(accepted.runId, "prices"))?.cursor, "enc:v1:not-actually-sealed");
});

test("sealed artifacts survive rotation while the optional previous-key ring remains configured", async () => {
  process.env.INTERNAL_API_KEY = "old-key";
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const snapshot = {
    schemaVersion: 1 as const,
    inputVersion: 1 as const,
    mode: "stock" as const,
    createdAt: new Date().toISOString(),
    payload: { stock: { B1: 1 } },
  };
  await saveInputSnapshotIfAbsent(accepted.runId, snapshot);
  process.env.INTERNAL_API_KEY = "new-key";
  process.env.SYNC_ARTIFACT_PREVIOUS_KEYS = "old-key";
  assert.deepEqual((await getInputSnapshot(accepted.runId, "stock"))?.payload, snapshot.payload);
});

test("bulk operation association is all-or-zero under the run fence", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  assert.ok(token);
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const intent = {
    schemaVersion: 1 as const,
    version: 1,
    runId: accepted.runId,
    mode: "prices" as const,
    manifestHash: "a".repeat(64),
    proposedCount: 2,
    byteLength: 100,
    clientIdentifier: "sync-client",
    stagedUploadIdentity: `${"a".repeat(64)}:1`,
    stagedUploadAttempt: 1,
    uploadedAt: new Date().toISOString(),
    phase: "launch_requested" as const,
    launchRequestedAt: new Date().toISOString(),
    operationId: null,
    failureReason: null,
  };
  await saveLaunchIntent(intent);

  assert.equal(
    await associateBulkOperationAtomically({
      runId: accepted.runId,
      mode: "prices",
      operationId: "gid://shopify/BulkOperation/1",
      proposedCount: 2,
      expectedRunVersion: run.version,
      expectedCurrentIndex: run.currentIndex,
      expectedIntentVersion: intent.version,
      expectedManifestHash: intent.manifestHash,
      fencingToken: "wrong-token",
    }),
    false,
  );
  assert.equal((await getSyncRun(accepted.runId))?.status, "running");
  assert.equal((await getLaunchIntent(accepted.runId, "prices"))?.phase, "launch_requested");

  assert.equal(
    await associateBulkOperationAtomically({
      runId: accepted.runId,
      mode: "prices",
      operationId: "gid://shopify/BulkOperation/1",
      proposedCount: 2,
      expectedRunVersion: run.version,
      expectedCurrentIndex: run.currentIndex + 1,
      expectedIntentVersion: intent.version,
      expectedManifestHash: intent.manifestHash,
      fencingToken: token!,
    }),
    false,
  );
  assert.equal((await getSyncRun(accepted.runId))?.status, "running");
  assert.equal((await getLaunchIntent(accepted.runId, "prices"))?.phase, "launch_requested");

  assert.equal(
    await associateBulkOperationAtomically({
      runId: accepted.runId,
      mode: "prices",
      operationId: "gid://shopify/BulkOperation/1",
      proposedCount: 2,
      expectedRunVersion: run.version,
      expectedCurrentIndex: run.currentIndex,
      expectedIntentVersion: intent.version,
      expectedManifestHash: intent.manifestHash,
      fencingToken: token!,
    }),
    true,
  );
  assert.equal((await getSyncRun(accepted.runId))?.status, "waiting_bulk");
  assert.equal((await getLaunchIntent(accepted.runId, "prices"))?.phase, "associated");
  await releaseSyncLock(token!);
});

test("launch-request fencing atomically rejects stale run state and an existing quarantine", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  assert.ok(token);
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const intent = {
    schemaVersion: 1 as const,
    version: 3,
    runId: run.runId,
    mode: "prices" as const,
    manifestHash: "b".repeat(64),
    proposedCount: 1,
    byteLength: 10,
    clientIdentifier: "sync-cas",
    stagedUploadIdentity: "upload:1",
    stagedUploadAttempt: 1,
    uploadedAt: new Date().toISOString(),
    phase: "launch_requested" as const,
    launchRequestedAt: new Date().toISOString(),
    operationId: null,
    failureReason: null,
  };
  await assert.rejects(
    markLaunchRequestedWithFence(intent, run.storeId, token!, run.version - 1, run.currentIndex),
    /preconditions changed/,
  );
  await saveBulkQuarantine({
    schemaVersion: 1,
    storeId: run.storeId,
    runId: "other-run",
    mode: "stock",
    quarantineToken: "other-token",
    manifestHash: "c".repeat(64),
    clientIdentifier: "other-client",
    knownOperationId: null,
    status: "ambiguous_launch",
    reason: "ambiguous",
    launchRequestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [],
  });
  await assert.rejects(
    markLaunchRequestedWithFence(intent, run.storeId, token!, run.version, run.currentIndex),
    /preconditions changed/,
  );
  assert.equal(await getBulkLaunchFence(run.storeId), null);
  await releaseSyncLock(token!);
});

test("a launch fence stranded without a quarantine is adopted into a clearable one", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const launchRequestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await markLaunchRequestedWithFence(
    {
      schemaVersion: 1, version: 1, runId: run.runId, mode: "prices",
      manifestHash: "a".repeat(64), proposedCount: 1, byteLength: 10,
      clientIdentifier: "sync-stranded", stagedUploadIdentity: "upload:1",
      stagedUploadAttempt: 1, uploadedAt: launchRequestedAt,
      phase: "launch_requested", launchRequestedAt, operationId: null, failureReason: null,
    },
    run.storeId, token!, run.version, run.currentIndex,
  );
  await updateBulkLaunchFenceKnownOperation(run.storeId, run.runId, "gid://bulk/1");
  await releaseSyncLock(token!);

  // The invocation died here: a fence exists, no quarantine was ever written.
  assert.equal(await getBulkQuarantine(run.storeId), null);
  assert.equal(
    (await createSyncRun({ modes: ["prices"], source: "cron" })).status,
    "quarantined",
  );

  const adopted = await adoptStrandedLaunchFence([run.storeId]);
  assert.ok(adopted);
  assert.equal(adopted!.runId, run.runId);
  assert.equal(adopted!.knownOperationId, "gid://bulk/1");
  assert.equal(adopted!.manifestHash, "a".repeat(64));
  // Inheriting the fence's timestamp keeps the reconciler's minimum age honest.
  assert.equal(adopted!.createdAt, launchRequestedAt);
  assert.equal(adopted!.launchRequestedAt, launchRequestedAt);
  assert.deepEqual(adopted!.noActiveCheckTimestamps, []);
  assert.ok(adopted!.quarantineToken.length >= 16);

  // Adoption is idempotent and the adopted token now clears both records.
  assert.equal(await adoptStrandedLaunchFence([run.storeId]), null);
  assert.equal(
    (await getBulkQuarantine(run.storeId))?.quarantineToken,
    adopted!.quarantineToken,
  );
  assert.equal(
    await deleteBulkQuarantine(run.storeId, run.runId, adopted!.quarantineToken),
    true,
  );
  assert.equal(await getBulkLaunchFence(run.storeId), null);
  assert.equal(await getBulkQuarantine(run.storeId), null);
  // Admission is no longer blocked by the fence (the original run is still open,
  // so it now falls through to the ordinary already_running path).
  assert.equal(
    (await createSyncRun({ modes: ["prices"], source: "cron" })).status,
    "already_running",
  );
});

test("fence adoption never overwrites an existing quarantine", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "running";
  await saveSyncRun(run, token!);
  await markLaunchRequestedWithFence(
    {
      schemaVersion: 1, version: 1, runId: run.runId, mode: "prices",
      manifestHash: "b".repeat(64), proposedCount: 1, byteLength: 10,
      clientIdentifier: "sync-existing", stagedUploadIdentity: "upload:1",
      stagedUploadAttempt: 1, uploadedAt: new Date().toISOString(),
      phase: "launch_requested", launchRequestedAt: new Date().toISOString(),
      operationId: null, failureReason: null,
    },
    run.storeId, token!, run.version, run.currentIndex,
  );
  await releaseSyncLock(token!);
  await saveBulkQuarantine({
    schemaVersion: 1, storeId: run.storeId, runId: run.runId, mode: "prices",
    quarantineToken: "already-owned-token", manifestHash: "b".repeat(64),
    clientIdentifier: "sync-existing", knownOperationId: null,
    status: "ambiguous_launch", reason: "ambiguous",
    launchRequestedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [],
  });

  assert.equal(await adoptStrandedLaunchFence([run.storeId]), null);
  assert.equal(
    (await getBulkQuarantine(run.storeId))?.quarantineToken,
    "already-owned-token",
  );
});

test("quarantine deletion is run/token conditioned and never deletes another run's fence", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  assert.ok(token);
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const intent = {
    schemaVersion: 1 as const, version: 1, runId: run.runId, mode: "prices" as const,
    manifestHash: "d".repeat(64), proposedCount: 1, byteLength: 10,
    clientIdentifier: "sync-owner", stagedUploadIdentity: "upload:1", stagedUploadAttempt: 1,
    uploadedAt: new Date().toISOString(), phase: "launch_requested" as const,
    launchRequestedAt: new Date().toISOString(), operationId: null, failureReason: null,
  };
  await markLaunchRequestedWithFence(intent, run.storeId, token!, run.version, run.currentIndex);
  await saveBulkQuarantine({
    schemaVersion: 1, storeId: run.storeId, runId: "other-run", mode: "stock",
    quarantineToken: "other-token", manifestHash: "e".repeat(64), clientIdentifier: "other",
    knownOperationId: null, status: "ambiguous_launch", reason: "ambiguous",
    launchRequestedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [],
  });
  assert.equal(await deleteBulkQuarantine(run.storeId, "other-run", "wrong-token"), false);
  assert.equal((await getBulkQuarantine(run.storeId))?.runId, "other-run");
  assert.equal((await getBulkLaunchFence(run.storeId))?.runId, run.runId);
  assert.equal(await deleteBulkQuarantine(run.storeId, "wrong-run", "other-token"), false);
  assert.equal(await deleteBulkQuarantine(run.storeId, "other-run", "other-token"), true);
  assert.equal((await getBulkLaunchFence(run.storeId))?.runId, run.runId);
  assert.equal(await getBulkQuarantine(run.storeId), null);
  await releaseSyncLock(token!);
});
