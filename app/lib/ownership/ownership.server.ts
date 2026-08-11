import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { setShopMetafield } from "~/lib/graphql/metafields.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * `adminClientForShop` is imported lazily on purpose. This module is imported
 * by nearly every billing / notification / analytics / portal module (that is
 * the point — one place decides what "ours" means), and `~/shopify.server`
 * constructs the Prisma session storage at module load. A static import would
 * drag that construction into every consumer's module graph, so a unit test
 * that mocks `~/db.server` but has no reason to know about Shopify sessions
 * would fail to even load the module under test. Only the two functions that
 * actually talk to Shopify pay for it.
 */
async function admin(shopDomain: string) {
  const { adminClientForShop } = await import("~/shopify.server");
  return adminClientForShop(shopDomain);
}

/**
 * Ownership — which selling plan groups, plans and contracts belong to THIS
 * app.
 *
 * The store may run another subscription app at the same time (cellexialabs.com
 * runs Joy Subscriptions). Two consequences, both dangerous:
 *
 *  1. Storefront: `product.selling_plan_groups` contains the other app's group
 *     too, so a buy box that picks "the first group" renders the competitor's
 *     plan — their discount, their frequencies, their selling plan id in the
 *     cart. `publishOwnGroupsMetafield()` mirrors our plan ids AND our own
 *     app id into the shop metafield `cellexia.plan_groups` so Liquid can
 *     render our group and ONLY our group (and render nothing at all when we
 *     have none on that product). Liquid requires BOTH factors to agree —
 *     a plan-id intersection and the group's stamped `app_id` — so neither
 *     field alone can unlock a group.
 *  2. Billing: SUBSCRIPTION_CONTRACTS_* webhooks fire for EVERY contract on the
 *     shop, whoever created it, and `syncContractFromShopify` mirrors them all.
 *     Without a marker our scheduler would charge the other app's subscribers
 *     on top of the other app charging them — duplicate charges to real
 *     customers. `SubscriptionContract.ownership` is that marker; every
 *     billing / notification / analytics query filters on it.
 *
 * Fail-safe direction, everywhere: when ownership cannot be positively
 * determined the contract is NOT ours (UNKNOWN) and therefore not billable.
 * An explicit OURS is never downgraded to UNKNOWN by a later re-sync; it moves
 * to FOREIGN only on positive evidence (lines carrying selling plans, none of
 * which are ours).
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────
//
// The pure vocabulary (OWNERSHIP_* constants, ContractOwnership, OURS_ONLY,
// isBillableOwnership, normalizeOwnership) lives in ./shared so admin route
// COMPONENTS can import it without dragging this server-only module into the
// client bundle. Re-exported here verbatim so every existing server caller
// keeps its import path; there is exactly one definition of each.

import {
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  normalizeOwnership,
} from "./shared";
import type { ContractOwnership } from "./shared";

export {
  OURS_ONLY,
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  isBillableOwnership,
  normalizeOwnership,
} from "./shared";
export type { ContractOwnership } from "./shared";

// ── Metafield contract (Liquid allow-list) ───────────────────────────────────

export const PLAN_GROUPS_METAFIELD_NAMESPACE = "cellexia";
export const PLAN_GROUPS_METAFIELD_KEY = "plan_groups";
export const PLAN_GROUPS_METAFIELD_VERSION = 2;

/**
 * Shape written to `shop.metafields.cellexia.plan_groups` (type: json).
 *
 * The storefront (v2, since v1.6.9) requires BOTH factors before rendering a
 * group: `appId` (the group's stamped `app_id` equal to it) AND `planSets`
 * (the group's live selling plan ids EXACTLY equal to one published set —
 * same members, same count). Either factor missing means "render nothing",
 * on every product. `groupIds` and `planIds` are legacy — inert on the new
 * storefront but still read by the Preview Doctor, by humans debugging a
 * shop, and by a pre-v1.6.9 extension during the upgrade window (its old
 * gate needs both non-empty, which keeps the widget alive until the new
 * extension deploys).
 */
export interface PlanGroupsMetafieldValue {
  v: number;
  /**
   * Numeric SellingPlanGroup ids as strings — legacy. Storefront Liquid never
   * consults these (its group ids are opaque, per-shop identifiers that can
   * never equal an admin id); the v1.6.6→v1.6.9 lesson lives in the module
   * header. Kept for the Preview Doctor, debuggability and the pre-v1.6.9
   * extension.
   */
  groupIds: string[];
  /**
   * Numeric SellingPlan ids as strings, the union across groups — legacy
   * (the pre-v1.6.9 extension's ownership factor; the new gate reads
   * `planSets`). Sourced from the append-only DB evidence, so it may carry
   * dead plan ids — which is exactly why it CANNOT serve an exact-set
   * comparison and `planSets` exists.
   */
  planIds: string[];
  /**
   * One entry per owned group: the group's LIVE selling plan ids (numeric
   * strings), read off Shopify at publish time. The storefront renders a
   * group only when its plan set EXACTLY equals one of these sets — same
   * members, same count. Exact equality is the point: an any-member rule
   * would let ONE corrupted entry render a competitor's single-plan group
   * whose owner stamped our (public) app id onto it, collapsing ownership
   * back to a single field. Under set equality, tampering with an existing
   * set darkens the widget (fails closed) and rendering a foreign group
   * requires authoring a complete, well-formed set for it — wholesale
   * forgery of the trust anchor, the documented residual.
   */
  planSets: string[][];
  /**
   * This app's own numeric Shopify App id (see getCurrentAppId). Compared
   * against `selling_plan_group.app_id` in Liquid — the other mandatory
   * ownership factor. Unlike group ids, app ids read the same from the Admin
   * API and from Storefront Liquid; unlike Shopify defaults, `app_id` is nil
   * unless this app stamped it onto the group, so publishing also heals
   * unstamped groups (see publishOwnGroupsMetafield). NOTE the honest limit:
   * the value is public and any app can stamp any string onto its OWN
   * groups, so appId alone proves nothing — it is the exact-set factor that
   * carries the single-field-corruption guarantee, and both are required.
   */
  appId: string;
}

// ── GID helpers ──────────────────────────────────────────────────────────────

/**
 * Numeric id of a Shopify GID ("gid://shopify/SellingPlan/42" → "42"). Returns
 * the input unchanged when it is already a bare numeric id, and null for
 * anything else (including our fake demo gids).
 */
export function numericIdFromGid(gid: string | null | undefined): string | null {
  if (typeof gid !== "string") return null;
  const trimmed = gid.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = /\/(\d+)(?:\?.*)?$/.exec(trimmed);
  return match ? match[1] : null;
}

/** Both id forms of one reference, deduped and blank-free. */
function idForms(ref: string | null | undefined): string[] {
  const forms: string[] = [];
  if (typeof ref === "string" && ref.trim() !== "") forms.push(ref.trim());
  const numeric = numericIdFromGid(ref);
  if (numeric && !forms.includes(numeric)) forms.push(numeric);
  return forms;
}

/** Parse a Prisma Json column that should hold a list of GID strings. */
export function parsePlanIdsJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "" && !out.includes(entry.trim())) {
      out.push(entry.trim());
    }
  }
  return out;
}

/**
 * Union of the plan ids we already had for a config and the ones the latest
 * sync returned, newest last, capped so the column cannot grow without bound.
 *
 * Append-only on purpose: Shopify deletes a selling plan when the merchant
 * drops a frequency, but live contracts keep referencing the dead plan id. If
 * we forgot it, those contracts — OUR subscribers — would look foreign on the
 * next re-sync and silently stop being billed.
 */
const MAX_RETAINED_PLAN_IDS = 500;

export function mergePlanIds(existing: unknown, fresh: string[]): string[] {
  const merged = [...parsePlanIdsJson(existing)];
  for (const id of fresh) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed !== "" && !merged.includes(trimmed)) merged.push(trimmed);
  }
  return merged.length > MAX_RETAINED_PLAN_IDS
    ? merged.slice(merged.length - MAX_RETAINED_PLAN_IDS)
    : merged;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface OwnGroupIds {
  /** Full GIDs, e.g. "gid://shopify/SellingPlanGroup/123". */
  gids: string[];
  /** Numeric ids as strings, the form Liquid's `group.id` yields. */
  numericIds: string[];
}

/** The selling plan groups this app owns on `shopId` (synced configs only). */
export async function getOwnGroupIds(shopId: string): Promise<OwnGroupIds> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId, shopifyGroupId: { not: null } },
    select: { shopifyGroupId: true },
  });

  const gids: string[] = [];
  const numericIds: string[] = [];
  for (const config of configs) {
    const gid = config.shopifyGroupId;
    if (!gid) continue;
    if (!gids.includes(gid)) gids.push(gid);
    const numeric = numericIdFromGid(gid);
    if (numeric && !numericIds.includes(numeric)) numericIds.push(numeric);
  }
  return { gids, numericIds };
}

/**
 * Every selling plan id this app owns, in BOTH forms (full GID and bare
 * numeric), so a caller can test a Shopify GID or a storefront numeric id
 * against the same set.
 */
export async function getOwnPlanIds(shopId: string): Promise<Set<string>> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId },
    select: { shopifyPlanIds: true },
  });

  const ids = new Set<string>();
  for (const config of configs) {
    for (const planId of parsePlanIdsJson(config.shopifyPlanIds)) {
      for (const form of idForms(planId)) ids.add(form);
    }
  }
  return ids;
}

export interface OwnPlanIdEvidence {
  /** Our plan ids, both forms (empty when we own no plans). */
  planIds: Set<string>;
  /**
   * True when the set can be trusted as complete. False when a config has a
   * synced group whose plan ids were never persisted (a shop upgraded from a
   * build without `shopifyPlanIds`, or a sync that half-failed): the set is
   * then missing plans that ARE ours, so "not in the set" proves nothing and
   * nothing may be declared FOREIGN on its strength.
   */
  known: boolean;
}

/**
 * Our plan ids plus whether that evidence is complete. Classification uses
 * this, never the bare set — an empty-because-unpopulated set would otherwise
 * mark our own subscribers as another app's and silently stop billing them.
 */
export async function getOwnPlanIdEvidence(
  shopId: string,
): Promise<OwnPlanIdEvidence> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId },
    select: { shopifyGroupId: true, shopifyPlanIds: true },
  });

  const planIds = new Set<string>();
  let known = true;
  for (const config of configs) {
    for (const planId of parsePlanIdsJson(config.shopifyPlanIds)) {
      for (const form of idForms(planId)) planIds.add(form);
    }
    // A group exists on Shopify but we never recorded its plans → incomplete.
    if (config.shopifyGroupId && config.shopifyPlanIds == null) known = false;
  }
  return { planIds, known };
}

/**
 * Backfill `shopifyPlanIds` for configs that have a synced group but no
 * recorded plans, by reading the group back from Shopify. Best effort and
 * never throws: a config whose group cannot be read keeps its null column, so
 * the evidence stays explicitly incomplete instead of falsely complete.
 *
 * The leading DB filter makes this a no-op (one indexed read) once every synced
 * config has its plans recorded, which is the steady state after the first
 * successful repair or the next plan sync.
 */
export async function refreshOwnPlanIdsFromShopify(
  shopDomain: string,
  shopId: string,
): Promise<number> {
  let repaired = 0;
  try {
    const configs = await prisma.sellingPlanConfig.findMany({
      where: { shopId, shopifyGroupId: { not: null }, shopifyPlanIds: { equals: Prisma.DbNull } },
      select: { id: true, shopifyGroupId: true, shopifyPlanIds: true },
    });
    if (configs.length === 0) return 0;

    const { getSellingPlanGroupPlanIds } = await import(
      "~/lib/graphql/sellingPlans.server"
    );
    const adminClient = await admin(shopDomain);
    for (const config of configs) {
      try {
        const planIds = await getSellingPlanGroupPlanIds(
          adminClient,
          config.shopifyGroupId!,
        );
        if (planIds.length === 0) continue; // group gone / unreadable — stay unknown
        await prisma.sellingPlanConfig.update({
          where: { id: config.id },
          data: { shopifyPlanIds: mergePlanIds(config.shopifyPlanIds, planIds) },
        });
        repaired += 1;
      } catch (err) {
        console.error(
          "[ownership] plan id backfill failed for config",
          config.id,
          err,
        );
      }
    }
  } catch (err) {
    console.error("[ownership] plan id backfill failed", shopDomain, err);
  }
  return repaired;
}

/** Is this selling plan (GID or numeric id) one of ours? */
export async function isOurSellingPlan(
  shopId: string,
  planIdOrGid: string | null | undefined,
): Promise<boolean> {
  if (typeof planIdOrGid !== "string" || planIdOrGid.trim() === "") return false;
  const ownPlanIds = await getOwnPlanIds(shopId);
  return planIdMatches(ownPlanIds, planIdOrGid);
}

/** Pure membership test against an already-loaded own-plan-id set. */
export function planIdMatches(
  ownPlanIds: ReadonlySet<string>,
  planIdOrGid: string | null | undefined,
): boolean {
  return idForms(planIdOrGid).some((form) => ownPlanIds.has(form));
}

// ── Classification (pure) ────────────────────────────────────────────────────

export interface ClassifyOwnershipInput {
  /** Selling plan ids found on the contract's lines (may be empty). */
  linePlanIds: Array<string | null | undefined>;
  /** Our plan ids, both forms. */
  ownPlanIds: ReadonlySet<string>;
  /** Ownership already stored locally, if this contract was mirrored before. */
  existingOwnership?: string | null;
  /**
   * False when our own plan ids could not be loaded (DB error, plans not
   * synced yet). Absence of evidence is never evidence of foreignness.
   */
  ownPlanIdsKnown?: boolean;
}

/**
 * Decide a contract's ownership from its lines' selling plans.
 *
 *  - any line's plan is ours                    → OURS
 *  - lines carry plans, none of them ours       → FOREIGN (positive evidence)
 *  - no selling plan on any line                → keep an explicit prior
 *                                                 verdict, else UNKNOWN
 *  - our plan ids unavailable                   → keep a prior verdict, else
 *                                                 UNKNOWN
 *
 * UNKNOWN is treated as NOT ours by every billing/messaging path, so the
 * indeterminate cases fail safe (nothing is charged) rather than fail open.
 */
export function classifyContractOwnership(
  input: ClassifyOwnershipInput,
): ContractOwnership {
  const prior = normalizeOwnership(input.existingOwnership);
  const planIds = input.linePlanIds.filter(
    (id): id is string => typeof id === "string" && id.trim() !== "",
  );

  if (input.ownPlanIdsKnown === false) {
    // Our own plan ids are temporarily unavailable — no evidence either way.
    return prior ?? OWNERSHIP_UNKNOWN;
  }

  if (planIds.length === 0) {
    // Contracts created without a selling plan (atomicCreate imports). Our own
    // import paths stamp OURS explicitly at creation time; anything else stays
    // indeterminate — and therefore unbillable — until an admin claims it.
    return prior ?? OWNERSHIP_UNKNOWN;
  }

  if (planIds.some((id) => planIdMatches(input.ownPlanIds, id))) {
    return OWNERSHIP_OURS;
  }

  // Every line carries a selling plan and not one of them is ours: this
  // contract belongs to another subscription app.
  return OWNERSHIP_FOREIGN;
}

// ── Plan-sync persistence + metafield publication ────────────────────────────

/**
 * Persist what a selling-plan sync returned (group GID + plan GIDs) on the
 * config row, then refresh the storefront allow-list metafield.
 *
 * Called from the plan-sync path. The metafield write never throws — a failed
 * write leaves the previous allow-list in place (and, on a shop that never had
 * one, leaves the buy box rendering nothing). Either way the storefront cannot
 * end up rendering a foreign group: the allow-list is the only thing that can
 * unlock a render.
 */
export async function recordSellingPlanSync(args: {
  shopId: string;
  shopDomain: string;
  configId: string;
  groupId: string;
  planIds: string[];
}): Promise<{ storedPlanIds: string[]; metafield: PublishResult }> {
  const config = await prisma.sellingPlanConfig.findFirst({
    where: { id: args.configId, shopId: args.shopId },
    select: { shopifyPlanIds: true },
  });
  const storedPlanIds = mergePlanIds(config?.shopifyPlanIds, args.planIds);

  await prisma.sellingPlanConfig.update({
    where: { id: args.configId },
    data: { shopifyGroupId: args.groupId, shopifyPlanIds: storedPlanIds },
  });

  const metafield = await publishOwnGroupsMetafield(args.shopDomain);
  return { storedPlanIds, metafield };
}

export interface PublishResult {
  ok: boolean;
  error?: string;
  value?: PlanGroupsMetafieldValue;
  /**
   * The group-side appId heal's outcome (GIDs). Present whenever the publish
   * reached the heal. `failed` non-empty means the metafield was published
   * (ok:true) but the named groups are NOT stamped — the storefront renders
   * nothing from them until a sync or the next publish succeeds. Callers
   * that log "published" must surface this (go-live audit does), because
   * "ok:true with failed heals" is a dark storefront behind a green line.
   */
  heal?: { stamped: string[]; alreadyStamped: string[]; failed: string[] };
  /**
   * The rides-along `cellexia.variant_defaults` publish (v1.14.0 per-variant
   * default frequency). PRESENTATION, not ownership: its failure never fails
   * this publish (the widget then preselects the group default), so it is
   * reported here instead of thrown. Absent when the ownership publish
   * failed before reaching it.
   */
  variantDefaults?: { ok: boolean; error?: string };
}

/**
 * Build the storefront allow-list from the synced configs of `shopDomain` and
 * write it to the shop metafield `cellexia.plan_groups` (type json):
 *
 *   {"v":2,"groupIds":["123"],"planIds":["456","789"],
 *    "planSets":[["456","789"]],"appId":"4830258"}
 *
 * Ids are the NUMERIC form because that is what Liquid gives for
 * `group.id` / `selling_plan.id`. Never throws — and a failed write is not a
 * silent fallback: the buy box treats a missing, malformed or empty allow-list
 * as "no group of ours is provable here" and renders NOTHING AT ALL, on every
 * product, including products that do carry our group. There is deliberately
 * no name-based fallback (a merchant can name the other app's group
 * "Cellexia Subscribe & Save"), so this metafield is the single source of
 * truth for what the storefront may render. Operationally that means a failed
 * publish is a full widget outage rather than a wrong widget: re-running the
 * plan sync, or Preview & launch, republishes it.
 *
 * TWO MANDATORY STOREFRONT FACTORS, BOTH FROM THIS VALUE (v1.6.9):
 *
 *  1. `planSets` — a group renders only when its LIVE plan ids EXACTLY equal
 *     one published set (same members, same count; plan ids are the one id
 *     space Liquid and the Admin API share). Exact equality — not "any one
 *     plan on a list" — is what makes single-entry corruption harmless: an
 *     appended or altered entry breaks the equality and darkens the widget
 *     (fails closed) instead of unlocking a competitor's group. The sets are
 *     read off Shopify AT PUBLISH TIME, never off the append-only DB
 *     evidence (which keeps dead plan ids for billing safety and would break
 *     the count).
 *  2. `appId` — the group's `selling_plan_group.app_id` must equal it. The
 *     value exists on the group only because this app stamps it there
 *     (Shopify leaves `app_id` nil otherwise), which is why the publish
 *     below also HEALS unstamped groups before writing the metafield:
 *     several flows republish without running the full group sync (go-live,
 *     config delete), and publishing an appId the groups don't carry would
 *     darken the widget until the next manual sync. Honest limit: the app id
 *     is public and any app can stamp any string onto its OWN groups, so
 *     this factor alone is not proof — it exists to force a forger to author
 *     BOTH factors coherently, and the exact-set factor is what carries the
 *     single-field guarantee.
 *
 * `groupIds` and `planIds` are legacy: inert on the new storefront
 * (`groupIds` since the v1.6.6 opaque-id lesson, `planIds` since the v1.6.9
 * exact-set factor), kept for the Preview Doctor, humans, and the
 * pre-v1.6.9 extension during the upgrade window.
 *
 * The one-field history, because it keeps trying to repeat: `groupIds` alone
 * decided ownership (v1.3.0) — broken by the id-space trap; `planIds`-any-
 * member decided it alone (v1.6.6) — one corrupted entry could render a
 * competitor's single-plan group whose owner stamped our public app id.
 * Exact sets plus the app-id stamp mean every degraded or tampered state
 * renders NOTHING: briefly absent beats briefly wrong. The same direction
 * governs a failed appId or live-state read: the publish returns `{ok:false}`
 * and leaves the previous allow-list in place — stale-but-valid beats
 * fresh-but-dark.
 *
 * Which makes the repairs below load-bearing rather than merely tidy. The
 * plan-id repair is one indexed query returning nothing once every synced
 * config has its plans (the steady state); the appId heal shares the one
 * live read the plan sets need anyway (a write happens only for groups
 * still unstamped). The heal is contained per group and its outcome is
 * surfaced on the result (`heal.failed`) — go-live audits it, the Preview
 * Doctor names it, and the daily alert sweep re-publishes on it.
 */
export async function publishOwnGroupsMetafield(
  shopDomain: string,
): Promise<PublishResult> {
  try {
    const shop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
      select: { id: true },
    });
    if (!shop) {
      return { ok: false, error: `Unknown shop: ${shopDomain}` };
    }

    await refreshOwnPlanIdsFromShopify(shopDomain, shop.id);
    const dbValue = await buildPlanGroupsValue(shop.id);
    const adminClient = await admin(shopDomain);
    // Lazy import: this module loads in nearly every server module graph,
    // and the group-sync layer is only ever needed on the publish path.
    const {
      getCurrentAppId,
      getSellingPlanGroupOwnershipStates,
      stampSellingPlanGroupAppIds,
    } = await import("~/lib/graphql/sellingPlans.server");
    const appId = await getCurrentAppId(adminClient);

    // One live read serves both halves of the app-id factor AND the exact
    // plan sets. NOT contained: if the live state cannot be read, there is
    // no truthful value to publish — failing here keeps the PREVIOUS
    // metafield in place, and stale-but-valid beats fresh-but-dark.
    const { gids } = await getOwnGroupIds(shop.id);
    const states = await getSellingPlanGroupOwnershipStates(adminClient, gids);

    // Heal groups that predate the appId stamp (pre-v1.6.9, or a failed
    // stamp): this publish path is reachable from flows that never run the
    // full group sync (go-live, config delete), so the publish itself
    // repairs the group-side factor. Per-group containment lives inside;
    // the outcome is surfaced on the result, never swallowed.
    const heal = await stampSellingPlanGroupAppIds(
      adminClient,
      states,
      gids,
      appId,
    );

    // The exact-set factor: each owned group's LIVE plan ids, numeric. A
    // group that could not be read back gets NO set — it cannot be
    // truthfully attested, so it stays dark (fail closed) and shows up in
    // heal.failed above.
    const planSets: string[][] = [];
    for (const gid of gids) {
      const state = states.get(gid);
      if (!state) continue;
      const set = state.planIds
        .map((planId) => numericIdFromGid(planId))
        .filter((id): id is string => id != null);
      if (set.length > 0) planSets.push(set);
    }

    const value: PlanGroupsMetafieldValue = { ...dbValue, planSets, appId };
    await setShopMetafield(adminClient, {
      namespace: PLAN_GROUPS_METAFIELD_NAMESPACE,
      key: PLAN_GROUPS_METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(value),
    });

    // Rides-along presentation publish: the per-variant default-frequency
    // metafield refreshes wherever the allow-list does (sync, delete,
    // go-live, sweeps), through this one choke point. CONTAINED — its
    // failure degrades preselection to the group default and must never
    // taint the ownership publish that just succeeded. Lazy import for the
    // same module-graph reason as the sellingPlans import above.
    let variantDefaults: { ok: boolean; error?: string };
    try {
      const { publishVariantDefaultsMetafield } = await import(
        "~/lib/widget/variant-defaults.server"
      );
      const published = await publishVariantDefaultsMetafield(
        adminClient,
        shop.id,
      );
      variantDefaults = published.ok
        ? { ok: true }
        : { ok: false, error: published.error };
    } catch (err) {
      console.error(
        "[ownership] variant_defaults rides-along publish failed",
        shopDomain,
        err,
      );
      variantDefaults = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { ok: true, value, heal, variantDefaults };
  } catch (err) {
    console.error(
      "[ownership] plan_groups metafield publish failed",
      shopDomain,
      err,
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The allow-list value for a shop, numeric ids only (Liquid's id form) —
 * everything the DB alone can answer (the legacy fields). The publish path
 * merges in `appId` and `planSets`, which need the Admin API: `planIds`
 * here is the append-only DB evidence (dead plan ids included, for billing
 * safety), which is legitimate for the legacy union field and disqualifying
 * for the exact-set factor.
 */
export async function buildPlanGroupsValue(
  shopId: string,
): Promise<Omit<PlanGroupsMetafieldValue, "appId" | "planSets">> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId, shopifyGroupId: { not: null } },
    select: { shopifyGroupId: true, shopifyPlanIds: true },
  });

  const groupIds: string[] = [];
  const planIds: string[] = [];
  for (const config of configs) {
    const groupNumeric = numericIdFromGid(config.shopifyGroupId);
    if (groupNumeric && !groupIds.includes(groupNumeric)) {
      groupIds.push(groupNumeric);
    }
    for (const planId of parsePlanIdsJson(config.shopifyPlanIds)) {
      const planNumeric = numericIdFromGid(planId);
      if (planNumeric && !planIds.includes(planNumeric)) planIds.push(planNumeric);
    }
  }

  return { v: PLAN_GROUPS_METAFIELD_VERSION, groupIds, planIds };
}

// ── Claiming (migration off the other app) ───────────────────────────────────

export interface ClaimContractsResult {
  claimed: number;
  skipped: number;
}

/**
 * Claim contracts as ours: UNKNOWN → OURS. Used when the merchant migrates
 * subscribers off the other subscription app and our import/backfill could not
 * prove ownership from the lines (imported contracts carry no selling plan).
 *
 * Deliberately narrow: FOREIGN rows — contracts positively identified as
 * another app's — are never flipped here, and already-OURS rows are a no-op.
 * Cancel them in the other app and re-import instead; two apps must never bill
 * the same contract.
 */
export async function claimContracts(
  shopId: string,
  contractIds: string[],
  actor: string,
): Promise<ClaimContractsResult> {
  const ids = [...new Set(contractIds.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return { claimed: 0, skipped: 0 };

  const claimable = await prisma.subscriptionContract.findMany({
    where: { shopId, id: { in: ids }, ownership: OWNERSHIP_UNKNOWN },
    select: { id: true, shopifyContractId: true, email: true, customerId: true },
  });

  for (const contract of claimable) {
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { ownership: OWNERSHIP_OURS },
    });
    await logEvent({
      shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "contract_ownership_claimed",
        shopifyContractId: contract.shopifyContractId,
        from: OWNERSHIP_UNKNOWN,
        to: OWNERSHIP_OURS,
      },
    });
  }

  return { claimed: claimable.length, skipped: ids.length - claimable.length };
}

/**
 * `claimContracts` above is deliberately the ONLY bulk writer of OURS in this
 * module. A second helper (`markContractsOurs`) used to sit here for the import
 * paths: it took bare contract ids, matched `ownership: { not: OURS }` and had
 * no `shopId` in its where clause. It had no production caller — the import
 * paths stamp `ownership: "OURS"` inline in their own `create`/`upsert`, which
 * is both narrower and atomic with the row they are creating — so it was pure
 * surface area, and its two differences from `claimContracts` were the exact
 * two a bulk ownership writer must not have: it would promote a FOREIGN row
 * (positively identified as another app's, i.e. the double-charge case) and it
 * would do so across shops. It was removed rather than repaired; anything that
 * needs to move rows to OURS goes through `claimContracts`, which is scoped to
 * one shop, refuses FOREIGN, and leaves an audit event behind.
 */

// ── Reclassification (upgrade path) ──────────────────────────────────────────

export interface ReclassifyResult {
  scanned: number;
  changed: number;
  resynced: number;
  errors: number;
  /**
   * How much work is LEFT once this run finished: the number of contracts
   * still waiting for a verdict (the UNKNOWN count). Both callers ask it that
   * question — the go-live audit payload records it, and Preview & launch
   * turns it into the "run it again" hint.
   *
   * It therefore reaches 0 exactly when every contract has been attributed,
   * and it strictly decreases while a run is making progress.
   *
   * It used to be `total - scanned`, counted over EVERY non-demo contract.
   * On a shop with more contracts than one pass may scan that number is
   * CONSTANT — the total never shrinks — so it never reached 0 however many
   * times the pass ran. The one completion signal the manual "click Re-check
   * until it's done" loop depends on always said "not done yet", and the
   * go-live audit trail recorded a backlog that had in fact been cleared.
   */
  remaining: number;
  counts: OwnershipCounts;
}

/** Safety cap so one interactive pass can never run unbounded in a request. */
export const RECLASSIFY_DEFAULT_LIMIT = 2000;

/** Rows the full sweep reads per batch (one query + its per-contract work). */
export const RECLASSIFY_BATCH_SIZE = 500;

/** Hard ceiling on a full sweep, so it too can never run unbounded. */
export const RECLASSIFY_MAX_CONTRACTS = 100_000;

/**
 * Shopify re-fetches ONE call may make. Local classification is a DB read and
 * costs nothing, but a contract with no mirrored selling plan can only be
 * decided by re-fetching it — and right after migration 0003 that is EVERY
 * pre-existing contract (the column ownership is derived from is added by that
 * migration, so it is null on every existing row). Without a budget the first
 * run on a large shop would sit in one request making one API call per
 * subscriber. Contracts left over stay UNKNOWN — unbillable, i.e. the safe
 * direction — are reported in `remaining`, and the next run picks them up
 * first (UNKNOWN sorts first in the interactive pass).
 */
export const RECLASSIFY_RESYNC_BUDGET = 1000;

/** The columns a classification pass needs off a contract row. */
interface ReclassifyRow {
  id: string;
  ownership: string;
  shopifyContractId: string;
  customerId: string;
  email: string;
  lines: Array<{ sellingPlanId: string | null }>;
}

const RECLASSIFY_SELECT = {
  id: true,
  ownership: true,
  shopifyContractId: true,
  // Identity fields for the reclassification audit event only.
  customerId: true,
  email: true,
  lines: { select: { sellingPlanId: true } },
} as const;

type SyncContractFn = (
  shopDomain: string,
  gid: string,
  options?: unknown,
) => Promise<unknown>;

/** Mutable state shared by every contract in one run. */
interface ReclassifyPass {
  shopDomain: string;
  shopId: string;
  evidence: OwnPlanIdEvidence;
  fetchMissing: boolean;
  result: ReclassifyResult;
  /** Re-fetches still allowed (see RECLASSIFY_RESYNC_BUDGET). */
  resyncBudget: number;
  /** Lazily imported once per run, never per contract. */
  syncFn: SyncContractFn | null;
}

/**
 * Decide one contract, the same way for the bounded pass and the full sweep.
 *
 * Cheap first: a contract whose mirrored lines already carry selling plan ids
 * is decided locally with no network at all. Only rows with no local evidence
 * AND no positive ownership yet are re-fetched, a failure there is contained
 * per contract, and the re-fetch budget is checked before the round trip.
 *
 * A row that is already OURS is never re-fetched: every path that writes OURS
 * has positive evidence behind it (the classifier matched one of our plan ids,
 * an import created the contract, or an admin claimed it), and contracts our
 * own import path created carry no selling plan at all — re-fetching those on
 * every run would mean one Shopify round trip per imported subscriber, forever,
 * to learn nothing. Their local verdict is re-checked either way, so a genuine
 * change of evidence still moves them.
 */
async function reclassifyOne(
  pass: ReclassifyPass,
  contract: ReclassifyRow,
): Promise<void> {
  pass.result.scanned += 1;

  const linePlanIds = contract.lines.map((l) => l.sellingPlanId);
  const hasLocalEvidence = linePlanIds.some(
    (id) => typeof id === "string" && id !== "",
  );
  const alreadyOurs = contract.ownership === OWNERSHIP_OURS;

  if (!hasLocalEvidence && !alreadyOurs && pass.fetchMissing) {
    // Out of budget: leave it UNKNOWN (unbillable — the safe direction) for
    // the next run rather than spending the request on it.
    if (pass.resyncBudget <= 0) return;
    pass.resyncBudget -= 1;
    try {
      if (!pass.syncFn) {
        const mod = await import("~/lib/contracts/sync.server");
        pass.syncFn = mod.syncContractFromShopify as unknown as SyncContractFn;
      }
      await pass.syncFn(pass.shopDomain, contract.shopifyContractId, {
        source: "SYSTEM",
      });
      pass.result.resynced += 1;
      return; // the sync classified and persisted it
    } catch (err) {
      pass.result.errors += 1;
      console.error(
        "[ownership] reclassify re-sync failed",
        contract.shopifyContractId,
        err,
      );
      return;
    }
  }

  const next = classifyContractOwnership({
    linePlanIds,
    ownPlanIds: pass.evidence.planIds,
    existingOwnership: contract.ownership,
    ownPlanIdsKnown: pass.evidence.known,
  });
  if (next !== contract.ownership) {
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { ownership: next },
    });
    pass.result.changed += 1;
    // Ownership decides COUNTABLE_CONTRACT membership — the population of
    // every metric — so a repair pass moving a contract in or out must leave
    // the same audit trail every other ownership writer does (the sync's
    // synced_from_shopify payload, claimContracts' claim event). Without it
    // a reclassify run retroactively shifted MRR/churn/funnel with nothing
    // in the event stream to explain the step.
    await logEvent({
      shopId: pass.shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "contract.updated",
      source: "SYSTEM",
      actor: "system",
      payload: {
        action: "ownership_reclassified",
        shopifyContractId: contract.shopifyContractId,
        ownership: next,
        previousOwnership: contract.ownership,
      },
    });
  }
}

function emptyResult(): ReclassifyResult {
  return {
    scanned: 0,
    changed: 0,
    resynced: 0,
    errors: 0,
    remaining: 0,
    counts: { ours: 0, foreign: 0, unknown: 0 },
  };
}

async function requireShopId(shopDomain: string): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) {
    throw new Error(`Unknown shop: ${shopDomain}`);
  }
  return shop.id;
}

/**
 * Re-decide ownership for contracts that were mirrored before ownership
 * existed (or before our plans were synced).
 *
 * WHY THIS EXISTS. Migration 0003 backfills every pre-existing contract to
 * UNKNOWN, because at migration time there is no evidence to do better: the
 * two columns ownership is derived from (ContractLine.sellingPlanId,
 * SellingPlanConfig.shopifyPlanIds) are added by that same migration and are
 * null on every existing row. UNKNOWN is not billable, so the upgrade is safe
 * but incomplete — OUR OWN subscribers sit in it too. This function is the
 * completion step: it puts the evidence back and lets the normal classifier
 * decide. Go-live runs it automatically (goLive in
 * app/lib/launch/launch.server.ts) and the Preview & launch page exposes it as
 * a button, so it is never a manual DB chore.
 *
 * Cheap first: contracts whose mirrored lines already carry selling plan ids
 * are decided locally, with no network at all. Only rows with no local
 * evidence AND no positive ownership yet are re-fetched from Shopify (through
 * the normal sync, which stores plan ids as it mirrors), and a failure there is
 * contained per contract.
 *
 * A row that is already OURS is never re-fetched: every path that writes OURS
 * has positive evidence behind it (the classifier matched one of our plan ids,
 * an import created the contract, or an admin claimed it), and contracts our
 * own import path created carry no selling plan at all — re-fetching those on
 * every pass would mean one Shopify round trip per imported subscriber,
 * forever, to learn nothing. Their local verdict is re-checked either way, so
 * a genuine change of evidence still moves them.
 */
export async function reclassifyContracts(
  shopDomain: string,
  options: { fetchMissing?: boolean; limit?: number } = {},
): Promise<ReclassifyResult> {
  const limit = options.limit ?? RECLASSIFY_DEFAULT_LIMIT;
  const shopId = await requireShopId(shopDomain);

  const pass: ReclassifyPass = {
    shopDomain,
    shopId,
    evidence: await getOwnPlanIdEvidence(shopId),
    fetchMissing: options.fetchMissing ?? true,
    result: emptyResult(),
    resyncBudget: RECLASSIFY_RESYNC_BUDGET,
    syncFn: null,
  };

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId, isDemo: false },
    // UNKNOWN first (descending sorts UNKNOWN > OURS > FOREIGN): on a shop
    // that has just upgraded, the indeterminate rows are the whole point of
    // the pass and the ones a `limit` must never be the reason to skip. It is
    // also what makes repeated runs converge — each one takes the rows that
    // still have no verdict, so the leftovers of the last run come first.
    orderBy: [{ ownership: "desc" }, { createdAt: "asc" }],
    select: RECLASSIFY_SELECT,
    take: limit,
  });

  for (const contract of contracts) {
    await reclassifyOne(pass, contract as ReclassifyRow);
  }

  pass.result.counts = await getOwnershipCounts(shopId);
  pass.result.remaining = pass.result.counts.unknown;
  return pass.result;
}

/**
 * Attribute EVERY contract on the shop, in one resumable sweep. This is what
 * go-live runs.
 *
 * `reclassifyContracts` above is one bounded pass, and go-live used to call it
 * exactly once: on a shop with more contracts than the pass limit that left
 * OUR OWN subscribers sitting in the migration's UNKNOWN backfill after
 * go-live — unbillable, so their renewals silently stopped — with nothing in
 * the product re-running the pass. The only recovery was an admin noticing the
 * number on Preview & launch and pressing Re-check over and over.
 *
 * Paginated by `id`, not by the UNKNOWN-first ordering the interactive pass
 * uses. Ownership is exactly what this loop rewrites, so ordering by it would
 * move rows between batches while paging through them — a row could be skipped
 * or revisited. `id` is a cuid, immutable and unique, so an id cursor visits
 * every contract exactly once no matter what the sweep writes.
 *
 * Bounded in both directions: at most `maxContracts` rows and at most
 * `resyncBudget` Shopify round trips per call. Anything not reached stays
 * UNKNOWN — not billed, not emailed, not counted — and is reported in
 * `remaining`, which the next sweep or the Re-check button resolves.
 */
export async function reclassifyAllContracts(
  shopDomain: string,
  options: {
    fetchMissing?: boolean;
    batchSize?: number;
    maxContracts?: number;
    resyncBudget?: number;
  } = {},
): Promise<ReclassifyResult> {
  const batchSize = Math.max(1, options.batchSize ?? RECLASSIFY_BATCH_SIZE);
  const maxContracts = Math.max(0, options.maxContracts ?? RECLASSIFY_MAX_CONTRACTS);
  const shopId = await requireShopId(shopDomain);

  const pass: ReclassifyPass = {
    shopDomain,
    shopId,
    evidence: await getOwnPlanIdEvidence(shopId),
    fetchMissing: options.fetchMissing ?? true,
    result: emptyResult(),
    resyncBudget: options.resyncBudget ?? RECLASSIFY_RESYNC_BUDGET,
    syncFn: null,
  };

  let cursor: string | null = null;
  while (pass.result.scanned < maxContracts) {
    const take = Math.min(batchSize, maxContracts - pass.result.scanned);
    const batch: ReclassifyRow[] = (await prisma.subscriptionContract.findMany({
      where: { shopId, isDemo: false },
      orderBy: { id: "asc" },
      select: RECLASSIFY_SELECT,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as ReclassifyRow[];

    if (batch.length === 0) break;
    for (const contract of batch) {
      await reclassifyOne(pass, contract);
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < take) break; // last page
  }

  pass.result.counts = await getOwnershipCounts(shopId);
  pass.result.remaining = pass.result.counts.unknown;
  return pass.result;
}

// ── Admin surfacing helpers ──────────────────────────────────────────────────

export interface OwnershipCounts {
  ours: number;
  foreign: number;
  unknown: number;
}

/** Contract counts by ownership (demo fixtures excluded). */
export async function getOwnershipCounts(
  shopId: string,
): Promise<OwnershipCounts> {
  const rows = await prisma.subscriptionContract.groupBy({
    by: ["ownership"],
    where: { shopId, isDemo: false },
    _count: { _all: true },
  });

  const counts: OwnershipCounts = { ours: 0, foreign: 0, unknown: 0 };
  for (const row of rows) {
    const n = row._count._all;
    if (row.ownership === OWNERSHIP_OURS) counts.ours += n;
    else if (row.ownership === OWNERSHIP_FOREIGN) counts.foreign += n;
    else counts.unknown += n;
  }
  return counts;
}
