import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  nextAttemptNumber,
} from "./helpers/idempotency";

/**
 * Idempotency-key contract: "{contractLocalId}:{cycleIndex}:{attemptNumber}"
 * (golden rule 4). The builder lives inline in the billing/dunning modules;
 * tests/helpers/idempotency.ts mirrors it, and the source-pinning test below
 * fails if either real module drifts from the mirrored format.
 */

const KEY_FORMAT = /^[A-Za-z0-9_-]+:\d+:\d+$/;

describe("key format", () => {
  it("is contractId:cycleIndex:attemptNumber", () => {
    expect(buildIdempotencyKey("cmabc123xyz", 4, 1)).toBe("cmabc123xyz:4:1");
    expect(buildIdempotencyKey("cmabc123xyz", 0, 3)).toBe("cmabc123xyz:0:3");
  });

  it("splits back into exactly 3 parts for local cuid ids", () => {
    const key = buildIdempotencyKey("cm4kq0v9h0000abcd1234efgh", 12, 2);
    expect(key).toMatch(KEY_FORMAT);
    const [contractId, cycle, attempt] = key.split(":");
    expect(contractId).toBe("cm4kq0v9h0000abcd1234efgh");
    expect(Number(cycle)).toBe(12);
    expect(Number(attempt)).toBe(2);
    expect(key.split(":")).toHaveLength(3);
  });

  it("a Shopify GID would corrupt the format — the contract mandates local ids", () => {
    // Golden rule: local cuid, never the GID. This documents WHY:
    const gidKey = buildIdempotencyKey("gid://shopify/SubscriptionContract/1", 4, 1);
    expect(gidKey.split(":").length).toBeGreaterThan(3); // ambiguous → unusable
    expect(gidKey).not.toMatch(KEY_FORMAT);
    // Cuids are colon-free, so the canonical shape holds.
    expect("cm4kq0v9h0000abcd1234efgh").not.toContain(":");
  });
});

describe("uniqueness invariants", () => {
  it("same (contract, cycle): consecutive attempts produce distinct keys", () => {
    const keys = [1, 2, 3, 4].map((attempt) =>
      buildIdempotencyKey("cm_contract_a", 7, attempt),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "cm_contract_a:7:1",
      "cm_contract_a:7:2",
      "cm_contract_a:7:3",
      "cm_contract_a:7:4",
    ]);
  });

  it("attempt numbering increments from the prior attempt count", () => {
    // Scheduler: priors=0 → attempt 1 (the scheduled charge).
    expect(nextAttemptNumber(0)).toBe(1);
    // Dunning retries: priors=1 → attempt 2, and so on up the ladder.
    expect(nextAttemptNumber(1)).toBe(2);
    expect(nextAttemptNumber(3)).toBe(4);

    // Re-running the builder for the same (contract, cycle) after each new
    // attempt yields a fresh, never-before-seen key.
    const seen = new Set<string>();
    let priors = 0;
    for (let i = 0; i < 5; i++) {
      const key = buildIdempotencyKey("cm_contract_a", 3, nextAttemptNumber(priors));
      expect(seen.has(key), `key ${key} reused`).toBe(false);
      seen.add(key);
      priors += 1;
    }
  });

  it("keys never collide across contracts, cycles and attempts", () => {
    const keys = new Set<string>();
    let total = 0;
    for (const contractId of ["cm_a", "cm_b", "cm_c"]) {
      for (let cycle = 0; cycle <= 5; cycle++) {
        for (let attempt = 1; attempt <= 4; attempt++) {
          keys.add(buildIdempotencyKey(contractId, cycle, attempt));
          total += 1;
        }
      }
    }
    expect(keys.size).toBe(total);
  });

  it("is deterministic — a crash-and-rerun rebuilds the identical key", () => {
    // This is the crash-safety property: the same (contract, cycle, attempt)
    // must map to the same key so Shopify can dedupe a re-fired create call.
    expect(buildIdempotencyKey("cm_a", 2, 1)).toBe(buildIdempotencyKey("cm_a", 2, 1));
  });
});

describe("source contract pinning", () => {
  const TEMPLATE = "`${contract.id}:${cycleIndex}:${attemptNumber}`";

  function sourceOf(relPath: string): string {
    return readFileSync(
      fileURLToPath(new URL(`../${relPath}`, import.meta.url)),
      "utf8",
    );
  }

  it("the billing scheduler builds keys with the mirrored format", () => {
    const src = sourceOf("app/lib/billing/scheduler.server.ts");
    expect(
      src.includes(TEMPLATE),
      `scheduler.server.ts no longer contains ${TEMPLATE} — update tests/helpers/idempotency.ts to match the new contract`,
    ).toBe(true);
  });

  it("the dunning engine builds retry keys with the mirrored format", () => {
    const src = sourceOf("app/lib/dunning/engine.server.ts");
    expect(
      src.includes(TEMPLATE),
      `engine.server.ts no longer contains ${TEMPLATE} — update tests/helpers/idempotency.ts to match the new contract`,
    ).toBe(true);
  });
});
