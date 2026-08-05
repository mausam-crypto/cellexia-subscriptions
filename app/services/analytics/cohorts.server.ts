/**
 * Cohort tables [analytics].
 *
 * `getCohortTable(shop, dimension, metric)` — monthly cohort columns (M0..M11)
 * across 15 acquisition/behaviour dimensions and 4 metrics, plus the flagship
 * `bestConfigurations(shop)` query: which acquisition source x offer x product
 * x cadence combination produces the highest 12-month contribution margin.
 *
 * Month offsets use the mean Gregorian month (30.4375 days) so cohorts are
 * comparable regardless of start day. The cohort clock is the contract's REAL
 * Shopify creation date (`treatmentStartedAt`, mirrored from
 * `remote.createdAt`), not the local row's first-seen `createdAt` — back-book
 * imports and reinstalls would otherwise all land in the install month.
 *
 * Churn: a member has exited when `cancelledAt` is stamped OR its status is
 * terminal (CANCELLED/EXPIRED/FAILED) — Shopify-side cancels arrive via
 * webhook sync with status only, never a `cancelledAt`.
 *
 * Money: LTV/contribution cells are cumulative REALISED payments including
 * cycle 0 — the origin checkout order (`firstOrderAovCents`) counts as the
 * first payment. Contribution uses the cost engine (`orderContribution`), the
 * full LTGP formula, not raw product margin.
 *
 * Re-exported from services/analytics/metrics.server per the cross-service
 * contract.
 */
import prisma from "~/db.server";
import { daysBetween, isoDate } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import { marketFromAddressJson } from "~/services/analytics/forecast.server";
import {
  getCostModel,
  metaByProductId,
  orderContribution,
} from "~/services/analytics/costModel.server";

// ───────────────────────────── Vocabulary ──────────────────────────────────

export {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
} from "~/services/analytics/cohortTypes";
export type {
  CohortDimension,
  CohortMetric,
} from "~/services/analytics/cohortTypes";
import {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
  type CohortDimension,
  type CohortMetric,
} from "~/services/analytics/cohortTypes";

export const COHORT_MONTH_COLUMNS = 12;

export interface CohortRow {
  key: string;
  cohortSize: number;
  /**
   * One value per month offset M0..M11; null when the cohort is too young to
   * be observed at that offset. retention cells are fractions 0..1; *Cents
   * cells are integer minor units; subscribers cells are absolute counts.
   */
  cells: (number | null)[];
}

export interface CohortTable {
  dimension: CohortDimension;
  metric: CohortMetric;
  columns: string[];
  rows: CohortRow[];
  generatedAt: string;
}

// ───────────────────────────── Pure helpers ────────────────────────────────

const AVG_MONTH_DAYS = 30.4375;

/** Whole "average months" elapsed between two dates (negative if at < start). */
export function monthOffset(start: Date, at: Date): number {
  return Math.floor(daysBetween(start, at) / AVG_MONTH_DAYS);
}

export function aovBandCents(cents: number | null): string {
  if (cents == null) return "unknown";
  if (cents < 5000) return "< 50";
  if (cents < 10000) return "50-99";
  if (cents < 15000) return "100-149";
  return "150+";
}

export function discountBand(percent: number | null): string {
  if (percent == null || percent <= 0) return "no intro discount";
  if (percent <= 10) return "1-10%";
  if (percent <= 20) return "11-20%";
  return "21%+";
}

export function profitBandCents(cents: number | null): string {
  if (cents == null) return "unknown";
  if (cents < 2500) return "< 25";
  if (cents < 5000) return "25-49";
  if (cents < 10000) return "50-99";
  return "100+";
}

/** Statuses that mean the contract has terminally exited. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);

/**
 * PURE — effective churn date of a contract. Uses `cancelledAt` when the
 * app's own cancel flow stamped it; otherwise, for contracts whose status
 * became terminal via a Shopify-side cancel/expiry/failure (the webhook sync
 * mirrors `status` but never writes `cancelledAt`), falls back to the row's
 * `updatedAt` — the terminal sync is typically the last write, so it is the
 * best available churn-date proxy. Returns null while the contract lives.
 */
export function effectiveCancelledAt(c: {
  status: string;
  cancelledAt: Date | null;
  updatedAt: Date;
}): Date | null {
  if (c.cancelledAt) return c.cancelledAt;
  return TERMINAL_STATUSES.has(c.status) ? c.updatedAt : null;
}

const ORIGIN_PAYMENT_WINDOW_MS = 2 * 86_400_000;

/**
 * PURE — ensure the cycle-0 (origin checkout) payment is present in a
 * member's payment list. `BillingAttempt` rows are only written for rebills,
 * so without this the first order is invisible to LTV/contribution math
 * (M0 LTV would read 0 and 12-month LTV would be short one full AOV).
 * Prepends a synthetic payment of `firstOrderAovCents` at the cohort anchor
 * unless a recorded payment already sits within 2 days of it (e.g. seeded
 * cycle-0 attempts) — rebills cannot occur before one interval (minimum one
 * week), so the window can never swallow a genuine rebill.
 */
export function withOriginPayment(
  payments: Array<{ amountCents: number; occurredAt: Date }>,
  anchor: Date,
  firstOrderAovCents: number | null,
): Array<{ amountCents: number; occurredAt: Date }> {
  if (firstOrderAovCents == null) return payments;
  const hasOriginPayment = payments.some(
    (p) => p.occurredAt.getTime() - anchor.getTime() < ORIGIN_PAYMENT_WINDOW_MS,
  );
  if (hasOriginPayment) return payments;
  return [{ amountCents: firstOrderAovCents, occurredAt: anchor }, ...payments];
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

export interface CohortKeyInput {
  createdAt: Date;
  acquisitionJson: string | null;
  deliveryAddressJson: string | null;
  widgetVersion: string | null;
  initialDiscountPercent: number | null;
  firstOrderAovCents: number | null;
  intervalWeeks: number;
  /** Blended contribution fraction of the contract's current lines. */
  contributionFraction: number;
  lines: Array<{
    title: string;
    quantity: number;
    sellingPlanName: string | null;
    createdAt: Date;
  }>;
}

/** PURE — derive the cohort key of a contract for a given dimension. */
export function cohortKeyFor(
  dimension: CohortDimension,
  c: CohortKeyInput,
): string {
  const acq = parseJson<Record<string, unknown>>(c.acquisitionJson, {});
  // The webhook writer stores the parseAcquisitionAttributes shape: UTM keys
  // nested under `utm` and `_cellexia_*` keys under `custom`. Merge both into
  // a flat view (top-level keys win) so the pickString key lists below resolve
  // for the nested writer shape as well as flat legacy/seed shapes.
  const utm = (typeof acq.utm === "object" && acq.utm ? acq.utm : {}) as Record<
    string,
    unknown
  >;
  const custom = (
    typeof acq.custom === "object" && acq.custom ? acq.custom : {}
  ) as Record<string, unknown>;
  const flat: Record<string, unknown> = { ...acq };
  for (const [k, v] of Object.entries(utm)) {
    if (flat[k] == null) flat[k] = v;
  }
  for (const [k, v] of Object.entries(custom)) {
    const stripped = k.replace(/^_cellexia_/, "");
    if (flat[stripped] == null) flat[stripped] = v;
  }
  const firstLine = [...c.lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];

  switch (dimension) {
    case "startMonth":
      return isoDate(c.createdAt).slice(0, 7);
    case "firstProduct":
      return firstLine?.title ?? "unknown";
    case "country":
      return marketFromAddressJson(c.deliveryAddressJson);
    case "acquisitionChannel":
      // v2 acquisition records (schemaVersion 2, acquisition.server.ts) store
      // the derived channel at top level as `channel`; utm.utm_source arrives
      // via the flat-merge above. Key order keeps `channel` authoritative.
      return (
        pickString(flat, ["channel", "utmSource", "utm_source", "source"]) ??
        "unknown"
      );
    case "landingPage":
      // v2 name is `landingPage` (top level); `landing` covers the widget's
      // `_cellexia_landing` attribute after the custom-prefix strip above.
      return (
        pickString(flat, [
          "landingPage",
          "landing_page",
          "landingPath",
          "landing",
        ]) ?? "unknown"
      );
    case "advertorial":
      return (
        pickString(flat, ["advertorial", "advertorialId", "advertorial_id"]) ??
        "none"
      );
    case "campaign":
      return (
        pickString(flat, ["campaign", "utmCampaign", "utm_campaign"]) ??
        "unknown"
      );
    case "initialDiscount":
      return discountBand(c.initialDiscountPercent);
    case "initialQuantity": {
      // The webhook writer stores widget attributes as STRINGS under
      // custom._cellexia_initial_quantity (stripped to `initial_quantity` by
      // the merge above); accept both key spellings and coerce strings.
      const fromAcq = flat.initialQuantity ?? flat.initial_quantity;
      const parsed =
        typeof fromAcq === "number"
          ? fromAcq
          : typeof fromAcq === "string"
            ? Number.parseFloat(fromAcq)
            : NaN;
      let qty: number;
      if (Number.isFinite(parsed)) {
        qty = parsed;
      } else {
        // Fallback: sum quantities of the INITIAL lines only — lines created
        // within 24h of the earliest line (relative to the earliest LINE, not
        // contract createdAt, so backfilled/imported contracts still work).
        // Products added later must not move the contract into a
        // higher-quantity cohort. Residual approximation: quantity edits to
        // an original line still reflect the current value.
        const t0 = Math.min(...c.lines.map((l) => l.createdAt.getTime()));
        qty = c.lines
          .filter((l) => l.createdAt.getTime() - t0 <= 86_400_000)
          .reduce((sum, line) => sum + line.quantity, 0);
      }
      return qty >= 4 ? "4+" : String(Math.max(0, Math.round(qty)));
    }
    case "sellingPlanConfig":
      return (
        pickString(flat, ["sellingPlanConfig", "sellingPlanGroup"]) ??
        firstLine?.sellingPlanName ??
        "unknown"
      );
    case "device":
      return pickString(flat, ["device", "deviceType", "device_type"]) ?? "unknown";
    case "newVsReturning": {
      const returning = flat.returning ?? flat.isReturning;
      if (typeof returning === "boolean") return returning ? "returning" : "new";
      // Attribute-sourced values are always strings ("true"/"false"); accept
      // them normalised — never emit raw "true"/"false" as cohort row labels.
      if (typeof returning === "string") {
        const v = returning.trim().toLowerCase();
        if (v === "true" || v === "1" || v === "yes" || v === "returning") {
          return "returning";
        }
        if (v === "false" || v === "0" || v === "no" || v === "new") {
          return "new";
        }
      }
      return (
        pickString(flat, ["newVsReturning", "customerType", "customer_type"]) ??
        "unknown"
      );
    }
    case "firstOrderAovBand":
      return aovBandCents(c.firstOrderAovCents);
    case "firstShipmentProfitBand":
      return profitBandCents(
        c.firstOrderAovCents == null
          ? null
          : Math.round(c.firstOrderAovCents * c.contributionFraction),
      );
    case "widgetVersion":
      return c.widgetVersion ?? "unknown";
  }
}

// ───────────────────────────── Table computation ───────────────────────────

export interface CohortMember {
  /** Cohort anchor — the contract's real Shopify creation date. */
  createdAt: Date;
  /** Effective churn date (see `effectiveCancelledAt`); null while alive. */
  cancelledAt: Date | null;
  /**
   * When the contract was merged into another (cancelReason MERGED) the
   * member is censored — removed from the risk set — from that month on:
   * a merge is consolidation, not churn.
   */
  mergedAt: Date | null;
  contributionFraction: number;
  /**
   * Realised payments (amountCents, occurredAt), any order. Includes the
   * cycle-0 origin order (see `withOriginPayment`).
   */
  payments: Array<{ amountCents: number; occurredAt: Date }>;
}

/**
 * Members observable at month offset m: old enough to be observed and not
 * censored out by a merge at or before m.
 */
function observableAt(
  members: CohortMember[],
  m: number,
  now: Date,
): CohortMember[] {
  return members.filter(
    (x) =>
      monthOffset(x.createdAt, now) >= m &&
      (x.mergedAt == null || monthOffset(x.createdAt, x.mergedAt) > m),
  );
}

/**
 * PURE, exported for tests — share of the cohort's observable members still
 * active at month m; null when nobody is observable yet.
 */
export function retentionCell(
  members: CohortMember[],
  m: number,
  now: Date,
): number | null {
  const eligible = observableAt(members, m, now);
  if (eligible.length === 0) return null;
  const survivors = eligible.filter(
    (x) => !x.cancelledAt || monthOffset(x.createdAt, x.cancelledAt) > m,
  ).length;
  return survivors / eligible.length;
}

/** PURE, exported for tests — `retentionCell` as an absolute count. */
export function subscribersCell(
  members: CohortMember[],
  m: number,
  now: Date,
): number | null {
  const eligible = observableAt(members, m, now);
  if (eligible.length === 0) return null;
  return eligible.filter(
    (x) => !x.cancelledAt || monthOffset(x.createdAt, x.cancelledAt) > m,
  ).length;
}

/**
 * PURE, exported for tests — cumulative realised revenue through month
 * offset `throughMonth`, INCLUDING the cycle-0 origin payment.
 */
export function cumulativeRevenueCents(
  member: CohortMember,
  throughMonth: number,
): number {
  let sum = 0;
  for (const payment of member.payments) {
    if (monthOffset(member.createdAt, payment.occurredAt) <= throughMonth) {
      sum += payment.amountCents;
    }
  }
  return sum;
}

/**
 * PURE, exported for tests — average cumulative revenue (or contribution)
 * per eligible member (old enough to be observed) through month m; null when
 * nobody is observable yet. Merged members stay eligible here: their
 * pre-merge payments are real cohort revenue.
 */
export function ltvCell(
  members: CohortMember[],
  m: number,
  now: Date,
  contribution: boolean,
): number | null {
  const eligible = members.filter((x) => monthOffset(x.createdAt, now) >= m);
  if (eligible.length === 0) return null;
  let total = 0;
  for (const member of eligible) {
    const revenue = cumulativeRevenueCents(member, m);
    total += contribution ? revenue * member.contributionFraction : revenue;
  }
  return Math.round(total / eligible.length);
}

interface LoadedContract {
  member: CohortMember;
  keyInput: CohortKeyInput;
  intervalWeeks: number;
  acquisitionJson: string | null;
  initialDiscountPercent: number | null;
}

async function loadContracts(shop: string): Promise<LoadedContract[]> {
  const [model, contracts, attempts] = await Promise.all([
    getCostModel(shop),
    prisma.subscriptionContract.findMany({
      where: { shop },
      include: { lines: true },
    }),
    prisma.billingAttempt.findMany({
      where: { shop, status: "SUCCESS" },
      select: { contractId: true, amountCents: true, occurredAt: true },
    }),
  ]);

  const productIds = [
    ...new Set(contracts.flatMap((c) => c.lines.map((l) => l.shopifyProductId))),
  ];
  const metaByProduct = await metaByProductId(shop, productIds);

  const paymentsByContract = new Map<
    string,
    Array<{ amountCents: number; occurredAt: Date }>
  >();
  for (const attempt of attempts) {
    if (attempt.amountCents == null) continue;
    const list = paymentsByContract.get(attempt.contractId);
    const entry = { amountCents: attempt.amountCents, occurredAt: attempt.occurredAt };
    if (list) list.push(entry);
    else paymentsByContract.set(attempt.contractId, [entry]);
  }

  return contracts.map((c) => {
    // Cohort clock: the contract's REAL Shopify creation time — the local
    // row's createdAt is only the first-seen/mirror moment and mis-dates
    // back-book imports, reinstalls and missed CREATE webhooks.
    const anchor = c.treatmentStartedAt ?? c.createdAt;

    // Full contribution (LTGP) fraction via the cost engine. Contracts with
    // no line value fall back to the shop's default margin fraction.
    const lineValue = c.lines.reduce(
      (sum, line) => sum + line.currentPriceCents * line.quantity,
      0,
    );
    const contributionFraction =
      lineValue > 0
        ? orderContribution(
            {
              lines: c.lines.map((line) => ({
                priceCents: line.currentPriceCents,
                quantity: line.quantity,
                meta: metaByProduct.get(line.shopifyProductId) ?? null,
              })),
            },
            model,
          ).contributionFraction
        : model.defaultMarginFraction;

    const cancelledAt = effectiveCancelledAt(c);

    return {
      member: {
        createdAt: anchor,
        cancelledAt,
        mergedAt:
          c.cancelReason === "MERGED" && cancelledAt ? cancelledAt : null,
        contributionFraction,
        payments: withOriginPayment(
          paymentsByContract.get(c.id) ?? [],
          anchor,
          c.firstOrderAovCents,
        ),
      },
      keyInput: {
        createdAt: anchor,
        acquisitionJson: c.acquisitionJson,
        deliveryAddressJson: c.deliveryAddressJson,
        widgetVersion: c.widgetVersion,
        initialDiscountPercent: c.initialDiscountPercent,
        firstOrderAovCents: c.firstOrderAovCents,
        intervalWeeks: c.intervalWeeks,
        contributionFraction,
        lines: c.lines.map((line) => ({
          title: line.title,
          quantity: line.quantity,
          sellingPlanName: line.sellingPlanName,
          createdAt: line.createdAt,
        })),
      },
      intervalWeeks: c.intervalWeeks,
      acquisitionJson: c.acquisitionJson,
      initialDiscountPercent: c.initialDiscountPercent,
    };
  });
}

export async function getCohortTable(
  shop: string,
  dimension: CohortDimension,
  metric: CohortMetric,
): Promise<CohortTable> {
  const now = new Date();
  const loaded = await loadContracts(shop);

  const groups = new Map<string, CohortMember[]>();
  for (const { member, keyInput } of loaded) {
    const key = cohortKeyFor(dimension, keyInput);
    const list = groups.get(key);
    if (list) list.push(member);
    else groups.set(key, [member]);
  }

  const columns = Array.from(
    { length: COHORT_MONTH_COLUMNS },
    (_, i) => `M${i}`,
  );

  const rows: CohortRow[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => {
      const cells: (number | null)[] = [];
      for (let m = 0; m < COHORT_MONTH_COLUMNS; m++) {
        switch (metric) {
          case "retention":
            cells.push(retentionCell(members, m, now));
            break;
          case "subscribers":
            cells.push(subscribersCell(members, m, now));
            break;
          case "ltvCents":
            cells.push(ltvCell(members, m, now, false));
            break;
          case "contributionCents":
            cells.push(ltvCell(members, m, now, true));
            break;
        }
      }
      return { key, cohortSize: members.length, cells };
    });

  return {
    dimension,
    metric,
    columns,
    rows,
    generatedAt: now.toISOString(),
  };
}

// ───────────────────────────── Best configurations ─────────────────────────

export interface BestConfiguration {
  /** Acquisition source/channel. */
  source: string;
  /** Introductory offer band (discount at signup). */
  offer: string;
  /** First product on the plan. */
  product: string;
  cadenceWeeks: number;
  contracts: number;
  /** Contracts observed for a full 12 months (fully mature cohort members). */
  matureContracts: number;
  /** Average contribution margin earned per contract in its first 12 months. */
  avgContribution12mCents: number;
  totalContribution12mCents: number;
}

/**
 * Flagship query: top acquisition source x offer x product x cadence
 * combinations ranked by average 12-month contribution margin per contract.
 * The 12-month contribution is the sum of REALISED payments in M0..M11 —
 * including the cycle-0 origin order, so intro-discount economics are
 * actually measured — times the contract's cost-engine contribution
 * fraction. Young contracts contribute partial totals — check
 * `matureContracts` before treating a combo as proven.
 */
export async function bestConfigurations(
  shop: string,
  limit = 25,
): Promise<BestConfiguration[]> {
  const now = new Date();
  const loaded = await loadContracts(shop);

  interface Combo {
    source: string;
    offer: string;
    product: string;
    cadenceWeeks: number;
    contracts: number;
    matureContracts: number;
    totalContribution: number;
  }
  const combos = new Map<string, Combo>();

  for (const { member, keyInput, intervalWeeks } of loaded) {
    const source = cohortKeyFor("acquisitionChannel", keyInput);
    const offer = discountBand(keyInput.initialDiscountPercent);
    const product = cohortKeyFor("firstProduct", keyInput);
    const key = `${source}|${offer}|${product}|${intervalWeeks}`;

    let combo = combos.get(key);
    if (!combo) {
      combo = {
        source,
        offer,
        product,
        cadenceWeeks: intervalWeeks,
        contracts: 0,
        matureContracts: 0,
        totalContribution: 0,
      };
      combos.set(key, combo);
    }
    combo.contracts++;
    if (monthOffset(member.createdAt, now) >= 12) combo.matureContracts++;
    combo.totalContribution +=
      cumulativeRevenueCents(member, 11) * member.contributionFraction;
  }

  return [...combos.values()]
    .map((combo) => ({
      source: combo.source,
      offer: combo.offer,
      product: combo.product,
      cadenceWeeks: combo.cadenceWeeks,
      contracts: combo.contracts,
      matureContracts: combo.matureContracts,
      avgContribution12mCents: Math.round(
        combo.totalContribution / Math.max(1, combo.contracts),
      ),
      totalContribution12mCents: Math.round(combo.totalContribution),
    }))
    .sort((a, b) => b.avgContribution12mCents - a.avgContribution12mCents)
    .slice(0, limit);
}
