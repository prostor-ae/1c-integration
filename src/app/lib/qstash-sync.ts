import { createHash } from "crypto";
import {
  Client,
  Receiver,
  type PublishRequest,
  type PublishToUrlResponse,
} from "@upstash/qstash";
import type { SyncMode } from "./sync-types";
import {
  getQstashContinuationRecord,
  getQstashContinuationRecordByMessageId,
  saveQstashContinuationRecord,
  updateQstashContinuationRecord,
  type QstashContinuationRecord,
} from "./sync-state";

export type SyncContinuationPayload =
  | {
      kind: "continue-run";
      runId: string;
      source: "cron" | "manual" | "bulk-finish" | "reconciler";
      currentIndex: number;
      currentMode: SyncMode | null;
      runVersion?: number;
      checkpointSequence?: number;
    }
  | {
      kind: "bulk-finish";
      opId: string;
      status: string;
      errorCode: string | null;
      source: "shopify-webhook";
    };

export type EnqueueSyncContinuationResult = {
  correlationId: string;
  deduplicationId: string;
  destinationUrl: string;
  failureCallbackUrl: string;
  messageId: string | null;
  deduplicated: boolean;
};

export type SyncContinuationPublishRequest =
  PublishRequest<SyncContinuationPayload> & {
    url: string;
    body: SyncContinuationPayload;
  };

export type SyncContinuationPublisher = (
  request: SyncContinuationPublishRequest,
) => Promise<Partial<PublishToUrlResponse> | void>;

type SyncContinuationConfig = {
  appBaseUrl: string;
  qstashToken: string | null;
  qstashApiBaseUrl: string | null;
  currentSigningKey: string | null;
  nextSigningKey: string | null;
};

let publisherOverride: SyncContinuationPublisher | null = null;
let verifierOverride:
  | ((args: {
      request: Request;
      rawBody: string;
      expectedUrl?: string;
    }) => Promise<boolean> | boolean)
  | null = null;

export class SyncContinuationConfigError extends Error {
  readonly code = "qstash_config_required";

  constructor(message: string) {
    super(message);
    this.name = "SyncContinuationConfigError";
  }
}

export function isSyncContinuationConfigError(
  error: unknown,
): error is SyncContinuationConfigError {
  return error instanceof SyncContinuationConfigError;
}

function isProductionRuntime(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  );
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function resolveAppBaseUrl(): string | null {
  const explicit =
    process.env.SYNC_CONTINUATION_BASE_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    null;
  return explicit ? normalizeBaseUrl(explicit) : null;
}

export function getSyncContinuationConfig({
  requirePublisher,
  requireReceiver,
}: {
  requirePublisher: boolean;
  requireReceiver: boolean;
}): SyncContinuationConfig {
  const config: SyncContinuationConfig = {
    appBaseUrl: resolveAppBaseUrl() ?? "",
    qstashToken: process.env.QSTASH_TOKEN || null,
    qstashApiBaseUrl: process.env.QSTASH_URL || null,
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || null,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || null,
  };

  const missing: string[] = [];
  if (!config.appBaseUrl) missing.push("SYNC_CONTINUATION_BASE_URL or APP_URL");
  if (requirePublisher && !config.qstashToken) missing.push("QSTASH_TOKEN");
  if (requireReceiver) {
    if (!config.currentSigningKey) missing.push("QSTASH_CURRENT_SIGNING_KEY");
    if (!config.nextSigningKey) missing.push("QSTASH_NEXT_SIGNING_KEY");
  }

  if (missing.length > 0) {
    throw new SyncContinuationConfigError(
      `Missing QStash sync continuation config: ${missing.join(", ")}`,
    );
  }

  return config;
}

export function buildSyncContinuationDestinationUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/internal/sync/continuation`;
}

export function buildSyncContinuationFailureCallbackUrl({
  baseUrl,
  correlationId,
}: {
  baseUrl: string;
  correlationId: string;
}): string {
  return `${normalizeBaseUrl(
    baseUrl,
  )}/api/internal/sync/continuation/failure?cid=${encodeURIComponent(
    correlationId,
  )}`;
}

function buildSafeDeduplicationId(prefix: string, parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
  return `${prefix}-${digest}`;
}

export function buildSyncContinuationDeduplicationId(
  payload: SyncContinuationPayload,
): string {
  if (payload.kind === "continue-run") {
    return buildSafeDeduplicationId("sync-continue", [
      payload.kind,
      payload.runId,
      payload.currentIndex,
      payload.currentMode ?? null,
      payload.checkpointSequence ?? 0,
    ]);
  }

  return buildSafeDeduplicationId("sync-bulk-finish", [
    payload.kind,
    payload.opId,
    payload.status.toUpperCase(),
    payload.errorCode ?? null,
    payload.source,
  ]);
}

export function buildSyncContinuationCorrelationId(
  deduplicationId: string,
): string {
  return createHash("sha256")
    .update(deduplicationId)
    .digest("hex")
    .slice(0, 32);
}

function createDefaultPublisher(
  config: SyncContinuationConfig,
): SyncContinuationPublisher {
  return async (request) => {
    const client = new Client({
      token: config.qstashToken ?? undefined,
      baseUrl: config.qstashApiBaseUrl ?? undefined,
    });
    return await client.publishJSON(request);
  };
}

function getPublishResultMessageId(
  result: Partial<PublishToUrlResponse> | void,
): string | null {
  return typeof result?.messageId === "string" ? result.messageId : null;
}

export async function enqueueSyncContinuation(
  payload: SyncContinuationPayload,
): Promise<EnqueueSyncContinuationResult> {
  const config = getSyncContinuationConfig({
    requirePublisher: !publisherOverride,
    requireReceiver: isProductionRuntime() && !publisherOverride,
  });
  const destinationUrl = buildSyncContinuationDestinationUrl(config.appBaseUrl);
  const deduplicationId = buildSyncContinuationDeduplicationId(payload);
  const correlationId = buildSyncContinuationCorrelationId(deduplicationId);
  const failureCallbackUrl = buildSyncContinuationFailureCallbackUrl({
    baseUrl: config.appBaseUrl,
    correlationId,
  });
  const createdAt = new Date().toISOString();

  const record: QstashContinuationRecord = {
    correlationId,
    payload,
    deduplicationId,
    destinationUrl,
    failureCallbackUrl,
    createdAt,
    publishedAt: null,
    messageId: null,
    status: "publishing",
  };
  await saveQstashContinuationRecord(record);

  const publisher = publisherOverride ?? createDefaultPublisher(config);
  const publishResult = await publisher({
    url: destinationUrl,
    body: payload,
    deduplicationId,
    failureCallback: failureCallbackUrl,
    retries: 5,
    headers: {
      "X-Sync-Continuation-Cid": correlationId,
      "X-Sync-Continuation-Kind": payload.kind,
    },
    label: `sync-${payload.kind}`,
  });

  const messageId = getPublishResultMessageId(publishResult);
  const deduplicated = publishResult?.deduplicated === true;
  await updateQstashContinuationRecord(correlationId, {
    status: "published",
    publishedAt: new Date().toISOString(),
    messageId,
  });

  return {
    correlationId,
    deduplicationId,
    destinationUrl,
    failureCallbackUrl,
    messageId,
    deduplicated,
  };
}

export async function verifyQstashRequest({
  request,
  rawBody,
  expectedUrl,
}: {
  request: Request;
  rawBody: string;
  expectedUrl?: string;
}): Promise<boolean> {
  if (verifierOverride) {
    return await verifierOverride({ request, rawBody, expectedUrl });
  }

  const signature = request.headers.get("upstash-signature");
  const requireReceiver = isProductionRuntime() || Boolean(signature);
  if (!requireReceiver) return true;

  const config = getSyncContinuationConfig({
    requirePublisher: false,
    requireReceiver: true,
  });
  if (!signature) return false;

  const receiver = new Receiver({
    currentSigningKey: config.currentSigningKey!,
    nextSigningKey: config.nextSigningKey!,
  });
  return await receiver.verify({
    body: rawBody,
    signature,
    url: expectedUrl ?? request.url,
    clockTolerance: 30,
  });
}

export async function getContinuationRecordForFailureCallback({
  correlationId,
  messageId,
}: {
  correlationId: string | null;
  messageId: string | null;
}): Promise<QstashContinuationRecord | null> {
  if (correlationId) {
    const byCid = await getQstashContinuationRecord(correlationId);
    if (byCid) return byCid;
  }
  if (messageId) {
    return await getQstashContinuationRecordByMessageId(messageId);
  }
  return null;
}

export function isSyncContinuationPayload(
  value: unknown,
): value is SyncContinuationPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SyncContinuationPayload>;
  if (payload.kind === "continue-run") {
    return (
      typeof payload.runId === "string" &&
      ["cron", "manual", "bulk-finish", "reconciler"].includes(
        payload.source as string,
      ) &&
      typeof payload.currentIndex === "number" &&
      Number.isInteger(payload.currentIndex) &&
      payload.currentIndex >= 0 &&
      (payload.currentMode === null ||
        payload.currentMode === "costs" ||
        payload.currentMode === "prices" ||
        payload.currentMode === "stock") &&
      (payload.runVersion === undefined ||
        typeof payload.runVersion === "number") &&
      (payload.checkpointSequence === undefined ||
        (typeof payload.checkpointSequence === "number" &&
          Number.isInteger(payload.checkpointSequence) &&
          payload.checkpointSequence >= 0))
    );
  }

  if (payload.kind === "bulk-finish") {
    return (
      typeof payload.opId === "string" &&
      typeof payload.status === "string" &&
      (payload.errorCode === null || typeof payload.errorCode === "string") &&
      payload.source === "shopify-webhook"
    );
  }

  return false;
}

export async function enqueuePersistedSyncContinuation(identity: {
  payload: Extract<SyncContinuationPayload, { kind: "continue-run" }>;
  deduplicationId: string;
  correlationId: string;
}): Promise<EnqueueSyncContinuationResult> {
  const expectedDeduplicationId = buildSyncContinuationDeduplicationId(
    identity.payload,
  );
  const expectedCorrelationId = buildSyncContinuationCorrelationId(
    expectedDeduplicationId,
  );
  if (
    identity.deduplicationId !== expectedDeduplicationId ||
    identity.correlationId !== expectedCorrelationId
  ) {
    throw new Error("persisted sync continuation identity mismatch");
  }
  return await enqueueSyncContinuation(identity.payload);
}

export function __setSyncContinuationPublisherForTests(
  publisher: SyncContinuationPublisher | null,
): void {
  publisherOverride = publisher;
}

export function __setQstashVerifierForTests(
  verifier:
    | ((args: {
        request: Request;
        rawBody: string;
        expectedUrl?: string;
      }) => Promise<boolean> | boolean)
    | null,
): void {
  verifierOverride = verifier;
}

export function __resetQstashSyncForTests(): void {
  publisherOverride = null;
  verifierOverride = null;
}
