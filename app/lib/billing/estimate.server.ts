import type { DiscountGrant } from "@prisma/client";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { discountAmount } from "~/lib/money";
import { emailCardLabel } from "~/lib/notifications/payment-method.server";
import { getActiveDiscountForCycle } from "./discounts.server";
import { resolveFollowingBillingDate } from "./following-date.server";

/**
 * `estimateNextCharge` — THE next-order estimate (v1.28.0, P2.4).
 *
 * One computation for every surface that says "this is what your next order
 * is / costs": the upcoming-order reminder (which used to be the only place
 * the live DiscountGrant was applied), the portal home card, the detail
 * "your next delivery" hero and the cancel flow. The arithmetic is exactly
 * the reminder's pre-v1.28 arithmetic, so no customer's number moves:
 *
 *   subtotal = Σ currentPriceCents × quantity over NON-gift lines
 *              (recurring lines AND one-time add-ons — both bill this cycle)
 *   discount = Σ discountAmount(currentPriceCents, grant.percent) × quantity
 *              (best live DiscountGrant, `getActiveDiscountForCycle`; the
 *              percent is applied PER UNIT PRICE and multiplied by quantity —
 *              exactly what `applyGrantToCycle` writes into the Shopify cycle,
 *              so a half-cent rounding can never make the shown total differ
 *              from the charged one — `grantDiscountCents` is the shared form)
 *   total    = subtotal − discount + deliveryPriceCents
 *
 * Dunning parity: when the newest attempt for the current cycle FAILED /
 * CHALLENGED / EXPIRED, the grant was already consumed for that cycle at
 * pre-charge (its Shopify prices are the discounted ones and the retry bills
 * them) — the `cycle_discount_applied` marker for that cycle is then the
 * truth (percent, cyclesRemaining + 1), not the decremented / exhausted grant.
 *
 * Taxes are Shopify's at charge time — this stays an estimate, but the same
 * one everywhere.
 *
 * Lines: the mirror's recurring lines, one-time add-ons (`isOneTimeAddon`),
 * attached gifts (`isGift` mirror rows — a committed zero-priced cycle edit)
 * and `scheduled_gift` rows for SCHEDULED GiftGrants the engine has already
 * COMMITTED to but not yet attached (save-flow gift, win-back perk, day-90
 * reward, admin grant). Never a rule that has not produced a grant: the
 * cycle-2 surprise / gift2 holdout arm is decided inside the gift engine at
 * grant time — until a GiftGrant row exists there is nothing to promise, and
 * this helper promises only what a row proves. Gift rows are free and never
 * change the money.
 *
 * Per-cycle line edits (v1.28.0 Stage D, migration 0028): a line whose
 * `skippedCycleIndex` equals the UPCOMING cycle index (`nextCycleIndex`) is
 * "not this time" — listed with `skippedThisCycle: true`, its plan quantity
 * kept for display, and it contributes 0 to subtotal / discount; a line whose
 * `cycleQuantityOverrideIndex` equals the upcoming index bills
 * `cycleQuantityOverride` units (`quantity` on the estimate line is the
 * billed count, `planQuantity` the recurring one). Indexes that do not match
 * are ignored here — stale ones are nulled by `clearStaleCycleOverrides`,
 * which the settlement / whole-cycle-skip / re-anchor paths call. Because
 * the reminder and every portal card read this estimate, a per-line skip
 * or tweak is reflected everywhere at once.
 *
 * Contained: the grant / gift / event reads each degrade independently (a
 * failed gift read drops the scheduled-gift rows, never the money) — an
 * estimate must never block a portal page or a reminder run.
 */

export type EstimateLineKind =
  | "recurring"
  | "one_time_addon"
  | "gift"
  | "scheduled_gift";

export interface EstimateLine {
  title: string;
  variantTitle: string | null;
  /** Units that BILL this cycle (the one-cycle override when one applies). */
  quantity: number;
  /** The recurring plan quantity — set only when it differs from `quantity`. */
  planQuantity?: number;
  unitPriceCents: number;
  lineTotalCents: number;
  kind: EstimateLineKind;
  free: boolean;
  /** Per-line "not this time" for the upcoming cycle — bills 0, still listed. */
  skippedThisCycle: boolean;
  variantId: string;
  imageUrl: string | null;
}

export interface NextChargeEstimate {
  lines: EstimateLine[];
  /** Plan pricing of the billable lines, before the grant. */
  subtotalCents: number;
  /** Cents the live grant takes off `subtotalCents` (0 without a grant). */
  discountCents: number;
  discountPercent: number | null;
  /** Live grant cycles left INCLUDING this one (null without a grant). */
  discountCyclesRemaining: number | null;
  /** Localized "10% off — 2 discounted orders left" (null without a grant). */
  discountLabel: string | null;
  totalCents: number;
  currency: string;
  deliveryCents: number | null;
  nextBillingDate: Date | null;
  /** nextBillingDate + one billing interval (null without a next date). */
  followingBillingDate: Date | null;
  /** "Visa ····4242" / "PayPal" / "" (revoked or unknown). */
  cardLabel: string;
  /** "12 High St, London W1A 1AA, GB" — or null when nothing is mirrored. */
  addressSummary: string | null;
}

export interface EstimateContractLike {
  id: string;
  ordersCount: number;
  nextBillingDate: Date | null;
  deliveryPriceCents: number;
  currencyCode: string;
  locale: string | null;
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
  paymentInstrumentType?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  paymentMethodRevokedAt?: Date | null;
  deliveryAddress?: unknown;
  lines: Array<{
    variantId: string;
    title: string;
    variantTitle?: string | null;
    imageUrl?: string | null;
    quantity: number;
    currentPriceCents: number;
    isGift?: boolean;
    isOneTimeAddon?: boolean;
    addonCycleIndex?: number | null;
    /** Per-cycle edits (migration 0028) — see module doc. */
    skippedCycleIndex?: number | null;
    cycleQuantityOverride?: number | null;
    cycleQuantityOverrideIndex?: number | null;
  }>;
}

export interface EstimateOptions {
  /** Pre-resolved live grant (skips the read); `null` = known none. */
  grant?: DiscountGrant | null;
  /** Skip the GiftGrant read entirely (surfaces that only need money). */
  includeScheduledGifts?: boolean;
  /**
   * Dunning parity: `false` skips the parked-cycle marker read; a resolved
   * `ParkedCycleDiscount` (or null = known none) is used as is; default reads.
   */
  parkedDiscount?: ParkedCycleDiscount | null | false;
}

interface ScheduledGiftRow {
  variantId: string;
  title: string;
  variantTitle: string | null;
}

/** "Product (Variant)" — hiding Shopify's placeholder single-variant title. */
function cleanVariantTitle(
  productTitle: string,
  variantTitle: string | null | undefined,
): string | null {
  const clean = (variantTitle ?? "").trim();
  if (!clean || clean === "Default Title" || clean === productTitle) return null;
  return clean;
}

/** One-line delivery address from the mirrored Shopify address JSON. */
export function addressSummaryOf(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  const str = (k: string): string =>
    typeof a[k] === "string" ? (a[k] as string).trim() : "";
  const cityLine = [str("city"), str("zip")].filter(Boolean).join(" ");
  const parts = [
    str("address1"),
    str("address2"),
    cityLine,
    str("provinceCode") || str("province"),
    str("countryCode") || str("country"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export type NextCycleIndexContract = Pick<EstimateContractLike, "id" | "ordersCount"> & {
  lines: Array<{
    isOneTimeAddon?: boolean;
    addonCycleIndex?: number | null;
    skippedCycleIndex?: number | null;
    cycleQuantityOverrideIndex?: number | null;
  }>;
};

/**
 * `nextCycleIndex` — the best LOCAL knowledge of the UPCOMING Shopify billing
 * cycle index (no admin call; the sweep resolves the real one by date with
 * `getBillingCycleByDate` at charge time). Every consumer that has to say
 * "does this per-cycle thing ride the next order?" reads this one number:
 * scheduled gifts, per-line skips, one-cycle quantity tweaks, and (through
 * the estimate) the reminder and every portal card.
 *
 *   ordersCount + 1
 *   ⊔ newest non-superseded BillingAttempt.cycleIndex (+1 when it SUCCEEDED
 *     — a FAILED / CHALLENGED / EXPIRED / PENDING attempt still OWNS its
 *     cycle: dunning retries and the in-flight charge bill that index)
 *   ⊔ every cycle index already staged locally against a resolved cycle:
 *     one-time add-ons (`addonCycleIndex`), per-line skips
 *     (`skippedCycleIndex`), quantity overrides (`cycleQuantityOverrideIndex`)
 *
 * Why the joins: ordersCount only moves on a successful charge and every
 * skipped cycle keeps its Shopify index, so after skips the real upcoming
 * index is above ordersCount + 1; anything the service already wrote against
 * a date-resolved cycle is a better witness than the counter. A stale
 * override (index below the upcoming one) never pushes the hint up — max()
 * only ever moves towards the newest evidence — and is nulled by
 * `clearStaleCycleOverrides`.
 *
 * Contained: a failed attempt read degrades to the local joins.
 */
export async function nextCycleIndex(
  contract: NextCycleIndexContract,
): Promise<number> {
  let hint = contract.ordersCount + 1;
  try {
    const newest = await prisma.billingAttempt.findFirst({
      where: { contractId: contract.id, supersededAt: null },
      orderBy: { createdAt: "desc" },
      select: { cycleIndex: true, status: true },
    });
    if (newest) {
      const fromAttempt =
        newest.status === "SUCCESS" ? newest.cycleIndex + 1 : newest.cycleIndex;
      if (fromAttempt > hint) hint = fromAttempt;
    }
  } catch (err) {
    console.error("[billing] estimate: attempt hint read failed", contract.id, err);
  }
  for (const l of contract.lines) {
    if (l.isOneTimeAddon && l.addonCycleIndex != null && l.addonCycleIndex > hint) {
      hint = l.addonCycleIndex;
    }
    if (l.skippedCycleIndex != null && l.skippedCycleIndex > hint) {
      hint = l.skippedCycleIndex;
    }
    if (l.cycleQuantityOverrideIndex != null && l.cycleQuantityOverrideIndex > hint) {
      hint = l.cycleQuantityOverrideIndex;
    }
  }
  return hint;
}

export interface ClearStaleCycleOverridesResult {
  skipsCleared: number;
  overridesCleared: number;
  /** false = the write failed (logged); nothing was cleared. */
  ok: boolean;
}

/**
 * Null every per-line cycle edit on the contract whose cycle index is BELOW
 * `currentIndex` (the upcoming cycle — `nextCycleIndex`, or the resolved
 * `cycle.cycleIndex` the caller already holds). A skip / quantity override
 * only ever targets ONE Shopify cycle; once that cycle settled, was skipped
 * whole, or the schedule re-anchored past it, the mirror flag would otherwise
 * keep telling the estimate "not this time" for a cycle that already
 * happened. Call sites (settlement `consumeCycleOnSuccess`, whole-cycle skip,
 * delay / re-anchor / next-date change, resync) are wired by the Stage D
 * verbs. Overrides ON or ABOVE `currentIndex` are left alone. Contained: a
 * failed write is logged and reported (`ok: false`), never thrown — this runs
 * inside billing paths.
 */
export async function clearStaleCycleOverrides(
  contractId: string,
  currentIndex: number,
): Promise<ClearStaleCycleOverridesResult> {
  try {
    const skips = await prisma.contractLine.updateMany({
      where: { contractId, skippedCycleIndex: { lt: currentIndex } },
      data: { skippedCycleIndex: null },
    });
    const overrides = await prisma.contractLine.updateMany({
      where: { contractId, cycleQuantityOverrideIndex: { lt: currentIndex } },
      data: { cycleQuantityOverride: null, cycleQuantityOverrideIndex: null },
    });
    return { skipsCleared: skips.count, overridesCleared: overrides.count, ok: true };
  } catch (err) {
    console.error(
      "[billing] clearStaleCycleOverrides failed",
      contractId,
      currentIndex,
      err,
    );
    return { skipsCleared: 0, overridesCleared: 0, ok: false };
  }
}

/**
 * SCHEDULED grants that will certainly ride the next chargeable cycle: the
 * engine attaches every SCHEDULED grant at or below the upcoming cycle index
 * (re-anchoring stranded earlier ones), so `cycleIndex ≤ hint` is the
 * commitment test. The hint is `nextCycleIndex` (passed in — computed once
 * per estimate) pushed up by ADDED grants already staged on a resolved cycle.
 * Grants above the hint (an admin gift placed on a later cycle) are not
 * next-order rows.
 */
async function loadScheduledGifts(
  contract: EstimateContractLike,
  upcomingIndex: number,
): Promise<ScheduledGiftRow[]> {
  const grants = await prisma.giftGrant.findMany({
    where: { contractId: contract.id, status: { in: ["SCHEDULED", "ADDED"] } },
    select: {
      id: true,
      cycleIndex: true,
      status: true,
      variantId: true,
      rule: { select: { name: true, variantTitle: true } },
    },
  });
  let hint = upcomingIndex;
  for (const g of grants) {
    if (g.status === "ADDED" && g.cycleIndex > hint) hint = g.cycleIndex;
  }
  const scheduled = grants.filter(
    (g) => g.status === "SCHEDULED" && g.cycleIndex <= hint,
  );
  if (scheduled.length === 0) return [];

  // Titles: the rule's variant title, else the producer's gift_scheduled
  // event (every producer logs `variantTitle` for its grant), else generic.
  const titleByGrant = new Map<string, string>();
  try {
    const events = await prisma.subscriberEvent.findMany({
      where: { contractId: contract.id, type: "lifecycle.gift_scheduled" },
      select: { payload: true },
    });
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown> | null;
      if (p && typeof p.grantId === "string" && typeof p.variantTitle === "string") {
        if (p.variantTitle.trim()) titleByGrant.set(p.grantId, p.variantTitle.trim());
      }
    }
  } catch (err) {
    console.error("[billing] estimate: gift title read failed", contract.id, err);
  }

  const seen = new Set<string>();
  const out: ScheduledGiftRow[] = [];
  for (const g of scheduled) {
    if (seen.has(g.variantId)) continue;
    seen.add(g.variantId);
    const title =
      g.rule?.variantTitle?.trim() ||
      titleByGrant.get(g.id) ||
      g.rule?.name?.trim() ||
      t(contract.locale, "portal.estimate.gift_generic");
    out.push({ variantId: g.variantId, title, variantTitle: null });
  }
  return out;
}

/**
 * THE grant arithmetic (shared with the DISCOUNT save card): the cents a
 * `pct` grant takes off one cycle = Σ discountAmount(unit, pct) × quantity
 * over non-gift lines — per unit price, as `applyGrantToCycle` edits the
 * Shopify cycle (Shopify multiplies the discounted unit by the quantity).
 */
export function grantDiscountCents(
  lines: Array<{ currentPriceCents: number; quantity: number; isGift?: boolean }>,
  pct: number,
): number {
  if (!(pct > 0)) return 0;
  return lines
    .filter((l) => !l.isGift)
    .reduce((sum, l) => sum + discountAmount(l.currentPriceCents, pct) * l.quantity, 0);
}

export interface ParkedCycleDiscount {
  percent: number;
  /** Cycles left INCLUDING the parked one. */
  cyclesRemaining: number;
  cycleIndex: number;
}

/**
 * The discount the CURRENT cycle already carries while dunning owns it: the
 * newest non-superseded attempt is FAILED / CHALLENGED / EXPIRED and a
 * `cycle_discount_applied` marker exists for its cycleIndex. The grant row
 * was decremented (or exhausted) at pre-charge, but the retry bills the
 * discounted cycle prices — so the marker, not the grant, is what the
 * customer will pay. Null when no such parked cycle (contained).
 */
export async function loadParkedCycleDiscount(
  contractId: string,
): Promise<ParkedCycleDiscount | null> {
  try {
    const newest = await prisma.billingAttempt.findFirst({
      where: { contractId, supersededAt: null },
      orderBy: { createdAt: "desc" },
      select: { cycleIndex: true, status: true },
    });
    if (!newest) return null;
    if (!["FAILED", "CHALLENGED", "EXPIRED"].includes(newest.status)) return null;
    const marker = await prisma.subscriberEvent.findFirst({
      where: {
        contractId,
        type: "contract.updated",
        AND: [
          { payload: { path: ["action"], equals: "cycle_discount_applied" } },
          { payload: { path: ["cycleIndex"], equals: newest.cycleIndex } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    const p = marker?.payload as Record<string, unknown> | null | undefined;
    if (!p || typeof p.percent !== "number" || !(p.percent > 0)) return null;
    const remaining =
      typeof p.cyclesRemaining === "number" && p.cyclesRemaining >= 0
        ? p.cyclesRemaining
        : 0;
    return {
      percent: p.percent,
      cyclesRemaining: remaining + 1,
      cycleIndex: newest.cycleIndex,
    };
  } catch (err) {
    console.error("[billing] estimate: parked cycle discount read failed", contractId, err);
    return null;
  }
}

/** Localized "{percent}% off — {count} discounted orders left". */
export function discountLabelFor(
  locale: string | null | undefined,
  percent: number,
  cyclesRemaining: number,
): string {
  const key =
    cyclesRemaining === 1
      ? "portal.estimate.discount_label_one"
      : "portal.estimate.discount_label";
  return t(locale, key, { percent, count: cyclesRemaining });
}

export async function estimateNextCharge(
  shop: string | { id: string; ianaTimezone: string },
  contract: EstimateContractLike,
  opts: EstimateOptions = {},
): Promise<NextChargeEstimate> {
  // Timezone for the following-date step (golden rule 5).
  let tz = "UTC";
  if (typeof shop === "string") {
    try {
      const row = await prisma.shop.findUnique({
        where: { id: shop },
        select: { ianaTimezone: true },
      });
      if (row?.ianaTimezone) tz = row.ianaTimezone;
    } catch (err) {
      console.error("[billing] estimate: shop tz read failed", shop, err);
    }
  } else {
    tz = shop.ianaTimezone;
  }
  const locale = contract.locale;

  // ── Upcoming cycle index (per-cycle edits + scheduled gifts key off it) ─
  const upcomingIndex = await nextCycleIndex(contract);

  // ── Lines from the mirror ────────────────────────────────────────────────
  // `billable` carries the EFFECTIVE quantity per non-gift line (0 when
  // skipped this cycle, the override when one applies) — the money below is
  // computed from it, so subtotal / discount / total match the listed lines.
  const lines: EstimateLine[] = [];
  const billable: Array<{ currentPriceCents: number; quantity: number; isGift?: boolean }> = [];
  const giftVariantIds = new Set<string>();
  for (const l of contract.lines) {
    const kind: EstimateLineKind = l.isGift
      ? "gift"
      : l.isOneTimeAddon
        ? "one_time_addon"
        : "recurring";
    if (l.isGift) giftVariantIds.add(l.variantId);
    const unit = l.isGift ? 0 : l.currentPriceCents;
    const skipped =
      !l.isGift &&
      l.skippedCycleIndex != null &&
      l.skippedCycleIndex === upcomingIndex;
    const overridden =
      !skipped &&
      !l.isGift &&
      l.cycleQuantityOverride != null &&
      l.cycleQuantityOverride >= 0 &&
      l.cycleQuantityOverrideIndex != null &&
      l.cycleQuantityOverrideIndex === upcomingIndex &&
      l.cycleQuantityOverride !== l.quantity;
    const billedQuantity = skipped
      ? 0
      : overridden
        ? (l.cycleQuantityOverride as number)
        : l.quantity;
    if (!l.isGift) {
      billable.push({ currentPriceCents: l.currentPriceCents, quantity: billedQuantity });
    }
    lines.push({
      title: l.title,
      variantTitle: cleanVariantTitle(l.title, l.variantTitle),
      // A skipped line keeps its plan quantity for display ("Serum × 2 —
      // not this time"); an overridden one shows what will bill.
      quantity: skipped ? l.quantity : billedQuantity,
      ...(overridden ? { planQuantity: l.quantity } : {}),
      unitPriceCents: unit,
      lineTotalCents: unit * billedQuantity,
      kind,
      free: l.isGift === true,
      skippedThisCycle: skipped,
      variantId: l.variantId,
      imageUrl: l.imageUrl ?? null,
    });
  }

  // ── Scheduled (committed, not yet attached) gifts ────────────────────────
  if (opts.includeScheduledGifts !== false) {
    try {
      const scheduled = await loadScheduledGifts(contract, upcomingIndex);
      for (const g of scheduled) {
        if (giftVariantIds.has(g.variantId)) continue; // already attached
        lines.push({
          title: g.title,
          variantTitle: g.variantTitle,
          quantity: 1,
          unitPriceCents: 0,
          lineTotalCents: 0,
          kind: "scheduled_gift",
          free: true,
          skippedThisCycle: false,
          variantId: g.variantId,
          imageUrl: null,
        });
      }
    } catch (err) {
      console.error("[billing] estimate: scheduled gift read failed", contract.id, err);
    }
  }

  // ── Money — the sweep's arithmetic (per unit × EFFECTIVE quantity) ─────
  const subtotalCents = billable.reduce(
    (sum, l) => sum + l.currentPriceCents * l.quantity,
    0,
  );

  let grant: DiscountGrant | null = null;
  if (opts.grant !== undefined) {
    grant = opts.grant;
  } else {
    try {
      grant = await getActiveDiscountForCycle(contract.id);
    } catch (err) {
      console.error("[billing] estimate: grant read failed", contract.id, err);
    }
  }
  // Dunning owns the current cycle → the applied marker is the truth (the
  // grant row was already consumed for this very cycle).
  let discountPercent: number | null =
    grant && grant.percent > 0 ? grant.percent : null;
  let discountCyclesRemaining: number | null =
    grant && grant.percent > 0 ? grant.cyclesRemaining : null;
  const parked =
    opts.parkedDiscount === undefined
      ? await loadParkedCycleDiscount(contract.id)
      : opts.parkedDiscount || null;
  if (parked) {
    discountPercent = parked.percent;
    discountCyclesRemaining = parked.cyclesRemaining;
  }
  const discountCents =
    discountPercent != null ? grantDiscountCents(billable, discountPercent) : 0;
  const discountedSubtotal = subtotalCents - discountCents;
  const deliveryCents = contract.deliveryPriceCents;
  const totalCents = discountedSubtotal + deliveryCents;

  // ── Dates ────────────────────────────────────────────────────────────────
  const nextBillingDate = contract.nextBillingDate;
  let followingBillingDate: Date | null = null;
  if (nextBillingDate) {
    try {
      followingBillingDate = await resolveFollowingBillingDate(contract, tz);
    } catch (err) {
      console.error("[billing] estimate: following date failed", contract.id, err);
    }
  }

  // ── Card + address (never throw) ─────────────────────────────────────────
  let cardLabel = "";
  if (contract.paymentMethodRevokedAt == null) {
    try {
      cardLabel = emailCardLabel(locale, {
        paymentInstrumentType: contract.paymentInstrumentType ?? null,
        cardBrand: contract.cardBrand ?? null,
        cardLast4: contract.cardLast4 ?? null,
      });
    } catch (err) {
      console.error("[billing] estimate: card label failed", contract.id, err);
    }
  }

  return {
    lines,
    subtotalCents,
    discountCents,
    discountPercent,
    discountCyclesRemaining,
    discountLabel:
      discountPercent != null && discountCyclesRemaining != null
        ? discountLabelFor(locale, discountPercent, discountCyclesRemaining)
        : null,
    totalCents,
    currency: contract.currencyCode,
    deliveryCents,
    nextBillingDate,
    followingBillingDate,
    cardLabel,
    addressSummary: addressSummaryOf(contract.deliveryAddress),
  };
}
