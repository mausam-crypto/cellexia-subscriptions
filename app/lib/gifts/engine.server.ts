import type {
  GiftGrant,
  GiftRule,
  Prisma,
  Shop,
} from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz, addIntervalTz } from "~/lib/dates.server";
import { contractFrequency } from "~/lib/frequency";
import {
  hasSentForCycle,
  sendNotification,
} from "~/lib/notifications/index.server";
import {
  type AdminClient,
  type ShopifyVariant,
  draftLineAdd,
  getBillingCycleByDate,
  getBillingCycleByIndex,
  getVariants,
  withBillingCycleEdit,
} from "~/lib/graphql/index.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import { pickGiftForContract } from "~/lib/gifts/picker.server";
import { giftEmailLines } from "~/lib/gifts/emailLines.server";
import { surpriseGiftArmFor } from "~/lib/experiments/index.server";

/**
 * Gift engine — turns GiftRules into GiftGrants and rides the earned gift
 * along on exactly one billing cycle.
 *
 * Mechanics: a gift is a zero-priced line added to ONE cycle via a
 * billing-cycle contract edit (subscriptionBillingCycleContractEdit draft +
 * subscriptionDraftLineAdd at "0.00" + commit). Because the edit is
 * cycle-scoped it auto-reverts after that cycle bills — the contract's
 * recurring lines are never touched, so "removal" is purely local mirror
 * hygiene (see clearShippedGiftMirrors).
 *
 * Grant lifecycle: SCHEDULED (earned, not yet attached) → ADDED (zero-priced
 * line committed onto the cycle) → SHIPPED (cycle billed — flipped by the
 * billing-success webhook) → mirror cleared. SCHEDULED grants double as a
 * queue: anything (win-back reactivation, admin) can create a SCHEDULED grant
 * for a future cycle and the engine attaches it pre-charge.
 *
 * Idempotency: one grant per (contract, cycleIndex, variant); the
 * cycle.gift_added event (payload.grantId) marks a committed cycle edit so a
 * crash between commit and the ADDED flip never adds the line twice; the
 * gift_announcement notification dedupes per cycle via NotificationLog.
 *
 * Callers: SUBSCRIPTION_CONTRACTS_CREATE webhook (cycles 1+2), the billing
 * scheduler pre-charge pipeline, and the daily gifts_run job. All of them
 * wrap calls in try/catch — a gift failure must never block billing.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type ContractWithLines = Prisma.SubscriptionContractGetPayload<{
  include: { lines: true };
}>;

export interface EnsureGiftsResult {
  cycleIndex: number;
  /** Rules whose trigger matched this cycle. */
  rulesMatched: number;
  /** New GiftGrant rows created (SCHEDULED). */
  grantsCreated: number;
  /** Grants whose zero-priced line was committed onto the cycle (→ ADDED). */
  linesAdded: number;
  /** gift_announcement notifications sent. */
  announced: number;
  /** SCHEDULED grants stranded on an earlier index re-anchored to this cycle. */
  reanchored?: number;
  /** Set when the whole call was a no-op (inactive contract, skipped cycle...). */
  skipped?: string;
  errors: number;
}

export interface GiftSchedulingStats {
  scanned: number;
  rulesMatched: number;
  grantsCreated: number;
  linesAdded: number;
  announced: number;
  mirrorsCleared: number;
  errors: number;
  skipped?: string;
}

/** Alert.type raised once when a built-in suggests a missing GiftRule. */
const GIFT_RULE_SUGGESTION_ALERT = "GIFT_RULE_SUGGESTED";

// ── Rule matching ────────────────────────────────────────────────────────────

/**
 * The UTC instant this cycle is expected to bill: Shopify's own expected date
 * when the cycle resolves, else local schedule math from nextBillingDate
 * (orderNumber − upcoming order number intervals away, in the shop timezone —
 * order-number space, because the Shopify cycle index drifts ahead of
 * ordersCount by one for every skipped cycle and would skew the estimate).
 */
function estimateCycleDate(
  contract: ContractWithLines,
  orderNumber: number,
  expectedDate: Date | null,
  tz: string,
): Date | null {
  if (expectedDate) return expectedDate;
  if (!contract.nextBillingDate) return null;
  const upcomingOrderNumber = contract.ordersCount + 1;
  const delta = orderNumber - upcomingOrderNumber;
  if (delta === 0) return contract.nextBillingDate;
  const freq = contractFrequency(contract);
  return addIntervalTz(contract.nextBillingDate, freq.unit, freq.count, tz, delta);
}

/**
 * Does `rule` earn a gift on the cycle that will bill order `orderNumber`?
 * - ORDER_INDEX: rule.orderIndex === orderNumber. ORDER-NUMBER space, not
 *   Shopify cycle-index space: "gift on your 6th order" is a promise about
 *   successful orders (ordersCount — the same number the lifecycle engine's
 *   milestone fires on), while Shopify's cycle indexes drift ahead by one for
 *   every skipped cycle (skipped cycles keep their index). Matching on the
 *   cycle index made the two spaces disagree after any skip: the milestone
 *   email announced a gift whose ORDER_INDEX rule could never match again.
 * - DAYS_SUBSCRIBED: the milestone date (firstChargeAt + daysSubscribed) falls
 *   inside this cycle's window (previous cycle date, this cycle date] — the
 *   gift ships with the first order on/after the anniversary.
 * SAVE_FLOW / WINBACK / MANUAL rules are never auto-matched here; those flows
 * create SCHEDULED grants directly and the engine attaches them.
 */
/** Repeating anniversaries stop being checked after this many multiples. */
const MAX_ANNIVERSARY_REPEATS = 30;

/**
 * Which anniversary multiple of `rule.daysSubscribed` (1st, 2nd, ...) falls
 * inside this cycle's window (previous cycle date, cycle date]? Non-repeating
 * rules only ever consider the first multiple (the pre-0024 behavior);
 * repeating rules (repeatsAnnually) check every multiple, so a 365-day rule
 * fires on year one, two, three... The k it returns doubles as the dedupe
 * key: the k-th anniversary grant is the k-th grant this rule produced for
 * the contract (see the rule loop's count guard).
 */
export function anniversaryIndexForCycle(
  rule: GiftRule,
  contract: ContractWithLines,
  cycleDate: Date | null,
  tz: string,
): number | null {
  if (rule.daysSubscribed == null || !contract.firstChargeAt || !cycleDate) {
    return null;
  }
  // Window start = one billing interval before this cycle's date.
  const freq = contractFrequency(contract);
  const windowStart = addIntervalTz(cycleDate, freq.unit, freq.count, tz, -1);
  const maxK = rule.repeatsAnnually ? MAX_ANNIVERSARY_REPEATS : 1;
  for (let k = 1; k <= maxK; k += 1) {
    const milestone = addDaysTz(
      contract.firstChargeAt,
      rule.daysSubscribed * k,
      tz,
    );
    // Milestones are ordered, so past the window end every later k is too.
    if (milestone.getTime() > cycleDate.getTime()) break;
    if (milestone.getTime() > windowStart.getTime()) return k;
  }
  return null;
}

function ruleMatchesCycle(
  rule: GiftRule,
  contract: ContractWithLines,
  orderNumber: number,
  cycleDate: Date | null,
  tz: string,
): boolean {
  if (rule.trigger === "ORDER_INDEX") {
    return rule.orderIndex != null && rule.orderIndex === orderNumber;
  }
  if (rule.trigger === "DAYS_SUBSCRIBED") {
    return anniversaryIndexForCycle(rule, contract, cycleDate, tz) != null;
  }
  return false;
}

// ── Attach machinery ─────────────────────────────────────────────────────────

/**
 * Has this grant's zero-priced line already been committed onto THIS cycle?
 * The marker is per (grant, cycleIndex), not per grant: a grant re-anchored
 * off a skipped cycle (its committed edit died with the skip) must be able to
 * commit a fresh edit onto its new cycle — a grant-only marker would report
 * the dead commit as done and the re-anchored gift would never ship. Every
 * cycle.gift_added event has always carried `cycleIndex` in its payload, so
 * pre-existing grants keep their marker.
 */
async function giftAddedEventExists(
  contractId: string,
  grantId: string,
  cycleIndex: number,
): Promise<boolean> {
  const row = await prisma.subscriberEvent.findFirst({
    where: {
      contractId,
      type: "cycle.gift_added",
      AND: [
        { payload: { path: ["grantId"], equals: grantId } },
        { payload: { path: ["cycleIndex"], equals: cycleIndex } },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/** Best-effort variant lookup for mirror-line metadata; null on any failure. */
async function fetchVariant(
  admin: AdminClient,
  variantId: string,
): Promise<ShopifyVariant | null> {
  try {
    const [variant] = await getVariants(admin, [variantId]);
    return variant ?? null;
  } catch (err) {
    console.error("[gifts] gift variant lookup failed", variantId, err);
    return null;
  }
}

/**
 * Commit the grant's zero-priced line onto its cycle, flip the grant to ADDED,
 * mirror the line locally (isGift, addedVia GIFT_ENGINE) and log
 * cycle.gift_added. Safe to re-run: the cycle.gift_added event marks a commit
 * that already happened, and an existing isGift mirror for the variant is
 * reused instead of duplicated.
 */
async function attachGrantToCycle(
  admin: AdminClient,
  shop: Shop,
  contract: ContractWithLines,
  grant: GiftGrant & { rule: GiftRule | null },
): Promise<void> {
  const alreadyCommitted = await giftAddedEventExists(
    contract.id,
    grant.id,
    grant.cycleIndex,
  );

  // Variant lookup hoisted above the commit: best-effort and never throws, so
  // it cannot fail the attach — and the marker event below needs the title.
  const variant = await fetchVariant(admin, grant.variantId);
  const title =
    variant?.productTitle || grant.rule?.variantTitle || grant.rule?.name || "Gift";

  if (!alreadyCommitted) {
    await withBillingCycleEdit(
      admin,
      contract.shopifyContractId,
      { index: grant.cycleIndex },
      async (draftId, run) => {
        // The gift rides free on this one cycle: currentPrice "0.00".
        await draftLineAdd(run, draftId, {
          productVariantId: grant.variantId,
          quantity: 1,
          currentPriceCents: 0,
        });
      },
    );
    // The idempotency marker goes down IMMEDIATELY after the commit — before
    // the ADDED flip and the mirror write (v1.24.0; it used to be written
    // last, so a crash anywhere in the bookkeeping left a committed edit
    // with no marker and the retry committed a second free line). A swallowed
    // marker-write failure is still safe: the ADDED flip below takes the
    // grant out of SCHEDULED, so nothing retries the commit.
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "cycle.gift_added",
      source: "SYSTEM",
      actor: "gift_engine",
      payload: {
        grantId: grant.id,
        ruleId: grant.ruleId,
        ruleName: grant.rule?.name ?? null,
        cycleIndex: grant.cycleIndex,
        variantId: grant.variantId,
        title,
        unitCostCents: grant.unitCostCents ?? grant.rule?.unitCostCents ?? null,
      },
    });
  }

  const now = new Date();
  await prisma.giftGrant.update({
    where: { id: grant.id },
    data: { status: "ADDED", addedAt: now },
  });

  // Mirror line for portal display / analytics. Reuse an existing gift mirror
  // for the same variant (a prior cycle's mirror not yet cleared) so the
  // portal never shows the same gift twice.
  const existingMirror = await prisma.contractLine.findFirst({
    where: { contractId: contract.id, isGift: true, variantId: grant.variantId },
  });
  if (!existingMirror) {
    await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyLineId: null, // cycle-scoped line — it has no contract line GID
        productId: variant?.productId ?? "",
        variantId: grant.variantId,
        title,
        variantTitle: variant?.title || grant.rule?.variantTitle || null,
        sku: variant?.sku ?? null,
        imageUrl: variant?.imageUrl ?? null,
        quantity: 1,
        currentPriceCents: 0,
        compareAtPriceCents: variant?.priceCents ?? null,
        unitCostCents:
          grant.rule?.unitCostCents ?? variant?.unitCostCents ?? null,
        isGift: true,
        isOneTimeAddon: false,
        addedVia: "GIFT_ENGINE",
      },
    });
  }

}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Make sure every gift earned for `cycleIndex` is granted and attached to that
 * cycle (and only that cycle). Idempotent — callable any number of times from
 * the create-webhook, the pre-charge pipeline and the daily job.
 *
 * TWO INDEX SPACES meet here and must not be conflated:
 *  - `cycleIndex` is Shopify billing-cycle space — everything that touches the
 *    cycle itself (skip/billed checks, grant rows, cycle edits) uses it.
 *  - `orderNumber` is order-number space (ordersCount + 1 = the order this
 *    cycle will become when it bills) — ORDER_INDEX rule matching uses it,
 *    because "gift on your Nth order" is the merchant's promise about ORDERS
 *    and it is the number the lifecycle engine's milestone email fires on.
 *    The two drift apart by one for every skipped cycle (skipped cycles keep
 *    their index), so matching rules on `cycleIndex` broke the promise for
 *    every subscriber who ever skipped.
 * Callers that resolved a real Shopify cycle pass both; when `orderNumber` is
 * omitted it defaults to the contract's ordersCount + 1, which is correct
 * whenever the ensured cycle is the next one that will actually charge.
 */
export async function ensureGiftsForUpcomingCycle(
  contractLocalId: string,
  cycleIndex: number,
  orderNumber?: number,
): Promise<EnsureGiftsResult> {
  const result: EnsureGiftsResult = {
    cycleIndex,
    rulesMatched: 0,
    grantsCreated: 0,
    linesAdded: 0,
    announced: 0,
    errors: 0,
  };

  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Subscription contract not found: ${contractLocalId}`);
  }
  const targetOrderNumber = orderNumber ?? contract.ordersCount + 1;
  if (contract.status !== "ACTIVE") {
    result.skipped = "contract_not_active";
    return result;
  }
  // Never add a free line (a real contract edit on Shopify) to another
  // subscription app's contract. UNKNOWN fails safe the same way.
  if (!isBillableOwnership(contract.ownership)) {
    result.skipped = "foreign_contract";
    return result;
  }

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: contract.shopId },
  });
  const tz = shop.ianaTimezone;

  const rules = await prisma.giftRule.findMany({
    where: {
      shopId: shop.id,
      active: true,
      trigger: { in: ["ORDER_INDEX", "DAYS_SUBSCRIBED"] },
    },
    orderBy: { createdAt: "asc" },
  });

  const giftsSettings = await getSetting(shop.id, "gifts");
  const lifecycle = await getSetting(shop.id, "lifecycle");
  // Ladder rungs past the base milestone are gift moments with no GiftRule
  // row behind them — the engine grants them directly (dynamic pick). The
  // base milestoneGiftCycle itself stays rule-driven (its rule carries the
  // merchant's chosen variant + announce flag).
  const ladderRungMatched =
    lifecycle.milestoneLadder.includes(targetOrderNumber) &&
    targetOrderNumber !== lifecycle.milestoneGiftCycle;

  // Pre-existing SCHEDULED grants for this cycle (win-back perks, manual
  // grants) are attached even when no rule matches, so check them up front.
  // The lte also surfaces grants stranded on an EARLIER index — producers in
  // ordersCount space (or a skip after granting) can leave a promised gift on
  // a cycle that will never charge; those are re-anchored to this cycle below
  // once their own cycle is provably unbillable. ADDED grants are read too:
  // an ADDED grant on an earlier index is a committed cycle edit whose cycle
  // may since have been skipped — the zero-priced line died with the skip
  // (cycle-scoped edits evaporate) while the grant stayed ADDED forever:
  // consumeCycleOnSuccess only flips grants on the cycle that settles, and
  // clearShippedGiftMirrors only clears SHIPPED grants, so without this read
  // the portal shows a free gift on every future order that never ships.
  const pendingGrants = await prisma.giftGrant.findMany({
    where: {
      contractId: contract.id,
      cycleIndex: { lte: cycleIndex },
      status: { in: ["SCHEDULED", "ADDED"] },
    },
    include: { rule: true },
  });
  const scheduledGrants = pendingGrants.filter(
    (g) => g.status === "SCHEDULED",
  );
  // ADDED at exactly this cycle is the healthy steady state (already attached)
  // and is left alone; only EARLIER-cycle ADDED grants need resolution.
  const strandedAddedGrants = pendingGrants.filter(
    (g) => g.status === "ADDED" && g.cycleIndex < cycleIndex,
  );
  if (
    rules.length === 0 &&
    scheduledGrants.length === 0 &&
    strandedAddedGrants.length === 0 &&
    !ladderRungMatched
  ) {
    result.skipped = "no_rules";
    return result;
  }

  const admin = await adminClientForShop(shop.domain);

  // Resolve the target cycle: gifts only ride on chargeable cycles.
  let expectedDate: Date | null = null;
  try {
    const cycle = await getBillingCycleByIndex(
      admin,
      contract.shopifyContractId,
      cycleIndex,
    );
    if (cycle) {
      if (cycle.skipped || cycle.status === "BILLED") {
        result.skipped = cycle.skipped ? "cycle_skipped" : "cycle_billed";
        return result;
      }
      expectedDate = cycle.billingAttemptExpectedDate;
    }
  } catch (err) {
    // A cycle read failure narrows DAYS_SUBSCRIBED matching (local estimate
    // is used) but never blocks ORDER_INDEX gifts.
    console.error(
      "[gifts] billing cycle read failed",
      contract.shopifyContractId,
      cycleIndex,
      err,
    );
  }
  const cycleDate = estimateCycleDate(
    contract,
    targetOrderNumber,
    expectedDate,
    tz,
  );

  // ── 1. Stranded promises → re-anchor; rules → grants ───────────────────────
  const grantsToAttach: Array<GiftGrant & { rule: GiftRule | null }> = [
    ...scheduledGrants.filter((g) => g.cycleIndex === cycleIndex),
  ];

  // A SCHEDULED grant sitting on an EARLIER cycle index is a promise on its
  // way to being broken: its exact-index attach will never fire once its own
  // cycle can no longer charge (the winback engine used to stamp grants in
  // ordersCount space, which diverges from Shopify's cycle indexes after any
  // skipped or unbilled cycle — the reactivation gift then sat SCHEDULED
  // forever). Re-anchor such grants to the cycle actually being ensured, but
  // ONLY when their own cycle is provably unbillable (skipped, billed or
  // gone): a grant for a future-but-earlier cycle that can still charge (the
  // create-webhook ensures cycles 1 AND 2) keeps riding its own cycle.
  //
  // An ADDED grant on an earlier index needs a status-aware verdict instead:
  //  - its cycle SKIPPED → the committed zero-line died with the skip; revert
  //    the grant to SCHEDULED on THIS cycle and re-attach (fresh cycle edit —
  //    giftAddedEventExists is per (grant, cycle), so the dead commit's marker
  //    does not block the new one). Reverting rather than staying ADDED keeps
  //    the attach retryable: if the re-attach fails, a SCHEDULED grant on the
  //    ensured cycle is retried by every later ensure call, whereas a
  //    re-anchored ADDED grant would claim a line it never committed and then
  //    be flipped SHIPPED by the next settlement without ever shipping.
  //  - its cycle BILLED → the line rode that order; the SHIPPED flip was lost
  //    (consumeCycleOnSuccess raced or a webhook went missing) — flip it here
  //    so mirror hygiene can clear it.
  //  - cycle gone/unreadable → proves nothing about the committed line; leave
  //    the grant alone.
  for (const grant of [
    ...scheduledGrants.filter((g) => g.cycleIndex < cycleIndex),
    ...strandedAddedGrants,
  ]) {
    try {
      let staleCycle: Awaited<ReturnType<typeof getBillingCycleByIndex>> = null;
      try {
        staleCycle = await getBillingCycleByIndex(
          admin,
          contract.shopifyContractId,
          grant.cycleIndex,
        );
      } catch (err) {
        // Transient read failure — leave the grant alone; the next ensure
        // call re-evaluates it. Never re-anchor on uncertainty.
        console.error(
          "[gifts] stranded grant cycle read failed",
          grant.id,
          contract.id,
          err,
        );
        continue;
      }

      if (grant.status === "ADDED") {
        if (staleCycle && !staleCycle.skipped && staleCycle.status === "BILLED") {
          // The gift shipped with that order — only the flip went missing.
          // Stamp shippedAt exactly like consumeCycleOnSuccess does: it is
          // the durable ship fact analytics survive REMOVED flips by.
          await prisma.giftGrant.update({
            where: { id: grant.id },
            data: { status: "SHIPPED", shippedAt: new Date() },
          });
          continue;
        }
        // Only a provably skipped cycle demonstrably killed the committed
        // line. Gone/unreadable cycles prove nothing — leave the grant.
        if (!staleCycle?.skipped) continue;
      } else {
        const unbillable =
          !staleCycle || staleCycle.skipped || staleCycle.status === "BILLED";
        if (!unbillable) continue;
      }

      // The variant may already be promised on this cycle (a rule grant or a
      // prior re-anchor) — one gift per (contract, cycle, variant), so the
      // stranded duplicate must not attach a second free line.
      const duplicate = await prisma.giftGrant.findFirst({
        where: {
          contractId: contract.id,
          cycleIndex,
          variantId: grant.variantId,
          id: { not: grant.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        if (grant.status === "ADDED") {
          // Superseded by the target cycle's own grant for the same variant.
          // Retire this one — left ADDED it would keep the shared isGift
          // mirror "live" forever (clearShippedGiftMirrors protects variants
          // with SCHEDULED/ADDED grants) even after the duplicate ships.
          // Status (and removedAt) only: shippedAt, if a lost-flip repair
          // ever stamped it, is history and survives every REMOVED flip.
          await prisma.giftGrant.update({
            where: { id: grant.id },
            data: { status: "REMOVED", removedAt: new Date() },
          });
          await logEvent({
            shopId: shop.id,
            contractId: contract.id,
            customerId: contract.customerId,
            email: contract.email,
            type: "cycle.gift_removed",
            source: "SYSTEM",
            actor: "gift_engine",
            payload: {
              grantIds: [grant.id],
              cycleIndexes: [grant.cycleIndex],
              variantId: grant.variantId,
              supersededByGrantId: duplicate.id,
              reason: "superseded_by_target_cycle_grant",
            },
          });
        }
        continue;
      }

      const reanchored = await prisma.giftGrant.update({
        where: { id: grant.id },
        data: {
          cycleIndex,
          ...(grant.status === "ADDED"
            ? { status: "SCHEDULED", addedAt: null }
            : {}),
        },
        include: { rule: true },
      });
      grantsToAttach.push(reanchored);
      result.reanchored = (result.reanchored ?? 0) + 1;

      await logEvent({
        shopId: shop.id,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "lifecycle.gift_rescheduled",
        source: "SYSTEM",
        actor: "gift_engine",
        payload: {
          grantId: grant.id,
          ruleId: grant.ruleId,
          variantId: grant.variantId,
          fromCycleIndex: grant.cycleIndex,
          toCycleIndex: cycleIndex,
          reason:
            grant.status === "ADDED"
              ? "added_grant_cycle_skipped"
              : "stranded_scheduled_grant",
        },
      });
    } catch (err) {
      result.errors += 1;
      console.error(
        "[gifts] stranded grant re-anchor failed",
        grant.id,
        contract.id,
        err,
      );
    }
  }

  // Grants already occupying this cycle, for the per-cycle cap: ADDED rows at
  // exactly this index (healthy steady state, not in grantsToAttach) plus
  // everything queued to attach. One box should feel generous, not bought —
  // when a save/win-back/reward grant already rides this cycle, rule gifts
  // stand down (gifts.maxGiftsPerCycle, default 1).
  const addedOnThisCycle = pendingGrants.filter(
    (g) => g.status === "ADDED" && g.cycleIndex === cycleIndex,
  ).length;
  const giftsOnThisCycle = () => addedOnThisCycle + grantsToAttach.length;

  /**
   * Create a grant + its lifecycle.gift_scheduled event and (optionally) the
   * gift_announcement email, shared by the rule loop and the ladder block.
   * The announcement's gift_title always names the ACTUAL granted variant —
   * the truth-in-emails rule: never announce a product the grant won't ship.
   */
  const createGrant = async (input: {
    ruleId: string | null;
    ruleName: string;
    trigger: string;
    variantId: string;
    variantTitle: string | null;
    unitCostCents: number | null;
    source: string;
    announce: boolean;
    /** Live enrichment for the announcement email; undefined = fetch when announcing. */
    imageUrl?: string | null;
    retailCents?: number | null;
  }): Promise<void> => {
    const created = await prisma.giftGrant.create({
      data: {
        contractId: contract.id,
        ruleId: input.ruleId,
        cycleIndex,
        variantId: input.variantId,
        status: "SCHEDULED",
        unitCostCents: input.unitCostCents,
        source: input.source,
      },
      include: { rule: true },
    });
    result.grantsCreated += 1;
    grantsToAttach.push(created);

    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "lifecycle.gift_scheduled",
      source: "SYSTEM",
      actor: "gift_engine",
      payload: {
        grantId: created.id,
        ruleId: input.ruleId,
        ruleName: input.ruleName,
        trigger: input.trigger,
        cycleIndex,
        orderNumber: targetOrderNumber,
        variantId: input.variantId,
        variantTitle: input.variantTitle,
        announceInAdvance: input.announce,
      },
    });

    // "Stay subscribed and get X" teaser — deduped per cycle so re-runs
    // never re-announce. The email shows the actual product: photo, shelf
    // price and arrival date, composed as localized lines (the body's
    // {gift_image_line}/{gift_worth_line}/{gift_date_line} slots).
    if (input.announce) {
      const sent = await hasSentForCycle(
        contract.id,
        "gift_announcement",
        cycleIndex,
      );
      if (!sent) {
        let imageUrl = input.imageUrl;
        let retailCents = input.retailCents;
        if (imageUrl === undefined || retailCents === undefined) {
          const variant = await fetchVariant(admin, input.variantId);
          imageUrl = imageUrl ?? variant?.imageUrl ?? null;
          retailCents = retailCents ?? variant?.priceCents ?? null;
        }
        const giftTitle = input.variantTitle ?? input.ruleName;
        await sendNotification({
          shopId: shop.id,
          contractId: contract.id,
          template: "gift_announcement",
          vars: {
            cycleIndex,
            gift_title: giftTitle,
            rule_name: input.ruleName,
            gift_variant_id: input.variantId,
            ...(cycleDate ? { gift_cycle_date: cycleDate.toISOString() } : {}),
            ...giftEmailLines({
              locale: contract.locale,
              title: giftTitle,
              imageUrl,
              retailCents,
              currencyCode: contract.currencyCode,
              arrivalDate: cycleDate,
              tz,
            }),
          },
        });
        result.announced += 1;
      }
    }
  };

  for (const rule of rules) {
    try {
      if (!ruleMatchesCycle(rule, contract, targetOrderNumber, cycleDate, tz)) {
        continue;
      }
      result.rulesMatched += 1;

      // An anniversary fires ONCE per (contract, rule, multiple). The cycle
      // window is (previous cycle date, cycle date] with the previous date
      // computed by a calendar step back — and a MONTH step back from a
      // clamped month-end (Feb 28 → Jan 28) reaches PAST the real previous
      // cycle date (Jan 31), so a milestone in the overlap would match two
      // consecutive cycles. The count guard makes that impossible: the k-th
      // anniversary grant is the k-th grant this rule produced, so a repeat
      // rule that already produced k grants owes nothing until multiple k+1
      // (non-repeat rules have k=1 — the pre-0024 behavior). A grant parked
      // on a skipped cycle is re-anchored by the pending-grant machinery
      // above, never re-created here.
      if (rule.trigger === "DAYS_SUBSCRIBED") {
        const k =
          anniversaryIndexForCycle(rule, contract, cycleDate, tz) ?? 1;
        const priorForRule = await prisma.giftGrant.count({
          where: { contractId: contract.id, ruleId: rule.id },
        });
        if (priorForRule >= k) continue;
      }

      // ORDER_INDEX rules fire ONCE per (contract, rule), ever — the promise
      // is about one specific order. Without this, a skip that shifts the
      // cycle↔order mapping after a grant was pre-attached under the fresh-
      // contract assumption lets the order-space rematch grant it a second
      // time on the shifted cycle (double COGS, duplicate surprise). The
      // re-anchor machinery moves the EXISTING row, so it is never blocked
      // by this guard.
      if (rule.trigger === "ORDER_INDEX") {
        const priorForRule = await prisma.giftGrant.count({
          where: { contractId: contract.id, ruleId: rule.id },
        });
        if (priorForRule >= 1) continue;
      }

      // Handled guard: one grant per (contract, cycle, variant) for FIXED
      // rules — any existing grant (whatever its status) means this gift was
      // handled. DYNAMIC rules vary the variant per customer, so their
      // handled mark is (contract, cycle, rule) instead.
      const existing = await prisma.giftGrant.findFirst({
        where:
          rule.selection === "DYNAMIC"
            ? { contractId: contract.id, cycleIndex, ruleId: rule.id }
            : { contractId: contract.id, cycleIndex, variantId: rule.variantId },
        include: { rule: true },
      });
      if (existing) {
        if (existing.status === "SCHEDULED") {
          const queued = grantsToAttach.some((g) => g.id === existing.id);
          if (!queued) grantsToAttach.push(existing);
        }
        continue;
      }

      if (giftsOnThisCycle() >= giftsSettings.maxGiftsPerCycle) continue;

      // gift2 holdout: the cycle-2 surprise is the app's standing experiment
      // — a deterministic slice of customers gets no gift (and no teaser, the
      // lifecycle engine checks the same arm), so months from now the cohort
      // numbers can say what the gift actually earns. This is THE divergence
      // point, so exposure is recorded here. Win-back perks and first-order
      // gifts are different moments and stay outside the experiment.
      if (rule.trigger === "ORDER_INDEX" && rule.orderIndex === 2) {
        const arm = await surpriseGiftArmFor(contract);
        if (arm === "no_gift") {
          // Promise-keeping guard: a stop→re-enable of the experiment can
          // leave a customer who was TEASED (arm resolved "gift" at order 1)
          // resolving "no_gift" now. A sent teaser outranks the arm — the
          // promise ships, and the contamination is logged so readouts can
          // drop the unit instead of counting a teased customer as holdout.
          const teased = await hasSentForCycle(
            contract.id,
            "gift_teaser",
            targetOrderNumber,
          );
          if (!teased) continue;
          await logEvent({
            shopId: shop.id,
            contractId: contract.id,
            customerId: contract.customerId,
            email: contract.email,
            type: "experiment.contaminated",
            source: "SYSTEM",
            actor: "gift_engine",
            payload: {
              experimentKey: "gift2_holdout",
              reason: "teaser_sent_before_no_gift_arm",
              orderNumber: targetOrderNumber,
            },
          });
        }
      }

      // Resolve the variant this grant will carry. DYNAMIC rules pick the
      // best product for THIS customer from gifts.pool (new to them, likely
      // wanted); a null pick falls back to the rule's fixed variant, so a
      // DYNAMIC rule can never grant less than a FIXED one.
      let variantId = rule.variantId;
      let variantTitle = rule.variantTitle;
      let grantUnitCostCents: number | null = null;
      let pickImageUrl: string | null | undefined;
      let pickRetailCents: number | null | undefined;
      if (rule.selection === "DYNAMIC") {
        const pick = await pickGiftForContract({
          shopId: shop.id,
          admin,
          contract,
          excludeVariantIds: [
            ...grantsToAttach.map((g) => g.variantId),
            ...pendingGrants
              .filter((g) => g.cycleIndex === cycleIndex)
              .map((g) => g.variantId),
          ],
        });
        if (pick) {
          variantId = pick.variantId;
          variantTitle = pick.label;
          grantUnitCostCents = pick.unitCostCents;
          pickImageUrl = pick.imageUrl;
          pickRetailCents = pick.retailCents;
        }
      }

      // The resolved variant may collide with a grant another producer
      // created for this cycle under a different rule identity — keep the
      // one-grant-per-(contract, cycle, variant) invariant. This runs for
      // EVERY dynamic rule (a null pick falls back to rule.variantId, which
      // the rule-scoped handled guard above cannot see), matching the ladder
      // block's unconditional check.
      if (rule.selection === "DYNAMIC" || variantId !== rule.variantId) {
        const dupe = await prisma.giftGrant.findFirst({
          where: { contractId: contract.id, cycleIndex, variantId },
          include: { rule: true },
        });
        if (dupe) {
          if (dupe.status === "SCHEDULED") {
            const queued = grantsToAttach.some((g) => g.id === dupe.id);
            if (!queued) grantsToAttach.push(dupe);
          }
          continue;
        }
      }

      await createGrant({
        ruleId: rule.id,
        ruleName: rule.name,
        trigger: rule.trigger,
        variantId,
        variantTitle,
        unitCostCents: grantUnitCostCents,
        source: "RULE",
        announce: rule.announceInAdvance,
        imageUrl: pickImageUrl,
        retailCents: pickRetailCents,
      });
    } catch (err) {
      result.errors += 1;
      console.error(
        "[gifts] rule evaluation failed",
        rule.id,
        contract.id,
        err,
      );
    }
  }

  // ── 1b. Milestone-ladder rungs (no GiftRule row — dynamic grants) ──────────
  // lifecycle.milestoneLadder keeps the goal-gradient alive past the base
  // milestone: order 12, 18, 24... each gets a gift, always announced (a
  // pre-announced reward is the whole point of a ladder). The variant is
  // picked per customer; when the pool yields nothing the base milestone
  // rule's variant is the fallback, and with neither the rung grants nothing
  // — the milestone email then omits the gift promise (truth gate).
  if (ladderRungMatched) {
    try {
      const priorLadderGrant = await prisma.giftGrant.findFirst({
        where: { contractId: contract.id, cycleIndex, source: "LADDER" },
        select: { id: true },
      });
      if (
        !priorLadderGrant &&
        giftsOnThisCycle() < giftsSettings.maxGiftsPerCycle
      ) {
        const pick = await pickGiftForContract({
          shopId: shop.id,
          admin,
          contract,
          excludeVariantIds: [
            ...grantsToAttach.map((g) => g.variantId),
            ...pendingGrants
              .filter((g) => g.cycleIndex === cycleIndex)
              .map((g) => g.variantId),
          ],
        });
        const baseMilestoneRule = pick
          ? null
          : rules.find(
              (r) =>
                r.trigger === "ORDER_INDEX" &&
                r.orderIndex === lifecycle.milestoneGiftCycle,
            ) ?? null;
        const variantId = pick?.variantId ?? baseMilestoneRule?.variantId;
        if (variantId) {
          const dupe = await prisma.giftGrant.findFirst({
            where: { contractId: contract.id, cycleIndex, variantId },
            select: { id: true },
          });
          if (!dupe) {
            await createGrant({
              ruleId: null,
              ruleName: `Milestone ladder — order ${targetOrderNumber}`,
              trigger: "MILESTONE_LADDER",
              variantId,
              variantTitle:
                pick?.label ?? baseMilestoneRule?.variantTitle ?? null,
              unitCostCents: pick?.unitCostCents ?? null,
              source: "LADDER",
              announce: true,
              imageUrl: pick?.imageUrl,
              retailCents: pick?.retailCents,
            });
          }
        }
      }
    } catch (err) {
      result.errors += 1;
      console.error(
        "[gifts] milestone-ladder grant failed",
        contract.id,
        targetOrderNumber,
        err,
      );
    }
  }

  // ── 2. Attach every SCHEDULED grant to the cycle ───────────────────────────
  for (const grant of grantsToAttach) {
    try {
      await attachGrantToCycle(admin, shop, contract, grant);
      result.linesAdded += 1;
    } catch (err) {
      // Grant stays SCHEDULED — the next ensure call retries the attach.
      result.errors += 1;
      console.error("[gifts] gift attach failed", grant.id, contract.id, err);
    }
  }

  return result;
}

/**
 * Clear local isGift mirror lines whose grant has SHIPPED (the cycle billed
 * and the cycle-scoped edit expired with it — Shopify already "removed" the
 * gift, that's the point of the Billing Cycles API). Marks those grants
 * REMOVED and logs one cycle.gift_removed event. Returns lines deleted.
 */
export async function clearShippedGiftMirrors(
  contractLocalId: string,
): Promise<number> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) return 0;

  const shippedGrants = await prisma.giftGrant.findMany({
    where: { contractId: contract.id, status: "SHIPPED" },
  });
  if (shippedGrants.length === 0) return 0;

  // A variant is still "live" when a SCHEDULED/ADDED grant references it —
  // its mirror belongs to the upcoming cycle and must survive the clear.
  // Cycle-0 grants are excluded: the first-order gift is terminally ADDED on
  // the synthetic origin-order index forever, and letting it protect its
  // variant made any later engine grant of the same product an immortal
  // phantom line in the portal.
  const liveGrants = await prisma.giftGrant.findMany({
    where: {
      contractId: contract.id,
      status: { in: ["SCHEDULED", "ADDED"] },
      cycleIndex: { gte: 1 },
    },
    select: { variantId: true },
  });
  const liveVariantIds = new Set(liveGrants.map((g) => g.variantId));

  const shippedVariantIds = new Set(
    shippedGrants
      .map((g) => g.variantId)
      .filter((variantId) => !liveVariantIds.has(variantId)),
  );
  const mirrorLines = contract.lines.filter(
    (line) => line.isGift && shippedVariantIds.has(line.variantId),
  );

  const now = new Date();
  if (mirrorLines.length > 0) {
    await prisma.contractLine.deleteMany({
      where: { id: { in: mirrorLines.map((l) => l.id) } },
    });
  }
  // Status (and removedAt) only: shippedAt is the durable "this gift left
  // the building" fact — the REMOVED flip is mirror hygiene and must never
  // erase it (analytics count gift COGS by it).
  await prisma.giftGrant.updateMany({
    where: { id: { in: shippedGrants.map((g) => g.id) } },
    data: { status: "REMOVED", removedAt: now },
  });

  // Logged whenever grants flipped, not only when a mirror line came off:
  // a variant whose mirror was kept alive by a still-live grant (or whose
  // mirror was already gone) still transitions SHIPPED→REMOVED here, and a
  // silent status flip would break the every-mutation-logs-an-event rule.
  await logEvent({
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "cycle.gift_removed",
    source: "SYSTEM",
    actor: "gift_engine",
    payload: {
      grantIds: shippedGrants.map((g) => g.id),
      cycleIndexes: shippedGrants.map((g) => g.cycleIndex),
      titles: mirrorLines.map((l) => l.title),
      mirrorLinesCleared: mirrorLines.length,
      reason: "shipped_cycle_scoped_edit_expired",
    },
  });

  return mirrorLines.length;
}

/**
 * Post-cycle gift removal. The cycle-scoped edit already auto-reverted on
 * Shopify when the cycle billed, so the only work is local mirror hygiene.
 */
export async function removeGiftAfterCycle(
  contractLocalId: string,
): Promise<{ removed: number }> {
  const removed = await clearShippedGiftMirrors(contractLocalId);
  return { removed };
}

// ── Daily sweep ──────────────────────────────────────────────────────────────

/**
 * One INFO alert (ever) when settings.lifecycle.surpriseGiftOnCycle2 is on but
 * no active ORDER_INDEX=2 GiftRule exists. A gift needs a real variant — the
 * engine cannot invent one, so it asks the merchant to create the rule.
 */
async function suggestSurpriseGiftRule(shop: Shop): Promise<void> {
  try {
    const lifecycle = await getSetting(shop.id, "lifecycle");
    if (!lifecycle.surpriseGiftOnCycle2) return;

    const rule = await prisma.giftRule.findFirst({
      where: {
        shopId: shop.id,
        active: true,
        trigger: "ORDER_INDEX",
        orderIndex: 2,
      },
      select: { id: true },
    });
    if (rule) return;

    const already = await prisma.alert.findFirst({
      where: { shopId: shop.id, type: GIFT_RULE_SUGGESTION_ALERT },
      select: { id: true },
    });
    if (already) return;

    const alert = await prisma.alert.create({
      data: {
        shopId: shop.id,
        type: GIFT_RULE_SUGGESTION_ALERT,
        severity: "INFO",
        message:
          "The cycle-2 surprise gift is enabled (settings.lifecycle.surpriseGiftOnCycle2) but no active gift rule with trigger ORDER_INDEX and order index 2 exists. Create one in Gifts and pick the gift variant — until then no surprise gift ships.",
        context: { setting: "lifecycle.surpriseGiftOnCycle2", orderIndex: 2 },
      },
    });
    await logEvent({
      shopId: shop.id,
      type: "alert.raised",
      source: "SYSTEM",
      actor: "gift_engine",
      payload: { alertId: alert.id, alertType: GIFT_RULE_SUGGESTION_ALERT },
    });
  } catch (err) {
    console.error("[gifts] surprise-gift rule suggestion failed", err);
  }
}

/**
 * Daily job (gifts_run): for every ACTIVE contract billing within 7 days,
 * ensure the upcoming cycle carries its earned gifts; then clear mirrors of
 * gifts that shipped; then run the settings-driven built-in checks. Every
 * contract is contained — one failure never stops the sweep.
 *
 * The upcoming cycle is resolved from Shopify by nextBillingDate, NOT assumed
 * to be ordersCount + 1: Shopify cycle indexes drift ahead of ordersCount by
 * one for every skipped cycle, so the ordersCount + 1 CYCLE of a
 * subscriber who ever skipped is an old skipped/billed cycle — the ensure
 * call short-circuited on it and this job was a permanent no-op for the
 * contract. ordersCount + 1 remains the ORDER number the resolved cycle will
 * become (rule matching), and the fallback cycle index when the read fails.
 */
export async function runGiftScheduling(now: Date): Promise<GiftSchedulingStats> {
  const stats: GiftSchedulingStats = {
    scanned: 0,
    rulesMatched: 0,
    grantsCreated: 0,
    linesAdded: 0,
    announced: 0,
    mirrorsCleared: 0,
    errors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }

  const horizon = addDaysTz(now, 7, shop.ianaTimezone);
  const upcoming = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      ...OURS_ONLY, // another app's contracts are not ours to edit or gift
      isDemo: false, // demo fixture: fake GID + static date inside the horizon
      status: "ACTIVE",
      nextBillingDate: { not: null, lte: horizon },
    },
    select: {
      id: true,
      ordersCount: true,
      shopifyContractId: true,
      nextBillingDate: true,
    },
    orderBy: { nextBillingDate: "asc" },
  });

  // One admin client for the whole sweep, created lazily so a shop with no
  // gift work never opens a session at all.
  let admin: AdminClient | null = null;

  for (const contract of upcoming) {
    stats.scanned += 1;
    try {
      const orderNumber = contract.ordersCount + 1;
      // Fallback when the cycle read fails: aligned spaces (no skips) — the
      // pre-fix behavior, and correct for the vast majority of contracts.
      let cycleIndex = orderNumber;
      try {
        admin ??= await adminClientForShop(shop.domain);
        const cycle = contract.nextBillingDate
          ? await getBillingCycleByDate(
              admin,
              contract.shopifyContractId,
              contract.nextBillingDate,
            )
          : null;
        if (cycle) cycleIndex = cycle.cycleIndex;
      } catch (err) {
        console.error(
          "[gifts] upcoming cycle resolution failed — falling back to order-number space",
          contract.id,
          err,
        );
      }
      const result = await ensureGiftsForUpcomingCycle(
        contract.id,
        cycleIndex,
        orderNumber,
      );
      stats.rulesMatched += result.rulesMatched;
      stats.grantsCreated += result.grantsCreated;
      stats.linesAdded += result.linesAdded;
      stats.announced += result.announced;
      stats.errors += result.errors;
    } catch (err) {
      stats.errors += 1;
      console.error("[gifts] scheduling failed for contract", contract.id, err);
    }
  }

  // Mirror hygiene: gifts that shipped with a billed cycle come off the local
  // mirror so the portal never shows a stale free item.
  const withShipped = await prisma.giftGrant.findMany({
    where: {
      status: "SHIPPED",
      contract: { shopId: shop.id, ...OURS_ONLY, isDemo: false },
    },
    select: { contractId: true },
    distinct: ["contractId"],
  });
  for (const { contractId } of withShipped) {
    try {
      stats.mirrorsCleared += await clearShippedGiftMirrors(contractId);
    } catch (err) {
      stats.errors += 1;
      console.error("[gifts] mirror clear failed", contractId, err);
    }
  }

  await suggestSurpriseGiftRule(shop);

  return stats;
}
