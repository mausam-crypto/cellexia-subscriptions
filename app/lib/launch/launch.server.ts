import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import {
  getShopMetafield,
  setShopMetafield,
} from "~/lib/graphql/metafields.server";
import {
  OURS_ONLY,
  publishOwnGroupsMetafield,
  reclassifyAllContracts,
  type ReclassifyResult,
} from "~/lib/ownership/ownership.server";
import { createMagicToken } from "~/lib/crypto/tokens.server";
import { addDaysTz } from "~/lib/dates.server";
import { logEvent } from "~/lib/events/log.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

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
/** Proxy-identity probe: short-lived token + short fetch timeout (see below). */
const PROXY_PROBE_TOKEN_TTL_SECONDS = 120;
const PROXY_PROBE_TIMEOUT_MS = 5000;
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

/** The Setting row every launch writer targets (settings registry key). */
const LAUNCH_SETTING_KEY = "launch";

/**
 * How many lost compare-and-swap races markChecklist retries before falling
 * back to the plain validated write. Two concurrent writers (a preview action
 * ticking its box and the go-live modal) is the realistic ceiling; exhausting
 * this many attempts means the stored row's raw `mode` can never equal its
 * parsed form — a junk value getLaunchState papers over with the default.
 */
const MARK_CHECKLIST_MAX_RETRIES = 3;

/**
 * Partial update of one launch-checklist boolean.
 *
 * INVARIANT: ticking a checklist box must never move `mode`. This used to be
 * a plain read-modify-write (getLaunchState → spread → setSetting), so a
 * goLive() committing between the read and the write was clobbered back to
 * SETUP by the stale snapshot — after which goLive still pushed "live" into
 * the cellexia.launch_status metafield: the storefront widget selling
 * subscriptions while billing, dunning and notifications stay gated dark,
 * exactly the diverged-flag direction the Preview & launch banner and the
 * launch_flag self-check exist to catch. The race is reachable: the preview
 * actions (which tick previewedStorefront/previewedPortal) and the go-live
 * modal are independent fetchers the same admin can have in flight at once.
 *
 * The write is therefore enforced AT the database (the monotonic-ownership
 * pattern in app/lib/contracts/sync.server.ts): a conditional update that
 * only lands while the stored `mode` still equals the mode this snapshot was
 * computed from. A lost race re-reads and re-applies the one field on the
 * fresh value — the mode flip always wins, the checkbox never does.
 */
export async function markChecklist(
  shopId: string,
  field: LaunchChecklistField,
  value: boolean,
  updatedBy?: string,
): Promise<LaunchState> {
  for (let attempt = 0; attempt < MARK_CHECKLIST_MAX_RETRIES; attempt++) {
    const state = await getLaunchState(shopId);
    if (state[field] === value) return state;
    const next: LaunchState = { ...state, [field]: value };
    // Same validation setSetting would run — the direct row writes below
    // must never store a value getSetting's schema would reject as junk.
    const validated = settingsSchemas[LAUNCH_SETTING_KEY].parse(next);

    const row = await prisma.setting.findUnique({
      where: { shopId_key: { shopId, key: LAUNCH_SETTING_KEY } },
      select: { id: true },
    });
    if (!row) {
      // Fresh install: no launch row yet. create(), not upsert — a writer
      // that got there first surfaces as a unique violation, and the loop
      // retries ON TOP OF its value instead of overwriting it.
      try {
        await prisma.setting.create({
          data: {
            shopId,
            key: LAUNCH_SETTING_KEY,
            value: validated as object,
            updatedBy,
          },
        });
        return next;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          continue;
        }
        throw err;
      }
    }

    const updated = await prisma.setting.updateMany({
      where: {
        shopId,
        key: LAUNCH_SETTING_KEY,
        // The compare-and-swap: never land on a row whose mode moved since
        // the read. A path filter rather than whole-value equality, so a
        // stored value with extra or missing optional fields (an older app
        // version's shape) can still be written through.
        value: { path: ["mode"], equals: state.mode },
      },
      data: { value: validated as object, updatedBy },
    });
    if (updated.count === 1) return next;
    // Lost the race: a concurrent goLive/revertToSetup moved the mode
    // between the read and this write. Re-read and re-apply the one field.
  }

  // Every attempt found a stored raw `mode` that cannot equal its parsed
  // form: junk the schema fallback is masking. Heal it through the
  // validating whole-object writer — here the full rewrite is the repair,
  // not the bug (no concurrent flip can lose this many CAS rounds).
  const state = await getLaunchState(shopId);
  if (state[field] === value) return state;
  const next: LaunchState = { ...state, [field]: value };
  await setSetting(shopId, LAUNCH_SETTING_KEY, next, updatedBy);
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
 *
 * OURS_ONLY, and it is not cosmetic: the billing sweep this list predicts is
 * itself OURS_ONLY (app/lib/billing/scheduler.server.ts), so another app's
 * overdue contract is not a charge we are about to make — and the stagger
 * built on this list calls setNextBillingDate, which EDITS THE CONTRACT ON
 * SHOPIFY. Without the filter, going live would silently reschedule the other
 * app's subscribers behind its back, on a list of charges we were never going
 * to make. Demo fixtures are excluded for the same reason (never billed).
 */
export async function getOverdueContracts(
  shopId: string,
): Promise<OverdueContract[]> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      isDemo: false,
      ...OURS_ONLY,
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

export interface GoLiveResult {
  shifted: number;
  /** Ownership pass outcome, or null when it could not run (see goLive). */
  ownership: ReclassifyResult | null;
  /** Why the ownership pass could not run, for the audit payload / toast. */
  ownershipError: string | null;
}

/**
 * Re-decide who owns EVERY mirrored contract, before anything can bill.
 *
 * `reclassifyAllContracts`, not the single bounded pass: the sweep pages
 * through the whole shop by id cursor. A single pass is capped, and go-live
 * calling it once meant a shop with more contracts than that cap went live
 * with OUR OWN subscribers still sitting in migration 0003's UNKNOWN backfill
 * — unbillable, so their renewals silently stopped — and nothing re-ran it.
 *
 * Contained on purpose. A failure here is the SAFE direction and must not
 * abort go-live: contracts whose ownership was never positively established
 * are UNKNOWN, and UNKNOWN is not billable, not emailable, not counted and not
 * in the portal. So the worst case of a failed sweep is that some of OUR OWN
 * renewals wait until the admin presses "Re-check" on the Preview & launch
 * page — never that another app's subscriber gets charged. `remaining` on the
 * result says how many are still waiting, and it now reaches 0 when the shop
 * is fully attributed.
 */
async function reclassifyForGoLive(
  shopDomain: string,
): Promise<{ ownership: ReclassifyResult | null; ownershipError: string | null }> {
  try {
    return { ownership: await reclassifyAllContracts(shopDomain), ownershipError: null };
  } catch (err) {
    console.error("[launch] go-live ownership reclassification failed", err);
    return {
      ownership: null,
      ownershipError: err instanceof Error ? err.message : String(err),
    };
  }
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
 * widget hidden — a go-live that lied, with nothing to detect it.
 *
 * Ownership is re-decided FIRST, before the mode flips. Going live is what
 * starts the billing sweep, and on a store that also runs another
 * subscription app the mirrored contracts must be attributed before a sweep
 * can look at them — this is the one moment in the product where that is
 * guaranteed to happen. It also runs before the overdue stagger, so the
 * "renewals about to fire" list the stagger edits is the real one.
 *
 * The overdue stagger runs SECOND — before the mode flips, while the shop is
 * still SETUP. The billing sweep gates on the launch SETTING and runs on its
 * own tick (billing_run, every 5 minutes, with no awareness of goLive): on a
 * migration store with hundreds of overdue imported contracts the per-contract
 * Shopify mutation loop takes minutes, so flipping LIVE first opened a window
 * in which the next sweep tick charged every not-yet-shifted contract in one
 * burst — exactly what the "Shift these renewals forward" option promises to
 * prevent — and the remaining stagger calls then rescheduled contracts that
 * had already been charged. Shifting first closes that window completely: by
 * the time anything can bill, every overdue date is tomorrow or later. The
 * price is that a subsequently failed metafield write leaves the shifted
 * dates behind (see the rollback below) — renewals harmlessly postponed by
 * 1-3 days, with no charge made, which is a far cheaper failure than the
 * burst. setNextBillingDate sends no customer notification, so running it in
 * SETUP contacts nobody.
 */
export async function goLive(
  shopDomain: string,
  options: GoLiveOptions,
): Promise<GoLiveResult> {
  const shop = await requireShop(shopDomain);
  const now = new Date();

  const { ownership, ownershipError } = await reclassifyForGoLive(shopDomain);

  // Stagger overdue renewals while the billing sweep is still gated by SETUP
  // — see the ordering note in the doc comment above.
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
    // dark; the admin gets a real error and can retry. Already-staggered
    // renewals stay postponed (dates only moved 1-3 days forward — no charge
    // was made), which is deliberate: see the ordering note above.
    await setSetting(shop.id, "launch", state, options.actor);
    throw new Error(
      `Storefront flag not updated (cellexia.launch_status): ${sync.error ?? "unknown error"}. The shop is still in setup${
        shifted > 0
          ? `; ${shifted} overdue renewal(s) were already postponed by 1-3 days (no charges were made)`
          : " — nothing was changed"
      } — retry.`,
    );
  }

  // Defensive republication of the storefront allow-list
  // (cellexia.plan_groups): the buy box renders our selling plan group and
  // only ours, so going live with a stale or missing allow-list on a shop that
  // also runs another subscription app would show that app's plan — or, worse,
  // put its selling plan id in our cart injection. Never throws; a failure is
  // logged and visible in the go-live audit payload.
  const planGroupsSync = await publishOwnGroupsMetafield(shopDomain);

  /**
   * What the published allow-list actually unlocks, for the audit trail.
   *
   * `ok: true` is not the same as "the buy box works". The storefront requires
   * BOTH ids to agree before it renders a group, so an allow-list with group
   * ids but no plan ids — what publishOwnGroupsMetafield() emits when it
   * cannot read a group back from Shopify — renders NOTHING on every product.
   * Recording that as a bare "published" is how a shop goes live with a dark
   * buy box and nothing in the audit trail saying so.
   */
  function planGroupsOutcome(): string {
    if (!planGroupsSync.ok) {
      return `failed: ${planGroupsSync.error ?? "unknown error"}`;
    }
    const groupIds = planGroupsSync.value?.groupIds ?? [];
    const planIds = planGroupsSync.value?.planIds ?? [];
    const planSets = planGroupsSync.value?.planSets ?? [];
    const healFailed = planGroupsSync.heal?.failed ?? [];
    if (groupIds.length === 0) {
      return "published but EMPTY (no synced selling plan group) — the buy box renders nothing; sync a plan from Plans";
    }
    if (planIds.length === 0) {
      return `published but INCOMPLETE (${groupIds.length} group id(s), no plan ids) — the buy box renders nothing until the plan ids are recorded; re-run the plan sync from Plans`;
    }
    // ok:true is still not "the buy box works": the storefront also needs
    // the exact plan sets and the group-side appId stamp (v1.6.9), and a
    // contained heal failure would otherwise hide behind this line.
    if (planSets.length === 0) {
      return `published but INCOMPLETE (${groupIds.length} group id(s), no plan sets) — the buy box renders nothing until the live plan sets are published; re-run the plan sync from Plans`;
    }
    if (healFailed.length > 0) {
      return `published but INCOMPLETE (appId stamp failed for ${healFailed.length} group(s): ${healFailed.join(", ")}) — the buy box renders nothing from those groups; re-run the plan sync from Plans or run the Preview Doctor`;
    }
    return `published (${groupIds.length} group id(s), ${planIds.length} plan id(s), ${planSets.length} plan set(s), appId stamped)`;
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
      planGroupsMetafield: planGroupsOutcome(),
      // The rides-along cellexia.variant_defaults publish (v1.14.0):
      // presentation-only, so a failure never blocks go-live — but a
      // merchant who configured per-variant default frequencies deserves an
      // audit line saying the storefront never received them.
      variantDefaultsMetafield: !planGroupsSync.ok
        ? "not reached (allow-list publish failed)"
        : planGroupsSync.variantDefaults == null
          ? "not reached"
          : planGroupsSync.variantDefaults.ok
            ? "published"
            : `failed: ${planGroupsSync.variantDefaults.error ?? "unknown error"} — the buy box preselects the group default until a plan re-sync succeeds`,
      ownershipReclassified: ownership
        ? {
            scanned: ownership.scanned,
            changed: ownership.changed,
            resynced: ownership.resynced,
            errors: ownership.errors,
            remaining: ownership.remaining,
            counts: ownership.counts,
          }
        : `failed: ${ownershipError ?? "unknown error"}`,
    },
  });

  return { shifted, ownership, ownershipError };
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

// ── Proxy-identity probe ─────────────────────────────────────────────────────

export type ProxyIdentityStatus = "OK" | "MISMATCH" | "UNREACHABLE";

export interface ProxyIdentityProbe {
  status: ProxyIdentityStatus;
  /** The store-domain URL probed (token stripped), for the checklist copy. */
  url: string;
  /** What actually came back (HTTP status / error), for the checklist copy. */
  detail: string | null;
}

/**
 * "Portal proxy answers as Cellexia" — the launch-checklist probe that makes
 * the /apps/cellexia collision structurally impossible to re-ship. The
 * merchant's other live app ("AOV & LTV Booster") already serves
 * /apps/cellexia on this store, and that collision shipped repeatedly, so a
 * config-file agreement (tests/proxy-subpath.test.ts) is not enough: this
 * checks the LIVE store. A short-lived PREVIEW token is minted server-side
 * and GET https://{store}/apps/cellexia-subs/preview/validate?token=… is
 * fetched with a short timeout. Only our own endpoint
 * (app/routes/proxy.preview.validate.tsx) answers 200 { ok: true } to a token
 * this app signed — any other status or body means something else owns the
 * path (a colliding app, or our [app_proxy] config was never deployed) and
 * the row shows MISMATCH with remediation copy.
 *
 * Never throws, never blocks the page render: network failures (timeout, DNS,
 * TLS) are UNREACHABLE — a warning, not a failed row, because a hiccup
 * between the app host and the storefront proves nothing about ownership.
 * A landing on the storefront /password page is UNREACHABLE too (see below):
 * a password-protected store answers for every storefront path, ours
 * included, so it proves nothing about who owns this one.
 */
export async function probeProxyIdentity(
  shopId: string,
): Promise<ProxyIdentityProbe> {
  let url = `${PORTAL_PROXY_BASE}/preview/validate`;
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const host = shop?.primaryDomain ?? shop?.domain;
    if (!host) {
      return { status: "UNREACHABLE", url, detail: "no shop domain on record" };
    }
    url = `https://${host}${PORTAL_PROXY_BASE}/preview/validate`;

    const token = await createMagicToken({
      action: "PREVIEW",
      params: { shopId },
      ttlSeconds: PROXY_PROBE_TOKEN_TTL_SECONDS,
      maxUses: 1,
      createdVia: "ADMIN",
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      PROXY_PROBE_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(`${url}?token=${encodeURIComponent(token)}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "follow",
      });
    } finally {
      clearTimeout(timer);
    }

    // A password-protected storefront (the normal pre-launch state) 302s
    // every store-domain path — app-proxy paths included — to /password,
    // which answers 200 text/html and would otherwise read as a MISMATCH
    // ("non-JSON response body"). That is not a real answer from the wrong
    // app; it is no answer about the proxy at all, so it grades UNREACHABLE
    // (inconclusive — the self-check confirms once and WARNs), the same
    // policy every sibling probe pins for this exact hop (portal_endtoend in
    // app/lib/debug/selfcheck.server.ts, storefront_markup in
    // doctor.server.ts). MISMATCH stays reserved for a deterministic answer
    // from something that is not this app.
    if ((response.url ?? "").includes("/password")) {
      return {
        status: "UNREACHABLE",
        url,
        detail:
          "redirected to the storefront password page — the store is password-protected, which proves nothing about proxy ownership; check again after removing the password (or verify in a browser after entering it)",
      };
    }

    if (!response.ok) {
      return { status: "MISMATCH", url, detail: `HTTP ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "MISMATCH", url, detail: "non-JSON response body" };
    }
    const isOurs =
      typeof body === "object" &&
      body !== null &&
      (body as { ok?: unknown }).ok === true;
    return isOurs
      ? { status: "OK", url, detail: null }
      : { status: "MISMATCH", url, detail: "unexpected response body" };
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "AbortError"
        ? `no answer within ${PROXY_PROBE_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("[launch] proxy-identity probe failed", detail);
    return { status: "UNREACHABLE", url, detail };
  }
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
