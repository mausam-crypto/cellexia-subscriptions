import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  buildActionLinkBundle,
  buildPortalUrl,
} from "~/lib/magiclinks/builder.server";
import { enqueue } from "~/lib/klaviyo/outbox.server";
import {
  contractProfileAttrs,
  contractSnapshotProperties,
  type ContractWithLines,
} from "~/lib/klaviyo/events-map.server";
import {
  renderEmail,
  TEMPLATES,
  type TemplateKey,
  type TemplateVars,
} from "./templates.server";
import { sendEmail } from "./mailer.server";

/**
 * Notification router.
 *
 * Primary path: enqueue a Klaviyo event (metric from the template registry) so
 * Klaviyo flows own delivery, branding and channel consent. Additionally,
 * critical templates (otp_code, threeds_action, admin_alert, import_summary)
 * are sent via direct SMTP so they still arrive when Klaviyo is down —
 * and otp_code is ONLY ever sent direct (codes never enter a marketing tool).
 *
 * Every send/suppression/failure lands in NotificationLog; every outcome logs
 * a notification.sent / notification.failed event. Never throws.
 */

/** Templates whose Klaviyo properties carry the one-tap magic-link bundle. */
const LINK_BUNDLE_TEMPLATES: ReadonlySet<TemplateKey> = new Set<TemplateKey>([
  "upcoming_order",
  "payment_failed_1",
  "payment_failed_2",
  "payment_failed_3",
  "payment_failed_sms",
  "card_expiring",
  "threeds_action",
  "resume_reminder",
  "winback_soft",
  "winback_perk",
  "winback_discount",
]);

/** Merchant-facing templates: recipients come from settings, not a contract. */
const ADMIN_TEMPLATES: ReadonlySet<TemplateKey> = new Set<TemplateKey>([
  "admin_alert",
  "import_summary",
]);

/**
 * Templates still allowed while launch mode is SETUP. Everything else is
 * SUPPRESSED (reason "setup_mode") — installing the app must never message a
 * customer until the merchant goes live. OTP codes stay allowed so the admin
 * can log in to preview the portal; the other two are merchant-facing.
 */
export const SETUP_ALLOWED_TEMPLATES: ReadonlySet<TemplateKey> = new Set<TemplateKey>([
  "otp_code",
  "admin_alert",
  "import_summary",
]);

export interface SendNotificationInput {
  shopId: string;
  contractId?: string | null;
  template: TemplateKey;
  locale?: string | null;
  email?: string | null;
  phone?: string | null;
  vars?: Record<string, unknown>;
}

export interface SendNotificationResult {
  status: "SENT" | "FAILED" | "SUPPRESSED";
  klaviyoEnqueued: boolean;
  directEmailSent: boolean;
}

function toTemplateVars(vars: Record<string, unknown>): TemplateVars {
  const out: TemplateVars = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
    else if (typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function extractCycleIndex(vars: Record<string, unknown>): number | undefined {
  const v = vars.cycleIndex ?? vars.cycle_index;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function writeLog(entry: {
  shopId: string;
  contractId?: string | null;
  email?: string | null;
  phone?: string | null;
  channel: string;
  template: string;
  status: string;
  klaviyoEventName?: string | null;
  error?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    // JSON round-trip drops `undefined` values (Prisma rejects them in Json).
    const payload = JSON.parse(JSON.stringify(entry.payload ?? {})) as object;
    await prisma.notificationLog.create({
      data: {
        shopId: entry.shopId,
        contractId: entry.contractId ?? null,
        email: entry.email ?? null,
        phone: entry.phone ?? null,
        channel: entry.channel,
        template: entry.template,
        status: entry.status,
        klaviyoEventName: entry.klaviyoEventName ?? null,
        error: entry.error ?? null,
        payload,
      },
    });
  } catch (err) {
    console.error("[notifications] NotificationLog write failed", err);
  }
}

export async function sendNotification(
  input: SendNotificationInput,
): Promise<SendNotificationResult> {
  const result: SendNotificationResult = {
    status: "FAILED",
    klaviyoEnqueued: false,
    directEmailSent: false,
  };
  const tmpl = TEMPLATES[input.template];
  const vars = input.vars ?? {};
  const cycleIndex = extractCycleIndex(vars);

  try {
    // ── SETUP gate: nothing customer-facing sends before go-live ────────────
    // Lazy import avoids a launch↔notifications cycle. A failed mode read
    // falls through to the outer catch (no send happens — fail dark).
    if (!SETUP_ALLOWED_TEMPLATES.has(input.template)) {
      const { isSetupMode } = await import("~/lib/launch/launch.server");
      if (await isSetupMode(input.shopId)) {
        await writeLog({
          shopId: input.shopId,
          contractId: input.contractId ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          channel: tmpl.channel,
          template: input.template,
          status: "SUPPRESSED",
          klaviyoEventName: tmpl.klaviyoMetric || null,
          payload: { cycleIndex, reason: "setup_mode" },
        });
        result.status = "SUPPRESSED";
        return result;
      }
    }

    // ── Resolve contract, recipient, locale ─────────────────────────────────
    let contract: ContractWithLines | null = null;
    if (input.contractId) {
      contract = await prisma.subscriptionContract.findUnique({
        where: { id: input.contractId },
        include: { lines: true },
      });
    }
    const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
    const tz = shop?.ianaTimezone ?? "Europe/London";
    const locale = input.locale ?? contract?.locale ?? "en";

    let email = input.email ?? contract?.email ?? null;
    const phone = input.phone ?? contract?.phone ?? null;

    if (ADMIN_TEMPLATES.has(input.template) && !input.email) {
      const alerts = await getSetting(input.shopId, "alerts");
      const recipients = alerts.emailTo.filter(Boolean);
      email = recipients.length
        ? recipients.join(", ")
        : (shop?.contactEmail ?? null);
    }

    if (!email && !phone) {
      await writeLog({
        shopId: input.shopId,
        contractId: contract?.id,
        channel: tmpl.channel,
        template: input.template,
        status: "FAILED",
        error: "No recipient (email/phone) could be resolved",
        payload: { cycleIndex, vars: toTemplateVars(vars) },
      });
      return result;
    }

    // ── Channel toggles (critical templates bypass suppression) ─────────────
    if (!tmpl.critical) {
      const notif = await getSetting(input.shopId, "notifications");
      const channelOn =
        tmpl.channel === "SMS" ? notif.channels.sms : notif.channels.email;
      if (!channelOn) {
        await writeLog({
          shopId: input.shopId,
          contractId: contract?.id,
          email,
          phone,
          channel: tmpl.channel,
          template: input.template,
          status: "SUPPRESSED",
          klaviyoEventName: tmpl.klaviyoMetric || null,
          payload: { cycleIndex, reason: "channel_disabled" },
        });
        result.status = "SUPPRESSED";
        return result;
      }
    }

    // ── Build Klaviyo properties: vars + contract snapshot + action links ───
    const properties: Record<string, unknown> = {
      ...vars,
      template: input.template,
    };
    if (contract) {
      Object.assign(properties, await contractSnapshotProperties(contract, tz));
    } else if (!properties.portal_url) {
      try {
        properties.portal_url = await buildPortalUrl(input.shopId);
      } catch {
        // shop without domain (tests) — flows just miss the link
      }
    }
    if (contract && LINK_BUNDLE_TEMPLATES.has(input.template)) {
      try {
        const addonVariantId =
          typeof vars.addon_variant_id === "string"
            ? vars.addon_variant_id
            : undefined;
        const bundle = await buildActionLinkBundle({
          contractId: contract.id,
          customerId: contract.customerId,
          email: email ?? undefined,
          createdVia: "KLAVIYO_FLOW",
          addonVariantId,
        });
        Object.assign(properties, bundle);
      } catch (err) {
        console.error(
          "[notifications] action link bundle failed",
          contract.id,
          err,
        );
      }
    }

    const channelsUsed: string[] = [];
    let directError: string | null = null;

    // ── Primary path: Klaviyo event (never for otp_code) ────────────────────
    if (tmpl.klaviyoMetric && input.template !== "otp_code") {
      const profileAttrs: Record<string, unknown> = contract
        ? contractProfileAttrs(contract)
        : {};

      await enqueue(input.shopId, {
        eventName: tmpl.klaviyoMetric,
        email,
        phone,
        profileAttrs,
        properties,
      });
      result.klaviyoEnqueued = true;
      channelsUsed.push("KLAVIYO_EVENT");
      await writeLog({
        shopId: input.shopId,
        contractId: contract?.id,
        email,
        phone,
        channel: "KLAVIYO_EVENT",
        template: input.template,
        status: "SENT",
        klaviyoEventName: tmpl.klaviyoMetric,
        payload: { cycleIndex, vars: toTemplateVars(vars) },
      });
    }

    // ── Direct SMTP for critical templates ──────────────────────────────────
    if (tmpl.critical) {
      if (email) {
        const templateVars = toTemplateVars(vars);
        if (!templateVars.portal_url && typeof properties.portal_url === "string") {
          templateVars.portal_url = properties.portal_url;
        }
        try {
          const rendered = renderEmail(input.template, locale, templateVars);
          await sendEmail({
            to: email,
            subject: rendered.subject,
            html: rendered.html,
          });
          result.directEmailSent = true;
          channelsUsed.push("EMAIL");
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            channel: "EMAIL",
            template: input.template,
            status: "SENT",
            payload: { cycleIndex },
          });
        } catch (err) {
          directError = err instanceof Error ? err.message : String(err);
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            channel: "EMAIL",
            template: input.template,
            status: "FAILED",
            error: directError,
            payload: { cycleIndex },
          });
        }
      } else {
        directError = "Critical template but no email recipient";
      }
    }

    const anySent = result.klaviyoEnqueued || result.directEmailSent;
    result.status = anySent ? "SENT" : "FAILED";

    await logEvent({
      shopId: input.shopId,
      contractId: contract?.id,
      customerId: contract?.customerId,
      email,
      type: anySent ? "notification.sent" : "notification.failed",
      source: "SYSTEM",
      payload: {
        template: input.template,
        klaviyoMetric: tmpl.klaviyoMetric || null,
        channels: channelsUsed,
        ...(cycleIndex !== undefined ? { cycleIndex } : {}),
        ...(directError ? { error: directError } : {}),
      },
    });

    return result;
  } catch (err) {
    console.error("[notifications] send failed", input.template, err);
    await writeLog({
      shopId: input.shopId,
      contractId: input.contractId ?? null,
      email: input.email ?? null,
      channel: tmpl.channel,
      template: input.template,
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
      payload: { cycleIndex },
    });
    await logEvent({
      shopId: input.shopId,
      contractId: input.contractId ?? null,
      email: input.email ?? null,
      type: "notification.failed",
      source: "SYSTEM",
      payload: {
        template: input.template,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return result;
  }
}

/**
 * Cycle-level dedupe: has a template already been SENT for this contract and
 * billing cycle? Callers (e.g. the upcoming-order job) use this to guarantee
 * one reminder per cycle even across restarts. Requires callers to pass
 * `cycleIndex` (or `cycle_index`) in `vars` when sending.
 */
export async function hasSentForCycle(
  contractId: string,
  template: TemplateKey,
  cycleIndex: number,
): Promise<boolean> {
  const row = await prisma.notificationLog.findFirst({
    where: {
      contractId,
      template,
      status: "SENT",
      payload: { path: ["cycleIndex"], equals: cycleIndex },
    },
    select: { id: true },
  });
  return row !== null;
}
