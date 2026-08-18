import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Magic verb RETRY_PAYMENT (v1.28.0, P1.3): the dunning emails' one-tap
 * "Retry now". Mock scaffold copied from tests/magic-setup-gate.test.ts.
 *
 *  - executes through requestCustomerRetry {source: MAGIC_LINK, actor:
 *    customer} and maps every outcome to the magic.retry.* copy;
 *  - is a MUTATING verb: launch-gated in SETUP and throttled with the
 *    portal's hourly ceiling — but never lock-blocked (a recovery);
 *  - the confirm page describes it with its own title/desc keys;
 *  - buildActionLinkBundle carries retry_payment_url (multi-use token).
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
    requestCustomerRetry: vi.fn(async (_id: string, _o: unknown): Promise<unknown> => null),
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

vi.mock("~/lib/dunning/engine.server", () => ({
  requestCustomerRetry: mocks.requestCustomerRetry,
}));

import {
  describeMagicAction,
  executeMagicAction,
} from "~/lib/magiclinks/handlers.server";
import { t } from "~/lib/i18n/i18n.server";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = false;
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.requestCustomerRetry.mockResolvedValue({
    kind: "started",
    caseId: "case_1",
    reopened: false,
    inFlight: false,
  });
});

describe("RETRY_PAYMENT execution", () => {
  it("hands off to requestCustomerRetry as MAGIC_LINK/customer and renders the started copy", async () => {
    const result = await executeMagicAction(payload("RETRY_PAYMENT"));
    expect(mocks.requestCustomerRetry).toHaveBeenCalledWith("ctr_1", {
      source: "MAGIC_LINK",
      actor: "customer",
    });
    expect(result.headline).toBe(t("en", "magic.retry.done"));
    expect(result.sub).toBe(t("en", "magic.retry.done_sub"));
    expect(result.redirect).toBeUndefined();
    const types = mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("magic.link_used");
  });

  it("maps too_soon / challenge_pending / paused / no_case to their copy", async () => {
    const cases = [
      [{ kind: "too_soon", caseId: "c", retryAgainAt: new Date() }, "magic.retry.too_soon"],
      [{ kind: "unavailable", caseId: "c", reason: "challenge_pending" }, "magic.retry.needs_bank"],
      [{ kind: "unavailable", caseId: null, reason: "contract_paused" }, "magic.retry.paused"],
      [{ kind: "no_case" }, "magic.retry.none"],
    ] as const;
    for (const [outcome, key] of cases) {
      mocks.requestCustomerRetry.mockResolvedValueOnce(outcome);
      const result = await executeMagicAction(payload("RETRY_PAYMENT"));
      expect(result.headline).toBe(t("en", key));
      expect(result.sub).toBe(t("en", `${key}_sub`));
    }
  });

  it("is launch-gated in SETUP (mutating verb) and throttled by the hourly ceiling", async () => {
    mocks.setupMode.value = true;
    const gated = await executeMagicAction(payload("RETRY_PAYMENT"));
    expect(gated.headline).toBe(t("en", "portal.setup.title"));
    expect(mocks.requestCustomerRetry).not.toHaveBeenCalled();

    mocks.setupMode.value = false;
    mocks.subscriberEventCount.mockResolvedValue(10_000);
    const throttled = await executeMagicAction(payload("RETRY_PAYMENT"));
    expect(throttled.headline).toBe(t("en", "magic.error.rate_limited"));
    expect(mocks.requestCustomerRetry).not.toHaveBeenCalled();
  });

  it("is never lock-blocked — a recovery verb", async () => {
    mocks.resolveLockState.mockResolvedValue({
      locked: true,
      until: new Date("2026-12-01T00:00:00Z"),
      lockDays: 30,
    });
    const result = await executeMagicAction(payload("RETRY_PAYMENT"));
    expect(mocks.requestCustomerRetry).toHaveBeenCalledTimes(1);
    expect(result.headline).toBe(t("en", "magic.retry.done"));
  });

  it("describes itself on the confirm page with its own keys and the mutating confirm label", async () => {
    const desc = await describeMagicAction(payload("RETRY_PAYMENT"));
    expect(desc.title).toBe(t("en", "magic.confirm.title.RETRY_PAYMENT"));
    expect(desc.description).toBe(t("en", "magic.confirm.desc.RETRY_PAYMENT"));
    expect(desc.confirmLabel).toBe(t("en", "magic.confirm.button"));
    expect(desc.lockedResult).toBeUndefined();
  });
});
