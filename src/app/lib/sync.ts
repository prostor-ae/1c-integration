import {
  fetchAllShopifyProductsAndVariants,
  fetchAllShopifyVariants,
  assertNoActiveBulkOperation,
  getBulkOperationById as fetchBulkOperationById,
  pollBulkOperation,
  runCostUpdateBulkMutation,
  runPriceUpdateBulkMutation,
  runStatusUpdateBulkMutation,
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
  createSyncRun,
  getPendingNextContinuation,
  getRunIdForOperation,
  getSyncRun,
  isMissingRedisConfig,
  listOpenRuns,
  markPendingNextContinuationEnqueued,
  releaseSyncLock,
  savePendingNextContinuation,
  saveSyncRun,
  withSyncLock,
  type AcceptedRun,
  type PendingNextContinuation,
  type SyncRun,
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
  isSyncContinuationConfigError,
  type EnqueueSyncContinuationResult,
  type SyncContinuationPayload,
} from "./qstash-sync";

export type { ModeResult, SyncMode, SyncResult } from "./sync-types";

const DRAFT_FLIP_THRESHOLD = 0.2;
const MUTATION_STALE_MS = 4 * 60 * 60 * 1000;
const QUERY_STALE_MS = 24 * 60 * 60 * 1000;

type BulkOperationLookup = (
  id: string,
) => Promise<ShopifyBulkOperationStatus | null>;

let bulkOperationLookupOverride: BulkOperationLookup | null = null;

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
};

export function buildStockStatusDiff(
  products: Map<string, ShopifyProductInfo>,
  stock1c: Record<string, unknown>,
): StockStatusDiff {
  const updates: StockStatusUpdate[] = [];
  let currentlyActive = 0;
  let proposedDraftFlips = 0;
  const flippedToDraftSamples: ShopifyProductInfo[] = [];

  products.forEach((product) => {
    if (product.status === "ACTIVE") currentlyActive += 1;

    let productInStock = false;
    for (const variant of product.variants) {
      if (!variant.barcode) continue;
      if (isActiveOneCStockAmount(stock1c[variant.barcode])) {
        productInStock = true;
        break;
      }
    }

    const newStatus: "ACTIVE" | "DRAFT" = productInStock ? "ACTIVE" : "DRAFT";
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
): Promise<ShopifyBulkOperationStatus | null> {
  const lookup = bulkOperationLookupOverride ?? fetchBulkOperationById;
  return await lookup(id);
}

export function __setBulkOperationByIdForTests(
  lookup: BulkOperationLookup | null,
): void {
  bulkOperationLookupOverride = lookup;
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

export async function acceptSyncRun({
  modes,
  source,
}: {
  modes: SyncMode[];
  source: SyncRun["source"];
}): Promise<AcceptedRun> {
  const accepted = await createSyncRun({ modes, source });
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
  };
  const result = await enqueueSyncContinuation(payload);
  logSyncEvent("sync_continuation_enqueued", {
    runId,
    source,
    currentIndex: run.currentIndex,
    currentMode: run.currentMode,
    runVersion: run.version,
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

export async function continueSyncRun(
  runId: string,
  continuationSource: ContinuationSource = "direct",
): Promise<SyncRun | null> {
  const startedAt = Date.now();
  logSyncEvent("sync_continue_requested", { runId, continuationSource });
  const initialRun = await getSyncRun(runId);
  if (!initialRun) {
    logSyncEvent(
      "sync_continue_run_missing",
      { runId, continuationSource },
      "warn",
    );
    return null;
  }

  return await withSyncLock(async (fencingToken) => {
    const run = await getSyncRun(runId);
    if (!run) {
      logSyncEvent(
        "sync_continue_run_missing",
        { runId, continuationSource },
        "warn",
      );
      return null;
    }
    if (
      ["completed", "failed", "skipped", "waiting_bulk"].includes(run.status)
    ) {
      logSyncEvent("sync_continue_noop", {
        continuationSource,
        reason: "terminal_or_waiting_bulk",
        ...summarizeSyncRun(run),
      });
      return run;
    }

    while (run.currentMode) {
      const modeStartedAt = Date.now();
      run.status = "running";
      run.attempts += 1;
      await saveSyncRun(run, fencingToken);

      const mode = run.currentMode;
      logSyncEvent("sync_mode_started", {
        continuationSource,
        mode,
        ...summarizeSyncRun(run),
      });
      try {
        const outcome = await startModeStep(mode);
        if (outcome.kind === "waiting_bulk") {
          run.status = "waiting_bulk";
          run.activeBulkOperationId = outcome.op.id;
          run.activeBulkOperationType = "MUTATION";
          run.proposedByMode[mode] = outcome.proposed;
          run.appliedByMode[mode] = 0;
          await saveSyncRun(run, fencingToken);
          logSyncEvent("sync_mode_waiting_bulk", {
            continuationSource,
            mode,
            proposed: outcome.proposed,
            opId: outcome.op.id,
            opStatus: outcome.op.status,
            durationMs: Date.now() - modeStartedAt,
            ...summarizeSyncRun(run),
          });
          return run;
        }

        recordModeResult(run, mode, outcome.result);
        advanceRun(run);
        await saveSyncRun(run, fencingToken);
        logSyncEvent("sync_mode_completed_without_bulk", {
          continuationSource,
          mode,
          result: outcome.result,
          nextMode: run.currentMode,
          durationMs: Date.now() - modeStartedAt,
          ...summarizeSyncRun(run),
        });
        if (!run.currentMode) {
          logSyncEvent("sync_run_completed", {
            continuationSource,
            durationMs: Date.now() - startedAt,
            ...summarizeSyncRun(run),
          });
          await sendManualSyncSuccessAlert(run);
          return run;
        }
      } catch (error: any) {
        const message = error?.message ?? String(error);
        run.status = "failed";
        run.failureReason = message;
        await saveSyncRun(run, fencingToken);
        logSyncEvent(
          "sync_mode_failed",
          {
            continuationSource,
            mode,
            error: message,
            durationMs: Date.now() - modeStartedAt,
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
      durationMs: Date.now() - startedAt,
      ...summarizeSyncRun(run),
    });
    await sendManualSyncSuccessAlert(run);
    return run;
  }, initialRun.storeId);
}

async function startModeStep(mode: SyncMode): Promise<ModeStepOutcome> {
  if (mode === "costs") return await startCostsModeStep();
  if (mode === "prices") return await startPricesModeStep();
  return await startStockModeStep();
}

async function handlePriorBulkOpConflict(
  mode: SyncMode,
  err: any,
): Promise<ModeStepOutcome | null> {
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
): Promise<ModeStepOutcome | null> {
  try {
    await assertNoActiveBulkOperation(mode);
    return null;
  } catch (error: any) {
    const conflict = await handlePriorBulkOpConflict(mode, error);
    if (conflict) return conflict;
    throw error;
  }
}

async function startCostsModeStep(): Promise<ModeStepOutcome> {
  const conflict = await assertNoConflictOrSkip("costs");
  if (conflict) return conflict;

  const alq = await fetch1cAlqitharaCosts();
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

  const local = await fetch1cLocalCosts();
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

  const variantsShopify = await fetchAllShopifyVariants();
  const updates: { inventoryItemId: string; cost: number }[] = [];

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

  const op = await runCostUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
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
  } = buildStockStatusDiff(products, stock1c);

  logSyncEvent("sync_mode_diff_computed", {
    mode: "stock",
    oneCStockCount,
    shopifyProductCount: products.size,
    shopifyVariantCount: countShopifyVariants(products),
    currentlyActive,
    proposedUpdates: updates.length,
    proposedDraftFlips,
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

export async function reconcileSyncRuns(): Promise<{
  checked: number;
  changed: number;
}> {
  const startedAt = Date.now();
  const runs = await listOpenRuns();
  logSyncEvent("sync_reconcile_started", { openRunCount: runs.length });
  let changed = 0;
  for (const run of runs) {
    logSyncEvent("sync_reconcile_run_checked", summarizeSyncRun(run));
    if (run.status === "queued" || run.status === "running") {
      logSyncEvent("sync_reconcile_continue_requested", summarizeSyncRun(run));
      const continued = await continueSyncRun(run.runId, "reconciler");
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

    const op = await getBulkOperationById(run.activeBulkOperationId);
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
      try {
        await enqueueBulkFinishNextContinuation(finishResult);
      } catch (error: any) {
        const message = error?.message ?? String(error);
        if (finishResult.run?.runId) {
          await markSyncRunFailed({
            runId: finishResult.run.runId,
            mode: finishResult.run.currentMode,
            reason: `Failed to enqueue next sync continuation after reconciled bulk operation ${finishResult.completedOpId ?? op.id}: ${message}`,
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
