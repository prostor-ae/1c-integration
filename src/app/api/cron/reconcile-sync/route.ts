import { NextResponse } from "next/server";
import { isSyncConfigError, reconcileSyncRuns } from "@/app/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  const isCron = request.headers.get("x-vercel-cron");

  if (
    process.env.VERCEL_ENV === "production" &&
    !isCron &&
    apiKey !== process.env.INTERNAL_API_KEY
  ) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await reconcileSyncRuns();
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.error(JSON.stringify({ event: "sync_reconcile_failed", error: message }));
    if (isSyncConfigError(error)) {
      return NextResponse.json(
        { ok: false, error: "redis_required", message },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
