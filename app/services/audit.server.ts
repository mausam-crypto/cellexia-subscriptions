/**
 * Immutable, hash-chained audit log.
 *
 * Every state-changing operation (billing action, contract edit, save offer,
 * CS override, settings change) MUST append an entry. Rows are append-only;
 * each entry's hash covers the previous entry's hash, so any tampering breaks
 * the chain and is detectable by verifyAuditChain.
 */
import prisma from "~/db.server";
import { sha256Hex } from "~/lib/crypto.server";
import type { ActorType } from "~/types/domain";

export interface AuditEntry {
  shop: string;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Sequence-collision retry budget. Callers like finalizeOp sit AFTER a
 * committed Shopify mutation, where a throw releases the idempotency guard
 * and a retry re-issues the mutation — so exhaustion must require truly
 * pathological contention, not just a webhook burst.
 */
const MAX_SEQ_ATTEMPTS = 10;

/** Jittered exponential backoff so colliding writers stop retrying in lockstep. */
function seqBackoffMs(attempt: number): number {
  return 5 * 2 ** attempt + Math.random() * 20;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const payloadJson = JSON.stringify(entry.payload ?? {});
  // Serialised per shop via the (shop, seq) unique constraint: on a rare
  // concurrent conflict we retry with a fresh seq.
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Without backoff every loser re-reads and re-collides in lockstep,
      // making "N concurrent writers" exhaust far fewer than N retries.
      await new Promise((resolve) => setTimeout(resolve, seqBackoffMs(attempt)));
    }
    const last = await prisma.auditLog.findFirst({
      where: { shop: entry.shop },
      orderBy: { seq: "desc" },
      select: { seq: true, hash: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? null;
    const hash = sha256Hex(
      [
        prevHash ?? "genesis",
        entry.shop,
        String(seq),
        entry.actorType,
        entry.actorId ?? "",
        entry.action,
        entry.subjectType ?? "",
        entry.subjectId ?? "",
        payloadJson,
      ].join("|"),
    );
    try {
      await prisma.auditLog.create({
        data: {
          shop: entry.shop,
          seq,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          subjectType: entry.subjectType ?? null,
          subjectId: entry.subjectId ?? null,
          payloadJson,
          prevHash,
          hash,
        },
      });
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== "P2002") throw e; // unique(shop, seq) collision → retry
    }
  }
  throw new Error("appendAudit: could not acquire audit sequence");
}

/** Recompute the chain and report the first broken entry, if any. */
export async function verifyAuditChain(
  shop: string,
): Promise<{ ok: boolean; brokenAtSeq?: number }> {
  const rows = await prisma.auditLog.findMany({
    where: { shop },
    orderBy: { seq: "asc" },
  });
  let prevHash: string | null = null;
  for (const row of rows) {
    const expected = sha256Hex(
      [
        prevHash ?? "genesis",
        row.shop,
        String(row.seq),
        row.actorType,
        row.actorId ?? "",
        row.action,
        row.subjectType ?? "",
        row.subjectId ?? "",
        row.payloadJson,
      ].join("|"),
    );
    if (expected !== row.hash) return { ok: false, brokenAtSeq: row.seq };
    prevHash = row.hash;
  }
  return { ok: true };
}
