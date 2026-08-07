import { describe, expect, it } from "vitest";
import {
  ACQ_URL_MAX,
  buildAcquisitionCapture,
  deviceTypeFromUserAgent,
  orderValueBandFromCents,
  sanitizeAcquisitionUrl,
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
