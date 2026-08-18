import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/app/lib/cron-auth";
import {
  acceptSyncRun,
  enqueueSyncRunContinuation,
  isSyncConfigError,
  markSyncRunFailed,
} from "@/app/lib/sync";
import { isMissingRedisConfig } from "@/app/lib/sync-state";
import { logSyncEvent } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    logSyncEvent(
      "cron_sync_unauthorized",
      {
        path: "/api/cron/daily-sync",
        hasAuthorization: Boolean(request.headers.get("authorization")),
        hasApiKey: Boolean(request.headers.get("x-api-key")),
        hasVercelCronHeader: Boolean(request.headers.get("x-vercel-cron")),
      },
      "warn",
    );
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  let acceptedRunId: string | null = null;
  let acceptedMode: string | null = null;
  try {
    const accepted = await acceptSyncRun({
      modes: ["stock", "prices"],
      source: "cron",
    });
    if (accepted.accepted) {
      acceptedRunId = accepted.runId;
      acceptedMode = accepted.currentMode;
      await enqueueSyncRunContinuation({
        runId: accepted.runId,
        source: "cron",
      });
    }
    if (accepted.status === "quarantined") {
      return NextResponse.json(
        { ok: false, error: "ambiguous_bulk_quarantine", ...accepted },
        { status: 503 },
      );
    }
    const durationMs = Date.now() - startedAt;
    logSyncEvent("cron_sync_accepted", { durationMs, accepted });
    return NextResponse.json({ ok: true, ...accepted }, { status: 202 });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const message = error?.message ?? String(error);
    if (acceptedRunId) {
      await markSyncRunFailed({
        runId: acceptedRunId,
        mode: acceptedMode,
        reason: `Failed to enqueue durable cron sync continuation: ${message}`,
      });
    }
    logSyncEvent(
      "cron_sync_accept_failed",
      { durationMs, acceptedRunId, error: message },
      "error",
    );
    if (isMissingRedisConfig(error)) {
      return NextResponse.json(
        { ok: false, error: "redis_required", message },
        { status: 503 },
      );
    }
    if (isSyncConfigError(error)) {
      return NextResponse.json(
        { ok: false, error: "sync_config_required", message },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
