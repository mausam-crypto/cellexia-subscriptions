/**
 * Offer engine — widget resolution, targeting, experiments, cadence defaults.
 *
 * `resolveWidget` is the single storefront entry point (via the app proxy):
 * it loads active WidgetConfig rows, applies targeting by priority, assigns
 * (and persists) a deterministic experiment variant, merges settings over the
 * brand-voice defaults, and attaches the quantity→cadence defaults from the
 * product's SellingPlanConfig.
 *
 * The pure decision helpers (targeting match, deterministic bucketing, deep
 * settings merge, cadence lookup) are exported standalone so they can be
 * unit-tested without any I/O.
 */
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { parseJson, WIDGET_TYPES } from "~/types/domain";
import type { ExperimentStatus, WidgetType } from "~/types/domain";

// ─────────────────────────────── Types ────────────────────────────────────

export interface WidgetTargeting {
  productIds?: string[];
  markets?: string[];
  trafficSources?: string[];
  returningOnly?: boolean;
  intentBands?: string[];
}

export interface ResolveWidgetParams {
  productId?: string;
  market?: string;
  trafficSource?: string;
  returning?: boolean;
  /** Stable anonymous token or Shopify customer id — experiment subject key. */
  visitorKey?: string;
  intentBand?: string;
  /** Optional filter: resolve only this widget type (e.g. per theme block). */
  widgetType?: WidgetType;
}

export type WidgetSettings = Record<string, unknown>;

export interface ResolvedWidget {
  widgetType: WidgetType;
  settings: WidgetSettings;
  experimentKey?: string;
  /** Quantity → default delivery cadence in weeks, e.g. {"1": 4, "2": 8}. */
  cadenceDefaults: Record<string, number>;
}

/** Structural subset of a WidgetConfig row used by the pure matching logic. */
export interface WidgetConfigLike {
  id?: string;
  widgetType: string;
  targetingJson: string;
  settingsJson: string;
  priority: number;
  experimentId?: string | null;
}

export interface ExperimentVariant {
  key: string;
  weight: number;
  /** Variant setting overrides; JSON string per schema, object also accepted. */
  settingsJson?: string | Record<string, unknown>;
}

/** Structural subset of SellingPlanConfig used by the pure cadence helpers. */
export interface SellingPlanConfigLike {
  plansJson: string;
  quantityDefaultsJson: string | null;
}

export interface QuantityDefaultsShape {
  default?: Record<string, number>;
  byProduct?: Record<string, Record<string, number>>;
  /** Legacy flat shape support: {"1": 4, "2": 8, ...}. */
  [key: string]: unknown;
}

interface PlanDefinition {
  name?: string;
  intervalWeeks?: number;
  percentOff?: number;
  shopifyPlanId?: string;
  /** Committed Treatment Plan: minimum deliveries (meaningful when >= 2). */
  minDeliveries?: number;
  /** Committed Treatment Plan marker. */
  committed?: boolean;
}

// ─────────────────────────────── Default widget copy ──────────────────────
//
// Brand voice (docs/BRAND.md): Continuous Treatment Plan — never raw
// "subscription" jargon; always the reassurance "Adjust, delay or cancel
// online"; premium and calm, no pressure tactics. "{percent}" placeholders are
// substituted client-side from the product's selling plan data.

export const DEFAULT_WIDGET_SETTINGS: Record<WidgetType, WidgetSettings> = {
  // Widget A — treatment choice on the PDP.
  TREATMENT_CHOICE: {
    // Presentation style — "choice" (default chooser cards), "max"
    // (Subscription Max: one confident full-width Continuous Treatment card,
    // pre-selected, no Basic Purchase card and no comparison framing; the
    // one-time purchase is demoted to a quiet text link below add-to-cart,
    // and the Widget E comparison nudge is off by default) or "ultra"
    // (Subscription Max Ultra: the subscription is not presented as a
    // concept at all — no card, no heading, no plan name, no bullets and no
    // savings framing; the plan price simply IS the price. Only the optional
    // plain price line, quantity pills, cadence/per-month lines, the
    // advanced rhythm details, add-to-cart and the neutral one-time link
    // render; the Widget E nudge and the committed card NEVER render in
    // ultra — cards are choice-framing). These three strings are the whole
    // whitelist: the storefront's CX.resolveStyle drops anything else and
    // falls back to the Liquid-resolved style, so no server-side validation
    // beyond this comment exists (the settings merge is generic). Liquid
    // resolves the style first (block default_style + market_styles); a
    // settings override ({"style": "max"} / {"style": "ultra"} /
    // {"style": "choice"}, typically market-targeted) wins after the
    // widget-config fetch — the storefront JS restyles the root. `style` is
    // INTENTIONALLY absent from these defaults and applies ONLY when a
    // merchant explicitly sets it: a default here would make resolveWidget
    // send `style` on EVERY config response and restyle every
    // Liquid-resolved max/ultra widget back to "choice" (CX.resolveStyle
    // falls back to the Liquid-resolved style when the config carries none).
    // Purely visual: pricing and selling plans are identical between styles.
    title: "CHOOSE YOUR TREATMENT",
    continuous: {
      label: "CONTINUOUS TREATMENT — RECOMMENDED",
      bullets: [
        "Designed for continued visible improvement",
        "Save {percent}%",
        "Adjust, delay or cancel online",
      ],
      badge: "RECOMMENDED",
      selectedByDefault: true,
    },
    basic: {
      label: "BASIC PURCHASE",
      bullets: [
        "One delivery",
        "Standard price",
        "No ongoing treatment benefits",
      ],
    },
    // Committed Treatment Plan card (shared contract). `committed` is
    // INTENTIONALLY absent from these defaults: it must reach the storefront
    // only when a config/variant explicitly sets it, otherwise the config
    // fetch would hide every Liquid-enabled committed card (the storefront's
    // `cm.enabled === false` hide fires ~0.5s after first paint, flipping a
    // position-1 committed pre-selection back to treatment with a visible
    // price jump) and stomp the merchant's Liquid terms copy with the
    // English app defaults — the same failure class as a default `style`.
    // Shape when a config sets it: {enabled, position (1 = first card and
    // pre-selected default, 2 = second, 3 = third), percentOff,
    // minDeliveries, termsShort, termsFull} — {n} / {p} placeholders are
    // substituted client-side from minDeliveries / percentOff. When
    // enabled === true, resolveWidget attaches `planIds` (the committed
    // selling plan ids) so the storefront JS can identify them — Liquid does
    // not expose billingPolicy minCycles.
    reassurance: "Adjust, delay or cancel online.",
  },
  // Widget B — quantity & cadence selection.
  QUANTITY_CADENCE: {
    title: "YOUR DELIVERY RHYTHM",
    quantityLabel: "Quantity per delivery",
    cadenceLabel: "Delivery every",
    cadenceUnit: "weeks",
    cadenceHint:
      "Based on your quantity, we recommend a delivery every {weeks} weeks — timed so you never run out.",
    reassurance: "Adjust, delay or cancel online.",
  },
  // Widget D — routine builder (rendered by the customer portal).
  ROUTINE_BUILDER: {
    title: "BUILD YOUR ROUTINE",
    body: "Add complementary steps to your treatment plan — aligned to one delivery, one box.",
    reassurance: "Adjust, delay or cancel online.",
  },
  // Widget E — nudge after a one-time (basic) purchase.
  POST_ONE_TIME: {
    title: "CONTINUE YOUR TREATMENT",
    body: "Visible results build with continued use. Move to a Continuous Treatment Plan and your next delivery arrives right on time — with your plan price locked in.",
    cta: "START MY TREATMENT PLAN",
    dismiss: "Not now",
    reassurance: "Adjust, delay or cancel online.",
  },
  // Widget F — cart conversion of one-time lines.
  CART_CONVERSION: {
    title: "MAKE IT A TREATMENT PLAN",
    body: "Switch this delivery to a Continuous Treatment Plan and save {percent}% on every delivery.",
    cta: "SWITCH & SAVE {percent}%",
    keepOneTime: "KEEP AS ONE-TIME",
    reassurance: "Adjust, delay or cancel online.",
  },
};

// ─────────────────────────────── Pure helpers ─────────────────────────────

export function isWidgetType(value: string): value is WidgetType {
  return (WIDGET_TYPES as readonly string[]).includes(value);
}

/** Storefront letter codes emitted by the theme extension's tele() → WidgetType. */
const WIDGET_LETTER_TO_TYPE: Record<string, WidgetType> = {
  A: "TREATMENT_CHOICE",
  B: "QUANTITY_CADENCE",
  D: "ROUTINE_BUILDER",
  E: "POST_ONE_TIME",
  F: "CART_CONVERSION",
};

/** Fields persisted in AnalyticsEvent.payloadJson for WIDGET_* telemetry. */
export interface WidgetTelemetryFields {
  widgetType: WidgetType | null;
  productId: string | null;
  variantKey: string | null;
  /** Named so metrics' isSubscriptionSelection() recognises plan-bearing events. */
  sellingPlanId: string | null;
  qty: number | null;
  experimentKey: string | null;
}

const MAX_TELEMETRY_FIELD_LENGTH = 100;

function truncate(value: string): string {
  return value.slice(0, MAX_TELEMETRY_FIELD_LENGTH);
}

/**
 * PURE — normalise a storefront telemetry body (the theme extension posts
 * `{ event, widget: 'A'|'B'|'E'|'F', productId, variantId, qty, planId,
 * experimentKey, visitor, path, ts }`; older/other clients may post
 * `widgetType` / `variantKey` directly) into the persisted payload fields.
 *
 * - `widgetType`: a valid WidgetType from `widgetType`, else mapped from the
 *   letter code in `widget`.
 * - `sellingPlanId`: from `planId` (string or number).
 * - `variantKey`: from `variantKey`, else derived from `experimentKey`
 *   (format `"experimentId:variantKey"` — see resolveWidget).
 */
export function extractWidgetTelemetry(
  body: Record<string, unknown>,
): WidgetTelemetryFields {
  const widgetType =
    typeof body.widgetType === "string" && isWidgetType(body.widgetType)
      ? body.widgetType
      : typeof body.widget === "string"
        ? (WIDGET_LETTER_TO_TYPE[body.widget] ?? null)
        : null;

  const productId =
    typeof body.productId === "string" || typeof body.productId === "number"
      ? truncate(String(body.productId))
      : null;

  const sellingPlanId =
    typeof body.planId === "string" || typeof body.planId === "number"
      ? truncate(String(body.planId))
      : null;

  const qty =
    typeof body.qty === "number" && Number.isFinite(body.qty) ? body.qty : null;

  const experimentKey =
    typeof body.experimentKey === "string" && body.experimentKey.length > 0
      ? truncate(body.experimentKey)
      : null;

  let variantKey: string | null = null;
  if (typeof body.variantKey === "string" && body.variantKey.length > 0) {
    variantKey = truncate(body.variantKey);
  } else if (experimentKey) {
    const colon = experimentKey.indexOf(":");
    if (colon >= 0 && colon < experimentKey.length - 1) {
      variantKey = experimentKey.slice(colon + 1);
    }
  }

  return { widgetType, productId, variantKey, sellingPlanId, qty, experimentKey };
}

/** Strip a GID down to its numeric tail so gid and bare ids compare equal. */
export function normalizeProductId(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

/**
 * A targeting rule matches when every restriction it declares is satisfied.
 * Empty / missing arrays mean "no restriction". A restriction on a dimension
 * the request did not provide does NOT match (safe default).
 */
export function matchesTargeting(
  targeting: WidgetTargeting,
  params: ResolveWidgetParams,
): boolean {
  if (targeting.productIds && targeting.productIds.length > 0) {
    if (!params.productId) return false;
    const wanted = normalizeProductId(params.productId);
    if (!targeting.productIds.some((id) => normalizeProductId(id) === wanted)) {
      return false;
    }
  }
  if (targeting.markets && targeting.markets.length > 0) {
    if (!params.market) return false;
    const market = params.market.toLowerCase();
    if (!targeting.markets.some((m) => m.toLowerCase() === market)) return false;
  }
  if (targeting.trafficSources && targeting.trafficSources.length > 0) {
    if (!params.trafficSource) return false;
    const src = params.trafficSource.toLowerCase();
    if (!targeting.trafficSources.some((s) => s.toLowerCase() === src)) {
      return false;
    }
  }
  if (targeting.returningOnly === true && params.returning !== true) {
    return false;
  }
  if (targeting.intentBands && targeting.intentBands.length > 0) {
    if (!params.intentBand) return false;
    const band = params.intentBand.toLowerCase();
    if (!targeting.intentBands.some((b) => b.toLowerCase() === band)) {
      return false;
    }
  }
  return true;
}

/**
 * Given configs sorted highest-priority-first, return the first matching
 * config for each widget type.
 */
export function pickFirstMatchPerType(
  configs: WidgetConfigLike[],
  params: ResolveWidgetParams,
): Partial<Record<WidgetType, WidgetConfigLike>> {
  const winners: Partial<Record<WidgetType, WidgetConfigLike>> = {};
  for (const config of configs) {
    if (!isWidgetType(config.widgetType)) continue;
    if (winners[config.widgetType]) continue;
    const targeting = parseJson<WidgetTargeting>(config.targetingJson, {});
    if (matchesTargeting(targeting, params)) {
      winners[config.widgetType] = config;
    }
  }
  return winners;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge overrides over defaults. Arrays and scalars are replaced. */
export function mergeSettings(
  base: WidgetSettings,
  override: WidgetSettings,
): WidgetSettings {
  const out: WidgetSettings = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeSettings(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** FNV-1a 32-bit hash — deterministic, dependency-free. */
export function hashSubjectKey(subjectKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < subjectKey.length; i++) {
    h ^= subjectKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic weighted bucketing: the same subjectKey always lands in the
 * same variant for a given variant list. Non-positive weights are ignored;
 * if no weight is positive the first variant wins.
 */
export function bucketForSubject(
  subjectKey: string,
  variants: Array<{ key: string; weight: number }>,
): string {
  if (variants.length === 0) {
    throw new Error("bucketForSubject: at least one variant is required");
  }
  const weights = variants.map((v) =>
    Number.isFinite(v.weight) && v.weight > 0 ? v.weight : 0,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return variants[0].key;
  const point = (hashSubjectKey(subjectKey) / 0x100000000) * total;
  let cumulative = 0;
  for (let i = 0; i < variants.length; i++) {
    cumulative += weights[i];
    if (point < cumulative) return variants[i].key;
  }
  return variants[variants.length - 1].key;
}

/**
 * Resolve the quantity→weeks map for one product from a config's
 * quantityDefaultsJson. Shape:
 *   {"default": {"1": 4, "2": 8, "3": 12}, "byProduct": {"<gid>": {...}}}
 * The legacy flat shape {"1": 4, "2": 8} is also accepted.
 */
export function cadenceDefaultsForProduct(
  config: SellingPlanConfigLike,
  productId: string,
): Record<string, number> {
  const parsed = parseJson<QuantityDefaultsShape>(
    config.quantityDefaultsJson,
    {},
  );
  const out: Record<string, number> = {};

  const collect = (source: unknown) => {
    if (!isPlainObject(source)) return;
    for (const [key, value] of Object.entries(source)) {
      const qty = Number.parseInt(key, 10);
      const weeks = typeof value === "number" ? value : Number.NaN;
      if (Number.isFinite(qty) && qty > 0 && Number.isFinite(weeks) && weeks > 0) {
        out[String(qty)] = weeks;
      }
    }
  };

  if (isPlainObject(parsed.default) || isPlainObject(parsed.byProduct)) {
    collect(parsed.default);
    if (productId && isPlainObject(parsed.byProduct)) {
      const wanted = normalizeProductId(productId);
      for (const [gid, overrides] of Object.entries(parsed.byProduct)) {
        if (normalizeProductId(gid) === wanted) collect(overrides);
      }
    }
  } else {
    // Legacy flat map.
    collect(parsed);
  }
  return out;
}

/** Pick a cadence from a defaults map: exact, else nearest lower, else nearest higher. */
export function cadenceFromDefaults(
  defaults: Record<string, number>,
  qty: number,
): number | null {
  const exact = defaults[String(qty)];
  if (typeof exact === "number") return exact;
  const entries = Object.entries(defaults)
    .map(([k, v]) => ({ qty: Number.parseInt(k, 10), weeks: v }))
    .filter((e) => Number.isFinite(e.qty) && e.qty > 0)
    .sort((a, b) => a.qty - b.qty);
  if (entries.length === 0) return null;
  let candidate: number | null = null;
  for (const entry of entries) {
    if (entry.qty <= qty) candidate = entry.weeks;
  }
  if (candidate !== null) return candidate;
  return entries[0].weeks; // qty below the smallest configured quantity
}

const FALLBACK_CADENCE_WEEKS = 4;

/**
 * Default delivery cadence (weeks) for a quantity of a product under a config.
 * Falls back to the first plan's intervalWeeks, then to 4 weeks.
 */
export function cadenceDefaultForQuantity(
  config: SellingPlanConfigLike,
  productId: string,
  qty: number,
): number {
  const defaults = cadenceDefaultsForProduct(config, productId);
  const fromDefaults = cadenceFromDefaults(defaults, qty);
  if (fromDefaults !== null) return fromDefaults;
  const plans = parseJson<PlanDefinition[]>(config.plansJson, []);
  const firstInterval = plans.find(
    (p) => typeof p.intervalWeeks === "number" && p.intervalWeeks > 0,
  )?.intervalWeeks;
  return firstInterval ?? FALLBACK_CADENCE_WEEKS;
}

function variantSettings(variant: ExperimentVariant): WidgetSettings {
  if (typeof variant.settingsJson === "string") {
    return parseJson<WidgetSettings>(variant.settingsJson, {});
  }
  return variant.settingsJson ?? {};
}

// ─────────────────────────────── I/O: resolution ──────────────────────────

const RUNNING: ExperimentStatus = "RUNNING";

/**
 * Persist-or-read the experiment assignment for a subject. Deterministic
 * bucketing means a lost race still yields the same variant.
 */
async function getOrCreateAssignment(
  experimentId: string,
  subjectKey: string,
  variants: ExperimentVariant[],
): Promise<string> {
  const existing = await prisma.experimentAssignment.findUnique({
    where: { experimentId_subjectKey: { experimentId, subjectKey } },
  });
  if (existing) return existing.variantKey;
  const variantKey = bucketForSubject(subjectKey, variants);
  try {
    await prisma.experimentAssignment.create({
      data: { experimentId, subjectKey, variantKey },
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== "P2002") throw e;
    const winner = await prisma.experimentAssignment.findUnique({
      where: { experimentId_subjectKey: { experimentId, subjectKey } },
    });
    if (winner) return winner.variantKey;
  }
  return variantKey;
}

/**
 * The product's SellingPlanConfig (best local match): a config whose
 * byProduct overrides mention the product, else the most recently updated
 * active config. Feeds both cadence defaults and committed plan ids.
 */
async function sellingPlanConfigForShopProduct(
  shop: string,
  productId?: string,
): Promise<SellingPlanConfigLike | null> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (configs.length === 0) return null;
  let chosen = configs[0];
  if (productId) {
    const wanted = normalizeProductId(productId);
    const withOverride = configs.find((config) => {
      const parsed = parseJson<QuantityDefaultsShape>(
        config.quantityDefaultsJson,
        {},
      );
      if (!isPlainObject(parsed.byProduct)) return false;
      return Object.keys(parsed.byProduct).some(
        (gid) => normalizeProductId(gid) === wanted,
      );
    });
    if (withOverride) chosen = withOverride;
  }
  return chosen;
}

/**
 * PURE — shopifyPlanId values of the committed entries in a config's
 * plansJson (committed === true or minDeliveries >= 2). The storefront JS
 * identifies committed plans through these ids because Liquid does not
 * expose the billingPolicy minCycles that enforces the commitment.
 */
export function committedPlanIdsForConfig(
  config: SellingPlanConfigLike,
): string[] {
  const plans = parseJson<PlanDefinition[]>(config.plansJson, []);
  return plans
    .filter(
      (p) =>
        p.committed === true ||
        (typeof p.minDeliveries === "number" && p.minDeliveries >= 2),
    )
    .map((p) => p.shopifyPlanId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Resolve the widget to show for a storefront context.
 *
 * Order of operations: active configs sorted by priority (highest first) →
 * first targeting match per widget type → overall highest-priority winner →
 * merge its settingsJson over DEFAULT_WIDGET_SETTINGS → apply the RUNNING
 * experiment variant (deterministic, persisted per subject) → attach cadence
 * defaults from the product's SellingPlanConfig.
 *
 * With no matching config the brand-default TREATMENT_CHOICE widget is
 * returned so the storefront always has something coherent to render.
 */
export async function resolveWidget(
  shop: string,
  params: ResolveWidgetParams,
): Promise<ResolvedWidget> {
  const rows = await prisma.widgetConfig.findMany({
    where: {
      shop,
      active: true,
      ...(params.widgetType ? { widgetType: params.widgetType } : {}),
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
  });

  const perType = pickFirstMatchPerType(rows, params);
  const winners = Object.values(perType).filter(
    (c): c is WidgetConfigLike => Boolean(c),
  );
  winners.sort((a, b) => b.priority - a.priority);
  const match = winners[0];

  const widgetType: WidgetType =
    match && isWidgetType(match.widgetType)
      ? match.widgetType
      : params.widgetType ?? "TREATMENT_CHOICE";

  let settings = mergeSettings(
    DEFAULT_WIDGET_SETTINGS[widgetType],
    match ? parseJson<WidgetSettings>(match.settingsJson, {}) : {},
  );

  let experimentKey: string | undefined;
  if (match?.experimentId && params.visitorKey) {
    const experiment = await prisma.experiment.findUnique({
      where: { id: match.experimentId },
    });
    if (experiment && experiment.shop === shop && experiment.status === RUNNING) {
      const variants = parseJson<ExperimentVariant[]>(
        experiment.variantsJson,
        [],
      ).filter((v) => typeof v.key === "string" && v.key.length > 0);
      if (variants.length > 0) {
        const variantKey = await getOrCreateAssignment(
          experiment.id,
          params.visitorKey,
          variants,
        );
        const variant = variants.find((v) => v.key === variantKey);
        if (variant) {
          settings = mergeSettings(settings, variantSettings(variant));
        }
        experimentKey = `${experiment.id}:${variantKey}`;
      }
    }
  }

  const planConfig = await sellingPlanConfigForShopProduct(
    shop,
    params.productId,
  );
  const cadenceDefaults = planConfig
    ? cadenceDefaultsForProduct(planConfig, params.productId ?? "")
    : {};

  // Committed Treatment Plan: when the committed card is enabled, attach the
  // committed selling plan ids so the storefront JS can tell committed plans
  // apart from standard ones (Liquid exposes neither minCycles nor our
  // committed flag).
  if (widgetType === "TREATMENT_CHOICE") {
    const committed = settings.committed;
    if (isPlainObject(committed) && committed.enabled === true) {
      settings = {
        ...settings,
        committed: {
          ...committed,
          planIds: planConfig ? committedPlanIdsForConfig(planConfig) : [],
        },
      };
    }
  }

  logger.debug("widget resolved", {
    shop,
    widgetType,
    matched: Boolean(match),
    experimentKey,
  });

  return { widgetType, settings, experimentKey, cadenceDefaults };
}
