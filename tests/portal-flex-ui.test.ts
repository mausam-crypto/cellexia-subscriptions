import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stage D flexibility — portal surfaces (v1.28.0, P2.6 / P2.7 / P2.8 / P2.9):
 *
 *  1. Pure helpers (app/lib/portal/flex.server.ts): pause-extend choices are
 *     clamped by the pause maximum measured from the pause START (as
 *     `extendPause` measures it), deduped and sorted, empty without a resume
 *     day; pause-until bounds = tomorrow … maxMonths × 30 days; "already
 *     out" only once the prediction passed AND the next order is more than a
 *     day away; the supply meter never says 0 and is null once passed.
 *  2. Toasts: paused_until / pause_extended / pause_too_far are date-aware
 *     and never carry an Undo form; send_tomorrow_done is date-aware and
 *     DOES carry the Undo form; refusals are alerts.
 *  3. Rendering (real detail loader, services mocked): the PAUSED banner
 *     offers Resume now + the merchant's extend choices with exact dates;
 *     the pause card offers the date picker + reason select; the "already
 *     out" banner posts send_tomorrow only when the prediction has passed;
 *     the supply meter shows an estimate while ahead; the delivery
 *     instructions card renders the mirrored note and a clear form; the
 *     address form gained the company field.
 *  4. SMS UNDO reads per-line edits from their own events.
 *  5. Copy hygiene: none of the new portal copy names cancellation.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-flex-ui";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const SHOP_DOMAIN = "cellexia.myshopify.com";
const TZ = "Europe/Zurich";
const DAY_MS = 86_400_000;

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
    currencyCode: "CHF",
  };
  return {
    shop,
    growth: {} as Record<string, unknown>,
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (): Promise<void> => {}),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findMany: mocks.contractFindMany,
    },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    dunningCase: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
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
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") {
      return {
        contextualPrompts: false,
        allowAddProducts: false,
        otpCodeTtlMinutes: 10,
        sessionTtlDays: 30,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
        perLineCycleEdits: false,
      };
    }
    if (key === "lifecycle") return { milestoneGiftCycle: 4, rewardsUnlockDay: 90 };
    if (key === "pause") return { maxMonths: 3 };
    if (key === "portalGrowth") {
      return {
        homeValueCard: false,
        addonUpsell: false,
        postActionUpsell: false,
        concessionLadder: false,
        cadenceNudge: false,
        runoutPrompt: true,
        supplyMeter: true,
        ...mocks.growth,
      };
    }
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    if (key === "dunning") return { preExpiryNoticeDays: 14, customerRetryCooldownMinutes: 30 };
    if (key === "cancelFlow") return {};
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: false,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

vi.mock("~/lib/graphql/paymentMethods.server", () => ({
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
}));

import {
  alreadyOut,
  daysOfSupplyLeft,
  pauseExtendChoices,
  pauseUntilBounds,
} from "~/lib/portal/flex.server";
import { resolveToast, TOAST_ALERT_KEYS, TOAST_KEYS } from "~/lib/portal/layout.server";
import { undoSpecFromEvent, UNDOABLE_EVENT_TYPES } from "~/lib/portal/undo.server";
import { loader as subscriptionLoader } from "~/routes/proxy.subscription.$id";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";

// ── 1. Pure helpers ──────────────────────────────────────────────────────────

describe("pauseExtendChoices", () => {
  const now = new Date("2026-08-17T10:00:00Z");
  const day = (offset: number) => shopDayStartUtc(new Date(now.getTime() + offset * DAY_MS), TZ);

  it("adds each week choice to the CURRENT resume day, keeping only those inside maxMonths × 30 days of the pause start", () => {
    // Paused 10 days ago, resuming in 20 days, max 90 days from pausedAt ⇒
    // the latest allowed day is +80 days from now: +2w (34) and +4w (48) fit.
    const choices = pauseExtendChoices({
      resumeAt: day(20),
      pausedAt: day(-10),
      weeks: [4, 2, 2],
      maxMonths: 3,
      tz: TZ,
      now,
    });
    expect(choices.map((c) => c.weeks)).toEqual([2, 4]);
    expect(choices[0].resumeAt.getTime()).toBe(shopDayStartUtc(addDaysTz(day(20), 14, TZ), TZ).getTime());
    expect(choices[1].resumeAt.getTime()).toBe(shopDayStartUtc(addDaysTz(day(20), 28, TZ), TZ).getTime());
    // Paused 80 days ago: only +2w still fits (max = +10 days from now, resume +5).
    expect(
      pauseExtendChoices({ resumeAt: day(5), pausedAt: day(-80), weeks: [2, 4], maxMonths: 3, tz: TZ, now }).map(
        (c) => c.weeks,
      ),
    ).toEqual([]);
    expect(
      pauseExtendChoices({ resumeAt: day(2), pausedAt: day(-70), weeks: [1, 2, 4], maxMonths: 3, tz: TZ, now }).map(
        (c) => c.weeks,
      ),
    ).toEqual([1, 2]);
  });

  it("is empty without a resume day, ignores junk week values and falls back to the registry default list", () => {
    expect(pauseExtendChoices({ resumeAt: null, pausedAt: day(-1), weeks: [2], maxMonths: 3, tz: TZ, now })).toEqual([]);
    expect(
      pauseExtendChoices({ resumeAt: day(5), pausedAt: day(-1), weeks: [0, -3, 2.5, "4", 99] as unknown[], maxMonths: 3, tz: TZ, now }),
    ).toEqual([]);
    expect(
      pauseExtendChoices({ resumeAt: day(5), pausedAt: day(-1), weeks: undefined, maxMonths: 3, tz: TZ, now }).map((c) => c.weeks),
    ).toEqual([2, 4]);
  });
});

describe("pauseUntilBounds / alreadyOut / daysOfSupplyLeft", () => {
  const now = new Date("2026-08-17T10:00:00Z");
  const today = shopDayStartUtc(now, TZ);

  it("bounds a new hold to tomorrow … maxMonths × 30 days (shop-tz day starts)", () => {
    const b = pauseUntilBounds({ maxMonths: 2, tz: TZ, now });
    expect(b.min.getTime()).toBe(addDaysTz(today, 1, TZ).getTime());
    expect(b.max.getTime()).toBe(shopDayStartUtc(addDaysTz(now, 60, TZ), TZ).getTime());
  });

  it("'already out' needs a passed prediction AND a next order more than a day away", () => {
    const yesterday = new Date(now.getTime() - DAY_MS);
    expect(alreadyOut(yesterday, new Date(now.getTime() + 5 * DAY_MS), now, TZ)).toBe(true);
    // Prediction still ahead — the standing run-out prompt's territory.
    expect(alreadyOut(new Date(now.getTime() + DAY_MS), new Date(now.getTime() + 5 * DAY_MS), now, TZ)).toBe(false);
    // Next order already tomorrow — nothing to pull.
    expect(alreadyOut(yesterday, addDaysTz(today, 1, TZ), now, TZ)).toBe(false);
    expect(alreadyOut(null, new Date(now.getTime() + 5 * DAY_MS), now, TZ)).toBe(false);
    expect(alreadyOut(yesterday, null, now, TZ)).toBe(false);
  });

  it("the supply meter rounds up, never says 0, and is null once the prediction passed", () => {
    expect(daysOfSupplyLeft(new Date(now.getTime() + 3.2 * DAY_MS), now)).toBe(4);
    expect(daysOfSupplyLeft(new Date(now.getTime() + 0.1 * DAY_MS), now)).toBe(1);
    expect(daysOfSupplyLeft(new Date(now.getTime() - 1), now)).toBeNull();
    expect(daysOfSupplyLeft(null, now)).toBeNull();
  });
});

// ── 2. Toasts ────────────────────────────────────────────────────────────────

describe("flexibility toasts", () => {
  const undoCtx = { csrfToken: "csrf", previewToken: null, contractIds: new Set(["ctr_1"]) };
  const req = (params: Record<string, string>) =>
    new Request(`https://cellexialabs.com${PORTAL_PROXY_BASE}/subscription/ctr_1?${new URLSearchParams(params)}`);

  it("registers every new key, with refusals as alerts", () => {
    for (const key of [
      "paused_until",
      "pause_extended",
      "pause_too_far",
      "pause_date_past",
      "send_tomorrow_done",
      "send_tomorrow_soon",
      "send_tomorrow_payment",
      "instructions_saved",
      "instructions_cleared",
    ]) {
      expect(TOAST_KEYS.has(key), key).toBe(true);
    }
    for (const key of ["pause_too_far", "pause_date_past", "send_tomorrow_soon", "send_tomorrow_payment"]) {
      expect(TOAST_ALERT_KEYS.has(key), key).toBe(true);
    }
    expect(TOAST_ALERT_KEYS.has("paused_until")).toBe(false);
    expect(TOAST_ALERT_KEYS.has("send_tomorrow_done")).toBe(false);
  });

  it("pause toasts name the exact day and never carry an Undo form (the banner owns reversal)", () => {
    const paused = resolveToast(req({ toast: "paused_until", d1: "2026-09-10", undo: "a.b", cid: "ctr_1" }), "en", undoCtx);
    expect(paused?.toast.text).toMatch(/10 September 2026|September 10, 2026/);
    expect(paused?.toast.html).toBeUndefined();
    expect(paused?.toast.tone).toBe("status");
    const extended = resolveToast(req({ toast: "pause_extended", d1: "2026-09-24" }), "en", undoCtx);
    expect(extended?.toast.text).toMatch(/24 September 2026|September 24, 2026/);
    const tooFar = resolveToast(req({ toast: "pause_too_far", d1: "2026-11-15" }), "en", undoCtx);
    expect(tooFar?.toast.text).toMatch(/15 November 2026|November 15, 2026/);
    expect(tooFar?.toast.tone).toBe("alert");
    // Malformed day ⇒ the plain copy, never a crash.
    expect(resolveToast(req({ toast: "paused_until", d1: "2026-99-99" }), "en", undoCtx)?.toast.text).toBe(
      "Your subscription is paused — it resumes automatically on the day you chose.",
    );
  });

  it("send_tomorrow_done names both dates and carries the Undo form", () => {
    const done = resolveToast(
      req({ toast: "send_tomorrow_done", d1: "2026-08-18", d2: "2026-09-15", undo: "a.b", cid: "ctr_1" }),
      "en",
      undoCtx,
    );
    expect(done?.toast.text).toMatch(/18 August 2026|August 18, 2026/);
    expect(done?.toast.text).toMatch(/15 September 2026|September 15, 2026/);
    expect(done?.toast.html).toContain('name="undo_token"');
    expect(done?.toast.html).toContain("/api/undo");
    const dateOnly = resolveToast(req({ toast: "send_tomorrow_done", d1: "2026-08-18" }), "en", null);
    expect(dateOnly?.toast.text).toMatch(/^Done — your next order is now on (18 August 2026|August 18, 2026)\.$/);
  });
});

// ── 3. Rendering ─────────────────────────────────────────────────────────────

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  url.searchParams.set("logged_in_customer_id", "1");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

const NOW = new Date();

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    lockDays: null,
    nextBillingDate: new Date(NOW.getTime() + 12 * DAY_MS),
    resumeAt: null,
    pausedAt: null,
    pausedReason: null,
    predictedEmptyDate: null,
    deliveryInstructions: null,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    deliveryAddress: null,
    cardBrand: null,
    cardLast4: null,
    cardExpiryMonth: null,
    cardExpiryYear: null,
    paymentMethodId: null,
    ordersCount: 3,
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
    lines: [
      {
        id: "line_1",
        productId: "p1",
        variantId: "v1",
        title: "Cellexia Serum",
        variantTitle: "Default Title",
        quantity: 1,
        currentPriceCents: 1000,
        compareAtPriceCents: null,
        isGift: false,
        isOneTimeAddon: false,
        imageUrl: null,
        skippedCycleIndex: null,
        cycleQuantityOverride: null,
        cycleQuantityOverrideIndex: null,
      },
    ],
    ...over,
  };
}

async function renderDetail(contract: unknown, params: Record<string, string> = {}): Promise<string> {
  mocks.contractFindFirst.mockResolvedValue(contract);
  const response = (await subscriptionLoader({
    request: new Request(proxyUrl("/subscription/ctr_1", params)),
    params: { id: "ctr_1" },
    context: {},
  } as never)) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.growth = {};
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
});

describe("subscription page — Stage D surfaces", () => {
  it("PAUSED: the banner offers Resume now plus the extend choices with their exact new dates", async () => {
    const resumeAt = shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ);
    const html = await renderDetail(
      makeContract({ status: "PAUSED", pausedAt: new Date(NOW.getTime() - 5 * DAY_MS), resumeAt, nextBillingDate: null }),
    );
    expect(html).toContain("/api/resume");
    expect(html).toContain("/api/pause_extend");
    expect(html).toContain('name="weeks" value="2"');
    expect(html).toContain('name="weeks" value="4"');
    expect(html).toContain("Need a little longer?");
    const plus2 = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: TZ }).format(addDaysTz(resumeAt, 14, TZ));
    expect(html).toContain(`+2 week(s) — resume ${plus2}`);
    // A paused contract never shows the ACTIVE-only pause card or the
    // "already out" branch, but keeps the delivery instructions form.
    expect(html).not.toContain("/api/pause_until");
    expect(html).not.toContain("/api/send_tomorrow");
    expect(html).toContain("/api/delivery_instructions");
  });

  it("PAUSED without a resume day: Resume now only (nothing to extend from)", async () => {
    const html = await renderDetail(makeContract({ status: "PAUSED", pausedAt: NOW, resumeAt: null, nextBillingDate: null }));
    expect(html).toContain("/api/resume");
    expect(html).not.toContain("/api/pause_extend");
  });

  it("ACTIVE: the pause card offers month buttons AND a date picker with reason, bounded like the service", async () => {
    const html = await renderDetail(makeContract());
    expect(html).toContain("/api/pause_until");
    expect(html).toContain('type="date" name="date"');
    const min = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(addDaysTz(shopDayStartUtc(NOW, TZ), 1, TZ));
    expect(html).toContain(`min="${min}"`);
    expect(html).toContain('name="reason"');
    for (const reason of ["TRAVEL", "TOO_MUCH", "BUDGET", "OTHER"]) {
      expect(html).toContain(`<option value="${reason}">`);
    }
    expect(html).toContain('<option value="">Prefer not to say</option>');
    // The months path stays.
    expect(html).toContain('name="months" value="1"');
  });

  it("ACTIVE with a passed prediction: the 'already out' banner posts send_tomorrow (no supply meter, no move-up prompt)", async () => {
    const html = await renderDetail(makeContract({ predictedEmptyDate: new Date(NOW.getTime() - 2 * DAY_MS) }));
    expect(html).toContain("/api/send_tomorrow");
    expect(html).toContain("Send my next order tomorrow");
    expect(html).toContain('name="expected_next"');
    expect(html).not.toContain("of product left");
    expect(html).not.toContain("Move it up to");
  });

  it("ACTIVE with a prediction ahead: the supply meter shows an estimate and the 'already out' banner is absent", async () => {
    const html = await renderDetail(makeContract({ predictedEmptyDate: new Date(NOW.getTime() + 4.5 * DAY_MS) }));
    expect(html).toContain('class="cxs-supply cxs-muted cxs-small"');
    // Named after the (single) recurring product — P2.9 copy.
    expect(html).toContain("About 5 day(s) of Cellexia Serum left");
    expect(html).toContain("Estimate based on how often you order");
    expect(html).not.toContain("/api/send_tomorrow");
  });

  it("the merchant toggles hide the meter and the 'already out' branch", async () => {
    mocks.growth = { supplyMeter: false, runoutPrompt: false };
    const ahead = await renderDetail(makeContract({ predictedEmptyDate: new Date(NOW.getTime() + 4.5 * DAY_MS) }));
    expect(ahead).not.toContain("left, at your usual pace");
    const passed = await renderDetail(makeContract({ predictedEmptyDate: new Date(NOW.getTime() - 2 * DAY_MS) }));
    expect(passed).not.toContain("/api/send_tomorrow");
  });

  it("delivery instructions: the card renders the mirrored note, the cap and a clear form; the address form has the company field", async () => {
    const html = await renderDetail(makeContract({ deliveryInstructions: "Leave with <neighbour> at no. 12" }));
    expect(html).toContain("/api/delivery_instructions");
    expect(html).toContain('maxlength="250"');
    expect(html).toContain("Leave with &lt;neighbour&gt; at no. 12");
    expect(html).toContain("Up to 250 characters");
    expect(html).toContain("Remove instructions");
    expect(html).toContain('name="company"');
    const empty = await renderDetail(makeContract());
    expect(empty).not.toContain("Remove instructions");
  });

  it("the paused_until toast renders with the chosen day", async () => {
    const html = await renderDetail(
      makeContract({ status: "PAUSED", pausedAt: NOW, resumeAt: shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ), nextBillingDate: null }),
      { toast: "paused_until", d1: "2026-09-10" },
    );
    expect(html).toMatch(/paused until (10 September 2026|September 10, 2026)/);
  });
});

// ── 4. SMS UNDO for per-line edits ───────────────────────────────────────────

describe("undoSpecFromEvent — per-line cycle edits", () => {
  it("maps cycle.line_skipped and cycle.line_quantity_set from their own payloads", () => {
    expect(UNDOABLE_EVENT_TYPES).toContain("cycle.line_skipped");
    expect(UNDOABLE_EVENT_TYPES).toContain("cycle.line_quantity_set");
    expect(
      undoSpecFromEvent({ type: "cycle.line_skipped", payload: { lineId: "line_1", cycleIndex: 7, title: "Serum" } }),
    ).toEqual({ kind: "line_skip", lineId: "line_1", cycleIndex: 7 });
    // Plan 2 → 1 this order: previous override null, override 1.
    expect(
      undoSpecFromEvent({
        type: "cycle.line_quantity_set",
        payload: { lineId: "line_1", cycleIndex: 7, qty: 1, from: 2, planQuantity: 2, cleared: false },
      }),
    ).toEqual({ kind: "line_qty_once", lineId: "line_1", cycleIndex: 7, previousOverride: null, override: 1 });
    // 3 (override) → back to plan 2: previous override 3, override null.
    expect(
      undoSpecFromEvent({
        type: "cycle.line_quantity_set",
        payload: { lineId: "line_1", cycleIndex: 7, qty: 2, from: 3, planQuantity: 2, cleared: true },
      }),
    ).toEqual({ kind: "line_qty_once", lineId: "line_1", cycleIndex: 7, previousOverride: 3, override: null });
    // Junk payload ⇒ nothing to undo (never a crash).
    expect(undoSpecFromEvent({ type: "cycle.line_skipped", payload: { lineId: 42 } })).toBeNull();
  });
});

// ── 5. Copy hygiene + source pins ────────────────────────────────────────────

describe("copy hygiene and source pins", () => {
  it("none of the new portal copy names cancellation or claims shipping the app does not control", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    const keys = Object.keys(catalog).filter(
      (k) =>
        k.startsWith("portal.pause.pick_date") ||
        k.startsWith("portal.pause.reason") ||
        k.startsWith("portal.pause.extend") ||
        k.startsWith("portal.nudge.already_out") ||
        k.startsWith("portal.supply.") ||
        k.startsWith("portal.instructions.") ||
        k.startsWith("portal.toast.paused_until") ||
        k.startsWith("portal.toast.pause_") ||
        k.startsWith("portal.toast.send_tomorrow") ||
        k.startsWith("portal.toast.instructions_"),
    );
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const key of keys) {
      expect(catalog[key], key).not.toMatch(/cancel/i);
      expect(catalog[key], key).not.toMatch(/on its way|arrives tomorrow|delivered tomorrow/i);
    }
  });

  it("the dispatcher classifies the verbs: pause_until/pause_extend lock-blocked, send_tomorrow + delivery_instructions never", () => {
    const source = readSource("app/routes/proxy.api.$action.tsx");
    const lockBlock = source.slice(source.indexOf("const LOCK_BLOCKED"), source.indexOf("let lock: LockState"));
    expect(lockBlock).toContain('"pause_until"');
    expect(lockBlock).toContain('"pause_extend"');
    expect(lockBlock).not.toContain('"send_tomorrow"');
    expect(lockBlock).not.toContain('"delivery_instructions"');
    const activeOnly = source.slice(source.indexOf("const ACTIVE_ONLY"), source.indexOf("const EDITABLE_ONLY"));
    expect(activeOnly).toContain('"pause_until"');
    expect(activeOnly).toContain('"send_tomorrow"');
    expect(source).toContain('EDITABLE_ONLY = new Set(["address", "delivery_instructions"])');
    // send_tomorrow undo = the next_date spec (SMS UNDO reads the same event).
    expect(source).toContain('kind: "next_date"');
  });

  it("the detail page keys the branches on their toggles and gates them honestly", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("growth.supplyMeter && isActive");
    // "Already out" needs the run-out toggle, ACTIVE, not preparing, no payment issue.
    const branch = source.slice(source.indexOf('"Already out" branch'), source.indexOf("Days-of-supply meter"));
    expect(branch).toContain("growth.runoutPrompt");
    expect(branch).toContain("!preparing");
    expect(branch).toContain("!dunning");
    expect(branch).toContain('api(ctx, "send_tomorrow")');
    expect(source).toContain("pausedBannerHtml(ctx");
    expect(source).toContain('api(ctx, "pause_until")');
    expect(source).toContain('api(ctx, "delivery_instructions")');
  });
});
