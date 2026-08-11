import prisma from "~/db.server";
import {
  type Frequency,
  frequencyRangeError,
  frequencySchema,
  parseConfigDefaultFrequency,
  parseConfigFrequencies,
  parseConfigVariantDefaults,
} from "~/lib/frequency";
import { setShopMetafield } from "~/lib/graphql/metafields.server";

/**
 * Per-variant default frequency → storefront (v1.14.0).
 *
 * Products sold as unit-count variants (1 / 2 / 3 jars) empty at different
 * rates, so the cadence the buy box PRESELECTS should follow the variant the
 * shopper picked. The merchant's explicit overrides live on
 * `SellingPlanConfig.variantDefaultFrequencies` (variant GID → {unit,count});
 * this module projects them into the shop metafield
 * `cellexia.variant_defaults`:
 *
 *   {"v":1,"default":{"unit":"WEEK","count":8},
 *    "byVariant":{"4411100011202":{"unit":"MONTH","count":3}}}
 *
 * Keys are NUMERIC variant ids — the id form Liquid's `variant.id` and the
 * theme's `[name="id"]` field carry. The buy box maps each entry onto the
 * rendered group's plan whose parsed cadence matches. `default` is the
 * group-level defaultFrequency, the REVERT TARGET: the Liquid folds it into
 * every variant that has no explicit override, so switching from an
 * overridden pack size back to a plain one preselects the plan default
 * again (the exact promise the admin form makes) — and it finally makes the
 * plan's "Default frequency" setting effective on the storefront, which
 * previously only followed the theme block's text handle. A cadence that
 * matches no live plan of the rendered group changes nothing.
 *
 * SYNCED CONFIGS ONLY, same filter as the allow-list (`shopifyGroupId` set,
 * `active` NOT consulted): a draft saved but never synced must not steer the
 * live storefront ("save is not publish"), and a deactivated-but-still-
 * synced config keeps its defaults for exactly as long as the allow-list
 * keeps rendering its group — the two metafields written by the one choke
 * point must never disagree about which configs exist. Cross-config
 * collisions (two synced groups covering the same variant) resolve
 * last-config-wins in createdAt order; the rendered group applies an entry
 * only when the cadence matches one of its own live plans, so a collision
 * with a NON-overlapping cadence degrades to the group default, while an
 * overlapping one preselects the newer config's cadence — merchants should
 * not double-cover products (the Plans page already warns about product
 * overlap for foreign apps; own-app overlap is a config smell).
 *
 * PRESENTATION, NOT OWNERSHIP: this metafield never decides what may render —
 * that stays with `cellexia.plan_groups` (two-factor gate, fails closed). A
 * missing or stale `variant_defaults` merely preselects the group default,
 * which is why the publish here is best-effort and contained, while the
 * allow-list publish it rides along with is not.
 *
 * Published from inside `publishOwnGroupsMetafield()` (the one choke point
 * every republish flow already goes through: plan sync, config delete,
 * go-live, the daily factor sweep), so the storefront copy refreshes
 * wherever the allow-list does.
 */

export const VARIANT_DEFAULTS_METAFIELD_NAMESPACE = "cellexia";
export const VARIANT_DEFAULTS_METAFIELD_KEY = "variant_defaults";
export const VARIANT_DEFAULTS_METAFIELD_VERSION = 1;

export interface VariantDefaultsMetafieldValue {
  v: number;
  /**
   * The group default frequency — the revert target for variants WITHOUT an
   * override. Absent when no synced config exists; last synced config wins.
   */
  default?: Frequency;
  /** Numeric variant id → the default frequency for that variant. */
  byVariant: Record<string, Frequency>;
}

export interface VariantDefaultsPublishResult {
  ok: boolean;
  error?: string;
  value?: VariantDefaultsMetafieldValue;
}

const VARIANT_GID_NUMERIC_RE = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

/**
 * The metafield value for a shop, from the DB alone. SYNCED configs only
 * (see the module header: allow-list parity, "save is not publish"). Every
 * config contributes its map filtered to the cadences it actually OFFERS
 * (an override left behind by a frequency edit must not point the
 * storefront at a plan that no longer exists), plus its group default as
 * the shared revert target — both last-config-wins in createdAt order.
 */
export async function buildVariantDefaultsValue(
  shopId: string,
): Promise<VariantDefaultsMetafieldValue> {
  const configs = await prisma.sellingPlanConfig.findMany({
    // Exactly the buildPlanGroupsValue filter: what the allow-list lets
    // render is what this metafield may configure — nothing more (drafts),
    // nothing less (deactivated-but-still-synced groups keep rendering).
    where: { shopId, shopifyGroupId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: {
      frequencies: true,
      defaultFrequency: true,
      frequenciesWeeks: true,
      defaultFrequencyWeeks: true,
      variantDefaultFrequencies: true,
    },
  });

  const byVariant: Record<string, Frequency> = {};
  let groupDefault: Frequency | undefined;
  for (const config of configs) {
    const offered = parseConfigFrequencies(config);
    // Belt and braces for the revert target: parseConfigDefaultFrequency
    // always returns a value, but only a well-formed, in-range one may be
    // published (a corrupt row must degrade this field, not the metafield).
    const candidate = parseConfigDefaultFrequency(config);
    if (
      frequencySchema.safeParse(candidate).success &&
      !frequencyRangeError(candidate)
    ) {
      groupDefault = candidate;
    }
    const defaults = parseConfigVariantDefaults(
      config.variantDefaultFrequencies,
      offered,
    );
    for (const [gid, freq] of defaults) {
      const numeric = VARIANT_GID_NUMERIC_RE.exec(gid)?.[1];
      if (!numeric) continue;
      byVariant[numeric] = freq;
    }
  }

  return {
    v: VARIANT_DEFAULTS_METAFIELD_VERSION,
    ...(groupDefault ? { default: groupDefault } : {}),
    byVariant,
  };
}

/**
 * Build + write the metafield. Never throws — a failed write leaves the
 * previous (or absent) metafield in place, and the widget then preselects
 * the group default: degraded presentation, never a dark or wrong widget.
 * `adminClient` is the caller's already-constructed client (the publish
 * choke point has one in hand; no second session lookup).
 */
export async function publishVariantDefaultsMetafield(
  adminClient: Parameters<typeof setShopMetafield>[0],
  shopId: string,
): Promise<VariantDefaultsPublishResult> {
  try {
    const value = await buildVariantDefaultsValue(shopId);
    await setShopMetafield(adminClient, {
      namespace: VARIANT_DEFAULTS_METAFIELD_NAMESPACE,
      key: VARIANT_DEFAULTS_METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(value),
    });
    return { ok: true, value };
  } catch (err) {
    console.error(
      "[variant-defaults] metafield publish failed for shop",
      shopId,
      err,
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
