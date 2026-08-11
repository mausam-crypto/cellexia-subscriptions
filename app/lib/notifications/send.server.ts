import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  buildActionLinkBundle,
  buildPortalUrl,
} from "~/lib/magiclinks/builder.server";
import { enqueue } from "~/lib/klaviyo/outbox.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import {
  contractProfileAttrs,
  contractSnapshotProperties,
  type ContractWithLines,
} from "~/lib/klaviyo/events-map.server";
import {
  renderEmail,
  TEMPLATES,
  type EmailContentOverride,
  type TemplateKey,
  type TemplateVars,
} from "./templates.server";
import { EMAIL_CATALOG } from "./catalog.server";
import { sendEmail } from "./mailer.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Notification router.
 *
 * Primary path: enqueue a Klaviyo event (metric from the template registry) so
 * Klaviyo flows own delivery, branding and channel consent. Additionally,
 * critical templates (otp_code, threeds_action, admin_alert, import_summary)
 * are sent via direct SMTP so they still arrive when Klaviyo is down —
 * and otp_code is ONLY ever sent direct (codes never enter a marketing tool).
 *
 * When KLAVIYO_PRIVATE_API_KEY is unset the outbox cannot deliver anything
 * (rows would sit PENDING until aged out), so metric templates do NOT enqueue:
 * EMAIL templates fall back to direct SMTP — the launch checklist's promise —
 * and SMS templates are SUPPRESSED (reason "klaviyo_unconfigured"), because a
 * SENT log row here advances dunning ladders and cycle dedupe, and must never
 * be written unless something was actually handed to a working transport.
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
  /** Outbox row carrying the delivery — lets the flush flip this row to
   * FAILED (and log notification.failed) when the row later goes DEAD. */
  outboxId?: string | null;
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
        outboxId: entry.outboxId ?? null,
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
    // ── Ownership gate: never message another app's customer ────────────────
    // The shop may run a second subscription app; its contracts arrive on the
    // same webhooks and get mirrored here. A message about a subscription we
    // do not manage is at best confusing and at worst a duplicate of the other
    // app's own email. UNKNOWN fails safe the same way. Admin-facing templates
    // (admin_alert, import_summary) go to the merchant, not the subscriber, so
    // they stay allowed even when they reference a foreign contract.
    if (
      contract &&
      !ADMIN_TEMPLATES.has(input.template) &&
      !isBillableOwnership(contract.ownership)
    ) {
      await writeLog({
        shopId: input.shopId,
        contractId: contract.id,
        email: input.email ?? contract.email,
        phone: input.phone ?? contract.phone,
        channel: tmpl.channel,
        template: input.template,
        status: "SUPPRESSED",
        klaviyoEventName: tmpl.klaviyoMetric || null,
        payload: {
          cycleIndex,
          reason: "foreign_contract",
          ownership: contract.ownership,
        },
      });
      result.status = "SUPPRESSED";
      return result;
    }
    // ── Demo gate: the portal-preview fixture is not a customer ─────────────
    // Every sweep is supposed to filter on isDemo: false, but this is the
    // last line of defense when one forgets (the pre-expiry sweep once did):
    // the fixture carries a plausible ACTIVE/OURS shape with a fake card and
    // a @cellexia-demo.invalid email, so a missed filter would push bogus
    // Klaviyo profiles/events and guaranteed bounces. Admin-facing templates
    // stay allowed — they go to the merchant, not the fixture's address.
    if (contract?.isDemo && !ADMIN_TEMPLATES.has(input.template)) {
      await writeLog({
        shopId: input.shopId,
        contractId: contract.id,
        email: input.email ?? contract.email,
        phone: input.phone ?? contract.phone,
        channel: tmpl.channel,
        template: input.template,
        status: "SUPPRESSED",
        klaviyoEventName: tmpl.klaviyoMetric || null,
        payload: { cycleIndex, reason: "demo_contract" },
      });
      result.status = "SUPPRESSED";
      return result;
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

    // ── Per-template overrides (v1.16.0, admin Emails tab) ──────────────────
    // enabled:false suppresses like a channel toggle (critical templates
    // bypass, same rule); non-empty subject/body replace the built-in copy in
    // the rendering below. Failure-contained: a broken settings read must
    // never block a send — overrides just don't apply.
    let contentOverride: EmailContentOverride | null = null;
    try {
      const emailsSettings = await getSetting(input.shopId, "emails");
      const override = emailsSettings.templates[input.template];
      if (override) {
        if (!tmpl.critical && override.enabled === false) {
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            phone,
            channel: tmpl.channel,
            template: input.template,
            status: "SUPPRESSED",
            klaviyoEventName: tmpl.klaviyoMetric || null,
            payload: { cycleIndex, reason: "template_disabled" },
          });
          result.status = "SUPPRESSED";
          return result;
        }
        // Copy overrides apply only where the catalog says the template is
        // customizable — system mail (otp_code, admin_alert, import_summary)
        // keeps its built-in copy no matter what a stored row claims.
        if (EMAIL_CATALOG[input.template].customizable) {
          contentOverride = { subject: override.subject, body: override.body };
        }
      }
    } catch (err) {
      console.error("[notifications] emails settings read failed", err);
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

    // Ready-rendered content for Klaviyo flows (v1.16.0): the merchant's
    // in-app copy (or the built-in catalog copy) with every placeholder —
    // one-tap links included — already substituted, so a flow can render
    // `{{ event.content_html }}` and stay in sync with the Emails tab.
    // Rendered from the full property set (snapshot + link bundle), caller
    // vars winning on collisions — the same variable set the SMTP fallback
    // renders from. Computed BEFORE attaching so the content never
    // recursively re-enters its own variable pool. otp_code never reaches
    // here (no metric); admin templates carry no metric either.
    const contentVars: TemplateVars = {
      ...toTemplateVars(properties),
      ...toTemplateVars(vars),
    };
    if (tmpl.klaviyoMetric) {
      const content = renderEmail(
        input.template,
        locale,
        contentVars,
        contentOverride,
      );
      properties.content_text = content.text;
      if (tmpl.channel === "EMAIL") {
        properties.content_subject = content.subject;
        properties.content_html = content.html;
      }
    }

    const channelsUsed: string[] = [];
    let directError: string | null = null;

    /**
     * Renders the template and delivers it via direct SMTP, logging EMAIL
     * SENT/FAILED. Shared by the critical path (always direct, Klaviyo up or
     * not) and the Klaviyo-unconfigured fallback for lifecycle email below.
     *
     * The SENT payload carries the caller's vars ONLY for templates that have
     * a Klaviyo metric: their persistent dedupe queries (dunning's
     * `payload.vars.dunning_dedupe`, card_expiring's `payload.vars.dedupe_key`)
     * normally match the KLAVIYO_EVENT row — when the key is unconfigured that
     * row does not exist, so this row must carry the keys instead. Metric-less
     * templates (otp_code, admin_alert, import_summary) keep a vars-free
     * payload: OTP codes must never be persisted in NotificationLog.
     */
    const deliverDirectEmail = async (to: string): Promise<void> => {
      // Render from the same variable set a Klaviyo flow would receive:
      // `properties` carries the caller's vars PLUS the contract snapshot,
      // portal_url and — for LINK_BUNDLE_TEMPLATES — the one-tap magic-link
      // bundle (skip_url, delay_3w_url, …). The locale bodies reference those
      // placeholders unconditionally ("Skip this order: {skip_url}"), so
      // rendering from `vars` alone shipped literal "{skip_url}" text in every
      // fallback reminder. Caller vars win on any key collision. The link
      // bundle stays OUT of `logPayload` below — magic-link tokens must never
      // be persisted in NotificationLog.
      const templateVars: TemplateVars = {
        ...contentVars,
      };
      const logPayload: Record<string, unknown> = tmpl.klaviyoMetric
        ? { cycleIndex, vars: toTemplateVars(vars) }
        : { cycleIndex };
      try {
        const rendered = renderEmail(
          input.template,
          locale,
          templateVars,
          contentOverride,
        );
        await sendEmail({
          shopId: input.shopId,
          to,
          subject: rendered.subject,
          html: rendered.html,
        });
        result.directEmailSent = true;
        channelsUsed.push("EMAIL");
        await writeLog({
          shopId: input.shopId,
          contractId: contract?.id,
          email: to,
          channel: "EMAIL",
          template: input.template,
          status: "SENT",
          payload: logPayload,
        });
      } catch (err) {
        directError = err instanceof Error ? err.message : String(err);
        await writeLog({
          shopId: input.shopId,
          contractId: contract?.id,
          email: to,
          channel: "EMAIL",
          template: input.template,
          status: "FAILED",
          error: directError,
          payload: { cycleIndex },
        });
      }
    };

    // ── Primary path: Klaviyo event (never for otp_code) ────────────────────
    if (tmpl.klaviyoMetric && input.template !== "otp_code") {
      if (await isKlaviyoConfigured(input.shopId)) {
        const profileAttrs: Record<string, unknown> = contract
          ? contractProfileAttrs(contract)
          : {};

        const outboxRow = await enqueue(input.shopId, {
          eventName: tmpl.klaviyoMetric,
          email,
          phone,
          profileAttrs,
          properties,
        });
        if (outboxRow) {
          result.klaviyoEnqueued = true;
          channelsUsed.push("KLAVIYO_EVENT");
          // SENT means "riding a live outbox row" — the row id makes that
          // claim falsifiable: if the row later goes DEAD, the flush flips
          // this log row to FAILED and logs notification.failed, so cycle
          // dedupe and dunning ladders stop trusting a delivery that never
          // happened (the ARCHITECTURE promise: never logged SENT
          // undelivered).
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            phone,
            channel: "KLAVIYO_EVENT",
            template: input.template,
            status: "SENT",
            klaviyoEventName: tmpl.klaviyoMetric,
            outboxId: outboxRow.id,
            payload: { cycleIndex, vars: toTemplateVars(vars) },
          });
        } else {
          // The enqueue itself was dropped (DB error): no row will ever
          // deliver this, so a SENT log here would be the exact
          // logged-SENT-but-undelivered lie the outboxId reconciliation
          // exists to prevent. Log FAILED and let the outcome event below
          // report notification.failed.
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            phone,
            channel: "KLAVIYO_EVENT",
            template: input.template,
            status: "FAILED",
            klaviyoEventName: tmpl.klaviyoMetric,
            error: "Klaviyo outbox enqueue failed",
            payload: { cycleIndex },
          });
        }
      } else if (!tmpl.critical) {
        // No Klaviyo key is configured (Settings or env). Enqueueing anyway would strand
        // the row PENDING (flushKlaviyoOutbox skips entirely without the key)
        // while this router reported SENT — dunning ladders would advance,
        // cycle dedupe would stick, and the customer would receive nothing;
        // and if the key appeared weeks later the stale backlog would fire
        // flows on long-resolved moments. Instead, EMAIL templates fall back
        // to direct SMTP — exactly what the launch checklist promises — and
        // SMS, which has no SMTP equivalent, is SUPPRESSED honestly so ladder
        // cursors advance without pretending delivery happened.
        if (tmpl.channel === "EMAIL" && email) {
          await deliverDirectEmail(email);
        } else {
          await writeLog({
            shopId: input.shopId,
            contractId: contract?.id,
            email,
            phone,
            channel: tmpl.channel,
            template: input.template,
            status: "SUPPRESSED",
            klaviyoEventName: tmpl.klaviyoMetric || null,
            payload: { cycleIndex, reason: "klaviyo_unconfigured" },
          });
          result.status = "SUPPRESSED";
          return result;
        }
      }
      // Critical templates without the key fall through to the direct-SMTP
      // branch below — they already deliver via SMTP either way, and skipping
      // the enqueue keeps a later-configured key from firing a stale flow.
    }

    // ── Direct SMTP for critical templates ──────────────────────────────────
    if (tmpl.critical) {
      if (email) {
        await deliverDirectEmail(email);
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
