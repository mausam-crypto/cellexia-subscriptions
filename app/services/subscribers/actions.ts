/**
 * [subscribers] — pure decision & parsing helpers for the subscriber list and
 * the customer-service console.
 *
 * No I/O in this module: everything is a plain function over plain inputs so
 * the routes stay thin and the logic is unit-testable
 * (tests/subscribers/actions.test.ts). Both admin routes import from here.
 */
import { addDays } from "~/lib/dates";
import { toCents } from "~/lib/money";
import {
  CANCEL_REASONS,
  CONTRACT_STATUSES,
  DUNNING_PHASES,
  PAUSE_OPTIONS_DAYS,
  type CancelReason,
  type ContractAction,
  type ContractStatus,
  type DunningPhase,
} from "~/types/domain";

// ─────────────────────────────── Console intents ──────────────────────────

/** Every manual override the CS console exposes. Subset of CONTRACT_ACTIONS. */
export const CS_INTENTS = [
  "CHANGE_QUANTITY",
  "CHANGE_VARIANT",
  "ADD_PRODUCT",
  "REMOVE_PRODUCT",
  "CHANGE_BILLING_DATE",
  "SKIP_SHIPMENT",
  "DELAY_WEEKS",
  "BRING_FORWARD",
  "PAUSE_UNTIL",
  "REACTIVATE",
  "SWITCH_CADENCE",
  "CHANGE_ADDRESS",
  "UPDATE_PAYMENT_METHOD",
  "APPLY_CREDIT",
  "CANCEL",
  "MERGE_CONTRACTS",
  "SPLIT_SHIPMENT",
] as const satisfies readonly ContractAction[];
export type CsIntent = (typeof CS_INTENTS)[number];

/** Intents that require the double-confirm checkbox (`confirm=yes`). */
export const DESTRUCTIVE_INTENTS: readonly CsIntent[] = [
  "REMOVE_PRODUCT",
  "CANCEL",
  "MERGE_CONTRACTS",
  "SPLIT_SHIPMENT",
];

// Guardrails for manual overrides (documented in docs/CS-CONSOLE.md).
export const MAX_LINE_QUANTITY = 24;
export const MAX_DELAY_WEEKS = 12;
export const MIN_INTERVAL_WEEKS = 1;
export const MAX_INTERVAL_WEEKS = 24;
/** Hard per-action ceiling for manual account credit (minor units). */
export const MAX_ACCOUNT_CREDIT_CENTS = 50_000;

export interface DeliveryAddressInput {
  firstName?: string;
  lastName?: string;
  address1: string;
  address2?: string;
  city: string;
  provinceCode?: string;
  zip: string;
  countryCode: string;
  phone?: string;
}

export type ParsedAction =
  | { intent: "CHANGE_QUANTITY"; lineId: string; quantity: number }
  | { intent: "CHANGE_VARIANT"; lineId: string; variantGid: string }
  | { intent: "ADD_PRODUCT"; variantGid: string; quantity: number; priceCents?: number }
  | { intent: "REMOVE_PRODUCT"; lineId: string }
  | { intent: "CHANGE_BILLING_DATE"; date: Date }
  | { intent: "SKIP_SHIPMENT" }
  | { intent: "DELAY_WEEKS"; weeks: number }
  | { intent: "BRING_FORWARD"; date: Date }
  | { intent: "PAUSE_UNTIL"; resumeDate: Date }
  | { intent: "REACTIVATE" }
  | { intent: "SWITCH_CADENCE"; intervalWeeks: number }
  | { intent: "CHANGE_ADDRESS"; address: DeliveryAddressInput }
  | { intent: "UPDATE_PAYMENT_METHOD" }
  | { intent: "APPLY_CREDIT"; amountCents: number }
  | { intent: "CANCEL"; reason: CancelReason }
  | { intent: "MERGE_CONTRACTS"; targetContractId: string }
  | { intent: "SPLIT_SHIPMENT"; lineIds: string[] };

export type ParseResult =
  | { ok: true; action: ParsedAction }
  | { ok: false; error: string };

/** Structural subset of FormData so tests can pass a real FormData. */
export interface FormValues {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

export interface ParseContext {
  now?: Date;
  /** The contract being edited — a merge target must be a different plan. */
  selfContractId?: string;
  /** Total line count — a split must leave at least one line behind. */
  totalLineCount?: number;
}

// ─────────────────────────────── Small parsers ────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function posInt(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse "YYYY-MM-DD" (UTC midnight) or a full ISO timestamp. */
export function parseIsoDate(v: unknown): Date | null {
  const s = str(v);
  if (s === null) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Accept a numeric variant id or a full ProductVariant GID; normalise to GID. */
export function normalizeVariantGid(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return `gid://shopify/ProductVariant/${v}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(v)) return v;
  return null;
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function ok(action: ParsedAction): ParseResult {
  return { ok: true, action };
}

// ─────────────────────────────── Action parsing ───────────────────────────

/**
 * Validate and normalise a CS console form submission into a typed action.
 * Returns a user-presentable error message on invalid input. Pure: `now` is
 * injectable for tests.
 */
export function parseConsoleAction(
  form: FormValues,
  ctx: ParseContext = {},
): ParseResult {
  const now = ctx.now ?? new Date();

  const intentRaw = str(form.get("intent"));
  if (intentRaw === null || !(CS_INTENTS as readonly string[]).includes(intentRaw)) {
    return fail("Unknown console action.");
  }
  const intent = intentRaw as CsIntent;

  if (DESTRUCTIVE_INTENTS.includes(intent) && str(form.get("confirm")) !== "yes") {
    return fail("This change needs an explicit confirmation before it can run.");
  }

  switch (intent) {
    case "CHANGE_QUANTITY": {
      const lineId = str(form.get("lineId"));
      if (lineId === null) return fail("Missing product line.");
      const quantity = posInt(form.get("quantity"));
      if (quantity === null) return fail("Quantity must be a whole number of 1 or more.");
      if (quantity > MAX_LINE_QUANTITY) {
        return fail(`Quantity is capped at ${MAX_LINE_QUANTITY} per product.`);
      }
      return ok({ intent, lineId, quantity });
    }
    case "CHANGE_VARIANT": {
      const lineId = str(form.get("lineId"));
      if (lineId === null) return fail("Missing product line.");
      const variantGid = normalizeVariantGid(str(form.get("variantGid")));
      if (variantGid === null) {
        return fail("Enter a variant ID or a gid://shopify/ProductVariant/… GID.");
      }
      return ok({ intent, lineId, variantGid });
    }
    case "ADD_PRODUCT": {
      const variantGid = normalizeVariantGid(str(form.get("variantGid")));
      if (variantGid === null) {
        return fail("Enter a variant ID or a gid://shopify/ProductVariant/… GID.");
      }
      const qtyRaw = str(form.get("quantity"));
      const quantity = qtyRaw === null ? 1 : posInt(qtyRaw);
      if (quantity === null || quantity > MAX_LINE_QUANTITY) {
        return fail(`Quantity must be between 1 and ${MAX_LINE_QUANTITY}.`);
      }
      const priceRaw = str(form.get("price"));
      if (priceRaw !== null) {
        const priceCents = toCents(priceRaw);
        if (priceCents <= 0) return fail("Price override must be greater than zero.");
        return ok({ intent, variantGid, quantity, priceCents });
      }
      return ok({ intent, variantGid, quantity });
    }
    case "REMOVE_PRODUCT": {
      const lineId = str(form.get("lineId"));
      if (lineId === null) return fail("Missing product line.");
      return ok({ intent, lineId });
    }
    case "CHANGE_BILLING_DATE":
    case "BRING_FORWARD": {
      const date = parseIsoDate(form.get("date"));
      if (date === null) return fail("Enter a valid date.");
      if (date.getTime() <= now.getTime()) return fail("Pick a date in the future.");
      return ok({ intent, date });
    }
    case "SKIP_SHIPMENT":
      return ok({ intent });
    case "DELAY_WEEKS": {
      const weeks = posInt(form.get("weeks"));
      if (weeks === null || weeks > MAX_DELAY_WEEKS) {
        return fail(`Delay must be between 1 and ${MAX_DELAY_WEEKS} weeks.`);
      }
      return ok({ intent, weeks });
    }
    case "PAUSE_UNTIL": {
      const explicit = parseIsoDate(form.get("resumeDate"));
      if (explicit !== null) {
        if (explicit.getTime() <= now.getTime()) return fail("Pick a resume date in the future.");
        return ok({ intent, resumeDate: explicit });
      }
      const days = posInt(form.get("pauseDays"));
      if (days === null || !(PAUSE_OPTIONS_DAYS as readonly number[]).includes(days)) {
        return fail("Choose a pause of 30, 60 or 90 days, or pick a resume date.");
      }
      return ok({ intent, resumeDate: addDays(now, days) });
    }
    case "REACTIVATE":
      return ok({ intent });
    case "SWITCH_CADENCE": {
      const intervalWeeks = posInt(form.get("intervalWeeks"));
      if (
        intervalWeeks === null ||
        intervalWeeks < MIN_INTERVAL_WEEKS ||
        intervalWeeks > MAX_INTERVAL_WEEKS
      ) {
        return fail(
          `Cadence must be between ${MIN_INTERVAL_WEEKS} and ${MAX_INTERVAL_WEEKS} weeks.`,
        );
      }
      return ok({ intent, intervalWeeks });
    }
    case "CHANGE_ADDRESS": {
      const address1 = str(form.get("address1"));
      const city = str(form.get("city"));
      const zip = str(form.get("zip"));
      const countryRaw = str(form.get("countryCode"));
      if (address1 === null) return fail("Address line 1 is required.");
      if (city === null) return fail("City is required.");
      if (zip === null) return fail("Postcode / ZIP is required.");
      if (countryRaw === null || !/^[A-Za-z]{2}$/.test(countryRaw)) {
        return fail("Country must be a two-letter code, e.g. FR.");
      }
      const address: DeliveryAddressInput = {
        address1,
        city,
        zip,
        countryCode: countryRaw.toUpperCase(),
      };
      const firstName = str(form.get("firstName"));
      if (firstName !== null) address.firstName = firstName;
      const lastName = str(form.get("lastName"));
      if (lastName !== null) address.lastName = lastName;
      const address2 = str(form.get("address2"));
      if (address2 !== null) address.address2 = address2;
      const provinceCode = str(form.get("provinceCode"));
      if (provinceCode !== null) address.provinceCode = provinceCode;
      const phone = str(form.get("phone"));
      if (phone !== null) address.phone = phone;
      return ok({ intent, address });
    }
    case "UPDATE_PAYMENT_METHOD":
      return ok({ intent });
    case "APPLY_CREDIT": {
      const raw = str(form.get("amount"));
      if (raw === null) return fail("Enter a credit amount.");
      const amountCents = toCents(raw);
      if (amountCents <= 0) return fail("Credit amount must be greater than zero.");
      if (amountCents > MAX_ACCOUNT_CREDIT_CENTS) {
        return fail(
          `Account credit is capped at ${(MAX_ACCOUNT_CREDIT_CENTS / 100).toFixed(2)} per action.`,
        );
      }
      return ok({ intent, amountCents });
    }
    case "CANCEL": {
      const reason = str(form.get("reason"));
      if (reason === null || !(CANCEL_REASONS as readonly string[]).includes(reason)) {
        return fail("Choose a cancellation reason.");
      }
      return ok({ intent, reason: reason as CancelReason });
    }
    case "MERGE_CONTRACTS": {
      const targetContractId = str(form.get("targetContractId"));
      if (targetContractId === null) return fail("Choose the plan to merge into.");
      if (ctx.selfContractId !== undefined && targetContractId === ctx.selfContractId) {
        return fail("Choose a different plan to merge into.");
      }
      return ok({ intent, targetContractId });
    }
    case "SPLIT_SHIPMENT": {
      const lineIds = Array.from(
        new Set(
          form
            .getAll("lineIds")
            .map((v) => str(v))
            .filter((v): v is string => v !== null),
        ),
      );
      if (lineIds.length === 0) return fail("Select at least one product to split out.");
      if (ctx.totalLineCount !== undefined && lineIds.length >= ctx.totalLineCount) {
        return fail("Leave at least one product in the original plan.");
      }
      return ok({ intent, lineIds });
    }
  }
}

/** Audit-log action name for a console override, e.g. "CS_SKIP_SHIPMENT". */
export function auditActionFor(intent: CsIntent): string {
  return `CS_${intent}`;
}

/** Toast copy after a successful override (calm, treatment-plan voice). */
export function successMessage(action: ParsedAction): string {
  switch (action.intent) {
    case "CHANGE_QUANTITY":
      return "Quantity updated.";
    case "CHANGE_VARIANT":
      return "Product variant swapped.";
    case "ADD_PRODUCT":
      return "Product added to the treatment plan.";
    case "REMOVE_PRODUCT":
      return "Product removed from the plan.";
    case "CHANGE_BILLING_DATE":
      return "Next billing date updated.";
    case "SKIP_SHIPMENT":
      return "Next delivery skipped.";
    case "DELAY_WEEKS":
      return `Next delivery delayed by ${action.weeks} ${action.weeks === 1 ? "week" : "weeks"}.`;
    case "BRING_FORWARD":
      return "Next delivery brought forward.";
    case "PAUSE_UNTIL":
      return "Treatment plan paused.";
    case "REACTIVATE":
      return "Treatment plan resumed.";
    case "SWITCH_CADENCE":
      return `Delivery cadence set to ${cadenceLabel(action.intervalWeeks).toLowerCase()}.`;
    case "CHANGE_ADDRESS":
      return "Delivery address updated.";
    case "UPDATE_PAYMENT_METHOD":
      return "Payment update email sent to the customer.";
    case "APPLY_CREDIT":
      return "Account credit applied to the next order.";
    case "CANCEL":
      return "Treatment plan cancelled.";
    case "MERGE_CONTRACTS":
      return "Plans merged into one delivery.";
    case "SPLIT_SHIPMENT":
      return "Selected products split into their own plan.";
  }
}

// ─────────────────────────────── Churn bands ──────────────────────────────

export const CHURN_MEDIUM_THRESHOLD = 0.4;
export const CHURN_HIGH_THRESHOLD = 0.7;

export const CHURN_BAND_FILTERS = ["LOW", "MEDIUM", "HIGH"] as const;
export type ChurnBandFilter = (typeof CHURN_BAND_FILTERS)[number];
export type ChurnBand = ChurnBandFilter | "UNSCORED";

/** Band a churn score (accepts 0–1 or 0–100 scale defensively). */
export function churnBand(score: number | null | undefined): ChurnBand {
  if (score === null || score === undefined) return "UNSCORED";
  const s = score > 1 ? score / 100 : score;
  if (s >= CHURN_HIGH_THRESHOLD) return "HIGH";
  if (s >= CHURN_MEDIUM_THRESHOLD) return "MEDIUM";
  return "LOW";
}

/** Prisma-ready numeric range for a churn band (assumes 0–1 storage). */
export function churnScoreRange(
  band: ChurnBandFilter,
): { gte?: number; lt?: number } {
  switch (band) {
    case "LOW":
      return { lt: CHURN_MEDIUM_THRESHOLD };
    case "MEDIUM":
      return { gte: CHURN_MEDIUM_THRESHOLD, lt: CHURN_HIGH_THRESHOLD };
    case "HIGH":
      return { gte: CHURN_HIGH_THRESHOLD };
  }
}

/** Normalise a score to an integer 0–100 for display. */
export function scoreOutOf100(value: number): number {
  return Math.round(value <= 1 ? value * 100 : value);
}

// ─────────────────────────────── Badge tones ──────────────────────────────

export type ConsoleTone =
  | "success"
  | "attention"
  | "warning"
  | "critical"
  | "info"
  | undefined;

export function statusTone(status: string): ConsoleTone {
  switch (status as ContractStatus) {
    case "ACTIVE":
      return "success";
    case "PAUSED":
      return "attention";
    case "CANCELLED":
      return "critical";
    case "EXPIRED":
      return "info";
    case "FAILED":
      return "warning";
    default:
      return undefined;
  }
}

export function dunningTone(phase: string): ConsoleTone {
  switch (phase as DunningPhase) {
    case "RESOLVED":
      return "success";
    case "PRE_DUNNING":
      return "info";
    case "RETRYING":
      return "attention";
    case "GRACE":
      return "warning";
    case "FINAL_NOTICE":
    case "EXHAUSTED":
      return "critical";
    default:
      return undefined;
  }
}

export function qualityTone(value: number | null | undefined): ConsoleTone {
  if (value === null || value === undefined) return undefined;
  const s = scoreOutOf100(value);
  if (s >= 70) return "success";
  if (s >= 40) return "attention";
  return "critical";
}

export function churnBandTone(band: ChurnBand): ConsoleTone {
  switch (band) {
    case "HIGH":
      return "critical";
    case "MEDIUM":
      return "attention";
    case "LOW":
      return "success";
    default:
      return undefined;
  }
}

/** Dunning phases that count as "currently in payment recovery". */
export const ACTIVE_DUNNING_PHASES = [
  "PRE_DUNNING",
  "RETRYING",
  "GRACE",
  "FINAL_NOTICE",
] as const satisfies readonly DunningPhase[];

// ─────────────────────────────── List filters ─────────────────────────────

export const NEXT_BILLING_WINDOWS = [
  "OVERDUE",
  "NEXT_7_DAYS",
  "NEXT_14_DAYS",
  "NEXT_30_DAYS",
] as const;
export type NextBillingWindow = (typeof NEXT_BILLING_WINDOWS)[number];

export function nextBillingRange(
  window: NextBillingWindow,
  now: Date,
): { gte?: Date; lt?: Date } {
  switch (window) {
    case "OVERDUE":
      return { lt: now };
    case "NEXT_7_DAYS":
      return { gte: now, lt: addDays(now, 7) };
    case "NEXT_14_DAYS":
      return { gte: now, lt: addDays(now, 14) };
    case "NEXT_30_DAYS":
      return { gte: now, lt: addDays(now, 30) };
  }
}

export interface SubscriberFilters {
  status: ContractStatus | null;
  churnBand: ChurnBandFilter | null;
  dunningPhase: DunningPhase | null;
  window: NextBillingWindow | null;
  email: string | null;
  page: number;
}

/** Parse and validate list-page query params; invalid values fall back safely. */
export function parseSubscriberFilters(params: URLSearchParams): SubscriberFilters {
  const status = params.get("status");
  const band = params.get("band");
  const phase = params.get("phase");
  const window = params.get("window");
  const email = params.get("email");
  const pageRaw = Number(params.get("page") ?? "1");
  return {
    status:
      status !== null && (CONTRACT_STATUSES as readonly string[]).includes(status)
        ? (status as ContractStatus)
        : null,
    churnBand:
      band !== null && (CHURN_BAND_FILTERS as readonly string[]).includes(band)
        ? (band as ChurnBandFilter)
        : null,
    dunningPhase:
      phase !== null && (DUNNING_PHASES as readonly string[]).includes(phase)
        ? (phase as DunningPhase)
        : null,
    window:
      window !== null && (NEXT_BILLING_WINDOWS as readonly string[]).includes(window)
        ? (window as NextBillingWindow)
        : null,
    email: email !== null && email.trim() !== "" ? email.trim() : null,
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

// ─────────────────────────────── Display helpers ──────────────────────────

/** "TOO_MUCH_PRODUCT" -> "Too much product". */
export function humanizeEnum(value: string): string {
  const words = value.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return value;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function cadenceLabel(intervalWeeks: number): string {
  return intervalWeeks === 1 ? "Every week" : `Every ${intervalWeeks} weeks`;
}

/** Compact products summary for the list table, e.g. "2× Serum · 1× Cream +2 more". */
export function linesSummary(
  lines: ReadonlyArray<{ title: string; quantity: number }>,
  max = 3,
): string {
  if (lines.length === 0) return "No products";
  const shown = lines
    .slice(0, max)
    .map((l) => `${l.quantity}× ${l.title}`)
    .join(" · ");
  const rest = lines.length - max;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

export function truncate(value: string, max = 140): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
