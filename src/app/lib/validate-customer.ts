// lib/validate-customer.ts
import { ApiError } from "next/dist/server/api-utils";
import { NextRequest, NextResponse } from "next/server";

/**
 * Thrown to short-circuit with an HTTP error code and message.
 */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Validates the incoming request’s Authorization header as a Customer Account API token,
 * then looks up and returns the customer’s GID.
 *
 * @throws HttpError with status 401 for missing/invalid tokens,
 *        502 for network issues, or 400 for other GraphQL/userErrors.
 */
export async function validateCustomer(
  req: NextRequest
): Promise<{ id: string; customer: any }> {
  // 1️⃣ Check for Authorization header
  const token = req.headers.get("authorization") || "";

  // 2️⃣ Call the Customer Account API endpoint
  const url = `https://shopify.com/87638835447/account/customer/api/2025-04/graphql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({
      query: `
        query {
          customer {
            id
            emailAddress {
                emailAddress
            }
          }
        }
      `,
    }),
  });

  // 3️⃣ Handle transport-level errors
  //   if (!resp.ok) {
  //     // e.g. network down, DNS failure, 5xx from Shopify
  //     throw new ApiError(resp.status, `Upstream error: ${resp.status}`);
  //   }

  // 4️⃣ Parse JSON and handle GraphQL-level errors
  const { data, errors } = await resp.json();
  if (errors && errors.length) {
    // check for authentication/permission failures
    const code = errors[0].extensions?.code;
    if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") {
      throw new ApiError(401, "Invalid or expired customer access token");
    }
    // other GraphQL userErrors
    throw new ApiError(400, errors.map((e: any) => e.message).join("; "));
  }

  // 5️⃣ Ensure we got an actual ID back
  const id = data?.customer?.id;
  if (!id) {
    throw new ApiError(401, "Invalid or expired customer access token");
  }

  return { id, customer: data.customer };
}
