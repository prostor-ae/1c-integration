import {
  fetchAllShopifyProductsAndVariants,
  updateProductStatus,
  type ShopifyProductInfo,
} from "@/app/lib/shopify-client";

type OneCAvailability = "Yes" | "No";
type ShopifyStatus = "ACTIVE" | "DRAFT";
type ShopifyStatusUpdate = { productId: string; status: ShopifyStatus };

type ProcessDeps = {
  fetchProducts: () => Promise<Map<string, ShopifyProductInfo>>;
  updateProductStatus: (
    productId: string,
    status: ShopifyStatus,
  ) => Promise<{ id: string; status: ShopifyProductInfo["status"] }>;
};

const DEFAULT_DEPS: ProcessDeps = {
  fetchProducts: fetchAllShopifyProductsAndVariants,
  updateProductStatus,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOneCWebhookItems(
  body: unknown,
): Record<string, OneCAvailability> {
  if (!isPlainRecord(body) || !isPlainRecord(body.Items)) {
    throw new Error("items_must_be_non_empty_object");
  }

  const items: Record<string, OneCAvailability> = {};
  const entries = Object.entries(body.Items);
  if (entries.length === 0) {
    throw new Error("items_must_be_non_empty_object");
  }

  for (const [barcode, value] of entries) {
    if (barcode.trim() === "") {
      throw new Error("barcode_must_be_non_empty");
    }
    if (value !== "Yes" && value !== "No") {
      throw new Error("item_values_must_be_yes_or_no");
    }
    items[barcode] = value;
  }

  return items;
}

export function buildStatusUpdatesFromWebhookItems(
  products: Map<string, ShopifyProductInfo>,
  items: Record<string, OneCAvailability>,
) {
  const desiredByProduct = new Map<string, ShopifyStatus>();
  const statusByProduct = new Map<string, ShopifyProductInfo["status"]>();
  const knownBarcodes = new Set<string>();

  products.forEach((product) => {
    statusByProduct.set(product.id, product.status);

    for (const variant of product.variants) {
      if (!variant.barcode || !(variant.barcode in items)) continue;

      knownBarcodes.add(variant.barcode);
      const desiredStatus =
        items[variant.barcode] === "Yes" ? "ACTIVE" : "DRAFT";
      const previous = desiredByProduct.get(product.id);

      // Product-level status is ACTIVE if any payload-mentioned variant is Yes.
      if (previous !== "ACTIVE")
        desiredByProduct.set(product.id, desiredStatus);
    }
  });

  const updates: ShopifyStatusUpdate[] = [];
  let unchanged = 0;

  desiredByProduct.forEach((desiredStatus, productId) => {
    if (statusByProduct.get(productId) === desiredStatus) {
      unchanged += 1;
      return;
    }
    updates.push({ productId, status: desiredStatus });
  });

  const unknownBarcodes = Object.keys(items).filter(
    (barcode) => !knownBarcodes.has(barcode),
  );

  return {
    updates,
    counts: {
      received: Object.keys(items).length,
      matched: knownBarcodes.size,
      unknown: unknownBarcodes.length,
      unchanged,
      proposed: updates.length,
    },
    unknownBarcodes,
  };
}

export async function processOneCWebhookItems(
  items: Record<string, OneCAvailability>,
  deps: ProcessDeps = DEFAULT_DEPS,
) {
  const products = await deps.fetchProducts();
  const result = buildStatusUpdatesFromWebhookItems(products, items);
  const updatedProducts = [];

  for (const update of result.updates) {
    const updatedProduct = await deps.updateProductStatus(
      update.productId,
      update.status,
    );
    updatedProducts.push(updatedProduct);
  }

  return {
    ...result.counts,
    applied: updatedProducts.length,
    updatedProducts,
    unknownBarcodes: result.unknownBarcodes,
  };
}
