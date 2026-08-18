import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal Undo (v1.28.0, P2.2) — undo.server.ts, the `undo` portal action and
 * the SMS UNDO keyword.
 *
 *  - performUndo restores the previous value stored in the action's spec:
 *    a one-cycle delay via revertDelayedCycle (cycle edit back), a
 *    re-anchor delay / next-date change via setNextBillingDate, a frequency
 *    change via changeFrequency(previous) + the previous date;
 *  - stale (the contract no longer sits at the action's after-state) and
 *    past (the previous date already went by) restore NOTHING;
 *  - every branch logs portal.undo { action, outcome };
 *  - the signed token expires with the window (portal.magicLinkTtlDays) and
 *    is bound to shop + contract + customer;
 *  - the `undo` portal action: token → performUndo → toast undone (with the
 *    restored date) / undo_expired / undo_stale; tampered token → error;
 *  - SMS UNDO reverses the newest customer-made undoable event within the
 *    window (from its own payload), answers "nothing to undo" when the last
 *    thing that happened was itself an undo, and "can't be undone" when the
 *    schedule moved on.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-undo";
process.env.CRON_SECRET = "test-cron-secret";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const NOW = new Date("2026-08-17T10:00:00.000Z");
const PREV = new Date("2026-09-07T22:00:00.000Z"); // Sep 8 Zurich
const NEXT = new Date("2026-09-14T22:00:00.000Z"); // Sep 15 Zurich
const PHONE = "+41 79 123 45 67";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  const contract: Record<string, unknown> = {};
  return {
    shop,
    contract,
    logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
    subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    setNextBillingDate: vi.fn(async (_s: string, _id: string, date: Date) => ({
      ...contract,
      nextBillingDate: date,
    })),
    revertDelayedCycle: vi.fn(async (_s: string, _id: string, date: Date) => ({
      ...contract,
      nextBillingDate: date,
    })),
    changeFrequency: vi.fn(async (_s: string, _id: string, f: { unit: string; count: number }) => ({
      ...contract,
      billingIntervalUnit: f.unit,
      billingIntervalCount: f.count,
      // Shopify moved the date back by the removed slack (6w → 4w = -2w).
      nextBillingDate: PREV,
    })),
    delayNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: NEXT })),
    delaySchedule: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: NEXT })),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(async () => ({ id: mocks.shop.id })) },
    portalSession: { findUnique: vi.fn(async () => null) },
    subscriptionContract: {
      findFirst: vi.fn(async (): Promise<unknown> => mocks.contract),
      findUnique: vi.fn(async (): Promise<unknown> => mocks.contract),
      findMany: vi.fn(async (): Promise<unknown[]> =>
        mocks.contract.phone ? [{ ...mocks.contract, shop: mocks.shop }] : [],
      ),
    },
    sellingPlanConfig: { findMany: vi.fn(async () => []) },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
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
        magicLinkTtlDays: 14,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        friendlyLockMessaging: false,
        delayReanchors: true,
      };
    }
    return {};
  }),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/contracts/service.server", () => ({
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: mocks.changeFrequency,
  changeLineQuantity: vi.fn(),
  delayNextCycle: mocks.delayNextCycle,
  delaySchedule: mocks.delaySchedule,
  pauseContract: vi.fn(),
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  revertDelayedCycle: mocks.revertDelayedCycle,
  setNextBillingDate: mocks.setNextBillingDate,
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: vi.fn(),
}));
vi.mock("~/lib/winback/engine.server", () => ({ reactivateFromWinback: vi.fn() }));
vi.mock("~/lib/graphql/index.server", () => ({}));
vi.mock("~/lib/portal/catalog.server", () => ({
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }, { unit: "WEEK", count: 6 }],
    allowChoice: true,
  })),
}));
vi.mock("~/lib/payments/cardUpdate.server", () => ({ resolveCardUpdatePath: vi.fn() }));
vi.mock("~/lib/dunning/engine.server", () => ({ requestCustomerRetry: vi.fn() }));
vi.mock("~/lib/portal/dunning.server", () => ({
  loadPortalDunning: vi.fn(),
  findPortalDunningCase: vi.fn(async () => null),
}));
vi.mock("~/lib/portal/threeds.server", () => ({ resolvePortalThreeDs: vi.fn() }));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { action as smsAction } from "~/routes/api.sms.inbound";
import { getPortalSession } from "~/lib/portal/session.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import {
  mintUndoToken,
  performUndo,
  readUndoToken,
  undoSpecFromEvent,
  undoWindowSeconds,
  type UndoSpec,
} from "~/lib/portal/undo.server";
import { TOAST_KEYS } from "~/lib/portal/layout.server";
import en from "../app/lib/i18n/locales/en.json";

const BINDING = {
  shopId: "shop_1",
  contractId: "ctr_1",
  customerId: "gid://shopify/Customer/1",
};

function baseContract() {
  return {
    id: "ctr_1",
    lockDays: 0,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    phone: null as string | null,
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: NEXT,
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
    lines: [],
  };
}

function undoEvents() {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === "portal.undo");
}

const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer", via: "portal" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  delete process.env.PORTAL_COOKIE_DEV;
  Object.keys(mocks.contract).forEach((k) => delete mocks.contract[k]);
  Object.assign(mocks.contract, baseContract());
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── performUndo ──────────────────────────────────────────────────────────────

describe("performUndo", () => {
  const delayOnce: UndoSpec = {
    kind: "delay",
    mode: "once",
    previousNextBillingDate: PREV.toISOString(),
    nextBillingDate: NEXT.toISOString(),
  };

  it("one-cycle delay → revertDelayedCycle back to the previous date (never a re-anchor)", async () => {
    const out = await performUndo(SHOP_DOMAIN, mocks.contract as never, delayOnce, OPTS);
    expect(out.kind).toBe("restored");
    expect(mocks.revertDelayedCycle).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", PREV, {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(undoEvents().map((e) => e.payload)).toEqual([
      expect.objectContaining({ action: "delay", outcome: "restored", mode: "once", via: "portal" }),
    ]);
  });

  it("re-anchor delay and next_date → setNextBillingDate(previous)", async () => {
    await performUndo(SHOP_DOMAIN, mocks.contract as never, { ...delayOnce, mode: "reanchor" }, OPTS);
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", PREV, expect.anything());
    expect(mocks.revertDelayedCycle).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const out = await performUndo(
      SHOP_DOMAIN,
      mocks.contract as never,
      { kind: "next_date", previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString() },
      OPTS,
    );
    expect(out).toMatchObject({ kind: "restored", nextBillingDate: PREV });
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    expect(undoEvents()[0].payload).toMatchObject({ action: "next_date", outcome: "restored" });
  });

  it("frequency → changeFrequency(previous cadence), then the previous date when the cadence restore did not land there", async () => {
    Object.assign(mocks.contract, {
      billingIntervalUnit: "WEEK",
      billingIntervalCount: 6,
      intervalWeeks: 6,
      nextBillingDate: new Date("2026-09-21T22:00:00.000Z"),
    });
    const spec: UndoSpec = {
      kind: "frequency",
      oldUnit: "WEEK",
      oldCount: 4,
      newUnit: "WEEK",
      newCount: 6,
      previousNextBillingDate: PREV.toISOString(),
      nextBillingDate: "2026-09-21T22:00:00.000Z",
    };
    const out = await performUndo(SHOP_DOMAIN, mocks.contract as never, spec, OPTS);
    expect(out).toMatchObject({ kind: "restored", frequency: { unit: "WEEK", count: 4 } });
    expect(mocks.changeFrequency).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      { unit: "WEEK", count: 4 },
      expect.anything(),
    );
    // The cadence restore already landed on PREV → no second re-anchor.
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();

    // When Shopify lands elsewhere, the exact previous date is put back.
    vi.clearAllMocks();
    mocks.changeFrequency.mockResolvedValueOnce({
      ...mocks.contract,
      nextBillingDate: new Date("2026-09-08T22:00:00.000Z"),
    } as never);
    await performUndo(SHOP_DOMAIN, mocks.contract as never, spec, OPTS);
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", PREV, expect.anything());
  });

  it("stale: the contract moved on since → nothing restored, portal.undo{outcome:stale}", async () => {
    Object.assign(mocks.contract, { nextBillingDate: new Date("2026-10-01T22:00:00.000Z") });
    const out = await performUndo(SHOP_DOMAIN, mocks.contract as never, delayOnce, OPTS);
    expect(out).toEqual({ kind: "stale" });
    expect(mocks.revertDelayedCycle).not.toHaveBeenCalled();
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(undoEvents()[0].payload).toMatchObject({ action: "delay", outcome: "stale" });

    // Frequency: current cadence ≠ the change's after-state.
    const freqOut = await performUndo(
      SHOP_DOMAIN,
      mocks.contract as never,
      { kind: "frequency", oldUnit: "WEEK", oldCount: 4, newUnit: "WEEK", newCount: 6, previousNextBillingDate: null, nextBillingDate: null },
      OPTS,
    );
    expect(freqOut).toEqual({ kind: "stale" });
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
  });

  it("past: the previous date already went by → nothing restored; inactive contract → nothing", async () => {
    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    const out = await performUndo(SHOP_DOMAIN, mocks.contract as never, delayOnce, OPTS);
    expect(out).toEqual({ kind: "past" });
    expect(mocks.revertDelayedCycle).not.toHaveBeenCalled();
    expect(undoEvents()[0].payload).toMatchObject({ outcome: "past" });

    vi.setSystemTime(NOW);
    Object.assign(mocks.contract, { status: "PAUSED" });
    expect(await performUndo(SHOP_DOMAIN, mocks.contract as never, delayOnce, OPTS)).toEqual({ kind: "inactive" });
  });
});

// ── Token ────────────────────────────────────────────────────────────────────

describe("undo token", () => {
  const spec: UndoSpec = {
    kind: "next_date",
    previousNextBillingDate: PREV.toISOString(),
    nextBillingDate: NEXT.toISOString(),
  };

  it("window comes from portal.magicLinkTtlDays (the SKIP-undo link lifetime); default 14 days", () => {
    expect(undoWindowSeconds({ magicLinkTtlDays: 3 })).toBe(3 * 24 * 3600);
    expect(undoWindowSeconds({})).toBe(14 * 24 * 3600);
  });

  it("round-trips inside the window and expires after it", () => {
    const token = mintUndoToken(spec, BINDING, 3600)!;
    expect(readUndoToken(token, BINDING)).toEqual({ ok: true, spec });
    vi.setSystemTime(new Date(NOW.getTime() + 3601 * 1000));
    expect(readUndoToken(token, BINDING)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses tampering, foreign bindings and garbage", () => {
    const token = mintUndoToken(spec, BINDING, 3600)!;
    const [body, sig] = token.split(".");
    expect(readUndoToken(`${body}x.${sig}`, BINDING)).toEqual({ ok: false, reason: "invalid" });
    expect(readUndoToken("nope", BINDING)).toEqual({ ok: false, reason: "invalid" });
    expect(readUndoToken(token, { ...BINDING, contractId: "ctr_2" })).toEqual({ ok: false, reason: "mismatch" });
    expect(readUndoToken(token, { ...BINDING, shopId: "shop_2" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("undoSpecFromEvent reads the previous values the events store (pre-v1.28 delays = once)", () => {
    expect(
      undoSpecFromEvent({
        type: "cycle.delayed",
        payload: { previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString(), weeks: 1 },
      }),
    ).toEqual({ kind: "delay", mode: "once", previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString() });
    expect(
      undoSpecFromEvent({
        type: "cycle.delayed",
        payload: { mode: "reanchor", previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString() },
      }),
    ).toMatchObject({ kind: "delay", mode: "reanchor" });
    expect(
      undoSpecFromEvent({
        type: "contract.frequency_changed",
        payload: { oldUnit: "WEEK", oldCount: 4, newUnit: "WEEK", newCount: 6, oldWeeks: 4, newWeeks: 6 },
      }),
    ).toEqual({ kind: "frequency", oldUnit: "WEEK", oldCount: 4, newUnit: "WEEK", newCount: 6, previousNextBillingDate: null, nextBillingDate: null });
    expect(undoSpecFromEvent({ type: "cycle.skipped", payload: {} })).toBeNull();
    expect(undoSpecFromEvent({ type: "cycle.delayed", payload: { previousNextBillingDate: "garbage" } })).toBeNull();
  });
});

// ── Portal `undo` action ─────────────────────────────────────────────────────

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function postAction(action: string, fields: Record<string, string>): Promise<Response> {
  const session = await getPortalSession(new Request(proxyUrl("/", { logged_in_customer_id: "1" })));
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: session?.csrfToken ?? "",
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

function locationParams(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://x").searchParams;
}

describe("POST /api/undo", () => {
  it("delay → the toast's token → undo restores the previous date and reports it", async () => {
    Object.assign(mocks.contract, { nextBillingDate: PREV });
    const delayed = locationParams(await postAction("delay", { weeks: "1" }));
    const token = delayed.get("undo")!;
    expect(token).toBeTruthy();

    // The contract now sits at the delayed date (the mirror the next request loads).
    Object.assign(mocks.contract, { nextBillingDate: NEXT });
    const undone = locationParams(await postAction("undo", { undo_token: token }));
    expect(undone.get("toast")).toBe("undone");
    expect(undone.get("d1")).toBe("2026-09-08");
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", PREV, expect.anything());
    expect(undoEvents()[0].payload).toMatchObject({ action: "delay", outcome: "restored", via: "portal" });
  });

  it("next_date and frequency toasts carry undo tokens too; a stale contract answers undo_stale", async () => {
    Object.assign(mocks.contract, { nextBillingDate: PREV });
    mocks.setNextBillingDate.mockResolvedValueOnce({ ...mocks.contract, nextBillingDate: NEXT } as never);
    const dated = locationParams(await postAction("next_date", { date: "2026-09-15" }));
    expect(dated.get("toast")).toBe("date_changed");
    expect(readUndoToken(dated.get("undo")!, BINDING)).toMatchObject({ ok: true, spec: { kind: "next_date" } });

    mocks.changeFrequency.mockResolvedValueOnce({ ...mocks.contract, nextBillingDate: NEXT } as never);
    const freq = locationParams(await postAction("frequency", { frequency: "6:WEEK" }));
    expect(freq.get("toast")).toBe("frequency_changed");
    expect(freq.get("every")).toBe("6:WEEK");
    const spec = readUndoToken(freq.get("undo")!, BINDING);
    expect(spec).toMatchObject({ ok: true, spec: { kind: "frequency", oldCount: 4, newCount: 6 } });

    // Contract never moved to 6 weeks (mirror shows 4) → stale, nothing called.
    vi.clearAllMocks();
    const stale = locationParams(await postAction("undo", { undo_token: freq.get("undo")! }));
    expect(stale.get("toast")).toBe("undo_stale");
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
  });

  it("expired token → undo_expired; tampered token → error; nothing restored", async () => {
    const token = mintUndoToken(
      { kind: "next_date", previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString() },
      BINDING,
      60,
    )!;
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect(locationParams(await postAction("undo", { undo_token: token })).get("toast")).toBe("undo_expired");
    vi.setSystemTime(NOW);
    expect(locationParams(await postAction("undo", { undo_token: `${token}x` })).get("toast")).toBe("error");
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });

  it("the previous date already passed → undo_expired", async () => {
    const token = mintUndoToken(
      { kind: "next_date", previousNextBillingDate: "2026-08-10T22:00:00.000Z", nextBillingDate: NEXT.toISOString() },
      BINDING,
      3600,
    )!;
    expect(locationParams(await postAction("undo", { undo_token: token })).get("toast")).toBe("undo_expired");
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });

  it("toast keys + English copy exist for every undo outcome", () => {
    for (const key of ["undone", "undo_stale", "undo_expired"]) {
      expect(TOAST_KEYS.has(key)).toBe(true);
      expect((en as Record<string, string>)[`portal.toast.${key}`]).toBeTruthy();
    }
    expect((en as Record<string, string>)["portal.toast.undone_plain"]).toBeTruthy();
  });
});

// ── SMS UNDO ─────────────────────────────────────────────────────────────────

async function sms(keyword: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = (await smsAction({
    request: new Request("https://app.example/api/sms/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cellexia-secret": "test-cron-secret" },
      body: JSON.stringify({ phone: PHONE, keyword }),
    }),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("SMS UNDO", () => {
  beforeEach(() => {
    Object.assign(mocks.contract, { phone: PHONE });
  });

  it("reverses the newest customer-made undoable event from its own payload", async () => {
    mocks.subscriberEventFindFirst.mockResolvedValue({
      type: "cycle.delayed",
      payload: { mode: "reanchor", previousNextBillingDate: PREV.toISOString(), nextBillingDate: NEXT.toISOString(), weeks: 2 },
    });
    const out = await sms("UNDO");
    expect(out.status).toBe(200);
    expect(out.json.ok).toBe(true);
    expect(out.json.message).toBe("Done — that change is undone. Your next Cellexia order is back on September 8, 2026.");
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", PREV, {
      source: "MAGIC_LINK",
      actor: "sms",
    });
    // Window + customer-only sources + newest-first, undo markers included.
    const where = (mocks.subscriberEventFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.contractId).toBe("ctr_1");
    // v1.28.0 (P2.5): per-line cycle edits are SMS-undoable too.
    expect(where.type).toEqual({ in: ["cycle.skipped", "cycle.delayed", "contract.next_date_changed", "contract.frequency_changed", "cycle.line_skipped", "cycle.line_quantity_set", "portal.undo"] });
    expect(where.source).toEqual({ in: ["CUSTOMER_PORTAL", "MAGIC_LINK"] });
    const since = (where.createdAt as { gte: Date }).gte;
    expect(NOW.getTime() - since.getTime()).toBe(14 * DAY_MS);
    expect(undoEvents()[0].payload).toMatchObject({ action: "delay", outcome: "restored", via: "sms" });
  });

  it("nothing recent, or the last thing was itself an undo → 'nothing to undo', no service call", async () => {
    let out = await sms("UNDO");
    expect(out.json).toEqual({ ok: false, message: (en as Record<string, string>)["magic.sms.undo_none"] });
    mocks.subscriberEventFindFirst.mockResolvedValue({ type: "portal.undo", payload: { action: "delay", outcome: "restored" } });
    out = await sms("UNDO");
    expect(out.json.ok).toBe(false);
    expect(out.json.message).toBe((en as Record<string, string>)["magic.sms.undo_none"]);
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(mocks.revertDelayedCycle).not.toHaveBeenCalled();
  });

  it("the schedule moved on since → 'can't be undone', nothing restored", async () => {
    mocks.subscriberEventFindFirst.mockResolvedValue({
      type: "contract.next_date_changed",
      payload: { previousNextBillingDate: PREV.toISOString(), nextBillingDate: "2026-10-01T22:00:00.000Z" },
    });
    const out = await sms("UNDO");
    expect(out.json).toEqual({ ok: false, message: (en as Record<string, string>)["magic.sms.undo_stale"] });
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });

  it("SMS DELAY follows portal.delayReanchors (ON here → delaySchedule)", async () => {
    const out = await sms("DELAY");
    expect(out.json.ok).toBe(true);
    expect(mocks.delaySchedule).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", { weeks: 2 }, { source: "MAGIC_LINK", actor: "sms" });
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
  });
});
