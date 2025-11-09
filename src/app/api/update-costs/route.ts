import { NextResponse } from "next/server";
import { get1cCosts } from "@/app/lib/1c-client";
import {
  fetchAllShopifyVariants,
  runCostUpdateBulkMutation,
} from "@/app/lib/shopify-client";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  try {
    const [costs1c, variantsShopify] = await Promise.all([
      get1cCosts(),
      fetchAllShopifyVariants(),
    ]);

    const updates: { inventoryItemId: string; cost: number }[] = [];
    const notFoundBarcodes: string[] = [];

    costs1c.forEach((cost, barcode) => {
      const variant = variantsShopify.get(barcode);
      if (variant) {
        if (variant.cost !== cost.toString()) {
          updates.push({
            inventoryItemId: variant.inventoryItemId,
            cost: cost,
          });
        }
      } else {
        notFoundBarcodes.push(barcode);
      }
    });

    console.log(`Found ${updates.length} products to update.`);
    if (notFoundBarcodes.length > 0) {
      console.warn(
        `Barcodes not found in Shopify: ${notFoundBarcodes.join(", ")}`
      );
    }

    if (updates.length > 0) {
      const bulkOperation = await runCostUpdateBulkMutation(updates);
      return NextResponse.json({
        message: "Cost update process started.",
        operation: bulkOperation,
        updatesCount: updates.length,
        notFoundBarcodes: notFoundBarcodes,
      });
    } else {
      return NextResponse.json({
        message: "No cost updates required.",
        updatesCount: 0,
        notFoundBarcodes: notFoundBarcodes,
      });
    }
  } catch (error: any) {
    console.error("Failed to update costs:", error);
    return NextResponse.json(
      { message: "Failed to update costs", error: error.message },
      { status: 500 }
    );
  }
}
