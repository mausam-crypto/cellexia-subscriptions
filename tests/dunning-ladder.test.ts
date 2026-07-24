import { describe, expect, it } from "vitest";
import { addDaysTz, alignToPayday } from "~/lib/dates.server";
import { defaultFor } from "~/lib/settings/registry.server";
import {
  DECLINE_CODE_TABLE,
  categorizeDeclineCode,
} from "~/lib/dunning/decline-codes.server";

/**
 * Pure retry-ladder math, tested against the documented engine contract.
 *
 * The dunning engine (app/lib/dunning/engine.server.ts, handleSoftFailure)
 * does not export a pure scheduling helper — the computation below is a
 * faithful mirror of its documented algorithm, built from the SAME primitives
 * the engine uses (addDaysTz + alignToPayday) and driven by the SAME settings
 * defaults (settings registry key "dunning"):
 *
 *   nextOffsetDays = softRetryDays.at(priorFailures + 1)   // undefined ⇒ exhausted
 *   candidate      = addDaysTz(case.openedAt, nextOffsetDays, shopTz)
 *   nextRetryAt    = paydayAlign ? alignToPayday(candidate, tz, paydaysOfMonth,
 *                                                paydaySnapWindowDays) : candidate
 *
 * Offsets are anchored to the FIRST failure (case.openedAt), not the previous
 * retry. If the engine's algorithm changes, this mirror must change with it.
 */

const LONDON = "Europe/London";
const dunning = defaultFor("dunning");

interface LadderStep {
  date: Date;
  paydayAligned: boolean;
}

function nextRetry(
  openedAt: Date,
  priorFailures: number,
  settings = dunning,
  tz = LONDON,
): LadderStep | null {
  const offset = settings.softRetryDays.at(priorFailures + 1);
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

describe("settings defaults sanity", () => {
  it("registry defaults match the documented ladder", () => {
    expect(dunning.softRetryDays).toEqual([0, 3, 7, 14]);
    expect(dunning.paydayAlign).toBe(true);
    expect(dunning.paydaysOfMonth).toEqual([1, 15, 25]);
    expect(dunning.paydaySnapWindowDays).toBe(3);
    expect(dunning.emailLadderDays).toEqual([0, 3, 7]);
    expect(dunning.smsDay).toBe(8);
  });
});

describe("retry schedule from first failure (worked example, Europe/London)", () => {
  // The engine's own worked example: scheduled charge fails Mon 5 Jan 2026.
  const openedAt = new Date("2026-01-05T09:00:00Z"); // 09:00 GMT London

  it("retry #1: day-3 offset → Thu 8 Jan, no payday within the snap window", () => {
    const step = nextRetry(openedAt, 0);
    expect(step).not.toBeNull();
    expect(shopDay(step!.date)).toBe("2026-01-08");
    expect(step!.paydayAligned).toBe(false);
  });

  it("retry #2: day-7 offset → candidate Mon 12 Jan snaps to payday Thu 15 Jan", () => {
    const step = nextRetry(openedAt, 1);
    expect(step).not.toBeNull();
    // Candidate (before alignment) is day 7 = 12 Jan…
    expect(shopDay(addDaysTz(openedAt, 7, LONDON))).toBe("2026-01-12");
    // …and the 3-day probe window (12→15) finds the payday on the 15th.
    expect(shopDay(step!.date)).toBe("2026-01-15");
    expect(step!.paydayAligned).toBe(true);
  });

  it("retry #3: day-14 offset → Mon 19 Jan, no snap (probe 19–22 has no payday)", () => {
    const step = nextRetry(openedAt, 2);
    expect(step).not.toBeNull();
    expect(shopDay(step!.date)).toBe("2026-01-19");
    expect(step!.paydayAligned).toBe(false);
  });

  it("all offsets anchor to the FIRST failure, not the previous retry", () => {
    // Day 14 from 5 Jan is 19 Jan — NOT 15 Jan + 14 = 29 Jan.
    const step = nextRetry(openedAt, 2);
    expect(shopDay(step!.date)).not.toBe("2026-01-29");
    expect(shopDay(step!.date)).toBe("2026-01-19");
  });

  it("retries preserve the original charge's time of day", () => {
    const step = nextRetry(openedAt, 0);
    expect(step!.date.toISOString()).toBe("2026-01-08T09:00:00.000Z");
  });
});

describe("ladder exhaustion boundary", () => {
  const openedAt = new Date("2026-01-05T09:00:00Z");

  it("defaults give exactly 3 automatic retries; the 4th failure exhausts", () => {
    // priorFailures counts FAILED attempts excluding the one just processed.
    expect(nextRetry(openedAt, 0)).not.toBeNull(); // schedules retry #1
    expect(nextRetry(openedAt, 1)).not.toBeNull(); // schedules retry #2
    expect(nextRetry(openedAt, 2)).not.toBeNull(); // schedules retry #3
    expect(nextRetry(openedAt, 3)).toBeNull(); // retry #3 failed → exhausted
  });

  it("a single-rung ladder [0] exhausts on the very first failure", () => {
    const settings = { ...dunning, softRetryDays: [0] };
    expect(nextRetry(openedAt, 0, settings)).toBeNull();
  });

  it("exhaustion is exactly at softRetryDays.length - 1 prior failures", () => {
    const rungs = dunning.softRetryDays.length; // 4
    expect(nextRetry(openedAt, rungs - 2)).not.toBeNull();
    expect(nextRetry(openedAt, rungs - 1)).toBeNull();
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

    // Snap window 3 probes 29, 30, 31 Mar, 1 Apr → payday 1 Apr.
    const step = nextRetry(openedAt, 1, settings);
    expect(shopDay(step!.date)).toBe("2026-04-01");
    expect(step!.date.toISOString()).toBe("2026-04-01T09:00:00.000Z"); // still 10:00 BST
    expect(step!.paydayAligned).toBe(true);
  });

  it("paydayAlign=false leaves the raw offset date untouched", () => {
    const openedAt = new Date("2026-01-05T09:00:00Z");
    const settings = { ...dunning, paydayAlign: false };
    const step = nextRetry(openedAt, 1, settings);
    expect(shopDay(step!.date)).toBe("2026-01-12"); // no snap to the 15th
    expect(step!.paydayAligned).toBe(false);
  });

  it("an offset landing exactly on a payday is aligned without moving", () => {
    // Day 3 from 12 Jan = 15 Jan, itself a payday → no movement, not flagged.
    const openedAt = new Date("2026-01-12T09:00:00Z");
    const step = nextRetry(openedAt, 0);
    expect(shopDay(step!.date)).toBe("2026-01-15");
    expect(step!.paydayAligned).toBe(false);
  });

  it("alignment is idempotent (aligning an aligned date is stable)", () => {
    const candidate = new Date("2026-01-12T09:00:00Z");
    const once = alignToPayday(candidate, LONDON, dunning.paydaysOfMonth, 3);
    const twice = alignToPayday(once, LONDON, dunning.paydaysOfMonth, 3);
    expect(twice.getTime()).toBe(once.getTime());
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
});
