import { NextResponse } from "next/server";
import { handleBulkOperationFinished } from "@/app/lib/sync";
import {
  parseBulkOperationWebhook,
  recordWebhookIdempotency,
  verifyShopifyWebhookHmac,
} from "@/app/lib/shopify-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic") || "bulk_operations/finish";

  if (!verifyShopifyWebhookHmac(rawBody, hmac)) {
    return NextResponse.json({ ok: false, error: "invalid_hmac" }, { status: 401 });
  }

  let payload;
  try {
    payload = parseBulkOperationWebhook(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const opId = payload.admin_graphql_api_id;
  const status = payload.status?.toUpperCase();
  if (!opId || !status) {
    return NextResponse.json(
      { ok: false, error: "missing_bulk_operation_fields" },
      { status: 400 }
    );
  }

  const firstDelivery = await recordWebhookIdempotency({ topic, operationId: opId, status });
  if (!firstDelivery) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  setTimeout(() => {
    handleBulkOperationFinished({
      opId,
      status,
      errorCode: payload.error_code ?? null,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "shopify_bulk_webhook_continuation_failed",
          opId,
          status,
          error: error?.message ?? String(error),
        })
      );
    });
  }, 0);

  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({ event: "shopify_bulk_webhook_recorded", opId, status, durationMs }));
  return NextResponse.json({ ok: true });
}
