import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Magic verb SKIP_FAILED_CYCLE (v1.28.0, P1.9): "Skip that order and
 * continue" from the payment_failed_parked touches. Mock scaffold copied
 * from tests/magic-use-method.test.ts.
 *
 *  - executes through skipFailedCycleAndResume {source MAGIC_LINK, actor
 *    customer} — the same case-aware service as the portal verb;
 *  - MUTATING verb: launch-gated + throttled, never lock-blocked;
 *  - outcomes map to honest copy: resumed (with the date), already active,
 *    hard-dead card → update-card copy, attempt in flight, unavailable;
 *  - the confirm page names the resume date the verb would set (or the
 *    no-date copy);
 *  - builder: few-use (3) SKIP_FAILED_CYCLE token, no params.
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
const skipMocks = vi.hoisted(() => ({
  skipFailedCycleAndResume: vi.fn(
    async (_s: string, _c: string, _o: unknown): Promise<unknown> => ({
      kind: "resumed",
      caseId: "case_1",
      cycleIndex: 7,
      nextBillingDate: new Date("2026-08-24T08:00:00.000Z"),
    }),
  ),
  previewSkipResumeDate: vi.fn(
    async (): Promise<Date | null> => new Date("2026-08-24T08:00:00.000Z"),
  ),
}));
vi.mock("~/lib/dunning/skip-resume.server", () => ({
  skipFailedCycleAndResume: skipMocks.skipFailedCycleAndResume,
  previewSkipResumeDate: skipMocks.previewSkipResumeDate,
}));

import {
  describeMagicAction,
  executeMagicAction,
} from "~/lib/magiclinks/handlers.server";
import { buildSkipFailedCycleUrl } from "~/lib/magiclinks/builder.server";
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
  process.env.SHOPIFY_APP_URL = "https://app.example";
  mocks.setupMode.value = false;
  mocks.portalSettings = {};
  mocks.contractFindUnique.mockResolvedValue({ ...mocks.contract, status: "FAILED" });
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  skipMocks.skipFailedCycleAndResume.mockResolvedValue({
    kind: "resumed",
    caseId: "case_1",
    cycleIndex: 7,
    nextBillingDate: new Date("2026-08-24T08:00:00.000Z"),
  });
  skipMocks.previewSkipResumeDate.mockResolvedValue(new Date("2026-08-24T08:00:00.000Z"));
});

describe("SKIP_FAILED_CYCLE execution", () => {
  it("runs the case-aware service as MAGIC_LINK/customer and names the resume date", async () => {
    const result = await executeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(skipMocks.skipFailedCycleAndResume).toHaveBeenCalledWith(mocks.shop.domain, "ctr_1", {
      source: "MAGIC_LINK",
      actor: "customer",
    });
    expect(result.headline).toBe(t("en", "magic.skip_resume.done"));
    expect(result.sub).toContain("2026");
    const types = mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("magic.link_used");
  });

  it("maps every outcome to honest copy", async () => {
    skipMocks.skipFailedCycleAndResume.mockResolvedValueOnce({ kind: "already_active" });
    expect((await executeMagicAction(payload("SKIP_FAILED_CYCLE"))).headline).toBe(
      t("en", "magic.skip_resume.already_active"),
    );
    for (const reason of ["card_revoked", "card_expired", "no_card"]) {
      skipMocks.skipFailedCycleAndResume.mockResolvedValueOnce({ kind: "refused", reason });
      expect((await executeMagicAction(payload("SKIP_FAILED_CYCLE"))).headline).toBe(
        t("en", "magic.skip_resume.card_dead"),
      );
    }
    skipMocks.skipFailedCycleAndResume.mockResolvedValueOnce({
      kind: "refused",
      reason: "attempt_in_flight",
    });
    expect((await executeMagicAction(payload("SKIP_FAILED_CYCLE"))).headline).toBe(
      t("en", "magic.skip_resume.in_flight"),
    );
    for (const reason of ["no_case", "contract_status", "cycle_billed", "no_cycle", "not_ours"]) {
      skipMocks.skipFailedCycleAndResume.mockResolvedValueOnce({ kind: "refused", reason });
      expect((await executeMagicAction(payload("SKIP_FAILED_CYCLE"))).headline).toBe(
        t("en", "magic.skip_resume.unavailable"),
      );
    }
  });

  it("is launch-gated in SETUP and throttled (mutating verb) but never lock-blocked (recovery)", async () => {
    mocks.setupMode.value = true;
    const gated = await executeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(gated.headline).toBe(t("en", "portal.setup.title"));
    expect(skipMocks.skipFailedCycleAndResume).not.toHaveBeenCalled();

    mocks.setupMode.value = false;
    mocks.subscriberEventCount.mockResolvedValue(10_000);
    const throttled = await executeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(throttled.headline).toBe(t("en", "magic.error.rate_limited"));
    expect(skipMocks.skipFailedCycleAndResume).not.toHaveBeenCalled();

    mocks.subscriberEventCount.mockResolvedValue(1);
    mocks.resolveLockState.mockResolvedValue({
      locked: true,
      until: new Date("2026-12-01T00:00:00Z"),
      lockDays: 30,
    });
    const result = await executeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(skipMocks.skipFailedCycleAndResume).toHaveBeenCalledTimes(1);
    expect(result.headline).toBe(t("en", "magic.skip_resume.done"));
  });

  it("describes itself with the resume date the verb would set (no-date copy otherwise)", async () => {
    const dated = await describeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(dated.title).toBe(t("en", "magic.confirm.title.SKIP_FAILED_CYCLE"));
    expect(dated.description).toContain("2026");
    expect(dated.description).not.toContain("{date}");
    expect(dated.confirmLabel).toBe(t("en", "magic.confirm.button"));
    expect(dated.lockedResult).toBeUndefined();

    skipMocks.previewSkipResumeDate.mockResolvedValueOnce(null);
    const nodate = await describeMagicAction(payload("SKIP_FAILED_CYCLE"));
    expect(nodate.description).toBe(t("en", "magic.confirm.desc.SKIP_FAILED_CYCLE_NODATE"));
  });
});

describe("buildSkipFailedCycleUrl", () => {
  it("mints a few-use (3) SKIP_FAILED_CYCLE token without params", async () => {
    const url = await buildSkipFailedCycleUrl({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "DUNNING_PARKED",
      ttlDays: 28,
    });
    expect(url).toBe("https://app.example/magic/TOKEN_ABC");
    const input = (mocks.createMagicToken.mock.calls as unknown as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      action: "SKIP_FAILED_CYCLE",
      contractId: "ctr_1",
      // A few uses (Stage G review fix): the token is consumed before the
      // verb runs, so a transient refusal must not burn the one-tap.
      maxUses: 3,
      ttlSeconds: 28 * 24 * 3600,
      createdVia: "DUNNING_PARKED",
    });
    expect(input.params).toBeUndefined();
  });
});
