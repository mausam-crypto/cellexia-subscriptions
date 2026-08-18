import { t } from "~/lib/i18n/i18n.server";
import {
  ShopifyUserError,
  listCustomerPaymentMethods,
  type AdminClient,
  type CustomerPaymentMethodSummary,
} from "~/lib/graphql/index.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { paymentMethodShortLabel } from "~/lib/portal/payment.server";

/**
 * Payment-methods list (v1.28.0, P1.7 — settings.portal.paymentMethodsList).
 *
 * The subscription page's payment section lists the customer's OTHER vaulted
 * methods ("Other payment methods on your account") with two verbs per
 * method — "Use for this subscription" (POST /api/payment_select →
 * changePaymentMethod, trigger `select`) and "Set as backup" (POST
 * /api/payment_backup → setBackupPaymentMethod, setBy CUSTOMER) — shows
 * "Backup: {label}" under the primary, and, when the account holds at most
 * one method, an honest "Add another payment method" block (no in-app card
 * entry exists: Shopify vaults new instruments only through a checkout, the
 * hosted replace flow or the account page).
 *
 * The list is read through `listCustomerPaymentMethods` (the same call the
 * services validate against — a form value is never trusted) with a tiny
 * in-process memo per customer (60 s) so a page render, its dunning banner
 * and a same-minute redirect share ONE Shopify read. No table.
 */

// ── Cache ────────────────────────────────────────────────────────────────────

export const PAYMENT_METHODS_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  methods: CustomerPaymentMethodSummary[];
}

const cache = new Map<string, CacheEntry>();
/** Above this many memoized customers a write first sweeps expired entries. */
export const PAYMENT_METHODS_CACHE_SWEEP_AT = 2_000;

/**
 * Bounded memo (v1.28.0 audit): expired entries used to stay in the Map
 * forever (one card-summary array per distinct customer who ever rendered
 * the detail page or the new-card banner). A write past SWEEP_AT drops every
 * expired entry; if all are still live, the oldest is evicted so the Map
 * never exceeds SWEEP_AT + 1 entries on a long-lived process.
 */
function evictBeforeWrite(now: number, ttl: number): void {
  if (cache.size < PAYMENT_METHODS_CACHE_SWEEP_AT) return;
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttl) {
      cache.delete(key);
    } else if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (cache.size >= PAYMENT_METHODS_CACHE_SWEEP_AT && oldestKey) {
    cache.delete(oldestKey);
  }
}

/** Tests only. */
export function _paymentMethodsCacheSize(): number {
  return cache.size;
}

/**
 * Non-revoked (live) payment methods on the customer's account, memoized per
 * customer GID for `ttlMs` (default 60 s). Rethrows Shopify failures —
 * containment is the caller's job (a render degrades to the single-card
 * section, a dispatcher verb to a toast).
 */
export async function listLivePaymentMethodsCached(
  admin: AdminClient,
  customerGid: string,
  opts: { ttlMs?: number; now?: Date; force?: boolean } = {},
): Promise<CustomerPaymentMethodSummary[]> {
  const ttl = opts.ttlMs ?? PAYMENT_METHODS_CACHE_TTL_MS;
  const now = (opts.now ?? new Date()).getTime();
  const hit = cache.get(customerGid);
  if (!opts.force && hit && now - hit.at < ttl) return hit.methods;
  const all = await listCustomerPaymentMethods(admin, customerGid);
  const live = all.filter((m) => !m.revoked);
  evictBeforeWrite(now, ttl);
  cache.set(customerGid, { at: now, methods: live });
  return live;
}

/** Drop the memo for one customer (after a select / backup mutation). */
export function invalidatePaymentMethodsCache(customerGid: string): void {
  cache.delete(customerGid);
}

/** Tests only. */
export function _resetPaymentMethodsCache(): void {
  cache.clear();
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** GID shape of a CustomerPaymentMethod — the only form value accepted. */
export const PAYMENT_METHOD_GID_RE =
  /^gid:\/\/shopify\/CustomerPaymentMethod\/[A-Za-z0-9_-]{1,64}$/;

export function isPaymentMethodGid(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_METHOD_GID_RE.test(value);
}

/**
 * Compact instrument label for a vaulted method ("Visa ····4242", "Shop Pay
 * ····1234", "PayPal"); a generic "Card" when the instrument carries no
 * brand/last4 (never blank — the customer must be able to tell rows apart).
 */
export function vaultedMethodLabel(
  locale: string,
  method: Pick<CustomerPaymentMethodSummary, "instrument">,
): string {
  const inst = method.instrument;
  const label = paymentMethodShortLabel(locale, {
    paymentInstrumentType: inst?.type ?? null,
    cardBrand: inst?.brand ?? null,
    cardLast4: inst?.lastDigits ?? null,
  });
  if (label) return label;
  if (inst?.type === "PAYPAL") return t(locale, "portal.payment.paypal_summary");
  return t(locale, "portal.payment.card_generic");
}

// ── Render ───────────────────────────────────────────────────────────────────

export interface PaymentMethodsSectionInput {
  locale: string;
  contract: {
    paymentMethodId: string | null;
    backupPaymentMethodId: string | null;
    paymentMethodRevokedAt?: Date | null;
  };
  /** Live (non-revoked) methods; null = the read failed / not attempted. */
  methods: CustomerPaymentMethodSummary[] | null;
  /** settings.portal.paymentMethodsList */
  enabled: boolean;
  /** Engine currently charging the backup (pointer equality). */
  onBackup: boolean;
  /** Storefront account URL (Manage payment methods). */
  accountUrl: string;
  /** `/apps/cellexia-subs/api/{action}` with locale/preview carried. */
  apiUrl: (action: string) => string;
  /** Hidden inputs INCLUDING contractId / _csrf / return_to. */
  hiddenFields: (fields: Array<[string, string]>) => string;
}

/**
 * Which block the section renders:
 *  - LIST:    ≥1 live method besides the primary → radio-style list
 *  - ADD:     a KNOWN list with ≤1 live method → "Add another payment method"
 *  - UNKNOWN: the read failed (methods null) → nothing extra; the section
 *             keeps its plain "Manage payment methods" link — never the
 *             "add another card" copy for a customer who may hold several
 *  - NONE:    feature off → nothing (the section keeps its pre-P1.7 shape)
 */
export type PaymentMethodsBlockKind = "LIST" | "ADD" | "UNKNOWN" | "NONE";

export function otherPaymentMethods(
  methods: CustomerPaymentMethodSummary[] | null,
  primaryId: string | null,
): CustomerPaymentMethodSummary[] {
  if (!methods) return [];
  return methods.filter((m) => !m.revoked && m.id !== primaryId);
}

export function paymentMethodsBlockKind(
  input: Pick<PaymentMethodsSectionInput, "enabled" | "methods" | "contract">,
): PaymentMethodsBlockKind {
  if (!input.enabled) return "NONE";
  if (input.methods === null) return "UNKNOWN";
  return otherPaymentMethods(input.methods, input.contract.paymentMethodId).length > 0
    ? "LIST"
    : "ADD";
}

/**
 * "Backup: {label}" line under the primary (null when no backup is set, or
 * while the engine is charging the backup — the on-backup note already
 * names it). Falls back to a generic line when the backup id is not in the
 * (possibly stale / unavailable) list.
 */
export function backupLine(
  locale: string,
  input: Pick<PaymentMethodsSectionInput, "contract" | "methods" | "onBackup">,
): string | null {
  const backupId = input.contract.backupPaymentMethodId;
  if (!backupId || input.onBackup) return null;
  const method = input.methods?.find((m) => m.id === backupId) ?? null;
  return method
    ? t(locale, "portal.payment.backup_line", { label: vaultedMethodLabel(locale, method) })
    : t(locale, "portal.payment.backup_line_generic");
}

export function paymentMethodsSectionHtml(input: PaymentMethodsSectionInput): string {
  const { locale, contract } = input;
  const kind = paymentMethodsBlockKind(input);
  if (kind === "NONE" || kind === "UNKNOWN") return "";

  if (kind === "LIST") {
    const others = otherPaymentMethods(input.methods, contract.paymentMethodId);
    const rows = others
      .map((m) => {
        const label = vaultedMethodLabel(locale, m);
        const isBackup = contract.backupPaymentMethodId === m.id;
        const useForm = `<form method="post" action="${input.apiUrl("payment_select")}" class="cxs-pm__use">${input.hiddenFields([["paymentMethodId", m.id]])}<button type="submit" class="cxs-btn cxs-btn--small">${escapeHtml(t(locale, "portal.payment.use_for_this"))}</button></form>`;
        // "Set as backup" toggle: posts the method id, or "" to clear when it
        // already IS the backup. While the engine charges the backup the
        // service refuses (BACKUP_IN_USE); the toggle is hidden then.
        const backupForm = input.onBackup
          ? ""
          : `<form method="post" action="${input.apiUrl("payment_backup")}" class="cxs-pm__backup">${input.hiddenFields([["paymentMethodId", isBackup ? "" : m.id]])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small" aria-pressed="${isBackup ? "true" : "false"}">${escapeHtml(t(locale, isBackup ? "portal.payment.backup_remove" : "portal.payment.backup_set"))}</button></form>`;
        return `<li class="cxs-pm__row${isBackup ? " cxs-pm__row--backup" : ""}"><div class="cxs-pm__label"><span>${escapeHtml(label)}</span>${isBackup ? `<span class="cxs-chip cxs-chip--info cxs-pm__chip">${escapeHtml(t(locale, "portal.payment.backup_chip"))}</span>` : ""}</div><div class="cxs-pm__actions">${useForm}${backupForm}</div></li>`;
      })
      .join("");
    return `<div class="cxs-pm" id="cxs-payment-methods">
  <p class="cxs-label" style="margin:16px 0 6px">${escapeHtml(t(locale, "portal.payment.others_title"))}</p>
  <ul class="cxs-pm__list" role="list">${rows}</ul>
  <p class="cxs-muted cxs-small" style="margin:8px 0 0">${escapeHtml(t(locale, "portal.payment.backup_explain"))}</p>
</div>`;
  }

  // ADD — honest options only.
  const canEmail =
    contract.paymentMethodId != null && contract.paymentMethodRevokedAt == null;
  const emailForm = canEmail
    ? `<form method="post" action="${input.apiUrl("payment_update")}" class="cxs-pm__email" style="margin:8px 0 0">${input.hiddenFields([])}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(t(locale, "portal.payment.add_email_link"))}</button></form>`
    : "";
  return `<div class="cxs-pm cxs-pm--add" id="cxs-payment-methods">
  <p class="cxs-label" style="margin:16px 0 6px">${escapeHtml(t(locale, "portal.payment.add_title"))}</p>
  <p class="cxs-small" style="margin:0"><a class="cxs-link cxs-payment__manage" href="${escapeHtml(input.accountUrl)}" rel="noopener">${escapeHtml(t(locale, "portal.payment.add_in_account"))}</a></p>${emailForm}
  <p class="cxs-muted cxs-small" style="margin:8px 0 0">${escapeHtml(t(locale, "portal.payment.add_checkout_note"))}</p>
</div>`;
}

// ── Error → toast mapping ────────────────────────────────────────────────────

/**
 * Friendly toast key for a refused select / backup verb, or null when the
 * error is not one of the known refusals (the dispatcher's generic catch
 * then applies). Typed service refusals (PaymentMethodChangeError codes) and
 * Shopify draft userErrors (matched on `code` when selected, else on the
 * message — the draft mutations select field+message only) both map here.
 * The result is always an existing TOAST_KEYS entry.
 */
export function paymentMethodErrorToast(err: unknown): string | null {
  if (err instanceof Error && err.name === "PaymentMethodChangeError") {
    const code = (err as { code?: string }).code;
    switch (code) {
      case "PAYMENT_METHOD_NOT_ON_ACCOUNT":
        return "payment_not_on_account";
      case "BACKUP_EQUALS_PRIMARY":
        return "backup_equals_primary";
      case "BACKUP_IN_USE":
        return "backup_in_use";
      default:
        return "error";
    }
  }
  if (err instanceof ShopifyUserError) {
    const codes = err.errors.map((e) => `${e.code ?? ""} ${e.message}`.toUpperCase());
    const has = (needle: string) => codes.some((c) => c.includes(needle));
    if (has("CUSTOMER_MISMATCH") || has("CUSTOMER MISMATCH")) return "payment_not_on_account";
    if (has("MISSING_CUSTOMER_PAYMENT_METHOD") || has("PAYMENT_METHOD_DOES_NOT_EXIST"))
      return "payment_not_on_account";
    if (has("STALE_CONTRACT") || has("STALE CONTRACT")) return "payment_stale";
    if (has("HAS_FUTURE_EDITS") || has("FUTURE EDITS")) return "cycle_edits_pending";
    return null;
  }
  return null;
}
