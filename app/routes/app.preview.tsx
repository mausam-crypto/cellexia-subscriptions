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
  launchFlagDiverged,
  markChecklist,
  probeProxyIdentity,
  readLaunchMetafield,
  revertToSetup,
  syncLaunchMetafield,
  type ProxyIdentityProbe,
} from "~/lib/launch/launch.server";
import {
  runPreviewDoctor,
  type DoctorReport,
  type DoctorStep,
} from "~/lib/launch/doctor.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { createDemoContract } from "~/lib/portal/demo.server";
import { buildPortalUrl } from "~/lib/magiclinks/builder.server";
import {
  PORTAL_PREVIEW_TTL_SECONDS,
  PREVIEW_TOKEN_PARAM,
  mintPreviewToken,
} from "~/lib/portal/previewToken.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import {
  getProducts,
  getSubscribableProducts,
} from "~/lib/graphql/index.server";
import type { AdminClient, ShopifyProduct } from "~/lib/graphql/index.server";
import {
  OURS_ONLY,
  getOwnershipCounts,
  reclassifyContracts,
} from "~/lib/ownership/ownership.server";
import {
  scanForeignSellingPlanGroups,
  toForeignGroupScanJson,
  type ForeignGroupScanJson,
} from "~/lib/ownership/foreign-groups.server";

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
const SEARCH_MIN_CHARS = 2;

/**
 * Direct, cookie-less portal preview URL: store-domain portal home carrying a
 * signed 1-hour ?cx_pp= token. This replaced the magic-link LOGIN hop —
 * Shopify's app proxy strips Set-Cookie, so the hand-off cookie the old flow
 * minted could never reach a browser on a live store and every preview
 * dead-ended at the setup gate. The token is stateless, multi-use within its
 * TTL, and opens a view-only session (mutations are intercepted).
 */
async function buildPortalPreviewUrl(
  shopId: string,
  contract: { id: string; customerId: string; email: string },
): Promise<string> {
  const token = mintPreviewToken(
    {
      shopId,
      customerId: contract.customerId,
      contractId: contract.id,
      email: contract.email,
    },
    PORTAL_PREVIEW_TTL_SECONDS,
  );
  const base = await buildPortalUrl(shopId, "/");
  return `${base}?${PREVIEW_TOKEN_PARAM}=${token}`;
}

// ── Shared view types ────────────────────────────────────────────────────────

interface ProductOption {
  id: string;
  title: string;
  handle: string;
  /**
   * Why "Preview on product page" cannot work for this product, or null when
   * it can. See previewBlockedReason() — offering an option that opens a 404
   * or a page the widget legitimately never renders on, while ticking the
   * "Storefront previewed" checklist item, is worse than not offering it.
   */
  blockedReason: string | null;
}

interface SubscriberMatch {
  email: string;
  name: string | null;
  status: string;
}

/**
 * What another subscription app on this store looks like from here: contracts
 * we will never touch, and selling plan groups we did not create.
 *
 * `groupsReadable: false` means Shopify could not be read — the card then says
 * nothing about groups rather than claiming there are none.
 */
interface OtherAppsView {
  foreignContracts: number;
  unknownContracts: number;
  ownContracts: number;
  groupsReadable: boolean;
  foreignGroups: Array<{
    id: string;
    name: string;
    merchantCode: string | null;
    productTitles: string[];
  }>;
}

const EMPTY_OTHER_APPS: OtherAppsView = {
  foreignContracts: 0,
  unknownContracts: 0,
  ownContracts: 0,
  groupsReadable: false,
  foreignGroups: [],
};

/** Is there anything to warn about at all? */
function hasOtherApps(view: OtherAppsView): boolean {
  return (
    view.foreignContracts > 0 ||
    view.unknownContracts > 0 ||
    view.foreignGroups.length > 0
  );
}

/**
 * The cellexia.launch_status metafield read back from Shopify — the ONLY
 * thing the storefront gates on. `readable: false` means the lookup itself
 * failed, in which case nothing is claimed (never cry wolf over a hiccup).
 */
interface StorefrontFlag {
  value: string | null;
  readable: boolean;
  diverged: boolean;
}

const UNREAD_STOREFRONT_FLAG: StorefrontFlag = {
  value: null,
  readable: false,
  diverged: false,
};

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  /** Preview URL to open in a new tab (preview-* intents). */
  url?: string;
  /**
   * Preview Doctor step list (run-doctor, and preview-storefront when the
   * doctor blocked the open). Rendered inline so a blocked preview explains
   * itself instead of opening a blank page.
   */
  report?: DoctorReport;
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

/**
 * Why the storefront preview cannot work for this product, or null.
 *
 * Two silent dead ends, both reachable from a perfectly normal setup and both
 * previously offered as if they were fine:
 *
 *  - NOT ACTIVE. Keeping the subscription product in DRAFT until launch is a
 *    normal way to prepare one. buildStorefrontPreviewUrl happily returns
 *    https://<shop>/products/<handle>?cx_preview=…, the tab opens the
 *    storefront 404 page, and the "Storefront previewed" checklist item ticks
 *    itself anyway — the app then claims a preview that never happened.
 *  - NO SELLING PLAN GROUP ATTACHED (the config row says SYNCED but the group
 *    was detached in Shopify, or the sync half-failed). Both block files guard
 *    on `product.selling_plan_groups.size > 0`, so that product page renders
 *    NOTHING from this app — no wrapper, no CSS and, critically, no <script>,
 *    which means buy-box-embed.js never loads and its "no placement anchor
 *    found" diagnostic cannot fire either. The admin sees an ordinary product
 *    page and cannot tell "embed not enabled" from "plan not on this product"
 *    from "widget broken".
 *
 * Only PROVEN blockers are reported: an unreadable status or an attachment
 * lookup that failed (attachedProductIds === null) never invents a reason, so
 * a Shopify hiccup can never empty the picker.
 */
function previewBlockedReason(
  product: ShopifyProduct,
  attachedProductIds: Set<string> | null,
): string | null {
  const status = (product.status ?? "").toUpperCase();
  if (status === "DRAFT") {
    return "Draft in Shopify — publish it before previewing";
  }
  if (status === "ARCHIVED") {
    return "Archived in Shopify — its product page returns 404";
  }
  if (attachedProductIds && !attachedProductIds.has(product.id)) {
    return "No subscription plan attached in Shopify — re-sync it from Plans";
  }
  return null;
}

/**
 * The storefront-preview picker: every synced product, each annotated with the
 * reason it cannot be previewed (null = it can). Both Shopify reads are
 * contained independently — a failure degrades the annotation, never the list.
 */
async function loadPreviewProducts(
  admin: AdminClient,
  productIds: string[],
): Promise<ProductOption[]> {
  if (productIds.length === 0) return [];

  const [attachedProductIds, fetched] = await Promise.all([
    getSubscribableProducts(admin).then(
      (rows) => new Set(rows.map((row) => row.id)),
      (err: unknown) => {
        console.error("[preview] selling-plan attachment lookup failed", err);
        return null;
      },
    ),
    getProducts(admin, productIds).then(
      (rows) => rows,
      (err: unknown) => {
        console.error("[preview] product lookup failed", err);
        return [] as ShopifyProduct[];
      },
    ),
  ]);

  return fetched.flatMap((p) =>
    p.handle
      ? [
          {
            id: p.id,
            title: p.title,
            handle: p.handle,
            blockedReason: previewBlockedReason(p, attachedProductIds),
          },
        ]
      : [],
  );
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

  // Proxy-identity probe ("Portal proxy answers as Cellexia"): a real fetch
  // against the live store domain, so it is kicked off FIRST and awaited last
  // to overlap the DB/Shopify reads below. Skipped for subscriber-search
  // fetcher requests (?q=) like every other non-search read on this page.
  // probeProxyIdentity never throws and times out quickly — the page render
  // is never blocked by a dead storefront.
  const proxyIdentityPromise: Promise<ProxyIdentityProbe> | null =
    query.length >= SEARCH_MIN_CHARS ? null : probeProxyIdentity(shop.id);

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
              // Only subscribers we manage: the portal shows nothing for
              // another app's contract, so offering one here would open an
              // empty portal and tick "Portal previewed" for a preview that
              // never happened.
              ...OURS_ONLY,
              email: { contains: query, mode: "insensitive" },
            },
            orderBy: { createdAt: "desc" },
            distinct: ["email"],
            take: 8,
            select: { email: true, firstName: true, lastName: true, status: true },
          })
        : Promise.resolve([]),
    ]);

  // Product titles/handles for the storefront preview picker, each annotated
  // with the reason it cannot be previewed (see previewBlockedReason).
  // Skipped for subscriber-search fetcher requests (?q=) so typing never hits
  // Shopify; a lookup failure must never break the page (failures are
  // contained inside loadPreviewProducts).
  let products: ProductOption[] = [];
  if (query.length < SEARCH_MIN_CHARS) {
    const productIds = [
      ...new Set(syncedConfigs.flatMap((c) => parseJsonStringArray(c.productIds))),
    ];
    products = await loadPreviewProducts(admin, productIds);
  }

  // Storefront flag read-back. The launch setting is what the admin sees, but
  // the metafield is what every product page actually reads — if they disagree
  // (a metafield write that failed, an interrupted go-live) the store is dark
  // while the app says LIVE, or still selling while the app says SETUP.
  // Contained like the product lookup: a failed read never breaks the page and
  // never claims a divergence. Skipped for subscriber-search fetcher requests.
  let storefrontFlag: StorefrontFlag = UNREAD_STOREFRONT_FLAG;
  if (query.length < SEARCH_MIN_CHARS) {
    try {
      const value = await readLaunchMetafield(admin);
      storefrontFlag = {
        value,
        readable: true,
        diverged: launchFlagDiverged(launch.mode, value),
      };
    } catch (err) {
      console.error("[preview] launch_status metafield read failed", err);
    }
  }

  // Another subscription app on the same store: its contracts (mirrored here
  // by the shared SUBSCRIPTION_CONTRACTS_* webhooks but never billed, emailed
  // or analysed by us) and its selling plan groups (which put a second
  // subscribe widget on the same product pages). Both reads are contained —
  // this card must never break the launch page. Skipped for ?q= fetcher
  // requests like the other Shopify reads.
  let otherApps: OtherAppsView = EMPTY_OTHER_APPS;
  if (query.length < SEARCH_MIN_CHARS) {
    let counts = { ours: 0, foreign: 0, unknown: 0 };
    try {
      counts = await getOwnershipCounts(shop.id);
    } catch (err) {
      console.error("[preview] ownership counts failed", err);
    }
    let groupScan: ForeignGroupScanJson = {
      readable: false,
      foreignGroups: [],
      foreignGroupNamesByProduct: {},
    };
    try {
      groupScan = toForeignGroupScanJson(
        await scanForeignSellingPlanGroups(admin, shop.id),
      );
    } catch (err) {
      console.error("[preview] foreign selling plan group scan failed", err);
    }
    otherApps = {
      foreignContracts: counts.foreign,
      unknownContracts: counts.unknown,
      ownContracts: counts.ours,
      groupsReadable: groupScan.readable,
      foreignGroups: groupScan.foreignGroups.map((g) => ({
        id: g.id,
        name: g.name || g.merchantCode || g.id,
        merchantCode: g.merchantCode,
        productTitles: g.products.map((p) => p.title).filter(Boolean),
      })),
    };
  }

  const subscriberMatches: SubscriberMatch[] = matches.map((m) => ({
    email: m.email,
    name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
    status: m.status,
  }));

  const proxyIdentity = proxyIdentityPromise ? await proxyIdentityPromise : null;

  return json({
    storeDomain: shop.primaryDomain ?? shop.domain,
    launch,
    storefrontFlag,
    proxyIdentity,
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
    otherApps,
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

  if (intent === "recheck-ownership") {
    // Re-decide which mirrored contracts are ours. Contracts that have never
    // been positively attributed are UNKNOWN and therefore not billed, not
    // emailed and not counted — this is the button that resolves them, and
    // go-live runs the same pass automatically.
    try {
      const result = await reclassifyContracts(shop.domain);
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "contract_ownership_rechecked",
          scanned: result.scanned,
          changed: result.changed,
          resynced: result.resynced,
          errors: result.errors,
          remaining: result.remaining,
          counts: result.counts,
        },
      });
      const { ours, foreign, unknown } = result.counts;
      // `remaining` is what is still unattributed AFTER this pass, so it says
      // whether pressing the button again has anything left to do — and it
      // reaches 0 when the shop is fully attributed. (It used to be
      // "contracts this pass did not look at", counted over every contract on
      // the shop, which on a shop bigger than one pass never reached 0 and so
      // always told the admin to run it again.)
      const leftovers = [
        result.errors > 0 ? `${result.errors} could not be read from Shopify` : "",
        result.remaining > 0 ? "run it again to finish the rest" : "",
      ].filter(Boolean);
      return json<ActionData>({
        intent,
        ok: true,
        toast: `Ownership re-checked: ${ours} managed by Cellexia, ${foreign} by another app, ${unknown} unattributed${
          leftovers.length > 0 ? ` (${leftovers.join(", ")})` : ""
        }`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Ownership re-check failed: ${message}`,
      });
    }
  }

  if (intent === "go-live") {
    const shiftOverdue = String(formData.get("shiftOverdue") ?? "") === "true";
    try {
      // goLive logs its own admin.action event — don't double-log here.
      const { shifted, ownership, ownershipError } = await goLive(shop.domain, {
        shiftOverdue,
        actor,
      });
      const shiftNote =
        shifted > 0
          ? ` — ${shifted} overdue renewal${shifted === 1 ? "" : "s"} spread over the next 3 days`
          : " — the subscription experience is now visible to store visitors";
      // A failed ownership pass never blocks go-live (unattributed contracts
      // are not billable), but the admin has to know it needs re-running.
      const ownershipNote = ownership
        ? ownership.changed > 0
          ? ` Ownership re-checked: ${ownership.changed} subscription${ownership.changed === 1 ? "" : "s"} re-attributed.`
          : ""
        : ` Ownership could not be re-checked (${ownershipError ?? "unknown error"}) — press “Re-check subscription ownership” before relying on the counts.`;
      return json<ActionData>({
        intent,
        ok: true,
        toast: `You're live${shiftNote}.${ownershipNote}`,
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

  if (intent === "resync-launch-flag") {
    // Push the launch mode into cellexia.launch_status again. Used when the
    // read-back banner shows the storefront flag disagreeing with the mode —
    // e.g. a metafield write that failed after the setting was saved.
    const launch = await getLaunchState(shop.id);
    const sync = await syncLaunchMetafield(shop.domain, launch.mode);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "launch_flag_resynced",
        mode: launch.mode,
        ok: sync.ok,
        error: sync.error ?? null,
      },
    });
    return json<ActionData>({
      intent,
      ok: sync.ok,
      toast: sync.ok
        ? `Storefront flag re-synced — the store is now ${launch.mode === "LIVE" ? "live" : "dark"}`
        : `Re-sync failed: ${sync.error ?? "unknown error"}`,
    });
  }

  if (intent === "run-doctor") {
    // runPreviewDoctor never throws (every step is contained) and logs its
    // own admin.action event — don't double-log here.
    const productId = String(formData.get("productId") ?? "").trim();
    const report = await runPreviewDoctor(shop.domain, productId || undefined);
    return json<ActionData>({ intent, ok: true, report });
  }

  if (intent === "preview-storefront") {
    const productHandle = String(formData.get("productHandle") ?? "").trim();
    const productId = String(formData.get("productId") ?? "").trim();
    const openAnyway = String(formData.get("openAnyway") ?? "") === "true";

    // Run the doctor BEFORE opening the tab: every closed gate on the render
    // chain used to look identical from the preview — a blank product page
    // with no explanation. When a step fails, the report is returned inline
    // instead of a URL; the "Open anyway" button re-submits with openAnyway
    // so nothing is ever hard-blocked. A doctor that itself blew up must
    // never block the preview either — fail open, but never SILENTLY: the
    // merchant is told the pre-flight check was skipped (toast below), so a
    // blank preview still has a named next step instead of looking vetted.
    // Neither un-vetted path ticks the "Storefront previewed" checklist
    // item — see the `vetted` gate below.
    let doctorSkipped = false;
    if (!openAnyway) {
      try {
        const report = await runPreviewDoctor(
          shop.domain,
          productId || undefined,
        );
        if (report.verdict === "BLOCKED") {
          const blocked = report.steps.find(
            (step) => step.key === report.firstBlockedStep,
          );
          return json<ActionData>({
            intent,
            ok: false,
            report,
            toast: `Preview blocked${blocked ? ` — ${blocked.label}` : ""}: see the diagnosis for the fix`,
          });
        }
      } catch (err) {
        console.error("[preview] doctor run before preview failed", err);
        doctorSkipped = true;
      }
    }
    try {
      const url = await buildStorefrontPreviewUrl(
        shop.id,
        productHandle || undefined,
      );
      // "Storefront previewed" ticks ONLY off a doctor-vetted open. An Open
      // anyway (the doctor just said BLOCKED) or a fail-open (the doctor
      // crashed — chain state unknown) may well open the exact blank page
      // the checklist item exists to catch; a checklist that says
      // "previewed" off a blank page defeats its purpose. Un-vetted opens
      // stay un-ticked — fixing the diagnosis and previewing again ticks it
      // — and the audit event says which kind this was.
      const vetted = !openAnyway && !doctorSkipped;
      if (vetted) {
        await markPreviewed(shop.id, "previewedStorefront", actor);
      }
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "storefront_preview_created",
          productHandle: productHandle || null,
          checklistPreviewedStorefront: vetted,
          ...(openAnyway ? { openAnyway: true } : {}),
          ...(doctorSkipped ? { doctorSkipped: true } : {}),
        },
      });
      return json<ActionData>({
        intent,
        ok: true,
        url,
        ...(doctorSkipped
          ? {
              toast:
                "Preview opened, but its pre-flight diagnosis could not run and was skipped — if the page looks blank, use Run diagnosis below. “Storefront previewed” was not ticked.",
            }
          : openAnyway
            ? {
                toast:
                  "Preview opened despite the blocked diagnosis — “Storefront previewed” stays unticked until a preview passes the diagnosis.",
              }
            : {}),
      });
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
      const url = await buildPortalPreviewUrl(shop.id, contract);
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
          via: "cx_pp",
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
        ...OURS_ONLY, // the portal only ever shows contracts we manage
        email: { equals: email, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!contract) {
      return json<ActionData>(
        {
          intent,
          ok: false,
          toast:
            "No Cellexia subscription found for that email (subscriptions managed by another app cannot be previewed here)",
        },
        { status: 404 },
      );
    }
    try {
      const url = await buildPortalPreviewUrl(shop.id, contract);
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
          via: "cx_pp",
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

// ── Preview Doctor ───────────────────────────────────────────────────────────

const DOCTOR_BADGES: Record<
  DoctorStep["status"],
  { tone?: "success" | "critical" | "warning"; label: string }
> = {
  PASS: { tone: "success", label: "Pass" },
  FAIL: { tone: "critical", label: "Fail" },
  WARN: { tone: "warning", label: "Check" },
  SKIP: { label: "Skipped" },
};

/**
 * The doctor's step list: one row per render-chain gate, in chain order, with
 * the diagnosis and (on failure) the fix. Shared by the "Run diagnosis" card
 * and the blocked-preview banner.
 */
function DoctorReportView({ report }: { report: DoctorReport }) {
  return (
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center">
        <Badge tone={report.verdict === "READY" ? "success" : "critical"}>
          {report.verdict === "READY" ? "Ready" : "Blocked"}
        </Badge>
        <Text as="p" variant="bodySm" tone="subdued">
          {report.verdict === "READY"
            ? "Every gate on the render chain is open — the preview should show the widget."
            : "Start at the first failing step; fix it, then run the diagnosis again."}
        </Text>
      </InlineStack>
      <BlockStack gap="200">
        {report.steps.map((step) => {
          const badge = DOCTOR_BADGES[step.status];
          return (
            <InlineStack
              key={step.key}
              gap="300"
              blockAlign="start"
              wrap={false}
            >
              <Box minWidth="72px">
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </Box>
              <BlockStack gap="050">
                <Text as="p" variant="bodyMd" fontWeight="medium">
                  {step.label}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {step.detail}
                </Text>
                {step.remediation ? (
                  <Text as="p" variant="bodySm" fontWeight="medium">
                    {`Fix: ${step.remediation}`}
                  </Text>
                ) : null}
              </BlockStack>
            </InlineStack>
          );
        })}
      </BlockStack>
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

/**
 * A checklist row that is a WARNING, not a to-do: it never blocks go-live and
 * has nothing to tick. Used for "another subscription app is on this store",
 * which the merchant must read before launching but cannot resolve from here.
 */
function ChecklistWarningRow({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Box minWidth="64px">
        <Badge tone="warning">Heads-up</Badge>
      </Box>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="medium">
          {title}
        </Text>
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
  const storefrontFlag = data.storefrontFlag;
  const proxyIdentity = data.proxyIdentity;
  const otherApps: OtherAppsView = data.otherApps ?? EMPTY_OTHER_APPS;
  const otherAppsPresent = hasOtherApps(otherApps);

  // Storefront flag re-sync (shown only when the read-back disagrees).
  const resyncFetcher = useFetcher<ActionData>();
  useFetcherToast(resyncFetcher);

  // Ownership re-check ("which of these mirrored contracts are ours?").
  const recheckFetcher = useFetcher<ActionData>();
  useFetcherToast(recheckFetcher);

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

  // Storefront preview. Only products whose page can actually show the widget
  // are selectable — the rest stay listed, disabled, with the reason on the
  // option, so "why is my product missing?" never becomes a support question.
  const storefrontFetcher = useFetcher<ActionData>();
  const previewableProducts = products.filter((p) => p.blockedReason === null);
  const [productHandle, setProductHandle] = useState(
    previewableProducts[0]?.handle ?? "",
  );
  useOpenPreviewUrl(storefrontFetcher);
  useFetcherToast(storefrontFetcher);
  const previewProductId =
    products.find((p) => p.handle === productHandle)?.id ?? "";
  const submitStorefrontPreview = (openAnyway: boolean) =>
    storefrontFetcher.submit(
      {
        intent: "preview-storefront",
        productHandle,
        productId: previewProductId,
        ...(openAnyway ? { openAnyway: "true" } : {}),
      },
      { method: "post" },
    );
  const blockedPreviewReport =
    storefrontFetcher.data && !storefrontFetcher.data.ok
      ? storefrontFetcher.data.report
      : undefined;

  // Preview Doctor — on-demand diagnosis of the widget render chain. Unlike
  // the preview picker, EVERY synced product is selectable here (no disabled
  // options): the broken products are exactly the ones worth diagnosing.
  const doctorFetcher = useFetcher<ActionData>();
  useFetcherToast(doctorFetcher);
  const [doctorProductHandle, setDoctorProductHandle] = useState(
    products[0]?.handle ?? "",
  );
  const doctorProductId =
    products.find((p) => p.handle === doctorProductHandle)?.id ?? "";

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
            {storefrontFlag.diverged ? (
              <Banner
                tone="critical"
                title="Your store isn't showing what this page says"
                action={{
                  content: "Re-sync storefront flag",
                  loading: resyncFetcher.state !== "idle",
                  onAction: () =>
                    resyncFetcher.submit(
                      { intent: "resync-launch-flag" },
                      { method: "post" },
                    ),
                }}
              >
                <p>
                  {isLive
                    ? "The app is LIVE, but the cellexia.launch_status flag your theme reads is still “setup” — the subscription widget is hidden on every product page. Re-sync it to finish going live."
                    : "The app is in SETUP, but the cellexia.launch_status flag your theme reads is still “live” — the subscription widget is visible and purchasable to every visitor. Re-sync it to go dark."}
                </p>
              </Banner>
            ) : null}
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
                    : "KLAVIYO_PRIVATE_API_KEY is not set — lifecycle emails fall back to plain direct-SMTP delivery (no Klaviyo flows, and SMS is not sent at all) until it is."
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
              {/* Proxy-identity guard: the store-domain portal path must be
                  answered by THIS app. The store's other app ("AOV & LTV
                  Booster") owns /apps/cellexia, so this row is what catches a
                  deployed collision or an undeployed [app_proxy] config. A
                  network failure is a warning, never a failed row. */}
              {proxyIdentity == null ? null : proxyIdentity.status ===
                "UNREACHABLE" ? (
                <ChecklistWarningRow title="Portal proxy could not be checked">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Could not reach ${proxyIdentity.url}${
                      proxyIdentity.detail ? ` (${proxyIdentity.detail})` : ""
                    } — likely a network hiccup between the app host and the store. Reload this page to re-check; this warning does not block go-live.`}
                  </Text>
                </ChecklistWarningRow>
              ) : (
                <ChecklistRow
                  done={proxyIdentity.status === "OK"}
                  title="Portal proxy answers as Cellexia"
                  detail={
                    proxyIdentity.status === "OK"
                      ? `${proxyIdentity.url} answered as this app — the store-domain portal path is Cellexia's.`
                      : `Something else answered at ${proxyIdentity.url}${
                          proxyIdentity.detail
                            ? ` (${proxyIdentity.detail})`
                            : ""
                        } — another app may be occupying this proxy path — the app proxy config may not be deployed, or a colliding app owns it; run npm run deploy and check the other app's proxy settings.`
                  }
                />
              )}
              {/* Non-blocking warning: another subscription app is running on
                  this store. Going live does not touch it, and moving its
                  subscribers over is a separate, manual step. */}
              {otherAppsPresent ? (
                <ChecklistWarningRow title="Another subscription app is running on this store">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {otherApps.foreignContracts > 0
                        ? `${otherApps.foreignContracts} subscription${otherApps.foreignContracts === 1 ? "" : "s"} on this store ${otherApps.foreignContracts === 1 ? "is" : "are"} managed by another app`
                        : "Another app's subscription plans are attached to products on this store"}
                      {otherApps.unknownContracts > 0
                        ? `, and ${otherApps.unknownContracts} could not be attributed to any app`
                        : ""}
                      .
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Going live does <strong>not</strong> touch them: Cellexia
                      never bills, emails, modifies or reports on a subscription
                      it does not own, so nobody gets charged twice. Moving
                      those subscribers to Cellexia is a separate step — cancel
                      them in the other app first, never leave both apps billing
                      the same subscription.
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Details below, in “Other subscription apps”. Full runbook:
                      docs/OPERATIONS.md → “Running alongside another
                      subscription app”; migration steps: docs/MIGRATION.md.
                    </Text>
                  </BlockStack>
                </ChecklistWarningRow>
              ) : null}
            </BlockStack>
          </BlockStack>
        </Card>

        {/* ── Other subscription apps ── */}
        {otherAppsPresent ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Other subscription apps
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Shopify sends every subscription contract on this store to every
                subscription app installed on it. Cellexia mirrors them so you
                can see them here, but it will never bill, email, modify or
                count a subscription another app created — that stays entirely
                with the other app.
              </Text>

              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <Box
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="headingLg">
                      {String(otherApps.ownContracts)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Managed by Cellexia — billed, emailed and reported on
                      here.
                    </Text>
                  </BlockStack>
                </Box>
                <Box
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="headingLg">
                      {String(otherApps.foreignContracts)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Managed by another app — Cellexia will never charge or
                      contact them.
                    </Text>
                  </BlockStack>
                </Box>
                <Box
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="headingLg">
                      {String(otherApps.unknownContracts)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Could not be attributed to any app — treated as not ours,
                      so never charged. Claim them on the Subscribers page if
                      they are yours.
                    </Text>
                  </BlockStack>
                </Box>
              </InlineGrid>

              {otherApps.groupsReadable && otherApps.foreignGroups.length > 0 ? (
                <BlockStack gap="200">
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Subscription plans on this store that are not Cellexia's
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    These selling plan groups belong to another app. Where they
                    sit on the same product as a Cellexia plan, the product page
                    can show two subscribe widgets — Cellexia only ever renders
                    its own, so switch the other app's widget off on those
                    products before you go live.
                  </Text>
                  {otherApps.foreignGroups.map((group) => (
                    <Text as="p" variant="bodySm" key={group.id}>
                      {`${group.name}${group.merchantCode ? ` (${group.merchantCode})` : ""} — ${
                        group.productTitles.length > 0
                          ? group.productTitles.join(", ")
                          : "no products attached"
                      }`}
                    </Text>
                  ))}
                </BlockStack>
              ) : null}

              {otherApps.unknownContracts > 0 ? (
                <Banner
                  tone="warning"
                  title={`${otherApps.unknownContracts} subscription${otherApps.unknownContracts === 1 ? " has" : "s have"} not been attributed to any app yet`}
                >
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      Unattributed means “not proven to be ours”, and Cellexia
                      treats that as not ours: those subscriptions are never
                      charged, emailed or counted — including any that really
                      are yours. Re-checking reads each one back from Shopify
                      and attributes it from the selling plan on its lines.
                    </Text>
                    <Text as="p" variant="bodySm">
                      Do this before you go live. Going live runs the same
                      check automatically.
                    </Text>
                  </BlockStack>
                </Banner>
              ) : null}

              <InlineStack gap="300" wrap>
                <Button
                  loading={recheckFetcher.state !== "idle"}
                  onClick={() =>
                    recheckFetcher.submit(
                      { intent: "recheck-ownership" },
                      { method: "post" },
                    )
                  }
                >
                  Re-check subscription ownership
                </Button>
                {otherApps.foreignContracts > 0 || otherApps.unknownContracts > 0 ? (
                  <Button url="/app/subscribers" variant="plain">
                    Review them on the Subscribers page
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        ) : null}

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
            ) : previewableProducts.length === 0 ? (
              /* Every synced product is a dead end. Saying so — with the
                 reason per product — beats offering a link that opens a 404
                 or a product page this app deliberately renders nothing on. */
              <Banner
                tone="warning"
                title="No product can be previewed yet"
                action={{ content: "Open Plans", url: "/app/plans" }}
              >
                <BlockStack gap="100">
                  <p>
                    The plan is synced, but none of its products can show the
                    widget on the storefront right now:
                  </p>
                  {products.map((p) => (
                    <Text as="p" variant="bodySm" key={p.id}>
                      {`${p.title} — ${p.blockedReason}`}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : (
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box minWidth="280px">
                    <Select
                      label="Product"
                      options={products.map((p) => ({
                        label: p.blockedReason
                          ? `${p.title} — ${p.blockedReason}`
                          : p.title,
                        value: p.handle,
                        disabled: p.blockedReason !== null,
                      }))}
                      value={productHandle}
                      onChange={setProductHandle}
                    />
                  </Box>
                  <Button
                    variant="primary"
                    disabled={!productHandle}
                    loading={storefrontFetcher.state !== "idle"}
                    onClick={() => submitStorefrontPreview(false)}
                  >
                    Preview on product page
                  </Button>
                </InlineStack>
                {blockedPreviewReport ? (
                  <Banner
                    tone="critical"
                    title="The preview would open a blank page — here's why"
                  >
                    <BlockStack gap="300">
                      <DoctorReportView report={blockedPreviewReport} />
                      <Box>
                        <Button
                          loading={storefrontFetcher.state !== "idle"}
                          onClick={() => submitStorefrontPreview(true)}
                        >
                          Open anyway
                        </Button>
                      </Box>
                    </BlockStack>
                  </Banner>
                ) : null}
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
            <Divider />
            {/* ── Preview Doctor ── */}
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Preview Doctor
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Widget not showing? This checks every gate between your plan
                and the live product page — plan sync, product attachment,
                storefront allow-list, app proxy, deployed extension and launch
                mode — against the live store, and names the first one that's
                closed. Read-only: nothing on the store is changed.
              </Text>
              <InlineStack gap="300" blockAlign="end" wrap>
                {products.length > 0 ? (
                  <Box minWidth="280px">
                    <Select
                      label="Product to diagnose"
                      options={products.map((p) => ({
                        label: p.title,
                        value: p.handle,
                      }))}
                      value={doctorProductHandle}
                      onChange={setDoctorProductHandle}
                    />
                  </Box>
                ) : null}
                <Button
                  loading={doctorFetcher.state !== "idle"}
                  onClick={() =>
                    doctorFetcher.submit(
                      { intent: "run-doctor", productId: doctorProductId },
                      { method: "post" },
                    )
                  }
                >
                  Run diagnosis
                </Button>
              </InlineStack>
              {doctorFetcher.data?.report ? (
                <DoctorReportView report={doctorFetcher.data.report} />
              ) : null}
            </BlockStack>
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
                    helpText="Opens directly on your live store. Valid for 1 hour; every action is disabled, so it's safe to share with your staff."
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
                    helpText="Opens directly on your live store. Valid for 1 hour. Read-only — nothing you click changes their subscription, so it's safe to share with your staff."
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
                {`• The customer portal opens at ${PORTAL_PROXY_BASE}`}
              </Text>
              <Text as="p" variant="bodySm">
                • Renewal billing, reminders, dunning and win-back start running
                on schedule
              </Text>
              <Text as="p" variant="bodySm">
                • Customer emails/SMS and Klaviyo events start sending
              </Text>
            </BlockStack>
            {otherAppsPresent ? (
              <Banner
                tone="warning"
                title="Another subscription app is running on this store"
              >
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    Going live does not touch its subscriptions: Cellexia never
                    bills, emails or modifies a subscription it does not own, so
                    nobody is charged twice. Migrating those subscribers to
                    Cellexia is a separate step — see docs/MIGRATION.md.
                  </Text>
                  <Text as="p" variant="bodySm">
                    {otherApps.unknownContracts > 0
                      ? `Going live re-checks ownership first, which should attribute the ${otherApps.unknownContracts} subscription${otherApps.unknownContracts === 1 ? "" : "s"} still unattributed. Until one is proven ours it is never charged.`
                      : "Going live re-checks ownership first, so nothing is charged before it has been attributed."}
                  </Text>
                </BlockStack>
              </Banner>
            ) : null}
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
