import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DOES schema.prisma STILL PARSE — AND DO ITS ENUMS STILL SAY WHAT THE CODE
 * ASSUMES?
 *
 * v1.28.0 shipped a schema.prisma in which a `resolution String? // …`
 * comment line had been pasted INSIDE `enum DunningState`, replacing the
 * `EXHAUSTED` value. `prisma generate` failed outright on the client's
 * machine ("hard error at deploy"), while every test in this suite stayed
 * green because the generated client on the release machine predated the
 * edit and Prisma is mocked everywhere. tests/migration-parity.test.ts
 * replays the SQL chain against the MODELS but never looks inside enum
 * bodies, so the corruption slipped through.
 *
 * Two guards, cheapest first:
 *  1. A parser pass over every `enum … { … }` block: each non-comment line
 *     must be a bare UPPER_SNAKE identifier (optionally with `@map(...)`), and
 *     the enums the runtime references by string must contain the values the
 *     code names (DunningState.EXHAUSTED is the one the dunning engine, the
 *     portal banner and the admin queue all key on).
 *  2. The real thing: `prisma validate` on the file (a dummy DATABASE_URL is
 *     enough — validate never connects). Skipped only when the Prisma CLI is
 *     not resolvable, so a bare CI without node_modules does not fail for the
 *     wrong reason. This is exactly the command that broke at deploy.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "prisma", "schema.prisma");
const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

/** enum name → values (comment lines and blank lines dropped). */
function enums(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    out.set(m[1], body);
  }
  return out;
}

const ENUM_LINE = /^[A-Z][A-Z0-9_]*(\s+@map\("[^"]*"\))?(\s*\/\/.*)?$/;

/**
 * Enum values the runtime references by NAME (string literals in code, not
 * through the generated client's type). If one of these disappears from the
 * schema, Prisma rejects every write that uses it at runtime — long after
 * generate/typecheck/tests all passed. Extend when new code keys on a value.
 */
const REQUIRED_VALUES: Record<string, string[]> = {
  DunningState: [
    "OPEN",
    "RETRYING",
    "AWAITING_CUSTOMER",
    "AWAITING_3DS",
    "RECOVERED",
    "EXHAUSTED",
    "CANCELLED",
  ],
};

describe("schema.prisma enum bodies", () => {
  const parsed = enums(schema);

  it("has at least the enums the required-values table names", () => {
    for (const name of Object.keys(REQUIRED_VALUES)) {
      expect(parsed.has(name), `enum ${name} missing from schema.prisma`).toBe(
        true,
      );
    }
  });

  it("every enum body line is a bare value (no field/comment lines pasted inside)", () => {
    const offenders: string[] = [];
    for (const [name, values] of parsed) {
      for (const v of values) {
        if (!ENUM_LINE.test(v)) offenders.push(`${name}: "${v}"`);
      }
    }
    expect(
      offenders,
      `non-value lines inside enum blocks (this is the v1.28.0 corruption shape): ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  it("enums the code keys on by name still carry every referenced value", () => {
    for (const [name, required] of Object.entries(REQUIRED_VALUES)) {
      const have = (parsed.get(name) ?? []).map((v) => v.split(/\s/)[0]);
      for (const value of required) {
        expect(have, `${name}.${value} missing (have: ${have.join(", ")})`).toContain(
          value,
        );
      }
    }
  });
});

describe("prisma validate", () => {
  const cli = path.join(ROOT, "node_modules", ".bin", "prisma");
  const available = fs.existsSync(cli);

  it.skipIf(!available)(
    "accepts prisma/schema.prisma (the exact command that failed at the v1.28.0 deploy)",
    () => {
      const res = spawnSync(cli, ["validate", "--schema", SCHEMA_PATH], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          // validate never connects; the datasource just needs a well-formed URL.
          DATABASE_URL:
            process.env.DATABASE_URL ?? "postgresql://u:p@localhost:5432/db",
        },
        timeout: 60_000,
        // On Windows, node_modules/.bin/prisma is a .cmd shim, not a directly
        // executable binary — spawnSync needs a shell to run it (otherwise
        // res.status comes back null instead of a real exit code).
        shell: process.platform === "win32",
      });
      expect(
        res.status,
        `prisma validate failed:\n${res.stdout}\n${res.stderr}`,
      ).toBe(0);
    },
    90_000,
  );
});
