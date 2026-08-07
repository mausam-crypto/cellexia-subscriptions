import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Preview-feature tests: the PREVIEW magic token (signature-verified, never
 * consumed — the buy-box reveal must survive PDP → cart navigation), the
 * go-live stagger math, and the local-only demo contract invariants.
 *
 * DB-free: an in-memory MagicLinkToken store (tokens.test.ts pattern) plus
 * capture stubs for the shop/contract tables stand in for prisma; the Shopify
 * app object, metafields, catalog and event log are inert mocks.
 */

interface TokenRow {
  tokenHash: string;
  action: string;
  payload: unknown;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
  usedAt: Date | null;
  createdVia: string | null;
}

interface UpdateManyArgs {
  where: {
    tokenHash?: string;
    expiresAt?: { gt?: Date };
    useCount?: { lt?: unknown };
  };
  data: {
    useCount?: { increment?: number };
    usedAt?: Date;
  };
}

const db = vi.hoisted(() => {
  // Sentinel standing in for Prisma's FieldRef<"MagicLinkToken", "Int">.
  const MAX_USES_FIELD = { __fieldRef: "MagicLinkToken.maxUses" };
  const store = new Map<string, TokenRow>();

  const magicLinkToken = {
    fields: { maxUses: MAX_USES_FIELD },

    async create({ data }: { data: Partial<TokenRow> & { tokenHash: string; expiresAt: Date } }) {
      const row: TokenRow = {
        tokenHash: data.tokenHash,
        action: data.action ?? "LOGIN",
        payload: data.payload ?? {},
        expiresAt: data.expiresAt,
        maxUses: data.maxUses ?? 1,
        useCount: data.useCount ?? 0,
        usedAt: null,
        createdVia: data.createdVia ?? null,
      };
      store.set(row.tokenHash, row);
      return row;
    },

    // Synchronous filter+mutate — emulates the DB's atomic conditional UPDATE.
    async updateMany({ where, data }: UpdateManyArgs) {
      let count = 0;
      for (const row of store.values()) {
        if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) continue;
        if (where.expiresAt?.gt !== undefined && !(row.expiresAt.getTime() > where.expiresAt.gt.getTime())) continue;
        if (where.useCount?.lt !== undefined) {
          const bound =
            where.useCount.lt === MAX_USES_FIELD
              ? row.maxUses
              : (where.useCount.lt as number);
          if (!(row.useCount < bound)) continue;
        }
        if (data.useCount?.increment) row.useCount += data.useCount.increment;
        if (data.usedAt !== undefined) row.usedAt = data.usedAt;
        count += 1;
      }
      return { count };
    },

    async findUnique({ where }: { where: { tokenHash: string } }) {
      return store.get(where.tokenHash) ?? null;
    },
  };

  const mocks = {
    shopFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractCreate: vi.fn(
      async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => ({
        id: "demo_contract_1",
        ...data,
      }),
    ),
    contractUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
    sellingPlanFindFirst: vi.fn(async (): Promise<unknown> => null),
    giftRuleFindFirst: vi.fn(async (): Promise<unknown> => null),
    giftGrantCreate: vi.fn(async (): Promise<unknown> => ({})),
  };

  return {
    store,
    mocks,
    prisma: {
      magicLinkToken,
      shop: { findUnique: mocks.shopFindUnique },
      subscriptionContract: {
        findFirst: mocks.contractFindFirst,
        create: mocks.contractCreate,
        update: mocks.contractUpdate,
      },
      sellingPlanConfig: { findFirst: mocks.sellingPlanFindFirst },
      giftRule: { findFirst: mocks.giftRuleFindFirst },
      giftGrant: { create: mocks.giftGrantCreate },
    },
  };
});

vi.mock("~/db.server", () => ({ default: db.prisma }));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(),
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async (): Promise<void> => {}),
  getShopMetafield: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
}));

import {
  sha256,
  verifyAndConsumeMagicToken,
  verifyMagicTokenSignature,
} from "~/lib/crypto/tokens.server";
import {
  buildStorefrontPreviewToken,
  buildStorefrontPreviewUrl,
  computeStaggeredDates,
} from "~/lib/launch/launch.server";
import { createDemoContract } from "~/lib/portal/demo.server";

const T0 = new Date("2026-07-23T12:00:00Z");
const DAY_MS = 86_400_000;

const shopFixture = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  primaryDomain: "www.cellexia.example",
  ianaTimezone: "Europe/London",
  currencyCode: "GBP",
  contactEmail: "owner@cellexia.example",
};

beforeEach(() => {
  db.store.clear();
  vi.clearAllMocks();
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db.mocks.shopFindUnique.mockResolvedValue(shopFixture);
  db.mocks.contractFindFirst.mockResolvedValue(null);
  db.mocks.sellingPlanFindFirst.mockResolvedValue(null);
  db.mocks.giftRuleFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flip the final character of the signature segment, keeping its length. */
function tamperSignature(token: string): string {
  const [body, sig] = token.split(".");
  const last = sig.at(-1) === "A" ? "B" : "A";
  return `${body}.${sig.slice(0, -1)}${last}`;
}

// ── PREVIEW magic token ──────────────────────────────────────────────────────

describe("PREVIEW token roundtrip", () => {
  it("builds a signed PREVIEW token that verifies with the shopId payload", async () => {
    const token = await buildStorefrontPreviewToken("shop_1");

    const result = verifyMagicTokenSignature(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.action).toBe("PREVIEW");
      expect(result.payload.params).toEqual({ shopId: "shop_1" });
      expect(result.payload.v).toBe(1);
      // TTL is 7 days.
      expect(result.payload.exp).toBe(
        Math.floor(T0.getTime() / 1000) + 7 * 24 * 3600,
      );
    }

    // Only the hash is persisted, with the PREVIEW action for audit.
    const row = db.store.get(sha256(token));
    expect(row?.action).toBe("PREVIEW");
    expect(row?.createdVia).toBe("ADMIN");
  });

  it("signature-verify never consumes — repeated PDP/cart validations stay free", async () => {
    const token = await buildStorefrontPreviewToken("shop_1");

    for (let i = 0; i < 5; i++) {
      expect(verifyMagicTokenSignature(token).ok).toBe(true);
    }

    const row = db.store.get(sha256(token));
    expect(row?.useCount).toBe(0);
    expect(row?.usedAt).toBeNull();

    // Even a later consuming path would still find the token unspent.
    const consumed = await verifyAndConsumeMagicToken(token);
    expect(consumed.ok).toBe(true);
    expect(db.store.get(sha256(token))?.useCount).toBe(1);
  });

  it("rejects a tampered signature", async () => {
    const token = await buildStorefrontPreviewToken("shop_1");
    const bad = tamperSignature(token);
    expect(bad).not.toBe(token);

    expect(verifyMagicTokenSignature(bad)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
    expect(db.store.get(sha256(token))?.useCount).toBe(0);
  });

  it("rejects a tampered body (shopId swap invalidates the signature)", async () => {
    const token = await buildStorefrontPreviewToken("shop_1");
    const [body, sig] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { params: Record<string, unknown> };
    payload.params.shopId = "someone_elses_shop";
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");

    expect(verifyMagicTokenSignature(`${forgedBody}.${sig}`)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("expires after 7 days (valid just before, rejected just after)", async () => {
    const token = await buildStorefrontPreviewToken("shop_1");

    vi.setSystemTime(new Date(T0.getTime() + 7 * DAY_MS - 1000));
    expect(verifyMagicTokenSignature(token).ok).toBe(true);

    vi.setSystemTime(new Date(T0.getTime() + 7 * DAY_MS + 1000));
    expect(verifyMagicTokenSignature(token)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
    expect(db.store.get(sha256(token))?.useCount).toBe(0);
  });
});

describe("storefront preview URL", () => {
  it("points ?cx_preview at the PDP on the primary domain", async () => {
    const url = new URL(
      await buildStorefrontPreviewUrl("shop_1", "renewal-serum"),
    );

    expect(url.host).toBe("www.cellexia.example");
    expect(url.pathname).toBe("/products/renewal-serum");

    const token = url.searchParams.get("cx_preview");
    expect(token).toBeTruthy();
    const result = verifyMagicTokenSignature(token as string);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.action).toBe("PREVIEW");
  });

  it("falls back to the home page without a product handle", async () => {
    const url = new URL(await buildStorefrontPreviewUrl("shop_1"));
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("cx_preview")).toBeTruthy();
  });
});

// ── Go-live stagger math ─────────────────────────────────────────────────────

describe("computeStaggeredDates", () => {
  const TZ = "Europe/London";

  it("returns an empty list for zero overdue contracts", () => {
    expect(computeStaggeredDates(0, TZ, T0)).toEqual([]);
  });

  it("round-robins over tomorrow/+2d/+3d and never lands today or earlier", () => {
    const dates = computeStaggeredDates(7, TZ, T0);
    expect(dates).toHaveLength(7);

    // July, no DST boundary: each tz-anchored day is exactly 24h.
    const offsets = dates.map((d) => (d.getTime() - T0.getTime()) / DAY_MS);
    expect(offsets).toEqual([1, 2, 3, 1, 2, 3, 1]);

    for (const d of dates) {
      expect(d.getTime()).toBeGreaterThan(T0.getTime());
      expect(d.getTime()).toBeLessThanOrEqual(T0.getTime() + 3 * DAY_MS);
    }

    // Even spread: no day carries more than ceil(count / 3) contracts.
    const perDay = new Map<number, number>();
    for (const o of offsets) perDay.set(o, (perDay.get(o) ?? 0) + 1);
    expect([...perDay.values()].every((n) => n <= Math.ceil(7 / 3))).toBe(true);
  });

  it("anchors to the shop-timezone calendar across a DST fall-back", () => {
    // 18:00 BST on 2026-10-24; London leaves DST overnight on the 25th.
    const from = new Date("2026-10-24T17:00:00Z");
    const [next] = computeStaggeredDates(1, TZ, from);

    // Wall-clock 18:00 is preserved — which is 25 real hours, not 24.
    expect(next.getTime() - from.getTime()).toBe(25 * 3600 * 1000);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(next);
    expect(local).toBe("18:00");
  });

  it("uses the given shop timezone, not a fixed one", () => {
    // Same instant; New York falls back Nov 1 2026, London already has.
    const from = new Date("2026-10-31T16:00:00Z");
    const [london] = computeStaggeredDates(1, "Europe/London", from);
    const [newYork] = computeStaggeredDates(1, "America/New_York", from);

    expect(london.getTime() - from.getTime()).toBe(24 * 3600 * 1000);
    expect(newYork.getTime() - from.getTime()).toBe(25 * 3600 * 1000);
  });
});

// ── Demo contract invariants ─────────────────────────────────────────────────

describe("demo contract", () => {
  it("reuses an existing demo contract instead of creating another", async () => {
    db.mocks.contractFindFirst.mockResolvedValue({
      id: "existing_demo",
      ownership: "OURS",
    });

    const { contractId } = await createDemoContract("shop_1");

    expect(contractId).toBe("existing_demo");
    expect(db.mocks.contractCreate).not.toHaveBeenCalled();
    expect(db.mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("repairs a demo contract the ownership migration left UNKNOWN", async () => {
    // Migration 0003 backfills every pre-existing row to UNKNOWN, and the
    // re-classification pass skips demo fixtures on purpose — so a demo
    // contract created before ownership existed would open an empty portal
    // preview (the portal renders OURS contracts only) with nothing to fix it.
    db.mocks.contractFindFirst.mockResolvedValue({
      id: "old_demo",
      ownership: "UNKNOWN",
    });

    const { contractId } = await createDemoContract("shop_1");

    expect(contractId).toBe("old_demo");
    expect(db.mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "old_demo" },
      data: { ownership: "OURS" },
    });
    expect(db.mocks.contractCreate).not.toHaveBeenCalled();
  });

  it("stamps a fresh demo contract as ours so the portal preview opens", async () => {
    await createDemoContract("shop_1");
    const [{ data }] = db.mocks.contractCreate.mock.calls[0]!;
    expect(data.ownership).toBe("OURS");
    expect(data.isDemo).toBe(true); // isDemo, not ownership, is the exclusion
  });

  it("creates a local-only contract every billing/analytics consumer excludes", async () => {
    const { contractId } = await createDemoContract("shop_1");
    expect(contractId).toBe("demo_contract_1");

    expect(db.mocks.contractCreate).toHaveBeenCalledTimes(1);
    const [{ data }] = db.mocks.contractCreate.mock.calls[0]!;

    // The exclusion contract: isDemo flag, fake GIDs, unroutable email.
    expect(data.isDemo).toBe(true);
    expect(data.shopifyContractId).toMatch(/^gid:\/\/cellexia\/demo\/contract\//);
    expect(data.customerId).toMatch(/^gid:\/\/cellexia\/demo\/customer\//);
    expect(String(data.email)).toMatch(/\.invalid$/);
    expect(data.status).toBe("ACTIVE");
    expect(data.currencyCode).toBe("GBP");

    // Billing-shaped fields stay plausible for the portal UI.
    expect((data.nextBillingDate as Date).getTime()).toBeGreaterThan(
      T0.getTime(),
    );
    const lines = (data.lines as { create: Array<Record<string, unknown>> })
      .create;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(String(line.productId)).toMatch(/^gid:\/\//);
      expect(Number.isInteger(line.currentPriceCents)).toBe(true);
    }
    const gift = lines.find((l) => l.isGift === true);
    expect(gift).toBeDefined();
    expect(gift?.currentPriceCents).toBe(0);

    // Lifetime revenue is consistent with the paid lines (money in cents).
    const subtotal = lines
      .filter((l) => l.isGift !== true)
      .reduce(
        (sum, l) =>
          sum + (l.currentPriceCents as number) * ((l.quantity as number) ?? 1),
        0,
      );
    expect(data.lifetimeRevenueCents).toBe(
      subtotal * (data.ordersCount as number),
    );
  });
});
