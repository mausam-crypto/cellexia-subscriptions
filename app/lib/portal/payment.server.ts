import { t } from "~/lib/i18n/i18n.server";
import { cardExpiryMoment } from "~/lib/dates.server";
import { applyDiscountPct } from "~/lib/money";

/**
 * Instrument-aware label for a contract's mirrored payment method (v1.28.0):
 * Shop Pay → "Shop Pay ····1234", PayPal → "PayPal", card → "{brand} ending
 * in {last4}". Falls back to the legacy `portal.payment.card_summary` key when
 * the instrument type is not mirrored yet (pre-0027 rows) — a PayPal contract
 * used to render "PayPal ending in ····".
 */
export function paymentMethodLabel(
  locale: string,
  contract: {
    paymentInstrumentType?: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
  },
): string {
  const type = contract.paymentInstrumentType ?? null;
  const last4 = contract.cardLast4 ?? "····";
  if (type === "SHOP_PAY") {
    return t(locale, "portal.payment.shop_pay_summary", { last4 });
  }
  if (type === "PAYPAL") {
    return t(locale, "portal.payment.paypal_summary");
  }
  return t(locale, "portal.payment.card_summary", {
    brand: displayCardBrand(contract.cardBrand) ?? t(locale, "portal.payment.card_generic"),
    last4,
  });
}

/**
 * Shopify mirrors card brands lower-case ("visa"); every portal surface
 * prints "Visa" — the same rule the emails apply (`emailCardLabel`), so the
 * home line, the hero and the payment section never disagree on the brand.
 * Mixed-case brands ("Shop Pay", "American Express") pass through untouched.
 */
export function displayCardBrand(brand: string | null | undefined): string | null {
  const clean = brand?.trim() ?? "";
  if (!clean) return null;
  if (clean === clean.toLowerCase()) {
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean;
}

// ── Payment section states (v1.28.0, P1.5) ──────────────────────────────────

/**
 * Customer-facing state of the contract's mirrored payment method. Derived
 * from mirrored fields only (no Shopify call), so it is exactly as fresh as
 * the mirror — which is what the engine itself charges against.
 *
 *  NONE     — nothing mirrored (no method id, no brand/last4)
 *  REVOKED  — paymentMethodRevokedAt set (Shopify removed the primary)
 *  EXPIRED  — expiry month/year already past (the card fails from the first
 *             instant of the month after its expiry month — same moment the
 *             pre-expiry job uses)
 *  EXPIRING — expires before the next order, or within
 *             settings.dunning.preExpiryNoticeDays of now
 *  OK       — anything else
 *
 * Precedence: NONE > REVOKED > EXPIRED > EXPIRING > OK.
 */
export type PortalPaymentState = "OK" | "EXPIRING" | "EXPIRED" | "REVOKED" | "NONE";

export interface PortalPaymentContract {
  paymentMethodId: string | null;
  backupPaymentMethodId?: string | null;
  paymentInstrumentType?: string | null;
  paymentMethodRevokedAt?: Date | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  nextBillingDate: Date | null;
  /**
   * Status + resumeAt make the "next order" date truthful: a PAUSED contract
   * keeps a stale (often past) nextBillingDate — its next charge is resumeAt
   * (the pre-expiry job's rule); an ACTIVE contract with an open dunning
   * case has no scheduled order (held). Optional: callers without them get
   * the plain nextBillingDate.
   */
  status?: string | null;
  resumeAt?: Date | null;
}

export interface PortalPaymentView {
  state: PortalPaymentState;
  /** "MM/YYYY" of the mirrored expiry, when mirrored. */
  expiryLabel: string | null;
  /** First instant after the expiry month (UTC) — the card is dead from here. */
  expiresAt: Date | null;
  /**
   * Engine currently charging the backup method (pointer equality, scoped
   * to an open case when the caller passes `hasOpenCase`).
   */
  onBackup: boolean;
  last4: string | null;
  /**
   * EXPIRING because the card is dead by the next order's date (vs. merely
   * inside the pre-expiry notice window, when the next order still charges
   * fine) — the note must not claim "before your next order" otherwise.
   */
  beforeNextOrder: boolean;
  /**
   * The next moment money moves — resumeAt when PAUSED, null while a dunning
   * case holds the order (`hasOpenCase`), else nextBillingDate. The date the
   * expiring / expired notes may name ("your next order on {date}"); null =
   * use the `_nodate` copy.
   */
  nextChargeDate: Date | null;
}

/**
 * The effective next-charge date (the intent-followup / payment_method_updated
 * rule): PAUSED → resumeAt; open dunning case → null (the order is held —
 * the banner owns that story); else nextBillingDate.
 */
export function effectiveNextChargeDate(
  contract: Pick<PortalPaymentContract, "nextBillingDate" | "status" | "resumeAt">,
  hasOpenCase?: boolean,
): Date | null {
  if (contract.status === "PAUSED") return contract.resumeAt ?? null;
  if (hasOpenCase === true) return null;
  return contract.nextBillingDate ?? null;
}

/**
 * First instant of the month after the card's expiry month — shop-tz local
 * midnight when `tz` is given (the clock nextBillingDate lives in), UTC
 * otherwise. See dates.server cardExpiryMoment.
 */
export function cardExpiresAt(
  month: number | null | undefined,
  year: number | null | undefined,
  tz?: string | null,
): Date | null {
  return cardExpiryMoment(month, year, tz);
}

export function derivePortalPaymentState(
  contract: PortalPaymentContract,
  opts: {
    now?: Date;
    preExpiryNoticeDays: number;
    tz?: string | null;
    /**
     * Whether the contract has an OPEN dunning case. The "on backup" pointer
     * marker (paymentMethodId === backupPaymentMethodId) only means "the
     * engine is charging the backup while the main card is fixed" while a
     * case is open — pass `false` when the caller knows there is none so a
     * stale marker (failed revert / legacy rows) never reads as on-backup.
     * Omit when unknown (pointer equality alone).
     */
    hasOpenCase?: boolean;
  },
): PortalPaymentView {
  const now = opts.now ?? new Date();
  const hasMirror = Boolean(
    contract.paymentMethodId || contract.cardBrand || contract.cardLast4,
  );
  const expiresAt = cardExpiresAt(
    contract.cardExpiryMonth,
    contract.cardExpiryYear,
    opts.tz,
  );
  const expiryLabel =
    contract.cardExpiryMonth != null && contract.cardExpiryYear != null
      ? `${String(contract.cardExpiryMonth).padStart(2, "0")}/${contract.cardExpiryYear}`
      : null;
  const onBackup =
    opts.hasOpenCase !== false &&
    contract.backupPaymentMethodId != null &&
    contract.paymentMethodId === contract.backupPaymentMethodId;

  const nextChargeDate = effectiveNextChargeDate(contract, opts.hasOpenCase);

  let state: PortalPaymentState = "OK";
  let beforeNextOrder = false;
  if (!hasMirror) {
    state = "NONE";
  } else if (contract.paymentMethodRevokedAt != null) {
    state = "REVOKED";
  } else if (expiresAt && now.getTime() >= expiresAt.getTime()) {
    state = "EXPIRED";
  } else if (expiresAt) {
    const noticeDays = Number.isFinite(opts.preExpiryNoticeDays)
      ? Math.max(0, opts.preExpiryNoticeDays)
      : 0;
    const noticeFrom = expiresAt.getTime() - noticeDays * 86_400_000;
    beforeNextOrder =
      nextChargeDate != null && nextChargeDate.getTime() >= expiresAt.getTime();
    if (beforeNextOrder || now.getTime() >= noticeFrom) state = "EXPIRING";
  }

  return {
    state,
    expiryLabel,
    expiresAt,
    onBackup,
    last4: contract.cardLast4 ?? null,
    beforeNextOrder,
    nextChargeDate,
  };
}

/**
 * Home-card chip for the payment method, or null when the status chip should
 * stay. A dunning "Payment issue" chip always wins (the failed charge is the
 * story; the card's expiry is a detail of it), so callers pass hasIssue.
 * Only ACTIVE contracts get one — a paused card keeps its "Paused" chip
 * (the resume line already carries the schedule), and a cancelled or
 * exhausted subscription's card state is not actionable from the list.
 */
export function paymentChipKey(
  state: PortalPaymentState,
  opts: { status: string; hasIssue: boolean },
): "portal.card.chip_expiring" | "portal.card.chip_expired" | "portal.card.chip_removed" | null {
  if (opts.hasIssue) return null;
  if (opts.status !== "ACTIVE") return null;
  if (state === "EXPIRED") return "portal.card.chip_expired";
  if (state === "EXPIRING") return "portal.card.chip_expiring";
  if (state === "REVOKED") return "portal.card.chip_removed";
  return null;
}

/**
 * The payment <details> opens by default whenever there is something to act
 * on: any non-OK method state, or a dunning banner on the page (its "Update
 * card" / "Use another card" CTAs anchor into this section).
 */
export function paymentDetailsOpen(
  state: PortalPaymentState,
  hasDunning: boolean,
): boolean {
  return hasDunning || state !== "OK";
}

/**
 * Compact instrument label for one-line contexts ("Visa ····4242",
 * "Shop Pay ····1234", "PayPal"). Null when nothing is mirrored — and null
 * when the mirrored method has been REVOKED (`paymentMethodRevokedAt` set):
 * the revoke webhook keeps brand/last4 for the payment section's "which card
 * was removed" story, but a next-charge line must never promise a charge to
 * a card that no longer exists (same rule as `estimateNextCharge.cardLabel`
 * and the reminder's `payment_line_missing`).
 */
export function paymentMethodShortLabel(
  locale: string,
  contract: {
    paymentInstrumentType?: string | null;
    paymentMethodRevokedAt?: Date | null;
    cardBrand: string | null;
    cardLast4: string | null;
  },
): string | null {
  if (contract.paymentMethodRevokedAt != null) return null;
  if (!contract.cardBrand && !contract.cardLast4) return null;
  const type = contract.paymentInstrumentType ?? null;
  const last4 = contract.cardLast4 ?? "····";
  if (type === "SHOP_PAY") {
    return t(locale, "portal.payment.shop_pay_summary", { last4 });
  }
  if (type === "PAYPAL") return t(locale, "portal.payment.paypal_summary");
  return t(locale, "portal.card.short", {
    brand: displayCardBrand(contract.cardBrand) ?? t(locale, "portal.payment.card_generic"),
    last4,
  });
}

/**
 * "{amount} on {date} · Visa ····4242" — the next-charge line shared by the
 * home card, the detail header and (via reminders) the upcoming-order email.
 * `amount` is whatever total the surface already shows (never a new
 * computation here); without one the line is "{date} · Visa ····4242".
 */
export function nextChargeLine(
  locale: string,
  parts: { amount: string | null; date: string; cardLabel: string | null },
): string {
  const lead = parts.amount
    ? t(locale, "portal.card.next_charge", { amount: parts.amount, date: parts.date })
    : parts.date;
  return parts.cardLabel ? `${lead} · ${parts.cardLabel}` : lead;
}

/**
 * The next-charge ESTIMATE the portal shows next to the date and card (P1.5),
 * computed exactly like the upcoming-order reminder's `total_estimate`
 * (app/lib/billing/reminders.server.ts): plan pricing of the non-gift lines,
 * minus any live per-cycle DiscountGrant percent, plus delivery. Taxes are
 * Shopify's at charge time, so it stays an estimate — but the same one in
 * every surface (v1.28.0 audit: home card, detail header and reminder must
 * never disagree on the figure framed as "what will be charged").
 */
export function nextChargeEstimateCents(
  contract: {
    deliveryPriceCents: number;
    lines: Array<{ currentPriceCents: number; quantity: number; isGift?: boolean }>;
  },
  grantPercent: number | null | undefined,
): number {
  let subtotal = contract.lines
    .filter((l) => !l.isGift)
    .reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0);
  if (grantPercent != null && grantPercent > 0) {
    subtotal = applyDiscountPct(subtotal, grantPercent);
  }
  return subtotal + contract.deliveryPriceCents;
}
