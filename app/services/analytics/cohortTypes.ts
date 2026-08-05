/**
 * Cohort dimensions/metrics shared between server code and route components.
 * Kept out of *.server.ts so client bundles can reference the option lists.
 */

export const COHORT_DIMENSIONS = [
  "startMonth",
  "firstProduct",
  "country",
  "acquisitionChannel",
  "landingPage",
  "advertorial",
  "campaign",
  "initialDiscount",
  "initialQuantity",
  "sellingPlanConfig",
  "device",
  "newVsReturning",
  "firstOrderAovBand",
  "firstShipmentProfitBand",
  "widgetVersion",
] as const;
export type CohortDimension = (typeof COHORT_DIMENSIONS)[number];

export const COHORT_METRICS = [
  "retention",
  "ltvCents",
  "contributionCents",
  "subscribers",
] as const;
export type CohortMetric = (typeof COHORT_METRICS)[number];
