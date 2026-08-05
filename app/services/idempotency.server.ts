/**
 * Idempotency guard for side-effectful operations (billing attempts, contract
 * mutations, webhook processing). The first caller with a given key runs the
 * operation and stores its result; subsequent callers get the stored result
 * without re-running the side effect.
 */
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Note: `ttlMs` must comfortably exceed the longest plausible `fn()` runtime.
 * A row whose `expiresAt` has passed is treated as absent (even if the run
 * that created it is still in flight), so an undersized TTL could let the
 * operation run twice.
 */
export async function withIdempotency<T>(
  key: string,
  scope: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ result: T; replayed: boolean }> {
  const now = new Date();
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (existing && existing.expiresAt > now) {
    if (existing.resultJson !== null) {
      logger.info("idempotency replay", { key, scope });
      return { result: JSON.parse(existing.resultJson) as T, replayed: true };
    }
    // A row without a result means a previous run crashed mid-flight;
    // treat as in-progress and refuse to double-fire the side effect.
    throw new Error(`Idempotent operation already in progress: ${scope}/${key}`);
  }
  if (existing) {
    // Expired row the prune job has not collected yet — treat as absent.
    // The expiresAt condition guarantees this can never race away a fresh
    // row another request just created under the same key.
    await prisma.idempotencyKey.deleteMany({
      where: { key, expiresAt: { lt: now } },
    });
  }

  const claim = () =>
    prisma.idempotencyKey.create({
      data: {
        key,
        scope,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

  try {
    await claim();
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== "P2002") throw e;
    // Lost the race — re-read and replay the stored result if present.
    const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (winner && winner.expiresAt > new Date()) {
      if (winner.resultJson != null) {
        return { result: JSON.parse(winner.resultJson) as T, replayed: true };
      }
      throw new Error(
        `Idempotent operation already in progress: ${scope}/${key}`,
      );
    }
    // The winning row is itself expired (or already gone) — clear it and
    // retry the claim once.
    if (winner) {
      await prisma.idempotencyKey.deleteMany({
        where: { key, expiresAt: { lt: new Date() } },
      });
    }
    try {
      await claim();
    } catch (e2: unknown) {
      if ((e2 as { code?: string }).code === "P2002") {
        throw new Error(
          `Idempotent operation already in progress: ${scope}/${key}`,
        );
      }
      throw e2;
    }
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Release the guard so the caller can retry; only a process crash should
    // leave an in-progress row behind. Filtering on resultJson: null means
    // cleanup can never clobber a completed row, and the swallowed cleanup
    // failure keeps fn()'s error as the one thrown.
    await prisma.idempotencyKey
      .deleteMany({ where: { key, resultJson: null } })
      .catch(() => {});
    throw err;
  }
  await prisma.idempotencyKey.update({
    where: { key },
    data: { resultJson: JSON.stringify(result ?? null) },
  });
  return { result, replayed: false };
}

/** Housekeeping: remove expired keys (call from a scheduled job). */
export async function pruneIdempotencyKeys(): Promise<number> {
  const res = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
