import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Portal audit regressions — the fixes in this file were shipped together:
 *
 *  1. Magic-link LOGIN must never put the portal session token in a URL or a
 *     JS-readable cookie: it redirects with a single-use short-TTL hand-off
 *     code that the portal exchanges server-side for the HttpOnly cookie.
 *  2. Winback perk-stage links ({ percent: 0, gift: true }) must grant the
 *     promised GIFT and no discount — percent 0 must not be clamped up to 1.
 *  3. The portal renders lang/dir on its root so RTL locales (ar) lay out
 *     correctly inside the merchant's LTR theme.
 *  4. requestOtp must not leak subscriber membership through response timing
 *     (fire-and-forget email send + constant-time floor).
 *  5. Static pins: session tokens are only read from the signed cookie, and
 *     the api dispatcher gates/dedupes the way the audit requires.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-portal-audit";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    status: "CANCELLED",
    ownership: "OURS",
    nextBillingDate: null,
    lines: [],
    shop,
  };
  return {
    shop,
    contract,
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    portalSessionCreate: vi.fn(
      async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
        id: "psn_1",
        ...args.data,
      }),
    ),
    winbackStateUpdateMany: vi.fn(async (): Promise<unknown> => ({ count: 1 })),
    otpCodeCount: vi.fn(async (): Promise<number> => 0),
    otpCodeCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
    otpCodeFindMany: vi.fn(async (): Promise<unknown[]> => []),
    otpCodeUpdateMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
    getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
      if (key === "winback") {
        return {
          enabled: true,
          softTouchOffsetDays: -7,
          perkOffsetDays: 3,
          discountOffsetDays: 21,
          sunsetOffsetDays: 60,
          discountPct: 20,
          discountCycles: 2,
        };
      }
      if (key === "portal") {
        return {
          contextualPrompts: true,
          allowAddProducts: true,
          otpCodeTtlMinutes: 10,
          sessionTtlDays: 30,
          magicLinkTtlDays: 14,
          mutationsPerHour: 30,
          nextDateMaxDays: 90,
          maxLineQuantity: 20,
          otpRequestsPerHour: 3,
          otpVerifyMaxAttempts: 5,
          contextualPromptBufferDays: 10,
          contextualPromptDelayWeeks: 3,
        };
      }
      return {};
    }),
    reactivateFromWinback: vi.fn(
      async (
        _contractId?: unknown,
        _input?: unknown,
        _options?: unknown,
      ): Promise<unknown> => ({}),
    ),
    createMagicToken: vi.fn(
      async (_input?: unknown): Promise<string> => "HANDOFF_CODE_123",
    ),
    verifyAndConsumeMagicToken: vi.fn(
      async (): Promise<unknown> => ({ ok: false, reason: "UNKNOWN" }),
    ),
    buildPortalUrl: vi.fn(
      async (): Promise<string> => "https://cellexialabs.com/apps/cellexia-subs",
    ),
    buildMagicUrl: vi.fn(
      async (): Promise<string> => "https://app.example/magic/tok",
    ),
    sendNotification: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findFirst: mocks.contractFindFirst,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    portalSession: { create: mocks.portalSessionCreate },
    winbackState: { updateMany: mocks.winbackStateUpdateMany },
    otpCode: {
      count: mocks.otpCodeCount,
      create: mocks.otpCodeCreate,
      findMany: mocks.otpCodeFindMany,
      updateMany: mocks.otpCodeUpdateMany,
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: mocks.reactivateFromWinback,
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  verifyAndConsumeMagicToken: mocks.verifyAndConsumeMagicToken,
  sha256: (data: string) =>
    createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: mocks.buildMagicUrl,
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
}));
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
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
}));

import { executeMagicAction } from "~/lib/magiclinks/handlers.server";
import { exchangeLoginHandoff } from "~/lib/portal/session.server";
import { isRtlLocale, portalPage } from "~/lib/portal/layout.server";
import { requestOtp, verifyOtp } from "~/lib/portal/otp.server";

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
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
});

// ── 1. LOGIN hand-off ────────────────────────────────────────────────────────

describe("magic LOGIN hand-off", () => {
  it("redirects with a single-use hand-off code, never the session token", async () => {
    const result = await executeMagicAction(payload("LOGIN"));

    expect(result.redirect).toBeDefined();
    expect(result.redirect).toContain("handoff=HANDOFF_CODE_123");
    expect(result.redirect).not.toContain("session=");
    // No session is minted at login time — only the exchange creates one.
    expect(mocks.portalSessionCreate).not.toHaveBeenCalled();

    const call = mocks.createMagicToken.mock.calls[0]?.[0] as {
      action: string;
      maxUses?: number;
      ttlSeconds: number;
      params?: Record<string, unknown>;
    };
    expect(call.action).toBe("LOGIN");
    expect(call.maxUses).toBe(1);
    expect(call.ttlSeconds).toBeLessThanOrEqual(120);
    expect(call.params?.handoff).toBe(true);
  });

  it("carries the preview flag through the hand-off params", async () => {
    await executeMagicAction(payload("LOGIN", { preview: true }));
    const call = mocks.createMagicToken.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(call.params?.preview).toBe(true);
  });
});

describe("exchangeLoginHandoff", () => {
  it("mints the HttpOnly session cookie for a valid hand-off code", async () => {
    mocks.verifyAndConsumeMagicToken.mockResolvedValueOnce({
      ok: true,
      payload: {
        v: 1,
        action: "LOGIN",
        contractId: "ctr_1",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        params: { handoff: true },
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "n",
      },
    });

    const result = await exchangeLoginHandoff("code", "shop_1");
    expect(result).not.toBeNull();
    expect(result?.cookie).toContain("cx_portal=");
    expect(result?.cookie).toContain("HttpOnly");
    expect(result?.cookie).toContain("Secure");
    expect(mocks.portalSessionCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses a plain LOGIN magic link pasted as a hand-off code", async () => {
    mocks.verifyAndConsumeMagicToken.mockResolvedValueOnce({
      ok: true,
      payload: {
        v: 1,
        action: "LOGIN",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        params: {}, // no handoff marker — an emailed LOGIN link
        exp: Math.floor(Date.now() / 1000) + 600,
        nonce: "n",
      },
    });
    expect(await exchangeLoginHandoff("code", "shop_1")).toBeNull();
    expect(mocks.portalSessionCreate).not.toHaveBeenCalled();
  });

  it("refuses expired / replayed codes", async () => {
    mocks.verifyAndConsumeMagicToken.mockResolvedValueOnce({
      ok: false,
      reason: "USED",
    });
    expect(await exchangeLoginHandoff("code", "shop_1")).toBeNull();
  });
});

// ── 2. Winback perk-stage gift ───────────────────────────────────────────────

describe("APPLY_WINBACK perk stage", () => {
  it("passes gift:true and percent 0 through — never a 1% consolation discount", async () => {
    const result = await executeMagicAction(
      payload("APPLY_WINBACK", { percent: 0, cycles: 0, gift: true }),
    );

    expect(mocks.reactivateFromWinback).toHaveBeenCalledTimes(1);
    const input = mocks.reactivateFromWinback.mock.calls[0]?.[1] as {
      percent?: number;
      cycles?: number;
      gift?: boolean;
    };
    expect(input.gift).toBe(true);
    // percent 0 must NOT be clamped up to 1 — the gift IS the incentive.
    expect(input.percent).toBe(0);

    // The confirmation promises the gift, not a bogus "0%/1% discount".
    expect(result.sub).toContain("gift");
    expect(result.sub).not.toMatch(/\d+% discount/);
  });

  it("still clamps and grants a real discount for discount-stage links", async () => {
    const result = await executeMagicAction(
      payload("APPLY_WINBACK", { percent: 20, cycles: 2, gift: false }),
    );
    const input = mocks.reactivateFromWinback.mock.calls[0]?.[1] as {
      percent?: number;
      cycles?: number;
      gift?: boolean;
    };
    expect(input.percent).toBe(20);
    expect(input.cycles).toBe(2);
    expect(input.gift).toBe(false);
    expect(result.sub).toContain("20%");
  });
});

// ── Magic-link mutation throttle ─────────────────────────────────────────────

describe("magic-link mutation throttle", () => {
  it("refuses a mutating verb once the hourly ceiling is exceeded", async () => {
    mocks.subscriberEventCount.mockResolvedValue(31); // includes this tap
    const result = await executeMagicAction(
      payload("APPLY_WINBACK", { percent: 0, cycles: 0, gift: true }),
    );
    expect(mocks.reactivateFromWinback).not.toHaveBeenCalled();
    expect(result.redirect).toBeUndefined();
    expect(result.headline.length).toBeGreaterThan(0);
  });

  it("never throttles the LOGIN hand-off", async () => {
    mocks.subscriberEventCount.mockResolvedValue(500);
    const result = await executeMagicAction(payload("LOGIN"));
    expect(result.redirect).toContain("handoff=");
  });
});

// ── 3. RTL / lang ────────────────────────────────────────────────────────────

describe("portal RTL/lang", () => {
  it("classifies ar as RTL and en/fr as LTR", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
    expect(isRtlLocale("fr")).toBe(false);
    expect(isRtlLocale(null)).toBe(false);
  });

  it("stamps lang + dir on the portal root", () => {
    const ar = portalPage({ locale: "ar", title: "T" });
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('lang="ar"');
    const en = portalPage({ locale: "en", title: "T" });
    expect(en).toContain('dir="ltr"');
    expect(en).toContain('lang="en"');
  });
});

// ── 4. OTP timing ────────────────────────────────────────────────────────────

describe("requestOtp anti-enumeration timing", () => {
  it("does not await the email send (fire-and-forget)", async () => {
    mocks.contractFindFirst.mockResolvedValueOnce(mocks.contract);
    // A send that never settles would hang requestOtp if it were awaited.
    mocks.sendNotification.mockReturnValueOnce(
      new Promise(() => {}) as Promise<unknown>,
    );
    const result = await requestOtp("sub@example.com");
    expect(result.ok).toBe(true);
    expect(mocks.otpCodeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  }, 4000);

  it("holds unknown emails to the same constant-time floor as known ones", async () => {
    mocks.contractFindFirst.mockResolvedValueOnce(null);
    const started = Date.now();
    const result = await requestOtp("stranger@example.com");
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    // MIN_RESPONSE_MS is 350; allow scheduling slack downwards.
    expect(elapsed).toBeGreaterThanOrEqual(330);
    expect(mocks.otpCodeCreate).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

// ── OTP telemetry (data-collection audit) ────────────────────────────────────
// Rate-limited requests and wrong-code attempts used to leave zero trace —
// abuse patterns and login friction were unmeasurable. Both now log an
// event, WITHOUT changing the anti-enumeration responses: same neutral
// shapes, same timing floor, and never any code material.

describe("requestOtp throttle telemetry", () => {
  it("logs portal.otp_throttled while keeping the neutral response", async () => {
    mocks.contractFindFirst.mockResolvedValueOnce(mocks.contract);
    mocks.otpCodeCount.mockResolvedValueOnce(3); // at the otpRequestsPerHour cap

    const result = await requestOtp("sub@example.com");

    // Byte-identical outcome to every other requestOtp path.
    expect(result.ok).toBe(true);
    expect(mocks.otpCodeCreate).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    const throttled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "portal.otp_throttled");
    expect(throttled).toHaveLength(1);
    expect(throttled[0].payload).toMatchObject({
      recentRequests: 3,
      limit: 3,
    });
  });
});

describe("verifyOtp wrong-code telemetry", () => {
  it("logs portal.login_failed — email-keyed, never code material", async () => {
    mocks.contractFindFirst.mockResolvedValueOnce(mocks.contract);
    mocks.otpCodeFindMany.mockResolvedValueOnce([
      { id: "otp_1", codeHash: "not-the-submitted-hash", attempts: 0 },
    ]);

    const result = await verifyOtp("sub@example.com", "123456");

    expect(result).toEqual({ ok: false });
    // The guessing budget still burns on every live code.
    expect(mocks.otpCodeUpdateMany).toHaveBeenCalledTimes(1);

    const failed = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "portal.login_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      email: "sub@example.com",
      payload: { reason: "code_mismatch", liveCodes: 1 },
    });
    // Neither the guessed code nor its hash enters the event stream.
    expect(JSON.stringify(failed[0])).not.toContain("123456");
  });

  it("stays silent for unknown emails (no shop to log against, no enumeration surface)", async () => {
    mocks.contractFindFirst.mockResolvedValueOnce(null);

    const result = await verifyOtp("stranger@example.com", "123456");

    expect(result).toEqual({ ok: false });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── 5. Static pins ───────────────────────────────────────────────────────────

describe("static source pins", () => {
  const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

  it("session tokens are read ONLY from the signed cookie", () => {
    const source = read("app/lib/portal/session.server.ts");
    expect(source).not.toContain('searchParams.get("session")');
    expect(source).not.toContain('cookies["cellexia_portal_session"]');
  });

  it("the portal layout script no longer writes a JS cookie", () => {
    const source = read("app/lib/portal/layout.server.ts");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("cellexia_portal_session");
  });

  it("the api dispatcher gates address to editable statuses and dedupes cycles", () => {
    const source = read("app/routes/proxy.api.$action.tsx");
    expect(source).toContain('EDITABLE_ONLY = new Set(["address"])');
    expect(source).toContain("isDuplicateCycleSubmit");
    expect(source).toContain('case "reactivate"');
    // Insert-then-count rate limiting on a dedicated attempt event.
    expect(source).toContain("portal.mutation_attempt");
    const attemptLogIndex = source.indexOf('type: "portal.mutation_attempt"');
    const countIndex = source.indexOf("recentAttempts");
    expect(attemptLogIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(attemptLogIndex);
  });

  it("cancelled contracts get a one-tap restart on home card and detail page", () => {
    expect(read("app/routes/proxy._index.tsx")).toContain('"reactivate"');
    expect(read("app/routes/proxy.subscription.$id.tsx")).toContain(
      'api(ctx, "reactivate")',
    );
  });

  it("the portal home logs a daily-throttled portal.visit (never for previews)", () => {
    const source = read("app/routes/proxy._index.tsx");
    expect(source).toContain('type: "portal.visit"');
    // Throttle key: one event per session per shop-day.
    expect(source).toContain('payload: { path: ["sessionId"]');
    expect(source).toContain("if (!portalSession.isPreview) {");
  });

  it("the detail page logs deduped cycle.addon_offer_shown impressions", () => {
    const source = read("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain('type: "cycle.addon_offer_shown"');
    // Once per (contract, upcoming order, variant) — the dedupe reads events
    // for the orderNumber before logging, and previews/demo never count.
    expect(source).toContain('payload: { path: ["orderNumber"]');
    expect(source).toContain("!portalSession.isPreview && !contract.isDemo");
  });
});
