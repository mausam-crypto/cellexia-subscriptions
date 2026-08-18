import { z } from "zod";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { normalizeLocale, t } from "~/lib/i18n/i18n.server";
import { addWeeksTz, formatShopDate } from "~/lib/dates.server";
import { createMagicToken, type MagicPayload } from "~/lib/crypto/tokens.server";
import { buildMagicUrl, buildPortalUrl } from "~/lib/magiclinks/builder.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { adminClientForShop } from "~/shopify.server";
import { resolveCardUpdatePath } from "~/lib/payments/cardUpdate.server";
import {
  addOneTimeAddon,
  applyDiscountGrant,
  delayNextCycle,
  delaySchedule,
  extendPause,
  PauseUntilError,
  pauseContract,
  resumeContract,
  skipNextCycle,
  swapLineVariant,
  unskipNextCycle,
  changeFrequency,
  changePaymentMethod,
  setBackupPaymentMethod,
} from "~/lib/contracts/service.server";
import {
  isPaymentMethodGid,
  paymentMethodErrorToast,
} from "~/lib/portal/payment-methods.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import type { WinbackOffer } from "~/lib/winback/restart.server";
import { delayModeFor } from "~/lib/portal/schedule.server";
import {
  isPreparingOrder,
  resolveChargeTiming,
} from "~/lib/billing/timing.server";
import {
  approxWeeks,
  contractFrequency,
  formatFrequency,
  sameFrequency,
  type Frequency,
} from "~/lib/frequency";

/**
 * Magic link execution. `executeMagicAction` is called by the /magic/:token
 * route AFTER the token has been verified + consumed; it dispatches every
 * verb into the contract services with `{ source: MAGIC_LINK, actor:
 * "customer" }` and returns localized copy for the standalone result page
 * (or a redirect for the hand-off verbs).
 *
 * `describeMagicAction` powers the pre-consumption GET confirmation page —
 * it only reads, never mutates.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MagicActionResult {
  headline: string;
  sub?: string;
  /** External hand-off (Shopify card update / 3DS / portal). */
  redirect?: string;
  /** One-tap undo magic link (e.g. UNSKIP after a SKIP). */
  undoUrl?: string;
  portalUrl?: string;
  /** Resolved customer locale — the route uses it for chrome copy. */
  locale: string;
}

export interface MagicActionDescription {
  action: MagicPayload["action"];
  locale: string;
  title: string;
  description: string;
  confirmLabel: string;
  portalUrl: string | null;
  /**
   * Set when the plan lock window — or the setup-mode launch gate — refuses
   * this verb RIGHT NOW: the GET confirm page must render this terminal
   * refusal instead of the promise + confirm form — otherwise the customer
   * taps "Confirm", burns the token's single use on a refusal, and the link
   * is dead by the time the window opens (or the store is LIVE again).
   */
  lockedResult?: MagicActionResult;
  /**
   * Multi-choice landing page (v1.28.0, EXTEND_PAUSE): the confirm form
   * renders one button per choice, each posting `choice=<value>`; the route
   * hands the tapped value to `executeMagicAction(payload, { choice })`.
   * Absent = the classic single confirm button.
   */
  choices?: Array<{ value: string; label: string }>;
}

type ContractWithLines = Prisma.SubscriptionContractGetPayload<{
  include: { lines: true; shop: true };
}>;

interface MagicContext {
  shop: Shop;
  contract: ContractWithLines | null;
  locale: string;
}

/** Every service call made on behalf of a magic link carries this identity. */
const MAGIC_OPTS = { source: "MAGIC_LINK" as const, actor: "customer" };

/**
 * Headline + sub for a lock-refused link, in the merchant's chosen register
 * (portal.friendlyLockMessaging, v1.19.0): the friendly default reads as
 * "almost there" with the benefit framing; off = the original factual copy.
 * Falls back to the classic keys when the unlock date could not be resolved
 * (the friendly headline embeds the date). Failure-contained: a broken
 * settings read must never break the locked page — classic copy applies.
 */
async function lockedCopy(
  shopId: string,
  locale: string,
  date: string,
): Promise<{ headline: string; sub?: string }> {
  let friendly = false;
  if (date) {
    try {
      friendly = (await getSetting(shopId, "portal")).friendlyLockMessaging;
    } catch {
      friendly = false;
    }
  }
  if (friendly) {
    return {
      headline: t(locale, "magic.locked_friendly", { date }),
      sub: t(locale, "magic.locked_friendly_sub"),
    };
  }
  return {
    headline: t(locale, "magic.locked"),
    sub: date ? t(locale, "magic.locked_sub", { date }) : undefined,
  };
}

/**
 * LOGIN hand-off code TTL. The code exists only for the duration of one 303
 * redirect (magic route → portal), is single-use, and is exchanged server-side
 * for the HttpOnly session cookie — see exchangeLoginHandoff.
 */
const LOGIN_HANDOFF_TTL_SECONDS = 60;

// ── Param parsing ────────────────────────────────────────────────────────────

const magicParamsSchema = z
  .object({
    weeks: z.number().optional(),
    months: z.number().optional(),
    variantId: z.string().optional(),
    lineId: z.string().optional(),
    percent: z.number().optional(),
    cycles: z.number().optional(),
    /** Winback perk stage: grant the reactivation gift (no discount). */
    gift: z.boolean().optional(),
    /**
     * One-tap restart link (v1.28.0, P3.2): carries no offer of its own —
     * the tap applies whatever offer the win-back engine currently stands
     * behind (restart.server.ts), so the confirm page and the result both
     * describe the re-derived offer, never the minted params.
     */
    restart: z.boolean().optional(),
    redirectUrl: z.string().nullable().optional(),
    /** EXTEND_PAUSE: the week choices the landing page may offer. */
    weeksChoices: z.array(z.number()).optional(),
    /** CHECKIN: the one-tap answer the link carries. */
    answer: z.enum(["great", "unsure"]).optional(),
    /** SET_FREQUENCY (P3.6): the exact cadence the follow-up offered. */
    unit: z.enum(["DAY", "WEEK", "MONTH"]).optional(),
    count: z.number().optional(),
    /** USE_METHOD (P1.7): the vaulted method GID + its display label. */
    paymentMethodId: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

type MagicParams = z.infer<typeof magicParamsSchema>;

function parseParams(payload: MagicPayload): MagicParams {
  const parsed = magicParamsSchema.safeParse(payload.params ?? {});
  return parsed.success ? parsed.data : {};
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : null;
  if (n == null) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ── Context resolution ───────────────────────────────────────────────────────

async function resolveMagicContext(payload: MagicPayload): Promise<MagicContext> {
  let contract: ContractWithLines | null = null;

  if (payload.contractId) {
    contract = await prisma.subscriptionContract.findUnique({
      where: { id: payload.contractId },
      include: { lines: true, shop: true },
    });
    if (!contract) {
      throw new Error(`Magic link contract not found: ${payload.contractId}`);
    }
    // A magic link is a zero-login mutation (skip / delay / pause / discount).
    // A contract owned by the store's other subscription app is never ours to
    // act on — treat it as if the link did not resolve. UNKNOWN fails safe too.
    if (!isBillableOwnership(contract.ownership)) {
      throw new Error(
        `Magic link contract is not managed by this app: ${payload.contractId}`,
      );
    }
  } else if (payload.email) {
    // LOGIN links may carry only an email; anchor on the newest contract we own.
    contract = await prisma.subscriptionContract.findFirst({
      where: { email: payload.email, ...OURS_ONLY },
      orderBy: { createdAt: "desc" },
      include: { lines: true, shop: true },
    });
  }

  const shop = contract?.shop ?? (await getPrimaryShop());
  if (!shop) throw new Error("No installed shop — cannot resolve magic link");

  return { shop, contract, locale: normalizeLocale(contract?.locale) };
}

function requireContract(ctx: MagicContext): ContractWithLines {
  if (!ctx.contract) {
    throw new Error("This magic link action requires a contract");
  }
  return ctx.contract;
}

function fmtDate(date: Date | null | undefined, shop: Shop, locale: string): string {
  return date ? formatShopDate(date, shop.ianaTimezone, locale) : "";
}

async function safePortalUrl(shopId: string, path = "/"): Promise<string | null> {
  try {
    return await buildPortalUrl(shopId, path);
  } catch (err) {
    console.error("[magic] portal URL build failed", err);
    return null;
  }
}

/**
 * Best-effort portal login URL for error pages, where no valid payload (and
 * therefore no contract) is available. Null when it cannot be built.
 */
export async function bestEffortPortalLoginUrl(): Promise<string | null> {
  try {
    const shop = await getPrimaryShop();
    if (!shop) return null;
    return await buildPortalUrl(shop.id, "/login");
  } catch (err) {
    console.error("[magic] best-effort portal login URL failed", err);
    return null;
  }
}

// ── 3DS redirect validation ──────────────────────────────────────────────────

// Lives in ./redirect (dependency-free) since v1.28.0 so the portal's
// "Confirm with my bank" verb shares the exact same gate; re-exported here
// for every existing importer.
export { isTrustedShopifyRedirect } from "./redirect";
import { isTrustedShopifyRedirect } from "./redirect";

// ── SET_FREQUENCY (v1.28.0, P3.6) ────────────────────────────────────────────

/** The {unit, count} a SET_FREQUENCY token carries, or null when malformed. */
export function setFrequencyTarget(params: MagicParams): Frequency | null {
  const unit = params.unit;
  const count = params.count;
  if (unit !== "DAY" && unit !== "WEEK" && unit !== "MONTH") return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    return null;
  }
  return { unit, count };
}

/**
 * One-tap slower cadence from the cancel-intent follow-up email. Truth is
 * re-derived HERE, not trusted from the token: the target must still be one
 * of the plan's offered cadences (frequencyOptionsForContract — the same
 * membership + allowChoice rule the portal's frequency form enforces) AND
 * still slower than the contract's current cadence (the customer may have
 * changed it since the email went out — a link that would speed deliveries
 * up, or do nothing, refuses honestly instead of "confirming"). Applied
 * through changeFrequency as MAGIC_LINK/customer, so the confirmation email
 * and the frequency_changed event fire exactly as from the portal.
 */
async function setFrequency(
  ctx: MagicContext,
  params: MagicParams,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, locale } = ctx;
  const c = requireContract(ctx);
  const target = setFrequencyTarget(params);
  const tr = (key: string, v?: Record<string, string | number>) => t(locale, key, v);
  const refuse = (): MagicActionResult => ({
    locale,
    headline: t(locale, "magic.set_frequency.unavailable"),
    sub: t(locale, "magic.set_frequency.unavailable_sub"),
    portalUrl,
  });
  if (!target) return refuse();
  // ACTIVE only — the same truth as the portal dispatcher (ACTIVE_ONLY has
  // "frequency") and intentApplicabilitySync, so an emailed one-tap and the
  // portal banner never disagree about a paused contract.
  if (c.status !== "ACTIVE") return refuse();
  const { frequencyOptionsForContract } = await import(
    "~/lib/portal/catalog.server"
  );
  const { options, allowChoice } = await frequencyOptionsForContract(shop.id, c);
  if (!allowChoice || !options.some((o) => sameFrequency(o, target))) {
    return refuse();
  }
  const current = contractFrequency(c);
  if (
    approxWeeks(target.unit, target.count) <=
    approxWeeks(current.unit, current.count)
  ) {
    return refuse();
  }
  const updated = await changeFrequency(shop.domain, c.id, target, MAGIC_OPTS);
  const frequency = formatFrequency(tr, "every", target);
  const date = fmtDate(
    updated.status === "PAUSED" ? updated.resumeAt : updated.nextBillingDate,
    shop,
    locale,
  );
  return {
    locale,
    headline: t(locale, "magic.set_frequency.done", { frequency }),
    sub: date ? t(locale, "magic.set_frequency.sub", { date }) : undefined,
    portalUrl,
  };
}

// ── EXTEND_PAUSE choices ─────────────────────────────────────────────────────

const EXTEND_WEEKS_FALLBACK: readonly number[] = [2, 4];

/**
 * The week choices a token may offer: its own `weeksChoices` (minted from
 * settings.portal.pauseExtendChoicesWeeks), sanitised to integers 1–26,
 * de-duplicated and sorted; the fixed fallback when the token carries none.
 */
export function allowedExtendWeeks(params: MagicParams): number[] {
  const raw = Array.isArray(params.weeksChoices) ? params.weeksChoices : [];
  const clean = [
    ...new Set(
      raw.filter(
        (n): n is number =>
          typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 26,
      ),
    ),
  ].sort((a, b) => a - b);
  return clean.length > 0 ? clean : [...EXTEND_WEEKS_FALLBACK];
}

function extendPauseChoices(
  params: MagicParams,
  contract: ContractWithLines | null,
  shop: Shop,
  locale: string,
): Array<{ value: string; label: string }> {
  const base = contract?.resumeAt ?? null;
  return allowedExtendWeeks(params).map((weeks) => {
    const date = base
      ? fmtDate(addWeeksTz(base, weeks, shop.ianaTimezone), shop, locale)
      : "";
    return {
      value: String(weeks),
      label: date
        ? t(locale, "magic.extend_pause.choice", { weeks, date })
        : t(locale, "magic.extend_pause.choice_nodate", { weeks }),
    };
  });
}

// ── Confirmation-page description (GET — read-only) ──────────────────────────

const REDIRECT_ACTIONS = new Set<MagicPayload["action"]>([
  "CHECKIN",
  "UPDATE_CARD",
  "CONFIRM_3DS",
  "LOGIN",
]);

/**
 * Verbs that mutate a contract — these share the portal's hourly ceiling AND
 * the setup-mode launch gate. The complement (LOGIN / UPDATE_CARD /
 * CONFIRM_3DS / PREVIEW) never edits a contract from here: card + 3DS
 * hand-offs land on Shopify-hosted pages (dunning is gated at its own
 * source), LOGIN opens the portal (which enforces its own launch gate), and
 * preview is the whole point of setup mode.
 */
const MUTATING_MAGIC_ACTIONS = new Set<MagicPayload["action"]>([
  "SKIP_NEXT",
  "UNSKIP_NEXT",
  "DELAY_NEXT",
  "ADD_TO_NEXT",
  "PAUSE",
  "RESUME",
  "EXTEND_PAUSE",
  "SWAP",
  "APPLY_WINBACK",
  // A charge attempt is a mutation too (v1.28.0): launch-gated + throttled,
  // never lock-blocked (a recovery, like UNSKIP/RESUME).
  "RETRY_PAYMENT",
  // One-tap slower cadence (v1.28.0, P3.6) — a schedule edit like SWAP.
  "SET_FREQUENCY",
  // Keep a scheduled-cancel subscription (v1.28.0, P3.8): a recovery —
  // launch-gated + throttled, never lock-blocked.
  "KEEP_SUBSCRIPTION",
  // Switch to another vaulted card (v1.28.0, P1.7): a Shopify contract edit
  // — launch-gated + throttled; a recovery, never lock-blocked.
  "USE_METHOD",
  // Set another vaulted card as the backup (v1.28.0, P1.8): a contract
  // mutation (local column) — launch-gated + throttled, never lock-blocked.
  "SET_BACKUP",
  // Skip the held order of a FAILED contract and reactivate (v1.28.0,
  // P1.9): Shopify cycle skip + activate — launch-gated + throttled; a
  // recovery, never lock-blocked.
  "SKIP_FAILED_CYCLE",
]);

/**
 * Verbs the plan lock window refuses at EXECUTION time (links are minted up
 * to 14 days ahead and sit in inboxes — mint-time gating would be a hole).
 * The reducing verbs only: UNSKIP_NEXT / RESUME / ADD_TO_NEXT / APPLY_WINBACK
 * stay available, matching the portal dispatcher's blocked set.
 */
const LOCKED_MAGIC_ACTIONS = new Set<MagicPayload["action"]>([
  "SKIP_NEXT",
  "DELAY_NEXT",
  "PAUSE",
  // Extending a hold extends a reduction (P2.6) — guarded for symmetry with
  // PAUSE; a no-op in practice (a hold inside the window was placed by an
  // exempt path). RESUME stays a recovery.
  "EXTEND_PAUSE",
  "SWAP",
  // A slower cadence is a schedule reduction — blocked like the portal's
  // frequency select inside the lock window.
  "SET_FREQUENCY",
]);

/**
 * Verbs the preparing-your-order window refuses at EXECUTION time (v1.28.0
 * review fix — parity with the portal dispatcher's PREPARING_BLOCKED): once
 * the billing day's charge moment has passed or an attempt is in flight, a
 * one-tap SKIP / DELAY / SWAP from a reminder email must not edit the cycle
 * being billed. Recoveries stay available.
 */
const PREPARING_MAGIC_ACTIONS = new Set<MagicPayload["action"]>([
  "SKIP_NEXT",
  "DELAY_NEXT",
  "SWAP",
  // Parity with the portal dispatcher (frequency is PREPARING_BLOCKED).
  "SET_FREQUENCY",
]);

/**
 * Terminal refusal for the setup-mode launch gate. Reuses the portal's
 * closed-portal copy (portal.setup.*): the magic page and the portal the
 * customer lands on next must tell the same story during the same freeze.
 */
function setupGateResult(
  locale: string,
  portalUrl: string | undefined,
): MagicActionResult {
  return {
    locale,
    headline: t(locale, "portal.setup.title"),
    sub: t(locale, "portal.setup.body"),
    portalUrl,
  };
}

/**
 * Terminal page for a contract-level verb (SET_FREQUENCY / USE_METHOD /
 * SWAP) Shopify refused because one-off changes are staged on the next order
 * (ContractEditBlockedError, v1.28.0 audit). The route calls this from its
 * catch: the tap is already consumed, so the customer gets the same
 * "undo your one-off changes first" truth the portal toast tells, plus the
 * portal link — instead of the generic "try again in a moment" (a retry of
 * the same link would only say USED). Contained: falls back to the master
 * locale when the context cannot be resolved.
 */
export function isContractEditBlockedError(err: unknown): boolean {
  return err instanceof Error && err.name === "ContractEditBlockedError";
}

export async function cycleEditsBlockedResult(
  payload: MagicPayload,
): Promise<MagicActionResult> {
  let locale = "en";
  let portalUrl: string | undefined;
  try {
    const ctx = await resolveMagicContext(payload);
    locale = ctx.locale;
    portalUrl = (await safePortalUrl(ctx.shop.id)) ?? undefined;
  } catch (err) {
    console.error("[magic] cycle-edits refusal context failed", err);
  }
  return {
    locale,
    headline: t(locale, "magic.cycle_edits_pending"),
    sub: t(locale, "magic.cycle_edits_pending_sub"),
    portalUrl,
  };
}

export async function describeMagicAction(
  payload: MagicPayload,
): Promise<MagicActionDescription> {
  const ctx = await resolveMagicContext(payload);
  const { shop, contract, locale } = ctx;
  const params = parseParams(payload);

  const vars: Record<string, string | number> = {
    weeks: clampInt(params.weeks, 1, 26, 1),
    months: clampInt(params.months, 1, 6, 1),
    date: fmtDate(contract?.nextBillingDate, shop, locale),
    // EXTEND_PAUSE / RESUME (P2.6): the hold's current resume day.
    resume_date: fmtDate(contract?.resumeAt, shop, locale),
    // SET_FREQUENCY (P3.6): the cadence the link would set, in words.
    frequency: setFrequencyTarget(params)
      ? formatFrequency(
          (key, v) => t(locale, key, v),
          "every",
          setFrequencyTarget(params)!,
        )
      : "",
    // USE_METHOD (P1.7): the card label minted with the link (display only;
    // the id is what executes, re-validated then).
    card: typeof params.label === "string" ? params.label : "",
  };
  // SKIP_FAILED_CYCLE (P1.9): the date the verb would resume from — the
  // same computation the execution uses; contained (empty ⇒ no-date copy).
  if (payload.action === "SKIP_FAILED_CYCLE" && contract) {
    const { previewSkipResumeDate } = await import(
      "~/lib/dunning/skip-resume.server"
    );
    const resumeDate = await previewSkipResumeDate(contract, shop.ianaTimezone);
    vars.date = fmtDate(resumeDate, shop, locale);
  }

  // EXTEND_PAUSE landing page: one button per allowed week choice, each
  // labelled with the exact new resume day it would produce.
  let choices: MagicActionDescription["choices"];
  if (payload.action === "EXTEND_PAUSE") {
    choices = extendPauseChoices(params, contract, shop, locale);
  }

  // Perk-stage winback links promise a GIFT, not a discount — the confirm
  // page must promise exactly what executing the link grants.
  // UPDATE_CARD: resolveCardUpdatePath (payments/cardUpdate.server.ts) only
  // redirects Shop Pay (and unknown-type) payers to Shopify's hosted page;
  // card / PayPal payers get Shopify's emailed 48h link — the confirm page
  // must promise the path the POST will actually take.
  const instrumentType = contract?.paymentInstrumentType ?? null;
  const cardUpdateByEmail =
    instrumentType === "CREDIT_CARD" || instrumentType === "PAYPAL";
  // DELAY_NEXT: the promise must match what executing the link does under
  // portal.delayReanchors (whole schedule vs this order only) — contained
  // settings read, one-cycle copy on any problem.
  let delayReanchors = false;
  if (payload.action === "DELAY_NEXT") {
    try {
      delayReanchors =
        delayModeFor(await getSetting(shop.id, "portal"), null) === "reanchor";
    } catch {
      delayReanchors = false;
    }
  }
  // Restart links (P3.2): the promise is the CURRENT offer, re-derived —
  // discount / gift / plain restart — never the minted percent 0.
  let restartOffer: WinbackOffer | null = null;
  const isRestartLink =
    payload.action === "APPLY_WINBACK" && params.restart === true;
  if (isRestartLink && contract) {
    restartOffer = await deriveRestartOffer(shop, contract, { memo: true });
    if (restartOffer?.kind === "DISCOUNT") {
      vars.percent = restartOffer.percent;
      vars.cycles = restartOffer.cycles;
    }
  }
  const descKey =
    payload.action === "CHECKIN"
      ? params.answer === "unsure"
        ? "magic.confirm.desc.CHECKIN_UNSURE"
        : "magic.confirm.desc.CHECKIN_GREAT"
      : isRestartLink
        ? restartOffer?.kind === "DISCOUNT"
          ? "magic.confirm.desc.APPLY_WINBACK_RESTART_DISCOUNT"
          : restartOffer?.kind === "GIFT"
            ? "magic.confirm.desc.APPLY_WINBACK_GIFT"
            : "magic.confirm.desc.APPLY_WINBACK_RESTART"
      : payload.action === "APPLY_WINBACK" && params.gift === true
      ? "magic.confirm.desc.APPLY_WINBACK_GIFT"
      : payload.action === "UPDATE_CARD" && cardUpdateByEmail
        ? "magic.confirm.desc.UPDATE_CARD_EMAIL"
        : payload.action === "USE_METHOD" && !vars.card
          ? "magic.confirm.desc.USE_METHOD_GENERIC"
        : payload.action === "SET_BACKUP" && !vars.card
          ? "magic.confirm.desc.SET_BACKUP_GENERIC"
        : payload.action === "SKIP_FAILED_CYCLE" && !vars.date
          ? "magic.confirm.desc.SKIP_FAILED_CYCLE_NODATE"
        : payload.action === "DELAY_NEXT" && delayReanchors
          ? "magic.confirm.desc.DELAY_NEXT_REANCHOR"
          : `magic.confirm.desc.${payload.action}`;

  // Setup-mode launch gate, checked at DESCRIBE time: while the store is in
  // SETUP (install-dark, or an emergency revertToSetup) the GET page must
  // render the refusal INSTEAD of the confirm form so nothing is consumed
  // and the same link works again once the store is LIVE (see lockedResult's
  // doc). Mutating verbs only; executeMagicAction holds the enforcement.
  let lockedResult: MagicActionResult | undefined;
  if (
    MUTATING_MAGIC_ACTIONS.has(payload.action) &&
    (await isSetupMode(shop.id))
  ) {
    lockedResult = setupGateResult(
      locale,
      (await safePortalUrl(shop.id)) ?? undefined,
    );
  }

  // Plan lock window, checked at DESCRIBE time too: the GET page must tell
  // the truth before the customer taps confirm (see lockedResult's doc). The
  // execute-time check below stays as the enforcement backstop.
  if (!lockedResult && contract && LOCKED_MAGIC_ACTIONS.has(payload.action)) {
    const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
    if (lock.locked) {
      const date = fmtDate(lock.until, shop, locale);
      lockedResult = {
        locale,
        ...(await lockedCopy(shop.id, locale, date)),
        portalUrl: (await safePortalUrl(shop.id)) ?? undefined,
      };
    }
  }

  return {
    ...(lockedResult ? { lockedResult } : {}),
    ...(choices ? { choices } : {}),
    action: payload.action,
    locale,
    title: t(
      locale,
      isRestartLink
        ? "magic.confirm.title.APPLY_WINBACK_RESTART"
        : `magic.confirm.title.${payload.action}`,
    ),
    description: t(locale, descKey, vars),
    confirmLabel:
      REDIRECT_ACTIONS.has(payload.action) &&
      !(payload.action === "UPDATE_CARD" && cardUpdateByEmail)
        ? t(locale, "magic.confirm.continue")
        : t(locale, "magic.confirm.button"),
    portalUrl: await safePortalUrl(shop.id),
  };
}

// ── Execution (POST — after verifyAndConsumeMagicToken) ──────────────────────

export interface MagicExecuteInput {
  /** The landing-page choice the customer tapped (EXTEND_PAUSE weeks). */
  choice?: string | null;
}

export async function executeMagicAction(
  payload: MagicPayload,
  input: MagicExecuteInput = {},
): Promise<MagicActionResult> {
  const ctx = await resolveMagicContext(payload);
  const { shop, contract, locale } = ctx;
  const params = parseParams(payload);

  // Audit first: every tapped link leaves a trace, even if the verb fails.
  await logEvent({
    shopId: shop.id,
    contractId: contract?.id ?? null,
    customerId: contract?.customerId ?? payload.customerId ?? null,
    email: contract?.email ?? payload.email ?? null,
    type: "magic.link_used",
    source: "MAGIC_LINK",
    actor: "customer",
    payload: {
      action: payload.action,
      contractId: contract?.id ?? payload.contractId ?? null,
      params: (payload.params ?? {}) as Record<string, unknown>,
    },
  });

  const portalUrl = (await safePortalUrl(shop.id)) ?? undefined;

  // ── Launch gate: a store in SETUP takes no zero-login mutations ────────────
  // Every other customer surface enforces its own SETUP gate (portal
  // dispatcher, jobs, notifications, Klaviyo, buy box). Magic links minted
  // while LIVE sit in inboxes for up to portal.magicLinkTtlDays days, so
  // after an emergency revertToSetup() they would keep mutating live Shopify
  // contracts while everything else is frozen — and goLive()'s overdue
  // stagger would later sweep the result into an unannounced charge. Same
  // terminal-refusal family as rate_limited/locked: the audit event above
  // already recorded the tap, nothing mutates. Hand-off verbs (LOGIN /
  // UPDATE_CARD / CONFIRM_3DS) and PREVIEW stay available — dunning/3DS is
  // gated at its own source, and preview is the whole point of setup mode.
  if (
    MUTATING_MAGIC_ACTIONS.has(payload.action) &&
    (await isSetupMode(shop.id))
  ) {
    return setupGateResult(locale, portalUrl);
  }

  // ── Throttle mutating verbs (insert-then-count) ────────────────────────────
  // Portal POSTs are rate limited per customer; magic links used to bypass
  // that entirely (bounded only by per-token maxUses). The audit event above
  // is ALREADY logged, so this count includes the current tap — concurrent
  // requests each see at least their own row and the ceiling holds without a
  // read-then-act race. LOGIN / card / 3DS hand-offs stay unthrottled.
  if (contract && MUTATING_MAGIC_ACTIONS.has(payload.action)) {
    const portalSettings = await getSetting(shop.id, "portal");
    const recentTaps = await prisma.subscriberEvent.count({
      where: {
        shopId: shop.id,
        contractId: contract.id,
        type: "magic.link_used",
        source: "MAGIC_LINK",
        createdAt: { gte: new Date(Date.now() - 3600_000) },
      },
    });
    if (recentTaps > portalSettings.mutationsPerHour) {
      return {
        locale,
        headline: t(locale, "magic.error.rate_limited"),
        sub: t(locale, "magic.error.rate_limited_sub"),
        portalUrl,
      };
    }
  }

  // ── Plan lock window: reducing verbs refuse at execution time ──────────────
  // Same blocked set as the portal dispatcher. Checked here (not at mint
  // time) because links live in inboxes for up to 14 days — a link minted
  // before the lock mattered must still be refused while the window runs,
  // and one minted during it must work again once the window has passed.
  if (contract && LOCKED_MAGIC_ACTIONS.has(payload.action)) {
    const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
    if (lock.locked) {
      const date = fmtDate(lock.until, shop, locale);
      return {
        locale,
        ...(await lockedCopy(shop.id, locale, date)),
        portalUrl,
      };
    }
  }

  // ── Preparing-your-order window (v1.28.0) — same gate as the portal ──────
  // Contained: isPreparingOrder answers false on any read failure.
  if (contract && PREPARING_MAGIC_ACTIONS.has(payload.action)) {
    const timing = await resolveChargeTiming(shop.id, shop.ianaTimezone);
    if (await isPreparingOrder(contract, timing)) {
      return {
        locale,
        headline: t(locale, "magic.preparing"),
        sub: t(locale, "magic.preparing_sub"),
        portalUrl,
      };
    }
  }

  switch (payload.action) {
    case "SKIP_NEXT": {
      const c = requireContract(ctx);
      const updated = await skipNextCycle(shop.domain, c.id, MAGIC_OPTS);
      const date = fmtDate(updated.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.skip.done"),
        sub: date ? t(locale, "magic.skip.sub", { date }) : undefined,
        undoUrl: await buildUndoUnskipUrl(shop, c),
        portalUrl,
      };
    }

    case "UNSKIP_NEXT": {
      const c = requireContract(ctx);
      const updated = await unskipNextCycle(shop.domain, c.id, MAGIC_OPTS);
      const date = fmtDate(updated.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.unskip.done"),
        sub: date ? t(locale, "magic.unskip.sub", { date }) : undefined,
        portalUrl,
      };
    }

    case "DELAY_NEXT": {
      const c = requireContract(ctx);
      const weeks = clampInt(params.weeks, 1, 26, 1);
      // Same semantics setting as the portal's delay buttons
      // (portal.delayReanchors, v1.28.0): the reminder's one-tap DELAY links
      // and the portal must not disagree about what "delay" means. A failed
      // settings read falls back to the one-cycle delay.
      let portalSettings: { delayReanchors?: boolean } | null = null;
      try {
        portalSettings = await getSetting(shop.id, "portal");
      } catch {
        portalSettings = null;
      }
      const updated =
        delayModeFor(portalSettings, null) === "reanchor"
          ? await delaySchedule(shop.domain, c.id, { weeks }, MAGIC_OPTS)
          : await delayNextCycle(shop.domain, c.id, { weeks }, MAGIC_OPTS);
      const date = fmtDate(updated.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.delay.done", { weeks }),
        sub: date ? t(locale, "magic.delay.sub", { date }) : undefined,
        portalUrl,
      };
    }

    case "ADD_TO_NEXT": {
      const c = requireContract(ctx);
      const variantId = params.variantId;
      if (!variantId) {
        throw new Error("ADD_TO_NEXT magic link is missing params.variantId");
      }
      const updated = await addOneTimeAddon(
        shop.domain,
        c.id,
        variantId,
        1,
        { addedVia: "MAGIC_LINK" },
        MAGIC_OPTS,
      );
      const line = updated.lines.find(
        (l) => l.isOneTimeAddon && l.variantId === variantId,
      );
      const title = line?.title ?? "";
      const date = fmtDate(updated.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.addon.done"),
        sub: date
          ? t(locale, "magic.addon.sub", { title, date })
          : t(locale, "magic.addon.sub_nodate", { title }),
        portalUrl,
      };
    }

    case "PAUSE": {
      const c = requireContract(ctx);
      const months = clampInt(params.months, 1, 6, 1);
      const updated = await pauseContract(shop.domain, c.id, months, MAGIC_OPTS);
      const date = fmtDate(updated.resumeAt, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.pause.done", { months }),
        sub: date
          ? t(locale, "magic.pause.sub", { date })
          : t(locale, "magic.pause.sub_nodate"),
        portalUrl,
      };
    }

    case "RESUME": {
      const c = requireContract(ctx);
      const updated = await resumeContract(shop.domain, c.id, MAGIC_OPTS);
      const date = fmtDate(updated.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.resume.done"),
        sub: date ? t(locale, "magic.resume.sub", { date }) : undefined,
        portalUrl,
      };
    }

    case "EXTEND_PAUSE": {
      // Pause exit ramp (v1.28.0, P2.6): the resume reminder's "need a
      // little longer?" — the customer picked a week choice on the landing
      // page; anything not in the token's own list falls back to the first
      // (smallest) choice, so a tampered form can never extend further than
      // the email offered. Only meaningful while PAUSED with a resume day.
      const c = requireContract(ctx);
      const allowed = allowedExtendWeeks(params);
      const tapped = Number(input.choice);
      const weeks =
        Number.isInteger(tapped) && allowed.includes(tapped)
          ? tapped
          : allowed[0];
      if (c.status !== "PAUSED" || !c.resumeAt) {
        return {
          locale,
          headline: t(locale, "magic.extend_pause.not_paused"),
          sub: t(locale, "magic.extend_pause.not_paused_sub"),
          portalUrl,
        };
      }
      const target = addWeeksTz(c.resumeAt, weeks, shop.ianaTimezone);
      let updated: Awaited<ReturnType<typeof extendPause>>;
      try {
        updated = await extendPause(shop.domain, c.id, target, MAGIC_OPTS);
      } catch (err) {
        // Beyond the maximum hold: honest refusal with the latest allowed
        // day (the service computed it) — never a generic error page.
        if (err instanceof PauseUntilError && err.code === "RESUME_DATE_TOO_FAR") {
          const maxDate = fmtDate(err.maxResumeAt ?? null, shop, locale);
          return {
            locale,
            headline: t(locale, "magic.extend_pause.too_far"),
            sub: maxDate
              ? t(locale, "magic.extend_pause.too_far_sub", { date: maxDate })
              : undefined,
            portalUrl,
          };
        }
        throw err;
      }
      const date = fmtDate(updated.resumeAt, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.extend_pause.done", { weeks }),
        sub: date ? t(locale, "magic.extend_pause.sub", { date }) : undefined,
        portalUrl,
      };
    }

    case "SWAP": {
      const c = requireContract(ctx);
      const variantId = params.variantId;
      if (!variantId) {
        throw new Error("SWAP magic link is missing params.variantId");
      }
      // Explicit line when given; otherwise the first recurring
      // (non-gift, non-addon) line, falling back to the first line at all.
      const line = params.lineId
        ? c.lines.find((l) => l.id === params.lineId)
        : (c.lines.find((l) => !l.isGift && !l.isOneTimeAddon) ?? c.lines[0]);
      if (!line) {
        throw new Error(
          params.lineId
            ? `SWAP magic link line not found on contract: ${params.lineId}`
            : `Contract ${c.id} has no lines to swap`,
        );
      }
      const updated = await swapLineVariant(
        shop.domain,
        c.id,
        line.id,
        variantId,
        MAGIC_OPTS,
      );
      const newLine = updated.lines.find((l) => l.variantId === variantId);
      return {
        locale,
        headline: t(locale, "magic.swap.done"),
        sub: t(locale, "magic.swap.sub", { title: newLine?.title ?? "" }),
        portalUrl,
      };
    }

    case "APPLY_WINBACK":
      return applyWinback(ctx, params, portalUrl);

    case "RETRY_PAYMENT": {
      // Customer "Retry now" from a dunning email (v1.28.0): the engine owns
      // the guards (open case / reopen EXHAUSTED, per-case cooldown, paused
      // and challenge-pending refusals) and the idempotent inline fire.
      const c = requireContract(ctx);
      const { requestCustomerRetry } = await import(
        "~/lib/dunning/engine.server"
      );
      const outcome = await requestCustomerRetry(c.id, {
        source: "MAGIC_LINK",
        actor: "customer",
      });
      return { locale, portalUrl, ...retryOutcomeCopy(locale, outcome) };
    }

    case "CONFIRM_3DS": {
      const redirectUrl = params.redirectUrl;
      if (redirectUrl == null || redirectUrl === "") {
        return {
          locale,
          headline: t(locale, "magic.threeds.missing"),
          sub: t(locale, "magic.threeds.missing_sub"),
          portalUrl,
        };
      }
      if (!isTrustedShopifyRedirect(redirectUrl)) {
        // Refuse anything that is not a Shopify-hosted https page.
        console.error(
          "[magic] CONFIRM_3DS refused untrusted redirect",
          redirectUrl,
        );
        return {
          locale,
          headline: t(locale, "magic.threeds.invalid"),
          sub: t(locale, "magic.threeds.invalid_sub"),
          portalUrl,
        };
      }
      return {
        locale,
        headline: t(locale, "magic.threeds.redirect"),
        redirect: redirectUrl,
        portalUrl,
      };
    }

    case "UPDATE_CARD": {
      const c = requireContract(ctx);
      if (!c.paymentMethodId) {
        return {
          locale,
          headline: t(locale, "magic.card.no_method"),
          sub: t(locale, "magic.card.no_method_sub"),
          portalUrl,
        };
      }
      const admin = await adminClientForShop(shop.domain);
      // ONE server-side decision (app/lib/payments/cardUpdate.server.ts):
      // Shop Pay → hosted secure page; cards / PayPal → Shopify emails the
      // customer its own 48h update link (the hosted page rejects them).
      const path = await resolveCardUpdatePath({
        admin,
        contract: c,
        source: "MAGIC_LINK",
        actor: "customer",
      });
      if (path.kind === "redirect") {
        return {
          locale,
          headline: t(locale, "magic.card.redirect"),
          redirect: path.url,
          portalUrl,
        };
      }
      if (path.kind === "email_sent") {
        return {
          locale,
          headline: t(locale, "magic.update_card.email_sent_title"),
          sub: t(locale, "magic.update_card.email_sent_sub"),
          portalUrl,
        };
      }
      if (path.reason === "payment_method_revoked") {
        return {
          locale,
          headline: t(locale, "magic.update_card.revoked_title"),
          sub: t(locale, "magic.update_card.revoked_sub"),
          portalUrl,
        };
      }
      return {
        locale,
        headline: t(locale, "magic.update_card.unavailable_title"),
        sub: t(locale, "magic.update_card.unavailable_sub"),
        portalUrl,
      };
    }

    case "SET_FREQUENCY":
      return setFrequency(ctx, params, portalUrl);

    case "USE_METHOD":
      return useMethod(ctx, params, portalUrl);

    case "SET_BACKUP":
      return setBackup(ctx, params, portalUrl);

    case "SKIP_FAILED_CYCLE":
      return skipFailedCycle(ctx, portalUrl);

    case "KEEP_SUBSCRIPTION": {
      // Scheduled cancel (v1.28.0, P3.8): the cancel_scheduled /
      // cancel_upcoming emails' one-tap "keep my subscription" — clears
      // cancelScheduledAt (atomic; the hourly job re-reads before it
      // cancels). Honest terminal copy for every state: kept, nothing was
      // scheduled (already kept), or already cancelled (restart instead).
      const c = requireContract(ctx);
      if (c.status === "CANCELLED") {
        return {
          locale,
          headline: t(locale, "magic.keep.already_cancelled"),
          sub: t(locale, "magic.keep.already_cancelled_sub"),
          portalUrl,
        };
      }
      const { keepScheduledCancel } = await import("~/lib/cancel/engine.server");
      const kept = await keepScheduledCancel(c.id, MAGIC_OPTS);
      const date = fmtDate(c.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, kept ? "magic.keep.done" : "magic.keep.nothing_scheduled"),
        sub: date ? t(locale, "magic.keep.sub", { date }) : undefined,
        portalUrl,
      };
    }

    case "CHECKIN":
      return checkin(ctx, payload, params, portalUrl);

    case "LOGIN":
      return login(ctx, payload, portalUrl);

    case "PREVIEW":
      // Storefront preview tokens live in ?cx_preview= URLs and are only ever
      // signature-verified by the app proxy — executing one as a magic verb
      // does nothing and reads as an invalid link.
      return {
        locale,
        headline: t(locale, "magic.error.title"),
        sub: t(locale, "magic.error.invalid"),
        portalUrl,
      };

    default: {
      // Exhaustive switch — a new MagicAction without a handler fails loudly.
      const never: never = payload.action;
      throw new Error(`Unhandled magic action: ${String(never)}`);
    }
  }
}

// ── USE_METHOD (v1.28.0, P1.7) ───────────────────────────────────────────────

/**
 * "Use my card ····1234 instead" from a dunning email: switch the contract's
 * primary to the vaulted method the link carries. Same service the portal's
 * payment_select uses (changePaymentMethod, trigger `select`, source
 * MAGIC_LINK): the id is validated against the customer's live methods
 * there — the token's params are never trusted — and an open dunning case
 * retries immediately. Statuses ACTIVE / PAUSED / FAILED like the portal
 * verb; a cancelled / expired contract gets the restart copy. Refusals map
 * through the same typed-error table as the portal toast.
 */
async function useMethod(
  ctx: MagicContext,
  params: MagicParams,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, locale } = ctx;
  const c = requireContract(ctx);
  const pmId = params.paymentMethodId;
  if (!isPaymentMethodGid(pmId)) {
    return {
      locale,
      headline: t(locale, "magic.error.title"),
      sub: t(locale, "magic.error.invalid"),
      portalUrl,
    };
  }
  if (c.status !== "ACTIVE" && c.status !== "PAUSED" && c.status !== "FAILED") {
    return {
      locale,
      headline: t(locale, "magic.use_method.ended"),
      sub: t(locale, "magic.use_method.ended_sub"),
      portalUrl,
    };
  }
  const label = typeof params.label === "string" ? params.label : "";
  try {
    await changePaymentMethod(shop.domain, c.id, pmId, {
      ...MAGIC_OPTS,
      trigger: "select",
    });
  } catch (err) {
    const toast = paymentMethodErrorToast(err);
    if (toast === "payment_not_on_account") {
      return {
        locale,
        headline: t(locale, "magic.use_method.not_on_account"),
        sub: t(locale, "magic.use_method.not_on_account_sub"),
        portalUrl,
      };
    }
    if (toast) {
      console.warn(`[magic] USE_METHOD refused for contract ${c.id}: ${toast}`);
      return {
        locale,
        headline: t(locale, "magic.use_method.unavailable"),
        sub: t(locale, "magic.use_method.unavailable_sub"),
        portalUrl,
      };
    }
    throw err;
  }
  return {
    locale,
    headline: label
      ? t(locale, "magic.use_method.done", { card: label })
      : t(locale, "magic.use_method.done_generic"),
    sub: t(locale, "magic.use_method.done_sub"),
    portalUrl,
  };
}

// ── SET_BACKUP (v1.28.0, P1.8) ───────────────────────────────────────────────

/**
 * "Keep my card, use ····1234 only if a payment fails" from the
 * new_card_detected email: set the vaulted method the link carries as the
 * contract's BACKUP (setBackupPaymentMethod, setBy CUSTOMER, source
 * MAGIC_LINK — the id is validated against the customer's live methods
 * there; the token's params are never trusted). Statuses ACTIVE / PAUSED /
 * FAILED like USE_METHOD. Honest terminal copy for every refusal: already
 * the primary (nothing to do), not on the account, or the engine is charging
 * the backup right now (try again later).
 */
async function setBackup(
  ctx: MagicContext,
  params: MagicParams,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, locale } = ctx;
  const c = requireContract(ctx);
  const pmId = params.paymentMethodId;
  if (!isPaymentMethodGid(pmId)) {
    return {
      locale,
      headline: t(locale, "magic.error.title"),
      sub: t(locale, "magic.error.invalid"),
      portalUrl,
    };
  }
  if (c.status !== "ACTIVE" && c.status !== "PAUSED" && c.status !== "FAILED") {
    return {
      locale,
      headline: t(locale, "magic.use_method.ended"),
      sub: t(locale, "magic.use_method.ended_sub"),
      portalUrl,
    };
  }
  const label = typeof params.label === "string" ? params.label : "";
  try {
    await setBackupPaymentMethod(shop.domain, c.id, pmId, {
      ...MAGIC_OPTS,
      setBy: "CUSTOMER",
    });
  } catch (err) {
    const toast = paymentMethodErrorToast(err);
    if (toast === "payment_not_on_account") {
      return {
        locale,
        headline: t(locale, "magic.use_method.not_on_account"),
        sub: t(locale, "magic.use_method.not_on_account_sub"),
        portalUrl,
      };
    }
    if (toast === "backup_equals_primary") {
      return {
        locale,
        headline: t(locale, "magic.set_backup.already_primary"),
        sub: t(locale, "magic.set_backup.already_primary_sub"),
        portalUrl,
      };
    }
    if (toast) {
      console.warn(`[magic] SET_BACKUP refused for contract ${c.id}: ${toast}`);
      return {
        locale,
        headline: t(locale, "magic.set_backup.unavailable"),
        sub: t(locale, "magic.set_backup.unavailable_sub"),
        portalUrl,
      };
    }
    throw err;
  }
  return {
    locale,
    headline: label
      ? t(locale, "magic.set_backup.done", { card: label })
      : t(locale, "magic.set_backup.done_generic"),
    sub: t(locale, "magic.set_backup.done_sub"),
    portalUrl,
  };
}

// ── SKIP_FAILED_CYCLE (v1.28.0, P1.9) ────────────────────────────────────────

/**
 * "Skip that order and continue" from a payment_failed_parked email: the
 * same case-aware service as the portal verb (skip-resume.server.ts) —
 * resolves the exhausted case, skips the held cycle on Shopify, reactivates
 * and sets the next date; every refusal is typed and mapped to honest copy
 * (a hard-dead card points at update-card; an attempt in flight says so).
 */
async function skipFailedCycle(
  ctx: MagicContext,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, locale } = ctx;
  const c = requireContract(ctx);
  const { skipFailedCycleAndResume } = await import(
    "~/lib/dunning/skip-resume.server"
  );
  const outcome = await skipFailedCycleAndResume(shop.domain, c.id, MAGIC_OPTS);
  switch (outcome.kind) {
    case "resumed": {
      const date = fmtDate(outcome.nextBillingDate, shop, locale);
      return {
        locale,
        headline: t(locale, "magic.skip_resume.done"),
        sub: date
          ? t(locale, "magic.skip_resume.done_sub", { date })
          : t(locale, "magic.skip_resume.done_sub_nodate"),
        portalUrl,
      };
    }
    case "already_active":
      return {
        locale,
        headline: t(locale, "magic.skip_resume.already_active"),
        sub: t(locale, "magic.skip_resume.already_active_sub"),
        portalUrl,
      };
    case "refused":
    default: {
      const reason = outcome.kind === "refused" ? outcome.reason : "no_case";
      if (reason === "card_revoked" || reason === "card_expired" || reason === "no_card") {
        return {
          locale,
          headline: t(locale, "magic.skip_resume.card_dead"),
          sub: t(locale, "magic.skip_resume.card_dead_sub"),
          portalUrl,
        };
      }
      if (reason === "attempt_in_flight") {
        return {
          locale,
          headline: t(locale, "magic.skip_resume.in_flight"),
          sub: t(locale, "magic.skip_resume.in_flight_sub"),
          portalUrl,
        };
      }
      return {
        locale,
        headline: t(locale, "magic.skip_resume.unavailable"),
        sub: t(locale, "magic.skip_resume.unavailable_sub"),
        portalUrl,
      };
    }
  }
}

// ── RETRY_PAYMENT copy ───────────────────────────────────────────────────────

/** Headline + sub for every customer-retry outcome (shared with the SMS keyword's key family). */
export function retryOutcomeCopy(
  locale: string,
  outcome: import("~/lib/dunning/engine.server").CustomerRetryOutcome,
): { headline: string; sub: string } {
  switch (outcome.kind) {
    case "started":
      return {
        headline: t(locale, "magic.retry.done"),
        sub: t(locale, "magic.retry.done_sub"),
      };
    case "too_soon":
      return {
        headline: t(locale, "magic.retry.too_soon"),
        sub: t(locale, "magic.retry.too_soon_sub"),
      };
    case "unavailable":
      if (outcome.reason === "challenge_pending") {
        return {
          headline: t(locale, "magic.retry.needs_bank"),
          sub: t(locale, "magic.retry.needs_bank_sub"),
        };
      }
      if (outcome.reason === "contract_paused") {
        return {
          headline: t(locale, "magic.retry.paused"),
          sub: t(locale, "magic.retry.paused_sub"),
        };
      }
      if (outcome.reason === "claim_lost") {
        // A concurrent request won the claim — the retry is running.
        return {
          headline: t(locale, "magic.retry.done"),
          sub: t(locale, "magic.retry.done_sub"),
        };
      }
      return {
        headline: t(locale, "magic.retry.none"),
        sub: t(locale, "magic.retry.none_sub"),
      };
    case "no_case":
    default:
      return {
        headline: t(locale, "magic.retry.none"),
        sub: t(locale, "magic.retry.none_sub"),
      };
  }
}

// ── SKIP undo link ───────────────────────────────────────────────────────────

async function buildUndoUnskipUrl(
  shop: Shop,
  contract: ContractWithLines,
): Promise<string | undefined> {
  try {
    const portalSettings = await getSetting(shop.id, "portal");
    return await buildMagicUrl({
      action: "UNSKIP_NEXT",
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      ttlSeconds: portalSettings.magicLinkTtlDays * 24 * 3600,
      createdVia: "MAGIC_LINK",
    });
  } catch (err) {
    // An undo link must never break the action that succeeded.
    console.error("[magic] undo link build failed", contract.id, err);
    return undefined;
  }
}

// ── APPLY_WINBACK ────────────────────────────────────────────────────────────

/**
 * Short per-contract memo of the derived restart offer for the GET confirm
 * page (v1.28.0 audit): the unauthenticated describe path used to run the
 * gift truth gate (an Admin `nodes` query for a perk-stage offer) on EVERY
 * fetch of the same token — inbox scanners prefetch magic GETs several
 * times, and one token can be fetched without limit before its single POST
 * use. Execution (POST) always derives fresh: the memo only saves reads,
 * never decides what the tap applies.
 */
const RESTART_OFFER_MEMO_TTL_MS = 60_000;
const RESTART_OFFER_MEMO_MAX = 2_000;
const restartOfferMemo = new Map<string, { at: number; offer: WinbackOffer | null }>();

/** Tests only. */
export function _resetRestartOfferMemo(): void {
  restartOfferMemo.clear();
}

/**
 * The offer a restart link would apply right now (restart.server.ts rules),
 * with the admin client for the gift truth gate when it can be built.
 * Contained: null (plain restart) on any failure — never a blocked restart.
 * `memo` = the describe (GET) path: a fresh derivation is reused for 60 s.
 */
async function deriveRestartOffer(
  shop: Shop,
  contract: ContractWithLines,
  opts: { memo?: boolean } = {},
): Promise<WinbackOffer | null> {
  const nowMs = Date.now();
  if (opts.memo) {
    const hit = restartOfferMemo.get(contract.id);
    if (hit && nowMs - hit.at < RESTART_OFFER_MEMO_TTL_MS) return hit.offer;
  }
  try {
    const { deriveCurrentWinbackOffer } = await import(
      "~/lib/winback/restart.server"
    );
    let admin: Awaited<ReturnType<typeof adminClientForShop>> | null = null;
    try {
      admin = await adminClientForShop(shop.domain);
    } catch {
      admin = null;
    }
    const offer = await deriveCurrentWinbackOffer(contract, { admin });
    if (opts.memo) {
      if (restartOfferMemo.size >= RESTART_OFFER_MEMO_MAX) {
        for (const [key, entry] of restartOfferMemo) {
          if (nowMs - entry.at >= RESTART_OFFER_MEMO_TTL_MS) restartOfferMemo.delete(key);
        }
        if (restartOfferMemo.size >= RESTART_OFFER_MEMO_MAX) {
          const oldest = restartOfferMemo.keys().next().value;
          if (oldest !== undefined) restartOfferMemo.delete(oldest);
        }
      }
      restartOfferMemo.set(contract.id, { at: nowMs, offer });
    }
    return offer;
  } catch (err) {
    console.error("[magic] restart offer derivation failed", contract.id, err);
    return null;
  }
}

async function applyWinback(
  ctx: MagicContext,
  params: MagicParams,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, locale } = ctx;
  const contract = requireContract(ctx);

  if (contract.status !== "CANCELLED") {
    return {
      locale,
      headline: t(locale, "magic.winback.already_active"),
      sub: t(locale, "magic.winback.already_active_sub"),
      portalUrl,
    };
  }

  const winbackSettings = await getSetting(shop.id, "winback");

  // One-tap restart link (v1.28.0, P3.2 / P3.5): the minted params carry no
  // offer — apply the CURRENT one, re-derived server-side by the same rules
  // and TTLs the emailed perk / discount legs use (parity with the portal's
  // Restart). Null offer = plain restart, exactly the pre-1.28 behaviour.
  let gift: boolean;
  let percent: number;
  let cycles: number;
  if (params.restart === true) {
    const offer = await deriveRestartOffer(shop, contract);
    gift = offer?.kind === "GIFT";
    percent = offer?.kind === "DISCOUNT" ? offer.percent : 0;
    cycles = offer?.kind === "DISCOUNT" ? offer.cycles : winbackSettings.discountCycles;
  } else {
    // Perk-stage links promise a GIFT and carry { percent: 0, gift: true } —
    // percent < 1 means "no discount" and must NOT be clamped up to 1%. Only
    // a link that actually promises a discount (percent >= 1) grants one.
    gift = params.gift === true;
    const rawPercent =
      typeof params.percent === "number" && Number.isFinite(params.percent)
        ? Math.floor(params.percent)
        : null;
    percent =
      rawPercent == null
        ? gift
          ? 0
          : winbackSettings.discountPct
        : rawPercent < 1
          ? 0
          : clampInt(rawPercent, 1, 90, winbackSettings.discountPct);
    cycles = clampInt(params.cycles, 1, 12, winbackSettings.discountCycles);
  }

  // Prefer the win-back engine's own reactivation (it owns WinbackState and
  // its event choreography). Fall back to the service-layer primitives when
  // the engine does not expose it.
  const engine = (await import("~/lib/winback/engine.server")) as unknown as {
    reactivateFromWinback?: (
      contractLocalId: string,
      input?: { percent?: number; cycles?: number; gift?: boolean },
      options?: { source?: string; actor?: string | null },
    ) => Promise<unknown>;
  };

  if (typeof engine.reactivateFromWinback === "function") {
    await engine.reactivateFromWinback(
      contract.id,
      { percent, cycles, gift },
      MAGIC_OPTS,
    );
  } else {
    // Activate + bill soon, then grant the promised discount (if any).
    await resumeContract(shop.domain, contract.id, MAGIC_OPTS);
    if (percent >= 1) {
      await applyDiscountGrant(
        shop.domain,
        contract.id,
        {
          type: "WINBACK",
          percent,
          cycles,
          grantedBy: "winback_engine",
          reason: "magic_link_winback",
        },
        MAGIC_OPTS,
      );
    }
    try {
      await prisma.winbackState.updateMany({
        where: { contractId: contract.id, status: "ACTIVE" },
        data: { status: "WON_BACK", wonBackAt: new Date() },
      });
    } catch (err) {
      console.error("[magic] winback state update failed", contract.id, err);
    }
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "winback.reactivated",
      source: "MAGIC_LINK",
      actor: "customer",
      payload: { percent, cycles: percent >= 1 ? cycles : 0, gift, via: "magic_link" },
    });
  }

  const updated = await prisma.subscriptionContract.findUnique({
    where: { id: contract.id },
  });
  const date = fmtDate(updated?.nextBillingDate, shop, locale);

  // Confirm exactly what was promised: gift copy for perk-stage links, the
  // discount line only when a discount was actually granted.
  const sub =
    percent >= 1
      ? t(locale, "magic.winback.sub", { percent, cycles, date: date || "—" })
      : gift
        ? t(locale, "magic.winback.sub_gift", { date: date || "—" })
        : t(locale, "magic.winback.sub_nodiscount", { date: date || "—" });

  return {
    locale,
    headline: t(locale, "magic.winback.done"),
    sub,
    portalUrl,
  };
}

// ── LOGIN ────────────────────────────────────────────────────────────────────

/**
 * LOGIN never puts the portal session token in a URL or a JS-readable cookie.
 * The session token is a bearer credential valid for portal.sessionTtlDays,
 * and the portal renders inside the merchant's theme next to third-party
 * storefront scripts — a token in ?session= would sit in proxy/CDN access
 * logs, browser history and document.URL, and a document.cookie-set copy can
 * never be HttpOnly.
 *
 * Instead the browser is 303-redirected with a SINGLE-USE, 60-second hand-off
 * code (?handoff=), which the portal home loader exchanges server-side
 * (exchangeLoginHandoff) for the HttpOnly+Secure cx_portal cookie — the same
 * cookie the OTP login sets — and then redirects to a clean URL.
 */
/**
 * CHECKIN (v1.28.0, P4.1): the routine check-in email's one-tap answer.
 * Not a contract mutation — it logs `lifecycle.checkin_answered {answer}`
 * (analytics + Klaviyo metric) and lands the customer on THEIR subscription
 * page via the LOGIN hand-off (HttpOnly cookie, single-use code) with a
 * toast; "Not sure yet" also carries `checkin=unsure` so the page leads
 * with the timeline card and the education card. Multi-use token (an
 * answer tapped twice is the same answer): the event dedupes nothing —
 * every tap is a data point, the readout takes the first per contract.
 */
async function checkin(
  ctx: MagicContext,
  payload: MagicPayload,
  params: MagicParams,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, contract, locale } = ctx;
  const c = requireContract(ctx);
  const answer: "great" | "unsure" = params.answer === "unsure" ? "unsure" : "great";
  await logEvent({
    shopId: shop.id,
    contractId: c.id,
    customerId: c.customerId,
    email: c.email,
    type: "lifecycle.checkin_answered",
    source: "MAGIC_LINK",
    actor: "customer",
    payload: { answer, via: "routine_checkin" },
  });
  const email = contract?.email ?? payload.email;
  const customerId = contract?.customerId ?? payload.customerId;
  if (!email || !customerId) {
    throw new Error("CHECKIN magic link is missing a customer identity");
  }
  const handoff = await createMagicToken({
    action: "LOGIN",
    contractId: c.id,
    customerId,
    email,
    params: { handoff: true },
    ttlSeconds: LOGIN_HANDOFF_TTL_SECONDS,
    maxUses: 1,
    createdVia: "LOGIN_HANDOFF",
  });
  const base = portalUrl ?? (await buildPortalUrl(shop.id, "/"));
  const next = `/subscription/${c.id}?toast=checkin_${answer}&checkin=${answer}`;
  const redirectUrl = `${base}${base.includes("?") ? "&" : "?"}handoff=${handoff}&next=${encodeURIComponent(next)}`;
  return {
    locale,
    headline: t(locale, answer === "unsure" ? "magic.checkin.done_unsure" : "magic.checkin.done_great"),
    redirect: redirectUrl,
    portalUrl,
  };
}

async function login(
  ctx: MagicContext,
  payload: MagicPayload,
  portalUrl: string | undefined,
): Promise<MagicActionResult> {
  const { shop, contract, locale } = ctx;

  const email = contract?.email ?? payload.email;
  const customerId = contract?.customerId ?? payload.customerId;
  if (!email || !customerId) {
    throw new Error("LOGIN magic link is missing a customer identity");
  }

  // Admin preview links carry params.preview — the session renders the full
  // portal but every mutating action is intercepted before it executes.
  const isPreview = payload.params?.preview === true;

  const handoff = await createMagicToken({
    action: "LOGIN",
    contractId: contract?.id,
    customerId,
    email,
    params: { handoff: true, ...(isPreview ? { preview: true } : {}) },
    ttlSeconds: LOGIN_HANDOFF_TTL_SECONDS,
    maxUses: 1,
    createdVia: "LOGIN_HANDOFF",
  });

  const base = portalUrl ?? (await buildPortalUrl(shop.id, "/"));
  let redirectUrl = `${base}${base.includes("?") ? "&" : "?"}handoff=${handoff}`;

  if (isPreview) {
    // Straggler support for pre-1.7.0 admin preview links: on a live store
    // Shopify's app proxy strips Set-Cookie, so the hand-off exchange above
    // can never leave a session in the browser. Append the stateless ?cx_pp=
    // preview token (the 1.7.0 preview identity) alongside the hand-off so
    // the portal still opens there; in the local harness the cookie continues
    // to work and the token is simply redundant.
    const { mintPreviewToken, PORTAL_PREVIEW_TTL_SECONDS, PREVIEW_TOKEN_PARAM } =
      await import("~/lib/portal/previewToken.server");
    const previewToken = mintPreviewToken(
      {
        shopId: shop.id,
        customerId,
        contractId: contract?.id ?? null,
        email,
      },
      PORTAL_PREVIEW_TTL_SECONDS,
    );
    redirectUrl += `&${PREVIEW_TOKEN_PARAM}=${previewToken}`;
  }

  return {
    locale,
    headline: t(locale, "magic.login.done"),
    redirect: redirectUrl,
    portalUrl,
  };
}
