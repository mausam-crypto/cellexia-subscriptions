import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * One-tap restart links through the magic route (v1.28.0, P3.2 + P3.5).
 * Mock scaffold copied from tests/magic-retry-payment.test.ts.
 *
 *  - an APPLY_WINBACK link carrying { restart: true } NEVER applies its
 *    minted params: describe + execute re-derive the CURRENT offer through
 *    deriveCurrentWinbackOffer (parity with the portal) and hand exactly
 *    that to reactivateFromWinback — discount / gift / plain restart;
 *  - the confirm page names the derived offer (or the plain welcome-back
 *    copy) — never "apply your discount" for a percent-0 link;
 *  - the result page links the PLAIN portal_url (no session token in it);
 *  - an already-ACTIVE contract is a friendly no-op;
 *  - classic perk / discount links keep applying their minted params.
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
    status: "CANCELLED",
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
    deriveCurrentWinbackOffer: vi.fn(async (): Promise<unknown> => null),
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
vi.mock("~/lib/winback/restart.server", () => ({
  deriveCurrentWinbackOffer: mocks.deriveCurrentWinbackOffer,
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
  _resetRestartOfferMemo,
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

const RESTART = { percent: 0, cycles: 0, gift: false, restart: true };
const EXPIRES = new Date("2026-10-15T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = false;
  mocks.contract.status = "CANCELLED";
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.deriveCurrentWinbackOffer.mockResolvedValue(null);
  // The GET confirm page memoizes the derived offer per contract for 60 s
  // (v1.28.0 audit) — each case here wants a fresh derivation.
  _resetRestartOfferMemo();
});

describe("restart link — execution applies the CURRENT offer, never the minted params", () => {
  it("no current offer → plain restart (percent 0, no gift), result links the plain portal_url", async () => {
    const result = await executeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.deriveCurrentWinbackOffer).toHaveBeenCalledTimes(1);
    expect(mocks.reactivateFromWinback).toHaveBeenCalledWith(
      "ctr_1",
      { percent: 0, cycles: 2, gift: false },
      { source: "MAGIC_LINK", actor: "customer" },
    );
    expect(result.headline).toBe(t("en", "magic.winback.done"));
    expect(result.sub).toBe(t("en", "magic.winback.sub_nodiscount", { date: "—" }));
    expect(result.portalUrl).toBe("https://cellexialabs.com/apps/cellexia-subs");
    expect(result.portalUrl).not.toMatch(/token|session|handoff/);
  });

  it("current DISCOUNT offer → grants exactly that percent/cycles and says so", async () => {
    mocks.deriveCurrentWinbackOffer.mockResolvedValue({
      kind: "DISCOUNT", percent: 15, cycles: 2, gift: false, giftTitle: null,
      offeredAt: new Date(), expiresAt: EXPIRES, stage: 2,
    });
    const result = await executeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.reactivateFromWinback).toHaveBeenCalledWith(
      "ctr_1",
      { percent: 15, cycles: 2, gift: false },
      { source: "MAGIC_LINK", actor: "customer" },
    );
    expect(result.sub).toBe(t("en", "magic.winback.sub", { percent: 15, cycles: 2, date: "—" }));
  });

  it("current GIFT offer → grants the gift (no discount) and says so", async () => {
    mocks.deriveCurrentWinbackOffer.mockResolvedValue({
      kind: "GIFT", percent: 0, cycles: 0, gift: true, giftTitle: "Mini serum",
      offeredAt: new Date(), expiresAt: EXPIRES, stage: 1,
    });
    const result = await executeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.reactivateFromWinback).toHaveBeenCalledWith(
      "ctr_1",
      { percent: 0, cycles: 2, gift: true },
      { source: "MAGIC_LINK", actor: "customer" },
    );
    expect(result.sub).toBe(t("en", "magic.winback.sub_gift", { date: "—" }));
  });

  it("an already-ACTIVE contract is a friendly no-op (link replay / restarted from the portal meanwhile)", async () => {
    mocks.contract.status = "ACTIVE";
    const result = await executeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(mocks.reactivateFromWinback).not.toHaveBeenCalled();
    expect(result.headline).toBe(t("en", "magic.winback.already_active"));
  });

  it("classic perk / discount links keep applying their minted params (not re-derived)", async () => {
    await executeMagicAction(payload("APPLY_WINBACK", { percent: 0, cycles: 0, gift: true }));
    expect(mocks.deriveCurrentWinbackOffer).not.toHaveBeenCalled();
    expect(mocks.reactivateFromWinback).toHaveBeenLastCalledWith(
      "ctr_1", { percent: 0, cycles: 1, gift: true }, { source: "MAGIC_LINK", actor: "customer" },
    );
    await executeMagicAction(payload("APPLY_WINBACK", { percent: 20, cycles: 2, gift: false }));
    expect(mocks.reactivateFromWinback).toHaveBeenLastCalledWith(
      "ctr_1", { percent: 20, cycles: 2, gift: false }, { source: "MAGIC_LINK", actor: "customer" },
    );
  });
});

describe("restart link — the confirm page promises exactly what the tap will do", () => {
  it("no offer: welcome-back title + plain restart copy (never 'apply your discount')", async () => {
    const desc = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(desc.title).toBe(t("en", "magic.confirm.title.APPLY_WINBACK_RESTART"));
    expect(desc.description).toBe(t("en", "magic.confirm.desc.APPLY_WINBACK_RESTART"));
    expect(desc.description).not.toContain("discount");
    expect(desc.confirmLabel).toBe(t("en", "magic.confirm.button"));
    expect(desc.portalUrl).toBe("https://cellexialabs.com/apps/cellexia-subs");
  });

  it("current DISCOUNT offer: names the percent and cycles", async () => {
    mocks.deriveCurrentWinbackOffer.mockResolvedValue({
      kind: "DISCOUNT", percent: 15, cycles: 2, gift: false, giftTitle: null,
      offeredAt: new Date(), expiresAt: EXPIRES, stage: 2,
    });
    const desc = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(desc.description).toBe(
      t("en", "magic.confirm.desc.APPLY_WINBACK_RESTART_DISCOUNT", { percent: 15, cycles: 2 }),
    );
    expect(desc.description).toContain("15%");
  });

  it("current GIFT offer: the gift copy", async () => {
    mocks.deriveCurrentWinbackOffer.mockResolvedValue({
      kind: "GIFT", percent: 0, cycles: 0, gift: true, giftTitle: "Mini serum",
      offeredAt: new Date(), expiresAt: EXPIRES, stage: 1,
    });
    const desc = await describeMagicAction(payload("APPLY_WINBACK", RESTART));
    expect(desc.description).toBe(t("en", "magic.confirm.desc.APPLY_WINBACK_GIFT"));
  });

  it("classic links keep their own copy", async () => {
    const perk = await describeMagicAction(payload("APPLY_WINBACK", { percent: 0, gift: true }));
    expect(perk.title).toBe(t("en", "magic.confirm.title.APPLY_WINBACK"));
    expect(perk.description).toBe(t("en", "magic.confirm.desc.APPLY_WINBACK_GIFT"));
    const disc = await describeMagicAction(payload("APPLY_WINBACK", { percent: 20, cycles: 2 }));
    expect(disc.description).toBe(t("en", "magic.confirm.desc.APPLY_WINBACK"));
    expect(mocks.deriveCurrentWinbackOffer).not.toHaveBeenCalled();
  });
});
