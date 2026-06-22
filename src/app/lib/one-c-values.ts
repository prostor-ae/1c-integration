export function toFiniteOneCNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function isSyncableOneCPrice(value: unknown): boolean {
  const numeric = toFiniteOneCNumber(value);
  return numeric !== null && numeric > 0;
}

export function isSyncableOneCDiscount(
  compareAtPrice: unknown,
  finalPrice: unknown,
): boolean {
  const compareAtPriceNumber = toFiniteOneCNumber(compareAtPrice);
  const finalPriceNumber = toFiniteOneCNumber(finalPrice);

  return (
    compareAtPriceNumber !== null &&
    finalPriceNumber !== null &&
    compareAtPriceNumber > 0 &&
    finalPriceNumber > 0 &&
    compareAtPriceNumber > finalPriceNumber
  );
}

export const ONE_C_STOCK_ACTIVE_THRESHOLD = 0.1;

export function isActiveOneCStockAmount(value: unknown): boolean {
  const numeric = toFiniteOneCNumber(value);
  return numeric !== null && numeric > ONE_C_STOCK_ACTIVE_THRESHOLD;
}
