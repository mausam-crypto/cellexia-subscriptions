import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * STATIC GUARDS for the two things `npm test` and `npm run typecheck` cannot
 * see: `npm run build` and the production Docker image.
 *
 * Both blew up on the v1.2.0 ZIP while the whole suite was green, because
 * nothing in tests/** touches the Remix build or the image:
 *
 *   1. `app/routes/app.tsx` imported Polaris CSS as `…/styles.css?url`. Vite
 *      encodes a `?url` CSS id into a `__VITE_CSS_URL__<hex>__` marker and
 *      hex-decodes it back in `vite:css-post`'s renderChunk. On Node 23.2.x
 *      `Buffer.from(s, "hex")` returns an EMPTY buffer when `s` is a two-byte
 *      (non-Latin1) string — and one non-ASCII character anywhere in the admin
 *      bundle makes the whole chunk two-byte — so the decode yields "" and the
 *      build dies with `[vite:css-post] css content for "" was not found`.
 *      Plain side-effect CSS imports never go near that code path: Remix's
 *      Vite plugin lists a route's CSS in the route manifest and `<Links />`
 *      renders it, which is what `app/root.tsx` does.
 *
 *   2. The Dockerfile ran `npm ci --omit=dev` and then `npm run build`, but the
 *      build chain (@remix-run/dev — the `remix` binary — plus vite and
 *      vite-tsconfig-paths) is in devDependencies: `sh: remix: not found`.
 *      Worse, `ENV NODE_ENV=production` means ANY later `npm remove/install`
 *      re-reifies the tree with --omit=dev and silently deletes the build
 *      chain again, so the fix is order-sensitive, not just flag-deep.
 *
 * These are file-shape assertions on purpose. They cost milliseconds, they run
 * in CI with no Docker daemon and no network, and they fail with the exact
 * sentence a maintainer needs. They do not replace actually running
 * `npm run build` before a release — see docs/UPDATE.md.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), "utf8");
}

const packageJson = JSON.parse(read("package.json")) as {
  version: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  workspaces?: string[];
};

// ── 1. Nothing in app/** may import CSS through Vite's `?url` path ───────────

describe("no `?url` CSS imports (the v1.2.0 build blocker)", () => {
  /** Every .ts/.tsx source file under app/. */
  function appSources(dir = join(REPO_ROOT, "app")): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        found.push(...appSources(full));
      } else if (/\.tsx?$/.test(entry)) {
        found.push(full);
      }
    }
    return found;
  }

  const sources = appSources();

  it("finds the app sources to check", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("imports stylesheets as side effects, never as `?url`", () => {
    // Only real module specifiers — `import x from "….css?url"` and
    // `import "….css?url"` — so prose about the ban does not trip the ban.
    const cssQueryImport = /\b(?:import|from|require\()\s*\(?\s*["'][^"'\n]*\.css\?(url|inline|raw)\b/g;
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(cssQueryImport)) {
        offenders.push(
          `${relative(REPO_ROOT, file)}:${source.slice(0, match.index).split("\n").length} (?${match[1]})`,
        );
      }
    }
    expect(
      offenders,
      "`import x from \"….css?url\"` makes Vite hex-encode the id into a " +
        "__VITE_CSS_URL__ marker, and Node 23.2.x decodes that marker to an " +
        "empty string, breaking `npm run build` with " +
        '`[vite:css-post] css content for "" was not found`. Use a plain ' +
        `\`import "….css"\` — Remix links it from the route manifest:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps <Links /> in the document head so route CSS is emitted", () => {
    // Side-effect CSS imports reach the browser only through the route
    // manifest's `css: [...]`, which <Links /> renders.
    const root = read("app", "root.tsx");
    expect(root).toMatch(/<Links\s*\/>/);
  });
});

// ── 2. The Docker image must be able to build what it starts ─────────────────

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  /** Dockerfile instructions in order, comments stripped, continuations joined. */
  const instructions: string[] = (() => {
    const joined = dockerfile
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n")
      .replace(/\\\n/g, " ");
    return joined
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  })();

  const indexOfInstruction = (pattern: RegExp) =>
    instructions.findIndex((line) => pattern.test(line));

  const installIndex = indexOfInstruction(/^RUN\b.*\bnpm ci\b/);
  const buildIndex = indexOfInstruction(/^RUN\b.*\bnpm run build\b/);

  /** Packages `npm run build` needs that npm would omit in production mode. */
  const buildChainInDevDeps = [
    "@remix-run/dev",
    "vite",
    "vite-tsconfig-paths",
  ].filter((name) => name in packageJson.devDependencies);

  it("installs dependencies before building", () => {
    expect(installIndex, "no `RUN npm ci` in the Dockerfile").toBeGreaterThan(
      -1,
    );
    expect(buildIndex, "no `RUN npm run build` in the Dockerfile").toBeGreaterThan(
      installIndex,
    );
  });

  it("installs the build chain that lives in devDependencies", () => {
    if (buildChainInDevDeps.length === 0) {
      // Someone promoted the build chain to `dependencies` — then a plain
      // production install is enough and this guard has nothing to enforce.
      return;
    }
    const install = instructions[installIndex];
    expect(
      install,
      `${buildChainInDevDeps.join(", ")} are devDependencies and the image ` +
        "runs `npm run build`, but this install omits dev packages — the " +
        "build step fails with `sh: remix: not found`.",
    ).not.toMatch(/--omit[= ]dev|--production|--only[= ]prod/);
    expect(
      install,
      `${buildChainInDevDeps.join(", ")} are devDependencies and the ` +
        "Dockerfile sets NODE_ENV=production, which makes npm skip dev " +
        "packages by default. `npm ci` needs an explicit --include=dev here.",
    ).toMatch(/--include[= ]dev/);
  });

  it("never re-reifies the dependency tree between install and build", () => {
    const between = instructions.slice(installIndex + 1, buildIndex);
    const offenders = between.filter((line) =>
      /^RUN\b.*\bnpm (?:remove|rm|uninstall|un|install|i|add|prune|dedupe)\b/.test(
        line,
      ),
    );
    expect(
      offenders,
      "with NODE_ENV=production these commands re-run the install algorithm " +
        "with --omit=dev and delete every devDependency again, undoing " +
        `--include=dev before the build runs:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("generates the Prisma client before building", () => {
    const prismaIndex = indexOfInstruction(/^RUN\b.*\bprisma generate\b/);
    expect(prismaIndex).toBeGreaterThan(installIndex);
    expect(prismaIndex).toBeLessThan(buildIndex);
  });

  it("keeps the host's node_modules out of the build context", () => {
    // `COPY . .` runs AFTER `npm ci`, so anything the context carries wins.
    // A node_modules tree installed on the developer's machine would replace
    // the image's with macOS/Windows native binaries (Prisma query engine,
    // esbuild) and break `prisma generate` / `npm run build` inside the image.
    expect(
      dockerfile,
      "this guard assumes the Dockerfile copies the whole context",
    ).toMatch(/^COPY \. \.$/m);

    const ignored = read(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    for (const entry of ["node_modules", "build"]) {
      expect(
        ignored,
        `.dockerignore must exclude ${entry}: \`COPY . .\` would otherwise ` +
          "overwrite what `npm ci` and `npm run build` produced in the image",
      ).toContain(entry);
    }
    expect(ignored, ".dockerignore must not ship secrets into a layer").toContain(
      ".env",
    );

    // …while still shipping everything the image builds from.
    for (const needed of ["package.json", "package-lock.json", "app", "prisma"]) {
      expect(
        ignored,
        `.dockerignore excludes ${needed}, which the image needs`,
      ).not.toContain(needed);
    }
  });

  it("starts the app through the documented entrypoint", () => {
    const cmd = instructions.at(-1) ?? "";
    expect(cmd).toMatch(/^CMD\b/);
    expect(cmd).toContain("docker-start");
    // docker-start must still run migrations then boot the server.
    expect(packageJson.scripts["docker-start"]).toBe(
      "npm run setup && npm run start",
    );
    expect(packageJson.scripts.setup).toContain("prisma migrate deploy");
  });
});

// ── 3. Access scopes must cover the Admin API mutations the app executes ─────

describe("access scopes cover the mutations the app calls", () => {
  const scopesOf = (source: string, pattern: RegExp): string[] => {
    const match = source.match(pattern);
    return match ? match[1].split(",").map((s) => s.trim()) : [];
  };
  const tomlScopes = scopesOf(
    read("shopify.app.toml"),
    /^scopes\s*=\s*"([^"]+)"/m,
  );
  const envScopes = scopesOf(read(".env.example"), /^SCOPES=([^\n]+)/m);

  it("parses both scope declarations", () => {
    expect(tomlScopes.length).toBeGreaterThan(0);
    expect(envScopes.length).toBeGreaterThan(0);
  });

  it("keeps shopify.app.toml and .env.example scope lists identical", () => {
    // OAuth installs grant what SCOPES says; deploys grant what the toml
    // says. Any drift means dev and prod run with different permissions.
    expect(envScopes).toEqual(tomlScopes);
  });

  it("requests write_orders while orders.server.ts issues refundCreate/orderCancel", () => {
    // refundCreate and orderCancel both require write_orders. Without it the
    // admin Refund button fails with ACCESS_DENIED on every install — a
    // green suite cannot catch it because tests stub the GraphQL client.
    const ordersLib = read("app", "lib", "graphql", "orders.server.ts");
    const usesWriteOrdersMutations = /\b(?:refundCreate|orderCancel)\s*\(/.test(
      ordersLib,
    );
    expect(usesWriteOrdersMutations, "expected the mutations this guard covers").toBe(true);
    expect(
      tomlScopes,
      "app/lib/graphql/orders.server.ts calls refundCreate/orderCancel, " +
        "which Shopify gates behind write_orders — the admin refund action " +
        "returns ACCESS_DENIED for every merchant without it",
    ).toContain("write_orders");
  });

  it("requests write_order_edits while orders.server.ts issues orderEdit* mutations", () => {
    // The first-order gift is attached to the origin order via order editing
    // (orderEditBegin → orderEditAddVariant → orderEditAddLineItemDiscount →
    // orderEditCommit), and ALL of those are gated behind write_order_edits.
    // Without the scope, orderEditBegin fails with ACCESS_DENIED, the catch in
    // firstOrderGift.server.ts reads that as "order not editable" and quietly
    // defers EVERY subscriber's promised gift to cycle 1 — a full billing
    // interval late, on every install, with no test able to see it because
    // the GraphQL client is stubbed.
    const ordersLib = read("app", "lib", "graphql", "orders.server.ts");
    const usesOrderEditMutations = /\borderEdit(?:Begin|AddVariant|AddLineItemDiscount|Commit)\s*\(/.test(
      ordersLib,
    );
    expect(usesOrderEditMutations, "expected the mutations this guard covers").toBe(true);
    expect(
      tomlScopes,
      "app/lib/graphql/orders.server.ts calls orderEditBegin/Commit, which " +
        "Shopify gates behind write_order_edits — the first-order gift " +
        "silently defers to the first renewal for every subscriber without it",
    ).toContain("write_order_edits");
  });
});

// ── 3b. Mandatory privacy webhooks must be compliance_topics, not topics ─────

describe("GDPR privacy webhooks are declared as compliance_topics", () => {
  // Shopify CLI 3.x validates `topics` against the standard webhook-topic
  // list; the three privacy topics are NOT on it. Declared under `topics`,
  // `shopify app deploy` rejects the config (launch blocked) — or the app
  // ships without its mandatory compliance subscriptions and the
  // CUSTOMERS_DATA_REQUEST/CUSTOMERS_REDACT/SHOP_REDACT handlers never
  // receive a delivery, an app-requirements violation. They belong under the
  // dedicated `compliance_topics` key of a [[webhooks.subscriptions]] entry.
  const toml = read("shopify.app.toml");
  const PRIVACY_TOPICS = [
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ];

  /** Every `topics = [...]` / `compliance_topics = [...]` array in the toml. */
  function topicArrays(key: "topics" | "compliance_topics"): string[][] {
    const out: string[][] = [];
    const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "gms");
    for (const match of toml.matchAll(re)) {
      out.push(
        [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
      );
    }
    return out;
  }

  it("declares all three privacy topics under compliance_topics", () => {
    const declared = topicArrays("compliance_topics").flat();
    for (const topic of PRIVACY_TOPICS) {
      expect(
        declared,
        `${topic} must be declared under compliance_topics with uri /webhooks`,
      ).toContain(topic);
    }
  });

  it("never lists a privacy topic in a regular topics array (deploy validation rejects it)", () => {
    // `topics = [...]` also matches `compliance_topics = [...]` textually —
    // the regex anchors on the key start, so filter is exact per key.
    const regular = topicArrays("topics").flat();
    for (const topic of PRIVACY_TOPICS) {
      expect(
        regular,
        `${topic} in the regular topics array fails shopify app deploy config validation`,
      ).not.toContain(topic);
    }
  });

  it("the webhook route still handles all three (uri contract intact)", () => {
    const handlers = read("app", "lib", "webhooks", "handlers.server.ts");
    for (const key of [
      "CUSTOMERS_DATA_REQUEST",
      "CUSTOMERS_REDACT",
      "SHOP_REDACT",
    ]) {
      expect(handlers).toContain(key);
    }
  });
});

// ── 4. package.json shape the deploy path depends on ─────────────────────────

describe("package.json deploy contract", () => {
  it("keeps the build and start scripts the image and hosts call", () => {
    expect(packageJson.scripts.build).toBe("remix vite:build");
    expect(packageJson.scripts.start).toBe(
      "remix-serve ./build/server/index.js",
    );
  });

  it("keeps the runtime server a production dependency", () => {
    // `npm run start` runs after the dev-dependency prune in the image.
    for (const name of ["@remix-run/serve", "prisma", "@prisma/client"]) {
      expect(
        packageJson.dependencies[name],
        `${name} must be a dependency: the image prunes devDependencies after the build`,
      ).toBeTruthy();
    }
  });

  it("declares no workspace glob that matches a directory without a manifest", () => {
    for (const pattern of packageJson.workspaces ?? []) {
      const base = pattern.replace(/\/\*$/, "");
      if (base === pattern) continue; // a literal path, not a glob
      let entries: string[] = [];
      try {
        entries = readdirSync(join(REPO_ROOT, base));
      } catch {
        continue; // the directory is not shipped at all
      }
      for (const entry of entries) {
        const dir = join(REPO_ROOT, base, entry);
        if (!statSync(dir).isDirectory()) continue;
        expect(
          readdirSync(dir),
          `package.json declares the workspace glob "${pattern}", which ` +
            `matches ${base}/${entry} — a directory with no package.json. ` +
            "npm 10 tolerates this; drop the glob or add a manifest rather " +
            "than relying on that.",
        ).toContain("package.json");
      }
    }
  });
});
