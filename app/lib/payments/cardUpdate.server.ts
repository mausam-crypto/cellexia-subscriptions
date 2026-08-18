import { logEvent, type EventSource } from "~/lib/events/log.server";
import {
  ShopifyUserError,
  getPaymentMethodUpdateUrl,
  sendPaymentMethodUpdateEmail,
  type AdminClient,
} from "~/lib/graphql/index.server";
import { adminClientForShop } from "~/shopify.server";

/**
 * Card-update path resolver (v1.28.0, P1.1).
 *
 * ONE decision, made server-side, for every surface that offers "Update your
 * card" — portal button, UPDATE_CARD magic link, SMS/dunning links, admin
 * "Open secure page":
 *
 * - `customerPaymentMethodGetUpdateUrl` (hosted page, 302) — per the Admin
 *   API reference it "currently only supports Shop Pay"; card instruments
 *   return userError code INVALID_INSTRUMENT. Until v1.28.0 every surface
 *   called it blindly, so card payers hit a dead button.
 * - `customerPaymentMethodSendUpdateEmail` — Shopify emails the customer its
 *   own "Confirm payment for your subscription" link (valid 48h) and replaces
 *   the instrument under the SAME payment-method id. Works for cards and
 *   PayPal. This is the fallback (and the default when the instrument type is
 *   not Shop Pay).
 *
 * Decision: no paymentMethodId → unavailable; SHOP_PAY → hosted URL;
 * null/UNKNOWN type → try the hosted URL, fall back on INVALID_INSTRUMENT;
 * CREDIT_CARD / PAYPAL → email. Every path logs
 * `contract.card_update_link_sent {channel, source, actor}` (contained: the
 * event log never breaks the action). A revoked primary is reported as
 * unavailable — the id no longer resolves on Shopify.
 */

export type CardUpdatePathSource =
  | "CUSTOMER_PORTAL"
  | "MAGIC_LINK"
  | "ADMIN"
  | "DUNNING"
  | "SMS";

export type CardUpdatePath =
  | { kind: "redirect"; url: string }
  | { kind: "email_sent" }
  | { kind: "unavailable"; reason: CardUpdateUnavailableReason };

export type CardUpdateUnavailableReason =
  | "no_payment_method" // contract has no paymentMethodId mirrored
  | "payment_method_revoked" // primary revoked and no promotion happened
  | "shopify_error"; // both Shopify paths failed (already logged)

/** The slice of a SubscriptionContract the resolver reads. */
export interface CardUpdateContract {
  id: string;
  shopId: string;
  customerId: string;
  email?: string | null;
  paymentMethodId: string | null;
  paymentInstrumentType?: string | null;
  paymentMethodRevokedAt?: Date | null;
}

export interface ResolveCardUpdatePathInput {
  /** Either an admin client or the shop domain to build one from. */
  admin?: AdminClient;
  shopDomain?: string;
  contract: CardUpdateContract;
  source: CardUpdatePathSource;
  actor?: string | null;
}

/** Event source for the audit row; mirrors the calling surface. */
function eventSourceFor(source: CardUpdatePathSource): EventSource {
  switch (source) {
    case "CUSTOMER_PORTAL":
      return "CUSTOMER_PORTAL";
    case "MAGIC_LINK":
      return "MAGIC_LINK";
    case "ADMIN":
      return "ADMIN";
    case "DUNNING":
    case "SMS":
      return "SCHEDULER";
    default:
      return "SYSTEM";
  }
}

function isInvalidInstrument(err: unknown): boolean {
  return (
    err instanceof ShopifyUserError &&
    err.errors.some((e) => e.code === "INVALID_INSTRUMENT")
  );
}

async function logSent(
  input: ResolveCardUpdatePathInput,
  channel: "hosted_url" | "shopify_email",
): Promise<void> {
  try {
    await logEvent({
      shopId: input.contract.shopId,
      contractId: input.contract.id,
      customerId: input.contract.customerId,
      email: input.contract.email ?? undefined,
      type: "contract.card_update_link_sent",
      source: eventSourceFor(input.source),
      actor: input.actor ?? null,
      payload: {
        channel,
        source: input.source,
        actor: input.actor ?? null,
        paymentMethodId: input.contract.paymentMethodId,
        instrumentType: input.contract.paymentInstrumentType ?? null,
      },
    });
  } catch (err) {
    console.error("[payments] card_update_link_sent log failed", err);
  }
}

/**
 * Decide and perform the card-update path for a contract. Never throws for
 * Shopify refusals — returns `unavailable` with a reason (already logged) so
 * every surface renders an honest state instead of a 500.
 */
export async function resolveCardUpdatePath(
  input: ResolveCardUpdatePathInput,
): Promise<CardUpdatePath> {
  const { contract } = input;
  const paymentMethodId = contract.paymentMethodId;
  if (!paymentMethodId) {
    return { kind: "unavailable", reason: "no_payment_method" };
  }
  if (contract.paymentMethodRevokedAt) {
    return { kind: "unavailable", reason: "payment_method_revoked" };
  }

  let admin: AdminClient;
  try {
    admin = input.admin ?? (await adminClientForShop(requireDomain(input)));
  } catch (err) {
    console.error("[payments] card update: admin client unavailable", err);
    return { kind: "unavailable", reason: "shopify_error" };
  }

  const type = contract.paymentInstrumentType ?? null;
  const tryHosted = type === "SHOP_PAY" || type == null || type === "UNKNOWN";

  if (tryHosted) {
    try {
      const url = await getPaymentMethodUpdateUrl(admin, paymentMethodId);
      await logSent(input, "hosted_url");
      return { kind: "redirect", url };
    } catch (err) {
      if (type === "SHOP_PAY" && !isInvalidInstrument(err)) {
        // Shop Pay is the documented case for the hosted page; anything but
        // "instrument not supported" is a real failure — still try the email
        // (it works for every instrument kind) before giving up.
        console.error(
          "[payments] hosted card-update URL failed for Shop Pay method",
          contract.id,
          err,
        );
      } else if (!isInvalidInstrument(err)) {
        console.error(
          "[payments] hosted card-update URL failed; falling back to email",
          contract.id,
          err,
        );
      }
      // INVALID_INSTRUMENT (card / PayPal behind an unknown type) → email.
    }
  }

  try {
    await sendPaymentMethodUpdateEmail(admin, paymentMethodId);
    await logSent(input, "shopify_email");
    return { kind: "email_sent" };
  } catch (err) {
    console.error(
      "[payments] customerPaymentMethodSendUpdateEmail failed",
      contract.id,
      err,
    );
    return { kind: "unavailable", reason: "shopify_error" };
  }
}

function requireDomain(input: ResolveCardUpdatePathInput): string {
  if (!input.shopDomain) {
    throw new Error("resolveCardUpdatePath needs `admin` or `shopDomain`");
  }
  return input.shopDomain;
}
