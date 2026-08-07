import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvDate } from "~/lib/csv-date";

/**
 * THE DATE THAT BILLED A MONTH EARLY — strict next_charge_date parsing.
 *
 * Both subscriber importers validate next_charge_date through parseCsvDate.
 * It used to fall back to bare `new Date(v)` for anything that wasn't
 * `YYYY-MM-DD`, silently accepting exactly what a migration CSV is most
 * likely to contain:
 *
 *  - "05/06/2026" — a European export meaning 5 June — parsed as US MDY
 *    May 6 in the SERVER's local timezone. Every row passed the dry run and
 *    created a real Shopify contract billing ~a month off schedule.
 *  - A spreadsheet-degraded bare "2026" parsed as Jan 1 2026; being in the
 *    past, resolveNextBillingDate silently moved it to TOMORROW — an
 *    unauthorized early charge on a stored payment method the day after
 *    cutover.
 *  - "2026-02-30" rolled over to Mar 2 on V8 instead of failing.
 *
 * The schema's error message always claimed "must be YYYY-MM-DD or
 * ISO-8601"; these tests make the parser as strict as the promise.
 */

describe("parseCsvDate accepts what the schema promises", () => {
  it("parses YYYY-MM-DD at 12:00 UTC so the calendar day survives any shop tz", () => {
    expect(parseCsvDate("2026-06-05")?.toISOString()).toBe(
      "2026-06-05T12:00:00.000Z",
    );
    expect(parseCsvDate("  2026-06-05  ")?.toISOString()).toBe(
      "2026-06-05T12:00:00.000Z",
    );
  });

  it("parses strict ISO-8601 timestamps with an explicit offset", () => {
    expect(parseCsvDate("2026-06-05T10:00:00Z")?.toISOString()).toBe(
      "2026-06-05T10:00:00.000Z",
    );
    expect(parseCsvDate("2026-06-05T10:00Z")?.toISOString()).toBe(
      "2026-06-05T10:00:00.000Z",
    );
    expect(parseCsvDate("2026-06-05T10:00:00.123+02:00")?.toISOString()).toBe(
      "2026-06-05T08:00:00.123Z",
    );
    expect(parseCsvDate("2026-06-05T10:00+0200")?.toISOString()).toBe(
      "2026-06-05T08:00:00.000Z",
    );
  });

  it("accepts a real leap day", () => {
    expect(parseCsvDate("2024-02-29")?.toISOString()).toBe(
      "2024-02-29T12:00:00.000Z",
    );
  });
});

describe("parseCsvDate rejects what used to slip through", () => {
  it("rejects ambiguous slash dates — the European-DMY-as-US-MDY billing shift", () => {
    expect(parseCsvDate("05/06/2026")).toBeNull();
    expect(parseCsvDate("5/6/2026")).toBeNull();
  });

  it("rejects prose dates", () => {
    expect(parseCsvDate("June 5, 2026")).toBeNull();
    expect(parseCsvDate("5 June 2026")).toBeNull();
  });

  it("rejects a degenerate bare year — the charge-tomorrow defect", () => {
    expect(parseCsvDate("2026")).toBeNull();
    expect(parseCsvDate("2026-06")).toBeNull();
  });

  it("rejects calendar rollover instead of letting V8 invent a date", () => {
    expect(parseCsvDate("2026-02-30")).toBeNull();
    expect(parseCsvDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(parseCsvDate("2026-13-01")).toBeNull();
    expect(parseCsvDate("2026-00-10")).toBeNull();
    expect(parseCsvDate("2026-04-31")).toBeNull();
    expect(parseCsvDate("2026-02-30T10:00:00Z")).toBeNull();
  });

  it("rejects timestamps without an explicit offset — server-timezone ambiguity", () => {
    expect(parseCsvDate("2026-06-05T10:00:00")).toBeNull();
    expect(parseCsvDate("2026-06-05 10:00:00")).toBeNull();
  });

  it("rejects out-of-range time and offset components", () => {
    expect(parseCsvDate("2026-06-05T24:00:00Z")).toBeNull();
    expect(parseCsvDate("2026-06-05T10:60:00Z")).toBeNull();
    expect(parseCsvDate("2026-06-05T10:00:61Z")).toBeNull();
    expect(parseCsvDate("2026-06-05T10:00:00+15:00")).toBeNull();
    expect(parseCsvDate("2026-06-05T10:00:00+02:60")).toBeNull();
  });

  it("rejects empty and junk", () => {
    expect(parseCsvDate("")).toBeNull();
    expect(parseCsvDate("   ")).toBeNull();
    expect(parseCsvDate("soon")).toBeNull();
  });
});

// ── Static: both importers use THE shared helper ─────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

describe("both importers share the strict parser — no drift possible", () => {
  for (const [file, spec] of [
    ["app/routes/app.import.tsx", '"~/lib/csv-date"'],
    ["scripts/import-subscribers.ts", '"../app/lib/csv-date"'],
  ] as const) {
    it(`${file} imports parseCsvDate from the shared module and defines no local copy`, () => {
      const source = read(file);
      expect(source).toContain(`import { parseCsvDate } from ${spec}`);
      // A re-introduced local implementation would shadow the strict one.
      expect(source).not.toMatch(/function parseCsvDate/);
    });
  }
});
