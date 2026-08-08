/**
 * Cellexia Buy Box — APP EMBED companion script. Vanilla JS, zero
 * dependencies, loaded (defer, after buy-box.js) ONLY by
 * blocks/buy-box-embed.liquid, i.e. only on product pages with selling
 * plans and only when the app embed is enabled.
 *
 * Responsibilities:
 *  1. MOUNT: move the server-rendered [hidden] .cx-buybox-embed wrapper from
 *     body-end into the PDP's buy column and unhide the WRAPPER only — and
 *     only while the widget inside it is showable. The inner widget's launch
 *     gate ([data-cellexia-gated][hidden] until the shop metafield
 *     cellexia.launch_status is "live") is buy-box.js's business and is
 *     deliberately NOT touched here; the wrapper simply stays [hidden] with
 *     it, because an unhidden EMPTY wrapper is itself a visible change to a
 *     live product page (display:block, 16px margins, grid-column:1/-1 — it
 *     would push Add to cart down for every visitor before go-live).
 *     Enabling the embed in SETUP mode therefore changes nothing on the
 *     storefront, and the ?cx_preview= reveal works unchanged: buy-box.js
 *     unhides this wrapper too once it carries data-cellexia-mounted. If a
 *     section-targeted Cellexia app block is present, the embed stays
 *     dormant (the block wins; never two widgets).
 *  2. PATCH CART REQUESTS: themes like cellexialabs.com's "Sleepify" have NO
 *     <form action="/cart/add"> — add-to-cart is a jQuery XHR. window.fetch
 *     and XMLHttpRequest are wrapped once; POSTs whose path ends in
 *     /cart/add or /cart/add.js get the selected selling_plan (and the
 *     properties[_cellexia_design] attribution) injected into the body, whatever
 *     its shape: FormData, URLSearchParams, urlencoded string, JSON
 *     items[], flat JSON {id, quantity} — and, in the encoded shapes, the
 *     bracket form jQuery produces for an items[] payload
 *     ("items[0][id]=…", per item). When one-time is selected, the widget is
 *     absent, gated-hidden, or anything at all goes wrong, the request passes
 *     through byte-identical — an add-to-cart must never break, and OTHER
 *     vendors' cart calls (e.g. the page's bundle widget posting a different
 *     product) must never be touched.
 *  3. TRACK VARIANTS: forward the theme's custom variant picker
 *     (.pdp__options) into the widget so prices stay correct — clicks as well
 *     as change events, since swatch buttons/labels fire no change event —
 *     followed by a re-read of ?variant= and, failing that, of the theme's
 *     own current-variant field.
 *
 * State is read exclusively via the guarded window.CellexiaSubs global that
 * buy-box.js maintains.
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  NAMESPACE HAZARD — WHY EVERY QUERY IN THIS FILE IS CLASS-QUALIFIED.    ║
 * ║  DO NOT RELAX THIS.                                                    ║
 * ╠════════════════════════════════════════════════════════════════════════╣
 * ║  Observed on the client's LIVE store (cellexialabs.com): the product    ║
 * ║  page already hosts an UNRELATED vendor that owns the "cx" namespace.   ║
 * ║  Inside .pdp__info (the buy column) it renders                          ║
 * ║      <div class="cx cx--self-contained" data-cx-embed>                  ║
 * ║  and the page also carries that vendor's cx-i18n / cx-cart-config /     ║
 * ║  cx-pdp-config / cx-embed-config script ids and a .sm-rc-widget.        ║
 * ║                                                                        ║
 * ║  This file used to find its own wrapper with a bare attribute lookup    ║
 * ║  (our wrapper attribute was formerly named data-cx-embed too). That     ║
 * ║  selector matched the OTHER vendor's element — which appears EARLIER    ║
 * ║  in the DOM than our body-end wrapper — with two consequences, both     ║
 * ║  reproduced live:                                                      ║
 * ║    1. we wrote our "mounted" marker onto, and adopted, another          ║
 * ║       vendor's element: we mutated and relocated DOM we do not own;     ║
 * ║    2. the mount check then answered "already mounted" forever, so OUR   ║
 * ║       wrapper never left the end of <body>. It stayed [hidden], the     ║
 * ║       widget measured 0px, and the buy box was invisible on the one     ║
 * ║       store this app has to work on.                                    ║
 * ║                                                                        ║
 * ║  The fix has three layers, and all three must stay:                     ║
 * ║    a. our storefront attributes are namespaced data-cellexia-*, not     ║
 * ║       data-cx-* (CSS class names stay .cx-buybox*, which does not       ║
 * ║       collide with that vendor's .cx / .cx--self-contained);            ║
 * ║    b. EVERY document-level query here is qualified by OUR OWN class as  ║
 * ║       well as our attribute (.cx-buybox-embed[data-cellexia-embed],     ║
 * ║       .cx-buybox[data-cellexia-buybox]) or is rooted at a node we       ║
 * ║       already proved is ours — never a bare [attribute] lookup;         ║
 * ║    c. isOwnWrapper() is asserted before anything is moved, marked or    ║
 * ║       unhidden, so even a future colliding app cannot get us to touch   ║
 * ║       its DOM.                                                         ║
 * ║  This file also never creates element ids and never queries id          ║
 * ║  selectors, and shares nothing except window.CellexiaSubs.              ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 */
(function () {
  'use strict';

  /* Only "this file already ran" may short-circuit the whole module.
     Deliberately NOT `subs.embedMounted`: mounting is not a one-way door —
     see the mount-state notes below. */
  var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
  if (subs.embedLoaded) {
    return;
  }
  subs.embedLoaded = true;

  /* ── Ownership ───────────────────────────────────────────────────────────
     The ONLY selectors this file may use to find its own markup. Class AND
     attribute, always: the attribute alone is what let another vendor's
     element be adopted as our wrapper on the live store (see the header). */
  var OWN_WRAPPER = '.cx-buybox-embed[data-cellexia-embed]';
  var OWN_WIDGET = '.cx-buybox[data-cellexia-buybox]';

  /**
   * "Is this node OUR embed wrapper?" — asserted before the wrapper is moved,
   * marked or unhidden, so a selector that somehow matched foreign markup
   * still cannot make us mutate DOM we do not own. classList.contains is the
   * primary test; the className fallback keeps very old browsers working.
   */
  function isOwnWrapper(node) {
    if (!node) {
      return false;
    }
    try {
      if (node.classList && typeof node.classList.contains === 'function') {
        return node.classList.contains('cx-buybox-embed');
      }
      var names = typeof node.className === 'string' ? node.className : '';
      return (' ' + names + ' ').indexOf(' cx-buybox-embed ') !== -1;
    } catch (err) {
      return false;
    }
  }

  /* ── Shared helpers ─────────────────────────────────────────────────────── */

  /** Still in the live document? (isConnected, with an older-browser path.) */
  function inDocument(node) {
    if (!node) {
      return false;
    }
    if (typeof node.isConnected === 'boolean') {
      return node.isConnected;
    }
    return document.contains ? document.contains(node) : true;
  }

  var warnedMessages = {};
  function warnOnce(message) {
    if (warnedMessages[message]) {
      return;
    }
    warnedMessages[message] = true;
    try {
      console.warn('[Cellexia buy box] ' + message);
    } catch (err) {
      /* consoles can be stubbed out — never matters */
    }
  }

  function safeQuery(selector, scope) {
    if (!selector) {
      return null;
    }
    try {
      return (scope || document).querySelector(selector);
    } catch (err) {
      return null; /* merchant-typed selector may be invalid */
    }
  }

  /**
   * The active subscription selection, or null. Null whenever the widget is
   * absent, launch-gated/hidden, or has one-time selected — the callers
   * treat null as "do not touch anything".
   */
  function activeSubState() {
    try {
      if (typeof subs.getState !== 'function') {
        return null;
      }
      var state = subs.getState();
      if (!state || state.mode !== 'subscription' || !state.sellingPlanId) {
        return null;
      }
      return state;
    } catch (err) {
      return null;
    }
  }

  function matchesVariant(id, state) {
    var ids = state.variantIds || [];
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i]) === String(id)) {
        return true;
      }
    }
    return false;
  }

  /* ── 1. Mounting ────────────────────────────────────────────────────────── */

  /** True when a SECTION-block widget is on the page (block wins over embed). */
  function sectionWidgetPresent() {
    var widgets = document.querySelectorAll(OWN_WIDGET);
    for (var i = 0; i < widgets.length; i++) {
      if (!widgets[i].closest(OWN_WRAPPER)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Automatic anchor heuristics, in order:
   *  1. cellexialabs.com: the grey quantity+ATC panel inside the buy column
   *     → insert before (after size options, above quantity + add to cart);
   *  2. OS 2.0 standard themes (Dawn family): .product-form__buttons → before;
   *  3. any /cart/add form's submit button → before its closest block-level
   *     wrapper INSIDE the form (falls back to the button itself);
   *  4. any /cart/add form → prepend;
   *  5. a price element → after.
   */
  function autoAnchor() {
    var el = safeQuery('.pdp__info .pdp__grey');
    if (el) {
      return { el: el, pos: 'before' };
    }
    el = safeQuery('.product-form__buttons');
    if (el) {
      return { el: el, pos: 'before' };
    }
    var submit = safeQuery("form[action*='/cart/add'] [type='submit']");
    if (submit) {
      var formEl = submit.closest('form');
      var wrap = submit;
      var parent = submit.parentElement;
      while (parent && parent !== formEl) {
        var tag = parent.tagName;
        if (tag === 'DIV' || tag === 'SECTION' || tag === 'FIELDSET') {
          wrap = parent;
          break;
        }
        parent = parent.parentElement;
      }
      return { el: wrap, pos: 'before' };
    }
    var form = safeQuery("form[action*='/cart/add']");
    if (form) {
      return { el: form, pos: 'prepend' };
    }
    el = safeQuery('.pdp__price, .price');
    if (el) {
      return { el: el, pos: 'after' };
    }
    return null;
  }

  /**
   * An anchor we may legitimately insert next to: a real element that is
   * neither the wrapper itself nor inside it (inserting a node next to its own
   * descendant is a DOM exception, and a merchant-typed selector can name a
   * node inside our widget).
   */
  function usableAnchor(wrapper, el) {
    if (!el || el === wrapper) {
      return false;
    }
    try {
      return !(wrapper.contains && wrapper.contains(el));
    } catch (err) {
      return true;
    }
  }

  function placeAt(wrapper, anchor) {
    /* Ownership assertion, right next to the mutation: this function MOVES a
       node. It may only ever move ours. */
    if (!isOwnWrapper(wrapper)) {
      return false;
    }
    var el = anchor.el;
    var pos = anchor.pos;
    if (pos === 'prepend') {
      el.insertBefore(wrapper, el.firstChild);
      return true;
    }
    if (pos === 'append') {
      el.appendChild(wrapper);
      return true;
    }
    if (!el.parentNode) {
      return false;
    }
    if (pos === 'after') {
      el.parentNode.insertBefore(wrapper, el.nextSibling);
    } else {
      el.parentNode.insertBefore(wrapper, el);
    }
    return true;
  }

  var diagnosticShown = false;

  /* True only when THIS page load carries ?cx_preview= in its own URL.
     Computed here rather than trusted off a global: it is one URLSearchParams
     read, and a gate this sensitive should not depend on script load order. */
  var previewTokenInUrl = false;
  try {
    previewTokenInUrl = !!new URLSearchParams(window.location.search).get(
      'cx_preview'
    );
  } catch (err) {
    previewTokenInUrl = false;
  }

  /**
   * Preview sessions must never fail silently: when no anchor matched, the
   * admin who followed a ?cx_preview= link gets a plain-English hint card.
   *
   * IT IS GATED ON THE VALIDATED SESSION *AND* THE ?cx_preview= PARAMETER IN
   * THIS PAGE LOAD'S URL — never on the raw token alone, never on
   * sessionStorage alone. buy-box.js writes the ?cx_preview= URL parameter
   * into sessionStorage BEFORE the app proxy has judged it, so "a token is
   * in sessionStorage" only means "somebody put a value in the URL" — a
   * leaked or expired link forwarded in a chat, a crawler replaying an old
   * URL, or anyone appending the parameter. Keying off that would show
   * internal English vendor copy to a Swiss customer on a live storefront.
   * And the VALIDATED token also persists in sessionStorage across same-tab
   * navigation (that is how the widget reveal follows PDP → cart), so the
   * validated session alone would raise this card on pages the admin never
   * previewed — the URL parameter pins it to the page actually opened
   * through a preview link. CellexiaSubs.previewValidated is set exclusively
   * on a { ok: true } answer from /apps/cellexia-subs/preview/validate; the
   * validation is async, so buy-box.js also fires cx:preview:validated,
   * which retries the mount (and therefore this card) below. No element id
   * (namespace hazard), English only (admin-only diagnostics are not
   * customer-facing copy).
   */
  function maybeShowDiagnostic() {
    try {
      if (diagnosticShown || !document.body || !previewTokenInUrl) {
        return;
      }
      if (subs.previewValidated !== true) {
        return;
      }
      diagnosticShown = true;
      var card = document.createElement('div');
      card.className = 'cx-buybox-diagnostic';
      card.setAttribute('role', 'status');
      card.textContent =
        'Cellexia buy box: no placement anchor found — set a custom CSS ' +
        'selector in the Buy box designer → Placement.';
      document.body.appendChild(card);
    } catch (err) {
      /* a diagnostic that cannot be shown is never worth an exception */
    }
  }

  /**
   * MOUNT STATE — why this is re-checked instead of latched.
   *
   * tryMount MOVES the one server-rendered wrapper out of body-end and into
   * the buy column, which makes it a descendant of the host product section.
   * In the theme editor — exactly where the merchant is during install —
   * changing any setting of that section makes Shopify replace the section's
   * innerHTML, destroying the moved wrapper; the same happens on themes that
   * swap the buy column by AJAX on variant change. A boolean "mounted" latch
   * would record success forever and the widget would simply be gone until a
   * full page reload, which reads as "the install is broken".
   *
   * So: mountedWrapper keeps a REFERENCE to the node we placed (a wrapper
   * removed from the document still exists, with its state and listeners
   * intact, as long as we hold it), and "is it mounted?" is answered by
   * asking the document, never by a flag.
   */
  var mountedWrapper = null;

  function embedIsMounted() {
    var mounted = inDocument(mountedWrapper);
    /* subs.embedMounted is a REPORT for anything reading the global, so keep
       it truthful in both directions rather than latched at true. */
    subs.embedMounted = mounted;
    return mounted;
  }

  /**
   * The wrapper to mount: the one in the document, else the node we placed
   * earlier and a section re-render has since detached — re-inserting that
   * same node restores the widget (and its buy-box.js wiring) without the
   * server markup being available a second time.
   */
  function findWrapper() {
    /* Class AND attribute (OWN_WRAPPER): the bare attribute lookup this
       replaced returned ANOTHER vendor's element on cellexialabs.com and
       wedged the mount forever — see the namespace-hazard block at the top.
       isOwnWrapper() below re-checks whatever comes back. */
    var inPage = document.querySelector(OWN_WRAPPER);
    if (isOwnWrapper(inPage)) {
      return inPage;
    }
    return isOwnWrapper(mountedWrapper) ? mountedWrapper : null;
  }

  /**
   * One mount attempt. Returns true when there is nothing left to do (either
   * mounted, or legitimately dormant); false asks the scheduler to retry.
   */
  function tryMount(finalAttempt) {
    try {
      if (embedIsMounted()) {
        return true;
      }
      var wrapper = findWrapper();
      if (!wrapper) {
        return true; /* liquid rendered nothing (shouldn't happen: script is conditional) */
      }
      /* Ownership assertion (defence in depth). findWrapper only ever returns
         our own wrapper; this re-states it at the point where the very next
         steps MOVE, MARK and UNHIDE the node. Bail out safely otherwise —
         another vendor's element must be left exactly as we found it. */
      if (!isOwnWrapper(wrapper)) {
        warnOnce(
          'refusing to mount: the resolved wrapper is not a Cellexia wrapper.'
        );
        return true;
      }
      if (sectionWidgetPresent()) {
        return true; /* section block wins — embed stays hidden and dormant */
      }

      var anchor = null;
      var customSelector = wrapper.getAttribute('data-cellexia-anchor');
      var customPosition =
        wrapper.getAttribute('data-cellexia-anchor-pos') || 'before';
      if (customSelector) {
        var customEl = safeQuery(customSelector);
        if (usableAnchor(wrapper, customEl)) {
          anchor = { el: customEl, pos: customPosition };
        } else if (!customEl && !finalAttempt) {
          /* Give a late-rendering custom anchor its 1500ms grace before
             falling back to the heuristics. */
          return false;
        } else {
          warnOnce(
            'custom anchor selector "' +
              customSelector +
              '" matched nothing usable — falling back to automatic placement.'
          );
        }
      }
      if (!anchor) {
        anchor = autoAnchor();
        if (anchor && !usableAnchor(wrapper, anchor.el)) {
          anchor = null;
        }
      }
      if (!anchor) {
        if (finalAttempt) {
          warnOnce(
            'no placement anchor found on this page — the widget stays ' +
              'unmounted. Set a custom CSS selector in the Buy box designer ' +
              '→ Placement (or on the app embed in the theme editor).'
          );
          /* …but only when there is a widget to place. An EMPTY wrapper means
             this product carries selling plans of which none are ours, so
             cx-buybox-core rendered nothing on purpose (it never renders
             another app's group — see the snippet's ownership block). That
             page has no placement problem: telling the admin to set an anchor
             selector would send them after the wrong thing, and buy-box.js is
             already raising the hint that does apply, off the marker the
             snippet leaves inside this wrapper. Both cards are
             position:fixed in the same corner, so they would also stack. */
          if (wrapper.querySelector(OWN_WIDGET)) {
            maybeShowDiagnostic();
          }
        }
        return false;
      }

      if (!placeAt(wrapper, anchor)) {
        return false;
      }
      /* Unhide the WRAPPER only — and only when the widget inside it is
         actually showable. The inner widget keeps its own
         [data-cellexia-gated][hidden] launch gate, governed by buy-box.js
         (metafield live / validated preview token); mounting must never
         bypass it, and unhiding an EMPTY wrapper is not harmless either:
         .cx-buybox-embed is display:block with 16px block margins and
         grid-column:1/-1, so before go-live it would push the quantity +
         Add to cart panel down — a whole extra row in a grid buy column —
         and shift every :nth-child rule the theme applies to that column,
         for every visitor, on every product page. So: gated inner ⇒ the
         wrapper stays [hidden] (display:none) and the live PDP is
         byte-for-byte what it was before the app embed was enabled.
         [hidden] on the inner widget is the right signal rather than
         [data-cellexia-gated], because a validated preview reveal that already ran
         removes exactly that attribute (and leaves data-cellexia-gated in place).
         data-cellexia-mounted records that the wrapper reached the buy column,
         which is what lets a LATER preview reveal unhide it. */
      wrapper.setAttribute('data-cellexia-mounted', 'true');
      mountedWrapper = wrapper;
      /* Kept in sync for anything that reads the global; it is a REPORT of
         the current state, never the thing that decides (see the mount-state
         note above). */
      subs.embedMounted = true;
      var inner = wrapper.querySelector(OWN_WIDGET);
      if (inner && !inner.hasAttribute('hidden')) {
        wrapper.removeAttribute('hidden');
      }
      /* The embed may have been dormant when buy-box.js booted (the section
         app block owned the page at that moment); now that it is the mounted
         widget, ask for a re-scan — init() is idempotent and skips widgets it
         already owns. */
      if (typeof subs.rescan === 'function') {
        try {
          subs.rescan();
        } catch (err) {
          /* never break the page over a re-scan */
        }
      }
      /* The widget was inside a [hidden] wrapper while buy-box.js booted, so
         it wrote NOTHING into the theme's product form (the launch gate is a
         write gate). Now that it is visible, ask it to push its preselection
         — otherwise the first Add to cart on a form-based theme would go out
         without the selling plan. No-op when the widget is still gated. */
      if (typeof subs.resync === 'function') {
        try {
          subs.resync();
        } catch (err) {
          /* never break the page over a form sync */
        }
      }
      return true;
    } catch (err) {
      return false; /* retry may still succeed; never throw from here */
    }
  }

  var finalTimer = null;
  function mountBoot() {
    if (tryMount(false)) {
      return;
    }
    if (!finalTimer) {
      /* One more pass for late-rendered PDPs (hydrated buy columns, deferred
         template sections). Cleared before the pass runs, so a LATER
         un-mount (section re-render) can schedule its own grace period
         instead of being locked out by this one. */
      finalTimer = window.setTimeout(function () {
        finalTimer = null;
        tryMount(true);
      }, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBoot);
  } else {
    mountBoot();
  }
  /* Defer scripts normally run right before DOMContentLoaded; listen anyway
     in case this file was injected late. Re-entry is cheap and idempotent. */
  document.addEventListener('DOMContentLoaded', mountBoot);

  /* The preview token is validated over the network, so a genuine admin
     session can be confirmed AFTER the mount passes have already run. Retry
     once then: the mount may now be worth redoing, and the admin-only
     diagnostic (suppressed until the session is proven) can finally be
     shown if there is still no anchor. */
  document.addEventListener('cx:preview:validated', function () {
    tryMount(true);
  });

  /* ── Re-mounting ─────────────────────────────────────────────────────────
     The wrapper lives inside the host product section once mounted, so
     anything that re-renders that section takes the widget with it. Two
     independent nets, because neither covers the other:

       - shopify:section:load / :unload — the theme editor. This is where the
         merchant is while installing from the ZIP, and where a vanished
         widget is most likely to be read as "the app is broken". :load fires
         after the replacement markup is in the DOM; :unload fires before the
         old one goes, so both are deferred by a tick.
       - a MutationObserver on <body> — themes that swap the buy column by
         AJAX on variant change (and any other re-render Shopify does not
         announce). Debounced to one check per task and short-circuited by a
         cheap isConnected read, so a busy page pays almost nothing. */

  var recheckScheduled = false;
  function scheduleRemount() {
    if (recheckScheduled || embedIsMounted()) {
      return;
    }
    recheckScheduled = true;
    window.setTimeout(function () {
      recheckScheduled = false;
      if (!embedIsMounted()) {
        mountBoot();
      }
    }, 0);
  }

  document.addEventListener('shopify:section:load', scheduleRemount);
  document.addEventListener('shopify:section:unload', scheduleRemount);

  try {
    if (typeof window.MutationObserver === 'function' && document.body) {
      new window.MutationObserver(scheduleRemount).observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  } catch (err) {
    /* observers are a safety net, never a requirement — the section events
       and the boot passes still cover the theme editor */
  }

  /* ── 2. Cart-request patching ───────────────────────────────────────────── */

  /** Same-origin POST target whose path ends in /cart/add or /cart/add.js. */
  function isCartAddUrl(url) {
    try {
      var parsed = new URL(String(url), window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return false;
      }
      return /\/cart\/add(\.js)?$/.test(parsed.pathname);
    } catch (err) {
      return false;
    }
  }

  /** selling_plan for JSON payloads: numeric when it cleanly is a number. */
  function planIdValue(id) {
    var numeric = Number(id);
    return isFinite(numeric) && String(numeric) === String(id) ? numeric : id;
  }

  /**
   * items[] / flat-JSON injection. Mutates `payload`; returns true when
   * something was actually injected. Items are matched against OUR product's
   * variant ids so another vendor's add (the page's bundle widget, cart-page
   * upsells) is never rewritten — that would 422 their checkout. The spec'd
   * item[0] fallback applies only when no item carries a usable id at all.
   */
  function injectJson(payload, state) {
    var items;
    if (payload && Object.prototype.toString.call(payload.items) === '[object Array]') {
      items = payload.items;
    } else if (payload && typeof payload === 'object' && payload.id != null) {
      items = [payload]; /* flat { id, quantity } */
    } else {
      return false;
    }

    var targets = [];
    var idsSeen = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.id != null && item.id !== '') {
        idsSeen = true;
        if (matchesVariant(item.id, state)) {
          targets.push(item);
        }
      }
    }
    if (!targets.length) {
      if (!idsSeen && items.length && items[0] && typeof items[0] === 'object') {
        targets.push(items[0]);
      } else {
        return false;
      }
    }

    var changed = false;
    for (var j = 0; j < targets.length; j++) {
      var target = targets[j];
      if (target.selling_plan) {
        continue; /* already a subscription line — leave it alone */
      }
      target.selling_plan = planIdValue(state.sellingPlanId);
      var properties =
        target.properties && typeof target.properties === 'object'
          ? target.properties
          : {};
      properties._cellexia_design = state.design;
      target.properties = properties;
      changed = true;
    }
    return changed;
  }

  /**
   * [key, value] pairs of any container that exposes entries() — both
   * URLSearchParams and FormData do. null when it cannot be walked.
   */
  function entryPairs(container) {
    var pairs = [];
    try {
      var iterator = container.entries();
      var step;
      while (!(step = iterator.next()).done) {
        pairs.push([String(step.value[0]), step.value[1]]);
      }
    } catch (err) {
      return null;
    }
    return pairs;
  }

  var ITEM_ID_KEY = /^items\[(\d+)\]\[id\]$/;
  var ITEM_PLAN_KEY = /^items\[(\d+)\]\[selling_plan\]$/;

  /**
   * The `items[i][…]` bracket shape, which is what jQuery produces for
   * $.ajax({ url: '/cart/add.js', data: { items: [{ id, quantity }] } }) —
   * "items%5B0%5D%5Bid%5D=…". Without this the flat params.get('id') lookup
   * finds nothing and the request goes out with no selling plan at all: the
   * shopper who chose the subscription silently gets a one-time line.
   *
   * Returns the indexes to inject into, applying the same per-item rules as
   * the JSON path: another vendor's variant is never touched, and an item
   * that already carries a selling_plan is left alone. Empty ⇒ the body
   * passes through byte-identical.
   */
  function itemIndexTargets(pairs, state) {
    var ids = {};
    var planned = {};
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      var idMatch = ITEM_ID_KEY.exec(key);
      if (idMatch) {
        ids[idMatch[1]] = pairs[i][1];
        continue;
      }
      var planMatch = ITEM_PLAN_KEY.exec(key);
      if (planMatch && pairs[i][1] !== '' && pairs[i][1] != null) {
        planned[planMatch[1]] = true;
      }
    }
    var targets = [];
    for (var index in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, index)) {
        continue;
      }
      if (planned[index]) {
        continue;
      }
      if (!matchesVariant(ids[index], state)) {
        continue;
      }
      targets.push(index);
    }
    return targets;
  }

  /** urlencoded string → new string, or null for "pass through untouched". */
  function injectUrlEncoded(body, state) {
    if (typeof window.URLSearchParams !== 'function') {
      return null;
    }
    var params;
    try {
      params = new URLSearchParams(body);
    } catch (err) {
      return null;
    }
    var id = params.get('id');
    if (id) {
      /* Flat shape: id=…&quantity=… */
      if (params.get('selling_plan')) {
        return null; /* someone already set it — not ours to overwrite */
      }
      if (!matchesVariant(id, state)) {
        return null; /* not our product — pass through untouched */
      }
      params.set('selling_plan', String(state.sellingPlanId));
      params.set('properties[_cellexia_design]', state.design);
      return params.toString();
    }
    var pairs = entryPairs(params);
    if (!pairs) {
      return null;
    }
    var targets = itemIndexTargets(pairs, state);
    if (!targets.length) {
      return null; /* no id at all, or nothing of ours — untouched */
    }
    for (var i = 0; i < targets.length; i++) {
      params.set(
        'items[' + targets[i] + '][selling_plan]',
        String(state.sellingPlanId)
      );
      params.set(
        'items[' + targets[i] + '][properties][_cellexia_design]',
        state.design
      );
    }
    return params.toString();
  }

  /** String body: JSON or urlencoded. Returns new string or null. */
  function injectString(body, state) {
    var head = body.replace(/^\s+/, '').charAt(0);
    if (head === '{' || head === '[') {
      var payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        return null;
      }
      if (!injectJson(payload, state)) {
        return null;
      }
      try {
        return JSON.stringify(payload);
      } catch (err) {
        return null;
      }
    }
    return injectUrlEncoded(body, state);
  }

  /** FormData → NEW FormData (caller's object untouched), or null. */
  function injectFormData(formData, state) {
    if (
      typeof formData.get !== 'function' ||
      typeof formData.set !== 'function' ||
      typeof formData.entries !== 'function'
    ) {
      return null; /* legacy FormData without inspection — pass through */
    }
    var pairs = entryPairs(formData);
    if (!pairs) {
      return null;
    }
    var id = formData.get('id');
    var targets = null;
    if (id) {
      if (formData.get('selling_plan')) {
        return null;
      }
      if (!matchesVariant(id, state)) {
        return null;
      }
    } else {
      /* Same items[i][id] shape as the urlencoded path (a FormData built by
         the theme from an items[] payload). */
      targets = itemIndexTargets(pairs, state);
      if (!targets.length) {
        return null;
      }
    }
    var copy;
    try {
      copy = new FormData();
      for (var i = 0; i < pairs.length; i++) {
        copy.append(pairs[i][0], pairs[i][1]);
      }
    } catch (err) {
      return null;
    }
    if (targets) {
      for (var j = 0; j < targets.length; j++) {
        copy.set(
          'items[' + targets[j] + '][selling_plan]',
          String(state.sellingPlanId)
        );
        copy.set(
          'items[' + targets[j] + '][properties][_cellexia_design]',
          state.design
        );
      }
    } else {
      copy.set('selling_plan', String(state.sellingPlanId));
      copy.set('properties[_cellexia_design]', state.design);
    }
    return copy;
  }

  /**
   * Body dispatcher: returns the REPLACEMENT body, or null meaning "send the
   * original, byte-identical". Unknown shapes (Blob, ArrayBuffer, streams)
   * are never touched.
   */
  function injectBody(body, state) {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return injectFormData(body, state);
    }
    if (
      typeof URLSearchParams !== 'undefined' &&
      body instanceof URLSearchParams
    ) {
      var encoded = injectUrlEncoded(body.toString(), state);
      return encoded === null ? null : new URLSearchParams(encoded);
    }
    if (typeof body === 'string') {
      return injectString(body, state);
    }
    return null;
  }

  /* fetch — wrapped once; everything inside try/catch falls through to the
     original, untouched request. */
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var url =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : String(input || '');
        if (
          init &&
          init.body != null &&
          String(init.method || 'GET').toUpperCase() === 'POST' &&
          isCartAddUrl(url)
        ) {
          var state = activeSubState();
          if (state) {
            var nextBody = injectBody(init.body, state);
            if (nextBody !== null) {
              var nextInit = {};
              for (var key in init) {
                if (Object.prototype.hasOwnProperty.call(init, key)) {
                  nextInit[key] = init[key];
                }
              }
              nextInit.body = nextBody;
              return originalFetch.call(this, input, nextInit);
            }
          }
        }
      } catch (err) {
        /* fall through to the original request — never break add-to-cart */
      }
      return originalFetch.apply(this, arguments);
    };
  }

  /* XMLHttpRequest — covers jQuery.ajax (the Sleepify theme's cart path). */
  var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto && typeof xhrProto.open === 'function') {
    var originalOpen = xhrProto.open;
    var originalSend = xhrProto.send;
    xhrProto.open = function (method, url) {
      try {
        this.__cxCartAdd =
          String(method || '').toUpperCase() === 'POST' && isCartAddUrl(url);
      } catch (err) {
        this.__cxCartAdd = false;
      }
      return originalOpen.apply(this, arguments);
    };
    xhrProto.send = function (body) {
      try {
        if (this.__cxCartAdd && body != null) {
          var state = activeSubState();
          if (state) {
            var nextBody = injectBody(body, state);
            if (nextBody !== null) {
              return originalSend.call(this, nextBody);
            }
          }
        }
      } catch (err) {
        /* fall through to the original request — never break add-to-cart */
      }
      return originalSend.apply(this, arguments);
    };
  }

  /* ── 3. Variant tracking (theme-specific pickers + URL) ────────────────────
     buy-box.js already handles product-form change events, popstate and its
     own history patch; this adds the Sleepify theme's custom size picker
     (.pdp__options — NOT a product form) and a post-interaction re-read.

     A `change` listener alone is not enough: a picker built from <button> or
     <label> swatches fires CLICKS ONLY, and a custom PDP that swaps the price
     in place without touching ?variant= leaves nothing else to hear. The
     widget would then keep quoting the first variant's prices directly above
     the add-to-cart button while the theme shows another — one price on the
     page, another at checkout. So both events are handled, and the deferred
     re-read consults the URL first and the theme's own current-variant field
     second. Interval-free by design; ids the widget does not recognise are
     ignored inside buy-box.js, so every push here is safe. */

  function pushVariant(value) {
    if (value == null || value === '') {
      return false;
    }
    try {
      if (typeof subs.setVariant !== 'function') {
        return false;
      }
      subs.setVariant(String(value));
      return true;
    } catch (err) {
      return false; /* display-only — never matters */
    }
  }

  /** The widget's own variant ids, when a widget is present and visible. */
  function knownVariantIds() {
    try {
      if (typeof subs.getState !== 'function') {
        return null;
      }
      var state = subs.getState();
      return state && state.variantIds && state.variantIds.length
        ? state.variantIds
        : null;
    } catch (err) {
      return null;
    }
  }

  function isKnownVariant(id, known) {
    if (!known) {
      return true; /* cannot tell — let the widget filter it */
    }
    for (var i = 0; i < known.length; i++) {
      if (String(known[i]) === String(id)) {
        return true;
      }
    }
    return false;
  }

  function syncVariantFromUrl() {
    try {
      var id = new URLSearchParams(window.location.search).get('variant');
      if (id) {
        return pushVariant(id);
      }
    } catch (err) {
      /* display-only — never matters */
    }
    return false;
  }

  /**
   * Last resort for themes that never touch ?variant=: the field the theme
   * itself maintains for the current selection. `[name="id"]` is canonical
   * (it is what its own add-to-cart submits); a `[data-variant-id]` is only
   * trusted OUTSIDE the picker, where it marks the current variant rather
   * than one swatch among several.
   *
   * This is the one document-wide lookup here that deliberately reads FOREIGN
   * markup (it is the theme's own field we are after, so it cannot be
   * class-qualified to ours). It is safe because it is strictly READ-ONLY —
   * nothing is written, marked or moved — every candidate must name one of
   * OUR variant ids to be used at all, and anything inside our own widget or
   * wrapper is skipped.
   */
  function syncVariantFromDom() {
    try {
      var known = knownVariantIds();
      var fields = document.querySelectorAll(
        'input[name="id"], select[name="id"], [data-variant-id]'
      );
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (
          field.closest &&
          (field.closest(OWN_WIDGET) || field.closest(OWN_WRAPPER))
        ) {
          continue; /* our own markup — the theme's field is what we want */
        }
        var id = field.getAttribute('data-variant-id');
        if (id) {
          if (field.closest && field.closest('.pdp__options')) {
            continue; /* a swatch marker, not the current selection */
          }
        } else {
          id = field.value;
        }
        if (!id || !isKnownVariant(id, known)) {
          continue;
        }
        if (pushVariant(id)) {
          return; /* first field that names one of our variants wins */
        }
      }
    } catch (err) {
      /* display-only — never matters */
    }
  }

  /** The theme updates its own state right after the event — re-read then. */
  function reReadVariant() {
    if (!syncVariantFromUrl()) {
      syncVariantFromDom();
    }
  }

  function onPickerInteraction(event) {
    try {
      var target = event.target;
      if (!target || !target.closest || !target.closest('.pdp__options')) {
        return;
      }
      /* The control the shopper actually touched: a <select>'s value, a
         radio's value, or a swatch button carrying the variant id. Walk a
         couple of levels up because clicks land on inner spans/images. */
      var node = target;
      for (var hops = 0; node && node.getAttribute && hops < 4; hops++) {
        var id =
          node.getAttribute('data-variant-id') ||
          node.getAttribute('data-variant') ||
          (typeof node.value === 'string' ? node.value : '');
        if (id) {
          pushVariant(id);
          break;
        }
        node = node.parentElement;
      }
      window.setTimeout(reReadVariant, 60);
    } catch (err) {
      /* display-only — never matters */
    }
  }

  document.addEventListener('change', onPickerInteraction, true);
  document.addEventListener('click', onPickerInteraction, true);

  window.addEventListener('popstate', syncVariantFromUrl);
  window.addEventListener('cx:locationchange', syncVariantFromUrl);
})();
