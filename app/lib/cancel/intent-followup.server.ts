import type { CancelSession, ContractLine, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";
import { t } from "~/lib/i18n/i18n.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { sendNotification } from "~/lib/notifications/index.server";
import {
  buildMagicUrl,
  buildPortalUrl,
  buildSetFrequencyUrl,
} from "~/lib/magiclinks/builder.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import { chargeMomentUtcSync, resolveChargeTiming } from "~/lib/billing/timing.server";
import { contractFrequency, formatFrequency, type Frequency } from "~/lib/frequency";
import { nextSlowerFrequency } from "~/lib/portal/growth.server";
import { frequencyOptionsForContract } from "~/lib/portal/catalog.server";
import { getSupportChannels } from "~/lib/support/channels.server";
import { cancelPublicPath } from "~/lib/cancel/config.server";

/**
 * Abandoned cancel-intent follow-up (v1.28.0, P3.6).
 *
 * The highest-intent cohort the app sees is the customer who opened the
 * cancel flow and walked away undecided: `cancel_session_gc` closes their
 * CancelSession as ABANDONED (terminal `cancel.aborted`) and, before this
 * release, nothing else happened. This module turns that moment into ONE
 * reason-matched follow-up:
 *
 *  - the hourly `cancel_intent_followup_run` job (registered beside the GC in
 *    jobs/runner.server.ts, SETUP-gated) scans ABANDONED sessions whose
 *    `completedAt` is at least `cancelFlow.intentFollowupHours` (default 18)
 *    old and at most INTENT_MAX_AGE_HOURS old — the window keeps a runner
 *    outage from blasting stale intent weeks later;
 *  - a session counts only while it is the contract's LATEST session — a
 *    later SAVED / CANCELLED session (or an open one) means the customer
 *    already decided; a scheduled cancel (`cancelScheduledAt`) is a decision
 *    too; the contract must still be ACTIVE or PAUSED, OURS and not demo;
 *  - timing rule: never inside `cancelFlow.intentFollowupChargeBufferHours`
 *    (default 48) before the next charge moment (Stage B `chargeMomentUtcSync`
 *    on nextBillingDate, or the resume day for a PAUSED contract) — an email
 *    landing hours before a charge reads as pressure, and the one-tap edits it
 *    carries would collide with the preparing window;
 *  - cooldown: at most one follow-up per CUSTOMER (email, across contracts —
 *    the same per-person scoping as the cancel-flow cooldowns) per
 *    `cancelFlow.intentFollowupCooldownDays` (default 30); and never twice for
 *    the same session (any NotificationLog row for the template on the
 *    contract since the session closed = already handled, whatever the
 *    outcome);
 *  - content: the saves that match the reason the customer gave, re-derived
 *    server-side at send time (a SKIP/DELAY only for an ACTIVE, unlocked
 *    contract with a next date; a slower cadence only when the plan offers
 *    one — the NEW SET_FREQUENCY verb, minted with the exact option; a
 *    smaller order via the portal only when a recurring line has quantity ≥ 2;
 *    a pause only when the contract is ACTIVE), the Stage C support channels
 *    ("talk to us"), and a plain link to the cancel page — cancelling stays
 *    one tap away, no forced offer (FTC/EU honesty).
 *
 * The same reason → actions mapping (`intentActionsFor`) and the same
 * detection rule (`findAbandonedIntent`) power the 14-day portal home banner
 * (intent-banner.server.ts), so email and portal never disagree about what
 * the customer is offered.
 *
 * Every contract is contained: a failure to build one email never stops the
 * sweep, and nothing here touches billing.
 */

/** Sessions older than this (since completedAt) are never followed up. */
export const INTENT_MAX_AGE_HOURS = 72;

/** Reason-matched follow-up actions, best-fit first. TALK is always offered
 * separately (support line / button) and DOWNSIZE is never one-tap. */
export type IntentAction = "SKIP" | "DELAY" | "SLOWER" | "DOWNSIZE" | "PAUSE";

const ACTIONS_BY_REASON: Record<string, IntentAction[]> = {
  TOO_MUCH_PRODUCT: ["SKIP", "DELAY", "SLOWER", "DOWNSIZE"],
  TOO_EXPENSIVE: ["DOWNSIZE", "SLOWER", "PAUSE"],
  NOT_SEEING_RESULTS: ["PAUSE", "DELAY"],
  TRYING_SOMETHING_ELSE: ["PAUSE", "DELAY"],
  SHIPPING_ISSUES: ["DELAY", "SLOWER"],
  OTHER: ["PAUSE", "SKIP"],
};

/** Pure: the ordered candidate actions for a cancel reason (null = no reason
 * given — the intro step). Pinned in tests/cancel-intent-followup.test.ts. */
export function intentActionsFor(reason: string | null | undefined): IntentAction[] {
  return [...(ACTIONS_BY_REASON[reason ?? "OTHER"] ?? ACTIONS_BY_REASON.OTHER)];
}

/** Which flow step the customer walked away from — the Klaviyo `step` prop. */
export function intentStepFor(session: {
  reason: string | null;
  savesShown: unknown;
}): "intro" | "reason" | "saves" {
  if (!session.reason) return "intro";
  return Array.isArray(session.savesShown) && session.savesShown.length > 0
    ? "saves"
    : "reason";
}

export interface AbandonedIntent {
  sessionId: string;
  reason: string | null;
  step: "intro" | "reason" | "saves";
  completedAt: Date;
}

/**
 * The contract's walked-away intent, if it is still live: the LATEST session
 * is ABANDONED and closed within `maxAgeMs`. Any later SAVED / CANCELLED /
 * open session means the customer decided — null. Reads only.
 */
export async function findAbandonedIntent(
  contractId: string,
  opts: { now: Date; maxAgeMs: number },
): Promise<AbandonedIntent | null> {
  const latest = await prisma.cancelSession.findFirst({
    where: { contractId },
    orderBy: { startedAt: "desc" },
    select: { id: true, reason: true, savesShown: true, outcome: true, completedAt: true },
  });
  if (!latest || latest.outcome !== "ABANDONED" || !latest.completedAt) return null;
  if (opts.now.getTime() - latest.completedAt.getTime() > opts.maxAgeMs) return null;
  return {
    sessionId: latest.id,
    reason: latest.reason,
    step: intentStepFor(latest),
    completedAt: latest.completedAt,
  };
}

// ── Applicability (server-derived truth) ─────────────────────────────────────

type ContractWithLines = SubscriptionContract & { lines: ContractLine[] };

export interface IntentApplicability {
  skip: boolean;
  delay: boolean;
  /** The exact slower cadence to offer, or null. */
  slower: Frequency | null;
  downsize: boolean;
  pause: boolean;
}

/**
 * Which reason-matched actions are TRUE for this contract right now. Pure
 * given its inputs; the async wrapper below loads lock + plan options.
 * Pinned in tests/cancel-intent-followup.test.ts.
 */
/**
 * The same rule as `hasPendingCycleEdits` (contracts/service.server.ts —
 * kept local so this pure helper stays free of the service module): mirror
 * lines witnessing a committed cycle edit Shopify's contract-level draft
 * would refuse.
 */
function linesHavePendingCycleEdits(lines: ReadonlyArray<ContractLine>): boolean {
  return lines.some(
    (l) =>
      l.skippedCycleIndex != null ||
      l.cycleQuantityOverrideIndex != null ||
      (l.isOneTimeAddon && l.addonCycleIndex != null) ||
      (l.isGift && !l.shopifyLineId),
  );
}

export function intentApplicabilitySync(
  contract: ContractWithLines,
  input: {
    locked: boolean;
    preparing: boolean;
    frequencyOptions: Frequency[];
    allowFrequencyChoice: boolean;
    downsizeEnabled: boolean;
  },
): IntentApplicability {
  const active = contract.status === "ACTIVE";
  const editable = active && !input.locked && !input.preparing && !!contract.nextBillingDate;
  // One truth with the portal dispatcher (ACTIVE_ONLY has "frequency") and
  // the SET_FREQUENCY verb: a cadence change needs an ACTIVE contract — a
  // PAUSED one is offered nothing one-tap (the banner keeps "talk to us").
  // Staged one-off changes on the next order (a per-line skip / one-time
  // quantity / added extra / staged gift) make Shopify refuse a
  // contract-level draft (ContractEditBlockedError) — never mint a
  // SET_FREQUENCY one-tap that would be dead on arrival.
  const slower =
    active &&
    !input.locked &&
    input.allowFrequencyChoice &&
    !linesHavePendingCycleEdits(contract.lines)
      ? nextSlowerFrequency(input.frequencyOptions, contractFrequency(contract))
      : null;
  const downsize =
    input.downsizeEnabled &&
    active &&
    contract.lines.some((l) => !l.isGift && !l.isOneTimeAddon && l.quantity >= 2);
  // Pause is a schedule reduction the lock refuses (LOCKED_MAGIC_ACTIONS /
  // the portal LOCK_BLOCKED set): never offer it inside the window.
  return { skip: editable, delay: editable, slower, downsize, pause: active && !input.locked };
}

export async function intentApplicability(
  shopId: string,
  tz: string,
  contract: ContractWithLines,
  opts: { preparing: boolean; downsizeEnabled: boolean; now?: Date },
): Promise<IntentApplicability> {
  let locked = false;
  try {
    locked = (await resolveLockState(shopId, contract, tz, opts.now)).locked;
  } catch (err) {
    console.error("[cancel-intent] lock read failed", contract.id, err);
    locked = true; // fail closed: never offer a reduction the lock refuses
  }
  let frequencyOptions: Frequency[] = [];
  let allowFrequencyChoice = false;
  try {
    const f = await frequencyOptionsForContract(shopId, contract);
    frequencyOptions = f.options;
    allowFrequencyChoice = f.allowChoice;
  } catch (err) {
    console.error("[cancel-intent] frequency options failed", contract.id, err);
  }
  return intentApplicabilitySync(contract, {
    locked,
    preparing: opts.preparing,
    frequencyOptions,
    allowFrequencyChoice,
    downsizeEnabled: opts.downsizeEnabled,
  });
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface IntentFollowupStats {
  scanned: number;
  sent: number;
  /** Decided / cooldown / buffer / already handled / nothing applicable. */
  skipped: number;
  errors: number;
  reason?: string;
}

/** Any prior handling of THIS session (sent, suppressed or failed) — never
 * re-run a session, whatever the router said the first time. */
async function alreadyHandled(contractId: string, since: Date): Promise<boolean> {
  const row = await prisma.notificationLog.findFirst({
    where: {
      contractId,
      template: "cancel_intent_followup",
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return row != null;
}

/** One follow-up per PERSON per cooldown — email-scoped like the flow's
 * other cooldowns, so a fresh contract never resets the clock. */
async function onCooldown(
  shopId: string,
  email: string,
  cooldownDays: number,
  now: Date,
): Promise<boolean> {
  if (cooldownDays <= 0) return false;
  const row = await prisma.notificationLog.findFirst({
    where: {
      shopId,
      email,
      template: "cancel_intent_followup",
      status: "SENT",
      createdAt: { gte: new Date(now.getTime() - cooldownDays * 86_400_000) },
    },
    select: { id: true },
  });
  return row != null;
}

/**
 * Pure: the customer paused AFTER the abandoned session closed — that pause
 * IS their decision, so neither the follow-up nor the banner may fire. A
 * contract already paused when the flow opened (pausedAt ≤ completedAt) is
 * not a decision. Shared with the banner (intent-banner.server.ts).
 */
export function pausedSince(
  contract: Pick<SubscriptionContract, "status" | "pausedAt">,
  completedAt: Date,
): boolean {
  return (
    contract.status === "PAUSED" &&
    contract.pausedAt != null &&
    contract.pausedAt.getTime() > completedAt.getTime()
  );
}

/** A billing attempt created since the session closed = money moved (or
 * tried to) after the customer walked away — the "before next charge" window
 * this email is for is over. Reads only; contained to `false`. */
async function chargedSince(contractId: string, completedAt: Date): Promise<boolean> {
  try {
    const row = await prisma.billingAttempt.findFirst({
      where: { contractId, createdAt: { gt: completedAt } },
      select: { id: true },
    });
    return row != null;
  } catch (err) {
    console.error("[cancel-intent] billing attempt read failed", contractId, err);
    return false;
  }
}

/** The next moment money moves for this contract, or null when unknown. */
function nextChargeDate(contract: SubscriptionContract): Date | null {
  if (contract.status === "PAUSED") return contract.resumeAt ?? null;
  return contract.nextBillingDate ?? null;
}

/**
 * Pure timing rule: true when the follow-up may go out at `now` — the next
 * charge moment is unknown, or at least `bufferHours` away. A charge moment
 * already in the past (preparing / stuck) blocks too: nothing edits a cycle
 * being billed. Pinned in tests.
 */
export function outsideChargeBuffer(
  chargeMoment: Date | null,
  now: Date,
  bufferHours: number,
): boolean {
  if (!chargeMoment) return true;
  return chargeMoment.getTime() - now.getTime() >= bufferHours * 3_600_000;
}

export async function runCancelIntentFollowup(now: Date): Promise<IntentFollowupStats> {
  const stats: IntentFollowupStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const shop = await getPrimaryShop();
  if (!shop) {
    stats.reason = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  let cancelFlow: SettingsValue<"cancelFlow">;
  try {
    cancelFlow = await getSetting(shop.id, "cancelFlow");
  } catch (err) {
    console.error("[cancel-intent] settings read failed", err);
    stats.reason = "settings_unreadable";
    return stats;
  }
  if (!cancelFlow.enabled || !cancelFlow.intentFollowupEnabled) {
    stats.reason = "disabled";
    return stats;
  }
  const hours = cancelFlow.intentFollowupHours;
  const dueBefore = new Date(now.getTime() - hours * 3_600_000);
  const oldest = new Date(now.getTime() - INTENT_MAX_AGE_HOURS * 3_600_000);

  let candidates: Array<Pick<CancelSession, "id" | "contractId" | "completedAt">> = [];
  try {
    candidates = await prisma.cancelSession.findMany({
      where: {
        outcome: "ABANDONED",
        completedAt: { gte: oldest, lte: dueBefore },
        contract: {
          shopId: shop.id,
          ...OURS_ONLY,
          isDemo: false,
          status: { in: ["ACTIVE", "PAUSED"] },
        },
      },
      select: { id: true, contractId: true, completedAt: true },
      orderBy: { completedAt: "asc" },
      take: 500,
    });
  } catch (err) {
    console.error("[cancel-intent] candidate scan failed", err);
    stats.reason = "scan_failed";
    return stats;
  }

  const timing = await resolveChargeTiming(shop.id, tz);
  const seenContracts = new Set<string>();

  for (const candidate of candidates) {
    if (seenContracts.has(candidate.contractId)) continue;
    seenContracts.add(candidate.contractId);
    stats.scanned += 1;
    try {
      const contract = await prisma.subscriptionContract.findUnique({
        where: { id: candidate.contractId },
        include: { lines: true },
      });
      if (!contract || (contract.status !== "ACTIVE" && contract.status !== "PAUSED")) {
        stats.skipped += 1;
        continue;
      }
      // A scheduled cancellation is a decision, not an abandoned intent.
      if (contract.cancelScheduledAt) {
        stats.skipped += 1;
        continue;
      }
      // Latest-session rule (a later save / cancel / open flow = decided).
      const intent = await findAbandonedIntent(contract.id, {
        now,
        maxAgeMs: INTENT_MAX_AGE_HOURS * 3_600_000,
      });
      if (!intent || intent.completedAt.getTime() > dueBefore.getTime()) {
        stats.skipped += 1;
        continue;
      }
      // A pause taken AFTER walking away is the decision ("never after a
      // pause"); a contract that was already paused when the flow opened
      // stays a candidate. A charge that landed since the session closes
      // the window too: this email is "before your next charge", never
      // "hours after money moved".
      if (pausedSince(contract, intent.completedAt) || (await chargedSince(contract.id, intent.completedAt))) {
        stats.skipped += 1;
        continue;
      }
      if (await alreadyHandled(contract.id, intent.completedAt)) {
        stats.skipped += 1;
        continue;
      }
      if (await onCooldown(shop.id, contract.email, cancelFlow.intentFollowupCooldownDays, now)) {
        stats.skipped += 1;
        continue;
      }
      // Timing rule: never inside the pre-charge buffer.
      const nextCharge = nextChargeDate(contract);
      const chargeMoment = nextCharge ? chargeMomentUtcSync(nextCharge, timing) : null;
      if (!outsideChargeBuffer(chargeMoment, now, cancelFlow.intentFollowupChargeBufferHours)) {
        stats.skipped += 1;
        continue;
      }

      const applicable = await intentApplicability(shop.id, tz, contract, {
        // Outside the buffer by construction — the preparing window (hours
        // after the charge moment) cannot overlap a charge ≥ buffer away.
        preparing: false,
        downsizeEnabled: cancelFlow.downsizeSaveEnabled,
        now,
      });

      const vars = await buildFollowupVars({
        shopId: shop.id,
        contract,
        intent,
        applicable,
      });

      // Nothing one-tap applies (locked, no next date, no slower option…):
      // the email would be a support line and a cancel link — not a
      // follow-up worth an inbox slot. The banner still shows "talk to us".
      if (!vars.actions) {
        stats.skipped += 1;
        continue;
      }

      const result = await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "cancel_intent_followup",
        vars,
      });
      if (result.status === "SENT") {
        stats.sent += 1;
        await logEvent({
          shopId: shop.id,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "cancel.intent_followup_sent",
          source: "SYSTEM",
          actor: "cancel_intent_followup",
          payload: {
            sessionId: intent.sessionId,
            reason: intent.reason,
            step: intent.step,
            hoursAfterAbort: Math.round(
              (now.getTime() - intent.completedAt.getTime()) / 3_600_000,
            ),
            actions: vars.actions,
          },
        });
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error("[cancel-intent] follow-up failed", candidate.contractId, err);
    }
  }
  return stats;
}

// ── Email variables ──────────────────────────────────────────────────────────

/**
 * The template's variables: reason line, the pre-composed `options_block`
 * (markdown-lite has no conditionals — inapplicable options are simply not
 * in it), the support line (Stage C channels; a reply-to fallback line when
 * none is configured), the plain cancel link and the individual URLs (each
 * an empty string when not offered, so a merchant override that references
 * one never shows a raw placeholder). Klaviyo receives `reason` / `step` as
 * event properties through the router's vars passthrough.
 */
export async function buildFollowupVars(input: {
  shopId: string;
  contract: ContractWithLines;
  intent: AbandonedIntent;
  applicable: IntentApplicability;
}): Promise<Record<string, string | number> & { actions: string }> {
  const { shopId, contract, intent, applicable } = input;
  const locale = contract.locale;
  const tr = (key: string, v?: Record<string, string | number>) => t(locale, key, v);
  const base = {
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    createdVia: "CANCEL_INTENT_FOLLOWUP",
  };
  const ttlSeconds = 14 * 24 * 3600;

  const portalUrl = await safeUrl(() => buildPortalUrl(shopId, "/"));
  const manageUrl = await safeUrl(() =>
    buildPortalUrl(shopId, `/subscription/${contract.id}`),
  );
  const cancelUrl = await safeUrl(async () => {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const host = shop?.primaryDomain ?? shop?.domain;
    if (!host) throw new Error("no shop domain");
    return `https://${host}${cancelPublicPath(contract.id)}`;
  });
  const supportUrl = await safeUrl(() => buildPortalUrl(shopId, "/account#cxs-support"));

  const lines: string[] = [];
  const offered: string[] = [];
  const urls: Record<string, string> = {
    skip_url: "",
    delay_3w_url: "",
    set_frequency_url: "",
    pause_url: "",
    manage_url: manageUrl,
    support_url: supportUrl,
    cancel_url: cancelUrl,
    portal_url: portalUrl,
  };

  for (const action of intentActionsFor(intent.reason)) {
    try {
      switch (action) {
        case "SKIP":
          if (!applicable.skip) break;
          urls.skip_url = await buildMagicUrl({ ...base, ttlSeconds, action: "SKIP_NEXT" });
          lines.push(tr("email.cancel_intent_followup.opt_skip", { skip_url: urls.skip_url }));
          offered.push(action);
          break;
        case "DELAY":
          if (!applicable.delay) break;
          urls.delay_3w_url = await buildMagicUrl({
            ...base,
            ttlSeconds,
            action: "DELAY_NEXT",
            params: { weeks: 3 },
          });
          lines.push(
            tr("email.cancel_intent_followup.opt_delay", { delay_3w_url: urls.delay_3w_url }),
          );
          offered.push(action);
          break;
        case "SLOWER":
          if (!applicable.slower) break;
          urls.set_frequency_url = await buildSetFrequencyUrl({
            ...base,
            frequency: applicable.slower,
          });
          lines.push(
            tr("email.cancel_intent_followup.opt_slower", {
              frequency: formatFrequency(tr, "every", applicable.slower),
              set_frequency_url: urls.set_frequency_url,
            }),
          );
          offered.push(action);
          break;
        case "DOWNSIZE":
          if (!applicable.downsize || !manageUrl) break;
          lines.push(tr("email.cancel_intent_followup.opt_downsize", { manage_url: manageUrl }));
          offered.push(action);
          break;
        case "PAUSE":
          if (!applicable.pause) break;
          urls.pause_url = await buildMagicUrl({
            ...base,
            ttlSeconds,
            action: "PAUSE",
            params: { months: 1 },
          });
          lines.push(tr("email.cancel_intent_followup.opt_pause", { pause_url: urls.pause_url }));
          offered.push(action);
          break;
      }
    } catch (err) {
      console.error("[cancel-intent] option build failed", contract.id, action, err);
    }
  }

  let supportLine = tr("email.cancel_intent_followup.support_line_none");
  try {
    const channels = await getSupportChannels(shopId);
    if (channels.hasAny && supportUrl) {
      supportLine = tr("email.cancel_intent_followup.support_line", { support_url: supportUrl });
    }
  } catch (err) {
    console.error("[cancel-intent] support channels failed", err);
  }

  const reasonKey = `email.cancel_intent_followup.reason.${intent.reason ?? "NONE"}`;
  let reasonLine = tr(reasonKey);
  if (reasonLine === reasonKey) reasonLine = tr("email.cancel_intent_followup.reason.NONE");

  return {
    ...urls,
    reason: intent.reason ?? "",
    step: intent.step,
    reason_line: reasonLine,
    options_block: lines.join("\n"),
    support_line: supportLine,
    cta_url: manageUrl || portalUrl,
    actions: offered.join(","),
  };
}

async function safeUrl(build: () => Promise<string>): Promise<string> {
  try {
    return await build();
  } catch (err) {
    console.error("[cancel-intent] url build failed", err);
    return "";
  }
}
