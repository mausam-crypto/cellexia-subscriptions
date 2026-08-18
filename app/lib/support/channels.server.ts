import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";

/**
 * Support channels (v1.28.0, P5.1) — the ONE resolver every surface that
 * points a customer at a human reads: the portal Get-help card, the
 * cancel-flow SUPPORT/EDUCATION cards, the mailer's Reply-To and the
 * merchant-bound support-request email.
 *
 * Resolution (settings.support, registry.server.ts):
 *  - email:    setting → Shop.contactEmail (mirrored at install / SHOP_UPDATE)
 *              → null (the email CTA is hidden, never a dead mailto:).
 *  - replyTo:  setting → resolved email → null (no Reply-To header).
 *  - whatsapp: setting normalized to E.164 digits → wa.me link; malformed → null.
 *  - chatUrl:  setting, https:// only → null.
 *  - hoursNote: verbatim.
 *  - replyWithin (v1.29.0): { value, unit, alwaysOn } — the reply promise
 *    every surface phrases through supportReplyPromise() (reply-promise.ts).
 *    A stored settings object that still carries the Stage C
 *    `slaBusinessDays` and no replyWithin* keys is read as
 *    { value: slaBusinessDays, unit: "business_days", alwaysOn: false } —
 *    no migration, the old key stays tolerated by the schema.
 *
 * Contained: any read failure (settings, DB) resolves to the empty channel
 * set — the surfaces render without a contact line rather than 500 (golden
 * rule 9). Never throws.
 */

export type ReplyWithinUnit = "minutes" | "hours" | "business_days";

/** The reply promise as every surface consumes it (see supportReplyPromise). */
export interface ReplyPromise {
  value: number;
  unit: ReplyWithinUnit;
  /** True = the team answers 24/7 (weekends included). */
  alwaysOn: boolean;
}

export const REPLY_WITHIN_UNITS: readonly ReplyWithinUnit[] = Object.freeze([
  "minutes",
  "hours",
  "business_days",
]);

/** Upper bound per unit (a week in minutes / a month in hours / 30 business days). */
export const REPLY_WITHIN_MAX: Readonly<Record<ReplyWithinUnit, number>> = Object.freeze({
  minutes: 10_080,
  hours: 720,
  business_days: 30,
});

export const DEFAULT_REPLY_PROMISE: ReplyPromise = Object.freeze({
  value: 30,
  unit: "minutes",
  alwaysOn: true,
});

export function isReplyWithinUnit(value: unknown): value is ReplyWithinUnit {
  return typeof value === "string" && (REPLY_WITHIN_UNITS as readonly string[]).includes(value);
}

export interface SupportChannels {
  email: string | null;
  replyTo: string | null;
  /** E.164 as stored/normalized ("+41791234567") — display form. */
  whatsapp: string | null;
  /** https://wa.me/<digits> — the tap target; null when whatsapp is null. */
  whatsappHref: string | null;
  chatUrl: string | null;
  hoursNote: string | null;
  replyWithin: ReplyPromise;
  /** True when at least one of email / whatsapp / chatUrl resolved. */
  hasAny: boolean;
}

export const EMPTY_SUPPORT_CHANNELS: SupportChannels = Object.freeze({
  email: null,
  replyTo: null,
  whatsapp: null,
  whatsappHref: null,
  chatUrl: null,
  hoursNote: null,
  replyWithin: DEFAULT_REPLY_PROMISE,
  hasAny: false,
});

/** Loose but safe: one @, no whitespace, no angle brackets / header breaks. */
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function normalizeSupportEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

/**
 * E.164 normalization: strips spaces, dots, dashes and parentheses; accepts a
 * leading "+" or "00"; requires 8–15 digits. Returns "+<digits>" or null.
 */
export function normalizeWhatsapp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/[\s.\-()]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) s = `+${s}`;
  const digits = s.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `+${digits}`;
}

export function normalizeChatUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** `mailto:` href with an RFC 6068-encoded subject (and optional body). */
export function mailtoHref(
  email: string,
  subject?: string | null,
  body?: string | null,
): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  // URLSearchParams encodes spaces as "+", which mail clients read literally;
  // RFC 6068 wants %20.
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${email}${query ? `?${query}` : ""}`;
}

/** `https://wa.me/<digits>` with an optional prefilled text. */
export function whatsappHrefFor(e164: string, text?: string | null): string {
  const digits = e164.replace(/^\+/, "");
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

interface SupportSettingShape {
  email?: unknown;
  replyTo?: unknown;
  whatsapp?: unknown;
  chatUrl?: unknown;
  hoursNote?: unknown;
  replyWithinValue?: unknown;
  replyWithinUnit?: unknown;
  alwaysOn?: unknown;
  /** Stage C (v1.28.0) key — read only when no replyWithin* key is stored. */
  slaBusinessDays?: unknown;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Pure: the reply promise out of a stored/parsed support settings object.
 * Legacy `slaBusinessDays` (and NO replyWithin* key) ⇒ business days, not
 * 24/7 — exactly what Stage C promised. Anything malformed ⇒ the default
 * (30 minutes, 24/7). `business_days` is never 24/7 (the unit already says
 * "not weekends"), so alwaysOn is normalised to false for it.
 */
export function resolveReplyPromise(
  setting: SupportSettingShape | null | undefined,
): ReplyPromise {
  const s = setting && typeof setting === "object" ? setting : {};
  const hasNew =
    s.replyWithinValue !== undefined ||
    s.replyWithinUnit !== undefined ||
    s.alwaysOn !== undefined;
  if (!hasNew && isIntInRange(s.slaBusinessDays, 1, REPLY_WITHIN_MAX.business_days)) {
    return { value: s.slaBusinessDays, unit: "business_days", alwaysOn: false };
  }
  const unit = isReplyWithinUnit(s.replyWithinUnit)
    ? s.replyWithinUnit
    : DEFAULT_REPLY_PROMISE.unit;
  const value = isIntInRange(s.replyWithinValue, 1, REPLY_WITHIN_MAX[unit])
    ? s.replyWithinValue
    : unit === DEFAULT_REPLY_PROMISE.unit
      ? DEFAULT_REPLY_PROMISE.value
      : 1;
  const alwaysOn =
    unit === "business_days"
      ? false
      : typeof s.alwaysOn === "boolean"
        ? s.alwaysOn
        : DEFAULT_REPLY_PROMISE.alwaysOn;
  return { value, unit, alwaysOn };
}

/**
 * Pure resolver — the testable core. `shopContactEmail` is the Shop record's
 * mirrored contact email (null when unknown).
 */
export function resolveSupportChannels(
  setting: SupportSettingShape | null | undefined,
  shopContactEmail: string | null | undefined,
): SupportChannels {
  const s = setting && typeof setting === "object" ? setting : {};
  const email =
    normalizeSupportEmail(s.email) ?? normalizeSupportEmail(shopContactEmail);
  const replyTo = normalizeSupportEmail(s.replyTo) ?? email;
  const whatsapp = normalizeWhatsapp(s.whatsapp);
  const chatUrl = normalizeChatUrl(s.chatUrl);
  const hoursNote =
    typeof s.hoursNote === "string" && s.hoursNote.trim()
      ? s.hoursNote.trim().slice(0, 300)
      : null;
  return {
    email,
    replyTo,
    whatsapp,
    whatsappHref: whatsapp ? whatsappHrefFor(whatsapp) : null,
    chatUrl,
    hoursNote,
    replyWithin: resolveReplyPromise(s),
    hasAny: !!(email || whatsapp || chatUrl),
  };
}

/** Resolve the shop's support channels. Never throws. */
export async function getSupportChannels(
  shopId: string,
): Promise<SupportChannels> {
  let setting: SupportSettingShape | null = null;
  let contactEmail: string | null = null;
  try {
    setting = (await getSetting(shopId, "support")) as SupportSettingShape;
  } catch (err) {
    console.error("[support] settings read failed — channels degrade", err);
  }
  // The Shop record is only consulted when the setting leaves the email
  // blank (the documented fallback) — one query less on every send.
  if (!normalizeSupportEmail(setting?.email)) {
    try {
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { contactEmail: true },
      });
      contactEmail = shop?.contactEmail ?? null;
    } catch (err) {
      console.error("[support] shop contact email read failed", err);
    }
  }
  try {
    return resolveSupportChannels(setting, contactEmail);
  } catch (err) {
    console.error("[support] channel resolution failed", err);
    return EMPTY_SUPPORT_CHANNELS;
  }
}
