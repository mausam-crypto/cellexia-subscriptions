import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { escapeHtml } from "~/lib/portal/layout.server";

/**
 * Price lock + price-change surfaces (v1.28.0, P4.6).
 *
 *  - "Member price · locked" pill: the contract is `grandfatheredPricing`
 *    (a GRANDFATHER price-change batch stamped it — every later propagation
 *    skips it) AND no price-change notice is pending against it. The pill
 *    claims exactly what the engine guarantees: `sendPriceChangeNotices` and
 *    `applyPriceChangeBatch` both filter `grandfatheredPricing: false`.
 *  - "You pay {member} instead of {one_off} per order": only when EVERY
 *    recurring line mirrors a compare-at price above its plan price — a
 *    comparison of mirrored catalog facts, never a charge figure (the charge
 *    figure is estimateNextCharge's).
 *  - Price-change banner: a PROPAGATE_WITH_NOTICE batch this contract was
 *    NOTICE_SENT for, still NOTICE_SENT (not applied to this contract), with
 *    an effective date. The banner restates the notice email's own figures
 *    (catalog old → new price per changed line, from the batch items) — it
 *    never predicts the post-change contract total, which the apply engine
 *    derives per line at apply time (ongoing discount / proportional).
 *
 * Every read is contained: a failed lookup renders no pill and no banner.
 */

export interface PriceChangeNotice {
  batchId: string;
  effectiveAt: Date;
  currencyCode: string;
  changes: Array<{
    variantId: string;
    title: string;
    oldPriceCents: number;
    newPriceCents: number;
  }>;
}

interface PriceLockContract {
  id: string;
  currencyCode: string;
  grandfatheredPricing?: boolean;
  lines: Array<{
    variantId: string;
    title: string;
    quantity: number;
    currentPriceCents: number;
    compareAtPriceCents?: number | null;
    isGift?: boolean;
    isOneTimeAddon?: boolean;
  }>;
}

/**
 * Pending price change for the contract: the newest NOTICE_SENT batch the
 * contract received a notice for and has not been APPLIED under, whose
 * effective date is known. Null when none, or on any read failure.
 */
export async function loadPendingPriceChange(
  contract: PriceLockContract,
  shopCurrency: string,
): Promise<PriceChangeNotice | null> {
  try {
    const outcomes = await prisma.priceChangeContractOutcome.findMany({
      where: { contractId: contract.id, status: { in: ["NOTICE_SENT", "APPLIED"] } },
      select: { batchId: true, status: true },
    });
    if (outcomes.length === 0) return null;
    const applied = new Set(
      outcomes.filter((o) => o.status === "APPLIED").map((o) => o.batchId),
    );
    const noticed = [
      ...new Set(
        outcomes
          .filter((o) => o.status === "NOTICE_SENT" && !applied.has(o.batchId))
          .map((o) => o.batchId),
      ),
    ];
    if (noticed.length === 0) return null;
    const batches = await prisma.priceChangeBatch.findMany({
      where: { id: { in: noticed }, status: "NOTICE_SENT", effectiveAt: { not: null } },
      orderBy: { effectiveAt: "asc" },
      select: { id: true, effectiveAt: true, items: true, currencyCode: true, status: true },
    });
    for (const batch of batches) {
      if (!batch.effectiveAt) continue;
      const currency = batch.currencyCode ?? shopCurrency;
      // Currency guard mirrors the notice/apply engines: foreign-currency
      // batches were never sent to (nor applied on) this contract.
      if (currency !== contract.currencyCode) continue;
      const items = Array.isArray(batch.items)
        ? (batch.items as Array<Record<string, unknown>>)
        : [];
      const byVariant = new Map<string, { oldPriceCents: number; newPriceCents: number }>();
      for (const it of items) {
        if (
          typeof it.variantId === "string" &&
          typeof it.oldPriceCents === "number" &&
          typeof it.newPriceCents === "number"
        ) {
          byVariant.set(it.variantId, {
            oldPriceCents: it.oldPriceCents,
            newPriceCents: it.newPriceCents,
          });
        }
      }
      const changes: PriceChangeNotice["changes"] = [];
      const seen = new Set<string>();
      for (const l of contract.lines) {
        if (l.isGift || l.isOneTimeAddon) continue;
        const item = byVariant.get(l.variantId);
        if (!item || seen.has(l.variantId)) continue;
        seen.add(l.variantId);
        changes.push({ variantId: l.variantId, title: l.title, ...item });
      }
      if (changes.length === 0) continue;
      // An effective date already passed with the batch still NOTICE_SENT
      // means the apply is late/failed for this contract — the notice still
      // stands (the price WILL move when the merchant applies), so keep it.
      return {
        batchId: batch.id,
        effectiveAt: batch.effectiveAt,
        currencyCode: currency,
        changes,
      };
    }
    return null;
  } catch (err) {
    console.error("[portal] pending price change read failed", contract.id, err);
    return null;
  }
}

export interface PriceLockView {
  /** Show the "Member price · locked" pill. */
  locked: boolean;
  /** "You pay {member} instead of {one_off} per order" inputs, or null. */
  saving: { memberCents: number; oneOffCents: number } | null;
  pending: PriceChangeNotice | null;
}

/** Pure: derive the pill / saving line from mirrored fields. */
export function priceLockView(
  contract: PriceLockContract,
  pending: PriceChangeNotice | null,
): PriceLockView {
  const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
  let saving: PriceLockView["saving"] = null;
  if (
    recurring.length > 0 &&
    recurring.every(
      (l) => l.compareAtPriceCents != null && l.compareAtPriceCents > l.currentPriceCents,
    )
  ) {
    const memberCents = recurring.reduce((s, l) => s + l.currentPriceCents * l.quantity, 0);
    const oneOffCents = recurring.reduce(
      (s, l) => s + (l.compareAtPriceCents ?? 0) * l.quantity,
      0,
    );
    if (oneOffCents > memberCents) saving = { memberCents, oneOffCents };
  }
  return {
    locked: contract.grandfatheredPricing === true && pending == null,
    saving,
    pending,
  };
}

/** Pill for the items-card header (empty string when not locked). */
export function priceLockPillHtml(locale: string, view: PriceLockView): string {
  if (!view.locked) return "";
  return `<span class="cxs-chip cxs-chip--active cxs-price-lock">${escapeHtml(t(locale, "portal.price.locked_pill"))}</span>`;
}

/** "You pay … instead of … per order" line (empty string when unknown). */
export function priceSavingLineHtml(
  locale: string,
  currency: string,
  view: PriceLockView,
): string {
  if (!view.saving) return "";
  return `<p class="cxs-muted cxs-small cxs-price-saving" style="margin:0 0 10px">${escapeHtml(
    t(locale, "portal.price.saving_line", {
      member: formatMoney(view.saving.memberCents, currency, locale),
      one_off: formatMoney(view.saving.oneOffCents, currency, locale),
    }),
  )}</p>`;
}
