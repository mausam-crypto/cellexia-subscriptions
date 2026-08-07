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

/**
 * Remove PII-shaped substrings from free text: email addresses, phone-length
 * digit runs (7+, separators tolerated) and long token-shaped strings (20+
 * chars of base64/hex-ish alphabet — session tokens, checkout tokens, JWTs).
 */
export function stripPiiFromText(text: string): string {
  return (
    text
      // emails first (they contain token-shaped local parts)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]")
      // long token-shaped runs (before digit runs, which they may contain)
      .replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]")
      // phone-length digit runs, tolerating common separators
      .replace(/\+?\d(?:[\s().-]?\d){6,}/g, "[redacted]")
  );
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
      params.append(
        key.toLowerCase(),
        stripPiiFromText(val).slice(0, ACQ_FIELD_MAX),
      );
    }
  }
  const path = stripPiiFromText(url.pathname);
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

/**
 * UTM params from a raw URL (absolute or path-relative). Null when the input
 * carries none — a null column reads "no UTM", not "empty UTM".
 */
export function utmFromUrl(value: unknown): AcqUtm | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  let url: URL;
  try {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, "https://relative.invalid");
  } catch {
    return null;
  }
  const get = (k: string): string | null => {
    const v = url.searchParams.get(k);
    return v ? stripPiiFromText(v).slice(0, ACQ_FIELD_MAX) : null;
  };
  const utm: AcqUtm = {
    source: get("utm_source"),
    medium: get("utm_medium"),
    campaign: get("utm_campaign"),
    term: get("utm_term"),
    content: get("utm_content"),
  };
  return Object.values(utm).some((v) => v != null) ? utm : null;
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
  };

  return { ...capture, acqRaw };
}
