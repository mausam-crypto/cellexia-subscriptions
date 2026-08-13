/**
 * Order Status page target (customer-account.order-status.block.render).
 * Renders on every revisit of the order page, so the backend status read
 * (already completed? survey disabled?) is what keeps it from re-asking —
 * device-local flags alone would re-ask on a second device.
 *
 * Preact entry (v1.21.1): same shared component as the Thank You target —
 * the s-* elements and the `shopify` global are identical across surfaces.
 */

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { Survey } from "./survey-core.jsx";

export default async () => {
  render(<Survey source="ORDER_STATUS" orderSource="order" />, document.body);
};
