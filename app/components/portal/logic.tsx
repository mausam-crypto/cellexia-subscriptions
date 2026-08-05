/**
 * Portal pure logic — decision & display helpers with NO I/O.
 *
 * Everything here operates on plain inputs so it is unit-testable
 * (tests/portal/auth.test.ts). Routes and components stay thin.
 */
import { addDays, daysBetween, isoDate } from "~/lib/dates";
import { formatMoney } from "~/lib/money";
import { planAdjustedPriceCents } from "~/services/core/pure";
import type {
  AddOnRankingInputs,
  CompatibilityEdgeInput,
} from "~/services/offers/preShipment.server";
import type {
  AutopilotGuardrails,
  CancelReason,
  CompatibilityRelation,
  MilestoneType,
  SaveOffer,
  SaveOfferType,
} from "~/types/domain";
import { CANCEL_REASONS, COMPATIBILITY_RELATIONS } from "~/types/domain";

// ─────────────────────────────── Treatment timeline ───────────────────────

/** "Week 14 of your treatment" — week 1 starts the day treatment begins. */
export function treatmentWeekLabel(
  startedAt: Date | null,
  now: Date,
): string | null {
  if (!startedAt) return null;
  const days = daysBetween(startedAt, now);
  if (days < 0) return null;
  const week = Math.floor(days / 7) + 1;
  return `Week ${week} of your treatment`;
}

/**
 * Whole calendar days (UTC) between now and a target date. 0 means the date
 * is today, 1 tomorrow. Calendar-granular on purpose: the value sits next to
 * a calendar-formatted date, so instant-based rounding would contradict it
 * ("about a day" beside a date two calendar days away) and claim "Being
 * prepared now" up to 12 hours before the billing instant.
 */
export function daysUntil(date: Date, now: Date): number {
  const utcDay = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcDay(date) - utcDay(now)) / 86_400_000);
}

/** Calm countdown copy for the next delivery. */
export function deliveryCountdownLabel(days: number): string {
  if (days <= 0) return "Being prepared now";
  if (days === 1) return "Arriving in about a day";
  return `Arriving in about ${days} days`;
}

/** Terminal plans render a closed-plan screen, never live delivery copy. */
export function isTerminalContractStatus(status: string): boolean {
  return status === "CANCELLED" || status === "EXPIRED";
}

/** FAILED = payment issue (dunning): live copy is suppressed, not terminal. */
export function isPaymentHoldStatus(status: string): boolean {
  return status === "FAILED";
}

// ─────────────────────────────── Supply / depletion ───────────────────────

/** "about 3 weeks left" from a DepletionEstimate.predictedRunOutAt. */
export function describeSupplyRemaining(
  runOutAt: Date | null,
  now: Date,
): string | null {
  if (!runOutAt) return null;
  const days = daysBetween(now, runOutAt);
  if (days <= 0) return "likely running low";
  if (days < 7) return days === 1 ? "about 1 day left" : `about ${days} days left`;
  const weeks = Math.round(days / 7);
  return weeks <= 1 ? "about 1 week left" : `about ${weeks} weeks left`;
}

/**
 * Context shown next to "Skip this delivery":
 * "You may still have about 2 weeks of product — skipping might suit you."
 */
export function skipSupplyNote(
  supplyLabels: Array<string | null>,
): string | null {
  const first = supplyLabels.find(
    (label): label is string => !!label && label.endsWith("left"),
  );
  if (!first) return null;
  const amount = first.slice(0, -" left".length);
  return `You may still have ${amount} of product — skipping might suit you.`;
}

// ─────────────────────────────── Savings ──────────────────────────────────

/** A valid customer-facing discount percentage sits strictly inside (0, 100). */
function validPercent(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 100
    ? value
    : null;
}

/** Strip a GID down to its tail so gid and bare selling-plan ids compare equal. */
function planIdTail(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

export interface PlanDiscountIndex {
  /** Normalised (tail) shopifyPlanId → percentOff. */
  byPlanId: Record<string, number>;
  /** Conservative default across non-committed ("standard") plan entries. */
  standardDefault: number | null;
  /** Conservative default across committed plan entries. */
  committedDefault: number | null;
}

/**
 * Index the shop's SellingPlanConfig rows (plansJson =
 * [{name, intervalWeeks, percentOff, shopifyPlanId, committed?, minDeliveries?}])
 * by selling-plan id, plus conservative (minimum) committed/standard default
 * percentages for lines whose plan id no longer matches any entry.
 */
export function planDiscountsFromConfigs(
  plansJsonList: string[],
): PlanDiscountIndex {
  const byPlanId: Record<string, number> = {};
  let standardDefault: number | null = null;
  let committedDefault: number | null = null;
  for (const raw of plansJsonList) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const percent = validPercent(record.percentOff);
      if (percent === null) continue;
      const minDeliveries = record.minDeliveries;
      const committed =
        record.committed === true ||
        (typeof minDeliveries === "number" && minDeliveries >= 2);
      if (typeof record.shopifyPlanId === "string" && record.shopifyPlanId) {
        byPlanId[planIdTail(record.shopifyPlanId)] = percent;
      }
      if (committed) {
        committedDefault =
          committedDefault === null ? percent : Math.min(committedDefault, percent);
      } else {
        standardDefault =
          standardDefault === null ? percent : Math.min(standardDefault, percent);
      }
    }
  }
  return { byPlanId, standardDefault, committedDefault };
}

/**
 * Discount percentage for one contract line: exact selling-plan match →
 * committed/standard plan defaults → the contract's recorded
 * initialDiscountPercent → null (unknown; caller hides the savings tile).
 */
export function resolveLinePercentOff(
  sellingPlanId: string | null | undefined,
  discounts: PlanDiscountIndex,
  opts: {
    committedPlan?: boolean;
    initialDiscountPercent?: number | null;
  } = {},
): number | null {
  if (sellingPlanId) {
    const exact = discounts.byPlanId[planIdTail(sellingPlanId)];
    if (validPercent(exact) !== null) return exact;
  }
  const preferred = opts.committedPlan
    ? [discounts.committedDefault, discounts.standardDefault]
    : [discounts.standardDefault, discounts.committedDefault];
  for (const candidate of preferred) {
    if (validPercent(candidate) !== null) return candidate;
  }
  return validPercent(opts.initialDiscountPercent);
}

/**
 * The single plan discount used when pricing a line ADDED to this contract
 * (portal add flows). First line with a plan-matched percent wins; falls back
 * to the shop defaults, then the recorded checkout discount.
 */
export function contractPercentOff(
  lines: Array<{ sellingPlanId: string | null }>,
  discounts: PlanDiscountIndex,
  opts: {
    committedPlan?: boolean;
    initialDiscountPercent?: number | null;
  } = {},
): number | null {
  for (const line of lines) {
    if (!line.sellingPlanId) continue;
    const exact = discounts.byPlanId[planIdTail(line.sellingPlanId)];
    if (validPercent(exact) !== null) return exact;
  }
  return resolveLinePercentOff(null, discounts, opts);
}

/** One-time (undiscounted) price recovered from an already-discounted price. */
export function oneTimePriceCents(
  discountedCents: number,
  percentOffValue: number,
): number {
  return Math.round(discountedCents / (1 - percentOffValue / 100));
}

/**
 * Subscriber savings per delivery versus one-time prices, per line, from the
 * line's resolved plan discount. Never negative; null when NO line has a
 * known discount — the tile is hidden rather than showing a dash.
 * Uses `planAdjustedPriceCents` (shared with core) for the discount leg so
 * portal maths always agree with how added/swapped lines are priced.
 */
export function perDeliverySavingsCents(
  lines: Array<{
    quantity: number;
    currentPriceCents: number;
    percentOff: number | null;
  }>,
): number | null {
  let known = false;
  let total = 0;
  for (const line of lines) {
    const percent = validPercent(line.percentOff);
    if (percent === null) continue;
    known = true;
    const oneTime = oneTimePriceCents(line.currentPriceCents, percent);
    const subscriber = planAdjustedPriceCents(percent, oneTime);
    total += Math.max(0, line.quantity) * Math.max(0, oneTime - subscriber);
  }
  return known ? Math.max(0, total) : null;
}

/**
 * LEGACY (kept for the contract-level initialDiscountPercent path and its
 * tests): savings from one blanket discount over the whole delivery.
 */
export function estimateSavingsCentsPerDelivery(
  lines: Array<{ quantity: number; currentPriceCents: number }>,
  discountPercent: number | null | undefined,
): number {
  if (!discountPercent || discountPercent <= 0 || discountPercent >= 100) {
    return 0;
  }
  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.currentPriceCents,
    0,
  );
  const oneTime = Math.round(subtotal / (1 - discountPercent / 100));
  return Math.max(0, oneTime - subtotal);
}

export function lifetimeSavingsCents(
  perDeliveryCents: number,
  successfulOrders: number,
): number {
  return perDeliveryCents * Math.max(0, successfulOrders);
}

export function formatCents(amountCents: number, currencyCode: string): string {
  return formatMoney({ amountCents, currencyCode });
}

// ─────────────────────────────── Labels ───────────────────────────────────

export function cadenceLabel(intervalWeeks: number): string {
  if (intervalWeeks === 1) return "Every week";
  return `Every ${intervalWeeks} weeks`;
}

const MILESTONE_LABELS: Record<MilestoneType, string> = {
  TREATMENT_STARTED: "Treatment started",
  FIRST_MONTH: "One month of care",
  NINETY_DAYS: "90 days strong",
  SIX_DELIVERIES: "Six deliveries",
  ONE_YEAR: "One full year",
};

export function milestoneLabel(type: string): string {
  return MILESTONE_LABELS[type as MilestoneType] ?? "Milestone";
}

const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  TOO_MUCH_PRODUCT: "I have more product than I need",
  NOT_SEEING_IMPROVEMENT: "I'm not seeing the results I hoped for",
  TOO_EXPENSIVE: "It's more than I want to spend right now",
  ONLY_WANTED_TO_TRY: "I only wanted to try it",
  IRRITATION: "My skin is reacting to a product",
  WANT_DIFFERENT_PRODUCT: "I'd like a different product",
  TRAVELLING: "I'm travelling or away for a while",
  CIRCUMSTANCES_CHANGED: "My circumstances have changed",
  OTHER: "Something else",
};

export function cancelReasonLabel(reason: CancelReason): string {
  return CANCEL_REASON_LABELS[reason];
}

export function isCancelReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

export function productInitial(title: string): string {
  const first = title.trim().charAt(0);
  return first ? first.toUpperCase() : "C";
}

// ─────────────────────────────── Cadence options ──────────────────────────

/**
 * Distinct interval-weeks options across the shop's SellingPlanConfig rows
 * (plansJson = [{name, intervalWeeks, percentOff, shopifyPlanId}]).
 */
export function cadenceOptionsFromConfigs(plansJsonList: string[]): number[] {
  const weeks = new Set<number>();
  for (const raw of plansJsonList) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const plan of parsed) {
      if (plan && typeof plan === "object") {
        const w = (plan as Record<string, unknown>).intervalWeeks;
        if (typeof w === "number" && Number.isInteger(w) && w > 0 && w <= 52) {
          weeks.add(w);
        }
      }
    }
  }
  return [...weeks].sort((a, b) => a - b);
}

// ─────────────────────────────── Guards & decisions ───────────────────────

/** A treatment plan keeps at least one product; swap instead of emptying. */
export function canRemoveLine(lineCount: number): boolean {
  return lineCount > 1;
}

export function clampQuantity(quantity: number, min = 1, max = 12): number {
  if (!Number.isFinite(quantity)) return min;
  return Math.min(max, Math.max(min, Math.round(quantity)));
}

/** Earlier than the current next date → bring forward; later → reschedule. */
export function chooseDeliveryDateAction(
  currentNext: Date | null,
  target: Date,
): "BRING_FORWARD" | "SET_DATE" {
  if (currentNext && target.getTime() < currentNext.getTime()) {
    return "BRING_FORWARD";
  }
  return "SET_DATE";
}

/** Parse an <input type="date"> value; null when absent/invalid. */
export function parseDateInput(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Resolve a pause choice ("30" | "60" | "90" | "custom") to a resume date. */
export function pauseResumeDate(
  option: string,
  now: Date,
  customDate?: string | null,
): Date | null {
  if (option === "30" || option === "60" || option === "90") {
    return addDays(now, Number(option));
  }
  if (option === "custom") {
    const parsed = parseDateInput(customDate);
    // Date-granularity comparison: parseDateInput yields UTC midnight, an
    // instant comparison would mis-handle same-day values.
    if (parsed && isoDate(parsed) > isoDate(now)) return parsed;
  }
  return null;
}

// ─────────────────────────────── Save offers ──────────────────────────────

/**
 * Offers arrive cheapest-first from retention; present structural (zero-cost)
 * ones before monetary ones, preserving relative order within each group.
 */
export function sortOffersStructuralFirst(offers: SaveOffer[]): SaveOffer[] {
  const structural = offers.filter((o) => o.costCents === 0);
  const monetary = offers.filter((o) => o.costCents !== 0);
  return [...structural, ...monetary];
}

/**
 * Where the cancel flow sends the customer when their session is no longer
 * IN_PROGRESS (Back button, stale tab, double submit, or a housekeeping job
 * that resolved the session behind their back):
 *  - CANCELLED → the goodbye view;
 *  - SAVED     → the truthful per-offer confirmation;
 *  - anything else (ABANDONED via the 48h expiry job or the zombie sweep) →
 *    a gentle restart of the flow, never a live offers page whose accept and
 *    decline buttons can only throw.
 * Null while the session is IN_PROGRESS — the flow may continue.
 */
export function resolvedSessionRedirect(
  outcome: string,
  sessionId: string,
): string | null {
  if (outcome === "IN_PROGRESS") return null;
  if (outcome === "CANCELLED") return "/portal/cancel?cancelled=1";
  if (outcome === "SAVED") return `/portal/cancel?session=${sessionId}&saved=1`;
  return "/portal/cancel?expired=1";
}

// ─────────────────────────────── Autopilot guardrails ─────────────────────

export function parseGuardrailsForm(form: {
  maxCharge?: string | null;
  askBeforeAdding?: string | null;
  minIntervalWeeks?: string | null;
  notifyDaysBefore?: string | null;
}): AutopilotGuardrails {
  const maxChargeRaw = Number.parseFloat(form.maxCharge ?? "");
  const minIntervalRaw = Number.parseInt(form.minIntervalWeeks ?? "", 10);
  const notifyRaw = Number.parseInt(form.notifyDaysBefore ?? "", 10);
  return {
    maxChargeCents:
      Number.isFinite(maxChargeRaw) && maxChargeRaw > 0
        ? Math.round(maxChargeRaw * 100)
        : null,
    askBeforeAdding:
      form.askBeforeAdding === "on" || form.askBeforeAdding === "true",
    minIntervalWeeks:
      Number.isInteger(minIntervalRaw) && minIntervalRaw > 0
        ? Math.min(52, minIntervalRaw)
        : null,
    notifyDaysBefore: Number.isInteger(notifyRaw)
      ? Math.min(30, Math.max(0, notifyRaw))
      : 3,
  };
}

// ─────────────────────────────── Add-on suggestions ───────────────────────

export interface PortalAddOnSuggestion {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  priceCents: number;
  reason: string | null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Defensive adapter over offers/preShipment `rankAddOnCandidates` output:
 * keeps the portal rendering resilient to field naming while integration
 * settles. Candidates missing a variant, title or price are dropped.
 */
export function normalizeRankedAddOns(raw: unknown): PortalAddOnSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: PortalAddOnSuggestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const productId = firstString(record, [
      "shopifyProductId",
      "productId",
      "productGid",
    ]);
    const variantId = firstString(record, [
      "shopifyVariantId",
      "variantId",
      "variantGid",
    ]);
    const title = firstString(record, ["title", "productTitle", "name"]);
    const priceCents = firstNumber(record, [
      "priceCents",
      "currentPriceCents",
      "unitPriceCents",
    ]);
    let reason = firstString(record, ["reason", "why", "rationale"]);
    if (!reason && Array.isArray(record.reasons)) {
      const first = record.reasons.find(
        (r): r is string => typeof r === "string" && r.length > 0,
      );
      reason = first ?? null;
    }
    if (!productId || !variantId || !title || priceCents === null) continue;
    out.push({
      shopifyProductId: productId,
      shopifyVariantId: variantId,
      title,
      priceCents,
      reason,
    });
  }
  return out;
}

// ─────────────────────────────── Ranking inputs ───────────────────────────

/** One catalog row prepared for ranking: ProductMeta joined with a real,
 *  currently-sellable default variant and its subscriber price. Rows without
 *  a variant or price are dropped by the builder — a suggestion the action
 *  cannot fulfil at an honest price must never render. */
export interface SuggestionCatalogRow {
  shopifyProductId: string;
  title: string;
  concern: string | null;
  grossMarginPercent: number | null;
  variantId: string | null;
  priceCents: number | null;
  availableForSale: boolean;
}

function isKnownRelation(value: string): value is CompatibilityRelation {
  return (COMPATIBILITY_RELATIONS as readonly string[]).includes(value);
}

/**
 * Assemble a GENUINE `AddOnRankingInputs` for offers/preShipment
 * `rankAddOnCandidates` — the exact field names the ranker reads
 * (currentProductIds, candidates keyed by productId, edges, customerConcerns).
 * Pure: plain rows in, plain inputs out; unit-tested against the real ranker.
 */
export function buildAddOnRankingInputs(args: {
  lines: Array<{ shopifyProductId: string }>;
  catalog: SuggestionCatalogRow[];
  edges: Array<{
    fromProductId: string;
    toProductId: string;
    relation: string;
    strength: number;
  }>;
  /** ProductMeta concern per product id (raw AND gid keys both welcome). */
  concernByProductId: Record<string, string | null | undefined>;
}): AddOnRankingInputs {
  const currentProductIds = args.lines.map((line) => line.shopifyProductId);

  const candidates = args.catalog
    .filter(
      (row): row is SuggestionCatalogRow & {
        variantId: string;
        priceCents: number;
      } =>
        row.availableForSale &&
        typeof row.variantId === "string" &&
        row.variantId.length > 0 &&
        typeof row.priceCents === "number" &&
        Number.isFinite(row.priceCents) &&
        row.priceCents > 0,
    )
    .map((row) => ({
      productId: row.shopifyProductId,
      variantId: row.variantId,
      title: row.title,
      priceCents: row.priceCents,
      marginPercent: row.grossMarginPercent,
      inventoryAvailable: true,
      concern: row.concern,
    }));

  const edges: CompatibilityEdgeInput[] = args.edges
    .filter((edge) => isKnownRelation(edge.relation))
    .map((edge) => ({
      fromProductId: edge.fromProductId,
      toProductId: edge.toProductId,
      relation: edge.relation as CompatibilityRelation,
      strength: edge.strength,
    }));

  const customerConcerns = [
    ...new Set(
      currentProductIds
        .map((id) => args.concernByProductId[id])
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  ];

  return { currentProductIds, candidates, edges, customerConcerns };
}

// ─────────────────────────────── Cancel-flow offer choices ────────────────

/** The customer-safe subset of a SaveOffer's params the portal may render. */
export interface PortalOfferChoice {
  action: string | null;
  delayWeeksOptions: number[];
  defaultDelayWeeks: number | null;
  daysOptions: number[];
  defaultDays: number | null;
  customResumeDateAllowed: boolean;
  intervalWeeksOptions: number[];
  defaultIntervalWeeks: number | null;
  currentIntervalWeeks: number | null;
  /** PRODUCT_SWAP: candidate product ids (loader resolves display titles). */
  candidateProductIds: string[];
  /** REMOVE_ITEM / PRODUCT_SWAP: selectable lines. */
  lineOptions: Array<{ lineId: string; title: string }>;
  suggestedLineId: string | null;
  collectDetails: boolean;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
  );
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whitelist a persisted offer's params for the portal view. Anything not
 * understood is dropped — offersJson is trusted server data, but the view
 * only ever needs these knobs and must never leak internals.
 */
export function whitelistOfferParams(
  params: Record<string, unknown>,
): PortalOfferChoice {
  const lineOptionsRaw = Array.isArray(params.lineOptions)
    ? params.lineOptions
    : [];
  const lineOptions: Array<{ lineId: string; title: string }> = [];
  for (const option of lineOptionsRaw) {
    if (!option || typeof option !== "object") continue;
    const record = option as Record<string, unknown>;
    if (typeof record.lineId === "string" && typeof record.title === "string") {
      lineOptions.push({ lineId: record.lineId, title: record.title });
    }
  }
  return {
    action: typeof params.action === "string" ? params.action : null,
    delayWeeksOptions: numberArray(params.delayWeeksOptions),
    defaultDelayWeeks: optionalNumber(params.defaultDelayWeeks),
    daysOptions: numberArray(params.daysOptions),
    defaultDays: optionalNumber(params.defaultDays),
    customResumeDateAllowed: params.customResumeDateAllowed === true,
    intervalWeeksOptions: numberArray(params.intervalWeeksOptions),
    defaultIntervalWeeks: optionalNumber(params.defaultIntervalWeeks),
    currentIntervalWeeks: optionalNumber(params.currentIntervalWeeks),
    candidateProductIds: Array.isArray(params.candidates)
      ? params.candidates.filter(
          (c): c is string => typeof c === "string" && c.length > 0,
        )
      : [],
    lineOptions,
    suggestedLineId:
      typeof params.suggestedLineId === "string" ? params.suggestedLineId : null,
    collectDetails: params.collectDetails === true,
  };
}

export type ChosenParamsResult =
  | { ok: true; chosen: Record<string, unknown> | undefined }
  | { ok: false; error: string };

/**
 * Turn the accept-offer form selection into the `chosenParams` handed to
 * retention `acceptOffer`. Validates AGAINST the advertised options (defence
 * in depth — the service re-validates) so a tampered POST can only ever pick
 * something the offer genuinely promised. `undefined` chosen = offer has no
 * parameters; the service executes its stated default.
 */
export function buildChosenParams(
  offerType: SaveOfferType,
  choice: PortalOfferChoice,
  raw: Record<string, string>,
  now: Date,
): ChosenParamsResult {
  switch (offerType) {
    case "CHANGE_DELIVERY_DATE": {
      if (choice.action === "SKIP_NEXT" || choice.delayWeeksOptions.length === 0) {
        return { ok: true, chosen: undefined };
      }
      const weeks = Number(raw.delayWeeks);
      if (!choice.delayWeeksOptions.includes(weeks)) {
        return { ok: false, error: "choice" };
      }
      return { ok: true, chosen: { delayWeeks: weeks } };
    }
    case "CHANGE_FREQUENCY": {
      if (choice.intervalWeeksOptions.length === 0) {
        return { ok: true, chosen: undefined };
      }
      const weeks = Number(raw.intervalWeeks);
      if (!choice.intervalWeeksOptions.includes(weeks)) {
        return { ok: false, error: "choice" };
      }
      return { ok: true, chosen: { intervalWeeks: weeks } };
    }
    case "TEMPORARY_PAUSE": {
      if (choice.daysOptions.length === 0 && !choice.customResumeDateAllowed) {
        return { ok: true, chosen: undefined };
      }
      if (raw.pauseOption === "custom") {
        if (!choice.customResumeDateAllowed) {
          return { ok: false, error: "choice" };
        }
        const resume = pauseResumeDate("custom", now, raw.pauseCustomDate);
        // Custom resume dates are honoured 1–180 days out (matches the
        // retention service's CUSTOM_PAUSE_MAX_DAYS bound).
        if (!resume || resume.getTime() > addDays(now, 180).getTime()) {
          return { ok: false, error: "pause-date" };
        }
        return { ok: true, chosen: { resumeDate: isoDate(resume) } };
      }
      const days = Number(raw.pauseOption);
      if (!choice.daysOptions.includes(days)) {
        return { ok: false, error: "choice" };
      }
      return { ok: true, chosen: { days } };
    }
    case "PRODUCT_SWAP": {
      if (choice.candidateProductIds.length === 0) {
        return { ok: false, error: "swap-unavailable" };
      }
      const productId = raw.swapProductId;
      if (!choice.candidateProductIds.includes(productId)) {
        return { ok: false, error: "choice" };
      }
      const chosen: Record<string, unknown> = { targetProductId: productId };
      if (raw.swapLineId) {
        if (!choice.lineOptions.some((o) => o.lineId === raw.swapLineId)) {
          return { ok: false, error: "choice" };
        }
        chosen.lineId = raw.swapLineId;
      } else if (choice.lineOptions.length === 1) {
        chosen.lineId = choice.lineOptions[0].lineId;
      }
      return { ok: true, chosen };
    }
    case "REMOVE_ITEM": {
      if (choice.lineOptions.length === 0) {
        return { ok: true, chosen: undefined };
      }
      const lineId = raw.removeLineId || choice.suggestedLineId || "";
      if (!choice.lineOptions.some((o) => o.lineId === lineId)) {
        return { ok: false, error: "choice" };
      }
      return { ok: true, chosen: { lineId } };
    }
    case "EDUCATION": {
      if (!choice.collectDetails) return { ok: true, chosen: undefined };
      const details = (raw.details ?? "").trim();
      if (!details) return { ok: false, error: "details" };
      return { ok: true, chosen: { details: details.slice(0, 2000) } };
    }
    default:
      return { ok: true, chosen: undefined };
  }
}

/**
 * Truthful per-offer lead sentence for the cancel flow's saved screen — the
 * confirmation states exactly what happened, keyed on the accepted offer.
 */
export function savedOfferLead(args: {
  offerType: string | null;
  nextDeliveryLabel: string | null;
  pausedUntilLabel: string | null;
  amountLabel: string | null;
  removedTitle: string | null;
  intervalWeeks: number | null;
  quantity: number | null;
  swapTitle: string | null;
}): string {
  switch (args.offerType) {
    case "CHANGE_DELIVERY_DATE":
      return args.nextDeliveryLabel
        ? `Your next delivery moves to ${args.nextDeliveryLabel} — nothing else changes.`
        : "Your next delivery has been rescheduled — nothing else changes.";
    case "TEMPORARY_PAUSE":
      return args.pausedUntilLabel
        ? `Your treatment is paused — deliveries resume around ${args.pausedUntilLabel}, and we'll remind you before they do.`
        : "Your treatment is paused — we'll remind you before it resumes.";
    case "ACCOUNT_CREDIT":
      return args.amountLabel
        ? `A credit of ${args.amountLabel} has been applied to your next delivery — your plan stays exactly as it is.`
        : "A credit has been applied to your next delivery — your plan stays exactly as it is.";
    case "TEMPORARY_DISCOUNT":
      return args.amountLabel
        ? `A one-time saving of ${args.amountLabel} applies to your next delivery — everything else stays the same.`
        : "Your one-time saving applies to your next delivery — everything else stays the same.";
    case "CHANGE_FREQUENCY":
      return args.intervalWeeks
        ? `Your deliveries now arrive every ${args.intervalWeeks} weeks — everything else stays the same.`
        : "Your delivery rhythm has been slowed — everything else stays the same.";
    case "CHANGE_QUANTITY":
      return args.quantity
        ? `Your deliveries now include ${args.quantity} per delivery — everything else stays the same.`
        : "You'll now receive a little less each delivery — everything else stays the same.";
    case "REMOVE_ITEM":
      return args.removedTitle
        ? `${args.removedTitle} has been removed from your plan — the rest of your routine continues as before.`
        : "That product has been removed from your plan — the rest of your routine continues as before.";
    case "PRODUCT_SWAP":
      return args.swapTitle
        ? `Your plan now includes ${args.swapTitle} instead — your schedule, pricing and milestones stay as they are.`
        : "Your product has been switched — your schedule, pricing and milestones stay as they are.";
    case "EDUCATION":
      return "Thank you for telling us — our care team will review this with you personally. Your plan stays as it is until then.";
    case "FREE_GIFT":
      return "A complimentary booster joins your next delivery — nothing else changes.";
    default:
      return "Your plan is updated — nothing else changes.";
  }
}

// ─────────────────────────────── Routine recommendation ───────────────────

export interface PortalRoutineStep {
  productId: string;
  title: string | null;
  role: string | null;
  timeOfDay: string | null;
  optional: boolean;
}

export interface PortalRoutine {
  steps: PortalRoutineStep[];
  notes: string[];
}

/** Defensive adapter over treatment/routines `recommendRoutine` output. */
export function normalizeRoutineRecommendation(raw: unknown): PortalRoutine {
  const empty: PortalRoutine = { steps: [], notes: [] };
  if (typeof raw !== "object" || raw === null) return empty;
  const record = raw as Record<string, unknown>;
  const stepsRaw =
    (Array.isArray(record.steps) && record.steps) ||
    (Array.isArray(record.products) && record.products) ||
    (Array.isArray(record.items) && record.items) ||
    [];
  const steps: PortalRoutineStep[] = [];
  for (const item of stepsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const step = item as Record<string, unknown>;
    const productId = firstString(step, [
      "productId",
      "shopifyProductId",
      "productGid",
    ]);
    if (!productId) continue;
    steps.push({
      productId,
      title: firstString(step, ["title", "productTitle", "name"]),
      role: firstString(step, ["role", "step", "purpose"]),
      timeOfDay: firstString(step, ["timeOfDay", "time"]),
      optional: step.optional === true,
    });
  }
  const notes: string[] = [];
  for (const key of ["notes", "coherenceNotes", "warnings"]) {
    const value = record[key];
    if (typeof value === "string" && value) notes.push(value);
    if (Array.isArray(value)) {
      for (const n of value) if (typeof n === "string" && n) notes.push(n);
    }
  }
  return { steps, notes };
}

export function groupByTimeOfDay<T extends { timeOfDay: string | null }>(
  steps: T[],
): { am: T[]; pm: T[]; anytime: T[] } {
  const am: T[] = [];
  const pm: T[] = [];
  const anytime: T[] = [];
  for (const step of steps) {
    if (step.timeOfDay === "AM") am.push(step);
    else if (step.timeOfDay === "PM") pm.push(step);
    else anytime.push(step);
  }
  return { am, pm, anytime };
}

export interface CompatibilityEdgeLite {
  fromProductId: string;
  toProductId: string;
  relation: string;
}

/**
 * Human coherence notes for a set of recommended products, from the
 * compatibility graph: application order, stagger advice, conflicts.
 */
export function coherenceNotes(
  productIds: string[],
  titleByProductId: Record<string, string>,
  edges: CompatibilityEdgeLite[],
): string[] {
  const included = new Set(productIds);
  const notes: string[] = [];
  const seen = new Set<string>();
  const name = (id: string) => titleByProductId[id] ?? "this product";
  for (const edge of edges) {
    if (!included.has(edge.fromProductId) || !included.has(edge.toProductId)) {
      continue;
    }
    const pairKey = [edge.relation, ...[edge.fromProductId, edge.toProductId].sort()].join("|");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    if (edge.relation === "ROUTINE_STEP_BEFORE") {
      notes.push(
        `Apply ${name(edge.fromProductId)} before ${name(edge.toProductId)}.`,
      );
    } else if (edge.relation === "STAGGER") {
      notes.push(
        `${name(edge.fromProductId)} and ${name(edge.toProductId)} work best on alternate days.`,
      );
    } else if (edge.relation === "SENSITIVITY_CONFLICT") {
      notes.push(
        `${name(edge.fromProductId)} and ${name(edge.toProductId)} are both active — introduce them gently, never in the same session.`,
      );
    }
  }
  return notes;
}

// ─────────────────────────────── Dates for copy ───────────────────────────

/**
 * "5 August" — pinned to UTC so the stored calendar day renders identically
 * on every host. Contract dates are UTC midnights; an unpinned formatter on a
 * negative-offset host shifts every portal date one day early.
 */
export function humanDateUtc(date: Date, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

export function humanDateLabel(date: Date | string | null): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  return humanDateUtc(d);
}

// ─────────────────────────────── Fonts ────────────────────────────────────

/**
 * @font-face overrides pointing at the configured asset base URL
 * (ShopSettings.settingsJson.fontBaseUrl or PORTAL_FONT_BASE_URL). Returned
 * as a string the portal layout inlines; portal.css carries system fallbacks
 * plus default /fonts/ faces, so an empty string is always safe.
 */
export function buildFontFaceCss(baseUrl: string | null): string {
  if (!baseUrl) return "";
  const base = baseUrl.replace(/\/+$/, "");
  return [
    `@font-face{font-family:"Gobold";src:url("${base}/Gobold.woff2") format("woff2"),url("${base}/Gobold.woff") format("woff");font-weight:400;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:"argumentum";src:url("${base}/Argumentum-Regular.woff2") format("woff2"),url("${base}/Argumentum-Regular.woff") format("woff");font-weight:400;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:"argumentum";src:url("${base}/Argumentum-Medium.woff2") format("woff2"),url("${base}/Argumentum-Medium.woff") format("woff");font-weight:500;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:"argumentum";src:url("${base}/Argumentum-SemiBold.woff2") format("woff2"),url("${base}/Argumentum-SemiBold.woff") format("woff");font-weight:600;font-style:normal;font-display:swap;}`,
  ].join("\n");
}
