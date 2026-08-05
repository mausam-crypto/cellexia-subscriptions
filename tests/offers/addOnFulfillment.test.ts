/**
 * Add-on fulfillment engine tests — pure decision helpers (which add-ons are
 * due, pricing per mode, remaining-delivery math, idempotency key shapes)
 * plus the mocked-prisma job flow including double-run safety and post-charge
 * consumption.
 *
 * Regression coverage for the "decorative add-ons" bug class: applied
 * RECURRING lines must carry the plan discount (never full retail), gifts
 * must apply at 0 cents, and consumption must be idempotent per charge.
 * Also pins the fulfillment-integrity fixes: the pre-commit
 * ADD_ON_APPLY_INTENT marker (no duplicate line after a partial failure),
 * the hardened applied-line lookups (never stamp/remove the base plan
 * line), attempt-id consume keys (concurrent successes never collide) and
 * the chargeAt race guard (an add-on applied after the order was built is
 * consumed by the charge that ships it).
 *
 * db.server, the core contract helpers, audit/events/idempotency and the
 * Shopify client are all mocked so importing the module touches neither
 * Prisma nor the Shopify runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionContract: { findMany: vi.fn(), findFirst: vi.fn() },
  shopSettings: { findUnique: vi.fn() },
  sellingPlanConfig: { findMany: vi.fn() },
  addOnItem: { updateMany: vi.fn(), deleteMany: vi.fn() },
  contractLine: { findFirst: vi.fn(), findMany: vi.fn() },
  auditLog: { findFirst: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const core = vi.hoisted(() => ({
  addLineToContract: vi.fn(),
  removeLineFromContract: vi.fn(),
  syncContractFromShopify: vi.fn(),
}));
vi.mock("~/services/core/contracts.server", () => core);

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

const shopifyClient = vi.hoisted(() => ({
  getOfflineAdmin: vi.fn(async () => ({ graphql: { __tag: "graphql" } })),
}));
vi.mock("~/services/core/shopifyClient.server", () => shopifyClient);

// The cross-agent pricing seam: planAdjustedPriceCents(percentOff, cents).
// Mocked with the documented contract so this suite stays hermetic while
// still asserting that RECURRING pricing routes through it.
vi.mock("~/services/core/pure", () => ({
  planAdjustedPriceCents: vi.fn(
    (percentOff: number | null, variantPriceCents: number) =>
      percentOff == null || percentOff <= 0 || percentOff >= 100
        ? variantPriceCents
        : Math.round(variantPriceCents * (1 - percentOff / 100)),
  ),
}));

// Stateful withIdempotency stand-in: first caller runs fn and stores the
// result, repeats replay it — exactly the production contract, minus Prisma.
const idem = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  keys: [] as string[],
}));
vi.mock("~/services/idempotency.server", () => ({
  withIdempotency: vi.fn(
    async (key: string, _scope: string, fn: () => Promise<unknown>) => {
      idem.keys.push(key);
      if (idem.store.has(key)) {
        return { result: idem.store.get(key), replayed: true };
      }
      const result = await fn();
      idem.store.set(key, result);
      return { result, replayed: false };
    },
  ),
}));

import {
  ADD_ON_APPLY_DAYS_DEFAULT,
  STOREFRONT_ADD_ON_NONCELESS_TTL_MS,
  addOnApplyKey,
  addOnConsumeKey,
  appliedAfterCharge,
  applyPriceCents,
  consumeAddOnsAfterCharge,
  consumeDecision,
  isAddOnDue,
  isRetentionGiftSource,
  isWithinApplyWindow,
  normalizeAddOnApplyDays,
  resolvePlanPercentOff,
  runApplyAddOnsJob,
  storefrontAddOnKey,
} from "~/services/offers/addOnFulfillment.server";

const SHOP = "cellexia-demo.myshopify.com";
const NOW = new Date("2026-08-02T08:00:00.000Z");
const BILLING = new Date("2026-08-04T00:00:00.000Z"); // 1.7 days out — in window
const CYCLE_ISO = BILLING.toISOString();

interface AddOnRow {
  id: string;
  contractId: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  quantity: number;
  priceCents: number;
  mode: string;
  remainingDeliveries: number | null;
  source: string;
  appliedAt: Date | null;
  appliedLineId: string | null;
}

function makeAddOn(overrides: Partial<AddOnRow> = {}): AddOnRow {
  return {
    id: "a1",
    contractId: "c1",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/11",
    title: "SPF Fluid",
    quantity: 1,
    priceCents: 1900,
    mode: "NEXT_ONLY",
    remainingDeliveries: null,
    source: "portal",
    appliedAt: null,
    appliedLineId: null,
    ...overrides,
  };
}

function makeContract(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    shopifyContractId: "gid://shopify/SubscriptionContract/77",
    shopifyCustomerId: "gid://shopify/Customer/9",
    customerEmail: "marie@example.com",
    status: "ACTIVE",
    nextBillingDate: BILLING,
    initialDiscountPercent: null,
    successfulOrders: 4,
    lines: [
      {
        id: "l1",
        shopifyVariantId: "gid://shopify/ProductVariant/99",
        sellingPlanId: null,
      },
    ],
    addOns: [makeAddOn()],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The job and consumption read the real clock; pin it so window math is
  // deterministic (BILLING is 1.7 days after NOW — inside the 3-day window).
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  idem.store.clear();
  idem.keys.length = 0;
  db.shopSettings.findUnique.mockResolvedValue({ settingsJson: "{}" });
  db.sellingPlanConfig.findMany.mockResolvedValue([]);
  db.addOnItem.updateMany.mockResolvedValue({ count: 1 });
  db.addOnItem.deleteMany.mockResolvedValue({ count: 1 });
  db.contractLine.findFirst.mockResolvedValue({ id: "line_new" });
  db.contractLine.findMany.mockResolvedValue([]);
  db.auditLog.findFirst.mockResolvedValue(null);
  core.addLineToContract.mockResolvedValue({ id: "c1" });
  core.removeLineFromContract.mockResolvedValue({ id: "c1" });
  core.syncContractFromShopify.mockResolvedValue({ id: "c1" });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────── Key shapes ───────────────────────────────

describe("idempotency key shapes", () => {
  it("apply key is addon-apply:<addOnId>:<cycleISO>", () => {
    expect(addOnApplyKey("a1", CYCLE_ISO)).toBe(
      `addon-apply:a1:${CYCLE_ISO}`,
    );
  });

  it("consume key is addon-consume:<contractId>:<attemptId> — per charge, never a count", () => {
    // Regression: a key built from the SUCCESS-row count let two concurrent
    // success webhooks (different attempts, same count read) collide and
    // lose one consumption. The attempt id is stable across redeliveries of
    // the same charge and unique across different charges.
    expect(addOnConsumeKey("c1", "ba_9")).toBe("addon-consume:c1:ba_9");
    expect(addOnConsumeKey("c1", "ba_9")).not.toBe(
      addOnConsumeKey("c1", "ba_10"),
    );
  });
});

describe("storefrontAddOnKey — nonce-scoped storefront add-on idempotency", () => {
  const VARIANT_GID = "gid://shopify/ProductVariant/11";

  it("REGRESSION: two distinct nonces mint distinct keys for the same contract/variant/mode", () => {
    // A date-granular key silently no-opped a deliberate second same-day
    // add of the same product while still reporting success — the customer
    // was promised two add-ons but only one AddOn row ever existed.
    const a = storefrontAddOnKey("c1", VARIANT_GID, "NEXT_ONLY", null, "n-1", NOW);
    const b = storefrontAddOnKey("c1", VARIANT_GID, "NEXT_ONLY", null, "n-2", NOW);
    expect(a.key).toBe("addon:c1:11:NEXT_ONLY:0:n-1");
    expect(b.key).toBe("addon:c1:11:NEXT_ONLY:0:n-2");
    expect(a.key).not.toBe(b.key);
  });

  it("nonce-less callers fall back to the ISO date in the final segment", () => {
    const { key } = storefrontAddOnKey("c1", VARIANT_GID, "RECURRING", null, null, NOW);
    expect(key).toBe("addon:c1:11:RECURRING:0:2026-08-02");
  });

  it("null remainingDeliveries renders as 0; a real count is embedded", () => {
    expect(
      storefrontAddOnKey("c1", VARIANT_GID, "NEXT_ONLY", null, "n", NOW).key,
    ).toContain(":NEXT_ONLY:0:");
    expect(
      storefrontAddOnKey("c1", VARIANT_GID, "N_DELIVERIES", 3, "n", NOW).key,
    ).toContain(":N_DELIVERIES:3:");
  });

  it("the canonical GID variant id reduces to its bare tail", () => {
    const { key } = storefrontAddOnKey(
      "c1",
      "gid://shopify/ProductVariant/424242",
      "NEXT_ONLY",
      null,
      "n",
      NOW,
    );
    expect(key).toBe("addon:c1:424242:NEXT_ONLY:0:n");
  });

  it("the short double-submit TTL applies ONLY without a nonce", () => {
    expect(
      storefrontAddOnKey("c1", VARIANT_GID, "NEXT_ONLY", null, null, NOW).ttlMs,
    ).toBe(STOREFRONT_ADD_ON_NONCELESS_TTL_MS);
    expect(
      storefrontAddOnKey("c1", VARIANT_GID, "NEXT_ONLY", null, "n-1", NOW).ttlMs,
    ).toBeUndefined();
  });
});

// ─────────────────────────────── Charge-time race guard ───────────────────

describe("appliedAfterCharge", () => {
  const chargeAt = new Date("2026-08-02T01:30:00.000Z");

  it("is true only when the add-on was applied strictly after the order was built", () => {
    expect(
      appliedAfterCharge(new Date("2026-08-02T06:00:00.000Z"), chargeAt),
    ).toBe(true);
    expect(
      appliedAfterCharge(new Date("2026-08-01T06:00:00.000Z"), chargeAt),
    ).toBe(false);
    expect(appliedAfterCharge(chargeAt, chargeAt)).toBe(false); // ties consume
  });

  it("is false without an appliedAt or without a chargeAt (legacy behavior)", () => {
    expect(appliedAfterCharge(null, chargeAt)).toBe(false);
    expect(appliedAfterCharge(new Date(), null)).toBe(false);
    expect(appliedAfterCharge(new Date(), undefined)).toBe(false);
  });
});

// ─────────────────────────────── Window math ──────────────────────────────

describe("normalizeAddOnApplyDays", () => {
  it("defaults to 3 and clamps to [1, 14]", () => {
    expect(ADD_ON_APPLY_DAYS_DEFAULT).toBe(3);
    expect(normalizeAddOnApplyDays(undefined)).toBe(3);
    expect(normalizeAddOnApplyDays("junk")).toBe(3);
    expect(normalizeAddOnApplyDays(null)).toBe(3);
    expect(normalizeAddOnApplyDays(0)).toBe(1);
    expect(normalizeAddOnApplyDays(99)).toBe(14);
    expect(normalizeAddOnApplyDays(6.9)).toBe(6);
    expect(normalizeAddOnApplyDays(7)).toBe(7);
  });
});

describe("isWithinApplyWindow", () => {
  it("is true up to windowDays ahead, false beyond, false without a date", () => {
    expect(isWithinApplyWindow(BILLING, NOW, 3)).toBe(true);
    expect(
      isWithinApplyWindow(new Date("2026-08-05T08:00:00.000Z"), NOW, 3),
    ).toBe(true); // exactly 3 days out
    expect(
      isWithinApplyWindow(new Date("2026-08-05T08:00:00.001Z"), NOW, 3),
    ).toBe(false);
    expect(isWithinApplyWindow(null, NOW, 3)).toBe(false);
  });

  it("treats past-due billing dates as in-window (charge is imminent)", () => {
    expect(
      isWithinApplyWindow(new Date("2026-08-01T00:00:00.000Z"), NOW, 3),
    ).toBe(true);
  });
});

// ─────────────────────────────── Due / pricing ────────────────────────────

describe("isAddOnDue", () => {
  it("unapplied NEXT_ONLY and RECURRING rows are due", () => {
    expect(isAddOnDue(makeAddOn())).toBe(true);
    expect(isAddOnDue(makeAddOn({ mode: "RECURRING" }))).toBe(true);
  });

  it("already-applied rows are never due again", () => {
    expect(isAddOnDue(makeAddOn({ appliedAt: NOW }))).toBe(false);
  });

  it("N_DELIVERIES is due only with a positive remaining count (null tolerated as 1)", () => {
    expect(
      isAddOnDue(makeAddOn({ mode: "N_DELIVERIES", remainingDeliveries: 3 })),
    ).toBe(true);
    expect(
      isAddOnDue(makeAddOn({ mode: "N_DELIVERIES", remainingDeliveries: 0 })),
    ).toBe(false);
    expect(
      isAddOnDue(makeAddOn({ mode: "N_DELIVERIES", remainingDeliveries: null })),
    ).toBe(true);
  });

  it("unknown modes are never due", () => {
    expect(isAddOnDue(makeAddOn({ mode: "MYSTERY" }))).toBe(false);
  });
});

describe("applyPriceCents", () => {
  it("RECURRING carries the plan discount — full retail is the old bug", () => {
    const addOn = makeAddOn({ mode: "RECURRING", priceCents: 6000 });
    expect(applyPriceCents(addOn, 20)).toBe(4800);
    expect(applyPriceCents(addOn, 15)).toBe(5100);
    // The regression: a discounted plan must never re-price at full retail.
    expect(applyPriceCents(addOn, 15)).not.toBe(6000);
  });

  it("RECURRING without a plan discount keeps the stored price", () => {
    const addOn = makeAddOn({ mode: "RECURRING", priceCents: 6000 });
    expect(applyPriceCents(addOn, null)).toBe(6000);
  });

  it("NEXT_ONLY and N_DELIVERIES charge the stored one-time price", () => {
    expect(applyPriceCents(makeAddOn({ priceCents: 1900 }), 20)).toBe(1900);
    expect(
      applyPriceCents(
        makeAddOn({ mode: "N_DELIVERIES", priceCents: 2500 }),
        20,
      ),
    ).toBe(2500);
  });

  it("retention gifts are always free, in every mode", () => {
    expect(isRetentionGiftSource("RETENTION_GIFT")).toBe(true);
    expect(isRetentionGiftSource("retention_gift")).toBe(true);
    expect(isRetentionGiftSource("portal")).toBe(false);
    expect(
      applyPriceCents(
        makeAddOn({ source: "RETENTION_GIFT", priceCents: 2400 }),
        null,
      ),
    ).toBe(0);
    expect(
      applyPriceCents(
        makeAddOn({
          source: "RETENTION_GIFT",
          mode: "RECURRING",
          priceCents: 2400,
        }),
        20,
      ),
    ).toBe(0);
  });
});

describe("resolvePlanPercentOff", () => {
  const entries = [
    { shopifyPlanId: "gid://shopify/SellingPlan/100", percentOff: 15 },
    { shopifyPlanId: "gid://shopify/SellingPlan/200", percentOff: 20 },
    { shopifyPlanId: "gid://shopify/SellingPlan/300", percentOff: 120 }, // junk
  ];

  it("prefers a valid initialDiscountPercent", () => {
    expect(resolvePlanPercentOff(12.5, ["100"], entries)).toBe(12.5);
  });

  it("rejects out-of-range initialDiscountPercent and falls back to plan entries", () => {
    expect(
      resolvePlanPercentOff(0, ["gid://shopify/SellingPlan/100"], entries),
    ).toBe(15);
    expect(resolvePlanPercentOff(100, ["200"], entries)).toBe(20);
  });

  it("matches GID and bare-id forms, taking the largest valid discount", () => {
    expect(resolvePlanPercentOff(null, ["100", "200"], entries)).toBe(20);
  });

  it("ignores junk entries and returns null when nothing matches", () => {
    expect(resolvePlanPercentOff(null, ["300"], entries)).toBe(null);
    expect(resolvePlanPercentOff(null, ["999"], entries)).toBe(null);
    expect(resolvePlanPercentOff(null, [null], entries)).toBe(null);
    expect(resolvePlanPercentOff(null, [], entries)).toBe(null);
  });
});

// ─────────────────────────────── Consume math ─────────────────────────────

describe("consumeDecision", () => {
  it("skips unapplied rows and RECURRING rows", () => {
    expect(consumeDecision(makeAddOn()).action).toBe("SKIP");
    expect(
      consumeDecision(makeAddOn({ mode: "RECURRING", appliedAt: NOW })).action,
    ).toBe("SKIP");
  });

  it("NEXT_ONLY removes the line after its single delivery", () => {
    expect(
      consumeDecision(
        makeAddOn({ appliedAt: NOW, remainingDeliveries: 1 }),
      ),
    ).toEqual({ action: "REMOVE_LINE", remaining: 0 });
  });

  it("N_DELIVERIES decrements until exhausted, then removes", () => {
    expect(
      consumeDecision(
        makeAddOn({ mode: "N_DELIVERIES", appliedAt: NOW, remainingDeliveries: 3 }),
      ),
    ).toEqual({ action: "DECREMENT", remaining: 2 });
    expect(
      consumeDecision(
        makeAddOn({ mode: "N_DELIVERIES", appliedAt: NOW, remainingDeliveries: 1 }),
      ),
    ).toEqual({ action: "REMOVE_LINE", remaining: 0 });
  });

  it("a zero count still maps to REMOVE_LINE (sweep for a failed removal)", () => {
    expect(
      consumeDecision(
        makeAddOn({ mode: "N_DELIVERIES", appliedAt: NOW, remainingDeliveries: 0 }),
      ),
    ).toEqual({ action: "REMOVE_LINE", remaining: 0 });
  });
});

// ─────────────────────────────── Apply job flow ───────────────────────────

describe("runApplyAddOnsJob", () => {
  it("applies a due NEXT_ONLY add-on at the stored one-time price and stamps tracking", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(1);
    expect(result.errors).toBe(0);
    expect(core.addLineToContract).toHaveBeenCalledTimes(1);
    expect(core.addLineToContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      {
        variantGid: "gid://shopify/ProductVariant/11",
        quantity: 1,
        priceCents: 1900,
      },
    );
    expect(idem.keys).toContain(`addon-apply:a1:${CYCLE_ISO}`);
    // The intent marker is written BEFORE the Shopify commit so a partial
    // failure (post-commit throw or crash) can be recognised on the next
    // run instead of committing a duplicate line.
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADD_ON_APPLY_INTENT",
        subjectId: "a1",
        payload: expect.objectContaining({
          key: `addon-apply:a1:${CYCLE_ISO}`,
          priorLineIds: [],
        }),
      }),
    );
    expect(audit.appendAudit.mock.invocationCallOrder[0]).toBeLessThan(
      core.addLineToContract.mock.invocationCallOrder[0],
    );
    // The stamping lookup is constrained to the applied line's exact shape
    // (price/quantity/no selling plan) so a createdAt tie after a sync
    // recreation can never stamp the customer's base plan line.
    expect(db.contractLine.findFirst).toHaveBeenCalledWith({
      where: {
        contractId: "c1",
        shopifyVariantId: "gid://shopify/ProductVariant/11",
        currentPriceCents: 1900,
        quantity: 1,
        sellingPlanId: null,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        appliedAt: expect.any(Date),
        appliedLineId: "line_new",
        remainingDeliveries: 1,
      }),
    });
    expect(db.addOnItem.deleteMany).not.toHaveBeenCalled();
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADD_ON_APPLIED",
        actorType: "SYSTEM",
        subjectId: "a1",
      }),
    );
    expect(events.emitLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "PRODUCT_ADDED",
        contractId: "c1",
        payload: expect.objectContaining({ addOn: true, priceCents: 1900 }),
        dedupeKey: `addon-apply:a1:${CYCLE_ISO}:applied`,
      }),
    );
  });

  it("RECURRING applies at the plan-adjusted price and deletes the row (it became a real line)", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({
        initialDiscountPercent: 20,
        addOns: [makeAddOn({ mode: "RECURRING", priceCents: 6000 })],
      }),
    ]);

    await runApplyAddOnsJob(SHOP);

    expect(core.addLineToContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      expect.objectContaining({ priceCents: 4800 }),
    );
    expect(db.addOnItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(db.addOnItem.updateMany).not.toHaveBeenCalled();
  });

  it("falls back to the selling-plan entry discount when initialDiscountPercent is null", async () => {
    db.sellingPlanConfig.findMany.mockResolvedValue([
      {
        plansJson: JSON.stringify([
          { shopifyPlanId: "gid://shopify/SellingPlan/200", percentOff: 15 },
        ]),
      },
    ]);
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({
        lines: [
          {
            id: "l1",
            shopifyVariantId: "gid://shopify/ProductVariant/99",
            sellingPlanId: "gid://shopify/SellingPlan/200",
          },
        ],
        addOns: [makeAddOn({ mode: "RECURRING", priceCents: 6000 })],
      }),
    ]);

    await runApplyAddOnsJob(SHOP);

    expect(core.addLineToContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      expect.objectContaining({ priceCents: 5100 }),
    );
  });

  it("retention gifts apply at 0 cents", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({
        addOns: [makeAddOn({ source: "RETENTION_GIFT", priceCents: 2400 })],
      }),
    ]);

    await runApplyAddOnsJob(SHOP);

    expect(core.addLineToContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      expect.objectContaining({ priceCents: 0 }),
    );
  });

  it("skips contracts billing outside the apply window", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({ nextBillingDate: new Date("2026-09-20T00:00:00.000Z") }),
    ]);

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(0);
    expect(core.addLineToContract).not.toHaveBeenCalled();
    expect(shopifyClient.getOfflineAdmin).not.toHaveBeenCalled();
  });

  it("honors settingsJson.addOnApplyDays for the window width", async () => {
    db.shopSettings.findUnique.mockResolvedValue({
      settingsJson: JSON.stringify({ addOnApplyDays: 10 }),
    });
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({ nextBillingDate: new Date("2026-08-10T00:00:00.000Z") }),
    ]);

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(1);
  });

  it("is double-run safe: the second run replays and adds nothing", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);

    const first = await runApplyAddOnsJob(SHOP);
    const second = await runApplyAddOnsJob(SHOP);

    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(core.addLineToContract).toHaveBeenCalledTimes(1);
    expect(events.emitLifecycleEvent).toHaveBeenCalledTimes(1);
  });

  it("resumes from the intent marker after a partial failure instead of committing a second line", async () => {
    // Day 1: the Shopify commit landed but the run died before stamping the
    // AddOnItem — the outer idempotency key was released and the inner
    // contract-edit key can't replay (its editVersion moved on the commit's
    // own sync). Only the ADD_ON_APPLY_INTENT marker survives.
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);
    db.auditLog.findFirst.mockResolvedValue({
      payloadJson: JSON.stringify({
        key: `addon-apply:a1:${CYCLE_ISO}`,
        priorLineIds: ["gid://shopify/SubscriptionLine/base"],
      }),
    });
    db.contractLine.findFirst.mockResolvedValue({ id: "line_committed" });

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(1);
    expect(result.errors).toBe(0);
    // The landed line is recognised after a re-sync; NO second commit — the
    // old behavior double-charged the customer every cycle.
    expect(core.syncContractFromShopify).toHaveBeenCalledTimes(1);
    expect(core.addLineToContract).not.toHaveBeenCalled();
    // Recovery lookup excludes lines that pre-existed the intent (the base
    // plan) and pins the applied shape.
    expect(db.contractLine.findFirst).toHaveBeenCalledWith({
      where: {
        contractId: "c1",
        shopifyVariantId: "gid://shopify/ProductVariant/11",
        currentPriceCents: 1900,
        quantity: 1,
        sellingPlanId: null,
        NOT: {
          shopifyLineId: { in: ["gid://shopify/SubscriptionLine/base"] },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ appliedLineId: "line_committed" }),
    });
  });

  it("an intent marker whose commit never landed still applies normally", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);
    db.auditLog.findFirst.mockResolvedValue({
      payloadJson: JSON.stringify({
        key: `addon-apply:a1:${CYCLE_ISO}`,
        priorLineIds: [],
      }),
    });
    db.contractLine.findFirst
      .mockResolvedValueOnce(null) // marker recovery: nothing landed
      .mockResolvedValueOnce({ id: "line_new" }); // post-commit stamping

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(1);
    expect(core.addLineToContract).toHaveBeenCalledTimes(1);
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ appliedLineId: "line_new" }),
    });
  });

  it("REGRESSION: a marker from a PRIOR billing cycle still routes through sync-and-detect — no re-add", async () => {
    // The partial failure crossed a cycle boundary before re-entry (billing
    // landed that afternoon, or the crashed run's 7-day in-progress
    // idempotency row outlived the ≤3-days-away billing date). OLD BUG: the
    // recovery lookup was keyed on the CURRENT cycle's ISO, found no marker,
    // and committed a second identical line — the unstamped orphan billed
    // forever.
    const OLD_CYCLE_ISO = "2026-07-07T00:00:00.000Z";
    const MARKER_AT = new Date("2026-07-06T09:00:00.000Z");
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);
    db.auditLog.findFirst.mockResolvedValue({
      createdAt: MARKER_AT,
      payloadJson: JSON.stringify({
        key: `addon-apply:a1:${OLD_CYCLE_ISO}`,
        priorLineIds: ["gid://shopify/SubscriptionLine/base"],
        priceCents: 1900,
        quantity: 1,
      }),
    });
    db.contractLine.findFirst.mockResolvedValue({ id: "line_committed" });

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.applied).toBe(1);
    expect(result.errors).toBe(0);
    // The marker lookup is cycle-agnostic: no payloadJson filter — any prior
    // intent for this AddOnItem routes through the detection path.
    expect(db.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        shop: SHOP,
        action: "ADD_ON_APPLY_INTENT",
        subjectType: "AddOnItem",
        subjectId: "a1",
      },
      orderBy: { seq: "desc" },
    });
    expect(core.syncContractFromShopify).toHaveBeenCalledTimes(1);
    expect(core.addLineToContract).not.toHaveBeenCalled();
    // Stamped with the detected line and the marker's commit-adjacent time.
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        appliedLineId: "line_committed",
        appliedAt: MARKER_AT,
      }),
    });
  });

  it("REGRESSION: RECURRING cross-cycle marker recovery deletes the row without a second line", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({
        addOns: [makeAddOn({ mode: "RECURRING", priceCents: 6000 })],
      }),
    ]);
    db.auditLog.findFirst.mockResolvedValue({
      createdAt: new Date("2026-07-06T09:00:00.000Z"),
      payloadJson: JSON.stringify({
        key: "addon-apply:a1:2026-07-07T00:00:00.000Z",
        priorLineIds: [],
        priceCents: 6000,
        quantity: 1,
      }),
    });
    db.contractLine.findFirst.mockResolvedValue({ id: "line_committed" });

    await runApplyAddOnsJob(SHOP);

    expect(core.addLineToContract).not.toHaveBeenCalled();
    expect(db.addOnItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(db.addOnItem.updateMany).not.toHaveBeenCalled();
  });

  it("detects the landed line by the marker's RECORDED price when the plan discount changed between cycles", async () => {
    // Cycle N committed the RECURRING line at 6000 (no discount); by cycle
    // N+1 the contract carries a 20% discount, so the recomputed apply price
    // is 4800 — searching with it would miss the landed line and re-add.
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({
        initialDiscountPercent: 20,
        addOns: [makeAddOn({ mode: "RECURRING", priceCents: 6000 })],
      }),
    ]);
    db.auditLog.findFirst.mockResolvedValue({
      createdAt: new Date("2026-07-06T09:00:00.000Z"),
      payloadJson: JSON.stringify({
        key: "addon-apply:a1:2026-07-07T00:00:00.000Z",
        priorLineIds: [],
        priceCents: 6000,
        quantity: 1,
      }),
    });
    db.contractLine.findFirst.mockResolvedValue({ id: "line_committed" });

    await runApplyAddOnsJob(SHOP);

    expect(db.contractLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ currentPriceCents: 6000 }),
      }),
    );
    expect(core.addLineToContract).not.toHaveBeenCalled();
  });

  it("REGRESSION: appliedAt is stamped at the commit return, never the job-start clock", async () => {
    // A slow multi-contract run: the job starts at 08:00, Shopify bills this
    // contract mid-run (order built 08:03), and the commit for this add-on
    // returns at 08:07. OLD BUG: appliedAt was the hoisted job-start `now`
    // (08:00), so appliedAfterCharge(08:00, 08:03) was false and the
    // never-shipped NEXT_ONLY line was consumed as if it shipped.
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);
    const chargeAt = new Date(NOW.getTime() + 3 * 60_000);
    const commitReturnedAt = new Date(NOW.getTime() + 7 * 60_000);
    core.addLineToContract.mockImplementation(async () => {
      vi.setSystemTime(commitReturnedAt);
      return { id: "c1" };
    });

    await runApplyAddOnsJob(SHOP);

    const { data } = db.addOnItem.updateMany.mock.calls[0][0] as {
      data: { appliedAt: Date };
    };
    expect(data.appliedAt.getTime()).toBeGreaterThanOrEqual(
      commitReturnedAt.getTime(),
    );
    // The mid-run charge cannot contain this line: it must stay applied for
    // the charge that actually ships it.
    expect(appliedAfterCharge(data.appliedAt, chargeAt)).toBe(true);
  });

  it("REGRESSION: marker recovery stamps the intent marker's createdAt, not the re-run's clock", async () => {
    // The re-run may happen days after the real commit; stamping the re-run
    // clock would postdate the real charge and spare a line that DID ship.
    const MARKER_AT = new Date("2026-08-01T23:59:00.000Z");
    db.subscriptionContract.findMany.mockResolvedValue([makeContract()]);
    db.auditLog.findFirst.mockResolvedValue({
      createdAt: MARKER_AT,
      payloadJson: JSON.stringify({
        key: `addon-apply:a1:${CYCLE_ISO}`,
        priorLineIds: [],
        priceCents: 1900,
        quantity: 1,
      }),
    });
    db.contractLine.findFirst.mockResolvedValue({ id: "line_committed" });

    await runApplyAddOnsJob(SHOP);

    expect(core.addLineToContract).not.toHaveBeenCalled();
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ appliedAt: MARKER_AT }),
    });
  });

  it("fail-soft: one bad contract never blocks the rest", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeContract({ id: "c-bad", addOns: [makeAddOn({ id: "a-bad", contractId: "c-bad" })] }),
      makeContract({ id: "c-good", addOns: [makeAddOn({ id: "a-good", contractId: "c-good" })] }),
    ]);
    core.addLineToContract
      .mockRejectedValueOnce(new Error("shopify userError"))
      .mockResolvedValue({ id: "c-good" });

    const result = await runApplyAddOnsJob(SHOP);

    expect(result.errors).toBe(1);
    expect(result.applied).toBe(1);
    expect(core.addLineToContract).toHaveBeenCalledTimes(2);
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADD_ON_APPLY_JOB",
        payload: expect.objectContaining({ applied: 1, errors: 1 }),
      }),
    );
  });
});

// ─────────────────────────────── Consumption flow ─────────────────────────

describe("consumeAddOnsAfterCharge", () => {
  it("decrements an applied N_DELIVERIES add-on without touching the line", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            mode: "N_DELIVERIES",
            appliedAt: NOW,
            appliedLineId: "l9",
            remainingDeliveries: 2,
          }),
        ],
      }),
    );

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_5");

    expect(idem.keys).toContain("addon-consume:c1:ba_5");
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { remainingDeliveries: 1 },
    });
    expect(core.removeLineFromContract).not.toHaveBeenCalled();
    expect(db.addOnItem.deleteMany).not.toHaveBeenCalled();
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ADD_ON_CONSUMED" }),
    );
  });

  it("removes the line and finalizes the row when the add-on is exhausted", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            appliedAt: NOW,
            appliedLineId: "l9",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );
    db.contractLine.findFirst.mockResolvedValue({ id: "l9" });

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_6");

    // Zeroed first so a failed removal is swept on the next charge.
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { remainingDeliveries: 0 },
    });
    expect(core.removeLineFromContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      "l9",
    );
    expect(db.addOnItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADD_ON_COMPLETED",
        payload: expect.objectContaining({
          lineRemoved: true,
          attemptId: "ba_6",
        }),
      }),
    );
  });

  it("falls back to a variant match constrained to the applied line's exact shape", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            appliedAt: NOW,
            appliedLineId: "gone",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );
    db.contractLine.findFirst
      .mockResolvedValueOnce(null) // by appliedLineId — stale
      .mockResolvedValueOnce({ id: "l77" }); // by hardened variant match

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_2");

    // Regression: an UNORDERED bare-variant fallback could resolve to the
    // customer's BASE plan line (same variant, recreated first by the sync
    // after Shopify rewrote line ids) and remove their core product. The
    // fallback must pin price, quantity and the missing selling plan.
    expect(db.contractLine.findFirst).toHaveBeenLastCalledWith({
      where: {
        contractId: "c1",
        shopifyVariantId: "gid://shopify/ProductVariant/11",
        currentPriceCents: 1900,
        quantity: 1,
        sellingPlanId: null,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(core.removeLineFromContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      "l77",
    );
  });

  it("retention gifts fall back at their applied price of 0 cents", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            source: "RETENTION_GIFT",
            priceCents: 2400,
            appliedAt: NOW,
            appliedLineId: "gone",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );
    db.contractLine.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "l88" });

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_7");

    expect(db.contractLine.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ currentPriceCents: 0 }),
      }),
    );
  });

  it("never removes a guessed line when neither lookup matches — finalizes and flags for review", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            appliedAt: NOW,
            appliedLineId: "gone",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );
    db.contractLine.findFirst.mockResolvedValue(null);

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_3");

    expect(core.removeLineFromContract).not.toHaveBeenCalled();
    expect(db.addOnItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADD_ON_COMPLETED",
        payload: expect.objectContaining({
          lineRemoved: false,
          needsReview: true,
        }),
      }),
    );
  });

  it("leaves an add-on applied AFTER the charged order was built for the charge that ships it", async () => {
    // Apply/charge race: the cycle billed at 01:30, the apply job ran at
    // 06:00 (past-due window has no lower bound), the success webhook
    // arrived last. The charged order cannot contain the just-added line —
    // consuming it would silently destroy the promise.
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            appliedAt: NOW, // applied at 08:00
            appliedLineId: "l9",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );

    const chargeAt = new Date("2026-08-02T01:30:00.000Z");
    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_8", chargeAt);

    expect(idem.keys).toHaveLength(0);
    expect(core.removeLineFromContract).not.toHaveBeenCalled();
    expect(db.addOnItem.deleteMany).not.toHaveBeenCalled();

    // The next charge (order built after the application) consumes it.
    db.contractLine.findFirst.mockResolvedValue({ id: "l9" });
    const nextChargeAt = new Date("2026-08-02T09:00:00.000Z");
    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_9", nextChargeAt);

    expect(core.removeLineFromContract).toHaveBeenCalledTimes(1);
    expect(db.addOnItem.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("is idempotent per charge: a redelivered success webhook replays", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            appliedAt: NOW,
            appliedLineId: "l9",
            remainingDeliveries: 1,
          }),
        ],
      }),
    );
    db.contractLine.findFirst.mockResolvedValue({ id: "l9" });

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_3");
    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_3");

    expect(core.removeLineFromContract).toHaveBeenCalledTimes(1);
    expect(db.addOnItem.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("different attempts mint different keys — concurrent successes can never collide", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn({
            mode: "N_DELIVERIES",
            appliedAt: NOW,
            appliedLineId: "l9",
            remainingDeliveries: 3,
          }),
        ],
      }),
    );

    // A delayed cycle-N success redelivered in the same burst as cycle
    // N+1's fresh success: distinct attempt ids, so both consume.
    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_n");
    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_n1");

    expect(idem.keys).toEqual([
      "addon-consume:c1:ba_n",
      "addon-consume:c1:ba_n1",
    ]);
    expect(db.addOnItem.updateMany).toHaveBeenCalledTimes(2);
  });

  it("skips unapplied and RECURRING rows without minting an idempotency key", async () => {
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [
          makeAddOn(), // unapplied
          makeAddOn({ id: "a2", mode: "RECURRING", appliedAt: NOW }),
        ],
      }),
    );

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_1");

    expect(idem.keys).toHaveLength(0);
    expect(db.addOnItem.updateMany).not.toHaveBeenCalled();
  });

  it("never throws — billing-success processing survives a database failure", async () => {
    db.subscriptionContract.findFirst.mockRejectedValue(
      new Error("db offline"),
    );

    await expect(
      consumeAddOnsAfterCharge(SHOP, "c1", "ba_1"),
    ).resolves.toBeUndefined();
  });

  it("a failing line removal is contained and swept on the next charge", async () => {
    const exhausted = makeAddOn({
      appliedAt: NOW,
      appliedLineId: "l9",
      remainingDeliveries: 1,
    });
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({ addOns: [exhausted] }),
    );
    db.contractLine.findFirst.mockResolvedValue({ id: "l9" });
    core.removeLineFromContract.mockRejectedValueOnce(new Error("userError"));

    await expect(
      consumeAddOnsAfterCharge(SHOP, "c1", "ba_4"),
    ).resolves.toBeUndefined();
    // Count was zeroed before the failed removal…
    expect(db.addOnItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { remainingDeliveries: 0 },
    });
    // …and the row is NOT finalized, so the next charge retries the removal.
    expect(db.addOnItem.deleteMany).not.toHaveBeenCalled();

    // Next charge: the zeroed row still maps to REMOVE_LINE (sweep).
    db.subscriptionContract.findFirst.mockResolvedValue(
      makeContract({
        addOns: [{ ...exhausted, remainingDeliveries: 0 }],
      }),
    );
    core.removeLineFromContract.mockResolvedValue({ id: "c1" });

    await consumeAddOnsAfterCharge(SHOP, "c1", "ba_5");

    expect(core.removeLineFromContract).toHaveBeenCalledTimes(2);
    expect(db.addOnItem.deleteMany).toHaveBeenCalledTimes(1);
  });
});
