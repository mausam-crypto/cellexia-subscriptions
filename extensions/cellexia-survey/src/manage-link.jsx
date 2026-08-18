/**
 * "Manage your subscription" entry point (v1.28.0, P5.2) — the same block
 * that carries the post-purchase survey also tells a brand-new subscriber
 * WHERE their subscription lives. Before this, nothing on the Thank You or
 * Order Status page pointed at the portal: the customer's first contact with
 * "manage" was a renewal email — or a native Shopify cancel that bypasses
 * every save.
 *
 * Renders ONLY when the order contains a subscription (selling-plan) line —
 * the same gate the survey uses — and links to the store-domain app-proxy
 * portal, `${shop.storefrontUrl}/apps/cellexia-subs/`. The subpath is
 * hardcoded here for the same reason it is hardcoded in the buy-box assets:
 * extension sources cannot import app modules. tests/extension-manage-link
 * .test.ts pins it to PORTAL_PROXY_SUBPATH (app/lib/portal/proxy-path.ts),
 * so a subpath change cannot leave the extension pointing at a dead URL.
 *
 * Independent of the survey's own gates on purpose: no App URL setting, no
 * backend call, no session token — a link must render even when the survey
 * is switched off, already answered, or the backend is unreachable. Nothing
 * here can fail loudly: no network, no state; a missing storefrontUrl (never
 * seen in practice, typed optional) simply hides the block. Inside the
 * checkout editor it renders unconditionally so the merchant can see and
 * position it, exactly like the survey's editor demo.
 */

/** Store-domain path of the customer portal (app proxy). MUST equal
 *  `/apps/${PORTAL_PROXY_SUBPATH}/` — pinned by tests. */
export const PORTAL_PROXY_PATH = "/apps/cellexia-subs/";

export function ManageSubscriptionLink() {
  const inEditor = Boolean(shopify.extension?.editor);
  const lines = shopify.lines.value;
  const hasSubscription =
    Array.isArray(lines) &&
    lines.some((line) => Boolean(line?.merchandise?.sellingPlan));
  const storefrontUrl = String(shopify.shop?.storefrontUrl ?? "")
    .trim()
    .replace(/\/+$/, "");

  if (!inEditor && (!hasSubscription || !storefrontUrl)) return null;

  const href = `${storefrontUrl}${PORTAL_PROXY_PATH}`;

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="small-200">
        <s-heading>{shopify.i18n.translate("manage.title")}</s-heading>
        <s-text color="subdued">{shopify.i18n.translate("manage.body")}</s-text>
        <s-button href={href} variant="secondary">
          {shopify.i18n.translate("manage.cta")}
        </s-button>
      </s-stack>
    </s-box>
  );
}
