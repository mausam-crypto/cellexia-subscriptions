import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * SMS keyword RETRY (v1.28.0, P1.3): the texted "Retry now". Dispatches
 * before the ACTIVE-only matcher (FAILED contracts are exactly who needs
 * it), targets the newest ACTIVE/PAUSED/FAILED contract with a case, hands
 * off to requestCustomerRetry with actor "sms" (same guards as the portal
 * button and the RETRY_PAYMENT magic link), and replies per outcome. Every
 * inbound message keeps leaving its portal.sms_inbound trace.
 */

process.env.CRON_SECRET = "test-cron-secret";

const store = vi.hoisted(() => ({
  contracts: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  isSetupMode: vi.fn(async (_shopId: string): Promise<boolean> => false),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  requestCustomerRetry: vi.fn(async (_id: string, _o: unknown): Promise<unknown> => ({
    kind: "started",
    caseId: "case_1",
    reopened: false,
    inFlight: false,
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (args: { where: Record<string, unknown> }): Promise<unknown[]> => {
        const status = args.where.status as string | undefined;
        return store.contracts.filter(
          (c) => c.phone != null && (!status || c.status === status),
        );
      }),
    },
    dunningCase: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }): Promise<unknown> => {
        const contractId = args.where.contractId as string;
        const state = args.where.state as string | { in: string[] };
        const states = typeof state === "string" ? [state] : state.in;
        return (
          store.cases.find(
            (k) => k.contractId === contractId && states.includes(k.state as string),
          ) ?? null
        );
      }),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/shop/install.server", () => ({ getPrimaryShop: mocks.getPrimaryShop }));
vi.mock("~/lib/contracts/service.server", () => ({
  skipNextCycle: vi.fn(),
  delayNextCycle: vi.fn(),
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  requestCustomerRetry: mocks.requestCustomerRetry,
}));

import { action } from "~/routes/api.sms.inbound";
import { t } from "~/lib/i18n/i18n.server";

const PHONE = "+41 79 123 45 67";

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
    email: "a@example.com",
    locale: "en",
    status: "ACTIVE",
    phone: PHONE,
    isDemo: false,
    ownership: "OURS",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    shop: { domain: "cellexia.myshopify.com", ianaTimezone: "Europe/Zurich" },
    ...over,
  };
}

async function reply(keyword: string) {
  const res = await action({ request: post({ phone: PHONE, keyword }), params: {}, context: {} } as never);
  return { status: (res as Response).status, body: await (res as Response).json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contracts = [];
  store.cases = [];
  mocks.requestCustomerRetry.mockResolvedValue({ kind: "started", caseId: "case_1", reopened: false, inFlight: false });
});

describe("SMS RETRY", () => {
  it("routes to requestCustomerRetry with actor sms and replies with the started copy", async () => {
    store.contracts = [contractFixture()];
    store.cases = [{ id: "case_1", contractId: "c_1", state: "RETRYING" }];
    const { status, body } = await reply("RETRY please");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, message: t("en", "magic.sms.retry_done") });
    expect(mocks.requestCustomerRetry).toHaveBeenCalledWith("c_1", {
      source: "MAGIC_LINK",
      actor: "sms",
    });
    const audit = mocks.logEvent.mock.calls.map((c) => c[0] as { type: string; payload: Record<string, unknown> }).find((e) => e.type === "portal.sms_inbound");
    expect(audit?.payload).toMatchObject({ verb: "RETRY", outcome: "ok", matched: true });
  });

  it("targets a FAILED contract (the ACTIVE-only matcher would have said unknown phone) — the one WITH a case wins", async () => {
    store.contracts = [
      contractFixture({ id: "c_new", status: "ACTIVE", createdAt: new Date("2026-08-10T00:00:00Z") }),
      contractFixture({ id: "c_failed", status: "FAILED", createdAt: new Date("2026-07-01T00:00:00Z") }),
    ];
    store.cases = [{ id: "case_x", contractId: "c_failed", state: "EXHAUSTED" }];
    await reply("RETRY");
    expect(mocks.requestCustomerRetry).toHaveBeenCalledWith("c_failed", expect.anything());
  });

  it("replies per engine outcome: too_soon / challenge_pending / paused / none — never fires twice", async () => {
    store.contracts = [contractFixture()];
    for (const [outcome, key] of [
      [{ kind: "too_soon", caseId: "case_1", retryAgainAt: new Date() }, "magic.sms.retry_too_soon"],
      [{ kind: "unavailable", caseId: "case_1", reason: "challenge_pending" }, "magic.sms.retry_needs_bank"],
      [{ kind: "unavailable", caseId: null, reason: "contract_paused" }, "magic.sms.retry_paused"],
      [{ kind: "no_case" }, "magic.sms.retry_none"],
    ] as const) {
      mocks.requestCustomerRetry.mockResolvedValueOnce(outcome);
      const { status, body } = await reply("RETRY");
      expect(status).toBe(200);
      expect(body).toEqual({ ok: false, message: t("en", key) });
    }
    const refused = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "portal.sms_inbound" && e.payload.outcome === "refused");
    expect(refused).toHaveLength(4);
  });

  it("a lost atomic claim (concurrent request won it) reads as 'retrying now' — never 'nothing to retry' (v1.28.0 audit)", async () => {
    store.contracts = [contractFixture()];
    mocks.requestCustomerRetry.mockResolvedValueOnce({ kind: "unavailable", caseId: "case_1", reason: "claim_lost" });
    const { body } = await reply("RETRY");
    expect(body).toEqual({ ok: true, message: t("en", "magic.sms.retry_done") });
    // SETUP mode / permanent refusal / skipped cycle → the generic none copy.
    for (const reason of ["setup_mode", "refused", "cycle_skipped"] as const) {
      mocks.requestCustomerRetry.mockResolvedValueOnce({ kind: "unavailable", caseId: null, reason });
      const res = await reply("RETRY");
      expect(res.body).toEqual({ ok: false, message: t("en", "magic.sms.retry_none") });
    }
  });

  it("unknown phone (no ACTIVE/PAUSED/FAILED contract) → the standard unknown-phone reply, engine untouched", async () => {
    store.contracts = [contractFixture({ status: "CANCELLED" })];
    const { body } = await reply("RETRY");
    expect(body).toEqual({ ok: false, message: t("en", "magic.sms.unknown_phone") });
    expect(mocks.requestCustomerRetry).not.toHaveBeenCalled();
  });

  it("an engine throw is a 500 with the generic error copy (Klaviyo may retry; the engine is idempotent)", async () => {
    store.contracts = [contractFixture()];
    mocks.requestCustomerRetry.mockRejectedValueOnce(new Error("boom"));
    const { status, body } = await reply("RETRY");
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, message: t("en", "magic.sms.error") });
  });
});

describe("SMS SKIP / DELAY / UNDO in SETUP mode (v1.28.0 audit — launch gate)", () => {
  // Every other customer mutation surface (portal dispatcher, magic executor,
  // jobs) refuses while the store is in SETUP; the texted keywords are the
  // one path that could still edit a live Shopify schedule after an
  // emergency revertToSetup(). Refused BEFORE any lock/preparing read or
  // service call, audited with its own outcome, replied with the portal's
  // setup copy.
  it("refuses SKIP, DELAY and UNDO with the setup copy and never calls a service", async () => {
    store.contracts = [contractFixture()];
    mocks.isSetupMode.mockResolvedValue(true);
    const service = await import("~/lib/contracts/service.server");
    for (const verb of ["SKIP", "DELAY", "UNDO"]) {
      const { status, body } = await reply(verb);
      expect(status, verb).toBe(200);
      expect(body, verb).toEqual({ ok: false, message: t("en", "portal.setup.body") });
    }
    expect(mocks.isSetupMode).toHaveBeenCalledWith("shop_1");
    expect(service.skipNextCycle).not.toHaveBeenCalled();
    expect(service.delayNextCycle).not.toHaveBeenCalled();
    const audits = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "portal.sms_inbound" && e.payload.outcome === "setup_mode");
    expect(audits.map((a) => a.payload.verb)).toEqual(["SKIP", "DELAY", "UNDO"]);
    mocks.isSetupMode.mockResolvedValue(false);
  });

  it("STOP and RETRY are not gated here (opt-out; RETRY gates itself in the engine)", async () => {
    store.contracts = [contractFixture()];
    store.cases = [{ id: "case_1", contractId: "c_1", state: "RETRYING" }];
    mocks.isSetupMode.mockResolvedValue(true);
    await reply("RETRY");
    expect(mocks.requestCustomerRetry).toHaveBeenCalledTimes(1);
    expect(mocks.isSetupMode).not.toHaveBeenCalled();
    mocks.isSetupMode.mockResolvedValue(false);
  });
});
