import { NextResponse } from "next/server";
import axios from "axios";
import crypto from "crypto";

const API_VERSION = process.env.API_VERSION || "2025-07";
const FLOW_SECRET = process.env.FLOW_SECRET as string;
const ORDER_SIGNING_SECRET =
  (process.env.ORDER_SIGNING_SECRET as string) ||
  (process.env.SHOPIFY_API_SECRET as string);

function createApi(isTest: boolean) {
  const domain = (
    isTest
      ? process.env.SHOPIFY_STORE_DOMAIN_TEST
      : process.env.SHOPIFY_STORE_DOMAIN
  ) as string | undefined;
  const token = (
    isTest
      ? process.env.SHOPIFY_ADMIN_TOKEN_TEST
      : process.env.SHOPIFY_ADMIN_TOKEN
  ) as string | undefined;
  if (!domain || !token) {
    throw new Error(
      `Missing Shopify ${isTest ? "TEST " : ""}envs: SHOPIFY_STORE_DOMAIN${
        isTest ? "_TEST" : ""
      } or SHOPIFY_ADMIN_TOKEN${isTest ? "_TEST" : ""}`
    );
  }
  return axios.create({
    baseURL: `https://${domain}/admin/api/${API_VERSION}`,
    headers: { "X-Shopify-Access-Token": token },
  });
}

function toGid(orderId: string) {
  return orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId.replace(/[^0-9]/g, "")}`;
}

function signPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return crypto
    .createHmac("sha256", ORDER_SIGNING_SECRET)
    .update(json)
    .digest("base64url");
}

function ok() {
  return new NextResponse("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

function fail(_message?: string) {
  return new NextResponse("fail", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: Request) {
  try {
    if (!FLOW_SECRET || req.headers.get("x-flow-secret") !== FLOW_SECRET) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { orderId, isTest } = (await req.json()) as {
      orderId: string;
      isTest?: boolean;
    };
    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const api = createApi(Boolean(isTest));
    const gid = toGid(orderId);

    const QUERY = `#graphql
      query getOrderSig($id: ID!) {
        order(id: $id) {
          id
          metafields(first: 10, namespace: "app.audit") {
            edges { node { key type value } }
          }
        }
      }
    `;

    const { data } = await api.post("/graphql.json", {
      query: QUERY,
      variables: { id: gid },
    });

    const gqlErrors = data?.errors || data?.data?.userErrors;
    if (gqlErrors?.length) {
      return NextResponse.json(
        { error: gqlErrors[0]?.message || "GraphQL error" },
        { status: 400 }
      );
    }

    const order = data?.data?.order;
    if (!order)
      return NextResponse.json({ error: "Order not found" }, { status: 404 });

    const metaEdges: any[] = order.metafields?.edges || [];
    const sigField = metaEdges.find(
      (e) => e?.node?.key === "hold_signature_v1"
    );
    if (!sigField) {
      return NextResponse.json(
        { ok: false, reason: "missing_signature" },
        { status: 200 }
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(sigField.node.value || "{}");
    } catch {
      return NextResponse.json(
        { ok: false, reason: "invalid_json" },
        { status: 200 }
      );
    }

    const { sig, issuedAt, action } = parsed || {};
    if (!sig)
      return NextResponse.json(
        { ok: false, reason: "missing_sig" },
        { status: 200 }
      );

    // TTL: 30 minutes by default
    const ttlMs = Number(process.env.SIGNATURE_TTL_MS || 30 * 60 * 1000);
    if (!issuedAt || Date.now() - Date.parse(issuedAt) > ttlMs) {
      return NextResponse.json(
        { ok: false, reason: "expired" },
        { status: 200 }
      );
    }

    // Verify signature over the payload without 'sig'
    const toVerify = { ...parsed };
    delete (toVerify as any).sig;
    const expected = signPayload(toVerify);
    const valid = crypto.timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expected)
    );

    return valid ? ok() : fail();
  } catch (e: any) {
    if (axios.isAxiosError(e)) {
      return NextResponse.json(
        { error: "Shopify API error", details: e.response?.data || e.message },
        { status: e.response?.status || 500 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "unexpected" },
      { status: 500 }
    );
  }
}
