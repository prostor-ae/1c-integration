import { Resend } from "resend";

type SendAlertArgs = {
  subject: string;
  body: string;
};

function getResendConfig(): {
  apiKey: string;
  from: string;
  recipients: string[];
} {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM;
  const recipientsRaw = process.env.ALERT_RECIPIENTS;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY env var is not set");
  }
  if (!from) {
    throw new Error("ALERT_FROM env var is not set");
  }
  if (!recipientsRaw) {
    throw new Error("ALERT_RECIPIENTS env var is not set");
  }

  const recipients = recipientsRaw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  if (recipients.length === 0) {
    throw new Error("ALERT_RECIPIENTS env var contains no recipients");
  }

  return { apiKey, from, recipients };
}

export async function sendAlert({ subject, body }: SendAlertArgs): Promise<void> {
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
        error: error?.message ?? String(error),
      })
    );
  }
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
    `The 1C endpoint for ${source} returned an empty Items map. The ${mode} mode was skipped.`,
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
    `The API endpoints are quick-ack; absence of this failure email is the normal success signal.`,
  ].join("\n");

  await sendAlert({ subject, body });
}
