import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Acquisition capture pipeline (migration 0006, docs/DATA_FOUNDATION.md):
 * ORDERS_CREATE payload → pure sanitizer → contract columns, and the
 * CUSTOMERS_REDACT eraser that ends the profile with the identity.
 *
 * The privacy contract pinned here is non-negotiable:
 *  - URLs are stripped of emails / phone runs / token-shaped strings and keep
 *    host + path + utm_* ONLY, hard length caps everywhere;
 *  - the full user agent dies at the device class; the IP is never even read
 *    (the sanitized bundle's key set is closed — asserted exactly);
 *  - the ORDERS_CREATE handler maps payload → columns (device type, units,
 *    value band, UTM), persists idempotently (acqRaw-still-null atomic claim)
 *    and only onto contracts we own;
 *  - time-to-purchase math clamps clock skew and never invents a value;
 *  - CUSTOMERS_REDACT nulls EVERY acq* column — the list is derived from
 *    prisma/schema.prisma, so adding an acq column without wiring its
 *    redaction fails this suite (the handler comment says MANDATORY; this
 *    test is the enforcement).
 *
 * Webhook module mocking follows tests/widget-design.test.ts.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(
    async (): Promise<unknown> => ({
      id: "shop_1",
      domain: "cellexia-test.myshopify.com",
    }),
  ),
  sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  subscriberEventUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  contractFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  shopFindUnique: vi.fn(
    async (): Promise<unknown> => ({
      id: "shop_1",
      domain: "cellexia-test.myshopify.com",
    }),
  ),
  notificationLogUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  otpCodeDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  portalSessionDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  magicLinkTokenDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  klaviyoOutboxDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  klaviyoOutboxUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  alertCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  alertFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  alertUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  getCustomer: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      updateMany: mocks.subscriberEventUpdateMany,
    },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findMany: mocks.contractFindMany,
      updateMany: mocks.contractUpdateMany,
    },
    shop: { findUnique: mocks.shopFindUnique },
    notificationLog: { updateMany: mocks.notificationLogUpdateMany },
    otpCode: { deleteMany: mocks.otpCodeDeleteMany },
    portalSession: { deleteMany: mocks.portalSessionDeleteMany },
    magicLinkToken: { deleteMany: mocks.magicLinkTokenDeleteMany },
    klaviyoOutbox: {
      deleteMany: mocks.klaviyoOutboxDeleteMany,
      updateMany: mocks.klaviyoOutboxUpdateMany,
    },
    alert: {
      create: mocks.alertCreate,
      findMany: mocks.alertFindMany,
      update: mocks.alertUpdate,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));

vi.mock("~/lib/settings/settings.server", () => ({ getSetting: vi.fn() }));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

vi.mock("~/lib/graphql/customers.server", () => ({
  getCustomer: mocks.getCustomer,
}));

import {
  ACQ_FIELD_MAX,
  ACQ_URL_MAX,
  buildAcquisitionCapture,
  deviceTypeFromUserAgent,
  sanitizeAcquisitionUrl,
  timeToPurchaseSeconds,
  utmFromUrl,
} from "~/lib/acquisition/sanitize";
import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
  });
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
  });
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.contractUpdateMany.mockResolvedValue({ count: 1 });
  mocks.klaviyoOutboxDeleteMany.mockResolvedValue({ count: 0 });
  mocks.klaviyoOutboxUpdateMany.mockResolvedValue({ count: 0 });
  mocks.alertFindMany.mockResolvedValue([]);
  mocks.getCustomer.mockResolvedValue(null);
});

// ── Sanitizer: the privacy rules as executable spec ──────────────────────────

describe("sanitizeAcquisitionUrl", () => {
  it("strips an email smuggled in the query, keeps the utm params", () => {
    const out = sanitizeAcquisitionUrl(
      "https://cellexialabs.com/pages/thanks?email=jane.doe@example.com&utm_source=newsletter",
    )!;
    expect(out).not.toContain("jane.doe");
    expect(out).not.toContain("example.com&"); // the email's domain is gone with it
    expect(out).toContain("utm_source=newsletter");
  });

  it("strips phone-length digit runs from the path", () => {
    const out = sanitizeAcquisitionUrl(
      "https://cellexialabs.com/ref/+41791234567/landing",
    )!;
    expect(out).not.toContain("41791234567");
    expect(out).toContain("[redacted]");
  });

  it("drops checkout/session tokens with the rest of the non-utm query", () => {
    const out = sanitizeAcquisitionUrl(
      "https://cellexialabs.com/products/serum?key=tok_AbCdEf1234567890XyZ&session=deadbeefdeadbeefdeadbeef&utm_campaign=launch",
    )!;
    expect(out).not.toContain("tok_");
    expect(out).not.toContain("deadbeef");
    expect(out).toBe("cellexialabs.com/products/serum?utm_campaign=launch");
  });

  it("scrubs token-shaped path segments (Shopify checkout URLs)", () => {
    const out = sanitizeAcquisitionUrl(
      "https://shop.example/checkouts/cn/AbCdEf1234567890AbCdEf12/thank_you",
    )!;
    expect(out).not.toContain("AbCdEf1234567890AbCdEf12");
  });

  it("keeps relative landing sites in path form (Shopify's usual shape)", () => {
    expect(sanitizeAcquisitionUrl("/products/serum?utm_source=ig&fbclid=SECRET")).toBe(
      "/products/serum?utm_source=ig",
    );
  });

  it("hard-caps output at ACQ_URL_MAX even for a hostile mega-URL", () => {
    const out = sanitizeAcquisitionUrl(
      `https://x.example/${"a/".repeat(2000)}?utm_source=${"s".repeat(500)}`,
    )!;
    expect(out.length).toBeLessThanOrEqual(ACQ_URL_MAX);
  });

  it("scrubs and caps unparseable input instead of storing it raw", () => {
    const out = sanitizeAcquisitionUrl(
      "android-app://com.google.android.gm mail from jane@example.com",
    )!;
    expect(out).not.toContain("jane@example.com");
  });

  it("returns null for empty/absent input", () => {
    expect(sanitizeAcquisitionUrl("")).toBeNull();
    expect(sanitizeAcquisitionUrl(undefined)).toBeNull();
    expect(sanitizeAcquisitionUrl(42)).toBeNull();
  });
});

describe("utmFromUrl", () => {
  it("extracts the five utm params and nothing else", () => {
    const utm = utmFromUrl(
      "/products/x?utm_source=ig&utm_medium=paid&utm_campaign=launch&utm_term=serum&utm_content=v2&gclid=SECRET",
    )!;
    expect(utm).toEqual({
      source: "ig",
      medium: "paid",
      campaign: "launch",
      term: "serum",
      content: "v2",
    });
  });

  it("scrubs PII inside utm values and caps their length", () => {
    const utm = utmFromUrl(
      `/x?utm_source=jane@example.com&utm_campaign=${"c".repeat(400)}`,
    )!;
    expect(utm.source).not.toContain("jane@example.com");
    expect(utm.campaign!.length).toBeLessThanOrEqual(ACQ_FIELD_MAX);
  });

  it("null when the URL carries no utm at all — null column means no UTM", () => {
    expect(utmFromUrl("/products/serum?fbclid=SECRET")).toBeNull();
    expect(utmFromUrl(null)).toBeNull();
  });
});

describe("deviceTypeFromUserAgent", () => {
  it("classifies the big four and returns null for absent input", () => {
    expect(deviceTypeFromUserAgent(IPHONE_UA)).toBe("mobile");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      ),
    ).toBe("desktop");
    expect(
      deviceTypeFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)"),
    ).toBe("tablet");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36", // no "Mobile" token
      ),
    ).toBe("tablet");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari",
      ),
    ).toBe("mobile");
    expect(deviceTypeFromUserAgent("")).toBeNull();
    expect(deviceTypeFromUserAgent(undefined)).toBeNull();
  });
});

describe("timeToPurchaseSeconds", () => {
  it("browse-to-buy latency in whole seconds", () => {
    expect(
      timeToPurchaseSeconds(
        new Date("2026-08-01T00:00:00Z"),
        new Date("2026-08-01T02:30:00Z"),
      ),
    ).toBe(9000);
  });

  it("clamps clock skew at 0 — never stores a negative", () => {
    expect(
      timeToPurchaseSeconds(
        new Date("2026-08-01T00:00:10Z"),
        new Date("2026-08-01T00:00:00Z"),
      ),
    ).toBe(0);
  });

  it("null when either instant is missing or invalid", () => {
    expect(timeToPurchaseSeconds(null, new Date())).toBeNull();
    expect(timeToPurchaseSeconds(new Date(), undefined)).toBeNull();
    expect(timeToPurchaseSeconds(new Date("nope"), new Date())).toBeNull();
  });
});

describe("buildAcquisitionCapture — the bundle never carries IP or full UA", () => {
  const capture = buildAcquisitionCapture({
    referringSite: "https://instagram.com/cellexia?igshid=AbCdEf1234567890XyZw12",
    landingSite: "/products/serum?utm_source=ig&utm_campaign=launch&fbclid=SECRET",
    sourceName: "web",
    userAgent: IPHONE_UA,
    countryCode: "ch",
    city: "Zürich",
    provinceCode: "zh",
    unitsFirstOrder: 3,
    orderId: "gid://shopify/Order/999001",
    orderTotalCents: 8490,
    orderCurrencyCode: "CHF",
    orderProcessedAt: new Date("2026-08-01T02:30:00Z"),
  });

  it("reduces the UA to a device class; the raw string appears nowhere", () => {
    expect(capture.acqDeviceType).toBe("mobile");
    expect(JSON.stringify(capture)).not.toContain("AppleWebKit");
    expect(JSON.stringify(capture)).not.toContain("iPhone OS");
  });

  it("derives the column values", () => {
    expect(capture.acqCountryCode).toBe("CH");
    expect(capture.acqProvinceCode).toBe("ZH");
    expect(capture.acqCity).toBe("Zürich");
    expect(capture.acqUnitsFirstOrder).toBe(3);
    expect(capture.acqOrderValueBand).toBe("75_100"); // 84.90 major units
    expect(capture.acqUtm).toEqual({
      source: "ig",
      medium: null,
      campaign: "launch",
      term: null,
      content: null,
    });
    expect(capture.acqLandingSite).toBe(
      "/products/serum?utm_source=ig&utm_campaign=launch",
    );
  });

  it("acqRaw's key set is CLOSED — no room for an IP or UA to sneak in", () => {
    expect(Object.keys(capture.acqRaw).sort()).toEqual(
      [
        "v",
        "orderId",
        "sourceName",
        "landingSite",
        "referringSite",
        "utm",
        // Capped-only recompute reserve for the utm scrub — deliberately
        // unscrubbed, rides inside acqRaw so CUSTOMERS_REDACT clears it.
        "rawUtm",
        // v1.16.0: presence-only paid-channel label from ad click-id params
        // (the ids themselves are never stored) — traffic-source ladder input.
        "paidChannel",
        // v1.16.0: capture-time self-referral verdict (referrer host vs the
        // shop's own domains) — internal navigation must not read "referral".
        "referrerInternal",
        "countryCode",
        "provinceCode",
        "city",
        "deviceType",
        "unitsFirstOrder",
        "orderTotalCents",
        "orderCurrencyCode",
        "orderValueBand",
        "orderProcessedAt",
        // Order-payload extras (ACQ-7): always present, null when the ingest
        // cannot supply them.
        "discountCodes",
        "checkoutLocale",
        "presentmentCurrencyCode",
        "presentmentTotalCents",
        "appId",
        "sourceIdentifier",
        "buyerAcceptsMarketing",
        "orderTags",
      ].sort(),
    );
    const raw = JSON.stringify(capture.acqRaw).toLowerCase();
    expect(raw).not.toContain("ip");
    expect(raw).not.toContain("useragent");
    expect(raw).not.toContain("user_agent");
  });
});

// ── ORDERS_CREATE: payload → capture → columns ───────────────────────────────

describe("ORDERS_CREATE acquisition capture", () => {
  const ORDER_GID = "gid://shopify/Order/999001";

  function orderPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 999001,
      admin_graphql_api_id: ORDER_GID,
      name: "#1042",
      email: "buyer@cellexia.example",
      customer: { id: 77, admin_graphql_api_id: "gid://shopify/Customer/77" },
      source_name: "web",
      currency: "CHF",
      total_price: "84.90",
      processed_at: "2026-08-01T02:30:00Z",
      landing_site: "/products/serum?utm_source=ig&fbclid=SECRET123",
      referring_site: "https://instagram.com/cellexia",
      client_details: { user_agent: IPHONE_UA, browser_ip: "203.0.113.7" },
      shipping_address: { country_code: "CH", city: "Zürich", province_code: "ZH" },
      line_items: [
        { product_id: 111, selling_plan_id: 777, quantity: 2, properties: [] },
        { product_id: 222, selling_plan_id: 777, quantity: 1, properties: [] },
      ],
      ...over,
    };
  }

  async function run(payload: Record<string, unknown>): Promise<void> {
    await webhookHandlers.ORDERS_CREATE({
      shopDomain: "cellexia-test.myshopify.com",
      payload,
      webhookId: "wh_acq_1",
    });
  }

  function stashEvents(): Record<string, unknown>[] {
    return mocks.logEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "acquisition.captured");
  }

  it("stashes the sanitized bundle keyed by the order id", async () => {
    await run(orderPayload());
    const stash = stashEvents();
    expect(stash).toHaveLength(1);
    const payload = stash[0].payload as {
      orderId: string;
      acquisition: Record<string, unknown>;
    };
    expect(payload.orderId).toBe(ORDER_GID);
    expect(payload.acquisition.acqDeviceType).toBe("mobile");
    expect(payload.acquisition.acqUnitsFirstOrder).toBe(3); // Σ quantities
    expect(payload.acquisition.acqOrderValueBand).toBe("75_100");
    // The stash carries the order's CUSTOMER identity, not just the email:
    // CUSTOMERS_REDACT matches on customer.id, and a customer who changes
    // their store email between checkout and erasure would otherwise leave
    // this bundle unreachable by every identity filter.
    expect(stash[0].customerId).toBe("gid://shopify/Customer/77");
    // The stash is as clean as the columns: no IP, no UA, no fbclid.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("203.0.113.7");
    expect(raw).not.toContain("AppleWebKit");
    expect(raw).not.toContain("SECRET123");
  });

  it("persists directly onto an existing OURS contract mirror (atomic acqRaw-null claim)", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: null,
      customerId: "gid://shopify/Customer/77",
      email: "buyer@cellexia.example",
      originOrderProcessedAt: null,
    });
    mocks.getCustomer.mockResolvedValue({
      createdAt: new Date("2026-08-01T00:00:00Z"),
      numberOfOrders: 1,
    });

    await run(orderPayload());

    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    const args = mocks.contractUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // The idempotency claim: only a still-SQL-null acqRaw is filled.
    expect(args.where.id).toBe("cm_c1");
    expect((args.where.acqRaw as { equals: unknown }).equals).toBe(Prisma.AnyNull);

    expect(args.data).toMatchObject({
      acqSourceName: "web",
      acqCountryCode: "CH",
      acqCity: "Zürich",
      acqProvinceCode: "ZH",
      acqDeviceType: "mobile",
      acqUnitsFirstOrder: 3,
      acqOrderValueBand: "75_100",
      acqLandingSite: "/products/serum?utm_source=ig",
      // account created 00:00, order processed 02:30 → 9000s browse-to-buy.
      acqTimeToPurchaseSeconds: 9000,
    });
    expect(args.data.acqUtm).toMatchObject({ source: "ig" });
    const acqRaw = args.data.acqRaw as Record<string, unknown>;
    expect(acqRaw.timeToPurchaseSeconds).toBe(9000);
    expect(acqRaw.customerCreatedAt).toBe("2026-08-01T00:00:00.000Z");
    // Nothing UA/IP-shaped reaches the row.
    const raw = JSON.stringify(args.data);
    expect(raw).not.toContain("203.0.113.7");
    expect(raw).not.toContain("AppleWebKit");

    // The capture is announced on the contract's event stream.
    const captured = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .find(
        (e) =>
          e.type === "contract.updated" &&
          (e.payload as Record<string, unknown>).action === "acquisition_captured",
      );
    expect(captured).toBeDefined();
  });

  it("is idempotent: a contract whose acqRaw is already set is never rewritten", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: { v: 1 },
      customerId: null,
      email: null,
      originOrderProcessedAt: null,
    });
    await run(orderPayload());
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
  });

  it("a lost claim race (updateMany count 0) logs no capture event", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: null,
      customerId: null,
      email: null,
      originOrderProcessedAt: null,
    });
    mocks.contractUpdateMany.mockResolvedValue({ count: 0 });
    await run(orderPayload());
    const captured = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .filter(
        (e) =>
          e.type === "contract.updated" &&
          (e.payload as Record<string, unknown>).action === "acquisition_captured",
      );
    expect(captured).toHaveLength(0);
  });

  it("never profiles another app's subscriber (FOREIGN/UNKNOWN contracts untouched)", async () => {
    for (const ownership of ["FOREIGN", "UNKNOWN"]) {
      mocks.contractUpdateMany.mockClear();
      mocks.contractFindFirst.mockResolvedValue({
        id: "cm_joy",
        shopId: "shop_1",
        ownership,
        acqRaw: null,
        customerId: null,
        email: null,
        originOrderProcessedAt: null,
      });
      await run(orderPayload());
      expect(mocks.contractUpdateMany, ownership).not.toHaveBeenCalled();
    }
  });

  it("one-time orders (no selling-plan line) produce no acquisition stash", async () => {
    await run(
      orderPayload({
        line_items: [{ product_id: 111, quantity: 2, properties: [] }],
      }),
    );
    expect(stashEvents()).toHaveLength(0);
  });

  it("marker-less REST payloads still stash via the productIds fallback", async () => {
    // The payload variant the take-rate fallback exists for: Shopify's REST
    // order webhook omits selling_plan_allocation/selling_plan/selling_plan_id
    // on every line even though the checkout was a subscription. Acquisition
    // must use the SAME containsSubscribable fallback — gating it on the
    // marker alone would zero the acquisition foundation for such shops, and
    // the order-id idempotency guard makes the loss permanent (no redelivery
    // ever reaches the block again).
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      { productIds: ["gid://shopify/Product/111"] },
    ]);
    await run(
      orderPayload({
        line_items: [{ product_id: 111, quantity: 3, properties: [] }],
      }),
    );
    const stash = stashEvents();
    expect(stash).toHaveLength(1);
    expect((stash[0].payload as { orderId: string }).orderId).toBe(ORDER_GID);
    // The take-rate denominator still counts the order exactly once.
    const checkouts = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "checkout.subscribable");
    expect(checkouts).toHaveLength(1);
  });

  it("marker-less payloads persist directly onto an existing OURS mirror too", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      { productIds: ["gid://shopify/Product/111"] },
    ]);
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: null,
      customerId: null,
      email: null,
      originOrderProcessedAt: null,
    });
    await run(
      orderPayload({
        line_items: [{ product_id: 111, quantity: 3, properties: [] }],
      }),
    );
    // The contract-create handshake keys on originOrderId, so the direct
    // persist is just as safe here as on the marker path.
    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("renewal orders never re-capture (source_name subscription_contract)", async () => {
    await run(orderPayload({ source_name: "subscription_contract" }));
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a TRANSIENT customer-lookup failure defers the persist — enrichment nulls never consume the only capture", async () => {
    // ACQ-5: the acqRaw-null claim is the bundle's only write ever. The old
    // behavior persisted customerCreatedAt/numberOfOrders/time-to-purchase
    // as null on a retryable error, consuming the claim and permanently
    // forfeiting the enrichment (the Shopify customer record stays fetchable
    // forever) — with the missingness clustered on exactly the API-outage
    // windows that bias a future training set. Now the whole persist defers:
    // the stash below is the retry fuel (contract-create pickup / nightly
    // backfill re-run it; the backfill counts the contained throw as
    // acqFailed and stamps acqPickupExhaustedAt only when NO stash exists).
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: null,
      customerId: "gid://shopify/Customer/77",
      email: null,
      originOrderProcessedAt: null,
    });
    mocks.getCustomer.mockRejectedValue(new Error("shopify down"));
    await run(orderPayload());
    // The claim was NOT consumed — a later retry can still land the full
    // enrichment — and the webhook itself survived (containment).
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
    // The stash is intact: the retry lanes have something to pick up.
    expect(stashEvents()).toHaveLength(1);
  });

  it("a conclusively ABSENT customer persists honest nulls (deleted customer, not an outage)", async () => {
    // getCustomer resolving null is Shopify's definitive "no such customer"
    // (deleted / GDPR-erased) — null enrichment is then the truth, and the
    // capture must land rather than retry forever.
    mocks.contractFindFirst.mockResolvedValue({
      id: "cm_c1",
      shopId: "shop_1",
      ownership: "OURS",
      acqRaw: null,
      customerId: "gid://shopify/Customer/77",
      email: null,
      originOrderProcessedAt: null,
    });
    mocks.getCustomer.mockResolvedValue(null);
    await run(orderPayload());
    const args = mocks.contractUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.acqTimeToPurchaseSeconds).toBeNull();
    expect(args.data.acqDeviceType).toBe("mobile"); // rest of the capture intact
  });
});

// ── CUSTOMERS_REDACT: the profile dies with the identity ─────────────────────

describe("CUSTOMERS_REDACT scrubs every acq* column", () => {
  /**
   * The acq* column list straight from prisma/schema.prisma — if a build adds
   * an acquisition column and forgets the redaction handler, this fails.
   */
  function acqColumnsFromSchema(): string[] {
    const schema = readFileSync(
      fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const model = schema.match(/model SubscriptionContract \{[\s\S]*?\n\}/)?.[0];
    expect(model, "SubscriptionContract model not found in schema").toBeDefined();
    const columns = [...model!.matchAll(/^\s{2}(acq\w+)\s/gm)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThanOrEqual(12); // the migration-0006 set
    return columns;
  }

  async function runRedact(): Promise<void> {
    await webhookHandlers.CUSTOMERS_REDACT({
      shopDomain: "cellexia-test.myshopify.com",
      payload: {
        customer: {
          id: 42,
          admin_graphql_api_id: "gid://shopify/Customer/42",
          email: "jane@example.com",
        },
      },
      webhookId: "wh_redact_1",
    });
  }

  beforeEach(() => {
    // c1's stash is only reachable by its originOrderId: the customer changed
    // their store email after checkout, so the redact payload's email no
    // longer matches the email the stash event was logged under. c2 mirrors
    // an imported contract with no origin order at all.
    mocks.contractFindMany.mockResolvedValue([
      { id: "c1", originOrderId: "gid://shopify/Order/999001" },
      { id: "c2", originOrderId: null },
    ]);
  });

  it("nulls every acq* column the schema declares (schema-derived completeness)", async () => {
    await runRedact();

    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    const args = mocks.contractUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(args.where).toEqual({ id: { in: ["c1", "c2"] } });

    for (const column of acqColumnsFromSchema()) {
      expect(
        Object.prototype.hasOwnProperty.call(args.data, column),
        `CUSTOMERS_REDACT does not handle ${column} — every acq* column MUST be accounted for`,
      ).toBe(true);
      const value = args.data[column];
      if (column === "acqPickupExhaustedAt") {
        // The one deliberate exception (migration 0010): this column carries
        // no acquisition data — it is the queue-control stamp that KEEPS the
        // redacted row out of origin_order_backfill's acqPending window (the
        // stash payloads are cleared below, so nightly re-scans could never
        // fill anything again). It must be SET on redact, never cleared:
        // nulling it would re-queue the acqRaw-null row forever, recreating
        // the starvation this marker exists to prevent.
        expect(
          value,
          `${column} must be stamped terminal on redact`,
        ).toBeInstanceOf(Date);
        continue;
      }
      const cleared =
        value === null || value === Prisma.DbNull || value === Prisma.JsonNull;
      expect(cleared, `${column} must be cleared, got ${String(value)}`).toBe(true);
    }
  });

  it("also anonymizes the identity columns alongside the profile", async () => {
    await runRedact();
    const { data } = mocks.contractUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.email).toBe("redacted+42@example.invalid");
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.deliveryAddress).toBe(Prisma.JsonNull);
  });

  it("clears acquisition.captured stash payloads BEFORE rewriting event identity", async () => {
    await runRedact();
    expect(mocks.subscriberEventUpdateMany).toHaveBeenCalledTimes(3);
    const [first, second, third] = mocks.subscriberEventUpdateMany.mock.calls.map(
      (c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> },
    );
    // Pass 1: the stash payloads (they carry the same geo/behavior bundle).
    expect(first.where.type).toBe("acquisition.captured");
    expect(first.data).toEqual({ payload: Prisma.DbNull });
    // Pass 2: the acquisition fragments copied into the direct-persist
    // confirmation events (asserted in detail below).
    expect(second.where.type).toBe("contract.updated");
    // Pass 3 (LAST): the identity rewrite the filters above depended on.
    expect(third.data).toEqual({ email: "redacted+42@example.invalid" });
    expect(third.where.type).toBeUndefined();
  });

  it("the stash dies even when the emails no longer line up (orderId-keyed clearing)", async () => {
    // The defect this pins: a stash event is written at ORDERS_CREATE time
    // with the CHECKOUT-time email and no contractId. A customer who then
    // changes their store email files an erasure request carrying the NEW
    // email — the identity filters (customerId/email/contractId) can all
    // miss the stash, leaving city-level geo + UTM + landing paths + device
    // behind for a row the shop was ordered to erase. The redact handler
    // must ALSO clear stash rows by payload.orderId for every matched
    // contract's originOrderId.
    await runRedact();
    const stashPass = mocks.subscriberEventUpdateMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown> })
      .find((call) => call.where.type === "acquisition.captured");
    expect(stashPass).toBeDefined();
    const or = (stashPass as { where: { OR: unknown[] } }).where.OR;
    expect(or).toContainEqual({
      payload: { path: ["orderId"], equals: "gid://shopify/Order/999001" },
    });
    // …and identity filters still participate (a stash with no surviving
    // contract is reachable through customerId — stamped since the fix — or
    // the original email).
    expect(or).toContainEqual({ customerId: "gid://shopify/Customer/42" });
    expect(or).toContainEqual({ email: "jane@example.com" });
    // A contract with no origin order contributes NO filter — never a
    // payload-path match on null that could sweep unrelated rows.
    for (const filter of or as Array<Record<string, unknown>>) {
      const payloadFilter = filter.payload as
        | { equals?: unknown }
        | undefined;
      if (payloadFilter) expect(payloadFilter.equals).not.toBeNull();
    }
  });

  it("orders_to_redact reaches the stash no identity filter can (guest one-time order)", async () => {
    // The defect this pins: handleOrdersCreate deliberately over-stashes
    // EVERY subscribable order — including a guest's one-time purchase that
    // never becomes a contract. That stash carries the geo/UTM/device/value
    // bundle plus the checkout-time email, keyed only by payload.orderId
    // (customerId null, contractId null). When the buyer later registers,
    // changes their store email and files an erasure request, the redact
    // payload's customer id and CURRENT email match nothing — but Shopify
    // hands the handler those very order ids in orders_to_redact. Ignoring
    // them leaves the full behavioral bundle and the raw checkout email
    // behind on rows the shop was ordered to erase.
    mocks.contractFindMany.mockResolvedValue([]); // the orders produced no contract
    await webhookHandlers.CUSTOMERS_REDACT({
      shopDomain: "cellexia-test.myshopify.com",
      payload: {
        customer: {
          id: 42,
          admin_graphql_api_id: "gid://shopify/Customer/42",
          email: "new-identity@example.com", // ≠ the checkout-time email
        },
        // Numeric REST id and full GID both normalize; junk contributes nothing.
        orders_to_redact: [999002, "gid://shopify/Order/999003", "not-an-id", null],
      },
      webhookId: "wh_redact_orders",
    });

    const calls = mocks.subscriberEventUpdateMany.mock.calls.map(
      (c) =>
        c[0] as { where: Record<string, unknown>; data: Record<string, unknown> },
    );
    // No matched contract → no confirmation-event pass: stash pass + email pass.
    expect(calls).toHaveLength(2);

    // Pass 1 — the stash payload dies via the REDACTED ORDER ids.
    const stashPass = calls[0];
    expect(stashPass.where.type).toBe("acquisition.captured");
    expect(stashPass.data).toEqual({ payload: Prisma.DbNull });
    const stashOr = stashPass.where.OR as unknown[];
    expect(stashOr).toContainEqual({
      payload: { path: ["orderId"], equals: "gid://shopify/Order/999002" },
    });
    expect(stashOr).toContainEqual({
      payload: { path: ["orderId"], equals: "gid://shopify/Order/999003" },
    });

    // Pass 2 (LAST) — the checkout-time email on those order-keyed rows dies
    // too: the identity filters (customerId / the NEW email) cannot reach it.
    const emailPass = calls[1];
    expect(emailPass.data).toEqual({ email: "redacted+42@example.invalid" });
    const emailOr = emailPass.where.OR as unknown[];
    expect(emailOr).toContainEqual({
      payload: { path: ["orderId"], equals: "gid://shopify/Order/999002" },
    });
    expect(emailOr).toContainEqual({
      payload: { path: ["orderId"], equals: "gid://shopify/Order/999003" },
    });

    // The junk entries never became filters — and NOTHING equals null, which
    // could otherwise sweep unrelated rows.
    for (const or of [stashOr, emailOr]) {
      for (const filter of or as Array<Record<string, unknown>>) {
        const payloadFilter = filter.payload as { equals?: unknown } | undefined;
        if (payloadFilter) {
          expect(payloadFilter.equals).toMatch(/^gid:\/\/shopify\/Order\/999/);
        }
      }
    }
  });

  it("a redacted order that IS a matched contract's origin contributes one filter, not two", async () => {
    // orders_to_redact usually repeats the origin orders of the customer's
    // contracts — the scrub set is a union, so the OR stays deduplicated.
    await webhookHandlers.CUSTOMERS_REDACT({
      shopDomain: "cellexia-test.myshopify.com",
      payload: {
        customer: {
          id: 42,
          admin_graphql_api_id: "gid://shopify/Customer/42",
          email: "jane@example.com",
        },
        orders_to_redact: [999001], // == c1.originOrderId from beforeEach
      },
      webhookId: "wh_redact_dup",
    });
    const stashPass = mocks.subscriberEventUpdateMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown> })
      .find((call) => call.where.type === "acquisition.captured")!;
    const orderFilters = (stashPass.where.OR as Array<Record<string, unknown>>).filter(
      (f) => f.payload != null,
    );
    expect(orderFilters).toEqual([
      { payload: { path: ["orderId"], equals: "gid://shopify/Order/999001" } },
    ]);
  });

  it("scrubs the acquisition fragments from acquisition_captured confirmation events", async () => {
    // The direct-persist path announces the capture on the contract's event
    // stream with sourceName/countryCode/deviceType in the payload — copies
    // of exactly the profile the redact order covers. "EVERY acquisition
    // field" includes copies: the payload is reduced to the action marker.
    await runRedact();
    const scrubPass = mocks.subscriberEventUpdateMany.mock.calls
      .map(
        (c) =>
          c[0] as { where: Record<string, unknown>; data: Record<string, unknown> },
      )
      .find((call) => call.where.type === "contract.updated");
    expect(scrubPass).toBeDefined();
    const pass = scrubPass as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Scoped to the matched contracts and to the acquisition_captured action
    // — other contract.updated events keep their payloads.
    expect(pass.where.contractId).toEqual({ in: ["c1", "c2"] });
    expect(pass.where.payload).toEqual({
      path: ["action"],
      equals: "acquisition_captured",
    });
    // The replacement payload carries NO acquisition fragment.
    expect(pass.data.payload).toEqual({
      action: "acquisition_captured",
      redacted: true,
    });
    for (const gone of ["sourceName", "countryCode", "deviceType"]) {
      expect(
        Object.prototype.hasOwnProperty.call(
          pass.data.payload as Record<string, unknown>,
          gone,
        ),
      ).toBe(false);
    }
  });

  it("kills live login/link artifacts and records the audit trail", async () => {
    await runRedact();
    expect(mocks.otpCodeDeleteMany).toHaveBeenCalled();
    expect(mocks.portalSessionDeleteMany).toHaveBeenCalled();
    expect(mocks.magicLinkTokenDeleteMany).toHaveBeenCalled();
    expect(mocks.alertCreate).toHaveBeenCalledTimes(1);
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(
      logged.some(
        (e) =>
          e.type === "admin.action" &&
          (e.payload as Record<string, unknown>).action === "customers_redact",
      ),
    ).toBe(true);
  });

  it("does nothing destructive when the payload carries no customer identity", async () => {
    await webhookHandlers.CUSTOMERS_REDACT({
      shopDomain: "cellexia-test.myshopify.com",
      payload: { customer: {} },
      webhookId: "wh_redact_2",
    });
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
    expect(mocks.subscriberEventUpdateMany).not.toHaveBeenCalled();
    expect(mocks.klaviyoOutboxDeleteMany).not.toHaveBeenCalled();
    expect(mocks.klaviyoOutboxUpdateMany).not.toHaveBeenCalled();
  });

  it("Klaviyo outbox: pending rows die, delivered rows are anonymized — nothing fires after the erasure", async () => {
    // ACQ-2/WH-10: every contract-scoped event copied email/phone + the acq
    // profile attrs into an outbox row, rows are retained forever, and the
    // 1-minute flush delivers PENDING/FAILED rows for up to 24h. A completed
    // redact that leaves them behind keeps live PII in a queryable table AND
    // transmits it outward after the erasure was acknowledged.
    await runRedact();

    // PENDING/FAILED rows are deleted outright (delivery plumbing, not a
    // financial record) so the flush can never send a redacted identity.
    expect(mocks.klaviyoOutboxDeleteMany).toHaveBeenCalledTimes(1);
    const del = mocks.klaviyoOutboxDeleteMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(del.where.status).toEqual({ in: ["PENDING", "FAILED"] });
    const delOr = del.where.OR as Array<Record<string, unknown>>;
    // Matched by the original email AND by the contract snapshot each row
    // carries — a store-email change since the last enqueue cannot hide rows.
    expect(delOr).toContainEqual({ email: "jane@example.com" });
    expect(delOr).toContainEqual({
      properties: { path: ["contract_id"], equals: "c1" },
    });
    expect(delOr).toContainEqual({
      properties: { path: ["contract_id"], equals: "c2" },
    });

    // SENT/DEAD rows stay as delivery audit, minus every identity and
    // acquisition copy (profileAttrs carry cellexia_acq_source/_country).
    expect(mocks.klaviyoOutboxUpdateMany).toHaveBeenCalledTimes(1);
    const scrub = mocks.klaviyoOutboxUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(scrub.data).toEqual({
      email: "redacted+42@example.invalid",
      phone: null,
      profileAttrs: Prisma.DbNull,
      properties: Prisma.DbNull,
    });
  });

  it("rewrites GDPR_DATA_REQUEST alert context/message for the redacted identity", async () => {
    // handleCustomersDataRequest stores the customer's email + order list in
    // Alert.context as operator guidance; the redact supersedes it.
    mocks.alertFindMany.mockResolvedValue([
      {
        id: "alert_1",
        context: {
          customerId: "gid://shopify/Customer/42",
          email: "jane@example.com",
          ordersRequested: [999001],
          dataRequestId: "req_9",
        },
      },
    ]);
    await runRedact();

    const query = mocks.alertFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(query.where.type).toBe("GDPR_DATA_REQUEST");

    expect(mocks.alertUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.alertUpdate.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: { message: string; context: Record<string, unknown> };
    };
    expect(update.where).toEqual({ id: "alert_1" });
    // The email is gone from BOTH copies; the audit key survives.
    expect(update.data.message).not.toContain("jane@example.com");
    expect(update.data.context.email).toBe("redacted+42@example.invalid");
    expect(update.data.context.ordersRequested).toEqual([]);
    expect(update.data.context.dataRequestId).toBe("req_9");
  });
});
