import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Delay semantics (v1.28.0, P2.2 — portal.delayReanchors).
 *
 *  - delayModeFor: ON → the week buttons re-anchor unless the form says
 *    `mode=once`; OFF → always the old one-cycle delay, whatever the form says.
 *  - The portal dispatcher routes accordingly (delaySchedule vs
 *    delayNextCycle) and the confirming redirect carries BOTH dates (d1/d2),
 *    the mode and the cadence token, plus a signed undo token.
 *  - resolveToast renders the two-date copy: "Next order {date}, then every
 *    N weeks from there" (re-anchor) vs "This order on {date}, back to {orig}
 *    after that" (once).
 *  - Service layer: delaySchedule = set-next-date + cycle.delayed{mode:
 *    "reanchor", followingBillingDate = new + interval}; delayNextCycle keeps
 *    the cycle edit and now logs mode "once" + followingBillingDate = ORIGINAL
 *    next + interval (later orders keep their rhythm).
 *  - The reminder's DELAY magic links and the SMS DELAY keyword go through
 *    the same delayModeFor decision (source pins).
 *  - estimateFrequencyChange: the consequence-date pair the frequency form
 *    previews.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-delay-semantics";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const TZ = "Europe/Zurich";
const NEXT = new Date("2026-09-07T22:00:00.000Z"); // Sep 8 00:00 Zurich (CEST)

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  const contract: Record<string, unknown> = {};
  return {
    shop,
    contract,
    reanchors: { value: true },
    contractFindFirst: vi.fn(async (): Promise<unknown> => contract),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    logEvent: vi.fn(async (): Promise<void> => {}),
    delayNextCycle: vi.fn(async (): Promise<unknown> => ({
      nextBillingDate: new Date("2026-09-14T22:00:00.000Z"),
    })),
    delaySchedule: vi.fn(async (): Promise<unknown> => ({
      nextBillingDate: new Date("2026-09-14T22:00:00.000Z"),
    })),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(async () => ({ id: mocks.shop.id })) },
    portalSession: { findUnique: vi.fn(async () => null) },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: vi.fn(async () => []),
    },
    sellingPlanConfig: { findMany: vi.fn(async () => []) },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
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
        magicLinkTtlDays: 14,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        friendlyLockMessaging: false,
        delayReanchors: mocks.reanchors.value,
      };
    }
    return {};
  }),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/contracts/service.server", () => ({
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  delayNextCycle: mocks.delayNextCycle,
  delaySchedule: mocks.delaySchedule,
  pauseContract: vi.fn(),
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  revertDelayedCycle: vi.fn(),
  setNextBillingDate: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: vi.fn(),
}));
vi.mock("~/lib/winback/engine.server", () => ({ reactivateFromWinback: vi.fn() }));
vi.mock("~/lib/graphql/index.server", () => ({}));
vi.mock("~/lib/portal/catalog.server", () => ({
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: true,
  })),
}));
vi.mock("~/lib/payments/cardUpdate.server", () => ({ resolveCardUpdatePath: vi.fn() }));
vi.mock("~/lib/dunning/engine.server", () => ({ requestCustomerRetry: vi.fn() }));
vi.mock("~/lib/portal/dunning.server", () => ({ loadPortalDunning: vi.fn() }));
vi.mock("~/lib/portal/threeds.server", () => ({ resolvePortalThreeDs: vi.fn() }));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession } from "~/lib/portal/session.server";
import { resolveToast } from "~/lib/portal/layout.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import {
  delayModeFor,
  estimateFrequencyChange,
} from "~/lib/portal/schedule.server";
import { readUndoToken } from "~/lib/portal/undo.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function baseContract() {
  return {
    id: "ctr_1",
    lockDays: 0,
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
    nextBillingDate: NEXT,
    createdAt: new Date(Date.now() - 100 * DAY_MS),
    firstChargeAt: new Date(Date.now() - 100 * DAY_MS),
    lines: [],
  };
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

async function postAction(action: string, fields: Record<string, string>): Promise<Response> {
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

function locationParams(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://x").searchParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.reanchors.value = true;
  Object.keys(mocks.contract).forEach((k) => delete mocks.contract[k]);
  Object.assign(mocks.contract, baseContract());
  mocks.subscriberEventCount.mockResolvedValue(1);
});

// ── delayModeFor ─────────────────────────────────────────────────────────────

describe("delayModeFor", () => {
  it("setting ON: re-anchor by default, 'once' only when the form asks for it", () => {
    expect(delayModeFor({ delayReanchors: true }, null)).toBe("reanchor");
    expect(delayModeFor({ delayReanchors: true }, "")).toBe("reanchor");
    expect(delayModeFor({ delayReanchors: true }, "reanchor")).toBe("reanchor");
    expect(delayModeFor({ delayReanchors: true }, "once")).toBe("once");
    expect(delayModeFor({ delayReanchors: true }, "garbage")).toBe("reanchor");
  });

  it("setting OFF (or unreadable): today's one-cycle delay whatever the form says", () => {
    expect(delayModeFor({ delayReanchors: false }, "reanchor")).toBe("once");
    expect(delayModeFor({ delayReanchors: false }, null)).toBe("once");
    expect(delayModeFor(null, "reanchor")).toBe("once");
    expect(delayModeFor({}, null)).toBe("once");
  });

  it("registry ships portal.delayReanchors ON by default", () => {
    const parsed = settingsSchemas.portal.parse({
      contextualPrompts: true,
      allowAddProducts: true,
      otpCodeTtlMinutes: 10,
      sessionTtlDays: 30,
      magicLinkTtlDays: 14,
    });
    expect(parsed.delayReanchors).toBe(true);
  });
});

// ── Dispatcher routing ───────────────────────────────────────────────────────

describe("proxy.api delay routing", () => {
  it("ON + week button → delaySchedule (re-anchor); redirect carries mode, both dates, cadence and an undo token", async () => {
    const res = await postAction("delay", { weeks: "1" });
    const params = locationParams(res);
    expect(mocks.delaySchedule).toHaveBeenCalledTimes(1);
    expect(mocks.delaySchedule.mock.calls[0].slice(0, 3)).toEqual([
      SHOP_DOMAIN,
      "ctr_1",
      { weeks: 1 },
    ]);
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(params.get("toast")).toBe("delayed");
    expect(params.get("mode")).toBe("reanchor");
    expect(params.get("every")).toBe("4:WEEK");
    // d1 = new next (Sep 15 Zurich); d2 = following = new next + 4 weeks (Oct 13).
    expect(params.get("d1")).toBe("2026-09-15");
    expect(params.get("d2")).toBe("2026-10-13");
    expect(params.get("cid")).toBe("ctr_1");
    const undo = readUndoToken(params.get("undo") ?? "", {
      shopId: "shop_1",
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
    });
    expect(undo).toEqual({
      ok: true,
      spec: {
        kind: "delay",
        mode: "reanchor",
        previousNextBillingDate: NEXT.toISOString(),
        nextBillingDate: "2026-09-14T22:00:00.000Z",
      },
    });
  });

  it("ON + 'Just this once' (mode=once) → delayNextCycle; d2 is the ORIGINAL rhythm's next order", async () => {
    const res = await postAction("delay", { weeks: "1", mode: "once" });
    const params = locationParams(res);
    expect(mocks.delayNextCycle).toHaveBeenCalledTimes(1);
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(params.get("mode")).toBe("once");
    expect(params.get("d1")).toBe("2026-09-15");
    // original next (Sep 8) + 4 weeks = Oct 6 — later orders keep their rhythm.
    expect(params.get("d2")).toBe("2026-10-06");
  });

  it("OFF → today's behaviour: one-cycle delay even when the form claims re-anchor", async () => {
    mocks.reanchors.value = false;
    const res = await postAction("delay", { weeks: "2", mode: "reanchor" });
    const params = locationParams(res);
    expect(mocks.delayNextCycle).toHaveBeenCalledTimes(1);
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(params.get("mode")).toBe("once");
  });

  it("the undo token is bound to the customer — another customer's binding is refused", async () => {
    const res = await postAction("delay", { weeks: "1" });
    const params = locationParams(res);
    const other = readUndoToken(params.get("undo") ?? "", {
      shopId: "shop_1",
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/2",
    });
    expect(other).toEqual({ ok: false, reason: "mismatch" });
  });
});

// ── Toast copy ───────────────────────────────────────────────────────────────

describe("resolveToast — both dates in the delay confirmation", () => {
  const req = (params: Record<string, string>) =>
    new Request(proxyUrl("/subscription/ctr_1", params));

  it("re-anchor: next date + cadence from there", () => {
    const out = resolveToast(
      req({ toast: "delayed", mode: "reanchor", d1: "2026-09-15", d2: "2026-10-13", every: "4:WEEK" }),
      "en",
    );
    expect(out?.toast.text).toBe("Next order September 15, 2026, then every 4 weeks from there.");
  });

  it("once: this order + back to the original rhythm", () => {
    const out = resolveToast(
      req({ toast: "delayed", mode: "once", d1: "2026-09-15", d2: "2026-10-06", every: "4:WEEK" }),
      "en",
    );
    expect(out?.toast.text).toBe("This order on September 15, 2026, back to October 6, 2026 after that.");
  });

  it("malformed / missing params fall back to the classic one-liner (never throws)", () => {
    expect(resolveToast(req({ toast: "delayed" }), "en")?.toast.text).toBe(
      "Your next order has been moved back.",
    );
    expect(
      resolveToast(req({ toast: "delayed", mode: "once", d1: "2026-99-99", d2: "x" }), "en")
        ?.toast.text,
    ).toBe("Your next order has been moved back.");
    expect(
      resolveToast(req({ toast: "delayed", mode: "reanchor", d1: "2026-09-15", every: "999999:WEEK" }), "en")
        ?.toast.text,
    ).toBe("Your next order has been moved back.");
  });

  it("date_changed and frequency_changed carry their dates too", () => {
    expect(
      resolveToast(req({ toast: "date_changed", d1: "2026-09-15", d2: "2026-10-13" }), "en")?.toast.text,
    ).toBe("Next order September 15, 2026, then October 13, 2026.");
    expect(
      resolveToast(req({ toast: "frequency_changed", every: "6:WEEK", d1: "2026-09-22" }), "en")
        ?.toast.text,
    ).toBe("Now every 6 weeks — next order September 22, 2026.");
  });

  it("renders the Undo form only with an undo context, a token, and a listed contract", () => {
    const params = { toast: "delayed", mode: "once", d1: "2026-09-15", d2: "2026-10-06", undo: "abc.def", cid: "ctr_1" };
    expect(resolveToast(req(params), "en")?.toast.html).toBeUndefined();
    const withCtx = resolveToast(req(params), "en", {
      csrfToken: "csrf-1",
      previewToken: null,
      contractIds: new Set(["ctr_1"]),
    });
    expect(withCtx?.toast.html).toContain(`${PORTAL_PROXY_BASE}/api/undo`);
    expect(withCtx?.toast.html).toContain('name="undo_token" value="abc.def"');
    expect(withCtx?.toast.html).toContain('name="_csrf" value="csrf-1"');
    expect(withCtx?.toast.html).toContain('name="return_to" value="/subscription/ctr_1"');
    expect(withCtx?.toast.html).toContain('name="contractId" value="ctr_1"');
    const foreign = resolveToast(req(params), "en", {
      csrfToken: "csrf-1",
      contractIds: new Set(["ctr_other"]),
    });
    expect(foreign?.toast.html).toBeUndefined();
    // Bare .cx- classes never appear in portal markup.
    expect(withCtx?.toast.html ?? "").not.toMatch(/class="[^"]*\bcx-/);
  });
});

// ── Consequence preview ──────────────────────────────────────────────────────

describe("estimateFrequencyChange", () => {
  const contract = { nextBillingDate: NEXT, intervalWeeks: 4, billingIntervalUnit: "WEEK", billingIntervalCount: 4 };
  const now = new Date("2026-08-17T10:00:00.000Z");

  it("same unit: the next order moves by the added slack, the full cadence follows", () => {
    const est = estimateFrequencyChange(contract, { unit: "WEEK", count: 6 }, TZ, now);
    expect(est?.nextDate.toISOString()).toBe("2026-09-21T22:00:00.000Z"); // +2 weeks
    expect(est?.followingDate.toISOString()).toBe("2026-11-02T23:00:00.000Z"); // +6 weeks (CET)
  });

  it("faster cadence pulls the next order in, never into the past", () => {
    const est = estimateFrequencyChange(contract, { unit: "WEEK", count: 2 }, TZ, now);
    expect(est?.nextDate.toISOString()).toBe("2026-08-24T22:00:00.000Z"); // -2 weeks
    const soon = estimateFrequencyChange(
      { ...contract, nextBillingDate: new Date("2026-08-18T22:00:00.000Z") },
      { unit: "WEEK", count: 1 },
      TZ,
      now,
    );
    expect(soon!.nextDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("current cadence: unchanged next, following one interval later; no next date → null", () => {
    const est = estimateFrequencyChange(contract, { unit: "WEEK", count: 4 }, TZ, now);
    expect(est?.nextDate.toISOString()).toBe(NEXT.toISOString());
    expect(est?.followingDate.toISOString()).toBe("2026-10-05T22:00:00.000Z");
    expect(estimateFrequencyChange({ ...contract, nextBillingDate: null }, { unit: "WEEK", count: 6 }, TZ, now)).toBeNull();
  });
});

// ── Source pins ──────────────────────────────────────────────────────────────

describe("every DELAY surface follows the one semantics decision", () => {
  it("magic-link DELAY_NEXT and SMS DELAY route through delayModeFor and delaySchedule", () => {
    for (const rel of ["app/lib/magiclinks/handlers.server.ts", "app/routes/api.sms.inbound.tsx"]) {
      const src = readSource(rel);
      expect(src).toContain("delayModeFor(");
      expect(src).toContain("delaySchedule(");
      expect(src).toContain("delayNextCycle(");
    }
  });

  it("the subscription page offers 'Just this once' only when the setting is on, and the frequency form previews dates", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain('["mode", "once"]');
    expect(src).toContain('["mode", "reanchor"]');
    expect(src).toContain("ctx.delayReanchors");
    expect(src).toContain("portal.schedule.delay_once_label");
    expect(src).toContain("data-cellexia-freq-preview");
    expect(src).toContain("estimateFrequencyChange(");
  });

  it("delay confirmation email no longer promises an unchanged rhythm (untrue under re-anchor)", () => {
    const en = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    expect(en["email.delay_confirmed.body"]).not.toMatch(/rhythm/i);
    expect(en["portal.ladder.delay_sub"]).not.toMatch(/nothing else changes/i);
    expect(en["magic.confirm.desc.DELAY_NEXT_REANCHOR"]).toMatch(/follow the new date/);
  });
});
