import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/app/lib/cron-auth";
import {
  acceptSyncRun,
  isSyncConfigError,
  kickOffSyncRun,
} from "@/app/lib/sync";
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
  try {
    const accepted = await acceptSyncRun({
      modes: ["stock", "prices"],
      source: "cron",
    });
    if (accepted.accepted) kickOffSyncRun(accepted.runId);
    const durationMs = Date.now() - startedAt;
    logSyncEvent("cron_sync_accepted", { durationMs, accepted });
    return NextResponse.json({ ok: true, ...accepted }, { status: 202 });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const message = error?.message ?? String(error);
    logSyncEvent(
      "cron_sync_accept_failed",
      { durationMs, error: message },
      "error",
    );
    if (isSyncConfigError(error)) {
      return NextResponse.json(
        { ok: false, error: "redis_required", message },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
