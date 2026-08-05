/**
 * Choice validation for the cancel-flow accept step (pure part of
 * acceptOffer). The invariant under test: the flow executes EXACTLY what the
 * offer advertised and the customer chose — never a hidden default the copy
 * did not promise, and never a silent no-op recorded as a save.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_PAUSE_MAX_DAYS,
  OfferChoiceError,
  educationCareFollowUp,
  estimateRetentionEconomics,
  liveDiscountAmountCents,
  preserveEducationAck,
  resolveOfferExecution,
} from "~/services/retention/cancellation.server";
import type { SaveOffer } from "~/types/domain";

const NOW = new Date("2026-08-02T12:00:00Z");

function offer(partial: Partial<SaveOffer> & Pick<SaveOffer, "type">): SaveOffer {
  return {
    title: "t",
    description: "d",
    costCents: 0,
    params: {},
    ...partial,
  };
}

const delayOffer = offer({
  type: "CHANGE_DELIVERY_DATE",
  params: { delayWeeksOptions: [2, 4, 6, 8], defaultDelayWeeks: 4 },
});

const pauseOffer = offer({
  type: "TEMPORARY_PAUSE",
  params: {
    daysOptions: [30, 60, 90],
    defaultDays: 30,
    customResumeDateAllowed: true,
    indefiniteAllowed: false,
  },
});

const cadenceOffer = offer({
  type: "CHANGE_FREQUENCY",
  params: {
    intervalWeeksOptions: [6, 8],
    defaultIntervalWeeks: 6,
    currentIntervalWeeks: 4,
  },
});

const swapOffer = offer({
  type: "PRODUCT_SWAP",
  params: { candidates: ["gid://shopify/Product/9"], mode: "EXPLORE" },
});

const removeOffer = offer({
  type: "REMOVE_ITEM",
  params: {
    suggestedLineId: "line2",
    lineOptions: [
      { lineId: "line1", title: "Serum" },
      { lineId: "line2", title: "Cream" },
    ],
  },
});

const quantityOffer = offer({
  type: "CHANGE_QUANTITY",
  params: { lineId: "line1", currentQuantity: 3, defaultQuantity: 2 },
});

describe("CHANGE_DELIVERY_DATE — delay weeks", () => {
  it("executes the customer's chosen option", () => {
    const plan = resolveOfferExecution(delayOffer, { delayWeeks: 8 }, NOW);
    expect(plan).toEqual({ kind: "DELAY_WEEKS", weeks: 8 });
  });

  it("accepts string form values", () => {
    const plan = resolveOfferExecution(delayOffer, { delayWeeks: "6" }, NOW);
    expect(plan).toEqual({ kind: "DELAY_WEEKS", weeks: 6 });
  });

  it("falls back to the advertised default when no choice is sent", () => {
    const plan = resolveOfferExecution(delayOffer, undefined, NOW);
    expect(plan).toEqual({ kind: "DELAY_WEEKS", weeks: 4 });
  });

  it("rejects weeks outside the advertised options", () => {
    expect(() =>
      resolveOfferExecution(delayOffer, { delayWeeks: 3 }, NOW),
    ).toThrow(OfferChoiceError);
    expect(() =>
      resolveOfferExecution(delayOffer, { delayWeeks: 52 }, NOW),
    ).toThrow(OfferChoiceError);
  });

  it("maps the skip variant to SKIP_NEXT", () => {
    const plan = resolveOfferExecution(
      offer({ type: "CHANGE_DELIVERY_DATE", params: { action: "SKIP_NEXT" } }),
      undefined,
      NOW,
    );
    expect(plan).toEqual({ kind: "SKIP_NEXT" });
  });
});

describe("TEMPORARY_PAUSE — days or custom resume date", () => {
  it("executes the chosen day option (90 days, not the old silent 30)", () => {
    const plan = resolveOfferExecution(pauseOffer, { days: 90 }, NOW);
    if (plan.kind !== "PAUSE_UNTIL") throw new Error("wrong plan");
    const days = Math.round(
      (plan.resumeDate.getTime() - NOW.getTime()) / 86_400_000,
    );
    expect(days).toBe(90);
  });

  it("honours a custom resume date when the offer advertised one", () => {
    const plan = resolveOfferExecution(
      pauseOffer,
      { resumeDate: "2026-11-02T00:00:00Z" },
      NOW,
    );
    if (plan.kind !== "PAUSE_UNTIL") throw new Error("wrong plan");
    expect(plan.resumeDate.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("rejects a custom date when the offer did not advertise one", () => {
    const noCustom = offer({
      type: "TEMPORARY_PAUSE",
      params: { daysOptions: [30, 60, 90], defaultDays: 30 },
    });
    expect(() =>
      resolveOfferExecution(noCustom, { resumeDate: "2026-09-01" }, NOW),
    ).toThrow(OfferChoiceError);
  });

  it("bounds custom dates to tomorrow..180 days (never indefinite)", () => {
    expect(() =>
      resolveOfferExecution(pauseOffer, { resumeDate: "2026-08-02" }, NOW),
    ).toThrow(OfferChoiceError); // today = not a pause
    expect(() =>
      resolveOfferExecution(pauseOffer, { resumeDate: "2027-08-02" }, NOW),
    ).toThrow(OfferChoiceError); // a year out
    expect(CUSTOM_PAUSE_MAX_DAYS).toBe(180);
  });

  it("accepts TOMORROW — the datepicker's advertised minimum (calendar granularity, not now+24h)", () => {
    // NOW is midday: "2026-08-03" parses to UTC midnight, which is < now+24h.
    // The portal advertises min = isoDate(now + 1 day), so an instant
    // comparison refused the exact date the picker itself offered.
    const plan = resolveOfferExecution(
      pauseOffer,
      { resumeDate: "2026-08-03" },
      NOW,
    );
    if (plan.kind !== "PAUSE_UNTIL") throw new Error("wrong plan");
    expect(plan.resumeDate.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("accepts the max calendar day (now + 180 days) and rejects the day after", () => {
    // addDays(NOW, 180) = 2027-01-29T12:00Z → calendar max is 2027-01-29.
    const plan = resolveOfferExecution(
      pauseOffer,
      { resumeDate: "2027-01-29" },
      NOW,
    );
    expect(plan.kind).toBe("PAUSE_UNTIL");
    expect(() =>
      resolveOfferExecution(pauseOffer, { resumeDate: "2027-01-30" }, NOW),
    ).toThrow(OfferChoiceError);
  });

  it("rejects day counts outside the advertised options", () => {
    expect(() => resolveOfferExecution(pauseOffer, { days: 45 }, NOW)).toThrow(
      OfferChoiceError,
    );
  });
});

describe("CHANGE_FREQUENCY", () => {
  it("executes the chosen interval", () => {
    expect(
      resolveOfferExecution(cadenceOffer, { intervalWeeks: 8 }, NOW),
    ).toEqual({ kind: "SWITCH_CADENCE", intervalWeeks: 8 });
  });

  it("rejects intervals not advertised", () => {
    expect(() =>
      resolveOfferExecution(cadenceOffer, { intervalWeeks: 10 }, NOW),
    ).toThrow(OfferChoiceError);
  });
});

describe("CHANGE_QUANTITY", () => {
  it("defaults to the advertised reduced quantity", () => {
    expect(resolveOfferExecution(quantityOffer, undefined, NOW)).toEqual({
      kind: "CHANGE_QUANTITY",
      lineId: "line1",
      quantity: 2,
    });
  });

  it("allows any smaller-than-current quantity, rejects increases", () => {
    expect(
      resolveOfferExecution(quantityOffer, { quantity: 1 }, NOW),
    ).toEqual({ kind: "CHANGE_QUANTITY", lineId: "line1", quantity: 1 });
    expect(() =>
      resolveOfferExecution(quantityOffer, { quantity: 3 }, NOW),
    ).toThrow(OfferChoiceError);
    expect(() =>
      resolveOfferExecution(quantityOffer, { quantity: 0 }, NOW),
    ).toThrow(OfferChoiceError);
  });
});

describe("PRODUCT_SWAP — the silent-no-op bug is dead", () => {
  it("REFUSES to execute without a chosen line + variant (old code no-opped and recorded a save)", () => {
    expect(() => resolveOfferExecution(swapOffer, undefined, NOW)).toThrow(
      OfferChoiceError,
    );
    expect(() => resolveOfferExecution(swapOffer, {}, NOW)).toThrow(
      OfferChoiceError,
    );
    expect(() =>
      resolveOfferExecution(swapOffer, { lineId: "line1" }, NOW),
    ).toThrow(OfferChoiceError);
  });

  it("returns a concrete swap plan for a fully specified choice", () => {
    expect(
      resolveOfferExecution(
        swapOffer,
        { lineId: "line1", newVariantGid: "gid://shopify/ProductVariant/99" },
        NOW,
      ),
    ).toEqual({
      kind: "PRODUCT_SWAP",
      lineId: "line1",
      newVariantGid: "gid://shopify/ProductVariant/99",
    });
  });

  it("rejects a variant id that is not a variant gid", () => {
    expect(() =>
      resolveOfferExecution(
        swapOffer,
        { lineId: "line1", newVariantGid: "gid://shopify/Product/9" },
        NOW,
      ),
    ).toThrow(OfferChoiceError);
  });
});

describe("REMOVE_ITEM", () => {
  it("defaults to the suggested line and accepts any advertised option", () => {
    expect(resolveOfferExecution(removeOffer, undefined, NOW)).toEqual({
      kind: "REMOVE_LINE",
      lineId: "line2",
    });
    expect(
      resolveOfferExecution(removeOffer, { lineId: "line1" }, NOW),
    ).toEqual({ kind: "REMOVE_LINE", lineId: "line1" });
  });

  it("rejects lines that were not offered", () => {
    expect(() =>
      resolveOfferExecution(removeOffer, { lineId: "line99" }, NOW),
    ).toThrow(OfferChoiceError);
  });
});

describe("EDUCATION — an acknowledgement, never a save", () => {
  it("maps to EDUCATION_ACK (callers must keep the session open)", () => {
    const plan = resolveOfferExecution(
      offer({ type: "EDUCATION", params: { topics: ["NO_OBLIGATION"] } }),
      undefined,
      NOW,
    );
    expect(plan.kind).toBe("EDUCATION_ACK");
  });

  it("REQUIRES details when the offer promised a care review (IRRITATION)", () => {
    const careOffer = offer({
      type: "EDUCATION",
      params: { collectDetails: true, route: "CUSTOMER_CARE" },
    });
    expect(() => resolveOfferExecution(careOffer, undefined, NOW)).toThrow(
      OfferChoiceError,
    );
    expect(() =>
      resolveOfferExecution(careOffer, { details: "   " }, NOW),
    ).toThrow(OfferChoiceError);
    const plan = resolveOfferExecution(
      careOffer,
      { details: "Redness around the eyes after day 3" },
      NOW,
    );
    expect(plan).toEqual({
      kind: "EDUCATION_ACK",
      details: "Redness around the eyes after day 3",
      collectDetails: true,
      route: "CUSTOMER_CARE",
    });
  });

  it("records a care follow-up ONLY when the offer collects details or routes to care", () => {
    // The portal's confirmation banner uses the same predicate: the
    // care-team promise ("someone will review this with you personally") may
    // only render when a follow-up was actually recorded. OLD BUG: every
    // EDUCATION accept promised personal outreach that, for plain educations,
    // nobody would ever make.
    expect(educationCareFollowUp({ collectDetails: true })).toBe(true);
    expect(educationCareFollowUp({ route: "CUSTOMER_CARE" })).toBe(true);
    expect(
      educationCareFollowUp({ collectDetails: true, route: "CUSTOMER_CARE" }),
    ).toBe(true);
    // Plain educations: acknowledgement only, no outreach promise.
    expect(educationCareFollowUp({ topics: ["NO_OBLIGATION"] })).toBe(false);
    expect(educationCareFollowUp({ route: "FAQ" })).toBe(false);
    expect(educationCareFollowUp({ collectDetails: "true" })).toBe(false);
    expect(educationCareFollowUp({})).toBe(false);
    expect(educationCareFollowUp(null)).toBe(false);
    expect(educationCareFollowUp(undefined)).toBe(false);
  });
});

describe("monetary offers", () => {
  it("resolves credit and discount amounts from the ADVERTISED params only", () => {
    expect(
      resolveOfferExecution(
        offer({ type: "ACCOUNT_CREDIT", costCents: 1270, params: { amountCents: 1270 } }),
        { amountCents: 999999 }, // client-sent value is ignored
        NOW,
      ),
    ).toEqual({ kind: "ACCOUNT_CREDIT", amountCents: 1270 });
    expect(
      resolveOfferExecution(
        offer({
          type: "TEMPORARY_DISCOUNT",
          costCents: 1905,
          params: { percentOff: 15, cycles: 1, estimatedCostCents: 1905 },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ kind: "TEMPORARY_DISCOUNT", amountCents: 1905 });
  });

  it("FREE_GIFT without a configured fulfilment variant throws (no phantom saves)", () => {
    expect(() =>
      resolveOfferExecution(
        offer({ type: "FREE_GIFT", costCents: 800, params: { note: "COMPLEMENTARY_SAMPLE" } }),
        undefined,
        NOW,
      ),
    ).toThrow(/no configured gift variant/);
  });

  it("FREE_GIFT resolves to the advertised variant", () => {
    expect(
      resolveOfferExecution(
        offer({
          type: "FREE_GIFT",
          costCents: 800,
          params: { variantGid: "gid://shopify/ProductVariant/777" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ kind: "FREE_GIFT", variantGid: "gid://shopify/ProductVariant/777" });
  });

  it("PERMANENT_DISCOUNT is never automated", () => {
    expect(() =>
      resolveOfferExecution(offer({ type: "PERMANENT_DISCOUNT" }), undefined, NOW),
    ).toThrow(/not an automated offer/);
  });
});

describe("estimateRetentionEconomics (regression cover)", () => {
  it("caps the save budget by pRetain × expected contribution", () => {
    const econ = estimateRetentionEconomics({
      totalRevenueCents: 30_000,
      successfulOrders: 3,
      currentOrderValueCents: 10_000,
      avgGrossMargin: 0.5,
      churnRiskScore: 0.5,
    });
    // avg 10 000 × margin 0.5 × 6 remaining = 30 000; pRetain 0.25.
    expect(econ.expectedFutureContributionCents).toBe(30_000);
    expect(econ.pRetain).toBeCloseTo(0.25, 5);
    expect(econ.maxSaveCostCents).toBe(7_500);
  });
});

describe("preserveEducationAck — the ack survives the offers recompute", () => {
  const acked: SaveOffer[] = [
    offer({
      type: "EDUCATION",
      params: {
        collectDetails: true,
        accepted: true,
        acceptedAt: "2026-08-02T12:00:00.000Z",
        details: "Redness around the eyes after day 3",
      },
    }),
    offer({ type: "PRODUCT_SWAP", params: { candidates: ["p1"] } }),
  ];
  const rebuilt: SaveOffer[] = [
    offer({ type: "EDUCATION", params: { collectDetails: true } }),
    offer({ type: "PRODUCT_SWAP", params: { candidates: ["p1"] } }),
  ];

  it("copies accepted/acceptedAt/details onto the recomputed EDUCATION offer", () => {
    // OLD BUG: getOffersForSession rebuilt offers from scratch on every
    // IN_PROGRESS load, wiping the accepted flag — the care card re-rendered
    // under "our care team is on it", and the re-submission's addendum was
    // silently swallowed by the cancel-edu idempotency key.
    const merged = preserveEducationAck(acked, rebuilt);
    const edu = merged.find((o) => o.type === "EDUCATION");
    expect(edu?.params).toMatchObject({
      collectDetails: true,
      accepted: true,
      acceptedAt: "2026-08-02T12:00:00.000Z",
      details: "Redness around the eyes after day 3",
    });
    // Non-education offers pass through untouched.
    expect(merged.find((o) => o.type === "PRODUCT_SWAP")).toEqual(rebuilt[1]);
  });

  it("is a no-op when nothing was acknowledged (or nothing was stored)", () => {
    expect(preserveEducationAck(rebuilt, rebuilt)).toEqual(rebuilt);
    expect(preserveEducationAck([], rebuilt)).toEqual(rebuilt);
  });

  it("REGRESSION: carries the accepted EDUCATION offer into lists rebuilt WITHOUT one (reason switch)", () => {
    // Reasons share one session, and some reasons build no EDUCATION offer.
    // OLD BUG: switching IRRITATION → TOO_MUCH_PRODUCT rebuilt (and
    // persisted) offers without EDUCATION, silently dropping the ack and the
    // reported reaction details — switching back re-showed the card and a
    // re-submitted care report replayed the completed idempotency key.
    const noEdu = [offer({ type: "TEMPORARY_PAUSE" })];
    expect(preserveEducationAck(acked, noEdu)).toEqual([...noEdu, acked[0]]);
  });

  it("an UNACCEPTED education is still dropped from lists without one", () => {
    const noEdu = [offer({ type: "TEMPORARY_PAUSE" })];
    expect(preserveEducationAck(rebuilt, noEdu)).toEqual(noEdu);
  });

  it("REGRESSION: a reason-switch round trip keeps the card hidden and the details recorded", () => {
    // IRRITATION (acked) → TOO_MUCH_PRODUCT (no EDUCATION) → IRRITATION
    // (fresh EDUCATION card): the ack must survive both hops.
    const noEdu = [offer({ type: "CHANGE_QUANTITY", params: { lineId: "l1" } })];
    const afterSwitchAway = preserveEducationAck(acked, noEdu);
    const afterSwitchBack = preserveEducationAck(afterSwitchAway, rebuilt);
    const edu = afterSwitchBack.find((o) => o.type === "EDUCATION");
    expect(edu?.params).toMatchObject({
      collectDetails: true,
      accepted: true,
      acceptedAt: "2026-08-02T12:00:00.000Z",
      details: "Redness around the eyes after day 3",
    });
    // Exactly one EDUCATION offer — the carried copy merges onto the fresh
    // card instead of duplicating it.
    expect(
      afterSwitchBack.filter((o) => o.type === "EDUCATION"),
    ).toHaveLength(1);
  });
});

describe("liveDiscountAmountCents — the percent promise is honoured live", () => {
  it("recomputes 15% of the LIVE order value, not the presentation snapshot", () => {
    // Presented on a 12 700-cent order (estimated 1 905); the customer then
    // halved the plan. OLD BUG: the stale fixed credit (1 905) was worth 30%
    // of the shrunk 6 350-cent order.
    expect(liveDiscountAmountCents(6_350, 15, null)).toBe(953);
    // …and a grown order gets the full promised 15%, not less.
    expect(liveDiscountAmountCents(25_400, 15, null)).toBe(3_810);
  });

  it("clamps to the session's save budget", () => {
    expect(liveDiscountAmountCents(100_000, 15, 1_000)).toBe(1_000);
  });

  it("falls back to the default percent for garbage input and floors at 0", () => {
    expect(liveDiscountAmountCents(10_000, Number.NaN, null)).toBe(1_500);
    expect(liveDiscountAmountCents(10_000, -5, null)).toBe(1_500);
    expect(liveDiscountAmountCents(0, 15, null)).toBe(0);
    expect(liveDiscountAmountCents(-500, 15, null)).toBe(0);
  });
});
