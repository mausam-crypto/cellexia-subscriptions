import type { DunningState } from "@prisma/client";

/**
 * The dunning states that mean "case still open" (resolvedAt null). Lives in
 * its own dependency-free module (v1.28.0) so read-only surfaces — the
 * portal's payment-issue view-model, the SMS keyword route — can share the
 * exact list without loading the engine (and its Shopify/notification graph).
 */
export const OPEN_CASE_STATES: DunningState[] = [
  "OPEN",
  "RETRYING",
  "AWAITING_CUSTOMER",
  "AWAITING_3DS",
];
