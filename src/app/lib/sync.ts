import {
  fetchAllShopifyProductsAndVariants,
  fetchAllShopifyVariants,
  assertNoActiveBulkOperation,
  getBulkOperationById,
  pollBulkOperation,
  runCostUpdateBulkMutation,
  runPriceUpdateBulkMutation,
  runStatusUpdateBulkMutation,
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
} from "./alerts";
import {
  canonicalizeModes,
  type ModeResult,
  type SyncMode,
  type SyncResult,
} from "./sync-types";
import {
  createSyncRun,
  getRunIdForOperation,
  getSyncRun,
  isMissingRedisConfig,
  listOpenRuns,
  saveSyncRun,
  withSyncLock,
  type AcceptedRun,
  type SyncRun,
} from "./sync-state";

export type { ModeResult, SyncMode, SyncResult } from "./sync-types";

const DRAFT_FLIP_THRESHOLD = 0.2;
const MUTATION_STALE_MS = 4 * 60 * 60 * 1000;
const QUERY_STALE_MS = 24 * 60 * 60 * 1000;


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

export async function acceptSyncRun({
  modes,
  source,
}: {
  modes: SyncMode[];
  source: SyncRun["source"];
}): Promise<AcceptedRun> {
  return createSyncRun({ modes, source });
}

export function kickOffSyncRun(runId: string): void {
  if (process.env.DISABLE_SYNC_KICKOFF === "1") return;
  setTimeout(() => {
    continueSyncRun(runId).catch((error) => {
      console.error(
        JSON.stringify({
          event: "sync_kickoff_failed",
          runId,
          error: error?.message ?? String(error),
        })
      );
    });
  }, 0);
}

export async function continueSyncRun(runId: string): Promise<SyncRun | null> {
  return await withSyncLock(async (fencingToken) => {
    const run = await getSyncRun(runId);
    if (!run) return null;
    if (["completed", "failed", "skipped", "waiting_bulk"].includes(run.status)) {
      return run;
    }

    while (run.currentMode) {
      run.status = "running";
      run.attempts += 1;
      await saveSyncRun(run, fencingToken);

      const mode = run.currentMode;
      try {
        const outcome = await startModeStep(mode);
        if (outcome.kind === "waiting_bulk") {
          run.status = "waiting_bulk";
          run.activeBulkOperationId = outcome.op.id;
          run.activeBulkOperationType = "MUTATION";
          run.proposedByMode[mode] = outcome.proposed;
          run.appliedByMode[mode] = 0;
          await saveSyncRun(run, fencingToken);
          return run;
        }

        recordModeResult(run, mode, outcome.result);
        advanceRun(run);
        await saveSyncRun(run, fencingToken);
        if (!run.currentMode) return run;
      } catch (error: any) {
        const message = error?.message ?? String(error);
        run.status = "failed";
        run.failureReason = message;
        await saveSyncRun(run, fencingToken);
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
    return run;
  });
}

async function startModeStep(mode: SyncMode): Promise<ModeStepOutcome> {
  if (mode === "costs") return await startCostsModeStep();
  if (mode === "prices") return await startPricesModeStep();
  return await startStockModeStep();
}

async function handlePriorBulkOpConflict(mode: SyncMode, err: any): Promise<ModeStepOutcome | null> {
  const parsed = tryParsePriorBulkOpActive(err);
  if (!parsed) return null;
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

async function assertNoConflictOrSkip(mode: SyncMode): Promise<ModeStepOutcome | null> {
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
  if (Object.keys(alq).length === 0) {
    await sendEmptyPayloadAlert({ mode: "costs", source: "AlqitharaCosts" });
    return {
      kind: "completed",
      result: { proposed: 0, applied: 0, skipped: "1C AlqitharaCosts payload empty" },
    };
  }

  const local = await fetch1cLocalCosts();
  if (Object.keys(local).length === 0) {
    await sendEmptyPayloadAlert({ mode: "costs", source: "LocalCosts" });
    return {
      kind: "completed",
      result: { proposed: 0, applied: 0, skipped: "1C LocalCosts payload empty" },
    };
  }

  const costs1c = new Map<string, number>();
  for (const barcode in alq) {
    if (Object.prototype.hasOwnProperty.call(alq, barcode)) costs1c.set(barcode, alq[barcode]);
  }
  for (const barcode in local) {
    if (Object.prototype.hasOwnProperty.call(local, barcode)) costs1c.set(barcode, local[barcode]);
  }

  const variantsShopify = await fetchAllShopifyVariants();
  const updates: { inventoryItemId: string; cost: number }[] = [];

  costs1c.forEach((cost, barcode) => {
    const variant = variantsShopify.get(barcode);
    if (!variant) return;
    const newCostStr = Number(cost).toFixed(2);
    const currentCostStr =
      variant.cost !== undefined && variant.cost !== null ? Number(variant.cost).toFixed(2) : null;
    if (currentCostStr !== newCostStr) {
      updates.push({ inventoryItemId: variant.inventoryItemId, cost });
    }
  });

  if (updates.length === 0) return { kind: "completed", result: { proposed: 0, applied: 0 } };

  const op = await runCostUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
}

async function startPricesModeStep(): Promise<ModeStepOutcome> {
  const conflict = await assertNoConflictOrSkip("prices");
  if (conflict) return conflict;

  const prices1c = await fetch1cPrices();
  if (Object.keys(prices1c).length === 0) {
    await sendEmptyPayloadAlert({ mode: "prices", source: "Prices" });
    return { kind: "completed", result: { proposed: 0, applied: 0, skipped: "1C Prices payload empty" } };
  }

  const discounts1c = await fetch1cDiscounts();
  if (Object.keys(discounts1c).length === 0) {
    await sendEmptyPayloadAlert({ mode: "prices", source: "Discounts" });
    return { kind: "completed", result: { proposed: 0, applied: 0, skipped: "1C Discounts payload empty" } };
  }

  const products = await fetchAllShopifyProductsAndVariants();
  const updates: { variantId: string; price: string; compareAtPrice: string | null }[] = [];

  products.forEach((product) => {
    product.variants.forEach((variant) => {
      if (!variant.barcode) return;
      const priceRaw = prices1c[variant.barcode];
      if (priceRaw === undefined || priceRaw === null) return;

      const priceStr = Number(priceRaw).toFixed(2);
      const discountRaw = discounts1c[variant.barcode];
      const hasValidDiscount =
        discountRaw !== undefined && discountRaw !== null && Number(discountRaw) < Number(priceStr);
      const newPrice = hasValidDiscount ? Number(discountRaw).toFixed(2) : priceStr;
      const newCompareAtPrice: string | null = hasValidDiscount ? priceStr : null;

      if ((discountRaw === undefined || discountRaw === null) && variant.compareAtPrice !== null) {
        console.log(
          JSON.stringify({
            event: "discount_removed",
            barcode: variant.barcode,
            oldCompareAtPrice: variant.compareAtPrice,
            newPrice,
          })
        );
      }

      const currentPriceStr =
        variant.price !== undefined && variant.price !== null ? Number(variant.price).toFixed(2) : null;
      const currentCompareAtPriceStr =
        variant.compareAtPrice !== undefined && variant.compareAtPrice !== null
          ? Number(variant.compareAtPrice).toFixed(2)
          : null;

      if (currentPriceStr !== newPrice || currentCompareAtPriceStr !== newCompareAtPrice) {
        updates.push({ variantId: variant.id, price: newPrice, compareAtPrice: newCompareAtPrice });
      }
    });
  });

  if (updates.length === 0) return { kind: "completed", result: { proposed: 0, applied: 0 } };

  const op = await runPriceUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
}

async function startStockModeStep(): Promise<ModeStepOutcome> {
  const conflict = await assertNoConflictOrSkip("stock");
  if (conflict) return conflict;

  const stock1c = await fetch1cStock();
  if (Object.keys(stock1c).length === 0) {
    await sendEmptyPayloadAlert({ mode: "stock", source: "Stock" });
    return { kind: "completed", result: { proposed: 0, applied: 0, skipped: "1C Stock payload empty" } };
  }

  const products = await fetchAllShopifyProductsAndVariants();
  const updates: { productId: string; status: "ACTIVE" | "DRAFT" }[] = [];
  let currentlyActive = 0;
  let proposedDraftFlips = 0;
  const flippedToDraftSamples: ShopifyProductInfo[] = [];

  products.forEach((product) => {
    if (product.status === "ACTIVE") currentlyActive += 1;

    let productInStock = false;
    for (const variant of product.variants) {
      if (!variant.barcode) continue;
      const stockBalance = stock1c[variant.barcode];
      if (stockBalance !== undefined && stockBalance > 0) {
        productInStock = true;
        break;
      }
    }

    const newStatus: "ACTIVE" | "DRAFT" = productInStock ? "ACTIVE" : "DRAFT";
    if (newStatus !== product.status) {
      updates.push({ productId: product.id, status: newStatus });
      if (product.status === "ACTIVE" && newStatus === "DRAFT") {
        proposedDraftFlips += 1;
        if (flippedToDraftSamples.length < 25) flippedToDraftSamples.push(product);
      }
    }
  });

  if (currentlyActive > 0 && proposedDraftFlips / currentlyActive > DRAFT_FLIP_THRESHOLD) {
    const pct = proposedDraftFlips / currentlyActive;
    const sample = flippedToDraftSamples.map((p) => ({
      handle: p.handle,
      barcode: p.variants[0]?.barcode ?? "",
    }));
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

  if (updates.length === 0) return { kind: "completed", result: { proposed: 0, applied: 0 } };

  const op = await runStatusUpdateBulkMutation(updates);
  return { kind: "waiting_bulk", op, proposed: updates.length };
}

export async function handleBulkOperationFinished({
  opId,
  status,
  errorCode,
}: {
  opId: string;
  status: string;
  errorCode: string | null;
}): Promise<SyncRun | null> {
  const runId = await getRunIdForOperation(opId);
  if (!runId) {
    console.warn(JSON.stringify({ event: "bulk_webhook_unknown_operation", opId, status }));
    return null;
  }

  return await withSyncLock(async (fencingToken) => {
    const run = await getSyncRun(runId);
    if (!run) return null;
    if (run.activeBulkOperationId !== opId) return run;
    if (run.status !== "waiting_bulk") return run;

    const mode = run.currentMode;
    if (!mode) return run;

    const normalizedStatus = status.toUpperCase();

    if (normalizedStatus === "COMPLETED") {
      const proposed = run.proposedByMode[mode] ?? 0;
      recordModeResult(run, mode, { proposed, applied: proposed });
      advanceRun(run);
      await saveSyncRun(run, fencingToken);
      if (run.currentMode) {
        kickOffSyncRun(run.runId);
      }
      return run;
    }

    if (normalizedStatus === "FAILED" || normalizedStatus === "CANCELED" || normalizedStatus === "EXPIRED") {
      const reason = `Bulk op ${opId} (${mode}) ended with ${normalizedStatus}, code=${errorCode ?? "null"}`;
      run.status = "failed";
      run.failureReason = reason;
      await saveSyncRun(run, fencingToken);
      await sendSyncFailureAlert({ runId: run.runId, mode, reason });
      return run;
    }

    return run;
  });
}

export async function reconcileSyncRuns(): Promise<{ checked: number; changed: number }> {
  const runs = await listOpenRuns();
  let changed = 0;
  for (const run of runs) {
    if (run.status === "queued" || run.status === "running") {
      const continued = await continueSyncRun(run.runId);
      if (continued?.version !== run.version) changed += 1;
      continue;
    }

    if (run.status !== "waiting_bulk" || !run.activeBulkOperationId) continue;

    const op = await getBulkOperationById(run.activeBulkOperationId);
    if (!op) continue;

    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status.toUpperCase())) {
      await handleBulkOperationFinished({
        opId: run.activeBulkOperationId,
        status: op.status,
        errorCode: op.errorCode,
      });
      changed += 1;
      continue;
    }

    const updatedAt = new Date(run.updatedAt).getTime();
    const staleAfter = run.activeBulkOperationType === "QUERY" ? QUERY_STALE_MS : MUTATION_STALE_MS;
    if (Date.now() - updatedAt > staleAfter) {
      run.missedRecoveryCount += 1;
      await saveSyncRun(run);
      changed += 1;
      await sendBulkOpTimeoutAlert({
        mode: run.currentMode ?? "unknown",
        opId: run.activeBulkOperationId,
      });
      if (run.missedRecoveryCount >= 2) {
        await sendSyncFailureAlert({
          runId: run.runId,
          mode: run.currentMode ?? "unknown",
          reason: "Queue/workflow escalation required after two missed recovery windows >24h",
        });
      }
    }
  }
  return { checked: runs.length, changed };
}

// Legacy synchronous runner retained for local/manual debugging only. API routes must not call it.
export async function runSync({ modes }: { modes: SyncMode[] }): Promise<SyncResult> {
  const orderedModes = canonicalizeModes(modes);
  const results: SyncResult = {};
  for (const mode of orderedModes) {
    if (mode === "costs") {
      const outcome = await startCostsModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "costs");
        results.costs = { proposed: outcome.proposed, applied: outcome.proposed };
      } else results.costs = outcome.result;
    } else if (mode === "prices") {
      const outcome = await startPricesModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "prices");
        results.prices = { proposed: outcome.proposed, applied: outcome.proposed };
      } else results.prices = outcome.result;
    } else {
      const outcome = await startStockModeStep();
      if (outcome.kind === "waiting_bulk") {
        await pollBulkOperation(outcome.op.id, "stock");
        results.stock = { proposed: outcome.proposed, applied: outcome.proposed };
      } else results.stock = outcome.result;
    }
  }
  return results;
}

export function isSyncConfigError(error: unknown): boolean {
  return isMissingRedisConfig(error);
}
