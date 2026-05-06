import { NextResponse } from "next/server";
import {
  parseOneCWebhookItems,
  processOneCWebhookItems,
} from "@/app/lib/1c-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
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

    let body: unknown;
    try {
      body = await req.json();
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

    const result = await processOneCWebhookItems(items);
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
