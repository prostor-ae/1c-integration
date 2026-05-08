import { NextResponse } from "next/server";
import {
  acceptSyncRun,
  isSyncConfigError,
  kickOffSyncRun,
  type SyncMode,
} from "@/app/lib/sync";
import { logSyncEvent } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_MODES = new Set<SyncMode>(["stock", "prices", "costs"]);

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.INTERNAL_API_KEY) {
    logSyncEvent(
      "manual_sync_unauthorized",
      {
        path: "/api/sync/trigger",
        hasApiKey: Boolean(request.headers.get("x-api-key")),
      },
      "warn",
    );
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!Array.isArray(body?.modes) || body.modes.length === 0) {
    return NextResponse.json(
      { error: "modes must be a non-empty array" },
      { status: 400 },
    );
  }

  if (
    !body.modes.every(
      (mode: unknown) =>
        typeof mode === "string" && VALID_MODES.has(mode as SyncMode),
    )
  ) {
    return NextResponse.json(
      { error: "modes must contain only: stock, prices, costs" },
      { status: 400 },
    );
  }

  const modes = body.modes as SyncMode[];
  const startedAt = Date.now();
  try {
    const accepted = await acceptSyncRun({ modes, source: "manual" });
    if (accepted.accepted) kickOffSyncRun(accepted.runId);
    const durationMs = Date.now() - startedAt;
    logSyncEvent("manual_sync_accepted", { durationMs, accepted });
    return NextResponse.json({ ok: true, ...accepted }, { status: 202 });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const message = error?.message ?? String(error);
    logSyncEvent(
      "manual_sync_accept_failed",
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
