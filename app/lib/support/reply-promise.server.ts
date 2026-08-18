import { t } from "~/lib/i18n/i18n.server";
import {
  DEFAULT_REPLY_PROMISE,
  REPLY_WITHIN_MAX,
  isReplyWithinUnit,
  type ReplyPromise,
  type ReplyWithinUnit,
} from "./channels.server";

/**
 * The reply promise (v1.29.0) — ONE sentence, ONE helper, every surface:
 * the Get-help card, the support_sent toast, the cancel-flow concierge card,
 * the saved page and the admin preview all phrase the promise through
 * `supportReplyPromise()`. Nothing else may spell "business day" / "24/7":
 * tests/support-reply-promise.test.ts grep-pins it.
 *
 *   "A human replies within 30 minutes, 24/7."
 *   "A human replies within {n} hours, 24/7."
 *   "A human replies within {n} minutes on business days."   (24/7 off)
 *   "A human replies within {n} business day(s)."
 *
 * Keys: portal.support.reply_promise.<unit>_<one|other>[_always]. The
 * non-`_always` minutes/hours sentences NAME business days because the SLA
 * job (replyPromiseElapsed) skips weekend time when 24/7 is off — the
 * customer must never read a stronger promise than the merchant enforces.
 *
 * The URL codec (`replyPromiseParams` / `parseReplyPromiseParams`) lets the
 * redirect-toast writers carry the promise to the sync toast resolver:
 * `sla` = value, `slau` = m|h|d, `sla247` = 1. Malformed ⇒ null — the toast
 * falls back to the copy without a promise (never a promise the settings did
 * not make).
 */

/** Anything that carries a resolved promise — SupportChannels or a bare promise. */
export type ReplyPromiseSource = ReplyPromise | { replyWithin: ReplyPromise };

function promiseOf(source: ReplyPromiseSource | null | undefined): ReplyPromise {
  if (!source) return DEFAULT_REPLY_PROMISE;
  const p = "replyWithin" in source ? source.replyWithin : source;
  return p ?? DEFAULT_REPLY_PROMISE;
}

/** The i18n key the sentence comes from — exported so tests can enumerate. */
export function replyPromiseKey(promise: ReplyPromise): string {
  const plural = promise.value === 1 ? "one" : "other";
  const always = promise.alwaysOn && promise.unit !== "business_days" ? "_always" : "";
  return `portal.support.reply_promise.${promise.unit}_${plural}${always}`;
}

/** The localized sentence — the ONLY place the promise is turned into words. */
export function supportReplyPromise(
  locale: string | null | undefined,
  channels: ReplyPromiseSource | null | undefined,
): string {
  const promise = promiseOf(channels);
  return t(locale, replyPromiseKey(promise), { n: promise.value });
}

const UNIT_CODE: Record<ReplyWithinUnit, string> = {
  minutes: "m",
  hours: "h",
  business_days: "d",
};
const CODE_UNIT: Record<string, ReplyWithinUnit> = { m: "minutes", h: "hours", d: "business_days" };

/** Query params the redirect-toast writer appends (see resolveToast). */
export function replyPromiseParams(
  channels: ReplyPromiseSource | null | undefined,
): Record<string, string> {
  const p = promiseOf(channels);
  return {
    sla: String(p.value),
    slau: UNIT_CODE[p.unit],
    ...(p.alwaysOn && p.unit !== "business_days" ? { sla247: "1" } : {}),
  };
}

/** Inverse of replyPromiseParams — null when anything is missing/tampered. */
export function parseReplyPromiseParams(params: URLSearchParams): ReplyPromise | null {
  const unit = CODE_UNIT[params.get("slau") ?? ""];
  if (!isReplyWithinUnit(unit)) return null;
  const value = Number(params.get("sla") ?? "");
  if (!Number.isInteger(value) || value < 1 || value > REPLY_WITHIN_MAX[unit]) return null;
  const alwaysOn = unit !== "business_days" && params.get("sla247") === "1";
  return { value, unit, alwaysOn };
}

/** Event-payload / alert-context shape read-back — null when malformed. */
export function readReplyPromise(raw: unknown): ReplyPromise | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { value?: unknown; unit?: unknown; alwaysOn?: unknown };
  if (!isReplyWithinUnit(o.unit)) return null;
  if (
    typeof o.value !== "number" ||
    !Number.isInteger(o.value) ||
    o.value < 1 ||
    o.value > REPLY_WITHIN_MAX[o.unit]
  ) {
    return null;
  }
  return {
    value: o.value,
    unit: o.unit,
    alwaysOn: o.unit !== "business_days" && o.alwaysOn === true,
  };
}
