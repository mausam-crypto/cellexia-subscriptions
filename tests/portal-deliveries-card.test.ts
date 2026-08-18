import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Your deliveries" (v1.28.0, P4.2) — PORTAL surfaces:
 *
 *  1. latestInTransit: only the NEWEST row counts, only when shipped and
 *     not delivered, only within portal.deliveriesInTransitMaxDays of the
 *     ship instant (a weeks-old parcel is never "on its way").
 *  2. inTransitBannerHtml (detail, under the hero): "Your {date} order is on
 *     its way — Track", role="status", cxs- only; falls back to the order
 *     page when there is no tracking URL; no link when neither is https.
 *  3. inTransitLineHtml (home card): "On its way · Track", role="status".
 *  4. latestDeliveryByContract: one distinct-per-contract SUCCESS query.
 *  5. Settings: portal.deliveriesInTransitMaxDays defaults 14 (2..60) and is
 *     exposed on the admin Settings page.
 *  6. Route pins: the detail loader reads the mirror once behind
 *     growth.deliveriesList (last 5, contained), renders the banner right
 *     after the hero block, the deliveries card before the support card,
 *     and the onboarding card reads the real first-order status (mirror row,
 *     else the origin order's originOrderFulfilledAt ⇒ "Shipped", else no
 *     claim). The home loader batches the read and hands each card its line.
 *  7. i18n: every new key exists in en.json; copy hygiene.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const dbMocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    billingAttempt: { findMany: dbMocks.attemptFindMany },
    subscriptionContract: {
      findUnique: dbMocks.contractFindUnique,
      findMany: dbMocks.contractFindMany,
    },
  },
}));

import {
  inTransitBannerHtml,
  inTransitLineHtml,
  latestDeliveryByContract,
  latestInTransit,
  type DeliveryRow,
} from "~/lib/portal/deliveries.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { locales } from "~/lib/i18n/locales";

const NOW = new Date("2026-08-17T12:00:00Z");
const TZ = "Europe/Zurich";

function row(over: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    attemptId: "att_1",
    contractId: "c_1",
    cycleIndex: 2,
    date: new Date("2026-08-10T09:00:00Z"),
    orderId: "gid://shopify/Order/700",
    orderName: "#1042",
    amountCents: 4900,
    refundedCents: 0,
    currencyCode: "CHF",
    status: "shipped",
    trackingUrl: "https://track.example/1Z999",
    trackingCompany: "DHL",
    trackingNumber: "1Z999",
    orderStatusUrl: "https://cellexialabs.com/12345/orders/abc/authenticate?key=k",
    shippedAt: new Date("2026-08-11T09:00:00Z"),
    deliveredAt: null,
    itemsSummary: "Renewal Serum, Night Cream",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.attemptFindMany.mockResolvedValue([]);
});

// ── 1. latestInTransit ───────────────────────────────────────────────────────

describe("latestInTransit", () => {
  it("returns the newest row when it is shipped, not delivered, within the window", () => {
    const r = row();
    expect(latestInTransit([r, row({ attemptId: "old", status: "delivered" })], { now: NOW })).toBe(r);
  });

  it("null for empty, delivered, processing or unknown newest rows", () => {
    expect(latestInTransit([], { now: NOW })).toBeNull();
    expect(latestInTransit([row({ status: "delivered", deliveredAt: NOW })], { now: NOW })).toBeNull();
    expect(latestInTransit([row({ status: "processing", shippedAt: null })], { now: NOW })).toBeNull();
    expect(latestInTransit([row({ status: "unknown", shippedAt: null })], { now: NOW })).toBeNull();
  });

  it("only the NEWEST row counts — an older shipped parcel behind a newer charge is not announced", () => {
    const newer = row({ attemptId: "new", status: "processing", shippedAt: null });
    const older = row({ attemptId: "old" });
    expect(latestInTransit([newer, older], { now: NOW })).toBeNull();
  });

  it("truth guard: shipped longer than maxDays ago (default 14) is not 'on its way'; the merchant window applies", () => {
    const stale = row({ shippedAt: new Date("2026-07-20T09:00:00Z") }); // 28 days
    expect(latestInTransit([stale], { now: NOW })).toBeNull();
    expect(latestInTransit([stale], { now: NOW, maxDays: 30 })).toBe(stale);
    const fresh = row({ shippedAt: new Date("2026-08-05T09:00:00Z") }); // 12 days
    expect(latestInTransit([fresh], { now: NOW })).toBe(fresh);
    expect(latestInTransit([fresh], { now: NOW, maxDays: 7 })).toBeNull();
    // a shipped row with no ship instant cannot be bounded — not announced
    expect(latestInTransit([row({ shippedAt: null })], { now: NOW })).toBeNull();
  });
});

// ── 2/3. HTML ────────────────────────────────────────────────────────────────

describe("inTransitBannerHtml / inTransitLineHtml", () => {
  it("banner: date, 'on its way', Track link (https tracking url), role=status, cxs- classes only", () => {
    const html = inTransitBannerHtml({ locale: "en", tz: TZ, row: row() });
    expect(html).toContain('role="status"');
    expect(html).toContain("cxs-deliveries__transit");
    expect(html).toContain("order is on its way");
    expect(html).toContain('href="https://track.example/1Z999"');
    expect(html).toContain(">Track<");
    expect(html).toContain('rel="noopener"');
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    expect(html).not.toMatch(/cancel/i);
  });

  it("banner: falls back to the order-status page when there is no tracking url; no link when neither is https", () => {
    const orderOnly = inTransitBannerHtml({ locale: "en", tz: TZ, row: row({ trackingUrl: null }) });
    expect(orderOnly).toContain("cellexialabs.com/12345/orders/abc");
    expect(orderOnly).toContain(">View order<");
    expect(orderOnly).not.toContain(">Track<");
    const bare = inTransitBannerHtml({
      locale: "en",
      tz: TZ,
      row: row({ trackingUrl: "javascript:alert(1)", orderStatusUrl: "http://insecure.example/o" }),
    });
    expect(bare).toContain("on its way");
    expect(bare).not.toContain("<a ");
    expect(bare).not.toContain("javascript:");
    expect(bare).not.toContain("insecure.example");
  });

  it("empty when there is no in-transit row", () => {
    expect(inTransitBannerHtml({ locale: "en", tz: TZ, row: null })).toBe("");
    expect(inTransitLineHtml({ locale: "en", row: null })).toBe("");
  });

  it("home line: 'On its way · Track', role=status, cxs- classes only", () => {
    const html = inTransitLineHtml({ locale: "en", row: row() });
    expect(html).toContain('role="status"');
    expect(html).toContain("cxs-deliveries__transit-line");
    expect(html).toContain("On its way");
    expect(html).toContain(">Track<");
    expect(html).toContain('href="https://track.example/1Z999"');
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    const noLinks = inTransitLineHtml({ locale: "en", row: row({ trackingUrl: null, orderStatusUrl: null }) });
    expect(noLinks).toContain("On its way");
    expect(noLinks).not.toContain("<a ");
  });
});

// ── 4. batch query ───────────────────────────────────────────────────────────

describe("latestDeliveryByContract", () => {
  it("one SUCCESS query, newest first, distinct per contract; empty input ⇒ no query", async () => {
    expect((await latestDeliveryByContract([])).size).toBe(0);
    expect(dbMocks.attemptFindMany).not.toHaveBeenCalled();

    dbMocks.attemptFindMany.mockResolvedValue([
      {
        id: "a1",
        contractId: "c_1",
        cycleIndex: 3,
        completedAt: new Date("2026-08-12T09:00:00Z"),
        scheduledFor: new Date("2026-08-12T00:00:00Z"),
        orderId: "gid://shopify/Order/1",
        orderName: "#1",
        amountCents: 100,
        currencyCode: "CHF",
        fulfilledAt: null,
        shippedAt: new Date("2026-08-13T09:00:00Z"),
        deliveredAt: null,
        trackingUrl: "https://t.example/1",
        trackingCompany: null,
        trackingNumber: null,
        orderStatusUrl: null,
        contract: { id: "c_1", currencyCode: "CHF", lines: [{ title: "Serum" }] },
      },
      {
        id: "a2",
        contractId: "c_2",
        cycleIndex: 1,
        completedAt: new Date("2026-08-01T09:00:00Z"),
        scheduledFor: new Date("2026-08-01T00:00:00Z"),
        orderId: null,
        orderName: null,
        amountCents: null,
        currencyCode: null,
        fulfilledAt: null,
        shippedAt: null,
        deliveredAt: null,
        trackingUrl: null,
        trackingCompany: null,
        trackingNumber: null,
        orderStatusUrl: null,
        contract: { id: "c_2", currencyCode: "CHF", lines: [] },
      },
    ]);
    const map = await latestDeliveryByContract(["c_1", "c_2"], { now: NOW });
    expect(dbMocks.attemptFindMany).toHaveBeenCalledTimes(1);
    const args = dbMocks.attemptFindMany.mock.calls[0][0] as {
      where: { contractId: { in: string[] }; status: string };
      distinct: string[];
      orderBy: unknown[];
    };
    expect(args.where.status).toBe("SUCCESS");
    expect(args.where.contractId.in).toEqual(["c_1", "c_2"]);
    expect(args.distinct).toEqual(["contractId"]);
    expect(args.orderBy[0]).toEqual({ completedAt: "desc" });
    expect(map.get("c_1")?.status).toBe("shipped");
    expect(map.get("c_2")?.status).toBe("processing");
    expect(latestInTransit([map.get("c_1")!], { now: NOW })?.attemptId).toBe("a1");
  });
});

// ── 5. settings ──────────────────────────────────────────────────────────────

describe("settings", () => {
  it("portal.deliveriesInTransitMaxDays defaults 14 within 2..60 and is exposed on the Settings page", () => {
    const portal = settingsSchemas.portal.parse(undefined) as { deliveriesInTransitMaxDays: number };
    expect(portal.deliveriesInTransitMaxDays).toBe(14);
    expect(settingsSchemas.portal.safeParse({ ...portal, deliveriesInTransitMaxDays: 1 }).success).toBe(false);
    expect(settingsSchemas.portal.safeParse({ ...portal, deliveriesInTransitMaxDays: 61 }).success).toBe(false);
    expect(settingsSchemas.portal.safeParse({ ...portal, deliveriesInTransitMaxDays: 30 }).success).toBe(true);
    expect(readSource("app/routes/app.settings.tsx")).toContain('path: "deliveriesInTransitMaxDays"');
  });
});

// ── 6. route pins ────────────────────────────────────────────────────────────

describe("proxy.subscription.$id.tsx wiring", () => {
  const src = readSource("app/routes/proxy.subscription.$id.tsx");

  it("reads the mirror once behind growth.deliveriesList (last 5, merchant windows), contained", () => {
    expect(src).toContain('from "~/lib/portal/deliveries.server"');
    expect(src).toContain("if (growth.deliveriesList) {\n    try {\n      deliveryRows = await listDeliveries(contract.id, {\n        limit: 5,");
    expect(src).toContain("processingMaxDays: portalSettings.deliveriesProcessingMaxDays");
    expect(src).toContain("maxDays: portalSettings.deliveriesInTransitMaxDays");
    expect(src).toContain('console.error("[portal] deliveries read failed"');
    // no dynamic import left behind — the module is imported once at the top
    expect(src).not.toContain('await import(\n          "~/lib/portal/deliveries.server"');
  });

  it("banner right after the hero / status block, before the dunning banner; card before the support card", () => {
    const hero = src.indexOf("body += nextDeliveryHeroHtml({");
    const banner = src.indexOf("body += inTransitBannerHtml({ locale, tz: ctx.tz, row: inTransit });");
    const dunningBanner = src.indexOf("body += dunningBannerHtml({");
    const card = src.indexOf("body += deliveriesCardHtml({");
    const support = src.indexOf("body += supportCardHtml({");
    expect(hero).toBeGreaterThan(0);
    expect(banner).toBeGreaterThan(hero);
    expect(dunningBanner).toBeGreaterThan(banner);
    expect(card).toBeGreaterThan(dunningBanner);
    expect(support).toBeGreaterThan(card);
    // the card is gated and hides when nothing has been charged yet
    const cardBlock = src.slice(card - 40, card + 200);
    expect(src.slice(card - 120, card)).toContain("if (growth.deliveriesList) {");
    expect(cardBlock).toContain("rows: deliveryRows");
    expect(cardBlock).toContain("hideWhenEmpty: true");
  });

  it("onboarding card: real first-order status — mirror row first, else originOrderFulfilledAt ⇒ Shipped, else no claim", () => {
    const start = src.indexOf("growth.onboardingCard &&\n    isActive &&\n    contract.ordersCount < 2 &&");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("body += onboardingCardHtml({", start));
    expect(block).toContain("growth.deliveriesList\n          ? deliveryRows\n          : await listDeliveries(contract.id, {");
    expect(block).toContain("r.orderId === contract.originOrderId");
    expect(block).toContain('first.status === "unknown" ? null : deliveryStatusLabel(locale, first.status)');
    expect(block).toContain("} else if (contract.originOrderFulfilledAt) {");
    expect(block).toContain('statusLabel: deliveryStatusLabel(locale, "shipped")');
    // never "being prepared" for a checkout order the mirror never saw
    expect(block).not.toContain('deliveryStatusLabel(locale, "processing")');
  });
});

describe("proxy._index.tsx wiring", () => {
  const src = readSource("app/routes/proxy._index.tsx");

  it("batches the newest charge per contract behind growth.deliveriesList and hands each card its line, contained", () => {
    expect(src).toContain('from "~/lib/portal/deliveries.server"');
    expect(src).toContain("if (growth.deliveriesList) {\n      try {\n        const latest = await latestDeliveryByContract(");
    expect(src).toContain("maxDays: portalSettings.deliveriesInTransitMaxDays");
    expect(src).toContain('console.error("[portal] in-transit lines (home) failed"');
    expect(src).toContain('inTransitLine: inTransitLines.get(contract.id) ?? "",');
    expect(src).toContain('${params.inTransitLine ?? ""}');
  });
});

// ── 7. i18n ──────────────────────────────────────────────────────────────────

describe("en.json carries every in-transit key; copy hygiene", () => {
  it("keys exist and never name cancellation", () => {
    const en = locales.en as Record<string, string>;
    for (const key of [
      "portal.deliveries.in_transit",
      "portal.deliveries.in_transit_short",
      "portal.deliveries.track_short",
      "portal.deliveries.view_order_short",
    ]) {
      expect(en[key], key).toBeTypeOf("string");
      expect(en[key]).not.toMatch(/cancel/i);
    }
    expect(en["portal.deliveries.in_transit"]).toContain("{date}");
  });
});
