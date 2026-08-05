/**
 * Acquisition enrichment [core / data-capture] — pure builders for the
 * schemaVersion-2 acquisition record stored in
 * `SubscriptionContract.acquisitionJson`.
 *
 * Sources: the storefront widget writes `_cellexia_*` cart attributes
 * (see extensions/treatment-widgets/assets/cellexia-widgets.js →
 * CX.buildCartAttributes); Shopify copies them onto the order as
 * `note_attributes` and onto the contract as `customAttributes`. The webhook
 * handlers feed either list into `buildAcquisition` together with the
 * shipping address / locale / order metadata and merge the result over
 * whatever is already stored via `mergeAcquisition` — earlier keys are never
 * lost, so ORDERS_CREATE and SUBSCRIPTION_CONTRACTS_CREATE may arrive in any
 * order.
 *
 * No I/O in this file (no Prisma, no Shopify) — everything is unit-tested in
 * tests/core/acquisition.test.ts.
 */

// ─────────────────────────── Input shapes ───────────────────────────────────

/** Order `note_attributes` use {name,value}; contract customAttributes {key,value}. */
export interface AcquisitionAttributeInput {
  key?: string | null;
  name?: string | null;
  value?: string | null;
}

/**
 * Tolerant address shape: accepts the order webhook's snake_case
 * `shipping_address` and the contract mirror's camelCase delivery address.
 */
export type AcquisitionAddressInput = Record<string, string | null | undefined>;

export interface AcquisitionInput {
  attributes?: AcquisitionAttributeInput[] | null;
  shippingAddress?: AcquisitionAddressInput | null;
  customerLocale?: string | null;
  orderName?: string | null;
  sourceName?: string | null;
  /** Initial plan lines (order selling-plan lines / contract lines). */
  lines?: Array<{ quantity?: number | null }> | null;
  /** Purchase moment — order created_at / contract createdAt; defaults now. */
  capturedAt?: Date | string | null;
}

export interface AcquisitionGeo {
  countryCode?: string;
  country?: string;
  city?: string;
  province?: string;
  /** First 3 characters of the postal code — coarse geo, never the full zip. */
  zip3?: string;
}

/**
 * Declared as a type alias (not an interface) on purpose: the implicit index
 * signature lets records flow into `mergeAcquisition`'s Record parameter.
 */
export type AcquisitionRecordV2 = {
  schemaVersion: 2;
  capturedAt: string;
  channel: string;
  utm?: Record<string, string>;
  referrer?: string;
  landingPage?: string;
  device?: string;
  widgetVersion?: string;
  visitor?: string;
  timeToPurchaseSeconds?: number;
  unitsInitial?: number;
  linesInitial?: number;
  geo?: AcquisitionGeo;
  customerLocale?: string;
  orderName?: string;
  sourceName?: string;
  /** Full raw attribute snapshot — kept verbatim even when unused today. */
  raw?: Record<string, string>;
};

// ─────────────────────────── Attribute helpers ─────────────────────────────

/** Normalise {key|name, value} pairs → [{key, value}] with non-empty strings. */
export function normalizeAttributes(
  attributes: AcquisitionAttributeInput[] | null | undefined,
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const attr of attributes ?? []) {
    const key = (attr.key ?? attr.name ?? "").trim();
    const value = (attr.value ?? "").trim();
    if (key === "" || value === "") continue;
    out.push({ key, value });
  }
  return out;
}

function attributeMap(
  attributes: AcquisitionAttributeInput[] | null | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { key, value } of normalizeAttributes(attributes)) {
    // First occurrence wins — replays/duplicates never overwrite.
    if (map[key] === undefined) map[key] = value;
  }
  return map;
}

/** Parse the widget's `_cellexia_utm` JSON snapshot; never throws. */
function parseUtmSnapshot(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") out[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// ─────────────────────────── Channel derivation ────────────────────────────

/** utm_source (lowercased) → canonical channel. */
const SOURCE_TO_CHANNEL: Record<string, string> = {
  facebook: "meta-ads",
  fb: "meta-ads",
  meta: "meta-ads",
  "meta-ads": "meta-ads",
  instagram: "meta-ads",
  ig: "meta-ads",
  google: "google",
  googleads: "google",
  "google-ads": "google",
  adwords: "google",
  youtube: "google",
  klaviyo: "klaviyo",
  email: "klaviyo",
  newsletter: "klaviyo",
  tiktok: "tiktok",
};

/**
 * Referrer hosts of the big content platforms: untagged traffic from them is
 * "organic" (search/social without campaign params); klaviyo link domains
 * stay attributed to klaviyo; any other external host is a "referral".
 */
const ORGANIC_HOST_TOKENS = [
  "google.",
  "facebook.",
  "instagram.",
  "tiktok.",
  "pinterest.",
];

function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.trim().toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

function sanitizeSource(source: string): string {
  return source.trim().toLowerCase().slice(0, 64);
}

export interface ChannelSignals {
  utmSource?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  referrer?: string | null;
}

/**
 * Derive the acquisition channel:
 * 1. `utm_source` — mapped to meta-ads/google/klaviyo/tiktok; an unmapped but
 *    present source is kept verbatim (lowercased) so no first-party signal is
 *    ever collapsed into "unknown".
 * 2. Paid click ids — gclid → google, fbclid → meta-ads.
 * 3. Referrer host — google/facebook/instagram/tiktok/pinterest → "organic"
 *    (untagged platform traffic), klaviyo hosts → "klaviyo", any other
 *    external host → "referral".
 * 4. Nothing at all → "direct".
 */
export function deriveChannel(signals: ChannelSignals): string {
  const source = signals.utmSource?.trim();
  if (source) {
    const normalized = sanitizeSource(source);
    return SOURCE_TO_CHANNEL[normalized] ?? normalized;
  }
  if (signals.gclid) return "google";
  if (signals.fbclid) return "meta-ads";
  const host = referrerHost(signals.referrer);
  if (host) {
    if (host.includes("klaviyo")) return "klaviyo";
    if (ORGANIC_HOST_TOKENS.some((token) => host.includes(token))) {
      return "organic";
    }
    return "referral";
  }
  return "direct";
}

// ─────────────────────────── Geo helpers ───────────────────────────────────

/** Coarse postal prefix — "69003" → "690", "SW1A 1AA" → "SW1"; null if empty. */
export function zip3(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const cleaned = zip.replace(/\s+/g, "").toUpperCase();
  if (cleaned === "") return null;
  return cleaned.slice(0, 3);
}

function pickAddressField(
  address: AcquisitionAddressInput,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function buildGeo(
  address: AcquisitionAddressInput | null | undefined,
): AcquisitionGeo | undefined {
  if (!address) return undefined;
  const geo: AcquisitionGeo = {};
  const countryCode = pickAddressField(address, ["country_code", "countryCode"]);
  const country = pickAddressField(address, ["country"]);
  const city = pickAddressField(address, ["city"]);
  const province = pickAddressField(address, [
    "province",
    "provinceCode",
    "province_code",
  ]);
  const zip = zip3(pickAddressField(address, ["zip", "postalCode", "postal_code"]));
  if (countryCode) geo.countryCode = countryCode.toUpperCase();
  if (country) geo.country = country;
  if (city) geo.city = city;
  if (province) geo.province = province;
  if (zip) geo.zip3 = zip;
  return Object.keys(geo).length > 0 ? geo : undefined;
}

// ─────────────────────────── Record builder ────────────────────────────────

function parseInstant(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build the schemaVersion-2 acquisition record from one ingestion event
 * (ORDERS_CREATE or SUBSCRIPTION_CONTRACTS_CREATE). Fields the event cannot
 * supply are simply absent — `mergeAcquisition` fills them in whenever the
 * other webhook (or a future re-sync) knows more.
 */
export function buildAcquisition(input: AcquisitionInput): AcquisitionRecordV2 {
  const attrs = attributeMap(input.attributes);

  // UTM: the widget's first-touch snapshot wins; loose top-level utm_* /
  // gclid / fbclid attributes (landing-page tooling) fill remaining gaps.
  const utm = parseUtmSnapshot(attrs["_cellexia_utm"]);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("utm_") || key === "gclid" || key === "fbclid") {
      if (utm[key] === undefined) utm[key] = value;
    }
  }

  const referrer = attrs["_cellexia_referrer"];
  const capturedAtMs = parseInstant(input.capturedAt) ?? Date.now();

  const record: AcquisitionRecordV2 = {
    schemaVersion: 2,
    capturedAt: new Date(capturedAtMs).toISOString(),
    channel: deriveChannel({
      utmSource: utm["utm_source"],
      gclid: utm["gclid"],
      fbclid: utm["fbclid"],
      referrer,
    }),
  };

  if (Object.keys(utm).length > 0) record.utm = utm;
  if (referrer) record.referrer = referrer;
  if (attrs["_cellexia_landing"]) record.landingPage = attrs["_cellexia_landing"];
  if (attrs["_cellexia_device"]) record.device = attrs["_cellexia_device"];
  if (attrs["_cellexia_widget"]) record.widgetVersion = attrs["_cellexia_widget"];
  if (attrs["_cellexia_visitor"]) record.visitor = attrs["_cellexia_visitor"];

  // Time from first widget impression to purchase, clamped ≥ 0 (clock skew
  // or a stale snapshot must never produce negative durations).
  const firstSeenMs = parseInstant(attrs["_cellexia_first_seen"]);
  if (firstSeenMs != null) {
    record.timeToPurchaseSeconds = Math.max(
      0,
      Math.round((capturedAtMs - firstSeenMs) / 1000),
    );
  }

  const lines = (input.lines ?? []).filter((l) => l != null);
  if (lines.length > 0) {
    record.unitsInitial = lines.reduce(
      (sum, line) => sum + Math.max(0, Math.round(line.quantity ?? 0)),
      0,
    );
    record.linesInitial = lines.length;
  } else {
    const qty = Number.parseInt(attrs["_cellexia_qty"] ?? "", 10);
    if (Number.isFinite(qty) && qty > 0) record.unitsInitial = qty;
  }

  const geo = buildGeo(input.shippingAddress);
  if (geo) record.geo = geo;

  if (input.customerLocale) record.customerLocale = input.customerLocale;
  if (input.orderName) record.orderName = input.orderName;
  if (input.sourceName) record.sourceName = input.sourceName;

  // Everything raw is kept: the full attribute snapshot, even keys nothing
  // consumes today — future features inherit the dataset.
  if (Object.keys(attrs).length > 0) record.raw = { ...attrs };

  return record;
}

// ─────────────────────────── Merge semantics ───────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Merge a new acquisition record over the stored one. Rules:
 * - keys unknown to the new record are preserved verbatim (never lose data);
 * - null/undefined in the new record never clobber an existing value;
 * - plain-object values (utm, geo, raw, legacy custom) merge one level deep,
 *   new sub-keys winning, existing sub-keys surviving.
 */
export function mergeAcquisition(
  existing: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      const merged: Record<string, unknown> = { ...prev };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue != null) merged[innerKey] = innerValue;
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}
