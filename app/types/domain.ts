/**
 * Cellexia Continuous Treatment — shared domain vocabulary.
 *
 * The Prisma schema stores enum-like values as String (SQLite compatibility).
 * EVERY string written to those columns must come from the const unions below.
 */

// ─────────────────────────────── Contracts ────────────────────────────────

export const CONTRACT_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Every modification the app supports on a live contract. */
export const CONTRACT_ACTIONS = [
  "CHANGE_QUANTITY",
  "CHANGE_VARIANT",
  "ADD_PRODUCT",
  "REMOVE_PRODUCT",
  "CHANGE_DELIVERY_DATE",
  "CHANGE_BILLING_DATE",
  "SKIP_SHIPMENT",
  "DELAY_WEEKS",
  "PAUSE_UNTIL",
  "BRING_FORWARD",
  "SWITCH_CADENCE",
  "CHANGE_ADDRESS",
  "UPDATE_PAYMENT_METHOD",
  "APPLY_CREDIT",
  "CONVERT_TO_ROUTINE",
  "MERGE_CONTRACTS",
  "SPLIT_SHIPMENT",
  "CANCEL",
  "REACTIVATE",
] as const;
export type ContractAction = (typeof CONTRACT_ACTIONS)[number];

export const ADD_ON_MODES = ["NEXT_ONLY", "RECURRING", "N_DELIVERIES"] as const;
export type AddOnMode = (typeof ADD_ON_MODES)[number];

// ─────────────────────────────── Billing / dunning ────────────────────────

export const BILLING_ATTEMPT_STATUSES = [
  "PENDING",
  "SUCCESS",
  "FAILURE",
  "CHALLENGED",
] as const;
export type BillingAttemptStatus = (typeof BILLING_ATTEMPT_STATUSES)[number];

export const DECLINE_CATEGORIES = [
  "INSUFFICIENT_FUNDS",
  "EXPIRED_CARD",
  "GENERIC_DECLINE",
  "LOST_OR_STOLEN",
  "PROCESSOR_ERROR",
  "AUTHENTICATION_REQUIRED",
  "PERMANENT_FAILURE",
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

export const DUNNING_PHASES = [
  "NONE",
  "PRE_DUNNING",
  "RETRYING",
  "GRACE",
  "FINAL_NOTICE",
  "RESOLVED",
  "EXHAUSTED",
] as const;
export type DunningPhase = (typeof DUNNING_PHASES)[number];

/** A single step of a dunning strategy. */
export interface DunningStep {
  /** Days after the failure (or previous step) to act. */
  afterDays: number;
  action: "RETRY" | "EMAIL" | "SMS" | "PORTAL_BANNER" | "PAUSE" | "CANCEL";
  template?: string;
}

// ─────────────────────────────── Retention ────────────────────────────────

export const CANCEL_REASONS = [
  "TOO_MUCH_PRODUCT",
  "NOT_SEEING_IMPROVEMENT",
  "TOO_EXPENSIVE",
  "ONLY_WANTED_TO_TRY",
  "IRRITATION",
  "WANT_DIFFERENT_PRODUCT",
  "TRAVELLING",
  "CIRCUMSTANCES_CHANGED",
  "OTHER",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_OUTCOMES = [
  "IN_PROGRESS",
  "SAVED",
  "CANCELLED",
  "ABANDONED",
] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

/**
 * Save offers, ordered cheapest-first. The retention engine must exhaust
 * structural options before discounting (protects margin).
 */
export const SAVE_OFFER_TYPES = [
  "EDUCATION",
  "CHANGE_DELIVERY_DATE",
  "CHANGE_FREQUENCY",
  "CHANGE_QUANTITY",
  "PRODUCT_SWAP",
  "REMOVE_ITEM",
  "TEMPORARY_PAUSE",
  "ACCOUNT_CREDIT",
  "FREE_GIFT",
  "TEMPORARY_DISCOUNT",
  "PERMANENT_DISCOUNT",
] as const;
export type SaveOfferType = (typeof SAVE_OFFER_TYPES)[number];

export interface SaveOffer {
  type: SaveOfferType;
  /** Human copy shown to the customer (brand voice, not ops jargon). */
  title: string;
  description: string;
  /** Estimated cost to Cellexia in minor units (0 for structural offers). */
  costCents: number;
  /** Parameters the executor needs, e.g. {delayWeeks: 4} or {percentOff: 10}. */
  params: Record<string, unknown>;
}

export const PAUSE_OPTIONS_DAYS = [30, 60, 90] as const;

export const SCORE_KINDS = ["QUALITY", "CHURN_RISK", "LTV"] as const;
export type ScoreKind = (typeof SCORE_KINDS)[number];

// ─────────────────────────────── Treatment ────────────────────────────────

export const TIME_OF_DAY = ["AM", "PM", "BOTH"] as const;
export type TimeOfDay = (typeof TIME_OF_DAY)[number];

export const COMPATIBILITY_RELATIONS = [
  "PAIRS_WITH",
  "STAGGER",
  "REDUNDANT",
  "ROUTINE_STEP_BEFORE",
  "SENSITIVITY_CONFLICT",
] as const;
export type CompatibilityRelation = (typeof COMPATIBILITY_RELATIONS)[number];

export const MILESTONE_TYPES = [
  "TREATMENT_STARTED",
  "FIRST_MONTH",
  "NINETY_DAYS",
  "SIX_DELIVERIES",
  "ONE_YEAR",
] as const;
export type MilestoneType = (typeof MILESTONE_TYPES)[number];

export const MILESTONE_REWARD_STATUSES = [
  "PENDING",
  "GRANTED",
  "NOTIFIED",
] as const;
export type MilestoneRewardStatus = (typeof MILESTONE_REWARD_STATUSES)[number];

export const ADHERENCE_QUESTIONS = [
  "STARTED_USING",
  "USAGE_FREQUENCY",
  "PRODUCT_REMAINING",
  "DISCOMFORT",
  "DESIRED_CHANGE",
] as const;
export type AdherenceQuestion = (typeof ADHERENCE_QUESTIONS)[number];

/** Behavioural signals that update a depletion estimate. */
export const DEPLETION_SIGNALS = [
  "EARLY_DELAY",
  "BROUGHT_FORWARD",
  "REPEATED_SKIPS",
  "EXTRA_ONE_TIME_PURCHASE",
  "SURVEY_OVERRIDE",
  "DELIVERY_RECEIVED",
] as const;
export type DepletionSignal = (typeof DEPLETION_SIGNALS)[number];

export interface AutopilotGuardrails {
  maxChargeCents: number | null;
  askBeforeAdding: boolean;
  minIntervalWeeks: number | null;
  notifyDaysBefore: number;
}

// ─────────────────────────────── Offers / widgets ─────────────────────────

export const WIDGET_TYPES = [
  "TREATMENT_CHOICE",
  "QUANTITY_CADENCE",
  "ROUTINE_BUILDER",
  "POST_ONE_TIME",
  "CART_CONVERSION",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const EXPERIMENT_STATUSES = ["DRAFT", "RUNNING", "COMPLETED"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

// ─────────────────────────────── Lifecycle events ─────────────────────────

/**
 * Every event the app emits. Mirrored 1:1 into Klaviyo as
 * "Cellexia <Human Name>" metrics — see services/communications.
 */
export const LIFECYCLE_EVENTS = [
  "SUBSCRIPTION_STARTED",
  "FIRST_CHARGE_APPROACHING",
  "CHARGE_COMPLETED",
  "CHARGE_FAILED",
  "CARD_EXPIRING",
  "SHIPMENT_DELAYED",
  "PRODUCT_ADDED",
  "PRODUCT_REMOVED",
  "ORDER_SKIPPED",
  "PAUSE_STARTED",
  "PAUSE_ENDING",
  // Emitted when a paused plan actually resumes (PAUSE_ENDING stays the
  // "pause ends soon" Klaviyo reminder trigger; analytics counts this one).
  "PAUSE_ENDED",
  // Dunning grace pause (system-driven) — distinct from customer
  // PAUSE_STARTED so pause-behaviour metrics count only customer pauses.
  "DUNNING_PAUSE_STARTED",
  "HIGH_CHURN_RISK",
  "LIKELY_EXCESS_INVENTORY",
  "LIKELY_PRODUCT_SHORTAGE",
  "TREATMENT_MILESTONE",
  "CANCELLATION_STARTED",
  "CANCELLATION_SAVED",
  "CANCELLATION_COMPLETED",
  "ELIGIBLE_FOR_UPGRADE",
  "REPEATED_ONE_TIME_ADD_ON",
  "PRODUCT_OUT_OF_STOCK",
  "PRODUCT_BACK_IN_STOCK",
  "SUBSCRIBER_ANNIVERSARY",
  "MAGIC_LINK_REQUESTED",
  "PRE_SHIPMENT_WINDOW_OPEN",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export const OUTBOX_STATUSES = ["PENDING", "SENT", "FAILED", "DEAD"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

// ─────────────────────────────── Staff / audit ────────────────────────────

export const STAFF_ROLE_NAMES = [
  "OWNER",
  "ADMIN",
  "CS_AGENT",
  "ANALYST",
] as const;
export type StaffRoleName = (typeof STAFF_ROLE_NAMES)[number];

export const ACTOR_TYPES = ["SYSTEM", "STAFF", "CUSTOMER", "WEBHOOK"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// ─────────────────────────────── Shared helpers ───────────────────────────

export interface Money {
  amountCents: number;
  currencyCode: string;
}

export interface ContractLineSummary {
  id: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  quantity: number;
  currentPriceCents: number;
}

/** Parse a JSON column defensively; enum-typed callers cast the result. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
