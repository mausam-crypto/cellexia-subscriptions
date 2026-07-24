import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { locales } from "~/lib/i18n/locales";
import { SUPPORTED_LOCALES, normalizeLocale, t } from "~/lib/i18n/i18n.server";

/**
 * Locale-catalog parity: en.json is the master. Every other catalog must have
 * exactly the same key set, and every value must carry exactly the same
 * {placeholder} variables as its en counterpart — a missing {date} in a
 * renewal reminder is a broken email in that language.
 */

const en = locales.en;
const NON_EN = Object.keys(locales).filter((code) => code !== "en");

/** Sorted list of {var} placeholder names used in a catalog string. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("master catalog (en)", () => {
  it("exists and is non-trivial", () => {
    expect(Object.keys(en).length).toBeGreaterThan(100);
  });

  it("every value is a non-empty string", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, `en["${key}"]`).toBe("string");
      expect(value.length, `en["${key}"] is empty`).toBeGreaterThan(0);
    }
  });

  it("every key is namespaced to a known prefix", () => {
    const allowed = /^(portal|magic|email|sms|cancel|common)\./;
    const offenders = Object.keys(en).filter((k) => !allowed.test(k));
    expect(
      offenders,
      `en keys outside the allowed namespaces: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("locale coverage", () => {
  it("SUPPORTED_LOCALES has at least 17 locales", () => {
    expect(
      SUPPORTED_LOCALES.length,
      `expected >= 17 locales, got ${SUPPORTED_LOCALES.length}: [${SUPPORTED_LOCALES.join(", ")}]`,
    ).toBeGreaterThanOrEqual(17);
  });

  it("SUPPORTED_LOCALES mirrors the catalog index and includes en", () => {
    expect(SUPPORTED_LOCALES.sort()).toEqual(Object.keys(locales).sort());
    expect(SUPPORTED_LOCALES).toContain("en");
  });
});

describe("per-locale key parity with en", () => {
  for (const code of NON_EN) {
    const catalog = locales[code];

    it(`[${code}] has exactly the same key set as en`, () => {
      const missing = Object.keys(en).filter((k) => !(k in catalog));
      const extra = Object.keys(catalog).filter((k) => !(k in en));
      expect(
        missing,
        `[${code}] missing ${missing.length} key(s): ${missing.join(", ")}`,
      ).toEqual([]);
      expect(
        extra,
        `[${code}] has ${extra.length} extra key(s): ${extra.join(", ")}`,
      ).toEqual([]);
    });

    it(`[${code}] every value keeps the same {var} placeholders as en`, () => {
      const mismatches: string[] = [];
      for (const [key, enValue] of Object.entries(en)) {
        const value = catalog[key];
        if (typeof value !== "string") continue; // covered by the parity test above
        const expected = placeholders(enValue);
        const actual = placeholders(value);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(
            `${key}: en has {${expected.join(", ")}} but ${code} has {${actual.join(", ")}}`,
          );
        }
      }
      expect(
        mismatches,
        `[${code}] placeholder mismatches:\n  ${mismatches.join("\n  ")}`,
      ).toEqual([]);
    });

    it(`[${code}] every value is a non-empty string`, () => {
      const empty = Object.entries(catalog)
        .filter(([, v]) => typeof v !== "string" || v.length === 0)
        .map(([k]) => k);
      expect(empty, `[${code}] empty values: ${empty.join(", ")}`).toEqual([]);
    });
  }
});

describe("buy-box extension locale parity", () => {
  // Theme-extension locale catalogs (extensions/cellexia-buy-box/locales):
  // en.default.json is the master; every other file must carry exactly the
  // same key set, non-empty string values, and the same {{ var }} Liquid
  // placeholders — the buy-box designer's text fallback chain ends here, so a
  // missing key is broken storefront copy in that language.
  const LOCALES_DIR = fileURLToPath(
    new URL("../extensions/cellexia-buy-box/locales", import.meta.url),
  );
  const MASTER_FILE = "en.default.json";

  function readCatalog(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
  }

  /** Sorted list of {{ var }} Liquid placeholder names used in a value. */
  function liquidPlaceholders(value: unknown): string[] {
    return [...String(value).matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      .map((m) => m[1])
      .sort();
  }

  const files = readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const extEn = readCatalog(MASTER_FILE);
  const extEnKeys = Object.keys(extEn).sort();

  it("ships all 22 locale files including the en.default master", () => {
    expect(
      files.length,
      `expected 22 locale files, got ${files.length}: [${files.join(", ")}]`,
    ).toBe(22);
    expect(files).toContain(MASTER_FILE);
  });

  it("the master catalog is flat, non-trivial, and non-empty-valued", () => {
    expect(extEnKeys.length).toBeGreaterThan(10);
    for (const [key, value] of Object.entries(extEn)) {
      expect(typeof value, `en.default["${key}"]`).toBe("string");
      expect(
        (value as string).length,
        `en.default["${key}"] is empty`,
      ).toBeGreaterThan(0);
    }
  });

  for (const file of files) {
    if (file === MASTER_FILE) continue;
    const catalog = readCatalog(file);

    it(`[${file}] has exactly the same key set as ${MASTER_FILE}`, () => {
      const missing = extEnKeys.filter((k) => !(k in catalog));
      const extra = Object.keys(catalog).filter((k) => !(k in extEn));
      expect(
        missing,
        `[${file}] missing ${missing.length} key(s): ${missing.join(", ")}`,
      ).toEqual([]);
      expect(
        extra,
        `[${file}] has ${extra.length} extra key(s): ${extra.join(", ")}`,
      ).toEqual([]);
    });

    it(`[${file}] every value is a non-empty string with en's {{ var }} placeholders`, () => {
      const problems: string[] = [];
      for (const [key, enValue] of Object.entries(extEn)) {
        const value = catalog[key];
        if (typeof value !== "string" || value.length === 0) {
          problems.push(`${key}: empty or non-string`);
          continue;
        }
        const expected = liquidPlaceholders(enValue);
        const actual = liquidPlaceholders(value);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          problems.push(
            `${key}: en has {{${expected.join(", ")}}} but has {{${actual.join(", ")}}}`,
          );
        }
      }
      expect(
        problems,
        `[${file}] problems:\n  ${problems.join("\n  ")}`,
      ).toEqual([]);
    });
  }
});

describe("normalizeLocale / t fallbacks", () => {
  it("unknown locales normalize to en", () => {
    expect(normalizeLocale("xx")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale("")).toBe("en");
  });

  it("exact locale codes normalize to themselves", () => {
    for (const code of SUPPORTED_LOCALES) {
      expect(normalizeLocale(code)).toBe(code);
    }
  });

  it("regional variants fall back to their base language when present", () => {
    // en-GB → en is always safe regardless of which catalogs are installed.
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("t() interpolates {var} placeholders", () => {
    // portal.login.code_sent: "...expires in {minutes} minutes."
    const out = t("en", "portal.login.code_sent", { minutes: 10 });
    expect(out).toContain("10");
    expect(out).not.toContain("{minutes}");
  });

  it("t() falls back to the key itself for unknown keys", () => {
    expect(t("en", "portal.__does_not_exist__")).toBe("portal.__does_not_exist__");
  });
});
