import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "crypto";
import { getRedisConfig, getStoreId } from "./config";
import { canonicalizeModes, type ModeResult, type SyncMode } from "./sync-types";

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

const RUN_TTL_SECONDS = 14 * 24 * 60 * 60;
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_MS = 5 * 60 * 1000;

let redisClient: RedisClientType | null = null;
const memoryRuns = new Map<string, SyncRun>();
const memoryOpIndex = new Map<string, string>();
const memoryIdempotency = new Map<string, string>();
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

function lockKey(storeId: string) {
  return `sync:lock:${storeId}`;
}

function idempotencyKey(key: string) {
  return `sync:idempotency:${key}`;
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
        JSON.stringify({ event: "redis_error", error: error?.message ?? String(error) })
      );
    });
  }
  if (!redisClient.isOpen) await redisClient.connect();
  return redisClient;
}

async function saveMemoryRun(run: SyncRun) {
  memoryRuns.set(run.runId, run);
  if (run.activeBulkOperationId) memoryOpIndex.set(run.activeBulkOperationId, run.runId);
  if (["queued", "running", "waiting_bulk"].includes(run.status)) {
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

  const existingRunId = redis
    ? await redis.get(activeKey(storeId))
    : memoryIdempotency.get(activeKey(storeId));
  if (existingRunId) {
    const existingRun = await getSyncRun(existingRunId);
    if (existingRun && ["queued", "running", "waiting_bulk"].includes(existingRun.status)) {
      return {
        runId: existingRun.runId,
        accepted: false,
        status: "already_running",
        modes: existingRun.requestedModes,
        currentMode: existingRun.currentMode,
      };
    }
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
    await redis.set(runKey(run.runId), JSON.stringify(run), { EX: RUN_TTL_SECONDS });
    await redis.set(activeKey(storeId), run.runId, { EX: RUN_TTL_SECONDS });
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

export async function getRunIdForOperation(opId: string): Promise<string | null> {
  const redis = await getRedis();
  if (!redis) return memoryOpIndex.get(opId) ?? null;
  return await redis.get(opKey(opId));
}

export async function saveSyncRun(run: SyncRun, fencingToken?: string): Promise<void> {
  const redis = await getRedis();
  const existing = await getSyncRun(run.runId);
  if (existing && existing.version > run.version) {
    throw new Error(`stale sync run transition rejected: ${run.runId}`);
  }
  if (fencingToken) {
    const existingToken = existing?.fencingToken;
    if (existingToken && existingToken !== fencingToken) {
      throw new Error(`fencing token mismatch for sync run ${run.runId}`);
    }
    run.fencingToken = fencingToken;
  }
  run.updatedAt = nowIso();
  run.version += 1;
  if (!redis) {
    await saveMemoryRun(run);
    return;
  }
  await redis.set(runKey(run.runId), JSON.stringify(run), { EX: RUN_TTL_SECONDS });
  if (run.activeBulkOperationId) {
    await redis.set(opKey(run.activeBulkOperationId), run.runId, { EX: RUN_TTL_SECONDS });
  }
  if (["queued", "running", "waiting_bulk"].includes(run.status)) {
    await redis.set(activeKey(run.storeId), run.runId, { EX: RUN_TTL_SECONDS });
  } else {
    const activeRunId = await redis.get(activeKey(run.storeId));
    if (activeRunId === run.runId) await redis.del(activeKey(run.storeId));
  }
}

export async function acquireSyncLock(storeId = getStoreId()): Promise<string | null> {
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

export async function releaseSyncLock(token: string, storeId = getStoreId()): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    if (memoryLock?.token === token) memoryLock = null;
    return;
  }
  const existing = await redis.get(lockKey(storeId));
  if (existing === token) await redis.del(lockKey(storeId));
}

export async function markIdempotent(key: string, value: string): Promise<boolean> {
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

export async function listOpenRuns(): Promise<SyncRun[]> {
  const redis = await getRedis();
  if (!redis) {
    return Array.from(memoryRuns.values()).filter((run) =>
      ["queued", "running", "waiting_bulk"].includes(run.status)
    );
  }
  const keys = await redis.keys("sync:run:*");
  const runs: SyncRun[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const run = JSON.parse(raw) as SyncRun;
    if (["queued", "running", "waiting_bulk"].includes(run.status)) runs.push(run);
  }
  return runs;
}

export async function withSyncLock<T>(fn: (fencingToken: string) => Promise<T>): Promise<T | null> {
  const token = await acquireSyncLock();
  if (!token) return null;
  try {
    return await fn(token);
  } finally {
    await releaseSyncLock(token);
  }
}

export function __resetMemorySyncStateForTests(): void {
  memoryRuns.clear();
  memoryOpIndex.clear();
  memoryIdempotency.clear();
  memoryLock = null;
}
