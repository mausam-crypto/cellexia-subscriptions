import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Magic verb USE_METHOD (v1.28.0, P1.7): "Use my card ····1234 instead" from
 * the payment_failed_2/3 emails. Mock scaffold copied from
 * tests/magic-retry-payment.test.ts.
 *
 *  - executes through changePaymentMethod {trigger: select, source:
 *    MAGIC_LINK, actor: customer} — the token's paymentMethodId is re-
 *    validated by the service (never trusted here);
 *  - MUTATING verb: launch-gated + throttled, never lock-blocked;
 *  - statuses ACTIVE / PAUSED / FAILED; CANCELLED gets the restart copy;
 *  - malformed / foreign ids never reach the service; typed refusals map to
 *    the magic.use_method.* copy;
 *  - the confirm page names the card when the token carries a label;
 *  - builder: multi-use token (5 uses, UPDATE_CARD convention) with {paymentMethodId, label};
 *  - the email block: lines only when ≥ 2 live methods, primary excluded,
 *    capped, empty on any failure / when the merchant switch is off; the
 *    English payment_failed_2/3 bodies carry {other_cards_block} and the
 *    preview sample resolves it.
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
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/aaaa",
    paymentInstrumentType: "CREDIT_CARD",
    lines: [],
    shop,
  };
  class PaymentMethodChangeError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.name = "PaymentMethodChangeError";
      this.code = code;
    }
  }
  class ShopifyUserError extends Error {
    errors: Array<{ message: string; code?: string | null }>;
    constructor(errors: Array<{ message: string; code?: string | null }>) {
      super("userErrors");
      this.name = "ShopifyUserError";
      this.errors = errors;
    }
  }
  const setupMode = { value: false };
  return {
    shop,
    contract,
    setupMode,
    PaymentMethodChangeError,
    ShopifyUserError,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    changePaymentMethod: vi.fn(
      async (_s: string, _c: string, _pm: string, _o: unknown): Promise<unknown> => ({}),
    ),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
    portalSettings: {} as Record<string, unknown>,
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
          ...mocks.portalSettings,
        };
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
  reactivateFromWinback: vi.fn(),
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  ShopifyUserError: mocks.ShopifyUserError,
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  PaymentMethodChangeError: mocks.PaymentMethodChangeError,
  PauseUntilError: class extends Error {},
  addOneTimeAddon: vi.fn(),
  applyDiscountGrant: vi.fn(),
  changeFrequency: vi.fn(),
  changePaymentMethod: mocks.changePaymentMethod,
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  extendPause: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  requestCustomerRetry: vi.fn(),
}));

import {
  describeMagicAction,
  executeMagicAction,
} from "~/lib/magiclinks/handlers.server";
import { buildUseMethodUrl } from "~/lib/magiclinks/builder.server";
import {
  composeOtherCardsBlock,
  otherCardsBlockForContract,
  MAX_OTHER_CARD_LINES,
} from "~/lib/dunning/other-cards.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";
import { t } from "~/lib/i18n/i18n.server";

const PM_MAIN = "gid://shopify/CustomerPaymentMethod/aaaa";
const PM_OTHER = "gid://shopify/CustomerPaymentMethod/bbbb";

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

function method(id: string, brand = "Mastercard", last4 = "8888", revoked = false) {
  return {
    id,
    revoked,
    revokedAt: revoked ? new Date() : null,
    revokedReason: null,
    instrument: {
      type: "CREDIT_CARD",
      brand,
      lastDigits: last4,
      expiryMonth: 12,
      expiryYear: 2030,
      expiresSoon: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_URL = "https://app.example";
  mocks.setupMode.value = false;
  mocks.portalSettings = {};
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.changePaymentMethod.mockResolvedValue({});
  mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN, "Visa", "4242"), method(PM_OTHER)]);
});

describe("USE_METHOD execution", () => {
  it("switches through changePaymentMethod (trigger select, MAGIC_LINK/customer) and names the card", async () => {
    const result = await executeMagicAction(
      payload("USE_METHOD", { paymentMethodId: PM_OTHER, label: "Mastercard ····8888" }),
    );
    expect(mocks.changePaymentMethod).toHaveBeenCalledWith(mocks.shop.domain, "ctr_1", PM_OTHER, {
      source: "MAGIC_LINK",
      actor: "customer",
      trigger: "select",
    });
    expect(result.headline).toBe(t("en", "magic.use_method.done", { card: "Mastercard ····8888" }));
    expect(result.sub).toBe(t("en", "magic.use_method.done_sub"));
    const types = mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("magic.link_used");
  });

  it("uses the generic copy without a label", async () => {
    const result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.use_method.done_generic"));
  });

  it("refuses malformed / foreign ids before the service, as an invalid link", async () => {
    for (const bad of [undefined, "", "gid://shopify/Customer/1", "<x>"]) {
      const result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: bad }));
      expect(result.headline).toBe(t("en", "magic.error.title"));
    }
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
  });

  it("works on PAUSED / FAILED; a CANCELLED contract gets the restart copy", async () => {
    for (const status of ["PAUSED", "FAILED"]) {
      mocks.contractFindUnique.mockResolvedValueOnce({ ...mocks.contract, status });
      const result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
      expect(result.headline).toBe(t("en", "magic.use_method.done_generic"));
    }
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(2);
    mocks.contractFindUnique.mockResolvedValueOnce({ ...mocks.contract, status: "CANCELLED" });
    const ended = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(ended.headline).toBe(t("en", "magic.use_method.ended"));
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(2);
  });

  it("maps refusals: not on account (typed + CUSTOMER_MISMATCH), other typed refusals → unavailable; unknown errors throw", async () => {
    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("PAYMENT_METHOD_NOT_ON_ACCOUNT"),
    );
    let result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.use_method.not_on_account"));

    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.ShopifyUserError([{ message: "Customer mismatch", code: "CUSTOMER_MISMATCH" }]),
    );
    result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.use_method.not_on_account"));

    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.ShopifyUserError([{ message: "stale", code: "STALE_CONTRACT" }]),
    );
    result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.use_method.unavailable"));

    mocks.changePaymentMethod.mockRejectedValueOnce(new Error("network"));
    await expect(
      executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER })),
    ).rejects.toThrow("network");
  });

  it("is launch-gated in SETUP and throttled (mutating verb) but never lock-blocked (recovery)", async () => {
    mocks.setupMode.value = true;
    const gated = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(gated.headline).toBe(t("en", "portal.setup.title"));
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();

    mocks.setupMode.value = false;
    mocks.subscriberEventCount.mockResolvedValue(10_000);
    const throttled = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(throttled.headline).toBe(t("en", "magic.error.rate_limited"));
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();

    mocks.subscriberEventCount.mockResolvedValue(1);
    mocks.resolveLockState.mockResolvedValue({
      locked: true,
      until: new Date("2026-12-01T00:00:00Z"),
      lockDays: 30,
    });
    const result = await executeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(1);
    expect(result.headline).toBe(t("en", "magic.use_method.done_generic"));
  });

  it("describes itself on the confirm page (card named when labelled, generic otherwise)", async () => {
    const named = await describeMagicAction(
      payload("USE_METHOD", { paymentMethodId: PM_OTHER, label: "Mastercard ····8888" }),
    );
    expect(named.title).toBe(t("en", "magic.confirm.title.USE_METHOD"));
    expect(named.description).toBe(
      t("en", "magic.confirm.desc.USE_METHOD", { card: "Mastercard ····8888" }),
    );
    expect(named.confirmLabel).toBe(t("en", "magic.confirm.button"));
    expect(named.lockedResult).toBeUndefined();
    const generic = await describeMagicAction(payload("USE_METHOD", { paymentMethodId: PM_OTHER }));
    expect(generic.description).toBe(t("en", "magic.confirm.desc.USE_METHOD_GENERIC"));
  });
});

describe("buildUseMethodUrl", () => {
  it("mints a multi-use (5, like UPDATE_CARD) USE_METHOD token carrying the id and label", async () => {
    const url = await buildUseMethodUrl({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "DUNNING",
      ttlDays: 37,
      paymentMethodId: PM_OTHER,
      label: "Mastercard ····8888",
    });
    expect(url).toBe("https://app.example/magic/TOKEN_ABC");
    expect(mocks.createMagicToken).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USE_METHOD",
        contractId: "ctr_1",
        maxUses: 5,
        ttlSeconds: 37 * 24 * 3600,
        createdVia: "DUNNING",
        params: { paymentMethodId: PM_OTHER, label: "Mastercard ····8888" },
      }),
    );
  });
});

describe("other_cards_block for payment_failed_2/3", () => {
  const input = {
    admin: {} as never,
    contract: {
      id: "ctr_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      locale: "en",
      paymentMethodId: PM_MAIN,
    },
    ttlDays: 37,
    createdVia: "DUNNING",
  };

  it("one 'Use my card … instead' line per OTHER live method when ≥ 2 exist, closing its paragraph", async () => {
    const block = await composeOtherCardsBlock(input, [method(PM_MAIN, "Visa", "4242"), method(PM_OTHER)]);
    expect(block).toBe(
      `${t("en", "email.payment_failed.use_card_line", { card: "Mastercard ····8888", url: "https://app.example/magic/TOKEN_ABC" })}\n\n`,
    );
    expect(block).not.toContain("Visa ····4242");
    expect(mocks.createMagicToken).toHaveBeenCalledTimes(1);
    expect((mocks.createMagicToken.mock.calls as unknown as Array<[unknown]>)[0]?.[0]).toMatchObject({
      action: "USE_METHOD",
      maxUses: 5,
      params: { paymentMethodId: PM_OTHER, label: "Mastercard ····8888" },
    });
  });

  it("empty with a single live method, when only revoked extras exist, or when nothing but the primary is live", async () => {
    expect(await composeOtherCardsBlock(input, [method(PM_MAIN, "Visa", "4242")])).toBe("");
    expect(
      await composeOtherCardsBlock(input, [method(PM_MAIN, "Visa", "4242"), method(PM_OTHER, "M", "1", true)]),
    ).toBe("");
    expect(await composeOtherCardsBlock(input, [])).toBe("");
    expect(mocks.createMagicToken).not.toHaveBeenCalled();
  });

  it("REVOKED primary + exactly one other live card → that card IS offered (Stage G review fix: 'other' counts against the primary, not the live count)", async () => {
    const block = await composeOtherCardsBlock(input, [
      method(PM_MAIN, "Visa", "4242", true),
      method(PM_OTHER),
    ]);
    expect(block).toContain("Mastercard ····8888");
    expect(mocks.createMagicToken).toHaveBeenCalledTimes(1);
    // A revoked primary with NO other live card still yields nothing.
    mocks.createMagicToken.mockClear();
    expect(await composeOtherCardsBlock(input, [method(PM_MAIN, "Visa", "4242", true)])).toBe("");
    expect(mocks.createMagicToken).not.toHaveBeenCalled();
  });

  it("an EXPIRED non-primary card is never offered; a card without expiry data (PayPal) still is", async () => {
    const expired = { ...method(PM_OTHER), instrument: { ...method(PM_OTHER).instrument, expiryMonth: 3, expiryYear: 2025 } };
    const now = new Date("2026-08-17T10:00:00Z");
    expect(await composeOtherCardsBlock({ ...input, now, tz: "Europe/Zurich" }, [method(PM_MAIN, "Visa", "4242"), expired])).toBe("");
    // Expiring at the end of THIS month is still live today.
    const thisMonth = { ...method(PM_OTHER), instrument: { ...method(PM_OTHER).instrument, expiryMonth: 8, expiryYear: 2026 } };
    expect(await composeOtherCardsBlock({ ...input, now, tz: "Europe/Zurich" }, [method(PM_MAIN, "Visa", "4242"), thisMonth])).toContain("Mastercard ····8888");
    const paypal = { ...method(PM_OTHER), instrument: { type: "PAYPAL", brand: null, lastDigits: null, expiryMonth: null, expiryYear: null, expiresSoon: null } };
    expect(await composeOtherCardsBlock({ ...input, now }, [method(PM_MAIN, "Visa", "4242"), paypal])).not.toBe("");
  });

  it("caps the lines", async () => {
    const many = [method(PM_MAIN, "Visa", "4242")];
    for (let i = 0; i < 6; i++) many.push(method(`gid://shopify/CustomerPaymentMethod/x${i}`, "Amex", `000${i}`));
    const block = await composeOtherCardsBlock(input, many);
    expect(block.split("\n").filter(Boolean)).toHaveLength(MAX_OTHER_CARD_LINES);
  });

  it("otherCardsBlockForContract reads Shopify, honours the merchant switch, and never throws", async () => {
    const block = await otherCardsBlockForContract(input);
    expect(block).toContain("Mastercard ····8888");
    mocks.portalSettings = { paymentMethodsList: false };
    expect(await otherCardsBlockForContract(input)).toBe("");
    mocks.portalSettings = {};
    mocks.listCustomerPaymentMethods.mockRejectedValueOnce(new Error("shopify down"));
    expect(await otherCardsBlockForContract(input)).toBe("");
  });

  it("the English payment_failed_2/3 bodies carry {other_cards_block}; payment_failed_1 does not; preview resolves it", () => {
    for (const key of ["payment_failed_2", "payment_failed_3"] as const) {
      expect(t("en", `email.${key}.body`)).toContain("{other_cards_block}");
      expect(String(previewSampleVars(key).other_cards_block)).toMatch(/example\.com/);
    }
    expect(t("en", "email.payment_failed_1.body")).not.toContain("{other_cards_block}");
  });
});
