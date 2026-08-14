import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Magic-link setup-mode launch gate.
 *
 * Every other customer surface enforces its own SETUP gate (portal loaders +
 * dispatcher, jobs, notifications, Klaviyo, buy box) — the magic executor
 * used to be the hole: links minted while LIVE sit in inboxes for up to
 * portal.magicLinkTtlDays days, so after an emergency revertToSetup() a
 * tapped skip/pause/winback link kept mutating live Shopify contracts while
 * billing and notifications were frozen, and goLive()'s overdue stagger later
 * swept the result into an unannounced charge.
 *
 * Invariants pinned here:
 *  - In SETUP, every contract-mutating verb (SKIP_NEXT, UNSKIP_NEXT,
 *    DELAY_NEXT, ADD_TO_NEXT, PAUSE, RESUME, SWAP, APPLY_WINBACK) returns the
 *    friendly closed-portal refusal at the executor's shared choke point —
 *    no service call, no redirect — while the tap still leaves its audit
 *    event.
 *  - Hand-off verbs keep working in SETUP: LOGIN (portal enforces its own
 *    gate), UPDATE_CARD and CONFIRM_3DS (dunning/3DS is gated at its source).
 *  - describeMagicAction surfaces the same refusal at GET time via
 *    lockedResult, so the confirm page never renders a form whose POST would
 *    burn the single-use token on a refusal.
 *  - Once LIVE, mutating verbs execute exactly as before.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-magic-setup-gate";

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
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    nextBillingDate: null,
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
    lines: [],
    shop,
  };
  const setupMode = { value: true };
  return {
    shop,
    contract,
    setupMode,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    winbackStateUpdateMany: vi.fn(async (): Promise<unknown> => ({ count: 1 })),
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
        };
      }
      if (key === "winback") {
        return { discountPct: 20, discountCycles: 2 };
      }
      return {};
    }),
    resolveLockState: vi.fn(
      async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 }),
    ),
    reactivateFromWinback: vi.fn(async (): Promise<unknown> => ({})),
    skipNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
    unskipNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
    delayNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
    addOneTimeAddon: vi.fn(async (): Promise<unknown> => ({ lines: [] })),
    pauseContract: vi.fn(async (): Promise<unknown> => ({ resumeAt: null })),
    resumeContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
    swapLineVariant: vi.fn(async (): Promise<unknown> => ({ lines: [] })),
    applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
    createMagicToken: vi.fn(async (): Promise<string> => "HANDOFF_CODE_123"),
    buildPortalUrl: vi.fn(
      async (): Promise<string> => "https://cellexialabs.com/apps/cellexia-subs",
    ),
    buildMagicUrl: vi.fn(
      async (): Promise<string> => "https://app.example/magic/tok",
    ),
    getPaymentMethodUpdateUrl: vi.fn(
      async (): Promise<string> => "https://shopify.example/card-update",
    ),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findFirst: mocks.contractFindFirst,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    winbackState: { updateMany: mocks.winbackStateUpdateMany },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: mocks.resolveLockState,
}));
vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: mocks.reactivateFromWinback,
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: mocks.buildMagicUrl,
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: mocks.getPaymentMethodUpdateUrl,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  addOneTimeAddon: mocks.addOneTimeAddon,
  applyDiscountGrant: mocks.applyDiscountGrant,
  delayNextCycle: mocks.delayNextCycle,
  pauseContract: mocks.pauseContract,
  resumeContract: mocks.resumeContract,
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: mocks.swapLineVariant,
  unskipNextCycle: mocks.unskipNextCycle,
}));

import {
  describeMagicAction,
  executeMagicAction,
} from "~/lib/magiclinks/handlers.server";
import { t } from "~/lib/i18n/i18n.server";

const SETUP_HEADLINE = t("en", "portal.setup.title");
const SETUP_SUB = t("en", "portal.setup.body");

const MUTATING_VERBS = [
  "SKIP_NEXT",
  "UNSKIP_NEXT",
  "DELAY_NEXT",
  "ADD_TO_NEXT",
  "PAUSE",
  "RESUME",
  "SWAP",
  "APPLY_WINBACK",
] as const;

function payload(
  action: string,
  params: Record<string, unknown> = {},
): Parameters<typeof executeMagicAction>[0] {
  return {
    v: 1,
    action,
    contractId: "ctr_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    params,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "nonce",
  } as Parameters<typeof executeMagicAction>[0];
}

function serviceCallHandles() {
  return [
    mocks.skipNextCycle,
    mocks.unskipNextCycle,
    mocks.delayNextCycle,
    mocks.addOneTimeAddon,
    mocks.pauseContract,
    mocks.resumeContract,
    mocks.swapLineVariant,
    mocks.applyDiscountGrant,
    mocks.reactivateFromWinback,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = true;
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({
    locked: false,
    until: null,
    lockDays: 0,
  });
});

// ── Execute-time gate ────────────────────────────────────────────────────────

describe("executeMagicAction while the store is in SETUP", () => {
  it.each(MUTATING_VERBS)(
    "refuses %s with the closed-portal copy and no service call",
    async (verb) => {
      const result = await executeMagicAction(payload(verb));
      expect(result.headline).toBe(SETUP_HEADLINE);
      expect(result.sub).toBe(SETUP_SUB);
      expect(result.redirect).toBeUndefined();
      for (const fn of serviceCallHandles()) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it("still records the magic.link_used audit event for the refused tap", async () => {
    await executeMagicAction(payload("SKIP_NEXT"));
    const types = mocks.logEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types).toContain("magic.link_used");
  });

  it("LOGIN keeps working — the portal enforces its own launch gate", async () => {
    const result = await executeMagicAction(payload("LOGIN"));
    expect(result.redirect).toContain("handoff=HANDOFF_CODE_123");
    expect(mocks.createMagicToken).toHaveBeenCalledTimes(1);
  });

  it("UPDATE_CARD keeps working — dunning/3DS is gated at its own source", async () => {
    const result = await executeMagicAction(payload("UPDATE_CARD"));
    expect(result.redirect).toBe("https://shopify.example/card-update");
  });

  it("CONFIRM_3DS keeps working for a trusted Shopify redirect", async () => {
    const result = await executeMagicAction(
      payload("CONFIRM_3DS", {
        redirectUrl: "https://checkout.shopify.com/challenge/1",
      }),
    );
    expect(result.redirect).toBe("https://checkout.shopify.com/challenge/1");
  });
});

describe("executeMagicAction once LIVE", () => {
  it("executes SKIP_NEXT exactly as before", async () => {
    mocks.setupMode.value = false;
    const result = await executeMagicAction(payload("SKIP_NEXT"));
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
    expect(result.headline).toBe(t("en", "magic.skip.done"));
  });

  it("executes APPLY_WINBACK on a cancelled contract", async () => {
    mocks.setupMode.value = false;
    mocks.contractFindUnique.mockResolvedValue({
      ...mocks.contract,
      status: "CANCELLED",
    });
    await executeMagicAction(
      payload("APPLY_WINBACK", { percent: 20, cycles: 2 }),
    );
    expect(mocks.reactivateFromWinback).toHaveBeenCalledTimes(1);
  });
});

// ── Describe-time gate (GET confirm page, pre-consumption) ───────────────────

describe("describeMagicAction while the store is in SETUP", () => {
  it("returns a terminal lockedResult so the confirm form never renders", async () => {
    const desc = await describeMagicAction(payload("SKIP_NEXT"));
    expect(desc.lockedResult).toBeDefined();
    expect(desc.lockedResult?.headline).toBe(SETUP_HEADLINE);
    expect(desc.lockedResult?.sub).toBe(SETUP_SUB);
  });

  it("does not gate the hand-off verbs' confirm pages", async () => {
    for (const verb of ["LOGIN", "UPDATE_CARD", "CONFIRM_3DS"]) {
      const desc = await describeMagicAction(payload(verb));
      expect(desc.lockedResult, verb).toBeUndefined();
    }
  });

  it("returns no lockedResult once LIVE (lock window permitting)", async () => {
    mocks.setupMode.value = false;
    const desc = await describeMagicAction(payload("SKIP_NEXT"));
    expect(desc.lockedResult).toBeUndefined();
  });
});
