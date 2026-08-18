import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P2.8 — address form + delivery instructions (v1.28.0, portal UI):
 *
 *  - the "Your next delivery" hero shows the mirrored delivery instructions
 *    right under the ships-to line (only when set; escaped);
 *  - the address form carries the Company field, a country <select> built
 *    from the static ISO list (named via Intl.DisplayNames, English
 *    fallback), and a region field backed by the per-country province table;
 *  - the delivery-instructions card is its own form (own POST), textarea
 *    capped by settings.portal.deliveryInstructionsMaxChars, showing the
 *    current note + a clear form;
 *  - copy hygiene: none of the P2.8 copy names cancellation.
 *
 * Rendering through the real detail loader is pinned in
 * tests/portal-flex-ui.test.ts; the dispatcher in
 * tests/portal-flex-dispatcher.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

import { nextDeliveryHeroHtml } from "~/lib/portal/next-delivery.server";
import {
  COUNTRY_CODES,
  countryOptions,
  countryRequiresProvince,
  normalizeProvinceCode,
  provincesFor,
} from "~/lib/portal/countries";
import en from "~/lib/i18n/locales/en.json";

const enMap = en as Record<string, string>;
const TZ = "Europe/Zurich";
const NEXT = new Date("2026-09-10T00:00:00Z");

function estimate() {
  return {
    lines: [
      {
        title: "Serum",
        variantTitle: null,
        quantity: 1,
        unitPriceCents: 1000,
        lineTotalCents: 1000,
        kind: "RECURRING",
        free: false,
        skippedThisCycle: false,
      },
    ],
    subtotalCents: 1000,
    discountCents: 0,
    discountPercent: null,
    discountCyclesRemaining: null,
    discountLabel: null,
    totalCents: 1000,
    currency: "CHF",
    deliveryCents: 0,
    nextBillingDate: NEXT,
    followingBillingDate: null,
    cardLabel: "Visa ····4242",
    addressSummary: "12 High St, London W1A 1AA, GB",
  };
}

function hero(deliveryInstructions: string | null) {
  return nextDeliveryHeroHtml({
    locale: "en",
    tz: TZ,
    contract: {
      id: "ctr_1",
      status: "ACTIVE",
      currencyCode: "CHF",
      nextBillingDate: NEXT,
      deliveryInstructions,
    },
    estimate: estimate() as never,
    cutoff: null,
    preparing: false,
    lineUp: null,
    outOfStockTitles: [],
    stockoutDelay: null,
    priceChange: null,
    chip: null,
    apiUrl: (a) => `/apps/cellexia-subs/api/${a}`,
    hiddenFields: () => "",
  });
}

describe("hero ships-to line + delivery instructions", () => {
  it("shows the instructions under the ships-to line when set, escaped; nothing when empty/blank", () => {
    const html = hero("Leave with <neighbour> at no. 12");
    expect(html).toContain("Ships to 12 High St, London W1A 1AA, GB");
    expect(html).toContain("Delivery instructions: Leave with &lt;neighbour&gt; at no. 12");
    expect(html.indexOf("Ships to")).toBeLessThan(html.indexOf("Delivery instructions:"));
    expect(hero(null)).not.toContain("Delivery instructions:");
    expect(hero("   ")).not.toContain("Delivery instructions:");
  });
});

describe("country / region lists", () => {
  it("countryOptions covers the ISO list, sorted by (English fallback) name, with sensible names", () => {
    const options = countryOptions("en");
    expect(options.length).toBe(COUNTRY_CODES.length);
    expect(options.find((c) => c.code === "CH")?.name).toBe("Switzerland");
    expect(options.find((c) => c.code === "GB")?.name).toBe("United Kingdom");
    const names = options.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b, "en"))).toEqual(names);
    // An unknown locale falls back to English names rather than throwing.
    expect(countryOptions("xx-INVALID").find((c) => c.code === "FR")?.name).toBeTruthy();
  });

  it("provincesFor / countryRequiresProvince / normalizeProvinceCode agree on the same table", () => {
    expect(provincesFor("US").length).toBeGreaterThan(40);
    expect(countryRequiresProvince("US")).toBe(true);
    expect(countryRequiresProvince("CH")).toBe(false);
    expect(provincesFor("CH")).toEqual([]);
    expect(normalizeProvinceCode("US", "ca")).toEqual({ ok: true, value: "CA" });
    expect(normalizeProvinceCode("US", "California")).toEqual({ ok: true, value: "CA" });
    expect(normalizeProvinceCode("US", "Nowhere")).toEqual({ ok: false });
    expect(normalizeProvinceCode("CH", "")).toEqual({ ok: true, value: null });
  });
});

describe("address + instructions forms (source pins)", () => {
  const src = readSource("app/routes/proxy.subscription.$id.tsx");

  it("the address form has Company, a country <select> and a province field; region validated server-side", () => {
    const fn = src.slice(src.indexOf("function addressHtml("), src.indexOf("// ── Delivery instructions"));
    expect(fn).toContain('field("company", "portal.address.company"');
    expect(fn).toContain('name="countryCode" required autocomplete="country" data-cellexia-country');
    expect(fn).toContain('name="provinceCode"');
    expect(fn).toContain("countryOptions(locale)");
    expect(fn).toContain("provincesFor(countryCode)");
    const api = readSource("app/routes/proxy.api.$action.tsx");
    expect(api).toContain("normalizeProvinceCode");
    expect(api).toContain("address_region_invalid");
  });

  it("delivery instructions: own POST, textarea capped by the merchant setting, current note shown, clear form", () => {
    const fn = src.slice(src.indexOf("function deliveryInstructionsHtml("), src.indexOf("// ── Payment"));
    expect(fn).toContain('api(ctx, "delivery_instructions")');
    expect(fn).toContain('maxlength="${maxChars}"');
    expect(fn).toContain("escapeHtml(current)");
    expect(fn).toContain('["instructions", ""]');
    expect(src).toContain("portalSettings.deliveryInstructionsMaxChars ?? 250");
    // Rendered for ACTIVE || PAUSED (editable), like the address.
    expect(src).toMatch(/if \(editable\) \{\s*body \+= addressHtml\(ctx\);[\s\S]*?deliveryInstructionsHtml\(/);
  });

  it("copy hygiene: the P2.8 keys exist and never name cancellation", () => {
    for (const key of [
      "portal.next.instructions",
      "portal.instructions.title",
      "portal.instructions.label",
      "portal.instructions.hint",
      "portal.instructions.save",
      "portal.instructions.clear",
      "portal.address.company",
      "portal.address.country_placeholder",
      "portal.address.province",
      "portal.toast.instructions_saved",
      "portal.toast.instructions_cleared",
      "portal.toast.address_region_invalid",
    ]) {
      expect(enMap[key], key).toBeTruthy();
      expect(enMap[key].toLowerCase(), key).not.toMatch(/cancel/);
    }
    expect(enMap["portal.instructions.hint"]).toContain("{max}");
    expect(enMap["portal.next.instructions"]).toContain("{instructions}");
  });
});
