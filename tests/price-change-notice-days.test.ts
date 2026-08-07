import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PriceChangeBatch noticeDays bound tests.
 *
 * The settings registry guarantees priceChangePolicy.noticeDays ∈ [7, 90]:
 * the advance-notice compliance window for repricing stored-credential
 * billing. But the policy value is not the only path to a notice window —
 * createPriceChangeBatch accepts a per-batch override fed by the app.bulk.tsx
 * form, and it used to flow verbatim into the batch row. sendPriceChangeNotices
 * computes effectiveAt = now + noticeDays, and applyPriceChangeBatch's ONLY
 * guard is `now < effectiveAt`, so a typed "0"/"3" (or a crafted POST with a
 * negative value) collapsed the "advance notice" to same-day repricing: the
 * notice email rendered an effective_date of today (or the past) and apply
 * passed immediately. These tests pin the bound at the service layer, where
 * NO caller can bypass it.
 *
 * DB-free: every seam is mocked (launch-sync.test.ts pattern).
 */

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(
    async (): Promise<unknown> => ({ mode: "GRANDFATHER", noticeDays: 30 }),
  ),
  batchCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "batch_1",
      ...args.data,
    }),
  ),
  contractCount: vi.fn(async (): Promise<number> => 3),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    priceChangeBatch: { create: mocks.batchCreate },
    subscriptionContract: { count: mocks.contractCount },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineUpdate: vi.fn(),
  withContractDraft: vi.fn(),
}));
vi.mock("~/lib/contracts/shared.server", () => ({
  ongoingDiscountPctForProduct: vi.fn(async (): Promise<number | null> => null),
  proportionalPriceCents: vi.fn((cents: number): number => cents),
  resolveActor: (): string => "system",
  resolveSource: (): string => "ADMIN",
}));
vi.mock("~/lib/ownership/ownership.server", () => ({
  OURS_ONLY: { ownership: "OURS" },
}));

import { createPriceChangeBatch } from "~/lib/contracts/priceChanges.server";
import {
  PRICE_CHANGE_NOTICE_DAYS_MAX,
  PRICE_CHANGE_NOTICE_DAYS_MIN,
  settingsSchemas,
} from "~/lib/settings/registry.server";

const SHOP_ID = "shop_1";
const ITEMS = [
  { variantId: "gid://shopify/ProductVariant/1", oldPriceCents: 1000, newPriceCents: 1200 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async () => ({
    mode: "GRANDFATHER",
    noticeDays: 30,
  }));
});

describe("createPriceChangeBatch noticeDays bound", () => {
  it.each([0, 3, -30, PRICE_CHANGE_NOTICE_DAYS_MIN - 1, PRICE_CHANGE_NOTICE_DAYS_MAX + 1])(
    "rejects an out-of-range override (%s) without creating a batch",
    async (days) => {
      await expect(
        createPriceChangeBatch(SHOP_ID, ITEMS, "PROPAGATE_WITH_NOTICE", days),
      ).rejects.toThrow(/between 7 and 90/);
      // No batch row, no audit event — the invalid window never exists, so
      // sendNotices/apply can never pick it up.
      expect(mocks.batchCreate).not.toHaveBeenCalled();
      expect(mocks.logEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-integer override", async () => {
    await expect(
      createPriceChangeBatch(SHOP_ID, ITEMS, "PROPAGATE_WITH_NOTICE", 7.5),
    ).rejects.toThrow(/whole number/);
    expect(mocks.batchCreate).not.toHaveBeenCalled();
  });

  it("also rejects out-of-range values on GRANDFATHER batches (row invariant, not mode behavior)", async () => {
    // noticeDays is stored on the batch row regardless of mode; the invariant
    // is on the stored value, not on whether this mode happens to read it.
    await expect(
      createPriceChangeBatch(SHOP_ID, ITEMS, "GRANDFATHER", 0),
    ).rejects.toThrow(/between 7 and 90/);
    expect(mocks.batchCreate).not.toHaveBeenCalled();
  });

  it.each([PRICE_CHANGE_NOTICE_DAYS_MIN, PRICE_CHANGE_NOTICE_DAYS_MAX])(
    "accepts the bound itself (%s)",
    async (days) => {
      const batch = (await createPriceChangeBatch(
        SHOP_ID,
        ITEMS,
        "PROPAGATE_WITH_NOTICE",
        days,
      )) as { noticeDays: number };
      expect(batch.noticeDays).toBe(days);
      expect(mocks.batchCreate).toHaveBeenCalledTimes(1);
    },
  );

  it("falls back to the policy's noticeDays when no override is given", async () => {
    const batch = (await createPriceChangeBatch(SHOP_ID, ITEMS)) as {
      noticeDays: number;
    };
    expect(batch.noticeDays).toBe(30);
  });

  it("enforces the exact same bound the settings registry does", async () => {
    // The exported constants ARE the registry bound — if the registry schema
    // ever moves, this test forces the service-layer guard to move with it.
    const schema = settingsSchemas.priceChangePolicy;
    for (const [days, valid] of [
      [PRICE_CHANGE_NOTICE_DAYS_MIN - 1, false],
      [PRICE_CHANGE_NOTICE_DAYS_MIN, true],
      [PRICE_CHANGE_NOTICE_DAYS_MAX, true],
      [PRICE_CHANGE_NOTICE_DAYS_MAX + 1, false],
    ] as const) {
      expect(
        schema.safeParse({ mode: "PROPAGATE_WITH_NOTICE", noticeDays: days })
          .success,
      ).toBe(valid);
    }
  });
});
