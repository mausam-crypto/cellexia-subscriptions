import prisma from "~/db.server";
import { COUNTABLE_CONTRACT, contractTaxCountry } from "./queries.server";

/**
 * Analytics segments — the dimension layer every filtered analytics view
 * shares (v1.15.0).
 *
 * A segment is an AND-combination of dimension values over the COUNTABLE book
 * (ours + non-demo — a segment can only ever NARROW that population, never
 * widen it). The dimensions consume the acquisition data foundation
 * (docs/DATA_FOUNDATION.md — these are its first analytical consumers, all
 * read-only) plus the contract mirror:
 *
 * - country:      contractTaxCountry — current delivery address, else the
 *                 acquisition (first order) shipping country. The SAME helper
 *                 the VAT cost model uses, so "analytics by country" and
 *                 "VAT by country" can never disagree on what a contract's
 *                 country is.
 * - language:     base language subtag of the REAL checkout locale when the
 *                 acquisition bundle captured one (acqRaw.checkoutLocale —
 *                 v1.16.0: SubscriptionContract.locale is normalized into
 *                 the 24-locale catalog with an "en" default, which inflates
 *                 the "en" bucket with unknown/unsupported locales), else
 *                 SubscriptionContract.locale — "fr-CH" filters as "fr".
 * - source:       traffic source, derived through a last-touch ladder
 *                 (v1.16.0): acqUtm.source (the campaign truth when UTMs
 *                 were present) → acqRaw.paidChannel (ad click-id presence
 *                 recorded by the sanitizer — "google_ads", "meta_ads", … —
 *                 paid traffic whose ads lack utm tags) → a referrer
 *                 classification of acqReferringSite (search engines and
 *                 social hosts by name — "google", "instagram", … — any
 *                 other external host as "referral") → acqSourceName, with
 *                 Shopify's online-store value "web" reading "direct" when
 *                 a captured bundle proves the visit had no referrer
 *                 (draft orders / app ids keep their names), lowercased.
 * - product:      contracts holding at least one non-gift line of the
 *                 product (numeric-id normalized so GID and numeric forms
 *                 match).
 * - discountBand: first-order discount depth, derived from the mirrored
 *                 origin money — originOrderDiscountCents as a share of the
 *                 PRE-discount total (total + discount): none / 1_10 /
 *                 10_20 / 20_30 / 30_plus. "unknown" while the origin money
 *                 is not captured yet.
 * - device:       acqDeviceType ("mobile" | "desktop" | "tablet").
 * - valueBand:    acqOrderValueBand (first-order value deciles, edges owned
 *                 by the acquisition sanitizer).
 * - design:       the buy-box design (widget preset key) the subscriber's
 *                 first checkout came through — originDesignKey, stamped
 *                 write-once by the design-measurement facts writer
 *                 (v1.26.0). Read-only here: this module never resolves the
 *                 design ladder itself. Take rate BY design is not a segment
 *                 view (its denominator is orders, not contracts) — it
 *                 lives in Buy box designer → Results.
 * - preselect:    which buy-box option was rendered as the default at that
 *                 first checkout — originDesignPreselect "sub" | "one"
 *                 (v1.26.0). Tracked as its own dimension because the
 *                 merchant usually preselects subscription and wants to
 *                 read the two variables apart.
 *
 * Every dimension has an explicit UNKNOWN bucket rather than silently
 * dropping unattributed contracts — an imported book with no acquisition
 * data must be visibly "unknown", not invisibly missing. Persisted rollup /
 * cohort tables stay shop-level; segment views are computed live from source
 * by segment-views.server.ts using the id list this module resolves.
 */

// The segment vocabulary (dimension list, param names, band constants,
// labels) lives in segments-shared.ts so route COMPONENTS can import it
// without dragging this server module into the client bundle — re-exported
// verbatim here so server code keeps one import surface.
export {
  DESIGN_KEY_RE,
  DESIGN_PRESELECT_SEGMENT_VALUES,
  DEVICE_TYPES,
  DISCOUNT_BANDS,
  SEGMENT_DIMENSIONS,
  SEGMENT_PARAM_NAMES,
  UNKNOWN_SEGMENT_VALUE,
  segmentValueLabel,
} from "./segments-shared";
export type {
  AnalyticsSegment,
  DiscountBand,
  SegmentDimension,
} from "./segments-shared";
import {
  DESIGN_KEY_RE,
  DESIGN_PRESELECT_SEGMENT_VALUES,
  DEVICE_TYPES,
  DISCOUNT_BANDS,
  SEGMENT_DIMENSIONS,
  SEGMENT_PARAM_NAMES,
  UNKNOWN_SEGMENT_VALUE,
  type AnalyticsSegment,
  type DiscountBand,
} from "./segments-shared";

// ── Parsing (fail-safe: an invalid value drops its dimension, never throws) ──

const COUNTRY_RE = /^[A-Z]{2,8}$/;
const LANGUAGE_RE = /^[a-z]{2,8}$/;
const VALUE_BAND_RE = /^[0-9a-z_]{1,16}$/;
const SOURCE_MAX_LEN = 64;

/** "gid://shopify/Product/123" | "123" → "123"; null when not id-shaped. */
export function normalizeProductId(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * Parse a segment from URL search params. Unknown or malformed values drop
 * their dimension (fail-safe: an unfiltered view over-reports, a thrown
 * loader shows nothing). Returns {} when no dimension is present.
 */
export function parseSegmentFromParams(
  params: URLSearchParams,
): AnalyticsSegment {
  const segment: AnalyticsSegment = {};

  const raw = (dim: (typeof SEGMENT_DIMENSIONS)[number]): string | null => {
    const value = params.get(SEGMENT_PARAM_NAMES[dim]);
    return value != null && value.trim() !== "" ? value.trim() : null;
  };

  const country = raw("country");
  if (country) {
    const upper = country.toUpperCase();
    if (upper === UNKNOWN_SEGMENT_VALUE.toUpperCase()) {
      segment.country = UNKNOWN_SEGMENT_VALUE;
    } else if (COUNTRY_RE.test(upper)) {
      segment.country = upper;
    }
  }

  const language = raw("language");
  if (language) {
    const lower = language.toLowerCase();
    if (lower === UNKNOWN_SEGMENT_VALUE || LANGUAGE_RE.test(lower)) {
      segment.language = lower;
    }
  }

  const source = raw("source");
  if (source) {
    segment.source = source.toLowerCase().slice(0, SOURCE_MAX_LEN);
  }

  const productId = raw("productId");
  if (productId) {
    const normalized = normalizeProductId(productId);
    if (normalized) segment.productId = normalized;
  }

  const discountBand = raw("discountBand");
  if (discountBand) {
    const lower = discountBand.toLowerCase();
    if (
      lower === UNKNOWN_SEGMENT_VALUE ||
      (DISCOUNT_BANDS as readonly string[]).includes(lower)
    ) {
      segment.discountBand = lower as AnalyticsSegment["discountBand"];
    }
  }

  const device = raw("device");
  if (device) {
    const lower = device.toLowerCase();
    if (
      lower === UNKNOWN_SEGMENT_VALUE ||
      (DEVICE_TYPES as readonly string[]).includes(lower)
    ) {
      segment.device = lower;
    }
  }

  const valueBand = raw("valueBand");
  if (valueBand) {
    const lower = valueBand.toLowerCase();
    if (lower === UNKNOWN_SEGMENT_VALUE || VALUE_BAND_RE.test(lower)) {
      segment.valueBand = lower;
    }
  }

  // v1.26.0: buy-box design + preselect. Same fail-safe rule — a malformed
  // preset key or an unknown preselect token drops its dimension.
  const design = raw("design");
  if (design) {
    const lower = design.toLowerCase();
    if (lower === UNKNOWN_SEGMENT_VALUE || DESIGN_KEY_RE.test(lower)) {
      segment.design = lower;
    }
  }

  const preselect = raw("preselect");
  if (preselect) {
    const lower = preselect.toLowerCase();
    if (
      lower === UNKNOWN_SEGMENT_VALUE ||
      (DESIGN_PRESELECT_SEGMENT_VALUES as readonly string[]).includes(lower)
    ) {
      segment.preselect = lower;
    }
  }

  return segment;
}

export function isEmptySegment(segment: AnalyticsSegment): boolean {
  return SEGMENT_DIMENSIONS.every((dim) => segment[dim] == null);
}

// ── Pure per-contract dimension derivation ───────────────────────────────────

/** Contract shape the segment predicate needs (subset of SubscriptionContract). */
export interface SegmentSourceContract {
  id: string;
  locale: string;
  deliveryAddress: unknown;
  acqCountryCode: string | null;
  acqSourceName: string | null;
  acqUtm: unknown;
  acqReferringSite: string | null;
  acqLandingSite: string | null;
  acqRaw: unknown;
  acqDeviceType: string | null;
  acqOrderValueBand: string | null;
  originOrderTotalCents: number | null;
  originOrderDiscountCents: number | null;
  /** v1.26.0 design measurement stamps (write-once; null = not attributed). */
  originDesignKey: string | null;
  originDesignPreselect: string | null;
  lines: Array<{ productId: string; isGift: boolean; title?: string }>;
}

/** Safe string read of one acqRaw key (acqRaw is untyped JSON). */
function acqRawString(acqRaw: unknown, key: string): string | null {
  if (acqRaw == null || typeof acqRaw !== "object" || Array.isArray(acqRaw)) {
    return null;
  }
  const value = (acqRaw as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Safe boolean read of one acqRaw key; null when absent/non-boolean. */
function acqRawBoolean(acqRaw: unknown, key: string): boolean | null {
  if (acqRaw == null || typeof acqRaw !== "object" || Array.isArray(acqRaw)) {
    return null;
  }
  const value = (acqRaw as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

export function contractCountryValue(
  contract: Pick<SegmentSourceContract, "deliveryAddress" | "acqCountryCode">,
): string {
  return contractTaxCountry(contract) ?? UNKNOWN_SEGMENT_VALUE;
}

export function contractLanguageValue(
  contract: Pick<SegmentSourceContract, "locale" | "acqRaw">,
): string {
  // The REAL checkout locale first (v1.16.0): contract.locale is normalized
  // into the app's locale catalog with an "en" default, so a Turkish
  // checkout on the 24-locale catalog would otherwise segment as English.
  const checkout =
    acqRawString(contract.acqRaw, "checkoutLocale")
      ?.split(/[-_]/)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (LANGUAGE_RE.test(checkout)) return checkout;
  const base = contract.locale?.split(/[-_]/)[0]?.trim().toLowerCase() ?? "";
  return LANGUAGE_RE.test(base) ? base : UNKNOWN_SEGMENT_VALUE;
}

/**
 * Referrer-host classification for the source ladder: named search engines
 * and social platforms by brand, any other external host as "referral".
 * Order matters only as documentation — hosts are disjoint.
 */
const REFERRER_SOURCES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, label: "google" },
  { re: /(^|\.)bing\.com$/, label: "bing" },
  { re: /(^|\.)duckduckgo\.com$/, label: "duckduckgo" },
  { re: /(^|\.)yahoo\.(com|co\.[a-z]{2})$/, label: "yahoo" },
  { re: /(^|\.)ecosia\.org$/, label: "ecosia" },
  { re: /(^|\.)qwant\.com$/, label: "qwant" },
  { re: /(^|\.)yandex\.(com|ru)$/, label: "yandex" },
  { re: /(^|\.)baidu\.com$/, label: "baidu" },
  { re: /(^|\.)instagram\.com$/, label: "instagram" },
  { re: /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, label: "facebook" },
  { re: /(^|\.)tiktok\.com$/, label: "tiktok" },
  { re: /(^|\.)(youtube\.com|youtu\.be)$/, label: "youtube" },
  { re: /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/, label: "pinterest" },
  { re: /(^|\.)reddit\.com$/, label: "reddit" },
  { re: /(^|\.)(twitter\.com|x\.com|t\.co)$/, label: "x" },
  { re: /(^|\.)(linkedin\.com|lnkd\.in)$/, label: "linkedin" },
  { re: /(^|\.)snapchat\.com$/, label: "snapchat" },
  { re: /(^|\.)threads\.net$/, label: "threads" },
  // Hosted-email click-through domains — a newsletter click, not a referral.
  { re: /(^|\.)(klaviyo\.com|klclick\d*\.com)$/, label: "email" },
];

/**
 * Host part of a stored (sanitized) acquisition URL — "host/path?q" or a
 * relative "/path" (no host). Lowercased, "www."-stripped; null when the
 * value carries no host-shaped prefix.
 */
function acqUrlHost(value: string | null): string | null {
  if (!value) return null;
  const head = value.trim().toLowerCase().split(/[/?#]/, 1)[0] ?? "";
  if (head === "" || !head.includes(".")) return null;
  return head.replace(/^www\./, "");
}

/**
 * Traffic source through the last-touch derivation ladder (v1.16.0) — see
 * the module doc. Each rung only speaks when the stronger ones are silent,
 * and everything is derived from the sanitized capture, so the ladder can be
 * re-run over stored rows at any time.
 */
export function contractSourceValue(
  contract: Pick<
    SegmentSourceContract,
    "acqUtm" | "acqSourceName" | "acqReferringSite" | "acqLandingSite" | "acqRaw"
  >,
): string {
  // 1. Explicit campaign tagging.
  const utm = contract.acqUtm;
  if (utm != null && typeof utm === "object" && !Array.isArray(utm)) {
    const source = (utm as Record<string, unknown>).source;
    if (typeof source === "string" && source.trim() !== "") {
      return source.trim().toLowerCase().slice(0, SOURCE_MAX_LEN);
    }
  }
  // 2. Ad click-id presence recorded at capture (paid traffic without utm).
  const paidChannel = acqRawString(contract.acqRaw, "paidChannel");
  if (paidChannel) {
    return paidChannel.trim().toLowerCase().slice(0, SOURCE_MAX_LEN);
  }
  // 3. Referrer host — search/social by name, other external hosts as
  // "referral". A referrer that is the shop ITSELF (internal navigation) is
  // not a source: the capture-time acqRaw.referrerInternal verdict decides
  // (it saw the shop's real domains — myshopify + order-status host — which
  // this read-time function cannot), with the landing-host comparison as
  // the fallback for bundles captured before the flag existed.
  const referrerInternal = acqRawBoolean(contract.acqRaw, "referrerInternal");
  const referrerHost = acqUrlHost(contract.acqReferringSite);
  const landingHost = acqUrlHost(contract.acqLandingSite);
  if (
    referrerHost &&
    referrerInternal !== true &&
    referrerHost !== landingHost
  ) {
    for (const { re, label } of REFERRER_SOURCES) {
      if (re.test(referrerHost)) return label;
    }
    return "referral";
  }
  // 4. Shopify channel. "web" from a WEBHOOK-captured bundle with no
  // referrer is genuinely direct traffic; other channels (draft orders, app
  // ids) keep their names. Rows that never proved the referrer's absence —
  // no bundle at all, or an import-passthrough bundle whose source CSV
  // simply lacked referrer columns — never claim "direct".
  if (contract.acqSourceName && contract.acqSourceName.trim() !== "") {
    const channel = contract.acqSourceName.trim().toLowerCase();
    if (
      channel === "web" &&
      contract.acqRaw != null &&
      acqRawBoolean(contract.acqRaw, "importPassthrough") !== true
    ) {
      return "direct";
    }
    return channel.slice(0, SOURCE_MAX_LEN);
  }
  return UNKNOWN_SEGMENT_VALUE;
}

export function contractDeviceValue(
  contract: Pick<SegmentSourceContract, "acqDeviceType">,
): string {
  const device = contract.acqDeviceType?.trim().toLowerCase() ?? "";
  return (DEVICE_TYPES as readonly string[]).includes(device)
    ? device
    : UNKNOWN_SEGMENT_VALUE;
}

export function contractValueBandValue(
  contract: Pick<SegmentSourceContract, "acqOrderValueBand">,
): string {
  const band = contract.acqOrderValueBand?.trim().toLowerCase() ?? "";
  return VALUE_BAND_RE.test(band) ? band : UNKNOWN_SEGMENT_VALUE;
}

/**
 * Buy-box design the subscriber came through (v1.26.0): the write-once
 * originDesignKey, validated against the preset-key shape so a hostile or
 * malformed stored value buckets as unknown rather than leaking into the
 * filter bar. Foreign / pre-tracking / unattributed contracts read unknown.
 */
export function contractDesignValue(
  contract: Pick<SegmentSourceContract, "originDesignKey">,
): string {
  const key = contract.originDesignKey?.trim().toLowerCase() ?? "";
  return DESIGN_KEY_RE.test(key) ? key : UNKNOWN_SEGMENT_VALUE;
}

/**
 * Which buy-box option was preselected at the first checkout (v1.26.0):
 * "sub" | "one" from originDesignPreselect, else unknown — including the
 * storefront's explicit "u" (unknown) token, which the facts writer stores
 * as null.
 */
export function contractPreselectValue(
  contract: Pick<SegmentSourceContract, "originDesignPreselect">,
): string {
  const preselect = contract.originDesignPreselect?.trim().toLowerCase() ?? "";
  return (DESIGN_PRESELECT_SEGMENT_VALUES as readonly string[]).includes(
    preselect,
  )
    ? preselect
    : UNKNOWN_SEGMENT_VALUE;
}

/**
 * First-order discount depth from the mirrored origin money:
 * discount ÷ (total + discount) — the discount's share of the PRE-discount
 * order value (the total is mirrored as charged, i.e. post-discount).
 * "unknown" while the origin total is not captured (backfill pending /
 * imported book with no origin order); "none" when a captured order carried
 * no discount.
 */
export function firstOrderDiscountBand(
  contract: Pick<
    SegmentSourceContract,
    "originOrderTotalCents" | "originOrderDiscountCents"
  >,
): DiscountBand | typeof UNKNOWN_SEGMENT_VALUE {
  const total = contract.originOrderTotalCents;
  if (total == null) return UNKNOWN_SEGMENT_VALUE;
  const discount = Math.max(0, contract.originOrderDiscountCents ?? 0);
  if (discount === 0) return "none";
  const preDiscount = Math.max(0, total) + discount;
  if (preDiscount <= 0) return UNKNOWN_SEGMENT_VALUE;
  const pct = (discount / preDiscount) * 100;
  if (pct < 10) return "1_10";
  if (pct < 20) return "10_20";
  if (pct < 30) return "20_30";
  return "30_plus";
}

/**
 * Whether a contract holds a non-gift line of the (numeric-normalized)
 * product. Lines whose productId is neither numeric nor a Product GID (the
 * mirror writes "" when Shopify reports no product — deleted products) can
 * never match: they are also excluded from the filter options, so the
 * dimension stays consistent end to end.
 */
export function contractHasProduct(
  contract: Pick<SegmentSourceContract, "lines">,
  numericProductId: string,
): boolean {
  return contract.lines.some(
    (line) =>
      !line.isGift && normalizeProductId(line.productId) === numericProductId,
  );
}

/** THE segment predicate — every dimension present must match (AND). */
export function contractMatchesSegment(
  contract: SegmentSourceContract,
  segment: AnalyticsSegment,
): boolean {
  if (segment.country != null && contractCountryValue(contract) !== segment.country) {
    return false;
  }
  if (
    segment.language != null &&
    contractLanguageValue(contract) !== segment.language
  ) {
    return false;
  }
  if (segment.source != null && contractSourceValue(contract) !== segment.source) {
    return false;
  }
  if (
    segment.productId != null &&
    !contractHasProduct(contract, segment.productId)
  ) {
    return false;
  }
  if (
    segment.discountBand != null &&
    firstOrderDiscountBand(contract) !== segment.discountBand
  ) {
    return false;
  }
  if (segment.device != null && contractDeviceValue(contract) !== segment.device) {
    return false;
  }
  if (
    segment.valueBand != null &&
    contractValueBandValue(contract) !== segment.valueBand
  ) {
    return false;
  }
  if (segment.design != null && contractDesignValue(contract) !== segment.design) {
    return false;
  }
  if (
    segment.preselect != null &&
    contractPreselectValue(contract) !== segment.preselect
  ) {
    return false;
  }
  return true;
}

// ── Resolution against the database ──────────────────────────────────────────

const SEGMENT_SOURCE_SELECT = {
  id: true,
  locale: true,
  deliveryAddress: true,
  acqCountryCode: true,
  acqSourceName: true,
  acqUtm: true,
  acqReferringSite: true,
  acqLandingSite: true,
  acqRaw: true,
  acqDeviceType: true,
  acqOrderValueBand: true,
  originOrderTotalCents: true,
  originOrderDiscountCents: true,
  originDesignKey: true,
  originDesignPreselect: true,
  lines: { select: { productId: true, isGift: true, title: true } },
} as const;

/**
 * One scan of the countable book with everything the predicate and the
 * option builder need. Exported so a caller using BOTH (the analytics
 * loader) fetches once and passes the list to each — the heaviest query of
 * the filtered path must not run twice per page view.
 */
export async function loadSegmentSourceContracts(
  shopId: string,
): Promise<SegmentSourceContract[]> {
  return prisma.subscriptionContract.findMany({
    where: { shopId, ...COUNTABLE_CONTRACT },
    select: SEGMENT_SOURCE_SELECT,
  });
}

/**
 * Resolve a segment to the countable contract ids it contains. Null when the
 * segment is empty (= no filter — callers keep their persisted/whole-book
 * path); an empty ARRAY is a real result (nobody matches). One scan of the
 * countable book (or the caller's preloaded list), filtered in JS through
 * the one predicate above — the derived dimensions (country fallback chain,
 * utm-vs-channel source, discount ratio bands) are deliberately not
 * re-expressed as SQL so a second divergent definition cannot exist.
 *
 * HONEST LIMIT: consumers feed the returned ids into `id: { in: [...] }`
 * filters, which hit Postgres' ~32k bind-parameter ceiling on a broad
 * segment over a very large book. This app is single-merchant with a book
 * orders of magnitude below that; revisit with a join/temp-table resolution
 * if the book ever approaches it.
 */
export async function resolveSegmentContractIds(
  shopId: string,
  segment: AnalyticsSegment,
  opts: { contracts?: SegmentSourceContract[] } = {},
): Promise<string[] | null> {
  if (isEmptySegment(segment)) return null;
  const contracts = opts.contracts ?? (await loadSegmentSourceContracts(shopId));
  return contracts
    .filter((contract) => contractMatchesSegment(contract, segment))
    .map((contract) => contract.id);
}

// ── Filter-bar options ───────────────────────────────────────────────────────

export interface SegmentOption {
  value: string;
  /** Display label — the value itself except for products (line title). */
  label: string;
  /** Countable contracts carrying this value (all statuses, all time). */
  count: number;
}

export interface SegmentOptions {
  totalContracts: number;
  countries: SegmentOption[];
  languages: SegmentOption[];
  sources: SegmentOption[];
  products: SegmentOption[];
  discountBands: SegmentOption[];
  devices: SegmentOption[];
  valueBands: SegmentOption[];
  /** v1.26.0: buy-box design keys seen on the countable book (+ unknown). */
  designs: SegmentOption[];
  /** v1.26.0: "sub" / "one" / unknown, in that fixed order. */
  preselects: SegmentOption[];
}

/** Cap per dimension so a high-cardinality value space cannot flood the UI. */
const MAX_OPTIONS_PER_DIMENSION = 40;

/**
 * The value space of every dimension with contract counts, for the analytics
 * filter bar. Counts are over the whole countable book (all statuses — the
 * cohort triangle spans all history, so the filter options must too). Sorted
 * most-common first; the explicit "unknown" bucket sorts last so real values
 * lead. Value-band options sort by their numeric edge (they are ordinal, not
 * frequency-ranked).
 */
export async function getSegmentOptions(
  shopId: string,
  opts: { contracts?: SegmentSourceContract[] } = {},
): Promise<SegmentOptions> {
  const contracts = opts.contracts ?? (await loadSegmentSourceContracts(shopId));

  const tally = (values: Iterable<string>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };

  const toOptions = (
    counts: Map<string, number>,
    labelFor: (value: string) => string = (value) => value,
  ): SegmentOption[] => {
    const options = [...counts.entries()]
      .map(([value, count]) => ({ value, label: labelFor(value), count }))
      .sort((a, b) => {
        const aUnknown = a.value === UNKNOWN_SEGMENT_VALUE ? 1 : 0;
        const bUnknown = b.value === UNKNOWN_SEGMENT_VALUE ? 1 : 0;
        return aUnknown - bUnknown || b.count - a.count || a.value.localeCompare(b.value);
      });
    // The cap applies to REAL values only; the unknown bucket (sorted last)
    // is always kept — an imported book with no acquisition data must stay
    // visibly "unknown" even on a 40+-value dimension, per the module doc.
    const unknown = options.find((o) => o.value === UNKNOWN_SEGMENT_VALUE);
    const capped = options
      .filter((o) => o.value !== UNKNOWN_SEGMENT_VALUE)
      .slice(0, MAX_OPTIONS_PER_DIMENSION);
    return unknown ? [...capped, unknown] : capped;
  };

  // Products: count contracts (not lines) per product, label by the most
  // recently seen line title for that product. Lines with an
  // un-normalizable productId (the mirror writes "" for deleted products)
  // are skipped: their option value would be the filter bar's
  // "All products" sentinel, silently unfiltering instead of filtering —
  // and the predicate could never match them anyway.
  const productCounts = new Map<string, number>();
  const productLabels = new Map<string, string>();
  for (const contract of contracts) {
    const seen = new Set<string>();
    for (const line of contract.lines) {
      if (line.isGift) continue;
      const id = normalizeProductId(line.productId);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      productCounts.set(id, (productCounts.get(id) ?? 0) + 1);
      if (line.title) productLabels.set(id, line.title);
    }
  }

  const valueBandOrder = (band: string): number => {
    if (band === UNKNOWN_SEGMENT_VALUE) return Number.MAX_SAFE_INTEGER;
    const lead = Number(band.split("_")[0]);
    return Number.isFinite(lead) ? lead : Number.MAX_SAFE_INTEGER - 1;
  };

  const valueBands = toOptions(
    tally(contracts.map(contractValueBandValue)),
  ).sort((a, b) => valueBandOrder(a.value) - valueBandOrder(b.value));

  const discountBandOrder = new Map<string, number>(
    [...DISCOUNT_BANDS, UNKNOWN_SEGMENT_VALUE].map((band, i) => [band, i]),
  );
  const discountBands = toOptions(
    tally(contracts.map(firstOrderDiscountBand)),
  ).sort(
    (a, b) =>
      (discountBandOrder.get(a.value) ?? 99) -
      (discountBandOrder.get(b.value) ?? 99),
  );

  // Preselect is a two-value vocabulary: fixed order (sub, one, unknown)
  // rather than frequency, so the select reads the same on every book.
  const preselectOrder = new Map<string, number>(
    [...DESIGN_PRESELECT_SEGMENT_VALUES, UNKNOWN_SEGMENT_VALUE].map(
      (value, i) => [value, i],
    ),
  );
  const preselects = toOptions(
    tally(contracts.map(contractPreselectValue)),
  ).sort(
    (a, b) =>
      (preselectOrder.get(a.value) ?? 99) - (preselectOrder.get(b.value) ?? 99),
  );

  return {
    totalContracts: contracts.length,
    countries: toOptions(tally(contracts.map(contractCountryValue))),
    languages: toOptions(tally(contracts.map(contractLanguageValue))),
    sources: toOptions(tally(contracts.map(contractSourceValue))),
    products: toOptions(productCounts, (id) => productLabels.get(id) ?? id),
    discountBands,
    devices: toOptions(tally(contracts.map(contractDeviceValue))),
    valueBands,
    designs: toOptions(tally(contracts.map(contractDesignValue))),
    preselects,
  };
}
