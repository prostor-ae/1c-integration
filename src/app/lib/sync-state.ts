import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "crypto";
import { getRedisConfig, getStoreId, getStoreIdAliases } from "./config";
import {
  canonicalizeModes,
  type ModeResult,
  type SyncMode,
} from "./sync-types";

export type SyncRunStatus =
  | "queued"
  | "running"
  | "waiting_bulk"
  | "completed"
  | "failed"
  | "skipped";

export type SyncRun = {
  runId: string;
  source: "cron" | "manual" | "shopify-webhook" | "reconciler";
  storeId: string;
  requestedModes: SyncMode[];
  currentIndex: number;
  currentMode: SyncMode | null;
  status: SyncRunStatus;
  activeBulkOperationId: string | null;
  activeBulkOperationType: "MUTATION" | "QUERY" | null;
  proposedByMode: Partial<Record<SyncMode, number>>;
  appliedByMode: Partial<Record<SyncMode, number>>;
  skippedByMode: Partial<Record<SyncMode, string>>;
  failureReason: string | null;
  attempts: number;
  version: number;
  fencingToken: string | null;
  createdAt: string;
  updatedAt: string;
  lockUntil: string | null;
  completedAt: string | null;
  missedRecoveryCount: number;
};

export type AcceptedRun = {
  runId: string;
  accepted: boolean;
  status: SyncRunStatus | "already_running";
  modes: SyncMode[];
  currentMode: SyncMode | null;
};

export type QstashContinuationRecord = {
  correlationId: string;
  payload: unknown;
  deduplicationId: string;
  destinationUrl: string;
  failureCallbackUrl: string;
  createdAt: string;
  publishedAt: string | null;
  messageId: string | null;
  status: "publishing" | "published";
};

export type PendingNextContinuation = {
  opId: string;
  runId: string;
  currentIndex: number;
  currentMode: SyncMode;
  runVersion: number;
  state: "pending" | "enqueued";
  createdAt: string;
  updatedAt: string;
  qstashCorrelationId: string | null;
  qstashMessageId: string | null;
};

const RUN_TTL_SECONDS = 14 * 24 * 60 * 60;
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_MS = 5 * 60 * 1000;
const SYNC_RUN_SCAN_COUNT = 100;
const SYNC_RUN_SCAN_LIMIT = 100;

let redisClient: RedisClientType | null = null;
const memoryRuns = new Map<string, SyncRun>();
const memoryOpIndex = new Map<string, string>();
const memoryIdempotency = new Map<string, string>();
const memoryLatestRunByStore = new Map<string, string>();
const memoryQstashContinuations = new Map<string, QstashContinuationRecord>();
const memoryQstashMessages = new Map<string, string>();
const memoryPendingNextContinuations = new Map<
  string,
  PendingNextContinuation
>();
let memoryLock: { token: string; expiresAt: number } | null = null;

class MissingRedisConfigError extends Error {
  constructor() {
    super("REDIS_URL is required for production sync orchestration");
    this.name = "MissingRedisConfigError";
  }
}

export function isMissingRedisConfig(error: unknown): boolean {
  return error instanceof MissingRedisConfigError;
}

function nowIso(): string {
  return new Date().toISOString();
}

function runKey(runId: string) {
  return `sync:run:${runId}`;
}

function opKey(opId: string) {
  return `sync:op:${opId}`;
}

function activeKey(storeId: string) {
  return `sync:active:${storeId}`;
}

function latestKey(storeId: string) {
  return `sync:latest:${storeId}`;
}

function lockKey(storeId: string) {
  return `sync:lock:${storeId}`;
}

function idempotencyKey(key: string) {
  return `sync:idempotency:${key}`;
}

function qstashContinuationKey(correlationId: string) {
  return `sync:qstash:continuation:${correlationId}`;
}

function qstashMessageKey(messageId: string) {
  return `sync:qstash:message:${messageId}`;
}

function pendingNextKey(opId: string) {
  return `sync:next-continuation:${opId}`;
}

function timeValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(a: SyncRun, b: SyncRun): number {
  return (
    timeValue(b.createdAt) - timeValue(a.createdAt) ||
    timeValue(b.updatedAt) - timeValue(a.updatedAt)
  );
}

function isOpenRun(run: SyncRun): boolean {
  return ["queued", "running", "waiting_bulk"].includes(run.status);
}

function selectNewestRun(runs: SyncRun[]): SyncRun | null {
  return [...runs].sort(newestFirst)[0] ?? null;
}

async function getRedis(): Promise<RedisClientType | null> {
  const config = getRedisConfig();
  if (!config.url) {
    if (config.required) throw new MissingRedisConfigError();
    return null;
  }
  if (!redisClient) {
    redisClient = createClient({ url: config.url });
    redisClient.on("error", (error) => {
      console.error(
        JSON.stringify({
          event: "redis_error",
          error: error?.message ?? String(error),
        }),
      );
    });
  }
  if (!redisClient.isOpen) await redisClient.connect();
  return redisClient;
}

async function readActiveRunId(
  redis: RedisClientType | null,
  storeId: string,
): Promise<string | undefined | null> {
  return redis
    ? await redis.get(activeKey(storeId))
    : memoryIdempotency.get(activeKey(storeId));
}

async function mirrorActiveRunKey({
  redis,
  fromStoreId,
  toStoreId,
  runId,
}: {
  redis: RedisClientType | null;
  fromStoreId: string;
  toStoreId: string;
  runId: string;
}): Promise<void> {
  if (fromStoreId === toStoreId) return;
  if (!redis) {
    memoryIdempotency.set(activeKey(toStoreId), runId);
    return;
  }
  await redis.set(activeKey(toStoreId), runId, { EX: RUN_TTL_SECONDS });
}

async function findOpenActiveRun(
  redis: RedisClientType | null,
  storeIds: string[],
): Promise<{ run: SyncRun; matchedStoreId: string } | null> {
  for (const storeId of storeIds) {
    const existingRunId = await readActiveRunId(redis, storeId);
    if (!existingRunId) continue;
    const existingRun = await getSyncRun(existingRunId);
    if (existingRun && isOpenRun(existingRun)) {
      return { run: existingRun, matchedStoreId: storeId };
    }
  }
  return null;
}

async function saveMemoryRun(run: SyncRun) {
  memoryRuns.set(run.runId, run);
  if (run.activeBulkOperationId)
    memoryOpIndex.set(run.activeBulkOperationId, run.runId);
  const latestRunId = memoryLatestRunByStore.get(run.storeId);
  const latestRun = latestRunId ? memoryRuns.get(latestRunId) : null;
  if (
    !latestRun ||
    latestRun.runId === run.runId ||
    newestFirst(run, latestRun) < 0
  ) {
    memoryLatestRunByStore.set(run.storeId, run.runId);
  }
  if (isOpenRun(run)) {
    memoryIdempotency.set(activeKey(run.storeId), run.runId);
  } else if (memoryIdempotency.get(activeKey(run.storeId)) === run.runId) {
    memoryIdempotency.delete(activeKey(run.storeId));
  }
}

export async function createSyncRun({
  modes,
  source,
}: {
  modes: SyncMode[];
  source: SyncRun["source"];
}): Promise<AcceptedRun> {
  const orderedModes = canonicalizeModes(modes);
  const storeId = getStoreId();
  const redis = await getRedis();

  const activeRun = await findOpenActiveRun(redis, getStoreIdAliases());
  if (activeRun) {
    await mirrorActiveRunKey({
      redis,
      fromStoreId: activeRun.matchedStoreId,
      toStoreId: storeId,
      runId: activeRun.run.runId,
    });
    return {
      runId: activeRun.run.runId,
      accepted: false,
      status: "already_running",
      modes: activeRun.run.requestedModes,
      currentMode: activeRun.run.currentMode,
    };
  }

  const createdAt = nowIso();
  const run: SyncRun = {
    runId: randomUUID(),
    source,
    storeId,
    requestedModes: orderedModes,
    currentIndex: 0,
    currentMode: orderedModes[0] ?? null,
    status: orderedModes.length > 0 ? "queued" : "completed",
    activeBulkOperationId: null,
    activeBulkOperationType: null,
    proposedByMode: {},
    appliedByMode: {},
    skippedByMode: {},
    failureReason: null,
    attempts: 0,
    version: 1,
    fencingToken: null,
    createdAt,
    updatedAt: createdAt,
    lockUntil: null,
    completedAt: orderedModes.length > 0 ? null : createdAt,
    missedRecoveryCount: 0,
  };

  if (!redis) {
    await saveMemoryRun(run);
  } else {
    await redis.set(runKey(run.runId), JSON.stringify(run), {
      EX: RUN_TTL_SECONDS,
    });
    await redis.set(activeKey(storeId), run.runId, { EX: RUN_TTL_SECONDS });
    await redis.set(latestKey(storeId), run.runId, { EX: RUN_TTL_SECONDS });
  }

  return {
    runId: run.runId,
    accepted: true,
    status: run.status,
    modes: run.requestedModes,
    currentMode: run.currentMode,
  };
}

export async function getSyncRun(runId: string): Promise<SyncRun | null> {
  const redis = await getRedis();
  if (!redis) return memoryRuns.get(runId) ?? null;
  const raw = await redis.get(runKey(runId));
  if (!raw) return null;
  return JSON.parse(raw) as SyncRun;
}

export async function getRunIdForOperation(
  opId: string,
): Promise<string | null> {
  const redis = await getRedis();
  if (!redis) return memoryOpIndex.get(opId) ?? null;
  return await redis.get(opKey(opId));
}

export async function saveSyncRun(
  run: SyncRun,
  fencingToken?: string,
): Promise<void> {
  const redis = await getRedis();
  const existing = await getSyncRun(run.runId);
  if (existing && existing.version > run.version) {
    throw new Error(`stale sync run transition rejected: ${run.runId}`);
  }
  if (fencingToken) {
    await assertCurrentLockOwner(run, fencingToken, redis);
    run.fencingToken = fencingToken;
  }
  run.updatedAt = nowIso();
  run.version += 1;
  if (!redis) {
    await saveMemoryRun(run);
    return;
  }
  await redis.set(runKey(run.runId), JSON.stringify(run), {
    EX: RUN_TTL_SECONDS,
  });
  const latestRunId = await redis.get(latestKey(run.storeId));
  if (!latestRunId || latestRunId === run.runId) {
    await redis.set(latestKey(run.storeId), run.runId, { EX: RUN_TTL_SECONDS });
  }
  if (run.activeBulkOperationId) {
    await redis.set(opKey(run.activeBulkOperationId), run.runId, {
      EX: RUN_TTL_SECONDS,
    });
  }
  if (isOpenRun(run)) {
    await redis.set(activeKey(run.storeId), run.runId, { EX: RUN_TTL_SECONDS });
  } else {
    const activeRunId = await redis.get(activeKey(run.storeId));
    if (activeRunId === run.runId) await redis.del(activeKey(run.storeId));
  }
}

async function scanSyncRuns({
  redis,
  storeId,
  limit = SYNC_RUN_SCAN_LIMIT,
}: {
  redis: RedisClientType;
  storeId?: string;
  limit?: number;
}): Promise<SyncRun[]> {
  let cursor = 0;
  const runs: SyncRun[] = [];

  do {
    const reply = await redis.scan(cursor, {
      MATCH: "sync:run:*",
      COUNT: SYNC_RUN_SCAN_COUNT,
    });
    cursor = reply.cursor;

    for (const key of reply.keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const run = JSON.parse(raw) as SyncRun;
      if (storeId && run.storeId !== storeId) continue;
      runs.push(run);
      if (runs.length >= limit) return runs;
    }
  } while (cursor !== 0);

  return runs;
}

async function assertCurrentLockOwner(
  run: SyncRun,
  fencingToken: string,
  redis: RedisClientType | null,
): Promise<void> {
  if (!redis) {
    if (memoryLock?.token !== fencingToken) {
      throw new Error(`fencing token mismatch for sync run ${run.runId}`);
    }
    return;
  }

  const currentToken = await redis.get(lockKey(run.storeId));
  if (currentToken !== fencingToken) {
    throw new Error(`fencing token mismatch for sync run ${run.runId}`);
  }
}

export async function acquireSyncLock(
  storeId = getStoreId(),
): Promise<string | null> {
  const token = randomUUID();
  const redis = await getRedis();
  if (!redis) {
    if (memoryLock && memoryLock.expiresAt > Date.now()) return null;
    memoryLock = { token, expiresAt: Date.now() + LOCK_TTL_MS };
    return token;
  }
  const acquired = await redis.set(lockKey(storeId), token, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  return acquired === "OK" ? token : null;
}

export async function releaseSyncLock(
  token: string,
  storeId = getStoreId(),
): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    if (memoryLock?.token === token) memoryLock = null;
    return;
  }
  const existing = await redis.get(lockKey(storeId));
  if (existing === token) await redis.del(lockKey(storeId));
}

export async function markIdempotent(
  key: string,
  value: string,
): Promise<boolean> {
  const redis = await getRedis();
  const fullKey = idempotencyKey(key);
  if (!redis) {
    if (memoryIdempotency.has(fullKey)) return false;
    memoryIdempotency.set(fullKey, value);
    return true;
  }
  const written = await redis.set(fullKey, value, {
    NX: true,
    EX: IDEMPOTENCY_TTL_SECONDS,
  });
  return written === "OK";
}

export async function getIdempotencyValue(key: string): Promise<string | null> {
  const redis = await getRedis();
  const fullKey = idempotencyKey(key);
  if (!redis) return memoryIdempotency.get(fullKey) ?? null;
  return await redis.get(fullKey);
}

export async function saveQstashContinuationRecord(
  record: QstashContinuationRecord,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    memoryQstashContinuations.set(record.correlationId, record);
    if (record.messageId) {
      memoryQstashMessages.set(record.messageId, record.correlationId);
    }
    return;
  }
  await redis.set(
    qstashContinuationKey(record.correlationId),
    JSON.stringify(record),
    { EX: RUN_TTL_SECONDS },
  );
  if (record.messageId) {
    await redis.set(qstashMessageKey(record.messageId), record.correlationId, {
      EX: RUN_TTL_SECONDS,
    });
  }
}

export async function updateQstashContinuationRecord(
  correlationId: string,
  patch: Partial<Omit<QstashContinuationRecord, "correlationId" | "createdAt">>,
): Promise<QstashContinuationRecord> {
  const existing = await getQstashContinuationRecord(correlationId);
  if (!existing) {
    throw new Error(
      `QStash continuation correlation record not found: ${correlationId}`,
    );
  }
  const next = { ...existing, ...patch };
  await saveQstashContinuationRecord(next);
  return next;
}

export async function getQstashContinuationRecord(
  correlationId: string,
): Promise<QstashContinuationRecord | null> {
  const redis = await getRedis();
  if (!redis) return memoryQstashContinuations.get(correlationId) ?? null;
  const raw = await redis.get(qstashContinuationKey(correlationId));
  return raw ? (JSON.parse(raw) as QstashContinuationRecord) : null;
}

export async function getQstashContinuationRecordByMessageId(
  messageId: string,
): Promise<QstashContinuationRecord | null> {
  const redis = await getRedis();
  const correlationId = redis
    ? await redis.get(qstashMessageKey(messageId))
    : (memoryQstashMessages.get(messageId) ?? null);
  if (!correlationId) return null;
  return await getQstashContinuationRecord(correlationId);
}

export async function savePendingNextContinuation(
  record: PendingNextContinuation,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    memoryPendingNextContinuations.set(record.opId, record);
    return;
  }
  await redis.set(pendingNextKey(record.opId), JSON.stringify(record), {
    EX: RUN_TTL_SECONDS,
  });
}

export async function getPendingNextContinuation(
  opId: string,
): Promise<PendingNextContinuation | null> {
  const redis = await getRedis();
  if (!redis) return memoryPendingNextContinuations.get(opId) ?? null;
  const raw = await redis.get(pendingNextKey(opId));
  return raw ? (JSON.parse(raw) as PendingNextContinuation) : null;
}

export async function markPendingNextContinuationEnqueued({
  opId,
  qstashCorrelationId,
  qstashMessageId,
}: {
  opId: string;
  qstashCorrelationId: string;
  qstashMessageId: string | null;
}): Promise<PendingNextContinuation> {
  const existing = await getPendingNextContinuation(opId);
  if (!existing) {
    throw new Error(`pending next-mode continuation not found: ${opId}`);
  }
  const next: PendingNextContinuation = {
    ...existing,
    state: "enqueued",
    updatedAt: nowIso(),
    qstashCorrelationId,
    qstashMessageId,
  };
  await savePendingNextContinuation(next);
  return next;
}

export async function listOpenRuns(): Promise<SyncRun[]> {
  const redis = await getRedis();
  if (!redis) {
    return Array.from(memoryRuns.values()).filter(isOpenRun);
  }

  const activeRun = await findOpenActiveRun(redis, getStoreIdAliases());
  if (activeRun) {
    await mirrorActiveRunKey({
      redis,
      fromStoreId: activeRun.matchedStoreId,
      toStoreId: getStoreId(),
      runId: activeRun.run.runId,
    });
    return [activeRun.run];
  }

  return (await scanSyncRuns({ redis, limit: SYNC_RUN_SCAN_LIMIT })).filter(
    isOpenRun,
  );
}

export async function listSyncRuns(
  limit = SYNC_RUN_SCAN_LIMIT,
): Promise<SyncRun[]> {
  const redis = await getRedis();
  if (!redis) return Array.from(memoryRuns.values());

  return await scanSyncRuns({ redis, limit });
}

export async function getLatestSyncRun(
  storeId = getStoreId(),
): Promise<SyncRun | null> {
  const redis = await getRedis();
  if (!redis) {
    const activeRun = await findOpenActiveRun(null, getStoreIdAliases());
    if (activeRun) {
      await mirrorActiveRunKey({
        redis: null,
        fromStoreId: activeRun.matchedStoreId,
        toStoreId: storeId,
        runId: activeRun.run.runId,
      });
      return activeRun.run;
    }

    const latestRunId = memoryLatestRunByStore.get(storeId);
    const latestRun = latestRunId ? memoryRuns.get(latestRunId) : null;
    if (latestRun) return latestRun;

    return selectNewestRun(
      Array.from(memoryRuns.values()).filter((run) => run.storeId === storeId),
    );
  }

  const activeRun = await findOpenActiveRun(redis, getStoreIdAliases());
  if (activeRun) {
    await mirrorActiveRunKey({
      redis,
      fromStoreId: activeRun.matchedStoreId,
      toStoreId: storeId,
      runId: activeRun.run.runId,
    });
    return activeRun.run;
  }

  const latestRunId = await redis.get(latestKey(storeId));
  if (latestRunId) {
    const latestRun = await getSyncRun(latestRunId);
    if (latestRun) return latestRun;
  }

  return selectNewestRun(await scanSyncRuns({ redis, storeId }));
}

export async function withSyncLock<T>(
  fn: (fencingToken: string) => Promise<T>,
  storeId = getStoreId(),
): Promise<T | null> {
  const token = await acquireSyncLock(storeId);
  if (!token) return null;
  try {
    return await fn(token);
  } finally {
    await releaseSyncLock(token, storeId);
  }
}

export function __resetMemorySyncStateForTests(): void {
  memoryRuns.clear();
  memoryOpIndex.clear();
  memoryIdempotency.clear();
  memoryLatestRunByStore.clear();
  memoryQstashContinuations.clear();
  memoryQstashMessages.clear();
  memoryPendingNextContinuations.clear();
  memoryLock = null;
}
