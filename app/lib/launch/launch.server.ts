import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { setShopMetafield } from "~/lib/graphql/metafields.server";
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

/**
 * Mirror the launch mode into the cellexia.launch_status shop metafield so
 * Liquid can gate rendering. Never throws — a metafield sync failure must
 * never break install or the go-live action (the app-side gates still hold).
 */
export async function syncLaunchMetafield(
  shopDomain: string,
  mode: LaunchMode,
): Promise<void> {
  try {
    const admin = await adminClientForShop(shopDomain);
    await setShopMetafield(admin, {
      namespace: LAUNCH_METAFIELD_NAMESPACE,
      key: LAUNCH_METAFIELD_KEY,
      type: "single_line_text_field",
      value: mode.toLowerCase(),
    });
  } catch (err) {
    console.error("[launch] launch_status metafield sync failed", shopDomain, err);
  }
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
  await syncLaunchMetafield(shopDomain, "LIVE");

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

/** Back to SETUP (dark): setting + metafield + audit event. */
export async function revertToSetup(
  shopDomain: string,
  actor: string,
): Promise<void> {
  const shop = await requireShop(shopDomain);
  const state = await getLaunchState(shop.id);
  await setSetting(shop.id, "launch", { ...state, mode: "SETUP" }, actor);
  await syncLaunchMetafield(shopDomain, "SETUP");
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
