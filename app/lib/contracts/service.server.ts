import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz, addIntervalTz, addWeeksTz } from "~/lib/dates.server";
import {
  FREQUENCY_COUNT_LIMITS,
  type Frequency,
  approxWeeks,
  contractFrequency,
  sameFrequency,
} from "~/lib/frequency";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { releaseHeldCycleAttempts } from "~/lib/billing/release.server";
import {
  ShopifyUserError,
  contractActivate,
  contractCancel,
  contractPause,
  draftLineAdd,
  draftLineRemove,
  draftLineUpdate,
  draftUpdateAddress,
  draftUpdateBillingPolicy,
  draftUpdateDeliveryPolicy,
  draftUpdatePaymentMethod,
  getBillingCycleByDate,
  getVariants,
  listCustomerPaymentMethods,
  scheduleEditBillingCycle,
  setNextBillingDate as shopifySetNextBillingDate,
  skipBillingCycle,
  unskipBillingCycle,
  withBillingCycleEdit,
  withContractDraft,
  type DeliveryAddressInput,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import {
  eventIdentity,
  fetchNextBillingDate,
  loadContractContext,
  ongoingDiscountedPriceCents,
  reloadContract,
  resolveActor,
  resolveSource,
  withMirrorGuard,
  type ContractContext,
  type LocalContractWithLines,
  type ServiceOptions,
} from "./shared.server";

/**
 * Contract services — the domain layer everything else (portal, magic links,
 * admin UI, cancel flow, billing, webhooks, jobs) calls.
 *
 * Every function: `(shopDomain, contractLocalId, ...args, options?)` — loads
 * the local mirror + admin client, performs the Shopify mutation(s) through
 * the graphql layer, updates the mirror, logs a canonical event with the
 * caller's `{ source, actor }` (default SYSTEM), and returns the updated
 * local contract with lines. Functions are idempotent where the operation
 * allows it (calling twice is safe and does not double-log).
 */

// ── Internal helpers ─────────────────────────────────────────────────────────

function requireNextBillingDate(ctx: ContractContext): Date {
  const date = ctx.contract.nextBillingDate;
  if (!date) {
    throw new Error(
      `Contract ${ctx.contract.id} has no nextBillingDate — cannot resolve its next billing cycle`,
    );
  }
  return date;
}

async function requireVariant(
  ctx: ContractContext,
  variantId: string,
): Promise<ShopifyVariant> {
  const [variant] = await getVariants(ctx.admin, [variantId]);
  if (!variant) {
    throw new Error(`Product variant not found on Shopify: ${variantId}`);
  }
  return variant;
}

// ── Skip / unskip ────────────────────────────────────────────────────────────

/**
 * Who triggered a skip. CUSTOMER (the default — every portal/magic-link
 * caller keeps today's behavior without changes) counts toward the
 * customer's own skip behavior: skipCount and lastSkippedAt feed the
 * risk/win-back models as disengagement signals. ADMIN and STOCKOUT are
 * merchant operations — a mass stockout skip must not make a loyal
 * subscriber look disengaged — so they count in merchantSkipCount instead
 * (migration 0016) and never stamp lastSkippedAt.
 */
export type SkipInitiator = "CUSTOMER" | "ADMIN" | "STOCKOUT";

export interface SkipCycleOptions extends ServiceOptions {
  initiator?: SkipInitiator;
  /** Why the initiator skipped ("stockout_tool", "SKIP_NOTIFY", …) — carried
   * verbatim into the cycle.skipped payload. */
  reason?: string;
}

/**
 * Skip the next billing cycle (per-cycle — the contract cadence is untouched).
 * Idempotent: a second call while the cycle is already skipped is a no-op.
 * One-time add-ons staged on the skipped cycle are removed first (Shopify
 * line + mirror + claim key) — a skipped cycle never settles, so nothing
 * else would ever clear them.
 */
export async function skipNextCycle(
  shopDomain: string,
  contractLocalId: string,
  options?: SkipCycleOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }
  if (cycle.skipped) return reloadContract(contract.id); // already skipped

  // ── Clear one-time add-ons staged on the cycle being skipped ───────────────
  // A skipped cycle never settles, and consumeCycleOnSuccess clears add-on
  // mirrors only when THEIR cycle settles (exact addonCycleIndex match) — so
  // without this, an add-on riding the skipped cycle survived forever: the
  // portal kept promising it "with your next order" while no future order
  // contained it, and its permanently-unique addClaimKey turned every later
  // re-add of the same variant into a silent "already staged" no-op.
  //
  // Removed BEFORE the Shopify skip commits, Shopify line first and mirror
  // second: the cycle edit would otherwise still hold the line if the cycle
  // were later unskipped (an invisible charge with nothing to remove in the
  // portal), and a non-user error at any point aborts the whole skip while
  // everything is still consistent — the customer retries and the loop
  // re-runs idempotently (a line already gone on Shopify is tolerated, the
  // mirror delete matches zero rows). Legacy mirrors with NULL
  // addonCycleIndex are left alone on purpose: their staged cycle is
  // unknowable locally, and consumeCycleOnSuccess's OR-null clause clears
  // them on the NEXT settlement anyway — they cannot strand.
  const stagedAddons = contract.lines.filter(
    (l) => l.isOneTimeAddon && l.addonCycleIndex === cycle.cycleIndex,
  );
  for (const line of stagedAddons) {
    if (line.shopifyLineId) {
      const shopifyLineId = line.shopifyLineId;
      try {
        await withBillingCycleEdit(
          admin,
          contract.shopifyContractId,
          { index: cycle.cycleIndex },
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      } catch (err) {
        // Nothing has been skipped yet — an infrastructure error is fully
        // retryable, so it must abort rather than half-clean.
        if (!(err instanceof ShopifyUserError)) throw err;
        // Line already gone on Shopify (or removed by a concurrent edit):
        // the mirror is what diverged — log and continue so it catches up.
        console.error(
          "[contracts] skipNextCycle: Shopify rejected add-on line removal, treating as already removed",
          contract.id,
          shopifyLineId,
          err.message,
        );
      }
    }
    // deleteMany, not delete: a concurrent portal removal racing this skip
    // must not turn the cleanup into a P2025 crash mid-flight.
    await withMirrorGuard("skipNextCycle", ctx, options, () =>
      prisma.contractLine.deleteMany({ where: { id: line.id } }),
    );
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "cycle.addon_removed",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        lineId: line.id,
        variantId: line.variantId,
        title: line.title,
        isGift: line.isGift,
        isOneTimeAddon: true,
        cycleIndex: cycle.cycleIndex,
        reason: "cycle_skipped",
      },
    });
  }

  await skipBillingCycle(admin, contract.shopifyContractId, {
    index: cycle.cycleIndex,
  });

  // Recompute the next billing date: prefer Shopify's own view; if it has not
  // advanced past the skipped cycle, add one interval in the shop timezone.
  let newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    null,
  );
  if (!newNext || newNext.getTime() <= nextBillingDate.getTime()) {
    const freq = contractFrequency(contract);
    newNext = addIntervalTz(
      nextBillingDate,
      freq.unit,
      freq.count,
      shop.ianaTimezone,
    );
  }

  const initiator: SkipInitiator = options?.initiator ?? "CUSTOMER";
  await withMirrorGuard("skipNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        nextBillingDate: newNext,
        // CUSTOMER skips are behavior signals; merchant-driven skips count
        // in their own column so a bulk stockout op can never contaminate
        // the customer's disengagement profile (see SkipInitiator).
        ...(initiator === "CUSTOMER"
          ? { skipCount: { increment: 1 }, lastSkippedAt: new Date() }
          : { merchantSkipCount: { increment: 1 } }),
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.skipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      // Always present, so stream analytics can split customer skips from
      // merchant skips without joining against the mirror columns.
      initiator,
      reason: options?.reason ?? null,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: newNext.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

/**
 * Un-skip the most recently skipped upcoming cycle. Idempotent: when no
 * skipped cycle can be found, returns the contract unchanged.
 */
export async function unskipNextCycle(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  const tz = shop.ianaTimezone;

  // After a skip, the skipped cycle sits one interval before the (advanced)
  // nextBillingDate. Probe there first, then at the current date.
  const unskipFreq = contractFrequency(contract);
  const previousDate = addIntervalTz(
    nextBillingDate,
    unskipFreq.unit,
    unskipFreq.count,
    tz,
    -1,
  );
  let cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    previousDate,
  );
  if (!cycle?.skipped) {
    cycle = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      nextBillingDate,
    );
  }
  if (!cycle?.skipped) return reloadContract(contract.id); // nothing to unskip

  await unskipBillingCycle(admin, contract.shopifyContractId, {
    index: cycle.cycleIndex,
  });

  let newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    null,
  );
  if (!newNext || newNext.getTime() >= nextBillingDate.getTime()) {
    newNext = cycle.billingAttemptExpectedDate ?? previousDate;
  }

  // Which counter does this unskip reverse? cycle.skipped events always
  // carry { initiator }: merchant-driven skips (ADMIN/STOCKOUT) counted in
  // merchantSkipCount, customer skips in skipCount — so the reversal must
  // decrement the SAME column. Decrementing skipCount unconditionally let an
  // admin skip+unskip pair erase a genuine customer-disengagement signal
  // while the merchant counter stayed overstated — wrong inputs to the
  // risk/win-back models on both columns. Prefer the skip staged on this
  // exact cycle; fall back to the most recent skip, then to CUSTOMER
  // (pre-initiator history holds only customer skips). Floored at zero like
  // the original.
  const recentSkips = await prisma.subscriberEvent.findMany({
    where: { contractId: contract.id, type: "cycle.skipped" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { payload: true },
  });
  const skipPayload = (e: { payload: unknown }) =>
    (e.payload ?? {}) as { cycleIndex?: unknown; initiator?: unknown };
  const reversedSkip =
    recentSkips.find((e) => skipPayload(e).cycleIndex === cycle.cycleIndex) ??
    recentSkips[0] ??
    null;
  const reversedInitiator =
    reversedSkip && typeof skipPayload(reversedSkip).initiator === "string"
      ? (skipPayload(reversedSkip).initiator as string)
      : "CUSTOMER";
  const reversesMerchantSkip =
    reversedInitiator === "ADMIN" || reversedInitiator === "STOCKOUT";

  await withMirrorGuard("unskipNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        nextBillingDate: newNext,
        ...(reversesMerchantSkip
          ? {
              merchantSkipCount: Math.max(
                0,
                (contract.merchantSkipCount ?? 0) - 1,
              ),
            }
          : { skipCount: Math.max(0, contract.skipCount - 1) }),
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.unskipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      // The initiator of the skip this unskip reversed — stream analytics
      // can pair skip/unskip without joining the mirror columns.
      reversedInitiator,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: newNext.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

// ── Delay ────────────────────────────────────────────────────────────────────

export interface DelayInput {
  weeks?: number;
  days?: number;
}

/**
 * Push the next billing cycle out by N weeks or days (schedule edit — the
 * contract cadence is untouched; later cycles keep their rhythm).
 */
export async function delayNextCycle(
  shopDomain: string,
  contractLocalId: string,
  delta: DelayInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const weeks = delta.weeks ?? 0;
  const days = delta.days ?? 0;
  if (weeks <= 0 && days <= 0) {
    throw new Error("delayNextCycle requires a positive weeks or days delta");
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  const tz = shop.ianaTimezone;

  let newDate = nextBillingDate;
  if (weeks > 0) newDate = addWeeksTz(newDate, weeks, tz);
  if (days > 0) newDate = addDaysTz(newDate, days, tz);

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }

  const edited = await scheduleEditBillingCycle(
    admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    { billingDate: newDate },
  );
  const effectiveDate = edited?.billingAttemptExpectedDate ?? newDate;

  await withMirrorGuard("delayNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effectiveDate },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.delayed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: effectiveDate.toISOString(),
      ...(weeks > 0 ? { weeks } : {}),
      ...(days > 0 ? { days } : {}),
    },
  });

  return reloadContract(contract.id);
}

// ── Frequency ────────────────────────────────────────────────────────────────

/**
 * Change the billing + delivery cadence. Accepts a multi-unit `Frequency`
 * ({unit, count}) or a bare week count (the pre-v1.8.0 form, still used by
 * week-denominated flows like the cancel save-offer).
 */
export async function changeFrequency(
  shopDomain: string,
  contractLocalId: string,
  frequency: Frequency | number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const freq: Frequency =
    typeof frequency === "number"
      ? { unit: "WEEK", count: frequency }
      : frequency;
  if (!Number.isInteger(freq.count) || freq.count < 1) {
    throw new Error(`Invalid frequency: ${freq.count} ${freq.unit}`);
  }
  const limits = FREQUENCY_COUNT_LIMITS[freq.unit];
  // WEEK keeps its historical wider service-layer ceiling (52 — imported and
  // legacy contracts land anywhere in it); other units follow the plan limits.
  const max = freq.unit === "WEEK" ? 52 : limits?.max;
  if (!limits || freq.count > max) {
    throw new Error(`Invalid frequency: ${freq.count} ${freq.unit}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (sameFrequency(contractFrequency(contract), freq)) {
    return reloadContract(contract.id);
  }

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdateBillingPolicy(run, draftId, {
        interval: freq.unit,
        intervalCount: freq.count,
      });
      await draftUpdateDeliveryPolicy(run, draftId, {
        interval: freq.unit,
        intervalCount: freq.count,
      });
    },
  );

  const newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    contract.nextBillingDate,
  );

  await withMirrorGuard("changeFrequency", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        intervalWeeks: approxWeeks(freq.unit, freq.count),
        billingIntervalUnit: freq.unit,
        billingIntervalCount: freq.count,
        nextBillingDate: newNext,
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.frequency_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      // Week approximations stay first for Klaviyo flows built on them.
      oldWeeks: contract.intervalWeeks,
      newWeeks: approxWeeks(freq.unit, freq.count),
      oldUnit: contract.billingIntervalUnit ?? "WEEK",
      oldCount: contract.billingIntervalCount ?? contract.intervalWeeks,
      newUnit: freq.unit,
      newCount: freq.count,
    },
  });

  return reloadContract(contract.id);
}

// ── Line operations ──────────────────────────────────────────────────────────

/**
 * Swap one line to a different variant, honoring the contract's ongoing
 * discount: grandfathered contracts keep the old line price when swapping
 * within the same product (size change); otherwise the new variant is priced
 * at SellingPlanConfig.ongoingDiscountPct off its catalog price (fallback:
 * the old line's proportional discount ratio).
 */
export async function swapLineVariant(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  newVariantId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.variantId === newVariantId) return reloadContract(contract.id);

  const variant = await requireVariant(ctx, newVariantId);

  const sameProduct =
    variant.productId != null && variant.productId === line.productId;
  const newPriceCents =
    contract.grandfatheredPricing && sameProduct
      ? line.currentPriceCents
      : await ongoingDiscountedPriceCents(shop.id, variant, line);

  const existingShopifyLineId = line.shopifyLineId;
  let newShopifyLineId: string | null = existingShopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      if (existingShopifyLineId) {
        try {
          await draftLineUpdate(run, draftId, existingShopifyLineId, {
            productVariantId: newVariantId,
            quantity: line.quantity,
            currentPriceCents: newPriceCents,
          });
          return;
        } catch (err) {
          // Cross-product swaps can be rejected as in-place updates; fall back
          // to remove + add within the same atomic draft.
          if (!(err instanceof ShopifyUserError)) throw err;
          await draftLineRemove(run, draftId, existingShopifyLineId);
        }
      }
      newShopifyLineId = await draftLineAdd(run, draftId, {
        productVariantId: newVariantId,
        quantity: line.quantity,
        currentPriceCents: newPriceCents,
      });
    },
  );

  await withMirrorGuard("swapLineVariant", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: {
        shopifyLineId: newShopifyLineId,
        productId: variant.productId ?? line.productId,
        variantId: newVariantId,
        title: variant.productTitle || line.title,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        currentPriceCents: newPriceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        addedVia: "SWAP",
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_swapped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      oldVariantId: line.variantId,
      newVariantId,
      oldTitle: line.title,
      newTitle: variant.productTitle,
      oldPriceCents: line.currentPriceCents,
      newPriceCents,
      grandfathered: contract.grandfatheredPricing && sameProduct,
    },
  });

  return reloadContract(contract.id);
}

/** Change one line's quantity. Idempotent for an unchanged quantity. */
export async function changeLineQuantity(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  quantity: number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.quantity === quantity) return reloadContract(contract.id);
  if (!line.shopifyLineId) {
    throw new Error(
      `Contract line ${line.id} has no Shopify line id — resync the contract before editing it`,
    );
  }

  const shopifyLineId = line.shopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftLineUpdate(run, draftId, shopifyLineId, { quantity });
    },
  );

  await withMirrorGuard("changeLineQuantity", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: { quantity },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.quantity_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      oldQuantity: line.quantity,
      newQuantity: quantity,
    },
  });

  return reloadContract(contract.id);
}

/**
 * Directly override one line's recurring unit price (admin support tool —
 * "edit anything"). Contract-level edit: the new price applies to every
 * future cycle until changed again or overwritten by a price-change batch.
 * Idempotent for an unchanged price.
 */
export async function setLinePrice(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  newPriceCents: number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(newPriceCents) || newPriceCents < 0) {
    throw new Error(`Invalid line price: ${newPriceCents} cents`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.currentPriceCents === newPriceCents) {
    return reloadContract(contract.id); // already at the requested price
  }
  if (line.isOneTimeAddon) {
    throw new Error(
      "One-time add-ons live on the next billing cycle, not the contract — remove and re-add the add-on instead of repricing it",
    );
  }
  if (!line.shopifyLineId) {
    throw new Error(
      `Contract line ${line.id} has no Shopify line id — resync the contract before editing it`,
    );
  }

  const shopifyLineId = line.shopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftLineUpdate(run, draftId, shopifyLineId, {
        currentPriceCents: newPriceCents,
      });
    },
  );

  await withMirrorGuard("setLinePrice", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: { currentPriceCents: newPriceCents },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_price_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      oldPriceCents: line.currentPriceCents,
      newPriceCents,
    },
  });

  return reloadContract(contract.id);
}

export interface AddLineOpts {
  isGift?: boolean;
  /** CHECKOUT | PORTAL | MAGIC_LINK | ADMIN | GIFT_ENGINE | SWAP */
  addedVia?: string;
}

/**
 * Add a recurring line: gifts at price 0, everything else at the ongoing
 * subscription discount. Idempotent: an existing line with the same variant,
 * gift flag and quantity is treated as this call already applied.
 *
 * Concurrency (non-gift adds — the portal/admin paths): same claim-first
 * shape as addOneTimeAddon under addClaimKey "line:{contractId}:{variantId}"
 * — the mirror row is created BEFORE the multi-second Shopify draft, and a
 * concurrent duplicate loses on P2002 and no-ops instead of appending the
 * same variant to the contract twice. Gift-engine lines never claim: gifts
 * are managed per grant with their own idempotency, and a gift of a variant
 * the customer also buys must never block or be blocked by the paid line.
 */
export async function addLine(
  shopDomain: string,
  contractLocalId: string,
  variantId: string,
  quantity: number,
  opts?: AddLineOpts,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const isGift = opts?.isGift ?? false;
  const addedVia = opts?.addedVia ?? "PORTAL";

  // Fast path only — for non-gift adds the race-proof guard is addClaimKey.
  const existing = contract.lines.find(
    (l) =>
      l.variantId === variantId &&
      l.isGift === isGift &&
      !l.isOneTimeAddon &&
      l.quantity === quantity,
  );
  if (existing) return reloadContract(contract.id); // already applied

  const variant = await requireVariant(ctx, variantId);
  const priceCents = isGift
    ? 0
    : await ongoingDiscountedPriceCents(shop.id, variant);

  // ── Atomic claim: mirror row FIRST, Shopify draft second ───────────────────
  let created: { id: string };
  try {
    created = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyLineId: null, // stamped after the draft commits
        productId: variant.productId ?? "",
        variantId,
        title: variant.productTitle,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        quantity,
        currentPriceCents: priceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        isGift,
        isOneTimeAddon: false,
        addedVia,
        ...(isGift ? {} : { addClaimKey: `line:${contract.id}:${variantId}` }),
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost the race: a concurrent request already added this variant.
      return reloadContract(contract.id);
    }
    throw err;
  }

  let shopifyLineId: string | null = null;
  try {
    await withContractDraft(
      admin,
      contract.shopifyContractId,
      async (draftId, run) => {
        shopifyLineId = await draftLineAdd(run, draftId, {
          productVariantId: variantId,
          quantity,
          currentPriceCents: priceCents,
        });
      },
    );
  } catch (err) {
    await prisma.contractLine
      .delete({ where: { id: created.id } })
      .catch((cleanupErr) => {
        console.error(
          "[contracts] addLine: failed to release the add claim after a failed draft",
          created.id,
          cleanupErr,
        );
      });
    throw err;
  }

  await withMirrorGuard("addLine", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: created.id },
      data: { shopifyLineId },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_added",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: created.id,
      variantId,
      title: variant.productTitle,
      quantity,
      priceCents,
      isGift,
      addedVia,
    },
  });

  return reloadContract(contract.id);
}

/**
 * Remove a line. Recurring lines come off the contract; one-time-addon lines
 * come off the upcoming billing cycle (where they actually live). Idempotent:
 * a missing local line is treated as already removed.
 */
export async function removeLine(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) return reloadContract(contract.id); // already removed

  if (line.shopifyLineId) {
    const shopifyLineId = line.shopifyLineId;
    try {
      if (line.isOneTimeAddon) {
        // Addons live on ONE billing cycle, not on the contract. The staged
        // cycle index recorded at add time (migration 0012) is authoritative
        // — Shopify cycle indexes are stable, while a date-resolved "next"
        // cycle can drift past the add-on (skips, resyncs). Legacy rows
        // without it fall back to resolving the upcoming cycle by date.
        let targetCycleIndex = line.addonCycleIndex;
        if (targetCycleIndex == null) {
          const nextBillingDate = requireNextBillingDate(ctx);
          const cycle = await getBillingCycleByDate(
            admin,
            contract.shopifyContractId,
            nextBillingDate,
          );
          if (!cycle) {
            throw new Error(
              `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
            );
          }
          targetCycleIndex = cycle.cycleIndex;
        }
        await withBillingCycleEdit(
          admin,
          contract.shopifyContractId,
          { index: targetCycleIndex },
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      } else {
        await withContractDraft(
          admin,
          contract.shopifyContractId,
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      }
    } catch (err) {
      if (!(err instanceof ShopifyUserError)) throw err;
      // Line already gone on Shopify (or removed by a concurrent edit): the
      // mirror is what diverged — log and continue so it catches up.
      console.error(
        "[contracts] removeLine: Shopify rejected line removal, treating as already removed",
        contract.id,
        shopifyLineId,
        err.message,
      );
    }
  }

  await withMirrorGuard("removeLine", ctx, options, () =>
    prisma.contractLine.delete({ where: { id: line.id } }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: line.isOneTimeAddon ? "cycle.addon_removed" : "contract.line_removed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      isGift: line.isGift,
      isOneTimeAddon: line.isOneTimeAddon,
    },
  });

  return reloadContract(contract.id);
}

// ── One-time add-on ──────────────────────────────────────────────────────────

export interface AddOneTimeAddonOpts {
  /** PORTAL | MAGIC_LINK | ADMIN — how the add-on was attached. */
  addedVia?: string;
}

/**
 * Attach a one-time add-on to the NEXT billing cycle only (billing-cycle
 * contract edit — the contract itself is untouched). The mirror line is
 * flagged `isOneTimeAddon` for portal display; the billing-success webhook
 * handler clears those mirrors after the cycle ships.
 *
 * Concurrency: the duplicate guard is the DATABASE, not a read. The mirror
 * line is created FIRST under the unique addClaimKey
 * "addon:{contractId}:{variantId}" (migration 0009) and only then does the
 * multi-second Shopify cycle edit run — deleted again if that edit fails.
 * The portal has no client-side button disabling, so a double-tap used to
 * send two overlapping requests that both passed the old find-then-act
 * check, both appended the variant to the next cycle, and the customer paid
 * for the add-on twice. Now the second request loses on P2002 and returns
 * the already-staged no-op.
 */
export async function addOneTimeAddon(
  shopDomain: string,
  contractLocalId: string,
  variantId: string,
  quantity: number,
  opts?: AddOneTimeAddonOpts,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);

  // Fast path only — the race-proof guard is the addClaimKey unique below.
  const existing = contract.lines.find(
    (l) => l.variantId === variantId && l.isOneTimeAddon,
  );
  if (existing) return reloadContract(contract.id); // addon already staged

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }

  const variant = await requireVariant(ctx, variantId);
  const priceCents = await ongoingDiscountedPriceCents(shop.id, variant);

  // ── Atomic claim: mirror row FIRST, Shopify edit second ────────────────────
  let created: { id: string };
  try {
    created = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyLineId: null, // stamped after the cycle edit commits
        productId: variant.productId ?? "",
        variantId,
        title: variant.productTitle,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        quantity,
        currentPriceCents: priceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        isGift: false,
        isOneTimeAddon: true,
        // The cycle this add-on rides on. consumeCycleOnSuccess clears the
        // mirror only when THIS cycle settles — an earlier cycle's settlement
        // (racing through the in-flight window) must not delete it, or the
        // freed addClaimKey lets the variant be staged and charged twice.
        addonCycleIndex: cycle.cycleIndex,
        addedVia: opts?.addedVia ?? "PORTAL",
        addClaimKey: `addon:${contract.id}:${variantId}`,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost the race: a concurrent request (double-tap, second tab) already
      // staged this add-on — same no-op as the fast path above.
      return reloadContract(contract.id);
    }
    throw err;
  }

  let shopifyLineId: string | null = null;
  try {
    await withBillingCycleEdit(
      admin,
      contract.shopifyContractId,
      { index: cycle.cycleIndex },
      async (draftId, run) => {
        shopifyLineId = await draftLineAdd(run, draftId, {
          productVariantId: variantId,
          quantity,
          currentPriceCents: priceCents,
        });
      },
    );
  } catch (err) {
    // The claim is only real once Shopify holds the line: release it so a
    // retry can stage the add-on cleanly instead of finding a ghost mirror.
    await prisma.contractLine
      .delete({ where: { id: created.id } })
      .catch((cleanupErr) => {
        console.error(
          "[contracts] addOneTimeAddon: failed to release the add claim after a failed cycle edit",
          created.id,
          cleanupErr,
        );
      });
    throw err;
  }

  await withMirrorGuard("addOneTimeAddon", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: created.id },
      data: { shopifyLineId },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.addon_added",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: created.id,
      cycleIndex: cycle.cycleIndex,
      variantId,
      title: variant.productTitle,
      quantity,
      priceCents,
    },
  });

  return reloadContract(contract.id);
}

// ── Pause / resume ───────────────────────────────────────────────────────────

export interface PauseOptions extends ServiceOptions {
  /** Why the contract paused — CUSTOMER | ADMIN | SAVE_FLOW | STOCKOUT_DELAY
   * | SYSTEM (the pause analogue of cancelReason; migration 0016). Stored on
   * SubscriptionContract.pausedReason and cleared on resume; null = "reason
   * not recorded", which is what every pre-existing caller keeps saying
   * until it opts in. */
  reason?: string;
}

/**
 * Pause for 1–N months (clamped by settings.pause.maxMonths). `resumeAt` uses
 * 30-day months for calendar honesty; the resume job re-activates then.
 */
export async function pauseContract(
  shopDomain: string,
  contractLocalId: string,
  months: number,
  options?: PauseOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "PAUSED") return reloadContract(contract.id);

  const pauseSettings = await getSetting(shop.id, "pause");
  const clampedMonths = Math.min(
    Math.max(1, Math.floor(months)),
    pauseSettings.maxMonths,
  );

  await contractPause(admin, contract.shopifyContractId);

  const now = new Date();
  const resumeAt = addDaysTz(now, clampedMonths * 30, shop.ianaTimezone);
  const reason = options?.reason ?? null;

  await withMirrorGuard("pauseContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      // pausedReason describes THIS pause episode — written fresh (null
      // included) on every pause, cleared on resume, like pausedAt.
      data: { status: "PAUSED", pausedAt: now, resumeAt, pausedReason: reason },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.paused",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: { months: clampedMonths, resumeAt: resumeAt.toISOString(), reason },
  });

  return reloadContract(contract.id);
}

/**
 * Resume a paused (or payment-FAILED — the admin "Resume" button offers both)
 * contract and bill soon (next billing date = now + 3 days), so the customer
 * who asked to come back gets product quickly rather than waiting a full
 * interval.
 *
 * FAILED resumes must also release the failed cycle: the dunning case that
 * failed the contract is closed (EXHAUSTED), and once the contract is ACTIVE
 * again onPaymentMethodUpdated can no longer reopen it (that path requires
 * status FAILED) — so without `releaseHeldCycleAttempts` the billing sweep's
 * cycle-history guard (scheduler b2) would hold the still-unbilled cycle on
 * its terminal FAILED/EXPIRED attempt forever and the "resumed" subscriber
 * would never be billed or shipped again (the same reactivated-but-never-
 * billed trap migration 0013 documents for win-back reactivation).
 */
export async function resumeContract(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "ACTIVE") return reloadContract(contract.id);
  const resumedFromFailed = contract.status === "FAILED";

  await contractActivate(admin, contract.shopifyContractId);

  const nextBillingDate = addDaysTz(new Date(), 3, shop.ianaTimezone);
  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  const effectiveNext = result.nextBillingDate ?? nextBillingDate;

  await withMirrorGuard("resumeContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        status: "ACTIVE",
        pausedAt: null,
        resumeAt: null,
        // pausedReason travels with pausedAt: it describes the pause episode
        // that just ended, not the contract.
        pausedReason: null,
        // failedAt is LIVE-STATE (like the cancel columns — see the win-back
        // engine): a resumed subscriber is retained again. The failure stays
        // in the event log and the closed episode's attempt rows.
        ...(resumedFromFailed ? { failedAt: null } : {}),
        nextBillingDate: effectiveNext,
      },
    }),
  );

  // After the mirror is ACTIVE: the closed failure episode's terminal
  // attempts stop being the cycle's live verdict, so the sweep can open the
  // fresh first attempt the admin was promised ("next charge in ~3 days").
  // No-op for PAUSED resumes (no terminal attempts / open case owns them).
  let releasedAttempts = 0;
  if (resumedFromFailed) {
    releasedAttempts = await releaseHeldCycleAttempts(contract.id);
  }

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.resumed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      nextBillingDate: effectiveNext.toISOString(),
      ...(resumedFromFailed
        ? {
            resumedFrom: "FAILED",
            // Terminal attempts of the closed episode released back to the
            // scheduler (supersededAt stamp). 0 = clean history or an open
            // dunning case still owns its cycle.
            releasedFailedAttempts: releasedAttempts,
          }
        : {}),
    },
  });

  return reloadContract(contract.id);
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Sources the ENGINE paths stamp. A fifth value, "EXTERNAL", exists on the
 * mirror column but is written only by syncContractFromShopify: a cancel
 * first observed from Shopify with no app-internal source stamped ahead of
 * it (Shopify-admin cancels, other surfaces). It is deliberately not in this
 * union — no engine caller may claim it.
 */
export type CancelSource = "CUSTOMER" | "ADMIN" | "DUNNING" | "SYSTEM";

export interface CancelOptions extends ServiceOptions {
  /** Defaults from `source`: portal/magic → CUSTOMER, ADMIN → ADMIN, else SYSTEM. */
  cancelSource?: CancelSource;
  /** Set false for internal cancels (merge) that must not trigger win-back. */
  scheduleWinback?: boolean;
}

function deriveCancelSource(options?: CancelOptions): CancelSource {
  if (options?.cancelSource) return options.cancelSource;
  switch (options?.source) {
    case "CUSTOMER_PORTAL":
    case "MAGIC_LINK":
      return "CUSTOMER";
    case "ADMIN":
      return "ADMIN";
    default:
      return "SYSTEM";
  }
}

/** Cancel the contract; schedules win-back unless disabled. Idempotent. */
export async function cancelContract(
  shopDomain: string,
  contractLocalId: string,
  reason: string,
  options?: CancelOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "CANCELLED") return reloadContract(contract.id);

  const cancelSource = deriveCancelSource(options);

  await contractCancel(admin, contract.shopifyContractId);

  await withMirrorGuard("cancelContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelSource,
      },
    }),
  );

  // ── Cancel-funnel bookkeeping for admin cancels ────────────────────────────
  // The CancelSession funnel was portal-only in practice: ADMIN was a
  // declared channel no writer ever produced, so admin-entered reasons never
  // reached the reason histogram and channel-split retention analysis had a
  // single bucket. An admin cancel not riding an open portal session records
  // a minimal completed session here (channel ADMIN, outcome CANCELLED, the
  // admin form's reason); when a session IS open, its own flow owns the
  // funnel verdict. DUNNING/SYSTEM cancels stay out on purpose — the funnel
  // measures cancel-intent conversations, not bookkeeping or dunning.
  // Contained: funnel bookkeeping must never break the cancel itself.
  let cancelSessionId: string | null = null;
  if (cancelSource === "ADMIN") {
    try {
      const openSession = await prisma.cancelSession.findFirst({
        where: { contractId: contract.id, outcome: null },
        select: { id: true },
      });
      if (!openSession) {
        const session = await prisma.cancelSession.create({
          data: {
            contractId: contract.id,
            channel: "ADMIN",
            reason,
            outcome: "CANCELLED",
            completedAt: new Date(),
          },
        });
        cancelSessionId = session.id;
      }
    } catch (err) {
      console.error(
        "[contracts] cancelContract: admin cancel-session bookkeeping failed",
        contract.id,
        err,
      );
    }
  }

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.cancelled",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      reason,
      cancelSource,
      ...(cancelSessionId ? { cancelSessionId } : {}),
    },
  });

  const updated = await reloadContract(contract.id);

  // Subscriber-tag recompute (tagging setting group): the cancel webhook echo
  // reaches the same recompute through syncContractFromShopify within
  // seconds, but "remove the tag when they cancel" is the feature's headline
  // promise — apply it in the same request. Contained: tagging never breaks
  // a cancel.
  try {
    const { maybeSyncSubscriberTag } = await import("~/lib/tagging/tags.server");
    await maybeSyncSubscriberTag(shop.id, contract.customerId, {
      contractId: contract.id,
    });
  } catch (err) {
    console.error(
      "[contracts] subscriber tag recompute failed after cancel",
      contract.id,
      err,
    );
  }

  if (options?.scheduleWinback !== false) {
    try {
      const winback = (await import("~/lib/winback/engine.server")) as {
        scheduleWinback?: (
          contract: LocalContractWithLines,
        ) => Promise<unknown>;
      };
      if (typeof winback.scheduleWinback === "function") {
        await winback.scheduleWinback(updated);
      }
    } catch (err) {
      // Win-back scheduling must never break a cancel.
      console.error(
        "[contracts] win-back scheduling failed after cancel",
        contract.id,
        err,
      );
    }
  }

  return updated;
}

// ── Address / next date / payment ────────────────────────────────────────────

/** Update the shipping address on the contract's delivery method. */
export async function updateDeliveryAddress(
  shopDomain: string,
  contractLocalId: string,
  address: DeliveryAddressInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdateAddress(run, draftId, address);
    },
  );

  // JSON round-trip drops `undefined` values (Prisma rejects them in Json).
  const addressJson = JSON.parse(JSON.stringify(address)) as object;

  await withMirrorGuard("updateDeliveryAddress", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { deliveryAddress: addressJson },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.address_updated",
    source: resolveSource(options),
    actor: resolveActor(options),
    // Minimal payload — no full address PII in the event log.
    payload: {
      city: address.city ?? null,
      zip: address.zip ?? null,
      countryCode: address.countryCode ?? null,
    },
  });

  return reloadContract(contract.id);
}

/** Move the contract's next billing date to an explicit date. */
export async function setNextBillingDate(
  shopDomain: string,
  contractLocalId: string,
  date: Date,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const previous = contract.nextBillingDate;
  if (previous && previous.getTime() === date.getTime()) {
    return reloadContract(contract.id); // already at the requested date
  }

  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    date,
  );
  const effective = result.nextBillingDate ?? date;

  await withMirrorGuard("setNextBillingDate", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effective },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.next_date_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      previousNextBillingDate: previous ? previous.toISOString() : null,
      nextBillingDate: effective.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

// ── Discount grants ──────────────────────────────────────────────────────────

export interface DiscountGrantInput {
  /** SAVE_OFFER | SAVE_OFFER_FINAL | WINBACK | RETENTION | MANUAL */
  type: string;
  percent: number;
  cycles: number;
  grantedBy?: string | null;
  reason?: string | null;
  /** Extra event-payload fields (e.g. { sessionId }) merged into the grant
   * event so stream analytics can join accepts to their flow session. */
  context?: Record<string, unknown>;
}

const GRANT_EVENT_TYPES: Record<string, string> = {
  SAVE_OFFER: "cancel.save_accepted",
  SAVE_OFFER_FINAL: "cancel.final_offer_accepted",
  // Deliberately NOT winback.discount_offered: the sweep already logged that
  // when the offer email was sent — re-emitting it on acceptance would
  // double-count offers and understate offer→acceptance conversion.
  WINBACK: "winback.discount_granted",
  RETENTION: "admin.action",
  MANUAL: "admin.action",
};

/**
 * Grant a temporary N-cycle percentage discount. The billing sweep applies it
 * per cycle via billing-cycle contract edits (never discount codes) and the
 * success webhook consumes one cycle at a time. Idempotent: an identical
 * still-active grant is not duplicated.
 *
 * Discount stacking cap: the percent is clamped so that the contract's plan
 * ongoing discount (SellingPlanConfig.ongoingDiscountPct) plus the grant never
 * exceeds settings.discountStacking.maxTotalDiscountPct. With zero headroom no
 * grant is created (the decision is logged); callers that SHOW offers run the
 * same clamp first (~/lib/billing/stacking.server) so customers are never
 * promised more than this gate will grant.
 */
export async function applyDiscountGrant(
  shopDomain: string,
  contractLocalId: string,
  grant: DiscountGrantInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(grant.percent) || grant.percent < 1 || grant.percent > 90) {
    throw new Error(`Invalid discount percent: ${grant.percent}`);
  }
  if (!Number.isInteger(grant.cycles) || grant.cycles < 1) {
    throw new Error(`Invalid discount cycles: ${grant.cycles}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;

  const clamp = await clampGrantPercentForContract(
    shop.id,
    contract.lines,
    grant.percent,
  );
  if (clamp.percent < 1) {
    // No headroom under the stacking cap — refuse the grant, audibly.
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "contract.updated",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        action: "discount_grant_rejected",
        reason: "stacking_cap",
        grantType: grant.type,
        requestedPercent: grant.percent,
        ongoingDiscountPct: clamp.ongoingDiscountPct,
        maxTotalDiscountPct: clamp.maxTotalDiscountPct,
      },
    });
    return reloadContract(contract.id);
  }
  const percent = clamp.percent;

  const existing = await prisma.discountGrant.findFirst({
    where: {
      contractId: contract.id,
      type: grant.type,
      percent,
      cyclesTotal: grant.cycles,
      cyclesRemaining: { gt: 0 },
    },
  });
  if (existing) return reloadContract(contract.id); // grant already active

  const created = await prisma.discountGrant.create({
    data: {
      contractId: contract.id,
      type: grant.type,
      percent,
      cyclesTotal: grant.cycles,
      cyclesRemaining: grant.cycles,
      grantedBy: grant.grantedBy ?? resolveActor(options),
      reason: grant.reason ?? null,
    },
  });

  await logEvent({
    ...eventIdentity(shop, contract),
    type: GRANT_EVENT_TYPES[grant.type] ?? "admin.action",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      action: "discount_grant_created",
      ...(grant.context ?? {}),
      grantId: created.id,
      grantType: grant.type,
      percent,
      ...(clamp.clamped
        ? {
            requestedPercent: grant.percent,
            clampedByStackingCap: true,
            ongoingDiscountPct: clamp.ongoingDiscountPct,
            maxTotalDiscountPct: clamp.maxTotalDiscountPct,
          }
        : {}),
      cycles: grant.cycles,
      reason: grant.reason ?? null,
    },
  });

  return reloadContract(contract.id);
}

// ── Backup payment method ────────────────────────────────────────────────────

/**
 * Swap the contract to its backup payment method (dunning fallback). The old
 * primary becomes the new backup so a later swap can restore it.
 */
export async function changePaymentMethodToBackup(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const backupId = contract.backupPaymentMethodId;
  if (!backupId) {
    throw new Error(
      `Contract ${contract.id} has no backup payment method to fall back to`,
    );
  }
  if (contract.paymentMethodId === backupId) {
    return reloadContract(contract.id); // already on the backup
  }

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdatePaymentMethod(run, draftId, backupId);
    },
  );

  // Best-effort card metadata refresh for the new active method.
  let cardData: {
    cardBrand?: string | null;
    cardLast4?: string | null;
    cardExpiryMonth?: number | null;
    cardExpiryYear?: number | null;
  } = {};
  try {
    const methods = await listCustomerPaymentMethods(admin, contract.customerId);
    const method = methods.find((m) => m.id === backupId);
    if (method?.instrument) {
      cardData = {
        cardBrand: method.instrument.brand,
        cardLast4: method.instrument.lastDigits,
        cardExpiryMonth: method.instrument.expiryMonth,
        cardExpiryYear: method.instrument.expiryYear,
      };
    }
  } catch (err) {
    console.error(
      "[contracts] card metadata refresh failed after backup swap",
      contract.id,
      err,
    );
  }

  await withMirrorGuard("changePaymentMethodToBackup", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        paymentMethodId: backupId,
        backupPaymentMethodId: contract.paymentMethodId,
        ...cardData,
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.payment_method_updated",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      usedBackup: true,
      previousPaymentMethodId: contract.paymentMethodId,
      paymentMethodId: backupId,
    },
  });

  return reloadContract(contract.id);
}

// ── Seam re-exports ──────────────────────────────────────────────────────────
// ARCHITECTURE.md lists every contract-service seam as importable from
// service.server.ts; these two live in sibling modules of this package.
// (Safe ESM cycle: all seams are hoisted function declarations.)

export { mergeContracts } from "./consolidation.server";
export { syncContractFromShopify } from "./sync.server";
