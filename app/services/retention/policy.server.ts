/**
 * [retention] Customer-facing pause/cancel policy gates.
 *
 * Two policies can restrict what a CUSTOMER may do from the portal:
 *
 *  - Minimum pause/cancel WINDOW — `ShopSettings.settingsJson.minPauseCancelWindow`
 *    ({enabled: false, days: 10} by default, days clamped to [1, 90]). Applies
 *    only to a customer's FIRST-ever contract; a returning subscriber (any
 *    prior contract, active or cancelled) is never window-locked. The window
 *    runs from `treatmentStartedAt ?? createdAt` and gates both pausing and
 *    cancelling.
 *
 *  - COMMITMENT — a Committed Treatment Plan (`SellingPlanConfig.plansJson`
 *    entries carrying {committed: true, minDeliveries: n}) blocks cancelling
 *    until `successfulOrders >= minDeliveries`. It never blocks pausing:
 *    skipping / delaying / pausing shift dates, they don't break the
 *    commitment.
 *
 * These gates apply ONLY to customer-facing surfaces (the portal). The CS
 * console and system flows (dunning pause/cancel, reconciliation) are never
 * gated — they simply do not call these functions.
 *
 * FAIL-OPEN RULE: the gate functions never throw. Missing data, malformed
 * JSON or a query failure logs a warning and returns "allowed" — a broken
 * policy must never trap a customer inside a plan.
 *
 * Decision logic is pure (`pauseCancelLockState`, `commitmentFromPlanEntries`,
 * `normalizePauseCancelWindowSettings`) per ARCHITECTURE convention 10; the
 * exported gates are thin I/O wrappers (2–3 cheap queries each).
 */
import prisma from "~/db.server";
import { addDays } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { parseJson } from "~/types/domain";

// ─────────────────────────── Window settings ──────────────────────────────

export interface PauseCancelWindowSettings {
  enabled: boolean;
  days: number;
}

const DEFAULT_WINDOW_SETTINGS: PauseCancelWindowSettings = {
  enabled: false,
  days: 10,
};

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PURE — normalise the raw `minPauseCancelWindow` settings value: OFF by
 * default, `days` clamped to [1, 90] with a 10-day fallback for junk input.
 */
export function normalizePauseCancelWindowSettings(
  raw: unknown,
): PauseCancelWindowSettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_WINDOW_SETTINGS };
  const enabled = raw.enabled === true;
  const daysRaw = Number(raw.days);
  const days = Number.isFinite(daysRaw)
    ? Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(daysRaw)))
    : DEFAULT_WINDOW_SETTINGS.days;
  return { enabled, days };
}

/** Merchant-configured minimum pause/cancel window for a shop. */
export async function getPauseCancelWindowSettings(
  shop: string,
): Promise<PauseCancelWindowSettings> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  return normalizePauseCancelWindowSettings(settingsObj.minPauseCancelWindow);
}

// ─────────────────────────── First-subscription check ─────────────────────

/**
 * True when no OTHER contract exists for (shop, customer) created earlier
 * than this one — a returning subscriber (any prior contract, active or
 * cancelled) is never window-locked.
 */
export async function isFirstSubscriptionForCustomer(
  shop: string,
  contract: { id: string; shopifyCustomerId: string; createdAt: Date },
): Promise<boolean> {
  const prior = await prisma.subscriptionContract.findFirst({
    where: {
      shop,
      shopifyCustomerId: contract.shopifyCustomerId,
      id: { not: contract.id },
      createdAt: { lt: contract.createdAt },
    },
    select: { id: true },
  });
  return prior == null;
}

// ─────────────────────────── Window lock math (PURE) ──────────────────────

/**
 * PURE — window lock state for one contract. Locked only when the policy is
 * enabled, this is the customer's first subscription AND the unlock instant
 * (`anchor + days`) is still strictly in the future. Callers resolve the
 * anchor as `treatmentStartedAt ?? createdAt`. `now` is injectable for tests.
 */
export function pauseCancelLockState(input: {
  anchor: Date;
  isFirst: boolean;
  settings: PauseCancelWindowSettings;
  now?: Date;
}): { locked: boolean; unlocksAt: Date | null } {
  const now = input.now ?? new Date();
  if (!input.settings.enabled || !input.isFirst) {
    return { locked: false, unlocksAt: null };
  }
  const unlocksAt = addDays(input.anchor, input.settings.days);
  if (unlocksAt.getTime() <= now.getTime()) {
    return { locked: false, unlocksAt: null };
  }
  return { locked: true, unlocksAt };
}

// ─────────────────────────── Commitment status ────────────────────────────

export interface CommitmentStatus {
  committed: boolean;
  minDeliveries: number;
  completedDeliveries: number;
  remainingDeliveries: number;
  met: boolean;
}

/** Structural subset of a `SellingPlanConfig.plansJson` plan entry. */
export interface SellingPlanEntryLike {
  name?: string;
  intervalWeeks?: number;
  percentOff?: number;
  shopifyPlanId?: string;
  /** Committed Treatment Plan marker (shared contract, agent policy-core). */
  committed?: boolean;
  minDeliveries?: number;
}

/** A committed plan entry without an explicit minimum commits to 3 deliveries. */
const DEFAULT_COMMITTED_MIN_DELIVERIES = 3;

/** Strip a GID down to its tail so gid and bare selling-plan ids compare equal. */
function normalizePlanId(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

function declaredMinDeliveries(entry: SellingPlanEntryLike): number | null {
  const raw = entry.minDeliveries;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : null;
}

function openCommitment(successfulOrders: number): CommitmentStatus {
  const completed =
    Number.isFinite(successfulOrders) && successfulOrders > 0
      ? Math.floor(successfulOrders)
      : 0;
  return {
    committed: false,
    minDeliveries: 0,
    completedDeliveries: completed,
    remainingDeliveries: 0,
    met: true,
  };
}

/**
 * PURE — commitment status from a contract's line selling-plan ids matched
 * against the plan entries of every active SellingPlanConfig.
 *
 * A contract is committed when any line's entry has `committed === true` (or
 * `minDeliveries >= 2`); `minDeliveries` is the max across matched committed
 * entries (default 3 when committed but unspecified). Unmatched plan ids
 * contribute nothing — a line we cannot attribute must never lock (defensive).
 */
export function commitmentFromPlanEntries(
  linePlanIds: ReadonlyArray<string>,
  planEntries: ReadonlyArray<SellingPlanEntryLike>,
  successfulOrders: number,
): CommitmentStatus {
  const byPlanId = new Map<string, SellingPlanEntryLike>();
  for (const entry of planEntries) {
    if (
      isPlainObject(entry) &&
      typeof entry.shopifyPlanId === "string" &&
      entry.shopifyPlanId.length > 0
    ) {
      byPlanId.set(normalizePlanId(entry.shopifyPlanId), entry);
    }
  }

  let committed = false;
  let minDeliveries = 0;
  for (const planId of linePlanIds) {
    const entry = byPlanId.get(normalizePlanId(planId));
    if (!entry) continue; // unmatched → not committed
    const declaredMin = declaredMinDeliveries(entry);
    const entryCommitted =
      entry.committed === true || (declaredMin !== null && declaredMin >= 2);
    if (!entryCommitted) continue;
    committed = true;
    minDeliveries = Math.max(
      minDeliveries,
      declaredMin ?? DEFAULT_COMMITTED_MIN_DELIVERIES,
    );
  }

  if (!committed) return openCommitment(successfulOrders);

  const completed = openCommitment(successfulOrders).completedDeliveries;
  return {
    committed: true,
    minDeliveries,
    completedDeliveries: completed,
    remainingDeliveries: Math.max(0, minDeliveries - completed),
    met: completed >= minDeliveries,
  };
}

/** Extract sellingPlanId values from caller-provided (already loaded) lines. */
function sellingPlanIdsFromLines(lines: unknown): string[] | null {
  if (!Array.isArray(lines)) return null;
  const ids: string[] = [];
  for (const line of lines) {
    if (isPlainObject(line) && typeof line.sellingPlanId === "string") {
      if (line.sellingPlanId.length > 0) ids.push(line.sellingPlanId);
    }
  }
  return ids;
}

/**
 * Commitment status for a contract. Pass already-loaded `lines` (any shape
 * carrying `sellingPlanId`) to skip the line query. Fails OPEN (not
 * committed) — see module docblock.
 */
export async function commitmentStatusFor(
  shop: string,
  contract: { id: string; successfulOrders: number; lines?: unknown },
): Promise<CommitmentStatus> {
  try {
    let planIds = sellingPlanIdsFromLines(contract.lines);
    if (planIds === null) {
      const lines = await prisma.contractLine.findMany({
        where: { contractId: contract.id },
        select: { sellingPlanId: true },
      });
      planIds = lines
        .map((l) => l.sellingPlanId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    }
    if (planIds.length === 0) return openCommitment(contract.successfulOrders);

    const configs = await prisma.sellingPlanConfig.findMany({
      where: { shop, active: true },
      select: { plansJson: true },
    });
    const entries: SellingPlanEntryLike[] = [];
    for (const config of configs) {
      const parsed = parseJson<unknown>(config.plansJson, []);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (isPlainObject(entry)) entries.push(entry as SellingPlanEntryLike);
      }
    }
    return commitmentFromPlanEntries(planIds, entries, contract.successfulOrders);
  } catch (error) {
    logger.warn("commitmentStatusFor failed open", {
      shop,
      contractId: contract.id,
      error: String(error),
    });
    return openCommitment(contract.successfulOrders);
  }
}

// ─────────────────────────── Gates ────────────────────────────────────────

export interface CancelGate {
  allowed: boolean;
  reason: "WINDOW" | "COMMITMENT" | null;
  unlocksAt: Date | null;
  commitment: CommitmentStatus | null;
}

const OPEN_CANCEL_GATE: CancelGate = {
  allowed: true,
  reason: null,
  unlocksAt: null,
  commitment: null,
};

/**
 * May the CUSTOMER cancel this contract right now? COMMITMENT is checked
 * first (the stronger, longer constraint), then the WINDOW. Portal-only —
 * CS console and dunning/system cancels never consult this gate.
 */
export async function getCancelGate(
  shop: string,
  contractId: string,
): Promise<CancelGate> {
  try {
    const contract = await prisma.subscriptionContract.findFirst({
      where: { id: contractId, shop },
      include: { lines: true },
    });
    if (!contract) {
      logger.warn("getCancelGate: contract not found — failing open", {
        shop,
        contractId,
      });
      return { ...OPEN_CANCEL_GATE };
    }

    const commitment = await commitmentStatusFor(shop, {
      id: contract.id,
      successfulOrders: contract.successfulOrders,
      lines: contract.lines,
    });
    if (commitment.committed && !commitment.met) {
      return { allowed: false, reason: "COMMITMENT", unlocksAt: null, commitment };
    }

    const settings = await getPauseCancelWindowSettings(shop);
    if (settings.enabled) {
      const isFirst = await isFirstSubscriptionForCustomer(shop, contract);
      const lock = pauseCancelLockState({
        anchor: contract.treatmentStartedAt ?? contract.createdAt,
        isFirst,
        settings,
      });
      if (lock.locked) {
        return {
          allowed: false,
          reason: "WINDOW",
          unlocksAt: lock.unlocksAt,
          commitment,
        };
      }
    }

    return { allowed: true, reason: null, unlocksAt: null, commitment };
  } catch (error) {
    logger.warn("getCancelGate failed open", {
      shop,
      contractId,
      error: String(error),
    });
    return { ...OPEN_CANCEL_GATE };
  }
}

/**
 * May the CUSTOMER pause this contract right now? Only the WINDOW policy
 * gates pausing — a commitment never blocks pausing (skipping / delaying /
 * pausing shift dates, they don't break the commitment). Portal-only.
 */
export interface PauseGate {
  allowed: boolean;
  reason: "WINDOW" | "COMMITMENT" | null;
  unlocksAt: Date | null;
  commitment: CommitmentStatus | null;
}

/**
 * Pausing is blocked by an unmet commitment (the schedule is fixed for the
 * first N deliveries of a Committed Treatment Plan) and by the first-plan
 * pause/cancel window.
 */
export async function getPauseGate(
  shop: string,
  contractId: string,
): Promise<PauseGate> {
  try {
    const contract = await prisma.subscriptionContract.findFirst({
      where: { id: contractId, shop },
      select: {
        id: true,
        shopifyCustomerId: true,
        createdAt: true,
        treatmentStartedAt: true,
        successfulOrders: true,
      },
    });
    if (!contract) {
      logger.warn("getPauseGate: contract not found — failing open", {
        shop,
        contractId,
      });
      return { allowed: true, reason: null, unlocksAt: null, commitment: null };
    }

    const commitment = await commitmentStatusFor(shop, {
      id: contract.id,
      successfulOrders: contract.successfulOrders,
    });
    if (commitment.committed && !commitment.met) {
      return { allowed: false, reason: "COMMITMENT", unlocksAt: null, commitment };
    }

    const settings = await getPauseCancelWindowSettings(shop);
    if (!settings.enabled) {
      return { allowed: true, reason: null, unlocksAt: null, commitment };
    }
    const isFirst = await isFirstSubscriptionForCustomer(shop, contract);
    const lock = pauseCancelLockState({
      anchor: contract.treatmentStartedAt ?? contract.createdAt,
      isFirst,
      settings,
    });
    return {
      allowed: !lock.locked,
      reason: lock.locked ? "WINDOW" : null,
      unlocksAt: lock.unlocksAt,
      commitment,
    };
  } catch (error) {
    logger.warn("getPauseGate failed open", {
      shop,
      contractId,
      error: String(error),
    });
    return { allowed: true, reason: null, unlocksAt: null, commitment: null };
  }
}

export interface ScheduleGate {
  allowed: boolean;
  reason: "COMMITMENT" | null;
  commitment: CommitmentStatus | null;
}

/**
 * Schedule adjustments (delay, skip, date changes, cadence switches) are
 * fixed for the first N deliveries of a Committed Treatment Plan. The
 * first-plan window policy does NOT gate the schedule — only pause/cancel.
 * Customer-facing surfaces only; CS console and system jobs are never gated.
 */
export async function getScheduleGate(
  shop: string,
  contractId: string,
): Promise<ScheduleGate> {
  try {
    const contract = await prisma.subscriptionContract.findFirst({
      where: { id: contractId, shop },
      select: { id: true, successfulOrders: true },
    });
    if (!contract) {
      logger.warn("getScheduleGate: contract not found — failing open", {
        shop,
        contractId,
      });
      return { allowed: true, reason: null, commitment: null };
    }
    const commitment = await commitmentStatusFor(shop, {
      id: contract.id,
      successfulOrders: contract.successfulOrders,
    });
    if (commitment.committed && !commitment.met) {
      return { allowed: false, reason: "COMMITMENT", commitment };
    }
    return { allowed: true, reason: null, commitment };
  } catch (error) {
    logger.warn("getScheduleGate failed open", {
      shop,
      contractId,
      error: String(error),
    });
    return { allowed: true, reason: null, commitment: null };
  }
}
