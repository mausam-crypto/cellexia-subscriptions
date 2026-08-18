import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One-tap restart links (v1.28.0, P3.2).
 *
 *  - `restart_url` is a signed APPLY_WINBACK link carrying { percent 0,
 *    gift false, restart true }, single use, TTL = settings.winback
 *    .restartLinkTtlDays (default 60);
 *  - restartLinkVars is contained: {} for MERGED / foreign / demo cancels
 *    and on any minting failure (never blocks a send);
 *  - the win-back engine mints it into winback_soft's vars;
 *  - the dead skip/delay bundle is gone from winback_soft (a cancelled
 *    contract cannot skip): the router's LINK_BUNDLE_TEMPLATES no longer
 *    lists it and the catalog declares portal_url + restart_url for both
 *    winback_soft and cancel_confirmed;
 *  - the English bodies use {restart_url}; the sample preview resolves it.
 */

const mocks = vi.hoisted(() => ({
  buildMagicUrl: vi.fn(async (_input: unknown): Promise<string> => "https://app.example/magic/RESTART"),
  getSetting: vi.fn(async (_shopId?: string, _key?: string): Promise<unknown> => ({
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

vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: mocks.buildMagicUrl,
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://cellexialabs.com/apps/cellexia-subs"),
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));

// ── Engine harness (soft-touch send) — mirrors tests/aud-portal-winback-events ─
const engine = vi.hoisted(() => ({
  states: [] as Array<Record<string, unknown>>,
  contracts: new Map<string, Record<string, unknown> | null>(),
  sendNotification: vi.fn(async (_i: unknown): Promise<unknown> => ({ status: "SENT" })),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
}));
vi.mock("~/db.server", () => {
  const client = {
    winbackState: {
      findMany: vi.fn(async (): Promise<unknown[]> => engine.states),
      findUnique: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = engine.states.find((s) => s.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row ?? { id: args.where.id, ...args.data };
      }),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => engine.contracts.get(args.where.id) ?? null),
      findUniqueOrThrow: vi.fn(async (args: { where: { id: string } }) => engine.contracts.get(args.where.id)),
      findFirst: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    subscriberEvent: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    cancelSession: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftRule: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      create: vi.fn(async (): Promise<unknown> => ({})),
    },
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
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: engine.logEvent }));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 20, clamped: false })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: engine.sendNotification,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/emailLines.server", () => ({
  giftEmailLines: vi.fn(() => ({ gift_image_line: "", gift_worth_line: "", gift_date_line: "" })),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (o: { current: unknown }) => o.current),
  surpriseGiftArmFor: vi.fn(async (): Promise<string> => "gift"),
  assignedArm: vi.fn(async (): Promise<string> => "control"),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
}));

import { runWinbackSweep } from "~/lib/winback/engine.server";

import {
  RESTART_LINK_PARAMS,
  buildRestartUrl,
  restartLinkTtlDays,
  restartLinkVars,
} from "~/lib/winback/links.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { t } from "~/lib/i18n/i18n.server";

const contract = {
  id: "ctr_1",
  shopId: "shop_1",
  customerId: "gid://shopify/Customer/1",
  email: "sub@example.com",
  ownership: "OURS",
  isDemo: false,
  cancelReason: "TOO_EXPENSIVE",
} as unknown as Parameters<typeof restartLinkVars>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildMagicUrl.mockResolvedValue("https://app.example/magic/RESTART");
});

describe("restart_url minting", () => {
  it("mints a single-use APPLY_WINBACK link with the restart params and the settings TTL (default 60 days)", async () => {
    const url = await buildRestartUrl(contract, { createdVia: "KLAVIYO_FLOW" });
    expect(url).toBe("https://app.example/magic/RESTART");
    expect(mocks.buildMagicUrl).toHaveBeenCalledTimes(1);
    const input = mocks.buildMagicUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(input.action).toBe("APPLY_WINBACK");
    expect(input.contractId).toBe("ctr_1");
    expect(input.customerId).toBe("gid://shopify/Customer/1");
    expect(input.email).toBe("sub@example.com");
    expect(input.params).toEqual({ percent: 0, cycles: 0, gift: false, restart: true });
    expect(input.params).toEqual(RESTART_LINK_PARAMS);
    expect(input.maxUses).toBe(1); // single use, like every other verb
    expect(input.ttlSeconds).toBe(60 * 24 * 3600);
    expect(input.createdVia).toBe("KLAVIYO_FLOW");
  });

  it("honours settings.winback.restartLinkTtlDays and falls back to 60 when the key is missing/invalid", async () => {
    mocks.getSetting.mockResolvedValueOnce({ restartLinkTtlDays: 30 });
    await buildRestartUrl(contract);
    expect((mocks.buildMagicUrl.mock.calls[0][0] as { ttlSeconds: number }).ttlSeconds).toBe(30 * 86400);

    expect(restartLinkTtlDays({} as never)).toBe(60);
    expect(restartLinkTtlDays({ restartLinkTtlDays: 0 } as never)).toBe(60);
    expect(restartLinkTtlDays({ restartLinkTtlDays: "x" } as never)).toBe(60);
    expect(restartLinkTtlDays({ restartLinkTtlDays: 90 } as never)).toBe(90);
  });

  it("restartLinkVars returns { restart_url } for a real cancel and {} for MERGED / foreign / demo / failure", async () => {
    await expect(restartLinkVars(contract)).resolves.toEqual({
      restart_url: "https://app.example/magic/RESTART",
    });
    await expect(
      restartLinkVars({ ...contract, cancelReason: "MERGED" }),
    ).resolves.toEqual({});
    await expect(
      restartLinkVars({ ...contract, ownership: "OTHER_APP" } as never),
    ).resolves.toEqual({});
    await expect(restartLinkVars({ ...contract, isDemo: true })).resolves.toEqual({});
    mocks.buildMagicUrl.mockRejectedValueOnce(new Error("db down"));
    await expect(restartLinkVars(contract)).resolves.toEqual({});
  });
});

describe("dead bundle removed from winback_soft; restart_url declared", () => {
  it("send.server no longer attaches the skip/delay bundle to winback_soft and mints restart_url for cancel_confirmed + winback_soft", () => {
    const src = readFileSync(
      join(process.cwd(), "app/lib/notifications/send.server.ts"),
      "utf8",
    );
    const bundleBlock = src.slice(
      src.indexOf("const LINK_BUNDLE_TEMPLATES"),
      src.indexOf("]);", src.indexOf("const LINK_BUNDLE_TEMPLATES")),
    );
    expect(bundleBlock).not.toMatch(/^\s*"winback_soft",/m);
    // Stabilisation pass: the perk / discount touches carry their own
    // engine-minted offer link (cta_url); the skip/delay/pause bundle was
    // dead on a cancelled contract there too.
    expect(bundleBlock).not.toMatch(/^\s*"winback_perk",/m);
    expect(bundleBlock).not.toMatch(/^\s*"winback_discount",/m);
    const restartBlock = src.slice(
      src.indexOf("const RESTART_LINK_TEMPLATES"),
      src.indexOf("]);", src.indexOf("const RESTART_LINK_TEMPLATES")),
    );
    expect(restartBlock).toContain('"cancel_confirmed"');
    expect(restartBlock).toContain('"winback_soft"');
    expect(src).toContain("restartLinkVars(contract");
  });

  it("the catalog declares portal_url + restart_url (no skip/delay links) for winback_soft and cancel_confirmed", () => {
    for (const key of ["winback_soft", "cancel_confirmed"] as const) {
      const links = EMAIL_CATALOG[key].links;
      expect(links).toContain("portal_url");
      expect(links).toContain("restart_url");
      expect(links).not.toContain("skip_url");
      expect(links).not.toContain("delay_3w_url");
      expect(links).not.toContain("pause_url");
    }
  });

  it("the English bodies restart through {restart_url} and still link the account", () => {
    for (const key of ["email.cancel_confirmed.body", "email.winback_soft.body"]) {
      const body = t("en", key);
      expect(body).toContain("{restart_url}");
      expect(body).toContain("{portal_url}");
    }
  });

  it("the Klaviyo event map mints restart_url on contract.cancelled before rendering the confirmation", () => {
    const src = readFileSync(
      join(process.cwd(), "app/lib/klaviyo/events-map.server.ts"),
      "utf8",
    );
    const at = src.indexOf('event.type === "contract.cancelled"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 600)).toContain("restartLinkVars");
    // Minted before the confirmation content render (so {restart_url} resolves).
    expect(at).toBeLessThan(src.indexOf("if (confirmationTemplate && cellexiaSend)"));
  });
});

describe("win-back engine mints restart_url into winback_soft", () => {
  it("the soft touch carries restart_url (no skip/delay bundle vars) and the perk stage keeps its own reactivate_url", async () => {
    engine.states = [
      {
        id: "wb_1",
        contractId: "c_1",
        shopId: "shop_1",
        cancelledAt: new Date("2026-07-20T00:00:00Z"),
        predictedEmptyDate: new Date("2026-08-10T00:00:00Z"),
        stage: 0,
        nextTouchAt: new Date("2026-08-03T00:00:00Z"),
        status: "ACTIVE",
        wonBackAt: null,
      },
    ];
    engine.contracts.set("c_1", {
      id: "c_1",
      shopId: "shop_1",
      shopifyContractId: "gid://shopify/SubscriptionContract/1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      ownership: "OURS",
      isDemo: false,
      status: "CANCELLED",
      locale: "en",
      intervalWeeks: 4,
      ordersCount: 5,
      predictedEmptyDate: null,
      cancelledAt: new Date("2026-07-20T00:00:00Z"),
      cancelReason: "TOO_MUCH_PRODUCT",
      lines: [],
    });
    mocks.buildMagicUrl.mockResolvedValue("https://app.example/magic/RESTART");

    await runWinbackSweep(new Date("2026-08-04T12:00:00Z"));

    const soft = engine.sendNotification.mock.calls
      .map((c) => c[0] as { template: string; vars: Record<string, unknown> })
      .find((c) => c.template === "winback_soft");
    expect(soft).toBeDefined();
    expect(soft!.vars.restart_url).toBe("https://app.example/magic/RESTART");
    // The template's button (email.cta.reactivate) IS the restart link.
    expect(soft!.vars.cta_url).toBe("https://app.example/magic/RESTART");
    expect(soft!.vars.skip_url).toBeUndefined();
    const minted = mocks.buildMagicUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(minted.action).toBe("APPLY_WINBACK");
    expect(minted.params).toEqual({ percent: 0, cycles: 0, gift: false, restart: true });
    expect(minted.maxUses).toBe(1);
    expect(minted.ttlSeconds).toBe(60 * 86400);
    // The touch itself is unchanged: soft_touch logged, stage advanced to 1.
    const types = engine.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("winback.soft_touch");
    expect(engine.states[0].stage).toBe(1);
  });

  it("a failed mint never blocks the soft touch (contained → email without restart_url)", async () => {
    engine.states = [
      {
        id: "wb_2",
        contractId: "c_2",
        shopId: "shop_1",
        cancelledAt: new Date("2026-07-20T00:00:00Z"),
        predictedEmptyDate: new Date("2026-08-10T00:00:00Z"),
        stage: 0,
        nextTouchAt: new Date("2026-08-03T00:00:00Z"),
        status: "ACTIVE",
        wonBackAt: null,
      },
    ];
    engine.contracts.set("c_2", {
      id: "c_2",
      shopId: "shop_1",
      shopifyContractId: "gid://shopify/SubscriptionContract/2",
      customerId: "gid://shopify/Customer/2",
      email: "two@example.com",
      ownership: "OURS",
      isDemo: false,
      status: "CANCELLED",
      locale: "en",
      intervalWeeks: 4,
      ordersCount: 2,
      predictedEmptyDate: null,
      cancelledAt: new Date("2026-07-20T00:00:00Z"),
      cancelReason: "OTHER",
      lines: [],
    });
    mocks.buildMagicUrl.mockRejectedValueOnce(new Error("token store down"));

    const stats = await runWinbackSweep(new Date("2026-08-04T12:00:00Z"));
    expect(stats.softTouches).toBe(1);
    expect(stats.errors).toBe(0);
    const soft = engine.sendNotification.mock.calls
      .map((c) => c[0] as { template: string; vars: Record<string, unknown> })
      .find((c) => c.template === "winback_soft");
    expect(soft).toBeDefined();
    expect(soft!.vars.restart_url).toBeUndefined();
    expect(soft!.vars.cta_url).toBeUndefined();
  });
});
