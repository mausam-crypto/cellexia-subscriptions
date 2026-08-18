import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.8 — the customer-facing surfaces of new-method detection (v1.28.0):
 *
 *  1. Home banner (proxy._index.tsx): "You have a newer card on file — use
 *     it for this subscription?" per contract the webhook TOLD about a new
 *     method (dunning.new_method_detected, action notified, ≤ 30 days) that
 *     still pays with another one; one-tap = the payment_select verb, quiet
 *     link = the detail page's payment section; rides
 *     portal.paymentMethodsList, never for preview sessions; .cxs- only.
 *  2. Magic verb SET_BACKUP: setBackupPaymentMethod {setBy CUSTOMER, source
 *     MAGIC_LINK} — mutating (launch-gated + throttled), never lock-blocked,
 *     malformed ids refused before the service, refusals mapped, confirm
 *     page copy; builder mints a multi-use (5) token with {paymentMethodId,
 *     label}.
 *  3. Template new_card_detected: registered (metric "Cellexia New Card
 *     Detected", CTA "Use my new card"), catalogued, in the flow specs with a
 *     rationale, preview sample vars render placeholder-free.
 *  4. Closed loop copy: reason "new_method" renders the "moved your
 *     subscription to your new card" line (retrying variant with a held
 *     payment); via_backup false.
 *  5. Settings: dunning.newMethodDetection / newMethodAutoSwitch default
 *     true and are on the admin Settings page.
 *  6. i18n: every new English key exists; the "add another card" copy states
 *     only honest options (no promise that a one-time re-purchase vaults).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

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
    setBackupPaymentMethod: vi.fn(
      async (_s: string, _c: string, _pm: string | null, _o: unknown): Promise<unknown> => ({}),
    ),
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
      return {};
    }),
    resolveLockState: vi.fn(
      async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 }),
    ),
    createMagicToken: vi.fn(async (): Promise<string> => "TOKEN_ABC"),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
    notificationLogFindFirst: vi.fn(async (): Promise<unknown> => null),
    dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
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
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/contracts/lock.server", () => ({ resolveLockState: mocks.resolveLockState }));
vi.mock("~/lib/winback/engine.server", () => ({ reactivateFromWinback: vi.fn() }));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/shop/install.server", () => ({ getPrimaryShop: mocks.getPrimaryShop }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  ShopifyUserError: mocks.ShopifyUserError,
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  PaymentMethodChangeError: mocks.PaymentMethodChangeError,
  PauseUntilError: class extends Error {},
  addOneTimeAddon: vi.fn(),
  applyDiscountGrant: vi.fn(),
  changeFrequency: vi.fn(),
  changePaymentMethod: vi.fn(),
  setBackupPaymentMethod: mocks.setBackupPaymentMethod,
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

import { describeMagicAction, executeMagicAction } from "~/lib/magiclinks/handlers.server";
import { buildSetBackupUrl } from "~/lib/magiclinks/builder.server";
import { previewSampleVars, renderTemplatePreview } from "~/lib/notifications/preview.server";
import { TEMPLATES } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { flowSpecs } from "~/lib/klaviyo/flows.server";
import { paymentMethodUpdatedVars } from "~/lib/notifications/payment-method.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { t } from "~/lib/i18n/i18n.server";
import { locales } from "~/lib/i18n/locales";

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_URL = "https://app.example";
  mocks.setupMode.value = false;
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.setBackupPaymentMethod.mockResolvedValue({});
});

// ── 1. Home banner ───────────────────────────────────────────────────────────

describe("home banner (proxy._index.tsx pins)", () => {
  const src = readSource("app/routes/proxy._index.tsx");

  it("reads the notified-method hits once per page, gated by portal.paymentMethodsList and never for previews", () => {
    expect(src).toContain('from "~/lib/dunning/new-method.server"');
    expect(src).toMatch(/portalSettings\.paymentMethodsList && !portalSession\.isPreview[\s\S]{0,80}newCardBannerHits\(contracts, \{/);
    expect(src).toContain("newCard: newCardHits.get(contract.id) ?? null");
  });

  it("renders the banner with the one-tap payment_select form + a link to the payment section, .cxs- only, on live statuses", () => {
    const start = src.indexOf("let newCardHtml");
    const block = src.slice(start, src.indexOf("// Value-first card", start));
    expect(block).toContain('["ACTIVE", "PAUSED", "FAILED"].includes(contract.status)');
    expect(block).toContain('api("payment_select")');
    expect(block).toContain('{ name: "paymentMethodId", value: params.newCard.paymentMethodId }');
    expect(block).toContain("portal.index.new_card_banner_labelled");
    expect(block).toContain("portal.index.new_card_banner");
    expect(block).toContain("portal.index.new_card_cta");
    expect(block).toContain('#cxs-payment"');
    expect(block).toContain("cxs-banner cxs-newcard");
    expect(block).not.toMatch(/class="[^"]*\bcx-/);
    // The banner sits above the value grid and the run-out prompt.
    expect(src).toMatch(/\$\{newCardHtml\}\s*\$\{valueHtml\}\s*\$\{promptHtml\}/);
  });
});

// ── 2. SET_BACKUP magic verb ─────────────────────────────────────────────────

describe("SET_BACKUP execution", () => {
  it("sets the backup through setBackupPaymentMethod (setBy CUSTOMER, MAGIC_LINK/customer) and names the card", async () => {
    const result = await executeMagicAction(
      payload("SET_BACKUP", { paymentMethodId: PM_OTHER, label: "Mastercard ····8210" }),
    );
    expect(mocks.setBackupPaymentMethod).toHaveBeenCalledWith(mocks.shop.domain, "ctr_1", PM_OTHER, {
      source: "MAGIC_LINK",
      actor: "customer",
      setBy: "CUSTOMER",
    });
    expect(result.headline).toBe(t("en", "magic.set_backup.done", { card: "Mastercard ····8210" }));
    expect(result.sub).toBe(t("en", "magic.set_backup.done_sub"));
    const generic = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(generic.headline).toBe(t("en", "magic.set_backup.done_generic"));
  });

  it("refuses malformed / foreign ids before the service", async () => {
    for (const bad of [undefined, "", "gid://shopify/Customer/1", "<x>"]) {
      const result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: bad }));
      expect(result.headline).toBe(t("en", "magic.error.title"));
    }
    expect(mocks.setBackupPaymentMethod).not.toHaveBeenCalled();
  });

  it("works on PAUSED / FAILED; a CANCELLED contract gets the ended copy", async () => {
    for (const status of ["PAUSED", "FAILED"]) {
      mocks.contractFindUnique.mockResolvedValueOnce({ ...mocks.contract, status });
      const result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
      expect(result.headline).toBe(t("en", "magic.set_backup.done_generic"));
    }
    mocks.contractFindUnique.mockResolvedValueOnce({ ...mocks.contract, status: "CANCELLED" });
    const ended = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(ended.headline).toBe(t("en", "magic.use_method.ended"));
    expect(mocks.setBackupPaymentMethod).toHaveBeenCalledTimes(2);
  });

  it("maps refusals: not on account, already the primary, in use → honest copy; unknown errors throw", async () => {
    mocks.setBackupPaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("PAYMENT_METHOD_NOT_ON_ACCOUNT"),
    );
    let result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.use_method.not_on_account"));

    mocks.setBackupPaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("BACKUP_EQUALS_PRIMARY"),
    );
    result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.set_backup.already_primary"));

    mocks.setBackupPaymentMethod.mockRejectedValueOnce(
      new mocks.PaymentMethodChangeError("BACKUP_IN_USE"),
    );
    result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(result.headline).toBe(t("en", "magic.set_backup.unavailable"));

    mocks.setBackupPaymentMethod.mockRejectedValueOnce(new Error("network"));
    await expect(
      executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER })),
    ).rejects.toThrow("network");
  });

  it("is launch-gated in SETUP and throttled (mutating verb) but never lock-blocked", async () => {
    mocks.setupMode.value = true;
    const gated = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(gated.headline).toBe(t("en", "portal.setup.title"));
    expect(mocks.setBackupPaymentMethod).not.toHaveBeenCalled();

    mocks.setupMode.value = false;
    mocks.subscriberEventCount.mockResolvedValue(10_000);
    const throttled = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(throttled.headline).toBe(t("en", "magic.error.rate_limited"));
    expect(mocks.setBackupPaymentMethod).not.toHaveBeenCalled();

    mocks.subscriberEventCount.mockResolvedValue(1);
    mocks.resolveLockState.mockResolvedValue({
      locked: true,
      until: new Date("2026-12-01T00:00:00Z"),
      lockDays: 30,
    });
    const result = await executeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(mocks.setBackupPaymentMethod).toHaveBeenCalledTimes(1);
    expect(result.headline).toBe(t("en", "magic.set_backup.done_generic"));
  });

  it("describes itself on the confirm page (card named when labelled, generic otherwise)", async () => {
    const named = await describeMagicAction(
      payload("SET_BACKUP", { paymentMethodId: PM_OTHER, label: "Mastercard ····8210" }),
    );
    expect(named.title).toBe(t("en", "magic.confirm.title.SET_BACKUP"));
    expect(named.description).toBe(
      t("en", "magic.confirm.desc.SET_BACKUP", { card: "Mastercard ····8210" }),
    );
    expect(named.confirmLabel).toBe(t("en", "magic.confirm.button"));
    const generic = await describeMagicAction(payload("SET_BACKUP", { paymentMethodId: PM_OTHER }));
    expect(generic.description).toBe(t("en", "magic.confirm.desc.SET_BACKUP_GENERIC"));
  });

  it("buildSetBackupUrl mints a multi-use (5) SET_BACKUP token carrying the id and label", async () => {
    const url = await buildSetBackupUrl({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "NEW_CARD_DETECTED",
      ttlDays: 37,
      paymentMethodId: PM_OTHER,
      label: "Mastercard ····8210",
    });
    expect(url).toContain("/magic/TOKEN_ABC");
    expect((mocks.createMagicToken.mock.calls as unknown as Array<[unknown]>)[0]?.[0]).toMatchObject({
      action: "SET_BACKUP",
      // Multi-use like UPDATE_CARD (Stage G review fix): idempotent verb,
      // token consumed before execution.
      maxUses: 5,
      ttlSeconds: 37 * 24 * 3600,
      params: { paymentMethodId: PM_OTHER, label: "Mastercard ····8210" },
    });
  });
});

// ── 3. Template registration ─────────────────────────────────────────────────

describe("new_card_detected template", () => {
  it("is registered with its own metric, CTA label and catalog entry, and appears in the flow specs with a rationale", () => {
    expect(TEMPLATES.new_card_detected).toMatchObject({
      channel: "EMAIL",
      klaviyoMetric: "Cellexia New Card Detected",
      i18nKey: "email.new_card_detected",
      critical: false,
      ctaLabelKey: "email.cta.use_new_card",
    });
    expect(EMAIL_CATALOG.new_card_detected).toMatchObject({
      group: "payments",
      customizable: true,
      disableable: true,
    });
    expect([...EMAIL_CATALOG.new_card_detected.links]).toEqual(
      expect.arrayContaining(["portal_url", "use_url", "backup_url"]),
    );
    const spec = flowSpecs().find((s) => s.metric === "Cellexia New Card Detected");
    expect(spec).toBeDefined();
    expect(spec!.templates).toEqual(["new_card_detected"]);
    expect(spec!.why.length).toBeGreaterThan(10);
  });

  it("previews placeholder-free through the real pipeline (subject + html + text)", async () => {
    const vars = previewSampleVars("new_card_detected");
    expect(vars.use_url).toMatch(/example\.com/);
    expect(vars.backup_url).toMatch(/example\.com/);
    const preview = await renderTemplatePreview({ template: "new_card_detected", locale: "en" });
    expect(preview.subject).not.toMatch(/\{[a-z_]+\}/);
    expect(preview.html).not.toMatch(/\{[a-z_]+\}/);
    expect(preview.text).not.toMatch(/\{[a-z_]+\}/);
    expect(preview.html).toContain("Use my new card");
    expect(preview.html).toContain("https://example.com/use-new-card");
    expect(preview.html).toContain("https://example.com/set-as-backup");
  });

  it("English body carries the intro / cta / backup lines and promises nothing about re-purchases", () => {
    const body = t("en", "email.new_card_detected.body");
    for (const ph of ["{intro_line}", "{cta}", "{backup_line}"]) expect(body).toContain(ph);
    expect(body).not.toMatch(/re-?purchase|one-time order/i);
    expect(t("en", "email.new_card_detected.intro_held", { card_label: "X", current_card_label: "Y" })).toContain("X");
    expect(t("en", "email.new_card_detected.backup_line", { current_card_label: "Y", backup_url: "U" })).toContain("U");
  });
});

// ── 4. Closed loop copy for the auto-switch ──────────────────────────────────

describe("payment_method_updated reason new_method", () => {
  const base = {
    locale: "en",
    tz: "Europe/Zurich",
    contract: {
      id: "ctr_1",
      shopId: "shop_1",
      cardBrand: "mastercard",
      cardLast4: "8210",
      paymentInstrumentType: "CREDIT_CARD",
      status: "ACTIVE",
      nextBillingDate: null,
    },
    previousCard: { cardBrand: "visa", cardLast4: "4242", paymentInstrumentType: "CREDIT_CARD" },
    cardUpdatedBy: "system" as const,
  };

  it("says 'we moved your subscription to your new card ····8210' (retrying variant with a held payment) and is not a backup notice", async () => {
    const calm = await paymentMethodUpdatedVars({ ...base, reason: "new_method", hasOpenCase: false });
    expect(calm.change_line).toBe(
      t("en", "email.payment_method_updated.change_line_new_method", {
        card_label: "Mastercard ····8210",
        previous_card_label: "Visa ····4242",
      }),
    );
    expect(String(calm.change_line)).toMatch(/moved your subscription to your new card Mastercard ····8210/);
    expect(calm.via_backup).toBe(false);
    expect(calm.change_reason).toBe("new_method");

    const held = await paymentMethodUpdatedVars({ ...base, reason: "new_method", hasOpenCase: true });
    expect(held.change_line).toBe(
      t("en", "email.payment_method_updated.change_line_new_method_retrying", {
        card_label: "Mastercard ····8210",
        previous_card_label: "Visa ····4242",
      }),
    );
    expect(held.next_line).toBe("");
  });

  it("the service passes reason new_method / cardUpdatedBy system for that trigger (source pin)", () => {
    const src = readSource("app/lib/contracts/service.server.ts");
    expect(src).toContain('reason: trigger === "new_method" ? "new_method" : "updated"');
    expect(src).toMatch(/trigger === "new_method"\s*\?\s*"system"/);
  });
});

// ── 5. Settings ──────────────────────────────────────────────────────────────

describe("settings", () => {
  it("dunning.newMethodDetection / newMethodAutoSwitch default true (field-level, additive) and are on the Settings page", () => {
    const parsed = settingsSchemas.dunning.parse({
      softRetryDays: [0, 3],
      paydayAlign: false,
      paydaysOfMonth: [1],
      paydaySnapWindowDays: 0,
      emailLadderDays: [0],
      smsDay: 8,
      preExpiryNoticeDays: 30,
      backupPaymentFallback: true,
      exhaustedAction: "PAUSE",
      cancelAfterFailedDays: 30,
    }) as Record<string, unknown>;
    expect(parsed.newMethodDetection).toBe(true);
    expect(parsed.newMethodAutoSwitch).toBe(true);
    const defaults = settingsSchemas.dunning.parse(undefined) as Record<string, unknown>;
    expect(defaults.newMethodDetection).toBe(true);
    expect(defaults.newMethodAutoSwitch).toBe(true);
    const page = readSource("app/routes/app.settings.tsx");
    expect(page).toContain('path: "newMethodDetection"');
    expect(page).toContain('path: "newMethodAutoSwitch"');
  });
});

// ── 6. i18n ──────────────────────────────────────────────────────────────────

describe("i18n", () => {
  it("every new English key exists", () => {
    const en = locales.en as Record<string, string>;
    for (const key of [
      "portal.index.new_card_banner",
      "portal.index.new_card_banner_labelled",
      "portal.index.new_card_cta",
      "portal.index.new_card_more",
      "email.new_card_detected.subject",
      "email.new_card_detected.body",
      "email.new_card_detected.intro_held",
      "email.new_card_detected.intro_expiring",
      "email.new_card_detected.intro_generic",
      "email.new_card_detected.backup_line",
      "email.new_card_detected.backup_line_generic",
      "email.cta.use_new_card",
      "email.payment_method_updated.change_line_new_method",
      "email.payment_method_updated.change_line_new_method_retrying",
      "magic.confirm.title.SET_BACKUP",
      "magic.confirm.desc.SET_BACKUP",
      "magic.confirm.desc.SET_BACKUP_GENERIC",
      "magic.set_backup.done",
      "magic.set_backup.done_generic",
      "magic.set_backup.done_sub",
      "magic.set_backup.already_primary",
      "magic.set_backup.already_primary_sub",
      "magic.set_backup.unavailable",
      "magic.set_backup.unavailable_sub",
    ]) {
      expect(typeof en[key], key).toBe("string");
      expect(en[key].length, key).toBeGreaterThan(0);
    }
  });

  it("the 'add another payment method' copy states honest options only (account page / secure link / subscription checkout), never a one-time re-purchase", () => {
    const en = locales.en as Record<string, string>;
    const copy = [
      en["portal.payment.add_title"],
      en["portal.payment.add_in_account"],
      en["portal.payment.add_email_link"],
      en["portal.payment.add_checkout_note"],
    ].join(" ");
    expect(copy).toMatch(/subscription/i);
    expect(copy).not.toMatch(/one-time|any (new )?order|next order saves|buy(ing)? anything/i);
  });
});
