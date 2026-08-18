import { createClient, type RedisClientType } from "redis";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "crypto";
import { getRedisConfig, getStoreId, getStoreIdAliases } from "./config";
import {
  canonicalizeModes,
  type SyncMode,
} from "./sync-types";
import type { SyncContinuationPayload } from "./qstash-sync";

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
  checkpointSequenceByMode?: Partial<Record<SyncMode, number>>;
  protectedSkippedByMode?: Partial<Record<SyncMode, number>>;
};

export type AcceptedRun = {
  runId: string;
  accepted: boolean;
  status: SyncRunStatus | "already_running" | "quarantined";
  modes: SyncMode[];
  currentMode: SyncMode | null;
};

export type SyncModeCheckpoint = {
  schemaVersion: 1;
  runId: string;
  mode: "prices" | "stock";
  currentIndex: number;
  sequence: number;
  phase: "scanning" | "ready_to_finalize";
  cursor: string | null;
  inputSnapshotKey: string;
  diffChunkSequences: number[];
  diffChunks: SyncDiffChunkMetadata[];
  pageCount: number;
  productCount: number;
  variantCount: number;
  counters: {
    proposed: number;
    variantsWithBarcodes?: number;
    variantsWith1cPrices?: number;
    variantsSkippedForNonPositive1cPrice?: number;
    discountRemovedCount?: number;
    currentlyActive?: number;
    proposedDraftFlips?: number;
    protectedProductsSkipped?: number;
  };
  draftFlipSamples?: Array<{ handle: string; barcode: string }>;
  continuationState: "needed" | "enqueued";
  continuationIdentity: {
    payload: Extract<SyncContinuationPayload, { kind: "continue-run" }>;
    deduplicationId: string;
    correlationId: string;
  } | null;
  updatedAt: string;
};

export type SyncDiffChunkMetadata = {
  sequence: number;
  count: number;
  hash: string;
  byteLength?: number;
};

export type SyncInputSnapshot = {
  schemaVersion: 1;
  inputVersion: 1;
  mode: "prices" | "stock";
  createdAt: string;
  payload: unknown;
};

export type SyncBulkLaunchIntent = {
  schemaVersion: 1;
  version: number;
  runId: string;
  mode: SyncMode;
  manifestHash: string;
  proposedCount: number;
  byteLength: number;
  clientIdentifier: string;
  stagedUploadIdentity: string;
  stagedUploadAttempt: number;
  uploadedAt: string | null;
  phase:
    | "prepared"
    | "uploaded"
    | "launch_requested"
    | "associated"
    | "ambiguous_failed";
  launchRequestedAt: string | null;
  operationId: string | null;
  failureReason: string | null;
};

export type SyncBulkQuarantine = {
  schemaVersion: 1;
  storeId: string;
  runId: string;
  mode: SyncMode;
  quarantineToken: string;
  manifestHash: string;
  clientIdentifier: string;
  knownOperationId: string | null;
  status: "ambiguous_launch";
  reason: string;
  launchRequestedAt: string;
  createdAt: string;
  noActiveCheckTimestamps: string[];
};

export type SyncBulkLaunchFence = {
  schemaVersion: 1;
  storeId: string;
  runId: string;
  mode: SyncMode;
  manifestHash: string;
  clientIdentifier: string;
  knownOperationId: string | null;
  createdAt: string;
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
// The launch fence must outlive every artifact needed to convert it into a
// clearable quarantine, but not forever: an unbounded fence can brick the store
// with no recovery path. No Shopify bulk mutation survives anywhere near this.
const BULK_LAUNCH_FENCE_TTL_SECONDS = 30 * 24 * 60 * 60;
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
const memoryModeCheckpoints = new Map<string, SyncModeCheckpoint>();
const memoryInputSnapshots = new Map<string, string>();
const memoryDiffChunks = new Map<string, string>();
const memoryLaunchIntents = new Map<string, SyncBulkLaunchIntent>();
const memoryBulkQuarantines = new Map<string, SyncBulkQuarantine>();
const memoryBulkLaunchFences = new Map<string, SyncBulkLaunchFence>();
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

export function syncCheckpointKey(runId: string, mode: "prices" | "stock") {
  return `sync:checkpoint:${runId}:${mode}`;
}

export function syncInputKey(runId: string, mode: "prices" | "stock") {
  return `sync:input:${runId}:${mode}`;
}

export function syncDiffKey(
  runId: string,
  mode: "prices" | "stock",
  sequence: number,
) {
  return `sync:diff:${runId}:${mode}:${sequence}`;
}

export function syncLaunchKey(runId: string, mode: SyncMode) {
  return `sync:launch:${runId}:${mode}`;
}

export function syncBulkQuarantineKey(storeId: string) {
  return `sync:bulk-quarantine:${storeId}`;
}

export function syncBulkLaunchFenceKey(storeId: string) {
  return `sync:bulk-launch-fence:${storeId}`;
}

function normalizeSyncRun(run: SyncRun): SyncRun {
  run.checkpointSequenceByMode ??= {};
  run.protectedSkippedByMode ??= {};
  return run;
}

function serializeArtifact(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
    throw new Error("sync durable artifact exceeds 16 MiB safety limit");
  }
  return serialized;
}

function artifactEncryptionKeys(): Array<{ id: string; key: Buffer }> {
  const previous = (process.env.SYNC_ARTIFACT_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const materials = [
    process.env.INTERNAL_API_KEY,
    ...previous,
    process.env.NODE_ENV === "test" ? "test-only-sync-cursor-key" : null,
  ].filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(materials));
  if (unique.length === 0) {
    throw new Error("INTERNAL_API_KEY is required to seal sync artifacts");
  }
  return unique.map((material) => {
    const key = createHash("sha256").update(material).digest();
    return { id: createHash("sha256").update(key).digest("hex").slice(0, 12), key };
  });
}

function sealCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  const primary = artifactEncryptionKeys()[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(cursor, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `enc:v2:${primary.id}:${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

function unsealCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  const match = /^enc:v(1|2):(?:([a-f0-9]{12}):)?(.+)$/.exec(cursor);
  if (!match?.[3]) {
    throw new Error("unsealed checkpoint cursor rejected");
  }
  const bytes = Buffer.from(match[3], "base64url");
  if (bytes.length < 29) throw new Error("invalid sealed checkpoint cursor");
  const candidates = artifactEncryptionKeys().filter(
    ({ id }) => !match[2] || id === match[2],
  );
  for (const { key } of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } catch {}
  }
  throw new Error("checkpoint cursor encryption key unavailable or invalid");
}

function sealSensitiveJson(value: unknown): string {
  const plaintext = serializeArtifact(value);
  const primary = artifactEncryptionKeys()[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `enc:v2:${primary.id}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

function unsealSensitiveJson<T>(sealed: string): T {
  const match = /^enc:v(1|2):(?:([a-f0-9]{12}):)?(.+)$/.exec(sealed);
  if (!match?.[3]) {
    throw new Error("unsealed sensitive sync artifact rejected");
  }
  const bytes = Buffer.from(match[3], "base64url");
  if (bytes.length < 29) throw new Error("invalid sealed sync artifact");
  const candidates = artifactEncryptionKeys().filter(
    ({ id }) => !match[2] || id === match[2],
  );
  for (const { key } of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {}
  }
  throw new Error("sync artifact encryption key unavailable or invalid");
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

function admitMemoryRun(run: SyncRun): AcceptedRun {
  const aliases = Array.from(new Set(getStoreIdAliases()));
  const quarantine = aliases
    .map((storeId) => memoryBulkQuarantines.get(syncBulkQuarantineKey(storeId)))
    .find(Boolean);
  const launchFence = aliases
    .map((storeId) => memoryBulkLaunchFences.get(syncBulkLaunchFenceKey(storeId)))
    .find(Boolean);
  if (quarantine || launchFence) {
    return {
      runId: quarantine?.runId ?? launchFence!.runId,
      accepted: false,
      status: "quarantined",
      modes: run.requestedModes,
      currentMode: run.currentMode,
    };
  }

  for (const alias of getStoreIdAliases()) {
    const existingRunId = memoryIdempotency.get(activeKey(alias));
    const existingRun = existingRunId
      ? memoryRuns.get(existingRunId)
      : undefined;
    if (!existingRun || !isOpenRun(existingRun)) continue;
    memoryIdempotency.set(activeKey(run.storeId), existingRun.runId);
    return {
      runId: existingRun.runId,
      accepted: false,
      status: "already_running",
      modes: existingRun.requestedModes,
      currentMode: existingRun.currentMode,
    };
  }

  memoryRuns.set(run.runId, run);
  memoryLatestRunByStore.set(run.storeId, run.runId);
  if (isOpenRun(run)) {
    memoryIdempotency.set(activeKey(run.storeId), run.runId);
  }
  return {
    runId: run.runId,
    accepted: true,
    status: run.status,
    modes: run.requestedModes,
    currentMode: run.currentMode,
  };
}

async function admitRedisRun(
  redis: RedisClientType,
  run: SyncRun,
): Promise<AcceptedRun> {
  const aliases = Array.from(new Set(getStoreIdAliases()));
  const quarantineKeys = aliases.map(syncBulkQuarantineKey);
  const fenceKeys = aliases.map(syncBulkLaunchFenceKey);
  const aliasActiveKeys = aliases.map(activeKey);
  const fixedKeys = [runKey(run.runId), activeKey(run.storeId), latestKey(run.storeId)];
  const keys = [...quarantineKeys, ...fenceKeys, ...fixedKeys, ...aliasActiveKeys];
  const blockerEnd = quarantineKeys.length + fenceKeys.length;
  const runKeyIndex = blockerEnd + 1;
  const activeKeyIndex = runKeyIndex + 1;
  const latestKeyIndex = activeKeyIndex + 1;
  const activeAliasStart = latestKeyIndex + 1;
  const rawResult = await redis.eval(
    `local blockerEnd = tonumber(ARGV[6])
     local runKeyIndex = tonumber(ARGV[7])
     local activeKeyIndex = tonumber(ARGV[8])
     local latestKeyIndex = tonumber(ARGV[9])
     local activeAliasStart = tonumber(ARGV[10])
     for index = 1, blockerEnd do
       local blockerRaw = redis.call('GET', KEYS[index])
       if blockerRaw then
         local blocker = cjson.decode(blockerRaw)
         return cjson.encode({status = 'quarantined', runId = blocker.runId})
       end
     end
     for index = activeAliasStart, #KEYS do
       local activeRunId = redis.call('GET', KEYS[index])
       if activeRunId then
         local activeRunRaw = redis.call('GET', ARGV[4] .. activeRunId)
         if activeRunRaw then
           local activeRun = cjson.decode(activeRunRaw)
           if activeRun.status == 'queued' or activeRun.status == 'running' or activeRun.status == 'waiting_bulk' then
             redis.call('SET', KEYS[activeKeyIndex], activeRunId, 'EX', ARGV[1])
             return cjson.encode({status = 'already_running', run = activeRunRaw})
           end
         end
       end
     end
     redis.call('SET', KEYS[runKeyIndex], ARGV[2], 'EX', ARGV[1])
     if ARGV[5] == '1' then
       redis.call('SET', KEYS[activeKeyIndex], ARGV[3], 'EX', ARGV[1])
     end
     redis.call('SET', KEYS[latestKeyIndex], ARGV[3], 'EX', ARGV[1])
     return cjson.encode({status = 'accepted'})`,
    {
      keys,
      arguments: [
        String(RUN_TTL_SECONDS),
        serializeArtifact(run),
        run.runId,
        runKey(""),
        isOpenRun(run) ? "1" : "0",
        String(blockerEnd),
        String(runKeyIndex),
        String(activeKeyIndex),
        String(latestKeyIndex),
        String(activeAliasStart),
      ],
    },
  );
  const result = JSON.parse(String(rawResult)) as {
    status: "accepted" | "already_running" | "quarantined";
    runId?: string;
    run?: string;
  };
  if (result.status === "already_running") {
    if (!result.run) throw new Error("active sync run admission result is invalid");
    const existingRun = normalizeSyncRun(JSON.parse(result.run) as SyncRun);
    return {
      runId: existingRun.runId,
      accepted: false,
      status: "already_running",
      modes: existingRun.requestedModes,
      currentMode: existingRun.currentMode,
    };
  }
  if (result.status === "quarantined") {
    if (!result.runId) throw new Error("quarantined sync admission result is invalid");
    return {
      runId: result.runId,
      accepted: false,
      status: "quarantined",
      modes: run.requestedModes,
      currentMode: run.currentMode,
    };
  }
  if (result.status !== "accepted") {
    throw new Error("unknown sync run admission result");
  }
  return {
    runId: run.runId,
    accepted: true,
    status: run.status,
    modes: run.requestedModes,
    currentMode: run.currentMode,
  };
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
    checkpointSequenceByMode: {},
    protectedSkippedByMode: {},
  };

  return redis ? await admitRedisRun(redis, run) : admitMemoryRun(run);
}

export async function getSyncRun(runId: string): Promise<SyncRun | null> {
  const redis = await getRedis();
  if (!redis) {
    const run = memoryRuns.get(runId);
    return run ? normalizeSyncRun(run) : null;
  }
  const raw = await redis.get(runKey(runId));
  if (!raw) return null;
  return normalizeSyncRun(JSON.parse(raw) as SyncRun);
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
      const run = normalizeSyncRun(JSON.parse(raw) as SyncRun);
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
  await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
       return redis.call('DEL', KEYS[1])
     end
     return 0`,
    { keys: [lockKey(storeId)], arguments: [token] },
  );
}

export async function markIdempotent(
  key: string,
  value: string,
  ttlSeconds = IDEMPOTENCY_TTL_SECONDS,
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
    EX: ttlSeconds,
  });
  return written === "OK";
}

export async function markRunIdempotent(
  key: string,
  value: string,
): Promise<boolean> {
  return await markIdempotent(key, value, RUN_TTL_SECONDS);
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

export async function failPendingNextContinuationIfCurrent({
  expected,
  reason,
}: {
  expected: PendingNextContinuation;
  reason: string;
}): Promise<"applied" | "stale" | "missing" | "lock_busy"> {
  const initial = await getSyncRun(expected.runId);
  if (!initial) return "missing";
  const fencingToken = await acquireSyncLock(initial.storeId);
  if (!fencingToken) return "lock_busy";
  try {
    const redis = await getRedis();
    const matches = (run: SyncRun, pending: PendingNextContinuation) =>
      run.version === expected.runVersion && run.status === "queued" &&
      run.currentIndex === expected.currentIndex && run.currentMode === expected.currentMode &&
      run.activeBulkOperationId === null && pending.opId === expected.opId &&
      pending.runId === expected.runId && pending.runVersion === expected.runVersion &&
      pending.currentIndex === expected.currentIndex && pending.currentMode === expected.currentMode &&
      pending.state === expected.state && pending.qstashCorrelationId === expected.qstashCorrelationId &&
      pending.qstashMessageId === expected.qstashMessageId;
    if (!redis) {
      const run = memoryRuns.get(expected.runId);
      const pending = memoryPendingNextContinuations.get(expected.opId);
      if (!run || !pending) return "missing";
      if (!matches(run, pending)) return "stale";
      await saveMemoryRun({ ...run, status: "failed", failureReason: reason,
        activeBulkOperationId: null, activeBulkOperationType: null, fencingToken,
        updatedAt: nowIso(), version: run.version + 1 });
      return "applied";
    }
    const next = { ...initial, status: "failed" as const, failureReason: reason,
      activeBulkOperationId: null, activeBulkOperationType: null, fencingToken,
      updatedAt: nowIso(), version: initial.version + 1 };
    const result = await redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -2 end
       local runRaw = redis.call('GET', KEYS[2]); local pendingRaw = redis.call('GET', KEYS[3])
       if not runRaw or not pendingRaw then return -1 end
       local run = cjson.decode(runRaw); local pending = cjson.decode(pendingRaw)
       if tonumber(run.version) ~= tonumber(ARGV[2]) or run.status ~= 'queued' or
          tonumber(run.currentIndex) ~= tonumber(ARGV[3]) or run.currentMode ~= ARGV[4] or
          run.activeBulkOperationId ~= cjson.null or pending.opId ~= ARGV[5] or
          pending.runId ~= ARGV[6] or tonumber(pending.runVersion) ~= tonumber(ARGV[2]) or
          tonumber(pending.currentIndex) ~= tonumber(ARGV[3]) or pending.currentMode ~= ARGV[4] or
          pending.state ~= ARGV[7] or
          (ARGV[8] == '' and pending.qstashCorrelationId ~= cjson.null) or
          (ARGV[8] ~= '' and pending.qstashCorrelationId ~= ARGV[8]) or
          (ARGV[9] == '' and pending.qstashMessageId ~= cjson.null) or
          (ARGV[9] ~= '' and pending.qstashMessageId ~= ARGV[9]) then return 0 end
       redis.call('SET', KEYS[2], ARGV[10], 'EX', ARGV[11])
       if redis.call('GET', KEYS[4]) == ARGV[6] then redis.call('DEL', KEYS[4]) end
       return 1`,
      { keys: [lockKey(initial.storeId), runKey(expected.runId), pendingNextKey(expected.opId), activeKey(initial.storeId)],
        arguments: [fencingToken, String(expected.runVersion), String(expected.currentIndex),
          expected.currentMode, expected.opId, expected.runId, expected.state,
          expected.qstashCorrelationId ?? "", expected.qstashMessageId ?? "",
          serializeArtifact(next), String(RUN_TTL_SECONDS)] },
    );
    if (Number(result) === 1) return "applied";
    if (Number(result) === -1) return "missing";
    if (Number(result) === -2) return "lock_busy";
    return "stale";
  } finally {
    await releaseSyncLock(fencingToken, initial.storeId);
  }
}

export async function getModeCheckpoint(
  runId: string,
  mode: "prices" | "stock",
): Promise<SyncModeCheckpoint | null> {
  const key = syncCheckpointKey(runId, mode);
  const redis = await getRedis();
  if (!redis) {
    const checkpoint = memoryModeCheckpoints.get(key);
    return checkpoint
      ? { ...checkpoint, cursor: unsealCursor(checkpoint.cursor) }
      : null;
  }
  const raw = await redis.get(key);
  if (!raw) return null;
  const checkpoint = JSON.parse(raw) as SyncModeCheckpoint;
  return { ...checkpoint, cursor: unsealCursor(checkpoint.cursor) };
}

export async function saveModeCheckpoint(
  checkpoint: SyncModeCheckpoint,
): Promise<void> {
  const key = syncCheckpointKey(checkpoint.runId, checkpoint.mode);
  const persistedCheckpoint = {
    ...checkpoint,
    cursor: sealCursor(checkpoint.cursor),
  };
  const value = serializeArtifact(persistedCheckpoint);
  const redis = await getRedis();
  if (!redis) {
    memoryModeCheckpoints.set(key, persistedCheckpoint);
    return;
  }
  await redis.set(key, value, { EX: RUN_TTL_SECONDS });
}

export async function deleteModeCheckpoint(
  runId: string,
  mode: "prices" | "stock",
): Promise<void> {
  const key = syncCheckpointKey(runId, mode);
  const redis = await getRedis();
  if (!redis) {
    memoryModeCheckpoints.delete(key);
    return;
  }
  await redis.del(key);
}

export async function getInputSnapshot(
  runId: string,
  mode: "prices" | "stock",
): Promise<SyncInputSnapshot | null> {
  const key = syncInputKey(runId, mode);
  const redis = await getRedis();
  if (!redis) {
    const sealed = memoryInputSnapshots.get(key);
    return sealed ? unsealSensitiveJson<SyncInputSnapshot>(sealed) : null;
  }
  const raw = await redis.get(key);
  return raw ? unsealSensitiveJson<SyncInputSnapshot>(raw) : null;
}

export async function saveInputSnapshotIfAbsent(
  runId: string,
  snapshot: SyncInputSnapshot,
): Promise<boolean> {
  const resolvedKey = syncInputKey(runId, snapshot.mode);
  const value = sealSensitiveJson({
    schemaVersion: snapshot.schemaVersion,
    inputVersion: snapshot.inputVersion,
    mode: snapshot.mode,
    createdAt: snapshot.createdAt,
    payload: snapshot.payload,
  });
  const redis = await getRedis();
  if (!redis) {
    if (memoryInputSnapshots.has(resolvedKey)) return false;
    memoryInputSnapshots.set(resolvedKey, value);
    return true;
  }
  const result = await redis.set(resolvedKey, value, {
    NX: true,
    EX: RUN_TTL_SECONDS,
  });
  return result === "OK";
}

export async function saveDiffChunk(
  runId: string,
  mode: "prices" | "stock",
  sequence: number,
  updates: unknown[],
): Promise<SyncDiffChunkMetadata> {
  const key = syncDiffKey(runId, mode, sequence);
  const plaintext = serializeArtifact(updates);
  const metadata = {
    sequence,
    count: updates.length,
    hash: createHash("sha256").update(plaintext).digest("hex"),
    byteLength: Buffer.byteLength(plaintext),
  };
  const value = sealSensitiveJson(updates);
  const redis = await getRedis();
  if (!redis) {
    memoryDiffChunks.set(key, value);
    return metadata;
  }
  await redis.set(key, value, { EX: RUN_TTL_SECONDS });
  return metadata;
}

export async function getDiffChunk<T>(
  runId: string,
  mode: "prices" | "stock",
  sequence: number,
): Promise<T[]> {
  const key = syncDiffKey(runId, mode, sequence);
  const redis = await getRedis();
  if (!redis) {
    const sealed = memoryDiffChunks.get(key);
    return sealed ? unsealSensitiveJson<T[]>(sealed) : [];
  }
  const raw = await redis.get(key);
  return raw ? unsealSensitiveJson<T[]>(raw) : [];
}

export async function getVerifiedDiffChunk<T>(
  runId: string,
  mode: "prices" | "stock",
  expected: SyncDiffChunkMetadata,
): Promise<T[]> {
  const key = syncDiffKey(runId, mode, expected.sequence);
  const redis = await getRedis();
  const raw = redis ? await redis.get(key) : memoryDiffChunks.get(key);
  if (!raw) throw new Error(`sync diff chunk ${expected.sequence} is missing`);
  let updates: T[];
  try {
    updates = unsealSensitiveJson<T[]>(raw);
  } catch (error: any) {
    throw new Error(`sync diff chunk ${expected.sequence} is corrupt: ${error?.message ?? String(error)}`);
  }
  const plaintext = serializeArtifact(updates);
  const hash = createHash("sha256").update(plaintext).digest("hex");
  if (updates.length !== expected.count || hash !== expected.hash) {
    throw new Error(`sync diff chunk ${expected.sequence} failed count/hash verification`);
  }
  return updates;
}

export async function getBulkLaunchFence(
  storeId = getStoreId(),
): Promise<SyncBulkLaunchFence | null> {
  const key = syncBulkLaunchFenceKey(storeId);
  const redis = await getRedis();
  if (!redis) return memoryBulkLaunchFences.get(key) ?? null;
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as SyncBulkLaunchFence) : null;
}

export async function markLaunchRequestedWithFence(
  intent: SyncBulkLaunchIntent,
  storeId: string,
  fencingToken: string,
  expectedRunVersion: number,
  expectedCurrentIndex: number,
): Promise<SyncBulkLaunchFence> {
  if (intent.phase !== "launch_requested") {
    throw new Error("launch fence requires launch_requested intent");
  }
  const fence: SyncBulkLaunchFence = {
    schemaVersion: 1,
    storeId,
    runId: intent.runId,
    mode: intent.mode,
    manifestHash: intent.manifestHash,
    clientIdentifier: intent.clientIdentifier,
    knownOperationId: null,
    createdAt: intent.launchRequestedAt ?? nowIso(),
  };
  const redis = await getRedis();
  if (!redis) {
    const run = memoryRuns.get(intent.runId);
    if (
      memoryLock?.token !== fencingToken ||
      !run ||
      run.version !== expectedRunVersion ||
      run.status !== "running" ||
      run.currentMode !== intent.mode ||
      run.currentIndex !== expectedCurrentIndex ||
      memoryBulkQuarantines.has(syncBulkQuarantineKey(storeId))
    ) {
      throw new Error("launch fence preconditions changed");
    }
    const existing = memoryBulkLaunchFences.get(syncBulkLaunchFenceKey(storeId));
    if (
      existing &&
      (existing.runId !== intent.runId ||
        existing.mode !== intent.mode ||
        existing.manifestHash !== intent.manifestHash ||
        existing.clientIdentifier !== intent.clientIdentifier)
    ) {
      throw new Error(`store is already fenced by an incompatible launch`);
    }
    memoryLaunchIntents.set(syncLaunchKey(intent.runId, intent.mode), intent);
    memoryBulkLaunchFences.set(syncBulkLaunchFenceKey(storeId), fence);
    return fence;
  }
  const result = await redis.eval(
    `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     local runRaw = redis.call('GET', KEYS[2])
     if not runRaw then return 0 end
     local run = cjson.decode(runRaw)
     if tonumber(run.version) ~= tonumber(ARGV[2]) then return 0 end
     if run.status ~= 'running' or run.currentMode ~= ARGV[3] then return 0 end
     if tonumber(run.currentIndex) ~= tonumber(ARGV[4]) then return 0 end
     if redis.call('GET', KEYS[5]) then return 0 end
     local existingRaw = redis.call('GET', KEYS[4])
     if existingRaw then
       local existing = cjson.decode(existingRaw)
       if existing.runId ~= ARGV[5] or existing.mode ~= ARGV[3] or
          existing.manifestHash ~= ARGV[9] or existing.clientIdentifier ~= ARGV[10] then return 0 end
     end
     redis.call('SET', KEYS[3], ARGV[6], 'EX', ARGV[8])
     redis.call('SET', KEYS[4], ARGV[7], 'EX', ARGV[11])
     return 1`,
    {
      keys: [
        lockKey(storeId),
        runKey(intent.runId),
        syncLaunchKey(intent.runId, intent.mode),
        syncBulkLaunchFenceKey(storeId),
        syncBulkQuarantineKey(storeId),
      ],
      arguments: [
        fencingToken,
        String(expectedRunVersion),
        intent.mode,
        String(expectedCurrentIndex),
        intent.runId,
        serializeArtifact(intent),
        serializeArtifact(fence),
        String(RUN_TTL_SECONDS),
        intent.manifestHash,
        intent.clientIdentifier,
        String(BULK_LAUNCH_FENCE_TTL_SECONDS),
      ],
    },
  );
  if (Number(result) !== 1) throw new Error("launch fence preconditions changed");
  return fence;
}

export async function updateBulkLaunchFenceKnownOperation(
  storeId: string,
  runId: string,
  operationId: string,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    const fence = memoryBulkLaunchFences.get(syncBulkLaunchFenceKey(storeId));
    if (!fence || fence.runId !== runId) return;
    const next = { ...fence, knownOperationId: operationId };
    memoryBulkLaunchFences.set(syncBulkLaunchFenceKey(storeId), next);
    return;
  }
  await redis.eval(
    `local raw = redis.call('GET', KEYS[1])
     if not raw then return 0 end
     local fence = cjson.decode(raw)
     if fence.runId ~= ARGV[1] then return 0 end
     fence.knownOperationId = ARGV[2]
     redis.call('SET', KEYS[1], cjson.encode(fence), 'KEEPTTL')
     return 1`,
    {
      keys: [syncBulkLaunchFenceKey(storeId)],
      arguments: [runId, operationId],
    },
  );
}

export async function getLaunchIntent(
  runId: string,
  mode: SyncMode,
): Promise<SyncBulkLaunchIntent | null> {
  const key = syncLaunchKey(runId, mode);
  const redis = await getRedis();
  if (!redis) return memoryLaunchIntents.get(key) ?? null;
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as SyncBulkLaunchIntent) : null;
}

export async function saveLaunchIntent(
  intent: SyncBulkLaunchIntent,
): Promise<void> {
  const key = syncLaunchKey(intent.runId, intent.mode);
  const value = serializeArtifact(intent);
  const redis = await getRedis();
  if (!redis) {
    memoryLaunchIntents.set(key, intent);
    return;
  }
  await redis.set(key, value, { EX: RUN_TTL_SECONDS });
}

export async function getBulkQuarantine(
  storeId = getStoreId(),
): Promise<SyncBulkQuarantine | null> {
  const key = syncBulkQuarantineKey(storeId);
  const redis = await getRedis();
  if (!redis) return memoryBulkQuarantines.get(key) ?? null;
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as SyncBulkQuarantine) : null;
}

export type SyncAdmissionBlocker = {
  storeId: string;
  quarantine: SyncBulkQuarantine | null;
  launchFence: SyncBulkLaunchFence | null;
};

export async function getSyncAdmissionBlocker(
  storeIds: string[] = Array.from(new Set(getStoreIdAliases())),
): Promise<SyncAdmissionBlocker | null> {
  const aliases = Array.from(new Set(storeIds));
  for (const storeId of aliases) {
    const quarantine = await getBulkQuarantine(storeId);
    if (!quarantine) continue;
    return {
      storeId,
      quarantine,
      launchFence: await getBulkLaunchFence(storeId),
    };
  }
  for (const storeId of aliases) {
    const launchFence = await getBulkLaunchFence(storeId);
    if (!launchFence) continue;
    return { storeId, quarantine: null, launchFence };
  }
  return null;
}

export async function saveBulkQuarantine(
  quarantine: SyncBulkQuarantine,
): Promise<void> {
  const key = syncBulkQuarantineKey(quarantine.storeId);
  const value = serializeArtifact(quarantine);
  const redis = await getRedis();
  if (!redis) {
    memoryBulkQuarantines.set(key, quarantine);
    return;
  }
  await redis.set(key, value);
}

export async function saveBulkQuarantineIfCurrent(
  quarantine: SyncBulkQuarantine,
  expectedRunId: string,
  expectedToken: string,
): Promise<boolean> {
  const key = syncBulkQuarantineKey(quarantine.storeId);
  const redis = await getRedis();
  if (!redis) {
    const current = memoryBulkQuarantines.get(key);
    if (
      current?.runId !== expectedRunId ||
      current.quarantineToken !== expectedToken
    ) return false;
    memoryBulkQuarantines.set(key, quarantine);
    return true;
  }
  const result = await redis.eval(
    `local raw = redis.call('GET', KEYS[1])
     if not raw then return 0 end
     local current = cjson.decode(raw)
     if current.runId ~= ARGV[1] or current.quarantineToken ~= ARGV[2] then return 0 end
     redis.call('SET', KEYS[1], ARGV[3])
     return 1`,
    { keys: [key], arguments: [expectedRunId, expectedToken, serializeArtifact(quarantine)] },
  );
  return Number(result) === 1;
}

export async function deleteBulkQuarantine(
  storeId: string,
  expectedRunId: string,
  expectedToken: string,
): Promise<boolean> {
  const key = syncBulkQuarantineKey(storeId);
  const redis = await getRedis();
  if (!redis) {
    const current = memoryBulkQuarantines.get(key);
    if (current?.runId !== expectedRunId || current.quarantineToken !== expectedToken) return false;
    memoryBulkQuarantines.delete(key);
    const fenceKey = syncBulkLaunchFenceKey(storeId);
    if (memoryBulkLaunchFences.get(fenceKey)?.runId === expectedRunId) {
      memoryBulkLaunchFences.delete(fenceKey);
    }
    return true;
  }
  const result = await redis.eval(
    `local raw = redis.call('GET', KEYS[1])
     if not raw then return 0 end
     local value = cjson.decode(raw)
     if value.runId ~= ARGV[1] or value.quarantineToken ~= ARGV[2] then return 0 end
     redis.call('DEL', KEYS[1])
     local fenceRaw = redis.call('GET', KEYS[2])
     if fenceRaw then
       local fence = cjson.decode(fenceRaw)
       if fence.runId == ARGV[1] then redis.call('DEL', KEYS[2]) end
     end
     return 1`,
    { keys: [key, syncBulkLaunchFenceKey(storeId)], arguments: [expectedRunId, expectedToken] },
  );
  return Number(result) === 1;
}

export const STRANDED_FENCE_ADOPTION_REASON =
  "Adopted a stranded bulk launch fence that had no quarantine record; the launch outcome is unknown";

function quarantineFromFence(
  fence: SyncBulkLaunchFence,
  storeId: string,
): SyncBulkQuarantine {
  return {
    schemaVersion: 1,
    storeId,
    runId: fence.runId,
    mode: fence.mode,
    quarantineToken: randomUUID(),
    manifestHash: fence.manifestHash,
    clientIdentifier: fence.clientIdentifier,
    knownOperationId: fence.knownOperationId ?? null,
    status: "ambiguous_launch",
    reason: STRANDED_FENCE_ADOPTION_REASON,
    launchRequestedAt: fence.createdAt,
    // Inherit the fence's age rather than restarting the clock, so adoption
    // never pushes the reconciler's minimum quarantine age further out.
    createdAt: fence.createdAt,
    noActiveCheckTimestamps: [],
  };
}

function adoptMemoryLaunchFence(storeId: string): SyncBulkQuarantine | null {
  const quarantineKey = syncBulkQuarantineKey(storeId);
  const fence = memoryBulkLaunchFences.get(syncBulkLaunchFenceKey(storeId));
  if (!fence || memoryBulkQuarantines.has(quarantineKey)) return null;
  const quarantine = quarantineFromFence(fence, storeId);
  memoryBulkQuarantines.set(quarantineKey, quarantine);
  return quarantine;
}

async function adoptRedisLaunchFence(
  redis: RedisClientType,
  storeId: string,
): Promise<SyncBulkQuarantine | null> {
  const fenceKey = syncBulkLaunchFenceKey(storeId);
  const raw = await redis.get(fenceKey);
  if (!raw) return null;
  const quarantine = quarantineFromFence(
    JSON.parse(raw) as SyncBulkLaunchFence,
    storeId,
  );
  // Compare-and-set on the exact bytes read: the quarantine JSON is built in
  // TypeScript because cjson.encode turns an empty array into `{}`, which would
  // corrupt noActiveCheckTimestamps.
  const result = await redis.eval(
    `local fenceRaw = redis.call('GET', KEYS[1])
     if not fenceRaw or fenceRaw ~= ARGV[1] then return 0 end
     if redis.call('GET', KEYS[2]) then return 0 end
     redis.call('SET', KEYS[2], ARGV[2])
     return 1`,
    {
      keys: [fenceKey, syncBulkQuarantineKey(storeId)],
      arguments: [raw, serializeArtifact(quarantine)],
    },
  );
  return Number(result) === 1 ? quarantine : null;
}

/**
 * Converts a launch fence that has no matching quarantine record into a real,
 * clearable quarantine.
 *
 * A fence blocks admission on its own (see admitRedisRun), but only
 * deleteBulkQuarantine removes it, and that needs a quarantine plus its token.
 * The fence also outlives the run and intent that markAmbiguousBulkLaunchAtomically
 * requires, so once those expire nothing else can produce that quarantine.
 * Without this, a fence stranded by a dead invocation blocks every future sync
 * with no recovery path short of editing Redis by hand.
 */
export async function adoptStrandedLaunchFence(
  storeIds: string[] = Array.from(new Set(getStoreIdAliases())),
): Promise<SyncBulkQuarantine | null> {
  const redis = await getRedis();
  for (const storeId of storeIds) {
    const adopted = redis
      ? await adoptRedisLaunchFence(redis, storeId)
      : adoptMemoryLaunchFence(storeId);
    if (adopted) return adopted;
  }
  return null;
}

export async function deleteModeArtifactsAfterAssociation(
  runId: string,
  mode: "prices" | "stock",
  sequences: number[],
): Promise<void> {
  const keys = [
    syncCheckpointKey(runId, mode),
    syncInputKey(runId, mode),
    ...sequences.map((sequence) => syncDiffKey(runId, mode, sequence)),
  ];
  const redis = await getRedis();
  if (!redis) {
    keys.forEach((key) => {
      memoryModeCheckpoints.delete(key);
      memoryInputSnapshots.delete(key);
      memoryDiffChunks.delete(key);
    });
    return;
  }
  if (keys.length > 0) await redis.del(keys);
}

export async function associateBulkOperationAtomically({
  runId,
  mode,
  operationId,
  proposedCount,
  expectedRunVersion,
  expectedCurrentIndex,
  expectedIntentVersion,
  expectedManifestHash,
  fencingToken,
}: {
  runId: string;
  mode: SyncMode;
  operationId: string;
  proposedCount: number;
  expectedRunVersion: number;
  expectedCurrentIndex: number;
  expectedIntentVersion: number;
  expectedManifestHash: string;
  fencingToken: string;
}): Promise<boolean> {
  const redis = await getRedis();
  const run = await getSyncRun(runId);
  const intent = await getLaunchIntent(runId, mode);
  if (!run || !intent) return false;

  const nextRun: SyncRun = {
    ...run,
    status: "waiting_bulk",
    activeBulkOperationId: operationId,
    activeBulkOperationType: "MUTATION",
    proposedByMode: { ...run.proposedByMode, [mode]: proposedCount },
    appliedByMode: { ...run.appliedByMode, [mode]: 0 },
    fencingToken,
    updatedAt: nowIso(),
    version: run.version + 1,
  };
  const nextIntent: SyncBulkLaunchIntent = {
    ...intent,
    version: intent.version + 1,
    phase: "associated",
    operationId,
    failureReason: null,
  };

  if (!redis) {
    if (
      memoryLock?.token !== fencingToken ||
      run.version !== expectedRunVersion ||
      run.currentIndex !== expectedCurrentIndex ||
      run.status !== "running" ||
      run.currentMode !== mode ||
      intent.version !== expectedIntentVersion ||
      intent.phase !== "launch_requested" ||
      intent.manifestHash !== expectedManifestHash ||
      intent.proposedCount !== proposedCount
    ) {
      return false;
    }
    const conflictingRun = memoryOpIndex.get(operationId);
    if (conflictingRun && conflictingRun !== runId) return false;
    await saveMemoryRun(nextRun);
    memoryLaunchIntents.set(syncLaunchKey(runId, mode), nextIntent);
    memoryOpIndex.set(operationId, runId);
    memoryBulkLaunchFences.delete(syncBulkLaunchFenceKey(run.storeId));
    return true;
  }

  const result = await redis.eval(
    `local lock = redis.call('GET', KEYS[1])
     if lock ~= ARGV[1] then return 0 end
     local runRaw = redis.call('GET', KEYS[2])
     local intentRaw = redis.call('GET', KEYS[3])
     if not runRaw or not intentRaw then return 0 end
     local run = cjson.decode(runRaw)
     local intent = cjson.decode(intentRaw)
     if tonumber(run.version) ~= tonumber(ARGV[2]) then return 0 end
     if run.status ~= 'running' or run.currentMode ~= ARGV[3] then return 0 end
     if tonumber(run.currentIndex) ~= tonumber(ARGV[4]) then return 0 end
     if tonumber(intent.version) ~= tonumber(ARGV[5]) then return 0 end
     if intent.phase ~= 'launch_requested' then return 0 end
     if intent.manifestHash ~= ARGV[6] then return 0 end
     if tonumber(intent.proposedCount) ~= tonumber(ARGV[7]) then return 0 end
     local opRun = redis.call('GET', KEYS[4])
     if opRun and opRun ~= ARGV[8] then return 0 end
     redis.call('SET', KEYS[2], ARGV[9], 'EX', ARGV[11])
     redis.call('SET', KEYS[3], ARGV[10], 'EX', ARGV[11])
     redis.call('SET', KEYS[4], ARGV[8], 'EX', ARGV[11])
     redis.call('DEL', KEYS[5])
     return 1`,
    {
      keys: [
        lockKey(run.storeId),
        runKey(runId),
        syncLaunchKey(runId, mode),
        opKey(operationId),
        syncBulkLaunchFenceKey(run.storeId),
      ],
      arguments: [
        fencingToken,
        String(expectedRunVersion),
        mode,
        String(expectedCurrentIndex),
        String(expectedIntentVersion),
        expectedManifestHash,
        String(proposedCount),
        runId,
        serializeArtifact(nextRun),
        serializeArtifact(nextIntent),
        String(RUN_TTL_SECONDS),
      ],
    },
  );
  return Number(result) === 1;
}

export async function markAmbiguousBulkLaunchAtomically({
  runId,
  mode,
  reason,
  fencingToken,
  knownOperationId = null,
}: {
  runId: string;
  mode: SyncMode;
  reason: string;
  fencingToken: string;
  knownOperationId?: string | null;
}): Promise<SyncBulkQuarantine> {
  const redis = await getRedis();
  const run = await getSyncRun(runId);
  const intent = await getLaunchIntent(runId, mode);
  if (!run || !intent) {
    throw new Error("cannot fence ambiguous bulk launch without run and intent");
  }
  const existing = await getBulkQuarantine(run.storeId);
  if (
    existing?.runId === runId &&
    intent.phase === "ambiguous_failed"
  ) {
    return existing;
  }
  if (intent.phase !== "launch_requested") {
    throw new Error(`ambiguous launch fence requires launch_requested, got ${intent.phase}`);
  }

  const now = nowIso();
  const quarantine: SyncBulkQuarantine = {
    schemaVersion: 1,
    storeId: run.storeId,
    runId,
    mode,
    quarantineToken: randomUUID(),
    manifestHash: intent.manifestHash,
    clientIdentifier: intent.clientIdentifier,
    knownOperationId,
    status: "ambiguous_launch",
    reason,
    launchRequestedAt: intent.launchRequestedAt ?? now,
    createdAt: now,
    noActiveCheckTimestamps: [],
  };
  const nextRun: SyncRun = {
    ...run,
    status: "failed",
    failureReason: reason,
    activeBulkOperationId: null,
    activeBulkOperationType: null,
    fencingToken,
    updatedAt: now,
    version: run.version + 1,
  };
  const nextIntent: SyncBulkLaunchIntent = {
    ...intent,
    version: intent.version + 1,
    phase: "ambiguous_failed",
    failureReason: reason,
  };

  if (!redis) {
    if (memoryLock?.token !== fencingToken) {
      throw new Error("ambiguous launch fence lost sync lock");
    }
    await saveMemoryRun(nextRun);
    memoryLaunchIntents.set(syncLaunchKey(runId, mode), nextIntent);
    memoryBulkQuarantines.set(
      syncBulkQuarantineKey(run.storeId),
      quarantine,
    );
    const fence = memoryBulkLaunchFences.get(syncBulkLaunchFenceKey(run.storeId));
    if (fence?.runId === runId) {
      memoryBulkLaunchFences.set(syncBulkLaunchFenceKey(run.storeId), {
        ...fence,
        knownOperationId: knownOperationId ?? fence.knownOperationId,
      });
    }
    return quarantine;
  }

  const result = await redis.eval(
    `local lock = redis.call('GET', KEYS[1])
     if lock ~= ARGV[1] then return 0 end
     local runRaw = redis.call('GET', KEYS[2])
     local intentRaw = redis.call('GET', KEYS[3])
     if not runRaw or not intentRaw then return 0 end
     local intent = cjson.decode(intentRaw)
     if intent.phase ~= 'launch_requested' then return 0 end
     redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[5])
     redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[5])
     redis.call('SET', KEYS[4], ARGV[4])
     local fenceRaw = redis.call('GET', KEYS[6])
     if fenceRaw and ARGV[7] ~= '' then
       local fence = cjson.decode(fenceRaw)
       if fence.runId == ARGV[6] then
         fence.knownOperationId = ARGV[7]
         redis.call('SET', KEYS[6], cjson.encode(fence), 'KEEPTTL')
       end
     end
     local active = redis.call('GET', KEYS[5])
     if active == ARGV[6] then redis.call('DEL', KEYS[5]) end
     return 1`,
    {
      keys: [
        lockKey(run.storeId),
        runKey(runId),
        syncLaunchKey(runId, mode),
        syncBulkQuarantineKey(run.storeId),
        activeKey(run.storeId),
        syncBulkLaunchFenceKey(run.storeId),
      ],
      arguments: [
        fencingToken,
        serializeArtifact(nextRun),
        serializeArtifact(nextIntent),
        serializeArtifact(quarantine),
        String(RUN_TTL_SECONDS),
        runId,
        knownOperationId ?? "",
      ],
    },
  );
  if (Number(result) !== 1) {
    throw new Error("ambiguous bulk launch fence could not be confirmed");
  }
  return quarantine;
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
  memoryModeCheckpoints.clear();
  memoryInputSnapshots.clear();
  memoryDiffChunks.clear();
  memoryLaunchIntents.clear();
  memoryBulkQuarantines.clear();
  memoryBulkLaunchFences.clear();
  memoryLock = null;
}

export function __expireMemorySyncLockForTests(): void {
  if (memoryLock) memoryLock.expiresAt = 0;
}

export function __setRedisClientForTests(client: RedisClientType | null): void {
  redisClient = client;
}

export function __deleteDiffChunkForTests(
  runId: string,
  mode: "prices" | "stock",
  sequence: number,
): void {
  memoryDiffChunks.delete(syncDiffKey(runId, mode, sequence));
}

export function __corruptDiffChunkForTests(
  runId: string,
  mode: "prices" | "stock",
  sequence: number,
): void {
  memoryDiffChunks.set(syncDiffKey(runId, mode, sequence), "enc:v2:000000000000:corrupt");
}
