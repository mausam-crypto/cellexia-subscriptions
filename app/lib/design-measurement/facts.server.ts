import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import {
  OWNERSHIP_OURS,
  getOwnPlanIdEvidence,
  planIdMatches,
} from "~/lib/ownership/ownership.server";
import { getSetting } from "~/lib/settings/settings.server";
import { getLaunchState } from "~/lib/launch/launch.server";
import {
  OPEN_EXPOSURE_GATE,
  calendarRungAllowed,
  isTransition,
  loadLedgerRevisions,
  resolveDesignFromRevisions,
  type ExposureGate,
  type LedgerRevision,
  type ResolvedDesign,
} from "./ledger.server";
import { marketHandleForCountry } from "./markets.server";
import {
  parseSeenValue,
  sanitizeDesignKey,
  normalizeDesignPreselect,
  type DesignPreselect,
  type DesignSource,
} from "./shared";

/**
 * SubscribableOrder writer (v1.26.0) — one PII-free fact row per subscribable
 * storefront order, carrying the design the shopper saw, whether the order
 * started one of OUR subscriptions, and the hygiene flags every per-design
 * readout must disclose. ORDERS_CREATE calls recordSubscribableOrder for
 * every containsSubscribable order (idempotent upsert on shopId+orderId);
 * the contract-create tail, the ORDERS_CREATE race path and the nightly
 * design_facts_backfill call linkContractDesign to join fact ↔ contract and
 * stamp the contract's originDesign* WRITE-ONCE.
 *
 * Both entry points MAY throw (a DB outage is not something to hide inside a
 * fact row); every caller wraps them in try/catch — the webhook containment
 * rule (ARCHITECTURE golden rule 9). Nothing here ever touches billing state.
 *
 * Design ladder, best evidence first (SubscribableOrder.designSource):
 *   seen        `_cellexia_seen` on any of our lines — the widget rendered
 *               this design AND we know the preselect (stamped on one-time
 *               and subscription adds alike);
 *   design_prop `_cellexia_design` only (pre-v1.26.0 extension, or a
 *               subscription add whose seen value was lost) — design known,
 *               preselect unknown unless the calendar names the same design;
 *   calendar    no widget property at all — the design the ledger says was
 *               live for the order's market at processedAt (theme-form
 *               installs without the seen input, orders before v1.26.0),
 *               but ONLY where the widget could render: a market hidden by
 *               widgetMarkets, or a store still in SETUP, cannot expose any
 *               design (calendarRungAllowed in ledger.server);
 *   none        nothing: no property and no revision was published yet, or
 *               the calendar answer is withheld because exposure was
 *               structurally impossible.
 * calendarDesignKey is ALWAYS recorded when the ledger has an answer, so the
 * scoreboard can report how often the stamped design and the calendar agree.
 */

export interface RecordSubscribableOrderLine {
  variantId: string | null;
  productId: string | null;
  /** Any id form (GID or numeric string); null = no selling plan on the line. */
  sellingPlanId: string | null;
  /** `_cellexia_design` (or its legacy name) as read off the line, raw. */
  designProp: string | null;
  /** `_cellexia_seen` as read off the line, raw. */
  seenProp: string | null;
  /** The line's product is in a subscribable SellingPlanConfig.productIds. */
  isOurProduct: boolean;
}

export interface RecordSubscribableOrderInput {
  shopId: string;
  orderId: string;
  orderName: string | null;
  processedAt: Date;
  countryCode: string | null;
  currencyCode: string | null;
  deviceType: string | null;
  sourceName: string | null;
  orderTotalCents: number | null;
  units: number | null;
  /** Used ONLY to compute `staff` against designMeasurement.excludeEmails; never stored. */
  orderEmail: string | null;
  hasSellingPlanLine: boolean;
  lines: RecordSubscribableOrderLine[];
  promo: boolean;
  /**
   * OPTIONAL, backfill only: when a row is rebuilt from event payloads that
   * carry no line detail, the caller may state the ownership it derived from
   * the contract mirror ("ours" when a countable contract has this order as
   * its origin). Ignored when the lines carry selling-plan ids of their own.
   */
  knownOwnership?: SubscribableOwnership | null;
}

export type SubscribableOwnership = "ours" | "foreign" | "mixed" | "none";

export interface RecordSubscribableOrderResult {
  designKey: string | null;
  designPreselect: DesignPreselect | null;
  designSource: string;
  created: boolean;
}

/** Column caps: the row is PII-free and every free-text field is short. */
const ORDER_NAME_MAX = 40;
const SOURCE_NAME_MAX = 40;
const DEVICE_TYPE_MAX = 16;
const CURRENCY_MAX = 8;
const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * Race window for linkContractDesign's no-fact path: the contract-create
 * webhook can land seconds BEFORE the origin ORDERS_CREATE. Stamping the
 * contract from the calendar (or as "none") in that window would burn the
 * write-once slot right before the order arrives with the real seen value,
 * so a young contract without a fact row is left for the order webhook's
 * tail (which calls linkContractDesign after recordSubscribableOrder) or the
 * nightly backfill. Past the window the order is not coming through the
 * webhook path any more, and the events/calendar answer is stamped.
 */
export const LINK_NO_FACT_GRACE_MS = 48 * 60 * 60 * 1000;

function capString(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeCountry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return COUNTRY_RE.test(code) ? code : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email === "" ? null : email;
}

function hasPlan(line: RecordSubscribableOrderLine): boolean {
  return typeof line.sellingPlanId === "string" && line.sellingPlanId.trim() !== "";
}

/**
 * Ownership of the order's selling-plan lines: any of ours + any foreign =
 * mixed; ours only; foreign only; no plan line at all = none. Exported for
 * tests. `knownOwnership` (backfill) is honoured only when the lines carry
 * no plan id evidence of their own.
 *
 * `ownPlanIdsKnown` mirrors classifyContractOwnership: when our own plan-id
 * set is INCOMPLETE (a synced group whose plan ids were never persisted,
 * see getOwnPlanIdEvidence) "not in the set" proves nothing, so a plan line
 * we cannot match is never declared foreign or mixed on that strength; the
 * row falls back to knownOwnership ?? "none" (or "ours" when another line
 * did match). Otherwise our own subscription orders would be dropped from
 * the take rate as another app's.
 */
export function classifyOrderOwnership(
  lines: RecordSubscribableOrderLine[],
  ownPlanIds: ReadonlySet<string>,
  knownOwnership?: SubscribableOwnership | null,
  ownPlanIdsKnown: boolean = true,
): SubscribableOwnership {
  let ours = false;
  let foreign = false;
  for (const line of lines) {
    if (!hasPlan(line)) continue;
    if (planIdMatches(ownPlanIds, line.sellingPlanId)) ours = true;
    else if (ownPlanIdsKnown) foreign = true;
  }
  if (ours && foreign) return "mixed";
  if (ours) return "ours";
  if (foreign) return "foreign";
  return knownOwnership ?? "none";
}

interface DesignChoice {
  designKey: string | null;
  preselect: DesignPreselect | null;
  source: DesignSource;
  /** Distinct design keys stamped on the order (seen + design props). */
  distinctKeys: string[];
  exposure: boolean;
}

/**
 * The seen → design_prop → calendar → none ladder over the order's lines.
 * When several lines carry (different) seen values the subscription line of
 * OUR plan wins (that is the line that sold), else the first stamped line;
 * the disagreement is disclosed through the `mixed` flag, never hidden.
 * `calendarRung` false (exposure structurally impossible: hidden market or
 * SETUP store, see calendarRungAllowed) turns the calendar step into "none"
 * while the calendar may still lend its preselect to a matching stamped
 * design (a stamp IS proof the widget rendered). Exported for tests.
 */
export function chooseDesign(
  lines: RecordSubscribableOrderLine[],
  ownPlanIds: ReadonlySet<string>,
  calendar: ResolvedDesign | null,
  calendarRung: boolean = true,
): DesignChoice {
  const distinct = new Set<string>();
  let seenPick: { designKey: string; preselect: DesignPreselect | null } | null =
    null;
  let seenPickIsOurPlan = false;
  let propPick: string | null = null;
  let propPickIsOurPlan = false;
  let exposure = false;

  for (const line of lines) {
    const seen = parseSeenValue(line.seenProp);
    const prop = sanitizeDesignKey(line.designProp);
    if (line.seenProp != null && line.seenProp !== "") exposure = true;
    if (line.designProp != null && line.designProp !== "") exposure = true;
    const ourPlan = hasPlan(line) && planIdMatches(ownPlanIds, line.sellingPlanId);
    if (seen) {
      distinct.add(seen.designKey);
      if (!seenPick || (ourPlan && !seenPickIsOurPlan)) {
        seenPick = seen;
        seenPickIsOurPlan = ourPlan;
      }
    }
    if (prop) {
      distinct.add(prop);
      if (!propPick || (ourPlan && !propPickIsOurPlan)) {
        propPick = prop;
        propPickIsOurPlan = ourPlan;
      }
    }
  }

  const distinctKeys = [...distinct].sort();
  if (seenPick) {
    // A seen value with an unknown preselect ("u", older buy-box.js) may
    // borrow the calendar's preselect when the calendar names the SAME
    // design — the calendar's preselect is exact whenever the merchant set
    // behavior.preselect explicitly.
    const preselect =
      seenPick.preselect ??
      (calendar && calendar.designKey === seenPick.designKey
        ? calendar.preselect
        : null);
    return {
      designKey: seenPick.designKey,
      preselect,
      source: "seen",
      distinctKeys,
      exposure,
    };
  }
  if (propPick) {
    const preselect =
      calendar && calendar.designKey === propPick ? calendar.preselect : null;
    return {
      designKey: propPick,
      preselect,
      source: "design_prop",
      distinctKeys,
      exposure,
    };
  }
  if (calendar && calendarRung) {
    return {
      designKey: calendar.designKey,
      preselect: calendar.preselect,
      source: "calendar",
      distinctKeys,
      exposure,
    };
  }
  return { designKey: null, preselect: null, source: "none", distinctKeys, exposure };
}

/**
 * `mixed`: several designs stamped on one order, or our product bought BOTH
 * as a subscription and one-time in the same order (the take-rate signal of
 * that order is ambiguous). Exported for tests.
 */
export function isMixedOrder(
  lines: RecordSubscribableOrderLine[],
  distinctKeys: string[],
): boolean {
  if (distinctKeys.length > 1) return true;
  let ourSub = false;
  let ourOneTime = false;
  for (const line of lines) {
    if (!line.isOurProduct) continue;
    if (hasPlan(line)) ourSub = true;
    else ourOneTime = true;
  }
  return ourSub && ourOneTime;
}

async function isStaffEmail(shopId: string, email: string | null): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const setting = await getSetting(shopId, "designMeasurement");
  return setting.excludeEmails.some((e) => e === normalized);
}

/**
 * The exposure gate (widgetMarkets + launch mode) the calendar rung is
 * judged against. CONTAINED: a failed settings read must never fail a fact
 * write and must never hide a design, so it degrades to the fully open gate
 * (every market allowed, store live), i.e. to the pre-fix behaviour. Also
 * used by the backfill's market recompute; exported for that and for tests.
 */
export async function loadExposureGate(shopId: string): Promise<ExposureGate> {
  try {
    const [widgetMarkets, launch] = await Promise.all([
      getSetting(shopId, "widgetMarkets"),
      getLaunchState(shopId),
    ]);
    return {
      widgetMarkets: {
        mode: widgetMarkets.mode === "selected" ? "selected" : "all",
        handles: Array.isArray(widgetMarkets.handles) ? [...widgetMarkets.handles] : [],
      },
      launchMode: launch.mode === "SETUP" ? "SETUP" : "LIVE",
    };
  } catch (err) {
    console.error("[design-measurement] exposure gate read failed", shopId, err);
    return OPEN_EXPOSURE_GATE;
  }
}

/** Cheap, contained: the scoreboard cache lives in the SCOREBOARD module. */
async function invalidateScoreboard(shopId: string): Promise<void> {
  try {
    const m = await import("~/lib/design-measurement/scoreboard.server");
    const fn = (m as { invalidateScoreboardCache?: (id: string) => unknown })
      .invalidateScoreboardCache;
    if (typeof fn === "function") await fn(shopId);
  } catch {
    // The scoreboard module is optional plumbing here; a missing or throwing
    // invalidation only means a readout stays cached for up to its TTL.
  }
}

/**
 * Resolve ownership, market, calendar and the design ladder for one order,
 * then upsert its fact row by (shopId, orderId). On UPDATE the join fields
 * (subscribed / contractId / subscribedAt) are never touched: they belong to
 * linkContractDesign and a redelivered order webhook must not undo a link.
 * Idempotent; may throw (callers contain).
 */
export async function recordSubscribableOrder(
  input: RecordSubscribableOrderInput,
): Promise<RecordSubscribableOrderResult> {
  const { shopId, orderId } = input;
  const processedAt =
    input.processedAt instanceof Date && !Number.isNaN(input.processedAt.getTime())
      ? input.processedAt
      : new Date();
  const countryCode = normalizeCountry(input.countryCode);

  const [evidence, marketHandle, revisions, staff, gate] = await Promise.all([
    getOwnPlanIdEvidence(shopId),
    marketHandleForCountry(shopId, countryCode),
    loadLedgerRevisions(shopId),
    isStaffEmail(shopId, input.orderEmail),
    loadExposureGate(shopId),
  ]);
  const ownPlanIds = evidence.planIds;

  const calendar = resolveDesignFromRevisions(revisions, processedAt, marketHandle);
  const ownership = classifyOrderOwnership(
    input.lines,
    ownPlanIds,
    input.knownOwnership ?? null,
    evidence.known,
  );
  const choice = chooseDesign(
    input.lines,
    ownPlanIds,
    calendar,
    calendarRungAllowed(gate, marketHandle),
  );
  const mixed = isMixedOrder(input.lines, choice.distinctKeys);
  const transition = isTransition(revisions, processedAt);

  const facts = {
    orderName: capString(input.orderName, ORDER_NAME_MAX),
    processedAt,
    countryCode,
    currencyCode: capString(input.currencyCode, CURRENCY_MAX)?.toUpperCase() ?? null,
    marketHandle,
    deviceType: capString(input.deviceType, DEVICE_TYPE_MAX),
    sourceName: capString(input.sourceName, SOURCE_NAME_MAX),
    orderTotalCents:
      typeof input.orderTotalCents === "number" && Number.isFinite(input.orderTotalCents)
        ? Math.round(input.orderTotalCents)
        : null,
    units:
      typeof input.units === "number" && Number.isFinite(input.units)
        ? Math.max(0, Math.round(input.units))
        : null,
    designKey: choice.designKey,
    designPreselect: choice.preselect,
    designRevisionId: calendar?.revisionId ?? null,
    designSource: choice.source,
    calendarDesignKey: calendar?.designKey ?? null,
    hasSellingPlanLine: input.hasSellingPlanLine === true,
    ownership,
    exposure: choice.exposure,
    promo: input.promo === true,
    mixed,
    transition,
    staff,
  };

  const existing = await prisma.subscribableOrder.findUnique({
    where: { shopId_orderId: { shopId, orderId } },
    select: { id: true },
  });

  let created = false;
  if (existing) {
    await prisma.subscribableOrder.update({
      where: { id: existing.id },
      data: facts,
    });
  } else {
    try {
      await prisma.subscribableOrder.create({
        data: { shopId, orderId, ...facts },
      });
      created = true;
    } catch (err) {
      // Two deliveries of the same order racing past the findUnique: the
      // loser lands here on the unique (shopId, orderId) key and simply
      // applies its (identical) facts as an update.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        await prisma.subscribableOrder.update({
          where: { shopId_orderId: { shopId, orderId } },
          data: facts,
        });
      } else {
        throw err;
      }
    }
  }

  await invalidateScoreboard(shopId);
  return {
    designKey: choice.designKey,
    designPreselect: choice.preselect,
    designSource: choice.source,
    created,
  };
}

// ── Contract join + write-once stamp ─────────────────────────────────────────

export interface LinkContractDesignResult {
  stamped: boolean;
  designKey: string | null;
  designSource: string | null;
}

const NOT_STAMPED: LinkContractDesignResult = {
  stamped: false,
  designKey: null,
  designSource: null,
};

/** The design attributed to `orderId` by the pre-1.26.0 event feed, if any. */
async function designFromAttributedEvents(
  shopId: string,
  orderId: string,
): Promise<string | null> {
  const events = await prisma.subscriberEvent.findMany({
    where: {
      shopId,
      type: "widget.design_attributed",
      payload: { path: ["orderId"], equals: orderId },
    },
    orderBy: { createdAt: "asc" },
    select: { payload: true },
    take: 10,
  });
  const keys: string[] = [];
  for (const event of events) {
    const payload = event.payload as { designKey?: unknown } | null;
    const key = sanitizeDesignKey(
      typeof payload?.designKey === "string" ? payload.designKey : null,
    );
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys.sort()[0] : null;
}

/**
 * Join order fact ↔ contract for a COUNTABLE contract (isDemo false,
 * ownership OURS) that has an originOrderId: marks the fact row
 * subscribed=true / contractId / subscribedAt (firstChargeAt ?? createdAt)
 * and stamps the contract's originDesign* WRITE-ONCE from the fact row. When
 * no fact row exists (order predates the feature, or the origin webhook was
 * lost) the stamp comes from widget.design_attributed events, else the
 * calendar, else "none" — but only once the contract is older than
 * LINK_NO_FACT_GRACE_MS (see that constant). Idempotent, safe to call
 * repeatedly; returns what was stamped BY THIS CALL (stamped:false when the
 * contract already carried a stamp).
 */
export async function linkContractDesign(
  shopId: string,
  contractId: string,
  now: Date = new Date(),
): Promise<LinkContractDesignResult> {
  const contract = await prisma.subscriptionContract.findFirst({
    where: { id: contractId, shopId },
    select: {
      id: true,
      originOrderId: true,
      isDemo: true,
      ownership: true,
      originDesignStampedAt: true,
      firstChargeAt: true,
      createdAt: true,
      originOrderProcessedAt: true,
      acqCountryCode: true,
    },
  });
  if (!contract || !contract.originOrderId) return NOT_STAMPED;
  // COUNTABLE gate: demo fixtures and another app's subscribers never enter
  // the population — a foreign contract's origin order is one-time FOR US.
  if (contract.isDemo || contract.ownership !== OWNERSHIP_OURS) return NOT_STAMPED;

  const orderId = contract.originOrderId;
  const fact = await prisma.subscribableOrder.findUnique({
    where: { shopId_orderId: { shopId, orderId } },
  });

  let touched = false;
  let stamp: {
    designKey: string | null;
    designPreselect: DesignPreselect | null;
    designRevisionId: string | null;
    designSource: DesignSource;
  };

  if (fact) {
    if (!fact.subscribed || fact.contractId !== contract.id) {
      await prisma.subscribableOrder.update({
        where: { id: fact.id },
        data: {
          subscribed: true,
          contractId: contract.id,
          subscribedAt: contract.firstChargeAt ?? contract.createdAt,
        },
      });
      touched = true;
    }
    stamp = {
      designKey: fact.designKey,
      designPreselect: normalizeDesignPreselect(fact.designPreselect),
      designRevisionId: fact.designRevisionId,
      designSource: (fact.designSource as DesignSource) ?? "none",
    };
  } else {
    if (contract.originDesignStampedAt != null) return NOT_STAMPED;
    if (now.getTime() - contract.createdAt.getTime() < LINK_NO_FACT_GRACE_MS) {
      // Race window: the origin ORDERS_CREATE may still be on its way and
      // will stamp with real evidence; do not consume the write-once slot.
      return NOT_STAMPED;
    }
    const attributed = await designFromAttributedEvents(shopId, orderId);
    const at = contract.originOrderProcessedAt ?? contract.createdAt;
    const [marketHandle, gate] = await Promise.all([
      marketHandleForCountry(shopId, contract.acqCountryCode),
      loadExposureGate(shopId),
    ]);
    let revisions: LedgerRevision[] = [];
    try {
      revisions = await loadLedgerRevisions(shopId);
    } catch (err) {
      console.error("[design-measurement] ledger read failed", shopId, err);
    }
    const calendar = resolveDesignFromRevisions(revisions, at, marketHandle);
    if (attributed) {
      stamp = {
        designKey: attributed,
        designPreselect:
          calendar && calendar.designKey === attributed ? calendar.preselect : null,
        designRevisionId: calendar?.revisionId ?? null,
        designSource: "design_prop",
      };
    } else if (calendar && calendarRungAllowed(gate, marketHandle)) {
      // Same rule as the fact writer: the calendar only speaks for orders
      // whose market could show the widget on a live store.
      stamp = {
        designKey: calendar.designKey,
        designPreselect: calendar.preselect,
        designRevisionId: calendar.revisionId,
        designSource: "calendar",
      };
    } else {
      stamp = {
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        designSource: "none",
      };
    }
  }

  let stamped = false;
  if (contract.originDesignStampedAt == null) {
    // WRITE-ONCE, enforced at the write (not just the read above): two
    // callers racing (create tail + order webhook tail) must not both win.
    const result = await prisma.subscriptionContract.updateMany({
      where: { id: contract.id, shopId, originDesignStampedAt: null },
      data: {
        originDesignKey: stamp.designKey,
        originDesignPreselect: stamp.designPreselect,
        originDesignRevisionId: stamp.designRevisionId,
        originDesignSource: stamp.designSource,
        originDesignStampedAt: now,
      },
    });
    stamped = result.count > 0;
    touched = touched || stamped;
  }

  if (touched) await invalidateScoreboard(shopId);
  return stamped
    ? { stamped: true, designKey: stamp.designKey, designSource: stamp.designSource }
    : NOT_STAMPED;
}
