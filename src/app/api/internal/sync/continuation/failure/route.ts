import { NextResponse } from "next/server";
import {
  getContinuationRecordForFailureCallback,
  isSyncContinuationConfigError,
  isSyncContinuationPayload,
  verifyQstashRequest,
} from "@/app/lib/qstash-sync";
import {
  failSyncContinuationIfCurrent,
  failBulkFinishContinuationIfCurrent,
} from "@/app/lib/sync";
import { getSyncRun } from "@/app/lib/sync-state";
import { logSyncEvent, summarizeSyncRun } from "@/app/lib/sync-logging";
import { sanitizeOperationalTextExcerpt } from "@/app/lib/sensitive-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type QstashFailureCallbackBody = {
  status?: number;
  body?: string;
  retried?: number;
  maxRetries?: number;
  dlqId?: string;
  sourceMessageId?: string;
  url?: string;
};

const FAILURE_BODY_EXCERPT_LIMIT = 500;

function nonRetryableJson(body: Record<string, unknown>, status = 489) {
  return NextResponse.json(body, {
    status,
    headers: { "Upstash-NonRetryable-Error": "true" },
  });
}

function normalizeBase64(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function withoutBase64Padding(value: string): string {
  return value.replace(/=+$/g, "");
}

function decodeCallbackResponseBody(body: string | undefined): string | null {
  if (typeof body !== "string" || body.trim() === "") return null;

  const normalized = normalizeBase64(body);
  if (
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return body;
  }

  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const recoded = Buffer.from(decoded, "utf8").toString("base64");
    if (
      withoutBase64Padding(recoded) !== withoutBase64Padding(normalized) ||
      decoded.trim() === ""
    ) {
      return body;
    }
    return decoded;
  } catch {
    return body;
  }
}

function summarizeCallback(body: QstashFailureCallbackBody): string {
  const decodedBody = decodeCallbackResponseBody(body.body);
  const bodyExcerpt = sanitizeOperationalTextExcerpt(
    decodedBody,
    FAILURE_BODY_EXCERPT_LIMIT,
  );
  const parts = [
    `delivery status=${body.status ?? "unknown"}`,
    `retried=${body.retried ?? "unknown"}/${body.maxRetries ?? "unknown"}`,
    body.dlqId ? `dlqId=${body.dlqId}` : null,
    body.sourceMessageId ? `sourceMessageId=${body.sourceMessageId}` : null,
    bodyExcerpt ? `responseBody=${bodyExcerpt}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const url = new URL(request.url);
  const cid = url.searchParams.get("cid");

  let verified = false;
  try {
    verified = await verifyQstashRequest({
      request,
      rawBody,
      expectedUrl: request.url,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logSyncEvent(
      "qstash_failure_callback_signature_error",
      { cid, error: message, durationMs: Date.now() - startedAt },
      "error",
    );
    return NextResponse.json(
      {
        ok: false,
        error: isSyncContinuationConfigError(error)
          ? "sync_config_required"
          : "invalid_qstash_signature",
      },
      { status: isSyncContinuationConfigError(error) ? 503 : 401 },
    );
  }

  if (!verified) {
    logSyncEvent(
      "qstash_failure_callback_rejected",
      { cid, reason: "invalid_signature", durationMs: Date.now() - startedAt },
      "warn",
    );
    return NextResponse.json(
      { ok: false, error: "invalid_qstash_signature" },
      { status: 401 },
    );
  }

  let callbackBody: QstashFailureCallbackBody;
  try {
    callbackBody = JSON.parse(rawBody) as QstashFailureCallbackBody;
  } catch {
    logSyncEvent(
      "qstash_failure_callback_rejected",
      { cid, reason: "invalid_json", durationMs: Date.now() - startedAt },
      "warn",
    );
    return nonRetryableJson({ ok: false, error: "invalid_json" });
  }

  const record = await getContinuationRecordForFailureCallback({
    correlationId: cid,
    messageId:
      typeof callbackBody.sourceMessageId === "string"
        ? callbackBody.sourceMessageId
        : null,
  });

  if (!record) {
    logSyncEvent(
      "qstash_failure_callback_missing_correlation",
      {
        cid,
        sourceMessageId: callbackBody.sourceMessageId,
        durationMs: Date.now() - startedAt,
      },
      "error",
    );
    return NextResponse.json(
      {
        ok: false,
        error: "missing_correlation",
      },
      { status: 500 },
    );
  }

  if (!isSyncContinuationPayload(record.payload)) {
    logSyncEvent(
      "qstash_failure_callback_invalid_correlation_payload",
      {
        cid: record.correlationId,
        sourceMessageId: callbackBody.sourceMessageId,
        durationMs: Date.now() - startedAt,
      },
      "error",
    );
    return nonRetryableJson({
      ok: false,
      error: "invalid_correlation_payload",
    });
  }

  const payload = record.payload;
  const summary = summarizeCallback(callbackBody);
  const reason =
    payload.kind === "continue-run"
      ? `QStash continuation exhausted for run ${payload.runId} index ${payload.currentIndex}: ${summary}`
      : `QStash bulk-finish continuation exhausted for op ${payload.opId} status ${payload.status} code=${payload.errorCode ?? "null"}: ${summary}`;

  let outcome = "marked_failed";

  if (payload.kind === "continue-run") {
    outcome = await failSyncContinuationIfCurrent({ payload, reason });
    if (outcome !== "marked_failed" && outcome !== "marked_ambiguous") {
      const run = await getSyncRun(payload.runId);
      logSyncEvent("qstash_failure_callback_noop", {
        reason: outcome,
        cid: record.correlationId,
        sourceMessageId: callbackBody.sourceMessageId,
        kind: payload.kind,
        payload,
        ...(run ? summarizeSyncRun(run) : {}),
      });
    }
  } else {
    outcome = await failBulkFinishContinuationIfCurrent({ payload, reason });
    if (outcome !== "marked_failed") {
      logSyncEvent("qstash_failure_callback_noop", {
        reason: outcome,
        cid: record.correlationId,
        sourceMessageId: callbackBody.sourceMessageId,
        kind: payload.kind,
        payload,
      });
    }
  }

  logSyncEvent("qstash_failure_callback_handled", {
    cid: record.correlationId,
    sourceMessageId: callbackBody.sourceMessageId,
    kind: payload.kind,
    outcome,
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json({ ok: true, outcome });
}
