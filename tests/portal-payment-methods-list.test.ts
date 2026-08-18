import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Payment-methods list (v1.28.0, P1.7 — settings.portal.paymentMethodsList):
 *
 *  - render rules: LIST when ≥1 live method besides the primary (rows with
 *    "Use for this subscription" + "Set as backup"/"Remove as backup",
 *    backup chip, aria-pressed), ADD when ≤1 method (account link, "Email me
 *    a secure link" only while a live method id exists, checkout note),
 *    NONE when the switch is off; the backup toggle disappears while the
 *    engine charges the backup; "Backup: {label}" line rules;
 *  - the 60 s per-customer memo (one Shopify read per window, force/expiry);
 *  - error → toast mapping (typed service refusals + Shopify userErrors);
 *  - the dispatcher: payment_select / payment_backup through the REAL api
 *    action with the contracts service mocked — guard chain, statuses
 *    ACTIVE/PAUSED/FAILED, never lock-blocked, feature switch, GID shape,
 *    events, toasts, error mapping, backup clear.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-payment-methods-list";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  class ShopifyUserError extends Error {
    errors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
    constructor(path: string, errors: Array<{ message: string; code?: string | null }>) {
      super(`Shopify userErrors at ${path}`);
      this.name = "ShopifyUserError";
      this.errors = errors;
    }
  }
  class PaymentMethodChangeError extends Error {
    code: string;
    constructor(code: string, message = code) {
      super(message);
      this.name = "PaymentMethodChangeError";
      this.code = code;
    }
  }
  return {
    shop,
    ShopifyUserError,
    PaymentMethodChangeError,
    portalSettings: {} as Record<string, unknown>,
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (): Promise<void> => {}),
    changePaymentMethod: vi.fn(
      async (_s: string, _c: string, _pm: string, _o?: unknown): Promise<unknown> => ({}),
    ),
    setBackupPaymentMethod: vi.fn(
      async (_s: string, _c: string, _pm: string | null, _o?: unknown): Promise<unknown> => ({}),
    ),
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
    billingAttempt: { findMany: vi.fn(async () => []) },
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
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
        paymentMethodsList: true,
        ...mocks.portalSettings,
      };
    }
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  PaymentMethodChangeError: mocks.PaymentMethodChangeError,
  PauseUntilError: class extends Error {},
  SendTomorrowError: class extends Error {},
  CycleLineEditError: class extends Error {},
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  changePaymentMethod: mocks.changePaymentMethod,
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  extendPause: vi.fn(),
  maxPauseResumeAt: vi.fn(),
  pauseContract: vi.fn(),
  pauseUntil: vi.fn(),
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  sendNextOrderTomorrow: vi.fn(),
  setBackupPaymentMethod: mocks.setBackupPaymentMethod,
  setDeliveryInstructions: vi.fn(),
  setLineQuantityThisCycle: vi.fn(),
  setNextBillingDate: vi.fn(),
  skipLineThisCycle: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipLineThisCycle: vi.fn(),
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: vi.fn(),
}));

vi.mock("~/lib/winback/restart.server", () => ({
  reactivateWithCurrentOffer: vi.fn(),
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  requestCustomerRetry: vi.fn(),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  ShopifyUserError: mocks.ShopifyUserError,
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
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
import {
  _resetPaymentMethodsCache,
  backupLine,
  invalidatePaymentMethodsCache,
  isPaymentMethodGid,
  listLivePaymentMethodsCached,
  paymentMethodErrorToast,
  paymentMethodsBlockKind,
  paymentMethodsSectionHtml,
  vaultedMethodLabel,
} from "~/lib/portal/payment-methods.server";
import { TOAST_ALERT_KEYS, TOAST_KEYS } from "~/lib/portal/layout.server";
import { defaultFor } from "~/lib/settings/registry.server";
import en from "../app/lib/i18n/locales/en.json";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date();
const PM_MAIN = "gid://shopify/CustomerPaymentMethod/aaaa-1111";
const PM_OTHER = "gid://shopify/CustomerPaymentMethod/bbbb-2222";
const PM_THIRD = "gid://shopify/CustomerPaymentMethod/cccc-3333";

function method(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    revoked: false,
    revokedAt: null as Date | null,
    revokedReason: null as string | null,
    instrument: {
      type: "CREDIT_CARD" as "CREDIT_CARD" | "SHOP_PAY" | "PAYPAL" | "UNKNOWN",
      brand: id === PM_MAIN ? "Visa" : "Mastercard",
      lastDigits: id === PM_MAIN ? "4242" : id === PM_OTHER ? "8888" : "1234",
      expiryMonth: 12,
      expiryYear: 2030,
      expiresSoon: false,
    },
    ...over,
  };
}

function sectionInput(over: Record<string, unknown> = {}) {
  return {
    locale: "en",
    contract: {
      paymentMethodId: PM_MAIN,
      backupPaymentMethodId: null as string | null,
      paymentMethodRevokedAt: null as Date | null,
    },
    methods: [method(PM_MAIN), method(PM_OTHER)] as never,
    enabled: true,
    onBackup: false,
    accountUrl: "https://cellexialabs.com/account",
    apiUrl: (action: string) => `/apps/cellexia-subs/api/${action}`,
    hiddenFields: (fields: Array<[string, string]>) =>
      fields.map(([n, v]) => `<input type="hidden" name="${n}" value="${v}">`).join(""),
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
    nextBillingDate: new Date(NOW.getTime() + 7 * DAY_MS),
    deliveryPriceCents: 0,
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
    ordersCount: 3,
    paymentMethodId: PM_MAIN,
    backupPaymentMethodId: null,
    paymentMethodRevokedAt: null,
    paymentInstrumentType: "CREDIT_CARD",
    lines: [],
    ...over,
  };
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

function expectToast(response: Response, toast: string): URL {
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get("Location") ?? "", "https://cellexialabs.com");
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
  _resetPaymentMethodsCache();
  mocks.portalSettings = {};
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([
    { lockDays: 30, shopifyPlanIds: ["gid://shopify/SellingPlan/1"] },
  ]);
  mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_OTHER)]);
  setContract(makeContract());
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("settings", () => {
  it("portal.paymentMethodsList defaults ON and dunning.postExhaustionTouchDays to [7, 21]", () => {
    expect((defaultFor("portal") as { paymentMethodsList: boolean }).paymentMethodsList).toBe(true);
    expect(
      (defaultFor("dunning") as { postExhaustionTouchDays: number[] }).postExhaustionTouchDays,
    ).toEqual([7, 21]);
  });

  it("registers the new toasts (refusals as alerts)", () => {
    for (const key of [
      "backup_set",
      "backup_cleared",
      "payment_not_on_account",
      "backup_equals_primary",
      "backup_in_use",
      "payment_stale",
    ]) {
      expect(TOAST_KEYS.has(key), key).toBe(true);
      expect(typeof (en as Record<string, string>)[`portal.toast.${key}`], key).toBe("string");
    }
    for (const key of ["payment_not_on_account", "backup_equals_primary", "backup_in_use", "payment_stale"]) {
      expect(TOAST_ALERT_KEYS.has(key), key).toBe(true);
    }
    expect(TOAST_ALERT_KEYS.has("backup_set")).toBe(false);
  });
});

// ── Render rules ─────────────────────────────────────────────────────────────

describe("render rules", () => {
  it("LIST when the account holds another live method: label, Use-for-this and Set-as-backup forms", () => {
    const input = sectionInput();
    expect(paymentMethodsBlockKind(input)).toBe("LIST");
    const html = paymentMethodsSectionHtml(input);
    expect(html).toContain(en["portal.payment.others_title"]);
    expect(html).toContain("Mastercard ····8888");
    // The primary is never listed as an "other" method.
    expect(html).not.toContain("Visa ····4242");
    expect(html).toContain('action="/apps/cellexia-subs/api/payment_select"');
    expect(html).toContain(`name="paymentMethodId" value="${PM_OTHER}"`);
    expect(html).toContain(en["portal.payment.use_for_this"]);
    expect(html).toContain('action="/apps/cellexia-subs/api/payment_backup"');
    expect(html).toContain(en["portal.payment.backup_set"]);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("no interruption to your deliveries");
    // .cxs-* namespace only — never bare .cx- classes.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
  });

  it("marks the current backup with a chip and offers Remove (posts an empty id)", () => {
    const input = sectionInput({
      contract: { paymentMethodId: PM_MAIN, backupPaymentMethodId: PM_OTHER, paymentMethodRevokedAt: null },
      methods: [method(PM_MAIN), method(PM_OTHER), method(PM_THIRD)],
    });
    const html = paymentMethodsSectionHtml(input);
    expect(html).toContain("cxs-pm__row--backup");
    expect(html).toContain(en["portal.payment.backup_chip"]);
    expect(html).toContain(en["portal.payment.backup_remove"]);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('name="paymentMethodId" value=""');
    // The third card can still become the backup.
    expect(html).toContain(`name="paymentMethodId" value="${PM_THIRD}"`);
    expect(html).toContain("Mastercard ····1234");
  });

  it("hides the backup toggle while the engine charges the backup (BACKUP_IN_USE would refuse), Use stays", () => {
    const html = paymentMethodsSectionHtml(
      sectionInput({
        contract: { paymentMethodId: PM_OTHER, backupPaymentMethodId: PM_OTHER, paymentMethodRevokedAt: null },
        onBackup: true,
      }),
    );
    expect(html).toContain("payment_select");
    expect(html).not.toContain("payment_backup");
  });

  it("ADD when ≤1 live method: account link + secure-email form + checkout note; no manage duplicate", () => {
    const input = sectionInput({ methods: [method(PM_MAIN)] });
    expect(paymentMethodsBlockKind(input)).toBe("ADD");
    const html = paymentMethodsSectionHtml(input);
    expect(html).toContain("cxs-pm--add");
    expect(html).toContain(en["portal.payment.add_title"]);
    expect(html).toContain('href="https://cellexialabs.com/account"');
    expect(html).toContain(en["portal.payment.add_in_account"]);
    expect(html).toContain('action="/apps/cellexia-subs/api/payment_update"');
    expect(html).toContain(en["portal.payment.add_email_link"]);
    expect(html).toContain(en["portal.payment.add_checkout_note"]);
    expect(html).not.toContain("payment_select");
  });

  it("ADD without the email form when no live method id exists (none / revoked) — the link would fail", () => {
    const none = paymentMethodsSectionHtml(
      sectionInput({
        contract: { paymentMethodId: null, backupPaymentMethodId: null, paymentMethodRevokedAt: null },
        methods: [],
      }),
    );
    expect(none).toContain("cxs-pm--add");
    expect(none).not.toContain("payment_update");
    const revoked = paymentMethodsSectionHtml(
      sectionInput({
        contract: { paymentMethodId: PM_MAIN, backupPaymentMethodId: null, paymentMethodRevokedAt: NOW },
        methods: [method(PM_MAIN)],
      }),
    );
    expect(revoked).not.toContain("payment_update");
  });

  it("UNKNOWN when the read failed (methods null) — nothing extra, never a list from nothing nor 'add another card' for a customer who may hold several (Stage G review fix)", () => {
    const input = sectionInput({ methods: null });
    expect(paymentMethodsBlockKind(input)).toBe("UNKNOWN");
    expect(paymentMethodsSectionHtml(input)).toBe("");
  });

  it("NONE when the merchant switch is off", () => {
    const input = sectionInput({ enabled: false });
    expect(paymentMethodsBlockKind(input)).toBe("NONE");
    expect(paymentMethodsSectionHtml(input)).toBe("");
  });

  it("revoked methods never count as 'other'", () => {
    const input = sectionInput({
      methods: [method(PM_MAIN), method(PM_OTHER, { revoked: true, revokedAt: NOW })],
    });
    expect(paymentMethodsBlockKind(input)).toBe("ADD");
  });

  it("escapes instrument labels", () => {
    const html = paymentMethodsSectionHtml(
      sectionInput({
        methods: [
          method(PM_MAIN),
          method(PM_OTHER, {
            instrument: { type: "CREDIT_CARD", brand: "<b>Evil</b>", lastDigits: "0000" },
          }),
        ],
      }),
    );
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });
});

describe("backup line + labels", () => {
  it("names the backup from the list, falls back to the generic line, hides it while on backup / unset", () => {
    const base = sectionInput({
      contract: { paymentMethodId: PM_MAIN, backupPaymentMethodId: PM_OTHER, paymentMethodRevokedAt: null },
    });
    expect(backupLine("en", base)).toBe("Backup: Mastercard ····8888");
    expect(backupLine("en", { ...base, methods: null })).toBe(en["portal.payment.backup_line_generic"]);
    expect(backupLine("en", { ...base, onBackup: true })).toBeNull();
    expect(backupLine("en", sectionInput())).toBeNull();
  });

  it("vaultedMethodLabel: card / Shop Pay / PayPal / generic", () => {
    expect(vaultedMethodLabel("en", method(PM_OTHER))).toBe("Mastercard ····8888");
    expect(
      vaultedMethodLabel("en", {
        instrument: { type: "SHOP_PAY", brand: "Visa", lastDigits: "1111", expiryMonth: null, expiryYear: null, expiresSoon: null },
      }),
    ).toBe("Shop Pay ····1111");
    expect(
      vaultedMethodLabel("en", {
        instrument: { type: "PAYPAL", brand: null, lastDigits: null, expiryMonth: null, expiryYear: null, expiresSoon: null },
      }),
    ).toBe("PayPal");
    expect(vaultedMethodLabel("en", { instrument: null })).toBe(en["portal.payment.card_generic"]);
  });

  it("isPaymentMethodGid accepts only CustomerPaymentMethod GIDs", () => {
    expect(isPaymentMethodGid(PM_MAIN)).toBe(true);
    expect(isPaymentMethodGid("gid://shopify/Customer/1")).toBe(false);
    expect(isPaymentMethodGid("")).toBe(false);
    expect(isPaymentMethodGid("gid://shopify/CustomerPaymentMethod/x y")).toBe(false);
    expect(isPaymentMethodGid(null)).toBe(false);
  });
});

// ── Cache ────────────────────────────────────────────────────────────────────

describe("per-customer memo", () => {
  it("reads Shopify once per 60 s window, filters revoked, refreshes after the window / on force / on invalidate", async () => {
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN),
      method(PM_OTHER, { revoked: true }),
    ]);
    const t0 = new Date("2026-08-17T10:00:00Z");
    const a = await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/1", { now: t0 });
    expect(a.map((m) => m.id)).toEqual([PM_MAIN]);
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/1", {
      now: new Date(t0.getTime() + 59_000),
    });
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(1);
    // Another customer is a separate entry.
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/2", { now: t0 });
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(2);
    // Window elapsed.
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/1", {
      now: new Date(t0.getTime() + 61_000),
    });
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(3);
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/1", {
      now: new Date(t0.getTime() + 62_000),
      force: true,
    });
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(4);
    invalidatePaymentMethodsCache("gid://shopify/Customer/1");
    await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/1", {
      now: new Date(t0.getTime() + 63_000),
    });
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(5);
  });

  it("propagates a Shopify failure (containment is the caller's job) and caches nothing", async () => {
    mocks.listCustomerPaymentMethods.mockRejectedValueOnce(new Error("boom"));
    await expect(
      listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/9"),
    ).rejects.toThrow("boom");
    mocks.listCustomerPaymentMethods.mockResolvedValueOnce([method(PM_MAIN)]);
    const again = await listLivePaymentMethodsCached({} as never, "gid://shopify/Customer/9");
    expect(again).toHaveLength(1);
  });
});

// ── Error mapping ────────────────────────────────────────────────────────────

describe("paymentMethodErrorToast", () => {
  it("maps typed service refusals", () => {
    expect(paymentMethodErrorToast(new mocks.PaymentMethodChangeError("PAYMENT_METHOD_NOT_ON_ACCOUNT"))).toBe(
      "payment_not_on_account",
    );
    expect(paymentMethodErrorToast(new mocks.PaymentMethodChangeError("BACKUP_EQUALS_PRIMARY"))).toBe(
      "backup_equals_primary",
    );
    expect(paymentMethodErrorToast(new mocks.PaymentMethodChangeError("BACKUP_IN_USE"))).toBe("backup_in_use");
    expect(paymentMethodErrorToast(new mocks.PaymentMethodChangeError("SOMETHING_NEW"))).toBe("error");
  });

  it("maps Shopify draft userErrors by code or message; unknown ⇒ null (generic path)", () => {
    const ue = (errors: Array<{ message: string; code?: string | null }>) =>
      new mocks.ShopifyUserError("subscriptionDraftUpdate", errors);
    expect(paymentMethodErrorToast(ue([{ message: "x", code: "CUSTOMER_MISMATCH" }]))).toBe(
      "payment_not_on_account",
    );
    expect(paymentMethodErrorToast(ue([{ message: "Customer mismatch" }]))).toBe("payment_not_on_account");
    expect(paymentMethodErrorToast(ue([{ message: "x", code: "MISSING_CUSTOMER_PAYMENT_METHOD" }]))).toBe(
      "payment_not_on_account",
    );
    expect(paymentMethodErrorToast(ue([{ message: "x", code: "STALE_CONTRACT" }]))).toBe("payment_stale");
    expect(paymentMethodErrorToast(ue([{ message: "The contract has future edits", code: "HAS_FUTURE_EDITS" }]))).toBe(
      "cycle_edits_pending",
    );
    expect(paymentMethodErrorToast(ue([{ message: "Something else" }]))).toBeNull();
    expect(paymentMethodErrorToast(new Error("network"))).toBeNull();
  });
});

// ── Dispatcher: payment_select ───────────────────────────────────────────────

describe("POST /api/payment_select", () => {
  it("switches through changePaymentMethod (trigger select, CUSTOMER_PORTAL), logs portal.payment_select, toasts payment_method_changed", async () => {
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_method_changed");
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(1);
    const [shop, id, pm, opts] = mocks.changePaymentMethod.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { trigger: string; source: string; actor: string },
    ];
    expect(shop).toBe(SHOP_DOMAIN);
    expect(id).toBe("ctr_1");
    expect(pm).toBe(PM_OTHER);
    expect(opts).toMatchObject({ trigger: "select", source: "CUSTOMER_PORTAL", actor: "customer" });
    const evt = (mocks.logEvent.mock.calls as unknown as Array<[{ type: string; payload: Record<string, unknown> }]>)
      .map((c) => c[0])
      .find((e) => e.type === "portal.payment_select");
    expect(evt).toBeDefined();
    expect(evt?.payload).toMatchObject({ paymentMethodId: PM_OTHER, previousPaymentMethodId: PM_MAIN });
  });

  it("refuses a malformed / foreign-typed id before any service call", async () => {
    expectToast(await postAction("payment_select", { paymentMethodId: "gid://shopify/Customer/1" }), "error");
    expectToast(await postAction("payment_select", {}), "error");
    expectToast(await postAction("payment_select", { paymentMethodId: "<script>" }), "error");
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
  });

  it("is refused when portal.paymentMethodsList is off", async () => {
    mocks.portalSettings = { paymentMethodsList: false };
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "error");
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
  });

  it("works on ACTIVE / PAUSED / FAILED, refuses CANCELLED / EXPIRED", async () => {
    for (const status of ["PAUSED", "FAILED"]) {
      setContract(makeContract({ status }));
      expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_method_changed");
    }
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(2);
    for (const status of ["CANCELLED", "EXPIRED"]) {
      setContract(makeContract({ status }));
      expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "error");
    }
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(2);
  });

  it("is never lock-blocked (a recovery)", async () => {
    setContract(
      makeContract({
        lockDays: 30,
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
        firstChargeAt: new Date(NOW.getTime() - 2 * DAY_MS),
        lines: [{ id: "l1", sellingPlanId: "gid://shopify/SellingPlan/1", isGift: false, isOneTimeAddon: false, quantity: 1 }],
      }),
    );
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_method_changed");
    expect(mocks.changePaymentMethod).toHaveBeenCalledTimes(1);
  });

  it("maps typed refusals and Shopify userErrors to friendly toasts; unknown errors take the generic path", async () => {
    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("PAYMENT_METHOD_NOT_ON_ACCOUNT"),
    );
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_not_on_account");

    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.ShopifyUserError("subscriptionDraftUpdate", [{ message: "Customer mismatch", code: "CUSTOMER_MISMATCH" }]),
    );
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_not_on_account");

    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.ShopifyUserError("subscriptionDraftCommit", [{ message: "Stale contract", code: "STALE_CONTRACT" }]),
    );
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "payment_stale");

    mocks.changePaymentMethod.mockRejectedValueOnce(
      new mocks.ShopifyUserError("subscriptionDraftCommit", [{ message: "x", code: "HAS_FUTURE_EDITS" }]),
    );
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "cycle_edits_pending");

    mocks.changePaymentMethod.mockRejectedValueOnce(new Error("network down"));
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "error");
  });

  it("requires a valid CSRF token and the contract must be the customer's own", async () => {
    const form = new URLSearchParams({
      contractId: "ctr_1",
      _csrf: "nope",
      return_to: "/subscription/ctr_1",
      paymentMethodId: PM_OTHER,
    });
    await expect(
      apiAction({
        request: new Request(proxyUrl("/api/payment_select", { logged_in_customer_id: "1" }), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { action: "payment_select" },
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    setContract(null);
    expectToast(await postAction("payment_select", { paymentMethodId: PM_OTHER }), "not_found");
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
  });

  it("is rate limited like every portal mutation", async () => {
    mocks.subscriberEventCount.mockResolvedValue(31);
    const res = await postAction("payment_select", { paymentMethodId: PM_OTHER });
    expect(res.status).toBe(429);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
  });
});

// ── Dispatcher: payment_backup ───────────────────────────────────────────────

describe("POST /api/payment_backup", () => {
  it("sets the backup through setBackupPaymentMethod (setBy CUSTOMER), logs portal.payment_backup_set, toasts backup_set", async () => {
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_OTHER }), "backup_set");
    const [shop, id, pm, opts] = mocks.setBackupPaymentMethod.mock.calls[0] as unknown as [
      string,
      string,
      string | null,
      { setBy: string; source: string; actor: string },
    ];
    expect(shop).toBe(SHOP_DOMAIN);
    expect(id).toBe("ctr_1");
    expect(pm).toBe(PM_OTHER);
    expect(opts).toMatchObject({ setBy: "CUSTOMER", source: "CUSTOMER_PORTAL", actor: "customer" });
    const evt = (mocks.logEvent.mock.calls as unknown as Array<[{ type: string; payload: Record<string, unknown> }]>)
      .map((c) => c[0])
      .find((e) => e.type === "portal.payment_backup_set");
    expect(evt?.payload).toMatchObject({ paymentMethodId: PM_OTHER, cleared: false });
  });

  it("clears with an empty id (null to the service), toasts backup_cleared", async () => {
    setContract(makeContract({ backupPaymentMethodId: PM_OTHER }));
    expectToast(await postAction("payment_backup", { paymentMethodId: "" }), "backup_cleared");
    expect((mocks.setBackupPaymentMethod.mock.calls[0] as unknown[])[2]).toBeNull();
    const evt = (mocks.logEvent.mock.calls as unknown as Array<[{ type: string; payload: Record<string, unknown> }]>)
      .map((c) => c[0])
      .find((e) => e.type === "portal.payment_backup_set");
    expect(evt?.payload).toMatchObject({ paymentMethodId: null, cleared: true, previousBackupPaymentMethodId: PM_OTHER });
  });

  it("maps BACKUP_EQUALS_PRIMARY / BACKUP_IN_USE / not-on-account to their toasts", async () => {
    mocks.setBackupPaymentMethod.mockRejectedValueOnce(new mocks.PaymentMethodChangeError("BACKUP_EQUALS_PRIMARY"));
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_MAIN }), "backup_equals_primary");
    mocks.setBackupPaymentMethod.mockRejectedValueOnce(new mocks.PaymentMethodChangeError("BACKUP_IN_USE"));
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_THIRD }), "backup_in_use");
    mocks.setBackupPaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("PAYMENT_METHOD_NOT_ON_ACCOUNT"),
    );
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_THIRD }), "payment_not_on_account");
  });

  it("refuses malformed ids, the feature switch off, and dead statuses", async () => {
    expectToast(await postAction("payment_backup", { paymentMethodId: "junk" }), "error");
    mocks.portalSettings = { paymentMethodsList: false };
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_OTHER }), "error");
    mocks.portalSettings = {};
    setContract(makeContract({ status: "CANCELLED" }));
    expectToast(await postAction("payment_backup", { paymentMethodId: PM_OTHER }), "error");
    expect(mocks.setBackupPaymentMethod).not.toHaveBeenCalled();
  });
});
