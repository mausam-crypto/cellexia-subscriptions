import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Admin dunning intents vs. the recovery webhook — the stale-page overwrite.
 *
 * "Retry now" / "Mark resolved" / "Cancel case" (Dunning queue and subscriber
 * cockpit) used to perform an UNCONDITIONAL state overwrite on the DunningCase:
 * no open-state guard, and in the cockpit the caseId came straight from the
 * form with `update({ where: { id: caseId } })` — unscoped to the contract or
 * shop. The engine's own reopen path guards ("RETRYING cases already have a
 * schedule; recovery closes the rest") and clears resolvedAt/resolution when
 * re-opening; the admin routes did neither. Consequence: an admin on a stale
 * page clicks "Retry now" after the customer's card was fixed and the webhook
 * RECOVERED the case → the case flips back to RETRYING with resolvedAt/
 * resolution still stamped → the sweep re-bills the already-billed cycle,
 * Shopify refuses, the case parks AWAITING_CUSTOMER, daysOpen (measured from
 * the ORIGINAL openedAt) blows past cancelAfterFailedDays, and exhaustCase
 * cancels an ACTIVE, fully-paid contract with reason PAYMENT_FAILED — while
 * the ladder re-sends "your payment failed" to a customer whose payment
 * succeeded. A bare POST with a foreign caseId could flip ANY case in the
 * database while resetting consecutiveFailures on the loaded contract.
 *
 * The fix under test: every admin case transition goes through the engine's
 * transitionOpenCase — ONE conditional updateMany whose where-clause carries
 * the case id, the authorized contract id AND `state: { in: OPEN_CASE_STATES }`
 * — so the guard and the write are atomic and a concurrent webhook recovery
 * cannot race the click. Behavioural tests drive the real engine function;
 * source pins keep both routes on the guarded path.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (): Promise<unknown> => null),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
}));

vi.mock("~/db.server", () => ({
  default: {
    dunningCase: { updateMany: mocks.dunningCaseUpdateMany },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://example.test/portal"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractFail: vi.fn(),
    createBillingAttempt: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(),
    withContractDraft: vi.fn(),
  };
});

import {
  OPEN_CASE_STATES,
  transitionOpenCase,
} from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-06T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 1 });
});

// ── Behaviour: the guarded transition itself ─────────────────────────────────

describe("transitionOpenCase — one atomic, scoped, open-state-guarded write", () => {
  it("RETRYING: schedules an immediate retry ONLY where the case is open and belongs to the contract", async () => {
    const claimed = await transitionOpenCase("case_1", "cm_c1", "RETRYING", NOW);

    expect(claimed).toBe(true);
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "case_1",
        contractId: "cm_c1",
        state: { in: OPEN_CASE_STATES },
      },
      data: { state: "RETRYING", nextRetryAt: NOW },
    });
  });

  it("RECOVERED: stamps resolvedAt/resolution and clears the schedule, under the same guard", async () => {
    await transitionOpenCase("case_1", "cm_c1", "RECOVERED", NOW);

    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "case_1",
        contractId: "cm_c1",
        state: { in: OPEN_CASE_STATES },
      },
      data: {
        state: "RECOVERED",
        resolvedAt: NOW,
        resolution: "RECOVERED",
        nextRetryAt: null,
      },
    });
  });

  it("CANCELLED: same shape as the engine's own close", async () => {
    await transitionOpenCase("case_1", "cm_c1", "CANCELLED", NOW);

    const call = mocks.dunningCaseUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where.state).toEqual({ in: OPEN_CASE_STATES });
    expect(call.data).toEqual({
      state: "CANCELLED",
      resolvedAt: NOW,
      resolution: "CANCELLED",
      nextRetryAt: null,
    });
  });

  it("returns FALSE when nothing matched — a recovered case (or a foreign caseId) is refused, not overwritten", async () => {
    // The webhook recovered the case between the admin's page load and the
    // click (or the caseId belongs to another contract): the conditional
    // write matches nothing, so the click mutates NOTHING — no state flip,
    // no stale resolvedAt/resolution carried into an "open" case.
    mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 0 });

    const claimed = await transitionOpenCase("case_1", "cm_c1", "RETRYING", NOW);

    expect(claimed).toBe(false);
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledTimes(1); // no fallback write
  });

  it("the open-state vocabulary is the engine's own (all four open states, nothing resolved)", () => {
    expect([...OPEN_CASE_STATES].sort()).toEqual([
      "AWAITING_3DS",
      "AWAITING_CUSTOMER",
      "OPEN",
      "RETRYING",
    ]);
  });
});

// ── Source pins: both admin routes stay on the guarded path ──────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** Blank out comments so prose can neither satisfy nor defeat a rule. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function caseBlock(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Dunning queue (app/routes/app.dunning.tsx) — guarded intents", () => {
  const source = stripComments(read("app/routes/app.dunning.tsx"));

  it("retryNow goes through transitionOpenCase and refuses when the claim fails", () => {
    const block = caseBlock(source, 'case "retryNow"', 'case "sendCardLink"');
    expect(block).toContain("transitionOpenCase(");
    expect(block).toContain("already resolved");
    // No unconditional state overwrite left behind.
    expect(block).not.toContain("prisma.dunningCase.update(");
  });

  it("sendCardLink refuses on a resolved case before any email goes out", () => {
    const block = caseBlock(source, 'case "sendCardLink"', 'case "cancelContract"');
    const guardAt = block.indexOf("OPEN_CASE_STATES.includes(kase.state)");
    const sendAt = block.indexOf("sendNotification(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(guardAt); // guard first, mail second
  });

  it("cancelContract refuses on a resolved case and closes the case conditionally", () => {
    const block = caseBlock(source, 'case "cancelContract"', "default:");
    expect(block).toContain("OPEN_CASE_STATES.includes(kase.state)");
    expect(block).toContain("transitionOpenCase(");
    expect(block).not.toContain("prisma.dunningCase.update(");
  });

  it("no raw dunningCase.update in the route writes `state` (counters may remain)", () => {
    let at = source.indexOf("prisma.dunningCase.update(");
    while (at !== -1) {
      const window = source.slice(at, at + 300);
      expect(window).not.toMatch(/\bstate:/);
      at = source.indexOf("prisma.dunningCase.update(", at + 1);
    }
  });

  it("takes the open-state vocabulary from the engine, not a local copy", () => {
    expect(source).not.toMatch(/const OPEN_CASE_STATES/);
    expect(source).toContain('from "~/lib/dunning/index.server"');
  });
});

describe("Subscriber cockpit (app/routes/app.subscribers.$id.tsx) — scoped + guarded intents", () => {
  const source = stripComments(read("app/routes/app.subscribers.$id.tsx"));

  it.each([
    ['case "dunningRetryNow"', 'case "dunningResolve"', '"RETRYING"'],
    ['case "dunningResolve"', 'case "dunningCancelCase"', '"RECOVERED"'],
    ['case "dunningCancelCase"', "case \"updateAddress\"", '"CANCELLED"'],
  ])("%s pins the form caseId to the authorized contract", (from, to, target) => {
    const block = caseBlock(source, from, to);
    // The caseId comes from the form; the transition must carry the loaded
    // contract's id so a bare POST cannot move another contract's case.
    expect(block).toContain(`transitionOpenCase(caseId, contractId, ${target}`);
    expect(block).toContain("already resolved");
  });

  it("no unscoped dunningCase.update survives anywhere in the cockpit", () => {
    expect(source).not.toContain("prisma.dunningCase.update(");
  });

  it("takes the open-state vocabulary from the engine, not a local copy", () => {
    expect(source).not.toMatch(/const OPEN_CASE_STATES/);
    expect(source).toContain('from "~/lib/dunning/index.server"');
  });
});
