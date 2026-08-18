import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { getVariants } from "~/lib/graphql/index.server";
import {
  discountedCents,
  getPortalCatalog,
  ongoingDiscountPctByProduct,
} from "~/lib/portal/catalog.server";
import {
  addDaysTz,
  cardExpiryMoment,
  formatShopDate,
} from "~/lib/dates.server";
import { contractFrequency, formatFrequency } from "~/lib/frequency";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { sendNotification } from "~/lib/notifications/send.server";
import { emailCardLabel } from "~/lib/notifications/payment-method.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import { hasFurtherOrders } from "~/lib/cancel/further-orders";
import { estimateNextCharge, type EstimateLine } from "./estimate.server";
import {
  editCutoffSync,
  formatEditCutoff,
  resolveChargeTiming,
  type ChargeTiming,
} from "./timing.server";

/**
 * Pre-billing customer touches:
 *
 * - `runUpcomingOrderReminders`: "your next order is on {date}" N days before
 *   each renewal (N = settings.notifications.upcomingOrderDaysBefore), exactly once
 *   per billing occasion (NotificationLog dedupe keyed on the shop-tz day the
 *   charge is due — a skipped/delayed cycle never suppresses the reminder for
 *   the charge that actually happens). The notifications
 *   layer attaches the one-tap magic-link bundle (skip / delay / pause /
 *   update-card), which is where most churn-preventing engagement happens.
 *   Each reminder also carries a one-tap ADD-ON suggestion (`addon_variant_id`
 *   → `addon_url` in the bundle): the merchant-configured variant
 *   (settings.notifications.addonSuggestionVariantId) or the top subscribable
 *   catalog product the customer doesn't already receive.
 *
 * - `runPauseAutoResume`: PAUSED contracts whose resumeAt has arrived are
 *   resumed (source SYSTEM), and contracts approaching resumeAt get a heads-up
 *   reminder (settings.pause.resumeReminderDaysBefore) so the first renewed
 *   charge is never a surprise.
 */

// ── Add-on suggestion (one-tap "add it to my order" leg) ─────────────────────

interface AddonCandidate {
  variantId: string;
  productId: string | null;
  title: string;
  /** At the ongoing subscription discount — what addOneTimeAddon will charge. */
  priceCents: number;
  imageUrl: string | null;
}

/** "Product (Variant)" — hiding Shopify's placeholder single-variant title. */
function addonTitle(productTitle: string, variantTitle: string): string {
  const clean = variantTitle.trim();
  if (!clean || clean === "Default Title" || clean === productTitle) {
    return productTitle;
  }
  return `${productTitle} (${clean})`;
}

/**
 * Prioritized add-on suggestions for a reminder run: the merchant-configured
 * variant first (when live and purchasable), then the subscribable portal
 * catalog in display order. Prices mirror addOneTimeAddon's charging math
 * (variant price at the covering plan's ongoing discount) so the email never
 * quotes a number the customer won't pay. Failures degrade to no suggestion —
 * the reminder itself must always go out.
 */
async function resolveAddonCandidates(
  shop: { id: string; domain: string },
  configuredVariantId: string,
): Promise<AddonCandidate[]> {
  const candidates: AddonCandidate[] = [];
  try {
    const admin = await adminClientForShop(shop.domain);

    // 1. Merchant-configured variant (settings.notifications.addonSuggestionVariantId).
    if (configuredVariantId) {
      const gid = /^\d+$/.test(configuredVariantId)
        ? `gid://shopify/ProductVariant/${configuredVariantId}`
        : configuredVariantId;
      const [variant] = await getVariants(admin, [gid]);
      if (
        variant &&
        variant.availableForSale &&
        (variant.productStatus == null || variant.productStatus === "ACTIVE")
      ) {
        const pctMap = await ongoingDiscountPctByProduct(
          shop.id,
          variant.productId ? [variant.productId] : [],
        );
        const pct = variant.productId
          ? (pctMap.get(variant.productId) ?? 0)
          : 0;
        candidates.push({
          variantId: variant.id,
          productId: variant.productId,
          title: addonTitle(variant.productTitle, variant.title),
          priceCents: discountedCents(variant.priceCents, pct),
          imageUrl: variant.imageUrl,
        });
      } else {
        console.error(
          "[reminders] configured add-on variant is not purchasable — falling back to catalog",
          gid,
        );
      }
    }

    // 2. Auto fallback: subscribable catalog, top-listed first.
    const catalog = await getPortalCatalog(admin, shop.id);
    const pctByProduct = await ongoingDiscountPctByProduct(
      shop.id,
      catalog.map((p) => p.id),
    );
    for (const product of catalog) {
      const variant = product.variants.find((v) => v.availableForSale);
      if (!variant) continue;
      if (candidates.some((c) => c.variantId === variant.id)) continue;
      candidates.push({
        variantId: variant.id,
        productId: product.id,
        title: addonTitle(product.title, variant.title),
        priceCents: discountedCents(
          variant.priceCents,
          pctByProduct.get(product.id) ?? 0,
        ),
        imageUrl: product.imageUrl,
      });
    }
  } catch (err) {
    // Suggestion resolution must never block the reminder run.
    console.error("[reminders] add-on suggestion resolution failed", err);
  }
  return candidates;
}

/**
 * First candidate the contract doesn't already receive — suggesting a product
 * that's already in the box (as a line, gift or staged add-on) reads as a bug.
 */
function pickAddonForContract(
  candidates: AddonCandidate[],
  lines: Array<{ productId: string; variantId: string }>,
): AddonCandidate | null {
  for (const candidate of candidates) {
    const alreadyInBox = lines.some(
      (l) =>
        l.variantId === candidate.variantId ||
        (candidate.productId != null && l.productId === candidate.productId),
    );
    if (!alreadyInBox) return candidate;
  }
  return null;
}

/**
 * Shop-tz calendar day (YYYY-MM-DD) of a billing date — the schedule-anchored
 * component of the upcoming-order dedupe key. en-CA formats as ISO-ordered
 * YYYY-MM-DD (same convention as the test helpers).
 */
function shopDayKey(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// ── Card line + expiry warning (v1.28.0, P1.5) ──────────────────────────────

/**
 * The reminder's payment vars: `card_label` ("Visa ····4242" / "Shop Pay
 * ····4242" / "PayPal" / ""), `payment_line` (the localized "Payment method:
 * …" line, or "" when nothing is mirrored — the body's line then collapses),
 * and `card_expiry_warning` — "" or ONE localized sentence: the card expires
 * before this order (expiry moment ≤ the charge date), or within
 * `dunning.preExpiryNoticeDays` of now. Cards work through the last day of
 * their expiry month, so the expiry moment is the first instant of the
 * following month (same convention as the pre-expiry job). PayPal carries
 * no expiry. Never throws — a broken card mirror must not block the reminder.
 */
export function reminderCardVars(
  contract: {
    locale: string | null;
    paymentInstrumentType?: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
    /** Revoked on Shopify (v1.28.0 audit): the mirrored card no longer exists. */
    paymentMethodRevokedAt?: Date | null;
  },
  nextBillingDate: Date,
  now: Date,
  preExpiryNoticeDays: number,
  tz: string,
): { card_label: string; payment_line: string; card_expiry_warning: string } {
  const locale = contract.locale;
  // A revoked method: last4 stays mirrored for copy elsewhere ("Card ····4242
  // was removed"), but a reminder that names it as THE payment method for
  // this order — with "nothing to do" — would be false: the charge will fail.
  if (contract.paymentMethodRevokedAt != null) {
    return {
      card_label: "",
      payment_line: t(locale, "email.upcoming_order.payment_line_missing"),
      card_expiry_warning: "",
    };
  }
  let cardLabel = "";
  try {
    cardLabel = emailCardLabel(locale, contract);
  } catch (err) {
    console.error("[reminders] card label failed", err);
  }
  const paymentLine = cardLabel
    ? t(locale, "email.upcoming_order.payment_line", { card_label: cardLabel })
    : "";

  let warning = "";
  const month = contract.cardExpiryMonth;
  const year = contract.cardExpiryYear;
  const expiresAt = cardExpiryMoment(month, year, tz);
  if (
    month != null &&
    year != null &&
    expiresAt != null &&
    contract.paymentInstrumentType !== "PAYPAL"
  ) {
    const expiry = `${String(month).padStart(2, "0")}/${year}`;
    const vars = { card_last4: contract.cardLast4 ?? "", card_expiry: expiry };
    if (expiresAt <= nextBillingDate) {
      warning = t(locale, "email.upcoming_order.card_expiry_warning", vars);
    } else if (
      Number.isFinite(preExpiryNoticeDays) &&
      preExpiryNoticeDays > 0 &&
      addDaysTz(now, preExpiryNoticeDays, tz) >= expiresAt
    ) {
      warning = t(locale, "email.upcoming_order.card_expiry_warning_soon", vars);
    }
  }
  return {
    card_label: cardLabel,
    payment_line: paymentLine,
    card_expiry_warning: warning,
  };
}

// ── Edit cut-off line (v1.28.0, P2.1) ────────────────────────────────────────

/**
 * `edit_cutoff` ("18 August 2026, 06:00" in the shop tz + locale),
 * `edit_cutoff_iso` and the composed `edit_cutoff_line` ("You can make changes
 * until …") — from the SAME charge-moment helper the sweep bills on
 * (timing.server.ts), so the reminder can never promise a window the sweep
 * does not honour. Never throws: a formatting failure collapses the line.
 */
export function reminderCutoffVars(
  locale: string | null,
  nextBillingDate: Date,
  timing: ChargeTiming,
): { edit_cutoff: string; edit_cutoff_iso: string; edit_cutoff_line: string } {
  try {
    const cutoff = editCutoffSync(nextBillingDate, timing);
    // The shared rendering (timing.server.ts): hour-0 cut-offs read as the
    // end of the previous day, exactly as the portal home card and hero.
    const label = formatEditCutoff(cutoff, timing.tz, locale);
    return {
      edit_cutoff: label,
      edit_cutoff_iso: cutoff.toISOString(),
      edit_cutoff_line: t(locale, "email.upcoming_order.edit_cutoff_line", {
        edit_cutoff: label,
      }),
    };
  } catch (err) {
    console.error("[reminders] edit cut-off vars failed", err);
    return { edit_cutoff: "", edit_cutoff_iso: "", edit_cutoff_line: "" };
  }
}

/**
 * "Serum (30 ml) × 1, Night Cream × 2, Travel Kit (free)" — one line per
 * estimate row, in the estimate's order; free rows (attached or committed
 * gifts) carry the localized "(free)" marker so the email never lists a gift
 * as if it were billed. Lines the customer skipped for this cycle
 * (`skippedThisCycle`, v1.28.0 Stage D) are omitted — the email lists what
 * WILL ship; a one-cycle quantity tweak shows the billed quantity.
 */
export function itemsSummaryOf(
  locale: string | null,
  lines: EstimateLine[],
): string {
  return lines
    .filter((l) => !l.skippedThisCycle)
    .map((l) => {
      const item = `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""} × ${l.quantity}`;
      return l.free ? t(locale, "email.upcoming_order.item_free", { item }) : item;
    })
    .join(", ");
}

// ── Upcoming order reminders ─────────────────────────────────────────────────

export interface UpcomingReminderStats {
  scanned: number;
  sent: number;
  alreadySent: number;
  addonsSuggested: number;
  errors: number;
  skipped?: string;
}

export async function runUpcomingOrderReminders(
  now: Date,
): Promise<UpcomingReminderStats> {
  const stats: UpcomingReminderStats = {
    scanned: 0,
    sent: 0,
    alreadySent: 0,
    addonsSuggested: 0,
    errors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  const notifications = await getSetting(shop.id, "notifications");
  const daysBefore = notifications.upcomingOrderDaysBefore;
  // Everything billing in the next `daysBefore` shop-tz days. Contracts already
  // due today are about to be charged by the sweep — a reminder now would be
  // noise, so the window starts at `now`.
  const horizon = addDaysTz(now, daysBefore, tz);

  const candidates = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      // Another subscription app's subscribers are not ours to email.
      ...OURS_ONLY,
      status: "ACTIVE",
      isDemo: false, // portal-preview fixtures never get customer touches
      nextBillingDate: { gte: now, lte: horizon },
      // An open dunning case owns the customer's next-order story: the
      // portal says "Payment issue · Order held since {date}" and the ladder
      // emails carry the retry date. The mirror's nextBillingDate is
      // advanced optimistically at attempt creation and is NOT resynced by
      // the failure webhook, so a short-interval plan inside the case's life
      // would otherwise be told "your order is on {held+interval}, changes
      // until …" — a promise nothing keeps if the retry exhausts. The held
      // order's own reminder is the dunning ladder.
      dunningCases: { none: { state: { in: OPEN_CASE_STATES } } },
    },
    include: { lines: true },
    orderBy: { nextBillingDate: "asc" },
  });
  // Scheduled cancel (v1.28.0, P3.8): a pointer at or past cancelScheduledAt
  // is an order the sweep will never bill (the hourly job ends the contract
  // first) — no reminder, no one-tap skip/delay links to a phantom order.
  // JS filter: Prisma cannot compare two columns of the same row.
  const contracts = candidates.filter((c) => hasFurtherOrders(c));

  // One-tap add-on leg: candidates resolved once per run, matched per contract
  // below. Gated on the reminder's own toggle AND the portal add-products
  // policy — an add-on magic link is portal add-product with fewer taps, so it
  // must respect the same merchant switch.
  const portal = await getSetting(shop.id, "portal");
  const addonCandidates =
    contracts.length > 0 &&
    notifications.addonSuggestionEnabled &&
    portal.allowAddProducts
      ? await resolveAddonCandidates(
          shop,
          notifications.addonSuggestionVariantId.trim(),
        )
      : [];

  // Expiring-card window for the reminder's warning line — the same knob the
  // pre-expiry job uses (settings own every schedule). Failure-contained: a
  // broken read just drops the "expires soon" sentence (the "before this
  // order" sentence needs no setting).
  let preExpiryNoticeDays = 0;
  if (contracts.length > 0) {
    try {
      const dunning = await getSetting(shop.id, "dunning");
      preExpiryNoticeDays =
        typeof dunning?.preExpiryNoticeDays === "number"
          ? dunning.preExpiryNoticeDays
          : 0;
    } catch (err) {
      console.error("[reminders] dunning settings read failed", err);
    }
  }

  // Charge timing for the "you can make changes until …" line — the sweep's
  // own helper (contained: a broken read means hour 0, the default).
  const timing: ChargeTiming =
    contracts.length > 0
      ? await resolveChargeTiming(shop.id, tz)
      : { tz, chargeHourLocal: 0 };

  for (const contract of contracts) {
    stats.scanned += 1;
    try {
      const nextBillingDate = contract.nextBillingDate;
      if (!nextBillingDate) continue;

      // One reminder per BILLING OCCASION, across restarts and re-runs.
      // `ordersCount + 1` alone is NOT a stable occasion key: ordersCount
      // only moves on a successful charge, so after a skip the next real
      // cycle recomputes the SAME index and the pre-skip reminder's SENT row
      // would suppress the reminder for the charge that actually happens —
      // hitting exactly the customers who tapped this reminder's own one-tap
      // skip link (the winback engine documents the same ordersCount/cycle
      // divergence). The dedupe key therefore carries the shop-tz day the
      // charge is due: skip/delay move nextBillingDate, so the rescheduled
      // charge gets its own reminder, while re-runs quoting the same due day
      // still dedupe. Pre-key rows (no reminder_dedupe var) are matched by
      // the exact billing date they quoted (next_date_iso), which moves with
      // the schedule the same way — no duplicate across the upgrade.
      const cycleIndex = contract.ordersCount + 1;
      const reminderDedupe = `upcoming_order:${shopDayKey(nextBillingDate, tz)}`;
      const alreadySent = await prisma.notificationLog.findFirst({
        where: {
          contractId: contract.id,
          template: "upcoming_order",
          status: "SENT",
          OR: [
            {
              payload: {
                path: ["vars", "reminder_dedupe"],
                equals: reminderDedupe,
              },
            },
            {
              payload: {
                path: ["vars", "next_date_iso"],
                equals: nextBillingDate.toISOString(),
              },
            },
          ],
        },
        select: { id: true },
      });
      if (alreadySent) {
        stats.alreadySent += 1;
        continue;
      }

      // Estimate = plan pricing minus any live per-cycle grant, plus delivery
      // — the shared next-order estimate (estimate.server.ts, v1.28.0), the
      // same numbers the portal shows. Taxes are Shopify's at charge time,
      // so this stays an estimate.
      const est = await estimateNextCharge(
        { id: shop.id, ianaTimezone: tz },
        contract,
      );
      const itemsSummary = itemsSummaryOf(contract.locale, est.lines);
      const totalCents = est.totalCents;
      const grantPercent = est.discountPercent;

      // `addon_variant_id` makes the notifications layer build the one-tap
      // `addon_url` magic link (ADD_TO_NEXT) into the Klaviyo link bundle.
      const addon = pickAddonForContract(addonCandidates, contract.lines);

      // Cadence vars: frequency_weeks stays the week approximation (additive
      // Klaviyo contract); `frequency` is the localized phrase the {frequency}
      // template placeholders render, in the same locale the send resolves.
      const freq = contractFrequency(contract);

      // Payment line + expiring-card warning (v1.28.0, P1.5).
      const cardVars = reminderCardVars(
        contract,
        nextBillingDate,
        now,
        preExpiryNoticeDays,
        tz,
      );
      // Edit cut-off (v1.28.0, P2.1) — the sweep's charge moment.
      const cutoffVars = reminderCutoffVars(contract.locale, nextBillingDate, timing);

      const result = await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "upcoming_order",
        locale: contract.locale,
        vars: {
          cycleIndex,
          ...cardVars,
          ...cutoffVars,
          // Persistent occasion dedupe (see the alreadySent check above) —
          // lands in the SENT row's payload.vars like dunning_dedupe does.
          reminder_dedupe: reminderDedupe,
          items_summary: itemsSummary,
          item_count: est.lines.filter((l) => !l.skippedThisCycle).length,
          total_estimate: formatMoney(
            totalCents,
            contract.currencyCode,
            contract.locale,
          ),
          total_estimate_cents: totalCents,
          next_date: formatShopDate(nextBillingDate, tz, contract.locale),
          next_date_iso: nextBillingDate.toISOString(),
          // "After that" date (v1.28.0) — one interval on, from the estimate.
          ...(est.followingBillingDate
            ? {
                following_date: formatShopDate(
                  est.followingBillingDate,
                  tz,
                  contract.locale,
                ),
                following_date_iso: est.followingBillingDate.toISOString(),
              }
            : {}),
          frequency_weeks: contract.intervalWeeks,
          frequency_unit: freq.unit,
          frequency_count: freq.count,
          frequency: formatFrequency(
            (key, fvars) => t(contract.locale, key, fvars),
            "every",
            freq,
          ),
          ...(grantPercent != null ? { discount_percent: grantPercent } : {}),
          ...(addon
            ? {
                addon_variant_id: addon.variantId,
                ...(addon.productId
                  ? { addon_product_id: addon.productId }
                  : {}),
                addon_title: addon.title,
                addon_price_cents: addon.priceCents,
                addon_price_formatted: formatMoney(
                  addon.priceCents,
                  contract.currencyCode,
                  contract.locale,
                ),
                ...(addon.imageUrl ? { addon_image_url: addon.imageUrl } : {}),
              }
            : {}),
        },
      });
      if (result.status === "SENT") {
        stats.sent += 1;
        if (addon) stats.addonsSuggested += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error("[reminders] upcoming-order send failed", contract.id, err);
    }
  }

  return stats;
}

// ── Pause auto-resume + resume reminders ─────────────────────────────────────

export interface PauseAutoResumeStats {
  resumed: number;
  resumeErrors: number;
  remindersSent: number;
  reminderErrors: number;
  skipped?: string;
}

export async function runPauseAutoResume(
  now: Date,
): Promise<PauseAutoResumeStats> {
  const stats: PauseAutoResumeStats = {
    resumed: 0,
    resumeErrors: 0,
    remindersSent: 0,
    reminderErrors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  // 1. Auto-resume: the pause window is over. The contracts service owns the
  //    Shopify mutation, mirror update and contract.resumed event.
  const dueForResume = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      ...OURS_ONLY, // never resume (or touch) another app's contract
      status: "PAUSED",
      isDemo: false,
      resumeAt: { not: null, lte: now },
    },
    select: { id: true, resumeAt: true },
  });

  for (const { id, resumeAt } of dueForResume) {
    try {
      const svc = await import("~/lib/contracts/service.server");
      // `billOn: resumeAt` (v1.28.0, P2.6): the first post-hold charge lands
      // at the charge moment of the promised resume day — the reminder said
      // "resumes on {resume_date}", so no +3-day drift, and never earlier
      // (a late run bills at the next sweep, not retroactively).
      await (
        svc.resumeContract as unknown as (
          shopDomain: string,
          contractId: string,
          opts?: { source?: string; billOn?: Date | null },
        ) => Promise<unknown>
      )(shop.domain, id, { source: "SYSTEM", billOn: resumeAt });
      stats.resumed += 1;
    } catch (err) {
      stats.resumeErrors += 1;
      console.error("[reminders] auto-resume failed", id, err);
    }
  }

  // 2. Resume reminders: heads-up before the subscription wakes up again.
  const pause = await getSetting(shop.id, "pause");
  const horizon = addDaysTz(now, pause.resumeReminderDaysBefore, tz);

  const approaching = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      ...OURS_ONLY,
      status: "PAUSED",
      isDemo: false,
      resumeAt: { gt: now, lte: horizon },
    },
    include: { lines: true },
  });

  // One-tap add-on leg (v1.16.0), same gates and candidate pool as the
  // upcoming-order reminder: a resume reminder is the other natural "your
  // box is coming" moment for adding a product in one click.
  const notifications = await getSetting(shop.id, "notifications");
  const portal = await getSetting(shop.id, "portal");
  const resumeAddonCandidates =
    approaching.length > 0 &&
    notifications.addonSuggestionEnabled &&
    portal.allowAddProducts
      ? await resolveAddonCandidates(
          shop,
          notifications.addonSuggestionVariantId.trim(),
        )
      : [];

  for (const contract of approaching) {
    try {
      const resumeAt = contract.resumeAt;
      if (!resumeAt) continue;

      // One reminder per RESUME DAY, not per pause episode: any SENT
      // resume_reminder since the hold was last (re)set means we already
      // reminded for the day it currently ends on. `extendPause` (portal
      // "need a little longer" or the reminder's own EXTEND_PAUSE link)
      // moves resumeAt later without touching pausedAt, so the dedupe floor
      // is max(pausedAt, latest contract.pause_extended) — the new resume
      // day gets its own heads-up instead of a silent auto-resume charge
      // (v1.28.0 review fix). Contained: an event-log read failure keeps
      // the per-episode floor.
      let dedupeSince =
        contract.pausedAt ?? new Date(now.getTime() - 180 * 86_400_000);
      try {
        const lastExtended = await prisma.subscriberEvent.findFirst({
          where: {
            contractId: contract.id,
            type: "contract.pause_extended",
            createdAt: { gte: dedupeSince },
          },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (lastExtended && lastExtended.createdAt.getTime() > dedupeSince.getTime()) {
          dedupeSince = lastExtended.createdAt;
        }
      } catch (err) {
        console.error(
          "[reminders] resume reminder: pause_extended lookup failed, using pausedAt",
          contract.id,
          err,
        );
      }
      const alreadySent = await prisma.notificationLog.findFirst({
        where: {
          contractId: contract.id,
          template: "resume_reminder",
          status: "SENT",
          createdAt: { gte: dedupeSince },
        },
        select: { id: true },
      });
      if (alreadySent) continue;

      // email.resume_reminder.body renders {frequency} — the localized phrase
      // is required; frequency_weeks stays alongside (additive contract).
      const freq = contractFrequency(contract);

      // `addon_variant_id` makes the notifications layer mint the one-tap
      // `addon_url` (ADD_TO_NEXT) into this reminder's link bundle too.
      const addon = pickAddonForContract(resumeAddonCandidates, contract.lines);

      const result = await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "resume_reminder",
        locale: contract.locale,
        vars: {
          resume_date: formatShopDate(resumeAt, tz, contract.locale),
          resume_date_iso: resumeAt.toISOString(),
          frequency_weeks: contract.intervalWeeks,
          frequency_unit: freq.unit,
          frequency_count: freq.count,
          frequency: formatFrequency(
            (key, fvars) => t(contract.locale, key, fvars),
            "every",
            freq,
          ),
          ...(addon
            ? {
                addon_variant_id: addon.variantId,
                ...(addon.productId
                  ? { addon_product_id: addon.productId }
                  : {}),
                addon_title: addon.title,
                addon_price_cents: addon.priceCents,
                addon_price_formatted: formatMoney(
                  addon.priceCents,
                  contract.currencyCode,
                  contract.locale,
                ),
                ...(addon.imageUrl ? { addon_image_url: addon.imageUrl } : {}),
              }
            : {}),
        },
      });
      if (result.status === "SENT") stats.remindersSent += 1;
    } catch (err) {
      stats.reminderErrors += 1;
      console.error("[reminders] resume reminder failed", contract.id, err);
    }
  }

  return stats;
}
