import { NextResponse } from "next/server";
import {
  getSyncRun,
  isMissingRedisConfig,
  listSyncRuns,
  type SyncRun,
} from "@/app/lib/sync-state";
import { logSyncEvent } from "@/app/lib/sync-logging";

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

function timeValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(a: SyncRun, b: SyncRun): number {
  return (
    timeValue(b.createdAt) - timeValue(a.createdAt) ||
    timeValue(b.updatedAt) - timeValue(a.updatedAt)
  );
}

function selectGenericStatusRun(runs: SyncRun[]): SyncRun | null {
  const running = runs.filter(isRunningSyncRun).sort(newestFirst);
  if (running.length > 0) return running[0];
  return [...runs].sort(newestFirst)[0] ?? null;
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?[redacted]";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

function sanitizeStatusText(value: string | null): string | null {
  if (!value) return value;
  return value
    .slice(0, 2000)
    .replace(/https?:\/\/[^\s"'<>)]*/gi, redactUrl)
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, "Basic [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|x-api-key|x-shopify-access-token|token|password|secret)(["'\s:=]+)([^"',\s}]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(shpat_|shpua_|sk_|rk_)[A-Za-z0-9_-]+/g, "$1[redacted]");
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
    failureReason: sanitizeStatusText(run.failureReason),
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

    const run = selectGenericStatusRun(await listSyncRuns());
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
