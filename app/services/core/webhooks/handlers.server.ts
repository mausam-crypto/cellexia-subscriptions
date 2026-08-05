/**
 * Webhook topic handlers (dispatched from app/routes/webhooks.tsx after
 * authentication + replay guard). One exported handler per topic family plus
 * a dispatch table. Handlers are written to be safe under Shopify's
 * at-least-once delivery: every side effect is idempotent or deduped.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import {
  type AdminGraphql,
  ShopifyGraphqlError,
  getOfflineAdmin,
  runGraphql,
  toGid,
} from "~/services/core/shopifyClient.server";
import {
  fetchShopifyContract,
  syncContractFromShopify,
} from "~/services/core/contracts.server";
import { recordAttemptOutcome } from "~/services/core/billing.server";
import {
  parseAcquisitionAttributes,
  productIsAvailable,
} from "~/services/core/pure";
import {
  buildAcquisition,
  mergeAcquisition,
} from "~/services/core/acquisition.server";
import { GET_ORDER_TOTAL_QUERY } from "~/graphql/billing";
import {
  isLiveEpisodeForFailure,
  onBillingFailure,
  onBillingSuccess,
} from "~/services/retention/dunning.server";
import { consumeAddOnsAfterCharge } from "~/services/offers/addOnFulfillment.server";
import {
  computeQualityScore,
  type QualityFeatures,
} from "~/services/treatment/quality.server";
import { registerDepletionSignal } from "~/services/treatment/depletion.server";
import {
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
} from "~/services/core/gdpr.server";
import { toCents } from "~/lib/money";
import { parseJson } from "~/types/domain";
import { logger } from "~/lib/logger.server";

export interface WebhookContext {
  topic: string;
  shop: string;
  payload: Record<string, unknown>;
  /** Present when the webhook came with an admin context; else we go offline. */
  graphql?: AdminGraphql | null;
}

async function resolveGraphql(ctx: WebhookContext): Promise<AdminGraphql> {
  if (ctx.graphql) return ctx.graphql;
  const { graphql } = await getOfflineAdmin(ctx.shop);
  return graphql;
}

/**
 * Retryable = worth a Shopify redelivery (transient infra failures).
 * Shopify userErrors are deterministic — retrying cannot help.
 */
export function isRetryableWebhookError(error: unknown): boolean {
  if (error instanceof ShopifyGraphqlError) {
    return !error.userErrors || error.userErrors.length === 0;
  }
  return true;
}

// ─────────────────────── subscription_contracts/* ──────────────────────────

export async function handleSubscriptionContractCreate(
  ctx: WebhookContext,
): Promise<void> {
  const graphql = await resolveGraphql(ctx);
  const contractGid = String(
    ctx.payload.admin_graphql_api_id ?? toGid("SubscriptionContract", String(ctx.payload.id)),
  );
  const contract = await syncContractFromShopify(graphql, ctx.shop, contractGid);

  // Acquisition attribution from the contract's custom attributes.
  const remote = await fetchShopifyContract(graphql, contractGid);
  const acquisition = parseAcquisitionAttributes(remote.customAttributes);
  const firstOrderAovCents = remote.originOrder
    ? toCents(remote.originOrder.totalPriceSet.shopMoney.amount)
    : null;

  // Enriched schemaVersion-2 record (channel, geo, device, time-to-purchase…)
  // merged over anything already stored — ORDERS_CREATE may have landed first
  // with order-only fields (locale, order name); never lose earlier keys.
  const legacyAcquisition: Record<string, unknown> = {
    widgetVersion: acquisition.widgetVersion,
    experimentKey: acquisition.experimentKey,
    variantKey: acquisition.variantKey,
    initialDiscountPercent: acquisition.initialDiscountPercent,
    utm: acquisition.utm,
    custom: acquisition.custom,
  };
  const acquisitionV2 = buildAcquisition({
    attributes: remote.customAttributes,
    shippingAddress: remote.deliveryMethod?.address ?? null,
    lines: remote.lines.edges.map((edge) => ({ quantity: edge.node.quantity })),
    capturedAt: remote.createdAt,
  });
  let mergedAcquisition = mergeAcquisition(
    mergeAcquisition(
      parseJson<Record<string, unknown>>(contract.acquisitionJson, {}),
      legacyAcquisition,
    ),
    acquisitionV2,
  );

  // Order-first arrival: when ORDERS_CREATE processed before this contract
  // row existed, its order-only enrichment (customer locale, order name,
  // source name, shipping geo, raw note_attributes) was stashed as an
  // ACQUISITION_ORDER_CAPTURE warehouse event keyed by the origin order gid.
  // Merge it UNDERNEATH the contract-side record: order-only keys land, and
  // contract-built fields (channel, unitsInitial from real lines) stay
  // authoritative. Replay-safe — mergeAcquisition is idempotent.
  if (remote.originOrder) {
    const stash = await prisma.analyticsEvent.findFirst({
      where: {
        shop: ctx.shop,
        name: ACQUISITION_ORDER_CAPTURE,
        // Trailing quote = exact-terminated JSON-substring match (the bare
        // gid for order 123 would also match order 1234).
        payloadJson: { contains: `${remote.originOrder.id}"` },
      },
      orderBy: { occurredAt: "desc" },
    });
    const stashPayload = parseJson<{
      orderId?: string;
      acquisition?: Record<string, unknown>;
    }>(stash?.payloadJson, {});
    if (
      stashPayload.orderId === remote.originOrder.id &&
      stashPayload.acquisition
    ) {
      mergedAcquisition = mergeAcquisition(
        stashPayload.acquisition,
        mergedAcquisition,
      );
    }
  }

  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: {
      acquisitionJson: JSON.stringify(mergedAcquisition),
      widgetVersion: acquisition.widgetVersion,
      initialDiscountPercent: acquisition.initialDiscountPercent,
      originOrderId: remote.originOrder?.id ?? contract.originOrderId,
      firstOrderAovCents: firstOrderAovCents ?? contract.firstOrderAovCents,
    },
  });

  await emitLifecycleEvent({
    shop: ctx.shop,
    name: "SUBSCRIPTION_STARTED",
    contractId: contract.id,
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail,
    dedupeKey: `subscription-started:${contract.id}`,
    payload: {
      intervalWeeks: contract.intervalWeeks,
      firstOrderAovCents,
      widgetVersion: acquisition.widgetVersion,
    },
  });

  // Initial quality score (treatment module owns the model).
  try {
    const lines = await prisma.contractLine.findMany({
      where: { contractId: contract.id },
    });
    const features: QualityFeatures = {
      // The widget packs UTM data into the _cellexia_utm JSON blob (never
      // loose top-level utm_* attributes), so the legacy parser's utm map is
      // empty for every widget signup — read the v2 record, which parses the
      // blob. deriveChannel always returns a non-empty slug ("direct" at
      // minimum), so the acquisition-source factor is never dead-zeroed by
      // an "unknown" fallback.
      acquisitionSource:
        acquisitionV2.utm?.["utm_source"] ?? acquisitionV2.channel,
      discountPercent: acquisition.initialDiscountPercent ?? 0,
      quantity: lines.reduce((sum, l) => sum + l.quantity, 0),
      // Neutral values for signals unknown at create time — each contributes
      // 0 points, so the score degrades gracefully instead of throwing.
      productMarginPercent: 0.5,
      hasPurchaseHistory: false,
      oneTimePurchases: 0,
      widgetEngaged: acquisition.widgetVersion != null,
      firstOrderMarginCents: 0,
      refundRiskFlag: false,
    };
    const { score, factors } = computeQualityScore(features);
    await prisma.scoreSnapshot.create({
      data: {
        shop: ctx.shop,
        contractId: contract.id,
        kind: "QUALITY",
        value: score,
        factorsJson: JSON.stringify(factors),
      },
    });
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { qualityScore: score },
    });
  } catch (e) {
    // The score is enrichment, not correctness — never fail the webhook on it.
    logger.warn("initial quality score failed", {
      shop: ctx.shop,
      contractId: contract.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  await appendAudit({
    shop: ctx.shop,
    actorType: "WEBHOOK",
    action: "CONTRACT_CREATED",
    subjectType: "SubscriptionContract",
    subjectId: contract.id,
    payload: { shopifyContractId: contractGid },
  });
}

export async function handleSubscriptionContractUpdate(
  ctx: WebhookContext,
): Promise<void> {
  const graphql = await resolveGraphql(ctx);
  const contractGid = String(
    ctx.payload.admin_graphql_api_id ?? toGid("SubscriptionContract", String(ctx.payload.id)),
  );
  await syncContractFromShopify(graphql, ctx.shop, contractGid);
}

// ─────────────────────── subscription_billing_attempts/* ───────────────────

interface BillingAttemptWebhookPayload {
  admin_graphql_api_id?: string;
  id?: number | string;
  idempotency_key?: string | null;
  order_id?: number | string | null;
  admin_graphql_api_order_id?: string | null;
  admin_graphql_api_subscription_contract_id?: string | null;
  subscription_contract_id?: number | string | null;
  error_code?: string | null;
  error_message?: string | null;
}

function billingIds(payload: Record<string, unknown>) {
  const p = payload as BillingAttemptWebhookPayload;
  const attemptGid =
    p.admin_graphql_api_id ??
    toGid("SubscriptionBillingAttempt", String(p.id ?? ""));
  const orderGid =
    p.admin_graphql_api_order_id ??
    (p.order_id != null ? toGid("Order", String(p.order_id)) : null);
  const contractGid =
    p.admin_graphql_api_subscription_contract_id ??
    (p.subscription_contract_id != null
      ? toGid("SubscriptionContract", String(p.subscription_contract_id))
      : null);
  return {
    attemptGid,
    orderGid,
    contractGid,
    idempotencyKey: p.idempotency_key ?? null,
    errorCode: p.error_code ?? null,
  };
}

export async function handleBillingAttemptSuccess(
  ctx: WebhookContext,
): Promise<void> {
  const { attemptGid, orderGid, contractGid, idempotencyKey } = billingIds(
    ctx.payload,
  );

  // Order total so contract revenue totals stay accurate. A missing amount
  // would permanently record 0 revenue for this cycle (the replay guard blocks
  // later repair), so pricing failures fail the webhook: the thrown plain
  // Error is retryable, webhooks.tsx returns 500 and releases the replay
  // guard, and Shopify's redelivery re-runs the whole handler cleanly.
  // Pricing runs before recordAttemptOutcome, so no partial state is written.
  let amountCents: number | null = null;
  // The order's creation time = the moment its line set was frozen. Passed
  // to consumeAddOnsAfterCharge so an add-on applied AFTER the order was
  // built (apply-job/charge race) is not consumed as if it had shipped.
  let chargeAt: Date | null = null;
  if (orderGid) {
    try {
      const graphql = await resolveGraphql(ctx);
      const data = await runGraphql<{
        order: {
          id: string;
          createdAt: string | null;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        } | null;
      }>(graphql, GET_ORDER_TOTAL_QUERY, { id: orderGid });
      if (!data.order) throw new Error("order not found");
      amountCents = toCents(data.order.totalPriceSet.shopMoney.amount);
      chargeAt = data.order.createdAt ? new Date(data.order.createdAt) : null;
    } catch (e) {
      throw new Error(
        `could not price billing attempt order ${orderGid}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  const { attempt, contract } = await recordAttemptOutcome(ctx.shop, attemptGid, {
    status: "SUCCESS",
    orderId: orderGid,
    amountCents,
    idempotencyKey,
    shopifyContractId: contractGid,
  });
  if (!contract) return;

  await onBillingSuccess(ctx.shop, contract.id);

  await emitLifecycleEvent({
    shop: ctx.shop,
    name: "CHARGE_COMPLETED",
    contractId: contract.id,
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail,
    dedupeKey: `charge-completed:${attemptGid}`,
    payload: {
      orderId: orderGid,
      amountCents,
      attemptNumber: attempt.attemptNumber,
    },
  });

  // The cycle actually charged → consume one-time / limited add-on lines
  // (decrement N_DELIVERIES, remove exhausted/NEXT_ONLY lines). Owned by the
  // fulfilment module; a throw here fails the webhook so Shopify redelivers —
  // everything above is dedupe-guarded, so the re-run is safe. Keyed on the
  // local attempt id (recordAttemptOutcome upserts the same row across
  // redeliveries) so distinct charges never share a consume key; chargeAt
  // (order.createdAt) excludes add-ons applied after this order was built.
  await consumeAddOnsAfterCharge(ctx.shop, contract.id, attempt.id, chargeAt);

  // A successful charge means a delivery is on its way for every line.
  const lines = await prisma.contractLine.findMany({
    where: { contractId: contract.id },
    select: { id: true },
  });
  for (const line of lines) {
    try {
      await registerDepletionSignal(ctx.shop, line.id, "DELIVERY_RECEIVED", {
        orderId: orderGid,
      });
    } catch (e) {
      logger.warn("depletion signal failed", {
        shop: ctx.shop,
        contractLineId: line.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export async function handleBillingAttemptFailure(
  ctx: WebhookContext,
  challenged = false,
): Promise<void> {
  const { attemptGid, orderGid, contractGid, idempotencyKey, errorCode } =
    billingIds(ctx.payload);

  const { attempt, contract, replayed } = await recordAttemptOutcome(
    ctx.shop,
    attemptGid,
    {
      status: challenged ? "CHALLENGED" : "FAILURE",
      errorCode,
      orderId: orderGid,
      idempotencyKey,
      shopifyContractId: contractGid,
    },
  );
  if (!contract) return;
  // SUCCESS is terminal: a late failure-family webhook for a paid attempt
  // (recordAttemptOutcome left the paid row untouched) must never dun.
  if (attempt.status === "SUCCESS") return;

  // `replayed` alone is NOT proof dunning ran: webhooks.tsx releases the
  // replay guard and returns 500 when the handler throws AFTER
  // recordAttemptOutcome committed (e.g. onBillingFailure hitting a
  // transient DB error) — Shopify's redelivery then re-enters here with
  // replayed=true, and an unconditional early return would silently abandon
  // the cycle: no DunningState, no retries, no emails, ever. Gate on the
  // actual dunning state instead: skip only when an episode is already live
  // (true replay, or the CHALLENGED→FAILURE second leg) or the episode for
  // this failure already ran to completion.
  let dunningAlreadyHandled = false;
  if (replayed) {
    const state = await prisma.dunningState.findUnique({
      where: { contractId: contract.id },
    });
    dunningAlreadyHandled =
      state != null &&
      // Live episode — same predicate onBillingFailure uses, so the
      // grace-pause-resume handoff (FINAL_NOTICE, nextRetryAt null) still
      // falls through and opens the fresh post-resume episode on redelivery.
      (isLiveEpisodeForFailure(state.phase, state.nextRetryAt) ||
        // …or the episode for this failure already ran to completion.
        ((state.phase === "RESOLVED" || state.phase === "EXHAUSTED") &&
          state.updatedAt >= attempt.occurredAt));
  }
  if (!dunningAlreadyHandled) {
    // CHALLENGED webhooks carry no decline code that categorises as a 3DS
    // failure — pass the flag so dunning runs the AUTHENTICATION_REQUIRED
    // strategy (complete-authentication email) instead of blind retries.
    await onBillingFailure(ctx.shop, contract.id, errorCode ?? "unknown", {
      challenged,
    });
  }

  // Always attempted: the dedupeKey (per attempt gid) makes this replay-safe,
  // so a redelivery after a crash between onBillingFailure and this emit
  // still sends the customer-facing failure email exactly once.
  await emitLifecycleEvent({
    shop: ctx.shop,
    name: "CHARGE_FAILED",
    contractId: contract.id,
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail,
    dedupeKey: `charge-failed:${attemptGid}`,
    payload: { errorCode, challenged },
  });
}

// ─────────────────────── customer_payment_methods/* ────────────────────────

export async function handleCustomerPaymentMethod(
  ctx: WebhookContext,
): Promise<void> {
  const gid = String(ctx.payload.admin_graphql_api_id ?? "");
  if (!gid) return;
  const revoked = ctx.topic.endsWith("REVOKE");
  // Shopify's payload nests card details under `payment_instrument`; keep the
  // legacy `instrument` key as a fallback.
  const instrument = (ctx.payload.payment_instrument ??
    ctx.payload.instrument ??
    {}) as {
    brand?: string | null;
    last_digits?: string | null;
    month?: number | null;
    year?: number | null;
  };

  // Non-card instruments (or unexpected payload shapes) carry no card fields —
  // skip the write rather than wiping metadata dunning depends on.
  if (
    !revoked &&
    instrument.brand == null &&
    instrument.last_digits == null &&
    instrument.month == null
  ) {
    return;
  }

  const data = revoked
    ? {
        cardBrand: null,
        cardLastDigits: null,
        cardExpiryMonth: null,
        cardExpiryYear: null,
      }
    : {
        cardBrand: instrument.brand ?? null,
        cardLastDigits: instrument.last_digits ?? null,
        cardExpiryMonth: instrument.month ?? null,
        cardExpiryYear: instrument.year ?? null,
      };

  const res = await prisma.subscriptionContract.updateMany({
    where: { shop: ctx.shop, paymentMethodId: gid },
    data,
  });
  if (res.count > 0) {
    await appendAudit({
      shop: ctx.shop,
      actorType: "WEBHOOK",
      action: revoked ? "PAYMENT_METHOD_REVOKED" : "PAYMENT_METHOD_UPDATED",
      subjectType: "CustomerPaymentMethod",
      subjectId: gid,
      payload: { contractsUpdated: res.count },
    });
  }
}

// ─────────────────────── orders/create ─────────────────────────────────────

/**
 * Null-origin fallback window: a contract missing its originOrderId (the
 * contract-create fetch returned originOrder null) is only matched to an
 * order created within this window of its treatmentStartedAt. The legitimate
 * race (webhooks minutes apart) always fits; back-book imports and contracts
 * from before install never do — matching them would cross-stamp an old
 * contract with a NEW order's acquisition, AOV and origin order, injecting a
 * phantom cycle-0 payment into the wrong cohort.
 */
const ORIGIN_MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * AnalyticsEvent name for the order-side acquisition stash (order-first
 * webhook arrival). Not a LifecycleEvent — written directly to the warehouse
 * (never Klaviyo) and consumed by handleSubscriptionContractCreate via the
 * same payloadJson-contains lookup pattern handleProductsUpdate uses.
 */
export const ACQUISITION_ORDER_CAPTURE = "ACQUISITION_ORDER_CAPTURE";

export async function handleOrdersCreate(ctx: WebhookContext): Promise<void> {
  const payload = ctx.payload as {
    admin_graphql_api_id?: string;
    id?: number | string;
    name?: string | null;
    source_name?: string | null;
    total_price?: string | null;
    created_at?: string | null;
    customer_locale?: string | null;
    customer?: { id?: number | string | null } | null;
    note_attributes?: Array<{
      name?: string | null;
      key?: string | null;
      value?: string | null;
    }> | null;
    shipping_address?: Record<string, string | null | undefined> | null;
  };
  const orderGid =
    payload.admin_graphql_api_id ?? toGid("Order", String(payload.id ?? ""));
  const isRecurringOrder = payload.source_name === "subscription_contract";
  const customerGid = payload.customer?.id
    ? toGid("Customer", String(payload.customer.id))
    : null;

  // 1. Checkout order that started a treatment plan → stamp acquisition AOV
  //    and merge the enriched schemaVersion-2 acquisition record (channel,
  //    utm, geo from shipping_address, locale, time-to-purchase, raw
  //    note_attributes snapshot) into each matched contract.
  //
  //    NOTE: the REST orders/create payload carries NO selling-plan field on
  //    line_items (selling_plan_allocation is a Cart AJAX / Liquid concept),
  //    so subscription relevance can never be read off the line items here —
  //    it is decided by matching this customer's contracts below, and the
  //    order-first stash is gated on the widget's _cellexia_* attributes.
  if (!isRecurringOrder && customerGid) {
    const aovCents = toCents(payload.total_price ?? 0);
    const orderCreatedAt = payload.created_at
      ? new Date(payload.created_at)
      : new Date();
    const acquisitionV2 = buildAcquisition({
      attributes: payload.note_attributes,
      shippingAddress: payload.shipping_address,
      customerLocale: payload.customer_locale,
      orderName: payload.name,
      sourceName: payload.source_name,
      // No line quantities: order line_items cannot distinguish subscription
      // lines from one-time items, so buildAcquisition falls back to the
      // widget's _cellexia_qty attribute; the contract-create record (built
      // from real contract lines) stays authoritative for unitsInitial.
      capturedAt: payload.created_at,
    });

    const targets = await prisma.subscriptionContract.findMany({
      where: {
        shop: ctx.shop,
        shopifyCustomerId: customerGid,
        OR: [
          { originOrderId: orderGid },
          {
            originOrderId: null,
            treatmentStartedAt: {
              gte: new Date(orderCreatedAt.getTime() - ORIGIN_MATCH_WINDOW_MS),
              lte: new Date(orderCreatedAt.getTime() + ORIGIN_MATCH_WINDOW_MS),
            },
          },
        ],
      },
    });

    if (targets.length > 0) {
      let aovStamped = 0;
      for (const target of targets) {
        // Enrichment ALWAYS merges (mergeAcquisition is replay-idempotent and
        // never loses earlier keys — the LEARNING-DATA-V2 any-order seam);
        // the origin/AOV stamp is stamp-once so an already-priced contract
        // keeps its original first-order AOV.
        //
        // Merge DIRECTION mirrors the order-first stash path: the order-built
        // record goes UNDERNEATH the stored one, so order-only fields (order
        // name, locale, source name, geo, raw) gap-fill while contract-built
        // keys stay authoritative — the order side has no line data and falls
        // back to the widget's _cellexia_qty for unitsInitial, which must
        // never overwrite the unitsInitial computed from real contract lines.
        const stampAov = target.firstOrderAovCents == null;
        if (stampAov) aovStamped += 1;
        await prisma.subscriptionContract.update({
          where: { id: target.id },
          data: {
            acquisitionJson: JSON.stringify(
              mergeAcquisition(
                acquisitionV2,
                parseJson<Record<string, unknown>>(target.acquisitionJson, {}),
              ),
            ),
            ...(stampAov
              ? { originOrderId: orderGid, firstOrderAovCents: aovCents }
              : {}),
          },
        });
      }
      await appendAudit({
        shop: ctx.shop,
        actorType: "WEBHOOK",
        action: "ORIGIN_ORDER_STAMPED",
        subjectType: "Order",
        subjectId: orderGid,
        payload: {
          contractsStamped: aovStamped,
          contractsEnriched: targets.length,
          aovCents,
          acquisitionChannel: acquisitionV2.channel,
        },
      });
    }

    // Order-first arrival: SUBSCRIPTION_CONTRACTS_CREATE may not have landed
    // yet (its handler creates the contract row), so the order-only fields
    // (locale, order name, source name, geo, raw note_attributes) would be
    // dropped with no retry. Stash the record so the contract-create handler
    // can merge it. Gated on the widget's _cellexia_* attributes so plain
    // one-time orders never accumulate stash rows; idempotent per order.
    const hasCellexiaAttributes = (payload.note_attributes ?? []).some((attr) =>
      (attr?.name ?? attr?.key ?? "").startsWith("_cellexia_"),
    );
    if (hasCellexiaAttributes) {
      // The trailing quote makes the JSON-substring match exact — the bare
      // gid for order 123 would also match order 1234's stash row.
      const existing = await prisma.analyticsEvent.findFirst({
        where: {
          shop: ctx.shop,
          name: ACQUISITION_ORDER_CAPTURE,
          payloadJson: { contains: `${orderGid}"` },
        },
        select: { id: true },
      });
      if (!existing) {
        await prisma.analyticsEvent.create({
          data: {
            shop: ctx.shop,
            name: ACQUISITION_ORDER_CAPTURE,
            shopifyCustomerId: customerGid,
            payloadJson: JSON.stringify({
              orderId: orderGid,
              acquisition: acquisitionV2,
            }),
          },
        });
      }
    }
  }

  // 2. Recurring orders need no add-on bookkeeping here any more: one-time /
  //    limited add-on lines are consumed by the fulfilment module's
  //    consumeAddOnsAfterCharge, wired into the CHARGE_COMPLETED branch of
  //    handleBillingAttemptSuccess — a single consumer, so a racing
  //    ORDERS_CREATE can never double-decrement remainingDeliveries.
}

// ─────────────────────── products/update ───────────────────────────────────

export async function handleProductsUpdate(ctx: WebhookContext): Promise<void> {
  const payload = ctx.payload as {
    admin_graphql_api_id?: string;
    id?: number | string;
    title?: string;
    handle?: string;
    status?: string;
    variants?: Array<{
      inventory_quantity?: number | null;
      inventory_management?: string | null;
      inventory_policy?: string | null;
    }> | null;
  };
  const productGid =
    payload.admin_graphql_api_id ?? toGid("Product", String(payload.id ?? ""));
  if (!payload.title) return;

  await prisma.productMeta.upsert({
    where: {
      shop_shopifyProductId: { shop: ctx.shop, shopifyProductId: productGid },
    },
    update: {
      title: payload.title,
      handle: payload.handle ?? null,
      active: payload.status === "active",
    },
    create: {
      shop: ctx.shop,
      shopifyProductId: productGid,
      title: payload.title,
      handle: payload.handle ?? null,
      active: payload.status === "active",
    },
  });

  // Availability transition detection: the latest stock event is the previous
  // known state (default: in stock).
  const availableNow =
    payload.status === "active" && productIsAvailable(payload.variants);
  const lastStockEvent = await prisma.analyticsEvent.findFirst({
    where: {
      shop: ctx.shop,
      name: { in: ["PRODUCT_OUT_OF_STOCK", "PRODUCT_BACK_IN_STOCK"] },
      payloadJson: { contains: productGid },
    },
    orderBy: { occurredAt: "desc" },
  });
  const wasAvailable = lastStockEvent
    ? lastStockEvent.name === "PRODUCT_BACK_IN_STOCK"
    : true;

  if (wasAvailable && !availableNow) {
    await emitLifecycleEvent({
      shop: ctx.shop,
      name: "PRODUCT_OUT_OF_STOCK",
      payload: { productId: productGid, title: payload.title },
    });
  } else if (!wasAvailable && availableNow) {
    await emitLifecycleEvent({
      shop: ctx.shop,
      name: "PRODUCT_BACK_IN_STOCK",
      payload: { productId: productGid, title: payload.title },
    });
  }
}

// ─────────────────────── app/scopes_update ─────────────────────────────────

/**
 * Shopify fires app/scopes_update when the merchant re-consents after a scope
 * change. Stored Session rows keep the scope string granted at OAuth time —
 * refresh them so later "does this session have scope X?" checks read the
 * live grant, not the stale one.
 */
export async function handleScopesUpdate(ctx: WebhookContext): Promise<void> {
  const current = ctx.payload.current;
  if (!Array.isArray(current)) {
    // Unexpected payload shape: nothing safe to write, nothing to audit.
    logger.warn("app/scopes_update payload missing current array", {
      shop: ctx.shop,
    });
    return;
  }
  // Session.scope is the template's comma-joined string form.
  const scope = current.map((s) => String(s)).join(",");
  const res = await prisma.session.updateMany({
    where: { shop: ctx.shop },
    data: { scope },
  });
  await appendAudit({
    shop: ctx.shop,
    actorType: "WEBHOOK",
    action: "APP_SCOPES_UPDATED",
    subjectType: "Shop",
    subjectId: ctx.shop,
    payload: { scope, sessionsUpdated: res.count },
  });
}

// ─────────────────────── app/uninstalled + compliance ──────────────────────

export async function handleAppUninstalled(ctx: WebhookContext): Promise<void> {
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: ctx.shop },
  });
  const settingsJson = JSON.stringify({
    ...parseJson<Record<string, unknown>>(settings?.settingsJson, {}),
    uninstalledAt: new Date().toISOString(),
  });
  await prisma.shopSettings.upsert({
    where: { shop: ctx.shop },
    update: { settingsJson, klaviyoEnabled: false },
    create: { shop: ctx.shop, settingsJson, klaviyoEnabled: false },
  });
  await prisma.session.deleteMany({ where: { shop: ctx.shop } });
  await appendAudit({
    shop: ctx.shop,
    actorType: "WEBHOOK",
    action: "APP_UNINSTALLED",
    subjectType: "Shop",
    subjectId: ctx.shop,
  });
}

// GDPR topics are handled by services/core/gdpr.server.ts (real redaction /
// export assembly, not just an ack) — dispatched per topic below.

// ─────────────────────── Dispatch ──────────────────────────────────────────

export async function dispatchWebhook(ctx: WebhookContext): Promise<void> {
  switch (ctx.topic) {
    case "SUBSCRIPTION_CONTRACTS_CREATE":
      return handleSubscriptionContractCreate(ctx);
    case "SUBSCRIPTION_CONTRACTS_UPDATE":
      return handleSubscriptionContractUpdate(ctx);
    case "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS":
      return handleBillingAttemptSuccess(ctx);
    case "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE":
      return handleBillingAttemptFailure(ctx, false);
    case "SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED":
      return handleBillingAttemptFailure(ctx, true);
    case "CUSTOMER_PAYMENT_METHODS_CREATE":
    case "CUSTOMER_PAYMENT_METHODS_UPDATE":
    case "CUSTOMER_PAYMENT_METHODS_REVOKE":
      return handleCustomerPaymentMethod(ctx);
    case "ORDERS_CREATE":
      return handleOrdersCreate(ctx);
    case "PRODUCTS_UPDATE":
      return handleProductsUpdate(ctx);
    case "APP_UNINSTALLED":
      return handleAppUninstalled(ctx);
    case "APP_SCOPES_UPDATE":
      return handleScopesUpdate(ctx);
    case "CUSTOMERS_DATA_REQUEST":
      return handleCustomersDataRequest(ctx.shop, ctx.payload);
    case "CUSTOMERS_REDACT":
      return handleCustomersRedact(ctx.shop, ctx.payload);
    case "SHOP_REDACT":
      return handleShopRedact(ctx.shop, ctx.payload);
    default:
      logger.info("unhandled webhook topic", { topic: ctx.topic, shop: ctx.shop });
      return;
  }
}
