/**
 * Dunning module — decline taxonomy + retry ladder engine.
 *
 * Webhook consumers call onBillingAttemptFailed / Succeeded / Challenged and
 * onPaymentMethodUpdated; the jobs module runs runDunningSweep and
 * runPreExpiryNotices on its tick.
 */

export {
  categorizeDeclineCode,
  DECLINE_CODES,
  DECLINE_CODE_TABLE,
  UNKNOWN_DECLINE,
  type CustomerAction,
  type DeclineCategory,
  type DeclineCodeInfo,
} from "./decline-codes.server";
export {
  OPEN_CASE_STATES,
  changePaymentMethodToBackup,
  exhaustCase,
  onBillingAttemptChallenged,
  onBillingAttemptFailed,
  onBillingAttemptSucceeded,
  onPaymentMethodUpdated,
  runDunningSweep,
  runPreExpiryNotices,
  transitionOpenCase,
  type DunningSweepStats,
} from "./engine.server";
