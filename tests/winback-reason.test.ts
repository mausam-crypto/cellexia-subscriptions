import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * WinbackState.reason (v1.28.0, P3.4 — migration 0028 column).
 *
 *  - scheduleWinback stamps `reason` on CREATE and on RESTART (a WON_BACK /
 *    SUNSET episode cancelled again gets the NEW reason);
 *  - resolveWinbackReason: contract.cancelReason first; else the newest
 *    CancelSession that ended CANCELLED with a reason; else null; a failed
 *    session read is contained (null, scheduling proceeds);
 *  - the admin subscriber page reads the state read-only and shows the
 *    reason (or names its absence for pre-v1.28.0 episodes).
 */

const engine = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  sessionFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const client = {
    winbackState: {
      findUnique: vi.fn(async (): Promise<unknown> => engine.existing),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: "wb_new", ...args.data };
        engine.created.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        engine.updated.push(args);
        return { id: "wb_1", ...(engine.existing ?? {}), ...args.data };
      }),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    subscriptionContract: {
      update: vi.fn(async (): Promise<unknown> => ({})),
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    cancelSession: { findFirst: engine.sessionFindFirst },
    subscriberEvent: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
  };
  return { default: client };
});
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({
    enabled: true,
    softTouchOffsetDays: -7,
    perkOffsetDays: 3,
    discountOffsetDays: 21,
    sunsetOffsetDays: 60,
    discountPct: 20,
    discountCycles: 2,
    reactivationBillDelayDays: 3,
    linkGraceDays: 14,
    restartLinkTtlDays: 60,
  })),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
}));
vi.mock("~/shopify.server", () => ({ adminClientForShop: vi.fn(async () => ({})) }));
vi.mock("~/lib/events/log.server", () => ({ logEvent: engine.logEvent }));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async () => ({ percent: 20, clamped: false })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async () => 0),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async () => ({ status: "SENT" })),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async () => ({})),
}));
vi.mock("~/lib/gifts/picker.server", () => ({ pickGiftForContract: vi.fn(async () => null) }));
vi.mock("~/lib/gifts/emailLines.server", () => ({
  giftEmailLines: vi.fn(() => ({ gift_image_line: "", gift_worth_line: "", gift_date_line: "" })),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (o: { current: unknown }) => o.current),
  surpriseGiftArmFor: vi.fn(async () => "gift"),
  assignedArm: vi.fn(async () => "control"),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: vi.fn(async () => ({})),
  getBillingCycleByDate: vi.fn(async () => null),
  setNextBillingDate: vi.fn(async () => ({ nextBillingDate: null })),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async () => "https://app.example/magic/X"),
  buildPortalUrl: vi.fn(async () => "https://cellexialabs.com/apps/x"),
}));

import { resolveWinbackReason, scheduleWinback } from "~/lib/winback/engine.server";

const CANCELLED = new Date("2026-08-10T10:00:00Z");

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "CANCELLED",
    ownership: "OURS",
    isDemo: false,
    cancelReason: "TOO_EXPENSIVE",
    cancelSource: "CUSTOMER",
    cancelledAt: CANCELLED,
    predictedEmptyDate: new Date("2026-09-01T00:00:00Z"),
    intervalWeeks: 8,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 8,
    ...over,
  } as unknown as Parameters<typeof scheduleWinback>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  engine.existing = null;
  engine.created.length = 0;
  engine.updated.length = 0;
  engine.sessionFindFirst.mockResolvedValue(null);
});

describe("resolveWinbackReason", () => {
  it("prefers contract.cancelReason", async () => {
    expect(await resolveWinbackReason({ id: "ctr_1", cancelReason: "NOT_SEEING_RESULTS" })).toBe(
      "NOT_SEEING_RESULTS",
    );
    expect(engine.sessionFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to the newest CANCELLED CancelSession reason, else null; a read failure is contained", async () => {
    engine.sessionFindFirst.mockResolvedValueOnce({ reason: "SHIPPING_ISSUES" });
    expect(await resolveWinbackReason({ id: "ctr_1", cancelReason: null })).toBe("SHIPPING_ISSUES");
    const args = engine.sessionFindFirst.mock.calls[0][0] as { where: unknown; orderBy: unknown };
    expect(args.where).toMatchObject({ contractId: "ctr_1", outcome: "CANCELLED", reason: { not: null } });
    expect(args.orderBy).toEqual({ startedAt: "desc" });
    expect(await resolveWinbackReason({ id: "ctr_1", cancelReason: null })).toBeNull();
    engine.sessionFindFirst.mockRejectedValueOnce(new Error("db"));
    expect(await resolveWinbackReason({ id: "ctr_1", cancelReason: null })).toBeNull();
  });
});

describe("scheduleWinback stamps WinbackState.reason", () => {
  it("on create: reason = the contract's cancel reason", async () => {
    const state = await scheduleWinback(contract());
    expect(state).not.toBeNull();
    expect(engine.created).toHaveLength(1);
    expect(engine.created[0]).toMatchObject({
      contractId: "ctr_1",
      status: "ACTIVE",
      stage: 0,
      reason: "TOO_EXPENSIVE",
    });
  });

  it("on restart (WON_BACK/SUNSET cancelled again): reason is overwritten with the NEW reason", async () => {
    engine.existing = { id: "wb_1", status: "SUNSET", reason: "TOO_EXPENSIVE" };
    await scheduleWinback(contract({ cancelReason: "TRYING_SOMETHING_ELSE" }));
    expect(engine.updated).toHaveLength(1);
    expect(engine.updated[0].data).toMatchObject({
      status: "ACTIVE",
      stage: 0,
      wonBackAt: null,
      reason: "TRYING_SOMETHING_ELSE",
    });
  });

  it("without a contract reason the session fallback is used; null when nothing is known", async () => {
    engine.sessionFindFirst.mockResolvedValueOnce({ reason: "OTHER" });
    await scheduleWinback(contract({ cancelReason: null }));
    expect(engine.created[0].reason).toBe("OTHER");
    engine.created.length = 0;
    await scheduleWinback(contract({ cancelReason: null }));
    expect(engine.created[0].reason).toBeNull();
  });

  it("an ACTIVE or OPTED_OUT episode is left untouched (no reason rewrite)", async () => {
    engine.existing = { id: "wb_1", status: "ACTIVE", reason: "OTHER" };
    await scheduleWinback(contract());
    expect(engine.updated).toHaveLength(0);
    expect(engine.created).toHaveLength(0);
    engine.existing = { id: "wb_1", status: "OPTED_OUT", reason: "OTHER" };
    await scheduleWinback(contract());
    expect(engine.updated).toHaveLength(0);
  });
});

describe("admin subscriber page", () => {
  it("reads WinbackState read-only and renders the reason (naming its absence for old episodes)", () => {
    const src = readFileSync(
      new URL("../app/routes/app.subscribers.$id.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("prisma.winbackState.findUnique");
    expect(src).toContain("reason: state.reason ?? null");
    expect(src).toContain("data.winback.reason ??");
    expect(src).not.toContain("prisma.winbackState.update(");
  });

  it("the schema carries the 0028 column", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    const block = schema.slice(schema.indexOf("model WinbackState"), schema.indexOf("model NotificationLog"));
    expect(block).toMatch(/\n\s+reason\s+String\?/);
  });
});
