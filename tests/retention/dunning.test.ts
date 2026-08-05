import { describe, expect, it } from "vitest";
import {
  MAX_RETRY_OFFSETS,
  MAX_TRANSIENT_STEP_FAILURES,
  applyRetryOffsets,
  cardExpiresBefore,
  categorizeDeclineCode,
  episodeCategory,
  episodeStrategy,
  isHighValueContract,
  isLiveEpisodeForFailure,
  nextLikelySalaryDate,
  parseDunningOverrides,
  snapRetryToLikelySalary,
  strategyFor,
  trailingStepErrors,
  transientBackoffMs,
} from "~/services/retention/dunning.server";
import type { DunningHistoryEntry } from "~/services/retention/dunning.server";
import { DECLINE_CATEGORIES } from "~/types/domain";
import type { DunningStep } from "~/types/domain";

function retrySteps(steps: DunningStep[]): DunningStep[] {
  return steps.filter((s) => s.action === "RETRY");
}

/** Cumulative day offsets at which each RETRY fires. */
function cumulativeRetryDays(steps: DunningStep[]): number[] {
  let cum = 0;
  const out: number[] = [];
  for (const s of steps) {
    cum += s.afterDays;
    if (s.action === "RETRY") out.push(cum);
  }
  return out;
}

describe("categorizeDeclineCode", () => {
  it("maps processor codes onto the seven categories", () => {
    expect(categorizeDeclineCode("insufficient_funds")).toBe(
      "INSUFFICIENT_FUNDS",
    );
    expect(categorizeDeclineCode("expired_card")).toBe("EXPIRED_CARD");
    expect(categorizeDeclineCode("card_declined")).toBe("GENERIC_DECLINE");
    expect(categorizeDeclineCode("generic_decline")).toBe("GENERIC_DECLINE");
    expect(categorizeDeclineCode("do_not_honor")).toBe("GENERIC_DECLINE");
    expect(categorizeDeclineCode("lost_card")).toBe("LOST_OR_STOLEN");
    expect(categorizeDeclineCode("stolen_card")).toBe("LOST_OR_STOLEN");
    expect(categorizeDeclineCode("pickup_card")).toBe("LOST_OR_STOLEN");
    expect(categorizeDeclineCode("processing_error")).toBe("PROCESSOR_ERROR");
    expect(categorizeDeclineCode("try_again_later")).toBe("PROCESSOR_ERROR");
    expect(categorizeDeclineCode("authentication_required")).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(categorizeDeclineCode("sca_required")).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(categorizeDeclineCode("invalid_account")).toBe("PERMANENT_FAILURE");
    expect(categorizeDeclineCode("permanent_failure")).toBe(
      "PERMANENT_FAILURE",
    );
  });

  it("is case-insensitive", () => {
    expect(categorizeDeclineCode("INSUFFICIENT_FUNDS")).toBe(
      "INSUFFICIENT_FUNDS",
    );
    expect(categorizeDeclineCode("Expired_Card")).toBe("EXPIRED_CARD");
  });

  it("defaults unknown and missing codes to GENERIC_DECLINE", () => {
    expect(categorizeDeclineCode(null)).toBe("GENERIC_DECLINE");
    expect(categorizeDeclineCode("")).toBe("GENERIC_DECLINE");
    expect(categorizeDeclineCode("some_new_mystery_code")).toBe(
      "GENERIC_DECLINE",
    );
  });
});

describe("strategyFor — per-category sequences", () => {
  it("returns a different sequence for every category", () => {
    for (let i = 0; i < DECLINE_CATEGORIES.length; i++) {
      for (let j = i + 1; j < DECLINE_CATEGORIES.length; j++) {
        const a = JSON.stringify(strategyFor(DECLINE_CATEGORIES[i], false));
        const b = JSON.stringify(strategyFor(DECLINE_CATEGORIES[j], false));
        expect(a).not.toBe(b);
      }
    }
  });

  it("INSUFFICIENT_FUNDS retries on days 3 / 5 / 7 with an email at each step", () => {
    const steps = strategyFor("INSUFFICIENT_FUNDS", false);
    expect(cumulativeRetryDays(steps)).toEqual([3, 5, 7]);
    const emails = steps.filter((s) => s.action === "EMAIL");
    expect(emails.length).toBeGreaterThanOrEqual(3);
  });

  it("GENERIC_DECLINE retries on days 2 / 4 / 8", () => {
    expect(cumulativeRetryDays(strategyFor("GENERIC_DECLINE", false))).toEqual([
      2, 4, 8,
    ]);
  });

  it("EXPIRED_CARD sends update email + SMS first, then a single retry", () => {
    const steps = strategyFor("EXPIRED_CARD", false);
    expect(steps[0].action).toBe("EMAIL");
    expect(steps.some((s) => s.action === "SMS")).toBe(true);
    expect(retrySteps(steps)).toHaveLength(1);
    // The single retry comes only after the update window (email + sms).
    const retryIdx = steps.findIndex((s) => s.action === "RETRY");
    const smsIdx = steps.findIndex((s) => s.action === "SMS");
    expect(retryIdx).toBeGreaterThan(smsIdx);
  });

  it("LOST_OR_STOLEN never retries and requests a new payment method immediately", () => {
    const steps = strategyFor("LOST_OR_STOLEN", false);
    expect(retrySteps(steps)).toHaveLength(0);
    expect(steps[0].action).toBe("EMAIL");
    expect(steps[0].afterDays).toBe(0);
  });

  it("PERMANENT_FAILURE never retries: grace then pause", () => {
    const steps = strategyFor("PERMANENT_FAILURE", false);
    expect(retrySteps(steps)).toHaveLength(0);
    expect(steps.some((s) => s.action === "PAUSE")).toBe(true);
  });

  it("PROCESSOR_ERROR retries quickly: +6h then +24h", () => {
    const steps = strategyFor("PROCESSOR_ERROR", false);
    expect(steps[0].action).toBe("RETRY");
    expect(steps[0].afterDays).toBe(0.25); // 6 hours
    const cum = cumulativeRetryDays(steps);
    expect(cum[0]).toBe(0.25);
    expect(cum[1]).toBe(1); // 24 hours cumulative
  });

  it("AUTHENTICATION_REQUIRED sends the authentication link before retrying", () => {
    const steps = strategyFor("AUTHENTICATION_REQUIRED", false);
    expect(steps[0].action).toBe("EMAIL");
    const firstRetry = steps.findIndex((s) => s.action === "RETRY");
    expect(firstRetry).toBeGreaterThan(0);
  });

  it("every strategy terminates with a PAUSE or CANCEL", () => {
    for (const category of DECLINE_CATEGORIES) {
      const steps = strategyFor(category, false);
      const last = steps[steps.length - 1];
      expect(["PAUSE", "CANCEL"]).toContain(last.action);
    }
  });
});

describe("strategyFor — high-value grace", () => {
  it("adds exactly one grace step before the first PAUSE/CANCEL", () => {
    for (const category of DECLINE_CATEGORIES) {
      const base = strategyFor(category, false);
      const high = strategyFor(category, true);
      expect(high).toHaveLength(base.length + 1);

      const baseTermIdx = base.findIndex(
        (s) => s.action === "PAUSE" || s.action === "CANCEL",
      );
      // The inserted step sits where the terminal step used to be…
      expect(high[baseTermIdx].action).toBe("EMAIL");
      expect(high[baseTermIdx].afterDays).toBeGreaterThan(0);
      // …and the original terminal step follows it.
      expect(high[baseTermIdx + 1].action).toBe(base[baseTermIdx].action);
    }
  });

  it("does not mutate the base strategy", () => {
    const before = JSON.stringify(strategyFor("GENERIC_DECLINE", false));
    strategyFor("GENERIC_DECLINE", true);
    expect(JSON.stringify(strategyFor("GENERIC_DECLINE", false))).toBe(before);
  });
});

describe("applyRetryOffsets / strategyFor with offsets", () => {
  it("re-bases RETRY steps onto the given cumulative days, keeping notices in place", () => {
    const base = strategyFor("GENERIC_DECLINE", false);
    const rebased = applyRetryOffsets(base, [3, 6]);
    expect(cumulativeRetryDays(rebased)).toEqual([3, 6]);
    // Non-retry steps keep their static cumulative positions.
    const staticNonRetry = (steps: DunningStep[]): Array<[string, number]> => {
      let cum = 0;
      const out: Array<[string, number]> = [];
      for (const s of steps) {
        cum += s.afterDays;
        if (s.action !== "RETRY") out.push([`${s.action}:${s.template ?? ""}`, cum]);
      }
      return out;
    };
    expect(staticNonRetry(rebased)).toEqual(staticNonRetry(base));
  });

  it("supports up to four retries via merchant overrides", () => {
    const rebased = applyRetryOffsets(strategyFor("GENERIC_DECLINE", false), [
      1, 3, 5, 7, 9, // 5 requested → capped at MAX_RETRY_OFFSETS
    ]);
    expect(cumulativeRetryDays(rebased)).toHaveLength(MAX_RETRY_OFFSETS);
  });

  it("never adds retries to categories that are never retried by design", () => {
    for (const category of ["LOST_OR_STOLEN", "PERMANENT_FAILURE"] as const) {
      const steps = strategyFor(category, false, undefined, [2, 4]);
      expect(retrySteps(steps)).toHaveLength(0);
    }
  });

  it("returns the strategy unchanged for null/empty/invalid offsets", () => {
    const base = strategyFor("INSUFFICIENT_FUNDS", false);
    expect(strategyFor("INSUFFICIENT_FUNDS", false, undefined, null)).toEqual(base);
    expect(applyRetryOffsets(base, [])).toEqual(base);
    expect(applyRetryOffsets(base, [0, -1, 99])).toEqual(base);
  });

  it("keeps the high-value grace step before the terminal step after re-basing", () => {
    const steps = strategyFor("GENERIC_DECLINE", true, 7, [1, 2]);
    const termIdx = steps.findIndex(
      (s) => s.action === "PAUSE" || s.action === "CANCEL",
    );
    expect(steps[termIdx - 1].template).toBe("dunning-grace-extension");
  });

  it("re-anchors trailing notices and the terminal PAUSE after offsets later than the static terminal day", () => {
    // INSUFFICIENT_FUNDS statically pauses on day 11; offsets 14/21/28 used
    // to merge as …PAUSE@11, RETRY@14, RETRY@21, RETRY@28 — every retry fired
    // against a paused contract and deterministically failed (zero recovery
    // from three configured retries).
    const rebased = applyRetryOffsets(
      strategyFor("INSUFFICIENT_FUNDS", false),
      [14, 21, 28],
    );
    expect(cumulativeRetryDays(rebased)).toEqual([14, 21, 28]);

    // Full cumulative timeline: every RETRY precedes the final notice and
    // the PAUSE, which keep their original relative gaps (+1, +4) after the
    // last retry.
    let cum = 0;
    const timeline = rebased.map((s) => {
      cum += s.afterDays;
      return [s.action, cum] as const;
    });
    expect(timeline).toEqual([
      ["EMAIL", 0],
      ["EMAIL", 3],
      ["EMAIL", 5],
      ["RETRY", 14],
      ["RETRY", 21],
      ["RETRY", 28],
      ["EMAIL", 29], // final notice: 28 + (8 − 7)
      ["PAUSE", 32], // terminal pause: 28 + (11 − 7)
    ]);
  });

  it("leaves trailing steps at their static positions when offsets end before the static last retry", () => {
    // GENERIC_DECLINE's last static retry is day 8; offsets [3, 6] end
    // earlier, so the final notice (day 10) and PAUSE (day 13) stay put.
    const rebased = applyRetryOffsets(strategyFor("GENERIC_DECLINE", false), [3, 6]);
    let cum = 0;
    const nonRetry: Array<[string, number]> = [];
    for (const s of rebased) {
      cum += s.afterDays;
      if (s.action !== "RETRY") nonRetry.push([s.action, cum]);
    }
    expect(nonRetry).toEqual([
      ["EMAIL", 0],
      ["EMAIL", 4],
      ["EMAIL", 10],
      ["PAUSE", 13],
    ]);
  });
});

describe("parseDunningOverrides", () => {
  it("keeps only whole days in [1..30], deduped, ascending, max four", () => {
    const parsed = parseDunningOverrides({
      INSUFFICIENT_FUNDS: [7, 3, 3, 5],
      GENERIC_DECLINE: [1, 2, 3, 4, 5, 6],
      EXPIRED_CARD: [0, 31, 2.5, "x"],
      PROCESSOR_ERROR: "not-an-array",
    });
    expect(parsed.INSUFFICIENT_FUNDS).toEqual([3, 5, 7]);
    expect(parsed.GENERIC_DECLINE).toEqual([1, 2, 3, 4]);
    expect(parsed.EXPIRED_CARD).toBeUndefined();
    expect(parsed.PROCESSOR_ERROR).toBeUndefined();
  });

  it("accepts numeric strings and rejects garbage roots", () => {
    expect(parseDunningOverrides({ GENERIC_DECLINE: ["3", "5"] }).GENERIC_DECLINE).toEqual([3, 5]);
    expect(parseDunningOverrides(null)).toEqual({});
    expect(parseDunningOverrides([1, 2, 3])).toEqual({});
    expect(parseDunningOverrides("nope")).toEqual({});
  });
});

describe("episodeCategory — mid-episode category pinning", () => {
  const history: DunningHistoryEntry[] = [
    { at: "t0", type: "EPISODE_START", declineCategory: "GENERIC_DECLINE" },
    { at: "t1", type: "STEP", stepIndex: 0, action: "EMAIL" },
    { at: "t2", type: "RESOLVED" },
    { at: "t3", type: "EPISODE_START", declineCategory: "INSUFFICIENT_FUNDS" },
    { at: "t4", type: "STEP", stepIndex: 0, action: "EMAIL" },
    // Mid-episode failure with a DIFFERENT code — must NOT re-index the
    // step counter into another category's strategy.
    { at: "t5", type: "RETRY_FAILED", declineCategory: "PROCESSOR_ERROR" },
  ];

  it("pins the category recorded at the CURRENT episode's start", () => {
    expect(episodeCategory(history, "PROCESSOR_ERROR")).toBe(
      "INSUFFICIENT_FUNDS",
    );
  });

  it("falls back for legacy histories without an EPISODE_START", () => {
    expect(
      episodeCategory(
        [{ at: "t0", type: "STEP", stepIndex: 0, action: "EMAIL" }],
        "EXPIRED_CARD",
      ),
    ).toBe("EXPIRED_CARD");
    expect(episodeCategory([], "GENERIC_DECLINE")).toBe("GENERIC_DECLINE");
  });
});

describe("isLiveEpisodeForFailure — grace-pause handoff opens a FRESH episode", () => {
  const soon = new Date("2026-08-05T00:00:00Z");

  it("treats the pause-resume handoff (FINAL_NOTICE, nextRetryAt null) as NOT live", () => {
    // OLD BUG: the post-resume billing failure landed in the in-episode
    // branch, stepsExecutedInEpisode counted the ENTIRE prior episode, and
    // the next queue pass wrote EXHAUSTED — a full cycle with zero retries
    // and zero recovery emails for every grace-pause-resumed contract.
    expect(isLiveEpisodeForFailure("FINAL_NOTICE", null)).toBe(false);
  });

  it("keeps every genuinely live shape in-episode", () => {
    expect(isLiveEpisodeForFailure("RETRYING", soon)).toBe(true);
    expect(isLiveEpisodeForFailure("RETRYING", null)).toBe(true);
    expect(isLiveEpisodeForFailure("GRACE", null)).toBe(true);
    expect(isLiveEpisodeForFailure("FINAL_NOTICE", soon)).toBe(true);
  });

  it("non-active phases are never live", () => {
    for (const phase of ["NONE", "RESOLVED", "EXHAUSTED", "PRE_DUNNING"]) {
      expect(isLiveEpisodeForFailure(phase, soon)).toBe(false);
      expect(isLiveEpisodeForFailure(phase, null)).toBe(false);
    }
  });
});

describe("episodeStrategy — the schedule is pinned at EPISODE_START", () => {
  const pinned: DunningStep[] = [
    { afterDays: 0, action: "EMAIL", template: "dunning-generic-notice" },
    { afterDays: 2, action: "RETRY" },
    { afterDays: 2, action: "RETRY" },
    { afterDays: 0, action: "EMAIL", template: "dunning-generic-update" },
    { afterDays: 4, action: "RETRY" },
    { afterDays: 2, action: "EMAIL", template: "dunning-generic-final" },
    { afterDays: 3, action: "PAUSE" },
  ];
  const reshaped: DunningStep[] = [
    { afterDays: 0, action: "EMAIL", template: "dunning-generic-notice" },
    { afterDays: 5, action: "RETRY" },
    { afterDays: 5, action: "EMAIL", template: "dunning-generic-final" },
    { afterDays: 3, action: "PAUSE" },
  ];

  it("returns the CURRENT episode's pinned steps, not the freshly rebuilt strategy", () => {
    // OLD BUG: the first learned DUNNING_RECOVERY version (no merchant action
    // at all) reshaped the rebuilt array mid-episode; an episode 5 steps in
    // indexed past the new 4-step array and was written EXHAUSTED — the final
    // notice and the terminal PAUSE never ran.
    const history: DunningHistoryEntry[] = [
      { at: "t0", type: "EPISODE_START", declineCategory: "GENERIC_DECLINE", steps: pinned },
      { at: "t1", type: "STEP", stepIndex: 0, action: "EMAIL" },
    ];
    expect(episodeStrategy(history, reshaped)).toEqual(pinned);
  });

  it("uses the MOST RECENT episode's pin across resolved episodes", () => {
    const history: DunningHistoryEntry[] = [
      { at: "t0", type: "EPISODE_START", declineCategory: "GENERIC_DECLINE", steps: reshaped },
      { at: "t1", type: "RESOLVED" },
      { at: "t2", type: "EPISODE_START", declineCategory: "GENERIC_DECLINE", steps: pinned },
    ];
    expect(episodeStrategy(history, reshaped)).toEqual(pinned);
  });

  it("falls back to the rebuilt strategy for legacy histories without a pin", () => {
    const legacy: DunningHistoryEntry[] = [
      { at: "t0", type: "EPISODE_START", declineCategory: "GENERIC_DECLINE" },
      { at: "t1", type: "STEP", stepIndex: 0, action: "EMAIL" },
    ];
    expect(episodeStrategy(legacy, reshaped)).toEqual(reshaped);
    expect(episodeStrategy([], reshaped)).toEqual(reshaped);
    expect(
      episodeStrategy(
        [{ at: "t0", type: "EPISODE_START", steps: [] }],
        reshaped,
      ),
    ).toEqual(reshaped);
  });
});

describe("transient failure containment", () => {
  it("counts only trailing STEP_ERROR entries", () => {
    const history: DunningHistoryEntry[] = [
      { at: "t0", type: "STEP_ERROR" },
      { at: "t1", type: "STEP", stepIndex: 0, action: "EMAIL" },
      { at: "t2", type: "STEP_ERROR" },
      { at: "t3", type: "STEP_ERROR" },
    ];
    expect(trailingStepErrors(history)).toBe(2);
    expect(trailingStepErrors([])).toBe(0);
  });

  it("backs off exponentially, capped at 24h", () => {
    expect(transientBackoffMs(1)).toBe(1 * 60 * 60 * 1000);
    expect(transientBackoffMs(2)).toBe(2 * 60 * 60 * 1000);
    expect(transientBackoffMs(3)).toBe(4 * 60 * 60 * 1000);
    expect(transientBackoffMs(6)).toBe(24 * 60 * 60 * 1000);
    expect(transientBackoffMs(50)).toBe(24 * 60 * 60 * 1000);
  });

  it("caps consecutive transient failures at a finite episode length", () => {
    expect(MAX_TRANSIENT_STEP_FAILURES).toBeGreaterThan(1);
    expect(MAX_TRANSIENT_STEP_FAILURES).toBeLessThanOrEqual(10);
  });
});

describe("nextLikelySalaryDate", () => {
  it("snaps forward to the 15th within a month", () => {
    const d = nextLikelySalaryDate(new Date(Date.UTC(2026, 0, 5)));
    expect(d.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("moves to the 1st of the next month after the 15th", () => {
    const d = nextLikelySalaryDate(new Date(Date.UTC(2026, 0, 20)));
    expect(d.toISOString().slice(0, 10)).toBe("2026-02-01");
  });

  it("is strictly after the input date", () => {
    const d = nextLikelySalaryDate(new Date(Date.UTC(2026, 0, 15)));
    expect(d.toISOString().slice(0, 10)).toBe("2026-02-01");
  });

  it("rolls over the year end", () => {
    const d = nextLikelySalaryDate(new Date(Date.UTC(2026, 11, 20)));
    expect(d.toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("snapRetryToLikelySalary", () => {
  it("snaps a nearby candidate to the day after payday", () => {
    const from = new Date(Date.UTC(2026, 0, 10));
    const candidate = new Date(Date.UTC(2026, 0, 13)); // payday 15th is close
    const snapped = snapRetryToLikelySalary(candidate, from);
    expect(snapped.toISOString().slice(0, 10)).toBe("2026-01-16");
  });

  it("leaves a distant candidate unchanged", () => {
    const from = new Date(Date.UTC(2026, 0, 2));
    const candidate = new Date(Date.UTC(2026, 0, 5)); // payday 15th is far
    const snapped = snapRetryToLikelySalary(candidate, from);
    expect(snapped.toISOString().slice(0, 10)).toBe("2026-01-05");
  });
});

describe("cardExpiresBefore", () => {
  it("a card is valid through the end of its expiry month", () => {
    // Card 12/2026 is valid until 2027-01-01T00:00Z.
    expect(
      cardExpiresBefore(12, 2026, new Date(Date.UTC(2026, 11, 15))),
    ).toBe(false);
    expect(cardExpiresBefore(12, 2026, new Date(Date.UTC(2027, 0, 2)))).toBe(
      true,
    );
  });

  it("detects expiry before next billing + lead window", () => {
    // Card 07/2026, billing + lead lands mid-August 2026.
    expect(cardExpiresBefore(7, 2026, new Date(Date.UTC(2026, 7, 15)))).toBe(
      true,
    );
    // Card 09/2026 outlives that window.
    expect(cardExpiresBefore(9, 2026, new Date(Date.UTC(2026, 7, 15)))).toBe(
      false,
    );
  });
});

describe("isHighValueContract", () => {
  it("uses paid-to-date and expected LTV thresholds", () => {
    expect(
      isHighValueContract({ totalRevenueCents: 30_000, expectedLtvCents: null }),
    ).toBe(true);
    expect(
      isHighValueContract({ totalRevenueCents: 0, expectedLtvCents: 70_000 }),
    ).toBe(true);
    expect(
      isHighValueContract({ totalRevenueCents: 5_000, expectedLtvCents: 10_000 }),
    ).toBe(false);
  });
});
