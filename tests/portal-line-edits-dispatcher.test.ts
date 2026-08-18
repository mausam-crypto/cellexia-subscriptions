import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal dispatcher — per-line cycle edits (v1.28.0, P2.5):
 * line_skip / line_unskip / line_qty_once through the REAL api action with
 * the contracts service mocked.
 *
 *  - guard chain: session, CSRF, ownership of the LINE (a foreign lineId is
 *    refused), zod on quantity, ACTIVE only;
 *  - plan lock window: line_skip and a one-order DECREASE are reductions
 *    (toast=locked, no service call); line_unskip, an increase and the
 *    restore to the plan quantity are additions / recoveries — never blocked;
 *  - preparing-your-order window refuses all three (the cycle is being
 *    billed);
 *  - merchant switch portal.perLineCycleEdits=false refuses all three;
 *  - LAST_LINE (typed) → toast=skip_line_last_line, no generic error;
 *  - success toasts carry the order day (d1) and a signed Undo token bound
 *    to the contract (line_skip / line_qty_once specs).
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-line-edits-dispatcher";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const TZ = "Europe/Zurich";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  class CycleLineEditError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "CycleLineEditError";
      this.code = code;
    }
  }
  class ContractEditBlockedError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContractEditBlockedError";
      this.code = code;
    }
  }
  return {
    shop,
    CycleLineEditError,
    ContractEditBlockedError,
    updateDeliveryAddress: vi.fn(async (): Promise<unknown> => ({})),
    portalSettings: { perLineCycleEdits: true } as Record<string, unknown>,
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    attemptFindMany: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (): Promise<void> => {}),
    skipLineThisCycle: vi.fn(async (): Promise<unknown> => ({})),
    unskipLineThisCycle: vi.fn(async (): Promise<unknown> => ({})),
    setLineQuantityThisCycle: vi.fn(
      async (_s: string, _c: string, _l: string, _q: number | null): Promise<unknown> => ({}),
    ),
    createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: vi.fn(async () => []),
    },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
    billingAttempt: { findMany: mocks.attemptFindMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    public: {
      appProxy: vi.fn(async () => ({
        session: { shop: SHOP_DOMAIN },
        liquid: (body: string, init?: ResponseInit | number) =>
          new Response(body, typeof init === "number" ? { status: init } : init),
      })),
    },
  },
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => mocks.shop),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => mocks.shop),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") {
      return {
        contextualPrompts: false,
        allowAddProducts: true,
        otpCodeTtlMinutes: 10,
        sessionTtlDays: 30,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        friendlyLockMessaging: false,
        delayReanchors: false,
        magicLinkTtlDays: 14,
        ...mocks.portalSettings,
      };
    }
    if (key === "pause") return { maxMonths: 3 };
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: mocks.createSignedPayload,
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  CycleLineEditError: mocks.CycleLineEditError,
  ContractEditBlockedError: mocks.ContractEditBlockedError,
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  pauseContract: vi.fn(),
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  setLineQuantityThisCycle: mocks.setLineQuantityThisCycle,
  setNextBillingDate: vi.fn(),
  skipLineThisCycle: mocks.skipLineThisCycle,
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipLineThisCycle: mocks.unskipLineThisCycle,
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: mocks.updateDeliveryAddress,
}));

vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: vi.fn(),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: true,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession } from "~/lib/portal/session.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { shopDayStartUtc } from "~/lib/dates.server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NEXT_WEEK = new Date(Date.now() + 7 * DAY_MS);
const TODAY = shopDayStartUtc(new Date(), TZ);

function makeLine(over: Record<string, unknown> = {}) {
  return {
    id: "line_1",
    quantity: 2,
    isGift: false,
    isOneTimeAddon: false,
    sellingPlanId: "gid://shopify/SellingPlan/1",
    productId: "gid://shopify/Product/9",
    variantId: "gid://shopify/ProductVariant/111",
    title: "Serum",
    variantTitle: "Default Title",
    currentPriceCents: 5000,
    compareAtPriceCents: null,
    imageUrl: null,
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    lockDays: null,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: NEXT_WEEK,
    deliveryPriceCents: 0,
    createdAt: new Date(Date.now() - 100 * DAY_MS),
    firstChargeAt: new Date(Date.now() - 100 * DAY_MS),
    ordersCount: 3,
    lines: [
      makeLine(),
      makeLine({ id: "line_2", variantId: "gid://shopify/ProductVariant/222", title: "Cream", quantity: 1 }),
    ],
    ...over,
  };
}

/** Locked: subscribed 2 days ago under a 30-day lock plan. */
function lockedContract() {
  return makeContract({
    lockDays: 30,
    createdAt: new Date(Date.now() - 2 * DAY_MS),
    firstChargeAt: new Date(Date.now() - 2 * DAY_MS),
  });
}

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function licidCsrf(): Promise<string> {
  const session = await getPortalSession(
    new Request(proxyUrl("/", { logged_in_customer_id: "1" })),
  );
  return session?.csrfToken ?? "";
}

async function postAction(action: string, fields: Record<string, string> = {}): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
    return_to: "/subscription/ctr_1",
    ...fields,
  });
  return (await apiAction({
    request: new Request(proxyUrl(`/api/${action}`, { logged_in_customer_id: "1" }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    params: { action },
    context: {},
  } as never)) as Response;
}

function location(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://cellexialabs.com");
}

function expectToast(response: Response, toast: string): URL {
  const url = location(response);
  expect(url.searchParams.get("toast")).toBe(toast);
  return url;
}

function setContract(contract: unknown) {
  mocks.contractFindFirst.mockResolvedValue(contract);
  mocks.contractFindUnique.mockResolvedValue(contract);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.portalSettings = { perLineCycleEdits: true };
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([
    { lockDays: 30, shopifyPlanIds: ["gid://shopify/SellingPlan/1"] },
  ]);
  mocks.attemptFindMany.mockResolvedValue([]);
  const contract = makeContract();
  setContract(contract);
  mocks.skipLineThisCycle.mockImplementation(async () => ({
    ...contract,
    lines: [makeLine({ skippedCycleIndex: 7 }), contract.lines[1]],
  }));
  mocks.unskipLineThisCycle.mockImplementation(async () => contract);
  mocks.setLineQuantityThisCycle.mockImplementation(
    async (_s: string, _c: string, _l: string, qty: number | null) => ({
      ...contract,
      lines: [
        makeLine(
          qty === 2
            ? {}
            : { cycleQuantityOverride: qty, cycleQuantityOverrideIndex: 7 },
        ),
        contract.lines[1],
      ],
    }),
  );
});

// ── line_skip ────────────────────────────────────────────────────────────────

describe("line_skip", () => {
  it("skips the owned line and confirms with the order day + an Undo token bound to the contract", async () => {
    const response = await postAction("line_skip", { lineId: "line_1" });
    const url = expectToast(response, "line_skipped");
    expect(mocks.skipLineThisCycle).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      "line_1",
      expect.objectContaining({ source: "CUSTOMER_PORTAL", actor: "customer" }),
    );
    expect(url.searchParams.get("d1")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("undo")).toBe("UNDOTOKEN");
    expect(url.searchParams.get("cid")).toBe("ctr_1");
    // The minted spec is the line_skip reverse, on the resolved cycle index.
    const [, data] = mocks.createSignedPayload.mock.calls[0] as unknown as [
      string,
      { spec: unknown; contractId: string },
    ];
    expect(data.contractId).toBe("ctr_1");
    expect(data.spec).toEqual({ kind: "line_skip", lineId: "line_1", cycleIndex: 7 });
  });

  it("refuses a lineId the contract does not own, a gift line and a one-time add-on", async () => {
    setContract(
      makeContract({
        lines: [
          makeLine(),
          makeLine({ id: "gift", isGift: true }),
          makeLine({ id: "addon", isOneTimeAddon: true }),
        ],
      }),
    );
    for (const lineId of ["line_x", "gift", "addon"]) {
      expectToast(await postAction("line_skip", { lineId }), "error");
    }
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
  });

  it("is a REDUCTION: refused inside the plan lock window with no service call", async () => {
    setContract(lockedContract());
    expectToast(await postAction("line_skip", { lineId: "line_1" }), "locked");
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
  });

  it("maps the typed LAST_LINE refusal to its own toast (never the generic error)", async () => {
    mocks.skipLineThisCycle.mockRejectedValueOnce(
      new mocks.CycleLineEditError("LAST_LINE", "would empty the cycle"),
    );
    expectToast(await postAction("line_skip", { lineId: "line_1" }), "skip_line_last_line");
  });

  it("is refused while the order is being prepared and when the merchant switch is off", async () => {
    setContract(makeContract({ nextBillingDate: TODAY }));
    expectToast(await postAction("line_skip", { lineId: "line_1" }), "preparing");
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();

    setContract(makeContract());
    mocks.portalSettings = { perLineCycleEdits: false };
    expectToast(await postAction("line_skip", { lineId: "line_1" }), "error");
    expectToast(await postAction("line_unskip", { lineId: "line_1" }), "error");
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "1" }), "error");
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
    expect(mocks.unskipLineThisCycle).not.toHaveBeenCalled();
    expect(mocks.setLineQuantityThisCycle).not.toHaveBeenCalled();
  });

  it("is ACTIVE-only", async () => {
    setContract(makeContract({ status: "PAUSED" }));
    expectToast(await postAction("line_skip", { lineId: "line_1" }), "error");
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
  });
});

// ── line_unskip ──────────────────────────────────────────────────────────────

describe("line_unskip", () => {
  it("is a RECOVERY: allowed inside the lock window", async () => {
    setContract(lockedContract());
    expectToast(await postAction("line_unskip", { lineId: "line_1" }), "line_unskipped");
    expect(mocks.unskipLineThisCycle).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      "line_1",
      expect.anything(),
    );
  });

  it("still requires ownership of the line", async () => {
    expectToast(await postAction("line_unskip", { lineId: "nope" }), "error");
    expect(mocks.unskipLineThisCycle).not.toHaveBeenCalled();
  });
});

// ── line_qty_once ────────────────────────────────────────────────────────────

describe("line_qty_once", () => {
  it("applies a one-order quantity and confirms with qty + order day + Undo (line_qty_once spec)", async () => {
    const response = await postAction("line_qty_once", { lineId: "line_1", quantity: "1" });
    const url = expectToast(response, "line_qty_once");
    expect(mocks.setLineQuantityThisCycle).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      "line_1",
      1,
      expect.anything(),
    );
    expect(url.searchParams.get("qty")).toBe("1");
    expect(url.searchParams.get("d1")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("undo")).toBe("UNDOTOKEN");
    const [, data] = mocks.createSignedPayload.mock.calls[0] as unknown as [string, { spec: unknown }];
    expect(data.spec).toEqual({
      kind: "line_qty_once",
      lineId: "line_1",
      cycleIndex: 7,
      previousOverride: null,
      override: 1,
    });
  });

  it("restoring the plan quantity confirms as line_qty_restored and undoes back to the previous override", async () => {
    setContract(
      makeContract({
        lines: [makeLine({ cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 7 }), makeLine({ id: "line_2" })],
      }),
    );
    const url = expectToast(
      await postAction("line_qty_once", { lineId: "line_1", quantity: "2" }),
      "line_qty_restored",
    );
    expect(url.searchParams.get("undo")).toBe("UNDOTOKEN");
    const [, data] = mocks.createSignedPayload.mock.calls[0] as unknown as [string, { spec: unknown }];
    expect(data.spec).toEqual({
      kind: "line_qty_once",
      lineId: "line_1",
      cycleIndex: 7,
      previousOverride: 1,
      override: null,
    });
  });

  it("a STALE override (older cycle, not yet cleared) is not a 'previous' value for the cycle the tweak lands on (review fix)", async () => {
    // Flag left over from cycle 6; the tweak lands on cycle 7 (the mock
    // service writes index 7). Undo must restore "no override", never 1.
    setContract(
      makeContract({
        lines: [makeLine({ cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 6 }), makeLine({ id: "line_2" })],
      }),
    );
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "3" }), "line_qty_once");
    const [, data] = mocks.createSignedPayload.mock.calls[0] as unknown as [string, { spec: unknown }];
    expect(data.spec).toEqual({
      kind: "line_qty_once",
      lineId: "line_1",
      cycleIndex: 7,
      previousOverride: null,
      override: 3,
    });
  });

  it("lock window blocks only a DECREASE below the plan quantity; an increase and the restore pass", async () => {
    setContract(lockedContract());
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "1" }), "locked");
    expect(mocks.setLineQuantityThisCycle).not.toHaveBeenCalled();

    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "3" }), "line_qty_once");
    expect(mocks.setLineQuantityThisCycle).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", "line_1", 3, expect.anything());

    setContract(
      lockedContract() && {
        ...lockedContract(),
        lines: [makeLine({ cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 7 }), makeLine({ id: "line_2" })],
      },
    );
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "2" }), "line_qty_restored");
  });

  it("validates the quantity through the shared bound (settings.portal.maxLineQuantity) and rejects 0", async () => {
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "0" }), "error");
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "21" }), "error");
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "abc" }), "error");
    expect(mocks.setLineQuantityThisCycle).not.toHaveBeenCalled();
  });

  it("a typed service refusal (e.g. SKIPPED_THIS_CYCLE) lands on the generic error, not a 500", async () => {
    mocks.setLineQuantityThisCycle.mockRejectedValueOnce(
      new mocks.CycleLineEditError("SKIPPED_THIS_CYCLE", "skipped"),
    );
    expectToast(await postAction("line_qty_once", { lineId: "line_1", quantity: "1" }), "error");
  });
});

// ── Source pins ──────────────────────────────────────────────────────────────

describe("source pins", () => {
  it("the three verbs sit in ACTIVE_ONLY and PREPARING_BLOCKED; line_skip / line_qty_once resolve the lock", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    const activeOnly = src.slice(src.indexOf("const ACTIVE_ONLY"), src.indexOf("if (ACTIVE_ONLY.has"));
    const preparing = src.slice(src.indexOf("const PREPARING_BLOCKED"), src.indexOf("if (PREPARING_BLOCKED.has"));
    for (const verb of ["line_skip", "line_unskip", "line_qty_once"]) {
      expect(activeOnly).toContain(`"${verb}"`);
      expect(preparing).toContain(`"${verb}"`);
    }
    expect(src).toMatch(/actionName === "line_skip" \|\|\s*actionName === "line_qty_once"/);
  });

  it("the items card labels the permanent stepper 'every order' next to the one-order stepper and uses cxs- classes only", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain('t(locale, "portal.items.qty_every_order")');
    expect(src).toContain('"portal.items.qty_this_order"');
    expect(src).toContain('api(ctx, "line_skip")');
    expect(src).toContain('api(ctx, "line_unskip")');
    expect(src).toContain('api(ctx, "line_qty_once")');
    const classes = src.match(/class="([^"]+)"/g) ?? [];
    for (const c of classes) expect(c).not.toMatch(/\bcx-/);
  });
});

// ── address (v1.28.0 review fixes: region tables + cycle-edits refusal) ──────

describe("address", () => {
  const base = { address1: "1 Main St", city: "Los Angeles", zip: "90001", countryCode: "US" };

  it("normalises the region against the country's table (name or code) and passes the code on", async () => {
    expectToast(
      await postAction("address", { ...base, provinceCode: "California" }),
      "address_updated",
    );
    const [, , address] = mocks.updateDeliveryAddress.mock.calls[0] as unknown[];
    expect(address).toMatchObject({ countryCode: "US", provinceCode: "CA" });
  });

  it("refuses an unknown region for a country with a required list (field-level toast, no Shopify call) and an unknown country", async () => {
    expectToast(
      await postAction("address", { ...base, provinceCode: "Bavaria" }),
      "address_region_invalid",
    );
    expectToast(await postAction("address", { ...base, provinceCode: "" }), "address_region_invalid");
    expectToast(await postAction("address", { ...base, countryCode: "XX", provinceCode: "CA" }), "error");
    expect(mocks.updateDeliveryAddress).not.toHaveBeenCalled();
  });

  it("countries without a required region keep free text; a Shopify refusal while cycle edits are staged maps to cycle_edits_pending", async () => {
    expectToast(
      await postAction("address", { address1: "1 Rue", city: "Paris", zip: "75001", countryCode: "fr" }),
      "address_updated",
    );
    expect((mocks.updateDeliveryAddress.mock.calls[0] as unknown[])[2]).toMatchObject({ countryCode: "FR" });

    mocks.updateDeliveryAddress.mockRejectedValueOnce(
      new mocks.ContractEditBlockedError("CYCLE_EDITS_PENDING", "refused"),
    );
    expectToast(
      await postAction("address", { address1: "1 Rue", city: "Paris", zip: "75001", countryCode: "FR" }),
      "cycle_edits_pending",
    );
  });
});
