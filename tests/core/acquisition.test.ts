/**
 * Unit tests for the schemaVersion-2 acquisition builders (pure, no I/O).
 * Contract: docs/LEARNING-DATA-V2.md §2.
 */
import { describe, expect, it } from "vitest";
import {
  buildAcquisition,
  deriveChannel,
  mergeAcquisition,
  normalizeAttributes,
  zip3,
} from "~/services/core/acquisition.server";

describe("deriveChannel", () => {
  it("maps the meta family of utm_source values to meta-ads", () => {
    for (const source of ["facebook", "fb", "Meta", "instagram", "IG"]) {
      expect(deriveChannel({ utmSource: source })).toBe("meta-ads");
    }
  });

  it("maps google-family sources to google and email tools to klaviyo", () => {
    expect(deriveChannel({ utmSource: "google" })).toBe("google");
    expect(deriveChannel({ utmSource: "adwords" })).toBe("google");
    expect(deriveChannel({ utmSource: "Klaviyo" })).toBe("klaviyo");
    expect(deriveChannel({ utmSource: "email" })).toBe("klaviyo");
    expect(deriveChannel({ utmSource: "tiktok" })).toBe("tiktok");
  });

  it("keeps an unmapped utm_source verbatim (lowercased) — never 'unknown'", () => {
    expect(deriveChannel({ utmSource: "Pinterest" })).toBe("pinterest");
    expect(deriveChannel({ utmSource: "some-blog" })).toBe("some-blog");
  });

  it("utm_source wins over click ids and referrer", () => {
    expect(
      deriveChannel({
        utmSource: "klaviyo",
        gclid: "abc",
        referrer: "https://www.google.com/",
      }),
    ).toBe("klaviyo");
  });

  it("falls back to paid click ids: gclid → google, fbclid → meta-ads", () => {
    expect(deriveChannel({ gclid: "x" })).toBe("google");
    expect(deriveChannel({ fbclid: "y" })).toBe("meta-ads");
  });

  it("maps untagged platform referrers to organic, klaviyo hosts to klaviyo", () => {
    expect(deriveChannel({ referrer: "https://www.google.fr/search?q=x" })).toBe(
      "organic",
    );
    expect(deriveChannel({ referrer: "https://m.facebook.com/" })).toBe("organic");
    expect(deriveChannel({ referrer: "https://www.tiktok.com/@x" })).toBe("organic");
    expect(deriveChannel({ referrer: "https://links.klaviyomail.com/x" })).toBe(
      "klaviyo",
    );
  });

  it("maps other external referrers to referral and nothing to direct", () => {
    expect(deriveChannel({ referrer: "https://some-magazine.fr/article" })).toBe(
      "referral",
    );
    expect(deriveChannel({})).toBe("direct");
    expect(deriveChannel({ referrer: "not a url" })).toBe("direct");
    expect(deriveChannel({ utmSource: "   " })).toBe("direct");
  });
});

describe("zip3", () => {
  it("takes the first three characters of the cleaned postal code", () => {
    expect(zip3("69003")).toBe("690");
    expect(zip3(" sw1a 1aa ")).toBe("SW1");
    expect(zip3("75")).toBe("75");
  });

  it("returns null for empty input", () => {
    expect(zip3("")).toBeNull();
    expect(zip3("   ")).toBeNull();
    expect(zip3(null)).toBeNull();
    expect(zip3(undefined)).toBeNull();
  });
});

describe("normalizeAttributes", () => {
  it("accepts {key,value} and {name,value}, dropping empties", () => {
    expect(
      normalizeAttributes([
        { key: "_cellexia_visitor", value: "v1abc" },
        { name: "_cellexia_device", value: "mobile" },
        { name: "empty", value: "" },
        { name: "", value: "orphan" },
        { name: "nullish", value: null },
      ]),
    ).toEqual([
      { key: "_cellexia_visitor", value: "v1abc" },
      { key: "_cellexia_device", value: "mobile" },
    ]);
  });
});

describe("buildAcquisition", () => {
  const CAPTURED_AT = "2026-08-02T12:00:00.000Z";
  const FIRST_SEEN = "2026-08-02T10:29:00.000Z"; // 5460 s before capture

  const orderAttributes = [
    { name: "_cellexia_visitor", value: "v1abc123" },
    { name: "_cellexia_first_seen", value: FIRST_SEEN },
    { name: "_cellexia_referrer", value: "https://www.instagram.com/" },
    { name: "_cellexia_landing", value: "/pages/serum" },
    {
      name: "_cellexia_utm",
      value: JSON.stringify({
        utm_source: "facebook",
        utm_campaign: "launch",
        fbclid: "fb123",
      }),
    },
    { name: "_cellexia_widget", value: "TREATMENT_CHOICE:v1" },
    { name: "_cellexia_device", value: "mobile" },
    { name: "_cellexia_qty", value: "2" },
    { name: "some_other_app_key", value: "kept-verbatim" },
  ];

  it("produces the exact schemaVersion-2 shape from order inputs", () => {
    const record = buildAcquisition({
      attributes: orderAttributes,
      shippingAddress: {
        country_code: "fr",
        country: "France",
        city: "Lyon",
        province: "Rhône",
        zip: "69003",
      },
      customerLocale: "fr",
      orderName: "#1234",
      sourceName: "web",
      lines: [{ quantity: 2 }],
      capturedAt: CAPTURED_AT,
    });

    expect(record).toEqual({
      schemaVersion: 2,
      capturedAt: CAPTURED_AT,
      channel: "meta-ads",
      utm: { utm_source: "facebook", utm_campaign: "launch", fbclid: "fb123" },
      referrer: "https://www.instagram.com/",
      landingPage: "/pages/serum",
      device: "mobile",
      widgetVersion: "TREATMENT_CHOICE:v1",
      visitor: "v1abc123",
      timeToPurchaseSeconds: 5460,
      unitsInitial: 2,
      linesInitial: 1,
      geo: {
        countryCode: "FR",
        country: "France",
        city: "Lyon",
        province: "Rhône",
        zip3: "690",
      },
      customerLocale: "fr",
      orderName: "#1234",
      sourceName: "web",
      raw: {
        _cellexia_visitor: "v1abc123",
        _cellexia_first_seen: FIRST_SEEN,
        _cellexia_referrer: "https://www.instagram.com/",
        _cellexia_landing: "/pages/serum",
        _cellexia_utm: JSON.stringify({
          utm_source: "facebook",
          utm_campaign: "launch",
          fbclid: "fb123",
        }),
        _cellexia_widget: "TREATMENT_CHOICE:v1",
        _cellexia_device: "mobile",
        _cellexia_qty: "2",
        some_other_app_key: "kept-verbatim",
      },
    });
  });

  it("clamps timeToPurchaseSeconds at zero for skewed clocks", () => {
    const record = buildAcquisition({
      attributes: [
        { name: "_cellexia_first_seen", value: "2026-08-02T13:00:00.000Z" },
      ],
      capturedAt: CAPTURED_AT, // one hour BEFORE first_seen
    });
    expect(record.timeToPurchaseSeconds).toBe(0);
  });

  it("omits timeToPurchaseSeconds when first_seen is unparseable", () => {
    const record = buildAcquisition({
      attributes: [{ name: "_cellexia_first_seen", value: "not-a-date" }],
      capturedAt: CAPTURED_AT,
    });
    expect(record.timeToPurchaseSeconds).toBeUndefined();
  });

  it("survives a malformed _cellexia_utm snapshot and loose utm_* attributes", () => {
    const record = buildAcquisition({
      attributes: [
        { name: "_cellexia_utm", value: "{broken json" },
        { name: "utm_source", value: "tiktok" },
        { name: "gclid", value: "should-not-win" },
      ],
      capturedAt: CAPTURED_AT,
    });
    expect(record.utm).toEqual({ utm_source: "tiktok", gclid: "should-not-win" });
    expect(record.channel).toBe("tiktok"); // utm_source outranks gclid
  });

  it("falls back to _cellexia_qty for unitsInitial when no lines are known", () => {
    const record = buildAcquisition({
      attributes: [{ name: "_cellexia_qty", value: "3" }],
      capturedAt: CAPTURED_AT,
    });
    expect(record.unitsInitial).toBe(3);
    expect(record.linesInitial).toBeUndefined();
  });

  it("derives direct with no signals and omits absent fields entirely", () => {
    const record = buildAcquisition({ capturedAt: CAPTURED_AT });
    expect(record.channel).toBe("direct");
    expect(record.schemaVersion).toBe(2);
    expect("utm" in record).toBe(false);
    expect("geo" in record).toBe(false);
    expect("raw" in record).toBe(false);
    expect("visitor" in record).toBe(false);
  });

  it("reads the contract mirror's camelCase delivery address", () => {
    const record = buildAcquisition({
      shippingAddress: {
        countryCode: "FR",
        city: "Paris",
        provinceCode: "IDF",
        zip: "75011",
      },
      capturedAt: CAPTURED_AT,
    });
    expect(record.geo).toEqual({
      countryCode: "FR",
      city: "Paris",
      province: "IDF",
      zip3: "750",
    });
  });
});

describe("mergeAcquisition", () => {
  it("preserves unknown existing keys and never clobbers with null", () => {
    const existing = {
      widgetVersion: "TREATMENT_CHOICE:v1",
      experimentKey: "exp1:v2",
      initialDiscountPercent: 15,
      futureKey: { nested: true },
      utm: { utm_source: "facebook", utm_term: "serum" },
    };
    const merged = mergeAcquisition(existing, {
      schemaVersion: 2,
      channel: "meta-ads",
      widgetVersion: null, // must not erase the stored value
      utm: { utm_source: "facebook", utm_campaign: "launch" },
    });
    expect(merged).toEqual({
      widgetVersion: "TREATMENT_CHOICE:v1",
      experimentKey: "exp1:v2",
      initialDiscountPercent: 15,
      futureKey: { nested: true },
      utm: {
        utm_source: "facebook",
        utm_term: "serum", // survived the merge
        utm_campaign: "launch", // added by the merge
      },
      schemaVersion: 2,
      channel: "meta-ads",
    });
  });

  it("is order-tolerant: contract-create then orders-create keeps both halves", () => {
    const fromContract = buildAcquisition({
      attributes: [{ key: "_cellexia_device", value: "mobile" }],
      capturedAt: "2026-08-02T12:00:00.000Z",
    });
    const fromOrder = buildAcquisition({
      attributes: [{ name: "_cellexia_device", value: "mobile" }],
      customerLocale: "fr",
      orderName: "#1234",
      capturedAt: "2026-08-02T12:00:05.000Z",
    });
    const a = mergeAcquisition(
      mergeAcquisition({}, { ...fromContract }),
      { ...fromOrder },
    );
    const b = mergeAcquisition(
      mergeAcquisition({}, { ...fromOrder }),
      { ...fromContract },
    );
    expect(a.customerLocale).toBe("fr");
    expect(a.orderName).toBe("#1234");
    expect(a.device).toBe("mobile");
    expect(b.customerLocale).toBe("fr");
    expect(b.orderName).toBe("#1234");
    expect(b.device).toBe("mobile");
    expect(a.schemaVersion).toBe(2);
  });

  it("treats null/undefined existing as empty", () => {
    expect(mergeAcquisition(null, { channel: "direct" })).toEqual({
      channel: "direct",
    });
    expect(mergeAcquisition(undefined, {})).toEqual({});
  });

  it("replaces scalars with newer values", () => {
    expect(
      mergeAcquisition({ channel: "direct" }, { channel: "google" }).channel,
    ).toBe("google");
  });
});
