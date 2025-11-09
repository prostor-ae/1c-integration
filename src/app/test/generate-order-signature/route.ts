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
      query getOrderForSignature($id: ID!) {
        order(id: $id) {
          id
          tags
          fulfillmentOrders(first: 10) {
            edges { node { id status } }
          }
          metafields(first: 20, namespace: "app.audit") {
            edges { node { id key namespace type value } }
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
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const hasOnHold = Boolean(
      order.fulfillmentOrders?.edges?.some(
        (e: any) => e?.node?.status === "ON_HOLD"
      )
    );
    if (!hasOnHold) {
      return NextResponse.json(
        { error: "Order is not on hold" },
        { status: 409 }
      );
    }

    // Ensure action appears to be from our app: rely on our hidden context metafield or our tag
    const metaEdges: any[] = order.metafields?.edges || [];
    const ctxField = metaEdges.find((e) => e?.node?.key === "hold_context_v1");
    const tagList: string[] = order.tags || [];
    const hasAppTag =
      tagList.includes("viewed_audit") ||
      tagList.some((t) => t.startsWith("viewed_by_"));

    if (!ctxField && !hasAppTag) {
      return NextResponse.json(
        { error: "Hold does not appear to be initiated by this app" },
        { status: 412 }
      );
    }

    let staffId: string | null = null;
    let staffName: string | null = null;

    if (ctxField) {
      try {
        const ctx = JSON.parse(ctxField.node.value || "{}");
        staffId = ctx.staffId || null;
        staffName = ctx.staffName || null;
      } catch {}
    }

    if (!staffName) {
      // Fallback: get from tag viewed_by_ (best-effort)
      const by = tagList.find((t) => t.startsWith("viewed_by_"));
      if (by) staffName = by.replace(/^viewed_by_/, "").replace(/_/g, " ");
    }

    if (!staffId && !staffName) {
      return NextResponse.json(
        {
          error:
            "Missing staff identity. Ensure client stores hold_context_v1 with staffId/staffName.",
        },
        { status: 422 }
      );
    }

    const issuedAt = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const action = "hold";

    const payload = {
      version: 1,
      orderId: order.id as string,
      staffId,
      staffName,
      action,
      issuedAt,
      nonce,
    };
    const sig = signPayload(payload);

    const SET = `#graphql
      mutation metafieldsSet($ownerId: ID!, $value: String!) {
        metafieldsSet(metafields: [{
          ownerId: $ownerId,
          namespace: "app.audit",
          key: "hold_signature_v1",
          type: "json",
          value: $value
        }]) {
          userErrors { field message }
        }
      }
    `;

    const value = JSON.stringify({ ...payload, sig });
    const setRes = await api.post("/graphql.json", {
      query: SET,
      variables: { ownerId: order.id, value },
    });

    const setErrs = setRes?.data?.data?.metafieldsSet?.userErrors;
    if (setErrs?.length) {
      return NextResponse.json(
        { error: setErrs[0]?.message || "Failed to set metafield" },
        { status: 400 }
      );
    }

    // Return short signature for tagging if desired
    return NextResponse.json(
      { ok: true, shortSig: sig.slice(0, 10) },
      { status: 200 }
    );
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
