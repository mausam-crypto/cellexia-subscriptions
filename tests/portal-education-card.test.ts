import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Education hub (v1.28.0, P4.4).
 *
 * Pins:
 *  - settings.portal.routineGuideUrl / howToUseUrl / faqUrl exist (default
 *    "") and the Settings page exposes them;
 *  - the card is hidden when all three are empty; renders only the links
 *    that are configured; "How to use {product}" names the single product,
 *    the plural label covers several; the Get-help entry anchors the support
 *    card;
 *  - URL sanitizing: https:// and store-relative paths only — javascript:,
 *    protocol-relative and http:// are dropped (never rendered);
 *  - the cancel flow's EDUCATION card and the saved page use the SAME
 *    resolved guide URL (routineGuideUrl → howToUseUrl → faqUrl) and render
 *    no guide button when nothing is configured;
 *  - the old hard-coded `/pages/routine-guide` i18n value is gone from every
 *    catalog;
 *  - the subscription detail route renders the card right after the items
 *    card and the cancel route hands the links to pageSaves / pageSaved.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const settings = vi.hoisted(() => ({
  portal: {} as Record<string, unknown>,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") return settings.portal;
    return {};
  }),
}));
vi.mock("~/db.server", () => ({ default: {} }));

import {
  EMPTY_EDUCATION_LINKS,
  educationCardHtml,
  educationGuideUrl,
  getEducationLinks,
  hasEducationLinks,
  sanitizeEducationUrl,
} from "~/lib/portal/education.server";
import { pageSaved, pageSaves } from "~/lib/cancel/pages.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

describe("settings", () => {
  it("portal.routineGuideUrl / howToUseUrl / faqUrl default to empty strings", () => {
    // Whole-group default (what a shop without a stored row gets)…
    const parsed = settingsSchemas.portal.parse(undefined);
    expect(parsed.routineGuideUrl).toBe("");
    expect(parsed.howToUseUrl).toBe("");
    expect(parsed.faqUrl).toBe("");
    // …and a previously stored row (pre-v1.28.0 shape) stays valid — the new
    // fields are field-level defaults, trimmed on the way in.
    const base = {
      contextualPrompts: true,
      allowAddProducts: true,
      otpCodeTtlMinutes: 10,
      sessionTtlDays: 30,
      magicLinkTtlDays: 14,
    };
    expect(settingsSchemas.portal.parse(base).faqUrl).toBe("");
    const stored = settingsSchemas.portal.parse({
      ...base,
      routineGuideUrl: "  /pages/routine-guide ",
    });
    expect(stored.routineGuideUrl).toBe("/pages/routine-guide");
  });

  it("the Settings page exposes the three fields under the portal group", () => {
    const page = src("app/routes/app.settings.tsx");
    for (const path of ["routineGuideUrl", "howToUseUrl", "faqUrl"]) {
      expect(page).toContain(`path: "${path}"`);
    }
  });

  it("getEducationLinks reads + sanitizes the portal settings and never throws", async () => {
    settings.portal = {
      routineGuideUrl: "/pages/routine-guide",
      howToUseUrl: "javascript:alert(1)",
      faqUrl: "https://cellexialabs.com/pages/faq",
    };
    expect(await getEducationLinks("shop_1")).toEqual({
      routineGuideUrl: "/pages/routine-guide",
      howToUseUrl: "",
      faqUrl: "https://cellexialabs.com/pages/faq",
    });
    settings.portal = {};
    expect(await getEducationLinks("shop_1")).toEqual(EMPTY_EDUCATION_LINKS);
  });
});

describe("sanitizeEducationUrl", () => {
  it("keeps https:// and store-relative paths, drops everything else", () => {
    expect(sanitizeEducationUrl("https://cellexialabs.com/pages/faq")).toBe(
      "https://cellexialabs.com/pages/faq",
    );
    expect(sanitizeEducationUrl("/pages/routine-guide")).toBe("/pages/routine-guide");
    expect(sanitizeEducationUrl("//evil.example/x")).toBe("");
    // Backslash-relative: browsers read "/\\host" as "//host" (protocol-
    // relative) for special schemes — must never leave the store either.
    expect(sanitizeEducationUrl("/\\evil.example/x")).toBe("");
    expect(sanitizeEducationUrl("/\\\\evil.example/x")).toBe("");
    expect(sanitizeEducationUrl("/pages\\x")).toBe("");
    expect(sanitizeEducationUrl("https://cellexialabs.com/x\\y")).toBe("");
    expect(sanitizeEducationUrl("http://cellexialabs.com/x")).toBe("");
    expect(sanitizeEducationUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeEducationUrl('/pages/x" onclick="1')).toBe("");
    expect(sanitizeEducationUrl("")).toBe("");
    expect(sanitizeEducationUrl(null)).toBe("");
  });
});

describe("educationCardHtml", () => {
  it("is hidden when all URLs are empty (even with a help anchor)", () => {
    expect(
      educationCardHtml({
        locale: "en",
        links: EMPTY_EDUCATION_LINKS,
        productTitles: ["Cellexia Serum"],
        helpHref: "#cxs-support",
      }),
    ).toBe("");
    expect(hasEducationLinks(EMPTY_EDUCATION_LINKS)).toBe(false);
  });

  it("renders only the configured links, names the single product, anchors Get help", () => {
    const html = educationCardHtml({
      locale: "en",
      links: {
        routineGuideUrl: "/pages/routine-guide",
        howToUseUrl: "https://cellexialabs.com/pages/how-to",
        faqUrl: "",
      },
      productTitles: ["Cellexia Serum"],
      helpHref: "#cxs-support",
    });
    expect(html).toContain('class="cxs-card cxs-education"');
    expect(html).toContain("<h2 id=\"cxs-education-title\"");
    expect(html).toContain("Get the most from your routine");
    expect(html).toContain('href="https://cellexialabs.com/pages/how-to">How to use Cellexia Serum</a>');
    expect(html).toContain('href="/pages/routine-guide">Routine guide</a>');
    expect(html).not.toContain(">FAQ<");
    expect(html).toContain('<a href="#cxs-support">Get help</a>');
    // No bare vendor prefix, ever.
    expect(html).not.toMatch(/\bcx-[\w-]+/);
  });

  it("uses the plural how-to label for several products and escapes titles", () => {
    const html = educationCardHtml({
      locale: "en",
      links: { routineGuideUrl: "", howToUseUrl: "/pages/how-to", faqUrl: "/pages/faq" },
      productTitles: ["Serum", "Cream <b>"],
      helpHref: null,
    });
    expect(html).toContain(">How to use your products</a>");
    expect(html).toContain('href="/pages/faq">FAQ</a>');
    expect(html).not.toContain("Get help");
    const single = educationCardHtml({
      locale: "en",
      links: { routineGuideUrl: "", howToUseUrl: "/pages/how-to", faqUrl: "" },
      productTitles: ["Cream <b>", "Cream <b>"],
      helpHref: null,
    });
    expect(single).toContain(">How to use Cream &lt;b&gt;</a>");
  });
});

describe("cancel flow reuses the same URL", () => {
  it("educationGuideUrl falls back routineGuide → howToUse → faq → null", () => {
    expect(educationGuideUrl({ routineGuideUrl: "/a", howToUseUrl: "/b", faqUrl: "/c" })).toBe("/a");
    expect(educationGuideUrl({ routineGuideUrl: "", howToUseUrl: "/b", faqUrl: "/c" })).toBe("/b");
    expect(educationGuideUrl({ routineGuideUrl: "", howToUseUrl: "", faqUrl: "/c" })).toBe("/c");
    expect(educationGuideUrl(EMPTY_EDUCATION_LINKS)).toBeNull();
  });

  it("EDUCATION save card + saved page link the settings URL; no URL ⇒ no guide button", () => {
    const links = { routineGuideUrl: "", howToUseUrl: "https://cellexialabs.com/pages/how-to", faqUrl: "" };
    const saves = pageSaves({
      locale: "en",
      csrf: "csrf-1",
      contractId: "c_1",
      offers: [{ kind: "EDUCATION" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
      education: links,
    });
    expect(saves.body).toContain(
      '<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="https://cellexialabs.com/pages/how-to" style="margin-bottom:10px">Read the routine guide</a>',
    );
    expect(saves.body).not.toContain("/pages/routine-guide");

    const saved = pageSaved({
      locale: "en",
      contractId: "c_1",
      messageKey: "cancel.saved.education",
      messageVars: {},
      showEducationLinks: true,
      showSupportLink: false,
      education: links,
    });
    expect(saved.body).toContain('href="https://cellexialabs.com/pages/how-to"');

    const none = pageSaves({
      locale: "en",
      csrf: "csrf-1",
      contractId: "c_1",
      offers: [{ kind: "EDUCATION" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
    });
    expect(none.body).not.toContain("Read the routine guide");
    expect(none.body).not.toContain("/pages/routine-guide");
    // The consultation form (the actual save) is still there.
    expect(none.body).toContain('name="kind" value="EDUCATION"');
  });

  it("the hard-coded guide_url copy is gone from every catalog and from the code", () => {
    for (const code of [
      "en", "ar", "cs", "da", "de", "el", "es", "fi", "fr", "hu", "it", "ja",
      "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "sv", "tr", "zh-CN",
    ]) {
      const catalog = JSON.parse(src(`app/lib/i18n/locales/${code}.json`)) as Record<string, string>;
      expect(catalog["cancel.saves.education.guide_url"], code).toBeUndefined();
      const hardCoded = Object.entries(catalog).filter(([, v]) => v === "/pages/routine-guide");
      expect(hardCoded, code).toEqual([]);
    }
    expect(src("app/lib/cancel/pages.server.ts")).not.toContain("guide_url");
  });

  it("routes: detail page renders the card after the items card; cancel route passes the links", () => {
    const detail = src("app/routes/proxy.subscription.$id.tsx");
    const items = detail.indexOf("body += itemsCardHtml(ctx, catalog, discountByProduct, isActive);");
    // v1.28.0 P4.1: the card HTML is built once (educationCardHtml) and
    // appended after the items card unless a "not sure yet" check-in landing
    // already placed it under the timeline card at the top.
    const card = detail.indexOf("if (!educationPlacedEarly) body += educationHtml;");
    expect(detail).toContain("const educationHtml = educationCardHtml({");
    expect(items).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(items);
    expect(detail).toContain('helpHref: "#cxs-support"');
    const cancel = src("app/routes/proxy.cancel.$id.$step.tsx");
    expect(cancel.match(/education: (?:showEducationLinks \? )?await getEducationLinks\(/g)).toHaveLength(3);
  });
});
