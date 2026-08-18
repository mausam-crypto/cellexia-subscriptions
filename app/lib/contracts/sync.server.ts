import { Prisma, type ContractStatus } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";
import { approxWeeks } from "~/lib/frequency";
import {
  getContract,
  getOrderSummary,
  getVariants,
  listContractGids,
  OrderNotFoundError,
  type OrderSummary,
  type ShopifyContract,
  type ShopifyContractLine,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import {
  OURS_ONLY,
  OWNERSHIP_UNKNOWN,
  classifyContractOwnership,
  getOwnPlanIdEvidence,
  isBillableOwnership,
  normalizeOwnership,
  refreshOwnPlanIdsFromShopify,
  type ContractOwnership,
} from "~/lib/ownership/ownership.server";
import { releaseHeldCycleAttempts } from "~/lib/billing/release.server";
import { getLockRules, maxLockDaysForPlanIds } from "./lock.server";
import type { LocalContractWithLines, ServiceOptions } from "./shared.server";
import { reloadContract, resolveActor } from "./shared.server";

/**
 * Shopify → local mirror synchronization. Webhook truth: whatever Shopify
 * says about a contract wins over local assumptions. Called by the webhook
 * dispatcher on SUBSCRIPTION_CONTRACTS_* topics and by the initial backfill.
 *
 * Local-only extension state (skipCount, pause bookkeeping, discount grants,
 * gift/one-time-addon flags, analytics fields) is preserved; only the fields
 * Shopify owns are overwritten.
 */

// ── Mapping helpers ──────────────────────────────────────────────────────────

function mapStatus(shopifyStatus: string): ContractStatus {
  switch (shopifyStatus) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "FAILED":
    case "STALE": // STALE = billing overdue/abandoned — treat as failed locally
      return "FAILED";
    default:
      return "ACTIVE";
  }
}

/**
 * Billing policy → whole weeks. MONTH×4 and DAY/7 are approximations —
 * acceptable for the surfaces that key off intervalWeeks (scheduling display,
 * portal frequency options, consolidation grouping; real due dates always come
 * from the mirrored Shopify nextBillingDate). Money math must NOT use this:
 * MRR reads the exact billingIntervalUnit/billingIntervalCount mirror written
 * alongside (see computeMrrCents in app/lib/analytics/queries.server.ts).
 */
function intervalWeeksFromPolicy(policy: {
  interval: string;
  intervalCount: number;
}): number {
  return approxWeeks(policy.interval, policy.intervalCount);
}

/** Approximate days in one policy interval — used only to RATIO two policies. */
function policyIntervalDays(policy: {
  interval: string;
  intervalCount: number;
}): number {
  const count = Math.max(1, policy.intervalCount);
  switch (policy.interval) {
    case "DAY":
      return count;
    case "WEEK":
      return count * 7;
    case "MONTH":
      return count * 30.437;
    case "YEAR":
      return count * 365.25;
    default:
      return count * 7;
  }
}

/**
 * Prepaid detection from the mirrored policies. Shopify models "prepaid" as a
 * delivery policy strictly more frequent than the billing policy: one charge
 * covers N deliveries (e.g. bill every 3 months, deliver monthly → N=3).
 * Pay-per-delivery contracts have equal policies (ratio 1) and are not
 * prepaid. Without this, isPrepaid was never set by any ingest path, so
 * prepaidActive/prepaidMixPct read 0 and the analytics cost model never
 * applied its deliveries-per-charge multipliers.
 */
function prepaidFromPolicies(sc: ShopifyContract): {
  isPrepaid: boolean;
  prepaidDeliveriesPerCharge: number | null;
} {
  if (!sc.deliveryPolicy) {
    return { isPrepaid: false, prepaidDeliveriesPerCharge: null };
  }
  const billingDays = policyIntervalDays(sc.billingPolicy);
  const deliveryDays = policyIntervalDays(sc.deliveryPolicy);
  const ratio = deliveryDays > 0 ? Math.round(billingDays / deliveryDays) : 1;
  if (ratio < 2) return { isPrepaid: false, prepaidDeliveriesPerCharge: null };
  return { isPrepaid: true, prepaidDeliveriesPerCharge: ratio };
}

interface CardData {
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  paymentInstrumentType: string | null;
}

function cardDataFromContract(sc: ShopifyContract): CardData | null {
  const instrument = sc.customerPaymentMethod?.instrument;
  if (!instrument) return null;
  return {
    cardBrand: instrument.brand,
    cardLast4: instrument.lastDigits,
    cardExpiryMonth: instrument.expiryMonth,
    cardExpiryYear: instrument.expiryYear,
    // Migration 0027: the normalized instrument kind travels with the card
    // columns (decides hosted-URL vs Shopify-email card update).
    paymentInstrumentType: instrument.type,
  };
}

function lineData(
  line: ShopifyContractLine,
  variant: ShopifyVariant | undefined,
): {
  shopifyLineId: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  currentPriceCents: number;
  compareAtPriceCents: number | null;
  unitCostCents: number | null;
  pricingPolicy?: object;
} {
  const baseCents =
    line.pricingPolicy && line.pricingPolicy.basePriceCents > 0
      ? line.pricingPolicy.basePriceCents
      : (variant?.priceCents ?? null);
  return {
    shopifyLineId: line.id,
    productId: line.productId ?? variant?.productId ?? "",
    variantId: line.variantId ?? "",
    title: line.title || (variant?.productTitle ?? ""),
    variantTitle: line.variantTitle,
    sku: line.sku ?? variant?.sku ?? null,
    imageUrl: line.imageUrl ?? variant?.imageUrl ?? null,
    quantity: line.quantity,
    sellingPlanId: line.sellingPlanId,
    sellingPlanName: line.sellingPlanName,
    currentPriceCents: line.currentPriceCents,
    compareAtPriceCents: baseCents,
    unitCostCents: variant?.unitCostCents ?? null,
    // Full pricing-policy mirror (migration 0016): basePrice + cycleDiscounts
    // incl. computedPriceCents, exactly as the contract query returned it —
    // the known future price step that MRR forecasting and the price-change
    // apply engine read locally. Only present when Shopify returned one: a
    // line without a policy (imports, gifts, portal-added lines) omits the
    // key, so the update path keeps whatever the mirror already holds rather
    // than erasing it (the unitCostCents keep philosophy: stale beats gone).
    ...(line.pricingPolicy
      ? {
          pricingPolicy: JSON.parse(
            JSON.stringify(line.pricingPolicy),
          ) as object,
        }
      : {}),
  };
}

// ── Origin-order money capture ───────────────────────────────────────────────

/**
 * Column-shaped origin-payment mirror from one order summary (migration 0006).
 *
 * totalCents is the order's CURRENT total — for a same-day capture (the normal
 * webhook path) that is exactly what was charged; for a late backfill it is
 * net of any item-refund reductions, i.e. the money actually kept, which is
 * the honest amount for analytics. originOrderRefundedCents is NOT set here —
 * only the REFUNDS_CREATE handler increments it (from capture onward), so a
 * refund can never be netted twice.
 *
 * processedAt (payment instant) falls back to createdAt so the analytics
 * engines always have a booking day for a captured payment.
 */
function originMoneyFields(order: OrderSummary, fallbackCurrency: string) {
  return {
    originOrderTotalCents: order.totalCents,
    originOrderDiscountCents: order.discountsCents,
    // Tax share of the total (migration 0016), captured at the same instant
    // as the total: on a VAT-inclusive book the total alone counts VAT as
    // merchant revenue, and past the 60-day order-access window the split is
    // unrecoverable — so it is taken while the order is still readable.
    originOrderTaxCents: order.taxCents,
    originOrderShippingChargedCents: order.shippingCents,
    originOrderProcessedAt: order.processedAt ?? order.createdAt ?? new Date(),
    // Never a hardcoded currency — same rule as the contract mirror.
    originOrderCurrencyCode: order.currencyCode ?? fallbackCurrency,
  };
}

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * Which app does this contract belong to?
 *
 * SUBSCRIPTION_CONTRACTS_* webhooks fire for EVERY contract on the shop —
 * including the ones another subscription app (Joy) created — and this
 * function is the single writer of contract mirrors, so it is also the single
 * place ownership is decided. Only `OURS` contracts are ever billed, messaged,
 * counted or exposed in the portal.
 *
 * Fail-safe: when our own plan ids cannot be loaded, or the contract carries no
 * selling plan at all, a contract we have never classified stays UNKNOWN
 * (= not billable) rather than defaulting to ours; and an explicit OURS is
 * never downgraded to UNKNOWN — it only moves to FOREIGN on positive evidence
 * (every line carries a selling plan and none of them is ours).
 */
async function resolveOwnership(
  shop: { id: string; domain: string },
  sc: ShopifyContract,
  existing: { ownership?: string | null; linePlanIds?: Array<string | null> } | null,
): Promise<ContractOwnership> {
  let ownPlanIds = new Set<string>();
  let ownPlanIdsKnown = false;
  try {
    let evidence = await getOwnPlanIdEvidence(shop.id);
    if (!evidence.known) {
      // A synced group whose plans were never recorded (upgrade from a build
      // without shopifyPlanIds). Read them back once, then re-evaluate; if the
      // repair fails the evidence stays incomplete and nothing is called
      // FOREIGN on the strength of a set we know is missing entries.
      const repaired = await refreshOwnPlanIdsFromShopify(shop.domain, shop.id);
      if (repaired > 0) evidence = await getOwnPlanIdEvidence(shop.id);
    }
    ownPlanIds = evidence.planIds;
    ownPlanIdsKnown = evidence.known;
  } catch (err) {
    console.error("[contracts] sync: own selling plan lookup failed", shop.id, err);
    ownPlanIds = new Set<string>();
    ownPlanIdsKnown = false;
  }

  return classifyContractOwnership({
    // Remote plan ids first, plus the ones already mirrored locally: evidence
    // is only ever added to, so a response that omits selling plans cannot
    // turn a known contract indeterminate.
    linePlanIds: [
      ...sc.lines.map((l) => l.sellingPlanId),
      ...(existing?.linePlanIds ?? []),
    ],
    ownPlanIds,
    existingOwnership: existing?.ownership,
    ownPlanIdsKnown,
  });
}

// ── Sync one contract ────────────────────────────────────────────────────────

/**
 * Fetch one contract from Shopify and upsert the local mirror (contract +
 * lines). Preserves isGift / isOneTimeAddon / addedVia on lines matched by
 * shopifyLineId (falling back to variantId), and never deletes
 * isOneTimeAddon mirror lines (they live on a billing cycle, not on the
 * contract, so Shopify's contract lines never contain them).
 */
export async function syncContractFromShopify(
  shopDomain: string,
  shopifyContractGid: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const shop = await requireShop(shopDomain);
  const admin = await adminClientForShop(shopDomain);
  const sc = await getContract(admin, shopifyContractGid);

  const existing = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: shopifyContractGid },
    include: { lines: true },
  });

  // Variant enrichment (COGS + undiscounted price) — best effort.
  let variantsById = new Map<string, ShopifyVariant>();
  try {
    const variantIds = [
      ...new Set(
        sc.lines
          .map((l) => l.variantId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const variants = await getVariants(admin, variantIds);
    variantsById = new Map(variants.map((v) => [v.id, v]));
  } catch (err) {
    console.error(
      "[contracts] sync: variant enrichment failed",
      shopifyContractGid,
      err,
    );
  }

  // Which app owns this contract. Resolved on every sync (the webhook is the
  // truth) but only ever tightened — and the tightening is enforced again at
  // the WRITE below, because this resolution is computed off the `existing`
  // read and can be stale by the time it lands: see the monotonic ownership
  // write before the upsert.
  // Resolved BEFORE the origin-order fetch so the money capture below can be
  // gated to contracts we own (a foreign contract's checkout money is not
  // ours to account, and each capture costs a Shopify round trip).
  const ownership = await resolveOwnership(
    { id: shop.id, domain: shopDomain },
    sc,
    existing
      ? {
          ownership: existing.ownership,
          linePlanIds: existing.lines.map((l) => l.sellingPlanId),
        }
      : null,
  );

  // First-charge detection + origin-order money capture — best effort, once
  // each, from ONE order-summary fetch. Idempotent: on an existing row the
  // money fields are written through an atomic updateMany claim conditioned
  // on originOrderTotalCents still being null (see below — the read here is
  // only an optimization that skips the fetch), so a captured value is never
  // overwritten by a later or concurrent sync; a failed fetch leaves the
  // fields null and the daily origin_order_backfill job retries. Ours-only:
  // the analytics that read these fields already filter OURS, and UNKNOWN
  // contracts that later prove ours are picked up by the backfill job.
  let firstChargeAt: Date | null = existing?.firstChargeAt ?? null;
  let originMoney: ReturnType<typeof originMoneyFields> | null = null;
  const wantFirstCharge = !firstChargeAt && sc.originOrder != null;
  const wantOriginMoney =
    sc.originOrder != null &&
    isBillableOwnership(ownership) &&
    existing?.originOrderTotalCents == null;
  if (sc.originOrder && (wantFirstCharge || wantOriginMoney)) {
    try {
      const order = await getOrderSummary(admin, sc.originOrder.id);
      if (wantFirstCharge) firstChargeAt = order.createdAt;
      if (wantOriginMoney) {
        originMoney = originMoneyFields(
          order,
          sc.currencyCode ?? existing?.currencyCode ?? shop.currencyCode,
        );
      }
    } catch (err) {
      console.error(
        "[contracts] sync: origin order lookup failed",
        sc.originOrder.id,
        err,
      );
    }
  }

  const status = mapStatus(sc.status);
  const now = new Date();
  const customer = sc.customer;
  const card = cardDataFromContract(sc);
  const prepaid = prepaidFromPolicies(sc);
  const deliveryAddressJson = sc.deliveryMethod?.address
    ? (JSON.parse(JSON.stringify(sc.deliveryMethod.address)) as object)
    : undefined;

  // NOTE: `ownership` is deliberately NOT part of this spread. The update path
  // below writes it under a monotonic rule (see there); putting it here would
  // reintroduce the read-modify-write race that rule exists to close.
  const shared = {
    customerId: customer?.id ?? existing?.customerId ?? "",
    email: customer?.email ?? existing?.email ?? "",
    phone: customer?.phone ?? existing?.phone ?? null,
    firstName: customer?.firstName ?? existing?.firstName ?? null,
    lastName: customer?.lastName ?? existing?.lastName ?? null,
    // customer.locale is Shopify-owned, so the mirror must track it — a
    // subscriber who switches store language after checkout would otherwise
    // keep receiving checkout-time-language notices forever (the create
    // branch used to be the only writer). Keep-if-absent: a response that
    // omits the locale never erases the one already recorded (the create
    // path defaults "en" separately).
    ...(customer?.locale ? { locale: normalizeLocale(customer.locale) } : {}),
    status,
    // Shopify always sets currencyCode on contracts; the null branch exists
    // because ShopifyContract mirrors what the API *could* omit. Fall back to
    // what this mirror already recorded, then to the shop's own currency —
    // never to a hardcoded code, which would smuggle amounts past the
    // "same currency only" analytics guards on non-GBP books.
    currencyCode: sc.currencyCode ?? existing?.currencyCode ?? shop.currencyCode,
    intervalWeeks: intervalWeeksFromPolicy(sc.billingPolicy),
    // Exact cadence mirror — the approximation-free source MRR reads.
    billingIntervalUnit: sc.billingPolicy.interval,
    billingIntervalCount: Math.max(1, sc.billingPolicy.intervalCount),
    // Billing-policy cycle bounds (migration 0016). A maxCycles-capped plan
    // expires on Shopify with no local warning unless the bound is mirrored —
    // it is on the wire in every sync response and was previously dropped.
    // Null = no bound on the plan (the common case).
    billingMinCycles: sc.billingPolicy.minCycles,
    billingMaxCycles: sc.billingPolicy.maxCycles,
    ...prepaid,
    nextBillingDate: sc.nextBillingDate,
    paymentMethodId: sc.customerPaymentMethod?.id ?? null,
    // Card metadata tracks the ACTIVE method. When Shopify reports no payment
    // method at all (removed/redacted) the four card columns are cleared
    // along with the id — keeping them fed "card expiring" notices and
    // Klaviyo props for a card no longer on file. A method that is PRESENT
    // but arrives without instrument details keeps the mirrored values:
    // an omitted instrument is not removal evidence.
    ...(sc.customerPaymentMethod == null
      ? {
          cardBrand: null,
          cardLast4: null,
          cardExpiryMonth: null,
          cardExpiryYear: null,
          paymentInstrumentType: null,
        }
      : (card ?? {})),
    // Revoked-state mirror (migration 0027): a live method clears the stamp;
    // Shopify reporting the method as revoked keeps/sets it. Absent method
    // → leave whatever the revoke webhook stamped.
    ...(sc.customerPaymentMethod != null
      ? { paymentMethodRevokedAt: sc.customerPaymentMethod.revokedAt ?? null }
      : {}),
    ...(deliveryAddressJson !== undefined
      ? { deliveryAddress: deliveryAddressJson }
      : {}),
    deliveryPriceCents: sc.deliveryPriceCents,
    deliveryMethodTitle: sc.deliveryMethod?.title ?? null,
    originOrderId: sc.originOrder?.id ?? existing?.originOrderId ?? null,
    originOrderName: sc.originOrder?.name ?? existing?.originOrderName ?? null,
    // Origin money is NOT part of this spread on the update path — see the
    // atomic claim below. originOrderRefundedCents is deliberately never
    // written here: the REFUNDS_CREATE handler owns that counter.
    firstChargeAt,
  };

  // Whether THIS sync stamped expiredAt — the mirror's expiry date is the
  // observation instant, not Shopify's (the Admin API exposes no
  // per-transition timestamp), and the audit event flags the approximation.
  let expiredAtStamped = false;

  // Status-transition bookkeeping the webhook path must not lose. Computed
  // against the row the update actually lands on: on the lost first-sync race
  // below that is the row a CONCURRENT sync committed, not this sync's null
  // read — so this is a function, not a value.
  const transitionsFor = (
    prior: {
      cancelledAt: Date | null;
      cancelSource: string | null;
      failedAt: Date | null;
      pausedAt: Date | null;
      expiredAt?: Date | null;
      status: string;
    } | null,
  ): Prisma.SubscriptionContractUpdateInput => {
    const transitions: Prisma.SubscriptionContractUpdateInput = {};
    if (status === "CANCELLED" && !prior?.cancelledAt) {
      transitions.cancelledAt = now;
      // EXTERNAL: the cancel was first observed FROM Shopify with no
      // app-internal source stamped ahead of it. Every engine path stamps its
      // source on the mirror before its webhook echo lands (CUSTOMER / ADMIN
      // / DUNNING via cancelContract, SYSTEM via merge), so a null prior
      // source here means the cancel happened in the Shopify admin or on
      // another surface. Additive value alongside the schema comment's
      // CUSTOMER | ADMIN | DUNNING | SYSTEM; analytics treats non-DUNNING
      // as voluntary. Stamping SYSTEM here used to make external churn
      // indistinguishable from internal bookkeeping cancels — permanently,
      // since the conflation happened at collection time.
      if (!prior?.cancelSource) transitions.cancelSource = "EXTERNAL";
      // A scheduled cancel (v1.28.0, P3.8) is settled by any cancel — the
      // column is LIVE-STATE and must not survive into a later reactivation.
      transitions.cancelScheduledAt = null;
    }
    if (status === "FAILED" && !prior?.failedAt) {
      transitions.failedAt = now;
    }
    if (status === "PAUSED" && !prior?.pausedAt) {
      transitions.pausedAt = now;
    }
    if (status === "EXPIRED" && !prior?.expiredAt) {
      // Shopify ended the contract (billingMaxCycles ran out). Webhooks
      // arrive within minutes of the flip, so the observation instant is the
      // best available expiry date (migration 0016 — the expiry analogue of
      // cancelledAt).
      transitions.expiredAt = now;
      expiredAtStamped = true;
    }
    if (status === "ACTIVE" && prior && prior.status === "PAUSED") {
      transitions.pausedAt = null;
      transitions.resumeAt = null;
      // pausedReason is LIVE-STATE like pausedAt: it describes the current
      // pause episode, and a resumed contract has none.
      transitions.pausedReason = null;
    }
    // Shopify-side reactivation (merchant reactivates a cancelled/failed
    // contract in the Shopify admin). The cancel/failure columns are
    // LIVE-STATE, not history (see the win-back engine): a reactivated
    // subscriber is retained again, and leaving stale stamps would both keep
    // counting them as churned AND make a LATER churn keep the old timestamp
    // (the stamps above only write when the prior stamp is null). The episode
    // itself stays in the event log and the closed attempts' rows. The
    // matching billing-cycle release happens after the write (see
    // releaseHeldCycleAttempts below) — it must run against the committed
    // ACTIVE row, not inside this update input.
    if (
      status === "ACTIVE" &&
      prior &&
      (prior.status === "CANCELLED" || prior.status === "FAILED")
    ) {
      transitions.cancelledAt = null;
      transitions.cancelReason = null;
      transitions.cancelSource = null;
      transitions.failedAt = null;
      // Reactivation after a CANCEL clears a scheduled cancel too (v1.28.0,
      // P3.8) — the hourly job must never re-cancel a subscriber who came
      // back. FAILED → ACTIVE is a payment RECOVERY, not a change of mind:
      // the customer's scheduled end stands (dunning recovery in
      // dunning/engine.server.ts leaves it too — one truth either way the
      // webhook races the local write).
      if (prior.status === "CANCELLED") transitions.cancelScheduledAt = null;
    }
    return transitions;
  };

  // ── Monotonic ownership write ──────────────────────────────────────────────
  // `ownership` was resolved off the `existing` read taken at the TOP of this
  // sync, and the Shopify round trips between that read and this write
  // (variant enrichment, plan-evidence lookup/repair, origin-order fetch) open
  // a multi-second window in which another writer can stamp an explicit
  // verdict — the import script's grandfathered+OURS stamp, an admin's
  // claimContracts, a concurrent sync with better evidence. Writing the stale
  // resolution unconditionally let a webhook-triggered sync flip a
  // just-imported contract back to UNKNOWN, silently excluding it from every
  // OURS_ONLY billing/reminder/dunning sweep with nothing self-healing it.
  //
  // The tightening rule, enforced at the database write instead of trusted to
  // the pre-fetch read:
  //  - OURS / FOREIGN are written: OURS is never a downgrade, and the
  //    classifier only ever RESOLVES FOREIGN on positive evidence (every line
  //    carries a selling plan, none ours) or an explicit FOREIGN prior.
  //  - UNKNOWN is never written on the update path. The column is NOT NULL
  //    DEFAULT 'UNKNOWN' (migration 0003 backfilled every pre-existing row),
  //    so a resolved UNKNOWN is either a no-op (row already UNKNOWN) or the
  //    forbidden explicit-verdict downgrade — omitting the write is exactly
  //    the `updateMany({ where: { ownership: UNKNOWN } })` guard with no
  //    second statement to race.
  const ownershipWrite =
    ownership === OWNERSHIP_UNKNOWN ? {} : { ownership };

  // Attempts released by a Shopify-side reactivation, for the audit event
  // below. Null = this sync was not a CANCELLED/FAILED → ACTIVE transition.
  let reactivationRelease: number | null = null;

  // The update path, shared by the normal existing-row sync and the lost
  // first-sync race below. `row` is the row the write must land on — the
  // top-of-sync read, or the re-read of what a concurrent sync committed.
  const updateExistingRow = async (row: NonNullable<typeof existing>) => {
    const data = {
      ...shared,
      // On the lost race every `existing?.` fallback inside `shared` was
      // computed off a null read. The Shopify payload both racers mirror is
      // identical, so those fallbacks are moot — EXCEPT firstChargeAt,
      // whose value came from an independent best-effort order fetch: never
      // clobber the winner's capture because this sync's own fetch failed.
      firstChargeAt: firstChargeAt ?? row.firstChargeAt,
      // Seed the deliveries-remaining counter only when the row never had
      // one (migration 0016 gave the column its cockpit reader but no
      // writer). The SETTLEMENT writers own the value from then on (each
      // successful prepaid charge re-arms the full per-charge allotment);
      // a routine re-sync must never overwrite a live value.
      ...(prepaid.isPrepaid && row.prepaidDeliveriesRemaining == null
        ? { prepaidDeliveriesRemaining: prepaid.prepaidDeliveriesPerCharge }
        : {}),
      ...ownershipWrite,
      ...transitionsFor(row),
    };
    const reactivating =
      status === "ACTIVE" &&
      (row.status === "CANCELLED" || row.status === "FAILED");
    if (!reactivating) {
      return prisma.subscriptionContract.update({
        where: { id: row.id },
        data,
      });
    }
    // ── Shopify-side reactivation: release the failed cycle. ─────────────────
    // A merchant reactivating a payment-failed contract directly in the
    // Shopify admin arrives here as CONTRACTS_UPDATE → CANCELLED/FAILED →
    // ACTIVE, with Shopify's nextBillingDate typically still parked inside
    // the failed cycle. The closed episode's dunning case cannot be reopened
    // (onPaymentMethodUpdated requires status FAILED), so without the release
    // the billing sweep's cycle-history guard (b2) holds the unbilled cycle
    // on its terminal attempt forever and the reactivated subscriber is never
    // billed again — the same trap migration 0013 closed for win-back
    // reactivation. ONE transaction with the ACTIVE mirror write, for the
    // same reason as the win-back path: a crash between "mirror says ACTIVE"
    // and "cycle released" is unfixable (the webhook redelivery re-syncs, but
    // by then the prior status is ACTIVE and this branch never re-fires).
    // Gated to billable ownership — a foreign/unknown contract's cycles are
    // not ours to release (and never held: only our attempts exist locally).
    return prisma.$transaction(async (tx) => {
      const updated = await tx.subscriptionContract.update({
        where: { id: row.id },
        data,
      });
      const rowOwnership = normalizeOwnership(updated.ownership);
      if (rowOwnership != null && isBillableOwnership(rowOwnership)) {
        reactivationRelease = await releaseHeldCycleAttempts(row.id, tx);
      }
      return updated;
    });
  };

  // ── First-mirror transition stamps ─────────────────────────────────────────
  // A webhook- or import-driven create observes the contract's state roughly
  // as it becomes true, so `now` is an honest transition date. A
  // backfill/reclassify create (source SYSTEM) mirrors a contract whose
  // transition happened an unknowable time ago — an established-shop install
  // backfills months-old cancelled contracts — and the Admin API exposes no
  // per-transition timestamp to read (updatedAt moves on ANY edit). Stamping
  // `now` there invented churn/pause dates at mirror time (false churn in
  // that day's rollup), so backfill mirrors keep null dates — status stays
  // the truth — and the audit event records the gap instead.
  const backfillCreate = options?.source === "SYSTEM";
  const createStamps: Record<string, unknown> = {};
  if (status === "CANCELLED") {
    // EXTERNAL, not SYSTEM: nothing app-internal cancelled a contract we are
    // only now meeting (see transitionsFor).
    createStamps.cancelSource = "EXTERNAL";
    if (!backfillCreate) createStamps.cancelledAt = now;
  } else if (status === "FAILED" && !backfillCreate) {
    createStamps.failedAt = now;
  } else if (status === "PAUSED" && !backfillCreate) {
    createStamps.pausedAt = now;
  } else if (status === "EXPIRED" && !backfillCreate) {
    createStamps.expiredAt = now;
  }
  // Set only when the CREATE below actually committed with omitted dates —
  // a lost race falls through to the update path, whose stamps are its own.
  let transitionDatesOmitted = false;

  // `existing` as the WRITE sees it — reassigned when the first-sync race is
  // lost, so everything downstream (origin-money claim, line matching, the
  // created/updated audit event) converges on the row that actually won.
  let existingRow = existing;
  let contractRow;
  if (existingRow) {
    contractRow = await updateExistingRow(existingRow);
  } else {
    // Lock window "terms as subscribed under" (v1.13.0): stamp the covering
    // plan's CURRENT lockDays once, at mirror birth — CREATE only, never the
    // update path, so later plan edits cannot rewrite what this subscriber
    // agreed to. Backfill mirrors (install; a contract we are only now
    // meeting) stay null: their subscribe-time terms are unknowable and null
    // is exempt, exactly like the transition dates above. Contained: a
    // failed rule read must never lose the mirror row itself.
    let lockDaysAtCreation: number | null = null;
    if (!backfillCreate) {
      try {
        lockDaysAtCreation = maxLockDaysForPlanIds(
          await getLockRules(shop.id),
          sc.lines.map((l) => l.sellingPlanId),
        );
      } catch (err) {
        console.error("[sync] lockDays stamp failed", shopifyContractGid, err);
      }
    }
    try {
      contractRow = await prisma.subscriptionContract.create({
        data: {
          shopId: shop.id,
          shopifyContractId: shopifyContractGid,
          locale: normalizeLocale(customer?.locale ?? "en"),
          // A brand-new mirror has no explicit verdict to protect — the
          // resolved value (UNKNOWN included) rides the create directly.
          ownership,
          lockDays: lockDaysAtCreation,
          ...shared,
          // First prepaid mirror: seed the deliveries-remaining counter with
          // the full per-charge allotment (see the update-path guard).
          ...(prepaid.isPrepaid
            ? { prepaidDeliveriesRemaining: prepaid.prepaidDeliveriesPerCharge }
            : {}),
          // Origin money may ride the CREATE directly — there is no earlier
          // capture a brand-new row could overwrite.
          ...(originMoney ?? {}),
          ...createStamps,
        },
      });
      transitionDatesOmitted = backfillCreate && status !== "ACTIVE";
      if (createStamps.expiredAt != null) expiredAtStamped = true;
    } catch (err) {
      // Two FIRST-TIME syncs of the same contract race ROUTINELY: Shopify
      // fires SUBSCRIPTION_CONTRACTS_CREATE and _UPDATE back-to-back at
      // checkout, and app.import's post-create sync races the CREATE
      // webhook. Both read `existing == null` at the top, both spend seconds
      // in the Shopify round trips above (variant enrichment, ownership
      // evidence, origin-order fetch), and the loser's create hits the
      // unique shopifyContractId. Propagating that P2002 would abort the
      // whole sync — the CREATE handler's post-sync work (contract.created
      // event, first-order gift, cycle-1/2 gift scheduling, locale backfill,
      // acquisition enrichment) never runs, the webhook answers 200 FAILED,
      // and the retry train is over: the plan-configured first-order gift
      // silently never ships. Instead, re-read the row the winner committed
      // and fall through to the update path — which re-applies the monotonic
      // ownership rule against the winner's verdict, exactly as if the read
      // at the top had seen it.
      if (
        !(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        )
      ) {
        throw err;
      }
      existingRow = await prisma.subscriptionContract.findUnique({
        where: { shopifyContractId: shopifyContractGid },
        include: { lines: true },
      });
      if (!existingRow) {
        // Conflicted row already gone (uninstall cleanup mid-race) — nothing
        // to converge on; surface the original error.
        throw err;
      }
      contractRow = await updateExistingRow(existingRow);
    }
  }

  // The verdict the ROW actually holds after the write above — when the
  // monotonic rule suppressed a stale UNKNOWN, this is the surviving explicit
  // verdict, not the resolution. The audit event below reports this.
  const persistedOwnership =
    normalizeOwnership(contractRow.ownership) ?? ownership;

  // Origin money on an EXISTING row is an atomic first-capture claim — the
  // same shape as runOriginOrderBackfill's. The read-time `existing` check
  // above is only an optimization; without this row-level guard a stale
  // concurrent sync (order fetched before a refund, written after another
  // capture + the refund's increment) could overwrite a captured pre-refund
  // total with the post-refund current total while refundedCents stays
  // incremented — netting the refund twice.
  if (existingRow && originMoney) {
    await prisma.subscriptionContract.updateMany({
      where: { id: existingRow.id, originOrderTotalCents: null },
      data: originMoney,
    });
  }

  // ── Rollup repair for a LATE firstChargeAt backfill ────────────────────────
  // newSubscribers counts a contract on its ARRIVAL day (firstChargeAt ??
  // createdAt). A contract counted via the null-firstChargeAt arm whose
  // firstChargeAt lands only NOW just moved days: the mirror-creation label
  // must drop it and the true arrival label must gain it — without this
  // re-upsert the arrival vanishes from every rollup row once the trailing
  // recompute window passes (the drift rollup.server.ts documents, naming
  // this writer as the repair). Only labels that ALREADY hold a rollup row
  // are re-upserted: a day predating the first rollup ever stays out (no
  // synthesized pre-analytics history — the cohort triangle, which recomputes
  // from source, still charts the arrival) and today's not-yet-written row is
  // left to the nightly run, which sees the corrected column anyway.
  // backfill:true so an existing row keeps its point-in-time snapshots
  // (runDailyRollup's backfill update recomputes flow columns only).
  // Contained + lazily imported: analytics must never fail — or weigh down
  // the module graph of — a mirror sync.
  if (existingRow && existingRow.firstChargeAt == null && firstChargeAt != null) {
    try {
      const [{ runDailyRollup }, { shopDayLabelUtc }] = await Promise.all([
        import("~/lib/analytics/rollup.server"),
        import("~/lib/analytics/queries.server"),
      ]);
      const tz = shop.ianaTimezone;
      const affectedByLabel = new Map<number, Date>();
      for (const instant of [firstChargeAt, existingRow.createdAt]) {
        affectedByLabel.set(shopDayLabelUtc(instant, tz).getTime(), instant);
      }
      const repairable = await prisma.dailyRollup.findMany({
        where: {
          shopId: shop.id,
          date: { in: [...affectedByLabel.keys()].map((t) => new Date(t)) },
        },
        select: { date: true },
      });
      for (const row of repairable) {
        const instant = affectedByLabel.get(row.date.getTime());
        if (instant) {
          await runDailyRollup(shop.id, instant, { backfill: true });
        }
      }
    } catch (err) {
      console.error(
        "[contracts] sync: rollup repair after firstChargeAt backfill failed",
        shopifyContractGid,
        err,
      );
    }
  }

  // ── Replace lines, preserving local flags ─────────────────────────────────
  const localLines = existingRow?.lines ?? [];
  const matchedLocalIds = new Set<string>();

  for (const line of sc.lines) {
    const variant = line.variantId
      ? variantsById.get(line.variantId)
      : undefined;
    const data = lineData(line, variant);

    let match = localLines.find(
      (l) => l.shopifyLineId != null && l.shopifyLineId === line.id,
    );
    if (!match) {
      match = localLines.find(
        (l) =>
          !matchedLocalIds.has(l.id) &&
          !l.isOneTimeAddon &&
          l.variantId === line.variantId,
      );
    }

    if (match) {
      matchedLocalIds.add(match.id);
      await prisma.contractLine.update({
        where: { id: match.id },
        // isGift / isOneTimeAddon / addedVia preserved (not in `data`).
        data: {
          ...data,
          // Never erase ownership evidence: a response that omits the selling
          // plan keeps the plan id we already recorded.
          ...(data.sellingPlanId == null && match.sellingPlanId != null
            ? {
                sellingPlanId: match.sellingPlanId,
                sellingPlanName: match.sellingPlanName,
              }
            : {}),
          // Never erase a known COGS with an unknown one: when variant
          // enrichment failed (or Shopify stopped returning the cost), keep
          // the unit cost we already mirrored — LTGP accuracy degrades to
          // "stale" instead of "missing".
          ...(data.unitCostCents == null && match.unitCostCents != null
            ? { unitCostCents: match.unitCostCents }
            : {}),
          // Same guard for the undiscounted reference price: for lines
          // without a Shopify pricingPolicy it comes from variant enrichment,
          // so one failed getVariants call would null it — and
          // proportionalPriceCents then loses its ratio reference, making
          // swaps and price-change applies charge the FULL catalog price.
          ...(data.compareAtPriceCents == null &&
          match.compareAtPriceCents != null
            ? { compareAtPriceCents: match.compareAtPriceCents }
            : {}),
          // And for the product identity: Shopify nulls a line's product /
          // variant ids when the merchant deletes the product, and enrichment
          // finds nothing — overwriting known ids with "" would silently
          // detach the line from its COGS override and cadence/stockout
          // policy, unrecoverably.
          ...(data.productId === "" && match.productId !== ""
            ? { productId: match.productId }
            : {}),
          ...(data.variantId === "" && match.variantId !== ""
            ? { variantId: match.variantId }
            : {}),
        },
      });
    } else {
      await prisma.contractLine.create({
        data: {
          contractId: contractRow.id,
          ...data,
          // Zero-priced lines arriving from Shopify are gift lines.
          isGift: data.currentPriceCents === 0,
          isOneTimeAddon: false,
          addedVia: "CHECKOUT",
        },
      });
    }
  }

  // Drop local lines Shopify no longer has — except one-time-addon mirrors,
  // which by design never appear in the contract's line list.
  const staleIds = localLines
    .filter((l) => !matchedLocalIds.has(l.id) && !l.isOneTimeAddon)
    .map((l) => l.id);
  if (staleIds.length > 0) {
    await prisma.contractLine.deleteMany({ where: { id: { in: staleIds } } });
  }

  await logEvent({
    shopId: shop.id,
    contractId: contractRow.id,
    customerId: contractRow.customerId,
    email: contractRow.email,
    // `existingRow`, not the top-of-sync read: the loser of the first-sync
    // race logs contract.updated — the winner already logged the one
    // contract.created for this mirror.
    type: existingRow ? "contract.updated" : "contract.created",
    source: options?.source ?? "WEBHOOK",
    actor: resolveActor(options),
    payload: {
      action: "synced_from_shopify",
      shopifyContractId: shopifyContractGid,
      status,
      ...(existingRow && existingRow.status !== status
        ? { previousStatus: existingRow.status }
        : {}),
      // Ownership is why this contract is (or is not) billable — always
      // auditable, and loudly so when it changed. Logged from the ROW the
      // write returned, not the resolved value: when the monotonic rule above
      // suppressed an UNKNOWN downgrade, the row's explicit verdict is the
      // truth this event must carry.
      ownership: persistedOwnership,
      ...(existingRow && existingRow.ownership !== persistedOwnership
        ? { previousOwnership: existingRow.ownership }
        : {}),
      // Shopify-side reactivation (CANCELLED/FAILED → ACTIVE): terminal
      // attempts of the closed episode released back to the scheduler
      // (supersededAt stamp — see updateExistingRow). 0 = clean history or
      // an open dunning case still owns its cycle.
      ...(reactivationRelease != null
        ? { reactivated: true, releasedFailedAttempts: reactivationRelease }
        : {}),
      // Backfill mirror of an already-non-ACTIVE contract: the transition
      // date columns were left null because the real date is unknowable
      // (see the first-mirror stamps) — recorded here instead of invented.
      ...(transitionDatesOmitted ? { transitionDatesUnknown: true } : {}),
      // expiredAt was stamped with the observation instant, not a Shopify
      // timestamp (the API has none) — flag the approximation.
      ...(expiredAtStamped ? { expiredAtApproximated: true } : {}),
      lineCount: sc.lines.length,
    },
  });

  // Subscriber-tag recompute (tagging setting group, v1.23.0): every path
  // that can change whether this customer still holds a live owned contract
  // converges on this sync — webhook transitions, app-internal writers via
  // their webhook echo, install backfills and the daily full_sync_reconcile
  // (which therefore re-converges every customer's tag daily). Membership is
  // recomputed from the mirror, never diffed from this sync's transition, so
  // an echo landing on an already-updated row still corrects the tag. Cheap
  // when nothing changed (CustomerTagState short-circuit). Contained +
  // lazily imported: tagging must never fail — or weigh down the module
  // graph of — a mirror sync.
  try {
    const { maybeSyncSubscriberTag } = await import("~/lib/tagging/tags.server");
    await maybeSyncSubscriberTag(shop.id, contractRow.customerId, {
      contractId: contractRow.id,
    });
  } catch (err) {
    console.error(
      "[contracts] sync: subscriber tag recompute failed",
      shopifyContractGid,
      err,
    );
  }

  // First-order tag heal: a contract that mirrored UNKNOWN (own-plan
  // evidence unreadable at the create moment) is skipped by the create-tail
  // tagging, and that tail never runs again — so when THIS sync is the one
  // that proves the contract ours, the origin order gets its missed tag
  // here. Existing rows only (a fresh billable CREATE is the create tail's
  // job; a backfill CREATE is deliberately untagged — forward-only), and
  // the taggedOrderId event guard keeps a repeat attempt a no-op.
  try {
    if (
      existingRow &&
      contractRow.originOrderId &&
      !isBillableOwnership(existingRow.ownership) &&
      isBillableOwnership(persistedOwnership)
    ) {
      const { maybeTagSubscriptionOrder } = await import(
        "~/lib/tagging/tags.server"
      );
      await maybeTagSubscriptionOrder(
        shop.id,
        contractRow,
        contractRow.originOrderId,
        "first",
        { orderName: contractRow.originOrderName },
      );
    }
  } catch (err) {
    console.error(
      "[contracts] sync: first-order tag heal failed",
      shopifyContractGid,
      err,
    );
  }

  // Welcome-email heal (v1.28.0): the same UNKNOWN→billable moment. The
  // create tail's subscription_started went through the router's ownership
  // gate and was SUPPRESSED(foreign_contract); that reason is the one row
  // the welcome dedupe ignores (subscription-started.server.ts), so this
  // re-invocation sends it now — bounded by
  // settings.notifications.welcomeHealMaxDays from the contract's mirror
  // birth so a long-standing subscriber is never "welcomed" (0 = off), and
  // still refused for imports/backfills (no origin order) inside the helper.
  // Contained: a notification failure never fails a sync.
  try {
    if (
      existingRow &&
      contractRow.originOrderId &&
      !isBillableOwnership(existingRow.ownership) &&
      isBillableOwnership(persistedOwnership)
    ) {
      const { getSetting } = await import("~/lib/settings/settings.server");
      const { welcomeHealMaxDays } = await getSetting(shop.id, "notifications");
      const ageMs = Date.now() - new Date(contractRow.createdAt).getTime();
      if (welcomeHealMaxDays > 0 && ageMs <= welcomeHealMaxDays * 86_400_000) {
        const { maybeSendSubscriptionStarted } = await import(
          "~/lib/notifications/subscription-started.server"
        );
        await maybeSendSubscriptionStarted(shop.id, contractRow.id);
      }
    }
  } catch (err) {
    console.error(
      "[contracts] sync: welcome email heal failed",
      shopifyContractGid,
      err,
    );
  }

  return reloadContract(contractRow.id);
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillResult {
  total: number;
  synced: number;
  failed: number;
  errors: Array<{ gid: string; error: string }>;
}

/**
 * Full mirror sweep: page through every contract GID on Shopify and mirror
 * each one. Individual failures are recorded and skipped so one bad contract
 * cannot abort the whole run. Two callers: onAppInstalled fires it once per
 * install (fire-and-forget, gated on Shop.lastFullSyncAt — contracts that
 * existed BEFORE install never get a webhook, so without this sweep they are
 * simply invisible to billing and analytics), and the daily
 * full_sync_reconcile job re-runs it to catch contracts whose webhooks were
 * permanently missed (Shopify redelivers for ~48h only).
 */
export async function backfillAllContracts(
  shopDomain: string,
): Promise<BackfillResult> {
  const admin = await adminClientForShop(shopDomain);
  const result: BackfillResult = { total: 0, synced: 0, failed: 0, errors: [] };

  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await listContractGids(admin, { cursor, first: 100 });
    for (const gid of page.gids) {
      result.total += 1;
      try {
        await syncContractFromShopify(shopDomain, gid, { source: "SYSTEM" });
        result.synced += 1;
      } catch (err) {
        result.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ gid, error: message });
        console.error("[contracts] backfill: contract sync failed", gid, err);
      }
    }
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    if (!cursor) break;
  }

  // A completed sweep IS the "last full sync" — the only writer of the
  // column, stamped on completion (per-contract failures above are retried
  // by the daily job; a sweep that threw never reaches this). Stamping it at
  // install metadata time, as before, asserted a sync that had not happened
  // and made the install gate in onAppInstalled meaningless.
  try {
    await prisma.shop.update({
      where: { domain: shopDomain },
      data: { lastFullSyncAt: new Date() },
    });
  } catch (err) {
    console.error("[contracts] backfill: lastFullSyncAt stamp failed", shopDomain, err);
  }

  return result;
}

// ── Origin-order money backfill (daily job) ──────────────────────────────────

/** Contracts per run — bounds the job's Shopify round trips. */
export const ORIGIN_BACKFILL_CAP = 200;

/**
 * How long after a contract's mirror is created the acquisition pass keeps
 * treating a missing stash as "order webhook not seen YET" rather than "no
 * stash will ever exist". Shopify redelivers failed webhooks for up to 48
 * hours, so a contract younger than this may still legitimately grow a stash
 * (or be filled by the ORDERS_CREATE direct-persist path); one older than
 * this without a stash never will — its ORDERS_CREATE either predates the
 * stash feature (pre-migration-0006 rows) or its stash payload was cleared
 * by CUSTOMERS_REDACT.
 */
export const ACQ_PICKUP_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * How long after a contract's mirror is created the MONEY pass keeps treating
 * an order-not-found answer as possibly transient (Shopify-side read lag right
 * after checkout) rather than conclusive. getOrderSummary's OrderNotFoundError
 * is the Admin API positively answering `order: null` — for a mirror older
 * than this horizon that can only mean deleted, GDPR-erased, or past the
 * 60-day order-access window without the read_all_orders scope (which
 * shopify.app.toml does not request; it needs Shopify approval). All three are
 * permanent under the app's current access, so the row is stamped
 * originCaptureExhaustedAt and retired from the capped oldest-first window.
 * Deliberately measured on the MIRROR's age, not the order's (which is
 * unknowable — fetching it is what just failed): an established-shop install
 * backfills months-old contracts whose mirrors are minutes old, and they
 * drain within days of install instead of occupying the window for 60 days.
 * Transport/throttle failures are NOT stamped — they throw plain errors and
 * stay retryable. NOT reused from ACQ_PICKUP_GRACE_MS: same value, different
 * clock (webhook-redelivery horizon vs. order-read-visibility horizon).
 */
export const ORIGIN_CAPTURE_GRACE_MS = 48 * 60 * 60 * 1000;

export interface OriginBackfillResult {
  scanned: number;
  captured: number;
  failed: number;
  /**
   * Money-pass rows proven permanently unfetchable and retired from the queue
   * (originCaptureExhaustedAt) this run.
   */
  exhausted: number;
  /**
   * Acquisition pickup pass: contracts scanned / stashes applied / errors /
   * rows proven unfillable and retired from the queue (acqPickupExhaustedAt).
   */
  acqScanned: number;
  acqApplied: number;
  acqFailed: number;
  acqExhausted: number;
}

/**
 * Daily origin_order_backfill job body: capture the origin (checkout) payment
 * for OURS contracts that have an originOrderId but no mirrored money yet —
 * rows that predate migration 0006, rows whose capture-at-sync fetch failed,
 * and rows classified OURS after their create webhook. Oldest first, capped
 * at ORIGIN_BACKFILL_CAP per run; per-contract failures are contained so one
 * dead order GID cannot stall the queue (it is retried next run).
 *
 * DRAINABLE by construction (migration 0011, the money-pass twin of the
 * 0010 fix below): rows already proven unfetchable are excluded
 * (originCaptureExhaustedAt), and every scanned row either captures, errors
 * transiently (retried next run), or — once the API conclusively answers
 * order-not-found for a mirror older than ORIGIN_CAPTURE_GRACE_MS — is
 * stamped terminal and leaves the window. Without that stamp the oldest-first
 * cap was permanently occupied by rows whose orders can never be fetched
 * (>60 days old without the read_all_orders scope, deleted, GDPR-erased):
 * an established-shop install can mirror hundreds of them at once, and every
 * nightly run then burned its whole cap on the same 200 dead fetches while
 * the fetchable rows this job exists for sorted forever after them. The
 * capture-at-sync path ignores the marker (its atomic claim only needs
 * originOrderTotalCents to still be null), so a row stamped while the order
 * was temporarily invisible self-heals on any later successful sync.
 *
 * Also the retry path for ACQUISITION capture: the acquisition.captured stash
 * handshake has exactly two online triggers (ORDERS_CREATE direct-persist and
 * the contract-create/catch-up webhooks), and BOTH can fire while the contract
 * is not yet billable — a contract mirrored UNKNOWN (plan-evidence fetch
 * failed) and reclassified OURS later would otherwise keep its stashed bundle
 * in the event log while the acq* columns stay null forever, exactly the
 * class of case this job already covers for origin MONEY. For OURS non-demo
 * contracts with an originOrderId and no acqRaw yet, re-run the stash pickup
 * (enrichAcquisitionOnContractCreate — its atomic acqRaw-null claim makes
 * this idempotent against concurrent webhook persists). Rows proven
 * unfillable — older than ACQ_PICKUP_GRACE_MS with still no stash — are
 * stamped acqPickupExhaustedAt and excluded from future scans, so the
 * oldest-first capped window always drains (migration 0010).
 *
 * Never touches Shopify state (reads only) and runs ungated in SETUP —
 * analytics capture, not a customer-facing action.
 */
export async function runOriginOrderBackfill(): Promise<
  OriginBackfillResult | { skipped: string }
> {
  const { getPrimaryShop } = await import("~/lib/shop/install.server");
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };

  const pending = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      isDemo: false,
      ...OURS_ONLY,
      originOrderId: { not: null },
      originOrderTotalCents: null,
      // Proven permanently unfetchable (order-not-found past the grace
      // horizon) — retired rows must never re-occupy the capped window.
      originCaptureExhaustedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: ORIGIN_BACKFILL_CAP,
    select: {
      id: true,
      customerId: true,
      email: true,
      currencyCode: true,
      originOrderId: true,
      createdAt: true,
    },
  });

  const result: OriginBackfillResult = {
    scanned: pending.length,
    captured: 0,
    failed: 0,
    exhausted: 0,
    acqScanned: 0,
    acqApplied: 0,
    acqFailed: 0,
    acqExhausted: 0,
  };

  // ── Acquisition stash pickup (see doc block) ───────────────────────────────
  // Independent of the money pass: a contract can have its money mirrored
  // (create-webhook sync) while the acquisition bundle was stashed under an
  // ownership that was not yet billable. No Shopify round trip unless a stash
  // is actually applied, so the cap only bounds the DB work.
  //
  // DRAINABLE by construction: rows already proven unfillable are excluded
  // (acqPickupExhaustedAt below), and every scanned row either applies, errors
  // (retried next run), or — once older than ACQ_PICKUP_GRACE_MS with still no
  // stash — is stamped terminal and leaves the window. Without that stamp the
  // oldest-first cap could be permanently occupied by rows that can never be
  // filled (pre-0006 contracts whose ORDERS_CREATE predates the stash feature,
  // redacted contracts whose stash payloads were cleared), starving the exact
  // reclassified-late contracts this pass exists for.
  const acqPending = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      isDemo: false,
      ...OURS_ONLY,
      originOrderId: { not: null },
      acqRaw: { equals: Prisma.AnyNull },
      acqPickupExhaustedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: ORIGIN_BACKFILL_CAP,
    select: { id: true, createdAt: true },
  });
  if (acqPending.length > 0) {
    result.acqScanned = acqPending.length;
    const graceCutoff = new Date(Date.now() - ACQ_PICKUP_GRACE_MS);
    // Lazy import: the webhooks module owns the stash handshake; loading it at
    // call time keeps the module graphs decoupled (it lazy-imports us back).
    const { enrichAcquisitionOnContractCreate } = await import(
      "~/lib/webhooks/handlers.server"
    );
    for (const contract of acqPending) {
      try {
        const applied = await enrichAcquisitionOnContractCreate(
          shop.domain,
          shop.id,
          contract.id,
        );
        if (applied) {
          result.acqApplied += 1;
        } else if (contract.createdAt <= graceCutoff) {
          // No stash and the webhook-race/redelivery horizon has passed: this
          // row can never be filled by the pickup. Retire it from the queue.
          // The acqRaw-still-null guard keeps the stamp from racing a
          // concurrent direct-persist that just filled the row (in which case
          // it has already left the queue anyway), and the direct-persist path
          // itself ignores the marker, so even a wrongly-stamped row is
          // self-healed by a genuinely late ORDERS_CREATE.
          const marked = await prisma.subscriptionContract.updateMany({
            where: {
              id: contract.id,
              acqRaw: { equals: Prisma.AnyNull },
              acqPickupExhaustedAt: null,
            },
            data: { acqPickupExhaustedAt: new Date() },
          });
          if (marked.count > 0) result.acqExhausted += 1;
        }
      } catch (err) {
        result.acqFailed += 1;
        console.error(
          "[contracts] origin_order_backfill: acquisition pickup failed",
          contract.id,
          err,
        );
      }
    }
  }

  if (pending.length === 0) return result;

  const admin = await adminClientForShop(shop.domain);
  const captureGraceCutoff = new Date(Date.now() - ORIGIN_CAPTURE_GRACE_MS);

  for (const contract of pending) {
    if (!contract.originOrderId) continue;
    try {
      const order = await getOrderSummary(admin, contract.originOrderId);
      const fields = originMoneyFields(order, contract.currencyCode);
      // Idempotent claim: only fills a still-null mirror, so a concurrent
      // sync-capture (or a duplicate job instance) can never overwrite.
      const updated = await prisma.subscriptionContract.updateMany({
        where: { id: contract.id, originOrderTotalCents: null },
        data: fields,
      });
      if (updated.count === 0) continue;
      result.captured += 1;
      await logEvent({
        shopId: shop.id,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "contract.updated",
        source: "SCHEDULER",
        actor: "system",
        payload: {
          action: "origin_order_captured",
          originOrderId: contract.originOrderId,
          totalCents: fields.originOrderTotalCents,
          currencyCode: fields.originOrderCurrencyCode,
          processedAt: fields.originOrderProcessedAt.toISOString(),
        },
      });
    } catch (err) {
      if (
        err instanceof OrderNotFoundError &&
        contract.createdAt <= captureGraceCutoff
      ) {
        // The API positively answered `order: null` for a mirror old enough
        // that read lag is ruled out: the order is deleted, erased, or beyond
        // the 60-day access horizon without read_all_orders. Permanent under
        // the app's current access — retire the row from the queue. The
        // originOrderTotalCents-still-null guard keeps the stamp from racing
        // a concurrent sync-capture that just filled the row (in which case
        // it has already left the queue anyway), and the sync-capture path
        // ignores the marker, so even a wrongly-stamped row is self-healed
        // by any later successful fetch (e.g. after read_all_orders is
        // granted).
        try {
          const marked = await prisma.subscriptionContract.updateMany({
            where: {
              id: contract.id,
              originOrderTotalCents: null,
              originCaptureExhaustedAt: null,
            },
            data: { originCaptureExhaustedAt: new Date() },
          });
          if (marked.count > 0) result.exhausted += 1;
          console.error(
            "[contracts] origin_order_backfill: origin order unfetchable, retired from queue",
            contract.id,
            contract.originOrderId,
            err,
          );
          continue;
        } catch (stampErr) {
          // Stamp write failed (DB hiccup): stay contained like every other
          // per-contract failure — the row is retried, and re-stamped, next run.
          result.failed += 1;
          console.error(
            "[contracts] origin_order_backfill: exhausted-stamp failed",
            contract.id,
            stampErr,
          );
          continue;
        }
      }
      result.failed += 1;
      console.error(
        "[contracts] origin_order_backfill: capture failed",
        contract.id,
        contract.originOrderId,
        err,
      );
    }
  }

  return result;
}
