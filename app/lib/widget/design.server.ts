import type { Prisma, WidgetDesignRevision } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import { setShopMetafield } from "~/lib/graphql/metafields.server";
import { logEvent } from "~/lib/events/log.server";
import {
  DEFAULT_DESIGN_CONFIG,
  sanitizeCustomCss,
  widgetDesignConfigSchema,
  type WidgetDesignConfig,
} from "./presets";

/**
 * Buy-box design config — server side of the Buy box designer.
 *
 * Storage model: WidgetDesignRevision is an append-only history. The latest
 * row with publishedAt is the live design; the latest row overall may be an
 * unpublished draft (the designer's work-in-progress). Publishing mirrors the
 * config to the shop metafield cellexia.buybox_design (type json), which the
 * Liquid block reads with null-safe fallbacks — so a shop with no published
 * revision (or a failed metafield write) keeps rendering exactly as v1.0.0.
 *
 * Consistency rule: DB and metafield must never diverge silently. When the
 * metafield write fails, publishedAt is rolled back and the error rethrown —
 * the revision stays a draft and the storefront keeps the previous design.
 *
 * v1.26.0: revisions carry an optional merchant-given `label` (see
 * normalizeDesignLabel) and every successful publish nudges the design
 * measurement engine (market map refresh + scoreboard cache clear, both
 * contained fire-and-forget; see afterPublishHooks) because a publish is
 * exactly what changes the design calendar the readouts resolve against.
 */

export const DESIGN_METAFIELD_NAMESPACE = "cellexia";
export const DESIGN_METAFIELD_KEY = "buybox_design";

const REVISION_LIST_LIMIT = 20;

/**
 * Merchant-given design name (v1.26.0, WidgetDesignRevision.label): "Test 1:
 * sub preselected". Shown in the revision history and the Results tab so a
 * measurement period reads as a named design instead of a cuid. Kept short
 * so it fits a table cell; whitespace collapsed; empty means "no name".
 */
export const DESIGN_LABEL_MAX_LENGTH = 80;

export interface RevisionWriteOptions {
  /** undefined = leave untouched; null/"" = no name; string = the name. */
  label?: string | null;
}

export function normalizeDesignLabel(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.slice(0, DESIGN_LABEL_MAX_LENGTH);
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Parse + sanitize an untrusted config: customCss is sanitized BEFORE schema
 * validation (so an oversized-but-strippable css doesn't hard-fail on length)
 * and the parsed result carries the sanitized css. Throws ZodError on any
 * shape/range/hex violation.
 */
function validateConfig(input: unknown): WidgetDesignConfig {
  let candidate = input;
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { style?: { customCss?: unknown } }).style?.customCss ===
      "string"
  ) {
    const withStyle = input as { style: { customCss: string } };
    candidate = {
      ...withStyle,
      style: {
        ...withStyle.style,
        customCss: sanitizeCustomCss(withStyle.style.customCss),
      },
    };
  }
  return widgetDesignConfigSchema.parse(candidate);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The live design: latest published revision's config, else
 * DEFAULT_DESIGN_CONFIG (== v1.0.0 rendering). A stored config that no longer
 * validates (schema drift) also falls back to the default — the widget must
 * never receive a config the schema doesn't vouch for.
 */
export async function getDesignConfig(
  shopId: string,
): Promise<WidgetDesignConfig> {
  const revision = await prisma.widgetDesignRevision.findFirst({
    where: { shopId, publishedAt: { not: null } },
    orderBy: { publishedAt: "desc" },
  });
  return parseStoredConfig(revision);
}

export interface DraftOrPublished {
  config: WidgetDesignConfig;
  /** Null when the shop has no revisions at all (config is the default). */
  revision: WidgetDesignRevision | null;
  /** True when `revision` exists and is not published (work in progress). */
  isDraft: boolean;
}

/**
 * What the designer should load: the newest revision whether draft or
 * published, else the default config.
 */
export async function getDraftOrPublished(
  shopId: string,
): Promise<DraftOrPublished> {
  const revision = await prisma.widgetDesignRevision.findFirst({
    where: { shopId },
    orderBy: { createdAt: "desc" },
  });
  return {
    config: parseStoredConfig(revision),
    revision,
    isDraft: revision != null && revision.publishedAt == null,
  };
}

/** Revision history, newest first (rows carry `label` since v1.26.0). */
export async function listRevisions(
  shopId: string,
  limit = REVISION_LIST_LIMIT,
): Promise<WidgetDesignRevision[]> {
  return prisma.widgetDesignRevision.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 100),
  });
}

function parseStoredConfig(
  revision: WidgetDesignRevision | null,
): WidgetDesignConfig {
  if (!revision) return DEFAULT_DESIGN_CONFIG;
  const parsed = widgetDesignConfigSchema.safeParse(revision.config);
  if (!parsed.success) {
    console.error(
      "[widget] stored design config invalid, falling back to default",
      revision.id,
      parsed.error.message,
    );
    return DEFAULT_DESIGN_CONFIG;
  }
  return parsed.data;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Validate + sanitize + store an unpublished draft revision. Nothing reaches
 * the storefront until publishRevision.
 */
export async function saveDraftRevision(
  shopId: string,
  config: unknown,
  createdBy?: string | null,
  opts?: RevisionWriteOptions,
): Promise<WidgetDesignRevision> {
  const validated = validateConfig(config);
  return prisma.widgetDesignRevision.create({
    data: {
      shopId,
      preset: validated.preset,
      config: validated as Prisma.InputJsonObject,
      createdBy: createdBy ?? null,
      label: normalizeDesignLabel(opts?.label),
    },
  });
}

/**
 * Publishing changes what the design calendar (design-measurement/ledger)
 * resolves from now on, so the readouts must not keep serving a cached
 * scoreboard, and the market -> country map the order facts rely on is
 * refreshed while we hold an admin client anyway. Both are fire-and-forget
 * and fully contained: the sibling modules are loaded dynamically inside a
 * try/catch so a missing or failing module can never break a publish (the
 * nightly design_facts_backfill repeats the market refresh; the scoreboard
 * cache expires on its own after 10 minutes).
 */
function afterPublishHooks(shopId: string, admin: AdminClient): void {
  void (async () => {
    try {
      const mod = await import("~/lib/design-measurement/markets.server");
      await mod.refreshMarketCountryMap(shopId, admin);
    } catch (err) {
      console.error("[widget] market map refresh after publish failed", err);
    }
  })();
  void (async () => {
    try {
      const mod = await import("~/lib/design-measurement/scoreboard.server");
      mod.invalidateScoreboardCache(shopId);
    } catch (err) {
      console.error("[widget] scoreboard cache invalidation failed", err);
    }
  })();
}

/**
 * Publish a revision: re-validate (defense in depth — the row predates this
 * deploy's schema), stamp publishedAt, mirror the config to the
 * cellexia.buybox_design shop metafield, log the audit event.
 *
 * If the metafield write fails, publishedAt is rolled back to its previous
 * value and the error rethrown: DB and metafield are never left divergent
 * silently, and the storefront keeps whatever design was live before.
 */
export async function publishRevision(
  shopId: string,
  revisionId: string,
  actor: string,
  opts?: RevisionWriteOptions,
): Promise<WidgetDesignRevision> {
  const revision = await prisma.widgetDesignRevision.findFirst({
    where: { id: revisionId, shopId },
  });
  if (!revision) {
    throw new Error(`[widget] design revision not found: ${revisionId}`);
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`[widget] shop not found: ${shopId}`);

  // Validate + sanitize again right before the metafield write.
  const validated = validateConfig(revision.config);
  const previousPublishedAt = revision.publishedAt;

  // A label passed here wins over the draft's; undefined leaves it alone
  // (backward compatible: pre-v1.26.0 callers never mention labels).
  const labelPatch =
    opts !== undefined && opts.label !== undefined
      ? { label: normalizeDesignLabel(opts.label) }
      : {};

  const published = await prisma.widgetDesignRevision.update({
    where: { id: revision.id },
    data: {
      publishedAt: new Date(),
      config: validated as Prisma.InputJsonObject,
      ...labelPatch,
    },
  });

  let admin: AdminClient;
  try {
    admin = await adminClientForShop(shop.domain);
    await setShopMetafield(admin, {
      namespace: DESIGN_METAFIELD_NAMESPACE,
      key: DESIGN_METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(validated),
    });
  } catch (err) {
    // Roll back so DB and metafield never diverge silently.
    await prisma.widgetDesignRevision.update({
      where: { id: revision.id },
      data: { publishedAt: previousPublishedAt },
    });
    throw err;
  }

  await logEvent({
    shopId,
    type: "admin.action",
    source: "ADMIN",
    actor,
    payload: {
      action: "buybox_design_published",
      preset: validated.preset,
      revisionId: revision.id,
      label: published.label ?? null,
    },
  });

  afterPublishHooks(shopId, admin);

  return published;
}

/**
 * Revert to an older design: copy that revision's config into a NEW revision
 * (history stays append-only) and publish it. The source's label travels
 * with the copy: a restored design is the same named design, so its
 * measurement periods keep reading under one name.
 */
export async function restoreRevision(
  shopId: string,
  revisionId: string,
  actor: string,
): Promise<WidgetDesignRevision> {
  const source = await prisma.widgetDesignRevision.findFirst({
    where: { id: revisionId, shopId },
  });
  if (!source) {
    throw new Error(`[widget] design revision not found: ${revisionId}`);
  }
  const draft = await saveDraftRevision(shopId, source.config, actor, {
    label: source.label,
  });
  return publishRevision(shopId, draft.id, actor);
}
