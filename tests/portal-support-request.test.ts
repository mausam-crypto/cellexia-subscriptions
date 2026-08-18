import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Get-help / support request (v1.28.0, P5.1).
 *
 * Drives the REAL portal dispatcher (`POST /api/support`) and the REAL
 * submitSupportRequest over a mocked db, with the downstream seams (event
 * log, alerts, mailer, contracts service) as spies.
 *
 * Pins:
 *  - guard chain: bad topic / empty message → error toast, nothing recorded;
 *  - stricter per-customer budget (settings.support.requestsPerHour, insert-
 *    then-count on the portal.mutation_attempt rows) → 429;
 *  - a good submit logs `support.requested` {topic, contractId, orderRef,
 *    pushBack, …} through logEventOrThrow (record of truth), raises the
 *    SUPPORT_REQUEST alert deduped per contract per day (context links to
 *    the subscriber page), emails the resolved support inbox with Reply-To =
 *    the customer, and redirects with toast support_sent + sla;
 *  - the alert / mailer failing never turns the submit into an error;
 *  - pushBack: Delivery problem + ACTIVE → the portal's own delay semantics
 *    (delayNextCycle when portal.delayReanchors is off; delaySchedule when
 *    on); refused inside the plan lock window and for non-DELIVERY topics;
 *    a failed push-back is reported (support_pushback_failed), never hidden;
 *  - order_ref is validated against the contract's own billed cycles;
 *  - the Klaviyo map carries "Cellexia Support Requested";
 *  - return_to "/account" is an accepted redirect target;
 *  - the layout renders the support toast with the SLA count.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-support-request";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
    contactEmail: "hello@cellexialabs.com",
  };
  const contract: Record<string, unknown> = {};
  return {
    shop,
    contract,
    settings: {
      support: {} as Record<string, unknown>,
      portal: {} as Record<string, unknown>,
    },
    lock: { locked: false as boolean },
    attempts: [] as Array<Record<string, unknown>>,
    contractFindFirst: vi.fn(async (): Promise<unknown> => contract),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    subscriberEventCount: vi.fn(async (_args?: unknown): Promise<number> => 1),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    logEvent: vi.fn(async (): Promise<void> => {}),
    logEventOrThrow: vi.fn(async (_event: unknown): Promise<void> => {}),
    raiseAlert: vi.fn(async (_input: unknown): Promise<boolean> => true),
    sendEmail: vi.fn(async (_mail: unknown): Promise<void> => {}),
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
    shop: { findUnique: vi.fn(async () => mocks.shop) },
    portalSession: { findUnique: vi.fn(async () => null) },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: vi.fn(async () => []),
    },
    sellingPlanConfig: { findMany: vi.fn(async () => []) },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      findMany: vi.fn(async () => []),
      count: mocks.subscriberEventCount,
    },
    billingAttempt: {
      findMany: vi.fn(async () => mocks.attempts),
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
        delayReanchors: false,
        ...mocks.settings.portal,
      };
    }
    if (key === "support") {
      return {
        email: "",
        replyTo: "",
        whatsapp: "",
        chatUrl: "",
        hoursNote: "",
        slaBusinessDays: 1,
        requestsPerHour: 3,
        ...mocks.settings.support,
      };
    }
    if (key === "chargeTiming") return { chargeHourLocal: 0 };
    return {};
  }),
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEventOrThrow,
}));
vi.mock("~/lib/analytics/alerts.server", () => ({ raiseAlert: mocks.raiseAlert }));
vi.mock("~/lib/notifications/mailer.server", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: vi.fn(async () => ({
    locked: mocks.lock.locked,
    until: mocks.lock.locked ? new Date(Date.now() + 5 * DAY_MS) : null,
    lockDays: mocks.lock.locked ? 14 : 0,
  })),
}));
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
import { eventMetricEntries } from "~/lib/klaviyo/events-map.server";
import { submitSupportRequest } from "~/lib/support/request.server";
import { supportCardHtml } from "~/lib/support/portal-card.server";
import { resolveSupportChannels } from "~/lib/support/channels.server";

function baseContract() {
  return {
    id: "ctr_1",
    lockDays: 0,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    firstName: "Anna",
    lastName: "Muster",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: new Date(Date.now() + 10 * DAY_MS),
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

async function postSupport(fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
    return_to: "/subscription/ctr_1",
    topic: "OTHER",
    message: "Hello, I need a hand.",
    ...fields,
  });
  return (await apiAction({
    request: new Request(proxyUrl(`/api/support`, { logged_in_customer_id: "1" }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    params: { action: "support" },
    context: {},
  } as never)) as Response;
}

function locationParams(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://x").searchParams;
}

function requestEvent(): Record<string, unknown> | undefined {
  const call = mocks.logEventOrThrow.mock.calls.find(
    (c) => (c[0] as { type: string }).type === "support.requested",
  );
  return call?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.settings.support = {};
  mocks.settings.portal = {};
  mocks.lock.locked = false;
  mocks.attempts = [];
  Object.keys(mocks.contract).forEach((k) => delete mocks.contract[k]);
  Object.assign(mocks.contract, baseContract());
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.raiseAlert.mockResolvedValue(true);
  mocks.sendEmail.mockResolvedValue(undefined);
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe("POST /api/support — guards", () => {
  it("unknown topic → error toast, nothing recorded", async () => {
    const res = await postSupport({ topic: "RANT" });
    expect(locationParams(res).get("toast")).toBe("error");
    expect(requestEvent()).toBeUndefined();
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("empty / whitespace message → error toast, nothing recorded", async () => {
    const res = await postSupport({ message: "   \n " });
    expect(locationParams(res).get("toast")).toBe("error");
    expect(requestEvent()).toBeUndefined();
  });

  it("stricter budget: more than settings.support.requestsPerHour support attempts this hour → 429", async () => {
    // General limit is 30/h; the support-specific count (payload action =
    // "support") returns 4 > 3.
    mocks.subscriberEventCount.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { payload?: unknown } }).where;
      return where?.payload ? 4 : 2;
    });
    const res = await postSupport({});
    expect(res.status).toBe(429);
    expect(requestEvent()).toBeUndefined();
    // The count is scoped to support attempts (payload path filter).
    const supportCount = mocks.subscriberEventCount.mock.calls.find(
      (c) => (c[0] as { where: { payload?: unknown } }).where.payload,
    );
    expect(supportCount?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "portal.mutation_attempt",
          payload: { path: ["action"], equals: "support" },
        }),
      }),
    );
  });

  it("the setting raises the budget", async () => {
    mocks.settings.support = { requestsPerHour: 10 };
    mocks.subscriberEventCount.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { payload?: unknown } }).where;
      return where?.payload ? 4 : 2;
    });
    const res = await postSupport({});
    expect(locationParams(res).get("toast")).toBe("support_sent");
  });

  it("a CANCELLED subscriber may still ask for help", async () => {
    mocks.contract.status = "CANCELLED";
    const res = await postSupport({});
    expect(locationParams(res).get("toast")).toBe("support_sent");
    expect(requestEvent()).toBeDefined();
  });
});

// ── Happy path: event, alert, email, toast ───────────────────────────────────

describe("POST /api/support — record, alert, email, toast", () => {
  it("logs support.requested with the documented payload and redirects with support_sent + sla", async () => {
    mocks.settings.support = { email: "care@cellexialabs.com", slaBusinessDays: 2 };
    const res = await postSupport({ topic: "PLAN", message: "Can I go monthly?" });
    const params = locationParams(res);
    expect(params.get("toast")).toBe("support_sent");
    expect(params.get("sla")).toBe("2");

    const ev = requestEvent();
    expect(ev).toEqual(
      expect.objectContaining({
        shopId: "shop_1",
        contractId: "ctr_1",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        type: "support.requested",
        source: "CUSTOMER_PORTAL",
        actor: "customer",
        payload: expect.objectContaining({
          topic: "PLAN",
          contractId: "ctr_1",
          orderRef: null,
          pushBack: false,
          pushBackApplied: false,
          message: "Can I go monthly?",
          surface: "portal_detail",
        }),
      }),
    );
  });

  it("raises SUPPORT_REQUEST deduped per contract per day, context linking to the subscriber page", async () => {
    await postSupport({ topic: "DELIVERY", message: "Box never arrived" });
    expect(mocks.raiseAlert).toHaveBeenCalledTimes(1);
    const input = mocks.raiseAlert.mock.calls[0][0] as Record<string, unknown>;
    expect(input.type).toBe("SUPPORT_REQUEST");
    expect(input.severity).toBe("WARNING");
    expect(String(input.message)).toContain("Delivery problem");
    expect(String(input.message)).toContain("Box never arrived");
    expect(input.context).toEqual(
      expect.objectContaining({
        contractId: "ctr_1",
        subscriberUrl: "/app/subscribers/ctr_1",
        topic: "DELIVERY",
      }),
    );
    const dedupe = input.dedupe as { key: string; value: string; since: Date };
    expect(dedupe.key).toBe("contractId");
    expect(dedupe.value).toBe("ctr_1");
    expect(dedupe.since.toISOString().endsWith("T00:00:00.000Z")).toBe(true);
  });

  it("emails the resolved support inbox with Reply-To = the customer; no inbox ⇒ no email", async () => {
    mocks.settings.support = { email: "care@cellexialabs.com" };
    await postSupport({ topic: "PAYMENT", message: "Charged twice?" });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(mail.to).toBe("care@cellexialabs.com");
    expect(mail.replyTo).toBe("sub@example.com");
    expect(mail.shopId).toBe("shop_1");
    expect(String(mail.subject)).toContain("Payment");
    expect(String(mail.html)).toContain("Charged twice?");
    expect(String(mail.html)).toContain("/app/subscribers/ctr_1");

    vi.clearAllMocks();
    mocks.settings.support = { email: "" };
    mocks.shop.contactEmail = null as unknown as string;
    await postSupport({});
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    mocks.shop.contactEmail = "hello@cellexialabs.com";
  });

  it("the shop's contact email is the inbox when the setting is blank", async () => {
    await postSupport({});
    const mail = mocks.sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(mail.to).toBe("hello@cellexialabs.com");
  });

  it("alert / mailer failures are contained — the request still succeeds", async () => {
    mocks.settings.support = { email: "care@cellexialabs.com" };
    mocks.raiseAlert.mockRejectedValue(new Error("alerts down"));
    mocks.sendEmail.mockRejectedValue(new Error("smtp down"));
    const res = await postSupport({});
    expect(locationParams(res).get("toast")).toBe("support_sent");
    expect(requestEvent()).toBeDefined();
  });

  it("a failed event write is the ONE thing that errors (no request without its record)", async () => {
    mocks.logEventOrThrow.mockRejectedValueOnce(new Error("db down"));
    const res = await postSupport({});
    expect(locationParams(res).get("toast")).toBe("error");
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("demo contracts never page the merchant (no alert, no email) but keep the event", async () => {
    mocks.contract.isDemo = true;
    mocks.settings.support = { email: "care@cellexialabs.com" };
    await postSupport({});
    expect(requestEvent()).toBeDefined();
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("return_to /account lands back on the Account page", async () => {
    const res = await postSupport({ return_to: "/account", surface: "portal_account" });
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/account?");
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ surface: "portal_account" }));
  });
});

// ── Order picker ─────────────────────────────────────────────────────────────

describe("order_ref", () => {
  it("a billed cycle of THIS contract resolves to its order name; anything else drops silently", async () => {
    mocks.attempts = [
      {
        id: "ba_1",
        orderName: "#1042",
        completedAt: new Date("2026-08-01T10:00:00Z"),
        createdAt: new Date("2026-08-01T10:00:00Z"),
        amountCents: 4900,
      },
    ];
    await postSupport({ topic: "DELIVERY", order_ref: "ba_1" });
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ orderRef: "#1042" }));

    vi.clearAllMocks();
    await postSupport({ topic: "DELIVERY", order_ref: "ba_other" });
    expect(locationParams(await postSupport({})).get("toast")).toBe("support_sent");
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ orderRef: null }));
  });
});

// ── Push-back ────────────────────────────────────────────────────────────────

describe("push my next order back 1 week", () => {
  it("DELIVERY + ACTIVE + reanchors OFF → delayNextCycle(1 week), payload pushBackApplied", async () => {
    const res = await postSupport({ topic: "DELIVERY", push_back: "1" });
    expect(locationParams(res).get("toast")).toBe("support_sent");
    expect(mocks.delayNextCycle).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      { weeks: 1 },
      { source: "CUSTOMER_PORTAL", actor: "customer" },
    );
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(requestEvent()?.payload).toEqual(
      expect.objectContaining({ pushBack: true, pushBackApplied: true, pushBackMode: "once" }),
    );
  });

  it("portal.delayReanchors ON → delaySchedule (the same decision the Delay button makes)", async () => {
    mocks.settings.portal = { delayReanchors: true };
    await postSupport({ topic: "DELIVERY", push_back: "1" });
    expect(mocks.delaySchedule).toHaveBeenCalledTimes(1);
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ pushBackMode: "reanchor" }));
  });

  it("ignored for non-DELIVERY topics", async () => {
    await postSupport({ topic: "PAYMENT", push_back: "1" });
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ pushBack: false }));
  });

  it("refused inside the plan lock window — request recorded, toast says the date was not moved", async () => {
    mocks.lock.locked = true;
    const res = await postSupport({ topic: "DELIVERY", push_back: "1" });
    expect(locationParams(res).get("toast")).toBe("support_pushback_failed");
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(requestEvent()).toBeDefined();
  });

  it("refused on a non-ACTIVE contract", async () => {
    mocks.contract.status = "PAUSED";
    const res = await postSupport({ topic: "DELIVERY", push_back: "1" });
    expect(locationParams(res).get("toast")).toBe("support_pushback_failed");
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
  });

  it("a delay service failure is reported, never hidden — and the request still lands", async () => {
    mocks.delayNextCycle.mockRejectedValueOnce(new Error("shopify 500"));
    const res = await postSupport({ topic: "DELIVERY", push_back: "1" });
    expect(locationParams(res).get("toast")).toBe("support_pushback_failed");
    expect(requestEvent()?.payload).toEqual(
      expect.objectContaining({ pushBack: true, pushBackApplied: false }),
    );
  });

  it("duplicate-submit guard: a stale expected_next (the delay already applied) records the request WITHOUT a second week and without a refusal toast", async () => {
    // Same dedupe the delay verb uses: the form carries the cycle date it
    // targeted; the contract has since moved (first submit / other tab).
    const stale = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const res = await postSupport({ topic: "DELIVERY", push_back: "1", expected_next: stale });
    expect(locationParams(res).get("toast")).toBe("support_sent");
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(requestEvent()?.payload).toEqual(
      expect.objectContaining({ pushBack: false, pushBackApplied: false }),
    );
    // A matching expected_next (fresh form) still applies the push-back.
    mocks.logEventOrThrow.mockClear();
    const fresh = (mocks.contract.nextBillingDate as Date).toISOString();
    await postSupport({ topic: "DELIVERY", push_back: "1", expected_next: fresh });
    expect(mocks.delayNextCycle).toHaveBeenCalledTimes(1);
    expect(requestEvent()?.payload).toEqual(expect.objectContaining({ pushBackApplied: true }));
  });

  it("the subscription page's Get-help form carries expected_next exactly when the push-back is offered", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/routes/proxy.subscription.$id.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(
      /\.\.\.\(allowPushBack\s*\?\s*\(\[\["expected_next", contract\.nextBillingDate\?\.toISOString\(\) \?\? ""\]\]/,
    );
  });
});

// ── submitSupportRequest direct (cancel-flow surface) ────────────────────────

describe("submitSupportRequest (direct)", () => {
  it("tags cancel-flow requests with reason + session and never pushes back", async () => {
    mocks.settings.support = { email: "care@cellexialabs.com", slaBusinessDays: 3 };
    const result = await submitSupportRequest({
      shopId: "shop_1",
      shopDomain: SHOP_DOMAIN,
      contract: baseContract(),
      topic: "DELIVERY",
      message: "Two boxes late in a row",
      pushBack: true,
      surface: "cancel_flow",
      cancelReason: "SHIPPING_ISSUES",
      cancelSessionId: "cs_1",
    });
    expect(result.slaBusinessDays).toBe(3);
    expect(result.emailSent).toBe(true);
    expect(result.alertRaised).toBe(true);
    expect(requestEvent()?.payload).toEqual(
      expect.objectContaining({
        surface: "cancel_flow",
        cancelReason: "SHIPPING_ISSUES",
        cancelSessionId: "cs_1",
        pushBack: true,
        pushBackApplied: true,
      }),
    );
    const alert = mocks.raiseAlert.mock.calls[0][0] as { message: string; context: Record<string, unknown> };
    expect(alert.message).toContain("during cancel flow (SHIPPING_ISSUES)");
    expect(alert.context.cancelReason).toBe("SHIPPING_ISSUES");
  });
});

// ── Klaviyo + toast + card ───────────────────────────────────────────────────

describe("wiring", () => {
  it('support.requested → "Cellexia Support Requested" in the Klaviyo map', () => {
    expect(eventMetricEntries()).toContainEqual({
      eventType: "support.requested",
      metric: "Cellexia Support Requested",
    });
  });

  it("resolveToast renders the SLA-aware confirmation; malformed sla → the plain copy", () => {
    const one = resolveToast(
      new Request("https://x/apps/cellexia-subs/?toast=support_sent&sla=1"),
      "en",
    );
    expect(one?.toast.text).toContain("within 1 business day.");
    const two = resolveToast(
      new Request("https://x/apps/cellexia-subs/?toast=support_sent&sla=2"),
      "en",
    );
    expect(two?.toast.text).toContain("within 2 business days.");
    const bad = resolveToast(
      new Request("https://x/apps/cellexia-subs/?toast=support_sent&sla=999"),
      "en",
    );
    expect(bad?.toast.text).not.toContain("999");
    const failed = resolveToast(
      new Request("https://x/apps/cellexia-subs/?toast=support_pushback_failed&sla=1"),
      "en",
    );
    expect(failed?.toast.text).toContain("couldn't move your next order");
  });

  it("the Get-help card renders only resolved channels, the privacy line and the SLA — no dead mailto", () => {
    const channels = resolveSupportChannels(
      { email: "care@cellexialabs.com", whatsapp: "+41791234567", hoursNote: "Mon–Fri" },
      null,
    );
    const html = supportCardHtml({
      locale: "en",
      channels,
      formAction: "/apps/cellexia-subs/api/support",
      hiddenFields: '<input type="hidden" name="contractId" value="ctr_1">',
      orders: [{ id: "ba_1", label: "#1042 · 1 Aug 2026" }],
      allowPushBack: true,
      topic: "PAYMENT",
    });
    expect(html).toContain('href="mailto:care@cellexialabs.com"');
    expect(html).toContain('href="https://wa.me/41791234567"');
    expect(html).not.toContain("Live chat");
    expect(html).toContain("Hours: Mon–Fri");
    expect(html).toContain('name="topic"');
    expect(html).toContain('<option value="PAYMENT" selected>');
    expect(html).toContain('name="order_ref"');
    expect(html).toContain('name="push_back"');
    // Payment preselected → the push-back row is server-hidden (revealed by the
    // layout script on topic change) but a <noscript> rule reveals it without JS.
    expect(html).toMatch(/class="cxs-check" hidden data-cellexia-support-delivery/);
    expect(html).toContain(
      "<noscript><style>.cxs-check[data-cellexia-support-delivery][hidden]{display:flex}</style></noscript>",
    );
    // …and the hidden attribute must actually HIDE: `.cxs-check{display:flex}`
    // is an author rule that beats the UA `[hidden]{display:none}`, so the
    // stylesheet needs its own `[hidden]` override (the noscript reveal rule
    // is more specific and later, so it still wins without JS).
    const layout = readFileSync(
      fileURLToPath(new URL("../app/lib/portal/layout.server.ts", import.meta.url)),
      "utf8",
    );
    expect(layout).toContain(".cxs-check[hidden]{display:none}");
    expect(layout.indexOf(".cxs-check[hidden]{display:none}")).toBeGreaterThan(
      layout.indexOf(".cxs-check{display:flex"),
    );
    expect(html).toContain("We reply within 1 business day.");
    expect(html).toContain("We keep it with your subscription history.");
    expect(html).not.toContain("cellexia.com");
    expect(html).toContain('id="cxs-support"');
    expect(html).not.toMatch(/class="[^"]*\bcx-[a-z]/);

    const none = supportCardHtml({
      locale: "en",
      channels: resolveSupportChannels({}, null),
      formAction: "/x",
      hiddenFields: "",
      allowPushBack: false,
    });
    expect(none).not.toContain("mailto:");
    expect(none).not.toContain("wa.me");
    expect(none).toContain('name="message"');
  });
});
