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

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body === "string") return init.body;
  return "";
}

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
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.DISABLE_SYNC_KICKOFF = "1";
  __resetMemorySyncStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.SHOPIFY_TARGET;
  delete process.env.SHOPIFY_FORCE_TEST;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_STORE_DOMAIN_TEST;
  delete process.env.SHOPIFY_ADMIN_TOKEN_TEST;
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

test("cron final bulk completion completes without success notification", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "cron" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "waiting_bulk";
  run.currentMode = "stock";
  run.activeBulkOperationId = "gid://shopify/BulkOperation/cron";
  run.activeBulkOperationType = "MUTATION";
  run.proposedByMode.stock = 4;
  run.appliedByMode.stock = 0;
  await saveSyncRun(run);

  const capture = captureAlertSubjects();
  try {
    await handleBulkOperationFinished({
      opId: "gid://shopify/BulkOperation/cron",
      status: "COMPLETED",
      errorCode: null,
      source: "shopify-webhook",
    });
  } finally {
    capture.restore();
  }

  assert.equal(
    capture.subjects.some((subject) => subject.includes("Sync completed")),
    false,
  );
  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "completed");
  assert.ok(saved?.completedAt);
  assert.equal(saved?.appliedByMode.stock, 4);
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

test("cron no-current-mode completion completes without success notification", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "cron" });
  const run = (await getSyncRun(accepted.runId)) as SyncRun;
  run.status = "queued";
  run.currentMode = null;
  run.currentIndex = run.requestedModes.length;
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
  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "completed");
  assert.ok(saved?.completedAt);
});

test("cron completed mode transition completes without success notification", async () => {
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const body = requestBody(init);

    if (url.includes("test-shop.myshopify.com/admin/api/")) {
      const parsed = JSON.parse(body);
      const query = String(parsed.query ?? "");
      if (query.includes("currentBulkOperation")) {
        return jsonResponse({ data: { currentBulkOperation: null } });
      }
    }

    if (url.includes("ProstorDatabasePrices")) {
      return jsonResponse({});
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  const accepted = await createSyncRun({ modes: ["prices"], source: "cron" });

  const capture = captureAlertSubjects();
  try {
    await continueSyncRun(accepted.runId, "cron");
  } finally {
    capture.restore();
  }

  assert.equal(
    capture.subjects.some((subject) => subject.includes("Sync completed")),
    false,
  );
  const saved = await getSyncRun(accepted.runId);
  assert.equal(saved?.status, "completed");
  assert.ok(saved?.completedAt);
  assert.equal(saved?.skippedByMode.prices, "1C Prices payload empty");
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
