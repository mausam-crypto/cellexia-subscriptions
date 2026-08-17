import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { fromZonedTime } from "date-fns-tz";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";
import { listMarkets, type AdminClient } from "~/lib/graphql/index.server";
import {
  getScoreboard,
  invalidateScoreboardCache,
} from "~/lib/design-measurement/scoreboard.server";
import type { ScoreboardGroupBy } from "~/lib/design-measurement/types";
import type {
  DesignMeasurementSettingsView,
  DesignResultsActionData,
  DesignResultsMarket,
  DesignResultsPayload,
  RangeKey,
} from "~/components/design-results";

/**
 * Buy box designer, Results tab data (v1.26.0): `/app/buy-box/results`.
 *
 * Resource route (no default export) with the ESCAPED file name
 * `app.buy-box_.results.tsx`: it lives at the URL under /app/buy-box but is
 * NOT nested under the designer's route, so the designer's loader (revision
 * history, markets, launch state) never re-runs when this route answers a
 * fetcher, and this route never runs when the designer page loads. The
 * Results tab (app/components/design-results.tsx) fetches it lazily on
 * first mount and on every control change.
 *
 * GET query params (all optional; unknown values fall back to the default):
 *   range  = 30 | 90 | 365 | all   (default all = since designMeasurement.startedAt, or all time)
 *   market = Shopify market handle, "" = every market (default)
 *   group  = variant | design | revision   (default variant)
 *   fresh  = 1 | true  → bypass the scoreboard's 10-minute cache
 *
 * POST intents:
 *   save-measurement-settings  fields startedAt (YYYY-MM-DD or ""), excludeEmails
 *                              (one per line and/or comma-separated),
 *                              guardrailMaxOrderDropPct (0..90),
 *                              guardrailMinOrdersPerWeek (0..100000)
 *   save-sessions              field weeklySessions = JSON object {"2026-W35": 1234, ...}
 * Both keep the untouched fields of the designMeasurement setting, log an
 * admin.action {action:"design_measurement_settings_saved"} event and clear
 * the scoreboard cache (guardrail thresholds, staff list and sessions all
 * change what the readout shows). save-measurement-settings additionally
 * re-flags `staff` on the SubscribableOrder rows already recorded (contained,
 * awaited) BEFORE the cache is cleared, so the exclusions apply to the next
 * read and not only after the nightly job. Invalid input → 422 with a plain
 * toast.
 *
 * `Cache-Control: no-store` rides the route `headers` export as well as the
 * loader Response: under single fetch the fetcher's `.data` request takes
 * its wire headers from `headers`, and a proxy must never serve a stale
 * scoreboard as if it were fresh.
 *
 * v1.27.0: the payload SHAPE is unchanged. Visits, conversion, the reference
 * comparison and the guardrail basis all ride inside `scoreboard` (computed
 * by getScoreboard from WidgetVisitorDay), and the beacon warning is decided
 * client-side from scoreboard.totals + the designer page's launchMode prop,
 * so this route needs no new field and no new query parameter.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

export const headers: HeadersFunction = () => ({ ...NO_STORE });

// ── Query parsing (exported for tests) ──────────────────────────────────────

const RANGE_DAYS: Record<RangeKey, number | null> = {
  "30": 30,
  "90": 90,
  "365": 365,
  all: null,
};

export function parseRangeParam(raw: string | null): RangeKey {
  if (raw === "30" || raw === "90" || raw === "365" || raw === "all") return raw;
  return "all";
}

export function parseGroupParam(raw: string | null): ScoreboardGroupBy {
  if (raw === "variant" || raw === "design" || raw === "revision") return raw;
  return "variant";
}

/** Market handles are Shopify-generated slugs; anything else is treated as "all markets". */
export function parseMarketParam(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed) ? trimmed : "";
}

export function parseFreshParam(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Markets for the Market select: every handle the order facts know
 * (MarketCountryMap, refreshed on publish and nightly) merged with the live
 * Shopify list for names. Either source failing degrades to the other; both
 * failing yields [] and the tab still renders with "All markets".
 */
async function listResultsMarkets(
  shopId: string,
  admin: AdminClient,
): Promise<DesignResultsMarket[]> {
  const byHandle = new Map<string, string | null>();
  try {
    const rows = await prisma.marketCountryMap.findMany({
      where: { shopId },
      select: { marketHandle: true, marketName: true },
      distinct: ["marketHandle"],
      orderBy: { marketHandle: "asc" },
    });
    for (const row of rows) byHandle.set(row.marketHandle, row.marketName ?? null);
  } catch (err) {
    console.error("[design-results] market map read failed", err);
  }
  try {
    const live = await listMarkets(admin);
    for (const m of live) {
      // Live names win over the cached ones (a renamed market reads right).
      byHandle.set(m.handle, m.name);
    }
  } catch (err) {
    console.error("[design-results] markets fetch failed, using cached handles", err);
  }
  return [...byHandle.entries()]
    .map(([handle, name]) => ({ handle, name }))
    .sort((a, b) => (a.name ?? a.handle).localeCompare(b.name ?? b.handle));
}

type DesignMeasurementSetting = SettingsValue<"designMeasurement">;

function settingsView(s: DesignMeasurementSetting): DesignMeasurementSettingsView {
  return {
    startedAt: s.startedAt ?? null,
    excludeEmails: [...s.excludeEmails],
    guardrailMaxOrderDropPct: s.guardrailMaxOrderDropPct,
    guardrailMinOrdersPerWeek: s.guardrailMinOrdersPerWeek,
    weeklySessions: { ...s.weeklySessions },
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const range = parseRangeParam(url.searchParams.get("range"));
  const market = parseMarketParam(url.searchParams.get("market"));
  const group = parseGroupParam(url.searchParams.get("group"));
  const fresh = parseFreshParam(url.searchParams.get("fresh"));

  const [scoreboard, settings, markets] = await Promise.all([
    getScoreboard({
      shopId: shop.id,
      rangeDays: RANGE_DAYS[range],
      marketHandle: market === "" ? null : market,
      groupBy: group,
      fresh,
    }),
    getSetting(shop.id, "designMeasurement"),
    listResultsMarkets(shop.id, admin),
  ]);

  const payload: DesignResultsPayload = {
    scoreboard,
    settings: settingsView(settings),
    markets,
    currencyCode: shop.currencyCode,
    query: { range, market, group },
  };
  return json(payload, { headers: { ...NO_STORE } });
};

// ── Action ───────────────────────────────────────────────────────────────────

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

class SettingsInputError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WEEK = /^\d{4}-W\d{2}$/;
/** Loose shape check: the list is a filter on order emails, not a mailbox. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseStartedAtField(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!ISO_DATE.test(trimmed)) {
    throw new SettingsInputError("Start date must look like 2026-09-01");
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new SettingsInputError("Start date is not a real calendar date");
  }
  return trimmed;
}

/** One per line and/or comma / semicolon separated; lowercased, trimmed, de-duplicated, capped at 200. */
export function parseExcludeEmailsField(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\n\r,;]+/)) {
    const email = piece.trim().toLowerCase();
    if (email === "") continue;
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) {
      throw new SettingsInputError(`"${piece.trim()}" does not look like an email address`);
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  if (out.length > 200) {
    throw new SettingsInputError("At most 200 staff emails can be listed");
  }
  return out;
}

export function parseIntSetting(
  raw: string,
  label: string,
  min: number,
  max: number,
): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new SettingsInputError(`${label} must be a whole number`);
  }
  const n = Number(trimmed);
  if (n < min || n > max) {
    throw new SettingsInputError(`${label} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Lower bound for the staff-flag recompute after a settings save: the
 * measurement start date at 00:00 shop time (the earliest order any readout
 * can include), or null (every row) when no start date is set. Exported for
 * tests.
 */
export function staffRecomputeSince(
  startedAt: string | null,
  tz: string,
): Date | null {
  if (!startedAt || !ISO_DATE.test(startedAt)) return null;
  const parsed = fromZonedTime(`${startedAt}T00:00:00`, tz);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** {"2026-W35": 1234, ...}; blank/null values drop the week; keys must be ISO weeks. */
export function parseWeeklySessionsField(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    throw new SettingsInputError("Sessions could not be read; please try again");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettingsInputError("Sessions could not be read; please try again");
  }
  const out: Record<string, number> = {};
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 400) {
    throw new SettingsInputError("At most 400 weeks of sessions can be stored");
  }
  for (const [week, value] of entries) {
    if (!ISO_WEEK.test(week)) {
      throw new SettingsInputError(`"${week}" is not a week like 2026-W35`);
    }
    if (value === null || value === "" || value === undefined) continue;
    const n = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100000000) {
      throw new SettingsInputError(`Sessions for ${week} must be a whole number of 0 or more`);
    }
    out[week] = n;
  }
  return out;
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
  const field = (name: string): string => String(formData.get(name) ?? "");

  if (intent !== "save-measurement-settings" && intent !== "save-sessions") {
    return json<DesignResultsActionData>(
      { intent, ok: false, toast: "Unknown action" },
      { status: 400 },
    );
  }

  try {
    const current = await getSetting(shop.id, "designMeasurement");
    let next: DesignMeasurementSetting;
    let changed: Record<string, unknown>;
    let toast: string;

    if (intent === "save-measurement-settings") {
      const startedAt = parseStartedAtField(field("startedAt"));
      const excludeEmails = parseExcludeEmailsField(field("excludeEmails"));
      const guardrailMaxOrderDropPct = parseIntSetting(
        field("guardrailMaxOrderDropPct"),
        "Tolerated weekly order drop",
        0,
        90,
      );
      const guardrailMinOrdersPerWeek = parseIntSetting(
        field("guardrailMinOrdersPerWeek"),
        "Minimum orders per week",
        0,
        100000,
      );
      next = {
        ...current,
        startedAt,
        excludeEmails,
        guardrailMaxOrderDropPct,
        guardrailMinOrdersPerWeek,
      };
      changed = {
        part: "settings",
        startedAt,
        excludeEmailsCount: excludeEmails.length,
        guardrailMaxOrderDropPct,
        guardrailMinOrdersPerWeek,
      };
      toast = "Measurement settings saved";
    } else {
      const weeklySessions = parseWeeklySessionsField(field("weeklySessions"));
      next = { ...current, weeklySessions };
      changed = { part: "sessions", weeks: Object.keys(weeklySessions).length };
      toast = "Product page sessions saved";
    }

    await setSetting(shop.id, "designMeasurement", next, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: { action: "design_measurement_settings_saved", ...changed },
    });
    if (intent === "save-measurement-settings") {
      // The `staff` flag is stamped on each SubscribableOrder at write time,
      // so a changed staff list must be applied to the rows ALREADY recorded
      // before the cache is dropped, otherwise the fresh refetch recomputes
      // over the old flags and the tab keeps counting staff orders until the
      // nightly job (and forever for rows outside its window) while the help
      // text promises they are left out. Awaited on purpose (the merchant's
      // next read must see it) and contained: a failure leaves the nightly
      // recompute as the fallback and never fails the save. Lazy import: the
      // backfill module pulls the ledger + Shopify client, which this route
      // does not otherwise need.
      try {
        const { recomputeStaffFlags } = await import(
          "~/lib/design-measurement/backfill.server"
        );
        await recomputeStaffFlags(shop.id, next.excludeEmails, {
          since: staffRecomputeSince(next.startedAt, shop.ianaTimezone),
        });
      } catch (err) {
        console.error("[design-results] staff flag recompute failed", err);
      }
    }
    // The readout depends on these values; never serve a cached board that
    // ignores what was just saved. Contained: a cache miss is the worst case.
    try {
      invalidateScoreboardCache(shop.id);
    } catch (err) {
      console.error("[design-results] cache invalidation failed", err);
    }
    return json<DesignResultsActionData>({ intent, ok: true, toast });
  } catch (err) {
    if (err instanceof SettingsInputError) {
      return json<DesignResultsActionData>(
        { intent, ok: false, toast: err.message },
        { status: 422 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[design-results] settings save failed", err);
    return json<DesignResultsActionData>(
      { intent, ok: false, toast: `Not saved: ${message}` },
      { status: 422 },
    );
  }
};
