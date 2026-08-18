/**
 * Thank You page target (purchase.thank-you.block.render). Shopify shows the
 * Thank You page exactly once — revisits land on the Order Status page, whose
 * sibling target (OrderStatus.jsx) carries the survey from there.
 *
 * Preact entry (v1.21.1): `@shopify/ui-extensions/preact` wires the injected
 * `shopify` global's signals into Preact, and the default export renders the
 * shared component into the extension's root.
 */

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { Survey } from "./survey-core.jsx";
import { ManageSubscriptionLink } from "./manage-link.jsx";

// v1.28.0 (P5.2): the "Manage your subscription" entry point renders in the
// same block, above the survey — subscription orders only (manage-link.jsx).
export default async () => {
  render(
    <s-stack gap="base">
      <ManageSubscriptionLink />
      <Survey source="THANK_YOU" orderSource="confirmation" />
    </s-stack>,
    document.body,
  );
};
