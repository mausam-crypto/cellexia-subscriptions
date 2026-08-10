import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CSV IMPORT ↔ WEBHOOK ACQUISITION PARITY.
 *
 * docs/DATA_FOUNDATION.md promises that imported acquisition data passes
 * through "the same sanitizer entry points and caps as the webhook path".
 * That promise broke silently once already: the CLI import spread raw CSV
 * `acq_utm_*` values straight into `acqUtm`/`acqRaw` (no PII scrub, no length
 * cap), so a Recharge export with an email inside a utm value landed it
 * verbatim in a column the contract calls scrubbed. And because imported
 * contracts have no origin order, nothing ever computed their first-order
 * shape — the whole migrated book silently vanished from value-band and
 * basket-size analysis.
 *
 * The sanitizer's behavior is covered in tests/acquisition.test.ts; these are
 * text-level pins (the technique csv-date.test.ts established) that the
 * importers keep going THROUGH it rather than growing private copies or raw
 * spreads back.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

describe("CLI importer routes acq_* CSV values through the shared sanitizer", () => {
  const source = read("scripts/import-subscribers.ts");

  it("imports the pure sanitizer module and defines no local copy", () => {
    expect(source).toContain('} from "../app/lib/acquisition/sanitize"');
    expect(source).not.toMatch(/function (buildAcquisitionCapture|sanitizeUtmValue|truncateAcqField)/);
  });

  it("every utm column is scrubbed + capped via sanitizeUtmValue (never spread raw)", () => {
    for (const col of [
      "acq_utm_source",
      "acq_utm_medium",
      "acq_utm_campaign",
      "acq_utm_term",
      "acq_utm_content",
    ] as const) {
      expect(source).toContain(`sanitizeUtmValue(acqRow?.${col})`);
    }
    // The defect being pinned out: `first.acq_utm_source ?? null` spread the
    // trim-only CSV value straight into the columns.
    expect(source).not.toMatch(/first\.acq_utm_/);
  });

  it("the capped-only originals ride in rawUtm (the recompute reserve)", () => {
    expect(source).toContain("truncateAcqField(acqRow?.acq_utm_campaign)");
    expect(source).toContain("rawUtm");
  });

  it("acq data is taken from the first row IN THE GROUP that carries any, with a drop warning", () => {
    // The old code read only group.rows[0], so acquisition data on a later
    // row of a multi-line group vanished without a trace.
    expect(source).toContain("const acqRows = group.rows.filter");
    expect(source).toContain("acq_* values ignored");
  });

  it("computes the first-order shape from CSV quantities + prices (ACQ-8)", () => {
    expect(source).toMatch(/unitsFirstOrder:\s*mergedLines\.reduce/);
    expect(source).toMatch(/orderTotalCents:\s*mergedLines\.reduce/);
    expect(source).toContain("acqUnitsFirstOrder: capture.acqUnitsFirstOrder");
    expect(source).toContain("acqOrderValueBand: capture.acqOrderValueBand");
  });

  it("keeps acqRaw shape parity with the webhook bundle (keys present, null)", () => {
    expect(source).toContain("customerCreatedAt: null");
    expect(source).toContain("customerNumberOfOrders: null");
    expect(source).toContain("timeToPurchaseSeconds: null");
    expect(source).toContain("importPassthrough: true");
    expect(source).toContain("importSubscribedSince");
  });
});

describe("admin importer captures the first-order shape too", () => {
  const source = read("app/routes/app.import.tsx");

  it("uses the shared buildAcquisitionCapture and defines no local copy", () => {
    expect(source).toContain(
      'import { buildAcquisitionCapture } from "~/lib/acquisition/sanitize"',
    );
    expect(source).not.toMatch(/function buildAcquisitionCapture/);
  });

  it("writes units, value band and the parity-shaped acqRaw bundle", () => {
    expect(source).toMatch(/unitsFirstOrder:\s*mergedLines\.reduce/);
    expect(source).toContain("acqUnitsFirstOrder: capture.acqUnitsFirstOrder");
    expect(source).toContain("acqOrderValueBand: capture.acqOrderValueBand");
    expect(source).toContain("customerCreatedAt: null");
    expect(source).toContain("importPassthrough: true");
    expect(source).toContain("importSubscribedSince");
  });
});
