import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-exhaustion touches (v1.28.0, P1.9) — runPostExhaustionTouches, the
 * dunning-sweep phase that stops FAILED (exhausted) contracts from going
 * silent forever.
 *
 *  - offsets from settings.dunning.postExhaustionTouchDays (default [7, 21]),
 *    counted from the case's exhaustion (resolvedAt); nothing before the
 *    first offset; the CURRENT window only (a missed day-7 is never replayed
 *    on top of a due day-21);
 *  - template payment_failed_parked with cta_url (UPDATE_CARD), the
 *    SKIP_FAILED_CYCLE link (live card only), the resume date and dunning_dedupe;
 *  - deduped per {case, offset} in NotificationLog (SENT or SUPPRESSED);
 *  - stop conditions: contract no longer FAILED, a newer case exists, the
 *    case was resolved by the customer (CUSTOMER_SKIPPED), manual-review
 *    declines, no offsets configured;
 *  - the template registry / catalog / metric / gate: EMAIL, "Cellexia
 *    Payment Parked", in the link-bundle set, SETUP-gated by riding
 *    dunning_run; the English body carries the three exits.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  sendNotification: vi.fn(async (_i: unknown): Promise<unknown> => ({ status: "SENT" })),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  buildMagicUrl: vi.fn(async (input: { action: string }): Promise<string> => `https://magic/${input.action}`),
  buildSkipFailedCycleUrl: vi.fn(async (): Promise<string> => "https://magic/SKIP_FAILED_CYCLE"),
}));

vi.mock("~/db.server", () => ({
  default: {
    dunningCase: {
      findMany: mocks.dunningCaseFindMany,
      findFirst: mocks.dunningCaseFindFirst,
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    billingAttempt: { findUnique: mocks.attemptFindUnique },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: mocks.buildMagicUrl,
  buildSkipFailedCycleUrl: mocks.buildSkipFailedCycleUrl,
}));
// skip-resume.server (the resume-date preview) pulls the contracts plumbing;
// none of it runs here — the previewSkipResumeDate path only reads prisma.
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({ requireShop: vi.fn() }));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: vi.fn(),
  skipBillingCycle: vi.fn(),
  getBillingCycleByIndex: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  setNextBillingDate: vi.fn(),
  getContract: vi.fn(),
}));
vi.mock("~/lib/billing/release.server", () => ({ releaseHeldCycleAttempts: vi.fn() }));
vi.mock("~/lib/dunning/engine.server", () => ({ onCycleSkipped: vi.fn() }));

import {
  dueOffsetIndex,
  parkedDedupeKey,
  runPostExhaustionTouches,
} from "~/lib/dunning/post-exhaustion.server";
import { TEMPLATES } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";
import { flowSpecs } from "~/lib/klaviyo/flows.server";
import { defaultFor } from "~/lib/settings/registry.server";
import { t } from "~/lib/i18n/i18n.server";

const NOW = new Date("2026-08-17T10:00:00.000Z");
const DAY = 86_400_000;
const TZ = "Europe/Zurich";

const SHOP = { id: "shop_1", domain: "cellexia-test.myshopify.com", ianaTimezone: TZ };

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_c1",
    shopId: SHOP.id,
    shop: SHOP,
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    status: "FAILED",
    ownership: "OURS",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    locale: "en",
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: new Date(NOW.getTime() - 20 * DAY),
    deliveryPriceCents: 0,
    // A live card by default (the hard-dead variant is a separate test).
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/main",
    paymentMethodRevokedAt: null,
    cardLast4: "4242",
    cardExpiryMonth: 12,
    cardExpiryYear: 2030,
    lines: [{ currentPriceCents: 4900, quantity: 1 }],
    ...over,
  };
}

function caseFixture(daysSinceExhaustion: number, over: Record<string, unknown> = {}) {
  const resolvedAt = new Date(NOW.getTime() - daysSinceExhaustion * DAY - 3600_000);
  return {
    id: "case_1",
    contractId: "cm_c1",
    state: "EXHAUSTED",
    resolution: "EXHAUSTED",
    openedAt: new Date(resolvedAt.getTime() - 30 * DAY),
    resolvedAt,
    triggerAttemptId: "att_1",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    amountAtRiskCents: 4900,
    amountAtRiskCurrencyCode: "CHF",
    contract: contractFixture(),
    ...over,
  };
}

function sentInput(): { template: string; vars: Record<string, unknown>; contractId: string } {
  return mocks.sendNotification.mock.calls[0][0] as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "dunning") return defaultFor("dunning");
    return {};
  });
  mocks.dunningCaseFindMany.mockResolvedValue([]);
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.attemptFindUnique.mockResolvedValue({
    cycleIndex: 4,
    scheduledFor: new Date(NOW.getTime() - 40 * DAY),
  });
  mocks.sendNotification.mockResolvedValue({ status: "SENT" });
});

describe("dueOffsetIndex (pure)", () => {
  it("nothing before the first offset; the current window; the last stays due", () => {
    expect(dueOffsetIndex([7, 21], 0)).toBeNull();
    expect(dueOffsetIndex([7, 21], 6)).toBeNull();
    expect(dueOffsetIndex([7, 21], 7)).toBe(0);
    expect(dueOffsetIndex([7, 21], 20)).toBe(0);
    expect(dueOffsetIndex([7, 21], 21)).toBe(1);
    expect(dueOffsetIndex([7, 21], 400)).toBe(1);
    expect(dueOffsetIndex([], 400)).toBeNull();
  });

  it("the default setting is [7, 21] and the dedupe key is per case + offset", () => {
    expect(defaultFor("dunning").postExhaustionTouchDays).toEqual([7, 21]);
    expect(parkedDedupeKey("case_1", 1)).toBe("parked:case_1:1");
  });
});

describe("runPostExhaustionTouches", () => {
  it("queries only EXHAUSTED/EXHAUSTED cases of FAILED, non-demo, OURS contracts", async () => {
    await runPostExhaustionTouches(NOW);
    const args = mocks.dunningCaseFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      state: "EXHAUSTED",
      resolution: "EXHAUSTED",
      contract: expect.objectContaining({ status: "FAILED", isDemo: false }),
    });
  });

  it("sends the day-7 touch with the three exits and logs dunning.parked_touch", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(7)]);
    const stats = await runPostExhaustionTouches(NOW);
    expect(stats).toMatchObject({ processed: 1, sent: 1 });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const input = sentInput();
    expect(input.template).toBe("payment_failed_parked");
    expect(input.contractId).toBe("cm_c1");
    expect(input.vars.dunning_dedupe).toBe("parked:case_1:0");
    expect(input.vars.cta_url).toBe("https://magic/UPDATE_CARD");
    expect(input.vars.skip_resume_url).toBe("https://magic/SKIP_FAILED_CYCLE");
    expect(input.vars.amount).toContain("49");
    expect(input.vars.decline_human).toBeTruthy();
    expect(typeof input.vars.resume_date).toBe("string");
    expect(input.vars.resume_date).not.toBe("");
    expect(input.vars.touch_offset_days).toBe(7);
    // The three-exit "ways" block: update (intro, {cta} between), retry
    // with the same card (RETRY_PAYMENT one-tap, resolved at compose time —
    // never a nested placeholder), skip-and-continue from the resume date.
    expect(input.vars.card_dead_reason).toBe("");
    expect(input.vars.ways_intro).toBe(t("en", "email.payment_failed_parked.ways_intro_live"));
    expect(input.vars.ways_more).toContain("https://magic/RETRY_PAYMENT");
    expect(input.vars.ways_more).toContain("https://magic/SKIP_FAILED_CYCLE");
    expect(input.vars.ways_more).toContain(String(input.vars.resume_date));
    expect(input.vars.ways_more).not.toMatch(/\{[a-z_]+\}/);
    const retryMint = (mocks.buildMagicUrl.mock.calls as unknown as Array<[{ action: string; maxUses?: number }]>)
      .map((c) => c[0]).find((a) => a.action === "RETRY_PAYMENT");
    expect(retryMint?.maxUses).toBe(5);
    // The skip link is minted with a TTL covering the last offset.
    const skipArgs = (mocks.buildSkipFailedCycleUrl.mock.calls as unknown as unknown[][])[0][0] as {
      ttlDays: number;
      contractId: string;
    };
    expect(skipArgs.contractId).toBe("cm_c1");
    expect(skipArgs.ttlDays).toBeGreaterThanOrEqual(21);
    const event = mocks.logEvent.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "dunning.parked_touch",
    )?.[0] as { payload: Record<string, unknown>; source: string };
    expect(event).toBeTruthy();
    expect(event.source).toBe("SCHEDULER");
    expect(event.payload).toMatchObject({ dunningCaseId: "case_1", offsetIndex: 0, offsetDays: 7 });
  });

  it("hard-dead card (revoked / expired / none): update-only block — no retry, no skip link minted, no resume date promised", async () => {
    for (const [over, reason, reasonKey] of [
      [{ paymentMethodRevokedAt: new Date(NOW.getTime() - 5 * DAY) }, "card_revoked", "card_dead_removed"],
      [{ cardExpiryMonth: 7, cardExpiryYear: 2026 }, "card_expired", "card_dead_expired"],
      [{ paymentMethodId: null }, "no_card", "card_dead_missing"],
    ] as const) {
      vi.clearAllMocks();
      mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(7, { contract: contractFixture(over) })]);
      const stats = await runPostExhaustionTouches(NOW);
      expect(stats, reason).toMatchObject({ processed: 1, sent: 1 });
      const input = sentInput();
      expect(input.vars.card_dead_reason).toBe(reason);
      expect(input.vars.cta_url).toBe("https://magic/UPDATE_CARD");
      expect(input.vars.skip_resume_url).toBe("");
      expect(input.vars.resume_date).toBe("");
      expect(input.vars.ways_intro).toBe(
        t("en", "email.payment_failed_parked.ways_intro_card_dead", {
          card_dead_reason: t("en", `email.payment_failed_parked.${reasonKey}`),
        }),
      );
      expect(input.vars.ways_more).toBe(t("en", "email.payment_failed_parked.ways_more_card_dead"));
      expect(String(input.vars.ways_intro)).not.toMatch(/\{[a-z_]+\}/);
      // Nothing dead is minted: no skip one-tap (a refusal would only spend it), no retry.
      expect(mocks.buildSkipFailedCycleUrl).not.toHaveBeenCalled();
      const actions = (mocks.buildMagicUrl.mock.calls as unknown as Array<[{ action: string }]>).map((c) => c[0].action);
      expect(actions).toEqual(["UPDATE_CARD"]);
      const event = mocks.logEvent.mock.calls.find(
        (c) => (c[0] as { type: string }).type === "dunning.parked_touch",
      )?.[0] as { payload: Record<string, unknown> };
      expect(event.payload.cardDead).toBe(reason);
    }
  });

  it("live card but no derivable resume date: the skip exit reads 'from your next scheduled order', never 'from :'", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      caseFixture(7, { triggerAttemptId: null, contract: contractFixture({ nextBillingDate: null }) }),
    ]);
    await runPostExhaustionTouches(NOW);
    const input = sentInput();
    expect(input.vars.resume_date).toBe("");
    expect(input.vars.ways_more).toContain(t("en", "email.payment_failed_parked.resume_date_fallback"));
    expect(input.vars.ways_more).toContain("https://magic/SKIP_FAILED_CYCLE");
  });

  it("nothing before the first offset", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(3)]);
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("day 21 sends offset 1 — and a never-sent day-7 is NOT replayed on top of it", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(25)]);
    await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(sentInput().vars.dunning_dedupe).toBe("parked:case_1:1");
  });

  it("dedupes per case + offset on the NotificationLog (SENT or SUPPRESSED)", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(9)]);
    mocks.notificationLogFindFirst.mockResolvedValue({ id: "log_1" });
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
    const where = (mocks.notificationLogFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      contractId: "cm_c1",
      template: "payment_failed_parked",
      status: { in: ["SENT", "SUPPRESSED"] },
      payload: { path: ["vars", "dunning_dedupe"], equals: "parked:case_1:0" },
    });
    // No links are minted for a deduped touch.
    expect(mocks.buildSkipFailedCycleUrl).not.toHaveBeenCalled();
  });

  it("stops when a newer case exists for the contract", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(9)]);
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_newer" });
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
    const where = (mocks.dunningCaseFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "cm_c1" });
    expect(where.openedAt).toEqual({ gt: caseFixture(9).openedAt });
  });

  it("stops when the contract is no longer FAILED, was resolved by the customer, or is not ours (defensive re-checks)", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      caseFixture(9, { id: "c_active", contract: contractFixture({ status: "ACTIVE" }) }),
      caseFixture(9, { id: "c_cancelled", contract: contractFixture({ status: "CANCELLED" }) }),
      caseFixture(9, { id: "c_skipped", resolution: "CUSTOMER_SKIPPED" }),
      caseFixture(9, { id: "c_reopened", state: "RETRYING", resolution: null }),
      caseFixture(9, { id: "c_foreign", contract: contractFixture({ ownership: "OTHER_APP" }) }),
      caseFixture(9, { id: "c_demo", contract: contractFixture({ isDemo: true }) }),
    ]);
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.processed).toBe(0);
  });

  it("stops on a scheduled cancel — the query filters it and the re-check drops it (audit)", async () => {
    await runPostExhaustionTouches(NOW);
    const args = mocks.dunningCaseFindMany.mock.calls[0][0] as { where: { contract: Record<string, unknown> } };
    expect(args.where.contract).toMatchObject({ cancelScheduledAt: null });
    for (const cancelScheduledAt of [
      new Date(NOW.getTime() + 10 * DAY), // still ahead: the customer already decided
      new Date(NOW.getTime() - 3600_000), // passed: cancel_scheduled_run ends it within the hour
    ]) {
      mocks.sendNotification.mockClear();
      mocks.dunningCaseFindMany.mockResolvedValue([
        caseFixture(9, { id: "c_sched", contract: contractFixture({ cancelScheduledAt }) }),
      ]);
      const stats = await runPostExhaustionTouches(NOW);
      expect(mocks.sendNotification).not.toHaveBeenCalled();
      expect(stats.processed).toBe(0);
    }
  });

  it("never nags manual-review declines (HARD + customerAction NONE)", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      caseFixture(9, { declineCode: "FRAUD_SUSPECTED", declineCategory: "HARD" }),
    ]);
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("no offsets configured → sends nothing", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "dunning" ? { ...defaultFor("dunning"), postExhaustionTouchDays: [] } : {},
    );
    mocks.dunningCaseFindMany.mockResolvedValue([caseFixture(40)]);
    const stats = await runPostExhaustionTouches(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("a SUPPRESSED send counts as suppressed and logs no parked_touch event; one bad case never blocks the rest", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      caseFixture(9, { id: "case_boom", contract: contractFixture({ id: "cm_boom" }) }),
      caseFixture(9, { id: "case_ok" }),
    ]);
    mocks.sendNotification
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce({ status: "SUPPRESSED" });
    const stats = await runPostExhaustionTouches(NOW);
    expect(stats.suppressed).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    expect(
      mocks.logEvent.mock.calls.some((c) => (c[0] as { type: string }).type === "dunning.parked_touch"),
    ).toBe(false);
  });
});

describe("payment_failed_parked template wiring", () => {
  it("is an EMAIL template on its own metric 'Cellexia Payment Parked', customizable + disableable, timed by postExhaustionTouchDays", () => {
    const tmpl = TEMPLATES.payment_failed_parked;
    expect(tmpl.channel).toBe("EMAIL");
    expect(tmpl.klaviyoMetric).toBe("Cellexia Payment Parked");
    expect(tmpl.critical).toBe(false);
    const entry = EMAIL_CATALOG.payment_failed_parked;
    expect(entry.group).toBe("payments");
    expect(entry.customizable).toBe(true);
    expect(entry.disableable).toBe(true);
    expect(entry.timing).toMatchObject({ settingsKey: "dunning", path: "postExhaustionTouchDays", kind: "intList" });
    expect(entry.links).toContain("skip_resume_url");
    expect(entry.links).toContain("update_card_url");
    expect(entry.links).toContain("retry_payment_url");
  });

  it("gets its own Klaviyo flow spec (the ladder flow must not re-fire on parked contracts)", () => {
    const spec = flowSpecs().find((s) => s.metric === "Cellexia Payment Parked");
    expect(spec).toBeTruthy();
    expect(spec!.templates).toEqual(["payment_failed_parked"]);
    expect(spec!.why.length).toBeGreaterThan(10);
  });

  it("the English body carries the composed 'ways' block around {cta}; the live block carries the three exits; the preview sample resolves it", () => {
    const body = t("en", "email.payment_failed_parked.body");
    expect(body).toContain("{ways_intro}\n{cta}\n{ways_more}");
    // The exits live in the composed block, not the body (a hard-dead card
    // must be able to drop them without a second body).
    expect(body).not.toContain("{retry_payment_url}");
    expect(body).not.toContain("{skip_resume_url}");
    const live = t("en", "email.payment_failed_parked.ways_more_live");
    expect(live).toContain("{retry_payment_url}");
    expect(live).toContain("{skip_resume_url}");
    expect(live).toContain("{resume_date}");
    expect(t("en", "email.payment_failed_parked.ways_intro_live")).toContain("Update your card");
    // Hard-dead copy promises no retry / skip one-tap.
    const deadIntro = t("en", "email.payment_failed_parked.ways_intro_card_dead");
    expect(deadIntro).toContain("{card_dead_reason}");
    expect(`${deadIntro} ${t("en", "email.payment_failed_parked.ways_more_card_dead")}`).not.toMatch(/\{(retry_payment_url|skip_resume_url|resume_date)\}/);
    // Subject no longer promises "three ways" (false for a dead card).
    expect(t("en", "email.payment_failed_parked.subject")).not.toMatch(/three/i);
    const sample = previewSampleVars("payment_failed_parked") as Record<string, unknown>;
    for (const key of ["ways_intro", "ways_more", "skip_resume_url", "resume_date", "days_since_failure", "amount", "decline_human"]) {
      expect(sample[key], key).toBeDefined();
    }
  });
});
