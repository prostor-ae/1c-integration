import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    console.log(JSON.stringify({ event: "1c_webhook_received", hasBody: body !== null }));
    return NextResponse.json({ ok: true, delegated: false }, { status: 200 });
  } catch (error: any) {
    console.error(
      JSON.stringify({ event: "1c_webhook_failed", error: error?.message ?? String(error) })
    );
    return NextResponse.json(
      { error: error?.message || "An unexpected error occurred." },
      { status: 500 }
    );
  }
}
