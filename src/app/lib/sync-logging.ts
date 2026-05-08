import { getShopifyLogContext } from "./shopify-env";
import type { SyncRun } from "./sync-state";

type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

function removeUndefined(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function summarizeSyncRun(run: SyncRun): LogFields {
  return {
    runId: run.runId,
    source: run.source,
    storeId: run.storeId,
    status: run.status,
    modes: run.requestedModes,
    currentMode: run.currentMode,
    currentIndex: run.currentIndex,
    activeBulkOperationId: run.activeBulkOperationId,
    activeBulkOperationType: run.activeBulkOperationType,
    proposedByMode: run.proposedByMode,
    appliedByMode: run.appliedByMode,
    skippedByMode: run.skippedByMode,
    attempts: run.attempts,
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    missedRecoveryCount: run.missedRecoveryCount,
  };
}

export function logSyncEvent(
  event: string,
  fields: LogFields = {},
  level: LogLevel = "info",
): void {
  const payload = removeUndefined({
    event,
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    vercelRegion: process.env.VERCEL_REGION,
    vercelDeploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    ...getShopifyLogContext(),
    ...fields,
  });

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
