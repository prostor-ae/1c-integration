import { NextResponse } from "next/server";
import axios from "axios";
import { ApiError } from "next/dist/server/api-utils";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN as string;
const API_VERSION = process.env.API_VERSION || "2025-07";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new ApiError(
    400,
    "Missing one of SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN"
  );
}

const api = axios.create({
  baseURL: `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`,
  headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log(body);
    // Update handle
    // const MUT = `mutation($input: ProductInput!){
    //   productUpdate(input:$input){
    //     product { id handle }
    //     userErrors { field message }
    //   }
    // }`;

    // const upd = await api.post("/graphql.json", {
    //   query: MUT,
    //   variables: { input: { id, handle: desired } },
    // });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    if (axios.isAxiosError(e)) {
      // Log detailed Axios error information
      console.error("Axios error details:", {
        message: e.message,
        status: e.response?.status,
        data: e.response?.data,
      });

      // Pass a more structured error back to the client
      return NextResponse.json(
        {
          error: "Shopify API request failed.",
          details: e.response?.data || e.message,
        },
        { status: e.response?.status || 500 }
      );
    } else {
      console.error("generate-handle error:", e);
    }

    // Generic error for non-Axios issues
    return NextResponse.json(
      { error: e?.message || "An unexpected error occurred." },
      { status: 500 }
    );
  }
}
