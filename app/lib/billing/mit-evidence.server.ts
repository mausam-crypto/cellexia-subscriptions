import type { Prisma } from "@prisma/client";

/**
 * MIT / stored-credential compliance evidence for BillingAttempt.mitEvidence.
 *
 * Card-network rules (Visa MIT framework, Mastercard credential-on-file)
 * require every merchant-initiated charge to carry proof that the credential
 * was stored with consent (the subscription's origin order) plus the 3-D
 * Secure outcome whenever the issuer challenged. Every attempt row — scheduled
 * charge, dunning retry, admin manual charge — stores the same blob, and the
 * challenge/resolution path folds the 3DS outcome back into it.
 *
 * Blob shape (all additive, defensively merged):
 *   {
 *     type: "MIT",
 *     storedCredential: true,
 *     consentOrder: "gid://shopify/Order/..." | null,   // origin order = consent snapshot
 *     originatingAction: "SCHEDULER" | "DUNNING_RETRY" | "ADMIN_MANUAL" | "BACKUP_FALLBACK",
 *     timestamp: ISO-8601,                               // when the attempt was created
 *     initiatedBy?: "admin@shop",                        // admin manual charges only
 *     threeDS?: {
 *       challenged: true,
 *       redirectIssued: boolean,                         // bank redirect URL delivered
 *       challengedAt?: ISO-8601,
 *       resolution: "PENDING_CUSTOMER_ACTION" | "SUCCEEDED" | "FAILED",
 *       resolvedAt?: ISO-8601,
 *     },
 *   }
 */

export type MitOriginatingAction =
  | "SCHEDULER"
  | "DUNNING_RETRY"
  | "ADMIN_MANUAL"
  | "BACKUP_FALLBACK";

export type ThreeDsResolution =
  | "PENDING_CUSTOMER_ACTION"
  | "SUCCEEDED"
  | "FAILED";

export interface ThreeDsOutcome {
  challenged: true;
  /** Whether a bank redirect URL was issued with the challenge. */
  redirectIssued?: boolean;
  challengedAt?: string;
  resolution: ThreeDsResolution;
  resolvedAt?: string;
}

export interface BuildMitEvidenceInput {
  /** The subscription's origin order — the consent snapshot for the stored credential. */
  consentOrder: string | null;
  originatingAction: MitOriginatingAction;
  /** When the attempt row was created. */
  timestamp: Date;
  /** Admin email for ADMIN_MANUAL charges. */
  initiatedBy?: string | null;
}

/** Canonical stored-credential/MIT evidence blob for a new billing attempt. */
export function buildMitEvidence(
  input: BuildMitEvidenceInput,
): Prisma.InputJsonObject {
  return {
    type: "MIT",
    storedCredential: true,
    consentOrder: input.consentOrder,
    originatingAction: input.originatingAction,
    timestamp: input.timestamp.toISOString(),
    ...(input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}),
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fold a 3DS outcome into an existing evidence blob without losing the MIT
 * fields already recorded (defensive: attempts imported or created before this
 * evidence existed may carry null / malformed blobs).
 */
export function withThreeDsOutcome(
  existing: Prisma.JsonValue | null | undefined,
  outcome: ThreeDsOutcome,
): Prisma.InputJsonObject {
  const base = asJsonObject(existing);
  const prior = asJsonObject(base.threeDS);
  return {
    ...base,
    threeDS: { ...prior, ...outcome },
  } as Prisma.InputJsonObject;
}

/** Does this evidence blob already record a 3DS challenge? */
export function hasThreeDsEvidence(
  evidence: Prisma.JsonValue | null | undefined,
): boolean {
  return asJsonObject(asJsonObject(evidence).threeDS).challenged === true;
}
