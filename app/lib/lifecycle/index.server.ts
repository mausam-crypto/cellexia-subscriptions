/**
 * Lifecycle engine — milestones, early-cycle incentives, day-N rewards unlock.
 *
 * The billing-success webhook calls onSuccessfulCycle after each billed cycle;
 * the jobs module should run runLifecycleSweep daily (rewards unlock lives
 * there). Gifts themselves are owned by the gift engine via GiftRules.
 */

export {
  onSuccessfulCycle,
  runLifecycleSweep,
  runRewardsUnlock,
  type LifecycleSweepStats,
  type RewardsUnlockStats,
  type SuccessfulCycleResult,
} from "./engine.server";
