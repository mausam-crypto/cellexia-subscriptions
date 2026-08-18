/**
 * Contract services — the domain layer everything else calls.
 *
 * Import from "~/lib/contracts/index.server" (or the individual modules).
 * All functions take `(shopDomain, contractLocalId, ...)`, mutate Shopify
 * through the graphql layer, keep the local mirror in sync, log canonical
 * events and return the updated local contract with lines.
 */

export {
  type AddLineOpts,
  type AddOneTimeAddonOpts,
  type CancelOptions,
  type CancelSource,
  type DelayInput,
  type DiscountGrantInput,
  type PaymentMethodChangeErrorCode,
  type PaymentMethodChangeTrigger,
  type PauseUntilErrorCode,
  type PauseUntilOptions,
  type PauseUntilReason,
  type ResumeOptions,
  type SendTomorrowErrorCode,
  PAUSE_UNTIL_REASONS,
  PauseUntilError,
  PaymentMethodChangeError,
  SendTomorrowError,
  DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY,
  type ContractEditBlockedCode,
  ContractEditBlockedError,
  hasPendingCycleEdits,
  mergeDeliveryInstructions,
  extendPause,
  maxPauseResumeAt,
  normalizePauseUntilReason,
  pauseUntil,
  sanitizeDeliveryInstructions,
  sendNextOrderTomorrow,
  setDeliveryInstructions,
  addLine,
  addOneTimeAddon,
  applyDiscountGrant,
  cancelContract,
  changeFrequency,
  changeLineQuantity,
  changePaymentMethod,
  changePaymentMethodToBackup,
  delayNextCycle,
  pauseContract,
  removeLine,
  resumeContract,
  setBackupPaymentMethod,
  setLinePrice,
  setNextBillingDate,
  skipNextCycle,
  swapLineVariant,
  unskipNextCycle,
  updateDeliveryAddress,
} from "./service.server";

export {
  type BackfillResult,
  backfillAllContracts,
  syncContractFromShopify,
} from "./sync.server";

export {
  type AutoConsolidationResult,
  mergeContracts,
  runAutoConsolidation,
} from "./consolidation.server";

export {
  type ApplyBatchResult,
  type PriceChangeItem,
  type SendNoticesResult,
  applyPriceChangeBatch,
  createPriceChangeBatch,
  sendPriceChangeNotices,
} from "./priceChanges.server";

export {
  type StockoutAction,
  type StockoutEvaluation,
  evaluateStockoutForContract,
} from "./stockout.server";

export {
  type LocalContractLine,
  type LocalContractWithLines,
  type ServiceOptions,
  ongoingDiscountPctForProduct,
  ongoingDiscountedPriceCents,
} from "./shared.server";
