import { NextResponse } from "next/server";
import { get1cProductData } from "@/app/lib/1c-client";
import {
  fetchAllShopifyProductsAndVariants,
  runPriceUpdateBulkMutation,
  runStatusUpdateBulkMutation,
} from "@/app/lib/shopify-client";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  const isCron = request.headers.get("x-vercel-cron");

  if (
    process.env.VERCEL_ENV === "production" &&
    !isCron &&
    apiKey !== process.env.INTERNAL_API_KEY
  ) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("Starting daily sync cron job...");

    const [oneCData, shopifyProducts] = await Promise.all([
      get1cProductData(),
      fetchAllShopifyProductsAndVariants(),
    ]);

    const priceUpdates: Parameters<typeof runPriceUpdateBulkMutation>[0] = [];
    const statusUpdates: Parameters<typeof runStatusUpdateBulkMutation>[0] = [];
    const barcodeToVariantMap = new Map<string, { variantId: string }>();

    shopifyProducts.forEach((product) => {
      let productInStock = false;
      product.variants.forEach((variant) => {
        if (!variant.barcode) return;
        barcodeToVariantMap.set(variant.barcode, { variantId: variant.id });

        const data1c = oneCData.get(variant.barcode);
        if (data1c && data1c.stock > 0) {
          productInStock = true;
        }

        if (data1c && data1c.price) {
          const newPrice = (data1c.discountPrice || data1c.price).toString();
          const newCompareAtPrice = data1c.discountPrice
            ? data1c.price.toString()
            : null;

          if (
            newPrice !== variant.price ||
            newCompareAtPrice !== variant.compareAtPrice
          ) {
            priceUpdates.push({
              variantId: variant.id,
              price: newPrice,
              compareAtPrice: newCompareAtPrice,
            });
          }
        }
      });

      const newStatus = productInStock ? "ACTIVE" : "DRAFT";
      if (newStatus !== product.status) {
        statusUpdates.push({ productId: product.id, status: newStatus });
      }
    });

    console.log(`Found ${priceUpdates.length} price updates to perform.`);
    console.log(`Found ${statusUpdates.length} status updates to perform.`);

    const operations = [];
    if (priceUpdates.length > 0) {
      operations.push(runPriceUpdateBulkMutation(priceUpdates));
    }
    if (statusUpdates.length > 0) {
      operations.push(runStatusUpdateBulkMutation(statusUpdates));
    }

    const results = await Promise.all(operations);

    console.log("Daily sync cron job finished successfully.");
    return NextResponse.json({
      message: "Daily sync completed successfully.",
      updates: {
        prices: priceUpdates.length,
        statuses: statusUpdates.length,
      },
      operations: results,
    });
  } catch (error: any) {
    console.error("Failed to run daily sync:", error);
    return NextResponse.json(
      { message: "Failed to run daily sync", error: error.message },
      { status: 500 }
    );
  }
}
