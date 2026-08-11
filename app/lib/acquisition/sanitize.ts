/**
 * Acquisition-data sanitizer — PURE functions only (no prisma, no Shopify, no
 * env), so the webhook handlers, the import script and the tests all consume
 * the exact same rules. See docs/DATA_FOUNDATION.md for the field-by-field
 * contract.
 *
 * Privacy rules (non-negotiable, enforced here so no caller can forget them):
 * - NEVER the raw IP, NEVER the full user-agent string. The UA is reduced to
 *   a device class ("mobile" | "desktop" | "tablet") and then discarded.
 * - URLs keep host + path + utm_* query params ONLY. Every other query param
 *   is dropped (checkout tokens, session ids, email-in-query, gclid/fbclid…).
 * - Free-text URL parts are scrubbed of emails, phone-length digit runs and
 *   token-shaped strings, then truncated.
 * - Everything is length-capped so a hostile payload cannot balloon a row.
 */

// ── Length caps ───────────────────────────────────────────────────────────────

export const ACQ_URL_MAX = 512;
export const ACQ_FIELD_MAX = 128;
export const ACQ_CITY_MAX = 64;
/**
 * Longest alnum/`_`/`-` run still treated as a human-written slug (campaign
 * name, product handle). Anything longer is machine output and is redacted
 * regardless of shape — no human types a 65-character campaign name.
 */
export const ACQ_SLUG_MAX = 64;
/** Cap on list-shaped bundle entries (discount codes, order tags). */
export const ACQ_LIST_MAX = 20;

// ── Small scrubbers ───────────────────────────────────────────────────────────

/** Trimmed + hard-capped string, null when empty/absent. */
export function truncateAcqField(
  value: unknown,
  max: number = ACQ_FIELD_MAX,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Candidate runs the token heuristic inspects (20+ of base64/slug alphabet). */
const TOKEN_RUN_RE = /[A-Za-z0-9_-]{20,}/g;
const PHONE_RUN_RE = /\+?\d(?:[\s().-]?\d){6,}/g;

/**
 * Machine token vs human slug. Redacting every 20+ char run destroyed the
 * campaign dimension at capture ("black-friday-2025-conversion",
 * "advanced-night-repair-serum" product handles), so the heuristic keeps
 * slug-shaped runs — `^[a-z0-9]+([_-][a-z0-9]+)*$`-ish names people type —
 * and redacts only shapes people do not type:
 *  - mixed-case WITH digits (base64 entropy: session tokens, JWT segments);
 *  - a separator-less letter+digit fusion (hex-ish checkout/cart tokens —
 *    real campaign names that long always carry `-`/`_` separators);
 *  - anything longer than ACQ_SLUG_MAX.
 * Pure-digit runs are ad-platform campaign/ad ids and are always kept here
 * (free TEXT still phone-scrubs digit runs — see stripPiiFromText).
 */
function isTokenShaped(run: string): boolean {
  if (run.length > ACQ_SLUG_MAX) return true;
  const hasDigit = /\d/.test(run);
  const hasLower = /[a-z]/.test(run);
  const hasUpper = /[A-Z]/.test(run);
  if (hasLower && hasUpper && hasDigit) return true;
  if (hasDigit && (hasLower || hasUpper) && !/[_-]/.test(run)) return true;
  return false;
}

const redactTokenRuns = (text: string): string =>
  text.replace(TOKEN_RUN_RE, (run) => (isTokenShaped(run) ? "[redacted]" : run));

/**
 * Remove PII-shaped substrings from free text: email addresses, phone-length
 * digit runs (7+, separators tolerated) and token-shaped strings (see
 * isTokenShaped — session tokens, checkout tokens, JWTs; human slugs
 * survive). For utm values and slug path segments, where digit runs are
 * campaign/ad ids rather than phone numbers, use sanitizeUtmValue / the URL
 * sanitizer instead — this full scrub is for genuinely free text.
 */
export function stripPiiFromText(text: string): string {
  return redactTokenRuns(
    // emails first (they contain token-shaped local parts)
    text.replace(EMAIL_RE, "[redacted]"),
  ).replace(PHONE_RUN_RE, "[redacted]");
}

/**
 * Scrub + cap a single utm_* VALUE. Emails and token-shaped strings are
 * redacted, but — unlike free text — digit runs are kept: a pure-digit utm
 * value is a Meta/Google campaign or ad id ({{campaign.id}} templates), not
 * a phone number, and redacting it severed the ad-platform join for every
 * numeric-id campaign. Null when empty/absent.
 */
export function sanitizeUtmValue(value: unknown): string | null {
  const raw = truncateAcqField(value, ACQ_FIELD_MAX * 2);
  if (!raw) return null;
  const scrubbed = redactTokenRuns(raw.replace(EMAIL_RE, "[redacted]"));
  return truncateAcqField(scrubbed, ACQ_FIELD_MAX);
}

/**
 * Scrub a URL pathname segment-wise: a slug-shaped segment (product handle,
 * collection slug, numeric id — the alphabet people put in URLs) keeps its
 * digits and only loses token-shaped runs; anything else (dots, %, @…) gets
 * the full free-text scrub, so an email or phone in a path still dies.
 */
function sanitizeUrlPathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      /^[A-Za-z0-9_-]+$/.test(segment)
        ? redactTokenRuns(segment)
        : stripPiiFromText(segment),
    )
    .join("/");
}

/**
 * Sanitize a URL for storage: host (when absolute) + path + utm_* params only.
 * Relative inputs (Shopify's `landing_site` is usually a path like
 * "/products/x?utm_source=ig") keep their path form. Unparseable input is
 * scrubbed as free text. Always length-capped; null when empty.
 */
export function sanitizeAcquisitionUrl(value: unknown): string | null {
  const raw = truncateAcqField(value, ACQ_URL_MAX * 2);
  if (!raw) return null;

  let url: URL;
  let relative = false;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      url = new URL(raw);
    } else {
      relative = true;
      url = new URL(raw, "https://relative.invalid");
    }
  } catch {
    // Not URL-shaped — keep it, but scrubbed and capped.
    return truncateAcqField(stripPiiFromText(raw), ACQ_URL_MAX);
  }

  const params = new URLSearchParams();
  for (const [key, val] of url.searchParams) {
    if (/^utm_[a-z_]+$/i.test(key)) {
      params.append(key.toLowerCase(), sanitizeUtmValue(val) ?? "");
    }
  }
  const path = sanitizeUrlPathname(url.pathname);
  const host = relative ? "" : url.host;
  const query = params.toString();
  const out = `${host}${path}${query ? `?${query}` : ""}`;
  return truncateAcqField(out, ACQ_URL_MAX);
}

// ── UTM extraction ────────────────────────────────────────────────────────────

export interface AcqUtm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

/** Loose URL parse shared by the two utm extractors; null on unparseable. */
function parseUrlLoose(value: unknown): URL | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, "https://relative.invalid");
  } catch {
    return null;
  }
}

/**
 * UTM params from a raw URL (absolute or path-relative). Null when the input
 * carries none — a null column reads "no UTM", not "empty UTM".
 */
export function utmFromUrl(value: unknown): AcqUtm | null {
  const url = parseUrlLoose(value);
  if (!url) return null;
  const get = (k: string): string | null =>
    sanitizeUtmValue(url.searchParams.get(k));
  const utm: AcqUtm = {
    source: get("utm_source"),
    medium: get("utm_medium"),
    campaign: get("utm_campaign"),
    term: get("utm_term"),
    content: get("utm_content"),
  };
  return Object.values(utm).some((v) => v != null) ? utm : null;
}

/**
 * The same five params, length-capped ONLY — no scrub. Persisted as
 * `acqRaw.rawUtm`, the recompute reserve: whenever the scrub heuristics
 * change, the sanitized `acqUtm` edge can be rebuilt from this instead of
 * being lost forever (the same escape hatch `acqRaw.orderTotalCents` gives
 * the value bands). It may therefore hold PII a scrub would catch — it lives
 * inside `acqRaw` precisely so CUSTOMERS_REDACT clears it with the rest.
 */
export function rawUtmFromUrl(value: unknown): AcqUtm | null {
  const url = parseUrlLoose(value);
  if (!url) return null;
  const get = (k: string): string | null =>
    truncateAcqField(url.searchParams.get(k), ACQ_FIELD_MAX);
  const utm: AcqUtm = {
    source: get("utm_source"),
    medium: get("utm_medium"),
    campaign: get("utm_campaign"),
    term: get("utm_term"),
    content: get("utm_content"),
  };
  return Object.values(utm).some((v) => v != null) ? utm : null;
}

// ── Paid-channel click-id detection ──────────────────────────────────────────

/**
 * Ad-platform click-id params → channel labels. Detection is PRESENCE-ONLY:
 * the sanitizer drops every non-utm query param (click-id VALUES are
 * user-tracking tokens and are never stored — the standing privacy rule),
 * but the fact that a click id was present is the strongest paid-traffic
 * signal an order carries when the merchant's ads lack utm tags. Order of
 * this table is the tie-break when several ids ride one URL (rare).
 */
const CLICK_ID_CHANNELS: ReadonlyArray<{ param: string; channel: string }> = [
  { param: "gclid", channel: "google_ads" },
  { param: "gbraid", channel: "google_ads" },
  { param: "wbraid", channel: "google_ads" },
  { param: "fbclid", channel: "meta_ads" },
  { param: "ttclid", channel: "tiktok_ads" },
  { param: "msclkid", channel: "microsoft_ads" },
  { param: "twclid", channel: "x_ads" },
  { param: "epik", channel: "pinterest_ads" },
  { param: "sccid", channel: "snapchat_ads" },
];

/**
 * Lowercased, "www."-stripped host of a URL or bare-host string; null when
 * the input carries no host-shaped prefix (relative paths, junk). Scheme is
 * stripped textually first so a bare "cellexialabs.com" is a host, not a
 * path.
 */
export function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = stripped.split(/[/?#]/, 1)[0] ?? "";
  if (!host.includes(".")) return null;
  return host.replace(/^www\./, "");
}

/**
 * The paid channel indicated by a click-id param on any of the given RAW
 * urls (checked in argument order — pass the landing url first). Must run
 * BEFORE sanitization: the sanitizer strips exactly these params. Returns
 * the channel label only — no value from the URL survives into it.
 */
export function paidChannelFromUrls(...urls: unknown[]): string | null {
  for (const value of urls) {
    const url = parseUrlLoose(value);
    if (!url) continue;
    const keys = new Set(
      [...url.searchParams.keys()].map((k) => k.toLowerCase()),
    );
    for (const { param, channel } of CLICK_ID_CHANNELS) {
      if (keys.has(param)) return channel;
    }
  }
  return null;
}

// ── Device class ──────────────────────────────────────────────────────────────

export type AcqDeviceType = "mobile" | "desktop" | "tablet";

/**
 * Reduce a user-agent string to a device class. The full UA is never stored —
 * this classification is all that survives. Null when absent/unclassifiable
 * input is empty.
 */
export function deviceTypeFromUserAgent(ua: unknown): AcqDeviceType | null {
  if (typeof ua !== "string" || ua.trim() === "") return null;
  // Tablets first: Android tablets carry "Android" without "Mobile", iPads
  // their own token (desktop-mode iPads are indistinguishable → desktop).
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "tablet";
  if (/Android(?![\s\S]*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

// ── Order-value band ──────────────────────────────────────────────────────────

/**
 * Band edges in MAJOR currency units. A pure presentation-friendly grouping —
 * the raw total is always kept alongside (acqRaw.orderTotalCents), so bands
 * can be recomputed with different edges later without losing data.
 */
export const ORDER_VALUE_BAND_EDGES = [25, 50, 75, 100, 150, 200] as const;

/**
 * Decile-friendly order-value band label from integer cents, e.g. 6400 →
 * "50_75", 25000 → "200_plus". Currency-agnostic (major units of whatever the
 * order currency is). Null for null/negative input.
 */
export function orderValueBandFromCents(
  totalCents: unknown,
): string | null {
  if (typeof totalCents !== "number" || !Number.isFinite(totalCents)) {
    return null;
  }
  if (totalCents < 0) return null;
  const major = totalCents / 100;
  let lower = 0;
  for (const edge of ORDER_VALUE_BAND_EDGES) {
    if (major < edge) return `${lower}_${edge}`;
    lower = edge;
  }
  return `${ORDER_VALUE_BAND_EDGES[ORDER_VALUE_BAND_EDGES.length - 1]}_plus`;
}

// ── Time to purchase ──────────────────────────────────────────────────────────

/**
 * Seconds between account creation and the origin order being processed —
 * "browse-to-buy" latency. Clamped at 0 (clock skew must never store a
 * negative), null when either instant is missing/invalid.
 */
export function timeToPurchaseSeconds(
  customerCreatedAt: Date | null | undefined,
  orderProcessedAt: Date | null | undefined,
): number | null {
  if (!customerCreatedAt || !orderProcessedAt) return null;
  const a = customerCreatedAt.getTime();
  const b = orderProcessedAt.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

// ── List-shaped bundle fields ────────────────────────────────────────────────

/**
 * Discount codes as a capped list of code strings. Accepts plain strings or
 * REST `{ code }` objects so the caller does not have to reshape the payload.
 * Null when absent (a pre-feature row reads "not captured"); an empty array
 * reads "no codes on the order".
 */
export function discountCodesFromInput(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const code =
      typeof item === "string"
        ? item
        : item != null &&
            typeof item === "object" &&
            typeof (item as { code?: unknown }).code === "string"
          ? (item as { code: string }).code
          : null;
    const cleaned = truncateAcqField(code, ACQ_SLUG_MAX);
    if (cleaned) out.push(cleaned);
    if (out.length >= ACQ_LIST_MAX) break;
  }
  return out;
}

/**
 * Order tags as a capped list. Accepts the REST comma-separated `tags`
 * string or an array. Null when absent; empty array when there are no tags.
 */
export function orderTagsFromInput(value: unknown): string[] | null {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (items == null) return null;
  const out: string[] = [];
  for (const item of items) {
    const cleaned = truncateAcqField(item, ACQ_SLUG_MAX);
    if (cleaned) out.push(cleaned);
    if (out.length >= ACQ_LIST_MAX) break;
  }
  return out;
}

// ── The whole bundle ─────────────────────────────────────────────────────────

/** Raw (webhook-shaped) inputs the bundle is built from. All optional. */
export interface AcquisitionInput {
  referringSite?: unknown;
  landingSite?: unknown;
  sourceName?: unknown;
  /** Full user agent — reduced to a device class here, then dropped. */
  userAgent?: unknown;
  countryCode?: unknown;
  city?: unknown;
  provinceCode?: unknown;
  /** Σ line-item quantities on the origin order. */
  unitsFirstOrder?: number | null;
  orderId?: string | null;
  orderTotalCents?: number | null;
  orderCurrencyCode?: string | null;
  orderProcessedAt?: Date | null;
  /** `discount_codes` — strings or REST `{ code }` objects. */
  discountCodes?: unknown;
  /** `customer_locale` (fallback `client_details.accept_language`). */
  checkoutLocale?: unknown;
  /** Shopify Markets: `presentment_currency` + presentment total in cents. */
  presentmentCurrencyCode?: unknown;
  presentmentTotalCents?: number | null;
  /** `app_id` — the numeric sales-channel app id. */
  appId?: unknown;
  /** `source_identifier` — channel-specific order reference. */
  sourceIdentifier?: unknown;
  /** `buyer_accepts_marketing` — consent snapshot at checkout. */
  buyerAcceptsMarketing?: unknown;
  /** Order `tags` — REST comma-separated string or an array. */
  orderTags?: unknown;
  /**
   * Hosts (or URLs) that ARE the shop itself — the myshopify domain plus the
   * order's own status-page URL host (the storefront's primary domain).
   * Feeds acqRaw.referrerInternal so the traffic-source ladder can tell a
   * self-referral (internal navigation — not a source) from a real external
   * referrer even when the landing_site was captured path-relative (the
   * usual Shopify shape).
   */
  internalHosts?: unknown;
}

/** Sanitized, column-shaped acquisition capture. */
export interface AcquisitionCapture {
  acqReferringSite: string | null;
  acqLandingSite: string | null;
  acqSourceName: string | null;
  acqUtm: AcqUtm | null;
  acqCountryCode: string | null;
  acqCity: string | null;
  acqProvinceCode: string | null;
  acqDeviceType: AcqDeviceType | null;
  acqUnitsFirstOrder: number | null;
  acqOrderValueBand: string | null;
  /** The whole sanitized bundle, persisted as acqRaw for future mining. */
  acqRaw: Record<string, unknown>;
}

/**
 * Build the sanitized acquisition capture from raw order-payload inputs.
 * UTM extraction runs against the RAW landing/referring URLs (before their
 * non-utm params are stripped), so no signal is lost to the sanitizer.
 */
export function buildAcquisitionCapture(
  input: AcquisitionInput,
): AcquisitionCapture {
  const landingRaw =
    typeof input.landingSite === "string" ? input.landingSite : null;
  const referringRaw =
    typeof input.referringSite === "string" ? input.referringSite : null;
  const utm = utmFromUrl(landingRaw) ?? utmFromUrl(referringRaw);

  const countryCode = truncateAcqField(input.countryCode, 8);
  const provinceCode = truncateAcqField(input.provinceCode, 16);
  const capture: Omit<AcquisitionCapture, "acqRaw"> = {
    acqReferringSite: sanitizeAcquisitionUrl(referringRaw),
    acqLandingSite: sanitizeAcquisitionUrl(landingRaw),
    acqSourceName: truncateAcqField(input.sourceName, 64),
    acqUtm: utm,
    acqCountryCode: countryCode ? countryCode.toUpperCase() : null,
    acqCity: truncateAcqField(input.city, ACQ_CITY_MAX),
    acqProvinceCode: provinceCode ? provinceCode.toUpperCase() : null,
    acqDeviceType: deviceTypeFromUserAgent(input.userAgent),
    acqUnitsFirstOrder:
      typeof input.unitsFirstOrder === "number" &&
      Number.isFinite(input.unitsFirstOrder) &&
      input.unitsFirstOrder > 0
        ? Math.round(input.unitsFirstOrder)
        : null,
    acqOrderValueBand: orderValueBandFromCents(input.orderTotalCents ?? null),
  };

  const presentmentCurrency = truncateAcqField(input.presentmentCurrencyCode, 8);
  const sourceIdentifier = truncateAcqField(input.sourceIdentifier, 64);

  // The mining bundle: everything above plus the raw-but-safe numerics.
  // NEVER the IP, NEVER the full UA — those inputs are not even accepted here
  // beyond the device classification above.
  const acqRaw: Record<string, unknown> = {
    v: 1,
    orderId: input.orderId ?? null,
    sourceName: capture.acqSourceName,
    landingSite: capture.acqLandingSite,
    referringSite: capture.acqReferringSite,
    utm: capture.acqUtm,
    // Length-capped ONLY, deliberately unscrubbed — the recompute reserve for
    // the utm scrub (see rawUtmFromUrl). Same source precedence as `utm`.
    rawUtm: rawUtmFromUrl(landingRaw) ?? rawUtmFromUrl(referringRaw),
    // Presence-only paid-channel signal from ad click ids on the RAW urls
    // (v1.16.0, additive key) — the ids themselves are never stored. Feeds
    // the traffic-source segment's derivation ladder (segments.server.ts).
    paidChannel: paidChannelFromUrls(landingRaw, referringRaw),
    // Whether the referrer is the shop ITSELF (v1.16.0, additive key):
    // matched against the caller-supplied internal hosts (myshopify domain,
    // order-status host) plus the landing host when the landing URL was
    // absolute. true = internal navigation, not a source; false = proven
    // external; null = no referrer to judge. Computed at capture because
    // the stored landing URL is usually path-relative — read-time host
    // comparison cannot see the shop's own custom domain.
    referrerInternal: (() => {
      const referrerHost = normalizeHost(referringRaw);
      if (!referrerHost) return null;
      const internal = new Set<string>();
      for (const entry of Array.isArray(input.internalHosts)
        ? input.internalHosts
        : []) {
        const host = normalizeHost(entry);
        if (host) internal.add(host);
      }
      const landingHost = normalizeHost(landingRaw);
      if (landingHost) internal.add(landingHost);
      return internal.has(referrerHost);
    })(),
    countryCode: capture.acqCountryCode,
    provinceCode: capture.acqProvinceCode,
    city: capture.acqCity,
    deviceType: capture.acqDeviceType,
    unitsFirstOrder: capture.acqUnitsFirstOrder,
    orderTotalCents:
      typeof input.orderTotalCents === "number" &&
      Number.isFinite(input.orderTotalCents)
        ? input.orderTotalCents
        : null,
    orderCurrencyCode: input.orderCurrencyCode ?? null,
    orderValueBand: capture.acqOrderValueBand,
    orderProcessedAt: input.orderProcessedAt?.toISOString() ?? null,
    // Order-payload extras — additive keys (null when the ingest cannot
    // supply them): which promo acquired the subscriber, checkout locale,
    // Markets presentment, sales channel, consent snapshot, tags.
    discountCodes: discountCodesFromInput(input.discountCodes),
    checkoutLocale: truncateAcqField(input.checkoutLocale, 16),
    presentmentCurrencyCode: presentmentCurrency
      ? presentmentCurrency.toUpperCase()
      : null,
    presentmentTotalCents:
      typeof input.presentmentTotalCents === "number" &&
      Number.isFinite(input.presentmentTotalCents)
        ? input.presentmentTotalCents
        : null,
    appId:
      typeof input.appId === "number" && Number.isFinite(input.appId)
        ? input.appId
        : truncateAcqField(input.appId, 64),
    sourceIdentifier: sourceIdentifier
      ? stripPiiFromText(sourceIdentifier)
      : null,
    buyerAcceptsMarketing:
      typeof input.buyerAcceptsMarketing === "boolean"
        ? input.buyerAcceptsMarketing
        : null,
    orderTags: orderTagsFromInput(input.orderTags),
  };

  return { ...capture, acqRaw };
}
