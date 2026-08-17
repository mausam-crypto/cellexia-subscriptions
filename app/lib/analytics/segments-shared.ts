/**
 * Segment vocabulary shared between server (segments.server.ts) and admin
 * route COMPONENTS. Client components must import from THIS module, never
 * from segments.server / index.server — a component that references a
 * .server module drags prisma into the client bundle and fails
 * `remix vite:build` (the ownership shared.ts lesson). This module must
 * never gain a server dependency.
 */

export const UNKNOWN_SEGMENT_VALUE = "unknown";

export const DISCOUNT_BANDS = [
  "none",
  "1_10",
  "10_20",
  "20_30",
  "30_plus",
] as const;
export type DiscountBand = (typeof DISCOUNT_BANDS)[number];

export const DEVICE_TYPES = ["mobile", "desktop", "tablet"] as const;

/**
 * Buy-box preselect vocabulary (v1.26.0) — which option the widget rendered
 * as the default at the subscriber's first checkout: "sub" (subscription
 * preselected) or "one" (one-time preselected). Mirrors
 * SubscriptionContract.originDesignPreselect; duplicated here rather than
 * imported from ~/lib/design-measurement/shared so this module keeps its
 * zero-dependency guarantee for client components.
 */
export const DESIGN_PRESELECT_SEGMENT_VALUES = ["sub", "one"] as const;

/**
 * Buy-box design keys are widget preset keys ("subscription_max", …) —
 * lowercase snake_case, capped at 40 chars. Shared with the server parser
 * so the URL param and the stored value can never disagree on shape.
 */
export const DESIGN_KEY_RE = /^[a-z0-9_]{1,40}$/;

export interface AnalyticsSegment {
  /** ISO country code (uppercase) or "unknown". */
  country?: string;
  /** Base language subtag (lowercase) or "unknown". */
  language?: string;
  /** Traffic source label (lowercase) or "unknown". */
  source?: string;
  /** Numeric product id (normalized — GID tails match). */
  productId?: string;
  /** First-order discount depth band or "unknown". */
  discountBand?: DiscountBand | typeof UNKNOWN_SEGMENT_VALUE;
  /** "mobile" | "desktop" | "tablet" | "unknown". */
  device?: string;
  /** acqOrderValueBand label ("0_25" … "200_plus") or "unknown". */
  valueBand?: string;
  /**
   * Buy-box design (widget preset key, e.g. "subscription_max") the
   * subscriber's first checkout came through, or "unknown" (v1.26.0 —
   * SubscriptionContract.originDesignKey).
   */
  design?: string;
  /**
   * Which buy-box option was preselected at that first checkout: "sub" |
   * "one" | "unknown" (v1.26.0 — SubscriptionContract.originDesignPreselect).
   */
  preselect?: string;
}

export const SEGMENT_DIMENSIONS = [
  "country",
  "language",
  "source",
  "productId",
  "discountBand",
  "device",
  "valueBand",
  "design",
  "preselect",
] as const satisfies ReadonlyArray<keyof AnalyticsSegment>;

export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

/** URL search-param name per dimension (shared by loader parse + UI links). */
export const SEGMENT_PARAM_NAMES: Record<SegmentDimension, string> = {
  country: "country",
  language: "lang",
  source: "source",
  productId: "product",
  discountBand: "discount",
  device: "device",
  valueBand: "value",
  design: "design",
  preselect: "preselect",
};

const DISCOUNT_BAND_LABELS: Record<string, string> = {
  none: "No discount",
  "1_10": "Under 10%",
  "10_20": "10–20%",
  "20_30": "20–30%",
  "30_plus": "30% or more",
};

const PRESELECT_LABELS: Record<string, string> = {
  sub: "Subscription preselected",
  one: "One-time preselected",
};

/**
 * "subscription_max" → "Subscription max": a widget preset key rendered as
 * plain words. Kept local (rather than importing the design-measurement
 * presetDisplayName) so this module stays dependency-free; the two must
 * agree on the shape, which is trivial for snake_case keys.
 */
function designKeyLabel(key: string): string {
  const words = key.replace(/_+/g, " ").trim();
  if (words === "") return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human label for a dimension value ("unknown" always reads "Unknown"). */
export function segmentValueLabel(
  dimension: SegmentDimension,
  value: string,
): string {
  if (value === UNKNOWN_SEGMENT_VALUE) return "Unknown";
  switch (dimension) {
    case "country":
      try {
        return (
          new Intl.DisplayNames(["en"], { type: "region" }).of(value) ?? value
        );
      } catch {
        return value;
      }
    case "language":
      try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(
          value,
        );
        return name && name !== value
          ? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
          : value;
      } catch {
        return value;
      }
    case "discountBand":
      return DISCOUNT_BAND_LABELS[value] ?? value;
    case "device":
      return value.charAt(0).toUpperCase() + value.slice(1);
    case "valueBand":
      return value === "200_plus" ? "200+" : value.replace(/_/g, "–");
    case "design":
      return designKeyLabel(value);
    case "preselect":
      return PRESELECT_LABELS[value] ?? value;
    default:
      return value;
  }
}
