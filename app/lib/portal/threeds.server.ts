import prisma from "~/db.server";
import { gql, type AdminClient } from "~/lib/graphql/client.server";
import { isTrustedShopifyRedirect } from "~/lib/magiclinks/redirect";

/**
 * Portal "Confirm with my bank" (v1.28.0, P1.6). The 3DS challenge used to
 * be reachable ONLY through the CONFIRM_3DS email link — a missed email was
 * a dead end. The banner's AWAITING_3DS state now posts /api/payment_3ds,
 * which resolves the challenge URL of the case's CHALLENGED attempt:
 *
 *  1. ask Shopify for the attempt's current `nextActionUrl` (the same
 *     CellexiaBillingAttemptStatus shape the stale-attempt sweep reads) —
 *     the stored BillingAttempt.challengeUrl is only a fallback when the
 *     query fails, never preferred over a fresh answer;
 *  2. a URL → persist it on BillingAttempt.challengeUrl (when it changed),
 *     gate it with isTrustedShopifyRedirect (https + shopify.com /
 *     myshopify.com only) → `redirect`;
 *  3. no URL → the challenge settled meanwhile → `settled` with the outcome
 *     recheckAttemptOutcome establishes (SUCCESS / FAILED / …), so the
 *     caller can tell the customer the truth instead of bouncing them.
 *
 * Never throws; the caller maps every kind to a toast.
 */

const ATTEMPT_CHALLENGE_QUERY = `#graphql
  query CellexiaBillingAttemptStatus($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      ready
      errorCode
      nextActionUrl
    }
  }
`;

interface AttemptChallengeResponse {
  subscriptionBillingAttempt?: {
    id?: string | null;
    ready?: boolean | null;
    errorCode?: string | null;
    nextActionUrl?: string | null;
  } | null;
}

export type PortalThreeDsOutcome =
  | { kind: "redirect"; url: string; attemptId: string }
  | { kind: "untrusted"; attemptId: string }
  | {
      kind: "settled";
      attemptId: string;
      outcome: "SUCCESS" | "FAILED" | "CHALLENGED" | "EXPIRED" | "UNRESOLVED";
    }
  | { kind: "none" };

export async function resolvePortalThreeDs(input: {
  admin: AdminClient | null;
  attemptId: string | null;
}): Promise<PortalThreeDsOutcome> {
  if (!input.attemptId) return { kind: "none" };
  const attempt = await prisma.billingAttempt.findUnique({
    where: { id: input.attemptId },
    select: {
      id: true,
      status: true,
      shopifyAttemptId: true,
      challengeUrl: true,
    },
  });
  if (!attempt || attempt.status !== "CHALLENGED" || !attempt.shopifyAttemptId) {
    return { kind: "none" };
  }

  let url: string | null = null;
  let queried = false;
  if (input.admin) {
    try {
      const data = await gql<AttemptChallengeResponse>(
        input.admin,
        ATTEMPT_CHALLENGE_QUERY,
        { id: attempt.shopifyAttemptId },
      );
      queried = true;
      url = data.subscriptionBillingAttempt?.nextActionUrl ?? null;
    } catch (err) {
      console.error(
        "[portal] 3DS challenge query failed",
        attempt.shopifyAttemptId,
        err,
      );
    }
  }
  if (!queried) url = attempt.challengeUrl ?? null;

  if (url) {
    if (queried && url !== attempt.challengeUrl) {
      try {
        await prisma.billingAttempt.updateMany({
          where: { id: attempt.id, status: "CHALLENGED" },
          data: { challengeUrl: url },
        });
      } catch (err) {
        console.error("[portal] challengeUrl persist failed", attempt.id, err);
      }
    }
    if (!isTrustedShopifyRedirect(url)) {
      console.error("[portal] 3DS refused untrusted redirect", attempt.id);
      return { kind: "untrusted", attemptId: attempt.id };
    }
    return { kind: "redirect", url, attemptId: attempt.id };
  }

  // Shopify reports no pending action: the challenge settled (or expired)
  // while the customer was away. Re-check through the scheduler's guarded
  // resolution path so the local row and the dunning case catch up.
  let outcome: Extract<PortalThreeDsOutcome, { kind: "settled" }>["outcome"] =
    "UNRESOLVED";
  try {
    const { recheckAttemptOutcome } = await import(
      "~/lib/billing/scheduler.server"
    );
    outcome = await recheckAttemptOutcome(attempt.id);
  } catch (err) {
    console.error("[portal] 3DS outcome re-check failed", attempt.id, err);
  }
  return { kind: "settled", attemptId: attempt.id, outcome };
}
