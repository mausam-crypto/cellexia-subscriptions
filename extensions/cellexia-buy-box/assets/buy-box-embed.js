/**
 * Cellexia Buy Box — APP EMBED companion script. Vanilla JS, zero
 * dependencies, loaded (defer, after buy-box.js) ONLY by
 * blocks/buy-box-embed.liquid, i.e. only on product pages with selling
 * plans and only when the app embed is enabled.
 *
 * Responsibilities:
 *  1. MOUNT: move the server-rendered [hidden] .cx-buybox-embed wrapper from
 *     body-end into the PDP's buy column and unhide the WRAPPER only. The
 *     inner widget's launch gate ([data-cx-gated][hidden] until the shop
 *     metafield cellexia.launch_status is "live") is buy-box.js's business
 *     and is deliberately NOT touched here — an enabled embed shows nothing
 *     to visitors until go-live, and the ?cx_preview= reveal works
 *     unchanged. If a section-targeted Cellexia app block is present, the
 *     embed stays dormant (the block wins; never two widgets).
 *  2. PATCH CART REQUESTS: themes like cellexialabs.com's "Sleepify" have NO
 *     <form action="/cart/add"> — add-to-cart is a jQuery XHR. window.fetch
 *     and XMLHttpRequest are wrapped once; POSTs whose path ends in
 *     /cart/add or /cart/add.js get the selected selling_plan (and the
 *     properties[_cx_design] attribution) injected into the body, whatever
 *     its shape: FormData, URLSearchParams, urlencoded string, JSON
 *     items[], flat JSON {id, quantity}. When one-time is selected, the
 *     widget is absent, gated-hidden, or anything at all goes wrong, the
 *     request passes through byte-identical — an add-to-cart must never
 *     break, and OTHER vendors' cart calls (e.g. the page's bundle widget
 *     posting a different product) must never be touched.
 *  3. TRACK VARIANTS: forward the theme's custom variant picker
 *     (.pdp__options) changes and ?variant= URL updates into the widget so
 *     prices stay correct.
 *
 * State is read exclusively via the guarded window.CellexiaSubs global that
 * buy-box.js maintains. NAMESPACE HAZARD: the host page also carries an
 * unrelated vendor using "cx-*" element ids (cx-i18n, cx-cart-config, ...)
 * — this file never creates element ids, never queries id selectors, and
 * shares nothing except window.CellexiaSubs.
 */
(function () {
  'use strict';

  if (window.CellexiaSubs && window.CellexiaSubs.embedMounted) {
    return;
  }
  var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
  if (subs.embedLoaded) {
    return;
  }
  subs.embedLoaded = true;

  /* ── Shared helpers ─────────────────────────────────────────────────────── */

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
    var widgets = document.querySelectorAll('[data-cx-buybox]');
    for (var i = 0; i < widgets.length; i++) {
      if (!widgets[i].closest('[data-cx-embed]')) {
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

  function placeAt(wrapper, anchor) {
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

  /**
   * Preview sessions must never fail silently: when no anchor matched but a
   * preview token is in sessionStorage (the admin following a ?cx_preview=
   * link), show a plain-English hint card. Real visitors have no token and
   * see nothing. No element id (namespace hazard), English only (admin-only
   * diagnostics are not customer-facing copy).
   */
  function maybeShowDiagnostic() {
    try {
      if (diagnosticShown || !document.body) {
        return;
      }
      if (!window.sessionStorage.getItem('cx_preview_token')) {
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
      /* sessionStorage blocked → no preview session → nothing to show */
    }
  }

  /**
   * One mount attempt. Returns true when there is nothing left to do (either
   * mounted, or legitimately dormant); false asks the scheduler to retry.
   */
  function tryMount(finalAttempt) {
    try {
      if (subs.embedMounted) {
        return true;
      }
      var wrapper = document.querySelector('[data-cx-embed]');
      if (!wrapper) {
        return true; /* liquid rendered nothing (shouldn't happen: script is conditional) */
      }
      if (sectionWidgetPresent()) {
        return true; /* section block wins — embed stays hidden and dormant */
      }

      var anchor = null;
      var customSelector = wrapper.getAttribute('data-cx-anchor');
      var customPosition = wrapper.getAttribute('data-cx-anchor-pos') || 'before';
      if (customSelector) {
        var customEl = safeQuery(customSelector);
        if (customEl) {
          anchor = { el: customEl, pos: customPosition };
        } else if (!finalAttempt) {
          /* Give a late-rendering custom anchor its 1500ms grace before
             falling back to the heuristics. */
          return false;
        } else {
          warnOnce(
            'custom anchor selector "' +
              customSelector +
              '" matched nothing — falling back to automatic placement.'
          );
        }
      }
      if (!anchor) {
        anchor = autoAnchor();
      }
      if (!anchor) {
        if (finalAttempt) {
          warnOnce(
            'no placement anchor found on this page — the widget stays ' +
              'unmounted. Set a custom CSS selector in the Buy box designer ' +
              '→ Placement (or on the app embed in the theme editor).'
          );
          maybeShowDiagnostic();
        }
        return false;
      }

      if (!placeAt(wrapper, anchor)) {
        return false;
      }
      /* Unhide the WRAPPER only. The inner widget keeps its own
         [data-cx-gated][hidden] launch gate, governed by buy-box.js
         (metafield live / validated preview token) — mounting must never
         bypass it. */
      wrapper.removeAttribute('hidden');
      subs.embedMounted = true;
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
         template sections). */
      finalTimer = window.setTimeout(function () {
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
      properties._cx_design = state.design;
      target.properties = properties;
      changed = true;
    }
    return changed;
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
    if (params.get('selling_plan')) {
      return null; /* someone already set it — not ours to overwrite */
    }
    var id = params.get('id');
    if (!id || !matchesVariant(id, state)) {
      return null; /* not our product (or no id) — pass through untouched */
    }
    params.set('selling_plan', String(state.sellingPlanId));
    params.set('properties[_cx_design]', state.design);
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
    if (formData.get('selling_plan')) {
      return null;
    }
    var id = formData.get('id');
    if (!id || !matchesVariant(id, state)) {
      return null;
    }
    var copy;
    try {
      copy = new FormData();
      var iterator = formData.entries();
      var step;
      while (!(step = iterator.next()).done) {
        copy.append(step.value[0], step.value[1]);
      }
    } catch (err) {
      return null;
    }
    copy.set('selling_plan', String(state.sellingPlanId));
    copy.set('properties[_cx_design]', state.design);
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
     own history patch; this adds the Sleepify theme's custom size <select>
     (.pdp__options — NOT a product form) and a post-change URL re-read.
     Interval-free by design. Unknown values are ignored inside the widget. */

  function syncVariantFromUrl() {
    try {
      var id = new URLSearchParams(window.location.search).get('variant');
      if (id && typeof subs.setVariant === 'function') {
        subs.setVariant(id);
      }
    } catch (err) {
      /* display-only — never matters */
    }
  }

  document.addEventListener(
    'change',
    function (event) {
      try {
        var target = event.target;
        if (!target || !target.closest || !target.closest('.pdp__options')) {
          return;
        }
        if (target.value != null && typeof subs.setVariant === 'function') {
          /* When the theme's <select> holds real variant ids this hits
             directly; otherwise it is a harmless no-op... */
          subs.setVariant(String(target.value));
        }
        /* ...and the URL the theme updates right after is the fallback. */
        window.setTimeout(syncVariantFromUrl, 60);
      } catch (err) {
        /* display-only — never matters */
      }
    },
    true
  );

  window.addEventListener('popstate', syncVariantFromUrl);
  window.addEventListener('cx:locationchange', syncVariantFromUrl);
})();
