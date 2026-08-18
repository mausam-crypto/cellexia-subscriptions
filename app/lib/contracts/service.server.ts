import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  addDaysTz,
  addIntervalTz,
  addWeeksTz,
  shopDayStartUtc,
} from "~/lib/dates.server";
import {
  chargeMomentUtcSync,
  isPreparingOrder,
  resolveChargeTiming,
} from "~/lib/billing/timing.server";
import {
  FREQUENCY_COUNT_LIMITS,
  type Frequency,
  approxWeeks,
  contractFrequency,
  sameFrequency,
} from "~/lib/frequency";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { releaseHeldCycleAttempts } from "~/lib/billing/release.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import { isBillableOwnership } from "~/lib/ownership/shared";
import {
  followingFromDelayEvent,
  loadNewestDelayEvent,
} from "~/lib/billing/following-date.server";
import {
  ShopifyUserError,
  contractActivate,
  contractCancel,
  contractPause,
  draftLineAdd,
  draftLineRemove,
  draftLineUpdate,
  draftLines,
  draftUpdateAddress,
  draftUpdateBillingPolicy,
  draftUpdateDeliveryPolicy,
  draftUpdateNote,
  draftUpdatePaymentMethod,
  getBillingCycleByDate,
  getContractNoteAndAttributes,
  getVariants,
  listCustomerPaymentMethods,
  scheduleEditBillingCycle,
  setNextBillingDate as shopifySetNextBillingDate,
  skipBillingCycle,
  unskipBillingCycle,
  withBillingCycleEdit,
  withContractDraft as withContractDraftRaw,
  type DeliveryAddressInput,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import { applyDiscountPct } from "~/lib/money";
import { matchDraftLine } from "./draft-lines";
import {
  eventIdentity,
  fetchNextBillingDate,
  loadContractContext,
  ongoingDiscountedPriceCents,
  ongoingDiscountPctForProduct,
  reloadContract,
  resolveActor,
  resolveSource,
  swapPriceCentsSync,
  withMirrorGuard,
  type ContractContext,
  type LocalContractWithLines,
  type ServiceOptions,
} from "./shared.server";

/**
 * Contract services — the domain layer everything else (portal, magic links,
 * admin UI, cancel flow, billing, webhooks, jobs) calls.
 *
 * Every function: `(shopDomain, contractLocalId, ...args, options?)` — loads
 * the local mirror + admin client, performs the Shopify mutation(s) through
 * the graphql layer, updates the mirror, logs a canonical event with the
 * caller's `{ source, actor }` (default SYSTEM), and returns the updated
 * local contract with lines. Functions are idempotent where the operation
 * allows it (calling twice is safe and does not double-log).
 */

// ── v1.28.0 Stage D seams (contracts, NOT yet implemented — see the plan) ────
//
// The Stage D verbs below are specified here so every implementer builds on
// the same primitives, mirror columns (migration 0028) and lock-window
// classification. Each follows the module shape above:
// `(shopDomain, contractLocalId, ...args, options?) → LocalContractWithLines`,
// Shopify first, mirror inside `withMirrorGuard`, one canonical `logEvent`,
// idempotent re-calls. The lock window (app/lib/contracts/lock.server.ts) is
// enforced by the CUSTOMER routes / cancel engine that call these — never in
// here — but each seam states which side of it it lands on so no route
// forgets: "REDUCING" verbs go through the same `resolveLockState` guard
// (lock.server.ts) as skip / delay / frequency; "ADDITION / RECOVERY" verbs
// are never blocked.
//
// Per-cycle line edits share ONE mechanism with the one-time add-on
// (`addOneTimeAddon` / `removeLine` below): resolve the UPCOMING Shopify
// cycle by date (`getBillingCycleByDate(admin, gid, nextBillingDate)`), open
// a billing-cycle contract draft on that exact index
// (`withBillingCycleEdit(admin, gid, { index }, ops)` →
// subscriptionBillingCycleContractEdit → subscriptionDraftLine{Add,Update,
// Remove} → subscriptionDraftCommit), and mirror the cycle index locally so
// the estimate (`estimateNextCharge` → `nextCycleIndex`) and every reminder /
// portal card reflect it without an admin call. The contract line itself is
// never rewritten by a per-cycle edit.
//
// ── skipLineThisCycle(shopDomain, contractLocalId, lineLocalId, options?) ──
//   Per-line "not this time" (P2.5). RECURRING, non-gift lines only (an
//   add-on is removed with `removeLine`; a gift line is the engine's).
//   • Guard: cannot empty the cycle — if every other billable line of the
//     upcoming cycle is already skipped, refuse (throw a typed error the
//     route maps to portal.skip_line.last_line) and point the customer at
//     the whole-cycle `skipNextCycle` instead. Shopify rejects an empty
//     draft anyway; the guard keeps the error local and copy-able.
//   • Shopify: withBillingCycleEdit({ index: cycle.cycleIndex }) →
//     draftLineRemove(run, draftId, line.shopifyLineId).
//   • Mirror: ContractLine.skippedCycleIndex = cycle.cycleIndex (the
//     addonCycleIndex analogue — the RESOLVED index, never ordersCount+1).
//     Idempotent: already equal → reload, no event.
//   • Event: `cycle.line_skipped` { lineId, variantId, title, cycleIndex,
//     quantity, undoToken? } — the undo path is `unskipLineThisCycle`
//     (draftLineAdd of the same variant/qty/price on the same index, null
//     the mirror flag; ADDITION / RECOVERY, never locked).
//   • Invalidation: whole-cycle skip, delay / re-anchor / setNextBillingDate,
//     resync and settlement (`consumeCycleOnSuccess`) call
//     `clearStaleCycleOverrides(contractId, currentIndex)` so a flag never
//     outlives its cycle. Estimate + reminders already honour the flag.
//   • Lock window: REDUCING (customer schedule reduction) — same guard as
//     skipNextCycle. ADMIN / SYSTEM callers are never blocked.
//
// ── setLineQuantityThisCycle(shopDomain, contractLocalId, lineLocalId,
//                             quantity, options?) ──
//   One-cycle quantity tweak ("just 1 this time" — P2.5, also the
//   TOO_MUCH_PRODUCT save). RECURRING, non-gift lines; quantity ≥ 1 (0 is
//   `skipLineThisCycle`); quantity === plan quantity clears the override.
//   • Shopify: withBillingCycleEdit({ index }) → draftLineUpdate(run,
//     draftId, line.shopifyLineId, { quantity }).
//   • Mirror: ContractLine.cycleQuantityOverride = quantity,
//     cycleQuantityOverrideIndex = cycle.cycleIndex; ContractLine.quantity
//     (the plan quantity) is untouched. Idempotent on equal values.
//   • Event: `cycle.line_quantity_overridden` { lineId, variantId, title,
//     cycleIndex, from: plan quantity, to: quantity }.
//   • Invalidation: as skipLineThisCycle (`clearStaleCycleOverrides`).
//   • Lock window: DECREASE below the plan quantity is REDUCING (guarded
//     like changeLineQuantity's decrease path); an INCREASE for one cycle is
//     an ADDITION and never blocked. Undo (restoring the plan quantity) is a
//     RECOVERY.
//
// ── pauseUntil / extendPause / sendNextOrderTomorrow / setDeliveryInstructions
//   IMPLEMENTED (v1.28.0 P2.6 / P2.7 / P2.8) — see the "Pause / resume",
//   "Send next order tomorrow" and "Delivery instructions" sections below.
//   Lock-window classification for the routes that wire them:
//   • pauseUntil, extendPause: REDUCING — same `resolveLockState` guard as
//     `pauseContract` (the "pause" action). resumeContract / the RESUME magic
//     verb are RECOVERIES, never blocked.
//   • sendNextOrderTomorrow: an ACCELERATION (bills earlier) — never blocked;
//     the service itself refuses PREPARING / open dunning / not ACTIVE.
//   • setDeliveryInstructions: a delivery-detail edit — never blocked.
//   Events: `contract.paused` { until: true, resumeAt, reason, months },
//   `contract.pause_extended` { from, to, days }, `contract.resumed` gains
//   { billOn } (the honoured hold end, null for "resume now"),
//   `contract.next_date_changed` { reason: "send_tomorrow" } + `cycle.rushed`
//   { from, to }, `contract.delivery_instructions_updated` { length, cleared }.
//
// Not seams (already exist): whole-cycle skip / unskip (`skipNextCycle` /
// `unskipNextCycle`), delay (`delayNextCycle` / `delaySchedule` /
// `revertDelayedCycle`), `pauseContract(months)` / `resumeContract`,
// `setNextBillingDate`, `changeLineQuantity` (permanent), `addOneTimeAddon`.

// ── Internal helpers ─────────────────────────────────────────────────────────

function requireNextBillingDate(ctx: ContractContext): Date {
  const date = ctx.contract.nextBillingDate;
  if (!date) {
    throw new Error(
      `Contract ${ctx.contract.id} has no nextBillingDate — cannot resolve its next billing cycle`,
    );
  }
  return date;
}

async function requireVariant(
  ctx: ContractContext,
  variantId: string,
): Promise<ShopifyVariant> {
  const [variant] = await getVariants(ctx.admin, [variantId]);
  if (!variant) {
    throw new Error(`Product variant not found on Shopify: ${variantId}`);
  }
  return variant;
}

// ── Contract-level edits vs. staged billing-cycle edits ─────────────────────
//
// Shopify (billing-cycles guide, "Limitations"): "If the contract has a
// current or future billing cycle with committed edits, then you can't
// update the source subscription contract until you delete all of the
// edits." Per-line "not this time" / "just this order", one-time add-ons,
// staged gifts and pre-charge DiscountGrant application are all such cycle
// edits. The only way to lift them is subscriptionBillingCycleEditsDelete,
// which ALSO drops the cycle's schedule edits (skips, delays) — far too
// destructive to run blind before every address / frequency / product save.
// The chosen contract (v1.28.0 review fix) is therefore the typed refusal:
// when Shopify rejects a source-contract draft (userError) AND the mirror
// shows staged cycle edits, the failure is surfaced as
// `ContractEditBlockedError("CYCLE_EDITS_PENDING")` so the portal / cancel
// flow can say "finish or undo your one-off changes first" instead of a
// generic error. Nothing changes on success (Shopify accepted ⇒ the edit
// went through exactly as before). Any other user error passes through.

export type ContractEditBlockedCode = "CYCLE_EDITS_PENDING";

export class ContractEditBlockedError extends Error {
  code: ContractEditBlockedCode;
  constructor(code: ContractEditBlockedCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ContractEditBlockedError";
    this.code = code;
  }
}

/**
 * Mirror lines that witness a committed billing-cycle edit on a current or
 * future cycle: per-line skip / quantity flags, a staged one-time add-on, a
 * staged gift (cycle-scoped line, no contract line GID). Pure; exported for
 * the routes' pre-checks and tests.
 */
export function hasPendingCycleEdits(
  lines: ReadonlyArray<{
    isGift: boolean;
    isOneTimeAddon: boolean;
    shopifyLineId: string | null;
    addonCycleIndex: number | null;
    skippedCycleIndex: number | null;
    cycleQuantityOverrideIndex: number | null;
  }>,
): boolean {
  return lines.some(
    (l) =>
      l.skippedCycleIndex != null ||
      l.cycleQuantityOverrideIndex != null ||
      (l.isOneTimeAddon && l.addonCycleIndex != null) ||
      (l.isGift && !l.shopifyLineId),
  );
}

/**
 * `withContractDraft` for the contracts service: identical on success; on a
 * Shopify userError it consults the mirror (error path only — no extra read
 * on the happy path) and rethrows as ContractEditBlockedError when staged
 * cycle edits explain the refusal. Every contract-level verb in this module
 * (frequency, swap, quantity, add / remove line, address, payment method,
 * delivery instructions) goes through here.
 */
async function withContractDraft(
  admin: Parameters<typeof withContractDraftRaw>[0],
  contractGid: string,
  ops: Parameters<typeof withContractDraftRaw>[2],
): Promise<{ contractId: string }> {
  try {
    return await withContractDraftRaw(admin, contractGid, ops);
  } catch (err) {
    if (!(err instanceof ShopifyUserError)) throw err;
    let pending = false;
    try {
      const lines = await prisma.contractLine.findMany({
        where: { contract: { shopifyContractId: contractGid } },
        select: {
          isGift: true,
          isOneTimeAddon: true,
          shopifyLineId: true,
          addonCycleIndex: true,
          skippedCycleIndex: true,
          cycleQuantityOverrideIndex: true,
        },
      });
      pending = hasPendingCycleEdits(lines);
    } catch (probeErr) {
      console.error(
        "[contracts] pending cycle-edit probe failed after Shopify refusal",
        contractGid,
        probeErr,
      );
    }
    if (!pending) throw err;
    throw new ContractEditBlockedError(
      "CYCLE_EDITS_PENDING",
      `Shopify refused the contract edit while billing-cycle edits are staged on ${contractGid}: ${err.message}`,
      err,
    );
  }
}

// ── Skip / unskip ────────────────────────────────────────────────────────────

/**
 * Who triggered a skip. CUSTOMER (the default — every portal/magic-link
 * caller keeps today's behavior without changes) counts toward the
 * customer's own skip behavior: skipCount and lastSkippedAt feed the
 * risk/win-back models as disengagement signals. ADMIN and STOCKOUT are
 * merchant operations — a mass stockout skip must not make a loyal
 * subscriber look disengaged — so they count in merchantSkipCount instead
 * (migration 0016) and never stamp lastSkippedAt.
 */
export type SkipInitiator = "CUSTOMER" | "ADMIN" | "STOCKOUT";

export interface SkipCycleOptions extends ServiceOptions {
  initiator?: SkipInitiator;
  /** Why the initiator skipped ("stockout_tool", "SKIP_NOTIFY", …) — carried
   * verbatim into the cycle.skipped payload. */
  reason?: string;
}

/**
 * Skip the next billing cycle (per-cycle — the contract cadence is untouched).
 * Idempotent: a second call while the cycle is already skipped is a no-op.
 * One-time add-ons staged on the skipped cycle are removed first (Shopify
 * line + mirror + claim key) — a skipped cycle never settles, so nothing
 * else would ever clear them.
 */
export async function skipNextCycle(
  shopDomain: string,
  contractLocalId: string,
  options?: SkipCycleOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }
  if (cycle.skipped) return reloadContract(contract.id); // already skipped

  // ── Clear one-time add-ons staged on the cycle being skipped ───────────────
  // A skipped cycle never settles, and consumeCycleOnSuccess clears add-on
  // mirrors only when THEIR cycle settles (exact addonCycleIndex match) — so
  // without this, an add-on riding the skipped cycle survived forever: the
  // portal kept promising it "with your next order" while no future order
  // contained it, and its permanently-unique addClaimKey turned every later
  // re-add of the same variant into a silent "already staged" no-op.
  //
  // Removed BEFORE the Shopify skip commits, Shopify line first and mirror
  // second: the cycle edit would otherwise still hold the line if the cycle
  // were later unskipped (an invisible charge with nothing to remove in the
  // portal), and a non-user error at any point aborts the whole skip while
  // everything is still consistent — the customer retries and the loop
  // re-runs idempotently (a line already gone on Shopify is tolerated, the
  // mirror delete matches zero rows). Legacy mirrors with NULL
  // addonCycleIndex are left alone on purpose: their staged cycle is
  // unknowable locally, and consumeCycleOnSuccess's OR-null clause clears
  // them on the NEXT settlement anyway — they cannot strand.
  const stagedAddons = contract.lines.filter(
    (l) => l.isOneTimeAddon && l.addonCycleIndex === cycle.cycleIndex,
  );
  for (const line of stagedAddons) {
    if (line.shopifyLineId) {
      const shopifyLineId = line.shopifyLineId;
      try {
        await withBillingCycleEdit(
          admin,
          contract.shopifyContractId,
          { index: cycle.cycleIndex },
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      } catch (err) {
        // Nothing has been skipped yet — an infrastructure error is fully
        // retryable, so it must abort rather than half-clean.
        if (!(err instanceof ShopifyUserError)) throw err;
        // Line already gone on Shopify (or removed by a concurrent edit):
        // the mirror is what diverged — log and continue so it catches up.
        console.error(
          "[contracts] skipNextCycle: Shopify rejected add-on line removal, treating as already removed",
          contract.id,
          shopifyLineId,
          err.message,
        );
      }
    }
    // deleteMany, not delete: a concurrent portal removal racing this skip
    // must not turn the cleanup into a P2025 crash mid-flight.
    await withMirrorGuard("skipNextCycle", ctx, options, () =>
      prisma.contractLine.deleteMany({ where: { id: line.id } }),
    );
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "cycle.addon_removed",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        lineId: line.id,
        variantId: line.variantId,
        title: line.title,
        isGift: line.isGift,
        isOneTimeAddon: true,
        cycleIndex: cycle.cycleIndex,
        reason: "cycle_skipped",
      },
    });
  }

  // ── Per-line cycle edits on the cycle being skipped (v1.28.0, P2.5) ────────
  // A "not this time" / "just this order" edit targets THIS cycle; once the
  // whole cycle is skipped it is moot, and its mirror flag is cleared below
  // (clearStaleCycleOverrides) so the estimate never carries it onto the
  // following order. The Shopify cycle edit is restored FIRST — a later
  // unskip would otherwise re-expose a cycle missing a line (or at a tweaked
  // quantity) with no mirror flag left to explain it. Same tolerance as the
  // add-on cleanup: a user error means the draft no longer holds what we
  // expect (mirror catches up); an infrastructure error aborts the skip
  // while nothing has moved yet.
  const perCycleEdited = contract.lines.filter(
    (l) =>
      !l.isGift &&
      !l.isOneTimeAddon &&
      l.shopifyLineId &&
      (l.skippedCycleIndex === cycle.cycleIndex ||
        l.cycleQuantityOverrideIndex === cycle.cycleIndex),
  );
  if (perCycleEdited.length > 0) {
    try {
      await withBillingCycleEdit(
        admin,
        contract.shopifyContractId,
        { index: cycle.cycleIndex },
        async (draftId, run) => {
          for (const line of perCycleEdited) {
            const target = await resolveDraftLineFor(run, draftId, contract, {
              id: line.id,
              shopifyLineId: line.shopifyLineId as string,
              variantId: line.variantId,
            });
            if (line.skippedCycleIndex === cycle.cycleIndex) {
              if (target) continue; // already back on the cycle
              await draftLineAdd(run, draftId, {
                productVariantId: line.variantId,
                quantity: line.quantity,
                currentPriceCents: await reAddPriceCents(contract, cycle.cycleIndex, line),
              });
            } else if (target && target.quantity !== line.quantity) {
              await draftLineUpdate(run, draftId, target.id, {
                quantity: line.quantity,
              });
            }
          }
        },
      );
    } catch (err) {
      if (!(err instanceof ShopifyUserError)) throw err;
      console.error(
        "[contracts] skipNextCycle: Shopify rejected restoring per-line cycle edits, continuing",
        contract.id,
        err.message,
      );
    }
  }

  await skipBillingCycle(admin, contract.shopifyContractId, {
    index: cycle.cycleIndex,
  });

  // Recompute the next billing date: prefer Shopify's own view; if it has not
  // advanced past the skipped cycle, add one interval in the shop timezone.
  let newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    null,
  );
  if (!newNext || newNext.getTime() <= nextBillingDate.getTime()) {
    const freq = contractFrequency(contract);
    newNext = addIntervalTz(
      nextBillingDate,
      freq.unit,
      freq.count,
      shop.ianaTimezone,
    );
  }

  const initiator: SkipInitiator = options?.initiator ?? "CUSTOMER";
  await withMirrorGuard("skipNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        nextBillingDate: newNext,
        // CUSTOMER skips are behavior signals; merchant-driven skips count
        // in their own column so a bulk stockout op can never contaminate
        // the customer's disengagement profile (see SkipInitiator).
        ...(initiator === "CUSTOMER"
          ? { skipCount: { increment: 1 }, lastSkippedAt: new Date() }
          : { merchantSkipCount: { increment: 1 } }),
      },
    }),
  );

  // The skipped cycle is behind us: per-line edits staged on it (or on any
  // earlier cycle) must not carry over to the following order.
  await invalidateStaleCycleOverrides(contract, cycle.cycleIndex + 1);

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.skipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      // Always present, so stream analytics can split customer skips from
      // merchant skips without joining against the mirror columns.
      initiator,
      reason: options?.reason ?? null,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: newNext.toISOString(),
    },
  });

  // Dunning reconciliation (v1.28.0): if the skipped cycle is the one an
  // open case is retrying, the case closes (nothing left to collect) instead
  // of firing into BILLING_CYCLE_SKIPPED refusals, emailing "still holding
  // your order" and exhausting the contract to FAILED. Contained; dynamic
  // import keeps the contracts → dunning edge lazy (see changePaymentMethod).
  try {
    const engine = await import("~/lib/dunning/engine.server");
    await engine.onCycleSkipped(
      contract.id,
      cycle.cycleIndex,
      resolveSource(options),
    );
  } catch (err) {
    console.error(
      "[contracts] dunning.onCycleSkipped failed after skip",
      contract.id,
      err,
    );
  }

  return reloadContract(contract.id);
}

/**
 * Un-skip the most recently skipped upcoming cycle. Idempotent: when no
 * skipped cycle can be found, returns the contract unchanged.
 */
export async function unskipNextCycle(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  const tz = shop.ianaTimezone;

  // After a skip, the skipped cycle sits one interval before the (advanced)
  // nextBillingDate. Probe there first, then at the current date.
  const unskipFreq = contractFrequency(contract);
  const previousDate = addIntervalTz(
    nextBillingDate,
    unskipFreq.unit,
    unskipFreq.count,
    tz,
    -1,
  );
  let cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    previousDate,
  );
  if (!cycle?.skipped) {
    cycle = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      nextBillingDate,
    );
  }
  if (!cycle?.skipped) return reloadContract(contract.id); // nothing to unskip

  // ── Per-line cycle edits staged AFTER the cycle being un-skipped ───────────
  // (v1.28.0 review fix) While cycle N was skipped, "not this time" / "just
  // this order" landed on cycle N+1 (the then-upcoming order). Un-skipping N
  // makes N the upcoming cycle again, but the estimate's cycle hint is a
  // max() over every staged flag index — a surviving N+1 flag would lift it
  // to N+1 and present cycle N as missing the line / at the lower total
  // while Shopify bills N in full. Same contract as skipNextCycle: restore
  // the Shopify cycle edits on their own cycles FIRST (nothing has moved
  // yet — an infrastructure error aborts, a user error means the draft no
  // longer holds what we expect and the mirror catches up), then null the
  // flags once the mirror is updated below.
  const laterFlagged = contract.lines.filter(
    (l) =>
      !l.isGift &&
      !l.isOneTimeAddon &&
      l.shopifyLineId &&
      ((l.skippedCycleIndex != null && l.skippedCycleIndex > cycle.cycleIndex) ||
        (l.cycleQuantityOverrideIndex != null &&
          l.cycleQuantityOverrideIndex > cycle.cycleIndex)),
  );
  const laterIndexes = [
    ...new Set(
      laterFlagged.flatMap((l) =>
        [l.skippedCycleIndex, l.cycleQuantityOverrideIndex].filter(
          (i): i is number => i != null && i > cycle.cycleIndex,
        ),
      ),
    ),
  ];
  for (const laterIndex of laterIndexes) {
    const onCycle = laterFlagged.filter(
      (l) =>
        l.skippedCycleIndex === laterIndex ||
        l.cycleQuantityOverrideIndex === laterIndex,
    );
    try {
      await withBillingCycleEdit(
        admin,
        contract.shopifyContractId,
        { index: laterIndex },
        async (draftId, run) => {
          for (const line of onCycle) {
            const target = await resolveDraftLineFor(run, draftId, contract, {
              id: line.id,
              shopifyLineId: line.shopifyLineId as string,
              variantId: line.variantId,
            });
            if (line.skippedCycleIndex === laterIndex) {
              if (target) continue; // already back on the cycle
              await draftLineAdd(run, draftId, {
                productVariantId: line.variantId,
                quantity: line.quantity,
                currentPriceCents: await reAddPriceCents(contract, laterIndex, line),
              });
            } else if (target && target.quantity !== line.quantity) {
              await draftLineUpdate(run, draftId, target.id, {
                quantity: line.quantity,
              });
            }
          }
        },
      );
    } catch (err) {
      if (!(err instanceof ShopifyUserError)) throw err;
      console.error(
        "[contracts] unskipNextCycle: Shopify rejected restoring later-cycle per-line edits, continuing",
        contract.id,
        laterIndex,
        err.message,
      );
    }
  }

  await unskipBillingCycle(admin, contract.shopifyContractId, {
    index: cycle.cycleIndex,
  });

  let newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    null,
  );
  if (!newNext || newNext.getTime() >= nextBillingDate.getTime()) {
    newNext = cycle.billingAttemptExpectedDate ?? previousDate;
  }

  // Which counter does this unskip reverse? cycle.skipped events always
  // carry { initiator }: merchant-driven skips (ADMIN/STOCKOUT) counted in
  // merchantSkipCount, customer skips in skipCount — so the reversal must
  // decrement the SAME column. Decrementing skipCount unconditionally let an
  // admin skip+unskip pair erase a genuine customer-disengagement signal
  // while the merchant counter stayed overstated — wrong inputs to the
  // risk/win-back models on both columns. Prefer the skip staged on this
  // exact cycle; fall back to the most recent skip, then to CUSTOMER
  // (pre-initiator history holds only customer skips). Floored at zero like
  // the original.
  const recentSkips = await prisma.subscriberEvent.findMany({
    where: { contractId: contract.id, type: "cycle.skipped" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { payload: true },
  });
  const skipPayload = (e: { payload: unknown }) =>
    (e.payload ?? {}) as { cycleIndex?: unknown; initiator?: unknown };
  const reversedSkip =
    recentSkips.find((e) => skipPayload(e).cycleIndex === cycle.cycleIndex) ??
    recentSkips[0] ??
    null;
  const reversedInitiator =
    reversedSkip && typeof skipPayload(reversedSkip).initiator === "string"
      ? (skipPayload(reversedSkip).initiator as string)
      : "CUSTOMER";
  const reversesMerchantSkip =
    reversedInitiator === "ADMIN" || reversedInitiator === "STOCKOUT";

  await withMirrorGuard("unskipNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        nextBillingDate: newNext,
        ...(reversesMerchantSkip
          ? {
              merchantSkipCount: Math.max(
                0,
                (contract.merchantSkipCount ?? 0) - 1,
              ),
            }
          : { skipCount: Math.max(0, contract.skipCount - 1) }),
      },
    }),
  );

  // Null the later-cycle flags restored above (mirror follows Shopify) and
  // leave a trail per line — the estimate must stop carrying them now that
  // cycle N is the upcoming order again.
  if (laterFlagged.length > 0) {
    // Snapshot the flags before the mirror write (the rows may be shared
    // references with the loaded contract).
    const trail = laterFlagged.map((line) => ({
      line,
      wasSkip: line.skippedCycleIndex != null,
      skippedCycleIndex: line.skippedCycleIndex,
      overrideIndex: line.cycleQuantityOverrideIndex,
      override: line.cycleQuantityOverride,
    }));
    await withMirrorGuard("unskipNextCycle", ctx, options, () =>
      prisma.contractLine.updateMany({
        where: { id: { in: laterFlagged.map((l) => l.id) } },
        data: {
          skippedCycleIndex: null,
          cycleQuantityOverride: null,
          cycleQuantityOverrideIndex: null,
        },
      }),
    );
    for (const { line, wasSkip, skippedCycleIndex, overrideIndex, override } of trail) {
      await logEvent({
        ...eventIdentity(shop, contract),
        type: wasSkip ? "cycle.line_unskipped" : "cycle.line_quantity_set",
        source: resolveSource(options),
        actor: resolveActor(options),
        payload: {
          lineId: line.id,
          variantId: line.variantId,
          title: line.title,
          cycleIndex: wasSkip ? skippedCycleIndex : overrideIndex,
          quantity: line.quantity,
          ...(wasSkip
            ? {}
            : {
                qty: line.quantity,
                from: override,
                planQuantity: line.quantity,
                cleared: true,
              }),
          reason: "cycle_unskipped",
        },
      });
    }
  }

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.unskipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      // The initiator of the skip this unskip reversed — stream analytics
      // can pair skip/unskip without joining the mirror columns.
      reversedInitiator,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: newNext.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

// ── Delay ────────────────────────────────────────────────────────────────────

export interface DelayInput {
  weeks?: number;
  days?: number;
}

/**
 * Push the next billing cycle out by N weeks or days (schedule edit — the
 * contract cadence is untouched; later cycles keep their rhythm).
 */
export async function delayNextCycle(
  shopDomain: string,
  contractLocalId: string,
  delta: DelayInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const weeks = delta.weeks ?? 0;
  const days = delta.days ?? 0;
  if (weeks <= 0 && days <= 0) {
    throw new Error("delayNextCycle requires a positive weeks or days delta");
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  const tz = shop.ianaTimezone;

  let newDate = nextBillingDate;
  if (weeks > 0) newDate = addWeeksTz(newDate, weeks, tz);
  if (days > 0) newDate = addDaysTz(newDate, days, tz);

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }

  const edited = await scheduleEditBillingCycle(
    admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    { billingDate: newDate },
  );
  const effectiveDate = edited?.billingAttemptExpectedDate ?? newDate;

  await withMirrorGuard("delayNextCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effectiveDate },
    }),
  );

  // The order after the delayed one keeps the ORIGINAL rhythm (a one-cycle
  // schedule edit never moves the anchor): anchor + one interval. When the
  // cycle was ALREADY once-delayed (a second "just this once"), the anchor is
  // the one that first delay recorded — never the delayed date + interval
  // (review fix; resolveFollowingBillingDate reads it before the mirror moves).
  const freq = contractFrequency(contract);
  const followingBillingDate =
    followingFromDelayEvent(
      await loadNewestDelayEvent(contract.id),
      nextBillingDate,
    ) ?? addIntervalTz(nextBillingDate, freq.unit, freq.count, tz);

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.delayed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      // v1.28.0 (P2.2): "once" = this order only, later orders keep their
      // rhythm; delaySchedule logs the same event with mode "reanchor".
      // followingBillingDate is what the customer is told comes after —
      // both dates are needed for truthful confirmation copy and Undo.
      mode: "once",
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: effectiveDate.toISOString(),
      followingBillingDate: followingBillingDate.toISOString(),
      ...(weeks > 0 ? { weeks } : {}),
      ...(days > 0 ? { days } : {}),
    },
  });

  // Dunning reconciliation (v1.28.0): a delay of the cycle an open case is
  // retrying moves the case's next retry to the new expected date — Shopify
  // refuses attempts more than 24h before it (BILLING_CYCLE_CHARGE_BEFORE_
  // EXPECTED_DATE), and a "delay" that still retried on the old rung would
  // contradict the customer's request. Contained; lazy import as above.
  try {
    const engine = await import("~/lib/dunning/engine.server");
    await engine.onCycleDelayed(
      contract.id,
      cycle.cycleIndex,
      effectiveDate,
      resolveSource(options),
    );
  } catch (err) {
    console.error(
      "[contracts] dunning.onCycleDelayed failed after delay",
      contract.id,
      err,
    );
  }

  return reloadContract(contract.id);
}

/**
 * Delay the WHOLE schedule by N weeks/days (v1.28.0, P2.2 — the
 * portal.delayReanchors=true semantics): the next order moves out AND becomes
 * the anchor every later order follows ("Next order {date}, then every
 * {frequency} from there"). Implemented as subscriptionContractSetNextBillingDate
 * — the same re-anchoring mutation the portal's next-date picker uses — but
 * logged as cycle.delayed (mode "reanchor") so the delay confirmation email,
 * Klaviyo "Order Delayed" metric and Undo all keep working for both modes.
 * followingBillingDate = new next + one interval (the truthful "then").
 */
export async function delaySchedule(
  shopDomain: string,
  contractLocalId: string,
  delta: DelayInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const weeks = delta.weeks ?? 0;
  const days = delta.days ?? 0;
  if (weeks <= 0 && days <= 0) {
    throw new Error("delaySchedule requires a positive weeks or days delta");
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  const tz = shop.ianaTimezone;

  let newDate = nextBillingDate;
  if (weeks > 0) newDate = addWeeksTz(newDate, weeks, tz);
  if (days > 0) newDate = addDaysTz(newDate, days, tz);

  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    newDate,
  );
  const effectiveDate = result.nextBillingDate ?? newDate;

  await withMirrorGuard("delaySchedule", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effectiveDate },
    }),
  );

  // Per-line cycle edits (P2.5): the re-anchor may re-index the upcoming
  // cycle — reconcile the flags against the cycle now at the new date.
  await reconcileCycleOverridesAfterMove(ctx, effectiveDate);

  const freq = contractFrequency(contract);
  const followingBillingDate = addIntervalTz(
    effectiveDate,
    freq.unit,
    freq.count,
    tz,
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.delayed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      mode: "reanchor",
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: effectiveDate.toISOString(),
      followingBillingDate: followingBillingDate.toISOString(),
      ...(weeks > 0 ? { weeks } : {}),
      ...(days > 0 ? { days } : {}),
    },
  });

  // Dunning reconciliation, as delayNextCycle: an open case retrying the
  // moved cycle follows the new expected date. The cycle index is resolved
  // best-effort (the anchor moved, so it is read AFTER the mutation);
  // contained — a failed lookup never breaks the delay.
  try {
    const cycle = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      effectiveDate,
    );
    if (cycle) {
      const engine = await import("~/lib/dunning/engine.server");
      await engine.onCycleDelayed(
        contract.id,
        cycle.cycleIndex,
        effectiveDate,
        resolveSource(options),
      );
    }
  } catch (err) {
    console.error(
      "[contracts] dunning.onCycleDelayed failed after delaySchedule",
      contract.id,
      err,
    );
  }

  return reloadContract(contract.id);
}

/**
 * Reverse a one-cycle delay (Undo, v1.28.0): the cycle currently at the
 * contract's next billing date is schedule-edited back to `toDate` — the
 * exact inverse of delayNextCycle (a re-anchoring set-next-date would move
 * later orders too, which the original delay never did). Idempotent when
 * the mirror already sits at `toDate`. Logs cycle.delay_reverted.
 */
export async function revertDelayedCycle(
  shopDomain: string,
  contractLocalId: string,
  toDate: Date,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);
  if (nextBillingDate.getTime() === toDate.getTime()) {
    return reloadContract(contract.id);
  }

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }
  const edited = await scheduleEditBillingCycle(
    admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    { billingDate: toDate },
  );
  const effectiveDate = edited?.billingAttemptExpectedDate ?? toDate;

  await withMirrorGuard("revertDelayedCycle", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effectiveDate },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.delay_reverted",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      cycleIndex: cycle.cycleIndex,
      previousNextBillingDate: nextBillingDate.toISOString(),
      nextBillingDate: effectiveDate.toISOString(),
    },
  });

  try {
    const engine = await import("~/lib/dunning/engine.server");
    await engine.onCycleDelayed(
      contract.id,
      cycle.cycleIndex,
      effectiveDate,
      resolveSource(options),
    );
  } catch (err) {
    console.error(
      "[contracts] dunning.onCycleDelayed failed after revertDelayedCycle",
      contract.id,
      err,
    );
  }

  return reloadContract(contract.id);
}

// ── Frequency ────────────────────────────────────────────────────────────────

/**
 * Change the billing + delivery cadence. Accepts a multi-unit `Frequency`
 * ({unit, count}) or a bare week count (the pre-v1.8.0 form, still used by
 * week-denominated flows like the cancel save-offer).
 */
export async function changeFrequency(
  shopDomain: string,
  contractLocalId: string,
  frequency: Frequency | number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const freq: Frequency =
    typeof frequency === "number"
      ? { unit: "WEEK", count: frequency }
      : frequency;
  if (!Number.isInteger(freq.count) || freq.count < 1) {
    throw new Error(`Invalid frequency: ${freq.count} ${freq.unit}`);
  }
  const limits = FREQUENCY_COUNT_LIMITS[freq.unit];
  // WEEK keeps its historical wider service-layer ceiling (52 — imported and
  // legacy contracts land anywhere in it); other units follow the plan limits.
  const max = freq.unit === "WEEK" ? 52 : limits?.max;
  if (!limits || freq.count > max) {
    throw new Error(`Invalid frequency: ${freq.count} ${freq.unit}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (sameFrequency(contractFrequency(contract), freq)) {
    return reloadContract(contract.id);
  }

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdateBillingPolicy(run, draftId, {
        interval: freq.unit,
        intervalCount: freq.count,
      });
      await draftUpdateDeliveryPolicy(run, draftId, {
        interval: freq.unit,
        intervalCount: freq.count,
      });
    },
  );

  const newNext = await fetchNextBillingDate(
    admin,
    contract.shopifyContractId,
    contract.nextBillingDate,
  );

  await withMirrorGuard("changeFrequency", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        intervalWeeks: approxWeeks(freq.unit, freq.count),
        billingIntervalUnit: freq.unit,
        billingIntervalCount: freq.count,
        nextBillingDate: newNext,
      },
    }),
  );

  // Per-line cycle edits (P2.5): a cadence change re-computes the upcoming
  // cycle — reconcile the flags against the cycle now at the new date.
  await reconcileCycleOverridesAfterMove(ctx, newNext);

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.frequency_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      // Week approximations stay first for Klaviyo flows built on them.
      oldWeeks: contract.intervalWeeks,
      newWeeks: approxWeeks(freq.unit, freq.count),
      oldUnit: contract.billingIntervalUnit ?? "WEEK",
      oldCount: contract.billingIntervalCount ?? contract.intervalWeeks,
      newUnit: freq.unit,
      newCount: freq.count,
      // v1.28.0 (Undo): the next-date pair the change moved between, so an
      // undo can restore the exact previous schedule, not just the cadence.
      previousNextBillingDate: contract.nextBillingDate
        ? contract.nextBillingDate.toISOString()
        : null,
      nextBillingDate: newNext ? newNext.toISOString() : null,
    },
  });

  return reloadContract(contract.id);
}

// ── Line operations ──────────────────────────────────────────────────────────

/**
 * THE swap-pricing rule (v1.28.0 — one helper, every surface). The unit price
 * a line takes when it is swapped to `variant`:
 *   - grandfathered contract + same product, same or smaller size (catalog
 *     price ≤ the line's original catalog price): min(locked price, repriced)
 *     — the lock shields against catalog rises, never buys a bigger size at
 *     the small-size price (a dearer variant is repriced like any swap);
 *   - otherwise SellingPlanConfig.ongoingDiscountPct off the variant's
 *     catalog price, falling back to the line's proportional discount ratio.
 * `swapLineVariant` applies exactly this; every preview of a swap price (the
 * portal items card, the cancel-flow SWAP and DOWNSIZE cards) must call it too,
 * so the price a customer is shown equals the price the swap applies.
 */
export async function swapPriceCentsFor(
  shopId: string,
  contract: { grandfatheredPricing: boolean },
  line: Pick<
    LocalContractWithLines["lines"][number],
    "productId" | "currentPriceCents" | "compareAtPriceCents"
  >,
  variant: Pick<ShopifyVariant, "productId" | "priceCents">,
): Promise<number> {
  // Pure rule lives in shared.server (swapPriceCentsSync) so the portal's
  // items-card dropdown can price options without the async config read.
  const pct = await ongoingDiscountPctForProduct(shopId, variant.productId);
  return swapPriceCentsSync(contract, line, variant, pct);
}

/**
 * Swap one line to a different variant, honoring the contract's ongoing
 * discount: grandfathered contracts keep the old line price when swapping
 * within the same product (size change); otherwise the new variant is priced
 * at SellingPlanConfig.ongoingDiscountPct off its catalog price (fallback:
 * the old line's proportional discount ratio). Pricing = `swapPriceCentsFor`.
 */
export async function swapLineVariant(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  newVariantId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.variantId === newVariantId) return reloadContract(contract.id);

  const variant = await requireVariant(ctx, newVariantId);

  const sameProduct =
    variant.productId != null && variant.productId === line.productId;
  const newPriceCents = await swapPriceCentsFor(
    shop.id,
    contract,
    line,
    variant,
  );

  const existingShopifyLineId = line.shopifyLineId;
  let newShopifyLineId: string | null = existingShopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      if (existingShopifyLineId) {
        try {
          await draftLineUpdate(run, draftId, existingShopifyLineId, {
            productVariantId: newVariantId,
            quantity: line.quantity,
            currentPriceCents: newPriceCents,
          });
          return;
        } catch (err) {
          // Cross-product swaps can be rejected as in-place updates; fall back
          // to remove + add within the same atomic draft.
          if (!(err instanceof ShopifyUserError)) throw err;
          await draftLineRemove(run, draftId, existingShopifyLineId);
        }
      }
      newShopifyLineId = await draftLineAdd(run, draftId, {
        productVariantId: newVariantId,
        quantity: line.quantity,
        currentPriceCents: newPriceCents,
      });
    },
  );

  await withMirrorGuard("swapLineVariant", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: {
        shopifyLineId: newShopifyLineId,
        productId: variant.productId ?? line.productId,
        variantId: newVariantId,
        title: variant.productTitle || line.title,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        currentPriceCents: newPriceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        addedVia: "SWAP",
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_swapped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      oldVariantId: line.variantId,
      newVariantId,
      oldTitle: line.title,
      newTitle: variant.productTitle,
      oldPriceCents: line.currentPriceCents,
      newPriceCents,
      grandfathered: contract.grandfatheredPricing && sameProduct,
    },
  });

  return reloadContract(contract.id);
}

/** Change one line's quantity. Idempotent for an unchanged quantity. */
export async function changeLineQuantity(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  quantity: number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.quantity === quantity) return reloadContract(contract.id);
  if (!line.shopifyLineId) {
    throw new Error(
      `Contract line ${line.id} has no Shopify line id — resync the contract before editing it`,
    );
  }

  const shopifyLineId = line.shopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftLineUpdate(run, draftId, shopifyLineId, { quantity });
    },
  );

  await withMirrorGuard("changeLineQuantity", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: { quantity },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.quantity_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      oldQuantity: line.quantity,
      newQuantity: quantity,
    },
  });

  return reloadContract(contract.id);
}

/**
 * Directly override one line's recurring unit price (admin support tool —
 * "edit anything"). Contract-level edit: the new price applies to every
 * future cycle until changed again or overwritten by a price-change batch.
 * Idempotent for an unchanged price.
 */
export async function setLinePrice(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  newPriceCents: number,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(newPriceCents) || newPriceCents < 0) {
    throw new Error(`Invalid line price: ${newPriceCents} cents`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new Error(
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.currentPriceCents === newPriceCents) {
    return reloadContract(contract.id); // already at the requested price
  }
  if (line.isOneTimeAddon) {
    throw new Error(
      "One-time add-ons live on the next billing cycle, not the contract — remove and re-add the add-on instead of repricing it",
    );
  }
  if (!line.shopifyLineId) {
    throw new Error(
      `Contract line ${line.id} has no Shopify line id — resync the contract before editing it`,
    );
  }

  const shopifyLineId = line.shopifyLineId;
  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftLineUpdate(run, draftId, shopifyLineId, {
        currentPriceCents: newPriceCents,
      });
    },
  );

  await withMirrorGuard("setLinePrice", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: { currentPriceCents: newPriceCents },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_price_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      oldPriceCents: line.currentPriceCents,
      newPriceCents,
    },
  });

  return reloadContract(contract.id);
}

export interface AddLineOpts {
  isGift?: boolean;
  /** CHECKOUT | PORTAL | MAGIC_LINK | ADMIN | GIFT_ENGINE | SWAP */
  addedVia?: string;
}

/**
 * Add a recurring line: gifts at price 0, everything else at the ongoing
 * subscription discount. Idempotent: an existing line with the same variant,
 * gift flag and quantity is treated as this call already applied.
 *
 * Concurrency (non-gift adds — the portal/admin paths): same claim-first
 * shape as addOneTimeAddon under addClaimKey "line:{contractId}:{variantId}"
 * — the mirror row is created BEFORE the multi-second Shopify draft, and a
 * concurrent duplicate loses on P2002 and no-ops instead of appending the
 * same variant to the contract twice. Gift-engine lines never claim: gifts
 * are managed per grant with their own idempotency, and a gift of a variant
 * the customer also buys must never block or be blocked by the paid line.
 */
export async function addLine(
  shopDomain: string,
  contractLocalId: string,
  variantId: string,
  quantity: number,
  opts?: AddLineOpts,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const isGift = opts?.isGift ?? false;
  const addedVia = opts?.addedVia ?? "PORTAL";

  // Fast path only — for non-gift adds the race-proof guard is addClaimKey.
  const existing = contract.lines.find(
    (l) =>
      l.variantId === variantId &&
      l.isGift === isGift &&
      !l.isOneTimeAddon &&
      l.quantity === quantity,
  );
  if (existing) return reloadContract(contract.id); // already applied

  const variant = await requireVariant(ctx, variantId);
  const priceCents = isGift
    ? 0
    : await ongoingDiscountedPriceCents(shop.id, variant);

  // ── Atomic claim: mirror row FIRST, Shopify draft second ───────────────────
  let created: { id: string };
  try {
    created = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyLineId: null, // stamped after the draft commits
        productId: variant.productId ?? "",
        variantId,
        title: variant.productTitle,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        quantity,
        currentPriceCents: priceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        isGift,
        isOneTimeAddon: false,
        addedVia,
        ...(isGift ? {} : { addClaimKey: `line:${contract.id}:${variantId}` }),
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost the race: a concurrent request already added this variant.
      return reloadContract(contract.id);
    }
    throw err;
  }

  let shopifyLineId: string | null = null;
  try {
    await withContractDraft(
      admin,
      contract.shopifyContractId,
      async (draftId, run) => {
        shopifyLineId = await draftLineAdd(run, draftId, {
          productVariantId: variantId,
          quantity,
          currentPriceCents: priceCents,
        });
      },
    );
  } catch (err) {
    await prisma.contractLine
      .delete({ where: { id: created.id } })
      .catch((cleanupErr) => {
        console.error(
          "[contracts] addLine: failed to release the add claim after a failed draft",
          created.id,
          cleanupErr,
        );
      });
    throw err;
  }

  await withMirrorGuard("addLine", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: created.id },
      data: { shopifyLineId },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.line_added",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: created.id,
      variantId,
      title: variant.productTitle,
      quantity,
      priceCents,
      isGift,
      addedVia,
    },
  });

  return reloadContract(contract.id);
}

/**
 * Remove a line. Recurring lines come off the contract; one-time-addon lines
 * come off the upcoming billing cycle (where they actually live). Idempotent:
 * a missing local line is treated as already removed.
 */
export async function removeLine(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) return reloadContract(contract.id); // already removed

  if (line.shopifyLineId) {
    const shopifyLineId = line.shopifyLineId;
    try {
      if (line.isOneTimeAddon) {
        // Addons live on ONE billing cycle, not on the contract. The staged
        // cycle index recorded at add time (migration 0012) is authoritative
        // — Shopify cycle indexes are stable, while a date-resolved "next"
        // cycle can drift past the add-on (skips, resyncs). Legacy rows
        // without it fall back to resolving the upcoming cycle by date.
        let targetCycleIndex = line.addonCycleIndex;
        if (targetCycleIndex == null) {
          const nextBillingDate = requireNextBillingDate(ctx);
          const cycle = await getBillingCycleByDate(
            admin,
            contract.shopifyContractId,
            nextBillingDate,
          );
          if (!cycle) {
            throw new Error(
              `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
            );
          }
          targetCycleIndex = cycle.cycleIndex;
        }
        await withBillingCycleEdit(
          admin,
          contract.shopifyContractId,
          { index: targetCycleIndex },
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      } else {
        await withContractDraft(
          admin,
          contract.shopifyContractId,
          async (draftId, run) => {
            await draftLineRemove(run, draftId, shopifyLineId);
          },
        );
      }
    } catch (err) {
      if (!(err instanceof ShopifyUserError)) throw err;
      // Line already gone on Shopify (or removed by a concurrent edit): the
      // mirror is what diverged — log and continue so it catches up.
      console.error(
        "[contracts] removeLine: Shopify rejected line removal, treating as already removed",
        contract.id,
        shopifyLineId,
        err.message,
      );
    }
  }

  await withMirrorGuard("removeLine", ctx, options, () =>
    prisma.contractLine.delete({ where: { id: line.id } }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: line.isOneTimeAddon ? "cycle.addon_removed" : "contract.line_removed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      isGift: line.isGift,
      isOneTimeAddon: line.isOneTimeAddon,
    },
  });

  return reloadContract(contract.id);
}

// ── One-time add-on ──────────────────────────────────────────────────────────

export interface AddOneTimeAddonOpts {
  /** PORTAL | MAGIC_LINK | ADMIN — how the add-on was attached. */
  addedVia?: string;
}

/**
 * Attach a one-time add-on to the NEXT billing cycle only (billing-cycle
 * contract edit — the contract itself is untouched). The mirror line is
 * flagged `isOneTimeAddon` for portal display; the billing-success webhook
 * handler clears those mirrors after the cycle ships.
 *
 * Concurrency: the duplicate guard is the DATABASE, not a read. The mirror
 * line is created FIRST under the unique addClaimKey
 * "addon:{contractId}:{variantId}" (migration 0009) and only then does the
 * multi-second Shopify cycle edit run — deleted again if that edit fails.
 * The portal has no client-side button disabling, so a double-tap used to
 * send two overlapping requests that both passed the old find-then-act
 * check, both appended the variant to the next cycle, and the customer paid
 * for the add-on twice. Now the second request loses on P2002 and returns
 * the already-staged no-op.
 */
export async function addOneTimeAddon(
  shopDomain: string,
  contractLocalId: string,
  variantId: string,
  quantity: number,
  opts?: AddOneTimeAddonOpts,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const nextBillingDate = requireNextBillingDate(ctx);

  // Fast path only — the race-proof guard is the addClaimKey unique below.
  const existing = contract.lines.find(
    (l) => l.variantId === variantId && l.isOneTimeAddon,
  );
  if (existing) return reloadContract(contract.id); // addon already staged

  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${contract.id}`,
    );
  }

  const variant = await requireVariant(ctx, variantId);
  const priceCents = await ongoingDiscountedPriceCents(shop.id, variant);

  // ── Atomic claim: mirror row FIRST, Shopify edit second ────────────────────
  let created: { id: string };
  try {
    created = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyLineId: null, // stamped after the cycle edit commits
        productId: variant.productId ?? "",
        variantId,
        title: variant.productTitle,
        variantTitle: variant.title || null,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        quantity,
        currentPriceCents: priceCents,
        compareAtPriceCents: variant.priceCents,
        unitCostCents: variant.unitCostCents,
        isGift: false,
        isOneTimeAddon: true,
        // The cycle this add-on rides on. consumeCycleOnSuccess clears the
        // mirror only when THIS cycle settles — an earlier cycle's settlement
        // (racing through the in-flight window) must not delete it, or the
        // freed addClaimKey lets the variant be staged and charged twice.
        addonCycleIndex: cycle.cycleIndex,
        addedVia: opts?.addedVia ?? "PORTAL",
        addClaimKey: `addon:${contract.id}:${variantId}`,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost the race: a concurrent request (double-tap, second tab) already
      // staged this add-on — same no-op as the fast path above.
      return reloadContract(contract.id);
    }
    throw err;
  }

  let shopifyLineId: string | null = null;
  try {
    await withBillingCycleEdit(
      admin,
      contract.shopifyContractId,
      { index: cycle.cycleIndex },
      async (draftId, run) => {
        shopifyLineId = await draftLineAdd(run, draftId, {
          productVariantId: variantId,
          quantity,
          currentPriceCents: priceCents,
        });
      },
    );
  } catch (err) {
    // The claim is only real once Shopify holds the line: release it so a
    // retry can stage the add-on cleanly instead of finding a ghost mirror.
    await prisma.contractLine
      .delete({ where: { id: created.id } })
      .catch((cleanupErr) => {
        console.error(
          "[contracts] addOneTimeAddon: failed to release the add claim after a failed cycle edit",
          created.id,
          cleanupErr,
        );
      });
    throw err;
  }

  await withMirrorGuard("addOneTimeAddon", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: created.id },
      data: { shopifyLineId },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.addon_added",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: created.id,
      cycleIndex: cycle.cycleIndex,
      variantId,
      title: variant.productTitle,
      quantity,
      priceCents,
    },
  });

  return reloadContract(contract.id);
}

// ── Per-cycle line edits (v1.28.0, P2.5) ─────────────────────────────────────

export type CycleLineEditErrorCode =
  | "LINE_NOT_FOUND" // no such line on this contract
  | "NOT_RECURRING" // gift / one-time add-on (removeLine owns add-ons)
  | "NO_SHOPIFY_LINE" // mirror line without a Shopify id — resync first
  | "LAST_LINE" // skipping it would empty the cycle → whole-order skip
  | "SKIPPED_THIS_CYCLE" // quantity tweak on a line already "not this time"
  | "INVALID_QUANTITY";

/**
 * Typed refusal for the per-cycle line verbs so the portal / cancel flow can
 * map it to copy (portal.toast.skip_line_last_line …) instead of a generic
 * error. Every code is a customer-caused, retry-safe state; nothing was
 * mutated on Shopify or the mirror when one is thrown.
 */
export class CycleLineEditError extends Error {
  code: CycleLineEditErrorCode;
  constructor(code: CycleLineEditErrorCode, message: string) {
    super(message);
    this.name = "CycleLineEditError";
    this.code = code;
  }
}

/** Skip / override flags exist on the mirror (cheap pre-check for callers). */
function hasCycleOverrides(lines: LocalContractWithLines["lines"]): boolean {
  return lines.some(
    (l) => l.skippedCycleIndex != null || l.cycleQuantityOverrideIndex != null,
  );
}

/**
 * Null every per-line flag whose cycle is BELOW `upcomingIndex` (contained;
 * a lazy import keeps contracts → billing/estimate one-directional at module
 * load). Called by the schedule movers below (whole-cycle skip, re-anchor,
 * next-date change, frequency change) — settlement clears its own inside
 * consumeCycleOnSuccess's transaction.
 */
async function invalidateStaleCycleOverrides(
  contract: LocalContractWithLines,
  upcomingIndex: number,
): Promise<void> {
  if (!hasCycleOverrides(contract.lines)) return;
  try {
    const { clearStaleCycleOverrides } = await import(
      "~/lib/billing/estimate.server"
    );
    await clearStaleCycleOverrides(contract.id, upcomingIndex);
  } catch (err) {
    console.error(
      "[contracts] clearStaleCycleOverrides failed",
      contract.id,
      upcomingIndex,
      err,
    );
  }
}

/**
 * After a schedule move whose Shopify cycle re-indexing is not knowable
 * locally (set-next-date / re-anchor / frequency change): resolve the cycle
 * now sitting at `effectiveDate` and null every flag below it. When the
 * lookup fails the flags cannot be trusted any more — they are cleared
 * outright (the Shopify cycle edit, if it survived on its cycle, was for
 * that cycle; the mirror must never claim "not this time" for an order it
 * cannot place). Contained: never breaks the schedule change.
 */
async function reconcileCycleOverridesAfterMove(
  ctx: ContractContext,
  effectiveDate: Date | null,
): Promise<void> {
  const { contract, admin } = ctx;
  if (!hasCycleOverrides(contract.lines)) return;
  try {
    const cycle = effectiveDate
      ? await getBillingCycleByDate(
          admin,
          contract.shopifyContractId,
          effectiveDate,
        )
      : null;
    if (cycle) {
      await invalidateStaleCycleOverrides(contract, cycle.cycleIndex);
      return;
    }
  } catch (err) {
    console.error(
      "[contracts] cycle lookup after schedule move failed — clearing per-line cycle edits",
      contract.id,
      err,
    );
  }
  try {
    await prisma.contractLine.updateMany({
      where: {
        contractId: contract.id,
        OR: [
          { skippedCycleIndex: { not: null } },
          { cycleQuantityOverrideIndex: { not: null } },
        ],
      },
      data: {
        skippedCycleIndex: null,
        cycleQuantityOverride: null,
        cycleQuantityOverrideIndex: null,
      },
    });
  } catch (err) {
    console.error(
      "[contracts] clearing per-line cycle edits after schedule move failed",
      contract.id,
      err,
    );
  }
}

/** Resolve the UPCOMING Shopify cycle by the mirror's next billing date. */
async function requireUpcomingCycle(ctx: ContractContext) {
  const nextBillingDate = requireNextBillingDate(ctx);
  const cycle = await getBillingCycleByDate(
    ctx.admin,
    ctx.contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle found at ${nextBillingDate.toISOString()} for contract ${ctx.contract.id}`,
    );
  }
  return cycle;
}

/** The recurring (non-gift, non-add-on) line or a typed refusal. */
function requireRecurringLine(
  contract: LocalContractWithLines,
  lineLocalId: string,
): LocalContractWithLines["lines"][number] & { shopifyLineId: string } {
  const line = contract.lines.find((l) => l.id === lineLocalId);
  if (!line) {
    throw new CycleLineEditError(
      "LINE_NOT_FOUND",
      `Contract line ${lineLocalId} not found on contract ${contract.id}`,
    );
  }
  if (line.isGift || line.isOneTimeAddon) {
    throw new CycleLineEditError(
      "NOT_RECURRING",
      `Contract line ${line.id} is not a recurring line`,
    );
  }
  if (!line.shopifyLineId) {
    throw new CycleLineEditError(
      "NO_SHOPIFY_LINE",
      `Contract line ${line.id} has no Shopify line id — resync the contract before editing it`,
    );
  }
  return line as typeof line & { shopifyLineId: string };
}

/**
 * The draft line a per-cycle edit acts on. Prefer the contract line's own
 * id (what a fresh cycle draft carries); after an unskip the cycle holds a
 * RE-ADDED copy under a cycle-scoped id, so fall back to the draft line with
 * the same variant that is not another mirrored line's id. Null when the
 * line is not on the draft at all (already skipped by an earlier edit).
 */
async function resolveDraftLineFor(
  run: Parameters<typeof draftLines>[0],
  draftId: string,
  contract: LocalContractWithLines,
  line: { id: string; shopifyLineId: string; variantId: string },
): Promise<{ id: string; quantity: number } | null> {
  const lines = await draftLines(run, draftId);
  // Shared with applyGrantToCycle (billing/discounts.server.ts) — one
  // resolver, one notion of "which draft line is this mirrored line".
  return matchDraftLine(lines, contract.lines, line);
}

/**
 * The unit price a line RE-ADDED to `cycleIndex` must carry (v1.28.0 review
 * fix). Normally the plan price — DiscountGrant application happens at
 * pre-charge and lands on whatever the draft holds then. But while dunning
 * owns the cycle (attempt FAILED / CHALLENGED and a `cycle_discount_applied`
 * marker for THIS index), the retry bills the cycle's already-discounted
 * prices and the portal shows that total: a re-add at plan price would bill
 * one line above the promise. Contained — any read failure ⇒ plan price.
 */
async function reAddPriceCents(
  contract: LocalContractWithLines,
  cycleIndex: number,
  line: { currentPriceCents: number },
): Promise<number> {
  try {
    const { loadParkedCycleDiscount } = await import("~/lib/billing/estimate.server");
    const parked = await loadParkedCycleDiscount(contract.id);
    if (parked && parked.cycleIndex === cycleIndex && parked.percent > 0) {
      return applyDiscountPct(line.currentPriceCents, parked.percent);
    }
  } catch (err) {
    console.error("[contracts] parked-cycle discount read failed — re-adding at plan price", contract.id, err);
  }
  return line.currentPriceCents;
}

/**
 * Per-line "not this time" — remove ONE recurring line from the UPCOMING
 * billing cycle only (billing-cycle contract edit; the contract line is
 * untouched and rides every later cycle). Mirror: skippedCycleIndex = the
 * resolved cycle index — the estimate, the reminder and every portal card
 * read it. Refuses (typed) to empty the cycle: the customer is pointed at
 * the whole-order skip instead. Idempotent: already skipped for this cycle
 * ⇒ reload, no event. Lock window: REDUCING — the CUSTOMER routes guard it.
 */
export async function skipLineThisCycle(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;
  const line = requireRecurringLine(contract, lineLocalId);
  const cycle = await requireUpcomingCycle(ctx);

  if (line.skippedCycleIndex === cycle.cycleIndex) {
    return reloadContract(contract.id); // already "not this time"
  }

  // Cannot empty the cycle: every OTHER billable line already skipped for
  // this cycle ⇒ refuse (Shopify rejects an empty draft anyway; keeping the
  // refusal local makes it copy-able and leaves nothing half-edited).
  const otherBillable = contract.lines.filter(
    (l) =>
      l.id !== line.id &&
      !l.isGift &&
      (!l.isOneTimeAddon || l.addonCycleIndex == null || l.addonCycleIndex === cycle.cycleIndex) &&
      l.skippedCycleIndex !== cycle.cycleIndex,
  );
  if (otherBillable.length === 0) {
    throw new CycleLineEditError(
      "LAST_LINE",
      `Skipping line ${line.id} would empty cycle ${cycle.cycleIndex} of contract ${contract.id} — use the whole-order skip`,
    );
  }

  let removedOnShopify = false;
  await withBillingCycleEdit(
    ctx.admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    async (draftId, run) => {
      const target = await resolveDraftLineFor(run, draftId, contract, line);
      if (!target) return; // not on the cycle any more — mirror catches up
      await draftLineRemove(run, draftId, target.id);
      removedOnShopify = true;
    },
  );

  await withMirrorGuard("skipLineThisCycle", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: {
        skippedCycleIndex: cycle.cycleIndex,
        // Skip wins over a one-cycle quantity tweak on the same cycle.
        ...(line.cycleQuantityOverrideIndex === cycle.cycleIndex
          ? { cycleQuantityOverride: null, cycleQuantityOverrideIndex: null }
          : {}),
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.line_skipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      cycleIndex: cycle.cycleIndex,
      quantity: line.quantity,
      removedOnShopify,
      nextBillingDate: contract.nextBillingDate
        ? contract.nextBillingDate.toISOString()
        : null,
    },
  });

  return reloadContract(contract.id);
}

/**
 * Undo of skipLineThisCycle: put the line back on the SAME cycle (draft line
 * add of the same variant / plan quantity / plan price) and null the mirror
 * flag. ADDITION / RECOVERY — never lock-blocked. Idempotent: no flag for
 * this cycle ⇒ reload, no event.
 */
export async function unskipLineThisCycle(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;
  const line = requireRecurringLine(contract, lineLocalId);
  if (line.skippedCycleIndex == null) return reloadContract(contract.id);
  const cycle = await requireUpcomingCycle(ctx);
  if (line.skippedCycleIndex !== cycle.cycleIndex) {
    // A stale flag from an earlier cycle: nothing to restore on Shopify —
    // just drop the flag so the estimate stops carrying it.
    await withMirrorGuard("unskipLineThisCycle", ctx, options, () =>
      prisma.contractLine.update({
        where: { id: line.id },
        data: { skippedCycleIndex: null },
      }),
    );
    return reloadContract(contract.id);
  }

  let restoredOnShopify = false;
  await withBillingCycleEdit(
    ctx.admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    async (draftId, run) => {
      const existing = await resolveDraftLineFor(run, draftId, contract, line);
      if (existing) return; // already on the cycle (concurrent undo) — mirror catches up
      await draftLineAdd(run, draftId, {
        productVariantId: line.variantId,
        quantity: line.quantity,
        currentPriceCents: await reAddPriceCents(contract, cycle.cycleIndex, line),
      });
      restoredOnShopify = true;
    },
  );

  await withMirrorGuard("unskipLineThisCycle", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data: { skippedCycleIndex: null },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.line_unskipped",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      cycleIndex: cycle.cycleIndex,
      quantity: line.quantity,
      restoredOnShopify,
    },
  });

  return reloadContract(contract.id);
}

/**
 * One-cycle quantity tweak ("just this order"): the UPCOMING cycle bills
 * `quantity` units of the line, every later cycle keeps the plan quantity.
 * `quantity` = null (or = the plan quantity) clears the override — the Undo
 * path. Mirror: cycleQuantityOverride / cycleQuantityOverrideIndex; the
 * plan quantity (ContractLine.quantity) is never touched. Idempotent on an
 * equal value. Lock window: a DECREASE below plan is REDUCING (routes
 * guard it), an increase / a restore is never blocked. Event
 * `cycle.line_quantity_set` { lineId, cycleIndex, qty, from, planQuantity }.
 */
export async function setLineQuantityThisCycle(
  shopDomain: string,
  contractLocalId: string,
  lineLocalId: string,
  quantity: number | null,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (quantity != null && (!Number.isInteger(quantity) || quantity < 1)) {
    throw new CycleLineEditError(
      "INVALID_QUANTITY",
      `Invalid one-cycle quantity: ${String(quantity)} (0 is skipLineThisCycle)`,
    );
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;
  const line = requireRecurringLine(contract, lineLocalId);
  const cycle = await requireUpcomingCycle(ctx);

  if (line.skippedCycleIndex === cycle.cycleIndex) {
    throw new CycleLineEditError(
      "SKIPPED_THIS_CYCLE",
      `Contract line ${line.id} is skipped for cycle ${cycle.cycleIndex} — unskip it before changing its quantity`,
    );
  }

  const currentOverride =
    line.cycleQuantityOverrideIndex === cycle.cycleIndex
      ? line.cycleQuantityOverride
      : null;
  const from = currentOverride ?? line.quantity;
  // Plan quantity ⇒ no override; anything else ⇒ that many units this cycle.
  const target = quantity == null || quantity === line.quantity ? null : quantity;
  if (target === currentOverride) return reloadContract(contract.id);
  const billedQuantity = target ?? line.quantity;

  await withBillingCycleEdit(
    ctx.admin,
    contract.shopifyContractId,
    { index: cycle.cycleIndex },
    async (draftId, run) => {
      const draftLine = await resolveDraftLineFor(run, draftId, contract, line);
      if (!draftLine) {
        // Not on the cycle (a foreign cycle edit removed it): put it back at
        // the requested quantity rather than failing the tweak.
        await draftLineAdd(run, draftId, {
          productVariantId: line.variantId,
          quantity: billedQuantity,
          currentPriceCents: await reAddPriceCents(contract, cycle.cycleIndex, line),
        });
        return;
      }
      if (draftLine.quantity === billedQuantity) return;
      await draftLineUpdate(run, draftId, draftLine.id, {
        quantity: billedQuantity,
      });
    },
  );

  await withMirrorGuard("setLineQuantityThisCycle", ctx, options, () =>
    prisma.contractLine.update({
      where: { id: line.id },
      data:
        target == null
          ? { cycleQuantityOverride: null, cycleQuantityOverrideIndex: null }
          : {
              cycleQuantityOverride: target,
              cycleQuantityOverrideIndex: cycle.cycleIndex,
            },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.line_quantity_set",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      lineId: line.id,
      variantId: line.variantId,
      title: line.title,
      cycleIndex: cycle.cycleIndex,
      qty: billedQuantity,
      from,
      planQuantity: line.quantity,
      cleared: target == null,
    },
  });

  return reloadContract(contract.id);
}

// ── Pause / resume ───────────────────────────────────────────────────────────

export interface PauseOptions extends ServiceOptions {
  /** Why the contract paused — CUSTOMER | ADMIN | SAVE_FLOW | STOCKOUT_DELAY
   * | SYSTEM (the pause analogue of cancelReason; migration 0016). Stored on
   * SubscriptionContract.pausedReason and cleared on resume; null = "reason
   * not recorded", which is what every pre-existing caller keeps saying
   * until it opts in. */
  reason?: string;
}

/**
 * Pause for 1–N months (clamped by settings.pause.maxMonths). `resumeAt` uses
 * 30-day months for calendar honesty; the resume job re-activates then.
 */
export async function pauseContract(
  shopDomain: string,
  contractLocalId: string,
  months: number,
  options?: PauseOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "PAUSED") return reloadContract(contract.id);

  const pauseSettings = await getSetting(shop.id, "pause");
  const clampedMonths = Math.min(
    Math.max(1, Math.floor(months)),
    pauseSettings.maxMonths,
  );

  await contractPause(admin, contract.shopifyContractId);

  const now = new Date();
  const resumeAt = addDaysTz(now, clampedMonths * 30, shop.ianaTimezone);
  const reason = options?.reason ?? null;

  await withMirrorGuard("pauseContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      // pausedReason describes THIS pause episode — written fresh (null
      // included) on every pause, cleared on resume, like pausedAt.
      data: { status: "PAUSED", pausedAt: now, resumeAt, pausedReason: reason },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.paused",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: { months: clampedMonths, resumeAt: resumeAt.toISOString(), reason },
  });

  return reloadContract(contract.id);
}

/**
 * Customer-stated reason for a vacation hold (v1.28.0, P2.6). Stored on the
 * same per-episode `pausedReason` column the months-based path uses for its
 * initiator tag (ADMIN / SAVE_FLOW / …): both describe THIS pause episode
 * and are cleared on resume; retention analytics reads them as one column.
 */
export const PAUSE_UNTIL_REASONS = ["TRAVEL", "TOO_MUCH", "BUDGET", "OTHER"] as const;
export type PauseUntilReason = (typeof PAUSE_UNTIL_REASONS)[number];

export function normalizePauseUntilReason(
  value: unknown,
): PauseUntilReason | null {
  return typeof value === "string" &&
    (PAUSE_UNTIL_REASONS as readonly string[]).includes(value)
    ? (value as PauseUntilReason)
    : null;
}

/** Typed refusals for the date-based pause verbs — routes map them to copy. */
export type PauseUntilErrorCode =
  | "RESUME_DATE_PAST" // resume day must be after today (shop tz)
  | "RESUME_DATE_TOO_FAR" // beyond pause.maxMonths × 30 days from the pause start
  | "NOT_PAUSED" // extendPause on a contract that is not PAUSED
  | "NOT_LATER"; // extendPause with a date not after the current resume date

export class PauseUntilError extends Error {
  constructor(
    readonly code: PauseUntilErrorCode,
    readonly maxResumeAt?: Date,
  ) {
    super(`pauseUntil refused: ${code}`);
    this.name = "PauseUntilError";
  }
}

export interface PauseUntilOptions extends ServiceOptions {
  /** TRAVEL | TOO_MUCH | BUDGET | OTHER — anything else is recorded as null. */
  reason?: string | null;
}

/**
 * The latest resume day a pause started at `pausedAt` may carry:
 * pausedAt + pause.maxMonths × 30 days (the same 30-day month
 * `pauseContract` uses), normalised to the shop-tz day start.
 */
export async function maxPauseResumeAt(
  shopId: string,
  pausedAt: Date,
  tz: string,
): Promise<Date> {
  const pauseSettings = await getSetting(shopId, "pause");
  return shopDayStartUtc(
    addDaysTz(pausedAt, pauseSettings.maxMonths * 30, tz),
    tz,
  );
}

/**
 * Vacation hold with an explicit resume DATE (v1.28.0, P2.6) — the date-based
 * sibling of `pauseContract(months)`; both write the same PAUSED state and the
 * same `contract.paused` event stream (`until: true` marks this path).
 *
 * `resumeAt` is normalised to the shop-tz START of its calendar day: the
 * auto-resume job (reminders.server.ts) re-activates in the first hourly run
 * of that day and hands the same instant to `resumeContract({ billOn })`, so
 * the first post-hold charge lands at that day's charge moment — never the
 * old now+3d drift, never before the day the customer chose. Bounds: the day
 * must be after today and at most pause.maxMonths × 30 days out.
 *
 * Idempotent: already PAUSED with the same resume day → reload, no event.
 * Already PAUSED with a DIFFERENT day → `extendPause` (later) or
 * `resumeContract` (earlier) — this verb refuses to silently move a hold.
 * Lock window: REDUCING — the caller route guards it like `pauseContract`.
 */
export async function pauseUntil(
  shopDomain: string,
  contractLocalId: string,
  resumeAt: Date,
  options?: PauseUntilOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const tz = shop.ianaTimezone;
  const now = new Date();

  const resumeDay = shopDayStartUtc(resumeAt, tz);
  if (Number.isNaN(resumeDay.getTime())) {
    throw new PauseUntilError("RESUME_DATE_PAST");
  }

  if (contract.status === "PAUSED") {
    if (
      contract.resumeAt &&
      shopDayStartUtc(contract.resumeAt, tz).getTime() === resumeDay.getTime()
    ) {
      return reloadContract(contract.id);
    }
    // A different day on an existing hold is a move, not a pause: keep the
    // verbs honest (later → extendPause, earlier → resumeContract).
    throw new PauseUntilError("NOT_LATER");
  }

  // Strictly after today: the earliest hold resumes tomorrow (a resume day of
  // today would re-activate within the hour — that is "no pause").
  const todayStart = shopDayStartUtc(now, tz);
  if (resumeDay.getTime() <= todayStart.getTime()) {
    throw new PauseUntilError("RESUME_DATE_PAST");
  }
  const maxResume = await maxPauseResumeAt(shop.id, now, tz);
  if (resumeDay.getTime() > maxResume.getTime()) {
    throw new PauseUntilError("RESUME_DATE_TOO_FAR", maxResume);
  }

  await contractPause(admin, contract.shopifyContractId);

  const reason = normalizePauseUntilReason(options?.reason);

  await withMirrorGuard("pauseUntil", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      // Same episode columns as pauseContract; resumeAt is the customer's
      // day VERBATIM (day start), never +3d.
      data: {
        status: "PAUSED",
        pausedAt: now,
        resumeAt: resumeDay,
        pausedReason: reason,
      },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.paused",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      until: true,
      resumeAt: resumeDay.toISOString(),
      reason,
      // Kept for the analytics stream that reads `months` off every pause:
      // the whole-day count divided by 30, rounded up (a 6-week hold = 2).
      months: Math.max(
        1,
        Math.ceil((resumeDay.getTime() - now.getTime()) / (30 * 86_400_000)),
      ),
    },
  });

  return reloadContract(contract.id);
}

/**
 * Move an existing hold's resume day LATER (v1.28.0, P2.6 exit ramp; also
 * the resume-reminder one-tap EXTEND_PAUSE verb). Requires status PAUSED and
 * a current resumeAt; the new day must be after it and within
 * pause.maxMonths × 30 days of `pausedAt` (a hold cannot be extended forever
 * one tap at a time — the clamp is measured from the pause start, not from
 * now). No Shopify call (the contract is already paused); mirror resumeAt
 * only. Idempotent on the same day (reload, no event). Choosing an EARLIER
 * day is `resumeContract` territory. Event: `contract.pause_extended`
 * { from, to, weeks? }. Lock window: REDUCING (guarded by the route for
 * symmetry with pause; a no-op in practice — a hold inside the window was
 * placed by an exempt path).
 */
export async function extendPause(
  shopDomain: string,
  contractLocalId: string,
  newResumeAt: Date,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;
  const tz = shop.ianaTimezone;

  if (contract.status !== "PAUSED" || !contract.resumeAt) {
    throw new PauseUntilError("NOT_PAUSED");
  }
  const currentDay = shopDayStartUtc(contract.resumeAt, tz);
  const newDay = shopDayStartUtc(newResumeAt, tz);
  if (Number.isNaN(newDay.getTime())) throw new PauseUntilError("NOT_LATER");
  if (newDay.getTime() === currentDay.getTime()) {
    return reloadContract(contract.id);
  }
  if (newDay.getTime() < currentDay.getTime()) {
    throw new PauseUntilError("NOT_LATER");
  }
  const anchor = contract.pausedAt ?? new Date();
  const maxResume = await maxPauseResumeAt(shop.id, anchor, tz);
  if (newDay.getTime() > maxResume.getTime()) {
    throw new PauseUntilError("RESUME_DATE_TOO_FAR", maxResume);
  }

  await withMirrorGuard("extendPause", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { resumeAt: newDay },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.pause_extended",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      from: currentDay.toISOString(),
      to: newDay.toISOString(),
      days: Math.round((newDay.getTime() - currentDay.getTime()) / 86_400_000),
    },
  });

  return reloadContract(contract.id);
}

/** Margin ahead of `now` for a resume whose promised day already passed. */
const RESUME_PAST_MARGIN_MS = 15 * 60_000;

export interface ResumeOptions extends ServiceOptions {
  /**
   * Bill ON this instant instead of the "now + 3 days" quick-return rule.
   * The auto-resume job passes the pause's own `resumeAt` (v1.28.0, P2.6):
   * a hold that promised "resumes on {date}" charges at that day's charge
   * moment, not three days later. Never earlier than now — a late job run
   * (the date already passed) bills at the next sweep, never retroactively.
   */
  billOn?: Date | null;
}

/**
 * Resume a paused (or payment-FAILED — the admin "Resume" button offers both)
 * contract and bill soon (next billing date = now + 3 days, or the caller's
 * `billOn` — see ResumeOptions), so the customer who asked to come back gets
 * product quickly rather than waiting a full interval.
 *
 * FAILED resumes must also release the failed cycle: the dunning case that
 * failed the contract is closed (EXHAUSTED), and once the contract is ACTIVE
 * again onPaymentMethodUpdated can no longer reopen it (that path requires
 * status FAILED) — so without `releaseHeldCycleAttempts` the billing sweep's
 * cycle-history guard (scheduler b2) would hold the still-unbilled cycle on
 * its terminal FAILED/EXPIRED attempt forever and the "resumed" subscriber
 * would never be billed or shipped again (the same reactivated-but-never-
 * billed trap migration 0013 documents for win-back reactivation).
 */
export async function resumeContract(
  shopDomain: string,
  contractLocalId: string,
  options?: ResumeOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "ACTIVE") return reloadContract(contract.id);
  const resumedFromFailed = contract.status === "FAILED";

  await contractActivate(admin, contract.shopifyContractId);

  const now = new Date();
  const billOn =
    options?.billOn instanceof Date && !Number.isNaN(options.billOn.getTime())
      ? options.billOn
      : null;
  // billOn: the promised day itself when still ahead; a date already passed
  // (late job run — the normal auto-resume case, resumeAt being a shop-day
  // start and the job hourly) becomes "as soon as Shopify accepts": Shopify
  // validates the date against ITS clock at processing time, so a bare
  // now+60s was one slow round trip / a minute of host clock skew away from
  // a refusal that left Shopify ACTIVE with the mirror still PAUSED
  // (v1.28.0 review fix). Use today's charge moment when it is still ahead
  // (the sweep bills anything ≤ the charge moment the same day either way),
  // else now + a 15-minute margin. Same shop day ⇒ same charge day.
  let nextBillingDate: Date;
  if (!billOn) {
    nextBillingDate = addDaysTz(now, 3, shop.ianaTimezone);
  } else if (billOn.getTime() > now.getTime()) {
    nextBillingDate = billOn;
  } else {
    const soon = new Date(now.getTime() + RESUME_PAST_MARGIN_MS);
    let chargeMoment: Date | null = null;
    try {
      const timing = await resolveChargeTiming(shop.id, shop.ianaTimezone);
      chargeMoment = chargeMomentUtcSync(now, timing);
    } catch (err) {
      console.error("[contracts] resume: charge moment lookup failed", contract.id, err);
    }
    nextBillingDate =
      chargeMoment && chargeMoment.getTime() > soon.getTime()
        ? chargeMoment
        : soon;
  }
  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  const effectiveNext = result.nextBillingDate ?? nextBillingDate;

  await withMirrorGuard("resumeContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        status: "ACTIVE",
        pausedAt: null,
        resumeAt: null,
        // pausedReason travels with pausedAt: it describes the pause episode
        // that just ended, not the contract.
        pausedReason: null,
        // failedAt is LIVE-STATE (like the cancel columns — see the win-back
        // engine): a resumed subscriber is retained again. The failure stays
        // in the event log and the closed episode's attempt rows.
        ...(resumedFromFailed ? { failedAt: null } : {}),
        nextBillingDate: effectiveNext,
      },
    }),
  );

  // The resume moved the next date like every other schedule mover: per-line
  // cycle edits staged before the hold are reconciled against the cycle now
  // at the new date (flags below it are dropped; on lookup failure they are
  // cleared outright — the mirror must never claim "not this time" for an
  // order it cannot place). Contained; v1.28.0 review fix.
  await reconcileCycleOverridesAfterMove(ctx, effectiveNext);

  // After the mirror is ACTIVE: the closed failure episode's terminal
  // attempts stop being the cycle's live verdict, so the sweep can open the
  // fresh first attempt the admin was promised ("next charge in ~3 days").
  // No-op for PAUSED resumes (no terminal attempts / open case owns them).
  let releasedAttempts = 0;
  if (resumedFromFailed) {
    releasedAttempts = await releaseHeldCycleAttempts(contract.id);
  }

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.resumed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      nextBillingDate: effectiveNext.toISOString(),
      // The scheduled hold end this resume honoured (auto-resume job), or
      // null for a "resume now" — the two are different retention moments.
      billOn: billOn ? billOn.toISOString() : null,
      ...(resumedFromFailed
        ? {
            resumedFrom: "FAILED",
            // Terminal attempts of the closed episode released back to the
            // scheduler (supersededAt stamp). 0 = clean history or an open
            // dunning case still owns its cycle.
            releasedFailedAttempts: releasedAttempts,
          }
        : {}),
    },
  });

  return reloadContract(contract.id);
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Sources the ENGINE paths stamp. A fifth value, "EXTERNAL", exists on the
 * mirror column but is written only by syncContractFromShopify: a cancel
 * first observed from Shopify with no app-internal source stamped ahead of
 * it (Shopify-admin cancels, other surfaces). It is deliberately not in this
 * union — no engine caller may claim it.
 */
export type CancelSource = "CUSTOMER" | "ADMIN" | "DUNNING" | "SYSTEM";

export interface CancelOptions extends ServiceOptions {
  /** Defaults from `source`: portal/magic → CUSTOMER, ADMIN → ADMIN, else SYSTEM. */
  cancelSource?: CancelSource;
  /** Set false for internal cancels (merge) that must not trigger win-back. */
  scheduleWinback?: boolean;
}

function deriveCancelSource(options?: CancelOptions): CancelSource {
  if (options?.cancelSource) return options.cancelSource;
  switch (options?.source) {
    case "CUSTOMER_PORTAL":
    case "MAGIC_LINK":
      return "CUSTOMER";
    case "ADMIN":
      return "ADMIN";
    default:
      return "SYSTEM";
  }
}

/** Cancel the contract; schedules win-back unless disabled. Idempotent. */
export async function cancelContract(
  shopDomain: string,
  contractLocalId: string,
  reason: string,
  options?: CancelOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  if (contract.status === "CANCELLED") return reloadContract(contract.id);

  const cancelSource = deriveCancelSource(options);

  await contractCancel(admin, contract.shopifyContractId);

  await withMirrorGuard("cancelContract", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelSource,
        // A cancel — scheduled or immediate, any source — settles a pending
        // scheduled cancel (v1.28.0, P3.8): the column never outlives the
        // contract's live state, so a later reactivation starts clean.
        cancelScheduledAt: null,
      },
    }),
  );

  // ── Cancel-funnel bookkeeping for admin cancels ────────────────────────────
  // The CancelSession funnel was portal-only in practice: ADMIN was a
  // declared channel no writer ever produced, so admin-entered reasons never
  // reached the reason histogram and channel-split retention analysis had a
  // single bucket. An admin cancel not riding an open portal session records
  // a minimal completed session here (channel ADMIN, outcome CANCELLED, the
  // admin form's reason); when a session IS open, its own flow owns the
  // funnel verdict. DUNNING/SYSTEM cancels stay out on purpose — the funnel
  // measures cancel-intent conversations, not bookkeeping or dunning.
  // Contained: funnel bookkeeping must never break the cancel itself.
  let cancelSessionId: string | null = null;
  if (cancelSource === "ADMIN") {
    try {
      const openSession = await prisma.cancelSession.findFirst({
        where: { contractId: contract.id, outcome: null },
        select: { id: true },
      });
      if (!openSession) {
        const session = await prisma.cancelSession.create({
          data: {
            contractId: contract.id,
            channel: "ADMIN",
            reason,
            outcome: "CANCELLED",
            completedAt: new Date(),
          },
        });
        cancelSessionId = session.id;
      }
    } catch (err) {
      console.error(
        "[contracts] cancelContract: admin cancel-session bookkeeping failed",
        contract.id,
        err,
      );
    }
  }

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.cancelled",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      reason,
      cancelSource,
      ...(cancelSessionId ? { cancelSessionId } : {}),
    },
  });

  const updated = await reloadContract(contract.id);

  // Subscriber-tag recompute (tagging setting group): the cancel webhook echo
  // reaches the same recompute through syncContractFromShopify within
  // seconds, but "remove the tag when they cancel" is the feature's headline
  // promise — apply it in the same request. Contained: tagging never breaks
  // a cancel.
  try {
    const { maybeSyncSubscriberTag } = await import("~/lib/tagging/tags.server");
    await maybeSyncSubscriberTag(shop.id, contract.customerId, {
      contractId: contract.id,
    });
  } catch (err) {
    console.error(
      "[contracts] subscriber tag recompute failed after cancel",
      contract.id,
      err,
    );
  }

  if (options?.scheduleWinback !== false) {
    try {
      const winback = (await import("~/lib/winback/engine.server")) as {
        scheduleWinback?: (
          contract: LocalContractWithLines,
        ) => Promise<unknown>;
      };
      if (typeof winback.scheduleWinback === "function") {
        await winback.scheduleWinback(updated);
      }
    } catch (err) {
      // Win-back scheduling must never break a cancel.
      console.error(
        "[contracts] win-back scheduling failed after cancel",
        contract.id,
        err,
      );
    }
  }

  return updated;
}

// ── Address / next date / payment ────────────────────────────────────────────

/** Update the shipping address on the contract's delivery method. */
export async function updateDeliveryAddress(
  shopDomain: string,
  contractLocalId: string,
  address: DeliveryAddressInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdateAddress(run, draftId, address);
    },
  );

  // JSON round-trip drops `undefined` values (Prisma rejects them in Json).
  const addressJson = JSON.parse(JSON.stringify(address)) as object;

  await withMirrorGuard("updateDeliveryAddress", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { deliveryAddress: addressJson },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.address_updated",
    source: resolveSource(options),
    actor: resolveActor(options),
    // Minimal payload — no full address PII in the event log.
    payload: {
      city: address.city ?? null,
      zip: address.zip ?? null,
      countryCode: address.countryCode ?? null,
    },
  });

  return reloadContract(contract.id);
}

/** Move the contract's next billing date to an explicit date. */
export async function setNextBillingDate(
  shopDomain: string,
  contractLocalId: string,
  date: Date,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const previous = contract.nextBillingDate;
  if (previous && previous.getTime() === date.getTime()) {
    return reloadContract(contract.id); // already at the requested date
  }

  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    date,
  );
  const effective = result.nextBillingDate ?? date;

  await withMirrorGuard("setNextBillingDate", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effective },
    }),
  );

  // Per-line cycle edits (P2.5) targeted the cycle at the OLD date; a
  // re-anchor may re-index the upcoming cycle — reconcile (contained).
  await reconcileCycleOverridesAfterMove(ctx, effective);

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.next_date_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      previousNextBillingDate: previous ? previous.toISOString() : null,
      nextBillingDate: effective.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

// ── Send next order tomorrow (P2.7 "already out") ────────────────────────────

/** Typed refusals for `sendNextOrderTomorrow` — routes map them to copy. */
export type SendTomorrowErrorCode =
  | "NOT_ACTIVE" // only an ACTIVE contract has an upcoming order to pull
  | "PREPARING" // the billing day's charge moment has passed / attempt in flight
  | "PAYMENT_ISSUE" // an open dunning case owns the cycle
  | "ALREADY_SOON"; // nextBillingDate is already tomorrow or earlier

export class SendTomorrowError extends Error {
  constructor(readonly code: SendTomorrowErrorCode) {
    super(`sendNextOrderTomorrow refused: ${code}`);
    this.name = "SendTomorrowError";
  }
}

/**
 * Run-out "I'm already out" branch (v1.28.0, P2.7): pull the upcoming order
 * to TOMORROW's shop day. Shopify's own nextBillingDate moves through the same
 * `subscriptionContractSetNextBillingDate` primitive `setNextBillingDate`
 * wraps, so Shopify and the mirror agree, and the sweep charges it at
 * tomorrow's charge moment (billing/timing.server.ts) — never "now": the
 * sweep bills at the shop's charge moment and an in-run charge is a
 * different, riskier verb. Later deliveries follow the new date (a re-anchor,
 * exactly what the customer who ran out wants).
 *
 * Refuses (typed) when the contract is not ACTIVE, when the current billing
 * day is already being prepared (`isPreparingOrder`), when an open dunning
 * case owns the cycle, or when the next date is already tomorrow or earlier
 * (nothing to pull). Per-line cycle edits (P2.5) are reconciled like every
 * other schedule move. Lock window: an ACCELERATION — never blocked.
 *
 * Event: `contract.next_date_changed` { reason: "send_tomorrow", previous… }
 * plus `cycle.rushed` { from, to } for the retention stream; the previous
 * date rides in the payload so Undo can restore it via `setNextBillingDate`.
 */
export async function sendNextOrderTomorrow(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const tz = shop.ianaTimezone;
  const now = new Date();

  if (contract.status !== "ACTIVE") throw new SendTomorrowError("NOT_ACTIVE");
  const previous = contract.nextBillingDate;
  const tomorrow = addDaysTz(shopDayStartUtc(now, tz), 1, tz);
  if (previous && previous.getTime() <= tomorrow.getTime()) {
    throw new SendTomorrowError("ALREADY_SOON");
  }
  if (await isPreparingOrder(contract, shop.id, now)) {
    throw new SendTomorrowError("PREPARING");
  }
  const openCase = await prisma.dunningCase.findFirst({
    where: {
      contractId: contract.id,
      state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] },
    },
    select: { id: true },
  });
  if (openCase) throw new SendTomorrowError("PAYMENT_ISSUE");

  const result = await shopifySetNextBillingDate(
    admin,
    contract.shopifyContractId,
    tomorrow,
  );
  const effective = result.nextBillingDate ?? tomorrow;

  await withMirrorGuard("sendNextOrderTomorrow", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: effective },
    }),
  );

  await reconcileCycleOverridesAfterMove(ctx, effective);

  const identity = eventIdentity(shop, contract);
  await logEvent({
    ...identity,
    type: "contract.next_date_changed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      reason: "send_tomorrow",
      previousNextBillingDate: previous ? previous.toISOString() : null,
      nextBillingDate: effective.toISOString(),
    },
  });
  await logEvent({
    ...identity,
    type: "cycle.rushed",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      from: previous ? previous.toISOString() : null,
      to: effective.toISOString(),
    },
  });

  return reloadContract(contract.id);
}

// ── Delivery instructions (P2.8) ─────────────────────────────────────────────

/**
 * Custom attribute key mirrored next to the Shopify contract note. Contract
 * customAttributes are copied onto every renewal order; Shopify hides
 * attributes whose key starts with `_` from the order status page and the
 * notification templates (the note is the human-facing copy), so the key is
 * underscore-prefixed (v1.28.0 review fix). The legacy un-prefixed key is
 * still recognised — and removed — on the next save/clear.
 */
export const DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY = "_cellexia_delivery_instructions";
const LEGACY_DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEYS: readonly string[] = [
  "cellexia_delivery_instructions",
];

/**
 * Pure merge behind setDeliveryInstructions: the contract's current Shopify
 * `note` / `customAttributes` (checkout attributes Shopify copied onto the
 * contract, other apps' keys — the store runs a second vendor's apps) are
 * preserved; only OUR attribute is replaced / removed, and the note is
 * rewritten only where the app owns it: an empty note, or one equal to the
 * text the app last wrote (`previous`). A note set elsewhere is composed as
 * `existing + "\n" + instructions` and, on clear, only our line is dropped.
 */
export function mergeDeliveryInstructions(input: {
  currentNote: string | null;
  currentAttributes: ReadonlyArray<{ key: string; value: string }>;
  /** The instructions text the app previously wrote (mirror), if any. */
  previous: string | null;
  /** New instructions; null clears. */
  value: string | null;
}): {
  note: string | null;
  customAttributes: Array<{ key: string; value: string }>;
} {
  const ours = new Set<string>([
    DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY,
    ...LEGACY_DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEYS,
  ]);
  const customAttributes = input.currentAttributes.filter((a) => !ours.has(a.key));
  if (input.value) {
    customAttributes.push({ key: DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY, value: input.value });
  }

  const existing = (input.currentNote ?? "").trim();
  const previous = (input.previous ?? "").trim();
  // Foreign part of the note: everything that is not the text we last wrote.
  let foreign = existing;
  if (previous) {
    if (existing === previous) foreign = "";
    else if (existing.endsWith(`\n${previous}`)) {
      foreign = existing.slice(0, existing.length - previous.length - 1).trim();
    }
  }
  let note: string | null;
  if (input.value) {
    note = foreign ? `${foreign}\n${input.value}` : input.value;
  } else {
    note = foreign || null;
  }
  return { note, customAttributes };
}

/**
 * Trim, collapse control characters (keep newlines), cap at `maxChars`.
 * Empty → null. Pure so routes can preview what will be stored.
 */
export function sanitizeDeliveryInstructions(
  raw: string | null | undefined,
  maxChars: number,
): string | null {
  if (raw == null) return null;
  const cleaned = String(raw)
    // Drop C0/C1 control characters except \n and \t; normalise CRLF.
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    // Collapse runs of blank lines / spaces so a note stays a note.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  const cap = Math.max(1, Math.floor(maxChars));
  return Array.from(cleaned).slice(0, cap).join("").trim() || null;
}

/**
 * Customer delivery note (v1.28.0, P2.8): written to the Shopify contract
 * `note` (copied onto every renewal order — where fulfilment reads it) AND
 * as the `cellexia_delivery_instructions` custom attribute (structured, for
 * flows), then mirrored on SubscriptionContract.deliveryInstructions. Empty
 * or null clears all three. Cap = settings.portal.deliveryInstructionsMaxChars.
 * Idempotent on equal text (no Shopify call, no event). Lock window: a
 * delivery-detail edit like `updateDeliveryAddress` — never blocked. Event:
 * `contract.delivery_instructions_updated` { length, cleared } — never the
 * text (PII-light events).
 */
export async function setDeliveryInstructions(
  shopDomain: string,
  contractLocalId: string,
  text: string | null,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;

  const portalSettings = await getSetting(shop.id, "portal");
  const maxChars =
    (portalSettings as { deliveryInstructionsMaxChars?: number })
      .deliveryInstructionsMaxChars ?? 250;
  const value = sanitizeDeliveryInstructions(text, maxChars);

  const current =
    (contract as { deliveryInstructions?: string | null }).deliveryInstructions ??
    null;
  if ((current ?? null) === value) return reloadContract(contract.id);

  // Read what the contract carries NOW (SubscriptionDraftInput.customAttributes
  // replaces the whole list and `note` the whole note): merge, never clobber.
  // A failed read is treated as "nothing else there" only for the note we own
  // — attributes are then left untouched rather than wiped.
  let currentNote: string | null = null;
  let currentAttributes: Array<{ key: string; value: string }> = [];
  let attributesKnown = false;
  try {
    const shopifyState = await getContractNoteAndAttributes(
      admin,
      contract.shopifyContractId,
    );
    currentNote = shopifyState.note;
    currentAttributes = shopifyState.customAttributes;
    attributesKnown = true;
  } catch (err) {
    console.error(
      "[contracts] setDeliveryInstructions: contract note/attributes read failed — merging conservatively",
      contract.id,
      err,
    );
  }
  const merged = mergeDeliveryInstructions({
    currentNote: attributesKnown ? currentNote : current,
    currentAttributes,
    previous: current,
    value,
  });

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdateNote(
        run,
        draftId,
        merged.note,
        // Unknown current list ⇒ do not send the list at all (a partial
        // write would drop foreign attributes); ours rides on the note.
        attributesKnown ? merged.customAttributes : undefined,
      );
    },
  );

  await withMirrorGuard("setDeliveryInstructions", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { deliveryInstructions: value },
    }),
  );

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.delivery_instructions_updated",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: { length: value ? value.length : 0, cleared: value === null },
  });

  return reloadContract(contract.id);
}

// ── Discount grants ──────────────────────────────────────────────────────────

export interface DiscountGrantInput {
  /** SAVE_OFFER | SAVE_OFFER_FINAL | WINBACK | RETENTION | MANUAL */
  type: string;
  percent: number;
  cycles: number;
  grantedBy?: string | null;
  reason?: string | null;
  /** Extra event-payload fields (e.g. { sessionId }) merged into the grant
   * event so stream analytics can join accepts to their flow session. */
  context?: Record<string, unknown>;
}

const GRANT_EVENT_TYPES: Record<string, string> = {
  SAVE_OFFER: "cancel.save_accepted",
  SAVE_OFFER_FINAL: "cancel.final_offer_accepted",
  // Deliberately NOT winback.discount_offered: the sweep already logged that
  // when the offer email was sent — re-emitting it on acceptance would
  // double-count offers and understate offer→acceptance conversion.
  WINBACK: "winback.discount_granted",
  RETENTION: "admin.action",
  MANUAL: "admin.action",
};

/**
 * Grant a temporary N-cycle percentage discount. The billing sweep applies it
 * per cycle via billing-cycle contract edits (never discount codes) and the
 * success webhook consumes one cycle at a time. Idempotent: an identical
 * still-active grant is not duplicated.
 *
 * Discount stacking cap: the percent is clamped so that the contract's plan
 * ongoing discount (SellingPlanConfig.ongoingDiscountPct) plus the grant never
 * exceeds settings.discountStacking.maxTotalDiscountPct. With zero headroom no
 * grant is created (the decision is logged); callers that SHOW offers run the
 * same clamp first (~/lib/billing/stacking.server) so customers are never
 * promised more than this gate will grant.
 */
export async function applyDiscountGrant(
  shopDomain: string,
  contractLocalId: string,
  grant: DiscountGrantInput,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  if (!Number.isInteger(grant.percent) || grant.percent < 1 || grant.percent > 90) {
    throw new Error(`Invalid discount percent: ${grant.percent}`);
  }
  if (!Number.isInteger(grant.cycles) || grant.cycles < 1) {
    throw new Error(`Invalid discount cycles: ${grant.cycles}`);
  }

  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract } = ctx;

  const clamp = await clampGrantPercentForContract(
    shop.id,
    contract.lines,
    grant.percent,
  );
  if (clamp.percent < 1) {
    // No headroom under the stacking cap — refuse the grant, audibly.
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "contract.updated",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        action: "discount_grant_rejected",
        reason: "stacking_cap",
        grantType: grant.type,
        requestedPercent: grant.percent,
        ongoingDiscountPct: clamp.ongoingDiscountPct,
        maxTotalDiscountPct: clamp.maxTotalDiscountPct,
      },
    });
    return reloadContract(contract.id);
  }
  const percent = clamp.percent;

  const existing = await prisma.discountGrant.findFirst({
    where: {
      contractId: contract.id,
      type: grant.type,
      percent,
      cyclesTotal: grant.cycles,
      cyclesRemaining: { gt: 0 },
    },
  });
  if (existing) return reloadContract(contract.id); // grant already active

  const created = await prisma.discountGrant.create({
    data: {
      contractId: contract.id,
      type: grant.type,
      percent,
      cyclesTotal: grant.cycles,
      cyclesRemaining: grant.cycles,
      grantedBy: grant.grantedBy ?? resolveActor(options),
      reason: grant.reason ?? null,
    },
  });

  await logEvent({
    ...eventIdentity(shop, contract),
    type: GRANT_EVENT_TYPES[grant.type] ?? "admin.action",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      action: "discount_grant_created",
      ...(grant.context ?? {}),
      grantId: created.id,
      grantType: grant.type,
      percent,
      ...(clamp.clamped
        ? {
            requestedPercent: grant.percent,
            clampedByStackingCap: true,
            ongoingDiscountPct: clamp.ongoingDiscountPct,
            maxTotalDiscountPct: clamp.maxTotalDiscountPct,
          }
        : {}),
      cycles: grant.cycles,
      reason: grant.reason ?? null,
    },
  });

  return reloadContract(contract.id);
}

// ── Payment methods ──────────────────────────────────────────────────────────

/** Why `changePaymentMethod` / `setBackupPaymentMethod` refused (v1.28.0). */
export type PaymentMethodChangeErrorCode =
  | "PAYMENT_METHOD_NOT_ON_ACCOUNT" // not among the customer's non-revoked methods
  | "BACKUP_EQUALS_PRIMARY" // backup must differ from the primary
  | "BACKUP_IN_USE" // the dunning engine is charging the backup right now
  | "CONTRACT_NOT_OWNED"; // FOREIGN / UNKNOWN contract — never ours to re-point

/**
 * Typed refusal so callers (portal / admin / magic links) can map to a
 * customer-facing toast instead of a generic error. The form value is never
 * trusted: a gid must be one of THIS customer's live methods.
 */
export class PaymentMethodChangeError extends Error {
  code: PaymentMethodChangeErrorCode;
  constructor(code: PaymentMethodChangeErrorCode, message: string) {
    super(message);
    this.name = "PaymentMethodChangeError";
    this.code = code;
  }
}

/** Who/what caused a primary payment-method change (event payload `trigger`). */
export type PaymentMethodChangeTrigger =
  | "select" // customer picked another vaulted method in the portal / magic link
  | "backup" // dunning fallback swap to the backup (old changePaymentMethodToBackup)
  | "new_method" // webhook detected a newer method and auto-switched
  | "admin"; // merchant "Make primary"

/**
 * Card-mirror columns for a vaulted method (brand/last4/expiry/type). Best
 * effort: `null` when the instrument details are absent — never blocks the
 * switch, Shopify already holds the truth.
 */
function cardMirrorFor(
  method: { instrument: { brand: string | null; lastDigits: string | null; expiryMonth: number | null; expiryYear: number | null; type: string } | null } | undefined,
): {
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardExpiryMonth?: number | null;
  cardExpiryYear?: number | null;
  paymentInstrumentType?: string | null;
} {
  if (!method?.instrument) return {};
  return {
    cardBrand: method.instrument.brand,
    cardLast4: method.instrument.lastDigits,
    cardExpiryMonth: method.instrument.expiryMonth,
    cardExpiryYear: method.instrument.expiryYear,
    paymentInstrumentType: method.instrument.type,
  };
}

/**
 * Switch the contract's PRIMARY payment method to another vaulted method of
 * the same customer (v1.28.0 seam; generalizes the dunning backup swap).
 *
 * - Already primary → no-op (returns the reloaded contract, no event).
 * - `paymentMethodId` MUST be among the customer's non-revoked methods
 *   (`listCustomerPaymentMethods`) → `PaymentMethodChangeError`
 *   PAYMENT_METHOD_NOT_ON_ACCOUNT otherwise. The Shopify draft would refuse a
 *   foreign method with CUSTOMER_MISMATCH anyway; validating first keeps the
 *   error typed and never trusts the form.
 * - Shopify: `withContractDraft(draftUpdatePaymentMethod)`.
 * - Mirror: paymentMethodId + brand/last4/expiry/instrument type,
 *   paymentMethodRevokedAt cleared (a live method was just chosen).
 * - Pointer rules (engine marks "on backup" by `paymentMethodId ===
 *   backupPaymentMethodId` and reverts from `DunningCase.originalPaymentMethodId`):
 *   trigger `backup` keeps the historical swap semantics (old primary becomes
 *   the backup); every other trigger clears backupPaymentMethodId when the
 *   new primary IS the backup (otherwise pointer equality would read as
 *   "engine on backup"), and an open case currently on the backup gets
 *   originalPaymentMethodId = null so the engine never reverts an explicit
 *   choice.
 * - Event `contract.payment_method_updated {trigger, previousPaymentMethodId,
 *   paymentMethodId}`; then the dunning engine's onPaymentMethodUpdated
 *   (contained — an open case retries immediately, FAILED reopens).
 */
export async function changePaymentMethod(
  shopDomain: string,
  contractLocalId: string,
  paymentMethodId: string,
  options: ServiceOptions & { trigger: PaymentMethodChangeTrigger },
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const { trigger } = options;

  // Golden rule: every billing path filters on ownership. The routes and
  // the engine gate before calling; the webhook new-method seam and any
  // future caller get the same refusal here so a mirrored FOREIGN / UNKNOWN
  // contract (the other app's) is never re-pointed by us.
  if (!isBillableOwnership(contract.ownership)) {
    throw new PaymentMethodChangeError(
      "CONTRACT_NOT_OWNED",
      `Contract ${contract.id} is not owned by this app (${contract.ownership}); its payment method is never changed here`,
    );
  }

  if (contract.paymentMethodId === paymentMethodId) {
    return reloadContract(contract.id); // already primary — nothing to do
  }

  const methods = await listCustomerPaymentMethods(admin, contract.customerId);
  const method = methods.find((m) => m.id === paymentMethodId && !m.revoked);
  if (!method) {
    throw new PaymentMethodChangeError(
      "PAYMENT_METHOD_NOT_ON_ACCOUNT",
      `Payment method ${paymentMethodId} is not among the customer's live payment methods for contract ${contract.id}`,
    );
  }

  await withContractDraft(
    admin,
    contract.shopifyContractId,
    async (draftId, run) => {
      await draftUpdatePaymentMethod(run, draftId, paymentMethodId);
    },
  );

  const previousPaymentMethodId = contract.paymentMethodId;
  // Pre-change card snapshot for the closed-loop notice below (names the
  // card being replaced) — captured before any mirror write.
  const previousCard = {
    cardBrand: contract.cardBrand,
    cardLast4: contract.cardLast4,
    paymentInstrumentType: contract.paymentInstrumentType,
  };
  const wasOnBackup =
    contract.backupPaymentMethodId != null &&
    contract.paymentMethodId === contract.backupPaymentMethodId;

  const pointerData: { backupPaymentMethodId?: string | null } = {};
  if (trigger === "backup") {
    // Historical swap semantics: the old primary becomes the backup so a
    // later swap can restore it.
    pointerData.backupPaymentMethodId = previousPaymentMethodId;
  } else if (
    contract.backupPaymentMethodId != null &&
    contract.backupPaymentMethodId === paymentMethodId
  ) {
    pointerData.backupPaymentMethodId = null;
  }

  await withMirrorGuard("changePaymentMethod", ctx, options, async () => {
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        paymentMethodId,
        paymentMethodRevokedAt: null,
        ...cardMirrorFor(method),
        ...pointerData,
      },
    });
    if (trigger !== "backup") {
      // Explicit choice during an open case: the engine's revert target must
      // follow it. On the backup → forget the target so the ladder never
      // flips the contract back; otherwise → the chosen card IS the new
      // original, so a later backup-then-revert restores THIS card and not
      // the declined one the customer just replaced.
      await prisma.dunningCase.updateMany({
        where: { contractId: contract.id, resolvedAt: null },
        data: { originalPaymentMethodId: wasOnBackup ? null : paymentMethodId },
      });
    }
  });

  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.payment_method_updated",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      trigger,
      usedBackup: trigger === "backup",
      previousPaymentMethodId,
      paymentMethodId,
      ...(pointerData.backupPaymentMethodId === null
        ? { backupCleared: true }
        : {}),
      // Klaviyo segmentation prop (canonical event → "Cellexia Payment
      // Method Updated" since v1.28.0). A webhook auto-switch to a newly
      // saved method (P1.8) is the app's doing, not a tap.
      card_updated_by:
        trigger === "admin"
          ? "merchant"
          : trigger === "new_method"
            ? "system"
            : "customer",
    },
  });

  // Closed loop (v1.28.0, P1.4): tell the customer the switch worked. The
  // `backup` trigger is the dunning engine's own swap — it sends its own
  // "switched to your backup card" notice — so it is skipped here; every
  // other trigger (portal select / new-method auto-switch / admin) is a
  // direct change the customer should hear about. Deduped per
  // {contract,last4}/24h and contained by the helper; dynamic import keeps
  // the contracts → notifications edge lazy (same reason as the dunning
  // import below).
  if (trigger !== "backup") {
    try {
      const { sendPaymentMethodUpdatedOnce } = await import(
        "~/lib/notifications/payment-method.server"
      );
      await sendPaymentMethodUpdatedOnce({
        locale: contract.locale,
        tz: shop.ianaTimezone,
        contract: {
          ...contract,
          paymentMethodId,
          paymentMethodRevokedAt: null,
          ...cardMirrorFor(method),
        },
        // `new_method` (P1.8) reads "we moved your subscription to your new
        // card ····1234" — the customer did not tap anything.
        reason: trigger === "new_method" ? "new_method" : "updated",
        previousCard,
        cardUpdatedBy:
          trigger === "admin"
            ? "merchant"
            : trigger === "new_method"
              ? "system"
              : "customer",
      });
    } catch (err) {
      console.error(
        "[contracts] payment_method_updated notice failed after payment method change",
        contract.id,
        err,
      );
    }
  }

  // Contained: a customer who just fixed the card should not wait for the
  // next ladder rung. Dynamic import keeps the contracts → dunning edge lazy
  // (the engine imports notifications/magic links; the service must stay
  // importable from those layers).
  try {
    const engine = await import("~/lib/dunning/engine.server");
    // Pre-change snapshot: lets a RETRYING case retry immediately because
    // the instrument actually changed (v1.28.0).
    await engine.onPaymentMethodUpdated(contract.id, {
      previous: {
        paymentMethodId: previousPaymentMethodId,
        cardLast4: contract.cardLast4,
        cardExpiryMonth: contract.cardExpiryMonth,
        cardExpiryYear: contract.cardExpiryYear,
        cardBrand: contract.cardBrand,
      },
    });
  } catch (err) {
    console.error(
      "[contracts] dunning.onPaymentMethodUpdated failed after payment method change",
      contract.id,
      err,
    );
  }

  return reloadContract(contract.id);
}

/**
 * Set or clear the contract's BACKUP payment method (v1.28.0). Local column
 * write only — Shopify has no notion of a backup; the dunning engine
 * (`dunning.backupPaymentFallback`) and the revoke webhook read it.
 *
 * - `null` clears (idempotent: already clear → no event).
 * - Otherwise MUST differ from the primary (BACKUP_EQUALS_PRIMARY) and be one
 *   of the customer's non-revoked methods (PAYMENT_METHOD_NOT_ON_ACCOUNT);
 *   same as the current backup → no-op.
 * - Records provenance in backupSetBy / backupSetAt (admin Select and the
 *   customer toggle write the same column).
 * - Events `contract.backup_payment_set|cleared {setBy, paymentMethodId,
 *   previousBackupPaymentMethodId}`.
 */
export async function setBackupPaymentMethod(
  shopDomain: string,
  contractLocalId: string,
  paymentMethodId: string | null,
  options: ServiceOptions & { setBy: "CUSTOMER" | "ADMIN" },
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { shop, contract, admin } = ctx;
  const { setBy } = options;
  const previous = contract.backupPaymentMethodId;
  const now = new Date();

  // The engine marks "currently charging the backup" by pointer equality
  // (paymentMethodId === backupPaymentMethodId) and reverts to the case's
  // original card only while that holds. Rewriting the backup column in that
  // window (clear, or point at a third card) would erase the marker: no
  // revert to the customer's real card, ladder stuck on a borrowed one.
  // Refuse with a typed error — but ONLY while a case is open: the engine
  // collapses the marker when the case closes, and a leftover equality (a
  // failed collapse / revert, legacy rows) must never lock the customer out
  // of setting a backup for good (v1.28.0 review fix).
  if (previous != null && contract.paymentMethodId === previous) {
    if (paymentMethodId === previous) return reloadContract(contract.id);
    const openCase = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, state: { in: OPEN_CASE_STATES } },
      select: { id: true },
    });
    if (openCase) {
      throw new PaymentMethodChangeError(
        "BACKUP_IN_USE",
        `Contract ${contract.id} is being charged on its backup payment method right now; the backup cannot be changed until the retry settles`,
      );
    }
    // Stale marker: fall through — the write below repoints / clears it.
  }

  if (paymentMethodId == null) {
    if (previous == null) return reloadContract(contract.id);
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { backupPaymentMethodId: null, backupSetBy: setBy, backupSetAt: now },
    });
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "contract.backup_payment_cleared",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: { setBy, previousBackupPaymentMethodId: previous },
    });
    return reloadContract(contract.id);
  }

  if (paymentMethodId === contract.paymentMethodId) {
    throw new PaymentMethodChangeError(
      "BACKUP_EQUALS_PRIMARY",
      `Payment method ${paymentMethodId} is already the primary of contract ${contract.id}`,
    );
  }
  if (paymentMethodId === previous) {
    return reloadContract(contract.id); // already the backup
  }
  const methods = await listCustomerPaymentMethods(admin, contract.customerId);
  const method = methods.find((m) => m.id === paymentMethodId && !m.revoked);
  if (!method) {
    throw new PaymentMethodChangeError(
      "PAYMENT_METHOD_NOT_ON_ACCOUNT",
      `Payment method ${paymentMethodId} is not among the customer's live payment methods for contract ${contract.id}`,
    );
  }

  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: {
      backupPaymentMethodId: paymentMethodId,
      backupSetBy: setBy,
      backupSetAt: now,
    },
  });
  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.backup_payment_set",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      setBy,
      paymentMethodId,
      previousBackupPaymentMethodId: previous,
      instrumentType: method.instrument?.type ?? null,
      cardLast4: method.instrument?.lastDigits ?? null,
    },
  });
  return reloadContract(contract.id);
}

// ── Backup payment method ────────────────────────────────────────────────────

/**
 * Swap the contract to its backup payment method (dunning fallback). The old
 * primary becomes the new backup so a later swap can restore it. Delegates
 * to `changePaymentMethod` with trigger `backup` (v1.28.0) — same Shopify
 * draft, same mirror refresh, same swap semantics, same event shape
 * (`usedBackup: true`).
 */
export async function changePaymentMethodToBackup(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, contractLocalId);
  const { contract } = ctx;

  const backupId = contract.backupPaymentMethodId;
  if (!backupId) {
    throw new Error(
      `Contract ${contract.id} has no backup payment method to fall back to`,
    );
  }
  if (contract.paymentMethodId === backupId) {
    return reloadContract(contract.id); // already on the backup
  }
  return changePaymentMethod(shopDomain, contractLocalId, backupId, {
    ...options,
    trigger: "backup",
  });
}

// ── Seam re-exports ──────────────────────────────────────────────────────────
// ARCHITECTURE.md lists every contract-service seam as importable from
// service.server.ts; these two live in sibling modules of this package.
// (Safe ESM cycle: all seams are hoisted function declarations.)

export { mergeContracts } from "./consolidation.server";
export { syncContractFromShopify } from "./sync.server";
