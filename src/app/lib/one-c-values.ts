export function toFiniteOneCNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function isSyncableOneCPrice(value: unknown): boolean {
  const numeric = toFiniteOneCNumber(value);
  return numeric !== null && numeric > 0;
}

export function isSyncableOneCDiscount(
  discount: unknown,
  basePrice: unknown,
): boolean {
  const discountNumber = toFiniteOneCNumber(discount);
  const basePriceNumber = toFiniteOneCNumber(basePrice);

  return (
    discountNumber !== null &&
    basePriceNumber !== null &&
    discountNumber > 0 &&
    basePriceNumber > 0 &&
    discountNumber < basePriceNumber
  );
}
