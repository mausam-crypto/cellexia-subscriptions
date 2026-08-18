import type { SubscriptionContract } from "@prisma/client";
import { t } from "~/lib/i18n/i18n.server";
import { getSetting } from "~/lib/settings/settings.server";
import { listCustomerPaymentMethods, type AdminClient } from "~/lib/graphql/index.server";
import { buildUseMethodUrl } from "~/lib/magiclinks/builder.server";
import { vaultedMethodLabel } from "~/lib/portal/payment-methods.server";
import { cardExpiryMoment } from "~/lib/dates.server";

/**
 * "Use my card ····1234 instead" lines for the payment_failed_2 / _3 emails
 * (v1.28.0, P1.7). Computed at SEND time from the customer's live vaulted
 * methods: one USE_METHOD magic link per LIVE method other than the
 * contract's current primary (a single-card customer gets nothing — the
 * update path is the story then). "Other" is counted against the primary,
 * not against the live count: a REVOKED primary is absent from the live
 * list, so a customer whose card was removed and who holds one other card —
 * exactly the customer whose update-card path is dead — still gets the
 * line. Expired vaulted cards (Shopify keeps them non-revoked) are never
 * offered: switching onto one only earns another decline.
 *
 * Contained by design: every failure (settings, admin client, Shopify read,
 * link mint) yields the empty block, so the template's `{other_cards_block}`
 * renders as nothing and the email still goes out. Merchant switch:
 * settings.portal.paymentMethodsList (off ⇒ empty). Capped at
 * MAX_OTHER_CARD_LINES lines so a card-collector account cannot flood the
 * email.
 */

export const MAX_OTHER_CARD_LINES = 3;

export interface OtherCardsBlockInput {
  admin: AdminClient;
  contract: Pick<
    SubscriptionContract,
    "id" | "shopId" | "customerId" | "email" | "locale" | "paymentMethodId"
  >;
  /** TTL of the USE_METHOD links (days) — the caller passes the UPDATE_CARD TTL. */
  ttlDays: number;
  createdVia: string;
  /** Shop timezone for the expiry check (golden rule 5); UTC month start otherwise. */
  tz?: string | null;
  now?: Date;
}

/**
 * Pure composer: given the live methods (already read), the lines. Exported
 * for tests and for callers that already hold the list.
 */
export async function composeOtherCardsBlock(
  input: OtherCardsBlockInput,
  liveMethods: Array<{
    id: string;
    revoked: boolean;
    instrument: {
      type: string;
      brand: string | null;
      lastDigits: string | null;
      expiryMonth?: number | null;
      expiryYear?: number | null;
    } | null;
  }>,
): Promise<string> {
  const now = input.now ?? new Date();
  const others = liveMethods
    .filter((m) => !m.revoked && m.id !== input.contract.paymentMethodId)
    .filter((m) => {
      const expiresAt = cardExpiryMoment(
        m.instrument?.expiryMonth,
        m.instrument?.expiryYear,
        input.tz,
      );
      return !expiresAt || expiresAt.getTime() > now.getTime();
    })
    .slice(0, MAX_OTHER_CARD_LINES);
  if (others.length === 0) return "";
  const locale = input.contract.locale ?? "en";
  const lines: string[] = [];
  for (const m of others) {
    const label = vaultedMethodLabel(locale, {
      instrument: m.instrument
        ? {
            type: m.instrument.type as "CREDIT_CARD" | "SHOP_PAY" | "PAYPAL" | "UNKNOWN",
            brand: m.instrument.brand,
            lastDigits: m.instrument.lastDigits,
            expiryMonth: m.instrument.expiryMonth ?? null,
            expiryYear: m.instrument.expiryYear ?? null,
            expiresSoon: null,
          }
        : null,
    });
    const url = await buildUseMethodUrl({
      contractId: input.contract.id,
      customerId: input.contract.customerId,
      email: input.contract.email ?? undefined,
      createdVia: input.createdVia,
      ttlDays: input.ttlDays,
      paymentMethodId: m.id,
      label,
    });
    lines.push(t(locale, "email.payment_failed.use_card_line", { card: label, url }));
  }
  // Trailing blank line: the body places `{other_cards_block}` right before
  // the next paragraph, so a non-empty block must close its own paragraph.
  return `${lines.join("\n")}\n\n`;
}

/** Read + compose; never throws (empty block on any failure). */
export async function otherCardsBlockForContract(
  input: OtherCardsBlockInput,
): Promise<string> {
  try {
    const portal = (await getSetting(input.contract.shopId, "portal")) as {
      paymentMethodsList?: boolean;
    };
    if (portal.paymentMethodsList === false) return "";
    const methods = await listCustomerPaymentMethods(
      input.admin,
      input.contract.customerId,
    );
    return await composeOtherCardsBlock(input, methods);
  } catch (err) {
    console.error(
      "[dunning] other-cards block failed (email goes out without it)",
      input.contract.id,
      err,
    );
    return "";
  }
}
