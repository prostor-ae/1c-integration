import { NextResponse } from "next/server";
import {
  OneCStatusSyncFencedError,
  parseOneCWebhookItems,
  processOneCWebhookItems,
  type ProcessDeps,
} from "@/app/lib/1c-webhook";
import {
  oneCWebhookRouteDeps,
} from "@/app/lib/1c-webhook-route-deps";
import { isAbortError } from "@/app/lib/shopify-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function retryableFence(error = "ambiguous_bulk_quarantine") {
  return NextResponse.json(
    { ok: false, error },
    { status: 503, headers: { "Retry-After": "60" } },
  );
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    const webhookKey = process.env.ONE_C_WEBHOOK_KEY;
    if (!webhookKey) {
      console.error(JSON.stringify({ event: "1c_webhook_config_missing" }));
      return jsonError("one_c_webhook_key_not_configured", 500);
    }

    if (req.headers.get("x-api-key") !== webhookKey) {
      console.warn(JSON.stringify({ event: "1c_webhook_unauthorized" }));
      return jsonError("unauthorized", 401);
    }

    const rawBody = await req.text();
    console.log(
      JSON.stringify({
        event: "1c_webhook_request_body",
        bodyLength: rawBody.length,
      }),
    );

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.warn(JSON.stringify({ event: "1c_webhook_invalid_json" }));
      return jsonError("invalid_json", 400);
    }

    let items: ReturnType<typeof parseOneCWebhookItems>;
    try {
      items = parseOneCWebhookItems(body);
    } catch (error: any) {
      console.warn(
        JSON.stringify({
          event: "1c_webhook_invalid_payload",
          error: error?.message ?? String(error),
        }),
      );
      return jsonError(error?.message ?? "invalid_payload", 400);
    }

    const deps = oneCWebhookRouteDeps();
    const fencingToken = await deps.acquireLock();
    if (!fencingToken) return retryableFence("sync_lock_busy");
    let result: Awaited<ReturnType<typeof processOneCWebhookItems>>;
    try {
      const mutationSignal = deps.createMutationSignal();
      const assertMutationAllowed: NonNullable<ProcessDeps["beforeMutations"]> =
        async () => {
          if (await deps.getAdmissionBlocker()) {
            throw new OneCStatusSyncFencedError();
          }
        };
      // Check once under the lock before Shopify reads, then again at the exact
      // mutation boundary to make injected/interleaved fence races fail closed.
      await assertMutationAllowed();
      result = await deps.processItems(items, {
        beforeMutations: assertMutationAllowed,
        signal: mutationSignal,
      });
    } catch (error) {
      if (error instanceof OneCStatusSyncFencedError) {
        console.warn(JSON.stringify({ event: "1c_webhook_bulk_quarantine_fenced" }));
        return retryableFence();
      }
      if (isAbortError(error)) {
        console.warn(JSON.stringify({ event: "1c_webhook_mutation_deadline_exceeded" }));
        return retryableFence("status_mutation_deadline_exceeded");
      }
      throw error;
    } finally {
      await deps.releaseLock(fencingToken);
    }
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        event: "1c_webhook_processed",
        durationMs,
        received: result.received,
        matched: result.matched,
        unknown: result.unknown,
        unchanged: result.unchanged,
        proposed: result.proposed,
        applied: result.applied,
        protectedProductsSkipped: result.protectedProductsSkipped,
      }),
    );

    return NextResponse.json(
      {
        ok: true,
        ...result,
        unknownBarcodes: result.unknownBarcodes.slice(0, 25),
      },
      { status: 200 },
    );
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    console.error(
      JSON.stringify({
        event: "1c_webhook_failed",
        durationMs,
        error: error?.message ?? String(error),
      }),
    );
    return NextResponse.json(
      { ok: false, error: error?.message || "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
