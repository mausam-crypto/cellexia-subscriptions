import {
  type AdminClient,
  type UserError,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Generic tag mutations for any taggable Admin node (Customer, Order, …).
 * Shopify's tagsAdd / tagsRemove take a bare node GID, append / take away
 * WITHOUT replacing the node's tag set, and are idempotent on the Shopify
 * side: re-adding a present tag and removing an absent one both succeed as
 * no-ops. customers.server.ts keeps its own customer-named copies for the
 * locale-tag helper; this module is the neutral home for callers that tag
 * more than one node type (app/lib/tagging).
 */

const NODE_TAGS_ADD_MUTATION = `#graphql
  mutation CellexiaNodeTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const NODE_TAGS_REMOVE_MUTATION = `#graphql
  mutation CellexiaNodeTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface NodeTagsMutationResponse {
  tagsAdd?: { node?: { id: string } | null; userErrors?: UserError[] } | null;
  tagsRemove?: {
    node?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

/** Add tags to a node (Customer/Order GID). Throws ShopifyUserError on refusal. */
export async function addNodeTags(
  admin: AdminClient,
  nodeGid: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;
  const data = await gql<NodeTagsMutationResponse>(
    admin,
    NODE_TAGS_ADD_MUTATION,
    { id: nodeGid, tags },
  );
  ensureNoUserErrors("tagsAdd", data.tagsAdd);
}

/** Remove tags from a node (Customer/Order GID). Absent tags are a no-op. */
export async function removeNodeTags(
  admin: AdminClient,
  nodeGid: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;
  const data = await gql<NodeTagsMutationResponse>(
    admin,
    NODE_TAGS_REMOVE_MUTATION,
    { id: nodeGid, tags },
  );
  ensureNoUserErrors("tagsRemove", data.tagsRemove);
}
