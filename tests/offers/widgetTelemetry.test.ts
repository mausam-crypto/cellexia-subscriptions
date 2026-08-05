/**
 * Round-trip test for storefront widget telemetry: the exact payloads the
 * theme extension's tele()/track() emit (extensions/treatment-widgets/assets/
 * cellexia-widgets.js) are normalised by extractWidgetTelemetry (used by the
 * proxy.api.events route) and must be readable by the analytics helpers
 * (classifyWidgetEvent / widgetTypeOf / isSubscriptionSelection).
 */
import { describe, expect, it } from "vitest";
import {
  classifyWidgetEvent,
  isSubscriptionSelection,
  widgetTypeOf,
} from "~/services/analytics/metrics.server";
import { extractWidgetTelemetry } from "~/services/offers/widgets.server";

/** Mirror the proxy route's event-name normalisation + persisted payload. */
function persistedRow(body: Record<string, unknown>): {
  name: string;
  payload: Record<string, unknown>;
} {
  const eventName = String(body.event ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 40);
  const payload = { event: eventName, ...extractWidgetTelemetry(body) };
  // Round-trip through JSON exactly like AnalyticsEvent.payloadJson.
  return {
    name: `WIDGET_${eventName}`,
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  };
}

describe("widget telemetry round trip (tele() → proxy → metrics)", () => {
  it("widget A add_to_cart with a plan counts as a subscription conversion", () => {
    // Exact shape built by track('add_to_cart', tele('A')).
    const { name, payload } = persistedRow({
      event: "add_to_cart",
      visitor: "vis-123",
      path: "/products/serum",
      ts: 1753000000000,
      widget: "A",
      productId: "1234567890",
      variantId: 44444,
      qty: 2,
      planId: "gid://shopify/SellingPlan/111",
      experimentKey: "cmexp123:variant-b",
    });

    expect(name).toBe("WIDGET_ADD_TO_CART");
    expect(classifyWidgetEvent(name)).toBe("CONVERSION");
    expect(widgetTypeOf(payload)).toBe("TREATMENT_CHOICE");
    expect(isSubscriptionSelection(payload)).toBe(true);
    expect(payload.qty).toBe(2);
    expect(payload.variantKey).toBe("variant-b");
    expect(payload.experimentKey).toBe("cmexp123:variant-b");
  });

  it("widget A add_to_cart without a plan is a conversion but not a subscription", () => {
    const { name, payload } = persistedRow({
      event: "add_to_cart",
      widget: "A",
      productId: "1234567890",
      variantId: 44444,
      qty: 1,
      planId: null,
      experimentKey: null,
    });
    expect(classifyWidgetEvent(name)).toBe("CONVERSION");
    expect(isSubscriptionSelection(payload)).toBe(false);
    expect(payload.variantKey).toBeNull();
  });

  it("widget E nudge_shown is an impression attributed to POST_ONE_TIME", () => {
    const { name, payload } = persistedRow({
      event: "nudge_shown",
      widget: "E",
      productId: "1234567890",
      variantId: 44444,
      qty: 1,
      planId: null,
      experimentKey: null,
    });
    expect(name).toBe("WIDGET_NUDGE_SHOWN");
    expect(classifyWidgetEvent(name)).toBe("IMPRESSION");
    expect(widgetTypeOf(payload)).toBe("POST_ONE_TIME");
  });

  it("widget E nudge_converted with a plan is a POST_ONE_TIME subscription conversion", () => {
    const { name, payload } = persistedRow({
      event: "nudge_converted",
      widget: "E",
      productId: "1234567890",
      variantId: 44444,
      qty: 1,
      planId: 222333,
      experimentKey: "cmexp123:control",
    });
    expect(classifyWidgetEvent(name)).toBe("CONVERSION");
    expect(widgetTypeOf(payload)).toBe("POST_ONE_TIME");
    expect(isSubscriptionSelection(payload)).toBe(true);
    expect(payload.sellingPlanId).toBe("222333");
    expect(payload.variantKey).toBe("control");
  });

  it("widget F impression / cart_convert map to CART_CONVERSION", () => {
    const impression = persistedRow({ event: "impression", widget: "F", rows: 2 });
    expect(classifyWidgetEvent(impression.name)).toBe("IMPRESSION");
    expect(widgetTypeOf(impression.payload)).toBe("CART_CONVERSION");
    expect(isSubscriptionSelection(impression.payload)).toBe(false);

    const convert = persistedRow({
      event: "cart_convert",
      widget: "F",
      productId: "1234567890",
      variantId: "44444",
      planId: "222333",
      qty: 3,
    });
    expect(classifyWidgetEvent(convert.name)).toBe("CONVERSION");
    expect(widgetTypeOf(convert.payload)).toBe("CART_CONVERSION");
    expect(isSubscriptionSelection(convert.payload)).toBe(true);
  });

  it("accepts an explicit widgetType/variantKey and rejects junk fields", () => {
    const direct = extractWidgetTelemetry({
      widgetType: "QUANTITY_CADENCE",
      variantKey: "b",
      productId: 987,
    });
    expect(direct.widgetType).toBe("QUANTITY_CADENCE");
    expect(direct.variantKey).toBe("b");
    expect(direct.productId).toBe("987");

    const junk = extractWidgetTelemetry({
      widgetType: "NOT_A_TYPE",
      widget: "Z",
      planId: { nope: true },
      qty: "three",
      experimentKey: "no-colon-here",
    });
    expect(junk.widgetType).toBeNull();
    expect(junk.sellingPlanId).toBeNull();
    expect(junk.qty).toBeNull();
    expect(junk.variantKey).toBeNull();
    expect(junk.experimentKey).toBe("no-colon-here");
  });

  it("truncates oversized fields to 100 characters", () => {
    const long = "x".repeat(500);
    const fields = extractWidgetTelemetry({
      widget: "A",
      productId: long,
      planId: long,
      variantKey: long,
    });
    expect(fields.productId).toHaveLength(100);
    expect(fields.sellingPlanId).toHaveLength(100);
    expect(fields.variantKey).toHaveLength(100);
  });
});
