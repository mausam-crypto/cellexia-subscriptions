import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * v1.28.0 cross-stage audit — chunk 2 fixes (guards / memo / docs).
 *
 *  1. Post-exhaustion "ways to continue" touches skip a contract with a
 *     scheduled cancel (query filter + defensive re-check) — the ladder and
 *     the intent follow-up already read a scheduled cancel as a decision.
 *  2. Magic SET_FREQUENCY / USE_METHOD / SWAP refused by Shopify while
 *     one-off changes are staged (ContractEditBlockedError) → the route
 *     renders the "undo your one-off changes first" page (customer locale +
 *     portal link), not the generic "try again"; the cancel-intent
 *     follow-up never mints SET_FREQUENCY for such a contract.
 *  3. The payment-methods memo is bounded (expired entries swept on write).
 *  4. The restart link's GET confirm page memoizes the derived offer for
 *     60 s (scanner prefetches no longer trigger an Admin gift pick each).
 *  5. DunningCase.resolution's documented value set includes CUSTOMER_SKIPPED.
 *
 * Mock scaffold copied from tests/magic-use-method.test.ts.
 */
const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  const contract = {
    id: "ctr_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    locale: "fr",
    status: "CANCELLED",
    ownership: "OURS",
    isDemo: false,
    nextBillingDate: null,
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/aaaa",
    paymentInstrumentType: "CREDIT_CARD",
    lines: [],
    shop,
  };
  const setupMode = { value: false };
  return {
    shop,
    contract,
    setupMode,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
    getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
      if (key === "portal") {
        return {
          contextualPrompts: true,
          allowAddProducts: true,
          otpCodeTtlMinutes: 10,
          sessionTtlDays: 30,
          magicLinkTtlDays: 14,
          mutationsPerHour: 30,
          friendlyLockMessaging: false,
          paymentMethodsList: true,
        };
      }
      if (key === "winback") {
        return { discountCycles: 2, discountPct: 20 };
      }
      return {};
    }),
    resolveLockState: vi.fn(
      async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 }),
    ),
    createMagicToken: vi.fn(async (): Promise<string> => "TOKEN_ABC"),
    buildPortalUrl: vi.fn(
      async (): Promise<string> => "https://cellexialabs.com/apps/cellexia-subs",
    ),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
    deriveCurrentWinbackOffer: vi.fn(async (): Promise<unknown> => null),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findFirst: mocks.contractFindFirst,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    winbackState: { updateMany: vi.fn(async () => ({ count: 1 })) },
    shop: { findUnique: vi.fn(async () => mocks.shop) },
    magicLinkToken: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/contracts/lock.server", () => ({ resolveLockState: mocks.resolveLockState }));
vi.mock("~/lib/winback/engine.server", () => ({ reactivateFromWinback: vi.fn() }));
vi.mock("~/lib/winback/restart.server", () => ({
  deriveCurrentWinbackOffer: mocks.deriveCurrentWinbackOffer,
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://magic/x"),
  buildPortalUrl: mocks.buildPortalUrl,
}));
vi.mock("~/lib/shop/install.server", () => ({ getPrimaryShop: mocks.getPrimaryShop }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  PaymentMethodChangeError: class extends Error {},
  PauseUntilError: class extends Error {},
  addOneTimeAddon: vi.fn(),
  applyDiscountGrant: vi.fn(),
  changeFrequency: vi.fn(),
  changePaymentMethod: vi.fn(),
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  extendPause: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
}));
vi.mock("~/lib/dunning/engine.server", () => ({ requestCustomerRetry: vi.fn() }));
vi.mock("~/lib/portal/catalog.server", () => ({
  frequencyOptionsForContract: vi.fn(async () => ({ options: [], allowChoice: true })),
}));
vi.mock("~/lib/support/channels.server", () => ({
  getSupportChannels: vi.fn(async () => ({})),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async () => ({ status: "SENT" })),
}));

import {
  _resetRestartOfferMemo,
  cycleEditsBlockedResult,
  describeMagicAction,
  isContractEditBlockedError,
} from "~/lib/magiclinks/handlers.server";
import {
  _paymentMethodsCacheSize,
  _resetPaymentMethodsCache,
  PAYMENT_METHODS_CACHE_SWEEP_AT,
  listLivePaymentMethodsCached,
} from "~/lib/portal/payment-methods.server";
import { intentApplicabilitySync } from "~/lib/cancel/intent-followup.server";
import { t } from "~/lib/i18n/i18n.server";
import { locales } from "~/lib/i18n/locales";

const RESTART = { percent: 0, gift: false, restart: true };

function payload(
  action: string,
  params: Record<string, unknown> = {},
): Parameters<typeof describeMagicAction>[0] {
  return {
    v: 1,
    action,
    contractId: "ctr_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    params,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "nonce",
  } as Parameters<typeof describeMagicAction>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_URL = "https://app.example";
  mocks.setupMode.value = false;
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.deriveCurrentWinbackOffer.mockResolvedValue(null);
  _resetRestartOfferMemo();
  _resetPaymentMethodsCache();
});

// ── 1. Post-exhaustion touches vs a scheduled cancel ─────────────────────────

describe("post-exhaustion touches skip a scheduled cancel", () => {
  const src = readFileSync("app/lib/dunning/post-exhaustion.server.ts", "utf8");

  it("the case query excludes contracts with cancelScheduledAt set", () => {
    expect(src).toMatch(/status:\s*"FAILED",\s*isDemo:\s*false,\s*cancelScheduledAt:\s*null,/);
  });

  it("the defensive re-check drops a scheduled cancel too (mocked / lagging reads)", () => {
    expect(src).toContain("contract.cancelScheduledAt != null ||");
  });
});

// ── 2. ContractEditBlockedError on the magic path ────────────────────────────

describe("magic ContractEditBlockedError → honest 'undo one-off changes' page", () => {
  it("isContractEditBlockedError matches by name only (the service class is not imported)", () => {
    const err = new Error("CYCLE_EDITS_PENDING");
    err.name = "ContractEditBlockedError";
    expect(isContractEditBlockedError(err)).toBe(true);
    expect(isContractEditBlockedError(new Error("x"))).toBe(false);
    expect(isContractEditBlockedError("ContractEditBlockedError")).toBe(false);
  });

  it("cycleEditsBlockedResult speaks the customer's locale and links the portal", async () => {
    const result = await cycleEditsBlockedResult(payload("SET_FREQUENCY", { unit: "WEEK", count: 6 }));
    expect(result.locale).toBe("fr");
    expect(result.headline).toBe(t("fr", "magic.cycle_edits_pending"));
    expect(result.sub).toBe(t("fr", "magic.cycle_edits_pending_sub"));
    expect(result.portalUrl).toBe("https://cellexialabs.com/apps/cellexia-subs");
    // Never the generic "try again in a moment" (a retry of the same link answers USED).
    expect(result.sub).not.toBe(t("fr", "magic.error.generic"));
  });

  it("falls back to the master locale when the context cannot be resolved", async () => {
    mocks.contractFindUnique.mockRejectedValueOnce(new Error("db down"));
    const result = await cycleEditsBlockedResult(payload("SET_FREQUENCY"));
    expect(result.locale).toBe("en");
    expect(result.headline).toBe(t("en", "magic.cycle_edits_pending"));
  });

  it("the route maps the error in its action catch (before the generic page) and every locale carries the copy", () => {
    const route = readFileSync("app/routes/magic.$token.tsx", "utf8");
    const idx = route.indexOf("isContractEditBlockedError(err)");
    expect(idx).toBeGreaterThan(0);
    expect(route.indexOf('errorPage("GENERIC")', idx)).toBeGreaterThan(idx);
    expect(route).toContain("cycleEditsBlockedResult(verified.payload)");
    for (const [code, catalog] of Object.entries(locales)) {
      expect(catalog["magic.cycle_edits_pending"], code).toBeTruthy();
      expect(catalog["magic.cycle_edits_pending_sub"], code).toBeTruthy();
    }
  });

  it("intentApplicabilitySync never offers 'slower' while one-off cycle edits are staged", () => {
    const options = [
      { unit: "WEEK" as const, count: 4 },
      { unit: "WEEK" as const, count: 8 },
    ];
    const base = {
      status: "ACTIVE",
      nextBillingDate: new Date("2026-09-01T00:00:00Z"),
      billingIntervalUnit: "WEEK",
      billingIntervalCount: 4,
      intervalWeeks: 4,
      lines: [] as Array<Record<string, unknown>>,
    };
    const input = {
      locked: false,
      preparing: false,
      frequencyOptions: options,
      allowFrequencyChoice: true,
      downsizeEnabled: false,
    };
    const clean = { ...base, lines: [line({})] };
    expect(intentApplicabilitySync(clean as never, input).slower).toEqual({ unit: "WEEK", count: 8 });
    const skipped = { ...base, lines: [line({ skippedCycleIndex: 3 })] };
    expect(intentApplicabilitySync(skipped as never, input).slower).toBeNull();
    const qtyOnce = { ...base, lines: [line({ cycleQuantityOverrideIndex: 3 })] };
    expect(intentApplicabilitySync(qtyOnce as never, input).slower).toBeNull();
    const addon = { ...base, lines: [line({ isOneTimeAddon: true, addonCycleIndex: 3 })] };
    expect(intentApplicabilitySync(addon as never, input).slower).toBeNull();
    const stagedGift = { ...base, lines: [line({ isGift: true, shopifyLineId: null })] };
    expect(intentApplicabilitySync(stagedGift as never, input).slower).toBeNull();
    // skip / delay stay applicable — only the contract-level draft is refused.
    expect(intentApplicabilitySync(skipped as never, input)).toMatchObject({ skip: true, delay: true });
  });
});

function line(over: Record<string, unknown>) {
  return {
    isGift: false,
    isOneTimeAddon: false,
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    addonCycleIndex: null,
    skippedCycleIndex: null,
    cycleQuantityOverrideIndex: null,
    quantity: 1,
    ...over,
  };
}

// ── 3. Payment-methods memo is bounded ───────────────────────────────────────

describe("payment-methods memo eviction", () => {
  it("a write past the sweep threshold drops expired entries; all-live evicts the oldest", async () => {
    mocks.listCustomerPaymentMethods.mockResolvedValue([]);
    const t0 = new Date("2026-08-17T10:00:00Z").getTime();
    // Fill to the threshold with entries that will all be expired at t0 + 61 s.
    for (let i = 0; i < PAYMENT_METHODS_CACHE_SWEEP_AT; i += 1) {
      await listLivePaymentMethodsCached({} as never, `gid://shopify/Customer/${i}`, {
        now: new Date(t0),
      });
    }
    expect(_paymentMethodsCacheSize()).toBe(PAYMENT_METHODS_CACHE_SWEEP_AT);
    // Next write after the TTL: the sweep frees every expired entry first.
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/new", {
      now: new Date(t0 + 61_000),
    });
    expect(_paymentMethodsCacheSize()).toBe(1);

    // All-live variant: refill at t1, then one more write within the TTL
    // evicts exactly the oldest instead of growing without bound.
    _resetPaymentMethodsCache();
    const t1 = t0 + 120_000;
    for (let i = 0; i < PAYMENT_METHODS_CACHE_SWEEP_AT; i += 1) {
      await listLivePaymentMethodsCached({} as never, `gid://shopify/Customer/${i}`, {
        now: new Date(t1 + i),
      });
    }
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/late", {
      now: new Date(t1 + 30_000),
    });
    expect(_paymentMethodsCacheSize()).toBe(PAYMENT_METHODS_CACHE_SWEEP_AT);
    // The oldest (Customer/0) is gone: a fresh read for it hits Shopify again.
    const calls = mocks.listCustomerPaymentMethods.mock.calls.length;
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/0", {
      now: new Date(t1 + 31_000),
    });
    expect(mocks.listCustomerPaymentMethods.mock.calls.length).toBe(calls + 1);
    // …while the newest live entry is still served from the memo (each write
    // at the threshold evicts exactly one oldest — the Map hovers at SWEEP_AT).
    await listLivePaymentMethodsCached(
      {} as never,
      `gid://shopify/Customer/${PAYMENT_METHODS_CACHE_SWEEP_AT - 1}`,
      { now: new Date(t1 + 31_000) },
    );
    expect(mocks.listCustomerPaymentMethods.mock.calls.length).toBe(calls + 1);
    expect(_paymentMethodsCacheSize()).toBe(PAYMENT_METHODS_CACHE_SWEEP_AT);
  });
});

// ── 4. Restart-link GET memo ────────────────────────────────────────────────

describe("restart link confirm page memoizes the derived offer", () => {
  it("repeated GET describes of the same contract derive once within 60 s; a reset derives again", async () => {
    mocks.deriveCurrentWinbackOffer.mockResolvedValue({
      kind: "DISCOUNT", percent: 15, cycles: 2, gift: false, giftTitle: null,
      offeredAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), stage: 2,
    });
    const a = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    const b = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    const c = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.deriveCurrentWinbackOffer).toHaveBeenCalledTimes(1);
    expect(a.description).toBe(b.description);
    expect(b.description).toBe(c.description);
    expect(a.description).toContain("15");
    _resetRestartOfferMemo();
    await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.deriveCurrentWinbackOffer).toHaveBeenCalledTimes(2);
  });

  it("execution (POST) never reads the memo — the tap applies a fresh derivation", () => {
    const src = readFileSync("app/lib/magiclinks/handlers.server.ts", "utf8");
    const memoCalls = src.match(/deriveRestartOffer\(shop, contract, \{ memo: true \}\)/g) ?? [];
    expect(memoCalls).toHaveLength(1);
    const plainCalls = src.match(/deriveRestartOffer\(shop, contract\)/g) ?? [];
    expect(plainCalls).toHaveLength(1);
  });
});

// ── 5. Schema comment ────────────────────────────────────────────────────────

describe("DunningCase.resolution documented value set", () => {
  it("lists CUSTOMER_SKIPPED next to the four original values", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(
      /resolution\s+String\?\s*\/\/ RECOVERED \| CUSTOMER_FIXED \| CUSTOMER_SKIPPED \| CANCELLED \| EXHAUSTED/,
    );
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    expect(arch).toContain("NOT recovered in `dunningRecoveryRate`");
  });
});
