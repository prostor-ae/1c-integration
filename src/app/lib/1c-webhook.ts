import {
  fetchShopifyProductsAndVariantsByIdentifiers,
  isPositiveShopifyPrice,
  updateProductStatus,
  type ShopifyProductInfo,
} from "@/app/lib/shopify-client";
import {
  sendMissingBarcodeAlert,
  type MissingBarcodeAlertArgs,
} from "@/app/lib/alerts";

type OneCAvailability = "Yes" | "No";
type ShopifyStatus = "ACTIVE" | "DRAFT";
type ShopifyStatusUpdate = { productId: string; status: ShopifyStatus };

export class OneCStatusSyncFencedError extends Error {
  constructor() {
    super("one_c_status_sync_fenced");
    this.name = "OneCStatusSyncFencedError";
  }
}

export type ProcessDeps = {
  fetchProductsByIdentifiers: (
    identifiers: string[],
    signal?: AbortSignal,
  ) => Promise<Map<string, ShopifyProductInfo>>;
  updateProductStatus: (
    productId: string,
    status: ShopifyStatus,
    signal?: AbortSignal,
  ) => Promise<{ id: string; status: ShopifyProductInfo["status"] }>;
  sendMissingBarcodeAlert?: (
    args: MissingBarcodeAlertArgs,
  ) => Promise<void>;
  beforeMutations?: () => Promise<void>;
  signal?: AbortSignal;
};

const DEFAULT_DEPS: ProcessDeps = {
  fetchProductsByIdentifiers: fetchShopifyProductsAndVariantsByIdentifiers,
  updateProductStatus,
  sendMissingBarcodeAlert,
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
  const protectedProductIds = new Set<string>();
  const productsWithPositivePricedAvailability = new Set<string>();

  products.forEach((product) => {
    statusByProduct.set(product.id, product.status);

    for (const variant of product.variants) {
      const identifiers = [variant.barcode, variant.sku].filter(
        (identifier): identifier is string =>
          typeof identifier === "string" && identifier !== "",
      );

      for (const identifier of identifiers) {
        if (!(identifier in items)) continue;

        knownBarcodes.add(identifier);
        if (product.excludeFrom1cStatusSync) {
          protectedProductIds.add(product.id);
          continue;
        }
        const desiredStatus = items[identifier] === "Yes" ? "ACTIVE" : "DRAFT";
        if (
          desiredStatus === "ACTIVE" &&
          isPositiveShopifyPrice(variant.price)
        ) {
          productsWithPositivePricedAvailability.add(product.id);
        }
        const previous = desiredByProduct.get(product.id);

        // Product-level status is ACTIVE if any payload-mentioned variant is Yes.
        if (previous !== "ACTIVE")
          desiredByProduct.set(product.id, desiredStatus);
      }
    }
  });

  const updates: ShopifyStatusUpdate[] = [];
  let unchanged = 0;

  desiredByProduct.forEach((desiredStatus, productId) => {
    const currentStatus = statusByProduct.get(productId);
    if (
      currentStatus === desiredStatus ||
      (currentStatus === "DRAFT" &&
        desiredStatus === "ACTIVE" &&
        !productsWithPositivePricedAvailability.has(productId))
    ) {
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
      protectedProductsSkipped: protectedProductIds.size,
    },
    unknownBarcodes,
  };
}

export async function processOneCWebhookItems(
  items: Record<string, OneCAvailability>,
  overrides: Partial<ProcessDeps> = {},
) {
  const deps: ProcessDeps = { ...DEFAULT_DEPS, ...overrides };
  deps.signal?.throwIfAborted();
  const products = await deps.fetchProductsByIdentifiers(
    Object.keys(items),
    deps.signal,
  );
  const result = buildStatusUpdatesFromWebhookItems(products, items);
  const updatedProducts = [];

  // The route uses this boundary to re-read durable launch fencing after all
  // Shopify reads and immediately before the first status mutation.
  await deps.beforeMutations?.();

  for (const update of result.updates) {
    deps.signal?.throwIfAborted();
    const updatedProduct = await deps.updateProductStatus(
      update.productId,
      update.status,
      deps.signal,
    );
    updatedProducts.push(updatedProduct);
  }

  const response = {
    ...result.counts,
    applied: updatedProducts.length,
    updatedProducts,
    unknownBarcodes: result.unknownBarcodes,
  };

  if (response.unknownBarcodes.length > 0 && deps.sendMissingBarcodeAlert) {
    try {
      await deps.sendMissingBarcodeAlert({
        received: response.received,
        matched: response.matched,
        unknown: response.unknown,
        unchanged: response.unchanged,
        proposed: response.proposed,
        applied: response.applied,
        unknownBarcodes: response.unknownBarcodes,
      });
    } catch (error: any) {
      console.error(
        JSON.stringify({
          event: "missing_barcode_alert_failed",
          error: error?.message ?? String(error),
        }),
      );
    }
  }

  return response;
}
