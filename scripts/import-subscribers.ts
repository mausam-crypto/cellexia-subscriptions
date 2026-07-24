/**
 * Cellexia Subscriptions — subscriber CSV import.
 *
 * Migrates subscribers from another platform (Recharge, Bold, spreadsheets…)
 * into native Shopify subscription contracts via
 * `subscriptionContractAtomicCreate`, then mirrors each contract locally,
 * marks it `grandfatheredPricing` and logs `contract.imported`.
 *
 * Usage:
 *   npx tsx scripts/import-subscribers.ts --file docs/sample-import.csv [--dry-run] [--shop my-store.myshopify.com]
 *
 * Preconditions (see docs/MIGRATION.md):
 *   - The app is installed on the shop (offline Admin session in the database).
 *   - .env provides DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET,
 *     SHOPIFY_APP_URL and SCOPES.
 *   - Cards are already vaulted in Shopify. Rows whose customer has no
 *     resolvable payment method are reported as SKIPPED, never half-imported.
 *
 * Behavior:
 *   - Rows are grouped by email + interval_weeks → one contract per group,
 *     one line per distinct variant (duplicate variants merge quantities).
 *   - Idempotent: an email that already has an ACTIVE local contract with the
 *     same interval is reported SKIPPED_DUPLICATE and left untouched.
 *   - --dry-run performs every read/validation (including Shopify lookups)
 *     but no mutation anywhere (no Shopify writes, no DB writes).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadDotEnv } from "./lib/env";
import { parseCsv } from "./lib/csv";

loadDotEnv();

const USAGE = `Usage:
  npx tsx scripts/import-subscribers.ts --file <path.csv> [--dry-run] [--shop <domain.myshopify.com>]

Options:
  --file      Path to the CSV file (columns per docs/sample-import.csv). Required.
  --dry-run   Validate + resolve everything, but perform no mutations at all.
  --shop      Shop domain. Defaults to the single installed shop.`;

// ── Shared types (derived from the final app seams) ──────────────────────────

type ShopifyServerModule = typeof import("../app/shopify.server");
type AdminClient = Awaited<ReturnType<ShopifyServerModule["adminClientForShop"]>>;
type Db = (typeof import("../app/db.server"))["default"];
type DatesModule = typeof import("../app/lib/dates.server");
type LogEventFn = (typeof import("../app/lib/events/log.server"))["logEvent"];

interface UserErrorShape {
  field?: unknown;
  message: string;
}

/** Local equivalent of the GraphQL layer's ShopifyUserError (scripts are self-contained). */
class ShopifyUserError extends Error {
  readonly userErrors: UserErrorShape[];
  constructor(message: string, userErrors: UserErrorShape[]) {
    super(message);
    this.name = "ShopifyUserError";
    this.userErrors = userErrors;
  }
}

// ── CSV row schema ───────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "phone",
  "variant_id",
  "quantity",
  "interval_weeks",
  "next_charge_date",
  "status",
  "price_cents",
  "currency",
  "address1",
  "address2",
  "city",
  "province_code",
  "zip",
  "country_code",
  "payment_method_id",
  "origin",
] as const;

const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const optionalUpper = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .transform((v) => v.toUpperCase())
    .optional(),
);

const requiredInt = (label: string, min: number, max: number) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const t = v.trim();
      if (t === "") return undefined;
      return /^-?\d+$/.test(t) ? Number(t) : t;
    },
    z
      .number({
        required_error: `${label} is required`,
        invalid_type_error: `${label} must be an integer`,
      })
      .int()
      .min(min, `${label} must be >= ${min}`)
      .max(max, `${label} must be <= ${max}`),
  );

/** Bare dates are parsed at 12:00 UTC so the calendar day survives any shop timezone. */
function parseCsvDate(value: string): Date | null {
  const v = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

const rowSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "email is required")
    .email("email is not a valid address")
    .transform((v) => v.toLowerCase()),
  first_name: optionalString,
  last_name: optionalString,
  phone: optionalString,
  variant_id: z
    .string()
    .trim()
    .min(1, "variant_id is required")
    .transform((v, ctx) => {
      if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(v)) return v;
      if (/^\d+$/.test(v)) return `gid://shopify/ProductVariant/${v}`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "variant_id must be a numeric ID or a gid://shopify/ProductVariant/... GID",
      });
      return z.NEVER;
    }),
  quantity: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? "1" : v),
    requiredInt("quantity", 1, 999),
  ),
  interval_weeks: requiredInt("interval_weeks", 1, 52),
  next_charge_date: z
    .string()
    .trim()
    .min(1, "next_charge_date is required")
    .refine(
      (v) => parseCsvDate(v) !== null,
      "next_charge_date must be YYYY-MM-DD or ISO-8601",
    ),
  status: z.preprocess(
    (v) => {
      if (typeof v !== "string" || v.trim() === "") return "ACTIVE";
      const s = v.trim().toUpperCase();
      return s === "ENABLED" ? "ACTIVE" : s;
    },
    z.enum(["ACTIVE", "PAUSED"], {
      errorMap: () => ({ message: "status must be ACTIVE or PAUSED" }),
    }),
  ),
  price_cents: requiredInt("price_cents", 0, 100_000_000),
  currency: z
    .string()
    .trim()
    .min(1, "currency is required")
    .transform((v) => v.toUpperCase())
    .pipe(
      z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code"),
    ),
  address1: z.string().trim().min(1, "address1 is required"),
  address2: optionalString,
  city: z.string().trim().min(1, "city is required"),
  province_code: optionalUpper,
  zip: optionalString,
  country_code: z
    .string()
    .trim()
    .min(1, "country_code is required")
    .transform((v) => v.toUpperCase())
    .pipe(
      z
        .string()
        .regex(/^[A-Z]{2}$/, "country_code must be a 2-letter ISO code"),
    ),
  payment_method_id: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((v, ctx) => {
        if (/^gid:\/\//.test(v)) return v;
        if (/^[A-Za-z0-9_-]+$/.test(v)) {
          return `gid://shopify/CustomerPaymentMethod/${v}`;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "payment_method_id must be a CustomerPaymentMethod token or GID",
        });
        return z.NEVER;
      })
      .optional(),
  ),
  origin: optionalString,
});

type ImportRow = z.infer<typeof rowSchema> & { line: number };

interface RowError {
  line: number;
  email: string;
  message: string;
}

interface ContractGroup {
  key: string;
  email: string;
  intervalWeeks: number;
  rows: ImportRow[];
  warnings: string[];
}

interface MergedLine {
  variantId: string;
  quantity: number;
  priceCents: number;
  sourceLines: number[];
}

interface VariantInfo {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
}

type GroupStatus =
  | "OK"
  | "DRY_RUN_OK"
  | "SKIPPED"
  | "SKIPPED_DUPLICATE"
  | "ERROR";

interface GroupResult {
  rows: string; // source line numbers, e.g. "2,3"
  email: string;
  intervalWeeks: number;
  lineCount: number;
  status: GroupStatus;
  detail: string;
  shopifyContractId?: string;
}

// ── GraphQL documents (Admin API 2025-01, inline so scripts stay self-contained) ──

const CUSTOMER_BY_EMAIL_QUERY = `#graphql
  query CellexiaImportCustomerByEmail($search: String!) {
    customers(first: 1, query: $search) {
      edges {
        node {
          id
          email
        }
      }
    }
  }
`;

const CUSTOMER_CREATE_MUTATION = `#graphql
  mutation CellexiaImportCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        email
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMER_PAYMENT_METHODS_QUERY = `#graphql
  query CellexiaImportPaymentMethods($customerId: ID!) {
    customer(id: $customerId) {
      paymentMethods(first: 25) {
        edges {
          node {
            id
            revokedAt
          }
        }
      }
    }
  }
`;

const VARIANT_QUERY = `#graphql
  query CellexiaImportVariant($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      product {
        id
        title
      }
    }
  }
`;

const ATOMIC_CREATE_MUTATION = `#graphql
  mutation CellexiaImportAtomicCreate($input: SubscriptionContractAtomicCreateInput!) {
    subscriptionContractAtomicCreate(input: $input) {
      contract {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ── Small helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function escapeSearchTerm(term: string): string {
  return term.replace(/(["\\])/g, "\\$1");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 1),
  );
  const line = (cells: string[]) =>
    "| " + cells.map((c, i) => (c ?? "").padEnd(widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(headers), sep, ...rows.map((r) => line(r))].join("\n");
}

function truncate(value: string, max = 70): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * GraphQL call with defensive parsing and throttle-aware retry.
 * userErrors are NOT checked here — each operation checks its own payload.
 */
async function gql<T>(
  admin: AdminClient,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await admin.graphql(
        document,
        variables ? { variables } : undefined,
      );
      const body = (await response.json()) as {
        data?: T;
        errors?: Array<{ message?: string }>;
      };
      if (body.errors && body.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${body.errors
            .map((e) => e.message ?? "unknown error")
            .join("; ")}`,
        );
      }
      if (!body.data) throw new Error("GraphQL response contained no data");
      return body.data;
    } catch (err) {
      lastError = err;
      const message = errorMessage(err);
      if (attempt < maxAttempts && /throttl|429|rate limit/i.test(message)) {
        await sleep(1500 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertNoUserErrors(
  operation: string,
  userErrors: UserErrorShape[] | null | undefined,
): void {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyUserError(
      `${operation}: ${userErrors.map((e) => e.message).join("; ")}`,
      userErrors,
    );
  }
}

// ── Shopify operations (self-contained equivalents of the graphql layer) ─────

async function getCustomerByEmail(
  admin: AdminClient,
  email: string,
): Promise<{ id: string; email: string | null } | null> {
  const data = await gql<{
    customers?: {
      edges?: Array<{ node?: { id?: string; email?: string | null } | null } | null> | null;
    } | null;
  }>(admin, CUSTOMER_BY_EMAIL_QUERY, {
    search: `email:"${escapeSearchTerm(email)}"`,
  });
  const node = data.customers?.edges?.[0]?.node;
  if (!node?.id) return null;
  // The search API can loosely match; require an exact (case-insensitive) hit.
  if (node.email && node.email.toLowerCase() !== email.toLowerCase()) {
    return null;
  }
  return { id: node.id, email: node.email ?? null };
}

async function createCustomer(
  admin: AdminClient,
  row: ImportRow,
): Promise<{ id: string }> {
  const base = compact({
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
  });

  const attempt = async (input: Record<string, unknown>) => {
    const data = await gql<{
      customerCreate?: {
        customer?: { id?: string } | null;
        userErrors?: UserErrorShape[] | null;
      } | null;
    }>(admin, CUSTOMER_CREATE_MUTATION, { input });
    assertNoUserErrors("customerCreate", data.customerCreate?.userErrors);
    const id = data.customerCreate?.customer?.id;
    if (!id) throw new Error("customerCreate returned no customer id");
    return { id };
  };

  try {
    return await attempt(row.phone ? { ...base, phone: row.phone } : base);
  } catch (err) {
    if (err instanceof ShopifyUserError) {
      // Invalid legacy phone numbers must not block the migration.
      if (row.phone && /phone/i.test(err.message)) {
        return attempt(base);
      }
      // Raced/imprecise search: the customer actually exists — re-resolve.
      if (/taken|already exists/i.test(err.message)) {
        const existing = await getCustomerByEmail(admin, row.email);
        if (existing) return { id: existing.id };
      }
    }
    throw err;
  }
}

/** Non-revoked payment method GIDs, in Shopify's order. */
async function listCustomerPaymentMethods(
  admin: AdminClient,
  customerId: string,
): Promise<string[]> {
  const data = await gql<{
    customer?: {
      paymentMethods?: {
        edges?: Array<{
          node?: { id?: string; revokedAt?: string | null } | null;
        } | null> | null;
      } | null;
    } | null;
  }>(admin, CUSTOMER_PAYMENT_METHODS_QUERY, { customerId });
  const edges = data.customer?.paymentMethods?.edges ?? [];
  const ids: string[] = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (node?.id && !node.revokedAt) ids.push(node.id);
  }
  return ids;
}

async function resolveVariant(
  admin: AdminClient,
  cache: Map<string, VariantInfo | null>,
  variantId: string,
): Promise<VariantInfo | null> {
  const cached = cache.get(variantId);
  if (cached !== undefined) return cached;
  const data = await gql<{
    productVariant?: {
      id?: string;
      title?: string | null;
      sku?: string | null;
      product?: { id?: string; title?: string | null } | null;
    } | null;
  }>(admin, VARIANT_QUERY, { id: variantId });
  const v = data.productVariant;
  const info: VariantInfo | null = v?.id
    ? {
        variantId: v.id,
        productId: v.product?.id ?? "",
        productTitle: v.product?.title ?? "Imported product",
        variantTitle: v.title ?? null,
        sku: v.sku ?? null,
      }
    : null;
  cache.set(variantId, info);
  return info;
}

async function atomicCreateContract(
  admin: AdminClient,
  input: Record<string, unknown>,
): Promise<{ id: string; status: string | null }> {
  const data = await gql<{
    subscriptionContractAtomicCreate?: {
      contract?: { id?: string; status?: string | null } | null;
      userErrors?: UserErrorShape[] | null;
    } | null;
  }>(admin, ATOMIC_CREATE_MUTATION, { input });
  const payload = data.subscriptionContractAtomicCreate;
  assertNoUserErrors("subscriptionContractAtomicCreate", payload?.userErrors);
  const id = payload?.contract?.id;
  if (!id) {
    throw new Error("subscriptionContractAtomicCreate returned no contract id");
  }
  return { id, status: payload?.contract?.status ?? null };
}

// ── Contracts-module sync seam (probed lazily; may not exist standalone) ─────

type SyncContractFn = (shopDomain: string, contractRef: string) => Promise<unknown>;

let cachedSyncFn: SyncContractFn | null | undefined;

/**
 * The contracts module owns `syncContractFromShopify`. Its exact file is that
 * module's concern, so we probe the two documented locations at runtime with
 * non-literal specifiers (keeps this script compiling and working standalone).
 * If neither resolves we fall back to the local mirror below — the import
 * never depends on another module being finished.
 */
async function resolveSyncContractFn(): Promise<SyncContractFn | null> {
  if (cachedSyncFn !== undefined) return cachedSyncFn;
  const candidates: string[] = [
    "../app/lib/contracts/sync.server",
    "../app/lib/contracts/service.server",
  ];
  for (const specifier of candidates) {
    try {
      const mod = (await import(specifier)) as Record<string, unknown>;
      const fn = mod["syncContractFromShopify"];
      if (typeof fn === "function") {
        cachedSyncFn = fn as SyncContractFn;
        return cachedSyncFn;
      }
    } catch {
      // Module not present — try the next candidate.
    }
  }
  cachedSyncFn = null;
  return null;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

function groupRows(rows: ImportRow[]): ContractGroup[] {
  const groups = new Map<string, ContractGroup>();
  for (const row of rows) {
    const key = `${row.email}::${row.interval_weeks}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        email: row.email,
        intervalWeeks: row.interval_weeks,
        rows: [],
        warnings: [],
      };
      groups.set(key, group);
    } else {
      const first = group.rows[0];
      const diffs: string[] = [];
      if (row.status !== first.status) diffs.push("status");
      if (row.currency !== first.currency) diffs.push("currency");
      if (row.next_charge_date !== first.next_charge_date) {
        diffs.push("next_charge_date");
      }
      if ((row.payment_method_id ?? "") !== (first.payment_method_id ?? "")) {
        diffs.push("payment_method_id");
      }
      if (
        row.address1 !== first.address1 ||
        row.city !== first.city ||
        (row.zip ?? "") !== (first.zip ?? "") ||
        row.country_code !== first.country_code
      ) {
        diffs.push("address");
      }
      if (diffs.length > 0) {
        group.warnings.push(
          `line ${row.line} differs from line ${first.line} on ${diffs.join(", ")} — using line ${first.line}'s values`,
        );
      }
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

function mergeLines(group: ContractGroup): MergedLine[] {
  const map = new Map<string, MergedLine>();
  for (const row of group.rows) {
    const existing = map.get(row.variant_id);
    if (existing) {
      existing.quantity += row.quantity;
      existing.sourceLines.push(row.line);
      if (existing.priceCents !== row.price_cents) {
        group.warnings.push(
          `line ${row.line}: price_cents differs for repeated variant ${row.variant_id} — using ${existing.priceCents}`,
        );
      }
    } else {
      map.set(row.variant_id, {
        variantId: row.variant_id,
        quantity: row.quantity,
        priceCents: row.price_cents,
        sourceLines: [row.line],
      });
    }
  }
  return [...map.values()];
}

// ── Contract construction ────────────────────────────────────────────────────

function resolveNextBillingDate(
  raw: string,
  tz: string,
  warnings: string[],
  dates: DatesModule,
): Date {
  const parsed = parseCsvDate(raw);
  if (!parsed) throw new Error(`unparseable next_charge_date: ${raw}`);
  if (parsed.getTime() > Date.now()) return parsed;
  const tomorrow = dates.shopDayStartUtc(
    dates.addDaysTz(new Date(), 1, tz),
    tz,
  );
  warnings.push(
    `next_charge_date ${raw} is in the past — moved to ${tomorrow.toISOString().slice(0, 10)}`,
  );
  return tomorrow;
}

function buildAtomicInput(args: {
  group: ContractGroup;
  mergedLines: MergedLine[];
  customerId: string;
  paymentMethodId: string;
  nextBillingDate: Date;
  toDecimal: (cents: number) => string;
}): Record<string, unknown> {
  const first = args.group.rows[0];
  const address = compact({
    address1: first.address1,
    address2: first.address2,
    city: first.city,
    provinceCode: first.province_code,
    zip: first.zip,
    countryCode: first.country_code,
    firstName: first.first_name,
    lastName: first.last_name,
    phone: first.phone,
  });
  return {
    customerId: args.customerId,
    currencyCode: first.currency,
    nextBillingDate: args.nextBillingDate.toISOString(),
    lines: args.mergedLines.map((line) => ({
      productVariantId: line.variantId,
      quantity: line.quantity,
      currentPrice: args.toDecimal(line.priceCents),
    })),
    contract: compact({
      status: first.status,
      paymentMethodId: args.paymentMethodId,
      billingPolicy: {
        interval: "WEEK",
        intervalCount: args.group.intervalWeeks,
      },
      deliveryPolicy: {
        interval: "WEEK",
        intervalCount: args.group.intervalWeeks,
      },
      deliveryMethod: { shipping: { address } },
      note: first.origin
        ? `Imported from ${first.origin} (Cellexia import script)`
        : undefined,
    }),
  };
}

/**
 * Fallback local mirror, used only when the contracts module's
 * `syncContractFromShopify` is unavailable or did not create the local row.
 * Built from CSV + resolved variant data we fully control.
 */
async function mirrorContractLocally(
  prisma: Db,
  args: {
    shopId: string;
    shopifyContractId: string;
    group: ContractGroup;
    mergedLines: MergedLine[];
    variants: Map<string, VariantInfo | null>;
    customerId: string;
    paymentMethodId: string;
    nextBillingDate: Date;
  },
) {
  const first = args.group.rows[0];
  const deliveryAddress = compact({
    address1: first.address1,
    address2: first.address2,
    city: first.city,
    provinceCode: first.province_code,
    zip: first.zip,
    countryCode: first.country_code,
    firstName: first.first_name,
    lastName: first.last_name,
    phone: first.phone,
  });

  return prisma.subscriptionContract.upsert({
    where: { shopifyContractId: args.shopifyContractId },
    create: {
      shopId: args.shopId,
      shopifyContractId: args.shopifyContractId,
      customerId: args.customerId,
      email: args.group.email,
      phone: first.phone ?? null,
      firstName: first.first_name ?? null,
      lastName: first.last_name ?? null,
      status: first.status,
      currencyCode: first.currency,
      intervalWeeks: args.group.intervalWeeks,
      nextBillingDate: args.nextBillingDate,
      paymentMethodId: args.paymentMethodId,
      deliveryAddress: deliveryAddress as object,
      grandfatheredPricing: true,
      lines: {
        create: args.mergedLines.map((line) => {
          const info = args.variants.get(line.variantId);
          return {
            productId: info?.productId ?? "",
            variantId: line.variantId,
            title: info?.productTitle ?? "Imported product",
            variantTitle: info?.variantTitle ?? null,
            sku: info?.sku ?? null,
            quantity: line.quantity,
            currentPriceCents: line.priceCents,
            addedVia: "ADMIN",
          };
        }),
      },
    },
    update: {
      status: first.status,
      nextBillingDate: args.nextBillingDate,
      paymentMethodId: args.paymentMethodId,
      grandfatheredPricing: true,
    },
  });
}

// ── Per-group pipeline ───────────────────────────────────────────────────────

interface ProcessContext {
  admin: AdminClient;
  prisma: Db;
  shop: { id: string; domain: string; ianaTimezone: string };
  dryRun: boolean;
  dates: DatesModule;
  toDecimal: (cents: number) => string;
  logEvent: LogEventFn;
  variantCache: Map<string, VariantInfo | null>;
  importBatchId: string | null;
}

async function processGroup(
  ctx: ProcessContext,
  group: ContractGroup,
): Promise<GroupResult> {
  const first = group.rows[0];
  const base = {
    rows: group.rows.map((r) => r.line).join(","),
    email: group.email,
    intervalWeeks: group.intervalWeeks,
    lineCount: group.rows.length,
  };

  // Idempotency: skip emails that already have an ACTIVE local contract with
  // the same interval.
  const duplicate = await ctx.prisma.subscriptionContract.findFirst({
    where: {
      shopId: ctx.shop.id,
      email: group.email,
      intervalWeeks: group.intervalWeeks,
      status: "ACTIVE",
    },
    select: { id: true, shopifyContractId: true },
  });
  if (duplicate) {
    return {
      ...base,
      status: "SKIPPED_DUPLICATE",
      detail: `active local contract ${duplicate.id} already exists at ${group.intervalWeeks}w`,
    };
  }

  // Validate every variant against Shopify (also feeds the local mirror).
  const mergedLines = mergeLines(group);
  const missingVariants: string[] = [];
  for (const line of mergedLines) {
    const info = await resolveVariant(ctx.admin, ctx.variantCache, line.variantId);
    if (!info) missingVariants.push(line.variantId);
  }
  if (missingVariants.length > 0) {
    return {
      ...base,
      status: "ERROR",
      detail: `variant(s) not found in Shopify: ${missingVariants.join(", ")}`,
    };
  }

  // Resolve the customer.
  const existingCustomer = await getCustomerByEmail(ctx.admin, group.email);

  // Resolve the payment method: explicit column first, else the customer's
  // first non-revoked vaulted method.
  let paymentMethodId = first.payment_method_id ?? null;
  if (existingCustomer) {
    const vaulted = await listCustomerPaymentMethods(
      ctx.admin,
      existingCustomer.id,
    );
    if (paymentMethodId) {
      if (!vaulted.includes(paymentMethodId)) {
        group.warnings.push(
          `payment_method_id ${paymentMethodId} is not among the customer's non-revoked methods — Shopify will validate it`,
        );
      }
    } else {
      paymentMethodId = vaulted[0] ?? null;
    }
  }
  if (!paymentMethodId) {
    return {
      ...base,
      status: "SKIPPED",
      detail: existingCustomer
        ? "no vaulted payment method — vault the card first (docs/MIGRATION.md)"
        : "customer not found in Shopify and no payment_method_id — vault the card first (docs/MIGRATION.md)",
    };
  }

  const nextBillingDate = resolveNextBillingDate(
    first.next_charge_date,
    ctx.shop.ianaTimezone,
    group.warnings,
    ctx.dates,
  );

  if (ctx.dryRun) {
    return {
      ...base,
      status: "DRY_RUN_OK",
      detail: `would create ${first.status} contract: ${mergedLines.length} line(s), ${
        existingCustomer ? "existing customer" : "new customer"
      }, pm ${paymentMethodId}, next charge ${nextBillingDate.toISOString().slice(0, 10)}`,
    };
  }

  const customerId =
    existingCustomer?.id ?? (await createCustomer(ctx.admin, first)).id;

  const input = buildAtomicInput({
    group,
    mergedLines,
    customerId,
    paymentMethodId,
    nextBillingDate,
    toDecimal: ctx.toDecimal,
  });
  const created = await atomicCreateContract(ctx.admin, input);

  // Mirror locally: prefer the contracts module's sync seam, fall back to the
  // local mirror if the seam is unavailable or did not materialize the row.
  const syncFn = await resolveSyncContractFn();
  if (syncFn) {
    try {
      await syncFn(ctx.shop.domain, created.id);
    } catch (err) {
      group.warnings.push(
        `syncContractFromShopify failed (${errorMessage(err)}) — using local mirror`,
      );
    }
  }
  let local = await ctx.prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: created.id },
  });
  if (!local) {
    local = await mirrorContractLocally(ctx.prisma, {
      shopId: ctx.shop.id,
      shopifyContractId: created.id,
      group,
      mergedLines,
      variants: ctx.variantCache,
      customerId,
      paymentMethodId,
      nextBillingDate,
    });
  }

  // Imported subscribers keep their migrated price: grandfather them.
  if (!local.grandfatheredPricing) {
    local = await ctx.prisma.subscriptionContract.update({
      where: { id: local.id },
      data: { grandfatheredPricing: true },
    });
  }

  await ctx.logEvent({
    shopId: ctx.shop.id,
    contractId: local.id,
    customerId,
    email: group.email,
    type: "contract.imported",
    source: "ADMIN",
    actor: "import-script",
    payload: {
      shopifyContractId: created.id,
      importBatchId: ctx.importBatchId,
      origin: first.origin ?? null,
      intervalWeeks: group.intervalWeeks,
      status: first.status,
      lineCount: mergedLines.length,
      priceCentsTotal: mergedLines.reduce(
        (sum, l) => sum + l.priceCents * l.quantity,
        0,
      ),
      currency: first.currency,
      grandfatheredPricing: true,
      sourceLines: group.rows.map((r) => r.line),
    },
  });

  return {
    ...base,
    status: "OK",
    detail: `created ${created.id}`,
    shopifyContractId: created.id,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: { file?: string; "dry-run"?: boolean; shop?: string };
  try {
    args = parseArgs({
      options: {
        file: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        shop: { type: "string" },
      },
    }).values;
  } catch (err) {
    console.error(errorMessage(err));
    console.error(USAGE);
    process.exit(2);
  }

  if (!args.file) {
    console.error("Missing required --file argument.");
    console.error(USAGE);
    process.exit(2);
  }
  const dryRun = args["dry-run"] === true;

  const filePath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) {
    fail(`CSV file not found: ${filePath}`);
  }

  const { headers, records } = parseCsv(fs.readFileSync(filePath, "utf8"));
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missingColumns.length > 0) {
    fail(
      `CSV is missing required column(s): ${missingColumns.join(", ")}\n` +
        `Expected header (any order): ${REQUIRED_COLUMNS.join(",")}\n` +
        `See docs/sample-import.csv.`,
    );
  }
  if (records.length === 0) {
    fail("CSV contains a header but no data rows — nothing to do.");
  }

  // Validate every row.
  const validRows: ImportRow[] = [];
  const rowErrors: RowError[] = [];
  for (const record of records) {
    const parsed = rowSchema.safeParse(record.data);
    if (parsed.success) {
      validRows.push({ ...parsed.data, line: record.line });
    } else {
      rowErrors.push({
        line: record.line,
        email: record.data.email ?? "",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    }
  }

  const groups = groupRows(validRows);

  console.log(
    `[import] ${records.length} row(s) parsed — ${validRows.length} valid, ` +
      `${rowErrors.length} invalid, ${groups.length} contract group(s)` +
      (dryRun ? " [dry-run]" : ""),
  );

  // App modules are loaded only after .env is in place (see loadDotEnv above).
  const { default: prisma } = await import("../app/db.server");
  const { logEvent } = await import("../app/lib/events/log.server");
  const { requireShop, getPrimaryShop } = await import(
    "../app/lib/shop/install.server"
  );
  const dates = await import("../app/lib/dates.server");
  const { decimalStringFromCents } = await import("../app/lib/money");

  try {
    const shop = args.shop
      ? await requireShop(args.shop).catch(() =>
          fail(
            `Shop ${args.shop} not found locally. Install the app on it first.`,
          ),
        )
      : await getPrimaryShop();
    if (!shop) {
      fail(
        "No installed shop found. Install the app, or pass --shop my-store.myshopify.com.",
      );
    }

    const admin = await (async () => {
      try {
        const { adminClientForShop } = await import("../app/shopify.server");
        return await adminClientForShop(shop.domain);
      } catch (err) {
        return fail(
          `Could not create an Admin API client for ${shop.domain}: ${errorMessage(err)}\n` +
            `Check SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_APP_URL / SCOPES and that ` +
            `the app is installed (offline session present).`,
        );
      }
    })();

    // Track the batch (audit trail). Dry-runs write nothing.
    let importBatchId: string | null = null;
    if (!dryRun) {
      const batch = await prisma.importBatch.create({
        data: {
          shopId: shop.id,
          filename: path.basename(filePath),
          totalRows: records.length,
          status: "RUNNING",
        },
      });
      importBatchId = batch.id;
    }

    const ctx: ProcessContext = {
      admin,
      prisma,
      shop: {
        id: shop.id,
        domain: shop.domain,
        ianaTimezone: shop.ianaTimezone,
      },
      dryRun,
      dates,
      toDecimal: decimalStringFromCents,
      logEvent,
      variantCache: new Map(),
      importBatchId,
    };

    const results: GroupResult[] = [];
    try {
      for (const group of groups) {
        let result: GroupResult;
        try {
          result = await processGroup(ctx, group);
        } catch (err) {
          result = {
            rows: group.rows.map((r) => r.line).join(","),
            email: group.email,
            intervalWeeks: group.intervalWeeks,
            lineCount: group.rows.length,
            status: "ERROR",
            detail: errorMessage(err),
          };
        }
        results.push(result);
        console.log(
          `[import] ${result.email} (${result.intervalWeeks}w): ${result.status}` +
            (result.status === "ERROR" ? ` — ${result.detail}` : ""),
        );
        await sleep(200); // stay well inside API rate limits
      }
    } catch (err) {
      // A crash mid-run must leave a FAILED batch behind, not a RUNNING one.
      if (importBatchId) {
        await prisma.importBatch
          .update({
            where: { id: importBatchId },
            data: {
              status: "FAILED",
              finishedAt: new Date(),
              errors: { fatal: errorMessage(err) } as object,
            },
          })
          .catch(() => undefined);
      }
      throw err;
    }

    // ── Reporting ──
    const rowsIn = (statuses: GroupStatus[]) =>
      results
        .filter((r) => statuses.includes(r.status))
        .reduce((sum, r) => sum + r.lineCount, 0);
    const okRows = rowsIn(["OK", "DRY_RUN_OK"]);
    const duplicateRows = rowsIn(["SKIPPED_DUPLICATE"]);
    const skippedRows = rowsIn(["SKIPPED"]);
    const errorRows = rowsIn(["ERROR"]) + rowErrors.length;
    const succeeded = dryRun ? 0 : rowsIn(["OK"]);

    if (rowErrors.length > 0) {
      console.log("\nInvalid rows (not imported):");
      console.log(
        renderTable(
          ["Line", "Email", "Problem"],
          rowErrors.map((e) => [
            String(e.line),
            e.email,
            truncate(e.message, 90),
          ]),
        ),
      );
    }

    console.log("\nContract groups:");
    console.log(
      renderTable(
        ["Rows", "Email", "Interval", "Lines", "Status", "Detail"],
        results.map((r) => [
          r.rows,
          r.email,
          `${r.intervalWeeks}w`,
          String(r.lineCount),
          r.status,
          truncate(r.detail),
        ]),
      ),
    );

    const groupWarnings = groups
      .filter((g) => g.warnings.length > 0)
      .flatMap((g) => g.warnings.map((w) => `${g.email} (${g.intervalWeeks}w): ${w}`));
    if (groupWarnings.length > 0) {
      console.log("\nWarnings:");
      for (const warning of groupWarnings) console.log(`  - ${warning}`);
    }

    console.log(
      `\nSummary: ${okRows} row(s) ${dryRun ? "importable" : "imported"}, ` +
        `${duplicateRows} duplicate, ${skippedRows} skipped (no payment method), ` +
        `${errorRows} error(s).`,
    );

    if (!dryRun && importBatchId) {
      await prisma.importBatch.update({
        where: { id: importBatchId },
        data: {
          succeeded,
          failed: errorRows,
          status: "DONE",
          finishedAt: new Date(),
          errors: {
            summary: {
              totalRows: records.length,
              validRows: validRows.length,
              invalidRows: rowErrors.length,
              groups: groups.length,
              importedRows: succeeded,
              duplicateRows,
              skippedRows,
              errorRows,
            },
            rowErrors,
            groups: results,
            warnings: groupWarnings,
          } as object,
        },
      });

      await logEvent({
        shopId: shop.id,
        type: "import.completed",
        source: "ADMIN",
        actor: "import-script",
        payload: {
          importBatchId,
          filename: path.basename(filePath),
          totalRows: records.length,
          imported: succeeded,
          duplicates: duplicateRows,
          skipped: skippedRows,
          errors: errorRows,
        },
      });
      console.log(`ImportBatch ${importBatchId} recorded.`);
    } else {
      console.log("[dry-run] no changes were made (Shopify or local database).");
    }

    process.exitCode = errorRows > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`[import] fatal: ${errorMessage(err)}`);
  process.exit(1);
});
