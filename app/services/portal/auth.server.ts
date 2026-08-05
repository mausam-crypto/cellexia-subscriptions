/**
 * Portal authentication — magic-link tokens + signed cookie sessions.
 *
 * The customer portal lives on the app domain (PORTAL_BASE_URL) and never
 * uses passwords. Two ways in:
 *
 *  1. Magic link: the customer enters their email, we mint a single-use
 *     30-minute token (only the SHA-256 hash is stored), emit
 *     MAGIC_LINK_REQUESTED and Klaviyo delivers the link. We always answer
 *     "ok" so account existence can never be enumerated.
 *
 *  2. App-proxy hand-off: a storefront "Manage my treatment" link hits the
 *     HMAC-verified app proxy while the customer is logged into the shop.
 *     `proxyHandoff` mints a short-lived (5 minute) single-use token and
 *     302s to the app-domain magic URL. We cannot set the portal cookie from
 *     the proxy response itself — that response is served on the *storefront*
 *     domain, so a Set-Cookie there would never reach the app domain. The
 *     instant token redirect gives the same "no password, no friction"
 *     experience while keeping the session cookie on the right origin.
 *
 * Session cookie: httpOnly, secure, SameSite=Lax, 14 days, signed with
 * MAGIC_LINK_SECRET (fallback SHOPIFY_API_SECRET).
 */
import { createCookieSessionStorage, redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { generateToken, hashToken } from "~/lib/crypto.server";
import { toCents } from "~/lib/money";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import {
  runGraphql,
  toGid,
  type AdminGraphql,
} from "~/services/core/shopifyClient.server";
import {
  planDiscountsFromConfigs,
  type PlanDiscountIndex,
} from "~/components/portal/logic";
import { parseJson } from "~/types/domain";

// ─────────────────────────────── Types ────────────────────────────────────

export interface PortalCustomer {
  shop: string;
  shopifyCustomerId: string;
  email: string;
}

export type MagicLinkFailure = "INVALID" | "EXPIRED" | "USED";

export class MagicLinkError extends Error {
  constructor(public readonly reason: MagicLinkFailure) {
    super(`Magic link ${reason.toLowerCase()}`);
    this.name = "MagicLinkError";
  }
}

export const MAGIC_LINK_TTL_MINUTES = 30;
export const PROXY_HANDOFF_TTL_MINUTES = 5;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

// ─────────────────────────────── Pure helpers (unit-tested) ───────────────

/** Normalise a base URL and build the magic verification link. */
export function magicLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/portal/magic/${token}`;
}

/** A token is usable while unused and strictly before its expiry instant. */
export function isTokenUsable(
  token: { expiresAt: Date; usedAt: Date | null },
  now: Date,
): boolean {
  return token.usedAt === null && now.getTime() < token.expiresAt.getTime();
}

/**
 * The email forms a magic-link lookup may match. Emails are normalised to
 * lowercase at contract ingestion (core), so the lowercase form is the
 * canonical key; the verbatim (trimmed) form rides along as belt-and-braces
 * for rows written before the ingestion fix was deployed. Empty when the
 * input is not plausibly an email.
 */
export function emailLookupCandidates(email: string): string[] {
  const trimmed = email.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized || !normalized.includes("@")) return [];
  return trimmed === normalized ? [normalized] : [normalized, trimmed];
}

/**
 * PURE — login-CSRF guard for the magic-link claim POST. The only legitimate
 * POST to /portal/magic/:token is the confirm button on that very page; a
 * cross-site auto-submitting form could otherwise force a victim's browser to
 * consume an attacker-minted token, pinning their portal session to the
 * attacker's account. Browsers always send `Origin` on POST, so that header
 * carries the enforcement; the `Sec-Fetch-Site` fallback only covers clients
 * that omit it ("none" = user-initiated navigation, e.g. address bar).
 */
export function isSameOriginClaim(
  originHeader: string | null,
  secFetchSite: string | null,
  expectedOrigin: string,
): boolean {
  if (originHeader) return originHeader === expectedOrigin;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

/**
 * Contracts store the Shopify customer id verbatim (usually a GID); the app
 * proxy hands us a bare numeric id. Match either representation.
 */
export function customerIdVariants(id: string): string[] {
  const trimmed = id.trim();
  if (trimmed.startsWith("gid://")) {
    const tail = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return tail && tail !== trimmed ? [trimmed, tail] : [trimmed];
  }
  return [trimmed, toGid("Customer", trimmed)];
}

// ─────────────────────────────── Session storage ──────────────────────────

function portalSecret(): string {
  const secret =
    process.env.MAGIC_LINK_SECRET || process.env.SHOPIFY_API_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MAGIC_LINK_SECRET must be set in production");
  }
  return "cellexia-portal-dev-secret";
}

const portalSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "cx_portal",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secrets: [portalSecret()],
  },
});

export function portalBaseUrl(): string {
  const base =
    process.env.PORTAL_BASE_URL || process.env.SHOPIFY_APP_URL || "";
  return base.replace(/\/+$/, "");
}

// ─────────────────────────────── Magic link flow ──────────────────────────

async function mintToken(
  shop: string,
  shopifyCustomerId: string,
  email: string,
  ttlMinutes: number,
): Promise<string> {
  const token = generateToken();
  await prisma.magicLinkToken.create({
    data: {
      shop,
      shopifyCustomerId,
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
  return token;
}

/**
 * PURE — the Prisma `where` shape for "a live (unused, unexpired) magic link
 * already exists for this address". Shared by the cooldown check and its
 * enumeration-defence decoy twin so both branches issue identically-shaped
 * (and identically-indexed) queries. Semantics match `isTokenUsable`: unused,
 * and strictly before the expiry instant.
 */
export function liveMagicLinkTokenWhere(
  shop: string,
  emails: string[],
  now: Date,
): { shop: string; email: { in: string[] }; usedAt: null; expiresAt: { gt: Date } } {
  return { shop, email: { in: emails }, usedAt: null, expiresAt: { gt: now } };
}

/** Throwaway indexed lookups — the timing pad for the enumeration defence. */
async function decoyTokenLookups(count: number): Promise<void> {
  const decoyHash = hashToken(generateToken());
  for (let i = 0; i < count; i++) {
    await prisma.magicLinkToken.findUnique({
      where: { tokenHash: decoyHash },
      select: { id: true },
    });
  }
}

/**
 * Request a magic sign-in link. ALWAYS resolves `{ ok: true }` regardless of
 * whether the email matches a treatment plan — no account enumeration.
 * Klaviyo delivers the email off the MAGIC_LINK_REQUESTED event.
 *
 * Flood control: while a previously-issued link is still live (unused,
 * unexpired) for this address, no new token is minted and no new email is
 * sent — one outbound magic-link email per (shop, email) per TTL window. An
 * attacker replaying the request form cannot flood the customer's inbox,
 * grow the token/outbox tables unboundedly, or burn Klaviyo send quota; the
 * customer-visible "check your inbox" response is identical, and the link
 * they were already sent keeps working.
 */
export async function requestMagicLink(
  shop: string,
  email: string,
): Promise<{ ok: true }> {
  const normalized = email.trim().toLowerCase();
  // Lowercase-first lookup: ingestion stores customerEmail lowercased, so a
  // customer typing ANY casing of their address always matches. The verbatim
  // form is kept only as rollout belt-and-braces for pre-fix rows.
  const candidates = emailLookupCandidates(email);
  if (candidates.length === 0) return { ok: true };

  const contract = await prisma.subscriptionContract.findFirst({
    where: { shop, customerEmail: { in: candidates } },
    orderBy: { updatedAt: "desc" },
    select: { shopifyCustomerId: true, customerEmail: true },
  });
  if (!contract) {
    // Enumeration defence: the matched branch performs six sequential DB
    // round-trips after this lookup — the cooldown check, then either the
    // real work (token insert, audit read + insert, analytics + outbox
    // inserts) or five decoy lookups when the cooldown short-circuits.
    // Mirror the same shape and number of round-trips with throwaway indexed
    // lookups so response timing does not reveal whether the email matched a
    // treatment plan.
    await prisma.magicLinkToken.findFirst({
      where: liveMagicLinkTokenWhere(
        shop,
        [`${generateToken().toLowerCase()}@decoy.invalid`],
        new Date(),
      ),
      select: { id: true },
    });
    await decoyTokenLookups(5);
    logger.info("portal magic link requested for unknown email", { shop });
    return { ok: true };
  }

  // Cooldown: a live link already covers this address — do not mint or send
  // another (see the flood-control note above).
  const liveToken = await prisma.magicLinkToken.findFirst({
    where: liveMagicLinkTokenWhere(shop, candidates, new Date()),
    select: { id: true },
  });
  if (liveToken) {
    // Timing pad: mirror the mint path's five remaining round-trips so a
    // repeat submission for a real address is not measurably faster than a
    // first one (or than an unknown address).
    await decoyTokenLookups(5);
    logger.info("portal magic link request suppressed — live link exists", {
      shop,
    });
    return { ok: true };
  }

  const token = await mintToken(
    shop,
    contract.shopifyCustomerId,
    contract.customerEmail ?? normalized,
    MAGIC_LINK_TTL_MINUTES,
  );
  const tokenHash = hashToken(token);
  const link = magicLinkUrl(portalBaseUrl(), token);

  await appendAudit({
    shop,
    actorType: "CUSTOMER",
    actorId: contract.shopifyCustomerId,
    action: "PORTAL_MAGIC_LINK_REQUESTED",
    subjectType: "MagicLinkToken",
    subjectId: tokenHash.slice(0, 12),
    payload: { expiresMinutes: MAGIC_LINK_TTL_MINUTES },
  });
  await emitLifecycleEvent({
    shop,
    name: "MAGIC_LINK_REQUESTED",
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail ?? normalized,
    // The raw link is a live bearer credential: keep it out of the
    // AnalyticsEvent warehouse row and hand it only to the Klaviyo outbox.
    payload: {
      expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      tokenRef: tokenHash.slice(0, 12),
    },
    deliveryOnlyPayload: { link },
    dedupeKey: `magic-link:${tokenHash}`,
  });
  return { ok: true };
}

/**
 * Non-mutating token check for GET requests. Email link scanners (Defender
 * SafeLinks, Mimecast, …) prefetch every URL in an email with a GET, so the
 * magic route's loader must never burn the token — it peeks here and the
 * atomic claim happens only on the explicit POST. Returns the failure reason,
 * or null when the token is currently usable.
 */
export async function peekMagicLink(
  token: string,
): Promise<MagicLinkFailure | null> {
  const row = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row) return "INVALID";
  if (row.usedAt) return "USED";
  if (!isTokenUsable({ expiresAt: row.expiresAt, usedAt: row.usedAt }, new Date())) {
    return "EXPIRED";
  }
  return null;
}

/**
 * Verify a magic token, burn it (single use, atomically) and answer with a
 * redirect to /portal carrying the session Set-Cookie. Throws MagicLinkError
 * for invalid / expired / already-used tokens so the route can render a
 * friendly retry screen.
 */
export async function verifyMagicLinkAndCreateSession(
  _request: Request,
  token: string,
): Promise<Response> {
  const tokenHash = hashToken(token);
  const row = await prisma.magicLinkToken.findUnique({ where: { tokenHash } });
  if (!row) throw new MagicLinkError("INVALID");
  if (row.usedAt) throw new MagicLinkError("USED");
  if (!isTokenUsable({ expiresAt: row.expiresAt, usedAt: row.usedAt }, new Date())) {
    throw new MagicLinkError("EXPIRED");
  }

  // Atomic claim: only one request may ever consume the token.
  const claimed = await prisma.magicLinkToken.updateMany({
    where: { tokenHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new MagicLinkError("USED");

  await appendAudit({
    shop: row.shop,
    actorType: "CUSTOMER",
    actorId: row.shopifyCustomerId,
    action: "PORTAL_SIGNED_IN",
    subjectType: "MagicLinkToken",
    subjectId: row.id,
    payload: { via: "magic-link" },
  });

  return createPortalSessionResponse(
    { shop: row.shop, shopifyCustomerId: row.shopifyCustomerId, email: row.email },
    "/portal",
  );
}

async function createPortalSessionResponse(
  customer: PortalCustomer,
  redirectTo: string,
): Promise<Response> {
  const session = await portalSessionStorage.getSession();
  session.set("shop", customer.shop);
  session.set("shopifyCustomerId", customer.shopifyCustomerId);
  session.set("email", customer.email);
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await portalSessionStorage.commitSession(session) },
  });
}

// ─────────────────────────────── Proxy hand-off ───────────────────────────

/**
 * Called from the app-proxy route AFTER `authenticate.public.appProxy` has
 * verified the request HMAC and only with the `logged_in_customer_id` Shopify
 * itself appended. Mints an instant single-use token and 302s (absolute URL)
 * to the app-domain magic route, which sets the portal cookie there.
 */
export async function proxyHandoff(
  shop: string,
  loggedInCustomerId: string,
): Promise<Response> {
  const variants = customerIdVariants(loggedInCustomerId);
  const contract = await prisma.subscriptionContract.findFirst({
    where: { shop, shopifyCustomerId: { in: variants } },
    orderBy: { updatedAt: "desc" },
    select: { shopifyCustomerId: true, customerEmail: true },
  });
  const shopifyCustomerId =
    contract?.shopifyCustomerId ?? toGid("Customer", loggedInCustomerId);
  const email = contract?.customerEmail ?? "";

  const token = await mintToken(
    shop,
    shopifyCustomerId,
    email,
    PROXY_HANDOFF_TTL_MINUTES,
  );
  await appendAudit({
    shop,
    actorType: "CUSTOMER",
    actorId: shopifyCustomerId,
    action: "PORTAL_PROXY_HANDOFF",
    subjectType: "MagicLinkToken",
    subjectId: hashToken(token).slice(0, 12),
    payload: { via: "app-proxy" },
  });
  return redirect(magicLinkUrl(portalBaseUrl(), token), 302);
}

// ─────────────────────────────── Session guards ───────────────────────────

/** Non-throwing session read (used by the layout to decide what to render). */
export async function getPortalCustomer(
  request: Request,
): Promise<PortalCustomer | null> {
  const session = await portalSessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const shop = session.get("shop");
  const shopifyCustomerId = session.get("shopifyCustomerId");
  const email = session.get("email");
  if (
    typeof shop !== "string" ||
    typeof shopifyCustomerId !== "string" ||
    typeof email !== "string" ||
    !shop ||
    !shopifyCustomerId
  ) {
    return null;
  }
  return { shop, shopifyCustomerId, email };
}

/** Loaders/actions call this first; absent session redirects to login. */
export async function requirePortalCustomer(
  request: Request,
): Promise<PortalCustomer> {
  const customer = await getPortalCustomer(request);
  if (!customer) throw redirect("/portal/login");
  return customer;
}

export async function destroyPortalSession(
  request: Request,
  redirectTo = "/portal/login",
): Promise<Response> {
  const session = await portalSessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await portalSessionStorage.destroySession(session) },
  });
}

// ─────────────────────────────── Ownership helpers ────────────────────────

export type PortalContract = NonNullable<
  Awaited<ReturnType<typeof findOwnedContractOrNull>>
>;

async function findOwnedContractOrNull(
  customer: PortalCustomer,
  contractId: string,
) {
  return prisma.subscriptionContract.findFirst({
    where: {
      id: contractId,
      shop: customer.shop,
      shopifyCustomerId: { in: customerIdVariants(customer.shopifyCustomerId) },
    },
    include: {
      lines: { include: { depletion: true } },
      milestones: true,
      addOns: true,
    },
  });
}

/**
 * The mandatory ownership check: every mutation resolves the contract THROUGH
 * this helper (id + shop + customer identity from the verified session), so a
 * tampered form contractId can never touch someone else's plan.
 */
export async function findOwnedContract(
  customer: PortalCustomer,
  contractId: string,
): Promise<PortalContract> {
  const contract = await findOwnedContractOrNull(customer, contractId);
  if (!contract) throw new Response("Not found", { status: 404 });
  return contract;
}

/** All of this customer's contracts, newest first, with lines + depletion. */
export async function findCustomerContracts(
  customer: PortalCustomer,
): Promise<PortalContract[]> {
  return prisma.subscriptionContract.findMany({
    where: {
      shop: customer.shop,
      shopifyCustomerId: { in: customerIdVariants(customer.shopifyCustomerId) },
    },
    include: {
      lines: { include: { depletion: true } },
      milestones: true,
      addOns: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

const STATUS_RANK: Record<string, number> = {
  ACTIVE: 0,
  PAUSED: 1,
  FAILED: 2,
  EXPIRED: 3,
  CANCELLED: 4,
};

/** The contract the portal centres on: ACTIVE first, then PAUSED, etc. */
export async function findPrimaryContract(
  customer: PortalCustomer,
): Promise<PortalContract | null> {
  const contracts = await findCustomerContracts(customer);
  if (contracts.length === 0) return null;
  return [...contracts].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
  )[0];
}

// ─────────────────────────────── Shop / theming helpers ───────────────────

/**
 * The login page has no session yet; resolve which shop a magic-link request
 * belongs to: explicit ?shop= param → PORTAL_SHOP env → the only installed
 * shop (single-brand app). Null when genuinely ambiguous.
 */
export async function resolveLoginShop(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("shop");
  if (fromQuery) return fromQuery;
  if (process.env.PORTAL_SHOP) return process.env.PORTAL_SHOP;
  const settings = await prisma.shopSettings.findMany({
    take: 2,
    select: { shop: true },
  });
  if (settings.length === 1) return settings[0].shop;
  const sessions = await prisma.session.findMany({
    take: 2,
    select: { shop: true },
    distinct: ["shop"],
  });
  if (sessions.length === 1) return sessions[0].shop;
  return null;
}

/** Font asset base URL: ShopSettings.settingsJson.fontBaseUrl → env → null. */
export async function getPortalFontBaseUrl(
  shop: string | null,
): Promise<string | null> {
  if (shop) {
    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    const parsed = parseJson<{ fontBaseUrl?: string }>(
      settings?.settingsJson ?? null,
      {},
    );
    if (parsed.fontBaseUrl) return parsed.fontBaseUrl;
  }
  return process.env.PORTAL_FONT_BASE_URL ?? null;
}

// ─────────────────────────────── Behaviour telemetry ──────────────────────

/**
 * Portal behaviour telemetry — one AnalyticsEvent per page view / successful
 * action (name `PORTAL_VIEW` / `PORTAL_ACTION`, payload {detail, contractId}).
 * Feeds the churn feature `portalVisits30d`. Direct prisma write, exactly
 * like the WIDGET_* events, and NEVER throws: telemetry must not be able to
 * take a customer page down.
 */
export async function trackPortal(
  shop: string,
  shopifyCustomerId: string | null,
  contractId: string | null,
  kind: "VIEW" | "ACTION",
  detail: string,
): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: {
        shop,
        name: `PORTAL_${kind}`,
        contractId,
        shopifyCustomerId,
        payloadJson: JSON.stringify({ detail, contractId }),
      },
    });
  } catch (error) {
    logger.warn("portal telemetry write failed", {
      shop,
      kind,
      detail,
      error: String(error),
    });
  }
}

// ─────────────────────────────── Catalog / variants ───────────────────────
// Shared by the dashboard suggestions, treatment add flow, routine builder
// and the storefront add-on proxy so every surface prices and validates
// variants identically (availability-aware, server-side prices only).

// NOTE FOR INTEGRATION: per convention this document belongs in
// app/graphql/products.ts [core]; move it there once core consolidates.
const PORTAL_PRODUCTS_VARIANTS_QUERY = `#graphql
  query PortalProductsVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variants(first: 20) {
          edges {
            node {
              id
              title
              price
              availableForSale
            }
          }
        }
      }
    }
  }
`;

export interface PortalVariantOption {
  id: string;
  title: string;
  priceCents: number;
}

interface PortalVariantNodesResult {
  nodes: Array<{
    id: string;
    title: string;
    variants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          price: string;
          availableForSale: boolean;
        };
      }>;
    };
  } | null>;
}

/**
 * Currently-sellable variants per product gid. Unavailable variants are
 * excluded here so no portal surface can ever offer (or subscribe someone
 * to) a variant that cannot ship. Fail-soft: a Shopify hiccup returns {}.
 */
export async function fetchVariantsByProduct(
  graphql: AdminGraphql,
  productIds: string[],
): Promise<Record<string, PortalVariantOption[]>> {
  const out: Record<string, PortalVariantOption[]> = {};
  if (productIds.length === 0) return out;
  const ids = [...new Set(productIds.map((id) => toGid("Product", id)))];
  try {
    const data = await runGraphql<PortalVariantNodesResult>(
      graphql,
      PORTAL_PRODUCTS_VARIANTS_QUERY,
      { ids },
    );
    for (const node of data.nodes) {
      if (!node) continue;
      out[node.id] = node.variants.edges
        .filter((edge) => edge.node.availableForSale)
        .map((edge) => ({
          id: edge.node.id,
          title: edge.node.title,
          priceCents: toCents(edge.node.price),
        }));
    }
  } catch (error) {
    logger.warn("portal variant lookup failed", { error: String(error) });
  }
  return out;
}

/** First AVAILABLE variant of a product, or null when none can ship. */
export async function fetchDefaultVariant(
  graphql: AdminGraphql,
  productId: string,
): Promise<PortalVariantOption | null> {
  const gid = toGid("Product", productId);
  const byProduct = await fetchVariantsByProduct(graphql, [gid]);
  const variants = byProduct[gid];
  if (!variants || variants.length === 0) return null;
  return variants[0];
}

/** The shop's selling-plan discount index (see logic.planDiscountsFromConfigs). */
export async function getPlanDiscounts(shop: string): Promise<PlanDiscountIndex> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shop, active: true },
    select: { plansJson: true },
  });
  return planDiscountsFromConfigs(configs.map((c) => c.plansJson));
}
