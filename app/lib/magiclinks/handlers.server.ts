import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { normalizeLocale, t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { sha256, type MagicPayload } from "~/lib/crypto/tokens.server";
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
  /** Set-Cookie header value to attach to the response (LOGIN). */
  setCookie?: string;
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

export const PORTAL_SESSION_COOKIE = "cellexia_portal_session";

// ── Param parsing ────────────────────────────────────────────────────────────

const magicParamsSchema = z
  .object({
    weeks: z.number().optional(),
    months: z.number().optional(),
    variantId: z.string().optional(),
    lineId: z.string().optional(),
    percent: z.number().optional(),
    cycles: z.number().optional(),
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
  } else if (payload.email) {
    // LOGIN links may carry only an email; anchor on the newest contract.
    contract = await prisma.subscriptionContract.findFirst({
      where: { email: payload.email },
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

  return {
    action: payload.action,
    locale,
    title: t(locale, `magic.confirm.title.${payload.action}`),
    description: t(locale, `magic.confirm.desc.${payload.action}`, vars),
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
  const percent = clampInt(params.percent, 1, 90, winbackSettings.discountPct);
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
      { percent, cycles },
      MAGIC_OPTS,
    );
  } else {
    // Activate + bill soon, then grant the promised discount.
    await resumeContract(shop.domain, contract.id, MAGIC_OPTS);
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
      payload: { percent, cycles, via: "magic_link" },
    });
  }

  const updated = await prisma.subscriptionContract.findUnique({
    where: { id: contract.id },
  });
  const date = fmtDate(updated?.nextBillingDate, shop, locale);

  return {
    locale,
    headline: t(locale, "magic.winback.done"),
    sub: t(locale, "magic.winback.sub", {
      percent,
      cycles,
      date: date || "—",
    }),
    portalUrl,
  };
}

// ── LOGIN ────────────────────────────────────────────────────────────────────

function portalSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${PORTAL_SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
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

  const portalSettings = await getSetting(shop.id, "portal");
  const ttlSeconds = portalSettings.sessionTtlDays * 24 * 3600;

  // Admin preview links carry params.preview — the session renders the full
  // portal but every mutating action is intercepted before it executes.
  const isPreview = payload.params?.preview === true;

  // Raw token only ever lives in the redirect/cookie; the DB stores its hash.
  const raw = crypto.randomBytes(32).toString("base64url");
  await prisma.portalSession.create({
    data: {
      tokenHash: sha256(raw),
      customerId,
      email,
      shopId: shop.id,
      isPreview,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  });

  await logEvent({
    shopId: shop.id,
    contractId: contract?.id ?? null,
    customerId,
    email,
    type: "portal.login",
    source: "MAGIC_LINK",
    actor: "customer",
    payload: { via: "magic_link", ...(isPreview ? { preview: true } : {}) },
  });

  // The portal is served on the store domain through the app proxy (which
  // strips Set-Cookie), so the session token also rides along as a query
  // param for the portal to adopt; the cookie covers same-domain setups.
  const base = portalUrl ?? (await buildPortalUrl(shop.id, "/"));
  const redirectUrl = `${base}${base.includes("?") ? "&" : "?"}session=${raw}`;

  return {
    locale,
    headline: t(locale, "magic.login.done"),
    redirect: redirectUrl,
    setCookie: portalSessionCookie(raw, ttlSeconds),
    portalUrl,
  };
}
