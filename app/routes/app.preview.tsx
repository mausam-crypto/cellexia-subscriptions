import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import type { FetcherWithComponents } from "@remix-run/react";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import {
  buildStorefrontPreviewUrl,
  getLaunchState,
  getOverdueContracts,
  goLive,
  markChecklist,
  revertToSetup,
} from "~/lib/launch/launch.server";
import { createDemoContract } from "~/lib/portal/demo.server";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import { getProducts } from "~/lib/graphql/index.server";

/**
 * Admin — Preview & launch.
 *
 * The install-dark control room: launch status + go-live checklist, storefront
 * preview links (signed ?cx_preview token that reveals the buy-box widget only
 * in the admin's own browser session) and portal preview sessions (full portal
 * UI, every mutating action intercepted). Going live flips the launch setting
 * and the cellexia.launch_status metafield; overdue renewals can be staggered
 * over the next 3 days so the flip never triggers a burst of charges.
 */

const SCHEDULER_HEALTHY_WINDOW_MS = 10 * 60 * 1000;
const PORTAL_PREVIEW_TTL_SECONDS = 3600;
const SEARCH_MIN_CHARS = 2;

// ── Shared view types ────────────────────────────────────────────────────────

interface ProductOption {
  id: string;
  title: string;
  handle: string;
}

interface SubscriberMatch {
  email: string;
  name: string | null;
  status: string;
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  /** Preview URL to open in a new tab (preview-* intents). */
  url?: string;
}

const stringArraySchema = z.array(z.string());

function parseJsonStringArray(value: unknown): string[] {
  const parsed = stringArraySchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();

  const now = new Date();
  const [launch, syncedConfigs, recentJobRun, overdue, demoContract, matches] =
    await Promise.all([
      getLaunchState(shop.id),
      prisma.sellingPlanConfig.findMany({
        where: { shopId: shop.id, syncStatus: "SYNCED" },
        select: { productIds: true },
      }),
      prisma.jobRun.findFirst({
        where: {
          startedAt: { gte: new Date(now.getTime() - SCHEDULER_HEALTHY_WINDOW_MS) },
        },
        select: { id: true },
      }),
      getOverdueContracts(shop.id),
      prisma.subscriptionContract.findFirst({
        where: { shopId: shop.id, isDemo: true },
        select: { id: true },
      }),
      query.length >= SEARCH_MIN_CHARS
        ? prisma.subscriptionContract.findMany({
            where: {
              shopId: shop.id,
              isDemo: false,
              email: { contains: query, mode: "insensitive" },
            },
            orderBy: { createdAt: "desc" },
            distinct: ["email"],
            take: 8,
            select: { email: true, firstName: true, lastName: true, status: true },
          })
        : Promise.resolve([]),
    ]);

  // Product titles/handles for the storefront preview picker. Skipped for
  // subscriber-search fetcher requests (?q=) so typing never hits Shopify; a
  // lookup failure must never break the page (failures are contained).
  let products: ProductOption[] = [];
  if (query.length < SEARCH_MIN_CHARS) {
    const productIds = [
      ...new Set(syncedConfigs.flatMap((c) => parseJsonStringArray(c.productIds))),
    ];
    try {
      products = (await getProducts(admin, productIds)).flatMap((p) =>
        p.handle ? [{ id: p.id, title: p.title, handle: p.handle }] : [],
      );
    } catch (err) {
      console.error("[preview] product lookup failed", err);
    }
  }

  const subscriberMatches: SubscriberMatch[] = matches.map((m) => ({
    email: m.email,
    name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
    status: m.status,
  }));

  return json({
    storeDomain: shop.primaryDomain ?? shop.domain,
    launch,
    checklist: {
      plansSynced: syncedConfigs.length > 0,
      schedulerHealthy: recentJobRun != null,
      klaviyoKeyPresent: isKlaviyoConfigured(),
    },
    overdueCount: overdue.length,
    overdueSample: overdue.slice(0, 5).map((c) => ({
      email: c.email,
      nextBillingDate: c.nextBillingDate.toISOString().slice(0, 10),
    })),
    hasDemoContract: demoContract != null,
    products,
    subscriberMatches,
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

async function markPreviewed(
  shopId: string,
  field: "previewedStorefront" | "previewedPortal",
  actor: string,
): Promise<void> {
  const before = await getLaunchState(shopId);
  if (!before[field]) {
    await markChecklist(shopId, field, true, actor);
  }
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

  if (intent === "mark-checklist") {
    const field = String(formData.get("field") ?? "");
    const value = String(formData.get("value") ?? "") === "true";
    if (field !== "confirmedThemeBlock" && field !== "confirmedKlaviyo") {
      return json<ActionData>(
        { intent, ok: false, toast: "Unknown checklist item" },
        { status: 400 },
      );
    }
    const before = await getLaunchState(shop.id);
    if (before[field] !== value) {
      await markChecklist(shop.id, field, value, actor);
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: { action: "launch_checklist_updated", field, value },
      });
    }
    return json<ActionData>({ intent, ok: true });
  }

  if (intent === "go-live") {
    const shiftOverdue = String(formData.get("shiftOverdue") ?? "") === "true";
    try {
      // goLive logs its own admin.action event — don't double-log here.
      const { shifted } = await goLive(shop.domain, { shiftOverdue, actor });
      return json<ActionData>({
        intent,
        ok: true,
        toast:
          shifted > 0
            ? `You're live — ${shifted} overdue renewal${shifted === 1 ? "" : "s"} spread over the next 3 days`
            : "You're live — the subscription experience is now visible to store visitors",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Go-live failed: ${message}`,
      });
    }
  }

  if (intent === "revert-setup") {
    try {
      // revertToSetup logs its own admin.action event — don't double-log here.
      await revertToSetup(shop.domain, actor);
      return json<ActionData>({
        intent,
        ok: true,
        toast: "Back in setup mode — the live store is dark again",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Revert failed: ${message}`,
      });
    }
  }

  if (intent === "preview-storefront") {
    const productHandle = String(formData.get("productHandle") ?? "").trim();
    try {
      const url = await buildStorefrontPreviewUrl(
        shop.id,
        productHandle || undefined,
      );
      await markPreviewed(shop.id, "previewedStorefront", actor);
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "storefront_preview_created",
          productHandle: productHandle || null,
          checklistPreviewedStorefront: true,
        },
      });
      return json<ActionData>({ intent, ok: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Could not build the preview link: ${message}`,
      });
    }
  }

  if (intent === "preview-portal-demo") {
    try {
      let contract = await prisma.subscriptionContract.findFirst({
        where: { shopId: shop.id, isDemo: true },
        orderBy: { createdAt: "desc" },
      });
      if (!contract) {
        const { contractId } = await createDemoContract(shop.id);
        contract = await prisma.subscriptionContract.findUniqueOrThrow({
          where: { id: contractId },
        });
      }
      const url = await buildMagicUrl({
        action: "LOGIN",
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        params: { preview: true },
        ttlSeconds: PORTAL_PREVIEW_TTL_SECONDS,
        createdVia: "ADMIN",
      });
      await markPreviewed(shop.id, "previewedPortal", actor);
      await logEvent({
        shopId: shop.id,
        contractId: contract.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "portal_preview_created",
          mode: "demo",
          contractId: contract.id,
          checklistPreviewedPortal: true,
        },
      });
      return json<ActionData>({ intent, ok: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Could not start the demo preview: ${message}`,
      });
    }
  }

  if (intent === "preview-portal-subscriber") {
    const email = String(formData.get("email") ?? "").trim();
    if (!email) {
      return json<ActionData>(
        { intent, ok: false, toast: "Pick a subscriber email first" },
        { status: 422 },
      );
    }
    const contract = await prisma.subscriptionContract.findFirst({
      where: {
        shopId: shop.id,
        isDemo: false,
        email: { equals: email, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!contract) {
      return json<ActionData>(
        { intent, ok: false, toast: "No subscription found for that email" },
        { status: 404 },
      );
    }
    try {
      const url = await buildMagicUrl({
        action: "LOGIN",
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        params: { preview: true },
        ttlSeconds: PORTAL_PREVIEW_TTL_SECONDS,
        createdVia: "ADMIN",
      });
      await markPreviewed(shop.id, "previewedPortal", actor);
      await logEvent({
        shopId: shop.id,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "portal_preview_created",
          mode: "subscriber",
          contractId: contract.id,
          checklistPreviewedPortal: true,
        },
      });
      return json<ActionData>({ intent, ok: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Could not start the portal preview: ${message}`,
      });
    }
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Client-side helpers ──────────────────────────────────────────────────────

type PreviewFetcher = FetcherWithComponents<ActionData>;

/** Opens a freshly generated preview URL in a new tab (once per URL). */
function useOpenPreviewUrl(fetcher: PreviewFetcher) {
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const url = fetcher.data?.ok ? fetcher.data.url : undefined;
    if (url && opened.current !== url) {
      opened.current = url;
      window.open(url, "_blank", "noopener");
    }
  }, [fetcher.data]);
}

function useFetcherToast(fetcher: PreviewFetcher) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.toast) {
      shopify.toast.show(fetcher.data.toast, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);
}

/** "If the tab didn't open" fallback + copyable link for mobile testing. */
function PreviewLinkFallback({
  url,
  label,
  helpText,
}: {
  url: string | undefined;
  label: string;
  helpText: string;
}) {
  if (!url) return null;
  return (
    <BlockStack gap="100">
      <TextField
        label={label}
        labelHidden
        autoComplete="off"
        readOnly
        value={url}
        helpText={helpText}
      />
      <Text as="p" variant="bodySm" tone="subdued">
        If the tab didn't open,{" "}
        <a href={url} target="_blank" rel="noreferrer">
          open the preview manually
        </a>
        .
      </Text>
    </BlockStack>
  );
}

// ── Checklist ────────────────────────────────────────────────────────────────

function ChecklistRow({
  done,
  title,
  detail,
  children,
}: {
  done: boolean;
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Box minWidth="64px">
        <Badge tone={done ? "success" : "attention"}>
          {done ? "Done" : "To do"}
        </Badge>
      </Box>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="medium">
          {title}
        </Text>
        {detail ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {detail}
          </Text>
        ) : null}
        {children}
      </BlockStack>
    </InlineStack>
  );
}

function ChecklistCheckbox({
  field,
  label,
  helpText,
  checked,
  disabled,
}: {
  field: "confirmedThemeBlock" | "confirmedKlaviyo";
  label: string;
  helpText?: string;
  checked: boolean;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<ActionData>();
  const optimistic = fetcher.formData
    ? fetcher.formData.get("value") === "true"
    : checked;
  return (
    <Checkbox
      label={label}
      helpText={helpText}
      checked={optimistic}
      disabled={disabled}
      onChange={(value) =>
        fetcher.submit(
          { intent: "mark-checklist", field, value: String(value) },
          { method: "post" },
        )
      }
    />
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PreviewPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const { launch, checklist, overdueCount, overdueSample, products } = data;
  const isLive = launch.mode === "LIVE";

  // Go-live / revert modals (navigation-form submits, toast via actionData).
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [shiftOverdue, setShiftOverdue] = useState(true);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData.ok && actionData.intent === "go-live") setGoLiveOpen(false);
    if (actionData.ok && actionData.intent === "revert-setup") {
      setRevertOpen(false);
    }
  }, [actionData, shopify]);

  const navIntent = navigation.formData?.get("intent");
  const busy = navigation.state !== "idle";

  // Storefront preview.
  const storefrontFetcher = useFetcher<ActionData>();
  const [productHandle, setProductHandle] = useState(products[0]?.handle ?? "");
  useOpenPreviewUrl(storefrontFetcher);
  useFetcherToast(storefrontFetcher);

  // Portal preview — demo contract.
  const demoFetcher = useFetcher<ActionData>();
  useOpenPreviewUrl(demoFetcher);
  useFetcherToast(demoFetcher);

  // Portal preview — real subscriber (loader-backed email search).
  const subscriberFetcher = useFetcher<ActionData>();
  useOpenPreviewUrl(subscriberFetcher);
  useFetcherToast(subscriberFetcher);
  const searchFetcher = useFetcher<typeof loader>();
  const [emailQuery, setEmailQuery] = useState("");
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  useEffect(() => {
    const q = emailQuery.trim();
    if (q.length < SEARCH_MIN_CHARS) return;
    const handle = setTimeout(() => {
      searchFetcher.load(`/app/preview?q=${encodeURIComponent(q)}`);
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailQuery]);
  const searchResults =
    emailQuery.trim().length >= SEARCH_MIN_CHARS
      ? (searchFetcher.data?.subscriberMatches ?? [])
      : [];

  const checklistItems = {
    plansSynced: checklist.plansSynced,
    themeBlock: launch.confirmedThemeBlock,
    storefront: launch.previewedStorefront,
    portal: launch.previewedPortal,
    klaviyo: checklist.klaviyoKeyPresent && launch.confirmedKlaviyo,
    scheduler: checklist.schedulerHealthy,
  };

  return (
    <Page
      title="Preview & launch"
      subtitle="Test everything on your live theme without store visitors seeing a thing, then go live."
    >
      <BlockStack gap="400">
        {/* ── Launch status ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <InlineStack gap="300" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  Launch status
                </Text>
                {isLive ? (
                  <Badge tone="success" size="large">
                    LIVE
                  </Badge>
                ) : (
                  <Badge tone="attention" size="large">
                    SETUP
                  </Badge>
                )}
              </InlineStack>
              {isLive ? (
                <Button
                  tone="critical"
                  variant="secondary"
                  onClick={() => setRevertOpen(true)}
                >
                  Revert to setup
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setGoLiveOpen(true)}>
                  Go live
                </Button>
              )}
            </InlineStack>
            <Text as="p" variant="bodyMd">
              {isLive
                ? `Live${launch.wentLiveAt ? ` since ${launch.wentLiveAt.slice(0, 10)}` : ""}: the buy-box widget, customer portal, renewal billing and customer notifications are all on.`
                : "Setup mode: nothing is visible to store visitors, no charges, no customer emails."}
            </Text>
            <Divider />
            <BlockStack gap="300">
              <ChecklistRow
                done={checklistItems.plansSynced}
                title="Selling plans synced"
                detail={
                  checklistItems.plansSynced
                    ? "At least one subscription plan is synced to Shopify."
                    : "No plan is synced yet — create and sync one on the Plans page."
                }
              >
                {!checklistItems.plansSynced ? (
                  <Box>
                    <Button url="/app/plans" variant="plain">
                      Open Plans
                    </Button>
                  </Box>
                ) : null}
              </ChecklistRow>
              <ChecklistRow
                done={checklistItems.themeBlock}
                title="Buy box added to your theme"
                detail="Easiest path: in the theme editor, open Theme settings → App embeds, switch on “Cellexia Buy Box” and save — it mounts itself into the product page automatically. If your theme supports app blocks on the product template, you can add the buy-box block instead. Either way it renders hidden until you go live, so this is safe at any time."
              >
                <ChecklistCheckbox
                  field="confirmedThemeBlock"
                  label="App embed enabled (Theme settings → App embeds) or block added"
                  checked={launch.confirmedThemeBlock}
                />
              </ChecklistRow>
              <ChecklistRow
                done={checklistItems.storefront}
                title="Storefront previewed"
                detail={
                  checklistItems.storefront
                    ? "You previewed the widget on your live theme."
                    : "Use the storefront preview below — this ticks itself."
                }
              />
              <ChecklistRow
                done={checklistItems.portal}
                title="Portal previewed"
                detail={
                  checklistItems.portal
                    ? "You previewed the customer portal."
                    : "Use the portal preview below — this ticks itself."
                }
              />
              <ChecklistRow
                done={checklistItems.klaviyo}
                title="Klaviyo connected"
                detail={
                  checklist.klaviyoKeyPresent
                    ? "API key configured. Events are suppressed until you go live."
                    : "KLAVIYO_PRIVATE_API_KEY is not set — lifecycle emails will use the SMTP fallback until it is."
                }
              >
                <ChecklistCheckbox
                  field="confirmedKlaviyo"
                  label="I confirmed the Klaviyo flows are ready"
                  checked={launch.confirmedKlaviyo}
                  disabled={!checklist.klaviyoKeyPresent}
                  helpText={
                    checklist.klaviyoKeyPresent
                      ? undefined
                      : "Set the API key first."
                  }
                />
              </ChecklistRow>
              <ChecklistRow
                done={checklistItems.scheduler}
                title="Scheduler healthy"
                detail={
                  checklistItems.scheduler
                    ? "A background job ran within the last 10 minutes."
                    : "No job has run in the last 10 minutes — check the internal tick or your external cron hitting /api/jobs/run."
                }
              />
            </BlockStack>
          </BlockStack>
        </Card>

        {/* ── Storefront preview ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Storefront preview
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Opens the live product page with the subscription widget revealed
              — only in your own browser session. Store visitors keep seeing the
              unchanged page. Works the same whether the widget loads through
              the app embed (Theme settings → App embeds) or the theme block.
            </Text>
            {products.length === 0 ? (
              <Banner
                tone="info"
                title="No synced plan yet"
                action={{ content: "Open Plans", url: "/app/plans" }}
              >
                <p>
                  Sync a subscription plan to Shopify first — the preview needs
                  a product with a subscribe option.
                </p>
              </Banner>
            ) : (
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box minWidth="280px">
                    <Select
                      label="Product"
                      options={products.map((p) => ({
                        label: p.title,
                        value: p.handle,
                      }))}
                      value={productHandle}
                      onChange={setProductHandle}
                    />
                  </Box>
                  <Button
                    variant="primary"
                    loading={storefrontFetcher.state !== "idle"}
                    onClick={() =>
                      storefrontFetcher.submit(
                        { intent: "preview-storefront", productHandle },
                        { method: "post" },
                      )
                    }
                  >
                    Preview on product page
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  In the preview tab: pick the subscription option in the
                  widget, add to cart, then open /cart and continue into
                  checkout — the recurring terms show up natively on the way.
                  All of it is visible only in your browser session. Open the
                  same link on your phone to test mobile.
                </Text>
                <PreviewLinkFallback
                  url={
                    storefrontFetcher.data?.ok
                      ? storefrontFetcher.data.url
                      : undefined
                  }
                  label="Storefront preview link"
                  helpText="Valid for 7 days — copy it to any of your own devices."
                />
              </BlockStack>
            )}
            <Box>
              <Button url="/app/buy-box" variant="plain">
                Customize the widget's design in the Buy box designer
              </Button>
            </Box>
          </BlockStack>
        </Card>

        {/* ── Portal preview ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Customer portal preview
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              You'll see exactly what they see; all changes are disabled in
              preview — nothing executes and Shopify is never called.
            </Text>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Box
                borderColor="border"
                borderWidth="025"
                borderRadius="200"
                padding="300"
              >
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    With a demo subscription
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Creates a local-only demo subscription — never billed, never
                    emailed, invisible to jobs and analytics — and opens the
                    portal as that subscriber.
                    {data.hasDemoContract
                      ? " Your existing demo subscription is reused."
                      : ""}
                  </Text>
                  <Box>
                    <Button
                      loading={demoFetcher.state !== "idle"}
                      onClick={() =>
                        demoFetcher.submit(
                          { intent: "preview-portal-demo" },
                          { method: "post" },
                        )
                      }
                    >
                      Preview with a demo subscription
                    </Button>
                  </Box>
                  <PreviewLinkFallback
                    url={demoFetcher.data?.ok ? demoFetcher.data.url : undefined}
                    label="Demo portal preview link"
                    helpText="Valid for 1 hour."
                  />
                </BlockStack>
              </Box>
              <Box
                borderColor="border"
                borderWidth="025"
                borderRadius="200"
                padding="300"
              >
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    As a real subscriber
                  </Text>
                  <TextField
                    label="Subscriber email"
                    autoComplete="off"
                    value={emailQuery}
                    onChange={(value) => {
                      setEmailQuery(value);
                      setSelectedEmail(null);
                    }}
                    placeholder="Search subscriber emails…"
                    loading={searchFetcher.state !== "idle"}
                  />
                  {selectedEmail == null && searchResults.length > 0 ? (
                    <Box
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                      padding="150"
                    >
                      <BlockStack gap="100">
                        {searchResults.map((match) => (
                          <Button
                            key={match.email}
                            variant="tertiary"
                            textAlign="left"
                            fullWidth
                            onClick={() => {
                              setSelectedEmail(match.email);
                              setEmailQuery(match.email);
                            }}
                          >
                            {`${match.email}${match.name ? ` — ${match.name}` : ""} (${match.status.toLowerCase()})`}
                          </Button>
                        ))}
                      </BlockStack>
                    </Box>
                  ) : null}
                  {selectedEmail ? (
                    <InlineStack gap="150">
                      <Tag
                        onRemove={() => {
                          setSelectedEmail(null);
                          setEmailQuery("");
                        }}
                      >
                        {selectedEmail}
                      </Tag>
                    </InlineStack>
                  ) : null}
                  <Box>
                    <Button
                      disabled={!selectedEmail}
                      loading={subscriberFetcher.state !== "idle"}
                      onClick={() => {
                        if (!selectedEmail) return;
                        subscriberFetcher.submit(
                          {
                            intent: "preview-portal-subscriber",
                            email: selectedEmail,
                          },
                          { method: "post" },
                        );
                      }}
                    >
                      Preview their portal
                    </Button>
                  </Box>
                  <PreviewLinkFallback
                    url={
                      subscriberFetcher.data?.ok
                        ? subscriberFetcher.data.url
                        : undefined
                    }
                    label="Subscriber portal preview link"
                    helpText="Valid for 1 hour. Read-only — nothing you click changes their subscription."
                  />
                </BlockStack>
              </Box>
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>

      {/* ── Go-live modal ── */}
      <Modal
        open={goLiveOpen}
        onClose={() => setGoLiveOpen(false)}
        title="Go live?"
        primaryAction={{
          content: "Go live",
          loading: busy && navIntent === "go-live",
          onAction: () =>
            submit(
              { intent: "go-live", shiftOverdue: String(shiftOverdue) },
              { method: "post" },
            ),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setGoLiveOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">Going live flips everything on at once:</Text>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                • The subscription widget becomes visible on your product pages
              </Text>
              <Text as="p" variant="bodySm">
                • The customer portal opens at /apps/cellexia
              </Text>
              <Text as="p" variant="bodySm">
                • Renewal billing, reminders, dunning and win-back start running
                on schedule
              </Text>
              <Text as="p" variant="bodySm">
                • Customer emails/SMS and Klaviyo events start sending
              </Text>
            </BlockStack>
            {overdueCount > 0 ? (
              <Banner
                tone="warning"
                title={`${overdueCount} active subscription${overdueCount === 1 ? " has" : "s have"} an overdue next billing date`}
              >
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    Going live would charge them all immediately in one burst
                    {overdueSample.length > 0
                      ? ` (e.g. ${overdueSample
                          .map((c) => `${c.email} — due ${c.nextBillingDate}`)
                          .join(", ")})`
                      : ""}
                    .
                  </Text>
                  <Checkbox
                    label="Shift these renewals forward, spread over the next 3 days (recommended)"
                    checked={shiftOverdue}
                    onChange={setShiftOverdue}
                  />
                </BlockStack>
              </Banner>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Revert modal ── */}
      <Modal
        open={revertOpen}
        onClose={() => setRevertOpen(false)}
        title="Revert to setup mode?"
        primaryAction={{
          content: "Revert to setup",
          destructive: true,
          loading: busy && navIntent === "revert-setup",
          onAction: () => submit({ intent: "revert-setup" }, { method: "post" }),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setRevertOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              This hides the buy-box widget, closes the customer portal and
              stops renewal charges, reminders and customer emails — the store
              goes dark again.
            </Text>
            <Banner tone="warning">
              Existing subscriptions are <strong>not</strong> cancelled or
              modified. Renewals that come due while in setup mode will be
              waiting when you go live again.
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
