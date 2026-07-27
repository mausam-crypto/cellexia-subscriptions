import { Prisma, type SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { requireShop } from "~/lib/shop/install.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { buildMitEvidence } from "~/lib/billing/mit-evidence.server";
import {
  hasSentForCycle,
  sendNotification,
} from "~/lib/notifications/send.server";
import {
  type AdminClient,
  draftUpdatePaymentMethod,
  getContract,
  getOrderSummary,
  listCustomerPaymentMethods,
  withContractDraft,
} from "~/lib/graphql/index.server";

/**
 * Webhook topic handlers.
 *
 * Every handler receives the REST-shaped (snake_case) JSON payload exactly as
 * Shopify delivered it and must tolerate partial payloads — no optional field
 * is ever trusted. Topic keys are the constants produced by shopify-app-remix
 * (`subscription_contracts/create` → `SUBSCRIPTION_CONTRACTS_CREATE`).
 *
 * Idempotency: the route layer dedupes on X-Shopify-Webhook-Id, and the
 * billing-attempt handlers additionally guard on the mirrored attempt status
 * so a manual replay (new webhook id, same attempt) never double-counts
 * revenue or re-fires notifications.
 *
 * Cross-module seams (contracts sync, dunning, gifts) are lazy-imported so
 * this module never participates in an import cycle; hooks that are not part
 * of the pinned seam list (lifecycle.onSuccessfulCycle,
 * dunning.onPaymentMethodUpdated, billing.consumeGrantCycle) are invoked via
 * `callOptionalHook`, which tolerates the export not existing.
 */

// ── Context types ────────────────────────────────────────────────────────────

export interface WebhookHandlerContext {
  shopDomain: string;
  /** Raw webhook JSON body (REST-shaped, snake_case). */
  payload: Record<string, unknown>;
  /** X-Shopify-Webhook-Id — already claimed by the route's receipt dedupe. */
  webhookId: string;
}

export type WebhookHandler = (ctx: WebhookHandlerContext) => Promise<void>;

type Payload = Record<string, unknown>;

/** Admin API client for webhook handlers (offline session for the shop). */
export function getAdmin(shopDomain: string): Promise<AdminClient> {
  return adminClientForShop(shopDomain);
}

// ── Defensive payload parsing ────────────────────────────────────────────────

function asRecord(value: unknown): Payload | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** First non-nullish value among `keys` in `payload`. */
function pick(payload: Payload, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (value != null) return value;
  }
  return null;
}

/**
 * Full GID from either an existing GID string or a numeric REST id.
 * `toGid("Order", 123)` → "gid://shopify/Order/123"; null when unusable.
 */
function toGid(resource: string, value: unknown): string | null {
  if (typeof value === "string") {
    if (value.startsWith("gid://")) return value;
    if (/^\d+$/.test(value)) return `gid://shopify/${resource}/${value}`;
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `gid://shopify/${resource}/${Math.trunc(value)}`;
  }
  return null;
}

// ── Optional cross-module hooks ──────────────────────────────────────────────

/**
 * Invoke `fnName` on a lazily imported module when (and only when) the export
 * exists. Returns true when the hook existed (even if it threw — the error is
 * logged and swallowed so a lifecycle/analytics hook can never fail a webhook).
 */
async function callOptionalHook(
  importer: () => Promise<unknown>,
  fnName: string,
  args: unknown[],
  label: string,
): Promise<boolean> {
  try {
    const mod = (await importer()) as Record<string, unknown>;
    const fn = mod[fnName];
    if (typeof fn !== "function") return false;
    await (fn as (...fnArgs: unknown[]) => unknown)(...args);
    return true;
  } catch (err) {
    console.error(`[webhooks] optional hook ${label} failed`, err);
    return true;
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const STATUS_EVENT: Record<string, string> = {
  ACTIVE: "contract.activated",
  PAUSED: "contract.paused",
  CANCELLED: "contract.cancelled",
  FAILED: "contract.failed",
  EXPIRED: "contract.expired",
};

function contractEventBase(
  shopId: string,
  contract: Pick<SubscriptionContract, "id" | "customerId" | "email">,
) {
  return {
    shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };
}

/** Contract GID from a subscription-contract-shaped payload. */
function contractGidFromPayload(payload: Payload): string | null {
  return toGid(
    "SubscriptionContract",
    pick(payload, "admin_graphql_api_id", "id"),
  );
}

type AttemptWithContract = Prisma.BillingAttemptGetPayload<{
  include: { contract: true };
}>;

/**
 * Resolve the local BillingAttempt for a billing-attempt webhook.
 *
 * Resolution order:
 * 1. `payload.admin_graphql_api_id` → BillingAttempt.shopifyAttemptId
 * 2. `payload.idempotency_key` → BillingAttempt.idempotencyKey (fallback for
 *    attempts whose Shopify id was never written back; the id is late-bound
 *    onto the row here)
 * 3. Neither matches → the attempt originated outside our scheduler (e.g.
 *    created manually in the Shopify admin). A mirror row is created against
 *    the contract (`payload.admin_graphql_api_subscription_contract_id` /
 *    `subscription_contract_id`) so revenue and dunning accounting stay
 *    complete; originatingAction ADMIN_MANUAL marks its provenance.
 *
 * Returns null (after a console warning) when nothing can be resolved — the
 * webhook is then acknowledged without effect.
 */
async function resolveBillingAttempt(
  payload: Payload,
  webhookId: string,
): Promise<AttemptWithContract | null> {
  const attemptGid = toGid(
    "SubscriptionBillingAttempt",
    pick(payload, "admin_graphql_api_id", "id"),
  );
  const idempotencyKey = asString(payload.idempotency_key);

  if (attemptGid) {
    const byGid = await prisma.billingAttempt.findUnique({
      where: { shopifyAttemptId: attemptGid },
      include: { contract: true },
    });
    if (byGid) return byGid;
  }

  if (idempotencyKey) {
    const byKey = await prisma.billingAttempt.findUnique({
      where: { idempotencyKey },
      include: { contract: true },
    });
    if (byKey) {
      if (attemptGid && byKey.shopifyAttemptId == null) {
        return prisma.billingAttempt.update({
          where: { id: byKey.id },
          data: { shopifyAttemptId: attemptGid },
          include: { contract: true },
        });
      }
      return byKey;
    }
  }

  const contractGid = toGid(
    "SubscriptionContract",
    pick(
      payload,
      "admin_graphql_api_subscription_contract_id",
      "subscription_contract_id",
    ),
  );
  const contract = contractGid
    ? await prisma.subscriptionContract.findUnique({
        where: { shopifyContractId: contractGid },
      })
    : null;
  if (!contract) {
    console.warn("[webhooks] billing attempt could not be resolved", {
      webhookId,
      attemptGid,
      idempotencyKey,
      contractGid,
    });
    return null;
  }

  return prisma.billingAttempt.create({
    data: {
      contractId: contract.id,
      shopifyAttemptId: attemptGid,
      idempotencyKey: idempotencyKey ?? `webhook:${attemptGid ?? webhookId}`,
      cycleIndex: contract.ordersCount + 1,
      attemptNumber: 1,
      status: "PENDING",
      scheduledFor: new Date(),
      originatingAction: "ADMIN_MANUAL",
      // Stored-credential/MIT compliance evidence — every attempt carries it,
      // including rows reconstructed from a webhook we didn't originate.
      mitEvidence: {
        ...buildMitEvidence({
          consentOrder: contract.originOrderId,
          originatingAction: "ADMIN_MANUAL",
          timestamp: new Date(),
        }),
        reconstructedFromWebhook: true,
      },
    },
    include: { contract: true },
  });
}

// ── Subscription contracts ───────────────────────────────────────────────────

/**
 * SUBSCRIPTION_CONTRACTS_CREATE
 * Payload: subscription contract (REST-shaped) — `admin_graphql_api_id`, `id`,
 * `customer_id`, `status`, `billing_policy`, `currency_code`, ...
 *
 * Mirrors the contract locally (syncContractFromShopify is the single writer
 * of contract mirrors), backfills the locale from the Shopify customer, logs
 * the canonical contract.created event (this is also the take-rate numerator
 * feed — analytics counts new contract mirrors as takeRateNum), delivers the
 * plan-configured first-order gift onto the origin order and schedules gifts
 * for the first two cycles.
 */
async function handleSubscriptionContractsCreate({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const contractGid = contractGidFromPayload(payload);
  if (!contractGid) {
    console.warn(
      "[webhooks] SUBSCRIPTION_CONTRACTS_CREATE without a contract id",
      webhookId,
    );
    return;
  }

  const { syncContractFromShopify } = await import(
    "~/lib/contracts/service.server"
  );
  await syncContractFromShopify(shopDomain, contractGid);

  const contract = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: contractGid },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Contract mirror missing after sync: ${contractGid}`);
  }

  // Locale: prefer the Shopify customer's locale when present.
  try {
    const admin = await getAdmin(shopDomain);
    const remote = await getContract(admin, contractGid);
    const rawLocale = remote.customer?.locale ?? null;
    if (rawLocale) {
      const locale = normalizeLocale(rawLocale);
      if (locale !== contract.locale) {
        await prisma.subscriptionContract.update({
          where: { id: contract.id },
          data: { locale },
        });
        contract.locale = locale;
      }
    }
  } catch (err) {
    console.error("[webhooks] customer locale sync failed", contractGid, err);
  }

  await logEvent({
    ...contractEventBase(shop.id, contract),
    type: "contract.created",
    source: "WEBHOOK",
    payload: {
      shopifyContractId: contract.shopifyContractId,
      status: contract.status,
      intervalWeeks: contract.intervalWeeks,
      currencyCode: contract.currencyCode,
      nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
      isPrepaid: contract.isPrepaid,
      lineCount: contract.lines.length,
      itemTitles: contract.lines.filter((l) => !l.isGift).map((l) => l.title),
      originOrderId: contract.originOrderId,
    },
  });

  // First-order gift (SellingPlanConfig.firstOrderGiftVariantId): delivered
  // onto the origin (checkout) order as a zero-priced line via order editing;
  // when the order cannot be edited the grant defers to a SCHEDULED cycle-1
  // grant that the engine attaches just below. Guarded: gifts never fail a
  // webhook.
  try {
    const { ensureFirstOrderGift } = await import(
      "~/lib/gifts/firstOrderGift.server"
    );
    await ensureFirstOrderGift(shopDomain, contract.id);
  } catch (err) {
    console.error("[webhooks] first-order gift failed", contract.id, err);
  }

  // Gift scheduling for the first cycles; the engine reads its own settings
  // and is a no-op when no rule matches. Guarded: gifts never fail a webhook.
  try {
    const { ensureGiftsForUpcomingCycle } = await import(
      "~/lib/gifts/engine.server"
    );
    await ensureGiftsForUpcomingCycle(contract.id, 1);
    await ensureGiftsForUpcomingCycle(contract.id, 2);
  } catch (err) {
    console.error("[webhooks] gift scheduling failed", contract.id, err);
  }
}

/**
 * SUBSCRIPTION_CONTRACTS_UPDATE
 * Payload: subscription contract (REST-shaped) — `admin_graphql_api_id`, `id`,
 * `status`, ...
 *
 * Re-syncs the mirror, then diffs the mirrored status before/after: a real
 * transition emits the specific canonical event (contract.paused / .cancelled
 * / .activated / .expired / .failed), anything else emits contract.updated.
 * An update for a contract we have never mirrored (catch-up) logs
 * contract.created instead.
 */
async function handleSubscriptionContractsUpdate({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const contractGid = contractGidFromPayload(payload);
  if (!contractGid) {
    console.warn(
      "[webhooks] SUBSCRIPTION_CONTRACTS_UPDATE without a contract id",
      webhookId,
    );
    return;
  }

  const before = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: contractGid },
    select: { status: true },
  });

  const { syncContractFromShopify } = await import(
    "~/lib/contracts/service.server"
  );
  await syncContractFromShopify(shopDomain, contractGid);

  const after = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: contractGid },
  });
  if (!after) {
    throw new Error(`Contract mirror missing after sync: ${contractGid}`);
  }

  const base = contractEventBase(shop.id, after);
  if (!before) {
    await logEvent({
      ...base,
      type: "contract.created",
      source: "WEBHOOK",
      payload: {
        shopifyContractId: contractGid,
        status: after.status,
        catchUp: true,
      },
    });
    return;
  }

  if (before.status !== after.status) {
    await logEvent({
      ...base,
      type: STATUS_EVENT[after.status] ?? "contract.updated",
      source: "WEBHOOK",
      payload: {
        shopifyContractId: contractGid,
        previousStatus: before.status,
        status: after.status,
      },
    });
  } else {
    await logEvent({
      ...base,
      type: "contract.updated",
      source: "WEBHOOK",
      payload: { shopifyContractId: contractGid, status: after.status },
    });
  }
}

// ── Billing attempts ─────────────────────────────────────────────────────────

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS
 * Payload: `admin_graphql_api_id`, `id`, `idempotency_key`, `order_id`,
 * `admin_graphql_api_order_id`, `subscription_contract_id`,
 * `admin_graphql_api_subscription_contract_id`, `ready`.
 *
 * The single success entry point for a billed cycle: settles the attempt
 * mirror, bumps contract counters, re-syncs nextBillingDate from Shopify
 * (authoritative), consumes cycle-scoped one-time add-on mirrors, flips this
 * cycle's gift grants ADDED → SHIPPED, notifies dunning + lifecycle, sends the
 * order confirmation and logs billing.attempt_succeeded +
 * billing.order_created.
 */
async function handleBillingAttemptSuccess({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const attempt = await resolveBillingAttempt(payload, webhookId);
  if (!attempt) return;

  const alreadySucceeded = attempt.status === "SUCCESS";
  const now = new Date();
  const admin = await getAdmin(shopDomain);

  const orderGid = toGid(
    "Order",
    pick(payload, "admin_graphql_api_order_id", "order_id"),
  );

  let amountCents = attempt.amountCents;
  let orderName = attempt.orderName;
  let orderCurrency = attempt.currencyCode;
  if (orderGid) {
    try {
      const summary = await getOrderSummary(admin, orderGid);
      amountCents = summary.totalCents;
      orderName = summary.name || orderName;
      orderCurrency = summary.currencyCode;
    } catch (err) {
      console.error("[webhooks] order summary fetch failed", orderGid, err);
    }
  }

  const updated = await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "SUCCESS",
      startedAt: attempt.startedAt ?? now,
      completedAt: attempt.completedAt ?? now,
      orderId: orderGid ?? attempt.orderId,
      orderName,
      amountCents,
      currencyCode: orderCurrency ?? attempt.contract.currencyCode,
    },
    include: { contract: true },
  });

  let contract = updated.contract;

  // Authoritative next billing date from Shopify (never computed locally).
  const resyncNextBillingDate = async () => {
    try {
      const remote = await getContract(admin, contract.shopifyContractId);
      contract = await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { nextBillingDate: remote.nextBillingDate },
      });
    } catch (err) {
      console.error(
        "[webhooks] nextBillingDate resync failed",
        contract.shopifyContractId,
        err,
      );
    }
  };

  if (alreadySucceeded) {
    // Manual replay (new webhook id, same attempt): refresh mirrors only —
    // counters, housekeeping, notifications and events already ran.
    await resyncNextBillingDate();
    return;
  }

  contract = await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: {
      ordersCount: { increment: 1 },
      lifetimeRevenueCents: { increment: amountCents ?? 0 },
      ...(contract.firstChargeAt ? {} : { firstChargeAt: now }),
    },
  });

  await resyncNextBillingDate();

  // One-time add-ons were billed cycle-scoped on Shopify (the cycle edit
  // expired with this charge) — only the local mirrors need clearing.
  const addonLines = await prisma.contractLine.findMany({
    where: { contractId: contract.id, isOneTimeAddon: true },
  });
  if (addonLines.length > 0) {
    await prisma.contractLine.deleteMany({
      where: { id: { in: addonLines.map((l) => l.id) } },
    });
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "cycle.addon_removed",
      source: "WEBHOOK",
      payload: {
        cycleIndex: updated.cycleIndex,
        titles: addonLines.map((l) => l.title),
        reason: "consumed_by_successful_cycle",
      },
    });
  }

  // Gifts attached to this cycle have now shipped with the order.
  await prisma.giftGrant.updateMany({
    where: {
      contractId: contract.id,
      cycleIndex: updated.cycleIndex,
      status: "ADDED",
    },
    data: { status: "SHIPPED" },
  });

  // Discount grant consumption: applyGrantToCycle (billing module) already
  // consumes a cycle when it applies the per-cycle edit pre-charge, so no
  // decrement happens here. If the billing module ever exposes a success-time
  // consumeGrantCycle hook, it owns the semantics and is invoked instead.
  await callOptionalHook(
    () => import("~/lib/billing/discounts.server"),
    "consumeGrantCycle",
    [contract.id, updated.cycleIndex],
    "billing.consumeGrantCycle",
  );

  // Dunning recovery bookkeeping — a failure here must surface (receipt
  // FAILED + alert-based recovery), so it is not swallowed.
  const { onBillingAttemptSucceeded } = await import(
    "~/lib/dunning/engine.server"
  );
  await onBillingAttemptSucceeded(updated.id);

  // Lifecycle milestones (surprise gifts, rewards, incentives) — contained.
  await callOptionalHook(
    () => import("~/lib/lifecycle/engine.server"),
    "onSuccessfulCycle",
    [contract, contract.ordersCount],
    "lifecycle.onSuccessfulCycle",
  );

  await sendNotification({
    shopId: shop.id,
    contractId: contract.id,
    template: "order_confirmed",
    vars: {
      cycleIndex: updated.cycleIndex,
      order_name: orderName ?? "",
      ...(amountCents != null
        ? {
            amount: formatMoney(
              amountCents,
              updated.currencyCode ?? contract.currencyCode,
              contract.locale,
            ),
          }
        : {}),
    },
  });

  const eventPayload = {
    attemptId: updated.id,
    shopifyAttemptId: updated.shopifyAttemptId,
    cycleIndex: updated.cycleIndex,
    attemptNumber: updated.attemptNumber,
    amountCents,
    orderId: orderGid,
    orderName,
  };
  await logEvent({
    ...contractEventBase(shop.id, contract),
    type: "billing.attempt_succeeded",
    source: "WEBHOOK",
    payload: eventPayload,
  });
  if (orderGid) {
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "billing.order_created",
      source: "WEBHOOK",
      payload: eventPayload,
    });
  }
}

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE
 * Payload: attempt fields as above plus `error_code`, `error_message`.
 *
 * Settles the attempt mirror as FAILED (raw error code/message only — the
 * decline taxonomy/category is the dunning module's job), logs
 * billing.attempt_failed and hands the attempt to the dunning engine.
 */
async function handleBillingAttemptFailure({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const attempt = await resolveBillingAttempt(payload, webhookId);
  if (!attempt) return;

  const alreadyFailed = attempt.status === "FAILED";
  const now = new Date();
  const errorCode = asString(payload.error_code);
  const errorMessage = asString(payload.error_message);

  const updated = await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "FAILED",
      startedAt: attempt.startedAt ?? now,
      completedAt: attempt.completedAt ?? now,
      errorCode: errorCode ?? attempt.errorCode,
      errorMessage: errorMessage ?? attempt.errorMessage,
    },
    include: { contract: true },
  });

  if (alreadyFailed) return; // replay — dunning already owns this failure

  await logEvent({
    ...contractEventBase(shop.id, updated.contract),
    type: "billing.attempt_failed",
    source: "WEBHOOK",
    payload: {
      attemptId: updated.id,
      shopifyAttemptId: updated.shopifyAttemptId,
      cycleIndex: updated.cycleIndex,
      attemptNumber: updated.attemptNumber,
      amountCents: updated.amountCents,
      errorCode: updated.errorCode,
      errorMessage: updated.errorMessage,
    },
  });

  const { onBillingAttemptFailed } = await import(
    "~/lib/dunning/engine.server"
  );
  await onBillingAttemptFailed(updated.id);
}

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED
 * Payload: attempt fields as above plus `redirect_url` (the 3DS challenge
 * page the customer must complete).
 *
 * Marks the attempt CHALLENGED and hands the redirect URL to the dunning
 * engine, which owns the 3DS link delivery.
 */
async function handleBillingAttemptChallenged({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const attempt = await resolveBillingAttempt(payload, webhookId);
  if (!attempt) return;

  const alreadyChallenged = attempt.status === "CHALLENGED";
  const now = new Date();
  const redirectUrl = asString(pick(payload, "redirect_url", "redirect_uri"));

  const updated = await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: { status: "CHALLENGED", startedAt: attempt.startedAt ?? now },
    include: { contract: true },
  });

  if (alreadyChallenged) return; // replay — 3DS flow already started

  await logEvent({
    ...contractEventBase(shop.id, updated.contract),
    type: "billing.attempt_challenged",
    source: "WEBHOOK",
    payload: {
      attemptId: updated.id,
      shopifyAttemptId: updated.shopifyAttemptId,
      cycleIndex: updated.cycleIndex,
      attemptNumber: updated.attemptNumber,
      redirectUrl,
    },
  });

  const { onBillingAttemptChallenged } = await import(
    "~/lib/dunning/engine.server"
  );
  await onBillingAttemptChallenged(updated.id, redirectUrl ?? undefined);
}

// ── Billing cycle edits ──────────────────────────────────────────────────────

/**
 * SUBSCRIPTION_BILLING_CYCLE_EDITS_{CREATE,UPDATE,DELETE}
 * Payload: billing cycle (REST-shaped) — `subscription_contract_id` /
 * `admin_graphql_api_subscription_contract_id`, `cycle_index`, `skipped`,
 * `billing_attempt_expected_date`, `cycle_start_at`, `cycle_end_at`.
 *
 * A cycle edit (skip/unskip/schedule change — possibly made in the Shopify
 * admin, outside this app) can move the contract's effective next billing
 * date, so the mirror is re-synced from getContract (authoritative) and a
 * contract.updated event records the edit.
 */
function makeBillingCycleEditHandler(
  action: "CREATE" | "UPDATE" | "DELETE",
): WebhookHandler {
  return async ({ shopDomain, payload, webhookId }) => {
    const shop = await requireShop(shopDomain);
    const contractGid = toGid(
      "SubscriptionContract",
      pick(
        payload,
        "admin_graphql_api_subscription_contract_id",
        "subscription_contract_id",
        "contract_id",
      ),
    );
    if (!contractGid) {
      console.warn(
        `[webhooks] SUBSCRIPTION_BILLING_CYCLE_EDITS_${action} without a contract id`,
        webhookId,
      );
      return;
    }
    const contract = await prisma.subscriptionContract.findUnique({
      where: { shopifyContractId: contractGid },
    });
    if (!contract) {
      console.warn(
        "[webhooks] cycle edit for unknown contract mirror",
        contractGid,
      );
      return;
    }

    const admin = await getAdmin(shopDomain);
    const remote = await getContract(admin, contractGid);
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: remote.nextBillingDate },
    });

    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "contract.updated",
      source: "WEBHOOK",
      payload: {
        cycleEdit: {
          action,
          cycleIndex: asNumber(pick(payload, "cycle_index", "index")),
          skipped: typeof payload.skipped === "boolean" ? payload.skipped : null,
          billingDate: asString(
            pick(
              payload,
              "billing_attempt_expected_date",
              "billing_date",
              "cycle_start_at",
            ),
          ),
        },
        nextBillingDate: remote.nextBillingDate?.toISOString() ?? null,
      },
    });
  };
}

// ── Customer payment methods ─────────────────────────────────────────────────

/**
 * CUSTOMER_PAYMENT_METHODS_{CREATE,UPDATE}
 * Payload: `admin_graphql_api_id` (payment method GID), `token`,
 * `customer_id`, `admin_graphql_api_customer_id`, `instrument_type`.
 *
 * Refreshes mirrored card metadata for every contract of the customer whose
 * payment method appears in listCustomerPaymentMethods, logs
 * contract.payment_method_updated when the method was directly touched or the
 * metadata actually changed, and pokes the dunning engine for contracts with
 * an open case (an updated card is the recovery moment).
 */
async function handlePaymentMethodUpsert({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const customerGid = toGid(
    "Customer",
    pick(payload, "admin_graphql_api_customer_id", "customer_id"),
  );
  if (!customerGid) {
    console.warn(
      "[webhooks] payment method webhook without customer id",
      webhookId,
    );
    return;
  }
  const methodGid = toGid(
    "CustomerPaymentMethod",
    pick(payload, "admin_graphql_api_id", "id"),
  );

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId: shop.id, customerId: customerGid },
  });
  if (contracts.length === 0) return;

  const admin = await getAdmin(shopDomain);
  const methods = await listCustomerPaymentMethods(admin, customerGid);

  for (const contract of contracts) {
    const method = contract.paymentMethodId
      ? (methods.find((m) => m.id === contract.paymentMethodId) ?? null)
      : null;
    if (!method) continue;

    const instrument = method.instrument;
    const card = {
      cardBrand: instrument?.brand ?? null,
      cardLast4: instrument?.lastDigits ?? null,
      cardExpiryMonth: instrument?.expiryMonth ?? null,
      cardExpiryYear: instrument?.expiryYear ?? null,
    };
    const changed =
      card.cardBrand !== contract.cardBrand ||
      card.cardLast4 !== contract.cardLast4 ||
      card.cardExpiryMonth !== contract.cardExpiryMonth ||
      card.cardExpiryYear !== contract.cardExpiryYear;
    const directHit =
      methodGid != null && methodGid === contract.paymentMethodId;
    if (!changed && !directHit) continue;

    if (changed) {
      await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: card,
      });
    }

    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "contract.payment_method_updated",
      source: "WEBHOOK",
      payload: {
        paymentMethodId: contract.paymentMethodId,
        brand: card.cardBrand,
        last4: card.cardLast4,
        expiryMonth: card.cardExpiryMonth,
        expiryYear: card.cardExpiryYear,
      },
    });

    const openCase = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, resolvedAt: null },
      select: { id: true },
    });
    if (openCase) {
      await callOptionalHook(
        () => import("~/lib/dunning/engine.server"),
        "onPaymentMethodUpdated",
        [contract.id],
        "dunning.onPaymentMethodUpdated",
      );
    }
  }
}

/**
 * CUSTOMER_PAYMENT_METHODS_REVOKE
 * Payload: `admin_graphql_api_id` (revoked payment method GID), `customer_id`.
 *
 * For every non-cancelled contract paying with the revoked method:
 * - backup method mirrored + `dunning.backupPaymentFallback` on → switch the
 *   Shopify contract to the backup via a contract-edit draft and promote the
 *   mirror (backup becomes primary);
 * - otherwise → payment_failed_1 notification ("Your card was removed") whose
 *   link bundle carries the one-tap update-card magic link.
 * Both paths log contract.payment_method_updated with `revoked: true`.
 */
async function handlePaymentMethodRevoke({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const methodGid = toGid(
    "CustomerPaymentMethod",
    pick(payload, "admin_graphql_api_id", "id"),
  );
  if (!methodGid) {
    console.warn(
      "[webhooks] CUSTOMER_PAYMENT_METHODS_REVOKE without method id",
      webhookId,
    );
    return;
  }

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      paymentMethodId: methodGid,
      status: { in: ["ACTIVE", "PAUSED", "FAILED"] },
    },
  });
  if (contracts.length === 0) return;

  const dunningSettings = await getSetting(shop.id, "dunning");
  const admin = await getAdmin(shopDomain);

  for (const contract of contracts) {
    const backupId = contract.backupPaymentMethodId;

    if (backupId && dunningSettings.backupPaymentFallback) {
      try {
        await withContractDraft(
          admin,
          contract.shopifyContractId,
          async (draftId, run) => {
            await draftUpdatePaymentMethod(run, draftId, backupId);
          },
        );

        let card = {
          cardBrand: null as string | null,
          cardLast4: null as string | null,
          cardExpiryMonth: null as number | null,
          cardExpiryYear: null as number | null,
        };
        try {
          const methods = await listCustomerPaymentMethods(
            admin,
            contract.customerId,
          );
          const backup = methods.find((m) => m.id === backupId);
          if (backup?.instrument) {
            card = {
              cardBrand: backup.instrument.brand,
              cardLast4: backup.instrument.lastDigits,
              cardExpiryMonth: backup.instrument.expiryMonth,
              cardExpiryYear: backup.instrument.expiryYear,
            };
          }
        } catch (err) {
          console.error(
            "[webhooks] backup card metadata fetch failed",
            contract.id,
            err,
          );
        }

        await prisma.subscriptionContract.update({
          where: { id: contract.id },
          data: {
            paymentMethodId: backupId,
            backupPaymentMethodId: null,
            ...card,
          },
        });

        await logEvent({
          ...contractEventBase(shop.id, contract),
          type: "contract.payment_method_updated",
          source: "WEBHOOK",
          payload: {
            revoked: true,
            usedBackup: true,
            revokedMethodId: methodGid,
            paymentMethodId: backupId,
          },
        });
        continue;
      } catch (err) {
        console.error(
          "[webhooks] backup payment switch failed, prompting customer",
          contract.id,
          err,
        );
        // fall through to the card prompt below
      }
    }

    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "contract.payment_method_updated",
      source: "WEBHOOK",
      payload: {
        revoked: true,
        usedBackup: false,
        revokedMethodId: methodGid,
      },
    });

    // payment_failed_1 is in the link-bundle set, so the notification carries
    // the one-tap update-card magic link automatically.
    await sendNotification({
      shopId: shop.id,
      contractId: contract.id,
      template: "payment_failed_1",
      vars: {
        decline_human: "Your card was removed",
        decline_code: "payment_method_revoked",
      },
    });
  }
}

// ── Orders ───────────────────────────────────────────────────────────────────

/**
 * The buy-box widget's design-attribution line property.
 *
 * It was named `_cx_design` up to v1.2.2 and was renamed together with the
 * widget's whole storefront namespace (the client's live store hosts another
 * vendor that owns "cx"). BOTH names are read, the current one preferred:
 * orders placed before the merchant updated the theme extension — and carts
 * that were already open at that moment — carry the old name, and take-rate
 * attribution must not develop a hole across the upgrade. Reading is all this
 * costs; the widget only ever writes the current name.
 */
const DESIGN_PROPERTY = "_cellexia_design";
/** Pre-v1.2.3 name of the same property — read-only backward compatibility. */
const DESIGN_PROPERTY_LEGACY = "_cx_design";

/** A line's design key under the current property, else the legacy one. */
export function designPropertyOf(li: Payload): string | null {
  return (
    lineProperty(li, DESIGN_PROPERTY) ?? lineProperty(li, DESIGN_PROPERTY_LEGACY)
  );
}

/**
 * ORDERS_CREATE
 * Payload: order (REST-shaped) — `id`, `admin_graphql_api_id`, `name`,
 * `email`, `line_items[]` (`product_id`, and — when Shopify includes them —
 * `selling_plan_allocation` / `selling_plan` / `selling_plan_id`).
 *
 * Take-rate denominator feed. Emits one "checkout.subscribable" event per
 * order that contained a subscribable product; the analytics daily rollup
 * counts these as takeRateDen (see app/lib/analytics/rollup.server.ts, which
 * defines this non-canonical type as its feed) and derives takeRateNum from
 * new contract mirrors, so nothing else is needed for the numerator.
 *
 * "Subscribable" approximation (documented): an order counts when a line item
 * carries any selling-plan marker (REST payloads do not always include one),
 * OR a line's product is listed in an active SellingPlanConfig.productIds.
 * Renewal orders are intentionally not treated specially here — their money
 * and events are owned by the billing-attempt webhooks — but they do count in
 * both numerator-eligible product sets, which slightly inflates the
 * denominator with renewal traffic; acceptable for a trend metric.
 *
 * Design attribution feed: the buy-box widget stamps subscription
 * add-to-carts with a hidden line property `_cellexia_design` = active design
 * preset key. When a line carries both that property and a selling-plan
 * marker, one "widget.design_attributed" event is logged per distinct design
 * key so analytics can report take-rate by design
 * (getDesignPerformance in app/lib/analytics/queries.server.ts). The type is
 * analytics-only: the Klaviyo events-map ignores unmapped types by design.
 * Both the current and the legacy property name are accepted — see
 * designPropertyOf above.
 */
async function handleOrdersCreate({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const lineItems = asArray(payload.line_items)
    .map(asRecord)
    .filter((li): li is Payload => li != null);
  if (lineItems.length === 0) return;

  const hasSellingPlanLine = lineItems.some(hasSellingPlanMarker);

  // ── Design attribution (_cellexia_design hidden line property) ────────────
  const orderGid = toGid("Order", pick(payload, "admin_graphql_api_id", "id"));
  const orderEmail = asString(pick(payload, "email", "contact_email"));
  const designKeys = new Set<string>();
  for (const li of lineItems) {
    if (!hasSellingPlanMarker(li)) continue; // one-time line: not a subscription add
    const designKey = designPropertyOf(li);
    if (designKey) designKeys.add(designKey);
  }
  for (const designKey of designKeys) {
    await logEvent({
      shopId: shop.id,
      email: orderEmail,
      type: "widget.design_attributed",
      source: "WEBHOOK",
      payload: { designKey, orderId: orderGid },
    });
  }

  let containsSubscribable = hasSellingPlanLine;
  if (!containsSubscribable) {
    const configs = await prisma.sellingPlanConfig.findMany({
      where: { shopId: shop.id, active: true },
      select: { productIds: true },
    });
    const subscribable = new Set<string>();
    for (const config of configs) {
      for (const pid of asArray(config.productIds)) {
        const s = asString(pid);
        if (s) subscribable.add(s);
      }
    }
    containsSubscribable = lineItems.some((li) => {
      const productGid = toGid("Product", pick(li, "product_id"));
      return productGid != null && subscribable.has(productGid);
    });
  }
  if (!containsSubscribable) return;

  await logEvent({
    shopId: shop.id,
    email: orderEmail,
    type: "checkout.subscribable",
    source: "WEBHOOK",
    payload: {
      orderId: orderGid,
      orderName: asString(payload.name),
      hasSellingPlanLine,
    },
  });
}

/** Any of the selling-plan markers REST order payloads may carry on a line. */
function hasSellingPlanMarker(li: Payload): boolean {
  return (
    li.selling_plan_allocation != null ||
    li.selling_plan != null ||
    li.selling_plan_id != null
  );
}

/**
 * A line-item property by name. REST payloads ship `properties` as an array of
 * `{name, value}` pairs; some serializations flatten it to a plain object —
 * both are handled. Returns null when absent or non-string.
 * Exported for tests (design-attribution parsing, tests/widget-design.test.ts).
 */
export function lineProperty(li: Payload, name: string): string | null {
  const props = li.properties;
  if (Array.isArray(props)) {
    for (const entry of props) {
      const rec = asRecord(entry);
      if (rec && asString(rec.name) === name) return asString(rec.value);
    }
    return null;
  }
  const rec = asRecord(props);
  return rec ? asString(rec[name]) : null;
}

/**
 * ORDERS_FULFILLED
 * Payload: order (REST-shaped) — `id`, `admin_graphql_api_id`, `name`,
 * `fulfillments[]` (`tracking_number`, `tracking_numbers[]`, `tracking_url`,
 * `tracking_urls[]`).
 *
 * Only renewal orders billed by this app (matched via BillingAttempt.orderId)
 * get the order_shipped notification — Shopify already notifies checkout
 * orders. Deduped per cycle via hasSentForCycle.
 */
async function handleOrdersFulfilled({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const orderGid = toGid("Order", pick(payload, "admin_graphql_api_id", "id"));
  if (!orderGid) return;

  const attempt = await prisma.billingAttempt.findFirst({
    where: { orderId: orderGid, contract: { shopId: shop.id } },
    include: { contract: true },
  });
  if (!attempt) return; // not one of our renewal orders

  if (await hasSentForCycle(attempt.contractId, "order_shipped", attempt.cycleIndex)) {
    return;
  }

  const fulfillment = asArray(payload.fulfillments)
    .map(asRecord)
    .find((f): f is Payload => f != null);
  const trackingNumber = fulfillment
    ? (asString(fulfillment.tracking_number) ??
      asString(asArray(fulfillment.tracking_numbers)[0]))
    : null;
  const trackingUrl = fulfillment
    ? (asString(fulfillment.tracking_url) ??
      asString(asArray(fulfillment.tracking_urls)[0]))
    : null;

  await sendNotification({
    shopId: shop.id,
    contractId: attempt.contractId,
    template: "order_shipped",
    vars: {
      cycleIndex: attempt.cycleIndex,
      order_name: attempt.orderName ?? asString(payload.name) ?? "",
      ...(trackingNumber ? { tracking_number: trackingNumber } : {}),
      ...(trackingUrl ? { tracking_url: trackingUrl } : {}),
    },
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

/**
 * APP_UNINSTALLED
 * Payload: shop (REST-shaped) — unused; the authenticated shop domain is
 * authoritative.
 *
 * Marks the Shop uninstalled and deletes its OAuth sessions (tokens are dead
 * the moment the app is removed). Mirror data is retained for reinstall.
 */
async function handleAppUninstalled({
  shopDomain,
}: WebhookHandlerContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop && shop.uninstalledAt == null) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { uninstalledAt: new Date() },
    });
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "WEBHOOK",
      payload: { action: "app_uninstalled", domain: shopDomain },
    });
  }
  await prisma.session.deleteMany({ where: { shop: shopDomain } });
}

/**
 * APP_SCOPES_UPDATE
 * Payload: `current` — array of the scopes now granted.
 *
 * Keeps stored session scopes in sync (Shopify app template convention).
 */
async function handleAppScopesUpdate({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const current = asArray(payload.current)
    .map(asString)
    .filter((s): s is string => s != null);
  if (current.length === 0) return;
  await prisma.session.updateMany({
    where: { shop: shopDomain },
    data: { scope: current.join(",") },
  });
}

// ── GDPR (mandatory compliance topics) ───────────────────────────────────────

/**
 * CUSTOMERS_DATA_REQUEST
 * Payload: `customer` ({ id, email, phone }), `orders_requested[]`,
 * `data_request` ({ id }).
 *
 * Raises an INFO alert for the operator (export steps live in
 * docs/OPERATIONS.md; a 30-day deadline applies) and logs admin.action.
 */
async function handleCustomersDataRequest({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) {
    console.warn("[webhooks] CUSTOMERS_DATA_REQUEST for unknown shop", shopDomain);
    return;
  }
  const customer = asRecord(payload.customer) ?? {};
  const customerGid = toGid(
    "Customer",
    pick(customer, "admin_graphql_api_id", "id"),
  );
  const email = asString(customer.email);

  const context = JSON.parse(
    JSON.stringify({
      customerId: customerGid,
      email,
      ordersRequested: asArray(payload.orders_requested),
      dataRequestId: asRecord(payload.data_request)?.id ?? null,
    }),
  ) as object;

  await prisma.alert.create({
    data: {
      shopId: shop.id,
      type: "GDPR_DATA_REQUEST",
      severity: "INFO",
      message: `GDPR data request for ${email ?? customerGid ?? "unknown customer"} — export their data per docs/OPERATIONS.md (30-day deadline).`,
      context,
    },
  });

  await logEvent({
    shopId: shop.id,
    customerId: customerGid,
    email,
    type: "admin.action",
    source: "WEBHOOK",
    payload: { action: "customers_data_request", customerId: customerGid },
  });
}

/**
 * CUSTOMERS_REDACT
 * Payload: `customer` ({ id, email }), `orders_to_redact[]`.
 *
 * Anonymizes PII while keeping financial records intact:
 * - SubscriptionContract: email → "redacted+{customerId}@example.invalid",
 *   names/phone/deliveryAddress nulled.
 * - SubscriberEvent + NotificationLog: email redacted, phone nulled.
 * - MagicLinkToken / OtpCode / PortalSession rows for the identity deleted
 *   (a redacted customer must not retain live login artifacts).
 * BillingAttempt / DunningCase / revenue counters are retained (legitimate
 * financial records). Raises an INFO alert and logs admin.action.
 */
async function handleCustomersRedact({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) {
    console.warn("[webhooks] CUSTOMERS_REDACT for unknown shop", shopDomain);
    return;
  }
  const customer = asRecord(payload.customer) ?? {};
  const customerGid = toGid(
    "Customer",
    pick(customer, "admin_graphql_api_id", "id"),
  );
  const originalEmail = asString(customer.email);
  const numericId =
    asNumber(customer.id) ?? asString(customer.id) ?? webhookId;
  const redactedEmail = `redacted+${numericId}@example.invalid`;

  const contractFilters: Prisma.SubscriptionContractWhereInput[] = [];
  if (customerGid) contractFilters.push({ customerId: customerGid });
  if (originalEmail) contractFilters.push({ email: originalEmail });
  if (contractFilters.length === 0) {
    console.warn("[webhooks] CUSTOMERS_REDACT without customer identity", webhookId);
    return;
  }

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId: shop.id, OR: contractFilters },
    select: { id: true },
  });
  const contractIds = contracts.map((c) => c.id);

  if (contractIds.length > 0) {
    await prisma.subscriptionContract.updateMany({
      where: { id: { in: contractIds } },
      data: {
        email: redactedEmail,
        firstName: null,
        lastName: null,
        phone: null,
        deliveryAddress: Prisma.JsonNull,
      },
    });
  }

  const eventFilters: Prisma.SubscriberEventWhereInput[] = [];
  if (customerGid) eventFilters.push({ customerId: customerGid });
  if (originalEmail) eventFilters.push({ email: originalEmail });
  if (contractIds.length > 0) eventFilters.push({ contractId: { in: contractIds } });
  await prisma.subscriberEvent.updateMany({
    where: { shopId: shop.id, OR: eventFilters },
    data: { email: redactedEmail },
  });

  const notificationFilters: Prisma.NotificationLogWhereInput[] = [];
  if (originalEmail) notificationFilters.push({ email: originalEmail });
  if (contractIds.length > 0) {
    notificationFilters.push({ contractId: { in: contractIds } });
  }
  if (notificationFilters.length > 0) {
    await prisma.notificationLog.updateMany({
      where: { shopId: shop.id, OR: notificationFilters },
      data: { email: redactedEmail, phone: null },
    });
  }

  // Live login/link artifacts die with the identity.
  if (originalEmail) {
    await prisma.otpCode.deleteMany({ where: { email: originalEmail } });
  }
  const sessionFilters: Prisma.PortalSessionWhereInput[] = [];
  if (originalEmail) sessionFilters.push({ email: originalEmail });
  if (customerGid) sessionFilters.push({ customerId: customerGid });
  if (sessionFilters.length > 0) {
    await prisma.portalSession.deleteMany({ where: { OR: sessionFilters } });
  }
  const tokenFilters: Prisma.MagicLinkTokenWhereInput[] = [];
  if (originalEmail) tokenFilters.push({ email: originalEmail });
  if (customerGid) tokenFilters.push({ customerId: customerGid });
  if (contractIds.length > 0) tokenFilters.push({ contractId: { in: contractIds } });
  if (tokenFilters.length > 0) {
    await prisma.magicLinkToken.deleteMany({ where: { OR: tokenFilters } });
  }

  await prisma.alert.create({
    data: {
      shopId: shop.id,
      type: "GDPR_CUSTOMER_REDACT",
      severity: "INFO",
      message: `GDPR redact completed for ${customerGid ?? redactedEmail}: ${contractIds.length} contract(s) anonymized; financial records retained.`,
      context: { customerId: customerGid, contractIds } as object,
    },
  });

  await logEvent({
    shopId: shop.id,
    customerId: customerGid,
    email: redactedEmail,
    type: "admin.action",
    source: "WEBHOOK",
    payload: { action: "customers_redact", contractsAnonymized: contractIds.length },
  });
}

/**
 * SHOP_REDACT
 * Payload: `shop_id`, `shop_domain`. Arrives 48h after uninstall.
 *
 * Raises a CRITICAL alert: all shop data must be purged within 48 hours per
 * docs/OPERATIONS.md. The purge itself is a deliberate operator action (it
 * destroys the entire mirror), never an automatic webhook side effect.
 */
async function handleShopRedact({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const domain = asString(payload.shop_domain) ?? shopDomain;
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) {
    console.warn("[webhooks] SHOP_REDACT for unknown shop", domain);
    return;
  }
  await prisma.alert.create({
    data: {
      shopId: shop.id,
      type: "GDPR_SHOP_REDACT",
      severity: "CRITICAL",
      message:
        "SHOP_REDACT received — purge all data for this shop within 48 hours per docs/OPERATIONS.md.",
      context: { domain },
    },
  });
  await logEvent({
    shopId: shop.id,
    type: "admin.action",
    source: "WEBHOOK",
    payload: { action: "shop_redact", domain },
  });
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const webhookHandlers: Record<string, WebhookHandler> = {
  SUBSCRIPTION_CONTRACTS_CREATE: handleSubscriptionContractsCreate,
  SUBSCRIPTION_CONTRACTS_UPDATE: handleSubscriptionContractsUpdate,
  SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS: handleBillingAttemptSuccess,
  SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE: handleBillingAttemptFailure,
  SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED: handleBillingAttemptChallenged,
  SUBSCRIPTION_BILLING_CYCLE_EDITS_CREATE: makeBillingCycleEditHandler("CREATE"),
  SUBSCRIPTION_BILLING_CYCLE_EDITS_UPDATE: makeBillingCycleEditHandler("UPDATE"),
  SUBSCRIPTION_BILLING_CYCLE_EDITS_DELETE: makeBillingCycleEditHandler("DELETE"),
  CUSTOMER_PAYMENT_METHODS_CREATE: handlePaymentMethodUpsert,
  CUSTOMER_PAYMENT_METHODS_UPDATE: handlePaymentMethodUpsert,
  CUSTOMER_PAYMENT_METHODS_REVOKE: handlePaymentMethodRevoke,
  ORDERS_CREATE: handleOrdersCreate,
  ORDERS_FULFILLED: handleOrdersFulfilled,
  APP_UNINSTALLED: handleAppUninstalled,
  APP_SCOPES_UPDATE: handleAppScopesUpdate,
  CUSTOMERS_DATA_REQUEST: handleCustomersDataRequest,
  CUSTOMERS_REDACT: handleCustomersRedact,
  SHOP_REDACT: handleShopRedact,
};
