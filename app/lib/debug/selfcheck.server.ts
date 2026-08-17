import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas, type SettingsKey } from "~/lib/settings/registry.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import { getShopMetafield } from "~/lib/graphql/metafields.server";
import { getCurrentAppId } from "~/lib/graphql/sellingPlans.server";
import { getGrantedAccessScopes } from "~/lib/graphql/appInstallation.server";
import {
  getLaunchState,
  launchFlagDiverged,
  probeProxyIdentity,
  readLaunchMetafield,
  type LaunchState,
} from "~/lib/launch/launch.server";
import { STOREFRONT_MARKERS } from "~/lib/launch/doctor.server";
import {
  WIDGET_MARKETS_METAFIELD_KEY,
  WIDGET_MARKETS_METAFIELD_NAMESPACE,
  auditSelectedHandles,
  marketAllowed,
  parseHiddenMarketFromHtml,
  readWidgetMarketsMetafield,
  widgetMarketsDiverged,
} from "~/lib/widget/widget-markets.server";
import { listMarkets } from "~/lib/graphql/markets.server";
import {
  OURS_ONLY,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  PLAN_GROUPS_METAFIELD_KEY,
  PLAN_GROUPS_METAFIELD_NAMESPACE,
  parsePlanIdsJson,
} from "~/lib/ownership/ownership.server";
import {
  mintPreviewToken,
  verifyPreviewToken,
} from "~/lib/portal/previewToken.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { verifyMailer } from "~/lib/notifications/mailer.server";
import {
  isKlaviyoConfigured,
  probeKlaviyoKey,
  resolveKlaviyoAuth,
} from "~/lib/klaviyo/client.server";
import { UNCOVERED_STATUSES } from "~/lib/klaviyo/flows.server";
import {
  renderEmail,
  TEMPLATES,
  type TemplateKey,
} from "~/lib/notifications/templates.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";
import { normalizeEmailDesign } from "~/lib/notifications/format";
import { isEncryptedSecret, revealSecret } from "~/lib/crypto/secrets.server";
import { getProducts } from "~/lib/graphql/products.server";
import { JOB_SCHEDULE, LOCK_LEASE_MS } from "~/lib/jobs/runner.server";

/**
 * Live self-check — the engine behind the admin Debug tab.
 *
 * The Preview Doctor answers "why is the buy box not rendering on THIS
 * product page"; this module answers the wider question the merchant asked
 * for by name: "is every key feature of this app actually functional ON THE
 * DEPLOYED STORE, right now?" — billing pipeline, dunning/retries, customer
 * portal, webhooks, jobs, notifications, Klaviyo, configuration and data
 * integrity. Most of what it verifies cannot be seen from a local checkout:
 * a proxy that Shopify never registered, an APP_SIGNING_SECRET that differs
 * between processes, webhooks that stopped arriving, a mailer that verifies
 * nowhere, granted scopes that drifted from requested ones.
 *
 * Contract (mirrors the doctor's): every check is independently contained —
 * a throwing check reports FAIL with the error, never crashes the run — and
 * nothing is cached across runs; every run probes the live store. Checks
 * only READ: no check mutates a contract, sends a notification, or touches
 * Shopify state. The engine runs every 30 minutes via the ungated
 * `selfcheck_run` job (it derives state and touches no customer — catching a
 * dead proxy BEFORE go-live is its whole point), persists the latest report
 * to the machine-written `selfCheck` setting, raises ONE deduped CRITICAL
 * `SELF_CHECK_FAILED` alert while broken (which emails the admins), and
 * auto-resolves that alert when the run comes back clean.
 */

export type SelfCheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export type SelfCheckCategory =
  | "Platform"
  | "Shopify connection"
  | "Launch & storefront"
  | "Customer portal"
  | "Billing"
  | "Dunning & retries"
  | "Jobs"
  | "Notifications"
  | "Data integrity";

export interface SelfCheckResult {
  key: string;
  label: string;
  category: SelfCheckCategory;
  status: SelfCheckStatus;
  detail: string;
  remediation?: string;
  /** Wall-clock cost of this check, for spotting slow probes. */
  ms: number;
}

export type SelfCheckVerdict = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface SelfCheckReport {
  ranAt: string;
  tookMs: number;
  trigger: "job" | "admin";
  /** BROKEN = any FAIL; DEGRADED = any WARN; HEALTHY otherwise. */
  verdict: SelfCheckVerdict;
  passCount: number;
  warnCount: number;
  failCount: number;
  skipCount: number;
  checks: SelfCheckResult[];
}

export const SELF_CHECK_ALERT_TYPE = "SELF_CHECK_FAILED";

// Freshness / staleness thresholds. Where a threshold mirrors another
// module's behavior, the source is named — drift here makes the check lie.
const BILLING_FRESH_MINUTES = 30; // matches /api/health BILLING_FRESHNESS_MS
const PENDING_STUCK_HOURS = 25; // scheduler STALE_EXPIRE_HOURS (24h) + the
// stale_attempt_sweep's 30-min cadence (runner registry) + slack. The sweep
// only becomes ELIGIBLE to expire an unresolved PENDING attempt at exactly
// 24h and runs on its own tick, so a check at the bare 24h boundary FAILs
// attempts the very next sweep tick expires on schedule — a false CRITICAL
// that self-resolves minutes later. Only older than expiry + a full cadence
// means the sweep itself is not doing its job.
const SETTLEMENT_LAG_HOURS = 26; // SUCCESS_REDRIVE_MIN_AGE_MS (24h30m) + slack
const FAILED_UNSETTLED_MINUTES = 60; // DUNNING_CLAIM_LEASE_MS (10m) + slack
const OVERDUE_SLACK_HOURS = 48; // shop-tz day semantics + dunning-held cycles
const RETRY_BEHIND_HOURS = 6; // dunning sweep runs every 10 min
const EXHAUST_SLACK_DAYS = 3; // on top of settings.dunning.cancelAfterFailedDays
const WEBHOOK_SILENCE_HOURS = 48; // LIVE store with active subscribers
const OUTBOX_DUE_SLACK_MINUTES = 15; // klaviyo_flush runs every minute
const OUTBOX_OLD_HOURS = 12; // age-out DEADs events at 24h — half-way warning
const CLOCK_SKEW_WARN_MS = 60_000;
const CLOCK_SKEW_FAIL_MS = 300_000;
const STOREFRONT_FETCH_TIMEOUT_MS = 6_000;
const DB_SLOW_MS = 1_000;
// Flow coverage is refreshed at most daily (KLAVIYO_FLOW_COVERAGE alert
// budget) — a cache older than two of those windows means the refresh died.
const FLOW_COVERAGE_STALE_HOURS = 48;
// A lease can never legitimately reach further than LOCK_LEASE_MS into the
// future (acquire and every renewal set now + LOCK_LEASE_MS); 2× is the
// unambiguous "no code path wrote this" line.
const WEDGED_LOCK_MS = LOCK_LEASE_MS * 2;
// How many plan products to read when picking a live PDP to probe.
const STOREFRONT_PROBE_PRODUCTS = 5;
// The exact gate attribute cx-buybox-core.liquid renders while the
// cellexia.launch_status metafield is anything but byte-exact "live"
// (tests/liquid/render.test.ts pins the Liquid half).
const LAUNCH_GATED_ATTR = 'data-cellexia-gated="true"';
// Attributes cx-buybox-core.liquid renders ONLY after its market gate passed
// (the widget root, gated or not, and the no-owned-group marker; an excluded
// market renders neither — tests/liquid/market-visibility.test.ts pins it).
// Their presence therefore proves the storefront judged the market allowed.
const MARKET_GATE_PASSED_ATTRS = [
  "data-cellexia-buybox",
  "data-cellexia-no-owned-group",
] as const;

/** A normal desktop browser UA — storefront CDNs vary responses on UA. */
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

async function fetchWithTimeout(
  url: string,
  redirect: RequestRedirect,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    STOREFRONT_FETCH_TIMEOUT_MS,
  );
  try {
    return await fetch(url, {
      redirect,
      signal: controller.signal,
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html" },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-run context (memoized shared resources, doctor-style) ────────────────

interface ShopRow {
  id: string;
  domain: string;
  primaryDomain: string | null;
}

class CheckContext {
  readonly now: Date;
  readonly shop: ShopRow;
  private adminPromise: Promise<AdminClient> | null = null;
  private launchPromise: Promise<LaunchState> | null = null;
  private appIdPromise: Promise<string> | null = null;

  constructor(shop: ShopRow, now: Date) {
    this.shop = shop;
    this.now = now;
  }

  /** Rejections are memoized too, so dependent checks report one root cause. */
  admin(): Promise<AdminClient> {
    this.adminPromise ??= adminClientForShop(this.shop.domain);
    return this.adminPromise;
  }

  launch(): Promise<LaunchState> {
    this.launchPromise ??= getLaunchState(this.shop.id);
    return this.launchPromise;
  }

  appId(): Promise<string> {
    this.appIdPromise ??= this.admin().then((admin) => getCurrentAppId(admin));
    return this.appIdPromise;
  }

  storefrontHost(): string {
    return this.shop.primaryDomain ?? this.shop.domain;
  }
}

type CheckOutcome = Omit<SelfCheckResult, "key" | "label" | "category" | "ms">;

interface CheckDef {
  key: string;
  label: string;
  category: SelfCheckCategory;
  /** Default remediation when the body FAILs by throwing. */
  remediation: string;
  run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

// ── The checks ───────────────────────────────────────────────────────────────

const CHECKS: CheckDef[] = [
  // ── Platform ───────────────────────────────────────────────────────────────
  {
    key: "database",
    label: "Database answers",
    category: "Platform",
    remediation:
      "Check DATABASE_URL and that the Postgres instance is up — nothing in the app works without it.",
    run: async () => {
      const started = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      const latency = Date.now() - started;
      if (latency > DB_SLOW_MS) {
        return {
          status: "WARN",
          detail: `Database answered in ${latency}ms — unusually slow; billing and portal requests share this latency.`,
          remediation:
            "Check database load/plan sizing; sustained slowness delays every renewal sweep.",
        };
      }
      return { status: "PASS", detail: `Database answered in ${latency}ms.` };
    },
  },
  {
    key: "migrations",
    label: "Database migrations applied",
    category: "Platform",
    remediation:
      "Run `npx prisma migrate deploy` on the deployed app — a half-applied migration set makes code and schema disagree in unpredictable places.",
    run: async () => {
      const rows = await prisma.$queryRaw<
        Array<{ migration_name: string }>
      >`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`;
      if (rows.length > 0) {
        return {
          status: "FAIL",
          detail: `Unfinished or rolled-back migrations: ${rows
            .map((r) => r.migration_name)
            .join(", ")}.`,
        };
      }
      return { status: "PASS", detail: "All migrations finished cleanly." };
    },
  },
  {
    key: "app_secrets",
    label: "Required configuration present",
    category: "Platform",
    remediation:
      "Set the missing variables in the deployed environment (.env / host secrets) and restart the app.",
    run: async (ctx) => {
      const required = [
        "DATABASE_URL",
        "SHOPIFY_API_KEY",
        "SHOPIFY_API_SECRET",
        "SHOPIFY_APP_URL",
        "APP_SIGNING_SECRET",
      ];
      const missing = required.filter((name) => !process.env[name]);
      if (process.env.SCHEDULER_MODE === "external" && !process.env.CRON_SECRET) {
        missing.push("CRON_SECRET (required when SCHEDULER_MODE=external)");
      }
      if (missing.length > 0) {
        return {
          status: "FAIL",
          detail: `Missing environment variables: ${missing.join(", ")}.`,
        };
      }
      if (!(await isKlaviyoConfigured(ctx.shop.id))) {
        return {
          status: "WARN",
          detail:
            "No Klaviyo API key is configured (Settings → Klaviyo connection, or KLAVIYO_PRIVATE_API_KEY) — lifecycle email falls back to direct SMTP and SMS is suppressed entirely.",
          remediation:
            "Add the key on the Settings page (or set the env var; docs/KLAVIYO_SETUP.md) if Klaviyo flows are expected to fire.",
        };
      }
      return { status: "PASS", detail: "All required variables are set." };
    },
  },
  {
    key: "mailer",
    label: "Email transport deliverable",
    category: "Platform",
    remediation:
      "Fix the email transport under Settings → Email delivery (or the MAIL_PROVIDER/SMTP_* environment fallback) — OTP codes, 3DS links and admin alerts ride this transport alone, even with Klaviyo configured.",
    run: async (ctx) => {
      const status = await verifyMailer(ctx.shop.id);
      const sourceLabel =
        status.source === "settings"
          ? "configured on the Settings page"
          : "configured via environment variables";
      if (!status.ok) {
        return {
          status: "FAIL",
          detail: `Mailer not deliverable (provider ${status.provider}, ${sourceLabel}): ${status.error ?? "verification failed"}.`,
        };
      }
      if (status.provider === "console") {
        return {
          status: status.implicitFallback ? "WARN" : "PASS",
          detail: status.implicitFallback
            ? "Mail provider fell back to console implicitly — fine in development, an outage in production."
            : `Console mail provider chosen explicitly (${sourceLabel}) — emails are logged, not delivered.`,
        };
      }
      return { status: "PASS", detail: `SMTP transport verified (${sourceLabel}).` };
    },
  },
  {
    key: "clock_skew",
    label: "App and database clocks agree",
    category: "Platform",
    remediation:
      "Fix NTP on the app host or database — schedule math compares app-side dates against DB timestamps, and skew silently shifts every renewal.",
    run: async (ctx) => {
      const rows = await prisma.$queryRaw<
        Array<{ db_now: Date }>
      >`SELECT now() AS db_now`;
      const dbNow = rows[0]?.db_now;
      if (!dbNow) {
        return { status: "WARN", detail: "Could not read the database clock." };
      }
      const skew = Math.abs(dbNow.getTime() - ctx.now.getTime());
      if (skew > CLOCK_SKEW_FAIL_MS) {
        return {
          status: "FAIL",
          detail: `Clocks differ by ${Math.round(skew / 1000)}s.`,
        };
      }
      if (skew > CLOCK_SKEW_WARN_MS) {
        return {
          status: "WARN",
          detail: `Clocks differ by ${Math.round(skew / 1000)}s.`,
        };
      }
      return {
        status: "PASS",
        detail: `Clocks agree (${Math.round(skew / 1000)}s apart).`,
      };
    },
  },

  // ── Shopify connection ─────────────────────────────────────────────────────
  {
    key: "admin_api",
    label: "Shopify Admin API reachable",
    category: "Shopify connection",
    remediation:
      "The offline access token is missing or revoked — reinstall/re-authorize the app (open it once from the Shopify admin). Billing, plan sync and contract edits all need this token.",
    run: async (ctx) => {
      const appId = await ctx.appId();
      return {
        status: "PASS",
        detail: `Admin API answered; this app's Shopify id is ${appId}.`,
      };
    },
  },
  {
    key: "api_scopes",
    label: "Granted API scopes match requested",
    category: "Shopify connection",
    remediation:
      "Run `npm run deploy` and re-open the app from the Shopify admin to approve the new scopes — a missing scope fails exactly one mutation, on the live store, at the worst moment.",
    run: async (ctx) => {
      const requested = (process.env.SCOPES ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (requested.length === 0) {
        return {
          status: "WARN",
          detail:
            "SCOPES is not set in the environment, so granted scopes cannot be diffed against requested ones.",
          remediation:
            "Set SCOPES in .env to the value in shopify.app.toml (docs/INSTALL.md keeps them in sync).",
        };
      }
      const granted = new Set(await getGrantedAccessScopes(await ctx.admin()));
      const missing = requested.filter((scope) => !granted.has(scope));
      if (missing.length > 0) {
        return {
          status: "FAIL",
          detail: `Requested but not granted: ${missing.join(", ")}.`,
        };
      }
      return {
        status: "PASS",
        detail: `All ${requested.length} requested scopes are granted.`,
      };
    },
  },
  {
    key: "webhook_delivery",
    label: "Webhooks arriving",
    category: "Shopify connection",
    remediation:
      "Run `npm run deploy` (webhooks are registered from shopify.app.toml on deploy) and check the host is publicly reachable — billing attempt OUTCOMES only ever arrive by webhook, so a silent webhook feed means charges whose results this app never learns.",
    run: async (ctx) => {
      const [latest, failedRecent, live, activeOurs] = await Promise.all([
        prisma.webhookReceipt.findFirst({
          orderBy: { receivedAt: "desc" },
          select: { receivedAt: true, topic: true },
        }),
        prisma.webhookReceipt.count({
          where: {
            status: "FAILED",
            receivedAt: { gte: hoursAgo(ctx.now, 24) },
          },
        }),
        ctx.launch().then((launch) => launch.mode === "LIVE"),
        prisma.subscriptionContract.count({
          where: {
            shopId: ctx.shop.id,
            status: "ACTIVE",
            isDemo: false,
            ...OURS_ONLY,
          },
        }),
      ]);

      if (!latest) {
        return {
          status: live ? "FAIL" : "WARN",
          detail: live
            ? "No webhook has EVER been received while the store is live."
            : "No webhook received yet — normal for a fresh install; will turn FAIL after go-live.",
        };
      }
      const silentSince = latest.receivedAt.getTime();
      const silentHours = (ctx.now.getTime() - silentSince) / 3_600_000;
      if (live && activeOurs > 0 && silentHours > WEBHOOK_SILENCE_HOURS) {
        // Silence alone is not an outage: every registered topic is
        // activity-driven, and a small store can be genuinely quiet for 48h.
        // FAIL only on positive evidence something SHOULD have arrived: a
        // billing attempt started since the last webhook (its outcome only
        // ever arrives via SUBSCRIPTION_BILLING_ATTEMPTS_*), old enough
        // that in-flight processing cannot explain the silence.
        const missingOutcomes = await prisma.billingAttempt.count({
          where: {
            startedAt: {
              gte: latest.receivedAt,
              lte: hoursAgo(ctx.now, 1),
            },
          },
        });
        if (missingOutcomes > 0) {
          return {
            status: "FAIL",
            detail: `${missingOutcomes} billing attempt(s) started since the last webhook (${Math.round(silentHours)}h ago) — their outcomes only arrive by webhook and none did.`,
          };
        }
        return {
          status: "PASS",
          detail: `No webhook for ${Math.round(silentHours)}h, but no local activity expected one — a quiet store, not a broken feed.`,
        };
      }
      if (failedRecent > 0) {
        return {
          status: "WARN",
          detail: `${failedRecent} webhook(s) failed processing in the last 24h — the WEBHOOK_FAILURES alert and settlement_redrive job own recovery; check the Alerts page.`,
          remediation:
            "Open Alerts and the Audit page to see which topic is failing and why.",
        };
      }
      return {
        status: "PASS",
        detail: `Last webhook (${latest.topic}) arrived ${Math.round(silentHours * 10) / 10}h ago; none failed in the last 24h.`,
      };
    },
  },
  {
    key: "app_proxy",
    label: "App proxy answers as Cellexia",
    category: "Shopify connection",
    remediation:
      "Run `npm run deploy` from the app folder — a 404 means Shopify has no proxy registered for this app, and without it the whole customer portal is unreachable.",
    run: async (ctx) => {
      let probe = await probeProxyIdentity(ctx.shop.id);
      if (probe.status === "UNREACHABLE") {
        // One egress blip at an unattended 30-min tick must not become a
        // CRITICAL email (this check runs ON the app host — a host that is
        // down runs nothing, so UNREACHABLE here is usually a network
        // hiccup). Confirm once; even a repeat grades WARN, because the
        // probe's own contract says UNREACHABLE proves nothing about
        // registration. MISMATCH — a real answer from the wrong app — is
        // deterministic and stays FAIL.
        probe = await probeProxyIdentity(ctx.shop.id);
      }
      if (probe.status === "OK") {
        return { status: "PASS", detail: `Proxy round-trip verified (${probe.url}).` };
      }
      if (probe.status === "UNREACHABLE") {
        return {
          status: "WARN",
          detail: `Proxy probe unreachable twice in a row: ${probe.detail ?? "no detail"} (${probe.url}) — inconclusive from this host; the portal_endtoend check below fails hard on a definite misconfiguration.`,
        };
      }
      return {
        status: "FAIL",
        detail: `Proxy answered but not as this app: ${probe.detail ?? "no detail"} (${probe.url}).`,
      };
    },
  },

  // ── Launch & storefront ────────────────────────────────────────────────────
  {
    key: "launch_flag",
    label: "Launch mode and storefront flag agree",
    category: "Launch & storefront",
    remediation:
      "Use “Re-sync storefront flag” on Preview & launch — the buy box gates on the metafield byte-for-byte, so a diverged flag is a dark (or prematurely live) storefront.",
    run: async (ctx) => {
      const [launch, flag] = await Promise.all([
        ctx.launch(),
        ctx.admin().then((admin) => readLaunchMetafield(admin)),
      ]);
      if (launchFlagDiverged(launch.mode, flag)) {
        return {
          status: "FAIL",
          detail: `App mode is ${launch.mode} but the cellexia.launch_status metafield reads ${flag === null ? "(missing)" : `"${flag}"`}.`,
        };
      }
      return {
        status: "PASS",
        detail: `Mode ${launch.mode}; storefront flag ${flag === null ? "(missing — dark either way)" : `"${flag}"`}.`,
      };
    },
  },
  {
    key: "widget_markets",
    label: "Market visibility setting and storefront agree",
    category: "Launch & storefront",
    remediation:
      "Preview & launch → Where the buy box shows → Re-sync — the buy box reads the cellexia.widget_markets metafield, so a diverged value shows (or hides) the widget in the wrong markets.",
    run: async (ctx) => {
      // v1.25.0: the setting is what the admin sees, the metafield is what
      // every product page reads. Compared the way Liquid evaluates it
      // (absent ⇔ all markets; "selected" lists as exact-string sets).
      const [setting, value] = await Promise.all([
        getSetting(ctx.shop.id, "widgetMarkets"),
        ctx.admin().then((admin) => readWidgetMarketsMetafield(admin)),
      ]);
      const wanted =
        setting.mode === "selected"
          ? `only ${setting.handles.length} market(s): ${setting.handles.join(", ")}`
          : "all markets";
      if (widgetMarketsDiverged(setting, value)) {
        return {
          status: "FAIL",
          detail: `The app says the buy box shows in ${wanted}, but the ${WIDGET_MARKETS_METAFIELD_NAMESPACE}.${WIDGET_MARKETS_METAFIELD_KEY} metafield reads ${value === null ? "(missing)" : value.length > 200 ? `${value.slice(0, 200)}…` : value}.`,
        };
      }
      const synced = `storefront metafield ${value === null ? "(absent — every market, as the default demands)" : "matches"}`;
      if (setting.mode !== "selected") {
        return { status: "PASS", detail: `Buy box shown in ${wanted}; ${synced}.` };
      }
      // Setting and metafield agree — but do the saved handles still name
      // LIVE markets? Save validates handles against the market list, yet a
      // market can be deleted, renamed or left as a draft afterwards (or was
      // a draft when picked); the Liquid then matches no visitor and the buy
      // box is dark in every market with every other check green. Judged
      // against the live list; an unreadable list is a note, never a verdict.
      let markets: Awaited<ReturnType<typeof listMarkets>>;
      try {
        markets = await listMarkets(await ctx.admin());
      } catch (err) {
        return {
          status: "PASS",
          detail: `Buy box shown in ${wanted}; ${synced}. Could not verify the selected handles against the live market list (${errorMessage(err)}) — re-run in a moment.`,
        };
      }
      const audit = auditSelectedHandles(setting, markets);
      const editHint =
        "Preview & launch → Where the buy box shows — edit the list so it names only markets that exist and are active on this shop.";
      const problems = [
        ...audit.missing.map((h) => `“${h}” is no longer a market on this shop`),
        ...audit.disabled.map((h) => `“${h}” is a draft/disabled market (no visitor resolves it)`),
      ];
      if (audit.live.length === 0) {
        return {
          status: "FAIL",
          detail: `None of the selected markets is a live market on this shop (${problems.join("; ")}) — the buy box is hidden in EVERY market although the setting and the storefront metafield agree.`,
          remediation: editHint,
        };
      }
      if (problems.length > 0) {
        return {
          status: "WARN",
          detail: `Selected market ${problems.join("; ")} — the buy box shows only in the remaining ${audit.live.length}: ${audit.live.join(", ")}.`,
          remediation: editHint,
        };
      }
      return {
        status: "PASS",
        detail: `Buy box shown in ${wanted}; ${synced}; every selected handle is a live market.`,
      };
    },
  },
  {
    key: "selling_plans",
    label: "Selling plans synced",
    category: "Launch & storefront",
    remediation:
      "Open Plans and press Sync to Shopify; the failing plan row shows the sync error.",
    run: async (ctx) => {
      const configs = await prisma.sellingPlanConfig.findMany({
        where: { shopId: ctx.shop.id, active: true },
        select: { name: true, syncStatus: true, syncError: true },
      });
      const errored = configs.filter((c) => c.syncStatus === "ERROR");
      const pending = configs.filter((c) => c.syncStatus === "PENDING");
      if (errored.length > 0) {
        return {
          status: "FAIL",
          detail: `Plan(s) failed to sync: ${errored
            .map((c) => `${c.name} (${c.syncError ?? "no error recorded"})`)
            .join("; ")}.`,
        };
      }
      if (configs.length === 0) {
        return {
          status: "WARN",
          detail:
            "No active subscription plan exists — the buy box renders nothing and no subscription can be sold.",
        };
      }
      if (pending.length > 0) {
        return {
          status: "WARN",
          detail: `Plan(s) not yet synced to Shopify: ${pending.map((c) => c.name).join(", ")}.`,
        };
      }
      return {
        status: "PASS",
        detail: `${configs.length} active plan(s), all synced.`,
      };
    },
  },
  {
    key: "plan_groups_allowlist",
    label: "Storefront ownership allow-list published",
    category: "Launch & storefront",
    remediation:
      "Press Sync to Shopify on the Plans page — the sync stamps our app id onto the selling plan group and republishes the cellexia.plan_groups allow-list the buy box gates on.",
    run: async (ctx) => {
      const metafield = await ctx
        .admin()
        .then((admin) =>
          getShopMetafield(
            admin,
            PLAN_GROUPS_METAFIELD_NAMESPACE,
            PLAN_GROUPS_METAFIELD_KEY,
          ),
        );
      const live = (await ctx.launch()).mode === "LIVE";
      if (!metafield) {
        return {
          status: live ? "FAIL" : "WARN",
          detail: `cellexia.plan_groups metafield is not published${live ? " — the buy box renders NOTHING on the live store" : " yet (fails closed: no widget until published)"}.`,
        };
      }
      let parsed: {
        appId?: unknown;
        planSets?: unknown;
      };
      try {
        parsed = JSON.parse(metafield.value) as typeof parsed;
      } catch {
        return {
          status: "FAIL",
          detail: "cellexia.plan_groups metafield holds unparsable JSON.",
        };
      }
      const appId = await ctx.appId();
      if (typeof parsed.appId !== "string" || parsed.appId !== appId) {
        return {
          status: "FAIL",
          detail: `Published appId ${JSON.stringify(parsed.appId ?? null)} does not match this app's id ${appId} — the storefront ownership factors cannot pass.`,
        };
      }
      const planSets = Array.isArray(parsed.planSets) ? parsed.planSets : [];
      if (planSets.length === 0) {
        return {
          status: live ? "FAIL" : "WARN",
          detail:
            "Published allow-list has no plan sets — no selling plan group can prove itself ours, so the buy box stays dark.",
        };
      }
      return {
        status: "PASS",
        detail: `Allow-list published: ${planSets.length} plan set(s), appId matches. (Deep factor verification runs daily via the OWNERSHIP_FACTORS sweep.)`,
      };
    },
  },
  {
    key: "storefront_reachable",
    label: "Storefront reachable",
    category: "Launch & storefront",
    remediation:
      "Check the shop's primary domain — if the app host cannot reach the storefront, preview diagnosis and metafield-driven rendering cannot be verified from here.",
    run: async (ctx) => {
      const url = `https://${ctx.storefrontHost()}/`;
      let response: Response;
      try {
        response = await fetchWithTimeout(url, "manual");
      } catch (err) {
        return {
          status: "WARN",
          detail: `Could not fetch ${url}: ${errorMessage(err)} — inconclusive from this host; verify the store loads in a browser.`,
        };
      }
      const location = response.headers.get("location") ?? "";
      if (response.status >= 300 && response.status < 400) {
        if (location.includes("password")) {
          return {
            status: "WARN",
            detail:
              "Storefront is password-protected. Redirects through the password page can drop query strings — the portal preview recovers automatically, but enter the password before judging a preview blank.",
          };
        }
        return {
          status: "PASS",
          detail: `Storefront redirects (${response.status} → ${location || "?"}) — normally a domain canonicalization.`,
        };
      }
      if (!response.ok) {
        return {
          status: "WARN",
          detail: `Storefront answered HTTP ${response.status}.`,
        };
      }
      return { status: "PASS", detail: `Storefront answered 200 at ${url}.` };
    },
  },
  {
    key: "storefront_widget",
    label: "Buy box present on a live product page",
    category: "Launch & storefront",
    remediation:
      "Confirm the app embed/block is still enabled on the PUBLISHED theme (Theme editor → App embeds) and the extension is deployed (`npm run deploy`) — a theme publish or editor change can silently remove the widget. The Preview Doctor on Preview & launch names the exact broken gate per product.",
    run: async (ctx) => {
      // End-to-end proof the merchant cannot get locally: fetch a REAL plan
      // product's page off the live theme and verify our markup is there,
      // gated exactly as the launch mode demands. Catches the failure
      // shapes only a deployed store exhibits — a theme publish that
      // dropped the app embed, an undeployed extension, a launch-status
      // metafield the THEME sees differently than the API reports.
      const configs = await prisma.sellingPlanConfig.findMany({
        where: {
          shopId: ctx.shop.id,
          active: true,
          syncStatus: "SYNCED",
          shopifyGroupId: { not: null },
        },
        orderBy: { createdAt: "asc" },
        select: { productIds: true },
      });
      const productIds = [
        ...new Set(configs.flatMap((c) => parsePlanIdsJson(c.productIds))),
      ];
      if (productIds.length === 0) {
        return {
          status: "SKIP",
          detail:
            "No synced plan with products yet — nothing to probe (the selling_plans check owns that half).",
        };
      }
      const products = await getProducts(
        await ctx.admin(),
        productIds.slice(0, STOREFRONT_PROBE_PRODUCTS),
      );
      const probeable = products.find(
        (p) => (p.status ?? "").toUpperCase() === "ACTIVE" && p.handle,
      );
      if (!probeable) {
        return {
          status: "WARN",
          detail: `None of the first ${Math.min(productIds.length, STOREFRONT_PROBE_PRODUCTS)} plan product(s) is ACTIVE with a handle — no live product page exists to probe.`,
          remediation:
            "Set at least one plan product to Active in Shopify — a plan whose products are all draft/archived can never sell.",
        };
      }
      const url = `https://${ctx.storefrontHost()}/products/${encodeURIComponent(
        probeable.handle as string,
      )}`;
      let response: Response;
      try {
        response = await fetchWithTimeout(url, "follow");
      } catch (err) {
        return {
          status: "WARN",
          detail: `Could not fetch ${url}: ${errorMessage(err)} — inconclusive from this host; open the page in a browser to verify the widget.`,
        };
      }
      if ((response.url ?? "").includes("/password")) {
        return {
          status: "WARN",
          detail:
            "The product page redirected to the storefront password page — inconclusive from this host; check the widget in a browser after entering the password.",
        };
      }
      if (!response.ok) {
        return {
          status: "WARN",
          detail: `${url} answered HTTP ${response.status} — could be bot protection or a storefront hiccup; inconclusive. Verify the widget in a browser.`,
        };
      }
      const html = await response.text();
      // Market visibility (v1.25.0) BEFORE the gate verdict: an excluded
      // market renders only the inert market-hidden template (which still
      // carries the app-snippet marker and no gate attribute), so a probe
      // from that market would otherwise report "visible as expected" while
      // LIVE (false) or "NOT launch-gated" while SETUP (false). Judge the
      // marker against the SETTING: hidden because the merchant asked for
      // it is a PASS; hidden while the setting allows the market means the
      // storefront metafield drifted — FAIL with the re-sync fix.
      const hiddenMarket = parseHiddenMarketFromHtml(html);
      if (hiddenMarket !== null) {
        const setting = await getSetting(ctx.shop.id, "widgetMarkets");
        const marketLabel = hiddenMarket
          ? `market “${hiddenMarket}”`
          : "a storefront that resolved no market handle";
        if (!marketAllowed(setting, hiddenMarket)) {
          return {
            status: "PASS",
            detail: `Widget hidden on ${url} (${marketLabel}) as your market setting demands — the launch gate is not judged from this market; the buy box is only shown in: ${setting.handles.join(", ") || "(none)"}.`,
          };
        }
        return {
          status: "FAIL",
          detail: `The storefront hides the widget on ${url} (${marketLabel}) but the app allows that market (${setting.mode === "selected" ? `only ${setting.handles.join(", ")}` : "all markets"}) — the cellexia.widget_markets metafield the theme reads has drifted from the setting.`,
          remediation:
            "Re-save the market setting on Preview & launch → Where the buy box shows (or press Re-sync there); if you changed it moments ago this can be page caching — re-run in a few minutes.",
        };
      }
      const marker = STOREFRONT_MARKERS.find((m) => html.includes(m));
      const live = (await ctx.launch()).mode === "LIVE";
      if (!marker) {
        return {
          status: live ? "FAIL" : "WARN",
          detail: live
            ? `Fetched ${url} and found none of our markup — the buy box is NOT on the live product page, so it sells nothing.`
            : `Our markup is not on ${url} yet — enable the app block/embed on the published theme before go-live (the go-live checklist tracks this).`,
        };
      }
      // The INVERSE market drift: the page rendered the widget (or the
      // no-owned-group marker — both only render once the Liquid's market
      // gate passed) although the setting EXCLUDES the market this host
      // serves. The probe hits the primary domain, i.e. the primary market,
      // and the rendered widget carries no market handle, so the handle
      // comes from the live market list. Real-world causes: the v1.25.0 ZIP
      // applied without `npm run deploy` (the pre-v1.25.0 Liquid ignores
      // the metafield and shows the buy box everywhere — the widget_markets
      // check still PASSes because setting and metafield agree), or a
      // metafield the theme cannot parse. Only judged under "selected" and
      // only when the page landed where it was asked (a market redirect —
      // e.g. a /en-us/ subfolder chosen for THIS host's location — would
      // render a market that is not the primary one, so the inference would
      // not hold); an unreadable market list is a note on the PASS, never a
      // verdict.
      let marketNote = "";
      const setting = await getSetting(ctx.shop.id, "widgetMarkets");
      const marketGatePassed = MARKET_GATE_PASSED_ATTRS.some((attr) =>
        html.includes(attr),
      );
      const landedElsewhere =
        Boolean(response.url) && !response.url.startsWith(url);
      if (setting.mode === "selected" && marketGatePassed && landedElsewhere) {
        marketNote = ` The page redirected to ${response.url}, so which market it rendered is unknown — the market rule was not judged.`;
      } else if (setting.mode === "selected" && marketGatePassed) {
        let primaryHandle: string | null = null;
        try {
          primaryHandle =
            (await listMarkets(await ctx.admin())).find((m) => m.primary)
              ?.handle ?? null;
        } catch (err) {
          marketNote = ` Could not verify the market rule against the live market list (${errorMessage(err)}) — re-run in a moment.`;
        }
        if (primaryHandle !== null && !marketAllowed(setting, primaryHandle)) {
          return {
            status: "FAIL",
            detail: `The buy box is rendered on ${url} although market “${primaryHandle}” (the primary market, which this host serves) is excluded by your setting (only ${setting.handles.join(", ")}) — the storefront extension is probably not deployed (the theme still runs a pre-v1.25.0 Liquid that ignores the market rule) or the cellexia.widget_markets metafield is stale.`,
            remediation:
              "Run `npm run deploy` from the app folder, then Preview & launch → Where the buy box shows → Re-sync; if you changed the setting moments ago this can be page caching — re-run in a few minutes.",
          };
        }
        if (primaryHandle === null && marketNote === "") {
          marketNote =
            " Could not tell which market this host serves (no primary market reported) — the market rule was not judged.";
        }
      }
      const gated = html.includes(LAUNCH_GATED_ATTR);
      if (live && gated) {
        return {
          status: "FAIL",
          detail: `The widget on ${url} is still launch-gated (hidden from every visitor) although the app is LIVE — the theme is reading a launch flag other than "live". If you went live moments ago this can be page caching; re-run in a few minutes, then use “Re-sync storefront flag” on Preview & launch.`,
        };
      }
      if (!live && !gated) {
        return {
          status: "FAIL",
          detail: `The widget on ${url} is NOT launch-gated although the app is in SETUP — visitors can see (and subscribe through) a widget that is supposed to be dark. Re-sync the storefront flag on Preview & launch.`,
        };
      }
      return {
        status: "PASS",
        detail: `Widget markup found on ${url} (“${marker}”), ${
          live ? "visible as expected for a LIVE store" : "launch-gated as expected in SETUP"
        }.${marketNote}`,
      };
    },
  },

  // ── Customer portal ────────────────────────────────────────────────────────
  {
    key: "portal_signing",
    label: "Portal token signing round-trip",
    category: "Customer portal",
    remediation:
      "APP_SIGNING_SECRET is unset, changed, or differs between app instances — every portal preview link, magic link and portal session cookie depends on it. Set ONE stable value in the deployed environment.",
    run: async (ctx) => {
      const token = mintPreviewToken(
        {
          shopId: ctx.shop.id,
          customerId: "gid://cellexia/selfcheck/customer",
          email: "selfcheck@cellexia-demo.invalid",
        },
        60,
      );
      const payload = verifyPreviewToken(token, ctx.shop.id);
      if (!payload) {
        return {
          status: "FAIL",
          detail:
            "A token minted by this process failed verification in the same process.",
        };
      }
      return {
        status: "PASS",
        detail: "Preview/magic-link signing verifies in-process.",
      };
    },
  },
  {
    key: "portal_endtoend",
    label: "Portal reachable through the store domain",
    category: "Customer portal",
    remediation:
      "The portal page is not coming back through Shopify's app proxy: run `npm run deploy` (registers the proxy), confirm the app host is publicly reachable, and re-test. Customers reach the portal ONLY through this path.",
    run: async (ctx) => {
      const url = `https://${ctx.storefrontHost()}${PORTAL_PROXY_BASE}/login`;
      let response: Response;
      try {
        response = await fetchWithTimeout(url, "follow");
      } catch {
        // Same flapping guard as app_proxy: retry a network failure once,
        // and grade a repeat WARN — deterministic answers (404, wrong
        // markup) below keep failing hard.
        try {
          response = await fetchWithTimeout(url, "follow");
        } catch (err) {
          return {
            status: "WARN",
            detail: `Could not fetch ${url} twice in a row: ${errorMessage(err)} — inconclusive from this host; open the portal in a browser to verify.`,
          };
        }
      }
      if (response.status === 404) {
        return {
          status: "FAIL",
          detail: `HTTP 404 at ${url} — Shopify has no app proxy registered for ${PORTAL_PROXY_BASE}.`,
        };
      }
      const finalUrl = response.url ?? "";
      if (finalUrl.includes("/password")) {
        return {
          status: "WARN",
          detail:
            "Portal fetch landed on the storefront password page — inconclusive from this host; open the portal in a browser after entering the password.",
        };
      }
      if (!response.ok) {
        return {
          status: "FAIL",
          detail: `HTTP ${response.status} at ${url}.`,
        };
      }
      const html = await response.text();
      if (!html.includes("data-cellexia-portal")) {
        return {
          status: "FAIL",
          detail:
            "The store answered 200 but the page contains no Cellexia portal markup — the proxy likely points at a different app or an old deployment.",
        };
      }
      return {
        status: "PASS",
        detail: `Portal page rendered end-to-end through the store domain (${url}).`,
      };
    },
  },
  {
    key: "portal_preview_ready",
    label: "Portal preview fixtures healthy",
    category: "Customer portal",
    remediation:
      "Use “Reset demo subscription” on Preview & launch — the demo contract must stay OURS (the portal renders OURS contracts only) and must keep its lines.",
    run: async (ctx) => {
      const demo = await prisma.subscriptionContract.findFirst({
        where: { shopId: ctx.shop.id, isDemo: true },
        select: { ownership: true, lines: { select: { id: true } } },
      });
      if (!demo) {
        return {
          status: "PASS",
          detail:
            "No demo contract yet — one is created on the first “Preview with a demo subscription” click.",
        };
      }
      if (demo.ownership !== OWNERSHIP_OURS) {
        return {
          status: "WARN",
          detail: `Demo contract ownership is ${demo.ownership} — the preview would open an empty portal (self-repairs on the next preview click).`,
        };
      }
      if (demo.lines.length === 0) {
        return {
          status: "WARN",
          detail: "Demo contract has no lines — the preview shows an empty portal.",
        };
      }
      return {
        status: "PASS",
        detail: `Demo contract ready (${demo.lines.length} line(s), ownership OURS).`,
      };
    },
  },

  // ── Billing ────────────────────────────────────────────────────────────────
  {
    key: "billing_heartbeat",
    label: "Billing scheduler heartbeat",
    category: "Billing",
    remediation:
      "The scheduler is not ticking: with SCHEDULER_MODE=internal check the app process is up; with external, check the cron is POSTing /api/jobs/run with the right x-cron-secret. Missed ticks are missed renewals.",
    run: async (ctx) => {
      const last = await prisma.jobRun.findFirst({
        where: { jobName: "billing_run" },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, error: true, stats: true },
      });
      if (!last) {
        return {
          status: "WARN",
          detail:
            "billing_run has never run — normal in the first minutes after install.",
        };
      }
      const ageMinutes =
        (ctx.now.getTime() - last.startedAt.getTime()) / 60_000;
      if (last.status === "FAILED") {
        return {
          status: "FAIL",
          detail: `Last billing_run FAILED ${Math.round(ageMinutes)}m ago: ${last.error ?? "no error recorded"}.`,
        };
      }
      if (ageMinutes > BILLING_FRESH_MINUTES) {
        return {
          status: "FAIL",
          detail: `Last billing_run was ${Math.round(ageMinutes)}m ago (cadence: 5m).`,
        };
      }
      const skipped =
        last.stats &&
        typeof last.stats === "object" &&
        (last.stats as Record<string, unknown>).skipped === "setup_mode";
      return {
        status: "PASS",
        detail: `billing_run ${last.status} ${Math.round(ageMinutes)}m ago${skipped ? " (setup mode — charges gated, heartbeat alive)" : ""}.`,
      };
    },
  },
  {
    key: "billing_pipeline",
    label: "No stuck billing attempts",
    category: "Billing",
    remediation:
      "Attempts are stuck past the sweeps' windows — check the stale_attempt_sweep / settlement_redrive job rows on the Audit page and the STUCK_CONTRACTS alert; these shapes self-heal only while those sweeps run.",
    run: async (ctx) => {
      const [stuckPending, unsettledSuccess, unsettledFailed] =
        await Promise.all([
          // PENDING older than the stale sweep's 24h expiry plus one sweep
          // cadence of slack (PENDING_STUCK_HOURS above) means the sweep is
          // not doing its job (age basis: startedAt ?? scheduledFor,
          // mirroring sweepStalePendingAttempts).
          prisma.billingAttempt.count({
            where: {
              status: "PENDING",
              OR: [
                { startedAt: { lte: hoursAgo(ctx.now, PENDING_STUCK_HOURS) } },
                {
                  startedAt: null,
                  scheduledFor: { lte: hoursAgo(ctx.now, PENDING_STUCK_HOURS) },
                },
              ],
            },
          }),
          prisma.billingAttempt.count({
            where: {
              status: "SUCCESS",
              settledAt: null,
              completedAt: { lte: hoursAgo(ctx.now, SETTLEMENT_LAG_HOURS) },
            },
          }),
          prisma.billingAttempt.count({
            where: {
              status: "FAILED",
              declineCategory: null,
              completedAt: {
                lte: minutesAgo(ctx.now, FAILED_UNSETTLED_MINUTES),
              },
            },
          }),
        ]);
      if (stuckPending > 0) {
        return {
          status: "FAIL",
          detail: `${stuckPending} billing attempt(s) PENDING for over ${PENDING_STUCK_HOURS}h — the stale-attempt sweep should have resolved or expired them.`,
        };
      }
      const warnings: string[] = [];
      if (unsettledSuccess > 0) {
        warnings.push(
          `${unsettledSuccess} SUCCESS attempt(s) unsettled past the redrive window`,
        );
      }
      if (unsettledFailed > 0) {
        warnings.push(
          `${unsettledFailed} FAILED attempt(s) without a decline category past the dunning lease`,
        );
      }
      if (warnings.length > 0) {
        return {
          status: "WARN",
          detail: `${warnings.join("; ")} — settlement_redrive should drain these.`,
        };
      }
      return {
        status: "PASS",
        detail: "No attempt is stuck past the sweeps' windows.",
      };
    },
  },
  {
    key: "billing_overdue",
    label: "No forgotten overdue renewals",
    category: "Billing",
    remediation:
      "These contracts are overdue with no attempt and no open dunning case — the billing sweep is not picking them up. Check billing_run stats on the Audit page and the contracts' cycle state on Subscribers.",
    run: async (ctx) => {
      if ((await ctx.launch()).mode !== "LIVE") {
        return {
          status: "SKIP",
          detail: "Billing is gated in setup mode — nothing can be overdue yet.",
        };
      }
      // Overdue + untouched: no attempt activity in the slack window and no
      // open dunning case. Dunning-held cycles (cycleHeld) keep an overdue
      // nextBillingDate BY DESIGN — those all have an open case or recent
      // attempt, so they do not match here.
      const overdue = await prisma.subscriptionContract.count({
        where: {
          shopId: ctx.shop.id,
          status: "ACTIVE",
          isDemo: false,
          ...OURS_ONLY,
          nextBillingDate: { lt: hoursAgo(ctx.now, OVERDUE_SLACK_HOURS) },
          billingAttempts: {
            none: {
              OR: [
                { status: "PENDING" },
                {
                  scheduledFor: { gte: hoursAgo(ctx.now, OVERDUE_SLACK_HOURS) },
                },
              ],
            },
          },
          dunningCases: {
            none: {
              state: {
                in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"],
              },
            },
          },
        },
      });
      if (overdue > 0) {
        return {
          status: "FAIL",
          detail: `${overdue} active contract(s) are ${OVERDUE_SLACK_HOURS}h+ overdue with no attempt and no dunning case.`,
        };
      }
      return {
        status: "PASS",
        detail: "Every due contract has been attempted or is dunning-held.",
      };
    },
  },
  {
    key: "double_charge_guard",
    label: "Idempotency holding (no double charges)",
    category: "Billing",
    remediation:
      "More than one non-superseded SUCCESS attempt exists for the same cycle — investigate the affected contracts on Subscribers IMMEDIATELY; this is the one invariant that guards customers' cards.",
    run: async () => {
      // Single-tenant assumption (like checkBillingRunFailed): BillingAttempt
      // has no shopId column.
      const rows = await prisma.$queryRaw<
        Array<{ contractId: string; cycleIndex: number; n: number }>
      >`SELECT "contractId", "cycleIndex", COUNT(*)::int AS n
        FROM "BillingAttempt"
        WHERE "status" = 'SUCCESS' AND "supersededAt" IS NULL
        GROUP BY "contractId", "cycleIndex"
        HAVING COUNT(*) > 1`;
      if (rows.length > 0) {
        return {
          status: "FAIL",
          detail: `${rows.length} contract cycle(s) have multiple successful charges: ${rows
            .slice(0, 5)
            .map((r) => `${r.contractId}#${r.cycleIndex}(${r.n})`)
            .join(", ")}${rows.length > 5 ? ", …" : ""}.`,
        };
      }
      return {
        status: "PASS",
        detail: "No cycle has more than one successful charge.",
      };
    },
  },
  {
    key: "renewal_readiness",
    label: "Every active subscription can renew",
    category: "Billing",
    remediation:
      "Open the affected subscribers — the billing sweep selects due contracts BY nextBillingDate, so an ACTIVE contract without one is silently never billed again. “Sync from Shopify” on the contract (or the nightly full_sync_reconcile) restores the schedule; if Shopify also has no date, set one on the subscriber page.",
    run: async (ctx) => {
      // Dunning-held cycles keep an OVERDUE date by design and PAUSED
      // contracts are a different status — an ACTIVE row with a NULL date is
      // the one shape no sweep can ever pick up: a paying subscriber who
      // silently stops receiving orders, with no error anywhere.
      const dateless = await prisma.subscriptionContract.count({
        where: {
          shopId: ctx.shop.id,
          status: "ACTIVE",
          isDemo: false,
          ...OURS_ONLY,
          nextBillingDate: null,
        },
      });
      if (dateless > 0) {
        const live = (await ctx.launch()).mode === "LIVE";
        return {
          status: live ? "FAIL" : "WARN",
          detail: `${dateless} ACTIVE contract(s) have no next billing date — the billing sweep can never select them, so they will never renew and the customer sees no error.`,
        };
      }
      return {
        status: "PASS",
        detail: "Every active contract carries a next billing date.",
      };
    },
  },

  // ── Dunning & retries ──────────────────────────────────────────────────────
  {
    key: "dunning_heartbeat",
    label: "Dunning sweep heartbeat",
    category: "Dunning & retries",
    remediation:
      "Same scheduler as billing (dunning_run, every 10 minutes) — if this is stale, failed payments are not being retried and recovery emails are not going out.",
    run: async (ctx) => {
      const last = await prisma.jobRun.findFirst({
        where: { jobName: "dunning_run" },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, error: true },
      });
      if (!last) {
        return {
          status: "WARN",
          detail: "dunning_run has never run — normal in the first minutes after install.",
        };
      }
      const ageMinutes =
        (ctx.now.getTime() - last.startedAt.getTime()) / 60_000;
      if (last.status === "FAILED") {
        return {
          status: "FAIL",
          detail: `Last dunning_run FAILED ${Math.round(ageMinutes)}m ago: ${last.error ?? "no error recorded"}.`,
        };
      }
      if (ageMinutes > BILLING_FRESH_MINUTES) {
        return {
          status: "FAIL",
          detail: `Last dunning_run was ${Math.round(ageMinutes)}m ago (cadence: 10m).`,
        };
      }
      return {
        status: "PASS",
        detail: `dunning_run ${last.status} ${Math.round(ageMinutes)}m ago.`,
      };
    },
  },
  {
    key: "dunning_cases",
    label: "No stalled dunning cases",
    category: "Dunning & retries",
    remediation:
      "A RETRYING case without a next retry can never fire or exhaust — open the case on the Dunning page; “Retry now” re-arms it. Overdue AWAITING cases mean the exhaust phase is behind.",
    run: async (ctx) => {
      const dunning = await getSetting(ctx.shop.id, "dunning");
      const contractScope = {
        shopId: ctx.shop.id,
        isDemo: false,
        ...OURS_ONLY,
      };
      const [zombies, behind, overdueAwaiting] = await Promise.all([
        // RETRYING + nextRetryAt null is the NORMAL in-flight shape while a
        // fired retry awaits its outcome webhook (fireRetry nulls the date;
        // the failure handler re-arms it) — during that whole window the
        // contract carries a PENDING attempt, so only the attemptless shape
        // is the true zombie (mid-tail death / attempt EXPIREd under it).
        prisma.dunningCase.count({
          where: {
            state: "RETRYING",
            nextRetryAt: null,
            contract: {
              is: {
                ...contractScope,
                billingAttempts: { none: { status: "PENDING" } },
              },
            },
          },
        }),
        // The sweep deliberately skips PAUSED contracts (resume re-enters
        // billing), so their stale nextRetryAt is by design, not a stall.
        prisma.dunningCase.count({
          where: {
            state: "RETRYING",
            nextRetryAt: { lt: hoursAgo(ctx.now, RETRY_BEHIND_HOURS) },
            contract: {
              is: { ...contractScope, status: { not: "PAUSED" } },
            },
          },
        }),
        prisma.dunningCase.count({
          where: {
            state: { in: ["AWAITING_CUSTOMER", "AWAITING_3DS"] },
            openedAt: {
              lt: hoursAgo(
                ctx.now,
                (dunning.cancelAfterFailedDays + EXHAUST_SLACK_DAYS) * 24,
              ),
            },
            contract: { is: contractScope },
          },
        }),
      ]);
      if (zombies > 0) {
        return {
          status: "FAIL",
          detail: `${zombies} RETRYING case(s) have no next retry scheduled — they can never fire or exhaust.`,
        };
      }
      const warnings: string[] = [];
      if (behind > 0) {
        warnings.push(
          `${behind} retry(ies) due over ${RETRY_BEHIND_HOURS}h ago and not fired`,
        );
      }
      if (overdueAwaiting > 0) {
        warnings.push(
          `${overdueAwaiting} awaiting case(s) past the ${dunning.cancelAfterFailedDays}-day exhaust window`,
        );
      }
      if (warnings.length > 0) {
        return { status: "WARN", detail: `${warnings.join("; ")}.` };
      }
      return {
        status: "PASS",
        detail: "Every open case has a live retry schedule or is within its window.",
      };
    },
  },
  {
    key: "dunning_config",
    label: "Retry ladder configuration coherent",
    category: "Dunning & retries",
    remediation:
      "Adjust the retry schedule on Settings → Failed payments — steps scheduled on/after the exhaust cutoff never run, which quietly shortens the recovery ladder the merchant thinks they configured.",
    run: async (ctx) => {
      // The schema validates each field alone; the cross-field trap is a
      // ladder that reaches past cancelAfterFailedDays — those steps are cut
      // off by exhaustion and never fire, invisibly, only on a live decline
      // playing out over weeks.
      const dunning = await getSetting(ctx.shop.id, "dunning");
      const problems: string[] = [];
      const deadRetries = dunning.softRetryDays.filter(
        (d) => d >= dunning.cancelAfterFailedDays,
      );
      if (deadRetries.length > 0) {
        problems.push(
          `retry day(s) ${deadRetries.join(", ")} fall on/after the ${dunning.cancelAfterFailedDays}-day exhaust cutoff and will never fire`,
        );
      }
      const deadEmails = dunning.emailLadderDays.filter(
        (d) => d >= dunning.cancelAfterFailedDays,
      );
      if (deadEmails.length > 0) {
        problems.push(
          `recovery email day(s) ${deadEmails.join(", ")} fall on/after the exhaust cutoff and will never send`,
        );
      }
      if (dunning.smsDay >= dunning.cancelAfterFailedDays) {
        problems.push(
          `the SMS day (${dunning.smsDay}) falls on/after the exhaust cutoff and will never send`,
        );
      }
      if (dunning.paydayAlign && dunning.paydaysOfMonth.length === 0) {
        problems.push(
          "payday alignment is on but no paydays are configured — retries fall back to raw offsets",
        );
      }
      if (problems.length > 0) {
        return { status: "WARN", detail: `${problems.join("; ")}.` };
      }
      return {
        status: "PASS",
        detail: `Ladder coherent: ${dunning.softRetryDays.length} retries, ${dunning.emailLadderDays.length} emails and the SMS all inside the ${dunning.cancelAfterFailedDays}-day window.`,
      };
    },
  },

  // ── Jobs ───────────────────────────────────────────────────────────────────
  {
    key: "jobs_health",
    label: "All background jobs running",
    category: "Jobs",
    remediation:
      "With SCHEDULER_MODE=internal the 60s tick died with the process; with external, the cron stopped calling /api/jobs/run. Check the host logs — every feature below the UI (billing, dunning, gifts, win-back, analytics, Klaviyo) rides these jobs.",
    run: async (ctx) => {
      const everRan = await prisma.jobRun.findFirst({ select: { id: true } });
      if (!everRan) {
        return {
          status: "FAIL",
          detail:
            "No job has EVER run — the scheduler tick is not reaching the runner.",
        };
      }
      const lastRuns = await Promise.all(
        JOB_SCHEDULE.map((job) =>
          prisma.jobRun
            .findFirst({
              where: { jobName: job.name },
              orderBy: { startedAt: "desc" },
              select: { status: true, startedAt: true },
            })
            .then((run) => ({ job, run })),
        ),
      );
      const stalled: string[] = [];
      const failed: string[] = [];
      for (const { job, run } of lastRuns) {
        if (!run) continue; // brand-new job on a fresh deploy
        const ageMinutes =
          (ctx.now.getTime() - run.startedAt.getTime()) / 60_000;
        if (run.status === "FAILED") {
          failed.push(job.name);
        }
        // 3× cadence (min 30m) of silence = stalled; FAILED runs re-arm after
        // 30m, so a persistently failing job shows in `failed` instead.
        if (ageMinutes > Math.max(job.everyMinutes * 3, 30)) {
          stalled.push(`${job.name} (${Math.round(ageMinutes)}m)`);
        }
      }
      if (stalled.length > 0) {
        return {
          status: "FAIL",
          detail: `Job(s) past 3× their cadence: ${stalled.join(", ")}.`,
        };
      }
      if (failed.length > 0) {
        return {
          status: "WARN",
          detail: `Last run FAILED for: ${failed.join(", ")} (auto-retries within 30m; the error is on the Audit page).`,
        };
      }
      return {
        status: "PASS",
        detail: `All ${JOB_SCHEDULE.length} jobs ran within their cadence.`,
      };
    },
  },
  {
    key: "job_locks",
    label: "No wedged job locks",
    category: "Jobs",
    remediation:
      "Delete the named JobLock row (its job re-creates it on the next tick) and check the database clock — the runner can only reclaim leases that have expired, so a lease stamped far in the future stops that job permanently and silently.",
    run: async (ctx) => {
      // acquire and every heartbeat renewal set lockedUntil = now +
      // LOCK_LEASE_MS, so a lease beyond 2× that horizon was not written by
      // any code path (DB clock jump, manual edit, corruption). Nothing can
      // reclaim it: jobs_health would only notice the symptom 3 cadences
      // later — for a daily job, three days of silent stoppage.
      const wedged = await prisma.jobLock.findMany({
        where: {
          lockedUntil: { gt: new Date(ctx.now.getTime() + WEDGED_LOCK_MS) },
        },
        select: { name: true, lockedUntil: true },
      });
      if (wedged.length > 0) {
        return {
          status: "FAIL",
          detail: `Job lock(s) leased impossibly far into the future: ${wedged
            .map(
              (l) =>
                `${l.name} (until ${l.lockedUntil.toISOString()})`,
            )
            .join(", ")} — the lease horizon is ${LOCK_LEASE_MS / 60_000}m, so these can never be reclaimed and the jobs are stopped.`,
        };
      }
      return {
        status: "PASS",
        detail: "No job lock is leased beyond the runner's horizon.",
      };
    },
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    key: "klaviyo_outbox",
    label: "Klaviyo outbox draining",
    category: "Notifications",
    remediation:
      "Events older than 24h are DEADed (never fired late, by design). Check the Klaviyo key (Settings → Klaviyo connection, or KLAVIYO_PRIVATE_API_KEY) and the klaviyo_flush job on the Audit page before the backlog ages out.",
    run: async (ctx) => {
      const pendingWhere = { status: { in: ["PENDING", "FAILED"] } };
      const [dueUndrained, oldest, expiredRecent] = await Promise.all([
        prisma.klaviyoOutbox.count({
          where: {
            ...pendingWhere,
            nextAttemptAt: {
              lte: minutesAgo(ctx.now, OUTBOX_DUE_SLACK_MINUTES),
            },
          },
        }),
        prisma.klaviyoOutbox.findFirst({
          where: pendingWhere,
          orderBy: { eventTime: "asc" },
          select: { eventTime: true },
        }),
        prisma.klaviyoOutbox.count({
          where: {
            status: "DEAD",
            lastError: { startsWith: "expired:" },
            eventTime: { gte: hoursAgo(ctx.now, 48) },
          },
        }),
      ]);
      if (!(await isKlaviyoConfigured(ctx.shop.id))) {
        if (dueUndrained > 0) {
          return {
            status: "WARN",
            detail: `${dueUndrained} event(s) queued with no Klaviyo API key configured (Settings or env) — they will age out DEAD after 24h without firing.`,
          };
        }
        return {
          status: "PASS",
          detail:
            "Klaviyo not configured; lifecycle email rides direct SMTP, SMS is suppressed. Nothing queued.",
        };
      }
      const oldestAgeHours = oldest
        ? (ctx.now.getTime() - oldest.eventTime.getTime()) / 3_600_000
        : 0;
      if (oldestAgeHours > OUTBOX_OLD_HOURS) {
        return {
          status: "FAIL",
          detail: `Oldest undelivered event is ${Math.round(oldestAgeHours)}h old — at 24h it is DEADed and its flow never fires.`,
        };
      }
      const warnings: string[] = [];
      if (dueUndrained > 0) {
        warnings.push(`${dueUndrained} due event(s) not yet drained`);
      }
      if (expiredRecent > 0) {
        warnings.push(`${expiredRecent} event(s) aged out DEAD in the last 48h`);
      }
      if (warnings.length > 0) {
        return { status: "WARN", detail: `${warnings.join("; ")}.` };
      }
      return { status: "PASS", detail: "Outbox is draining normally." };
    },
  },
  {
    key: "notification_failures",
    label: "Notifications delivering",
    category: "Notifications",
    remediation:
      "Open the failing NotificationLog rows via the Audit page — OTP, 3DS links and dunning emails ride this path; a failing transport is silent churn.",
    run: async (ctx) => {
      const [failedRecent, staleSuppressed, live] = await Promise.all([
        prisma.notificationLog.count({
          where: {
            shopId: ctx.shop.id,
            status: "FAILED",
            createdAt: { gte: hoursAgo(ctx.now, 24) },
          },
        }),
        prisma.notificationLog.count({
          where: {
            shopId: ctx.shop.id,
            status: "SUPPRESSED",
            createdAt: { gte: hoursAgo(ctx.now, 24) },
            payload: { path: ["reason"], equals: "setup_mode" },
          },
        }),
        ctx.launch().then((launch) => launch.mode === "LIVE"),
      ]);
      if (live && staleSuppressed > 0) {
        return {
          status: "WARN",
          detail: `${staleSuppressed} notification(s) suppressed as "setup_mode" in the last 24h although the app is LIVE — if these persist, the launch gate is being misread.`,
        };
      }
      if (failedRecent > 0) {
        return {
          status: "WARN",
          detail: `${failedRecent} notification send(s) FAILED in the last 24h.`,
        };
      }
      return {
        status: "PASS",
        detail: "No failed sends in the last 24h.",
      };
    },
  },
  {
    key: "klaviyo_key_live",
    label: "Klaviyo accepts the API key",
    category: "Notifications",
    remediation:
      "Re-enter the key under Settings → Klaviyo connection (or fix KLAVIYO_PRIVATE_API_KEY) — a revoked/rotated key means every lifecycle flow silently stops, and queued events age out DEAD after 24h.",
    run: async (ctx) => {
      // app_secrets only checks that a key EXISTS; this proves Klaviyo still
      // accepts it — a key revoked in Klaviyo's dashboard is invisible
      // locally until events start dying in the outbox.
      const auth = await resolveKlaviyoAuth(ctx.shop.id);
      if (!auth.apiKey) {
        return {
          status: "SKIP",
          detail:
            "No Klaviyo key configured — the required-configuration check reports this; nothing to probe.",
        };
      }
      const probe = await probeKlaviyoKey(auth.apiKey);
      const sourceLabel =
        auth.source === "settings"
          ? "stored on the Settings page"
          : "from the environment";
      if (probe.ok) {
        return {
          status: "PASS",
          detail: `Klaviyo accepted the key ${sourceLabel}. ${probe.detail}`,
        };
      }
      if (probe.transient) {
        return {
          status: "WARN",
          detail: `Klaviyo unreachable from this host — inconclusive; the key itself is unproven. ${probe.detail}`,
        };
      }
      return {
        status: "FAIL",
        detail: `Klaviyo rejected the key ${sourceLabel} — every flow-delivered email/SMS is silently dead. ${probe.detail}`,
      };
    },
  },
  {
    key: "klaviyo_flow_coverage",
    label: "Klaviyo flows cover the delivery metrics",
    category: "Notifications",
    remediation:
      "Open Emails → Set up my flows and re-run the guided setup — an uncovered metric means those customer emails fire an event that no flow delivers, so the customer receives nothing.",
    run: async (ctx) => {
      // Reads the machine-written cache (the guided setup / daily
      // KLAVIYO_FLOW_COVERAGE sweep own the Klaviyo API budget) — this check
      // makes the cached verdict visible every 30 minutes instead of only on
      // the Emails page.
      const setup = await getSetting(ctx.shop.id, "klaviyoFlowSetup");
      if (!setup.setupRanAt) {
        return {
          status: "SKIP",
          detail:
            "The guided flow setup has not been run — coverage is not tracked until it is (Emails → Set up my flows).",
        };
      }
      const uncovered = setup.rows.filter((r) =>
        UNCOVERED_STATUSES.has(r.status),
      );
      const errored = setup.rows.filter((r) => r.status === "error");
      // A run that Klaviyo's creation limit (or the run budget) ended early
      // leaves `rate_limited` rows, and a metric Klaviyo has not registered
      // yet stays `pending_metric` — neither is delivered, yet neither is
      // in UNCOVERED_STATUSES (the alert sweep deliberately waits for its
      // daily re-verify to turn them into a real "missing" rather than
      // nagging mid-setup). This check must not read them as covered.
      const waiting = setup.rows.filter(
        (r) => r.status === "rate_limited" || r.status === "pending_metric",
      );
      const problems: string[] = [];
      if (uncovered.length > 0) {
        problems.push(
          `${uncovered.length} metric(s) have no live flow delivering them: ${uncovered
            .map((r) => r.metric)
            .join(", ")}`,
        );
      }
      if (errored.length > 0) {
        problems.push(
          `${errored.length} metric(s) failed their last setup attempt: ${errored
            .map((r) => r.metric)
            .join(", ")}`,
        );
      }
      if (waiting.length > 0) {
        problems.push(
          `${waiting.length} metric(s) not covered yet — the last setup run stopped before them; open Emails → Klaviyo delivery setup and click Create my flows again: ${waiting
            .map((r) => r.metric)
            .join(", ")}`,
        );
      }
      if (problems.length > 0) {
        return { status: "WARN", detail: `${problems.join("; ")}.` };
      }
      const checkedAgeHours = setup.checkedAt
        ? (ctx.now.getTime() - new Date(setup.checkedAt).getTime()) / 3_600_000
        : Number.POSITIVE_INFINITY;
      if (
        checkedAgeHours > FLOW_COVERAGE_STALE_HOURS &&
        (await isKlaviyoConfigured(ctx.shop.id))
      ) {
        return {
          status: "WARN",
          detail: `The coverage cache is ${
            Number.isFinite(checkedAgeHours)
              ? `${Math.round(checkedAgeHours)}h old`
              : "missing a successful verification"
          } — the daily refresh is not completing, so this verdict may be stale.`,
          remediation:
            "Open Emails to trigger a fresh verification, and check the alerts_run job on the Audit page.",
        };
      }
      // Only what is TRUE: rows delivered by a live flow, by the app, or
      // deliberately off — never a bare row count.
      const covered = setup.rows.filter(
        (r) => r.status === "live" || r.status === "app_delivers" || r.status === "off",
      ).length;
      const other = setup.rows.length - covered;
      return {
        status: "PASS",
        detail: `All ${covered} delivery metrics are covered (cached verdict${
          setup.checkedAt ? `, verified ${Math.round(checkedAgeHours)}h ago` : ""
        })${other > 0 ? ` — ${other} row(s) not yet verified` : ""}.`,
      };
    },
  },
  {
    key: "email_templates",
    label: "Every email template renders cleanly",
    category: "Notifications",
    remediation:
      "Open the named template on the Emails page — its live preview shows exactly what broke. Built-in copy is pinned by tests; this almost always means a merchant override references a placeholder that template never receives.",
    run: async (ctx) => {
      // The tests pin built-in copy; the merchant's stored overrides are the
      // uncovered surface. Render every template through the REAL pipeline
      // (renderEmail — the same code both delivery shapes use) with the
      // shop's overrides and design applied: a throw here is a send-time
      // failure, a leftover {placeholder} reaches the customer as literal
      // braces.
      const [emails, designRaw] = await Promise.all([
        getSetting(ctx.shop.id, "emails"),
        getSetting(ctx.shop.id, "emailDesign"),
      ]);
      const design = normalizeEmailDesign(designRaw);
      const templates = emails.templates ?? {};
      const broken: string[] = [];
      const strays: string[] = [];
      for (const template of Object.keys(TEMPLATES) as TemplateKey[]) {
        const override = templates[template];
        try {
          const rendered = renderEmail(
            template,
            "en",
            previewSampleVars(template),
            {
              subject: override?.subject ?? "",
              body: override?.body ?? "",
            },
            design,
          );
          const strayTokens = [
            ...new Set(
              [
                ...`${rendered.subject}\n${rendered.text}`.matchAll(
                  /\{([a-z0-9_]+)\}/gi,
                ),
              ]
                .map((m) => m[1])
                .filter((token) => token !== "cta"),
            ),
          ];
          if (strayTokens.length > 0) {
            strays.push(`${template} ({${strayTokens.join("}, {")}})`);
          }
        } catch (err) {
          broken.push(`${template}: ${errorMessage(err)}`);
        }
      }
      if (broken.length > 0) {
        return {
          status: "FAIL",
          detail: `Template(s) throw on render — a real send will fail identically: ${broken.join("; ")}.`,
        };
      }
      if (strays.length > 0) {
        return {
          status: "WARN",
          detail: `Template(s) render with unresolved placeholders that customers would see as literal braces: ${strays.join("; ")}.`,
        };
      }
      return {
        status: "PASS",
        detail: `All ${Object.keys(TEMPLATES).length} templates render placeholder-free with the merchant's overrides and design applied.`,
      };
    },
  },

  // ── Data integrity ─────────────────────────────────────────────────────────
  {
    key: "settings_integrity",
    label: "Stored settings parse cleanly",
    category: "Data integrity",
    remediation:
      "getSetting silently falls back to DEFAULTS when a stored value no longer parses — re-save the named section on Settings so the merchant's intent (not the default) governs behavior.",
    run: async (ctx) => {
      const rows = await prisma.setting.findMany({
        where: { shopId: ctx.shop.id },
        select: { key: true, value: true },
      });
      const broken: string[] = [];
      for (const row of rows) {
        const schema = settingsSchemas[row.key as SettingsKey];
        if (!schema) continue; // orphaned key from an older version — inert
        if (!schema.safeParse(row.value).success) broken.push(row.key);
      }
      if (broken.length > 0) {
        return {
          status: "WARN",
          detail: `Stored settings no longer parse and defaults are silently in effect for: ${broken.join(", ")}.`,
        };
      }
      return {
        status: "PASS",
        detail: `${rows.length} stored setting group(s) all parse.`,
      };
    },
  },
  {
    key: "stored_secrets",
    label: "Stored credentials decrypt",
    category: "Data integrity",
    remediation:
      "Re-enter the named credential on the Settings page — an APP_SIGNING_SECRET rotation makes stored secrets undecryptable, and delivery silently falls back to the environment variables (which may be absent or stale).",
    run: async (ctx) => {
      // revealSecret never throws; a failed decrypt is exactly the silent
      // degradation the Klaviyo/mailer resolvers log-and-swallow. Surface it
      // where a human looks.
      const [klaviyo, mail] = await Promise.all([
        getSetting(ctx.shop.id, "klaviyo"),
        getSetting(ctx.shop.id, "mailTransport"),
      ]);
      const broken: string[] = [];
      if (
        klaviyo.privateApiKey &&
        isEncryptedSecret(klaviyo.privateApiKey) &&
        !revealSecret(klaviyo.privateApiKey).ok
      ) {
        broken.push("the Klaviyo private API key (Settings → Klaviyo connection)");
      }
      if (
        mail.smtpPass &&
        isEncryptedSecret(mail.smtpPass) &&
        !revealSecret(mail.smtpPass).ok
      ) {
        broken.push("the SMTP password (Settings → Email delivery)");
      }
      if (broken.length > 0) {
        return {
          status: "FAIL",
          detail: `Stored credential(s) can no longer be decrypted (APP_SIGNING_SECRET rotated?): ${broken.join("; ")} — delivery has silently fallen back to environment variables.`,
        };
      }
      const stored = [
        klaviyo.privateApiKey ? "Klaviyo key" : null,
        mail.smtpPass ? "SMTP password" : null,
      ].filter(Boolean);
      return {
        status: "PASS",
        detail:
          stored.length > 0
            ? `Stored credential(s) decrypt cleanly: ${stored.join(", ")}.`
            : "No credentials stored in Settings — environment variables are in use.",
      };
    },
  },
  {
    key: "event_provenance",
    label: "Contract events keep their contract link",
    category: "Data integrity",
    remediation:
      "Investigate on the Audit page — contract-scoped events with no contract mean a contract row was deleted outside the demo-reset path (real mirrors are history and must never be deleted), or a demo reset failed to delete its events with it.",
    run: async (ctx) => {
      // SubscriberEvent.contractId is onDelete:SetNull, and the ONLY legal
      // deleter is the demo reset — which must delete the demo's events too
      // (an orphaned event has lost its demo provenance forever). Any
      // contract-family event with a NULL contractId is therefore integrity
      // damage, not data.
      const orphaned = await prisma.subscriberEvent.count({
        where: {
          shopId: ctx.shop.id,
          contractId: null,
          OR: ["contract.", "cycle.", "billing.", "dunning."].map((prefix) => ({
            type: { startsWith: prefix },
          })),
        },
      });
      if (orphaned > 0) {
        return {
          status: "WARN",
          detail: `${orphaned} contract-scoped event(s) have lost their contract link — the audit timeline can no longer attribute them, and contract-less counters cannot filter them.`,
        };
      }
      return {
        status: "PASS",
        detail: "Every contract-scoped event still points at its contract.",
      };
    },
  },
  {
    key: "ownership_integrity",
    label: "Contract ownership attributed",
    category: "Data integrity",
    remediation:
      "Run “Re-check subscription ownership” on Preview & launch, then claim genuinely-ours rows on Subscribers — UNKNOWN contracts are excluded from billing and the portal (fail-safe), so a real subscriber stuck on UNKNOWN is silently unserved.",
    run: async (ctx) => {
      const [unknown, oursNoLines] = await Promise.all([
        prisma.subscriptionContract.count({
          where: {
            shopId: ctx.shop.id,
            isDemo: false,
            ownership: OWNERSHIP_UNKNOWN,
          },
        }),
        prisma.subscriptionContract.count({
          where: {
            shopId: ctx.shop.id,
            isDemo: false,
            status: "ACTIVE",
            ownership: OWNERSHIP_OURS,
            lines: { none: {} },
          },
        }),
      ]);
      const warnings: string[] = [];
      if (unknown > 0) {
        warnings.push(
          `${unknown} contract(s) have UNKNOWN ownership (treated as not ours everywhere it matters)`,
        );
      }
      if (oursNoLines > 0) {
        warnings.push(`${oursNoLines} active OURS contract(s) have no lines`);
      }
      if (warnings.length > 0) {
        return { status: "WARN", detail: `${warnings.join("; ")}.` };
      }
      return {
        status: "PASS",
        detail: "Every non-demo contract is attributed and shaped correctly.",
      };
    },
  },
  {
    key: "design_facts",
    label: "Design measurement facts",
    category: "Data integrity",
    remediation:
      "The nightly design_facts_backfill job rebuilds the missing SubscribableOrder rows from the checkout.subscribable event feed; a gap of a day is normal. If the gap keeps growing after a night, the ORDERS_CREATE fact write is failing: check the server log for “[webhooks] design fact failed”.",
    run: async (ctx) => {
      // The take-rate denominator has two ledgers since v1.26.0: the
      // checkout.subscribable event feed (the rollup's source) and the
      // SubscribableOrder fact table (the Results tab's source). Both are
      // written by ORDERS_CREATE for the same order set (one event per
      // order id, one row per order id), so over the WHOLE history they
      // must agree; facts falling behind means the Results tab is
      // under-reporting orders while the analytics rollup is not. Whole
      // history on purpose: the two sides do not share a clock (the event
      // is stamped when the webhook lands, the row carries the order's
      // processed_at, which an imported or API-created order may backdate
      // by weeks), so any windowed comparison produces false gaps at the
      // window edge. Seen coverage is reported for the recent rows only,
      // where the extension version actually shows.
      const since = hoursAgo(ctx.now, 30 * 24);
      const [events, facts, recentFacts, recentSeen] = await Promise.all([
        prisma.subscriberEvent.count({
          where: { shopId: ctx.shop.id, type: "checkout.subscribable" },
        }),
        prisma.subscribableOrder.count({
          where: { shopId: ctx.shop.id },
        }),
        prisma.subscribableOrder.count({
          where: { shopId: ctx.shop.id, processedAt: { gte: since } },
        }),
        prisma.subscribableOrder.count({
          where: {
            shopId: ctx.shop.id,
            processedAt: { gte: since },
            designSource: "seen",
          },
        }),
      ]);
      const coverage =
        recentFacts > 0
          ? ` Seen coverage: ${Math.round((recentSeen / recentFacts) * 100)}% of the last 30 days' fact rows carry the widget's seen marker.`
          : "";
      if (facts < events) {
        return {
          status: "WARN",
          detail: `${events - facts} subscribable order(s) have no design fact row (${events} event(s), ${facts} fact row(s) since install).${coverage}`,
        };
      }
      return {
        status: "PASS",
        detail:
          events === 0 && facts === 0
            ? "No subscribable orders yet; nothing to reconcile."
            : `${facts} design fact row(s) cover the ${events} subscribable order event(s) since install.${coverage}`,
      };
    },
  },
  {
    key: "widget_visits",
    label: "Widget visit beacon",
    category: "Data integrity",
    remediation:
      "Orders carrying the widget's seen marker prove the buy-box renders, so visits should be arriving too. Check that the v1.27.0 extension is deployed (npm run deploy) and that the Cellexia app embed is enabled in the theme editor: theme-block-only installs get no visit tracking. Then open a product page and look for a request to /apps/cellexia-subs/w?e=view in the network tab; a 204 means the beacon works.",
    run: async (ctx) => {
      // The Results tab's conversion column divides orders by VISITS
      // (WidgetVisitorDay, written by the storefront beacon since v1.27.0).
      // The beacon has two silent failure modes the server cannot see from
      // its own side: the app embed disabled in the theme (the embed JS is
      // what sends it) and an old extension still deployed. Both leave the
      // ledger empty while orders keep landing WITH the seen marker, and
      // that is the signature checked here: exposure orders in the last 7
      // days but no visit row in the same window. Not LIVE: nothing to
      // expect (SETUP renders the widget hidden and the beacon is silent).
      const live = (await ctx.launch()).mode === "LIVE";
      if (!live) {
        return {
          status: "PASS",
          detail:
            "Store is in setup mode; the visit beacon only records on a live store.",
        };
      }
      const since = hoursAgo(ctx.now, 7 * 24);
      const [visits, exposureOrders] = await Promise.all([
        prisma.widgetVisitorDay.count({
          where: { shopId: ctx.shop.id, lastSeenAt: { gte: since } },
        }),
        prisma.subscribableOrder.count({
          where: { shopId: ctx.shop.id, processedAt: { gte: since }, exposure: true },
        }),
      ]);
      if (visits > 0) {
        return {
          status: "PASS",
          detail: `${visits} visit row(s) recorded in the last 7 days.`,
        };
      }
      if (exposureOrders === 0) {
        return {
          status: "PASS",
          detail:
            "No visits and no widget-exposed orders in the last 7 days; nothing to reconcile yet.",
        };
      }
      return {
        status: "WARN",
        detail: `${exposureOrders} order(s) in the last 7 days carry the widget's seen marker but no visit was recorded: the beacon is not deployed, the app embed is disabled, or the request is blocked. Conversion per design cannot be computed until visits arrive.`,
      };
    },
  },
  {
    key: "open_alerts",
    label: "No unresolved critical alerts",
    category: "Data integrity",
    remediation:
      "Open the Alerts page — each alert carries its own context and the checks above only summarize them.",
    run: async (ctx) => {
      const open = await prisma.alert.findMany({
        where: {
          shopId: ctx.shop.id,
          resolvedAt: null,
          // Not our own alert: the self-check must never fail because of the
          // alert IT raised, or a broken run could hold itself broken forever.
          type: { not: SELF_CHECK_ALERT_TYPE },
        },
        select: { type: true, severity: true },
      });
      const critical = open.filter((a) => a.severity === "CRITICAL");
      if (critical.length > 0) {
        return {
          status: "FAIL",
          detail: `Open CRITICAL alert(s): ${[...new Set(critical.map((a) => a.type))].join(", ")}.`,
        };
      }
      if (open.length > 0) {
        return {
          status: "WARN",
          detail: `${open.length} open alert(s): ${[...new Set(open.map((a) => a.type))].join(", ")}.`,
        };
      }
      return { status: "PASS", detail: "No open alerts." };
    },
  },
  {
    key: "gift_promises",
    label: "Gift emails backed by real gifts",
    category: "Notifications",
    remediation:
      "Open the Gifts page and align each promise with a rule (or the gift pool): every email that mentions a gift must have machinery behind it.",
    run: async (ctx) => {
      // The v1.24.0 truth rule: an email may only promise what a grant will
      // ship. The engines gate their sends at runtime; this check surfaces
      // the CONFIGURATION drift behind those silent gates, so a promise
      // quietly suppressed for everyone shows up here instead of nowhere.
      const [lifecycle, cancelFlow, gifts] = await Promise.all([
        getSetting(ctx.shop.id, "lifecycle"),
        getSetting(ctx.shop.id, "cancelFlow"),
        getSetting(ctx.shop.id, "gifts"),
      ]);
      const rules = await prisma.giftRule.findMany({
        where: { shopId: ctx.shop.id, active: true },
        select: {
          trigger: true,
          orderIndex: true,
          daysSubscribed: true,
          selection: true,
        },
      });
      const hasOrderRule = (index: number): boolean =>
        rules.some((r) => r.trigger === "ORDER_INDEX" && r.orderIndex === index);
      const hasAnniversaryRule = rules.some(
        (r) => r.trigger === "DAYS_SUBSCRIBED",
      );
      const poolEmpty = gifts.pool.length === 0;

      const warnings: string[] = [];
      if (lifecycle.surpriseGiftOnCycle2 && !hasOrderRule(2)) {
        warnings.push(
          "the cycle-2 surprise is on but no ORDER_INDEX=2 rule exists (no gift ships, no teaser sends)",
        );
      }
      if (!hasOrderRule(lifecycle.milestoneGiftCycle)) {
        warnings.push(
          `no ORDER_INDEX=${lifecycle.milestoneGiftCycle} rule backs the milestone email's gift (it will send without its gift sentence)`,
        );
      }
      if (!hasAnniversaryRule) {
        warnings.push(
          "no DAYS_SUBSCRIBED rule exists — anniversary gifts never ship",
        );
      }
      if (poolEmpty) {
        const needers: string[] = [];
        if (rules.some((r) => r.selection === "DYNAMIC")) {
          needers.push("dynamic gift rules");
        }
        if (lifecycle.rewardsGiftEnabled) needers.push("the day-90 reward");
        if (cancelFlow.giftSaveEnabled) needers.push("the cancel-flow gift save");
        if (lifecycle.milestoneLadder.length > 0) {
          needers.push("milestone-ladder gifts");
        }
        if (needers.length > 0) {
          warnings.push(
            `the gift pool is empty but ${needers.join(", ")} depend(s) on it (each falls back or quietly skips)`,
          );
        }
      }
      if (warnings.length > 0) {
        return { status: "WARN", detail: `${warnings.join("; ")}.` };
      }
      return {
        status: "PASS",
        detail:
          "Every configured gift promise has an active rule or a stocked pool behind it.",
      };
    },
  },
];

/** Stable copy for tests and the Debug page's "what is covered" rendering. */
export const SELF_CHECK_KEYS: readonly string[] = CHECKS.map((c) => c.key);

// ── Runner ───────────────────────────────────────────────────────────────────

async function runOneCheck(
  check: CheckDef,
  ctx: CheckContext,
): Promise<SelfCheckResult> {
  const started = Date.now();
  try {
    const outcome = await check.run(ctx);
    return {
      key: check.key,
      label: check.label,
      category: check.category,
      status: outcome.status,
      detail: outcome.detail,
      remediation:
        outcome.remediation ??
        (outcome.status === "FAIL" || outcome.status === "WARN"
          ? check.remediation
          : undefined),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      key: check.key,
      label: check.label,
      category: check.category,
      status: "FAIL",
      detail: `This check could not run: ${errorMessage(err)}`,
      remediation: check.remediation,
      ms: Date.now() - started,
    };
  }
}

/**
 * Run every check against the live store, persist the report, and keep the
 * SELF_CHECK_FAILED alert in sync with the verdict. Never throws past the
 * report itself: persistence and alerting failures are contained (golden
 * rule 9 — a broken alert pipe must not break the diagnosis of a broken
 * alert pipe).
 */
export async function runSelfCheck(
  shopDomain: string,
  opts: { trigger?: "job" | "admin"; actor?: string } = {},
): Promise<SelfCheckReport> {
  const trigger = opts.trigger ?? "admin";
  const shop = await requireShop(shopDomain);
  const now = new Date();
  const ctx = new CheckContext(
    { id: shop.id, domain: shop.domain, primaryDomain: shop.primaryDomain },
    now,
  );

  // All checks are read-only and independently contained, so they run
  // concurrently — the wall clock is the slowest live probe, not the sum.
  const checks = await Promise.all(
    CHECKS.map((check) => runOneCheck(check, ctx)),
  );

  const failCount = checks.filter((c) => c.status === "FAIL").length;
  const warnCount = checks.filter((c) => c.status === "WARN").length;
  const report: SelfCheckReport = {
    ranAt: now.toISOString(),
    tookMs: Date.now() - now.getTime(),
    trigger,
    verdict: failCount > 0 ? "BROKEN" : warnCount > 0 ? "DEGRADED" : "HEALTHY",
    passCount: checks.filter((c) => c.status === "PASS").length,
    warnCount,
    failCount,
    skipCount: checks.filter((c) => c.status === "SKIP").length,
    checks,
  };

  // Persist for the Debug page (machine-written setting; no UI section).
  try {
    await setSetting(shop.id, "selfCheck", { version: 1, lastReport: report });
  } catch (err) {
    console.error("[selfcheck] persisting report failed", err);
  }

  // One deduped CRITICAL alert while broken; auto-resolved on recovery. The
  // raise emails settings.alerts.emailTo (CRITICAL path) — exactly the
  // "tell us before the live store breaks" behavior this tab exists for.
  try {
    if (report.verdict === "BROKEN") {
      const { raiseAlert } = await import("~/lib/analytics/alerts.server");
      const failing = checks.filter((c) => c.status === "FAIL");
      await raiseAlert({
        shopId: shop.id,
        type: SELF_CHECK_ALERT_TYPE,
        severity: "CRITICAL",
        message: `Self-check found ${failing.length} failing check(s): ${failing
          .map((c) => c.label)
          .join("; ")}`,
        context: {
          failed: failing.map((c) => ({ key: c.key, detail: c.detail })),
          ranAt: report.ranAt,
          trigger,
        },
      });
    } else {
      const resolved = await prisma.alert.updateMany({
        where: {
          shopId: shop.id,
          type: SELF_CHECK_ALERT_TYPE,
          resolvedAt: null,
        },
        data: { resolvedAt: new Date() },
      });
      if (resolved.count > 0) {
        await logEvent({
          shopId: shop.id,
          type: "admin.action",
          source: "SYSTEM",
          actor: "system",
          payload: {
            action: "self_check_recovered",
            resolvedAlerts: resolved.count,
            verdict: report.verdict,
          },
        });
      }
    }
  } catch (err) {
    console.error("[selfcheck] alert sync failed", err);
  }

  // Admin-triggered runs are audited like doctor runs; job runs already
  // leave a JobRun row every 30 minutes and would only drown the timeline.
  if (trigger === "admin") {
    try {
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor: opts.actor ?? "admin",
        payload: {
          action: "self_check_run",
          verdict: report.verdict,
          failCount,
          warnCount,
        },
      });
    } catch (err) {
      console.error("[selfcheck] audit event failed", err);
    }
  }

  return report;
}

/** The stored last report (null when the job has not run yet). */
export async function getLastSelfCheckReport(
  shopId: string,
): Promise<SelfCheckReport | null> {
  const stored = await getSetting(shopId, "selfCheck");
  return (stored.lastReport as SelfCheckReport | null) ?? null;
}
