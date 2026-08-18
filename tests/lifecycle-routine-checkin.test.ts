import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * WEEK-N ROUTINE CHECK-IN (v1.28.0, P4.1) — the sweep + the magic verb.
 *
 *  Sweep (runRoutineCheckin):
 *   - candidate window = routineStart (firstChargeAt, else createdAt — the
 *     SAME anchor the card/education use) such that routine week ∈
 *     [checkinWeek, checkinWeek + grace); the belt re-checks the week;
 *   - the survey expectation sentence rides as {expectation_line} ("" when
 *     none) — Stage E review;
 *   - sends `routine_checkin` ONCE per contract (NotificationLog SENT dedupe)
 *     with the phase copy + the two CHECKIN links + cycle-free vars;
 *   - gates: lifecycle.resultsTimeline.enabled, portalGrowth.resultsTimeline,
 *     the results_timeline "shown" arm (holdout ⇒ nothing sent, nothing
 *     logged);
 *   - never throws — a per-contract failure is counted, the loop continues.
 *
 *  Magic CHECKIN:
 *   - describe: its own title + answer-specific description;
 *   - execute: logs lifecycle.checkin_answered {answer}, mints a LOGIN
 *     hand-off and 303s to the portal with next=/subscription/{id}
 *     ?toast=checkin_{answer}&checkin={answer};
 *   - not a mutation: no lock / preparing / throttle interference;
 *   - buildCheckinLinks mints two multi-use CHECKIN tokens;
 *   - safeHandoffNext only ever admits /subscription/{id} + toast/checkin.
 */

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
    firstChargeAt: new Date("2026-07-20T10:00:00Z"),
    createdAt: new Date("2026-07-20T10:00:00Z"),
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
    lines: [],
    shop,
  };
  const setupMode = { value: false };
  return {
    shop,
    contract,
    setupMode,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => [contract]),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    notificationLogFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    surveyFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
    getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
    resolveLockState: vi.fn(async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 })),
    // Token = "{action}-{answer|handoff}" so URLs are asserted by intent.
    createMagicToken: vi.fn(
      async (input: { action: string; params?: { answer?: string; handoff?: boolean } }): Promise<string> =>
        `${input.action}-${input.params?.answer ?? (input.params?.handoff ? "handoff" : "")}`,
    ),
    shopFindUnique: vi.fn(async (): Promise<unknown> => shop),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
    sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({ status: "SENT" })),
    arm: vi.fn(async (): Promise<string> => "shown"),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
      findFirst: mocks.contractFindFirst,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    surveyResponse: { findFirst: mocks.surveyFindFirst },
    winbackState: { updateMany: vi.fn(async () => ({ count: 1 })) },
    shop: { findUnique: mocks.shopFindUnique },
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
vi.mock("~/shopify.server", () => ({ adminClientForShop: vi.fn(async () => ({})) }));
vi.mock("~/lib/graphql/index.server", () => ({ getPaymentMethodUpdateUrl: vi.fn() }));
vi.mock("~/lib/contracts/service.server", () => ({
  addOneTimeAddon: vi.fn(),
  applyDiscountGrant: vi.fn(),
  delayNextCycle: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
}));
vi.mock("~/lib/dunning/engine.server", () => ({ requestCustomerRetry: vi.fn() }));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async () => false),
}));
vi.mock("~/lib/experiments/index.server", () => ({ resultsTimelineArmFor: mocks.arm }));

// The magic builder is REAL (it wraps the mocked createMagicToken and the
// mocked shop read), so pin the app URL it needs.
process.env.SHOPIFY_APP_URL = "https://app.example";

import { settingsSchemas } from "~/lib/settings/registry.server";
import { CHECKIN_GRACE_WEEKS, runRoutineCheckin } from "~/lib/lifecycle/checkin.server";
import { buildCheckinLinks } from "~/lib/magiclinks/builder.server";
import { describeMagicAction, executeMagicAction } from "~/lib/magiclinks/handlers.server";
import { safeHandoffNext } from "~/lib/portal/handoff-next.server";
import { t } from "~/lib/i18n/i18n.server";

/** 2026-08-17 12:00Z — contract started 2026-07-20 ⇒ 28 days ⇒ week 5. */
const NOW = new Date("2026-08-17T12:00:00Z");

function lifecycleWith(over: Record<string, unknown> = {}) {
  const base = settingsSchemas.lifecycle.parse(undefined);
  return { ...base, resultsTimeline: { ...base.resultsTimeline, ...over } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = false;
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.contractFindMany.mockResolvedValue([mocks.contract]);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.arm.mockResolvedValue("shown");
  mocks.sendNotification.mockResolvedValue({ status: "SENT" });
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "lifecycle") return lifecycleWith({ checkinWeek: 5 });
    if (key === "portalGrowth") return settingsSchemas.portalGrowth.parse(undefined);
    if (key === "portal") return { mutationsPerHour: 30, magicLinkTtlDays: 14 };
    return {};
  });
});

// ── Sweep ────────────────────────────────────────────────────────────────────

describe("runRoutineCheckin — sends once at the configured week", () => {
  it("scans the firstChargeAt window for [checkinWeek, checkinWeek+grace) and sends the phase copy + links", async () => {
    const stats = await runRoutineCheckin(NOW);
    expect(stats).toMatchObject({ scanned: 1, sent: 1, skipped: 0, errors: 0 });

    const where = (mocks.contractFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ shopId: "shop_1", isDemo: false, status: "ACTIVE" });
    // routineStart(): firstChargeAt in the window, OR (no firstChargeAt AND
    // createdAt in the window) — the same anchor the portal card uses, so a
    // contract whose origin-order fetch failed is not silently skipped.
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    const range = or[0].firstChargeAt as { gt: Date; lte: Date };
    // week 5 ⇒ start ≤ now − 28 d, and > now − (28 + grace·7) d (shop-tz days).
    expect(range.lte.toISOString().slice(0, 10)).toBe("2026-07-20");
    expect(range.gt.toISOString().slice(0, 10)).toBe(
      new Date(range.lte.getTime() - CHECKIN_GRACE_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10),
    );
    expect(or[1]).toEqual({ firstChargeAt: null, createdAt: range });
    expect(where.firstChargeAt).toBeUndefined();

    const send = mocks.sendNotification.mock.calls[0][0] as {
      template: string;
      contractId: string;
      vars: Record<string, unknown>;
    };
    expect(send.template).toBe("routine_checkin");
    expect(send.contractId).toBe("ctr_1");
    expect(send.vars.week).toBe(5);
    expect(send.vars.phase_title).toBe(t("en", "portal.timeline.phase2.title"));
    expect(send.vars.phase_body).toBe(t("en", "portal.timeline.phase2.body"));
    expect(String(send.vars.next_phase_line)).toContain("From week 9");
    expect(send.vars.checkin_great_url).toBe("https://app.example/magic/CHECKIN-great");
    expect(send.vars.checkin_unsure_url).toBe("https://app.example/magic/CHECKIN-unsure");
    expect(send.vars.cta_url).toBe("https://cellexialabs.com/apps/cellexia-subs/subscription/ctr_1");
    // No cycleIndex — the dedupe is per contract, not per cycle.
    expect(send.vars.cycleIndex).toBeUndefined();
    // No survey answer ⇒ the expectation placeholder resolves to "".
    expect(send.vars.expectation_line).toBe("");
  });

  it("a contract with null firstChargeAt is sent on its createdAt week (the query returns it, the belt agrees)", async () => {
    mocks.contractFindMany.mockResolvedValueOnce([{ ...mocks.contract, firstChargeAt: null }]);
    const stats = await runRoutineCheckin(NOW);
    expect(stats).toMatchObject({ scanned: 1, sent: 1 });
    expect((mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> }).vars.week).toBe(5);
  });

  it("a fast survey expectation rides as {expectation_line}; the survey holdout never gets it", async () => {
    mocks.surveyFindFirst.mockResolvedValue({ answers: { expectedSpeed: "days" } });
    await runRoutineCheckin(NOW);
    let vars = (mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> }).vars;
    expect(String(vars.expectation_line)).toContain("within days");
    expect(String(vars.expectation_line)).toContain("week 5");
    vi.clearAllMocks();
    mocks.contractFindMany.mockResolvedValueOnce([{ ...mocks.contract, surveyHoldout: true }]);
    await runRoutineCheckin(NOW);
    vars = (mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> }).vars;
    expect(vars.expectation_line).toBe("");
    expect(mocks.surveyFindFirst).not.toHaveBeenCalled();
  });

  it("dedupes on a SENT NotificationLog row — never a second email", async () => {
    mocks.notificationLogFindFirst.mockResolvedValueOnce({ id: "log_1" });
    const stats = await runRoutineCheckin(NOW);
    expect(stats.sent).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const where = (mocks.notificationLogFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "ctr_1", template: "routine_checkin", status: "SENT" });
  });

  it("holdout arm: nothing sent, nothing minted", async () => {
    mocks.arm.mockResolvedValueOnce("holdout");
    const stats = await runRoutineCheckin(NOW);
    expect(stats.sent).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.createMagicToken).not.toHaveBeenCalled();
  });

  it("belt: a candidate outside the week window is skipped even if the query returned it", async () => {
    // Started 10 weeks ago ⇒ week 11, past checkinWeek + grace.
    mocks.contractFindMany.mockResolvedValueOnce([
      { ...mocks.contract, firstChargeAt: new Date("2026-06-08T10:00:00Z") },
    ]);
    const stats = await runRoutineCheckin(NOW);
    expect(stats.sent).toBe(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("gates: timeline content off / growth toggle off ⇒ no scan at all", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") return lifecycleWith({ enabled: false });
      if (key === "portalGrowth") return settingsSchemas.portalGrowth.parse(undefined);
      return {};
    });
    expect((await runRoutineCheckin(NOW)).reason).toBe("timeline_disabled");
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "lifecycle") return lifecycleWith({ checkinWeek: 5 });
      if (key === "portalGrowth") return { ...settingsSchemas.portalGrowth.parse(undefined), resultsTimeline: false };
      return {};
    });
    expect((await runRoutineCheckin(NOW)).reason).toBe("growth_toggle_off");
    expect(mocks.contractFindMany).not.toHaveBeenCalled();
  });

  it("a per-contract failure is counted and never thrown", async () => {
    mocks.contractFindMany.mockResolvedValueOnce([
      mocks.contract,
      { ...mocks.contract, id: "ctr_2" },
    ]);
    mocks.sendNotification
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce({ status: "SENT" });
    const stats = await runRoutineCheckin(NOW);
    expect(stats.errors).toBe(1);
    expect(stats.sent).toBe(1);
  });
});

// ── Magic CHECKIN ────────────────────────────────────────────────────────────

function payload(action: string, params: Record<string, unknown> = {}) {
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

describe("magic CHECKIN", () => {
  it("describes itself with an answer-specific promise", async () => {
    const great = await describeMagicAction(payload("CHECKIN", { answer: "great" }));
    expect(great.title).toBe(t("en", "magic.confirm.title.CHECKIN"));
    expect(great.description).toBe(t("en", "magic.confirm.desc.CHECKIN_GREAT"));
    const unsure = await describeMagicAction(payload("CHECKIN", { answer: "unsure" }));
    expect(unsure.description).toBe(t("en", "magic.confirm.desc.CHECKIN_UNSURE"));
    expect(unsure.lockedResult).toBeUndefined();
  });

  it("logs lifecycle.checkin_answered and 303s to the subscription page with the toast + checkin params", async () => {
    const result = await executeMagicAction(payload("CHECKIN", { answer: "unsure" }));
    const answered = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown>; source: string })
      .find((e) => e.type === "lifecycle.checkin_answered");
    expect(answered).toBeDefined();
    expect(answered?.payload).toMatchObject({ answer: "unsure" });
    expect(answered?.source).toBe("MAGIC_LINK");
    // LOGIN hand-off (single-use, 60 s) — never the session token in a URL.
    const minted = mocks.createMagicToken.mock.calls[0][0] as {
      action: string;
      params: Record<string, unknown>;
      maxUses: number;
    };
    expect(minted.action).toBe("LOGIN");
    expect(minted.params.handoff).toBe(true);
    expect(minted.maxUses).toBe(1);
    expect(result.redirect).toContain("handoff=LOGIN-handoff");
    const url = new URL(result.redirect!);
    expect(url.searchParams.get("next")).toBe("/subscription/ctr_1?toast=checkin_unsure&checkin=unsure");
    expect(result.headline).toBe(t("en", "magic.checkin.done_unsure"));
  });

  it("defaults an unknown answer to 'great' and is not gated as a mutation (works in SETUP, past the throttle)", async () => {
    mocks.setupMode.value = true;
    mocks.subscriberEventCount.mockResolvedValue(999);
    const result = await executeMagicAction(payload("CHECKIN", { answer: "whatever" }));
    expect(result.redirect).toBeDefined();
    expect(new URL(result.redirect!).searchParams.get("next")).toContain("toast=checkin_great");
  });
});

describe("buildCheckinLinks", () => {
  it("mints two multi-use CHECKIN tokens carrying the answer", async () => {
    const links = await buildCheckinLinks({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "ROUTINE_CHECKIN",
    });
    expect(links.checkin_great_url).toMatch(/^https:\/\/app\.example\/magic\//);
    expect(links.checkin_unsure_url).toMatch(/^https:\/\/app\.example\/magic\//);
    const inputs = mocks.createMagicToken.mock.calls.map(
      (c) => c[0] as { action: string; params: { answer: string }; maxUses: number; createdVia: string },
    );
    expect(inputs.map((i) => i.action)).toEqual(["CHECKIN", "CHECKIN"]);
    expect(inputs.map((i) => i.params.answer).sort()).toEqual(["great", "unsure"]);
    for (const i of inputs) {
      expect(i.maxUses).toBeGreaterThan(1);
      expect(i.createdVia).toBe("ROUTINE_CHECKIN");
    }
  });
});

describe("safeHandoffNext", () => {
  it("admits only /subscription/{id} with whitelisted word-only params", () => {
    expect(safeHandoffNext("/subscription/ctr_1?toast=checkin_unsure&checkin=unsure")).toBe(
      "/subscription/ctr_1?toast=checkin_unsure&checkin=unsure",
    );
    expect(safeHandoffNext("/subscription/ctr_1")).toBe("/subscription/ctr_1");
    expect(safeHandoffNext("/subscription/ctr_1?toast=<script>&x=1")).toBe("/subscription/ctr_1");
    expect(safeHandoffNext("//evil.example/x")).toBeNull();
    expect(safeHandoffNext("https://evil.example/subscription/ctr_1")).toBeNull();
    expect(safeHandoffNext("/account")).toBeNull();
    expect(safeHandoffNext("/subscription/../login")).toBeNull();
    expect(safeHandoffNext(null)).toBeNull();
  });
});
