import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal "Confirm with my bank" (v1.28.0, P1.6): resolvePortalThreeDs behind
 * POST /api/payment_3ds.
 *
 *  - the CHALLENGED attempt's fresh nextActionUrl (CellexiaBillingAttemptStatus)
 *    → persisted on BillingAttempt.challengeUrl → gated by the trusted
 *    Shopify-redirect helper → redirect;
 *  - an untrusted host is refused;
 *  - a failed status query falls back to the stored challengeUrl;
 *  - no pending action → the attempt is re-checked (recheckAttemptOutcome)
 *    and the settled outcome reported;
 *  - no attempt / not CHALLENGED → none (the caller offers Retry now).
 */

const mocks = vi.hoisted(() => ({
  gql: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  recheckAttemptOutcome: vi.fn(async (_id: string): Promise<string> => "UNRESOLVED"),
}));

vi.mock("~/db.server", () => ({
  default: {
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      updateMany: mocks.attemptUpdateMany,
    },
  },
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: mocks.gql }));
vi.mock("~/lib/billing/scheduler.server", () => ({
  recheckAttemptOutcome: mocks.recheckAttemptOutcome,
}));

import { resolvePortalThreeDs } from "~/lib/portal/threeds.server";
import { isTrustedShopifyRedirect } from "~/lib/magiclinks/redirect";
import { TOAST_KEYS } from "~/lib/portal/layout.server";
import en from "../app/lib/i18n/locales/en.json";

const ADMIN = { graphql: vi.fn() } as never;
const CHALLENGED = {
  id: "att_ch",
  status: "CHALLENGED",
  shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/77",
  challengeUrl: null,
};
const HOSTED = "https://checkout.shopify.com/3ds/abc";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptFindUnique.mockResolvedValue(CHALLENGED);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.recheckAttemptOutcome.mockResolvedValue("UNRESOLVED");
});

describe("resolvePortalThreeDs", () => {
  it("queries the attempt's status, persists the challenge URL and redirects to it", async () => {
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: { id: "x", ready: false, nextActionUrl: HOSTED },
    });
    const out = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(out).toEqual({ kind: "redirect", url: HOSTED, attemptId: "att_ch" });
    // Same query shape as the stale-attempt sweep, by Shopify attempt id.
    const [, query, vars] = mocks.gql.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(query).toContain("CellexiaBillingAttemptStatus");
    expect(query).toContain("nextActionUrl");
    expect(vars).toEqual({ id: CHALLENGED.shopifyAttemptId });
    // Persisted, status-guarded (a settled row is never rewritten).
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "att_ch", status: "CHALLENGED" },
      data: { challengeUrl: HOSTED },
    });
    expect(mocks.recheckAttemptOutcome).not.toHaveBeenCalled();
  });

  it("does not rewrite an unchanged stored URL", async () => {
    mocks.attemptFindUnique.mockResolvedValue({ ...CHALLENGED, challengeUrl: HOSTED });
    mocks.gql.mockResolvedValue({ subscriptionBillingAttempt: { nextActionUrl: HOSTED } });
    const out = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(out.kind).toBe("redirect");
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an untrusted host even when Shopify returned it (persisted for the record, never followed)", async () => {
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: { nextActionUrl: "https://evil.example/3ds" },
    });
    const out = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(out).toEqual({ kind: "untrusted", attemptId: "att_ch" });
  });

  it("falls back to the stored challengeUrl when the status query fails, and to 'none' without one", async () => {
    mocks.gql.mockRejectedValue(new Error("Shopify 502"));
    mocks.attemptFindUnique.mockResolvedValue({ ...CHALLENGED, challengeUrl: HOSTED });
    const out = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(out).toEqual({ kind: "redirect", url: HOSTED, attemptId: "att_ch" });
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled(); // nothing new learned

    // No admin client at all behaves like a failed query.
    const noAdmin = await resolvePortalThreeDs({ admin: null, attemptId: "att_ch" });
    expect(noAdmin.kind).toBe("redirect");

    mocks.attemptFindUnique.mockResolvedValue(CHALLENGED); // no stored URL
    const settled = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    // Nothing to redirect to → the settled lane, re-check unresolved.
    expect(settled).toEqual({ kind: "settled", attemptId: "att_ch", outcome: "UNRESOLVED" });
  });

  it("no pending action → re-checks the attempt through the scheduler and reports what settled", async () => {
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: { ready: true, nextActionUrl: null },
    });
    mocks.recheckAttemptOutcome.mockResolvedValue("SUCCESS");
    const paid = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(paid).toEqual({ kind: "settled", attemptId: "att_ch", outcome: "SUCCESS" });
    expect(mocks.recheckAttemptOutcome).toHaveBeenCalledWith("att_ch");

    mocks.recheckAttemptOutcome.mockResolvedValue("FAILED");
    const failed = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(failed).toMatchObject({ kind: "settled", outcome: "FAILED" });

    // A throwing re-check reads as unresolved, never as a 500.
    mocks.recheckAttemptOutcome.mockRejectedValue(new Error("boom"));
    const unresolved = await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" });
    expect(unresolved).toMatchObject({ kind: "settled", outcome: "UNRESOLVED" });
  });

  it("no attempt id, unknown attempt, or an attempt that is no longer CHALLENGED → none", async () => {
    expect(await resolvePortalThreeDs({ admin: ADMIN, attemptId: null })).toEqual({ kind: "none" });
    mocks.attemptFindUnique.mockResolvedValue(null);
    expect(await resolvePortalThreeDs({ admin: ADMIN, attemptId: "gone" })).toEqual({ kind: "none" });
    mocks.attemptFindUnique.mockResolvedValue({ ...CHALLENGED, status: "SUCCESS" });
    expect(await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" })).toEqual({ kind: "none" });
    mocks.attemptFindUnique.mockResolvedValue({ ...CHALLENGED, shopifyAttemptId: null });
    expect(await resolvePortalThreeDs({ admin: ADMIN, attemptId: "att_ch" })).toEqual({ kind: "none" });
    expect(mocks.gql).not.toHaveBeenCalled();
  });
});

describe("the trusted-redirect gate is the shared one", () => {
  it("accepts Shopify hosts over https only, dot-boundary", () => {
    expect(isTrustedShopifyRedirect("https://checkout.shopify.com/x")).toBe(true);
    expect(isTrustedShopifyRedirect("https://cellexia.myshopify.com/x")).toBe(true);
    expect(isTrustedShopifyRedirect("http://checkout.shopify.com/x")).toBe(false);
    expect(isTrustedShopifyRedirect("https://notshopify.com/x")).toBe(false);
    expect(isTrustedShopifyRedirect("https://evilshopify.com/x")).toBe(false);
    expect(isTrustedShopifyRedirect("")).toBe(false);
    expect(isTrustedShopifyRedirect(null)).toBe(false);
  });
});

describe("portal toasts for the recovery verbs", () => {
  it("every toast key the dispatcher can emit is renderable and has English copy", () => {
    for (const key of [
      "retry_started",
      "retry_too_soon",
      "retry_needs_bank",
      "retry_paused",
      "retry_unavailable",
      "threeds_paid",
      "threeds_failed",
      "threeds_none",
      "threeds_unavailable",
    ]) {
      expect(TOAST_KEYS.has(key)).toBe(true);
      expect(typeof (en as Record<string, string>)[`portal.toast.${key}`]).toBe("string");
    }
    // v1.28.0 audit: a failed retry sends no email between ladder rungs, so
    // the copy only promises what the code guarantees (an order confirmation
    // on success; the banner shows the next step otherwise).
    expect((en as Record<string, string>)["portal.toast.retry_started"]).toBe(
      "We're retrying your payment now — if it goes through you'll get your order confirmation; otherwise this page will show the next step.",
    );
  });
});
