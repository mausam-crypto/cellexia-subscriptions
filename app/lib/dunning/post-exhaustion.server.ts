import type { ContractLine, DunningCase, Shop, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { formatShopDate } from "~/lib/dates.server";
import { formatMoney } from "~/lib/money";
import {
  buildMagicUrl,
  buildSkipFailedCycleUrl,
} from "~/lib/magiclinks/builder.server";
import { sendNotification } from "~/lib/notifications/index.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import { t } from "~/lib/i18n/i18n.server";
import { categorizeDeclineCode } from "./decline-codes.server";
import { estimateHeldAmountCents } from "./held-amount.server";
import { cardHardDeadReason, previewSkipResumeDate } from "./skip-resume.server";

/**
 * Post-exhaustion touches (v1.28.0, P1.9).
 *
 * Until now `exhaustCase` sent nothing and the win-back engine only speaks
 * to CANCELLED contracts, so a FAILED (dunning-exhausted) subscription went
 * silent forever — the "parked cohort". This sweep phase (rides inside
 * dunning_run, SETUP-gated with it) sends `payment_failed_parked` at each
 * offset of settings.dunning.postExhaustionTouchDays (days after the case
 * was exhausted) while:
 *
 *  - the contract is still FAILED (reactivated / cancelled ⇒ stop) and has
 *    no scheduled cancel (a scheduled cancel is a decision — the intent
 *    follow-up reads it the same way — so no "ways to continue" touch),
 *  - the exhausted case is the contract's NEWEST case with resolution
 *    EXHAUSTED (a customer skip-and-continue marks it CUSTOMER_SKIPPED; a
 *    reopened case is no longer EXHAUSTED; a newer case owns the story),
 *  - the decline is one the customer can act on (manual-review declines —
 *    HARD + customerAction NONE — are never nagged, like the ladder),
 *  - the offset's window is current: offset i is due while days[i] ≤
 *    daysSinceExhaustion < days[i+1] (the last one stays due) — a sweep
 *    outage never replays a missed earlier touch on top of the current one.
 *
 * Deduped in NotificationLog on `parked:{caseId}:{offsetIndex}` (SENT or
 * SUPPRESSED — a disabled channel / template must not be re-tried every 10
 * minutes). The email's "ways to continue" block is composed here (vars
 * `ways_intro` / `ways_more`, the `{cta}` update-card button between them):
 * a card that can still be charged gets the three exits — update card, retry
 * with the same card (RETRY_PAYMENT one-tap), skip-and-continue from the
 * resume date (SKIP_FAILED_CYCLE one-tap; "your next scheduled order" when
 * no date can be derived); a HARD-DEAD card (removed / expired / none —
 * `cardHardDeadReason`, the same gate the portal banner and the skip verb
 * apply) gets the honest single exit: update the card, we retry
 * automatically once a working one is on file — no retry / skip links are
 * minted at all, so a one-tap never lands on a refusal. Klaviyo metric "Cellexia Payment Parked" (its own — the ladder flow must
 * not re-fire on a parked contract). Every send logs dunning.parked_touch
 * {offset}. Per-case fault-isolated; never throws.
 */

const TEMPLATE = "payment_failed_parked" as const;
/** Link validity beyond the last configured offset (same convention as the engine's UPDATE_CARD grace). */
const LINK_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface PostExhaustionStats {
  /** Exhausted-and-still-FAILED cases inspected. */
  processed: number;
  sent: number;
  suppressed: number;
  skipped: number;
}

type CaseWithContract = DunningCase & {
  contract: SubscriptionContract & { shop: Shop; lines: ContractLine[] };
};

/**
 * Pure: the offset index due for a case exhausted `daysSince` days ago, or
 * null when none is (before the first offset, or no offsets configured).
 * "Due" = the current window: the largest i with days[i] ≤ daysSince.
 */
export function dueOffsetIndex(
  offsetsDays: readonly number[],
  daysSince: number,
): number | null {
  let due: number | null = null;
  for (let i = 0; i < offsetsDays.length; i += 1) {
    if (daysSince >= offsetsDays[i]) due = i;
  }
  return due;
}

export function parkedDedupeKey(caseId: string, offsetIndex: number): string {
  return `parked:${caseId}:${offsetIndex}`;
}

/**
 * The parked order's amount: THE next-order estimate (grant / parked marker /
 * per-line edits — the figure the portal banner and items card print), the
 * case's frozen at-risk figure only when the estimate has nothing to say.
 */
async function estimateAmountCents(
  kase: DunningCase,
  contract: CaseWithContract["contract"],
): Promise<number | null> {
  const est = await estimateHeldAmountCents(
    { id: contract.shop.id, ianaTimezone: contract.shop.ianaTimezone },
    contract,
  );
  return est ?? kase.amountAtRiskCents ?? null;
}

export async function runPostExhaustionTouches(
  now: Date = new Date(),
): Promise<PostExhaustionStats> {
  const stats: PostExhaustionStats = { processed: 0, sent: 0, suppressed: 0, skipped: 0 };
  const settingsCache = new Map<string, { offsets: number[] }>();
  const offsetsFor = async (shopId: string): Promise<number[]> => {
    const cached = settingsCache.get(shopId);
    if (cached) return cached.offsets;
    const dunning = (await getSetting(shopId, "dunning")) as {
      postExhaustionTouchDays?: unknown;
    };
    const raw = dunning.postExhaustionTouchDays;
    const offsets = Array.isArray(raw)
      ? raw.filter((d): d is number => Number.isInteger(d) && d >= 1)
      : [];
    settingsCache.set(shopId, { offsets });
    return offsets;
  };

  let cases: CaseWithContract[];
  try {
    cases = (await prisma.dunningCase.findMany({
      where: {
        state: "EXHAUSTED",
        resolution: "EXHAUSTED",
        // A scheduled cancel is a decision (same reading as the intent
        // follow-up and the ladder's past-date gate): "ways to continue"
        // must not chase a customer who already asked to end it.
        contract: {
          status: "FAILED",
          isDemo: false,
          cancelScheduledAt: null,
          ...OURS_ONLY,
        },
      },
      include: { contract: { include: { shop: true, lines: true } } },
      orderBy: { resolvedAt: "asc" },
    })) as unknown as CaseWithContract[];
  } catch (err) {
    console.error("[dunning] post-exhaustion: case query failed", err);
    return stats;
  }

  for (const kase of cases) {
    try {
      const contract = kase.contract;
      // Defensive re-checks (the where clause is the truth in production;
      // a mocked or lagging read must never mail a live or foreign contract).
      if (
        kase.state !== "EXHAUSTED" ||
        kase.resolution !== "EXHAUSTED" ||
        !contract ||
        contract.status !== "FAILED" ||
        contract.isDemo ||
        contract.cancelScheduledAt != null ||
        !isBillableOwnership(contract.ownership)
      ) {
        continue;
      }
      stats.processed += 1;

      const offsets = await offsetsFor(contract.shopId);
      if (offsets.length === 0) {
        stats.skipped += 1;
        continue;
      }
      const exhaustedAt = kase.resolvedAt ?? kase.openedAt;
      const daysSince = Math.floor((now.getTime() - exhaustedAt.getTime()) / DAY_MS);
      const offsetIndex = dueOffsetIndex(offsets, daysSince);
      if (offsetIndex == null) {
        stats.skipped += 1;
        continue;
      }

      // Newest case owns the story: a newer one (any state) means the
      // contract's payment trouble moved on since this exhaustion.
      const newer = await prisma.dunningCase.findFirst({
        where: { contractId: contract.id, openedAt: { gt: kase.openedAt } },
        select: { id: true },
      });
      if (newer) {
        stats.skipped += 1;
        continue;
      }

      const info = categorizeDeclineCode(kase.declineCode);
      if (kase.declineCategory === "HARD" && info.customerAction === "NONE") {
        stats.skipped += 1;
        continue; // manual-review declines: never nag the customer
      }

      const dedupeKey = parkedDedupeKey(kase.id, offsetIndex);
      const already = await prisma.notificationLog.findFirst({
        where: {
          contractId: contract.id,
          template: TEMPLATE,
          status: { in: ["SENT", "SUPPRESSED"] },
          payload: { path: ["vars", "dunning_dedupe"], equals: dedupeKey },
        },
        select: { id: true },
      });
      if (already) {
        stats.skipped += 1;
        continue;
      }

      const ttlDays = (offsets[offsets.length - 1] ?? 0) + LINK_GRACE_DAYS;
      const linkBase = {
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        createdVia: "DUNNING_PARKED",
      };
      const tz = contract.shop.ianaTimezone;
      const locale = contract.locale ?? "en";
      // Hard-dead card (removed / expired / none): the retry and skip exits
      // are dead ends (skipFailedCycleAndResume refuses them, a retry only
      // re-declines) — do not mint them, do not promise them.
      const dead = cardHardDeadReason(contract, now, tz);
      const ctaUrl = await buildMagicUrl({
        ...linkBase,
        action: "UPDATE_CARD",
        ttlSeconds: ttlDays * DAY_MS / 1000,
        maxUses: 5,
      });
      let skipResumeUrl = "";
      let resumeDateLabel = "";
      let waysIntro: string;
      let waysMore: string;
      if (dead) {
        const reasonKey =
          dead === "card_expired"
            ? "email.payment_failed_parked.card_dead_expired"
            : dead === "card_revoked"
              ? "email.payment_failed_parked.card_dead_removed"
              : "email.payment_failed_parked.card_dead_missing";
        waysIntro = t(locale, "email.payment_failed_parked.ways_intro_card_dead", {
          card_dead_reason: t(locale, reasonKey),
        });
        waysMore = t(locale, "email.payment_failed_parked.ways_more_card_dead");
      } else {
        const [retryUrl, skipUrl, resumeDate] = await Promise.all([
          buildMagicUrl({
            ...linkBase,
            action: "RETRY_PAYMENT",
            ttlSeconds: ttlDays * DAY_MS / 1000,
            maxUses: 5,
          }),
          buildSkipFailedCycleUrl({ ...linkBase, ttlDays }),
          previewSkipResumeDate(contract, tz, now),
        ]);
        skipResumeUrl = skipUrl;
        resumeDateLabel = resumeDate
          ? formatShopDate(resumeDate, tz, locale)
          : "";
        waysIntro = t(locale, "email.payment_failed_parked.ways_intro_live");
        waysMore = t(locale, "email.payment_failed_parked.ways_more_live", {
          retry_payment_url: retryUrl,
          skip_resume_url: skipUrl,
          resume_date:
            resumeDateLabel ||
            t(locale, "email.payment_failed_parked.resume_date_fallback"),
        });
      }

      const amountCents = await estimateAmountCents(kase, contract);
      const currency = contract.currencyCode;
      const vars: Record<string, unknown> = {
        amount: amountCents != null ? formatMoney(amountCents, currency, contract.locale) : "",
        decline_human: info.description,
        days_since_failure: Math.max(
          0,
          Math.floor((now.getTime() - kase.openedAt.getTime()) / DAY_MS),
        ),
        days_since_hold: daysSince,
        card_last4: contract.cardLast4 ?? "",
        card_dead_reason: dead ?? "",
        cta_url: ctaUrl,
        ways_intro: waysIntro,
        ways_more: waysMore,
        skip_resume_url: skipResumeUrl,
        resume_date: resumeDateLabel,
        touch_offset_days: offsets[offsetIndex],
        dunning_dedupe: dedupeKey,
      };

      const result = await sendNotification({
        shopId: contract.shopId,
        contractId: contract.id,
        template: TEMPLATE,
        vars,
      });
      if (result.status === "SENT") stats.sent += 1;
      else if (result.status === "SUPPRESSED") stats.suppressed += 1;
      else stats.skipped += 1;

      if (result.status === "SENT") {
        await logEvent({
          shopId: contract.shopId,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "dunning.parked_touch",
          source: "SCHEDULER",
          actor: "system",
          payload: {
            dunningCaseId: kase.id,
            offsetIndex,
            offsetDays: offsets[offsetIndex],
            daysSinceExhaustion: daysSince,
            declineCode: kase.declineCode,
            declineCategory: kase.declineCategory,
            // Which "ways" block went out: null = the three exits, else the
            // hard-dead single exit (no retry / skip links minted).
            cardDead: dead,
          },
        });
      }
    } catch (err) {
      console.error("[dunning] post-exhaustion touch failed", kase.id, err);
    }
  }
  return stats;
}
