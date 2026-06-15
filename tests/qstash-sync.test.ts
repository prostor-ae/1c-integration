import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as continuationPost } from "../src/app/api/internal/sync/continuation/route";
import { POST as continuationFailurePost } from "../src/app/api/internal/sync/continuation/failure/route";
import {
  __setBulkOperationByIdForTests,
  reconcileSyncRuns,
} from "../src/app/lib/sync";
import {
  __resetQstashSyncForTests,
  __setQstashVerifierForTests,
  __setSyncContinuationPublisherForTests,
  buildSyncContinuationDeduplicationId,
  enqueueSyncContinuation,
  getContinuationRecordForFailureCallback,
  getSyncContinuationConfig,
  type SyncContinuationPublishRequest,
} from "../src/app/lib/qstash-sync";
import {
  __resetMemorySyncStateForTests,
  acquireSyncLock,
  createSyncRun,
  getPendingNextContinuation,
  getSyncRun,
  releaseSyncLock,
  saveSyncRun,
  type SyncRun,
} from "../src/app/lib/sync-state";

let publishedContinuations: SyncContinuationPublishRequest[] = [];

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_URL;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.SYNC_CONTINUATION_BASE_URL = "https://sync.example.test/";
  __resetMemorySyncStateForTests();
  __resetQstashSyncForTests();
  __setBulkOperationByIdForTests(null);
  publishedContinuations = [];
  __setSyncContinuationPublisherForTests(async (request) => {
    publishedContinuations.push(request);
    return {
      messageId: `msg_${publishedContinuations.length}`,
      url: request.url,
    };
  });
  __setQstashVerifierForTests(() => true);
});

test("continue-run dedupe is step-aware", () => {
  const first = buildSyncContinuationDeduplicationId({
    kind: "continue-run",
    runId: "run-1",
    source: "bulk-finish",
    currentIndex: 0,
    currentMode: "prices",
  });
  const second = buildSyncContinuationDeduplicationId({
    kind: "continue-run",
    runId: "run-1",
    source: "bulk-finish",
    currentIndex: 1,
    currentMode: "stock",
  });

  assert.notEqual(first, second);
  assert.match(first, /run-1:0:prices:bulk-finish$/);
  assert.match(second, /run-1:1:stock:bulk-finish$/);
});

test("enqueue uses app base URL, not QSTASH_URL, and stores failure correlation", async () => {
  process.env.QSTASH_URL = "https://qstash-api.example.test";

  const result = await enqueueSyncContinuation({
    kind: "continue-run",
    runId: "run-1",
    source: "manual",
    currentIndex: 0,
    currentMode: "prices",
  });
  const record = await getContinuationRecordForFailureCallback({
    correlationId: result.correlationId,
    messageId: result.messageId,
  });

  assert.equal(publishedContinuations.length, 1);
  assert.equal(
    publishedContinuations[0].url,
    "https://sync.example.test/api/internal/sync/continuation",
  );
  assert.match(
    publishedContinuations[0].failureCallback ?? "",
    /^https:\/\/sync\.example\.test\/api\/internal\/sync\/continuation\/failure\?cid=/,
  );
  assert.equal(record?.messageId, "msg_1");
  assert.deepEqual(record?.payload, publishedContinuations[0].body);
});

test("production config validation fails closed when QStash env is missing", () => {
  Object.assign(process.env, { NODE_ENV: "production" });

  assert.throws(
    () =>
      getSyncContinuationConfig({
        requirePublisher: true,
        requireReceiver: true,
      }),
    /Missing QStash sync continuation config/,
  );
});

test("continuation route rejects invalid production QStash signatures", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.QSTASH_CURRENT_SIGNING_KEY = "current";
  process.env.QSTASH_NEXT_SIGNING_KEY = "next";
  __setQstashVerifierForTests(null);

  const response = await continuationPost(
    new Request("https://sync.example.test/api/internal/sync/continuation", {
      method: "POST",
      headers: { "upstash-signature": "bad" },
      body: JSON.stringify({
        kind: "continue-run",
        runId: "run-1",
        source: "manual",
        currentIndex: 0,
        currentMode: "prices",
      }),
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_qstash_signature");
});

test("continuation route dispatches continue-run at matching cursor", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "queued";
  run.currentMode = null;
  run.currentIndex = run.requestedModes.length;
  await saveSyncRun(run);

  const response = await continuationPost(
    new Request("https://sync.example.test/api/internal/sync/continuation", {
      method: "POST",
      body: JSON.stringify({
        kind: "continue-run",
        runId: accepted.runId,
        source: "manual",
        currentIndex: run.currentIndex,
        currentMode: null,
      }),
    }),
  );
  const saved = await getSyncRun(accepted.runId);

  assert.equal(response.status, 200);
  assert.equal(saved?.status, "completed");
});

test("bulk-finish delivery advances to next mode and enqueues pending continuation", async () => {
  const accepted = await createSyncRun({
    modes: ["prices", "stock"],
    source: "manual",
  });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "prices";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/next";
  run.activeBulkOperationType = "MUTATION";
  run.proposedByMode.prices = 2;
  await saveSyncRun(run);

  const response = await continuationPost(
    new Request("https://sync.example.test/api/internal/sync/continuation", {
      method: "POST",
      body: JSON.stringify({
        kind: "bulk-finish",
        opId: "gid://shopify/BulkOperation/next",
        status: "COMPLETED",
        errorCode: null,
        source: "shopify-webhook",
      }),
    }),
  );
  const body = await response.json();
  const saved = await getSyncRun(accepted.runId);
  const pending = await getPendingNextContinuation(
    "gid://shopify/BulkOperation/next",
  );

  assert.equal(response.status, 200);
  assert.equal(body.nextEnqueued, true);
  assert.equal(saved?.status, "queued");
  assert.equal(saved?.currentMode, "stock");
  assert.equal(pending?.state, "enqueued");
  assert.equal(publishedContinuations.length, 1);
  assert.deepEqual(publishedContinuations[0].body, {
    kind: "continue-run",
    runId: accepted.runId,
    source: "bulk-finish",
    currentIndex: 1,
    currentMode: "stock",
    runVersion: saved?.version,
  });
});

test("reconciler enqueues next mode continuation after missed bulk-finish webhook", async () => {
  const accepted = await createSyncRun({
    modes: ["prices", "stock"],
    source: "manual",
  });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "prices";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/reconcile-next";
  run.activeBulkOperationType = "MUTATION";
  run.proposedByMode.prices = 2;
  await saveSyncRun(run);
  __setBulkOperationByIdForTests(async (id) => ({
    id,
    status: "COMPLETED",
    errorCode: null,
    type: "MUTATION",
    url: null,
    partialDataUrl: null,
  }));

  const result = await reconcileSyncRuns();
  const saved = await getSyncRun(accepted.runId);
  const pending = await getPendingNextContinuation(
    "gid://shopify/BulkOperation/reconcile-next",
  );

  assert.equal(result.changed, 1);
  assert.equal(saved?.status, "queued");
  assert.equal(saved?.currentMode, "stock");
  assert.equal(pending?.state, "enqueued");
  assert.equal(publishedContinuations.length, 1);
  assert.deepEqual(publishedContinuations[0].body, {
    kind: "continue-run",
    runId: accepted.runId,
    source: "bulk-finish",
    currentIndex: 1,
    currentMode: "stock",
    runVersion: saved?.version,
  });
});

test("reconciler marks run failed if next mode continuation enqueue fails after recovery", async () => {
  const accepted = await createSyncRun({
    modes: ["prices", "stock"],
    source: "manual",
  });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "prices";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/reconcile-fail";
  run.activeBulkOperationType = "MUTATION";
  run.proposedByMode.prices = 2;
  await saveSyncRun(run);
  __setBulkOperationByIdForTests(async (id) => ({
    id,
    status: "COMPLETED",
    errorCode: null,
    type: "MUTATION",
    url: null,
    partialDataUrl: null,
  }));
  __setSyncContinuationPublisherForTests(async () => {
    throw new Error("qstash unavailable");
  });

  await assert.rejects(() => reconcileSyncRuns(), /qstash unavailable/);
  const saved = await getSyncRun(accepted.runId);

  assert.equal(saved?.status, "failed");
  assert.match(
    saved?.failureReason ?? "",
    /Failed to enqueue next sync continuation after reconciled bulk operation gid:\/\/shopify\/BulkOperation\/reconcile-fail: qstash unavailable/,
  );
  assert.equal(saved?.activeBulkOperationId, null);
});

test("bulk-finish lock contention returns retryable failure instead of acknowledging", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/busy";
  run.activeBulkOperationType = "MUTATION";
  await saveSyncRun(run);

  const lockToken = await acquireSyncLock();
  assert.ok(lockToken);
  try {
    const response = await continuationPost(
      new Request("https://sync.example.test/api/internal/sync/continuation", {
        method: "POST",
        body: JSON.stringify({
          kind: "bulk-finish",
          opId: "gid://shopify/BulkOperation/busy",
          status: "COMPLETED",
          errorCode: null,
          source: "shopify-webhook",
        }),
      }),
    );
    const body = await response.json();
    const saved = await getSyncRun(accepted.runId);

    assert.equal(response.status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.error, "qstash_continuation_failed");
    assert.equal(saved?.status, "waiting_bulk");
  } finally {
    await releaseSyncLock(lockToken!);
  }
});

test("failure callback resolves correlation record and marks run failed", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const enqueueResult = await enqueueSyncContinuation({
    kind: "continue-run",
    runId: accepted.runId,
    source: "manual",
    currentIndex: 0,
    currentMode: "stock",
  });

  const response = await continuationFailurePost(
    new Request(
      `https://sync.example.test/api/internal/sync/continuation/failure?cid=${enqueueResult.correlationId}`,
      {
        method: "POST",
        body: JSON.stringify({
          status: 500,
          retried: 5,
          maxRetries: 5,
          sourceMessageId: enqueueResult.messageId,
          dlqId: "dlq_1",
        }),
      },
    ),
  );
  const saved = await getSyncRun(accepted.runId);

  assert.equal(response.status, 200);
  assert.equal(saved?.status, "failed");
  assert.match(
    saved?.failureReason ?? "",
    /QStash continuation exhausted for run .* index 0/,
  );
});

test("failure callback includes sanitized response body detail", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const enqueueResult = await enqueueSyncContinuation({
    kind: "continue-run",
    runId: accepted.runId,
    source: "manual",
    currentIndex: 0,
    currentMode: "stock",
  });
  const responseBody = JSON.stringify({
    message: "Shopify retries exhausted after concrete cause",
    url: "https://user:pass@example.test/path?token=abc123",
    authorization: "Bearer secret-token",
    shopifyToken: "shpat_12345",
    access_token: "access-secret",
    api_key: "api-secret",
    client_secret: "client-secret",
  });

  const response = await continuationFailurePost(
    new Request(
      `https://sync.example.test/api/internal/sync/continuation/failure?cid=${enqueueResult.correlationId}`,
      {
        method: "POST",
        body: JSON.stringify({
          status: 500,
          body: Buffer.from(responseBody, "utf8").toString("base64"),
          retried: 5,
          maxRetries: 5,
          sourceMessageId: enqueueResult.messageId,
        }),
      },
    ),
  );
  const saved = await getSyncRun(accepted.runId);
  const reason = saved?.failureReason ?? "";

  assert.equal(response.status, 200);
  assert.match(reason, /responseBody=.*concrete cause/);
  assert.match(reason, /https:\/\/example\.test\/path\?\[redacted\]/);
  assert.doesNotMatch(
    reason,
    /user:pass|abc123|secret-token|shpat_12345|Bearer secret|access-secret|api-secret|client-secret/,
  );
  assert.ok(reason.length < 1000);
});

test("failure callback does not fail an already recovered continue-run", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const enqueueResult = await enqueueSyncContinuation({
    kind: "continue-run",
    runId: accepted.runId,
    source: "manual",
    currentIndex: 0,
    currentMode: "stock",
  });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "completed";
  run.currentIndex = 1;
  run.currentMode = null;
  run.completedAt = new Date().toISOString();
  await saveSyncRun(run);

  const response = await continuationFailurePost(
    new Request(
      `https://sync.example.test/api/internal/sync/continuation/failure?cid=${enqueueResult.correlationId}`,
      {
        method: "POST",
        body: JSON.stringify({
          status: 500,
          retried: 5,
          maxRetries: 5,
          sourceMessageId: enqueueResult.messageId,
        }),
      },
    ),
  );
  const body = await response.json();
  const saved = await getSyncRun(accepted.runId);

  assert.equal(response.status, 200);
  assert.equal(body.outcome, "noop_stale_or_recovered");
  assert.equal(saved?.status, "completed");
});

test("failure callback does not fail an already recovered bulk-finish", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/recovered";
  run.activeBulkOperationType = "MUTATION";
  await saveSyncRun(run);
  const enqueueResult = await enqueueSyncContinuation({
    kind: "bulk-finish",
    opId: "gid://shopify/BulkOperation/recovered",
    status: "COMPLETED",
    errorCode: null,
    source: "shopify-webhook",
  });

  const completed = (await getSyncRun(accepted.runId)) as SyncRun;
  completed.status = "completed";
  completed.currentIndex = 1;
  completed.currentMode = null;
  completed.activeBulkOperationId = null;
  completed.activeBulkOperationType = null;
  completed.completedAt = new Date().toISOString();
  await saveSyncRun(completed);

  const response = await continuationFailurePost(
    new Request(
      `https://sync.example.test/api/internal/sync/continuation/failure?cid=${enqueueResult.correlationId}`,
      {
        method: "POST",
        body: JSON.stringify({
          status: 500,
          retried: 5,
          maxRetries: 5,
          sourceMessageId: enqueueResult.messageId,
        }),
      },
    ),
  );
  const body = await response.json();
  const saved = await getSyncRun(accepted.runId);

  assert.equal(response.status, 200);
  assert.equal(body.outcome, "noop_stale_or_recovered");
  assert.equal(saved?.status, "completed");
});

test("failure callback does not acknowledge missing correlation", async () => {
  const response = await continuationFailurePost(
    new Request(
      "https://sync.example.test/api/internal/sync/continuation/failure?cid=missing",
      {
        method: "POST",
        body: JSON.stringify({
          status: 500,
          retried: 5,
          maxRetries: 5,
          sourceMessageId: "msg_missing",
        }),
      },
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_correlation");
});
