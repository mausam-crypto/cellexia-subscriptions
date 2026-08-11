import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Analytics segments (v1.15.0): the dimension derivations, the one shared
 * predicate, URL parsing (fail-safe), id resolution + filter-bar options
 * against the fake db, the contract-id seams of the filtered views
 * (cohorts / survival / MRR / funnel), the segment churn series, and the
 * reconstructed-history segment forecast (grade cap + caveats included).
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("~/db.server", () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        const client = dbHolder.current;
        if (!client) {
          throw new Error(`fake db not initialised (accessed ${String(prop)})`);
        }
        return client[prop as string];
      },
    },
  ),
}));

import {
  contractCountryValue,
  contractDeviceValue,
  contractHasProduct,
  contractLanguageValue,
  contractMatchesSegment,
  contractSourceValue,
  contractValueBandValue,
  firstOrderDiscountBand,
  getSegmentOptions,
  isEmptySegment,
  normalizeProductId,
  parseSegmentFromParams,
  resolveSegmentContractIds,
  type SegmentSourceContract,
} from "~/lib/analytics/segments.server";
import {
  getSegmentChurnSeries,
  getSegmentForecast,
} from "~/lib/analytics/segment-views.server";
import { computeCohortRows } from "~/lib/analytics/cohorts.server";
import { getSurvivalByCycle } from "~/lib/analytics/survival.server";
import {
  computeMrrCents,
  getFunnelMetrics,
} from "~/lib/analytics/queries.server";

// ── Pure: dimension derivation ───────────────────────────────────────────────

function sourceContract(over: Partial<SegmentSourceContract> = {}): SegmentSourceContract {
  return {
    id: "c1",
    locale: "en",
    deliveryAddress: null,
    acqCountryCode: null,
    acqSourceName: null,
    acqUtm: null,
    acqReferringSite: null,
    acqLandingSite: null,
    acqRaw: null,
    acqDeviceType: null,
    acqOrderValueBand: null,
    originOrderTotalCents: null,
    originOrderDiscountCents: null,
    lines: [],
    ...over,
  };
}

describe("dimension derivation", () => {
  it("country: delivery address first, acquisition fallback, unknown last", () => {
    expect(
      contractCountryValue(
        sourceContract({ deliveryAddress: { countryCode: "ch" } }),
      ),
    ).toBe("CH");
    expect(contractCountryValue(sourceContract({ acqCountryCode: "de" }))).toBe(
      "DE",
    );
    expect(contractCountryValue(sourceContract())).toBe("unknown");
  });

  it("language: base subtag of the contract locale", () => {
    expect(contractLanguageValue(sourceContract({ locale: "fr-CH" }))).toBe("fr");
    expect(contractLanguageValue(sourceContract({ locale: "de" }))).toBe("de");
    expect(contractLanguageValue(sourceContract({ locale: "" }))).toBe("unknown");
  });

  it("language: the REAL checkout locale outranks the normalized contract locale (v1.16.0)", () => {
    // A Turkish checkout normalized to the catalog default "en" must still
    // segment as Turkish — the checkout locale is the truth.
    expect(
      contractLanguageValue(
        sourceContract({ locale: "en", acqRaw: { checkoutLocale: "tr-TR" } }),
      ),
    ).toBe("tr");
    // Absent/hostile checkout locale falls back to the contract locale.
    expect(
      contractLanguageValue(
        sourceContract({ locale: "fr-CH", acqRaw: { checkoutLocale: "  " } }),
      ),
    ).toBe("fr");
    expect(
      contractLanguageValue(
        sourceContract({ locale: "de", acqRaw: { checkoutLocale: 42 } }),
      ),
    ).toBe("de");
  });

  it("traffic source: utm source wins over the Shopify channel, lowercased", () => {
    expect(
      contractSourceValue(
        sourceContract({
          acqUtm: { source: "Instagram" },
          acqSourceName: "web",
        }),
      ),
    ).toBe("instagram");
    expect(
      contractSourceValue(sourceContract({ acqSourceName: "web" })),
    ).toBe("web");
    expect(contractSourceValue(sourceContract())).toBe("unknown");
    // Hostile utm shapes never throw.
    expect(
      contractSourceValue(sourceContract({ acqUtm: [1, 2] as unknown })),
    ).toBe("unknown");
  });

  it("traffic source ladder (v1.16.0): paid channel → referrer class → direct", () => {
    // 2. Click-id presence (recorded by the sanitizer) beats the referrer
    // and the channel — paid traffic without utm tags.
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { paidChannel: "google_ads" },
          acqReferringSite: "www.google.com/",
          acqSourceName: "web",
        }),
      ),
    ).toBe("google_ads");
    // 3a. Named search/social referrer hosts classify by brand.
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1 },
          acqReferringSite: "www.google.ch/search",
          acqSourceName: "web",
        }),
      ),
    ).toBe("google");
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1 },
          acqReferringSite: "l.instagram.com/",
          acqSourceName: "web",
        }),
      ),
    ).toBe("instagram");
    // 3b. Any other external host is a referral.
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1 },
          acqReferringSite: "some-blog.example.org/post/best-serums",
          acqSourceName: "web",
        }),
      ),
    ).toBe("referral");
    // 3c. A referrer equal to the landing host is the shop itself — not a
    // source; the captured bundle with no external referrer reads direct.
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1 },
          acqReferringSite: "cellexialabs.com/collections/all",
          acqLandingSite: "cellexialabs.com/products/serum",
          acqSourceName: "web",
        }),
      ),
    ).toBe("direct");
    // 3d. The capture-time verdict wins over the host comparison: the usual
    // Shopify shape stores the landing PATH-relative (no host to compare),
    // but the sanitizer already judged the referrer against the shop's own
    // domains — internal navigation reads direct, never "referral".
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1, referrerInternal: true },
          acqReferringSite: "cellexialabs.com/pages/about",
          acqLandingSite: "/products/serum",
          acqSourceName: "web",
        }),
      ),
    ).toBe("direct");
    // …and a capture-time PROVEN-external unknown host stays a referral.
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1, referrerInternal: false },
          acqReferringSite: "some-blog.example.org/post",
          acqLandingSite: "/products/serum",
          acqSourceName: "web",
        }),
      ),
    ).toBe("referral");
    // 4. "web" reads "direct" ONLY for a captured bundle (acqRaw present);
    // an uncaptured row keeps the honest "web".
    expect(
      contractSourceValue(
        sourceContract({ acqRaw: { v: 1 }, acqSourceName: "web" }),
      ),
    ).toBe("direct");
    expect(
      contractSourceValue(sourceContract({ acqSourceName: "web" })),
    ).toBe("web");
    // Non-web channels keep their names even when captured.
    expect(
      contractSourceValue(
        sourceContract({ acqRaw: { v: 1 }, acqSourceName: "shopify_draft_order" }),
      ),
    ).toBe("shopify_draft_order");
    // An import-passthrough bundle never proved the referrer's ABSENCE (the
    // CSV may simply lack referrer columns) — "web" stays "web", not
    // "direct" (the module's imported-book honesty rule).
    expect(
      contractSourceValue(
        sourceContract({
          acqRaw: { v: 1, importPassthrough: true },
          acqSourceName: "web",
        }),
      ),
    ).toBe("web");
  });

  it("device + value band pass through their vocabulary, else unknown", () => {
    expect(contractDeviceValue(sourceContract({ acqDeviceType: "Mobile" }))).toBe(
      "mobile",
    );
    expect(contractDeviceValue(sourceContract({ acqDeviceType: "bot" }))).toBe(
      "unknown",
    );
    expect(
      contractValueBandValue(sourceContract({ acqOrderValueBand: "50_75" })),
    ).toBe("50_75");
    expect(contractValueBandValue(sourceContract())).toBe("unknown");
  });

  it("first-order discount bands on the PRE-discount base, unknown until captured", () => {
    // Not captured yet → unknown, never a guess.
    expect(firstOrderDiscountBand(sourceContract())).toBe("unknown");
    // Captured, no discount → none.
    expect(
      firstOrderDiscountBand(
        sourceContract({ originOrderTotalCents: 9000, originOrderDiscountCents: 0 }),
      ),
    ).toBe("none");
    // 1000 off a 10000 pre-discount order = exactly 10% → 10_20 (bands are
    // [lower, upper) on the lower edge).
    expect(
      firstOrderDiscountBand(
        sourceContract({
          originOrderTotalCents: 9000,
          originOrderDiscountCents: 1000,
        }),
      ),
    ).toBe("10_20");
    expect(
      firstOrderDiscountBand(
        sourceContract({
          originOrderTotalCents: 9001,
          originOrderDiscountCents: 999,
        }),
      ),
    ).toBe("1_10");
    // 3000 off 10000 = 30% → 30_plus.
    expect(
      firstOrderDiscountBand(
        sourceContract({
          originOrderTotalCents: 7000,
          originOrderDiscountCents: 3000,
        }),
      ),
    ).toBe("30_plus");
  });

  it("product membership: numeric and GID forms match, gift lines never do", () => {
    expect(normalizeProductId("gid://shopify/Product/123")).toBe("123");
    expect(normalizeProductId("123")).toBe("123");
    expect(normalizeProductId("gid://shopify/ProductVariant/123")).toBeNull();
    const contract = sourceContract({
      lines: [
        { productId: "gid://shopify/Product/11", isGift: false },
        { productId: "gid://shopify/Product/99", isGift: true },
      ],
    });
    expect(contractHasProduct(contract, "11")).toBe(true);
    expect(contractHasProduct(contract, "99")).toBe(false); // gift only
    expect(contractHasProduct(contract, "12")).toBe(false);
  });

  it("the predicate ANDs every present dimension", () => {
    const contract = sourceContract({
      deliveryAddress: { countryCode: "CH" },
      locale: "fr-CH",
      acqUtm: { source: "instagram" },
      lines: [{ productId: "gid://shopify/Product/11", isGift: false }],
    });
    expect(
      contractMatchesSegment(contract, { country: "CH", source: "instagram" }),
    ).toBe(true);
    expect(
      contractMatchesSegment(contract, { country: "CH", source: "google" }),
    ).toBe(false);
    expect(contractMatchesSegment(contract, {})).toBe(true);
    expect(
      contractMatchesSegment(contract, { language: "fr", productId: "11" }),
    ).toBe(true);
    expect(contractMatchesSegment(contract, { device: "unknown" })).toBe(true);
    expect(contractMatchesSegment(contract, { device: "mobile" })).toBe(false);
  });
});

// ── Pure: URL parsing (fail-safe) ────────────────────────────────────────────

describe("parseSegmentFromParams", () => {
  const parse = (query: string) =>
    parseSegmentFromParams(new URLSearchParams(query));

  it("parses and normalizes every dimension", () => {
    expect(
      parse(
        "country=ch&lang=FR&source=Instagram&product=gid://shopify/Product/12&discount=10_20&device=Mobile&value=50_75",
      ),
    ).toEqual({
      country: "CH",
      language: "fr",
      source: "instagram",
      productId: "12",
      discountBand: "10_20",
      device: "mobile",
      valueBand: "50_75",
    });
  });

  it("accepts the explicit unknown bucket everywhere it exists", () => {
    expect(parse("country=unknown&discount=unknown&device=unknown")).toEqual({
      country: "unknown",
      discountBand: "unknown",
      device: "unknown",
    });
  });

  it("drops malformed values instead of throwing (fail-safe: unfiltered beats broken)", () => {
    expect(parse("country=Sw!tz&lang=123&discount=99_100&device=bot&product=x")).toEqual(
      {},
    );
    expect(isEmptySegment(parse(""))).toBe(true);
    expect(isEmptySegment(parse("country=CH"))).toBe(false);
  });
});

// ── DB-backed: resolution, options and the filtered-view seams ───────────────

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};
const NOW = new Date("2026-08-05T12:00:00Z");

function D(iso: string): Date {
  return new Date(iso);
}

function contractRow(id: string, over: Row): Row {
  return {
    id,
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    cancelSource: null,
    cancelReason: null,
    cancelledAt: null,
    failedAt: null,
    expiredAt: null,
    createdAt: D("2026-06-01T08:00:00Z"),
    firstChargeAt: D("2026-06-10T10:00:00Z"),
    currencyCode: "CHF",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    deliveryAddress: null,
    acqCountryCode: null,
    acqSourceName: null,
    acqUtm: null,
    acqDeviceType: null,
    acqOrderValueBand: null,
    originOrderId: null,
    originOrderTotalCents: null,
    originOrderDiscountCents: null,
    originOrderTaxCents: null,
    originOrderRefundedCents: 0,
    originOrderProcessedAt: null,
    originOrderCurrencyCode: null,
    ordersCount: 1,
    lines: [],
    ...over,
  };
}

const line = (productId: string, title: string): Row => ({
  productId,
  variantId: `${productId}-v`,
  title,
  quantity: 1,
  currentPriceCents: 5000,
  compareAtPriceCents: null,
  unitCostCents: 1000,
  isGift: false,
  isOneTimeAddon: false,
});

/**
 * Three countable contracts + pollution:
 * - c_ch: CH, French, instagram (utm), product 11, mobile
 * - c_de: DE (acq fallback), German, google (channel), product 22, desktop
 * - c_mystery: nothing captured anywhere (all unknown buckets)
 * - c_foreign / c_demo: MUST never appear in ids, options or views.
 */
function buildSegmentStore(): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  store.settings.push({
    shopId: SHOP_ID,
    key: "costModel",
    value: {
      paymentFeePct: 2.9,
      paymentFeeFixedCents: 30,
      fulfillmentCostPerShipmentCents: 150,
      shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
      cogsFallbackPctOfPrice: 25,
      vat: { enabled: false, defaultRatePct: 0, countryRatesPct: {} },
    },
  });

  store.subscriptionContracts.push(
    contractRow("c_ch", {
      deliveryAddress: { countryCode: "CH" },
      locale: "fr-CH",
      acqUtm: { source: "instagram" },
      acqSourceName: "web",
      acqDeviceType: "mobile",
      acqOrderValueBand: "50_75",
      originOrderTotalCents: 9000,
      originOrderDiscountCents: 1000,
      lines: [line("gid://shopify/Product/11", "Serum")],
    }),
    contractRow("c_de", {
      acqCountryCode: "DE",
      locale: "de",
      acqSourceName: "google",
      acqDeviceType: "desktop",
      originOrderTotalCents: 8000,
      originOrderDiscountCents: 0,
      lines: [line("gid://shopify/Product/22", "Cream")],
    }),
    contractRow("c_mystery", { lines: [line("gid://shopify/Product/11", "Serum")] }),
    contractRow("c_foreign", {
      ownership: "FOREIGN",
      deliveryAddress: { countryCode: "CH" },
      lines: [line("gid://shopify/Product/11", "Serum")],
    }),
    contractRow("c_demo", {
      isDemo: true,
      deliveryAddress: { countryCode: "CH" },
      lines: [line("gid://shopify/Product/11", "Serum")],
    }),
  );
  return store;
}

describe("resolveSegmentContractIds + getSegmentOptions", () => {
  it("resolves ids through the one predicate, countable population only", async () => {
    dbHolder.current = createAnalyticsDb(buildSegmentStore()) as never;
    expect(await resolveSegmentContractIds(SHOP_ID, {})).toBeNull();
    expect(
      await resolveSegmentContractIds(SHOP_ID, { country: "CH" }),
    ).toEqual(["c_ch"]); // never c_foreign / c_demo
    expect(
      await resolveSegmentContractIds(SHOP_ID, { productId: "11" }),
    ).toEqual(["c_ch", "c_mystery"]);
    expect(
      await resolveSegmentContractIds(SHOP_ID, {
        productId: "11",
        country: "unknown",
      }),
    ).toEqual(["c_mystery"]);
    expect(
      await resolveSegmentContractIds(SHOP_ID, { country: "FR" }),
    ).toEqual([]); // a real empty result, not "no filter"
  });

  it("builds filter options with counts, unknown bucket last, product titles as labels", async () => {
    dbHolder.current = createAnalyticsDb(buildSegmentStore()) as never;
    const options = await getSegmentOptions(SHOP_ID);
    expect(options.totalContracts).toBe(3); // countable only

    expect(options.countries).toEqual([
      { value: "CH", label: "CH", count: 1 },
      { value: "DE", label: "DE", count: 1 },
      { value: "unknown", label: "unknown", count: 1 },
    ]);
    expect(options.sources.map((o) => o.value)).toEqual([
      "google",
      "instagram",
      "unknown",
    ]);
    expect(options.products).toEqual([
      { value: "11", label: "Serum", count: 2 },
      { value: "22", label: "Cream", count: 1 },
    ]);
    expect(options.discountBands.map((o) => o.value)).toEqual([
      "none",
      "10_20",
      "unknown",
    ]);
  });

  it("never offers a product option whose id cannot be filtered on (deleted-product lines)", async () => {
    const store = buildSegmentStore();
    // The mirror writes "" when Shopify reports no product id; an option with
    // value "" would be the filter bar's "All products" sentinel — selecting
    // it would silently UNfilter.
    const mystery = store.subscriptionContracts.find((c) => c.id === "c_mystery") as Row;
    (mystery.lines as Row[]).push({ ...line("", "Ghost Product") });
    dbHolder.current = createAnalyticsDb(store) as never;
    const options = await getSegmentOptions(SHOP_ID);
    expect(options.products.some((o) => o.value === "")).toBe(false);
    expect(options.products.some((o) => o.label === "Ghost Product")).toBe(false);
  });

  it("the 40-option cap never evicts the unknown bucket (imported books stay visible)", async () => {
    const store = buildSegmentStore();
    // 45 distinct sources — more than the cap — while c_mystery stays unknown.
    for (let i = 0; i < 45; i++) {
      store.subscriptionContracts.push(
        contractRow(`c_src_${i}`, {
          acqSourceName: `channel_${String(i).padStart(2, "0")}`,
          lines: [line("gid://shopify/Product/33", "Filler")],
        }),
      );
    }
    dbHolder.current = createAnalyticsDb(store) as never;
    const options = await getSegmentOptions(SHOP_ID);
    expect(options.sources.length).toBe(41); // 40 real values + unknown
    expect(options.sources[options.sources.length - 1].value).toBe("unknown");
  });
});

describe("filtered-view seams take the resolved ids", () => {
  it("the origin double-count guard stays SHOP-WIDE under a segment filter", async () => {
    const store = buildSegmentStore();
    // Segment member c_ch's origin order is (anomalously) also claimed by a
    // successful attempt on OUT-of-segment contract c_de. The whole-book
    // surfaces suppress c_ch's origin mirror; the filtered view must too —
    // a segment cell may never book money the whole book excludes.
    const cCh = store.subscriptionContracts.find((c) => c.id === "c_ch") as Row;
    const cDe = store.subscriptionContracts.find((c) => c.id === "c_de") as Row;
    cCh.originOrderId = "gid://shopify/Order/77";
    cCh.originOrderProcessedAt = D("2026-06-12T10:00:00Z");
    cCh.originOrderCurrencyCode = "CHF";
    store.billingAttempts.push({
      id: "a_claim",
      contractId: "c_de",
      contract: cDe,
      status: "SUCCESS",
      amountCents: 9000,
      refundedCents: 0,
      currencyCode: "CHF",
      taxCents: null,
      discountCents: null,
      costSnapshot: null,
      completedAt: D("2026-06-12T10:00:00Z"),
      orderId: "gid://shopify/Order/77",
    });
    dbHolder.current = createAnalyticsDb(store) as never;

    const filtered = await computeCohortRows(SHOP_ID, NOW, {
      contractIds: ["c_ch"],
    });
    // c_ch's origin total (9000) must NOT appear: the claiming attempt lives
    // outside the segment but still wins the precedence rule.
    expect(filtered.find((r) => r.monthOffset === 0)?.revenueCents).toBe(0);
  });

  it("computeCohortRows narrows to the segment population", async () => {
    const store = buildSegmentStore();
    store.billingAttempts.push({
      id: "a1",
      contractId: "c_ch",
      contract: store.subscriptionContracts[0],
      status: "SUCCESS",
      amountCents: 5000,
      refundedCents: 0,
      currencyCode: "CHF",
      taxCents: null,
      discountCents: null,
      costSnapshot: null,
      completedAt: D("2026-06-15T10:00:00Z"),
      orderId: null,
    });
    dbHolder.current = createAnalyticsDb(store) as never;

    const all = await computeCohortRows(SHOP_ID, NOW);
    expect(all.find((r) => r.monthOffset === 0)?.cohortSize).toBe(3);

    const filtered = await computeCohortRows(SHOP_ID, NOW, {
      contractIds: ["c_ch"],
    });
    expect(filtered.find((r) => r.monthOffset === 0)?.cohortSize).toBe(1);
    expect(filtered.find((r) => r.monthOffset === 0)?.revenueCents).toBe(5000);
    // Nothing was persisted by the filtered computation.
    expect(store.cohortCells).toHaveLength(0);
  });

  it("getSurvivalByCycle + computeMrrCents + getFunnelMetrics narrow the same way", async () => {
    const store = buildSegmentStore();
    dbHolder.current = createAnalyticsDb(store) as never;

    const all = await getSurvivalByCycle(SHOP_ID);
    expect(all.totalContracts).toBe(3);
    const filtered = await getSurvivalByCycle(SHOP_ID, {
      contractIds: ["c_ch", "c_de"],
    });
    expect(filtered.totalContracts).toBe(2);

    // MRR: each contract bills 5000 every 4 weeks → round(5000×4.345/4)=5431.
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(3 * 5431);
    expect(
      await computeMrrCents(SHOP_ID, "CHF", { contractIds: ["c_ch"] }),
    ).toBe(5431);

    // Funnel: segmented call nulls take rate (unsegmentable denominator) and
    // scopes the live counts.
    const funnel = await getFunnelMetrics(SHOP_ID, 30, {
      contractIds: ["c_ch"],
    });
    expect(funnel.takeRatePct).toBeNull();
    expect(funnel.prepaidMixPct).toBe(0);
  });

  it("getSegmentChurnSeries classifies exactly like the rollup", async () => {
    const store = buildSegmentStore();
    const [cCh, cDe, cMystery] = store.subscriptionContracts;
    // c_ch: cancelled by CUSTOMER this week → voluntary.
    cCh.status = "CANCELLED";
    cCh.cancelSource = "CUSTOMER";
    cCh.cancelledAt = D("2026-08-04T10:00:00Z");
    // c_de: dunning-exhausted FAILED (no cancelledAt) → involuntary.
    cDe.status = "FAILED";
    cDe.failedAt = D("2026-08-03T10:00:00Z");
    // c_mystery: consolidation merge — must count in NEITHER column.
    cMystery.status = "CANCELLED";
    cMystery.cancelSource = "SYSTEM";
    cMystery.cancelReason = "MERGED";
    cMystery.cancelledAt = D("2026-08-04T10:00:00Z");
    dbHolder.current = createAnalyticsDb(store) as never;

    const series = await getSegmentChurnSeries(
      SHOP_ID,
      ["c_ch", "c_de", "c_mystery"],
      { weekCount: 4, now: NOW },
    );
    expect(series.weeks).toHaveLength(4);
    const lastWeek = series.weeks.length - 1;
    expect(series.churnedVoluntary[lastWeek]).toBe(1);
    expect(series.churnedInvoluntary[lastWeek]).toBe(1);
    // June arrivals are outside the 4-week window.
    expect(series.newSubscribers.every((n) => n === 0)).toBe(true);
  });
});

// ── Segment forecast (reconstructed history) ─────────────────────────────────

describe("getSegmentForecast", () => {
  function buildForecastStore(): { store: AnalyticsStore; ids: string[] } {
    const store = buildSegmentStore();
    const contract = store.subscriptionContracts.find((c) => c.id === "c_ch") as Row;
    // Arrival at the first charge — the reconstructed actives series counts
    // a contract only from its arrival week onward.
    contract.firstChargeAt = D("2026-05-06T10:00:00Z");
    // 10 weekly 5000-cent charges ending well before NOW.
    for (let week = 0; week < 10; week++) {
      store.billingAttempts.push({
        id: `af_${week}`,
        contractId: "c_ch",
        contract,
        status: "SUCCESS",
        amountCents: 5000,
        refundedCents: 0,
        currencyCode: "CHF",
        taxCents: null,
        discountCents: null,
        costSnapshot: null,
        completedAt: new Date(
          D("2026-05-06T10:00:00Z").getTime() + week * 7 * 86_400_000,
        ),
        orderId: null,
      });
    }
    return { store, ids: ["c_ch"] };
  }

  it("reconstructs weekly history, forecasts both metrics, and caps the grade below A with the disclosure reasons", async () => {
    const { store, ids } = buildForecastStore();
    dbHolder.current = createAnalyticsDb(store) as never;
    const forecast = await getSegmentForecast(SHOP_ID, ids, {
      horizonWeeks: 8,
      now: NOW,
    });

    expect(forecast.weeksOfHistory).toBeGreaterThanOrEqual(10);
    expect(forecast.series.activeSubscribers.forecast).toHaveLength(8);
    expect(forecast.series.netRevenueCents.forecast).toHaveLength(8);
    // One contract, alive throughout → a flat reconstructed actives series.
    expect(
      forecast.series.activeSubscribers.history.every((p) => p.value === 1),
    ).toBe(true);
    // Reconstructed history never earns the top grade…
    expect(forecast.accuracy.grade).not.toBe("A");
    // …and always says why it is different.
    expect(
      forecast.accuracy.reasons.some((r) => r.includes("reconstructed")),
    ).toBe(true);
    // Bands are ordered AND never zero-width: a constant reconstructed
    // series (this fixture's actives are flat 1) must not claim perfect
    // certainty — the sigma floor guarantees real width.
    for (const point of forecast.series.netRevenueCents.forecast) {
      expect(point.lo).toBeLessThanOrEqual(point.value);
      expect(point.hi).toBeGreaterThanOrEqual(point.value);
    }
    const activesBands = forecast.series.activeSubscribers.forecast;
    expect(activesBands.some((p) => p.hi > p.lo)).toBe(true);
    // Blend is a real candidate with its OWN walk-forward error (equal-weight
    // mean, backtested as such) — never a fabricated mean of other models.
    const blend = forecast.models.find((m) => m.key === "blend");
    expect(blend?.available).toBe(true);
    expect(blend?.backtestMape).not.toBeNull();
  });

  it("returns the empty forecast (grade D, no series) for an empty segment", async () => {
    dbHolder.current = createAnalyticsDb(buildSegmentStore()) as never;
    const forecast = await getSegmentForecast(SHOP_ID, [], { now: NOW });
    expect(forecast.weeksOfHistory).toBe(0);
    expect(forecast.accuracy.grade).toBe("D");
    expect(forecast.series.activeSubscribers.history).toHaveLength(0);
  });
});
