export const SHOPIFY_WEIGHT_METAFIELD = {
  namespace: "custom",
  key: "weight",
} as const;

export type ShopifyWeightMetafieldValue = {
  value?: string | number | null;
} | null | undefined;

export function parseShopifyWeightKg(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const numeric =
    typeof value === "number" ? value : Number(String(value).trim());

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function parseShopifyWeightMetafieldKg(
  metafield: ShopifyWeightMetafieldValue,
): number | null {
  return parseShopifyWeightKg(metafield?.value);
}

export function applyShopifyWeight(
  valuePerKg: number,
  weightKg: number | null | undefined,
): number {
  return valuePerKg * (weightKg ?? 1);
}
