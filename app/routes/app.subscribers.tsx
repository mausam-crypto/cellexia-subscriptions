import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Outlet,
  useFetcher,
  useLoaderData,
  useNavigate,
  useParams,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  ChoiceList,
  Filters,
  IndexTable,
  InlineStack,
  Modal,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
  Tooltip,
  useIndexResourceState,
} from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { csvEscape } from "~/lib/csv.server";
import { formatMoney } from "~/lib/money";
import {
  CREATED_ID_ASC,
  CREATED_ID_DESC,
  createdIdAfter,
  createdIdBefore,
  decodeCreatedIdCursor,
  encodeCreatedIdCursor,
} from "~/lib/pagination.server";
import { applyDiscountGrant, skipNextCycle } from "~/lib/contracts/index.server";
import {
  OURS_ONLY,
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  normalizeOwnership,
} from "~/lib/ownership/shared";
import { claimContracts } from "~/lib/ownership/ownership.server";

/**
 * Admin — Subscribers index. Search (email/name), status filter, ownership
 * filter, risk sort, cursor pagination by createdAt, bulk skip / bulk discount
 * grant / bulk claim / CSV export. Row click opens the support cockpit
 * (app.subscribers.$id).
 *
 * This is one of the few places that deliberately shows contracts we do NOT
 * own: the store may run a second subscription app whose contracts are
 * mirrored here, and the merchant needs to see them (and, when migrating,
 * claim them). Every row therefore carries its ownership, and non-OURS rows
 * are visibly distinct — nothing in the app bills, emails or counts them.
 */

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
] as const;

const OWNERSHIP_OPTIONS = [
  OWNERSHIP_OURS,
  OWNERSHIP_FOREIGN,
  OWNERSHIP_UNKNOWN,
] as const;

const OWNERSHIP_LABELS: Record<string, string> = {
  [OWNERSHIP_OURS]: "Cellexia",
  [OWNERSHIP_FOREIGN]: "Another app",
  [OWNERSHIP_UNKNOWN]: "Unattributed",
};

/** Plain-English "what does this mean for me" per ownership value. */
const OWNERSHIP_HELP: Record<string, string> = {
  [OWNERSHIP_OURS]:
    "Managed by Cellexia — billed, emailed and reported on by this app.",
  [OWNERSHIP_FOREIGN]:
    "Created by another subscription app on this store. Cellexia never bills, emails, modifies or counts it.",
  [OWNERSHIP_UNKNOWN]:
    "Could not be attributed to any app (no selling plan on its lines). Treated as not ours, so never billed. Claim it if it is yours.",
};

// ── Loader ───────────────────────────────────────────────────────────────────

interface SubscriberRow {
  id: string;
  name: string;
  email: string;
  status: string;
  itemsSummary: string;
  intervalWeeks: number;
  nextBillingDate: string | null;
  ordersCount: number;
  lifetimeRevenue: string;
  churnRiskScore: number | null;
  /** OURS | FOREIGN | UNKNOWN — which app manages this subscription. */
  ownership: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);

  // When a child route (detail page) is matched, skip the heavy list query —
  // the parent component only renders <Outlet /> in that case.
  if (/^\/app\/subscribers\/.+/.test(url.pathname)) {
    return json({
      child: true as const,
      rows: [] as SubscriberRow[],
      hasNext: false,
      hasPrevious: false,
      nextCursor: null as string | null,
      prevCursor: null as string | null,
      sort: "newest",
      page: 0,
      q: "",
      statuses: [] as string[],
      ownerships: [] as string[],
      ownershipCounts: { ours: 0, foreign: 0, unknown: 0 },
    });
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  const statuses = (url.searchParams.get("status") ?? "")
    .split(",")
    .filter((s): s is (typeof STATUS_OPTIONS)[number] =>
      (STATUS_OPTIONS as readonly string[]).includes(s),
    );
  const sort = url.searchParams.get("sort") === "risk" ? "risk" : "newest";
  const cursorParam = url.searchParams.get("cursor");
  const dir = url.searchParams.get("dir") === "prev" ? "prev" : "next";
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10) || 0);

  const where: Prisma.SubscriptionContractWhereInput = { shopId: shop.id };
  if (q) {
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
    ];
  }
  if (statuses.length > 0) {
    where.status = { in: statuses };
  }
  // Ownership filter — the admin list is the ONE place non-OURS contracts are
  // visible, so it is also the one place they can be filtered for and claimed.
  const ownerships = (url.searchParams.get("ownership") ?? "")
    .split(",")
    .filter((v): v is (typeof OWNERSHIP_OPTIONS)[number] =>
      (OWNERSHIP_OPTIONS as readonly string[]).includes(v),
    );
  if (ownerships.length > 0) {
    where.ownership = { in: ownerships };
  }

  let contracts: Prisma.SubscriptionContractGetPayload<{
    include: { lines: true };
  }>[] = [];
  let hasNext = false;
  let hasPrevious = false;

  if (sort === "risk") {
    // Risk sort uses offset pagination (risk scores shift constantly; a
    // stable cursor buys nothing here).
    contracts = await prisma.subscriptionContract.findMany({
      where,
      include: { lines: true },
      orderBy: [{ churnRiskScore: "desc" }, { createdAt: "desc" }],
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    });
    hasNext = contracts.length > PAGE_SIZE;
    hasPrevious = page > 0;
    contracts = contracts.slice(0, PAGE_SIZE);
  } else {
    // Compound (createdAt, id) keyset cursor — see app/lib/pagination.server.ts
    // (same fix as the audit log: a bare-timestamp cursor skipped contracts
    // sharing the boundary millisecond, e.g. an import batch). The cursor
    // condition is ANDed alongside the filter where, never merged into it —
    // `where` already carries its own OR legs for the q search.
    const validCursor = decodeCreatedIdCursor(cursorParam);
    if (!validCursor) {
      contracts = await prisma.subscriptionContract.findMany({
        where,
        include: { lines: true },
        orderBy: [...CREATED_ID_DESC],
        take: PAGE_SIZE + 1,
      });
      hasNext = contracts.length > PAGE_SIZE;
      hasPrevious = false;
      contracts = contracts.slice(0, PAGE_SIZE);
    } else if (dir === "next") {
      contracts = await prisma.subscriptionContract.findMany({
        where: { AND: [where, createdIdAfter(validCursor)] },
        include: { lines: true },
        orderBy: [...CREATED_ID_DESC],
        take: PAGE_SIZE + 1,
      });
      hasNext = contracts.length > PAGE_SIZE;
      hasPrevious = true;
      contracts = contracts.slice(0, PAGE_SIZE);
    } else {
      contracts = await prisma.subscriptionContract.findMany({
        where: { AND: [where, createdIdBefore(validCursor)] },
        include: { lines: true },
        orderBy: [...CREATED_ID_ASC],
        take: PAGE_SIZE + 1,
      });
      hasPrevious = contracts.length > PAGE_SIZE;
      hasNext = true;
      contracts = contracts.slice(0, PAGE_SIZE).reverse();
    }
  }

  const rows: SubscriberRow[] = contracts.map((c) => {
    const name =
      [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;
    const visible = c.lines.slice(0, 2);
    const extra = c.lines.length - visible.length;
    const itemsSummary =
      visible.map((l) => `${l.quantity} × ${l.title}`).join(", ") +
      (extra > 0 ? ` +${extra} more` : "");
    return {
      id: c.id,
      name,
      email: c.email,
      status: c.status,
      itemsSummary: itemsSummary || "No items",
      intervalWeeks: c.intervalWeeks,
      nextBillingDate: c.nextBillingDate ? c.nextBillingDate.toISOString() : null,
      ordersCount: c.ordersCount,
      lifetimeRevenue: formatMoney(c.lifetimeRevenueCents, c.currencyCode),
      churnRiskScore: c.churnRiskScore,
      ownership: normalizeOwnership(c.ownership) ?? OWNERSHIP_UNKNOWN,
    };
  });

  // Shop-wide ownership tally for the "another app is here too" banner —
  // independent of the current page/filter so it never lies by omission.
  const ownershipGroups = await prisma.subscriptionContract.groupBy({
    by: ["ownership"],
    where: { shopId: shop.id, isDemo: false },
    _count: { _all: true },
  });
  const ownershipCounts = { ours: 0, foreign: 0, unknown: 0 };
  for (const group of ownershipGroups) {
    const n = group._count._all;
    if (group.ownership === OWNERSHIP_OURS) ownershipCounts.ours += n;
    else if (group.ownership === OWNERSHIP_FOREIGN) ownershipCounts.foreign += n;
    else ownershipCounts.unknown += n;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  return json({
    child: false as const,
    rows,
    hasNext,
    hasPrevious,
    nextCursor: last ? last.id : null, // unused; kept for shape stability
    prevCursor: first ? first.id : null,
    // Real cursors: compound "<createdAt ISO>~<id>" keyset strings (opaque
    // to the client, which just replays them into ?cursor=).
    nextCreatedAt: contracts.length
      ? encodeCreatedIdCursor(contracts[contracts.length - 1])
      : null,
    prevCreatedAt: contracts.length
      ? encodeCreatedIdCursor(contracts[0])
      : null,
    sort,
    page,
    q,
    statuses: statuses as string[],
    ownerships: ownerships as string[],
    ownershipCounts,
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
  processed?: number;
  failures?: number;
  csv?: string;
  filename?: string;
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

// csvEscape lives in ~/lib/csv.server: shared with the audit export so
// formula-injection neutralization can never drift between the two surfaces.

function parseIds(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

/**
 * Server-side OURS_ONLY + isDemo gate for the MUTATING bulk intents (bulkSkip,
 * bulkGrant). The list deliberately shows FOREIGN/UNKNOWN and demo rows — the
 * merchant must be able to see and claim them — and the service layer
 * (skipNextCycle / applyDiscountGrant via loadContractContext) checks shop
 * membership only. Without this filter, selecting "Managed by: Another app"
 * rows and clicking a bulk action (or a bare POST to this route) would
 * reschedule or discount another subscription app's contracts on Shopify.
 * Mirrors ownershipRefusal in the detail cockpit: non-owned rows are refused
 * and reported in the failures count, never touched. bulkClaim and exportCsv
 * intentionally keep the wider scope (claiming/exporting non-OURS rows is
 * their whole point).
 */
async function billableSelection(
  shopId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.subscriptionContract.findMany({
    where: { shopId, id: { in: ids }, ...OURS_ONLY, isDemo: false },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

const BULK_OWNERSHIP_REFUSAL =
  "Some selected subscriptions are not managed by Cellexia (or are demo rows), so they were skipped — Cellexia never bills, modifies or emails subscriptions owned by another app. Claim them first if they are yours.";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const ids = parseIds(formData.get("ids"));
  const opts = { source: "ADMIN" as const, actor };

  try {
    if (intent === "bulkSkip") {
      if (ids.length === 0) {
        return json<ActionResponse>({ ok: false, intent, error: "No subscribers selected" });
      }
      const allowed = await billableSelection(shop.id, ids);
      let processed = 0;
      let failures = 0;
      let refused = 0;
      let firstError: string | null = null;
      for (const id of ids) {
        if (!allowed.has(id)) {
          failures += 1;
          refused += 1;
          if (!firstError) firstError = BULK_OWNERSHIP_REFUSAL;
          console.warn("[admin] refused bulkSkip on non-owned/demo contract", id);
          continue;
        }
        try {
          await skipNextCycle(shop.domain, id, opts);
          processed += 1;
        } catch (err) {
          failures += 1;
          if (!firstError) firstError = errMessage(err);
          console.error("[admin] bulk skip failed", id, err);
        }
      }
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "bulk_skip_next_cycle",
          description: `Bulk skipped the next cycle for ${processed} of ${ids.length} selected subscribers`,
          contractIds: ids,
          processed,
          failures,
          refused,
        },
      });
      return json<ActionResponse>({
        ok: failures === 0,
        intent,
        processed,
        failures,
        message: `Skipped next cycle for ${processed} subscriber(s)${failures ? `, ${failures} failed` : ""}`,
        ...(failures && firstError ? { error: firstError } : {}),
      });
    }

    if (intent === "bulkGrant") {
      if (ids.length === 0) {
        return json<ActionResponse>({ ok: false, intent, error: "No subscribers selected" });
      }
      const percent = parseInt(String(formData.get("percent") ?? ""), 10);
      const cycles = parseInt(String(formData.get("cycles") ?? ""), 10);
      const reason = String(formData.get("reason") ?? "").trim() || null;
      if (!Number.isInteger(percent) || percent < 1 || percent > 90) {
        return json<ActionResponse>({ ok: false, intent, error: "Percent must be 1–90" });
      }
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > 12) {
        return json<ActionResponse>({ ok: false, intent, error: "Cycles must be 1–12" });
      }
      const allowed = await billableSelection(shop.id, ids);
      let processed = 0;
      let failures = 0;
      let refused = 0;
      let firstError: string | null = null;
      for (const id of ids) {
        if (!allowed.has(id)) {
          failures += 1;
          refused += 1;
          if (!firstError) firstError = BULK_OWNERSHIP_REFUSAL;
          console.warn("[admin] refused bulkGrant on non-owned/demo contract", id);
          continue;
        }
        try {
          await applyDiscountGrant(
            shop.domain,
            id,
            { type: "MANUAL", percent, cycles, grantedBy: actor, reason },
            opts,
          );
          processed += 1;
        } catch (err) {
          failures += 1;
          if (!firstError) firstError = errMessage(err);
          console.error("[admin] bulk discount grant failed", id, err);
        }
      }
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "bulk_discount_grant",
          description: `Bulk granted ${percent}% for ${cycles} cycle(s) to ${processed} of ${ids.length} selected subscribers`,
          contractIds: ids,
          percent,
          cycles,
          reason,
          processed,
          failures,
          refused,
        },
      });
      return json<ActionResponse>({
        ok: failures === 0,
        intent,
        processed,
        failures,
        message: `Granted ${percent}% for ${cycles} cycle(s) to ${processed} subscriber(s)${failures ? `, ${failures} failed` : ""}`,
        ...(failures && firstError ? { error: firstError } : {}),
      });
    }

    if (intent === "bulkClaim") {
      // Migration case: the merchant moved subscribers off the other app and
      // our import could not prove ownership from the contract lines (imported
      // contracts carry no selling plan). claimContracts flips UNKNOWN → OURS
      // only; FOREIGN rows — positively identified as another app's — are
      // never flipped here, because two apps must never bill one contract.
      if (ids.length === 0) {
        return json<ActionResponse>({
          ok: false,
          intent,
          error: "No subscribers selected",
        });
      }
      const { claimed, skipped } = await claimContracts(shop.id, ids, actor);
      // claimContracts logs one admin.action per claimed contract; this is the
      // batch-level record of who ran it and what it covered.
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "bulk_claim_contracts",
          description: `Claimed ${claimed} of ${ids.length} selected subscribers as managed by Cellexia`,
          contractIds: ids,
          claimed,
          skipped,
        },
      });
      return json<ActionResponse>({
        ok: claimed > 0,
        intent,
        processed: claimed,
        failures: skipped,
        message:
          claimed > 0
            ? `Claimed ${claimed} subscriber(s) as managed by Cellexia${skipped ? `; ${skipped} skipped (already claimed, or managed by another app)` : ""}`
            : "Nothing to claim — the selected subscribers are already managed by Cellexia, or belong to another app (cancel them there and re-import instead)",
        ...(claimed === 0
          ? {
              error:
                "Only unattributed subscriptions can be claimed. A subscription positively identified as another app's is never flipped — cancel it in that app and import it here.",
            }
          : {}),
      });
    }

    if (intent === "exportCsv") {
      if (ids.length === 0) {
        return json<ActionResponse>({ ok: false, intent, error: "No subscribers selected" });
      }
      const contracts = await prisma.subscriptionContract.findMany({
        where: { shopId: shop.id, id: { in: ids } },
        include: { lines: true },
        orderBy: { createdAt: "desc" },
      });
      const header = [
        "id",
        "email",
        "firstName",
        "lastName",
        "status",
        "intervalWeeks",
        "nextBillingDate",
        "ordersCount",
        "lifetimeRevenue",
        "currencyCode",
        "churnRiskScore",
        "ownership",
        "items",
        "createdAt",
      ];
      const lines = contracts.map((c) =>
        [
          c.id,
          c.email,
          c.firstName ?? "",
          c.lastName ?? "",
          c.status,
          c.intervalWeeks,
          c.nextBillingDate ? c.nextBillingDate.toISOString() : "",
          c.ordersCount,
          (c.lifetimeRevenueCents / 100).toFixed(2),
          c.currencyCode,
          c.churnRiskScore ?? "",
          c.ownership,
          c.lines.map((l) => `${l.quantity}x ${l.title}`).join("; "),
          c.createdAt.toISOString(),
        ]
          .map(csvEscape)
          .join(","),
      );
      const csv = [header.join(","), ...lines].join("\n");
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "subscribers_csv_export",
          description: `Exported ${contracts.length} subscribers to CSV`,
          contractIds: ids,
          rowCount: contracts.length,
        },
      });
      return json<ActionResponse>({
        ok: true,
        intent,
        csv,
        filename: `subscribers-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        message: `Exported ${contracts.length} subscribers`,
      });
    }

    return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
  } catch (err) {
    console.error("[admin] subscribers action failed", intent, err);
    return json<ActionResponse>({ ok: false, intent, error: errMessage(err) });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

function statusTone(
  status: string,
): "success" | "attention" | "critical" | "info" | undefined {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PAUSED":
      return "attention";
    case "FAILED":
      return "critical";
    case "EXPIRED":
      return "info";
    default:
      return undefined; // CANCELLED — neutral
  }
}

/**
 * Which app manages this subscription. OURS renders nothing — the default is
 * "Cellexia manages it", and a badge on every row would be noise. Anything
 * else is called out, because it changes what the app will and will not do.
 */
function OwnershipBadge({ ownership }: { ownership: string }) {
  if (ownership === OWNERSHIP_OURS) return null;
  return (
    <Tooltip content={OWNERSHIP_HELP[ownership] ?? ownership}>
      <Badge tone={ownership === OWNERSHIP_FOREIGN ? "warning" : "attention"}>
        {OWNERSHIP_LABELS[ownership] ?? ownership}
      </Badge>
    </Tooltip>
  );
}

function RiskDot({ score }: { score: number | null }) {
  const s = score ?? 0;
  const color = s >= 0.66 ? "#d72c0d" : s >= 0.33 ? "#b98900" : "#29845a";
  return (
    <InlineStack gap="100" blockAlign="center">
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: color,
        }}
      />
      <Text as="span" variant="bodySm" tone="subdued">
        {score == null ? "–" : s.toFixed(2)}
      </Text>
    </InlineStack>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function SubscribersPage() {
  const params = useParams();
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const bulkFetcher = useFetcher<typeof action>();
  const exportFetcher = useFetcher<typeof action>();

  const [queryValue, setQueryValue] = useState(data.child ? "" : data.q);
  const [grantModalOpen, setGrantModalOpen] = useState(false);
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const [grantPercent, setGrantPercent] = useState("10");
  const [grantCycles, setGrantCycles] = useState("2");
  const [grantReason, setGrantReason] = useState("");
  const downloadedRef = useRef<string | null>(null);

  const rows = data.child ? [] : data.rows;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(rows);

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Debounced search.
  useEffect(() => {
    if (data.child) return;
    const handle = setTimeout(() => {
      if (queryValue !== data.q) {
        setParam({ q: queryValue || null, cursor: null, dir: null, page: null });
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [queryValue, data, setParam]);

  // Clear selection after a successful bulk op.
  useEffect(() => {
    if (bulkFetcher.state === "idle" && bulkFetcher.data?.ok) {
      clearSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFetcher.state, bulkFetcher.data]);

  // Trigger CSV download when the export action returns.
  useEffect(() => {
    const d = exportFetcher.data;
    if (
      exportFetcher.state === "idle" &&
      d?.ok &&
      d.csv &&
      d.filename &&
      downloadedRef.current !== d.filename
    ) {
      downloadedRef.current = d.filename;
      downloadTextFile(d.csv, d.filename);
    }
  }, [exportFetcher.state, exportFetcher.data]);

  if (params.id || data.child) {
    return <Outlet />;
  }

  const statuses = data.statuses;
  const ownerships = data.ownerships;
  const ownershipCounts = data.ownershipCounts;
  const sort = data.sort;
  const otherAppContracts =
    ownershipCounts.foreign + ownershipCounts.unknown;

  const appliedFilters = [
    ...(statuses.length > 0
      ? [
          {
            key: "status",
            label: `Status: ${statuses.join(", ")}`,
            onRemove: () =>
              setParam({ status: null, cursor: null, dir: null, page: null }),
          },
        ]
      : []),
    ...(ownerships.length > 0
      ? [
          {
            key: "ownership",
            label: `Managed by: ${ownerships
              .map((o) => OWNERSHIP_LABELS[o] ?? o)
              .join(", ")}`,
            onRemove: () =>
              setParam({ ownership: null, cursor: null, dir: null, page: null }),
          },
        ]
      : []),
  ];

  const filters = [
    {
      key: "status",
      label: "Status",
      shortcut: true,
      pinned: true,
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          allowMultiple
          choices={STATUS_OPTIONS.map((s) => ({ label: s, value: s }))}
          selected={statuses}
          onChange={(selected) =>
            setParam({
              status: selected.length ? selected.join(",") : null,
              cursor: null,
              dir: null,
              page: null,
            })
          }
        />
      ),
    },
    {
      key: "ownership",
      label: "Managed by",
      shortcut: true,
      pinned: otherAppContracts > 0,
      filter: (
        <ChoiceList
          title="Managed by"
          titleHidden
          allowMultiple
          choices={OWNERSHIP_OPTIONS.map((o) => ({
            label: OWNERSHIP_LABELS[o] ?? o,
            value: o,
            helpText: OWNERSHIP_HELP[o],
          }))}
          selected={ownerships}
          onChange={(selected) =>
            setParam({
              ownership: selected.length ? selected.join(",") : null,
              cursor: null,
              dir: null,
              page: null,
            })
          }
        />
      ),
    },
  ];

  const submitBulk = (intent: string, extra: Record<string, string> = {}) => {
    bulkFetcher.submit(
      { intent, ids: JSON.stringify(selectedResources), ...extra },
      { method: "post" },
    );
  };

  const promotedBulkActions = [
    {
      content: "Skip next cycle",
      onAction: () => submitBulk("bulkSkip"),
    },
    {
      content: "Grant discount",
      onAction: () => setGrantModalOpen(true),
    },
    {
      content: "Export CSV",
      onAction: () =>
        exportFetcher.submit(
          { intent: "exportCsv", ids: JSON.stringify(selectedResources) },
          { method: "post" },
        ),
    },
    // Only offered when there is something claimable on the shop at all —
    // on a single-app store this action would be meaningless noise.
    ...(ownershipCounts.unknown > 0
      ? [
          {
            content: "Claim as Cellexia's",
            onAction: () => setClaimModalOpen(true),
          },
        ]
      : []),
  ];

  const busy = bulkFetcher.state !== "idle";
  const lastResult = bulkFetcher.data ?? exportFetcher.data;

  return (
    <Page title="Subscribers" fullWidth>
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

        {/* Another subscription app shares this store. Stated once, at the top
            of the only list that shows its contracts, so the ownership badges
            below need no explaining. */}
        {otherAppContracts > 0 ? (
          <Banner
            tone="warning"
            title="Some subscriptions on this store are not managed by Cellexia"
          >
            <BlockStack gap="200">
              <p>
                {ownershipCounts.foreign > 0
                  ? `${ownershipCounts.foreign} ${ownershipCounts.foreign === 1 ? "subscription was" : "subscriptions were"} created by another subscription app`
                  : ""}
                {ownershipCounts.foreign > 0 && ownershipCounts.unknown > 0
                  ? ", and "
                  : ""}
                {ownershipCounts.unknown > 0
                  ? `${ownershipCounts.unknown} ${ownershipCounts.unknown === 1 ? "subscription" : "subscriptions"} could not be attributed to any app`
                  : ""}
                . Cellexia never bills, emails, modifies or counts them, and
                they are hidden from the customer portal.
              </p>
              {ownershipCounts.unknown > 0 ? (
                <p>
                  If unattributed subscriptions are in fact yours (imported from
                  another app after cancelling them there), select them and use
                  the “Claim as Cellexia's” bulk action.
                </p>
              ) : null}
            </BlockStack>
          </Banner>
        ) : null}

        <Card padding="0">
          <Box padding="300">
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Box width="100%">
                <Filters
                  queryValue={queryValue}
                  queryPlaceholder="Search by email or name"
                  filters={filters}
                  appliedFilters={appliedFilters}
                  onQueryChange={setQueryValue}
                  onQueryClear={() => {
                    setQueryValue("");
                    setParam({ q: null, cursor: null, dir: null, page: null });
                  }}
                  onClearAll={() => {
                    setQueryValue("");
                    setParam({
                      q: null,
                      status: null,
                      cursor: null,
                      dir: null,
                      page: null,
                    });
                  }}
                />
              </Box>
              <Box minWidth="180px">
                <Select
                  label="Sort"
                  labelHidden
                  options={[
                    { label: "Newest first", value: "newest" },
                    { label: "Highest churn risk", value: "risk" },
                  ]}
                  value={sort}
                  onChange={(value) =>
                    setParam({
                      sort: value === "risk" ? "risk" : null,
                      cursor: null,
                      dir: null,
                      page: null,
                    })
                  }
                />
              </Box>
            </InlineStack>
          </Box>

          <IndexTable
            resourceName={{ singular: "subscriber", plural: "subscribers" }}
            itemCount={rows.length}
            selectedItemsCount={
              allResourcesSelected ? "All" : selectedResources.length
            }
            onSelectionChange={handleSelectionChange}
            promotedBulkActions={promotedBulkActions}
            loading={busy}
            headings={[
              { title: "Customer" },
              { title: "Status" },
              { title: "Items" },
              { title: "Interval" },
              { title: "Next order" },
              { title: "Orders" },
              { title: "Lifetime revenue" },
              { title: "Risk" },
            ]}
          >
            {rows.map((row, index) => (
              <IndexTable.Row
                id={row.id}
                key={row.id}
                position={index}
                selected={selectedResources.includes(row.id)}
                onClick={() => navigate(`/app/subscribers/${row.id}`)}
              >
                <IndexTable.Cell>
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {row.name}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.email}
                    </Text>
                  </BlockStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack gap="150" blockAlign="center" wrap={false}>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                    <OwnershipBadge ownership={row.ownership} />
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm">
                    {row.itemsSummary}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>Every {row.intervalWeeks} wk</IndexTable.Cell>
                <IndexTable.Cell>{formatDate(row.nextBillingDate)}</IndexTable.Cell>
                <IndexTable.Cell>{row.ordersCount}</IndexTable.Cell>
                <IndexTable.Cell>{row.lifetimeRevenue}</IndexTable.Cell>
                <IndexTable.Cell>
                  <RiskDot score={row.churnRiskScore} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>

          <Box padding="300">
            <InlineStack align="center">
              <Pagination
                hasPrevious={data.hasPrevious}
                hasNext={data.hasNext}
                onPrevious={() => {
                  if (sort === "risk") {
                    setParam({ page: String(Math.max(0, data.page - 1)) });
                  } else {
                    setParam({ cursor: data.prevCreatedAt, dir: "prev" });
                  }
                }}
                onNext={() => {
                  if (sort === "risk") {
                    setParam({ page: String(data.page + 1) });
                  } else {
                    setParam({ cursor: data.nextCreatedAt, dir: "next" });
                  }
                }}
              />
            </InlineStack>
          </Box>
        </Card>
      </BlockStack>

      <Modal
        open={grantModalOpen}
        onClose={() => setGrantModalOpen(false)}
        title={`Grant discount to ${selectedResources.length} subscriber(s)`}
        primaryAction={{
          content: "Grant discount",
          loading: busy,
          onAction: () => {
            submitBulk("bulkGrant", {
              percent: grantPercent,
              cycles: grantCycles,
              reason: grantReason,
            });
            setGrantModalOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setGrantModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Applies a temporary percentage discount for the next N billing
              cycles via per-cycle contract edits — never discount codes.
            </Text>
            <TextField
              label="Discount percent"
              type="number"
              value={grantPercent}
              onChange={setGrantPercent}
              autoComplete="off"
              suffix="%"
              min={1}
              max={90}
            />
            <TextField
              label="Number of cycles"
              type="number"
              value={grantCycles}
              onChange={setGrantCycles}
              autoComplete="off"
              min={1}
              max={12}
            />
            <TextField
              label="Reason (internal)"
              value={grantReason}
              onChange={setGrantReason}
              autoComplete="off"
              placeholder="e.g. service recovery, VIP"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={claimModalOpen}
        onClose={() => setClaimModalOpen(false)}
        title={`Claim ${selectedResources.length} subscriber(s) as Cellexia's?`}
        primaryAction={{
          content: "Claim as Cellexia's",
          loading: busy,
          onAction: () => {
            submitBulk("bulkClaim");
            setClaimModalOpen(false);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setClaimModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              Claiming tells Cellexia that these subscriptions are its to bill,
              email and report on. Use it after migrating subscribers from
              another subscription app.
            </Text>
            <Banner tone="critical">
              <BlockStack gap="200">
                <p>
                  <strong>
                    Cancel these subscriptions in the other app first.
                  </strong>{" "}
                  If both apps consider a subscription theirs, the customer is
                  charged twice.
                </p>
                <p>
                  Only unattributed subscriptions can be claimed. Subscriptions
                  positively identified as another app's are skipped — cancel
                  them there and import them here instead.
                </p>
              </BlockStack>
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
