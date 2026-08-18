import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import {
  addDaysTz,
  addIntervalTz,
  formatShopDate,
  shopDayStartUtc,
} from "~/lib/dates.server";
import { estimateFrequencyChange } from "~/lib/portal/schedule.server";
import {
  alreadyOut,
  daysOfSupplyLeft,
  pauseExtendChoices,
  pauseUntilBounds,
} from "~/lib/portal/flex.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import { logEvent } from "~/lib/events/log.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  resolveToast,
  closedPortalPage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import {
  derivePortalPaymentState,
  paymentChipKey,
  paymentDetailsOpen,
  paymentMethodLabel,
  type PortalPaymentView,
} from "~/lib/portal/payment.server";
import { getActiveDiscountForCycle } from "~/lib/billing/discounts.server";
import {
  nextCycleIndex,
  type NextChargeEstimate,
} from "~/lib/billing/estimate.server";
import {
  resolveChargeTiming,
  preparingOrderDate,
  type ChargeTiming,
} from "~/lib/billing/timing.server";
import {
  contractCutoff,
  lineUpTarget,
  loadRecentStockoutDelay,
  nextDeliveryHeroHtml,
  outOfStockTitles,
  safeEstimateNextCharge,
} from "~/lib/portal/next-delivery.server";
import {
  loadPendingPriceChange,
  priceLockPillHtml,
  priceLockView,
  priceSavingLineHtml,
  type PriceLockView,
} from "~/lib/portal/price-lock.server";
import {
  loadPortalDunning,
  logDunningBannerShown,
  type PortalDunningView,
} from "~/lib/portal/dunning.server";
import { dunningBannerHtml } from "~/lib/portal/dunning-banner.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import {
  cardHardDeadReason,
  computeSkipResumeDate,
} from "~/lib/dunning/skip-resume.server";
import { getSupportChannels } from "~/lib/support/channels.server";
import { supportCardHtml } from "~/lib/support/portal-card.server";
import {
  educationCardHtml,
  getEducationLinks,
} from "~/lib/portal/education.server";
import {
  onboardingCardHtml,
  resolveTimeline,
  resolveTimelineArm,
  expectationLineFor,
  timelineCardHtml,
  timelinePosition,
} from "~/lib/portal/timeline.server";
import {
  deliveriesCardHtml,
  deliveryStatusLabel,
  inTransitBannerHtml,
  latestInTransit,
  listDeliveries,
  type DeliveryRow,
} from "~/lib/portal/deliveries.server";
import { cutoffLabel } from "~/lib/portal/next-delivery.server";
import { buildDownsizeOptions } from "~/lib/cancel/engine.server";
import {
  orderPickerLabel,
  recentOrdersForPicker,
} from "~/lib/support/request.server";
import { listCustomerPaymentMethods } from "~/lib/graphql/paymentMethods.server";
import type { CustomerPaymentMethodSummary } from "~/lib/graphql/paymentMethods.server";
import {
  backupLine,
  listLivePaymentMethodsCached,
  paymentMethodsSectionHtml,
} from "~/lib/portal/payment-methods.server";
import {
  PORTAL_BASE_PATH,
  requireCustomer,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import {
  catalogProduct,
  discountedCents,
  frequencyOptionsForContract,
  getPortalCatalog,
  ongoingDiscountPctByProduct,
  type CatalogProduct,
} from "~/lib/portal/catalog.server";
import {
  ongoingDiscountPctForProduct,
  swapPriceCentsSync,
  type LocalContractLine,
  type LocalContractWithLines,
} from "~/lib/contracts/shared.server";
import {
  contractFrequency,
  formatFrequency,
  frequencyToken,
  parseFrequencyToken,
  sameFrequency,
  type Frequency,
} from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { resolveLockState, type LockState } from "~/lib/contracts/lock.server";
import {
  MOMENTUM_TOAST_KEYS,
  milestoneRemaining,
  nextSlowerFrequency,
  popularAddonProductIds,
  recentSkipCount,
  runsOutBeforeNextDelivery,
} from "~/lib/portal/growth.server";
import { PROVINCES, countryOptions, provincesFor } from "~/lib/portal/countries";
import { hasFurtherOrders } from "~/lib/cancel/further-orders";

/**
 * Full subscription management: items (swap / quantity / remove), add a
 * product (recurring or next-order-only), schedule (next date, frequency,
 * skip, delay), pause with auto-resume, address, payment method, cancel.
 *
 * Every mutation is a plain form POST to /apps/cellexia-subs/api/{action} carrying
 * the contract id + the session CSRF token; this page only reads.
 */

const addressSchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    company: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    city: z.string().optional(),
    provinceCode: z.string().optional(),
    countryCode: z.string().optional(),
    zip: z.string().optional(),
    phone: z.string().optional(),
  })
  .passthrough();

/** yyyy-MM-dd for <input type="date"> in the shop's timezone. */
function dateInputValue(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function hiddenFields(fields: Array<[string, string]>): string {
  return fields
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
}

interface PageContext {
  locale: string;
  tz: string;
  contract: LocalContractWithLines;
  csrf: string;
  returnTo: string;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  preview: string | null;
  /** settings.portal.nextDateMaxDays — same bound the api action validates. */
  nextDateMaxDays: number;
  /** settings.portal.maxLineQuantity — same bound the api action validates. */
  maxQuantity: number;
  /** Plan lock window — the same state the api action enforces. */
  lock: LockState;
  /**
   * Storefront account URL (`https://<primary domain>/account`) — where the
   * customer manages payment methods themselves (v1.28.0). Shop.primaryDomain
   * when known, else the myshopify domain.
   */
  accountUrl: string;
  /** Payment method state derived from the mirror (v1.28.0, P1.5). */
  payment: PortalPaymentView;
  /** A dunning banner is on the page — the payment section opens for it. */
  hasDunning: boolean;
  /** Live per-cycle DiscountGrant percent for the next-charge estimate. */
  grantPercent: number | null;
  /**
   * THE next-order estimate (v1.28.0, P2.4): lines as they will bill and the
   * discounted total — shared with the reminder. Every money figure on this
   * page comes from here; nothing else sums or discounts.
   */
  estimate: NextChargeEstimate;
  /**
   * Billing day reached / attempt in flight (P2.1): the order is being
   * prepared, so this cycle's skip / delay / next-date / frequency / swap
   * controls are hidden — changes apply from the following delivery.
   */
  preparing: boolean;
  /** Price lock pill + saving line + pending price-change notice (P4.6). */
  priceLock: PriceLockView;
  /**
   * settings.portal.delayReanchors (P2.2): true → "Delay by N weeks" moves
   * the whole schedule and a "Just this once" row pushes only this order;
   * false → the classic one-cycle delay buttons.
   */
  delayReanchors: boolean;
  /**
   * Swap-option prices per line id → variant id (v1.28.0): resolved in the
   * loader through THE swap-pricing rule (swapPriceCentsSync — the same rule
   * `swapLineVariant` bills), so the dropdown shows what the swap applies on
   * grandfathered contracts too. A line absent from the map falls back to
   * the catalog price at the product's ongoing discount.
   */
  swapPrices: Map<string, Map<string, number>>;
  /**
   * Per-line cycle edits (v1.28.0, P2.5): the upcoming Shopify cycle index
   * the estimate keyed on (nextCycleIndex) — a line whose skippedCycleIndex /
   * cycleQuantityOverrideIndex equals it is "not this time" / tweaked for
   * the next order. Null when the read failed (controls render as unset).
   */
  upcomingCycleIndex: number | null;
  /** settings.portal.perLineCycleEdits — the same switch the api action holds. */
  perLineCycleEdits: boolean;
  /**
   * Payment-methods list (v1.28.0, P1.7): the customer's live vaulted
   * methods (null = not read / read failed — the section degrades to the
   * single-card shape) and the merchant switch (settings.portal.
   * paymentMethodsList) the api action holds too.
   */
  paymentMethods: CustomerPaymentMethodSummary[] | null;
  paymentMethodsList: boolean;
}

function api(ctx: PageContext, action: string): string {
  return withLocale(`${PORTAL_BASE_PATH}/api/${action}`, ctx.locale, ctx.preview);
}

function baseFields(ctx: PageContext): Array<[string, string]> {
  return [
    ["contractId", ctx.contract.id],
    ["_csrf", ctx.csrf],
    ["return_to", ctx.returnTo],
  ];
}

// ── Items ────────────────────────────────────────────────────────────────────

function stepperHtml(ctx: PageContext, line: LocalContractLine): string {
  // Lock window: decreases are blocked (the api action enforces the same
  // rule), increases stay available.
  const minus =
    line.quantity <= 1 || ctx.lock.locked
      ? `<button type="button" disabled aria-hidden="true">&minus;</button>`
      : `<form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(line.quantity - 1)]])}<button type="submit" aria-label="${escapeHtml(t(ctx.locale, "portal.items.decrease"))}">&minus;</button></form>`;
  const plus =
    line.quantity >= ctx.maxQuantity
      ? `<button type="button" disabled aria-hidden="true">+</button>`
      : `<form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(line.quantity + 1)]])}<button type="submit" aria-label="${escapeHtml(t(ctx.locale, "portal.items.increase"))}">+</button></form>`;
  return `<div class="cxs-stepper">${minus}<span class="cxs-stepper__qty">${line.quantity}</span>${plus}</div>`;
}

/** Is the line skipped / quantity-tweaked for the UPCOMING cycle? */
function lineSkippedThisCycle(ctx: PageContext, line: LocalContractLine): boolean {
  return (
    ctx.upcomingCycleIndex != null &&
    line.skippedCycleIndex === ctx.upcomingCycleIndex
  );
}
function lineOverrideThisCycle(ctx: PageContext, line: LocalContractLine): number | null {
  if (
    ctx.upcomingCycleIndex != null &&
    line.cycleQuantityOverrideIndex === ctx.upcomingCycleIndex &&
    line.cycleQuantityOverride != null &&
    line.cycleQuantityOverride >= 1 &&
    line.cycleQuantityOverride !== line.quantity
  ) {
    return line.cycleQuantityOverride;
  }
  return null;
}

/**
 * "Just this order" stepper (P2.5): posts line_qty_once with the one-order
 * quantity — the permanent stepper above it is labelled "Change for every
 * order" so the two are never confused. A decrease below the plan quantity
 * is a reduction (lock-blocked like the permanent one); increases and the
 * "Back to usual" restore stay available. Hidden while the order is being
 * prepared (the cycle can no longer be edited).
 */
function onceStepperHtml(ctx: PageContext, line: LocalContractLine): string {
  const override = lineOverrideThisCycle(ctx, line);
  const current = override ?? line.quantity;
  const post = (qty: number, label: string, glyph: string) =>
    `<form method="post" action="${api(ctx, "line_qty_once")}">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(qty)]])}<button type="submit" aria-label="${escapeHtml(label)}">${glyph}</button></form>`;
  const minus =
    current <= 1 || (ctx.lock.locked && current - 1 < line.quantity)
      ? `<button type="button" disabled aria-hidden="true">&minus;</button>`
      : post(current - 1, t(ctx.locale, "portal.items.qty_once_decrease"), "&minus;");
  const plus =
    current >= ctx.maxQuantity
      ? `<button type="button" disabled aria-hidden="true">+</button>`
      : post(current + 1, t(ctx.locale, "portal.items.qty_once_increase"), "+");
  const badge =
    override != null
      ? `<span class="cxs-small cxs-muted cxs-items__once-badge">${escapeHtml(t(ctx.locale, "portal.items.qty_once_badge", { quantity: override, plan: line.quantity }))}</span> <form method="post" action="${api(ctx, "line_qty_once")}" class="cxs-items__once-reset">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(line.quantity)]])}<button type="submit" class="cxs-linklike">${escapeHtml(t(ctx.locale, "portal.items.qty_once_reset"))}</button></form>`
      : "";
  return `<div class="cxs-items__once"><span class="cxs-small cxs-muted cxs-items__qty-label">${escapeHtml(t(ctx.locale, "portal.items.qty_this_order"))}</span><div class="cxs-stepper cxs-stepper--once">${minus}<span class="cxs-stepper__qty">${current}</span>${plus}</div>${badge}</div>`;
}

/**
 * "Not this time" (P2.5): one link per recurring line that removes it from
 * the next order only; once set, a "Skipped for {date} · Undo" badge with
 * the line_unskip form (never blocked). Only offered when at least one OTHER
 * billable line stays on the order — the last product points at the
 * whole-order skip (the service refuses it too).
 */
function skipLineHtml(
  ctx: PageContext,
  line: LocalContractLine,
  othersOnOrder: boolean,
): string {
  const { locale } = ctx;
  if (lineSkippedThisCycle(ctx, line)) {
    const date = ctx.contract.nextBillingDate
      ? formatShopDate(ctx.contract.nextBillingDate, ctx.tz, locale)
      : null;
    const badge = date
      ? t(locale, "portal.items.skipped_badge", { date })
      : t(locale, "portal.items.skipped_badge_nodate");
    return `<div class="cxs-items__skipped cxs-small"><span class="cxs-badge cxs-badge--muted">${escapeHtml(badge)}</span> · <form method="post" action="${api(ctx, "line_unskip")}" class="cxs-items__unskip">${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}<button type="submit" class="cxs-linklike">${escapeHtml(t(locale, "portal.items.unskip_line"))}</button></form></div>`;
  }
  if (!othersOnOrder || ctx.lock.locked || ctx.preparing) return "";
  return `<form method="post" action="${api(ctx, "line_skip")}" class="cxs-items__skip-line">${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}<button type="submit" class="cxs-linklike cxs-small" title="${escapeHtml(t(locale, "portal.items.skip_line_hint", { title: line.title }))}">${escapeHtml(t(locale, "portal.items.skip_line"))}</button></form>`;
}

function swapHtml(
  ctx: PageContext,
  line: LocalContractLine,
  product: CatalogProduct | null,
  discountPct: number,
): string {
  if (!product) return "";
  const alternatives = product.variants.filter((v) => v.id !== line.variantId);
  if (alternatives.length === 0) return "";

  const resolved = ctx.swapPrices.get(line.id);
  const options = product.variants
    .map((v) => {
      const price = formatMoney(
        resolved?.get(v.id) ?? discountedCents(v.priceCents, discountPct),
        ctx.contract.currencyCode,
        ctx.locale,
      );
      const selected = v.id === line.variantId ? " selected" : "";
      return `<option value="${escapeHtml(v.id)}"${selected}>${escapeHtml(`${v.title} — ${price}`)}</option>`;
    })
    .join("");

  return `<form method="post" action="${api(ctx, "swap")}" class="cxs-row" style="margin-top:10px">
    ${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}
    <select class="cxs-select" name="variantId" style="flex:1" aria-label="${escapeHtml(t(ctx.locale, "portal.items.swap_label"))}">${options}</select>
    <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(ctx.locale, "portal.items.swap"))}</button>
  </form>`;
}

function itemsCardHtml(
  ctx: PageContext,
  catalog: CatalogProduct[],
  discountByProduct: Map<string, number>,
  editable: boolean,
): string {
  const { contract, locale } = ctx;
  const recurringCount = contract.lines.filter(
    (l) => !l.isGift && !l.isOneTimeAddon,
  ).length;

  const rows = contract.lines
    .map((line) => {
      const thumb = line.imageUrl
        ? `<img class="cxs-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cxs-thumb cxs-thumb--placeholder">C</div>`;

      const badges: string[] = [];
      if (line.isGift) badges.push(t(locale, "portal.item.gift"));
      if (line.isOneTimeAddon) badges.push(t(locale, "portal.item.one_time"));
      const meta = [
        line.variantTitle && line.variantTitle !== "Default Title"
          ? line.variantTitle
          : null,
        ...badges,
      ]
        .filter(Boolean)
        .join(" · ");

      const compare =
        line.compareAtPriceCents != null &&
        line.compareAtPriceCents > line.currentPriceCents
          ? `<span class="cxs-compare">${escapeHtml(formatMoney(line.compareAtPriceCents * line.quantity, contract.currencyCode, locale))}</span>`
          : "";
      const price = line.isGift
        ? escapeHtml(t(locale, "portal.item.free"))
        : `${compare}${escapeHtml(formatMoney(line.currentPriceCents * line.quantity, contract.currencyCode, locale))}`;

      // Per-line cycle edits (P2.5): recurring lines only, ACTIVE contracts,
      // merchant switch on. `othersOnOrder` mirrors the service's cannot-
      // empty-the-cycle guard.
      const perLine =
        ctx.perLineCycleEdits &&
        editable &&
        contract.status === "ACTIVE" &&
        !line.isGift &&
        !line.isOneTimeAddon;
      const skippedNow = perLine && lineSkippedThisCycle(ctx, line);
      const othersOnOrder = contract.lines.some(
        (l) =>
          l.id !== line.id &&
          !l.isGift &&
          (!l.isOneTimeAddon || l.addonCycleIndex == null || l.addonCycleIndex === ctx.upcomingCycleIndex) &&
          !lineSkippedThisCycle(ctx, l),
      );

      let controls = "";
      if (editable && !line.isGift) {
        // Lock window: recurring lines cannot be removed or swapped while it
        // runs (one-time addons stay removable — undoing an addition).
        const canRemove =
          line.isOneTimeAddon || (recurringCount > 1 && !ctx.lock.locked);
        // Inline confirm (P5.3): the arm button opens a "Remove X? Keep /
        // Remove" panel inside the form (layout script) — no window.confirm.
        const confirmId = `cxs-confirm-${line.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
        const removeForm = canRemove
          ? `<form method="post" action="${api(ctx, "remove_line")}" data-cellexia-confirm class="cxs-remove">${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}<button type="submit" class="cxs-btn cxs-btn--danger cxs-btn--small" data-cellexia-confirm-arm aria-controls="${confirmId}">${escapeHtml(t(locale, "portal.items.remove"))}</button><div class="cxs-confirm" id="${confirmId}" data-cellexia-confirm-panel role="group" aria-label="${escapeHtml(t(locale, "portal.items.remove_confirm", { title: line.title }))}" hidden><p class="cxs-confirm__q">${escapeHtml(t(locale, "portal.items.remove_confirm", { title: line.title }))}</p><button type="button" class="cxs-btn cxs-btn--quiet cxs-btn--small" data-cellexia-confirm-keep>${escapeHtml(t(locale, "portal.items.remove_keep"))}</button><button type="submit" class="cxs-btn cxs-btn--danger cxs-btn--small">${escapeHtml(t(locale, "portal.items.remove_go"))}</button></div></form>`
          : "";
        // Permanent stepper labelled "Change for every order" whenever the
        // one-order stepper sits next to it (the distinction is explicit).
        const stepper = line.isOneTimeAddon
          ? ""
          : perLine && !skippedNow
            ? `<div class="cxs-items__every"><span class="cxs-small cxs-muted cxs-items__qty-label">${escapeHtml(t(locale, "portal.items.qty_every_order"))}</span>${stepperHtml(ctx, line)}</div>`
            : stepperHtml(ctx, line);
        const once = perLine && !skippedNow && !ctx.preparing ? onceStepperHtml(ctx, line) : "";
        const skipLine = perLine ? skipLineHtml(ctx, line, othersOnOrder) : "";
        // Preparing (P2.1): a swap would target the cycle already being
        // prepared — hidden until the following delivery.
        const swap =
          line.isOneTimeAddon || ctx.lock.locked || ctx.preparing
            ? ""
            : swapHtml(
                ctx,
                line,
                catalogProduct(catalog, line.productId),
                discountByProduct.get(line.productId) ?? 0,
              );
        controls = `<div class="cxs-row cxs-row--between" style="margin-top:10px">${stepper}${removeForm}</div>${once}${skipLine}${swap}`;
      }

      return `<div class="cxs-item${skippedNow ? " cxs-item--skipped" : ""}">${thumb}<div class="cxs-item__body"><p class="cxs-item__title">${escapeHtml(line.title)}</p>${meta ? `<p class="cxs-item__meta">${escapeHtml(meta)}</p>` : ""}${controls}</div><span class="cxs-price">${price}</span></div>`;
    })
    .join("");

  // Footer money comes from the shared estimate (P2.4 money-true rule): the
  // items card's total is the DISCOUNTED total the hero and the reminder
  // state — never a second figure.
  const est = ctx.estimate;
  const discountRow =
    est.discountCents > 0 && est.discountLabel
      ? `<div class="cxs-row cxs-row--between cxs-small cxs-muted" style="margin-top:8px"><span>${escapeHtml(t(locale, "portal.next.subtotal"))}</span><span>${escapeHtml(formatMoney(est.subtotalCents, contract.currencyCode, locale))}</span></div>
  <div class="cxs-row cxs-row--between cxs-small cxs-next__discount" style="margin-top:4px"><span>${escapeHtml(est.discountLabel)}</span><span>${escapeHtml(`−${formatMoney(est.discountCents, contract.currencyCode, locale)}`)}</span></div>`
      : "";
  const delivery =
    contract.deliveryPriceCents > 0
      ? `<div class="cxs-row cxs-row--between cxs-small cxs-muted" style="margin-top:8px"><span>${escapeHtml(t(locale, "portal.detail.delivery"))}</span><span>${escapeHtml(formatMoney(contract.deliveryPriceCents, contract.currencyCode, locale))}</span></div>`
      : "";

  // Price lock (P4.6): the pill sits in the header only while the engine
  // guarantees the price (grandfathered, no pending batch); the saving line
  // compares mirrored compare-at prices — never the charge figure.
  const lockPill = priceLockPillHtml(locale, ctx.priceLock);
  const savingLine = priceSavingLineHtml(locale, contract.currencyCode, ctx.priceLock);

  return `<section class="cxs-card cxs-items">
  <div class="cxs-row cxs-row--between" style="margin:0 0 14px"><h2 style="font-size:18px;margin:0">${escapeHtml(t(locale, "portal.detail.items_title"))}</h2>${lockPill}</div>
  ${savingLine}
  ${rows}
  ${discountRow}
  ${delivery}
  <hr class="cxs-divider">
  <div class="cxs-row cxs-row--between"><strong>${escapeHtml(t(locale, "portal.index.order_total"))}</strong><strong class="cxs-price cxs-items__total">${escapeHtml(formatMoney(est.totalCents, contract.currencyCode, locale))}</strong></div>
</section>`;
}

// ── Add a product ────────────────────────────────────────────────────────────

interface AddProductSection {
  html: string;
  /** Variants actually offered (rendered), for the impression event below. */
  offered: Array<{ variantId: string; productId: string }>;
}

async function addProductHtml(
  ctx: PageContext,
  catalog: CatalogProduct[],
  discountByProduct: Map<string, number>,
  growth: { upsell: boolean; shopId: string },
): Promise<AddProductSection> {
  const { locale, contract } = ctx;
  const inContract = new Set(
    contract.lines.filter((l) => !l.isOneTimeAddon).map((l) => l.variantId),
  );
  const offered: AddProductSection["offered"] = [];

  // Honest social proof (portalGrowth.addonUpsell): "popular add-on" only on
  // products with enough REAL cycle.addon_added events behind them — an
  // empty set means no badge anywhere, never an invented one.
  let popular = new Set<string>();
  if (growth.upsell) {
    const variantToProduct = new Map<string, string>();
    for (const product of catalog) {
      for (const v of product.variants) variantToProduct.set(v.id, product.id);
    }
    popular = await popularAddonProductIds(growth.shopId, variantToProduct);
  }

  const cards = catalog
    .map((product) => {
      const pct = discountByProduct.get(product.id) ?? 0;
      const variants = product.variants.filter((v) => !inContract.has(v.id));
      if (variants.length === 0) return "";
      for (const v of variants) {
        offered.push({ variantId: v.id, productId: product.id });
      }

      const first = variants[0];
      const priceHtml =
        pct > 0
          ? `<span class="cxs-compare">${escapeHtml(formatMoney(first.priceCents, contract.currencyCode, locale))}</span>${escapeHtml(formatMoney(discountedCents(first.priceCents, pct), contract.currencyCode, locale))}`
          : escapeHtml(formatMoney(first.priceCents, contract.currencyCode, locale));

      const variantField =
        variants.length === 1
          ? `<input type="hidden" name="variantId" value="${escapeHtml(first.id)}">`
          : `<select class="cxs-select" name="variantId" aria-label="${escapeHtml(t(locale, "portal.add.variant_label"))}">${variants
              .map((v) => {
                const price = formatMoney(
                  discountedCents(v.priceCents, pct),
                  contract.currencyCode,
                  locale,
                );
                return `<option value="${escapeHtml(v.id)}">${escapeHtml(`${v.title} — ${price}`)}</option>`;
              })
              .join("")}</select>`;

      const thumb = product.imageUrl
        ? `<img class="cxs-thumb" src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cxs-thumb cxs-thumb--placeholder">C</div>`;

      const popularBadge =
        growth.upsell && popular.has(product.id)
          ? `<span class="cxs-chip cxs-chip--active" style="margin:0 0 4px">${escapeHtml(t(locale, "portal.add.popular"))}</span>`
          : "";

      // Button order is the foot-in-the-door lever (portalGrowth.addonUpsell):
      // the low-commitment one-time "try it" leads, the recurring add stays
      // one visual step behind — a used trial converts itself. Classic mode
      // keeps the original recurring-first order.
      const buttons = growth.upsell
        ? `<button type="submit" class="cxs-btn cxs-btn--small cxs-btn--full" formaction="${api(ctx, "addon")}">${escapeHtml(t(locale, "portal.add.try_once"))}</button>
        <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small cxs-btn--full">${escapeHtml(t(locale, "portal.add.every_time"))}</button>`
        : `<button type="submit" class="cxs-btn cxs-btn--small cxs-btn--full">${escapeHtml(t(locale, "portal.add.recurring"))}</button>
        <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small cxs-btn--full" formaction="${api(ctx, "addon")}">${escapeHtml(t(locale, "portal.add.one_time"))}</button>`;

      return `<form method="post" action="${api(ctx, "add_line")}" class="cxs-card">
        ${hiddenFields([...baseFields(ctx), ["quantity", "1"]])}
        ${thumb}
        ${popularBadge}
        <p class="cxs-item__title" style="margin:0">${escapeHtml(product.title)}</p>
        <p class="cxs-price cxs-small" style="margin:0">${priceHtml}</p>
        ${variantField}
        ${buttons}
      </form>`;
    })
    .filter(Boolean)
    .join("");

  if (!cards) return { html: "", offered: [] };

  // Zero-transaction-cost framing: the add-on rides a delivery that is
  // already coming — no extra shipping moment to mentally pay for.
  const shipsWith =
    growth.upsell && contract.nextBillingDate
      ? `<p class="cxs-muted cxs-small" style="margin:0 0 6px">${escapeHtml(
          t(locale, "portal.add.ships_with", {
            date: formatShopDate(contract.nextBillingDate, ctx.tz, locale),
          }),
        )}</p>`
      : "";

  const html = `<details class="cxs-acc" id="cxs-add"${growth.upsell ? " open" : ""}>
  <summary>${escapeHtml(t(locale, "portal.add.title"))}</summary>
  <div class="cxs-acc__body">
    ${shipsWith}
    <p class="cxs-muted cxs-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.add.intro"))}</p>
    <div class="cxs-grid">${cards}</div>
  </div>
</details>`;
  return { html, offered };
}

/**
 * First addable candidate for the momentum slot: the catalog's first
 * available variant the contract doesn't already hold as a recurring line,
 * at its member (ongoing-discount) price — the same price addOneTimeAddon
 * will actually charge.
 */
function firstAddableCandidate(
  contract: LocalContractWithLines,
  catalog: CatalogProduct[],
  discountByProduct: Map<string, number>,
): { variantId: string; title: string; priceCents: number } | null {
  const inContract = new Set(
    contract.lines.filter((l) => !l.isOneTimeAddon).map((l) => l.variantId),
  );
  for (const product of catalog) {
    const pct = discountByProduct.get(product.id) ?? 0;
    for (const variant of product.variants) {
      if (inContract.has(variant.id) || !variant.availableForSale) continue;
      return {
        variantId: variant.id,
        title: product.title,
        priceCents: discountedCents(variant.priceCents, pct),
      };
    }
  }
  return null;
}

/**
 * cycle.addon_offer_shown — the impression half of the add-on funnel.
 * cycle.addon_added alone forced attach rate onto a charges denominator
 * (subscribers who never saw the offer were indistinguishable), so the
 * render logs one event per offered variant, throttled to once per
 * (contract, upcoming order, variant) by event existence. `orderNumber` is
 * ORDER-NUMBER space (ordersCount + 1 — stable across page reloads, and a
 * skip keeps the offer's target order the same), not the Shopify cycle
 * index; resolving the real cycle would cost an admin round-trip per page
 * view. Unmapped in the Klaviyo event map — an impression is analytics, not
 * a customer moment. Contained: a failed write must never break the page.
 */
async function logAddonOfferImpressions(
  ctx: PageContext,
  offered: AddProductSection["offered"],
): Promise<void> {
  if (offered.length === 0) return;
  const { contract } = ctx;
  const orderNumber = contract.ordersCount + 1;
  try {
    const logged = await prisma.subscriberEvent.findMany({
      where: {
        contractId: contract.id,
        type: "cycle.addon_offer_shown",
        payload: { path: ["orderNumber"], equals: orderNumber },
      },
      select: { payload: true },
    });
    const seen = new Set(
      logged.map(
        (e) => (e.payload as { variantId?: unknown } | null)?.variantId,
      ),
    );
    for (const offer of offered) {
      if (seen.has(offer.variantId)) continue;
      await logEvent({
        shopId: contract.shopId,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "cycle.addon_offer_shown",
        source: "CUSTOMER_PORTAL",
        actor: "customer",
        payload: {
          orderNumber,
          variantId: offer.variantId,
          productId: offer.productId,
        },
      });
    }
  } catch (err) {
    console.error(
      "[portal] addon offer impression log failed",
      contract.id,
      err,
    );
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────

function scheduleHtml(
  ctx: PageContext,
  frequencies: Frequency[],
  allowFrequencyChoice: boolean,
  /** portalGrowth.concessionLadder inputs; null = classic quick actions. */
  ladder: {
    slower: Frequency | null;
    skipDate: string | null;
    milestoneNote: boolean;
    /** Downsize row (v1.28.0, P2.3 — cancelFlow.downsizeSaveEnabled): one
     * unit fewer of the biggest recurring line, with the concrete plan-price
     * per-order figures; null when no line has quantity > 1. */
    fewer: {
      lineId: string;
      title: string;
      quantity: number;
      totalCents: number;
      currentCents: number;
    } | null;
    /** Smaller-size row (v1.28.0, Stage B follow-up): the cheapest strictly
     * cheaper variant/product buildDownsizeOptions offers for the biggest
     * recurring line — posts the swap action with its concrete new total. */
    downsize: {
      lineId: string;
      variantId: string;
      title: string;
      totalCents: number;
      currentCents: number;
    } | null;
  } | null,
): string {
  const { locale, tz, contract } = ctx;
  const tr = (key: string, vars?: Record<string, string | number>) =>
    t(locale, key, vars);
  const now = new Date();
  const minDate = dateInputValue(addDaysTz(now, 1, tz), tz);
  const maxDate = dateInputValue(addDaysTz(now, ctx.nextDateMaxDays, tz), tz);
  const currentDate = contract.nextBillingDate
    ? dateInputValue(contract.nextBillingDate, tz)
    : minDate;

  const nextDateForm = `<div class="cxs-field">
    <label class="cxs-label" for="cxs-next-date">${escapeHtml(t(locale, "portal.schedule.next_date_label"))}</label>
    <form method="post" action="${api(ctx, "next_date")}" class="cxs-row">
      ${hiddenFields(baseFields(ctx))}
      <input class="cxs-input" style="flex:1" id="cxs-next-date" type="date" name="date" required value="${currentDate}" min="${minDate}" max="${maxDate}">
      <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "common.save"))}</button>
    </form>
  </div>`;

  // Option values are machine tokens ("2:WEEK") the api action parses back —
  // only emit tokens that round-trip parseFrequencyToken, never display text.
  const currentFrequency = contractFrequency(contract);
  const frequencyForm = allowFrequencyChoice
    ? `<div class="cxs-field">
    <label class="cxs-label" for="cxs-frequency">${escapeHtml(t(locale, "portal.schedule.frequency_label"))}</label>
    <form method="post" action="${api(ctx, "frequency")}" class="cxs-row">
      ${hiddenFields(baseFields(ctx))}
      <select class="cxs-select" style="flex:1" id="cxs-frequency" name="frequency" data-cellexia-freq-select>${frequencies
        .filter((f) => parseFrequencyToken(frequencyToken(f)) !== null)
        .map((f) => {
          // Consequence preview (v1.28.0, P2.2): each option carries the
          // next-date pair the cadence is expected to produce (shared
          // estimator with the cancel flow's FREQUENCY save); the layout
          // script mirrors the selected option's text into the hint below.
          const est = estimateFrequencyChange(contract, f, tz, now);
          const preview = est
            ? t(locale, "portal.schedule.frequency_preview", {
                date: formatShopDate(est.nextDate, tz, locale),
                following: formatShopDate(est.followingDate, tz, locale),
              })
            : "";
          const selected = sameFrequency(f, currentFrequency);
          return `<option value="${escapeHtml(frequencyToken(f))}"${selected ? " selected" : ""} data-cxs-preview="${escapeHtml(preview)}">${escapeHtml(formatFrequency(tr, "option", f))}</option>`;
        })
        .join("")}</select>
      <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "common.save"))}</button>
    </form>
    <p class="cxs-muted cxs-small" style="margin:6px 0 0" data-cellexia-freq-preview>${escapeHtml(
      (() => {
        const est = estimateFrequencyChange(contract, currentFrequency, tz, now);
        return est
          ? t(locale, "portal.schedule.frequency_preview", {
              date: formatShopDate(est.nextDate, tz, locale),
              following: formatShopDate(est.followingDate, tz, locale),
            })
          : "";
      })(),
    )}</p>
  </div>`
    : "";

  // Server-side double-submit dedupe: one-tap forms carry the cycle date they
  // target, so a duplicate POST for an already-advanced cycle is a no-op.
  const expectedNext: Array<[string, string]> = [
    ["expected_next", contract.nextBillingDate?.toISOString() ?? ""],
  ];

  // Concession ladder (portalGrowth.concessionLadder, v1.20.0): the quick
  // actions become an ORDERED menu — delay first (revenue shifts, nothing is
  // lost), the plan's next-slower cadence second (continuity survives where
  // repeated skips erode it), skip last, quiet but fully present with its
  // concrete consequence date. Every option remains one tap; only the
  // hierarchy and the honesty of consequences change — reactance-safe
  // choice architecture, not friction.
  // Delay forms (v1.28.0, P2.2 — portal.delayReanchors): ON → the week
  // buttons re-anchor the whole schedule (mode=reanchor, hint says so) and a
  // quiet "Just this once" row pushes only this order (mode=once); OFF → the
  // classic one-cycle buttons, no mode field. The api dispatcher enforces
  // the same setting server-side, so a stale form can never re-anchor a
  // shop that turned it off.
  const delayButtons = (btnClass: string, once: boolean) =>
    [1, 2, 3]
      .map(
        (weeks) =>
          `<button type="submit" class="cxs-btn ${btnClass} cxs-btn--small" name="weeks" value="${weeks}">${escapeHtml(
            t(
              locale,
              once ? "portal.schedule.delay_once_weeks" : "portal.schedule.delay_weeks",
              { weeks },
            ),
          )}</button>`,
      )
      .join("\n        ");
  const delayForms = (btnClass: string): string => {
    if (!ctx.delayReanchors) {
      return `<form method="post" action="${api(ctx, "delay")}" class="cxs-row cxs-row--wrap">${hiddenFields([...baseFields(ctx), ...expectedNext])}
        ${delayButtons(btnClass, false)}
      </form>`;
    }
    return `<form method="post" action="${api(ctx, "delay")}" class="cxs-row cxs-row--wrap cxs-delay--reanchor">${hiddenFields([...baseFields(ctx), ...expectedNext, ["mode", "reanchor"]])}
        ${delayButtons(btnClass, false)}
      </form>
      <p class="cxs-muted cxs-small" style="margin:6px 0 0">${escapeHtml(t(locale, "portal.schedule.delay_reanchor_hint"))}</p>
      <details class="cxs-delay--once" style="margin-top:8px">
        <summary class="cxs-small" style="cursor:pointer">${escapeHtml(t(locale, "portal.schedule.delay_once_label"))}</summary>
        <p class="cxs-muted cxs-small" style="margin:6px 0 8px">${escapeHtml(t(locale, "portal.schedule.delay_once_hint"))}</p>
        <form method="post" action="${api(ctx, "delay")}" class="cxs-row cxs-row--wrap">${hiddenFields([...baseFields(ctx), ...expectedNext, ["mode", "once"]])}
        ${delayButtons("cxs-btn--quiet", true)}
        </form>
      </details>`;
  };

  let quickActions: string;
  if (ladder) {
    const delayRow = `<div style="border:1px solid var(--cxs-accent);border-radius:8px;padding:10px 12px">
      <p style="margin:0;font-weight:500">${escapeHtml(t(locale, "portal.ladder.delay_title"))}</p>
      <p class="cxs-muted cxs-small" style="margin:2px 0 8px">${escapeHtml(t(locale, "portal.ladder.delay_sub"))}</p>
      ${delayForms("cxs-btn--ghost")}
    </div>`;
    const slowerRow =
      ladder.slower && parseFrequencyToken(frequencyToken(ladder.slower)) !== null
        ? `<div style="border:1px solid var(--cxs-line);border-radius:8px;padding:10px 12px">
      <div class="cxs-row cxs-row--between">
        <div>
          <p style="margin:0;font-weight:500">${escapeHtml(t(locale, "portal.ladder.slower_title"))}</p>
          <p class="cxs-muted cxs-small" style="margin:2px 0 0">${escapeHtml(
            t(locale, "portal.ladder.slower_sub", {
              frequency: formatFrequency(tr, "every", ladder.slower),
            }),
          )}</p>
        </div>
        <form method="post" action="${api(ctx, "frequency")}">${hiddenFields([...baseFields(ctx), ["frequency", frequencyToken(ladder.slower)]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.ladder.slower_cta"))}</button></form>
      </div>
    </div>`
        : "";
    // Downsize row (P2.3): fewer units is the overstock lever BEFORE a skip —
    // posts the existing quantity action with the exact figures it produces.
    const fewerRow = ladder.fewer
      ? `<div style="border:1px solid var(--cxs-line);border-radius:8px;padding:10px 12px" class="cxs-ladder__fewer">
      <div class="cxs-row cxs-row--between">
        <div>
          <p style="margin:0;font-weight:500">${escapeHtml(t(locale, "portal.ladder.fewer_title"))}</p>
          <p class="cxs-muted cxs-small" style="margin:2px 0 0">${escapeHtml(
            t(locale, "portal.ladder.fewer_sub", {
              quantity: ladder.fewer.quantity,
              title: ladder.fewer.title,
              total: formatMoney(ladder.fewer.totalCents, contract.currencyCode, locale),
              current: formatMoney(ladder.fewer.currentCents, contract.currencyCode, locale),
            }),
          )}</p>
        </div>
        <form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", ladder.fewer.lineId], ["quantity", String(ladder.fewer.quantity)]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.ladder.fewer_cta"))}</button></form>
      </div>
    </div>`
      : "";
    // Smaller size (Stage B follow-up): the swap-priced cheaper variant /
    // product the engine's DOWNSIZE save would offer, posting the same swap
    // action the items card uses; the total is the engine's newTotalCents.
    const downsizeRow = ladder.downsize
      ? `<div style="border:1px solid var(--cxs-line);border-radius:8px;padding:10px 12px" class="cxs-ladder__downsize">
      <div class="cxs-row cxs-row--between">
        <div>
          <p style="margin:0;font-weight:500">${escapeHtml(t(locale, "portal.ladder.downsize_title"))}</p>
          <p class="cxs-muted cxs-small" style="margin:2px 0 0">${escapeHtml(
            t(locale, "portal.ladder.downsize_sub", {
              title: ladder.downsize.title,
              total: formatMoney(ladder.downsize.totalCents, contract.currencyCode, locale),
              current: formatMoney(ladder.downsize.currentCents, contract.currencyCode, locale),
            }),
          )}</p>
        </div>
        <form method="post" action="${api(ctx, "swap")}">${hiddenFields([...baseFields(ctx), ["lineId", ladder.downsize.lineId], ["variantId", ladder.downsize.variantId]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.ladder.downsize_cta"))}</button></form>
      </div>
    </div>`
      : "";
    const skipConsequence = [
      ladder.skipDate
        ? t(locale, "portal.ladder.skip_sub", { date: ladder.skipDate })
        : "",
      // Truthful loss note: milestones count ORDERS, so a skip genuinely
      // pushes the gift back one delivery. Shown only while one is pending.
      ladder.milestoneNote ? t(locale, "portal.ladder.skip_milestone") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const skipRow = `<div style="border:1px solid var(--cxs-line);border-radius:8px;padding:10px 12px">
      <div class="cxs-row cxs-row--between">
        <div>
          <p style="margin:0">${escapeHtml(t(locale, "portal.ladder.skip_title"))}</p>
          ${skipConsequence ? `<p class="cxs-muted cxs-small" style="margin:2px 0 0">${escapeHtml(skipConsequence)}</p>` : ""}
        </div>
        <form method="post" action="${api(ctx, "skip")}">${hiddenFields([...baseFields(ctx), ...expectedNext])}<button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small">${escapeHtml(t(locale, "portal.actions.skip"))}</button></form>
      </div>
    </div>`;
    quickActions = `<div>
      <span class="cxs-label">${escapeHtml(t(locale, "portal.ladder.title"))}</span>
      <div class="cxs-stack" style="margin-top:6px">${delayRow}${slowerRow}${fewerRow}${downsizeRow}${skipRow}</div>
    </div>`;
  } else {
    const skipForm = `<form method="post" action="${api(ctx, "skip")}">${hiddenFields([...baseFields(ctx), ...expectedNext])}<button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small">${escapeHtml(t(locale, "portal.actions.skip"))}</button></form>`;
    const delayForm = ctx.delayReanchors
      ? `<div style="flex-basis:100%">${delayForms("cxs-btn--quiet")}</div>`
      : delayForms("cxs-btn--quiet");
    quickActions = `<div>
      <span class="cxs-label">${escapeHtml(t(locale, "portal.schedule.quick_label"))}</span>
      <div class="cxs-actions" style="margin-top:4px">${skipForm}${delayForm}</div>
      <p class="cxs-muted cxs-small" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.schedule.skip_hint"))}</p>
    </div>`;
  }

  return `<details class="cxs-acc" open>
  <summary>${escapeHtml(t(locale, "portal.schedule.title"))}</summary>
  <div class="cxs-acc__body cxs-stack">
    ${nextDateForm}
    ${frequencyForm}
    ${quickActions}
  </div>
</details>`;
}

// ── Pause ────────────────────────────────────────────────────────────────────

function pauseHtml(ctx: PageContext, maxMonths: number): string {
  const { locale, tz } = ctx;
  const months = [1, 2, 3].filter((m) => m <= maxMonths);
  const buttons = months
    .map((m) => {
      const resumeDate = formatShopDate(
        addDaysTz(new Date(), m * 30, tz),
        tz,
        locale,
      );
      return `<form method="post" action="${api(ctx, "pause")}">${hiddenFields([...baseFields(ctx), ["months", String(m)]])}<button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--full" style="justify-content:space-between"><span>${escapeHtml(t(locale, "portal.pause.months", { months: m }))}</span><span class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.pause.until", { date: resumeDate }))}</span></button></form>`;
    })
    .join("");

  // Vacation hold with a date (v1.28.0, P2.6): pick the resume day directly
  // (tomorrow … maxMonths × 30 days — the same bounds `pauseUntil` enforces)
  // and, optionally, why. The service normalises unknown reasons to null.
  const bounds = pauseUntilBounds({ maxMonths, tz });
  const minValue = dateInputValue(bounds.min, tz);
  const maxValue = dateInputValue(bounds.max, tz);
  const reasonOptions = ["TRAVEL", "TOO_MUCH", "BUDGET", "OTHER"]
    .map(
      (r) =>
        `<option value="${r}">${escapeHtml(t(locale, `portal.pause.reason.${r}`))}</option>`,
    )
    .join("");
  const dateForm = `<form method="post" action="${api(ctx, "pause_until")}" class="cxs-pause-until">
      ${hiddenFields(baseFields(ctx))}
      <p class="cxs-small" style="margin:0 0 6px;font-weight:600">${escapeHtml(t(locale, "portal.pause.pick_date_title"))}</p>
      <div class="cxs-form-grid">
        <div class="cxs-field">
          <label class="cxs-label" for="cxs-pause-date">${escapeHtml(t(locale, "portal.pause.pick_date_label"))}</label>
          <input class="cxs-input" id="cxs-pause-date" type="date" name="date" min="${minValue}" max="${maxValue}" required>
        </div>
        <div class="cxs-field">
          <label class="cxs-label" for="cxs-pause-reason">${escapeHtml(t(locale, "portal.pause.reason_label"))}</label>
          <select class="cxs-input" id="cxs-pause-reason" name="reason"><option value="">${escapeHtml(t(locale, "portal.pause.reason_none"))}</option>${reasonOptions}</select>
        </div>
      </div>
      <p class="cxs-muted cxs-small" style="margin:0 0 10px">${escapeHtml(t(locale, "portal.pause.pick_date_hint", { min: formatShopDate(bounds.min, tz, locale), max: formatShopDate(bounds.max, tz, locale) }))}</p>
      <button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--full">${escapeHtml(t(locale, "portal.pause.pick_date_submit"))}</button>
    </form>`;

  return `<details class="cxs-acc">
  <summary>${escapeHtml(t(locale, "portal.pause.title"))}</summary>
  <div class="cxs-acc__body cxs-stack">
    <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.pause.intro"))}</p>
    ${buttons}
    ${dateForm}
  </div>
</details>`;
}

/**
 * PAUSED banner controls (v1.28.0, P2.6 exit ramp): "Resume now" plus the
 * merchant's "need a little longer?" choices — each labelled with the exact
 * new resume day, only those still inside the pause maximum (measured from
 * the pause start, as `extendPause` measures it). No resume day ⇒ no
 * choices (nothing to extend from). Lock window: hidden like every pause
 * control (the route gates the call).
 */
function pausedBannerHtml(
  ctx: PageContext,
  input: { weeks: readonly number[]; maxMonths: number; locked: boolean },
): string {
  const { locale, tz, contract } = ctx;
  const resumeCopy = contract.resumeAt
    ? t(locale, "portal.detail.paused_until", {
        date: formatShopDate(contract.resumeAt, tz, locale),
      })
    : t(locale, "portal.detail.paused");
  // "Resume now" schedules the first order ~3 days out (resumeContract with
  // no billOn) — say so next to the button (review fix, P2.6 copy truth).
  const resumeForm = `<form method="post" action="${api(ctx, "resume")}">${hiddenFields(baseFields(ctx))}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.actions.resume"))}</button></form><p class="cxs-muted cxs-small" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.pause.resume_now_hint"))}</p>`;
  const choices = input.locked
    ? []
    : pauseExtendChoices({
        resumeAt: contract.resumeAt,
        pausedAt: contract.pausedAt,
        weeks: input.weeks,
        maxMonths: input.maxMonths,
        tz,
      });
  const extendHtml =
    choices.length > 0
      ? `<div class="cxs-pause-extend"><p class="cxs-small" style="margin:10px 0 6px;font-weight:600">${escapeHtml(t(locale, "portal.pause.extend_title"))}</p><div class="cxs-actions" style="margin:0">${choices
          .map(
            (c) =>
              `<form method="post" action="${api(ctx, "pause_extend")}">${hiddenFields([...baseFields(ctx), ["weeks", String(c.weeks)], ["expected_resume", contract.resumeAt?.toISOString() ?? ""]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.pause.extend_choice", { weeks: c.weeks, date: formatShopDate(c.resumeAt, tz, locale) }))}</button></form>`,
          )
          .join("")}</div><p class="cxs-muted cxs-small" style="margin:6px 0 0">${escapeHtml(t(locale, "portal.pause.extend_hint"))}</p></div>`
      : "";
  // "Change resume date" (P2.6): one date input — tomorrow … the latest day
  // this hold may run to (pause.maxMonths × 30 days from the pause START,
  // the same clamp extendPause applies). Inside the lock window only an
  // EARLIER day is offered (moving later is a reduction; earlier is a
  // recovery — the dispatcher splits the two by direction). Only with a
  // resume day (nothing to change otherwise).
  let changeDateHtml = "";
  if (contract.resumeAt) {
    const bounds = pauseUntilBounds({ maxMonths: input.maxMonths, tz });
    const anchor = contract.pausedAt ?? new Date();
    const maxFromStart = shopDayStartUtc(
      addDaysTz(anchor, Math.max(1, Math.floor(input.maxMonths)) * 30, tz),
      tz,
    );
    const currentDay = shopDayStartUtc(contract.resumeAt, tz);
    const maxDay = input.locked
      ? currentDay
      : maxFromStart.getTime() > currentDay.getTime()
        ? maxFromStart
        : currentDay;
    if (maxDay.getTime() >= bounds.min.getTime()) {
      changeDateHtml = `<form method="post" action="${api(ctx, "pause_resume_date")}" class="cxs-pause-resume-date" style="margin-top:10px">
      ${hiddenFields(baseFields(ctx))}
      <div class="cxs-form-grid">
        <div class="cxs-field">
          <label class="cxs-label" for="cxs-resume-date">${escapeHtml(t(locale, "portal.pause.change_date_label"))}</label>
          <input class="cxs-input" id="cxs-resume-date" type="date" name="date" value="${dateInputValue(currentDay, tz)}" min="${dateInputValue(bounds.min, tz)}" max="${dateInputValue(maxDay, tz)}" required>
        </div>
        <div class="cxs-field" style="align-self:end"><button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.pause.change_date_submit"))}</button></div>
      </div>
      <p class="cxs-muted cxs-small" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.pause.change_date_hint"))}</p>
    </form>`;
    }
  }
  return `<div class="cxs-banner"><p>${escapeHtml(resumeCopy)}</p>${resumeForm}${extendHtml}${changeDateHtml}</div>`;
}

// ── Address ──────────────────────────────────────────────────────────────────

function addressHtml(ctx: PageContext): string {
  const { locale, contract } = ctx;
  const parsed = addressSchema.safeParse(contract.deliveryAddress ?? {});
  const a: Record<string, string> = {};
  if (parsed.success) {
    for (const [k, v] of Object.entries(parsed.data)) {
      if (typeof v === "string") a[k] = v;
    }
  }

  const field = (
    name: string,
    labelKey: string,
    opts?: { half?: boolean; required?: boolean; autocomplete?: string; maxlength?: number },
  ) =>
    `<div class="cxs-field${opts?.half ? "" : " cxs-field--full"}">
      <label class="cxs-label" for="cxs-addr-${name}">${escapeHtml(t(locale, labelKey))}</label>
      <input class="cxs-input" id="cxs-addr-${name}" type="text" name="${name}" value="${escapeHtml(a[name] ?? "")}"${opts?.required ? " required" : ""}${opts?.autocomplete ? ` autocomplete="${opts.autocomplete}"` : ""}${opts?.maxlength ? ` maxlength="${opts.maxlength}"` : ""}>
    </div>`;

  return `<details class="cxs-acc">
  <summary>${escapeHtml(t(locale, "portal.address.title"))}</summary>
  <div class="cxs-acc__body">
    <form method="post" action="${api(ctx, "address")}">
      ${hiddenFields(baseFields(ctx))}
      <div class="cxs-form-grid">
        ${field("firstName", "portal.address.first_name", { half: true, autocomplete: "given-name" })}
        ${field("lastName", "portal.address.last_name", { half: true, autocomplete: "family-name" })}
        ${field("company", "portal.address.company", { autocomplete: "organization", maxlength: 100 })}
        ${field("address1", "portal.address.address1", { required: true, autocomplete: "address-line1" })}
        ${field("address2", "portal.address.address2", { autocomplete: "address-line2" })}
        ${field("city", "portal.address.city", { half: true, required: true, autocomplete: "address-level2" })}
        ${field("zip", "portal.address.zip", { half: true, required: true, autocomplete: "postal-code" })}
        ${countryFieldHtml(locale, a.countryCode ?? "")}
        ${provinceFieldHtml(locale, a.countryCode ?? "", a.provinceCode ?? "")}
        ${field("phone", "portal.address.phone", { autocomplete: "tel" })}
      </div>
      <p class="cxs-muted cxs-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.address.country_hint"))}</p>
      <button type="submit" class="cxs-btn cxs-btn--full">${escapeHtml(t(locale, "portal.address.save"))}</button>
    </form>
  </div>
</details>`;
}

/**
 * Country as a `<select>` (v1.28.0, P2.8 review fix — no more typed ISO
 * codes): every code Shopify ships to, named in the customer's locale via
 * Intl.DisplayNames, sorted by name, the current value preselected. Marked
 * `data-cellexia-country` for the region swapper in the portal script.
 */
function countryFieldHtml(locale: string, current: string): string {
  const selected = current.toUpperCase();
  const options = countryOptions(locale)
    .map(
      (c) =>
        `<option value="${escapeHtml(c.code)}"${c.code === selected ? " selected" : ""}>${escapeHtml(c.name)}</option>`,
    )
    .join("");
  const placeholder = selected
    ? ""
    : `<option value="" selected disabled>${escapeHtml(t(locale, "portal.address.country_placeholder"))}</option>`;
  return `<div class="cxs-field">
      <label class="cxs-label" for="cxs-addr-countryCode">${escapeHtml(t(locale, "portal.address.country"))}</label>
      <select class="cxs-select" id="cxs-addr-countryCode" name="countryCode" required autocomplete="country" data-cellexia-country>${placeholder}${options}</select>
    </div>`;
}

/**
 * Region / state: a text field backed by a `<datalist>` of the CURRENT
 * country's required regions (code + name — the customer picks by name, the
 * code is what is submitted), free text for countries without one. Works
 * without JS as-is; with JS the portal script rebuilds the datalist when the
 * country changes (the whole table rides in `data-cellexia-provinces`). The
 * server validates against the same table (normalizeProvinceCode).
 */
function provinceFieldHtml(locale: string, countryCode: string, current: string): string {
  const list = provincesFor(countryCode);
  const options = list
    .map((p) => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)}</option>`)
    .join("");
  const table = escapeHtml(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(PROVINCES).map(([cc, ps]) => [cc, ps.map((p) => [p.code, p.name])]),
      ),
    ),
  );
  return `<div class="cxs-field" data-cellexia-province-field data-cellexia-provinces="${table}">
      <label class="cxs-label" for="cxs-addr-provinceCode">${escapeHtml(t(locale, "portal.address.province"))}</label>
      <input class="cxs-input" id="cxs-addr-provinceCode" type="text" name="provinceCode" value="${escapeHtml(current)}" list="cxs-addr-provinces" autocomplete="address-level1" maxlength="60"${list.length > 0 ? " required" : ""}>
      <datalist id="cxs-addr-provinces">${options}</datalist>
    </div>`;
}

// ── Delivery instructions (v1.28.0, P2.8) ────────────────────────────────────

/**
 * A note for the courier / fulfilment: written to the Shopify contract note
 * (copied onto every renewal order) + a custom attribute, mirrored on the
 * contract. Own form (own POST), under the address card. `maxChars` =
 * settings.portal.deliveryInstructionsMaxChars — the service caps by the
 * same number; the textarea only pre-limits typing.
 */
function deliveryInstructionsHtml(ctx: PageContext, maxChars: number): string {
  const { locale, contract } = ctx;
  const current = contract.deliveryInstructions ?? "";
  const clearButton = current
    ? `<form method="post" action="${api(ctx, "delivery_instructions")}" style="margin-top:8px">${hiddenFields([...baseFields(ctx), ["instructions", ""]])}<button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small">${escapeHtml(t(locale, "portal.instructions.clear"))}</button></form>`
    : "";
  return `<details class="cxs-acc"${current ? " open" : ""}>
  <summary>${escapeHtml(t(locale, "portal.instructions.title"))}</summary>
  <div class="cxs-acc__body">
    <form method="post" action="${api(ctx, "delivery_instructions")}">
      ${hiddenFields(baseFields(ctx))}
      <div class="cxs-field cxs-field--full">
        <label class="cxs-label" for="cxs-instructions">${escapeHtml(t(locale, "portal.instructions.label"))}</label>
        <textarea class="cxs-textarea" id="cxs-instructions" name="instructions" rows="3" maxlength="${maxChars}">${escapeHtml(current)}</textarea>
      </div>
      <p class="cxs-muted cxs-small" style="margin:6px 0 12px">${escapeHtml(t(locale, "portal.instructions.hint", { max: maxChars }))}</p>
      <button type="submit" class="cxs-btn cxs-btn--full">${escapeHtml(t(locale, "portal.instructions.save"))}</button>
    </form>
    ${clearButton}
  </div>
</details>`;
}

// ── Payment ──────────────────────────────────────────────────────────────────

/**
 * Payment section (v1.28.0, P1.5): the mirrored method with an explicit
 * state note — EXPIRING (amber), EXPIRED / REVOKED (red), on-backup — and the
 * update button made prominent whenever the card needs attention. The
 * <details> opens by default in any non-OK state or while a dunning banner
 * is on the page (its CTAs anchor here). Notes are role=status so screen
 * readers announce them on open; colours come from the .cxs-* tokens only.
 */
function paymentHtml(ctx: PageContext): string {
  const { locale, contract, payment } = ctx;
  const hasCard = contract.cardBrand || contract.cardLast4;
  const revoked = payment.state === "REVOKED";
  const attention =
    payment.state === "EXPIRING" || payment.state === "EXPIRED" || revoked;
  // The EFFECTIVE next-charge date (resumeAt when paused, none while a
  // dunning case holds the order) — never the mirror's stale nextBillingDate
  // for a PAUSED / held contract, which the paused / held banners contradict.
  const nextDate = payment.nextChargeDate
    ? formatShopDate(payment.nextChargeDate, ctx.tz, locale)
    : null;
  const last4 = payment.last4 ?? "····";

  let note = "";
  if (payment.state === "EXPIRING" && payment.expiryLabel) {
    // "before your next order on {date}" only when that is true — inside the
    // pre-expiry notice window the next order may still charge fine.
    note = `<p class="cxs-small cxs-payment__note cxs-payment__note--warn" role="status">${escapeHtml(
      nextDate && payment.beforeNextOrder
        ? t(locale, "portal.payment.expiring_note", { last4, expiry: payment.expiryLabel, date: nextDate })
        : t(locale, "portal.payment.expiring_note_nodate", { last4, expiry: payment.expiryLabel }),
    )}</p>`;
  } else if (payment.state === "EXPIRED") {
    note = `<p class="cxs-small cxs-payment__note cxs-payment__note--danger" role="status">${escapeHtml(
      nextDate
        ? t(locale, "portal.payment.expired_note", { date: nextDate })
        : t(locale, "portal.payment.expired_note_nodate"),
    )}</p>`;
  } else if (revoked) {
    note = `<p class="cxs-small cxs-payment__note cxs-payment__note--danger" role="status">${escapeHtml(t(locale, "portal.payment.revoked_note"))}</p>`;
  }
  // Engine on the backup: the mirrored brand/last4 IS the backup card, so
  // the label above already names it; the note explains why.
  const backupNote = payment.onBackup
    ? `<p class="cxs-small cxs-payment__note cxs-payment__note--info" role="status">${escapeHtml(
        payment.last4
          ? t(locale, "portal.payment.on_backup", { last4: payment.last4 })
          : t(locale, "portal.payment.on_backup_generic"),
      )}</p>`
    : "";

  const summary = hasCard
    ? `<p style="margin:0;font-weight:500">${escapeHtml(
        paymentMethodLabel(locale, contract),
      )}</p>${payment.expiryLabel && !revoked && !attention ? `<p class="cxs-muted cxs-small" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.payment.expires", { expiry: payment.expiryLabel }))}</p>` : ""}${note}${backupNote}`
    : `<p class="cxs-muted" style="margin:0">${escapeHtml(t(locale, "portal.payment.none"))}</p>${backupNote}`;

  // Update button only while the primary still resolves on Shopify — a
  // revoked method cannot be updated (the resolver reports unavailable), so
  // the honest path is the account page below. Prominent (filled) whenever
  // the card needs attention, ghost otherwise.
  const updateForm =
    contract.paymentMethodId && !revoked
      ? `<form method="post" action="${api(ctx, "payment_update")}" style="margin-top:14px">${hiddenFields(baseFields(ctx))}<button type="submit" class="cxs-btn${attention ? "" : " cxs-btn--ghost"} cxs-btn--full">${escapeHtml(t(locale, "portal.payment.update"))}</button></form>
      <p class="cxs-muted cxs-small" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.payment.secure_note"))}</p>`
      : "";

  const manageLink = `<p class="cxs-small" style="margin:10px 0 0"><a class="cxs-link cxs-payment__manage${revoked ? " cxs-payment__manage--primary" : ""}" href="${escapeHtml(ctx.accountUrl)}" rel="noopener">${escapeHtml(t(locale, "portal.payment.manage_in_account"))}</a></p>`;

  // Payment-methods list (v1.28.0, P1.7): "Backup: {label}" under the
  // primary, then either the "Other payment methods on your account" list
  // (Use for this subscription / Set as backup) or the honest "Add another
  // payment method" block. The ADD block carries its own account link, so
  // the plain manage link is dropped then (one link, not two).
  const pmInput = {
    locale,
    contract: {
      paymentMethodId: contract.paymentMethodId,
      backupPaymentMethodId: contract.backupPaymentMethodId,
      paymentMethodRevokedAt: contract.paymentMethodRevokedAt,
    },
    methods: ctx.paymentMethods,
    // The demo fixture has no Shopify customer — no list, no add block.
    enabled: ctx.paymentMethodsList && !contract.isDemo,
    onBackup: payment.onBackup,
    accountUrl: ctx.accountUrl,
    apiUrl: (action: string) => api(ctx, action),
    hiddenFields: (fields: Array<[string, string]>) =>
      hiddenFields([...baseFields(ctx), ...fields]),
  };
  const backupText = ctx.paymentMethodsList ? backupLine(locale, pmInput) : null;
  const backupLineHtml = backupText
    ? `<p class="cxs-muted cxs-small cxs-payment__backup" style="margin:4px 0 0">${escapeHtml(backupText)}</p>`
    : "";
  const methodsHtml = paymentMethodsSectionHtml(pmInput);
  const showManage = !methodsHtml.includes("cxs-pm--add");

  const open = paymentDetailsOpen(payment.state, ctx.hasDunning);
  return `<details class="cxs-acc${attention ? " cxs-acc--attention" : ""}" id="cxs-payment"${open ? " open" : ""}>
  <summary>${escapeHtml(t(locale, "portal.payment.title"))}</summary>
  <div class="cxs-acc__body">${summary}${backupLineHtml}${updateForm}${methodsHtml}${showManage ? manageLink : ""}</div>
</details>`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

async function loadOwnedContract(
  shopId: string,
  contractId: string,
  portalSession: PortalSessionContext,
): Promise<LocalContractWithLines | null> {
  return prisma.subscriptionContract.findFirst({
    where: {
      id: contractId,
      shopId,
      customerId: portalSession.customerId,
      // OURS_ONLY: guessing the local id of a contract owned by the store's
      // other subscription app must 404, not open our management UI on it.
      ...OURS_ONLY,
    },
    include: { lines: true },
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);
  const portalSession = await requireCustomer(request);
  const shop = await requireShop(session.shop);

  // Launch gate: while in setup mode the portal is closed to the public —
  // only admin preview sessions pass through.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const contract = await loadOwnedContract(
    shop.id,
    params.id ?? "",
    portalSession,
  );
  if (!contract) {
    throw redirect(
      withLocale(
        `${PORTAL_BASE_PATH}/?toast=not_found`,
        locale,
        portalSession.previewToken,
      ),
    );
  }

  const [
    portalSettings,
    pauseSettings,
    growth,
    lifecycle,
    frequency,
    lock,
    dunningSettings,
    cancelFlowSettings,
  ] = await Promise.all([
    getSetting(shop.id, "portal"),
    getSetting(shop.id, "pause"),
    getSetting(shop.id, "portalGrowth"),
    getSetting(shop.id, "lifecycle"),
    frequencyOptionsForContract(shop.id, contract),
    resolveLockState(shop.id, contract, shop.ianaTimezone),
    getSetting(shop.id, "dunning"),
    getSetting(shop.id, "cancelFlow"),
  ]);
  // Scheduled cancel (v1.28.0, P3.8): inside the lock window the cancel
  // link stays and the lock copy promises "schedule your cancellation"
  // instead of "cancellation available on {date}" — mirrors the exact toggle
  // requireCancelContext reads (default ON).
  const scheduledCancelEnabled =
    (cancelFlowSettings as { scheduledCancelEnabled?: boolean })
      .scheduledCancelEnabled !== false;

  // Catalog + discount map (cached, degrade-to-empty) for swap/add sections.
  let catalog: CatalogProduct[] = [];
  let discountByProduct = new Map<string, number>();
  try {
    const admin = await adminClientForShop(session.shop);
    catalog = await getPortalCatalog(admin, shop.id);
    const productIds = [
      ...new Set([
        ...catalog.map((p) => p.id),
        ...contract.lines.map((l) => l.productId),
      ]),
    ];
    discountByProduct = await ongoingDiscountPctByProduct(shop.id, productIds);
  } catch (err) {
    console.error("[portal] catalog unavailable for subscription page", err);
  }

  // Swap-option prices (v1.28.0) through THE swap-pricing rule, so the
  // dropdown equals what swapLineVariant bills — grandfathered contracts keep
  // the locked line price on a same-product swap. Only recurring lines with a
  // catalog product get options; the covering-config percent is read once
  // per product (null → the line's proportional ratio, as the service does).
  // Contained: a failed read leaves the line off the map (catalog fallback).
  const swapPrices = new Map<string, Map<string, number>>();
  if (catalog.length > 0) {
    const pctCache = new Map<string, number | null>();
    for (const line of contract.lines) {
      if (line.isGift || line.isOneTimeAddon) continue;
      const product = catalogProduct(catalog, line.productId);
      if (!product) continue;
      try {
        let pct = pctCache.get(line.productId);
        if (pct === undefined) {
          pct = await ongoingDiscountPctForProduct(shop.id, line.productId);
          pctCache.set(line.productId, pct);
        }
        const byVariant = new Map<string, number>();
        for (const v of product.variants) {
          byVariant.set(
            v.id,
            swapPriceCentsSync(
              contract,
              line,
              { productId: product.id, priceCents: v.priceCents },
              pct,
            ),
          );
        }
        swapPrices.set(line.id, byVariant);
      } catch (err) {
        console.error("[portal] swap price resolution failed", line.id, err);
      }
    }
  }

  // Live per-cycle grant for the next-charge estimate (contained).
  let grantPercent: number | null = null;
  let grantRow: Awaited<ReturnType<typeof getActiveDiscountForCycle>> | undefined;
  try {
    grantRow = await getActiveDiscountForCycle(contract.id);
    grantPercent = grantRow?.percent ?? null;
  } catch (err) {
    console.error("[portal] discount grant lookup failed", contract.id, err);
  }

  // THE next-order estimate (P2.4) — the hero, the items card and the
  // reminder all read this one computation. estimateNextCharge is itself
  // contained (each read degrades independently); safeEstimateNextCharge
  // guards the page against a bug in it (plan-price fallback, same math).
  const estimate = await safeEstimateNextCharge(
    { id: shop.id, ianaTimezone: shop.ianaTimezone },
    contract,
    grantRow !== undefined ? { grant: grantRow } : {},
  );
  // Upcoming cycle index (P2.5) — the same number the estimate keyed the
  // per-line skip / one-order quantity flags on. Contained: null on failure
  // (the items card then shows the plain controls, never a wrong badge).
  let upcomingCycleIndex: number | null = null;
  try {
    upcomingCycleIndex = await nextCycleIndex(contract);
  } catch (err) {
    console.error("[portal] upcoming cycle index read failed", contract.id, err);
  }

  // Charge timing (P2.1): the cut-off IS the charge moment; the sweep reads
  // the same instant. Contained (hour 0 on a broken read).
  const timing: ChargeTiming = await resolveChargeTiming(shop.id, shop.ianaTimezone);
  // Attempts feed the "preparing your order" check and the stock-out delay
  // notice; a failed read means "not preparing" (classic controls stay).
  let attempts: Array<{
    status: string;
    originatingAction: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    scheduledFor: Date;
    supersededAt: Date | null;
  }> = [];
  try {
    attempts = await prisma.billingAttempt.findMany({
      where: { contractId: contract.id },
      select: {
        status: true,
        originatingAction: true,
        startedAt: true,
        completedAt: true,
        scheduledFor: true,
        supersededAt: true,
      },
    });
  } catch (err) {
    console.error("[portal] billing attempts read failed", contract.id, err);
  }
  // The order date being prepared (the in-flight attempt's own date — the
  // mirror's nextBillingDate is already the following cycle then); null =
  // not preparing.
  const preparingDate = preparingOrderDate(
    { ...contract, billingAttempts: attempts },
    timing,
    new Date(),
  );
  const preparing = preparingDate != null;

  // "Your deliveries" (v1.28.0, P4.2 — portalGrowth.deliveriesList): the
  // contract's last 5 charged orders from the local mirror, read ONCE for
  // the in-transit banner under the hero, the deliveries card and the
  // onboarding card's first-order status. Contained: a failed read hides
  // those surfaces, never the page. Off ⇒ no read at all.
  let deliveryRows: DeliveryRow[] = [];
  if (growth.deliveriesList) {
    try {
      deliveryRows = await listDeliveries(contract.id, {
        limit: 5,
        processingMaxDays: portalSettings.deliveriesProcessingMaxDays,
      });
    } catch (err) {
      console.error("[portal] deliveries read failed", contract.id, err);
    }
  }
  const inTransit = latestInTransit(deliveryRows, {
    maxDays: portalSettings.deliveriesInTransitMaxDays,
  });

  // Price lock / pending price change (P4.6) — contained.
  const pendingPriceChange = await loadPendingPriceChange(contract, shop.currencyCode);
  const priceLock = priceLockView(contract, pendingPriceChange);

  const ctx: PageContext = {
    locale,
    tz: shop.ianaTimezone,
    contract,
    csrf: portalSession.csrfToken,
    returnTo: `/subscription/${contract.id}`,
    preview: portalSession.previewToken,
    nextDateMaxDays: portalSettings.nextDateMaxDays,
    maxQuantity: portalSettings.maxLineQuantity,
    lock,
    accountUrl: `https://${shop.primaryDomain ?? shop.domain}/account`,
    // Payment method state from the mirror (P1.5): expiring / expired /
    // revoked / on-backup — the same fields the engine charges against.
    payment: derivePortalPaymentState(contract, {
      preExpiryNoticeDays: dunningSettings.preExpiryNoticeDays,
      tz: shop.ianaTimezone,
    }),
    hasDunning: false,
    grantPercent,
    estimate,
    preparing,
    priceLock,
    delayReanchors: portalSettings.delayReanchors === true,
    swapPrices,
    upcomingCycleIndex,
    perLineCycleEdits: portalSettings.perLineCycleEdits !== false,
    paymentMethods: null,
    paymentMethodsList:
      (portalSettings as { paymentMethodsList?: boolean }).paymentMethodsList !==
      false,
  };

  const isActive = contract.status === "ACTIVE";
  const isPaused = contract.status === "PAUSED";
  const isCancelled = contract.status === "CANCELLED";
  const isFailed = contract.status === "FAILED";
  const editable = isActive || isPaused;

  // ── Portal growth inputs (v1.20.0, each behind its portalGrowth toggle) ───
  // All derived from data the page already holds or one cheap query each;
  // every claim they power is computed, never asserted (growth.server.ts).
  const currentFrequency = contractFrequency(contract);
  const slowerOption =
    (growth.concessionLadder || growth.cadenceNudge) && frequency.allowChoice
      ? nextSlowerFrequency(frequency.options, currentFrequency)
      : null;
  const milestoneAway = milestoneRemaining(
    contract.ordersCount,
    lifecycle.milestoneGiftCycle,
    lifecycle.milestoneLadder,
  );
  // Ladder downsize row (v1.28.0, P2.3): behind the same merchant toggle as
  // the cancel-flow DOWNSIZE save; the biggest recurring line with more than
  // one unit, one unit fewer, plan-price per-order figures (the quantity
  // action applies exactly this — no Shopify call on page load).
  const fewerRow = (() => {
    if (!growth.concessionLadder || !cancelFlowSettings.downsizeSaveEnabled) return null;
    const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
    const candidates = recurring.filter((l) => l.quantity > 1 && l.shopifyLineId);
    if (candidates.length === 0) return null;
    const target = candidates.reduce((best, l) =>
      l.currentPriceCents * l.quantity > best.currentPriceCents * best.quantity ? l : best,
    );
    const currentCents = recurring.reduce((s, l) => s + l.currentPriceCents * l.quantity, 0);
    return {
      lineId: target.id,
      title: target.title,
      quantity: target.quantity - 1,
      totalCents: currentCents - target.currentPriceCents,
      currentCents,
    };
  })();
  // Smaller-size row (Stage B follow-up): the engine's DOWNSIZE options for
  // the biggest recurring line (the same target the cancel-flow card acts
  // on) — first strictly cheaper variant / product, swap-priced. One
  // contained Shopify read, only when the row could render at all.
  let downsizeRow: {
    lineId: string;
    variantId: string;
    title: string;
    totalCents: number;
    currentCents: number;
  } | null = null;
  if (
    growth.concessionLadder &&
    cancelFlowSettings.downsizeSaveEnabled &&
    isActive &&
    !lock.locked &&
    !preparing
  ) {
    const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
    const target =
      recurring.length > 0
        ? recurring.reduce((best, l) =>
            l.currentPriceCents * l.quantity > best.currentPriceCents * best.quantity ? l : best,
          )
        : null;
    if (target) {
      try {
        const options = await buildDownsizeOptions(shop.id, session.shop, contract, target);
        const pick = options.find((o) => o.mode !== "QUANTITY" && !!o.variantId);
        if (pick?.variantId) {
          downsizeRow = {
            lineId: target.id,
            variantId: pick.variantId,
            title: pick.title,
            totalCents: pick.newTotalCents,
            currentCents: recurring.reduce((s, l) => s + l.currentPriceCents * l.quantity, 0),
          };
        }
      } catch (err) {
        console.error("[portal] downsize options failed", contract.id, err);
      }
    }
  }
  // "Skip this order — next one on {date}": the estimate's schedule-aware
  // following date (after a "just this once" delay the following order is the
  // recorded anchor + interval, what skipNextCycle / Shopify actually set and
  // what the hero's "After that" prints) — the plain interval step only when
  // the estimate has none.
  const skipConsequenceDate =
    isActive && contract.nextBillingDate
      ? formatShopDate(
          estimate.followingBillingDate ??
            addIntervalTz(
              contract.nextBillingDate,
              currentFrequency.unit,
              currentFrequency.count,
              ctx.tz,
            ),
          ctx.tz,
          locale,
        )
      : null;
  let repeatedSkips = false;
  // Preparing (P2.1): the cadence nudge and the run-out prompt post frequency
  // / next_date for the cycle being prepared — both wait for the next cycle.
  if (growth.cadenceNudge && isActive && slowerOption && !lock.locked && !preparing) {
    try {
      repeatedSkips = (await recentSkipCount(contract.id, new Date())) >= 2;
    } catch (err) {
      console.error("[portal] skip-count scan failed", err);
    }
  }
  const runoutDue =
    growth.runoutPrompt &&
    isActive &&
    !lock.locked &&
    !preparing &&
    runsOutBeforeNextDelivery(
      contract.predictedEmptyDate,
      contract.nextBillingDate,
      new Date(),
    );
  // The toast key drives the momentum slot; the toast itself renders as
  // today. Resolved once here so both consumers agree.
  // Undo context (v1.28.0, P2.2): the schedule toasts (delayed / date_changed
  // / frequency_changed) carry a signed undo token; the resolver renders the
  // Undo form only with the session's CSRF and only for THIS contract.
  const resolvedToast = resolveToast(request, locale, {
    csrfToken: portalSession.csrfToken,
    previewToken: portalSession.previewToken,
    contractIds: new Set([contract.id]),
  });

  // ── Payment issue (v1.28.0, P1.2): the contract's dunning case ────────────
  // Open case, or the newest EXHAUSTED one while FAILED. Contained: a read
  // failure renders the page without the banner, never a 500.
  let dunning: PortalDunningView | null = null;
  if (isActive || isPaused || isFailed) {
    try {
      // The banner names THE estimate's total — the same figure the hero and
      // the items card print on this page (grant / parked marker / per-line
      // edits applied), never the mirror's undiscounted plan sum.
      dunning = await loadPortalDunning(contract, {
        heldOrderTotalCents: estimate.totalCents,
      });
    } catch (err) {
      console.error("[portal] dunning view failed", contract.id, err);
    }
  }
  ctx.hasDunning = dunning != null;
  // "On backup" is a statement about an OPEN case (the engine swapped and
  // will revert / has collapsed the marker on close). Without one, pointer
  // equality is a leftover and must not hide the backup toggle nor print
  // "we're using your backup card while your main card is fixed". The same
  // fact decides the payment notes' "next order" date (held → no date), so
  // the view is re-derived once the case is known.
  {
    const hasOpenCase =
      dunning != null && OPEN_CASE_STATES.includes(dunning.caseState);
    ctx.payment = derivePortalPaymentState(contract, {
      preExpiryNoticeDays: dunningSettings.preExpiryNoticeDays,
      tz: shop.ianaTimezone,
      hasOpenCase,
    });
  }
  let liveMethodCount: number | null = null;
  const retryCooldownMinutes = dunningSettings.customerRetryCooldownMinutes;
  // Payment-methods list (v1.28.0, P1.7): ONE cached read (60 s per
  // customer, in-process) feeds the "Other payment methods" list, the
  // "Backup: …" line and the dunning banner's "Use another card" CTA. Only
  // for statuses the select / backup verbs accept; never for the demo
  // fixture (no Shopify customer). Contained: a failed read renders the
  // plain single-card section (manage link, no add / list block), never a 500.
  if (
    ctx.paymentMethodsList &&
    (isActive || isPaused || isFailed) &&
    !contract.isDemo
  ) {
    try {
      const admin = await adminClientForShop(session.shop);
      ctx.paymentMethods = await listLivePaymentMethodsCached(
        admin,
        contract.customerId,
      );
      liveMethodCount = ctx.paymentMethods.length;
    } catch (err) {
      console.error("[portal] payment methods list failed", contract.id, err);
    }
  }
  if (dunning && liveMethodCount == null) {
    if (dunning.ctaGroup === "UPDATE_CARD" && !contract.isDemo) {
      // "Use another card" only when the account really holds ≥2 live
      // methods (list feature off ⇒ plain count, uncached). Contained.
      try {
        const admin = await adminClientForShop(session.shop);
        const methods = await listCustomerPaymentMethods(admin, contract.customerId);
        liveMethodCount = methods.filter((m) => !m.revoked).length;
      } catch (err) {
        console.error("[portal] payment methods count failed", contract.id, err);
      }
    }
  }

  let body = "";

  // Scheduled cancel vs the next pointer (v1.28.0 audit): true when the
  // schedule ends before the mirror's next order, i.e. no further order
  // will ever bill (further-orders.ts).
  const noFurtherOrders =
    !isCancelled && contract.cancelScheduledAt != null && !hasFurtherOrders(contract);

  // Scheduled cancel (v1.28.0, P3.8): "cancels on {date} · keep my
  // subscription" — the keep posts to the cancel route's own action, which
  // clears the schedule atomically. Shown above the status banner on any
  // live status (a paused contract can be scheduled too).
  if (contract.cancelScheduledAt && !isCancelled) {
    body += `<div class="cxs-banner cxs-banner--cancel-scheduled"><p>${escapeHtml(
      t(locale, "portal.detail.cancel_scheduled", {
        date: formatShopDate(contract.cancelScheduledAt, ctx.tz, locale),
      }),
    )}</p><form method="post" action="${withLocale(`${PORTAL_BASE_PATH}/cancel/${contract.id}`, locale, ctx.preview)}">${hiddenFields([["intent", "keep_scheduled"], ["_csrf", ctx.csrf]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.actions.keep_subscription"))}</button></form></div>`;
  }

  // Status banner for anything that is not simply active.
  if (isPaused) {
    // Resume now + the pause exit ramp (v1.28.0, P2.6): "need a little
    // longer?" choices from settings.portal.pauseExtendChoicesWeeks, each
    // with its exact new resume day, clamped by the pause maximum.
    body += pausedBannerHtml(ctx, {
      weeks: portalSettings.pauseExtendChoicesWeeks,
      maxMonths: pauseSettings.maxMonths,
      locked: lock.locked,
    });
  } else if (isCancelled && contract.cancelReason === "MERGED") {
    // Auto-consolidated source (consolidation.server.ts): the lines continue
    // in the primary contract — no Restart door (it would double-bill), the
    // note says where the routine went.
    body += `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.detail.status_note.merged"))}</p></div>`;
  } else if (isCancelled) {
    // Never a dead end: a returning customer restarts from the welcome-back
    // landing (v1.28.0, P3.5 — what is preserved + the CURRENT win-back
    // offer, re-derived server-side), one tap from there through the
    // win-back reactivation service. Waiting for the win-back email is a
    // pure LTGP leak.
    body += `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.detail.status_note.cancelled"))}</p><a class="cxs-btn cxs-btn--small" href="${withLocale(`${PORTAL_BASE_PATH}/subscription/${contract.id}/restart`, locale, ctx.preview)}">${escapeHtml(t(locale, "portal.actions.restart"))}</a></div>`;
  } else if (isFailed && dunning) {
    // The dunning banner below carries the whole story; the generic note
    // would only repeat it.
  } else if (!isActive) {
    body += `<div class="cxs-note" style="margin:0 0 16px">${escapeHtml(t(locale, `portal.detail.status_note.${contract.status.toLowerCase()}`))}</div>`;
  } else if (dunning) {
    // ACTIVE with an open case: the order is HELD, not scheduled — "Next
    // order {date}" would be a false promise while the payment is unpaid.
    body += `<div class="cxs-card cxs-row cxs-row--between"><div><span class="cxs-label">${escapeHtml(t(locale, "portal.dunning.held_since"))}</span><strong>${escapeHtml(formatShopDate(dunning.openedAt, ctx.tz, locale))}</strong></div><span class="cxs-chip cxs-chip--failed">${escapeHtml(t(locale, "portal.dunning.chip"))}</span></div>`;
  } else if (noFurtherOrders && contract.cancelScheduledAt) {
    // Scheduled cancel whose end falls before the mirror's next pointer
    // (further-orders.ts): the sweep will never bill that order, so the
    // "Your next delivery {date}" hero would be a false promise. The keep
    // button in the banner above is the way back.
    body += `<div class="cxs-card cxs-no-further-orders"><p style="margin:0">${escapeHtml(
      t(locale, "portal.detail.no_further_orders", {
        date: formatShopDate(contract.cancelScheduledAt, ctx.tz, locale),
      }),
    )}</p></div>`;
  } else if (contract.nextBillingDate) {
    // "Your next delivery" hero (P2.4 + P2.1): date, cut-off (or the
    // preparing chip + note), the lines as they will bill, the discounted
    // total from the shared estimate, ships-to / card / after-that, the
    // line-up CTA and stock-out / price-change notices. The chip flags an
    // expiring / expired / removed card (a payment issue took the branch
    // above).
    const cardChip = paymentChipKey(ctx.payment.state, {
      status: contract.status,
      hasIssue: false,
    });
    const chip = cardChip
      ? {
          label: t(locale, cardChip),
          className:
            ctx.payment.state === "EXPIRING" ? "cxs-chip--warn" : "cxs-chip--failed",
        }
      : { label: t(locale, "portal.status.active"), className: "cxs-chip--active" };

    // Line up with the customer's other active delivery: posts the existing
    // next_date action with the sibling's date, only when that date is a
    // valid next_date target and no lock / preparing state forbids it.
    let lineUp = null;
    if (!lock.locked && !preparing) {
      try {
        const siblings = await prisma.subscriptionContract.findMany({
          where: {
            shopId: shop.id,
            customerId: contract.customerId,
            status: "ACTIVE",
            id: { not: contract.id },
            ...OURS_ONLY,
          },
          select: { id: true, status: true, nextBillingDate: true },
        });
        const now = new Date();
        lineUp = lineUpTarget(contract, siblings, {
          tz: ctx.tz,
          locale,
          minDate: addDaysTz(now, 1, ctx.tz),
          maxDate: addDaysTz(now, ctx.nextDateMaxDays, ctx.tz),
        });
      } catch (err) {
        console.error("[portal] sibling contracts read failed", contract.id, err);
      }
    }

    // Stock-out: catalog availability of the contract's own variants (the
    // cached portal catalog), plus the newest stock-out delay behind the
    // current next date. Both contained.
    const availability = new Map<string, boolean>();
    for (const product of catalog) {
      for (const v of product.variants) availability.set(v.id, v.availableForSale);
    }
    const stockoutDelay = await loadRecentStockoutDelay(contract, attempts);

    body += nextDeliveryHeroHtml({
      locale,
      tz: ctx.tz,
      contract,
      estimate: ctx.estimate,
      cutoff: contractCutoff(contract.nextBillingDate, timing),
      preparing,
      preparingOrderDate: preparingDate,
      lineUp,
      outOfStockTitles: outOfStockTitles(contract.lines, availability),
      stockoutDelay,
      priceChange: ctx.priceLock.pending,
      chip,
      apiUrl: (action) => api(ctx, action),
      hiddenFields: (fields) => hiddenFields([...baseFields(ctx), ...fields]),
    });
  }

  // In-transit banner (P4.2): the newest shipped-not-delivered order, right
  // under the hero / status block — "Your {date} order is on its way — Track"
  // (order page when no tracking URL). Pure mirror read; role="status".
  body += inTransitBannerHtml({ locale, tz: ctx.tz, row: inTransit });

  if (dunning) {
    // "Skip that order and continue from {date}" (P1.9): FAILED contract,
    // exhausted case, card not hard-dead; the date is the one the verb will
    // set (same pure computation) — never a promise the POST cannot keep.
    let skipResumeDate: Date | null = null;
    if (
      isFailed &&
      dunning.state === "EXHAUSTED" &&
      !cardHardDeadReason(contract, new Date(), ctx.tz)
    ) {
      const heldDate = dunning.heldCycleDate ?? contract.nextBillingDate;
      if (heldDate) {
        skipResumeDate = computeSkipResumeDate({
          heldDate,
          frequency: contractFrequency(contract),
          tz: ctx.tz,
          now: new Date(),
        });
      }
    }
    body += dunningBannerHtml({
      locale,
      tz: ctx.tz,
      view: dunning,
      contract,
      status: contract.status,
      locked: lock.locked,
      liveMethodCount,
      retryCooldownMinutes,
      apiUrl: (action) => api(ctx, action),
      hiddenFields: (fields) => hiddenFields([...baseFields(ctx), ...fields]),
      helpHref: "#cxs-support",
      skipResumeDate,
    });
    // Impression event — real customers only, once per case per window.
    if (!portalSession.isPreview && !contract.isDemo) {
      await logDunningBannerShown({
        shopId: shop.id,
        contract,
        view: dunning,
        surface: "detail",
        windowHours: portalSettings.dunningBannerEventHours,
      });
    }
  }

  // Plan lock window notice: shown while the window runs, with the exact
  // unlock date — the controls it disables are hidden below, and the api
  // action refuses them server-side regardless of what a stale page posts.
  // Two renderings of the SAME mechanic (portal.friendlyLockMessaging,
  // v1.19.0): the friendly default is a "welcome period" progress card —
  // benefit-first copy, endowed progress (day X of Y), and an explicit
  // can-do list, never naming the blocked verbs (reactance/priming
  // hygiene); off = the original factual notice. Either way the date is the
  // exact shop-tz unlock promise.
  if (lock.locked && lock.until && (isActive || isPaused)) {
    const unlockDate = formatShopDate(lock.until, ctx.tz, locale);
    if (portalSettings.friendlyLockMessaging && lock.lockDays > 0) {
      // Display-only arithmetic: ±1h around DST shifts is acceptable here —
      // the enforced boundary stays resolveLockState's shop-tz midnight.
      const daysToGo = Math.max(
        1,
        Math.ceil((lock.until.getTime() - Date.now()) / 86_400_000),
      );
      const dayOfWindow = Math.min(
        lock.lockDays,
        Math.max(1, lock.lockDays - daysToGo + 1),
      );
      const pct = Math.min(
        100,
        Math.max(4, Math.round((dayOfWindow / lock.lockDays) * 100)),
      );
      // The can-do list must promise only what THIS page can deliver: add
      // and quantity are ACTIVE-only actions, so a paused-and-locked
      // subscriber is promised address/payment changes only.
      const canDo = (
        isActive
          ? [
              "portal.locked.friendly_can_add",
              "portal.locked.friendly_can_details",
              "portal.locked.friendly_can_qty",
            ]
          : ["portal.locked.friendly_can_details"]
      )
        .map(
          (key) =>
            `<span style="white-space:nowrap"><span style="color:var(--cxs-accent)" aria-hidden="true">&#10003;</span> ${escapeHtml(t(locale, key))}</span>`,
        )
        .join(" ");
      body += `<div class="cxs-card">
        <div class="cxs-row cxs-row--between">
          <strong>${escapeHtml(t(locale, "portal.locked.friendly_title"))}</strong>
          <span class="cxs-small cxs-muted">${escapeHtml(
            t(locale, "portal.locked.friendly_progress", {
              day: dayOfWindow,
              days: lock.lockDays,
            }),
          )}</span>
        </div>
        <div class="cxs-progress cxs-progress--welcome" role="progressbar" aria-label="${escapeHtml(t(locale, "portal.a11y.progress_welcome"))}" aria-valuemin="0" aria-valuemax="${lock.lockDays}" aria-valuenow="${dayOfWindow}" aria-valuetext="${escapeHtml(t(locale, "portal.locked.friendly_progress", { day: dayOfWindow, days: lock.lockDays }))}" style="height:6px;background:var(--cxs-accent-soft);border-radius:999px;margin:10px 0;overflow:hidden"><span style="width:${pct}%;height:100%;background:var(--cxs-accent);border-radius:999px"></span></div>
        <p class="cxs-small cxs-muted" style="margin:0 0 10px">${escapeHtml(
          t(locale, "portal.locked.friendly_body", { date: unlockDate }),
        )}</p>
        <p class="cxs-small" style="margin:0;display:flex;gap:6px 14px;flex-wrap:wrap">${canDo}</p>
      </div>`;
    } else {
      // Classic notice: with scheduled cancel ON (P3.8) it must not claim
      // cancellation is unavailable — the flow schedules it for the unlock
      // day, and the cancel link below stays reachable.
      body += `<div class="cxs-note" style="margin:0 0 16px">${escapeHtml(
        t(
          locale,
          scheduledCancelEnabled
            ? "portal.locked.notice_scheduled"
            : "portal.locked.notice",
          { date: unlockDate },
        ),
      )}</div>`;
    }
  }

  // Results timeline (v1.28.0, P4.1 — portalGrowth.resultsTimeline +
  // lifecycle.resultsTimeline.enabled + the results_timeline "shown" arm):
  // "Week N of your routine" with the phase copy for THIS week and what
  // comes next. Exposure is recorded here (the divergence point) for real
  // customers only; the admin preview / demo fixture render without touching
  // the experiment. A "checkin=unsure" landing (routine check-in email, "Not
  // sure yet") puts the card FIRST — ahead of the hero — with the education
  // card right under it, so the answer lands on the help, not on a schedule.
  const checkinParam = new URL(request.url).searchParams.get("checkin");
  const checkinAnswer =
    checkinParam === "great" ? "great" : checkinParam === "unsure" ? "unsure" : null;
  const educationLinks = await getEducationLinks(shop.id);
  const educationHtml = educationCardHtml({
    locale,
    links: educationLinks,
    productTitles: contract.lines
      .filter((l) => !l.isGift && !l.isOneTimeAddon)
      .map((l) => l.title),
    helpHref: "#cxs-support",
  });
  let timelineHtml = "";
  if (growth.resultsTimeline && isActive) {
    try {
      const timeline = await resolveTimeline(shop.id, locale);
      const position = timelinePosition(timeline, contract, new Date(), ctx.tz);
      if (position) {
        const arm =
          portalSession.isPreview || contract.isDemo
            ? "shown"
            : await resolveTimelineArm(contract);
        if (arm === "shown") {
          // Survey expectation sentence (P4.1 survey_personalisation) —
          // contained, null for holdout / no answer / toggle off.
          const expectation = await expectationLineFor({
            timeline,
            locale,
            contract,
            position,
          });
          timelineHtml = timelineCardHtml({
            locale,
            position,
            checkinAnswer,
            expectationLine: expectation,
          });
        }
      }
    } catch (err) {
      console.error("[portal] results timeline card failed", contract.id, err);
    }
  }
  let educationPlacedEarly = false;
  if (timelineHtml && checkinAnswer === "unsure" && !dunning) {
    body = timelineHtml + educationHtml + body;
    educationPlacedEarly = true;
  } else if (timelineHtml) {
    body += timelineHtml;
  }

  // First-cycle onboarding card (v1.28.0, P4.5 — portalGrowth.onboardingCard):
  // "What happens next" until the second order has billed. First-order facts
  // from the contract mirror (+ the delivery mirror's status when it has
  // one), next date + cut-off from THE estimate/timing helpers, the guide
  // links, the help anchor. Contained reads. Same "genuinely new" gate as
  // the welcome email: a contract without an origin order (CSV import,
  // backfill) is not a first-cycle subscriber and never gets a fabricated
  // "placed on {mirror birth}" first-order line.
  if (
    growth.onboardingCard &&
    isActive &&
    contract.ordersCount < 2 &&
    contract.originOrderId != null
  ) {
    try {
      let firstStatus: {
        statusLabel: string | null;
        orderStatusUrl: string | null;
        trackingUrl: string | null;
      } = { statusLabel: null, orderStatusUrl: null, trackingUrl: null };
      try {
        // The delivery mirror rows (already read when the deliveries surface
        // is on; a dedicated read otherwise, so this card never depends on
        // that toggle). The origin (checkout) order never becomes a
        // BillingAttempt, so a first-cycle contract's rows are usually
        // empty — the contract's own originOrderFulfilledAt (orders/fulfilled
        // mirror) is then the truthful "Shipped" fact; nothing mirrored ⇒ no
        // status claim at all (never "being prepared" for a checkout order).
        const rows = growth.deliveriesList
          ? deliveryRows
          : await listDeliveries(contract.id, {
              limit: 5,
              processingMaxDays: portalSettings.deliveriesProcessingMaxDays,
            });
        const first =
          rows.find((r) => contract.originOrderId != null && r.orderId === contract.originOrderId) ??
          rows.find((r) => r.cycleIndex === 0) ??
          (contract.ordersCount <= 1 ? rows[rows.length - 1] : undefined);
        if (first) {
          firstStatus = {
            statusLabel:
              first.status === "unknown" ? null : deliveryStatusLabel(locale, first.status),
            orderStatusUrl: first.orderStatusUrl,
            trackingUrl: first.trackingUrl,
          };
        } else if (contract.originOrderFulfilledAt) {
          firstStatus = {
            statusLabel: deliveryStatusLabel(locale, "shipped"),
            orderStatusUrl: null,
            trackingUrl: null,
          };
        }
      } catch (err) {
        console.error("[portal] onboarding: deliveries read failed", contract.id, err);
      }
      // Never the mirror row's createdAt: no order date ⇒ the no-date copy.
      const firstDate = contract.originOrderProcessedAt ?? contract.firstChargeAt ?? null;
      const cutoff = contract.nextBillingDate ? contractCutoff(contract.nextBillingDate, timing) : null;
      body += onboardingCardHtml({
        locale,
        firstOrder: {
          name: contract.originOrderName ?? null,
          dateLabel: firstDate ? formatShopDate(firstDate, ctx.tz, locale) : null,
          ...firstStatus,
        },
        nextDateLabel:
          contract.nextBillingDate && !dunning
            ? formatShopDate(contract.nextBillingDate, ctx.tz, locale)
            : null,
        cutoffLabel: cutoff && !preparing ? cutoffLabel(locale, cutoff, ctx.tz) : null,
        links: educationLinks,
        helpHref: "#cxs-support",
      });
    } catch (err) {
      console.error("[portal] onboarding card failed", contract.id, err);
    }
  }

  // Momentum upsell (portalGrowth.postActionUpsell, v1.20.0): a customer who
  // just did something positive for their subscription is in the cheapest
  // yes-state the portal ever sees (commitment consistency) — offer ONE
  // add-on, one tap, at the member price. POSITIVE moments only
  // (MOMENTUM_TOAST_KEYS): after a skip this slot would read as tone-deaf
  // and stays empty.
  if (
    growth.postActionUpsell &&
    isActive &&
    portalSettings.allowAddProducts &&
    resolvedToast &&
    MOMENTUM_TOAST_KEYS.has(resolvedToast.key)
  ) {
    const candidate = firstAddableCandidate(contract, catalog, discountByProduct);
    if (candidate) {
      const price = formatMoney(
        candidate.priceCents,
        contract.currencyCode,
        locale,
      );
      body += `<div class="cxs-card">
        <p class="cxs-small" style="margin:0 0 10px">${escapeHtml(t(locale, "portal.momentum.title"))}</p>
        <div class="cxs-row cxs-row--between">
          <div><p class="cxs-item__title" style="margin:0">${escapeHtml(candidate.title)}</p><p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.add.ships_with", { date: contract.nextBillingDate ? formatShopDate(contract.nextBillingDate, ctx.tz, locale) : "" }))}</p></div>
          <form method="post" action="${api(ctx, "addon")}">${hiddenFields([...baseFields(ctx), ["variantId", candidate.variantId], ["quantity", "1"]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.momentum.cta", { price }))}</button></form>
        </div>
      </div>`;
    }
  }

  // Cadence-fix nudge (portalGrowth.cadenceNudge): two or more skips in the
  // trailing window is a cadence mismatch, not two coincidences — fixing the
  // cadence keeps continuity where repeated skips erode it. Truthful framing:
  // price and rewards genuinely survive a frequency change.
  if (repeatedSkips && slowerOption) {
    const phrase = formatFrequency(
      (key, vars) => t(locale, key, vars),
      "every",
      slowerOption,
    );
    body += `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.nudge.cadence", { frequency: phrase }))}</p><form method="post" action="${api(ctx, "frequency")}">${hiddenFields([...baseFields(ctx), ["frequency", frequencyToken(slowerOption)]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.nudge.cadence_cta"))}</button></form></div>`;
  }

  // Runout prompt (portalGrowth.runoutPrompt): the churn model predicts the
  // customer runs OUT before the next box lands — the inverse of the
  // standing "running low later? push it back" prompt. Both CTAs grow or
  // protect the relationship: move the delivery up, or add one more unit.
  if (runoutDue && contract.predictedEmptyDate && contract.nextBillingDate) {
    const tomorrow = addDaysTz(new Date(), 1, ctx.tz);
    const moveUpTo =
      contract.predictedEmptyDate.getTime() > tomorrow.getTime()
        ? contract.predictedEmptyDate
        : tomorrow;
    const moveUpValue = dateInputValue(moveUpTo, ctx.tz);
    const moveUpLabel = formatShopDate(moveUpTo, ctx.tz, locale);
    const firstRecurring = contract.lines.find(
      (l) => !l.isGift && !l.isOneTimeAddon,
    );
    const addOneForm =
      firstRecurring && firstRecurring.quantity < ctx.maxQuantity
        ? `<form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", firstRecurring.id], ["quantity", String(firstRecurring.quantity + 1)]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.nudge.runout_add"))}</button></form>`
        : "";
    body += `<div class="cxs-banner cxs-banner--runout" id="cxs-runout"><p>${escapeHtml(t(locale, "portal.nudge.runout"))}</p><div class="cxs-actions" style="margin:0"><form method="post" action="${api(ctx, "next_date")}">${hiddenFields([...baseFields(ctx), ["date", moveUpValue]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.nudge.runout_moveup", { date: moveUpLabel }))}</button></form>${addOneForm}</div></div>`;
  }

  // "Already out" branch (v1.28.0, P2.7): the predicted-empty day has passed
  // and the next order is still more than a day away — offer to send it
  // tomorrow (sendNextOrderTomorrow: charged at tomorrow's charge moment,
  // later deliveries follow). An acceleration: not lock-gated; hidden while
  // the order is being prepared or a payment issue owns the cycle (the
  // service refuses both anyway — the page just does not offer them).
  if (
    growth.runoutPrompt &&
    isActive &&
    !preparing &&
    !dunning &&
    alreadyOut(
      contract.predictedEmptyDate,
      contract.nextBillingDate,
      new Date(),
      ctx.tz,
    )
  ) {
    const tomorrow = addDaysTz(new Date(), 1, ctx.tz);
    body += `<div class="cxs-banner cxs-banner--already-out"><p>${escapeHtml(t(locale, "portal.nudge.already_out"))}</p><div class="cxs-actions" style="margin:0"><form method="post" action="${api(ctx, "send_tomorrow")}">${hiddenFields([...baseFields(ctx), ["expected_next", contract.nextBillingDate?.toISOString() ?? ""]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.nudge.already_out_cta"))}</button></form></div><p class="cxs-muted cxs-small" style="margin:8px 0 0">${escapeHtml(t(locale, "portal.nudge.already_out_hint", { date: formatShopDate(tomorrow, ctx.tz, locale) }))}</p></div>`;
  }

  // Days-of-supply meter (v1.28.0, P2.9): "about N days left" from the churn
  // model's predicted-empty date — an estimate, said so; never rendered once
  // the day has passed (the branch above owns that moment) and never for a
  // contract that is not ACTIVE.
  if (growth.supplyMeter && isActive) {
    const days = daysOfSupplyLeft(contract.predictedEmptyDate, new Date());
    if (days != null) {
      // Named after the single recurring product (the model predicts per
      // contract); several products ⇒ the generic "product" string. Two
      // keys (not one with an optional placeholder) so every locale keeps
      // placeholder parity: `meter` carries {days}, `meter_product` {days, product}.
      const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
      const meterText =
        recurring.length === 1 && recurring[0].title
          ? t(locale, "portal.supply.meter_product", { days, product: recurring[0].title })
          : t(locale, "portal.supply.meter", { days });
      // Linked to the run-out prompt (P2.9 ↔ runoutPrompt) when the supply
      // ends before the next order lands — the prompt above holds the fixes.
      const link = runoutDue
        ? ` <a class="cxs-supply__link cxs-link" href="#cxs-runout">${escapeHtml(t(locale, "portal.supply.meter_runout_link"))}</a>`
        : "";
      body += `<p class="cxs-supply cxs-muted cxs-small" style="margin:0 0 12px"><span class="cxs-supply__days">${escapeHtml(meterText)}</span> <span class="cxs-supply__note">${escapeHtml(t(locale, "portal.supply.meter_estimate"))}</span>${link}</p>`;
    }
  }

  body += itemsCardHtml(ctx, catalog, discountByProduct, isActive);

  // Education hub (v1.28.0, P4.4): settings-driven links (how-to / routine
  // guide / FAQ) + the Get-help entry anchoring the support card below.
  // Hidden when no URL is configured; contained settings read. Already
  // placed under the timeline card on a "not sure yet" check-in landing.
  if (!educationPlacedEarly) body += educationHtml;

  if (isActive && portalSettings.allowAddProducts) {
    const addSection = await addProductHtml(ctx, catalog, discountByProduct, {
      upsell: growth.addonUpsell,
      shopId: shop.id,
    });
    body += addSection.html;
    // Impressions: real customers only — the admin preview and the demo
    // fixture must never inflate the offer-shown denominator.
    if (!portalSession.isPreview && !contract.isDemo) {
      await logAddonOfferImpressions(ctx, addSection.offered);
    }
  }
  if (isActive && !lock.locked) {
    // The schedule and pause cards hold only locked controls (next date,
    // frequency, skip, delay, pause) — hidden wholesale during the window.
    // Preparing (P2.1): the schedule card targets THIS cycle, which is
    // already being prepared — hidden until the following delivery (the hero
    // note says so); pause stays, it does not touch the in-flight order.
    // Open dunning case (v1.28.0 audit): the mirror's pointer is already
    // held+interval, so skip/delay/next_date/frequency/per-line edits would
    // silently target cycle N+1 while cycle N is still retrying — the hero
    // already says "held since"; the payment banner's verbs are the only
    // cycle actions until the case closes (the dispatcher refuses too).
    // No further orders (scheduled cancel ends before the pointer): nothing
    // to skip or move — the keep button is the way back.
    if (!preparing && !dunning && !noFurtherOrders) {
      body += scheduleHtml(
        ctx,
        frequency.options,
        frequency.allowChoice,
        growth.concessionLadder
          ? {
              slower: slowerOption,
              skipDate: skipConsequenceDate,
              milestoneNote: milestoneAway != null,
              fewer: fewerRow,
              downsize: downsizeRow,
            }
          : null,
      );
    }
    body += pauseHtml(ctx, pauseSettings.maxMonths);
  }
  if (editable) {
    body += addressHtml(ctx);
    // Delivery instructions (v1.28.0, P2.8): same editability as the
    // address (ACTIVE || PAUSED), never lock-gated.
    body += deliveryInstructionsHtml(
      ctx,
      portalSettings.deliveryInstructionsMaxChars ?? 250,
    );
  }
  if (editable || isFailed) {
    // FAILED contracts show the payment section too — the status note asks
    // the customer to update their card, so the button must be on this page.
    body += paymentHtml(ctx);
  }
  // "Your deliveries" card (P4.2): this contract's last 5 charged orders —
  // date, status chip (being prepared / shipped / delivered), Track link,
  // "View order & receipt" — from the mirror rows read above. Hidden when
  // the toggle is off or nothing has been charged yet (the onboarding card
  // and the empty account-tab state already cover a first cycle).
  if (growth.deliveriesList) {
    body += deliveriesCardHtml({
      locale,
      tz: ctx.tz,
      rows: deliveryRows,
      hideWhenEmpty: true,
    });
  }
  // Get-help card (v1.28.0, P5.1) — on EVERY subscription page, whatever the
  // status: resolved channels + the quick form (topic, message, last billed
  // orders, "push my next order back 1 week" for delivery problems on an
  // ACTIVE contract). A payment-issue banner above preselects Payment and
  // links here. Channels and orders are contained reads.
  {
    const channels = await getSupportChannels(shop.id);
    const orders = (await recentOrdersForPicker(contract.id, 5)).map((o) => ({
      id: o.id,
      label: orderPickerLabel(o, ctx.tz, locale, contract.currencyCode),
    }));
    const allowPushBack =
      isActive && !!contract.nextBillingDate && !preparing && !lock.locked;
    body += supportCardHtml({
      locale,
      channels,
      formAction: api(ctx, "support"),
      hiddenFields: hiddenFields([
        ...baseFields(ctx),
        ["surface", dunning ? "portal_dunning" : "portal_detail"],
        // The push-back IS a delay: carry the cycle date it targets so a
        // duplicate POST (stale tab, JS-off double-click) can never delay
        // two cycles — same dedupe the delay verb uses (expected_next).
        ...(allowPushBack
          ? ([["expected_next", contract.nextBillingDate?.toISOString() ?? ""]] as Array<
              [string, string]
            >)
          : []),
      ]),
      topic: dunning ? "PAYMENT" : null,
      orders,
      allowPushBack,
    });
  }

  if (editable && (!lock.locked || scheduledCancelEnabled)) {
    // Cancel flow entry — the cancel-flow module owns everything past here.
    // Inside the lock window the link stays (v1.28.0, P3.8) whenever
    // cancelFlow.scheduledCancelEnabled — the same toggle requireCancelContext
    // reads — because the flow then offers "schedule my cancellation for
    // {unlock date}": cancel must always be reachable (FTC/EU). With the
    // toggle off the link hides and requireCancelContext turns a direct
    // /cancel/:id visit away with the locked toast either way.
    body += `<p style="text-align:center;margin:24px 0 0"><a href="${withLocale(`${PORTAL_BASE_PATH}/cancel/${contract.id}`, locale, ctx.preview)}" class="cxs-muted cxs-small" style="color:var(--cxs-muted)">${escapeHtml(t(locale, "portal.detail.cancel_link"))}</a></p>`;
  }

  const toast = resolvedToast?.toast ?? null;
  const toastWithUndo: PortalToast | null = toast;
  if (
    toastWithUndo &&
    new URL(request.url).searchParams.get("toast") === "skipped"
  ) {
    toastWithUndo.html = `<form method="post" action="${api(ctx, "unskip")}">${hiddenFields(baseFields(ctx))}<button type="submit">${escapeHtml(t(locale, "portal.toast.undo"))}</button></form>`;
  }

  return liquid(
    portalPage({
      locale,
      title: t(locale, "portal.detail.title"),
      body,
      activeNav: "subscriptions",
      toast: toastWithUndo,
      backHref: withLocale(`${PORTAL_BASE_PATH}/`, locale, ctx.preview),
      backLabel: t(locale, "portal.detail.back"),
      isPreview: portalSession.isPreview,
      previewToken: portalSession.previewToken,
    }),
  );
};
