/**
 * Auto-resume for paused treatment plans [core].
 *
 * Every pause in the app promises a resume date (portal pauses, cancel-flow
 * saves, CS pauses, dunning grace pauses) — this job is what actually keeps
 * that promise. Without it a "pause until" is a silent cancellation.
 *
 * Three passes per run:
 *  1. Reminders — contracts resuming within `pauseReminderDays` (default 3,
 *     ShopSettings.settingsJson.pauseReminderDays-overridable) get one
 *     PAUSE_ENDING event per (contract, resume date) so Klaviyo can send
 *     "your deliveries resume on {date}". Dunning grace pauses are excluded
 *     (CONFIGURABILITY.md): their cycle is still unpaid, and a cheerful
 *     "deliveries resume" email would directly contradict the FINAL_NOTICE
 *     handoff the resume pass performs.
 *  2. Resumes — contracts whose `pausedUntil` has arrived are resumed via the
 *     core `resumeContract` recipe (SYSTEM actor; audit + PAUSE_ENDED event
 *     happen inside core). Fail-soft per contract: one Shopify error never
 *     blocks the rest of the queue.
 *  3. Orphan detection — PAUSED contracts with NO `pausedUntil` can never be
 *     auto-resumed by pass 2 (a half-committed pauseUntil run, or a pause
 *     made externally in the Shopify admin / native portal). Surface them:
 *     warn-log every run and append one PAUSE_ORPHAN_DETECTED audit row per
 *     contract so CS can see and fix the silent cancellation.
 *
 * Dunning grace pauses are covered too, with a handoff instead of a silent
 * reactivation: `resumeContract` resolves live dunning episodes inline, so
 * for a contract whose pause was a dunning GRACE step this job re-opens the
 * episode as FINAL_NOTICE after the resume — the cycle is still unpaid, the
 * portal banner stays truthful, and the customer gets the promised final
 * notice rather than a serene "welcome back" into a broken card.
 *
 * Registered in the jobs registry as "pause-resume" (hourly).
 */
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { addDays, humanDate, isoDate } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { getOfflineAdmin } from "~/services/core/shopifyClient.server";
import { resumeContract } from "~/services/core/contracts.server";

/** Dunning phases that mark a live grace pause at resume time. */
const GRACE_HANDOFF_PHASES = ["GRACE", "FINAL_NOTICE", "EXHAUSTED"] as const;

/**
 * PURE (exported for unit tests) — is this contract's pause a live dunning
 * grace pause? Used by pass 2 to hand the episode to FINAL_NOTICE instead of
 * silently reactivating, and by pass 1 to SKIP the PAUSE_ENDING reminder —
 * "your deliveries resume on {date}" must never be sent to a customer whose
 * cycle is still unpaid and who is about to receive the final notice.
 */
export function isDunningGracePause(
  state: { graceUntil: Date | null; phase: string } | null | undefined,
): boolean {
  return (
    state != null &&
    state.graceUntil != null &&
    (GRACE_HANDOFF_PHASES as readonly string[]).includes(state.phase)
  );
}

/** Reminder lead: 3 days (CONFIGURABILITY.md), pauseReminderDays-overridable. */
const DEFAULT_REMINDER_DAYS = 3;

async function reminderDaysFor(shop: string): Promise<number> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const parsed = parseJson<Record<string, unknown>>(
    settings?.settingsJson ?? "{}",
    {},
  );
  const raw = parsed.pauseReminderDays;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && raw <= 30
    ? Math.round(raw)
    : DEFAULT_REMINDER_DAYS;
}

export interface PauseResumeSummary {
  shop: string;
  remindersSent: number;
  resumed: number;
  failed: number;
  /** PAUSED contracts with no pausedUntil — nothing will ever resume them. */
  orphans: number;
}

export async function runPauseResumeJob(
  shop?: string,
): Promise<PauseResumeSummary[]> {
  // Any PAUSED contract (pausedUntil or not): orphan-only shops must still
  // be visited by pass 3.
  const shops = shop
    ? [shop]
    : (
        await prisma.subscriptionContract.findMany({
          where: { status: "PAUSED" },
          select: { shop: true },
          distinct: ["shop"],
        })
      ).map((row) => row.shop);

  const summaries: PauseResumeSummary[] = [];
  const now = new Date();

  for (const currentShop of shops) {
    const summary: PauseResumeSummary = {
      shop: currentShop,
      remindersSent: 0,
      resumed: 0,
      failed: 0,
      orphans: 0,
    };

    const paused = await prisma.subscriptionContract.findMany({
      where: {
        shop: currentShop,
        status: "PAUSED",
        pausedUntil: { not: null },
      },
    });

    const reminderDays = await reminderDaysFor(currentShop);
    const reminderHorizon = addDays(now, reminderDays);

    for (const contract of paused) {
      const resumeAt = contract.pausedUntil as Date;

      // Pass 1 — reminder before resumption. The dedupeKey pins one send per
      // (contract, resume date): rescheduling the pause re-arms the reminder.
      if (resumeAt > now && resumeAt <= reminderHorizon) {
        // Dunning grace pauses are excluded (same predicate as the pass-2
        // handoff): the cycle is unpaid, so "your deliveries resume on
        // {date}" would be followed on resume day by the final-notice email
        // for the same contract — contradictory messaging on the
        // highest-friction cohort.
        const dunning = await prisma.dunningState.findUnique({
          where: { contractId: contract.id },
        });
        if (isDunningGracePause(dunning)) {
          continue;
        }
        await emitLifecycleEvent({
          shop: currentShop,
          name: "PAUSE_ENDING",
          contractId: contract.id,
          shopifyCustomerId: contract.shopifyCustomerId,
          email: contract.customerEmail,
          payload: {
            resumeDate: isoDate(resumeAt),
            resumeDateHuman: humanDate(resumeAt),
          },
          dedupeKey: `pause-ending:${contract.id}:${isoDate(resumeAt)}`,
        });
        summary.remindersSent += 1;
        continue;
      }

      // Pass 2 — the resume date has arrived.
      if (resumeAt <= now) {
        try {
          // Capture whether this pause belongs to a dunning grace episode
          // BEFORE resuming (resumeContract wipes live episodes to RESOLVED).
          const dunningBefore = await prisma.dunningState.findUnique({
            where: { contractId: contract.id },
          });
          const gracePause = isDunningGracePause(dunningBefore);

          const { graphql } = await getOfflineAdmin(currentShop);
          await resumeContract(graphql, currentShop, contract.id);
          summary.resumed += 1;

          if (gracePause && dunningBefore) {
            // Hand the episode to FINAL_NOTICE — never silently ACTIVE. The
            // cycle is still unpaid: the next billing outcome either resolves
            // the episode (success) or opens a fresh one (failure).
            const history = parseJson<
              Array<{ at: string; type: string; note?: string }>
            >(dunningBefore.historyJson, []);
            history.push({
              at: now.toISOString(),
              type: "STEP",
              note: "GRACE_PAUSE_RESUMED_FINAL_NOTICE",
            });
            await prisma.dunningState.update({
              where: { contractId: contract.id },
              data: {
                phase: "FINAL_NOTICE",
                graceUntil: null,
                nextRetryAt: null,
                historyJson: JSON.stringify(history),
              },
            });
            await emitLifecycleEvent({
              shop: currentShop,
              name: "CHARGE_FAILED",
              contractId: contract.id,
              shopifyCustomerId: contract.shopifyCustomerId,
              email: contract.customerEmail,
              payload: {
                template: "dunning-grace-final-notice",
                declineCategory: dunningBefore.declineCategory,
                followUp: true,
                resumedFromGracePause: true,
              },
              dedupeKey: `dunning-final-notice:${contract.id}:${isoDate(resumeAt)}`,
            });
            await appendAudit({
              shop: currentShop,
              actorType: "SYSTEM",
              action: "DUNNING_GRACE_RESUMED",
              subjectType: "SubscriptionContract",
              subjectId: contract.id,
              payload: {
                resumeDate: isoDate(resumeAt),
                phase: "FINAL_NOTICE",
                declineCategory: dunningBefore.declineCategory,
              },
            });
          }
        } catch (error) {
          summary.failed += 1;
          logger.warn("pause-resume failed for contract", {
            shop: currentShop,
            contractId: contract.id,
            error: String(error),
          });
        }
      }
    }

    // Pass 3 — orphan detection. A PAUSED contract with no pausedUntil is
    // invisible to passes 1–2 forever: nothing resumes it, no reminder fires
    // (the module docstring calls this "a silent cancellation"). Sources: a
    // pauseUntil run that died between the Shopify pause and the pausedUntil
    // stamp (now self-healing on retry, but a never-retried one still
    // lingers), and pauses made externally (Shopify admin, native portal).
    // Warn every run; audit once per contract so CS has a durable flag
    // without the hourly job spamming the chain.
    const orphaned = await prisma.subscriptionContract.findMany({
      where: { shop: currentShop, status: "PAUSED", pausedUntil: null },
      select: { id: true, shopifyContractId: true, customerEmail: true },
    });
    summary.orphans = orphaned.length;
    for (const contract of orphaned) {
      logger.warn("paused contract has no resume date — will never auto-resume", {
        shop: currentShop,
        contractId: contract.id,
        shopifyContractId: contract.shopifyContractId,
      });
      const alreadyFlagged = await prisma.auditLog.findFirst({
        where: {
          shop: currentShop,
          action: "PAUSE_ORPHAN_DETECTED",
          subjectType: "SubscriptionContract",
          subjectId: contract.id,
        },
        select: { id: true },
      });
      if (!alreadyFlagged) {
        await appendAudit({
          shop: currentShop,
          actorType: "SYSTEM",
          action: "PAUSE_ORPHAN_DETECTED",
          subjectType: "SubscriptionContract",
          subjectId: contract.id,
          payload: {
            shopifyContractId: contract.shopifyContractId,
            note: "PAUSED with pausedUntil null — resume or set a pause end date",
          },
        });
      }
    }

    logger.info("pause-resume job run", { ...summary });
    summaries.push(summary);
  }

  return summaries;
}
