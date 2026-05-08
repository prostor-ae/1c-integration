import { NextResponse } from "next/server";
import { handleBulkOperationFinished } from "@/app/lib/sync";
import {
  parseBulkOperationWebhook,
  recordWebhookIdempotency,
  verifyShopifyWebhookHmac,
} from "@/app/lib/shopify-webhooks";
import { logSyncEvent } from "@/app/lib/sync-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic =
    request.headers.get("x-shopify-topic") || "bulk_operations/finish";

  if (!verifyShopifyWebhookHmac(rawBody, hmac)) {
    logSyncEvent(
      "shopify_bulk_webhook_rejected",
      {
        reason: "invalid_hmac",
        topic,
        hasHmac: Boolean(hmac),
        durationMs: Date.now() - startedAt,
      },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "invalid_hmac" },
      { status: 401 },
    );
  }

  let payload;
  try {
    payload = parseBulkOperationWebhook(rawBody);
  } catch {
    logSyncEvent(
      "shopify_bulk_webhook_rejected",
      {
        reason: "invalid_json",
        topic,
        durationMs: Date.now() - startedAt,
      },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const opId = payload.admin_graphql_api_id;
  const status = payload.status?.toUpperCase();
  if (!opId || !status) {
    logSyncEvent(
      "shopify_bulk_webhook_rejected",
      {
        reason: "missing_bulk_operation_fields",
        topic,
        opId,
        opStatus: status,
        durationMs: Date.now() - startedAt,
      },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "missing_bulk_operation_fields" },
      { status: 400 },
    );
  }

  const firstDelivery = await recordWebhookIdempotency({
    topic,
    operationId: opId,
    status,
  });
  if (!firstDelivery) {
    logSyncEvent("shopify_bulk_webhook_duplicate", {
      topic,
      opId,
      opStatus: status,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  setTimeout(() => {
    handleBulkOperationFinished({
      opId,
      status,
      errorCode: payload.error_code ?? null,
      source: "shopify-webhook",
    }).catch((error) => {
      logSyncEvent(
        "shopify_bulk_webhook_continuation_failed",
        {
          opId,
          opStatus: status,
          error: error?.message ?? String(error),
        },
        "error",
      );
    });
  }, 0);

  const durationMs = Date.now() - startedAt;
  logSyncEvent("shopify_bulk_webhook_recorded", {
    topic,
    opId,
    opStatus: status,
    errorCode: payload.error_code ?? null,
    durationMs,
    continuationScheduled: true,
  });
  return NextResponse.json({ ok: true });
}
