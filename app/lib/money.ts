import type { Money } from "~/types/domain";

/** Format integer minor units for display, e.g. 4900 EUR -> "€49.00". */
export function formatMoney(money: Money, locale = "en"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currencyCode,
  }).format(money.amountCents / 100);
}

export function toCents(decimalAmount: string | number): number {
  const n =
    typeof decimalAmount === "string"
      ? Number.parseFloat(decimalAmount)
      : decimalAmount;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function percentOff(baseCents: number, percent: number): number {
  return Math.round(baseCents * (1 - percent / 100));
}
