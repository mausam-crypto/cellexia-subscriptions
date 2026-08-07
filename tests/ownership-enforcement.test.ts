import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ownership ENFORCEMENT — the half of the ownership model that says "no".
 *
 * `tests/ownership.test.ts` pins how a contract is classified. This file pins
 * what the rest of the app then refuses to do with a contract that is not
 * ours: never charge it, never email its customer, never enqueue a Klaviyo
 * event for it, never edit it on Shopify, never count it.
 *
 * The scenario is real: cellexialabs.com runs Joy Subscriptions. Joy's
 * contracts arrive on the SAME SUBSCRIPTION_CONTRACTS_* webhooks and are
 * mirrored into our database. Without these guards, going live would have our
 * scheduler charge Joy's subscribers on top of Joy charging them, and our
 * dunning/Klaviyo flows would mail people who never subscribed to us.
 *
 * Two layers, both load-bearing:
 *  1. Behavioural — the guards actually fire (mocked seams).
 *  2. Static — every sweep's DB query still carries the ownership filter.
 *     A query that silently loses `OURS_ONLY` cannot be caught by a unit test
 *     with a mocked Prisma (the mock returns whatever it is told to), so the
 *     filter itself is asserted in the source.
 */

const OURS = "OURS";
const FOREIGN = "FOREIGN";
const UNKNOWN = "UNKNOWN";

// ── Shared mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
  shopFindUnique: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({
      id: "shop_1",
      ianaTimezone: "Europe/London",
      contactEmail: "merchant@example.com",
    }),
  ),
  notificationLogCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  notificationLogFindFirst: vi.fn(async (): Promise<unknown> => null),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  dunningCaseCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (): Promise<unknown[]> => []),
  giftRuleFindMany: vi.fn(async (): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
  shopFindUniqueOrThrow: vi.fn(
    async (): Promise<unknown> => ({ id: "shop_1", ianaTimezone: "Europe/London" }),
  ),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  enqueue: vi.fn(async (): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return {
        channels: { email: true, sms: true },
        upcomingOrderDaysBefore: 3,
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
      };
    }
    if (key === "alerts") return { emailTo: ["merchant@example.com"] };
    if (key === "lifecycle") {
      return {
        milestoneGiftCycle: 6,
        earlyCycleIncentivesEnabled: true,
        surpriseGiftOnCycle2: true,
        rewardsUnlockDay: 30,
      };
    }
    if (key === "winback") return { enabled: true, softTouchOffsetDays: 7 };
    return {};
  }),
  sendEmail: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://example.test/portal"),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
    },
    shop: {
      findUnique: mocks.shopFindUnique,
      findUniqueOrThrow: mocks.shopFindUniqueOrThrow,
    },
    notificationLog: {
      create: mocks.notificationLogCreate,
      findFirst: mocks.notificationLogFindFirst,
    },
    dunningCase: {
      findFirst: mocks.dunningCaseFindFirst,
      create: mocks.dunningCaseCreate,
    },
    giftGrant: {
      findFirst: mocks.giftGrantFindFirst,
      findMany: mocks.giftGrantFindMany,
    },
    giftRule: { findMany: mocks.giftRuleFindMany },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
// Ownership gates are what's under test — pin the Klaviyo key as present so
// the OURS happy path exercises the outbox, not the SMTP fallback (which has
// its own suite: tests/klaviyo-unconfigured-fallback.test.ts).
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: () => true,
}));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/notifications/mailer.server", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildActionLinkBundle: mocks.buildActionLinkBundle,
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  skipNextCycle: mocks.skipNextCycle,
  delayNextCycle: mocks.delayNextCycle,
}));

import { action as smsInboundAction } from "~/routes/api.sms.inbound";
import { sendNotification } from "~/lib/notifications/send.server";
import { enqueueKlaviyoForEvent } from "~/lib/klaviyo/events-map.server";
import { ensureGiftsForUpcomingCycle } from "~/lib/gifts/engine.server";
import { onSuccessfulCycle } from "~/lib/lifecycle/engine.server";
import { scheduleWinback } from "~/lib/winback/engine.server";

function contractFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm_contract_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1001",
    customerId: "gid://shopify/Customer/2002",
    email: "anna@example.com",
    phone: null,
    firstName: "Anna",
    lastName: "Larsson",
    status: "ACTIVE",
    ownership: OURS,
    locale: "en",
    currencyCode: "GBP",
    intervalWeeks: 8,
    nextBillingDate: new Date("2026-09-01T09:00:00Z"),
    ordersCount: 3,
    isPrepaid: false,
    isDemo: false,
    deliveryPriceCents: 0,
    churnRiskScore: 0.1,
    cancelReason: null,
    cancelledAt: null,
    predictedEmptyDate: null,
    lines: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
    contactEmail: "merchant@example.com",
  });
  mocks.shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
  });
});

// ── Notifications: never email another app's customer ────────────────────────

describe("sendNotification ownership gate", () => {
  it("suppresses a customer template for a FOREIGN contract with reason foreign_contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: FOREIGN }),
    );

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      template: "upcoming_order",
      vars: { cycleIndex: 4 },
    });

    expect(result.status).toBe("SUPPRESSED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const logged = mocks.notificationLogCreate.mock.calls[0]?.[0] as {
      data: { status: string; payload: { reason?: string; ownership?: string } };
    };
    expect(logged.data.status).toBe("SUPPRESSED");
    expect(logged.data.payload.reason).toBe("foreign_contract");
    expect(logged.data.payload.ownership).toBe(FOREIGN);
  });

  it("suppresses for UNKNOWN too — absence of proof is not proof of ownership", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: UNKNOWN }),
    );

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      template: "payment_failed_1",
    });

    expect(result.status).toBe("SUPPRESSED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("still sends for an OURS contract — the guard costs a legitimate subscriber nothing", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      template: "upcoming_order",
      vars: { cycleIndex: 4 },
    });

    expect(result.status).not.toBe("SUPPRESSED");
    expect(mocks.enqueue).toHaveBeenCalled();
  });

  it("still delivers merchant-facing templates that reference a foreign contract", async () => {
    // admin_alert goes to the MERCHANT, not to the other app's subscriber —
    // suppressing it would hide exactly the alert that warns about them.
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: FOREIGN }),
    );

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      template: "admin_alert",
      vars: { message: "another app detected" },
    });

    expect(result.status).not.toBe("SUPPRESSED");
  });
});

// ── Klaviyo: never enqueue an event for another app's subscriber ─────────────

describe("enqueueKlaviyoForEvent ownership gate", () => {
  it("enqueues nothing for a FOREIGN contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: FOREIGN }),
    );

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      email: "anna@example.com",
      type: "contract.created",
      source: "WEBHOOK",
      actor: "system",
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues nothing for an UNKNOWN contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: UNKNOWN }),
    );

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      email: "anna@example.com",
      type: "contract.created",
      source: "WEBHOOK",
      actor: "system",
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("still enqueues for an OURS contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      email: "anna@example.com",
      type: "contract.created",
      source: "WEBHOOK",
      actor: "system",
    });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ── Shopify-mutating engines: never edit another app's contract ──────────────

describe("engines refuse to act on a contract that is not ours", () => {
  it("the gift engine attaches nothing to a FOREIGN contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: FOREIGN }),
    );

    const result = await ensureGiftsForUpcomingCycle("cm_contract_1", 4);

    expect(result.skipped).toBe("foreign_contract");
    expect(result.grantsCreated).toBe(0);
    expect(result.linesAdded).toBe(0);
    // It bails before even reading the gift rules — no Shopify draft is opened.
    expect(mocks.giftRuleFindMany).not.toHaveBeenCalled();
  });

  it("the lifecycle engine fires no milestone for an UNKNOWN contract", async () => {
    // Same call that DOES fire for an OURS contract in the next test — the
    // only difference is ownership, so this cannot pass vacuously.
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: UNKNOWN, ordersCount: 6 }),
    );

    const result = await onSuccessfulCycle("cm_contract_1", 6);

    expect(result.milestoneReached).toBe(false);
    expect(result.incentiveAnnounced).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("…and does fire the milestone for the identical OURS contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: OURS, ordersCount: 6 }),
    );

    const result = await onSuccessfulCycle("cm_contract_1", 6);

    expect(result.milestoneReached).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalled();
  });

  it("win-back is never scheduled for another app's cancellation", async () => {
    const state = await scheduleWinback(
      contractFixture({
        ownership: FOREIGN,
        status: "CANCELLED",
        cancelledAt: new Date("2026-08-01T00:00:00Z"),
      }) as never,
    );

    expect(state).toBeNull();
  });
});

// ── Inbound SMS keywords: never reschedule another app's subscription ────────

/**
 * POST /api/sms/inbound resolves a phone number to a contract and then MUTATES
 * it — SKIP and DELAY both move the next billing date on Shopify. Every
 * subscriber on the store is in this table, the other app's included, and a
 * phone number carries no ownership with it. The lookup itself is therefore
 * the guard: the query only ever considers contracts we manage, and a number
 * we do not manage gets the ordinary "unknown phone" reply, which is what
 * makes the OTHER app's keyword flow the one that answers it.
 */
describe("inbound SMS keyword handling", () => {
  const PHONE = "+41 79 555 22 11";

  function smsRequest(keyword: string): Request {
    return new Request("https://app.example/api/sms/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cellexia-secret": "test-cron-secret",
      },
      body: JSON.stringify({ phone: PHONE, keyword }),
    });
  }

  const CONTRACT_ROW = {
    id: "cm_contract_1",
    phone: PHONE,
    locale: "en",
    ownership: OURS,
    shop: { domain: "shop.myshopify.com", ianaTimezone: "Europe/Zurich" },
  };

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    // The mock enforces whatever filter the query asked for, so a dropped
    // OURS_ONLY shows up here as another app's subscriber being rescheduled.
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return [CONTRACT_ROW].filter(
        (row) => !where.ownership || row.ownership === where.ownership,
      );
    });
  });

  it("skips the cycle for one of our subscribers", async () => {
    const response = await smsInboundAction({
      request: smsRequest("SKIP"),
      params: {},
      context: {} as never,
    });
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(mocks.skipNextCycle).toHaveBeenCalledWith(
      "shop.myshopify.com",
      "cm_contract_1",
      expect.objectContaining({ source: "MAGIC_LINK" }),
    );
  });

  it.each([FOREIGN, UNKNOWN])(
    "does nothing for a %s contract — the number is unknown to us",
    async (ownership) => {
      mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where;
        return [{ ...CONTRACT_ROW, ownership }].filter(
          (row) => !where.ownership || row.ownership === where.ownership,
        );
      });

      const response = await smsInboundAction({
        request: smsRequest("SKIP"),
        params: {},
        context: {} as never,
      });
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
      expect(mocks.skipNextCycle).not.toHaveBeenCalled();
      expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    },
  );

  it("asks the database for our contracts only", async () => {
    await smsInboundAction({
      request: smsRequest("DELAY"),
      params: {},
      context: {} as never,
    });
    const where = (mocks.contractFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where).toMatchObject({
      status: "ACTIVE",
      isDemo: false,
      ownership: OURS,
    });
  });
});

// ── Static: the sweeps' DB filters ───────────────────────────────────────────

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * Blank out `//` line comments and `/* *\/` block comments so a rule can never
 * be satisfied (or defeated) by prose. Deliberately simple: it only has to be
 * right about the files listed below, all of which are ordinary TypeScript.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every query that decides who gets charged, messaged, swept or counted. If one
 * of these loses its ownership filter, the app starts acting on another
 * subscription app's contracts again — the exact defect this suite exists for.
 */
const OWNERSHIP_FILTERED_QUERIES: Array<[string, string]> = [
  ["app/lib/billing/scheduler.server.ts", "billing due-contract sweep"],
  ["app/lib/billing/reminders.server.ts", "reminders + pause auto-resume"],
  ["app/lib/dunning/engine.server.ts", "dunning sweeps"],
  ["app/lib/gifts/engine.server.ts", "gift scheduling sweep"],
  ["app/lib/winback/engine.server.ts", "win-back re-subscribe detection"],
  ["app/lib/lifecycle/engine.server.ts", "rewards unlock sweep"],
  ["app/lib/contracts/consolidation.server.ts", "auto-consolidation"],
  ["app/lib/contracts/priceChanges.server.ts", "price-change batches"],
  ["app/lib/analytics/rollup.server.ts", "daily rollups"],
  ["app/lib/analytics/queries.server.ts", "dashboard + funnel queries"],
  ["app/lib/analytics/cohorts.server.ts", "cohort LTGP"],
  ["app/lib/analytics/survival.server.ts", "survival curves"],
  ["app/lib/analytics/risk.server.ts", "churn risk + predicted empty dates"],
  ["app/lib/analytics/forecast.server.ts", "forecasting"],
  ["app/lib/analytics/alerts.server.ts", "operational alert scan"],
  ["app/lib/portal/otp.server.ts", "portal OTP login"],
  ["app/routes/proxy._index.tsx", "portal subscription list"],
  ["app/routes/proxy.account.tsx", "portal account page"],
  ["app/routes/proxy.subscription.$id.tsx", "portal subscription detail"],
  ["app/routes/proxy.api.$action.tsx", "portal mutation dispatcher"],
  ["app/lib/magiclinks/handlers.server.ts", "magic-link handlers"],
  ["app/routes/app.bulk.tsx", "bulk plan migration + mass skip"],
  ["app/routes/app.analytics.tsx", "analytics churn split"],
  ["app/lib/launch/launch.server.ts", "go-live overdue stagger"],
  ["app/routes/api.sms.inbound.tsx", "inbound SMS keyword lookup"],
  ["app/routes/app.subscribers.$id.tsx", "admin support cockpit"],
];

describe("ownership filters are present in every gating query", () => {
  for (const [file, what] of OWNERSHIP_FILTERED_QUERIES) {
    it(`${what} (${file}) filters on ownership`, () => {
      const source = stripComments(read(file));
      // COUNTABLE_CONTRACT is the analytics module's { isDemo: false,
      // ...OURS_ONLY } bundle — accepted here because its definition is pinned
      // to spread OURS_ONLY by the dedicated assertion below.
      expect(source).toMatch(
        /OURS_ONLY|COUNTABLE_CONTRACT|isBillableOwnership/,
      );
      // `~/lib/ownership/shared` is the isomorphic half of ownership.server
      // (constants + pure helpers, re-exported by it verbatim). Route
      // COMPONENTS must take the vocabulary from there — a component that
      // references ownership.server drags server-only code into the client
      // bundle and breaks `remix vite:build`. Either path proves the
      // identifiers come from the one canonical module.
      expect(source).toMatch(
        /from "~\/lib\/ownership\/(ownership\.server|shared)"|COUNTABLE_CONTRACT/,
      );
    });
  }

  it("COUNTABLE_CONTRACT itself carries the ownership filter — the indirection cannot rot", () => {
    // Files satisfying the rule above via COUNTABLE_CONTRACT are only safe
    // while that constant actually spreads OURS_ONLY. Pin the definition so a
    // future edit that drops the ownership half (keeping only isDemo) fails
    // here rather than silently re-counting another app's contracts.
    const source = stripComments(read("app/lib/analytics/queries.server.ts"));
    expect(source).toMatch(
      /export const COUNTABLE_CONTRACT =\s*\{\s*isDemo:\s*false,\s*\.\.\.OURS_ONLY\s*\}\s*as const;/,
    );
    expect(source).toContain('from "~/lib/ownership/ownership.server"');
  });

  it("the billing due-query itself carries the filter, not just the file", () => {
    const source = stripComments(read("app/lib/billing/scheduler.server.ts"));
    // The one query that creates charges. Anchored on its own shape so a
    // stray OURS_ONLY elsewhere in the file cannot satisfy the rule.
    const due = source.slice(
      source.indexOf("const candidates = await prisma.subscriptionContract"),
    );
    const whereBlock = due.slice(0, due.indexOf("orderBy"));
    expect(whereBlock).toContain("OURS_ONLY");
    expect(whereBlock).toContain('status: "ACTIVE"');
  });

  it("the stale-attempt sweep restricts to our contracts", () => {
    const source = stripComments(read("app/lib/billing/scheduler.server.ts"));
    const sweep = source.slice(source.indexOf("prisma.billingAttempt.findMany"));
    expect(sweep.slice(0, sweep.indexOf("include:"))).toContain("OURS_ONLY");
  });

  it("the portal mutation dispatcher gates every action on one lookup", () => {
    const source = stripComments(read("app/routes/proxy.api.$action.tsx"));
    const lookup = source.slice(
      source.indexOf("prisma.subscriptionContract.findFirst"),
    );
    expect(lookup.slice(0, lookup.indexOf("include:"))).toContain("OURS_ONLY");
  });

  it("both bulk mutations restrict their target set to OURS, non-demo", () => {
    // Mass plan migration and mass skip write to Shopify for every matching
    // contract. One missing ownership filter here edits a whole book of
    // another app's subscriptions in a single click — and a missing isDemo
    // half feeds the portal-preview demo contract (ACTIVE + OURS, real
    // catalog variants, fake Shopify GID) into the sweep, where its
    // guaranteed Shopify error surfaces as a critical banner and re-enters
    // the "N remaining — run again" arithmetic on every rerun.
    const source = stripComments(read("app/routes/app.bulk.tsx"));
    const migrate = source.slice(source.indexOf('case "migrate"'));
    const migrateWhere = migrate.slice(0, migrate.indexOf("const total"));
    expect(migrateWhere).toContain("OURS_ONLY");
    expect(migrateWhere).toContain("isDemo: false");
    const massSkip = source.slice(source.indexOf('case "massSkip"'));
    const massSkipWhere = massSkip.slice(0, massSkip.indexOf("const total"));
    expect(massSkipWhere).toContain("OURS_ONLY");
    expect(massSkipWhere).toContain("isDemo: false");
    // The loader's frequency distribution feeds the migrate picker — its
    // counts must match what the action will touch, so it carries both
    // halves of the gate too.
    const dist = source.slice(
      source.indexOf("prisma.subscriptionContract.groupBy"),
    );
    const distWhere = dist.slice(0, dist.indexOf("_count"));
    expect(distWhere).toContain("OURS_ONLY");
    expect(distWhere).toContain("isDemo: false");
  });

  it("price-change batches target OURS, non-demo contracts through the one shared where", () => {
    // createPriceChangeBatch (count), sendPriceChangeNotices and
    // applyPriceChangeBatch all select through affectedContractsWhere — the
    // single place the dual gate must live. Without isDemo the demo contract
    // is counted, gets a price-increase notice at its .invalid fixture
    // address, and hands apply a permanent failure against its fake GID.
    const source = stripComments(
      read("app/lib/contracts/priceChanges.server.ts"),
    );
    const fn = source.slice(source.indexOf("function affectedContractsWhere"));
    const body = fn.slice(0, fn.indexOf("lines:"));
    expect(body).toContain("OURS_ONLY");
    expect(body).toContain("isDemo: false");
    // All three surfaces actually go through it (1 definition + 3 call sites).
    expect(source.match(/affectedContractsWhere\(/g)?.length).toBe(4);
  });

  it("the go-live overdue query filters before anything is rescheduled", () => {
    const source = stripComments(read("app/lib/launch/launch.server.ts"));
    const query = source.slice(
      source.indexOf("export async function getOverdueContracts"),
    );
    expect(query.slice(0, query.indexOf("orderBy"))).toContain("OURS_ONLY");
  });

  it("the inbound SMS lookup filters before SKIP/DELAY can fire", () => {
    const source = stripComments(read("app/routes/api.sms.inbound.tsx"));
    const query = source.slice(
      source.indexOf("prisma.subscriptionContract.findMany"),
    );
    expect(query.slice(0, query.indexOf("orderBy"))).toContain("OURS_ONLY");
  });

  it("the admin support cockpit refuses every non-read-only intent", () => {
    // The cockpit opens for a contract we do not own on purpose (the merchant
    // must be able to look). What it must never do is act on one — "Charge
    // now" there calls billingAttemptCreate, which is the duplicate charge in
    // person. The refusal is default-deny: a NEW intent is refused unless it
    // is explicitly added to the read-only exemption set.
    const source = stripComments(read("app/routes/app.subscribers.$id.tsx"));
    expect(source).toContain("OWNERSHIP_EXEMPT_INTENTS");
    expect(source).toMatch(
      /const OWNERSHIP_EXEMPT_INTENTS = new Set\(\["searchProducts"\]\)/,
    );
    expect(source).toContain("isBillableOwnership(ownership)");
    // The gate runs on the way in, next to the contract load — before the
    // intent switch, so it cannot be bypassed by any single case.
    const action = source.slice(source.indexOf("export const action"));
    const guardAt = action.indexOf("ownershipRefusal(intent");
    const switchAt = action.indexOf("switch (intent)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(switchAt);
  });

  it("the admin subscribers LIST is deliberately NOT filtered, but shows ownership", () => {
    // The one place non-OURS contracts must remain visible: the merchant has
    // to be able to see (and claim) them. Pinned so a well-meaning sweep of
    // "add OURS_ONLY everywhere" cannot blind the admin. Scoped to the loader:
    // the action's MUTATING intents are gated (next test) — visibility is a
    // loader property, refusal is an action property.
    const source = stripComments(read("app/routes/app.subscribers.tsx"));
    expect(source).toContain("ownership: normalizeOwnership(");
    expect(source).toContain("claimContracts");
    const loader = source.slice(
      source.indexOf("export const loader"),
      // The loader body ends where the action-side helpers begin; the OURS_ONLY
      // gate (billableSelection) lives with those helpers, not in the list query.
      source.indexOf("function actorFromSession"),
    );
    expect(loader).not.toContain("OURS_ONLY");
  });

  it("the admin subscribers bulk MUTATIONS gate on OURS_ONLY + isDemo before acting", () => {
    // The list shows FOREIGN/UNKNOWN and demo rows on purpose, and
    // skipNextCycle/applyDiscountGrant only check shop membership — so the
    // action itself must refuse non-owned ids or a "Skip next cycle" over a
    // "Managed by: Another app" selection reschedules another app's billing
    // on Shopify (and a bare POST needs no UI at all). bulkClaim/exportCsv
    // keep the wider scope by design: claiming/exporting non-OURS rows is
    // their whole point, and neither touches Shopify.
    const source = stripComments(read("app/routes/app.subscribers.tsx"));
    const gate = source.slice(source.indexOf("async function billableSelection"));
    const gateQuery = gate.slice(0, gate.indexOf("select:"));
    expect(gateQuery).toContain("OURS_ONLY");
    expect(gateQuery).toContain("isDemo: false");
    // Both mutating intents consult the gate before their loops; the refused
    // rows land in the failures count like the cockpit's ownershipRefusal.
    for (const intent of ["bulkSkip", "bulkGrant"]) {
      const block = source.slice(source.indexOf(`intent === "${intent}"`));
      const beforeLoop = block.slice(0, block.indexOf("for (const id of ids)"));
      expect(beforeLoop, `${intent} must gate before its loop`).toContain(
        "await billableSelection(",
      );
      const loop = block.slice(block.indexOf("for (const id of ids)"));
      expect(
        loop.slice(0, loop.indexOf("try {")),
        `${intent} must refuse ids outside the gate`,
      ).toContain("allowed.has(id)");
    }
    // The claim path stays wide: it exists to flip UNKNOWN rows to OURS.
    const claim = source.slice(source.indexOf('intent === "bulkClaim"'));
    expect(claim.slice(0, claim.indexOf("logEvent"))).not.toContain(
      "billableSelection",
    );
  });
});

// ── The upgrade itself: migration 0003 + the pass that completes it ──────────

/**
 * Everything above assumes the `ownership` column holds a real verdict. On the
 * client's store — which has been mirroring another app's contracts for months
 * — that assumption is created by the MIGRATION, and it is the one thing no
 * unit test with a mocked Prisma can observe. A backfill of 'OURS' would hand
 * every guard above a lie it is bound to honour: the sweep would find Joy's
 * contracts marked OURS and charge them, exactly once per renewal, for real
 * money, and every assertion in this file would still pass.
 */
describe("migration 0003 backfills fail-SAFE and stays additive", () => {
  const MIGRATION = "prisma/migrations/0003_contract_ownership/migration.sql";
  /** SQL with `--` comments removed, so prose can neither satisfy nor break a rule. */
  const sql = read(MIGRATION)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("gives pre-existing rows UNKNOWN, not OURS", () => {
    // At migration time there is no evidence to do better: ContractLine
    // .sellingPlanId and SellingPlanConfig.shopifyPlanIds are added by this
    // same migration, so every pre-existing row's ownership is unknowable.
    // UNKNOWN is unbillable; 'OURS' would bill another app's subscribers.
    expect(sql).toMatch(
      /ALTER TABLE "SubscriptionContract" ADD COLUMN\s+"ownership" TEXT NOT NULL DEFAULT 'UNKNOWN'/,
    );
    expect(sql).not.toMatch(/ADD COLUMN\s+"ownership" TEXT NOT NULL DEFAULT 'OURS'/);
  });

  it("leaves UNKNOWN as the standing default too — a forgotten insert is not billable", () => {
    // A column default is only ever REACHED by an insert that forgot the
    // column, so its value is not "what most contracts are", it is "what a
    // future bug gets". Every insert path writes ownership explicitly today
    // (the webhook mirror classifies it; both import paths and the portal demo
    // fixture stamp OURS), which is exactly why the default can afford to be
    // the safe value rather than the common one.
    expect(sql).not.toMatch(/SET DEFAULT 'OURS'/);
    expect(sql).not.toMatch(/DEFAULT 'OURS'/);
  });

  it("declares the same default in schema.prisma as the migration installs", () => {
    // Nothing else compares these two: the parity test next door checks that
    // columns exist, not what they default to. Drift here is invisible until a
    // `create()` without ownership lands on a real database.
    const schema = read("prisma/schema.prisma");
    expect(schema).toContain('ownership                   String    @default("UNKNOWN")');
    expect(schema).not.toContain('ownership                   String    @default("OURS")');

    const migrationDefault = /"ownership" TEXT NOT NULL DEFAULT '(\w+)'/.exec(sql);
    const schemaDefault = /ownership\s+String\s+@default\("(\w+)"\)/.exec(schema);
    expect(migrationDefault?.[1]).toBe(schemaDefault?.[1]);
  });

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("is present, and only the vetted additive migrations follow it", () => {
    const dirs = fs
      .readdirSync(path.join(ROOT, "prisma/migrations"))
      .filter((entry) =>
        fs.statSync(path.join(ROOT, "prisma/migrations", entry)).isDirectory(),
      )
      .sort();
    expect(dirs).toContain("0003_contract_ownership");
    // Anything after 0003 must be vetted here: a later migration could undo
    // the fail-safe backfill above. Each successor is checked additive-only
    // (and ownership-untouched) below; an UNVETTED newcomer fails this
    // assertion until it gets its own describe block.
    expect(dirs.slice(dirs.indexOf("0003_contract_ownership") + 1)).toEqual([
      "0004_analytics_costs",
      "0005_exact_billing_cadence",
      "0006_origin_order_revenue_acquisition",
      "0007_billing_attempt_settled_at",
      "0008_dunning_concurrency",
      "0009_line_add_claim",
      "0010_acq_pickup_exhausted",
      "0011_origin_capture_exhausted",
      "0012_addon_cycle_index",
      "0013_reactivation_cycle_release",
      "0014_challenged_attempt_marker_repair",
    ]);
  });
});

describe("migration 0004 (analytics costs) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0004_analytics_costs/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0005 (exact billing cadence) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0005_exact_billing_cadence/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the two nullable cadence columns", () => {
    // Nullable on purpose: pre-1.4.0 rows carry NULL until their next sync
    // and MRR falls back to the intervalWeeks approximation — a NOT NULL
    // DEFAULT would stamp a fake cadence on every existing contract instead.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(2);
    expect(sql).toMatch(
      /ALTER TABLE "SubscriptionContract" ADD COLUMN "billingIntervalUnit" TEXT;/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "SubscriptionContract" ADD COLUMN "billingIntervalCount" INTEGER;/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0006 (origin-order revenue + acquisition) stays additive and leaves ownership alone", () => {
  const sql = read(
    "prisma/migrations/0006_origin_order_revenue_acquisition/migration.sql",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the 18 origin/acquisition columns, on SubscriptionContract only", () => {
    const adds = sql.match(/ADD COLUMN\s+"(\w+)"/g) ?? [];
    expect(adds).toHaveLength(18);
    const names = adds.map((a) => /"(\w+)"/.exec(a)![1]);
    for (const name of names) {
      expect(name, name).toMatch(/^(originOrder|acq)/);
    }
    // Every ALTER targets the contract table — no other table is touched.
    const alters = sql.match(/ALTER TABLE\s+"(\w+)"/g) ?? [];
    expect(alters).toEqual(['ALTER TABLE "SubscriptionContract"']);
  });

  it("the one NOT NULL DEFAULT is the refund counter at 0 — historically honest", () => {
    // Everything else is nullable (null = "not captured yet"); a NOT NULL
    // DEFAULT would stamp fake data on every pre-existing row.
    const notNullAdds = (sql.match(/ADD COLUMN\s+"(\w+)"[^,;]*NOT NULL/g) ?? []).map(
      (a) => /"(\w+)"/.exec(a)![1],
    );
    expect(notNullAdds).toEqual(["originOrderRefundedCents"]);
    expect(sql).toMatch(
      /"originOrderRefundedCents" INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0007 (settledAt marker) stays additive and leaves ownership alone", () => {
  const sql = read(
    "prisma/migrations/0007_billing_attempt_settled_at/migration.sql",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("its one UPDATE backfills ONLY the newly added column", () => {
    // The generic no-UPDATE rule is relaxed here on purpose: the backfill
    // must be allowed, but only if the SET list touches nothing that existed
    // before this migration.
    const updates = sql.match(/UPDATE\s+"[^"]+"[\s\S]*?;/gi) ?? [];
    expect(updates).toHaveLength(1);
    const setCols = [...updates[0]!.matchAll(/SET\s+"(\w+)"|,\s*"(\w+)"\s*=/g)]
      .map((m) => m[1] ?? m[2])
      .filter(Boolean);
    expect(setCols).toEqual(["settledAt"]);
    expect(sql).toMatch(
      /ALTER TABLE "BillingAttempt" ADD COLUMN "settledAt" TIMESTAMP\(3\)/,
    );
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0008 (dunning concurrency) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0008_dunning_concurrency/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("its one UPDATE is the duplicate-open-case repair, confined to rn > 1 rows", () => {
    // Same relaxation as 0007: the repair that lets the unique index build
    // must be allowed, but it may only CLOSE surplus duplicate open cases —
    // never a contract's single healthy case, and never any other table.
    const updates = sql.match(/UPDATE\s+"(\w+)"/gi) ?? [];
    expect(updates).toEqual(['UPDATE "DunningCase"']);
    expect(sql).toMatch(/ranked\.rn > 1/);
    expect(sql).toMatch(/'SUPERSEDED_DUPLICATE'/);
  });

  it("adds the lease column and the one-open-case partial unique index", () => {
    expect(sql).toMatch(
      /ALTER TABLE "BillingAttempt" ADD COLUMN "dunningClaimedAt" TIMESTAMP\(3\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "DunningCase_one_open_case_per_contract"/,
    );
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0009 (line add claim) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0009_line_add_claim/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the one nullable claim column and its unique index", () => {
    // Nullable on purpose: checkout sync, gift-engine and import lines never
    // set the claim key, and existing rows are untouched — a NOT NULL would
    // fail the deploy on any populated table.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(sql).toMatch(
      /ALTER TABLE "ContractLine" ADD COLUMN "addClaimKey" TEXT;/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ContractLine_addClaimKey_key" ON "ContractLine"\("addClaimKey"\)/,
    );
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0010 (acq pickup exhausted) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0010_acq_pickup_exhausted/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the one nullable terminal-marker column", () => {
    // Nullable, no backfill on purpose: every existing row is legitimately
    // "not yet proven unfillable" — the next origin_order_backfill runs prove
    // (and stamp) the dead ones, so the capped pickup window can drain.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(sql).toMatch(
      /ALTER TABLE "SubscriptionContract" ADD COLUMN "acqPickupExhaustedAt" TIMESTAMP\(3\);/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0011 (origin capture exhausted) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0011_origin_capture_exhausted/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the one nullable terminal-marker column", () => {
    // Nullable, no backfill on purpose: every existing row is legitimately
    // "not yet proven unfetchable" — the next origin_order_backfill runs
    // prove (and stamp) the dead ones, so the capped money window can drain.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(sql).toMatch(
      /ALTER TABLE "SubscriptionContract" ADD COLUMN "originCaptureExhaustedAt" TIMESTAMP\(3\);/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0012 (addon cycle index) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0012_addon_cycle_index/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the one nullable cycle-index column", () => {
    // Nullable, no backfill on purpose: legacy add-on rows cannot know their
    // cycle, and consumeCycleOnSuccess reads NULL as "belongs to the next
    // settling cycle" — the exact pre-migration clearing behavior.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(sql).toMatch(
      /ALTER TABLE "ContractLine" ADD COLUMN "addonCycleIndex" INTEGER;/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0013 (reactivation cycle release) stays additive and leaves ownership alone", () => {
  const sql = read("prisma/migrations/0013_reactivation_cycle_release/migration.sql")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb anywhere in it", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      /\bRENAME\b/i,
      /\bALTER\s+TYPE\b/i,
      /\bALTER\s+COLUMN\s+"\w+"\s+TYPE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("adds only the one nullable release-marker column", () => {
    // Nullable, no backfill on purpose: legacy attempt rows (NULL) keep full
    // guard-blocking power — only a win-back reactivation that closes the
    // rows' churn episode ever stamps the marker.
    const adds = sql.match(/ADD COLUMN [^;]+/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(sql).toMatch(
      /ALTER TABLE "BillingAttempt" ADD COLUMN "supersededAt" TIMESTAMP\(3\);/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("migration 0014 (challenged-attempt marker repair) stays additive and leaves ownership alone", () => {
  const sql = read(
    "prisma/migrations/0014_challenged_attempt_marker_repair/migration.sql",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is additive only — no destructive verb, no schema change at all", () => {
    for (const verb of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bRENAME\b/i,
      /\bALTER\b/i, // data-only repair: not even an ADD COLUMN
      /\bCREATE\b/i,
    ]) {
      expect(sql, String(verb)).not.toMatch(verb);
    }
  });

  it("its one UPDATE clears ONLY the challenge-stamped marker, on CHALLENGED rows only", () => {
    // Same relaxation as 0007/0008: a repair UPDATE is allowed, but it may
    // only null the failure engine's processed marker on rows the OLD
    // challenge claims stamped (status CHALLENGED + category AUTH_REQUIRED —
    // the exact and only signature those claims wrote). Rows already FAILED
    // are never touched: clearing a genuinely processed marker would re-run
    // the engine on webhook redelivery.
    const updates = sql.match(/UPDATE\s+"(\w+)"/gi) ?? [];
    expect(updates).toEqual(['UPDATE "BillingAttempt"']);
    expect(sql).toMatch(/SET "declineCategory" = NULL/);
    expect(sql).toMatch(/"status" = 'CHALLENGED'/);
    expect(sql).toMatch(/"declineCategory" = 'AUTH_REQUIRED'/);
  });

  it("never touches the ownership column or its default", () => {
    expect(sql).not.toMatch(/ownership/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("the reclassification that completes the upgrade is wired in", () => {
  /**
   * reclassifyContracts is what turns the migration's UNKNOWN backfill into
   * real verdicts — and for one release it existed with NO caller anywhere in
   * the app: a documented go-live step that nothing performed. That is not
   * something a behavioural test can catch (dead code passes every test it has
   * none of), so the wiring itself is asserted.
   */
  it("go-live runs it, before the launch mode flips", () => {
    const source = stripComments(read("app/lib/launch/launch.server.ts"));
    expect(source).toContain("reclassifyAllContracts");
    const goLiveBody = source.slice(source.indexOf("export async function goLive"));
    const passAt = goLiveBody.indexOf("reclassifyForGoLive");
    const flipAt = goLiveBody.indexOf('mode: "LIVE"');
    expect(passAt).toBeGreaterThan(-1);
    expect(passAt).toBeLessThan(flipAt);
  });

  it("go-live sweeps every contract instead of one capped pass", () => {
    // reclassifyContracts stops at RECLASSIFY_DEFAULT_LIMIT rows. Go-live
    // calling it once meant a shop with more contracts than the cap went live
    // with the overflow left UNKNOWN — our own subscribers among them, and
    // UNKNOWN is not billable — with nothing in the product re-running it.
    const source = stripComments(read("app/lib/launch/launch.server.ts"));
    expect(source).toContain("reclassifyAllContracts");
    // The bounded pass appears nowhere: every occurrence of the name here is
    // part of "reclassifyAllContracts".
    expect(source.split("reclassifyAllContracts").join("")).not.toContain(
      "reclassifyContracts",
    );
  });

  it("the Preview & launch page exposes it as an action the admin can run", () => {
    const source = stripComments(read("app/routes/app.preview.tsx"));
    expect(source).toContain("reclassifyContracts");
    expect(source).toContain('intent === "recheck-ownership"');
    expect(source).toContain('intent: "recheck-ownership"'); // the button
  });
});
