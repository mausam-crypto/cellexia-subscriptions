/**
 * Money helpers. All amounts are integer cents + ISO currency code.
 * Conversions to/from Shopify's decimal strings happen only at the API boundary.
 */

export function centsFromDecimalString(amount: string | number): number {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  return Math.round(n * 100);
}

export function decimalStringFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(
  cents: number,
  currencyCode: string,
  locale = "en",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
  }).format(cents / 100);
}

/** Apply a percentage discount with banker's-safe rounding (round half away from zero). */
export function applyDiscountPct(cents: number, pct: number): number {
  return Math.round((cents * (100 - pct)) / 100);
}

export function discountAmount(cents: number, pct: number): number {
  return cents - applyDiscountPct(cents, pct);
}
