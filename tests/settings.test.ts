import { describe, expect, it } from "vitest";
import {
  defaultFor,
  settingsSchemas,
  type SettingsKey,
  type SettingsValue,
} from "~/lib/settings/registry.server";

/**
 * Registry-only tests (no DB): every key must have a self-consistent default,
 * and a corrupted stored value must fall back to that default via safeParse —
 * exactly the logic getSetting() applies (app/lib/settings/settings.server.ts):
 *
 *   const parsed = settingsSchemas[key].safeParse(row.value);
 *   return parsed.success ? parsed.data : defaultFor(key);
 */

const KEYS = Object.keys(settingsSchemas) as SettingsKey[];

/** Mirror of getSetting()'s parse-or-default fallback, minus the DB read. */
function simulatedGetSetting<K extends SettingsKey>(
  key: K,
  stored: unknown,
): SettingsValue<K> {
  const parsed = settingsSchemas[key].safeParse(stored);
  return (parsed.success ? parsed.data : defaultFor(key)) as SettingsValue<K>;
}

const JUNK_VALUES: Array<[string, unknown]> = [
  ["a random string", "garbage"],
  ["a number", 42],
  ["null (JSON null in the DB)", null],
  ["an array", []],
  ["an unrelated object", { bogus: true }],
  ["a wrong-enum object", { mode: "NOT_A_REAL_MODE" }],
  ["a stringified object", "{}"],
];

describe("settings registry", () => {
  it("exposes the full expected key set", () => {
    expect(KEYS).toEqual(
      expect.arrayContaining([
        "launch",
        "discountStacking",
        "priceChangePolicy",
        "stockout",
        "dunning",
        "pause",
        "portal",
        "cadence",
        "consolidation",
        "notifications",
        "cancelFlow",
        "lifecycle",
        "winback",
        "alerts",
      ]),
    );
  });

  it("carries NO buyBox group — buy-box presentation is controlled where the widget reads it", () => {
    // savingsFormat / subscriptionListedFirst / showReassuranceCopy were
    // admin controls nothing consumed: the storefront widget reads the
    // theme-editor block settings (savings_format, preselect_subscription,
    // show_reassurance) and the published design presets. Live-looking dead
    // toggles are worse than no toggles — do not re-add the group without
    // wiring it into the payload the extension actually reads.
    expect(KEYS).not.toContain("buyBox");
  });

  for (const key of KEYS) {
    describe(`key "${key}"`, () => {
      it("has a default that its own schema accepts (round-trip)", () => {
        const def = defaultFor(key);
        const reparsed = settingsSchemas[key].safeParse(def);
        expect(
          reparsed.success,
          `defaultFor("${key}") must satisfy its own schema`,
        ).toBe(true);
        if (reparsed.success) expect(reparsed.data).toEqual(def);
      });

      it("default survives a JSON round-trip (Json column storage)", () => {
        const def = defaultFor(key);
        const stored: unknown = JSON.parse(JSON.stringify(def));
        expect(simulatedGetSetting(key, stored)).toEqual(def);
      });

      it("an absent value (undefined) yields the default", () => {
        expect(simulatedGetSetting(key, undefined)).toEqual(defaultFor(key));
      });

      it("defaultFor is stable across calls (no shared mutable state)", () => {
        const a = defaultFor(key);
        const b = defaultFor(key);
        expect(a).toEqual(b);
        expect(a).not.toBe(b); // fresh object each time — callers can't corrupt it
      });

      for (const [label, junk] of JUNK_VALUES) {
        it(`falls back cleanly to the default when stored value is ${label}`, () => {
          expect(simulatedGetSetting(key, junk)).toEqual(defaultFor(key));
        });
      }
    });
  }
});

describe("high-stakes defaults (policy sanity)", () => {
  it("promo codes are never allowed on renewals by default (golden rule 3)", () => {
    expect(defaultFor("discountStacking").allowPromoCodesOnRenewals).toBe(false);
  });

  it("dunning defaults are internally consistent", () => {
    const d = defaultFor("dunning");
    // Offsets from first failure must be strictly increasing, starting at 0.
    expect(d.softRetryDays[0]).toBe(0);
    for (let i = 1; i < d.softRetryDays.length; i++) {
      expect(d.softRetryDays[i]).toBeGreaterThan(d.softRetryDays[i - 1]);
    }
    // Paydays stay in the 1–28 range so every month has each payday.
    for (const p of d.paydaysOfMonth) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(28);
    }
    // The SMS lands after the last email rung — email-first escalation.
    expect(d.smsDay).toBeGreaterThan(Math.max(...d.emailLadderDays));
  });

  it("final cancel-flow offer is capped and rate-limited by default", () => {
    const c = defaultFor("cancelFlow");
    expect(c.finalOfferPct).toBeLessThanOrEqual(40);
    expect(c.finalOfferCooldownDays).toBeGreaterThanOrEqual(30);
  });
});
