import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { COUNTABLE_CONTRACT } from "./queries.server";

/**
 * The analytics cost model — the ONE place per-line COGS, per-shipment
 * fulfillment/shipping cost and payment fees are resolved.
 *
 * Both gross-profit surfaces (DailyRollup.estGrossProfitCents and
 * CohortCell.grossProfitCents) consume these helpers, so the two can never
 * disagree by construction again. The shared formula is:
 *
 *   gross profit = revenue collected (net of refunds)
 *                − COGS (resolved per line, see resolveLineCogs)
 *                − fulfillment + shipping cost per shipment
 *                − payment processing fees per charge
 *
 * COGS resolution order per billed line (first known value wins):
 *   1. ContractLine.unitCostCents        — synced from Shopify inventoryItem cost
 *   2. ProductCadence.unitCostCentsOverride — merchant-entered override
 *      (variant-level row first, then the product-level row)
 *   3. costModel.cogsFallbackPctOfPrice × line price — ESTIMATED; every use is
 *      counted (estimatedCogsCents) so coverage can be reported honestly.
 *
 * Settings live under the "costModel" key (app/lib/settings/registry.server.ts)
 * and are edited on the Settings page ("Costs & profit" section); per-product
 * overrides are edited on the Plans page ("Costs & margins" section).
 */

export type CostModelSettings = SettingsValue<"costModel">;

/** How a line's COGS value was obtained. */
export type CogsSource = "SHOPIFY" | "OVERRIDE" | "ESTIMATED";

/** Line shape the cost resolution needs (subset of ContractLine). */
export interface LineForCogs {
  productId: string;
  variantId: string;
  quantity: number;
  currentPriceCents: number;
  unitCostCents: number | null;
  isGift: boolean;
}

/** Merchant COGS overrides, pre-indexed for O(1) per-line lookup. */
export interface CogsOverrides {
  /** `${productId}|${variantId}` → cents (variant-level rows). */
  byVariant: ReadonlyMap<string, number>;
  /** productId → cents (product-level rows, variantId null). */
  byProduct: ReadonlyMap<string, number>;
}

/** Everything cost resolution needs, loaded once per computation run. */
export interface CostContext {
  costModel: CostModelSettings;
  overrides: CogsOverrides;
}

export const EMPTY_OVERRIDES: CogsOverrides = {
  byVariant: new Map(),
  byProduct: new Map(),
};

/** Load the cost model + per-product overrides for a shop (one settings read + one query). */
export async function loadCostContext(shopId: string): Promise<CostContext> {
  const [costModel, overrideRows] = await Promise.all([
    getSetting(shopId, "costModel"),
    prisma.productCadence.findMany({
      where: { shopId, unitCostCentsOverride: { not: null } },
      select: { productId: true, variantId: true, unitCostCentsOverride: true },
    }),
  ]);

  const byVariant = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const row of overrideRows) {
    if (row.unitCostCentsOverride == null) continue;
    if (row.variantId) {
      byVariant.set(`${row.productId}|${row.variantId}`, row.unitCostCentsOverride);
    } else {
      byProduct.set(row.productId, row.unitCostCentsOverride);
    }
  }
  return { costModel, overrides: { byVariant, byProduct } };
}

export interface ResolvedLineCogs {
  /** Per-UNIT cost in cents (multiply by quantity for the line total). */
  unitCostCents: number;
  source: CogsSource;
  /** True when the value came from the percentage-of-price fallback. */
  estimated: boolean;
}

/**
 * Resolve one line's per-unit COGS: synced Shopify cost → merchant override
 * (variant row, then product row) → percentage-of-price estimate.
 *
 * Exported for tests — this is the resolution order the whole analytics
 * module depends on.
 */
export function resolveLineCogs(
  line: Pick<LineForCogs, "productId" | "variantId" | "currentPriceCents" | "unitCostCents">,
  ctx: CostContext,
): ResolvedLineCogs {
  if (line.unitCostCents != null) {
    return { unitCostCents: line.unitCostCents, source: "SHOPIFY", estimated: false };
  }
  const override =
    ctx.overrides.byVariant.get(`${line.productId}|${line.variantId}`) ??
    ctx.overrides.byProduct.get(line.productId);
  if (override != null) {
    return { unitCostCents: override, source: "OVERRIDE", estimated: false };
  }
  return {
    unitCostCents: Math.round(
      (line.currentPriceCents * ctx.costModel.cogsFallbackPctOfPrice) / 100,
    ),
    source: "ESTIMATED",
    estimated: true,
  };
}

export interface PerCycleCosts {
  /** Total COGS of the cycle's lines (known + estimated), in cents. */
  cogsCents: number;
  /** Portion of cogsCents that came from the percentage fallback. */
  estimatedCogsCents: number;
  /** Lines whose COGS had to be estimated (no Shopify cost, no override). */
  linesEstimated: number;
}

/**
 * COGS for one billed cycle, resolved per line through resolveLineCogs.
 * `includeGifts: false` excludes gift lines so callers that account gift COGS
 * separately (via GiftGrant → GiftRule.unitCostCents) do not double count.
 *
 * Note: a zero-priced gift line under the fallback estimates 0 anyway, but the
 * exclusion keeps the accounting explicit.
 */
export function perCycleLineCosts(
  lines: LineForCogs[],
  ctx: CostContext,
  opts: { includeGifts: boolean },
): PerCycleCosts {
  let cogsCents = 0;
  let estimatedCogsCents = 0;
  let linesEstimated = 0;
  for (const line of lines) {
    if (line.isGift && !opts.includeGifts) continue;
    const resolved = resolveLineCogs(line, ctx);
    const lineTotal = resolved.unitCostCents * line.quantity;
    cogsCents += lineTotal;
    if (resolved.estimated) {
      estimatedCogsCents += lineTotal;
      linesEstimated += 1;
    }
  }
  return { cogsCents, estimatedCogsCents, linesEstimated };
}

// ── Per-charge cost snapshot (migration 0016) ────────────────────────────────

/** Contract shape computeChargeCostSnapshot needs (subset of SubscriptionContract). */
export interface ContractWithLines {
  deliveryPriceCents: number;
  isPrepaid: boolean;
  prepaidDeliveriesPerCharge: number | null;
  lines: LineForCogs[];
}

/** One resolved non-gift line inside a stored ChargeCostSnapshot. */
export interface ChargeCostSnapshotLine {
  variantId: string;
  quantity: number;
  /** currentPriceCents at snapshot time (the price the cost was resolved against). */
  priceCents: number;
  /** Resolved per-UNIT cost at snapshot time. */
  unitCostCents: number;
  /** True when the value came from the percentage-of-price fallback. */
  estimated: boolean;
}

/**
 * The cost basis of ONE charge, frozen at settlement into
 * BillingAttempt.costSnapshot so gross-profit history stops being repriced by
 * later cost-setting edits (the nightly cohort rebuild used to re-resolve all
 * history with today's costs).
 *
 * All *Cents totals are per CHARGE — already multiplied by deliveriesPerCharge
 * (prepaid: one charge ships N deliveries) — so readers add them directly.
 * Payment fees are deliberately ABSENT: they depend on the charged
 * amountCents, which lives on the attempt row, so the reader computes them at
 * read time (fee settings are a merchant-wide config, not a per-line basis).
 * Gift lines are excluded entirely (totals AND lines[]): gift COGS is booked
 * once per GiftGrant, never per charge — the same accounting split both
 * gross-profit surfaces already apply.
 */
export interface ChargeCostSnapshot {
  v: 1;
  cogsCents: number;
  /** Portion of cogsCents that came from the percentage fallback. */
  estimatedCogsCents: number;
  /** Carrier cost leg of the shipment cost (per charge). */
  shippingCostCents: number;
  /** Merchant-side fulfillment leg (per charge). */
  fulfillmentCostCents: number;
  deliveriesPerCharge: number;
  lines: ChargeCostSnapshotLine[];
}

/**
 * Resolve a charge's full cost basis through the shared cost model, in the
 * exact shape stored on BillingAttempt.costSnapshot. Called by the settlement
 * paths (success webhook + stale-attempt sweep) with the contract as mirrored
 * at settlement; pure over its inputs so it is safely testable.
 *
 * `opts.deliveriesPerCharge` overrides the contract-derived shipment count for
 * callers that already resolved it (defaults to the same prepaid rule the
 * live readers use).
 */
export function computeChargeCostSnapshot(
  ctx: CostContext,
  contract: ContractWithLines,
  opts: { deliveriesPerCharge?: number } = {},
): ChargeCostSnapshot {
  const deliveries = Math.max(
    1,
    opts.deliveriesPerCharge ??
      (contract.isPrepaid ? (contract.prepaidDeliveriesPerCharge ?? 1) : 1),
  );

  let cogsCents = 0;
  let estimatedCogsCents = 0;
  const lines: ChargeCostSnapshotLine[] = [];
  for (const line of contract.lines) {
    if (line.isGift) continue; // booked per GiftGrant — see interface doc
    const resolved = resolveLineCogs(line, ctx);
    const lineTotal = resolved.unitCostCents * line.quantity;
    cogsCents += lineTotal;
    if (resolved.estimated) estimatedCogsCents += lineTotal;
    lines.push({
      variantId: line.variantId,
      quantity: line.quantity,
      priceCents: line.currentPriceCents,
      unitCostCents: resolved.unitCostCents,
      estimated: resolved.estimated,
    });
  }

  // Split the perShipmentCostCents legs so the snapshot stays inspectable
  // (which part was carrier cost vs fulfillment) — readers sum both.
  const shippingPerShipment =
    ctx.costModel.shippingCostPerShipmentCents.mode === "charged"
      ? Math.max(0, contract.deliveryPriceCents)
      : ctx.costModel.shippingCostPerShipmentCents.flatCents;

  return {
    v: 1,
    cogsCents: cogsCents * deliveries,
    estimatedCogsCents: estimatedCogsCents * deliveries,
    shippingCostCents: shippingPerShipment * deliveries,
    fulfillmentCostCents:
      ctx.costModel.fulfillmentCostPerShipmentCents * deliveries,
    deliveriesPerCharge: deliveries,
    lines,
  };
}

/**
 * Validate a BillingAttempt.costSnapshot Json value back into a typed
 * snapshot, or null when absent/unrecognized. Readers (rollup + cohorts)
 * PREFER a parsed snapshot and fall back to live cost resolution when this
 * returns null — pre-0016 attempts carry no snapshot and keep the historical
 * live-model semantics (repriced by today's cost settings, the documented
 * approximation they always had). An unknown version fails closed to the
 * fallback rather than misreading a future shape.
 */
export function parseChargeCostSnapshot(
  value: unknown,
): ChargeCostSnapshot | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snap = value as Record<string, unknown>;
  if (snap.v !== 1) return null;
  for (const field of [
    "cogsCents",
    "estimatedCogsCents",
    "shippingCostCents",
    "fulfillmentCostCents",
    "deliveriesPerCharge",
  ] as const) {
    if (typeof snap[field] !== "number" || !Number.isFinite(snap[field])) {
      return null;
    }
  }
  return snap as unknown as ChargeCostSnapshot;
}

/** Payment processing fee for one successful charge, per the cost model. */
export function paymentFeeCents(
  amountCents: number,
  costModel: CostModelSettings,
): number {
  if (amountCents <= 0) return 0;
  return (
    Math.round((amountCents * costModel.paymentFeePct) / 100) +
    costModel.paymentFeeFixedCents
  );
}

// ── VAT / sales tax (reporting cost) ─────────────────────────────────────────

/** One charge's inputs to VAT resolution (shop-currency cents). */
export interface VatCharge {
  /** Money kept for this charge — amount charged net of recorded refunds. */
  netAmountCents: number;
  /** Amount originally charged — the base the captured tax was computed on. */
  grossAmountCents: number;
  /**
   * REAL tax captured from the order mirror (BillingAttempt.taxCents /
   * SubscriptionContract.originOrderTaxCents). Still collected (data
   * foundation, additive promise) but NOT used by the deduction since
   * v1.16.0 — the merchant's VAT model is a flat percentage of revenue, and
   * the captured figure is the tax-extracted-from-gross amount (a different,
   * smaller number on tax-inclusive prices). Kept in the input shape so the
   * capture pipeline stays exercised and a future model can opt back in.
   */
  capturedTaxCents: number | null;
  /** ISO country the charge ships to (contractTaxCountry), null when unknown. */
  countryCode: string | null;
}

export interface ResolvedVat {
  /** VAT booked against this charge's kept money, in cents. */
  vatCents: number;
  /** True whenever a configured rate produced a (possibly zero) deduction. */
  estimated: boolean;
}

/** The configured VAT rate for a country: exact country entry, else the default. */
export function vatRatePctForCountry(
  costModel: CostModelSettings,
  countryCode: string | null,
): number {
  if (!costModel.vat.enabled) return 0;
  if (countryCode) {
    const exact = costModel.vat.countryRatesPct[countryCode.toUpperCase()];
    if (exact != null) return exact;
  }
  return costModel.vat.defaultRatePct;
}

/**
 * VAT booked against one charge's kept money — a REPORTING cost subtracted by
 * both gross-profit surfaces when the vat setting is enabled (never touches
 * billing).
 *
 * The model (v1.16.0, merchant-defined): VAT is a flat percentage of revenue,
 * subtracted exactly like any other expense — kept money × rate/100, so a
 * CHF 100.00 charge at 8.1% books CHF 8.10. This deliberately replaces BOTH
 * v1.15.0 paths (captured order tax, and the net × rate/(100+rate)
 * extraction): each produced the tax-extracted-from-gross figure (CHF 7.49
 * on that example), which is not the model the merchant runs their P&L on.
 * `capturedTaxCents` keeps arriving in the input (still collected per the
 * data foundation) but no longer drives the deduction.
 *
 * The rate is the contract country's entry, else the default rate. Every
 * rate-derived deduction is flagged `estimated` and accumulated into
 * estimatedVatCents, so the surfaces disclose that VAT figures are modeled
 * from configured rates rather than read off orders.
 *
 * Disabled setting or non-positive kept money resolves to zero.
 */
export function resolveChargeVat(
  charge: VatCharge,
  costModel: CostModelSettings,
): ResolvedVat {
  if (!costModel.vat.enabled || charge.netAmountCents <= 0) {
    return { vatCents: 0, estimated: false };
  }
  const ratePct = vatRatePctForCountry(costModel, charge.countryCode);
  if (ratePct <= 0) return { vatCents: 0, estimated: true };
  return {
    vatCents: Math.round((charge.netAmountCents * ratePct) / 100),
    estimated: true,
  };
}

/**
 * Fulfillment + shipping cost the MERCHANT pays for one shipment.
 *
 * `deliveryChargedCents` is what the customer paid for delivery on that
 * contract — used only in "charged" mode (cost ≈ pass-through). It is NEVER
 * subtracted from revenue elsewhere: customer-paid delivery is already inside
 * the charged amount, i.e. it is revenue, not a cost.
 */
export function perShipmentCostCents(
  costModel: CostModelSettings,
  deliveryChargedCents: number,
): number {
  const shipping =
    costModel.shippingCostPerShipmentCents.mode === "charged"
      ? Math.max(0, deliveryChargedCents)
      : costModel.shippingCostPerShipmentCents.flatCents;
  return costModel.fulfillmentCostPerShipmentCents + shipping;
}

// ── Coverage reporting ────────────────────────────────────────────────────────

export interface CostCoverageProduct {
  productId: string;
  variantId: string;
  title: string;
}

export interface CostCoverage {
  /** Non-gift lines on countable contracts with a known (non-estimated) COGS, ÷ all such lines, ×100. */
  linesWithKnownCogsPct: number;
  /** Same but weighted by line revenue (price × quantity), ×100. */
  revenueWithKnownCogsPct: number;
  /** Distinct products/variants currently billed with NO known cost — set them on the Plans page. */
  productsMissingCogs: CostCoverageProduct[];
  /** Denominator context: how many non-gift lines were examined. */
  totalLines: number;
  // ── Presentation conveniences (derived from the fields above) ──────────────
  /** Lines whose COGS had to be estimated (totalLines − known lines). */
  linesMissingCost: number;
  /** Alias of linesWithKnownCogsPct (0–100) for banner copy. */
  coveragePct: number;
  /** productsMissingCogs.length — how many products need a cost set. */
  productsMissingCost: number;
  /** First few missing-product titles for banner copy. */
  sampleProductTitles: string[];
}

/**
 * How much of the currently-billed book has a KNOWN cost (Shopify inventory
 * cost or merchant override) versus the percentage estimate. Powers the
 * "LTGP is partly estimated" banner on the analytics page and the coverage
 * badges on the Plans page.
 *
 * Scope: lines of ACTIVE + PAUSED countable contracts (ours, non-demo) — the
 * book whose future LTGP the merchant is pricing decisions against.
 */
export async function getCostCoverage(shopId: string): Promise<CostCoverage> {
  const [ctx, contracts] = await Promise.all([
    loadCostContext(shopId),
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        status: { in: ["ACTIVE", "PAUSED"] },
        ...COUNTABLE_CONTRACT,
      },
      select: {
        lines: {
          select: {
            productId: true,
            variantId: true,
            title: true,
            quantity: true,
            currentPriceCents: true,
            unitCostCents: true,
            isGift: true,
          },
        },
      },
    }),
  ]);

  let totalLines = 0;
  let knownLines = 0;
  let totalRevenue = 0;
  let knownRevenue = 0;
  const missing = new Map<string, CostCoverageProduct>();

  for (const contract of contracts) {
    for (const line of contract.lines) {
      if (line.isGift) continue;
      totalLines += 1;
      const lineRevenue = line.currentPriceCents * line.quantity;
      totalRevenue += lineRevenue;
      const resolved = resolveLineCogs(line, ctx);
      if (resolved.estimated) {
        const key = `${line.productId}|${line.variantId}`;
        if (!missing.has(key)) {
          missing.set(key, {
            productId: line.productId,
            variantId: line.variantId,
            title: line.title,
          });
        }
      } else {
        knownLines += 1;
        knownRevenue += lineRevenue;
      }
    }
  }

  const pct = (num: number, den: number): number =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : 100;

  const productsMissingCogs = [...missing.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const linesWithKnownCogsPct = pct(knownLines, totalLines);

  return {
    linesWithKnownCogsPct,
    revenueWithKnownCogsPct: pct(knownRevenue, totalRevenue),
    productsMissingCogs,
    totalLines,
    linesMissingCost: totalLines - knownLines,
    coveragePct: linesWithKnownCogsPct,
    productsMissingCost: productsMissingCogs.length,
    sampleProductTitles: productsMissingCogs.slice(0, 5).map((p) => p.title),
  };
}
