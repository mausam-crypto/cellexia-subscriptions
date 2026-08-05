/**
 * Pure decision/transform helpers for the core subscription service.
 *
 * No I/O in this file (no Prisma, no Shopify, no crypto imports) so the unit
 * tests under tests/core can import it without touching a database.
 */
import type {
  ActorType,
  ContractStatus,
  StaffRoleName,
} from "~/types/domain";
import { ACTOR_TYPES } from "~/types/domain";

// ─────────────────────────── Interval conversion ───────────────────────────

export type ShopifySellingPlanInterval = "DAY" | "WEEK" | "MONTH" | "YEAR";

/**
 * Shopify deliveryPolicy {interval, intervalCount} → whole weeks.
 * MONTH is approximated as 4 weeks (documented in docs/CORE.md); DAY rounds
 * up to at least one week; YEAR = 52 weeks.
 */
export function intervalToWeeks(
  interval: ShopifySellingPlanInterval,
  intervalCount: number,
): number {
  const count = Math.max(1, Math.round(intervalCount));
  switch (interval) {
    case "WEEK":
      return count;
    case "MONTH":
      return count * 4;
    case "YEAR":
      return count * 52;
    case "DAY":
      return Math.max(1, Math.ceil(count / 7));
    default:
      return count;
  }
}

/** We always write cadence back to Shopify in exact weeks. */
export function weeksToInterval(weeks: number): {
  interval: "WEEK";
  intervalCount: number;
} {
  return { interval: "WEEK", intervalCount: Math.max(1, Math.round(weeks)) };
}

// ─────────────────────────── Status mapping ────────────────────────────────

/**
 * Shopify SubscriptionContractSubscriptionStatus → local ContractStatus.
 * STALE (Shopify gave up billing) maps to FAILED; anything unknown is treated
 * as FAILED so it surfaces for review instead of silently looking healthy.
 */
export function mapShopifyContractStatus(status: string): ContractStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "FAILED":
    case "STALE":
    default:
      return "FAILED";
  }
}

// ─────────────────────────── Money formatting ──────────────────────────────

/** Integer cents → Shopify Decimal input string ("1234" cents → "12.34"). */
export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Subscriber price for a contract line: the variant's storefront price with
 * the plan discount applied. Contract-line mirror prices are ALWAYS the
 * already-discounted subscription prices, so every path that writes a line
 * price to Shopify (variant swap, added line) must run the base price through
 * this — otherwise the customer silently loses their plan discount.
 *
 * A null / zero / out-of-range percentOff means "no recorded discount" and
 * returns the base price unchanged (matches historic behaviour for cohorts
 * without an attributed discount).
 */
export function planAdjustedPriceCents(
  percentOff: number | null,
  variantPriceCents: number,
): number {
  if (
    percentOff == null ||
    !Number.isFinite(percentOff) ||
    percentOff <= 0 ||
    percentOff >= 100
  ) {
    return variantPriceCents;
  }
  return Math.round(variantPriceCents * (1 - percentOff / 100));
}

// ─────────────────────────── Idempotency keys ──────────────────────────────

/**
 * Spec'd billing key: bill:<localContractId>:<billingCycleIndex>[:<attempt>].
 * `attempt` distinguishes deliberate re-attempts for the SAME unpaid cycle
 * (e.g. dunning retries) so each retry actually reaches Shopify while each
 * individual attempt stays replay-safe.
 */
export function billingIdempotencyKey(
  contractId: string,
  billingCycleIndex: number,
  attempt?: string | number,
): string {
  return attempt === undefined
    ? `bill:${contractId}:${billingCycleIndex}`
    : `bill:${contractId}:${billingCycleIndex}:${attempt}`;
}

/** Deterministic non-crypto fingerprint (djb2) of arbitrary JSON-able args. */
export function stableFingerprint(input: unknown): string {
  const s = JSON.stringify(input) ?? "null";
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Key for a contract edit. Same contract + action + args within the TTL
 * window replays instead of double-firing (double-click protection).
 *
 * `versionToken` (the contract row's `updatedAt`, ISO string) folds the
 * mirror's version into the fingerprint: every successful edit re-syncs the
 * mirror and bumps `updatedAt`, so a legitimate A→B→A sequence (quantity
 * 1→2→1, pause→resume→pause, cadence toggle) gets a FRESH key for the second
 * "A" and executes instead of silently replaying the first "A" with a success
 * banner. True double-submits still replay: nothing changed between the two
 * requests, so the token — and therefore the key — is identical.
 */
export function contractOpKey(
  contractId: string,
  action: string,
  args: unknown,
  versionToken?: string,
): string {
  const fingerprint =
    versionToken === undefined
      ? stableFingerprint(args)
      : stableFingerprint({ args, versionToken });
  return `contract:${contractId}:${action}:${fingerprint}`;
}

// ─────────────────────────── Acquisition parsing ───────────────────────────

export interface AcquisitionAttribution {
  widgetVersion: string | null;
  experimentKey: string | null;
  variantKey: string | null;
  initialDiscountPercent: number | null;
  utm: Record<string, string>;
  custom: Record<string, string>;
}

/**
 * Parse checkout/contract customAttributes into acquisition attribution.
 * Recognised keys: _cellexia_widget, _cellexia_experiment, _cellexia_variant,
 * _cellexia_discount_percent, utm_*; any other _cellexia_* lands in `custom`.
 */
export function parseAcquisitionAttributes(
  attributes: Array<{ key: string; value: string | null }> | null | undefined,
): AcquisitionAttribution {
  const out: AcquisitionAttribution = {
    widgetVersion: null,
    experimentKey: null,
    variantKey: null,
    initialDiscountPercent: null,
    utm: {},
    custom: {},
  };
  for (const attr of attributes ?? []) {
    const value = attr.value ?? "";
    if (!value) continue;
    if (attr.key === "_cellexia_widget") out.widgetVersion = value;
    else if (attr.key === "_cellexia_experiment") out.experimentKey = value;
    else if (attr.key === "_cellexia_variant") out.variantKey = value;
    else if (attr.key === "_cellexia_discount_percent") {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) out.initialDiscountPercent = n;
    } else if (attr.key.startsWith("utm_")) out.utm[attr.key] = value;
    else if (attr.key.startsWith("_cellexia_")) out.custom[attr.key] = value;
  }
  return out;
}

// ─────────────────────────── RBAC matrix ───────────────────────────────────

/**
 * OWNER and ADMIN pass every check. Other roles pass only when explicitly
 * listed. An empty requirement list means "any recognised staff role".
 */
export function isRoleAllowed(
  role: StaffRoleName,
  required: readonly StaffRoleName[],
): boolean {
  if (role === "OWNER" || role === "ADMIN") return true;
  if (required.length === 0) return true;
  return required.includes(role);
}

export interface Actor {
  type: ActorType;
  id?: string | null;
}

/** Tolerant actor normalisation: "STAFF" | "cs@x.com" | {type,id} all work. */
export function normalizeActor(
  actor: Actor | ActorType | string | null | undefined,
): Actor {
  if (!actor) return { type: "SYSTEM", id: null };
  if (typeof actor === "string") {
    if ((ACTOR_TYPES as readonly string[]).includes(actor)) {
      return { type: actor as ActorType, id: null };
    }
    return { type: "STAFF", id: actor };
  }
  return { type: actor.type, id: actor.id ?? null };
}

// ─────────────────────────── Reconciliation diff ───────────────────────────

/** "gid://shopify/Order/123" and "123" compare equal. */
export function normalizeOrderId(id: string | null | undefined): string | null {
  if (!id) return null;
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

export interface ReconcileLocalAttempt {
  contractId: string;
  orderId: string | null;
  amountCents: number | null;
}

export interface ReconcileShopifyOrder {
  id: string;
  totalCents: number;
}

export interface ReconcileDiff {
  /** Shopify subscription orders with no matching successful local attempt. */
  ordersWithoutAttempt: string[];
  /** Successful local attempts whose order was not found on Shopify. */
  attemptsWithoutOrder: Array<{ contractId: string; orderId: string | null }>;
  amountMismatches: Array<{
    orderId: string;
    localCents: number;
    shopifyCents: number;
  }>;
  /** Matched successful attempts recorded with no amount (local revenue 0). */
  unpricedAttempts: Array<{
    contractId: string;
    orderId: string;
    shopifyCents: number;
  }>;
}

export function diffReconcile(
  attempts: ReconcileLocalAttempt[],
  orders: ReconcileShopifyOrder[],
): ReconcileDiff {
  const attemptsByOrder = new Map<string, ReconcileLocalAttempt>();
  for (const a of attempts) {
    const key = normalizeOrderId(a.orderId);
    if (key) attemptsByOrder.set(key, a);
  }
  const orderIds = new Set<string>();
  const diff: ReconcileDiff = {
    ordersWithoutAttempt: [],
    attemptsWithoutOrder: [],
    amountMismatches: [],
    unpricedAttempts: [],
  };
  for (const order of orders) {
    const key = normalizeOrderId(order.id);
    if (!key) continue;
    orderIds.add(key);
    const attempt = attemptsByOrder.get(key);
    if (!attempt) {
      diff.ordersWithoutAttempt.push(order.id);
    } else if (attempt.amountCents == null) {
      // A SUCCESS attempt with no amount contributed 0 to totalRevenueCents —
      // surface it instead of letting the revenue drift sail through.
      diff.unpricedAttempts.push({
        contractId: attempt.contractId,
        orderId: order.id,
        shopifyCents: order.totalCents,
      });
    } else if (attempt.amountCents !== order.totalCents) {
      diff.amountMismatches.push({
        orderId: order.id,
        localCents: attempt.amountCents,
        shopifyCents: order.totalCents,
      });
    }
  }
  for (const a of attempts) {
    const key = normalizeOrderId(a.orderId);
    if (!key || !orderIds.has(key)) {
      diff.attemptsWithoutOrder.push({
        contractId: a.contractId,
        orderId: a.orderId,
      });
    }
  }
  return diff;
}

// ─────────────────────────── Product availability ──────────────────────────

/**
 * From a products/update webhook payload: a product is available when any
 * variant is untracked or has positive inventory.
 */
export function productIsAvailable(
  variants:
    | Array<{
        inventory_quantity?: number | null;
        inventory_management?: string | null;
        inventory_policy?: string | null;
      }>
    | null
    | undefined,
): boolean {
  if (!variants || variants.length === 0) return true;
  return variants.some(
    (v) =>
      v.inventory_management == null ||
      v.inventory_policy === "continue" ||
      (v.inventory_quantity ?? 0) > 0,
  );
}
