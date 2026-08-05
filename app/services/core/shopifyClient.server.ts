/**
 * Thin wrapper around the Shopify Admin GraphQL client.
 *
 * Every service function that talks to Shopify accepts an `AdminGraphql`
 * (the `admin.graphql` function from `authenticate.admin`,
 * `authenticate.webhook`, or `unauthenticated.admin`) so business logic stays
 * independent of how the request was authenticated.
 */
import { unauthenticated } from "~/shopify.server";
import { logger } from "~/lib/logger.server";

export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown,
    public readonly userErrors?: Array<{ field?: string[]; message: string }>,
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

/** Run a query/mutation and unwrap `data`, throwing on transport or GraphQL errors. */
export async function runGraphql<T = Record<string, unknown>>(
  graphql: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as {
    data?: T;
    errors?: unknown;
  };
  if (body.errors) {
    logger.error("shopify graphql error", { errors: body.errors });
    throw new ShopifyGraphqlError("Shopify GraphQL error", body.errors);
  }
  if (!body.data) {
    throw new ShopifyGraphqlError("Shopify GraphQL returned no data", null);
  }
  return body.data;
}

/**
 * Unwrap a mutation payload and throw if it carries userErrors.
 * Usage: `assertNoUserErrors("subscriptionDraftCommit", payload.userErrors)`.
 */
export function assertNoUserErrors(
  operation: string,
  userErrors: Array<{ field?: string[] | null; message: string }> | undefined,
): void {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyGraphqlError(
      `${operation}: ${userErrors.map((e) => e.message).join("; ")}`,
      null,
      userErrors.map((e) => ({ field: e.field ?? undefined, message: e.message })),
    );
  }
}

/** Offline-token admin client for jobs and webhook follow-up work. */
export async function getOfflineAdmin(shop: string): Promise<{
  graphql: AdminGraphql;
}> {
  const { admin } = await unauthenticated.admin(shop);
  return { graphql: admin.graphql as unknown as AdminGraphql };
}

/** Extract the numeric tail of a Shopify GID ("gid://shopify/Product/1" -> "1"). */
export function gidTail(gid: string): string {
  const idx = gid.lastIndexOf("/");
  return idx === -1 ? gid : gid.slice(idx + 1);
}

export function toGid(type: string, id: string | number): string {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/${type}/${s}`;
}
