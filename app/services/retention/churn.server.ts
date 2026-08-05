/**
 * [retention] Churn-risk scoring.
 *
 * computeChurnRisk is PURE (weighted logistic-style model over normalised
 * behavioural features, returning a 0..1 score plus a per-feature factor
 * breakdown for explainability). Every feature is a signal the app REALLY
 * collects today — no permanently-defaulted inputs quietly eating the
 * model's weight budget (the launch model carried ~39% of its positive
 * weight on refunds/tickets/ratings that nothing ever wrote, which pushed
 * textbook at-risk customers under the alert threshold forever).
 *
 * runChurnScanJob assembles features, applies the learned calibration curve
 * (analytics/learning.server, CHURN_CALIBRATION ModelState) to the raw
 * score, snapshots both, and emits HIGH_CHURN_RISK with a suggested
 * proactive intervention (always the cheapest structural offer matching the
 * risk driver).
 */
import prisma from "~/db.server";
import { addDays, daysBetween, isoDate, startOfWeek } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import {
  CALIBRATION_SNAPSHOT_MAX_AGE_DAYS,
  applyCalibration,
  getModelState,
} from "~/services/analytics/learning.server";
import type { CalibrationBucket } from "~/services/analytics/learning.server";
import { discomfortReported } from "~/services/treatment/adherence.server";
import { parseJson } from "~/types/domain";
import type { SaveOfferType } from "~/types/domain";

// ─────────────────────────── Pure: the model ──────────────────────────────

export interface ChurnFeatures {
  /** PORTAL_VIEW telemetry events in the last 30 days (real page views). */
  portalVisits30d: number;
  /** Customer-initiated delivery delays in the last 90 days. */
  delays90d: number;
  /** Customer-initiated skips in the last 90 days. */
  skips90d: number;
  failedCharges90d: number;
  /** Days of product the customer is estimated to have beyond need. */
  inferredExcessDays: number;
  /** Latest adherence survey reported discomfort/irritation. */
  adherenceDiscomfort: boolean;
  /** Products added to the plan (portal/routine/add-ons) in 90 days. */
  addOnActivity90d: number;
  /** Percent change of recent order value vs. before (negative = shrinking). */
  aovTrendPct: number;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Weights of the logistic-style model. Positive = pushes risk up. Feature
 * values are normalised to [0..1] (or [-0.5..1] for the AOV trend) before
 * weighting, so weights are directly comparable in the factor breakdown.
 *
 * Calibration targets (asserted in tests/retention/churn.test.ts):
 *  - a clean contract sits near the sigmoid(bias) floor ≈ 0.10;
 *  - the textbook production at-risk case (3 failed charges, 2 skips,
 *    30 surplus days) crosses DEFAULT_CHURN_THRESHOLD;
 *  - maxed engagement (portal + add-ons) keeps a busy-but-happy
 *    subscriber below threshold.
 */
const WEIGHTS = {
  bias: -2.2,
  portalVisits30d: -0.5, // self-managing subscribers adjust, not cancel
  delays90d: 0.9,
  skips90d: 1.15,
  failedCharges90d: 1.4,
  inferredExcessDays: 1.0,
  adherenceDiscomfort: 0.8,
  addOnActivity90d: -0.6, // investing in the routine is protective
  aovDecline: 0.65,
} as const;

export function computeChurnRisk(features: ChurnFeatures): {
  score: number;
  factors: Record<string, number>;
} {
  const normalised: Record<string, number> = {
    portalVisits30d: clamp(features.portalVisits30d, 0, 10) / 10,
    delays90d: clamp(features.delays90d, 0, 4) / 4,
    skips90d: clamp(features.skips90d, 0, 4) / 4,
    failedCharges90d: clamp(features.failedCharges90d, 0, 3) / 3,
    inferredExcessDays: clamp(features.inferredExcessDays, 0, 60) / 60,
    adherenceDiscomfort: features.adherenceDiscomfort ? 1 : 0,
    addOnActivity90d: clamp(features.addOnActivity90d, 0, 3) / 3,
    // Declining spend raises risk (caps at −50%); growth is mildly protective.
    aovDecline: clamp(-features.aovTrendPct / 50, -0.5, 1),
  };

  const factors: Record<string, number> = { baseline: WEIGHTS.bias };
  let z = WEIGHTS.bias;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (key === "bias") continue;
    const contribution =
      (weight as number) * (normalised[key as keyof typeof normalised] ?? 0);
    factors[key] = Math.round(contribution * 10_000) / 10_000;
    z += contribution;
  }

  return { score: sigmoid(z), factors };
}

// ─────────────────────────── Pure: interventions ──────────────────────────

export interface ProactiveIntervention {
  offerType: SaveOfferType;
  /** Customer-facing suggestion, Continuous Treatment voice. */
  message: string;
  params: Record<string, unknown>;
}

/**
 * Cheapest structural offer that matches the dominant risk driver — the
 * intervention is always free to Cellexia (hierarchy rank 0-6), never a
 * discount.
 */
export function pickProactiveIntervention(
  features: ChurnFeatures,
): ProactiveIntervention {
  if (features.inferredExcessDays >= 21) {
    return {
      offerType: "CHANGE_DELIVERY_DATE",
      message:
        "It looks like you are well stocked — shall we move your next delivery back four weeks?",
      params: { delayWeeks: 4 },
    };
  }
  if (features.failedCharges90d > 0) {
    return {
      offerType: "EDUCATION",
      message:
        "A recent payment did not go through. A quick card update keeps your deliveries on track.",
      params: { route: "UPDATE_PAYMENT" },
    };
  }
  if (features.adherenceDiscomfort) {
    return {
      offerType: "PRODUCT_SWAP",
      message:
        "If a product is not agreeing with your skin, we will swap it for a gentler alternative — your plan carries on unchanged.",
      params: { mode: "GENTLER" },
    };
  }
  if (features.skips90d >= 2 || features.delays90d >= 2) {
    return {
      offerType: "CHANGE_FREQUENCY",
      message:
        "A slower rhythm might suit your routine better — would you like more time between deliveries?",
      params: { intervalWeeksDelta: 2 },
    };
  }
  return {
    offerType: "EDUCATION",
    message:
      "How is your treatment going? See what to expect at this stage — and remember you can adjust, delay or cancel online any time.",
    params: { topics: ["EXPECTED_TIMELINE", "CHECK_IN"] },
  };
}

// ─────────────────────────── Scan job ─────────────────────────────────────

/**
 * Merchant-tunable via ShopSettings.settingsJson.churnRiskThreshold
 * (editable in app.retention). Calibrated so the live-signal model flags a
 * genuine production at-risk profile without ratings/tickets/refunds data.
 */
export const DEFAULT_CHURN_THRESHOLD = 0.55;

/** No HIGH_CHURN_RISK re-emit within this window after an accepted intervention. */
export const INTERVENTION_COOLDOWN_DAYS = 28;

/** ScoreSnapshot retention per (contract, kind): newest N are kept. */
export const CHURN_SNAPSHOTS_KEPT = 30;

/** Statuses the scan scores — PAUSED customers must stay visible to retention. */
const SCAN_STATUSES = ["ACTIVE", "PAUSED"] as const;

interface EventRow {
  payloadJson: string;
}

/** Count events whose payload.source is organic (absent or CUSTOMER). */
function countOrganic(rows: EventRow[]): number {
  let count = 0;
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payloadJson, {});
    const source = payload.source;
    if (source == null || source === "CUSTOMER") count++;
  }
  return count;
}

/**
 * Feature assembly notes (every source is real, day-1 data):
 *  - portalVisits30d: PORTAL_VIEW telemetry (portal/auth.server trackPortal).
 *  - delays90d / skips90d: SHIPMENT_DELAYED / ORDER_SKIPPED events whose
 *    payload.source is CUSTOMER (or legacy/absent) — retention-driven
 *    interventions (STAFF / SAVE_OFFER / AUTOPILOT) are excluded so accepting
 *    the suggested delay can never RAISE the churn score.
 *  - failedCharges90d: FAILURE billing attempts.
 *  - inferredExcessDays: depletion estimates — days between the next delivery
 *    and the predicted run-out (positive = surplus building up).
 *  - adherenceDiscomfort: latest answered adherence survey (180 d) reporting
 *    discomfort (treatment/adherence.server semantics).
 *  - addOnActivity90d: PRODUCT_ADDED events — investing in the routine.
 *  - aovTrendPct: latest 2 successful charges vs the 2 before.
 */
export async function runChurnScanJob(
  shop?: string,
): Promise<{ scored: number; flagged: number }> {
  const now = new Date();
  const d30 = addDays(now, -30);
  const d90 = addDays(now, -90);
  const d180 = addDays(now, -180);
  const cooldownCutoff = addDays(now, -INTERVENTION_COOLDOWN_DAYS);
  const weekKey = isoDate(startOfWeek(now));

  const shopRows = shop
    ? [{ shop }]
    : await prisma.subscriptionContract.findMany({
        where: { status: { in: [...SCAN_STATUSES] } },
        distinct: ["shop"],
        select: { shop: true },
      });

  let scored = 0;
  let flagged = 0;

  for (const { shop: shopDomain } of shopRows) {
    // Per-shop counters: the audit row for shop B must not inherit shop A's
    // totals (the cumulative-totals bug made cross-shop audits meaningless).
    let shopScored = 0;
    let shopFlagged = 0;

    const settings = await prisma.shopSettings.findUnique({
      where: { shop: shopDomain },
    });
    const settingsObj = parseJson<Record<string, unknown>>(
      settings?.settingsJson,
      {},
    );
    const rawThreshold = Number(settingsObj.churnRiskThreshold);
    const threshold =
      Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold < 1
        ? rawThreshold
        : DEFAULT_CHURN_THRESHOLD;

    // Learned calibration: null buckets = identity (launch defaults).
    const calibrationState = await getModelState(shopDomain, "CHURN_CALIBRATION");
    const buckets =
      (calibrationState?.params.buckets as CalibrationBucket[] | undefined) ??
      null;
    const modelVersion = calibrationState?.version ?? null;

    const contracts = await prisma.subscriptionContract.findMany({
      where: { shop: shopDomain, status: { in: [...SCAN_STATUSES] } },
      include: { lines: { include: { depletion: true } } },
    });

    for (const contract of contracts) {
      try {
        const [
          delayRows,
          skipRows,
          portalVisits30d,
          failedCharges90d,
          addOnActivity90d,
          latestSurvey,
        ] = await Promise.all([
          prisma.analyticsEvent.findMany({
            where: {
              shop: shopDomain,
              contractId: contract.id,
              name: "SHIPMENT_DELAYED",
              occurredAt: { gte: d90 },
            },
            select: { payloadJson: true },
          }),
          prisma.analyticsEvent.findMany({
            where: {
              shop: shopDomain,
              contractId: contract.id,
              name: "ORDER_SKIPPED",
              occurredAt: { gte: d90 },
            },
            select: { payloadJson: true },
          }),
          prisma.analyticsEvent.count({
            where: {
              shop: shopDomain,
              name: "PORTAL_VIEW",
              occurredAt: { gte: d30 },
              OR: [
                { contractId: contract.id },
                ...(contract.shopifyCustomerId
                  ? [{ shopifyCustomerId: contract.shopifyCustomerId }]
                  : []),
              ],
            },
          }),
          prisma.billingAttempt.count({
            where: {
              contractId: contract.id,
              status: "FAILURE",
              occurredAt: { gte: d90 },
            },
          }),
          prisma.analyticsEvent.count({
            where: {
              shop: shopDomain,
              contractId: contract.id,
              name: "PRODUCT_ADDED",
              occurredAt: { gte: d90 },
            },
          }),
          prisma.adherenceSurvey.findFirst({
            where: {
              shop: shopDomain,
              contractId: contract.id,
              respondedAt: { not: null, gte: d180 },
            },
            orderBy: { respondedAt: "desc" },
            select: { answersJson: true },
          }),
        ]);

        const delays90d = countOrganic(delayRows);
        const skips90d = countOrganic(skipRows);

        const answers = parseJson<Record<string, string>>(
          latestSurvey?.answersJson,
          {},
        );
        const adherenceDiscomfort =
          typeof answers.DISCOMFORT === "string" &&
          discomfortReported(answers.DISCOMFORT);

        // AOV trend: latest two successful charges vs the two before.
        const recentCharges = await prisma.billingAttempt.findMany({
          where: {
            contractId: contract.id,
            status: "SUCCESS",
            amountCents: { not: null },
          },
          orderBy: { occurredAt: "desc" },
          take: 4,
          select: { amountCents: true },
        });
        let aovTrendPct = 0;
        if (recentCharges.length === 4) {
          const latest =
            ((recentCharges[0].amountCents ?? 0) +
              (recentCharges[1].amountCents ?? 0)) /
            2;
          const prior =
            ((recentCharges[2].amountCents ?? 0) +
              (recentCharges[3].amountCents ?? 0)) /
            2;
          if (prior > 0) aovTrendPct = ((latest - prior) / prior) * 100;
        }

        // Excess inventory: surplus days beyond the next delivery.
        const baseline =
          contract.nextDeliveryDate ?? contract.nextBillingDate ?? now;
        let inferredExcessDays = 0;
        for (const line of contract.lines) {
          const runOut = line.depletion?.predictedRunOutAt;
          if (!runOut) continue;
          const surplus = daysBetween(baseline, runOut);
          if (surplus > inferredExcessDays) inferredExcessDays = surplus;
        }

        const features: ChurnFeatures = {
          portalVisits30d,
          delays90d,
          skips90d,
          failedCharges90d,
          inferredExcessDays,
          adherenceDiscomfort,
          addOnActivity90d,
          aovTrendPct,
        };

        const { score: rawScore, factors } = computeChurnRisk(features);
        const score = applyCalibration(rawScore, buckets);

        await prisma.scoreSnapshot.create({
          data: {
            shop: shopDomain,
            contractId: contract.id,
            kind: "CHURN_RISK",
            value: score,
            factorsJson: JSON.stringify({
              ...factors,
              raw: rawScore,
              calibrated: score,
              modelVersion,
            }),
          },
        });
        // Prune: only delete snapshots that are BOTH beyond the newest
        // CHURN_SNAPSHOTS_KEPT AND older than the learning job's calibration
        // pairing window. Pruning by count alone starved CHURN_CALIBRATION:
        // still-subscribed contracts (scanned daily) never kept a snapshot
        // older than ~30 days, so the only rows that ever aged into the
        // 60-180d pairing window belonged to exited contracts — a ~100%
        // churned training sample that calibrated every score near 1 and
        // flagged the entire active base HIGH_CHURN_RISK. Rows stay bounded
        // (~CALIBRATION_SNAPSHOT_MAX_AGE_DAYS per contract); the weekly
        // forecast prune clears anything older than that anyway.
        const staleSnapshots = await prisma.scoreSnapshot.findMany({
          where: {
            contractId: contract.id,
            kind: "CHURN_RISK",
            computedAt: {
              lt: addDays(now, -CALIBRATION_SNAPSHOT_MAX_AGE_DAYS),
            },
          },
          orderBy: { computedAt: "desc" },
          skip: CHURN_SNAPSHOTS_KEPT,
          select: { id: true },
        });
        if (staleSnapshots.length > 0) {
          await prisma.scoreSnapshot.deleteMany({
            where: { id: { in: staleSnapshots.map((s) => s.id) } },
          });
        }

        await prisma.subscriptionContract.update({
          where: { id: contract.id },
          data: { churnRiskScore: score },
        });
        scored++;
        shopScored++;

        if (score >= threshold) {
          // Mid-pause customers are scored (they stay on the radar) but not
          // emailed: the suggested interventions (delay, slower cadence) do
          // not apply while deliveries are stopped. Pause-overdue contracts
          // DO get outreach — they are the highest-risk cohort of all.
          const insidePauseWindow =
            contract.status === "PAUSED" &&
            contract.pausedUntil != null &&
            contract.pausedUntil.getTime() > now.getTime();

          // Intervention-acceptance cooldown: a customer who just accepted a
          // save offer or a retention-driven schedule change is being helped
          // already — re-alerting every week nags them into churn.
          let inCooldown = false;
          if (!insidePauseWindow) {
            const [recentSave, recentInterventionRows] = await Promise.all([
              prisma.cancellationSession.findFirst({
                where: {
                  contractId: contract.id,
                  outcome: "SAVED",
                  resolvedAt: { gte: cooldownCutoff },
                },
                select: { id: true },
              }),
              prisma.analyticsEvent.findMany({
                where: {
                  shop: shopDomain,
                  contractId: contract.id,
                  name: { in: ["SHIPMENT_DELAYED", "ORDER_SKIPPED"] },
                  occurredAt: { gte: cooldownCutoff },
                },
                select: { payloadJson: true },
              }),
            ]);
            const acceptedIntervention = recentInterventionRows.some((row) => {
              const payload = parseJson<Record<string, unknown>>(
                row.payloadJson,
                {},
              );
              return (
                payload.source === "STAFF" ||
                payload.source === "SAVE_OFFER" ||
                payload.source === "AUTOPILOT"
              );
            });
            inCooldown = recentSave != null || acceptedIntervention;
          }

          if (!insidePauseWindow && !inCooldown) {
            const intervention = pickProactiveIntervention(features);
            await emitLifecycleEvent({
              shop: shopDomain,
              name: "HIGH_CHURN_RISK",
              contractId: contract.id,
              shopifyCustomerId: contract.shopifyCustomerId,
              email: contract.customerEmail,
              payload: {
                score,
                rawScore,
                factors,
                suggestedIntervention: intervention,
              },
              // At most one high-risk alert per contract per week.
              dedupeKey: `churn:${contract.id}:${weekKey}`,
            });
            flagged++;
            shopFlagged++;
          }
        }
      } catch (e) {
        logger.error("churn scan failed for contract", {
          contractId: contract.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await appendAudit({
      shop: shopDomain,
      actorType: "SYSTEM",
      action: "CHURN_SCAN",
      payload: {
        scored: shopScored,
        flagged: shopFlagged,
        threshold,
        modelVersion,
        weekKey,
      },
    });
  }

  return { scored, flagged };
}
