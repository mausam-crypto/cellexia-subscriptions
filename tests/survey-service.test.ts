/**
 * Survey service behavior (service.server.ts, v1.21.0) over an in-memory DB
 * seam (the tokens.test.ts pattern): progressive answer merges, impression
 * vs answer semantics, contract linking with the deterministic holdout
 * assignment, and the one-shot survey.answered emission (per-order dedupe).
 */

import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface SurveyRow {
  id: string;
  shopId: string;
  orderId: string;
  contractId: string | null;
  customerId: string | null;
  source: string;
  locale: string | null;
  questionSetVersion: number;
  answers: unknown;
  shownAt: Date;
  answeredAt: Date | null;
  completedAt: Date | null;
  linkedAt: Date | null;
  emittedAt: Date | null;
}

interface ContractRow {
  id: string;
  shopId: string;
  originOrderId: string | null;
  customerId: string;
  email: string;
  isDemo: boolean;
  ownership: string;
  surveyHoldout: boolean | null;
}

const db = {
  surveys: new Map<string, SurveyRow>(),
  contracts: new Map<string, ContractRow>(),
  events: [] as Array<{ shopId: string; type: string; payload: Record<string, unknown> }>,
  nextId: 1,
};

vi.mock("~/db.server", () => {
  const client = {
    surveyResponse: {
      findUnique: async ({ where }: { where: { orderId?: string; id?: string } }) => {
        if (where.orderId) {
          return (
            [...db.surveys.values()].find((r) => r.orderId === where.orderId) ??
            null
          );
        }
        return db.surveys.get(where.id ?? "") ?? null;
      },
      create: async ({ data }: { data: Partial<SurveyRow> }) => {
        // Enforce the schema's orderId @unique like the real database: the
        // create race (impression beacon vs first tap) is only testable when
        // the loser actually gets its P2002.
        if (
          [...db.surveys.values()].some((r) => r.orderId === data.orderId)
        ) {
          throw new Prisma.PrismaClientKnownRequestError("unique violation", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: "SurveyResponse_orderId_key" },
          });
        }
        const row: SurveyRow = {
          id: `sr_${db.nextId++}`,
          shopId: data.shopId as string,
          orderId: data.orderId as string,
          contractId: null,
          customerId: data.customerId ?? null,
          source: data.source as string,
          locale: data.locale ?? null,
          questionSetVersion: data.questionSetVersion as number,
          answers: data.answers ?? null,
          shownAt: new Date(),
          answeredAt: data.answeredAt ?? null,
          completedAt: null,
          linkedAt: null,
          emittedAt: null,
        };
        db.surveys.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<SurveyRow> }) => {
        const row = db.surveys.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; contractId?: null; emittedAt?: null };
        data: Partial<SurveyRow>;
      }) => {
        // Null-claim semantics like the real DB: each null condition present
        // in the where must hold on the row or the update matches nothing.
        const row = db.surveys.get(where.id);
        if (!row) return { count: 0 };
        if ("contractId" in where && row.contractId !== where.contractId) {
          return { count: 0 };
        }
        if ("emittedAt" in where && row.emittedAt !== where.emittedAt) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      findMany: async (args?: {
        where?: {
          contractId?: null | { not: null };
          emittedAt?: null;
          answeredAt?: { not: null; lt: Date };
        };
      }) => {
        let rows = [...db.surveys.values()];
        const where = args?.where;
        if (where) {
          if (where.contractId === null) {
            rows = rows.filter((r) => r.contractId === null);
          } else if (where.contractId && "not" in where.contractId) {
            rows = rows.filter((r) => r.contractId !== null);
          }
          if ("emittedAt" in where && where.emittedAt === null) {
            rows = rows.filter((r) => r.emittedAt === null);
          }
          if (where.answeredAt) {
            rows = rows.filter(
              (r) =>
                r.answeredAt !== null &&
                r.answeredAt.getTime() < where.answeredAt!.lt.getTime(),
            );
          }
        }
        return rows;
      },
    },
    subscriptionContract: {
      findFirst: async ({ where }: { where: { originOrderId?: string } }) => {
        return (
          [...db.contracts.values()].find(
            (c) =>
              c.originOrderId === where.originOrderId &&
              !c.isDemo &&
              c.ownership === "OURS",
          ) ?? null
        );
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.contracts.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; surveyHoldout: null }; data: { surveyHoldout: boolean } }) => {
        const row = db.contracts.get(where.id);
        if (!row || row.surveyHoldout !== null) return { count: 0 };
        row.surveyHoldout = data.surveyHoldout;
        return { count: 1 };
      },
    },
    subscriberEvent: {
      findFirst: async ({
        where,
      }: {
        where: {
          type: string;
          payload?: { path: string[]; equals: unknown };
          AND?: { payload: { path: string[]; equals: unknown } };
        };
      }) => {
        // Honor every payload-path condition present (the mismatch-guard
        // query carries two: action AND orderId).
        const conds = [where.payload, where.AND?.payload].filter(
          (c): c is { path: string[]; equals: unknown } => Boolean(c),
        );
        const hit = db.events.find(
          (e) =>
            e.type === where.type &&
            conds.every((c) => e.payload[c.path[0]] === c.equals),
        );
        return hit ? { id: "evt_hit", createdAt: new Date() } : null;
      },
    },
  };
  return {
    default: {
      ...client,
      $transaction: async (fn: (tx: typeof client) => Promise<unknown>) =>
        fn(client),
    },
  };
});

const logEventImpl = async (input: {
  shopId: string;
  type: string;
  payload?: Record<string, unknown>;
}) => {
  db.events.push({
    shopId: input.shopId,
    type: input.type,
    payload: input.payload ?? {},
  });
};

vi.mock("~/lib/events/log.server", () => ({
  logEvent: async (input: { shopId: string; type: string; payload?: Record<string, unknown> }) =>
    logEventImpl(input),
  logEventOrThrow: async (input: { shopId: string; type: string; payload?: Record<string, unknown> }) =>
    logEventImpl(input),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: async () => ({ enabled: true, holdoutPct: 15, writesPerHour: 2000 }),
}));

import {
  getSurveyOrderStatus,
  linkSurveyForContract,
  maybeEmitAnswered,
  recordSurveyWrite,
  runSurveyLinkSweep,
  surveyHoldoutForContract,
} from "~/lib/survey/service.server";
import type { SubscriptionContract, SurveyResponse } from "@prisma/client";

const SHOP = "shop_1";
const ORDER = "gid://shopify/Order/1001";

beforeEach(() => {
  db.surveys.clear();
  db.contracts.clear();
  db.events.length = 0;
  db.nextId = 1;
});

describe("surveyHoldoutForContract", () => {
  it("is deterministic and respects the percentage bounds", () => {
    const a = surveyHoldoutForContract("contract_abc", 15);
    expect(surveyHoldoutForContract("contract_abc", 15)).toBe(a);
    expect(surveyHoldoutForContract("contract_abc", 0)).toBe(false);
    expect(surveyHoldoutForContract("contract_abc", 100)).toBe(true);
  });

  it("lands near the requested share over many contracts", () => {
    let held = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (surveyHoldoutForContract(`contract_${i}`, 15)) held += 1;
    }
    const pct = (held / n) * 100;
    expect(pct).toBeGreaterThan(11);
    expect(pct).toBeLessThan(19);
  });
});

describe("recordSurveyWrite", () => {
  it("impression creates a shown-not-answered row; answers merge progressively; completion stamps", async () => {
    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "THANK_YOU",
      answer: null,
    });
    const shown = [...db.surveys.values()][0];
    expect(shown.answeredAt).toBeNull();

    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "THANK_YOU",
      answer: { question: "plannedDuration", option: "permanent" },
    });
    expect(shown.answeredAt).not.toBeNull();
    expect(shown.completedAt).toBeNull();

    for (const [q, o] of [
      ["motive", "prevention"],
      ["expectedSpeed", "three_months_plus"],
      ["routine", "full"],
    ] as const) {
      await recordSurveyWrite(SHOP, {
        orderId: ORDER,
        source: "THANK_YOU",
        answer: { question: q, option: o },
      });
    }
    expect(shown.completedAt).not.toBeNull();
    expect(shown.answers).toEqual({
      plannedDuration: "permanent",
      motive: "prevention",
      expectedSpeed: "three_months_plus",
      routine: "full",
    });
  });

  it("REGRESSION: the impression-vs-first-tap create race loses no answer, in either arrival order", async () => {
    // Both writers read "no row" before either insert — the exact
    // interleaving of the confirmation-page beacon and the first tap, which
    // land within milliseconds on EVERY order. The unique orderId kills one
    // create with P2002; the loser must merge into the winner's row, never
    // surface a 500 the fail-quiet extension swallows.
    const impression = () =>
      recordSurveyWrite(SHOP, {
        orderId: ORDER,
        source: "THANK_YOU",
        answer: null,
      });
    const tap = () =>
      recordSurveyWrite(SHOP, {
        orderId: ORDER,
        source: "THANK_YOU",
        answer: { question: "plannedDuration", option: "permanent" },
      });

    // Simultaneous start = both see the empty table before either commits.
    await Promise.all([impression(), tap()]);
    expect(db.surveys.size).toBe(1);
    let row = [...db.surveys.values()][0];
    expect(row.answers).toEqual({ plannedDuration: "permanent" });
    expect(row.answeredAt).not.toBeNull();

    // Opposite arrival order (tap's create wins, impression loses).
    db.surveys.clear();
    await Promise.all([tap(), impression()]);
    expect(db.surveys.size).toBe(1);
    row = [...db.surveys.values()][0];
    expect(row.answers).toEqual({ plannedDuration: "permanent" });
    expect(row.answeredAt).not.toBeNull();
  });

  it("REGRESSION: an impression against an existing row never rewrites answers (no clobber window)", async () => {
    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "THANK_YOU",
      answer: { question: "plannedDuration", option: "permanent" },
    });
    const before = [...db.surveys.values()][0];
    const answersRef = before.answers;
    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "ORDER_STATUS",
      answer: null,
    });
    const after = [...db.surveys.values()][0];
    // Same object, untouched — the impression path may only fill customerId.
    expect(after.answers).toBe(answersRef);
    expect(after.answers).toEqual({ plannedDuration: "permanent" });
    expect(after.answeredAt).toBe(before.answeredAt);
  });

  it("a non-P2002 create failure still surfaces (fail-quiet must not hide real breakage)", async () => {
    db.surveys.clear();
    const dbModule = (await import("~/db.server")).default as {
      surveyResponse: { create: (args: unknown) => Promise<unknown> };
    };
    const realCreate = dbModule.surveyResponse.create;
    dbModule.surveyResponse.create = async () => {
      throw new Error("connection reset");
    };
    try {
      await expect(
        recordSurveyWrite(SHOP, {
          orderId: ORDER,
          source: "THANK_YOU",
          answer: null,
        }),
      ).rejects.toThrow("connection reset");
    } finally {
      dbModule.surveyResponse.create = realCreate;
    }
  });

  it("invalid answers are dropped by sanitization, never stored", async () => {
    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "THANK_YOU",
      answer: { question: "motive", option: "hacked_option" },
    });
    const row = [...db.surveys.values()][0];
    expect(row.answers).toEqual({});
  });

  it("links to an OURS contract when the mirror exists, assigns the holdout once, emits survey.answered once", async () => {
    db.contracts.set("c1", {
      id: "c1",
      shopId: SHOP,
      originOrderId: ORDER,
      customerId: "gid://shopify/Customer/9",
      email: "a@b.co",
      isDemo: false,
      ownership: "OURS",
      surveyHoldout: null,
    });

    for (const [q, o] of [
      ["plannedDuration", "trying"],
      ["motive", "occasion"],
      ["expectedSpeed", "days"],
      ["routine", "on_off"],
    ] as const) {
      await recordSurveyWrite(SHOP, {
        orderId: ORDER,
        source: "THANK_YOU",
        answer: { question: q, option: o },
      });
    }

    const row = [...db.surveys.values()][0];
    expect(row.contractId).toBe("c1");
    expect(db.contracts.get("c1")?.surveyHoldout).not.toBeNull();

    const answeredEvents = db.events.filter((e) => e.type === "survey.answered");
    expect(answeredEvents).toHaveLength(1);
    expect(answeredEvents[0].payload.survey_expected_speed).toBe("days");
    expect(typeof answeredEvents[0].payload.survey_holdout).toBe("boolean");
  });

  it("never links a FOREIGN or demo contract's order", async () => {
    db.contracts.set("cf", {
      id: "cf",
      shopId: SHOP,
      originOrderId: ORDER,
      customerId: "gid://shopify/Customer/9",
      email: "a@b.co",
      isDemo: false,
      ownership: "FOREIGN",
      surveyHoldout: null,
    });
    await recordSurveyWrite(SHOP, {
      orderId: ORDER,
      source: "ORDER_STATUS",
      answer: { question: "motive", option: "daily_care" },
    });
    const row = [...db.surveys.values()][0];
    expect(row.contractId).toBeNull();
    expect(db.events.filter((e) => e.type === "survey.answered")).toHaveLength(0);
  });
});

// ── v1.22.0 hardening ────────────────────────────────────────────────────────

function seedContract(over: Partial<ContractRow> = {}): ContractRow {
  const row: ContractRow = {
    id: "c1",
    shopId: SHOP,
    originOrderId: ORDER,
    customerId: "gid://shopify/Customer/9",
    email: "a@b.co",
    isDemo: false,
    ownership: "OURS",
    surveyHoldout: null,
    ...over,
  };
  db.contracts.set(row.id, row);
  return row;
}

function seedSurvey(over: Partial<SurveyRow> = {}): SurveyRow {
  const row: SurveyRow = {
    id: `sr_${db.nextId++}`,
    shopId: SHOP,
    orderId: ORDER,
    contractId: null,
    customerId: null,
    source: "THANK_YOU",
    locale: null,
    questionSetVersion: 1,
    answers: { plannedDuration: "permanent" },
    shownAt: new Date(),
    answeredAt: new Date(Date.now() - 2 * 3600_000),
    completedAt: null,
    linkedAt: null,
    emittedAt: null,
    ...over,
  };
  db.surveys.set(row.id, row);
  return row;
}

describe("REGRESSION: linkSurveyForContract identity guard (cross-customer poisoning)", () => {
  it("never links a row claimed by a different customer, and logs the guard once", async () => {
    const contract = seedContract();
    const row = seedSurvey({ customerId: "gid://shopify/Customer/666" });

    await linkSurveyForContract(
      row as unknown as SurveyResponse,
      contract as unknown as SubscriptionContract,
    );
    expect(db.surveys.get(row.id)?.contractId).toBeNull();
    expect(db.events.filter((e) => e.type === "survey.answered")).toHaveLength(0);

    // Second attempt (the daily sweep) must not spam a second guard event.
    await linkSurveyForContract(
      row as unknown as SurveyResponse,
      contract as unknown as SubscriptionContract,
    );
    const guards = db.events.filter(
      (e) => e.payload.action === "survey_link_customer_mismatch",
    );
    expect(guards).toHaveLength(1);
    expect(guards[0].payload.orderId).toBe(ORDER);
  });

  it("still links matching and guest (null-customerId) rows", async () => {
    const contract = seedContract();
    const row = seedSurvey({ customerId: contract.customerId });
    await linkSurveyForContract(
      row as unknown as SurveyResponse,
      contract as unknown as SubscriptionContract,
    );
    expect(db.surveys.get(row.id)?.contractId).toBe("c1");
  });
});

describe("REGRESSION: one-shot survey.answered emission (emittedAt claim)", () => {
  it("racing emitters produce exactly one event; the claim survives on the row", async () => {
    const contract = seedContract();
    const row = seedSurvey({
      contractId: "c1",
      answers: {
        plannedDuration: "permanent",
        motive: "prevention",
        expectedSpeed: "days",
        routine: "full",
      },
    });
    db.contracts.get("c1")!.surveyHoldout = false;

    const results = await Promise.all([
      maybeEmitAnswered(db.surveys.get(row.id) as unknown as SurveyResponse),
      maybeEmitAnswered(db.surveys.get(row.id) as unknown as SurveyResponse),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.events.filter((e) => e.type === "survey.answered")).toHaveLength(1);
    expect(db.surveys.get(row.id)?.emittedAt).not.toBeNull();
    void contract;
  });

  it("heals a pre-upgrade row (event exists, emittedAt null) without re-emitting", async () => {
    seedContract();
    const row = seedSurvey({
      contractId: "c1",
      answers: {
        plannedDuration: "permanent",
        motive: "prevention",
        expectedSpeed: "days",
        routine: "full",
      },
    });
    db.events.push({
      shopId: SHOP,
      type: "survey.answered",
      payload: { orderId: ORDER },
    });

    const emitted = await maybeEmitAnswered(
      db.surveys.get(row.id) as unknown as SurveyResponse,
    );
    expect(emitted).toBe(false);
    expect(db.surveys.get(row.id)?.emittedAt).not.toBeNull();
    expect(db.events.filter((e) => e.type === "survey.answered")).toHaveLength(1);
  });
});

describe("REGRESSION: sweep partial-answer pass cannot be starved by emitted rows", () => {
  it("only scans rows still owing their event and flushes stale partials", async () => {
    seedContract();
    // An already-emitted row (would previously occupy the take() window)…
    seedSurvey({
      orderId: "gid://shopify/Order/9001",
      contractId: "c1",
      emittedAt: new Date(),
    });
    // …and a stale linked partial still owing its event.
    const owed = seedSurvey({
      orderId: "gid://shopify/Order/9002",
      contractId: "c1",
      answers: { motive: "prevention" },
    });

    const stats = await runSurveyLinkSweep(SHOP, new Date());
    expect(stats.emitted).toBe(1);
    expect(db.surveys.get(owed.id)?.emittedAt).not.toBeNull();
    const events = db.events.filter((e) => e.type === "survey.answered");
    expect(events).toHaveLength(1);
    expect(events[0].payload.orderId).toBe("gid://shopify/Order/9002");
    expect(events[0].payload.survey_completed).toBe(false);
  });
});

describe("REGRESSION: getSurveyOrderStatus hides another customer's answers", () => {
  it("returns the empty shape to a provably different customer, the answers to the owner", async () => {
    seedSurvey({
      customerId: "gid://shopify/Customer/9",
      completedAt: new Date(),
    });

    const foreign = await getSurveyOrderStatus(
      SHOP,
      ORDER,
      "gid://shopify/Customer/666",
    );
    expect(foreign.answered).toEqual({});
    expect(foreign.completed).toBe(false);

    const owner = await getSurveyOrderStatus(
      SHOP,
      ORDER,
      "gid://shopify/Customer/9",
    );
    expect(owner.answered).toEqual({ plannedDuration: "permanent" });
    expect(owner.completed).toBe(true);
  });
});
