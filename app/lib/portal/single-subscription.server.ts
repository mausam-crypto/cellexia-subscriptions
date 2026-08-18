import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { withLocale } from "~/lib/portal/layout.server";

/**
 * Single-subscription view (v1.29.0, portal.singleSubscriptionOpensDetail).
 *
 * A customer with exactly ONE subscription — any status: the subscription
 * page handles ACTIVE / PAUSED / FAILED / CANCELLED / EXPIRED — has nothing
 * to choose from on the list, so the portal home 302s straight to that
 * subscription's page. Two invariants make it safe:
 *
 *  - the query string is FORWARDED (toasts, undo tokens, ?cid=, ?locale=,
 *    ?cx_pp=, return_to…) so every post-action redirect to "/" still lands
 *    with its toast, and the preview token survives the hop — MINUS the
 *    Shopify app-proxy reserved keys (shop / path_prefix / timestamp /
 *    signature / logged_in_customer_id) and the home's own one-shot keys
 *    (handoff / next / list). The 302 Location is resolved against the
 *    storefront and re-proxied, so Shopify appends fresh copies of its keys:
 *    forwarding the stale ones would duplicate them (HMAC base divergence ⇒
 *    400) and leak a signature / customer id into the address bar;
 *  - `?list=1` is the escape hatch: the nav "Subscriptions" tab and the
 *    detail page's back link carry it in single mode, so the list is always
 *    reachable and a redirect can never loop. Home-card actions rendered on
 *    the explicit list return to `/?list=1` (HOME_LIST_RETURN_TO) so the
 *    list survives a round-trip.
 *
 * Pure helpers — the route applies them after its own auth / setup gates
 * and after loading the customer's contracts (same guard chain as the list).
 */

/** Query marker that keeps the list rendering (escape hatch). */
export const LIST_MARKER_PARAM = "list";

/** True when the request explicitly asks for the list (`?list=1`). */
export function wantsList(url: URL): boolean {
  return url.searchParams.get(LIST_MARKER_PARAM) === "1";
}

/**
 * `return_to` value that brings a customer back to the explicit list
 * (`/?list=1`) — the only home return_to besides "/" the API accepts.
 */
export const HOME_LIST_RETURN_TO = `/?${LIST_MARKER_PARAM}=1`;

/**
 * The home page's own `return_to`: `/?list=1` when the page was rendered as
 * the explicit list (escape hatch), plain "/" otherwise. Card actions and
 * toast Undo forms on the list use it so a round-trip through the API lands
 * back on the list instead of bouncing to the single subscription.
 */
export function homeReturnTo(url: URL): string {
  return wantsList(url) ? HOME_LIST_RETURN_TO : "/";
}

/**
 * Query keys NEVER forwarded by the single-subscription redirect: Shopify's
 * app-proxy reserved keys (re-appended by the proxy on the next hop — a
 * forwarded copy duplicates them and can break the HMAC check) plus the
 * home's own one-shot keys (hand-off exchange, in-portal landing, marker).
 */
export const REDIRECT_DROPPED_PARAMS: ReadonlySet<string> = new Set([
  "shop",
  "path_prefix",
  "timestamp",
  "signature",
  "logged_in_customer_id",
  "handoff",
  "next",
  LIST_MARKER_PARAM,
]);

/**
 * The query string the redirect carries: every key of `url` except the
 * dropped set, in order, repeated keys preserved. "" when nothing remains.
 */
export function forwardedSearch(url: URL): string {
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (REDIRECT_DROPPED_PARAMS.has(key)) continue;
    params.append(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * The single-mode decision: setting on AND exactly one contract (whatever
 * its status). Shared by the home redirect and the detail page's flag.
 */
export function isSingleSubscriptionMode(input: {
  enabled: boolean;
  contractCount: number;
}): boolean {
  return input.enabled && input.contractCount === 1;
}

/**
 * Where the home should send a single-subscription customer, or null to
 * render the list: null when the setting is off, when the customer has 0 or
 * ≥2 contracts, or when the query carries `?list=1`. The returned path keeps
 * the request's query string minus REDIRECT_DROPPED_PARAMS (see
 * forwardedSearch).
 */
export function singleSubscriptionRedirectPath(input: {
  requestUrl: URL | string;
  enabled: boolean;
  contractIds: readonly string[];
}): string | null {
  const url =
    typeof input.requestUrl === "string" ? new URL(input.requestUrl) : input.requestUrl;
  if (
    !isSingleSubscriptionMode({
      enabled: input.enabled,
      contractCount: input.contractIds.length,
    })
  ) {
    return null;
  }
  if (wantsList(url)) return null;
  const id = input.contractIds[0];
  return `${PORTAL_PROXY_BASE}/subscription/${encodeURIComponent(id)}${forwardedSearch(url)}`;
}

/** The list URL with the escape-hatch marker (nav tab / back link). */
export function listHref(locale: string, preview: string | null): string {
  return withLocale(`${PORTAL_PROXY_BASE}/?${LIST_MARKER_PARAM}=1`, locale, preview);
}
