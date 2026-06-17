import { NextResponse } from "next/server";
import {
  getWebhookIdempotencyValue,
  parseBulkOperationWebhook,
  recordWebhookIdempotency,
  verifyShopifyWebhookHmacWithDiagnostics,
} from "@/app/lib/shopify-webhooks";
import { logSyncEvent } from "@/app/lib/sync-logging";
import {
  enqueueSyncContinuation,
  isSyncContinuationConfigError,
} from "@/app/lib/qstash-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic =
    request.headers.get("x-shopify-topic") || "bulk_operations/finish";
  const shopDomainHeader = request.headers.get("x-shopify-shop-domain");
  const hmacVerification = verifyShopifyWebhookHmacWithDiagnostics(
    rawBody,
    hmac,
    { shopDomainHeader },
  );

  if (!hmacVerification.ok) {
    logSyncEvent(
      "shopify_bulk_webhook_rejected",
      {
        reason: "invalid_hmac",
        hmacFailureReason: hmacVerification.reason,
        topic,
        hasHmac: Boolean(hmac),
        shopDomainHeader: hmacVerification.shopDomainHeader,
        webhookSecretTarget: hmacVerification.webhookSecretTarget,
        webhookSecretTargetSource: hmacVerification.webhookSecretTargetSource,
        webhookSecretCandidateSources: hmacVerification.candidateSecretSources,
        webhookSecretConfiguredSources:
          hmacVerification.configuredSecretSources,
        hmacHeaderLength: hmacVerification.hmacHeaderLength,
        rawBodyBytes: hmacVerification.rawBodyBytes,
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
        shopDomainHeader: hmacVerification.shopDomainHeader,
        webhookSecretMatchedSource: hmacVerification.matchedSecretSource,
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
        shopDomainHeader: hmacVerification.shopDomainHeader,
        webhookSecretMatchedSource: hmacVerification.matchedSecretSource,
        durationMs: Date.now() - startedAt,
      },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "missing_bulk_operation_fields" },
      { status: 400 },
    );
  }

  const existingDelivery = await getWebhookIdempotencyValue({
    topic,
    operationId: opId,
    status,
  });
  if (existingDelivery) {
    logSyncEvent("shopify_bulk_webhook_duplicate", {
      topic,
      opId,
      opStatus: status,
      shopDomainHeader: hmacVerification.shopDomainHeader,
      webhookSecretMatchedSource: hmacVerification.matchedSecretSource,
      qstashCorrelationId: existingDelivery,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let enqueueResult;
  try {
    enqueueResult = await enqueueSyncContinuation({
      kind: "bulk-finish",
      opId,
      status,
      errorCode: payload.error_code ?? null,
      source: "shopify-webhook",
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logSyncEvent(
      "shopify_bulk_webhook_enqueue_failed",
      {
        topic,
        opId,
        opStatus: status,
        shopDomainHeader: hmacVerification.shopDomainHeader,
        webhookSecretMatchedSource: hmacVerification.matchedSecretSource,
        error: message,
        durationMs: Date.now() - startedAt,
      },
      "error",
    );
    return NextResponse.json(
      {
        ok: false,
        error: isSyncContinuationConfigError(error)
          ? "sync_config_required"
          : "qstash_enqueue_failed",
        message,
      },
      { status: isSyncContinuationConfigError(error) ? 503 : 500 },
    );
  }

  const firstDelivery = await recordWebhookIdempotency({
    topic,
    operationId: opId,
    status,
    value: enqueueResult.correlationId,
  });

  const durationMs = Date.now() - startedAt;
  logSyncEvent("shopify_bulk_webhook_enqueued", {
    topic,
    opId,
    opStatus: status,
    errorCode: payload.error_code ?? null,
    shopDomainHeader: hmacVerification.shopDomainHeader,
    webhookSecretMatchedSource: hmacVerification.matchedSecretSource,
    durationMs,
    firstDelivery,
    qstashCorrelationId: enqueueResult.correlationId,
    qstashMessageId: enqueueResult.messageId,
    qstashDeduplicationId: enqueueResult.deduplicationId,
    qstashDeduplicated: enqueueResult.deduplicated,
  });
  return NextResponse.json({
    ok: true,
    duplicate: !firstDelivery,
    qstashMessageId: enqueueResult.messageId,
  });
}
