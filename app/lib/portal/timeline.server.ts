import { differenceInCalendarDays } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { getSetting } from "~/lib/settings/settings.server";
import { DEFAULT_RESULTS_TIMELINE_PHASES } from "~/lib/settings/registry.server";

/**
 * Results timeline (v1.28.0, P4.1) — "Week N of your routine".
 *
 * ONE content source (settings.lifecycle.resultsTimeline: enabled,
 * checkinWeek, phases[{fromWeek, toWeek|null, title, body}]) feeds three
 * surfaces: the portal progress card (detail page) + compact line (home
 * card), the cancel flow's EDUCATION save (phase copy for the customer's
 * week instead of static text) and the week-N routine check-in email.
 *
 * Honesty rules (load-bearing): the DEFAULT phase copy is generic
 * daily-use-consumable language ("many people notice…", "consistency
 * matters"), never a medical or efficacy claim; a merchant override replaces
 * the text verbatim and owns its truth. Empty override text = the i18n
 * default for that phase POSITION, so translations survive for untouched
 * phases. The week itself is arithmetic on the contract's own start (golden
 * rule 5: shop-timezone calendar days) — never a guess.
 *
 * Measurement: the portal card / education reuse / check-in email are the
 * decision points of the `results_timeline` experiment (holdout arm sees
 * the pre-v1.28.0 behaviour); resolveTimelineArm wraps the kernel so a
 * kernel failure resolves to "shown" exactly like a disabled experiment.
 * All three surfaces obey the SAME toggle pair — lifecycle.resultsTimeline
 * .enabled (content) AND portalGrowth.resultsTimeline (surface) — so a
 * merchant who switches the growth toggle off gets no card, no email and no
 * cancel-flow phase copy, and no exposure is recorded for a treatment that
 * is not showing anywhere.
 *
 * Expectation line (P4.1 survey_personalisation): when the customer's
 * post-purchase survey answered expectedSpeed with a FAST horizon (days /
 * weeks / one_two_months), one extra sentence names the gap between that
 * hope and the routine's real horizon ("week {n} is right on track") — the
 * NOT_SEEING_RESULTS cohort's expectation reset. Generic, non-medical copy;
 * survey-holdout contracts never get it (survey-driven content is the
 * survey experiment's treatment); behind lifecycle.resultsTimeline
 * .expectationLine (default on).
 */

export interface TimelinePhase {
  fromWeek: number;
  /** null = open-ended (the last phase). */
  toWeek: number | null;
  /** Resolved, localized text (override or i18n default). */
  title: string;
  body: string;
}

export interface ResolvedTimeline {
  enabled: boolean;
  checkinWeek: number;
  /** Survey-answer expectation sentence on the three surfaces (default on). */
  expectationLine: boolean;
  phases: TimelinePhase[];
}

export interface TimelinePosition {
  /** 1-based routine week ("Week 1" = the first seven days). */
  week: number;
  /** Zero-based index into `phases`. */
  phaseIndex: number;
  phase: TimelinePhase;
  /** The phase after this one, null on the last. */
  next: TimelinePhase | null;
  /**
   * Progress towards the LAST phase's start week (the "results window"),
   * 0–100. Once inside the last phase it reads 100.
   */
  pct: number;
}

/** i18n default position for a phase index — the 4 shipped defaults; extra
 * merchant phases past those fall back to the last default. */
function defaultKeyIndex(index: number): number {
  return Math.min(index, DEFAULT_RESULTS_TIMELINE_PHASES.length - 1) + 1;
}

/**
 * Localize a stored phase list: non-empty merchant text wins, otherwise the
 * i18n default for the position. Pure — tests feed it directly.
 */
export function localizePhases(
  locale: string,
  stored: ReadonlyArray<{
    fromWeek: number;
    toWeek: number | null;
    title?: string;
    body?: string;
  }>,
): TimelinePhase[] {
  return stored.map((p, i) => {
    const n = defaultKeyIndex(i);
    const title = (p.title ?? "").trim() || t(locale, `portal.timeline.phase${n}.title`);
    const body = (p.body ?? "").trim() || t(locale, `portal.timeline.phase${n}.body`);
    return { fromWeek: p.fromWeek, toWeek: p.toWeek ?? null, title, body };
  });
}

/**
 * The shop's timeline, localized. Contained: an unreadable setting yields
 * the shipped defaults, still enabled (the card is decoration — but a
 * broken read must not silently switch off a measured treatment either, so
 * defaults it is).
 */
export async function resolveTimeline(
  shopId: string,
  locale: string,
): Promise<ResolvedTimeline> {
  try {
    const lifecycle = await getSetting(shopId, "lifecycle");
    const cfg = lifecycle.resultsTimeline;
    return {
      enabled: cfg.enabled !== false,
      checkinWeek: cfg.checkinWeek,
      expectationLine: cfg.expectationLine !== false,
      phases: localizePhases(locale, cfg.phases),
    };
  } catch (err) {
    console.error("[portal] results timeline settings read failed", err);
    return {
      enabled: true,
      checkinWeek: 4,
      expectationLine: true,
      phases: localizePhases(locale, DEFAULT_RESULTS_TIMELINE_PHASES),
    };
  }
}

/**
 * Is the surface pair switched on? portalGrowth.resultsTimeline gates the
 * card, the check-in email AND the cancel-flow reuse alike. Contained: an
 * unreadable growth book reads "on" (the merchant's toggle decides, not an
 * outage — same rule as resolveTimeline).
 */
export async function timelineSurfaceEnabled(shopId: string): Promise<boolean> {
  try {
    const growth = await getSetting(shopId, "portalGrowth");
    return growth.resultsTimeline !== false;
  } catch (err) {
    console.error("[portal] results timeline growth toggle read failed", err);
    return true;
  }
}

/**
 * 1-based routine week from the contract's start, in shop-timezone
 * calendar days: days 0–6 → week 1, 7–13 → week 2, … A start in the future
 * (clock skew, imported contract) reads as week 1, never 0 or negative.
 */
export function routineWeek(start: Date, now: Date, tz: string): number {
  const days = differenceInCalendarDays(toZonedTime(now, tz), toZonedTime(start, tz));
  return Math.max(1, Math.floor(Math.max(0, days) / 7) + 1);
}

/**
 * Where week N sits on the phase list. Phase boundaries are in "weeks
 * completed" space: a phase [fromWeek, toWeek) covers routine weeks
 * fromWeek+1 … toWeek (weeks 1–4 for 0–4, 5–8 for 4–8, …); the last phase is
 * open-ended. Before the first phase (never with the defaults) → the first
 * phase. Pure.
 */
export function positionForWeek(
  phases: readonly TimelinePhase[],
  week: number,
): TimelinePosition | null {
  if (phases.length === 0) return null;
  const completed = Math.max(0, week - 1);
  let phaseIndex = 0;
  for (let i = 0; i < phases.length; i += 1) {
    if (completed >= phases[i].fromWeek) phaseIndex = i;
  }
  const phase = phases[phaseIndex];
  const next = phases[phaseIndex + 1] ?? null;
  const last = phases[phases.length - 1];
  const horizon = Math.max(1, last.fromWeek);
  const pct = Math.min(100, Math.max(4, Math.round((completed / horizon) * 100)));
  return { week, phaseIndex, phase, next, pct: phaseIndex === phases.length - 1 ? 100 : pct };
}

/** Contract start for week math — the same anchor the rewards strip uses. */
export function routineStart(contract: {
  firstChargeAt: Date | null;
  createdAt: Date;
}): Date {
  return contract.firstChargeAt ?? contract.createdAt;
}

/**
 * The customer's current position, or null when the timeline is disabled /
 * has no phases. Convenience for the three surfaces.
 */
export function timelinePosition(
  timeline: ResolvedTimeline,
  contract: { firstChargeAt: Date | null; createdAt: Date },
  now: Date,
  tz: string,
): TimelinePosition | null {
  if (!timeline.enabled) return null;
  return positionForWeek(timeline.phases, routineWeek(routineStart(contract), now, tz));
}

/**
 * The results_timeline experiment arm, contained: any kernel/import
 * failure resolves to "shown" (a disabled experiment's resolution — the
 * merchant's toggle, not an outage, decides who is held out).
 */
export async function resolveTimelineArm(contract: {
  shopId: string;
  id: string;
  email: string;
}): Promise<"shown" | "holdout"> {
  try {
    const { resultsTimelineArmFor } = await import("~/lib/experiments/index.server");
    return await resultsTimelineArmFor(contract);
  } catch (err) {
    console.error("[portal] results timeline arm failed", contract.id, err);
    return "shown";
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** "From week {n}: {title}" for the next phase; "" on the last phase. */
export function nextPhaseLine(locale: string, pos: TimelinePosition): string {
  if (!pos.next) return "";
  return t(locale, "portal.timeline.next_phase", {
    week: pos.next.fromWeek + 1,
    title: pos.next.title,
  });
}

/**
 * The detail-page progress card. `checkinAnswer` (from the routine
 * check-in email's one-tap answer) adds a one-line acknowledgement.
 */
export function timelineCardHtml(input: {
  locale: string;
  position: TimelinePosition;
  checkinAnswer?: "great" | "unsure" | null;
  /** The survey expectation sentence (expectationLineFor); null = none. */
  expectationLine?: string | null;
}): string {
  const { locale, position: pos } = input;
  const weekLabel = t(locale, "portal.timeline.week_title", { week: pos.week });
  const ack =
    input.checkinAnswer === "great"
      ? `<p class="cxs-small cxs-timeline__ack" style="margin:0 0 8px">${escapeHtml(t(locale, "portal.timeline.checkin_ack_great"))}</p>`
      : input.checkinAnswer === "unsure"
        ? `<p class="cxs-small cxs-timeline__ack" style="margin:0 0 8px">${escapeHtml(t(locale, "portal.timeline.checkin_ack_unsure"))}</p>`
        : "";
  const next = nextPhaseLine(locale, pos);
  const nextHtml = next
    ? `<p class="cxs-small cxs-muted cxs-timeline__next" style="margin:8px 0 0">${escapeHtml(next)}</p>`
    : "";
  return `<section class="cxs-card cxs-timeline" id="cxs-timeline" aria-labelledby="cxs-timeline-title">
  <div class="cxs-row cxs-row--between">
    <strong id="cxs-timeline-title">${escapeHtml(weekLabel)}</strong>
    <span class="cxs-small cxs-muted cxs-timeline__phase">${escapeHtml(pos.phase.title)}</span>
  </div>
  <div class="cxs-progress cxs-progress--timeline" role="progressbar" aria-label="${escapeHtml(t(locale, "portal.a11y.progress_timeline"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pos.pct}" aria-valuetext="${escapeHtml(weekLabel)}" style="height:6px;background:var(--cxs-accent-soft);border-radius:999px;margin:10px 0;overflow:hidden"><span style="width:${pos.pct}%;height:100%;background:var(--cxs-accent);border-radius:999px"></span></div>
  ${ack}<p class="cxs-small cxs-timeline__body" style="margin:0">${escapeHtml(pos.phase.body)}</p>
  ${input.expectationLine ? `<p class="cxs-small cxs-timeline__expectation" style="margin:8px 0 0">${escapeHtml(input.expectationLine)}</p>` : ""}${nextHtml}
</section>`;
}

/** Compact one-liner for the home card: "Week 3 of your routine · {title}". */
export function timelineLineHtml(locale: string, pos: TimelinePosition): string {
  const text = t(locale, "portal.timeline.home_line", {
    week: pos.week,
    title: pos.phase.title,
  });
  return `<p class="cxs-small cxs-muted cxs-timeline__line" style="margin:8px 0 0">${escapeHtml(text)}</p>`;
}

/**
 * The cancel flow's EDUCATION card body for a positioned customer: the
 * phase copy for THEIR week (title + body) plus the "what comes next" line
 * — replaces the static "8–12 weeks" sentence. Plain text (the card escapes).
 */
export function educationTimelineText(
  locale: string,
  pos: TimelinePosition,
  expectationLine: string | null = null,
): string {
  const head = t(locale, "portal.timeline.education_lead", {
    week: pos.week,
    title: pos.phase.title,
  });
  const next = nextPhaseLine(locale, pos);
  return [head, pos.phase.body, expectationLine, next].filter(Boolean).join(" ");
}

// ── Expectation line (survey expectedSpeed) ──────────────────────────────────

/** The survey answers that name a horizon shorter than the routine's. */
const FAST_EXPECTATIONS = ["days", "weeks", "one_two_months"] as const;
type FastExpectation = (typeof FAST_EXPECTATIONS)[number];

/**
 * The one-line expectation reset for a survey answer, or null when the
 * answer is unknown / already patient (three_months_plus, not_sure) — those
 * customers need no reset. Pure.
 */
export function expectationLine(
  locale: string,
  answer: string | null | undefined,
  pos: TimelinePosition,
): string | null {
  if (!answer || !(FAST_EXPECTATIONS as readonly string[]).includes(answer)) return null;
  return t(locale, `portal.timeline.expectation.${answer as FastExpectation}`, {
    week: pos.week,
  });
}

/**
 * The contract's survey expectedSpeed answer, or null: no survey, no answer,
 * or a survey-HOLDOUT contract (survey-driven content is that experiment's
 * treatment — the holdout must not receive it). Newest answered response
 * wins. Contained: any failure → null (the sentence is optional).
 */
export async function expectedSpeedFor(contract: {
  id: string;
  surveyHoldout?: boolean | null;
}): Promise<string | null> {
  if (contract.surveyHoldout === true) return null;
  try {
    const row = await prisma.surveyResponse.findFirst({
      where: { contractId: contract.id, answeredAt: { not: null } },
      orderBy: { answeredAt: "desc" },
      select: { answers: true },
    });
    const answers = row?.answers as { expectedSpeed?: unknown } | null | undefined;
    const v = answers?.expectedSpeed;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch (err) {
    console.error("[portal] survey expectedSpeed read failed", contract.id, err);
    return null;
  }
}

/**
 * The expectation sentence for a contract on a surface, or null: the
 * lifecycle.resultsTimeline.expectationLine toggle, then the survey answer.
 * Contained.
 */
export async function expectationLineFor(input: {
  timeline: ResolvedTimeline;
  locale: string;
  contract: { id: string; surveyHoldout?: boolean | null };
  position: TimelinePosition;
}): Promise<string | null> {
  if (!input.timeline.expectationLine) return null;
  const answer = await expectedSpeedFor(input.contract);
  return expectationLine(input.locale, answer, input.position);
}

// ── First-cycle onboarding card (v1.28.0, P4.5) ──────────────────────────────

export interface OnboardingCardInput {
  locale: string;
  /** The checkout order: label ("#1042" or ""), formatted date, and — when
   * the delivery mirror knows — a status label + order page URL. */
  firstOrder: {
    name: string | null;
    dateLabel: string | null;
    statusLabel: string | null;
    orderStatusUrl: string | null;
    trackingUrl: string | null;
  };
  /** Next order (formatted) + the change cut-off (formatted); null = unknown. */
  nextDateLabel: string | null;
  cutoffLabel: string | null;
  /** Education links (settings.portal.*) — rendered when present. */
  links: { howToUseUrl: string; routineGuideUrl: string; faqUrl: string };
  /** In-page anchor of the support card; null hides the line. */
  helpHref: string | null;
}

/**
 * "What happens next" — shown on the detail page until the SECOND order has
 * billed (ordersCount < 2; the caller decides). Says only what the local
 * mirror proves: the first order's date/name (and status when the delivery
 * mirror has it), the next order date + cut-off from THE estimate/timing
 * helpers, how changes work, and the merchant's guide links. Growth copy
 * hygiene: never names cancellation.
 */
export function onboardingCardHtml(input: OnboardingCardInput): string {
  const { locale } = input;
  const rows: string[] = [];
  const fo = input.firstOrder;
  const firstText = fo.dateLabel
    ? fo.name
      ? t(locale, "portal.onboarding.first_order_named", { name: fo.name, date: fo.dateLabel })
      : t(locale, "portal.onboarding.first_order", { date: fo.dateLabel })
    : t(locale, "portal.onboarding.first_order_nodate");
  const link = (href: string | null, label: string): string =>
    href && /^https:\/\/[^\s"'<>]+$/i.test(href)
      ? ` <a class="cxs-link" href="${escapeHtml(href)}" rel="noopener">${escapeHtml(label)}</a>`
      : "";
  const status = fo.statusLabel
    ? ` <span class="cxs-badge cxs-badge--muted">${escapeHtml(fo.statusLabel)}</span>`
    : "";
  rows.push(
    `<li class="cxs-onboarding__row"><strong>${escapeHtml(t(locale, "portal.onboarding.step_first"))}</strong> ${escapeHtml(firstText)}${status}${link(fo.trackingUrl, t(locale, "portal.onboarding.track"))}${link(fo.orderStatusUrl, t(locale, "portal.onboarding.view_order"))}</li>`,
  );
  if (input.nextDateLabel) {
    const nextText = input.cutoffLabel
      ? t(locale, "portal.onboarding.next_order_cutoff", {
          date: input.nextDateLabel,
          cutoff: input.cutoffLabel,
        })
      : t(locale, "portal.onboarding.next_order", { date: input.nextDateLabel });
    rows.push(
      `<li class="cxs-onboarding__row"><strong>${escapeHtml(t(locale, "portal.onboarding.step_next"))}</strong> ${escapeHtml(nextText)}</li>`,
    );
  }
  rows.push(
    `<li class="cxs-onboarding__row"><strong>${escapeHtml(t(locale, "portal.onboarding.step_changes"))}</strong> ${escapeHtml(t(locale, "portal.onboarding.changes_body"))}</li>`,
  );
  const guideLinks: string[] = [];
  const a = (href: string, label: string) =>
    `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  if (input.links.howToUseUrl) {
    guideLinks.push(a(input.links.howToUseUrl, t(locale, "portal.education.how_to_use_plural")));
  }
  if (input.links.routineGuideUrl) {
    guideLinks.push(a(input.links.routineGuideUrl, t(locale, "portal.education.routine_guide")));
  }
  if (input.links.faqUrl) guideLinks.push(a(input.links.faqUrl, t(locale, "portal.education.faq")));
  if (guideLinks.length > 0) {
    rows.push(
      `<li class="cxs-onboarding__row"><strong>${escapeHtml(t(locale, "portal.onboarding.step_learn"))}</strong> <span class="cxs-onboarding__links">${guideLinks.join(" ")}</span></li>`,
    );
  }
  const help = input.helpHref
    ? `<p class="cxs-small cxs-muted" style="margin:10px 0 0"><a href="${escapeHtml(input.helpHref)}">${escapeHtml(t(locale, "portal.onboarding.help"))}</a></p>`
    : "";
  return `<section class="cxs-card cxs-onboarding" id="cxs-onboarding" aria-labelledby="cxs-onboarding-title">
  <h2 id="cxs-onboarding-title" style="font-size:18px;margin:0 0 6px">${escapeHtml(t(locale, "portal.onboarding.title"))}</h2>
  <p class="cxs-muted cxs-small" style="margin:0 0 10px">${escapeHtml(t(locale, "portal.onboarding.intro"))}</p>
  <ol class="cxs-onboarding__list" style="margin:0;padding-left:18px;display:grid;gap:8px">${rows.join("")}</ol>
  ${help}
</section>`;
}

/**
 * The cancel flow's phase-aware EDUCATION sentence for a contract, or null
 * when the static copy applies: timeline disabled (either toggle of the
 * pair — portalGrowth.resultsTimeline is checked BEFORE the arm so no
 * exposure is recorded for a switched-off treatment), no position, or the
 * customer sits in the results_timeline holdout arm (the arm is resolved —
 * and exposure recorded — only for real customers; previews read "shown").
 * Contained: any failure → null (the static sentence is always truthful).
 */
export async function educationTimelineTextFor(input: {
  shopId: string;
  tz: string;
  locale: string;
  contract: {
    id: string;
    shopId: string;
    email: string;
    firstChargeAt: Date | null;
    createdAt: Date;
    isDemo?: boolean;
    surveyHoldout?: boolean | null;
  };
  isPreview: boolean;
  now?: Date;
}): Promise<string | null> {
  try {
    if (!(await timelineSurfaceEnabled(input.shopId))) return null;
    const timeline = await resolveTimeline(input.shopId, input.locale);
    const pos = timelinePosition(timeline, input.contract, input.now ?? new Date(), input.tz);
    if (!pos) return null;
    const arm =
      input.isPreview || input.contract.isDemo
        ? "shown"
        : await resolveTimelineArm(input.contract);
    if (arm !== "shown") return null;
    const expectation = await expectationLineFor({
      timeline,
      locale: input.locale,
      contract: input.contract,
      position: pos,
    });
    return educationTimelineText(input.locale, pos, expectation);
  } catch (err) {
    console.error("[cancel] education timeline text failed", input.contract.id, err);
    return null;
  }
}
