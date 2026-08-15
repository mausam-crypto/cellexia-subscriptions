import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Emails admin route shape (v1.25.0) — static source pins.
 *
 * The slowness the merchant reported had three root causes; each has a
 * pin here so it cannot creep back:
 *  1. ROUTE NESTING: `app.emails.tsx` was the Remix layout parent of the
 *     setup wizard and the per-template editor, so its heavy loader (a
 *     dozen settings reads + the sent log + a preview render) ran on every
 *     child document load and after every child action. The children now
 *     use the escaped flat-route names (`app.emails_.setup.tsx`,
 *     `app.emails_.$template.tsx`) — same URLs, no nesting — and the
 *     overview renders no <Outlet>.
 *  2. LIVE KLAVIYO IN THE LOADER: the setup page verified against Klaviyo
 *     on every visit. It now only STARTS background tasks for verify/setup
 *     (setup-task.server.ts) — never calls verifyFlowCoverage /
 *     runGuidedSetup directly — throttled by the 10-minute auto-verify
 *     gate, and polls a resource route that reads DB state only. The ONE
 *     in-request Klaviyo call left is save-key's single probeKlaviyoKey
 *     validation of the pasted key before it is stored (15 s-bounded).
 *  3. Tab switches on the overview and test sends in the editor no longer
 *     revalidate loaders.
 *
 * Behavioural pins (loader throttle, save-key contract) live in
 * tests/klaviyo-setup-route.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("emails routes are decoupled from the overview layout", () => {
  it("the setup wizard and the editor use escaped (non-nested) file names; the old nested names are gone", () => {
    expect(exists("app/routes/app.emails_.setup.tsx")).toBe(true);
    expect(exists("app/routes/app.emails_.$template.tsx")).toBe(true);
    expect(exists("app/routes/app.emails_.setup_.status.tsx")).toBe(true);
    expect(exists("app/routes/app.emails.setup.tsx")).toBe(false);
    expect(exists("app/routes/app.emails.$template.tsx")).toBe(false);
  });

  it("the overview renders no <Outlet> and skips revalidation for tab switches", () => {
    const source = readSource("app/routes/app.emails.tsx");
    expect(source).not.toContain("<Outlet");
    expect(source).not.toMatch(/\bOutlet\b/);
    expect(source).not.toMatch(/\buseParams\b/);
    expect(source).not.toMatch(/\buseLocation\b/);
    expect(source).toContain("onlyTabDiffers");
    expect(source).toContain('intent === "preview" || intent === "preview-design"');
  });

  it("the editor skips revalidation for preview AND send-test", () => {
    const source = readSource("app/routes/app.emails_.$template.tsx");
    expect(source).toContain('intent === "preview" || intent === "send-test"');
  });
});

describe("the setup page never runs Klaviyo verification or flow creation inside a request (save-key's single key probe is the deliberate exception)", () => {
  it("only starts background tasks — no direct verifyFlowCoverage / runGuidedSetup calls", () => {
    const source = readSource("app/routes/app.emails_.setup.tsx");
    expect(source).toContain("startFlowTask(");
    expect(source).not.toMatch(/\bverifyFlowCoverage\b/);
    expect(source).not.toMatch(/\brunGuidedSetup\b/);
    expect(source).not.toMatch(/\bklaviyoApiRequest\b/);
    // The only in-request Klaviyo call: validate-before-save of the pasted
    // key (save-key branch) — exactly one, so a second one is a conscious change.
    expect((source.match(/await probeKlaviyoKey\(/g) ?? []).length).toBe(1);
    // Polls the status route while a task runs.
    expect(source).toContain("/app/emails/setup/status");
    expect(source).toContain("useFetcher");
    // Progress UI + the retired copy.
    expect(source).toContain("ProgressBar");
    expect(source).not.toMatch(/click again in a minute/i);
    expect(source).toContain('unchecked: { label: "Not checked yet" }');
  });

  it("the loader's auto-verify is throttled: 10 minutes from the LAST TOUCH (failed attempts included), never while a task runs", () => {
    const source = readSource("app/routes/app.emails_.setup.tsx");
    expect(source).toContain("const AUTO_VERIFY_STALE_MS = 10 * 60_000");
    expect(source).toContain("[cached.checkedAt, cached.lastAttemptAt]");
    expect(source).toContain('task?.state !== "running"');
    expect(source).toContain("ageMs > AUTO_VERIFY_STALE_MS");
  });

  it("a key saved while a run is in flight owes ONE automatic refresh once that run finishes", () => {
    const source = readSource("app/routes/app.emails_.setup.tsx");
    expect(source).toContain("pendingVerifyRef");
    expect(source).toContain('actionData.started === false && actionData.task?.state === "running"');
    expect(source).toContain('form.set("intent", "refresh")');
    expect(source).toContain("re-checks with the new key as soon as the current run finishes");
  });

  it("the status route is a DB-only resource route (no Klaviyo calls, no default export) whose no-store header rides the route `headers` export (single fetch drops loader Response headers)", () => {
    const source = readSource("app/routes/app.emails_.setup_.status.tsx");
    expect(source).toContain("getFlowTask(");
    expect(source).toContain("cachedCoverageRows(");
    expect(source).not.toMatch(/\bklaviyoApiRequest\b/);
    expect(source).not.toMatch(/\bverifyFlowCoverage\b/);
    expect(source).not.toMatch(/\brunGuidedSetup\b/);
    expect(source).not.toContain("export default");
    expect(source).toMatch(/export const headers\b/);
    expect(source).toContain('"Cache-Control": "no-store"');
  });

  it("the flows module never fetches per-flow definitions on any path", () => {
    const source = readSource("app/lib/klaviyo/flows.server.ts");
    expect(source).not.toContain("additional-fields[flow]=definition");
    expect(source).not.toMatch(/\blistFlowsWithTriggers\b/);
    expect(source).toContain("include=flow-triggers");
    expect(source).not.toMatch(/click again in a minute/i);
  });
});
