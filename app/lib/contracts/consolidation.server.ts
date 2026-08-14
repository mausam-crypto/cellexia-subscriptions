import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { contractFrequency, frequencyToken } from "~/lib/frequency";
import { draftLineAdd, withContractDraft } from "~/lib/graphql/index.server";
import {
  clampGrantPercentForContract,
  type StackableLine,
} from "~/lib/billing/stacking.server";
import { cancelContract } from "./service.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import {
  eventIdentity,
  loadContractContext,
  reloadContract,
  resolveActor,
  resolveSource,
  withMirrorGuard,
  type LocalContractLine,
  type LocalContractWithLines,
  type ServiceOptions,
} from "./shared.server";

/**
 * Shipment consolidation ("routine box"): merge several of a customer's
 * contracts into one so everything bills and ships together — fewer parcels,
 * fewer charges, fewer chances to churn.
 */

// ── Manual / engine merge ────────────────────────────────────────────────────

/** A grant re-pointed onto the primary (merge event payload shape). */
interface MovedGrant {
  grantId: string;
  type: string;
  percent: number;
  cyclesRemaining: number;
  /** Present when the primary's stacking headroom reduced the percent. */
  clampedFromPercent?: number;
}

/** A grant that could NOT ride the merge (merge event payload shape). */
interface DroppedGrant {
  grantId: string;
  type: string;
  percent: number;
  cyclesRemaining: number;
  reason: "stacking_cap";
}

/**
 * Move a source contract's live DiscountGrants (cyclesRemaining > 0, not
 * exhausted) onto the merge primary, so an accepted cancel-save / win-back /
 * retention discount keeps applying after consolidation — the grant is a
 * price promise made to the customer, and the source it sits on is about to
 * be cancelled into the primary. Grants ride billing-cycle contract edits on
 * whatever contract they point at (golden rule 3 — never codes), so the move
 * is a local re-point; the billing sweep's best-of selection already
 * prevents stacking when the primary holds its own grants.
 *
 * Each percent is re-clamped against the primary's post-merge lines under
 * settings.discountStacking.maxTotalDiscountPct — the same hard gate
 * `applyDiscountGrant` enforces at creation. Zero headroom = the grant is
 * NOT moved (it dies with the source) and is reported as dropped so the
 * merge event makes the broken promise audible instead of silent.
 *
 * Idempotent: a retry finds already-moved grants on the primary, not the
 * source, and moves nothing twice.
 */
async function migrateActiveGrants(
  shopId: string,
  primaryId: string,
  primaryLinesAfterMerge: StackableLine[],
  sourceId: string,
): Promise<{ moved: MovedGrant[]; dropped: DroppedGrant[] }> {
  const grants = await prisma.discountGrant.findMany({
    where: {
      contractId: sourceId,
      cyclesRemaining: { gt: 0 },
      exhaustedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });
  const moved: MovedGrant[] = [];
  const dropped: DroppedGrant[] = [];
  for (const grant of grants) {
    const clamp = await clampGrantPercentForContract(
      shopId,
      primaryLinesAfterMerge,
      grant.percent,
    );
    if (clamp.percent < 1) {
      dropped.push({
        grantId: grant.id,
        type: grant.type,
        percent: grant.percent,
        cyclesRemaining: grant.cyclesRemaining,
        reason: "stacking_cap",
      });
      continue;
    }
    await prisma.discountGrant.update({
      where: { id: grant.id },
      data: {
        contractId: primaryId,
        ...(clamp.percent !== grant.percent ? { percent: clamp.percent } : {}),
      },
    });
    moved.push({
      grantId: grant.id,
      type: grant.type,
      percent: clamp.percent,
      cyclesRemaining: grant.cyclesRemaining,
      ...(clamp.percent !== grant.percent
        ? { clampedFromPercent: grant.percent }
        : {}),
    });
  }
  return { moved, dropped };
}

/**
 * Merge `otherLocalIds` into `primaryLocalId`: move each source contract's
 * recurring non-gift lines onto the primary at their preserved ongoing
 * prices, move each source's live DiscountGrants onto the primary (the price
 * promises must survive the merge), cancel the sources (reason "MERGED",
 * cancelSource SYSTEM, no win-back — the customer is still subscribed), and
 * stamp `mergeGroupId` on every involved contract.
 *
 * Retry-safe: `mergeGroupId = primary.id` is stamped on each source right
 * after the Shopify draft commit that copied its lines, BEFORE the cancel
 * phase. A still-ACTIVE source carrying this primary's stamp is a
 * half-merged leftover of a prior attempt whose cancel failed — a retry
 * resumes it with grants + cancel ONLY and never re-copies its lines
 * (re-copying is a recurring double charge on the primary). Sources already
 * CANCELLED into this merge group are skipped entirely.
 */
export async function mergeContracts(
  shopDomain: string,
  primaryLocalId: string,
  otherLocalIds: string[],
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, primaryLocalId);
  const { shop, contract: primary, admin } = ctx;
  if (primary.status !== "ACTIVE") {
    throw new Error(
      `Merge primary ${primary.id} is not ACTIVE (status ${primary.status})`,
    );
  }
  // Merging rewrites lines on Shopify and cancels the sources — never on a
  // contract another subscription app owns (or one we cannot vouch for).
  if (!isBillableOwnership(primary.ownership)) {
    throw new Error(
      `Merge primary ${primary.id} is not managed by this app (ownership ${primary.ownership})`,
    );
  }
  // A primary that is itself half-merged into ANOTHER contract (stamped with
  // a foreign mergeGroupId while still ACTIVE) already had its lines copied
  // elsewhere; absorbing sources into it would multiply those copies when
  // the pending merge is retried. Fail safe: complete that merge first.
  if (primary.mergeGroupId != null && primary.mergeGroupId !== primary.id) {
    throw new Error(
      `Merge primary ${primary.id} is half-merged into ${primary.mergeGroupId} — complete that merge before using it as a primary`,
    );
  }

  // Load + validate sources. `resume` sources are half-merged leftovers of a
  // prior attempt: their lines are already on the primary (the pre-cancel
  // mergeGroupId stamp proves it), only the cancel + grant move remain.
  const freshSources: LocalContractWithLines[] = [];
  const resumeSources: LocalContractWithLines[] = [];
  for (const otherId of otherLocalIds) {
    if (otherId === primaryLocalId) continue;
    const other = await prisma.subscriptionContract.findUnique({
      where: { id: otherId },
      include: { lines: true },
    });
    if (!other || other.shopId !== shop.id) {
      throw new Error(`Merge source contract not found: ${otherId}`);
    }
    if (!isBillableOwnership(other.ownership)) {
      throw new Error(
        `Merge source ${otherId} is not managed by this app (ownership ${other.ownership})`,
      );
    }
    if (other.customerId !== primary.customerId) {
      throw new Error(
        `Merge source ${otherId} belongs to a different customer than primary ${primary.id}`,
      );
    }
    if (other.status === "CANCELLED" && other.mergeGroupId === primary.id) {
      continue; // already merged into this primary — idempotent skip
    }
    if (other.status !== "ACTIVE") {
      throw new Error(
        `Merge source ${otherId} is not ACTIVE (status ${other.status})`,
      );
    }
    if (other.mergeGroupId === primary.id) {
      // Half-merged into THIS primary by a prior attempt whose cancel
      // failed: the lines are already on the primary — never copy them
      // again (a re-copy is a duplicate recurring line, billed on every
      // renewal). Resume with grants + cancel only.
      resumeSources.push(other);
      continue;
    }
    if (other.mergeGroupId != null && other.mergeGroupId !== other.id) {
      // Half-merged into a DIFFERENT contract: its lines already live over
      // there. Folding it in here would duplicate them the moment that
      // pending merge is retried. Fail safe: refuse until it completes.
      // (`mergeGroupId === other.id` is just "was the primary of an earlier
      // merge" — a normal fresh source.)
      throw new Error(
        `Merge source ${otherId} is half-merged into ${other.mergeGroupId} — complete that merge first`,
      );
    }
    freshSources.push(other);
  }
  if (freshSources.length === 0 && resumeSources.length === 0) {
    return reloadContract(primary.id);
  }

  // Move recurring, non-gift lines of FRESH sources only (gift lines are
  // re-earned on the primary; one-time-addon mirrors belong to a source
  // billing cycle and do not move; resume sources were copied last attempt).
  const moves: Array<{ source: LocalContractWithLines; line: LocalContractLine }> =
    [];
  for (const source of freshSources) {
    for (const line of source.lines) {
      if (line.isGift || line.isOneTimeAddon) continue;
      moves.push({ source, line });
    }
  }

  const addedShopifyIds: Array<string | null> = [];
  if (moves.length > 0) {
    await withContractDraft(
      admin,
      primary.shopifyContractId,
      async (draftId, run) => {
        for (const { line } of moves) {
          const id = await draftLineAdd(run, draftId, {
            productVariantId: line.variantId,
            quantity: line.quantity,
            currentPriceCents: line.currentPriceCents, // ongoing price preserved
            // Plan lineage travels with the line: dropped here, the merged
            // line carries no selling plan on Shopify OR locally (the next
            // sync mirrors the plan-less line back), and per-line plan
            // attribution is erased forever. Ownership itself would survive
            // via the monotonic OURS rule — this is about keeping "which
            // plan did this line ride" answerable after a merge.
            sellingPlanId: line.sellingPlanId,
            sellingPlanName: line.sellingPlanName,
          });
          addedShopifyIds.push(id);
        }
      },
    );
  }

  await withMirrorGuard("mergeContracts", ctx, options, async () => {
    for (let i = 0; i < moves.length; i++) {
      const { line } = moves[i]!;
      await prisma.contractLine.create({
        data: {
          contractId: primary.id,
          shopifyLineId: addedShopifyIds[i] ?? null,
          productId: line.productId,
          variantId: line.variantId,
          title: line.title,
          variantTitle: line.variantTitle,
          sku: line.sku,
          imageUrl: line.imageUrl,
          quantity: line.quantity,
          sellingPlanId: line.sellingPlanId,
          sellingPlanName: line.sellingPlanName,
          currentPriceCents: line.currentPriceCents,
          compareAtPriceCents: line.compareAtPriceCents,
          unitCostCents: line.unitCostCents,
          isGift: false,
          isOneTimeAddon: false,
          addedVia: line.addedVia,
        },
      });
    }
    // Stamp merge progress BEFORE the cancel phase: an ACTIVE source carrying
    // `mergeGroupId = primary.id` means "lines already copied, cancel
    // pending" — the marker the validation above resumes on, so a retry
    // after a failed cancel completes the cancel instead of re-adding the
    // lines (recurring double charge). Stamped only AFTER the Shopify draft
    // commit — a stamp must never exist unless the lines really are on the
    // primary — and inside the mirror guard, so a stamp failure is an
    // audible divergence, never a silent retry-with-duplicates.
    for (const source of freshSources) {
      await prisma.subscriptionContract.update({
        where: { id: source.id },
        data: { mergeGroupId: primary.id },
      });
    }
  });

  // The primary's post-merge line set — what the stacking clamp on migrated
  // grants must be judged against (its plan ongoing discount can differ from
  // the source's). Resume sources' lines were mirrored by the prior attempt
  // and are already inside `primary.lines`.
  const primaryLinesAfterMerge: StackableLine[] = [
    ...primary.lines.map((l) => ({ productId: l.productId, isGift: l.isGift })),
    ...moves.map(({ line }) => ({ productId: line.productId, isGift: false })),
  ];

  // Move live grants + cancel each source (no win-back — the subscriber is
  // still with us). Grants move BEFORE the cancel so a cancel failure can
  // never strand a price promise on a cancelled contract; the move is
  // idempotent, so a resumed retry re-runs it harmlessly. Failures are
  // collected so one bad source cannot strand the others silently.
  const failures: Array<{ contractId: string; error: string }> = [];
  const mergedIds: string[] = [];
  const resumedIds = new Set(resumeSources.map((s) => s.id));
  let movedGrantCount = 0;
  let droppedGrantCount = 0;
  for (const source of [...freshSources, ...resumeSources]) {
    try {
      const grants = await migrateActiveGrants(
        shop.id,
        primary.id,
        primaryLinesAfterMerge,
        source.id,
      );
      movedGrantCount += grants.moved.length;
      droppedGrantCount += grants.dropped.length;
      await cancelContract(shopDomain, source.id, "MERGED", {
        source: resolveSource(options),
        actor: resolveActor(options),
        cancelSource: "SYSTEM",
        scheduleWinback: false,
      });
      mergedIds.push(source.id);
      await logEvent({
        shopId: shop.id,
        contractId: source.id,
        customerId: source.customerId,
        email: source.email,
        type: "contract.merged",
        source: resolveSource(options),
        actor: resolveActor(options),
        payload: {
          mergedInto: primary.id,
          movedLineCount: source.lines.filter(
            (l) => !l.isGift && !l.isOneTimeAddon,
          ).length,
          ...(resumedIds.has(source.id) ? { resumed: true } : {}),
          ...(grants.moved.length > 0 ? { movedGrants: grants.moved } : {}),
          ...(grants.dropped.length > 0
            ? { droppedGrants: grants.dropped }
            : {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ contractId: source.id, error: message });
      console.error(
        "[contracts] mergeContracts: failed to cancel merged source — its lines were already copied to the primary; the retry will resume with cancel only (mergeGroupId stamp)",
        source.id,
        err,
      );
    }
  }

  await prisma.subscriptionContract.update({
    where: { id: primary.id },
    data: { mergeGroupId: primary.id },
  });

  await logEvent({
    ...eventIdentity(shop, primary),
    type: "contract.merged",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      mergedContractIds: mergedIds,
      movedLineCount: moves.length,
      ...(resumedIds.size > 0 ? { resumedContractIds: [...resumedIds] } : {}),
      ...(movedGrantCount > 0 ? { movedGrantCount } : {}),
      ...(droppedGrantCount > 0 ? { droppedGrantCount } : {}),
      ...(failures.length > 0 ? { failures } : {}),
    },
  });

  if (failures.length > 0) {
    throw new Error(
      `mergeContracts: ${failures.length} source contract(s) could not be cancelled after their lines were moved: ${failures
        .map((f) => f.contractId)
        .join(", ")}`,
    );
  }

  return reloadContract(primary.id);
}

// ── Automatic consolidation (daily job) ──────────────────────────────────────

export interface AutoConsolidationResult {
  customersEvaluated: number;
  clustersMerged: number;
  contractsMerged: number;
  failures: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trim + collapse whitespace + lowercase; non-strings degrade to "". */
function normalizedFingerprintPart(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

/**
 * Where the contract's parcels GO, as a comparable token for the AUTO merge
 * path. Two writers feed `deliveryAddress`: the sync mirror (full Shopify
 * shape, code + full-name fields) and `updateDeliveryAddress` (portal shape,
 * code fields only) — so province/country compare on their code with the
 * full name as fallback, and every part is trim/case-normalized so cosmetic
 * checkout differences never split a genuine match. Recipient identity
 * (first/last/company) is part of the fingerprint: a parcel addressed to a
 * different person is a different delivery even at the same street address
 * (the recurring-gift case). Phone is deliberately excluded — it does not
 * route the parcel.
 *
 * Null handling is fail-safe for a DESTRUCTIVE merge: null vs null compares
 * equal (nothing distinguishes them), null vs set compares different (we
 * cannot prove they ship to the same place, so we never merge them).
 */
export function deliveryAddressFingerprint(deliveryAddress: unknown): string {
  if (deliveryAddress == null) return "none";
  if (typeof deliveryAddress !== "object" || Array.isArray(deliveryAddress)) {
    // Unrecognized mirror shape — compare opaquely; only byte-identical
    // unknowns can merge.
    return `opaque:${JSON.stringify(deliveryAddress)}`;
  }
  const a = deliveryAddress as Record<string, unknown>;
  return [
    normalizedFingerprintPart(a.firstName),
    normalizedFingerprintPart(a.lastName),
    normalizedFingerprintPart(a.company),
    normalizedFingerprintPart(a.address1),
    normalizedFingerprintPart(a.address2),
    normalizedFingerprintPart(a.city),
    normalizedFingerprintPart(a.provinceCode) ||
      normalizedFingerprintPart(a.province),
    normalizedFingerprintPart(a.countryCode) ||
      normalizedFingerprintPart(a.country),
    normalizedFingerprintPart(a.zip),
  ].join("|");
}

/**
 * When settings.consolidation.autoMergeAlignedContracts is on: group a
 * customer's ACTIVE pay-per-cycle contracts by their EXACT cadence
 * (contractFrequency) AND their delivery routing (normalized address +
 * payment method), and merge those whose nextBillingDate falls within
 * alignmentWindowDays of the earliest one — into that earliest contract.
 * Called by the daily job.
 *
 * The routing gate exists because this path is automatic: merging folds the
 * source's lines into the primary's address and payment method wholesale,
 * and a customer legitimately holds two same-cadence contracts shipping to
 * different addresses (home + office, a recurring gift). The AUTO path must
 * never reroute a delivery or switch whose card is charged; an explicit
 * admin-initiated mergeContracts call stays free to merge across addresses —
 * the admin sees what they are doing.
 */
export async function runAutoConsolidation(
  shopId: string,
): Promise<AutoConsolidationResult> {
  const result: AutoConsolidationResult = {
    customersEvaluated: 0,
    clustersMerged: 0,
    contractsMerged: 0,
    failures: 0,
  };

  const settings = await getSetting(shopId, "consolidation");
  if (!settings.autoMergeAlignedContracts) return result;

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`Shop not found: ${shopId}`);

  // Prepaid contracts are excluded: their billing/delivery rhythms differ and
  // merging would break the deliveries-remaining accounting.
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      ...OURS_ONLY, // never fold another app's contract into one of ours
      status: "ACTIVE",
      isPrepaid: false,
      isDemo: false,
      nextBillingDate: { not: null },
    },
    orderBy: { nextBillingDate: "asc" },
  });

  const groups = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    // EXACT cadence key ({count}:{unit} via contractFrequency), never the
    // intervalWeeks approximation: MONTH×4 / DAY-ceil-÷7 map DISTINCT
    // cadences to the same integer (10 days and 2 weeks are both "2"), and
    // this grouping feeds a DESTRUCTIVE merge — the sources are cancelled.
    // An approximation collision must never decide that; contractFrequency
    // still degrades pre-v1.4.0 rows (null unit) to their week mirror, which
    // is genuinely all those rows know about themselves.
    //
    // Routing gate (same destructive-merge posture): contracts only cluster
    // when they ship to the SAME normalized address and charge the SAME
    // payment method — the automatic path must never silently reroute a
    // delivery or move a line onto a different card. Payment follows the
    // address null rule: both unreadable (null) compares equal, null vs set
    // compares different — fail-safe, don't merge what we cannot prove.
    // Joined on NUL so free-text address parts can never collide with the
    // field separators.
    const key = [
      contract.customerId,
      frequencyToken(contractFrequency(contract)),
      deliveryAddressFingerprint(contract.deliveryAddress),
      contract.paymentMethodId ?? "none",
    ].join("\u0000");
    const list = groups.get(key);
    if (list) list.push(contract);
    else groups.set(key, [contract]);
  }

  const windowMs = settings.alignmentWindowDays * DAY_MS;
  const customersSeen = new Set<string>();

  for (const group of groups.values()) {
    customersSeen.add(group[0]!.customerId);
    if (group.length < 2) continue;

    // Cluster by billing-date proximity (group is sorted ascending); merge
    // each cluster into its earliest-billing contract.
    let cluster: typeof contracts = [group[0]!];
    const clusters: Array<typeof contracts> = [];
    for (let i = 1; i < group.length; i++) {
      const contract = group[i]!;
      const anchor = cluster[0]!.nextBillingDate!;
      if (contract.nextBillingDate!.getTime() - anchor.getTime() <= windowMs) {
        cluster.push(contract);
      } else {
        clusters.push(cluster);
        cluster = [contract];
      }
    }
    clusters.push(cluster);

    for (const c of clusters) {
      if (c.length < 2) continue;
      const [primary, ...rest] = c;
      try {
        await mergeContracts(
          shop.domain,
          primary!.id,
          rest.map((r) => r.id),
          { source: "SCHEDULER", actor: "system" },
        );
        result.clustersMerged += 1;
        result.contractsMerged += rest.length;
      } catch (err) {
        result.failures += 1;
        console.error(
          "[contracts] runAutoConsolidation: cluster merge failed",
          primary!.id,
          err,
        );
      }
    }
  }

  result.customersEvaluated = customersSeen.size;
  return result;
}
