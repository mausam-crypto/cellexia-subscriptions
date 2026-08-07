import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Magic-link token tests with an in-memory MagicLinkToken store standing in
 * for prisma. The mock reproduces the exact semantics the real code relies on:
 *
 *  - `create` inserts a row keyed by tokenHash;
 *  - `updateMany` applies its where-filter and mutation ATOMICALLY (fully
 *    synchronous body, no awaits between check and write) — including the
 *    `useCount < maxUses` conditional expressed via the Prisma field
 *    reference `prisma.magicLinkToken.fields.maxUses`. This is what makes the
 *    concurrent double-consume race testable: exactly one caller can win.
 *  - `findUnique` looks up by tokenHash.
 */

interface TokenRow {
  tokenHash: string;
  action: string;
  contractId: string | null;
  customerId: string | null;
  email: string | null;
  payload: unknown;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
  usedAt: Date | null;
  createdVia: string | null;
}

interface UpdateManyArgs {
  where: {
    tokenHash?: string;
    expiresAt?: { gt?: Date };
    useCount?: { lt?: unknown };
  };
  data: {
    useCount?: { increment?: number };
    usedAt?: Date;
  };
}

const db = vi.hoisted(() => {
  // Sentinel standing in for Prisma's FieldRef<"MagicLinkToken", "Int">.
  const MAX_USES_FIELD = { __fieldRef: "MagicLinkToken.maxUses" };
  const store = new Map<string, TokenRow>();

  const magicLinkToken = {
    fields: { maxUses: MAX_USES_FIELD },

    async create({ data }: { data: Partial<TokenRow> & { tokenHash: string; expiresAt: Date } }) {
      const row: TokenRow = {
        tokenHash: data.tokenHash,
        action: data.action ?? "LOGIN",
        contractId: data.contractId ?? null,
        customerId: data.customerId ?? null,
        email: data.email ?? null,
        payload: data.payload ?? {},
        expiresAt: data.expiresAt,
        maxUses: data.maxUses ?? 1,
        useCount: data.useCount ?? 0,
        usedAt: null,
        createdVia: data.createdVia ?? null,
      };
      store.set(row.tokenHash, row);
      return row;
    },

    // NOTE: the entire filter+mutate loop is synchronous — this emulates the
    // database's atomic conditional UPDATE, so two racing consumers can never
    // both pass the useCount<maxUses check.
    async updateMany({ where, data }: UpdateManyArgs) {
      let count = 0;
      for (const row of store.values()) {
        if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) continue;
        if (where.expiresAt?.gt !== undefined && !(row.expiresAt.getTime() > where.expiresAt.gt.getTime())) continue;
        if (where.useCount?.lt !== undefined) {
          const bound =
            where.useCount.lt === MAX_USES_FIELD
              ? row.maxUses
              : (where.useCount.lt as number);
          if (!(row.useCount < bound)) continue;
        }
        if (data.useCount?.increment) row.useCount += data.useCount.increment;
        if (data.usedAt !== undefined) row.usedAt = data.usedAt;
        count += 1;
      }
      return { count };
    },

    async findUnique({ where }: { where: { tokenHash: string } }) {
      return store.get(where.tokenHash) ?? null;
    },
  };

  return { store, prisma: { magicLinkToken } };
});

vi.mock("~/db.server", () => ({ default: db.prisma }));

import {
  createMagicToken,
  sha256,
  verifyAndConsumeMagicToken,
  verifyMagicTokenSignature,
} from "~/lib/crypto/tokens.server";

const T0 = new Date("2026-07-23T12:00:00Z");

beforeEach(() => {
  db.store.clear();
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flip the final character of the signature segment, keeping its length. */
function tamperSignature(token: string): string {
  const [body, sig] = token.split(".");
  const last = sig.at(-1) === "A" ? "B" : "A";
  return `${body}.${sig.slice(0, -1)}${last}`;
}

describe("sign → verify roundtrip", () => {
  it("creates a token whose payload verifies and round-trips", async () => {
    const token = await createMagicToken({
      action: "SKIP_NEXT",
      contractId: "c_123",
      customerId: "gid://shopify/Customer/1",
      email: "anna@example.com",
      params: { weeks: 2 },
      ttlSeconds: 3600,
      createdVia: "ADMIN",
    });

    // Only the sha256 hash is persisted — never the raw token.
    expect(db.store.has(sha256(token))).toBe(true);
    expect(db.store.has(token)).toBe(false);

    // Peek does not consume.
    const peek = verifyMagicTokenSignature(token);
    expect(peek.ok).toBe(true);
    expect(db.store.get(sha256(token))?.useCount).toBe(0);

    const result = await verifyAndConsumeMagicToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.action).toBe("SKIP_NEXT");
      expect(result.payload.contractId).toBe("c_123");
      expect(result.payload.customerId).toBe("gid://shopify/Customer/1");
      expect(result.payload.email).toBe("anna@example.com");
      expect(result.payload.params).toEqual({ weeks: 2 });
      expect(result.payload.exp).toBe(Math.floor(T0.getTime() / 1000) + 3600);
      expect(result.payload.v).toBe(1);
    }

    const row = db.store.get(sha256(token));
    expect(row?.useCount).toBe(1);
    expect(row?.usedAt).toEqual(new Date());
  });
});

describe("tampering", () => {
  it("rejects a tampered signature", async () => {
    const token = await createMagicToken({
      action: "LOGIN",
      email: "anna@example.com",
      ttlSeconds: 3600,
    });
    const bad = tamperSignature(token);
    expect(bad).not.toBe(token);

    await expect(verifyAndConsumeMagicToken(bad)).resolves.toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
    expect(verifyMagicTokenSignature(bad)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
    // Nothing was consumed.
    expect(db.store.get(sha256(token))?.useCount).toBe(0);
  });

  it("rejects a tampered body (payload swap keeps the old signature invalid)", async () => {
    const token = await createMagicToken({
      action: "SKIP_NEXT",
      contractId: "c_123",
      ttlSeconds: 3600,
    });
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    payload.action = "UPDATE_CARD"; // escalate the verb
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const forged = `${forgedBody}.${sig}`;

    const result = await verifyAndConsumeMagicToken(forged);
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyAndConsumeMagicToken("no-dots-here")).resolves.toEqual({
      ok: false,
      reason: "MALFORMED",
    });
    await expect(verifyAndConsumeMagicToken("a.b.c")).resolves.toEqual({
      ok: false,
      reason: "MALFORMED",
    });
  });
});

describe("expiry", () => {
  it("rejects an expired token (and never touches the store)", async () => {
    const token = await createMagicToken({
      action: "RESUME",
      contractId: "c_9",
      ttlSeconds: 3600,
    });

    vi.setSystemTime(new Date(T0.getTime() + 2 * 3600 * 1000)); // +2h

    await expect(verifyAndConsumeMagicToken(token)).resolves.toEqual({
      ok: false,
      reason: "EXPIRED",
    });
    expect(verifyMagicTokenSignature(token)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
    expect(db.store.get(sha256(token))?.useCount).toBe(0);
  });

  it("accepts a token right up to (but not past) its expiry", async () => {
    const token = await createMagicToken({
      action: "RESUME",
      contractId: "c_9",
      ttlSeconds: 3600,
    });

    vi.setSystemTime(new Date(T0.getTime() + 3599 * 1000));
    const result = await verifyAndConsumeMagicToken(token);
    expect(result.ok).toBe(true);
  });
});

describe("use counting", () => {
  it("single-use: consumed once, then USED", async () => {
    const token = await createMagicToken({
      action: "SKIP_NEXT",
      contractId: "c_1",
      ttlSeconds: 3600,
    });

    const first = await verifyAndConsumeMagicToken(token);
    expect(first.ok).toBe(true);

    const second = await verifyAndConsumeMagicToken(token);
    expect(second).toEqual({ ok: false, reason: "USED" });
    expect(db.store.get(sha256(token))?.useCount).toBe(1);
  });

  it("maxUses 5 allows exactly 5 consumes then blocks", async () => {
    const token = await createMagicToken({
      action: "UPDATE_CARD",
      contractId: "c_1",
      ttlSeconds: 3600,
      maxUses: 5,
    });

    for (let i = 1; i <= 5; i++) {
      const result = await verifyAndConsumeMagicToken(token);
      expect(result.ok, `use #${i} should succeed`).toBe(true);
      expect(db.store.get(sha256(token))?.useCount).toBe(i);
    }

    const sixth = await verifyAndConsumeMagicToken(token);
    expect(sixth).toEqual({ ok: false, reason: "USED" });
    expect(db.store.get(sha256(token))?.useCount).toBe(5);
  });

  it("concurrent double-consume race: exactly one wins", async () => {
    const token = await createMagicToken({
      action: "SKIP_NEXT",
      contractId: "c_race",
      ttlSeconds: 3600,
    });

    const [r1, r2] = await Promise.all([
      verifyAndConsumeMagicToken(token),
      verifyAndConsumeMagicToken(token),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const loser = [r1, r2].find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, reason: "USED" });
    expect(db.store.get(sha256(token))?.useCount).toBe(1);
  });

  it("a validly-signed token missing from the DB is UNKNOWN", async () => {
    const token = await createMagicToken({
      action: "LOGIN",
      email: "anna@example.com",
      ttlSeconds: 3600,
    });
    db.store.clear(); // e.g. token row purged

    await expect(verifyAndConsumeMagicToken(token)).resolves.toEqual({
      ok: false,
      reason: "UNKNOWN",
    });
  });
});
