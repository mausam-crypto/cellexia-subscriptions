import { describe, expect, it } from "vitest";
import {
  CANCEL_REASON_KEYS,
  FINAL_DISCOUNT,
  MAX_SAVES_SHOWN,
  REASONS,
  SAVE_KINDS,
  reasonConfig,
  type SaveKind,
} from "~/lib/cancel/config.server";

describe("REASONS structural integrity", () => {
  it("covers every CANCEL_REASON_KEY exactly once", () => {
    const keys = REASONS.map((r) => r.key);
    expect(keys.sort()).toEqual([...CANCEL_REASON_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every reason has at least one save", () => {
    for (const reason of REASONS) {
      expect(
        reason.savesOrder.length,
        `${reason.key} must offer at least one save`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every savesOrder member is a valid SaveKind, with no duplicates", () => {
    for (const reason of REASONS) {
      for (const save of reason.savesOrder) {
        expect(
          SAVE_KINDS as readonly string[],
          `${reason.key} offers unknown save "${save}"`,
        ).toContain(save);
      }
      expect(
        new Set(reason.savesOrder).size,
        `${reason.key} lists a save twice`,
      ).toBe(reason.savesOrder.length);
    }
  });

  it("every reason has a cancel.* i18n key", () => {
    for (const reason of REASONS) {
      expect(reason.i18nKey.startsWith("cancel."), reason.i18nKey).toBe(true);
    }
  });
});

describe("surplus (TOO_MUCH_PRODUCT) never gets a discount", () => {
  const surplus = REASONS.find((r) => r.key === "TOO_MUCH_PRODUCT")!;

  it("leads with DELAY, then SKIP, DOWNSIZE, FREQUENCY — logistics fixes before anything else", () => {
    // v1.28.0: DELAY ("push my next order to the predicted run-out day",
    // P3.3) leads — it only renders when the churn model knows a run-out
    // day after the next charge, so SKIP keeps the slot otherwise. DOWNSIZE
    // (fewer units / smaller size / cheaper product) sits right after SKIP —
    // a structural fix for surplus that keeps every delivery at a lower
    // ARPU; it only renders when a genuinely cheaper option exists, so
    // FREQUENCY still fills the visible slice otherwise.
    expect(surplus.savesOrder[0]).toBe("DELAY");
    expect(surplus.savesOrder[1]).toBe("SKIP");
    expect(surplus.savesOrder[2]).toBe("DOWNSIZE");
    expect(surplus.savesOrder[3]).toBe("FREQUENCY");
  });

  it("contains no DISCOUNT anywhere in its savesOrder", () => {
    expect(surplus.savesOrder).not.toContain("DISCOUNT" satisfies SaveKind);
  });

  it("the visible slice (MAX_SAVES_SHOWN) is [DELAY, SKIP] — never a discount", () => {
    expect(surplus.savesOrder.slice(0, MAX_SAVES_SHOWN)).toEqual([
      "DELAY",
      "SKIP",
    ]);
  });
});

describe("discount gating", () => {
  it("DISCOUNT is only reachable via TOO_EXPENSIVE before the final offer", () => {
    const reasonsWithDiscount = REASONS.filter((r) =>
      r.savesOrder.includes("DISCOUNT"),
    ).map((r) => r.key);
    expect(reasonsWithDiscount).toEqual(["TOO_EXPENSIVE"]);
  });

  it("even for TOO_EXPENSIVE, the discount is not the lead offer", () => {
    const expensive = REASONS.find((r) => r.key === "TOO_EXPENSIVE")!;
    expect(expensive.savesOrder.indexOf("DISCOUNT")).toBeGreaterThan(0);
    // v1.28.0: the cheaper configuration (DOWNSIZE — not a discount) leads,
    // the reframe (pause) follows; the margin give-away is the fallback and
    // the LAST entry, so at the default cap it only shows when no cheaper
    // configuration exists.
    expect(expensive.savesOrder).toEqual(["DOWNSIZE", "PAUSE", "DISCOUNT"]);
    expect(expensive.savesOrder.at(-1)).toBe("DISCOUNT");
  });

  it("FINAL_DISCOUNT is a step-4 outcome marker, not a reason-matched save", () => {
    expect(FINAL_DISCOUNT).toBe("FINAL_DISCOUNT");
    expect(SAVE_KINDS as readonly string[]).not.toContain(FINAL_DISCOUNT);
    for (const reason of REASONS) {
      expect(
        reason.savesOrder as readonly string[],
        `${reason.key} must not offer the final discount as a regular save`,
      ).not.toContain(FINAL_DISCOUNT);
    }
  });

  it("unqualified reasons (OTHER) map to PAUSE then GIFT — no discount training", () => {
    const other = REASONS.find((r) => r.key === "OTHER")!;
    expect(other.savesOrder).toEqual(["PAUSE", "GIFT"]);
    expect(other.savesOrder).not.toContain("DISCOUNT" satisfies SaveKind);
  });
});

describe("reasonConfig lookup", () => {
  it("returns the config for every known key", () => {
    for (const key of CANCEL_REASON_KEYS) {
      const config = reasonConfig(key);
      expect(config).not.toBeNull();
      expect(config!.key).toBe(key);
    }
  });

  it("returns null for unknown / tampered / missing values", () => {
    expect(reasonConfig("PRICE_HIKE")).toBeNull(); // not a real key
    expect(reasonConfig("too_expensive")).toBeNull(); // case matters — form values are exact
    expect(reasonConfig("")).toBeNull();
    expect(reasonConfig(null)).toBeNull();
    expect(reasonConfig(undefined)).toBeNull();
  });
});

describe("flow-shape constants", () => {
  it("at most MAX_SAVES_SHOWN saves are surfaced, and every reason can fill step 3", () => {
    expect(MAX_SAVES_SHOWN).toBeGreaterThanOrEqual(1);
    for (const reason of REASONS) {
      expect(reason.savesOrder.slice(0, MAX_SAVES_SHOWN).length).toBeGreaterThan(0);
    }
  });
});
