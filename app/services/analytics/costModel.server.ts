/**
 * Cost model engine [analytics] — ANALYTICS-V2 §1.
 *
 * The single source of truth for profit math. Every consumer that needs a
 * margin, COGS or contribution figure imports `getCostModel` /
 * `orderContribution` from here — no module computes margin on its own.
 *
 * THE UNIT RULE: `ProductMeta.grossMarginPercent` is a FRACTION 0..1 (as the
 * schema documents). All `ShopSettings.settingsJson.costModel` values are
 * integers (cents) or percents 0–100 as named; `getCostModel` normalises the
 * percents to fractions before anything else consumes them.
 *
 * `ShopSettings.settingsJson.costModel` shape (written by the Costs tab):
 * {
 *   "defaultGrossMarginPercent": 70,   // percent 0-100
 *   "shippingPerDeliveryCents": 0,     // what CELLEXIA pays per shipment
 *   "fulfillmentPerDeliveryCents": 0,  // pick/pack/3PL per shipment
 *   "paymentFeePercent": 0,            // e.g. 1.9 (percent of order value)
 *   "paymentFeeFixedCents": 0          // e.g. 30 per charge
 * }
 */
import prisma from "~/db.server";
import { parseJson } from "~/types/domain";

// ───────────────────────────── Types ───────────────────────────────────────

export interface CostModel {
  /** Fraction 0..1 — used when a product has no cost data. */
  defaultMarginFraction: number;
  shippingPerDeliveryCents: number;
  fulfillmentPerDeliveryCents: number;
  /** Fraction 0..1 of order value (normalised from paymentFeePercent). */
  paymentFeeFraction: number;
  paymentFeeFixedCents: number;
  /** True once the merchant saved the cost form at least once — drives the
   *  "set your costs" banners. */
  configured: boolean;
}

/** Per-product cost inputs, straight from ProductMeta (fraction convention). */
export interface ProductCostMeta {
  unitCostCents?: number | null;
  /** FRACTION 0..1, e.g. 0.78 — per the ProductMeta schema. */
  grossMarginPercent?: number | null;
}

export interface OrderContribution {
  revenueCents: number;
  cogsCents: number;
  shippingCents: number;
  fulfillmentCents: number;
  paymentFeeCents: number;
  /** revenue − COGS − shipping − fulfillment − payment fees (LTGP per order). */
  contributionCents: number;
  /** contributionCents / revenueCents, floored at −1; 0 when revenue is 0. */
  contributionFraction: number;
}

// ───────────────────────────── Pure helpers ────────────────────────────────

const DEFAULT_MARGIN_PERCENT = 70;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Percent 0-100 → fraction 0..1, falling back when absent or garbage. */
function percentToFraction(value: unknown, fallbackFraction: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "undefined" || value === null || !Number.isFinite(n)) {
    return fallbackFraction;
  }
  return clamp01(n / 100);
}

/** Non-negative integer cents, 0 when absent or garbage. */
function toCentsInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "undefined" || value === null || !Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.round(n));
}

/**
 * PURE — parse + normalise a ShopSettings.settingsJson string into a
 * CostModel (percents → fractions, defaults applied). `configured` is true
 * exactly when a `costModel` object has been saved at least once.
 */
export function parseCostModel(
  settingsJson: string | null | undefined,
): CostModel {
  const settings = parseJson<Record<string, unknown>>(settingsJson, {});
  const raw = settings.costModel;
  const configured =
    typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const obj = configured ? (raw as Record<string, unknown>) : {};
  return {
    defaultMarginFraction: percentToFraction(
      obj.defaultGrossMarginPercent,
      DEFAULT_MARGIN_PERCENT / 100,
    ),
    shippingPerDeliveryCents: toCentsInt(obj.shippingPerDeliveryCents),
    fulfillmentPerDeliveryCents: toCentsInt(obj.fulfillmentPerDeliveryCents),
    paymentFeeFraction: percentToFraction(obj.paymentFeePercent, 0),
    paymentFeeFixedCents: toCentsInt(obj.paymentFeeFixedCents),
    configured,
  };
}

/** The model of a shop that has configured nothing yet. */
export const UNCONFIGURED_COST_MODEL: CostModel = Object.freeze(
  parseCostModel(null),
);

/**
 * PURE — COGS of one line in cents. Precedence: explicit `unitCostCents`
 * (× quantity) → `grossMarginPercent` fraction → the shop's default margin
 * fraction.
 */
export function productCogsCents(
  line: { priceCents: number; quantity: number },
  meta: {
    unitCostCents?: number | null;
    grossMarginPercent?: number | null;
  } | null,
  model: CostModel,
): number {
  const quantity =
    Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
  if (meta?.unitCostCents != null && Number.isFinite(meta.unitCostCents)) {
    return Math.round(Math.max(0, meta.unitCostCents) * quantity);
  }
  const lineValue = Math.max(0, line.priceCents) * quantity;
  const marginFraction =
    meta?.grossMarginPercent != null && Number.isFinite(meta.grossMarginPercent)
      ? clamp01(meta.grossMarginPercent)
      : model.defaultMarginFraction;
  return Math.round(lineValue * (1 - marginFraction));
}

/**
 * PURE — full LTGP contribution of one order:
 * `contribution = revenue − COGS − shipping − fulfillment − (revenue×feeFraction + feeFixed)`.
 *
 * Per-delivery costs apply once per order (only when the order has lines);
 * payment fees apply only when there is revenue to charge. The fraction is
 * guarded: 0 when revenue is 0, never below −1.
 */
export function orderContribution(
  input: {
    lines: Array<{
      priceCents: number;
      quantity: number;
      meta: {
        unitCostCents?: number | null;
        grossMarginPercent?: number | null;
      } | null;
    }>;
  },
  model: CostModel,
): OrderContribution {
  let revenueCents = 0;
  let cogsCents = 0;
  for (const line of input.lines) {
    const quantity =
      Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    revenueCents += Math.max(0, line.priceCents) * quantity;
    cogsCents += productCogsCents(line, line.meta, model);
  }
  const hasDelivery = input.lines.length > 0;
  const shippingCents = hasDelivery ? model.shippingPerDeliveryCents : 0;
  const fulfillmentCents = hasDelivery ? model.fulfillmentPerDeliveryCents : 0;
  const paymentFeeCents =
    revenueCents > 0
      ? Math.round(revenueCents * model.paymentFeeFraction) +
        model.paymentFeeFixedCents
      : 0;
  const contributionCents =
    revenueCents - cogsCents - shippingCents - fulfillmentCents - paymentFeeCents;
  const contributionFraction =
    revenueCents > 0 ? Math.max(-1, contributionCents / revenueCents) : 0;
  return {
    revenueCents,
    cogsCents,
    shippingCents,
    fulfillmentCents,
    paymentFeeCents,
    contributionCents,
    contributionFraction,
  };
}

// ───────────────────────────── I/O ──────────────────────────────────────────

/** Load the shop's cost model (parse + normalise + defaults). */
export async function getCostModel(shop: string): Promise<CostModel> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  return parseCostModel(settings?.settingsJson);
}

/** Bare numeric tail of a product id ("gid://shopify/Product/123" → "123"). */
function bareProductId(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/**
 * One-query ProductMeta cost lookup, tolerant of GID and bare product ids on
 * both sides. The returned map answers lookups by the exact id the caller
 * used, its bare tail, and its GID form.
 */
export async function metaByProductId(
  shop: string,
  productIds: string[],
): Promise<
  Map<string, { unitCostCents: number | null; grossMarginPercent: number | null }>
> {
  const candidates = new Set<string>();
  for (const id of productIds) {
    if (!id) continue;
    const bare = bareProductId(id);
    candidates.add(id);
    candidates.add(bare);
    candidates.add(`gid://shopify/Product/${bare}`);
  }
  const map = new Map<
    string,
    { unitCostCents: number | null; grossMarginPercent: number | null }
  >();
  if (candidates.size === 0) return map;

  const rows = await prisma.productMeta.findMany({
    where: { shop, shopifyProductId: { in: [...candidates] } },
    select: {
      shopifyProductId: true,
      unitCostCents: true,
      grossMarginPercent: true,
    },
  });
  for (const row of rows) {
    const value = {
      unitCostCents: row.unitCostCents,
      grossMarginPercent: row.grossMarginPercent,
    };
    const bare = bareProductId(row.shopifyProductId);
    map.set(row.shopifyProductId, value);
    map.set(bare, value);
    map.set(`gid://shopify/Product/${bare}`, value);
  }
  return map;
}
