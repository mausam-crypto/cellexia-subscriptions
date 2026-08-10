import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * INBOUND SMS — the STOP opt-out writer and the audit-first rule.
 *
 * Two audit findings share this route:
 *  - WinbackState.OPTED_OUT was a dead state: the engine guarded on it
 *    ("never re-engage") but no code path anywhere wrote it. STOP now flips
 *    every ACTIVE campaign for the matched customer(s) to OPTED_OUT
 *    (+ optedOutAt, touch cleared) and logs winback.opted_out — and it
 *    matches phones across ANY contract status, because win-back texts go to
 *    CANCELLED subscribers the ACTIVE-only matcher cannot see.
 *  - Rejected intents (unknown phone / unknown keyword) left zero trace.
 *    Every inbound message now logs portal.sms_inbound with outcome, hashed
 *    phone + last 4 digits, and a capped keyword excerpt — never the raw
 *    number or full free text.
 *
 * Drives the REAL action with real i18n; replies must stay byte-identical
 * to the pre-audit responses on every pre-existing path.
 */

process.env.CRON_SECRET = "test-cron-secret";

const store = vi.hoisted(() => ({
  contracts: [] as Array<Record<string, unknown>>,
  winbackStates: [] as Array<Record<string, unknown>>,
  winbackUpdates: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: null,
  })),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: null,
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    // Plan lock window (v1.13.0): the SKIP/DELAY gate reads the contract's
    // lock inputs and the shop's lock rules; nothing is locked here.
    sellingPlanConfig: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
        }): Promise<unknown[]> => {
          // handleStop's second query selects the customer's contracts.
          const customerIn = (
            args.where.customerId as { in?: string[] } | undefined
          )?.in;
          if (customerIn) {
            return store.contracts.filter((c) =>
              customerIn.includes(c.customerId as string),
            );
          }
          // Phone-candidate scan — honor the status filter when present.
          const status = args.where.status as string | undefined;
          return store.contracts.filter(
            (c) => c.phone != null && (!status || c.status === status),
          );
        },
      ),
    },
    winbackState: {
      findMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
        }): Promise<unknown[]> => {
          const contractIn = (
            args.where.contractId as { in?: string[] } | undefined
          )?.in;
          return store.winbackStates.filter(
            (s) =>
              (!contractIn || contractIn.includes(s.contractId as string)) &&
              s.status === args.where.status,
          );
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: { in: string[] } };
          data: Record<string, unknown>;
        }): Promise<{ count: number }> => {
          store.winbackUpdates.push(args.data);
          const hit = store.winbackStates.filter((s) =>
            args.where.id.in.includes(s.id as string),
          );
          for (const s of hit) Object.assign(s, args.data);
          return { count: hit.length };
        },
      ),
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  skipNextCycle: mocks.skipNextCycle,
  delayNextCycle: mocks.delayNextCycle,
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));

import { action } from "~/routes/api.sms.inbound";
import { t } from "~/lib/i18n/i18n.server";

const PHONE = "+41 79 123 45 67";
const DIGITS = "41791234567";

function post(body: Record<string, unknown>): Request {
  return new Request("https://app.example/api/sms/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cellexia-secret": "test-cron-secret",
    },
    body: JSON.stringify(body),
  });
}

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    phone: PHONE,
    locale: "en",
    status: "CANCELLED",
    ownership: "OURS",
    isDemo: false,
    shop: { domain: "cellexia.myshopify.com", ianaTimezone: "Europe/Zurich" },
    ...over,
  };
}

function events(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

async function run(body: Record<string, unknown>): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const res = (await action({
    request: post(body),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contracts = [];
  store.winbackStates = [];
  store.winbackUpdates = [];
});

// ── STOP: the OPTED_OUT writer ──────────────────────────────────────────────

describe("STOP", () => {
  it("flips the cancelled subscriber's ACTIVE campaign to OPTED_OUT and logs winback.opted_out", async () => {
    store.contracts = [contractFixture()];
    store.winbackStates = [
      {
        id: "wb_1",
        contractId: "c_1",
        shopId: "shop_1",
        stage: 1,
        status: "ACTIVE",
        nextTouchAt: new Date(),
      },
    ];

    const { status, json } = await run({ phone: PHONE, keyword: "STOP" });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.message).toBe(t("en", "magic.sms.stop_done"));

    expect(store.winbackUpdates).toHaveLength(1);
    expect(store.winbackUpdates[0]).toMatchObject({
      status: "OPTED_OUT",
      nextTouchAt: null,
    });
    expect(store.winbackUpdates[0].optedOutAt).toBeInstanceOf(Date);
    expect(store.winbackStates[0].status).toBe("OPTED_OUT");

    const optedOut = events("winback.opted_out");
    expect(optedOut).toHaveLength(1);
    expect(optedOut[0].contractId).toBe("c_1");
    expect(optedOut[0].payload).toMatchObject({
      stateId: "wb_1",
      stage: 1,
      via: "sms_stop",
    });

    const audit = events("portal.sms_inbound");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ verb: "STOP", outcome: "ok" });
  });

  it("matches CANCELLED contracts — the win-back audience the ACTIVE-only matcher cannot see", async () => {
    // Same fixture, but assert the reply is NOT unknown_phone (the pre-fix
    // behavior for a cancelled subscriber texting STOP).
    store.contracts = [contractFixture({ status: "CANCELLED" })];

    const { json } = await run({ phone: PHONE, keyword: "STOP please" });

    expect(json.message).not.toBe(t("en", "magic.sms.unknown_phone"));
    expect(json.ok).toBe(true);
  });

  it("confirms even with no ACTIVE campaign (the customer asked to stop) — no phantom event", async () => {
    store.contracts = [contractFixture()];
    store.winbackStates = []; // nothing scheduled

    const { json } = await run({ phone: PHONE, keyword: "STOP" });

    expect(json.ok).toBe(true);
    expect(store.winbackUpdates).toHaveLength(0);
    expect(events("winback.opted_out")).toHaveLength(0);
    expect(events("portal.sms_inbound")[0]?.payload).toMatchObject({
      outcome: "ok",
    });
  });

  it("unknown phone still answers unknown_phone, with an audit trace", async () => {
    const { json } = await run({ phone: "+15550001111", keyword: "STOP" });

    expect(json.ok).toBe(false);
    expect(json.message).toBe(t("en", "magic.sms.unknown_phone"));
    const audit = events("portal.sms_inbound");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      outcome: "unknown_phone",
      matched: false,
    });
  });
});

// ── Audit-first for every other path ────────────────────────────────────────

describe("portal.sms_inbound audit", () => {
  it("unknown keyword: response unchanged, keyword excerpt + hashed phone recorded", async () => {
    store.contracts = [contractFixture({ status: "ACTIVE" })];

    const { status, json } = await run({
      phone: PHONE,
      keyword: "PAUSE my subscription for a bit please",
    });

    expect(status).toBe(200);
    expect(json).toEqual({
      ok: false,
      message: t("en", "magic.sms.unknown_keyword"),
    });

    const audit = events("portal.sms_inbound");
    expect(audit).toHaveLength(1);
    expect(audit[0].contractId).toBe("c_1");
    const payload = audit[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      verb: "PAUSE", // first word only — never the full free text
      outcome: "unknown_keyword",
      phoneLast4: DIGITS.slice(-4),
      matched: true,
    });
    expect(payload.phoneHash).toBe(
      createHash("sha256").update(DIGITS).digest("hex"),
    );
    // Privacy: the raw number never enters the event stream.
    expect(JSON.stringify(payload)).not.toContain("123 45 67");
  });

  it("unknown phone (non-STOP): audited against the primary shop", async () => {
    const { json } = await run({ phone: "+15550001111", keyword: "SKIP" });

    expect(json.ok).toBe(false);
    const audit = events("portal.sms_inbound");
    expect(audit).toHaveLength(1);
    expect(audit[0].shopId).toBe("shop_1");
    expect(audit[0].payload).toMatchObject({
      verb: "SKIP",
      outcome: "unknown_phone",
    });
  });

  it("successful SKIP is audited ok", async () => {
    store.contracts = [contractFixture({ status: "ACTIVE" })];

    const { json } = await run({ phone: PHONE, keyword: "SKIP" });

    expect(json.ok).toBe(true);
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
    expect(events("portal.sms_inbound")[0]?.payload).toMatchObject({
      verb: "SKIP",
      outcome: "ok",
    });
  });

  it("a service failure is audited as error (response unchanged: 500)", async () => {
    store.contracts = [contractFixture({ status: "ACTIVE" })];
    mocks.skipNextCycle.mockRejectedValueOnce(new Error("shopify down"));

    const { status } = await run({ phone: PHONE, keyword: "SKIP" });

    expect(status).toBe(500);
    expect(events("portal.sms_inbound")[0]?.payload).toMatchObject({
      outcome: "error",
    });
  });

  it("an audit failure never changes the reply", async () => {
    store.contracts = [contractFixture({ status: "ACTIVE" })];
    mocks.logEvent.mockRejectedValue(new Error("event store down"));

    const { status, json } = await run({ phone: PHONE, keyword: "SKIP" });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});
