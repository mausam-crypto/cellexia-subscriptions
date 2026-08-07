import { describe, expect, it } from "vitest";
import {
  addDaysTz,
  addWeeksTz,
  alignToPayday,
  isDueNow,
  isSameShopDay,
} from "~/lib/dates.server";

const LONDON = "Europe/London";
const HOUR_MS = 60 * 60 * 1000;

/** Calendar day of an instant in a timezone, as "YYYY-MM-DD" (en-CA format). */
function shopDay(d: Date, tz = LONDON): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Europe/London 2026 DST transitions:
//   spring forward: Sun 29 Mar 2026, 01:00 UTC (GMT → BST, UTC+1)
//   fall back:      Sun 25 Oct 2026, 01:00 UTC (BST → GMT)

describe("addWeeksTz across DST boundaries (Europe/London)", () => {
  it("keeps the local wall-clock time across the March spring-forward", () => {
    // Wed 25 Mar, 09:00 GMT (= 09:00 London). +1 week lands in BST.
    const base = new Date("2026-03-25T09:00:00Z");
    const result = addWeeksTz(base, 1, LONDON);

    // Wall clock stays 09:00 London → UTC shifts back one hour.
    expect(result.toISOString()).toBe("2026-04-01T08:00:00.000Z");
    expect(shopDay(result)).toBe("2026-04-01");
    // Only 167 real hours elapsed — the skipped hour is absorbed.
    expect((result.getTime() - base.getTime()) / HOUR_MS).toBe(167);
  });

  it("keeps the local wall-clock time across the October fall-back", () => {
    // Wed 21 Oct, 09:00 UTC = 10:00 BST London. +1 week lands in GMT.
    const base = new Date("2026-10-21T09:00:00Z");
    const result = addWeeksTz(base, 1, LONDON);

    // Wall clock stays 10:00 London → UTC shifts forward one hour.
    expect(result.toISOString()).toBe("2026-10-28T10:00:00.000Z");
    expect(shopDay(result)).toBe("2026-10-28");
    // 169 real hours elapsed — the repeated hour is absorbed.
    expect((result.getTime() - base.getTime()) / HOUR_MS).toBe(169);
  });

  it("returns to the original UTC offset when spanning both transitions", () => {
    // Mon 2 Mar 10:00 GMT + 35 weeks = Mon 2 Nov (back in GMT).
    const base = new Date("2026-03-02T10:00:00Z");
    const result = addWeeksTz(base, 35, LONDON);
    expect(result.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("is exact clock arithmetic when no transition is crossed", () => {
    const base = new Date("2026-01-05T09:00:00Z");
    const result = addWeeksTz(base, 2, LONDON);
    expect(result.getTime() - base.getTime()).toBe(14 * 24 * HOUR_MS);
    expect(result.toISOString()).toBe("2026-01-19T09:00:00.000Z");
  });
});

describe("addDaysTz across DST boundaries (Europe/London)", () => {
  it("crossing spring-forward: next calendar day, 23 elapsed hours", () => {
    // Sat 28 Mar 12:00 GMT → Sun 29 Mar 12:00 BST.
    const base = new Date("2026-03-28T12:00:00Z");
    const result = addDaysTz(base, 1, LONDON);
    expect(result.toISOString()).toBe("2026-03-29T11:00:00.000Z");
    expect(shopDay(result)).toBe("2026-03-29");
    expect((result.getTime() - base.getTime()) / HOUR_MS).toBe(23);
  });

  it("crossing fall-back: next calendar day, 25 elapsed hours", () => {
    // Sat 24 Oct 13:00 BST (12:00 UTC) → Sun 25 Oct 13:00 GMT.
    const base = new Date("2026-10-24T12:00:00Z");
    const result = addDaysTz(base, 1, LONDON);
    expect(result.toISOString()).toBe("2026-10-25T13:00:00.000Z");
    expect(shopDay(result)).toBe("2026-10-25");
    expect((result.getTime() - base.getTime()) / HOUR_MS).toBe(25);
  });

  it("supports negative day offsets back across a transition", () => {
    // Mon 30 Mar 09:00 BST (08:00 UTC) − 2 days → Sat 28 Mar 09:00 GMT.
    const base = new Date("2026-03-30T08:00:00Z");
    const result = addDaysTz(base, -2, LONDON);
    expect(result.toISOString()).toBe("2026-03-28T09:00:00.000Z");
  });

  it("zero-day offset round-trips to the same instant", () => {
    const base = new Date("2026-07-23T15:30:00Z");
    expect(addDaysTz(base, 0, LONDON).getTime()).toBe(base.getTime());
  });
});

describe("isDueNow edges (shop-timezone day, not UTC day)", () => {
  it("due yesterday → true; due today → true; due tomorrow → false", () => {
    const now = new Date("2026-07-23T10:00:00Z");
    expect(isDueNow(new Date("2026-07-22T10:00:00Z"), LONDON, now)).toBe(true);
    expect(isDueNow(new Date("2026-07-23T10:00:00Z"), LONDON, now)).toBe(true);
    expect(isDueNow(new Date("2026-07-24T10:00:00Z"), LONDON, now)).toBe(false);
  });

  it("UTC skew: same UTC day but next London day is NOT due yet", () => {
    // Due 23:30 UTC = 00:30 London on 24 Jul (BST). Now is 23:00 London 23 Jul.
    // A naive UTC-day comparison would say due; London says tomorrow.
    const due = new Date("2026-07-23T23:30:00Z");
    const now = new Date("2026-07-23T22:00:00Z");
    expect(shopDay(due)).toBe("2026-07-24");
    expect(isDueNow(due, LONDON, now)).toBe(false);

    // The moment "now" enters 24 Jul London, it is due.
    expect(isDueNow(due, LONDON, new Date("2026-07-23T23:30:00Z"))).toBe(true);
  });

  it("UTC skew the other way: 'tomorrow' in UTC can already be due locally", () => {
    // Due 02:00 UTC on 24 Jul = 22:00 New York on 23 Jul.
    const due = new Date("2026-07-24T02:00:00Z");
    const now = new Date("2026-07-23T12:00:00Z"); // 08:00 New York, 23 Jul
    expect(shopDay(due, "America/New_York")).toBe("2026-07-23");
    expect(isDueNow(due, "America/New_York", now)).toBe(true);
  });

  it("winter (London == UTC): boundary behaves as plain calendar days", () => {
    const due = new Date("2026-01-10T00:30:00Z");
    expect(isDueNow(due, LONDON, new Date("2026-01-09T23:59:00Z"))).toBe(false);
    expect(isDueNow(due, LONDON, new Date("2026-01-10T00:00:30Z"))).toBe(true);
    expect(isDueNow(due, LONDON, new Date("2026-01-11T09:00:00Z"))).toBe(true);
  });

  it("isSameShopDay agrees with the tz-day used by isDueNow", () => {
    const a = new Date("2026-07-23T23:30:00Z"); // 24 Jul London
    const b = new Date("2026-07-24T10:00:00Z"); // 24 Jul London
    expect(isSameShopDay(a, b, LONDON)).toBe(true);
    expect(isSameShopDay(a, b, "UTC")).toBe(false);
  });
});

describe("alignToPayday", () => {
  const paydays = [1, 15, 25];

  it("snaps forward to a payday within the window", () => {
    // Mon 12 Jan + window 3 probes 12,13,14,15 → snaps to the 15th.
    const candidate = new Date("2026-01-12T09:00:00Z");
    const result = alignToPayday(candidate, LONDON, paydays, 3);
    expect(shopDay(result)).toBe("2026-01-15");
    // Time of day is preserved (only the calendar day moves).
    expect(result.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("snaps across a month boundary (month wrap)", () => {
    // Fri 30 Jan, paydays [1], window 3 → probes 30,31,1 Feb → 1 Feb.
    const candidate = new Date("2026-01-30T09:00:00Z");
    const result = alignToPayday(candidate, LONDON, [1], 3);
    expect(shopDay(result)).toBe("2026-02-01");
  });

  it("snaps across a year boundary", () => {
    const candidate = new Date("2025-12-30T09:00:00Z");
    const result = alignToPayday(candidate, LONDON, [1], 3);
    expect(shopDay(result)).toBe("2026-01-01");
  });

  it("is a no-op when no payday falls within the window", () => {
    // Mon 5 Jan, payday on the 15th, window 3 (probes 5..8) → unchanged.
    const candidate = new Date("2026-01-05T09:00:00Z");
    const result = alignToPayday(candidate, LONDON, [15], 3);
    expect(result.getTime()).toBe(candidate.getTime());
  });

  it("a candidate already on a payday stays put (offset-0 probe)", () => {
    const candidate = new Date("2026-01-15T09:00:00Z");
    const result = alignToPayday(candidate, LONDON, paydays, 3);
    expect(result.getTime()).toBe(candidate.getTime());
  });

  it("empty paydays list is a no-op", () => {
    const candidate = new Date("2026-01-12T09:00:00Z");
    expect(alignToPayday(candidate, LONDON, [], 3).getTime()).toBe(
      candidate.getTime(),
    );
  });

  it("snapWindowDays <= 0 disables snapping entirely", () => {
    const offPayday = new Date("2026-01-12T09:00:00Z");
    const onPayday = new Date("2026-01-15T09:00:00Z");
    expect(alignToPayday(offPayday, LONDON, paydays, 0).getTime()).toBe(
      offPayday.getTime(),
    );
    expect(alignToPayday(onPayday, LONDON, paydays, 0).getTime()).toBe(
      onPayday.getTime(),
    );
    expect(alignToPayday(offPayday, LONDON, paydays, -1).getTime()).toBe(
      offPayday.getTime(),
    );
  });

  it("payday snapping is stable across a DST transition", () => {
    // Candidate Sun 29 Mar (spring-forward day, BST from 01:00). Paydays [1],
    // window 3 probes 29,30,31,1 Apr → snaps to 1 Apr, wall time preserved.
    const candidate = addDaysTz(new Date("2026-03-22T10:00:00Z"), 7, LONDON);
    expect(candidate.toISOString()).toBe("2026-03-29T09:00:00.000Z"); // 10:00 BST
    const result = alignToPayday(candidate, LONDON, [1], 3);
    expect(shopDay(result)).toBe("2026-04-01");
    expect(result.toISOString()).toBe("2026-04-01T09:00:00.000Z"); // still 10:00 BST
  });
});
