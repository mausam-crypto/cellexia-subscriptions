/**
 * Survey service behavior (service.server.ts, v1.21.0) over an in-memory DB
 * seam (the tokens.test.ts pattern): progressive answer merges, impression
 * vs answer semantics, contract linking with the deterministic holdout
 * assignment, and the one-shot survey.answered emission (per-order dedupe).
 */

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
