/**
 * Cellexia Buy Box — storefront behaviour. Vanilla JS, zero dependencies,
 * loaded deferred via the block schema (Shopify dedupes across blocks).
 *
 * Responsibilities:
 *  - Sync the selected purchase option into a hidden `selling_plan` input
 *    inside the product form (form[action*="/cart/add"], scoped to this
 *    block's section so pages with several product forms behave). The form
 *    must be OURS: outside a section scope a candidate form is only accepted
 *    when its [name="id"] is a variant of this product (or is not filled in
 *    yet) — a PDP's quick-add / cross-sell forms belong to other products and
 *    would be poisoned by our selling_plan (Shopify 422). Themes with no
 *    product form at all get no form here; buy-box-embed.js carries the plan
 *    on their AJAX cart requests instead.
 *  - Keep EXACTLY ONE field named `selling_plan` in that form. Shopify's cart
 *    parser honours the LAST duplicate, so a second field silently wins over
 *    the one we keep updating (the app embed can move the widget — and the
 *    server-rendered mirror inside it — into the very form we already
 *    injected into). This file therefore owns a single field, tagged
 *    `data-cellexia-plan-input` ("own" = created here, "adopted" = the theme's own
 *    input, reused), and neutralises any other one that turns up.
 *  - NEVER touch the theme's form while the widget is not visible. The
 *    launch gate ([data-cellexia-gated][hidden] until the shop metafield
 *    cellexia.launch_status is "live") and the unmounted/dormant app-embed
 *    wrapper are WRITE gates as well as visual ones: a visitor who cannot
 *    see the buy box must never end up with a subscription line in the cart.
 *    Anything this widget wrote before it became hidden is undone; when it
 *    is legitimately revealed (validated preview token, embed mount) the
 *    write path is re-run through CellexiaSubs.resync().
 *  - Stamp subscription add-to-carts with a hidden line property
 *    `properties[_cellexia_design]` = the wrapper's data-cellexia-preset, so the
 *    ORDERS_CREATE webhook can attribute take-rate per design. The property
 *    is disabled (not submitted) whenever one-time purchase is selected.
 *  - Drive all eight design presets from the same state machine:
 *    radios (classic/tiles/value_stack/planner/subscription_max), role=tab
 *    toggle buttons (with arrow-key keyboard support), the inline checkbox,
 *    and frequency chips — every control funnels into setMode()/render().
 *    subscription_max (v1.6.0) needs NO code of its own by design: its
 *    quiet one-time line is a data-cellexia-option radio like any card, its
 *    picked/unpicked swap is pure CSS on the wrap's is-selected class this
 *    file already toggles, and its switch-back label reaches the
 *    subscription radio natively through its for attribute — the browser's
 *    label click fires the radio change event this file already handles.
 *    Do not add a parallel handler for it.
 *  - Re-render prices when the variant changes — for ANY switching
 *    mechanism. Product form `change` events and the ?variant= URL fallback
 *    (history patch + popstate) are the fast paths; under them sit
 *    EVENT-FREE layers (v1.6.8, from the live Sleepify defect: the theme's
 *    size pills set the variant programmatically — jQuery .val(), no change
 *    event, no URL write — and every price surface froze on the landing
 *    variant): click delegation over the product area and a cheap 600ms
 *    visibility-gated poll of the theme's [name="id"] field, both funnelling
 *    into one authoritative re-read. See "Event-independent variant
 *    tracking" inside init(). Price nodes carry stable data-cellexia-* hooks
 *    in every preset (data-cellexia-sub-price, data-cellexia-onetime-price,
 *    data-cellexia-pd-price, data-cellexia-then, data-cellexia-save,
 *    data-cellexia-per-delivery, data-cellexia-first-label); a variant change
 *    also re-anchors the root's data-cellexia-money-* pair so the theme
 *    add-to-cart price sync swaps the NEW variant's strings.
 *  - Re-resolve {percent}/{amount}/{frequency} text templates carried in
 *    data-cellexia-tpl attributes with per-plan values from the JSON island.
 *  - Keep the THEME's own add-to-cart button honest: when a theme prints the
 *    price in that button ("ADD TO CART - CHF 64.00") and the shopper selects
 *    the subscription, swap the one-time money STRING for the subscription
 *    one inside the button's text nodes, and put the theme's text back on
 *    one-time / hidden / gated. Opt-out + custom selector come from the
 *    published design config (themeSync). See the module below: it never
 *    touches innerHTML, never guesses a price, and never blocks add-to-cart.
 *  - Register each widget on window.CellexiaSubs (guarded global — the page
 *    may carry OTHER vendors' "cx-*" ids; we never touch those) so the app
 *    embed's companion script (buy-box-embed.js) can read the current
 *    selection when patching JS-driven cart requests on themes that have no
 *    /cart/add form, and can push variant changes back in.
 *
 * All displayed strings are precomputed, fully localized, in the block's
 * JSON island — this file never formats money or composes copy.
 */
(function () {
  'use strict';

  if (window.__cxBuyBoxLoaded) {
    return;
  }
  window.__cxBuyBoxLoaded = true;

  /* ── Ownership selectors ─────────────────────────────────────────────────
     The ONLY selectors this file may use to find its own markup at document
     level. Class AND attribute, always — never a bare [attribute] lookup.

     WHY (observed live on cellexialabs.com): the client's product page also
     hosts an unrelated vendor that owns the "cx" namespace — a
     <div class="cx cx--self-contained" data-cx-embed> inside the buy column,
     plus cx-i18n / cx-cart-config / cx-pdp-config / cx-embed-config script
     ids. Our storefront attributes were formerly data-cx-* too, so a bare
     attribute lookup matched THAT vendor's element (it comes earlier in the
     DOM), we marked and adopted markup we do not own, and our own widget
     never mounted — an invisible buy box on the one store that matters. The
     attributes are namespaced data-cellexia-* now; qualifying every lookup
     with our own class as well is the second, independent net. The class
     names stay cx-buybox* — they do not collide with that vendor's
     .cx / .cx--self-contained. See assets/buy-box-embed.js for the full
     write-up. Do not relax either layer. */
  var OWN_WIDGET = '.cx-buybox[data-cellexia-buybox]';
  var OWN_WRAPPER = '.cx-buybox-embed[data-cellexia-embed]';
  var OWN_GATED = '.cx-buybox[data-cellexia-gated]';
  /* The subscription_ultra_max preset's relocated one-time line (the
     "satellite" module inside init()): OUR markup that legitimately lives
     OUTSIDE the widget root once mounted, so every scan that skips "ours"
     must skip it too, and every mutation of it asserts this class first. */
  var OWN_SATELLITE = '.cx-buybox-satellite[data-cellexia-satellite]';
  /* The marker the Liquid leaves when this product carries selling plans but
     none of them are ours (another subscription app owns every group on it).
     It is an empty, hidden <template>: invisible to a shopper by definition,
     and the only thing that tells this file "the widget rendered nothing on
     purpose". Class-qualified like every other own-markup selector. */
  var OWN_NO_GROUP = '.cx-buybox-nogroup[data-cellexia-no-owned-group]';

  /* Themes like Dawn update ?variant= via history.replaceState without firing
     any event we can hear — patch history once so URL changes become events. */
  var historyPatched = false;
  function patchHistory() {
    if (historyPatched) {
      return;
    }
    historyPatched = true;
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = window.history[method];
      if (typeof original !== 'function') {
        return;
      }
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        try {
          window.dispatchEvent(new CustomEvent('cx:locationchange'));
        } catch (err) {
          /* never break navigation */
        }
        return result;
      };
    });
  }

  function variantIdFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('variant') || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Still in the live document? (isConnected, with an older-browser path.)
   *
   * A theme-editor section re-render — or an AJAX buy-column swap — replaces
   * a whole subtree, leaving the widget root and the product form it bound to
   * DETACHED but still referenced by this file's closures. A detached node
   * has no [hidden] ancestor, so "is it visible?" answers yes for a widget
   * nobody can see; every visibility test here therefore starts with this.
   */
  function inDocument(node) {
    if (!node) {
      return false;
    }
    if (typeof node.isConnected === 'boolean') {
      return node.isConnected;
    }
    return document.contains ? document.contains(node) : true;
  }

  /* ── Admin preview (setup mode) ──────────────────────────────────────────
     While the app is in setup mode the block renders [hidden][data-cellexia-gated]
     for everyone. A signed preview link (?cx_preview=<token>) lets the
     admin — and only the admin's own browser session — reveal it: the token
     is kept in sessionStorage (so PDP → cart navigation keeps preview on)
     and validated server-side via the app proxy before anything is shown.
     Fail closed: any network or validation problem leaves the widget
     hidden. In live mode nothing is gated and this module does no work —
     and never fetches. */

  var PREVIEW_STORAGE_KEY = 'cx_preview_token';
  /* Hardcoded because theme-extension JS cannot import app modules — must
     match PORTAL_PROXY_SUBPATH in app/lib/portal/proxy-path.ts and the
     [app_proxy] subpath in shopify.app.toml (tests/proxy-subpath.test.ts
     enforces the agreement). NEVER '/apps/cellexia': that subpath is served
     by the merchant's other live app ("AOV & LTV Booster"). */
  var PREVIEW_VALIDATE_PATH = '/apps/cellexia-subs/preview/validate';
  var previewValidated = false;
  /* True only when THIS page load carried ?cx_preview= in the URL — a gate
     EVERY admin-only diagnostic card requires (the validation-failure card
     alone, the other two in conjunction with the validated session).
     Deliberately not derived from sessionStorage: the stored token follows
     the tab across pages, and a card must only ever appear on the page the
     admin is actually looking at through a preview link. */
  var previewTokenInUrl = false;

  function previewStorageGet() {
    try {
      return window.sessionStorage.getItem(PREVIEW_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function previewStorageSet(token) {
    try {
      window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, token);
    } catch (err) {
      /* storage blocked (privacy mode) → preview simply won't persist */
    }
  }

  function previewStorageClear() {
    try {
      window.sessionStorage.removeItem(PREVIEW_STORAGE_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * Re-run the write path for every VISIBLE widget. applySellingPlan()
   * deliberately refuses to touch the theme's form while its widget is
   * hidden, so a widget that becomes visible later — a validated preview
   * reveal, or the app-embed wrapper being mounted into the buy column —
   * has to push its selection at that moment.
   */
  function resyncWidgets() {
    try {
      var subs = window.CellexiaSubs;
      if (subs && typeof subs.resync === 'function') {
        subs.resync();
      }
    } catch (err) {
      /* never break the page over a form sync */
    }
  }

  /**
   * Publish "this browser session holds a SERVER-VALIDATED preview token" on
   * the guarded global, and announce it to the page.
   *
   * previewBoot() stores the raw ?cx_preview= parameter in sessionStorage
   * BEFORE the proxy has seen it, so the mere presence of that value proves
   * nothing — a leaked, expired or invented link puts it there just as well.
   * Only this flag (set exclusively on a { ok: true } answer) — and only in
   * conjunction with ?cx_preview= in the current page's own URL — may gate
   * admin-only behaviour such as buy-box-embed.js's English diagnostic card,
   * which must never be shown to a customer nor on a page the admin never
   * opened through a preview link.
   */
  function markPreviewValidated() {
    try {
      var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
      subs.previewValidated = true;
    } catch (err) {
      /* the global is a nicety — never break the reveal over it */
    }
    try {
      document.dispatchEvent(new CustomEvent('cx:preview:validated'));
    } catch (err) {
      /* no CustomEvent constructor → listeners simply never fire */
    }
  }

  /* ── Admin-only diagnostic: foreign plans, none of ours ──────────────────
     Raised once per page, and ONLY inside a server-validated preview session.

     The failure it explains is silent by design: on a product whose selling
     plan groups all belong to another subscription app (the client's store
     runs Joy Subscriptions too), the Liquid renders nothing at all rather
     than render a competitor's plan through our widget. "Nothing" is the
     correct page for a shopper and a mystery for the merchant, who is
     looking at a product page with no buy box and no explanation.

     GATED ON THE VALIDATED SESSION *AND* THE ?cx_preview= URL PARAMETER OF
     THIS PAGE LOAD — same rule, and the same reasons, as buy-box-embed.js's
     placement diagnostic. Both halves are load-bearing: previewBoot() puts
     the ?cx_preview= parameter into sessionStorage BEFORE the app proxy has
     judged it, so a raw token alone proves only that somebody put a value in
     the URL — only CellexiaSubs.previewValidated, set exclusively on an
     { ok: true } answer from the proxy, proves an admin. And the VALIDATED
     token persists in sessionStorage across same-tab navigation (so the
     widget reveal follows PDP → cart), so validation alone would raise this
     card on pages the admin never previewed — the URL parameter pins it to
     the page actually opened through a preview link. English only (an
     internal diagnostic is not customer-facing copy), no element id
     (namespace hazard), and the same card style as the other diagnostic so
     the two read as one voice. */
  var noGroupDiagnosticShown = false;

  function maybeShowNoOwnedGroupDiagnostic() {
    try {
      if (noGroupDiagnosticShown || !document.body || !previewTokenInUrl) {
        return;
      }
      var subs = window.CellexiaSubs;
      if (!subs || subs.previewValidated !== true) {
        return;
      }
      if (!document.querySelector(OWN_NO_GROUP)) {
        return;
      }
      noGroupDiagnosticShown = true;
      var card = document.createElement('div');
      card.className = 'cx-buybox-diagnostic';
      card.setAttribute('role', 'status');
      card.textContent =
        'Cellexia buy box: this product has subscription plans from another ' +
        'app but none from Cellexia. Sync your Cellexia plan to this product ' +
        "in the app's Plans page.";
      document.body.appendChild(card);
    } catch (err) {
      /* a diagnostic that cannot be shown is never worth an exception */
    }
  }

  /* ── Admin-only diagnostic: preview validation FAILED ────────────────────
     The blank page this explains: the admin followed a ?cx_preview= link,
     the assets loaded, and /preview/validate said no — an expired or invalid
     token ({ ok: false }), a proxy that is not there (HTTP 404 because the
     app configuration was never deployed), a server error, or a network
     failure. The WIDGET's fail-closed rendering is unchanged in every one of
     those cases — it stays hidden — but the silence is replaced by the usual
     diagnostic card naming which of the two failure families happened, so
     the admin is not left staring at a blank page with seven possible
     causes.

     GATE: the cx_preview URL parameter ON THIS PAGE LOAD — by definition NOT
     the validated session (validation just failed; there is none to gate
     on), and deliberately NOT sessionStorage: the stored token follows the
     browser tab across pages, so a card keyed off storage could surface on
     pages the admin never previewed. The other two diagnostics require this
     same URL-parameter gate PLUS the validated session on top.

     COPY RULE — this card is an UNAUTHENTICATED surface. Because its gate
     is the URL parameter ALONE (validation failed, so there is no proven
     admin), anyone who appends ?cx_preview=x to a gated product page can
     elicit it. The copy therefore discloses nothing a bearer does not
     already have: no proxy paths, no configuration detail, no operator
     commands ("npm run …"). Both branches route the admin to the
     admin-gated Preview Doctor on Preview & launch, which names the exact
     cause and fix behind authentication. tests/preview-failure.test.ts
     pins both the copy and the no-internal-detail rule. */
  var previewFailureShown = false;

  function maybeShowPreviewFailureDiagnostic(kind, detail) {
    try {
      if (previewFailureShown || previewValidated || !previewTokenInUrl) {
        return;
      }
      if (!document.body) {
        return;
      }
      previewFailureShown = true;
      var card = document.createElement('div');
      card.className = 'cx-buybox-diagnostic';
      card.setAttribute('role', 'status');
      card.textContent =
        kind === 'token'
          ? 'Cellexia buy box: this preview link is expired or invalid, so ' +
            'the widget stays hidden. Generate a fresh preview link from ' +
            'Preview & launch.'
          : 'Cellexia buy box: the preview could not be validated (' +
            detail +
            '), so the widget stays hidden. Open Preview & launch in the ' +
            'Cellexia admin and run the Preview Doctor for the exact ' +
            'cause and fix.';
      document.body.appendChild(card);
    } catch (err) {
      /* a diagnostic that cannot be shown is never worth an exception */
    }
  }

  function revealGated() {
    var gated = document.querySelectorAll(OWN_GATED);
    Array.prototype.forEach.call(gated, function (el) {
      el.removeAttribute('hidden');
      el.setAttribute('data-cellexia-preview', 'true');
      var ribbon = el.querySelector(
        '.cx-buybox__preview-ribbon[data-cellexia-preview-ribbon]'
      );
      if (ribbon) {
        ribbon.removeAttribute('hidden');
      }
      /* App-embed path: the widget lives inside the .cx-buybox-embed
         wrapper, which buy-box-embed.js keeps [hidden] for as long as the
         widget inside it is launch-gated (an unhidden EMPTY wrapper is a
         visible layout change on the live PDP — see buy-box.css). Reveal
         that wrapper too, but ONLY once it has actually been mounted into
         the buy column, so a dormant embed (the section block won) or one
         that found no anchor never surfaces at the end of <body>. */
      var wrapper = el.closest ? el.closest(OWN_WRAPPER) : null;
      if (wrapper && wrapper.getAttribute('data-cellexia-mounted') === 'true') {
        wrapper.removeAttribute('hidden');
      }
    });
    markPreviewValidated();
    resyncWidgets();
  }

  function previewBoot() {
    var fromUrl = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get('cx_preview');
    } catch (err) {
      fromUrl = null;
    }
    if (fromUrl) {
      previewTokenInUrl = true;
      previewStorageSet(fromUrl);
    }
    var token = previewStorageGet();
    if (!token) {
      return;
    }
    /* Nothing on this page needs a preview session: live mode renders without
       the gate, so there is nothing to reveal — and no marker means there is
       no admin-only diagnostic to raise either. Skip validation entirely (no
       fetch). The marker half matters because a product with only another
       app's plans renders NO widget at all, gated or not: without it, the one
       page whose emptiness needs explaining would never even ask the proxy
       whether this is an admin. */
    if (
      !document.querySelector(OWN_GATED) &&
      !document.querySelector(OWN_NO_GROUP)
    ) {
      return;
    }
    if (typeof window.fetch !== 'function') {
      return; /* fail closed on ancient browsers */
    }
    window
      .fetch(PREVIEW_VALIDATE_PATH + '?token=' + encodeURIComponent(token), {
        credentials: 'omit'
      })
      .then(function (response) {
        /* Server hiccup (non-2xx) → fail closed, keep the token for retry —
           but tell the admin behind a preview link WHICH hiccup: a 404 here
           is the "app configuration never deployed" blank page. */
        if (!response.ok) {
          maybeShowPreviewFailureDiagnostic('proxy', 'HTTP ' + response.status);
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data) {
          return;
        }
        if (data.ok === true) {
          previewValidated = true;
          /* revealGated() publishes CellexiaSubs.previewValidated, which is
             the gate the diagnostic reads — so it runs first even on pages
             where there is no gated widget to reveal. */
          revealGated();
          maybeShowNoOwnedGroupDiagnostic();
        } else {
          /* Invalid or expired token: forget it so we stop asking — and name
             the reason for the admin whose link just went dark. */
          previewStorageClear();
          maybeShowPreviewFailureDiagnostic('token', '');
        }
      })
      .catch(function () {
        /* Network error (or a non-JSON answer on the subpath) → the widget
           stays hidden; the card explains instead of nothing. The helper
           refuses to fire after a successful validation, so an exception
           thrown by the reveal path above can never masquerade as a proxy
           failure. */
        maybeShowPreviewFailureDiagnostic('proxy', 'a network error or timeout');
      });
  }

  /** Set text and hide the element entirely when the string is empty. */
  function setText(el, text) {
    if (!el) {
      return;
    }
    var value = text || '';
    if (el.textContent !== value) {
      el.textContent = value;
    }
    if (value === '') {
      el.setAttribute('hidden', 'hidden');
    } else {
      el.removeAttribute('hidden');
    }
  }

  /**
   * Set a price node's text; when compareText is given (showCompareAt),
   * append the struck-through one-time price. Never hides the node.
   */
  function setPrice(el, text, compareText) {
    if (!el) {
      return;
    }
    el.textContent = text || '';
    if (compareText && compareText !== text) {
      el.appendChild(document.createTextNode(' '));
      var struck = document.createElement('s');
      struck.className = 'cx-price__compare';
      struck.textContent = compareText;
      el.appendChild(struck);
    }
  }

  /**
   * Resolve a {percent}/{amount}/{frequency} template (from data-cellexia-tpl)
   * with per-plan values. Blank values collapse cleanly: "Subscribe & save
   * {percent}" with no saving degrades to "Subscribe & save".
   */
  function resolveTpl(tpl, vals) {
    return String(tpl || '')
      .replace(/\{percent\}/g, vals.percent)
      .replace(/\{amount\}/g, vals.amount)
      .replace(/\{frequency\}/g, vals.frequency)
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  /* ══ THEME ADD-TO-CART PRICE SYNC ════════════════════════════════════════
     Most themes print the price inside their own add-to-cart button
     ("ADD TO CART - CHF 64.00"). That string is the ONE-TIME price, so with
     the subscription option selected the widget shows CHF 51.20 while the
     button the shopper is about to click still says CHF 64.00 — two prices
     for one action, on the last click before the cart.

     What this module does — and deliberately does not do:

      - It is a MONEY-STRING SWAP, not a price re-render. It walks the
        target's TEXT NODES (never innerHTML, never a node the theme owns
        structurally) and replaces occurrences of the exact one-time money
        string with the subscription one. Both strings are formatted by
        Liquid with the shop's own money_format — this file never formats
        money, here as everywhere else.
      - If the one-time string is not in the element, it does NOTHING. No
        currency regex, no guessing which number is the price: a theme whose
        button reads "Add to cart" is simply left alone, silently.
      - Everything it changed is recorded, so selecting one-time (or the
        widget becoming hidden/gated/detached) restores the theme's own text
        exactly.
      - It re-applies when the theme rewrites the button — Sleepify's own JS
        rewrites that label on every variant change — via a MutationObserver
        per target, plus the widget's normal variant/plan/mode events.
      - Our own writes happen with the observers disconnected and a
        re-entrancy flag set, so we can never hear ourselves; and a write
        budget switches the module off (restoring the theme's text) if some
        theme insists on rewriting the button in response to our write.
      - Every entry point is wrapped in try/catch. A failure leaves the theme
        untouched and can never block add-to-cart: this module never touches
        the form, the submit handler or the cart payload.

     Scope: the widget's own product area. Targets are looked up by walking
     UP from the widget and taking the first ancestor that contains a match,
     so a header cart pill or a cart drawer is normally out of reach by
     construction. The exclusion list below is applied at every level anyway —
     it is what protects the last-resort document-wide lookup, and the case
     where the widget and the theme's button share no ancestor below <body>. */

  /* The elements themes print the add-to-cart price in. The first two entries
     are the client's custom "Sleepify" theme (div.pdp__grey > div.pdp__actions
     > div.action--atc > button.btn.btn--primary.btn--atc); the rest cover
     Dawn / OS 2.0 and the common third-party patterns. A merchant-set
     themeSync.priceSelector replaces this list entirely. */
  var PRICE_SYNC_SELECTORS = [
    '.pdp__actions .btn--atc',
    '.action--atc button',
    'button[name="add"]',
    '.product-form__submit',
    '[data-add-to-cart]',
    '.btn--atc'
  ].join(', ');

  /* The theme's MAIN price display (v1.11.0) — the price under the product
     title, which otherwise keeps quoting the one-time price while the
     subscription is selected: the first entry is the client's Sleepify
     theme (.pdp__price with the current price, the struck compare-at and a
     per-unit line inside), the rest cover Dawn / OS 2.0 and the common
     third-party patterns. Same exact-string swap as the button: the struck
     compare-at and per-unit strings are deliberately NOT touched (they are
     not the one-time money string, and this module never computes money).
     A merchant-set themeSync.mainPriceSelector replaces this list. */
  var PRICE_SYNC_MAIN_SELECTORS = [
    '.pdp__price',
    '.product__price',
    '.price__regular',
    '.product-price',
    '[data-product-price]'
  ].join(', ');

  /* Regions whose buttons are never THIS product's add-to-cart. A candidate
     inside one of these is dropped no matter which lookup found it: a false
     negative here costs nothing (the module simply does nothing), while a
     false positive would rewrite a price in the site header or the cart
     drawer.

     The last two entries are OUR OWN markup. The instance already skips its
     own root, but on a page that somehow carries a second Cellexia widget (a
     dormant app embed alongside the section block) that widget's price copy
     is not this instance's to rewrite either. Everything else on the page —
     including the other cx-namespace vendor's widget — is protected by the
     rule that the target must literally contain the theme's one-time money
     string before a single character is touched. */
  var PRICE_SYNC_EXCLUDED =
    'header, [role="banner"], nav, footer, [role="dialog"], ' +
    '.site-header, .header, .mini-cart, .cart-drawer, cart-drawer, ' +
    '[data-cart-drawer], #cart-drawer, ' +
    '.cx-buybox[data-cellexia-buybox], .cx-buybox-embed[data-cellexia-embed], ' +
    '.cx-buybox-satellite[data-cellexia-satellite]';

  var PRICE_SYNC_MAX_TARGETS = 8;
  var PRICE_SYNC_MAX_TEXT_NODES = 200;
  var PRICE_SYNC_MAX_DEPTH = 12;
  /* Runaway guard: a theme that rewrites the button in reaction to our write
     would ping-pong forever. More than this many effective writes inside the
     window switches the module off for good, theme text restored. */
  var PRICE_SYNC_MAX_WRITES = 12;
  var PRICE_SYNC_WINDOW_MS = 2000;

  function priceSyncNow() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  /** Collect every TEXT node under `el` (skipping script/style/template). */
  function priceSyncTextNodes(el, out, depth) {
    if (!el || depth > PRICE_SYNC_MAX_DEPTH) {
      return;
    }
    var children = el.childNodes;
    if (!children) {
      return;
    }
    for (var i = 0; i < children.length; i++) {
      if (out.length >= PRICE_SYNC_MAX_TEXT_NODES) {
        return;
      }
      var child = children[i];
      if (child.nodeType === 3) {
        out.push(child);
      } else if (child.nodeType === 1) {
        var tag = child.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') {
          continue;
        }
        priceSyncTextNodes(child, out, depth + 1);
      }
    }
  }

  /**
   * One widget's price-sync instance.
   *
   * `api` is the widget's own view of itself:
   *   isHidden()        launch-gated / unmounted / detached — same test the
   *                     form write path uses, so display and writes agree
   *   isSubscription()  the shopper's current selection
   *   oneTimeMoney()    the money string the theme printed (JSON island)
   *   subMoney()        the first-order subscription money string, '' when
   *                     the current variant has no allocation
   */
  /**
   * One PER-SURFACE price-sync instance. v1.11.0 runs TWO of these — the
   * add-to-cart button surface and the theme's main price display — as
   * fully independent instances rather than one instance with a combined
   * selector, and each independence is load-bearing:
   *  - resolveTargets() stops at the FIRST ancestor level containing any
   *    match, so a combined selector would let the nearer surface shadow
   *    the farther one (on Dawn-family embeds the wrapper mounts inside
   *    the /cart/add form, whose button would end the walk before the
   *    out-of-form price block is ever reachable — and vice versa for
   *    placements near the price block);
   *  - the permanent kill switch (`dead`) must only take down ITS OWN
   *    surface: a merchant-typed main-price selector that fails to parse
   *    must not silently disable the button sync that was working;
   *  - the records/write-budget bookkeeping stays per surface, so one
   *    noisy surface cannot evict the other from the target cap.
   *
   * `selectorOverride` selects the surface: absent = the add-to-cart
   * surface with its pre-v1.11.0 semantics byte-for-byte (config flag
   * data-cellexia-price-sync, merchant data-cellexia-price-selector, built-in button
   * list); present = the caller resolved the surface's selector itself and
   * the instance starts alive.
   */
  function createPriceSync(root, api, selectorOverride) {
    var custom = (root.getAttribute('data-cellexia-price-selector') || '').replace(
      /^\s+|\s+$/g,
      ''
    );
    var selector = selectorOverride || custom || PRICE_SYNC_SELECTORS;
    /* Off by config, and the permanent kill switch for anything that goes
       wrong later (invalid selector, runaway theme, thrown exception). */
    var dead = selectorOverride
      ? false
      : root.getAttribute('data-cellexia-price-sync') !== 'true';
    var targets = [];
    var observers = [];
    /* { node, original, written } for every text node we rewrote. */
    var records = [];
    var writing = false;
    var scheduled = false;
    var appliedFrom = null;
    var appliedTo = null;
    var wrote = 0;
    var writes = 0;
    var windowStart = 0;

    function excluded(el) {
      try {
        return !!(el.closest && el.closest(PRICE_SYNC_EXCLUDED));
      } catch (err) {
        return false;
      }
    }

    function queryIn(scope) {
      var found = [];
      var list;
      try {
        list = scope.querySelectorAll(selector);
      } catch (err) {
        /* An invalid merchant selector must not throw at the theme. */
        dead = true;
        return found;
      }
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        /* Never our own markup — the widget prints prices too. */
        if (el === root || root.contains(el) || excluded(el)) {
          continue;
        }
        found.push(el);
        if (found.length >= PRICE_SYNC_MAX_TARGETS) {
          break;
        }
      }
      return found;
    }

    function resolveTargets() {
      var node = root.parentNode;
      while (node && node.nodeType === 1 && node !== document.body) {
        var found = queryIn(node);
        if (dead) {
          return [];
        }
        if (found.length) {
          return found;
        }
        node = node.parentNode;
      }
      /* Widget and button share no ancestor below <body> (or the widget is
         detached): fall back to the document, minus the excluded regions. */
      return queryIn(document);
    }

    /**
     * Forget records that no longer describe reality: the node left the page,
     * or the theme rewrote it since we wrote it. In both cases our "what it
     * said before" is worthless, and the theme's newest text is what the next
     * swap must start from.
     */
    function dropStaleRecords() {
      var kept = [];
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (
          inDocument(record.node) &&
          record.node.nodeValue === record.written
        ) {
          kept.push(record);
        }
      }
      records = kept;
      return records.length;
    }

    function revertAll() {
      dropStaleRecords();
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.node.nodeValue !== record.original) {
          record.node.nodeValue = record.original;
          wrote += 1;
        }
      }
      records = [];
      appliedFrom = null;
      appliedTo = null;
    }

    function applySwap(from, to) {
      var swapped = false;
      for (var i = 0; i < targets.length; i++) {
        var nodes = [];
        priceSyncTextNodes(targets[i], nodes, 0);
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          var value = node.nodeValue;
          if (!value || value.indexOf(from) === -1) {
            continue;
          }
          var next = value.split(from).join(to);
          if (next === value) {
            continue;
          }
          records.push({ node: node, original: value, written: next });
          node.nodeValue = next;
          wrote += 1;
          swapped = true;
        }
      }
      if (swapped) {
        appliedFrom = from;
        appliedTo = to;
      }
    }

    function overBudget() {
      var now = priceSyncNow();
      if (now - windowStart > PRICE_SYNC_WINDOW_MS) {
        windowStart = now;
        writes = 0;
      }
      writes += 1;
      return writes > PRICE_SYNC_MAX_WRITES;
    }

    function disconnect() {
      for (var i = 0; i < observers.length; i++) {
        try {
          observers[i].disconnect();
        } catch (err) {
          /* ignore */
        }
      }
      observers = [];
    }

    function connect() {
      disconnect();
      if (dead || typeof window.MutationObserver !== 'function') {
        return;
      }
      for (var i = 0; i < targets.length; i++) {
        try {
          var observer = new window.MutationObserver(onThemeMutation);
          observer.observe(targets[i], {
            childList: true,
            characterData: true,
            subtree: true
          });
          observers.push(observer);
        } catch (err) {
          /* one unobservable target must not cost the others */
        }
      }
    }

    function onThemeMutation() {
      /* Our writes run with the observers disconnected and `writing` set, so
         anything heard here is the THEME rewriting its button (Sleepify does
         exactly that on every variant change). Coalesce bursts to one pass. */
      if (writing || dead || scheduled) {
        return;
      }
      scheduled = true;
      window.setTimeout(function () {
        scheduled = false;
        sync();
      }, 0);
    }

    /** Run `fn` as OUR write: observers off, re-entrancy flag on, budgeted. */
    function write(fn) {
      wrote = 0;
      writing = true;
      disconnect();
      try {
        fn();
      } finally {
        writing = false;
      }
      if (wrote > 0 && overBudget()) {
        dead = true;
        writing = true;
        try {
          revertAll();
        } catch (err) {
          /* nothing more we can safely do */
        } finally {
          writing = false;
        }
        disconnect();
      }
    }

    function sync() {
      if (dead) {
        return;
      }
      try {
        if (api.isHidden()) {
          /* Launch-gated, unmounted embed, or a detached ghost: the shopper
             cannot see our price, so the theme must show its own. */
          write(revertAll);
          disconnect();
          return;
        }
        var from = api.oneTimeMoney();
        var to = api.subMoney();
        var want = api.isSubscription() && !!from && !!to && from !== to;

        targets = resolveTargets();
        if (dead || !targets.length) {
          write(revertAll);
          disconnect();
          return;
        }
        var recordsBefore = records.length;
        var recordsKept = dropStaleRecords();
        if (
          want &&
          from === appliedFrom &&
          to === appliedTo &&
          recordsKept > 0 &&
          recordsKept === recordsBefore
        ) {
          /* Already showing exactly this and NOTHING was touched. The count
             comparison is load-bearing: "some record survived" is not
             enough once a surface spans several nodes — a theme rewriting
             ONE of them (a currency app, a per-unit refresh) must fall
             through to the full re-apply below, or that node stays showing
             the theme's one-time text while the rest show ours. */
          connect();
          return;
        }
        write(function () {
          revertAll();
          if (want) {
            applySwap(from, to);
          }
        });
        connect();
      } catch (err) {
        /* Whatever happened, the theme gets its own text back and we stop. */
        dead = true;
        try {
          writing = true;
          revertAll();
        } catch (inner) {
          /* ignore */
        } finally {
          writing = false;
        }
        disconnect();
      }
    }

    return { sync: sync };
  }

  function collectForms(scope) {
    if (!scope) {
      return [];
    }
    var all = Array.prototype.slice.call(
      scope.querySelectorAll('form[action*="/cart/add"]')
    );
    /* Prefer real add-to-cart forms (with a variant id AND a submit control) —
       this skips Shop Pay installment forms, which also post to /cart/add. */
    var withId = all.filter(function (form) {
      return form.querySelector('[name="id"]');
    });
    var withSubmit = withId.filter(function (form) {
      return form.querySelector(
        'button[type="submit"], input[type="submit"], button[name="add"], [name="add"]'
      );
    });
    if (withSubmit.length) {
      return withSubmit;
    }
    if (withId.length) {
      return withId;
    }
    return all;
  }

  /**
   * Ownership test for a /cart/add form: does it belong to OUR product?
   *
   *  'own'     — its [name="id"] holds one of our variant ids.
   *  'unknown' — it carries no variant id yet (the theme fills it in later);
   *              ownership can neither be proven nor disproven.
   *  'token'   — its [name="id"] holds a NON-NUMERIC value: not a plausible
   *              Shopify variant id at all, but a theme's own placeholder
   *              token. Inconclusive, like 'unknown' — but kept distinct so
   *              a document-wide search (which must PROVE ownership) never
   *              binds it, while the in-section fallback (where the block's
   *              placement itself vouches for the form) still may.
   *  'foreign' — its [name="id"] holds a digits-only value that is not in
   *              our variants island: another product's variant id. This is
   *              CONCLUSIVE — a numeric id either is ours or it is not.
   *
   * A PDP routinely carries other products' add-to-cart forms (quick-add cards
   * in a "you may also like" carousel, cross-sell blocks, a cart-drawer quick
   * add), and on themes with no product form at all they are the ONLY forms on
   * the page. Writing our selling_plan into one of them makes Shopify reject
   * that other product's add-to-cart with a 422 — so the write path applies
   * the same identity check the read path (initialVariantId /
   * onVariantMaybeChanged) and buy-box-embed.js's request patcher already do.
   */
  function formOwnership(form, variants) {
    var idInput = form.querySelector('[name="id"]');
    if (!idInput) {
      return 'unknown';
    }
    var value = idInput.value == null ? '' : String(idInput.value);
    if (value === '') {
      return 'unknown';
    }
    if (Object.prototype.hasOwnProperty.call(variants, value)) {
      return 'own';
    }
    return /^\d+$/.test(value) ? 'foreign' : 'token';
  }

  /**
   * First provably-ours form, else the first one carrying no id at all.
   * 'token' forms are NOT picked here: this helper also serves the
   * document-wide search, where a theme token proves nothing — the in-section
   * fallback below decides for itself whether placement vouches for one.
   */
  function pickOwnedForm(forms, variants) {
    var undecided = null;
    for (var i = 0; i < forms.length; i++) {
      var verdict = formOwnership(forms[i], variants);
      if (verdict === 'own') {
        return forms[i];
      }
      if (verdict === 'unknown' && !undecided) {
        undecided = forms[i];
      }
    }
    return undecided;
  }

  function findProductForm(root, variants) {
    var sectionId = root.getAttribute('data-section-id');
    var scope = null;
    if (sectionId) {
      scope = document.getElementById('shopify-section-' + sectionId);
    }
    if (!scope) {
      scope = root.closest('.shopify-section');
    }
    var scoped = collectForms(scope);
    if (scoped.length) {
      var owned = pickOwnedForm(scoped, variants);
      if (owned) {
        return owned;
      }
      /* No provable-or-idless form in the block's own section. The placement
         proof ("the app block renders in the product section") only covers
         the INCONCLUSIVE case — a theme that stores a non-variant token in
         [name="id"] ('token') — so that form is still adopted, unchanged
         behaviour for the themes this fallback existed for. A form whose
         [name="id"] holds a NUMERIC id not in our island is a different
         animal: PROVABLY another product's (a cross-sell / complementary-
         products quick-add can be the only form in the section when the main
         add-to-cart is JS-driven), and writing our selling_plan into it gets
         that product's add-to-cart 422-rejected by Shopify. Conclusively
         foreign everywhere means bind to nothing — the same "prove ownership
         or bind to nothing" rule as the document-wide path below, and
         formless themes are already carried by buy-box-embed.js's request
         patcher. */
      for (var i = 0; i < scoped.length; i++) {
        if (formOwnership(scoped[i], variants) === 'token') {
          return scoped[i];
        }
      }
      return null;
    }
    /* No section to scope to — the app embed boots at body end, outside any
       .shopify-section. A document-wide search must therefore PROVE ownership;
       binding to nothing is the correct outcome on formless AJAX themes like
       Sleepify, where buy-box-embed.js patches the /cart/add(.js) request
       itself and carries the selling plan there. */
    return pickOwnedForm(collectForms(document), variants);
  }

  /**
   * True for an app-embed widget that must stay DORMANT: the section app
   * block also rendered a widget on this page and the block wins (never two
   * widgets — and, more importantly, never two writers on the theme's form,
   * where the last writer's plan id would silently beat the visible widget's
   * selection). Same test buy-box-embed.js implements as sectionWidgetPresent.
   */
  function embedSuppressed(root) {
    if (!root.closest || !root.closest(OWN_WRAPPER)) {
      return false;
    }
    var widgets = document.querySelectorAll(OWN_WIDGET);
    for (var i = 0; i < widgets.length; i++) {
      if (!widgets[i].closest(OWN_WRAPPER)) {
        return true;
      }
    }
    return false;
  }

  /**
   * "Is this node one of OUR widget roots?" — asserted before init() writes
   * anything onto it. Every caller already selects with OWN_WIDGET; this is
   * the second net at the point of mutation, so no future selector change can
   * make us stamp attributes onto another vendor's element (see the ownership
   * block at the top of this file).
   */
  function isOwnWidget(node) {
    if (!node) {
      return false;
    }
    try {
      if (node.classList && typeof node.classList.contains === 'function') {
        return node.classList.contains('cx-buybox');
      }
      var names = typeof node.className === 'string' ? node.className : '';
      return (' ' + names + ' ').indexOf(' cx-buybox ') !== -1;
    } catch (err) {
      return false;
    }
  }

  function init(root) {
    if (!isOwnWidget(root)) {
      return; /* not ours — never touch it */
    }
    if (root.getAttribute('data-cellexia-init') === 'true') {
      return;
    }
    if (embedSuppressed(root)) {
      /* Deliberately NOT marked initialised: if the section block disappears
         (theme editor), a later boot can still let the embed take over. */
      return;
    }
    root.setAttribute('data-cellexia-init', 'true');

    var dataEl = root.querySelector('script[data-cellexia-data]');
    var data = null;
    try {
      data = dataEl ? JSON.parse(dataEl.textContent) : null;
    } catch (err) {
      data = null;
    }
    if (!data || !data.variants) {
      return;
    }

    function qa(selector) {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    }

    var preset = root.getAttribute('data-cellexia-preset') || 'classic';
    /* Identity-checked against the JSON island: we never write into another
       product's form (see formOwnership). null is a valid outcome. */
    var form = findProductForm(root, data.variants);
    var radios = qa('input[data-cellexia-option]');
    var tabs = qa('[data-cellexia-tab]');
    var tablists = qa('[role="tablist"]');
    var panels = qa('[data-cellexia-panel]');
    var wraps = qa('[data-cellexia-option-wrap]');
    var inlineBox = root.querySelector('[data-cellexia-inline]');
    var freqSelect = root.querySelector('[data-cellexia-freq]');
    var freqChips = qa('[data-cellexia-freq-chip]');
    /* Stable data-cellexia-* hooks — every preset uses these (possibly several
       nodes each), never preset-specific classes. */
    var els = {
      subPrice: qa('[data-cellexia-sub-price]'),
      firstLabel: qa('[data-cellexia-first-label]'),
      then: qa('[data-cellexia-then]'),
      save: qa('[data-cellexia-save]'),
      saveRow: qa('[data-cellexia-save-row]'),
      perDelivery: qa('[data-cellexia-per-delivery]'),
      oneTime: qa('[data-cellexia-onetime-price]'),
      pdPrice: qa('[data-cellexia-pd-price]'),
      tpl: qa('[data-cellexia-tpl]')
    };

    function initialVariantId() {
      if (form) {
        var idInput = form.querySelector('[name="id"]');
        if (idInput && idInput.value && data.variants[String(idInput.value)]) {
          return String(idInput.value);
        }
      }
      var fromUrl = variantIdFromUrl();
      if (fromUrl && data.variants[fromUrl]) {
        return fromUrl;
      }
      return String(data.initialVariant);
    }

    function initialMode() {
      if (data.requiresSellingPlan) {
        return 'subscription';
      }
      for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) {
          return radios[i].value;
        }
      }
      if (inlineBox) {
        return inlineBox.checked ? 'subscription' : 'one_time';
      }
      for (var j = 0; j < tabs.length; j++) {
        if (tabs[j].getAttribute('aria-selected') === 'true') {
          return tabs[j].getAttribute('data-cellexia-tab');
        }
      }
      return data.preselect ? 'subscription' : 'one_time';
    }

    function initialPlanId() {
      if (freqSelect && freqSelect.value) {
        return String(freqSelect.value);
      }
      for (var i = 0; i < freqChips.length; i++) {
        if (freqChips[i].checked) {
          return String(freqChips[i].value);
        }
      }
      return String(data.initialPlan || '');
    }

    var state = {
      variantId: initialVariantId(),
      planId: initialPlanId(),
      mode: initialMode()
    };

    /* ── Per-variant default frequency (v1.14.0) ─────────────────────────────
       The island's per-variant `defaultPlan` (override, else the folded plan
       default). A variant switch adopts it — but never over the shopper's
       own explicit cadence pick, which is sticky for the widget's life. */
    var planExplicit = false;

    /** The variant's default plan id, only if the variant can buy it. */
    function variantDefaultPlanId(variantId) {
      var v = data.variants[String(variantId)];
      if (!v || !v.defaultPlan) {
        return '';
      }
      var dp = String(v.defaultPlan);
      return v.plans && v.plans[dp] ? dp : '';
    }

    function maybeAdoptVariantDefault(variantId) {
      if (planExplicit) {
        return;
      }
      var dp = variantDefaultPlanId(variantId);
      if (dp && dp !== String(state.planId)) {
        state.planId = dp;
        syncFreqControls();
      }
    }

    /* The server preselected the default for the variant IT rendered; if the
       theme's field already points elsewhere at init, adopt THAT variant's
       default — nothing chosen yet. Before the initial render/apply below. */
    if (String(state.variantId) !== String(data.initialVariant)) {
      maybeAdoptVariantDefault(state.variantId);
    }

    function currentVariant() {
      return (
        data.variants[String(state.variantId)] ||
        data.variants[String(data.initialVariant)] ||
        null
      );
    }

    function currentPlan() {
      var variant = currentVariant();
      if (!variant || !variant.plans) {
        return null;
      }
      return variant.plans[state.planId] || null;
    }

    /**
     * Does the CURRENT variant carry any subscription allocation at all?
     * Distinct from currentPlan(): a variant can lack the SELECTED cadence
     * while offering others (render() falls back to its first plan), but a
     * variant with an empty/absent plans map has no subscription to sell —
     * the --no-sub state.
     */
    function variantHasAnyPlan() {
      var variant = currentVariant();
      if (!variant || !variant.plans) {
        return false;
      }
      for (var planKey in variant.plans) {
        if (Object.prototype.hasOwnProperty.call(variant.plans, planKey)) {
          return true;
        }
      }
      return false;
    }

    /**
     * The launch gate is a WRITE gate, not just a visual one.
     *
     * While this widget is hidden — [data-cellexia-gated][hidden] before go-live,
     * or inside an app-embed wrapper that has not been mounted — the shopper
     * cannot see a purchase option, so nothing may reach the theme's form.
     * Without this test a setup-mode shop (the state of EVERY shop the moment
     * the ZIP is installed) would inject the preselected selling_plan into a
     * Dawn-family product form and turn any Add to cart into a subscription,
     * invisibly. Same test getState() uses, so reads and writes agree.
     *
     * A DETACHED root counts as hidden too: after a section re-render this
     * widget object is still alive in memory but its markup is gone from the
     * page, and a ghost that keeps writing into (or answering for) the live
     * form is the same defect wearing a different hat.
     */
    function widgetHidden() {
      if (!inDocument(root)) {
        return true;
      }
      try {
        return !!root.closest('[hidden]');
      } catch (err) {
        return false; /* no closest() → treat as visible, as before */
      }
    }

    /* Theme price sync — see the module above. Reads the money strings from
       the JSON island (the same values the widget itself displays), falling
       back to the server-rendered root attributes for the initial
       variant/plan. Both are Liquid-formatted with the shop's money_format,
       so they are byte-identical to what the theme printed. */
    var priceSyncApi = {
      isHidden: function () {
        return widgetHidden();
      },
      isSubscription: function () {
        return state.mode === 'subscription';
      },
      oneTimeMoney: function () {
        var variant = currentVariant();
        if (variant && variant.oneTime) {
          return variant.oneTime;
        }
        return root.getAttribute('data-cellexia-money-onetime') || '';
      },
      subMoney: function () {
        var variant = currentVariant();
        if (variant) {
          /* The island is authoritative for a variant it knows: no plan
             means no subscription price to promise for it. */
          var plan = variant.plans ? variant.plans[state.planId] : null;
          return plan && plan.first ? plan.first : '';
        }
        return root.getAttribute('data-cellexia-money-sub') || '';
      }
    };
    /* Two INDEPENDENT surfaces (see createPriceSync's header for why they
       must not share a selector, a walk, records or a kill switch): the
       add-to-cart button (pre-v1.11.0 semantics, internal flag), and the
       theme's main price display (v1.11.0, its own flag + selector; absent
       attributes on pre-v1.11.0 cached markup keep it off). */
    var priceSyncs = [createPriceSync(root, priceSyncApi)];
    if (root.getAttribute('data-cellexia-price-sync-main') === 'true') {
      var customMain = (
        root.getAttribute('data-cellexia-main-selector') || ''
      ).replace(/^\s+|\s+$/g, '');
      priceSyncs.push(
        createPriceSync(root, priceSyncApi, customMain || PRICE_SYNC_MAIN_SELECTORS)
      );
    }

    /* ── subscription_ultra_max satellite (v1.11.0) ──────────────────────────
       The preset's quiet one-time line must sit ALL THE WAY UNDER the
       theme's buy area — below quantity, Add to cart and the trust content
       (.pdp__grey on the client's PDP) — not inside the widget. The Liquid
       renders it INSIDE the widget root (so no-JS and launch-gated pages
       are exactly as safe as subscription_max), and this module relocates
       that one element after the theme's buy area while the widget is
       visible. Every radio/wrap/price collection below was taken at init,
       while the satellite was still inside the root, so the existing state
       machine keeps driving it by reference after the move.

       INVARIANTS, each load-bearing:
        - the launch gate is an ANCESTOR [hidden]: outside the root that
          ancestry is gone, so the satellite's own hidden attribute mirrors
          widgetHidden() on every sync — a gated/parked/ghost widget never
          leaves a visible one-time line behind;
        - ownership is asserted (isOwnSatellite) before anything is moved
          or removed — the same rule as every other own-markup mutation;
        - a relocated radio must never JOIN the theme's form (it would
          submit a stray cx-purchase field), so its form attribute points
          at a non-existent id whenever a FORM ancestor appears;
        - a theme re-render that destroys the satellite's host brings it
          home (we hold the reference, like the embed's mountedWrapper),
          and a predecessor root's stray satellite is removed at init. */

    function isOwnSatellite(node) {
      if (!node) {
        return false;
      }
      try {
        if (node.classList && typeof node.classList.contains === 'function') {
          return node.classList.contains('cx-buybox-satellite');
        }
        var names = typeof node.className === 'string' ? node.className : '';
        return (' ' + names + ' ').indexOf(' cx-buybox-satellite ') !== -1;
      } catch (err) {
        return false;
      }
    }

    var satellite =
      preset === 'subscription_ultra_max'
        ? root.querySelector(OWN_SATELLITE)
        : null;
    if (satellite && !isOwnSatellite(satellite)) {
      satellite = null;
    }
    /* The group div the satellite came from — its home when no anchor
       exists or the widget hides while detached from its host. */
    var satelliteHome = satellite ? satellite.parentNode : null;

    if (satellite) {
      try {
        /* A predecessor widget for this same block (theme-editor section
           re-render) may have left ITS relocated line in the page. */
        var strays = document.querySelectorAll(OWN_SATELLITE);
        for (var st = 0; st < strays.length; st++) {
          var stray = strays[st];
          if (
            stray !== satellite &&
            isOwnSatellite(stray) &&
            !root.contains(stray) &&
            stray.getAttribute('data-cellexia-for') ===
              root.getAttribute('data-block-id') &&
            stray.parentNode
          ) {
            stray.parentNode.removeChild(stray);
          }
        }
      } catch (err) {
        /* stray cleanup is a nicety — never break init over it */
      }
    }

    /**
     * The element the satellite lands AFTER: the theme's whole buy area.
     * Walk UP from the widget and take the first .pdp__grey an ancestor
     * contains (the client's PDP: quantity + Add to cart + badges +
     * guarantee + reviews), else the bound /cart/add form (generic themes:
     * the form ends with the buy buttons), else nothing — the line simply
     * stays where the Liquid put it, which is the subscription_max layout.
     */
    function satelliteAnchor() {
      var node = root.parentNode;
      while (node && node.nodeType === 1 && node !== document.body) {
        var grey = null;
        try {
          grey = node.querySelector('.pdp__grey');
        } catch (err) {
          grey = null;
        }
        if (grey && !grey.contains(root) && grey.parentNode) {
          return grey;
        }
        node = node.parentNode;
      }
      if (form && inDocument(form) && form.parentNode && !form.contains(root)) {
        return form;
      }
      return null;
    }

    /** Keep the relocated radio out of any THEME form's radio group. */
    function syncSatelliteFormOwner() {
      var inForm = false;
      var walk = satellite.parentNode;
      while (walk && walk.nodeType === 1) {
        if (walk.nodeName === 'FORM') {
          inForm = true;
          break;
        }
        walk = walk.parentNode;
      }
      var inputs = satellite.querySelectorAll('input');
      for (var ii = 0; ii < inputs.length; ii++) {
        if (inForm) {
          inputs[ii].setAttribute('form', 'cx-no-form-' + preset);
        } else {
          inputs[ii].removeAttribute('form');
        }
      }
    }

    function syncSatellite() {
      if (!satellite || !isOwnSatellite(satellite)) {
        return;
      }
      try {
        if (!inDocument(root)) {
          /* Ghost: the widget's markup was replaced. Its satellite must not
             survive it — the successor renders (and mounts) its own. */
          if (inDocument(satellite) && satellite.parentNode) {
            satellite.parentNode.removeChild(satellite);
          }
          return;
        }
        var hidden = widgetHidden();
        if (hidden) {
          satellite.setAttribute('hidden', 'hidden');
        } else {
          satellite.removeAttribute('hidden');
        }
        if (!inDocument(satellite)) {
          /* The theme re-rendered the area the satellite lived in: bring it
             home first, so it is never lost, then (below) re-mount. */
          if (satelliteHome && inDocument(satelliteHome)) {
            satelliteHome.appendChild(satellite);
          } else {
            root.appendChild(satellite);
          }
        }
        if (!hidden && root.contains(satellite)) {
          var anchor = satelliteAnchor();
          if (
            anchor &&
            anchor.parentNode &&
            !satellite.contains(anchor) &&
            anchor !== satellite
          ) {
            anchor.parentNode.insertBefore(satellite, anchor.nextSibling);
          }
        }
        syncSatelliteFormOwner();
      } catch (err) {
        /* placement is presentation — never break the widget over it */
      }
    }

    /** Never let a display concern break the widget. */
    function syncThemePrice() {
      for (var ps = 0; ps < priceSyncs.length; ps++) {
        try {
          priceSyncs[ps].sync();
        } catch (err) {
          /* the module already fails closed; this is the outer belt —
             and one surface's failure must not cost the other its sync */
        }
      }
      try {
        syncSatellite();
      } catch (err) {
        /* same rule for the ultra_max satellite */
      }
    }

    /**
     * Undo everything this widget wrote into the theme's form. Called when it
     * turns out to be hidden (gate still closed, embed unmounted, a section
     * re-render in the theme editor): an input we created is removed, an
     * input we adopted from the theme is emptied, the design property is
     * disabled. The form is left exactly as a widget-less page would have it.
     */
    function releaseForm() {
      if (!form) {
        return;
      }
      if (!inDocument(root) && inDocument(form)) {
        /* A GHOST (this widget's markup was replaced) must not reach into a
           form that is still on the page: its successor owns that input now,
           and clearing it here would drop a plan the shopper can see. */
        return;
      }
      var input = form.querySelector('input[data-cellexia-plan-input]');
      if (input) {
        if (
          input.getAttribute('data-cellexia-plan-input') === 'own' &&
          input.parentNode
        ) {
          input.parentNode.removeChild(input);
        } else if (input.value !== '') {
          input.value = '';
        }
      }
      var prop = form.querySelector('input[data-cellexia-design-prop]');
      if (prop) {
        prop.disabled = true;
        prop.value = '';
      }
    }

    /**
     * The ONE field in the theme's form that carries name="selling_plan".
     * Prefers the field we already own or adopted, otherwise the LAST
     * pre-existing one (the cart honours the last duplicate, so that is the
     * field that actually decides), otherwise creates ours.
     *
     * Any OTHER selling_plan field carrying our own data-cellexia-selling-plan hook
     * loses its name. That is the widget's server-rendered mirror, which the
     * app embed can carry into this very form when it mounts; the shipped
     * Liquid renders it nameless, and this is the belt-and-braces version of
     * the same rule for a stale cached copy of the markup. Two named fields
     * would mean the shopper's "One-time" click updates one of them while the
     * cart reads the other.
     */
    function sellingPlanField() {
      var fields = form.querySelectorAll(
        'input[name="selling_plan"], select[name="selling_plan"]'
      );
      var field = null;
      for (var i = 0; i < fields.length; i++) {
        field = fields[i];
        if (field.hasAttribute('data-cellexia-plan-input')) {
          break;
        }
      }
      if (field && !field.hasAttribute('data-cellexia-plan-input')) {
        field.setAttribute('data-cellexia-plan-input', 'adopted');
      }
      if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'selling_plan';
        field.setAttribute('data-cellexia-plan-input', 'own');
        form.appendChild(field);
      }
      for (var j = 0; j < fields.length; j++) {
        if (fields[j] !== field && fields[j].hasAttribute('data-cellexia-selling-plan')) {
          fields[j].removeAttribute('name');
        }
      }
      return field;
    }

    /* Hidden line property stamping the active design on subscription
       add-to-carts (read by the ORDERS_CREATE webhook for take-rate-by-
       design analytics). Disabled — not submitted — for one-time carts. */
    function applyDesignProp(subscriptionSelected) {
      if (!form || widgetHidden()) {
        return;
      }
      var prop = form.querySelector('input[data-cellexia-design-prop]');
      if (subscriptionSelected) {
        if (!prop) {
          prop = document.createElement('input');
          prop.type = 'hidden';
          prop.name = 'properties[_cellexia_design]';
          prop.setAttribute('data-cellexia-design-prop', '');
          form.appendChild(prop);
        }
        prop.disabled = false;
        if (prop.value !== preset) {
          prop.value = preset;
        }
      } else if (prop) {
        prop.disabled = true;
        prop.value = '';
      }
    }

    function applySellingPlan(force) {
      if (!form) {
        return;
      }
      if (widgetHidden()) {
        /* Launch-gated or unmounted: write nothing, and take back anything
           written while this widget was still visible. Revealing it later
           (validated preview token, embed mount) re-runs this through
           CellexiaSubs.resync(). */
        releaseForm();
        return;
      }
      var input = sellingPlanField();
      var next =
        state.mode === 'subscription' && currentPlan()
          ? String(state.planId)
          : '';
      applyDesignProp(next !== '');
      if (force || input.value !== next) {
        input.value = next;
        try {
          input.dispatchEvent(new Event('change', { bubbles: true }));
          root.dispatchEvent(
            new CustomEvent('cx:buybox:change', {
              bubbles: true,
              detail: {
                variantId: state.variantId,
                sellingPlanId: next || null,
                mode: state.mode,
                design: preset
              }
            })
          );
        } catch (err) {
          /* display/analytics only — never break add-to-cart */
        }
      }
    }

    function setMode(mode) {
      if (
        mode === 'subscription' &&
        !data.requiresSellingPlan &&
        !variantHasAnyPlan()
      ) {
        /* The current variant has no subscription allocation (--no-sub):
           there is no plan this mode could put in the cart, and render()
           would immediately force one_time again anyway. Refusing here keeps
           every entry point honest — in particular the hidden subscription
           radio, which a stray label activation (subscription_max's
           switch-back line before CSS hides it, or a theme script) can still
           fire while the subscription card is display:none. Without this,
           the widget lands in a state where NOTHING appears selected while
           the cart would get a one-time line. Mirrors the render() fallback;
           requires_selling_plan products keep their subscription-only
           posture untouched. */
        mode = 'one_time';
      }
      state.mode = mode;
      radios.forEach(function (radio) {
        var on = radio.value === mode;
        if (radio.checked !== on) {
          radio.checked = on;
        }
        radio.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      wraps.forEach(function (wrap) {
        wrap.classList.toggle(
          'is-selected',
          wrap.getAttribute('data-cellexia-option-wrap') === mode
        );
      });
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-cellexia-tab') === mode;
        tab.classList.toggle('is-selected', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          tab.removeAttribute('tabindex');
        } else {
          tab.setAttribute('tabindex', '-1');
        }
      });
      panels.forEach(function (panel) {
        if (panel.getAttribute('data-cellexia-panel') === mode) {
          panel.removeAttribute('hidden');
        } else {
          panel.setAttribute('hidden', 'hidden');
        }
      });
      if (inlineBox) {
        var boxOn = mode === 'subscription';
        if (inlineBox.checked !== boxOn) {
          inlineBox.checked = boxOn;
        }
      }
      applySellingPlan(false);
      syncThemePrice();
    }

    function syncFreqControls() {
      if (freqSelect && freqSelect.value !== state.planId) {
        freqSelect.value = state.planId;
      }
      freqChips.forEach(function (chip) {
        var on = String(chip.value) === state.planId;
        if (chip.checked !== on) {
          chip.checked = on;
        }
      });
    }

    function render() {
      var variant = currentVariant();
      if (!variant) {
        return;
      }
      var plan = variant.plans ? variant.plans[state.planId] : null;
      /* True when the line below MOVED the selection: the form has to follow,
         or the widget shows a highlighted cadence while the cart gets a
         one-time line (see the applySellingPlan call at the end). */
      var planFellBack = false;
      if (!plan && variant.plans) {
        /* Selected frequency has no allocation on this variant — fall back
           to the variant's default (v1.14.0: the selection is unhonorable
           either way, and the merchant's default beats allocation order),
           else its first plan, so subscription stays offerable. Reachable
           from the UI too: the chips/dropdown list EVERY group plan, while
           a variant only carries the cadences it has an allocation for. */
        var ids = Object.keys(variant.plans);
        if (ids.length) {
          state.planId = variantDefaultPlanId(state.variantId) || ids[0];
          syncFreqControls();
          plan = variant.plans[state.planId];
          planFellBack = true;
        }
      }
      var subAvailable = !!plan;
      root.classList.toggle('cx-buybox--no-sub', !subAvailable);
      if (satellite) {
        try {
          /* The relocated satellite has no .cx-buybox--no-sub ancestor out
             there, so it carries its own copy of the state class (the CSS
             hides its switch-back label on a no-sub variant off this). */
          satellite.classList.toggle('cx-buybox--no-sub', !subAvailable);
        } catch (err) {
          /* class toggle is presentation — never break a repaint */
        }
      }

      els.oneTime.forEach(function (el) {
        el.textContent = variant.oneTime;
      });

      /* Re-resolve {percent}/{amount}/{frequency} templates (tab labels,
         inline label, "or buy once for {amount}", firstOrderLine, …).
         Savings nodes are handled below so they can hide when empty. */
      var vals = {
        percent: plan && plan.savePct ? plan.savePct : '',
        amount: variant.oneTime || '',
        frequency: plan && plan.freq ? plan.freq : ''
      };
      els.tpl.forEach(function (el) {
        if (el.hasAttribute('data-cellexia-save')) {
          return;
        }
        var resolved = resolveTpl(el.getAttribute('data-cellexia-tpl'), vals);
        if (el.textContent !== resolved) {
          el.textContent = resolved;
        }
      });

      if (subAvailable) {
        /* Strike-through compare: exact via the island's cents when present
           (a one-time price NOT above the subscription price earns no
           strike), string inequality as the pre-matrix fallback inside
           setPrice(). */
        var compareText = variant.oneTime || null;
        if (
          typeof variant.oneTimeCents === 'number' &&
          typeof plan.firstCents === 'number' &&
          variant.oneTimeCents <= plan.firstCents
        ) {
          compareText = null;
        }
        els.subPrice.forEach(function (el) {
          setPrice(
            el,
            plan.first,
            el.hasAttribute('data-cellexia-compare') ? compareText : null
          );
        });
        els.pdPrice.forEach(function (el) {
          el.textContent = plan.pd || plan.first;
        });
        els.then.forEach(function (el) {
          setText(el, plan.then);
        });
        els.save.forEach(function (el) {
          if (el.hasAttribute('data-cellexia-tpl')) {
            /* Custom savingsTemplate: resolve it, but only while there is a
               real saving to claim. */
            setText(
              el,
              plan.save ? resolveTpl(el.getAttribute('data-cellexia-tpl'), vals) : ''
            );
          } else {
            setText(el, plan.save);
          }
        });
        els.saveRow.forEach(function (row) {
          if (plan.save) {
            row.removeAttribute('hidden');
          } else {
            row.setAttribute('hidden', 'hidden');
          }
        });
        els.perDelivery.forEach(function (el) {
          setText(el, plan.perDelivery);
        });
        els.firstLabel.forEach(function (el) {
          if (plan.then) {
            el.removeAttribute('hidden');
          } else {
            el.setAttribute('hidden', 'hidden');
          }
        });
        if (planFellBack) {
          /* render() is authoritative about the plan it settled on. Callers
             that write the form BEFORE painting (onPlanChosen, which applies
             the shopper's click, and onVariantMaybeChanged) would otherwise
             leave selling_plan empty — currentPlan() was undefined at the
             moment they ran — while the repainted UI shows a subscription
             with a checked cadence. Force, because the value we are undoing
             may be the empty string they just wrote. */
          applySellingPlan(true);
        }
      } else if (state.mode === 'subscription' && !data.requiresSellingPlan) {
        setMode('one_time');
      }
      /* Re-anchor the theme add-to-cart price-sync pair on what was just
         painted. The island is the sync's primary source, but the root
         attributes are its server-rendered fallback and the pair external
         readers see — left stale they re-freeze the theme's button on the
         landing variant, which is half of the live v1.6.8 bug. */
      try {
        root.setAttribute('data-cellexia-money-onetime', variant.oneTime || '');
        root.setAttribute(
          'data-cellexia-money-sub',
          plan && plan.first ? plan.first : ''
        );
      } catch (err) {
        /* attribute write is a nicety — the island still carries the pair */
      }
      /* The variant/plan the widget just painted is also the pair the theme's
         add-to-cart button has to quote. */
      syncThemePrice();
    }

    function onVariantMaybeChanged(nextId) {
      if (!nextId) {
        return;
      }
      nextId = String(nextId);
      if (nextId === String(state.variantId) || !data.variants[nextId]) {
        return;
      }
      state.variantId = nextId;
      /* Before the paint, so render() prices the default it is adopting. */
      maybeAdoptVariantDefault(nextId);
      render();
      /* Force: some themes rebuild form internals on variant change and drop
         our hidden input's value in the process. */
      applySellingPlan(true);
    }

    function onPlanChosen(planId) {
      /* A real cadence click — variant defaults stop moving the selection. */
      planExplicit = true;
      state.planId = String(planId);
      if (state.mode !== 'subscription') {
        /* Choosing a delivery frequency implies wanting the subscription. */
        setMode('subscription');
      } else {
        applySellingPlan(false);
      }
      render();
    }

    /* ── Global handle: window.CellexiaSubs ──────────────────────────────────
       Consumed by buy-box-embed.js (the app embed's mount + cart-request
       patching script) on themes without a reachable /cart/add form.
       getState() returns null while the widget is hidden — launch-gated
       ([data-cellexia-gated][hidden]) or inside the unmounted [hidden] embed
       wrapper — so nothing external ever acts for a widget the visitor
       cannot see. Namespace note: this page may also carry ANOTHER vendor's
       "cx-*" element ids; we only ever share state through this one guarded
       global, never through DOM ids. */
    try {
      var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
      subs.widgets = subs.widgets || [];
      subs.widgets.push({
        /* Used by pruneWidgets(): a widget whose root was destroyed must be
           dropped from the registry, not merely ignored. */
        isConnected: function () {
          return inDocument(root);
        },
        getState: function () {
          if (widgetHidden()) {
            return null;
          }
          var statePlan = currentPlan();
          return {
            mode: state.mode,
            design: preset,
            variantId: String(state.variantId),
            variantIds: Object.keys(data.variants),
            sellingPlanId:
              state.mode === 'subscription' && statePlan
                ? String(state.planId)
                : null
          };
        },
        setVariant: function (variantId) {
          onVariantMaybeChanged(variantId);
        },
        resync: function () {
          /* Re-run the write path. No-op while still hidden (applySellingPlan
             releases the form instead), which is what makes it safe to call
             from anything that MIGHT have revealed a widget. A widget the
             theme editor has replaced is detached from the document and must
             stay out of it entirely — its successor owns the form now. */
          if (!inDocument(root)) {
            return;
          }
          /* The form this widget bound to may itself have been replaced by
             the re-render that moved us — re-bind before writing. */
          ensureForm();
          applySellingPlan(true);
          /* A detach stops the variant poll; a re-insert re-arms it (no-op
             while it is already running). */
          startVariantPoll();
          /* A reveal (validated preview token) or an embed mount is also the
             moment the theme's button becomes ours to keep honest — and a
             re-hide is the moment to give it back. */
          syncThemePrice();
          /* …and the moment to re-read the theme's CURRENT variant with a
             fresh field scan: the page may have moved (or landed on an
             un-synced variant) while this widget was hidden or detached. */
          reReadVariant(true);
        }
      });
      if (!subs.pruneWidgets) {
        /* Drop widgets whose markup is gone (theme-editor section re-render,
           AJAX buy-column swap). Without this, getState() — which returns the
           FIRST non-null answer — keeps serving a destroyed widget's stale
           mode/plan to buy-box-embed.js's cart patcher, because a detached
           root has no [hidden] ancestor and so still looks "visible". */
        subs.pruneWidgets = function () {
          var live = [];
          for (var wp = 0; wp < subs.widgets.length; wp++) {
            var entry = subs.widgets[wp];
            var alive;
            try {
              alive =
                typeof entry.isConnected !== 'function' || entry.isConnected();
            } catch (err) {
              alive = false;
            }
            if (alive) {
              live.push(entry);
            }
          }
          subs.widgets = live;
        };
      }
      /** Prune first, then walk — every consumer below goes through this. */
      var liveWidgets = function () {
        try {
          if (typeof subs.pruneWidgets === 'function') {
            subs.pruneWidgets();
          }
        } catch (err) {
          /* a failed prune must never stop the walk */
        }
        return subs.widgets;
      };
      if (!subs.getState) {
        /* First visible widget wins (there is at most one visible: the
           section block suppresses the embed). */
        subs.getState = function () {
          var widgets = liveWidgets();
          for (var wi = 0; wi < widgets.length; wi++) {
            var widgetState = null;
            try {
              widgetState = widgets[wi].getState();
            } catch (err) {
              widgetState = null;
            }
            if (widgetState) {
              return widgetState;
            }
          }
          return null;
        };
      }
      if (!subs.setVariant) {
        /* Unknown ids are ignored per widget (onVariantMaybeChanged checks
           its own JSON island), so broadcasting is safe. */
        subs.setVariant = function (variantId) {
          var widgets = liveWidgets();
          for (var wj = 0; wj < widgets.length; wj++) {
            try {
              widgets[wj].setVariant(variantId);
            } catch (err) {
              /* never break the page over a variant sync */
            }
          }
        };
      }
      if (!subs.resync) {
        /* Called by anything that can UNHIDE a widget after init: the
           validated-preview reveal here, and the app embed's mount in
           buy-box-embed.js. Hidden widgets stay untouched. */
        subs.resync = function () {
          var widgets = liveWidgets();
          for (var wk = 0; wk < widgets.length; wk++) {
            try {
              widgets[wk].resync();
            } catch (err) {
              /* never break the page over a resync */
            }
          }
        };
      }
    } catch (err) {
      /* the global handle is an embed nicety — never break the widget */
    }

    /* ── Wire up ─────────────────────────────────────────────────────────── */

    radios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) {
          setMode(radio.value);
        }
      });
    });

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        setMode(tab.getAttribute('data-cellexia-tab'));
      });
    });

    /* role=tab keyboard contract: arrows move AND activate (roving tabindex). */
    tablists.forEach(function (list) {
      list.addEventListener('keydown', function (event) {
        var key = event.key;
        if (
          key !== 'ArrowLeft' &&
          key !== 'ArrowRight' &&
          key !== 'Home' &&
          key !== 'End'
        ) {
          return;
        }
        var listTabs = Array.prototype.slice.call(
          list.querySelectorAll('[data-cellexia-tab]')
        );
        if (!listTabs.length) {
          return;
        }
        var current = listTabs.indexOf(document.activeElement);
        if (current === -1) {
          current = 0;
        }
        var next = current;
        if (key === 'ArrowLeft') {
          next = (current - 1 + listTabs.length) % listTabs.length;
        } else if (key === 'ArrowRight') {
          next = (current + 1) % listTabs.length;
        } else if (key === 'Home') {
          next = 0;
        } else {
          next = listTabs.length - 1;
        }
        event.preventDefault();
        listTabs[next].focus();
        setMode(listTabs[next].getAttribute('data-cellexia-tab'));
      });
    });

    if (inlineBox) {
      inlineBox.addEventListener('change', function () {
        if (data.requiresSellingPlan) {
          inlineBox.checked = true;
          return;
        }
        setMode(inlineBox.checked ? 'subscription' : 'one_time');
      });
    }

    if (freqSelect) {
      freqSelect.addEventListener('change', function () {
        onPlanChosen(freqSelect.value);
      });
    }

    freqChips.forEach(function (chip) {
      chip.addEventListener('change', function () {
        if (chip.checked) {
          onPlanChosen(chip.value);
        }
      });
    });

    function onFormChange(event) {
      var target = event.target;
      if (!target || target.name === 'selling_plan') {
        return;
      }
      if (target.name === 'id') {
        onVariantMaybeChanged(target.value);
        return;
      }
      /* Variant pickers often use option radios/selects; the theme updates
         the [name="id"] input right after — re-read it on the next tick. */
      window.setTimeout(function () {
        if (!form) {
          return;
        }
        var idInput = form.querySelector('[name="id"]');
        if (idInput) {
          onVariantMaybeChanged(idInput.value);
        }
      }, 0);
    }

    /* Last-moment safety: guarantee the input (and the _cellexia_design stamp)
       reflects the selection even if a theme script rewrote the form. */
    function onFormSubmit() {
      applySellingPlan(true);
    }

    var wiredForm = null;
    function wireForm() {
      if (!form || wiredForm === form) {
        return;
      }
      wiredForm = form;
      form.addEventListener('change', onFormChange);
      form.addEventListener('submit', onFormSubmit, true);
    }
    wireForm();

    /**
     * Re-bind to the form that is actually on the page.
     *
     * The widget can outlive the form it bound to at init: the app embed
     * MOVES this widget into the product section, so a theme-editor section
     * re-render destroys the form (and every listener on it) while the
     * wrapper — re-inserted by buy-box-embed.js — carries on. Writing the
     * shopper's selection into a detached form would look like it worked and
     * add a one-time line at checkout. Called from resync(), i.e. from every
     * event that can make this widget visible or move it.
     */
    function ensureForm() {
      if (form && inDocument(form)) {
        return;
      }
      var next = findProductForm(root, data.variants);
      if (next && next !== form) {
        form = next;
        wireForm();
      }
    }

    function onUrlChange() {
      var fromUrl = variantIdFromUrl();
      if (fromUrl) {
        onVariantMaybeChanged(fromUrl);
      }
    }
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('cx:locationchange', onUrlChange);

    /* ── Event-independent variant tracking (v1.6.8) ─────────────────────────
       Observed live on the client's Sleepify theme: jar packs are separate
       VARIANTS switched by the theme's own pill buttons, and the theme sets
       its current-variant state programmatically (jQuery .val()) — no change
       event ever fires and ?variant= is never written, so every listener
       above stays silent while the theme's own price display and the cart
       move on. The widget then quotes the landing variant's prices next to a
       button selling another variant. Events stay the fast path; these
       layers sit underneath and need no event at all:

         1. readThemeVariant() — the authoritative re-read: the theme's
            [name="id"] input-or-select (our bound form first, then a
            READ-ONLY document-wide scan that skips our own markup), and —
            v1.11.0, from the SECOND live Sleepify defect — elements that
            carry a variant id only as an ATTRIBUTE (data-variant-id /
            data-val-id / data-variant): the client's pills moved to
            data-val-id, the page has NO [name="id"] field at all, and the
            only other signal is another vendor's product rows updating on
            their own schedule, which a naive read raced into a widget
            permanently one click behind. Then ?variant=, else keep the
            current variant. A page can carry SEVERAL such signals for this
            product (quick-buy modal, sticky add-to-cart bar, bystander
            widgets), so when island-known values DISAGREE the scan settles
            on evidence instead of document order — see readThemeVariant's
            tier list: changed-value first, then fields (with the
            own-section tiebreak), then the theme's own active-selection
            paint, then passive markers; an unpicked swatch is never
            evidence. A numeric id the island does NOT know, appearing in
            our bound form or in a FIELD we watched hold our own ids, is
            CONCLUSIVE: the product gained a variant after plan sync, and
            the widget parks (below) rather than quote another variant's
            prices — a mere marker can never park it;
         2. click delegation over the product area (host section, else the
            bound form, else the whole page): any click schedules a re-read
            on the next macrotask and again at +350ms, because themes update
            their state asynchronously;
         3. a 600ms poll of the same field — a string compare against the
            current variant, only while the document is visible, ONE
            interval per widget, cleared on pagehide and on detach, re-armed
            by resync() — which catches ANY switching mechanism, including
            pure-JS themes with no clicks near us. The poll reuses the last
            scan's field list (validated for liveness) and only re-runs the
            document-wide query every 10th tick; click-driven re-reads
            always re-query, so a form the theme just opened is seen at the
            interaction that opened it.

       All three funnel into onVariantMaybeChanged(), whose render() repaints
       every price surface of every preset from the island matrix and
       re-anchors the theme add-to-cart price sync. */

    /** Island row exists for this id? (own-property — never the prototype). */
    function knownVariant(value) {
      return (
        !!value && Object.prototype.hasOwnProperty.call(data.variants, value)
      );
    }

    /* Attribute names a theme (or another widget on the page) uses to carry
       a variant id on an element that is not a form field. data-val-id is
       the client's CURRENT Sleepify size-pill vocabulary (v1.11.0, observed
       live — the pills moved off data-variant-id, and one pill ships its id
       with trailing whitespace, so every read below is trimmed). */
    var VARIANT_ID_ATTRS = ['data-variant-id', 'data-val-id', 'data-variant'];

    function trimId(value) {
      return String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
    }

    /** First variant-id attribute present on the element, trimmed. */
    function markerValue(el) {
      if (!el.getAttribute) {
        return '';
      }
      for (var i = 0; i < VARIANT_ID_ATTRS.length; i++) {
        var value = el.getAttribute(VARIANT_ID_ATTRS[i]);
        if (value != null && trimId(value) !== '') {
          return trimId(value);
        }
      }
      return '';
    }

    /** A [name="id"] input/select — the theme's canonical variant field. */
    function isThemeField(el) {
      return !!el.getAttribute && el.getAttribute('name') === 'id';
    }

    /**
     * Does the theme currently RENDER this element as the selected option?
     * (Checked input, aria-selected/pressed/checked, or an active/selected/
     * current class token.) A picker paints this synchronously in its own
     * click handler, which makes it the earliest — and on the client's
     * field-less theme the ONLY trustworthy — evidence of a variant change.
     */
    function markerActive(el) {
      try {
        if (el.checked === true) {
          return true;
        }
        if (!el.getAttribute) {
          return false;
        }
        if (
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-pressed') === 'true' ||
          el.getAttribute('aria-checked') === 'true'
        ) {
          return true;
        }
        var cls = el.getAttribute('class') || '';
        return /(^|[\s_-])(active|selected|current)([\s_-]|$)/.test(cls);
      } catch (err) {
        return false;
      }
    }

    /**
     * One swatch among several, not the current selection: a control-shaped
     * carrier (button/label/link/option, radio/checkbox input) or one inside
     * an option-picker container, WITHOUT the active signal. Its id names an
     * OPTION the shopper could pick — reading it as "the current variant" is
     * how a widget freezes on the first pill in the row.
     */
    function markerIsUnpickedOption(el) {
      if (markerActive(el)) {
        return false;
      }
      var tag = el.nodeName;
      if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'OPTION' || tag === 'A') {
        return true;
      }
      if (tag === 'INPUT') {
        var type = (el.getAttribute('type') || '').toLowerCase();
        return type === 'radio' || type === 'checkbox';
      }
      try {
        return !!(el.closest && el.closest('.pdp__options, [data-option]'));
      } catch (err) {
        return false;
      }
    }

    var THEME_FIELDS_MAX_AGE = 10;
    var themeFields = null;
    var themeFieldsAge = 0;

    /**
     * The THEME's variant signals — strictly read-only, foreign by design
     * (it is the theme's state we are after): skip anything of ours. Two
     * shapes are collected: [name="id"] fields (the canonical form state)
     * and elements carrying a variant-id ATTRIBUTE (v1.11.0 — swatch pills,
     * current-variant markers, another vendor's product rows; which of them
     * count, and how much, is decided per read in readThemeVariant).
     * `fresh` forces the document-wide query; otherwise the previous list is
     * reused while every element in it is still connected and the list is
     * younger than THEME_FIELDS_MAX_AGE polls, so the widget's lifetime poll
     * does not pay a document-wide querySelectorAll per tick.
     */
    function scanThemeFields(fresh) {
      if (!fresh && themeFields && themeFieldsAge < THEME_FIELDS_MAX_AGE) {
        var reusable = true;
        for (var i = 0; i < themeFields.length; i++) {
          if (!inDocument(themeFields[i])) {
            reusable = false;
            break;
          }
        }
        if (reusable) {
          themeFieldsAge += 1;
          return themeFields;
        }
      }
      var fields;
      try {
        fields = document.querySelectorAll(
          'input[name="id"], select[name="id"], [data-variant-id], [data-val-id], [data-variant]'
        );
      } catch (err) {
        themeFields = null;
        return [];
      }
      var found = [];
      for (var j = 0; j < fields.length; j++) {
        var field = fields[j];
        if (
          field.closest &&
          (field.closest(OWN_WIDGET) ||
            field.closest(OWN_WRAPPER) ||
            field.closest(OWN_SATELLITE))
        ) {
          continue;
        }
        found.push(field);
      }
      themeFields = found;
      themeFieldsAge = 0;
      return found;
    }

    /* Last-seen value per scanned field — the evidence the disagreement and
       un-synced rules read. Rebuilt on every scan pass, so entries for
       fields that left the document fall away on their own. */
    var fieldMemory = [];

    function rememberedValue(field) {
      for (var i = 0; i < fieldMemory.length; i++) {
        if (fieldMemory[i].field === field) {
          return fieldMemory[i].value;
        }
      }
      return null;
    }

    /**
     * The theme's current variant, as { id, unsynced }: `id` is an
     * island-known variant id or null; `unsynced: true` is the CONCLUSIVE
     * "this product now sells a variant the island has no row for" verdict
     * (see the section comment) — never raised from a value that could
     * belong to another product's form, and (v1.11.0) never from a mere
     * marker ATTRIBUTE: another widget's rows reshuffling to a variant we
     * never sold is not evidence this product changed, so only a real
     * [name="id"] field may park the widget.
     *
     * Evidence tiers, strongest first (v1.11.0 — from the live Sleepify
     * defect where the ONLY page-level signals were the pills' data-val-id
     * attributes and another vendor's data-variant-id rows that update on
     * their own schedule; a one-shot read of those rows put the widget
     * permanently one click behind the shopper):
     *   1. the bound form's [name="id"] — conclusive, as before;
     *   2. a FIELD whose value CHANGED since the last read (the one the
     *      shopper is driving — a laggy field self-corrects here the
     *      moment it catches up);
     *   3. [name="id"] fields, unanimous, then the own-section tiebreak —
     *      the canonical form state stays above any mere marker, so a
     *      foreign element wearing a "selected" class can never override
     *      it;
     *   4. the theme's own "this is selected" paint: active-signal carriers
     *      (checked radio, aria-selected/pressed, active/selected class),
     *      changed first then unanimous — also the fallback when fields
     *      disagree beyond the section tiebreak;
     *   5. passive current-variant markers (another widget's row naming one
     *      of OUR variants), changed first then unanimous, and only when no
     *      field and no active carrier said anything — the weakest evidence
     *      never overrides the theme's own state. Changes compete only
     *      WITHIN their tier: a bystander row settling late (to the
     *      previous click's variant) must never outrank the unchanged
     *      active pill the shopper is looking at.
     * Unpicked options (a swatch without the active signal) are never
     * evidence: each pill permanently names its OWN variant.
     */
    function readThemeVariant(fresh) {
      if (form && inDocument(form)) {
        var idInput = form.querySelector('[name="id"]');
        if (idInput) {
          var formValue = trimId(idInput.value);
          if (knownVariant(formValue)) {
            return { id: formValue, unsynced: false };
          }
          if (/^\d+$/.test(formValue)) {
            /* The bound form passed the ownership check, so a numeric id
               the island does not know is OUR product's un-synced variant. */
            return { id: null, unsynced: true };
          }
        }
      }
      var fields = scanThemeFields(fresh);
      var ownSection = null;
      try {
        ownSection = root.closest('.shopify-section');
      } catch (err) {
        ownSection = null;
      }
      var fieldKnown = [];
      var fieldDistinct = [];
      var activeDistinct = [];
      var passiveDistinct = [];
      /* Changed-since-last-read signals, PER TIER. One flat "any change
         wins" bucket would let a changed PASSIVE bystander outrank the
         theme's own unchanged active paint — the exact shape of the
         one-behind defect on a quick second click, when the bystander
         settles late to the PREVIOUS variant. A change only ever competes
         within its own trust tier. */
      var changedField = null;
      var changedFieldConflict = false;
      var changedActive = null;
      var changedActiveConflict = false;
      var changedPassive = null;
      var changedPassiveConflict = false;
      var changedUnsynced = false;
      var memory = [];
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var isField = isThemeField(field);
        var value = isField ? trimId(field.value) : markerValue(field);
        if (!isField && markerIsUnpickedOption(field)) {
          /* One swatch among several: its id names an option, not the
             current selection. Remember nothing and let the active one
             speak — a memory entry here would make the pill row read as a
             wall of "changed" signals the moment a theme re-renders it. */
          continue;
        }
        var last = rememberedValue(field);
        memory.push({ field: field, value: value });
        if (knownVariant(value)) {
          var isActive = !isField && markerActive(field);
          if (isField) {
            fieldKnown.push({ field: field, value: value });
            if (fieldDistinct.indexOf(value) === -1) {
              fieldDistinct.push(value);
            }
          } else if (isActive) {
            if (activeDistinct.indexOf(value) === -1) {
              activeDistinct.push(value);
            }
          } else if (passiveDistinct.indexOf(value) === -1) {
            passiveDistinct.push(value);
          }
          if (last !== null && last !== value) {
            if (isField) {
              if (changedField === null) {
                changedField = value;
              } else if (changedField !== value) {
                changedFieldConflict = true;
              }
            } else if (isActive) {
              if (changedActive === null) {
                changedActive = value;
              } else if (changedActive !== value) {
                changedActiveConflict = true;
              }
            } else if (changedPassive === null) {
              changedPassive = value;
            } else if (changedPassive !== value) {
              changedPassiveConflict = true;
            }
          }
        } else if (
          isField &&
          /^\d+$/.test(value) &&
          last !== null &&
          knownVariant(last) &&
          (!ownSection || !ownSection.contains || ownSection.contains(field))
        ) {
          /* A FIELD we watched hold OUR ids now holds a numeric id the
             island does not know — an un-synced variant of this product.
             Scoped to the widget's own section (when one exists): a shared
             quick-add/bundle field elsewhere on the page being retargeted
             from our product to another's must not park a widget whose own
             section still agrees with the island. */
          changedUnsynced = true;
        }
      }
      fieldMemory = memory;
      if (changedField !== null && !changedFieldConflict) {
        return { id: changedField, unsynced: false };
      }
      if (changedUnsynced) {
        return { id: null, unsynced: true };
      }
      if (fieldDistinct.length === 1) {
        return { id: fieldDistinct[0], unsynced: false };
      }
      if (fieldDistinct.length > 1) {
        if (ownSection && ownSection.contains) {
          var sectionValue = null;
          var sectionConflict = false;
          for (var k = 0; k < fieldKnown.length; k++) {
            if (!ownSection.contains(fieldKnown[k].field)) {
              continue;
            }
            if (sectionValue === null) {
              sectionValue = fieldKnown[k].value;
            } else if (sectionValue !== fieldKnown[k].value) {
              sectionConflict = true;
            }
          }
          if (sectionValue !== null && !sectionConflict) {
            return { id: sectionValue, unsynced: false };
          }
        }
        /* Fields disagree and the section cannot arbitrate: fall through to
           the theme's own selection paint rather than freezing forever. */
      }
      if (changedActive !== null && !changedActiveConflict) {
        return { id: changedActive, unsynced: false };
      }
      if (activeDistinct.length === 1) {
        return { id: activeDistinct[0], unsynced: false };
      }
      if (fieldDistinct.length === 0 && activeDistinct.length === 0) {
        /* Passive bystander markers: the weakest evidence, consulted only
           when neither a field nor the theme's own paint said anything. */
        if (changedPassive !== null && !changedPassiveConflict) {
          return { id: changedPassive, unsynced: false };
        }
        if (passiveDistinct.length === 1) {
          return { id: passiveDistinct[0], unsynced: false };
        }
      }
      return { id: null, unsynced: false };
    }

    /* ── Un-synced variant posture ("parked") ────────────────────────────────
       The theme is selling a variant of THIS product that the island has no
       row for — one added after the last plan sync. Every price string the
       widget could show belongs to ANOTHER variant, and a selling_plan left
       in the form could 422 the theme's add-to-cart (the plan may not cover
       the new variant). So the widget steps aside: root [hidden] plus the
       data-cellexia-unsynced marker (ours to remove, unlike the launch
       gate's), the theme's form released through the existing hidden-widget
       write path, the theme's button given its own text back, getState()
       null so the embed's cart patcher carries no plan either. The theme
       sells the variant one-time, exactly as if the widget were not
       installed. The moment the theme returns to a variant the island
       knows, the widget un-parks, repaints and re-writes the form. A plan
       re-sync ships a fresh island, so a reloaded page prices the new
       variant normally. */

    function parkUnsynced() {
      if (root.getAttribute('data-cellexia-unsynced') === 'true') {
        return; /* already parked */
      }
      if (widgetHidden()) {
        return; /* gated or unmounted: nothing shown, nothing written */
      }
      root.setAttribute('data-cellexia-unsynced', 'true');
      root.setAttribute('hidden', 'hidden');
      /* widgetHidden() is true from here on: this releases the theme's form
         (selling_plan emptied or removed, design prop disabled) and gives
         the theme's add-to-cart button its own text back. */
      applySellingPlan(true);
      syncThemePrice();
    }

    function unparkUnsynced() {
      if (root.getAttribute('data-cellexia-unsynced') !== 'true') {
        return false;
      }
      root.removeAttribute('data-cellexia-unsynced');
      root.removeAttribute('hidden');
      return true;
    }

    function reReadVariant(fresh) {
      var read = readThemeVariant(fresh);
      if (read.unsynced) {
        parkUnsynced();
        return;
      }
      var next = read.id || variantIdFromUrl();
      if (!next || !knownVariant(String(next))) {
        /* No signal, or an id the island does not know without conclusive
           evidence it is ours: keep the current variant, as before. */
        return;
      }
      next = String(next);
      if (unparkUnsynced()) {
        /* Back on a variant the island knows: repaint and re-write
           everything the parked state released — even when it is the very
           variant the widget froze on. Same default-adoption rule as the
           normal switch path. */
        state.variantId = next;
        maybeAdoptVariantDefault(next);
        render();
        applySellingPlan(true);
        return;
      }
      onVariantMaybeChanged(next);
    }

    function onProductAreaClick(event) {
      if (!inDocument(root)) {
        return; /* a ghost re-reads nothing */
      }
      var area = null;
      try {
        area = root.closest('.shopify-section');
      } catch (err) {
        area = null;
      }
      if (!area && form && inDocument(form)) {
        area = form;
      }
      if (
        area &&
        event &&
        event.target &&
        area.contains &&
        !area.contains(event.target)
      ) {
        return;
      }
      /* fresh: the click may have OPENED the form it is about to drive
         (quick-buy modal), so the cached field list must not be trusted. */
      window.setTimeout(function () {
        reReadVariant(true);
      }, 0);
      window.setTimeout(function () {
        reReadVariant(true);
      }, 350);
    }
    document.addEventListener('click', onProductAreaClick, true);

    var variantPoll = null;
    function stopVariantPoll() {
      if (variantPoll === null) {
        return;
      }
      try {
        window.clearInterval(variantPoll);
      } catch (err) {
        /* ignore */
      }
      variantPoll = null;
    }
    function startVariantPoll() {
      if (variantPoll !== null || typeof window.setInterval !== 'function') {
        return;
      }
      variantPoll = window.setInterval(function () {
        if (
          document.visibilityState &&
          document.visibilityState !== 'visible'
        ) {
          return;
        }
        if (!inDocument(root)) {
          /* Detached (theme-editor section re-render). The app embed can
             re-insert this same widget, and resync() re-arms the poll then;
             a widget that never comes back must not tick forever — and its
             relocated satellite must not outlive it either. */
          syncSatellite();
          stopVariantPoll();
          return;
        }
        reReadVariant();
      }, 600);
    }
    startVariantPoll();
    window.addEventListener('pagehide', stopVariantPoll);

    /* ── Initial paint + sync (injects the hidden input on load so the very
          first Add to Cart already carries the preselected plan) ─────────── */
    render();
    setMode(state.mode);
    applySellingPlan(true);
    /* Seed the tracking layers with the page's CURRENT theme state: fills
       the per-field memory (so the very first change is already a "changed"
       signal), parks immediately when the page LANDED on an un-synced
       variant, and adopts a theme field that already disagrees with the
       server-rendered initial variant. No-op on a page that agrees. */
    reReadVariant(true);
  }

  function scan() {
    var roots = document.querySelectorAll(OWN_WIDGET);
    Array.prototype.forEach.call(roots, init);
  }

  function boot() {
    patchHistory();
    previewBoot();
    scan();
    /* Re-scan handle for buy-box-embed.js: an embed widget that was dormant
       at boot (the section app block owned the page) is left uninitialised on
       purpose, so if it ever becomes the active widget — the block was
       removed in the theme editor, or the embed mounts after a section
       re-render — the mount step can ask for it to be initialised. init() is
       idempotent, so calling this at any time is safe. */
    try {
      var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
      subs.rescan = scan;
    } catch (err) {
      /* the global handle is an embed nicety — never break the widget */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Theme editor: sections are re-rendered in place. */
  document.addEventListener('shopify:section:load', function (event) {
    if (event.target && event.target.querySelectorAll) {
      Array.prototype.forEach.call(
        event.target.querySelectorAll(OWN_WIDGET),
        init
      );
      /* A re-rendered section comes back gated — re-reveal without refetch. */
      if (previewValidated) {
        revealGated();
      }
    }
    /* The section may have come back with a different product (theme editor
       preview, quick-view swap): a marker that was not there before still
       deserves its hint. No-op once the card is up. */
    if (previewValidated) {
      maybeShowNoOwnedGroupDiagnostic();
    }
    /* Widgets that SURVIVED the re-render (the app embed's wrapper is moved
       into the section by buy-box-embed.js and re-inserted afterwards, so it
       outlives its host) are now bound to a form that no longer exists.
       resync() re-resolves the form and re-writes the selection; widgets the
       re-render destroyed are pruned out of the registry by the same call.
       Deferred a tick so it runs after buy-box-embed.js has re-mounted. */
    window.setTimeout(resyncWidgets, 0);
  });
})();
