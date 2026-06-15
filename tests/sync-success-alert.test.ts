import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { buildSyncSuccessAlert } from "../src/app/lib/alerts";
import {
  continueSyncRun,
  handleBulkOperationFinished,
} from "../src/app/lib/sync";
import {
  __resetMemorySyncStateForTests,
  createSyncRun,
  getSyncRun,
  saveSyncRun,
  type SyncRun,
} from "../src/app/lib/sync-state";

function captureAlertSubjects() {
  const subjects: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    try {
      const parsed = JSON.parse(String(message));
      if (parsed.event === "alert_send_failed") {
        subjects.push(String(parsed.subject ?? ""));
      }
    } catch {
      // Ignore non-JSON console errors from unrelated code.
    }
  };
  return {
    subjects,
    restore: () => {
      console.error = originalError;
    },
  };
}

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.RESEND_API_KEY;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.DISABLE_SYNC_KICKOFF = "1";
  __resetMemorySyncStateForTests();
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

test("success alert formatter uses warning subject when completed run has skipped modes", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "completed";
  run.currentMode = null;
  run.completedAt = new Date().toISOString();
  run.skippedByMode.prices = "1C Prices payload empty";

  const alert = buildSyncSuccessAlert({ run });

  assert.match(alert.subject, /Sync completed with warnings/);
  assert.match(alert.body, /1C Prices payload empty/);
  assert.match(alert.body, /Skipped\/warning reasons/);
});

test("final bulk completion sends one success notification and ignores duplicate completion observations", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/1";
  run.activeBulkOperationType = "MUTATION";
  run.proposedByMode.stock = 3;
  run.appliedByMode.stock = 0;
  await saveSyncRun(run);

  const capture = captureAlertSubjects();
  try {
    await handleBulkOperationFinished({
      opId: "gid://shopify/BulkOperation/1",
      status: "COMPLETED",
      errorCode: null,
      source: "shopify-webhook",
    });
    await handleBulkOperationFinished({
      opId: "gid://shopify/BulkOperation/1",
      status: "COMPLETED",
      errorCode: null,
      source: "reconciler",
    });
  } finally {
    capture.restore();
  }

  assert.deepEqual(
    capture.subjects.filter((subject) => subject.includes("Sync completed")),
    ["[1c-integration] Sync completed (stock)"],
  );
  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.appliedByMode.stock, 3);
});

test("failed bulk completion does not send success notification", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/2";
  run.activeBulkOperationType = "MUTATION";
  await saveSyncRun(run);

  const capture = captureAlertSubjects();
  try {
    await handleBulkOperationFinished({
      opId: "gid://shopify/BulkOperation/2",
      status: "FAILED",
      errorCode: "INTERNAL_SERVER_ERROR",
      source: "shopify-webhook",
    });
  } finally {
    capture.restore();
  }

  assert.equal(
    capture.subjects.some((subject) => subject.includes("Sync completed")),
    false,
  );
  assert.equal(
    capture.subjects.some((subject) => subject.includes("Sync failure")),
    true,
  );
});

test("continueSyncRun sends success notification only from a completed transition", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "queued";
  run.currentMode = null;
  run.currentIndex = run.requestedModes.length;
  await saveSyncRun(run);

  const capture = captureAlertSubjects();
  try {
    await continueSyncRun(accepted.runId, "direct");
    await continueSyncRun(accepted.runId, "direct");
  } finally {
    capture.restore();
  }

  assert.deepEqual(
    capture.subjects.filter((subject) => subject.includes("Sync completed")),
    ["[1c-integration] Sync completed (stock)"],
  );
  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "completed");
});

test("waiting bulk continuation noop does not send success notification", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/3";
  run.activeBulkOperationType = "MUTATION";
  await saveSyncRun(run);

  const capture = captureAlertSubjects();
  try {
    await continueSyncRun(accepted.runId, "direct");
  } finally {
    capture.restore();
  }

  assert.equal(
    capture.subjects.some((subject) => subject.includes("Sync completed")),
    false,
  );
});
