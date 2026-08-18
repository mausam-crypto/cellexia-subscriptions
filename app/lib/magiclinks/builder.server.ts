import prisma from "~/db.server";
import {
  createMagicToken,
  type CreateMagicLinkInput,
} from "~/lib/crypto/tokens.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

/**
 * Magic link URL builders. Every URL is a signed, expiring, single-action token.
 * These are embedded in Klaviyo event properties so emails/SMS get one-tap verbs
 * with zero login.
 */

function appUrl(): string {
  const url = process.env.SHOPIFY_APP_URL;
  if (!url) throw new Error("SHOPIFY_APP_URL is not set");
  return url.replace(/\/$/, "");
}

export async function buildMagicUrl(
  input: CreateMagicLinkInput,
): Promise<string> {
  const token = await createMagicToken(input);
  return `${appUrl()}/magic/${token}`;
}

/** Portal URL on the shop's own domain via app proxy. */
export async function buildPortalUrl(
  shopId: string,
  path = "/",
): Promise<string> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const host = shop?.primaryDomain ?? shop?.domain;
  if (!host) throw new Error("No shop domain available for portal URL");
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `https://${host}${PORTAL_PROXY_BASE}${clean}`;
}

const DEFAULT_TTL_DAYS = 14;

/** Standard one-tap bundle attached to upcoming-order/dunning notifications. */
export async function buildActionLinkBundle(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
  addonVariantId?: string;
  /**
   * Pause exit ramp (v1.28.0, P2.6): also mint `resume_url` (RESUME — one
   * tap, resume now) and `extend_pause_url` (EXTEND_PAUSE — a landing page
   * offering the "need a little longer?" week choices). Set by the
   * resume_reminder send only; the choices come from
   * settings.portal.pauseExtendChoicesWeeks when `shopId` is given.
   */
  pauseControls?: boolean;
  shopId?: string;
}): Promise<Record<string, string>> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  const base = {
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
  };

  const [skipUrl, delay1wUrl, delay3wUrl, updateCardUrl, pauseUrl, retryUrl] =
    await Promise.all([
      buildMagicUrl({ ...base, action: "SKIP_NEXT" }),
      buildMagicUrl({ ...base, action: "DELAY_NEXT", params: { weeks: 1 } }),
      buildMagicUrl({ ...base, action: "DELAY_NEXT", params: { weeks: 3 } }),
      buildMagicUrl({ ...base, action: "UPDATE_CARD", maxUses: 5 }),
      buildMagicUrl({ ...base, action: "PAUSE", params: { months: 1 } }),
      // Customer "Retry now" (v1.28.0) — the dunning emails' one-tap retry.
      // Multi-use: the engine's per-case cooldown is the real throttle, and
      // a customer who taps it again after fixing the card must not find a
      // dead link.
      buildMagicUrl({ ...base, action: "RETRY_PAYMENT", maxUses: 5 }),
    ]);

  const bundle: Record<string, string> = {
    skip_url: skipUrl,
    delay_1w_url: delay1wUrl,
    delay_3w_url: delay3wUrl,
    update_card_url: updateCardUrl,
    pause_url: pauseUrl,
    retry_payment_url: retryUrl,
  };

  if (params.addonVariantId) {
    bundle.addon_url = await buildMagicUrl({
      ...base,
      action: "ADD_TO_NEXT",
      params: { variantId: params.addonVariantId },
    });
  }

  if (params.pauseControls) {
    const weeksChoices = await resolvePauseExtendChoices(params.shopId);
    const [resumeUrl, extendUrl] = await Promise.all([
      buildMagicUrl({ ...base, action: "RESUME" }),
      // The choice is made on the landing page (POST field), so ONE token
      // carries every allowed choice; execution validates against this list.
      buildMagicUrl({
        ...base,
        action: "EXTEND_PAUSE",
        params: { weeksChoices },
      }),
    ]);
    bundle.resume_url = resumeUrl;
    bundle.extend_pause_url = extendUrl;
  }

  return bundle;
}

/** Default when the setting cannot be read (contained — never blocks a send). */
export const DEFAULT_PAUSE_EXTEND_CHOICES_WEEKS: readonly number[] = [2, 4];

export async function resolvePauseExtendChoices(
  shopId: string | undefined,
): Promise<number[]> {
  if (!shopId) return [...DEFAULT_PAUSE_EXTEND_CHOICES_WEEKS];
  try {
    const { getSetting } = await import("~/lib/settings/settings.server");
    const portal = (await getSetting(shopId, "portal")) as {
      pauseExtendChoicesWeeks?: unknown;
    };
    const raw = portal.pauseExtendChoicesWeeks;
    const clean = Array.isArray(raw)
      ? raw.filter(
          (n): n is number =>
            typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 26,
        )
      : [];
    return clean.length > 0
      ? [...new Set(clean)].sort((a, b) => a - b)
      : [...DEFAULT_PAUSE_EXTEND_CHOICES_WEEKS];
  } catch (err) {
    console.error("[magic] pause extend choices read failed", shopId, err);
    return [...DEFAULT_PAUSE_EXTEND_CHOICES_WEEKS];
  }
}

/**
 * Routine check-in links (v1.28.0, P4.1): two CHECKIN verbs — "Great" and
 * "Not sure yet" — for the week-N check-in email. Multi-use (maxUses 3): a
 * customer who taps twice must not find a dead link, and the answer is
 * idempotent data. TTL defaults to the standard bundle TTL.
 */
export async function buildCheckinLinks(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
}): Promise<{ checkin_great_url: string; checkin_unsure_url: string }> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  const base = {
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
    maxUses: 3,
  };
  const [great, unsure] = await Promise.all([
    buildMagicUrl({ ...base, action: "CHECKIN", params: { answer: "great" } }),
    buildMagicUrl({ ...base, action: "CHECKIN", params: { answer: "unsure" } }),
  ]);
  return { checkin_great_url: great, checkin_unsure_url: unsure };
}

/**
 * One-tap slower cadence (v1.28.0, P3.6): a SET_FREQUENCY verb carrying the
 * exact {unit, count} the cancel-intent follow-up offered. Minted ONLY when
 * the caller has already established that a slower option exists on the
 * plan (nextSlowerFrequency) — the handler re-derives the offered list at
 * execution time, so a stale or tampered token can never set a cadence the
 * plan does not offer. Single-use like SKIP/DELAY. TTL defaults to the
 * standard bundle TTL.
 */
export async function buildSetFrequencyUrl(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
  frequency: { unit: "DAY" | "WEEK" | "MONTH"; count: number };
}): Promise<string> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  return buildMagicUrl({
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
    maxUses: 1,
    action: "SET_FREQUENCY",
    params: { unit: params.frequency.unit, count: params.frequency.count },
  });
}

/**
 * Uses per payment one-tap (USE_METHOD / SET_BACKUP) — the UPDATE_CARD /
 * RETRY_PAYMENT convention: the token is consumed before the verb runs and
 * both verbs are idempotent, so replay is harmless and a transient refusal
 * cannot strand the customer on a USED page (v1.28.0 review fix).
 */
export const PAYMENT_LINK_MAX_USES = 5;
/** Uses per SKIP_FAILED_CYCLE one-tap (see buildSkipFailedCycleUrl). */
export const SKIP_FAILED_CYCLE_MAX_USES = 3;

/**
 * One-tap "Use my card ····1234 instead" (v1.28.0, P1.7): a USE_METHOD verb
 * carrying the vaulted method's GID (+ a display label for the confirm
 * page). Minted ONLY for methods the caller just read from
 * listCustomerPaymentMethods for this contract's customer; the handler
 * re-validates through changePaymentMethod at execution time, so a stale or
 * tampered token can never attach a foreign method. Multi-use like
 * UPDATE_CARD (the verb is idempotent — already primary → no-op — and the
 * token is consumed BEFORE execution, so a single-use link would die on a
 * transient refusal whose copy says "try again in a moment"); TTL like the
 * dunning UPDATE_CARD link (caller passes the same days).
 */
export async function buildUseMethodUrl(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
  paymentMethodId: string;
  label?: string;
}): Promise<string> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  return buildMagicUrl({
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
    maxUses: PAYMENT_LINK_MAX_USES,
    action: "USE_METHOD",
    params: {
      paymentMethodId: params.paymentMethodId,
      ...(params.label ? { label: params.label } : {}),
    },
  });
}

/**
 * One-tap "Keep my card, use ····1234 only if a payment fails" (v1.28.0,
 * P1.8): a SET_BACKUP verb carrying the vaulted method's GID (+ display
 * label). Same trust model as USE_METHOD — minted only for a method just read
 * from listCustomerPaymentMethods for this customer, re-validated by
 * setBackupPaymentMethod at execution time. Multi-use like USE_METHOD
 * (idempotent verb: already the backup → no-op; a BACKUP_IN_USE refusal
 * during the engine's swap window must not kill the link).
 */
export async function buildSetBackupUrl(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
  paymentMethodId: string;
  label?: string;
}): Promise<string> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  return buildMagicUrl({
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
    maxUses: PAYMENT_LINK_MAX_USES,
    action: "SET_BACKUP",
    params: {
      paymentMethodId: params.paymentMethodId,
      ...(params.label ? { label: params.label } : {}),
    },
  });
}

/**
 * One-tap "Skip that order and continue" (v1.28.0, P1.9) for a FAILED
 * (dunning-exhausted) contract — carried by the payment_failed_parked
 * touches. No params: the held cycle, the card state and the resume date
 * are re-derived at execution time (skip-resume.server.ts). A few uses (the
 * CHECKIN precedent): the token is consumed before execution, so a transient
 * refusal (attempt_in_flight, a Shopify blip) must not burn the customer's
 * one-tap; a replay after success lands on "already back on" (the verb
 * refuses non-FAILED contracts). The TTL should cover the whole
 * post-exhaustion window (caller passes days).
 */
export async function buildSkipFailedCycleUrl(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
}): Promise<string> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  return buildMagicUrl({
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
    maxUses: SKIP_FAILED_CYCLE_MAX_USES,
    action: "SKIP_FAILED_CYCLE",
  });
}
