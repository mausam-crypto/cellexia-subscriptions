/**
 * appendAudit sequence-contention tests (mocked prisma) — regression coverage
 * for the retry budget: a webhook burst colliding on the per-shop (shop, seq)
 * unique constraint must not exhaust the loop and throw, because callers like
 * finalizeOp sit AFTER a committed Shopify mutation where a throw releases
 * the idempotency guard (and a retry re-issues the mutation). The old cap of
 * 5 zero-backoff attempts exhausted under lockstep contention; the fix raises
 * the cap to 10 and adds jittered backoff.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

import { appendAudit } from "~/services/audit.server";

const SHOP = "cellexia-demo.myshopify.com";

function p2002(): Error & { code: string } {
  return Object.assign(new Error("unique constraint failed"), {
    code: "P2002",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  let seq = 0;
  db.auditLog.findFirst.mockImplementation(async () => ({
    seq: ++seq,
    hash: `hash-${seq}`,
  }));
});

describe("appendAudit sequence retries", () => {
  it("REGRESSION: survives 6 consecutive collisions (old 5-attempt cap threw)", async () => {
    let calls = 0;
    db.auditLog.create.mockImplementation(async () => {
      calls += 1;
      if (calls <= 6) throw p2002();
      return {};
    });

    await expect(
      appendAudit({
        shop: SHOP,
        actorType: "SYSTEM",
        action: "TEST_ACTION",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(7);
  }, 15_000);

  it("re-reads the tail before every attempt (fresh seq per retry)", async () => {
    let calls = 0;
    db.auditLog.create.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw p2002();
      return {};
    });

    await appendAudit({ shop: SHOP, actorType: "SYSTEM", action: "TEST" });

    expect(db.auditLog.findFirst).toHaveBeenCalledTimes(2);
    const seqs = db.auditLog.create.mock.calls.map(
      (call) => (call[0] as { data: { seq: number } }).data.seq,
    );
    // The retry allocated a NEW sequence number, not the collided one.
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });

  it("still surfaces non-collision errors immediately", async () => {
    db.auditLog.create.mockRejectedValue(new Error("connection refused"));
    await expect(
      appendAudit({ shop: SHOP, actorType: "SYSTEM", action: "TEST" }),
    ).rejects.toThrow("connection refused");
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
