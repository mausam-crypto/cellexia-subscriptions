import { z } from "zod";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { normalizeLocale, t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { createMagicToken, type MagicPayload } from "~/lib/crypto/tokens.server";
import { buildMagicUrl, buildPortalUrl } from "~/lib/magiclinks/builder.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { adminClientForShop } from "~/shopify.server";
import { getPaymentMethodUpdateUrl } from "~/lib/graphql/index.server";
import {
  addOneTimeAddon,
  applyDiscountGrant,
  delayNextCycle,
  pauseContract,
  resumeContract,
  skipNextCycle,
  swapLineVariant,
  unskipNextCycle,
} from "~/lib/contracts/service.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import { isSetupMode } from "~/lib/launch/launch.server";

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
    redirectUrl: z.string().nullable().optional(),
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

/** Only https URLs on shopify.com / myshopify.com (dot-boundary) may be handed off. */
export function isTrustedShopifyRedirect(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "shopify.com" ||
    host.endsWith(".shopify.com") ||
    host === "myshopify.com" ||
    host.endsWith(".myshopify.com")
  );
}

// ── Confirmation-page description (GET — read-only) ──────────────────────────

const REDIRECT_ACTIONS = new Set<MagicPayload["action"]>([
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
  "SWAP",
  "APPLY_WINBACK",
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
  "SWAP",
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
  };

  // Perk-stage winback links promise a GIFT, not a discount — the confirm
  // page must promise exactly what executing the link grants.
  const descKey =
    payload.action === "APPLY_WINBACK" && params.gift === true
      ? "magic.confirm.desc.APPLY_WINBACK_GIFT"
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
    action: payload.action,
    locale,
    title: t(locale, `magic.confirm.title.${payload.action}`),
    description: t(locale, descKey, vars),
    confirmLabel: REDIRECT_ACTIONS.has(payload.action)
      ? t(locale, "magic.confirm.continue")
      : t(locale, "magic.confirm.button"),
    portalUrl: await safePortalUrl(shop.id),
  };
}

// ── Execution (POST — after verifyAndConsumeMagicToken) ──────────────────────

export async function executeMagicAction(
  payload: MagicPayload,
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
      const updated = await delayNextCycle(
        shop.domain,
        c.id,
        { weeks },
        MAGIC_OPTS,
      );
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
      const url = await getPaymentMethodUpdateUrl(admin, c.paymentMethodId);
      return {
        locale,
        headline: t(locale, "magic.card.redirect"),
        redirect: url,
        portalUrl,
      };
    }

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

  // Perk-stage links promise a GIFT and carry { percent: 0, gift: true } —
  // percent < 1 means "no discount" and must NOT be clamped up to 1%. Only a
  // link that actually promises a discount (percent >= 1) grants one.
  const gift = params.gift === true;
  const rawPercent =
    typeof params.percent === "number" && Number.isFinite(params.percent)
      ? Math.floor(params.percent)
      : null;
  const percent =
    rawPercent == null
      ? gift
        ? 0
        : winbackSettings.discountPct
      : rawPercent < 1
        ? 0
        : clampInt(rawPercent, 1, 90, winbackSettings.discountPct);
  const cycles = clampInt(params.cycles, 1, 12, winbackSettings.discountCycles);

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
