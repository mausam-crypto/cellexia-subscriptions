import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SUPPORT / EDUCATION save truth (v1.28.0, P5.1).
 *
 * Before: both cards showed a hard-coded `mailto:support@cellexia.com` (a
 * domain the store does not own — a dead link) next to a bare "I'll keep my
 * subscription" button that closed the session as SAVED although nothing
 * had happened. Analytics counted a no-op as a save.
 *
 * Pins:
 *  - acceptSave(EDUCATION|SUPPORT) WITHOUT a submitted request throws and
 *    reverts the SAVED claim (session stays open) — a bare button / mailto
 *    click is not a save;
 *  - WITH a message it closes as SAVED, stamps savedAt, logs
 *    cancel.save_accepted AND routes the request through submitSupportRequest
 *    (surface cancel_flow, reason + session tagged, never a push-back);
 *  - a request whose record-of-truth write fails is NOT a save: the throw
 *    propagates and the SAVED claim reverts (the customer can retry);
 *  - the saves page renders the inline Get-help form (topic fixed by the
 *    card, required message) with the merchant's REAL channels, no mailto to
 *    cellexia.com, no bare "stay" accept form;
 *  - the saved page shows the real channels too;
 *  - the route parses support_topic / support_message into
 *    AcceptSaveParams.support.
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  claims: [] as Array<Record<string, unknown>>,
  reverts: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  submitSupportRequest: vi.fn(async (_input: unknown): Promise<unknown> => ({
    eventLogged: true,
    pushBackApplied: false,
    pushBackFailed: false,
    alertRaised: true,
    emailSent: true,
    slaBusinessDays: 1,
  })),
  contractUpdate: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      findMany: vi.fn(async (): Promise<unknown[]> => [{ id: "c_1" }]),
      update: mocks.contractUpdate,
    },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.claims.push(args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.reverts.push(args.data);
        return store.session;
      }),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") {
      return {
        enabled: true,
        maxSavesShown: 3,
        frequencySuggestDeltaWeeks: 2,
        pauseSuggestMonths: 2,
        reasonOfferPctDefault: 15,
        reasonOfferCyclesDefault: 2,
        reasonOfferCooldownDays: 90,
        giftSaveEnabled: false,
        giftSaveCooldownDays: 180,
        downsizeSaveEnabled: false,
        sessionFreshMinutes: 60,
      };
    }
    if (key === "pause") return { maxMonths: 3 };
    if (key === "chargeTiming") return { chargeHourLocal: 0 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 15 })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: vi.fn(async () => ({})) }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (a: { current: unknown }) => a.current),
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: vi.fn(async () => ({ locked: false, until: null })),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: vi.fn(async (): Promise<unknown> => ({})),
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  swapPriceCentsFor: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/support/request.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/support/request.server")>();
  return { ...actual, submitSupportRequest: mocks.submitSupportRequest };
});

import { acceptSave } from "~/lib/cancel/engine.server";
import { pageSaved, pageSaves } from "~/lib/cancel/pages.server";
import { resolveSupportChannels } from "~/lib/support/channels.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

function contractFixture() {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    firstName: "Anna",
    status: "ACTIVE",
    ownership: "OURS",
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 3,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    lines: [],
  };
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "SHIPPING_ISSUES",
    reasonDetail: null,
    savesShown: [{ kind: "SUPPORT" }, { kind: "EDUCATION" }],
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claims = [];
  store.reverts = [];
  store.contract = contractFixture();
  store.session = sessionFixture();
});

describe("acceptSave — SUPPORT / EDUCATION are only saves when a request was submitted", () => {
  for (const kind of ["SUPPORT", "EDUCATION"] as const) {
    it(`${kind}: bare accept (no message) throws and reverts the SAVED claim`, async () => {
      await expect(acceptSave("cs_1", kind, {})).rejects.toThrow(/requires a submitted support request/);
      // The claim was taken first (atomic closer) and then reverted. SUPPORT
      // claims SAVED_PENDING (v1.28.0 concierge save — a request awaiting a
      // reply is not yet a save); EDUCATION stays SAVED.
      expect(store.claims[0]).toEqual(
        expect.objectContaining({
          outcome: kind === "SUPPORT" ? "SAVED_PENDING" : "SAVED",
          saveAccepted: kind,
        }),
      );
      expect(store.reverts).toContainEqual(
        expect.objectContaining({ outcome: null, saveAccepted: null, completedAt: null }),
      );
      expect(mocks.submitSupportRequest).not.toHaveBeenCalled();
      expect(mocks.contractUpdate).not.toHaveBeenCalled();
      expect(mocks.logEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "cancel.save_accepted" }),
      );
    });

    it(`${kind}: whitespace-only message is still a bare accept`, async () => {
      await expect(
        acceptSave("cs_1", kind, { support: { topic: "OTHER", message: "   " } }),
      ).rejects.toThrow(/requires a submitted support request/);
    });
  }

  it("SUPPORT with a message: request routed (cancel_flow, reason + session, no push-back), session SAVED, savedAt stamped, save_accepted logged", async () => {
    await acceptSave("cs_1", "SUPPORT", {
      support: { topic: "DELIVERY", message: "Two boxes late" },
    });
    expect(mocks.submitSupportRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitSupportRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        shopId: "shop_1",
        shopDomain: "cellexia.myshopify.com",
        topic: "DELIVERY",
        message: "Two boxes late",
        pushBack: false,
        surface: "cancel_flow",
        cancelReason: "SHIPPING_ISSUES",
        cancelSessionId: "cs_1",
        source: "CUSTOMER_PORTAL",
      }),
    );
    expect(store.reverts).toEqual([]);
    expect(mocks.contractUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ savedAt: expect.any(Date) }) }),
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.save_accepted",
        payload: expect.objectContaining({ saveKind: "SUPPORT", reason: "SHIPPING_ISSUES" }),
      }),
    );
  });

  it("EDUCATION defaults the topic to OTHER (a consultation, not a delivery complaint)", async () => {
    await acceptSave("cs_1", "EDUCATION", { support: { topic: "OTHER", message: "What order?" } });
    expect(mocks.submitSupportRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({ topic: "OTHER", surface: "cancel_flow" }),
    );
  });

  it("a request whose record could not be written is NOT a save — the throw propagates, the claim reverts, nothing counts", async () => {
    // submitSupportRequest contains alert/email/push-back itself; its only
    // throw is the support.requested record-of-truth write. SAVED means a
    // request was submitted, so a failed record must not close the session.
    mocks.submitSupportRequest.mockRejectedValueOnce(new Error("db down"));
    await expect(
      acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "Late" } }),
    ).rejects.toThrow(/db down/);
    expect(store.reverts).toContainEqual(
      expect.objectContaining({ outcome: null, saveAccepted: null, completedAt: null }),
    );
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancel.save_accepted" }),
    );
  });
});

describe("saves page — inline Get-help form instead of a dead mailto", () => {
  const channels = resolveSupportChannels(
    { email: "care@cellexialabs.com", whatsapp: "+41791234567" },
    null,
  );

  it("SUPPORT card: real channel buttons + a form posting accept_save with a required message; no bare stay button", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "csrf-1",
      contractId: "c_1",
      offers: [{ kind: "SUPPORT" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
      support: channels,
    });
    expect(page.body).toContain('href="mailto:care@cellexialabs.com?subject=Delivery%20issue"');
    expect(page.body).toContain('href="https://wa.me/41791234567"');
    expect(page.body).not.toContain("cellexia.com");
    expect(page.body).toContain('name="intent" value="accept_save"');
    expect(page.body).toContain('name="kind" value="SUPPORT"');
    expect(page.body).toContain('name="support_topic" value="DELIVERY"');
    expect(page.body).toMatch(/<textarea[^>]*name="support_message"[^>]*required/);
    expect(page.body).toContain("Send to our team and keep my subscription");
    expect(page.body).not.toContain("I'll keep my subscription for now");
    // Privacy line rides along.
    expect(page.body).toContain("We keep it with your subscription history.");
  });

  it("EDUCATION card: guide link stays a plain link; consultation is the form (topic OTHER)", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "csrf-1",
      contractId: "c_1",
      offers: [{ kind: "EDUCATION" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
      support: channels,
      // Guide URL is settings-driven since P4.4 (portal.routineGuideUrl).
      education: { routineGuideUrl: "/pages/routine-guide", howToUseUrl: "", faqUrl: "" },
    });
    expect(page.body).toContain('href="/pages/routine-guide"');
    expect(page.body).toContain('href="mailto:care@cellexialabs.com?subject=Skincare%20consultation"');
    expect(page.body).toContain('name="kind" value="EDUCATION"');
    expect(page.body).toContain('name="support_topic" value="OTHER"');
    expect(page.body).not.toContain("Sounds good — I'll keep my subscription");
  });

  it("no channels resolved → no contact buttons at all (never a placeholder address), form still there", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "csrf-1",
      contractId: "c_1",
      offers: [{ kind: "SUPPORT" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
    });
    expect(page.body).not.toContain("mailto:");
    expect(page.body).not.toContain("wa.me");
    expect(page.body).toContain('name="support_message"');
  });

  it("saved page: real channels, no mailto to cellexia.com", () => {
    const saved = pageSaved({
      locale: "en",
      contractId: "c_1",
      messageKey: "cancel.saved.support",
      messageVars: {},
      showEducationLinks: false,
      showSupportLink: true,
      support: channels,
    });
    expect(saved.body).toContain("mailto:care@cellexialabs.com");
    expect(saved.body).not.toContain("cellexia.com");
    const bare = pageSaved({
      locale: "en",
      contractId: "c_1",
      messageKey: "cancel.saved.education",
      messageVars: {},
      showEducationLinks: true,
      showSupportLink: false,
      education: { routineGuideUrl: "/pages/routine-guide", howToUseUrl: "", faqUrl: "" },
    });
    expect(bare.body).toContain('href="/pages/routine-guide"');
    expect(bare.body).not.toContain("mailto:");
  });
});

describe("source contracts", () => {
  it("the cancel route parses support_topic / support_message into AcceptSaveParams.support", () => {
    const route = src("app/routes/proxy.cancel.$id.$step.tsx");
    expect(route).toContain('form.get("support_message")');
    expect(route).toContain('form.get("support_topic")');
    expect(route).toContain("support: {");
  });

  it("no hard-coded cellexia.com support address remains in the cancel module or portal card", () => {
    for (const rel of [
      "app/lib/cancel/pages.server.ts",
      "app/lib/cancel/engine.server.ts",
      "app/lib/support/portal-card.server.ts",
      "app/lib/support/channels.server.ts",
      "app/lib/support/request.server.ts",
    ]) {
      expect(src(rel), rel).not.toContain("cellexia.com");
    }
  });
});
