/**
 * GDPR compliance handlers [core] — the three mandatory Shopify privacy
 * topics, dispatched from services/core/webhooks/handlers.server.ts:
 *
 *  - customers/redact → handleCustomersRedact: anonymise the customer's PII
 *    while RETAINING financial records — contracts, lines, billing attempts
 *    and revenue totals stay; emails, delivery addresses, magic-link tokens
 *    and acquisition identifiers go.
 *  - customers/data_request → handleCustomersDataRequest: assemble the
 *    customer's data, log the export JSON for the operator (RUNBOOK §8.4)
 *    and append a counts-only audit row. Nothing is emailed anywhere.
 *  - shop/redact → handleShopRedact: append a final GDPR_SHOP_REDACTED audit
 *    entry with per-table counts, then purge every row belonging to the shop
 *    across every model EXCEPT the append-only AuditLog.
 *
 * All three are safe under Shopify's at-least-once delivery: redaction is
 * idempotent (a re-run finds nothing left to redact and its audit row says
 * alreadyRedacted), the data request is deduped by the ProcessedWebhook
 * replay guard upstream, and the shop purge deletes by shop-scoped filters a
 * second pass simply matches zero rows against.
 *
 * No Shopify I/O in this module — compliance webhooks carry no admin context
 * (the app may already be uninstalled), so everything works from the local
 * mirror alone.
 */
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { logger } from "~/lib/logger.server";
import { parseJson } from "~/types/domain";

// ─────────────────────────── Payload shapes ────────────────────────────────

interface ComplianceCustomer {
  id?: number | string | null;
  email?: string | null;
  phone?: string | null;
}

interface CustomersRedactPayload {
  shop_domain?: string | null;
  customer?: ComplianceCustomer | null;
  orders_to_redact?: Array<number | string> | null;
}

interface CustomersDataRequestPayload {
  shop_domain?: string | null;
  customer?: ComplianceCustomer | null;
  orders_requested?: Array<number | string> | null;
  data_request?: { id?: number | string | null } | null;
}

// ─────────────────────────── Identity helpers ──────────────────────────────

/**
 * Compliance payloads carry the bare numeric customer id; the mirror stores
 * gids verbatim ("gid://shopify/Customer/123"). Match BOTH forms so a row
 * written from either representation is found. Built inline (not via
 * shopifyClient.toGid) so this module stays free of the Shopify client
 * dependency graph — compliance handling must work with zero Shopify access.
 */
export function customerIdForms(
  rawId: number | string | null | undefined,
): string[] {
  if (rawId == null) return [];
  const s = String(rawId).trim();
  if (s === "") return [];
  if (s.startsWith("gid://")) {
    const bare = s.slice(s.lastIndexOf("/") + 1);
    return bare !== "" && bare !== s ? [s, bare] : [s];
  }
  return [`gid://shopify/Customer/${s}`, s];
}

// ─────────────────────────── Acquisition redaction ─────────────────────────

/**
 * Top-level acquisition keys removed on customer redact. `raw` and the v1
 * `custom` map hold the verbatim `_cellexia_*` attribute snapshots (referrer,
 * utm, visitor key) — leaving them would nullify the redaction, so they go
 * with the parsed keys they duplicate.
 */
const ACQUISITION_REMOVED_KEYS = [
  "referrer",
  "utm",
  "visitor",
  "raw",
  "custom",
] as const;

/** Geo sub-keys removed; countryCode/country stay for country-level cohorts. */
const ACQUISITION_REMOVED_GEO_KEYS = ["city", "province", "zip3"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Strip PII from an acquisition record (v1 or v2 shape), keeping the
 * aggregate-safe fields (channel, device, geo.countryCode, schemaVersion,
 * units/lines, widget + experiment keys, capturedAt…). Stamps `redactedAt`
 * the first time anything is stripped; a second application is a no-op
 * (`changed: false`), which is what makes handleCustomersRedact idempotent.
 */
export function redactAcquisition(
  record: Record<string, unknown>,
  redactedAt: string,
): { record: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const out: Record<string, unknown> = { ...record };

  for (const key of ACQUISITION_REMOVED_KEYS) {
    if (key in out) {
      delete out[key];
      changed = true;
    }
  }

  const geo = out["geo"];
  if (isPlainObject(geo)) {
    const nextGeo: Record<string, unknown> = { ...geo };
    for (const key of ACQUISITION_REMOVED_GEO_KEYS) {
      if (key in nextGeo) {
        delete nextGeo[key];
        changed = true;
      }
    }
    if (Object.keys(nextGeo).length === 0) delete out["geo"];
    else out["geo"] = nextGeo;
  }

  if (changed && out["redactedAt"] === undefined) {
    out["redactedAt"] = redactedAt;
  }

  return { record: out, changed };
}

// ─────────────────────────── customers/redact ──────────────────────────────

/**
 * AnalyticsEvent payload keys that can carry an email address (emit paths
 * write `email` today; the aliases cover historical/defensive shapes).
 */
const EVENT_EMAIL_KEYS = ["email", "customerEmail", "profileEmail"] as const;

export async function handleCustomersRedact(
  shop: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const p = payload as CustomersRedactPayload;
  const idForms = customerIdForms(p.customer?.id);
  const email = p.customer?.email?.trim() || null;

  if (idForms.length === 0) {
    // Nothing identifiable to match on — record the failed request so the
    // 30-day compliance clock has an audit residue, but change no state.
    logger.warn("customers/redact payload carried no customer id", { shop });
    await appendAudit({
      shop,
      actorType: "WEBHOOK",
      action: "GDPR_CUSTOMER_REDACTED",
      subjectType: "Customer",
      subjectId: null,
      payload: { invalidPayload: true },
    });
    return;
  }
  const customerGid = idForms[0];
  const redactedAt = new Date().toISOString();

  // 1. Contracts: null the PII columns, strip the acquisition record.
  //    Financial columns (totals, attempts, card metadata for reconciliation)
  //    are deliberately retained — GDPR permits keeping transaction records.
  const contracts = await prisma.subscriptionContract.findMany({
    where: { shop, shopifyCustomerId: { in: idForms } },
  });
  let contractsRedacted = 0;
  for (const contract of contracts) {
    const data: Prisma.SubscriptionContractUpdateInput = {};
    if (contract.customerEmail != null) data.customerEmail = null;
    if (contract.deliveryAddressJson != null) data.deliveryAddressJson = null;
    const acquisition = parseJson<Record<string, unknown> | null>(
      contract.acquisitionJson,
      null,
    );
    if (isPlainObject(acquisition)) {
      const { record, changed } = redactAcquisition(acquisition, redactedAt);
      if (changed) data.acquisitionJson = JSON.stringify(record);
    }
    if (Object.keys(data).length > 0) {
      await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data,
      });
      contractsRedacted += 1;
    }
  }

  // 2. Magic-link tokens: hard-delete (they exist only to reach this email).
  const tokenWhere: Prisma.MagicLinkTokenWhereInput = {
    shop,
    OR: [
      { shopifyCustomerId: { in: idForms } },
      ...(email ? [{ email }] : []),
    ],
  };
  const tokens = await prisma.magicLinkToken.deleteMany({ where: tokenWhere });

  // 3. Analytics warehouse: scrub email-bearing payload keys on the
  //    customer's events. Rows and non-identifying payload fields stay so
  //    aggregate metrics keep their history.
  const events = await prisma.analyticsEvent.findMany({
    where: { shop, shopifyCustomerId: { in: idForms } },
    select: { id: true, payloadJson: true },
  });
  let eventsScrubbed = 0;
  for (const event of events) {
    const eventPayload = parseJson<Record<string, unknown> | null>(
      event.payloadJson,
      null,
    );
    if (!isPlainObject(eventPayload)) continue;
    let changed = false;
    for (const key of EVENT_EMAIL_KEYS) {
      if (eventPayload[key] != null) {
        delete eventPayload[key];
        changed = true;
      }
    }
    if (changed) {
      await prisma.analyticsEvent.update({
        where: { id: event.id },
        data: { payloadJson: JSON.stringify(eventPayload) },
      });
      eventsScrubbed += 1;
    }
  }

  // Counts only — writing any redacted value here would re-persist the PII
  // into the (retained, append-only) audit log.
  await appendAudit({
    shop,
    actorType: "WEBHOOK",
    action: "GDPR_CUSTOMER_REDACTED",
    subjectType: "Customer",
    subjectId: customerGid,
    payload: {
      contractsMatched: contracts.length,
      contractsRedacted,
      tokensDeleted: tokens.count,
      eventsScrubbed,
      alreadyRedacted:
        contractsRedacted === 0 && tokens.count === 0 && eventsScrubbed === 0,
    },
  });
  logger.info("gdpr customer redact complete", {
    shop,
    customerId: customerGid,
    contractsRedacted,
    tokensDeleted: tokens.count,
    eventsScrubbed,
  });
}

// ─────────────────────────── customers/data_request ────────────────────────

export async function handleCustomersDataRequest(
  shop: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const p = payload as CustomersDataRequestPayload;
  const idForms = customerIdForms(p.customer?.id);
  const ordersRequested = (p.orders_requested ?? []).length;

  if (idForms.length === 0) {
    logger.warn("customers/data_request payload carried no customer id", {
      shop,
    });
    await appendAudit({
      shop,
      actorType: "WEBHOOK",
      action: "GDPR_DATA_REQUEST",
      subjectType: "Customer",
      subjectId: null,
      payload: { invalidPayload: true, ordersRequested, contractsFound: 0 },
    });
    return;
  }
  const customerGid = idForms[0];

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shop, shopifyCustomerId: { in: idForms } },
    include: { lines: true },
  });
  const contractIds = contracts.map((c) => c.id);
  const billingAttemptsCount =
    contractIds.length > 0
      ? await prisma.billingAttempt.count({
          where: { contractId: { in: contractIds } },
        })
      : 0;
  const analyticsEventsCount = await prisma.analyticsEvent.count({
    where: { shop, shopifyCustomerId: { in: idForms } },
  });

  // The EXPORT is the one place PII belongs in full — handing the customer
  // their own data is the purpose of the request, so acquisition ships
  // unredacted (referrer, utm, geo and all).
  const exportRecord = {
    generatedAt: new Date().toISOString(),
    shop,
    customerId: customerGid,
    email: p.customer?.email ?? contracts[0]?.customerEmail ?? null,
    ordersRequested,
    contracts: contracts.map((c) => ({
      id: c.id,
      shopifyContractId: c.shopifyContractId,
      status: c.status,
      currencyCode: c.currencyCode,
      intervalWeeks: c.intervalWeeks,
      customerEmail: c.customerEmail,
      deliveryAddress: parseJson<Record<string, unknown> | null>(
        c.deliveryAddressJson,
        null,
      ),
      acquisition: parseJson<Record<string, unknown> | null>(
        c.acquisitionJson,
        null,
      ),
      nextBillingDate: c.nextBillingDate,
      treatmentStartedAt: c.treatmentStartedAt,
      pausedUntil: c.pausedUntil,
      cancelledAt: c.cancelledAt,
      cancelReason: c.cancelReason,
      successfulOrders: c.successfulOrders,
      failedAttempts: c.failedAttempts,
      totalRevenueCents: c.totalRevenueCents,
      lines: c.lines.map((l) => ({
        title: l.title,
        quantity: l.quantity,
        currentPriceCents: l.currentPriceCents,
        shopifyProductId: l.shopifyProductId,
        shopifyVariantId: l.shopifyVariantId,
      })),
    })),
    billingAttemptsCount,
    analyticsEventsCount,
  };

  // The export is delivered via logs: the operator retrieves this line and
  // fulfils the request within 30 days (RUNBOOK §8.4). Deliberately not
  // emailed — the app must never send PII to an address it cannot verify.
  logger.info("gdpr customer data request export", {
    shop,
    customerId: customerGid,
    export: exportRecord,
  });

  // Exactly ONE audit row per delivery, counts only (the export itself must
  // not be persisted into the audit log — it would outlive a later redact).
  await appendAudit({
    shop,
    actorType: "WEBHOOK",
    action: "GDPR_DATA_REQUEST",
    subjectType: "Customer",
    subjectId: customerGid,
    payload: { ordersRequested, contractsFound: contracts.length },
  });
}

// ─────────────────────────── shop/redact ───────────────────────────────────

/**
 * IdempotencyKey has no shop column; its keys embed the local cuids of the
 * shop's rows instead (bill:<contractId>:…, contract:<contractId>:…,
 * dunning-step:<contractId>:…, pre-dunning:<contractId>:…,
 * autopilot:*:<contractId>:…, addon-apply:<addOnId>:…,
 * addon-consume:<contractId>:…, cancel-*:<sessionId>:…). Sweeping by
 * embedded cuid (globally unique, so `contains` cannot cross-match) removes
 * them; anything a format change ever misses still dies within 7 days via
 * the TTL + weekly prune job.
 */
const IDEMPOTENCY_SWEEP_CHUNK = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface RedactTable {
  /** Prisma model name as reported in the audit payload. */
  table: string;
  count: () => Prisma.PrismaPromise<number>;
  del: () => Prisma.PrismaPromise<Prisma.BatchPayload>;
}

/**
 * Every model except AuditLog, ordered CHILD BEFORE PARENT so the delete
 * transaction never violates a foreign key:
 *   DepletionEstimate → ContractLine → SubscriptionContract
 *   ContractLine / AddOnItem / BillingAttempt / DunningState / Milestone
 *     → SubscriptionContract
 *   SellingPlanConfigVersion → SellingPlanConfig
 *   ExperimentAssignment → Experiment
 * Everything else is relation-free and shop-scoped directly.
 */
function shopRedactTables(shop: string): RedactTable[] {
  const viaContract = { contract: { shop } } as const;
  return [
    {
      table: "DepletionEstimate",
      count: () =>
        prisma.depletionEstimate.count({ where: { line: viaContract } }),
      del: () =>
        prisma.depletionEstimate.deleteMany({ where: { line: viaContract } }),
    },
    {
      table: "ContractLine",
      count: () => prisma.contractLine.count({ where: viaContract }),
      del: () => prisma.contractLine.deleteMany({ where: viaContract }),
    },
    {
      table: "AddOnItem",
      count: () => prisma.addOnItem.count({ where: viaContract }),
      del: () => prisma.addOnItem.deleteMany({ where: viaContract }),
    },
    {
      table: "BillingAttempt",
      count: () => prisma.billingAttempt.count({ where: { shop } }),
      del: () => prisma.billingAttempt.deleteMany({ where: { shop } }),
    },
    {
      table: "DunningState",
      count: () => prisma.dunningState.count({ where: viaContract }),
      del: () => prisma.dunningState.deleteMany({ where: viaContract }),
    },
    {
      table: "Milestone",
      count: () => prisma.milestone.count({ where: viaContract }),
      del: () => prisma.milestone.deleteMany({ where: viaContract }),
    },
    {
      table: "SubscriptionContract",
      count: () => prisma.subscriptionContract.count({ where: { shop } }),
      del: () => prisma.subscriptionContract.deleteMany({ where: { shop } }),
    },
    {
      table: "SellingPlanConfigVersion",
      count: () =>
        prisma.sellingPlanConfigVersion.count({
          where: { config: { shop } },
        }),
      del: () =>
        prisma.sellingPlanConfigVersion.deleteMany({
          where: { config: { shop } },
        }),
    },
    {
      table: "SellingPlanConfig",
      count: () => prisma.sellingPlanConfig.count({ where: { shop } }),
      del: () => prisma.sellingPlanConfig.deleteMany({ where: { shop } }),
    },
    {
      table: "ExperimentAssignment",
      count: () =>
        prisma.experimentAssignment.count({ where: { experiment: { shop } } }),
      del: () =>
        prisma.experimentAssignment.deleteMany({
          where: { experiment: { shop } },
        }),
    },
    {
      table: "Experiment",
      count: () => prisma.experiment.count({ where: { shop } }),
      del: () => prisma.experiment.deleteMany({ where: { shop } }),
    },
    {
      table: "CancellationSession",
      count: () => prisma.cancellationSession.count({ where: { shop } }),
      del: () => prisma.cancellationSession.deleteMany({ where: { shop } }),
    },
    {
      table: "ScoreSnapshot",
      count: () => prisma.scoreSnapshot.count({ where: { shop } }),
      del: () => prisma.scoreSnapshot.deleteMany({ where: { shop } }),
    },
    {
      table: "AdherenceSurvey",
      count: () => prisma.adherenceSurvey.count({ where: { shop } }),
      del: () => prisma.adherenceSurvey.deleteMany({ where: { shop } }),
    },
    {
      table: "ProductMeta",
      count: () => prisma.productMeta.count({ where: { shop } }),
      del: () => prisma.productMeta.deleteMany({ where: { shop } }),
    },
    {
      table: "CompatibilityEdge",
      count: () => prisma.compatibilityEdge.count({ where: { shop } }),
      del: () => prisma.compatibilityEdge.deleteMany({ where: { shop } }),
    },
    {
      table: "RoutineTemplate",
      count: () => prisma.routineTemplate.count({ where: { shop } }),
      del: () => prisma.routineTemplate.deleteMany({ where: { shop } }),
    },
    {
      table: "WidgetConfig",
      count: () => prisma.widgetConfig.count({ where: { shop } }),
      del: () => prisma.widgetConfig.deleteMany({ where: { shop } }),
    },
    {
      table: "AnalyticsEvent",
      count: () => prisma.analyticsEvent.count({ where: { shop } }),
      del: () => prisma.analyticsEvent.deleteMany({ where: { shop } }),
    },
    {
      table: "OutboundEvent",
      count: () => prisma.outboundEvent.count({ where: { shop } }),
      del: () => prisma.outboundEvent.deleteMany({ where: { shop } }),
    },
    {
      table: "ForecastSnapshot",
      count: () => prisma.forecastSnapshot.count({ where: { shop } }),
      del: () => prisma.forecastSnapshot.deleteMany({ where: { shop } }),
    },
    {
      table: "ModelState",
      count: () => prisma.modelState.count({ where: { shop } }),
      del: () => prisma.modelState.deleteMany({ where: { shop } }),
    },
    {
      table: "MagicLinkToken",
      count: () => prisma.magicLinkToken.count({ where: { shop } }),
      del: () => prisma.magicLinkToken.deleteMany({ where: { shop } }),
    },
    {
      // Includes THIS delivery's replay-guard row — if Shopify redelivers
      // after the purge, the re-run just matches zero rows (idempotent).
      table: "ProcessedWebhook",
      count: () => prisma.processedWebhook.count({ where: { shop } }),
      del: () => prisma.processedWebhook.deleteMany({ where: { shop } }),
    },
    {
      table: "StaffRole",
      count: () => prisma.staffRole.count({ where: { shop } }),
      del: () => prisma.staffRole.deleteMany({ where: { shop } }),
    },
    {
      table: "ShopSettings",
      count: () => prisma.shopSettings.count({ where: { shop } }),
      del: () => prisma.shopSettings.deleteMany({ where: { shop } }),
    },
    {
      // Usually already emptied by APP_UNINSTALLED (shop/redact arrives 48 h
      // after uninstall); the deleteMany is the belt-and-braces pass.
      table: "Session",
      count: () => prisma.session.count({ where: { shop } }),
      del: () => prisma.session.deleteMany({ where: { shop } }),
    },
  ];
}

export async function handleShopRedact(
  shop: string,
  _payload: Record<string, unknown>,
): Promise<void> {
  const tables = shopRedactTables(shop);

  // Per-table counts BEFORE anything is deleted — they go into the retained
  // AuditLog as the permanent record of what the purge removed.
  const counts = await Promise.all(tables.map((t) => t.count()));
  const tableCounts: Record<string, number> = {};
  tables.forEach((t, i) => {
    tableCounts[t.table] = counts[i];
  });

  // Cuids whose IdempotencyKey rows must be swept (see the constant's doc).
  const [contractIds, addOnIds, sessionIds] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shop },
      select: { id: true },
    }),
    prisma.addOnItem.findMany({
      where: { contract: { shop } },
      select: { id: true },
    }),
    prisma.cancellationSession.findMany({
      where: { shop },
      select: { id: true },
    }),
  ]);
  const embeddedIds = [...contractIds, ...addOnIds, ...sessionIds].map(
    (row) => row.id,
  );
  const idChunks = chunk(embeddedIds, IDEMPOTENCY_SWEEP_CHUNK);
  const idempotencyKeyCounts = await Promise.all(
    idChunks.map((ids) =>
      prisma.idempotencyKey.count({
        where: { OR: ids.map((id) => ({ key: { contains: id } })) },
      }),
    ),
  );
  tableCounts["IdempotencyKey"] = idempotencyKeyCounts.reduce(
    (sum, n) => sum + n,
    0,
  );

  // Audit FIRST: AuditLog is the one table that survives, and this entry is
  // the evidence the purge happened and what it covered.
  await appendAudit({
    shop,
    actorType: "WEBHOOK",
    action: "GDPR_SHOP_REDACTED",
    subjectType: "Shop",
    subjectId: shop,
    payload: { tables: tableCounts },
  });

  // One transaction, child-before-parent: either the whole shop is purged or
  // (on a transient failure) nothing is, and the retryable throw lets
  // webhooks.tsx release the replay guard for Shopify's redelivery.
  await prisma.$transaction([
    ...tables.map((t) => t.del()),
    ...idChunks.map((ids) =>
      prisma.idempotencyKey.deleteMany({
        where: { OR: ids.map((id) => ({ key: { contains: id } })) },
      }),
    ),
  ]);

  logger.info("gdpr shop redact complete", { shop, tables: tableCounts });
}
