import { NextResponse } from "next/server";
import {
  getLatestSyncRun,
  getSyncRun,
  isMissingRedisConfig,
  type SyncRun,
} from "@/app/lib/sync-state";
import { logSyncEvent } from "@/app/lib/sync-logging";
import { sanitizeOperationalText } from "@/app/lib/sensitive-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RUNNING_STATUSES = new Set<SyncRun["status"]>([
  "queued",
  "running",
  "waiting_bulk",
]);

function isRunningSyncRun(run: SyncRun | null): boolean {
  return run ? RUNNING_STATUSES.has(run.status) : false;
}

function toSyncRunStatusResponse(run: SyncRun) {
  return {
    runId: run.runId,
    source: run.source,
    status: run.status,
    requestedModes: run.requestedModes,
    currentMode: run.currentMode,
    currentIndex: run.currentIndex,
    activeBulkOperationId: run.activeBulkOperationId,
    activeBulkOperationType: run.activeBulkOperationType,
    proposedByMode: run.proposedByMode,
    appliedByMode: run.appliedByMode,
    skippedByMode: run.skippedByMode,
    failureReason: sanitizeOperationalText(run.failureReason),
    attempts: run.attempts,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    missedRecoveryCount: run.missedRecoveryCount,
  };
}

export async function GET(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.INTERNAL_API_KEY) {
    logSyncEvent(
      "sync_status_unauthorized",
      {
        path: "/api/sync/status",
        hasApiKey: Boolean(request.headers.get("x-api-key")),
      },
      "warn",
    );
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const runId = new URL(request.url).searchParams.get("runId")?.trim();

  try {
    if (runId) {
      const run = await getSyncRun(runId);
      if (!run) {
        logSyncEvent("sync_status_not_found", {
          runId,
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          { ok: false, error: "sync_run_not_found", runId },
          { status: 404 },
        );
      }

      logSyncEvent("sync_status_returned", {
        runId,
        status: run.status,
        currentMode: run.currentMode,
        running: isRunningSyncRun(run),
        lookup: "run_id",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({
        ok: true,
        running: isRunningSyncRun(run),
        run: toSyncRunStatusResponse(run),
      });
    }

    const run = await getLatestSyncRun();
    if (!run) {
      logSyncEvent("sync_status_returned", {
        running: false,
        lookup: "latest",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ ok: true, running: false, run: null });
    }

    logSyncEvent("sync_status_returned", {
      runId: run.runId,
      status: run.status,
      currentMode: run.currentMode,
      running: isRunningSyncRun(run),
      lookup: "latest",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: true,
      running: isRunningSyncRun(run),
      run: toSyncRunStatusResponse(run),
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logSyncEvent(
      "sync_status_failed",
      { runId, durationMs: Date.now() - startedAt, error: message },
      "error",
    );
    if (isMissingRedisConfig(error)) {
      return NextResponse.json(
        { ok: false, error: "redis_required", message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "sync_status_failed" },
      { status: 500 },
    );
  }
}
