import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * FIRST-CYCLE ONBOARDING CARD (v1.28.0, P4.5) — "What happens next".
 *
 *  - Pure renderer: first order (name + date, delivery status + Track /
 *    View order links only when the mirror has them and the URL is https),
 *    next order + change cut-off, how to make changes, guide links, help.
 *  - Says only what it is given: no next date ⇒ no next-order row; no
 *    links ⇒ no learn row; unknown status ⇒ no badge.
 *  - Copy hygiene: never names cancellation.
 *  - Route pins: gated on portalGrowth.onboardingCard, ACTIVE, an origin order and
 *    ordersCount < 2; reads the delivery mirror (listDeliveries) contained;
 *    next date + cut-off from THE timing helpers.
 *  - Registry: portalGrowth.onboardingCard ships ON.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

vi.mock("~/lib/settings/settings.server", () => ({ getSetting: vi.fn(async () => ({})) }));

import { onboardingCardHtml } from "~/lib/portal/timeline.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

const base = {
  locale: "en",
  firstOrder: {
    name: "#1042",
    dateLabel: "1 August 2026",
    statusLabel: null,
    orderStatusUrl: null,
    trackingUrl: null,
  },
  nextDateLabel: "29 August 2026",
  cutoffLabel: "29 August 2026, 00:00",
  links: { howToUseUrl: "/pages/how-to", routineGuideUrl: "", faqUrl: "https://cellexialabs.com/pages/faq" },
  helpHref: "#cxs-support",
};

describe("onboardingCardHtml", () => {
  it("renders the four steps from what it is given, in the cxs- namespace", () => {
    const html = onboardingCardHtml(base);
    expect(html).toContain('id="cxs-onboarding"');
    expect(html).toContain("What happens next");
    expect(html).toContain("#1042 was placed on 1 August 2026.");
    expect(html).toContain("Scheduled for 29 August 2026 — you can make changes until 29 August 2026, 00:00.");
    expect(html).toContain("Skip, delay, swap or add products right here");
    expect(html).toContain('href="/pages/how-to"');
    expect(html).toContain('href="https://cellexialabs.com/pages/faq"');
    expect(html).not.toContain("Routine guide"); // empty URL ⇒ no link
    expect(html).toContain('href="#cxs-support"');
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    expect(html).not.toMatch(/cancel/i);
  });

  it("first-order status + links only when the delivery mirror has them (https only)", () => {
    const withStatus = onboardingCardHtml({
      ...base,
      firstOrder: {
        name: null,
        dateLabel: "1 August 2026",
        statusLabel: "Shipped",
        orderStatusUrl: "https://cellexialabs.com/orders/abc",
        trackingUrl: "http://insecure.example/track", // dropped
      },
    });
    expect(withStatus).toContain("Placed on 1 August 2026.");
    expect(withStatus).toContain("Shipped");
    expect(withStatus).toContain('href="https://cellexialabs.com/orders/abc"');
    expect(withStatus).not.toContain("insecure.example");
    expect(withStatus).not.toContain(">Track<");
    const noBadge = onboardingCardHtml(base);
    expect(noBadge).not.toContain("cxs-badge");
  });

  it("omits the next-order and learn rows when it has nothing truthful to say", () => {
    const html = onboardingCardHtml({
      ...base,
      firstOrder: { ...base.firstOrder, dateLabel: null, name: null },
      nextDateLabel: null,
      cutoffLabel: null,
      links: { howToUseUrl: "", routineGuideUrl: "", faqUrl: "" },
      helpHref: null,
    });
    expect(html).toContain("Placed and being prepared.");
    expect(html).not.toContain("Scheduled for");
    expect(html).not.toContain("Get the most from it.");
    expect(html).not.toContain("cxs-support");
    // Next date without a cut-off (preparing / hour unknown) ⇒ date only.
    const dateOnly = onboardingCardHtml({ ...base, cutoffLabel: null });
    expect(dateOnly).toContain("Scheduled for 29 August 2026.");
    expect(dateOnly).not.toContain("make changes until");
  });
});

describe("registry + route wiring", () => {
  it("portalGrowth.onboardingCard ships ON", () => {
    expect(settingsSchemas.portalGrowth.parse(undefined).onboardingCard).toBe(true);
  });
  it("detail route: gated on the toggle, ACTIVE and ordersCount < 2; delivery mirror + timing helpers feed it", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    // Genuinely-new gate (same as the welcome email): an origin order must
    // exist — imports/backfills never see the card, and the first-order date
    // never falls back to the mirror row's createdAt.
    expect(src).toMatch(
      /growth\.onboardingCard &&\s+isActive &&\s+contract\.ordersCount < 2 &&\s+contract\.originOrderId != null/,
    );
    expect(src).toContain("contract.originOrderProcessedAt ?? contract.firstChargeAt ?? null");
    expect(src).not.toContain("contract.originOrderProcessedAt ?? contract.firstChargeAt ?? contract.createdAt");
    // Delivery mirror (P4.2): the rows read once for the deliveries surface,
    // or a dedicated read when that toggle is off; the origin order's
    // originOrderFulfilledAt is the fallback "Shipped" fact.
    expect(src).toContain('from "~/lib/portal/deliveries.server"');
    expect(src).toContain("growth.deliveriesList\n          ? deliveryRows\n          : await listDeliveries(contract.id, {");
    expect(src).toContain("} else if (contract.originOrderFulfilledAt) {");
    expect(src).toContain("contractCutoff(contract.nextBillingDate, timing)");
    expect(src).toContain("cutoffLabel(locale, cutoff, ctx.tz)");
    // A held (dunning) order is not "scheduled": no next date on the card.
    expect(src).toContain("contract.nextBillingDate && !dunning");
    expect(src).toContain("body += onboardingCardHtml({");
  });
  it("copy hygiene: onboarding keys never name cancellation", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    const keys = Object.keys(catalog).filter((k) => k.startsWith("portal.onboarding."));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const key of keys) expect(catalog[key], key).not.toMatch(/cancel/i);
  });
});
