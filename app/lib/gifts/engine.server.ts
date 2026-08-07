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
import { addDaysTz, addWeeksTz } from "~/lib/dates.server";
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
  return addWeeksTz(
    contract.nextBillingDate,
    delta * Math.max(1, contract.intervalWeeks),
    tz,
  );
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
    if (rule.daysSubscribed == null || !contract.firstChargeAt || !cycleDate) {
      return false;
    }
    const milestone = addDaysTz(contract.firstChargeAt, rule.daysSubscribed, tz);
    const windowStart = addWeeksTz(
      cycleDate,
      -Math.max(1, contract.intervalWeeks),
      tz,
    );
    return (
      milestone.getTime() > windowStart.getTime() &&
      milestone.getTime() <= cycleDate.getTime()
    );
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
  }

  const now = new Date();
  await prisma.giftGrant.update({
    where: { id: grant.id },
    data: { status: "ADDED", addedAt: now },
  });

  // Mirror line for portal display / analytics. Reuse an existing gift mirror
  // for the same variant (a prior cycle's mirror not yet cleared) so the
  // portal never shows the same gift twice.
  const variant = await fetchVariant(admin, grant.variantId);
  const title =
    variant?.productTitle || grant.rule?.variantTitle || grant.rule?.name || "Gift";
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

  if (!alreadyCommitted) {
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
        unitCostCents: grant.rule?.unitCostCents ?? null,
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
    strandedAddedGrants.length === 0
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
          await prisma.giftGrant.update({
            where: { id: grant.id },
            data: { status: "SHIPPED" },
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
          await prisma.giftGrant.update({
            where: { id: grant.id },
            data: { status: "REMOVED", removedAt: new Date() },
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

  for (const rule of rules) {
    try {
      if (!ruleMatchesCycle(rule, contract, targetOrderNumber, cycleDate, tz)) {
        continue;
      }
      result.rulesMatched += 1;

      // Unique-ish guard: one grant per (contract, cycle, variant) — any
      // existing grant (whatever its status) means this gift was handled.
      const existing = await prisma.giftGrant.findFirst({
        where: {
          contractId: contract.id,
          cycleIndex,
          variantId: rule.variantId,
        },
        include: { rule: true },
      });
      if (existing) {
        if (existing.status === "SCHEDULED") {
          const queued = grantsToAttach.some((g) => g.id === existing.id);
          if (!queued) grantsToAttach.push(existing);
        }
        continue;
      }

      const created = await prisma.giftGrant.create({
        data: {
          contractId: contract.id,
          ruleId: rule.id,
          cycleIndex,
          variantId: rule.variantId,
          status: "SCHEDULED",
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
          ruleId: rule.id,
          ruleName: rule.name,
          trigger: rule.trigger,
          cycleIndex,
          orderNumber: targetOrderNumber,
          variantId: rule.variantId,
          variantTitle: rule.variantTitle,
          announceInAdvance: rule.announceInAdvance,
        },
      });

      // "Stay subscribed and get X" teaser — deduped per cycle so re-runs
      // never re-announce. The Klaviyo flow owns the actual email.
      if (rule.announceInAdvance) {
        const sent = await hasSentForCycle(
          contract.id,
          "gift_announcement",
          cycleIndex,
        );
        if (!sent) {
          await sendNotification({
            shopId: shop.id,
            contractId: contract.id,
            template: "gift_announcement",
            vars: {
              cycleIndex,
              gift_title: rule.variantTitle ?? rule.name,
              rule_name: rule.name,
              ...(cycleDate ? { gift_cycle_date: cycleDate.toISOString() } : {}),
            },
          });
          result.announced += 1;
        }
      }
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
  const liveGrants = await prisma.giftGrant.findMany({
    where: {
      contractId: contract.id,
      status: { in: ["SCHEDULED", "ADDED"] },
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
  await prisma.giftGrant.updateMany({
    where: { id: { in: shippedGrants.map((g) => g.id) } },
    data: { status: "REMOVED", removedAt: now },
  });

  if (mirrorLines.length > 0) {
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
        reason: "shipped_cycle_scoped_edit_expired",
      },
    });
  }

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
