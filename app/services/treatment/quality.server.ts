/**
 * Subscriber quality score — how healthy a new (or existing) treatment plan
 * looks for long-term value. Pure scoring plus small derived policies:
 * onboarding tier and dunning aggressiveness.
 *
 * Score is 0..100. Weights (documented, mirrored in docs/TREATMENT.md):
 *
 * | Factor              | Contribution                                        |
 * |---------------------|-----------------------------------------------------|
 * | base                | +50 (neutral starting point)                        |
 * | acquisitionSource   | −10..+10 (organic/referral good, deal sites bad)    |
 * | discountPercent     | −0.6 pt per % off, floored at −20                   |
 * | quantity            | +4 per unit beyond the first, capped at +12         |
 * | productMarginPercent| (margin − 0.5) × 40, clamped to ±15                 |
 * | hasPurchaseHistory  | +8 when true                                        |
 * | oneTimePurchases    | +2 per prior one-time purchase, capped at +10       |
 * | widgetEngaged       | +5 when the customer engaged deliberately           |
 * | firstOrderMarginCents| +1 pt per €10 contribution margin, clamped to ±10  |
 * | refundRiskFlag      | −20 when flagged                                    |
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import type { ScoreKind } from "~/types/domain";

export interface QualityFeatures {
  /** Attribution slug, e.g. "organic", "referral", "paid_social", "deal_site". */
  acquisitionSource: string;
  /** Acquisition discount as a percent, e.g. 20 for 20% off. */
  discountPercent: number;
  /** Units on the initial plan. */
  quantity: number;
  /** Blended product gross margin as a fraction, e.g. 0.72. */
  productMarginPercent: number;
  hasPurchaseHistory: boolean;
  /** Count of prior one-time purchases. */
  oneTimePurchases: number;
  /** Deliberately engaged with a treatment/cadence widget before subscribing. */
  widgetEngaged: boolean;
  /** Contribution margin of the first order, integer cents. */
  firstOrderMarginCents: number;
  refundRiskFlag: boolean;
}

const BASE_SCORE = 50;

/** Points by acquisition source (lowercased); unknown sources score 0. */
export const ACQUISITION_SOURCE_POINTS: Record<string, number> = {
  organic: 10,
  referral: 10,
  email: 8,
  direct: 6,
  influencer: 4,
  paid_search: 2,
  paid_social: 0,
  affiliate: -4,
  giveaway: -8,
  deal_site: -10,
  coupon_site: -10,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pure. Returns the 0..100 score and the per-factor breakdown. */
export function computeQualityScore(features: QualityFeatures): {
  score: number;
  factors: Record<string, number>;
} {
  const factors: Record<string, number> = { base: BASE_SCORE };

  factors.acquisitionSource =
    ACQUISITION_SOURCE_POINTS[features.acquisitionSource.trim().toLowerCase()] ?? 0;

  factors.discount = clamp(-0.6 * Math.max(0, features.discountPercent), -20, 0);

  factors.quantity = clamp((Math.max(1, features.quantity) - 1) * 4, 0, 12);

  factors.productMargin = clamp((features.productMarginPercent - 0.5) * 40, -15, 15);

  factors.purchaseHistory = features.hasPurchaseHistory ? 8 : 0;

  factors.oneTimePurchases = clamp(Math.max(0, features.oneTimePurchases) * 2, 0, 10);

  factors.widgetEngaged = features.widgetEngaged ? 5 : 0;

  // +1 point per 1000 cents (€10) of first-order contribution margin.
  factors.firstOrderMargin = clamp(features.firstOrderMarginCents / 1000, -10, 10);

  factors.refundRisk = features.refundRiskFlag ? -20 : 0;

  const raw = Object.values(factors).reduce((sum, v) => sum + v, 0);
  const score = clamp(Math.round(raw), 0, 100);
  return { score, factors };
}

export type OnboardingTier = "WHITE_GLOVE" | "STANDARD" | "LIGHT";

/**
 * Higher-quality subscribers get a heavier-touch onboarding — they justify
 * the cost and respond to it.
 */
export function deriveOnboardingTier(score: number): OnboardingTier {
  if (score >= 70) return "WHITE_GLOVE";
  if (score >= 40) return "STANDARD";
  return "LIGHT";
}

export type DunningAggressiveness = "GENTLE" | "STANDARD" | "ASSERTIVE";

/**
 * High-quality subscribers are approached gently on payment failure (patient
 * retries, soft copy — the relationship is worth protecting). Low-quality
 * cohorts get a shorter, more assertive sequence to cap recovery cost.
 */
export function dunningAggressiveness(score: number): DunningAggressiveness {
  if (score >= 70) return "GENTLE";
  if (score >= 40) return "STANDARD";
  return "ASSERTIVE";
}

/**
 * Convenience: compute, persist to the contract's denormalised qualityScore,
 * snapshot into ScoreSnapshot for explainability, and audit.
 */
export async function snapshotQualityScore(
  shop: string,
  contractId: string,
  features: QualityFeatures,
): Promise<{ score: number; factors: Record<string, number> }> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
    select: { id: true, shop: true },
  });
  if (!contract || contract.shop !== shop) {
    throw new Error(`snapshotQualityScore: contract not found: ${contractId}`);
  }
  const { score, factors } = computeQualityScore(features);
  const kind: ScoreKind = "QUALITY";
  await prisma.subscriptionContract.update({
    where: { id: contractId },
    data: { qualityScore: score },
  });
  await prisma.scoreSnapshot.create({
    data: {
      shop,
      contractId,
      kind,
      value: score,
      factorsJson: JSON.stringify(factors),
    },
  });
  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "QUALITY_SCORE_SNAPSHOT",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: { score, factors },
  });
  return { score, factors };
}
