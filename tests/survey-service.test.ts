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

vi.mock("~/db.server", () => ({
  default: {
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
      updateMany: async ({ where, data }: { where: { id: string; contractId: null }; data: Partial<SurveyRow> }) => {
        const row = db.surveys.get(where.id);
        if (!row || row.contractId !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findMany: async () => [...db.surveys.values()],
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
      findFirst: async ({ where }: { where: { type: string; payload: { equals: unknown } } }) => {
        const orderId = where.payload.equals;
        return (
          db.events.find(
            (e) => e.type === where.type && e.payload.orderId === orderId,
          ) ?? null
        );
      },
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: async (input: { shopId: string; type: string; payload?: Record<string, unknown> }) => {
    db.events.push({
      shopId: input.shopId,
      type: input.type,
      payload: input.payload ?? {},
    });
  },
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: async () => ({ enabled: true, holdoutPct: 15, writesPerHour: 2000 }),
}));

import {
  recordSurveyWrite,
  surveyHoldoutForContract,
} from "~/lib/survey/service.server";

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
