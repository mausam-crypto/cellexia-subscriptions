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
 *     /cart/add or /cart/add.js get patched, whatever the body's shape:
 *     FormData, URLSearchParams, urlencoded string, JSON items[], flat JSON
 *     {id, quantity} — and, in the encoded shapes, the bracket form jQuery
 *     produces for an items[] payload ("items[0][id]=…", per item). Two
 *     stamps, two gates (v1.26.0):
 *       - properties[_cellexia_seen] = "<preset>|<s|o|u>" goes on EVERY
 *         line of OUR product while the widget is visible — one-time AND
 *         subscription. It is the design-measurement exposure record: the
 *         ORDERS_CREATE webhook needs to know which design (and whether the
 *         subscription was preselected: s = yes, o = one-time preselected,
 *         u = unknown) the shopper SAW, for the one-time orders as much as
 *         for the subscriptions, or take rate per design has no denominator.
 *         An existing non-empty seen value is never overwritten.
 *       - selling_plan + properties[_cellexia_design] go on ONLY when the
 *         subscription is selected (unchanged semantics: design = preset).
 *     When the widget is absent, gated-hidden, or anything at all goes
 *     wrong, the request passes through byte-identical — an add-to-cart
 *     must never break, and OTHER vendors' cart calls (e.g. the page's
 *     bundle widget posting a different product) must never be touched. A
 *     line that ALREADY carries a selling_plan is completed, never
 *     rewritten: when it is OUR OWN plan id — a theme that serializes the
 *     widget's adopted selling_plan field into a hand-built payload without
 *     copying the properties inputs — the missing _cellexia_design and
 *     _cellexia_seen properties are stamped on (otherwise every such order
 *     gets the subscription but loses take-rate-by-design reporting,
 *     invisibly), while any other plan id passes through byte-identical
 *     (that line is another app's, and gets no seen stamp either).
 *  3. TRACK VARIANTS: forward the theme's custom variant picker
 *     (.pdp__options) into the widget so prices stay correct — clicks as well
 *     as change events, since swatch buttons/labels fire no change event —
 *     followed by a re-read of ?variant= and, failing that, of the theme's
 *     own current-variant field.
 *  4. VISIT BEACON (v1.27.0): an anonymous, cookie-free GET pixel to the app
 *     proxy (/apps/cellexia-subs/w) that records, per widget design and
 *     preselect, that a visitor SAW the widget (view), touched it (engage) and
 *     added to cart (atc). It is the denominator the Results tab needs to
 *     compare designs on conversion (orders per 100 exposed visits) and not
 *     only on take rate. Measurement only: every branch is contained, nothing
 *     is awaited, and a beacon that cannot be sent is simply not sent.
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
  /* The subscription_ultra_max preset's relocated one-time line — OUR
     markup that legitimately lives OUTSIDE the widget root once buy-box.js
     mounts it (see the satellite module there), so "skip our own markup"
     scans must skip it too. */
  var OWN_SATELLITE = '.cx-buybox-satellite[data-cellexia-satellite]';

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
   * The VISIBLE widget's state, or null. Null whenever the widget is absent
   * or launch-gated/hidden (getState() itself answers null then) — the
   * callers treat null as "do not touch anything". Any mode counts: a
   * one-time selection is exposure too, and gets the seen stamp (v1.26.0;
   * this used to be activeSubState(), subscription-only). Whether the line
   * ALSO gets selling_plan + _cellexia_design is subscriptionSelected().
   */
  function exposureState() {
    try {
      if (typeof subs.getState !== 'function') {
        return null;
      }
      var state = subs.getState();
      return state || null;
    } catch (err) {
      return null;
    }
  }

  /** The subscription branch of the patch: a plan is selected and known. */
  function subscriptionSelected(state) {
    return !!(state && state.mode === 'subscription' && state.sellingPlanId);
  }

  /**
   * properties[_cellexia_seen] value: "<preset>|<p>", p = s (subscription
   * was preselected on the rendered widget), o (one-time was), u (unknown:
   * a buy-box.js that predates the field). Same spelling as buy-box.js's
   * theme-form input; the webhook parses it (design-measurement/shared).
   */
  function preselectCode(state) {
    return state.preselect === true ? 's' : state.preselect === false ? 'o' : 'u';
  }

  function seenValue(state) {
    return String(state.design) + '|' + preselectCode(state);
  }

  /** A property value that already records something (never overwrite it). */
  function hasValue(value) {
    return value != null && String(value) !== '';
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
      /* A (re)mounted root is a root the visit beacon may not be watching
         yet (a section re-render replaces the node). Contained, hoisted, and
         a no-op until the beacon module below has booted. */
      observeVisitRoots();
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
   * upsells) is never rewritten — that would 422 their checkout. Every
   * matched item gets the missing _cellexia_seen stamp; the subscription
   * pair (selling_plan + _cellexia_design) only while the subscription is
   * selected. An item that already carries a selling_plan is completed,
   * never rewritten: OUR plan id (knowable only while the subscription is
   * selected — with one-time selected a plan the theme kept sending is not
   * provably ours, so it passes through untouched) gets whichever of
   * _cellexia_design / _cellexia_seen is missing (a theme that serialized
   * the widget's adopted field without the properties inputs), any other
   * plan id is another app's line and is left alone entirely. The spec'd
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

    var sub = subscriptionSelected(state);
    var changed = false;
    for (var j = 0; j < targets.length; j++) {
      var target = targets[j];
      var properties =
        target.properties && typeof target.properties === 'object'
          ? target.properties
          : null;
      var touched = false;
      if (target.selling_plan) {
        /* Already a subscription line. A foreign plan id is never ours to
           touch — and while one-time is selected NO plan is provably ours;
           our own (String-compared, themes carry it numeric or as text) may
           only be missing its properties (an empty value counts as missing:
           it records nothing either way). */
        if (!sub || String(target.selling_plan) !== String(state.sellingPlanId)) {
          continue;
        }
      } else if (sub) {
        target.selling_plan = planIdValue(state.sellingPlanId);
        touched = true;
      }
      properties = properties || {};
      if (sub && !hasValue(properties._cellexia_design)) {
        properties._cellexia_design = state.design;
        touched = true;
      }
      if (!hasValue(properties._cellexia_seen)) {
        properties._cellexia_seen = seenValue(state);
        touched = true;
      }
      if (touched) {
        target.properties = properties;
        changed = true;
      }
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
  var ITEM_DESIGN_KEY = /^items\[(\d+)\]\[properties\]\[_cellexia_design\]$/;
  var ITEM_SEEN_KEY = /^items\[(\d+)\]\[properties\]\[_cellexia_seen\]$/;

  /**
   * The `items[i][…]` bracket shape, which is what jQuery produces for
   * $.ajax({ url: '/cart/add.js', data: { items: [{ id, quantity }] } }) —
   * "items%5B0%5D%5Bid%5D=…". Without this the flat params.get('id') lookup
   * finds nothing and the request goes out with no selling plan at all: the
   * shopper who chose the subscription silently gets a one-time line.
   *
   * Returns the indexes to touch, applying the same per-item rules as the
   * JSON path — another vendor's variant is never rewritten: `plan` lists
   * the items that need selling_plan, `design` the ones that need
   * _cellexia_design (both subscription-only), `seen` the ones that need
   * _cellexia_seen (every mode). An item that already carries a plan is
   * completed only when that plan is provably OURS (subscription selected,
   * same id — a theme that serialized the widget's adopted field without
   * the properties inputs); planned with any other id it is left alone. All
   * three empty ⇒ the body passes through byte-identical.
   */
  function itemIndexTargets(pairs, state) {
    var ids = {};
    var planned = {};
    var designed = {};
    var seen = {};
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      var value = pairs[i][1];
      var idMatch = ITEM_ID_KEY.exec(key);
      if (idMatch) {
        ids[idMatch[1]] = value;
        continue;
      }
      if (!hasValue(value)) {
        continue; /* an empty plan/property records nothing — "missing" */
      }
      var planMatch = ITEM_PLAN_KEY.exec(key);
      if (planMatch) {
        planned[planMatch[1]] = value;
        continue;
      }
      var designMatch = ITEM_DESIGN_KEY.exec(key);
      if (designMatch) {
        designed[designMatch[1]] = true;
        continue;
      }
      var seenMatch = ITEM_SEEN_KEY.exec(key);
      if (seenMatch) {
        seen[seenMatch[1]] = true;
      }
    }
    var sub = subscriptionSelected(state);
    var targets = { plan: [], design: [], seen: [] };
    for (var index in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, index)) {
        continue;
      }
      if (!matchesVariant(ids[index], state)) {
        continue;
      }
      if (planned[index] != null) {
        if (!sub || String(planned[index]) !== String(state.sellingPlanId)) {
          continue; /* another app's line (or not provably ours) */
        }
      } else if (sub) {
        targets.plan.push(index);
      }
      if (sub && !designed[index]) {
        targets.design.push(index);
      }
      if (!seen[index]) {
        targets.seen.push(index);
      }
    }
    return targets;
  }

  function hasItemTargets(targets) {
    return !!(targets.plan.length || targets.design.length || targets.seen.length);
  }

  /** Write itemIndexTargets() into a container with .set() (params/FormData). */
  function applyItemTargets(container, targets, state) {
    var i;
    for (i = 0; i < targets.plan.length; i++) {
      container.set(
        'items[' + targets.plan[i] + '][selling_plan]',
        String(state.sellingPlanId)
      );
    }
    for (i = 0; i < targets.design.length; i++) {
      container.set(
        'items[' + targets.design[i] + '][properties][_cellexia_design]',
        state.design
      );
    }
    for (i = 0; i < targets.seen.length; i++) {
      container.set(
        'items[' + targets.seen[i] + '][properties][_cellexia_seen]',
        seenValue(state)
      );
    }
  }

  /**
   * The flat shape (id=…&quantity=…): which stamps this body still needs,
   * given a `get(key)` reader over it, or null for "pass through untouched"
   * — not our variant, a plan that is not provably ours, or nothing missing.
   * Shared by the urlencoded and FormData flat paths so the two cannot
   * drift apart. Same completion rule as the bracket shape.
   */
  function flatStamps(get, state) {
    var id = get('id');
    if (!id || !matchesVariant(id, state)) {
      return null;
    }
    var sub = subscriptionSelected(state);
    var stamps = { plan: false, design: false, seen: false };
    var existingPlan = get('selling_plan');
    if (hasValue(existingPlan)) {
      if (!sub || String(existingPlan) !== String(state.sellingPlanId)) {
        return null;
      }
    } else if (sub) {
      stamps.plan = true;
    }
    stamps.design = sub && !hasValue(get('properties[_cellexia_design]'));
    stamps.seen = !hasValue(get('properties[_cellexia_seen]'));
    return stamps.plan || stamps.design || stamps.seen ? stamps : null;
  }

  function applyFlatStamps(container, stamps, state) {
    if (stamps.plan) {
      container.set('selling_plan', String(state.sellingPlanId));
    }
    if (stamps.design) {
      container.set('properties[_cellexia_design]', state.design);
    }
    if (stamps.seen) {
      container.set('properties[_cellexia_seen]', seenValue(state));
    }
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
    if (params.get('id')) {
      /* Flat shape: id=…&quantity=… */
      var stamps = flatStamps(function (key) {
        return params.get(key);
      }, state);
      if (!stamps) {
        return null; /* not our product, or nothing to add — untouched */
      }
      applyFlatStamps(params, stamps, state);
      return params.toString();
    }
    var pairs = entryPairs(params);
    if (!pairs) {
      return null;
    }
    var targets = itemIndexTargets(pairs, state);
    if (!hasItemTargets(targets)) {
      return null; /* no id at all, or nothing of ours — untouched */
    }
    applyItemTargets(params, targets, state);
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
    var stamps = null;
    var targets = null;
    if (formData.get('id')) {
      /* Flat shape — the same completion rules as the urlencoded flat path
         (flatStamps): our own plan is completed, anything else passes
         through untouched. */
      stamps = flatStamps(function (key) {
        return formData.get(key);
      }, state);
      if (!stamps) {
        return null;
      }
    } else {
      /* Same items[i][id] shape as the urlencoded path (a FormData built by
         the theme from an items[] payload). */
      targets = itemIndexTargets(pairs, state);
      if (!hasItemTargets(targets)) {
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
      applyItemTargets(copy, targets, state);
    } else {
      applyFlatStamps(copy, stamps, state);
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

  /**
   * "Does this cart body target one of OUR variants": the atc beacon's
   * question, which is NOT injectBody()'s question ("did anything change").
   * WHY a separate check (v1.27.0 review): on a theme-form install
   * buy-box.js already wrote selling_plan and both properties into the
   * product form; a theme whose add-to-cart builds FormData(form) and calls
   * fetch (no submit event) then sends a body with nothing missing, so
   * injectBody() answers null and the shopper's add would never be counted,
   * although the order itself is (it carries _cellexia_seen). Reads only the
   * id (flat), items[i][id] (bracket) or items[].id / id (JSON), so a foreign
   * variant is still never counted. Cheap by construction: called only when
   * injectBody() had nothing to do. Any failure reads as "not ours".
   */
  function bodyTargetsOurs(body, state) {
    try {
      var pairs = null;
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        if (typeof body.get !== 'function' || typeof body.entries !== 'function') {
          return false; /* legacy FormData without inspection */
        }
        if (body.get('id')) {
          return matchesVariant(body.get('id'), state);
        }
        pairs = entryPairs(body);
      } else {
        var text =
          typeof body === 'string'
            ? body
            : typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams
              ? body.toString()
              : null;
        if (text === null) {
          return false;
        }
        var head = text.replace(/^\s+/, '').charAt(0);
        if (head === '{' || head === '[') {
          var payload = JSON.parse(text);
          var items =
            payload && Object.prototype.toString.call(payload.items) === '[object Array]'
              ? payload.items
              : payload && typeof payload === 'object' && payload.id != null
                ? [payload]
                : [];
          for (var i = 0; i < items.length; i++) {
            if (items[i] && typeof items[i] === 'object' && matchesVariant(items[i].id, state)) {
              return true;
            }
          }
          return false;
        }
        if (typeof window.URLSearchParams !== 'function') {
          return false;
        }
        var params = new URLSearchParams(text);
        if (params.get('id')) {
          return matchesVariant(params.get('id'), state);
        }
        pairs = entryPairs(params);
      }
      if (!pairs) {
        return false;
      }
      for (var j = 0; j < pairs.length; j++) {
        if (ITEM_ID_KEY.test(pairs[j][0]) && matchesVariant(pairs[j][1], state)) {
          return true;
        }
      }
      return false;
    } catch (err) {
      return false;
    }
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
          var state = exposureState();
          if (state) {
            var nextBody = injectBody(init.body, state);
            /* atc is decided on "targets our variant", not on "was changed":
               a body already carrying every stamp is still an add. */
            if (nextBody !== null || bodyTargetsOurs(init.body, state)) {
              noteCartAdd(state);
            }
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
          var state = exposureState();
          if (state) {
            var nextBody = injectBody(body, state);
            /* Same atc rule as the fetch wrapper: ours-complete counts too. */
            if (nextBody !== null || bodyTargetsOurs(body, state)) {
              noteCartAdd(state);
            }
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
     second. Since v1.6.8 buy-box.js also carries the GENERIC event-free
     layers (product-area click delegation + a visibility-gated [name="id"]
     poll), which catch pickers this file has never heard of — this module
     stays the picker-specific fast path and keeps no interval of its own.
     Ids the widget does not recognise are ignored inside buy-box.js, so
     every push here is safe. */

  function pushVariant(value) {
    /* Trimmed: the client's live pills ship one variant id with trailing
       whitespace inside the attribute value, and buy-box.js compares ids
       by exact string against the island keys. */
    var id = value == null ? '' : String(value).replace(/^\s+|\s+$/g, '');
    if (id === '') {
      return false;
    }
    try {
      if (typeof subs.setVariant !== 'function') {
        return false;
      }
      subs.setVariant(id);
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
   * Attribute vocabulary for a variant id carried on a non-field element.
   * data-val-id is the client's CURRENT Sleepify pill markup (v1.11.0,
   * observed live — the pills moved off data-variant-id, and one pill ships
   * its id with trailing whitespace; pushVariant trims).
   */
  function markerId(el) {
    return (
      el.getAttribute('data-variant-id') ||
      el.getAttribute('data-val-id') ||
      el.getAttribute('data-variant') ||
      ''
    );
  }

  /** Trimmed value for the isKnownVariant check (attribute may pad ids). */
  function cleanId(value) {
    return value == null ? '' : String(value).replace(/^\s+|\s+$/g, '');
  }

  /** The theme currently renders this element as the selected option. */
  function markerActiveSignal(el) {
    try {
      if (el.checked === true) {
        return true;
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
   * an option-picker container, WITHOUT the active signal.
   */
  function markerIsUnpickedOption(el) {
    if (markerActiveSignal(el)) {
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

  /**
   * Last resort for themes that never touch ?variant=: the state the theme
   * itself maintains for the current selection, in trust order —
   * `[name="id"]` fields (canonical: what its own add-to-cart submits), then
   * carriers the theme paints as SELECTED (active class / aria / checked),
   * then a passive current-variant marker outside any picker. The tiers are
   * the fix for the live one-behind defect (v1.11.0): another vendor's
   * product rows on the client's PDP carry [data-variant-id] naming OUR
   * variants and update on their own schedule, so the old first-match read
   * raced them and pushed the PREVIOUS variant after every pill click. The
   * theme's own selection paint now always outranks a passive bystander, and
   * an unpicked swatch is never evidence at all.
   *
   * This is the one document-wide lookup here that deliberately reads FOREIGN
   * markup (it is the theme's own state we are after, so it cannot be
   * class-qualified to ours). It is safe because it is strictly READ-ONLY —
   * nothing is written, marked or moved — every candidate must name one of
   * OUR variant ids to be used at all, and anything inside our own widget,
   * wrapper or satellite is skipped.
   */
  function syncVariantFromDom() {
    try {
      var known = knownVariantIds();
      var fields = document.querySelectorAll(
        'input[name="id"], select[name="id"], [data-variant-id], [data-val-id], [data-variant]'
      );
      var fieldPick = null;
      var activePick = null;
      var passivePick = null;
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (
          field.closest &&
          (field.closest(OWN_WIDGET) ||
            field.closest(OWN_WRAPPER) ||
            field.closest(OWN_SATELLITE))
        ) {
          continue; /* our own markup — the theme's state is what we want */
        }
        var isField = field.getAttribute('name') === 'id';
        var id = cleanId(isField ? field.value : markerId(field));
        if (!id || !isKnownVariant(id, known)) {
          continue;
        }
        if (isField) {
          if (fieldPick === null) {
            fieldPick = id;
          }
        } else if (markerActiveSignal(field)) {
          if (activePick === null) {
            activePick = id;
          }
        } else if (!markerIsUnpickedOption(field) && passivePick === null) {
          passivePick = id;
        }
      }
      var pick = fieldPick !== null ? fieldPick : activePick;
      if (pick === null) {
        pick = passivePick;
      }
      if (pick !== null) {
        pushVariant(pick);
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
          markerId(node) || (typeof node.value === 'string' ? node.value : '');
        if (cleanId(id)) {
          pushVariant(id);
          break;
        }
        node = node.parentElement;
      }
      /* Staggered re-reads instead of one 60ms shot: themes settle their
         own state (and bystander widgets settle theirs) on unpredictable
         schedules, and the tiers above make a late re-read corrective
         rather than corruptive. buy-box.js's own click delegation + poll
         sit underneath as the always-on net. */
      window.setTimeout(reReadVariant, 60);
      window.setTimeout(reReadVariant, 350);
      window.setTimeout(reReadVariant, 900);
    } catch (err) {
      /* display-only — never matters */
    }
  }

  document.addEventListener('change', onPickerInteraction, true);
  document.addEventListener('click', onPickerInteraction, true);

  window.addEventListener('popstate', syncVariantFromUrl);
  window.addEventListener('cx:locationchange', syncVariantFromUrl);

  /* ── 4. Visit beacon (v1.27.0) ──────────────────────────────────────────────
     WHY: take rate per design (from the _cellexia_seen order stamp) has
     orders as its denominator, so a design that quietly sells FEWER orders
     but converts more of them to subscriptions looks like a winner. The
     honest comparison is per exposed visit: orders per 100 visits and
     subscriptions per 100 visits, keyed by exactly the same design + preselect
     stamp as the order facts, so numerator and denominator agree. This module
     records that denominator: a GET pixel to the app proxy per page view,
     per event, at most once per event per (design|preselect).

     What it is NOT: it is not an experiment assignment (the visitor id below
     is a browser-local anonymous id, so the experiment kernel's no-RNG rule
     does not apply), it carries no personal data (no email, no customer id,
     no IP is read here; the id is random and never leaves the browser except
     inside this request), and it needs no consent gate (merchant decision,
     v1.27.0). Nothing here may ever affect the page: every entry point is
     wrapped, nothing is awaited, and a beacon that cannot be sent is not sent.

     Skipped entirely in an admin preview (?cx_preview= in this page's URL),
     in the theme editor (Shopify.designMode, the merchant customising the
     theme is not a shopper) and, per event, whenever getState() answers null
     (widget hidden, gated or absent): a visitor who cannot see the widget is
     not exposed to a design.

     Wire format (see app/routes/proxy.w.tsx): e = view|engage|atc, d = design,
     p = s|o|u (preselect), v = variant id, c = ISO country (Shopify.country),
     cur = active currency, dv = m|t|d device, vid = visitor id, pv = page-view
     id, t = Date.now(), m = s|o (atc only: subscription or one-time line).

     Transport: new Image().src, the one request shape every browser sends
     without a CORS preflight and without blocking anything; fetch(keepalive,
     no-cors) only where Image is missing (never awaited). The path is pinned
     to the app-proxy subpath by tests/proxy-subpath.test.ts. */

  var VISIT_PATH = '/apps/cellexia-subs/w';
  var VISIT_ID_KEY = 'cellexia_vid';
  var VISIT_ID_SHAPE = /^[A-Za-z0-9_-]{8,32}$/;
  var VISIT_ID_ALPHABET =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  var visitsReady = false; /* module booted (false during the early mount passes) */
  var visitsOff = false; /* admin preview / theme editor: never measure the merchant */
  var visitsSent = {}; /* "event:design|p[:m]" → true (once per page load) */
  var visitorIdValue = null; /* memoised vid */
  var pageViewId = ''; /* pv: 8 chars per page load */
  var visitObserver = null; /* IntersectionObserver, when the browser has one */
  var visitWatch = []; /* [{ el, timer }] roots under observation */

  /**
   * length random URL-safe characters. crypto.getRandomValues when the
   * browser has it, Math.random otherwise: this is an anonymous browser-local
   * id, not an experiment assignment, so the kernel's no-RNG rule does not
   * apply and a weaker generator only risks a (harmless) collision.
   */
  function randomToken(length) {
    var bytes = null;
    try {
      var cryptoApi = window.crypto || window.msCrypto;
      if (
        cryptoApi &&
        typeof cryptoApi.getRandomValues === 'function' &&
        typeof Uint8Array === 'function'
      ) {
        bytes = cryptoApi.getRandomValues(new Uint8Array(length));
      }
    } catch (err) {
      bytes = null;
    }
    var out = '';
    for (var i = 0; i < length; i++) {
      var n = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += VISIT_ID_ALPHABET.charAt(n % VISIT_ID_ALPHABET.length);
    }
    return out;
  }

  /** window.localStorage / sessionStorage, or null: the ACCESS can throw. */
  function safeStore(name) {
    try {
      var store = window[name];
      return store &&
        typeof store.getItem === 'function' &&
        typeof store.setItem === 'function'
        ? store
        : null;
    } catch (err) {
      return null;
    }
  }

  function storeRead(store, key) {
    try {
      return store ? store.getItem(key) : null;
    } catch (err) {
      return null;
    }
  }

  /** True only when the value can be read back (quota / private mode). */
  function storeWrite(store, key, value) {
    try {
      if (!store) {
        return false;
      }
      store.setItem(key, value);
      return store.getItem(key) === value;
    } catch (err) {
      return false;
    }
  }

  /**
   * The visitor id: localStorage first (a returning visitor is one visitor
   * across days, which is what "visits per day" needs), sessionStorage when
   * that is unavailable, a per-page value as the last resort. Validated on
   * read so a tampered value never reaches the URL.
   */
  function visitorId() {
    if (visitorIdValue) {
      return visitorIdValue;
    }
    var local = safeStore('localStorage');
    var session = safeStore('sessionStorage');
    var found = storeRead(local, VISIT_ID_KEY);
    if (!VISIT_ID_SHAPE.test(String(found || ''))) {
      found = storeRead(session, VISIT_ID_KEY);
    }
    if (!VISIT_ID_SHAPE.test(String(found || ''))) {
      found = randomToken(16);
      if (!storeWrite(local, VISIT_ID_KEY, found)) {
        storeWrite(session, VISIT_ID_KEY, found);
      }
    }
    visitorIdValue = String(found);
    return visitorIdValue;
  }

  function shopifyGlobal() {
    try {
      var shopify = window.Shopify;
      return shopify && typeof shopify === 'object' ? shopify : null;
    } catch (err) {
      return null;
    }
  }

  /** Shopify.country as uppercase ISO-2, else '' (the server maps it to a market). */
  function visitCountry() {
    var shopify = shopifyGlobal();
    var code = shopify && shopify.country ? String(shopify.country).toUpperCase() : '';
    return /^[A-Z]{2}$/.test(code) ? code : '';
  }

  /** Shopify.currency.active, else ''. */
  function visitCurrency() {
    var shopify = shopifyGlobal();
    var code =
      shopify && shopify.currency && shopify.currency.active
        ? String(shopify.currency.active).toUpperCase()
        : '';
    return /^[A-Z]{3}$/.test(code) ? code : '';
  }

  /**
   * m | t | d from a deliberately simple heuristic: viewport width first
   * (< 768 mobile, < 1024 tablet), and a coarse primary pointer on a wide
   * viewport reads as a tablet rather than a desktop. Good enough to split
   * the Results tab by device; never used for anything else.
   */
  function visitDevice() {
    try {
      var width = window.innerWidth;
      var coarse = false;
      if (typeof window.matchMedia === 'function') {
        var query = window.matchMedia('(pointer: coarse)');
        coarse = !!(query && query.matches);
      }
      if (typeof width === 'number' && width > 0) {
        return width < 768 ? 'm' : width < 1024 || coarse ? 't' : 'd';
      }
      return coarse ? 'm' : 'd';
    } catch (err) {
      return 'd';
    }
  }

  function visitQuery(event, state, mode) {
    var enc = encodeURIComponent;
    var query =
      'e=' +
      enc(event) +
      '&d=' +
      enc(String(state.design)) +
      '&p=' +
      preselectCode(state) +
      '&v=' +
      enc(state.variantId == null ? '' : String(state.variantId)) +
      '&c=' +
      enc(visitCountry()) +
      '&cur=' +
      enc(visitCurrency()) +
      '&dv=' +
      visitDevice() +
      '&vid=' +
      enc(visitorId()) +
      '&pv=' +
      enc(pageViewId) +
      '&t=' +
      Date.now();
    if (mode) {
      query += '&m=' + enc(mode);
    }
    return query;
  }

  /** Fire and forget. Never awaited, never thrown from. */
  function transmitVisit(url) {
    try {
      if (typeof window.Image === 'function') {
        var pixel = new window.Image();
        pixel.src = url;
      } else if (typeof originalFetch === 'function') {
        /* The ORIGINAL fetch, not our own patched wrapper. */
        var pending = originalFetch.call(window, url, {
          method: 'GET',
          keepalive: true,
          credentials: 'omit',
          mode: 'no-cors'
        });
        if (pending && typeof pending.catch === 'function') {
          pending.catch(function () {
            /* a beacon that did not arrive is not worth an unhandled rejection */
          });
        }
      }
    } catch (err) {
      /* a beacon that cannot be sent is not sent */
    }
  }

  /**
   * Send one event, once per page load per (design|preselect) and, for atc,
   * per mode too (a shopper who adds one-time and then switches to the
   * subscription counts for both flags on the server, never twice for one).
   * Returns true only when a request actually went out.
   */
  function sendVisit(event, mode) {
    try {
      if (!visitsReady || visitsOff) {
        return false;
      }
      var state = exposureState();
      if (!state) {
        return false;
      }
      var once = event + ':' + seenValue(state) + (mode ? ':' + mode : '');
      if (visitsSent[once]) {
        return false;
      }
      visitsSent[once] = true;
      transmitVisit(VISIT_PATH + '?' + visitQuery(event, state, mode));
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * atc from the cart-request patch: called when the intercepted body
   * targets OUR variant, whether the patch injected stamps into it or found
   * them already there (bodyTargetsOurs). m is the widget's branch
   * (subscription selected ⇒ the line carries our plan, injected or
   * completed; otherwise a one-time line).
   */
  function noteCartAdd(state) {
    sendVisit('atc', subscriptionSelected(state) ? 's' : 'o');
  }

  /**
   * atc from a theme product form (the buy-box.js install shape, where no
   * cart request is patched): a capture-phase submit of a /cart/add form
   * that carries our seen input, enabled (releaseForm() disables it while
   * the widget is hidden). m from the widget's current mode.
   */
  function onVisitSubmit(event) {
    try {
      var form = event && event.target;
      if (!form || form.tagName !== 'FORM' || typeof form.querySelector !== 'function') {
        return;
      }
      if (!isCartAddUrl(form.getAttribute('action') || '')) {
        return;
      }
      var seen = form.querySelector('input[name="properties[_cellexia_seen]"]');
      if (!seen || seen.disabled) {
        return;
      }
      var state = exposureState();
      if (!state) {
        return;
      }
      sendVisit('atc', state.mode === 'subscription' ? 's' : 'o');
    } catch (err) {
      /* measurement only */
    }
  }

  /** engage: the first interaction inside a widget root (or its satellite). */
  function onVisitEngage(event) {
    try {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest(OWN_WIDGET) || target.closest(OWN_SATELLITE)) {
        sendVisit('engage', null);
      }
    } catch (err) {
      /* measurement only */
    }
  }

  function visitWatchFor(el) {
    for (var i = 0; i < visitWatch.length; i++) {
      if (visitWatch[i].el === el) {
        return visitWatch[i];
      }
    }
    return null;
  }

  function stopVisitObserver() {
    try {
      if (visitObserver) {
        visitObserver.disconnect();
      }
    } catch (err) {
      /* nothing to release */
    }
    visitObserver = null;
  }

  function viewTimerFor(watch) {
    return function () {
      watch.timer = null;
      /* Sent ⇒ this page load's view is recorded; the observer has done its
         job. Not sent (hidden at that instant) ⇒ keep watching. */
      if (sendVisit('view', null)) {
        stopVisitObserver();
      }
    };
  }

  /**
   * view = a root at least half in the viewport for a full second, so a
   * scroll-past never counts and a page opened in a background tab (nothing
   * intersects) never counts. Each entry starts or cancels that root's dwell
   * timer; isIntersecting is missing on some older engines, so the ratio
   * decides and isIntersecting only vetoes.
   */
  function onVisitIntersect(entries) {
    try {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var watch = visitWatchFor(entry.target);
        if (!watch) {
          continue;
        }
        var visible =
          Number(entry.intersectionRatio) >= 0.5 && entry.isIntersecting !== false;
        if (visible && watch.timer === null) {
          watch.timer = window.setTimeout(viewTimerFor(watch), 1000);
        } else if (!visible && watch.timer !== null) {
          window.clearTimeout(watch.timer);
          watch.timer = null;
        }
      }
    } catch (err) {
      /* measurement only */
    }
  }

  /** Observe every widget root not yet under observation (idempotent). */
  function observeVisitRoots() {
    if (!visitsReady || visitsOff || !visitObserver) {
      return;
    }
    try {
      var roots = document.querySelectorAll(OWN_WIDGET);
      for (var i = 0; i < roots.length; i++) {
        if (!visitWatchFor(roots[i])) {
          visitWatch.push({ el: roots[i], timer: null });
          visitObserver.observe(roots[i]);
        }
      }
    } catch (err) {
      /* measurement only */
    }
  }

  function bootVisits() {
    try {
      visitsOff = String(window.location.search || '').indexOf('cx_preview=') !== -1;
    } catch (err) {
      visitsOff = false;
    }
    /* The theme editor (Online Store > Customize): Shopify sets the
       documented editor-only global Shopify.designMode = true inside the
       customiser's preview frame, whose URL carries no cx_preview=. The
       merchant clicking through designs there is not a shopper; without
       this gate every editing session would add visits with zero orders to
       exactly the design being edited and drag its conversion down. The
       cart stamps stay on (the editor's own add-to-cart still works). */
    var shopify = shopifyGlobal();
    if (shopify && shopify.designMode === true) {
      visitsOff = true;
    }
    if (visitsOff) {
      return;
    }
    pageViewId = randomToken(8);
    visitsReady = true;
    document.addEventListener('pointerdown', onVisitEngage, true);
    document.addEventListener('click', onVisitEngage, true);
    document.addEventListener('keydown', onVisitEngage, true);
    document.addEventListener('change', onVisitEngage, true);
    document.addEventListener('submit', onVisitSubmit, true);
    if (typeof window.IntersectionObserver === 'function') {
      try {
        visitObserver = new window.IntersectionObserver(onVisitIntersect, {
          threshold: [0.5]
        });
      } catch (err) {
        visitObserver = null;
      }
    }
    if (visitObserver) {
      observeVisitRoots();
      /* Roots that arrive later: a late DOM, a section re-render (tryMount
         also calls observeVisitRoots after every successful mount). */
      document.addEventListener('DOMContentLoaded', observeVisitRoots);
      document.addEventListener('shopify:section:load', observeVisitRoots);
    } else {
      /* No IntersectionObserver: a widget that is visible 1.5 s after boot
         counts as viewed. Coarser, but still gated on getState(). */
      window.setTimeout(function () {
        sendVisit('view', null);
      }, 1500);
    }
  }

  try {
    bootVisits();
  } catch (err) {
    /* the beacon is never worth an exception on a product page */
  }
})();
