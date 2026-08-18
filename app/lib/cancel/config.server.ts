/**
 * Cancel-flow vocabulary: reasons, save kinds and the reason → saves mapping.
 *
 * ── Psychology rationale ─────────────────────────────────────────────────────
 * The REASONS list is ordered by save-ability, most save-able first: a radio
 * list is scanned top-to-bottom and the first plausible match wins, so leading
 * with logistics reasons ("too much product") — which have cheap, non-discount
 * fixes — biases the funnel toward skips/frequency changes instead of margin
 * give-aways. Price objections come second (a pause reframes the spend without
 * discounting; the discount is the fallback, not the lead). "Other" is last
 * and maps only to PAUSE, because unqualified discounts train customers to
 * threaten cancellation for money off.
 *
 * Reason-gating is the core guardrail: NO offer of any kind is shown before a
 * reason is recorded, and each reason unlocks only the saves that actually
 * address it. A "too much product" subscriber never sees a percentage
 * discount — they see a skip. This preserves gross margin and prevents
 * discount training while still matching a real objection with a real fix.
 *
 * Default-to-pause: PAUSE appears in most mappings because a paused
 * subscriber retains the relationship, the stored payment method and the
 * consent — reactivation is one tap — whereas a cancelled one must be won
 * back. Loss aversion does the heavy lifting on step 1 (what you'd give up),
 * and the pause is framed as the no-loss default.
 *
 * ── Compliance guardrails (FTC click-to-cancel / EU-UK fairness) ─────────────
 * - Cancellation must be at least as easy as sign-up: skipping every offer,
 *   the full path is ≤3 required clicks ("Continue to cancel" → reason submit
 *   → "No thanks, cancel my subscription", which completes the cancellation
 *   immediately — no interstitial is ever auto-inserted before completion).
 * - The reason survey has a visible "I'd rather not say" bypass straight to
 *   the confirm step, so the survey is never a hard gate.
 * - The deeper final offer is strictly OPT-IN: it is only reachable through an
 *   explicit "See my final offer" control (saves/confirm pages), is shown at
 *   most once per flow and once per cooldown (enforced by
 *   eligibleForFinalOffer against prior cancel.final_offer_shown events and
 *   grants), and its decline control cancels immediately — never a loop.
 * - No dark patterns: the "continue to cancel" control always has equal
 *   visual weight with the save CTA (same size, same typography), decline
 *   controls are full-size buttons (never hidden links), and every claim in
 *   the copy ("final offer", milestone progress) is enforced by data.
 */

import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

/** The 11 save mechanics the flow can offer. EXTEND_PAUSE (v1.28.0) is the
 * pause exit ramp — offered only on already-PAUSED contracts, in PAUSE's
 * slot; it never appears in a reason's savesOrder. DELAY (v1.28.0, P3.3) is
 * "push my next order to {predicted empty date}" — the fitted answer to
 * "too much product" when the churn model knows the run-out day. */
export const SAVE_KINDS = [
  "DELAY",
  "SKIP",
  "FREQUENCY",
  "PAUSE",
  "EXTEND_PAUSE",
  "DISCOUNT",
  "GIFT",
  "SWAP",
  "DOWNSIZE",
  "EDUCATION",
  "SUPPORT",
] as const;

export type SaveKind = (typeof SAVE_KINDS)[number];

/** CancelSession.saveAccepted value for the step-4 deeper discount. */
export const FINAL_DISCOUNT = "FINAL_DISCOUNT";

export const CANCEL_REASON_KEYS = [
  "TOO_MUCH_PRODUCT",
  "TOO_EXPENSIVE",
  "NOT_SEEING_RESULTS",
  "TRYING_SOMETHING_ELSE",
  "SHIPPING_ISSUES",
  "OTHER",
] as const;

export type CancelReason = (typeof CANCEL_REASON_KEYS)[number];

export interface CancelReasonConfig {
  key: CancelReason;
  /** i18n key for the radio label (all copy lives in the locale catalogs). */
  i18nKey: string;
  /** Saves to offer for this reason, best-fit first. Max MAX_SAVES_SHOWN shown. */
  savesOrder: SaveKind[];
}

/**
 * Ordered most save-able first — see the module JSDoc for why the order and
 * the per-reason mappings look like this.
 */
export const REASONS: CancelReasonConfig[] = [
  {
    key: "TOO_MUCH_PRODUCT",
    i18nKey: "cancel.reason.too_much_product",
    // DOWNSIZE (v1.28.0) right after SKIP: fewer units / a smaller size is a
    // structural fix for surplus that keeps every delivery, at a lower ARPU
    // instead of zero. It only renders when a genuinely cheaper option
    // exists, so FREQUENCY/PAUSE still fill the cap otherwise.
    // DELAY (v1.28.0, P3.3) FIRST: when the churn model predicts the run-out
    // day and it lies after the next charge, "push my next order to {that
    // day}" fits the objection exactly — one delivery arrives when the
    // product actually runs out, nothing is skipped. It only renders when
    // that prediction exists and is within cancelFlow.delaySaveMaxDays, so
    // SKIP keeps its slot otherwise.
    savesOrder: ["DELAY", "SKIP", "DOWNSIZE", "FREQUENCY", "PAUSE"],
  },
  {
    key: "TOO_EXPENSIVE",
    i18nKey: "cancel.reason.too_expensive",
    // DOWNSIZE (v1.28.0) leads: a cheaper configuration (fewer units /
    // smaller size / cheaper product, each with its concrete new total)
    // answers the price objection directly and keeps every delivery at a
    // lower ARPU instead of zero — and it is not a discount, so it never
    // trains the customer. The pause reframes the spend next; the discount
    // stays the fallback (it fills the cap when no cheaper option exists).
    savesOrder: ["DOWNSIZE", "PAUSE", "DISCOUNT"],
  },
  {
    key: "NOT_SEEING_RESULTS",
    i18nKey: "cancel.reason.not_seeing_results",
    // Education first (a knowledge problem before a product problem), then a
    // free product — COGS instead of face-value margin, and it introduces a
    // second product (OFFER_PLAYBOOK §2). SWAP survives as the fallback when
    // the gift card is unavailable (pool empty / cooldown).
    savesOrder: ["EDUCATION", "GIFT", "SWAP"],
  },
  {
    key: "TRYING_SOMETHING_ELSE",
    i18nKey: "cancel.reason.trying_something_else",
    // "Trying something else" IS a variety request — a free different
    // product answers it exactly, and costs COGS, not margin.
    savesOrder: ["GIFT", "PAUSE", "SWAP"],
  },
  {
    key: "SHIPPING_ISSUES",
    i18nKey: "cancel.reason.shipping_issues",
    savesOrder: ["SUPPORT", "FREQUENCY"],
  },
  {
    key: "OTHER",
    i18nKey: "cancel.reason.other",
    // PAUSE first, deliberately (unqualified discounts train customers to
    // threaten cancellation for money off — see the module JSDoc). A gift is
    // the one sweetener that doesn't reprice the product, so it may follow.
    savesOrder: ["PAUSE", "GIFT"],
  },
];

/**
 * Saves a PAUSED canceller is offered FIRST, whatever the reason (v1.28.0):
 * a subscriber already on hold who still walks into the flow used to see
 * zero applicable saves (SKIP / DOWNSIZE / FREQUENCY were ACTIVE-only, PAUSE
 * a no-op). The honest, non-discount fixes for that moment are the pause
 * exit ramp — PAUSE's slot resolves to EXTEND_PAUSE on a paused contract —
 * and "resume later, at a slower cadence" (FREQUENCY applied to the paused
 * contract: nothing is charged before the hold ends; the slower cadence
 * applies from the first order after it). The reason's own order follows,
 * so a reason that already leads with them keeps its intent; the cap
 * (settings.cancelFlow.maxSavesShown) still applies.
 */
export const PAUSED_SAVES_LEAD: SaveKind[] = ["PAUSE", "FREQUENCY"];

/**
 * The SaveKind order to walk for a contract in `status` — the reason's own
 * order for ACTIVE contracts; PAUSED_SAVES_LEAD first (deduped) for PAUSED.
 * Pure — pinned in tests/cancel-paused-saves.test.ts.
 */
export function savesOrderFor(cfg: CancelReasonConfig, status: string): SaveKind[] {
  if (status !== "PAUSED") return cfg.savesOrder;
  const out: SaveKind[] = [];
  for (const kind of [...PAUSED_SAVES_LEAD, ...cfg.savesOrder]) {
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

/**
 * Saves the plan lock window refuses (v1.28.0, P3.8): every schedule
 * reduction the portal dispatcher blocks — a locked contract that walks the
 * flow (to schedule its cancellation) is offered only the additive saves
 * (DISCOUNT / GIFT / EDUCATION / SUPPORT). Same set as the dispatcher's
 * blocked verbs; the engine enforces it at offer AND accept time.
 */
export const LOCK_BLOCKED_SAVES: ReadonlySet<SaveKind> = new Set<SaveKind>([
  "DELAY",
  "SKIP",
  "FREQUENCY",
  "PAUSE",
  "EXTEND_PAUSE",
  "SWAP",
  "DOWNSIZE",
]);

/**
 * CancelSession outcome for the concierge save (v1.28.0, P3.7): the SUPPORT
 * request went out and the subscription stands, but a human still has to
 * answer — analytics keep it DISTINCT from SAVED (a request is not yet a
 * save); the hourly concierge job promotes it to SAVED once the merchant
 * resolves the SUPPORT_REQUEST alert while the contract still lives.
 */
export const SAVED_PENDING = "SAVED_PENDING";

/** CancelSession outcome when a locked contract scheduled its cancellation
 * for the unlock moment (v1.28.0, P3.8) — the hourly job completes it. */
export const CANCEL_SCHEDULED = "CANCEL_SCHEDULED";

/** Look up a reason config; null for unknown/tampered form values. */
export function reasonConfig(key: string | null | undefined): CancelReasonConfig | null {
  if (!key) return null;
  return REASONS.find((r) => r.key === key) ?? null;
}

/**
 * Merge step-3 offers into an existing savesShown list, preserving any
 * FINAL_DISCOUNT marker already recorded — browser back-navigation to the
 * saves page must never wipe the "final offer was shown" state (that marker
 * is the once-per-flow invariant). `changed` is false when the non-final
 * offer set is identical, so callers neither re-write nor re-log on a
 * refresh. Pure — tested directly in tests/cancel-mapping.test.ts.
 */
export function mergeSavesShown<T extends { kind: string }>(
  existing: T[],
  saves: T[],
): { merged: T[]; changed: boolean } {
  const preserved = existing.filter((s) => s.kind === FINAL_DISCOUNT);
  const existingNonFinal = existing.filter((s) => s.kind !== FINAL_DISCOUNT);
  // Change detection compares full payloads, not just the kind sequence
  // (v1.24.0): a re-rendered card of the SAME kind can carry a different
  // offer — the dynamic GIFT pick being the sharp case — and savesShown is
  // what the accept path executes, so a stale payload would grant something
  // other than what the customer saw. Offers are built in deterministic key
  // order by getSavesForReason, so stringify equality is reliable.
  const changed =
    existingNonFinal.length === 0 ||
    JSON.stringify(existingNonFinal) !== JSON.stringify(saves);
  return { merged: [...saves, ...preserved], changed };
}

/**
 * Behavior-tuning defaults, promoted to settings.cancelFlow (maxSavesShown,
 * frequencySuggestDeltaWeeks, pauseSuggestMonths, sessionFreshMinutes) so the
 * operator can tune them without a deploy. The constants remain as the
 * registry defaults and as fallbacks for callers without a shop id.
 */

/** At most this many reason-matched saves are shown on step 3 (default). */
export const MAX_SAVES_SHOWN = 2;

/** FREQUENCY save suggests shipping this many weeks less often (default). */
export const FREQUENCY_SUGGEST_DELTA_WEEKS = 2;

/** PAUSE save suggests this many months (default; clamped by settings.pause.maxMonths). */
export const PAUSE_SUGGEST_MONTHS = 2;

/** How many swap alternatives a SWAP card lists at most. */
export const MAX_SWAP_OPTIONS = 3;

/** How many cheaper configurations a DOWNSIZE card lists at most
 * (fewer units → smaller size → cheaper product, in that order). */
export const MAX_DOWNSIZE_OPTIONS = 3;

/**
 * An un-completed session older than this is treated as stale: the flow
 * starts fresh (and startCancelSession marks stale ones ABANDONED). Default
 * for settings.cancelFlow.sessionFreshMinutes.
 */
export const SESSION_FRESH_MINUTES = 60;

/** Public (store-domain) base path of the app proxy — single source of truth
 * in app/lib/portal/proxy-path.ts (kept in lock-step with shopify.app.toml by
 * tests/proxy-subpath.test.ts). */
export const PROXY_PUBLIC_BASE = PORTAL_PROXY_BASE;

/** Store-domain URL path for a cancel-flow step (used for links AND redirects —
 * Location headers resolve against the storefront host, never `/proxy/...`). */
export function cancelPublicPath(contractLocalId: string, step?: string): string {
  const base = `${PROXY_PUBLIC_BASE}/cancel/${contractLocalId}`;
  return step ? `${base}/${step}` : base;
}

/** Store-domain URL path of the portal home ("keep my subscription" target). */
export function portalPublicPath(): string {
  return `${PROXY_PUBLIC_BASE}/`;
}

/** Step slugs handled by proxy.cancel.$id.$step.tsx. */
export const CANCEL_STEPS = [
  "reason",
  "saves",
  "final",
  "confirm",
  "done",
  "saved",
  // Scheduled-cancel confirmation (v1.28.0, P3.8): "cancels on {date} ·
  // keep my subscription"; also the landing after a keep.
  "scheduled",
] as const;

export type CancelStep = (typeof CANCEL_STEPS)[number];

export function isCancelStep(value: string | undefined): value is CancelStep {
  return (CANCEL_STEPS as readonly string[]).includes(value ?? "");
}

/**
 * Deterministic A/B copy variant per contract. Pages render the highest-
 * leverage persuasive strings (intro headline/sub, final-offer headline) from
 * `cancel.*.{a|b}` i18n keys; operators tweak either variant in the catalog
 * and analytics can split events by the `copyVariant` payload field logged
 * with cancel.flow_started. Stable per contract so a refresh never flips copy.
 */
export function copyVariantFor(contractLocalId: string): "a" | "b" {
  let h = 0;
  for (let i = 0; i < contractLocalId.length; i++) {
    h = (h * 31 + contractLocalId.charCodeAt(i)) | 0;
  }
  return (h & 1) === 0 ? "a" : "b";
}
