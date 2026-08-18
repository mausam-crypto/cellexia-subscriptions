import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Delivery-tracking mirror (v1.28.0, P4.2 "Your deliveries").
 *
 * The renewal order's shipping facts live on BillingAttempt (migration 0028:
 * trackingUrl / trackingCompany / trackingNumber / orderStatusUrl /
 * shippedAt / deliveredAt) so the portal's deliveries list and the
 * "track your parcel" links read the local mirror and never call the Admin
 * API (read_orders is 60-day limited; the mirror is the source of truth).
 *
 * Fed by four webhook topics, all funnelled through `applyDeliveryTracking`:
 *   - orders/fulfilled          — full order: first fulfillment's tracking,
 *                                 created_at (ship instant), order_status_url
 *   - fulfillments/create       — fulfillment: tracking + created_at
 *   - fulfillments/update       — tracking edits (number added later by the
 *                                 3PL) and shipment_status "delivered"
 *   - fulfillment_events/create — status "delivered" (happened_at)
 *   - the billing-success settlement — orderStatusUrl from the order summary
 *
 * Rules (all idempotent — a redelivery or a second topic carrying the same
 * facts writes nothing and logs nothing):
 *   - only attempts of OWNED contracts are ever written (the same
 *     isBillableOwnership gate as every other order-matched handler);
 *   - tracking url/company/number: incoming non-null values overwrite (the
 *     carrier's number often arrives on a later fulfillments/update), nulls
 *     keep what is stored;
 *   - orderStatusUrl: overwrite when it changes;
 *   - shippedAt / deliveredAt: FIRST WINS (split shipments keep the earliest
 *     instant; a delivered milestone never moves back). Race-safe: the two
 *     milestone columns are written with GUARDED conditional updates
 *     (updateMany where { id, shippedAt: null } / { id, deliveredAt: null })
 *     — orders/fulfilled and fulfillments/create land for the same
 *     fulfillment at the same instant and the webhook route does not
 *     serialize topics, so a read-then-write would double-stamp and
 *     double-log. Only the writer whose guarded update affected the row
 *     logs the milestone;
 *   - contract.delivery_shipped / contract.delivery_delivered are logged
 *     exactly on the null→set transition of the corresponding column —
 *     analytics only (no Klaviyo mapping, no email: Klaviyo owns shipping
 *     emails);
 *   - a CANCELLED fulfillment (fulfillments/update status cancelled | error
 *     | failure) un-ships the mirror when the stored tracking is the
 *     cancelled fulfillment's (url or number match, or — with no tracking on
 *     either side — the same created_at): tracking url/company/number are
 *     cleared, shippedAt is cleared unless a delivered stamp exists, and
 *     contract.delivery_shipment_cancelled is logged. Tracking that belongs
 *     to another (live) fulfillment of the same order is left alone.
 *
 * Contained by design: every caller wraps this in try/catch — a tracking
 * mirror failure must never fail a webhook, and never a billing settlement.
 */

export interface DeliveryTrackingInput {
  shopId: string;
  orderGid: string;
  /** Webhook topic / caller label, recorded on the events. */
  source: string;
  orderName?: string | null;
  orderStatusUrl?: string | null;
  tracking?: {
    url: string | null;
    company: string | null;
    number: string | null;
  } | null;
  /** The fulfillment's created_at — becomes shippedAt (first wins). */
  shippedAt?: Date | null;
  /** A delivered signal's instant — becomes deliveredAt (first wins). */
  deliveredAt?: Date | null;
  /**
   * A fulfillment that was cancelled / failed: clears the mirrored tracking
   * (and the ship instant, unless delivered) WHEN the stored values are this
   * fulfillment's. Exclusive with the write inputs above.
   */
  cancelledTracking?: {
    url: string | null;
    number: string | null;
    /** The cancelled fulfillment's created_at (matches shippedAt when the
     * fulfillment carried no tracking at all). */
    createdAt: Date | null;
  } | null;
}

export type DeliveryTrackingOutcome =
  | "no_attempt"
  | "foreign"
  | "unchanged"
  | "updated";

export interface DeliveryTrackingResult {
  outcome: DeliveryTrackingOutcome;
  attemptId: string | null;
  /** Column names written (empty unless outcome === "updated"). */
  changed: string[];
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** Parse a Shopify ISO timestamp; null when missing or malformed. */
export function parseWebhookDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function applyDeliveryTracking(
  input: DeliveryTrackingInput,
): Promise<DeliveryTrackingResult> {
  const attempt = await prisma.billingAttempt.findFirst({
    where: { orderId: input.orderGid, contract: { shopId: input.shopId } },
    select: {
      id: true,
      contractId: true,
      cycleIndex: true,
      orderName: true,
      trackingUrl: true,
      trackingCompany: true,
      trackingNumber: true,
      orderStatusUrl: true,
      shippedAt: true,
      deliveredAt: true,
      contract: {
        select: { id: true, customerId: true, email: true, ownership: true },
      },
    },
  });
  if (!attempt) return { outcome: "no_attempt", attemptId: null, changed: [] };
  if (!isBillableOwnership(attempt.contract.ownership)) {
    return { outcome: "foreign", attemptId: attempt.id, changed: [] };
  }

  const base = {
    shopId: input.shopId,
    contractId: attempt.contract.id,
    customerId: attempt.contract.customerId,
    email: attempt.contract.email,
    source: "WEBHOOK" as const,
  };
  const orderName = attempt.orderName ?? input.orderName ?? null;

  // ── Cancelled fulfillment: un-ship when the mirror holds ITS facts ────────
  if (input.cancelledTracking) {
    const c = input.cancelledTracking;
    const createdAt = validDate(c.createdAt);
    const storedHasTracking = attempt.trackingUrl != null || attempt.trackingNumber != null;
    const matches =
      (c.url != null && c.url === attempt.trackingUrl) ||
      (c.number != null && c.number === attempt.trackingNumber) ||
      (!storedHasTracking &&
        c.url == null &&
        c.number == null &&
        createdAt != null &&
        attempt.shippedAt != null &&
        attempt.shippedAt.getTime() === createdAt.getTime());
    if (!matches) return { outcome: "unchanged", attemptId: attempt.id, changed: [] };
    const clear: {
      trackingUrl: null;
      trackingCompany: null;
      trackingNumber: null;
      shippedAt?: null;
    } = { trackingUrl: null, trackingCompany: null, trackingNumber: null };
    // A delivered parcel stays delivered — only an undelivered ship instant
    // is withdrawn with its fulfillment.
    if (attempt.deliveredAt == null && attempt.shippedAt != null) clear.shippedAt = null;
    const cleared = Object.keys(clear);
    await prisma.billingAttempt.update({ where: { id: attempt.id }, data: clear });
    await logEvent({
      ...base,
      type: "contract.delivery_shipment_cancelled",
      payload: {
        orderId: input.orderGid,
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        orderName,
        trackingCompany: attempt.trackingCompany,
        unshipped: clear.shippedAt === null,
        via: input.source,
      },
    });
    return { outcome: "updated", attemptId: attempt.id, changed: cleared };
  }

  const data: {
    trackingUrl?: string;
    trackingCompany?: string;
    trackingNumber?: string;
    orderStatusUrl?: string;
  } = {};

  const tracking = input.tracking;
  if (tracking) {
    if (tracking.url && tracking.url !== attempt.trackingUrl) {
      data.trackingUrl = tracking.url;
    }
    if (tracking.company && tracking.company !== attempt.trackingCompany) {
      data.trackingCompany = tracking.company;
    }
    if (tracking.number && tracking.number !== attempt.trackingNumber) {
      data.trackingNumber = tracking.number;
    }
  }
  if (input.orderStatusUrl && input.orderStatusUrl !== attempt.orderStatusUrl) {
    data.orderStatusUrl = input.orderStatusUrl;
  }
  const shippedAt = validDate(input.shippedAt);
  const wantShipped = shippedAt != null && attempt.shippedAt == null;
  const deliveredAt = validDate(input.deliveredAt);
  const wantDelivered = deliveredAt != null && attempt.deliveredAt == null;

  const changed = Object.keys(data);
  if (changed.length === 0 && !wantShipped && !wantDelivered) {
    return { outcome: "unchanged", attemptId: attempt.id, changed };
  }

  // Tracking / order page: plain overwrite (last non-null wins by design).
  if (changed.length > 0) {
    await prisma.billingAttempt.update({ where: { id: attempt.id }, data });
  }
  // Milestones: guarded null→set writes. The affected-row count — not the
  // snapshot read above — decides who logs, so two concurrent topics
  // carrying the same milestone stamp it once and log it once.
  let shippedStamped: Date | null = null;
  if (wantShipped && shippedAt) {
    const r = await prisma.billingAttempt.updateMany({
      where: { id: attempt.id, shippedAt: null },
      data: { shippedAt },
    });
    if (r.count === 1) {
      shippedStamped = shippedAt;
      changed.push("shippedAt");
    }
  }
  let deliveredStamped: Date | null = null;
  if (wantDelivered && deliveredAt) {
    const r = await prisma.billingAttempt.updateMany({
      where: { id: attempt.id, deliveredAt: null },
      data: { deliveredAt },
    });
    if (r.count === 1) {
      deliveredStamped = deliveredAt;
      changed.push("deliveredAt");
    }
  }
  if (changed.length === 0) {
    // Lost both guarded writes to a concurrent topic: nothing of ours landed.
    return { outcome: "unchanged", attemptId: attempt.id, changed };
  }

  const trackingCompany = data.trackingCompany ?? attempt.trackingCompany;
  const hasTracking =
    (data.trackingUrl ?? attempt.trackingUrl) != null ||
    (data.trackingNumber ?? attempt.trackingNumber) != null;

  // Events fire on the column transition only, so a second topic carrying
  // the same milestone (orders/fulfilled + fulfillments/create) logs once.
  // No tracking number on the stream (same rule as billing.order_fulfilled).
  if (shippedStamped) {
    await logEvent({
      ...base,
      type: "contract.delivery_shipped",
      payload: {
        orderId: input.orderGid,
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        orderName,
        shippedAt: shippedStamped.toISOString(),
        trackingCompany,
        hasTracking,
        via: input.source,
      },
    });
  }
  if (deliveredStamped) {
    await logEvent({
      ...base,
      type: "contract.delivery_delivered",
      payload: {
        orderId: input.orderGid,
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        orderName,
        deliveredAt: deliveredStamped.toISOString(),
        trackingCompany,
        via: input.source,
      },
    });
  }

  return { outcome: "updated", attemptId: attempt.id, changed };
}

/**
 * Same as applyDeliveryTracking but never throws — for webhook handlers and
 * the settlement path, where the mirror is a side effect, not the job.
 */
export async function applyDeliveryTrackingContained(
  input: DeliveryTrackingInput,
): Promise<DeliveryTrackingResult | null> {
  try {
    return await applyDeliveryTracking(input);
  } catch (err) {
    console.error(
      "[webhooks] delivery tracking mirror failed",
      input.source,
      input.orderGid,
      err,
    );
    return null;
  }
}
