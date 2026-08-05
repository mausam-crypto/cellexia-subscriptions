/**
 * Unit tests for the core module's pure helpers (no DB, no Shopify).
 */
import { describe, expect, it } from "vitest";
import {
  billingIdempotencyKey,
  centsToDecimalString,
  contractOpKey,
  diffReconcile,
  intervalToWeeks,
  mapShopifyContractStatus,
  normalizeOrderId,
  parseAcquisitionAttributes,
  planAdjustedPriceCents,
  productIsAvailable,
  stableFingerprint,
  weeksToInterval,
} from "~/services/core/pure";

describe("intervalToWeeks", () => {
  it("passes weeks through unchanged", () => {
    expect(intervalToWeeks("WEEK", 1)).toBe(1);
    expect(intervalToWeeks("WEEK", 6)).toBe(6);
  });

  it("approximates months as 4 weeks", () => {
    expect(intervalToWeeks("MONTH", 1)).toBe(4);
    expect(intervalToWeeks("MONTH", 3)).toBe(12);
  });

  it("converts years to 52 weeks", () => {
    expect(intervalToWeeks("YEAR", 1)).toBe(52);
  });

  it("rounds days up to at least one week", () => {
    expect(intervalToWeeks("DAY", 1)).toBe(1);
    expect(intervalToWeeks("DAY", 7)).toBe(1);
    expect(intervalToWeeks("DAY", 8)).toBe(2);
  });

  it("never returns less than one week", () => {
    expect(intervalToWeeks("WEEK", 0)).toBe(1);
    expect(intervalToWeeks("MONTH", 0)).toBe(4);
  });
});

describe("weeksToInterval", () => {
  it("always writes exact weeks back to Shopify", () => {
    expect(weeksToInterval(4)).toEqual({ interval: "WEEK", intervalCount: 4 });
    expect(weeksToInterval(12)).toEqual({ interval: "WEEK", intervalCount: 12 });
  });

  it("clamps to a minimum of one week", () => {
    expect(weeksToInterval(0)).toEqual({ interval: "WEEK", intervalCount: 1 });
    expect(weeksToInterval(-3)).toEqual({ interval: "WEEK", intervalCount: 1 });
  });

  it("round-trips through intervalToWeeks", () => {
    for (const weeks of [1, 2, 4, 8, 12]) {
      const policy = weeksToInterval(weeks);
      expect(intervalToWeeks(policy.interval, policy.intervalCount)).toBe(weeks);
    }
  });
});

describe("mapShopifyContractStatus", () => {
  it("maps the five known statuses one-to-one", () => {
    expect(mapShopifyContractStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapShopifyContractStatus("PAUSED")).toBe("PAUSED");
    expect(mapShopifyContractStatus("CANCELLED")).toBe("CANCELLED");
    expect(mapShopifyContractStatus("EXPIRED")).toBe("EXPIRED");
    expect(mapShopifyContractStatus("FAILED")).toBe("FAILED");
  });

  it("maps STALE and unknown values to FAILED so they surface", () => {
    expect(mapShopifyContractStatus("STALE")).toBe("FAILED");
    expect(mapShopifyContractStatus("SOMETHING_NEW")).toBe("FAILED");
  });
});

describe("centsToDecimalString", () => {
  it("formats integer cents as a two-decimal string", () => {
    expect(centsToDecimalString(4900)).toBe("49.00");
    expect(centsToDecimalString(1)).toBe("0.01");
    expect(centsToDecimalString(1005)).toBe("10.05");
  });
});

describe("idempotency keys", () => {
  it("builds the spec'd billing key", () => {
    expect(billingIdempotencyKey("c123", 4)).toBe("bill:c123:4");
  });

  it("is stable for identical contract-edit args", () => {
    const a = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 });
    const b = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 });
    expect(a).toBe(b);
  });

  it("differs when args differ", () => {
    const a = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 });
    const b = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 3 });
    expect(a).not.toBe(b);
  });

  it("fingerprints deterministically", () => {
    expect(stableFingerprint({ x: 1 })).toBe(stableFingerprint({ x: 1 }));
    expect(stableFingerprint({ x: 1 })).not.toBe(stableFingerprint({ x: 2 }));
  });
});

describe("contractOpKey — version token (A→B→A no longer wedges)", () => {
  const v1 = "2026-08-01T10:00:00.000Z";
  const v2 = "2026-08-01T10:00:05.000Z";

  it("a true double-submit (same args, same mirror version) replays", () => {
    const a = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 }, v1);
    const b = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 }, v1);
    expect(a).toBe(b);
  });

  it("the second 'A' of an A→B→A toggle gets a FRESH key (mirror version moved)", () => {
    // Old behaviour: qty 1→2→1→2 wedged on the second "2" for 10 minutes
    // with a false success banner. Every successful edit bumps the mirror's
    // updatedAt, so the same args re-key.
    const firstPlus = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 }, v1);
    const secondPlus = contractOpKey("c1", "CHANGE_QUANTITY", { lineId: "l1", quantity: 2 }, v2);
    expect(firstPlus).not.toBe(secondPlus);
  });

  it("pause→resume→pause→resume: the second REACTIVATE re-keys too", () => {
    const first = contractOpKey("c1", "REACTIVATE", { fromStatus: "PAUSED" }, v1);
    const second = contractOpKey("c1", "REACTIVATE", { fromStatus: "PAUSED" }, v2);
    expect(first).not.toBe(second);
  });
});

describe("planAdjustedPriceCents — subscriber pricing for swaps and added lines", () => {
  it("applies the plan discount to the variant's retail price", () => {
    // 20% plan: €54.00 retail → €43.20 subscriber (the old swap committed
    // €54.00 and silently stripped the discount on every future cycle).
    expect(planAdjustedPriceCents(20, 5400)).toBe(4320);
    expect(planAdjustedPriceCents(15, 4800)).toBe(4080);
  });

  it("rounds to whole cents", () => {
    expect(planAdjustedPriceCents(15, 4999)).toBe(4249); // 4249.15 → 4249
  });

  it("passes the retail price through when no discount is recorded", () => {
    expect(planAdjustedPriceCents(null, 5400)).toBe(5400);
    expect(planAdjustedPriceCents(0, 5400)).toBe(5400);
    expect(planAdjustedPriceCents(-5, 5400)).toBe(5400);
    expect(planAdjustedPriceCents(100, 5400)).toBe(5400);
    expect(planAdjustedPriceCents(Number.NaN, 5400)).toBe(5400);
  });
});

describe("parseAcquisitionAttributes", () => {
  it("extracts widget, experiment, discount and utm keys", () => {
    const parsed = parseAcquisitionAttributes([
      { key: "_cellexia_widget", value: "B/1.2" },
      { key: "_cellexia_experiment", value: "pdp-cadence" },
      { key: "_cellexia_variant", value: "treatment" },
      { key: "_cellexia_discount_percent", value: "15" },
      { key: "utm_source", value: "klaviyo" },
      { key: "utm_campaign", value: "spring" },
      { key: "_cellexia_custom_flag", value: "yes" },
      { key: "unrelated", value: "ignored" },
    ]);
    expect(parsed.widgetVersion).toBe("B/1.2");
    expect(parsed.experimentKey).toBe("pdp-cadence");
    expect(parsed.variantKey).toBe("treatment");
    expect(parsed.initialDiscountPercent).toBe(15);
    expect(parsed.utm).toEqual({ utm_source: "klaviyo", utm_campaign: "spring" });
    expect(parsed.custom).toEqual({ _cellexia_custom_flag: "yes" });
  });

  it("handles null, empty and malformed input", () => {
    expect(parseAcquisitionAttributes(null).widgetVersion).toBeNull();
    expect(parseAcquisitionAttributes([]).initialDiscountPercent).toBeNull();
    const parsed = parseAcquisitionAttributes([
      { key: "_cellexia_discount_percent", value: "not-a-number" },
      { key: "_cellexia_widget", value: null },
    ]);
    expect(parsed.initialDiscountPercent).toBeNull();
    expect(parsed.widgetVersion).toBeNull();
  });
});

describe("normalizeOrderId", () => {
  it("compares gids and bare ids equal", () => {
    expect(normalizeOrderId("gid://shopify/Order/42")).toBe("42");
    expect(normalizeOrderId("42")).toBe("42");
    expect(normalizeOrderId(null)).toBeNull();
  });
});

describe("diffReconcile", () => {
  const attempts = [
    { contractId: "c1", orderId: "gid://shopify/Order/1", amountCents: 4900 },
    { contractId: "c2", orderId: "gid://shopify/Order/2", amountCents: 9900 },
    { contractId: "c3", orderId: null, amountCents: 1000 },
  ];

  it("reports a clean run when everything matches", () => {
    const diff = diffReconcile(
      [attempts[0]],
      [{ id: "gid://shopify/Order/1", totalCents: 4900 }],
    );
    expect(diff.ordersWithoutAttempt).toEqual([]);
    expect(diff.attemptsWithoutOrder).toEqual([]);
    expect(diff.amountMismatches).toEqual([]);
  });

  it("finds orders missing locally and attempts missing on Shopify", () => {
    const diff = diffReconcile(attempts, [
      { id: "gid://shopify/Order/1", totalCents: 4900 },
      { id: "gid://shopify/Order/99", totalCents: 500 },
    ]);
    expect(diff.ordersWithoutAttempt).toEqual(["gid://shopify/Order/99"]);
    // c2's order is missing on Shopify; c3 has no order id at all.
    expect(diff.attemptsWithoutOrder).toEqual([
      { contractId: "c2", orderId: "gid://shopify/Order/2" },
      { contractId: "c3", orderId: null },
    ]);
  });

  it("flags amount mismatches", () => {
    const diff = diffReconcile(
      [attempts[0]],
      [{ id: "gid://shopify/Order/1", totalCents: 4500 }],
    );
    expect(diff.amountMismatches).toEqual([
      { orderId: "gid://shopify/Order/1", localCents: 4900, shopifyCents: 4500 },
    ]);
  });
});

describe("productIsAvailable", () => {
  it("is available when any variant has stock", () => {
    expect(
      productIsAvailable([
        { inventory_management: "shopify", inventory_quantity: 0 },
        { inventory_management: "shopify", inventory_quantity: 3 },
      ]),
    ).toBe(true);
  });

  it("is unavailable when every tracked variant is out", () => {
    expect(
      productIsAvailable([
        { inventory_management: "shopify", inventory_quantity: 0 },
        { inventory_management: "shopify", inventory_quantity: -2 },
      ]),
    ).toBe(false);
  });

  it("untracked or oversellable variants keep the product available", () => {
    expect(
      productIsAvailable([{ inventory_management: null, inventory_quantity: 0 }]),
    ).toBe(true);
    expect(
      productIsAvailable([
        {
          inventory_management: "shopify",
          inventory_policy: "continue",
          inventory_quantity: 0,
        },
      ]),
    ).toBe(true);
    expect(productIsAvailable([])).toBe(true);
    expect(productIsAvailable(null)).toBe(true);
  });
});
