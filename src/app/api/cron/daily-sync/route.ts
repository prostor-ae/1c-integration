import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/app/lib/cron-auth";
import { acceptSyncRun, isSyncConfigError, kickOffSyncRun } from "@/app/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const accepted = await acceptSyncRun({ modes: ["stock", "prices"], source: "cron" });
    if (accepted.accepted) kickOffSyncRun(accepted.runId);
    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify({ event: "cron_sync_accepted", durationMs, accepted }));
    return NextResponse.json({ ok: true, ...accepted }, { status: 202 });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const message = error?.message ?? String(error);
    console.error(JSON.stringify({ event: "cron_sync_accept_failed", durationMs, error: message }));
    if (isSyncConfigError(error)) {
      return NextResponse.json(
        { ok: false, error: "redis_required", message },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
