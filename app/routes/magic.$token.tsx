import {
  json,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import prisma from "~/db.server";
import {
  sha256,
  verifyAndConsumeMagicToken,
  verifyMagicTokenSignature,
} from "~/lib/crypto/tokens.server";
import { t } from "~/lib/i18n/i18n.server";
import { isRtlLocale } from "~/lib/portal/layout.server";
import {
  bestEffortPortalLoginUrl,
  describeMagicAction,
  executeMagicAction,
  type MagicActionDescription,
  type MagicActionResult,
} from "~/lib/magiclinks/handlers.server";

/**
 * /magic/:token — one-tap magic link executor (public, self-authenticating).
 *
 * GET verifies the signature ONLY (email scanners prefetch GETs — consuming
 * here would burn single-use tokens) and renders a standalone branded confirm
 * page whose form auto-submits after 1200ms. POST verifies AND consumes, then
 * executes the verb. Resource route: it owns its full HTML shell — no theme,
 * no root layout, robots noindex.
 */

// ── HTML helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON-encode for inline <script> context ("</script>" safe). */
function jsStr(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

const SHELL_CSS = `
  :root {
    --bg: #f6f2ec; --card: #fffdf9; --ink: #221f1a; --muted: #6e675c;
    --accent: #334d43; --accent-ink: #f6f2ec; --gold: #b08d57; --line: #e7dfd3;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--ink); min-height: 100vh;
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 16px;
  }
  .wordmark {
    margin-top: 24px; font-size: 20px; font-weight: 600;
    letter-spacing: 0.35em; text-transform: uppercase; text-indent: 0.35em;
  }
  .wordmark b { color: var(--gold); font-weight: 600; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    padding: 32px 24px; max-width: 420px; width: 100%; margin-top: 28px;
    text-align: center; box-shadow: 0 8px 30px rgba(34, 31, 26, 0.06);
  }
  h1 { font-size: 22px; line-height: 1.3; font-weight: 600; margin-bottom: 12px; }
  .desc { color: var(--muted); font-size: 15px; line-height: 1.55; margin-bottom: 24px; }
  .btn {
    display: inline-block; width: 100%; background: var(--accent);
    color: var(--accent-ink); border: none; border-radius: 999px;
    padding: 14px 24px; font-size: 16px; font-weight: 600; font-family: inherit;
    cursor: pointer; text-decoration: none; text-align: center;
  }
  .btn[disabled] { opacity: 0.7; cursor: default; }
  .btn.secondary {
    background: transparent; color: var(--accent);
    border: 1px solid var(--accent); margin-top: 12px;
  }
  .note { margin-top: 16px; font-size: 13px; color: var(--muted); }
  a.quiet {
    display: inline-block; margin-top: 18px; color: var(--muted);
    font-size: 14px; text-decoration: underline;
  }
  .footer { margin-top: 32px; font-size: 12px; color: var(--muted); }
`;

function pageShell(title: string, bodyHtml: string, locale = "en"): string {
  // Declare the real content language + direction — a confirm page rendered
  // in Arabic must not announce itself as lang="en" LTR to screen readers.
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  return `<!doctype html>
<html lang="${esc(locale)}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>${esc(title)} — Cellexia</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wordmark">Cellexi<b>a</b></div>
${bodyHtml}
<div class="footer">Cellexia</div>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
  return new Response(body, { status, headers });
}

// ── Pages ────────────────────────────────────────────────────────────────────

function confirmPage(desc: MagicActionDescription): string {
  const { locale } = desc;
  const cancelHtml = desc.portalUrl
    ? `<a class="quiet" id="cancel-link" href="${esc(desc.portalUrl)}">${esc(
        t(locale, "magic.confirm.cancel"),
      )}</a>`
    : "";

  const body = `<div class="card">
  <h1>${esc(desc.title)}</h1>
  <p class="desc">${esc(desc.description)}</p>
  <form method="post" id="magic-form">
    <button class="btn" id="confirm-btn" type="submit">${esc(
      desc.confirmLabel,
    )}</button>
  </form>
  <p class="note" id="auto-note" hidden>${esc(
    t(locale, "magic.confirm.auto_note"),
  )}</p>
  ${cancelHtml}
</div>
<script>
(function () {
  var form = document.getElementById("magic-form");
  var btn = document.getElementById("confirm-btn");
  var note = document.getElementById("auto-note");
  if (!form || !btn) return;
  if (note) note.hidden = false;
  var confirming = ${jsStr(t(locale, "magic.confirm.confirming"))};
  var submitted = false;
  function go() {
    if (submitted) return;
    submitted = true;
    btn.disabled = true;
    btn.textContent = confirming;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }
  var timer = setTimeout(go, 1200);
  form.addEventListener("submit", function () {
    clearTimeout(timer);
    submitted = true;
    btn.disabled = true;
    btn.textContent = confirming;
  });
  var cancel = document.getElementById("cancel-link");
  if (cancel) {
    cancel.addEventListener("click", function () {
      clearTimeout(timer);
      submitted = true;
    });
  }
})();
</script>`;

  return pageShell(desc.title, body, locale);
}

function successPage(result: MagicActionResult): string {
  const { locale } = result;
  const parts: string[] = [`<h1>${esc(result.headline)}</h1>`];
  if (result.sub) parts.push(`<p class="desc">${esc(result.sub)}</p>`);
  if (result.portalUrl) {
    parts.push(
      `<a class="btn" href="${esc(result.portalUrl)}">${esc(
        t(locale, "magic.success.portal"),
      )}</a>`,
    );
  }
  if (result.undoUrl) {
    parts.push(
      `<a class="btn secondary" href="${esc(result.undoUrl)}">${esc(
        t(locale, "magic.success.undo"),
      )}</a>`,
    );
  }
  return pageShell(
    result.headline,
    `<div class="card">${parts.join("\n  ")}</div>`,
    locale,
  );
}

type ErrorKind = "EXPIRED" | "USED" | "INVALID" | "GENERIC";

const ERROR_STATUS: Record<ErrorKind, number> = {
  EXPIRED: 410,
  USED: 410,
  INVALID: 400,
  GENERIC: 500,
};

const ERROR_KEY: Record<ErrorKind, string> = {
  EXPIRED: "magic.error.expired",
  USED: "magic.error.used",
  INVALID: "magic.error.invalid",
  GENERIC: "magic.error.generic",
};

function toErrorKind(
  reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "USED" | "UNKNOWN",
): ErrorKind {
  if (reason === "EXPIRED") return "EXPIRED";
  if (reason === "USED") return "USED";
  return "INVALID";
}

/**
 * Friendly error page. LOGIN links cannot be re-minted here (that requires a
 * signing round-trip via email), so it links to the portal login on the store
 * primary domain when it can be built, else generic copy.
 */
async function errorPage(kind: ErrorKind): Promise<Response> {
  // No trustworthy payload on a bad token — the master locale is used.
  const locale = "en";
  const loginUrl = await bestEffortPortalLoginUrl();
  const parts: string[] = [
    `<h1>${esc(t(locale, "magic.error.title"))}</h1>`,
    `<p class="desc">${esc(t(locale, ERROR_KEY[kind]))} ${esc(
      t(locale, "magic.error.portal_hint"),
    )}</p>`,
  ];
  if (loginUrl) {
    parts.push(
      `<a class="btn" href="${esc(loginUrl)}">${esc(
        t(locale, "magic.error.login_button"),
      )}</a>`,
    );
  }
  return html(
    pageShell(
      t(locale, "magic.error.title"),
      `<div class="card">${parts.join("\n  ")}</div>`,
      locale,
    ),
    ERROR_STATUS[kind],
  );
}

// ── Loader (GET): verify signature only, render confirm page ─────────────────

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  const verified = verifyMagicTokenSignature(token);
  if (!verified.ok) return errorPage(toErrorKind(verified.reason));

  // Read-only exhaustion peek so an already-used link gets an honest page on
  // GET too. This does NOT consume — scanners can prefetch harmlessly.
  const row = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: sha256(token) },
  });
  if (!row) return errorPage("INVALID");
  if (row.useCount >= row.maxUses) return errorPage("USED");

  try {
    const desc = await describeMagicAction(verified.payload);
    return html(confirmPage(desc));
  } catch (err) {
    console.error("[magic] confirm page failed", verified.payload.action, err);
    return errorPage("GENERIC");
  }
};

// ── Action (POST): consume + execute ─────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const token = params.token ?? "";
  const verified = await verifyAndConsumeMagicToken(token);
  if (!verified.ok) return errorPage(toErrorKind(verified.reason));

  try {
    const result = await executeMagicAction(verified.payload);

    if (result.redirect) {
      // 303: the browser follows with GET. UPDATE_CARD tokens carry maxUses 5
      // so the Shopify card page can be revisited from the same email. LOGIN
      // redirects carry only a single-use ~60s hand-off code — the portal
      // exchanges it server-side for the HttpOnly session cookie.
      return redirect(result.redirect, { status: 303 });
    }

    return html(successPage(result));
  } catch (err) {
    console.error("[magic] action failed", verified.payload.action, err);
    return errorPage("GENERIC");
  }
};
