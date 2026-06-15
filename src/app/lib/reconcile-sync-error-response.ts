import { NextResponse } from "next/server";

import { isSyncConfigError } from "@/app/lib/sync";
import { isMissingRedisConfig } from "@/app/lib/sync-state";

export function reconcileSyncErrorResponse(error: any) {
  const message = error?.message ?? String(error);
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
