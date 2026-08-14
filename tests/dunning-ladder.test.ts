import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addDaysTz, alignToPayday } from "~/lib/dates.server";
import { defaultFor, settingsSchemas } from "~/lib/settings/registry.server";
import { selectNextRetryOffsetDays } from "~/lib/dunning/ladder.server";
import {
  DECLINE_CODE_TABLE,
  categorizeDeclineCode,
} from "~/lib/dunning/decline-codes.server";

/**
 * Retry-ladder math, tested against the REAL rung-selection helper the
 * dunning engine uses (app/lib/dunning/ladder.server.ts —
 * selectNextRetryOffsetDays) plus the same payday-alignment primitives
 * (addDaysTz + alignToPayday) and the settings-registry defaults.
 *
 * Engine contract (handleSoftFailure):
 *
 *   nextOffsetDays = selectNextRetryOffsetDays(softRetryDays, openedAt, now, tz)
 *                    // first offset whose moment is still ahead of `now`;
 *                    // undefined ⇒ ladder exhausted
 *   candidate      = addDaysTz(case.openedAt, nextOffsetDays, shopTz)
 *   nextRetryAt    = paydayAlign ? alignToPayday(candidate, tz, paydaysOfMonth,
 *                                                paydaySnapWindowDays) : candidate
 *
 * Offsets are anchored to the FIRST failure (case.openedAt), not the previous
 * retry. Rungs are chosen by TIME, not by counting failed attempts, so manual
 * "Retry now", the 1-hour backup-card retry and payment-method-updated
 * immediate retries never consume configured rungs.
 */

const LONDON = "Europe/London";
const dunning = defaultFor("dunning");

interface LadderStep {
  date: Date;
  paydayAligned: boolean;
}

/** The engine's schedule step: rung selection + payday alignment. */
function nextRetry(
  openedAt: Date,
  now: Date,
  settings = dunning,
  tz = LONDON,
): LadderStep | null {
  const offset = selectNextRetryOffsetDays(
    settings.softRetryDays,
    openedAt,
    now,
    tz,
  );
  if (offset === undefined) return null; // ladder exhausted
  const candidate = addDaysTz(openedAt, offset, tz);
  if (!settings.paydayAlign) return { date: candidate, paydayAligned: false };
  const aligned = alignToPayday(
    candidate,
    tz,
    settings.paydaysOfMonth,
    settings.paydaySnapWindowDays,
  );
  return {
    date: aligned,
    paydayAligned: aligned.getTime() !== candidate.getTime(),
  };
}

function shopDay(d: Date, tz = LONDON): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function plusDays(base: Date, days: number, tz = LONDON): Date {
  return addDaysTz(base, days, tz);
}

describe("settings defaults sanity", () => {
  it("registry defaults match the documented ladder", () => {
    expect(dunning.softRetryDays).toEqual([0, 3, 7, 14]);
    expect(dunning.paydayAlign).toBe(true);
    expect(dunning.paydaysOfMonth).toEqual([1, 15, 25]);
    expect(dunning.paydaySnapWindowDays).toBe(3);
    expect(dunning.emailLadderDays).toEqual([0, 3, 7]);
    expect(dunning.smsDay).toBe(8);
  });

  it("softRetryDays must be strictly increasing (schema refine)", () => {
    // Validated through the registry: a misordered ladder is refused, so
    // getSetting falls back to the safe defaults instead of misbehaving.
    const bad = settingsSchemas.dunning.safeParse({
      ...dunning,
      softRetryDays: [0, 7, 3, 14],
    });
    expect(bad.success).toBe(false);
  });
});

describe("retry schedule from first failure (worked example, Europe/London)", () => {
  // The engine's own worked example: scheduled charge fails Mon 5 Jan 2026.
  const openedAt = new Date("2026-01-05T09:00:00Z"); // 09:00 GMT London

  it("retry #1: original failure at day 0 → day-3 offset → Thu 8 Jan, no snap", () => {
    const step = nextRetry(openedAt, openedAt);
    expect(step).not.toBeNull();
    expect(shopDay(step!.date)).toBe("2026-01-08");
    expect(step!.paydayAligned).toBe(false);
  });

  it("retry #2: failure on day 3 → day-7 candidate Mon 12 Jan snaps to payday Thu 15 Jan", () => {
    const step = nextRetry(openedAt, plusDays(openedAt, 3));
    expect(step).not.toBeNull();
    // Candidate (before alignment) is day 7 = 12 Jan…
    expect(shopDay(addDaysTz(openedAt, 7, LONDON))).toBe("2026-01-12");
    // …and the 3-day probe window (12→15) finds the payday on the 15th.
    expect(shopDay(step!.date)).toBe("2026-01-15");
    expect(step!.paydayAligned).toBe(true);
  });

  it("retry #3: failure on day 10 (the snapped payday) → day-14 → Mon 19 Jan, no snap", () => {
    const step = nextRetry(openedAt, plusDays(openedAt, 10));
    expect(step).not.toBeNull();
    expect(shopDay(step!.date)).toBe("2026-01-19");
    expect(step!.paydayAligned).toBe(false);
  });

  it("all offsets anchor to the FIRST failure, not the previous retry", () => {
    // Day 14 from 5 Jan is 19 Jan — NOT 15 Jan + 14 = 29 Jan.
    const step = nextRetry(openedAt, plusDays(openedAt, 10));
    expect(shopDay(step!.date)).not.toBe("2026-01-29");
    expect(shopDay(step!.date)).toBe("2026-01-19");
  });

  it("retries preserve the original charge's time of day", () => {
    const step = nextRetry(openedAt, openedAt);
    expect(step!.date.toISOString()).toBe("2026-01-08T09:00:00.000Z");
  });
});

describe("extra failed attempts never consume ladder rungs", () => {
  const openedAt = new Date("2026-01-05T09:00:00Z");

  it("an admin Retry-now failing on day 4 still leaves day-7 and day-14 rungs", () => {
    // Regardless of HOW MANY attempts have failed by day 4, the next rung is
    // the day-7 offset — time-anchored selection ignores attempt counts.
    const step = nextRetry(openedAt, plusDays(openedAt, 4));
    expect(shopDay(addDaysTz(openedAt, 7, LONDON))).toBe("2026-01-12");
    expect(shopDay(step!.date)).toBe("2026-01-15"); // day-7 rung (snapped)
  });

  it("the 1-hour backup retry failing on day 3 does not skip to day 14", () => {
    const now = new Date(plusDays(openedAt, 3).getTime() + 60 * 60 * 1000);
    const offset = selectNextRetryOffsetDays(
      dunning.softRetryDays,
      openedAt,
      now,
      LONDON,
    );
    expect(offset).toBe(7);
  });

  it("the selected retry is always strictly in the future", () => {
    for (const day of [0, 1, 2, 3, 5, 8, 13]) {
      const now = plusDays(openedAt, day);
      const offset = selectNextRetryOffsetDays(
        dunning.softRetryDays,
        openedAt,
        now,
        LONDON,
      );
      expect(offset).not.toBeUndefined();
      const candidate = addDaysTz(openedAt, offset!, LONDON);
      expect(candidate.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("ladder exhaustion boundary", () => {
  const openedAt = new Date("2026-01-05T09:00:00Z");

  it("defaults give exactly 3 automatic retries; the day-14 failure exhausts", () => {
    expect(nextRetry(openedAt, openedAt)).not.toBeNull(); // schedules retry #1
    expect(nextRetry(openedAt, plusDays(openedAt, 3))).not.toBeNull(); // #2
    expect(nextRetry(openedAt, plusDays(openedAt, 10))).not.toBeNull(); // #3
    expect(nextRetry(openedAt, plusDays(openedAt, 14))).toBeNull(); // exhausted
  });

  it("a single-rung ladder [0] exhausts on the very first failure", () => {
    const settings = { ...dunning, softRetryDays: [0] };
    expect(nextRetry(openedAt, openedAt, settings)).toBeNull();
  });

  it("a failure processed after every offset has passed exhausts immediately", () => {
    expect(nextRetry(openedAt, plusDays(openedAt, 30))).toBeNull();
  });
});

describe("payday alignment interplay", () => {
  it("snaps across a DST transition AND a month boundary", () => {
    // Case opens Sun 22 Mar 2026, 10:00 GMT. Day-7 offset lands Sun 29 Mar —
    // the spring-forward day (BST). Wall time is preserved by addDaysTz.
    const openedAt = new Date("2026-03-22T10:00:00Z");
    const settings = { ...dunning, paydaysOfMonth: [1] };
    const candidate = addDaysTz(openedAt, 7, LONDON);
    expect(candidate.toISOString()).toBe("2026-03-29T09:00:00.000Z"); // 10:00 BST

    // Failure on day 3 → day-7 rung; snap window 3 probes 29, 30, 31 Mar,
    // 1 Apr → payday 1 Apr.
    const step = nextRetry(openedAt, plusDays(openedAt, 3), settings);
    expect(shopDay(step!.date)).toBe("2026-04-01");
    expect(step!.date.toISOString()).toBe("2026-04-01T09:00:00.000Z"); // still 10:00 BST
    expect(step!.paydayAligned).toBe(true);
  });

  it("paydayAlign=false leaves the raw offset date untouched", () => {
    const openedAt = new Date("2026-01-05T09:00:00Z");
    const settings = { ...dunning, paydayAlign: false };
    const step = nextRetry(openedAt, plusDays(openedAt, 3), settings);
    expect(shopDay(step!.date)).toBe("2026-01-12"); // no snap to the 15th
    expect(step!.paydayAligned).toBe(false);
  });

  it("an offset landing exactly on a payday is aligned without moving", () => {
    // Day 3 from 12 Jan = 15 Jan, itself a payday → no movement, not flagged.
    const openedAt = new Date("2026-01-12T09:00:00Z");
    const step = nextRetry(openedAt, openedAt);
    expect(shopDay(step!.date)).toBe("2026-01-15");
    expect(step!.paydayAligned).toBe(false);
  });

  it("alignment is idempotent (aligning an aligned date is stable)", () => {
    const candidate = new Date("2026-01-12T09:00:00Z");
    const once = alignToPayday(candidate, LONDON, dunning.paydaysOfMonth, 3);
    const twice = alignToPayday(once, LONDON, dunning.paydaysOfMonth, 3);
    expect(twice.getTime()).toBe(once.getTime());
  });

  it("a snap past the next rung cannot make the following retry fire immediately", () => {
    // Rung gaps smaller than the snap window: [0, 2, 4, 8] with window 3.
    // Day-2 candidate snaps to day 5 (payday). The retry after the day-5
    // failure is selected by time — day 8, never the already-past day 4.
    const openedAt = new Date("2026-01-01T09:00:00Z");
    const settings = {
      ...dunning,
      softRetryDays: [0, 2, 4, 8],
      paydaysOfMonth: [6],
      paydaySnapWindowDays: 3,
    };
    const first = nextRetry(openedAt, openedAt, settings);
    expect(shopDay(first!.date)).toBe("2026-01-06"); // day-2 snapped to payday
    const afterSnapFailure = nextRetry(openedAt, first!.date, settings);
    expect(afterSnapFailure).not.toBeNull();
    expect(shopDay(afterSnapFailure!.date)).toBe("2026-01-09"); // day 8, future
    expect(
      afterSnapFailure!.date.getTime(),
    ).toBeGreaterThan(first!.date.getTime());
  });
});

describe("hard declines produce no retry", () => {
  it("every HARD / AUTH_REQUIRED code is non-retryable (the ladder never runs)", () => {
    // Engine contract: only category SOFT enters handleSoftFailure and thus
    // the softRetryDays ladder; HARD parks on AWAITING_CUSTOMER and
    // AUTH_REQUIRED on AWAITING_3DS — neither ever schedules a ladder retry.
    for (const row of DECLINE_CODE_TABLE) {
      if (row.category === "SOFT") continue;
      expect(row.retryable, `${row.code} must not be retryable`).toBe(false);
    }
  });

  it("spot checks: expired card and fraud never re-enter the ladder", () => {
    expect(categorizeDeclineCode("EXPIRED_PAYMENT_METHOD").retryable).toBe(false);
    expect(categorizeDeclineCode("FRAUD_SUSPECTED").retryable).toBe(false);
    expect(categorizeDeclineCode("AUTHENTICATION_ERROR").retryable).toBe(false);
  });

  it("unknown decline codes stay on the retry ladder (conservative default)", () => {
    expect(categorizeDeclineCode("NEVER_SEEN_BEFORE").retryable).toBe(true);
  });
});

describe("notification ladder math (emailLadderDays / smsDay)", () => {
  // Engine contract: email rung N is due when daysSinceOpen >= emailLadderDays[N]
  // and exactly N emails have been sent (emailsSent is the cursor).
  function emailRungDue(emailsSent: number, daysSinceOpen: number): boolean {
    const dueDay = dunning.emailLadderDays.at(emailsSent);
    return dueDay !== undefined && daysSinceOpen >= dueDay;
  }

  it("emails fire at days 0, 3 and 7 and then stop", () => {
    expect(emailRungDue(0, 0)).toBe(true); // payment_failed_1, immediately
    expect(emailRungDue(1, 2)).toBe(false); // too early for #2
    expect(emailRungDue(1, 3)).toBe(true); // payment_failed_2 at day 3
    expect(emailRungDue(2, 6)).toBe(false);
    expect(emailRungDue(2, 7)).toBe(true); // payment_failed_3 at day 7
    expect(emailRungDue(3, 365)).toBe(false); // ladder complete — never a 4th
  });

  it("exactly one SMS, at smsDay", () => {
    const smsDue = (smsSent: number, daysSinceOpen: number) =>
      smsSent === 0 && daysSinceOpen >= dunning.smsDay;
    expect(smsDue(0, 7)).toBe(false);
    expect(smsDue(0, 8)).toBe(true);
    expect(smsDue(1, 9)).toBe(false); // already sent — never repeats
  });

  it("engine source uses the persistent NotificationLog dedupe per rung", () => {
    // A crash between send and cursor write (or a second sweep instance) must
    // not re-send a rung — the engine checks NotificationLog first.
    const engineSource = readFileSync(
      fileURLToPath(
        new URL("../app/lib/dunning/engine.server.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(engineSource).toContain('path: ["vars", "dunning_dedupe"]');
    expect(engineSource).toContain("dunning_dedupe: dedupeKey");
  });
});

describe("cross-cycle case scoping (source contract)", () => {
  const engineSource = readFileSync(
    fileURLToPath(
      new URL("../app/lib/dunning/engine.server.ts", import.meta.url),
    ),
    "utf8",
  );

  it("ensureOpenCase supersedes an open case from an older billing cycle", () => {
    // The ladder anchors every offset to case.openedAt — reusing an old
    // cycle's case would compute every retry in the past and burn the whole
    // ladder in minutes.
    expect(engineSource).toContain('resolution: "SUPERSEDED"');
    expect(engineSource).toContain("dunning.case_superseded");
  });

  it("a success only resolves a case anchored to the same cycle", () => {
    expect(engineSource).toContain("caseCycleIndex(kase)");
    expect(engineSource).toMatch(
      /sameCycle = kaseCycle == null \|\| kaseCycle === attempt\.cycleIndex/,
    );
  });

  it("late failures for an already-succeeded cycle never open a case", () => {
    expect(engineSource).toContain('reason: "cycle_already_succeeded"');
  });

  it("the challenged path only reuses a case anchored to the attempt's own cycle", () => {
    // onBillingAttemptChallenged must never hijack an older cycle's open case
    // (cancelling its scheduled retry and inheriting its stale openedAt) — a
    // cross-cycle case falls through to ensureOpenCase's supersede, exactly
    // like the failure path. Behavior pinned by
    // tests/dunning-challenged-cross-cycle.test.ts.
    expect(engineSource).toMatch(
      /sameCycleCase \?\?\s*\(await ensureOpenCase\(attempt, "AUTH_REQUIRED", "WEBHOOK"\)\)/,
    );
  });
});
