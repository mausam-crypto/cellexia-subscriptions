import prisma from "~/db.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz } from "~/lib/dates.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { sendNotification } from "~/lib/notifications/index.server";
import { buildCheckinLinks, buildPortalUrl } from "~/lib/magiclinks/builder.server";
import {
  expectationLineFor,
  nextPhaseLine,
  resolveTimeline,
  resolveTimelineArm,
  routineWeek,
  routineStart,
  timelinePosition,
} from "~/lib/portal/timeline.server";

/**
 * Week-N routine check-in (v1.28.0, P4.1) — the third surface of the
 * results timeline. Once per contract, when the customer's routine week
 * reaches settings.lifecycle.resultsTimeline.checkinWeek (default 4 — the
 * last week of phase 1, so the email leads with the "getting started" copy
 * and "from week 5" as the next-phase line), the `routine_checkin` email
 * goes out through the notifications router: the phase copy for their week
 * + the survey expectation sentence when known + two one-tap answers
 * (CHECKIN great / unsure) that land on the subscription page.
 *
 * Gates, in order: lifecycle.resultsTimeline.enabled AND
 * portalGrowth.resultsTimeline (the same toggle pair the portal card and
 * the cancel-flow reuse obey); ACTIVE, OURS, not demo; the results_timeline
 * "shown" arm (the holdout gets no email — that IS the experiment);
 * NotificationLog dedupe (one SENT per contract, ever). The router adds the
 * SETUP / ownership / demo / channel / template gates on top.
 *
 * Window: routine week ∈ [checkinWeek, checkinWeek + CHECKIN_GRACE_WEEKS)
 * — an outage of a couple of weeks still catches everyone once, while a
 * long-imported base whose week N passed months ago is never blasted. The
 * window is on the SAME anchor the surfaces use — firstChargeAt, else
 * createdAt (routineStart) — so a contract whose origin-order fetch failed
 * (or that never had one) is not silently skipped while its portal card
 * already says "week N". Never throws; every contract is contained.
 */

export const CHECKIN_GRACE_WEEKS = 3;

export interface RoutineCheckinStats {
  scanned: number;
  sent: number;
  /** Holdout arm / already sent / no position. */
  skipped: number;
  errors: number;
  reason?: string;
}

async function alreadySent(contractId: string): Promise<boolean> {
  const row = await prisma.notificationLog.findFirst({
    where: { contractId, template: "routine_checkin", status: "SENT" },
    select: { id: true },
  });
  return row != null;
}

export async function runRoutineCheckin(now: Date): Promise<RoutineCheckinStats> {
  const stats: RoutineCheckinStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const shop = await getPrimaryShop();
  if (!shop) {
    stats.reason = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  let checkinWeek = 4;
  try {
    const [lifecycle, growth] = await Promise.all([
      getSetting(shop.id, "lifecycle"),
      getSetting(shop.id, "portalGrowth"),
    ]);
    if (lifecycle.resultsTimeline?.enabled === false) {
      stats.reason = "timeline_disabled";
      return stats;
    }
    if (growth.resultsTimeline === false) {
      stats.reason = "growth_toggle_off";
      return stats;
    }
    checkinWeek = lifecycle.resultsTimeline?.checkinWeek ?? 4;
  } catch (err) {
    console.error("[lifecycle] routine check-in settings read failed", err);
    stats.reason = "settings_unreadable";
    return stats;
  }

  // start ∈ (now − (checkinWeek−1+grace)·7 d, now − (checkinWeek−1)·7 d]
  //   ⇔ routine week ∈ [checkinWeek, checkinWeek + grace)
  const windowEnd = addDaysTz(now, -(checkinWeek - 1) * 7, tz);
  const windowStart = addDaysTz(windowEnd, -CHECKIN_GRACE_WEEKS * 7, tz);

  let candidates: Array<{
    id: string;
    shopId: string;
    email: string;
    customerId: string;
    locale: string;
    firstChargeAt: Date | null;
    createdAt: Date;
    surveyHoldout: boolean | null;
  }> = [];
  try {
    candidates = await prisma.subscriptionContract.findMany({
      where: {
        shopId: shop.id,
        ...OURS_ONLY,
        isDemo: false,
        status: "ACTIVE",
        // routineStart(): firstChargeAt, else createdAt — the belt below
        // re-checks with the timeline's own math.
        OR: [
          { firstChargeAt: { gt: windowStart, lte: windowEnd } },
          { firstChargeAt: null, createdAt: { gt: windowStart, lte: windowEnd } },
        ],
      },
      select: {
        id: true,
        shopId: true,
        email: true,
        customerId: true,
        locale: true,
        firstChargeAt: true,
        createdAt: true,
        surveyHoldout: true,
      },
    });
  } catch (err) {
    console.error("[lifecycle] routine check-in candidate scan failed", err);
    stats.reason = "scan_failed";
    return stats;
  }

  for (const contract of candidates) {
    stats.scanned += 1;
    try {
      // Belt for the SQL window (the same rule, in the timeline's own math).
      const week = routineWeek(routineStart(contract), now, tz);
      if (week < checkinWeek || week >= checkinWeek + CHECKIN_GRACE_WEEKS) {
        stats.skipped += 1;
        continue;
      }
      if (await alreadySent(contract.id)) {
        stats.skipped += 1;
        continue;
      }
      const arm = await resolveTimelineArm(contract);
      if (arm !== "shown") {
        stats.skipped += 1;
        continue;
      }
      const timeline = await resolveTimeline(shop.id, contract.locale);
      const position = timelinePosition(timeline, contract, now, tz);
      if (!position) {
        stats.skipped += 1;
        continue;
      }
      const expectation = await expectationLineFor({
        timeline,
        locale: contract.locale,
        contract,
        position,
      });
      const links = await buildCheckinLinks({
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        createdVia: "ROUTINE_CHECKIN",
      });
      // Button → the subscription page; contained (no domain ⇒ no button).
      let cta_url = "";
      try {
        cta_url = await buildPortalUrl(shop.id, `/subscription/${contract.id}`);
      } catch {
        cta_url = "";
      }
      const result = await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "routine_checkin",
        vars: {
          ...(cta_url ? { cta_url } : {}),
          week: position.week,
          phase_title: position.phase.title,
          phase_body: position.phase.body,
          next_phase_line: nextPhaseLine(contract.locale, position),
          expectation_line: expectation ?? "",
          ...links,
        },
      });
      if (result.status === "SENT") stats.sent += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.errors += 1;
      console.error("[lifecycle] routine check-in failed", contract.id, err);
    }
  }

  return stats;
}
