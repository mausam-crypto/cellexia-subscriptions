import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import { getShopMetafield } from "~/lib/graphql/metafields.server";
import { getProducts } from "~/lib/graphql/products.server";
import {
  findProductsMissingFromGroup,
  getCurrentAppId,
  getSellingPlanGroupOwnershipStates,
} from "~/lib/graphql/sellingPlans.server";
import {
  PLAN_GROUPS_METAFIELD_KEY,
  PLAN_GROUPS_METAFIELD_NAMESPACE,
  numericIdFromGid,
  parsePlanIdsJson,
} from "~/lib/ownership/ownership.server";
import { getLaunchState, probeProxyIdentity } from "./launch.server";

/**
 * Preview Doctor — walks the storefront-widget render chain and says WHICH
 * gate is closed.
 *
 * The widget only appears when ~7 independent gates all open — extension
 * deployed + app embed enabled, plan synced, group actually attached to the
 * product, allow-list metafield published, launch gate, valid preview token +
 * reachable proxy, JS mount — and every failure mode used to look identical:
 * a blank product page. This module turns that black box into a step list a
 * merchant can act on, in chain order, each step reporting PASS / FAIL /
 * WARN / SKIP with a detail line and a remediation.
 *
 * Contract: every step is independently contained (a throwing step reports
 * FAIL with the error, never crashes the doctor), nothing is cached — every
 * run probes the live store — and one admin.action event
 * ({action:"preview_doctor_run"}) records the verdict.
 *
 * Id spaces (the v1.6.6 lesson, do not regress): `group_on_product` compares
 * Admin API group GIDs against Admin API reads — one id space, exact equality
 * is reliable. `allow_list` mirrors what storefront Liquid actually gates on
 * (v1.6.9): numeric ids, and ownership needs BOTH an EXACT plan-set match —
 * the group's live plan ids equal to one published `planSets` entry, same
 * members, same count (storefront Liquid exposes group ids in a different,
 * opaque id space, so the group-id field is inert there, and the legacy
 * any-member `planIds` rule is gone) — AND an app-id match: the metafield's
 * appId must be this app's own id, VERBATIM (the snippet never trims), and
 * the group itself must carry that id as its stamped `app_id` — Shopify
 * leaves `app_id` nil unless the app stamps it, so a group synced before
 * v1.6.9 renders NOTHING until re-stamped. An allow-list missing either
 * factor, an unstamped group, or a live plan set no published set covers
 * must fail this step; a false PASS here is a dark storefront with a green
 * dashboard.
 */

export type DoctorStepStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface DoctorStep {
  key: string;
  label: string;
  status: DoctorStepStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  steps: DoctorStep[];
  verdict: "READY" | "BLOCKED";
  /** Key of the first FAIL step, when BLOCKED. */
  firstBlockedStep?: string;
}

/** Everything a step needs off a SellingPlanConfig row. */
interface DoctorConfigRow {
  id: string;
  name: string;
  active: boolean;
  syncStatus: string;
  syncError: string | null;
  shopifyGroupId: string | null;
  shopifyPlanIds: unknown;
  productIds: unknown;
}

const STOREFRONT_FETCH_TIMEOUT_MS = 6_000;

/** A normal desktop browser UA — storefront CDNs vary responses on UA. */
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Markers that prove OUR markup reached the storefront HTML. Any one of them
 * — even inside hidden/launch-gated markup — proves the extension is deployed,
 * the embed/block is enabled on the published theme, and the product carries
 * selling plan groups (the Liquid renders nothing otherwise).
 */
export const STOREFRONT_MARKERS = [
  "cx-buybox",
  "data-cellexia-embed",
  "BEGIN app snippet: cx-buybox-core",
] as const;

const REMEDIATIONS = {
  plan_config:
    "Create a plan on the Plans page and press Sync to Shopify; the sync error (if any) is shown on the plan row.",
  product_in_plan:
    "This product isn't part of your plan — edit the plan on the Plans page and add it, then re-sync.",
  group_on_product:
    "The plan is synced but Shopify doesn't show it attached to this product — press Sync to Shopify again.",
  allow_list:
    "Press Sync to Shopify on the Plans page — the sync stamps our app id onto the selling plan group and republishes the allow-list.",
  proxy:
    "The app configuration isn't deployed — run npm run deploy from the app folder, then retry. A 404 here means Shopify has no proxy registered for this app.",
  storefront_markup:
    "The extension isn't reaching the storefront: confirm the app embed toggle is ON in Theme editor → Theme settings → App embeds on the PUBLISHED theme and saved, and that npm run deploy succeeded after the latest ZIP (deploys before v1.6.4 were rejected for size).",
} as const;

/** The step body's answer; `key`/`label` are added by the runner. */
type StepOutcome = Omit<DoctorStep, "key" | "label">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse a Prisma Json column that should hold a list of strings. */
function stringList(value: unknown): string[] {
  return parsePlanIdsJson(value);
}

/** Can this config actually power the storefront widget? */
function isRenderableConfig(config: DoctorConfigRow): boolean {
  return (
    config.active &&
    config.syncStatus === "SYNCED" &&
    config.shopifyGroupId != null &&
    stringList(config.shopifyPlanIds).length > 0
  );
}

/** Why this config cannot power the widget, in merchant words. */
function configProblems(config: DoctorConfigRow): string[] {
  const problems: string[] = [];
  if (!config.active) problems.push("the plan is deactivated");
  if (config.syncStatus !== "SYNCED") {
    problems.push(
      `its sync status is ${config.syncStatus}${
        config.syncError ? ` (${config.syncError})` : ""
      }`,
    );
  }
  if (!config.shopifyGroupId) {
    problems.push("no Shopify selling plan group is recorded (never synced)");
  } else if (stringList(config.shopifyPlanIds).length === 0) {
    problems.push("no selling plan ids were recorded (the sync half-failed)");
  }
  return problems;
}

/**
 * Run the full diagnosis against the live store. Cache nothing — a doctor
 * that reports yesterday's store is worse than no doctor.
 */
export async function runPreviewDoctor(
  shopDomain: string,
  productId?: string,
): Promise<DoctorReport> {
  const steps: DoctorStep[] = [];

  // Shared, memoized lookups. Memoization is per-RUN only (nothing outlives
  // this call), so every run still reads the live store; it just avoids the
  // same run paying for the same read twice. A rejected promise is memoized
  // too — every dependent step then reports the same root failure.
  let shopPromise: Promise<{
    id: string;
    domain: string;
    primaryDomain: string | null;
  }> | null = null;
  const getShop = () => (shopPromise ??= requireShop(shopDomain));

  let adminPromise: Promise<AdminClient> | null = null;
  const getAdmin = () => (adminPromise ??= adminClientForShop(shopDomain));

  let configsPromise: Promise<DoctorConfigRow[]> | null = null;
  const getConfigs = () =>
    (configsPromise ??= getShop().then((shop) =>
      prisma.sellingPlanConfig.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          active: true,
          syncStatus: true,
          syncError: true,
          shopifyGroupId: true,
          shopifyPlanIds: true,
          productIds: true,
        },
      }),
    ));

  // Each step is independently contained: a throw becomes a FAIL row with the
  // error text and the step's standard remediation — never a crashed doctor.
  async function runStep(
    key: keyof typeof REMEDIATIONS | "launch_mode",
    label: string,
    body: () => Promise<StepOutcome>,
  ): Promise<void> {
    try {
      steps.push({ key, label, ...(await body()) });
    } catch (err) {
      steps.push({
        key,
        label,
        status: "FAIL",
        detail: `This check could not run: ${errorMessage(err)}`,
        remediation:
          key === "launch_mode" ? undefined : REMEDIATIONS[key],
      });
    }
  }

  const skipNoProduct: StepOutcome = {
    status: "SKIP",
    detail: "No product selected — pick a product to run this check.",
  };

  // ── a. plan_config ─────────────────────────────────────────────────────────
  await runStep("plan_config", "Subscription plan synced", async () => {
    const configs = await getConfigs();
    const renderable = configs.filter(isRenderableConfig);
    if (renderable.length > 0) {
      const first = renderable[0];
      const planCount = stringList(first.shopifyPlanIds).length;
      return {
        status: "PASS",
        detail: `“${first.name}” is active and synced — Shopify group ${
          numericIdFromGid(first.shopifyGroupId) ?? first.shopifyGroupId
        }, ${planCount} selling plan id${planCount === 1 ? "" : "s"} recorded.`,
      };
    }
    if (configs.length === 0) {
      return {
        status: "FAIL",
        detail: "No subscription plan exists yet — the widget has nothing to sell.",
        remediation: REMEDIATIONS.plan_config,
      };
    }
    const details = configs
      .map((c) => `“${c.name}”: ${configProblems(c).join("; ")}`)
      .join(" · ");
    return {
      status: "FAIL",
      detail: `${configs.length} plan${configs.length === 1 ? "" : "s"} found but none can power the widget — ${details}.`,
      remediation: REMEDIATIONS.plan_config,
    };
  });

  // ── b. product_in_plan ─────────────────────────────────────────────────────
  await runStep("product_in_plan", "Product is part of the plan", async () => {
    if (!productId) return skipNoProduct;
    const configs = await getConfigs();
    const containing = configs.filter((c) =>
      stringList(c.productIds).includes(productId),
    );
    if (containing.length > 0) {
      return {
        status: "PASS",
        detail: `This product is in plan “${containing[0].name}”.`,
      };
    }
    return {
      status: "FAIL",
      detail:
        configs.length === 0
          ? "There is no plan for this product to be part of."
          : `This product's id is not in any plan's product list (${configs
              .map((c) => `“${c.name}”`)
              .join(", ")}).`,
      remediation: REMEDIATIONS.product_in_plan,
    };
  });

  // ── c. group_on_product ────────────────────────────────────────────────────
  await runStep(
    "group_on_product",
    "Shopify shows the plan on this product",
    async () => {
      if (!productId) return skipNoProduct;
      const configs = await getConfigs();
      const withGroup = configs.filter((c) => c.shopifyGroupId != null);
      // Prefer the group(s) of the config(s) that claim this product; fall
      // back to every group we own so a wrong product list still gets an
      // honest attachment answer instead of a vacuous one.
      const claiming = withGroup.filter((c) =>
        stringList(c.productIds).includes(productId),
      );
      const candidates = claiming.length > 0 ? claiming : withGroup;
      if (candidates.length === 0) {
        return {
          status: "SKIP",
          detail:
            "No Shopify selling plan group exists to check — fix the plan sync first.",
        };
      }
      // Admin id space end to end (product GIDs + group GIDs from the Admin
      // API) — exact equality is reliable here, unlike storefront Liquid
      // group ids. Ownership on the storefront matches on PLAN ids instead;
      // that half is the allow_list step's job.
      const admin = await getAdmin();
      for (const candidate of candidates) {
        const missing = await findProductsMissingFromGroup(
          admin,
          candidate.shopifyGroupId as string,
          [productId],
        );
        if (missing.length === 0) {
          return {
            status: "PASS",
            detail: `Shopify confirms group ${
              numericIdFromGid(candidate.shopifyGroupId) ??
              candidate.shopifyGroupId
            } (“${candidate.name}”) is attached to this product.`,
          };
        }
      }
      return {
        status: "FAIL",
        detail: `Shopify does not list our selling plan group${
          candidates.length === 1 ? "" : "s"
        } (${candidates
          .map((c) => numericIdFromGid(c.shopifyGroupId) ?? c.shopifyGroupId)
          .join(", ")}) on this product — without it the product page renders nothing of ours.`,
        remediation: REMEDIATIONS.group_on_product,
      };
    },
  );

  // ── d. allow_list ──────────────────────────────────────────────────────────
  await runStep("allow_list", "Storefront allow-list published", async () => {
    const [configs, admin] = await Promise.all([getConfigs(), getAdmin()]);
    const metafield = await getShopMetafield(
      admin,
      PLAN_GROUPS_METAFIELD_NAMESPACE,
      PLAN_GROUPS_METAFIELD_KEY,
    );
    if (!metafield) {
      return {
        status: "FAIL",
        detail:
          "The cellexia.plan_groups shop metafield does not exist — the storefront allow-list was never published, so the widget renders nothing on every product.",
        remediation: REMEDIATIONS.allow_list,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(metafield.value);
    } catch {
      parsed = null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        status: "FAIL",
        detail:
          "The cellexia.plan_groups metafield exists but does not hold a JSON object — the widget treats that as an empty allow-list and renders nothing.",
        remediation: REMEDIATIONS.allow_list,
      };
    }
    const published = parsed as {
      groupIds?: unknown;
      planIds?: unknown;
      planSets?: unknown;
      appId?: unknown;
    };
    const publishedGroupIds = Array.isArray(published.groupIds)
      ? published.groupIds.map(String)
      : [];
    const publishedPlanIds = Array.isArray(published.planIds)
      ? published.planIds.map(String)
      : [];
    const publishedPlanSets = Array.isArray(published.planSets)
      ? published.planSets.map((set) =>
          Array.isArray(set) ? set.map(String) : [],
        )
      : [];
    // Mirror the snippet EXACTLY. Its `| append: ''` stringifies (so a JSON
    // number is as good as a string) but NEVER trims, and `!= blank` treats
    // a whitespace-only string as missing. So: whitespace-only → the
    // "missing" branch (gate closed), but a PADDED value is kept VERBATIM —
    // trimming it here would report a match the storefront will never make
    // (" 4477001" vs "4477001" is a dark widget), the exact false PASS this
    // step exists to prevent.
    const publishedAppId =
      typeof published.appId === "string" && published.appId.trim() !== ""
        ? published.appId
        : typeof published.appId === "number"
          ? String(published.appId)
          : null;

    const ownGroups = configs.filter((c) => c.shopifyGroupId != null);
    const preferred = ownGroups.filter(isRenderableConfig);
    const relevant = preferred.length > 0 ? preferred : ownGroups;
    if (relevant.length === 0) {
      return {
        status: "SKIP",
        detail:
          "No synced selling plan group to look for in the allow-list — fix the plan sync first.",
      };
    }
    const ownGroupNumericIds = relevant
      .map((c) => numericIdFromGid(c.shopifyGroupId))
      .filter((id): id is string => id != null);
    const ownPlanNumericIds = relevant
      .flatMap((c) => stringList(c.shopifyPlanIds))
      .map((id) => numericIdFromGid(id))
      .filter((id): id is string => id != null);

    const missingGroups = ownGroupNumericIds.filter(
      (id) => !publishedGroupIds.includes(id),
    );
    // The storefront's PRIMARY ownership factor is the PLAN ids (Liquid group
    // ids live in a different id space) — and BOTH lists must be non-empty
    // before it renders anything at all.
    const planIdPublished =
      ownPlanNumericIds.length === 0 ||
      ownPlanNumericIds.some((id) => publishedPlanIds.includes(id));

    const problems: string[] = [];
    if (missingGroups.length > 0) {
      problems.push(`missing our group id${missingGroups.length === 1 ? "" : "s"} ${missingGroups.join(", ")}`);
    }
    if (publishedPlanIds.length === 0) {
      problems.push(
        "its planIds list is empty — the widget requires plan ids and renders nothing",
      );
    } else if (!planIdPublished) {
      problems.push(
        "its planIds list contains none of our selling plan ids (the storefront matches on plan ids)",
      );
    }

    // The app-id factor, metafield half. The comparison is VERBATIM, like
    // the snippet's — a padded-but-right value gets its own message because
    // "the digits match" is precisely the trap.
    const ourAppId = await getCurrentAppId(admin);
    if (publishedAppId == null) {
      problems.push(
        "its appId field is missing — the widget requires an appId match alongside the plan sets and renders nothing until republished",
      );
    } else if (publishedAppId !== ourAppId) {
      if (publishedAppId.trim() === ourAppId) {
        problems.push(
          `its appId (${JSON.stringify(publishedAppId)}) carries stray whitespace around this app's id (${ourAppId}) — the storefront compares exactly and renders nothing; republish to fix`,
        );
      } else {
        problems.push(
          `its appId (${publishedAppId}) does not match this app's installed id (${ourAppId})`,
        );
      }
    }
    if (publishedPlanSets.length === 0) {
      problems.push(
        "its planSets field is missing or empty (published before v1.6.9?) — the widget requires an exact plan-set match and renders nothing until republished",
      );
    }

    // The group-side halves, against the LIVE Shopify state — exactly what
    // storefront Liquid will see: the group must be stamped with our app id
    // (`app_id` is nil on any group synced before v1.6.9), and its live
    // plan set must EXACTLY equal one published set (same members, same
    // count) — the storefront's other factor since v1.6.9.
    const groupGids = relevant
      .map((c) => c.shopifyGroupId)
      .filter((id): id is string => id != null);
    const states = await getSellingPlanGroupOwnershipStates(admin, groupGids);
    const unstamped = groupGids.filter(
      (gid) => states.get(gid)?.appId !== ourAppId,
    );
    if (unstamped.length > 0) {
      problems.push(
        `our selling plan group${unstamped.length === 1 ? "" : "s"} ${unstamped
          .map((gid) => numericIdFromGid(gid) ?? gid)
          .join(", ")} ${
          unstamped.length === 1 ? "does" : "do"
        } not carry our app id on Shopify (created before the app-id stamp, or the stamp failed) — the storefront requires the group-side app_id match and renders nothing from ${
          unstamped.length === 1 ? "it" : "them"
        }`,
      );
    }
    const setsAsKeys = new Set(
      publishedPlanSets.map((set) => [...set].sort().join(",")),
    );
    const uncovered = groupGids.filter((gid) => {
      const state = states.get(gid);
      if (!state) return false; // already reported as unstamped above
      const liveSet = state.planIds
        .map((id) => numericIdFromGid(id))
        .filter((id): id is string => id != null);
      if (liveSet.length === 0) return true;
      return !setsAsKeys.has([...liveSet].sort().join(","));
    });
    if (uncovered.length > 0) {
      problems.push(
        `the live plan set of group${uncovered.length === 1 ? "" : "s"} ${uncovered
          .map((gid) => numericIdFromGid(gid) ?? gid)
          .join(", ")} matches no published planSets entry — the storefront requires exact set equality and renders nothing from ${
          uncovered.length === 1 ? "it" : "them"
        } until republished`,
      );
    }

    if (problems.length > 0) {
      return {
        status: "FAIL",
        detail: `The allow-list is published but ${problems.join("; ")}.`,
        remediation: REMEDIATIONS.allow_list,
      };
    }
    return {
      status: "PASS",
      detail: `cellexia.plan_groups is published and contains our group id${
        ownGroupNumericIds.length === 1 ? "" : "s"
      } (${ownGroupNumericIds.join(", ")}) plus ${publishedPlanIds.length} plan id${
        publishedPlanIds.length === 1 ? "" : "s"
      } and ${publishedPlanSets.length} plan set${
        publishedPlanSets.length === 1 ? "" : "s"
      }, its appId matches this app (${ourAppId}), and the group${
        groupGids.length === 1 ? " is" : "s are"
      } stamped with it and exactly covered.`,
    };
  });

  // ── e. proxy ───────────────────────────────────────────────────────────────
  await runStep("proxy", "App proxy answers as Cellexia", async () => {
    // Reuses the launch-checklist probe: mints a short-lived PREVIEW token
    // server-side and fetches the store-domain validate endpoint (~5s
    // timeout), requiring OUR {ok:true} JSON. Unlike the checklist row —
    // where a network hiccup is only a warning — the doctor treats every
    // non-answer as a FAIL: this exact probe is what the preview reveal will
    // run from the visitor's browser, so "unreachable now" blocks the preview
    // now.
    const shop = await getShop();
    const probe = await probeProxyIdentity(shop.id);
    if (probe.status === "OK") {
      return {
        status: "PASS",
        detail: `${probe.url} answered { ok: true } to a token this app signed — the proxy is deployed and ours.`,
      };
    }
    let detail: string;
    if (probe.status === "UNREACHABLE") {
      detail = `${probe.url} could not be reached${
        probe.detail ? ` (${probe.detail})` : ""
      } — timeout or network failure.`;
    } else if (probe.detail === "HTTP 404") {
      detail = `${probe.url} returned HTTP 404 — Shopify has no app proxy registered on this path for this app.`;
    } else if (
      probe.detail === "non-JSON response body" ||
      probe.detail === "unexpected response body"
    ) {
      detail = `${probe.url} answered, but not with this app's response (${probe.detail}) — something else owns the path.`;
    } else {
      detail = `${probe.url} did not answer as this app${
        probe.detail ? ` (${probe.detail})` : ""
      }.`;
    }
    return { status: "FAIL", detail, remediation: REMEDIATIONS.proxy };
  });

  // ── f. storefront_markup — the end-to-end probe ────────────────────────────
  await runStep(
    "storefront_markup",
    "Widget markup reaches the live product page",
    async () => {
      if (!productId) return skipNoProduct;
      const [shop, admin] = await Promise.all([getShop(), getAdmin()]);
      const [product] = await getProducts(admin, [productId]);
      if (!product) {
        return {
          status: "FAIL",
          detail:
            "The product could not be read from the Admin API (deleted?) — there is no product page to probe.",
          remediation: REMEDIATIONS.product_in_plan,
        };
      }
      const status = (product.status ?? "").toUpperCase();
      if (status === "DRAFT" || status === "ARCHIVED") {
        return {
          status: "FAIL",
          detail: `The product is ${status} in Shopify — its storefront page does not exist, so nothing can render there.`,
          remediation:
            "Set the product to Active in Shopify, then re-run the diagnosis.",
        };
      }
      if (!product.handle) {
        return {
          status: "FAIL",
          detail: "The product has no handle — its storefront URL cannot be built.",
          remediation: REMEDIATIONS.product_in_plan,
        };
      }
      const host = shop.primaryDomain ?? shop.domain;
      const url = `https://${host}/products/${encodeURIComponent(product.handle)}`;

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        STOREFRONT_FETCH_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "user-agent": DESKTOP_UA,
            accept: "text/html,application/xhtml+xml",
          },
        });
      } catch (err) {
        // The fetch itself failing proves nothing about the theme — the app
        // host may simply not reach the storefront. Inconclusive, not FAIL.
        const reason =
          err instanceof Error && err.name === "AbortError"
            ? `no answer within ${STOREFRONT_FETCH_TIMEOUT_MS / 1000}s`
            : errorMessage(err);
        return {
          status: "WARN",
          detail: `Could not fetch ${url} (${reason}) — the probe is inconclusive; open the page in your browser and check manually.`,
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.url.includes("/password")) {
        return {
          status: "WARN",
          detail: `${url} redirected to the storefront password page — the probe cannot see the product page. Inconclusive; use your preview link (it carries your browser session past the password).`,
        };
      }
      if (!response.ok) {
        return {
          status: "WARN",
          detail: `${url} answered HTTP ${response.status} — could be bot protection or a storefront hiccup; the probe is inconclusive. Open the page in your browser and check manually.`,
        };
      }

      const html = await response.text();
      const marker = STOREFRONT_MARKERS.find((m) => html.includes(m));
      if (marker) {
        return {
          status: "PASS",
          detail: `Found “${marker}” in the live page HTML — the extension is deployed, the embed/block is enabled, and the product page carries our markup (hidden until revealed is expected).`,
        };
      }
      return {
        status: "FAIL",
        detail: `Fetched ${url} (HTTP ${response.status}, ${Math.round(
          html.length / 1024,
        )} KB) and found none of our markers — the extension's markup is not reaching the storefront.`,
        remediation: REMEDIATIONS.storefront_markup,
      };
    },
  );

  // ── g. launch_mode — informational, PASS either way ────────────────────────
  await runStep("launch_mode", "Launch mode", async () => {
    const shop = await getShop();
    const launch = await getLaunchState(shop.id);
    return {
      status: "PASS",
      detail:
        launch.mode === "SETUP"
          ? "SETUP — the widget is hidden from visitors; your preview link reveals it only in your browser."
          : "LIVE — the widget is visible to every store visitor.",
    };
  });

  const firstBlocked = steps.find((step) => step.status === "FAIL");
  const report: DoctorReport = {
    steps,
    verdict: firstBlocked ? "BLOCKED" : "READY",
    ...(firstBlocked ? { firstBlockedStep: firstBlocked.key } : {}),
  };

  // One audit event per run; logEvent never throws, but the shop read can —
  // a doctor run must never crash on its own bookkeeping.
  try {
    const shop = await getShop();
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      payload: {
        action: "preview_doctor_run",
        verdict: report.verdict,
        firstBlockedStep: report.firstBlockedStep ?? null,
        productId: productId ?? null,
      },
    });
  } catch (err) {
    console.error("[doctor] preview_doctor_run event failed", err);
  }

  return report;
}
