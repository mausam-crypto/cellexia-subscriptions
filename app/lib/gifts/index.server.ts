/**
 * Gift engine — GiftRules → GiftGrants → zero-priced lines on exactly one
 * billing cycle (billing-cycle contract edits; auto-revert after the cycle).
 *
 * The billing scheduler and the contracts-create webhook call
 * ensureGiftsForUpcomingCycle pre-charge; the jobs module runs
 * runGiftScheduling daily; clearShippedGiftMirrors is mirror hygiene after a
 * cycle bills.
 */

export {
  clearShippedGiftMirrors,
  ensureGiftsForUpcomingCycle,
  removeGiftAfterCycle,
  runGiftScheduling,
  type EnsureGiftsResult,
  type GiftSchedulingStats,
} from "./engine.server";
