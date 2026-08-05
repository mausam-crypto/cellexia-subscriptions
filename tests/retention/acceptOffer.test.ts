/**
 * acceptOffer I/O-seam tests — the claim → idempotent-execute →
 * release-on-error protocol behind the double-concession fix. The core money
 * invariant under test: ONE accepted offer executes EXACTLY ONE concession,
 * no matter how bookkeeping blips, retries and double-submits interleave.
 *
 *  - A bookkeeping (audit/event) failure AFTER the committed concession must
 *    NOT release the idempotency key or revert the session — a customer
 *    retry replays instead of granting a second credit / second skipped
 *    cycle / doubled delay.
 *  - A pre-commit execution failure releases the claim AND the key so the
 *    customer can retry cleanly.
 *  - A lost compare-and-set claim (concurrent accept) returns the winner's
 *    session without ever entering the idempotent block.
 *  - EDUCATION acknowledgements are keyed on report CONTENT, so a new report
 *    after an ack wipe records a second analytics event instead of replaying.
 *
 * Hermetic: prisma, audit, events, idempotency (stateful Map with
 * release-on-error, mirroring the production contract) and the core contract
 * helpers are all mocked — the pattern of tests/offers/addOnFulfillment.test.ts.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cancellationSession: {
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  subscriptionContract: { findUniqueOrThrow: vi.fn(), findFirst: vi.fn() },
  contractLine: { findFirst: vi.fn(), findMany: vi.fn() },
  productMeta: { findMany: vi.fn() },
  shopSettings: { findUnique: vi.fn() },
  addOnItem: { create: vi.fn() },
  analyticsEvent: { create: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

// Stateful withIdempotency stand-in mirroring production: first caller runs
// fn and stores the result, repeats replay it, and a THROWING fn releases
// the key (release-on-error) so a retry can run again.
const idem = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  keys: [] as string[],
}));
vi.mock("~/services/idempotency.server", () => ({
  withIdempotency: vi.fn(
    async (key: string, _scope: string, fn: () => Promise<unknown>) => {
      idem.keys.push(key);
      if (idem.store.has(key)) {
        return { result: idem.store.get(key), replayed: true };
      }
      try {
        const result = await fn();
        idem.store.set(key, result);
        return { result, replayed: false };
      } catch (e) {
        idem.store.delete(key);
        throw e;
      }
    },
  ),
}));

const core = vi.hoisted(() => {
  class KeepOneLineError extends Error {
    constructor(message = "keep one line") {
      super(message);
      this.name = "KeepOneLineError";
    }
  }
  return {
    KeepOneLineError,
    applyAccountCredit: vi.fn(),
    cancelContract: vi.fn(),
    delayByWeeks: vi.fn(),
    getVariantInfo: vi.fn(),
    pauseUntil: vi.fn(),
    removeLineFromContract: vi.fn(),
    skipNextShipment: vi.fn(),
    swapLineVariant: vi.fn(),
    switchCadence: vi.fn(),
    updateLineQuantity: vi.fn(),
  };
});
vi.mock("~/services/core/contracts.server", () => core);

vi.mock("~/services/analytics/costModel.server", () => ({
  getCostModel: vi.fn(),
  metaByProductId: vi.fn(async () => new Map()),
  orderContribution: vi.fn(() => ({ contributionFraction: 0.5 })),
}));

vi.mock("~/services/retention/saveOffers.server", () => ({
  buildOffersForReason: vi.fn(() => []),
  maxRationalSaveCostCents: vi.fn((p: number, c: number) => Math.floor(p * c)),
  orderValueCents: vi.fn(() => 0),
}));

import { OfferChoiceError, acceptOffer } from "~/services/retention/cancellation.server";
import type { SaveOffer } from "~/types/domain";

const SHOP = "cellexia-demo.myshopify.com";
const SESSION_ID = "s1";
const SAVE_KEY = "cancel-save:s1:CHANGE_DELIVERY_DATE";
const graphqlStub = (() => {}) as never;

const skipOffer: SaveOffer = {
  type: "CHANGE_DELIVERY_DATE",
  title: "Skip your next delivery",
  description: "d",
  costCents: 0,
  params: { action: "SKIP_NEXT" },
};

const removeOffer: SaveOffer = {
  type: "REMOVE_ITEM",
  title: "Remove a product",
  description: "d",
  costCents: 0,
  params: {
    suggestedLineId: "l2",
    lineOptions: [
      { lineId: "l1", title: "Serum" },
      { lineId: "l2", title: "Cream" },
    ],
  },
};

const educationOffer: SaveOffer = {
  type: "EDUCATION",
  title: "Talk to our care team",
  description: "d",
  costCents: 0,
  params: { collectDetails: true, route: "CUSTOMER_CARE" },
};

// Mutable session row backing the stateful prisma mock.
let sessionRow: Record<string, unknown>;

function seedSession(offers: SaveOffer[]) {
  sessionRow = {
    id: SESSION_ID,
    shop: SHOP,
    contractId: "c1",
    outcome: "IN_PROGRESS",
    reason: "TOO_MUCH_PRODUCT",
    reasonDetail: null,
    savedByOffer: null,
    saveCostCents: null,
    resolvedAt: null,
    maxSaveCostCents: 5000,
    offersJson: JSON.stringify(offers),
    startedAt: new Date("2026-08-02T10:00:00.000Z"),
  };
}

function detailsHash(details: string): string {
  return createHash("sha256").update(details).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drop implementations — the bookkeeping-failure
  // test's persistent mockRejectedValue on appendAudit would otherwise leak
  // into every later test in the file.
  audit.appendAudit.mockReset();
  idem.store.clear();
  idem.keys.length = 0;
  seedSession([skipOffer]);

  db.cancellationSession.findUniqueOrThrow.mockImplementation(async () => ({
    ...sessionRow,
  }));
  db.cancellationSession.findFirst.mockResolvedValue(null);
  db.cancellationSession.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(sessionRow, data);
      return { ...sessionRow };
    },
  );
  // Compare-and-set semantics: the write only lands when the row still
  // matches every guarded column, exactly like updateMany on SQLite.
  db.cancellationSession.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (where.id !== sessionRow.id) return { count: 0 };
      if ("outcome" in where && sessionRow.outcome !== where.outcome) {
        return { count: 0 };
      }
      if (
        "savedByOffer" in where &&
        sessionRow.savedByOffer !== where.savedByOffer
      ) {
        return { count: 0 };
      }
      Object.assign(sessionRow, data);
      return { count: 1 };
    },
  );
  db.subscriptionContract.findUniqueOrThrow.mockResolvedValue({
    id: "c1",
    shop: SHOP,
    shopifyCustomerId: "gid://shopify/Customer/9",
    customerEmail: "marie@example.com",
    status: "ACTIVE",
  });
  db.analyticsEvent.create.mockResolvedValue({});
  core.skipNextShipment.mockResolvedValue({ id: "c1" });
  core.removeLineFromContract.mockResolvedValue({ id: "c1" });
});

describe("acceptOffer — bookkeeping failure after the committed concession", () => {
  it("REGRESSION: keeps the claim and the idempotency key; a customer retry never re-executes", async () => {
    audit.appendAudit.mockRejectedValue(
      new Error("appendAudit: could not acquire audit sequence"),
    );

    // First accept: the concession commits, bookkeeping blows up — swallowed.
    const saved = await acceptOffer(
      graphqlStub,
      SESSION_ID,
      "CHANGE_DELIVERY_DATE",
    );

    expect(saved.outcome).toBe("SAVED");
    expect(core.skipNextShipment).toHaveBeenCalledTimes(1);
    // The session was NOT reverted and the key was NOT released.
    expect(sessionRow.outcome).toBe("SAVED");
    expect(sessionRow.savedByOffer).toBe("CHANGE_DELIVERY_DATE");
    expect(idem.store.has(SAVE_KEY)).toBe(true);

    // Double-submit / lost-response retry: the SAVED session short-circuits
    // (or the stored result replays) — the invariant is SINGLE EXECUTION.
    const replayed = await acceptOffer(
      graphqlStub,
      SESSION_ID,
      "CHANGE_DELIVERY_DATE",
    );

    expect(replayed.outcome).toBe("SAVED");
    expect(replayed.savedByOffer).toBe("CHANGE_DELIVERY_DATE");
    expect(core.skipNextShipment).toHaveBeenCalledTimes(1);
  });
});

describe("acceptOffer — pre-commit execution failure", () => {
  it("releases the claim AND the key, and a retry executes exactly once more", async () => {
    core.skipNextShipment.mockRejectedValueOnce(new Error("shopify down"));

    await expect(
      acceptOffer(graphqlStub, SESSION_ID, "CHANGE_DELIVERY_DATE"),
    ).rejects.toThrow("shopify down");

    // Claim released: outcome back to IN_PROGRESS with the save columns
    // nulled, and the idempotency key gone (release-on-error).
    expect(sessionRow.outcome).toBe("IN_PROGRESS");
    expect(sessionRow.savedByOffer).toBeNull();
    expect(sessionRow.saveCostCents).toBeNull();
    expect(sessionRow.resolvedAt).toBeNull();
    expect(idem.store.has(SAVE_KEY)).toBe(false);

    // Retry succeeds and executes the concession exactly once more.
    const saved = await acceptOffer(
      graphqlStub,
      SESSION_ID,
      "CHANGE_DELIVERY_DATE",
    );

    expect(saved.outcome).toBe("SAVED");
    expect(core.skipNextShipment).toHaveBeenCalledTimes(2);
    expect(idem.store.has(SAVE_KEY)).toBe(true);
  });
});

describe("acceptOffer — lost compare-and-set claim", () => {
  it("returns the concurrent winner's session without entering the idempotent block", async () => {
    // A concurrent accept resolves the session between our read and our CAS.
    db.cancellationSession.updateMany.mockImplementationOnce(async () => {
      sessionRow.outcome = "SAVED";
      sessionRow.savedByOffer = "CHANGE_DELIVERY_DATE";
      return { count: 0 };
    });

    const result = await acceptOffer(
      graphqlStub,
      SESSION_ID,
      "CHANGE_DELIVERY_DATE",
    );

    expect(result.outcome).toBe("SAVED");
    expect(core.skipNextShipment).not.toHaveBeenCalled();
    expect(idem.keys).not.toContain(SAVE_KEY);
  });

  it("throws already-resolved when the winner saved a DIFFERENT offer", async () => {
    db.cancellationSession.updateMany.mockImplementationOnce(async () => {
      sessionRow.outcome = "SAVED";
      sessionRow.savedByOffer = "TEMPORARY_PAUSE";
      return { count: 0 };
    });

    await expect(
      acceptOffer(graphqlStub, SESSION_ID, "CHANGE_DELIVERY_DATE"),
    ).rejects.toThrow(/already resolved/);
    expect(core.skipNextShipment).not.toHaveBeenCalled();
  });
});

describe("acceptOffer — REMOVE_LINE surfaces the keepOne guard as a friendly re-pick", () => {
  it("passes keepOne, maps KeepOneLineError to OfferChoiceError and releases the claim", async () => {
    seedSession([removeOffer]);
    core.removeLineFromContract.mockRejectedValueOnce(
      new core.KeepOneLineError(),
    );

    await expect(
      acceptOffer(graphqlStub, SESSION_ID, "REMOVE_ITEM"),
    ).rejects.toBeInstanceOf(OfferChoiceError);

    expect(core.removeLineFromContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      "l2",
      { keepOne: true },
    );
    // The refused save must not stick: claim and key both released.
    expect(sessionRow.outcome).toBe("IN_PROGRESS");
    expect(idem.store.has("cancel-save:s1:REMOVE_ITEM")).toBe(false);
  });
});

describe("acceptOffer — EDUCATION ack is keyed on report content", () => {
  it("REGRESSION: a second, DIFFERENT report after an ack wipe records a second analytics event", async () => {
    seedSession([educationOffer]);
    const originalOffersJson = sessionRow.offersJson;

    await acceptOffer(graphqlStub, SESSION_ID, "EDUCATION", {
      details: "Redness around the eyes after day 3",
    });

    const hash1 = detailsHash("Redness around the eyes after day 3");
    expect(idem.keys).toContain(`cancel-edu:s1:${hash1}`);
    expect(db.analyticsEvent.create).toHaveBeenCalledTimes(1);
    expect(db.analyticsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `care-followup:s1:${hash1}`,
        }),
      }),
    );

    // An offers recompute wiped the ack (e.g. a reason switch on an older
    // build); the customer re-submits an UPDATED report. OLD BUG: the
    // session-scoped key replayed, persisted nothing, blocked the ops-feed
    // event — and still showed "our care team is on it".
    sessionRow.offersJson = originalOffersJson;
    await acceptOffer(graphqlStub, SESSION_ID, "EDUCATION", {
      details: "It spread to the neck since my last report",
    });

    const hash2 = detailsHash("It spread to the neck since my last report");
    expect(hash2).not.toBe(hash1);
    expect(idem.keys).toContain(`cancel-edu:s1:${hash2}`);
    expect(db.analyticsEvent.create).toHaveBeenCalledTimes(2);
    expect(db.analyticsEvent.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `care-followup:s1:${hash2}`,
        }),
      }),
    );
    // The session stays open either time — EDUCATION never resolves SAVED.
    expect(sessionRow.outcome).toBe("IN_PROGRESS");
  });

  it("an IDENTICAL double-submit still replays harmlessly", async () => {
    seedSession([educationOffer]);

    await acceptOffer(graphqlStub, SESSION_ID, "EDUCATION", {
      details: "Redness around the eyes after day 3",
    });
    await acceptOffer(graphqlStub, SESSION_ID, "EDUCATION", {
      details: "Redness around the eyes after day 3",
    });

    expect(db.analyticsEvent.create).toHaveBeenCalledTimes(1);
  });
});
