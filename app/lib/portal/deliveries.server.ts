import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate } from "~/lib/dates.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * "Your deliveries" (v1.28.0, P4.2) — the portal's read of the local order
 * mirror: every successful charge is a delivery row (date, order name,
 * amount, shipping status, Track / View order links). Reads BillingAttempt
 * only (the columns the FULFILLMENTS webhooks + settlement mirror; migration
 * 0028) — never the Admin API, whose read_orders scope stops at 60 days.
 *
 * Status is derived, never guessed:
 *   delivered  — deliveredAt set (fulfillment_events/create "delivered" or
 *                fulfillments/update shipment_status "delivered")
 *   shipped    — shippedAt or fulfilledAt set (a fulfillment exists)
 *   refunded   — nothing shipped and the charge was refunded in full
 *                (BillingAttempt.refundedCents via REFUNDS_CREATE, e.g. the
 *                merchant cancelled + refunded the order before it left):
 *                the row says "Refunded" and never "Being prepared", and no
 *                amount is listed as if it had been kept
 *   processing — charged, no fulfillment mirrored yet
 *   unknown    — the attempt predates the mirror (charged before v1.28.0 /
 *                the fulfillment topics were not deployed): the row still
 *                links to the Shopify order page when we hold its URL, and
 *                the copy says "see the order page", never "processing".
 *
 * Cycle 0 (the checkout order) is not a BillingAttempt: listDeliveries /
 * listCustomerDeliveries synthesize ONE origin row per contract from the
 * contract mirror (originOrderName / ProcessedAt / TotalCents /
 * RefundedCents / FulfilledAt) so a first-cycle subscriber sees the order
 * they actually paid for instead of the empty state. The origin row has no
 * tracking / order-page URL — the fulfillment webhooks match BillingAttempt
 * only (Shopify's own checkout shipping notification carries the tracking).
 *
 * Receipt: Shopify's order-status page carries the receipt (and the tracking
 * widget) — there is no app-generated invoice, and the copy says so. Every
 * link is a plain anchor with rel="noopener": no admin API, no proxying.
 */

export type DeliveryStatus =
  | "processing"
  | "shipped"
  | "delivered"
  | "refunded"
  | "unknown";

export interface DeliveryRow {
  /** BillingAttempt id; `origin:{contractId}` for the synthesized cycle-0 row. */
  attemptId: string;
  contractId: string;
  cycleIndex: number;
  /** Charge instant (completedAt, else scheduledFor). */
  date: Date;
  orderId: string | null;
  orderName: string | null;
  amountCents: number | null;
  /** Refunded so far (REFUNDS_CREATE); 0 when none. */
  refundedCents: number;
  currencyCode: string | null;
  status: DeliveryStatus;
  trackingUrl: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  orderStatusUrl: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  /** The subscription's recurring line titles — the row's label. */
  itemsSummary: string;
}

/**
 * The status rule, exported so its truth table is pinnable. `mirrorFloor`
 * is the moment the delivery mirror started writing (v1.28.0 rollout): a
 * charge before it with nothing mirrored is "unknown", not "processing" —
 * we cannot claim an order from last spring is still being prepared.
 */
export function deliveryStatusOf(
  a: {
    completedAt: Date | null;
    scheduledFor: Date;
    fulfilledAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    amountCents?: number | null;
    refundedCents?: number | null;
  },
  opts: { now: Date; mirrorFloor?: Date | null; processingMaxDays?: number },
): DeliveryStatus {
  if (a.deliveredAt) return "delivered";
  if (a.shippedAt || a.fulfilledAt) return "shipped";
  // Refunded in full before anything shipped: not "being prepared".
  const refunded = a.refundedCents ?? 0;
  if (refunded > 0 && a.amountCents != null && refunded >= a.amountCents) {
    return "refunded";
  }
  const chargedAt = a.completedAt ?? a.scheduledFor;
  if (opts.mirrorFloor && chargedAt.getTime() < opts.mirrorFloor.getTime()) {
    return "unknown";
  }
  // A charge with no fulfillment mirrored for a long time is not honestly
  // "processing" either — most likely the fulfillment topics were not
  // deployed for it. Default 30 days (merchant-tunable by the caller).
  const maxDays = opts.processingMaxDays ?? 30;
  if (opts.now.getTime() - chargedAt.getTime() > maxDays * 86_400_000) {
    return "unknown";
  }
  return "processing";
}

interface ListOptions {
  limit?: number;
  now?: Date;
  /** Charges before this instant with nothing mirrored read "unknown". */
  mirrorFloor?: Date | null;
  processingMaxDays?: number;
}

const ATTEMPT_SELECT = {
  id: true,
  contractId: true,
  cycleIndex: true,
  completedAt: true,
  scheduledFor: true,
  orderId: true,
  orderName: true,
  amountCents: true,
  refundedCents: true,
  currencyCode: true,
  fulfilledAt: true,
  shippedAt: true,
  deliveredAt: true,
  trackingUrl: true,
  trackingCompany: true,
  trackingNumber: true,
  orderStatusUrl: true,
  contract: {
    select: {
      id: true,
      currencyCode: true,
      lines: {
        select: { title: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
  },
} as const;

type AttemptRow = {
  id: string;
  contractId: string;
  cycleIndex: number;
  completedAt: Date | null;
  scheduledFor: Date;
  orderId: string | null;
  orderName: string | null;
  amountCents: number | null;
  refundedCents?: number | null;
  currencyCode: string | null;
  fulfilledAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  orderStatusUrl: string | null;
  contract: {
    id: string;
    currencyCode: string;
    lines: Array<{ title: string }>;
  };
};

function toRow(a: AttemptRow, opts: ListOptions): DeliveryRow {
  const now = opts.now ?? new Date();
  return {
    attemptId: a.id,
    contractId: a.contractId,
    cycleIndex: a.cycleIndex,
    date: a.completedAt ?? a.scheduledFor,
    orderId: a.orderId,
    orderName: a.orderName,
    amountCents: a.amountCents,
    refundedCents: a.refundedCents ?? 0,
    currencyCode: a.currencyCode ?? a.contract.currencyCode ?? null,
    status: deliveryStatusOf(a, {
      now,
      mirrorFloor: opts.mirrorFloor ?? null,
      processingMaxDays: opts.processingMaxDays,
    }),
    trackingUrl: a.trackingUrl,
    trackingCompany: a.trackingCompany,
    trackingNumber: a.trackingNumber,
    orderStatusUrl: a.orderStatusUrl,
    shippedAt: a.shippedAt ?? a.fulfilledAt,
    deliveredAt: a.deliveredAt,
    itemsSummary: a.contract.lines.map((l) => l.title).join(", "),
  };
}

const ORIGIN_SELECT = {
  id: true,
  originOrderId: true,
  originOrderName: true,
  originOrderProcessedAt: true,
  originOrderTotalCents: true,
  originOrderRefundedCents: true,
  originOrderCurrencyCode: true,
  originOrderFulfilledAt: true,
  currencyCode: true,
  createdAt: true,
  lines: { select: { title: true }, orderBy: { createdAt: "asc" as const } },
} as const;

type OriginContractRow = {
  id: string;
  originOrderId: string | null;
  originOrderName: string | null;
  originOrderProcessedAt: Date | null;
  originOrderTotalCents: number | null;
  originOrderRefundedCents: number | null;
  originOrderCurrencyCode: string | null;
  originOrderFulfilledAt: Date | null;
  currencyCode: string;
  createdAt: Date;
  lines: Array<{ title: string }>;
};

/**
 * The cycle-0 row for a contract's checkout order, or null when the mirror
 * holds no origin order (imports, backfills). Pure — exported so its shape
 * is pinnable. Date = the order's processedAt (never the mirror row's
 * birth); status from originOrderFulfilledAt (orders/fulfilled origin
 * branch) with the same processing/unknown/refunded rules as renewals.
 */
export function originDeliveryRow(
  c: OriginContractRow,
  opts: ListOptions,
): DeliveryRow | null {
  if (!c.originOrderId || !c.originOrderProcessedAt) return null;
  const now = opts.now ?? new Date();
  const status = deliveryStatusOf(
    {
      completedAt: c.originOrderProcessedAt,
      scheduledFor: c.originOrderProcessedAt,
      fulfilledAt: c.originOrderFulfilledAt,
      shippedAt: null,
      deliveredAt: null,
      amountCents: c.originOrderTotalCents,
      refundedCents: c.originOrderRefundedCents ?? 0,
    },
    { now, mirrorFloor: opts.mirrorFloor ?? null, processingMaxDays: opts.processingMaxDays },
  );
  return {
    attemptId: `origin:${c.id}`,
    contractId: c.id,
    cycleIndex: 0,
    date: c.originOrderProcessedAt,
    orderId: c.originOrderId,
    orderName: c.originOrderName,
    amountCents: c.originOrderTotalCents,
    refundedCents: c.originOrderRefundedCents ?? 0,
    currencyCode: c.originOrderCurrencyCode ?? c.currencyCode ?? null,
    status,
    trackingUrl: null,
    trackingCompany: null,
    trackingNumber: null,
    orderStatusUrl: null,
    shippedAt: c.originOrderFulfilledAt,
    deliveredAt: null,
    itemsSummary: c.lines.map((l) => l.title).join(", "),
  };
}

/** Newest first, then the synthesized origin rows sort by their date too. */
function sortNewestFirst(rows: DeliveryRow[]): DeliveryRow[] {
  return rows.sort(
    (a, b) => b.date.getTime() - a.date.getTime() || b.cycleIndex - a.cycleIndex,
  );
}

/** Deliveries of ONE contract, newest first (successful charges + cycle 0). */
export async function listDeliveries(
  contractId: string,
  opts: ListOptions = {},
): Promise<DeliveryRow[]> {
  const limit = opts.limit ?? 10;
  const rows = (await prisma.billingAttempt.findMany({
    where: { contractId, status: "SUCCESS" },
    orderBy: [{ completedAt: "desc" }, { cycleIndex: "desc" }],
    take: limit,
    select: ATTEMPT_SELECT,
  })) as unknown as AttemptRow[];
  const out = rows.map((a) => toRow(a, opts));
  // Cycle 0 (contained: a failed contract read leaves the renewal rows).
  try {
    const c = (await prisma.subscriptionContract.findUnique({
      where: { id: contractId },
      select: ORIGIN_SELECT,
    })) as unknown as OriginContractRow | null;
    const origin = c ? originDeliveryRow(c, opts) : null;
    if (origin && !out.some((r) => r.orderId != null && r.orderId === origin.orderId)) {
      out.push(origin);
    }
  } catch (err) {
    console.error("[portal] deliveries: origin order read failed", contractId, err);
  }
  return sortNewestFirst(out).slice(0, limit);
}

/**
 * Deliveries across ALL of a customer's owned contracts on this shop, newest
 * first — the Account tab list. OURS_ONLY: another app's renewals are not in
 * our mirror and must not be counted as ours.
 */
export async function listCustomerDeliveries(
  shopId: string,
  customerId: string,
  opts: ListOptions = {},
): Promise<DeliveryRow[]> {
  const limit = opts.limit ?? 10;
  const rows = (await prisma.billingAttempt.findMany({
    where: {
      status: "SUCCESS",
      contract: { shopId, customerId, ...OURS_ONLY },
    },
    orderBy: [{ completedAt: "desc" }, { cycleIndex: "desc" }],
    take: limit,
    select: ATTEMPT_SELECT,
  })) as unknown as AttemptRow[];
  const out = rows.map((a) => toRow(a, opts));
  try {
    const contracts = (await prisma.subscriptionContract.findMany({
      where: { shopId, customerId, ...OURS_ONLY, originOrderId: { not: null } },
      select: ORIGIN_SELECT,
    })) as unknown as OriginContractRow[];
    for (const c of contracts) {
      const origin = originDeliveryRow(c, opts);
      if (origin && !out.some((r) => r.orderId != null && r.orderId === origin.orderId)) {
        out.push(origin);
      }
    }
  } catch (err) {
    console.error("[portal] deliveries: origin order read failed", customerId, err);
  }
  return sortNewestFirst(out).slice(0, limit);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

/** Only http(s) URLs are ever rendered as links (webhook payload hygiene). */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

export function deliveryStatusLabel(locale: string, status: DeliveryStatus): string {
  return t(locale, `portal.deliveries.status.${status}`);
}

/**
 * The "Your deliveries" card. Pure: takes rows + formatting context, returns
 * HTML (cxs- namespace). Empty rows → the honest empty state (no card at all
 * when `hideWhenEmpty`). The receipt sentence names Shopify's order page as
 * the place the receipt lives — the app issues no invoices.
 */
export function deliveriesCardHtml(input: {
  locale: string;
  tz: string;
  rows: DeliveryRow[];
  /** Card heading id (a11y landmark), default "cxs-deliveries". */
  id?: string;
  hideWhenEmpty?: boolean;
}): string {
  const { locale, tz, rows } = input;
  const id = input.id ?? "cxs-deliveries";
  if (rows.length === 0 && input.hideWhenEmpty) return "";

  const items = rows
    .map((r) => {
      const status = deliveryStatusLabel(locale, r.status);
      const dateLabel = formatShopDate(r.date, tz, locale);
      // A fully refunded row lists no amount as if it had been kept.
      const amount =
        r.status !== "refunded" && r.amountCents != null && r.currencyCode
          ? formatMoney(r.amountCents, r.currencyCode, locale)
          : null;
      const title = r.orderName
        ? t(locale, "portal.deliveries.row_title", { order: r.orderName, date: dateLabel })
        : dateLabel;
      const metaParts = [
        status,
        amount,
        r.itemsSummary || null,
        r.status === "shipped" && r.shippedAt
          ? t(locale, "portal.deliveries.shipped_on", {
              date: formatShopDate(r.shippedAt, tz, locale),
            })
          : null,
        r.status === "delivered" && r.deliveredAt
          ? t(locale, "portal.deliveries.delivered_on", {
              date: formatShopDate(r.deliveredAt, tz, locale),
            })
          : null,
        r.trackingCompany && (r.status === "shipped" || r.status === "delivered")
          ? t(locale, "portal.deliveries.carrier", { carrier: r.trackingCompany })
          : null,
      ].filter((p): p is string => p != null && p.length > 0);

      const track = safeHref(r.trackingUrl);
      const orderPage = safeHref(r.orderStatusUrl);
      const links: string[] = [];
      if (track) {
        links.push(
          `<a class="cxs-linklike cxs-deliveries__track" href="${escapeHtml(track)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.deliveries.track"))}</a>`,
        );
      }
      if (orderPage) {
        links.push(
          `<a class="cxs-linklike cxs-deliveries__order" href="${escapeHtml(orderPage)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.deliveries.view_order"))}</a>`,
        );
      }
      const linksHtml = links.length
        ? `<div class="cxs-deliveries__links cxs-small">${links.join(" · ")}</div>`
        : "";
      return `<div class="cxs-item cxs-deliveries__row cxs-deliveries__row--${r.status}" data-status="${r.status}"><div class="cxs-item__body"><p class="cxs-item__title">${escapeHtml(title)}</p><p class="cxs-item__meta">${escapeHtml(metaParts.join(" · "))}</p>${linksHtml}</div></div>`;
    })
    .join("");

  const body = rows.length
    ? items
    : `<p class="cxs-muted cxs-small" style="margin:6px 0 0">${escapeHtml(t(locale, "portal.deliveries.empty"))}</p>`;
  const receiptNote = rows.some((r) => safeHref(r.orderStatusUrl))
    ? `<p class="cxs-muted cxs-small cxs-deliveries__receipt-note" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.deliveries.receipt_note"))}</p>`
    : "";

  return `<section class="cxs-card cxs-deliveries" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title"><span class="cxs-label" id="${escapeHtml(id)}-title">${escapeHtml(t(locale, "portal.deliveries.title"))}</span>${body}${receiptNote}</section>`;
}

// ── In transit ("on its way") ────────────────────────────────────────────────

/**
 * The newest delivery when it is SHIPPED and not delivered — the parcel the
 * customer is waiting for right now — or null. Truth guard: a shipment older
 * than `maxDays` past its ship instant (portal.deliveriesInTransitMaxDays)
 * is not honestly "on its way" — many stores never post a delivered signal,
 * and a weeks-old parcel would otherwise be announced forever. Rows are the
 * newest-first list from listDeliveries; only the FIRST row counts (a newer
 * charge still being prepared means the previous parcel is no longer the
 * story of the page — the hero already talks about the next order).
 */
export function latestInTransit(
  rows: DeliveryRow[],
  opts: { now?: Date; maxDays?: number } = {},
): DeliveryRow | null {
  const latest = rows[0];
  if (!latest || latest.status !== "shipped" || !latest.shippedAt) return null;
  const now = opts.now ?? new Date();
  const maxDays = opts.maxDays ?? 14;
  const age = now.getTime() - latest.shippedAt.getTime();
  if (age < 0 || age > maxDays * 86_400_000) return null;
  return latest;
}

/** The single "Track" / "View order" link an in-transit surface carries. */
function transitLink(
  locale: string,
  row: DeliveryRow,
  extraClass: string,
): string {
  const track = safeHref(row.trackingUrl);
  if (track) {
    return `<a class="cxs-linklike ${extraClass} cxs-deliveries__track" href="${escapeHtml(track)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.deliveries.track_short"))}</a>`;
  }
  const orderPage = safeHref(row.orderStatusUrl);
  if (orderPage) {
    return `<a class="cxs-linklike ${extraClass} cxs-deliveries__order" href="${escapeHtml(orderPage)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.deliveries.view_order_short"))}</a>`;
  }
  return "";
}

/**
 * The detail page's in-transit banner under the hero: "Your {date} order is
 * on its way — Track". role="status" (a live fact, not an alert). Empty when
 * `row` is null.
 */
export function inTransitBannerHtml(input: {
  locale: string;
  tz: string;
  row: DeliveryRow | null;
}): string {
  const { locale, tz, row } = input;
  if (!row) return "";
  const text = t(locale, "portal.deliveries.in_transit", {
    date: formatShopDate(row.date, tz, locale),
  });
  const link = transitLink(locale, row, "cxs-deliveries__transit-link");
  return `<div class="cxs-banner cxs-deliveries__transit" id="cxs-in-transit" role="status"><p><span class="cxs-deliveries__transit-text">${escapeHtml(text)}</span>${link ? ` — ${link}` : ""}</p></div>`;
}

/**
 * The home card's one-liner: "On its way · Track". Empty when `row` is null.
 */
export function inTransitLineHtml(input: {
  locale: string;
  row: DeliveryRow | null;
}): string {
  const { locale, row } = input;
  if (!row) return "";
  const link = transitLink(locale, row, "cxs-deliveries__transit-link");
  return `<p class="cxs-small cxs-deliveries__transit-line" role="status" style="margin:6px 0 0"><span class="cxs-deliveries__transit-text">${escapeHtml(t(locale, "portal.deliveries.in_transit_short"))}</span>${link ? ` · ${link}` : ""}</p>`;
}

/**
 * The newest successful charge of EACH given contract in one query (home
 * page: one "on its way" line per card without N reads). Prisma `distinct`
 * on contractId after the newest-first order keeps the first row per group.
 */
export async function latestDeliveryByContract(
  contractIds: string[],
  opts: ListOptions = {},
): Promise<Map<string, DeliveryRow>> {
  const out = new Map<string, DeliveryRow>();
  if (contractIds.length === 0) return out;
  const rows = (await prisma.billingAttempt.findMany({
    where: { contractId: { in: contractIds }, status: "SUCCESS" },
    orderBy: [{ completedAt: "desc" }, { cycleIndex: "desc" }],
    distinct: ["contractId"],
    select: ATTEMPT_SELECT,
  })) as unknown as AttemptRow[];
  for (const a of rows) {
    if (!out.has(a.contractId)) out.set(a.contractId, toRow(a, opts));
  }
  return out;
}
