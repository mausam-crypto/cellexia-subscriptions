/**
 * Subscription contract operations — the single implementation of the
 * Shopify contract-editing draft recipe. Every other module changes live
 * contracts exclusively through these functions.
 *
 * Recipe (ARCHITECTURE.md): subscriptionContractUpdate → draft mutations →
 * subscriptionDraftCommit, then ALWAYS re-sync the local mirror.
 * Billing-cycle actions and status changes skip the draft. Every mutation is
 * wrapped in withIdempotency, appends an audit entry and, where meaningful,
 * emits a lifecycle event.
 */
import type { SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  type AdminGraphql,
  ShopifyGraphqlError,
  assertNoUserErrors,
  runGraphql,
} from "~/services/core/shopifyClient.server";
import {
  type Actor,
  centsToDecimalString,
  contractOpKey,
  intervalToWeeks,
  mapShopifyContractStatus,
  normalizeActor,
  planAdjustedPriceCents,
  weeksToInterval,
} from "~/services/core/pure";
import {
  GET_CONTRACT_QUERY,
  SUBSCRIPTION_BILLING_CYCLE_SKIP_MUTATION,
  SUBSCRIPTION_CONTRACT_ACTIVATE_MUTATION,
  SUBSCRIPTION_CONTRACT_ATOMIC_CREATE_MUTATION,
  SUBSCRIPTION_CONTRACT_CANCEL_MUTATION,
  SUBSCRIPTION_CONTRACT_PAUSE_MUTATION,
  SUBSCRIPTION_CONTRACT_SET_NEXT_BILLING_DATE_MUTATION,
  SUBSCRIPTION_CONTRACT_UPDATE_MUTATION,
  SUBSCRIPTION_DRAFT_COMMIT_MUTATION,
  SUBSCRIPTION_DRAFT_DISCOUNT_ADD_MUTATION,
  SUBSCRIPTION_DRAFT_LINE_ADD_MUTATION,
  SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION,
  SUBSCRIPTION_DRAFT_LINE_UPDATE_MUTATION,
  SUBSCRIPTION_DRAFT_UPDATE_MUTATION,
} from "~/graphql/contracts";
import { GET_VARIANT_QUERY } from "~/graphql/products";
import { CUSTOMER_PAYMENT_METHOD_SEND_UPDATE_EMAIL_MUTATION } from "~/graphql/customers";
import { addWeeks } from "~/lib/dates";
import { toCents } from "~/lib/money";
import {
  parseJson,
  type CancelReason,
  type ContractAction,
} from "~/types/domain";
import { logger } from "~/lib/logger.server";

/** Contract edits replay within this window (double-submit protection). */
const EDIT_TTL_MS = 10 * 60 * 1000;

/**
 * Thrown when a pause is requested on a plan that is already paused. Routes
 * and jobs treat this as a deterministic, user-fixable condition (resume
 * first), never as a transient failure to retry.
 */
export class AlreadyPausedError extends Error {
  constructor(message = "This treatment plan is already paused — resume it before starting a new pause.") {
    super(message);
    this.name = "AlreadyPausedError";
  }
}

/**
 * PURE (exported for unit tests) — does this error mean Shopify rejected
 * subscriptionContractPause because the contract is ALREADY paused? That is
 * the desired end state, so pauseUntil treats it as success: retrying the
 * mutation after a half-committed run (paused remotely, pausedUntil never
 * stamped) must self-heal instead of failing forever on the userError.
 */
export function isAlreadyPausedUserError(error: unknown): boolean {
  // Deliberately narrow: match only phrasings asserting the contract IS
  // paused ("already paused", "is paused", "currently paused") — never
  // "cannot be paused" (e.g. cancelled contracts), which is a real failure.
  return (
    error instanceof ShopifyGraphqlError &&
    (error.userErrors ?? []).some((e) =>
      /(already|is|currently)\s+paused/i.test(e.message),
    )
  );
}

/**
 * Thrown by removeLineFromContract({keepOne: true}) when removing the line
 * would leave the plan empty. The portal passes keepOne so concurrent
 * removals from two tabs cannot race the plan down to zero lines (a dead but
 * still-billed contract); the CS console keeps its unrestricted behaviour.
 */
export class KeepOneLineError extends Error {
  constructor(
    message = "Your plan keeps at least one product — swap it instead of removing the last one.",
  ) {
    super(message);
    this.name = "KeepOneLineError";
  }
}

/**
 * Who initiated a schedule change. Non-CUSTOMER sources are stamped into the
 * SHIPMENT_DELAYED / ORDER_SKIPPED event payloads so the churn model can
 * exclude retention-driven interventions from its "customer is disengaging"
 * signals (otherwise accepting a suggested delay RAISES the churn score).
 */
export type ScheduleChangeSource = "CUSTOMER" | "STAFF" | "SAVE_OFFER" | "AUTOPILOT" | "SYSTEM";

// ─────────────────────────── GraphQL result shapes ─────────────────────────

interface UserError {
  field?: string[] | null;
  message: string;
}

interface ShopifyContractPayload {
  id: string;
  status: string;
  createdAt: string;
  nextBillingDate: string | null;
  note: string | null;
  customAttributes: Array<{ key: string; value: string | null }>;
  currencyCode: string;
  customer: { id: string; email: string | null } | null;
  customerPaymentMethod: {
    id: string;
    instrument: {
      brand?: string | null;
      lastDigits?: string | null;
      expiryMonth?: number | null;
      expiryYear?: number | null;
    } | null;
  } | null;
  billingPolicy: { interval: string; intervalCount: number };
  deliveryPolicy: { interval: string; intervalCount: number };
  deliveryMethod: {
    address?: Record<string, string | null> | null;
  } | null;
  originOrder: {
    id: string;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  } | null;
  lines: {
    edges: Array<{
      node: {
        id: string;
        productId: string | null;
        variantId: string | null;
        title: string;
        quantity: number;
        currentPrice: { amount: string; currencyCode: string };
        sellingPlanId: string | null;
        sellingPlanName: string | null;
      };
    }>;
  };
}

interface GetContractResult {
  subscriptionContract: ShopifyContractPayload | null;
}

export interface DeliveryAddressInput {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  countryCode?: string | null;
  zip?: string | null;
  phone?: string | null;
}

// ─────────────────────────── Local helpers ─────────────────────────────────

async function getLocalContract(
  shop: string,
  contractId: string,
): Promise<SubscriptionContract> {
  return prisma.subscriptionContract.findFirstOrThrow({
    where: { id: contractId, shop },
  });
}

async function getLocalLine(contractId: string, lineId: string) {
  const line = await prisma.contractLine.findFirst({
    where: { id: lineId, contractId },
  });
  if (!line) {
    throw new Error(
      `Contract line ${lineId} not found on contract ${contractId}`,
    );
  }
  if (!line.shopifyLineId) {
    throw new Error(
      `Contract line ${lineId} has no Shopify line id yet — re-sync the contract first`,
    );
  }
  return line;
}

/** Fetch the full contract payload from Shopify (throws when missing). */
export async function fetchShopifyContract(
  graphql: AdminGraphql,
  shopifyContractId: string,
): Promise<ShopifyContractPayload> {
  const data = await runGraphql<GetContractResult>(graphql, GET_CONTRACT_QUERY, {
    id: shopifyContractId,
  });
  if (!data.subscriptionContract) {
    throw new Error(`Shopify contract not found: ${shopifyContractId}`);
  }
  return data.subscriptionContract;
}

/** Open a draft on the contract, run `edit`, commit. */
async function withDraft(
  graphql: AdminGraphql,
  shopifyContractId: string,
  edit: (draftId: string) => Promise<void>,
): Promise<void> {
  const open = await runGraphql<{
    subscriptionContractUpdate: {
      draft: { id: string } | null;
      userErrors: UserError[];
    };
  }>(graphql, SUBSCRIPTION_CONTRACT_UPDATE_MUTATION, {
    contractId: shopifyContractId,
  });
  assertNoUserErrors(
    "subscriptionContractUpdate",
    open.subscriptionContractUpdate.userErrors,
  );
  const draftId = open.subscriptionContractUpdate.draft?.id;
  if (!draftId) {
    throw new Error("subscriptionContractUpdate returned no draft id");
  }

  await edit(draftId);

  const commit = await runGraphql<{
    subscriptionDraftCommit: {
      contract: { id: string } | null;
      userErrors: UserError[];
    };
  }>(graphql, SUBSCRIPTION_DRAFT_COMMIT_MUTATION, { draftId });
  assertNoUserErrors(
    "subscriptionDraftCommit",
    commit.subscriptionDraftCommit.userErrors,
  );
}

async function variantPriceCents(
  graphql: AdminGraphql,
  variantGid: string,
): Promise<{ priceCents: number; title: string; productId: string }> {
  const data = await runGraphql<{
    productVariant: {
      id: string;
      title: string;
      price: string;
      product: { id: string; title: string };
    } | null;
  }>(graphql, GET_VARIANT_QUERY, { id: variantGid });
  if (!data.productVariant) {
    throw new Error(`Product variant not found: ${variantGid}`);
  }
  return {
    priceCents: toCents(data.productVariant.price),
    title: data.productVariant.product.title,
    productId: data.productVariant.product.id,
  };
}

/**
 * Public variant lookup (price in cents, product title + gid) for callers
 * that must validate a customer-chosen variant before executing a contract
 * edit (e.g. the cancel-flow swap offer verifying the chosen variant really
 * belongs to an advertised candidate product).
 */
export async function getVariantInfo(
  graphql: AdminGraphql,
  variantGid: string,
): Promise<{ priceCents: number; title: string; productId: string }> {
  return variantPriceCents(graphql, variantGid);
}

/** ISO version token for A→B→A-safe edit keys (see contractOpKey). */
function editVersion(contract: SubscriptionContract): string {
  return contract.updatedAt.toISOString();
}

/**
 * The plan discount (percent off retail) this contract's lines are priced
 * under: the attributed checkout discount first, else the percentOff of the
 * selling plan the (preferred) line signed up with, else null. Used so swaps
 * and added lines keep subscriber pricing instead of reverting to retail.
 */
async function contractPlanDiscountPercent(
  contract: SubscriptionContract,
  preferredSellingPlanId?: string | null,
): Promise<number | null> {
  const attributed = contract.initialDiscountPercent;
  if (
    attributed != null &&
    Number.isFinite(attributed) &&
    attributed > 0 &&
    attributed < 100
  ) {
    return attributed;
  }

  let sellingPlanId = preferredSellingPlanId ?? null;
  if (!sellingPlanId) {
    const line = await prisma.contractLine.findFirst({
      where: { contractId: contract.id, sellingPlanId: { not: null } },
      select: { sellingPlanId: true },
    });
    sellingPlanId = line?.sellingPlanId ?? null;
  }
  if (!sellingPlanId) return null;

  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shop: contract.shop },
    select: { plansJson: true },
  });
  for (const config of configs) {
    const plans = parseJson<
      Array<{ percentOff?: number; shopifyPlanId?: string | null }>
    >(config.plansJson, []);
    const match = plans.find(
      (p) => p.shopifyPlanId != null && p.shopifyPlanId === sellingPlanId,
    );
    if (
      match &&
      typeof match.percentOff === "number" &&
      Number.isFinite(match.percentOff)
    ) {
      return match.percentOff;
    }
  }
  return null;
}

interface OpContext {
  shop: string;
  contract: SubscriptionContract;
  action: ContractAction;
  actor?: Actor | string | null;
  payload?: Record<string, unknown>;
}

/**
 * Audit + re-sync after a successful Shopify mutation.
 *
 * Runs strictly AFTER the mutation committed on Shopify, inside the
 * withIdempotency closure. A throw here would release the idempotency guard
 * and let a retry re-issue the already-committed mutation (duplicate add-on
 * lines, double credits) — so post-commit bookkeeping failures are contained:
 * log, fall back to the locally known contract, and let the reconcile job
 * converge the mirror.
 */
async function finalizeOp(
  graphql: AdminGraphql,
  ctx: OpContext,
): Promise<SubscriptionContract> {
  const actor = normalizeActor(ctx.actor);
  try {
    await appendAudit({
      shop: ctx.shop,
      actorType: actor.type,
      actorId: actor.id,
      action: ctx.action,
      subjectType: "SubscriptionContract",
      subjectId: ctx.contract.id,
      payload: ctx.payload,
    });
    return await syncContractFromShopify(
      graphql,
      ctx.shop,
      ctx.contract.shopifyContractId,
    );
  } catch (error) {
    logger.error("finalizeOp post-commit bookkeeping failed", {
      shop: ctx.shop,
      contractId: ctx.contract.id,
      action: ctx.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return ctx.contract;
  }
}

// ─────────────────────────── Mirror sync ───────────────────────────────────

/**
 * Query the full contract from Shopify and upsert the local mirror
 * (SubscriptionContract + ContractLine rows). The mirror is the read model
 * for the whole app; call this after EVERY commit.
 */
export async function syncContractFromShopify(
  graphql: AdminGraphql,
  shop: string,
  shopifyContractId: string,
): Promise<SubscriptionContract> {
  const remote = await fetchShopifyContract(graphql, shopifyContractId);

  const status = mapShopifyContractStatus(remote.status);
  const intervalWeeks = intervalToWeeks(
    remote.deliveryPolicy.interval as "DAY" | "WEEK" | "MONTH" | "YEAR",
    remote.deliveryPolicy.intervalCount,
  );
  const nextBillingDate = remote.nextBillingDate
    ? new Date(remote.nextBillingDate)
    : null;
  const address = remote.deliveryMethod?.address ?? null;
  const instrument = remote.customerPaymentMethod?.instrument ?? null;

  const common = {
    shop,
    shopifyCustomerId: remote.customer?.id ?? "",
    // Normalised at ingestion: Shopify preserves checkout casing
    // ("Marie.Dupont@Gmail.com"), and the portal's magic-link lookup matches
    // the lowercase form — a verbatim mixed-case store would lock the
    // customer out of the portal forever.
    customerEmail: remote.customer?.email?.toLowerCase() ?? null,
    status,
    currencyCode: remote.currencyCode,
    intervalWeeks,
    nextBillingDate,
    // Shopify exposes one schedule; delivery follows billing (documented).
    nextDeliveryDate: nextBillingDate,
    deliveryAddressJson: address ? JSON.stringify(address) : null,
    paymentMethodId: remote.customerPaymentMethod?.id ?? null,
    cardBrand: instrument?.brand ?? null,
    cardLastDigits: instrument?.lastDigits ?? null,
    cardExpiryMonth: instrument?.expiryMonth ?? null,
    cardExpiryYear: instrument?.expiryYear ?? null,
  };

  let contract = await prisma.subscriptionContract.upsert({
    where: { shopifyContractId },
    update: common,
    create: {
      ...common,
      shopifyContractId,
      treatmentStartedAt: new Date(remote.createdAt),
      originOrderId: remote.originOrder?.id ?? null,
    },
  });

  // Cancellations made OUTSIDE the app (Shopify admin, native customer
  // portal, another app, Shopify marking the contract EXPIRED) arrive here
  // with a terminal status but would otherwise never get cancelledAt — which
  // overstates netGrowth and keeps dead contracts in every churn denominator
  // forever. Stamp them once (cancelledAt: null guard = idempotent across
  // webhook replays). App-initiated paths are unaffected: cancelContract /
  // mergeContracts overwrite these fields with their own values right after
  // their sync, and resumeContract clears them after its sync.
  if (status === "CANCELLED" || status === "EXPIRED") {
    const stamped = await prisma.subscriptionContract.updateMany({
      where: { shopifyContractId, cancelledAt: null },
      data: { cancelledAt: new Date(), cancelReason: "EXTERNAL" },
    });
    if (stamped.count > 0) {
      contract = await prisma.subscriptionContract.findUniqueOrThrow({
        where: { shopifyContractId },
      });
    }
  }

  // Lines: upsert by shopifyLineId, drop lines that no longer exist remotely.
  const remoteLines = remote.lines.edges.map((e) => e.node);
  const remoteLineIds = remoteLines.map((l) => l.id);
  const localLines = await prisma.contractLine.findMany({
    where: { contractId: contract.id },
  });

  for (const node of remoteLines) {
    const data = {
      shopifyProductId: node.productId ?? "",
      shopifyVariantId: node.variantId ?? "",
      title: node.title,
      quantity: node.quantity,
      currentPriceCents: toCents(node.currentPrice.amount),
      sellingPlanId: node.sellingPlanId,
      sellingPlanName: node.sellingPlanName,
    };
    const existing = localLines.find((l) => l.shopifyLineId === node.id);
    if (existing) {
      await prisma.contractLine.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await prisma.contractLine.create({
        data: { ...data, contractId: contract.id, shopifyLineId: node.id },
      });
    }
  }

  const stale = localLines.filter(
    (l) => l.shopifyLineId && !remoteLineIds.includes(l.shopifyLineId),
  );
  if (stale.length > 0) {
    const staleIds = stale.map((l) => l.id);
    await prisma.depletionEstimate.deleteMany({
      where: { contractLineId: { in: staleIds } },
    });
    await prisma.contractLine.deleteMany({ where: { id: { in: staleIds } } });
  }

  logger.info("contract synced", {
    shop,
    shopifyContractId,
    status,
    lines: remoteLines.length,
  });
  return contract;
}

// ─────────────────────────── Line operations ───────────────────────────────

export async function updateLineQuantity(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  lineId: string,
  quantity: number,
): Promise<SubscriptionContract> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be a whole number of at least 1");
  }
  const contract = await getLocalContract(shop, contractId);
  const line = await getLocalLine(contractId, lineId);
  const key = contractOpKey(
    contractId,
    "CHANGE_QUANTITY",
    { lineId, quantity },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftLineUpdate: {
            lineUpdated: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_LINE_UPDATE_MUTATION, {
          draftId,
          lineId: line.shopifyLineId,
          input: { quantity },
        });
        assertNoUserErrors(
          "subscriptionDraftLineUpdate",
          data.subscriptionDraftLineUpdate.userErrors,
        );
      });
      const synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "CHANGE_QUANTITY",
        payload: { lineId, from: line.quantity, to: quantity },
      });
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function swapLineVariant(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  lineId: string,
  newVariantGid: string,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const line = await getLocalLine(contractId, lineId);
  const key = contractOpKey(
    contractId,
    "CHANGE_VARIANT",
    { lineId, newVariantGid },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const variant = await variantPriceCents(graphql, newVariantGid);
      // Mirror line prices are the already-discounted subscriber prices —
      // committing the raw retail price here would silently strip the plan
      // discount from this line on every future cycle.
      const discountPercent = await contractPlanDiscountPercent(
        contract,
        line.sellingPlanId,
      );
      const subscriberPriceCents = planAdjustedPriceCents(
        discountPercent,
        variant.priceCents,
      );
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftLineUpdate: {
            lineUpdated: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_LINE_UPDATE_MUTATION, {
          draftId,
          lineId: line.shopifyLineId,
          input: {
            productVariantId: newVariantGid,
            currentPrice: centsToDecimalString(subscriberPriceCents),
          },
        });
        assertNoUserErrors(
          "subscriptionDraftLineUpdate",
          data.subscriptionDraftLineUpdate.userErrors,
        );
      });
      return finalizeOp(graphql, {
        shop,
        contract,
        action: "CHANGE_VARIANT",
        payload: {
          lineId,
          fromVariantId: line.shopifyVariantId,
          toVariantId: newVariantGid,
          retailPriceCents: variant.priceCents,
          subscriberPriceCents,
          discountPercent,
        },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function addLineToContract(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  input: { variantGid: string; quantity: number; priceCents?: number },
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const key = contractOpKey(
    contractId,
    "ADD_PRODUCT",
    input,
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const variant = await variantPriceCents(graphql, input.variantGid);
      // Default to the SUBSCRIBER price (plan discount applied) — a line added
      // to a plan joins the plan's pricing; callers may still pass an explicit
      // priceCents (e.g. zero-priced retention gifts).
      const priceCents =
        input.priceCents ??
        planAdjustedPriceCents(
          await contractPlanDiscountPercent(contract),
          variant.priceCents,
        );
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftLineAdd: {
            lineAdded: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_LINE_ADD_MUTATION, {
          draftId,
          input: {
            productVariantId: input.variantGid,
            quantity: input.quantity,
            currentPrice: centsToDecimalString(priceCents),
          },
        });
        assertNoUserErrors(
          "subscriptionDraftLineAdd",
          data.subscriptionDraftLineAdd.userErrors,
        );
      });
      const synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "ADD_PRODUCT",
        payload: { ...input, priceCents },
      });
      await emitLifecycleEvent({
        shop,
        name: "PRODUCT_ADDED",
        contractId: contract.id,
        shopifyCustomerId: synced.shopifyCustomerId,
        email: synced.customerEmail,
        payload: {
          variantId: input.variantGid,
          productTitle: variant.title,
          quantity: input.quantity,
          priceCents,
        },
      });
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function removeLineFromContract(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  lineId: string,
  opts?: { keepOne?: boolean },
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const line = await getLocalLine(contractId, lineId);
  const key = contractOpKey(
    contractId,
    "REMOVE_PRODUCT",
    { lineId },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      if (opts?.keepOne) {
        // Re-count against Shopify (not the mirror snapshot): two concurrent
        // removals both passing a stale local count is exactly the race that
        // empties a plan.
        const remote = await fetchShopifyContract(
          graphql,
          contract.shopifyContractId,
        );
        if (remote.lines.edges.length <= 1) {
          throw new KeepOneLineError();
        }
      }
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftLineRemove: {
            lineRemoved: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION, {
          draftId,
          lineId: line.shopifyLineId,
        });
        assertNoUserErrors(
          "subscriptionDraftLineRemove",
          data.subscriptionDraftLineRemove.userErrors,
        );
      });
      const synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "REMOVE_PRODUCT",
        payload: { lineId, title: line.title, variantId: line.shopifyVariantId },
      });
      await emitLifecycleEvent({
        shop,
        name: "PRODUCT_REMOVED",
        contractId: contract.id,
        shopifyCustomerId: synced.shopifyCustomerId,
        email: synced.customerEmail,
        payload: { productTitle: line.title, variantId: line.shopifyVariantId },
      });
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

// ─────────────────────────── Schedule operations ───────────────────────────

async function setNextBillingDateInternal(
  graphql: AdminGraphql,
  shop: string,
  contract: SubscriptionContract,
  date: Date,
  action: ContractAction,
  payload: Record<string, unknown>,
): Promise<SubscriptionContract> {
  const key = contractOpKey(
    contract.id,
    action,
    { date: date.toISOString() },
    editVersion(contract),
  );
  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const data = await runGraphql<{
        subscriptionContractSetNextBillingDate: {
          contract: { id: string } | null;
          userErrors: UserError[];
        };
      }>(graphql, SUBSCRIPTION_CONTRACT_SET_NEXT_BILLING_DATE_MUTATION, {
        contractId: contract.shopifyContractId,
        date: date.toISOString(),
      });
      assertNoUserErrors(
        "subscriptionContractSetNextBillingDate",
        data.subscriptionContractSetNextBillingDate.userErrors,
      );
      return finalizeOp(graphql, { shop, contract, action, payload });
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function setNextBillingDate(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  date: Date,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  return setNextBillingDateInternal(
    graphql,
    shop,
    contract,
    date,
    "CHANGE_BILLING_DATE",
    { from: contract.nextBillingDate?.toISOString(), to: date.toISOString() },
  );
}

export async function skipNextShipment(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  opts?: { source?: ScheduleChangeSource },
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  if (!contract.nextBillingDate) {
    throw new Error("This treatment plan has no upcoming delivery to skip");
  }
  const source: ScheduleChangeSource = opts?.source ?? "CUSTOMER";
  const cycleDate = contract.nextBillingDate.toISOString();
  const key = contractOpKey(
    contractId,
    "SKIP_SHIPMENT",
    { cycleDate },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const data = await runGraphql<{
        subscriptionBillingCycleSkip: {
          billingCycle: { cycleIndex: number; skipped: boolean } | null;
          userErrors: UserError[];
        };
      }>(graphql, SUBSCRIPTION_BILLING_CYCLE_SKIP_MUTATION, {
        billingCycleInput: {
          contractId: contract.shopifyContractId,
          selector: { date: cycleDate },
        },
      });
      assertNoUserErrors(
        "subscriptionBillingCycleSkip",
        data.subscriptionBillingCycleSkip.userErrors,
      );
      const synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "SKIP_SHIPMENT",
        payload: {
          skippedCycleDate: cycleDate,
          cycleIndex: data.subscriptionBillingCycleSkip.billingCycle?.cycleIndex,
        },
      });
      await emitLifecycleEvent({
        shop,
        name: "ORDER_SKIPPED",
        contractId: contract.id,
        shopifyCustomerId: synced.shopifyCustomerId,
        email: synced.customerEmail,
        payload: {
          skippedCycleDate: cycleDate,
          nextBillingDate: synced.nextBillingDate?.toISOString() ?? null,
          source,
        },
      });
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function delayByWeeks(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  weeks: number,
  opts?: { source?: ScheduleChangeSource },
): Promise<SubscriptionContract> {
  if (!Number.isFinite(weeks) || weeks < 1) {
    throw new Error("Delay must be at least one week");
  }
  const source: ScheduleChangeSource = opts?.source ?? "CUSTOMER";
  const contract = await getLocalContract(shop, contractId);
  const base = contract.nextBillingDate ?? new Date();
  const newDate = addWeeks(base, weeks);
  const synced = await setNextBillingDateInternal(
    graphql,
    shop,
    contract,
    newDate,
    "DELAY_WEEKS",
    { weeks, from: contract.nextBillingDate?.toISOString(), to: newDate.toISOString() },
  );
  await emitLifecycleEvent({
    shop,
    name: "SHIPMENT_DELAYED",
    contractId: contract.id,
    shopifyCustomerId: synced.shopifyCustomerId,
    email: synced.customerEmail,
    payload: { weeks, newDate: newDate.toISOString(), source },
  });
  return synced;
}

export async function bringForward(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  date: Date,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  if (contract.nextBillingDate && date >= contract.nextBillingDate) {
    throw new Error(
      "Bring-forward date must be earlier than the current next delivery date",
    );
  }
  return setNextBillingDateInternal(graphql, shop, contract, date, "BRING_FORWARD", {
    from: contract.nextBillingDate?.toISOString(),
    to: date.toISOString(),
  });
}

// ─────────────────────────── Pause / resume / cancel ───────────────────────

export async function pauseUntil(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  resumeDate: Date,
  // emitEvent defaults to true; system-driven pauses that must not count as
  // customer pause behaviour (dunning grace pause) pass { emitEvent: false }
  // and emit their own distinctly named event — same pattern as cancelContract.
  opts?: { emitEvent?: boolean },
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  // Pause-while-paused guard: pausing an already-paused plan would silently
  // overwrite its resume date (a 90-day pause "shortened" to 30 by an admin
  // one-click, or vice versa). Resume first, then pause again.
  if (contract.status === "PAUSED" && contract.pausedUntil != null) {
    throw new AlreadyPausedError();
  }
  const key = contractOpKey(
    contractId,
    "PAUSE_UNTIL",
    { resumeDate: resumeDate.toISOString() },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      // Orphan self-heal: a prior run may have committed the Shopify pause
      // (mirror synced to PAUSED) and then died before stamping pausedUntil —
      // the state runPauseResumeJob can never resume ("a silent
      // cancellation"). The guard above only throws for PAUSED with a
      // pausedUntil, so status PAUSED here means exactly that half-committed
      // state (or an external pause): skip the mutation — re-running it dies
      // on Shopify's "already paused" userError and wedges every retry before
      // the pausedUntil write — and just finish the local half.
      if (contract.status !== "PAUSED") {
        try {
          const data = await runGraphql<{
            subscriptionContractPause: {
              contract: { id: string; status: string } | null;
              userErrors: UserError[];
            };
          }>(graphql, SUBSCRIPTION_CONTRACT_PAUSE_MUTATION, {
            subscriptionContractId: contract.shopifyContractId,
          });
          assertNoUserErrors(
            "subscriptionContractPause",
            data.subscriptionContractPause.userErrors,
          );
        } catch (error) {
          // "Already paused" from Shopify = the desired state already holds
          // (half-committed retry racing the mirror, or an external pause).
          // Treat as success so the retry heals instead of wedging.
          if (!isAlreadyPausedUserError(error)) throw error;
          logger.info("pauseUntil: contract already paused on Shopify", {
            shop,
            contractId,
          });
        }
      }
      let synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "PAUSE_UNTIL",
        payload: { resumeDate: resumeDate.toISOString() },
      });
      // Atomic conditional stamp: two pause paths racing within one mutation
      // round-trip (a dunning grace pause vs a portal pause accept) can BOTH
      // reach this point — the entry guard only saw the mirror loaded at
      // function start, and the "already paused" self-heal above treats the
      // winner's committed pause as success. An unconditional update would
      // let the loser silently overwrite the winner's resume date (the exact
      // overwrite the entry guard forbids). Only a row still missing a
      // resume date may be stamped (genuine orphan/external-pause heals);
      // the loser throws AlreadyPausedError BEFORE the PAUSE_STARTED emit —
      // withIdempotency releases the key and every caller already handles
      // the error deterministically (dunning skips past the step, portal /
      // admin surface the resume-first message).
      const stamped = await prisma.subscriptionContract.updateMany({
        where: { id: contract.id, pausedUntil: null },
        data: { pausedUntil: resumeDate },
      });
      if (stamped.count === 0) {
        throw new AlreadyPausedError();
      }
      synced = await prisma.subscriptionContract.findUniqueOrThrow({
        where: { id: contract.id },
      });
      if (opts?.emitEvent !== false) {
        await emitLifecycleEvent({
          shop,
          name: "PAUSE_STARTED",
          contractId: contract.id,
          shopifyCustomerId: synced.shopifyCustomerId,
          email: synced.customerEmail,
          payload: { resumeDate: resumeDate.toISOString() },
        });
      }
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

/** Resume a paused plan; also the reactivation path after cancel/failure. */
export async function resumeContract(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const key = contractOpKey(
    contractId,
    "REACTIVATE",
    { fromStatus: contract.status },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const data = await runGraphql<{
        subscriptionContractActivate: {
          contract: { id: string; status: string } | null;
          userErrors: UserError[];
        };
      }>(graphql, SUBSCRIPTION_CONTRACT_ACTIVATE_MUTATION, {
        subscriptionContractId: contract.shopifyContractId,
      });
      assertNoUserErrors(
        "subscriptionContractActivate",
        data.subscriptionContractActivate.userErrors,
      );
      let synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "REACTIVATE",
        payload: { fromStatus: contract.status },
      });
      synced = await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { pausedUntil: null, cancelledAt: null, cancelReason: null },
      });
      // Reactivation metric: emit only for genuine pause-resumes — this
      // function is also the post-cancel reactivation path, so gate on the
      // pre-call state. (PAUSE_ENDING remains the "pause ends soon" reminder
      // trigger; PAUSE_ENDED is the actual resume.)
      if (contract.status === "PAUSED" || contract.pausedUntil != null) {
        await emitLifecycleEvent({
          shop,
          name: "PAUSE_ENDED",
          contractId: contract.id,
          shopifyCustomerId: synced.shopifyCustomerId,
          email: synced.customerEmail,
          payload: { fromStatus: contract.status },
        });
      }
      // Resolve any live dunning episode inline (no import from retention —
      // dunning.server.ts imports this module): a reactivated contract must
      // not have a scheduled PAUSE/CANCEL step fire against it later.
      await prisma.dunningState.updateMany({
        where: {
          contractId: contract.id,
          phase: { in: ["RETRYING", "GRACE", "FINAL_NOTICE"] },
        },
        data: { phase: "RESOLVED", nextRetryAt: null, graceUntil: null },
      });
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function cancelContract(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  // CancelReason for voluntary churn; free-form for system cancels
  // (e.g. "PAYMENT_FAILURE" from dunning) — analytics separates the two.
  reason: CancelReason | (string & {}),
  actor: Actor | string,
  // emitEvent defaults to true; callers that emit their own richer
  // CANCELLATION_COMPLETED (portal finalize) or must not count as voluntary
  // churn (dunning) pass { emitEvent: false }.
  opts?: { emitEvent?: boolean },
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const key = contractOpKey(
    contractId,
    "CANCEL",
    { reason },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const data = await runGraphql<{
        subscriptionContractCancel: {
          contract: { id: string; status: string } | null;
          userErrors: UserError[];
        };
      }>(graphql, SUBSCRIPTION_CONTRACT_CANCEL_MUTATION, {
        subscriptionContractId: contract.shopifyContractId,
      });
      try {
        assertNoUserErrors(
          "subscriptionContractCancel",
          data.subscriptionContractCancel.userErrors,
        );
      } catch (e) {
        // Convergence: a retry after a post-commit blip (or an out-of-band
        // cancel) hits Shopify's "already cancelled" userError even though
        // the desired end state is reached. Verify against the LIVE remote
        // status — never the message text — and proceed as success so
        // finalize retries converge instead of erroring forever.
        if (!(e instanceof ShopifyGraphqlError)) throw e;
        const remote = await fetchShopifyContract(
          graphql,
          contract.shopifyContractId,
        );
        if (mapShopifyContractStatus(remote.status) !== "CANCELLED") throw e;
      }
      let synced = await finalizeOp(graphql, {
        shop,
        contract,
        action: "CANCEL",
        actor,
        payload: { reason },
      });
      synced = await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { cancelledAt: new Date(), cancelReason: reason },
      });
      if (opts?.emitEvent !== false) {
        await emitLifecycleEvent({
          shop,
          name: "CANCELLATION_COMPLETED",
          contractId: contract.id,
          shopifyCustomerId: synced.shopifyCustomerId,
          email: synced.customerEmail,
          payload: { reason },
        });
      }
      return synced;
    },
    EDIT_TTL_MS,
  );
  return result;
}

// ─────────────────────────── Cadence / address / payment ───────────────────

export async function switchCadence(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  intervalWeeks: number,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const policy = weeksToInterval(intervalWeeks);
  const key = contractOpKey(
    contractId,
    "SWITCH_CADENCE",
    policy,
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftUpdate: {
            draft: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_UPDATE_MUTATION, {
          draftId,
          input: {
            billingPolicy: policy,
            deliveryPolicy: policy,
          },
        });
        assertNoUserErrors(
          "subscriptionDraftUpdate",
          data.subscriptionDraftUpdate.userErrors,
        );
      });
      return finalizeOp(graphql, {
        shop,
        contract,
        action: "SWITCH_CADENCE",
        payload: { fromWeeks: contract.intervalWeeks, toWeeks: policy.intervalCount },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function updateDeliveryAddress(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  address: DeliveryAddressInput,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const key = contractOpKey(
    contractId,
    "CHANGE_ADDRESS",
    address,
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftUpdate: {
            draft: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_UPDATE_MUTATION, {
          draftId,
          input: { deliveryMethod: { shipping: { address } } },
        });
        assertNoUserErrors(
          "subscriptionDraftUpdate",
          data.subscriptionDraftUpdate.userErrors,
        );
      });
      return finalizeOp(graphql, {
        shop,
        contract,
        action: "CHANGE_ADDRESS",
        payload: { city: address.city, countryCode: address.countryCode },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

export async function sendPaymentUpdateEmail(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  if (!contract.paymentMethodId) {
    throw new Error(
      "No payment method on file for this treatment plan — re-sync the contract first",
    );
  }
  const key = contractOpKey(contractId, "UPDATE_PAYMENT_METHOD", {
    paymentMethodId: contract.paymentMethodId,
    day: new Date().toISOString().slice(0, 10),
  });

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const data = await runGraphql<{
        customerPaymentMethodSendUpdateEmail: {
          customer: { id: string } | null;
          userErrors: UserError[];
        };
      }>(graphql, CUSTOMER_PAYMENT_METHOD_SEND_UPDATE_EMAIL_MUTATION, {
        customerPaymentMethodId: contract.paymentMethodId,
      });
      assertNoUserErrors(
        "customerPaymentMethodSendUpdateEmail",
        data.customerPaymentMethodSendUpdateEmail.userErrors,
      );
      return finalizeOp(graphql, {
        shop,
        contract,
        action: "UPDATE_PAYMENT_METHOD",
        payload: { paymentMethodId: contract.paymentMethodId },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

// ─────────────────────────── Credit / merge / split ────────────────────────

/**
 * Account credit = a one-cycle fixed-amount manual discount on the next order.
 */
export async function applyAccountCredit(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  amountCents: number,
): Promise<SubscriptionContract> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Credit amount must be a positive whole number of cents");
  }
  const contract = await getLocalContract(shop, contractId);
  // Double-click protection only (EDIT_TTL_MS window) — a legitimate second
  // credit of the same amount later the same day must go through, so the key
  // deliberately carries no date component; the mirror version token means a
  // second credit after the first one commits gets a fresh key anyway.
  const key = contractOpKey(
    contractId,
    "APPLY_CREDIT",
    { amountCents },
    editVersion(contract),
  );

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
        const data = await runGraphql<{
          subscriptionDraftDiscountAdd: {
            discountAdded: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_DRAFT_DISCOUNT_ADD_MUTATION, {
          draftId,
          input: {
            title: "Account credit",
            recurringCycleLimit: 1,
            value: {
              fixedAmount: {
                amount: centsToDecimalString(amountCents),
                appliesOnEachItem: false,
              },
            },
          },
        });
        assertNoUserErrors(
          "subscriptionDraftDiscountAdd",
          data.subscriptionDraftDiscountAdd.userErrors,
        );
      });
      return finalizeOp(graphql, {
        shop,
        contract,
        action: "APPLY_CREDIT",
        payload: { amountCents, cycles: 1 },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

/**
 * Merge: copy every line of each source contract onto the target, then cancel
 * the sources. The customer keeps one consolidated delivery.
 */
export async function mergeContracts(
  graphql: AdminGraphql,
  shop: string,
  targetContractId: string,
  sourceContractIds: string[],
): Promise<SubscriptionContract> {
  const target = await getLocalContract(shop, targetContractId);
  const sources = await Promise.all(
    sourceContractIds.map((id) => getLocalContract(shop, id)),
  );
  const key = contractOpKey(targetContractId, "MERGE_CONTRACTS", {
    sourceContractIds,
  });

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const sourceLines = await prisma.contractLine.findMany({
        where: { contractId: { in: sourceContractIds } },
      });
      // Re-run safety: a prior invocation may have committed the draft before
      // failing (e.g. while cancelling a source). Skip any source line already
      // represented on the remote target so a retry never duplicates lines.
      const remoteTarget = await fetchShopifyContract(
        graphql,
        target.shopifyContractId,
      );
      const lineKey = (variantId: string | null, quantity: number, priceCents: number) =>
        `${variantId}|${quantity}|${priceCents}`;
      const existingLines = new Map<string, number>();
      for (const edge of remoteTarget.lines.edges) {
        const node = edge.node;
        const k = lineKey(node.variantId, node.quantity, toCents(node.currentPrice.amount));
        existingLines.set(k, (existingLines.get(k) ?? 0) + 1);
      }
      const linesToAdd = sourceLines.filter((line) => {
        const k = lineKey(line.shopifyVariantId, line.quantity, line.currentPriceCents);
        const count = existingLines.get(k) ?? 0;
        if (count > 0) {
          existingLines.set(k, count - 1);
          return false;
        }
        return true;
      });
      if (linesToAdd.length > 0) {
        await withDraft(graphql, target.shopifyContractId, async (draftId) => {
          for (const line of linesToAdd) {
            const data = await runGraphql<{
              subscriptionDraftLineAdd: {
                lineAdded: { id: string } | null;
                userErrors: UserError[];
              };
            }>(graphql, SUBSCRIPTION_DRAFT_LINE_ADD_MUTATION, {
              draftId,
              input: {
                productVariantId: line.shopifyVariantId,
                quantity: line.quantity,
                currentPrice: centsToDecimalString(line.currentPriceCents),
              },
            });
            assertNoUserErrors(
              "subscriptionDraftLineAdd",
              data.subscriptionDraftLineAdd.userErrors,
            );
          }
        });
      }

      for (const source of sources) {
        // Re-run safety: skip the cancel when a prior invocation already
        // cancelled this source, but still converge the local mirror below.
        const remoteSource = await fetchShopifyContract(
          graphql,
          source.shopifyContractId,
        );
        if (remoteSource.status !== "CANCELLED") {
          const cancel = await runGraphql<{
            subscriptionContractCancel: {
              contract: { id: string; status: string } | null;
              userErrors: UserError[];
            };
          }>(graphql, SUBSCRIPTION_CONTRACT_CANCEL_MUTATION, {
            subscriptionContractId: source.shopifyContractId,
          });
          assertNoUserErrors(
            "subscriptionContractCancel",
            cancel.subscriptionContractCancel.userErrors,
          );
        }
        await syncContractFromShopify(graphql, shop, source.shopifyContractId);
        // "MERGED" (never "OTHER"): the customer and their revenue continue
        // on the target contract, so analytics must not book this as churn —
        // metrics/cohorts/survival exclude MERGED from cancellation counts.
        // Deliberately NOT in the customer-facing CANCEL_REASONS union.
        await prisma.subscriptionContract.update({
          where: { id: source.id },
          data: { cancelledAt: new Date(), cancelReason: "MERGED" },
        });
        await appendAudit({
          shop,
          actorType: "SYSTEM",
          action: "MERGE_CONTRACTS",
          subjectType: "SubscriptionContract",
          subjectId: source.id,
          payload: { mergedInto: target.id },
        });
      }

      return finalizeOp(graphql, {
        shop,
        contract: target,
        action: "MERGE_CONTRACTS",
        payload: { sourceContractIds, linesMoved: sourceLines.length },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}

/**
 * Split: move the given lines onto a brand-new contract that copies the
 * source's schedule, payment method and delivery address
 * (subscriptionContractAtomicCreate), then remove them from the source.
 * Returns the refreshed source contract.
 */
export async function splitContract(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  lineIdsToSplit: string[],
): Promise<SubscriptionContract> {
  const contract = await getLocalContract(shop, contractId);
  const lines = await Promise.all(
    lineIdsToSplit.map((lineId) => getLocalLine(contractId, lineId)),
  );
  if (lines.length === 0) {
    throw new Error("Select at least one product to move to its own delivery");
  }
  const allLines = await prisma.contractLine.count({ where: { contractId } });
  if (lines.length >= allLines) {
    throw new Error("Cannot split every product off — the plan would be empty");
  }
  const key = contractOpKey(contractId, "SPLIT_SHIPMENT", { lineIdsToSplit });

  const { result } = await withIdempotency(
    key,
    "contract-edit",
    async () => {
      const remote = await fetchShopifyContract(graphql, contract.shopifyContractId);
      if (!remote.customer?.id) {
        throw new Error("Contract has no customer — cannot split");
      }

      // Re-run safety: a prior invocation may have created the new contract
      // and then failed during the draft line-removal. The created GID is
      // persisted in the audit log keyed by the idempotency key — reuse it
      // instead of creating (and billing) a duplicate contract.
      const priorCreate = await prisma.auditLog.findFirst({
        where: {
          shop,
          action: "SPLIT_SHIPMENT_CREATED",
          subjectType: "SubscriptionContract",
          subjectId: contract.id,
          payloadJson: { contains: key },
        },
        orderBy: { seq: "desc" },
      });
      const priorPayload = parseJson<{ key?: string; newContractGid?: string }>(
        priorCreate?.payloadJson,
        {},
      );
      let newContractGid: string | null =
        priorPayload.key === key ? (priorPayload.newContractGid ?? null) : null;

      if (!newContractGid) {
        const policy = weeksToInterval(contract.intervalWeeks);
        const address = remote.deliveryMethod?.address ?? null;

        const input: Record<string, unknown> = {
          customerId: remote.customer.id,
          nextBillingDate:
            remote.nextBillingDate ?? addWeeks(new Date(), 1).toISOString(),
          currencyCode: remote.currencyCode,
          contract: {
            status: "ACTIVE",
            paymentMethodId: remote.customerPaymentMethod?.id,
            billingPolicy: policy,
            deliveryPolicy: policy,
            deliveryPrice: centsToDecimalString(0),
            ...(address
              ? {
                  deliveryMethod: {
                    shipping: {
                      address: {
                        firstName: address.firstName,
                        lastName: address.lastName,
                        company: address.company,
                        address1: address.address1,
                        address2: address.address2,
                        city: address.city,
                        provinceCode: address.provinceCode,
                        countryCode: address.countryCode,
                        zip: address.zip,
                        phone: address.phone,
                      },
                    },
                  },
                }
              : {}),
          },
          lines: lines.map((line) => ({
            productVariantId: line.shopifyVariantId,
            quantity: line.quantity,
            currentPrice: centsToDecimalString(line.currentPriceCents),
          })),
        };

        const created = await runGraphql<{
          subscriptionContractAtomicCreate: {
            contract: { id: string } | null;
            userErrors: UserError[];
          };
        }>(graphql, SUBSCRIPTION_CONTRACT_ATOMIC_CREATE_MUTATION, { input });
        assertNoUserErrors(
          "subscriptionContractAtomicCreate",
          created.subscriptionContractAtomicCreate.userErrors,
        );
        newContractGid =
          created.subscriptionContractAtomicCreate.contract?.id ?? null;
        if (!newContractGid) {
          throw new Error("subscriptionContractAtomicCreate returned no contract");
        }
        // Persist the GID before the destructive removal step so a retry can
        // resume instead of creating a second contract.
        await appendAudit({
          shop,
          actorType: "SYSTEM",
          action: "SPLIT_SHIPMENT_CREATED",
          subjectType: "SubscriptionContract",
          subjectId: contract.id,
          payload: { key, newContractGid },
        });
      }

      // Re-run safety: only remove lines still present remotely (`remote` was
      // fetched at the top of this closure, after any prior partial run).
      const remoteLineIds = new Set(remote.lines.edges.map((e) => e.node.id));
      const linesToRemove = lines.filter(
        (line) =>
          line.shopifyLineId != null && remoteLineIds.has(line.shopifyLineId),
      );
      if (linesToRemove.length > 0) {
        await withDraft(graphql, contract.shopifyContractId, async (draftId) => {
          for (const line of linesToRemove) {
            const data = await runGraphql<{
              subscriptionDraftLineRemove: {
                lineRemoved: { id: string } | null;
                userErrors: UserError[];
              };
            }>(graphql, SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION, {
              draftId,
              lineId: line.shopifyLineId,
            });
            assertNoUserErrors(
              "subscriptionDraftLineRemove",
              data.subscriptionDraftLineRemove.userErrors,
            );
          }
        });
      }

      const newLocal = await syncContractFromShopify(graphql, shop, newContractGid);
      await appendAudit({
        shop,
        actorType: "SYSTEM",
        action: "SPLIT_SHIPMENT",
        subjectType: "SubscriptionContract",
        subjectId: newLocal.id,
        payload: { splitFrom: contract.id },
      });

      return finalizeOp(graphql, {
        shop,
        contract,
        action: "SPLIT_SHIPMENT",
        payload: { lineIdsToSplit, newContractId: newLocal.id },
      });
    },
    EDIT_TTL_MS,
  );
  return result;
}
