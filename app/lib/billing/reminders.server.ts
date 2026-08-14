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
import { addDaysTz, formatShopDate } from "~/lib/dates.server";
import { contractFrequency, formatFrequency } from "~/lib/frequency";
import { t } from "~/lib/i18n/i18n.server";
import { applyDiscountPct, formatMoney } from "~/lib/money";
import { sendNotification } from "~/lib/notifications/send.server";
import { getActiveDiscountForCycle } from "./discounts.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Pre-billing customer touches:
 *
 * - `runUpcomingOrderReminders`: "your order ships soon" N days before each
 *   renewal (N = settings.notifications.upcomingOrderDaysBefore), exactly once
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

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      // Another subscription app's subscribers are not ours to email.
      ...OURS_ONLY,
      status: "ACTIVE",
      isDemo: false, // portal-preview fixtures never get customer touches
      nextBillingDate: { gte: now, lte: horizon },
    },
    include: { lines: true },
    orderBy: { nextBillingDate: "asc" },
  });

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

      const chargeableLines = contract.lines.filter((l) => !l.isGift);
      const itemsSummary = contract.lines
        .map(
          (l) =>
            `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""} × ${l.quantity}`,
        )
        .join(", ");

      // Estimate = plan pricing minus any live per-cycle grant, plus delivery.
      // Taxes are Shopify's at charge time, so this stays an estimate.
      let subtotalCents = chargeableLines.reduce(
        (sum, l) => sum + l.currentPriceCents * l.quantity,
        0,
      );
      const grant = await getActiveDiscountForCycle(contract.id);
      if (grant) subtotalCents = applyDiscountPct(subtotalCents, grant.percent);
      const totalCents = subtotalCents + contract.deliveryPriceCents;

      // `addon_variant_id` makes the notifications layer build the one-tap
      // `addon_url` magic link (ADD_TO_NEXT) into the Klaviyo link bundle.
      const addon = pickAddonForContract(addonCandidates, contract.lines);

      // Cadence vars: frequency_weeks stays the week approximation (additive
      // Klaviyo contract); `frequency` is the localized phrase the {frequency}
      // template placeholders render, in the same locale the send resolves.
      const freq = contractFrequency(contract);

      const result = await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "upcoming_order",
        locale: contract.locale,
        vars: {
          cycleIndex,
          // Persistent occasion dedupe (see the alreadySent check above) —
          // lands in the SENT row's payload.vars like dunning_dedupe does.
          reminder_dedupe: reminderDedupe,
          items_summary: itemsSummary,
          item_count: contract.lines.length,
          total_estimate: formatMoney(
            totalCents,
            contract.currencyCode,
            contract.locale,
          ),
          total_estimate_cents: totalCents,
          next_date: formatShopDate(nextBillingDate, tz, contract.locale),
          next_date_iso: nextBillingDate.toISOString(),
          frequency_weeks: contract.intervalWeeks,
          frequency_unit: freq.unit,
          frequency_count: freq.count,
          frequency: formatFrequency(
            (key, fvars) => t(contract.locale, key, fvars),
            "every",
            freq,
          ),
          ...(grant ? { discount_percent: grant.percent } : {}),
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
    select: { id: true },
  });

  for (const { id } of dueForResume) {
    try {
      const svc = await import("~/lib/contracts/service.server");
      await (
        svc.resumeContract as unknown as (
          shopDomain: string,
          contractId: string,
          opts?: { source?: string },
        ) => Promise<unknown>
      )(shop.domain, id, { source: "SYSTEM" });
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

      // One reminder per pause period: any SENT resume_reminder since this
      // pause began means we already reminded.
      const dedupeSince =
        contract.pausedAt ?? new Date(now.getTime() - 180 * 86_400_000);
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
