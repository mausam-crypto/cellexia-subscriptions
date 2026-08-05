/**
 * GDPR compliance handler tests (mocked prisma) — the contract of
 * app/services/core/gdpr.server.ts:
 *
 *  1. customers/redact anonymises PII (email, delivery address, acquisition
 *     identifiers) while retaining financial records, and is idempotent —
 *     a redelivery redacts nothing new and its audit row says alreadyRedacted.
 *  2. Acquisition stripping keeps the aggregate-safe fields (countryCode,
 *     channel, device, schemaVersion) and stamps redactedAt exactly once.
 *  3. shop/redact deletes child tables before their parents, never touches
 *     AuditLog, and appends the per-table-counts audit entry BEFORE deleting.
 *  4. customers/data_request appends exactly ONE counts-only audit row and
 *     logs the full (deliberately unredacted) export for the operator.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  return {
    subscriptionContract: model(),
    contractLine: model(),
    depletionEstimate: model(),
    addOnItem: model(),
    billingAttempt: model(),
    dunningState: model(),
    milestone: model(),
    magicLinkToken: model(),
    analyticsEvent: model(),
    cancellationSession: model(),
    sellingPlanConfigVersion: model(),
    sellingPlanConfig: model(),
    experimentAssignment: model(),
    experiment: model(),
    scoreSnapshot: model(),
    adherenceSurvey: model(),
    productMeta: model(),
    compatibilityEdge: model(),
    routineTemplate: model(),
    widgetConfig: model(),
    outboundEvent: model(),
    forecastSnapshot: model(),
    modelState: model(),
    processedWebhook: model(),
    staffRole: model(),
    shopSettings: model(),
    session: model(),
    idempotencyKey: model(),
    // Present ONLY to prove shop redact never touches it.
    auditLog: model(),
    $transaction: vi.fn(),
  };
});
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const log = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("~/lib/logger.server", () => log);

import {
  customerIdForms,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  redactAcquisition,
} from "~/services/core/gdpr.server";

const SHOP = "cellexia-demo.myshopify.com";
const CUSTOMER_GID = "gid://shopify/Customer/777";
const EMAIL = "marie@example.com";

type ModelMock = {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

function allModelMocks(): ModelMock[] {
  return Object.values(db).filter(
    (v): v is ModelMock => typeof v === "object" && v != null && "count" in v,
  );
}

function acquisitionWithPii(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    capturedAt: "2026-08-02T10:00:00.000Z",
    channel: "tiktok",
    device: "mobile",
    widgetVersion: "B",
    landingPage: "/products/serum",
    timeToPurchaseSeconds: 900,
    unitsInitial: 2,
    referrer: "https://www.tiktok.com/@someone",
    utm: { utm_source: "tiktok", fbclid: "abc" },
    visitor: "v1a2b3c",
    raw: { _cellexia_visitor: "v1a2b3c", _cellexia_referrer: "https://t.co/x" },
    custom: { _cellexia_note: "gift" },
    geo: {
      countryCode: "FR",
      country: "France",
      city: "Lyon",
      province: "Rhône",
      zip3: "690",
    },
  };
}

function contractRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    shopifyCustomerId: CUSTOMER_GID,
    customerEmail: EMAIL,
    deliveryAddressJson: JSON.stringify({ address1: "12 rue des Lilas" }),
    acquisitionJson: JSON.stringify(acquisitionWithPii()),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of allModelMocks()) {
    model.findMany.mockResolvedValue([]);
    model.update.mockResolvedValue({});
    model.deleteMany.mockResolvedValue({ count: 0 });
    model.count.mockResolvedValue(0);
  }
  db.$transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
});

describe("customerIdForms", () => {
  it("expands a bare numeric id into gid + bare", () => {
    expect(customerIdForms(777)).toEqual([CUSTOMER_GID, "777"]);
    expect(customerIdForms("777")).toEqual([CUSTOMER_GID, "777"]);
  });

  it("expands a gid into gid + bare", () => {
    expect(customerIdForms(CUSTOMER_GID)).toEqual([CUSTOMER_GID, "777"]);
  });

  it("returns nothing for missing ids", () => {
    expect(customerIdForms(null)).toEqual([]);
    expect(customerIdForms(undefined)).toEqual([]);
    expect(customerIdForms("  ")).toEqual([]);
  });
});

describe("redactAcquisition — PII stripping", () => {
  it("strips identifiers, keeps aggregate fields, stamps redactedAt", () => {
    const { record, changed } = redactAcquisition(
      acquisitionWithPii(),
      "2026-08-04T09:00:00.000Z",
    );

    expect(changed).toBe(true);
    // Removed: everything that identifies or fingerprints the person.
    expect(record.referrer).toBeUndefined();
    expect(record.utm).toBeUndefined();
    expect(record.visitor).toBeUndefined();
    expect(record.raw).toBeUndefined();
    expect(record.custom).toBeUndefined();
    // Kept: coarse aggregates cohort analytics runs on.
    expect(record.channel).toBe("tiktok");
    expect(record.device).toBe("mobile");
    expect(record.schemaVersion).toBe(2);
    expect(record.widgetVersion).toBe("B");
    expect(record.unitsInitial).toBe(2);
    expect(record.geo).toEqual({ countryCode: "FR", country: "France" });
    expect(record.redactedAt).toBe("2026-08-04T09:00:00.000Z");
  });

  it("is idempotent: a second pass changes nothing and keeps the first stamp", () => {
    const first = redactAcquisition(
      acquisitionWithPii(),
      "2026-08-04T09:00:00.000Z",
    );
    const second = redactAcquisition(first.record, "2026-09-01T00:00:00.000Z");
    expect(second.changed).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(second.record.redactedAt).toBe("2026-08-04T09:00:00.000Z");
  });

  it("drops an emptied geo object instead of leaving {}", () => {
    const { record } = redactAcquisition(
      { schemaVersion: 2, geo: { city: "Lyon", zip3: "690" } },
      "2026-08-04T09:00:00.000Z",
    );
    expect(record.geo).toBeUndefined();
  });
});

describe("handleCustomersRedact", () => {
  const payload = {
    shop_domain: SHOP,
    customer: { id: 777, email: EMAIL },
    orders_to_redact: [1001],
  };

  it("matches gid + bare id forms and nulls PII columns while keeping the row", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([contractRow()]);
    db.magicLinkToken.deleteMany.mockResolvedValue({ count: 2 });
    db.analyticsEvent.findMany.mockResolvedValue([
      {
        id: "e1",
        payloadJson: JSON.stringify({ email: EMAIL, intervalWeeks: 4 }),
      },
      { id: "e2", payloadJson: JSON.stringify({ productId: "p1" }) },
    ]);

    await handleCustomersRedact(SHOP, payload);

    // Both identity forms are matched.
    const { where } = db.subscriptionContract.findMany.mock.calls[0][0];
    expect(where).toEqual({
      shop: SHOP,
      shopifyCustomerId: { in: [CUSTOMER_GID, "777"] },
    });

    // The contract row survives (financial record) but its PII is gone.
    expect(db.subscriptionContract.update).toHaveBeenCalledTimes(1);
    const { data } = db.subscriptionContract.update.mock.calls[0][0];
    expect(data.customerEmail).toBeNull();
    expect(data.deliveryAddressJson).toBeNull();
    const acquisition = JSON.parse(data.acquisitionJson as string);
    expect(acquisition.utm).toBeUndefined();
    expect(acquisition.referrer).toBeUndefined();
    expect(acquisition.visitor).toBeUndefined();
    expect(acquisition.geo).toEqual({ countryCode: "FR", country: "France" });
    expect(acquisition.channel).toBe("tiktok");
    expect(typeof acquisition.redactedAt).toBe("string");

    // Magic-link tokens die by customer id OR email.
    const tokenWhere = db.magicLinkToken.deleteMany.mock.calls[0][0].where;
    expect(tokenWhere.shop).toBe(SHOP);
    expect(tokenWhere.OR).toEqual([
      { shopifyCustomerId: { in: [CUSTOMER_GID, "777"] } },
      { email: EMAIL },
    ]);

    // Only the email-bearing event is rewritten, minus its email key.
    expect(db.analyticsEvent.update).toHaveBeenCalledTimes(1);
    const eventUpdate = db.analyticsEvent.update.mock.calls[0][0];
    expect(eventUpdate.where).toEqual({ id: "e1" });
    expect(JSON.parse(eventUpdate.data.payloadJson as string)).toEqual({
      intervalWeeks: 4,
    });

    // Counts-only audit — the redacted values must never re-enter storage.
    expect(audit.appendAudit).toHaveBeenCalledTimes(1);
    const entry = audit.appendAudit.mock.calls[0][0];
    expect(entry.action).toBe("GDPR_CUSTOMER_REDACTED");
    expect(entry.subjectType).toBe("Customer");
    expect(entry.subjectId).toBe(CUSTOMER_GID);
    expect(entry.payload).toEqual({
      contractsMatched: 1,
      contractsRedacted: 1,
      tokensDeleted: 2,
      eventsScrubbed: 1,
      alreadyRedacted: false,
    });
    expect(JSON.stringify(entry.payload)).not.toContain(EMAIL);
  });

  it("is idempotent: a re-run redacts nothing new and audits alreadyRedacted", async () => {
    const alreadyRedactedAcquisition = redactAcquisition(
      acquisitionWithPii(),
      "2026-08-04T09:00:00.000Z",
    ).record;
    db.subscriptionContract.findMany.mockResolvedValue([
      contractRow({
        customerEmail: null,
        deliveryAddressJson: null,
        acquisitionJson: JSON.stringify(alreadyRedactedAcquisition),
      }),
    ]);
    db.magicLinkToken.deleteMany.mockResolvedValue({ count: 0 });
    db.analyticsEvent.findMany.mockResolvedValue([
      { id: "e1", payloadJson: JSON.stringify({ intervalWeeks: 4 }) },
    ]);

    await handleCustomersRedact(SHOP, payload);

    expect(db.subscriptionContract.update).not.toHaveBeenCalled();
    expect(db.analyticsEvent.update).not.toHaveBeenCalled();
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "GDPR_CUSTOMER_REDACTED",
        payload: expect.objectContaining({
          contractsRedacted: 0,
          tokensDeleted: 0,
          eventsScrubbed: 0,
          alreadyRedacted: true,
        }),
      }),
    );
  });

  it("audits an invalid payload without touching any state", async () => {
    await handleCustomersRedact(SHOP, { customer: {} });
    expect(db.subscriptionContract.findMany).not.toHaveBeenCalled();
    expect(db.magicLinkToken.deleteMany).not.toHaveBeenCalled();
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "GDPR_CUSTOMER_REDACTED",
        payload: { invalidPayload: true },
      }),
    );
  });
});

describe("handleCustomersDataRequest", () => {
  const payload = {
    shop_domain: SHOP,
    customer: { id: 777, email: EMAIL },
    orders_requested: [1001, 1002],
    data_request: { id: 55 },
  };

  it("appends exactly ONE counts-only audit row with the required shape", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      { ...contractRow(), lines: [] },
    ]);
    db.billingAttempt.count.mockResolvedValue(4);
    db.analyticsEvent.count.mockResolvedValue(7);

    await handleCustomersDataRequest(SHOP, payload);

    expect(audit.appendAudit).toHaveBeenCalledTimes(1);
    const entry = audit.appendAudit.mock.calls[0][0];
    expect(entry.action).toBe("GDPR_DATA_REQUEST");
    expect(entry.subjectType).toBe("Customer");
    expect(entry.subjectId).toBe(CUSTOMER_GID);
    expect(entry.payload).toEqual({ ordersRequested: 2, contractsFound: 1 });
  });

  it("logs the full export (PII included — that is its purpose) and mutates nothing", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      {
        ...contractRow(),
        lines: [
          {
            title: "Serum",
            quantity: 2,
            currentPriceCents: 3995,
            shopifyProductId: "gid://shopify/Product/11",
            shopifyVariantId: "gid://shopify/ProductVariant/111",
          },
        ],
      },
    ]);
    db.billingAttempt.count.mockResolvedValue(4);
    db.analyticsEvent.count.mockResolvedValue(7);

    await handleCustomersDataRequest(SHOP, payload);

    const exportCall = log.logger.info.mock.calls.find(
      ([message]) => message === "gdpr customer data request export",
    );
    expect(exportCall).toBeDefined();
    const context = exportCall?.[1] as {
      export: {
        email: string | null;
        billingAttemptsCount: number;
        analyticsEventsCount: number;
        contracts: Array<{
          customerEmail: string | null;
          acquisition: Record<string, unknown> | null;
          lines: unknown[];
        }>;
      };
    };
    expect(context.export.email).toBe(EMAIL);
    expect(context.export.billingAttemptsCount).toBe(4);
    expect(context.export.analyticsEventsCount).toBe(7);
    expect(context.export.contracts).toHaveLength(1);
    expect(context.export.contracts[0].customerEmail).toBe(EMAIL);
    expect(context.export.contracts[0].lines).toHaveLength(1);
    // The export is NOT redacted — the customer is entitled to all of it.
    expect(context.export.contracts[0].acquisition?.referrer).toBe(
      "https://www.tiktok.com/@someone",
    );

    expect(db.subscriptionContract.update).not.toHaveBeenCalled();
    expect(db.magicLinkToken.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("handleShopRedact", () => {
  function firstCall(fn: ReturnType<typeof vi.fn>): number {
    expect(fn).toHaveBeenCalled();
    return fn.mock.invocationCallOrder[0];
  }

  beforeEach(() => {
    db.subscriptionContract.findMany.mockResolvedValue([
      { id: "contract-cuid-1" },
    ]);
    db.addOnItem.findMany.mockResolvedValue([{ id: "addon-cuid-1" }]);
    db.cancellationSession.findMany.mockResolvedValue([
      { id: "session-cuid-1" },
    ]);
    db.subscriptionContract.count.mockResolvedValue(3);
    db.contractLine.count.mockResolvedValue(5);
    db.idempotencyKey.count.mockResolvedValue(4);
    for (const model of allModelMocks()) {
      model.deleteMany.mockResolvedValue({ count: 1 });
    }
  });

  it("appends the per-table-counts audit entry BEFORE any delete runs", async () => {
    await handleShopRedact(SHOP, { shop_domain: SHOP });

    expect(audit.appendAudit).toHaveBeenCalledTimes(1);
    const entry = audit.appendAudit.mock.calls[0][0];
    expect(entry.action).toBe("GDPR_SHOP_REDACTED");
    expect(entry.subjectType).toBe("Shop");
    expect(entry.subjectId).toBe(SHOP);
    const tables = entry.payload.tables as Record<string, number>;
    expect(tables.SubscriptionContract).toBe(3);
    expect(tables.ContractLine).toBe(5);
    expect(tables.IdempotencyKey).toBe(4);
    // AuditLog is retained — it must not even appear in the purge manifest.
    expect(tables.AuditLog).toBeUndefined();

    // Audit strictly precedes the first delete.
    expect(audit.appendAudit.mock.invocationCallOrder[0]).toBeLessThan(
      firstCall(db.depletionEstimate.deleteMany),
    );
  });

  it("deletes child tables before their parents, inside one transaction", async () => {
    await handleShopRedact(SHOP, { shop_domain: SHOP });

    expect(db.$transaction).toHaveBeenCalledTimes(1);

    // DepletionEstimate → ContractLine → SubscriptionContract
    expect(firstCall(db.depletionEstimate.deleteMany)).toBeLessThan(
      firstCall(db.contractLine.deleteMany),
    );
    expect(firstCall(db.contractLine.deleteMany)).toBeLessThan(
      firstCall(db.subscriptionContract.deleteMany),
    );
    // Every other contract child precedes the contract delete.
    for (const child of [
      db.addOnItem,
      db.billingAttempt,
      db.dunningState,
      db.milestone,
    ]) {
      expect(firstCall(child.deleteMany)).toBeLessThan(
        firstCall(db.subscriptionContract.deleteMany),
      );
    }
    // SellingPlanConfigVersion → SellingPlanConfig
    expect(firstCall(db.sellingPlanConfigVersion.deleteMany)).toBeLessThan(
      firstCall(db.sellingPlanConfig.deleteMany),
    );
    // ExperimentAssignment → Experiment
    expect(firstCall(db.experimentAssignment.deleteMany)).toBeLessThan(
      firstCall(db.experiment.deleteMany),
    );
  });

  it("purges every shop-scoped table EXCEPT AuditLog", async () => {
    await handleShopRedact(SHOP, { shop_domain: SHOP });

    for (const swept of [
      db.session,
      db.shopSettings,
      db.staffRole,
      db.productMeta,
      db.analyticsEvent,
      db.outboundEvent,
      db.magicLinkToken,
      db.processedWebhook,
      db.forecastSnapshot,
      db.modelState,
    ]) {
      expect(swept.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    }
    expect(db.auditLog.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.update).not.toHaveBeenCalled();
  });

  it("sweeps IdempotencyKey rows by the embedded contract/add-on/session cuids", async () => {
    await handleShopRedact(SHOP, { shop_domain: SHOP });

    expect(db.idempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
    const { where } = db.idempotencyKey.deleteMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { key: { contains: "contract-cuid-1" } },
      { key: { contains: "addon-cuid-1" } },
      { key: { contains: "session-cuid-1" } },
    ]);
  });
});
