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
import {
  OURS_ONLY,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  PLAN_GROUPS_METAFIELD_KEY,
  PLAN_GROUPS_METAFIELD_NAMESPACE,
} from "~/lib/ownership/ownership.server";
import {
  mintPreviewToken,
  verifyPreviewToken,
} from "~/lib/portal/previewToken.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { verifyMailer } from "~/lib/notifications/mailer.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import { JOB_SCHEDULE } from "~/lib/jobs/runner.server";

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
const PENDING_STUCK_HOURS = 24; // scheduler STALE_EXPIRE_HOURS — the stale
// sweep EXPIREs unresolved PENDING attempts at 24h, so any PENDING row older
// than that means the sweep itself is not doing its job.
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
    run: async () => {
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
      if (!isKlaviyoConfigured()) {
        return {
          status: "WARN",
          detail:
            "KLAVIYO_PRIVATE_API_KEY is not set — lifecycle email falls back to direct SMTP and SMS is suppressed entirely.",
          remediation:
            "Set the key (docs/KLAVIYO_SETUP.md) if Klaviyo flows are expected to fire.",
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
      "Fix the SMTP settings (MAIL_PROVIDER/SMTP_*) — OTP codes, 3DS links and admin alerts ride this transport alone, even with Klaviyo configured.",
    run: async () => {
      const status = await verifyMailer();
      if (!status.ok) {
        return {
          status: "FAIL",
          detail: `Mailer not deliverable (provider ${status.provider}): ${status.error ?? "verification failed"}.`,
        };
      }
      if (status.provider === "console") {
        return {
          status: status.implicitFallback ? "WARN" : "PASS",
          detail: status.implicitFallback
            ? "Mail provider fell back to console implicitly — fine in development, an outage in production."
            : "Console mail provider chosen explicitly (development).",
        };
      }
      return { status: "PASS", detail: "SMTP transport verified." };
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
          // PENDING older than the stale sweep's own 24h expiry means the
          // sweep is not doing its job (age basis: startedAt ?? scheduledFor,
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

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    key: "klaviyo_outbox",
    label: "Klaviyo outbox draining",
    category: "Notifications",
    remediation:
      "Events older than 24h are DEADed (never fired late, by design). Check KLAVIYO_PRIVATE_API_KEY and the klaviyo_flush job on the Audit page before the backlog ages out.",
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
      if (!isKlaviyoConfigured()) {
        if (dueUndrained > 0) {
          return {
            status: "WARN",
            detail: `${dueUndrained} event(s) queued with no KLAVIYO_PRIVATE_API_KEY set — they will age out DEAD after 24h without firing.`,
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
