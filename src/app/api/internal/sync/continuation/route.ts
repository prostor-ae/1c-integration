import { NextResponse } from "next/server";
import {
  isSyncContinuationConfigError,
  isSyncContinuationPayload,
  verifyQstashRequest,
  type SyncContinuationPayload,
} from "@/app/lib/qstash-sync";
import {
  continueSyncRun,
  createSyncInvocationBudget,
  enqueueBulkFinishNextContinuation,
  FutureCheckpointSequenceError,
  handleBulkOperationFinished,
} from "@/app/lib/sync";
import {
  getSyncRun,
  type SyncRun,
} from "@/app/lib/sync-state";
import { logSyncEvent, summarizeSyncRun } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function nonRetryableJson(body: Record<string, unknown>, status = 489) {
  return NextResponse.json(body, {
    status,
    headers: { "Upstash-NonRetryable-Error": "true" },
  });
}

function isSafeContinueNoop(
  run: SyncRun,
  payload: Extract<SyncContinuationPayload, { kind: "continue-run" }>,
): boolean {
  if (["completed", "failed", "skipped", "waiting_bulk"].includes(run.status)) {
    return true;
  }
  if (run.currentIndex > payload.currentIndex) return true;
  if (
    run.currentIndex === payload.currentIndex &&
    run.currentMode === payload.currentMode
  ) {
    return false;
  }
  return run.status !== "queued";
}

async function handleContinueRun(
  payload: Extract<SyncContinuationPayload, { kind: "continue-run" }>,
  invocationStartedAt: number,
) {
  const run = await getSyncRun(payload.runId);
  if (!run) {
    logSyncEvent(
      "qstash_continue_run_noop",
      { reason: "run_missing", runId: payload.runId, payload },
      "warn",
    );
    return { ok: true, noop: true, reason: "run_missing" };
  }

  if (isSafeContinueNoop(run, payload)) {
    logSyncEvent("qstash_continue_run_noop", {
      reason: "safe_cursor_or_status",
      payload,
      ...summarizeSyncRun(run),
    });
    return { ok: true, noop: true, reason: "safe_cursor_or_status" };
  }

  if (
    run.status === "queued" &&
    (run.currentIndex !== payload.currentIndex ||
      run.currentMode !== payload.currentMode)
  ) {
    logSyncEvent(
      "qstash_continue_run_cursor_mismatch",
      { payload, ...summarizeSyncRun(run) },
      "warn",
    );
    return { ok: true, noop: true, reason: "cursor_mismatch" };
  }

  const continued = await continueSyncRun(
    payload.runId,
    payload.source,
    payload.checkpointSequence ?? 0,
    createSyncInvocationBudget({ startedAt: invocationStartedAt }),
  );
  if (!continued) {
    throw new Error(
      `sync continuation was not processed for run ${payload.runId}; sync lock may be busy`,
    );
  }
  return {
    ok: true,
    runId: payload.runId,
    status: continued.status,
  };
}

async function handleBulkFinish(
  payload: Extract<SyncContinuationPayload, { kind: "bulk-finish" }>,
) {
  const result = await handleBulkOperationFinished({
    opId: payload.opId,
    status: payload.status,
    errorCode: payload.errorCode,
    source: payload.source,
  });

  const nextMessage = await enqueueBulkFinishNextContinuation(result);

  return {
    ok: true,
    runId: result.run?.runId ?? null,
    status: result.run?.status ?? null,
    nextEnqueued: Boolean(nextMessage),
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();

  let verified = false;
  try {
    verified = await verifyQstashRequest({
      request,
      rawBody,
      expectedUrl: request.url,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logSyncEvent(
      "qstash_continuation_signature_error",
      { error: message, durationMs: Date.now() - startedAt },
      "error",
    );
    return NextResponse.json(
      {
        ok: false,
        error: isSyncContinuationConfigError(error)
          ? "sync_config_required"
          : "invalid_qstash_signature",
      },
      { status: isSyncContinuationConfigError(error) ? 503 : 401 },
    );
  }

  if (!verified) {
    logSyncEvent(
      "qstash_continuation_rejected",
      { reason: "invalid_signature", durationMs: Date.now() - startedAt },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "invalid_qstash_signature" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logSyncEvent(
      "qstash_continuation_rejected",
      { reason: "invalid_json", durationMs: Date.now() - startedAt },
      "warn",
    );
    return nonRetryableJson({ ok: false, error: "invalid_json" });
  }

  if (!isSyncContinuationPayload(payload)) {
    logSyncEvent(
      "qstash_continuation_rejected",
      { reason: "invalid_payload", durationMs: Date.now() - startedAt },
      "warn",
    );
    return nonRetryableJson({ ok: false, error: "invalid_payload" });
  }

  try {
    const result =
      payload.kind === "continue-run"
        ? await handleContinueRun(payload, startedAt)
        : await handleBulkFinish(payload);
    logSyncEvent("qstash_continuation_handled", {
      kind: payload.kind,
      durationMs: Date.now() - startedAt,
      result,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    if (error instanceof FutureCheckpointSequenceError) {
      logSyncEvent(
        "qstash_continuation_rejected",
        {
          kind: payload.kind,
          reason: error.code,
          durationMs: Date.now() - startedAt,
        },
        "warn",
      );
      return nonRetryableJson({ ok: false, error: error.code });
    }
    logSyncEvent(
      "qstash_continuation_failed",
      {
        kind: payload.kind,
        durationMs: Date.now() - startedAt,
        error: message,
      },
      "error",
    );
    return NextResponse.json(
      { ok: false, error: "qstash_continuation_failed", message },
      { status: isSyncContinuationConfigError(error) ? 503 : 500 },
    );
  }
}
