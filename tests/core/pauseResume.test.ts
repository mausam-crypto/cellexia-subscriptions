/**
 * Pause-resume job tests (mocked prisma) — regression coverage for:
 *
 *  - PAUSE_ENDING reminders are NOT sent for dunning grace pauses
 *    (CONFIGURABILITY.md: "dunning grace pauses excluded") — a failing-card
 *    customer must never get "your deliveries resume on {date}" followed by
 *    the final-notice email on resume day.
 *  - Orphan detection: PAUSED contracts with no pausedUntil are invisible to
 *    both job passes (nothing will ever resume them); the job surfaces them
 *    with one PAUSE_ORPHAN_DETECTED audit row per contract.
 *  - The reminder-lead default matches the documented 3 days.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionContract: { findMany: vi.fn() },
  shopSettings: { findUnique: vi.fn() },
  dunningState: { findUnique: vi.fn(), update: vi.fn() },
  auditLog: { findFirst: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

const shopifyClient = vi.hoisted(() => ({
  getOfflineAdmin: vi.fn(async () => ({ graphql: { __tag: "graphql" } })),
}));
vi.mock("~/services/core/shopifyClient.server", () => shopifyClient);

const core = vi.hoisted(() => ({ resumeContract: vi.fn() }));
vi.mock("~/services/core/contracts.server", () => core);

import {
  isDunningGracePause,
  runPauseResumeJob,
} from "~/services/core/pauseResume.server";

const SHOP = "cellexia-demo.myshopify.com";
const NOW = Date.now();

function pausedContract(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    shopifyCustomerId: "gid://shopify/Customer/777",
    customerEmail: "marie@example.com",
    status: "PAUSED",
    pausedUntil: new Date(NOW + 2 * 24 * 60 * 60 * 1000), // 2 days out
    shopifyContractId: "gid://shopify/SubscriptionContract/9001",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.shopSettings.findUnique.mockResolvedValue(null);
  db.dunningState.findUnique.mockResolvedValue(null);
  db.auditLog.findFirst.mockResolvedValue(null);
  // Call order per shop: pass 1+2 list (pausedUntil not null), then pass 3
  // orphan list — default to empty for both.
  db.subscriptionContract.findMany.mockResolvedValue([]);
});

describe("isDunningGracePause", () => {
  it("is true only for a set graceUntil in a grace-handoff phase", () => {
    const graceUntil = new Date();
    expect(isDunningGracePause({ graceUntil, phase: "GRACE" })).toBe(true);
    expect(isDunningGracePause({ graceUntil, phase: "FINAL_NOTICE" })).toBe(true);
    expect(isDunningGracePause({ graceUntil, phase: "EXHAUSTED" })).toBe(true);
  });

  it("is false for customer pauses and resolved episodes", () => {
    expect(isDunningGracePause(null)).toBe(false);
    expect(isDunningGracePause(undefined)).toBe(false);
    expect(isDunningGracePause({ graceUntil: null, phase: "GRACE" })).toBe(false);
    expect(
      isDunningGracePause({ graceUntil: new Date(), phase: "RESOLVED" }),
    ).toBe(false);
    expect(
      isDunningGracePause({ graceUntil: new Date(), phase: "RETRYING" }),
    ).toBe(false);
  });
});

describe("runPauseResumeJob — reminder pass", () => {
  it("sends PAUSE_ENDING for a customer pause inside the reminder window", async () => {
    db.subscriptionContract.findMany
      .mockResolvedValueOnce([pausedContract()]) // passes 1+2
      .mockResolvedValueOnce([]); // pass 3 (orphans)

    const [summary] = await runPauseResumeJob(SHOP);

    expect(summary.remindersSent).toBe(1);
    expect(events.emitLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "PAUSE_ENDING", contractId: "c1" }),
    );
  });

  it("REGRESSION: skips the reminder for a dunning grace pause", async () => {
    db.subscriptionContract.findMany
      .mockResolvedValueOnce([pausedContract()])
      .mockResolvedValueOnce([]);
    db.dunningState.findUnique.mockResolvedValue({
      contractId: "c1",
      phase: "GRACE",
      graceUntil: new Date(NOW + 2 * 24 * 60 * 60 * 1000),
    });

    const [summary] = await runPauseResumeJob(SHOP);

    expect(summary.remindersSent).toBe(0);
    expect(events.emitLifecycleEvent).not.toHaveBeenCalled();
  });

  it("defaults the reminder lead to the documented 3 days", async () => {
    // 4 days out: inside the old (undocumented) 5-day lead, outside the
    // documented 3-day lead — no reminder must fire.
    db.subscriptionContract.findMany
      .mockResolvedValueOnce([
        pausedContract({
          pausedUntil: new Date(NOW + 4 * 24 * 60 * 60 * 1000),
        }),
      ])
      .mockResolvedValueOnce([]);

    const [summary] = await runPauseResumeJob(SHOP);

    expect(summary.remindersSent).toBe(0);
    expect(events.emitLifecycleEvent).not.toHaveBeenCalled();
  });
});

describe("runPauseResumeJob — orphan pass", () => {
  it("flags PAUSED contracts with no pausedUntil exactly once", async () => {
    const orphan = pausedContract({ id: "c9", pausedUntil: null });
    db.subscriptionContract.findMany
      .mockResolvedValueOnce([]) // passes 1+2 (filter excludes the orphan)
      .mockResolvedValueOnce([orphan]); // pass 3

    const [summary] = await runPauseResumeJob(SHOP);

    expect(summary.orphans).toBe(1);
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAUSE_ORPHAN_DETECTED",
        subjectId: "c9",
      }),
    );

    // Second hourly run: the audit row already exists → no duplicate append.
    audit.appendAudit.mockClear();
    db.auditLog.findFirst.mockResolvedValue({ id: "audit1" });
    db.subscriptionContract.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([orphan]);

    const [second] = await runPauseResumeJob(SHOP);
    expect(second.orphans).toBe(1);
    expect(audit.appendAudit).not.toHaveBeenCalled();
  });
});
