import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PORTAL_PROXY_BASE,
  PORTAL_PROXY_SUBPATH,
} from "~/lib/portal/proxy-path";

/**
 * App-proxy subpath agreement — the guard that makes the /apps/cellexia
 * collision structurally impossible to re-ship.
 *
 * The merchant's OTHER live app ("AOV & LTV Booster") already serves
 * /apps/cellexia on the same store. Shipping this app on the same subpath —
 * which happened repeatedly — hands the customer portal's store-domain
 * traffic to that app (or its traffic to us, depending on which proxy config
 * Shopify kept). The current subpath is "cellexia-subs" and the legacy value
 * is BANNED.
 *
 * Four places carry the subpath and can drift independently:
 *
 *   1. shopify.app.toml `[app_proxy] subpath` — what Shopify actually deploys;
 *   2. PORTAL_PROXY_SUBPATH in app/lib/portal/proxy-path.ts — what every
 *      server-side URL builder uses (portal, cancel flow, magic-link portal
 *      URLs, the proxy-identity probe);
 *   3. extensions/cellexia-buy-box/assets/buy-box.js — hardcoded, because
 *      theme-extension JS cannot import app modules;
 *   4. extensions/cellexia-buy-box/assets/buy-box-embed.js — same.
 *
 * This test forces all four to agree and forbids the banned value in each.
 * The runtime complement is the Preview & launch checklist row "Portal proxy
 * answers as Cellexia" (probeProxyIdentity), which catches a collision that
 * exists only in the deployed store, where this static test cannot see.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS_DIR = join(REPO_ROOT, "extensions", "cellexia-buy-box", "assets");

/** The subpath that collides with AOV & LTV Booster — banned forever. */
const BANNED_SUBPATH = "cellexia";

function banMessage(source: string, value: string): string {
  return (
    `${source} uses app-proxy subpath "${value}", but "${BANNED_SUBPATH}" is BANNED: ` +
    `the merchant's other live app ("AOV & LTV Booster") already serves ` +
    `/apps/${BANNED_SUBPATH} on the same store, and reusing it hands the ` +
    `customer portal's traffic to that app. Use PORTAL_PROXY_SUBPATH ` +
    `("${PORTAL_PROXY_SUBPATH}") from app/lib/portal/proxy-path.ts.`
  );
}

/** `subpath = "..."` from shopify.app.toml's [app_proxy] block. */
function tomlSubpath(): string {
  const toml = readFileSync(join(REPO_ROOT, "shopify.app.toml"), "utf8");
  const match = /^subpath\s*=\s*"([^"]*)"/m.exec(toml);
  if (!match) {
    throw new Error(
      "shopify.app.toml has no `subpath = \"...\"` line — the [app_proxy] block is missing or renamed",
    );
  }
  return match[1];
}

/**
 * Every distinct app-proxy subpath referenced in a JS asset, from any
 * `/apps/<subpath>/...` occurrence (code or comment — a stale comment is how
 * the next regression gets copy-pasted back in).
 */
function assetSubpaths(fileName: string): string[] {
  const source = readFileSync(join(ASSETS_DIR, fileName), "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(/\/apps\/([A-Za-z0-9_-]+)\//g)) {
    found.add(match[1]);
  }
  return [...found];
}

describe("app-proxy subpath (single source of truth + legacy-collision ban)", () => {
  const sources: Array<[label: string, subpaths: string[]]> = [
    ["shopify.app.toml [app_proxy] subpath", [tomlSubpath()]],
    [
      "app/lib/portal/proxy-path.ts PORTAL_PROXY_SUBPATH",
      [PORTAL_PROXY_SUBPATH],
    ],
    [
      "extensions/cellexia-buy-box/assets/buy-box.js",
      assetSubpaths("buy-box.js"),
    ],
    [
      "extensions/cellexia-buy-box/assets/buy-box-embed.js",
      assetSubpaths("buy-box-embed.js"),
    ],
  ];

  it("finds a proxy-path reference in every source (the grep cannot go blind)", () => {
    for (const [label, subpaths] of sources) {
      expect(
        subpaths.length,
        `${label} contains no /apps/<subpath>/ reference — if the path moved, update this test's extraction with it`,
      ).toBeGreaterThan(0);
    }
  });

  it("all four sources agree on the subpath", () => {
    for (const [label, subpaths] of sources) {
      for (const subpath of subpaths) {
        expect(
          subpath,
          `${label} disagrees with PORTAL_PROXY_SUBPATH ("${PORTAL_PROXY_SUBPATH}") — every subpath reference must come from (or match) app/lib/portal/proxy-path.ts`,
        ).toBe(PORTAL_PROXY_SUBPATH);
      }
    }
  });

  it(`never regresses to the banned legacy subpath "${BANNED_SUBPATH}" (AOV & LTV Booster collision)`, () => {
    // The constant itself is checked too: redefining it to "cellexia" must
    // fail HERE, with the collision named, not via a downstream agreement.
    expect(
      PORTAL_PROXY_SUBPATH,
      banMessage("app/lib/portal/proxy-path.ts PORTAL_PROXY_SUBPATH", PORTAL_PROXY_SUBPATH),
    ).not.toBe(BANNED_SUBPATH);
    for (const [label, subpaths] of sources) {
      for (const subpath of subpaths) {
        expect(subpath, banMessage(label, subpath)).not.toBe(BANNED_SUBPATH);
      }
    }
  });

  it("PORTAL_PROXY_BASE is derived from the subpath", () => {
    expect(PORTAL_PROXY_BASE).toBe(`/apps/${PORTAL_PROXY_SUBPATH}`);
  });

  it("buy-box.js fetches preview validation from the exact expected path", () => {
    // Belt and braces for the one place the storefront actually calls: the
    // /apps/<subpath>/ extraction above requires a trailing slash, so pin the
    // full literal too — a regression that rebuilds the path some other way
    // must not slip past the regex.
    const source = readFileSync(join(ASSETS_DIR, "buy-box.js"), "utf8");
    expect(source).toContain(
      `PREVIEW_VALIDATE_PATH = '${PORTAL_PROXY_BASE}/preview/validate'`,
    );
  });
});
