import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CHALLENGED is strictly a forward transition from PENDING — a late or
 * replayed 3DS webhook must never stomp a settled attempt.
 *
 * The timeline being defended: Shopify delivers CHALLENGED while the app is
 * restarting (no receipt written → Shopify queues a retry). The customer
 * completes 3DS; SUCCESS lands and fully settles the attempt (counters
 * incremented, dunning case RECOVERED). The CHALLENGED retry then arrives an
 * hour later. An unguarded write would flip the settled SUCCESS back to
 * CHALLENGED — reopening dunning for a PAID cycle, emailing the customer a
 * 3DS link for a charge that already went through, letting the exhaust sweep
 * eventually cancel a customer in good standing, and re-arming the success
 * path's status≠SUCCESS claim so a replayed SUCCESS double-increments
 * ordersCount / lifetimeRevenueCents.
 *
 * Three sites hold the line (source contract, same pinning pattern as
 * tests/cancel-save-guards.test.ts):
 *  1. webhook handler handleBillingAttemptChallenged — PENDING-guarded claim;
 *  2. billing stale sweep resolveStaleAttempt — PENDING-guarded claims for
 *     its CHALLENGED and FAILED branches (the sweep reads PENDING, but the
 *     outcome webhook can settle the attempt inside the sweep's window);
 *  3. dunning onBillingAttemptChallenged — cycle-already-succeeded guard
 *     (never open/extend a case for a cycle with a SUCCESS attempt) plus a
 *     status-guarded claim of its own.
 */

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const handlersSource = src("../app/lib/webhooks/handlers.server.ts");
const schedulerSource = src("../app/lib/billing/scheduler.server.ts");
const dunningSource = src("../app/lib/dunning/engine.server.ts");

describe("webhook handleBillingAttemptChallenged", () => {
  it("claims the PENDING → CHALLENGED transition atomically and stops on a lost claim", () => {
    expect(handlersSource).toContain(
      'where: { id: attempt.id, status: "PENDING" },',
    );
    expect(handlersSource).toContain("replay or already settled — never stomp");
  });

  it("documents CHALLENGED as a forward-only transition in the handler contract", () => {
    expect(handlersSource).toContain(
      "CHALLENGED is strictly a forward transition from PENDING",
    );
  });

  it("the success path's replay claim stays status-guarded (the double-increment arm)", () => {
    expect(handlersSource).toContain(
      'where: { id: attempt.id, status: { not: "SUCCESS" } },',
    );
  });
});

describe("billing stale sweep resolveStaleAttempt", () => {
  it("both webhook-raceable branches (CHALLENGED and FAILED) claim from PENDING only", () => {
    const claims = schedulerSource.match(
      /where: \{ id: attempt\.id, status: "PENDING" \},/g,
    );
    expect(claims?.length).toBeGreaterThanOrEqual(2);
  });

  it("a lost CHALLENGED claim hands off NOTHING to dunning", () => {
    expect(schedulerSource).toContain(
      "an unguarded update would flip a settled",
    );
    expect(schedulerSource).toContain("hand off nothing");
  });
});

describe("dunning onBillingAttemptChallenged", () => {
  it("never opens or extends a case for a cycle that already has a SUCCESS attempt", () => {
    // Same guard as the failure path — pinned for BOTH: the two
    // cycle_already_succeeded markers are onBillingAttemptFailed's and
    // onBillingAttemptChallenged's.
    const guards = dunningSource.match(/reason: "cycle_already_succeeded"/g);
    expect(guards?.length).toBeGreaterThanOrEqual(2);
  });

  it("its own attempt write is status-guarded (PENDING or CHALLENGED re-entry only)", () => {
    expect(dunningSource).toContain(
      'where: { id: attempt.id, status: { in: ["PENDING", "CHALLENGED"] } },',
    );
    expect(dunningSource).toContain("a settled attempt is never resurrected");
  });
});
