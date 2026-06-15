import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/app/lib/cron-auth";
import { reconcileSyncRuns } from "@/app/lib/sync";
import { reconcileSyncErrorResponse } from "@/app/lib/reconcile-sync-error-response";
import { logSyncEvent } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    logSyncEvent(
      "sync_reconcile_unauthorized",
      {
        path: "/api/cron/reconcile-sync",
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
    const result = await reconcileSyncRuns();
    logSyncEvent("sync_reconcile_response", {
      durationMs: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logSyncEvent(
      "sync_reconcile_failed",
      { durationMs: Date.now() - startedAt, error: message },
      "error",
    );
    return reconcileSyncErrorResponse(error);
  }
}
