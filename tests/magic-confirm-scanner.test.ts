import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /magic/:token confirm page — scanner safety.
 *
 * Corporate email-security products (Microsoft Defender SafeLinks, Proofpoint
 * URL Defense, Mimecast…) detonate emailed links in JS-capable sandboxes
 * BEFORE the customer sees the email. The confirm page therefore must never
 * submit its form from script: no timer, no load-time requestSubmit()/
 * form.submit(). A POST — which consumes the single-use token and executes a
 * real contract mutation (skip / pause / delay / swap / winback) — may only
 * ever be caused by the customer's own tap on the confirm button. The old
 * `setTimeout(go, 1200)` auto-submit let scanners silently pause or skip live
 * contracts and left the customer a dead (410) link.
 *
 * Invariants pinned here:
 *  - GET renders a POST form + confirm button, with zero script-driven submit.
 *  - GET never consumes (verifyAndConsumeMagicToken is POST-only).
 *  - A terminal lockedResult (plan lock window / setup-mode launch gate)
 *    renders WITHOUT any form at all.
 *  - POST is the only path that consumes + executes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const mocks = vi.hoisted(() => ({
  verifyMagicTokenSignature: vi.fn(
    (): unknown => ({
      ok: true,
      payload: { v: 1, action: "SKIP_NEXT", contractId: "ctr_1" },
    }),
  ),
  verifyAndConsumeMagicToken: vi.fn(
    async (): Promise<unknown> => ({
      ok: true,
      payload: { v: 1, action: "SKIP_NEXT", contractId: "ctr_1" },
    }),
  ),
  tokenFindUnique: vi.fn(
    async (): Promise<unknown> => ({ useCount: 0, maxUses: 1 }),
  ),
  describeMagicAction: vi.fn(
    async (): Promise<unknown> => ({
      action: "SKIP_NEXT",
      locale: "en",
      title: "Skip your next order",
      description: "We'll skip your next delivery.",
      confirmLabel: "Confirm",
      portalUrl: "https://cellexialabs.com/apps/cellexia-subs",
    }),
  ),
  executeMagicAction: vi.fn(
    async (): Promise<unknown> => ({
      locale: "en",
      headline: "Done — your next order is skipped",
    }),
  ),
  bestEffortPortalLoginUrl: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("~/db.server", () => ({
  default: { magicLinkToken: { findUnique: mocks.tokenFindUnique } },
}));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => `sha256:${data}`,
  verifyMagicTokenSignature: mocks.verifyMagicTokenSignature,
  verifyAndConsumeMagicToken: mocks.verifyAndConsumeMagicToken,
}));

vi.mock("~/lib/magiclinks/handlers.server", () => ({
  bestEffortPortalLoginUrl: mocks.bestEffortPortalLoginUrl,
  describeMagicAction: mocks.describeMagicAction,
  executeMagicAction: mocks.executeMagicAction,
}));

vi.mock("~/lib/portal/layout.server", () => ({
  isRtlLocale: (locale: string | null) => locale === "ar",
}));

import { action, loader } from "~/routes/magic.$token";

function loaderArgs(token = "tok") {
  return {
    request: new Request(`https://app.example/magic/${token}`),
    params: { token },
    context: {},
  } as never;
}

function actionArgs(token = "tok", method = "POST") {
  return {
    request: new Request(`https://app.example/magic/${token}`, { method }),
    params: { token },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokenFindUnique.mockResolvedValue({ useCount: 0, maxUses: 1 });
});

describe("GET confirm page requires a real user gesture", () => {
  it("renders the POST form + confirm button with NO script-driven submit", async () => {
    const response = (await loader(loaderArgs())) as Response;
    expect(response.status).toBe(200);
    const html = await response.text();

    // The one-click confirm flow stays: a plain POST form with its button.
    expect(html).toContain('<form method="post" id="magic-form">');
    expect(html).toContain('type="submit"');
    expect(html).toContain("Confirm");

    // …but nothing in the page may submit it except the customer's tap.
    expect(html).not.toContain("setTimeout");
    expect(html).not.toContain("setInterval");
    expect(html).not.toContain("requestSubmit");
    expect(html).not.toContain(".submit(");
    // The "confirming automatically…" note is gone with the timer.
    expect(html).not.toContain("auto-note");
  });

  it("never consumes the token on GET (scanner prefetch is harmless)", async () => {
    await loader(loaderArgs());
    expect(mocks.verifyAndConsumeMagicToken).not.toHaveBeenCalled();
    expect(mocks.executeMagicAction).not.toHaveBeenCalled();
  });

  it("renders a terminal refusal (lock window / setup gate) with no form at all", async () => {
    mocks.describeMagicAction.mockResolvedValueOnce({
      action: "SKIP_NEXT",
      locale: "en",
      title: "Skip your next order",
      description: "We'll skip your next delivery.",
      confirmLabel: "Confirm",
      portalUrl: null,
      lockedResult: {
        locale: "en",
        headline: "This change is unavailable right now",
        sub: "Try again soon.",
      },
    });
    const response = (await loader(loaderArgs())) as Response;
    const html = await response.text();
    expect(html).toContain("This change is unavailable right now");
    expect(html).not.toContain("<form");
    expect(mocks.verifyAndConsumeMagicToken).not.toHaveBeenCalled();
  });

  it("shows the honest 410 page for an exhausted token without consuming", async () => {
    mocks.tokenFindUnique.mockResolvedValueOnce({ useCount: 1, maxUses: 1 });
    const response = (await loader(loaderArgs())) as Response;
    expect(response.status).toBe(410);
    expect(mocks.describeMagicAction).not.toHaveBeenCalled();
    expect(mocks.verifyAndConsumeMagicToken).not.toHaveBeenCalled();
  });
});

describe("POST is the only consuming + executing path", () => {
  it("consumes the token and executes the verb", async () => {
    const response = (await action(actionArgs())) as Response;
    expect(response.status).toBe(200);
    expect(mocks.verifyAndConsumeMagicToken).toHaveBeenCalledTimes(1);
    expect(mocks.executeMagicAction).toHaveBeenCalledTimes(1);
    const html = await response.text();
    expect(html).toContain("Done — your next order is skipped");
  });

  it("303-redirects hand-off results", async () => {
    mocks.executeMagicAction.mockResolvedValueOnce({
      locale: "en",
      headline: "Signing you in",
      redirect: "https://cellexialabs.com/apps/cellexia-subs?handoff=abc",
    });
    const response = (await action(actionArgs())) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("handoff=abc");
  });
});

describe("source pin: no timer-driven submit can come back", () => {
  it("the route contains no setTimeout/setInterval/requestSubmit/.submit(", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "app/routes/magic.$token.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/setTimeout|setInterval|requestSubmit/);
    expect(source).not.toContain(".submit(");
    // The confirm form itself must stay — one tap, one POST.
    expect(source).toContain('<form method="post" id="magic-form">');
  });
});
