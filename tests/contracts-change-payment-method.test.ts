import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * changePaymentMethod / setBackupPaymentMethod (v1.28.0, migration 0027) —
 * the contract-service seam behind the portal "Use for this subscription",
 * the admin "Make primary" and the dunning backup swap:
 *
 *  - the gid is validated against the customer's NON-REVOKED methods (never
 *    the form) → typed PaymentMethodChangeError PAYMENT_METHOD_NOT_ON_ACCOUNT;
 *  - Shopify draft update + mirror refresh (brand/last4/expiry/instrument
 *    type, paymentMethodRevokedAt cleared);
 *  - pointer rules: new === backup → backupPaymentMethodId cleared; open case
 *    on the backup → originalPaymentMethodId nulled (no engine revert);
 *    already primary → no-op, no event; trigger `backup` keeps the historical
 *    swap (old primary becomes the backup);
 *  - event contract.payment_method_updated {trigger, previous, new};
 *  - dunning.onPaymentMethodUpdated is poked and CONTAINED;
 *  - changePaymentMethodToBackup delegates with trigger `backup`;
 *  - setBackupPaymentMethod: null clears, ≠ primary, ∈ live list, provenance
 *    columns, events contract.backup_payment_set|cleared.
 *
 * Scaffold: aud-contracts-skip-pause-cancel.test.ts (real service module,
 * seams mocked).
 */

const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
const PM_MAIN = "gid://shopify/CustomerPaymentMethod/main";
const PM_OTHER = "gid://shopify/CustomerPaymentMethod/other";
const PM_BACKUP = "gid://shopify/CustomerPaymentMethod/backup";
const PM_REVOKED = "gid://shopify/CustomerPaymentMethod/revoked";
const PM_FOREIGN = "gid://shopify/CustomerPaymentMethod/foreign";

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: unknown[] },
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      Object.assign(store.contract, args.data);
      return store.contract;
    },
  ),
  dunningCaseUpdateMany: vi.fn(async (): Promise<unknown> => ({ count: 1 })),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
  draftUpdatePaymentMethod: vi.fn(async (): Promise<void> => {}),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      body: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<void> => {
      await body("gid://shopify/SubscriptionDraft/1", {});
    },
  ),
  onPaymentMethodUpdated: vi.fn(async (): Promise<void> => {}),
  sendPaymentMethodUpdatedOnce: vi.fn(async (_i?: unknown): Promise<string> => "SENT"),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
    },
    dunningCase: {
      updateMany: mocks.dunningCaseUpdateMany,
      findFirst: mocks.dunningCaseFindFirst,
    },
    contractLine: {
      deleteMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    },
    subscriberEvent: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/winback/engine.server", () => ({
  scheduleWinback: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onPaymentMethodUpdated: mocks.onPaymentMethodUpdated,
}));
// v1.28.0 closed loop (P1.4): the service tells the customer the switch
// worked through the shared notice helper — pinned at its seam here.
vi.mock("~/lib/notifications/payment-method.server", () => ({
  sendPaymentMethodUpdatedOnce: mocks.sendPaymentMethodUpdatedOnce,
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: vi.fn(),
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdatePaymentMethod: mocks.draftUpdatePaymentMethod,
    getBillingCycleByDate: vi.fn(),
    getContract: vi.fn(),
    getVariants: vi.fn(),
    listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: vi.fn(),
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: vi.fn(),
    withContractDraft: mocks.withContractDraft,
  };
});

import {
  PaymentMethodChangeError,
  changePaymentMethod,
  changePaymentMethodToBackup,
  setBackupPaymentMethod,
} from "~/lib/contracts/service.server";

function method(
  id: string,
  over: Record<string, unknown> = {},
  instrument: Record<string, unknown> | null = {
    type: "CREDIT_CARD",
    brand: "Mastercard",
    lastDigits: "1111",
    expiryMonth: 12,
    expiryYear: 2028,
    expiresSoon: false,
  },
) {
  return { id, revoked: false, revokedAt: null, revokedReason: null, instrument, ...over };
}

function baseContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    paymentMethodId: PM_MAIN,
    backupPaymentMethodId: null,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardExpiryMonth: 4,
    cardExpiryYear: 2027,
    paymentInstrumentType: "CREDIT_CARD",
    paymentMethodRevokedAt: null,
    lines: [],
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; source: string; actor: string | null; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = baseContract();
  mocks.listCustomerPaymentMethods.mockResolvedValue([
    method(PM_MAIN, {}, { type: "CREDIT_CARD", brand: "Visa", lastDigits: "4242", expiryMonth: 4, expiryYear: 2027, expiresSoon: false }),
    method(PM_OTHER),
    method(PM_BACKUP, {}, { type: "SHOP_PAY", brand: "Shop Pay", lastDigits: "8888", expiryMonth: 1, expiryYear: 2030, expiresSoon: false }),
    method(PM_REVOKED, { revoked: true, revokedAt: new Date("2026-08-01T00:00:00Z") }),
  ]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("changePaymentMethod — validation", () => {
  it("refuses a gid that is not among the customer's live methods (typed error, no Shopify call)", async () => {
    await expect(
      changePaymentMethod("cellexia.myshopify.com", "c_1", PM_FOREIGN, {
        source: "CUSTOMER_PORTAL",
        actor: "customer",
        trigger: "select",
      }),
    ).rejects.toMatchObject({
      name: "PaymentMethodChangeError",
      code: "PAYMENT_METHOD_NOT_ON_ACCOUNT",
    });
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(0);
  });

  it("refuses a REVOKED method of the same customer", async () => {
    await expect(
      changePaymentMethod("cellexia.myshopify.com", "c_1", PM_REVOKED, {
        trigger: "select",
      }),
    ).rejects.toBeInstanceOf(PaymentMethodChangeError);
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
  });

  it("refuses a FOREIGN / UNKNOWN (other app's) contract before any Shopify or mirror write — CONTRACT_NOT_OWNED (Stage G review fix)", async () => {
    for (const ownership of ["FOREIGN", "UNKNOWN"]) {
      store.contract = baseContract({ ownership });
      await expect(
        changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
          source: "WEBHOOK",
          actor: "system",
          trigger: "new_method",
        }),
      ).rejects.toMatchObject({ name: "PaymentMethodChangeError", code: "CONTRACT_NOT_OWNED" });
    }
    expect(mocks.listCustomerPaymentMethods).not.toHaveBeenCalled();
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.onPaymentMethodUpdated).not.toHaveBeenCalled();
  });

  it("already primary → no-op: no Shopify call, no mirror write, no event", async () => {
    const out = await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_MAIN, {
      trigger: "select",
    });
    expect(out.paymentMethodId).toBe(PM_MAIN);
    expect(mocks.listCustomerPaymentMethods).not.toHaveBeenCalled();
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("changePaymentMethod — switch, mirror, event, dunning poke", () => {
  it("drafts the Shopify update, refreshes the mirror (type + revokedAt cleared) and logs the event", async () => {
    store.contract = baseContract({
      paymentMethodRevokedAt: new Date("2026-08-02T00:00:00Z"),
    });

    await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      trigger: "select",
    });

    expect(mocks.withContractDraft).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      expect.any(Function),
    );
    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/SubscriptionDraft/1",
      PM_OTHER,
    );
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      paymentMethodId: PM_OTHER,
      cardBrand: "Mastercard",
      cardLast4: "1111",
      cardExpiryMonth: 12,
      cardExpiryYear: 2028,
      paymentInstrumentType: "CREDIT_CARD",
      paymentMethodRevokedAt: null,
    });
    // Not on backup and PM_OTHER is not the backup → pointer untouched.
    expect(data).not.toHaveProperty("backupPaymentMethodId");

    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.source).toBe("CUSTOMER_PORTAL");
    expect(event.actor).toBe("customer");
    expect(event.payload).toMatchObject({
      trigger: "select",
      usedBackup: false,
      previousPaymentMethodId: PM_MAIN,
      paymentMethodId: PM_OTHER,
      card_updated_by: "customer",
    });
    expect(mocks.onPaymentMethodUpdated).toHaveBeenCalledWith("c_1", expect.anything());

    // v1.28.0 closed loop: the customer hears the switch worked — the notice
    // describes the NEW card and names the old one; a customer trigger.
    expect(mocks.sendPaymentMethodUpdatedOnce).toHaveBeenCalledTimes(1);
    const notice = mocks.sendPaymentMethodUpdatedOnce.mock.calls[0][0] as {
      reason: string;
      cardUpdatedBy: string;
      contract: Record<string, unknown>;
      previousCard: Record<string, unknown>;
    };
    expect(notice).toMatchObject({ reason: "updated", cardUpdatedBy: "customer" });
    expect(notice.contract).toMatchObject({
      paymentMethodId: PM_OTHER,
      cardLast4: "1111",
      paymentInstrumentType: "CREDIT_CARD",
    });
    expect(notice.previousCard).toMatchObject({ cardLast4: "4242" });
  });

  it("the admin trigger notifies with card_updated_by 'merchant'; the backup trigger never double-sends (the engine owns that notice)", async () => {
    await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
      source: "ADMIN",
      trigger: "admin",
    });
    expect(mocks.sendPaymentMethodUpdatedOnce).toHaveBeenCalledTimes(1);
    expect(mocks.sendPaymentMethodUpdatedOnce.mock.calls[0][0]).toMatchObject({
      cardUpdatedBy: "merchant",
    });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({ card_updated_by: "merchant" });

    vi.clearAllMocks();
    store.contract = baseContract();
    await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
      trigger: "backup",
    });
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });

  it("selecting the BACKUP as primary clears backupPaymentMethodId (pointer equality would read as 'engine on backup')", async () => {
    store.contract = baseContract({ backupPaymentMethodId: PM_BACKUP });

    await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_BACKUP, {
      trigger: "select",
    });

    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      paymentMethodId: PM_BACKUP,
      backupPaymentMethodId: null,
      paymentInstrumentType: "SHOP_PAY",
      cardLast4: "8888",
    });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({ backupCleared: true });
    // Not on backup at call time → the chosen card becomes the open case's
    // revert target (v1.28.0 audit: an explicit choice mid-case must never
    // be undone by a later backup-then-revert).
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { contractId: "c_1", resolvedAt: null },
      data: { originalPaymentMethodId: PM_BACKUP },
    });
  });

  it("selecting a new primary while the engine is ON the backup nulls the open case's originalPaymentMethodId", async () => {
    store.contract = baseContract({
      paymentMethodId: PM_BACKUP,
      backupPaymentMethodId: PM_BACKUP, // engine's "on backup" marker
    });

    await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
      trigger: "admin",
      source: "ADMIN",
      actor: "merchant@example.com",
    });

    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { contractId: "c_1", resolvedAt: null },
      data: { originalPaymentMethodId: null },
    });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({ trigger: "admin", paymentMethodId: PM_OTHER });
  });

  it("dunning poke failure is contained — the switch, mirror and event stand", async () => {
    mocks.onPaymentMethodUpdated.mockRejectedValueOnce(new Error("engine down"));

    const out = await changePaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, {
      trigger: "select",
    });

    expect(out.paymentMethodId).toBe(PM_OTHER);
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
  });
});

describe("changePaymentMethodToBackup delegates with trigger 'backup' (old swap semantics)", () => {
  it("old primary becomes the backup; event keeps usedBackup:true", async () => {
    store.contract = baseContract({ backupPaymentMethodId: PM_BACKUP });

    await changePaymentMethodToBackup("cellexia.myshopify.com", "c_1", {
      source: "SYSTEM",
    });

    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      PM_BACKUP,
    );
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      paymentMethodId: PM_BACKUP,
      backupPaymentMethodId: PM_MAIN,
      cardLast4: "8888",
      paymentInstrumentType: "SHOP_PAY",
    });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({
      trigger: "backup",
      usedBackup: true,
      previousPaymentMethodId: PM_MAIN,
      paymentMethodId: PM_BACKUP,
    });
    // The swap is a fallback, not a customer choice → the case keeps its
    // revert target.
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
  });

  it("no backup configured → throws; already on the backup → no-op", async () => {
    await expect(
      changePaymentMethodToBackup("cellexia.myshopify.com", "c_1"),
    ).rejects.toThrow(/no backup payment method/);

    store.contract = baseContract({
      paymentMethodId: PM_BACKUP,
      backupPaymentMethodId: PM_BACKUP,
    });
    await changePaymentMethodToBackup("cellexia.myshopify.com", "c_1");
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("setBackupPaymentMethod", () => {
  it("sets a live, non-primary method with provenance and logs backup_payment_set", async () => {
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_BACKUP, {
      source: "ADMIN",
      actor: "merchant@example.com",
      setBy: "ADMIN",
    });

    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ backupPaymentMethodId: PM_BACKUP, backupSetBy: "ADMIN" });
    expect(data.backupSetAt).toBeInstanceOf(Date);
    const [event] = eventsOfType("contract.backup_payment_set");
    expect(event.source).toBe("ADMIN");
    expect(event.payload).toMatchObject({
      setBy: "ADMIN",
      paymentMethodId: PM_BACKUP,
      previousBackupPaymentMethodId: null,
      instrumentType: "SHOP_PAY",
      cardLast4: "8888",
    });
    // Local column only — Shopify has no notion of a backup.
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
  });

  it("refuses the primary as backup and a method not on the account (typed errors)", async () => {
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_MAIN, { setBy: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "BACKUP_EQUALS_PRIMARY" });
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_FOREIGN, { setBy: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "PAYMENT_METHOD_NOT_ON_ACCOUNT" });
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_REVOKED, { setBy: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "PAYMENT_METHOD_NOT_ON_ACCOUNT" });
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("while the engine is charging the backup (both pointers equal, OPEN case) the backup cannot be cleared or repointed — BACKUP_IN_USE (v1.28.0 audit: the revert marker must survive)", async () => {
    store.contract = baseContract({ paymentMethodId: PM_BACKUP, backupPaymentMethodId: PM_BACKUP });
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_open" });
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", null, { setBy: "ADMIN" }),
    ).rejects.toMatchObject({ code: "BACKUP_IN_USE" });
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, { setBy: "ADMIN" }),
    ).rejects.toMatchObject({ code: "BACKUP_IN_USE" });
    // Re-setting the same backup is the idempotent no-op it always was.
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_BACKUP, { setBy: "ADMIN" });
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("pointer equality WITHOUT an open case is a stale marker (recovered on the backup, collapse failed): repointing / clearing the backup works (Stage G review fix)", async () => {
    store.contract = baseContract({ paymentMethodId: PM_BACKUP, backupPaymentMethodId: PM_BACKUP });
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_OTHER, { setBy: "CUSTOMER" });
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ backupPaymentMethodId: PM_OTHER, backupSetBy: "CUSTOMER" });
    expect(eventsOfType("contract.backup_payment_set")[0].payload).toMatchObject({
      paymentMethodId: PM_OTHER,
      previousBackupPaymentMethodId: PM_BACKUP,
    });
    // The open-case lookup was scoped to open states (never a resolved case).
    const where = (mocks.dunningCaseFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "c_1" });
    expect(where.state).toBeDefined();

    // Clearing works too; the primary stays what it is.
    vi.clearAllMocks();
    store.contract = baseContract({ paymentMethodId: PM_BACKUP, backupPaymentMethodId: PM_BACKUP });
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", null, { setBy: "CUSTOMER" });
    expect((mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data)
      .toMatchObject({ backupPaymentMethodId: null });
    expect(store.contract.paymentMethodId).toBe(PM_BACKUP);
    // And "set the primary as backup" is still the plain BACKUP_EQUALS_PRIMARY refusal.
    await expect(
      setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_BACKUP, { setBy: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "BACKUP_EQUALS_PRIMARY" });
  });

  it("null clears with provenance and logs backup_payment_cleared; clearing an empty backup is a silent no-op", async () => {
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", null, { setBy: "CUSTOMER" });
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    store.contract = baseContract({ backupPaymentMethodId: PM_BACKUP });
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", null, {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      setBy: "CUSTOMER",
    });
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ backupPaymentMethodId: null, backupSetBy: "CUSTOMER" });
    const [event] = eventsOfType("contract.backup_payment_cleared");
    expect(event.payload).toMatchObject({
      setBy: "CUSTOMER",
      previousBackupPaymentMethodId: PM_BACKUP,
    });
  });

  it("same backup again → no-op", async () => {
    store.contract = baseContract({ backupPaymentMethodId: PM_BACKUP });
    await setBackupPaymentMethod("cellexia.myshopify.com", "c_1", PM_BACKUP, { setBy: "ADMIN" });
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
