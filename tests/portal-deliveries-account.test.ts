import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Your deliveries" (v1.28.0, P4.2) — Account tab list + view-model.
 *
 *  1. Status truth table: delivered > shipped > processing, and "unknown"
 *     (never "processing") for charges the mirror could not have seen —
 *     before the mirror floor, or older than portal.deliveriesProcessingMaxDays.
 *  2. Queries: SUCCESS attempts only, newest first, capped, and the
 *     cross-contract list is OURS_ONLY + shop + customer scoped.
 *  3. Card HTML: cxs- classes only, Track link only for an https tracking
 *     url, "View order & receipt" = the Shopify order-status page (the
 *     receipt lives there — no invented invoices), honest empty state,
 *     javascript:/http: URLs never rendered as links, no cancellation
 *     wording (growth-copy hygiene).
 *  4. Settings: portalGrowth.deliveriesList defaults ON,
 *     portal.deliveriesProcessingMaxDays defaults 30 (3..120).
 *  5. Route pins: the account loader gates on growth.deliveriesList, reads
 *     the local mirror only (no Admin API), and is contained.
 *  6. i18n: every key the card uses exists in en.json.
 *  7. Stage E review: a charge refunded in full before anything shipped
 *     reads "refunded" (never "Being prepared") and lists no amount; the
 *     checkout (cycle-0) order is synthesized from the contract mirror so a
 *     first-cycle subscriber never sees the empty state for the order they
 *     paid for (no tracking/order-page link — the fulfillment webhooks
 *     match BillingAttempt only).
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
  deliveriesCardHtml,
  deliveryStatusOf,
  listCustomerDeliveries,
  listDeliveries,
  type DeliveryRow,
} from "~/lib/portal/deliveries.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { locales } from "~/lib/i18n/locales";

const NOW = new Date("2026-08-17T12:00:00Z");
const TZ = "Europe/Zurich";

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    contractId: "c_1",
    cycleIndex: 2,
    completedAt: new Date("2026-08-10T09:00:00Z"),
    scheduledFor: new Date("2026-08-10T00:00:00Z"),
    orderId: "gid://shopify/Order/700",
    orderName: "#1042",
    amountCents: 4900,
    currencyCode: "CHF",
    fulfilledAt: null,
    shippedAt: null,
    deliveredAt: null,
    trackingUrl: null,
    trackingCompany: null,
    trackingNumber: null,
    orderStatusUrl: "https://cellexialabs.com/12345/orders/abc/authenticate?key=k",
    contract: {
      id: "c_1",
      currencyCode: "CHF",
      lines: [{ title: "Renewal Serum" }, { title: "Night Cream" }],
    },
    ...over,
  };
}

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

// ── 1. status truth table ────────────────────────────────────────────────────

describe("deliveryStatusOf", () => {
  const base = {
    completedAt: new Date("2026-08-10T09:00:00Z"),
    scheduledFor: new Date("2026-08-10T00:00:00Z"),
    fulfilledAt: null,
    shippedAt: null,
    deliveredAt: null,
  };

  it("delivered beats shipped beats processing", () => {
    expect(deliveryStatusOf(base, { now: NOW })).toBe("processing");
    expect(deliveryStatusOf({ ...base, fulfilledAt: new Date() }, { now: NOW })).toBe("shipped");
    expect(deliveryStatusOf({ ...base, shippedAt: new Date() }, { now: NOW })).toBe("shipped");
    expect(
      deliveryStatusOf({ ...base, shippedAt: new Date(), deliveredAt: new Date() }, { now: NOW }),
    ).toBe("delivered");
  });

  it("a charge before the mirror floor with nothing mirrored is 'unknown', never 'processing'", () => {
    expect(
      deliveryStatusOf(base, { now: NOW, mirrorFloor: new Date("2026-08-12T00:00:00Z") }),
    ).toBe("unknown");
    // …but a mirrored shipment still reads shipped whatever the floor.
    expect(
      deliveryStatusOf(
        { ...base, shippedAt: new Date("2026-08-11T00:00:00Z") },
        { now: NOW, mirrorFloor: new Date("2026-08-12T00:00:00Z") },
      ),
    ).toBe("shipped");
  });

  it("refunded in full before shipping ⇒ 'refunded' (never processing); partial refund or shipped ⇒ unchanged", () => {
    expect(deliveryStatusOf({ ...base, amountCents: 4900, refundedCents: 4900 }, { now: NOW })).toBe("refunded");
    expect(deliveryStatusOf({ ...base, amountCents: 4900, refundedCents: 5000 }, { now: NOW })).toBe("refunded");
    expect(deliveryStatusOf({ ...base, amountCents: 4900, refundedCents: 1000 }, { now: NOW })).toBe("processing");
    expect(deliveryStatusOf({ ...base, amountCents: 4900, refundedCents: 0 }, { now: NOW })).toBe("processing");
    // A refund after shipping (a return) does not un-ship the row.
    expect(
      deliveryStatusOf({ ...base, shippedAt: new Date(), amountCents: 4900, refundedCents: 4900 }, { now: NOW }),
    ).toBe("shipped");
    // Unknown amount ⇒ never refunded by inference.
    expect(deliveryStatusOf({ ...base, amountCents: null, refundedCents: 4900 }, { now: NOW })).toBe("processing");
  });

  it("older than processingMaxDays (default 30) with nothing mirrored is 'unknown'", () => {
    const old = { ...base, completedAt: new Date("2026-06-01T09:00:00Z") };
    expect(deliveryStatusOf(old, { now: NOW })).toBe("unknown");
    expect(deliveryStatusOf(old, { now: NOW, processingMaxDays: 120 })).toBe("processing");
    // completedAt null → scheduledFor is the charge instant.
    expect(
      deliveryStatusOf({ ...base, completedAt: null, scheduledFor: new Date("2026-08-15T00:00:00Z") }, { now: NOW }),
    ).toBe("processing");
  });
});

// ── 2. queries ───────────────────────────────────────────────────────────────

describe("listDeliveries / listCustomerDeliveries", () => {
  it("listDeliveries: SUCCESS attempts of the contract, newest first, capped (default 10), mapped to rows", async () => {
    dbMocks.attemptFindMany.mockResolvedValue([
      attempt({ shippedAt: new Date("2026-08-11T09:00:00Z"), trackingUrl: "https://t/1", trackingCompany: "DHL" }),
      attempt({ id: "att_0", cycleIndex: 1, completedAt: new Date("2026-07-10T09:00:00Z"), orderName: "#1001", currencyCode: null }),
    ]);
    const rows = await listDeliveries("c_1", { now: NOW });
    const args = dbMocks.attemptFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(args.where).toEqual({ contractId: "c_1", status: "SUCCESS" });
    expect(args.orderBy).toEqual([{ completedAt: "desc" }, { cycleIndex: "desc" }]);
    expect(args.take).toBe(10);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attemptId: "att_1",
      orderName: "#1042",
      amountCents: 4900,
      currencyCode: "CHF",
      status: "shipped",
      trackingUrl: "https://t/1",
      trackingCompany: "DHL",
      shippedAt: new Date("2026-08-11T09:00:00Z"),
      itemsSummary: "Renewal Serum, Night Cream",
      date: new Date("2026-08-10T09:00:00Z"),
    });
    // The contract currency is the fallback; an old charge with nothing
    // mirrored is 'unknown' (38 days ago > 30).
    expect(rows[1]).toMatchObject({ currencyCode: "CHF", status: "unknown" });

    await listDeliveries("c_1", { limit: 3 });
    expect((dbMocks.attemptFindMany.mock.calls[1][0] as { take: number }).take).toBe(3);
  });

  it("listCustomerDeliveries scopes to shop + customer + OURS_ONLY (another app's renewals are not in our mirror)", async () => {
    await listCustomerDeliveries("shop_1", "gid://shopify/Customer/1", { limit: 10 });
    const args = dbMocks.attemptFindMany.mock.calls[0][0] as { where: Record<string, unknown>; take: number };
    expect(args.where).toEqual({
      status: "SUCCESS",
      contract: { shopId: "shop_1", customerId: "gid://shopify/Customer/1", ...OURS_ONLY },
    });
    expect(args.take).toBe(10);
  });

  it("the select never reads beyond the mirror columns (no Admin API, no order fetch)", () => {
    const src = readSource("app/lib/portal/deliveries.server.ts");
    expect(src).not.toMatch(/getOrderSummary|adminClientForShop|gql\(/);
    expect(src).toContain("orderStatusUrl: true");
    expect(src).toContain("trackingUrl: true");
    expect(src).toContain("deliveredAt: true");
    expect(src).toContain("refundedCents: true");
  });

  it("rows carry refundedCents from the attempt; a fully refunded unshipped charge is a 'refunded' row", async () => {
    dbMocks.attemptFindMany.mockResolvedValue([attempt({ refundedCents: 4900 })]);
    const rows = await listDeliveries("c_1", { now: NOW });
    expect(rows[0]).toMatchObject({ status: "refunded", refundedCents: 4900, amountCents: 4900 });
  });

  const originContract = (over: Record<string, unknown> = {}) => ({
    id: "c_1",
    originOrderId: "gid://shopify/Order/500",
    originOrderName: "#1001",
    originOrderProcessedAt: new Date("2026-08-05T09:00:00Z"),
    originOrderTotalCents: 5900,
    originOrderRefundedCents: 0,
    originOrderCurrencyCode: "CHF",
    originOrderFulfilledAt: new Date("2026-08-06T09:00:00Z"),
    currencyCode: "CHF",
    createdAt: new Date("2026-08-05T09:05:00Z"),
    lines: [{ title: "Renewal Serum" }],
    ...over,
  });

  it("listDeliveries synthesizes the checkout (cycle-0) row from the contract mirror: date = processedAt, amount = originOrderTotalCents, shipped from originOrderFulfilledAt, no tracking/order-page link", async () => {
    dbMocks.attemptFindMany.mockResolvedValue([attempt()]);
    dbMocks.contractFindUnique.mockResolvedValue(originContract());
    const rows = await listDeliveries("c_1", { now: NOW });
    expect(rows).toHaveLength(2);
    // Newest first: the renewal (Aug 10) above the checkout order (Aug 5).
    expect(rows[0].attemptId).toBe("att_1");
    expect(rows[1]).toMatchObject({
      attemptId: "origin:c_1",
      contractId: "c_1",
      cycleIndex: 0,
      date: new Date("2026-08-05T09:00:00Z"),
      orderId: "gid://shopify/Order/500",
      orderName: "#1001",
      amountCents: 5900,
      currencyCode: "CHF",
      status: "shipped",
      shippedAt: new Date("2026-08-06T09:00:00Z"),
      trackingUrl: null,
      orderStatusUrl: null,
      itemsSummary: "Renewal Serum",
    });
    const sel = (dbMocks.contractFindUnique.mock.calls[0][0] as { where: unknown }).where;
    expect(sel).toEqual({ id: "c_1" });
  });

  it("origin row: no origin order (import) ⇒ no row; unfulfilled ⇒ processing (then unknown past the max days); refunded in full ⇒ refunded; a failed contract read leaves the renewal rows", async () => {
    dbMocks.contractFindUnique.mockResolvedValue(originContract({ originOrderId: null }));
    expect(await listDeliveries("c_1", { now: NOW })).toHaveLength(0);
    dbMocks.contractFindUnique.mockResolvedValue(originContract({ originOrderFulfilledAt: null }));
    expect((await listDeliveries("c_1", { now: NOW }))[0].status).toBe("processing");
    dbMocks.contractFindUnique.mockResolvedValue(
      originContract({ originOrderFulfilledAt: null, originOrderProcessedAt: new Date("2026-06-01T00:00:00Z") }),
    );
    expect((await listDeliveries("c_1", { now: NOW }))[0].status).toBe("unknown");
    dbMocks.contractFindUnique.mockResolvedValue(
      originContract({ originOrderFulfilledAt: null, originOrderRefundedCents: 5900 }),
    );
    expect((await listDeliveries("c_1", { now: NOW }))[0].status).toBe("refunded");
    dbMocks.attemptFindMany.mockResolvedValue([attempt()]);
    dbMocks.contractFindUnique.mockRejectedValueOnce(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await listDeliveries("c_1", { now: NOW })).map((r) => r.attemptId)).toEqual(["att_1"]);
    spy.mockRestore();
  });

  it("listCustomerDeliveries adds each owned contract's origin row (OURS_ONLY, originOrderId set) and dedupes on orderId; the limit still caps", async () => {
    dbMocks.attemptFindMany.mockResolvedValue([attempt()]);
    dbMocks.contractFindMany.mockResolvedValue([
      originContract(),
      originContract({ id: "c_2", originOrderId: "gid://shopify/Order/700", originOrderName: "#1042" }), // same order as att_1 → deduped
    ]);
    const rows = await listCustomerDeliveries("shop_1", "gid://shopify/Customer/1", { now: NOW });
    expect(rows.map((r) => r.attemptId)).toEqual(["att_1", "origin:c_1"]);
    const where = (dbMocks.contractFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      ...OURS_ONLY,
      originOrderId: { not: null },
    });
    const capped = await listCustomerDeliveries("shop_1", "gid://shopify/Customer/1", { now: NOW, limit: 1 });
    expect(capped).toHaveLength(1);
  });
});

// ── 3. card HTML ─────────────────────────────────────────────────────────────

describe("deliveriesCardHtml", () => {
  it("renders a row with status, amount, items, Track (tracking url) and View order & receipt (order-status page) links", () => {
    const html = deliveriesCardHtml({ locale: "en", tz: TZ, rows: [row()] });
    expect(html).toContain('class="cxs-card cxs-deliveries"');
    expect(html).toContain("Your deliveries");
    expect(html).toContain("Order #1042");
    expect(html).toContain("Shipped");
    expect(html).toContain("CHF");
    expect(html).toContain("Renewal Serum, Night Cream");
    expect(html).toContain("via DHL");
    expect(html).toContain('href="https://track.example/1Z999"');
    expect(html).toContain("Track parcel");
    expect(html).toContain('href="https://cellexialabs.com/12345/orders/abc/authenticate?key=k"');
    expect(html).toContain("View order &amp; receipt");
    expect(html).toContain('rel="noopener"');
    // The receipt note names the order page as where the receipt lives.
    expect(html).toContain("cxs-deliveries__receipt-note");
    expect(html).toContain("The receipt for each order is on its order page");
    // Never a bare .cx- class, never the cancel namespace.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    expect(html).not.toContain("cxc-");
  });

  it("a refunded row says Refunded and lists no amount", () => {
    const html = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [row({ status: "refunded", refundedCents: 4900, shippedAt: null, trackingUrl: null })],
    });
    expect(html).toContain('data-status="refunded"');
    expect(html).toContain("Refunded");
    expect(html).not.toContain("Being prepared");
    expect(html).not.toContain("49.00");
  });

  it("delivered rows say Delivered {date}; processing rows have no Track link; unknown rows point to the order page", () => {
    const delivered = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [row({ status: "delivered", deliveredAt: new Date("2026-08-13T10:00:00Z") })],
    });
    expect(delivered).toContain("Delivered");
    expect(delivered).toContain('data-status="delivered"');

    const processing = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [row({ status: "processing", trackingUrl: null, trackingCompany: null, shippedAt: null })],
    });
    expect(processing).toContain("Being prepared");
    expect(processing).not.toContain("Track parcel");
    expect(processing).toContain("View order &amp; receipt");

    const unknown = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [row({ status: "unknown", trackingUrl: null, trackingCompany: null, shippedAt: null })],
    });
    expect(unknown).toContain("See the order page for shipping status");
    expect(unknown).not.toContain("Being prepared");
  });

  it("only https URLs become links (javascript:/http:/garbage from a payload never render)", () => {
    const html = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [
        row({
          trackingUrl: "javascript:alert(1)",
          orderStatusUrl: "http://insecure.example/o",
        }),
      ],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("insecure.example");
    expect(html).not.toContain("Track parcel");
    expect(html).not.toContain("View order");
    expect(html).not.toContain("cxs-deliveries__receipt-note");
  });

  it("empty: the honest empty state, or nothing at all with hideWhenEmpty", () => {
    expect(deliveriesCardHtml({ locale: "en", tz: TZ, rows: [] })).toContain("No orders yet");
    expect(deliveriesCardHtml({ locale: "en", tz: TZ, rows: [], hideWhenEmpty: true })).toBe("");
  });

  it("escapes order names and item titles", () => {
    const html = deliveriesCardHtml({
      locale: "en",
      tz: TZ,
      rows: [row({ orderName: "#<b>1", itemsSummary: "<script>x</script>" })],
    });
    expect(html).not.toContain("<b>1");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("copy hygiene: the deliveries copy never names cancellation or pressure words", () => {
    const en = locales.en as Record<string, string>;
    const keys = Object.keys(en).filter((k) => k.startsWith("portal.deliveries."));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const k of keys) {
      expect(en[k], k).not.toMatch(/cancel|hurry|last chance|only today|invoice PDF/i);
    }
  });
});

// ── 4. settings ──────────────────────────────────────────────────────────────

describe("settings", () => {
  it("portalGrowth.deliveriesList defaults ON; portal.deliveriesProcessingMaxDays defaults 30 within 3..120", () => {
    expect(settingsSchemas.portalGrowth.parse(undefined).deliveriesList).toBe(true);
    expect(settingsSchemas.portalGrowth.parse({ deliveriesList: false }).deliveriesList).toBe(false);
    const portal = settingsSchemas.portal.parse(undefined) as { deliveriesProcessingMaxDays: number };
    expect(portal.deliveriesProcessingMaxDays).toBe(30);
    expect(settingsSchemas.portal.safeParse({ ...portal, deliveriesProcessingMaxDays: 2 }).success).toBe(false);
    expect(settingsSchemas.portal.safeParse({ ...portal, deliveriesProcessingMaxDays: 121 }).success).toBe(false);
  });

  it("both are exposed on the admin Settings page", () => {
    const src = readSource("app/routes/app.settings.tsx");
    expect(src).toContain('path: "deliveriesList"');
    expect(src).toContain('path: "deliveriesProcessingMaxDays"');
  });
});

// ── 5. route pins ────────────────────────────────────────────────────────────

describe("proxy.account.tsx wiring", () => {
  const src = readSource("app/routes/proxy.account.tsx");

  it("renders the card only when growth.deliveriesList is on, from the local mirror, last 10, contained", () => {
    expect(src).toContain('getSetting(shop.id, "portalGrowth")');
    expect(src).toContain("if (growth.deliveriesList)");
    expect(src).toContain("listCustomerDeliveries(shop.id, portalSession.customerId, {");
    expect(src).toContain("limit: 10");
    expect(src).toContain("processingMaxDays: portalSettings.deliveriesProcessingMaxDays");
    expect(src).toContain("hideWhenEmpty: true");
    // Contained: the card can fail, the page cannot.
    const block = src.slice(src.indexOf("let deliveriesHtml"), src.indexOf("const body = `"));
    expect(block).toContain("try {");
    expect(block).toContain("catch (err)");
    expect(block).toContain('deliveriesHtml = ""');
    // Placed in the body between the subscriptions card and support.
    expect(src.indexOf("${deliveriesHtml}")).toBeGreaterThan(src.indexOf("portal.account.your_subscriptions"));
    expect(src.indexOf("${deliveriesHtml}")).toBeLessThan(src.indexOf("${supportHtml}"));
    // No Admin API on the account page.
    expect(src).not.toMatch(/adminClientForShop|getOrderSummary/);
  });
});

// ── 6. i18n keys ─────────────────────────────────────────────────────────────

describe("en.json carries every deliveries key the card uses", () => {
  it("keys exist", () => {
    const en = locales.en as Record<string, string>;
    for (const key of [
      "portal.deliveries.title",
      "portal.deliveries.row_title",
      "portal.deliveries.status.processing",
      "portal.deliveries.status.shipped",
      "portal.deliveries.status.delivered",
      "portal.deliveries.status.unknown",
      "portal.deliveries.status.refunded",
      "portal.deliveries.shipped_on",
      "portal.deliveries.delivered_on",
      "portal.deliveries.carrier",
      "portal.deliveries.track",
      "portal.deliveries.view_order",
      "portal.deliveries.receipt_note",
      "portal.deliveries.empty",
    ]) {
      expect(en[key], key).toBeTypeOf("string");
    }
    expect(en["portal.deliveries.row_title"]).toContain("{order}");
    expect(en["portal.deliveries.row_title"]).toContain("{date}");
  });
});
