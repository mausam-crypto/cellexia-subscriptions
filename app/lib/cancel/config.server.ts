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

/** The 7 save mechanics the flow can offer. */
export const SAVE_KINDS = [
  "SKIP",
  "FREQUENCY",
  "PAUSE",
  "DISCOUNT",
  "SWAP",
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
    savesOrder: ["SKIP", "FREQUENCY", "PAUSE"],
  },
  {
    key: "TOO_EXPENSIVE",
    i18nKey: "cancel.reason.too_expensive",
    savesOrder: ["PAUSE", "DISCOUNT"],
  },
  {
    key: "NOT_SEEING_RESULTS",
    i18nKey: "cancel.reason.not_seeing_results",
    savesOrder: ["EDUCATION", "SWAP"],
  },
  {
    key: "TRYING_SOMETHING_ELSE",
    i18nKey: "cancel.reason.trying_something_else",
    savesOrder: ["PAUSE", "SWAP"],
  },
  {
    key: "SHIPPING_ISSUES",
    i18nKey: "cancel.reason.shipping_issues",
    savesOrder: ["SUPPORT", "FREQUENCY"],
  },
  {
    key: "OTHER",
    i18nKey: "cancel.reason.other",
    savesOrder: ["PAUSE"],
  },
];

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
  const changed =
    existingNonFinal.length === 0 ||
    existingNonFinal.map((s) => s.kind).join(",") !==
      saves.map((s) => s.kind).join(",");
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

/**
 * An un-completed session older than this is treated as stale: the flow
 * starts fresh (and startCancelSession marks stale ones ABANDONED). Default
 * for settings.cancelFlow.sessionFreshMinutes.
 */
export const SESSION_FRESH_MINUTES = 60;

/** Public (store-domain) base path of the app proxy — matches shopify.app.toml. */
export const PROXY_PUBLIC_BASE = "/apps/cellexia";

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
