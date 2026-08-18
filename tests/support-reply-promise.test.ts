import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Support reply promise (v1.29.0) — "A human replies within 30 minutes,
 * 24/7." replaces Stage C's `support.slaBusinessDays`.
 *
 * Pins:
 *  - the model: replyWithinValue (int ≥ 1) + replyWithinUnit
 *    (minutes | hours | business_days) + alwaysOn (24/7), default 30 / minutes
 *    / true; per-unit ceilings; business_days is never 24/7;
 *  - supportReplyPromise() is the ONE sentence: every unit, singular/plural,
 *    the 24/7 variant, and the {n} substitution;
 *  - quiet migration: a stored settings object that still carries
 *    slaBusinessDays and no replyWithin* key parses (schema tolerates the old
 *    key) AND resolves as { value, unit: business_days, alwaysOn: false } —
 *    through the schema (getSetting path) and the pure resolver alike; once
 *    a replyWithin* key exists the legacy key is ignored;
 *  - the URL codec the toast rides on round-trips and rejects tampering;
 *  - every consumer uses the helper: no stray "business day" / "24/7"
 *    literal outside the helper's own keys in the customer-facing sources
 *    and en.json (the obsolete sla_* / support_sent_one|other /
 *    support_pending|hold_one|other keys are gone from every catalog).
 */

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: vi.fn() }));

import {
  DEFAULT_REPLY_PROMISE,
  EMPTY_SUPPORT_CHANNELS,
  REPLY_WITHIN_MAX,
  resolveReplyPromise,
  resolveSupportChannels,
  type ReplyPromise,
} from "~/lib/support/channels.server";
import {
  parseReplyPromiseParams,
  readReplyPromise,
  replyPromiseKey,
  replyPromiseParams,
  supportReplyPromise,
} from "~/lib/support/reply-promise.server";
import { defaultFor, settingsSchemas } from "~/lib/settings/registry.server";
import { locales } from "~/lib/i18n/locales";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

const P = (value: number, unit: ReplyPromise["unit"], alwaysOn: boolean): ReplyPromise => ({
  value,
  unit,
  alwaysOn,
});

describe("supportReplyPromise — the one sentence", () => {
  it("default: 30 minutes, 24/7", () => {
    expect(supportReplyPromise("en", EMPTY_SUPPORT_CHANNELS)).toBe(
      "A human replies within 30 minutes, 24/7.",
    );
    expect(supportReplyPromise("en", DEFAULT_REPLY_PROMISE)).toBe(
      "A human replies within 30 minutes, 24/7.",
    );
    expect(supportReplyPromise("en", null)).toBe("A human replies within 30 minutes, 24/7.");
  });

  it("every unit × plural × alwaysOn variant", () => {
    const cases: Array<[ReplyPromise, string]> = [
      [P(1, "minutes", true), "A human replies within 1 minute, 24/7."],
      // Not 24/7: the sentence NAMES business days — the SLA job skips
      // weekend time, so the customer must not read a stronger promise.
      [P(1, "minutes", false), "A human replies within 1 minute on business days."],
      [P(45, "minutes", false), "A human replies within 45 minutes on business days."],
      [P(1, "hours", true), "A human replies within 1 hour, 24/7."],
      [P(2, "hours", true), "A human replies within 2 hours, 24/7."],
      [P(1, "hours", false), "A human replies within 1 hour on business days."],
      [P(4, "hours", false), "A human replies within 4 hours on business days."],
      [P(1, "business_days", false), "A human replies within 1 business day."],
      [P(2, "business_days", false), "A human replies within 2 business days."],
      // business days are never 24/7 — the flag is ignored in the copy.
      [P(3, "business_days", true), "A human replies within 3 business days."],
    ];
    for (const [promise, sentence] of cases) {
      expect(supportReplyPromise("en", promise), JSON.stringify(promise)).toBe(sentence);
      expect(supportReplyPromise("en", { replyWithin: promise })).toBe(sentence);
    }
  });

  it("every key the helper can pick exists in en.json with {n}", () => {
    const seen = new Set<string>();
    for (const unit of ["minutes", "hours", "business_days"] as const) {
      for (const value of [1, 2]) {
        for (const alwaysOn of [true, false]) {
          seen.add(replyPromiseKey(P(value, unit, alwaysOn)));
        }
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "portal.support.reply_promise.minutes_one",
        "portal.support.reply_promise.minutes_other",
        "portal.support.reply_promise.minutes_one_always",
        "portal.support.reply_promise.minutes_other_always",
        "portal.support.reply_promise.hours_one",
        "portal.support.reply_promise.hours_other",
        "portal.support.reply_promise.hours_one_always",
        "portal.support.reply_promise.hours_other_always",
        "portal.support.reply_promise.business_days_one",
        "portal.support.reply_promise.business_days_other",
      ].sort(),
    );
    for (const key of seen) {
      expect(locales.en[key], key).toContain("{n}");
    }
  });

  it("falls back to English for a locale without the key yet (never the raw key)", () => {
    // Whatever the translation pass has done, the sentence is never a key.
    expect(supportReplyPromise("fr", DEFAULT_REPLY_PROMISE)).not.toContain("reply_promise");
  });
});

describe("resolveReplyPromise — model, defaults, legacy read", () => {
  it("defaults to 30 minutes 24/7 for empty / malformed input", () => {
    const dflt = { value: 30, unit: "minutes", alwaysOn: true };
    expect(resolveReplyPromise(undefined)).toEqual(dflt);
    expect(resolveReplyPromise({})).toEqual(dflt);
    expect(resolveReplyPromise({ replyWithinValue: "30" })).toEqual(dflt);
    expect(resolveReplyPromise({ replyWithinUnit: "days" })).toEqual(dflt);
    expect(resolveReplyPromise({ replyWithinValue: 0 })).toEqual(dflt);
    expect(resolveReplyPromise({ replyWithinValue: 99_999 })).toEqual(dflt);
  });

  it("reads the new keys; per-unit ceilings; business_days is never 24/7", () => {
    expect(
      resolveReplyPromise({ replyWithinValue: 2, replyWithinUnit: "hours", alwaysOn: false }),
    ).toEqual({ value: 2, unit: "hours", alwaysOn: false });
    expect(
      resolveReplyPromise({ replyWithinValue: 3, replyWithinUnit: "business_days", alwaysOn: true }),
    ).toEqual({ value: 3, unit: "business_days", alwaysOn: false });
    // Over the unit ceiling ⇒ 1 for that unit (never a promise past the ceiling).
    expect(
      resolveReplyPromise({ replyWithinValue: 31, replyWithinUnit: "business_days" }),
    ).toEqual({ value: 1, unit: "business_days", alwaysOn: false });
    expect(REPLY_WITHIN_MAX).toEqual({ minutes: 10_080, hours: 720, business_days: 30 });
  });

  it("legacy slaBusinessDays with no replyWithin* ⇒ business days, not 24/7", () => {
    expect(resolveReplyPromise({ slaBusinessDays: 1 })).toEqual({
      value: 1,
      unit: "business_days",
      alwaysOn: false,
    });
    expect(resolveReplyPromise({ slaBusinessDays: 3, hoursNote: "Mon–Fri" })).toEqual({
      value: 3,
      unit: "business_days",
      alwaysOn: false,
    });
    // Once a new key is stored the legacy key is ignored.
    expect(
      resolveReplyPromise({ slaBusinessDays: 3, replyWithinValue: 30, replyWithinUnit: "minutes", alwaysOn: true }),
    ).toEqual({ value: 30, unit: "minutes", alwaysOn: true });
    // A malformed legacy value is not a promise either.
    expect(resolveReplyPromise({ slaBusinessDays: 0 })).toEqual(DEFAULT_REPLY_PROMISE);
    expect(resolveSupportChannels({ slaBusinessDays: 2 }, null).replyWithin).toEqual({
      value: 2,
      unit: "business_days",
      alwaysOn: false,
    });
  });
});

describe("registry: settings.support carries the model and tolerates the legacy key", () => {
  it("defaults + schema shape", () => {
    const d = defaultFor("support");
    expect(d.replyWithinValue).toBe(30);
    expect(d.replyWithinUnit).toBe("minutes");
    expect(d.alwaysOn).toBe(true);
    expect("slaBusinessDays" in d).toBe(false);
    expect(settingsSchemas.support.safeParse({ replyWithinUnit: "days" }).success).toBe(false);
    expect(settingsSchemas.support.safeParse({ replyWithinValue: 0 }).success).toBe(false);
    expect(settingsSchemas.support.safeParse({ replyWithinValue: 2.5 }).success).toBe(false);
  });

  it("per-unit ceiling is enforced at save time (path replyWithinValue)", () => {
    const tooManyDays = settingsSchemas.support.safeParse({
      replyWithinValue: 31,
      replyWithinUnit: "business_days",
    });
    expect(tooManyDays.success).toBe(false);
    if (!tooManyDays.success) {
      expect(tooManyDays.error.issues[0].path).toEqual(["replyWithinValue"]);
    }
    expect(
      settingsSchemas.support.safeParse({ replyWithinValue: 721, replyWithinUnit: "hours" }).success,
    ).toBe(false);
    expect(
      settingsSchemas.support.safeParse({ replyWithinValue: 720, replyWithinUnit: "hours" }).success,
    ).toBe(true);
    expect(
      settingsSchemas.support.safeParse({ replyWithinValue: 10_080, replyWithinUnit: "minutes" }).success,
    ).toBe(true);
  });

  it("a stored Stage C row still parses AND reads as its business-day promise (getSetting path)", () => {
    const stored = {
      email: "care@cellexialabs.com",
      replyTo: "",
      whatsapp: "",
      chatUrl: "",
      hoursNote: "Mon–Fri 9–17",
      slaBusinessDays: 2,
      requestsPerHour: 3,
    };
    const parsed = settingsSchemas.support.parse(stored);
    // The field defaults must NOT mask the legacy value: the parse itself
    // performs the quiet read so getSetting → resolver agree.
    expect(parsed.replyWithinValue).toBe(2);
    expect(parsed.replyWithinUnit).toBe("business_days");
    expect(parsed.alwaysOn).toBe(false);
    expect(parsed.slaBusinessDays).toBe(2);
    expect(resolveReplyPromise(parsed)).toEqual({ value: 2, unit: "business_days", alwaysOn: false });
    // A row already migrated by a save keeps its own values.
    const saved = settingsSchemas.support.parse({
      ...stored,
      slaBusinessDays: undefined,
      replyWithinValue: 30,
      replyWithinUnit: "minutes",
      alwaysOn: true,
    });
    expect(resolveReplyPromise(saved)).toEqual({ value: 30, unit: "minutes", alwaysOn: true });
  });
});

describe("URL codec (toast) and payload read-back", () => {
  it("round-trips value / unit / 24-7 and rejects tampering", () => {
    for (const p of [
      P(30, "minutes", true),
      P(2, "hours", false),
      P(1, "business_days", false),
    ]) {
      const params = new URLSearchParams(replyPromiseParams({ replyWithin: p }));
      expect(parseReplyPromiseParams(params)).toEqual(p);
    }
    expect(replyPromiseParams(P(30, "minutes", true))).toEqual({ sla: "30", slau: "m", sla247: "1" });
    expect(replyPromiseParams(P(2, "business_days", true))).toEqual({ sla: "2", slau: "d" });
    expect(parseReplyPromiseParams(new URLSearchParams("sla=2"))).toBeNull();
    expect(parseReplyPromiseParams(new URLSearchParams("sla=999&slau=d"))).toBeNull();
    expect(parseReplyPromiseParams(new URLSearchParams("sla=1&slau=x"))).toBeNull();
    expect(parseReplyPromiseParams(new URLSearchParams("sla=1.5&slau=h"))).toBeNull();
    // 24/7 can never be claimed for business days through the URL.
    expect(parseReplyPromiseParams(new URLSearchParams("sla=1&slau=d&sla247=1"))).toEqual(
      P(1, "business_days", false),
    );
  });

  it("readReplyPromise accepts the payload shape only", () => {
    expect(readReplyPromise({ value: 30, unit: "minutes", alwaysOn: true })).toEqual(
      P(30, "minutes", true),
    );
    expect(readReplyPromise({ value: 2, unit: "business_days", alwaysOn: true })).toEqual(
      P(2, "business_days", false),
    );
    expect(readReplyPromise(null)).toBeNull();
    expect(readReplyPromise(2)).toBeNull();
    expect(readReplyPromise({ value: "2", unit: "hours" })).toBeNull();
    expect(readReplyPromise({ value: 2, unit: "weeks" })).toBeNull();
  });
});

describe("every consumer goes through the helper", () => {
  const CONSUMERS = [
    "app/lib/support/portal-card.server.ts",
    "app/lib/portal/layout.server.ts",
    "app/lib/cancel/pages.server.ts",
    "app/routes/proxy.cancel.$id.$step.tsx",
    "app/routes/proxy.api.$action.tsx",
    "app/lib/cancel/engine.server.ts",
    "app/lib/support/request.server.ts",
  ];

  it("no consumer spells the promise itself or reads slaBusinessDays", () => {
    for (const rel of CONSUMERS) {
      const text = src(rel);
      expect(text, rel).not.toMatch(/business[ _-]?days?\b(?!_)/i);
      expect(text, rel).not.toContain("24/7");
      expect(text, rel).not.toContain("slaBusinessDays");
      expect(text, rel).not.toContain("sla_one");
      expect(text, rel).not.toContain("support_sent_one");
      expect(text, rel).not.toContain("support_pending_one");
    }
    // The four surfaces that render the sentence import the helper.
    for (const rel of [
      "app/lib/support/portal-card.server.ts",
      "app/lib/portal/layout.server.ts",
      "app/lib/cancel/pages.server.ts",
      "app/routes/proxy.cancel.$id.$step.tsx",
    ]) {
      expect(src(rel), rel).toContain("supportReplyPromise(");
    }
    // The toast writer carries the promise with the codec, not a bare number.
    expect(src("app/routes/proxy.api.$action.tsx")).toContain("replyPromiseParams(result)");
    // The admin Settings section exposes the three fields and no legacy field.
    const settings = src("app/routes/app.settings.tsx");
    expect(settings).toContain('path: "replyWithinValue"');
    expect(settings).toContain('path: "replyWithinUnit"');
    expect(settings).toContain('path: "alwaysOn"');
    expect(settings).not.toContain('path: "slaBusinessDays"');
  });

  it("en.json: the promise lives only in the reply_promise keys; the composed keys take {promise}; obsolete keys are gone from every catalog", () => {
    const en = locales.en;
    const offenders = Object.entries(en).filter(
      ([key, value]) =>
        !key.startsWith("portal.support.reply_promise.") &&
        (/business day/i.test(value) || value.includes("24/7")),
    );
    expect(offenders.map(([k]) => k)).toEqual([]);
    for (const key of [
      "portal.toast.support_sent_promise",
      "cancel.saved.support_pending",
      "cancel.saved.support_hold",
    ]) {
      expect(en[key], key).toContain("{promise}");
    }
    expect(en["cancel.saved.support_hold"]).toContain("{date}");
    const obsolete = [
      "portal.support.sla_one",
      "portal.support.sla_other",
      "portal.toast.support_sent_one",
      "portal.toast.support_sent_other",
      "cancel.saves.support.sla_one",
      "cancel.saves.support.sla_other",
      "cancel.saved.support_pending_one",
      "cancel.saved.support_pending_other",
      "cancel.saved.support_hold_one",
      "cancel.saved.support_hold_other",
    ];
    for (const [code, catalog] of Object.entries(locales)) {
      for (const key of obsolete) {
        expect(key in catalog, `${code} still has ${key}`).toBe(false);
      }
    }
  });
});
