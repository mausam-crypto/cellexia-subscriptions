import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
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
  DataTable,
  Divider,
  DropZone,
  InlineStack,
  Layout,
  List,
  Page,
  Popover,
  Text,
} from "@shopify/polaris";
import { createHash } from "node:crypto";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { decimalStringFromCents } from "~/lib/money";
import { parseCsvDate } from "~/lib/csv-date";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import {
  ShopifyUserError,
  atomicCreateContract,
  ensureNoUserErrors,
  getCustomerByEmail,
  getVariants,
  gql,
  listCustomerPaymentMethods,
  type AdminClient,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import { syncContractFromShopify } from "~/lib/contracts/service.server";

/**
 * Admin — Subscriber import (migration from Recharge / Skio / Appstle / Bold).
 *
 * Upload the migration CSV (format per docs/MIGRATION.md), dry-run it (every
 * read + validation, zero writes anywhere), then execute: real contracts via
 * subscriptionContractAtomicCreate, mirrored locally through
 * syncContractFromShopify, marked grandfatheredPricing, one
 * `contract.imported` event per contract and one `import.completed` per batch.
 *
 * Execute is only possible after a dry run of the *same file* in this session
 * (the server verifies a hash of the CSV against the dry-run token).
 *
 * Large migrations (> {EXECUTE_MAX_ROWS} rows) must use the CLI importer
 * (`npm run import:subscribers`) — a web request is the wrong place for an
 * hour of API calls.
 */

const EXECUTE_MAX_ROWS = 400;
const DRY_RUN_MAX_ROWS = 2000;
/**
 * A RUNNING ImportBatch younger than this blocks any new execute for the shop
 * (see the claim in runImport). Older RUNNING rows are crash residue — a killed
 * process never reaches the DONE/FAILED update — and must not wedge the
 * importer forever. An execute is capped at EXECUTE_MAX_ROWS rows precisely so
 * it finishes well inside a web request; 30 minutes is far beyond any request
 * timeout.
 */
const EXECUTE_RUNNING_STALE_MINUTES = 30;

// ── Compact CSV parser (RFC 4180-ish; quoted fields, CRLF, BOM) ──────────────
// Scripts import from app, never the reverse — so the parser is inlined here
// rather than imported from scripts/lib/csv.ts.

interface CsvRecord {
  line: number;
  data: Record<string, string>;
}

function parseCsv(text: string): { headers: string[]; records: CsvRecord[] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawContent = false;
  let line = 1;
  let rowStartLine = 1;

  const pushField = () => {
    cells.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push({ line: rowStartLine, cells });
    cells = [];
    sawContent = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (ch === ",") {
      pushField();
      sawContent = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      line++;
      if (sawContent || field.length > 0 || cells.length > 0) pushRow();
      rowStartLine = line;
      continue;
    }
    field += ch;
    sawContent = true;
  }
  if (inQuotes) {
    throw new Error(
      `CSV parse error: unterminated quoted field starting near line ${rowStartLine}`,
    );
  }
  if (sawContent || field.length > 0 || cells.length > 0) pushRow();

  const headerRow = rows.shift();
  if (!headerRow) return { headers: [], records: [] };
  const headers = headerRow.cells.map((h) => h.trim().toLowerCase());
  const records: CsvRecord[] = rows.map((row) => {
    const data: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      data[header] = (row.cells[idx] ?? "").trim();
    });
    return { line: row.line, data };
  });
  return { headers, records };
}

// ── Row schema (mirror of scripts/import-subscribers.ts, compacted) ──────────

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

// next_charge_date parsing is the shared strict helper in ~/lib/csv-date —
// see that module for what is accepted and the billing defects a lenient
// `new Date(v)` fallback caused here.

/**
 * Statuses the importer can CREATE (the `status` column enum). The duplicate
 * guard in processGroup checks against THIS exact set — a guard narrower than
 * what the importer creates (the old ACTIVE-only check) let a re-executed
 * file double-create every PAUSED subscriber on Shopify: two live PAUSED
 * contracts that both resume — and both bill — when the customer comes back.
 * Widen this and the guard widens with it.
 */
const IMPORTABLE_STATUSES = ["ACTIVE", "PAUSED"] as const;

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
      "next_charge_date must be YYYY-MM-DD or an ISO-8601 timestamp with timezone (e.g. 2026-06-05 or 2026-06-05T10:00:00Z)",
    ),
  status: z.preprocess(
    (v) => {
      if (typeof v !== "string" || v.trim() === "") return "ACTIVE";
      const s = v.trim().toUpperCase();
      return s === "ENABLED" ? "ACTIVE" : s;
    },
    z.enum(IMPORTABLE_STATUSES, {
      errorMap: () => ({ message: "status must be ACTIVE or PAUSED" }),
    }),
  ),
  price_cents: requiredInt("price_cents", 0, 100_000_000),
  currency: z
    .string()
    .trim()
    .min(1, "currency is required")
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code")),
  address1: z.string().trim().min(1, "address1 is required"),
  address2: optionalString,
  city: z.string().trim().min(1, "city is required"),
  province_code: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((v) => v.toUpperCase())
      .optional(),
  ),
  zip: optionalString,
  country_code: z
    .string()
    .trim()
    .min(1, "country_code is required")
    .transform((v) => v.toUpperCase())
    .pipe(
      z.string().regex(/^[A-Z]{2}$/, "country_code must be a 2-letter ISO code"),
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

// ── Result types ─────────────────────────────────────────────────────────────

interface InvalidRow {
  line: number;
  email: string;
  message: string;
}

type GroupStatus =
  | "OK"
  | "DRY_RUN_OK"
  | "SKIPPED"
  | "SKIPPED_DUPLICATE"
  | "ERROR";

interface GroupResult {
  rows: string;
  email: string;
  intervalWeeks: number;
  lineCount: number;
  status: GroupStatus;
  detail: string;
}

interface RunSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  groups: number;
  okRows: number;
  duplicateRows: number;
  skippedRows: number;
  errorRows: number;
}

interface RunOutput {
  results: GroupResult[];
  invalidRows: InvalidRow[];
  summary: RunSummary;
  batchId: string | null;
}

interface BatchView {
  id: string;
  filename: string;
  createdAt: string;
  totalRows: number;
  succeeded: number;
  failed: number;
  status: string;
  errorsJson: string | null;
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  error?: string;
  dryRunToken?: string;
  results?: GroupResult[];
  invalidRows?: InvalidRow[];
  summary?: RunSummary;
  executedBatchId?: string;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

interface ContractGroup {
  email: string;
  intervalWeeks: number;
  rows: ImportRow[];
  warnings: string[];
}

function groupRows(rows: ImportRow[]): ContractGroup[] {
  const groups = new Map<string, ContractGroup>();
  for (const row of rows) {
    const key = `${row.email}::${row.interval_weeks}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        email: row.email,
        intervalWeeks: row.interval_weeks,
        rows: [],
        warnings: [],
      };
      groups.set(key, group);
    } else {
      const first = group.rows[0];
      if (
        row.next_charge_date !== first.next_charge_date ||
        row.status !== first.status ||
        row.currency !== first.currency
      ) {
        group.warnings.push(
          `line ${row.line} differs from line ${first.line} (date/status/currency) — using line ${first.line}'s values`,
        );
      }
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

interface MergedLine {
  variantId: string;
  quantity: number;
  priceCents: number;
}

function mergeLines(group: ContractGroup): MergedLine[] {
  const map = new Map<string, MergedLine>();
  for (const row of group.rows) {
    const existing = map.get(row.variant_id);
    if (existing) {
      existing.quantity += row.quantity;
      if (existing.priceCents !== row.price_cents) {
        group.warnings.push(
          `line ${row.line}: price differs for repeated variant — using ${existing.priceCents}`,
        );
      }
    } else {
      map.set(row.variant_id, {
        variantId: row.variant_id,
        quantity: row.quantity,
        priceCents: row.price_cents,
      });
    }
  }
  return [...map.values()];
}

// ── Shopify helpers local to the import path ─────────────────────────────────

const CUSTOMER_CREATE_MUTATION = `#graphql
  mutation CellexiaAdminImportCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CustomerCreateResponse {
  customerCreate?: {
    customer?: { id?: string } | null;
    userErrors?: Array<{ field?: string[] | null; message: string }>;
  } | null;
}

async function createCustomer(
  admin: AdminClient,
  row: ImportRow,
): Promise<string> {
  const base: Record<string, unknown> = { email: row.email };
  if (row.first_name) base.firstName = row.first_name;
  if (row.last_name) base.lastName = row.last_name;

  const attempt = async (input: Record<string, unknown>): Promise<string> => {
    const data = await gql<CustomerCreateResponse>(
      admin,
      CUSTOMER_CREATE_MUTATION,
      { input },
    );
    ensureNoUserErrors("customerCreate", data.customerCreate);
    const id = data.customerCreate?.customer?.id;
    if (!id) throw new Error("customerCreate returned no customer id");
    return id;
  };

  try {
    return await attempt(row.phone ? { ...base, phone: row.phone } : base);
  } catch (err) {
    if (err instanceof ShopifyUserError) {
      // Invalid legacy phone numbers must not block a migration.
      if (row.phone && /phone/i.test(err.message)) return attempt(base);
      // Raced/imprecise search — the customer exists after all.
      if (/taken|already exists/i.test(err.message)) {
        const existing = await getCustomerByEmail(admin, row.email);
        if (existing) return existing.id;
      }
    }
    throw err;
  }
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Per-group pipeline ───────────────────────────────────────────────────────

interface RunContext {
  admin: AdminClient;
  shop: { id: string; domain: string; ianaTimezone: string };
  actor: string;
  dryRun: boolean;
  variantsById: Map<string, ShopifyVariant>;
  importBatchId: string | null;
}

function resolveNextBillingDate(
  raw: string,
  tz: string,
  warnings: string[],
): Date {
  const parsed = parseCsvDate(raw);
  if (!parsed) throw new Error(`unparseable next_charge_date: ${raw}`);
  if (parsed.getTime() > Date.now()) return parsed;
  const tomorrow = shopDayStartUtc(addDaysTz(new Date(), 1, tz), tz);
  warnings.push(
    `next_charge_date ${raw} is in the past — moved to ${tomorrow.toISOString().slice(0, 10)}`,
  );
  return tomorrow;
}

async function processGroup(
  ctx: RunContext,
  group: ContractGroup,
): Promise<GroupResult> {
  const first = group.rows[0];
  const base = {
    rows: group.rows.map((r) => r.line).join(","),
    email: group.email,
    intervalWeeks: group.intervalWeeks,
    lineCount: group.rows.length,
  };
  const withWarnings = (detail: string) =>
    group.warnings.length > 0
      ? `${detail}. Warnings: ${group.warnings.join("; ")}`
      : detail;

  // Idempotency: an email that already has a local contract at this interval
  // in ANY status the importer can create (ACTIVE or PAUSED —
  // IMPORTABLE_STATUSES) was already migrated — never double-import. The
  // guard must cover the full creatable set: the sequential re-run the UI
  // supports (fix the errored rows, dry-run again, execute again) re-feeds
  // every group, and an ACTIVE-only check would send each PAUSED subscriber
  // through atomicCreateContract a second time.
  //
  // CASE-INSENSITIVE on purpose (the same pattern as the portal OTP lookup in
  // otp.server.ts): rowSchema lowercases every CSV email, but the mirror this
  // guard scans keeps the case Shopify stored — syncContractFromShopify
  // writes the Shopify customer's email VERBATIM, exactly as the customer
  // typed it at checkout. A plain (case-sensitive) equality therefore missed
  // every subscriber whose stored email carries an uppercase letter, and the
  // prescribed re-run created a SECOND live Shopify contract for them
  // (Shopify's own customer search is case-insensitive, so processGroup finds
  // the customer and bills them twice per interval).
  const duplicate = await prisma.subscriptionContract.findFirst({
    where: {
      shopId: ctx.shop.id,
      email: { equals: group.email, mode: "insensitive" },
      intervalWeeks: group.intervalWeeks,
      status: { in: [...IMPORTABLE_STATUSES] },
    },
    select: { id: true, status: true },
  });
  if (duplicate) {
    return {
      ...base,
      status: "SKIPPED_DUPLICATE",
      detail: `${duplicate.status.toLowerCase()} local contract ${duplicate.id} already exists at ${group.intervalWeeks}w`,
    };
  }

  const mergedLines = mergeLines(group);
  const missingVariants = mergedLines
    .map((l) => l.variantId)
    .filter((id) => !ctx.variantsById.has(id));
  if (missingVariants.length > 0) {
    return {
      ...base,
      status: "ERROR",
      detail: `variant(s) not found in Shopify: ${missingVariants.join(", ")}`,
    };
  }

  const existingCustomer = await getCustomerByEmail(ctx.admin, group.email);

  // Payment method: explicit column first, else the customer's first
  // non-revoked vaulted method.
  let paymentMethodId = first.payment_method_id ?? null;
  if (existingCustomer) {
    const methods = await listCustomerPaymentMethods(
      ctx.admin,
      existingCustomer.id,
    );
    const vaulted = methods.filter((m) => !m.revoked).map((m) => m.id);
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
        ? "no vaulted payment method — vault the card first (docs/MIGRATION.md §3)"
        : "customer not found in Shopify and no payment_method_id — vault the card first (docs/MIGRATION.md §3)",
    };
  }

  const nextBillingDate = resolveNextBillingDate(
    first.next_charge_date,
    ctx.shop.ianaTimezone,
    group.warnings,
  );

  if (ctx.dryRun) {
    return {
      ...base,
      status: "DRY_RUN_OK",
      detail: withWarnings(
        `would create ${first.status} contract: ${mergedLines.length} line(s), ` +
          `${existingCustomer ? "existing customer" : "new customer"}, ` +
          `next charge ${nextBillingDate.toISOString().slice(0, 10)}`,
      ),
    };
  }

  const customerId =
    existingCustomer?.id ?? (await createCustomer(ctx.admin, first));

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

  const created = await atomicCreateContract(ctx.admin, {
    customerId,
    currencyCode: first.currency,
    nextBillingDate,
    lines: mergedLines.map((line) => ({
      productVariantId: line.variantId,
      quantity: line.quantity,
      currentPrice: decimalStringFromCents(line.priceCents),
    })),
    contract: compact({
      status: first.status,
      paymentMethodId,
      billingPolicy: { interval: "WEEK", intervalCount: group.intervalWeeks },
      deliveryPolicy: { interval: "WEEK", intervalCount: group.intervalWeeks },
      deliveryMethod: { shipping: { address } },
      note: first.origin
        ? `Imported from ${first.origin} (Cellexia admin import)`
        : undefined,
    }),
  });

  // Mirror locally through the contracts module; fall back to a compact local
  // mirror if the sync fails (Shopify already holds the truth either way).
  try {
    await syncContractFromShopify(ctx.shop.domain, created.contractId, {
      source: "ADMIN",
      actor: ctx.actor,
    });
  } catch (err) {
    group.warnings.push(
      `syncContractFromShopify failed (${errorMessage(err)}) — using local mirror`,
    );
  }
  let local = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: created.contractId },
  });
  if (!local) {
    local = await prisma.subscriptionContract.create({
      data: {
        shopId: ctx.shop.id,
        shopifyContractId: created.contractId,
        customerId,
        email: group.email,
        phone: first.phone ?? null,
        firstName: first.first_name ?? null,
        lastName: first.last_name ?? null,
        status: first.status,
        currencyCode: first.currency,
        intervalWeeks: group.intervalWeeks,
        nextBillingDate,
        paymentMethodId,
        deliveryAddress: address as object,
        grandfatheredPricing: true,
        // Created by us → ours. Imports carry no selling plan, so the
        // line-based classifier in sync.server can only say UNKNOWN, and
        // UNKNOWN is never billed.
        ownership: "OURS",
        lines: {
          create: mergedLines.map((line) => {
            const variant = ctx.variantsById.get(line.variantId);
            return {
              productId: variant?.productId ?? "",
              variantId: line.variantId,
              title: variant?.productTitle ?? "Imported product",
              variantTitle: variant?.title ?? null,
              sku: variant?.sku ?? null,
              quantity: line.quantity,
              currentPriceCents: line.priceCents,
              compareAtPriceCents: variant?.priceCents ?? null,
              unitCostCents: variant?.unitCostCents ?? null,
              addedVia: "ADMIN",
            };
          }),
        },
      },
    });
  }

  // Imported subscribers keep their migrated price — grandfather them — and
  // are stamped OURS here, the only place with positive evidence that this
  // contract is not another subscription app's (see
  // app/lib/ownership/ownership.server.ts).
  if (!local.grandfatheredPricing || local.ownership !== "OURS") {
    local = await prisma.subscriptionContract.update({
      where: { id: local.id },
      data: { grandfatheredPricing: true, ownership: "OURS" },
    });
  }

  await logEvent({
    shopId: ctx.shop.id,
    contractId: local.id,
    customerId,
    email: group.email,
    type: "contract.imported",
    source: "ADMIN",
    actor: ctx.actor,
    payload: {
      shopifyContractId: created.contractId,
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
    detail: withWarnings(`created ${created.contractId}`),
  };
}

// ── The run (dry or executed) ────────────────────────────────────────────────

function csvToken(csvText: string): string {
  return createHash("sha256").update(csvText).digest("hex");
}

async function runImport(args: {
  admin: AdminClient;
  shop: { id: string; domain: string; ianaTimezone: string };
  actor: string;
  csvText: string;
  filename: string;
  dryRun: boolean;
}): Promise<RunOutput | { error: string }> {
  let parsedCsv;
  try {
    parsedCsv = parseCsv(args.csvText);
  } catch (err) {
    return { error: errorMessage(err) };
  }
  const { headers, records } = parsedCsv;

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missingColumns.length > 0) {
    return {
      error:
        `CSV is missing required column(s): ${missingColumns.join(", ")}. ` +
        `Expected header (any order): ${REQUIRED_COLUMNS.join(",")} — see docs/MIGRATION.md.`,
    };
  }
  if (records.length === 0) {
    return { error: "CSV contains a header but no data rows." };
  }
  if (args.dryRun && records.length > DRY_RUN_MAX_ROWS) {
    return {
      error: `File has ${records.length} rows — above the ${DRY_RUN_MAX_ROWS}-row limit for the admin importer. Use the CLI: npm run import:subscribers.`,
    };
  }
  if (!args.dryRun && records.length > EXECUTE_MAX_ROWS) {
    return {
      error: `File has ${records.length} rows — executing more than ${EXECUTE_MAX_ROWS} rows in a web request risks a timeout. Use the CLI: npm run import:subscribers.`,
    };
  }

  const validRows: ImportRow[] = [];
  const invalidRows: InvalidRow[] = [];
  for (const record of records) {
    const parsed = rowSchema.safeParse(record.data);
    if (parsed.success) {
      validRows.push({ ...parsed.data, line: record.line });
    } else {
      invalidRows.push({
        line: record.line,
        email: record.data.email ?? "",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    }
  }

  const groups = groupRows(validRows);

  // Validate every distinct variant against Shopify up-front (one batch call).
  const variantIds = [...new Set(validRows.map((r) => r.variant_id))];
  let variantsById = new Map<string, ShopifyVariant>();
  try {
    const variants = await getVariants(args.admin, variantIds);
    variantsById = new Map(variants.map((v) => [v.id, v]));
  } catch (err) {
    return { error: `Variant lookup failed: ${errorMessage(err)}` };
  }

  let importBatchId: string | null = null;
  if (!args.dryRun) {
    // One execute per shop at a time. The per-group duplicate guard in
    // processGroup is check-then-create against the local mirror, and the
    // mirror row for a freshly created contract only lands seconds after the
    // Shopify create — so two overlapping executes of the same (dry-run-
    // verified) file would both pass every duplicate check and create every
    // subscriber TWICE on Shopify, billing them double each cycle. The claim
    // below makes "is an execute already running?" + "create my RUNNING
    // batch" atomic: a transaction-scoped advisory lock (same pattern as
    // raiseAlert in analytics/alerts.server.ts) serializes concurrent
    // executes — double-clicked button, second admin tab, two app pods —
    // and exactly one wins; the rest get a clear refusal. Only the claim is
    // under the transaction; the long Shopify work below runs outside it.
    // A crash mid-import strands a RUNNING row, so only batches younger than
    // EXECUTE_RUNNING_STALE_MINUTES block.
    const staleCutoff = new Date(
      Date.now() - EXECUTE_RUNNING_STALE_MINUTES * 60_000,
    );
    // Explicit union so `"running" in claim` narrows: the inferred transaction
    // return type makes both properties optional, which defeats `in` narrowing.
    const claim:
      | { running: { id: string; filename: string | null } }
      | { batch: { id: string } } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${args.shop.id}), hashtext('import_execute'))`;
      const running = await tx.importBatch.findFirst({
        where: {
          shopId: args.shop.id,
          status: "RUNNING",
          createdAt: { gt: staleCutoff },
        },
        select: { id: true, filename: true },
      });
      if (running) return { running };
      const batch = await tx.importBatch.create({
        data: {
          shopId: args.shop.id,
          filename: args.filename,
          totalRows: records.length,
          status: "RUNNING",
        },
      });
      return { batch };
    });
    if ("running" in claim) {
      return {
        error:
          `Another import (${claim.running.filename ?? "unnamed file"}) is still running for this shop. ` +
          `Wait for it to finish — running the same file twice would create every subscriber's contract twice.`,
      };
    }
    importBatchId = claim.batch.id;
  }

  const ctx: RunContext = {
    admin: args.admin,
    shop: args.shop,
    actor: args.actor,
    dryRun: args.dryRun,
    variantsById,
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
    }
  } catch (err) {
    // A crash mid-run must leave a FAILED batch behind, never a RUNNING one.
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

  const rowsIn = (statuses: GroupStatus[]) =>
    results
      .filter((r) => statuses.includes(r.status))
      .reduce((sum, r) => sum + r.lineCount, 0);
  const summary: RunSummary = {
    totalRows: records.length,
    validRows: validRows.length,
    invalidRows: invalidRows.length,
    groups: groups.length,
    okRows: rowsIn(["OK", "DRY_RUN_OK"]),
    duplicateRows: rowsIn(["SKIPPED_DUPLICATE"]),
    skippedRows: rowsIn(["SKIPPED"]),
    errorRows: rowsIn(["ERROR"]) + invalidRows.length,
  };

  if (!args.dryRun && importBatchId) {
    await prisma.importBatch.update({
      where: { id: importBatchId },
      data: {
        succeeded: rowsIn(["OK"]),
        failed: summary.errorRows,
        status: "DONE",
        finishedAt: new Date(),
        errors: {
          summary: summary as unknown as Record<string, unknown>,
          rowErrors: invalidRows,
          groups: results,
        } as object,
      },
    });
    await logEvent({
      shopId: args.shop.id,
      type: "import.completed",
      source: "ADMIN",
      actor: args.actor,
      payload: {
        importBatchId,
        filename: args.filename,
        totalRows: records.length,
        imported: rowsIn(["OK"]),
        duplicates: summary.duplicateRows,
        skipped: summary.skippedRows,
        errors: summary.errorRows,
      },
    });
  }

  return { results, invalidRows, summary, batchId: importBatchId };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const batches = await prisma.importBatch.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const batchViews: BatchView[] = batches.map((batch) => ({
    id: batch.id,
    filename: batch.filename ?? "—",
    createdAt: batch.createdAt.toISOString().replace("T", " ").slice(0, 16),
    totalRows: batch.totalRows,
    succeeded: batch.succeeded,
    failed: batch.failed,
    status: batch.status,
    errorsJson: batch.errors
      ? JSON.stringify(batch.errors, null, 2).slice(0, 4000)
      : null,
  }));

  return json({ batches: batchViews, executeMaxRows: EXECUTE_MAX_ROWS });
};

// ── Action ───────────────────────────────────────────────────────────────────

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const csvText = String(formData.get("csv") ?? "");
  const filename = String(formData.get("filename") ?? "upload.csv");

  if (intent !== "dry-run" && intent !== "execute") {
    return json<ActionData>(
      { intent, ok: false, toast: "Unknown action" },
      { status: 400 },
    );
  }
  if (!csvText.trim()) {
    return json<ActionData>({
      intent,
      ok: false,
      error: "Drop a CSV file first.",
    });
  }

  if (intent === "execute") {
    // Execute only after a dry run of the exact same file in this session.
    const token = String(formData.get("dryRunToken") ?? "");
    if (token !== csvToken(csvText)) {
      return json<ActionData>({
        intent,
        ok: false,
        error:
          "This file has not been dry-run (or changed since the dry run). Run a dry run first.",
      });
    }
  }

  const output = await runImport({
    admin,
    shop: { id: shop.id, domain: shop.domain, ianaTimezone: shop.ianaTimezone },
    actor,
    csvText,
    filename,
    dryRun: intent === "dry-run",
  });

  if ("error" in output) {
    return json<ActionData>({ intent, ok: false, error: output.error });
  }

  return json<ActionData>({
    intent,
    ok: true,
    toast:
      intent === "dry-run"
        ? `Dry run complete: ${output.summary.okRows} importable row(s), ${output.summary.errorRows} error(s)`
        : `Import complete: ${output.summary.okRows} row(s) imported, ${output.summary.errorRows} error(s)`,
    dryRunToken: intent === "dry-run" ? csvToken(csvText) : undefined,
    results: output.results,
    invalidRows: output.invalidRows,
    summary: output.summary,
    executedBatchId: output.batchId ?? undefined,
  });
};

// ── UI ───────────────────────────────────────────────────────────────────────

function statusBadge(status: GroupStatus) {
  switch (status) {
    case "OK":
    case "DRY_RUN_OK":
      return <Badge tone="success">{status === "OK" ? "Imported" : "OK"}</Badge>;
    case "SKIPPED_DUPLICATE":
      return <Badge tone="info">Duplicate</Badge>;
    case "SKIPPED":
      return <Badge tone="warning">Skipped</Badge>;
    default:
      return <Badge tone="critical">Error</Badge>;
  }
}

function batchStatusBadge(status: string) {
  switch (status) {
    case "DONE":
      return <Badge tone="success">Done</Badge>;
    case "RUNNING":
      return <Badge tone="attention">Running</Badge>;
    case "FAILED":
      return <Badge tone="critical">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function BatchErrorsPopover({ batch }: { batch: BatchView }) {
  const [open, setOpen] = useState(false);
  if (!batch.errorsJson) {
    return (
      <Text as="span" tone="subdued">
        —
      </Text>
    );
  }
  return (
    <Popover
      active={open}
      activator={
        <Button size="slim" disclosure onClick={() => setOpen((v) => !v)}>
          Details
        </Button>
      }
      onClose={() => setOpen(false)}
    >
      <Box padding="300" maxWidth="480px">
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0 }}>
            {batch.errorsJson}
          </pre>
        </div>
      </Box>
    </Popover>
  );
}

export default function ImportPage() {
  const { batches, executeMaxRows } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [csvText, setCsvText] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [dryRunCsv, setDryRunCsv] = useState<string | null>(null);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const handleDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      file
        .text()
        .then((text) => {
          setCsvText(text);
          setFilename(file.name);
        })
        .catch(() => {
          setCsvText(null);
          setFilename(null);
        });
    },
    [],
  );

  const busy = navigation.state !== "idle";
  const navIntent = navigation.formData?.get("intent");

  const runDry = () => {
    if (!csvText) return;
    setDryRunCsv(csvText);
    const fd = new FormData();
    fd.set("intent", "dry-run");
    fd.set("filename", filename ?? "upload.csv");
    fd.set("csv", csvText);
    submit(fd, { method: "post" });
  };

  const runExecute = () => {
    if (!csvText || !actionData?.dryRunToken) return;
    const fd = new FormData();
    fd.set("intent", "execute");
    fd.set("filename", filename ?? "upload.csv");
    fd.set("csv", csvText);
    fd.set("dryRunToken", actionData.dryRunToken);
    submit(fd, { method: "post" });
  };

  const dryRunMatchesFile =
    actionData?.intent === "dry-run" &&
    actionData.ok &&
    Boolean(actionData.dryRunToken) &&
    dryRunCsv != null &&
    dryRunCsv === csvText;

  const approxRows = csvText
    ? Math.max(0, csvText.split("\n").filter((l) => l.trim() !== "").length - 1)
    : 0;

  const resultRows = (actionData?.results ?? []).map((result) => [
    result.rows,
    result.email,
    `${result.intervalWeeks}w`,
    String(result.lineCount),
    statusBadge(result.status),
    result.detail,
  ]);

  const invalidRowRows = (actionData?.invalidRows ?? []).map((row) => [
    String(row.line),
    row.email,
    row.message,
  ]);

  const batchRows = batches.map((batch) => [
    batch.createdAt,
    batch.filename,
    String(batch.totalRows),
    String(batch.succeeded),
    String(batch.failed),
    batchStatusBadge(batch.status),
    <BatchErrorsPopover key={batch.id} batch={batch} />,
  ]);

  return (
    <Page
      title="Subscriber import"
      subtitle="Migrate subscribers from Recharge, Skio, Appstle or Bold into native contracts."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner title="Before you import" tone="info">
              <BlockStack gap="150">
                <Text as="p" variant="bodySm">
                  Full runbook: <code>docs/MIGRATION.md</code> (export mapping
                  per source platform, payment-method migration, cutover
                  sequence). The essentials:
                </Text>
                <List type="number">
                  <List.Item>
                    Freeze billing in the old app first — exactly one system may
                    own the next charge.
                  </List.Item>
                  <List.Item>
                    One CSV row per subscription line; rows sharing email +
                    interval become one contract. Header:{" "}
                    <code>{REQUIRED_COLUMNS.join(",")}</code>.
                  </List.Item>
                  <List.Item>
                    Migrate payment methods first — rows without a resolvable
                    vaulted card are skipped, never half-imported.
                  </List.Item>
                  <List.Item>
                    Variants must belong to a synced selling plan group (Plans
                    page), or the create fails.
                  </List.Item>
                  <List.Item>
                    {`Files over ${executeMaxRows} rows: use the CLI importer (npm run import:subscribers) instead of this page.`}
                  </List.Item>
                </List>
              </BlockStack>
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Upload CSV
                </Text>
                <DropZone
                  accept=".csv,text/csv"
                  allowMultiple={false}
                  onDrop={handleDrop}
                >
                  {csvText && filename ? (
                    <Box padding="400">
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="p" fontWeight="medium">
                          {filename}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          {`~${approxRows} data row(s). Drop another file to replace.`}
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload
                      actionTitle="Add CSV file"
                      actionHint="or drop it here"
                    />
                  )}
                </DropZone>
                {actionData?.error ? (
                  <Banner tone="critical">{actionData.error}</Banner>
                ) : null}
                <InlineStack gap="300">
                  <Button
                    onClick={runDry}
                    disabled={!csvText}
                    loading={busy && navIntent === "dry-run"}
                  >
                    Run dry run
                  </Button>
                  <Button
                    variant="primary"
                    onClick={runExecute}
                    disabled={!dryRunMatchesFile}
                    loading={busy && navIntent === "execute"}
                  >
                    Execute import
                  </Button>
                  {!dryRunMatchesFile && csvText ? (
                    <Text as="span" tone="subdued" variant="bodySm">
                      Execute unlocks after a clean dry run of this exact file.
                    </Text>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            {actionData?.summary ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {actionData.intent === "dry-run"
                      ? "Dry-run results (no changes were made)"
                      : "Import results"}
                  </Text>
                  <InlineStack gap="200" wrap>
                    <Badge tone="success">
                      {`${actionData.summary.okRows} ${actionData.intent === "dry-run" ? "importable" : "imported"}`}
                    </Badge>
                    <Badge tone="info">
                      {`${actionData.summary.duplicateRows} duplicate`}
                    </Badge>
                    <Badge tone="warning">
                      {`${actionData.summary.skippedRows} skipped (no payment method)`}
                    </Badge>
                    <Badge tone="critical">
                      {`${actionData.summary.errorRows} error`}
                    </Badge>
                  </InlineStack>
                  {invalidRowRows.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Invalid rows (not imported)
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text", "text"]}
                        headings={["Line", "Email", "Problem"]}
                        rows={invalidRowRows}
                      />
                    </>
                  ) : null}
                  {resultRows.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Contract groups
                      </Text>
                      <DataTable
                        columnContentTypes={[
                          "text",
                          "text",
                          "text",
                          "text",
                          "text",
                          "text",
                        ]}
                        headings={[
                          "CSV lines",
                          "Email",
                          "Interval",
                          "Lines",
                          "Status",
                          "Detail",
                        ]}
                        rows={resultRows}
                      />
                    </>
                  ) : null}
                </BlockStack>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Import history
                </Text>
                {batches.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No import batches yet (CLI imports appear here too).
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                      "text",
                      "text",
                    ]}
                    headings={[
                      "Started",
                      "File",
                      "Rows",
                      "Imported",
                      "Failed",
                      "Status",
                      "Errors",
                    ]}
                    rows={batchRows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
