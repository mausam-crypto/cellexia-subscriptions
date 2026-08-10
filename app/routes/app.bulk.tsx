import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { Frequency } from "~/lib/frequency";
import {
  approxDays,
  approxWeeks,
  contractFrequency,
  frequencyLabelEn,
  frequencyToken,
  normalizeFrequencies,
  parseConfigFrequencies,
  parseFrequencyToken,
  sameFrequency,
} from "~/lib/frequency";
import { centsFromDecimalString, formatMoney } from "~/lib/money";
import { searchProducts } from "~/lib/graphql/index.server";
import {
  applyPriceChangeBatch,
  changeFrequency,
  createPriceChangeBatch,
  sendPriceChangeNotices,
  skipNextCycle,
} from "~/lib/contracts/index.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import {
  PRICE_CHANGE_NOTICE_DAYS_MAX,
  PRICE_CHANGE_NOTICE_DAYS_MIN,
} from "~/lib/settings/registry.server";

/**
 * Admin — Bulk operations:
 *  (a) Price change batches (grandfather vs propagate-with-notice),
 *  (b) Plan migration (move every ACTIVE contract from one frequency to another),
 *  (c) Mass skip (stockout tool — skip the next cycle for everyone on a variant).
 *
 * Bulk mutations run synchronously capped at 200 contracts per execution;
 * the UI reports how many remain so the operator simply runs it again.
 */

const BULK_LIMIT = 200;

const priceItemsSchema = z
  .array(
    z.object({
      variantId: z.string().min(1),
      oldPriceCents: z.number().int().min(0),
      newPriceCents: z.number().int().min(0),
    }),
  )
  .min(1);

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const now = Date.now();

  const batches = await prisma.priceChangeBatch.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  const policy = await getSetting(shop.id, "priceChangePolicy");

  const freqDist = await prisma.subscriptionContract.groupBy({
    by: ["billingIntervalUnit", "billingIntervalCount", "intervalWeeks"],
    // OURS_ONLY + isDemo: the distribution drives the plan-migration picker
    // below, which then MUTATES every matching contract — offering another
    // app's cadences here would put its subscribers one click from being
    // edited by us, and counting the portal-preview demo contract would show
    // the operator one more contract than the action can ever process.
    where: { shopId: shop.id, status: "ACTIVE", ...OURS_ONLY, isDemo: false },
    _count: { _all: true },
  });
  // Canonicalize every group through contractFrequency (NULL unit — a row
  // predating the exact mirror — reads as WEEK/intervalWeeks) and merge the
  // groups that canonicalize identically, e.g. {WEEK,8} and {NULL,8w}.
  const distribution = new Map<string, { freq: Frequency; contracts: number }>();
  for (const group of freqDist) {
    const freq = contractFrequency(group);
    const token = frequencyToken(freq);
    const entry = distribution.get(token);
    if (entry) entry.contracts += group._count._all;
    else distribution.set(token, { freq, contracts: group._count._all });
  }

  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId: shop.id, active: true },
  });

  return json({
    currencyCode: shop.currencyCode,
    policy,
    frequencies: [...distribution.values()]
      .sort(
        (a, b) =>
          approxDays(a.freq.unit, a.freq.count) -
          approxDays(b.freq.unit, b.freq.count),
      )
      .map(({ freq, contracts }) => ({
        unit: freq.unit,
        count: freq.count,
        contracts,
      })),
    // Every cadence the active plan configs offer — merged client-side with
    // the observed distribution into the migration target choices.
    planFrequencies: normalizeFrequencies(
      configs.flatMap((config) => parseConfigFrequencies(config)),
    ).map((f) => ({ unit: f.unit, count: f.count })),
    batches: batches.map((b) => {
      const items = priceItemsSchema.safeParse(b.items);
      const effectiveAtMs = b.effectiveAt?.getTime() ?? null;
      const applyReady =
        b.status !== "APPLIED" &&
        b.status !== "CANCELLED" &&
        (b.mode === "GRANDFATHER"
          ? true
          : b.status === "NOTICE_SENT" &&
            effectiveAtMs != null &&
            effectiveAtMs <= now);
      return {
        id: b.id,
        mode: b.mode,
        status: b.status,
        noticeDays: b.noticeDays,
        createdBy: b.createdBy,
        createdAt: b.createdAt.toISOString(),
        noticeSentAt: b.noticeSentAt?.toISOString() ?? null,
        effectiveAt: b.effectiveAt?.toISOString() ?? null,
        appliedAt: b.appliedAt?.toISOString() ?? null,
        contractsAffected: b.contractsAffected,
        itemCount: items.success ? items.data.length : 0,
        applyReady,
        needsNotice: b.mode === "PROPAGATE_WITH_NOTICE" && b.status === "DRAFT",
      };
    }),
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
  count?: number;
  processed?: number;
  failures?: number;
  remaining?: number;
  results?: Array<{
    id: string;
    title: string;
    imageUrl: string | null;
    variants: Array<{
      id: string;
      title: string;
      sku: string | null;
      price: string;
      priceCents: number;
    }>;
  }>;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function dateRangeWhere(from: string, to: string): Prisma.DateTimeFilter | undefined {
  const filter: Prisma.DateTimeFilter = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    filter.gte = new Date(`${from}T00:00:00.000Z`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    filter.lt = new Date(
      new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000,
    );
  }
  return filter.gte || filter.lt ? filter : undefined;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = str(formData, "intent");
  const opts = { source: "ADMIN" as const, actor };

  const adminLog = async (
    description: string,
    payload: Record<string, unknown> = {},
  ) => {
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: { description, ...payload },
    });
  };

  try {
    switch (intent) {
      case "searchProducts": {
        const q = str(formData, "q");
        if (!q) return json<ActionResponse>({ ok: true, intent, results: [] });
        const found = await searchProducts(admin, q, 10);
        return json<ActionResponse>({
          ok: true,
          intent,
          results: found.map((p) => ({
            id: p.id,
            title: p.title,
            imageUrl: p.featuredImageUrl,
            variants: p.variants.map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              price: formatMoney(v.priceCents, shop.currencyCode),
              priceCents: v.priceCents,
            })),
          })),
        });
      }

      // ── (a) Price change batches ────────────────────────────────────────
      case "createBatch": {
        const parsed = priceItemsSchema.safeParse(
          JSON.parse(str(formData, "items") || "[]"),
        );
        if (!parsed.success) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "Add at least one variant with a valid new price",
          });
        }
        const modeRaw = str(formData, "mode");
        const mode =
          modeRaw === "GRANDFATHER" || modeRaw === "PROPAGATE_WITH_NOTICE"
            ? modeRaw
            : undefined;
        // Same bound the settings registry enforces for
        // priceChangePolicy.noticeDays: the Polaris TextField's min/max only
        // constrain the spinner arrows, not typed values or direct POSTs, and
        // an out-of-range value here (a typed "3" for "30", or a crafted 0 /
        // negative) collapses the advance-notice window to same-day repricing.
        // An empty/omitted field falls back to the policy default (already
        // bound by the registry); anything else must be in range.
        const noticeDaysInput = str(formData, "noticeDays").trim();
        let noticeDays: number | undefined;
        if (noticeDaysInput !== "") {
          const noticeDaysRaw = Number(noticeDaysInput);
          if (
            !Number.isInteger(noticeDaysRaw) ||
            noticeDaysRaw < PRICE_CHANGE_NOTICE_DAYS_MIN ||
            noticeDaysRaw > PRICE_CHANGE_NOTICE_DAYS_MAX
          ) {
            return json<ActionResponse>({
              ok: false,
              intent,
              error: `Notice period must be a whole number between ${PRICE_CHANGE_NOTICE_DAYS_MIN} and ${PRICE_CHANGE_NOTICE_DAYS_MAX} days`,
            });
          }
          noticeDays = noticeDaysRaw;
        }
        const batch = await createPriceChangeBatch(
          shop.id,
          parsed.data,
          mode,
          noticeDays,
          { ...opts, createdBy: actor },
        );
        return json<ActionResponse>({
          ok: true,
          intent,
          message: `Price change batch created (${batch.contractsAffected} contracts affected)`,
        });
      }
      case "sendNotices": {
        const batchId = str(formData, "batchId");
        const result = await sendPriceChangeNotices(batchId, opts);
        await adminLog(
          `Sent price-change notices for batch ${batchId} to ${result.contractsNotified} contracts (${result.failures} failed)`,
          {
            action: "price_change_send_notices",
            batchId,
            contractsNotified: result.contractsNotified,
            failures: result.failures,
          },
        );
        return json<ActionResponse>({
          ok: true,
          intent,
          message: `Notices sent to ${result.contractsNotified} subscriber(s)${result.failures ? `, ${result.failures} failed` : ""}`,
        });
      }
      case "applyBatch": {
        const batchId = str(formData, "batchId");
        const result = await applyPriceChangeBatch(batchId, opts);
        await adminLog(
          `Applied price change batch ${batchId}: ${result.contractsUpdated} updated, ${result.contractsGrandfathered} grandfathered, ${result.failures} failed`,
          {
            action: "price_change_apply",
            batchId,
            contractsUpdated: result.contractsUpdated,
            contractsGrandfathered: result.contractsGrandfathered,
            failures: result.failures,
          },
        );
        return json<ActionResponse>({
          ok: result.failures === 0,
          intent,
          message:
            result.batch.mode === "GRANDFATHER"
              ? `Batch applied — ${result.contractsGrandfathered} contract(s) grandfathered`
              : `Batch applied — ${result.contractsUpdated} contract(s) repriced${result.failures ? `, ${result.failures} failed` : ""}`,
        });
      }

      // ── (b) Plan migration ──────────────────────────────────────────────
      case "migrate": {
        // Token fields ("8:WEEK") from the current UI; bare week integers
        // keep a stale pre-v1.8.0 tab working (bare weeks = WEEK unit).
        const legacyWeeks = (key: string): Frequency | null => {
          const weeks = parseInt(str(formData, key), 10);
          return Number.isInteger(weeks) && weeks >= 1
            ? { unit: "WEEK", count: weeks }
            : null;
        };
        const source =
          parseFrequencyToken(str(formData, "sourceFrequency")) ??
          legacyWeeks("sourceWeeks");
        const target =
          parseFrequencyToken(str(formData, "targetFrequency")) ??
          legacyWeeks("targetWeeks");
        if (!source || !target || sameFrequency(source, target)) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "Pick two different frequencies",
          });
        }
        const where: Prisma.SubscriptionContractWhereInput = {
          shopId: shop.id,
          // OURS_ONLY: this changes the billing cadence on Shopify. Another
          // subscription app's contract is not ours to reschedule.
          ...OURS_ONLY,
          // isDemo: the portal-preview demo contract is deliberately ACTIVE +
          // OURS with a real interval but a fake Shopify GID — the frequency
          // edit can only error, and the failed row re-enters "N remaining —
          // run again" arithmetic forever.
          isDemo: false,
          status: "ACTIVE" as const,
          // A WEEK source must also match every row contractFrequency
          // canonicalizes to that week cadence — the same shapes the loader's
          // distribution merges into one picker entry: rows predating the
          // exact mirror (NULL unit) AND rows whose mirrored unit is not
          // plan-offerable (a YEAR contract imported from a previous app),
          // both of which fall back to intervalWeeks.
          ...(source.unit === "WEEK"
            ? {
                OR: [
                  {
                    billingIntervalUnit: "WEEK",
                    billingIntervalCount: source.count,
                  },
                  { billingIntervalUnit: null, intervalWeeks: source.count },
                  {
                    billingIntervalUnit: {
                      notIn: ["DAY", "WEEK", "MONTH"],
                    },
                    intervalWeeks: source.count,
                  },
                ],
              }
            : {
                billingIntervalUnit: source.unit,
                billingIntervalCount: source.count,
              }),
        };
        const total = await prisma.subscriptionContract.count({ where });
        const contracts = await prisma.subscriptionContract.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take: BULK_LIMIT,
          select: { id: true },
        });
        let processed = 0;
        const failed: Array<{ contractId: string; error: string }> = [];
        for (const contract of contracts) {
          try {
            await changeFrequency(shop.domain, contract.id, target, opts);
            processed += 1;
          } catch (err) {
            failed.push({ contractId: contract.id, error: errMessage(err) });
            console.error("[admin] plan migration failed", contract.id, err);
          }
        }
        const failures = failed.length;
        const firstError = failed[0]?.error ?? null;
        const remaining = Math.max(0, total - contracts.length);
        await adminLog(
          `Plan migration ${frequencyLabelEn(source)} → ${frequencyLabelEn(target)}: ${processed} migrated, ${failures} failed, ${remaining} remaining`,
          {
            action: "plan_migration",
            // Week approximations stay first for anything built on them.
            sourceWeeks: approxWeeks(source.unit, source.count),
            targetWeeks: approxWeeks(target.unit, target.count),
            sourceUnit: source.unit,
            sourceCount: source.count,
            targetUnit: target.unit,
            targetCount: target.count,
            processed,
            failures,
            // Every failure by contract: a count plus first-error could not
            // answer "which contracts, and why" once the run scrolled out of
            // the server logs — and these are the exact contracts an operator
            // must chase before the migration is really done. Bounded by
            // BULK_LIMIT per run.
            ...(failed.length > 0 ? { failedContracts: failed } : {}),
            remaining,
            batchLimit: BULK_LIMIT,
          },
        );
        return json<ActionResponse>({
          ok: failures === 0,
          intent,
          processed,
          failures,
          remaining,
          message: `Migrated ${processed} contract(s) to ${frequencyLabelEn(target).toLowerCase()}${failures ? `, ${failures} failed` : ""}${remaining ? `. ${remaining} remaining — run again to continue.` : ""}`,
          ...(failures && firstError ? { error: firstError } : {}),
        });
      }

      // ── (c) Mass skip ───────────────────────────────────────────────────
      case "previewMassSkip":
      case "massSkip": {
        const variantId = str(formData, "variantId");
        if (!variantId) {
          return json<ActionResponse>({ ok: false, intent, error: "Pick a variant" });
        }
        const range = dateRangeWhere(str(formData, "from"), str(formData, "to"));
        const where: Prisma.SubscriptionContractWhereInput = {
          shopId: shop.id,
          // OURS_ONLY: skipping a cycle is a Shopify billing-cycle mutation —
          // never on a contract another subscription app manages.
          ...OURS_ONLY,
          // isDemo: the portal-preview demo contract carries REAL catalog
          // variant ids and a near-future nextBillingDate, so it matches any
          // stockout sweep for those variants — inflating the preview count
          // and turning every run into "1 failed" against its fake GID.
          isDemo: false,
          status: "ACTIVE",
          lines: { some: { variantId } },
          ...(range ? { nextBillingDate: range } : {}),
        };
        const total = await prisma.subscriptionContract.count({ where });
        if (intent === "previewMassSkip") {
          return json<ActionResponse>({
            ok: true,
            intent,
            count: total,
            message: `${total} active contract(s) match`,
          });
        }
        const contracts = await prisma.subscriptionContract.findMany({
          where,
          orderBy: { nextBillingDate: "asc" },
          take: BULK_LIMIT,
          select: { id: true },
        });
        let processed = 0;
        const failed: Array<{ contractId: string; error: string }> = [];
        for (const contract of contracts) {
          try {
            // ADMIN initiator: a stockout-tool skip is the merchant's call,
            // not the customer's — it lands in merchantSkipCount so a bulk
            // run can never make loyal subscribers look disengaged to the
            // risk/win-back models (see skipNextCycle).
            await skipNextCycle(shop.domain, contract.id, {
              ...opts,
              initiator: "ADMIN",
              reason: "stockout_tool",
            });
            processed += 1;
          } catch (err) {
            failed.push({ contractId: contract.id, error: errMessage(err) });
            console.error("[admin] mass skip failed", contract.id, err);
          }
        }
        const failures = failed.length;
        const firstError = failed[0]?.error ?? null;
        const remaining = Math.max(0, total - contracts.length);
        await adminLog(
          `Mass skip for variant ${variantId}: ${processed} contracts skipped, ${failures} failed, ${remaining} remaining`,
          {
            action: "mass_skip",
            variantId,
            processed,
            failures,
            // Per-contract failures, same rationale as plan_migration.
            ...(failed.length > 0 ? { failedContracts: failed } : {}),
            remaining,
            batchLimit: BULK_LIMIT,
          },
        );
        return json<ActionResponse>({
          ok: failures === 0,
          intent,
          processed,
          failures,
          remaining,
          message: `Skipped the next cycle for ${processed} contract(s)${failures ? `, ${failures} failed` : ""}${remaining ? `. ${remaining} remaining — run again to continue.` : ""}`,
          ...(failures && firstError ? { error: firstError } : {}),
        });
      }

      default:
        return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
    }
  } catch (err) {
    console.error("[admin] bulk action failed", intent, err);
    return json<ActionResponse>({ ok: false, intent, error: errMessage(err) });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

interface SelectedPriceItem {
  variantId: string;
  label: string;
  oldPriceCents: number;
  oldPrice: string;
  newPrice: string; // decimal input
}

function batchStatusTone(
  status: string,
): "attention" | "info" | "success" | "critical" | undefined {
  switch (status) {
    case "DRAFT":
      return "attention";
    case "NOTICE_SENT":
      return "info";
    case "APPLIED":
      return "success";
    case "CANCELLED":
      return "critical";
    default:
      return undefined;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "8:WEEK" → "every 8 weeks" for mid-sentence migration copy. */
function tokenLabelLower(token: string): string {
  const freq = parseFrequencyToken(token);
  return freq ? frequencyLabelEn(freq).toLowerCase() : "?";
}

export default function BulkOpsPage() {
  const data = useLoaderData<typeof loader>();
  const actionFetcher = useFetcher<typeof action>();
  const searchFetcher = useFetcher<typeof action>();
  const previewFetcher = useFetcher<typeof action>();

  const busy = actionFetcher.state !== "idle";
  const lastResult = actionFetcher.data;

  // (a) Price change batch creation
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchQuery, setBatchQuery] = useState("");
  const [batchItems, setBatchItems] = useState<SelectedPriceItem[]>([]);
  const [batchMode, setBatchMode] = useState<string>(data.policy.mode);
  const [batchNoticeDays, setBatchNoticeDays] = useState(
    String(data.policy.noticeDays),
  );
  const [applyBatchId, setApplyBatchId] = useState<string | null>(null);

  // (b) Plan migration
  const sourceOptions = data.frequencies;
  const [sourceFrequency, setSourceFrequency] = useState(
    sourceOptions.length ? frequencyToken(sourceOptions[0]) : "",
  );
  const targetChoices = useMemo(() => {
    // Union of what the active plan configs offer and what contracts are
    // actually on; the legacy week ladder only when both are empty.
    const union = normalizeFrequencies([
      ...data.planFrequencies,
      ...data.frequencies,
    ]);
    const list = union.length
      ? union
      : [2, 3, 4, 6, 8, 10, 12].map((count) => ({
          unit: "WEEK" as const,
          count,
        }));
    return list.map((f) => ({
      token: frequencyToken(f),
      label: frequencyLabelEn(f),
    }));
  }, [data.planFrequencies, data.frequencies]);
  const [targetFrequency, setTargetFrequency] = useState(
    targetChoices.some((c) => c.token === "8:WEEK")
      ? "8:WEEK"
      : (targetChoices[0]?.token ?? ""),
  );
  const [migrateOpen, setMigrateOpen] = useState(false);
  const affectedBySource =
    sourceOptions.find((f) => frequencyToken(f) === sourceFrequency)
      ?.contracts ?? 0;

  // (c) Mass skip
  const [skipQuery, setSkipQuery] = useState("");
  const [skipVariant, setSkipVariant] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [skipFrom, setSkipFrom] = useState("");
  const [skipTo, setSkipTo] = useState("");
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);

  const applyBatch = data.batches.find((b) => b.id === applyBatchId) ?? null;

  const addBatchItem = (
    variantId: string,
    label: string,
    priceCents: number,
  ) => {
    setBatchItems((items) =>
      items.some((i) => i.variantId === variantId)
        ? items
        : [
            ...items,
            {
              variantId,
              label,
              oldPriceCents: priceCents,
              oldPrice: (priceCents / 100).toFixed(2),
              newPrice: (priceCents / 100).toFixed(2),
            },
          ],
    );
  };

  const submitCreateBatch = () => {
    const items = batchItems
      .map((i) => ({
        variantId: i.variantId,
        oldPriceCents: i.oldPriceCents,
        newPriceCents: centsFromDecimalString(i.newPrice),
      }))
      .filter((i) => Number.isInteger(i.newPriceCents) && i.newPriceCents >= 0);
    actionFetcher.submit(
      {
        intent: "createBatch",
        items: JSON.stringify(items),
        mode: batchMode,
        noticeDays: batchNoticeDays,
      },
      { method: "post" },
    );
    setBatchModalOpen(false);
    setBatchItems([]);
  };

  const previewCount = previewFetcher.data?.count ?? null;

  return (
    <Page title="Bulk operations" fullWidth>
      <BlockStack gap="400">
        {lastResult && !lastResult.ok && lastResult.error ? (
          <Banner tone="critical" title="Action failed">
            <p>{lastResult.error}</p>
          </Banner>
        ) : null}
        {lastResult && lastResult.ok && lastResult.message ? (
          <Banner tone="success">
            <p>{lastResult.message}</p>
          </Banner>
        ) : null}

        {/* (a) Price change batches */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Price change batches
              </Text>
              <Button variant="primary" onClick={() => setBatchModalOpen(true)}>
                New price change
              </Button>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Grandfather locks existing subscribers at their current price;
              propagate-with-notice notifies them and applies the new price
              after the notice period.
            </Text>
            <Divider />
            {data.batches.length === 0 ? (
              <Text as="p" tone="subdued">
                No price change batches yet.
              </Text>
            ) : (
              data.batches.map((b) => (
                <InlineStack key={b.id} align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={batchStatusTone(b.status)}>{b.status}</Badge>
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {`${b.mode === "GRANDFATHER" ? "Grandfather" : "Propagate"} · ${b.itemCount} variant(s) · ${b.contractsAffected} contract(s)`}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {`Created ${formatDate(b.createdAt)}${b.createdBy ? ` by ${b.createdBy}` : ""}`}
                        {b.noticeSentAt ? ` · notices ${formatDate(b.noticeSentAt)}` : ""}
                        {b.effectiveAt ? ` · effective ${formatDate(b.effectiveAt)}` : ""}
                        {b.appliedAt ? ` · applied ${formatDate(b.appliedAt)}` : ""}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <ButtonGroup>
                    {b.needsNotice ? (
                      <Button
                        size="slim"
                        disabled={busy}
                        onClick={() =>
                          actionFetcher.submit(
                            { intent: "sendNotices", batchId: b.id },
                            { method: "post" },
                          )
                        }
                      >
                        Send notices
                      </Button>
                    ) : null}
                    {b.status !== "APPLIED" && b.status !== "CANCELLED" ? (
                      <Button
                        size="slim"
                        variant="primary"
                        disabled={busy || !b.applyReady}
                        onClick={() => setApplyBatchId(b.id)}
                      >
                        Apply now
                      </Button>
                    ) : null}
                  </ButtonGroup>
                </InlineStack>
              ))
            )}
          </BlockStack>
        </Card>

        {/* (b) Plan migration */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Plan migration
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Moves every ACTIVE contract from one delivery frequency to
              another. Runs in batches of {BULK_LIMIT} — re-run until none
              remain.
            </Text>
            <InlineStack gap="300" blockAlign="end" wrap>
              <Select
                label="From frequency"
                options={
                  sourceOptions.length
                    ? sourceOptions.map((f) => ({
                        label: `${frequencyLabelEn(f)} (${f.contracts} active)`,
                        value: frequencyToken(f),
                      }))
                    : [{ label: "No active contracts", value: "" }]
                }
                value={sourceFrequency}
                onChange={setSourceFrequency}
                disabled={sourceOptions.length === 0}
              />
              <Select
                label="To frequency"
                options={targetChoices.map((c) => ({
                  label: c.label,
                  value: c.token,
                }))}
                value={targetFrequency}
                onChange={setTargetFrequency}
              />
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !sourceFrequency ||
                  sourceFrequency === targetFrequency ||
                  affectedBySource === 0
                }
                onClick={() => setMigrateOpen(true)}
              >
                {`Migrate ${affectedBySource} contract(s)`}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* (c) Mass skip */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Mass skip (stockout tool)
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Skips the next billing cycle for every ACTIVE contract containing
              the chosen variant, optionally limited to contracts whose next
              order falls in a date range.
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <Box minWidth="240px">
                <TextField
                  label="Search products"
                  value={skipQuery}
                  onChange={setSkipQuery}
                  autoComplete="off"
                  placeholder="Search by title"
                />
              </Box>
              <Button
                loading={searchFetcher.state !== "idle"}
                onClick={() =>
                  searchFetcher.submit(
                    { intent: "searchProducts", q: skipQuery },
                    { method: "post" },
                  )
                }
              >
                Search
              </Button>
              <TextField
                label="Next order from"
                type="date"
                value={skipFrom}
                onChange={setSkipFrom}
                autoComplete="off"
              />
              <TextField
                label="Next order to"
                type="date"
                value={skipTo}
                onChange={setSkipTo}
                autoComplete="off"
              />
            </InlineStack>
            {(searchFetcher.data?.results ?? []).map((product) => (
              <BlockStack key={product.id} gap="100">
                <Text as="span" fontWeight="semibold" variant="bodySm">
                  {product.title}
                </Text>
                {product.variants.map((v) => (
                  <InlineStack key={v.id} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodySm">
                      {`${v.title || "Default"}${v.sku ? ` · ${v.sku}` : ""} · ${v.price}`}
                    </Text>
                    <Button
                      size="slim"
                      pressed={skipVariant?.id === v.id}
                      onClick={() =>
                        setSkipVariant({
                          id: v.id,
                          label: `${product.title} — ${v.title || "Default"}`,
                        })
                      }
                    >
                      {skipVariant?.id === v.id ? "Selected" : "Select"}
                    </Button>
                  </InlineStack>
                ))}
              </BlockStack>
            ))}
            {skipVariant ? (
              <InlineStack gap="300" blockAlign="center">
                <Badge tone="info">{skipVariant.label}</Badge>
                <Button
                  loading={previewFetcher.state !== "idle"}
                  onClick={() =>
                    previewFetcher.submit(
                      {
                        intent: "previewMassSkip",
                        variantId: skipVariant.id,
                        from: skipFrom,
                        to: skipTo,
                      },
                      { method: "post" },
                    )
                  }
                >
                  Preview affected
                </Button>
                {previewCount != null ? (
                  <Text as="span" variant="bodySm">
                    {`${previewCount} contract(s) match`}
                  </Text>
                ) : null}
                <Button
                  variant="primary"
                  tone="critical"
                  disabled={busy || previewCount == null || previewCount === 0}
                  onClick={() => setSkipConfirmOpen(true)}
                >
                  Skip next cycle for all
                </Button>
              </InlineStack>
            ) : null}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      <Modal
        open={batchModalOpen}
        onClose={() => setBatchModalOpen(false)}
        title="New price change batch"
        primaryAction={{
          content: "Create batch",
          loading: busy,
          disabled: batchItems.length === 0,
          onAction: submitCreateBatch,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setBatchModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="end">
              <Box width="70%">
                <TextField
                  label="Search products"
                  value={batchQuery}
                  onChange={setBatchQuery}
                  autoComplete="off"
                  placeholder="Search by title"
                />
              </Box>
              <Button
                loading={searchFetcher.state !== "idle"}
                onClick={() =>
                  searchFetcher.submit(
                    { intent: "searchProducts", q: batchQuery },
                    { method: "post" },
                  )
                }
              >
                Search
              </Button>
            </InlineStack>
            {(searchFetcher.data?.results ?? []).map((product) => (
              <BlockStack key={product.id} gap="100">
                <Text as="span" fontWeight="semibold" variant="bodySm">
                  {product.title}
                </Text>
                {product.variants.map((v) => (
                  <InlineStack key={v.id} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodySm">
                      {`${v.title || "Default"}${v.sku ? ` · ${v.sku}` : ""} · ${v.price}`}
                    </Text>
                    <Button
                      size="slim"
                      disabled={batchItems.some((i) => i.variantId === v.id)}
                      onClick={() =>
                        addBatchItem(
                          v.id,
                          `${product.title} — ${v.title || "Default"}`,
                          v.priceCents,
                        )
                      }
                    >
                      Add
                    </Button>
                  </InlineStack>
                ))}
              </BlockStack>
            ))}
            {batchItems.length > 0 ? (
              <>
                <Divider />
                <Text as="h3" variant="headingSm">
                  New prices
                </Text>
                {batchItems.map((item) => (
                  <InlineStack
                    key={item.variantId}
                    gap="200"
                    blockAlign="center"
                    wrap={false}
                  >
                    <Box width="100%">
                      <Text as="span" variant="bodySm">
                        {`${item.label} (now ${item.oldPrice})`}
                      </Text>
                    </Box>
                    <Box minWidth="120px">
                      <TextField
                        label="New price"
                        labelHidden
                        type="number"
                        value={item.newPrice}
                        onChange={(v) =>
                          setBatchItems((items) =>
                            items.map((i) =>
                              i.variantId === item.variantId
                                ? { ...i, newPrice: v }
                                : i,
                            ),
                          )
                        }
                        autoComplete="off"
                        prefix={data.currencyCode}
                      />
                    </Box>
                    <Button
                      size="micro"
                      tone="critical"
                      variant="plain"
                      onClick={() =>
                        setBatchItems((items) =>
                          items.filter((i) => i.variantId !== item.variantId),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </InlineStack>
                ))}
                <Select
                  label="Mode"
                  options={[
                    { label: "Grandfather existing subscribers", value: "GRANDFATHER" },
                    {
                      label: "Propagate with notice",
                      value: "PROPAGATE_WITH_NOTICE",
                    },
                  ]}
                  value={batchMode}
                  onChange={setBatchMode}
                />
                {batchMode === "PROPAGATE_WITH_NOTICE" ? (
                  <TextField
                    label="Notice period (days)"
                    type="number"
                    value={batchNoticeDays}
                    onChange={setBatchNoticeDays}
                    autoComplete="off"
                    min={7}
                    max={90}
                  />
                ) : null}
              </>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={applyBatch != null}
        onClose={() => setApplyBatchId(null)}
        title="Apply price change batch"
        primaryAction={{
          content: "Apply now",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (applyBatch) {
              actionFetcher.submit(
                { intent: "applyBatch", batchId: applyBatch.id },
                { method: "post" },
              );
            }
            setApplyBatchId(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setApplyBatchId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            {applyBatch?.mode === "GRANDFATHER"
              ? `Marks ${applyBatch?.contractsAffected ?? 0} affected contract(s) as grandfathered — their prices never change.`
              : `Repriced lines take effect immediately for ${applyBatch?.contractsAffected ?? 0} affected contract(s). Only possible after the notice period (effective ${formatDate(applyBatch?.effectiveAt ?? null)}).`}
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={migrateOpen}
        onClose={() => setMigrateOpen(false)}
        title="Migrate plans"
        primaryAction={{
          content: "Migrate",
          destructive: true,
          loading: busy,
          onAction: () => {
            actionFetcher.submit(
              { intent: "migrate", sourceFrequency, targetFrequency },
              { method: "post" },
            );
            setMigrateOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setMigrateOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            {`Moves up to ${Math.min(BULK_LIMIT, affectedBySource)} of ${affectedBySource} ACTIVE contract(s) from ${tokenLabelLower(sourceFrequency)} to ${tokenLabelLower(targetFrequency)}. Each contract's billing and delivery policy is edited on Shopify and the change is logged on its timeline.`}
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={skipConfirmOpen}
        onClose={() => setSkipConfirmOpen(false)}
        title="Mass skip next cycle"
        primaryAction={{
          content: "Skip for all",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (skipVariant) {
              actionFetcher.submit(
                {
                  intent: "massSkip",
                  variantId: skipVariant.id,
                  from: skipFrom,
                  to: skipTo,
                },
                { method: "post" },
              );
            }
            setSkipConfirmOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setSkipConfirmOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            {`Skips the next billing cycle for ${previewCount ?? "?"} contract(s) containing ${skipVariant?.label ?? "the selected variant"} (max ${BULK_LIMIT} per run). Customers keep their cadence afterwards; each skip is logged on the contract timeline.`}
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
