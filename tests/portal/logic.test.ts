/**
 * Portal pure-logic tests — the rebuilt retention/portal machinery.
 *
 * Covers, with explicit regressions against the OLD wrong behaviour:
 *  - calendar-granular next-delivery countdown (instant-rounding bug gone)
 *  - UTC-pinned customer-facing dates (host-TZ shift bug gone)
 *  - per-line subscriber savings from selling-plan discounts (the
 *    initialDiscountPercent-only dead tile is gone; unknown hides, never 0/—)
 *  - the suggestion pipeline against the REAL offers ranker (the shape
 *    mismatch that made the upsell permanently dead is gone)
 *  - cancel-flow offer choices: whitelisting, chosen-params validation
 *    against advertised options, truthful per-offer saved confirmations
 *  - magic-link email lookup casing
 *  - portal telemetry writes (and its never-throws guarantee)
 */
import { describe, expect, it, vi } from "vitest";

const { analyticsCreate } = vi.hoisted(() => ({ analyticsCreate: vi.fn() }));

vi.mock("~/db.server", () => ({
  default: { analyticsEvent: { create: analyticsCreate } },
}));
vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: {},
  default: {},
}));

import { rankAddOnCandidates } from "~/services/offers/preShipment.server";
import {
  emailLookupCandidates,
  trackPortal,
} from "~/services/portal/auth.server";
import {
  buildAddOnRankingInputs,
  buildChosenParams,
  contractPercentOff,
  daysUntil,
  deliveryCountdownLabel,
  humanDateLabel,
  humanDateUtc,
  isPaymentHoldStatus,
  isTerminalContractStatus,
  normalizeRankedAddOns,
  oneTimePriceCents,
  perDeliverySavingsCents,
  planDiscountsFromConfigs,
  resolveLinePercentOff,
  resolvedSessionRedirect,
  savedOfferLead,
  whitelistOfferParams,
  type PortalOfferChoice,
  type SuggestionCatalogRow,
} from "~/components/portal/logic";

// ─────────────────────────────── Countdown ────────────────────────────────

describe("daysUntil (calendar-granular, UTC)", () => {
  const billing = new Date("2026-08-05T00:00:00.000Z");

  it("says 1 (tomorrow) when the charge is 10h away but on the next calendar day", () => {
    const now = new Date("2026-08-04T14:00:00.000Z");
    // OLD BUG: Math.round(10h/24h) === 0 → "Being prepared now" while a
    // skip/delay would still succeed. Calendar days must say tomorrow.
    expect(daysUntil(billing, now)).toBe(1);
    expect(daysUntil(billing, now)).not.toBe(0);
    expect(deliveryCountdownLabel(daysUntil(billing, now))).toBe(
      "Arriving in about a day",
    );
  });

  it("matches the calendar date shown beside it (no 'about a day' two days out)", () => {
    const now = new Date("2026-08-02T23:00:00.000Z");
    // OLD BUG: round(49h/24h) === 2 while the tile shows a date 3 calendar
    // days away.
    expect(daysUntil(billing, now)).toBe(3);
  });

  it("is 0 only on the billing day itself", () => {
    expect(daysUntil(billing, new Date("2026-08-05T09:00:00.000Z"))).toBe(0);
    expect(deliveryCountdownLabel(0)).toBe("Being prepared now");
  });
});

describe("humanDateUtc / humanDateLabel", () => {
  it("renders the stored UTC calendar day on any host timezone", () => {
    // OLD BUG: an unpinned Intl formatter on a negative-offset host rendered
    // 2026-08-05T00:00Z as "4 August".
    expect(humanDateUtc(new Date("2026-08-05T00:00:00.000Z"))).toBe("5 August");
    expect(humanDateLabel("2026-08-05T00:00:00.000Z")).toBe("5 August");
  });

  it("is null-safe for missing or invalid dates", () => {
    expect(humanDateLabel(null)).toBeNull();
    expect(humanDateLabel("not-a-date")).toBeNull();
  });
});

// ─────────────────────────────── Status branching ─────────────────────────

describe("contract status branching", () => {
  it("treats CANCELLED and EXPIRED as terminal (closed-plan screen)", () => {
    expect(isTerminalContractStatus("CANCELLED")).toBe(true);
    expect(isTerminalContractStatus("EXPIRED")).toBe(true);
    expect(isTerminalContractStatus("ACTIVE")).toBe(false);
    expect(isTerminalContractStatus("PAUSED")).toBe(false);
  });

  it("treats FAILED as a payment hold, not terminal", () => {
    expect(isPaymentHoldStatus("FAILED")).toBe(true);
    expect(isTerminalContractStatus("FAILED")).toBe(false);
    expect(isPaymentHoldStatus("ACTIVE")).toBe(false);
  });
});

// ─────────────────────────────── Savings ──────────────────────────────────

const PLANS_JSON = JSON.stringify([
  {
    name: "Every 4 weeks",
    intervalWeeks: 4,
    percentOff: 20,
    shopifyPlanId: "gid://shopify/SellingPlan/111",
  },
  {
    name: "Committed 6",
    intervalWeeks: 4,
    percentOff: 25,
    shopifyPlanId: "gid://shopify/SellingPlan/222",
    minDeliveries: 6,
  },
]);

describe("planDiscountsFromConfigs / resolveLinePercentOff", () => {
  const discounts = planDiscountsFromConfigs([PLANS_JSON]);

  it("indexes by selling-plan id tail with committed/standard defaults", () => {
    expect(discounts.byPlanId["111"]).toBe(20);
    expect(discounts.byPlanId["222"]).toBe(25);
    expect(discounts.standardDefault).toBe(20);
    expect(discounts.committedDefault).toBe(25);
  });

  it("matches a line's plan whether stored as gid or bare id", () => {
    expect(resolveLinePercentOff("gid://shopify/SellingPlan/111", discounts)).toBe(20);
    expect(resolveLinePercentOff("111", discounts)).toBe(20);
  });

  it("falls back plan match → defaults → recorded checkout discount → null", () => {
    expect(resolveLinePercentOff("999", discounts)).toBe(20); // standard default
    expect(
      resolveLinePercentOff("999", discounts, { committedPlan: true }),
    ).toBe(25); // committed default preferred
    const empty = planDiscountsFromConfigs([]);
    expect(
      resolveLinePercentOff(null, empty, { initialDiscountPercent: 15 }),
    ).toBe(15);
    expect(resolveLinePercentOff(null, empty)).toBeNull();
    expect(
      resolveLinePercentOff(null, empty, { initialDiscountPercent: 0 }),
    ).toBeNull();
  });

  it("survives malformed plansJson", () => {
    const parsed = planDiscountsFromConfigs(["not json", "[{\"percentOff\":\"x\"}]"]);
    expect(parsed.byPlanId).toEqual({});
    expect(parsed.standardDefault).toBeNull();
  });
});

describe("perDeliverySavingsCents", () => {
  it("derives savings from each line's own plan discount", () => {
    // €60.80 discounted at 20% → one-time €76.00 → €15.20 saved per unit.
    expect(oneTimePriceCents(6080, 20)).toBe(7600);
    const savings = perDeliverySavingsCents([
      { quantity: 1, currentPriceCents: 6080, percentOff: 20 },
    ]);
    expect(savings).toBe(1520);
  });

  it("multiplies across quantities and skips unknown-discount lines", () => {
    const savings = perDeliverySavingsCents([
      { quantity: 2, currentPriceCents: 6080, percentOff: 20 },
      { quantity: 3, currentPriceCents: 4800, percentOff: null }, // unknown → excluded
    ]);
    expect(savings).toBe(3040);
  });

  it("returns null (tile hidden) when NO line has a known discount — never 0/—", () => {
    // OLD BUG: the tile keyed on initialDiscountPercent, which no storefront
    // path populated, so every real customer saw "—" forever.
    const savings = perDeliverySavingsCents([
      { quantity: 1, currentPriceCents: 6080, percentOff: null },
    ]);
    expect(savings).toBeNull();
    expect(savings).not.toBe(0);
  });

  it("is never negative", () => {
    const savings = perDeliverySavingsCents([
      { quantity: 1, currentPriceCents: 1, percentOff: 0.0001 },
    ]);
    expect(savings).not.toBeNull();
    expect(savings!).toBeGreaterThanOrEqual(0);
  });
});

describe("contractPercentOff", () => {
  const discounts = planDiscountsFromConfigs([PLANS_JSON]);
  it("prefers the first line with a plan-matched percent", () => {
    expect(
      contractPercentOff(
        [{ sellingPlanId: null }, { sellingPlanId: "gid://shopify/SellingPlan/222" }],
        discounts,
      ),
    ).toBe(25);
  });
  it("falls back to shop defaults then the recorded discount", () => {
    expect(contractPercentOff([{ sellingPlanId: null }], discounts)).toBe(20);
    const empty = planDiscountsFromConfigs([]);
    expect(
      contractPercentOff([{ sellingPlanId: null }], empty, {
        initialDiscountPercent: 10,
      }),
    ).toBe(10);
    expect(contractPercentOff([{ sellingPlanId: null }], empty)).toBeNull();
  });
});

// ─────────────────────────────── Suggestion pipeline ──────────────────────

describe("buildAddOnRankingInputs → rankAddOnCandidates → normalizeRankedAddOns", () => {
  const gid = (n: number) => `gid://shopify/Product/${n}`;
  const lines = [{ shopifyProductId: gid(1) }];
  const catalog: SuggestionCatalogRow[] = [
    {
      shopifyProductId: gid(2),
      title: "Eye Cream",
      concern: "firmness",
      grossMarginPercent: 0.7,
      variantId: "gid://shopify/ProductVariant/22",
      priceCents: 4800,
      availableForSale: true,
    },
    {
      shopifyProductId: gid(3),
      title: "No Variant Product",
      concern: "hydration",
      grossMarginPercent: 0.8,
      variantId: null, // no sellable variant → must be dropped
      priceCents: null,
      availableForSale: false,
    },
    {
      shopifyProductId: gid(4),
      title: "Conflicting Acid",
      concern: "brightening",
      grossMarginPercent: 0.9,
      variantId: "gid://shopify/ProductVariant/44",
      priceCents: 5400,
      availableForSale: true,
    },
  ];
  const edges = [
    { fromProductId: gid(1), toProductId: gid(2), relation: "PAIRS_WITH", strength: 2 },
    { fromProductId: gid(4), toProductId: gid(1), relation: "SENSITIVITY_CONFLICT", strength: 1 },
    { fromProductId: gid(1), toProductId: gid(2), relation: "NOT_A_RELATION", strength: 9 },
  ];
  const concernByProductId = { [gid(1)]: "firmness" };

  it("builds the EXACT AddOnRankingInputs shape the ranker reads", () => {
    const inputs = buildAddOnRankingInputs({
      lines,
      catalog,
      edges,
      concernByProductId,
    });
    // OLD BUG: the portal passed {shop, contract, lines, …} and the ranker's
    // first line (`inputs.currentProductIds.map`) threw, so suggestions were
    // permanently []. These are the fields the ranker actually reads.
    expect(inputs.currentProductIds).toEqual([gid(1)]);
    expect(inputs.candidates.map((c) => c.productId)).toEqual([gid(2), gid(4)]);
    expect(inputs.candidates[0]).toMatchObject({
      productId: gid(2),
      variantId: "gid://shopify/ProductVariant/22",
      priceCents: 4800,
      marginPercent: 0.7,
      concern: "firmness",
    });
    // Unknown relations are filtered — only known CompatibilityRelations pass.
    expect(inputs.edges).toHaveLength(2);
    expect(inputs.customerConcerns).toEqual(["firmness"]);
  });

  it("produces a non-empty, priced, variant-bearing suggestion list end-to-end", () => {
    const inputs = buildAddOnRankingInputs({
      lines,
      catalog,
      edges,
      concernByProductId,
    });
    const suggestions = normalizeRankedAddOns(rankAddOnCandidates(inputs));
    expect(suggestions.length).toBeGreaterThan(0);
    const eyeCream = suggestions.find((s) => s.shopifyProductId === gid(2));
    expect(eyeCream).toBeDefined();
    expect(eyeCream!.shopifyVariantId).toBe("gid://shopify/ProductVariant/22");
    expect(eyeCream!.priceCents).toBe(4800);
    expect(eyeCream!.title).toBe("Eye Cream");
    // The conflict-blocked and variantless products never surface.
    expect(suggestions.some((s) => s.shopifyProductId === gid(4))).toBe(false);
    expect(suggestions.some((s) => s.shopifyProductId === gid(3))).toBe(false);
  });

  it("never fabricates a price: catalog rows without variant+price are dropped", () => {
    const inputs = buildAddOnRankingInputs({
      lines: [],
      catalog: [
        { ...catalog[1] },
        {
          ...catalog[0],
          priceCents: 0, // zero/invalid price → dropped too
        },
      ],
      edges: [],
      concernByProductId: {},
    });
    expect(inputs.candidates).toHaveLength(0);
  });
});

// ─────────────────────────────── Cancel-flow choices ──────────────────────

function choiceOf(params: Record<string, unknown>): PortalOfferChoice {
  return whitelistOfferParams(params);
}

const NOW = new Date("2026-08-02T10:00:00.000Z");

describe("whitelistOfferParams", () => {
  it("extracts only the customer-safe knobs", () => {
    const choice = choiceOf({
      delayWeeksOptions: [2, 4, 6, 8],
      defaultDelayWeeks: 4,
      daysOptions: [30, 60, 90],
      customResumeDateAllowed: true,
      intervalWeeksOptions: [6, 8],
      candidates: ["p1", "p2"],
      lineOptions: [{ lineId: "l1", title: "Serum" }, { junk: true }],
      suggestedLineId: "l1",
      collectDetails: true,
      secretInternal: "never",
    });
    expect(choice.delayWeeksOptions).toEqual([2, 4, 6, 8]);
    expect(choice.daysOptions).toEqual([30, 60, 90]);
    expect(choice.customResumeDateAllowed).toBe(true);
    expect(choice.intervalWeeksOptions).toEqual([6, 8]);
    expect(choice.candidateProductIds).toEqual(["p1", "p2"]);
    expect(choice.lineOptions).toEqual([{ lineId: "l1", title: "Serum" }]);
    expect(choice.collectDetails).toBe(true);
    expect("secretInternal" in choice).toBe(false);
  });

  it("is junk-safe", () => {
    const choice = choiceOf({ delayWeeksOptions: "4", daysOptions: [-1, "x"] });
    expect(choice.delayWeeksOptions).toEqual([]);
    expect(choice.daysOptions).toEqual([]);
  });
});

describe("buildChosenParams — the customer's ACTUAL choice travels", () => {
  it("CHANGE_DELIVERY_DATE: advertised week passes, tampered week is refused", () => {
    const choice = choiceOf({ delayWeeksOptions: [2, 4, 6, 8], defaultDelayWeeks: 4 });
    expect(
      buildChosenParams("CHANGE_DELIVERY_DATE", choice, { delayWeeks: "6" }, NOW),
    ).toEqual({ ok: true, chosen: { delayWeeks: 6 } });
    expect(
      buildChosenParams("CHANGE_DELIVERY_DATE", choice, { delayWeeks: "26" }, NOW),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("CHANGE_DELIVERY_DATE (skip variant): no parameters, default executes", () => {
    const choice = choiceOf({ action: "SKIP_NEXT" });
    expect(buildChosenParams("CHANGE_DELIVERY_DATE", choice, {}, NOW)).toEqual({
      ok: true,
      chosen: undefined,
    });
  });

  it("CHANGE_FREQUENCY: only advertised rhythms pass", () => {
    const choice = choiceOf({ intervalWeeksOptions: [6, 8] });
    expect(
      buildChosenParams("CHANGE_FREQUENCY", choice, { intervalWeeks: "8" }, NOW),
    ).toEqual({ ok: true, chosen: { intervalWeeks: 8 } });
    expect(
      buildChosenParams("CHANGE_FREQUENCY", choice, { intervalWeeks: "2" }, NOW),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("TEMPORARY_PAUSE: 30/60/90 pass; the promised custom date is honoured", () => {
    const choice = choiceOf({
      daysOptions: [30, 60, 90],
      defaultDays: 30,
      customResumeDateAllowed: true,
    });
    expect(
      buildChosenParams("TEMPORARY_PAUSE", choice, { pauseOption: "90" }, NOW),
    ).toEqual({ ok: true, chosen: { days: 90 } });
    // OLD BUG: 'pick the date it should resume' was promised but 30 days
    // always executed. The chosen resume date must survive.
    expect(
      buildChosenParams(
        "TEMPORARY_PAUSE",
        choice,
        { pauseOption: "custom", pauseCustomDate: "2026-11-01" },
        NOW,
      ),
    ).toEqual({ ok: true, chosen: { resumeDate: "2026-11-01" } });
    expect(
      buildChosenParams(
        "TEMPORARY_PAUSE",
        choice,
        { pauseOption: "custom", pauseCustomDate: "2026-01-01" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "pause-date" });
    // Bounded pauses only: beyond ~6 months is refused, mirroring the
    // retention service's CUSTOM_PAUSE_MAX_DAYS.
    expect(
      buildChosenParams(
        "TEMPORARY_PAUSE",
        choice,
        { pauseOption: "custom", pauseCustomDate: "2027-06-01" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "pause-date" });
    expect(
      buildChosenParams("TEMPORARY_PAUSE", choice, { pauseOption: "45" }, NOW),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("TEMPORARY_PAUSE: custom date refused when the offer never advertised it", () => {
    const choice = choiceOf({ daysOptions: [30], customResumeDateAllowed: false });
    expect(
      buildChosenParams(
        "TEMPORARY_PAUSE",
        choice,
        { pauseOption: "custom", pauseCustomDate: "2026-11-01" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("PRODUCT_SWAP: advertised candidate passes with the line auto-resolved", () => {
    const choice = choiceOf({
      candidates: ["p1", "p2"],
      lineOptions: [{ lineId: "l1", title: "Serum" }],
    });
    expect(
      buildChosenParams("PRODUCT_SWAP", choice, { swapProductId: "p2" }, NOW),
    ).toEqual({ ok: true, chosen: { targetProductId: "p2", lineId: "l1" } });
    expect(
      buildChosenParams("PRODUCT_SWAP", choice, { swapProductId: "evil" }, NOW),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("PRODUCT_SWAP: no candidates → the offer is unfulfillable, never a silent no-op", () => {
    // OLD BUG: accepting the swap resolved SAVED without swapping anything.
    const choice = choiceOf({ candidates: [] });
    expect(
      buildChosenParams("PRODUCT_SWAP", choice, { swapProductId: "p1" }, NOW),
    ).toEqual({ ok: false, error: "swap-unavailable" });
  });

  it("REMOVE_ITEM: defaults to the suggested line; tampered lines refused", () => {
    const choice = choiceOf({
      suggestedLineId: "l2",
      lineOptions: [
        { lineId: "l1", title: "Serum" },
        { lineId: "l2", title: "Mist" },
      ],
    });
    expect(buildChosenParams("REMOVE_ITEM", choice, {}, NOW)).toEqual({
      ok: true,
      chosen: { lineId: "l2" },
    });
    expect(
      buildChosenParams("REMOVE_ITEM", choice, { removeLineId: "l1" }, NOW),
    ).toEqual({ ok: true, chosen: { lineId: "l1" } });
    expect(
      buildChosenParams("REMOVE_ITEM", choice, { removeLineId: "evil" }, NOW),
    ).toEqual({ ok: false, error: "choice" });
  });

  it("EDUCATION with collectDetails: details are required and trimmed", () => {
    const choice = choiceOf({ collectDetails: true });
    expect(buildChosenParams("EDUCATION", choice, { details: "  " }, NOW)).toEqual(
      { ok: false, error: "details" },
    );
    expect(
      buildChosenParams("EDUCATION", choice, { details: " redness on cheeks " }, NOW),
    ).toEqual({ ok: true, chosen: { details: "redness on cheeks" } });
  });

  it("offers without options execute their stated default (chosen undefined)", () => {
    expect(
      buildChosenParams("ACCOUNT_CREDIT", choiceOf({ amountCents: 1270 }), {}, NOW),
    ).toEqual({ ok: true, chosen: undefined });
  });
});

describe("savedOfferLead — the confirmation states exactly what happened", () => {
  const base = {
    offerType: null as string | null,
    nextDeliveryLabel: "28 August",
    pausedUntilLabel: "3 October",
    amountLabel: "€12.70",
    removedTitle: "Niacinamide Serum",
    intervalWeeks: 8,
    quantity: 1,
    swapTitle: "Gentle Renewal Cream",
  };

  it("ACCOUNT_CREDIT confirms the credit and does NOT claim the date moved", () => {
    const lead = savedOfferLead({ ...base, offerType: "ACCOUNT_CREDIT" });
    // OLD BUG: every save said "Your next delivery moves to 28 August".
    expect(lead).toContain("€12.70");
    expect(lead).not.toContain("moves to");
  });

  it("CHANGE_DELIVERY_DATE keeps the (true) date-moved sentence", () => {
    expect(
      savedOfferLead({ ...base, offerType: "CHANGE_DELIVERY_DATE" }),
    ).toContain("moves to 28 August");
  });

  it("TEMPORARY_PAUSE shows the executed resume date", () => {
    expect(savedOfferLead({ ...base, offerType: "TEMPORARY_PAUSE" })).toContain(
      "3 October",
    );
  });

  it("REMOVE_ITEM / CHANGE_FREQUENCY / PRODUCT_SWAP name the actual change", () => {
    expect(savedOfferLead({ ...base, offerType: "REMOVE_ITEM" })).toContain(
      "Niacinamide Serum",
    );
    expect(savedOfferLead({ ...base, offerType: "CHANGE_FREQUENCY" })).toContain(
      "every 8 weeks",
    );
    expect(savedOfferLead({ ...base, offerType: "PRODUCT_SWAP" })).toContain(
      "Gentle Renewal Cream",
    );
  });

  it("EDUCATION promises the care follow-up, not a schedule change", () => {
    const lead = savedOfferLead({ ...base, offerType: "EDUCATION" });
    expect(lead).toContain("care team");
    expect(lead).not.toContain("moves to");
  });

  it("unknown types fall back to a safe generic line", () => {
    expect(savedOfferLead({ ...base, offerType: "SOMETHING_NEW" })).toContain(
      "Your plan is updated",
    );
  });
});

describe("resolvedSessionRedirect — no resolved session ever renders live offers", () => {
  it("lets an IN_PROGRESS session continue", () => {
    expect(resolvedSessionRedirect("IN_PROGRESS", "s1")).toBeNull();
  });

  it("sends CANCELLED to the goodbye view and SAVED to its confirmation", () => {
    expect(resolvedSessionRedirect("CANCELLED", "s1")).toBe(
      "/portal/cancel?cancelled=1",
    );
    expect(resolvedSessionRedirect("SAVED", "s1")).toBe(
      "/portal/cancel?session=s1&saved=1",
    );
  });

  it("restarts the flow for an ABANDONED (housekeeping-expired) session", () => {
    // OLD BUG: ABANDONED fell through everywhere — the stale tab rendered a
    // live offers page whose decline button 500'd, so the customer's explicit
    // cancel request did nothing and the next charge fired anyway.
    expect(resolvedSessionRedirect("ABANDONED", "s1")).toBe(
      "/portal/cancel?expired=1",
    );
  });

  it("treats any unknown outcome as expired, never as live", () => {
    expect(resolvedSessionRedirect("SOMETHING_NEW", "s1")).toBe(
      "/portal/cancel?expired=1",
    );
  });
});

// ─────────────────────────────── Magic-link casing ────────────────────────

describe("emailLookupCandidates", () => {
  it("always queries the lowercase form first", () => {
    expect(emailLookupCandidates("Marie.Dupont@Gmail.com")).toEqual([
      "marie.dupont@gmail.com",
      "Marie.Dupont@Gmail.com",
    ]);
  });

  it("collapses to a single candidate when already lowercase", () => {
    expect(emailLookupCandidates("  marie@x.com  ")).toEqual(["marie@x.com"]);
  });

  it("rejects non-emails outright", () => {
    expect(emailLookupCandidates("   ")).toEqual([]);
    expect(emailLookupCandidates("no-at-sign")).toEqual([]);
  });
});

// ─────────────────────────────── Portal telemetry ─────────────────────────

describe("trackPortal", () => {
  it("writes a PORTAL_VIEW/PORTAL_ACTION AnalyticsEvent row", async () => {
    analyticsCreate.mockResolvedValueOnce({});
    await trackPortal("shop.myshopify.com", "gid://shopify/Customer/1", "c1", "VIEW", "dashboard");
    expect(analyticsCreate).toHaveBeenCalledWith({
      data: {
        shop: "shop.myshopify.com",
        name: "PORTAL_VIEW",
        contractId: "c1",
        shopifyCustomerId: "gid://shopify/Customer/1",
        payloadJson: JSON.stringify({ detail: "dashboard", contractId: "c1" }),
      },
    });
    analyticsCreate.mockResolvedValueOnce({});
    await trackPortal("shop.myshopify.com", null, "c1", "ACTION", "skip");
    expect(analyticsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "PORTAL_ACTION" }),
      }),
    );
  });

  it("NEVER throws — telemetry cannot take a customer page down", async () => {
    analyticsCreate.mockRejectedValueOnce(new Error("db gone"));
    await expect(
      trackPortal("shop.myshopify.com", null, null, "VIEW", "dashboard"),
    ).resolves.toBeUndefined();
  });
});
