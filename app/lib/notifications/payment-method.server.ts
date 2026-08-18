import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate } from "~/lib/dates.server";
import { buildPortalUrl } from "~/lib/magiclinks/builder.server";
import { sendNotification } from "./send.server";

/**
 * Payment-method copy helpers shared by every sender that talks about the
 * card behind a subscription (v1.28.0, portal churn pack — P1.4/P1.5):
 *
 *  - `emailCardLabel` — the compact instrument-aware label the emails and
 *    SMS use ("Visa ····4242", "Shop Pay ····4242", "PayPal"). The portal
 *    has its own longer form (app/lib/portal/payment.server.ts); this one is
 *    for a line inside a sentence.
 *  - `paymentMethodUpdatedVars` — the FULL variable set the
 *    `payment_method_updated` template body renders from (change_line /
 *    next_line / card_label / cta_url …). Every sender of that template MUST
 *    build its vars here: the English body references {change_line} and
 *    {next_line} unconditionally, and t() leaves an unknown placeholder
 *    visible.
 *  - `sendPaymentMethodUpdatedOnce` — the closed loop after a card change:
 *    builds the vars, dedupes ONCE per {contract, last4} per 24 h through the
 *    persistent NotificationLog pattern the dunning ladder uses
 *    (`payload.vars.dedupe_key` on the SENT row), then routes through
 *    sendNotification. Never throws — a failed notice must never break the
 *    webhook / service action that triggered it (golden rule 9).
 */

export interface CardLike {
  paymentInstrumentType?: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** "Visa ····4242" / "Shop Pay ····4242" / "PayPal" / "" when nothing is mirrored. */
export function emailCardLabel(
  locale: string | null | undefined,
  card: CardLike | null | undefined,
): string {
  if (!card) return "";
  const type = card.paymentInstrumentType ?? null;
  const last4 = card.cardLast4 ?? "";
  if (type === "PAYPAL") return t(locale, "email.card_label.paypal");
  if (type === "SHOP_PAY") {
    return t(locale, "email.card_label.shop_pay", { last4 });
  }
  if (!last4 && !card.cardBrand) return "";
  const brand = card.cardBrand ? capitalizeBrand(card.cardBrand) : "";
  return brand
    ? t(locale, "email.card_label.card", { brand, last4 })
    : t(locale, "email.card_label.card_generic", { last4 });
}

/** Shopify mirrors brands lower-case ("visa"); emails want "Visa". */
function capitalizeBrand(brand: string): string {
  const clean = brand.trim();
  if (!clean) return "";
  if (clean === clean.toLowerCase()) {
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean;
}

/** Why the customer is being told their payment method changed. */
export type PaymentMethodUpdatedReason =
  /** Direct change: the customer (or an admin) put a different / renewed card on the subscription. */
  | "updated"
  /** The primary was removed from the account and the backup took over (revoke webhook). */
  | "backup_promoted"
  /** The primary failed and the dunning engine switched renewals to the backup. */
  | "backup_failed"
  /**
   * The primary was removed / had expired and the payment-method webhook
   * moved the subscription to a NEW method the customer just saved (v1.28.0,
   * P1.8 — changePaymentMethod trigger `new_method`).
   */
  | "new_method";

export interface PaymentMethodUpdatedInput {
  locale: string | null | undefined;
  /** Shop IANA timezone (next_date formatting). */
  tz: string;
  /** The contract AS IT IS NOW — the card these vars describe. */
  contract: CardLike & {
    id: string;
    shopId: string;
    nextBillingDate?: Date | null;
    currencyCode?: string | null;
    paymentMethodId?: string | null;
    paymentMethodRevokedAt?: Date | null;
    /** Contract status — PAUSED / FAILED change what "next order" means. */
    status?: string | null;
  };
  reason: PaymentMethodUpdatedReason;
  /** The instrument that was replaced (backup variants name it). */
  previousCard?: CardLike | null;
  /** Klaviyo prop: who made the change. */
  cardUpdatedBy: "customer" | "merchant" | "system";
  /** Next charge amount in cents when known (renders next_line_amount). */
  amountCents?: number | null;
  /**
   * An open dunning case exists for the contract (the caller knows; when
   * omitted the helper looks it up, contained). With a case — or a FAILED
   * contract — the honest "next" is the retry of the held payment, not a
   * scheduled date (which then sits in the past).
   */
  hasOpenCase?: boolean;
  /** Test seam / caller clock for the past-date suppression. */
  now?: Date;
}

/**
 * The template's variable set. `card_brand` / `card_last4` / `via_backup`
 * are kept for merchant overrides and the pre-1.28.0 Klaviyo property
 * contract; the body itself renders `change_line`, `next_line` and `{cta}`.
 * `cta_url` is the portal detail page with `?toast=payment_method_changed`
 * — best-effort (a shop without a domain simply gets no button).
 */
export async function paymentMethodUpdatedVars(
  input: PaymentMethodUpdatedInput,
): Promise<Record<string, unknown>> {
  const { locale, contract } = input;
  const cardLabel = emailCardLabel(locale, contract);
  // The backup variants read "… because {previous_card_label} was removed";
  // an unmirrored previous card degrades to a generic phrase, never a hole.
  const previousLabel =
    emailCardLabel(locale, input.previousCard ?? null) ||
    t(locale, "email.card_label.previous_generic");
  const nextDate = contract.nextBillingDate
    ? formatShopDate(contract.nextBillingDate, input.tz, locale ?? undefined)
    : "";
  const amount =
    input.amountCents != null && contract.currencyCode
      ? formatMoney(input.amountCents, contract.currencyCode, locale ?? undefined)
      : "";

  // What "next" truthfully means for this contract (v1.28.0 audit): an open
  // case or a FAILED contract → the held payment is about to be retried (its
  // nextBillingDate sits inside the unbilled cycle, usually in the past); a
  // PAUSED contract → nothing is charged until resume; otherwise the
  // scheduled date, and only when it is still ahead.
  let hasOpenCase = input.hasOpenCase;
  if (hasOpenCase == null) {
    try {
      hasOpenCase =
        (await prisma.dunningCase.findFirst({
          where: { contractId: contract.id, resolvedAt: null },
          select: { id: true },
        })) != null;
    } catch (err) {
      console.error(
        "[notifications] payment_method_updated open-case lookup failed",
        contract.id,
        err,
      );
      hasOpenCase = false;
    }
  }
  const status = contract.status ?? null;
  const retrying = hasOpenCase === true || status === "FAILED";
  const paused = status === "PAUSED";
  const now = input.now ?? new Date();

  const changeKey =
    input.reason === "backup_promoted"
      ? cardLabel
        ? "email.payment_method_updated.change_line_backup_promoted"
        : "email.payment_method_updated.change_line_backup_promoted_nolabel"
      : input.reason === "backup_failed"
        ? cardLabel
          ? "email.payment_method_updated.change_line_backup_failed"
          : "email.payment_method_updated.change_line_backup_failed_nolabel"
        : input.reason === "new_method"
          ? retrying
            ? "email.payment_method_updated.change_line_new_method_retrying"
            : "email.payment_method_updated.change_line_new_method"
        : input.cardUpdatedBy === "merchant"
          ? "email.payment_method_updated.change_line_updated_by_merchant"
          : retrying
            ? "email.payment_method_updated.change_line_updated_retrying"
            : "email.payment_method_updated.change_line_updated";
  const changeLine = t(locale, changeKey, {
    card_label: cardLabel,
    previous_card_label: previousLabel,
  });
  const nextDateAhead =
    contract.nextBillingDate != null &&
    contract.nextBillingDate.getTime() > now.getTime();
  const nextLine = retrying
    ? ""
    : paused
      ? t(locale, "email.payment_method_updated.next_line_paused")
      : nextDate && nextDateAhead
        ? amount
          ? t(locale, "email.payment_method_updated.next_line_amount", {
              next_date: nextDate,
              amount,
            })
          : t(locale, "email.payment_method_updated.next_line", {
              next_date: nextDate,
            })
        : "";

  let ctaUrl: string | null = null;
  try {
    ctaUrl = await buildPortalUrl(
      contract.shopId,
      `/subscription/${contract.id}?toast=payment_method_changed`,
    );
  } catch (err) {
    console.error(
      "[notifications] payment_method_updated portal URL failed",
      contract.id,
      err,
    );
  }

  return {
    card_label: cardLabel,
    card_brand: contract.cardBrand ? capitalizeBrand(contract.cardBrand) : "",
    card_last4: contract.cardLast4 ?? "",
    previous_card_label: previousLabel,
    change_line: changeLine,
    next_line: nextLine,
    next_date: nextDate,
    amount,
    via_backup:
      input.reason === "backup_promoted" || input.reason === "backup_failed",
    change_reason: input.reason,
    card_updated_by: input.cardUpdatedBy,
    ...(ctaUrl ? { cta_url: ctaUrl } : {}),
  };
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable dedupe key: one notice per contract per card (last4) per 24 h. */
export function paymentMethodUpdatedDedupeKey(contract: CardLike): string {
  return `payment_method_updated:${contract.cardLast4 ?? "unknown"}`;
}

/**
 * Closed loop after a card change — deduped, contained. Returns the send
 * status ("DUPLICATE" when the 24 h window suppressed it; "FAILED" when the
 * router threw or the dedupe read failed AND the send failed).
 *
 * The dedupe read failing (DB blip) fails OPEN: the worst case is a second
 * "your card is updated" email; the alternative — a customer who just fixed
 * their card hearing nothing — is exactly what this notice exists to
 * prevent.
 */
export async function sendPaymentMethodUpdatedOnce(
  input: PaymentMethodUpdatedInput & { now?: Date },
): Promise<"SENT" | "SUPPRESSED" | "FAILED" | "DUPLICATE"> {
  const { contract } = input;
  const dedupeKey = paymentMethodUpdatedDedupeKey(contract);
  const now = input.now ?? new Date();
  try {
    const recent = await prisma.notificationLog.findFirst({
      where: {
        contractId: contract.id,
        template: "payment_method_updated",
        status: "SENT",
        createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) },
        payload: { path: ["vars", "dedupe_key"], equals: dedupeKey },
      },
      select: { id: true },
    });
    if (recent) return "DUPLICATE";
  } catch (err) {
    console.error(
      "[notifications] payment_method_updated dedupe read failed",
      contract.id,
      err,
    );
  }
  try {
    const vars = await paymentMethodUpdatedVars(input);
    const result = await sendNotification({
      shopId: contract.shopId,
      contractId: contract.id,
      template: "payment_method_updated",
      vars: { ...vars, dedupe_key: dedupeKey },
    });
    return result.status;
  } catch (err) {
    console.error(
      "[notifications] payment_method_updated send failed",
      contract.id,
      err,
    );
    return "FAILED";
  }
}
