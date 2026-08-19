import {
  fetchAllShopifyProductsAndVariants,
  fetchShopifyProductPage,
  fetchAllShopifyVariants,
  assertNoActiveBulkOperation,
  getBulkOperationById as fetchBulkOperationById,
  getCurrentBulkOperation,
  pollBulkOperation,
  runCostUpdateBulkMutation,
  runPriceUpdateBulkMutation,
  runStatusUpdateBulkMutation,
  buildCostUpdateBulkMutationJsonl,
  buildPriceUpdateBulkMutationJsonl,
  buildStatusUpdateBulkMutationJsonl,
  createAndUploadBulkMutationManifest,
  launchPreparedBulkMutation,
  isAbortError,
  isPositiveShopifyPrice,
  ShopifyProductVariantsTruncatedError,
  type CostUpdateBulkMutationInput,
  type PriceUpdateBulkMutationInput,
  type ShopifyBulkOperationStatus,
  type ShopifyProductInfo,
} from "./shopify-client";
import {
  fetch1cAlqitharaCosts,
  fetch1cDiscounts,
  fetch1cLocalCosts,
  fetch1cPrices,
  fetch1cStock,
} from "./1c-client";
import {
  sendBulkOpConflictAlert,
  sendBulkOpTimeoutAlert,
  sendEmptyPayloadAlert,
  sendSafetyFloorAlert,
  sendSyncFailureAlert,
  sendSyncSuccessAlert,
} from "./alerts";
import {
  canonicalizeModes,
  type ModeResult,
  type SyncMode,
  type SyncResult,
} from "./sync-types";
import {
  acquireSyncLock,
  adoptStrandedLaunchFence,
  associateBulkOperationAtomically,
  createSyncRun,
  deleteModeArtifactsAfterAssociation,
  deleteBulkQuarantine,
  getBulkLaunchFence,
  getBulkQuarantine,
  getVerifiedDiffChunk,
  getInputSnapshot,
  getLaunchIntent,
  getModeCheckpoint,
  getPendingNextContinuation,
  getRunIdForOperation,
  getSyncRun,
  getSyncAdmissionBlocker,
  failPendingNextContinuationIfCurrent,
  isMissingRedisConfig,
  listOpenRuns,
  markPendingNextContinuationEnqueued,
  markRunIdempotent,
  releaseSyncLock,
  saveDiffChunk,
  saveBulkQuarantineIfCurrent,
  saveInputSnapshotIfAbsent,
  saveLaunchIntent,
  saveModeCheckpoint,
  savePendingNextContinuation,
  saveSyncRun,
  markAmbiguousBulkLaunchAtomically,
  markLaunchRequestedWithFence,
  updateBulkLaunchFenceKnownOperation,
  withSyncLock,
  type AcceptedRun,
  type PendingNextContinuation,
  type SyncBulkQuarantine,
  type SyncRun,
  type SyncInputSnapshot,
  type SyncModeCheckpoint,
} from "./sync-state";
import { logSyncEvent, summarizeSyncRun } from "./sync-logging";
import { applyShopifyWeight } from "./product-weight";
import {
  isActiveOneCStockAmount,
  isSyncableOneCDiscount,
  isSyncableOneCPrice,
} from "./one-c-values";
import {
  enqueueSyncContinuation,
  enqueuePersistedSyncContinuation,
  buildSyncContinuationCorrelationId,
  buildSyncContinuationDeduplicationId,
  isSyncContinuationConfigError,
  type EnqueueSyncContinuationResult,
  type SyncContinuationPayload,
} from "./qstash-sync";
import { createHash } from "crypto";

export type { ModeResult, SyncMode, SyncResult } from "./sync-types";

const DRAFT_FLIP_THRESHOLD = 0.2;
const MUTATION_STALE_MS = 4 * 60 * 60 * 1000;
const QUERY_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_FINALIZATION_UPDATES = 100_000;
const MAX_BULK_MANIFEST_BYTES = 15 * 1024 * 1024;

type BulkOperationLookup = (
  id: string,
  signal?: AbortSignal,
  storeId?: string,
) => Promise<ShopifyBulkOperationStatus | null>;

let bulkOperationLookupOverride: BulkOperationLookup | null = null;
let bulkFinishFailureBeforeLockedReadOverride:
  | ((runId: string, fencingToken: string) => Promise<void>)
  | null = null;

type PriorBulkOpActivePayload = {
  error: "prior_bulk_op_active";
  mode: string;
  op_id: string;
  status: string;
};

type ModeStepOutcome =
  | { kind: "completed"; result: ModeResult }
  | {
      kind: "waiting_bulk";
      op: { id: string; status: string };
      proposed: number;
    };

export type SyncInvocationBudget = {
  startedAt: number;
  abortDeadline: number;
  checkpointHeadroomMs: number;
  minimumFinalizationMs: number;
  now: () => number;
  signal: AbortSignal;
};

export function createSyncInvocationBudget({
  startedAt = Date.now(),
  now = () => Date.now(),
  signal,
}: {
  startedAt?: number;
  now?: () => number;
  signal?: AbortSignal;
} = {}): SyncInvocationBudget {
  const abortDeadline = startedAt + 50_000;
  return {
    startedAt,
    abortDeadline,
    checkpointHeadroomMs: 8_000,
    minimumFinalizationMs: 15_000,
    now,
    signal:
      signal ?? AbortSignal.timeout(Math.max(1, abortDeadline - Date.now())),
  };
}

type AdaptiveSyncDeps = {
  fetchPage: typeof fetchShopifyProductPage;
  fetchVariants: typeof fetchAllShopifyVariants;
  fetchAlqitharaCosts: typeof fetch1cAlqitharaCosts;
  fetchLocalCosts: typeof fetch1cLocalCosts;
  fetchPrices: typeof fetch1cPrices;
  fetchDiscounts: typeof fetch1cDiscounts;
  fetchStock: typeof fetch1cStock;
  createUpload: typeof createAndUploadBulkMutationManifest;
  launchBulk: typeof launchPreparedBulkMutation;
  associateBulk: typeof associateBulkOperationAtomically;
  fenceAmbiguous: typeof markAmbiguousBulkLaunchAtomically;
  getCurrentBulk: typeof getCurrentBulkOperation;
};

const DEFAULT_ADAPTIVE_DEPS: AdaptiveSyncDeps = {
  fetchPage: fetchShopifyProductPage,
  fetchVariants: fetchAllShopifyVariants,
  fetchAlqitharaCosts: fetch1cAlqitharaCosts,
  fetchLocalCosts: fetch1cLocalCosts,
  fetchPrices: fetch1cPrices,
  fetchDiscounts: fetch1cDiscounts,
  fetchStock: fetch1cStock,
  createUpload: createAndUploadBulkMutationManifest,
  launchBulk: launchPreparedBulkMutation,
  associateBulk: associateBulkOperationAtomically,
  fenceAmbiguous: markAmbiguousBulkLaunchAtomically,
  getCurrentBulk: getCurrentBulkOperation,
};
let adaptiveDepsOverride: Partial<AdaptiveSyncDeps> | null = null;

export function __setAdaptiveSyncDepsForTests(
  override: Partial<AdaptiveSyncDeps> | null,
): void {
  adaptiveDepsOverride = override;
}

function adaptiveDeps(): AdaptiveSyncDeps {
  return { ...DEFAULT_ADAPTIVE_DEPS, ...adaptiveDepsOverride };
}

export class FutureCheckpointSequenceError extends Error {
  readonly code = "future_checkpoint_sequence";
}

export function buildPriceUpdateTargetFromOneC({
  priceRaw,
  compareAtRaw,
  weightKg,
}: {
  priceRaw: unknown;
  compareAtRaw: unknown;
  weightKg: number | null;
}): { price: string; compareAtPrice: string | null } | null {
  if (!isSyncableOneCPrice(priceRaw)) return null;

  const finalPrice = applyShopifyWeight(Number(priceRaw), weightKg);
  const price = Number(finalPrice).toFixed(2);
  const compareAtPrice = isSyncableOneCDiscount(compareAtRaw, priceRaw)
    ? Number(applyShopifyWeight(Number(compareAtRaw), weightKg)).toFixed(2)
    : null;

  return { price, compareAtPrice };
}

export type StockStatusUpdate = { productId: string; status: "ACTIVE" | "DRAFT" };

export type StockStatusDiff = {
  updates: StockStatusUpdate[];
  currentlyActive: number;
  proposedDraftFlips: number;
  flippedToDraftSamples: ShopifyProductInfo[];
  protectedProductsSkipped: number;
};

export function buildStockStatusDiff(
  products: Map<string, ShopifyProductInfo>,
  stock1c: Record<string, unknown>,
): StockStatusDiff {
  const updates: StockStatusUpdate[] = [];
  let currentlyActive = 0;
  let proposedDraftFlips = 0;
  const flippedToDraftSamples: ShopifyProductInfo[] = [];
  let protectedProductsSkipped = 0;

  products.forEach((product) => {
    if (product.excludeFrom1cStatusSync) {
      protectedProductsSkipped += 1;
      return;
    }
    if (product.status === "ACTIVE") currentlyActive += 1;

    let productInStock = false;
    let positivePricedVariantInStock = false;
    for (const variant of product.variants) {
      if (!variant.barcode) continue;
      if (isActiveOneCStockAmount(stock1c[variant.barcode])) {
        productInStock = true;
        if (isPositiveShopifyPrice(variant.price)) {
          positivePricedVariantInStock = true;
          break;
        }
      }
    }

    const newStatus: "ACTIVE" | "DRAFT" = productInStock ? "ACTIVE" : "DRAFT";
    if (
      product.status === "DRAFT" &&
      newStatus === "ACTIVE" &&
      !positivePricedVariantInStock
    ) {
      return;
    }
    if (newStatus !== product.status) {
      updates.push({ productId: product.id, status: newStatus });
      if (product.status === "ACTIVE" && newStatus === "DRAFT") {
        proposedDraftFlips += 1;
        if (flippedToDraftSamples.length < 25)
          flippedToDraftSamples.push(product);
      }
    }
  });

  return {
    updates,
    currentlyActive,
    proposedDraftFlips,
    flippedToDraftSamples,
    protectedProductsSkipped,
  };
}

function tryParsePriorBulkOpActive(err: any): PriorBulkOpActivePayload | null {
  const msg = err?.message;
  if (typeof msg !== "string") return null;
  try {
    const parsed = JSON.parse(msg);
    if (
      parsed &&
      parsed.error === "prior_bulk_op_active" &&
      typeof parsed.op_id === "string" &&
      typeof parsed.status === "string"
    ) {
      return parsed as PriorBulkOpActivePayload;
    }
  } catch {
    // not JSON
  }
  return null;
}

function recordModeResult(run: SyncRun, mode: SyncMode, result: ModeResult) {
  run.proposedByMode[mode] = result.proposed;
  run.appliedByMode[mode] = result.applied;
  if (result.skipped) run.skippedByMode[mode] = result.skipped;
  if (result.error) run.failureReason = result.error;
}

function currentMode(run: SyncRun): SyncMode | null {
  return run.requestedModes[run.currentIndex] ?? null;
}

async function getBulkOperationById(
  id: string,
  signal?: AbortSignal,
  storeId?: string,
): Promise<ShopifyBulkOperationStatus | null> {
  const lookup = bulkOperationLookupOverride ?? fetchBulkOperationById;
  return await lookup(id, signal, storeId);
}

export function __setBulkOperationByIdForTests(
  lookup: BulkOperationLookup | null,
): void {
  bulkOperationLookupOverride = lookup;
}

export function __setBulkFinishFailureBeforeLockedReadForTests(
  hook: ((runId: string, fencingToken: string) => Promise<void>) | null,
): void {
  bulkFinishFailureBeforeLockedReadOverride = hook;
}

function advanceRun(run: SyncRun) {
  run.currentIndex += 1;
  run.currentMode = currentMode(run);
  run.activeBulkOperationId = null;
  run.activeBulkOperationType = null;
  if (!run.currentMode) {
    run.status = "completed";
    run.completedAt = new Date().toISOString();
  } else {
    run.status = "queued";
  }
}

function countShopifyVariants(
  products: Map<string, ShopifyProductInfo>,
): number {
  let count = 0;
  products.forEach((product) => {
    count += product.variants.length;
  });
  return count;
}

async function sendManualSyncSuccessAlert(run: SyncRun): Promise<void> {
  if (run.source !== "manual") return;
  await sendSyncSuccessAlert({ run });
}

/**
 * Returns the store's quarantine, adopting a stranded launch fence into one when
 * the fence is blocking admission on its own. The adopted token is logged
 * because it is the only way an operator can reach POST /api/sync/quarantine/clear.
 */
async function resolveBulkQuarantine(): Promise<SyncBulkQuarantine | null> {
  const blocker = await getSyncAdmissionBlocker();
  if (!blocker) return null;
  if (blocker.quarantine) return blocker.quarantine;
  const adopted = await adoptStrandedLaunchFence([blocker.storeId]);
  if (adopted) {
    logSyncEvent(
      "sync_bulk_launch_fence_adopted",
      {
        runId: adopted.runId,
        mode: adopted.mode,
        quarantineToken: adopted.quarantineToken,
        knownOperationId: adopted.knownOperationId,
        manifestHashPrefix: adopted.manifestHash.slice(0, 12),
        fenceCreatedAt: adopted.createdAt,
        reason: adopted.reason,
      },
      "error",
    );
  }
  return adopted;
}

export async function acceptSyncRun({
  modes,
  source,
}: {
  modes: SyncMode[];
  source: SyncRun["source"];
}): Promise<AcceptedRun> {
  const accepted = await createSyncRun({ modes, source });
  if (accepted.status === "quarantined") {
    // Admission also blocks on a bare launch fence. Adopt it so the rejection is
    // self-describing and an operator has a token to clear.
    const quarantine = await resolveBulkQuarantine();
    logSyncEvent(
      "sync_run_rejected_by_bulk_quarantine",
      {
        source,
        runId: quarantine?.runId ?? accepted.runId,
        mode: quarantine?.mode ?? accepted.currentMode,
        createdAt: quarantine?.createdAt,
      },
      "error",
    );
  }
  logSyncEvent("sync_run_accept_result", {
    source,
    accepted: accepted.accepted,
    status: accepted.status,
    runId: accepted.runId,
    modes: accepted.modes,
    currentMode: accepted.currentMode,
  });
  return accepted;
}

type ContinuationSource =
  | "direct"
  | "cron"
  | "manual"
  | "bulk-finish"
  | "reconciler"
  | "shopify-webhook";

export async function enqueueSyncRunContinuation({
  runId,
  source,
}: {
  runId: string;
  source: "cron" | "manual" | "bulk-finish" | "reconciler";
}): Promise<EnqueueSyncContinuationResult> {
  const run = await getSyncRun(runId);
  if (!run) {
    throw new Error(`sync run not found for continuation enqueue: ${runId}`);
  }
  const payload: SyncContinuationPayload = {
    kind: "continue-run",
    runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: run.currentMode,
    runVersion: run.version,
    checkpointSequence: 0,
  };
  const result = await enqueueSyncContinuation(payload);
  logSyncEvent("sync_continuation_enqueued", {
    runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: run.currentMode,
    runVersion: run.version,
    checkpointSequence: 0,
    qstashMessageId: result.messageId,
    qstashCorrelationId: result.correlationId,
    qstashDeduplicationId: result.deduplicationId,
    qstashDeduplicated: result.deduplicated,
  });
  return result;
}

export async function markSyncRunFailed({
  runId,
  mode,
  reason,
}: {
  runId: string;
  mode?: string | null;
  reason: string;
}): Promise<void> {
  const run = await getSyncRun(runId);
  const failureMode = mode ?? run?.currentMode ?? "unknown";
  let shouldAlert = true;

  if (run) {
    shouldAlert = run.status !== "failed" || run.failureReason !== reason;
    run.status = "failed";
    run.failureReason = reason;
    run.activeBulkOperationId = null;
    run.activeBulkOperationType = null;
    await saveSyncRun(run);
    logSyncEvent(
      "sync_run_marked_failed",
      {
        reason,
        failureMode,
        ...summarizeSyncRun(run),
      },
      "error",
    );
  } else {
    logSyncEvent(
      "sync_run_mark_failed_missing",
      { runId, failureMode, reason },
      "error",
    );
  }

  if (shouldAlert) {
    await sendSyncFailureAlert({ runId, mode: failureMode, reason });
  }
}

export async function failSyncContinuationIfCurrent({
  payload,
  reason,
}: {
  payload: Extract<SyncContinuationPayload, { kind: "continue-run" }>;
  reason: string;
}): Promise<
  | "marked_failed"
  | "marked_ambiguous"
  | "noop_missing"
  | "noop_stale_or_recovered"
  | "rejected_future"
> {
  const initial = await getSyncRun(payload.runId);
  if (!initial) return "noop_missing";
  const fencingToken = await acquireSyncLock(initial.storeId);
  if (!fencingToken) {
    throw new Error(`sync continuation failure lock busy for ${payload.runId}`);
  }
  let shouldAlert = false;
  try {
    const run = await getSyncRun(payload.runId);
    if (!run) return "noop_missing";
    if (
      !["queued", "running"].includes(run.status) ||
      run.currentIndex !== payload.currentIndex ||
      run.currentMode !== payload.currentMode
    ) {
      return "noop_stale_or_recovered";
    }
    const delivered = payload.checkpointSequence ?? 0;
    let expected = 0;
    if (run.currentMode === "prices" || run.currentMode === "stock") {
      expected =
        (await getModeCheckpoint(run.runId, run.currentMode))?.sequence ?? 0;
    }
    if (delivered < expected) return "noop_stale_or_recovered";
    if (delivered > expected) return "rejected_future";

    if (run.currentMode) {
      const [intent, fence] = await Promise.all([
        getLaunchIntent(run.runId, run.currentMode),
        getBulkLaunchFence(run.storeId),
      ]);
      if (
        intent?.phase === "launch_requested" &&
        fence?.runId === run.runId &&
        fence.mode === run.currentMode &&
        fence.manifestHash === intent.manifestHash
      ) {
        await markAmbiguousBulkLaunchAtomically({
          runId: run.runId,
          mode: run.currentMode,
          reason,
          fencingToken,
          knownOperationId: fence.knownOperationId,
        });
        shouldAlert = true;
        return "marked_ambiguous";
      }
    }

    shouldAlert = run.status !== "failed" || run.failureReason !== reason;
    run.status = "failed";
    run.failureReason = reason;
    run.activeBulkOperationId = null;
    run.activeBulkOperationType = null;
    await saveSyncRun(run, fencingToken);
    logSyncEvent(
      "sync_continuation_sequence_failed",
      {
        deliveredSequence: delivered,
        expectedSequence: expected,
        reason,
        ...summarizeSyncRun(run),
      },
      "error",
    );
    return "marked_failed";
  } finally {
    await releaseSyncLock(fencingToken, initial.storeId);
    if (shouldAlert) {
      await sendSyncFailureAlert({
        runId: payload.runId,
        mode: payload.currentMode ?? "unknown",
        reason,
      });
    }
  }
}

export async function failBulkFinishContinuationIfCurrent({
  payload,
  reason,
}: {
  payload: Extract<SyncContinuationPayload, { kind: "bulk-finish" }>;
  reason: string;
}): Promise<"marked_failed" | "noop_unknown_operation" | "noop_stale_or_recovered"> {
  const initialRunId = await getRunIdForOperation(payload.opId);
  if (!initialRunId) return "noop_unknown_operation";
  const initial = await getSyncRun(initialRunId);
  if (!initial) return "noop_unknown_operation";
  const fencingToken = await acquireSyncLock(initial.storeId);
  if (!fencingToken) throw new Error(`bulk-finish failure lock busy for ${payload.opId}`);
  let shouldAlert = false;
  try {
    await bulkFinishFailureBeforeLockedReadOverride?.(initialRunId, fencingToken);
    const lockedRunId = await getRunIdForOperation(payload.opId);
    const run = lockedRunId ? await getSyncRun(lockedRunId) : null;
    if (
      lockedRunId !== initialRunId ||
      !run ||
      run.status !== "waiting_bulk" ||
      run.activeBulkOperationId !== payload.opId
    ) {
      return "noop_stale_or_recovered";
    }
    run.status = "failed";
    run.failureReason = reason;
    run.activeBulkOperationId = null;
    run.activeBulkOperationType = null;
    await saveSyncRun(run, fencingToken);
    shouldAlert = true;
    return "marked_failed";
  } finally {
    await releaseSyncLock(fencingToken, initial.storeId);
    if (shouldAlert) {
      await sendSyncFailureAlert({
        runId: initialRunId,
        mode: initial.currentMode ?? "unknown",
        reason,
      });
    }
  }
}

type PriceInputPayload = {
  prices: Record<string, number>;
  discounts: Record<string, number>;
};

type StockInputPayload = { stock: Record<string, number> };

type AdaptiveCounters = SyncModeCheckpoint["counters"];

type RequestLocalContext = {
  priceSnapshot: Map<string, ShopifyProductInfo> | null;
  priceTraversalMs: number;
};

type AdaptiveOutcome =
  | { kind: "completed"; result: ModeResult; retainedProducts?: Map<string, ShopifyProductInfo>; traversalMs?: number }
  | { kind: "yielded" }
  | { kind: "waiting_bulk" }
  | { kind: "ambiguous" };

function remainingBudget(budget: SyncInvocationBudget): number {
  return budget.abortDeadline - budget.now();
}

function estimateNextPageMs(durations: number[]): number {
  if (durations.length === 0) return 2_000;
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const observedMax = Math.max(...durations);
  return Math.min(
    10_000,
    Math.max(2_000, Math.ceil(Math.max(observedMax, mean) * 1.5)),
  );
}

function shouldYieldBeforePage(
  budget: SyncInvocationBudget,
  estimatedNextPageMs: number,
): boolean {
  return (
    budget.now() + estimatedNextPageMs + budget.checkpointHeadroomMs >=
    budget.abortDeadline
  );
}

function createContinuationIdentity({
  run,
  mode,
  sequence,
  source,
}: {
  run: SyncRun;
  mode: "prices" | "stock";
  sequence: number;
  source: "cron" | "manual" | "bulk-finish" | "reconciler";
}): NonNullable<SyncModeCheckpoint["continuationIdentity"]> {
  const payload: Extract<SyncContinuationPayload, { kind: "continue-run" }> = {
    kind: "continue-run",
    runId: run.runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: mode,
    runVersion: run.version + 1,
    checkpointSequence: sequence,
  };
  const deduplicationId = buildSyncContinuationDeduplicationId(payload);
  return {
    payload,
    deduplicationId,
    correlationId: buildSyncContinuationCorrelationId(deduplicationId),
  };
}

function sortPriceUpdates(
  updates: PriceUpdateBulkMutationInput[],
): PriceUpdateBulkMutationInput[] {
  return [...updates].sort(
    (a, b) =>
      a.productId.localeCompare(b.productId) ||
      a.variantId.localeCompare(b.variantId),
  );
}

function sortCostUpdates(
  updates: CostUpdateBulkMutationInput[],
): CostUpdateBulkMutationInput[] {
  return [...updates].sort((a, b) =>
    a.inventoryItemId.localeCompare(b.inventoryItemId),
  );
}

function sortStockUpdates(updates: StockStatusUpdate[]): StockStatusUpdate[] {
  return [...updates].sort(
    (a, b) =>
      a.productId.localeCompare(b.productId) || a.status.localeCompare(b.status),
  );
}

function priceDiffForProducts(
  products: ShopifyProductInfo[],
  input: PriceInputPayload,
): { updates: PriceUpdateBulkMutationInput[]; counters: AdaptiveCounters } {
  const updates: PriceUpdateBulkMutationInput[] = [];
  const counters: AdaptiveCounters = {
    proposed: 0,
    variantsWithBarcodes: 0,
    variantsWith1cPrices: 0,
    variantsSkippedForNonPositive1cPrice: 0,
    discountRemovedCount: 0,
  };
  for (const product of products) {
    for (const variant of product.variants) {
      if (!variant.barcode) continue;
      counters.variantsWithBarcodes! += 1;
      const priceRaw = input.prices[variant.barcode];
      if (priceRaw === undefined || priceRaw === null) continue;
      counters.variantsWith1cPrices! += 1;
      if (!isSyncableOneCPrice(priceRaw)) {
        counters.variantsSkippedForNonPositive1cPrice! += 1;
        continue;
      }
      const compareAtRaw = input.discounts[variant.barcode];
      const target = buildPriceUpdateTargetFromOneC({
        priceRaw,
        compareAtRaw,
        weightKg: product.weightKg,
      });
      if (!target) continue;
      if (
        (compareAtRaw === undefined || compareAtRaw === null) &&
        variant.compareAtPrice !== null
      ) {
        counters.discountRemovedCount! += 1;
      }
      const currentPrice = Number(variant.price).toFixed(2);
      const currentCompareAt =
        variant.compareAtPrice === null || variant.compareAtPrice === undefined
          ? null
          : Number(variant.compareAtPrice).toFixed(2);
      if (
        currentPrice !== target.price ||
        currentCompareAt !== target.compareAtPrice
      ) {
        updates.push({
          productId: product.id,
          variantId: variant.id,
          price: target.price,
          compareAtPrice: target.compareAtPrice,
        });
      }
    }
  }
  counters.proposed = updates.length;
  return { updates: sortPriceUpdates(updates), counters };
}

function stockDiffForProducts(
  products: ShopifyProductInfo[],
  input: StockInputPayload,
): {
  updates: StockStatusUpdate[];
  counters: AdaptiveCounters;
  samples: Array<{ handle: string; barcode: string }>;
} {
  const map = new Map(products.map((product) => [product.id, product]));
  const diff = buildStockStatusDiff(map, input.stock);
  return {
    updates: sortStockUpdates(diff.updates),
    counters: {
      proposed: diff.updates.length,
      currentlyActive: diff.currentlyActive,
      proposedDraftFlips: diff.proposedDraftFlips,
      protectedProductsSkipped: diff.protectedProductsSkipped,
    },
    samples: diff.flippedToDraftSamples.map((product) => ({
      handle: product.handle,
      barcode: product.variants[0]?.barcode ?? "",
    })),
  };
}

function addCounters(
  base: AdaptiveCounters,
  next: AdaptiveCounters,
): AdaptiveCounters {
  const result: AdaptiveCounters = { ...base };
  for (const key of Object.keys(next) as Array<keyof AdaptiveCounters>) {
    result[key] = (result[key] ?? 0) + (next[key] ?? 0);
  }
  return result;
}

async function loadModeInput(
  run: SyncRun,
  mode: "prices" | "stock",
  signal: AbortSignal,
): Promise<{ input: PriceInputPayload | StockInputPayload; snapshot: SyncInputSnapshot; reused: boolean } | { skipped: ModeResult }> {
  const existing = await getInputSnapshot(run.runId, mode);
  if (existing) {
    if (
      existing.schemaVersion !== 1 ||
      existing.inputVersion !== 1 ||
      existing.mode !== mode
    ) {
      throw new Error(`invalid immutable ${mode} input snapshot`);
    }
    logSyncEvent("sync_input_snapshot_reused", {
      runId: run.runId,
      mode,
      inputVersion: existing.inputVersion,
    });
    return {
      input: existing.payload as PriceInputPayload | StockInputPayload,
      snapshot: existing,
      reused: true,
    };
  }

  const deps = adaptiveDeps();
  let payload: PriceInputPayload | StockInputPayload;
  if (mode === "prices") {
    const prices = await deps.fetchPrices(signal);
    if (Object.keys(prices).length === 0) {
      await sendEmptyPayloadAlertOnce(run.runId, mode, "Prices");
      return { skipped: { proposed: 0, applied: 0, skipped: "1C Prices payload empty" } };
    }
    const discounts = await deps.fetchDiscounts(signal);
    if (Object.keys(discounts).length === 0) {
      await sendEmptyPayloadAlertOnce(run.runId, mode, "Discounts");
      return { skipped: { proposed: 0, applied: 0, skipped: "1C Discounts payload empty" } };
    }
    payload = { prices, discounts };
  } else {
    const stock = await deps.fetchStock(signal);
    if (Object.keys(stock).length === 0) {
      await sendEmptyPayloadAlertOnce(run.runId, mode, "Stock");
      return { skipped: { proposed: 0, applied: 0, skipped: "1C Stock payload empty" } };
    }
    payload = { stock };
  }
  const snapshot: SyncInputSnapshot = {
    schemaVersion: 1,
    inputVersion: 1,
    mode,
    createdAt: new Date().toISOString(),
    payload,
  };
  return { input: payload, snapshot, reused: false };
}

async function sendEmptyPayloadAlertOnce(
  runId: string,
  mode: string,
  source: string,
): Promise<void> {
  const first = await markRunIdempotent(
    `empty-payload-alert:${runId}:${mode}:${source}`,
    new Date().toISOString(),
  );
  if (first) await sendEmptyPayloadAlert({ mode, source });
}

async function persistAndEnqueueCheckpoint({
  run,
  mode,
  deliveredSequence,
  phase,
  cursor,
  inputSnapshot,
  updates,
  prior,
  pageCount,
  productCount,
  variantCount,
  counters,
  samples,
  fencingToken,
  source,
}: {
  run: SyncRun;
  mode: "prices" | "stock";
  deliveredSequence: number;
  phase: "scanning" | "ready_to_finalize";
  cursor: string | null;
  inputSnapshot: SyncInputSnapshot;
  updates: unknown[];
  prior: SyncModeCheckpoint | null;
  pageCount: number;
  productCount: number;
  variantCount: number;
  counters: AdaptiveCounters;
  samples: Array<{ handle: string; barcode: string }>;
  fencingToken: string;
  source: "cron" | "manual" | "bulk-finish" | "reconciler";
}): Promise<void> {
  await saveInputSnapshotIfAbsent(run.runId, inputSnapshot);
  const savedChunk = await saveDiffChunk(run.runId, mode, deliveredSequence, updates);
  const sequences = Array.from(
    new Set([...(prior?.diffChunkSequences ?? []), deliveredSequence]),
  ).sort((a, b) => a - b);
  const diffChunks = [
    ...(prior?.diffChunks ?? []),
    savedChunk,
  ].filter(
    (chunk, index, all) =>
      all.findLastIndex((candidate) => candidate.sequence === chunk.sequence) === index,
  ).sort((a, b) => a.sequence - b.sequence);
  const nextSequence = deliveredSequence + 1;
  const continuationIdentity = createContinuationIdentity({
    run,
    mode,
    sequence: nextSequence,
    source,
  });
  const checkpoint: SyncModeCheckpoint = {
    schemaVersion: 1,
    runId: run.runId,
    mode,
    currentIndex: run.currentIndex,
    sequence: nextSequence,
    phase,
    cursor,
    inputSnapshotKey: `sync:input:${run.runId}:${mode}`,
    diffChunkSequences: sequences,
    diffChunks,
    pageCount,
    productCount,
    variantCount,
    counters,
    draftFlipSamples: samples.slice(0, 25),
    continuationState: "needed",
    continuationIdentity,
    updatedAt: new Date().toISOString(),
  };
  await saveModeCheckpoint(checkpoint);
  run.status = "queued";
  run.checkpointSequenceByMode ??= {};
  run.checkpointSequenceByMode[mode] = nextSequence;
  run.protectedSkippedByMode ??= {};
  run.protectedSkippedByMode[mode] = counters.protectedProductsSkipped ?? 0;
  await saveSyncRun(run, fencingToken);
  logSyncEvent("sync_scan_checkpoint_saved", {
    runId: run.runId,
    mode,
    sequence: nextSequence,
    phase,
    pageCount,
    productCount,
    variantCount,
    proposed: counters.proposed,
    protectedProductsSkipped: counters.protectedProductsSkipped ?? 0,
  });

  try {
    const published = await enqueuePersistedSyncContinuation(
      continuationIdentity,
    );
    checkpoint.continuationState = "enqueued";
    checkpoint.updatedAt = new Date().toISOString();
    await saveModeCheckpoint(checkpoint);
    logSyncEvent("sync_scan_continuation_enqueued", {
      runId: run.runId,
      mode,
      sequence: nextSequence,
      qstashCorrelationId: published.correlationId,
      qstashMessageId: published.messageId,
    });
  } catch (error: any) {
    logSyncEvent(
      "sync_scan_continuation_enqueue_deferred",
      {
        runId: run.runId,
        mode,
        sequence: nextSequence,
        error: error?.message ?? String(error),
      },
      "warn",
    );
  }
}

async function collectPersistedUpdates<T>(
  checkpoint: SyncModeCheckpoint,
): Promise<T[]> {
  if (!checkpoint.diffChunks || checkpoint.diffChunks.length !== checkpoint.diffChunkSequences.length) {
    throw new Error("sync checkpoint diff metadata is missing or inconsistent");
  }
  const listed = [...checkpoint.diffChunkSequences].sort((a, b) => a - b);
  const described = checkpoint.diffChunks.map((chunk) => chunk.sequence).sort((a, b) => a - b);
  if (listed.some((sequence, index) => sequence !== described[index])) {
    throw new Error("sync checkpoint diff sequence metadata is inconsistent");
  }
  const expectedCount = checkpoint.diffChunks.reduce((sum, chunk) => sum + chunk.count, 0);
  if (expectedCount > MAX_FINALIZATION_UPDATES) {
    throw new Error(`sync finalization exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
  }
  const result: T[] = [];
  for (const metadata of [...checkpoint.diffChunks].sort((a, b) => a.sequence - b.sequence)) {
    const chunk = await getVerifiedDiffChunk<T>(checkpoint.runId, checkpoint.mode, metadata);
    for (const update of chunk) result.push(update);
  }
  return result;
}

async function fenceAmbiguousLaunch(
  run: SyncRun,
  mode: SyncMode,
  reason: string,
  fencingToken: string,
  knownOperationId: string | null = null,
): Promise<void> {
  const quarantine = await adaptiveDeps().fenceAmbiguous({
    runId: run.runId,
    mode,
    reason,
    fencingToken,
    knownOperationId,
  });
  logSyncEvent(
    "sync_bulk_launch_ambiguous",
    {
      runId: run.runId,
      mode,
      reason,
      manifestHashPrefix: quarantine.manifestHash.slice(0, 12),
      clientIdentifier: quarantine.clientIdentifier,
      // The only operator-reachable copy of the token that clears this.
      quarantineToken: quarantine.quarantineToken,
      knownOperationId: quarantine.knownOperationId,
    },
    "error",
  );
  await sendSyncFailureAlert({ runId: run.runId, mode, reason });
}

async function launchDurableBulk({
  run,
  mode,
  updates,
  checkpoint,
  fencingToken,
  budget,
}: {
  run: SyncRun;
  mode: SyncMode;
  updates:
    | CostUpdateBulkMutationInput[]
    | PriceUpdateBulkMutationInput[]
    | StockStatusUpdate[];
  checkpoint: SyncModeCheckpoint | null;
  fencingToken: string;
  budget: SyncInvocationBudget;
}): Promise<"waiting_bulk" | "ambiguous"> {
  if (updates.length > MAX_FINALIZATION_UPDATES) {
    throw new Error(`sync finalization exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
  }
  const sortedUpdates =
    mode === "costs"
      ? sortCostUpdates(updates as CostUpdateBulkMutationInput[])
      : mode === "prices"
        ? sortPriceUpdates(updates as PriceUpdateBulkMutationInput[])
        : sortStockUpdates(updates as StockStatusUpdate[]);
  const jsonl =
    mode === "costs"
      ? buildCostUpdateBulkMutationJsonl(
          sortedUpdates as CostUpdateBulkMutationInput[],
          MAX_BULK_MANIFEST_BYTES,
        )
      : mode === "prices"
        ? buildPriceUpdateBulkMutationJsonl(
            sortedUpdates as PriceUpdateBulkMutationInput[],
            MAX_BULK_MANIFEST_BYTES,
          )
        : buildStatusUpdateBulkMutationJsonl(
            sortedUpdates as StockStatusUpdate[],
            MAX_BULK_MANIFEST_BYTES,
          );
  const manifestHash = createHash("sha256").update(jsonl).digest("hex");
  const proposedCount = sortedUpdates.length;
  const byteLength = Buffer.byteLength(jsonl);
  if (byteLength > MAX_BULK_MANIFEST_BYTES) {
    throw new Error(`sync bulk manifest exceeds ${MAX_BULK_MANIFEST_BYTES} byte limit`);
  }
  const clientIdentifier = `sync-${createHash("sha256")
    .update(`${run.runId}:${mode}:${manifestHash}`)
    .digest("hex")
    .slice(0, 48)}`;
  let intent = await getLaunchIntent(run.runId, mode);
  if (intent) {
    // Fence before validating manifest identity. A launch_requested intent means
    // a mutation may already be in flight, and the durable fence is already
    // written; a manifest that no longer matches is a stronger reason to fence,
    // not a reason to throw and strand the fence with no quarantine record.
    if (intent.phase === "launch_requested") {
      await fenceAmbiguousLaunch(
        run,
        mode,
        intent.manifestHash === manifestHash
          ? "Recovered a launch_requested intent without durable operation association"
          : "Recovered a launch_requested intent whose manifest no longer matches the recomputed diff",
        fencingToken,
      );
      return "ambiguous";
    }
    if (
      intent.manifestHash !== manifestHash ||
      intent.proposedCount !== proposedCount ||
      intent.byteLength !== byteLength ||
      intent.mode !== mode ||
      intent.clientIdentifier !== clientIdentifier
    ) {
      throw new Error("persisted bulk launch manifest identity mismatch");
    }
    if (intent.phase === "associated") return "waiting_bulk";
    if (intent.phase === "ambiguous_failed") return "ambiguous";
  }

  const attempt = (intent?.stagedUploadAttempt ?? 0) + 1;
  intent = {
    schemaVersion: 1,
    version: (intent?.version ?? 0) + 1,
    runId: run.runId,
    mode,
    manifestHash,
    proposedCount,
    byteLength,
    clientIdentifier,
    stagedUploadIdentity: `${manifestHash}:${attempt}`,
    stagedUploadAttempt: attempt,
    uploadedAt: null,
    phase: "prepared",
    launchRequestedAt: null,
    operationId: null,
    failureReason: null,
  };
  await saveLaunchIntent(intent);
  logSyncEvent("sync_bulk_manifest_prepared", {
    runId: run.runId,
    mode,
    proposedCount,
    byteLength,
    manifestHashPrefix: manifestHash.slice(0, 12),
    clientIdentifier,
    stagedUploadAttempt: attempt,
  });

  const upload = await adaptiveDeps().createUpload({
    mode,
    jsonl,
    stagedUploadAttempt: attempt,
    signal: budget.signal,
  });
  intent = {
    ...intent,
    version: intent.version + 1,
    uploadedAt: new Date().toISOString(),
    phase: "uploaded",
  };
  await saveLaunchIntent(intent);
  intent = {
    ...intent,
    version: intent.version + 1,
    phase: "launch_requested",
    launchRequestedAt: new Date().toISOString(),
  };
  await markLaunchRequestedWithFence(
    intent,
    run.storeId,
    fencingToken,
    run.version,
    run.currentIndex,
  );

  let operation: { id: string; status: string };
  try {
    operation = await adaptiveDeps().launchBulk({
      mode,
      stagedUploadPath: upload.stagedUploadPath,
      clientIdentifier,
      signal: budget.signal,
    });
  } catch (error: any) {
    const reason = `Ambiguous Shopify ${mode} bulk launch: ${error?.message ?? String(error)}`;
    await fenceAmbiguousLaunch(run, mode, reason, fencingToken);
    return "ambiguous";
  }

  try {
    await updateBulkLaunchFenceKnownOperation(run.storeId, run.runId, operation.id);
  } catch {
    // The original launch fence remains durable and fail-closed.
  }

  let associated = false;
  try {
    associated = await adaptiveDeps().associateBulk({
      runId: run.runId,
      mode,
      operationId: operation.id,
      proposedCount,
      expectedRunVersion: run.version,
      expectedCurrentIndex: run.currentIndex,
      expectedIntentVersion: intent.version,
      expectedManifestHash: manifestHash,
      fencingToken,
    });
  } catch (error: any) {
    await fenceAmbiguousLaunch(
      run,
      mode,
      `Shopify ${mode} bulk operation ${operation.id} returned but atomic association failed: ${error?.message ?? String(error)}`,
      fencingToken,
      operation.id,
    );
    return "ambiguous";
  }
  if (!associated) {
    await fenceAmbiguousLaunch(
      run,
      mode,
      `Shopify ${mode} bulk operation ${operation.id} returned but atomic association was rejected`,
      fencingToken,
      operation.id,
    );
    return "ambiguous";
  }

  logSyncEvent("sync_bulk_operation_associated", {
    runId: run.runId,
    mode,
    opId: operation.id,
    opStatus: operation.status,
    proposedCount,
    manifestHashPrefix: manifestHash.slice(0, 12),
    clientIdentifier,
  });
  if (mode !== "costs") {
    try {
      await deleteModeArtifactsAfterAssociation(
        run.runId,
        mode,
        checkpoint?.diffChunkSequences ?? [],
      );
    } catch (error: any) {
      logSyncEvent(
        "sync_bulk_artifact_cleanup_failed",
        { runId: run.runId, mode, error: error?.message ?? String(error) },
        "warn",
      );
    }
  }
  return "waiting_bulk";
}

async function finalizeAdaptiveMode({
  run,
  mode,
  currentUpdates,
  checkpoint,
  counters,
  samples,
  fencingToken,
  budget,
}: {
  run: SyncRun;
  mode: "prices" | "stock";
  currentUpdates: PriceUpdateBulkMutationInput[] | StockStatusUpdate[];
  checkpoint: SyncModeCheckpoint | null;
  counters: AdaptiveCounters;
  samples: Array<{ handle: string; barcode: string }>;
  fencingToken: string;
  budget: SyncInvocationBudget;
}): Promise<AdaptiveOutcome> {
  const expectedPersistedCount = checkpoint?.diffChunks.reduce(
    (sum, chunk) => sum + chunk.count,
    0,
  ) ?? 0;
  if (expectedPersistedCount + currentUpdates.length > MAX_FINALIZATION_UPDATES) {
    throw new Error(`sync finalization exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
  }
  const rawBytes =
    (checkpoint?.diffChunks.reduce(
      (sum, chunk) => sum + (chunk.byteLength ?? MAX_BULK_MANIFEST_BYTES + 1),
      0,
    ) ?? 0) + Buffer.byteLength(JSON.stringify(currentUpdates));
  const conservativeBytes = rawBytes * 2 +
    (expectedPersistedCount + currentUpdates.length) * 256;
  if (conservativeBytes > MAX_BULK_MANIFEST_BYTES) {
    throw new Error(`sync bulk manifest exceeds ${MAX_BULK_MANIFEST_BYTES} byte limit before finalization`);
  }
  const persisted = checkpoint
    ? await collectPersistedUpdates<PriceUpdateBulkMutationInput | StockStatusUpdate>(checkpoint)
    : [];
  const updates = persisted;
  for (const update of currentUpdates) updates.push(update);
  if (updates.length > MAX_FINALIZATION_UPDATES) {
    throw new Error(`sync finalization exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
  }
  if (mode === "stock") {
    run.protectedSkippedByMode ??= {};
    run.protectedSkippedByMode.stock =
      counters.protectedProductsSkipped ?? 0;
    await saveSyncRun(run, fencingToken);
    const active = counters.currentlyActive ?? 0;
    const flips = counters.proposedDraftFlips ?? 0;
    const ratio = active > 0 ? flips / active : 0;
    if (active > 0 && ratio > DRAFT_FLIP_THRESHOLD) {
      await sendSafetyFloorAlert({
        totalActive: active,
        proposedFlips: flips,
        percentage: ratio,
        sampleSkus: samples.slice(0, 25),
      });
      if (checkpoint) {
        await deleteModeArtifactsAfterAssociation(
          run.runId,
          mode,
          checkpoint.diffChunkSequences,
        );
      }
      return {
        kind: "completed",
        result: {
          proposed: updates.length,
          applied: 0,
          skipped: `20% DRAFT-flip floor exceeded: ${flips}/${active} = ${(ratio * 100).toFixed(1)}%`,
        },
      };
    }
  }
  if (updates.length === 0) {
    if (checkpoint) {
      await deleteModeArtifactsAfterAssociation(
        run.runId,
        mode,
        checkpoint.diffChunkSequences,
      );
    }
    return { kind: "completed", result: { proposed: 0, applied: 0 } };
  }
  const launch = await launchDurableBulk({
    run,
    mode,
    updates: updates as PriceUpdateBulkMutationInput[] | StockStatusUpdate[],
    checkpoint,
    fencingToken,
    budget,
  });
  return { kind: launch };
}

async function startAdaptiveModeStep({
  run,
  mode,
  deliveredSequence,
  fencingToken,
  budget,
  source,
  reusedProducts,
  reusedTraversalMs = 0,
}: {
  run: SyncRun;
  mode: "prices" | "stock";
  deliveredSequence: number;
  fencingToken: string;
  budget: SyncInvocationBudget;
  source: "cron" | "manual" | "bulk-finish" | "reconciler";
  reusedProducts?: Map<string, ShopifyProductInfo> | null;
  reusedTraversalMs?: number;
}): Promise<AdaptiveOutcome> {
  const checkpoint = await getModeCheckpoint(run.runId, mode);
  if (checkpoint) {
    if (
      checkpoint.currentIndex !== run.currentIndex ||
      checkpoint.mode !== mode
    ) {
      throw new Error("checkpoint does not match current run cursor");
    }
    if (checkpoint.phase === "ready_to_finalize") {
      const conflict = await assertNoConflictOrSkip(mode, budget.signal);
      if (conflict) {
        await deleteModeArtifactsAfterAssociation(
          run.runId,
          mode,
          checkpoint.diffChunkSequences,
        );
        return conflict;
      }
      logSyncEvent("sync_scan_finalize_resumed", {
        runId: run.runId,
        mode,
        sequence: deliveredSequence,
        pageCount: checkpoint.pageCount,
        productCount: checkpoint.productCount,
        variantCount: checkpoint.variantCount,
      });
      return await finalizeAdaptiveMode({
        run,
        mode,
        currentUpdates: [],
        checkpoint,
        counters: checkpoint.counters,
        samples: checkpoint.draftFlipSamples ?? [],
        fencingToken,
        budget,
      });
    }
  }

  const conflict = await assertNoConflictOrSkip(mode, budget.signal);
  if (conflict) return conflict;
  const inputResult = await loadModeInput(run, mode, budget.signal);
  if ("skipped" in inputResult) {
    return { kind: "completed", result: inputResult.skipped };
  }

  if (mode === "stock" && reusedProducts) {
    const traversalEstimateMs = Math.max(
      2_000,
      Math.ceil(reusedTraversalMs * 1.5),
    );
    const requiredAfterStockFetch =
      traversalEstimateMs +
      budget.minimumFinalizationMs +
      budget.checkpointHeadroomMs;
    if (remainingBudget(budget) < requiredAfterStockFetch) {
      await saveInputSnapshotIfAbsent(run.runId, inputResult.snapshot);
      run.status = "queued";
      await saveSyncRun(run, fencingToken);
      await enqueueCurrentModeSequence(run, source, 0);
      logSyncEvent("sync_stock_snapshot_reuse_abandoned", {
        runId: run.runId,
        remainingMs: remainingBudget(budget),
        requiredMs: requiredAfterStockFetch,
      });
      return { kind: "yielded" };
    }
    const traversalStarted = budget.now();
    const pageDiff = stockDiffForProducts(
      Array.from(reusedProducts.values()),
      inputResult.input as StockInputPayload,
    );
    const traversalMs = Math.max(0, budget.now() - traversalStarted);
    if (remainingBudget(budget) < budget.minimumFinalizationMs) {
      await persistAndEnqueueCheckpoint({
        run,
        mode,
        deliveredSequence,
        phase: "ready_to_finalize",
        cursor: null,
        inputSnapshot: inputResult.snapshot,
        updates: pageDiff.updates,
        prior: null,
        pageCount: 1,
        productCount: reusedProducts.size,
        variantCount: countShopifyVariants(reusedProducts),
        counters: pageDiff.counters,
        samples: pageDiff.samples,
        fencingToken,
        source,
      });
      return { kind: "yielded" };
    }
    logSyncEvent("sync_stock_snapshot_reused", {
      runId: run.runId,
      mode,
      productCount: reusedProducts.size,
      traversalMs,
      proposed: pageDiff.updates.length,
      protectedProductsSkipped:
        pageDiff.counters.protectedProductsSkipped ?? 0,
    });
    return await finalizeAdaptiveMode({
      run,
      mode,
      currentUpdates: pageDiff.updates,
      checkpoint: null,
      counters: pageDiff.counters,
      samples: pageDiff.samples,
      fencingToken,
      budget,
    });
  }

  const pageDurations: number[] = [];
  const startedAt = budget.now();
  let cursor = checkpoint?.cursor ?? null;
  let pageCount = checkpoint?.pageCount ?? 0;
  let productCount = checkpoint?.productCount ?? 0;
  let variantCount = checkpoint?.variantCount ?? 0;
  let counters: AdaptiveCounters = checkpoint?.counters ?? { proposed: 0 };
  let samples = checkpoint?.draftFlipSamples ?? [];
  let currentUpdates: PriceUpdateBulkMutationInput[] | StockStatusUpdate[] = [];
  let currentUpdateRawBytes = 2;
  const persistedRawBytes = checkpoint?.diffChunks.reduce(
    (sum, chunk) => sum + (chunk.byteLength ?? MAX_BULK_MANIFEST_BYTES + 1),
    0,
  ) ?? 0;
  const persistedUpdateCount = checkpoint?.diffChunks.reduce(
    (sum, chunk) => sum + chunk.count,
    0,
  ) ?? 0;
  let retainedProducts =
    mode === "prices" && !checkpoint
      ? new Map<string, ShopifyProductInfo>()
      : null;
  let firstPage = true;

  logSyncEvent(checkpoint ? "sync_scan_resumed" : "sync_scan_started", {
    runId: run.runId,
    mode,
    sequence: deliveredSequence,
    pageCount,
    productCount,
    variantCount,
  });

  while (true) {
    const estimate = estimateNextPageMs(pageDurations);
    if (!firstPage && shouldYieldBeforePage(budget, estimate)) {
      await persistAndEnqueueCheckpoint({
        run,
        mode,
        deliveredSequence,
        phase: "scanning",
        cursor,
        inputSnapshot: inputResult.snapshot,
        updates: currentUpdates,
        prior: checkpoint,
        pageCount,
        productCount,
        variantCount,
        counters,
        samples,
        fencingToken,
        source,
      });
      retainedProducts = null;
      logSyncEvent("sync_scan_yielded", {
        runId: run.runId,
        mode,
        sequence: deliveredSequence,
        elapsedMs: budget.now() - startedAt,
        estimatedNextPageMs: estimate,
        pageCount,
        productCount,
        variantCount,
      });
      return { kind: "yielded" };
    }
    if (firstPage && checkpoint && shouldYieldBeforePage(budget, estimate)) {
      // Resumed invocations do not start a request they cannot safely finish.
      await persistAndEnqueueCheckpoint({
        run,
        mode,
        deliveredSequence,
        phase: "scanning",
        cursor,
        inputSnapshot: inputResult.snapshot,
        updates: [],
        prior: checkpoint,
        pageCount,
        productCount,
        variantCount,
        counters,
        samples,
        fencingToken,
        source,
      });
      return { kind: "yielded" };
    }

    const pageStarted = budget.now();
    const page = await adaptiveDeps().fetchPage(cursor, {
      signal: budget.signal,
    });
    if (page.truncatedProductIds.length > 0) {
      const truncatedIds = new Set(page.truncatedProductIds);
      const truncatedProducts = page.products
        .filter((product) => truncatedIds.has(product.id))
        .map(({ id, handle }) => ({ id, handle }))
        .slice(0, 25);
      logSyncEvent(
        "shopify_product_variants_truncated",
        {
          runId: run.runId,
          mode,
          products: truncatedProducts,
        },
        "error",
      );
      throw new ShopifyProductVariantsTruncatedError(
        page.truncatedProductIds,
        truncatedProducts,
      );
    }
    const pageVariantCount = page.products.reduce(
      (sum, product) => sum + product.variants.length,
      0,
    );
    pageCount += 1;
    productCount += page.products.length;
    variantCount += pageVariantCount;
    cursor = page.endCursor;
    if (retainedProducts) {
      page.products.forEach((product) => retainedProducts!.set(product.id, product));
    }
    if (mode === "prices") {
      const pageDiff = priceDiffForProducts(
        page.products,
        inputResult.input as PriceInputPayload,
      );
      if (currentUpdates.length + pageDiff.updates.length > MAX_FINALIZATION_UPDATES) {
        throw new Error(`sync scan exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
      }
      for (const update of pageDiff.updates) {
        (currentUpdates as PriceUpdateBulkMutationInput[]).push(update);
        currentUpdateRawBytes += Buffer.byteLength(JSON.stringify(update)) + 1;
      }
      counters = addCounters(counters, pageDiff.counters);
    } else {
      const pageDiff = stockDiffForProducts(
        page.products,
        inputResult.input as StockInputPayload,
      );
      if (currentUpdates.length + pageDiff.updates.length > MAX_FINALIZATION_UPDATES) {
        throw new Error(`sync scan exceeds ${MAX_FINALIZATION_UPDATES} update limit`);
      }
      for (const update of pageDiff.updates) {
        (currentUpdates as StockStatusUpdate[]).push(update);
        currentUpdateRawBytes += Buffer.byteLength(JSON.stringify(update)) + 1;
      }
      counters = addCounters(counters, pageDiff.counters);
      for (const sample of pageDiff.samples) {
        if (samples.length >= 25) break;
        samples.push(sample);
      }
    }
    const conservativeManifestBytes =
      (persistedRawBytes + currentUpdateRawBytes) * 2 +
      (persistedUpdateCount + currentUpdates.length) * 256;
    if (conservativeManifestBytes > MAX_BULK_MANIFEST_BYTES) {
      throw new Error(
        `sync bulk manifest exceeds ${MAX_BULK_MANIFEST_BYTES} byte limit during scan`,
      );
    }
    const pageDuration = Math.max(0, budget.now() - pageStarted);
    pageDurations.push(pageDuration);
    logSyncEvent("sync_scan_page_completed", {
      runId: run.runId,
      mode,
      sequence: deliveredSequence,
      pageCount,
      pageProductCount: page.products.length,
      pageVariantCount,
      productCount,
      variantCount,
      pageDurationMs: pageDuration,
      estimatedNextPageMs: estimateNextPageMs(pageDurations),
      proposed: counters.proposed,
      protectedProductsSkipped: counters.protectedProductsSkipped ?? 0,
    });
    firstPage = false;

    if (page.hasNextPage) continue;
    const mustFinalizeFresh =
      Boolean(checkpoint) || remainingBudget(budget) < budget.minimumFinalizationMs;
    if (mustFinalizeFresh) {
      await persistAndEnqueueCheckpoint({
        run,
        mode,
        deliveredSequence,
        phase: "ready_to_finalize",
        cursor,
        inputSnapshot: inputResult.snapshot,
        updates: currentUpdates,
        prior: checkpoint,
        pageCount,
        productCount,
        variantCount,
        counters,
        samples,
        fencingToken,
        source,
      });
      retainedProducts = null;
      return { kind: "yielded" };
    }

    const outcome = await finalizeAdaptiveMode({
      run,
      mode,
      currentUpdates,
      checkpoint: null,
      counters,
      samples,
      fencingToken,
      budget,
    });
    if (
      outcome.kind === "completed" &&
      mode === "prices" &&
      outcome.result.proposed === 0 &&
      retainedProducts
    ) {
      outcome.retainedProducts = retainedProducts;
      outcome.traversalMs = Math.max(0, budget.now() - startedAt);
    }
    return outcome;
  }
}

function continuationQueueSource(
  source: ContinuationSource,
  run: SyncRun,
): "cron" | "manual" | "bulk-finish" | "reconciler" {
  if (source === "cron" || source === "manual" || source === "bulk-finish") {
    return source;
  }
  if (run.source === "cron" || run.source === "manual") return run.source;
  return "reconciler";
}

function isAbortLike(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (error && typeof error === "object" && "cause" in error) {
    return isAbortLike((error as { cause?: unknown }).cause);
  }
  return false;
}

async function enqueueCurrentModeSequence(
  run: SyncRun,
  source: "cron" | "manual" | "bulk-finish" | "reconciler",
  checkpointSequence: number,
): Promise<void> {
  const payload: Extract<SyncContinuationPayload, { kind: "continue-run" }> = {
    kind: "continue-run",
    runId: run.runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: run.currentMode,
    runVersion: run.version,
    checkpointSequence,
  };
  await enqueueSyncContinuation(payload);
}

export async function continueSyncRun(
  runId: string,
  continuationSource: ContinuationSource = "direct",
  checkpointSequence = 0,
  budget: SyncInvocationBudget = createSyncInvocationBudget(),
): Promise<SyncRun | null> {
  const startedAt = budget.now();
  logSyncEvent("sync_continue_requested", {
    runId,
    continuationSource,
    checkpointSequence,
  });
  const initialRun = await getSyncRun(runId);
  if (!initialRun) {
    logSyncEvent(
      "sync_continue_run_missing",
      { runId, continuationSource, checkpointSequence },
      "warn",
    );
    return null;
  }

  return await withSyncLock(async (fencingToken) => {
    let run = await getSyncRun(runId);
    if (!run) return null;
    if (["completed", "failed", "skipped", "waiting_bulk"].includes(run.status)) {
      logSyncEvent("sync_continue_noop", {
        continuationSource,
        checkpointSequence,
        reason: "terminal_or_waiting_bulk",
        ...summarizeSyncRun(run),
      });
      return run;
    }

    const blocker = await getSyncAdmissionBlocker();
    const blockerRunId =
      blocker?.quarantine?.runId ?? blocker?.launchFence?.runId ?? null;
    if (blockerRunId && blockerRunId !== run.runId) {
      const reason = `Store is fenced by ambiguous bulk launch from run ${blockerRunId}`;
      run.status = "failed";
      run.failureReason = reason;
      await saveSyncRun(run, fencingToken);
      await sendSyncFailureAlert({
        runId: run.runId,
        mode: run.currentMode ?? "unknown",
        reason,
      });
      return run;
    }

    const context: RequestLocalContext = {
      priceSnapshot: null,
      priceTraversalMs: 0,
    };
    let deliveredSequence = checkpointSequence;
    const queueSource = continuationQueueSource(continuationSource, run);

    while (run.currentMode) {
      const mode = run.currentMode;
      if (mode === "prices" || mode === "stock") {
        const checkpoint = await getModeCheckpoint(run.runId, mode);
        if (!checkpoint && deliveredSequence > 0) {
          throw new FutureCheckpointSequenceError(
            `checkpoint ${deliveredSequence} has no durable predecessor`,
          );
        }
        if (checkpoint && deliveredSequence > checkpoint.sequence) {
          throw new FutureCheckpointSequenceError(
            `future checkpoint ${deliveredSequence}; expected ${checkpoint.sequence}`,
          );
        }
        if (checkpoint && deliveredSequence < checkpoint.sequence) {
          if (
            checkpoint.continuationState === "needed" &&
            checkpoint.continuationIdentity
          ) {
            try {
              await enqueuePersistedSyncContinuation(
                checkpoint.continuationIdentity,
              );
              checkpoint.continuationState = "enqueued";
              checkpoint.updatedAt = new Date().toISOString();
              await saveModeCheckpoint(checkpoint);
            } catch (error: any) {
              logSyncEvent("sync_stale_continuation_republish_failed", {
                runId: run.runId,
                mode,
                deliveredSequence,
                expectedSequence: checkpoint.sequence,
                error: error?.message ?? String(error),
              });
            }
          }
          logSyncEvent("sync_stale_continuation_noop", {
            runId: run.runId,
            mode,
            deliveredSequence,
            expectedSequence: checkpoint.sequence,
          });
          return run;
        }
      } else if (deliveredSequence !== 0) {
        throw new FutureCheckpointSequenceError(
          `costs mode does not accept checkpoint ${deliveredSequence}`,
        );
      }

      const modeStartedAt = budget.now();
      run.status = "running";
      run.attempts += 1;
      await saveSyncRun(run, fencingToken);
      logSyncEvent("sync_mode_started", {
        continuationSource,
        checkpointSequence: deliveredSequence,
        mode,
        ...summarizeSyncRun(run),
      });

      try {
        let outcome: AdaptiveOutcome | ModeStepOutcome;
        if (mode === "costs") {
          outcome = await startDurableCostsModeStep({
            run,
            fencingToken,
            budget,
          });
        } else {
          outcome = await startAdaptiveModeStep({
            run,
            mode,
            deliveredSequence,
            fencingToken,
            budget,
            source: queueSource,
            reusedProducts:
              mode === "stock" ? context.priceSnapshot : null,
            reusedTraversalMs:
              mode === "stock" ? context.priceTraversalMs : 0,
          });
        }

        if (outcome.kind === "yielded") {
          return await getSyncRun(run.runId);
        }
        if (outcome.kind === "ambiguous") {
          return await getSyncRun(run.runId);
        }
        if (outcome.kind === "waiting_bulk") {
          return await getSyncRun(run.runId);
        }

        recordModeResult(run, mode, outcome.result);
        if (
          mode === "prices" &&
          "retainedProducts" in outcome &&
          outcome.retainedProducts
        ) {
          context.priceSnapshot = outcome.retainedProducts;
          context.priceTraversalMs = outcome.traversalMs ?? 0;
        }
        advanceRun(run);
        await saveSyncRun(run, fencingToken);
        logSyncEvent("sync_mode_completed_without_bulk", {
          continuationSource,
          checkpointSequence: deliveredSequence,
          mode,
          result: outcome.result,
          nextMode: run.currentMode,
          durationMs: budget.now() - modeStartedAt,
          ...summarizeSyncRun(run),
        });
        deliveredSequence = 0;

        if (!run.currentMode) {
          await sendManualSyncSuccessAlert(run);
          return run;
        }

        if (run.currentMode === "stock") {
          const conservativeReuseBudget =
            5_000 +
            Math.max(2_000, Math.ceil(context.priceTraversalMs * 1.5)) +
            budget.minimumFinalizationMs;
          if (
            context.priceSnapshot &&
            remainingBudget(budget) < conservativeReuseBudget
          ) {
            context.priceSnapshot = null;
            await enqueueCurrentModeSequence(run, queueSource, 0);
            logSyncEvent("sync_stock_snapshot_reuse_deferred", {
              runId: run.runId,
              remainingMs: remainingBudget(budget),
              requiredMs: conservativeReuseBudget,
            });
            return run;
          }
          if (
            !context.priceSnapshot &&
            remainingBudget(budget) <
              2_000 + budget.checkpointHeadroomMs
          ) {
            await enqueueCurrentModeSequence(run, queueSource, 0);
            return run;
          }
        }
      } catch (error: any) {
        if (error instanceof FutureCheckpointSequenceError) throw error;
        if (isAbortLike(error)) {
          run = (await getSyncRun(run.runId)) ?? run;
          if (run.status === "failed") return run;
          run.status = "queued";
          await saveSyncRun(run, fencingToken);
          try {
            await enqueueCurrentModeSequence(
              run,
              queueSource,
              deliveredSequence,
            );
          } catch (enqueueError: any) {
            logSyncEvent("sync_deadline_retry_enqueue_deferred", {
              runId: run.runId,
              mode,
              checkpointSequence: deliveredSequence,
              error: enqueueError?.message ?? String(enqueueError),
            });
          }
          logSyncEvent("sync_invocation_deadline_checkpointed", {
            runId: run.runId,
            mode,
            checkpointSequence: deliveredSequence,
          });
          return run;
        }
        const message = error?.message ?? String(error);
        run = (await getSyncRun(run.runId)) ?? run;
        if (run.status === "failed") return run;
        run.status = "failed";
        run.failureReason = message;
        await saveSyncRun(run, fencingToken);
        logSyncEvent(
          "sync_mode_failed",
          {
            continuationSource,
            checkpointSequence: deliveredSequence,
            mode,
            error: message,
            durationMs: budget.now() - modeStartedAt,
            ...summarizeSyncRun(run),
          },
          "error",
        );
        await sendSyncFailureAlert({
          runId: run.runId,
          mode,
          reason: message,
        });
        return run;
      }
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    await saveSyncRun(run, fencingToken);
    logSyncEvent("sync_run_completed", {
      continuationSource,
      durationMs: budget.now() - startedAt,
      ...summarizeSyncRun(run),
    });
    await sendManualSyncSuccessAlert(run);
    return run;
  }, initialRun.storeId);
}

async function handlePriorBulkOpConflict(
  mode: SyncMode,
  err: any,
): Promise<Extract<ModeStepOutcome, { kind: "completed" }> | null> {
  const parsed = tryParsePriorBulkOpActive(err);
  if (!parsed) return null;
  logSyncEvent(
    "sync_prior_bulk_op_conflict",
    {
      mode,
      opId: parsed.op_id,
      opStatus: parsed.status,
    },
    "warn",
  );
  await sendBulkOpConflictAlert({
    mode,
    opId: parsed.op_id,
    status: parsed.status,
  });
  return {
    kind: "completed",
    result: {
      proposed: 0,
      applied: 0,
      skipped: `prior bulk op active: ${parsed.op_id} [${parsed.status}]`,
    },
  };
}

async function assertNoConflictOrSkip(
  mode: SyncMode,
  signal?: AbortSignal,
): Promise<Extract<ModeStepOutcome, { kind: "completed" }> | null> {
  try {
    await assertNoActiveBulkOperation(mode, signal);
    return null;
  } catch (error: any) {
    const conflict = await handlePriorBulkOpConflict(mode, error);
    if (conflict) return conflict;
    throw error;
  }
}

type CostsModePreparation =
  | Extract<ModeStepOutcome, { kind: "completed" }>
  | { kind: "ready"; updates: CostUpdateBulkMutationInput[] };

async function prepareCostsModeStep(
  signal?: AbortSignal,
): Promise<CostsModePreparation> {
  const conflict = await assertNoConflictOrSkip("costs", signal);
  if (conflict) return conflict;

  const alq = await adaptiveDeps().fetchAlqitharaCosts();
  const alqCount = Object.keys(alq).length;
  if (Object.keys(alq).length === 0) {
    logSyncEvent("sync_mode_skipped", {
      mode: "costs",
      reason: "1C AlqitharaCosts payload empty",
    });
    await sendEmptyPayloadAlert({ mode: "costs", source: "AlqitharaCosts" });
    return {
      kind: "completed",
      result: {
        proposed: 0,
        applied: 0,
        skipped: "1C AlqitharaCosts payload empty",
      },
    };
  }

  const local = await adaptiveDeps().fetchLocalCosts();
  const localCount = Object.keys(local).length;
  if (Object.keys(local).length === 0) {
    logSyncEvent("sync_mode_skipped", {
      mode: "costs",
      reason: "1C LocalCosts payload empty",
      oneCAlqitharaCostCount: alqCount,
    });
    await sendEmptyPayloadAlert({ mode: "costs", source: "LocalCosts" });
    return {
      kind: "completed",
      result: {
        proposed: 0,
        applied: 0,
        skipped: "1C LocalCosts payload empty",
      },
    };
  }

  const costs1c = new Map<string, number>();
  for (const barcode in alq) {
    if (Object.prototype.hasOwnProperty.call(alq, barcode))
      costs1c.set(barcode, alq[barcode]);
  }
  for (const barcode in local) {
    if (Object.prototype.hasOwnProperty.call(local, barcode))
      costs1c.set(barcode, local[barcode]);
  }

  const variantsShopify = await adaptiveDeps().fetchVariants();
  const updates: CostUpdateBulkMutationInput[] = [];

  costs1c.forEach((cost, barcode) => {
    const variant = variantsShopify.get(barcode);
    if (!variant) return;
    const weightedCost = applyShopifyWeight(Number(cost), variant.weightKg);
    const newCostStr = Number(weightedCost).toFixed(2);
    const currentCostStr =
      variant.cost !== undefined && variant.cost !== null
        ? Number(variant.cost).toFixed(2)
        : null;
    if (currentCostStr !== newCostStr) {
      updates.push({
        inventoryItemId: variant.inventoryItemId,
        cost: Number(newCostStr),
      });
    }
  });

  logSyncEvent("sync_mode_diff_computed", {
    mode: "costs",
    oneCAlqitharaCostCount: alqCount,
    oneCLocalCostCount: localCount,
    oneCMergedCostCount: costs1c.size,
    shopifyVariantCount: variantsShopify.size,
    proposedUpdates: updates.length,
  });

  if (updates.length === 0)
    return { kind: "completed", result: { proposed: 0, applied: 0 } };

  return { kind: "ready", updates };
}

async function startCostsModeStep(): Promise<ModeStepOutcome> {
  const prepared = await prepareCostsModeStep();
  if (prepared.kind === "completed") return prepared;

  const op = await runCostUpdateBulkMutation(prepared.updates);
  return { kind: "waiting_bulk", op, proposed: prepared.updates.length };
}

async function startDurableCostsModeStep({
  run,
  fencingToken,
  budget,
}: {
  run: SyncRun;
  fencingToken: string;
  budget: SyncInvocationBudget;
}): Promise<AdaptiveOutcome> {
  const prepared = await prepareCostsModeStep(budget.signal);
  if (prepared.kind === "completed") return prepared;
  return {
    kind: await launchDurableBulk({
      run,
      mode: "costs",
      updates: prepared.updates,
      checkpoint: null,
      fencingToken,
      budget,
    }),
  };
}

async function startPricesModeStep(): Promise<ModeStepOutcome> {
  const conflict = await assertNoConflictOrSkip("prices");
  if (conflict) return conflict;

  const prices1c = await fetch1cPrices();
  const oneCPriceCount = Object.keys(prices1c).length;
  if (oneCPriceCount === 0) {
    logSyncEvent("sync_mode_skipped", {
      mode: "prices",
      reason: "1C Prices payload empty",
    });
    await sendEmptyPayloadAlert({ mode: "prices", source: "Prices" });
    return {
      kind: "completed",
      result: { proposed: 0, applied: 0, skipped: "1C Prices payload empty" },
    };
  }

  const discounts1c = await fetch1cDiscounts();
  const oneCDiscountCount = Object.keys(discounts1c).length;
  if (oneCDiscountCount === 0) {
    logSyncEvent("sync_mode_skipped", {
      mode: "prices",
      reason: "1C Discounts payload empty",
      oneCPriceCount,
    });
    await sendEmptyPayloadAlert({ mode: "prices", source: "Discounts" });
    return {
      kind: "completed",
      result: {
        proposed: 0,
        applied: 0,
        skipped: "1C Discounts payload empty",
      },
    };
  }

  const products = await fetchAllShopifyProductsAndVariants();
  const updates: {
    productId: string;
    variantId: string;
    price: string;
    compareAtPrice: string | null;
  }[] = [];
  let discountRemovedCount = 0;
  let variantsWithBarcodes = 0;
  let variantsWith1cPrices = 0;
  let variantsSkippedForNonPositive1cPrice = 0;

  products.forEach((product) => {
    product.variants.forEach((variant) => {
      if (!variant.barcode) return;
      variantsWithBarcodes += 1;
      const priceRaw = prices1c[variant.barcode];
      if (priceRaw === undefined || priceRaw === null) return;
      variantsWith1cPrices += 1;
      if (!isSyncableOneCPrice(priceRaw)) {
        variantsSkippedForNonPositive1cPrice += 1;
        return;
      }

      const compareAtRaw = discounts1c[variant.barcode];
      const target = buildPriceUpdateTargetFromOneC({
        priceRaw,
        compareAtRaw,
        weightKg: product.weightKg,
      });
      if (!target) return;
      const newPrice = target.price;
      const newCompareAtPrice = target.compareAtPrice;

      if (
        (compareAtRaw === undefined || compareAtRaw === null) &&
        variant.compareAtPrice !== null
      ) {
        discountRemovedCount += 1;
        console.log(
          JSON.stringify({
            event: "discount_removed",
            barcode: variant.barcode,
            oldCompareAtPrice: variant.compareAtPrice,
            newPrice,
          }),
        );
      }

      const currentPriceStr =
        variant.price !== undefined && variant.price !== null
          ? Number(variant.price).toFixed(2)
          : null;
      const currentCompareAtPriceStr =
        variant.compareAtPrice !== undefined && variant.compareAtPrice !== null
          ? Number(variant.compareAtPrice).toFixed(2)
          : null;

      if (
        currentPriceStr !== newPrice ||
        currentCompareAtPriceStr !== newCompareAtPrice
      ) {
        updates.push({
          productId: product.id,
          variantId: variant.id,
          price: newPrice,
          compareAtPrice: newCompareAtPrice,
        });
      }
    });
  });

  logSyncEvent("sync_mode_diff_computed", {
    mode: "prices",
    oneCPriceCount,
    oneCDiscountCount,
    shopifyProductCount: products.size,
    shopifyVariantCount: countShopifyVariants(products),
    variantsWithBarcodes,
    variantsWith1cPrices,
    variantsSkippedForNonPositive1cPrice,
    proposedUpdates: updates.length,
    discountRemovedCount,
  });

  if (updates.length === 0)
    return { kind: "completed", result: { proposed: 0, applied: 0 } };

  const op = await runPriceUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
}

async function startStockModeStep(): Promise<ModeStepOutcome> {
  const conflict = await assertNoConflictOrSkip("stock");
  if (conflict) return conflict;

  const stock1c = await fetch1cStock();
  const oneCStockCount = Object.keys(stock1c).length;
  if (oneCStockCount === 0) {
    logSyncEvent("sync_mode_skipped", {
      mode: "stock",
      reason: "1C Stock payload empty",
    });
    await sendEmptyPayloadAlert({ mode: "stock", source: "Stock" });
    return {
      kind: "completed",
      result: { proposed: 0, applied: 0, skipped: "1C Stock payload empty" },
    };
  }

  const products = await fetchAllShopifyProductsAndVariants();
  const {
    updates,
    currentlyActive,
    proposedDraftFlips,
    flippedToDraftSamples,
    protectedProductsSkipped,
  } = buildStockStatusDiff(products, stock1c);

  logSyncEvent("sync_mode_diff_computed", {
    mode: "stock",
    oneCStockCount,
    shopifyProductCount: products.size,
    shopifyVariantCount: countShopifyVariants(products),
    currentlyActive,
    proposedUpdates: updates.length,
    proposedDraftFlips,
    protectedProductsSkipped,
    draftFlipThreshold: DRAFT_FLIP_THRESHOLD,
    proposedDraftFlipRatio:
      currentlyActive > 0 ? proposedDraftFlips / currentlyActive : 0,
  });

  if (
    currentlyActive > 0 &&
    proposedDraftFlips / currentlyActive > DRAFT_FLIP_THRESHOLD
  ) {
    const pct = proposedDraftFlips / currentlyActive;
    const sample = flippedToDraftSamples.map((p) => ({
      handle: p.handle,
      barcode: p.variants[0]?.barcode ?? "",
    }));
    logSyncEvent(
      "sync_stock_safety_floor_triggered",
      {
        mode: "stock",
        totalActive: currentlyActive,
        proposedFlips: proposedDraftFlips,
        percentage: pct,
        sampleSize: sample.length,
      },
      "warn",
    );
    await sendSafetyFloorAlert({
      totalActive: currentlyActive,
      proposedFlips: proposedDraftFlips,
      percentage: pct,
      sampleSkus: sample,
    });
    return {
      kind: "completed",
      result: {
        proposed: updates.length,
        applied: 0,
        skipped: `20% DRAFT-flip floor exceeded: ${proposedDraftFlips}/${currentlyActive} = ${(pct * 100).toFixed(1)}%`,
      },
    };
  }

  if (updates.length === 0)
    return { kind: "completed", result: { proposed: 0, applied: 0 } };

  const op = await runStatusUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
}

export type BulkOperationFinishResult = {
  run: SyncRun | null;
  needsContinuation: boolean;
  completedOpId?: string;
  nextContinuationPayload?: SyncContinuationPayload;
};

export async function enqueueBulkFinishNextContinuation(
  result: BulkOperationFinishResult,
): Promise<EnqueueSyncContinuationResult | null> {
  if (
    !result.needsContinuation ||
    !result.nextContinuationPayload ||
    !result.completedOpId
  ) {
    return null;
  }

  const nextMessage = await enqueueSyncContinuation(
    result.nextContinuationPayload,
  );
  await markPendingNextContinuationEnqueued({
    opId: result.completedOpId,
    qstashCorrelationId: nextMessage.correlationId,
    qstashMessageId: nextMessage.messageId,
  });
  logSyncEvent("qstash_bulk_finish_next_enqueued", {
    opId: result.completedOpId,
    runId: result.run?.runId,
    qstashCorrelationId: nextMessage.correlationId,
    qstashMessageId: nextMessage.messageId,
    qstashDeduplicationId: nextMessage.deduplicationId,
    qstashDeduplicated: nextMessage.deduplicated,
  });
  return nextMessage;
}

function noBulkFinishContinuation(
  run: SyncRun | null,
): BulkOperationFinishResult {
  return { run, needsContinuation: false };
}

function nextPayloadFromRun(
  run: SyncRun,
  source: "bulk-finish",
): SyncContinuationPayload {
  return {
    kind: "continue-run",
    runId: run.runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: run.currentMode,
    runVersion: run.version,
    checkpointSequence: 0,
  };
}

function nextPayloadFromPending(
  pending: PendingNextContinuation,
): SyncContinuationPayload {
  return {
    kind: "continue-run",
    runId: pending.runId,
    source: "bulk-finish",
    currentIndex: pending.currentIndex,
    currentMode: pending.currentMode,
    runVersion: pending.runVersion,
    checkpointSequence: 0,
  };
}

async function recordPendingNextModeContinuation({
  opId,
  run,
  nextIndex,
  nextMode,
}: {
  opId: string;
  run: SyncRun;
  nextIndex: number;
  nextMode: SyncMode;
}): Promise<void> {
  const now = new Date().toISOString();
  await savePendingNextContinuation({
    opId,
    runId: run.runId,
    currentIndex: nextIndex,
    currentMode: nextMode,
    runVersion: run.version + 1,
    state: "pending",
    createdAt: now,
    updatedAt: now,
    qstashCorrelationId: null,
    qstashMessageId: null,
  });
}

export async function handleBulkOperationFinished({
  opId,
  status,
  errorCode,
  source = "direct",
}: {
  opId: string;
  status: string;
  errorCode: string | null;
  source?: "direct" | "shopify-webhook" | "reconciler";
}): Promise<BulkOperationFinishResult> {
  logSyncEvent("sync_bulk_finish_received", {
    completionSource: source,
    opId,
    opStatus: status,
    errorCode,
  });
  const runId = await getRunIdForOperation(opId);
  if (!runId) {
    logSyncEvent(
      "bulk_webhook_unknown_operation",
      { completionSource: source, opId, opStatus: status },
      "warn",
    );
    return noBulkFinishContinuation(null);
  }

  const initialRun = await getSyncRun(runId);
  if (!initialRun) {
    logSyncEvent(
      "sync_bulk_finish_run_missing",
      { completionSource: source, runId, opId, opStatus: status },
      "warn",
    );
    return noBulkFinishContinuation(null);
  }

  const fencingToken = await acquireSyncLock(initialRun.storeId);
  if (!fencingToken) {
    logSyncEvent(
      "sync_bulk_finish_lock_busy",
      { completionSource: source, runId, opId, opStatus: status },
      "warn",
    );
    throw new Error(`sync bulk-finish lock busy for operation ${opId}`);
  }

  try {
    const run = await getSyncRun(runId);
    if (!run) {
      logSyncEvent(
        "sync_bulk_finish_run_missing",
        { completionSource: source, runId, opId, opStatus: status },
        "warn",
      );
      return noBulkFinishContinuation(null);
    }
    if (run.activeBulkOperationId !== opId) {
      const pending = await getPendingNextContinuation(opId);
      if (
        pending?.state === "pending" &&
        pending.runId === run.runId &&
        run.status === "queued" &&
        run.currentIndex === pending.currentIndex &&
        run.currentMode === pending.currentMode
      ) {
        logSyncEvent("sync_bulk_finish_pending_next_recovered", {
          completionSource: source,
          opId,
          opStatus: status,
          pendingCurrentIndex: pending.currentIndex,
          pendingCurrentMode: pending.currentMode,
          ...summarizeSyncRun(run),
        });
        return {
          run,
          needsContinuation: true,
          completedOpId: opId,
          nextContinuationPayload: nextPayloadFromPending(pending),
        };
      }
      logSyncEvent("sync_bulk_finish_ignored", {
        completionSource: source,
        reason: "operation_is_not_active_for_run",
        pendingNextState: pending?.state,
        opId,
        opStatus: status,
        ...summarizeSyncRun(run),
      });
      return noBulkFinishContinuation(run);
    }
    if (run.status !== "waiting_bulk") {
      logSyncEvent("sync_bulk_finish_ignored", {
        completionSource: source,
        reason: "run_not_waiting_bulk",
        opId,
        opStatus: status,
        ...summarizeSyncRun(run),
      });
      return noBulkFinishContinuation(run);
    }

    const mode = run.currentMode;
    if (!mode) {
      logSyncEvent("sync_bulk_finish_ignored", {
        completionSource: source,
        reason: "run_has_no_current_mode",
        opId,
        opStatus: status,
        ...summarizeSyncRun(run),
      });
      return noBulkFinishContinuation(run);
    }

    const normalizedStatus = status.toUpperCase();

    if (normalizedStatus === "COMPLETED") {
      const proposed = run.proposedByMode[mode] ?? 0;
      const nextIndex = run.currentIndex + 1;
      const nextMode = run.requestedModes[nextIndex] ?? null;
      if (nextMode) {
        await recordPendingNextModeContinuation({
          opId,
          run,
          nextIndex,
          nextMode,
        });
      }
      recordModeResult(run, mode, { proposed, applied: proposed });
      advanceRun(run);
      await saveSyncRun(run, fencingToken);
      logSyncEvent("sync_bulk_operation_completed", {
        completionSource: source,
        mode,
        opId,
        opStatus: normalizedStatus,
        proposed,
        applied: proposed,
        nextMode: run.currentMode,
        ...summarizeSyncRun(run),
      });
      if (run.currentMode) {
        return {
          run,
          needsContinuation: true,
          completedOpId: opId,
          nextContinuationPayload: nextPayloadFromRun(run, "bulk-finish"),
        };
      } else {
        logSyncEvent("sync_run_completed", {
          completionSource: source,
          ...summarizeSyncRun(run),
        });
        await sendManualSyncSuccessAlert(run);
      }
      return noBulkFinishContinuation(run);
    }

    if (
      normalizedStatus === "FAILED" ||
      normalizedStatus === "CANCELED" ||
      normalizedStatus === "EXPIRED"
    ) {
      const reason = `Bulk op ${opId} (${mode}) ended with ${normalizedStatus}, code=${errorCode ?? "null"}`;
      run.status = "failed";
      run.failureReason = reason;
      await saveSyncRun(run, fencingToken);
      logSyncEvent(
        "sync_bulk_operation_failed",
        {
          completionSource: source,
          mode,
          opId,
          opStatus: normalizedStatus,
          errorCode,
          reason,
          ...summarizeSyncRun(run),
        },
        "error",
      );
      await sendSyncFailureAlert({ runId: run.runId, mode, reason });
      return noBulkFinishContinuation(run);
    }

    logSyncEvent("sync_bulk_operation_not_terminal", {
      completionSource: source,
      mode,
      opId,
      opStatus: normalizedStatus,
      ...summarizeSyncRun(run),
    });
    return noBulkFinishContinuation(run);
  } finally {
    await releaseSyncLock(fencingToken, initialRun.storeId);
  }
}

const QUARANTINE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_CHECK_SPACING_MS = 5 * 60 * 1000;

async function reconcileBulkLaunchQuarantine(
  budget: SyncInvocationBudget,
): Promise<boolean> {
  const quarantine = await resolveBulkQuarantine();
  if (!quarantine) return false;
  const now = Date.now();
  try {
    const active = await adaptiveDeps().getCurrentBulk(
      budget.signal,
      quarantine.storeId,
    );
    if (active && ["RUNNING", "CREATED", "CANCELING"].includes(active.status.toUpperCase())) {
      await saveBulkQuarantineIfCurrent(
        quarantine,
        quarantine.runId,
        quarantine.quarantineToken,
      );
      logSyncEvent("sync_bulk_quarantine_refreshed", {
        runId: quarantine.runId,
        mode: quarantine.mode,
        diagnostic: "active_mutation",
        opId: active.id,
        opStatus: active.status,
      });
      return false;
    }

    const checks = quarantine.noActiveCheckTimestamps
      .map((value) => Date.parse(value))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const lastCheck = checks.at(-1) ?? 0;
    if (now - lastCheck >= QUARANTINE_CHECK_SPACING_MS) {
      quarantine.noActiveCheckTimestamps = [
        ...quarantine.noActiveCheckTimestamps,
        new Date(now).toISOString(),
      ].slice(-3);
    }
    const createdAt = Date.parse(quarantine.createdAt);
    const spacedChecks = quarantine.noActiveCheckTimestamps
      .map((value) => Date.parse(value))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const hasThreeSpaced =
      spacedChecks.length >= 3 &&
      spacedChecks[1] - spacedChecks[0] >= QUARANTINE_CHECK_SPACING_MS &&
      spacedChecks[2] - spacedChecks[1] >= QUARANTINE_CHECK_SPACING_MS;
    if (
      Number.isFinite(createdAt) &&
      now - createdAt >= QUARANTINE_MIN_AGE_MS &&
      hasThreeSpaced
    ) {
      const cleared = await deleteBulkQuarantine(
        quarantine.storeId,
        quarantine.runId,
        quarantine.quarantineToken,
      );
      if (cleared) {
        logSyncEvent("sync_bulk_quarantine_cleared", {
          runId: quarantine.runId,
          mode: quarantine.mode,
          source: "reconciler",
          noActiveCheckCount: spacedChecks.length,
        });
        return true;
      }
    }
    await saveBulkQuarantineIfCurrent(
      quarantine,
      quarantine.runId,
      quarantine.quarantineToken,
    );
    logSyncEvent("sync_bulk_quarantine_no_active_check", {
      runId: quarantine.runId,
      mode: quarantine.mode,
      noActiveCheckCount: quarantine.noActiveCheckTimestamps.length,
      ageMs: Number.isFinite(createdAt) ? now - createdAt : null,
    });
    return false;
  } catch (error: any) {
    await saveBulkQuarantineIfCurrent(
      quarantine,
      quarantine.runId,
      quarantine.quarantineToken,
    );
    logSyncEvent(
      "sync_bulk_quarantine_diagnostic_inconclusive",
      {
        runId: quarantine.runId,
        mode: quarantine.mode,
        error: error?.message ?? String(error),
      },
      "warn",
    );
    return false;
  }
}

export async function clearBulkLaunchQuarantine({
  quarantineToken,
  terminalOperationId,
}: {
  quarantineToken: string;
  terminalOperationId?: string;
}): Promise<boolean> {
  const initial = await resolveBulkQuarantine();
  if (!initial || initial.quarantineToken !== quarantineToken) return false;
  const fencingToken = await acquireSyncLock(initial.storeId);
  if (!fencingToken) return false;
  try {
  const quarantine = await getBulkQuarantine(initial.storeId);
  if (
    !quarantine ||
    quarantine.runId !== initial.runId ||
    quarantine.quarantineToken !== quarantineToken
  ) return false;
  let proof = "no_active_mutation";
  const active = await adaptiveDeps().getCurrentBulk(
    undefined,
    quarantine.storeId,
  );
  if (
    active &&
    ["RUNNING", "CREATED", "CANCELING"].includes(active.status.toUpperCase())
  ) {
    return false;
  }
  if (terminalOperationId) {
    if (
      !quarantine.knownOperationId ||
      terminalOperationId !== quarantine.knownOperationId
    ) {
      return false;
    }
    const operation = await getBulkOperationById(
      terminalOperationId,
      undefined,
      quarantine.storeId,
    );
    if (
      !operation ||
      !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(
        operation.status.toUpperCase(),
      )
    ) {
      return false;
    }
    proof = `terminal_operation:${operation.status.toUpperCase()}`;
  } else if (quarantine.knownOperationId) {
    return false;
  }
  const cleared = await deleteBulkQuarantine(
    quarantine.storeId,
    quarantine.runId,
    quarantineToken,
  );
  if (cleared) {
    logSyncEvent("sync_bulk_quarantine_cleared", {
      runId: quarantine.runId,
      mode: quarantine.mode,
      source: "operator",
      proof,
    });
  }
  return cleared;
  } finally {
    await releaseSyncLock(fencingToken, initial.storeId);
  }
}

export async function reconcileSyncRuns(
  budget: SyncInvocationBudget = createSyncInvocationBudget(),
): Promise<{
  checked: number;
  changed: number;
}> {
  const startedAt = Date.now();
  const quarantineCleared = await reconcileBulkLaunchQuarantine(budget);
  const runs = await listOpenRuns();
  logSyncEvent("sync_reconcile_started", { openRunCount: runs.length });
  let changed = quarantineCleared ? 1 : 0;
  for (const run of runs) {
    logSyncEvent("sync_reconcile_run_checked", summarizeSyncRun(run));
    if (run.status === "queued" || run.status === "running") {
      logSyncEvent("sync_reconcile_continue_requested", summarizeSyncRun(run));
      const checkpointSequence =
        run.currentMode === "prices" || run.currentMode === "stock"
          ? (await getModeCheckpoint(run.runId, run.currentMode))?.sequence ?? 0
          : 0;
      const continued = await continueSyncRun(run.runId, "reconciler", checkpointSequence, budget);
      if (continued?.version !== run.version) changed += 1;
      continue;
    }

    if (run.status !== "waiting_bulk" || !run.activeBulkOperationId) {
      logSyncEvent("sync_reconcile_run_ignored", {
        reason: "not_waiting_for_bulk",
        ...summarizeSyncRun(run),
      });
      continue;
    }

    const op = await getBulkOperationById(
      run.activeBulkOperationId,
      budget.signal,
      run.storeId,
    );
    if (!op) {
      logSyncEvent(
        "sync_reconcile_bulk_operation_missing",
        {
          opId: run.activeBulkOperationId,
          ...summarizeSyncRun(run),
        },
        "warn",
      );
      continue;
    }

    logSyncEvent("sync_reconcile_bulk_status_checked", {
      opId: op.id,
      opStatus: op.status,
      opType: op.type,
      errorCode: op.errorCode,
      hasResultUrl: Boolean(op.url),
      hasPartialDataUrl: Boolean(op.partialDataUrl),
      ...summarizeSyncRun(run),
    });

    if (
      ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(
        op.status.toUpperCase(),
      )
    ) {
      const finishResult = await handleBulkOperationFinished({
        opId: run.activeBulkOperationId,
        status: op.status,
        errorCode: op.errorCode,
        source: "reconciler",
      });
      const pending = finishResult.completedOpId
        ? await getPendingNextContinuation(finishResult.completedOpId)
        : null;
      try {
        await enqueueBulkFinishNextContinuation(finishResult);
      } catch (error: any) {
        const message = error?.message ?? String(error);
        const reason = `Failed to enqueue next sync continuation after reconciled bulk operation ${finishResult.completedOpId ?? op.id}: ${message}`;
        if (pending) {
          const outcome = await failPendingNextContinuationIfCurrent({ expected: pending, reason });
          if (outcome === "applied") {
            await sendSyncFailureAlert({ runId: pending.runId, mode: pending.currentMode, reason });
          }
          logSyncEvent("sync_reconcile_enqueue_failure_transition", {
            runId: pending.runId, opId: pending.opId, outcome,
          });
        }
        throw error;
      }
      changed += 1;
      continue;
    }

    const updatedAt = new Date(run.updatedAt).getTime();
    const staleAfter =
      run.activeBulkOperationType === "QUERY"
        ? QUERY_STALE_MS
        : MUTATION_STALE_MS;
    if (Date.now() - updatedAt > staleAfter) {
      run.missedRecoveryCount += 1;
      await saveSyncRun(run);
      changed += 1;
      logSyncEvent(
        "sync_reconcile_bulk_stale",
        {
          staleAfterMs: staleAfter,
          ageMs: Date.now() - updatedAt,
          ...summarizeSyncRun(run),
        },
        "warn",
      );
      await sendBulkOpTimeoutAlert({
        mode: run.currentMode ?? "unknown",
        opId: run.activeBulkOperationId,
      });
      if (run.missedRecoveryCount >= 2) {
        await sendSyncFailureAlert({
          runId: run.runId,
          mode: run.currentMode ?? "unknown",
          reason:
            "Queue/workflow escalation required after two missed recovery windows >24h",
        });
      }
    } else {
      logSyncEvent("sync_reconcile_bulk_still_running", {
        staleAfterMs: staleAfter,
        ageMs: Date.now() - updatedAt,
        ...summarizeSyncRun(run),
      });
    }
  }
  logSyncEvent("sync_reconcile_completed", {
    checked: runs.length,
    changed,
    durationMs: Date.now() - startedAt,
  });
  return { checked: runs.length, changed };
}

// Legacy synchronous runner retained for local/manual debugging only. API routes must not call it.
export async function runSync({
  modes,
}: {
  modes: SyncMode[];
}): Promise<SyncResult> {
  const orderedModes = canonicalizeModes(modes);
  const results: SyncResult = {};
  for (const mode of orderedModes) {
    if (mode === "costs") {
      const outcome = await startCostsModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "costs");
        results.costs = {
          proposed: outcome.proposed,
          applied: outcome.proposed,
        };
      } else results.costs = outcome.result;
    } else if (mode === "prices") {
      const outcome = await startPricesModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "prices");
        results.prices = {
          proposed: outcome.proposed,
          applied: outcome.proposed,
        };
      } else results.prices = outcome.result;
    } else {
      const outcome = await startStockModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "stock");
        results.stock = {
          proposed: outcome.proposed,
          applied: outcome.proposed,
        };
      } else results.stock = outcome.result;
    }
  }
  return results;
}

export function isSyncConfigError(error: unknown): boolean {
  return isMissingRedisConfig(error) || isSyncContinuationConfigError(error);
}
