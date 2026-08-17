import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESIGN_PRESELECT_VALUES,
  DESIGN_SOURCE_VALUES,
  SEEN_PROPERTY,
  designVariantLabel,
  normalizeDesignPreselect,
  parseSeenValue,
  preselectDisplayName,
  presetDisplayName,
  sanitizeDesignKey,
} from "~/lib/design-measurement/shared";

/**
 * DESIGN MEASUREMENT — the isomorphic contract (v1.26.0)
 *
 *  1. The `_cellexia_seen` value grammar `<preset>|<s|o|u>` parses to
 *     {designKey, preselect}; the key is sanitized to /^[a-z0-9_]{1,40}$/
 *     (lowercased) because a line property is buyer-writable input; an
 *     empty/invalid key yields null.
 *  2. Display formatters: presetDisplayName / designVariantLabel are the ONE
 *     naming the Results tab and the segments layer share.
 *  3. shared.ts stays free of server imports (client bundle safety).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("seen property grammar", () => {
  it("names the property the storefront stamps", () => {
    expect(SEEN_PROPERTY).toBe("_cellexia_seen");
    expect(DESIGN_PRESELECT_VALUES).toEqual(["sub", "one"]);
    expect(DESIGN_SOURCE_VALUES).toEqual(["seen", "design_prop", "calendar", "none"]);
  });

  it("parses <preset>|<s|o|u>", () => {
    expect(parseSeenValue("subscription_max|s")).toEqual({
      designKey: "subscription_max",
      preselect: "sub",
    });
    expect(parseSeenValue("classic|o")).toEqual({ designKey: "classic", preselect: "one" });
    expect(parseSeenValue("tiles|u")).toEqual({ designKey: "tiles", preselect: null });
    // Bare preset (no flag) = preselect unknown.
    expect(parseSeenValue("tiles")).toEqual({ designKey: "tiles", preselect: null });
    // Full words tolerated (hand-typed test carts).
    expect(parseSeenValue("tiles|sub")?.preselect).toBe("sub");
    expect(parseSeenValue("tiles|one")?.preselect).toBe("one");
    // Unknown flags never invent a preselect.
    expect(parseSeenValue("tiles|x")?.preselect).toBeNull();
    expect(parseSeenValue("tiles|")?.preselect).toBeNull();
  });

  it("sanitizes the key: trim + lowercase, [a-z0-9_]{1,40} only", () => {
    expect(parseSeenValue("  Subscription_MAX | S ")).toEqual({
      designKey: "subscription_max",
      preselect: "sub",
    });
    expect(parseSeenValue("|s")).toBeNull();
    expect(parseSeenValue("")).toBeNull();
    expect(parseSeenValue("   ")).toBeNull();
    expect(parseSeenValue(null)).toBeNull();
    expect(parseSeenValue(undefined)).toBeNull();
    expect(parseSeenValue("<script>|s")).toBeNull();
    expect(parseSeenValue("has space|s")).toBeNull();
    expect(parseSeenValue("a".repeat(41) + "|s")).toBeNull();
    expect(parseSeenValue("a".repeat(40) + "|s")?.designKey).toBe("a".repeat(40));
    // Only the first bar splits; the rest of the flag is opaque.
    expect(parseSeenValue("classic|s|extra")).toEqual({ designKey: "classic", preselect: null });
  });

  it("sanitizeDesignKey mirrors the parser's key rule (used for _cellexia_design too)", () => {
    expect(sanitizeDesignKey(" Classic ")).toBe("classic");
    expect(sanitizeDesignKey("value_stack")).toBe("value_stack");
    expect(sanitizeDesignKey("bad-key")).toBeNull();
    expect(sanitizeDesignKey("")).toBeNull();
    expect(sanitizeDesignKey(null)).toBeNull();
  });

  it("normalizeDesignPreselect narrows stored strings", () => {
    expect(normalizeDesignPreselect("sub")).toBe("sub");
    expect(normalizeDesignPreselect("one")).toBe("one");
    expect(normalizeDesignPreselect("s")).toBeNull();
    expect(normalizeDesignPreselect(null)).toBeNull();
    expect(normalizeDesignPreselect(undefined)).toBeNull();
  });
});

describe("display formatters", () => {
  it("presetDisplayName: snake_case → Sentence case, null → Unknown", () => {
    expect(presetDisplayName("subscription_max")).toBe("Subscription max");
    expect(presetDisplayName("subscription_ultra_max")).toBe("Subscription ultra max");
    expect(presetDisplayName("classic")).toBe("Classic");
    expect(presetDisplayName("value_stack")).toBe("Value stack");
    expect(presetDisplayName(null)).toBe("Unknown");
    expect(presetDisplayName("")).toBe("Unknown");
    expect(presetDisplayName(undefined)).toBe("Unknown");
  });

  it("preselectDisplayName", () => {
    expect(preselectDisplayName("sub")).toBe("sub preselected");
    expect(preselectDisplayName("one")).toBe("one-time preselected");
    expect(preselectDisplayName(null)).toBe("");
    expect(preselectDisplayName("u")).toBe("");
  });

  it("designVariantLabel composes design × preselect", () => {
    expect(designVariantLabel("subscription_max", "sub")).toBe(
      "Subscription max · sub preselected",
    );
    expect(designVariantLabel("subscription_max", "one")).toBe(
      "Subscription max · one-time preselected",
    );
    expect(designVariantLabel("subscription_max", null)).toBe("Subscription max");
    expect(designVariantLabel(null, "sub")).toBe("Unknown design");
    expect(designVariantLabel("", null)).toBe("Unknown design");
    // Merchant-facing copy: no em dashes.
    expect(designVariantLabel("subscription_max", "sub")).not.toContain("—");
  });
});

describe("module hygiene", () => {
  it("shared.ts has no server imports (client components import it)", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "app/lib/design-measurement/shared.ts"),
      "utf8",
    );
    const imports = source.match(/^\s*import .* from ["'][^"']+["'];?/gm) ?? [];
    expect(imports).toEqual([]);
    expect(source).not.toMatch(/\.server["']/);
    expect(source).not.toMatch(/from ["']~\/db\.server["']/);
  });
});
