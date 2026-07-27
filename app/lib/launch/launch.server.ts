import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import {
  getShopMetafield,
  setShopMetafield,
} from "~/lib/graphql/metafields.server";
import { createMagicToken } from "~/lib/crypto/tokens.server";
import { addDaysTz } from "~/lib/dates.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Launch mode — the install-dark contract every customer-facing gate imports.
 *
 * A fresh install starts in SETUP: customer-facing jobs are skipped, customer
 * notifications and Klaviyo events are suppressed at source, the public portal
 * is closed and the buy-box block renders hidden. Nothing on the live store
 * changes until the merchant explicitly goes live here. The shop metafield
 * cellexia.launch_status ("setup" | "live") mirrors the mode for Liquid.
 *
 * Storefront preview happens through a signed PREVIEW magic token appended to
 * a product URL (?cx_preview=<token>): the buy-box block validates it via the
 * app proxy and reveals itself only in that admin's own browser session.
 */

export type LaunchState = SettingsValue<"launch">;
export type LaunchMode = LaunchState["mode"];

/** Checklist booleans an admin (or a preview action) can tick individually. */
export type LaunchChecklistField =
  | "confirmedThemeBlock"
  | "confirmedKlaviyo"
  | "previewedStorefront"
  | "previewedPortal";

export const LAUNCH_METAFIELD_NAMESPACE = "cellexia";
export const LAUNCH_METAFIELD_KEY = "launch_status";

const PREVIEW_TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const PREVIEW_TOKEN_MAX_USES = 500;
/** Overdue charges are spread over the next N days when going live. */
const GO_LIVE_STAGGER_DAYS = 3;

// ── State reads ──────────────────────────────────────────────────────────────

export async function getLaunchState(shopId: string): Promise<LaunchState> {
  return getSetting(shopId, "launch");
}

export async function isLive(shopId: string): Promise<boolean> {
  return (await getLaunchState(shopId)).mode === "LIVE";
}

export async function isSetupMode(shopId: string): Promise<boolean> {
  return (await getLaunchState(shopId)).mode === "SETUP";
}

// ── Metafield mirror ─────────────────────────────────────────────────────────

/** Outcome of a launch_status metafield write — never an exception. */
export interface LaunchSyncResult {
  ok: boolean;
  /** Failure reason, for the admin toast / audit payload. */
  error?: string;
}

/**
 * Mirror the launch mode into the cellexia.launch_status shop metafield so
 * Liquid can gate rendering. Never throws — install must not fail because a
 * metafield write failed — but it does REPORT: this metafield is the only
 * thing the storefront reads, so a caller that changes the launch mode has to
 * know whether the storefront actually followed (goLive/revertToSetup roll
 * their setting back when it did not). Fire-and-forget callers (install)
 * simply ignore the result; the Preview & launch page reads the flag back and
 * offers a re-sync.
 */
export async function syncLaunchMetafield(
  shopDomain: string,
  mode: LaunchMode,
): Promise<LaunchSyncResult> {
  try {
    const admin = await adminClientForShop(shopDomain);
    await setShopMetafield(admin, {
      namespace: LAUNCH_METAFIELD_NAMESPACE,
      key: LAUNCH_METAFIELD_KEY,
      type: "single_line_text_field",
      value: mode.toLowerCase(),
    });
    return { ok: true };
  } catch (err) {
    console.error("[launch] launch_status metafield sync failed", shopDomain, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The launch_status metafield as Liquid sees it ("setup" | "live" | null when
 * it was never written). Throws on a read failure — callers decide whether a
 * failed read is fatal (the Preview page contains it and shows nothing).
 */
export async function readLaunchMetafield(
  admin: AdminClient,
): Promise<string | null> {
  const metafield = await getShopMetafield(
    admin,
    LAUNCH_METAFIELD_NAMESPACE,
    LAUNCH_METAFIELD_KEY,
  );
  return metafield ? metafield.value : null;
}

/**
 * Does the storefront flag disagree with the launch mode?
 *
 * Compared BYTE-FOR-BYTE the way the buy box compares it. The gate in
 * cx-buybox-core.liquid is
 *
 *     assign cx_launch_status = shop.metafields.cellexia.launch_status.value …
 *     if cx_launch_status == 'live'
 *
 * — a plain Liquid string equality: no trim, no case folding. ONLY the exact
 * value "live" renders the widget; anything else (missing metafield included)
 * fails closed. So a missing flag while in SETUP is not a divergence — the
 * store is dark either way — but a "live" flag while in SETUP is, and so is
 * any non-"live" flag while LIVE.
 *
 * This comparison must therefore NOT normalise. It used to `.trim()` and
 * `.toLowerCase()`, which made the detector blind in the one direction that
 * matters: a hand-edited metafield of " Live " with the app in LIVE was
 * reported as in-sync, while Liquid read it as not-live and every product
 * page rendered the widget `hidden data-cellexia-gated`. The merchant saw a
 * green "Live" page over a dark store — exactly the state the banner on
 * app/routes/app.preview.tsx exists to surface. Normalising here can only
 * ever hide a dark store; being stricter can only ever offer a re-sync that
 * rewrites the flag to the canonical value. Keep it exact.
 */
export function launchFlagDiverged(
  mode: LaunchMode,
  metafieldValue: string | null,
): boolean {
  const storefrontLive = metafieldValue === "live";
  return storefrontLive !== (mode === "LIVE");
}

// ── Checklist ────────────────────────────────────────────────────────────────

/** Partial update of one launch-checklist boolean (read-modify-write). */
export async function markChecklist(
  shopId: string,
  field: LaunchChecklistField,
  value: boolean,
  updatedBy?: string,
): Promise<LaunchState> {
  const state = await getLaunchState(shopId);
  if (state[field] === value) return state;
  const next: LaunchState = { ...state, [field]: value };
  await setSetting(shopId, "launch", next, updatedBy);
  return next;
}

// ── Go-live ──────────────────────────────────────────────────────────────────

export interface OverdueContract {
  id: string;
  shopifyContractId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  nextBillingDate: Date;
}

/**
 * ACTIVE contracts whose nextBillingDate is already in the past — the ones the
 * billing sweep would charge in a burst the moment the app goes live. The
 * go-live modal lists them and offers to stagger them instead.
 */
export async function getOverdueContracts(
  shopId: string,
): Promise<OverdueContract[]> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      isDemo: false,
      nextBillingDate: { not: null, lt: new Date() },
    },
    orderBy: { nextBillingDate: "asc" },
    select: {
      id: true,
      shopifyContractId: true,
      email: true,
      firstName: true,
      lastName: true,
      nextBillingDate: true,
    },
  });
  return contracts.filter(
    (c): c is OverdueContract => c.nextBillingDate !== null,
  );
}

/**
 * Pure stagger math for the go-live overdue shift: contract i's new billing
 * date lands tomorrow / +2d / +3d (round-robin over GO_LIVE_STAGGER_DAYS),
 * anchored to the shop-timezone calendar. Never today, never in the past —
 * going live must not trigger a burst of charges.
 */
export function computeStaggeredDates(
  count: number,
  tz: string,
  from: Date,
): Date[] {
  return Array.from({ length: count }, (_, index) =>
    addDaysTz(from, 1 + (index % GO_LIVE_STAGGER_DAYS), tz),
  );
}

export interface GoLiveOptions {
  /** Spread overdue renewals over the next 3 days instead of charging at once. */
  shiftOverdue: boolean;
  /** Admin identity for the audit trail (setting.updatedBy + event actor). */
  actor: string;
}

/**
 * Flip the shop LIVE: setting + metafield + audit event. With `shiftOverdue`,
 * every overdue contract's next billing date moves to tomorrow / +1d / +2d
 * (round-robin, shop timezone) so going live never triggers a burst of
 * charges. Shift failures are contained per contract — going live must not
 * abort halfway because one contract edit failed.
 *
 * The metafield write is NOT contained: it is the only signal the storefront
 * has, so if it fails the setting is rolled back and the error rethrown (the
 * design-publish contract in app/lib/widget/design.server.ts). Otherwise the
 * admin would see "You're live" while every product page still renders the
 * widget hidden — a go-live that lied, with nothing to detect it. The
 * metafield is written BEFORE any contract is touched, so a failed go-live
 * never leaves shifted billing dates behind either.
 */
export async function goLive(
  shopDomain: string,
  options: GoLiveOptions,
): Promise<{ shifted: number }> {
  const shop = await requireShop(shopDomain);
  const now = new Date();

  const state = await getLaunchState(shop.id);
  await setSetting(
    shop.id,
    "launch",
    { ...state, mode: "LIVE", wentLiveAt: now.toISOString() },
    options.actor,
  );
  const sync = await syncLaunchMetafield(shopDomain, "LIVE");
  if (!sync.ok) {
    // Roll back so the app never claims to be live while the storefront is
    // dark; the admin gets a real error and can retry.
    await setSetting(shop.id, "launch", state, options.actor);
    throw new Error(
      `Storefront flag not updated (cellexia.launch_status): ${sync.error ?? "unknown error"}. Nothing was changed — retry.`,
    );
  }

  let shifted = 0;
  if (options.shiftOverdue) {
    const overdue = await getOverdueContracts(shop.id);
    const targets = computeStaggeredDates(
      overdue.length,
      shop.ianaTimezone,
      now,
    );
    const { setNextBillingDate } = await import(
      "~/lib/contracts/service.server"
    );
    for (const [index, contract] of overdue.entries()) {
      try {
        await setNextBillingDate(shopDomain, contract.id, targets[index], {
          source: "ADMIN",
          actor: options.actor,
        });
        shifted += 1;
      } catch (err) {
        console.error("[launch] overdue shift failed", contract.id, err);
      }
    }
  }

  await logEvent({
    shopId: shop.id,
    type: "admin.action",
    source: "ADMIN",
    actor: options.actor,
    payload: {
      action: "go_live",
      shiftOverdue: options.shiftOverdue,
      shifted,
      wentLiveAt: now.toISOString(),
    },
  });

  return { shifted };
}

/**
 * Back to SETUP (dark): setting + metafield + audit event.
 *
 * Same contract as goLive, and it matters more here: this is the kill switch.
 * If the metafield write fails the setting is rolled back to LIVE and the
 * error rethrown, because the alternative — app-side dark, storefront still
 * selling subscriptions — is worse than an honest failure the admin can
 * retry (or work around by switching the app embed off in the theme editor).
 */
export async function revertToSetup(
  shopDomain: string,
  actor: string,
): Promise<void> {
  const shop = await requireShop(shopDomain);
  const state = await getLaunchState(shop.id);
  await setSetting(shop.id, "launch", { ...state, mode: "SETUP" }, actor);
  const sync = await syncLaunchMetafield(shopDomain, "SETUP");
  if (!sync.ok) {
    await setSetting(shop.id, "launch", state, actor);
    throw new Error(
      `Storefront flag not updated (cellexia.launch_status): ${sync.error ?? "unknown error"}. The store is still live — retry, or switch the Cellexia app embed off in the theme editor.`,
    );
  }
  await logEvent({
    shopId: shop.id,
    type: "admin.action",
    source: "ADMIN",
    actor,
    payload: { action: "revert_to_setup" },
  });
}

// ── Storefront preview ───────────────────────────────────────────────────────

/**
 * Signed PREVIEW token for the storefront buy-box reveal. Only ever
 * signature-verified (never consumed) so the admin can browse PDP → cart
 * freely; the DB row exists purely for audit. TTL 7 days.
 */
export async function buildStorefrontPreviewToken(
  shopId: string,
): Promise<string> {
  return createMagicToken({
    action: "PREVIEW",
    params: { shopId },
    ttlSeconds: PREVIEW_TOKEN_TTL_SECONDS,
    maxUses: PREVIEW_TOKEN_MAX_USES,
    createdVia: "ADMIN",
  });
}

/**
 * Storefront preview URL on the live theme: a PDP when a product handle is
 * given, otherwise the home page. The ?cx_preview token makes the buy-box
 * block reveal itself in the admin's browser session only.
 */
export async function buildStorefrontPreviewUrl(
  shopId: string,
  productHandle?: string,
): Promise<string> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const host = shop?.primaryDomain ?? shop?.domain;
  if (!host) throw new Error("No shop domain available for preview URL");

  const token = await buildStorefrontPreviewToken(shopId);
  const path = productHandle
    ? `/products/${encodeURIComponent(productHandle)}`
    : "/";
  return `https://${host}${path}?cx_preview=${encodeURIComponent(token)}`;
}
