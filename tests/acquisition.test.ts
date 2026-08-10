import { describe, expect, it } from "vitest";
import {
  ACQ_LIST_MAX,
  ACQ_SLUG_MAX,
  ACQ_URL_MAX,
  buildAcquisitionCapture,
  deviceTypeFromUserAgent,
  discountCodesFromInput,
  orderTagsFromInput,
  orderValueBandFromCents,
  rawUtmFromUrl,
  sanitizeAcquisitionUrl,
  sanitizeUtmValue,
  stripPiiFromText,
  timeToPurchaseSeconds,
  truncateAcqField,
  utmFromUrl,
} from "~/lib/acquisition/sanitize";
import { originPaymentCountsOnce } from "~/lib/analytics/queries.server";

/**
 * Acquisition data foundation (migration 0006):
 *  - the PURE sanitizer every ingest path shares (webhooks + import script) —
 *    privacy rules are enforced here, so these tests are the privacy contract:
 *    no raw IP, no full UA, URLs reduced to host+path+utm_*, PII scrubbed,
 *    everything length-capped;
 *  - originPaymentCountsOnce — THE double-count guard between the origin
 *    (checkout) payment mirror and successful BillingAttempts, shared by the
 *    rollup and the cohort engine.
 */

// ── stripPiiFromText ─────────────────────────────────────────────────────────

describe("stripPiiFromText", () => {
  it("redacts email addresses", () => {
    expect(stripPiiFromText("/thanks?to=jane.doe@example.com")).not.toContain(
      "jane.doe@example.com",
    );
  });

  it("redacts phone-length digit runs (with separators)", () => {
    expect(stripPiiFromText("call +41 79 123 45 67 now")).not.toContain("123");
    expect(stripPiiFromText("id 0791234567")).toContain("[redacted]");
  });

  it("redacts token-shaped strings (checkout/session tokens)", () => {
    const s = stripPiiFromText("/checkouts/cn/AbCdEf1234567890AbCdEf12/thank_you");
    expect(s).not.toContain("AbCdEf1234567890AbCdEf12");
  });

  it("leaves short human paths alone", () => {
    expect(stripPiiFromText("/products/night-cream")).toBe(
      "/products/night-cream",
    );
  });

  // The token heuristic must not eat human slugs: redacting every 20+ char
  // run destroyed real campaign names and product handles at capture, with
  // no raw copy anywhere to recompute from.
  it("keeps 20+ char kebab/snake slugs (campaign names, product handles)", () => {
    expect(stripPiiFromText("black-friday-2025-conversion")).toBe(
      "black-friday-2025-conversion",
    );
    expect(stripPiiFromText("/products/advanced-night-repair-serum")).toBe(
      "/products/advanced-night-repair-serum",
    );
  });

  it("still redacts separator-less letter+digit fusions (hex-ish tokens)", () => {
    expect(stripPiiFromText("aabbccddeeff00112233")).toContain("[redacted]");
    expect(stripPiiFromText("SECRETTOKEN1234567890")).toContain("[redacted]");
  });

  it("redacts any run longer than ACQ_SLUG_MAX regardless of shape", () => {
    const monster = "very-long-".repeat(8) + "slug"; // 84 chars
    expect(monster.length).toBeGreaterThan(ACQ_SLUG_MAX);
    expect(stripPiiFromText(monster)).toContain("[redacted]");
  });
});

// ── sanitizeUtmValue ─────────────────────────────────────────────────────────

describe("sanitizeUtmValue (utm values: digit runs are ad ids, not phones)", () => {
  it("keeps realistic campaign values verbatim", () => {
    expect(sanitizeUtmValue("black-friday-2025-conversion")).toBe(
      "black-friday-2025-conversion",
    );
    expect(sanitizeUtmValue("20260801_summer_sale")).toBe(
      "20260801_summer_sale",
    );
    // Meta/Google {{campaign.id}} templates resolve to pure-digit ids.
    expect(sanitizeUtmValue("120210123456789012")).toBe("120210123456789012");
  });

  it("still scrubs emails and token-shaped values", () => {
    expect(sanitizeUtmValue("jane.doe@example.com")).not.toContain(
      "jane.doe@example.com",
    );
    expect(sanitizeUtmValue("AbCdEf1234567890AbCdEf12")).toBe("[redacted]");
  });

  it("caps and nulls like every other field", () => {
    expect(sanitizeUtmValue("x".repeat(500))!.length).toBeLessThanOrEqual(128);
    expect(sanitizeUtmValue("")).toBeNull();
    expect(sanitizeUtmValue(undefined)).toBeNull();
    expect(sanitizeUtmValue(42)).toBeNull();
  });
});

// ── sanitizeAcquisitionUrl ───────────────────────────────────────────────────

describe("sanitizeAcquisitionUrl", () => {
  it("keeps host + path + utm_* params only on absolute URLs", () => {
    const out = sanitizeAcquisitionUrl(
      "https://www.cellexialabs.com/products/serum?utm_source=ig&utm_campaign=launch&fbclid=SECRET123&key=tok_abcdef",
    );
    expect(out).toContain("www.cellexialabs.com/products/serum");
    expect(out).toContain("utm_source=ig");
    expect(out).toContain("utm_campaign=launch");
    expect(out).not.toContain("fbclid");
    expect(out).not.toContain("SECRET123");
    expect(out).not.toContain("tok_abcdef");
  });

  it("keeps relative landing_site paths relative", () => {
    const out = sanitizeAcquisitionUrl("/products/serum?utm_medium=cpc&sid=99887766554");
    expect(out).toBe("/products/serum?utm_medium=cpc");
  });

  it("strips email-in-query even under a utm key's value", () => {
    const out = sanitizeAcquisitionUrl("/x?utm_content=a@b.com");
    expect(out).not.toContain("a@b.com");
  });

  it("caps length and returns null for empty/non-string input", () => {
    const long = `/p/${"a".repeat(5000)}`;
    expect(sanitizeAcquisitionUrl(long)!.length).toBeLessThanOrEqual(ACQ_URL_MAX);
    expect(sanitizeAcquisitionUrl("")).toBeNull();
    expect(sanitizeAcquisitionUrl(undefined)).toBeNull();
    expect(sanitizeAcquisitionUrl(42)).toBeNull();
  });

  it("scrubs unparseable input as free text instead of throwing", () => {
    const out = sanitizeAcquisitionUrl("not a url with jane@doe.com inside");
    expect(out).not.toContain("jane@doe.com");
  });

  // Landing paths ARE the landing-page dimension: a 20+ char product handle
  // must survive, or every long-handle product reads "[redacted]" forever.
  it("keeps long product-handle path segments and digit-run segments", () => {
    expect(
      sanitizeAcquisitionUrl("/products/advanced-night-repair-serum?utm_source=ig"),
    ).toBe("/products/advanced-night-repair-serum?utm_source=ig");
    expect(sanitizeAcquisitionUrl("/collections/20260801_summer_sale")).toBe(
      "/collections/20260801_summer_sale",
    );
  });

  it("still redacts checkout-token path segments", () => {
    const out = sanitizeAcquisitionUrl(
      "/checkouts/cn/AbCdEf1234567890AbCdEf12/thank_you",
    );
    expect(out).not.toContain("AbCdEf1234567890AbCdEf12");
    expect(out).toContain("/thank_you");
  });

  it("keeps digit-heavy utm values (ad-platform ids), scrubs token values", () => {
    const out = sanitizeAcquisitionUrl(
      "/l?utm_campaign=120210123456789012&utm_content=AbCdEf1234567890AbCdEf12",
    );
    expect(out).toContain("utm_campaign=120210123456789012");
    expect(out).not.toContain("AbCdEf1234567890AbCdEf12");
  });
});

// ── utmFromUrl ───────────────────────────────────────────────────────────────

describe("utmFromUrl", () => {
  it("extracts the five utm params", () => {
    expect(
      utmFromUrl(
        "/landing?utm_source=meta&utm_medium=paid&utm_campaign=q3&utm_term=cream&utm_content=v2",
      ),
    ).toEqual({
      source: "meta",
      medium: "paid",
      campaign: "q3",
      term: "cream",
      content: "v2",
    });
  });

  it("returns null (not an all-null object) when no utm present", () => {
    expect(utmFromUrl("/products/serum?variant=123")).toBeNull();
    expect(utmFromUrl("")).toBeNull();
    expect(utmFromUrl(null)).toBeNull();
  });

  // The exact values the old scrub destroyed (kebab names, date-stamped
  // names, numeric platform ids) — the campaign dimension must survive.
  it("keeps realistic campaign values intact", () => {
    expect(
      utmFromUrl(
        "/l?utm_source=meta&utm_campaign=black-friday-2025-conversion",
      )?.campaign,
    ).toBe("black-friday-2025-conversion");
    expect(utmFromUrl("/l?utm_campaign=20260801_summer_sale")?.campaign).toBe(
      "20260801_summer_sale",
    );
    expect(utmFromUrl("/l?utm_campaign=120210123456789012")?.campaign).toBe(
      "120210123456789012",
    );
  });
});

// ── rawUtmFromUrl (the recompute reserve) ────────────────────────────────────

describe("rawUtmFromUrl", () => {
  it("keeps the values capped-only — even ones the scrub would redact", () => {
    const raw = rawUtmFromUrl(
      "/l?utm_source=ig&utm_content=AbCdEf1234567890AbCdEf12",
    );
    expect(raw).toEqual({
      source: "ig",
      medium: null,
      campaign: null,
      term: null,
      content: "AbCdEf1234567890AbCdEf12",
    });
  });

  it("null when no utm at all (matches utmFromUrl's null semantics)", () => {
    expect(rawUtmFromUrl("/products/serum?variant=123")).toBeNull();
    expect(rawUtmFromUrl(null)).toBeNull();
  });
});

// ── deviceTypeFromUserAgent ──────────────────────────────────────────────────

describe("deviceTypeFromUserAgent (full UA is never stored — only this class)", () => {
  it("classifies iPhone/Android-mobile as mobile", () => {
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      ),
    ).toBe("mobile");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      ),
    ).toBe("mobile");
  });

  it("classifies iPad / Android-without-Mobile as tablet", () => {
    expect(
      deviceTypeFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"),
    ).toBe("tablet");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ),
    ).toBe("tablet");
  });

  it("classifies desktop browsers as desktop", () => {
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ),
    ).toBe("desktop");
  });

  it("returns null on absent/empty input", () => {
    expect(deviceTypeFromUserAgent(undefined)).toBeNull();
    expect(deviceTypeFromUserAgent("")).toBeNull();
    expect(deviceTypeFromUserAgent(7)).toBeNull();
  });
});

// ── orderValueBandFromCents ──────────────────────────────────────────────────

describe("orderValueBandFromCents", () => {
  it("bands major units against the documented edges", () => {
    expect(orderValueBandFromCents(0)).toBe("0_25");
    expect(orderValueBandFromCents(2499)).toBe("0_25");
    expect(orderValueBandFromCents(2500)).toBe("25_50");
    expect(orderValueBandFromCents(6400)).toBe("50_75");
    expect(orderValueBandFromCents(9900)).toBe("75_100");
    expect(orderValueBandFromCents(12000)).toBe("100_150");
    expect(orderValueBandFromCents(19999)).toBe("150_200");
    expect(orderValueBandFromCents(20000)).toBe("200_plus");
    expect(orderValueBandFromCents(250000)).toBe("200_plus");
  });

  it("is null for negative / non-numeric input", () => {
    expect(orderValueBandFromCents(-1)).toBeNull();
    expect(orderValueBandFromCents(null)).toBeNull();
    expect(orderValueBandFromCents("6400")).toBeNull();
    expect(orderValueBandFromCents(Number.NaN)).toBeNull();
  });
});

// ── timeToPurchaseSeconds ────────────────────────────────────────────────────

describe("timeToPurchaseSeconds", () => {
  it("computes account-creation → payment latency in whole seconds", () => {
    expect(
      timeToPurchaseSeconds(
        new Date("2026-08-01T10:00:00Z"),
        new Date("2026-08-01T10:20:30Z"),
      ),
    ).toBe(1230);
  });

  it("clamps clock skew at zero and nulls on missing inputs", () => {
    expect(
      timeToPurchaseSeconds(
        new Date("2026-08-01T10:00:05Z"),
        new Date("2026-08-01T10:00:00Z"),
      ),
    ).toBe(0);
    expect(timeToPurchaseSeconds(null, new Date())).toBeNull();
    expect(timeToPurchaseSeconds(new Date(), null)).toBeNull();
  });
});

// ── truncateAcqField ─────────────────────────────────────────────────────────

describe("truncateAcqField", () => {
  it("trims, caps and nulls empties", () => {
    expect(truncateAcqField("  web  ", 10)).toBe("web");
    expect(truncateAcqField("a".repeat(300), 64)!.length).toBe(64);
    expect(truncateAcqField("   ")).toBeNull();
    expect(truncateAcqField(123)).toBeNull();
  });
});

// ── List-shaped bundle fields ────────────────────────────────────────────────

describe("discountCodesFromInput / orderTagsFromInput", () => {
  it("accepts REST {code} objects and plain strings, capped", () => {
    expect(
      discountCodesFromInput([{ code: "WELCOME10", amount: "10.00" }, "VIP"]),
    ).toEqual(["WELCOME10", "VIP"]);
    expect(discountCodesFromInput([])).toEqual([]);
    expect(discountCodesFromInput(undefined)).toBeNull();
    expect(
      discountCodesFromInput(
        Array.from({ length: 50 }, (_, i) => `CODE${i}`),
      )!.length,
    ).toBe(ACQ_LIST_MAX);
  });

  it("accepts the REST comma-separated tags string and arrays, capped", () => {
    expect(orderTagsFromInput("vip, wholesale ,  ")).toEqual([
      "vip",
      "wholesale",
    ]);
    expect(orderTagsFromInput(["a", "b"])).toEqual(["a", "b"]);
    expect(orderTagsFromInput("")).toEqual([]);
    expect(orderTagsFromInput(undefined)).toBeNull();
  });
});

// ── buildAcquisitionCapture ──────────────────────────────────────────────────

describe("buildAcquisitionCapture", () => {
  const input = {
    referringSite: "https://l.instagram.com/?u=x&e=SECRETTOKEN1234567890",
    landingSite: "/products/serum?utm_source=ig&utm_medium=bio&session=tok_1234567890abcdefghij",
    sourceName: "web",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    countryCode: "ch",
    city: "Lausanne",
    provinceCode: "vd",
    unitsFirstOrder: 3,
    orderId: "gid://shopify/Order/1001",
    orderTotalCents: 12800,
    orderCurrencyCode: "CHF",
    orderProcessedAt: new Date("2026-08-05T09:00:00Z"),
  };

  it("produces column-shaped sanitized values", () => {
    const capture = buildAcquisitionCapture(input);
    expect(capture.acqSourceName).toBe("web");
    expect(capture.acqUtm).toEqual({
      source: "ig",
      medium: "bio",
      campaign: null,
      term: null,
      content: null,
    });
    expect(capture.acqCountryCode).toBe("CH");
    expect(capture.acqProvinceCode).toBe("VD");
    expect(capture.acqCity).toBe("Lausanne");
    expect(capture.acqDeviceType).toBe("mobile");
    expect(capture.acqUnitsFirstOrder).toBe(3);
    expect(capture.acqOrderValueBand).toBe("100_150");
    expect(capture.acqLandingSite).toContain("/products/serum");
    expect(capture.acqLandingSite).not.toContain("tok_1234567890abcdefghij");
  });

  it("the raw bundle carries the money context but never UA or IP", () => {
    const capture = buildAcquisitionCapture(input);
    expect(capture.acqRaw.orderTotalCents).toBe(12800);
    expect(capture.acqRaw.orderCurrencyCode).toBe("CHF");
    expect(capture.acqRaw.orderProcessedAt).toBe("2026-08-05T09:00:00.000Z");
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain("Mozilla");
    expect(serialized).not.toContain("iPhone OS");
  });

  it("handles a payload with nothing usable (all nulls, no throw)", () => {
    const capture = buildAcquisitionCapture({});
    expect(capture.acqSourceName).toBeNull();
    expect(capture.acqUtm).toBeNull();
    expect(capture.acqDeviceType).toBeNull();
    expect(capture.acqOrderValueBand).toBeNull();
    expect(capture.acqRaw.orderId).toBeNull();
  });

  it("acqRaw.rawUtm keeps the capped-only utm alongside the scrubbed edge", () => {
    const capture = buildAcquisitionCapture({
      landingSite:
        "/products/serum?utm_source=ig&utm_content=AbCdEf1234567890AbCdEf12",
    });
    expect(capture.acqUtm).toEqual({
      source: "ig",
      medium: null,
      campaign: null,
      term: null,
      content: "[redacted]",
    });
    expect(capture.acqRaw.rawUtm).toEqual({
      source: "ig",
      medium: null,
      campaign: null,
      term: null,
      content: "AbCdEf1234567890AbCdEf12",
    });
    // No utm anywhere → both edges null (never an all-null object).
    const bare = buildAcquisitionCapture({ landingSite: "/products/serum" });
    expect(bare.acqUtm).toBeNull();
    expect(bare.acqRaw.rawUtm).toBeNull();
  });

  it("carries the order-payload extras, sanitized, null when absent", () => {
    const capture = buildAcquisitionCapture({
      ...input,
      discountCodes: [{ code: "WELCOME10" }, "VIP"],
      checkoutLocale: "fr-CH",
      presentmentCurrencyCode: "eur",
      presentmentTotalCents: 11900,
      appId: 580111,
      sourceIdentifier: "pos-till-3",
      buyerAcceptsMarketing: true,
      orderTags: "subscription, first-order",
    });
    expect(capture.acqRaw.discountCodes).toEqual(["WELCOME10", "VIP"]);
    expect(capture.acqRaw.checkoutLocale).toBe("fr-CH");
    expect(capture.acqRaw.presentmentCurrencyCode).toBe("EUR");
    expect(capture.acqRaw.presentmentTotalCents).toBe(11900);
    expect(capture.acqRaw.appId).toBe(580111);
    expect(capture.acqRaw.sourceIdentifier).toBe("pos-till-3");
    expect(capture.acqRaw.buyerAcceptsMarketing).toBe(true);
    expect(capture.acqRaw.orderTags).toEqual(["subscription", "first-order"]);

    // Keys are ALWAYS present (shape parity) — null when the ingest cannot
    // supply them, so pre-feature vs no-value rows stay distinguishable.
    const bare = buildAcquisitionCapture({});
    expect(bare.acqRaw).toMatchObject({
      discountCodes: null,
      checkoutLocale: null,
      presentmentCurrencyCode: null,
      presentmentTotalCents: null,
      appId: null,
      sourceIdentifier: null,
      buyerAcceptsMarketing: null,
      orderTags: null,
      rawUtm: null,
    });
  });
});

// ── originPaymentCountsOnce (the double-count guard) ─────────────────────────

describe("originPaymentCountsOnce", () => {
  const captured = {
    originOrderId: "gid://shopify/Order/1001",
    originOrderTotalCents: 12800,
    originOrderProcessedAt: new Date("2026-08-05T09:00:00Z"),
    originOrderCurrencyCode: "CHF",
  };
  const none = new Set<string>();

  it("counts a captured, in-currency origin payment", () => {
    expect(originPaymentCountsOnce(captured, none, "CHF")).toBe(true);
  });

  it("PRECEDENCE: an origin order also claimed by a successful BillingAttempt counts once — the attempt wins", () => {
    const claimed = new Set(["gid://shopify/Order/1001"]);
    expect(originPaymentCountsOnce(captured, claimed, "CHF")).toBe(false);
    // …and an unrelated attempt order id does not block it.
    expect(
      originPaymentCountsOnce(
        captured,
        new Set(["gid://shopify/Order/9999"]),
        "CHF",
      ),
    ).toBe(true);
  });

  it("skips uncaptured payments (null total) and missing processed instants", () => {
    expect(
      originPaymentCountsOnce(
        { ...captured, originOrderTotalCents: null },
        none,
        "CHF",
      ),
    ).toBe(false);
    expect(
      originPaymentCountsOnce(
        { ...captured, originOrderProcessedAt: null },
        none,
        "CHF",
      ),
    ).toBe(false);
  });

  it("currency guard: never sums a EUR origin total into a CHF book", () => {
    expect(
      originPaymentCountsOnce(
        { ...captured, originOrderCurrencyCode: "EUR" },
        none,
        "CHF",
      ),
    ).toBe(false);
    // Legacy tolerance: an unknown currency passes (capture always writes one).
    expect(
      originPaymentCountsOnce(
        { ...captured, originOrderCurrencyCode: null },
        none,
        "CHF",
      ),
    ).toBe(true);
  });
});
