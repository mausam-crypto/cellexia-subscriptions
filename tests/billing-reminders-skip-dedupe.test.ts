import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UPCOMING-ORDER REMINDER DEDUPE × SKIPPED CYCLES.
 *
 * The reminder run used to dedupe on `ordersCount + 1` (hasSentForCycle).
 * ordersCount only moves on a SUCCESSFUL charge, so after a customer skipped
 * a cycle — typically via the one-tap skip link carried by the reminder
 * itself — the next real cycle recomputed the SAME index, the pre-skip SENT
 * row matched, and no reminder ever preceded the charge that actually
 * happened: a surprise renewal for exactly the customer who signalled they
 * were not ready (the module's own anti-goal, "the first renewed charge is
 * never a surprise"; winback/engine.server.ts documents the same
 * ordersCount/cycle-index divergence).
 *
 * The contract now, driven against the REAL runUpcomingOrderReminders with a
 * stateful NotificationLog model:
 *  - the dedupe keys on the billing OCCASION — the shop-tz day the charge is
 *    due (`reminder_dedupe: upcoming_order:{YYYY-MM-DD}`), stamped into the
 *    SENT row's payload.vars exactly like dunning's dunning_dedupe;
 *  - a skip (nextBillingDate moved one interval, ordersCount unchanged)
 *    NEVER suppresses the following cycle's reminder;
 *  - a re-run for the same due day still dedupes (exactly one reminder per
 *    occasion, across restarts);
 *  - legacy SENT rows without the key still dedupe via the exact billing
 *    date they quoted (payload.vars.next_date_iso) — no duplicate reminder
 *    across the upgrade, and no post-skip suppression either.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return {
        channels: { email: true, sms: true },
        upcomingOrderDaysBefore: 3,
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
      };
    }
    if (key === "portal") return { allowAddProducts: false };
    return {};
  }),
  sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({
    status: "SENT",
    klaviyoEnqueued: true,
    directEmailSent: false,
  })),
}));

/**
 * NotificationLog modeled as real rows: the sendNotification mock appends a
 * SENT row whose payload mirrors what the real sender persists for templates
 * with a Klaviyo metric — `{ cycleIndex, vars }` — and findFirst implements
 * the Prisma JSON-path equality the dedupe query uses.
 */
const sentRows = vi.hoisted(() => [] as Array<Row>);

function payloadAt(payload: Row, path: string[]): unknown {
  let cur: unknown = payload;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Row)[seg];
  }
  return cur;
}

function matchesPayloadFilter(row: Row, filter: Row): boolean {
  const spec = filter.payload as { path: string[]; equals: unknown };
  return payloadAt(row.payload as Row, spec.path) === spec.equals;
}

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  discountedCents: (cents: number, _pct: number) => cents,
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(
    async (): Promise<Map<string, number>> => new Map(),
  ),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  t: (_locale: string, key: string) => key,
  normalizeLocale: (v: string) => v,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));

import { runUpcomingOrderReminders } from "~/lib/billing/reminders.server";

const JUNE_1 = new Date("2026-06-01T09:00:00.000Z");
const JUNE_29 = new Date("2026-06-29T09:00:00.000Z"); // one 4-week interval later

function contractFixture(over: Row = {}): Row {
  return {
    id: "cm_c1",
    shopId: "shop_1",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    ordersCount: 5, // only moves on a SUCCESSFUL charge — never on a skip
    nextBillingDate: JUNE_1,
    deliveryPriceCents: 0,
    currencyCode: "GBP",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    lines: [
      {
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Serum",
        variantTitle: "",
        quantity: 1,
        currentPriceCents: 5400,
        isGift: false,
      },
    ],
    ...over,
  };
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

function sentVars(): Array<Row> {
  return mocks.sendNotification.mock.calls.map(
    (c) => ((c[0] as { vars?: Row }).vars ?? {}) as Row,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sentRows.length = 0;
  mocks.notificationLogFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as {
      where: { contractId: string; template: string; status: string; OR: Row[] };
    }).where;
    const hit = sentRows.find(
      (row) =>
        row.contractId === where.contractId &&
        row.template === where.template &&
        row.status === where.status &&
        where.OR.some((f) => matchesPayloadFilter(row, f)),
    );
    return hit ? { id: hit.id } : null;
  });
  mocks.sendNotification.mockImplementation(async (input: unknown) => {
    const { contractId, template, vars } = input as {
      contractId: string;
      template: string;
      vars: Row;
    };
    // Mirror the real sender's SENT persistence for klaviyoMetric templates:
    // payload = { cycleIndex, vars } (toTemplateVars keeps string/number).
    sentRows.push({
      id: `nl_${sentRows.length + 1}`,
      contractId,
      template,
      status: "SENT",
      payload: { cycleIndex: vars.cycleIndex, vars },
    });
    return { status: "SENT", klaviyoEnqueued: true, directEmailSent: false };
  });
});

describe("skip never suppresses the next real cycle's reminder", () => {
  it("sends for June 1, dedupes a re-run, then STILL sends after the cycle is skipped to June 29", async () => {
    // 1. Reminder window before June 1: sends, keyed on the due day.
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);
    const first = await runUpcomingOrderReminders(daysBefore(JUNE_1, 2));
    expect(first.sent).toBe(1);
    expect(first.alreadySent).toBe(0);
    expect(sentVars()[0]).toMatchObject({
      cycleIndex: 6,
      reminder_dedupe: "upcoming_order:2026-06-01",
    });

    // 2. Re-run in the same window (restart / second job tick): dedupes.
    const rerun = await runUpcomingOrderReminders(daysBefore(JUNE_1, 1));
    expect(rerun.sent).toBe(0);
    expect(rerun.alreadySent).toBe(1);

    // 3. The customer taps the reminder's one-tap skip: nextBillingDate moves
    //    one interval, ordersCount does NOT move (only settlement increments
    //    it) — the recomputed cycleIndex is 6 AGAIN. The old ordersCount+1
    //    dedupe matched here and silently dropped the reminder for the charge
    //    that actually happens.
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ nextBillingDate: JUNE_29 }),
    ]);
    const afterSkip = await runUpcomingOrderReminders(daysBefore(JUNE_29, 2));
    expect(afterSkip.sent).toBe(1);
    expect(afterSkip.alreadySent).toBe(0);
    expect(sentVars()[1]).toMatchObject({
      cycleIndex: 6, // same index — the key must NOT be this alone
      reminder_dedupe: "upcoming_order:2026-06-29",
    });

    // 4. And the rescheduled occasion itself still dedupes on re-run.
    const rerunAfterSkip = await runUpcomingOrderReminders(
      daysBefore(JUNE_29, 1),
    );
    expect(rerunAfterSkip.sent).toBe(0);
    expect(rerunAfterSkip.alreadySent).toBe(1);
  });

  it("legacy SENT rows (pre-key) dedupe via the exact date they quoted — and release after a skip", async () => {
    // A row written before reminder_dedupe existed: vars carry next_date_iso
    // but no dedupe key (the real sender persisted caller vars for this
    // template all along).
    sentRows.push({
      id: "nl_legacy",
      contractId: "cm_c1",
      template: "upcoming_order",
      status: "SENT",
      payload: {
        cycleIndex: 6,
        vars: { cycleIndex: 6, next_date_iso: JUNE_1.toISOString() },
      },
    });

    // Same occasion (June 1): the legacy row still dedupes — no duplicate
    // reminder across the upgrade.
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);
    const sameOccasion = await runUpcomingOrderReminders(daysBefore(JUNE_1, 2));
    expect(sameOccasion.sent).toBe(0);
    expect(sameOccasion.alreadySent).toBe(1);

    // After the skip the legacy row quotes a date that no longer exists on
    // the schedule — the June 29 charge gets its reminder.
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ nextBillingDate: JUNE_29 }),
    ]);
    const afterSkip = await runUpcomingOrderReminders(daysBefore(JUNE_29, 2));
    expect(afterSkip.sent).toBe(1);
    expect(sentVars()[0]).toMatchObject({
      reminder_dedupe: "upcoming_order:2026-06-29",
    });
  });

  it("keeps cycleIndex in vars (additive Klaviyo/log contract: payload.cycleIndex stays queryable)", async () => {
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);
    await runUpcomingOrderReminders(daysBefore(JUNE_1, 2));

    expect(sentRows).toHaveLength(1);
    expect((sentRows[0].payload as Row).cycleIndex).toBe(6);
    expect(sentVars()[0]).toMatchObject({
      cycleIndex: 6,
      next_date_iso: JUNE_1.toISOString(),
    });
  });
});
