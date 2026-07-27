/**
 * Liquid rendering harness for extensions/cellexia-buy-box.
 *
 * WHY THIS EXISTS
 * ---------------
 * v1.2.0 shipped a storefront render that printed
 *   "<!-- BEGIN app snippet: cx-design-text -->CHOOSE YOUR RITUAL<!-- END app snippet -->"
 * and "Subscribe &amp; Save" as literal page text. Both defects are invisible
 * to unit tests of TypeScript helpers and to `shopify app deploy`: they only
 * exist in the interaction between Liquid and Shopify's THEME APP EXTENSION
 * semantics. This harness renders the real .liquid files with those semantics
 * so the defect class is caught in CI instead of on the client's storefront.
 *
 * SHOPIFY SEMANTICS MIRRORED HERE (deliberately, including the sharp edges)
 * -----------------------------------------------------------------------
 * 1. APP-SNIPPET WRAPPING. In a theme app extension Shopify wraps the output
 *    of EVERY `{% render 'x' %}` of an extension snippet in
 *      <!-- BEGIN app snippet: x --> … <!-- END app snippet -->
 *    The custom `render` tag below reproduces that exactly. In markup position
 *    the markers are invisible HTML comments; the moment a template captures a
 *    render into a variable and escapes it, they become visible page text.
 *    Reproducing the wrapper is the whole point: it is what makes
 *    tests/liquid/render.test.ts able to fail on the production bug.
 * 2. THE `t` FILTER RETURNS HTML-ESCAPED TEXT. "Subscribe & Save" comes back
 *    as "Subscribe &amp; Save"; escaping that again yields "&amp;amp;", which
 *    renders as the literal characters "&amp;". `t` here interpolates its
 *    named arguments into the locale string and then escapes the whole result,
 *    exactly like the platform, and reports missing keys as
 *    "translation missing: <locale>.<key>" so tests can assert on that too.
 * 3. `escape` uses Ruby/Shopify's mapping (`"` → `&quot;`), NOT liquidjs's
 *    default (`"` → `&#34;`). The widget's SAFE → RAW un-escape chain replaces
 *    `&quot;`, so getting this wrong would silently mask a real bug.
 * 4. Liquid truthiness (`jsTruthy: false`): only nil/false are falsy, "" and 0
 *    are truthy — the semantics the .liquid was written against.
 * 5. `strictFilters: true`: a filter used by the templates but not implemented
 *    here fails the suite instead of silently passing the value through. If a
 *    future edit introduces a new Shopify filter, this harness must learn it.
 *
 * The harness is intentionally dependency-light: liquidjs plus node:fs. It
 * never imports app/ server code, so it runs with no DB and no network.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Liquid, RenderTag } from "liquidjs";
import type {
  Context,
  Emitter,
  Parser,
  TagToken,
  TopLevelToken,
} from "liquidjs";

// ── Paths ────────────────────────────────────────────────────────────────────

/** Repository root (this file lives at tests/liquid/harness.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const EXTENSION_DIR = join(
  REPO_ROOT,
  "extensions",
  "cellexia-buy-box",
);
export const SNIPPETS_DIR = join(EXTENSION_DIR, "snippets");
export const BLOCKS_DIR = join(EXTENSION_DIR, "blocks");
export const ASSETS_DIR = join(EXTENSION_DIR, "assets");
export const LOCALES_DIR = join(EXTENSION_DIR, "locales");

/** The two app-block entry points, keyed by the way merchants install them. */
export const BLOCK_FILES = {
  section: join(BLOCKS_DIR, "buy-box.liquid"),
  embed: join(BLOCKS_DIR, "buy-box-embed.liquid"),
} as const;

export type BlockTarget = keyof typeof BLOCK_FILES;

/** Every .liquid file shipped in the extension (blocks + snippets). */
export function extensionLiquidFiles(): string[] {
  const files: string[] = [];
  for (const dir of [BLOCKS_DIR, SNIPPETS_DIR]) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".liquid")) files.push(join(dir, name));
    }
  }
  return files;
}

// ── HTML escaping / entity decoding (Shopify semantics) ──────────────────────

/**
 * Shopify's `escape` filter (Ruby CGI.escapeHTML): `&` first, then the rest.
 * liquidjs's built-in emits `&#34;` for `"`, which would break the widget's
 * documented `replace: '&quot;', '"'` un-escape chain.
 */
export function shopifyEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/**
 * Decode HTML entities ONE level, the way a browser decodes an attribute value
 * or a text node. Single-level is the point: if decoding once still leaves an
 * entity behind ("&amp;" → "&amp;"), the value was escaped twice.
 */
export function decodeEntitiesOnce(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    },
  );
}

// ── Money ────────────────────────────────────────────────────────────────────

/** cellexialabs.com sells in CHF and formats as "CHF 64.00". */
export const DEFAULT_MONEY_FORMAT = "CHF {{amount}}";
export const DEFAULT_MONEY_WITH_CURRENCY_FORMAT = "CHF {{amount}} CHF";

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupThousands(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Shopify's money formatting: cents → the shop's money_format, supporting the
 * four `{{amount*}}` placeholders the platform defines.
 */
export function formatMoney(cents: unknown, format: string): string {
  const value = toNumber(cents) / 100;
  const fixed = Math.abs(value).toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const sign = value < 0 ? "-" : "";
  const noDecimals = String(Math.round(Math.abs(value)));
  const replacements: Record<string, string> = {
    amount: sign + groupThousands(whole, ",") + "." + fraction,
    amount_no_decimals: sign + groupThousands(noDecimals, ","),
    amount_with_comma_separator:
      sign + groupThousands(whole, ".") + "," + fraction,
    amount_no_decimals_with_comma_separator:
      sign + groupThousands(noDecimals, "."),
  };
  return format.replace(
    /\{\{\s*(amount(?:_no_decimals)?(?:_with_comma_separator)?)\s*\}\}/g,
    (match, key: string) => replacements[key] ?? match,
  );
}

// ── Locales (the extension's own locale files) ───────────────────────────────

const localeCache = new Map<string, Record<string, string>>();

function readLocaleFile(name: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(LOCALES_DIR, name), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Translations for a storefront locale, merged over the extension's default
 * locale exactly like Shopify does (per-key fallback to en.default.json).
 */
export function translationsFor(isoCode: string): Record<string, string> {
  const key = isoCode || "en";
  const cached = localeCache.get(key);
  if (cached) return cached;

  const base = readLocaleFile("en.default.json") ?? {};
  const candidates = [`${key}.json`];
  const language = key.split("-")[0];
  if (language && language !== key) candidates.push(`${language}.json`);
  let overlay: Record<string, string> | null = null;
  for (const candidate of candidates) {
    overlay = readLocaleFile(candidate);
    if (overlay) break;
  }
  const merged = { ...base, ...(overlay ?? {}) };
  localeCache.set(key, merged);
  return merged;
}

/** Locale codes shipped by the extension, e.g. ["ar", "cs", …, "zh-CN"]. */
export function shippedLocales(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.default\.json$|\.json$/, ""))
    .sort();
}

// ── Engine ───────────────────────────────────────────────────────────────────

interface FilterThis {
  context: Context;
}

/** An Emitter that buffers into a string (liquidjs' SimpleEmitter is internal). */
class CaptureEmitter implements Emitter {
  buffer = "";
  write(html: unknown): void {
    this.buffer += html === null || html === undefined ? "" : String(html);
  }
}

/** `{% render 'name' %}` → the leading literal, for the comment markers. */
function leadingSnippetName(args: string): string {
  const match = /^\s*['"]([^'"]+)['"]/.exec(args);
  return match ? match[1] : args.trim().split(/[\s,]/)[0];
}

/**
 * Shopify's app-snippet render. Identical to liquidjs' `{% render %}`
 * (isolated scope, keyword arguments, globals still visible) except that the
 * output is wrapped in the BEGIN/END app snippet comments the platform adds.
 * THIS IS THE BUG REPRODUCER — see the file header.
 */
class AppSnippetRenderTag extends RenderTag {
  private readonly snippetName: string;

  constructor(
    token: TagToken,
    remainTokens: TopLevelToken[],
    liquid: Liquid,
    parser: Parser,
  ) {
    super(token, remainTokens, liquid, parser);
    const parsedFile: unknown = (this as unknown as { file: unknown }).file;
    this.snippetName =
      typeof parsedFile === "string"
        ? parsedFile
        : leadingSnippetName(token.args);
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const captured = new CaptureEmitter();
    yield super.render(ctx, captured);
    emitter.write(`<!-- BEGIN app snippet: ${this.snippetName} -->`);
    emitter.write(captured.buffer);
    emitter.write("<!-- END app snippet -->");
  }
}

/**
 * `{% schema %} … {% endschema %}` renders nothing: Shopify consumes the block
 * schema at install time and strips it from the storefront output.
 */
const schemaTag = {
  parse(_token: TagToken, remainTokens: TopLevelToken[]): void {
    let next = remainTokens.shift();
    while (next) {
      if ((next as { name?: string }).name === "endschema") return;
      next = remainTokens.shift();
    }
    throw new Error("{% schema %} is not closed");
  },
  render(): string {
    return "";
  },
};

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Deterministic stand-in for the extension CDN. */
export function assetUrl(name: string): string {
  return `//cdn.shopify.com/extensions/cellexia-buy-box/assets/${name}`;
}

let engineSingleton: Liquid | null = null;

/**
 * The Liquid engine, configured to behave like the Shopify storefront for the
 * subset of the language and filter set the buy box actually uses.
 */
export function engine(): Liquid {
  if (engineSingleton) return engineSingleton;

  const liquid = new Liquid({
    root: [SNIPPETS_DIR, BLOCKS_DIR],
    extname: ".liquid",
    relativeReference: false,
    // Liquid (not JS) truthiness: "" and 0 are truthy, only nil/false are not.
    jsTruthy: false,
    // Undefined variables render as empty, exactly like the storefront…
    strictVariables: false,
    // …but an unknown FILTER must fail loudly: it means this harness does not
    // yet model something the templates rely on.
    strictFilters: true,
    cache: false,
  });

  liquid.registerTag("render", AppSnippetRenderTag as never);
  liquid.registerTag("schema", schemaTag as never);

  // ── Filters ────────────────────────────────────────────────────────────────
  // Only the filters the templates use are implemented (see the grep in
  // tests/liquid/lint.test.ts, which fails when a new one appears).

  liquid.registerFilter("escape", (value: unknown) =>
    shopifyEscape(value === null || value === undefined ? "" : String(value)),
  );

  liquid.registerFilter("t", function (this: FilterThis, ...args: unknown[]) {
    const key = String(args[0] ?? "");
    // liquidjs hands named filter arguments over as [key, value] tuples;
    // tolerate the merged-object shape too so a liquidjs upgrade cannot
    // silently turn interpolation into a no-op.
    const named: Record<string, unknown> = {};
    for (const argument of args.slice(1)) {
      if (
        Array.isArray(argument) &&
        argument.length === 2 &&
        typeof argument[0] === "string"
      ) {
        named[argument[0]] = argument[1];
      } else if (
        argument !== null &&
        typeof argument === "object" &&
        !Array.isArray(argument)
      ) {
        Object.assign(named, argument as Record<string, unknown>);
      }
    }
    const isoCode = String(
      this.context.getSync(["request", "locale", "iso_code"]) ?? "en",
    );
    const table = translationsFor(isoCode);
    const template = table[key];
    if (template === undefined) {
      // Shopify prints this on the page; tests assert it never appears.
      return `translation missing: ${isoCode}.${key}`;
    }
    const interpolated = template.replace(
      /\{\{\s*([\w.]+)\s*\}\}/g,
      (match, name: string) => {
        const value = named[name];
        return value === undefined || value === null ? match : String(value);
      },
    );
    // The platform returns HTML-ESCAPED text — the v1.2.0 double-escape bug.
    return shopifyEscape(interpolated);
  });

  liquid.registerFilter("money", function (this: FilterThis, value: unknown) {
    const format = String(
      this.context.getSync(["shop", "money_format"]) ?? DEFAULT_MONEY_FORMAT,
    );
    return formatMoney(value, format);
  });

  liquid.registerFilter(
    "money_with_currency",
    function (this: FilterThis, value: unknown) {
      const format = String(
        this.context.getSync(["shop", "money_with_currency_format"]) ??
          DEFAULT_MONEY_WITH_CURRENCY_FORMAT,
      );
      return formatMoney(value, format);
    },
  );

  liquid.registerFilter(
    "color_modify",
    (color: unknown, property: unknown, amount: unknown) => {
      const input = String(color ?? "");
      if (String(property) !== "alpha") return input;
      const rgb = hexToRgb(input);
      if (!rgb) return input;
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${toNumber(amount)})`;
    },
  );

  liquid.registerFilter("asset_url", (value: unknown) =>
    assetUrl(String(value ?? "")),
  );

  liquid.registerFilter(
    "stylesheet_tag",
    (url: unknown) =>
      `<link href="${String(url ?? "")}" rel="stylesheet" type="text/css" media="all">`,
  );

  liquid.registerFilter(
    "script_tag",
    (url: unknown) => `<script src="${String(url ?? "")}"></script>`,
  );

  engineSingleton = liquid;
  return liquid;
}

// ── Block schema defaults (the settings Shopify hands the block) ─────────────

interface SchemaSetting {
  id?: string;
  type: string;
  default?: unknown;
}

const schemaCache = new Map<BlockTarget, Record<string, unknown>>();

/**
 * The block settings a freshly added block has: every schema setting at its
 * declared default. Read from the block file itself so the fixtures can never
 * drift from the shipped schema.
 */
export function defaultBlockSettings(
  target: BlockTarget,
): Record<string, unknown> {
  const cached = schemaCache.get(target);
  if (cached) return { ...cached };
  const source = readFileSync(BLOCK_FILES[target], "utf8");
  const match = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/.exec(source);
  if (!match) throw new Error(`no {% schema %} in ${BLOCK_FILES[target]}`);
  const schema = JSON.parse(match[1]) as { settings?: SchemaSetting[] };
  const settings: Record<string, unknown> = {};
  for (const setting of schema.settings ?? []) {
    if (!setting.id) continue;
    settings[setting.id] =
      setting.default === undefined ? undefined : setting.default;
  }
  schemaCache.set(target, settings);
  return { ...settings };
}

// ── Product fixture ──────────────────────────────────────────────────────────

/**
 * Ids chosen to look like the real thing (Shopify serves numeric ids to
 * Liquid) and to be stable, so the zero-config snapshot is byte-stable.
 */
export const FIXTURE = {
  productId: 7712300000001,
  groupId: 6612300000009,
  variantIds: { small: 4411100011101, large: 4411100011102 },
  planIds: { weeks4: 6881100001, weeks6: 6881100002, weeks8: 6881100003 },
  prices: { small: 6400, large: 9800 },
} as const;

export interface SellingPlanFixture {
  id: number;
  name: string;
  options: Array<{ name: string; value: string }>;
  recurring_deliveries: boolean;
}

export interface AllocationFixture {
  selling_plan: SellingPlanFixture;
  selling_plan_group_id: number;
  price: number;
  compare_at_price: number;
  /** Optional: an allocation drop can state no per-delivery price at all. */
  per_delivery_price?: number;
  price_adjustments: Array<{ position: number; price: number }>;
}

export interface VariantFixture {
  id: number;
  title: string;
  price: number;
  compare_at_price: number | null;
  available: boolean;
  selling_plan_allocations: AllocationFixture[];
}

export interface ProductFixtureOptions {
  /** Subscription cheaper than one-time (and a deeper first-order discount). */
  hasSavings?: boolean;
  /** Prepaid plan: one charge covers several deliveries. */
  prepaid?: boolean;
  /**
   * The allocation states NO per-delivery price (the key is absent, which
   * Liquid reads as nil — not 0). The widget must fall back to the charge
   * price rather than render the money filter's rendering of nil, and must
   * not claim a per-delivery price it was never given.
   */
  omitPerDeliveryPrice?: boolean;
  /** Subscription-only product: the one-time option is not rendered. */
  requiresSellingPlan?: boolean;
  /** 1 collapses the group to a single cadence (no selector in any version). */
  planCount?: 1 | 2 | 3;
  /** Renames the group so the "contains cellexia" pick is exercised. */
  groupName?: string;
  /** A product with no selling plan groups at all: the block must render nothing. */
  noSellingPlans?: boolean;
  /**
   * The variant the page opens on carries NO allocation in the group, while
   * the group (and the other variant) still does — a product only partly
   * added to the selling plan group. There is no subscription to sell for
   * that variant, and the widget must say so from the first paint.
   */
  selectedVariantHasNoAllocations?: boolean;
}

const PLAN_SPECS: Array<{ id: number; weeks: number }> = [
  { id: FIXTURE.planIds.weeks4, weeks: 4 },
  { id: FIXTURE.planIds.weeks6, weeks: 6 },
  { id: FIXTURE.planIds.weeks8, weeks: 8 },
];

function makePlans(count: number): SellingPlanFixture[] {
  return PLAN_SPECS.slice(0, count).map((spec) => ({
    id: spec.id,
    name: `Delivery every ${spec.weeks} weeks`,
    options: [{ name: "Delivery every", value: `${spec.weeks} weeks` }],
    recurring_deliveries: true,
  }));
}

function makeAllocations(
  variantPrice: number,
  plans: SellingPlanFixture[],
  options: ProductFixtureOptions,
): AllocationFixture[] {
  const hasSavings = options.hasSavings !== false;
  return plans.map((plan) => {
    // 20% off the first order, 10% off every order after it.
    const first = hasSavings ? Math.round(variantPrice * 0.8) : variantPrice;
    const ongoing = hasSavings ? Math.round(variantPrice * 0.9) : variantPrice;
    const allocation: AllocationFixture = {
      selling_plan: plan,
      selling_plan_group_id: FIXTURE.groupId,
      price: first,
      compare_at_price: variantPrice,
      per_delivery_price: options.prepaid ? Math.round(first / 2) : first,
      price_adjustments: hasSavings
        ? [
            { position: 1, price: first },
            { position: 2, price: ongoing },
          ]
        : [{ position: 1, price: first }],
    };
    // Absent, not zero: Liquid must see nil, the way the drop behaves when
    // the platform states no per-delivery price for the allocation.
    if (options.omitPerDeliveryPrice) delete allocation.per_delivery_price;
    return allocation;
  });
}

/** A product shaped exactly like the storefront `product` drop the block reads. */
export function makeProduct(options: ProductFixtureOptions = {}) {
  const plans = makePlans(options.planCount ?? 3);
  const variants: VariantFixture[] = [
    {
      id: FIXTURE.variantIds.small,
      title: "30 ml",
      price: FIXTURE.prices.small,
      compare_at_price: null,
      available: true,
      selling_plan_allocations: makeAllocations(
        FIXTURE.prices.small,
        plans,
        options,
      ),
    },
    {
      id: FIXTURE.variantIds.large,
      title: "50 ml",
      price: FIXTURE.prices.large,
      compare_at_price: null,
      available: true,
      selling_plan_allocations: makeAllocations(
        FIXTURE.prices.large,
        plans,
        options,
      ),
    },
  ];
  if (options.selectedVariantHasNoAllocations) {
    variants[0].selling_plan_allocations = [];
  }
  const group = {
    id: FIXTURE.groupId,
    name: options.groupName ?? "Cellexia Ritual",
    app_id: "cellexia",
    selling_plans: plans,
  };
  return {
    id: FIXTURE.productId,
    title: "Cellexia Serum",
    handle: "cellexia-serum",
    url: "/products/cellexia-serum",
    available: true,
    requires_selling_plan: options.requiresSellingPlan === true,
    price: FIXTURE.prices.small,
    featured_image: {
      src: "//cdn.shopify.com/s/files/1/0000/0001/products/serum.jpg",
      alt: "Cellexia Serum",
      width: 1200,
      height: 1200,
    },
    variants,
    selected_or_first_available_variant: variants[0],
    selling_plan_groups: options.noSellingPlans ? [] : [group],
  };
}

// ── Context factory ──────────────────────────────────────────────────────────

export interface MakeContextOptions extends ProductFixtureOptions {
  /** Which installation path to render. Defaults to the section app block. */
  target?: BlockTarget;
  /**
   * The published design config (shop metafield cellexia.buybox_design).
   * `undefined`/`null` means the METAFIELD IS ABSENT — the zero-config
   * fallback a brand-new install renders with.
   */
  config?: Record<string, unknown> | null;
  /**
   * shop.metafields.cellexia.launch_status.value; null = metafield absent.
   * Typed as a plain string so tests can assert the fail-closed behaviour for
   * values the app never writes.
   */
  launchStatus?: "live" | "setup" | (string & {}) | null;
  /** request.locale.iso_code */
  locale?: string;
  /** request.page_type */
  pageType?: string;
  /** Theme-editor settings for the block (merged over the schema defaults). */
  blockSettings?: Record<string, unknown>;
  uid?: string;
  sectionId?: string;
  moneyFormat?: string;
}

export interface RenderContext {
  globals: Record<string, unknown>;
  scope: Record<string, unknown>;
  target: BlockTarget;
}

/**
 * Build the globals + block scope for one render. Everything the snippet
 * reads off the storefront (product, shop metafields, request, settings) is a
 * GLOBAL, because `{% render %}` isolates the scope exactly like Shopify does
 * — passing them in the scope instead would silently hide bugs.
 */
export function makeContext(options: MakeContextOptions = {}): RenderContext {
  const target = options.target ?? "section";
  const product = makeProduct(options);

  const launchStatus =
    options.launchStatus === undefined ? "live" : options.launchStatus;
  const config = options.config ?? null;

  const cellexiaMetafields: Record<string, unknown> = {};
  if (launchStatus !== null) {
    cellexiaMetafields.launch_status = { value: launchStatus, type: "single_line_text_field" };
  }
  if (config !== null) {
    cellexiaMetafields.buybox_design = { value: config, type: "json" };
  }

  const globals: Record<string, unknown> = {
    product,
    shop: {
      name: "Cellexia Labs",
      permanent_domain: "cellexia-labs.myshopify.com",
      domain: "cellexialabs.com",
      currency: "CHF",
      money_format: options.moneyFormat ?? DEFAULT_MONEY_FORMAT,
      money_with_currency_format: DEFAULT_MONEY_WITH_CURRENCY_FORMAT,
      metafields: { cellexia: cellexiaMetafields },
    },
    request: {
      page_type: options.pageType ?? "product",
      host: "cellexialabs.com",
      origin: "https://cellexialabs.com",
      locale: { iso_code: options.locale ?? "en", endonym_name: "English" },
      design_mode: false,
    },
    settings: {},
    template: { name: "product", suffix: "" },
  };

  const uid = options.uid ?? "cx-block-1";
  const scope: Record<string, unknown> = {
    block: {
      id: uid,
      shopify_attributes: `data-shopify-editor-block="{&quot;id&quot;:&quot;${uid}&quot;}"`,
      settings: {
        ...defaultBlockSettings(target),
        ...(options.blockSettings ?? {}),
      },
    },
    section: { id: options.sectionId ?? "template--1__main" },
  };

  return { globals, scope, target };
}

// ── Render entry points ──────────────────────────────────────────────────────

/**
 * Render a block file end to end: the block's own Liquid, its `{% render %}`
 * of cx-buybox-core, and Shopify's app-snippet comment wrapper around it.
 */
export async function renderBlock(
  options: MakeContextOptions = {},
): Promise<string> {
  const { globals, scope, target } = makeContext(options);
  const html = await engine().renderFile(BLOCK_FILES[target], scope, {
    globals,
  });
  return String(html);
}

/** The section app block (the default install path). */
export function renderWidget(
  options: MakeContextOptions = {},
): Promise<string> {
  return renderBlock({ ...options, target: "section" });
}

/** The app embed (the install path used on cellexialabs.com). */
export function renderEmbed(
  options: MakeContextOptions = {},
): Promise<string> {
  return renderBlock({ ...options, target: "embed" });
}

// ── Rendered-HTML helpers ────────────────────────────────────────────────────

/** Strip HTML comments — including Shopify's app-snippet markers. */
export function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Strip <script>/<style>/<noscript> bodies: they are never visible text. */
export function stripNonRenderedBodies(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
}

/**
 * What a shopper actually reads on the page: comments and script/style bodies
 * removed, tags removed (so attribute values, which are not visible text,
 * disappear with them), entities decoded once, whitespace collapsed.
 *
 * Deliberately does NOT drop [hidden] subtrees: for the "must never appear"
 * assertions that is the stricter reading (a comment marker inside a hidden
 * node is still a bug). Positive assertions about copy should therefore check
 * the element's own hidden attribute too — see elementTexts().
 */
export function visibleText(html: string): string {
  const withoutMarkup = stripHtmlComments(stripNonRenderedBodies(html)).replace(
    /<[^>]*>/g,
    " ",
  );
  return decodeEntitiesOnce(withoutMarkup).replace(/\s+/g, " ").trim();
}

/** All tags in the document, as raw source strings. */
export function tags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

/** Tags carrying an attribute (`data-cellexia-save`, `name`, …). */
export function tagsWithAttribute(html: string, attribute: string): string[] {
  const pattern = new RegExp(`(?:^|[\\s])${escapeForRegExp(attribute)}(?=[\\s=>/]|$)`);
  return tags(html).filter((tag) => pattern.test(tag));
}

/** One attribute's raw (still escaped) value, or null. */
export function attributeValue(tag: string, attribute: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${escapeForRegExp(attribute)}\\s*=\\s*"([^"]*)"`,
  ).exec(tag);
  return match ? match[1] : null;
}

/**
 * The decoded text inside every element carrying `attribute`. The widget's
 * hook-bearing nodes (data-cellexia-save, data-cellexia-then, …) contain plain text only,
 * so a non-greedy match to the matching close tag is exact for them.
 */
export function elementTexts(html: string, attribute: string): string[] {
  const pattern = new RegExp(
    `<(\\w+)[^>]*(?:^|\\s)${escapeForRegExp(attribute)}(?=[\\s=>/])[^>]*>([\\s\\S]*?)</\\1>`,
    "g",
  );
  const texts: string[] = [];
  let match = pattern.exec(html);
  while (match !== null) {
    texts.push(
      decodeEntitiesOnce(match[2].replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim(),
    );
    match = pattern.exec(html);
  }
  return texts;
}

/** Every value of an attribute across the document, raw (still escaped). */
export function attributeValues(html: string, attribute: string): string[] {
  const values: string[] = [];
  for (const tag of tagsWithAttribute(html, attribute)) {
    const value = attributeValue(tag, attribute);
    if (value !== null) values.push(value);
  }
  return values;
}

export function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How many times a literal occurs. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The widget root tag (`<div … data-cellexia-buybox …>`), or null. */
export function rootTag(html: string): string | null {
  const roots = tagsWithAttribute(html, "data-cellexia-buybox");
  return roots.length ? roots[0] : null;
}

export interface JsonIsland {
  initialVariant: string;
  initialPlan: string;
  preselect: boolean;
  requiresSellingPlan: boolean;
  variants: Record<
    string,
    {
      available: boolean;
      oneTime: string;
      plans: Record<
        string,
        {
          first: string;
          then: string;
          save: string;
          perDelivery: string;
          pd: string;
          freq: string;
          savePct: string;
        }
      >;
    }
  >;
}

/**
 * Parse the widget's JSON island. Throws (failing the test) when the Liquid
 * emits malformed JSON — the island is what buy-box.js reads for every price.
 */
export function parseJsonIsland(html: string): JsonIsland {
  const match =
    /<script type="application\/json" data-cellexia-data>([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!match) throw new Error("no JSON island (script[data-cellexia-data]) rendered");
  return JSON.parse(match[1]) as JsonIsland;
}

// ── JS ⇄ Liquid contract extraction ──────────────────────────────────────────

/** Read one of the extension's asset files. */
export function readAsset(name: string): string {
  return readFileSync(join(ASSETS_DIR, name), "utf8");
}

/**
 * Every `data-cellexia-*` / `.cx-*` token the storefront JS looks up in the DOM,
 * taken from its querySelector/querySelectorAll/closest/matches and
 * getAttribute/hasAttribute string literals. Each of these is a promise the
 * Liquid must keep; render.test.ts asserts they all exist in the markup.
 *
 * Two sources, because the JS deliberately hoists its own-markup selectors
 * into constants (`OWN_WIDGET = '.cx-buybox[data-cellexia-buybox]'`) so that
 * no document-level lookup can ever be written as a bare `[attribute]` one —
 * the namespace collision with the other `cx-*` vendor on cellexialabs.com is
 * what that guards. Scanning only the call sites would let those hoisted
 * selectors drift away from the markup unnoticed, so selector-shaped string
 * constants are read too.
 */
export function domContractTokens(source: string): string[] {
  const tokens = new Set<string>();

  const collect = (literal: string): void => {
    for (const attribute of literal.match(/data-cellexia-[a-z0-9-]+/g) ?? []) {
      tokens.add(attribute);
    }
    for (const className of literal.match(/\.cx-[A-Za-z0-9_-]+/g) ?? []) {
      tokens.add(className);
    }
  };

  const calls =
    /\.(?:querySelector|querySelectorAll|closest|matches|getAttribute|hasAttribute)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match = calls.exec(source);
  while (match !== null) {
    collect(match[2]);
    match = calls.exec(source);
  }

  // Hoisted selector constants: `NAME = '<selector>'`, kept to the ones that
  // actually look like a selector for our own markup.
  const constants = /=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  match = constants.exec(source);
  while (match !== null) {
    const literal = match[2];
    if (literal.includes("[data-cellexia-") || /^\s*\.cx-/.test(literal)) {
      collect(literal);
    }
    match = constants.exec(source);
  }

  return [...tokens].sort();
}
