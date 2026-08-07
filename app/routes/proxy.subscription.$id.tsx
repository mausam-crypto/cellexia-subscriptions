import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { addDaysTz, formatShopDate } from "~/lib/dates.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  resolveToast,
  setupGatePage,
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
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Full subscription management: items (swap / quantity / remove), add a
 * product (recurring or next-order-only), schedule (next date, frequency,
 * skip, delay), pause with auto-resume, address, payment method, cancel.
 *
 * Every mutation is a plain form POST to /apps/cellexia-subscriptions/api/{action} carrying
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
  /** settings.portal.nextDateMaxDays — same bound the api action validates. */
  nextDateMaxDays: number;
  /** settings.portal.maxLineQuantity — same bound the api action validates. */
  maxQuantity: number;
}

function api(ctx: PageContext, action: string): string {
  return withLocale(`${PORTAL_BASE_PATH}/api/${action}`, ctx.locale);
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
  const minus =
    line.quantity <= 1
      ? `<button type="button" disabled aria-hidden="true">&minus;</button>`
      : `<form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(line.quantity - 1)]])}<button type="submit" aria-label="${escapeHtml(t(ctx.locale, "portal.items.decrease"))}">&minus;</button></form>`;
  const plus =
    line.quantity >= ctx.maxQuantity
      ? `<button type="button" disabled aria-hidden="true">+</button>`
      : `<form method="post" action="${api(ctx, "quantity")}">${hiddenFields([...baseFields(ctx), ["lineId", line.id], ["quantity", String(line.quantity + 1)]])}<button type="submit" aria-label="${escapeHtml(t(ctx.locale, "portal.items.increase"))}">+</button></form>`;
  return `<div class="cx-stepper">${minus}<span class="cx-stepper__qty">${line.quantity}</span>${plus}</div>`;
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

  return `<form method="post" action="${api(ctx, "swap")}" class="cx-row" style="margin-top:10px">
    ${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}
    <select class="cx-select" name="variantId" style="flex:1" aria-label="${escapeHtml(t(ctx.locale, "portal.items.swap_label"))}">${options}</select>
    <button type="submit" class="cx-btn cx-btn--ghost cx-btn--small">${escapeHtml(t(ctx.locale, "portal.items.swap"))}</button>
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
        ? `<img class="cx-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cx-thumb cx-thumb--placeholder">C</div>`;

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
          ? `<span class="cx-compare">${escapeHtml(formatMoney(line.compareAtPriceCents * line.quantity, contract.currencyCode, locale))}</span>`
          : "";
      const price = line.isGift
        ? escapeHtml(t(locale, "portal.item.free"))
        : `${compare}${escapeHtml(formatMoney(line.currentPriceCents * line.quantity, contract.currencyCode, locale))}`;

      let controls = "";
      if (editable && !line.isGift) {
        const canRemove = line.isOneTimeAddon || recurringCount > 1;
        const removeForm = canRemove
          ? `<form method="post" action="${api(ctx, "remove_line")}" data-cellexia-confirm="${escapeHtml(t(locale, "portal.items.remove_confirm", { title: line.title }))}">${hiddenFields([...baseFields(ctx), ["lineId", line.id]])}<button type="submit" class="cx-btn cx-btn--danger cx-btn--small">${escapeHtml(t(locale, "portal.items.remove"))}</button></form>`
          : "";
        const stepper = line.isOneTimeAddon ? "" : stepperHtml(ctx, line);
        const swap = line.isOneTimeAddon
          ? ""
          : swapHtml(
              ctx,
              line,
              catalogProduct(catalog, line.productId),
              discountByProduct.get(line.productId) ?? 0,
            );
        controls = `<div class="cx-row cx-row--between" style="margin-top:10px">${stepper}${removeForm}</div>${swap}`;
      }

      return `<div class="cx-item">${thumb}<div class="cx-item__body"><p class="cx-item__title">${escapeHtml(line.title)}</p>${meta ? `<p class="cx-item__meta">${escapeHtml(meta)}</p>` : ""}${controls}</div><span class="cx-price">${price}</span></div>`;
    })
    .join("");

  const totalCents =
    contract.lines.reduce(
      (sum, l) => sum + l.currentPriceCents * l.quantity,
      0,
    ) + contract.deliveryPriceCents;
  const delivery =
    contract.deliveryPriceCents > 0
      ? `<div class="cx-row cx-row--between cx-small cx-muted" style="margin-top:8px"><span>${escapeHtml(t(locale, "portal.detail.delivery"))}</span><span>${escapeHtml(formatMoney(contract.deliveryPriceCents, contract.currencyCode, locale))}</span></div>`
      : "";

  return `<section class="cx-card">
  <h2 style="font-size:18px;margin:0 0 14px">${escapeHtml(t(locale, "portal.detail.items_title"))}</h2>
  ${rows}
  ${delivery}
  <hr class="cx-divider">
  <div class="cx-row cx-row--between"><strong>${escapeHtml(t(locale, "portal.index.order_total"))}</strong><strong class="cx-price">${escapeHtml(formatMoney(totalCents, contract.currencyCode, locale))}</strong></div>
</section>`;
}

// ── Add a product ────────────────────────────────────────────────────────────

function addProductHtml(
  ctx: PageContext,
  catalog: CatalogProduct[],
  discountByProduct: Map<string, number>,
): string {
  const { locale, contract } = ctx;
  const inContract = new Set(
    contract.lines.filter((l) => !l.isOneTimeAddon).map((l) => l.variantId),
  );

  const cards = catalog
    .map((product) => {
      const pct = discountByProduct.get(product.id) ?? 0;
      const variants = product.variants.filter((v) => !inContract.has(v.id));
      if (variants.length === 0) return "";

      const first = variants[0];
      const priceHtml =
        pct > 0
          ? `<span class="cx-compare">${escapeHtml(formatMoney(first.priceCents, contract.currencyCode, locale))}</span>${escapeHtml(formatMoney(discountedCents(first.priceCents, pct), contract.currencyCode, locale))}`
          : escapeHtml(formatMoney(first.priceCents, contract.currencyCode, locale));

      const variantField =
        variants.length === 1
          ? `<input type="hidden" name="variantId" value="${escapeHtml(first.id)}">`
          : `<select class="cx-select" name="variantId" aria-label="${escapeHtml(t(locale, "portal.add.variant_label"))}">${variants
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
        ? `<img class="cx-thumb" src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cx-thumb cx-thumb--placeholder">C</div>`;

      return `<form method="post" action="${api(ctx, "add_line")}" class="cx-card">
        ${hiddenFields([...baseFields(ctx), ["quantity", "1"]])}
        ${thumb}
        <p class="cx-item__title" style="margin:0">${escapeHtml(product.title)}</p>
        <p class="cx-price cx-small" style="margin:0">${priceHtml}</p>
        ${variantField}
        <button type="submit" class="cx-btn cx-btn--small cx-btn--full">${escapeHtml(t(locale, "portal.add.recurring"))}</button>
        <button type="submit" class="cx-btn cx-btn--ghost cx-btn--small cx-btn--full" formaction="${api(ctx, "addon")}">${escapeHtml(t(locale, "portal.add.one_time"))}</button>
      </form>`;
    })
    .filter(Boolean)
    .join("");

  if (!cards) return "";

  return `<details class="cx-acc">
  <summary>${escapeHtml(t(locale, "portal.add.title"))}</summary>
  <div class="cx-acc__body">
    <p class="cx-muted cx-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.add.intro"))}</p>
    <div class="cx-grid">${cards}</div>
  </div>
</details>`;
}

// ── Schedule ─────────────────────────────────────────────────────────────────

function scheduleHtml(
  ctx: PageContext,
  frequencies: number[],
  allowFrequencyChoice: boolean,
): string {
  const { locale, tz, contract } = ctx;
  const now = new Date();
  const minDate = dateInputValue(addDaysTz(now, 1, tz), tz);
  const maxDate = dateInputValue(addDaysTz(now, ctx.nextDateMaxDays, tz), tz);
  const currentDate = contract.nextBillingDate
    ? dateInputValue(contract.nextBillingDate, tz)
    : minDate;

  const nextDateForm = `<div class="cx-field">
    <label class="cx-label" for="cx-next-date">${escapeHtml(t(locale, "portal.schedule.next_date_label"))}</label>
    <form method="post" action="${api(ctx, "next_date")}" class="cx-row">
      ${hiddenFields(baseFields(ctx))}
      <input class="cx-input" style="flex:1" id="cx-next-date" type="date" name="date" required value="${currentDate}" min="${minDate}" max="${maxDate}">
      <button type="submit" class="cx-btn cx-btn--ghost cx-btn--small">${escapeHtml(t(locale, "common.save"))}</button>
    </form>
  </div>`;

  const frequencyForm = allowFrequencyChoice
    ? `<div class="cx-field">
    <label class="cx-label" for="cx-frequency">${escapeHtml(t(locale, "portal.schedule.frequency_label"))}</label>
    <form method="post" action="${api(ctx, "frequency")}" class="cx-row">
      ${hiddenFields(baseFields(ctx))}
      <select class="cx-select" style="flex:1" id="cx-frequency" name="weeks">${frequencies
        .map(
          (w) =>
            `<option value="${w}"${w === contract.intervalWeeks ? " selected" : ""}>${escapeHtml(t(locale, "portal.schedule.every_weeks_option", { weeks: w }))}</option>`,
        )
        .join("")}</select>
      <button type="submit" class="cx-btn cx-btn--ghost cx-btn--small">${escapeHtml(t(locale, "common.save"))}</button>
    </form>
  </div>`
    : "";

  // Server-side double-submit dedupe: one-tap forms carry the cycle date they
  // target, so a duplicate POST for an already-advanced cycle is a no-op.
  const expectedNext: Array<[string, string]> = [
    ["expected_next", contract.nextBillingDate?.toISOString() ?? ""],
  ];
  const skipForm = `<form method="post" action="${api(ctx, "skip")}">${hiddenFields([...baseFields(ctx), ...expectedNext])}<button type="submit" class="cx-btn cx-btn--quiet cx-btn--small">${escapeHtml(t(locale, "portal.actions.skip"))}</button></form>`;
  const delayForm = `<form method="post" action="${api(ctx, "delay")}" class="cx-row cx-row--wrap">${hiddenFields([...baseFields(ctx), ...expectedNext])}
    <button type="submit" class="cx-btn cx-btn--quiet cx-btn--small" name="weeks" value="1">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 1 }))}</button>
    <button type="submit" class="cx-btn cx-btn--quiet cx-btn--small" name="weeks" value="2">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 2 }))}</button>
    <button type="submit" class="cx-btn cx-btn--quiet cx-btn--small" name="weeks" value="3">${escapeHtml(t(locale, "portal.schedule.delay_weeks", { weeks: 3 }))}</button>
  </form>`;

  return `<details class="cx-acc" open>
  <summary>${escapeHtml(t(locale, "portal.schedule.title"))}</summary>
  <div class="cx-acc__body cx-stack">
    ${nextDateForm}
    ${frequencyForm}
    <div>
      <span class="cx-label">${escapeHtml(t(locale, "portal.schedule.quick_label"))}</span>
      <div class="cx-actions" style="margin-top:4px">${skipForm}${delayForm}</div>
      <p class="cx-muted cx-small" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.schedule.skip_hint"))}</p>
    </div>
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
      return `<form method="post" action="${api(ctx, "pause")}">${hiddenFields([...baseFields(ctx), ["months", String(m)]])}<button type="submit" class="cx-btn cx-btn--quiet cx-btn--full" style="justify-content:space-between"><span>${escapeHtml(t(locale, "portal.pause.months", { months: m }))}</span><span class="cx-muted cx-small">${escapeHtml(t(locale, "portal.pause.until", { date: resumeDate }))}</span></button></form>`;
    })
    .join("");

  return `<details class="cx-acc">
  <summary>${escapeHtml(t(locale, "portal.pause.title"))}</summary>
  <div class="cx-acc__body cx-stack">
    <p class="cx-muted cx-small" style="margin:0">${escapeHtml(t(locale, "portal.pause.intro"))}</p>
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
    `<div class="cx-field${opts?.half ? "" : " cx-field--full"}">
      <label class="cx-label" for="cx-addr-${name}">${escapeHtml(t(locale, labelKey))}</label>
      <input class="cx-input" id="cx-addr-${name}" type="text" name="${name}" value="${escapeHtml(a[name] ?? "")}"${opts?.required ? " required" : ""}${opts?.autocomplete ? ` autocomplete="${opts.autocomplete}"` : ""}${opts?.maxlength ? ` maxlength="${opts.maxlength}"` : ""}>
    </div>`;

  return `<details class="cx-acc">
  <summary>${escapeHtml(t(locale, "portal.address.title"))}</summary>
  <div class="cx-acc__body">
    <form method="post" action="${api(ctx, "address")}">
      ${hiddenFields(baseFields(ctx))}
      <div class="cx-form-grid">
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
      <p class="cx-muted cx-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.address.country_hint"))}</p>
      <button type="submit" class="cx-btn cx-btn--full">${escapeHtml(t(locale, "portal.address.save"))}</button>
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
      )}</p>${expiry ? `<p class="cx-muted cx-small" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.payment.expires", { expiry }))}</p>` : ""}`
    : `<p class="cx-muted" style="margin:0">${escapeHtml(t(locale, "portal.payment.none"))}</p>`;

  const updateForm = contract.paymentMethodId
    ? `<form method="post" action="${api(ctx, "payment_update")}" style="margin-top:14px">${hiddenFields(baseFields(ctx))}<button type="submit" class="cx-btn cx-btn--ghost cx-btn--full">${escapeHtml(t(locale, "portal.payment.update"))}</button></form>
      <p class="cx-muted cx-small" style="margin:10px 0 0">${escapeHtml(t(locale, "portal.payment.secure_note"))}</p>`
    : "";

  return `<details class="cx-acc">
  <summary>${escapeHtml(t(locale, "portal.payment.title"))}</summary>
  <div class="cx-acc__body">${summary}${updateForm}</div>
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
    return liquid(setupGatePage(locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const contract = await loadOwnedContract(
    shop.id,
    params.id ?? "",
    portalSession,
  );
  if (!contract) {
    throw redirect(withLocale(`${PORTAL_BASE_PATH}/?toast=not_found`, locale));
  }

  const [portalSettings, pauseSettings, frequency] = await Promise.all([
    getSetting(shop.id, "portal"),
    getSetting(shop.id, "pause"),
    frequencyOptionsForContract(shop.id, contract),
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
    nextDateMaxDays: portalSettings.nextDateMaxDays,
    maxQuantity: portalSettings.maxLineQuantity,
  };

  const isActive = contract.status === "ACTIVE";
  const isPaused = contract.status === "PAUSED";
  const isCancelled = contract.status === "CANCELLED";
  const isFailed = contract.status === "FAILED";
  const editable = isActive || isPaused;

  let body = "";

  // Status banner for anything that is not simply active.
  if (isPaused) {
    const resumeCopy = contract.resumeAt
      ? t(locale, "portal.detail.paused_until", {
          date: formatShopDate(contract.resumeAt, ctx.tz, locale),
        })
      : t(locale, "portal.detail.paused");
    body += `<div class="cx-banner"><p>${escapeHtml(resumeCopy)}</p><form method="post" action="${api(ctx, "resume")}">${hiddenFields(baseFields(ctx))}<button type="submit" class="cx-btn cx-btn--small">${escapeHtml(t(locale, "portal.actions.resume"))}</button></form></div>`;
  } else if (isCancelled) {
    // Never a dead end: a returning customer restarts in one tap, through the
    // win-back reactivation service (no discount unless a win-back grant
    // already exists). Waiting for the win-back email is a pure LTGP leak.
    body += `<div class="cx-banner"><p>${escapeHtml(t(locale, "portal.detail.status_note.cancelled"))}</p><form method="post" action="${api(ctx, "reactivate")}">${hiddenFields(baseFields(ctx))}<button type="submit" class="cx-btn cx-btn--small">${escapeHtml(t(locale, "portal.actions.restart"))}</button></form></div>`;
  } else if (!isActive) {
    body += `<div class="cx-note" style="margin:0 0 16px">${escapeHtml(t(locale, `portal.detail.status_note.${contract.status.toLowerCase()}`))}</div>`;
  } else if (contract.nextBillingDate) {
    body += `<div class="cx-card cx-row cx-row--between"><div><span class="cx-label">${escapeHtml(t(locale, "portal.index.next_order"))}</span><strong>${escapeHtml(formatShopDate(contract.nextBillingDate, ctx.tz, locale))}</strong></div><span class="cx-chip cx-chip--active">${escapeHtml(t(locale, "portal.status.active"))}</span></div>`;
  }

  body += itemsCardHtml(ctx, catalog, discountByProduct, isActive);

  if (isActive && portalSettings.allowAddProducts) {
    body += addProductHtml(ctx, catalog, discountByProduct);
  }
  if (isActive) {
    body += scheduleHtml(ctx, frequency.options, frequency.allowChoice);
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
  if (editable) {
    // Cancel flow entry — the cancel-flow module owns everything past here.
    body += `<p style="text-align:center;margin:24px 0 0"><a href="${withLocale(`${PORTAL_BASE_PATH}/cancel/${contract.id}`, locale)}" class="cx-muted cx-small" style="color:var(--cx-muted)">${escapeHtml(t(locale, "portal.detail.cancel_link"))}</a></p>`;
  }

  const toast = resolveToast(request, locale)?.toast ?? null;
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
      backHref: withLocale(`${PORTAL_BASE_PATH}/`, locale),
      backLabel: t(locale, "portal.detail.back"),
      isPreview: portalSession.isPreview,
    }),
  );
};
