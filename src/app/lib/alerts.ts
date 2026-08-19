import { Resend } from "resend";
import type { SyncRun } from "./sync-state";

type SendAlertArgs = {
  subject: string;
  body: string;
};

export type MissingBarcodeAlertArgs = {
  received: number;
  matched: number;
  unknown: number;
  unchanged: number;
  proposed: number;
  applied: number;
  unknownBarcodes: string[];
};

export const ALERT_EMAIL_FROM = "notification@morlavi92.uk";
export const ALERT_EMAIL_RECIPIENT = "chepiga.lev@gmail.com";
export const ALERT_EMAIL_RECIPIENTS = [
  ALERT_EMAIL_RECIPIENT,
  "sergei.vasilev@alqithara.ae",
];
const MISSING_BARCODE_ALERT_SAMPLE_LIMIT = 25;

function getResendConfig(): {
  apiKey: string;
  from: string;
  recipients: string[];
} {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY env var is not set");
  }

  return {
    apiKey,
    from: ALERT_EMAIL_FROM,
    recipients: ALERT_EMAIL_RECIPIENTS,
  };
}

export async function sendAlert({
  subject,
  body,
}: SendAlertArgs): Promise<void> {
  try {
    const { apiKey, from, recipients } = getResendConfig();
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from,
      to: recipients,
      subject,
      text: body,
    });
  } catch (error: any) {
    console.error(
      JSON.stringify({
        event: "alert_send_failed",
        subject,
        error: error?.message ?? String(error),
      }),
    );
  }
}

export async function sendMissingBarcodeAlert({
  received,
  matched,
  unknown,
  unchanged,
  proposed,
  applied,
  unknownBarcodes,
}: MissingBarcodeAlertArgs): Promise<void> {
  const sample = unknownBarcodes.slice(0, MISSING_BARCODE_ALERT_SAMPLE_LIMIT);
  const hiddenCount = Math.max(unknownBarcodes.length - sample.length, 0);
  const sampleLines = sample.map((barcode) => `  - ${barcode}`).join("\n");

  const subject = `[1c-integration] 1C webhook unknown Shopify barcodes (${unknown})`;
  const body = [
    `A 1C webhook payload included barcodes that were not found in Shopify.`,
    ``,
    `The webhook processing stays best-effort: matched products were handled, unknown barcodes were skipped, and this email is informational.`,
    ``,
    `Received barcodes:  ${received}`,
    `Matched barcodes:   ${matched}`,
    `Unknown barcodes:   ${unknown}`,
    `Unchanged products: ${unchanged}`,
    `Proposed updates:   ${proposed}`,
    `Applied updates:    ${applied}`,
    ``,
    `Unknown barcode sample (up to ${MISSING_BARCODE_ALERT_SAMPLE_LIMIT}):`,
    sampleLines || "  (none captured)",
    hiddenCount > 0 ? `  ...and ${hiddenCount} more` : null,
    ``,
    `Action: add or correct these product variant barcodes in Shopify, then let the next 1C webhook retry update their statuses.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  await sendAlert({ subject, body });
}

export async function sendSafetyFloorAlert({
  totalActive,
  proposedFlips,
  percentage,
  sampleSkus,
}: {
  totalActive: number;
  proposedFlips: number;
  percentage: number;
  sampleSkus: Array<{ handle: string; barcode: string }>;
}): Promise<void> {
  const subject = `[1c-integration] Stock sync ABORTED: 20% DRAFT-flip floor exceeded`;
  const pctFormatted = (percentage * 100).toFixed(1);
  const sampleLines = sampleSkus
    .slice(0, 25)
    .map((s) => `  - ${s.handle} | barcode=${s.barcode}`)
    .join("\n");

  const body = [
    `The stock sync was skipped because too many products would flip from ACTIVE to DRAFT in a single run.`,
    ``,
    `Currently ACTIVE products: ${totalActive}`,
    `Proposed DRAFT flips:      ${proposedFlips}`,
    `Percentage:                ${pctFormatted}% (threshold: 20%)`,
    ``,
    `Sample of affected SKUs (up to 25):`,
    sampleLines || "  (none captured)",
    ``,
    `No status updates were applied. Investigate the 1C stock payload before re-triggering.`,
  ].join("\n");

  await sendAlert({ subject, body });
}

export async function sendBulkOpTimeoutAlert({
  mode,
  opId,
}: {
  mode: string;
  opId: string;
}): Promise<void> {
  const subject = `[1c-integration] Bulk op TIMEOUT (${mode})`;
  const body = [
    `A Shopify bulk operation did not reach a terminal status within the polling budget.`,
    ``,
    `Mode:           ${mode}`,
    `Bulk op id:     ${opId}`,
    ``,
    `The run was aborted. The bulk op may still be running on Shopify; the next run will detect it via assertNoActiveBulkOperation.`,
  ].join("\n");
  await sendAlert({ subject, body });
}

export async function sendBulkOpConflictAlert({
  mode,
  opId,
  status,
}: {
  mode: string;
  opId: string;
  status: string;
}): Promise<void> {
  const subject = `[1c-integration] Bulk op CONFLICT (${mode})`;
  const body = [
    `A prior Shopify bulk operation is still active. The ${mode} mode was skipped.`,
    ``,
    `Mode:        ${mode}`,
    `Op id:       ${opId}`,
    `Status:      ${status}`,
    ``,
    `Wait for the prior op to finish, or cancel it in Shopify Admin, then re-trigger.`,
  ].join("\n");
  await sendAlert({ subject, body });
}

export async function sendEmptyPayloadAlert({
  mode,
  source,
}: {
  mode: string;
  source: string;
}): Promise<void> {
  const subject = `[1c-integration] 1C payload empty (${mode}/${source})`;
  const body = [
    `The 1C endpoint for ${source} returned an empty or missing Items map. The ${mode} mode was skipped.`,
    ``,
    `Mode:    ${mode}`,
    `Source:  ${source}`,
    ``,
    `Investigate upstream 1C system before re-triggering.`,
  ].join("\n");
  await sendAlert({ subject, body });
}

export async function sendSyncFailureAlert({
  runId,
  mode,
  reason,
}: {
  runId: string;
  mode: string;
  reason: string;
}): Promise<void> {
  const subject = `[1c-integration] Sync failure (${mode})`;
  const body = [
    `A sync run failed or requires operator attention.`,
    ``,
    `Run id:  ${runId}`,
    `Mode:    ${mode}`,
    `Reason:  ${reason}`,
    ``,
    `The API endpoints are quick-ack; success and failure emails are sent after the async sync run reaches a final state.`,
  ].join("\n");

  await sendAlert({ subject, body });
}

function formatModeNumberRecord(
  record: Partial<Record<string, number>>,
  modes: string[],
): string {
  const keys = Array.from(new Set([...modes, ...Object.keys(record)])).filter(
    (mode) => record[mode] !== undefined,
  );
  if (keys.length === 0) return "  (none)";
  return keys.map((mode) => `  - ${mode}: ${record[mode]}`).join("\n");
}

function formatSkippedRecord(
  record: Partial<Record<string, string>>,
  modes: string[],
): string {
  const keys = Array.from(new Set([...modes, ...Object.keys(record)])).filter(
    (mode) => record[mode],
  );
  if (keys.length === 0) return "  (none)";
  return keys.map((mode) => `  - ${mode}: ${record[mode]}`).join("\n");
}

export function buildSyncSuccessAlert({
  run,
}: {
  run: SyncRun;
}): SendAlertArgs {
  const modes = run.requestedModes;
  const modeLabel = modes.join(", ") || "none";
  const hasWarnings = Object.keys(run.skippedByMode).length > 0;
  const subject = hasWarnings
    ? `[1c-integration] Sync completed with warnings (${modeLabel})`
    : `[1c-integration] Sync completed (${modeLabel})`;

  const body = [
    hasWarnings
      ? `A sync run completed, but one or more modes were skipped or need operator review.`
      : `A sync run completed successfully.`,
    ``,
    `Run id:      ${run.runId}`,
    `Source:      ${run.source}`,
    `Status:      ${run.status}`,
    `Modes:       ${modeLabel}`,
    `Created at:  ${run.createdAt}`,
    `Updated at:  ${run.updatedAt}`,
    `Completed:   ${run.completedAt ?? "(not recorded)"}`,
    ``,
    `Proposed updates by mode:`,
    formatModeNumberRecord(run.proposedByMode, modes),
    ``,
    `Applied updates by mode:`,
    formatModeNumberRecord(run.appliedByMode, modes),
    ``,
    `Skipped/warning reasons:`,
    formatSkippedRecord(run.skippedByMode, modes),
    run.failureReason ? `` : null,
    run.failureReason ? `Failure reason field: ${run.failureReason}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { subject, body };
}

export async function sendSyncSuccessAlert({
  run,
}: {
  run: SyncRun;
}): Promise<void> {
  await sendAlert(buildSyncSuccessAlert({ run }));
}
