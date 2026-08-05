/**
 * Add-on fulfillment engine [fulfillment] — turns AddOnItem promises into
 * charged, shipped reality.
 *
 * Historically an AddOnItem was decorative: the portal/storefront created the
 * row, the customer was told "it arrives with your next delivery", and
 * nothing ever injected it into a Shopify billing cycle — no charge, no
 * shipment. This module closes that loop with two seams:
 *
 *  - `runApplyAddOnsJob(shop?)` (jobs registry key "apply-add-ons", daily):
 *    for contracts billing within the apply window
 *    (`ShopSettings.settingsJson.addOnApplyDays`, default 3 days), every
 *    unapplied AddOnItem is applied through the core contract-editing recipe
 *    (`addLineToContract`) so the next charge includes it.
 *      RECURRING      → line priced with the plan discount via
 *                       `planAdjustedPriceCents`; the AddOnItem row is then
 *                       DELETED — it became a permanent ContractLine (the
 *                       audit trail keeps the attribution).
 *      NEXT_ONLY /
 *      N_DELIVERIES   → line priced at the stored one-time `priceCents`;
 *                       the row is stamped `appliedAt` + `appliedLineId` so
 *                       consumption can later remove the line.
 *      RETENTION_GIFT → (source convention) applied at 0 cents — a promised
 *                       complimentary product must never be charged.
 *
 *  - `consumeAddOnsAfterCharge(shop, contractId, attemptId, chargeAt?)`:
 *    called after a successful charge; decrements `remainingDeliveries` on
 *    applied NEXT_ONLY / N_DELIVERIES add-ons and, when exhausted, removes
 *    the contract line via core `removeLineFromContract` (SYSTEM actor) and
 *    finalizes the AddOnItem. Idempotent per charge (keyed on the local
 *    BillingAttempt id, so redelivered webhooks replay while distinct
 *    charges can never collide) and never throws — billing-success
 *    processing must not break on add-on housekeeping. `chargeAt` (the
 *    charged order's createdAt) guards the apply/charge race: an add-on
 *    applied AFTER the order was built did not ship with it and is left
 *    applied for the charge that actually ships it.
 *
 * Conventions honored: money is integer cents; every state change is
 * audited; contract mutations run inside withIdempotency; lifecycle events
 * go through emitLifecycleEvent (PRODUCT_ADDED carries `payload.addOn: true`
 * so analytics can tell applied add-ons from customer-initiated adds).
 * Fail-soft: one bad contract never blocks the job for the rest.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import { getOfflineAdmin } from "~/services/core/shopifyClient.server";
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import {
  addLineToContract,
  removeLineFromContract,
  syncContractFromShopify,
} from "~/services/core/contracts.server";
import { planAdjustedPriceCents } from "~/services/core/pure";
import { addDays, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { parseJson } from "~/types/domain";
import type { AddOnMode, ContractStatus } from "~/types/domain";

// Enum-string convention: DB strings come from ~/types/domain unions.
const ACTIVE: ContractStatus = "ACTIVE";

// ─────────────────────────── Pure decision helpers ─────────────────────────
// No I/O below this banner until the job section — unit-tested in
// tests/offers/addOnFulfillment.test.ts over plain inputs.

/** Days before the billing date inside which add-ons are applied. */
export const ADD_ON_APPLY_DAYS_DEFAULT = 3;
export const ADD_ON_APPLY_DAYS_MIN = 1;
export const ADD_ON_APPLY_DAYS_MAX = 14;

/** Minimal AddOnItem shape the pure helpers reason over. */
export interface AddOnLike {
  mode: string; // domain.ts AddOnMode: NEXT_ONLY | RECURRING | N_DELIVERIES
  remainingDeliveries: number | null;
  appliedAt: Date | null;
  priceCents: number;
  source: string;
}

/** Idempotency key for applying ONE add-on to ONE billing cycle. */
export function addOnApplyKey(addOnId: string, cycleISO: string): string {
  return `addon-apply:${addOnId}:${cycleISO}`;
}

/**
 * Idempotency key for consuming a contract's add-ons after ONE successful
 * charge. Keyed on the local BillingAttempt id: recordAttemptOutcome upserts
 * the same row across webhook redeliveries, so a redelivered success webhook
 * replays, while two DIFFERENT charges (e.g. a delayed cycle-N success
 * arriving in the same burst as cycle N+1's) can never share a key — a
 * count-based key made concurrent successes collide and lose a consumption.
 */
export function addOnConsumeKey(contractId: string, attemptId: string): string {
  return `addon-consume:${contractId}:${attemptId}`;
}

/** Nonce-less storefront add-on keys only guard the double-submit window. */
export const STOREFRONT_ADD_ON_NONCELESS_TTL_MS = 10 * 60 * 1000;

/**
 * Idempotency key (+ TTL) for ONE storefront add-on submission
 * (proxy.api.add-on). With a client nonce the key is per-submission (default
 * TTL) so a customer can deliberately add the same variant twice — a
 * date-granular key silently no-opped the second add while reporting
 * success. Without a nonce the key falls back to the ISO date and a short
 * TTL that only guards the double-submit window. The variant id is reduced
 * to its bare GID tail so equivalent id forms can never mint distinct keys.
 */
export function storefrontAddOnKey(
  contractId: string,
  canonicalVariantId: string,
  mode: AddOnMode,
  remainingDeliveries: number | null,
  nonce: string | null,
  now: Date,
): { key: string; ttlMs: number | undefined } {
  return {
    key: `addon:${contractId}:${planIdTail(canonicalVariantId)}:${mode}:${remainingDeliveries ?? 0}:${nonce ?? isoDate(now)}`,
    ttlMs: nonce ? undefined : STOREFRONT_ADD_ON_NONCELESS_TTL_MS,
  };
}

/**
 * True when an applied add-on was applied AFTER the charged order was built
 * (`chargeAt` = the order's createdAt): the order cannot contain the line,
 * so consuming it would remove a line that never shipped. Left applied, it
 * is consumed by the charge that actually ships it. Without a `chargeAt`
 * (no order on the webhook) the race cannot be detected — callers keep the
 * legacy consume-everything behavior.
 */
export function appliedAfterCharge(
  appliedAt: Date | null,
  chargeAt: Date | null | undefined,
): boolean {
  return (
    appliedAt != null &&
    chargeAt != null &&
    appliedAt.getTime() > chargeAt.getTime()
  );
}

/**
 * `settingsJson.addOnApplyDays` → whole days, clamped to [1, 14];
 * absent/garbage falls back to the default (3).
 */
export function normalizeAddOnApplyDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || !Number.isFinite(n)) {
    return ADD_ON_APPLY_DAYS_DEFAULT;
  }
  return Math.min(
    ADD_ON_APPLY_DAYS_MAX,
    Math.max(ADD_ON_APPLY_DAYS_MIN, Math.floor(n)),
  );
}

/**
 * A contract is in the apply window when its next billing date is at most
 * `windowDays` away. Deliberately no lower bound: a slightly past-due
 * billing date means the charge is imminent (or the next cycle is about to
 * be scheduled) — applying is still the right call, whereas skipping would
 * strand the promise for another full cycle.
 */
export function isWithinApplyWindow(
  nextBillingDate: Date | null,
  now: Date,
  windowDays: number,
): boolean {
  if (!nextBillingDate) return false;
  return nextBillingDate.getTime() <= addDays(now, windowDays).getTime();
}

/** Source convention for retention free gifts — they ship at 0 cents. */
export function isRetentionGiftSource(source: string): boolean {
  return source.trim().toUpperCase().startsWith("RETENTION_GIFT");
}

/**
 * An add-on is due for application when it has not been applied yet and
 * still owes deliveries. RECURRING/NEXT_ONLY rows always owe their first
 * application; N_DELIVERIES must have a positive remaining count (null is
 * treated as 1, matching expectedNextOrderValueCents' tolerance).
 */
export function isAddOnDue(addOn: {
  mode: string;
  appliedAt: Date | null;
  remainingDeliveries: number | null;
}): boolean {
  if (addOn.appliedAt != null) return false;
  if (addOn.mode === "RECURRING" || addOn.mode === "NEXT_ONLY") return true;
  if (addOn.mode === "N_DELIVERIES") {
    return (addOn.remainingDeliveries ?? 1) > 0;
  }
  return false;
}

/**
 * The price the applied ContractLine carries, in integer cents.
 *  - RETENTION_GIFT source → 0 (a promised gift is never charged);
 *  - RECURRING → subscriber price via planAdjustedPriceCents (the line
 *    joins the plan permanently, so it keeps the plan discount — the old
 *    full-retail behavior is a bug, see retention build notes);
 *  - NEXT_ONLY / N_DELIVERIES → the stored one-time priceCents.
 */
export function applyPriceCents(
  addOn: Pick<AddOnLike, "mode" | "priceCents" | "source">,
  planPercentOff: number | null,
): number {
  if (isRetentionGiftSource(addOn.source)) return 0;
  if (addOn.mode === "RECURRING") {
    return planAdjustedPriceCents(planPercentOff, addOn.priceCents);
  }
  return addOn.priceCents;
}

/** A selling-plan entry as stored in SellingPlanConfig.plansJson. */
export interface PlanEntryLike {
  percentOff?: unknown;
  shopifyPlanId?: unknown;
}

/** "gid://shopify/SellingPlan/123" and "123" compare equal. */
function planIdTail(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

/**
 * Resolve the contract's plan discount percent for RECURRING pricing.
 * Order: `initialDiscountPercent` when it is a real percentage in (0, 100);
 * else the largest valid `percentOff` among plan entries matched by the
 * contract lines' sellingPlanId (GID and bare-id forms compare equal);
 * else null (planAdjustedPriceCents treats null as "no discount").
 */
export function resolvePlanPercentOff(
  initialDiscountPercent: number | null,
  lineSellingPlanIds: Array<string | null>,
  planEntries: PlanEntryLike[],
): number | null {
  if (
    typeof initialDiscountPercent === "number" &&
    Number.isFinite(initialDiscountPercent) &&
    initialDiscountPercent > 0 &&
    initialDiscountPercent < 100
  ) {
    return initialDiscountPercent;
  }
  const wanted = new Set(
    lineSellingPlanIds
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map(planIdTail),
  );
  if (wanted.size === 0) return null;
  let best: number | null = null;
  for (const entry of planEntries) {
    if (!entry || typeof entry.shopifyPlanId !== "string") continue;
    if (!wanted.has(planIdTail(entry.shopifyPlanId))) continue;
    const p = typeof entry.percentOff === "number" ? entry.percentOff : NaN;
    if (!Number.isFinite(p) || p <= 0 || p >= 100) continue;
    if (best === null || p > best) best = p;
  }
  return best;
}

export type ConsumeAction = "DECREMENT" | "REMOVE_LINE" | "SKIP";

/**
 * What one successful charge does to an applied add-on.
 *  - unapplied rows and RECURRING rows are never consumed (RECURRING rows
 *    are deleted at application time; one surviving would be a legacy row);
 *  - NEXT_ONLY → REMOVE_LINE (it shipped once, done);
 *  - N_DELIVERIES → DECREMENT until the count is exhausted, then
 *    REMOVE_LINE. A current count of 0 also maps to REMOVE_LINE without
 *    decrementing further — that is the self-healing sweep for a previous
 *    run whose line removal failed after the count was zeroed.
 */
export function consumeDecision(addOn: {
  mode: string;
  appliedAt: Date | null;
  remainingDeliveries: number | null;
}): { action: ConsumeAction; remaining: number } {
  if (addOn.appliedAt == null) return { action: "SKIP", remaining: addOn.remainingDeliveries ?? 0 };
  if (addOn.mode !== "NEXT_ONLY" && addOn.mode !== "N_DELIVERIES") {
    return { action: "SKIP", remaining: addOn.remainingDeliveries ?? 0 };
  }
  const current = addOn.remainingDeliveries ?? 1;
  if (current <= 0) return { action: "REMOVE_LINE", remaining: 0 };
  const next = current - 1;
  if (next <= 0) return { action: "REMOVE_LINE", remaining: 0 };
  return { action: "DECREMENT", remaining: next };
}

// ─────────────────────────── Apply job ─────────────────────────────────────

export interface ApplyAddOnsJobResult {
  shops: number;
  contractsScanned: number;
  applied: number;
  errors: number;
}

/**
 * Apply every due add-on for contracts billing within the apply window.
 * Registered by [learning] in jobsRegistry under "apply-add-ons" (daily).
 *
 * Replay safety: each application runs inside
 * withIdempotency("addon-apply:<addOnId>:<cycleISO>") — re-running the job
 * (or overlapping runs) replays instead of double-adding. The inner
 * addLineToContract carries its own contract-edit idempotency as well, but
 * that key cannot replay across runs (it embeds the contract's updatedAt,
 * which the successful commit itself advances) — so an ADD_ON_APPLY_INTENT
 * audit marker written BEFORE the Shopify commit lets a re-run after a
 * partial failure (post-commit throw or process crash) recognise the line
 * it already committed instead of adding a duplicate.
 * Fail-soft: a failing contract is logged and counted, and the loop moves on.
 */
export async function runApplyAddOnsJob(
  shop?: string,
): Promise<ApplyAddOnsJobResult> {
  const now = new Date();

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      ...(shop ? { shop } : {}),
      status: ACTIVE,
      nextBillingDate: { not: null },
      addOns: { some: { appliedAt: null } },
    },
    include: { addOns: true, lines: true },
  });

  const byShop = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const list = byShop.get(contract.shop) ?? [];
    list.push(contract);
    byShop.set(contract.shop, list);
  }

  let contractsScanned = 0;
  let applied = 0;
  let errors = 0;

  for (const [shopDomain, shopContracts] of byShop) {
    const [settingsRow, planConfigs] = await Promise.all([
      prisma.shopSettings.findUnique({ where: { shop: shopDomain } }),
      prisma.sellingPlanConfig.findMany({
        where: { shop: shopDomain, active: true },
      }),
    ]);
    const settings = parseJson<Record<string, unknown>>(
      settingsRow?.settingsJson ?? null,
      {},
    );
    const windowDays = normalizeAddOnApplyDays(settings.addOnApplyDays);
    const planEntries: PlanEntryLike[] = planConfigs.flatMap((config) =>
      parseJson<PlanEntryLike[]>(config.plansJson, []),
    );

    // The offline admin client is minted lazily — a shop whose contracts are
    // all outside the window never needs one.
    let graphql: AdminGraphql | null = null;
    let shopApplied = 0;
    let shopErrors = 0;

    for (const contract of shopContracts) {
      if (!isWithinApplyWindow(contract.nextBillingDate, now, windowDays)) {
        continue;
      }
      contractsScanned++;
      const due = contract.addOns.filter(isAddOnDue);
      if (due.length === 0) continue;

      try {
        graphql ??= (await getOfflineAdmin(shopDomain)).graphql;
        const percentOff = resolvePlanPercentOff(
          contract.initialDiscountPercent,
          contract.lines.map((line) => line.sellingPlanId),
          planEntries,
        );
        // nextBillingDate is non-null here (query filter + window check).
        const cycleISO = contract.nextBillingDate!.toISOString();

        for (const addOn of due) {
          const { replayed } = await withIdempotency(
            addOnApplyKey(addOn.id, cycleISO),
            "addon-apply",
            async () => {
              const priceCents = applyPriceCents(addOn, percentOff);
              const markerKey = addOnApplyKey(addOn.id, cycleISO);
              // Applied add-on lines are drafted without a selling plan and
              // at exactly this price/quantity; base checkout lines carry a
              // selling plan. Constraining the lookups this way means a
              // createdAt tie after a sync recreation can never stamp (or
              // later remove) the customer's base plan line.
              const appliedLineWhere = {
                contractId: contract.id,
                shopifyVariantId: addOn.shopifyVariantId,
                currentPriceCents: priceCents,
                quantity: addOn.quantity,
                sellingPlanId: null,
              };

              // Crash-safe re-run convergence (splitContract's marker
              // pattern, but written BEFORE the mutation): addLineToContract
              // commits to Shopify FIRST, and its inner contract-edit key
              // embeds the contract's updatedAt — after a partial failure
              // between the commit and the stamp below (a thrown read/write,
              // a process crash) it cannot replay, so a naive re-run would
              // commit a SECOND identical line and double-charge the
              // customer. The ADD_ON_APPLY_INTENT audit row outlives every
              // failure window (including RECURRING's deleted AddOnItem
              // row); on re-entry we re-sync the mirror and look for a line
              // this application already created instead of re-adding one.
              //
              // The marker lookup is deliberately CYCLE-AGNOSTIC: an
              // AddOnItem is applied at most once (appliedAt is never reset
              // and completed rows are deleted), so ANY prior intent marker
              // — whatever cycle its key embeds — must route through the
              // sync-and-detect path. Both partial-failure windows can cross
              // a billing cycle before re-entry (a post-commit throw on the
              // billing day itself, or a crash whose in-progress idempotency
              // row outlives the ≤3-days-away billing date); a cycle-keyed
              // lookup then missed the marker and re-added the line — an
              // orphan billed forever.
              let line: { id: string } | null = null;
              let committed = false;
              // The appliedAt stamp participates in appliedAfterCharge
              // ordering against the charged order's createdAt, so it must
              // approximate the REAL Shopify commit — never the job-start
              // clock, which on a slow multi-contract run predates charges
              // landing mid-run and lets a never-shipped line be consumed.
              let recoveredAt: Date | null = null;
              let stampAt: Date | null = null;
              const priorMarker = await prisma.auditLog.findFirst({
                where: {
                  shop: shopDomain,
                  action: "ADD_ON_APPLY_INTENT",
                  subjectType: "AddOnItem",
                  subjectId: addOn.id,
                },
                orderBy: { seq: "desc" },
              });
              const priorPayload = parseJson<{
                key?: string;
                priorLineIds?: unknown[];
                priceCents?: unknown;
                quantity?: unknown;
              }>(priorMarker?.payloadJson, {});
              if (
                typeof priorPayload.key === "string" &&
                priorPayload.key.startsWith(`addon-apply:${addOn.id}:`)
              ) {
                await syncContractFromShopify(
                  graphql!,
                  shopDomain,
                  contract.shopifyContractId,
                );
                const priorLineIds = (priorPayload.priorLineIds ?? []).filter(
                  (id): id is string => typeof id === "string",
                );
                // A matching line whose Shopify line id predates the intent
                // is the base plan; one that does NOT is the line the prior
                // (partially failed) run already committed. Detection uses
                // the marker's RECORDED price/quantity: a plan-discount
                // change between cycles would move the freshly recomputed
                // applyPriceCents off the committed line and re-add it.
                line = await prisma.contractLine.findFirst({
                  where: {
                    contractId: contract.id,
                    shopifyVariantId: addOn.shopifyVariantId,
                    currentPriceCents:
                      typeof priorPayload.priceCents === "number"
                        ? priorPayload.priceCents
                        : priceCents,
                    quantity:
                      typeof priorPayload.quantity === "number"
                        ? priorPayload.quantity
                        : addOn.quantity,
                    sellingPlanId: null,
                    ...(priorLineIds.length > 0
                      ? { NOT: { shopifyLineId: { in: priorLineIds } } }
                      : {}),
                  },
                  orderBy: { createdAt: "desc" },
                });
                committed = line != null;
                if (committed) {
                  // The intent marker is written immediately before the
                  // original commit, so its createdAt is the only surviving
                  // approximation of when the line really landed. A few
                  // seconds early errs toward consuming a line that DID ship
                  // — never toward destroying one that did not.
                  recoveredAt = priorMarker?.createdAt ?? null;
                }
              }

              if (!committed) {
                // Persist intent (with the pre-existing Shopify line ids for
                // this variant) BEFORE the commit, so any failure after the
                // commit still leaves enough behind to recognise the landed
                // line on the next run.
                const priorLines = await prisma.contractLine.findMany({
                  where: {
                    contractId: contract.id,
                    shopifyVariantId: addOn.shopifyVariantId,
                  },
                  select: { shopifyLineId: true },
                });
                await appendAudit({
                  shop: shopDomain,
                  actorType: "SYSTEM",
                  action: "ADD_ON_APPLY_INTENT",
                  subjectType: "AddOnItem",
                  subjectId: addOn.id,
                  payload: {
                    key: markerKey,
                    addOnId: addOn.id,
                    contractId: contract.id,
                    variantId: addOn.shopifyVariantId,
                    priceCents,
                    quantity: addOn.quantity,
                    priorLineIds: priorLines
                      .map((l) => l.shopifyLineId)
                      .filter((id): id is string => id != null),
                  },
                });
                await addLineToContract(graphql!, shopDomain, contract.id, {
                  variantGid: addOn.shopifyVariantId,
                  quantity: addOn.quantity,
                  priceCents,
                });
                // Captured the moment the commit returns: milliseconds late
                // errs toward EXCLUDING the line from a charge frozen
                // mid-run (it stays applied for the next one) — never toward
                // consuming a line that never shipped.
                stampAt = new Date();
                // The core helper re-syncs the mirror; the freshest matching
                // line is the one the application just created (or, on an
                // inner replay, the one it created moments ago).
                line = await prisma.contractLine.findFirst({
                  where: appliedLineWhere,
                  orderBy: { createdAt: "desc" },
                });
              }

              if (addOn.mode === "RECURRING") {
                // The add-on became a permanent plan line; the row's job is
                // done. deleteMany keeps this idempotent if a concurrent
                // consumer already removed it.
                await prisma.addOnItem.deleteMany({ where: { id: addOn.id } });
              } else {
                await prisma.addOnItem.updateMany({
                  where: { id: addOn.id },
                  data: {
                    // Commit-time stamp (fresh path) or the intent marker's
                    // createdAt (recovery path) — one of the two is always
                    // set; the trailing fallback is unreachable belt-and-
                    // braces that degrades to "now at stamp time" (which
                    // errs toward exclusion, the safe direction).
                    appliedAt: recoveredAt ?? stampAt ?? new Date(),
                    appliedLineId: line?.id ?? null,
                    remainingDeliveries:
                      addOn.mode === "NEXT_ONLY"
                        ? 1
                        : (addOn.remainingDeliveries ?? 1),
                  },
                });
              }

              await appendAudit({
                shop: shopDomain,
                actorType: "SYSTEM",
                action: "ADD_ON_APPLIED",
                subjectType: "AddOnItem",
                subjectId: addOn.id,
                payload: {
                  contractId: contract.id,
                  mode: addOn.mode,
                  title: addOn.title,
                  quantity: addOn.quantity,
                  priceCents,
                  source: addOn.source,
                  cycle: cycleISO,
                  appliedLineId: line?.id ?? null,
                },
              });
              await emitLifecycleEvent({
                shop: shopDomain,
                name: "PRODUCT_ADDED",
                contractId: contract.id,
                shopifyCustomerId: contract.shopifyCustomerId,
                email: contract.customerEmail,
                payload: {
                  addOn: true,
                  title: addOn.title,
                  mode: addOn.mode,
                  quantity: addOn.quantity,
                  priceCents,
                  source: addOn.source,
                  cycle: cycleISO,
                },
                dedupeKey: `${addOnApplyKey(addOn.id, cycleISO)}:applied`,
              });
              return { priceCents, lineId: line?.id ?? null };
            },
          );
          if (!replayed) {
            applied++;
            shopApplied++;
          }
        }
      } catch (e) {
        // Fail-soft per contract: log, count, continue. The released
        // idempotency key means the next run retries this contract.
        errors++;
        shopErrors++;
        logger.error("apply-add-ons: contract application failed", {
          shop: shopDomain,
          contractId: contract.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (shopApplied > 0 || shopErrors > 0) {
      await appendAudit({
        shop: shopDomain,
        actorType: "SYSTEM",
        action: "ADD_ON_APPLY_JOB",
        payload: { applied: shopApplied, errors: shopErrors, windowDays },
      });
    }
  }

  return { shops: byShop.size, contractsScanned, applied, errors };
}

// ─────────────────────────── Post-charge consumption ───────────────────────

/**
 * After a successful charge: decrement applied NEXT_ONLY / N_DELIVERIES
 * add-ons and remove exhausted lines from the contract (SYSTEM actor via
 * core removeLineFromContract, which audits, re-syncs and emits
 * PRODUCT_REMOVED itself). Idempotent per charge via
 * withIdempotency("addon-consume:<contractId>:<attemptId>") — `attemptId`
 * is the local BillingAttempt id, stable across webhook redeliveries and
 * unique per charge, so concurrent successes for DIFFERENT attempts can
 * never share a key and lose a consumption.
 *
 * `chargeAt` (the charged order's createdAt, when the webhook carried an
 * order) guards the apply/charge race: an add-on applied AFTER the order
 * was built cannot have shipped with it, so it is excluded and left applied
 * for the charge that actually ships it. Without `chargeAt` every applied
 * add-on is consumed (legacy behavior).
 *
 * NEVER throws — this runs on the billing-success path and add-on
 * housekeeping must not break charge processing. Per-add-on failures are
 * swallowed after zeroing the count, so the next charge's sweep re-attempts
 * the line removal instead of double-decrementing.
 */
export async function consumeAddOnsAfterCharge(
  shop: string,
  contractId: string,
  attemptId: string,
  chargeAt?: Date | null,
): Promise<void> {
  try {
    const contract = await prisma.subscriptionContract.findFirst({
      where: { id: contractId, shop },
      include: { addOns: true },
    });
    if (!contract) return;

    const consumable = contract.addOns.filter(
      (addOn) =>
        consumeDecision(addOn).action !== "SKIP" &&
        !appliedAfterCharge(addOn.appliedAt, chargeAt),
    );
    if (consumable.length === 0) return;

    await withIdempotency(
      addOnConsumeKey(contractId, attemptId),
      "addon-consume",
      async () => {
        let graphql: AdminGraphql | null = null;
        const outcomes: Array<Record<string, unknown>> = [];

        for (const addOn of consumable) {
          try {
            const decision = consumeDecision(addOn);
            if (decision.action === "DECREMENT") {
              await prisma.addOnItem.updateMany({
                where: { id: addOn.id },
                data: { remainingDeliveries: decision.remaining },
              });
              await appendAudit({
                shop,
                actorType: "SYSTEM",
                action: "ADD_ON_CONSUMED",
                subjectType: "AddOnItem",
                subjectId: addOn.id,
                payload: {
                  contractId,
                  mode: addOn.mode,
                  title: addOn.title,
                  remainingDeliveries: decision.remaining,
                  attemptId,
                },
              });
              outcomes.push({
                addOnId: addOn.id,
                action: decision.action,
                remaining: decision.remaining,
              });
            } else if (decision.action === "REMOVE_LINE") {
              // Zero the count FIRST: if the removal below fails, the next
              // charge's sweep sees 0 and retries the removal instead of
              // decrementing again.
              await prisma.addOnItem.updateMany({
                where: { id: addOn.id },
                data: { remainingDeliveries: 0 },
              });
              // appliedLineId can dangle: Shopify rewrites line ids on later
              // draft commits and the sync recreates local rows. The fallback
              // must therefore only ever match the line the apply step
              // created — same variant AND the exact applied price/quantity
              // AND no selling plan (applied add-on lines are drafted
              // without one; base checkout lines carry one). An unordered
              // bare-variant fallback could resolve to the customer's BASE
              // plan line and remove their core product permanently.
              const appliedPrice = isRetentionGiftSource(addOn.source)
                ? 0
                : addOn.priceCents;
              const line =
                (addOn.appliedLineId
                  ? await prisma.contractLine.findFirst({
                      where: { id: addOn.appliedLineId, contractId },
                    })
                  : null) ??
                (await prisma.contractLine.findFirst({
                  where: {
                    contractId,
                    shopifyVariantId: addOn.shopifyVariantId,
                    currentPriceCents: appliedPrice,
                    quantity: addOn.quantity,
                    sellingPlanId: null,
                  },
                  orderBy: { createdAt: "desc" },
                }));
              if (line) {
                graphql ??= (await getOfflineAdmin(shop)).graphql;
                await removeLineFromContract(graphql, shop, contractId, line.id);
              } else {
                // Ambiguous: neither the stamped id nor the hardened variant
                // match found the applied line. Removing a guessed line
                // risks destroying the base plan — leave the contract
                // untouched, finalize the AddOnItem, and flag for CS review.
                logger.warn(
                  "addon-consume: applied line not found, skipping removal",
                  {
                    shop,
                    contractId,
                    addOnId: addOn.id,
                    appliedLineId: addOn.appliedLineId,
                    variantId: addOn.shopifyVariantId,
                  },
                );
              }
              await prisma.addOnItem.deleteMany({ where: { id: addOn.id } });
              await appendAudit({
                shop,
                actorType: "SYSTEM",
                action: "ADD_ON_COMPLETED",
                subjectType: "AddOnItem",
                subjectId: addOn.id,
                payload: {
                  contractId,
                  mode: addOn.mode,
                  title: addOn.title,
                  lineRemoved: Boolean(line),
                  ...(line ? {} : { needsReview: true }),
                  attemptId,
                },
              });
              outcomes.push({
                addOnId: addOn.id,
                action: decision.action,
                lineRemoved: Boolean(line),
              });
            }
          } catch (e) {
            logger.error("addon-consume: add-on failed", {
              shop,
              contractId,
              addOnId: addOn.id,
              error: e instanceof Error ? e.message : String(e),
            });
            outcomes.push({ addOnId: addOn.id, action: "ERROR" });
          }
        }
        return { attemptId, outcomes };
      },
    );
  } catch (e) {
    logger.error("consumeAddOnsAfterCharge failed", {
      shop,
      contractId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
