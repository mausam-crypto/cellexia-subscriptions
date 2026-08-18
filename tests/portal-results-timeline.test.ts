import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RESULTS TIMELINE (v1.28.0, P4.1) — "Week N of your routine".
 *
 * Pinned here:
 *  1. Registry: lifecycle.resultsTimeline defaults (enabled, checkinWeek 4,
 *     four phases 0–4 / 4–8 / 8–12 / 12+), the Settings-page record→array
 *     preprocess, the increasing-start refine; portalGrowth.resultsTimeline
 *     defaults ON.
 *  2. Phase math: routineWeek is shop-tz calendar arithmetic (week 1 = the
 *     first seven days), positionForWeek maps a week to its phase / next /
 *     progress, i18n defaults fill empty merchant text per POSITION.
 *  3. Copy hygiene: default phase copy never claims (medical / efficacy
 *     words) and never names cancellation.
 *  4. Toggle + holdout: a disabled timeline yields no position; the
 *     experiment kernel decides shown/holdout (control = "shown", ON by
 *     default, mirrors gift2_holdout); the education reuse returns null for
 *     the holdout arm and never touches the kernel in preview.
 *  5. Source pins: the detail route keys the card on growth.resultsTimeline
 *     + the arm; the cancel saves page prefers the phase sentence over the
 *     static one; the check-in email template is registered.
 *  6. Stage E review: portalGrowth.resultsTimeline gates the cancel-flow
 *     reuse too (checked BEFORE the arm — no exposure while off); toWeek is
 *     DERIVED from the next phase's fromWeek on parse; the survey
 *     expectedSpeed expectation line (days/weeks/one_two_months only,
 *     survey holdout excluded, lifecycle.resultsTimeline.expectationLine
 *     toggle) on the card / education / check-in surfaces; the check-in
 *     default 4 is documented as the LAST week of phase 1.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  arm: vi.fn(async (): Promise<string> => "shown"),
  surveyFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: { surveyResponse: { findFirst: mocks.surveyFindFirst } },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/experiments/index.server", () => ({
  resultsTimelineArmFor: mocks.arm,
}));

import {
  DEFAULT_RESULTS_TIMELINE_PHASES,
  settingsSchemas,
} from "~/lib/settings/registry.server";
import {
  educationTimelineText,
  educationTimelineTextFor,
  expectationLine,
  expectationLineFor,
  expectedSpeedFor,
  localizePhases,
  positionForWeek,
  resolveTimeline,
  resolveTimelineArm,
  routineWeek,
  timelineCardHtml,
  timelineLineHtml,
  timelinePosition,
} from "~/lib/portal/timeline.server";

const TZ = "Europe/Zurich";
const phases = () => localizePhases("en", DEFAULT_RESULTS_TIMELINE_PHASES);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "lifecycle") return settingsSchemas.lifecycle.parse(undefined);
    return {};
  });
  mocks.arm.mockResolvedValue("shown");
  mocks.surveyFindFirst.mockResolvedValue(null);
});

// ── 1. Registry ──────────────────────────────────────────────────────────────

describe("lifecycle.resultsTimeline setting", () => {
  it("defaults: enabled, check-in week 4, four generic phases with empty text", () => {
    const lifecycle = settingsSchemas.lifecycle.parse(undefined);
    expect(lifecycle.resultsTimeline.enabled).toBe(true);
    expect(lifecycle.resultsTimeline.checkinWeek).toBe(4);
    expect(lifecycle.resultsTimeline.phases.map((p) => [p.fromWeek, p.toWeek])).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
      [12, null],
    ]);
    for (const p of lifecycle.resultsTimeline.phases) {
      expect(p.title).toBe("");
      expect(p.body).toBe("");
    }
  });

  it("a stored pre-v1.28.0 lifecycle book gets the timeline defaults (field-level default)", () => {
    const parsed = settingsSchemas.lifecycle.safeParse({
      surpriseGiftOnCycle2: true,
      milestoneGiftCycle: 6,
      anniversaryGiftDays: 365,
      rewardsUnlockDay: 90,
      earlyCycleIncentivesEnabled: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resultsTimeline.checkinWeek).toBe(4);
  });

  it("accepts the Settings page's numeric-keyed record shape as the phase array", () => {
    const parsed = settingsSchemas.lifecycle.safeParse({
      surpriseGiftOnCycle2: true,
      milestoneGiftCycle: 6,
      anniversaryGiftDays: 365,
      rewardsUnlockDay: 90,
      earlyCycleIncentivesEnabled: true,
      resultsTimeline: {
        enabled: true,
        checkinWeek: 5,
        phases: {
          "0": { fromWeek: 0, toWeek: 3, title: "Start", body: "" },
          "1": { fromWeek: 3, toWeek: undefined, title: "", body: "Keep going" },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.resultsTimeline.phases).toEqual([
        { fromWeek: 0, toWeek: 3, title: "Start", body: "" },
        { fromWeek: 3, toWeek: null, title: "", body: "Keep going" },
      ]);
    }
  });

  it("rejects non-increasing phase starts", () => {
    const parsed = settingsSchemas.lifecycle.safeParse({
      surpriseGiftOnCycle2: true,
      milestoneGiftCycle: 6,
      anniversaryGiftDays: 365,
      rewardsUnlockDay: 90,
      earlyCycleIncentivesEnabled: true,
      resultsTimeline: {
        phases: [
          { fromWeek: 4, toWeek: 8 },
          { fromWeek: 4, toWeek: null },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("portalGrowth.resultsTimeline ships ON", () => {
    expect(settingsSchemas.portalGrowth.parse(undefined).resultsTimeline).toBe(true);
  });
});

// ── 2. Phase math ────────────────────────────────────────────────────────────

describe("routineWeek — shop-tz calendar weeks", () => {
  const start = new Date("2026-08-01T10:00:00Z");
  it("days 0–6 are week 1, day 7 opens week 2", () => {
    expect(routineWeek(start, new Date("2026-08-01T12:00:00Z"), TZ)).toBe(1);
    expect(routineWeek(start, new Date("2026-08-07T23:00:00Z"), TZ)).toBe(2); // Aug 8 01:00 in Zurich
    expect(routineWeek(start, new Date("2026-08-07T20:00:00Z"), TZ)).toBe(1); // still Aug 7 in Zurich
    expect(routineWeek(start, new Date("2026-08-29T12:00:00Z"), TZ)).toBe(5);
  });
  it("a start in the future reads as week 1, never 0", () => {
    expect(routineWeek(start, new Date("2026-07-20T00:00:00Z"), TZ)).toBe(1);
  });
});

describe("positionForWeek", () => {
  it("maps weeks onto the four default phases and exposes the next one", () => {
    const p = phases();
    expect(positionForWeek(p, 1)?.phaseIndex).toBe(0);
    expect(positionForWeek(p, 4)?.phaseIndex).toBe(0);
    expect(positionForWeek(p, 5)?.phaseIndex).toBe(1);
    expect(positionForWeek(p, 8)?.phaseIndex).toBe(1);
    expect(positionForWeek(p, 9)?.phaseIndex).toBe(2);
    expect(positionForWeek(p, 12)?.phaseIndex).toBe(2);
    const last = positionForWeek(p, 13);
    expect(last?.phaseIndex).toBe(3);
    expect(last?.next).toBeNull();
    expect(last?.pct).toBe(100);
    const first = positionForWeek(p, 1);
    expect(first?.next?.title).toBe(p[1].title);
    expect(first?.pct).toBeGreaterThanOrEqual(4);
    expect(first?.pct).toBeLessThan(50);
  });
  it("returns null with no phases", () => {
    expect(positionForWeek([], 3)).toBeNull();
  });
});

describe("localizePhases", () => {
  it("merchant text wins per field; empty text falls back to the i18n default for that position", () => {
    const out = localizePhases("en", [
      { fromWeek: 0, toWeek: 4, title: "My start", body: "" },
      { fromWeek: 4, toWeek: null, title: "", body: "Custom body" },
    ]);
    expect(out[0].title).toBe("My start");
    expect(out[0].body).not.toBe("");
    expect(out[0].body).not.toMatch(/portal\.timeline/); // resolved, not the key
    expect(out[1].title).not.toMatch(/portal\.timeline/);
    expect(out[1].body).toBe("Custom body");
  });
});

// ── 3. Copy hygiene ──────────────────────────────────────────────────────────

describe("default phase copy hygiene", () => {
  it("makes no medical/efficacy claim and never names cancellation", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<
      string,
      string
    >;
    const keys = Object.keys(catalog).filter(
      (k) => k.startsWith("portal.timeline.") || k.startsWith("email.routine_checkin."),
    );
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const key of keys) {
      expect(catalog[key], key).not.toMatch(/cancel/i);
      expect(catalog[key], key).not.toMatch(
        /\b(cure|cures|treat|treats|treatment|clinically|proven|guarantee|guaranteed|heal|heals|medical|results? (are|is) guaranteed)\b/i,
      );
    }
    // The generic hedge is the house voice.
    expect(catalog["portal.timeline.phase3.body"]).toMatch(/many people/i);
  });
});

// ── 4. Toggle + holdout ──────────────────────────────────────────────────────

describe("resolveTimeline / timelinePosition", () => {
  const contract = {
    firstChargeAt: new Date("2026-07-01T00:00:00Z"),
    createdAt: new Date("2026-06-30T00:00:00Z"),
  };
  it("disabled timeline ⇒ no position (nothing renders anywhere)", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") {
        const base = settingsSchemas.lifecycle.parse(undefined);
        return { ...base, resultsTimeline: { ...base.resultsTimeline, enabled: false } };
      }
      return {};
    });
    const timeline = await resolveTimeline("shop_1", "en");
    expect(timeline.enabled).toBe(false);
    expect(timelinePosition(timeline, contract, new Date("2026-08-01T00:00:00Z"), TZ)).toBeNull();
  });
  it("enabled ⇒ the week from firstChargeAt in shop tz", async () => {
    const timeline = await resolveTimeline("shop_1", "en");
    const pos = timelinePosition(timeline, contract, new Date("2026-08-01T00:00:00Z"), TZ);
    // Jul 1 → Aug 1 = 31 days ⇒ week 5 (phase 2).
    expect(pos?.week).toBe(5);
    expect(pos?.phaseIndex).toBe(1);
  });
  it("an unreadable setting degrades to the shipped defaults, still enabled", async () => {
    mocks.getSetting.mockRejectedValueOnce(new Error("db down"));
    const timeline = await resolveTimeline("shop_1", "en");
    expect(timeline.enabled).toBe(true);
    expect(timeline.phases).toHaveLength(4);
  });
});

describe("experiment arm", () => {
  it("results_timeline is registered ON by default with 'shown' as control (gift2 pattern)", async () => {
    const src = readSource("app/lib/experiments/index.server.ts");
    expect(src).toContain('key: "results_timeline"');
    const block = src.slice(src.indexOf('key: "results_timeline"'), src.indexOf('key: "final_offer_depth"'));
    expect(block).toMatch(/key: "shown"[\s\S]*key: "holdout"/);
    expect(block).toContain("defaultEnabled: true");
    expect(src).toContain("export async function resultsTimelineArmFor");
  });
  it("resolveTimelineArm returns the kernel's arm and fails to 'shown'", async () => {
    const c = { shopId: "shop_1", id: "c1", email: "a@b.c" };
    mocks.arm.mockResolvedValueOnce("holdout");
    expect(await resolveTimelineArm(c)).toBe("holdout");
    mocks.arm.mockRejectedValueOnce(new Error("kernel down"));
    expect(await resolveTimelineArm(c)).toBe("shown");
  });
});

describe("cancel EDUCATION reuse — educationTimelineTextFor", () => {
  const contract = {
    id: "c1",
    shopId: "shop_1",
    email: "a@b.c",
    firstChargeAt: new Date("2026-07-01T00:00:00Z"),
    createdAt: new Date("2026-07-01T00:00:00Z"),
  };
  const now = new Date("2026-08-01T00:00:00Z");
  it("shown arm ⇒ the phase sentence for the customer's week", async () => {
    const text = await educationTimelineTextFor({
      shopId: "shop_1",
      tz: TZ,
      locale: "en",
      contract,
      isPreview: false,
      now,
    });
    expect(text).toContain("week 5");
    expect(text).toContain(phases()[1].title);
    expect(text).toContain(phases()[1].body);
    expect(text).toContain("From week 9");
    expect(mocks.arm).toHaveBeenCalledTimes(1);
  });
  it("holdout arm ⇒ null (the static sentence renders)", async () => {
    mocks.arm.mockResolvedValueOnce("holdout");
    expect(
      await educationTimelineTextFor({ shopId: "shop_1", tz: TZ, locale: "en", contract, isPreview: false, now }),
    ).toBeNull();
  });
  it("preview never touches the kernel", async () => {
    const text = await educationTimelineTextFor({
      shopId: "shop_1",
      tz: TZ,
      locale: "en",
      contract,
      isPreview: true,
      now,
    });
    expect(text).not.toBeNull();
    expect(mocks.arm).not.toHaveBeenCalled();
  });
  it("timeline disabled ⇒ null", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") {
        const base = settingsSchemas.lifecycle.parse(undefined);
        return { ...base, resultsTimeline: { ...base.resultsTimeline, enabled: false } };
      }
      return {};
    });
    expect(
      await educationTimelineTextFor({ shopId: "shop_1", tz: TZ, locale: "en", contract, isPreview: false, now }),
    ).toBeNull();
  });
  it("portalGrowth.resultsTimeline OFF ⇒ null, and the arm is never resolved (no exposure for a switched-off treatment)", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") return settingsSchemas.lifecycle.parse(undefined);
      if (key === "portalGrowth") return { ...settingsSchemas.portalGrowth.parse(undefined), resultsTimeline: false };
      return {};
    });
    expect(
      await educationTimelineTextFor({ shopId: "shop_1", tz: TZ, locale: "en", contract, isPreview: false, now }),
    ).toBeNull();
    expect(mocks.arm).not.toHaveBeenCalled();
    // An unreadable growth book reads ON (the merchant's toggle decides, not an outage).
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") return settingsSchemas.lifecycle.parse(undefined);
      if (key === "portalGrowth") throw new Error("db");
      return {};
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await educationTimelineTextFor({ shopId: "shop_1", tz: TZ, locale: "en", contract, isPreview: false, now }),
    ).toContain("week 5");
    spy.mockRestore();
  });
  it("adds the survey expectation sentence when the answer is a fast horizon", async () => {
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: "days" } });
    const text = await educationTimelineTextFor({ shopId: "shop_1", tz: TZ, locale: "en", contract, isPreview: false, now });
    expect(text).toContain("within days");
    expect(text).toContain("week 5 is right on track");
    // Order: lead, phase body, expectation, next phase.
    expect(text!.indexOf("within days")).toBeGreaterThan(text!.indexOf(phases()[1].body));
    expect(text!.indexOf("within days")).toBeLessThan(text!.indexOf("From week 9"));
  });
});

// ── Expectation line (survey expectedSpeed) ──────────────────────────────────

describe("expectation line — survey expectedSpeed", () => {
  const pos = () => positionForWeek(phases(), 5)!;
  it("days / weeks / one_two_months get a sentence with the week; patient or unknown answers get none", () => {
    expect(expectationLine("en", "days", pos())).toContain("within days");
    expect(expectationLine("en", "weeks", pos())).toContain("within a few weeks");
    expect(expectationLine("en", "one_two_months", pos())).toContain("month or two");
    for (const a of ["three_months_plus", "not_sure", "", null, undefined, "bogus"]) {
      expect(expectationLine("en", a, pos())).toBeNull();
    }
    expect(expectationLine("en", "days", pos())).toContain("week 5");
  });
  it("copy hygiene: generic, non-medical, never names cancellation", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    for (const k of ["days", "weeks", "one_two_months"]) {
      const v = catalog[`portal.timeline.expectation.${k}`];
      expect(v).toContain("{week}");
      expect(v).not.toMatch(/cancel|cure|heal|clinical|proven|guarantee|wrinkle|skin/i);
    }
  });
  it("expectedSpeedFor: newest answered response's answer; null for no survey, invalid answer, a survey-HOLDOUT contract, or a failed read", async () => {
    expect(await expectedSpeedFor({ id: "c1" })).toBeNull();
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: "weeks" } });
    expect(await expectedSpeedFor({ id: "c1" })).toBe("weeks");
    const args = mocks.surveyFindFirst.mock.calls.at(-1)![0] as { where: Record<string, unknown>; orderBy: unknown };
    expect(args.where).toMatchObject({ contractId: "c1", answeredAt: { not: null } });
    expect(args.orderBy).toEqual({ answeredAt: "desc" });
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: 3 } });
    expect(await expectedSpeedFor({ id: "c1" })).toBeNull();
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: "weeks" } });
    mocks.surveyFindFirst.mockClear();
    expect(await expectedSpeedFor({ id: "c1", surveyHoldout: true })).toBeNull();
    expect(mocks.surveyFindFirst).not.toHaveBeenCalled();
    mocks.surveyFindFirst.mockRejectedValueOnce(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await expectedSpeedFor({ id: "c1" })).toBeNull();
    spy.mockRestore();
  });
  it("expectationLineFor obeys lifecycle.resultsTimeline.expectationLine (default ON)", async () => {
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: "days" } });
    const base = { enabled: true, checkinWeek: 4, phases: phases() };
    expect(
      await expectationLineFor({ timeline: { ...base, expectationLine: true }, locale: "en", contract: { id: "c1" }, position: pos() }),
    ).toContain("within days");
    expect(
      await expectationLineFor({ timeline: { ...base, expectationLine: false }, locale: "en", contract: { id: "c1" }, position: pos() }),
    ).toBeNull();
    expect(settingsSchemas.lifecycle.parse(undefined).resultsTimeline.expectationLine).toBe(true);
  });
  it("the card renders it under the phase body; educationTimelineText appends it before the next-phase line", () => {
    const html = timelineCardHtml({ locale: "en", position: pos(), expectationLine: "You hoped <fast>." });
    expect(html).toContain('class="cxs-small cxs-timeline__expectation"');
    expect(html).toContain("You hoped &lt;fast&gt;.");
    expect(timelineCardHtml({ locale: "en", position: pos() })).not.toContain("cxs-timeline__expectation");
    const text = educationTimelineText("en", pos(), "EXPECT");
    expect(text.indexOf("EXPECT")).toBeGreaterThan(text.indexOf(pos().phase.body));
    expect(text.indexOf("EXPECT")).toBeLessThan(text.indexOf("From week 9"));
  });
  it("wired on all three surfaces: detail card, check-in email var + template placeholder, cancel reuse", () => {
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(detail).toContain("expectationLineFor({");
    expect(detail).toContain("expectationLine: expectation,");
    const checkin = readSource("app/lib/lifecycle/checkin.server.ts");
    expect(checkin).toContain('expectation_line: expectation ?? ""');
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    expect(catalog["email.routine_checkin.body"]).toContain("{phase_body}\n\n{expectation_line}\n\n{next_phase_line}");
    const timeline = readSource("app/lib/portal/timeline.server.ts");
    expect(timeline).toContain("return educationTimelineText(input.locale, pos, expectation);");
  });
});

describe("phase toWeek is derived; check-in default is documented as the last week of phase 1", () => {
  it("toWeek always equals the next phase's fromWeek (null on the last), whatever was stored", () => {
    const base = settingsSchemas.lifecycle.parse(undefined);
    const parsed = settingsSchemas.lifecycle.parse({
      ...base,
      resultsTimeline: {
        ...base.resultsTimeline,
        phases: [
          { fromWeek: 0, toWeek: 6 },
          { fromWeek: 4, toWeek: null },
          { fromWeek: 10, toWeek: 99 },
        ],
      },
    });
    expect(parsed.resultsTimeline.phases.map((p) => [p.fromWeek, p.toWeek])).toEqual([
      [0, 4],
      [4, 10],
      [10, null],
    ]);
  });
  it("week 4 (the default check-in week) sits in phase 1 and the docs say so", () => {
    expect(positionForWeek(phases(), 4)?.phaseIndex).toBe(0);
    for (const rel of ["app/lib/settings/registry.server.ts", "app/lib/lifecycle/checkin.server.ts", "app/routes/app.settings.tsx"]) {
      const src = readSource(rel);
      expect(src, rel).not.toMatch(/default 4 (=|—) (the )?start of phase 2/);
      expect(src, rel).toMatch(/last week of phase 1/i);
    }
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("timelineCardHtml / timelineLineHtml", () => {
  it("renders the week, the phase copy, the next phase and an accessible progress bar in the cxs- namespace", () => {
    const pos = positionForWeek(phases(), 3)!;
    const html = timelineCardHtml({ locale: "en", position: pos, checkinAnswer: null });
    expect(html).toContain("Week 3 of your routine");
    expect(html).toContain(pos.phase.title);
    expect(html).toContain("The first weeks are about building the habit"); // body (HTML-escaped)
    expect(html).toContain("From week 5");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('id="cxs-timeline"');
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    const line = timelineLineHtml("en", pos);
    expect(line).toContain("Week 3 of your routine");
    expect(line).toContain("cxs-timeline__line");
  });
  it("acknowledges the check-in answer when the landing carries one", () => {
    const pos = positionForWeek(phases(), 5)!;
    expect(timelineCardHtml({ locale: "en", position: pos, checkinAnswer: "unsure" })).toContain(
      "cxs-timeline__ack",
    );
    expect(timelineCardHtml({ locale: "en", position: pos })).not.toContain("cxs-timeline__ack");
  });
  it("educationTimelineText carries no HTML (the card escapes it)", () => {
    const pos = positionForWeek(phases(), 9)!;
    expect(educationTimelineText("en", pos)).not.toMatch(/</);
  });
});

// ── 5. Source pins ───────────────────────────────────────────────────────────

describe("wiring pins", () => {
  it("detail route: card behind growth.resultsTimeline, arm resolved for real customers, unsure landing leads with the card + education", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain("growth.resultsTimeline && isActive");
    expect(src).toContain("await resolveTimelineArm(contract)");
    expect(src).toMatch(/portalSession\.isPreview \|\| contract\.isDemo\s*\?\s*"shown"/);
    expect(src).toContain('checkinAnswer === "unsure"');
    expect(src).toContain("body = timelineHtml + educationHtml + body");
  });
  it("home route: compact line behind growth.resultsTimeline and the shown arm", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    expect(src).toContain("growth.resultsTimeline && !portalSession.isPreview");
    expect(src).toContain('if (arm === "shown")');
    expect(src).toContain("timelineLineHtml(locale, pos)");
  });
  it("cancel saves page: the phase sentence replaces the static EDUCATION copy only when resolved", () => {
    const pages = readSource("app/lib/cancel/pages.server.ts");
    expect(pages).toContain('educationTimelineText || t(locale, "cancel.saves.education.desc")');
    const route = readSource("app/routes/proxy.cancel.$id.$step.tsx");
    expect(route).toContain("educationTimelineTextFor(");
    expect(route).toContain('offers.some((o) => o.kind === "EDUCATION")');
  });
  it("routine_checkin template + Klaviyo metric registered; sweep hooked into the lifecycle sweep", () => {
    const templates = readSource("app/lib/notifications/templates.server.ts");
    expect(templates).toContain("routine_checkin: {");
    expect(templates).toContain('klaviyoMetric: "Cellexia Routine Check-in"');
    const engine = readSource("app/lib/lifecycle/engine.server.ts");
    expect(engine).toContain('import("./checkin.server")');
    const map = readSource("app/lib/klaviyo/events-map.server.ts");
    expect(map).toContain('"lifecycle.checkin_answered"');
  });
});
