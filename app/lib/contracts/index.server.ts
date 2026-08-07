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
  addLine,
  addOneTimeAddon,
  applyDiscountGrant,
  cancelContract,
  changeFrequency,
  changeLineQuantity,
  changePaymentMethodToBackup,
  delayNextCycle,
  pauseContract,
  removeLine,
  resumeContract,
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
