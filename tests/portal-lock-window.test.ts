import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN LOCK WINDOW (SellingPlanConfig.lockDays, v1.13.0)
 *
 * "Block skip, pause, change or cancel for the first X days" — the discounted
 * first order must not be grabbable-and-cancellable before a single renewal
 * bills. Three layers are covered here:
 *
 *  1. The pure lock computation (lockStateFor): plan-id membership both id
 *     forms, strictest-rule-wins, earliest-anchor rule, exempt contracts
 *     without line plan ids (imports/demo).
 *  2. The portal dispatcher behaviorally, through a real storefront-login
 *     session: every reducing action refused with toast=locked and NO service
 *     call; additions and recoveries still executing INSIDE the window; the
 *     same actions executing again once the window has passed.
 *  3. Source pins on every other enforcement surface (cancel choke point,
 *     engine backstop, magic links, SMS, portal UI, admin form) so a refactor
 *     cannot silently drop one — the portal-audit.test.ts house style.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-lock-window";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const PLAN_GID = "gid://shopify/SellingPlan/42";
const DAY_MS = 24 * 3600_000;

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  return {
    shop,
    setupMode: { value: false },
    // portal.friendlyLockMessaging as the settings mock serves it. Default
    // FALSE here so the classic-copy tests above keep pinning the plain
    // behavior; the friendly describe flips it per test (ships ON).
    friendlyLock: { value: false },
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (): Promise<void> => {}),
    skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    delayNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    pauseContract: vi.fn(async (): Promise<unknown> => ({})),
    changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
    setNextBillingDate: vi.fn(async (): Promise<unknown> => ({})),
    swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
    changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
    removeLine: vi.fn(async (): Promise<unknown> => ({})),
    unskipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    addOneTimeAddon: vi.fn(async (): Promise<unknown> => ({ lines: [] })),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
    },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
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
          new Response(
            body,
            typeof init === "number" ? { status: init } : init,
          ),
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
  isSetupMode: vi.fn(async (): Promise<boolean> => mocks.setupMode.value),
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
        contextualPromptBufferDays: 10,
        contextualPromptDelayWeeks: 3,
        friendlyLockMessaging: mocks.friendlyLock.value,
      };
    }
    if (key === "pause") return { maxMonths: 3 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  addLine: vi.fn(),
  addOneTimeAddon: mocks.addOneTimeAddon,
  changeFrequency: mocks.changeFrequency,
  changeLineQuantity: mocks.changeLineQuantity,
  delayNextCycle: mocks.delayNextCycle,
  pauseContract: mocks.pauseContract,
  removeLine: mocks.removeLine,
  resumeContract: vi.fn(),
  setNextBillingDate: mocks.setNextBillingDate,
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: mocks.swapLineVariant,
  unskipNextCycle: mocks.unskipNextCycle,
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
import { requireCancelContext } from "~/lib/cancel/portal.server";
import { getPortalSession } from "~/lib/portal/session.server";
import { resolveToast } from "~/lib/portal/layout.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import {
  lockStateFor,
  maxLockDaysForPlanIds,
  type LockRule,
} from "~/lib/contracts/lock.server";

const TZ = "Europe/Zurich";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function rule(lockDays: number, planIds: string[]): LockRule {
  return { lockDays, planIds: new Set(planIds) };
}

function makeContract(opts: {
  createdDaysAgo: number;
  firstChargeDaysAgo?: number | null;
  status?: string;
  /** Terms as subscribed under — the sync-create stamp. Default 30. */
  stampedLockDays?: number | null;
}) {
  const createdAt = new Date(Date.now() - opts.createdDaysAgo * DAY_MS);
  const firstChargeAt =
    opts.firstChargeDaysAgo == null
      ? null
      : new Date(Date.now() - opts.firstChargeDaysAgo * DAY_MS);
  return {
    id: "ctr_1",
    lockDays: opts.stampedLockDays === undefined ? 30 : opts.stampedLockDays,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: opts.status ?? "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: new Date(Date.now() + 7 * DAY_MS),
    deliveryPriceCents: 0,
    createdAt,
    firstChargeAt,
    ordersCount: 1,
    lines: [
      {
        id: "line_1",
        quantity: 2,
        isGift: false,
        isOneTimeAddon: false,
        sellingPlanId: PLAN_GID,
        productId: "gid://shopify/Product/9",
        variantId: "gid://shopify/ProductVariant/111",
        title: "Serum",
        variantTitle: "Default Title",
        currentPriceCents: 5000,
        compareAtPriceCents: null,
        imageUrl: null,
      },
      {
        id: "line_addon",
        quantity: 1,
        isGift: false,
        isOneTimeAddon: true,
        sellingPlanId: null,
        productId: "gid://shopify/Product/10",
        variantId: "gid://shopify/ProductVariant/222",
        title: "Mask",
        variantTitle: "Default Title",
        currentPriceCents: 2000,
        compareAtPriceCents: null,
        imageUrl: null,
      },
    ],
  };
}

const LOCK_RULE_ROW = {
  lockDays: 30,
  shopifyPlanIds: [PLAN_GID],
};

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** CSRF token of the storefront-login (licid) session, as a page would embed it. */
async function licidCsrf(): Promise<string> {
  const session = await getPortalSession(
    new Request(proxyUrl("/", { logged_in_customer_id: "1" })),
  );
  expect(session?.isPreview).toBe(false);
  return session?.csrfToken ?? "";
}

async function postAction(
  action: string,
  fields: Record<string, string>,
): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
    return_to: "/subscription/ctr_1",
    ...fields,
  });
  return (await apiAction({
    request: new Request(
      proxyUrl(`/api/${action}`, { logged_in_customer_id: "1" }),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    ),
    params: { action },
    context: {},
  } as never)) as Response;
}

function expectToast(response: Response, toast: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("Location") ?? "").toContain(`toast=${toast}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.setupMode.value = false;
  mocks.friendlyLock.value = false;
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([LOCK_RULE_ROW]);
  const contract = makeContract({ createdDaysAgo: 5, firstChargeDaysAgo: 5 });
  mocks.contractFindFirst.mockResolvedValue(contract);
  mocks.contractFindUnique.mockResolvedValue(contract);
});

// ── 1. Pure lock computation ─────────────────────────────────────────────────

describe("lockStateFor", () => {
  const young = makeContract({ createdDaysAgo: 5, firstChargeDaysAgo: 5 });

  it("no rules → unlocked, no window", () => {
    expect(lockStateFor([], young, TZ)).toEqual({
      locked: false,
      until: null,
      lockDays: 0,
    });
  });

  it("matches the line plan id in GID form and numeric form", () => {
    expect(lockStateFor([rule(30, [PLAN_GID])], young, TZ).locked).toBe(true);
    // Rule stored numeric, line carries the GID — idForms must bridge.
    expect(lockStateFor([rule(30, ["42"])], young, TZ).locked).toBe(true);
  });

  it("a foreign plan id never locks", () => {
    expect(
      lockStateFor([rule(30, ["gid://shopify/SellingPlan/999"])], young, TZ)
        .locked,
    ).toBe(false);
  });

  it("contracts without line plan ids (imports, demo) are exempt", () => {
    const imported = {
      ...young,
      lines: [{ sellingPlanId: null }, { sellingPlanId: null }],
    };
    expect(lockStateFor([rule(30, [PLAN_GID])], imported, TZ).locked).toBe(
      false,
    );
  });

  it("a null stamp (pre-feature / backfill row) is exempt even when the plan locks", () => {
    const preFeature = makeContract({
      createdDaysAgo: 5,
      firstChargeDaysAgo: 5,
      stampedLockDays: null,
    });
    expect(lockStateFor([rule(30, [PLAN_GID])], preFeature, TZ).locked).toBe(
      false,
    );
  });

  it("terms as subscribed under: effective window is min(stamp, current setting)", () => {
    // Raising 30 → 45 after checkout never retro-extends the commitment…
    const raised = lockStateFor([rule(45, [PLAN_GID])], young, TZ);
    expect(raised.lockDays).toBe(30);
    expect(raised.locked).toBe(true);
    // …lowering 30 → 10 applies immediately (day-5 subscriber still inside)…
    const lowered = lockStateFor([rule(10, [PLAN_GID])], young, TZ);
    expect(lowered.lockDays).toBe(10);
    expect(lowered.locked).toBe(true);
    // …and disabling (or deleting the config) releases immediately.
    expect(lockStateFor([], young, TZ).locked).toBe(false);
    // Strictest CURRENT rule wins among several matches before the min().
    expect(
      maxLockDaysForPlanIds(
        [rule(10, [PLAN_GID]), rule(45, [PLAN_GID]), rule(60, ["999"])],
        [PLAN_GID],
      ),
    ).toBe(45);
  });

  it("anchors on the EARLIEST of firstChargeAt/createdAt", () => {
    // CSV import with subscribed_since long ago: firstChargeAt far in the
    // past beats a recent mirror createdAt — not locked.
    const migrated = makeContract({
      createdDaysAgo: 2,
      firstChargeDaysAgo: 200,
    });
    expect(lockStateFor([rule(30, [PLAN_GID])], migrated, TZ).locked).toBe(
      false,
    );

    // Late renewal-settlement stamp: firstChargeAt AFTER createdAt must not
    // re-lock a contract whose mirror age already passed the window.
    const lateStamp = makeContract({
      createdDaysAgo: 40,
      firstChargeDaysAgo: 3,
    });
    expect(lockStateFor([rule(30, [PLAN_GID])], lateStamp, TZ).locked).toBe(
      false,
    );
  });

  it("releases at shop-timezone MIDNIGHT of the displayed date — the promise is exactly true", () => {
    // Checkout 2026-01-05 14:30 UTC, lockDays 3: the customer is told
    // "available on 8 January" and the lock must release at 00:00 Zurich
    // time that day (23:00 UTC on the 7th, winter offset +1).
    const contract = {
      ...makeContract({ createdDaysAgo: 1, stampedLockDays: 3 }),
      createdAt: new Date("2026-01-05T14:30:00Z"),
      firstChargeAt: new Date("2026-01-05T14:25:00Z"),
    };
    const rules = [rule(3, [PLAN_GID])];
    const boundary = new Date("2026-01-07T23:00:00Z");
    expect(lockStateFor(rules, contract, TZ, boundary).until).toEqual(boundary);
    expect(
      lockStateFor(rules, contract, TZ, new Date("2026-01-07T22:59:59Z"))
        .locked,
    ).toBe(true);
    expect(lockStateFor(rules, contract, TZ, boundary).locked).toBe(false);
  });
});

// ── 2. Portal dispatcher, inside the window ──────────────────────────────────

describe("proxy.api inside the lock window", () => {
  it.each([
    ["skip", {}],
    ["delay", { weeks: "1" }],
    ["frequency", { frequency: "4:WEEK" }],
    ["next_date", { date: "2030-01-01" }],
    ["pause", { months: "1" }],
    ["swap", { lineId: "line_1", variantId: "gid://shopify/ProductVariant/112" }],
  ] as Array<[string, Record<string, string>]>)(
    "refuses %s with toast=locked and no service call",
    async (action, fields) => {
      const response = await postAction(action, fields);
      expectToast(response, "locked");
      for (const fn of [
        mocks.skipNextCycle,
        mocks.delayNextCycle,
        mocks.changeFrequency,
        mocks.setNextBillingDate,
        mocks.pauseContract,
        mocks.swapLineVariant,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses a quantity DECREASE but executes an increase", async () => {
    const down = await postAction("quantity", {
      lineId: "line_1",
      quantity: "1",
    });
    expectToast(down, "locked");
    expect(mocks.changeLineQuantity).not.toHaveBeenCalled();

    const up = await postAction("quantity", { lineId: "line_1", quantity: "3" });
    expectToast(up, "quantity_changed");
    expect(mocks.changeLineQuantity).toHaveBeenCalledTimes(1);
  });

  it("refuses removing a recurring line but allows removing a one-time addon", async () => {
    const recurring = await postAction("remove_line", { lineId: "line_1" });
    expectToast(recurring, "locked");
    expect(mocks.removeLine).not.toHaveBeenCalled();

    const addon = await postAction("remove_line", { lineId: "line_addon" });
    expectToast(addon, "line_removed");
    expect(mocks.removeLine).toHaveBeenCalledTimes(1);
  });

  it("still allows the recovery/addition actions", async () => {
    const unskip = await postAction("unskip", {});
    expectToast(unskip, "unskipped");
    expect(mocks.unskipNextCycle).toHaveBeenCalledTimes(1);

    const addon = await postAction("addon", {
      variantId: "gid://shopify/ProductVariant/333",
      quantity: "1",
    });
    expectToast(addon, "addon_added");
    expect(mocks.addOneTimeAddon).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Portal dispatcher, window passed / lock disabled ──────────────────────

describe("proxy.api outside the lock window", () => {
  it("executes skip once the window has passed", async () => {
    const aged = makeContract({ createdDaysAgo: 40, firstChargeDaysAgo: 40 });
    mocks.contractFindFirst.mockResolvedValue(aged);
    const response = await postAction("skip", {});
    expectToast(response, "skipped");
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });

  it("executes skip when no plan sets lockDays", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
    const response = await postAction("skip", {});
    expectToast(response, "skipped");
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });

  it("executes skip for a pre-feature contract (null stamp) even inside a rule's window", async () => {
    const preFeature = makeContract({
      createdDaysAgo: 5,
      firstChargeDaysAgo: 5,
      stampedLockDays: null,
    });
    mocks.contractFindFirst.mockResolvedValue(preFeature);
    const response = await postAction("skip", {});
    expectToast(response, "skipped");
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Cancel flow choke point ───────────────────────────────────────────────

describe("requireCancelContext inside the lock window", () => {
  it("redirects every cancel-flow request to the subscription page with toast=locked", async () => {
    let thrown: unknown;
    try {
      await requireCancelContext(
        new Request(proxyUrl("/cancel/ctr_1", { logged_in_customer_id: "1" })),
        "ctr_1",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain("/subscription/ctr_1");
    expect(location).toContain("toast=locked");
  });

  it("passes once the window has passed", async () => {
    const aged = makeContract({ createdDaysAgo: 40, firstChargeDaysAgo: 40 });
    mocks.contractFindUnique.mockResolvedValue(aged);
    mocks.contractFindFirst.mockResolvedValue(aged);
    const ctx = await requireCancelContext(
      new Request(proxyUrl("/cancel/ctr_1", { logged_in_customer_id: "1" })),
      "ctr_1",
    );
    expect(ctx.contract.id).toBe("ctr_1");
  });
});

// ── 5. Source pins on every other enforcement surface ────────────────────────

// ── Friendly lock messaging (portal.friendlyLockMessaging, v1.19.0) ──────────
// Same mechanic, reframed surfaces: a "welcome period" progress card and
// benefit-first copy instead of a plain restriction notice. ON by default in
// the registry; the behavior tests above run with the mock OFF so the classic
// copy stays pinned too.

describe("friendly lock messaging (v1.19.0)", () => {
  it("ships ON by default in the settings registry", () => {
    const parsed = settingsSchemas.portal.parse(undefined);
    expect(parsed.friendlyLockMessaging).toBe(true);
    // A stored pre-v1.19.0 portal value (no key) flips on via the
    // field-level default — the additive-settings pattern.
    const legacy = settingsSchemas.portal.safeParse({
      contextualPrompts: true,
      allowAddProducts: true,
      otpCodeTtlMinutes: 10,
      sessionTtlDays: 30,
      magicLinkTtlDays: 14,
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.friendlyLockMessaging).toBe(true);
  });

  it("a refused action redirects with the unlock day + countdown when friendly is ON", async () => {
    mocks.friendlyLock.value = true;
    const response = await postAction("skip", {});
    expect(response.status).toBe(302);
    const location = new URL(
      response.headers.get("Location") ?? "",
      "https://cellexialabs.com",
    );
    expect(location.searchParams.get("toast")).toBe("locked");
    // Contract is 5 days into a 30-day window → unlock ~25 days out.
    expect(location.searchParams.get("locked_until")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    const days = Number(location.searchParams.get("locked_days"));
    expect(days).toBeGreaterThanOrEqual(24);
    expect(days).toBeLessThanOrEqual(26);
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });

  it("a refused action carries NO friendly params when the toggle is off", async () => {
    const response = await postAction("skip", {});
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("toast=locked");
    expect(location).not.toContain("locked_until");
    expect(location).not.toContain("locked_days");
  });

  it("resolveToast renders the friendly copy from valid params and falls back on tampered ones", () => {
    const url = (qs: string) =>
      new Request(`https://cellexialabs.com/portal/?${qs}`);
    const friendly = resolveToast(
      url("toast=locked&locked_until=2026-09-10&locked_days=18"),
      "en",
    );
    expect(friendly?.toast.text).toContain("unlock on September 10, 2026");
    expect(friendly?.toast.text).toContain("18 day(s) to go");
    // The classic factual copy stays reachable on any malformed input —
    // resolveToast trusts nothing from the URL.
    for (const qs of [
      "toast=locked",
      "toast=locked&locked_until=tomorrow&locked_days=18",
      "toast=locked&locked_until=2026-09-10&locked_days=-3",
      "toast=locked&locked_until=2026-09-10&locked_days=9999",
      // Regex-valid but calendar-invalid: Invalid Date must fall back, not
      // reach Intl.format (which THROWS RangeError → a 500 on the page).
      "toast=locked&locked_until=2026-99-99&locked_days=18",
      "toast=locked&locked_until=2026-02-30&locked_days=18",
    ]) {
      const classic = resolveToast(url(qs), "en");
      expect(classic?.toast.text).toBe(
        "This isn't available yet — your plan's minimum commitment period is still running.",
      );
    }
  });

  it("source pin: the subscription page keys the progress card on the toggle, keeps the classic note, and scopes the can-do list by status", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("portalSettings.friendlyLockMessaging");
    expect(source).toContain("portal.locked.friendly_title");
    expect(source).toContain("portal.locked.friendly_progress");
    // The classic note stays reachable as the else branch.
    expect(source).toContain("portal.locked.notice");
    // A PAUSED contract is only ever promised what this page can deliver
    // for it: add/quantity are ACTIVE-only actions, so the can-do list must
    // branch on isActive and keep the details entry for the paused case.
    const canDoBranch = source.slice(
      source.indexOf("const canDo ="),
      source.indexOf("portal.locked.friendly_title"),
    );
    expect(canDoBranch).toContain("isActive");
    expect(canDoBranch).toContain("portal.locked.friendly_can_details");
  });

  it("the cancel choke point carries the friendly params when the toggle is on", async () => {
    mocks.friendlyLock.value = true;
    const request = new Request(
      proxyUrl("/cancel/ctr_1", { logged_in_customer_id: "1" }),
    );
    const thrown = await requireCancelContext(request, "ctr_1").then(
      () => null,
      (reason) => reason,
    );
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain("toast=locked");
    expect(location).toMatch(/locked_until=\d{4}-\d{2}-\d{2}/);
    expect(location).toMatch(/locked_days=\d+/);
  });

  it("magic links and SMS switch copy on the same setting", () => {
    const handlers = readSource("app/lib/magiclinks/handlers.server.ts");
    expect(handlers).toContain("friendlyLockMessaging");
    expect(handlers).toContain("magic.locked_friendly");
    const sms = readSource("app/routes/api.sms.inbound.tsx");
    expect(sms).toContain("friendlyLockMessaging");
    expect(sms).toContain("magic.sms.locked_friendly");
  });

  it("friendly copy never names cancellation and always names the unlock date — the whole point", () => {
    const catalog = JSON.parse(
      readSource("app/lib/i18n/locales/en.json"),
    ) as Record<string, string>;
    const friendlyKeys = Object.keys(catalog).filter(
      (key) => key.includes("friendly") && key.includes("locked"),
    );
    // All ten shipped keys are present…
    expect(friendlyKeys.length).toBeGreaterThanOrEqual(10);
    for (const key of friendlyKeys) {
      // …none of them primes the exit (reactance/priming hygiene — the
      // psychological rationale for the whole feature)…
      expect(catalog[key], key).not.toMatch(/cancel/i);
      expect(catalog[key], key).not.toMatch(/can't|cannot|not available/i);
    }
    // …and every dated surface keeps the exact unlock promise.
    for (const key of [
      "portal.locked.friendly_body",
      "portal.toast.locked_friendly",
      "magic.locked_friendly",
      "magic.sms.locked_friendly",
    ]) {
      expect(catalog[key], key).toContain("{date}");
    }
  });
});

describe("lock window source pins", () => {
  it("the api dispatcher's blocked set is exactly the reducing actions", () => {
    const source = readSource("app/routes/proxy.api.$action.tsx");
    expect(source).toContain('const LOCK_BLOCKED = new Set([');
    for (const action of [
      '"skip"',
      '"delay"',
      '"frequency"',
      '"next_date"',
      '"pause"',
      '"swap"',
    ]) {
      expect(source).toContain(action);
    }
    expect(source).toContain("lock.locked && LOCK_BLOCKED.has(actionName)");
    expect(source).toContain("lock.locked && quantity.data < line.quantity");
    expect(source).toContain("lock.locked && !line.isOneTimeAddon");
  });

  it("the cancel choke point gates before returning a context", () => {
    const source = readSource("app/lib/cancel/portal.server.ts");
    const gate = source.indexOf(
      "resolveLockState(shop.id, contract, shop.ianaTimezone)",
    );
    const contextReturn = source.indexOf("return {\n    shop,");
    expect(gate).toBeGreaterThan(-1);
    expect(contextReturn).toBeGreaterThan(gate);
    expect(source).toContain("toast=locked");
  });

  it("completeCancel keeps a customer-channel backstop before the claim", () => {
    const source = readSource("app/lib/cancel/engine.server.ts");
    const backstop = source.indexOf('if (source !== "ADMIN") {');
    const claim = source.indexOf("const claimedHere = session.outcome == null;");
    expect(backstop).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(backstop);
    expect(
      source.slice(backstop, claim).includes("resolveLockState"),
    ).toBe(true);
  });

  it("magic links refuse exactly the reducing verbs at execution time", () => {
    const source = readSource("app/lib/magiclinks/handlers.server.ts");
    const setStart = source.indexOf("const LOCKED_MAGIC_ACTIONS");
    expect(setStart).toBeGreaterThan(-1);
    const setBlock = source.slice(setStart, source.indexOf("]);", setStart));
    for (const verb of ['"SKIP_NEXT"', '"DELAY_NEXT"', '"PAUSE"', '"SWAP"']) {
      expect(setBlock).toContain(verb);
    }
    for (const spared of ['"UNSKIP_NEXT"', '"RESUME"', '"APPLY_WINBACK"', '"ADD_TO_NEXT"']) {
      expect(setBlock).not.toContain(spared);
    }
    expect(source).toContain(
      "contract && LOCKED_MAGIC_ACTIONS.has(payload.action)",
    );
  });

  it("the SMS route refuses SKIP and DELAY while locked", () => {
    const source = readSource("app/routes/api.sms.inbound.tsx");
    expect(source).toContain('verb === "SKIP" || verb === "DELAY"');
    expect(source).toContain("resolveLockState(contract.shopId");
    expect(source).toContain('outcome: "locked"');
    expect(source).toContain("magic.sms.locked");
  });

  it("the subscription page hides schedule, pause and the cancel link while locked", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("if (isActive && !lock.locked) {");
    expect(source).toContain("if (editable && !lock.locked) {");
    expect(source).toContain("portal.locked.notice");
  });

  it("the portal home hides the one-tap skip/delay while locked", () => {
    const source = readSource("app/routes/proxy._index.tsx");
    expect(source).toContain('contract.status === "ACTIVE" && !params.locked');
    expect(source).toContain(
      "lockStateFor(lockRules, contract, shop.ianaTimezone).locked",
    );
  });

  it("the plans admin saves lockDays end to end", () => {
    const source = readSource("app/routes/app.plans.tsx");
    expect(source).toContain('lockDays: intFrom(formData, "lockDays")');
    expect(source).toContain("lockDays: values.lockDays");
    expect(source).toContain("lockDays: config.lockDays");
    expect(source).toMatch(/lockDays: z\s*\n?\s*\.number\(\)|lockDays: z\.number\(\)/);
  });

  it('the portal layout accepts the "locked" toast key', () => {
    const source = readSource("app/lib/portal/layout.server.ts");
    expect(source).toContain('"locked",');
  });

  it("the sync CREATE path stamps the subscribed-under commitment — and only the create path", () => {
    const source = readSource("app/lib/contracts/sync.server.ts");
    expect(source).toContain("maxLockDaysForPlanIds(");
    expect(source).toContain("lockDays: lockDaysAtCreation");
    // Backfill mirrors (terms unknowable) must stay null-exempt.
    expect(source).toContain("if (!backfillCreate) {");
    // Exactly one writer: the update path never rewrites the stamp.
    expect(source.match(/lockDays:/g)).toHaveLength(1);
  });

  it("the magic GET confirm page renders the locked refusal without consuming the token", () => {
    const route = readSource("app/routes/magic.$token.tsx");
    expect(route).toContain(
      "if (desc.lockedResult) return html(successPage(desc.lockedResult));",
    );
    const handlers = readSource("app/lib/magiclinks/handlers.server.ts");
    // Describe-time check (GET, pre-consumption) AND execute-time backstop.
    expect(
      handlers.match(/LOCKED_MAGIC_ACTIONS\.has\(payload\.action\)/g)?.length,
    ).toBe(2);
  });
});
