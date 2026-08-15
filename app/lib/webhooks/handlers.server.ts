import { Prisma, type SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent, logEventOrThrow } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { requireShop } from "~/lib/shop/install.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { buildMitEvidence } from "~/lib/billing/mit-evidence.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";
import {
  computeChargeCostSnapshot,
  loadCostContext,
  type CostContext,
} from "~/lib/analytics/costs.server";
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
  gql,
  listCustomerPaymentMethods,
  withContractDraft,
  type OrderSummary,
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

  // attemptNumber continues the cycle's real history rather than hardcoding 1:
  // a reconstructed row can land on a cycle that already holds scheduler or
  // dunning attempts (that is the common case — an admin retries a failed
  // cycle from the Shopify admin), and numbering it 1 would mislabel the
  // recovery position in every event payload and dunning analytic. Superseded
  // rows still count (history is append-only; idempotency keys already number
  // past them).
  const priorAttempts = await prisma.billingAttempt.aggregate({
    where: { contractId: contract.id, cycleIndex },
    _max: { attemptNumber: true },
  });

  return prisma.billingAttempt.create({
    data: {
      contractId: contract.id,
      shopifyAttemptId: attemptGid,
      idempotencyKey: idempotencyKey ?? `webhook:${attemptGid ?? webhookId}`,
      cycleIndex,
      attemptNumber: (priorAttempts._max.attemptNumber ?? 0) + 1,
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

  // Replay guard on the CONTRACT's identity: the route receipt only dedupes
  // exact webhook-id redeliveries, and a manual redelivery (the documented
  // recovery after a FAILED receipt) carries a NEW id. The sync above is
  // idempotent, but the canonical creation event is not — a second
  // contract.created would double-count the creation moment in timeline
  // analytics and re-fire the subscription-started Klaviyo flow at the
  // customer. Same guard family as the order-id and refund-id guards; the
  // catch-up branch in handleSubscriptionContractsUpdate stamps the same
  // shopifyContractId key, so a catch-up creation blocks a late replay too.
  const alreadyCreated = await prisma.subscriberEvent.findFirst({
    where: {
      shopId: shop.id,
      type: "contract.created",
      payload: { path: ["shopifyContractId"], equals: contract.shopifyContractId },
    },
    select: { id: true },
  });
  if (!alreadyCreated) {
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "contract.created",
      source: "WEBHOOK",
      payload: {
        shopifyContractId: contract.shopifyContractId,
        status: contract.status,
        intervalWeeks: contract.intervalWeeks,
        billingIntervalUnit: contract.billingIntervalUnit,
        billingIntervalCount: contract.billingIntervalCount,
        currencyCode: contract.currencyCode,
        nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
        isPrepaid: contract.isPrepaid,
        lineCount: contract.lines.length,
        itemTitles: contract.lines.filter((l) => !l.isGift).map((l) => l.title),
        originOrderId: contract.originOrderId,
      },
    });
  }

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

  // Post-purchase survey link: the thank-you page may already have written a
  // SurveyResponse for this contract's origin order (survey rows are keyed by
  // order because either side can win the race). Same containment rule as
  // acquisition: the survey never fails a webhook.
  try {
    await linkSurveyOnContractCreate(shop.id, contract.id);
  } catch (err) {
    console.error("[webhooks] survey link failed", contract.id, err);
  }

  // First-order tag (tagging setting group, v1.23.0): the origin order gets
  // its tag HERE — the moment the contract is mirrored and proven ours — not
  // in ORDERS_CREATE, which races the contract webhook and cannot decide
  // ownership. ORDERS_CREATE also never sees renewal orders (source_name
  // early return); those get the repeat tag in finishSuccessSettlement.
  // Guarded like every tail step: tagging never fails a webhook.
  try {
    await maybeTagOriginOrder(shop.id, contract.id);
  } catch (err) {
    console.error("[webhooks] first-order tag failed", contract.id, err);
  }
}

/**
 * Shared by the CREATE handler and the UPDATE catch-up branch (a lost create
 * webhook's catch-up IS the contract's create moment — the acquisition rule).
 * Demo/ownership/idempotency gating lives in maybeTagSubscriptionOrder.
 */
async function maybeTagOriginOrder(
  shopId: string,
  contractId: string,
): Promise<void> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
  });
  if (!contract?.originOrderId) return;
  const { maybeTagSubscriptionOrder } = await import(
    "~/lib/tagging/tags.server"
  );
  await maybeTagSubscriptionOrder(shopId, contract, contract.originOrderId, "first", {
    orderName: contract.originOrderName,
  });
}

/**
 * Shared by the CREATE handler, the UPDATE catch-up branch (a lost create
 * webhook's catch-up IS the contract's create moment — the acquisition rule)
 * and nothing else: the daily survey_link_sweep covers every other path.
 * Ownership/demo gating lives in the survey service's contract lookup.
 */
async function linkSurveyOnContractCreate(
  shopId: string,
  contractId: string,
): Promise<void> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
  });
  if (!contract?.originOrderId || contract.isDemo) return;
  if (!isBillableOwnership(contract.ownership)) return;
  const row = await prisma.surveyResponse.findUnique({
    where: { orderId: contract.originOrderId },
  });
  if (!row || row.contractId) return;
  const { linkSurveyForContract } = await import("~/lib/survey/service.server");
  await linkSurveyForContract(row, contract);
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
    // Same reasoning for the survey link (create-moment side effects must be
    // mirrored in the catch-up branch — see linkSurveyOnContractCreate).
    try {
      await linkSurveyOnContractCreate(shop.id, after.id);
    } catch (err) {
      console.error("[webhooks] catch-up survey link failed", after.id, err);
    }
    // And for the first-order tag (see maybeTagOriginOrder).
    try {
      await maybeTagOriginOrder(shop.id, after.id);
    } catch (err) {
      console.error("[webhooks] catch-up first-order tag failed", after.id, err);
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

  // Gifts attached to this cycle have now shipped with the order. shippedAt
  // rides the flip: later mirror hygiene flips SHIPPED grants REMOVED, and
  // without the timestamp "shipped then cleaned" and "superseded, never
  // shipped" become indistinguishable rows — analytics count gift COGS by
  // status IN (ADDED, SHIPPED) OR shippedAt IS NOT NULL, and the gifts
  // engine's REMOVED flips write status + removedAt only, so this stamp is
  // the ship fact's sole durable carrier.
  await tx.giftGrant.updateMany({
    where: { contractId, cycleIndex, status: "ADDED" },
    data: { status: "SHIPPED", shippedAt: new Date() },
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
      // Money invariant (integer cents + currencyCode) holds on the STREAM
      // too: on a Shopify Markets shop attempts settle in foreign presentment
      // currencies, and a stream-only consumer summing amountCents without
      // the denomination would mix currencies raw — the same trap the
      // rollup's shop-currency guard exists for.
      currencyCode: updated.currencyCode ?? contract.currencyCode,
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

  // Repeat-order tag (tagging setting group, v1.23.0): renewal orders never
  // reach ORDERS_CREATE (source_name early return), so the tag rides the
  // settlement tail — which BOTH claim winners funnel into (success webhook
  // and stale-attempt sweep), so a lost webhook cannot strand the tag.
  // Redrive-safe: the taggedOrderId-keyed event guard inside skips an order
  // already tagged, and the Shopify add is a no-op when the tag is present.
  // Guarded here too (not just inside): tagging never fails a settlement.
  if (updated.orderId) {
    try {
      const { maybeTagSubscriptionOrder } = await import(
        "~/lib/tagging/tags.server"
      );
      await maybeTagSubscriptionOrder(shopId, contract, updated.orderId, "repeat", {
        orderName: updated.orderName,
      });
    } catch (err) {
      console.error("[webhooks] repeat-order tag failed", updated.orderId, err);
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

  const orderGid = toGid(
    "Order",
    pick(payload, "admin_graphql_api_order_id", "order_id"),
  );

  if (attempt.status === "SUCCESS") {
    // Manual replay (new webhook id, same already-settled attempt).
    // amountCents is immutable ONLY ONCE NON-NULL: after a refund,
    // currentTotalPriceSet is the REDUCED total while refundedCents is
    // subtracted separately by rollups/cohorts, so overwriting an amount
    // that already landed would double-count the refund. A NULL amount is a
    // different state entirely — the settlement-time order-summary fetch
    // failed (throttle/outage) and the real charge is booked as ZERO
    // revenue in every surface (lifetimeRevenueCents, rollup chargedCents,
    // cohort LTGP), permanently, because nothing else re-reads it. This
    // redelivery is the repair lane: re-fetch and true-up the amount (plus
    // the money breakdown from the same summary) while it is still NULL,
    // claimed row-level so two concurrent replays can only true-up once.
    // Accepted residual, documented: an item refund recorded between the
    // zero-booking and this true-up is inside the re-fetched current total
    // AND in refundedCents — the same reduced-total asymmetry
    // DATA_FOUNDATION.md accepts for pre-capture origin refunds, and
    // strictly better than the permanent zero booking it repairs.
    if (attempt.amountCents == null) {
      const trueUpOrderGid = attempt.orderId ?? orderGid;
      if (trueUpOrderGid) {
        try {
          const summary = await getOrderSummary(admin, trueUpOrderGid);
          await prisma.$transaction(async (tx) => {
            const trued = await tx.billingAttempt.updateMany({
              where: { id: attempt.id, status: "SUCCESS", amountCents: null },
              data: {
                amountCents: summary.totalCents,
                currencyCode:
                  summary.currencyCode ?? attempt.contract.currencyCode,
                orderName: summary.name || attempt.orderName,
                orderId: trueUpOrderGid,
                discountCents: summary.discountsCents,
                taxCents: summary.taxCents,
                shippingCents: summary.shippingCents,
                subtotalCents: summary.subtotalCents,
                orderProcessedAt: summary.processedAt ?? summary.createdAt,
              },
            });
            // The zero-amount claim incremented lifetimeRevenueCents by
            // `?? 0` — add the missing revenue (and its discount twin) only
            // when THIS replay won the null→amount claim.
            if (trued.count > 0) {
              await tx.subscriptionContract.update({
                where: { id: attempt.contractId },
                data: {
                  lifetimeRevenueCents: { increment: summary.totalCents },
                  ...(summary.discountsCents > 0
                    ? {
                        lifetimeDiscountCents: {
                          increment: summary.discountsCents,
                        },
                      }
                    : {}),
                },
              });
              // The repair record rides the true-up transaction (same event
              // the sweep arm logs): the original billing.attempt_succeeded
              // keeps its null amountCents forever, so without this row the
              // append-only ledger could never explain why the table and the
              // event stream disagree on this charge. refundedCentsIncluded
              // is 0 here — unlike the sweep, this arm books the re-fetched
              // current total as-is (the documented accepted residual above).
              await logEvent(
                {
                  ...contractEventBase(shop.id, attempt.contract),
                  type: "billing.attempt_amount_backfilled",
                  source: "WEBHOOK",
                  actor: "system",
                  payload: {
                    attemptId: attempt.id,
                    orderId: trueUpOrderGid,
                    cycleIndex: attempt.cycleIndex,
                    amountCents: summary.totalCents,
                    currencyCode:
                      summary.currencyCode ?? attempt.contract.currencyCode,
                    refundedCentsIncluded: 0,
                    resolvedBy: "webhook_redelivery",
                  },
                },
                { tx },
              );
            }
          });
        } catch (err) {
          // Transient-tolerant like the original fetch: the row keeps
          // amountCents NULL (the ATTEMPT_AMOUNT_MISSING alert surfaces it)
          // and the next redelivery retries the true-up.
          console.error(
            "[webhooks] null-amount true-up failed",
            attempt.id,
            err,
          );
        }
      }
    }
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

  let amountCents = attempt.amountCents;
  let orderName = attempt.orderName;
  let orderCurrency = attempt.currencyCode;
  // Full summary retained past the destructured basics: the money breakdown
  // (discount/tax/shipping/subtotal) and the order's real processedAt exist
  // ONLY at this fetch — the 60-day order-access horizon makes them
  // unrecoverable later — and rollups otherwise estimate renewal discounts
  // from drifting mirror lines.
  let orderSummary: OrderSummary | null = null;
  // The charge instant. The order's createdAt is when Shopify actually
  // charged the card; webhook-arrival time (`now`) is only the fallback.
  // Stamping `now` on a delayed webhook shifts the charge into the NEXT
  // rollup day and, for a first charge, possibly the next cohort month
  // (audit: day-boundary drift). Backdating is capped at
  // MAX_CHARGE_BACKDATE_MS so the charge's true day is always still inside
  // rollup_run's trailing recompute window — an unbounded backdate (manual
  // redelivery days later) would strand the charge in a closed rollup row
  // that is never recomputed. The UNCLAMPED instant is not discarded: the
  // claim below stores the order's real processedAt in
  // BillingAttempt.orderProcessedAt, so the cap costs day-placement
  // precision only, never the raw value.
  let chargedAt = now;
  if (orderGid) {
    try {
      const summary = await getOrderSummary(admin, orderGid);
      orderSummary = summary;
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

  // Cost context for the per-charge cost snapshot (I2): loaded OUTSIDE the
  // claim transaction (one settings read + one query, no Shopify round trip)
  // and contained — analytics plumbing must never fail a settlement.
  let costCtx: CostContext | null = null;
  try {
    costCtx = await loadCostContext(shop.id);
  } catch (err) {
    console.error(
      "[webhooks] cost context load failed — settling without a cost snapshot",
      attempt.id,
      err,
    );
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
    // Per-charge cost snapshot (I2): the cost basis of THIS charge, frozen so
    // gross-profit history stops being repriced by later cost-setting edits.
    // Lines are read BEFORE consumeCycleOnSuccess deletes the consumed
    // add-on mirrors — the customer paid for them on this order, so they
    // belong to this charge's cost basis. Add-ons staged for OTHER cycles
    // are excluded with the exact cycle-scope rule the consumption below
    // applies; gift lines are excluded inside computeChargeCostSnapshot
    // (gift COGS books once per GiftGrant). Contained: a snapshot failure
    // settles without one and readers fall back to the live cost model.
    let costSnapshot: Prisma.InputJsonValue | undefined;
    if (costCtx) {
      try {
        const chargeLines = await tx.contractLine.findMany({
          where: { contractId: attempt.contractId },
        });
        const billedLines = chargeLines.filter(
          (l) =>
            !l.isOneTimeAddon ||
            l.addonCycleIndex == null ||
            l.addonCycleIndex === attempt.cycleIndex,
        );
        costSnapshot = computeChargeCostSnapshot(costCtx, {
          deliveryPriceCents: attempt.contract.deliveryPriceCents,
          isPrepaid: attempt.contract.isPrepaid,
          prepaidDeliveriesPerCharge:
            attempt.contract.prepaidDeliveriesPerCharge,
          lines: billedLines,
        }) as unknown as Prisma.InputJsonValue;
      } catch (err) {
        console.error(
          "[webhooks] cost snapshot computation failed — settling without one",
          attempt.id,
          err,
        );
      }
    }

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
        // Renewal-order money breakdown + the order's REAL processedAt
        // (UNCAPPED — completedAt above carries the clamped instant for
        // rollup day placement; this column preserves the raw truth), from
        // the summary already in hand. This is the ONLY capture moment:
        // the 60-day order-access horizon makes a later fetch impossible,
        // and rollups estimate renewal discounts from drifting mirror lines
        // whenever these are null.
        ...(orderSummary
          ? {
              discountCents: orderSummary.discountsCents,
              taxCents: orderSummary.taxCents,
              shippingCents: orderSummary.shippingCents,
              subtotalCents: orderSummary.subtotalCents,
              orderProcessedAt:
                orderSummary.processedAt ?? orderSummary.createdAt,
            }
          : {}),
        ...(costSnapshot !== undefined ? { costSnapshot } : {}),
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
        // Renewals-only discount twin of lifetimeRevenueCents (origin
        // discount is mirrored separately in originOrderDiscountCents).
        ...(orderSummary && orderSummary.discountsCents > 0
          ? { lifetimeDiscountCents: { increment: orderSummary.discountsCents } }
          : {}),
        ...(row.contract.firstChargeAt ? {} : { firstChargeAt: chargedAt }),
        // Prepaid delivery countdown (the cockpit's "N left" badge): each
        // successful prepaid charge PAYS FOR a fresh per-charge allotment,
        // so settlement re-arms the counter to the full allotment. Routine
        // re-syncs must never touch a live value (the sync's seed is
        // null-guarded); the settlement writer is the one legitimate
        // resetter, because a new charge is exactly what grants new
        // deliveries. Charge-level granularity by design — decrementing per
        // shipped delivery (scheduled fulfillments inside one charge) needs
        // fulfillment-created webhooks the app does not subscribe yet, and
        // the old decrement-per-CHARGE reading drove the counter to a
        // permanent "0 left" on a still-billing contract.
        ...(row.contract.isPrepaid &&
        row.contract.prepaidDeliveriesPerCharge != null
          ? {
              prepaidDeliveriesRemaining:
                row.contract.prepaidDeliveriesPerCharge,
            }
          : {}),
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

  // Event dedupe keyed on the ATTEMPT's event existence — the exact pattern
  // finishSuccessSettlement uses for billing.attempt_succeeded. Guarding on
  // the pre-run status ("was it FAILED before this run?") cannot distinguish
  // "event already logged" from "crashed between the status write above and
  // the logEvent below": every redelivery would then see FAILED, skip, and
  // the event — a risk-model training row AND the Klaviyo dunning-open flow
  // trigger — would be lost forever (the redrive paths re-invoke only the
  // dunning engine, never this log).
  const alreadyLogged =
    (await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        type: "billing.attempt_failed",
        payload: { path: ["attemptId"], equals: updated.id },
      },
      select: { id: true },
    })) != null;
  if (!alreadyLogged) {
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
        // Money invariant on the stream: amountCents never travels without
        // its denomination (see the success payload's twin comment).
        currencyCode: updated.currencyCode ?? updated.contract.currencyCode,
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
  shopDomain?: string,
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
  // Shopify Markets presentment total — what the customer actually saw at
  // checkout, alongside the shopMoney total below.
  const presentmentMoney = asRecord(
    asRecord(payload.total_price_set)?.presentment_money,
  );
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
    // Order-payload extras (all sanitization/caps live in the sanitizer):
    // which promo acquired the subscriber, checkout locale, Markets
    // presentment, sales channel, consent snapshot, tags. Raw REST shapes
    // pass through as-is — the sanitizer accepts {code} objects, strings and
    // comma-separated tag lists.
    discountCodes: payload.discount_codes,
    checkoutLocale: payload.customer_locale ?? clientDetails?.accept_language,
    presentmentCurrencyCode: payload.presentment_currency,
    presentmentTotalCents: centsFromAmountString(presentmentMoney?.amount),
    appId: payload.app_id,
    sourceIdentifier: payload.source_identifier,
    buyerAcceptsMarketing: payload.buyer_accepts_marketing,
    orderTags: payload.tags,
    // The shop's own hosts, so the sanitizer can mark a self-referral
    // (internal navigation) at capture time: the myshopify domain plus the
    // order-status URL — the one payload field that reliably carries the
    // storefront's PRIMARY (custom) domain.
    internalHosts: [shopDomain, asString(payload.order_status_url)].filter(
      Boolean,
    ),
  });
}

/**
 * Persist a sanitized acquisition capture onto a contract mirror. Idempotent
 * (only fills while acqRaw is still SQL-null, claimed atomically) and
 * ours-only — another app's subscriber is not ours to profile, and UNKNOWN
 * fails safe the same way. Enriches with the Shopify customer's createdAt so
 * acqTimeToPurchaseSeconds (account creation → origin payment) can be
 * computed. Returns true when this call performed the write.
 *
 * THROWS when the customer enrichment fails TRANSIENTLY (no admin client, or
 * the customer read errored). The acqRaw-null claim below is the bundle's
 * only write ever — persisting enrichment nulls on a retryable error would
 * consume it and permanently forfeit customerCreatedAt/numberOfOrders/
 * time-to-purchase (churn-model features, DATA_FOUNDATION.md) even though
 * the Shopify customer record stays fetchable forever, with the missingness
 * clustered on exactly the API-outage windows that bias a training set.
 * Every caller contains the throw (acquisition never fails a webhook) and
 * the retry lanes are already in place: the stash survives in the event log,
 * and the nightly origin_order_backfill's acqPending pass counts a throw as
 * acqFailed (retried next run) — it stamps acqPickupExhaustedAt only when NO
 * stash exists, so a transient error can never retire the row. Enrichment
 * nulls persist only when they are the TRUTH: no customer on the contract,
 * or Shopify conclusively answering that the customer does not exist.
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
  if (contract.customerId) {
    if (!admin) {
      throw new Error(
        `acquisition enrichment deferred (no admin client) for ${contract.id}`,
      );
    }
    // A getCustomer failure propagates: transient by definition here (a
    // deleted/erased customer resolves to null WITHOUT throwing, which
    // persists honest nulls below).
    const { getCustomer } = await import("~/lib/graphql/customers.server");
    const customer = await getCustomer(admin, contract.customerId);
    customerCreatedAt = customer?.createdAt ?? null;
    customerNumberOfOrders = customer?.numberOfOrders ?? null;
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
 * log forever. Returns true when this call persisted the bundle; THROWS when
 * the customer enrichment failed transiently (see applyAcquisitionToContract)
 * so the backfill counts a retryable failure instead of retiring the row.
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
 * webhook id, so each event family below additionally guards on its OWN
 * existence for this order's id — one order never counts twice in the
 * take-rate denominator, design attribution or acquisition stash, while a
 * redelivery after a partial run (crash or swallowed insert between the
 * sequential writes) re-completes exactly the missing families instead of
 * skipping them forever (see the per-family dedupe comment in the body).
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

  // Shopify test orders (payload.test — test gateway / Bogus): real webhooks
  // carrying fake money. They must not enter the take-rate denominator, the
  // design feed or the acquisition stash — a merchant's setup-phase
  // verification checkout would permanently deflate the reported take-rate,
  // and the event rows carry no field that could filter them out later
  // (contrast contracts, which carry isDemo). The skip itself is logged with
  // test: true so the exclusion stays auditable, guarded on the order id
  // like every other per-order event.
  if (payload.test === true) {
    if (orderGid) {
      const alreadyMarked = await prisma.subscriberEvent.findFirst({
        where: {
          shopId: shop.id,
          type: "admin.action",
          AND: [
            { payload: { path: ["action"], equals: "order_skipped_test" } },
            { payload: { path: ["orderId"], equals: orderGid } },
          ],
        },
        select: { id: true },
      });
      if (!alreadyMarked) {
        await logEvent({
          shopId: shop.id,
          type: "admin.action",
          source: "WEBHOOK",
          payload: { action: "order_skipped_test", orderId: orderGid, test: true },
        });
      }
    }
    return;
  }

  // Idempotency on the ORDER's identity: the route layer only dedupes exact
  // redeliveries (same X-Shopify-Webhook-Id); a manual redelivery carries a
  // NEW webhook id and would otherwise double-count checkout.subscribable
  // (the take-rate denominator), widget.design_attributed and the
  // acquisition stash. Deduped PER EVENT FAMILY, not with one any-event
  // early-return across all of them: the families are written sequentially,
  // so a process death (or a swallowed insert — logEvent contains its own
  // failures) between them leaves a partial order, and an any-event guard
  // would turn every redelivery into a clean skip — the missing writes
  // (takeRateDen rows, sibling design keys, the shop's acquisition bundle)
  // could then never be repaired by ANY path. Each family below re-checks
  // its own existence instead, so the route's crash-residue re-run and
  // manual redeliveries re-complete exactly what is missing.

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
  // otherwise never stash a bundle and the contract-create pickup would find
  // nothing: the shop's entire acquisition foundation would silently stay
  // null. The stash write dedupes on ITS OWN existence (per-family rule
  // above), so a first run that lost the stash to a swallowed insert while a
  // later event landed is repaired by redelivery, and the direct-persist
  // half re-runs regardless — its atomic acqRaw-null claim makes that free.
  // Stashing for a subscribable ONE-TIME order is safe: the pickup handshake
  // applies a bundle only when contract.originOrderId matches the stashed
  // orderId, so a non-subscription order's stash is one inert event row.
  // Guarded — acquisition must never fail order processing.
  if (containsSubscribable) {
    try {
      const capture = acquisitionFromOrderPayload(
        payload,
        lineItems,
        orderGid,
        shopDomain,
      );
      const hasStash =
        orderGid != null &&
        (await prisma.subscriberEvent.findFirst({
          where: {
            shopId: shop.id,
            type: ACQUISITION_EVENT,
            payload: { path: ["orderId"], equals: orderGid },
          },
          select: { id: true },
        })) != null;
      if (!hasStash) {
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
      }
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
  // A line attributes its design when it is a subscription add: a selling-plan
  // marker proves that directly, and on the marker-less REST payload variant
  // (the one the containsSubscribable fallback exists for — see the block
  // comment above) the property itself is the proof, because the widget only
  // stamps it in the same code paths that inject selling_plan and the theme
  // widget disables the design input for one-time selections. Gating strictly
  // on the marker here while the denominator uses the fallback would count
  // such an order in checkout.subscribable but never in the design feed —
  // take-rate-by-design silently undercounting conversions for exactly the
  // payload variant this handler documents as real. Provably one-time lines
  // (no marker AND the order not subscribable) stay ignored.
  const designKeys = new Set<string>();
  for (const li of lineItems) {
    const designKey = designPropertyOf(li);
    if (!designKey) continue;
    if (!hasSellingPlanMarker(li) && !containsSubscribable) continue;
    designKeys.add(designKey);
  }
  for (const designKey of designKeys) {
    if (orderGid) {
      const alreadyAttributed = await prisma.subscriberEvent.findFirst({
        where: {
          shopId: shop.id,
          type: "widget.design_attributed",
          AND: [
            { payload: { path: ["orderId"], equals: orderGid } },
            { payload: { path: ["designKey"], equals: designKey } },
          ],
        },
        select: { id: true },
      });
      if (alreadyAttributed) continue; // partial run: only the missing keys log
    }
    await logEvent({
      shopId: shop.id,
      email: orderEmail,
      type: "widget.design_attributed",
      source: "WEBHOOK",
      payload: { designKey, orderId: orderGid },
    });
  }

  if (!containsSubscribable) return;

  if (orderGid) {
    const alreadyCounted = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        type: "checkout.subscribable",
        payload: { path: ["orderId"], equals: orderGid },
      },
      select: { id: true },
    });
    if (alreadyCounted) return;
  }

  await logEvent({
    shopId: shop.id,
    email: orderEmail,
    type: "checkout.subscribable",
    source: "WEBHOOK",
    payload: {
      orderId: orderGid,
      orderName: asString(payload.name),
      hasSellingPlanLine,
      // Per-market join context (v1.6.0 serves different design presets per
      // market concurrently): the presentment currency identifies the market
      // side of the checkout and designKeys ties the denominator row to the
      // presets actually shown — without them take-rate-by-design divides
      // one design's conversions by a denominator polluted with every other
      // design's traffic, and the data to fix that retroactively was never
      // collected.
      presentmentCurrencyCode: asString(payload.presentment_currency),
      designKeys: [...designKeys].sort(),
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
 * Shop-currency conversion for a foreign-presentment refund (v1.16.0).
 *
 * REST refund transactions are denominated in the order's payment
 * (presentment) currency; the mirrored totals they net against are shopMoney
 * figures. When the currencies disagree, this fetches Shopify's own
 * shop-currency total for the refund (refund.totalRefundedSet.shopMoney) so
 * the money can be netted properly — the store sells in several presentment
 * currencies and analytics centralize on the store currency.
 *
 * Outcome contract (a skip event arms the PERMANENT replay guard, so the
 * caller must never write one on a transient failure):
 * - returns the converted figure when the refund reads back in the stored
 *   currency;
 * - returns null only on a CONCLUSIVE non-answer — no refund id/stored
 *   currency to work with, the refund unreadable (deleted/erased), or its
 *   shopMoney denominated in yet another currency: the standing terminal
 *   skip-and-log behavior is then correct;
 * - THROWS on transport/throttle errors (getAdmin, gql) — the live handler
 *   propagates so the webhook receipt goes FAILED and the delivery stays
 *   replayable; the reconcile job leaves the guard event unresolved and
 *   retries next run.
 */
async function convertRefundToStoredCurrency(
  shopDomain: string,
  refundGid: string | null,
  storedCurrency: string | null | undefined,
): Promise<{ amountCents: number; currencyCode: string } | null> {
  if (!refundGid || storedCurrency == null) return null;
  const admin = await getAdmin(shopDomain);
  const { getRefundShopMoney } = await import("~/lib/graphql/index.server");
  const shopMoney = await getRefundShopMoney(admin, refundGid);
  // The fetched figure must be denominated in the currency the stored
  // total uses, or netting would mis-book by the FX delta all over again.
  if (!shopMoney || shopMoney.currencyCode !== storedCurrency) return null;
  return { amountCents: shopMoney.amountCents, currencyCode: storedCurrency };
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
 * first CONVERTED to the stored currency via Shopify's own shopMoney figure
 * (convertRefundToStoredCurrency, v1.16.0 — analytics centralize on the
 * store currency, so the money must be netted, not dropped); only when that
 * conversion is unavailable is it skipped with
 * refund_skipped_currency_mismatch instead of mixed in raw.
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
   * webhook-id redeliveries). Deliberately NOT scoped to a contract: refund
   * ids are globally unique, and the unmatched-refund guard event (logged
   * when neither branch matches, see below) carries no contractId — a
   * contract-scoped lookup would miss it, and a manual redelivery arriving
   * AFTER the attempt/mirror finally exists would net a refund whose
   * settlement capture already absorbed it (and which the refund_reconcile
   * job owns from the moment the guard event exists). */
  const alreadyRecorded = async (): Promise<boolean> => {
    if (!refundGid) return false;
    const already = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
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
    if (await alreadyRecorded()) return;

    const { amountCents, currencyCode } = refundMoneyFromPayload(payload);
    if (amountCents <= 0) return;

    // amountCents was stamped alongside currencyCode at settlement (same
    // `orderCurrency ?? contract.currencyCode` fallback) — that is the
    // denomination refundedCents nets against. A refund in another currency
    // (foreign-presentment order on a Markets shop) is CONVERTED to the
    // stored currency via Shopify's own shopMoney figure (v1.16.0 — the
    // store sells in several presentment currencies and analytics
    // centralize on the store currency); when the conversion is unavailable
    // it is skipped and logged, never mixed in raw. The skip event carries
    // the refundId, so the replay guard blocks redeliveries exactly like a
    // recorded refund.
    let recordedAmountCents = amountCents;
    let recordedCurrency = currencyCode ?? attempt.currencyCode;
    let conversion: Record<string, unknown> = {};
    const attemptCurrency = attempt.currencyCode ?? attempt.contract.currencyCode;
    if (!refundCurrencyAgrees(currencyCode, attemptCurrency)) {
      // A transport/throttle error THROWS out of the handler here — the
      // receipt goes FAILED and the delivery replays, instead of a terminal
      // skip event arming the replay guard on a refund that would have
      // converted fine one retry later. Nothing is written before this
      // point, so the throw leaves no partial state.
      const converted = await convertRefundToStoredCurrency(
        shopDomain,
        refundGid,
        attemptCurrency,
      );
      if (!converted) {
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
      recordedAmountCents = converted.amountCents;
      recordedCurrency = converted.currencyCode;
      // Additive payload fields — the presentment original stays auditable.
      conversion = {
        converted: true,
        presentmentAmountCents: amountCents,
        presentmentCurrencyCode: currencyCode,
      };
    }

    // The counter moves and its replay guard arms in ONE transaction — the
    // refund twin of the success handler's claim transaction. The
    // refund_recorded event below IS the handler's only replay guard
    // (alreadyRecorded above): committed separately, a process death between
    // the increment and the event would leave the counter moved with no
    // guard, and the crash-residue redelivery (or the documented manual
    // replay after a FAILED receipt) would net the same refund twice — a
    // permanent divergence between refundedCents/lifetimeRevenueCents and
    // the event-derived rollup, with no repair path. logEventOrThrow (not
    // logEvent) because the event is load-bearing state here: a swallowed
    // insert would commit the money move unguarded, so the failure must roll
    // the whole transaction back instead (receipt FAILED → replayable).
    await prisma.$transaction(async (tx) => {
      await tx.billingAttempt.update({
        where: { id: attempt.id },
        data: { refundedCents: { increment: recordedAmountCents } },
      });

      // Keep the contract's lifetime revenue NET of refunds — the same
      // semantics rollups/cohorts apply by subtracting refundedCents.
      // Clamped at zero so a refund recorded against an attempt whose
      // amount never landed (e.g. a stale-sweep row from before amounts
      // were mirrored) cannot go negative; the clamp reads the row INSIDE
      // the transaction so a concurrent settlement or refund cannot skew it.
      const contractRow = await tx.subscriptionContract.findUniqueOrThrow({
        where: { id: attempt.contractId },
        select: { lifetimeRevenueCents: true },
      });
      const lifetimeDecrement = Math.min(
        recordedAmountCents,
        Math.max(0, contractRow.lifetimeRevenueCents),
      );
      if (lifetimeDecrement > 0) {
        await tx.subscriptionContract.update({
          where: { id: attempt.contractId },
          data: { lifetimeRevenueCents: { decrement: lifetimeDecrement } },
        });
      }

      await logEventOrThrow(
        {
          ...contractEventBase(shop.id, attempt.contract),
          type: "admin.action",
          source: "WEBHOOK",
          payload: {
            action: "refund_recorded",
            refundId: refundGid,
            orderId: orderGid,
            attemptId: attempt.id,
            cycleIndex: attempt.cycleIndex,
            amountCents: recordedAmountCents,
            currencyCode: recordedCurrency,
            ...conversion,
          },
        },
        { tx },
      );
    });
    return;
  }

  // ── 2. Origin (checkout) order of one of OUR contracts ────────────────────
  const contract = await prisma.subscriptionContract.findFirst({
    where: { shopId: shop.id, originOrderId: orderGid },
  });
  if (!contract) {
    // Neither branch matched. That is EITHER a genuinely foreign order
    // (another app's renewal, a plain one-time purchase — nothing to net
    // out) OR one of ours refunded inside an unmatched window: a renewal
    // order before settlement stamps BillingAttempt.orderId (hours wide
    // when the success webhook is lost to the stale sweep), or an origin
    // order before its contract mirror exists. The two are indistinguishable
    // HERE — so the refund is recorded as an unmatched guard event instead
    // of dropped: the event (a) arms the refundId replay guard, so a manual
    // redelivery arriving AFTER settlement/capture cannot net money the
    // reduced-total capture already absorbed, and (b) feeds the daily
    // refund_reconcile job (reconcileUnmatchedRefunds below), which
    // re-attempts the match once the attempt/mirror exists and settles
    // money-only refunds that would otherwise vanish from refundedCents
    // forever. Genuinely foreign refunds simply age out of the reconcile
    // window with the event as audit residue.
    const { amountCents, currencyCode } = refundMoneyFromPayload(payload);
    if (amountCents <= 0 || !refundGid) return; // nothing nettable / no identity to reconcile on
    if (await alreadyRecorded()) return; // redelivery of an already-guarded refund
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "WEBHOOK",
      payload: {
        action: "refund_unmatched",
        refundId: refundGid,
        orderId: orderGid,
        amountCents,
        currencyCode,
        // Item-linked refunds reduce the order's currentTotalPriceSet, so a
        // LATER settlement/capture stores the already-reduced total — the
        // reconcile job must not net those a second time. Money-only
        // refunds leave the total untouched and are the ones it recovers.
        lineItemRefund: asArray(payload.refund_line_items).length > 0,
      },
    });
    return;
  }
  if (!isBillableOwnership(contract.ownership)) return;
  if (await alreadyRecorded()) return;

  const { amountCents, currencyCode } = refundMoneyFromPayload(payload);
  if (amountCents <= 0) return;

  // Foreign-presentment conversion (v1.16.0), mirroring the attempt branch:
  // when the refund's currency provably disagrees with the captured origin
  // currency, net Shopify's shopMoney figure instead of skipping. A
  // transport/throttle error THROWS out of the handler (receipt FAILED →
  // replayable — nothing has been written yet); a CONCLUSIVE null lets the
  // original values flow into the transaction below, whose row-level
  // currency gate produces the standing refund_skipped_currency_mismatch
  // outcome.
  let recordedAmountCents = amountCents;
  let recordedCurrency = currencyCode;
  let conversion: Record<string, unknown> = {};
  if (!refundCurrencyAgrees(currencyCode, contract.originOrderCurrencyCode)) {
    const converted = await convertRefundToStoredCurrency(
      shopDomain,
      refundGid,
      contract.originOrderCurrencyCode,
    );
    if (converted) {
      recordedAmountCents = converted.amountCents;
      recordedCurrency = converted.currencyCode;
      conversion = {
        converted: true,
        presentmentAmountCents: amountCents,
        presentmentCurrencyCode: currencyCode,
      };
    }
  }

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
  //
  // Increment and guard event commit in ONE transaction, exactly like the
  // attempt branch above: the event is the only replay guard, and a crash
  // between the two would let a redelivery net the same refund twice.
  // logEventOrThrow so a refused event insert rolls the increment back
  // (receipt FAILED → replayable) instead of committing it unguarded.
  await prisma.$transaction(async (tx) => {
    const netted = await tx.subscriptionContract.updateMany({
      where: {
        id: contract.id,
        originOrderTotalCents: { not: null },
        // Null refund currency (sparse payload) nets against any capture —
        // the same null-tolerant rule refundCurrencyAgrees encodes.
        ...(recordedCurrency != null
          ? {
              OR: [
                { originOrderCurrencyCode: null },
                { originOrderCurrencyCode: recordedCurrency },
              ],
            }
          : {}),
      },
      data: { originOrderRefundedCents: { increment: recordedAmountCents } },
    });

    // Distinguish WHICH gate refused, for the event log only (both skip
    // events arm the replay guard the same way): re-read AFTER the failed
    // updateMany — a total that is null now was null when the update ran.
    let action = "refund_recorded";
    if (netted.count === 0) {
      const current = await tx.subscriptionContract.findFirst({
        where: { id: contract.id },
        select: { originOrderTotalCents: true },
      });
      action =
        current?.originOrderTotalCents == null
          ? "refund_skipped_pre_capture"
          : "refund_skipped_currency_mismatch";
    }

    // Logged for ALL outcomes: the skip events carry the refundId, so the
    // replay guard above also blocks a manual redelivery arriving AFTER a
    // later capture from netting a refund the capture already absorbed.
    await logEventOrThrow(
      {
        ...contractEventBase(shop.id, contract),
        type: "admin.action",
        source: "WEBHOOK",
        payload: {
          action,
          refundId: refundGid,
          orderId: orderGid,
          originOrder: true,
          amountCents: recordedAmountCents,
          currencyCode: recordedCurrency ?? contract.originOrderCurrencyCode,
          ...conversion,
          ...(action === "refund_skipped_currency_mismatch"
            ? { expectedCurrencyCode: contract.originOrderCurrencyCode }
            : {}),
        },
      },
      { tx },
    );
  });
}

/**
 * How far back the refund_reconcile job re-scans unmatched-refund guard
 * events. The unmatched windows it exists for close within hours (settlement
 * stamps attempt.orderId; the contract mirror lands with its webhook or the
 * daily backfill), so 30 days is generous; beyond it, an unmatched event is a
 * genuinely foreign order's refund and ages out of the scan as audit residue
 * rather than accumulating rescans forever.
 */
const REFUND_RECONCILE_WINDOW_MS = 30 * 86_400_000;

/** Per-run bound on the reconcile scan (oldest first — the window drains). */
const REFUND_RECONCILE_CAP = 200;

/**
 * Re-attempt the refund matches handleRefundsCreate had to give up on (the
 * refund_unmatched guard events): a refund can arrive before the settlement
 * stamps BillingAttempt.orderId or before the contract mirror exists, and
 * without this pass its money would be missing from refundedCents forever.
 * Registered as the daily refund_reconcile job (jobs/runner.server.ts).
 *
 * Matching precedence and gates mirror the live handler exactly. What can be
 * netted is narrower, though, because by construction every capture the
 * matched row carries happened AFTER the refund:
 *  - attempt match, MONEY-ONLY refund (no refund line items): netted — the
 *    order's currentTotalPriceSet was never reduced by it, so the captured
 *    amountCents (or its later null-amount true-up) contains the money in
 *    full;
 *  - attempt match, ITEM-linked refund: the capture stored the already-
 *    reduced total, so netting again would subtract the same money twice —
 *    terminal skip (refund_skipped_absorbed_by_capture);
 *  - origin match: the mirror postdates the refund, so the origin capture is
 *    pre-capture-refund by construction — the same terminal
 *    refund_skipped_pre_capture verdict (and documented tolerance,
 *    DATA_FOUNDATION.md) the live origin branch applies.
 *
 * Idempotent via the refundId guard: every verdict is itself an admin.action
 * event carrying the refundId, and a refund with ANY non-unmatched event is
 * skipped — so is one the live handler recorded first. `matched` counts
 * refunds that reached a terminal verdict this run.
 */
export async function reconcileUnmatchedRefunds(): Promise<{
  scanned: number;
  matched: number;
}> {
  const { getPrimaryShop } = await import("~/lib/shop/install.server");
  const shop = await getPrimaryShop();
  if (!shop) return { scanned: 0, matched: 0 };

  const unmatched = await prisma.subscriberEvent.findMany({
    where: {
      shopId: shop.id,
      type: "admin.action",
      createdAt: { gte: new Date(Date.now() - REFUND_RECONCILE_WINDOW_MS) },
      payload: { path: ["action"], equals: "refund_unmatched" },
    },
    orderBy: { createdAt: "asc" },
    take: REFUND_RECONCILE_CAP,
    select: { id: true, payload: true },
  });

  let matched = 0;
  for (const evt of unmatched) {
    const p = (evt.payload ?? {}) as Record<string, unknown>;
    const refundGid = asString(p.refundId);
    const orderGid = asString(p.orderId);
    const amountCents = asNumber(p.amountCents);
    const currencyCode = asString(p.currencyCode);
    const lineItemRefund = p.lineItemRefund === true;
    if (!refundGid || !orderGid || amountCents == null || amountCents <= 0) {
      continue; // malformed guard event — nothing safe to reconcile
    }

    // A verdict (or a live-handler record) already exists for this refund.
    const resolved = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        type: "admin.action",
        payload: { path: ["refundId"], equals: refundGid },
        NOT: { payload: { path: ["action"], equals: "refund_unmatched" } },
      },
      select: { id: true },
    });
    if (resolved) continue;

    // ── Attempt match (same precedence as the live handler) ─────────────────
    const attempt = await prisma.billingAttempt.findFirst({
      where: { orderId: orderGid, contract: { shopId: shop.id } },
      include: { contract: true },
    });
    if (attempt) {
      if (!isBillableOwnership(attempt.contract.ownership)) continue;

      const attemptCurrency =
        attempt.currencyCode ?? attempt.contract.currencyCode;

      if (lineItemRefund) {
        // Item-linked money is inside the (later) capture's reduced total —
        // absorbed regardless of currency, so this verdict comes first.
        await logEvent({
          ...contractEventBase(shop.id, attempt.contract),
          type: "admin.action",
          source: "SCHEDULER",
          payload: {
            action: "refund_skipped_absorbed_by_capture",
            refundId: refundGid,
            orderId: orderGid,
            attemptId: attempt.id,
            cycleIndex: attempt.cycleIndex,
            amountCents,
            currencyCode: currencyCode ?? attemptCurrency,
            resolvedBy: "refund_reconcile",
          },
        });
        matched += 1;
        continue;
      }

      // Foreign-presentment conversion (v1.16.0) — the same rule the live
      // handler applies, so a refund that raced its settlement is not
      // treated worse than one that arrived after it. Transient fetch
      // failures leave the guard event UNRESOLVED (retried next run, the
      // reconcile job's whole point); only a conclusive non-answer gets the
      // terminal mismatch verdict.
      let recordedAmountCents = amountCents;
      let recordedCurrency = currencyCode;
      let conversion: Record<string, unknown> = {};
      if (!refundCurrencyAgrees(currencyCode, attemptCurrency)) {
        let converted: { amountCents: number; currencyCode: string } | null;
        try {
          converted = await convertRefundToStoredCurrency(
            shop.domain,
            refundGid,
            attemptCurrency,
          );
        } catch (err) {
          console.warn(
            "[webhooks] reconcile refund conversion failed — retrying next run",
            refundGid,
            err,
          );
          continue;
        }
        if (!converted) {
          await logEvent({
            ...contractEventBase(shop.id, attempt.contract),
            type: "admin.action",
            source: "SCHEDULER",
            payload: {
              action: "refund_skipped_currency_mismatch",
              refundId: refundGid,
              orderId: orderGid,
              attemptId: attempt.id,
              cycleIndex: attempt.cycleIndex,
              amountCents,
              currencyCode,
              expectedCurrencyCode: attemptCurrency,
              resolvedBy: "refund_reconcile",
            },
          });
          matched += 1;
          continue;
        }
        recordedAmountCents = converted.amountCents;
        recordedCurrency = converted.currencyCode;
        conversion = {
          converted: true,
          presentmentAmountCents: amountCents,
          presentmentCurrencyCode: currencyCode,
        };
      }

      // Money-only: net it, atomically with its verdict event — the same
      // one-transaction rule the live attempt branch applies.
      await prisma.$transaction(async (tx) => {
        await tx.billingAttempt.update({
          where: { id: attempt.id },
          data: { refundedCents: { increment: recordedAmountCents } },
        });
        const contractRow = await tx.subscriptionContract.findUniqueOrThrow({
          where: { id: attempt.contractId },
          select: { lifetimeRevenueCents: true },
        });
        const lifetimeDecrement = Math.min(
          recordedAmountCents,
          Math.max(0, contractRow.lifetimeRevenueCents),
        );
        if (lifetimeDecrement > 0) {
          await tx.subscriptionContract.update({
            where: { id: attempt.contractId },
            data: { lifetimeRevenueCents: { decrement: lifetimeDecrement } },
          });
        }
        await logEventOrThrow(
          {
            ...contractEventBase(shop.id, attempt.contract),
            type: "admin.action",
            source: "SCHEDULER",
            payload: {
              action: "refund_recorded",
              refundId: refundGid,
              orderId: orderGid,
              attemptId: attempt.id,
              cycleIndex: attempt.cycleIndex,
              amountCents: recordedAmountCents,
              currencyCode: recordedCurrency ?? attemptCurrency,
              ...conversion,
              resolvedBy: "refund_reconcile",
            },
          },
          { tx },
        );
      });
      matched += 1;
      continue;
    }

    // ── Origin match ─────────────────────────────────────────────────────────
    const contract = await prisma.subscriptionContract.findFirst({
      where: { shopId: shop.id, originOrderId: orderGid },
    });
    if (!contract || !isBillableOwnership(contract.ownership)) {
      continue; // still unmatched — retried until the window ages it out
    }
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "admin.action",
      source: "SCHEDULER",
      payload: {
        action: "refund_skipped_pre_capture",
        refundId: refundGid,
        orderId: orderGid,
        originOrder: true,
        amountCents,
        currencyCode: currencyCode ?? contract.originOrderCurrencyCode,
        resolvedBy: "refund_reconcile",
      },
    });
    matched += 1;
  }

  return { scanned: unmatched.length, matched };
}

/**
 * ORDERS_FULFILLED
 * Payload: order (REST-shaped) — `id`, `admin_graphql_api_id`, `name`,
 * `fulfillments[]` (`tracking_number`, `tracking_numbers[]`, `tracking_url`,
 * `tracking_urls[]`).
 *
 * Delivery-outcome collection (docs/DATA_FOUNDATION.md collect-now doctrine):
 * the payload is the ONLY carrier of the charge→ship gap — persisted as
 * BillingAttempt.fulfilledAt for renewal orders and
 * SubscriptionContract.originOrderFulfilledAt for origin (checkout) orders,
 * first fulfillment wins (split shipments keep the earliest instant), plus a
 * billing.order_fulfilled event with the tracking company (no tracking
 * number, no PII). Orders older than the 60-day access horizon are
 * unfetchable later, so dropping this here would start every future
 * shipping-performance/churn-latency analysis cold.
 *
 * Only renewal orders billed by this app (matched via BillingAttempt.orderId)
 * get the order_shipped notification — Shopify already notifies checkout
 * orders. Deduped per cycle via hasSentForCycle; the persistence and event
 * run BEFORE that dedupe so a redelivery after a half-run still lands them.
 */
async function handleOrdersFulfilled({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const orderGid = toGid("Order", pick(payload, "admin_graphql_api_id", "id"));
  if (!orderGid) return;

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
  const trackingCompany = fulfillment
    ? asString(fulfillment.tracking_company)
    : null;
  // The ship instant: the fulfillment's own created_at when parseable,
  // webhook arrival otherwise.
  const fulfilledAtRaw = fulfillment ? asString(fulfillment.created_at) : null;
  const fulfilledAtParsed = fulfilledAtRaw ? new Date(fulfilledAtRaw) : null;
  const fulfilledAt =
    fulfilledAtParsed && !Number.isNaN(fulfilledAtParsed.getTime())
      ? fulfilledAtParsed
      : new Date();

  /** billing.order_fulfilled, deduped on the order id (manual replays). */
  const logFulfilledOnce = async (
    contract: Pick<SubscriptionContract, "id" | "customerId" | "email">,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    const already = await prisma.subscriberEvent.findFirst({
      where: {
        shopId: shop.id,
        type: "billing.order_fulfilled",
        payload: { path: ["orderId"], equals: orderGid },
      },
      select: { id: true },
    });
    if (already) return;
    await logEvent({
      ...contractEventBase(shop.id, contract),
      type: "billing.order_fulfilled",
      source: "WEBHOOK",
      payload: {
        orderId: orderGid,
        fulfilledAt: fulfilledAt.toISOString(),
        trackingCompany,
        hasTracking: trackingNumber != null || trackingUrl != null,
        ...extra,
      },
    });
  };

  const attempt = await prisma.billingAttempt.findFirst({
    where: { orderId: orderGid, contract: { shopId: shop.id } },
    include: { contract: true },
  });
  if (attempt) {
    // First fulfillment wins: split shipments must not advance the instant.
    await prisma.billingAttempt.updateMany({
      where: { id: attempt.id, fulfilledAt: null },
      data: { fulfilledAt },
    });
    await logFulfilledOnce(attempt.contract, {
      origin: false,
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      orderName: attempt.orderName ?? asString(payload.name),
    });

    if (
      await hasSentForCycle(attempt.contractId, "order_shipped", attempt.cycleIndex)
    ) {
      return;
    }
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
    return;
  }

  // Origin (checkout) order: no notification — Shopify already sent one —
  // but the cycle-0 pay→ship gap is collected, owned contracts only (origin
  // money-mirror rule: another app's checkout is not ours to measure).
  const contract = await prisma.subscriptionContract.findFirst({
    where: { shopId: shop.id, originOrderId: orderGid },
  });
  if (!contract || !isBillableOwnership(contract.ownership)) return;

  await prisma.subscriptionContract.updateMany({
    where: { id: contract.id, originOrderFulfilledAt: null },
    data: { originOrderFulfilledAt: fulfilledAt },
  });
  await logFulfilledOnce(contract, {
    origin: true,
    orderName: asString(payload.name),
  });
}

/**
 * ORDERS_CANCELLED
 * Payload: order (REST-shaped) — `id`, `admin_graphql_api_id`, `name`,
 * `cancel_reason`, `cancelled_at`, `financial_status`, `total_price`,
 * `currency`.
 *
 * CAPTURE-ONLY, deliberately: no money mutation. Captured totals are frozen
 * at capture (BillingAttempt.amountCents immutable once SUCCESS;
 * originOrderTotalCents "never rewritten") and REFUNDS_CREATE is the single
 * post-capture adjustment channel — when a cancellation refunds money, its
 * refund webhook does the netting. What a cancellation alone changes is the
 * VOID case: an authorization cancelled without a refund transaction emits no
 * REFUNDS_CREATE, and before this handler that money silently kept its full
 * captured total. The event makes the case visible and auditable (which
 * orders were cancelled, in what financial state, for how much) without
 * opening a second money-mutation channel that could double-net against a
 * later refund.
 *
 * Matched to our book the same way refunds are (attempt first, then origin
 * mirror, owned contracts only); foreign orders are ignored. Deduped on the
 * order id — a cancellation is a one-shot fact.
 */
async function handleOrdersCancelled({
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
  const contract =
    attempt?.contract ??
    (await prisma.subscriptionContract.findFirst({
      where: { shopId: shop.id, originOrderId: orderGid },
    }));
  if (!contract || !isBillableOwnership(contract.ownership)) return;

  const already = await prisma.subscriberEvent.findFirst({
    where: {
      shopId: shop.id,
      type: "billing.order_cancelled",
      payload: { path: ["orderId"], equals: orderGid },
    },
    select: { id: true },
  });
  if (already) return;

  await logEvent({
    ...contractEventBase(shop.id, contract),
    type: "billing.order_cancelled",
    source: "WEBHOOK",
    payload: {
      orderId: orderGid,
      orderName: asString(payload.name),
      origin: attempt == null,
      ...(attempt
        ? { attemptId: attempt.id, cycleIndex: attempt.cycleIndex }
        : {}),
      cancelReason: asString(payload.cancel_reason),
      cancelledAt: asString(payload.cancelled_at),
      totalCents: centsFromAmountString(payload.total_price),
      currencyCode: asString(payload.currency),
      financialStatus: asString(payload.financial_status),
    },
  });
}

// ── Shop & customer identity mirrors ─────────────────────────────────────────

/** The shopLocales half of the shop-metadata refresh (not in the payload). */
const SHOP_LOCALES_QUERY = `#graphql
  query CellexiaShopLocales {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

/**
 * SHOP_UPDATE
 * Payload: shop (REST-shaped) — `name`, `currency`, `iana_timezone`,
 * `customer_email` / `email`, `domain`.
 *
 * The Shop metadata mirror (currency, timezone, name, contact email, primary
 * domain, enabled locales) was previously written ONLY by onAppInstalled on
 * OAuth afterAuth: a merchant changing the store timezone or currency in the
 * Shopify admin left the mirror stale indefinitely, silently corrupting every
 * shop-day window (rollup day bucketing, cohort month keys, scheduler day
 * math) and every "same currency as the shop" analytics guard from that
 * moment on. This handler keeps the mirror live; a currency/timezone change
 * additionally logs an admin.action event, because day-bucketed history
 * BEFORE the change was computed under the old values — the event dates the
 * boundary for anyone reading those numbers later.
 */
async function handleShopUpdate({
  shopDomain,
  payload,
}: WebhookHandlerContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) {
    console.warn("[webhooks] SHOP_UPDATE for unknown shop", shopDomain);
    return;
  }

  const name = asString(payload.name);
  const currencyCode = asString(payload.currency);
  const ianaTimezone = asString(payload.iana_timezone);
  const contactEmail = asString(pick(payload, "customer_email", "email"));
  const primaryDomain = asString(payload.domain);

  // Locales are not in the REST payload — refreshed via GraphQL, contained
  // (a locale-fetch hiccup must not lose the currency/timezone refresh).
  let enabledLocales: object | undefined;
  try {
    const admin = await getAdmin(shopDomain);
    const data = await gql<{
      shopLocales?: Array<{ locale: string; primary: boolean; published: boolean }>;
    }>(admin, SHOP_LOCALES_QUERY);
    if (data.shopLocales) enabledLocales = data.shopLocales as object;
  } catch (err) {
    console.error("[webhooks] shop locales refresh failed", shopDomain, err);
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      name: name ?? undefined,
      currencyCode: currencyCode ?? undefined,
      ianaTimezone: ianaTimezone ?? undefined,
      contactEmail: contactEmail ?? undefined,
      primaryDomain: primaryDomain ?? undefined,
      ...(enabledLocales !== undefined ? { enabledLocales } : {}),
    },
  });

  const currencyChanged =
    currencyCode != null && currencyCode !== shop.currencyCode;
  const timezoneChanged =
    ianaTimezone != null && ianaTimezone !== shop.ianaTimezone;
  if (currencyChanged || timezoneChanged) {
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "WEBHOOK",
      payload: {
        action: "shop_metadata_changed",
        ...(currencyChanged
          ? {
              previousCurrencyCode: shop.currencyCode,
              currencyCode,
            }
          : {}),
        ...(timezoneChanged
          ? {
              previousIanaTimezone: shop.ianaTimezone,
              ianaTimezone,
            }
          : {}),
      },
    });
  }
}

/**
 * CUSTOMERS_UPDATE
 * Payload: customer (REST-shaped) — `id`, `admin_graphql_api_id`, `email`,
 * `first_name`, `last_name`, `phone`.
 *
 * Contract mirrors refresh email/phone/name only inside
 * syncContractFromShopify, which runs on CONTRACT-scoped webhooks: active
 * contracts self-heal every billing cycle, but PAUSED / FAILED / CANCELLED
 * contracts — exactly the populations dunning and winback email — held a
 * stale address indefinitely when the customer changed it in the store. This
 * handler refreshes the identity fields on ALL of the customer's mirrors,
 * OURS and FOREIGN alike: it is identity data, not billing, and the
 * CUSTOMERS_REDACT email-fallback filters match on the mirrored value, so
 * letting it drift also weakens erasure coverage.
 *
 * GDPR: mirrors already anonymized by CUSTOMERS_REDACT (the
 * redacted+…@example.invalid stamp) are never revived — customerId survives
 * redaction as the financial-record key, so without this skip a later
 * customers/update for the same customer id would write the live identity
 * straight back onto an erased row.
 *
 * Only non-null payload values refresh a field (the same "never clobber with
 * absence" rule the sync applies), and the event carries the changed FIELD
 * NAMES only — no identity values on the event stream.
 */
async function handleCustomersUpdate({
  shopDomain,
  payload,
  webhookId,
}: WebhookHandlerContext): Promise<void> {
  const shop = await requireShop(shopDomain);
  const customerGid = toGid(
    "Customer",
    pick(payload, "admin_graphql_api_id", "id"),
  );
  if (!customerGid) {
    console.warn("[webhooks] CUSTOMERS_UPDATE without customer id", webhookId);
    return;
  }

  const email = asString(payload.email);
  const phone = asString(payload.phone);
  const firstName = asString(payload.first_name);
  const lastName = asString(payload.last_name);

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId: shop.id, customerId: customerGid },
  });

  for (const contract of contracts) {
    if (
      contract.email.startsWith("redacted+") &&
      contract.email.endsWith("@example.invalid")
    ) {
      continue; // erased identity — see the GDPR note above
    }

    const data: Record<string, string> = {};
    const changedFields: string[] = [];
    if (email != null && email !== contract.email) {
      data.email = email;
      changedFields.push("email");
    }
    if (phone != null && phone !== contract.phone) {
      data.phone = phone;
      changedFields.push("phone");
    }
    if (firstName != null && firstName !== contract.firstName) {
      data.firstName = firstName;
      changedFields.push("firstName");
    }
    if (lastName != null && lastName !== contract.lastName) {
      data.lastName = lastName;
      changedFields.push("lastName");
    }
    if (changedFields.length === 0) continue;

    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data,
    });

    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: email ?? contract.email,
      type: "contract.updated",
      source: "WEBHOOK",
      payload: { action: "customer_updated", changedFields },
    });
  }
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
 * - KlaviyoOutbox: PENDING/FAILED rows for the identity are DELETED — the
 *   1-minute flush would otherwise transmit the customer's email/phone and
 *   acq profile attrs to Klaviyo for up to 24h AFTER the erasure was
 *   acknowledged; SENT/DEAD rows (kept as delivery audit) are anonymized
 *   like NotificationLog, with profileAttrs/properties cleared — they carry
 *   cellexia_acq_source/cellexia_acq_country plus names on every
 *   contract-scoped event, i.e. exactly the copies "EVERY acquisition field
 *   dies with the identity" covers.
 * - GDPR_DATA_REQUEST alerts for the identity: message and context stored
 *   the customer's email and order list as operator guidance — rewritten to
 *   the redacted identity (the dataRequestId survives as the audit key).
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

  // Klaviyo outbox: every contract-scoped event copied the identity (email/
  // phone) and the acq profile attrs into a row here, and rows are retained
  // forever (the age-out sweep only flips status). Matched by the original
  // identity AND by properties.contract_id — a customer whose store email
  // drifted since the last enqueue is still reachable through the contract
  // snapshot every row carries. PENDING/FAILED rows die outright: the
  // 1-minute klaviyo_flush would otherwise deliver them to Klaviyo for up to
  // MAX_EVENT_AGE_MS after this redact was acknowledged. SENT/DEAD rows stay
  // as delivery audit, anonymized like NotificationLog (identity redacted,
  // attrs/properties cleared — both carry acquisition copies).
  const outboxFilters: Prisma.KlaviyoOutboxWhereInput[] = [];
  if (originalEmail) outboxFilters.push({ email: originalEmail });
  const originalPhone = asString(customer.phone);
  if (originalPhone) outboxFilters.push({ phone: originalPhone });
  for (const contractId of contractIds) {
    outboxFilters.push({
      properties: { path: ["contract_id"], equals: contractId },
    });
  }
  if (outboxFilters.length > 0) {
    await prisma.klaviyoOutbox.deleteMany({
      where: {
        shopId: shop.id,
        status: { in: ["PENDING", "FAILED"] },
        OR: outboxFilters,
      },
    });
    await prisma.klaviyoOutbox.updateMany({
      where: { shopId: shop.id, OR: outboxFilters },
      data: {
        email: redactedEmail,
        phone: null,
        profileAttrs: Prisma.DbNull,
        properties: Prisma.DbNull,
      },
    });
  }

  // GDPR_DATA_REQUEST alerts carry the customer's email + requested order
  // list in message/context (operator guidance for the export). The redact
  // supersedes the guidance; the dataRequestId survives as the audit key.
  const alertFilters: Prisma.AlertWhereInput[] = [];
  if (customerGid) {
    alertFilters.push({ context: { path: ["customerId"], equals: customerGid } });
  }
  if (originalEmail) {
    alertFilters.push({ context: { path: ["email"], equals: originalEmail } });
  }
  if (alertFilters.length > 0) {
    const dataRequestAlerts = await prisma.alert.findMany({
      where: { shopId: shop.id, type: "GDPR_DATA_REQUEST", OR: alertFilters },
      select: { id: true, context: true },
    });
    for (const alert of dataRequestAlerts) {
      const context = (alert.context ?? {}) as Record<string, unknown>;
      await prisma.alert.update({
        where: { id: alert.id },
        data: {
          message: `GDPR data request for ${customerGid ?? redactedEmail} — identity redacted per customers/redact.`,
          context: {
            customerId: customerGid,
            email: redactedEmail,
            ordersRequested: [],
            dataRequestId: context.dataRequestId ?? null,
            redacted: true,
          },
        },
      });
    }
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
  ORDERS_CANCELLED: handleOrdersCancelled,
  REFUNDS_CREATE: handleRefundsCreate,
  SHOP_UPDATE: handleShopUpdate,
  CUSTOMERS_UPDATE: handleCustomersUpdate,
  APP_UNINSTALLED: handleAppUninstalled,
  APP_SCOPES_UPDATE: handleAppScopesUpdate,
  CUSTOMERS_DATA_REQUEST: handleCustomersDataRequest,
  CUSTOMERS_REDACT: handleCustomersRedact,
  SHOP_REDACT: handleShopRedact,
};
