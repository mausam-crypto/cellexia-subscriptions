import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/shared";
import { logEvent } from "~/lib/events/log.server";
import { addNodeTags, removeNodeTags } from "~/lib/graphql/tags.server";

/**
 * Shopify tagging (v1.23.0, `tagging` setting group — ON by default).
 *
 * Mirrors subscription state onto Shopify tags:
 * - the customer carries the subscriber tag while they have ≥1 live (ACTIVE
 *   or PAUSED) contract that is OURS and not demo, and loses it when their
 *   last live contract ends (cancel, expire, fail — recovery re-applies it);
 * - the origin (checkout) order gets the first-order tag, every renewal
 *   order the repeat-order tag.
 *
 * Design rules, in order of importance:
 * 1. CONTAINED — every entry point catches everything. A tag write must
 *    never fail a webhook, a billing settlement or a mirror sync (golden
 *    rule 9). A missed write self-heals: the customer tag is recomputed
 *    from live-set MEMBERSHIP (not transition diffs) on every contract
 *    sync, so the daily full_sync_reconcile re-converges every customer.
 * 2. OURS-ONLY + non-demo — the store runs a second subscription app whose
 *    contracts arrive on the same webhooks; tagging one of its customers
 *    (or a demo fixture's) is the bug class the OURS_ONLY spread exists for.
 * 3. INSTALL-DARK — no tag is written while launch mode is SETUP; a failed
 *    mode read counts as SETUP (fail-dark, like the Klaviyo gate).
 * 4. OWN TAGS ONLY — a removal may only take back a tag this app recorded
 *    applying (CustomerTagState). No row + no live contract = the customer
 *    is never touched, so a merchant's hand-typed tags survive.
 * 5. FORWARD-ONLY ORDERS — order tags are applied at the moment the order
 *    is proven ours (contract-create tail / billing settlement). Historical
 *    orders (imports, install backfills, renames) are deliberately left
 *    alone: rewriting closed orders' tags would churn merchant exports, and
 *    orders past Shopify's 60-day access horizon refuse writes anyway.
 */

type TaggingSettings = SettingsValue<"tagging">;

/** Statuses that count as "currently a subscriber" for the customer tag.
 * FAILED is deliberately NOT live: analytics counts entering FAILED as
 * involuntary churn, and dunning's recovery paths flip the contract back to
 * ACTIVE — which re-applies the tag through the same membership recompute. */
const LIVE_STATUSES = ["ACTIVE", "PAUSED"] as const;

/** CUSTOMERS_REDACT rewrites mirror emails to `redacted+{id}@…` and keeps the
 * rows — after that, no data may be pushed to Shopify for the identity. */
const REDACTED_EMAIL_PREFIX = "redacted+";

/** Belt for the settings-save reconcile: a pathological book stops here
 * rather than holding the save request forever (dropped customers converge
 * via the per-sync recompute + daily full_sync_reconcile). */
const RECONCILE_CUSTOMER_CAP = 2000;

export type SubscriberTagOp =
  | "added"
  | "removed"
  | "renamed"
  | "noop"
  | "skipped"
  | "failed";

interface SubscriberTagOptions {
  /** Contract that triggered the recompute — event provenance only. */
  contractId?: string | null;
  /** Preloaded settings (reconcile sweep) — skips the per-customer read. */
  settings?: TaggingSettings;
  /** The sweep verified LIVE mode once for the whole run. */
  launchChecked?: boolean;
}

/**
 * Recompute and apply the subscriber tag for one customer. Never throws.
 * Cheap when nothing changed: the CustomerTagState row short-circuits before
 * any Shopify round trip, so per-sync and daily-reconcile calls are two
 * indexed reads under a short advisory-locked transaction in the common
 * case (the lock serializes racing webhook echoes for one customer).
 */
export async function maybeSyncSubscriberTag(
  shopId: string,
  customerId: string,
  opts: SubscriberTagOptions = {},
): Promise<SubscriberTagOp> {
  try {
    return await syncSubscriberTag(shopId, customerId, opts);
  } catch (err) {
    console.error("[tagging] subscriber tag sync failed", customerId, err);
    return "failed";
  }
}

async function syncSubscriberTag(
  shopId: string,
  customerId: string,
  opts: SubscriberTagOptions,
): Promise<SubscriberTagOp> {
  if (!customerId) return "skipped";
  const settings = opts.settings ?? (await getSetting(shopId, "tagging"));
  if (!settings.customerTagEnabled) return "skipped";

  // The whole read-decide-write runs under a per-(shop, customer) advisory
  // lock: webhook echoes race routinely (a cancel echo and a new checkout's
  // create can recompute the same customer concurrently with OPPOSITE
  // verdicts), and without serialization a stale "remove" could land after a
  // fresh "still live" no-op — stripping the tag from a live subscriber
  // until the next recompute. xact-scoped, so a crash can never leak the
  // lock; the timeout bounds a Shopify stall.
  return await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:${customerId}`}, 0))`;

      // ALL of this customer's mirrors, ownership filtered in JS below —
      // deliberately NOT ...OURS_ONLY in the where: membership (the ADD
      // side) counts only owned contracts, but the REMOVAL side must keep
      // working after every contract was reclassified away from OURS (the
      // documented OURS→FOREIGN transition on positive plan evidence) —
      // an SQL-side ownership filter would return zero rows and strand our
      // tag on another app's customer forever.
      const contracts = await tx.subscriptionContract.findMany({
        where: { shopId, customerId, isDemo: false },
        select: { id: true, status: true, email: true, ownership: true },
        orderBy: { createdAt: "desc" },
      });
      // No mirror has ever existed for this customer — nothing we manage,
      // and never a Shopify write on zero evidence. (Mirrors are never
      // deleted, so a CustomerTagState row cannot exist without one.)
      if (contracts.length === 0) return "noop";
      if (contracts.some((c) => c.email.startsWith(REDACTED_EMAIL_PREFIX))) {
        return "skipped";
      }

      const owned = contracts.filter((c) => isBillableOwnership(c.ownership));
      const desired = owned.some((c) =>
        (LIVE_STATUSES as readonly string[]).includes(c.status),
      );
      const marker = await tx.customerTagState.findUnique({
        where: { shopId_customerId: { shopId, customerId } },
      });
      const tag = settings.customerTag;
      const appliedTag = marker?.tagged ? marker.tagValue : null;

      // Byte-exact diff between recorded and desired state. A removal can
      // only ever be of the ledger-recorded value — no ledger row means no
      // removal, so hand-typed merchant tags are never touched.
      const removeTag =
        appliedTag && (!desired || appliedTag !== tag) ? appliedTag : null;
      const addTag = desired && appliedTag !== tag ? tag : null;
      if (!removeTag && !addTag) return "noop";

      if (!opts.launchChecked) {
        // Install-dark: fail-dark on an unreadable mode (the throw lands in
        // the wrapper's catch). Lazy import keeps launch↔tagging acyclic.
        const { isSetupMode } = await import("~/lib/launch/launch.server");
        if (await isSetupMode(shopId)) return "skipped";
      }

      const shop = await tx.shop.findUnique({ where: { id: shopId } });
      if (!shop || shop.uninstalledAt) return "skipped";

      // No THROTTLED retry by design: a failed write throws out of the
      // transaction into the wrapper's catch ("failed"), the ledger is not
      // advanced, and the next recompute (any sync of this customer, or the
      // daily full_sync_reconcile at the latest) retries the same diff.
      const admin = await adminClientForShop(shop.domain);
      if (removeTag) await removeNodeTags(admin, customerId, [removeTag]);
      if (addTag) await addNodeTags(admin, customerId, [addTag]);

      // Recorded only AFTER Shopify accepted the write — a crash in between
      // re-runs the (idempotent) mutation on the next recompute.
      await tx.customerTagState.upsert({
        where: { shopId_customerId: { shopId, customerId } },
        create: { shopId, customerId, tagged: desired, tagValue: tag },
        update: {
          tagged: desired,
          tagValue: desired ? tag : (removeTag ?? tag),
        },
      });

      const op: SubscriberTagOp =
        removeTag && addTag ? "renamed" : addTag ? "added" : "removed";
      // Witness: prefer an owned contract; the pure-removal case after a
      // reclassification away from OURS falls back to any mirror so the
      // audit event keeps its contract link (event_provenance rule).
      const witness = owned[0] ?? contracts[0];
      await logEvent({
        shopId,
        contractId: opts.contractId ?? witness.id,
        customerId,
        email: witness.email,
        type: "contract.updated",
        source: "SYSTEM",
        actor: "system",
        payload: {
          action: "subscriber_tag_synced",
          op,
          tag,
          ...(removeTag ? { removedTag: removeTag } : {}),
          customerId,
        },
      });
      return op;
    },
    // maxWait bounds the queue for the lock; timeout bounds the Shopify
    // round trips so a stalled API call cannot pin a connection forever.
    { maxWait: 5_000, timeout: 30_000 },
  );
}

/**
 * Tag one subscription order (origin order → first-order tag, renewal order
 * → repeat-order tag). Never throws. Idempotent across redrives via the
 * taggedOrderId-keyed event guard (same family as the contract.created
 * replay guard); the Shopify add itself is a no-op when the tag is present.
 */
export async function maybeTagSubscriptionOrder(
  shopId: string,
  contract: {
    id: string;
    customerId: string;
    email: string;
    isDemo: boolean;
    ownership: string;
  },
  orderGid: string | null | undefined,
  kind: "first" | "repeat",
  opts: { orderName?: string | null } = {},
): Promise<void> {
  try {
    if (!orderGid) return;
    if (contract.isDemo) return;
    if (!isBillableOwnership(contract.ownership)) return;
    // Post-redact identities are frozen: no data pushed to Shopify for them,
    // order tags included (same rule as the customer path).
    if (contract.email.startsWith(REDACTED_EMAIL_PREFIX)) return;
    const settings = await getSetting(shopId, "tagging");
    if (!settings.orderTagsEnabled) return;
    const tag = kind === "first" ? settings.firstOrderTag : settings.repeatOrderTag;

    // Once per order: a redrive, a webhook replay or the P2002 create-race
    // both-run shape finds the guard event and skips — which also respects a
    // merchant who removed the tag by hand. Scoped to the CONTRACT so the
    // JSON predicate filters a few dozen rows off the [contractId, createdAt]
    // index instead of heap-scanning the shop's entire contract.updated
    // history (the highest-volume event type — every sync logs one).
    // Best-effort, not atomic: two drivers racing through the window between
    // this check and the event insert can double-log the audit event; the
    // Shopify add itself stays idempotent, so the tag is never wrong.
    const alreadyTagged = await prisma.subscriberEvent.findFirst({
      where: {
        shopId,
        contractId: contract.id,
        type: "contract.updated",
        payload: { path: ["taggedOrderId"], equals: orderGid },
      },
      select: { id: true },
    });
    if (alreadyTagged) return;

    // Install-dark: fail-dark on an unreadable mode (caught below).
    const { isSetupMode } = await import("~/lib/launch/launch.server");
    if (await isSetupMode(shopId)) return;

    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop || shop.uninstalledAt) return;

    const admin = await adminClientForShop(shop.domain);
    await addNodeTags(admin, orderGid, [tag]);

    await logEvent({
      shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "contract.updated",
      source: "SYSTEM",
      actor: "system",
      payload: {
        action: "order_tagged",
        taggedOrderId: orderGid,
        ...(opts.orderName ? { orderName: opts.orderName } : {}),
        tag,
        kind,
      },
    });
  } catch (err) {
    console.error("[tagging] order tag failed", orderGid, err);
  }
}

export interface SubscriberTagReconcileStats {
  examined: number;
  added: number;
  removed: number;
  renamed: number;
  failed: number;
  capped: boolean;
}

/**
 * Reconcile the subscriber tag for every customer it could apply to: everyone
 * with a live owned contract (add side) plus everyone the ledger says is
 * currently tagged (remove/rename side). Invoked contained from the Settings
 * save so a toggle-on or a rename takes effect immediately; the per-sync
 * recompute + daily full_sync_reconcile converge anyone this pass missed.
 * Returns null when the pass did not run (disabled / SETUP).
 */
export async function reconcileAllSubscriberTags(
  shopId: string,
  actor?: string | null,
): Promise<SubscriberTagReconcileStats | null> {
  const settings = await getSetting(shopId, "tagging");
  if (!settings.customerTagEnabled) return null;
  const { isSetupMode } = await import("~/lib/launch/launch.server");
  if (await isSetupMode(shopId)) return null;

  const [live, tagged] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        isDemo: false,
        ...OURS_ONLY,
        status: { in: [...LIVE_STATUSES] },
      },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
    prisma.customerTagState.findMany({
      where: { shopId, tagged: true },
      select: { customerId: true },
    }),
  ]);
  const customerIds = [
    ...new Set(
      [...live, ...tagged].map((r) => r.customerId).filter((id) => id !== ""),
    ),
  ];
  const capped = customerIds.length > RECONCILE_CUSTOMER_CAP;
  const batch = customerIds.slice(0, RECONCILE_CUSTOMER_CAP);

  const stats: SubscriberTagReconcileStats = {
    examined: batch.length,
    added: 0,
    removed: 0,
    renamed: 0,
    failed: 0,
    capped,
  };
  for (const customerId of batch) {
    const op = await maybeSyncSubscriberTag(shopId, customerId, {
      settings,
      launchChecked: true,
    });
    if (op === "added") stats.added += 1;
    else if (op === "removed") stats.removed += 1;
    else if (op === "renamed") stats.renamed += 1;
    else if (op === "failed") stats.failed += 1;
  }

  await logEvent({
    shopId,
    type: "admin.action",
    source: "ADMIN",
    actor: actor ?? "system",
    payload: { action: "subscriber_tags_reconciled", ...stats },
  });
  return stats;
}
