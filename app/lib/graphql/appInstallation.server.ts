import { type AdminClient, gql } from "./client.server";

/**
 * The access scopes Shopify has actually GRANTED this app's installation —
 * as opposed to the scopes the app requests (process.env.SCOPES). The two
 * drift when a scope was added to the config after install and the merchant
 * never re-approved: everything compiles, most pages work, and the one
 * mutation needing the new scope fails on the live store. The self-check
 * diffs granted against requested to catch exactly that.
 */

const ACCESS_SCOPES_QUERY = `#graphql
  query CellexiaGrantedAccessScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

interface AccessScopesResponse {
  currentAppInstallation?: {
    accessScopes?: Array<{ handle?: string | null } | null> | null;
  } | null;
}

/** Granted scope handles (e.g. "read_products"). Throws on an unreadable
 * installation — callers decide how a failed read is reported. */
export async function getGrantedAccessScopes(
  admin: AdminClient,
): Promise<string[]> {
  const data = await gql<AccessScopesResponse>(admin, ACCESS_SCOPES_QUERY);
  const scopes = data.currentAppInstallation?.accessScopes;
  if (!scopes) {
    throw new Error("Could not read this app's granted access scopes");
  }
  return scopes
    .map((scope) => scope?.handle ?? "")
    .filter((handle) => handle.length > 0);
}
