import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { addDaysTz, addIntervalTz, formatShopDate } from "~/lib/dates.server";
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
import type {
  LocalContractLine,
  LocalContractWithLines,
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

function swapHtml(
  ctx: PageContext,
  line: LocalContractLine,
  product: CatalogProduct | null,
  discountPct: number,
): string {
  if (!product) return "";
  const alternatives = product.variants.filter((v) => v.id !== line.variantId);
  if (alternatives.length === 0) return "";

  const options = product.variants
    .map((v) => {
      const price = formatMoney(
        discountedCents(v.priceCents, discountPct),
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

      let controls = "";
      if (editable && !line.isGift) {
        // Lock window: recurring lines cannot be removed or swapped while it
        // runs (one-time addons stay removable — undoing an addition).
        const canRemove =
          line.isOneTimeAddon || (recurringCount > 1 && !ctx.lock.locked);
        const removeForm = canRemove
          ? `<form method="post" action="${api(ctx, "remove_line")}" data-cellexia-confirm="${escapeHtml(t(locale, "portal.items.remove_confirm", { title: line.title }))}">${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}<button type="submit" class="cxs-btn cxs-btn--danger cxs-btn--small">${escapeHtml(t(locale, "portal.items.remove"))}</button></form>`
          : "";
        const stepper = line.isOneTimeAddon ? "" : stepperHtml(ctx, line);
        const swap =
          line.isOneTimeAddon || ctx.lock.locked
            ? ""
            : swapHtml(
                ctx,
                line,
                catalogProduct(catalog, line.productId),
                discountByProduct.get(line.productId) ?? 0,
              );
        controls = `<div class="cxs-row cxs-row--between" style="margin-top:10px">${stepper}${removeForm}</div>${swap}`;
      }

      return `<div class="cxs-item">${thumb}<div class="cxs-item__body"><p class="cxs-item__title">${escapeHtml(line.title)}</p>${meta ? `<p class="cxs-item__meta">${escapeHtml(meta)}</p>` : ""}${controls}</div><span class="cxs-price">${price}</span></div>`;
    })
    .join("");

  const totalCents =
    contract.lines.reduce(
      (sum, l) => sum + l.currentPriceCents * l.quantity,
      0,
    ) + contract.deliveryPriceCents;
  const delivery =
    contract.deliveryPriceCents > 0
      ? `<div class="cxs-row cxs-row--between cxs-small cxs-muted" style="margin-top:8px"><span>${escapeHtml(t(locale, "portal.detail.delivery"))}</span><span>${escapeHtml(formatMoney(contract.deliveryPriceCents, contract.currencyCode, locale))}</span></div>`
      : "";

  return `<section class="cxs-card">
  <h2 style="font-size:18px;margin:0 0 14px">${escapeHtml(t(locale, "portal.detail.items_title"))}</h2>
  ${rows}
  ${delivery}
  <hr class="cxs-divider">
  <div class="cxs-row cxs-row--between"><strong>${escapeHtml(t(locale, "portal.index.order_total"))}</strong><strong class="cxs-price">${escapeHtml(formatMoney(totalCents, contract.currencyCode, locale))}</strong></div>
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
      <select class="cxs-select" style="flex:1" id="cxs-frequency" name="frequency">${frequencies
        .filter((f) => parseFrequencyToken(frequencyToken(f)) !== null)
        .map(
          (f) =>
            `<option value="${escapeHtml(frequencyToken(f))}"${sameFrequency(f, currentFrequency) ? " selected" : ""}>${escapeHtml(formatFrequency(tr, "option", f))}</option>`,
        )
        .join("")}</select>
      <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "common.save"))}</button>
    </form>
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
  let quickActions: string;
  if (ladder) {
    const delayRow = `<div style="border:1px solid var(--cxs-accent);border-radius:8px;padding:10px 12px">
      <p style="margin:0;font-weight:500">${escapeHtml(t(locale, "portal.ladder.delay_title"))}</p>
      <p class="cxs-muted cxs-small" style="margin:2px 0 8px">${escapeHtml(t(locale, "portal.ladder.delay_sub"))}</p>
      <form method="post" action="${api(ctx, "delay")}" class="cxs-row cxs-row--wrap">${hiddenFields([...baseFields(ctx), ...expectedNext])}
        <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small" name="weeks" value="1">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 1 }))}</button>
        <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small" name="weeks" value="2">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 2 }))}</button>
        <button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small" name="weeks" value="3">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 3 }))}</button>
      </form>
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
      <div class="cxs-stack" style="margin-top:6px">${delayRow}${slowerRow}${skipRow}</div>
    </div>`;
  } else {
    const skipForm = `<form method="post" action="${api(ctx, "skip")}">${hiddenFields([...baseFields(ctx), ...expectedNext])}<button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small">${escapeHtml(t(locale, "portal.actions.skip"))}</button></form>`;
    const delayForm = `<form method="post" action="${api(ctx, "delay")}" class="cxs-row cxs-row--wrap">${hiddenFields([...baseFields(ctx), ...expectedNext])}
    <button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small" name="weeks" value="1">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 1 }))}</button>
    <button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small" name="weeks" value="2">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 2 }))}</button>
    <button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--small" name="weeks" value="3">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 3 }))}</button>
  </form>`;
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

  return `<details class="cxs-acc">
  <summary>${escapeHtml(t(locale, "portal.pause.title"))}</summary>
  <div class="cxs-acc__body cxs-stack">
    <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.pause.intro"))}</p>
    ${buttons}
  </div>
</details>`;
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
        ${field("address1", "portal.address.address1", { required: true, autocomplete: "address-line1" })}
        ${field("address2", "portal.address.address2", { autocomplete: "address-line2" })}
        ${field("city", "portal.address.city", { half: true, required: true, autocomplete: "address-level2" })}
        ${field("zip", "portal.address.zip", { half: true, required: true, autocomplete: "postal-code" })}
        ${field("provinceCode", "portal.address.province", { half: true, maxlength: 3 })}
        ${field("countryCode", "portal.address.country", { half: true, required: true, autocomplete: "country", maxlength: 2 })}
        ${field("phone", "portal.address.phone", { autocomplete: "tel" })}
      </div>
      <p class="cxs-muted cxs-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.address.country_hint"))}</p>
      <button type="submit" class="cxs-btn cxs-btn--full">${escapeHtml(t(locale, "portal.address.save"))}</button>
    </form>
  </div>
</details>`;
}

// ── Payment ──────────────────────────────────────────────────────────────────

function paymentHtml(ctx: PageContext): string {
  const { locale, contract } = ctx;
  const hasCard = contract.cardBrand || contract.cardLast4;
  const expiry =
    contract.cardExpiryMonth && contract.cardExpiryYear
      ? `${String(contract.cardExpiryMonth).padStart(2, "0")}/${contract.cardExpiryYear}`
      : null;

  const summary = hasCard
    ? `<p style="margin:0;font-weight:500">${escapeHtml(
        t(locale, "portal.payment.card_summary", {
          brand: contract.cardBrand ?? t(locale, "portal.payment.card_generic"),
          last4: contract.cardLast4 ?? "····",
        }),
      )}</p>${expiry ? `<p class="cxs-muted cxs-small" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.payment.expires", { expiry }))}</p>` : ""}`
    : `<p class="cxs-muted" style="margin:0">${escapeHtml(t(locale, "portal.payment.none"))}</p>`;

  const updateForm = contract.paymentMethodId
    ? `<form method="post" action="${api(ctx, "payment_update")}" style="margin-top:14px">${hiddenFields(baseFields(ctx))}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--full">${escapeHtml(t(locale, "portal.payment.update"))}</button></form>
      <p class="cxs-muted cxs-small" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.payment.secure_note"))}</p>`
    : "";

  return `<details class="cxs-acc">
  <summary>${escapeHtml(t(locale, "portal.payment.title"))}</summary>
  <div class="cxs-acc__body">${summary}${updateForm}</div>
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

  const [portalSettings, pauseSettings, growth, lifecycle, frequency, lock] =
    await Promise.all([
      getSetting(shop.id, "portal"),
      getSetting(shop.id, "pause"),
      getSetting(shop.id, "portalGrowth"),
      getSetting(shop.id, "lifecycle"),
      frequencyOptionsForContract(shop.id, contract),
      resolveLockState(shop.id, contract, shop.ianaTimezone),
    ]);

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
  );
  const skipConsequenceDate =
    isActive && contract.nextBillingDate
      ? formatShopDate(
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
  if (growth.cadenceNudge && isActive && slowerOption && !lock.locked) {
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
    runsOutBeforeNextDelivery(
      contract.predictedEmptyDate,
      contract.nextBillingDate,
      new Date(),
    );
  // The toast key drives the momentum slot; the toast itself renders as
  // today. Resolved once here so both consumers agree.
  const resolvedToast = resolveToast(request, locale);

  let body = "";

  // Status banner for anything that is not simply active.
  if (isPaused) {
    const resumeCopy = contract.resumeAt
      ? t(locale, "portal.detail.paused_until", {
          date: formatShopDate(contract.resumeAt, ctx.tz, locale),
        })
      : t(locale, "portal.detail.paused");
    body += `<div class="cxs-banner"><p>${escapeHtml(resumeCopy)}</p><form method="post" action="${api(ctx, "resume")}">${hiddenFields(baseFields(ctx))}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.actions.resume"))}</button></form></div>`;
  } else if (isCancelled) {
    // Never a dead end: a returning customer restarts in one tap, through the
    // win-back reactivation service (no discount unless a win-back grant
    // already exists). Waiting for the win-back email is a pure LTGP leak.
    body += `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.detail.status_note.cancelled"))}</p><form method="post" action="${api(ctx, "reactivate")}">${hiddenFields(baseFields(ctx))}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.actions.restart"))}</button></form></div>`;
  } else if (!isActive) {
    body += `<div class="cxs-note" style="margin:0 0 16px">${escapeHtml(t(locale, `portal.detail.status_note.${contract.status.toLowerCase()}`))}</div>`;
  } else if (contract.nextBillingDate) {
    body += `<div class="cxs-card cxs-row cxs-row--between"><div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.next_order"))}</span><strong>${escapeHtml(formatShopDate(contract.nextBillingDate, ctx.tz, locale))}</strong></div><span class="cxs-chip cxs-chip--active">${escapeHtml(t(locale, "portal.status.active"))}</span></div>`;
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
        <div style="height:6px;background:var(--cxs-accent-soft);border-radius:999px;margin:10px 0;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--cxs-accent);border-radius:999px"></div></div>
        <p class="cxs-small cxs-muted" style="margin:0 0 10px">${escapeHtml(
          t(locale, "portal.locked.friendly_body", { date: unlockDate }),
        )}</p>
        <p class="cxs-small" style="margin:0;display:flex;gap:6px 14px;flex-wrap:wrap">${canDo}</p>
      </div>`;
    } else {
      body += `<div class="cxs-note" style="margin:0 0 16px">${escapeHtml(
        t(locale, "portal.locked.notice", { date: unlockDate }),
      )}</div>`;
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
    body += `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.nudge.runout"))}</p><div class="cxs-actions" style="margin:0"><form method="post" action="${api(ctx, "next_date")}">${hiddenFields([...baseFields(ctx), ["date", moveUpValue]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.nudge.runout_moveup", { date: moveUpLabel }))}</button></form>${addOneForm}</div></div>`;
  }

  body += itemsCardHtml(ctx, catalog, discountByProduct, isActive);

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
    body += scheduleHtml(
      ctx,
      frequency.options,
      frequency.allowChoice,
      growth.concessionLadder
        ? {
            slower: slowerOption,
            skipDate: skipConsequenceDate,
            milestoneNote: milestoneAway != null,
          }
        : null,
    );
    body += pauseHtml(ctx, pauseSettings.maxMonths);
  }
  if (editable) {
    body += addressHtml(ctx);
  }
  if (editable || isFailed) {
    // FAILED contracts show the payment section too — the status note asks
    // the customer to update their card, so the button must be on this page.
    body += paymentHtml(ctx);
  }
  if (editable && !lock.locked) {
    // Cancel flow entry — the cancel-flow module owns everything past here.
    // Hidden during the lock window; requireCancelContext turns a direct
    // /cancel/:id visit away with the same toast either way.
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
