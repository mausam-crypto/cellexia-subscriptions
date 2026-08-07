import { Prisma, type SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { requireShop } from "~/lib/shop/install.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { buildMitEvidence } from "~/lib/billing/mit-evidence.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";
import {
  hasSentForCycle,
  sendNotification,
} from "~/lib/notifications/send.server";
import {
  type AdminClient,
  draftUpdatePaymentMethod,
  getBillingCycleByDate,
  getContract,
  getOrderSummary,
  listCustomerPaymentMethods,
  withContractDraft,
} from "~/lib/graphql/index.server";
import {
  buildAcquisitionCapture,
  timeToPurchaseSeconds,
  type AcquisitionCapture,
} from "~/lib/acquisition/sanitize";

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

/**
 * How far back a settling success may backdate completedAt/firstChargeAt to
 * the order's real charge instant (its createdAt). 24h: with rollup_run
 * re-upserting the last ROLLUP_RECOMPUTE_DAYS (=2) days on every tick, a
 * charge backdated ≤24h sits in a day that is at most 2 days old by the next
 * tick — still inside the recompute window, so it can never be stranded in a
 * closed DailyRollup row. Same constant lives in billing/scheduler.server.ts
 * for the stale sweep.
 */
const MAX_CHARGE_BACKDATE_MS = 86_400_000;

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
 *    complete; originatingAction ADMIN_MANUAL marks its provenance. Its
 *    cycleIndex is resolved in Shopify billing-cycle space (see inline
 *    comment) so cycle-scoped settlement matches add-on mirrors and gifts.
 *
 * Returns null (after a console warning) when nothing can be resolved — the
 * webhook is then acknowledged without effect.
 */
async function resolveBillingAttempt(
  shopDomain: string,
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

  // Reaching here means no local row matched by attempt id OR idempotency key:
  // this app did not originate the charge. On a contract we do not own, that
  // is the OTHER subscription app charging its own subscriber —
  // SUBSCRIPTION_BILLING_ATTEMPTS_* fires for every contract on the shop,
  // whoever created it, and the client's store runs Joy alongside us.
  //
  // Reconstructing a BillingAttempt for it would put another app's charge on
  // our book: the success handler increments ordersCount and
  // lifetimeRevenueCents on the mirror, the row sits in the PENDING gauge the
  // health endpoint reads, and every foreign renewal would cost us a Shopify
  // order-summary round trip. UNKNOWN fails safe the same way — our scheduler
  // only ever charges OURS, so an attempt we did not originate on a contract
  // we cannot vouch for is never ours to record.
  //
  // Attempts we DID originate are untouched: they matched by shopifyAttemptId
  // or idempotencyKey and returned above. So does the one case this
  // reconstruction path exists for — a merchant manually charging one of OUR
  // contracts from the Shopify admin.
  if (!isBillableOwnership(contract.ownership)) {
    console.warn(
      "[webhooks] ignoring billing attempt for non-owned contract",
      contract.shopifyContractId,
      contract.ownership,
    );
    return null;
  }

  // The reconstructed row's cycleIndex must live in SHOPIFY billing-cycle
  // space, not ordersCount space. Everything cycle-scoped that this attempt
  // will settle against was stamped from getBillingCycleByDate — one-time
  // add-on mirrors (addonCycleIndex, consumed by consumeCycleOnSuccess's
  // exact-index match) and gift grants (ADDED → SHIPPED flip, same helper).
  // Shopify cycle indexes diverge from ordersCount permanently after any
  // skipped or unbilled cycle (a skipped cycle keeps its index — see the
  // winback engine's identical resolution), so ordersCount + 1 on a diverged
  // contract settles the wrong cycle: the customer pays for the staged
  // add-on, yet its mirror row survives forever and its addClaimKey blocks
  // every future staging of that variant. The local mirror's nextBillingDate
  // still points inside the cycle being billed here (it is only re-synced
  // after settlement), so the cycle containing it is the billed cycle —
  // the same date addOneTimeAddon resolved against when it staged the
  // add-on. ordersCount + 1 remains the fallback when the read fails or no
  // billing date is mirrored.
  let cycleIndex = contract.ordersCount + 1;
  if (contract.nextBillingDate) {
    try {
      const admin = await getAdmin(shopDomain);
      const cycle = await getBillingCycleByDate(
        admin,
        contract.shopifyContractId,
        contract.nextBillingDate,
      );
      if (cycle) cycleIndex = cycle.cycleIndex;
    } catch (err) {
      console.error(
        "[webhooks] billed-cycle read failed for reconstructed attempt — falling back to ordersCount space",
        contract.shopifyContractId,
        err,
      );
    }
  }

  return prisma.billingAttempt.create({
    data: {
      contractId: contract.id,
      shopifyAttemptId: attemptGid,
      idempotencyKey: idempotencyKey ?? `webhook:${attemptGid ?? webhookId}`,
      cycleIndex,
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
 * of contract mirrors — which also captures the origin order's money fields
 * for owned contracts), backfills the locale from the Shopify customer, logs
 * the canonical contract.created event (this is also the take-rate numerator
 * feed — analytics counts new contract mirrors as takeRateNum), picks up the
 * origin order's stashed acquisition bundle when its ORDERS_CREATE arrived
 * first (see enrichAcquisitionOnContractCreate), delivers the plan-configured
 * first-order gift onto the origin order and schedules gifts for the first
 * two cycles.
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
  // On a fresh contract cycle N bills order N (nothing can have been skipped
  // yet), so both index spaces are passed explicitly aligned — ensure(2)'s
  // order number must not be recomputed from ordersCount later, when a bump
  // could have moved it.
  try {
    const { ensureGiftsForUpcomingCycle } = await import(
      "~/lib/gifts/engine.server"
    );
    await ensureGiftsForUpcomingCycle(contract.id, 1, 1);
    await ensureGiftsForUpcomingCycle(contract.id, 2, 2);
  } catch (err) {
    console.error("[webhooks] gift scheduling failed", contract.id, err);
  }

  // Acquisition enrichment: persist the origin order's stashed bundle (when
  // its ORDERS_CREATE already arrived) + time-to-purchase from the Shopify
  // customer's createdAt. Guarded: acquisition never fails a webhook.
  try {
    await enrichAcquisitionOnContractCreate(shopDomain, shop.id, contract.id);
  } catch (err) {
    console.error("[webhooks] acquisition enrichment failed", contract.id, err);
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
    // The create webhook that would have picked up the stashed acquisition
    // bundle was lost — this catch-up IS the contract's create moment, so run
    // the same pickup here or the bundle sits in the event log while the acq*
    // columns stay null forever. Guarded like every enrichment: acquisition
    // never fails a webhook.
    try {
      await enrichAcquisitionOnContractCreate(shopDomain, shop.id, after.id);
    } catch (err) {
      console.error(
        "[webhooks] catch-up acquisition enrichment failed",
        after.id,
        err,
      );
    }
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
 * Cycle-consumption accounting a settled charge owes the local mirror:
 * one-time add-on mirror lines are cleared (they were billed cycle-scoped on
 * Shopify — the cycle edit expired with this charge) and this cycle's gift
 * grants flip ADDED → SHIPPED (they rode along on the order).
 *
 * MUST run inside the claim transaction of WHICHEVER writer wins the
 * → SUCCESS transition — the webhook delivery (handleBillingAttemptSuccess)
 * or the stale-attempt sweep (billing/scheduler.server.ts resolveStaleAttempt)
 * — and never in the redrive tail. Leaving it out of a claim winner is worse:
 * the stale mirror row shows a phantom "with your next order" add-on forever
 * AND its addClaimKey blocks every future addOneTimeAddon for that variant as
 * an "already staged" no-op.
 *
 * The clear is CYCLE-scoped (migration 0012): only mirrors staged onto the
 * settling cycle (addonCycleIndex === cycleIndex) are consumed. A contract-
 * scoped clear used to delete an add-on the customer staged for cycle N+1
 * during cycle N's in-flight window (nextBillingDate advances optimistically
 * at attempt creation, so addOneTimeAddon targets N+1 the moment the attempt
 * exists — hours wide when a lost success webhook leaves the attempt to the
 * stale sweep). The N+1 Shopify cycle edit survived while its mirror (and
 * addClaimKey) vanished: the customer was charged with nothing to remove in
 * the portal, and the freed claim key let the same variant be staged — and
 * paid for — twice. Legacy rows with NULL addonCycleIndex (staged before the
 * column existed) keep the old cleared-on-any-settlement behavior.
 */
export async function consumeCycleOnSuccess(
  tx: Prisma.TransactionClient,
  contractId: string,
  cycleIndex: number,
): Promise<{ addonTitles: string[] }> {
  const addonLines = await tx.contractLine.findMany({
    where: {
      contractId,
      isOneTimeAddon: true,
      OR: [{ addonCycleIndex: cycleIndex }, { addonCycleIndex: null }],
    },
  });
  if (addonLines.length > 0) {
    await tx.contractLine.deleteMany({
      where: { id: { in: addonLines.map((l) => l.id) } },
    });
  }

  // Gifts attached to this cycle have now shipped with the order.
  await tx.giftGrant.updateMany({
    where: { contractId, cycleIndex, status: "ADDED" },
    data: { status: "SHIPPED" },
  });

  return { addonTitles: addonLines.map((l) => l.title) };
}

/**
 * The post-claim tail of a success settlement: grant-consumption hook,
 * dunning close, lifecycle milestones, order confirmation and the
 * billing.attempt_succeeded / billing.order_created events — everything a
 * settled charge owes the rest of the system that does NOT have to commit
 * atomically with the claim. Shared by the first delivery (redrive=false)
 * and by the replay path re-driving a half-settled attempt (redrive=true).
 *
 * CRASH CONTRACT: settledAt is stamped LAST — the success-side analogue of
 * the failure path's declineCategory-written-last marker. If the process
 * dies anywhere in this tail, the attempt stays SUCCESS + settledAt NULL and
 * the next redelivery re-drives the whole tail. Every step is idempotent so
 * a redrive can never double-book:
 *  - consumeGrantCycle: optional hook (owner of its own semantics; absent
 *    today — applyGrantToCycle consumes pre-charge);
 *  - onBillingAttemptSucceeded: status guard + open-case check + attemptId
 *    dedupe on its retry_succeeded event (dunning engine);
 *  - onSuccessfulCycle: dedupes on ordersCount events by design;
 *  - order confirmation: hasSentForCycle guard on the redrive path;
 *  - events: attemptId-keyed existence check on the redrive path (the first
 *    delivery just won the claim atomically, so no prior events can exist).
 */
export async function finishSuccessSettlement(
  shopId: string,
  attemptId: string,
  {
    redrive,
    source = "WEBHOOK",
    resolvedBy,
  }: {
    redrive: boolean;
    /**
     * Which claim winner is driving the tail. The webhook delivery logs its
     * events as WEBHOOK; the stale-attempt sweep (billing/scheduler.server.ts)
     * settles the same attempt via the Shopify status query and logs SCHEDULER
     * — same tail, two entry points, so a lost success webhook can never
     * strand the settlement bookkeeping.
     */
    source?: "WEBHOOK" | "SCHEDULER";
    /** Extra payload marker for sweep-resolved settlements ("stale_sweep"). */
    resolvedBy?: string;
  },
): Promise<void> {
  const updated = await prisma.billingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { contract: true },
  });
  const contract = updated.contract;

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

  const alreadyConfirmed =
    redrive &&
    (await hasSentForCycle(contract.id, "order_confirmed", updated.cycleIndex));
  if (!alreadyConfirmed) {
    await sendNotification({
      shopId,
      contractId: contract.id,
      template: "order_confirmed",
      vars: {
        cycleIndex: updated.cycleIndex,
        order_name: updated.orderName ?? "",
        ...(updated.amountCents != null
          ? {
              amount: formatMoney(
                updated.amountCents,
                updated.currencyCode ?? contract.currencyCode,
                contract.locale,
              ),
            }
          : {}),
      },
    });
  }

  const alreadyLogged =
    redrive &&
    (await prisma.subscriberEvent.findFirst({
      where: {
        shopId,
        type: "billing.attempt_succeeded",
        payload: { path: ["attemptId"], equals: updated.id },
      },
      select: { id: true },
    })) != null;
  if (!alreadyLogged) {
    const eventPayload = {
      attemptId: updated.id,
      shopifyAttemptId: updated.shopifyAttemptId,
      cycleIndex: updated.cycleIndex,
      attemptNumber: updated.attemptNumber,
      amountCents: updated.amountCents,
      orderId: updated.orderId,
      orderName: updated.orderName,
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    await logEvent({
      ...contractEventBase(shopId, contract),
      type: "billing.attempt_succeeded",
      source,
      payload: eventPayload,
    });
    if (updated.orderId) {
      await logEvent({
        ...contractEventBase(shopId, contract),
        type: "billing.order_created",
        source,
        payload: eventPayload,
      });
    }
  }

  // Marker LAST: every side effect above has now run to completion at least
  // once. Only from here on may a replay take the mirror-refresh-only path.
  await prisma.billingAttempt.update({
    where: { id: attemptId },
    data: { settledAt: new Date() },
  });
}

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
 *
 * Crash safety: the status claim and the local ACCOUNTING it authorises
 * (contract counters, add-on mirror clearing, gift flip) commit in ONE
 * transaction, so no process death can separate them. The remaining side
 * effects run in finishSuccessSettlement, which stamps settledAt LAST — a
 * redelivery of a SUCCESS attempt with settledAt still NULL re-drives that
 * tail instead of returning (see the marker contract on the helper).
 */
async function handleBillingAttemptSuccess({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const attempt = await resolveBillingAttempt(shopDomain, payload, webhookId);
  if (!attempt) return;

  const now = new Date();
  const admin = await getAdmin(shopDomain);

  let contract = attempt.contract;

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

  if (attempt.status === "SUCCESS") {
    // Manual replay (new webhook id, same already-settled attempt).
    // amountCents is deliberately NOT re-read from the order here: after a
    // refund, currentTotalPriceSet is the REDUCED total while refundedCents
    // is subtracted separately by rollups/cohorts, so overwriting the
    // originally charged amount would double-count the refund. The charge
    // history row is immutable once SUCCESS.
    //
    // settledAt set: the original delivery finished every side effect —
    // refresh the Shopify-owned mirror only. settledAt NULL: the process
    // died between the settlement transaction committing and the marker
    // being stamped, and this redelivery is the ONLY thing that can re-drive
    // the missing bookkeeping (dunning close, confirmation, events) — the
    // same recovery contract the failure path has always had.
    if (attempt.settledAt == null) {
      await finishSuccessSettlement(shop.id, attempt.id, { redrive: true });
    }
    await resyncNextBillingDate();
    return;
  }

  const orderGid = toGid(
    "Order",
    pick(payload, "admin_graphql_api_order_id", "order_id"),
  );

  let amountCents = attempt.amountCents;
  let orderName = attempt.orderName;
  let orderCurrency = attempt.currencyCode;
  // The charge instant. The order's createdAt is when Shopify actually
  // charged the card; webhook-arrival time (`now`) is only the fallback.
  // Stamping `now` on a delayed webhook shifts the charge into the NEXT
  // rollup day and, for a first charge, possibly the next cohort month
  // (audit: day-boundary drift). Backdating is capped at
  // MAX_CHARGE_BACKDATE_MS so the charge's true day is always still inside
  // rollup_run's trailing recompute window — an unbounded backdate (manual
  // redelivery days later) would strand the charge in a closed rollup row
  // that is never recomputed.
  let chargedAt = now;
  if (orderGid) {
    try {
      const summary = await getOrderSummary(admin, orderGid);
      amountCents = summary.totalCents;
      orderName = summary.name || orderName;
      orderCurrency = summary.currencyCode;
      if (
        summary.createdAt != null &&
        now.getTime() - summary.createdAt.getTime() <= MAX_CHARGE_BACKDATE_MS
      ) {
        chargedAt = summary.createdAt;
      }
    } catch (err) {
      console.error("[webhooks] order summary fetch failed", orderGid, err);
    }
  }

  // Atomic claim of the → SUCCESS transition PLUS the local accounting it
  // authorises, in ONE transaction. The status guard in the WHERE makes
  // exactly ONE delivery win when the same success arrives twice under two
  // DIFFERENT webhook ids concurrently (route receipts only dedupe exact
  // webhook-id redeliveries): the loser's UPDATE matches zero rows and takes
  // the replay path below, so ordersCount / lifetimeRevenueCents can never
  // double-increment from a duplicated delivery. And because the counter
  // increment, the add-on mirror clearing and the gift flip commit with the
  // claim, a process death can never strand a SUCCESS attempt whose
  // accounting is lost forever — the pre-transaction bug this replaces.
  const settled = await prisma.$transaction(async (tx) => {
    const claimed = await tx.billingAttempt.updateMany({
      where: { id: attempt.id, status: { not: "SUCCESS" } },
      data: {
        status: "SUCCESS",
        startedAt: attempt.startedAt ?? now,
        completedAt: attempt.completedAt ?? chargedAt,
        orderId: orderGid ?? attempt.orderId,
        orderName,
        amountCents,
        currencyCode: orderCurrency ?? attempt.contract.currencyCode,
      },
    });
    if (claimed.count === 0) return null;

    const row = await tx.billingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      include: { contract: true },
    });

    // One-time add-on mirror clearing + gift ADDED → SHIPPED — shared with
    // the stale-attempt sweep's claim transaction (same helper, same rules).
    const { addonTitles } = await consumeCycleOnSuccess(
      tx,
      row.contract.id,
      row.cycleIndex,
    );

    const contractRow = await tx.subscriptionContract.update({
      where: { id: row.contract.id },
      data: {
        ordersCount: { increment: 1 },
        lifetimeRevenueCents: { increment: amountCents ?? 0 },
        ...(row.contract.firstChargeAt ? {} : { firstChargeAt: chargedAt }),
      },
    });
    return {
      cycleIndex: row.cycleIndex,
      contract: contractRow,
      addonTitles,
    };
  });
  if (!settled) {
    // Lost the race to a concurrent duplicate delivery: that delivery owns
    // the counters and every side effect. Mirror refresh only.
    await resyncNextBillingDate();
    return;
  }
  contract = settled.contract;

  await resyncNextBillingDate();

  if (settled.addonTitles.length > 0) {
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "cycle.addon_removed",
      source: "WEBHOOK",
      payload: {
        cycleIndex: settled.cycleIndex,
        titles: settled.addonTitles,
        reason: "consumed_by_successful_cycle",
      },
    });
  }

  // Everything that does not have to commit with the claim — dunning close,
  // lifecycle, order confirmation, events — plus the settledAt marker,
  // stamped LAST (see the crash contract on the helper).
  await finishSuccessSettlement(shop.id, attempt.id, { redrive: false });
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
  const attempt = await resolveBillingAttempt(shopDomain, payload, webhookId);
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

  if (!alreadyFailed) {
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
  }

  // ALWAYS hand off to the dunning engine — even on redelivery. The engine
  // owns the real "already processed" marker (attempt FAILED + declineCategory
  // set, written LAST): if the process died between the attempt update above
  // and the engine finishing (case/retry state incomplete), the redelivered
  // webhook is the only thing that can re-drive it. Guarding here on
  // `alreadyFailed` would defeat exactly that recovery.
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
 *
 * CHALLENGED is strictly a forward transition from PENDING (status-guarded
 * claim, same one-writer rule as the success path): Shopify may retry a
 * CHALLENGED delivery long after the customer completed 3DS and the SUCCESS
 * webhook settled the attempt. An unguarded write here would flip a settled
 * SUCCESS back to CHALLENGED — reopening dunning for a PAID cycle, emailing
 * the customer a 3DS link for a charge that already went through, and
 * re-arming the success path's status≠SUCCESS claim so a replayed SUCCESS
 * could double-increment ordersCount/lifetimeRevenueCents. A lost claim
 * (already CHALLENGED = replay, or settled SUCCESS/FAILED/EXPIRED = stale)
 * skips the dunning hand-off entirely.
 */
async function handleBillingAttemptChallenged({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const attempt = await resolveBillingAttempt(shopDomain, payload, webhookId);
  if (!attempt) return;

  const now = new Date();
  const redirectUrl = asString(pick(payload, "redirect_url", "redirect_uri"));

  const claimed = await prisma.billingAttempt.updateMany({
    where: { id: attempt.id, status: "PENDING" },
    data: { status: "CHALLENGED", startedAt: attempt.startedAt ?? now },
  });
  if (claimed.count === 0) return; // replay or already settled — never stomp

  const updated = await prisma.billingAttempt.findUniqueOrThrow({
    where: { id: attempt.id },
    include: { contract: true },
  });

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

    // Poke dunning when a case is open — OR when the contract sits FAILED
    // after an exhausted ladder. EXHAUSTED cases always have resolvedAt set,
    // so gating on open cases alone would make the engine's reopen-EXHAUSTED
    // recovery path unreachable: a customer who fixes their card via the
    // emailed link would stay FAILED forever while believing it's resolved.
    // onPaymentMethodUpdated itself handles both branches.
    const openCase = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, resolvedAt: null },
      select: { id: true },
    });
    if (openCase || contract.status === "FAILED") {
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

// ── Acquisition capture (data foundation — docs/DATA_FOUNDATION.md) ──────────

/**
 * Non-canonical stash event: the sanitized acquisition bundle of a
 * subscription-origin order, keyed by payload.orderId. ORDERS_CREATE and
 * SUBSCRIPTION_CONTRACTS_CREATE arrive in either order, so the bundle is
 * stashed here and whichever side finds both halves persists it onto the
 * contract. Analytics-only plumbing: the Klaviyo events-map ignores unmapped
 * types by design, and CUSTOMERS_REDACT scrubs these payloads.
 */
const ACQUISITION_EVENT = "acquisition.captured";

/**
 * Sanitized acquisition bundle from an ORDERS_CREATE payload. All the privacy
 * rules live in the pure sanitizer (app/lib/acquisition/sanitize.ts): URLs
 * keep host + path + utm_* only, the user agent is reduced to a device class
 * and dropped, no raw IP is ever read, every field is length-capped.
 */
function acquisitionFromOrderPayload(
  payload: Payload,
  lineItems: Payload[],
  orderGid: string | null,
): AcquisitionCapture {
  const clientDetails = asRecord(payload.client_details);
  const address =
    asRecord(payload.shipping_address) ?? asRecord(payload.billing_address) ?? {};
  const units = lineItems.reduce(
    (sum, li) => sum + Math.max(0, asNumber(li.quantity) ?? 0),
    0,
  );
  const processedAtRaw = asString(pick(payload, "processed_at", "created_at"));
  const processedAt = processedAtRaw ? new Date(processedAtRaw) : null;
  return buildAcquisitionCapture({
    referringSite: payload.referring_site,
    landingSite: payload.landing_site,
    sourceName: payload.source_name,
    userAgent: clientDetails?.user_agent,
    countryCode: address.country_code,
    city: address.city,
    provinceCode: address.province_code,
    unitsFirstOrder: units > 0 ? units : null,
    orderId: orderGid,
    orderTotalCents: centsFromAmountString(pick(payload, "total_price")),
    orderCurrencyCode: asString(payload.currency),
    orderProcessedAt:
      processedAt && !Number.isNaN(processedAt.getTime()) ? processedAt : null,
  });
}

/**
 * Persist a sanitized acquisition capture onto a contract mirror. Idempotent
 * (only fills while acqRaw is still SQL-null, claimed atomically) and
 * ours-only — another app's subscriber is not ours to profile, and UNKNOWN
 * fails safe the same way. Enriches with the Shopify customer's createdAt so
 * acqTimeToPurchaseSeconds (account creation → origin payment) can be
 * computed. Returns true when this call performed the write.
 */
async function applyAcquisitionToContract(
  shopId: string,
  contract: SubscriptionContract,
  capture: AcquisitionCapture,
  admin: AdminClient | null,
): Promise<boolean> {
  if (!isBillableOwnership(contract.ownership)) return false;
  if (contract.acqRaw != null) return false;

  let customerCreatedAt: Date | null = null;
  let customerNumberOfOrders: number | null = null;
  if (admin && contract.customerId) {
    try {
      const { getCustomer } = await import("~/lib/graphql/customers.server");
      const customer = await getCustomer(admin, contract.customerId);
      customerCreatedAt = customer?.createdAt ?? null;
      customerNumberOfOrders = customer?.numberOfOrders ?? null;
    } catch (err) {
      console.error(
        "[webhooks] acquisition: customer lookup failed",
        contract.customerId,
        err,
      );
    }
  }

  const rawProcessedAt = capture.acqRaw.orderProcessedAt;
  const processedAt =
    contract.originOrderProcessedAt ??
    (typeof rawProcessedAt === "string" ? new Date(rawProcessedAt) : null);
  const ttp = timeToPurchaseSeconds(customerCreatedAt, processedAt);

  const acqRaw = {
    ...capture.acqRaw,
    customerCreatedAt: customerCreatedAt?.toISOString() ?? null,
    customerNumberOfOrders,
    timeToPurchaseSeconds: ttp,
  } as Prisma.InputJsonValue;

  const updated = await prisma.subscriptionContract.updateMany({
    where: { id: contract.id, acqRaw: { equals: Prisma.AnyNull } },
    data: {
      acqReferringSite: capture.acqReferringSite,
      acqLandingSite: capture.acqLandingSite,
      acqSourceName: capture.acqSourceName,
      acqUtm:
        capture.acqUtm == null
          ? Prisma.DbNull
          : (capture.acqUtm as unknown as Prisma.InputJsonValue),
      acqCountryCode: capture.acqCountryCode,
      acqCity: capture.acqCity,
      acqProvinceCode: capture.acqProvinceCode,
      acqDeviceType: capture.acqDeviceType,
      acqTimeToPurchaseSeconds: ttp,
      acqUnitsFirstOrder: capture.acqUnitsFirstOrder,
      acqOrderValueBand: capture.acqOrderValueBand,
      acqRaw,
    },
  });
  if (updated.count === 0) return false; // concurrent capture won the claim

  await logEvent({
    ...contractEventBase(shopId, contract),
    type: "contract.updated",
    source: "WEBHOOK",
    payload: {
      action: "acquisition_captured",
      sourceName: capture.acqSourceName,
      countryCode: capture.acqCountryCode,
      deviceType: capture.acqDeviceType,
      hasUtm: capture.acqUtm != null,
    },
  });
  return true;
}

/**
 * Stash-pickup side of the acquisition handshake: when the origin order's
 * ORDERS_CREATE arrived first, its bundle is waiting in the event log — pick
 * it up and persist. When the contract webhook wins the race instead, the
 * ORDERS_CREATE handler's direct-persist path completes it later. Both sides
 * are idempotent on acqRaw-still-null.
 *
 * Exported because the create webhook is NOT the only moment a contract can
 * become eligible: a contract mirrored as UNKNOWN at create time (plan
 * evidence unavailable) can be reclassified OURS later, and a lost create
 * webhook means the mirror is first built by the contracts-update catch-up
 * path. Both callers beyond handleSubscriptionContractsCreate — the catch-up
 * branch and the daily origin_order_backfill job (sync.server.ts) — reuse
 * this exact pickup so a captured bundle can never be stranded in the event
 * log forever. Returns true when this call persisted the bundle.
 */
export async function enrichAcquisitionOnContractCreate(
  shopDomain: string,
  shopId: string,
  contractId: string,
): Promise<boolean> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
  });
  if (!contract?.originOrderId) return false;
  if (!isBillableOwnership(contract.ownership)) return false;
  if (contract.acqRaw != null) return false;

  const stash = await prisma.subscriberEvent.findFirst({
    where: {
      shopId,
      type: ACQUISITION_EVENT,
      payload: { path: ["orderId"], equals: contract.originOrderId },
    },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  const stashPayload = stash?.payload as { acquisition?: unknown } | null;
  const acquisition = stashPayload?.acquisition;
  if (
    acquisition == null ||
    typeof acquisition !== "object" ||
    !("acqRaw" in acquisition)
  ) {
    // Order webhook not seen yet — its direct-persist path (or a later
    // backfill run, once the stash exists) will finish.
    return false;
  }

  const admin = await getAdmin(shopDomain).catch(() => null);
  return applyAcquisitionToContract(
    shopId,
    contract,
    acquisition as AcquisitionCapture,
    admin,
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
 * Renewal orders (payload source_name "subscription_contract" — the value
 * Shopify stamps on orders created by subscription billing attempts) are
 * EXCLUDED entirely: their money and events are owned by the billing-attempt
 * webhooks, they are not a storefront checkout the take-rate denominator
 * should count (every renewal would otherwise deflate the level as the
 * subscriber base matures), and their line items re-carry the widget's design
 * property from the original add-to-cart, which would re-attribute the same
 * design once per cycle. Events logged before this exclusion shipped still
 * include renewal orders — the analytics helpText notes this.
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
 *
 * Acquisition capture feed (docs/DATA_FOUNDATION.md): for subscribable orders
 * — a selling-plan marker on a line OR a line's product listed in an active
 * SellingPlanConfig.productIds, the same containsSubscribable test the
 * take-rate denominator uses, because REST payloads do not always carry the
 * marker — the payload's landing_site / referring_site / source_name /
 * client_details.user_agent / addresses are reduced to the SANITIZED
 * acquisition bundle (pure sanitizer, app/lib/acquisition/sanitize.ts — no
 * raw IP, no full UA, URLs stripped to host+path+utm_*), stashed as an
 * "acquisition.captured" event keyed by orderId, and persisted directly when
 * the contract mirror already exists (contract-create webhook side picks up
 * the stash otherwise). Over-stashing a subscribable one-time order is
 * harmless: the pickup only applies a bundle whose orderId matches the
 * contract's originOrderId. Contained: acquisition can never fail the
 * webhook.
 *
 * Idempotency: the route layer dedupes exact redeliveries on
 * X-Shopify-Webhook-Id (WebhookReceipt); a manual redelivery carries a NEW
 * webhook id, so this handler additionally skips when an event for this
 * order's id was already logged — one order never counts twice in the
 * take-rate denominator, design attribution or acquisition stash (same
 * pattern as handleRefundsCreate's refund-id guard).
 */
async function handleOrdersCreate({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  // Renewal orders are not checkouts: see the doc block above. Checked before
  // any DB work — the common case on a mature book is a renewal.
  if (asString(payload.source_name) === "subscription_contract") return;

  const shop = await requireShop(shopDomain);
  const lineItems = asArray(payload.line_items)
    .map(asRecord)
    .filter((li): li is Payload => li != null);
  if (lineItems.length === 0) return;

  const hasSellingPlanLine = lineItems.some(hasSellingPlanMarker);

  const orderGid = toGid("Order", pick(payload, "admin_graphql_api_id", "id"));
  const orderEmail = asString(pick(payload, "email", "contact_email"));
  // The order's customer identity — stamped onto the acquisition stash event
  // so handleCustomersRedact can find it by customerId even after the
  // customer changes their store email (redact payloads carry the CURRENT
  // email; a stash keyed on the checkout-time email alone would survive).
  const orderCustomer = asRecord(payload.customer);
  const orderCustomerGid = orderCustomer
    ? toGid("Customer", pick(orderCustomer, "admin_graphql_api_id", "id"))
    : null;

  // Idempotency on the ORDER's identity: the route layer only dedupes exact
  // redeliveries (same X-Shopify-Webhook-Id); a manual redelivery carries a
  // NEW webhook id and would otherwise double-count checkout.subscribable
  // (the take-rate denominator) and widget.design_attributed. Same pattern as
  // handleRefundsCreate's refund-id guard.
  if (orderGid) {
    const already = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        type: { in: ["checkout.subscribable", "widget.design_attributed"] },
        payload: { path: ["orderId"], equals: orderGid },
      },
      select: { id: true },
    });
    if (already) return;
  }

  // ── Subscribable detection (marker OR productIds fallback) ────────────────
  // Computed BEFORE the acquisition block because both consumers need it:
  // per the handler doc above, REST payloads do not always include a
  // selling-plan marker on line items, so gating anything strictly on the
  // marker silently drops the payload variant the fallback exists for.
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

  // ── Acquisition capture (subscribable orders) ─────────────────────────────
  // Stash the sanitized bundle keyed by orderId, then persist directly when
  // the contract mirror already arrived (webhook race: either order). Gated on
  // containsSubscribable — NOT on the selling-plan marker alone — because a
  // subscription-origin order whose REST payload omits the marker would
  // otherwise never stash a bundle, the contract-create pickup would find
  // nothing, and (with the order-id idempotency guard above satisfied by the
  // checkout.subscribable event) no redelivery could ever repair it: the
  // shop's entire acquisition foundation would silently stay null. Stashing
  // for a subscribable ONE-TIME order is safe: the pickup handshake applies a
  // bundle only when contract.originOrderId matches the stashed orderId, so a
  // non-subscription order's stash is one inert event row. Guarded —
  // acquisition must never fail order processing.
  if (containsSubscribable) {
    try {
      const capture = acquisitionFromOrderPayload(payload, lineItems, orderGid);
      await logEvent({
        shopId: shop.id,
        customerId: orderCustomerGid,
        email: orderEmail,
        type: ACQUISITION_EVENT,
        source: "WEBHOOK",
        payload: {
          orderId: orderGid,
          acquisition: capture as unknown as Record<string, unknown>,
        },
      });
      if (orderGid) {
        const contract = await prisma.subscriptionContract.findFirst({
          where: { shopId: shop.id, originOrderId: orderGid },
        });
        if (contract && contract.acqRaw == null) {
          const admin = await getAdmin(shopDomain).catch(() => null);
          await applyAcquisitionToContract(shop.id, contract, capture, admin);
        }
      }
    } catch (err) {
      console.error("[webhooks] acquisition capture failed", orderGid, err);
    }
  }

  // ── Design attribution (_cellexia_design hidden line property) ────────────
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

/** Cents from a REST money string ("30.00" / "30"), null when unparseable. */
function centsFromAmountString(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Σ successful refund transactions from a REFUNDS_CREATE payload. A refund
 * with no parseable money movement (e.g. restock-only) sums to zero.
 */
function refundMoneyFromPayload(payload: Payload): {
  amountCents: number;
  currencyCode: string | null;
} {
  let amountCents = 0;
  let currencyCode: string | null = null;
  for (const tx of asArray(payload.transactions).map(asRecord)) {
    if (!tx) continue;
    if (asString(tx.kind) !== "refund") continue;
    const status = asString(tx.status);
    if (status && status !== "success" && status !== "pending") continue;
    const cents = centsFromAmountString(tx.amount);
    if (cents == null || cents <= 0) continue;
    amountCents += cents;
    currencyCode = asString(tx.currency) ?? currencyCode;
  }
  return { amountCents, currencyCode };
}

/**
 * Can a refund's money be netted against a stored cents figure? Only when the
 * currencies AGREE — the same standing rule the analytics readers apply
 * ("Mixed-currency attempts/origin totals are excluded rather than summed
 * raw", rollup.server.ts). On a Shopify Markets shop the REST refund
 * transactions are denominated in the order's PAYMENT (presentment) currency,
 * while our mirrored totals (BillingAttempt.amountCents,
 * originOrderTotalCents) are shopMoney figures — subtracting one from the
 * other mis-nets by the FX delta. A null on either side means the currency is
 * unknowable (sparse payload, pre-stamp row); treated as agreeing, the same
 * null-tolerant comparison originPaymentCountsOnce uses.
 */
function refundCurrencyAgrees(
  refundCurrency: string | null,
  storedCurrency: string | null | undefined,
): boolean {
  if (refundCurrency == null || storedCurrency == null) return true;
  return refundCurrency === storedCurrency;
}

/**
 * REFUNDS_CREATE
 * Payload: refund (REST-shaped) — `id`, `admin_graphql_api_id`
 * (gid://shopify/Refund/…), `order_id`, `transactions[]` (`kind: "refund"`,
 * `amount`, `currency`, `status`), `refund_line_items[]`.
 *
 * Analytics feed, two matches in strict precedence order:
 *
 * 1. RENEWAL order (BillingAttempt.orderId): refunded amount recorded on
 *    BillingAttempt.refundedCents. The originally charged amountCents is
 *    never rewritten — rollups and cohorts subtract refundedCents instead,
 *    so revenue and gross profit read net of refunds while the charge
 *    history stays intact. SubscriptionContract.lifetimeRevenueCents is
 *    decremented (clamped at zero) so the per-contract lifetime figure reads
 *    net of refunds too.
 * 2. ORIGIN (checkout) order (SubscriptionContract.originOrderId, only when
 *    no attempt matched): recorded on originOrderRefundedCents, which
 *    cohort/rollup analytics net against the mirrored origin payment —
 *    but ONLY once originOrderTotalCents has been captured. Before capture
 *    the refund is skipped (refund_skipped_pre_capture): the late capture
 *    stores the order's CURRENT total, which is already net of the refund's
 *    reductions, so recording it here too would subtract the same money
 *    twice. lifetimeRevenueCents is deliberately NOT touched — it keeps its
 *    renewals-only ("billed by this app") meaning, and the origin payment
 *    was never added to it.
 *
 * The precedence is the same rule the revenue side applies (an order that is
 * somehow both a billing-attempt order AND an origin order counts once, on
 * the attempt) — see originPaymentCountsOnce in
 * app/lib/analytics/queries.server.ts.
 *
 * Refunds on orders matching neither (another app's orders, non-subscription
 * orders) are ignored: their money never entered our revenue metrics, so
 * there is nothing to net out.
 *
 * BOTH branches additionally require CURRENCY AGREEMENT
 * (refundCurrencyAgrees): a refund denominated in another currency than the
 * stored total (foreign-presentment order on a Shopify Markets shop) is
 * skipped with refund_skipped_currency_mismatch instead of mixed in raw.
 *
 * Idempotency: the route layer dedupes exact redeliveries on
 * X-Shopify-Webhook-Id (WebhookReceipt); manual redeliveries carry a NEW
 * webhook id, so this handler additionally skips when an admin.action event
 * with payload.refundId for this refund already exists — one refund is never
 * recorded twice.
 */
async function handleRefundsCreate({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const orderGid = toGid("Order", pick(payload, "order_id", "admin_graphql_api_order_id"));
  if (!orderGid) {
    console.warn("[webhooks] REFUNDS_CREATE without an order id", webhookId);
    return;
  }

  const refundGid = toGid("Refund", pick(payload, "admin_graphql_api_id", "id"));

  /** Replay guard on the refund's identity (route receipts only catch exact
   * webhook-id redeliveries). */
  const alreadyRecorded = async (contractId: string): Promise<boolean> => {
    if (!refundGid) return false;
    const already = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        contractId,
        type: "admin.action",
        payload: { path: ["refundId"], equals: refundGid },
      },
      select: { id: true },
    });
    return already != null;
  };

  // ── 1. Renewal order (BillingAttempt) — precedence over the origin match ──
  const attempt = await prisma.billingAttempt.findFirst({
    where: { orderId: orderGid, contract: { shopId: shop.id } },
    include: { contract: true },
  });
  if (attempt) {
    if (!isBillableOwnership(attempt.contract.ownership)) return;
    if (await alreadyRecorded(attempt.contractId)) return;

    const { amountCents, currencyCode } = refundMoneyFromPayload(payload);
    if (amountCents <= 0) return;

    // amountCents was stamped alongside currencyCode at settlement (same
    // `orderCurrency ?? contract.currencyCode` fallback) — that is the
    // denomination refundedCents nets against. A refund in another currency
    // (foreign-presentment order on a Markets shop) is skipped and logged,
    // never mixed in raw; the skip event carries the refundId, so the replay
    // guard blocks redeliveries exactly like a recorded refund.
    const attemptCurrency = attempt.currencyCode ?? attempt.contract.currencyCode;
    if (!refundCurrencyAgrees(currencyCode, attemptCurrency)) {
      await logEvent({
        ...contractEventBase(shop.id, attempt.contract),
        type: "admin.action",
        source: "WEBHOOK",
        payload: {
          action: "refund_skipped_currency_mismatch",
          refundId: refundGid,
          orderId: orderGid,
          attemptId: attempt.id,
          cycleIndex: attempt.cycleIndex,
          amountCents,
          currencyCode,
          expectedCurrencyCode: attemptCurrency,
        },
      });
      return;
    }

    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: { refundedCents: { increment: amountCents } },
    });

    // Keep the contract's lifetime revenue NET of refunds — the same
    // semantics rollups/cohorts apply by subtracting refundedCents. Clamped
    // at zero so a refund recorded against an attempt whose amount never
    // landed (e.g. a stale-sweep row from before amounts were mirrored)
    // cannot go negative.
    const lifetimeDecrement = Math.min(
      amountCents,
      Math.max(0, attempt.contract.lifetimeRevenueCents),
    );
    if (lifetimeDecrement > 0) {
      await prisma.subscriptionContract.update({
        where: { id: attempt.contractId },
        data: { lifetimeRevenueCents: { decrement: lifetimeDecrement } },
      });
    }

    await logEvent({
      ...contractEventBase(shop.id, attempt.contract),
      type: "admin.action",
      source: "WEBHOOK",
      payload: {
        action: "refund_recorded",
        refundId: refundGid,
        orderId: orderGid,
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        amountCents,
        currencyCode: currencyCode ?? attempt.currencyCode,
      },
    });
    return;
  }

  // ── 2. Origin (checkout) order of one of OUR contracts ────────────────────
  const contract = await prisma.subscriptionContract.findFirst({
    where: { shopId: shop.id, originOrderId: orderGid },
  });
  if (!contract) return; // not one of our orders — nothing to net out
  if (!isBillableOwnership(contract.ownership)) return;
  if (await alreadyRecorded(contract.id)) return;

  const { amountCents, currencyCode } = refundMoneyFromPayload(payload);
  if (amountCents <= 0) return;

  // Refunds net against the origin payment only FROM CAPTURE ONWARD — the
  // originMoneyFields contract in contracts/sync.server.ts. A pre-capture
  // refund is already inside the CURRENT total a late capture (sync or the
  // origin_order_backfill job) stores, so incrementing refundedCents here too
  // would net the same money twice. AND only in the CAPTURED CURRENCY:
  // originOrderTotalCents is a shopMoney figure while REST refund
  // transactions are denominated in the order's payment (presentment)
  // currency, so a foreign-presentment refund (Shopify Markets) must be
  // skipped rather than mixed in raw — refundCurrencyAgrees. Both gates are
  // enforced at the row level (updateMany conditioned on a non-null captured
  // total whose currency agrees), never via a prior read, so a capture
  // landing concurrently cannot slip between check and increment.
  const netted = await prisma.subscriptionContract.updateMany({
    where: {
      id: contract.id,
      originOrderTotalCents: { not: null },
      // Null refund currency (sparse payload) nets against any capture —
      // the same null-tolerant rule refundCurrencyAgrees encodes.
      ...(currencyCode != null
        ? {
            OR: [
              { originOrderCurrencyCode: null },
              { originOrderCurrencyCode: currencyCode },
            ],
          }
        : {}),
    },
    data: { originOrderRefundedCents: { increment: amountCents } },
  });

  // Distinguish WHICH gate refused, for the event log only (both skip events
  // arm the replay guard the same way): re-read AFTER the failed updateMany —
  // a total that is null now was null when the update ran.
  let action = "refund_recorded";
  if (netted.count === 0) {
    const current = await prisma.subscriptionContract.findFirst({
      where: { id: contract.id },
      select: { originOrderTotalCents: true },
    });
    action =
      current?.originOrderTotalCents == null
        ? "refund_skipped_pre_capture"
        : "refund_skipped_currency_mismatch";
  }

  // Logged for ALL outcomes: the skip events carry the refundId, so the
  // replay guard above also blocks a manual redelivery arriving AFTER a later
  // capture from netting a refund the capture already absorbed.
  await logEvent({
    ...contractEventBase(shop.id, contract),
    type: "admin.action",
    source: "WEBHOOK",
    payload: {
      action,
      refundId: refundGid,
      orderId: orderGid,
      originOrder: true,
      amountCents,
      currencyCode: currencyCode ?? contract.originOrderCurrencyCode,
      ...(action === "refund_skipped_currency_mismatch"
        ? { expectedCurrencyCode: contract.originOrderCurrencyCode }
        : {}),
    },
  });
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
 *   names/phone/deliveryAddress nulled, and EVERY acquisition field (acq* +
 *   acqRaw — source, UTMs, geo, device, timings) nulled: acquisition data is
 *   behavioral profile data, exactly what a redact request covers.
 * - SubscriberEvent + NotificationLog: email redacted, phone nulled; the
 *   "acquisition.captured" stash events additionally have their payloads
 *   cleared (they carry the same geo/behavior bundle). Stash events are
 *   matched by customerId/email/contractId AND by payload.orderId against
 *   the matched contracts' originOrderIds PLUS every id in the payload's own
 *   `orders_to_redact` list — a stash written before the contract existed
 *   carries no contractId, and the customer may have changed their store
 *   email since checkout, so the identity filters alone can miss it. The
 *   orders_to_redact ids are the only handle on the stash of an over-stashed
 *   order that never became a contract at all (handleOrdersCreate stashes
 *   every subscribable order, including a guest's one-time purchase): no
 *   contract means no originOrderId, and identity drift defeats the
 *   customerId/email filters — Shopify names those orders explicitly, so
 *   they join both the payload-clearing pass and the email scrub (the event
 *   row itself carries the checkout-time email).
 *   The "contract.updated" acquisition_captured confirmation
 *   events have their payload acquisition fragments
 *   (sourceName/countryCode/deviceType) scrubbed too — EVERY acquisition
 *   field dies with the identity, wherever it was copied.
 * - MagicLinkToken / OtpCode / PortalSession rows for the identity deleted
 *   (a redacted customer must not retain live login artifacts).
 * BillingAttempt / DunningCase / revenue counters — including the origin
 * order money mirror (originOrder*Cents) — are retained (legitimate
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

  // The payload names the customer's orders EXPLICITLY. An over-stashed
  // order that never became a contract (a guest one-time checkout of a
  // subscribable product) is reachable through NO identity filter once the
  // store email drifted — its acquisition stash keeps the geo/UTM/device/
  // value bundle and the checkout-time email — but its id is right here.
  // toGid drops malformed entries, so a bad id can never become a filter.
  const redactedOrderGids = asArray(payload.orders_to_redact)
    .map((value) => toGid("Order", value))
    .filter((v): v is string => v != null);

  const contractFilters: Prisma.SubscriptionContractWhereInput[] = [];
  if (customerGid) contractFilters.push({ customerId: customerGid });
  if (originalEmail) contractFilters.push({ email: originalEmail });
  if (contractFilters.length === 0 && redactedOrderGids.length === 0) {
    console.warn("[webhooks] CUSTOMERS_REDACT without customer identity", webhookId);
    return;
  }

  const contracts =
    contractFilters.length > 0
      ? await prisma.subscriptionContract.findMany({
          where: { shopId: shop.id, OR: contractFilters },
          select: { id: true, originOrderId: true },
        })
      : [];
  const contractIds = contracts.map((c) => c.id);
  const originOrderIds = contracts
    .map((c) => c.originOrderId)
    .filter((v): v is string => v != null);
  // Order-keyed scrub set: matched contracts' origin orders ∪ the payload's
  // orders_to_redact — deduplicated (a redacted order that DID become a
  // contract appears in both).
  const scrubOrderIds = [...new Set([...originOrderIds, ...redactedOrderGids])];

  if (contractIds.length > 0) {
    await prisma.subscriptionContract.updateMany({
      where: { id: { in: contractIds } },
      data: {
        email: redactedEmail,
        firstName: null,
        lastName: null,
        phone: null,
        deliveryAddress: Prisma.JsonNull,
        // Acquisition data foundation (migration 0006): behavioral profile
        // data dies with the identity — every acq* column and the raw bundle.
        // MANDATORY: any new acq* column must be added here.
        acqReferringSite: null,
        acqLandingSite: null,
        acqSourceName: null,
        acqUtm: Prisma.DbNull,
        acqCountryCode: null,
        acqCity: null,
        acqProvinceCode: null,
        acqDeviceType: null,
        acqTimeToPurchaseSeconds: null,
        acqUnitsFirstOrder: null,
        acqOrderValueBand: null,
        acqRaw: Prisma.DbNull,
        // Terminal for the daily stash pickup too: the stash payloads are
        // cleared below, so nightly re-scans of this contract could never
        // fill anything again (and must not — the data died with the
        // identity). Without this stamp the acqRaw-null row would re-enter
        // origin_order_backfill's capped acqPending window forever.
        acqPickupExhaustedAt: new Date(),
      },
    });
  }

  const eventFilters: Prisma.SubscriberEventWhereInput[] = [];
  if (customerGid) eventFilters.push({ customerId: customerGid });
  if (originalEmail) eventFilters.push({ email: originalEmail });
  if (contractIds.length > 0) eventFilters.push({ contractId: { in: contractIds } });
  // Acquisition stash events carry the same geo/behavior bundle the contract
  // columns do — clear their payloads BEFORE the email pass below rewrites
  // the identity these filters match on. The identity filters alone are not
  // enough: a stash is written at ORDERS_CREATE time (contractId null, email
  // as of checkout), so a customer who changed their store email — or whose
  // order carried no email at all — would leave the geo/UTM/device bundle
  // behind. The stash is keyed by payload.orderId, and scrubOrderIds (the
  // matched contracts' originOrderIds plus the payload's orders_to_redact —
  // the ONLY handle on a contract-less over-stashed order) recovers exactly
  // those rows.
  const orderKeyedFilters: Prisma.SubscriberEventWhereInput[] =
    scrubOrderIds.map((orderId) => ({
      payload: { path: ["orderId"], equals: orderId },
    }));
  const stashFilters: Prisma.SubscriberEventWhereInput[] = [
    ...eventFilters,
    ...orderKeyedFilters,
  ];
  await prisma.subscriberEvent.updateMany({
    where: { shopId: shop.id, type: "acquisition.captured", OR: stashFilters },
    data: { payload: Prisma.DbNull },
  });
  // The direct-persist confirmation event copies acquisition fragments
  // (sourceName / countryCode / deviceType) into its payload — "EVERY
  // acquisition field" includes copies. The action marker is kept so
  // timelines still show that a capture happened, minus the data.
  if (contractIds.length > 0) {
    await prisma.subscriberEvent.updateMany({
      where: {
        shopId: shop.id,
        type: "contract.updated",
        contractId: { in: contractIds },
        payload: { path: ["action"], equals: "acquisition_captured" },
      },
      data: {
        payload: { action: "acquisition_captured", redacted: true },
      },
    });
  }
  // Identity rewrite — LAST, after every filter that matches on the original
  // identity has run. The order-keyed filters ride along: an event row keyed
  // to a redacted order (acquisition stash, checkout.subscribable,
  // widget.design_attributed) carries the CHECKOUT-time email on the row
  // itself, which no customerId/email/contractId filter reaches after
  // identity drift.
  await prisma.subscriberEvent.updateMany({
    where: { shopId: shop.id, OR: [...eventFilters, ...orderKeyedFilters] },
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
  REFUNDS_CREATE: handleRefundsCreate,
  APP_UNINSTALLED: handleAppUninstalled,
  APP_SCOPES_UPDATE: handleAppScopesUpdate,
  CUSTOMERS_DATA_REQUEST: handleCustomersDataRequest,
  CUSTOMERS_REDACT: handleCustomersRedact,
  SHOP_REDACT: handleShopRedact,
};
