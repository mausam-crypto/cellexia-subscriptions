import prisma from "~/db.server";
import { formatShopDate } from "~/lib/dates.server";
import { contractFrequency, formatFrequency } from "~/lib/frequency";
import { t } from "~/lib/i18n/i18n.server";
import { buildPortalUrl } from "~/lib/magiclinks/builder.server";
import { formatMoney } from "~/lib/money";
import { sendNotification } from "./send.server";

/**
 * Welcome email — `subscription_started` (v1.28.0, P4.5 template half /
 * P5.2 entry point). ONE email per genuinely new contract, from the
 * subscription-created webhook path: what happens next (first order placed,
 * next charge date + amount estimate, the change/skip cut-off), where to
 * manage it (portal link + CTA) and how to reach support.
 *
 * "Genuinely new" = the mirror carries an origin (checkout) order. Imported
 * contracts (admin CSV import → subscriptionContractCreate mutation) and
 * install backfills mirror contracts that were never checked out here — no
 * originOrderId — and their subscribers already have history: welcoming them
 * as new would be a lie and a churn trigger, so they are refused BEFORE the
 * router (no NotificationLog row, no metric). A `contract.imported` event
 * for the contract refuses too, as belt-and-braces for a mirror that later
 * gains an origin order.
 *
 * Dedupe by contract: any SENT or SUPPRESSED `subscription_started` row for
 * the contract means the decision was taken — a webhook replay, the UPDATE
 * catch-up branch or a second create webhook never sends twice. FAILED rows
 * (transport hiccup) do not block a later attempt. ONE exception: a
 * SUPPRESSED row whose payload.reason is `foreign_contract` (the router's
 * ownership gate) is not final — a mirror that landed UNKNOWN at the create
 * moment is proven ours by a later sync, and sync.server.ts re-invokes this
 * from its UNKNOWN→billable heal (bounded by
 * settings.notifications.welcomeHealMaxDays) so the welcome is sent late
 * rather than lost.
 *
 * Every var is pre-composed here (the templates only interpolate): the body
 * never has to branch. Missing facts collapse their line to "" rather than
 * inventing one — no next date → no next line; no support email → no
 * support line. The estimate/timing helpers are the Stage-B ones the portal
 * and the reminder read (estimateNextCharge, editCutoffSync), so this email
 * can never quote a charge amount or cut-off the sweep would not honour.
 *
 * Contained end to end: never throws into the webhook (golden rule — a
 * notification failure never breaks a webhook or billing).
 */

export type SubscriptionStartedOutcome =
  | "sent"
  | "suppressed"
  | "failed"
  | "already_sent"
  | "not_new_contract"
  | "no_contract"
  | "error";

/** Templates' i18n key root. */
const KEY = "email.subscription_started";

export async function maybeSendSubscriptionStarted(
  shopId: string,
  contractId: string,
): Promise<SubscriptionStartedOutcome> {
  try {
    const contract = await prisma.subscriptionContract.findUnique({
      where: { id: contractId },
      include: { lines: true },
    });
    if (!contract || contract.shopId !== shopId) return "no_contract";

    // ── Genuinely new? (imports / backfills carry no origin order) ─────────
    if (!contract.originOrderId) return "not_new_contract";
    const imported = await prisma.subscriberEvent.findFirst({
      where: { shopId, contractId: contract.id, type: "contract.imported" },
      select: { id: true },
    });
    if (imported) return "not_new_contract";

    // ── Once per contract ──────────────────────────────────────────────────
    // SENT and every SUPPRESSED row are final decisions — EXCEPT the router's
    // ownership gate (payload.reason "foreign_contract"): a mirror that
    // landed UNKNOWN at the create moment is suppressed there and may be
    // proven ours by a later sync (the heal in sync.server.ts re-invokes
    // this), so that one reason never blocks. Filtered in JS: a Prisma
    // NOT-on-json-path drops rows lacking the key (SQL NULL), which would
    // hide legitimate SENT/SUPPRESSED rows.
    const priorRows = await prisma.notificationLog.findMany({
      where: {
        contractId: contract.id,
        template: "subscription_started",
        status: { in: ["SENT", "SUPPRESSED"] },
      },
      select: { status: true, payload: true },
    });
    const prior = priorRows.find((row) => {
      if (row.status === "SENT") return true;
      const reason = (row.payload as { reason?: unknown } | null)?.reason;
      return reason !== "foreign_contract";
    });
    if (prior) return "already_sent";

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { ianaTimezone: true },
    });
    const tz = shop?.ianaTimezone ?? "Europe/London";
    const locale = contract.locale;

    // ── Product ────────────────────────────────────────────────────────────
    const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
    const named = recurring.length > 0 ? recurring : contract.lines;
    const firstTitle = named[0]?.title?.trim() || "Cellexia";
    const product =
      named.length > 1
        ? t(locale, `${KEY}.product_multi`, {
            product: firstTitle,
            count: named.length - 1,
          })
        : firstTitle;

    // ── First order line (origin order exists — gated above) ───────────────
    const first_order_line = contract.originOrderName
      ? t(locale, `${KEY}.first_order_line`, {
          order_name: contract.originOrderName,
        })
      : t(locale, `${KEY}.first_order_line_noname`);

    // ── Next charge: date + estimate + cut-off (Stage-B helpers) ──────────
    const freq = contractFrequency(contract);
    const frequency = formatFrequency(
      (key, fvars) => t(locale, key, fvars),
      "every",
      freq,
    );
    let next_line = "";
    let next_date = "";
    let next_date_iso = "";
    let amount = "";
    let changes_line = "";
    let edit_cutoff = "";
    let edit_cutoff_iso = "";
    if (contract.nextBillingDate) {
      next_date = formatShopDate(contract.nextBillingDate, tz, locale);
      next_date_iso = contract.nextBillingDate.toISOString();
      try {
        const { estimateNextCharge } = await import(
          "~/lib/billing/estimate.server"
        );
        const est = await estimateNextCharge(
          { id: shopId, ianaTimezone: tz },
          contract,
          { includeScheduledGifts: false },
        );
        amount = formatMoney(est.totalCents, contract.currencyCode, locale);
      } catch (err) {
        console.error("[subscription_started] estimate failed", contract.id, err);
      }
      next_line = amount
        ? t(locale, `${KEY}.next_line_amount`, { amount, next_date, frequency })
        : t(locale, `${KEY}.next_line`, { next_date, frequency });
      try {
        const { resolveChargeTiming } = await import(
          "~/lib/billing/timing.server"
        );
        const { reminderCutoffVars } = await import(
          "~/lib/billing/reminders.server"
        );
        const timing = await resolveChargeTiming(shopId, tz);
        const cutoff = reminderCutoffVars(locale, contract.nextBillingDate, timing);
        edit_cutoff = cutoff.edit_cutoff;
        edit_cutoff_iso = cutoff.edit_cutoff_iso;
        if (edit_cutoff) {
          changes_line = t(locale, `${KEY}.changes_line`, { edit_cutoff });
        }
      } catch (err) {
        console.error("[subscription_started] cut-off failed", contract.id, err);
      }
    }

    // ── Support line (P5.1 resolver; falls back to nothing, never a dead
    //    address) ────────────────────────────────────────────────────────────
    let support_email = "";
    let support_line = "";
    try {
      const { getSupportChannels } = await import("~/lib/support/channels.server");
      const channels = await getSupportChannels(shopId);
      if (channels.email) {
        support_email = channels.email;
        support_line = t(locale, `${KEY}.support_line`, { support_email });
      }
    } catch (err) {
      console.error("[subscription_started] support channels failed", err);
    }

    // ── Portal CTA (the router also supplies portal_url via the snapshot) ──
    let cta_url = "";
    try {
      cta_url = await buildPortalUrl(shopId, "/");
    } catch {
      // No shop domain (tests / partial install): the body still carries
      // {portal_url} from the router snapshot when resolvable; the CTA
      // button is simply omitted when cta_url is empty.
    }

    const result = await sendNotification({
      shopId,
      contractId: contract.id,
      template: "subscription_started",
      locale,
      vars: {
        product,
        ...(contract.originOrderName ? { order_name: contract.originOrderName } : {}),
        first_order_line,
        next_line,
        next_date,
        next_date_iso,
        amount,
        frequency,
        frequency_weeks: contract.intervalWeeks,
        frequency_unit: freq.unit,
        frequency_count: freq.count,
        edit_cutoff,
        edit_cutoff_iso,
        changes_line,
        support_email,
        support_line,
        ...(cta_url ? { cta_url } : {}),
      },
    });
    if (result.status === "SENT") return "sent";
    if (result.status === "SUPPRESSED") return "suppressed";
    return "failed";
  } catch (err) {
    console.error("[subscription_started] send failed", contractId, err);
    return "error";
  }
}
