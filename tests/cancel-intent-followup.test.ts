import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fromZonedTime } from "date-fns-tz";

/**
 * Abandoned cancel-intent follow-up (v1.28.0, P3.6) — pins:
 *
 *  Sweep (runCancelIntentFollowup):
 *   - candidate query: ABANDONED sessions closed ≥ intentFollowupHours and
 *     ≤ INTENT_MAX_AGE_HOURS ago on ACTIVE/PAUSED, OURS, non-demo contracts;
 *   - sends ONE cancel_intent_followup with reason/step + the reason-matched
 *     one-tap links (SKIP / DELAY_NEXT 3w / SET_FREQUENCY when a slower
 *     option exists) + a plain cancel link, and logs
 *     cancel.intent_followup_sent;
 *   - timing: never inside intentFollowupChargeBufferHours before the next
 *     charge moment (outsideChargeBuffer);
 *   - cooldown: never twice per customer email per intentFollowupCooldownDays;
 *     never twice for the same session (any NotificationLog row since it
 *     closed);
 *   - gates: intentFollowupEnabled / cancelFlow.enabled off; a later SAVED /
 *     CANCELLED session (latest-session rule); a scheduled cancel;
 *     nothing applicable → no email;
 *   - the job is registered SETUP-gated after cancel_session_gc.
 *
 *  Magic SET_FREQUENCY:
 *   - describe: own title + description naming the cadence;
 *   - execute: re-derives the plan's offered options (membership +
 *     allowChoice), refuses when the target is not slower any more,
 *     applies changeFrequency as MAGIC_LINK/customer;
 *   - classification: MUTATING (setup-gated), LOCK-blocked, PREPARING-
 *     blocked — parity with the portal frequency form.
 *
 *  Banner (intentBannerHtml / findBannerIntent): the same reason mapping and
 *  applicability, forms post to the portal dispatcher with csrf, the cancel
 *  link is plain, DOWNSIZE is a link (never one-tap), portal.intent.* copy is
 *  outside the growth-copy scope, and cancel.intent_banner_shown is logged.
 *
 *  Settings + template registry: cancelFlow.intentFollowup* defaults;
 *  cancel_intent_followup in TEMPLATES / EMAIL_CATALOG / preview samples with
 *  metric "Cellexia Cancel Intent" and a Klaviyo flow rationale.
 */

const TZ = "Europe/Zurich";
const DAY = (ymd: string) => fromZonedTime(`${ymd}T00:00:00`, TZ);
/** 2026-08-17 12:00Z */
const NOW = new Date("2026-08-17T12:00:00Z");
const H = 3_600_000;

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
    contactEmail: "hello@cellexialabs.com",
  };
  const contract: Record<string, unknown> = {
    id: "ctr_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    intervalWeeks: 8,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 8,
    nextBillingDate: null as Date | null,
    resumeAt: null as Date | null,
    pausedAt: null as Date | null,
    cancelScheduledAt: null as Date | null,
    lockDays: null,
    lines: [
      {
        id: "line_1",
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Serum",
        quantity: 1,
        isGift: false,
        isOneTimeAddon: false,
        currentPriceCents: 6600,
        shopifyLineId: "gid://shopify/SubscriptionLine/1",
      },
    ],
    shop,
  };
  const session = {
    id: "sess_1",
    contractId: "ctr_1",
    reason: "TOO_MUCH_PRODUCT" as string | null,
    savesShown: [{ kind: "SKIP" }] as unknown,
    outcome: "ABANDONED" as string | null,
    completedAt: new Date("2026-08-16T14:00:00Z") as Date | null,
    startedAt: new Date("2026-08-16T13:00:00Z"),
  };
  const setupMode = { value: false };
  return {
    shop,
    contract,
    session,
    setupMode,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => [contract]),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    sessionFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => [session]),
    sessionFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => session),
    notificationLogFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    billingAttemptFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
    getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
    resolveLockState: vi.fn(async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 })),
    createMagicToken: vi.fn(
      async (input: { action: string; params?: Record<string, unknown> }): Promise<string> =>
        `${input.action}${input.params?.weeks ? `-${input.params.weeks}w` : ""}${
          input.params?.count ? `-${input.params.count}${input.params.unit}` : ""
        }`,
    ),
    shopFindUnique: vi.fn(async (): Promise<unknown> => shop),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
    sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({ status: "SENT" })),
    frequencyOptions: vi.fn(async (): Promise<unknown> => ({
      options: [
        { unit: "WEEK", count: 4 },
        { unit: "WEEK", count: 8 },
        { unit: "WEEK", count: 12 },
      ],
      allowChoice: true,
    })),
    supportChannels: vi.fn(async (): Promise<unknown> => ({ hasAny: true })),
    changeFrequency: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({
      status: "ACTIVE",
      nextBillingDate: DAY("2026-09-10"),
      resumeAt: null,
    })),
    isPreparingOrder: vi.fn(async (): Promise<boolean> => false),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
      findFirst: mocks.contractFindFirst,
    },
    cancelSession: {
      findMany: mocks.sessionFindMany,
      findFirst: mocks.sessionFindFirst,
    },
    subscriberEvent: {
      count: mocks.subscriberEventCount,
      findFirst: mocks.subscriberEventFindFirst,
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    billingAttempt: { findFirst: mocks.billingAttemptFindFirst },
    shop: { findUnique: mocks.shopFindUnique },
    sellingPlanConfig: { findMany: vi.fn(async () => []) },
    setting: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/contracts/lock.server", () => ({ resolveLockState: mocks.resolveLockState }));
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
  delaySchedule: vi.fn(),
  extendPause: vi.fn(),
  PauseUntilError: class extends Error {},
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
  changeFrequency: mocks.changeFrequency,
}));
vi.mock("~/lib/dunning/engine.server", () => ({ requestCustomerRetry: vi.fn() }));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async () => false),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  frequencyOptionsForContract: mocks.frequencyOptions,
}));
vi.mock("~/lib/support/channels.server", () => ({
  getSupportChannels: mocks.supportChannels,
}));
vi.mock("~/lib/billing/timing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/billing/timing.server")>();
  return {
    ...actual,
    resolveChargeTiming: vi.fn(async () => ({
      tz: "Europe/Zurich",
      chargeHourLocal: 6,
      preparingWindowHours: 6,
    })),
    isPreparingOrder: mocks.isPreparingOrder,
  };
});
vi.mock("~/lib/winback/engine.server", () => ({ reactivateFromWinback: vi.fn() }));

process.env.SHOPIFY_APP_URL = "https://app.example";

import { settingsSchemas } from "~/lib/settings/registry.server";
import {
  INTENT_MAX_AGE_HOURS,
  findAbandonedIntent,
  intentActionsFor,
  intentApplicabilitySync,
  intentStepFor,
  outsideChargeBuffer,
  runCancelIntentFollowup,
} from "~/lib/cancel/intent-followup.server";
import {
  findBannerIntent,
  intentBannerHtml,
  renderIntentBanner,
} from "~/lib/cancel/intent-banner.server";
import { buildSetFrequencyUrl } from "~/lib/magiclinks/builder.server";
import {
  describeMagicAction,
  executeMagicAction,
  setFrequencyTarget,
} from "~/lib/magiclinks/handlers.server";
import { JOB_NAMES, JOB_SCHEDULE, SETUP_GATED_JOB_NAMES } from "~/lib/jobs/runner.server";
import { TEMPLATES } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { previewSampleVars, renderTemplatePreview } from "~/lib/notifications/preview.server";
import { flowSpecs } from "~/lib/klaviyo/flows.server";
import { t } from "~/lib/i18n/i18n.server";

function cancelFlowWith(over: Record<string, unknown> = {}) {
  return { ...settingsSchemas.cancelFlow.parse(undefined), ...over };
}

function payload(
  action: string,
  params: Record<string, unknown> = {},
): Parameters<typeof executeMagicAction>[0] {
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = false;
  mocks.contract.status = "ACTIVE";
  mocks.contract.nextBillingDate = DAY("2026-09-10");
  mocks.contract.resumeAt = null;
  mocks.contract.cancelScheduledAt = null;
  mocks.contract.pausedAt = null;
  mocks.billingAttemptFindFirst.mockResolvedValue(null);
  mocks.contract.billingIntervalCount = 8;
  mocks.contract.intervalWeeks = 8;
  (mocks.contract.lines as Array<{ quantity: number }>)[0].quantity = 1;
  mocks.session.reason = "TOO_MUCH_PRODUCT";
  mocks.session.outcome = "ABANDONED";
  mocks.session.completedAt = new Date(NOW.getTime() - 20 * H);
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.sessionFindMany.mockResolvedValue([mocks.session]);
  mocks.sessionFindFirst.mockResolvedValue(mocks.session);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.sendNotification.mockResolvedValue({ status: "SENT" });
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.frequencyOptions.mockResolvedValue({
    options: [
      { unit: "WEEK", count: 4 },
      { unit: "WEEK", count: 8 },
      { unit: "WEEK", count: 12 },
    ],
    allowChoice: true,
  });
  mocks.supportChannels.mockResolvedValue({ hasAny: true });
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "cancelFlow") return cancelFlowWith();
    if (key === "portal") return { mutationsPerHour: 30, magicLinkTtlDays: 14, friendlyLockMessaging: false };
    return {};
  });
});

// ── Pure rules ───────────────────────────────────────────────────────────────

describe("reason → actions mapping + step", () => {
  it("maps every cancel reason to reason-matched actions (DOWNSIZE never one-tap, TALK always separate)", () => {
    expect(intentActionsFor("TOO_MUCH_PRODUCT")).toEqual(["SKIP", "DELAY", "SLOWER", "DOWNSIZE"]);
    expect(intentActionsFor("TOO_EXPENSIVE")).toEqual(["DOWNSIZE", "SLOWER", "PAUSE"]);
    expect(intentActionsFor("SHIPPING_ISSUES")).toEqual(["DELAY", "SLOWER"]);
    expect(intentActionsFor("NOT_SEEING_RESULTS")).toEqual(["PAUSE", "DELAY"]);
    expect(intentActionsFor(null)).toEqual(intentActionsFor("OTHER"));
    expect(intentActionsFor("BOGUS")).toEqual(intentActionsFor("OTHER"));
  });

  it("derives the Klaviyo step from the session shape", () => {
    expect(intentStepFor({ reason: null, savesShown: null })).toBe("intro");
    expect(intentStepFor({ reason: "OTHER", savesShown: null })).toBe("reason");
    expect(intentStepFor({ reason: "OTHER", savesShown: [{ kind: "PAUSE" }] })).toBe("saves");
  });

  it("outsideChargeBuffer: unknown charge → ok; ≥ buffer away → ok; inside or past → blocked", () => {
    expect(outsideChargeBuffer(null, NOW, 48)).toBe(true);
    expect(outsideChargeBuffer(new Date(NOW.getTime() + 49 * H), NOW, 48)).toBe(true);
    expect(outsideChargeBuffer(new Date(NOW.getTime() + 47 * H), NOW, 48)).toBe(false);
    expect(outsideChargeBuffer(new Date(NOW.getTime() - 1 * H), NOW, 48)).toBe(false);
    expect(outsideChargeBuffer(new Date(NOW.getTime() + 1 * H), NOW, 0)).toBe(true);
  });

  it("intentApplicabilitySync re-derives every action from contract truth", () => {
    const base = mocks.contract as unknown as Parameters<typeof intentApplicabilitySync>[0];
    const options = [
      { unit: "WEEK" as const, count: 8 },
      { unit: "WEEK" as const, count: 12 },
    ];
    const ok = intentApplicabilitySync(base, {
      locked: false,
      preparing: false,
      frequencyOptions: options,
      allowFrequencyChoice: true,
      downsizeEnabled: true,
    });
    expect(ok).toEqual({
      skip: true,
      delay: true,
      slower: { unit: "WEEK", count: 12 },
      downsize: false, // quantity 1 — nothing to make smaller
      pause: true,
    });
    // Locked: no reductions at all.
    const locked = intentApplicabilitySync(base, {
      locked: true,
      preparing: false,
      frequencyOptions: options,
      allowFrequencyChoice: true,
      downsizeEnabled: true,
    });
    expect(locked).toMatchObject({ skip: false, delay: false, slower: null });
    // Preparing: the cycle being billed is not editable; slower still fine.
    const preparing = intentApplicabilitySync(base, {
      locked: false,
      preparing: true,
      frequencyOptions: options,
      allowFrequencyChoice: true,
      downsizeEnabled: true,
    });
    expect(preparing).toMatchObject({ skip: false, delay: false, slower: { unit: "WEEK", count: 12 } });
    // No slower option offered / choice disallowed → null.
    expect(
      intentApplicabilitySync(base, {
        locked: false,
        preparing: false,
        frequencyOptions: [{ unit: "WEEK", count: 8 }],
        allowFrequencyChoice: true,
        downsizeEnabled: true,
      }).slower,
    ).toBeNull();
    expect(
      intentApplicabilitySync(base, {
        locked: false,
        preparing: false,
        frequencyOptions: options,
        allowFrequencyChoice: false,
        downsizeEnabled: true,
      }).slower,
    ).toBeNull();
    // PAUSED: nothing one-tap — a cadence change needs an ACTIVE contract
    // (the portal dispatcher's ACTIVE_ONLY has "frequency"; the banner's
    // /api/frequency form would only error) — one truth with the portal.
    const paused = intentApplicabilitySync(
      { ...base, status: "PAUSED" } as typeof base,
      { locked: false, preparing: false, frequencyOptions: options, allowFrequencyChoice: true, downsizeEnabled: true },
    );
    expect(paused).toMatchObject({ skip: false, delay: false, pause: false, slower: null });
    // Locked: pause is a reduction the lock refuses (LOCKED_MAGIC_ACTIONS /
    // portal LOCK_BLOCKED) — never offered inside the window.
    expect(locked.pause).toBe(false);
    // Downsize only when a recurring line has quantity ≥ 2 and the save is on.
    const two = { ...base, lines: [{ ...base.lines[0], quantity: 2 }] } as typeof base;
    expect(intentApplicabilitySync(two, { locked: false, preparing: false, frequencyOptions: options, allowFrequencyChoice: true, downsizeEnabled: true }).downsize).toBe(true);
    expect(intentApplicabilitySync(two, { locked: false, preparing: false, frequencyOptions: options, allowFrequencyChoice: true, downsizeEnabled: false }).downsize).toBe(false);
  });

  it("findAbandonedIntent: only the LATEST session counts, only while ABANDONED and inside the window", async () => {
    expect(await findAbandonedIntent("ctr_1", { now: NOW, maxAgeMs: 72 * H })).toMatchObject({
      sessionId: "sess_1",
      reason: "TOO_MUCH_PRODUCT",
      step: "saves",
    });
    const where = (mocks.sessionFindFirst.mock.calls[0][0] as { orderBy: unknown }).orderBy;
    expect(where).toEqual({ startedAt: "desc" });
    // A later SAVED session (returned as latest) = decided.
    mocks.sessionFindFirst.mockResolvedValueOnce({ ...mocks.session, id: "sess_2", outcome: "SAVED" });
    expect(await findAbandonedIntent("ctr_1", { now: NOW, maxAgeMs: 72 * H })).toBeNull();
    // Too old.
    mocks.sessionFindFirst.mockResolvedValueOnce({ ...mocks.session, completedAt: new Date(NOW.getTime() - 100 * H) });
    expect(await findAbandonedIntent("ctr_1", { now: NOW, maxAgeMs: 72 * H })).toBeNull();
    // Still open.
    mocks.sessionFindFirst.mockResolvedValueOnce({ ...mocks.session, outcome: null, completedAt: null });
    expect(await findAbandonedIntent("ctr_1", { now: NOW, maxAgeMs: 72 * H })).toBeNull();
  });
});

// ── Sweep ────────────────────────────────────────────────────────────────────

describe("runCancelIntentFollowup", () => {
  it("scans ABANDONED sessions in [now−72h, now−hours] on ACTIVE/PAUSED OURS non-demo contracts and sends the reason-matched email once", async () => {
    const stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ scanned: 1, sent: 1, skipped: 0, errors: 0 });

    const where = (mocks.sessionFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.outcome).toBe("ABANDONED");
    const range = where.completedAt as { gte: Date; lte: Date };
    expect(range.lte.getTime()).toBe(NOW.getTime() - 18 * H);
    expect(range.gte.getTime()).toBe(NOW.getTime() - INTENT_MAX_AGE_HOURS * H);
    expect(where.contract).toMatchObject({
      shopId: "shop_1",
      isDemo: false,
      status: { in: ["ACTIVE", "PAUSED"] },
    });
    expect((where.contract as Record<string, unknown>).ownership).toBeDefined();

    const send = mocks.sendNotification.mock.calls[0][0] as {
      template: string;
      contractId: string;
      vars: Record<string, string>;
    };
    expect(send.template).toBe("cancel_intent_followup");
    expect(send.contractId).toBe("ctr_1");
    expect(send.vars.reason).toBe("TOO_MUCH_PRODUCT");
    expect(send.vars.step).toBe("saves");
    // TOO_MUCH_PRODUCT on an ACTIVE 8-week contract with a 12-week option:
    // SKIP + DELAY(3w) + SET_FREQUENCY(12 WEEK); quantity 1 → no downsize.
    expect(send.vars.skip_url).toBe("https://app.example/magic/SKIP_NEXT");
    expect(send.vars.delay_3w_url).toBe("https://app.example/magic/DELAY_NEXT-3w");
    expect(send.vars.set_frequency_url).toBe("https://app.example/magic/SET_FREQUENCY-12WEEK");
    expect(send.vars.pause_url).toBe("");
    expect(send.vars.actions).toBe("SKIP,DELAY,SLOWER");
    expect(send.vars.options_block).toContain("Skip my next order: https://app.example/magic/SKIP_NEXT");
    expect(send.vars.options_block).toContain("every 12 weeks");
    expect(send.vars.options_block).not.toContain("smaller");
    // Honesty: the plain cancel link + support line always ride along.
    expect(send.vars.cancel_url).toBe(`https://cellexialabs.com/apps/${"cellexia"}/cancel/ctr_1`.replace(
      "/apps/cellexia/",
      send.vars.cancel_url.match(/\/apps\/[^/]+\//)?.[0] ?? "/apps/cellexia/",
    ));
    expect(send.vars.cancel_url).toMatch(/^https:\/\/cellexialabs\.com\/apps\/[^/]+\/cancel\/ctr_1$/);
    expect(send.vars.support_line).toContain("account#cxs-support");
    expect(send.vars.reason_line).toBe(t("en", "email.cancel_intent_followup.reason.TOO_MUCH_PRODUCT"));

    const event = mocks.logEvent.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "cancel.intent_followup_sent",
    );
    expect(event).toBeDefined();
    expect((event![0] as { payload: Record<string, unknown> }).payload).toMatchObject({
      sessionId: "sess_1",
      reason: "TOO_MUCH_PRODUCT",
      step: "saves",
      actions: "SKIP,DELAY,SLOWER",
    });
    // Every minted token is single-use and stamped with the sender.
    for (const call of mocks.createMagicToken.mock.calls) {
      expect((call[0] as unknown as { createdVia: string }).createdVia).toBe("CANCEL_INTENT_FOLLOWUP");
    }
  });

  it("uses the settings hours (not a constant) for the due cut-off", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "cancelFlow" ? cancelFlowWith({ intentFollowupHours: 24 }) : {},
    );
    await runCancelIntentFollowup(NOW);
    const where = (mocks.sessionFindMany.mock.calls[0][0] as { where: { completedAt: { lte: Date } } }).where;
    expect(where.completedAt.lte.getTime()).toBe(NOW.getTime() - 24 * H);
  });

  it("never sends inside the pre-charge buffer (48h before the charge moment) — and never after the charge passed", async () => {
    // Charge at 06:00 Zurich on 2026-08-19 = 04:00Z → 40h away from NOW.
    mocks.contract.nextBillingDate = DAY("2026-08-19");
    let stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    // 2026-08-20 06:00 Zurich = 64h away → allowed.
    mocks.contract.nextBillingDate = DAY("2026-08-20");
    stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 1 });
    // A PAUSED contract's next charge is its resume day.
    vi.clearAllMocks();
    mocks.sendNotification.mockResolvedValue({ status: "SENT" });
    mocks.sessionFindMany.mockResolvedValue([mocks.session]);
    mocks.sessionFindFirst.mockResolvedValue(mocks.session);
    mocks.contractFindUnique.mockResolvedValue(mocks.contract);
    mocks.contract.status = "PAUSED";
    mocks.contract.nextBillingDate = null;
    mocks.contract.resumeAt = DAY("2026-08-18");
    stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("locked + TOO_EXPENSIVE (PAUSE reason, no slower option): pause_url is never minted and no email goes out", async () => {
    mocks.session.reason = "TOO_EXPENSIVE";
    mocks.resolveLockState.mockResolvedValue({ locked: true, until: DAY("2026-09-01"), lockDays: 30 });
    mocks.frequencyOptions.mockResolvedValue({ options: [{ unit: "WEEK", count: 8 }], allowChoice: true });
    const stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.createMagicToken.mock.calls.some((c) => (c[0] as { action: string }).action === "PAUSE")).toBe(false);
    mocks.session.reason = "TOO_MUCH_PRODUCT";
    mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  });

  it("a pause taken AFTER the abandoned session is the decision — no email (an already-paused contract stays a candidate)", async () => {
    mocks.contract.status = "PAUSED";
    mocks.contract.nextBillingDate = null;
    mocks.contract.resumeAt = DAY("2026-10-01");
    // Paused 2h after walking away → skipped, no applicability read.
    mocks.contract.pausedAt = new Date(mocks.session.completedAt!.getTime() + 2 * H);
    let stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.frequencyOptions).not.toHaveBeenCalled();
    // Paused BEFORE opening the flow → still a candidate (nothing one-tap
    // applies for PAUSED, so it is skipped for that reason, after the read).
    mocks.contract.pausedAt = new Date(mocks.session.completedAt!.getTime() - 24 * H);
    stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.frequencyOptions).toHaveBeenCalled();
    mocks.contract.status = "ACTIVE";
    mocks.contract.pausedAt = null;
    mocks.contract.resumeAt = null;
  });

  it("a charge that landed since the session closes the window — no email hours after money moved", async () => {
    mocks.contract.nextBillingDate = DAY("2026-09-10");
    mocks.billingAttemptFindFirst.mockResolvedValueOnce({ id: "ba_1" });
    const stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const where = (mocks.billingAttemptFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ contractId: "ctr_1", createdAt: { gt: mocks.session.completedAt } });
    // No attempt since → sends.
    const again = await runCancelIntentFollowup(NOW);
    expect(again).toMatchObject({ sent: 1 });
  });

  it("cooldown: one per customer email per intentFollowupCooldownDays; and never twice for the same session", async () => {
    // A SENT row for this email inside 30 days → skip.
    mocks.notificationLogFindFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: Record<string, unknown> }).where;
      return w.email === "sub@example.com" && w.status === "SENT" ? { id: "nl_1" } : null;
    });
    let stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    const cooldownCall = mocks.notificationLogFindFirst.mock.calls.find(
      (c) => (c[0] as { where: Record<string, unknown> }).where.email === "sub@example.com",
    )!;
    const cw = (cooldownCall[0] as { where: Record<string, unknown> }).where;
    expect(cw.template).toBe("cancel_intent_followup");
    expect((cw.createdAt as { gte: Date }).gte.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
    // Any prior row for THIS session (contract-scoped, since it closed) → skip.
    mocks.notificationLogFindFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: Record<string, unknown> }).where;
      return w.contractId === "ctr_1" ? { id: "nl_2" } : null;
    });
    stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 0, skipped: 1 });
    // Cooldown 0 disables the per-person clock (session dedupe stays).
    mocks.notificationLogFindFirst.mockReset();
    mocks.notificationLogFindFirst.mockResolvedValue(null);
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "cancelFlow" ? cancelFlowWith({ intentFollowupCooldownDays: 0 }) : {},
    );
    stats = await runCancelIntentFollowup(NOW);
    expect(stats).toMatchObject({ sent: 1 });
    expect(
      mocks.notificationLogFindFirst.mock.calls.some(
        (c) => (c[0] as { where: Record<string, unknown> }).where.email === "sub@example.com",
      ),
    ).toBe(false);
  });

  it("gates: disabled setting / cancel flow off / decided later / scheduled cancel / nothing applicable", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "cancelFlow" ? cancelFlowWith({ intentFollowupEnabled: false }) : {},
    );
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ reason: "disabled", sent: 0 });
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "cancelFlow" ? cancelFlowWith({ enabled: false }) : {},
    );
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ reason: "disabled", sent: 0 });
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "cancelFlow" ? cancelFlowWith() : {},
    );

    // Latest session is a later SAVED one → decided.
    mocks.sessionFindFirst.mockResolvedValue({ ...mocks.session, id: "sess_2", outcome: "SAVED" });
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ sent: 0, skipped: 1 });
    mocks.sessionFindFirst.mockResolvedValue(mocks.session);

    // Scheduled cancel = a decision.
    mocks.contract.cancelScheduledAt = DAY("2026-09-01");
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ sent: 0, skipped: 1 });
    mocks.contract.cancelScheduledAt = null;

    // Locked + no slower option → nothing one-tap → no email.
    mocks.resolveLockState.mockResolvedValue({ locked: true, until: DAY("2026-09-01"), lockDays: 30 });
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a SUPPRESSED router verdict counts as handled (skipped, no event); a per-contract failure never stops the sweep", async () => {
    mocks.sendNotification.mockResolvedValueOnce({ status: "SUPPRESSED" });
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ sent: 0, skipped: 1, errors: 0 });
    expect(mocks.logEvent).not.toHaveBeenCalled();
    mocks.contractFindUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await runCancelIntentFollowup(NOW)).toMatchObject({ errors: 1 });
  });

  it("registers cancel_intent_followup_run SETUP-gated, hourly, right after cancel_session_gc", () => {
    expect(JOB_NAMES).toContain("cancel_intent_followup_run");
    expect(SETUP_GATED_JOB_NAMES).toContain("cancel_intent_followup_run");
    const gc = JOB_NAMES.indexOf("cancel_session_gc");
    expect(JOB_NAMES.indexOf("cancel_intent_followup_run")).toBeGreaterThan(gc);
    expect(JOB_SCHEDULE.find((j) => j.name === "cancel_intent_followup_run")?.everyMinutes).toBe(60);
  });
});

// ── Magic SET_FREQUENCY ──────────────────────────────────────────────────────

describe("SET_FREQUENCY magic verb", () => {
  it("buildSetFrequencyUrl mints a single-use token carrying the exact {unit, count}", async () => {
    const url = await buildSetFrequencyUrl({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "CANCEL_INTENT_FOLLOWUP",
      frequency: { unit: "WEEK", count: 12 },
    });
    expect(url).toBe("https://app.example/magic/SET_FREQUENCY-12WEEK");
    const input = mocks.createMagicToken.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      action: "SET_FREQUENCY",
      maxUses: 1,
      params: { unit: "WEEK", count: 12 },
    });
  });

  it("setFrequencyTarget rejects malformed params", () => {
    expect(setFrequencyTarget({ unit: "WEEK", count: 12 })).toEqual({ unit: "WEEK", count: 12 });
    expect(setFrequencyTarget({ unit: "YEAR" as never, count: 1 })).toBeNull();
    expect(setFrequencyTarget({ unit: "WEEK", count: 0 })).toBeNull();
    expect(setFrequencyTarget({ unit: "WEEK", count: 1.5 })).toBeNull();
    expect(setFrequencyTarget({})).toBeNull();
  });

  it("describe: own title + description naming the cadence; not locked when the plan lock is off", async () => {
    const d = await describeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(d.title).toBe(t("en", "magic.confirm.title.SET_FREQUENCY"));
    expect(d.description).toBe(
      t("en", "magic.confirm.desc.SET_FREQUENCY", { frequency: "every 12 weeks" }),
    );
    expect(d.lockedResult).toBeUndefined();
  });

  it("execute: re-derives the offered options and applies changeFrequency as MAGIC_LINK/customer", async () => {
    const r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(mocks.changeFrequency).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "ctr_1",
      { unit: "WEEK", count: 12 },
      { source: "MAGIC_LINK", actor: "customer" },
    );
    expect(r.headline).toBe(t("en", "magic.set_frequency.done", { frequency: "every 12 weeks" }));
    expect(r.sub).toContain("September 10, 2026");
    expect(mocks.frequencyOptions).toHaveBeenCalled();
  });

  it("execute: refuses honestly when the option is not offered, choice is disallowed, or it is no longer slower", async () => {
    const unavailable = t("en", "magic.set_frequency.unavailable");
    // Not in the offered list.
    let r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 16 }));
    expect(r.headline).toBe(unavailable);
    // Choice disallowed by the plan config.
    mocks.frequencyOptions.mockResolvedValueOnce({
      options: [{ unit: "WEEK", count: 8 }, { unit: "WEEK", count: 12 }],
      allowChoice: false,
    });
    r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(unavailable);
    // Customer already moved to 12 weeks (or slower) since the email.
    mocks.contract.billingIntervalCount = 12;
    mocks.contract.intervalWeeks = 12;
    r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(unavailable);
    // Malformed params.
    mocks.contract.billingIntervalCount = 8;
    r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK" }));
    expect(r.headline).toBe(unavailable);
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
  });

  it("classification: MUTATING (setup-gated), LOCK-blocked, PREPARING-blocked", async () => {
    mocks.setupMode.value = true;
    let r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(t("en", "portal.setup.title"));
    mocks.setupMode.value = false;

    mocks.resolveLockState.mockResolvedValue({ locked: true, until: DAY("2026-09-01"), lockDays: 30 });
    r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(t("en", "magic.locked"));
    const d = await describeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(d.lockedResult?.headline).toBe(t("en", "magic.locked"));
    mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });

    mocks.isPreparingOrder.mockResolvedValueOnce(true);
    r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(t("en", "magic.preparing"));
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
  });
});

// ── Banner ───────────────────────────────────────────────────────────────────

describe("portal home cancel-intent banner", () => {
  const applicable = {
    skip: true,
    delay: true,
    slower: { unit: "WEEK" as const, count: 12 },
    downsize: true,
    pause: true,
  };
  const intent = {
    sessionId: "sess_1",
    reason: "TOO_MUCH_PRODUCT",
    step: "saves" as const,
    completedAt: NOW,
  };

  it("renders the reason-matched actions as dispatcher forms (csrf, return_to) + links; DOWNSIZE is a link; the cancel link is plain", () => {
    const html = intentBannerHtml({
      locale: "en",
      contract: { id: "ctr_1", nextBillingDate: DAY("2026-09-10") },
      intent,
      applicable,
      csrf: "csrf_1",
      preview: null,
      supportAvailable: true,
    });
    expect(html).toContain('class="cxs-banner cxs-intent"');
    expect(html).toContain(t("en", "portal.intent.title"));
    // Order = intentActionsFor(TOO_MUCH_PRODUCT): skip, delay, slower, downsize.
    const iSkip = html.indexOf("/api/skip");
    const iDelay = html.indexOf("/api/delay");
    const iFreq = html.indexOf("/api/frequency");
    const iManage = html.indexOf("/subscription/ctr_1");
    expect(iSkip).toBeGreaterThan(-1);
    expect(iDelay).toBeGreaterThan(iSkip);
    expect(iFreq).toBeGreaterThan(iDelay);
    expect(iManage).toBeGreaterThan(iFreq);
    expect(html).toContain('name="_csrf" value="csrf_1"');
    expect(html).toContain('name="return_to" value="/"');
    expect(html).toContain('name="weeks" value="3"');
    expect(html).toContain('name="frequency" value="12:WEEK"');
    expect(html).toContain('name="expected_next" value="' + DAY("2026-09-10").toISOString());
    expect(html).toContain("every 12 weeks");
    expect(html).toContain("/account#cxs-support");
    expect(html).toContain("/cancel/ctr_1");
    expect(html).toContain(t("en", "portal.intent.cancel_link"));
    // No pause for TOO_MUCH_PRODUCT (not in its mapping) even though applicable.
    expect(html).not.toContain("/api/pause");
    // Only .cxs-* classes.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
  });

  it("drops inapplicable actions and renders nothing when no action + no support", () => {
    const html = intentBannerHtml({
      locale: "en",
      contract: { id: "ctr_1", nextBillingDate: null },
      intent,
      applicable: { skip: false, delay: false, slower: null, downsize: false, pause: false },
      csrf: "c",
      preview: null,
      supportAvailable: false,
    });
    expect(html).toBe("");
  });

  it("findBannerIntent honours intentBannerDays, skips demo / scheduled / non-live contracts, picks the newest intent", async () => {
    const c1 = { ...mocks.contract, id: "ctr_1" } as never;
    expect(await findBannerIntent([c1], { now: NOW, bannerDays: 0 })).toBeNull();
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
    const hit = await findBannerIntent([c1], { now: NOW, bannerDays: 14 });
    expect(hit?.intent.sessionId).toBe("sess_1");
    const maxAge = (mocks.sessionFindFirst.mock.calls[0][0] as { where: unknown }).where;
    expect(maxAge).toEqual({ contractId: "ctr_1" });
    // 15 days old → outside the banner window.
    mocks.sessionFindFirst.mockResolvedValueOnce({
      ...mocks.session,
      completedAt: new Date(NOW.getTime() - 15 * 86_400_000),
    });
    expect(await findBannerIntent([c1], { now: NOW, bannerDays: 14 })).toBeNull();
    // A pause taken after the abandoned session = decided → no banner;
    // paused before opening the flow → still a candidate.
    expect(
      await findBannerIntent(
        [{ ...mocks.contract, id: "ctr_1", status: "PAUSED", pausedAt: new Date(NOW.getTime() - H) } as never],
        { now: NOW, bannerDays: 14 },
      ),
    ).toBeNull();
    expect(
      await findBannerIntent(
        [{ ...mocks.contract, id: "ctr_1", status: "PAUSED", pausedAt: new Date(NOW.getTime() - 10 * 86_400_000) } as never],
        { now: NOW, bannerDays: 14 },
      ),
    ).not.toBeNull();
    // Demo / cancelled / scheduled never query.
    vi.clearAllMocks();
    await findBannerIntent(
      [
        { ...mocks.contract, id: "d", isDemo: true } as never,
        { ...mocks.contract, id: "x", status: "CANCELLED" } as never,
        { ...mocks.contract, id: "s", cancelScheduledAt: NOW } as never,
      ],
      { now: NOW, bannerDays: 14 },
    );
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
  });

  it("portal parity: a PAUSED contract's banner never posts /api/frequency (ACTIVE_ONLY in the dispatcher) nor /api/pause", async () => {
    const ctx = {
      shopId: "shop_1",
      tz: TZ,
      locale: "en",
      csrf: "c",
      preview: null,
      isPreview: true,
      bannerDays: 14,
      downsizeEnabled: true,
      preparingByContract: new Map<string, boolean>(),
      supportAvailable: true,
      now: NOW,
    };
    mocks.session.reason = "TOO_EXPENSIVE";
    const html = await renderIntentBanner(
      [{ ...mocks.contract, status: "PAUSED", pausedAt: new Date(NOW.getTime() - 10 * 86_400_000), nextBillingDate: null } as never],
      ctx,
    );
    expect(html).toContain("cxs-intent"); // "talk to us" + cancel link only
    expect(html).not.toContain("/api/frequency");
    expect(html).not.toContain("/api/pause");
    // The portal dispatcher indeed refuses frequency/pause for PAUSED.
    const dispatcher = readFileSync(new URL("../app/routes/proxy.api.$action.tsx", import.meta.url), "utf8");
    const activeOnly = dispatcher.slice(dispatcher.indexOf("const ACTIVE_ONLY"), dispatcher.indexOf("if (ACTIVE_ONLY.has(actionName)"));
    expect(activeOnly).toContain('"frequency"');
    expect(activeOnly).toContain('"pause"');
    // …and the SET_FREQUENCY verb refuses PAUSED too (one truth).
    mocks.contract.status = "PAUSED";
    const r = await executeMagicAction(payload("SET_FREQUENCY", { unit: "WEEK", count: 12 }));
    expect(r.headline).toBe(t("en", "magic.set_frequency.unavailable"));
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
    mocks.contract.status = "ACTIVE";
    mocks.session.reason = "TOO_MUCH_PRODUCT";
  });

  it("renderIntentBanner logs cancel.intent_banner_shown once per session per day for real customers, never in preview", async () => {
    const ctx = {
      shopId: "shop_1",
      tz: TZ,
      locale: "en",
      csrf: "c",
      preview: null,
      isPreview: false,
      bannerDays: 14,
      downsizeEnabled: true,
      preparingByContract: new Map<string, boolean>(),
      supportAvailable: true,
      now: NOW,
    };
    const html = await renderIntentBanner([mocks.contract as never], ctx);
    expect(html).toContain("cxs-intent");
    const ev = mocks.logEvent.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "cancel.intent_banner_shown",
    );
    expect(ev).toBeDefined();
    expect((ev![0] as { payload: unknown; source: string }).payload).toMatchObject({
      sessionId: "sess_1",
      reason: "TOO_MUCH_PRODUCT",
    });
    // Already logged today → no second event.
    vi.clearAllMocks();
    mocks.subscriberEventFindFirst.mockResolvedValueOnce({ id: "ev_1" });
    await renderIntentBanner([mocks.contract as never], ctx);
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // Preview: banner renders, no event.
    vi.clearAllMocks();
    await renderIntentBanner([mocks.contract as never], { ...ctx, isPreview: true });
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // Preparing contract: no skip/delay forms.
    vi.clearAllMocks();
    const prep = await renderIntentBanner([mocks.contract as never], {
      ...ctx,
      preparingByContract: new Map([["ctr_1", true]]),
    });
    expect(prep).not.toContain("/api/skip");
    expect(prep).toContain("/api/frequency");
  });

  it("portal.intent.* copy lives outside the growth-copy scope and the home route wires the banner outside the growth helpers", () => {
    const route = readFileSync(
      new URL("../app/routes/proxy._index.tsx", import.meta.url),
      "utf8",
    );
    expect(route).toContain("renderIntentBanner(contracts, {");
    expect(route).toContain("cancelFlow.intentBannerDays");
    const growth = readFileSync(
      new URL("../app/lib/portal/growth.server.ts", import.meta.url),
      "utf8",
    );
    expect(growth).not.toContain("portal.intent.");
  });

  it("the admin Cancel-flow page exposes every intent follow-up knob (settings, never constants)", () => {
    const page = readFileSync(
      new URL("../app/routes/app.cancel-flow.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain('formData.get("intentFollowupEnabled") === "true"');
    for (const key of [
      "intentFollowupHours",
      "intentFollowupChargeBufferHours",
      "intentFollowupCooldownDays",
      "intentBannerDays",
    ]) {
      expect(page).toContain(`intField("${key}")`);
      expect(page).toContain(`error={errors.${key}}`);
    }
    // The stored value is still spread first so unrendered keys carry through.
    expect(page).toContain("...previous,");
  });
});

// ── Registry / template / settings ───────────────────────────────────────────

describe("registry", () => {
  it("cancelFlow settings carry the follow-up knobs with the documented defaults", () => {
    const d = settingsSchemas.cancelFlow.parse(undefined);
    expect(d.intentFollowupEnabled).toBe(true);
    expect(d.intentFollowupHours).toBe(18);
    expect(d.intentFollowupChargeBufferHours).toBe(48);
    expect(d.intentFollowupCooldownDays).toBe(30);
    expect(d.intentBannerDays).toBe(14);
    expect(() => settingsSchemas.cancelFlow.parse({ ...d, intentFollowupHours: 0 })).toThrow();
    // Previously stored values (without the new fields) still parse.
    const legacy = { ...d } as Record<string, unknown>;
    delete legacy.intentFollowupHours;
    expect(settingsSchemas.cancelFlow.parse(legacy).intentFollowupHours).toBe(18);
  });

  it("cancel_intent_followup is a registered, customizable EMAIL template on metric 'Cellexia Cancel Intent' with a flow rationale and a placeholder-free preview", async () => {
    expect(TEMPLATES.cancel_intent_followup).toMatchObject({
      channel: "EMAIL",
      klaviyoMetric: "Cellexia Cancel Intent",
      i18nKey: "email.cancel_intent_followup",
      critical: false,
    });
    const entry = EMAIL_CATALOG.cancel_intent_followup;
    expect(entry.customizable).toBe(true);
    expect(entry.disableable).toBe(true);
    expect(entry.timing).toMatchObject({ settingsKey: "cancelFlow", path: "intentFollowupHours" });
    expect(entry.links).toContain("set_frequency_url");
    expect(entry.links).toContain("cancel_url");
    const spec = flowSpecs().find((s) => s.metric === "Cellexia Cancel Intent");
    expect(spec?.templates).toEqual(["cancel_intent_followup"]);
    expect(spec?.why.length).toBeGreaterThan(10);
    const vars = previewSampleVars("cancel_intent_followup");
    expect(vars.reason).toBe("TOO_MUCH_PRODUCT");
    const preview = await renderTemplatePreview({ template: "cancel_intent_followup", locale: "en" });
    expect(preview.html).not.toMatch(/\{[a-z0-9_]+\}/i);
    expect(preview.html).toContain("https://example.com/cancel");
    expect(preview.html).toContain("https://example.com/set-frequency");
  });

  it("the English body keeps cancelling reachable (plain cancel link) and reads the pre-composed blocks", () => {
    const body = t("en", "email.cancel_intent_followup.body");
    expect(body).toContain("{options_block}");
    expect(body).toContain("{support_line}");
    expect(body).toContain("{cancel_url}");
    expect(body).toContain("{reason_line}");
    for (const r of ["TOO_MUCH_PRODUCT", "TOO_EXPENSIVE", "NOT_SEEING_RESULTS", "TRYING_SOMETHING_ELSE", "SHIPPING_ISSUES", "OTHER", "NONE"]) {
      const key = `email.cancel_intent_followup.reason.${r}`;
      expect(t("en", key), key).not.toBe(key);
    }
  });
});
