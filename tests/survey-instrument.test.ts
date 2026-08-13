/**
 * The post-purchase survey measurement instrument (v1.21.0).
 *
 * Pins two things that must never drift apart or change silently:
 *
 * 1. The frozen instrument itself (app/lib/survey/shared.ts): version,
 *    question keys, option keys AND their order. Churn/LTGP coefficients are
 *    estimated per option key over months of matured labels — an in-place
 *    edit pools answers from different instruments and corrupts both sides
 *    undetectably. Changing ANY of these must bump
 *    SURVEY_QUESTION_SET_VERSION, which this suite forces a human to notice.
 *
 * 2. The extension's bundled mirror (extensions/cellexia-survey/src/
 *    questions.json) — extension sources cannot import app code, so the
 *    vocabulary is duplicated by construction; this suite is what makes the
 *    duplication safe.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SURVEY_QUESTIONS,
  SURVEY_QUESTION_KEYS,
  SURVEY_QUESTION_SET_VERSION,
  isCompleteSurvey,
  isValidSurveyAnswer,
  sanitizeSurveyAnswers,
} from "~/lib/survey/shared";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIRROR_PATH = join(
  REPO_ROOT,
  "extensions",
  "cellexia-survey",
  "src",
  "questions.json",
);

describe("the frozen instrument (version 1)", () => {
  it("pins version, question keys, option keys and order — bump the version to change any of this", () => {
    expect(SURVEY_QUESTION_SET_VERSION).toBe(1);
    expect(
      SURVEY_QUESTIONS.map((q) => ({ key: q.key, options: [...q.options] })),
    ).toEqual([
      {
        key: "plannedDuration",
        options: ["trying", "few_months", "six_months_plus", "permanent"],
      },
      {
        key: "motive",
        options: ["fast_wrinkles", "prevention", "daily_care", "occasion"],
      },
      {
        key: "expectedSpeed",
        options: [
          "days",
          "weeks",
          "one_two_months",
          "three_months_plus",
          "not_sure",
        ],
      },
      {
        key: "routine",
        options: ["full", "most_days", "on_off", "minimal"],
      },
    ]);
  });

  it("the extension mirror is byte-equal in version, keys, options and order", () => {
    const mirror = JSON.parse(readFileSync(MIRROR_PATH, "utf8")) as {
      questionSetVersion: number;
      questions: Array<{ key: string; options: string[] }>;
    };
    expect(mirror.questionSetVersion).toBe(SURVEY_QUESTION_SET_VERSION);
    expect(mirror.questions).toEqual(
      SURVEY_QUESTIONS.map((q) => ({ key: q.key, options: [...q.options] })),
    );
  });
});

describe("answer validation + sanitization", () => {
  it("accepts every declared option and rejects unknowns", () => {
    for (const q of SURVEY_QUESTIONS) {
      for (const option of q.options) {
        expect(isValidSurveyAnswer(q.key, option)).toBe(true);
      }
      expect(isValidSurveyAnswer(q.key, "nope")).toBe(false);
    }
    expect(isValidSurveyAnswer("unknownQuestion", "trying")).toBe(false);
  });

  it("sanitize drops unknown questions, invalid options and non-string junk", () => {
    expect(
      sanitizeSurveyAnswers({
        plannedDuration: "trying",
        motive: "not_an_option",
        expectedSpeed: 42,
        routine: "full",
        injected: "value",
      }),
    ).toEqual({ plannedDuration: "trying", routine: "full" });
    expect(sanitizeSurveyAnswers(null)).toEqual({});
    expect(sanitizeSurveyAnswers("string")).toEqual({});
  });

  it("isCompleteSurvey requires a valid answer for every question", () => {
    const complete = {
      plannedDuration: "permanent",
      motive: "prevention",
      expectedSpeed: "three_months_plus",
      routine: "full",
    };
    expect(isCompleteSurvey(complete)).toBe(true);
    expect(isCompleteSurvey({ ...complete, motive: undefined })).toBe(false);
    expect(SURVEY_QUESTION_KEYS).toHaveLength(4);
  });
});

// ── Deploy-blocker pins (v1.21.1) ─────────────────────────────────────────────
// Two real `npm run deploy` hard-rejects shipped in v1.21.0 and are pinned
// here so they cannot regress:
//  1. api_version "2025-01" — copied from the Admin API pin, but checkout UI
//     extensions only accept CURRENT quarterly versions, and React bindings
//     ended at 2025-07 entirely.
//  2. `react-reconciler` — an undeclared peer dependency of the (now removed)
//     React bindings; the bundler failed on it at deploy time because
//     `npm run verify` never bundles extensions.

describe("survey extension deploy contract (v1.21.1)", () => {
  const extensionDir = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "extensions",
    "cellexia-survey",
  );

  it("targets a checkout-supported quarterly api_version (2025-10 or later)", () => {
    const toml = readFileSync(join(extensionDir, "shopify.extension.toml"), "utf8");
    const match = toml.match(/^api_version = "(\d{4})-(\d{2})"$/m);
    expect(match, "api_version must be a quarterly YYYY-MM literal").not.toBeNull();
    const [, year, month] = match as RegExpMatchArray;
    expect(["01", "04", "07", "10"]).toContain(month);
    // 2025-10 is the floor: the first version of the current (Preact)
    // component model, and everything older is outside or leaving the
    // checkout support window. Deliberately no upper bound — bumping
    // forward is routine maintenance.
    expect(`${year}-${month}` >= "2025-10").toBe(true);
  });

  it("depends on the Preact component model — never the discontinued React bindings", () => {
    const pkg = JSON.parse(
      readFileSync(join(extensionDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    // The current model's three pillars…
    expect(Object.keys(deps)).toEqual(
      expect.arrayContaining(["@shopify/ui-extensions", "preact", "@preact/signals"]),
    );
    // …and the dead end that broke the deploy: ui-extensions-react has no
    // release for any api_version Shopify still accepts, and it silently
    // required react-reconciler as an undeclared peer.
    expect(deps["@shopify/ui-extensions-react"]).toBeUndefined();
    expect(deps["react"]).toBeUndefined();

    // Comment-stripped, both directions: a pin that reads comments can be
    // satisfied by a comment (the v1.19.0 dead-toggle lesson) or tripped by
    // one (the migration note here names the dead package) — only CODE counts.
    const codeOf = (entry: string): string =>
      readFileSync(join(extensionDir, "src", entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/(^|[^:"'])\/\/.*$/, "$1"))
        .join("\n");
    for (const entry of ["ThankYou.jsx", "OrderStatus.jsx", "survey-core.jsx"]) {
      const code = codeOf(entry);
      expect(code, entry).not.toContain("@shopify/ui-extensions-react");
      expect(code, entry).not.toMatch(/from "react"/);
    }
    // The entries wire the Preact runtime in explicitly.
    for (const entry of ["ThankYou.jsx", "OrderStatus.jsx"]) {
      const code = codeOf(entry);
      expect(code, entry).toContain('import "@shopify/ui-extensions/preact"');
      expect(code, entry).toMatch(/render\(/);
    }
  });
});

// ── Render-runtime pins (v1.21.2) ─────────────────────────────────────────────
// The block deployed but painted NOTHING anywhere (theme editor included):
// with no tsconfig, the CLI's esbuild compiled JSX with the CLASSIC transform
// (React.createElement) — `React` doesn't exist in the extension sandbox, the
// module threw on first render, and the sandbox swallowed it. The bundle test
// below reproduces the CLI's default bundling (no jsx flags) so that failure
// mode can never ship silently again; the editor pin keeps the block visible
// in the checkout editor, where every production gate fails by design.

describe("survey extension render runtime (v1.21.2)", () => {
  const extensionDir = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "extensions",
    "cellexia-survey",
  );

  it("tsconfig wires the Preact JSX runtime (load-bearing for rendering, not just types)", () => {
    const tsconfig = JSON.parse(
      readFileSync(join(extensionDir, "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: Record<string, unknown> };
    expect(tsconfig.compilerOptions?.jsx).toBe("react-jsx");
    expect(tsconfig.compilerOptions?.jsxImportSource).toBe("preact");
  });

  it("bundles under the CLI's DEFAULT settings with Preact JSX — no React references survive", async () => {
    const { build } = (await import("esbuild")) as typeof import("esbuild");
    for (const entry of ["ThankYou.jsx", "OrderStatus.jsx"]) {
      // Deliberately NO jsx flags: esbuild must pick the transform up from
      // the extension's tsconfig exactly like `shopify app deploy` does.
      const result = await build({
        entryPoints: [join(extensionDir, "src", entry)],
        bundle: true,
        write: false,
        format: "esm",
        logLevel: "silent",
      });
      const code = result.outputFiles[0].text;
      expect(code, entry).not.toContain("React.createElement");
      expect(code, entry).toContain("preact");
    }
  });

  it("renders a local demo inside the checkout editor — no gating, no network", () => {
    const code = readFileSync(
      join(extensionDir, "src", "survey-core.jsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:"'])\/\/.*$/, "$1"))
      .join("\n");
    // Editor detection as CODE (comment-stripped, the standing pin rule)…
    expect(code).toMatch(/shopify\.extension\?\.editor/);
    // …the demo activates without touching the backend…
    expect(code).toMatch(/if \(inEditor\) \{\s*\n?\s*setPhase\("active"\)/);
    // …and neither impressions nor taps may ever post from an editor session.
    expect(code).toMatch(/impressionSent \|\| inEditor\) return/);
    expect(code).toMatch(/if \(inEditor\) return;/);
  });
});
