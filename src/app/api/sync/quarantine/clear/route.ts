import { NextResponse } from "next/server";
import { clearBulkLaunchQuarantine } from "@/app/lib/sync";
import { logSyncEvent } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.INTERNAL_API_KEY) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const value = body as {
    quarantineToken?: unknown;
    terminalOperationId?: unknown;
  };
  if (
    typeof value.quarantineToken !== "string" ||
    value.quarantineToken.length < 16 ||
    (value.terminalOperationId !== undefined &&
      typeof value.terminalOperationId !== "string")
  ) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }
  try {
    const cleared = await clearBulkLaunchQuarantine({
      quarantineToken: value.quarantineToken,
      terminalOperationId: value.terminalOperationId as string | undefined,
    });
    if (!cleared) {
      return NextResponse.json(
        { ok: false, error: "quarantine_proof_inconclusive_or_token_mismatch" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, cleared: true });
  } catch (error: any) {
    logSyncEvent(
      "sync_bulk_quarantine_clear_failed",
      { error: error?.message ?? String(error) },
      "error",
    );
    return NextResponse.json(
      { ok: false, error: "quarantine_diagnostic_failed" },
      { status: 503 },
    );
  }
}
