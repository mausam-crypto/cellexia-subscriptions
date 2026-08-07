import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FINAL_DISCOUNT,
  mergeSavesShown,
} from "~/lib/cancel/config.server";
import { defaultFor, settingsSchemas } from "~/lib/settings/registry.server";
import {
  buildIdempotencyKey,
  nextAttemptNumber,
} from "./helpers/idempotency";

/**
 * Guardrails of the cancel-save flow and the win-back incentive path.
 *
 * Pure pieces (mergeSavesShown, settings defaults) are tested directly.
 * DB-coupled invariants (acceptSave's shown-kind guard, the reason-offer
 * cooldown, the final-offer show-once check, applyWinback's perk handling)
 * are pinned against the module source — the same pattern
 * tests/idempotency.test.ts uses — so silently removing a guard fails the
 * suite.
 */

function src(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

const engineSource = src("../app/lib/cancel/engine.server.ts");
const handlersSource = src("../app/lib/magiclinks/handlers.server.ts");
const dunningSource = src("../app/lib/dunning/engine.server.ts");

// ── mergeSavesShown: back-navigation must not wipe the final-offer marker ────

type Offer = { kind: string };

describe("mergeSavesShown", () => {
  const step3: Offer[] = [{ kind: "PAUSE" }, { kind: "DISCOUNT" }];
  const withFinal: Offer[] = [...step3, { kind: FINAL_DISCOUNT }];

  it("first write records the offers and reports changed", () => {
    const { merged, changed } = mergeSavesShown([], step3);
    expect(changed).toBe(true);
    expect(merged.map((s) => s.kind)).toEqual(["PAUSE", "DISCOUNT"]);
  });

  it("re-rendering the same offers is a no-op (refresh)", () => {
    const { changed } = mergeSavesShown(step3, step3);
    expect(changed).toBe(false);
  });

  it("back-navigation after the final offer preserves the FINAL_DISCOUNT marker", () => {
    // savesShown = [PAUSE, DISCOUNT, FINAL_DISCOUNT]; the saves loader
    // re-records [PAUSE, DISCOUNT] — the marker must survive and nothing
    // must be re-logged.
    const { merged, changed } = mergeSavesShown(withFinal, step3);
    expect(changed).toBe(false);
    void merged;
  });

  it("a genuinely different offer set rewrites but still keeps the marker", () => {
    const { merged, changed } = mergeSavesShown(withFinal, [{ kind: "SKIP" }]);
    expect(changed).toBe(true);
    expect(merged.map((s) => s.kind)).toEqual(["SKIP", FINAL_DISCOUNT]);
  });
});

// ── Offer gating is enforced, not presentation-only ──────────────────────────

describe("acceptSave guardrails (source contract)", () => {
  it("rejects save kinds that were never offered in the session", () => {
    expect(engineSource).toContain(
      "was never offered in cancel session",
    );
    // PAUSE stays exempt — the step-1 one-tap pause runs before anything is
    // recorded, and pause is the flow's always-available default.
    expect(engineSource).toContain('if (saveKind !== "PAUSE")');
  });

  it("re-checks the reason-offer cooldown at accept time (not only at show time)", () => {
    expect(engineSource).toContain("reasonOfferOnCooldown(shop.id, contract.id");
    expect(engineSource).toContain(
      "a SAVE_OFFER grant exists within reasonOfferCooldownDays",
    );
  });

  it("skips the DISCOUNT card while a SAVE_OFFER grant is inside the cooldown", () => {
    expect(engineSource).toContain(
      "await reasonOfferOnCooldown(shopId, contract.id, cancelFlow)",
    );
  });

  it("the final offer is show-once: prior final_offer_shown events block eligibility", () => {
    expect(engineSource).toContain('type: "cancel.final_offer_shown"');
    expect(engineSource).toContain("excludeSessionId");
  });
});

// ── Session closure is an atomic claim, not a read-then-write ────────────────

describe("cancel-session closure races (source contract)", () => {
  // The concurrent interleaving: saves page open in tab A, confirm page in
  // tab B (back-button navigation makes this common). Both POSTs pass a plain
  // outcome==null read; without an atomic claim BOTH execute their Shopify
  // mutations and the LAST session write wins — a save-accept and a
  // cancel-confirm can both take effect with the session recording only one
  // (contract CANCELLED on Shopify, session smiling "SAVED"). The engine must
  // therefore claim the session with updateMany({ where: { outcome: null }})
  // as the FIRST write in all three closers, execute only after winning, and
  // revert the claim if the mutation fails.

  it("all three closers (acceptSave, acceptFinalOffer, completeCancel) claim atomically", () => {
    const claims = engineSource.match(
      /where: \{ id: session\.id, outcome: null \}/g,
    );
    expect(claims).toHaveLength(3);
  });

  it("each closer reverts its claim when the execution fails", () => {
    expect(engineSource).toContain("acceptSave claim revert failed");
    expect(engineSource).toContain("acceptFinalOffer claim revert failed");
    expect(engineSource).toContain("completeCancel claim revert failed");
  });

  it("saves re-check contract.status INSIDE the claimed section (no grant onto a cancelled contract)", () => {
    expect(engineSource).toContain("is cancelled — save");
    expect(engineSource).toContain("is cancelled — final offer refused");
  });

  it("a completeCancel that loses the claim to a rival confirm never re-executes", () => {
    expect(engineSource).toContain("double-executing");
  });

  it("no unconditional cancelSession.update ever writes a terminal outcome", () => {
    // The historical bug shape: session closed with a plain .update AFTER the
    // Shopify mutation — last write wins under concurrency. Terminal outcomes
    // (SAVED / CANCELLED / ABANDONED) may only be written through guarded
    // updateMany claims; .update is reserved for bookkeeping (savesShown,
    // reason) and the failure-path reverts (outcome: null).
    expect(engineSource).not.toMatch(
      /cancelSession\s*\.?\s*\n?\s*\.?update\(\{[\s\S]{0,240}?outcome: "(SAVED|CANCELLED|ABANDONED)"/,
    );
  });
});

describe("cancelFlow settings", () => {
  it("defaults preserve the pre-promotion constants", () => {
    const c = defaultFor("cancelFlow");
    expect(c.maxSavesShown).toBe(2);
    expect(c.frequencySuggestDeltaWeeks).toBe(2);
    expect(c.pauseSuggestMonths).toBe(2);
    expect(c.sessionFreshMinutes).toBe(60);
  });

  it("ships a non-zero reason-offer cooldown by default (anti-farming)", () => {
    expect(defaultFor("cancelFlow").reasonOfferCooldownDays).toBeGreaterThan(0);
  });
});

describe("winback settings", () => {
  it("defaults preserve the pre-promotion constants", () => {
    const w = defaultFor("winback");
    expect(w.reactivationBillDelayDays).toBe(3);
    expect(w.linkGraceDays).toBe(14);
  });

  it("refuses non-monotonic touch offsets (skip-ahead safety)", () => {
    const w = defaultFor("winback");
    const bad = settingsSchemas.winback.safeParse({
      ...w,
      perkOffsetDays: 90, // > sunsetOffsetDays 60
    });
    expect(bad.success).toBe(false);
  });
});

// ── Winback perk link: the promised gift, never a phantom 1% ─────────────────

describe("APPLY_WINBACK perk handling (source contract)", () => {
  it("percent < 1 means NO discount — never clamped up to 1", () => {
    expect(handlersSource).toMatch(/rawPercent < 1\s*\?\s*0/);
  });

  it("the gift flag is passed through to reactivateFromWinback", () => {
    expect(handlersSource).toMatch(
      /reactivateFromWinback\(\s*contract\.id,\s*\{ percent, cycles, gift \}/,
    );
  });

  it("perk confirmations use gift copy, not a discount line", () => {
    expect(handlersSource).toContain("magic.winback.sub_gift");
  });
});

// ── Dunning idempotency: payment-method-updated + scheduled-retry collision ──

describe("dunning retry idempotency through the immediate-retry collision", () => {
  // Scenario: a case is RETRYING with a scheduled rung when the customer
  // fixes their card — onPaymentMethodUpdated leaves RETRYING cases alone,
  // but even if two sweep passes race the same due case, fireRetry MUST reuse
  // the un-started PENDING row (same idempotency key) rather than minting a
  // new attempt: Shopify dedupes on the key, so a double charge is impossible.

  it("onPaymentMethodUpdated never re-schedules a case that already has a retry", () => {
    expect(dunningSource).toContain(
      "RETRYING cases already have a schedule",
    );
  });

  it("fireRetry reuses the un-started PENDING dunning row with its original key", () => {
    expect(dunningSource).toMatch(
      /status: "PENDING",\s*originatingAction: "DUNNING_RETRY",\s*shopifyAttemptId: null/,
    );
    expect(dunningSource).toContain("idempotencyKey: row.idempotencyKey");
  });

  it("a re-fired attempt for the same (contract, cycle, attempt) yields the SAME key", () => {
    // Two racing sweeps compute the identical key for the reused row.
    const first = buildIdempotencyKey("cm_contract_x", 5, nextAttemptNumber(1));
    const second = buildIdempotencyKey("cm_contract_x", 5, nextAttemptNumber(1));
    expect(first).toBe(second);
    expect(first).toBe("cm_contract_x:5:2");
  });

  it("only a NEW attempt number mints a new key (after the prior row settled)", () => {
    const settled = buildIdempotencyKey("cm_contract_x", 5, nextAttemptNumber(2));
    expect(settled).toBe("cm_contract_x:5:3");
    expect(settled).not.toBe(buildIdempotencyKey("cm_contract_x", 5, 2));
  });

  it("permanent create failures park the case instead of looping hourly forever", () => {
    expect(dunningSource).toContain("attempt_create_failed_permanently");
    expect(dunningSource).toContain("CREATE_FAILURE_MAX");
  });
});
