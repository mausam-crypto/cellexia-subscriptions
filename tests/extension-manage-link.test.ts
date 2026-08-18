/**
 * "Manage your subscription" entry point in the thank-you / order-status
 * extension (v1.28.0, P5.2).
 *
 * Pins:
 *  - the link renders ONLY when the order carries a subscription (selling-
 *    plan) line — the same gate as the survey — and never depends on the
 *    survey's own gates (App URL, backend status);
 *  - it targets the store-domain app-proxy portal
 *    `${shop.storefrontUrl}/apps/<PORTAL_PROXY_SUBPATH>/` — the hardcoded
 *    subpath (extension sources cannot import app modules) must equal
 *    PORTAL_PROXY_SUBPATH and can never be the banned legacy value;
 *  - both render targets mount it, and the CLI-default bundle still builds
 *    with the Preact runtime (the v1.21.2 lesson);
 *  - the copy comes from the extension locale catalog (default locale).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PORTAL_PROXY_BASE,
  PORTAL_PROXY_SUBPATH,
} from "~/lib/portal/proxy-path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT_DIR = join(REPO_ROOT, "extensions", "cellexia-survey");
const SRC = join(EXT_DIR, "src");

/** Comment-stripped source — only CODE counts (standing pin rule). */
function codeOf(entry: string): string {
  return readFileSync(join(SRC, entry), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'])\/\/.*$/, "$1"))
    .join("\n");
}

describe("manage-link.jsx — gating", () => {
  const code = codeOf("manage-link.jsx");

  it("renders only when a line carries a selling plan (subscription order)", () => {
    expect(code).toMatch(/merchandise\?\.sellingPlan/);
    // Outside the editor: no subscription line → null. The editor demo
    // (merchant positioning) is the ONLY bypass.
    expect(code).toMatch(
      /if \(!inEditor && \(!hasSubscription \|\| !storefrontUrl\)\) return null;/,
    );
    expect(code).toMatch(/shopify\.extension\?\.editor/);
  });

  it("does not depend on the survey's gates — no App URL, no network, no session token", () => {
    expect(code).not.toContain("app_url");
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("sessionToken");
    expect(code).not.toContain("useEffect");
  });

  it("builds the URL from the storefront URL + the portal proxy path", () => {
    expect(code).toMatch(/shopify\.shop\?\.storefrontUrl/);
    expect(code).toMatch(/const href = `\$\{storefrontUrl\}\$\{PORTAL_PROXY_PATH\}`;/);
    expect(code).toMatch(/<s-button href=\{href\}/);
  });
});

describe("manage-link.jsx — portal proxy path agreement", () => {
  it("hardcodes exactly PORTAL_PROXY_BASE + '/' and never the banned legacy subpath", () => {
    const code = codeOf("manage-link.jsx");
    const match = /export const PORTAL_PROXY_PATH = "([^"]+)";/.exec(code);
    expect(match, "PORTAL_PROXY_PATH constant missing").not.toBeNull();
    const path = (match as RegExpMatchArray)[1];
    expect(path).toBe(`${PORTAL_PROXY_BASE}/`);
    expect(path).toBe(`/apps/${PORTAL_PROXY_SUBPATH}/`);
    // Every /apps/<x>/ occurrence in the file (comments included — a stale
    // comment is how the next regression gets copy-pasted back in) is ours.
    const raw = readFileSync(join(SRC, "manage-link.jsx"), "utf8");
    const subpaths = new Set(
      [...raw.matchAll(/\/apps\/([A-Za-z0-9_-]+)\//g)].map((m) => m[1]),
    );
    expect([...subpaths]).toEqual([PORTAL_PROXY_SUBPATH]);
    expect(subpaths.has("cellexia")).toBe(false);
  });
});

describe("render targets", () => {
  it("both entries mount the link alongside the survey", () => {
    for (const entry of ["ThankYou.jsx", "OrderStatus.jsx"]) {
      const code = codeOf(entry);
      expect(code, entry).toContain(
        'import { ManageSubscriptionLink } from "./manage-link.jsx"',
      );
      expect(code, entry).toMatch(/<ManageSubscriptionLink \/>/);
      expect(code, entry).toMatch(/<Survey /);
    }
  });

  it("the CLI-default bundle still builds on the Preact runtime and carries the portal path", async () => {
    const { build } = (await import("esbuild")) as typeof import("esbuild");
    for (const entry of ["ThankYou.jsx", "OrderStatus.jsx"]) {
      const result = await build({
        entryPoints: [join(SRC, entry)],
        bundle: true,
        write: false,
        format: "esm",
        logLevel: "silent",
      });
      const bundled = result.outputFiles[0].text;
      expect(bundled, entry).not.toContain("React.createElement");
      expect(bundled, entry).toContain("preact");
      expect(bundled, entry).toContain(`${PORTAL_PROXY_BASE}/`);
    }
  });
});

describe("copy", () => {
  it("the default locale carries the manage.* keys the component reads", () => {
    const en = JSON.parse(
      readFileSync(join(EXT_DIR, "locales", "en.default.json"), "utf8"),
    ) as { manage?: Record<string, string> };
    expect(en.manage?.title).toBe("Manage your subscription");
    expect(en.manage?.cta).toBe("Manage my subscription");
    expect((en.manage?.body ?? "").length).toBeGreaterThan(10);
    const code = codeOf("manage-link.jsx");
    for (const key of ["manage.title", "manage.body", "manage.cta"]) {
      expect(code).toContain(`shopify.i18n.translate("${key}")`);
    }
  });

  it("EVERY extension locale carries manage.title/body/cta (Shopify falls back to English per missing key — a French Thank You page must not show an English card)", () => {
    const dir = join(EXT_DIR, "locales");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    const en = JSON.parse(readFileSync(join(dir, "en.default.json"), "utf8")) as {
      manage: Record<string, string>;
    };
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        manage?: Record<string, string>;
      };
      for (const key of ["title", "body", "cta"]) {
        expect(typeof data.manage?.[key], `${file} manage.${key}`).toBe("string");
        expect((data.manage?.[key] ?? "").trim().length, `${file} manage.${key}`).toBeGreaterThan(3);
        if (file !== "en.default.json") {
          // Translated, not copied from English.
          expect(data.manage?.[key], `${file} manage.${key} untranslated`).not.toBe(en.manage[key]);
        }
      }
    }
  });
});
