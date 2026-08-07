import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { formatMoney } from "~/lib/money";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import {
  OPEN_CASE_STATES,
  categorizeDeclineCode,
  transitionOpenCase,
} from "~/lib/dunning/index.server";
import { sendNotification } from "~/lib/notifications/index.server";
import { cancelContract } from "~/lib/contracts/index.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Admin — Dunning queue. Failed-payment cases by state, with human decline
 * descriptions, ladder progress and per-case actions (retry now, resend the
 * card-fix link, cancel the contract). Summary cards show open volume and
 * 30-day recovery performance.
 */

const TABS = [
  { id: "retrying", content: "Retrying" },
  { id: "awaiting", content: "Awaiting customer" },
  { id: "threeds", content: "Awaiting 3DS" },
  { id: "exhausted", content: "Exhausted" },
  { id: "recovered", content: "Recovered (30d)" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab") as TabId | null;
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "retrying";

  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  let where: Prisma.DunningCaseWhereInput;
  switch (tab) {
    case "awaiting":
      where = { state: "AWAITING_CUSTOMER" };
      break;
    case "threeds":
      where = { state: "AWAITING_3DS" };
      break;
    case "exhausted":
      where = { state: "EXHAUSTED" };
      break;
    case "recovered":
      where = { state: "RECOVERED", resolvedAt: { gte: thirtyDaysAgo } };
      break;
    default:
      where = { state: { in: ["OPEN", "RETRYING"] } };
  }
  // Standing rule: only our own, non-demo contracts. Legacy cases on foreign/
  // demo contracts would otherwise sit in the queue forever — the sweep
  // deliberately skips them, so "Retry now" on one would never fire.
  where.contract = { shopId: shop.id, ...OURS_ONLY, isDemo: false };

  const cases = await prisma.dunningCase.findMany({
    where,
    include: { contract: { include: { lines: true } } },
    orderBy:
      tab === "exhausted" || tab === "recovered"
        ? { resolvedAt: "desc" }
        : { openedAt: "asc" },
    take: 100,
  });

  // Amounts: trigger attempt when it carries one, else line-sum estimate.
  const attemptIds = cases
    .map((k) => k.triggerAttemptId)
    .filter((id): id is string => id != null);
  const attempts = attemptIds.length
    ? await prisma.billingAttempt.findMany({ where: { id: { in: attemptIds } } })
    : [];
  const attemptById = new Map(attempts.map((a) => [a.id, a]));

  const rows = cases.map((k) => {
    const contract = k.contract;
    const attempt = k.triggerAttemptId
      ? attemptById.get(k.triggerAttemptId)
      : undefined;
    const estimateCents =
      contract.lines.reduce(
        (sum, l) => sum + l.currentPriceCents * l.quantity,
        0,
      ) + contract.deliveryPriceCents;
    const amountCents = attempt?.amountCents ?? (contract.lines.length ? estimateCents : null);
    return {
      id: k.id,
      contractId: contract.id,
      customerName:
        [contract.firstName, contract.lastName].filter(Boolean).join(" ") ||
        contract.email,
      email: contract.email,
      amount:
        amountCents != null
          ? formatMoney(amountCents, attempt?.currencyCode ?? contract.currencyCode)
          : "–",
      declineCode: k.declineCode,
      declineHuman: categorizeDeclineCode(k.declineCode).description,
      state: k.state,
      openedAt: k.openedAt.toISOString(),
      resolvedAt: k.resolvedAt?.toISOString() ?? null,
      ladderStep: k.ladderStep,
      nextRetryAt: k.nextRetryAt?.toISOString() ?? null,
      emailsSent: k.emailsSent,
      smsSent: k.smsSent,
      recovered:
        k.recoveredCents != null
          ? formatMoney(k.recoveredCents, contract.currencyCode)
          : null,
    };
  });

  // Summary cards (same ownership/demo scoping as the queue).
  const summaryContract = { shopId: shop.id, ...OURS_ONLY, isDemo: false };
  const openCases = await prisma.dunningCase.count({
    where: { state: { in: OPEN_CASE_STATES }, contract: summaryContract },
  });
  const recovered30 = await prisma.dunningCase.findMany({
    where: {
      state: "RECOVERED",
      resolvedAt: { gte: thirtyDaysAgo },
      contract: summaryContract,
    },
    select: { recoveredCents: true },
  });
  const exhausted30 = await prisma.dunningCase.count({
    where: {
      state: "EXHAUSTED",
      resolvedAt: { gte: thirtyDaysAgo },
      contract: summaryContract,
    },
  });
  // Cancelled-from-dunning cases are churn outcomes too — excluding them
  // would flatter the recovery rate. SUPERSEDED closures (an old cycle's
  // case replaced by a newer cycle's) are not outcomes and stay out.
  const cancelled30 = await prisma.dunningCase.count({
    where: {
      state: "CANCELLED",
      resolution: "CANCELLED",
      resolvedAt: { gte: thirtyDaysAgo },
      contract: summaryContract,
    },
  });
  const recoveredCount = recovered30.length;
  const resolvedTotal = recoveredCount + exhausted30 + cancelled30;
  const recoveryRatePct =
    resolvedTotal > 0 ? Math.round((recoveredCount / resolvedTotal) * 100) : null;
  const recoveredRevenueCents = recovered30.reduce(
    (sum, k) => sum + (k.recoveredCents ?? 0),
    0,
  );

  return json({
    tab,
    rows,
    tz: shop.ianaTimezone,
    summary: {
      openCases,
      recoveryRatePct,
      recoveredCount,
      resolvedTotal,
      recoveredRevenue: formatMoney(recoveredRevenueCents, shop.currencyCode),
    },
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const caseId = String(formData.get("caseId") ?? "");

  const kase = await prisma.dunningCase.findUnique({
    where: { id: caseId },
    include: { contract: { include: { lines: true } } },
  });
  if (!kase || kase.contract.shopId !== shop.id) {
    return json<ActionResponse>({ ok: false, intent, error: "Dunning case not found" });
  }
  // Same gate as the loader: acting on a foreign/demo contract's case would
  // retry another app's charge or email a fixture address.
  if (!isBillableOwnership(kase.contract.ownership) || kase.contract.isDemo) {
    return json<ActionResponse>({
      ok: false,
      intent,
      error: "This contract is not managed by Cellexia Subscriptions",
    });
  }
  const contract = kase.contract;

  const adminLog = async (
    description: string,
    payload: Record<string, unknown> = {},
  ) => {
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: { description, dunningCaseId: kase.id, ...payload },
    });
  };

  try {
    switch (intent) {
      case "retryNow": {
        const now = new Date();
        // Guarded + atomic (transitionOpenCase): only an OPEN-state case can
        // be scheduled. The queue row may be minutes stale — if the recovery
        // webhook already resolved this case, flipping it back to RETRYING
        // would make the sweep re-bill the already-billed cycle and walk the
        // paid customer toward exhaustion/cancellation.
        const claimed = await transitionOpenCase(
          kase.id,
          contract.id,
          "RETRYING",
          now,
        );
        if (!claimed) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "This dunning case is already resolved — refresh the page",
          });
        }
        await logEvent({
          shopId: shop.id,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "dunning.retry_scheduled",
          source: "ADMIN",
          actor,
          payload: {
            dunningCaseId: kase.id,
            trigger: "admin_retry_now",
            immediate: true,
            nextRetryAt: now.toISOString(),
          },
        });
        await adminLog("Scheduled an immediate dunning retry from the queue", {
          action: "dunning_retry_now",
        });
        return json<ActionResponse>({
          ok: true,
          intent,
          message: "Retry scheduled — the next sweep fires it within a minute",
        });
      }

      case "sendCardLink": {
        // A resolved case is not re-mailable: the stale-page click after a
        // webhook recovery would send "your payment failed" to a customer
        // whose payment just succeeded.
        if (!OPEN_CASE_STATES.includes(kase.state)) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "This dunning case is already resolved — refresh the page",
          });
        }
        const info = categorizeDeclineCode(kase.declineCode);
        let ctaUrl: string | null = null;
        try {
          ctaUrl = await buildMagicUrl({
            action: "UPDATE_CARD",
            contractId: contract.id,
            customerId: contract.customerId,
            email: contract.email,
            ttlSeconds: 14 * 24 * 3600,
            maxUses: 5,
            createdVia: "ADMIN",
          });
        } catch (err) {
          console.error("[admin] update-card magic link failed", contract.id, err);
        }
        const estimateCents =
          contract.lines.reduce(
            (sum, l) => sum + l.currentPriceCents * l.quantity,
            0,
          ) + contract.deliveryPriceCents;
        const result = await sendNotification({
          shopId: shop.id,
          contractId: contract.id,
          template: "payment_failed_1",
          vars: {
            amount: contract.lines.length
              ? formatMoney(estimateCents, contract.currencyCode, contract.locale)
              : "",
            card_last4: contract.cardLast4 ?? "",
            decline_human: info.description,
            resent_by_admin: true,
            ...(ctaUrl ? { cta_url: ctaUrl } : {}),
          },
        });
        if (result.status === "FAILED") {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "Notification could not be sent (see notification log)",
          });
        }
        await prisma.dunningCase.update({
          where: { id: kase.id },
          data: { emailsSent: { increment: 1 }, lastNotifiedAt: new Date() },
        });
        await adminLog("Re-sent the fix-payment email with a fresh card-update link", {
          action: "dunning_resend_card_link",
          notificationStatus: result.status,
        });
        return json<ActionResponse>({
          ok: true,
          intent,
          message: "Card-fix email sent again",
        });
      }

      case "cancelContract": {
        // Same stale-page guard: once the case is resolved (customer paid),
        // "Cancel" here would cancel an ACTIVE, fully-paid contract with
        // reason PAYMENT_FAILED and fire win-back at a paying customer.
        if (!OPEN_CASE_STATES.includes(kase.state)) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "This dunning case is already resolved — refresh the page",
          });
        }
        await cancelContract(shop.domain, contract.id, "PAYMENT_FAILED", {
          source: "ADMIN",
          actor,
          cancelSource: "ADMIN",
        });
        // Conditional close: if a recovery raced the cancel, the case is no
        // longer open and there is nothing left to overwrite — the contract
        // cancel above already happened under the admin's explicit click.
        await transitionOpenCase(kase.id, contract.id, "CANCELLED");
        await adminLog(
          "Cancelled the contract from the dunning queue (reason PAYMENT_FAILED)",
          { action: "dunning_cancel_contract" },
        );
        return json<ActionResponse>({
          ok: true,
          intent,
          message: "Contract cancelled and case closed",
        });
      }

      default:
        return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
    }
  } catch (err) {
    console.error("[admin] dunning action failed", intent, caseId, err);
    return json<ActionResponse>({ ok: false, intent, error: errMessage(err) });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

function formatDate(iso: string | null, tz?: string): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Shop-timezone date + time — retry moments are times, not just days, and
 * rendering them in the admin browser's timezone shifts the displayed day. */
function formatDateTime(iso: string | null, tz: string): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return formatDate(iso);
}

function stateTone(
  state: string,
): "success" | "attention" | "critical" | "warning" | "info" | undefined {
  switch (state) {
    case "RECOVERED":
      return "success";
    case "RETRYING":
    case "OPEN":
      return "attention";
    case "AWAITING_CUSTOMER":
      return "warning";
    case "AWAITING_3DS":
      return "info";
    case "EXHAUSTED":
      return "critical";
    default:
      return undefined;
  }
}

export default function DunningPage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [cancelCaseId, setCancelCaseId] = useState<string | null>(null);

  const busy = fetcher.state !== "idle";
  const selectedTabIndex = Math.max(
    0,
    TABS.findIndex((t) => t.id === data.tab),
  );

  const submit = (intent: string, caseId: string) => {
    fetcher.submit({ intent, caseId }, { method: "post" });
  };

  const lastResult = fetcher.data;

  return (
    <Page title="Dunning" subtitle="Failed payments and recovery" fullWidth>
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

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <Card>
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm" tone="subdued">
                Open cases
              </Text>
              <Text as="p" variant="headingLg">
                {String(data.summary.openCases)}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm" tone="subdued">
                Recovery rate (30d)
              </Text>
              <Text as="p" variant="headingLg">
                {data.summary.recoveryRatePct != null
                  ? `${data.summary.recoveryRatePct}%`
                  : "–"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {`${data.summary.recoveredCount} of ${data.summary.resolvedTotal} resolved cases (incl. exhausted + cancelled)`}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm" tone="subdued">
                Recovered revenue (30d)
              </Text>
              <Text as="p" variant="headingLg">
                {data.summary.recoveredRevenue}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({ id: t.id, content: t.content }))}
            selected={selectedTabIndex}
            onSelect={(index) => {
              const next = new URLSearchParams();
              const tab = TABS[index];
              if (tab && tab.id !== "retrying") next.set("tab", tab.id);
              setSearchParams(next, { replace: true });
            }}
          />
          <IndexTable
            resourceName={{ singular: "case", plural: "cases" }}
            itemCount={data.rows.length}
            selectable={false}
            loading={busy}
            headings={[
              { title: "Customer" },
              { title: "Amount" },
              { title: "Decline" },
              { title: "Opened" },
              { title: "Step" },
              { title: "Next retry" },
              { title: "Emails / SMS" },
              { title: "Actions" },
            ]}
          >
            {data.rows.map((row, index) => (
              <IndexTable.Row id={row.id} key={row.id} position={index}>
                <IndexTable.Cell>
                  <BlockStack gap="050">
                    <Button
                      variant="plain"
                      onClick={() => navigate(`/app/subscribers/${row.contractId}`)}
                    >
                      {row.customerName}
                    </Button>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.email}
                    </Text>
                  </BlockStack>
                </IndexTable.Cell>
                <IndexTable.Cell>{row.amount}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Box maxWidth="280px">
                    <BlockStack gap="050">
                      <InlineStack gap="100">
                        <Badge tone={stateTone(row.state)}>{row.state}</Badge>
                        {row.declineCode ? (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {row.declineCode}
                          </Text>
                        ) : null}
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued" truncate>
                        {row.declineHuman}
                      </Text>
                    </BlockStack>
                  </Box>
                </IndexTable.Cell>
                <IndexTable.Cell>{timeAgo(row.openedAt)}</IndexTable.Cell>
                <IndexTable.Cell>{row.ladderStep}</IndexTable.Cell>
                <IndexTable.Cell>
                  {row.state === "RECOVERED" && row.recovered
                    ? `Recovered ${row.recovered}`
                    : formatDateTime(row.nextRetryAt, data.tz)}
                </IndexTable.Cell>
                <IndexTable.Cell>{`${row.emailsSent} / ${row.smsSent}`}</IndexTable.Cell>
                <IndexTable.Cell>
                  {row.state === "RECOVERED" || row.state === "EXHAUSTED" ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.resolvedAt ? `Closed ${timeAgo(row.resolvedAt)}` : "Closed"}
                    </Text>
                  ) : (
                    <ButtonGroup>
                      <Button
                        size="slim"
                        disabled={busy}
                        onClick={() => submit("retryNow", row.id)}
                      >
                        Retry now
                      </Button>
                      <Button
                        size="slim"
                        disabled={busy}
                        onClick={() => submit("sendCardLink", row.id)}
                      >
                        Send card link
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        disabled={busy}
                        onClick={() => setCancelCaseId(row.id)}
                      >
                        Cancel contract
                      </Button>
                    </ButtonGroup>
                  )}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>

      <Modal
        open={cancelCaseId != null}
        onClose={() => setCancelCaseId(null)}
        title="Cancel contract"
        primaryAction={{
          content: "Cancel contract",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (cancelCaseId) submit("cancelContract", cancelCaseId);
            setCancelCaseId(null);
          },
        }}
        secondaryActions={[{ content: "Keep contract", onAction: () => setCancelCaseId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Cancels the subscription contract (reason PAYMENT_FAILED) and
            closes this dunning case. Win-back messaging will be scheduled
            automatically.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
