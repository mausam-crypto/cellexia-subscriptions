import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate, formatShopTime, shopDayStartUtc } from "~/lib/dates.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import {
  estimateNextCharge,
  type EstimateContractLike,
  type EstimateOptions,
  type NextChargeEstimate,
} from "~/lib/billing/estimate.server";
import { nextChargeEstimateCents } from "~/lib/portal/payment.server";
import {
  editCutoffSync,
  preparingOrderDate,
  type AttemptLike,
  type ChargeTiming,
} from "~/lib/billing/timing.server";
import type { PriceChangeNotice } from "~/lib/portal/price-lock.server";

/**
 * "Your next delivery" hero (v1.28.0, P2.4 + P2.1) — the portal's one truthful
 * picture of the upcoming order:
 *
 *   date · "You can make changes until {cut-off}" (the charge moment,
 *   `editCutoff`) · the lines AS THEY WILL BILL (recurring, one-time add-ons
 *   marked "this order only", gift rows "(free)") · the live DiscountGrant
 *   line with "{k} discounted orders left" · delivery · ships-to · card · the
 *   DISCOUNTED total · "After that: {date}" · optional "line up with your
 *   other delivery" CTA · stock-out / price-change notice lines.
 *
 * Money-true rule: every figure comes from `estimateNextCharge()` — the same
 * computation the upcoming-order reminder states. Nothing here adds, sums or
 * discounts; it formats.
 *
 * "Preparing your order" (P2.1): once `isPreparingOrder` is true the hero
 * shows the chip + a note, and the route hides skip / delay / next-date /
 * frequency / swap for this cycle — changes apply from the following
 * delivery. Pure HTML builder: the route hands in URL/field helpers.
 */

export interface LineUpOption {
  /** Formatted date of the other delivery (display). */
  dateLabel: string;
  /** yyyy-MM-dd (shop tz) the next_date action accepts. */
  dateValue: string;
}

export interface NextDeliveryHeroInput {
  locale: string;
  tz: string;
  contract: {
    id: string;
    status: string;
    currencyCode: string;
    nextBillingDate: Date | null;
    /** Delivery instructions (P2.8) — shown under the ships-to line. */
    deliveryInstructions?: string | null;
  };
  estimate: NextChargeEstimate;
  /** editCutoff(nextBillingDate) — null when there is no next date. */
  cutoff: Date | null;
  /** isPreparingOrder(contract) — billing day reached / attempt in flight. */
  preparing: boolean;
  /**
   * `preparingOrderDate(contract)` — the billing date of the order being
   * prepared. While an attempt is in flight the mirror's nextBillingDate is
   * already the FOLLOWING cycle, so the header prints this date instead and
   * the "following delivery" note prints the mirror's date. Optional: absent
   * (or equal to nextBillingDate) keeps the classic rendering.
   */
  preparingOrderDate?: Date | null;
  /** Another ACTIVE contract with a different next date (null = none). */
  lineUp: LineUpOption | null;
  /** Titles of contract lines whose variant is currently out of stock. */
  outOfStockTitles: string[];
  /** Newest stock-out delay that produced the current next date (or null). */
  stockoutDelay: { title: string } | null;
  /** Pending price-change notice for this contract (or null). */
  priceChange: PriceChangeNotice | null;
  /** Status / card chip the route already resolved (rendered top-right). */
  chip: { label: string; className: string } | null;
  /** `/apps/cellexia-subs/api/{action}` with locale/preview carried. */
  apiUrl: (action: string) => string;
  /** Hidden inputs INCLUDING contractId / _csrf / return_to. */
  hiddenFields: (fields: Array<[string, string]>) => string;
}

/**
 * `estimateNextCharge` that never throws (portal pages must render). The
 * helper is contained internally; this guards against a bug in it. The
 * last-resort figure is Stage A's `nextChargeEstimateCents` — the SAME
 * arithmetic (pinned by parity), plan price without the grant.
 */
export async function safeEstimateNextCharge(
  shop: { id: string; ianaTimezone: string },
  contract: EstimateContractLike,
  opts: EstimateOptions = {},
): Promise<NextChargeEstimate> {
  try {
    return await estimateNextCharge(shop, contract, opts);
  } catch (err) {
    console.error("[portal] next-charge estimate failed", contract.id, err);
    const totalCents = nextChargeEstimateCents(contract, null);
    return {
      lines: contract.lines.map((l) => ({
        title: l.title,
        variantTitle: l.variantTitle ?? null,
        quantity: l.quantity,
        unitPriceCents: l.isGift ? 0 : l.currentPriceCents,
        lineTotalCents: l.isGift ? 0 : l.currentPriceCents * l.quantity,
        kind: l.isGift ? "gift" : l.isOneTimeAddon ? "one_time_addon" : "recurring",
        free: l.isGift === true,
        skippedThisCycle: false,
        variantId: l.variantId,
        imageUrl: l.imageUrl ?? null,
      })),
      subtotalCents: totalCents - contract.deliveryPriceCents,
      discountCents: 0,
      discountPercent: null,
      discountCyclesRemaining: null,
      discountLabel: null,
      totalCents,
      currency: contract.currencyCode,
      deliveryCents: contract.deliveryPriceCents,
      nextBillingDate: contract.nextBillingDate,
      followingBillingDate: null,
      cardLabel: "",
      addressSummary: null,
    };
  }
}

/** "17 August 2026, 00:00" — the same rendering the reminder email uses. */
export function cutoffLabel(locale: string, cutoff: Date, tz: string): string {
  return `${formatShopDate(cutoff, tz, locale)}, ${formatShopTime(cutoff, tz, locale)}`;
}

/** Sync convenience: cut-off for a contract's next date, or null. */
export function contractCutoff(
  nextBillingDate: Date | null,
  timing: ChargeTiming,
): Date | null {
  if (!nextBillingDate) return null;
  try {
    return editCutoffSync(nextBillingDate, timing);
  } catch (err) {
    console.error("[portal] cut-off failed", err);
    return null;
  }
}

/**
 * Preparing state for many contracts at once (portal home): one attempts
 * query, then the pure check per contract. Contained — a failed read answers
 * "not preparing" for every contract (the classic controls stay).
 */
export async function preparingByContract(
  contracts: Array<{ id: string; status: string; nextBillingDate: Date | null }>,
  timing: ChargeTiming,
  now: Date = new Date(),
): Promise<Map<string, boolean>> {
  const dates = await preparingOrderDateByContract(contracts, timing, now);
  const out = new Map<string, boolean>();
  for (const [id, date] of dates) out.set(id, date != null);
  return out;
}

/**
 * Same one-query read, answering the ORDER DATE being prepared per contract
 * (`preparingOrderDate`): null = not preparing; a date = preparing, and that
 * date is what the surface prints (the attempt's own date while in flight —
 * the mirror's nextBillingDate is already the following cycle then).
 */
export async function preparingOrderDateByContract(
  contracts: Array<{ id: string; status: string; nextBillingDate: Date | null }>,
  timing: ChargeTiming,
  now: Date = new Date(),
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  const active = contracts.filter((c) => c.status === "ACTIVE" && c.nextBillingDate);
  if (active.length === 0) return out;
  try {
    const attempts = await prisma.billingAttempt.findMany({
      where: { contractId: { in: active.map((c) => c.id) } },
      select: {
        contractId: true,
        status: true,
        originatingAction: true,
        startedAt: true,
        scheduledFor: true,
        supersededAt: true,
      },
    });
    const byContract = new Map<string, AttemptLike[]>();
    for (const a of attempts) {
      const list = byContract.get(a.contractId) ?? [];
      list.push(a);
      byContract.set(a.contractId, list);
    }
    for (const c of active) {
      out.set(
        c.id,
        preparingOrderDate(
          { ...c, billingAttempts: byContract.get(c.id) ?? [] },
          timing,
          now,
        ),
      );
    }
  } catch (err) {
    console.error("[portal] preparing state read failed", err);
  }
  return out;
}

/**
 * The customer's OTHER active contract with a different next delivery day
 * (shop tz) — the "line up with your other delivery" target. Null when there
 * is none, or when the sibling's date is not a valid next_date target
 * (outside [minDate, maxDate] of the next_date action). Pure.
 */
export function lineUpTarget(
  contract: { id: string; nextBillingDate: Date | null },
  siblings: Array<{ id: string; status: string; nextBillingDate: Date | null }>,
  opts: { tz: string; locale: string; minDate: Date; maxDate: Date },
): LineUpOption | null {
  if (!contract.nextBillingDate) return null;
  const ownDay = shopDayStartUtc(contract.nextBillingDate, opts.tz).getTime();
  const candidates = siblings
    .filter(
      (s) =>
        s.id !== contract.id &&
        s.status === "ACTIVE" &&
        s.nextBillingDate != null &&
        shopDayStartUtc(s.nextBillingDate, opts.tz).getTime() !== ownDay,
    )
    .sort(
      (a, b) => a.nextBillingDate!.getTime() - b.nextBillingDate!.getTime(),
    );
  const other = candidates[0];
  if (!other || !other.nextBillingDate) return null;
  const target = other.nextBillingDate;
  const minDay = shopDayStartUtc(opts.minDate, opts.tz).getTime();
  const maxDay = shopDayStartUtc(opts.maxDate, opts.tz).getTime();
  const targetDay = shopDayStartUtc(target, opts.tz).getTime();
  if (targetDay < minDay || targetDay > maxDay) return null;
  return {
    dateLabel: formatShopDate(target, opts.tz, opts.locale),
    dateValue: new Intl.DateTimeFormat("en-CA", {
      timeZone: opts.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(target),
  };
}

/**
 * Newest `stockout.delayed` event that produced the CURRENT next date: the
 * event must be newer than the last settled attempt (else it belongs to a
 * past cycle) and no older than the delay itself. Contained.
 */
export async function loadRecentStockoutDelay(
  contract: { id: string; nextBillingDate: Date | null; lines: Array<{ variantId: string; title: string }> },
  attempts: Array<{ status: string; completedAt?: Date | null; scheduledFor: Date }>,
): Promise<{ title: string } | null> {
  if (!contract.nextBillingDate) return null;
  try {
    const ev = await prisma.subscriberEvent.findFirst({
      where: { contractId: contract.id, type: "stockout.delayed" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, payload: true },
    });
    if (!ev) return null;
    const lastSettled = attempts
      .filter((a) => a.status === "SUCCESS" || a.status === "FAILED")
      .map((a) => (a.completedAt ?? a.scheduledFor).getTime())
      .reduce((m, x) => Math.max(m, x), 0);
    if (ev.createdAt.getTime() <= lastSettled) return null;
    // A delay is only "the current next date" while it is still ahead of us
    // and the delayed order has not billed: nextBillingDate after the event.
    if (contract.nextBillingDate.getTime() < ev.createdAt.getTime()) return null;
    const p = ev.payload as { variantIds?: unknown } | null;
    const ids = Array.isArray(p?.variantIds) ? (p!.variantIds as unknown[]) : [];
    const first = contract.lines.find((l) => ids.includes(l.variantId));
    return { title: first?.title ?? contract.lines[0]?.title ?? "" };
  } catch (err) {
    console.error("[portal] stockout delay read failed", contract.id, err);
    return null;
  }
}

/** Contract lines whose catalog variant is not available for sale. */
export function outOfStockTitles(
  lines: Array<{ variantId: string; title: string; isGift?: boolean }>,
  availability: Map<string, boolean>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.isGift) continue;
    const avail = availability.get(l.variantId);
    if (avail === false && !seen.has(l.title)) {
      seen.add(l.title);
      out.push(l.title);
    }
  }
  return out;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function lineRowHtml(
  locale: string,
  currency: string,
  line: NextChargeEstimate["lines"][number],
  outOfStock: boolean,
): string {
  const meta: string[] = [];
  if (line.variantTitle) meta.push(line.variantTitle);
  if (line.kind === "one_time_addon") meta.push(t(locale, "portal.next.this_order_only"));
  // Per-line cycle edits (P2.5): the estimate already bills 0 for a skipped
  // line and the override quantity for a tweaked one — the row says so.
  if (line.skippedThisCycle) meta.push(t(locale, "portal.next.not_this_time"));
  if (line.planQuantity != null && !line.skippedThisCycle) {
    meta.push(t(locale, "portal.next.qty_once", { plan: line.planQuantity }));
  }
  if (outOfStock) meta.push(t(locale, "portal.next.out_of_stock_badge"));
  const qtyPrice = line.free
    ? t(locale, "portal.next.free")
    : t(locale, "portal.next.qty_price", {
        quantity: line.quantity,
        price: formatMoney(line.unitPriceCents, currency, locale),
      });
  const total = line.free
    ? t(locale, "portal.next.free")
    : formatMoney(line.lineTotalCents, currency, locale);
  const metaText = [...meta, line.free ? "" : qtyPrice].filter(Boolean).join(" · ");
  const thumb = line.imageUrl
    ? `<img class="cxs-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
    : `<div class="cxs-thumb cxs-thumb--placeholder">C</div>`;
  const skippedCls = line.skippedThisCycle ? " cxs-next__line--skipped" : "";
  const titleHtml = line.skippedThisCycle
    ? `<s>${escapeHtml(line.title)}</s>`
    : escapeHtml(line.title);
  return `<div class="cxs-item cxs-next__line cxs-next__line--${line.kind}${skippedCls}">${thumb}<div class="cxs-item__body"><p class="cxs-item__title">${titleHtml}${line.free ? ` <span class="cxs-muted cxs-small cxs-next__free">${escapeHtml(t(locale, "portal.next.free"))}</span>` : ""}</p>${metaText ? `<p class="cxs-item__meta">${escapeHtml(metaText)}</p>` : ""}</div><span class="cxs-price">${escapeHtml(total)}</span></div>`;
}

export function nextDeliveryHeroHtml(input: NextDeliveryHeroInput): string {
  const { locale, tz, contract, estimate } = input;
  const currency = estimate.currency || contract.currencyCode;
  // Under "Preparing" with an attempt in flight the mirror's nextBillingDate
  // has already been advanced one interval by the sweep: the order being
  // prepared is the attempt's own date (header) and the mirror's date IS the
  // following delivery (note) — the estimate's followingBillingDate would be
  // N+2 at that moment.
  const inFlightAhead =
    input.preparing &&
    input.preparingOrderDate != null &&
    contract.nextBillingDate != null &&
    input.preparingOrderDate.getTime() < contract.nextBillingDate.getTime();
  const headerDate = inFlightAhead ? input.preparingOrderDate! : contract.nextBillingDate;
  const followingDate = inFlightAhead
    ? contract.nextBillingDate
    : estimate.followingBillingDate;
  const nextDate = headerDate ? formatShopDate(headerDate, tz, locale) : "";
  const oos = new Set(input.outOfStockTitles);

  // ── Header: title, date, chip, cut-off / preparing ────────────────────────
  const chip = input.preparing
    ? `<span class="cxs-chip cxs-chip--warn cxs-next__preparing">${escapeHtml(t(locale, "portal.next.preparing_chip"))}</span>`
    : input.chip
      ? `<span class="cxs-chip ${input.chip.className}">${escapeHtml(input.chip.label)}</span>`
      : "";
  let timingLine = "";
  if (input.preparing) {
    timingLine = `<p class="cxs-small cxs-next__note cxs-next__note--preparing" role="status" style="margin:6px 0 0">${escapeHtml(
      followingDate
        ? t(locale, "portal.next.preparing_note", {
            date: formatShopDate(followingDate, tz, locale),
          })
        : t(locale, "portal.next.preparing_note_nodate"),
    )}</p>`;
  } else if (input.cutoff) {
    timingLine = `<p class="cxs-muted cxs-small cxs-next__cutoff" style="margin:6px 0 0">${escapeHtml(
      t(locale, "portal.next.cutoff", { cutoff: cutoffLabel(locale, input.cutoff, tz) }),
    )}</p>`;
  }

  // ── Notices (one line each, role=status) ─────────────────────────────────
  const notices: string[] = [];
  if (input.stockoutDelay && nextDate) {
    notices.push(
      t(locale, "portal.next.stockout_delayed", {
        date: nextDate,
        title: input.stockoutDelay.title,
      }),
    );
  }
  for (const title of input.outOfStockTitles) {
    notices.push(t(locale, "portal.next.stockout", { title }));
  }
  if (input.priceChange && input.priceChange.changes.length > 0) {
    const pc = input.priceChange;
    const first = pc.changes[0]!;
    const vars = {
      date: formatShopDate(pc.effectiveAt, tz, locale),
      title: first.title,
      old: formatMoney(first.oldPriceCents, pc.currencyCode, locale),
      new: formatMoney(first.newPriceCents, pc.currencyCode, locale),
      count: pc.changes.length - 1,
    };
    notices.push(
      pc.changes.length === 1
        ? t(locale, "portal.price.change_banner", vars)
        : pc.changes.length === 2
          ? t(locale, "portal.price.change_banner_one_more", vars)
          : t(locale, "portal.price.change_banner_more", vars),
    );
  }
  const noticesHtml = notices
    .map(
      (n) =>
        `<p class="cxs-small cxs-next__notice" role="status" style="margin:10px 0 0;padding:8px 10px;border:1px dashed var(--cxs-line);border-radius:8px">${escapeHtml(n)}</p>`,
    )
    .join("");

  // ── Lines as they will bill ──────────────────────────────────────────────
  const linesHtml = estimate.lines
    .map((l) => lineRowHtml(locale, currency, l, oos.has(l.title)))
    .join("");

  // ── Money rows (formatting only — estimateNextCharge owns the arithmetic) ─
  const rows: string[] = [];
  const row = (label: string, value: string, cls = "") =>
    `<div class="cxs-row cxs-row--between cxs-small ${cls}"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  if (estimate.discountCents > 0 && estimate.discountLabel) {
    rows.push(
      row(t(locale, "portal.next.subtotal"), formatMoney(estimate.subtotalCents, currency, locale), "cxs-muted"),
    );
    rows.push(
      row(
        estimate.discountLabel,
        `−${formatMoney(estimate.discountCents, currency, locale)}`,
        "cxs-next__discount",
      ),
    );
  }
  if (estimate.deliveryCents != null && estimate.deliveryCents > 0) {
    rows.push(
      row(t(locale, "portal.detail.delivery"), formatMoney(estimate.deliveryCents, currency, locale), "cxs-muted"),
    );
  }
  const totalHtml = `<div class="cxs-row cxs-row--between" style="margin-top:6px"><strong>${escapeHtml(t(locale, "portal.next.total"))}</strong><strong class="cxs-price cxs-next__total">${escapeHtml(formatMoney(estimate.totalCents, currency, locale))}</strong></div>`;

  // ── Ships-to / card / after that ─────────────────────────────────────────
  const facts: string[] = [];
  if (estimate.addressSummary) {
    facts.push(t(locale, "portal.next.ships_to", { address: estimate.addressSummary }));
  }
  // Delivery instructions (P2.8): the mirrored courier note, right under the
  // address it applies to — the customer sees what every order will carry.
  const instructions = (input.contract.deliveryInstructions ?? "").trim();
  if (instructions) {
    facts.push(t(locale, "portal.next.instructions", { instructions }));
  }
  if (estimate.cardLabel) {
    facts.push(t(locale, "portal.next.card", { card: estimate.cardLabel }));
  }
  if (followingDate) {
    facts.push(
      t(locale, "portal.next.after_that", {
        date: formatShopDate(followingDate, tz, locale),
      }),
    );
  }
  const factsHtml = facts.length
    ? `<p class="cxs-muted cxs-small cxs-next__facts" style="margin:10px 0 0">${facts.map((f) => escapeHtml(f)).join("<br>")}</p>`
    : "";

  // ── Line up with the other delivery ──────────────────────────────────────
  const lineUpHtml =
    input.lineUp && !input.preparing
      ? `<form method="post" action="${input.apiUrl("next_date")}" class="cxs-next__lineup" style="margin-top:12px">${input.hiddenFields([["date", input.lineUp.dateValue]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small cxs-btn--full">${escapeHtml(t(locale, "portal.next.line_up", { date: input.lineUp.dateLabel }))}</button></form>`
      : "";

  return `<section class="cxs-card cxs-next" id="cxs-next">
  <div class="cxs-row cxs-row--between">
    <div><span class="cxs-label">${escapeHtml(t(locale, "portal.next.title"))}</span><strong class="cxs-next__date">${escapeHtml(nextDate)}</strong>${timingLine}</div>
    ${chip}
  </div>
  ${noticesHtml}
  <hr class="cxs-divider">
  <div class="cxs-next__lines">${linesHtml}</div>
  <hr class="cxs-divider">
  <div class="cxs-stack cxs-next__money" style="gap:4px">${rows.join("")}${totalHtml}</div>
  ${factsHtml}
  ${lineUpHtml}
</section>`;
}
