import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 Stage D adversarial-review fixes — portal dispatcher + cancel intro
 * (second wave). Real api action, contracts service mocked (scaffold:
 * tests/portal-pause-until-ui.test.ts).
 *
 *  1. pause_extend dedupes a double-tap: the banner form embeds the resume
 *     day it was rendered against (`expected_resume`); a mismatch reports
 *     the standing hold WITHOUT a second extendPause call.
 *  2. pause_resume_date on a hold WITHOUT a resume day (admin / external
 *     pause) bounds the chosen day by the pause maximum (pausedAt +
 *     maxMonths × 30d) — pause_too_far beyond it, never an ACTIVE contract
 *     with a first order years out.
 *  3. "Resume now" confirms with the first charge day (resumed + d1 →
 *     portal.toast.resumed_date), also on the idempotent already-ACTIVE
 *     path; the banner says the first order lands in ~3 days.
 *  4. Cancel intro on a PAUSED contract without a resume day: note only, no
 *     pause CTA (acceptSave refuses PAUSE on PAUSED), Continue still there.
 *  5. "We'll remind you first" only when the reminder will be sent
 *     (resumeReminderPromised: email channel + template enabled).
 *  6. countryOptions is memoised per locale (same frozen list back).
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-pause-until-ui";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const TZ = "Europe/Zurich";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  class PauseUntilError extends Error {
    constructor(
      readonly code: string,
      readonly maxResumeAt?: Date,
    ) {
      super(`pauseUntil refused: ${code}`);
      this.name = "PauseUntilError";
    }
  }
  class SendTomorrowError extends Error {
    constructor(readonly code: string) {
      super(`sendNextOrderTomorrow refused: ${code}`);
      this.name = "SendTomorrowError";
    }
  }
  return {
    shop,
    PauseUntilError,
    SendTomorrowError,
    portalSettings: {} as Record<string, unknown>,
    pauseSettings: { maxMonths: 3 } as Record<string, unknown>,
    notifSettings: { channels: { email: true, sms: true } } as Record<string, unknown>,
    emailsSettings: { templates: {} } as Record<string, unknown>,
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    attemptFindMany: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (): Promise<void> => {}),
    pauseUntil: vi.fn(
      async (_s: string, _c: string, _resumeAt: Date, _o?: unknown): Promise<unknown> => ({}),
    ),
    extendPause: vi.fn(
      async (_s: string, _c: string, _resumeAt: Date, _o?: unknown): Promise<unknown> => ({}),
    ),
    sendNextOrderTomorrow: vi.fn(async (): Promise<unknown> => ({})),
    resumeContract: vi.fn(
      async (_s: string, _c: string, _o?: { billOn?: Date | null }): Promise<unknown> => ({}),
    ),
    maxPauseResumeAt: vi.fn(async (_shopId: string, _pausedAt: Date, _tz: string): Promise<Date> => new Date(0)),
    setDeliveryInstructions: vi.fn(
      async (_s: string, _c: string, _text: string | null, _o?: unknown): Promise<unknown> => ({}),
    ),
    createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: vi.fn(async () => []),
    },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
    billingAttempt: { findMany: mocks.attemptFindMany },
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
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        friendlyLockMessaging: false,
        delayReanchors: false,
        magicLinkTtlDays: 14,
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
        ...mocks.portalSettings,
      };
    }
    if (key === "pause") return mocks.pauseSettings;
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    if (key === "notifications") return mocks.notifSettings;
    if (key === "emails") return mocks.emailsSettings;
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: mocks.createSignedPayload,
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  PauseUntilError: mocks.PauseUntilError,
  SendTomorrowError: mocks.SendTomorrowError,
  CycleLineEditError: class extends Error {},
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  extendPause: mocks.extendPause,
  pauseContract: vi.fn(),
  pauseUntil: mocks.pauseUntil,
  removeLine: vi.fn(),
  resumeContract: mocks.resumeContract,
  maxPauseResumeAt: mocks.maxPauseResumeAt,
  sendNextOrderTomorrow: mocks.sendNextOrderTomorrow,
  setDeliveryInstructions: mocks.setDeliveryInstructions,
  setLineQuantityThisCycle: vi.fn(),
  setNextBillingDate: vi.fn(),
  skipLineThisCycle: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipLineThisCycle: vi.fn(),
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: vi.fn(),
}));

vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: vi.fn(),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: true,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession } from "~/lib/portal/session.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import { resolveToast, toastTone, TOAST_KEYS } from "~/lib/portal/layout.server";
import { pageIntro } from "~/lib/cancel/pages.server";
import { countryOptions } from "~/lib/portal/countries";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "~/lib/i18n/locales/en.json";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const enMap = en as Record<string, string>;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date();
const TODAY = shopDayStartUtc(NOW, TZ);
const NEXT_WEEK = new Date(NOW.getTime() + 7 * DAY_MS);

function isoDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function makeLine(over: Record<string, unknown> = {}) {
  return {
    id: "line_1",
    quantity: 2,
    isGift: false,
    isOneTimeAddon: false,
    sellingPlanId: "gid://shopify/SellingPlan/1",
    productId: "gid://shopify/Product/9",
    variantId: "gid://shopify/ProductVariant/111",
    title: "Serum",
    variantTitle: "Default Title",
    currentPriceCents: 5000,
    compareAtPriceCents: null,
    imageUrl: null,
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    lockDays: null,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: NEXT_WEEK,
    deliveryPriceCents: 0,
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
    ordersCount: 3,
    pausedAt: null,
    resumeAt: null,
    pausedReason: null,
    deliveryInstructions: null,
    lines: [makeLine()],
    ...over,
  };
}

/** Locked: subscribed 2 days ago under a 30-day lock plan. */
function lockedContract(over: Record<string, unknown> = {}) {
  return makeContract({
    lockDays: 30,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 2 * DAY_MS),
    ...over,
  });
}

/** PAUSED 10 days ago, resuming in 20 days. */
function pausedContract(over: Record<string, unknown> = {}) {
  return makeContract({
    status: "PAUSED",
    pausedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    resumeAt: shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ),
    nextBillingDate: null,
    ...over,
  });
}

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function licidCsrf(): Promise<string> {
  const session = await getPortalSession(
    new Request(proxyUrl("/", { logged_in_customer_id: "1" })),
  );
  return session?.csrfToken ?? "";
}

async function postAction(action: string, fields: Record<string, string> = {}): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
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

function location(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://cellexialabs.com");
}

function expectToast(response: Response, toast: string): URL {
  const url = location(response);
  expect(url.searchParams.get("toast")).toBe(toast);
  return url;
}

function setContract(contract: unknown) {
  mocks.contractFindFirst.mockResolvedValue(contract);
  mocks.contractFindUnique.mockResolvedValue(contract);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.portalSettings = {};
  mocks.pauseSettings = { maxMonths: 3 };
  mocks.notifSettings = { channels: { email: true, sms: true } };
  mocks.emailsSettings = { templates: {} };
  mocks.maxPauseResumeAt.mockResolvedValue(new Date(0));
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([
    { lockDays: 30, shopifyPlanIds: ["gid://shopify/SellingPlan/1"] },
  ]);
  mocks.attemptFindMany.mockResolvedValue([]);
  setContract(makeContract());
  mocks.pauseUntil.mockImplementation(async (_s: string, _c: string, resumeAt: Date) =>
    makeContract({ status: "PAUSED", pausedAt: NOW, resumeAt }),
  );
  mocks.extendPause.mockImplementation(async (_s: string, _c: string, resumeAt: Date) =>
    pausedContract({ resumeAt }),
  );
  mocks.sendNextOrderTomorrow.mockImplementation(async () =>
    makeContract({ nextBillingDate: addDaysTz(TODAY, 1, TZ) }),
  );
  mocks.resumeContract.mockImplementation(
    async (_s: string, _c: string, o?: { billOn?: Date | null }) =>
      makeContract({ nextBillingDate: o?.billOn ?? addDaysTz(NOW, 3, TZ) }),
  );
  mocks.setDeliveryInstructions.mockImplementation(
    async (_s: string, _c: string, text: string | null) =>
      makeContract({ deliveryInstructions: text && text.trim() ? text.trim() : null }),
  );
});


import { resumeReminderPromised } from "~/lib/notifications/promise.server";

// ── 1. pause_extend double-submit dedupe ─────────────────────────────────────

describe("pause_extend double-submit dedupe (expected_resume)", () => {
  it("a stale expected_resume (double-tap / retry / second tab) reports the standing hold without a second extendPause", async () => {
    const paused = pausedContract();
    setContract(paused);
    const current = paused.resumeAt as unknown as Date;
    // First tap: rendered against the current resume day → executes.
    const first = expectToast(
      await postAction("pause_extend", { weeks: "2", expected_resume: current.toISOString() }),
      "pause_extended",
    );
    expect(mocks.extendPause).toHaveBeenCalledTimes(1);
    const moved = shopDayStartUtc(addDaysTz(current, 14, TZ), TZ);
    expect(first.searchParams.get("d1")).toBe(isoDay(moved));
    // The hold has moved; the second request of the same tap still carries
    // the OLD day → duplicate: same success toast, the standing (moved) day,
    // no service call.
    setContract(pausedContract({ resumeAt: moved }));
    const second = expectToast(
      await postAction("pause_extend", { weeks: "2", expected_resume: current.toISOString() }),
      "pause_extended",
    );
    expect(mocks.extendPause).toHaveBeenCalledTimes(1);
    expect(second.searchParams.get("d1")).toBe(isoDay(moved));
  });

  it("a matching expected_resume (or none — legacy form) executes normally", async () => {
    const paused = pausedContract();
    setContract(paused);
    expectToast(
      await postAction("pause_extend", {
        weeks: "4",
        expected_resume: (paused.resumeAt as unknown as Date).toISOString(),
      }),
      "pause_extended",
    );
    expectToast(await postAction("pause_extend", { weeks: "4" }), "pause_extended");
    expect(mocks.extendPause).toHaveBeenCalledTimes(2);
  });

  it("the PAUSED banner embeds expected_resume on every extend form (source pin)", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    const form = src.slice(src.indexOf('api(ctx, "pause_extend")'), src.indexOf('api(ctx, "pause_extend")') + 400);
    expect(form).toContain('["expected_resume", contract.resumeAt?.toISOString() ?? ""]');
    expect(src).toContain('t(locale, "portal.pause.resume_now_hint")');
    expect(enMap["portal.pause.resume_now_hint"]).toContain("3 days");
  });
});

// ── 2. pause_resume_date without a resume day: bounded ───────────────────────

describe("pause_resume_date on a hold WITHOUT a resume day (admin / external pause)", () => {
  it("bounds the chosen day by the pause maximum from the pause start: pause_too_far + the latest day beyond it, resume_on within it", async () => {
    const pausedAt = new Date(NOW.getTime() - 10 * DAY_MS);
    setContract(pausedContract({ resumeAt: null, pausedAt }));
    const max = shopDayStartUtc(addDaysTz(pausedAt, 90, TZ), TZ);
    mocks.maxPauseResumeAt.mockResolvedValue(max);

    const farOut = addDaysTz(NOW, 5 * 365, TZ);
    const refused = expectToast(await postAction("pause_resume_date", { date: isoDay(farOut) }), "pause_too_far");
    expect(refused.searchParams.get("d1")).toBe(isoDay(max));
    expect(mocks.resumeContract).not.toHaveBeenCalled();
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(mocks.maxPauseResumeAt).toHaveBeenCalledWith("shop_1", pausedAt, TZ);

    const within = shopDayStartUtc(addDaysTz(NOW, 30, TZ), TZ);
    const ok = expectToast(await postAction("pause_resume_date", { date: isoDay(within) }), "resume_on");
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
    const opts = mocks.resumeContract.mock.calls[0][2] as { billOn?: Date };
    expect(opts.billOn?.getTime()).toBe(within.getTime());
    expect(ok.searchParams.get("d1")).toBe(isoDay(within));
  });

  it("with a resume day the existing direction dispatch is untouched (no max lookup on the earlier path)", async () => {
    const paused = pausedContract();
    setContract(paused);
    const earlier = shopDayStartUtc(addDaysTz(NOW, 5, TZ), TZ);
    expectToast(await postAction("pause_resume_date", { date: isoDay(earlier) }), "resume_on");
    expect(mocks.maxPauseResumeAt).not.toHaveBeenCalled();
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
  });
});

// ── 3. "Resume now" names the first charge day ───────────────────────────────

describe("resume confirmation carries the first charge day", () => {
  it("resume → resumed + d1 (the service's nextBillingDate, ~3 days out); already ACTIVE → resumed + the standing next order", async () => {
    setContract(pausedContract());
    const url = expectToast(await postAction("resume", {}), "resumed");
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
    expect(url.searchParams.get("d1")).toBe(isoDay(addDaysTz(NOW, 3, TZ)));
    expect(url.searchParams.get("undo")).toBeNull();

    setContract(makeContract());
    const idem = expectToast(await postAction("resume", {}), "resumed");
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
    expect(idem.searchParams.get("d1")).toBe(isoDay(NEXT_WEEK));
  });

  it("resumed + d1 renders the dated copy; without d1 the classic line; never an Undo form", () => {
    expect(TOAST_KEYS.has("resumed")).toBe(true);
    const dated = resolveToast(
      new Request("https://cellexialabs.com/x?toast=resumed&d1=2026-10-01&undo=UNDOTOKEN&cid=ctr_1"),
      "en",
      { csrfToken: "csrf", preview: null, contractIds: ["ctr_1"] } as never,
    );
    expect(dated?.toast.text).toBe(
      enMap["portal.toast.resumed_date"].replace("{date}", "October 1, 2026"),
    );
    expect(dated?.toast.text).toContain("October 1, 2026");
    expect(dated?.toast.html).toBeUndefined();
    const plain = resolveToast(new Request("https://cellexialabs.com/x?toast=resumed"), "en");
    expect(plain?.toast.text).toBe(enMap["portal.toast.resumed"]);
    // Malformed d1 falls back to the classic line.
    const bad = resolveToast(new Request("https://cellexialabs.com/x?toast=resumed&d1=soon"), "en");
    expect(bad?.toast.text).toBe(enMap["portal.toast.resumed"]);
  });
});

// ── 4. Cancel intro on PAUSED without a resume day ───────────────────────────

describe("cancel intro on a PAUSED contract without a resume day", () => {
  const introArgs = {
    locale: "en",
    csrf: "tok",
    contractId: "c_1",
    firstName: "Ana",
    summary: {
      nextBillingDate: null,
      tenureDays: 30,
      ordersCount: 3,
      yearlySavingsCents: 0,
      currencyCode: "CHF",
    } as never,
    tz: TZ,
    copyVariant: "a" as const,
    pauseMonths: 2,
    showError: false,
  };

  it("renders the no-date note and NO pause CTA (acceptSave would refuse PAUSE); Continue and keep stay", () => {
    const page = pageIntro({ ...introArgs, paused: { resumeAt: null, choices: [] } });
    expect(page.body).toContain(enMap["cancel.intro.paused_note_nodate"]);
    expect(page.body).not.toContain('name="intent" value="pause"');
    expect(page.body).not.toContain('name="intent" value="extend_pause"');
    expect(page.body).toContain('name="intent" value="continue"');
    expect(page.body).toContain(enMap["cancel.intro.keep_cta"]);
    // A hold with a resume day keeps the dated note.
    const dated = pageIntro({
      ...introArgs,
      paused: { resumeAt: new Date("2026-10-01T22:00:00Z"), choices: [] },
    });
    expect(dated.body).toContain("Your subscription is paused until");
    expect(dated.body).not.toContain('name="intent" value="pause"');
  });

  it("the cancel loader builds `paused` for EVERY PAUSED contract (source pin)", () => {
    const src = readSource("app/routes/proxy.cancel.$id.tsx");
    expect(src).toContain("resumeAt: contract.resumeAt ?? null,");
    expect(src).not.toContain('contract.status === "PAUSED" && contract.resumeAt');
  });
});

// ── 5. "We'll remind you first" only when the reminder is actually sent ─────

describe("resumeReminderPromised", () => {
  it("true with the email channel on and no template override; false when the merchant disables either", async () => {
    mocks.notifSettings = { channels: { email: true, sms: true } };
    mocks.emailsSettings = { templates: {} };
    expect(await resumeReminderPromised("shop_1")).toBe(true);
    mocks.emailsSettings = { templates: { resume_reminder: { enabled: false } } };
    expect(await resumeReminderPromised("shop_1")).toBe(false);
    mocks.emailsSettings = { templates: { resume_reminder: { enabled: true } } };
    expect(await resumeReminderPromised("shop_1")).toBe(true);
    mocks.notifSettings = { channels: { email: false, sms: true } };
    expect(await resumeReminderPromised("shop_1")).toBe(false);
    // A broken settings read never promises.
    mocks.notifSettings = null as never;
    expect(await resumeReminderPromised("shop_1")).toBe(false);
  });

  it("the cancel flow picks the *_noremind copy when the promise cannot be kept (catalog + source pins)", () => {
    for (const key of [
      "cancel.saved.pause_noremind",
      "cancel.saved.extend_pause_noremind",
      "cancel.saves.pause.desc_noremind",
    ]) {
      expect(enMap[key]).toBeTruthy();
      expect(enMap[key].toLowerCase()).not.toContain("remind");
    }
    for (const key of ["cancel.saved.pause", "cancel.saved.extend_pause", "cancel.saves.pause.desc"]) {
      expect(enMap[key].toLowerCase()).toContain("remind");
    }
    const step = readSource("app/routes/proxy.cancel.$id.$step.tsx");
    expect(step).toContain('"cancel.saved.pause_noremind"');
    expect(step).toContain('"cancel.saved.extend_pause_noremind"');
    expect(step.match(/resumeReminder: await resumeReminderPromised\(shop\.id\)/g)?.length).toBe(2);
    const pages = readSource("app/lib/cancel/pages.server.ts");
    expect(pages).toContain('resumeReminder ? "cancel.saves.pause.desc" : "cancel.saves.pause.desc_noremind"');
  });
});

// ── 6. countryOptions memoised ───────────────────────────────────────────────

describe("countryOptions memoisation", () => {
  it("returns the same frozen list per locale (built once), still sorted with every code", () => {
    const a = countryOptions("de");
    const b = countryOptions("de");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.find((c) => c.code === "CH")?.name).toBe("Schweiz");
    expect(countryOptions("en")).not.toBe(a);
  });
});
