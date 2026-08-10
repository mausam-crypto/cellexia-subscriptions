import { normalizeLocale, t } from "~/lib/i18n/i18n.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

/**
 * Shared HTML layout for every portal page served through the app proxy.
 *
 * Pages are returned via `liquid(html)` so the storefront theme wraps them in
 * the store's own header/footer — this file only produces the content block:
 * a scoped `<style>`, the page body, a sticky bottom nav (mobile) and a toast.
 * Everything is prefixed `.cx-` to avoid colliding with theme CSS. No JS
 * frameworks: plain forms plus a few lines of vanilla JS for toasts, confirm
 * prompts and double-submit protection.
 */

// ── Small shared helpers ─────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Normalized locale from the proxy request's ?locale= (Shopify appends it). */
export function localeFromRequest(request: Request): string {
  return normalizeLocale(new URL(request.url).searchParams.get("locale"));
}

/**
 * Right-to-left locales. Of the 22 shipped catalogs only Arabic is RTL today;
 * the other codes future-proof the check for catalogs that may be added.
 */
const RTL_LANGS = new Set(["ar", "he", "fa", "ur"]);

export function isRtlLocale(locale: string | null | undefined): boolean {
  return RTL_LANGS.has(normalizeLocale(locale).split("-")[0]);
}

/**
 * Append ?locale= to a portal path (skipped for the default "en"), plus the
 * ?cx_pp= admin preview token when one is given and the path targets the
 * portal proxy. The app proxy strips cookies on a live store, so for a
 * preview session the token in the URL IS the session — every in-portal link
 * and redirect built while one is active must carry it, or the next click
 * lands sessionless on the login page. Callers pass
 * `session.previewToken` (null for cookie / storefront-login sessions, which
 * makes this a no-op).
 */
export function withLocale(
  path: string,
  locale: string,
  preview?: string | null,
): string {
  let out = path;
  if (locale && locale !== "en") {
    const sep = out.includes("?") ? "&" : "?";
    out = `${out}${sep}locale=${encodeURIComponent(locale)}`;
  }
  if (preview && out.startsWith(PORTAL_PROXY_BASE)) {
    const sep = out.includes("?") ? "&" : "?";
    out = `${out}${sep}cx_pp=${encodeURIComponent(preview)}`;
  }
  return out;
}

/** Toast keys the layout will render; anything else in ?toast= is ignored. */
export const TOAST_KEYS = new Set([
  "skipped",
  "unskipped",
  "delayed",
  "frequency_changed",
  "swapped",
  "quantity_changed",
  "line_added",
  "line_removed",
  "addon_added",
  "paused",
  "resumed",
  "date_changed",
  "address_updated",
  "restarted",
  "saved_pending",
  "not_found",
  "cannot_remove_last",
  "preview_blocked",
  "error",
]);

export interface PortalToast {
  /** Localized toast text. */
  text: string;
  /** Optional extra HTML rendered inside the toast (e.g. an undo form). */
  html?: string;
}

/** Resolve ?toast= from the request into localized toast content, if valid. */
export function resolveToast(
  request: Request,
  locale: string,
): { key: string; toast: PortalToast } | null {
  const key = new URL(request.url).searchParams.get("toast");
  if (!key || !TOAST_KEYS.has(key)) return null;
  return { key, toast: { text: t(locale, `portal.toast.${key}`) } };
}

// ── Page shell ───────────────────────────────────────────────────────────────

export interface PortalPageInput {
  locale: string;
  /** Page heading (plain text — escaped here). */
  title: string;
  /** Pre-built, already-escaped HTML for the page content. */
  body?: string;
  /** Alias for `body` accepted for cross-module callers (cancel flow). */
  bodyHtml?: string;
  activeNav?: "subscriptions" | "account" | null;
  toast?: PortalToast | null;
  /** Hide the bottom nav (login page). */
  hideNav?: boolean;
  /** Optional back link above the heading. */
  backHref?: string;
  backLabel?: string;
  /** Admin preview session — renders the persistent "Preview mode" banner. */
  isPreview?: boolean;
  /**
   * Raw ?cx_pp= token of the active preview session, so the nav links carry
   * it (see withLocale). Pass `session.previewToken`; null/omitted for
   * cookie and storefront-login sessions.
   */
  previewToken?: string | null;
  /**
   * This is the setup-gate page AND it is safe to arm the one-shot token
   * rescue: marks the root with data-cellexia-gate so the inline script may
   * re-try ONCE with a sessionStorage-saved preview token when the URL lost
   * its ?cx_pp= (the storefront password page redirect is the classic
   * query-shedding hop). Only ever set for GET-rendered gates — a gate
   * rendered as a POST response (portal api action, cancel-flow actions,
   * login OTP action) must not arm it, because location.replace re-issues
   * the POST URL as a GET and lands on a raw 405/404 instead of the gate.
   * Customers are unaffected either way: the gate only renders while the
   * store is dark, and only a browser that previously held a live admin
   * preview has a saved token.
   */
  isSetupGate?: boolean;
}

const STYLE = `
.cx-portal{
  --cx-bg:#faf8f5;--cx-card:#ffffff;--cx-ink:#2b2b28;--cx-muted:#8a837a;
  --cx-line:#ece7df;--cx-accent:#4a5d4a;--cx-accent-soft:#eef1ee;
  --cx-accent-ink:#f6f4ef;--cx-amber:#8a6d3b;--cx-amber-soft:#f6efe2;
  --cx-danger:#a04b3c;--cx-danger-soft:#f7ebe8;--cx-radius:12px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--cx-ink);max-width:680px;margin:0 auto;
  padding:24px 16px 96px;line-height:1.55;font-size:16px;
  -webkit-font-smoothing:antialiased;
}
.cx-portal *,.cx-portal *::before,.cx-portal *::after{box-sizing:border-box}
.cx-portal h1,.cx-portal h2,.cx-portal h3{font-family:Georgia,"Times New Roman",serif;font-weight:400;margin:0;color:var(--cx-ink)}
.cx-head{margin:0 0 20px}
.cx-head h1{font-size:26px;letter-spacing:0.01em}
.cx-head .cx-sub{margin:6px 0 0;color:var(--cx-muted);font-size:14px}
.cx-back{display:inline-flex;align-items:center;gap:6px;min-height:44px;color:var(--cx-muted);text-decoration:none;font-size:14px}
.cx-back:hover{color:var(--cx-ink)}
.cx-card{background:var(--cx-card);border:1px solid var(--cx-line);border-radius:var(--cx-radius);padding:20px;margin:0 0 16px}
.cx-card--flush{padding:0;overflow:hidden}
.cx-muted{color:var(--cx-muted)}
.cx-small{font-size:13px}
.cx-row{display:flex;align-items:center;gap:12px}
.cx-row--between{justify-content:space-between}
.cx-row--wrap{flex-wrap:wrap}
.cx-stack>*+*{margin-top:12px}
.cx-divider{border:0;border-top:1px solid var(--cx-line);margin:16px 0}
.cx-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600}
.cx-chip--active{background:var(--cx-accent-soft);color:var(--cx-accent)}
.cx-chip--paused{background:var(--cx-amber-soft);color:var(--cx-amber)}
.cx-chip--cancelled,.cx-chip--expired{background:#f0eeea;color:var(--cx-muted)}
.cx-chip--failed{background:var(--cx-danger-soft);color:var(--cx-danger)}
.cx-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 20px;border-radius:8px;border:1px solid var(--cx-accent);background:var(--cx-accent);color:var(--cx-accent-ink);font-size:15px;font-weight:500;text-decoration:none;cursor:pointer;transition:opacity .15s ease;font-family:inherit;line-height:1.2}
.cx-btn:hover{opacity:.9}
.cx-btn:disabled{opacity:.5;cursor:default}
.cx-btn--ghost{background:transparent;color:var(--cx-accent);border-color:var(--cx-accent)}
.cx-btn--quiet{background:transparent;color:var(--cx-ink);border-color:var(--cx-line)}
.cx-btn--danger{background:transparent;color:var(--cx-danger);border-color:transparent;padding-left:8px;padding-right:8px}
.cx-btn--small{min-height:44px;padding:8px 14px;font-size:14px}
.cx-btn--full{width:100%}
.cx-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.cx-label{display:block;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:var(--cx-muted);margin:0 0 6px}
.cx-input,.cx-select{width:100%;min-height:44px;padding:10px 14px;border:1px solid var(--cx-line);border-radius:8px;background:#fff;color:var(--cx-ink);font-size:16px;font-family:inherit}
.cx-input:focus,.cx-select:focus{outline:2px solid var(--cx-accent);outline-offset:1px;border-color:var(--cx-accent)}
.cx-field{margin:0 0 14px}
.cx-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.cx-form-grid .cx-field--full{grid-column:1 / -1}
.cx-item{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--cx-line)}
.cx-item:last-child{border-bottom:0;padding-bottom:0}
.cx-item:first-child{padding-top:0}
.cx-thumb{width:56px;height:56px;border-radius:8px;object-fit:cover;background:var(--cx-bg);border:1px solid var(--cx-line);flex:none}
.cx-thumb--placeholder{display:flex;align-items:center;justify-content:center;color:var(--cx-muted);font-size:20px;font-family:Georgia,serif}
.cx-item__body{flex:1;min-width:0}
.cx-item__title{font-weight:500;margin:0}
.cx-item__meta{color:var(--cx-muted);font-size:13px;margin:2px 0 0}
.cx-price{font-variant-numeric:tabular-nums;white-space:nowrap}
.cx-compare{color:var(--cx-muted);text-decoration:line-through;font-size:13px;margin-right:6px}
.cx-stepper{display:inline-flex;align-items:center;border:1px solid var(--cx-line);border-radius:8px;overflow:hidden}
.cx-stepper form{display:flex}
.cx-stepper button{min-width:44px;min-height:44px;border:0;background:transparent;font-size:18px;cursor:pointer;color:var(--cx-ink);font-family:inherit}
.cx-stepper button:disabled{color:var(--cx-line);cursor:default}
.cx-stepper__qty{min-width:36px;text-align:center;font-variant-numeric:tabular-nums}
details.cx-acc{border:1px solid var(--cx-line);border-radius:var(--cx-radius);background:var(--cx-card);margin:0 0 12px}
details.cx-acc>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:16px 20px;cursor:pointer;font-family:Georgia,"Times New Roman",serif;font-size:17px}
details.cx-acc>summary::-webkit-details-marker{display:none}
details.cx-acc>summary::after{content:"";width:9px;height:9px;border-right:1.5px solid var(--cx-muted);border-bottom:1.5px solid var(--cx-muted);transform:rotate(45deg);transition:transform .15s ease;flex:none;margin-right:4px}
details.cx-acc[open]>summary::after{transform:rotate(-135deg)}
details.cx-acc>.cx-acc__body{padding:4px 20px 20px}
.cx-banner{display:flex;flex-wrap:wrap;align-items:center;gap:12px;background:var(--cx-accent-soft);border:1px solid #dde4dd;border-radius:var(--cx-radius);padding:16px 20px;margin:0 0 16px}
.cx-banner p{margin:0;flex:1;min-width:200px;font-size:15px}
.cx-rewards{background:linear-gradient(135deg,#42533f,#4a5d4a 55%,#5b7058);color:var(--cx-accent-ink);border-radius:var(--cx-radius);padding:20px;margin:0 0 16px}
.cx-rewards h2{color:#fdfcf9;font-size:18px;margin:0 0 12px}
.cx-rewards .cx-muted{color:#cfd7cd}
.cx-rewards__grid{display:flex;gap:20px;flex-wrap:wrap}
.cx-rewards__cell{flex:1;min-width:150px}
.cx-rewards__num{font-family:Georgia,serif;font-size:24px;line-height:1.1}
.cx-progress{height:6px;border-radius:3px;background:rgba(255,255,255,.25);overflow:hidden;margin-top:8px}
.cx-progress>span{display:block;height:100%;background:#fdfcf9;border-radius:3px}
.cx-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.cx-grid .cx-card{margin:0;padding:14px;display:flex;flex-direction:column;gap:8px}
.cx-grid .cx-thumb{width:100%;height:120px}
.cx-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:12px;background:#2b2b28;color:#faf8f5;border-radius:10px;padding:12px 18px;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.18);max-width:calc(100vw - 32px);transition:opacity .3s ease}
.cx-toast--hide{opacity:0;pointer-events:none}
.cx-toast form{display:inline}
.cx-toast button[type=submit]{background:none;border:0;color:#b8c4b6;text-decoration:underline;cursor:pointer;font-size:14px;min-height:44px;padding:0 4px;font-family:inherit}
.cx-nav{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;background:#fffdfa;border-top:1px solid var(--cx-line);padding-bottom:env(safe-area-inset-bottom)}
.cx-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:56px;text-decoration:none;color:var(--cx-muted);font-size:12px;letter-spacing:0.02em}
.cx-nav a.cx-nav--on{color:var(--cx-accent);font-weight:600}
.cx-nav svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.6}
.cx-hp{position:absolute !important;left:-9999px !important;width:1px;height:1px;overflow:hidden}
.cx-preview-bar{position:fixed;top:0;left:0;right:0;z-index:100;background:#2b2b28;color:#faf8f5;text-align:center;font-size:13px;line-height:1.4;padding:11px 16px;letter-spacing:0.01em}
.cx-error{background:var(--cx-danger-soft);color:var(--cx-danger);border-radius:8px;padding:12px 16px;font-size:14px;margin:0 0 14px}
.cx-note{background:var(--cx-bg);border:1px dashed var(--cx-line);border-radius:8px;padding:12px 16px;font-size:14px;color:var(--cx-muted)}
.cx-portal[dir=rtl] .cx-compare{margin-right:0;margin-left:6px}
.cx-portal[dir=rtl] details.cx-acc>summary::after{margin-right:0;margin-left:4px}
@media (min-width:720px){
  .cx-portal{padding-bottom:48px}
  .cx-nav{position:static;border:0;background:transparent;justify-content:flex-start;gap:8px;margin:0 0 24px;order:-1}
  .cx-nav a{flex:none;flex-direction:row;gap:8px;padding:0 16px;border-radius:999px;border:1px solid var(--cx-line);font-size:14px;min-height:44px}
  .cx-nav a.cx-nav--on{border-color:var(--cx-accent);background:var(--cx-accent-soft)}
  .cx-shell{display:flex;flex-direction:column}
  .cx-toast{bottom:32px}
  .cx-grid{grid-template-columns:repeat(3,1fr)}
}
`;

const SCRIPT = `
(function(){
  // NOTE: session tokens never ride in the URL or a JS-set cookie. Magic-link
  // logins hand off a single-use code that the SERVER exchanges for the
  // HttpOnly cx_portal cookie before this page ever renders — so this script
  // has nothing credential-shaped to touch.
  // The ONE document-level lookup on this page, qualified by our class AND
  // our attribute. The portal is served through the app proxy, so this markup
  // is injected into the MERCHANT'S THEME: the theme's own markup and every
  // storefront app on the shop — including the other "cx" vendor this app was
  // renamed away from — share this document. A bare ".cx-toast" or
  // ".cx-portal form" lookup is the same mistake that made the buy box bind to
  // a foreign wrapper in v1.2.2. Everything below is rooted at this node, so
  // nothing outside our own subtree is ever read, and — for the submit
  // handlers, which DISABLE buttons — never written either.
  var root=document.querySelector(".cx-portal[data-cellexia-portal]");
  if(!root){return;}
  var toast=root.querySelector(".cx-toast[data-cellexia-toast]");
  if(toast){
    setTimeout(function(){toast.classList.add("cx-toast--hide")},7000);
  }
  root.querySelectorAll("form[data-cellexia-confirm]").forEach(function(f){
    f.addEventListener("submit",function(e){
      if(!window.confirm(f.getAttribute("data-cellexia-confirm"))){e.preventDefault();}
    });
  });
  // Double-submit guard: the FIRST submit marks the form; any further submit
  // (double-tap, impatient retry) is prevented outright, and the buttons are
  // disabled a tick later so the first submission itself is never blocked.
  // Best-effort only — the server dedupes the same cycle independently.
  root.querySelectorAll("form").forEach(function(f){
    f.addEventListener("submit",function(e){
      if(f.hasAttribute("data-cellexia-submitted")){e.preventDefault();return;}
      f.setAttribute("data-cellexia-submitted","");
      setTimeout(function(){
        f.querySelectorAll("button[type=submit],input[type=submit]").forEach(function(b){b.disabled=true;});
      },0);
    });
  });
  // Belt-and-suspenders for the cookie-less admin preview (?cx_pp=): the app
  // proxy strips cookies, so the token in the URL is the whole session — a
  // single link or form that dropped it dead-ends the preview at the login
  // page. The server threads the token through every URL it builds
  // (withLocale's third parameter); this pass re-stamps anything that slipped
  // through. Root-scoped like everything above — only OUR portal-base links
  // and forms are ever touched, never the theme's. NOT a credential in the
  // cookie sense: the token is admin-minted, 1-hour, and view-only (every
  // mutation is intercepted server-side for preview sessions).
  var pp=new window.URLSearchParams(window.location.search).get("cx_pp");
  var ppBase="${PORTAL_PROXY_BASE}";
  var ppJoin=function(url,tok){return url+(url.indexOf("?")===-1?"?":"&")+"cx_pp="+encodeURIComponent(tok);};
  if(pp){
    var ppAdd=function(url){return ppJoin(url,pp);};
    root.querySelectorAll("a[href]").forEach(function(a){
      var href=a.getAttribute("href");
      if(href&&href.indexOf(ppBase)===0&&href.indexOf("cx_pp=")===-1){
        a.setAttribute("href",ppAdd(href));
      }
    });
    root.querySelectorAll("form").forEach(function(f){
      var action=f.getAttribute("action")||"";
      if(action.indexOf(ppBase)!==0){return;}
      // The server reads cx_pp from the query string (POST bodies are not
      // consulted), so the action URL gets it; the hidden input is a second
      // copy for anything that rewrites the action downstream.
      if(action.indexOf("cx_pp=")===-1){f.setAttribute("action",ppAdd(action));}
      if(!f.querySelector('input[name="cx_pp"]')){
        var hidden=document.createElement("input");
        hidden.type="hidden";hidden.name="cx_pp";hidden.value=pp;
        f.appendChild(hidden);
      }
    });
  }
  // Preview-token continuity across dropped query strings. On a live store
  // the token in the URL IS the whole session (the proxy strips cookies), and
  // redirects outside our control — the storefront password page above all —
  // can shed the query on the way back. So: a page rendering a live preview
  // (the preview bar proves the token opened a session) saves the token; the
  // sessionless SETUP GATE page — which only renders while the store is dark,
  // so no customer traffic exists to misdirect — re-tries once with the saved
  // token when its own URL arrived without one. No loop is possible: the
  // retry URL carries cx_pp, and a page whose URL carries cx_pp never
  // retries. Same storage trade-off the buy-box preview already accepted
  // (admin-minted, short-TTL, view-only token in sessionStorage); wrapped in
  // try/catch because sessionStorage itself can throw (private browsing).
  try{
    if(pp&&root.querySelector(".cx-preview-bar")){
      window.sessionStorage.setItem("cellexia:cx_pp",pp);
    }
    if(!pp&&root.hasAttribute("data-cellexia-gate")){
      var saved=window.sessionStorage.getItem("cellexia:cx_pp");
      if(saved){window.location.replace(ppJoin(window.location.href,saved));}
    }
  }catch(e){}
})();
`;

const NAV_ICON_SUBSCRIPTIONS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4z"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/></svg>`;
const NAV_ICON_ACCOUNT = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`;

/** Build the full portal content block for a `liquid()` response. */
export function portalPage(input: PortalPageInput): string {
  const locale = input.locale;
  const base = PORTAL_PROXY_BASE;
  const body = input.body ?? input.bodyHtml ?? "";
  // The theme's <html> is not ours to change, so language + direction are
  // declared on the portal root: Arabic (etc.) renders RTL with correct
  // screen-reader pronunciation even inside an LTR theme.
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const backArrow = dir === "rtl" ? "&rarr;" : "&larr;";

  const preview = input.previewToken ?? null;
  const nav = input.hideNav
    ? ""
    : `<nav class="cx-nav" aria-label="${escapeHtml(t(locale, "portal.nav.label"))}">
        <a href="${withLocale(`${base}/`, locale, preview)}"${input.activeNav === "subscriptions" ? ' class="cx-nav--on" aria-current="page"' : ""}>${NAV_ICON_SUBSCRIPTIONS}<span>${escapeHtml(t(locale, "portal.nav.subscriptions"))}</span></a>
        <a href="${withLocale(`${base}/account`, locale, preview)}"${input.activeNav === "account" ? ' class="cx-nav--on" aria-current="page"' : ""}>${NAV_ICON_ACCOUNT}<span>${escapeHtml(t(locale, "portal.nav.account"))}</span></a>
      </nav>`;

  const toast = input.toast
    ? `<div class="cx-toast" data-cellexia-toast role="status">${escapeHtml(input.toast.text)}${input.toast.html ?? ""}</div>`
    : "";

  const back = input.backHref
    ? `<a class="cx-back" href="${escapeHtml(input.backHref)}">${backArrow} ${escapeHtml(input.backLabel ?? t(locale, "portal.back"))}</a>`
    : "";

  // Slim fixed banner + body offset so the theme header is never covered.
  const previewBar = input.isPreview
    ? `<style>body{padding-top:42px !important}</style><div class="cx-preview-bar" role="status">${escapeHtml(t(locale, "portal.preview.banner"))}</div>`
    : "";

  // The gate marker rides at the tag's end so the data-cellexia-portal
  // literal keeps its plain trailing space — the lint suite's selector↔markup
  // pairing scanner reads this source file and must keep seeing it.
  const gateAttr = input.isSetupGate ? ' data-cellexia-gate=""' : "";
  return `<div class="cx-portal" data-cellexia-portal lang="${escapeHtml(locale)}" dir="${dir}"${gateAttr}>
<style>${STYLE}</style>
${previewBar}
<div class="cx-shell">
${nav}
<header class="cx-head">
${back}
<h1>${escapeHtml(input.title)}</h1>
</header>
<main>
${body}
</main>
</div>
${toast}
<script>${SCRIPT}</script>
</div>`;
}

/**
 * Minimal branded "portal not yet available" page, shown to the public while
 * the app is in setup mode (launch gate). Preview sessions never see this.
 * Served with a 200 — a temporary state, not an error — and noindex so the
 * closed portal never enters a search index.
 */
export function setupGatePage(
  locale: string,
  opts: { armTokenRescue?: boolean } = {},
): string {
  return portalPage({
    locale,
    title: t(locale, "portal.setup.title"),
    body: `<meta name="robots" content="noindex"><div class="cx-card"><p style="margin:0">${escapeHtml(t(locale, "portal.setup.body"))}</p></div>`,
    hideNav: true,
    // Default true: every direct caller renders the gate from a GET loader.
    // POST-rendered gates go through closedPortalPage, which disarms.
    isSetupGate: opts.armTokenRescue !== false,
  });
}

/**
 * Dedicated page for an expired/tampered ?cx_pp= admin preview link — an
 * honest, actionable message instead of the generic setup gate the admin
 * used to dead-end on. Rendered even in setup mode: this URL only exists
 * because an admin minted it.
 */
export function previewExpiredPage(locale: string): string {
  return portalPage({
    locale,
    title: t(locale, "portal.preview.expired_title"),
    body: `<meta name="robots" content="noindex"><div class="cx-card"><p style="margin:0">${escapeHtml(t(locale, "portal.preview.expired_body"))}</p></div>`,
    hideNav: true,
  });
}

/**
 * The page to serve when the portal is CLOSED to this request (setup-mode
 * launch gate). One rule, applied at every gate site: a request that carries
 * a ?cx_pp= preview token reached the gate only because that token failed to
 * open a session (a valid one bypasses the gate), so it gets the named
 * "preview link expired" page; everything else gets the generic gate. Before
 * this helper only the login page named the expiry — a storefront-logged-in
 * admin on a stale preview link got a non-preview session, hit the gate on
 * the portal home, and saw "finishing touches" with zero explanation.
 */
export function closedPortalPage(request: Request, locale: string): string {
  const hasPreviewToken = new URL(request.url).searchParams.has("cx_pp");
  if (hasPreviewToken) return previewExpiredPage(locale);
  // The token rescue may only arm on GET-rendered gates: a gate returned as
  // a POST response (api action, cancel-flow action) sits at a POST-only
  // URL, and the rescue's location.replace would replay it as a GET — a raw
  // "Method Not Allowed" (or a preview-persona 404 on cancel routes) where
  // the designed gate page used to be.
  return setupGatePage(locale, { armTokenRescue: request.method === "GET" });
}
