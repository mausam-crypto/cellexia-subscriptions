import { t } from "~/lib/i18n/i18n.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { mailtoHref, type SupportChannels } from "./channels.server";
import { SUPPORT_MESSAGE_MAX, SUPPORT_TOPICS, type SupportTopic } from "./request.server";

/**
 * The Get-help card (v1.28.0, P5.1) — one HTML builder for every surface:
 * the Account page, the bottom of every subscription page, the payment-issue
 * banner's "Get help" anchor target, and (inline, framed by the save card)
 * the cancel-flow SUPPORT/EDUCATION cards. Pure: the route hands in the
 * resolved channels, the form target and its hidden fields.
 *
 * Honesty: only channels that resolved render (no dead mailto:); the SLA
 * line names settings.support.slaBusinessDays; the privacy line says exactly
 * what happens to the message (team + Klaviyo profile — see the copy).
 */

export interface SupportCardInput {
  locale: string;
  channels: SupportChannels;
  /** `/apps/cellexia-subs/api/support` (or the cancel-flow saves action). */
  formAction: string;
  /** Hidden inputs INCLUDING contractId / _csrf / return_to (or the cancel-flow's). */
  hiddenFields: string;
  /** Preselected topic (the dunning banner passes PAYMENT, cancel SUPPORT passes DELIVERY…). */
  topic?: SupportTopic | null;
  /** Order picker rows (already labelled) — omitted/empty ⇒ no picker. */
  orders?: Array<{ id: string; label: string }>;
  /** Contract is ACTIVE with a next order — the push-back checkbox is offered. */
  allowPushBack: boolean;
  /** Which subscription this form is about, when the page shows several. */
  contractPicker?: Array<{ id: string; label: string }> | null;
  /** DOM id (anchor target of the banner's "Get help"). */
  id?: string;
  /** Card heading + intro override keys (cancel flow reuses its own copy). */
  titleKey?: string;
  introKey?: string;
  /** Submit button label key. */
  ctaKey?: string;
  /** Wrap in a .cxs-card (default) or render bare (inside another card). */
  bare?: boolean;
  /** Prefilled message (cancel flow: the reason detail the customer typed). */
  message?: string | null;
}

/** Channel buttons + hours line — reused on the saved page and emails. */
export function supportChannelsHtml(
  locale: string,
  channels: SupportChannels,
  subject?: string | null,
): string {
  const btns: string[] = [];
  if (channels.email) {
    btns.push(
      `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${escapeHtml(mailtoHref(channels.email, subject ?? null))}">${escapeHtml(t(locale, "portal.support.email_cta"))}</a>`,
    );
  }
  if (channels.whatsappHref) {
    btns.push(
      `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${escapeHtml(channels.whatsappHref)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.support.whatsapp_cta"))}</a>`,
    );
  }
  if (channels.chatUrl) {
    btns.push(
      `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${escapeHtml(channels.chatUrl)}" target="_blank" rel="noopener">${escapeHtml(t(locale, "portal.support.chat_cta"))}</a>`,
    );
  }
  if (btns.length === 0 && !channels.hoursNote) return "";
  const hours = channels.hoursNote
    ? `<p class="cxs-muted cxs-small cxs-support__hours">${escapeHtml(t(locale, "portal.support.hours", { hours: channels.hoursNote }))}</p>`
    : "";
  return `${btns.length ? `<div class="cxs-support__channels">${btns.join("")}</div>` : ""}${hours}`;
}

export function supportCardHtml(input: SupportCardInput): string {
  const { locale, channels } = input;
  const id = input.id ?? "cxs-support";
  const title = t(locale, input.titleKey ?? "portal.support.title");
  const intro = t(locale, input.introKey ?? "portal.support.intro");
  const cta = t(locale, input.ctaKey ?? "portal.support.send");
  const selected = input.topic ?? null;

  const topicOptions = SUPPORT_TOPICS.map(
    (topic) =>
      `<option value="${topic}"${topic === selected ? " selected" : ""}>${escapeHtml(t(locale, `portal.support.topic.${topic.toLowerCase()}`))}</option>`,
  ).join("");

  const contractPicker =
    input.contractPicker && input.contractPicker.length > 1
      ? `<div class="cxs-field"><label class="cxs-label" for="${id}-contract">${escapeHtml(t(locale, "portal.support.contract_label"))}</label><select class="cxs-select" name="contractId" id="${id}-contract">${input.contractPicker
          .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
          .join("")}</select></div>`
      : "";

  const orderPicker =
    input.orders && input.orders.length > 0
      ? `<div class="cxs-field"><label class="cxs-label" for="${id}-order">${escapeHtml(t(locale, "portal.support.order_label"))}</label><select class="cxs-select" name="order_ref" id="${id}-order"><option value="">${escapeHtml(t(locale, "portal.support.order_none"))}</option>${input.orders
          .map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`)
          .join("")}</select></div>`
      : "";

  // The row is server-hidden unless Delivery is preselected and revealed by the
  // layout script on topic change; without JS the <noscript> rule reveals it so
  // a customer can still tick it (the server ignores push_back for other topics).
  const pushBack = input.allowPushBack
    ? `<label class="cxs-check"${selected === "DELIVERY" ? "" : " hidden"} data-cellexia-support-delivery><input type="checkbox" name="push_back" value="1"><span>${escapeHtml(t(locale, "portal.support.push_back"))}<br><span class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.support.push_back_hint"))}</span></span></label><noscript><style>.cxs-check[data-cellexia-support-delivery][hidden]{display:flex}</style></noscript>`
    : "";

  const sla = t(
    locale,
    channels.slaBusinessDays === 1
      ? "portal.support.sla_one"
      : "portal.support.sla_other",
    { days: channels.slaBusinessDays },
  );

  const form = `<form method="post" action="${escapeHtml(input.formAction)}" class="cxs-support__form">
    ${input.hiddenFields}
    ${contractPicker}
    <div class="cxs-field"><label class="cxs-label" for="${id}-topic">${escapeHtml(t(locale, "portal.support.topic_label"))}</label><select class="cxs-select" name="topic" id="${id}-topic" data-cellexia-support-topic>${topicOptions}</select></div>
    ${orderPicker}
    <div class="cxs-field"><label class="cxs-label" for="${id}-message">${escapeHtml(t(locale, "portal.support.message_label"))}</label><textarea class="cxs-textarea" name="message" id="${id}-message" maxlength="${SUPPORT_MESSAGE_MAX}" required placeholder="${escapeHtml(t(locale, "portal.support.message_placeholder"))}">${escapeHtml(input.message ?? "")}</textarea></div>
    ${pushBack}
    <button type="submit" class="cxs-btn cxs-btn--full">${escapeHtml(cta)}</button>
    <p class="cxs-muted cxs-small" style="margin:8px 0 0">${escapeHtml(sla)}</p>
    <p class="cxs-muted cxs-small cxs-support__privacy">${escapeHtml(t(locale, "portal.support.privacy"))}</p>
  </form>`;

  const inner = `<h2 style="font-size:18px;margin:0 0 6px">${escapeHtml(title)}</h2>
  <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(intro)}</p>
  ${supportChannelsHtml(locale, channels)}
  <hr class="cxs-divider">
  ${form}`;

  return input.bare
    ? `<div class="cxs-support" id="${escapeHtml(id)}">${inner}</div>`
    : `<div class="cxs-card cxs-support" id="${escapeHtml(id)}">${inner}</div>`;
}
