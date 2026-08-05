/**
 * Milestones & anniversaries — benefits that accumulate, never countdowns.
 *
 * runMilestoneJob detects earned milestones per ACTIVE contract, records them
 * (unique contractId+type), grants the configured reward and emits
 * TREATMENT_MILESTONE with payload.kind = "MILESTONE".
 *
 * Rewards come from ShopSettings.settingsJson.milestoneRewards, merged over
 * DEFAULT_MILESTONE_REWARDS below.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { addDays, daysBetween } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { parseJson } from "~/types/domain";
import type { MilestoneType } from "~/types/domain";

export interface MilestoneReward {
  /** Machine key for templates, e.g. "FREE_DELIVERY". */
  type: string;
  title: string;
  description: string;
}

/**
 * Default rewards, in Continuous Treatment voice. All are accumulating
 * benefits (free delivery, price protection, early access, replacement
 * cover) — no urgency, no countdowns.
 */
export const DEFAULT_MILESTONE_REWARDS: Record<MilestoneType, MilestoneReward> = {
  TREATMENT_STARTED: {
    type: "WELCOME",
    title: "Your treatment plan has begun",
    description:
      "Welcome to your continuous treatment. Your routine builds from here — and you can adjust, delay or cancel online whenever you need.",
  },
  FIRST_MONTH: {
    type: "FREE_DELIVERY",
    title: "One month in — your next delivery ships free",
    description:
      "A month of consistent care deserves a thank-you: delivery on your next order is on us.",
  },
  NINETY_DAYS: {
    type: "PRICE_PROTECTION",
    title: "90 days of care — your price is now protected",
    description:
      "Your treatment plan price is locked in for as long as your plan stays active, whatever happens to list prices.",
  },
  SIX_DELIVERIES: {
    type: "EARLY_ACCESS",
    title: "Six deliveries — early access unlocked",
    description:
      "You now get first access to new Cellexia formulas and limited editions, before they open to everyone else.",
  },
  ONE_YEAR: {
    type: "FREE_REPLACEMENT",
    title: "A full year of continuous treatment",
    description:
      "From now on, any delivery that arrives damaged or goes missing is replaced free — no questions asked.",
  },
};

/**
 * Pure: which milestones a contract has earned.
 * - TREATMENT_STARTED: first successful charge
 * - FIRST_MONTH: 30 days since treatment start
 * - NINETY_DAYS: 90 days
 * - SIX_DELIVERIES: successfulOrders >= 6
 * - ONE_YEAR: 365 days
 */
export function earnedMilestones(input: {
  successfulOrders: number;
  treatmentStartedAt: Date | null;
  now?: Date;
}): MilestoneType[] {
  const now = input.now ?? new Date();
  const earned: MilestoneType[] = [];
  const started = input.successfulOrders >= 1;
  if (started) earned.push("TREATMENT_STARTED");
  const activeDays = input.treatmentStartedAt
    ? daysBetween(input.treatmentStartedAt, now)
    : 0;
  if (started && activeDays >= 30) earned.push("FIRST_MONTH");
  if (started && activeDays >= 90) earned.push("NINETY_DAYS");
  if (input.successfulOrders >= 6) earned.push("SIX_DELIVERIES");
  if (started && activeDays >= 365) earned.push("ONE_YEAR");
  return earned;
}

async function rewardsForShop(
  shop: string,
  cache: Map<string, Record<MilestoneType, MilestoneReward>>,
): Promise<Record<MilestoneType, MilestoneReward>> {
  const cached = cache.get(shop);
  if (cached) return cached;
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const settingsJson = parseJson<Record<string, unknown>>(settings?.settingsJson, {});
  const overrides =
    (settingsJson.milestoneRewards as Partial<Record<MilestoneType, MilestoneReward>>) ??
    {};
  const merged = { ...DEFAULT_MILESTONE_REWARDS, ...overrides };
  cache.set(shop, merged);
  return merged;
}

/**
 * Detect and record new milestones for every ACTIVE contract, emitting
 * TREATMENT_MILESTONE (payload.kind = "MILESTONE") with the reward payload.
 */
export async function runMilestoneJob(shop?: string): Promise<{ granted: number }> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: { status: "ACTIVE", ...(shop ? { shop } : {}) },
    include: { milestones: { select: { type: true } } },
  });

  const rewardsCache = new Map<string, Record<MilestoneType, MilestoneReward>>();
  let granted = 0;
  const now = new Date();

  for (const contract of contracts) {
    const startedAt =
      contract.treatmentStartedAt ??
      (contract.successfulOrders > 0 ? contract.createdAt : null);
    const earned = earnedMilestones({
      successfulOrders: contract.successfulOrders,
      treatmentStartedAt: startedAt,
      now,
    });
    const already = new Set(contract.milestones.map((m) => m.type));
    const missing = earned.filter((type) => !already.has(type));
    if (missing.length === 0) continue;

    const rewards = await rewardsForShop(contract.shop, rewardsCache);

    for (const type of missing) {
      const reward = rewards[type] ?? DEFAULT_MILESTONE_REWARDS[type];
      let milestone;
      try {
        milestone = await prisma.milestone.create({
          data: {
            contractId: contract.id,
            type,
            rewardStatus: "GRANTED",
            rewardJson: JSON.stringify(reward),
          },
        });
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        if (code === "P2002") continue; // already recorded by a concurrent run
        throw e;
      }

      await emitLifecycleEvent({
        shop: contract.shop,
        name: "TREATMENT_MILESTONE",
        contractId: contract.id,
        shopifyCustomerId: contract.shopifyCustomerId,
        email: contract.customerEmail,
        payload: {
          kind: "MILESTONE", // adherence check-ins reuse this event name with kind ADHERENCE_CHECK_IN
          milestone: type,
          reward,
        },
        dedupeKey: `milestone:${contract.id}:${type}`,
      });

      await prisma.milestone.update({
        where: { id: milestone.id },
        data: { rewardStatus: "NOTIFIED" },
      });

      await appendAudit({
        shop: contract.shop,
        actorType: "SYSTEM",
        action: "MILESTONE_GRANTED",
        subjectType: "Milestone",
        subjectId: milestone.id,
        payload: { contractId: contract.id, type, reward: { ...reward } },
      });
      granted += 1;
    }
  }

  logger.info("milestone job complete", { shop: shop ?? "all", granted });
  return { granted };
}

/** Days after the anniversary date during which the yearly event may fire. */
const ANNIVERSARY_WINDOW_DAYS = 6;

/**
 * Emit SUBSCRIBER_ANNIVERSARY once per completed treatment year, within a
 * short window after the anniversary date (job runs daily; a 30-day
 * AnalyticsEvent guard prevents duplicates inside the window).
 */
export async function runAnniversariesJob(shop?: string): Promise<{ emitted: number }> {
  const now = new Date();
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      status: "ACTIVE",
      treatmentStartedAt: { not: null, lte: addDays(now, -365) },
      ...(shop ? { shop } : {}),
    },
  });

  let emitted = 0;
  for (const contract of contracts) {
    const started = contract.treatmentStartedAt;
    if (!started) continue;
    const years = Math.floor(daysBetween(started, now) / 365);
    if (years < 1) continue;
    const anniversaryAt = addDays(started, years * 365);
    const sinceAnniversary = daysBetween(anniversaryAt, now);
    if (sinceAnniversary < 0 || sinceAnniversary > ANNIVERSARY_WINDOW_DAYS) continue;

    const recent = await prisma.analyticsEvent.findFirst({
      where: {
        shop: contract.shop,
        name: "SUBSCRIBER_ANNIVERSARY",
        contractId: contract.id,
        occurredAt: { gte: addDays(now, -30) },
      },
      select: { id: true },
    });
    if (recent) continue;

    await emitLifecycleEvent({
      shop: contract.shop,
      name: "SUBSCRIBER_ANNIVERSARY",
      contractId: contract.id,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: {
        years,
        treatmentStartedAt: started.toISOString(),
        note: `${years} ${years === 1 ? "year" : "years"} of continuous treatment.`,
      },
      dedupeKey: `anniversary:${contract.id}:${years}`,
    });
    emitted += 1;
  }

  logger.info("anniversaries job complete", { shop: shop ?? "all", emitted });
  return { emitted };
}
