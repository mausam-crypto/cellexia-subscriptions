/* PREVIEW COPY — source of truth: extensions/treatment-widgets/assets/ */
/* Cellexia widgets A/B/E/F + committed card. ES5 IIFE, no deps. Pure helpers
   on window.CellexiaWidgets, tested in tests/theme-ext-widget-logic.test.ts. */
(function (win) {
  'use strict';

  var CX = win.CellexiaWidgets || {};

  /* ── pure helpers (no I/O) ── */

  CX.DEFAULT_CADENCE = { 1: 4, 2: 8, 3: 12 };

  CX.cadenceForQuantity = function (qty, defaults) {
    var d = defaults || {};
    var v = d[String(qty)];
    if (v == null) v = d[qty];
    if (typeof v === 'string') v = parseInt(v, 10);
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    var f = CX.DEFAULT_CADENCE[qty];
    return typeof f === 'number' ? f : 4;
  };

  /* "Delivery every 4 weeks" / "2 months" / "30 days" → weeks */
  CX.parseIntervalWeeks = function (text) {
    if (!text) return null;
    var s = String(text);
    var m = s.match(/(\d+)\s*week/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(\d+)\s*month/i);
    if (m) return parseInt(m[1], 10) * 4;
    m = s.match(/(\d+)\s*day/i);
    if (m) return Math.max(1, Math.round(parseInt(m[1], 10) / 7));
    return null;
  };

  CX.normalizePlans = function (rawPlans) {
    var out = [];
    var arr = rawPlans || [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i] || {};
      var weeks = CX.parseIntervalWeeks(p.option);
      if (weeks == null) weeks = CX.parseIntervalWeeks(p.name);
      out.push({
        id: p.id,
        name: p.name || '',
        percentOff: p.valueType === 'percentage' ? (p.value || 0) : 0,
        intervalWeeks: weeks
      });
    }
    return out;
  };

  CX.pickPlanForWeeks = function (plans, weeks) {
    if (!plans || !plans.length) return null;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < plans.length; i++) {
      var w = plans[i].intervalWeeks;
      var dist = w == null ? 9999 : Math.abs(w - weeks);
      if (dist < bestDist) { bestDist = dist; best = plans[i]; }
    }
    return best;
  };

  CX.maxPercentOff = function (plans) {
    var max = 0;
    var arr = plans || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].percentOff > max) max = arr[i].percentOff;
    return max;
  };

  CX.planPriceCents = function (unitPriceCents, percentOff) {
    return Math.round((unitPriceCents * (100 - (percentOff || 0))) / 100);
  };

  CX.computeSavingsPercent = function (oneTimeCents, planCents) {
    if (!oneTimeCents || oneTimeCents <= 0) return 0;
    if (planCents == null || planCents >= oneTimeCents) return 0;
    return Math.round(((oneTimeCents - planCents) / oneTimeCents) * 100);
  };

  CX.cyclesPerYear = function (intervalWeeks) {
    return !intervalWeeks || intervalWeeks <= 0 ? 0 : 52 / intervalWeeks;
  };

  CX.estimateAnnualSavingCents = function (unitPriceCents, percentOff, quantity, intervalWeeks) {
    var perUnit = unitPriceCents - CX.planPriceCents(unitPriceCents, percentOff);
    return Math.round(perUnit * (quantity || 1) * CX.cyclesPerYear(intervalWeeks));
  };

  /* Shopify money_format renderer for integer cents. */
  CX.formatMoney = function (cents, format) {
    var value = (cents || 0) / 100;
    function grp(precision, thousands, decimal) {
      var parts = Math.abs(value).toFixed(precision).split('.');
      var s = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      if (precision > 0) s += decimal + parts[1];
      return value < 0 ? '-' + s : s;
    }
    return (format || '${{amount}}')
      .replace(/\{\{\s*amount\s*\}\}/g, grp(2, ',', '.'))
      .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, grp(0, ',', '.'))
      .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/g, grp(2, '.', ','))
      .replace(/\{\{\s*amount_no_decimals_with_comma_separator\s*\}\}/g, grp(0, '.', ','))
      .replace(/\{\{\s*amount_with_apostrophe_separator\s*\}\}/g, grp(2, "'", '.'));
  };

  /* 'gid://shopify/SellingPlan/123' → '123'; bare/numeric ids pass through.
     The widget-config planIds are GraphQL GIDs (pushSellingPlanConfig writes
     shopifyPlanId back as a GID) while Liquid exposes numeric plan ids, so
     both sides must reduce to the numeric tail before comparing. */
  CX.idTail = function (id) {
    var s = String(id);
    var i = s.lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
  };

  /* committed pool: explicit id list wins (GID or numeric, compared by
     numeric tail), else case-insensitive name match */
  CX.splitPlans = function (plans, ids, match) {
    var out = { committed: [], standard: [] };
    plans = plans || []; ids = ids || [];
    match = match ? String(match).toLowerCase() : '';
    for (var i = 0; i < plans.length; i++) {
      var c = false;
      for (var j = 0; j < ids.length && !c; j++) c = CX.idTail(ids[j]) === CX.idTail(plans[i].id);
      if (!ids.length && match) c = String(plans[i].name || '').toLowerCase().indexOf(match) !== -1;
      out[c ? 'committed' : 'standard'].push(plans[i]);
    }
    return out;
  };

  /* pre-selected card: committed at position 1, else treatment. Ultra has
     no cards at all — the mode is always treatment (committed NEVER: it is
     choice-framing, and its terms disclosure lives on the card). */
  CX.initialMode = function (o) {
    o = o || {};
    if (!o.hasPlans) return 'basic';
    if (String(o.style || '') === 'ultra') return 'treatment';
    return o.committedEnabled && String(o.committedPosition) === '1' ? 'committed' : 'treatment';
  };

  /* ── Widget styles ("choice" | "max" | "ultra") ── */

  /* Config style (admin targeting, settings.style — sent only when a
     merchant EXPLICITLY set it) wins over the Liquid-resolved style;
     unrecognised values fall through to the other layer, then to "choice".
     Case/whitespace tolerant on both sides. */
  CX.resolveStyle = function (liquidStyle, configStyle) {
    function norm(v) {
      if (v == null) return null;
      var s = String(v).toLowerCase().replace(/^\s+|\s+$/g, '');
      return s === 'max' || s === 'choice' || s === 'ultra' ? s : null;
    }
    return norm(configStyle) || norm(liquidStyle) || 'choice';
  };

  /* Allocation price for a variant+plan (covers fixed_amount etc.), else
     the % math; no plan → the one-time price. Drives every plan price shown,
     including the ultra price line (unit price — the ATC shows the total). */
  CX.planUnitCents = function (variant, plan) {
    if (!variant) return 0;
    if (!plan) return variant.priceCents;
    var prices = variant.planPrices;
    var alloc = prices ? prices[String(plan.id)] : null;
    if (typeof alloc === 'number' && isFinite(alloc)) return alloc;
    return CX.planPriceCents(variant.priceCents, plan.percentOff);
  };

  /* Basic-link copy: fill every __PRICE__ token in a link template. */
  CX.fillPriceToken = function (template, priceText) {
    var t = template == null ? '' : String(template);
    return t.split('__PRICE__').join(priceText == null ? '' : String(priceText));
  };

  /* ── first-party acquisition capture (pure) ── */

  /* Checkout/cart attribute values must stay under 250 characters. */
  CX.ATTR_MAX = 249;
  /* First-touch context window: 30 days. */
  CX.CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  CX.clipAttr = function (value) {
    var s = value == null ? '' : String(value);
    return s.length > CX.ATTR_MAX ? s.slice(0, CX.ATTR_MAX) : s;
  };

  /* "?utm_source=x&gclid=y&foo=z" → {utm_source:'x', gclid:'y'} — only
     utm_* / gclid / fbclid survive; empty values and bad encodings drop. */
  CX.parseTrackingParams = function (search) {
    var out = {};
    if (!search) return out;
    var q = String(search);
    if (q.charAt(0) === '?') q = q.slice(1);
    var pairs = q.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var eq = pairs[i].indexOf('=');
      var k = eq === -1 ? pairs[i] : pairs[i].slice(0, eq);
      var v = eq === -1 ? '' : pairs[i].slice(eq + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) { continue; }
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e2) { continue; }
      if (!v) continue;
      if (k.indexOf('utm_') === 0 || k === 'gclid' || k === 'fbclid') out[k] = v;
    }
    return out;
  };

  /* Keep the stored first-touch context while it is fresh (≤ 30 days old and
     not from the future); otherwise adopt the candidate as the new first touch. */
  CX.firstTouch = function (existing, candidate, nowMs) {
    if (existing && existing.firstSeenAt) {
      var seen = Date.parse(existing.firstSeenAt);
      var age = nowMs - seen;
      if (isFinite(seen) && age >= 0 && age <= CX.CONTEXT_TTL_MS) return existing;
    }
    return candidate;
  };

  /* Internal navigation must never poison the first touch: when the referrer
     is the store's own host, (a) recover utm_* / gclid / fbclid from the
     referrer's query string — same-origin referrers keep the full URL under
     the default strict-origin-when-cross-origin policy, so this rescues the
     UTMs of a widget-less entry page (homepage ad landing) — with
     current-page params winning, and (b) blank the referrer so the shop's
     own URL is never stored ('' correctly derives 'direct' server-side when
     nothing was recoverable). External referrers pass through untouched.
     ES5 manual parse (no URL()) for old-browser safety; never throws. */
  CX.sanitizeFirstTouch = function (referrer, ownHost, utm) {
    var out = { referrer: referrer == null ? '' : String(referrer), utm: {} };
    var k;
    var src = utm || {};
    for (k in src) { if (src.hasOwnProperty(k)) out.utm[k] = src[k]; }
    if (!out.referrer || !ownHost) return out;
    try {
      var m = out.referrer.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^/?#]*)/);
      if (!m) return out;
      var host = m[1];
      var at = host.indexOf('@');
      if (at !== -1) host = host.slice(at + 1);
      host = host.replace(/:\d*$/, '').toLowerCase();
      if (host !== String(ownHost).toLowerCase()) return out;
      var q = out.referrer.indexOf('?');
      if (q !== -1) {
        var query = out.referrer.slice(q + 1);
        var hashAt = query.indexOf('#');
        if (hashAt !== -1) query = query.slice(0, hashAt);
        var recovered = CX.parseTrackingParams(query);
        for (k in recovered) {
          if (recovered.hasOwnProperty(k) && !out.utm.hasOwnProperty(k)) {
            out.utm[k] = recovered[k];
          }
        }
      }
      out.referrer = '';
    } catch (e) { /* hostile referrer string — keep the candidate as-is */ }
    return out;
  };

  /* JSON attribute that always parses and never exceeds maxLen: keys are
     dropped from the tail until the JSON fits ('{}' in the worst case). */
  CX.safeJsonAttr = function (obj, maxLen) {
    var limit = maxLen || CX.ATTR_MAX;
    var src = obj || {};
    var keys = [];
    for (var k in src) { if (src.hasOwnProperty(k)) keys.push(k); }
    for (;;) {
      var slice = {};
      for (var i = 0; i < keys.length; i++) slice[keys[i]] = String(src[keys[i]]);
      var json;
      try { json = JSON.stringify(slice); } catch (e) { return '{}'; }
      if (json.length <= limit) return json;
      if (!keys.length) return '{}';
      keys.pop();
    }
  };

  /* Cart attribute map for POST /cart/update.js (leading underscore keeps the
     keys hidden at checkout). Pure: ctx = {visitor, firstSeenAt, referrer,
     landing, utm, widgetType, experimentKey, device, qty, discountPercent}.
     Every value is a string < 250 chars; empty values are omitted so real
     data already on the cart is never overwritten by blanks. */
  CX.buildCartAttributes = function (ctx) {
    ctx = ctx || {};
    var out = {};
    function put(key, value) {
      var s = value == null ? '' : String(value);
      if (!s) return;
      out[key] = CX.clipAttr(s);
    }
    put('_cellexia_visitor', ctx.visitor);
    put('_cellexia_first_seen', ctx.firstSeenAt);
    put('_cellexia_referrer', ctx.referrer);
    put('_cellexia_landing', ctx.landing);
    var utm = ctx.utm || {};
    var hasUtm = false;
    for (var uk in utm) { if (utm.hasOwnProperty(uk)) { hasUtm = true; break; } }
    if (hasUtm) out['_cellexia_utm'] = CX.safeJsonAttr(utm, CX.ATTR_MAX);
    /* widget identity is "version:variant" — variant from the experiment
       assignment ("experimentId:variantKey") when present, else v1 */
    var widget = ctx.widgetType || 'TREATMENT_CHOICE';
    var variant = 'v1';
    if (ctx.experimentKey) {
      var ek = String(ctx.experimentKey);
      var colon = ek.indexOf(':');
      variant = colon === -1 ? ek : ek.slice(colon + 1);
      if (!variant) variant = 'v1';
      put('_cellexia_experiment', ek);
    }
    put('_cellexia_widget', widget + ':' + variant);
    put('_cellexia_device', ctx.device);
    var qty = ctx.qty;
    if (qty != null && isFinite(qty) && qty > 0) put('_cellexia_qty', String(qty));
    var pct = ctx.discountPercent;
    if (pct != null && isFinite(pct) && pct > 0) put('_cellexia_discount_percent', String(pct));
    return out;
  };

  win.CellexiaWidgets = CX;
  if (!win.document) return; /* unit-test env: pure helpers only */

  /* ── DOM layer ── */

  var doc = win.document;
  var PROXY = '/apps/cellexia-subscriptions/api';

  function qs(root, sel) { return root.querySelector(sel); }
  function qsa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function ga(el, name) { return el.getAttribute(name); }
  function shopRoot() { return (win.Shopify && win.Shopify.routes && win.Shopify.routes.root) || '/'; }
  function isB2B() { return win.isB2BCustomer === true; }
  function setText(el, text) { if (el) el.textContent = text; }
  function show(el) { if (el) el.removeAttribute('hidden'); }
  function hide(el) { if (el) el.setAttribute('hidden', 'hidden'); }
  function mark(el, on) {
    el.classList[on ? 'add' : 'remove']('is-selected');
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.setAttribute('tabindex', on ? '0' : '-1');
  }
  function readJsonScript(root, sel) {
    var el = qs(root, sel);
    if (!el) return [];
    try { return JSON.parse(el.textContent) || []; } catch (e) { return []; }
  }

  function visitorKey() {
    try {
      var k = win.localStorage.getItem('cxw_visitor');
      if (!k) {
        k = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        win.localStorage.setItem('cxw_visitor', k);
      }
      return k;
    } catch (e) { return 'anon'; }
  }

  /* First-touch context, persisted 30 days: first seen, first referrer,
     first landing path, first utm/gclid/fbclid snapshot. Re-captured only
     when the stored window has expired. Never throws. */
  function firstTouchContext() {
    /* own-store referrers are internal navigation, not acquisition — harvest
       any entry-page tracking params they carry, then drop the referrer */
    var clean = CX.sanitizeFirstTouch(
      doc.referrer || '',
      (win.location && win.location.hostname) || '',
      CX.parseTrackingParams(win.location && win.location.search)
    );
    var candidate = {
      firstSeenAt: new Date().toISOString(),
      referrer: clean.referrer,
      landing: (win.location && win.location.pathname) || '/',
      utm: clean.utm
    };
    try {
      var stored = null;
      var raw = win.localStorage.getItem('cxw_ctx');
      if (raw) { try { stored = JSON.parse(raw); } catch (e) { stored = null; } }
      var ctx = CX.firstTouch(stored, candidate, Date.now());
      if (ctx === candidate) win.localStorage.setItem('cxw_ctx', JSON.stringify(candidate));
      return ctx;
    } catch (e2) { return candidate; }
  }

  function deviceType() {
    try {
      return win.matchMedia && win.matchMedia('(max-width: 767px)').matches
        ? 'mobile' : 'desktop';
    } catch (e) { return 'desktop'; }
  }

  /* Stamp acquisition context onto the cart AFTER a successful add/convert
     via POST /cart/update.js {attributes}. Fire-and-forget: runs after the
     ATC response, ignores its own result, and any failure is swallowed —
     it must never block or break add-to-cart. keepalive lets the request
     survive the reload/navigation afterCartMutation may trigger right after
     (widget F always reloads on /cart; widget A may navigate to /cart). */
  function postCartAttributes(extra) {
    try {
      var ctx = firstTouchContext();
      var payload = {
        visitor: visitorKey(),
        firstSeenAt: ctx.firstSeenAt,
        referrer: ctx.referrer,
        landing: ctx.landing,
        utm: ctx.utm,
        device: deviceType()
      };
      for (var k in extra) { if (extra.hasOwnProperty(k)) payload[k] = extra[k]; }
      var attributes = CX.buildCartAttributes(payload);
      var any = false;
      for (var a in attributes) { if (attributes.hasOwnProperty(a)) { any = true; break; } }
      if (!any) return;
      request('POST', shopRoot() + 'cart/update.js', { attributes: attributes }, null,
        { keepalive: true });
    } catch (e) { /* never break add-to-cart */ }
  }

  function request(method, url, payload, cb, opts) {
    var done = cb || function () {};
    if (!win.fetch) { done(new Error('fetch unavailable'), null); return; }
    win.fetch(url, {
      method: method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: 'same-origin',
      keepalive: !!(opts && opts.keepalive)
    }).then(function (res) {
      return res.json().then(
        function (json) { done(res.ok ? null : new Error('HTTP ' + res.status), json); },
        function () { done(res.ok ? null : new Error('HTTP ' + res.status), null); }
      );
    })['catch'](function (err) { done(err, null); });
  }

  /* telemetry — must never break the widget */
  function track(event, data) {
    try {
      var payload = { event: event, visitor: visitorKey(), path: win.location.pathname, ts: Date.now() };
      for (var k in data) { if (data.hasOwnProperty(k)) payload[k] = data[k]; }
      var url = PROXY + '/events';
      if (win.navigator && win.navigator.sendBeacon && win.Blob) {
        win.navigator.sendBeacon(url, new win.Blob([JSON.stringify(payload)], { type: 'application/json' }));
      } else {
        request('POST', url, payload, null);
      }
    } catch (e) { /* swallow */ }
  }

  function dispatchCartRefresh() {
    try {
      doc.dispatchEvent(new win.CustomEvent('cart:refresh', { bubbles: true }));
    } catch (e) {
      try {
        var ev = doc.createEvent('CustomEvent');
        ev.initCustomEvent('cart:refresh', true, false, null);
        doc.dispatchEvent(ev);
      } catch (e2) { /* swallow */ }
    }
  }

  /* Refresh theme minicart when present, else fall back to /cart. */
  function afterCartMutation(reloadOnCartPage) {
    dispatchCartRefresh();
    /* on /cart a reload wins: Liquid re-renders totals + conversion rows */
    if (reloadOnCartPage && win.location.pathname.indexOf('/cart') === 0) { win.location.reload(); return; }
    var mini = doc.querySelector('.mini-cart');
    if (mini && typeof win.refreshMiniCart === 'function') {
      request('GET', shopRoot() + 'cart.js', null, function (err, cart) {
        if (!err && cart) { try { win.refreshMiniCart(cart); } catch (e) { /* theme changed */ } }
      });
      return;
    }
    if (!mini) win.location.href = shopRoot() + 'cart';
  }

  /* ── Widgets A + B + E (product block) ── */

  function initChoice(root) {
    var state = {
      mode: 'treatment',
      /* last non-basic mode — where the quiet basic link returns to */
      lastPlanMode: null,
      qty: 1,
      productId: ga(root,'data-product-id'),
      requiresPlan: ga(root,'data-requires-plan') === 'true',
      moneyFormat: ga(root,'data-money-format') || '${{amount}}',
      enableE: ga(root,'data-enable-e') === 'true',
      cadenceDefaults: {},
      plans: [],
      variants: [],
      variant: null,
      plan: null,
      experimentKey: null,
      cmEnabled: ga(root,'data-committed-enabled') === 'true',
      cmMatch: ga(root,'data-committed-plan-match') || '',
      market: ga(root,'data-market') || '',
      style: CX.resolveStyle(ga(root,'data-cxw-style'), null),
      nudgeInMax: ga(root,'data-enable-nudge-in-max') === 'true',
      /* line toggles honored in ALL styles (absent attr = shown) */
      showCadence: ga(root,'data-show-cadence-line') !== 'false',
      showPermonth: ga(root,'data-show-permonth-line') !== 'false',
      showPriceLine: ga(root,'data-show-price-line') !== 'false',
      busy: false
    };
    try { state.cadenceDefaults = JSON.parse(ga(root,'data-cadence-defaults')) || {}; } catch (e) { /* noop */ }
    state.plans = CX.normalizePlans(readJsonScript(root, '[data-cxw-plans]'));
    state.variants = readJsonScript(root, '[data-cxw-variants]');
    state.pools = CX.splitPlans(state.plans,
      readJsonScript(root, '[data-cxw-committed-plans]'), state.cmMatch);

    function findVariant(id) {
      if (id == null) return null;
      for (var i = 0; i < state.variants.length; i++) {
        if (String(state.variants[i].id) === String(id)) return state.variants[i];
      }
      return null;
    }

    state.variant = findVariant(ga(root,'data-selected-variant')) || state.variants[0] || null;
    state.mode = CX.initialMode({ hasPlans: !!state.plans.length, style: state.style,
      committedEnabled: committedOn(), committedPosition: ga(root,'data-committed-position') });
    if (state.requiresPlan && state.mode === 'basic') state.mode = 'treatment';

    var els = {
      cards: qsa(root, '[data-cxw-mode]'),
      pills: qsa(root, '[data-cxw-qty]'),
      cadence: qs(root, '[data-cxw-cadence]'),
      permonth: qs(root, '[data-cxw-permonth]'),
      planSelect: qs(root, '[data-cxw-plan-select]'),
      variantWrap: qs(root, '[data-cxw-variant-wrap]'),
      variantSelect: qs(root, '[data-cxw-variant-select]'),
      atc: qs(root, '[data-cxw-atc]'),
      atcLabel: qs(root, '[data-cxw-atc-label]'),
      atcPrice: qs(root, '[data-cxw-atc-price]'),
      treatPrice: qs(root, '[data-cxw-treatment-price]'),
      treatCompare: qs(root, '[data-cxw-treatment-compare]'),
      basicPrice: qs(root, '[data-cxw-basic-price]'),
      cmPrice: qs(root, '[data-cxw-committed-price]'),
      cmCompare: qs(root, '[data-cxw-committed-compare]'),
      cmTerms: qs(root, '[data-cxw-committed-terms]'),
      termsBtn: qs(root, '[data-cxw-terms-toggle]'),
      tooltip: qs(root, '.cxw-tooltip'),
      heading: qs(root, '[data-cxw-heading]'),
      savingsCopy: qs(root, '[data-cxw-savings-copy]'),
      nudge: qs(root, '[data-cxw-nudge]'),
      nudgeBasic: qs(root, '[data-cxw-nudge-basic]'),
      nudgePlan: qs(root, '[data-cxw-nudge-plan]'),
      nudgeAnnual: qs(root, '[data-cxw-nudge-annual]'),
      basicLink: qs(root, '[data-cxw-basic-link]'),
      ultraPrice: qs(root, '[data-cxw-ultra-price]'),
      cardsWrap: qs(root, '.cxw-cards'),
      error: qs(root, '[data-cxw-error]')
    };

    /* line toggles apply in every style — hide even cached/stale markup */
    if (!state.showCadence) hide(els.cadence);
    if (!state.showPermonth) hide(els.permonth);

    /* B2B: plans never apply — hide plan cards/nudge (covers cached HTML) */
    if (isB2B()) {
      if (state.requiresPlan) { hide(root); return; }
      state.mode = 'basic';
      state.enableE = false;
      state.cmEnabled = false;
      for (var b2bIdx = 0; b2bIdx < els.cards.length; b2bIdx++) {
        if (ga(els.cards[b2bIdx], 'data-cxw-mode') !== 'basic') hide(els.cards[b2bIdx]);
      }
      if (els.nudge) hide(els.nudge);
      /* B2B is always a plain purchase — a "buy once instead" link (cached
         max-style HTML) offers a switch that does not exist for them */
      if (els.basicLink) hide(els.basicLink);
      /* …and the ultra price line shows a plan price they never get */
      if (els.ultraPrice) hide(els.ultraPrice);
    }

    function money(cents) { return CX.formatMoney(cents, state.moneyFormat); }

    function stdPool() { return state.pools.standard.length ? state.pools.standard : state.plans; }
    /* ultra: committed never applies — cards are choice-framing and the
       committed terms disclosure lives on the (absent) card */
    function committedOn() { return state.style !== 'ultra' && state.cmEnabled && !!state.pools.committed.length; }
    /* hide the committed card when off, pool-less or absent */
    function syncCommitted() {
      var card = cardFor('committed');
      if (card && committedOn()) { show(card); return; }
      hide(card);
      if (state.mode === 'committed') { state.mode = 'treatment'; setPlanFromQty(); }
    }

    /* allocation price for variant+plan (fixed_amount etc.), else % math */
    function planUnitFor(variant, plan) { return CX.planUnitCents(variant, plan); }

    function tele(widget) {
      /* planId only when subscribing — analytics reads it as a plan selection */
      var subscribing = state.mode !== 'basic' && state.plan;
      return {
        widget: widget,
        style: state.style,
        productId: state.productId,
        variantId: state.variant ? state.variant.id : null,
        qty: state.qty,
        planId: subscribing ? state.plan.id : null,
        experimentKey: state.experimentKey
      };
    }

    function setPlanFromQty() {
      if (!state.plans.length) { state.plan = null; return; }
      var pool = state.mode === 'committed' ? state.pools.committed : stdPool();
      var weeks = CX.cadenceForQuantity(state.qty, state.cadenceDefaults);
      state.plan = CX.pickPlanForWeeks(pool, weeks);
      if (els.planSelect && state.plan) els.planSelect.value = String(state.plan.id);
    }

    /* Telemetry once per page load; the box itself shows on EVERY switch to
       basic and hides whenever a plan card is selected. */
    var nudgeTracked = false;

    function fillNudge() {
      if (!els.nudge || !state.variant) return;
      /* best (cheapest) available plan at the current cadence */
      var w = CX.cadenceForQuantity(state.qty, state.cadenceDefaults);
      var plan = CX.pickPlanForWeeks(stdPool(), w);
      var cp = committedOn() ? CX.pickPlanForWeeks(state.pools.committed, w) : null;
      if (cp && (!plan || planUnitFor(state.variant, cp) < planUnitFor(state.variant, plan))) plan = cp;
      if (!plan) return;
      var unit = state.variant.priceCents;
      var planUnit = planUnitFor(state.variant, plan);
      setText(els.nudgeBasic, money(unit * state.qty));
      setText(els.nudgePlan, money(planUnit * state.qty));
      if (els.nudgeAnnual) {
        var weeks = plan.intervalWeeks || w;
        var annual = Math.round((unit - planUnit) * state.qty * CX.cyclesPerYear(weeks));
        var tpl = ga(els.nudge,'data-cxw-annual-template') || '__AMOUNT__';
        els.nudgeAnnual.textContent = annual > 0 ? tpl.replace('__AMOUNT__', money(annual)) : '';
      }
    }

    function maybeShowNudge() {
      if (!state.enableE || !els.nudge) return;
      /* Ultra: NEVER — there is no comparison to make when the subscription
         is not presented as a concept (no opt-back-in exists) */
      if (state.style === 'ultra') return;
      /* Subscription Max: a comparison box reintroduces doubt — suppressed
         unless the merchant explicitly re-enabled it for this style */
      if (state.style === 'max' && !state.nudgeInMax) return;
      fillNudge();
      show(els.nudge);
      if (!nudgeTracked) {
        nudgeTracked = true;
        track('nudge_shown', tele('E'));
      }
    }

    function render() {
      var i;
      for (i = 0; i < els.cards.length; i++) {
        mark(els.cards[i], ga(els.cards[i],'data-cxw-mode') === state.mode);
      }
      for (i = 0; i < els.pills.length; i++) {
        mark(els.pills[i], parseInt(ga(els.pills[i],'data-cxw-qty'), 10) === state.qty);
      }

      /* Roving tabindex must stay Tab-reachable: when the selected mode
         lives on no visible card (basic hidden after a restyle to max, or
         quiet-link basic in native max), park tabindex=0 on the first
         visible card without claiming aria-checked. */
      var tabAnchor = null;
      var tabReachable = false;
      for (i = 0; i < els.cards.length; i++) {
        if (els.cards[i].hasAttribute('hidden')) continue;
        if (!tabAnchor) tabAnchor = els.cards[i];
        if (ga(els.cards[i],'data-cxw-mode') === state.mode) tabReachable = true;
      }
      if (!tabReachable && tabAnchor) tabAnchor.setAttribute('tabindex', '0');

      var unit = state.variant ? state.variant.priceCents : 0;
      var planUnit = planUnitFor(state.variant, state.plan);
      /* unselected plan card shows its own pool's pick */
      var w0 = CX.cadenceForQuantity(state.qty, state.cadenceDefaults);
      var inCm = state.mode === 'committed';
      var tUnit = inCm ? planUnitFor(state.variant, CX.pickPlanForWeeks(stdPool(), w0)) : planUnit;
      function cmp(el, u) {
        if (!el) return;
        if (u < unit) { setText(el, money(unit)); show(el); } else hide(el);
      }

      setText(els.treatPrice, money(tUnit));
      cmp(els.treatCompare, tUnit);
      setText(els.basicPrice, money(unit));

      if (els.cmPrice) {
        var cUnit = inCm ? planUnit
          : planUnitFor(state.variant, CX.pickPlanForWeeks(state.pools.committed, w0));
        setText(els.cmPrice, money(cUnit));
        cmp(els.cmCompare, cUnit);
        if (els.cmTerms) (inCm ? show : hide)(els.cmTerms);
      }

      if (els.cadence && state.plan && state.showCadence) {
        /* Committed mode: the schedule is fixed for the first N deliveries —
           never promise "adjust anytime" while that plan is selected. */
        var tpl = (state.mode === 'committed' &&
          ga(els.cadence,'data-cxw-cadence-committed-template')) ||
          ga(els.cadence,'data-cxw-cadence-template') || '';
        if (tpl) els.cadence.textContent = tpl.replace('__WEEKS__', String(state.plan.intervalWeeks || w0));
      }

      /* Assurance line under add-to-cart follows the selected plan's terms. */
      var assuranceEl = qs(root, '[data-cxw-assurance]');
      if (assuranceEl) {
        var aTxt = state.mode === 'committed'
          ? ga(assuranceEl, 'data-cxw-assurance-committed')
          : ga(assuranceEl, 'data-cxw-assurance-default');
        if (aTxt) assuranceEl.textContent = aTxt;
      }

      /* Basic link (max + ultra styles): honest one-time total for the
         current qty; aria-pressed mirrors basic mode and drives the selected
         styling. Ultra uses its own NEUTRAL templates (never names the
         plan); the max attrs are the fallback for ultra-rendered markup
         that predates the ultra attrs (cached HTML). */
      if (els.basicLink) {
        var inBasic = state.mode === 'basic';
        var linkTpl = state.style === 'ultra'
          ? (ga(els.basicLink, inBasic
              ? 'data-cxw-ultra-back-template' : 'data-cxw-ultra-link-template') ||
             ga(els.basicLink, inBasic
              ? 'data-cxw-basic-back-template' : 'data-cxw-basic-link-template'))
          : ga(els.basicLink, inBasic
              ? 'data-cxw-basic-back-template' : 'data-cxw-basic-link-template');
        if (linkTpl) setText(els.basicLink, CX.fillPriceToken(linkTpl, money(unit * state.qty)));
        els.basicLink.setAttribute('aria-pressed', inBasic ? 'true' : 'false');
      }

      /* Ultra price line: the plan UNIT price, plain — no compare, no
         savings framing (the ATC carries the qty total). Buying once via
         the link honestly moves it to the one-time unit price. */
      if (els.ultraPrice) {
        if (state.style === 'ultra' && state.showPriceLine && !isB2B()) {
          setText(els.ultraPrice, money(state.mode !== 'basic' && state.plan ? planUnit : unit));
          show(els.ultraPrice);
        } else {
          hide(els.ultraPrice);
        }
      }

      /* more units stretch the cadence — say so, or pills read as a price rise */
      if (els.permonth) {
        var pmWeeks = state.plan ? (state.plan.intervalWeeks || w0) : 0;
        if (state.mode !== 'basic' && state.plan && pmWeeks > 0 && state.showPermonth) {
          var pmMonthly = Math.round((planUnit * state.qty) * CX.cyclesPerYear(pmWeeks) / 12);
          var pmTpl = state.qty > 1
            ? (ga(els.permonth,'data-cxw-permonth-multi-template') || '')
            : (ga(els.permonth,'data-cxw-permonth-template') || '');
          if (pmTpl) {
            els.permonth.textContent = pmTpl
              .replace('__QTY__', String(state.qty))
              .replace('__UNIT__', money(planUnit))
              .replace('__MONTHLY__', money(pmMonthly));
            show(els.permonth);
          }
        } else {
          hide(els.permonth);
        }
      }

      /* savings bullet follows the selected plan */
      if (els.savingsCopy && state.plan) {
        var stpl = ga(els.savingsCopy, 'data-cxw-savings-template');
        var spct = CX.computeSavingsPercent(unit, tUnit);
        if (stpl && spct > 0) {
          setText(els.savingsCopy, stpl.replace('__PERCENT__', String(spct)));
        }
      }

      setText(els.atcPrice, money((state.mode !== 'basic' && state.plan ? planUnit : unit) * state.qty));

      if (els.atc) {
        var available = state.variant && state.variant.available;
        if (available && !state.busy) els.atc.removeAttribute('disabled');
        else els.atc.setAttribute('disabled', 'disabled');
        if (!state.busy) setText(els.atcLabel, ga(els.atc,available ? 'data-label-add' : 'data-label-oos'));
      }
      if (els.nudge && !els.nudge.hasAttribute('hidden')) fillNudge();
    }

    function setMode(mode, source) {
      if (mode === 'basic' && state.requiresPlan) return;
      if (mode === 'committed' && !committedOn()) return;
      if (state.mode === mode) return;
      /* remember the plan card the shopper is leaving so the quiet basic
         link can return to it — a committed default must survive a
         buy-once round-trip */
      if (state.mode !== 'basic') state.lastPlanMode = state.mode;
      state.mode = mode;
      setPlanFromQty();
      if (mode === 'basic') {
        track('select_basic', tele('A'));
        maybeShowNudge();
      } else {
        track(mode === 'committed' ? 'select_committed' : 'select_treatment', tele('A'));
        /* Selecting any treatment plan resolves the nudge — hide it however
           the selection was made (card click, keyboard, or the nudge CTA). */
        hide(els.nudge);
      }
      render();
    }

    function setQty(qty) {
      if (state.qty === qty) return;
      state.qty = qty;
      setPlanFromQty();
      render();
    }

    /* radiogroup semantics: click, Space/Enter, arrow keys. Hidden items
       (basic card after a restyle to max, B2B-hidden plan cards) never
       receive picks, and the arrows walk past them — otherwise a keyboard
       user would silently select an invisible card and strand the roving
       tabindex on a display:none node. */
    function bindRadioGroup(items, onPick) {
      function visibleFrom(idx, dir) {
        for (var n = 1; n <= items.length; n++) {
          var cand = items[((idx + dir * n) % items.length + items.length) % items.length];
          if (!cand.hasAttribute('hidden')) return cand;
        }
        return items[idx];
      }
      for (var i = 0; i < items.length; i++) {
        (function (el, idx) {
          el.addEventListener('click', function () {
            if (el.hasAttribute('hidden')) return;
            onPick(el);
          });
          el.addEventListener('keydown', function (ev) {
            if (el.hasAttribute('hidden')) return;
            var key = ev.key || ev.keyCode;
            if (key === ' ' || key === 'Enter' || key === 32 || key === 13) {
              ev.preventDefault();
              onPick(el);
            } else if (key === 'ArrowRight' || key === 'ArrowDown' || key === 39 || key === 40) {
              ev.preventDefault();
              var next = visibleFrom(idx, 1);
              next.focus(); onPick(next);
            } else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 37 || key === 38) {
              ev.preventDefault();
              var prev = visibleFrom(idx, -1);
              prev.focus(); onPick(prev);
            }
          });
        })(items[i], i);
      }
    }
    bindRadioGroup(els.cards, function (el) { setMode(ga(el, 'data-cxw-mode'), 'card'); });
    bindRadioGroup(els.pills, function (el) { setQty(parseInt(ga(el, 'data-cxw-qty'), 10) || 1); });

    if (els.planSelect) {
      els.planSelect.addEventListener('change', function () {
        for (var i = 0; i < state.plans.length; i++) {
          if (String(state.plans[i].id) === String(els.planSelect.value)) { state.plan = state.plans[i]; break; }
        }
        /* keep mode in the chosen plan's pool */
        if (state.mode !== 'basic' && committedOn()) {
          state.mode = state.pools.committed.indexOf(state.plan) < 0 ? 'treatment' : 'committed';
        }
        render();
      });
    }

    /* variant sync: the theme's [sm-rc-variant-selector] wins */
    var themeVariantSel = doc.querySelector('[sm-rc-variant-selector]');
    function syncFromThemeSel() {
      if (!themeVariantSel) return;
      var v = findVariant(themeVariantSel.value);
      if (v && v !== state.variant) { state.variant = v; render(); }
    }
    if (themeVariantSel) {
      if (els.variantWrap) hide(els.variantWrap);
      /* jQuery .val().trigger('change') fires only jQuery-bound handlers */
      themeVariantSel.addEventListener('change', syncFromThemeSel);
      if (win.jQuery) win.jQuery(themeVariantSel).on('change', syncFromThemeSel);
      var initial = findVariant(themeVariantSel.value);
      if (initial) state.variant = initial;
    } else if (els.variantSelect) {
      els.variantSelect.addEventListener('change', function () {
        var v = findVariant(els.variantSelect.value);
        if (v) { state.variant = v; render(); }
      });
    }

    var nudgeSwitch = qs(root, '[data-cxw-nudge-switch]');
    if (nudgeSwitch) {
      nudgeSwitch.addEventListener('click', function () {
        hide(els.nudge);
        setMode('treatment', 'nudge');
        /* after setMode so tele() carries the plan */
        track('nudge_converted', tele('E'));
        for (var i = 0; i < els.cards.length; i++) {
          if (ga(els.cards[i],'data-cxw-mode') === 'treatment') { els.cards[i].focus(); break; }
        }
      });
    }
    var nudgeDismiss = qs(root, '[data-cxw-nudge-dismiss]');
    if (nudgeDismiss) nudgeDismiss.addEventListener('click', function () { hide(els.nudge); });

    /* Quiet basic link (max style): toggles buying once ↔ the plan. A real
       button — click/Space/Enter all fire; setMode tracks select_basic /
       select_treatment and render() swaps the two templates + aria-pressed
       and moves the add-to-cart price. */
    if (els.basicLink) {
      els.basicLink.addEventListener('click', function () {
        /* return to the plan the shopper actually left — the committed
           pre-selection survives the round-trip unless a config override
           has disabled committed since (then treatment, never a dead end) */
        var back = state.lastPlanMode === 'committed' && committedOn()
          ? 'committed' : 'treatment';
        setMode(state.mode === 'basic' ? back : 'basic', 'basic-link');
      });
    }

    /* committed terms "?": hover/focus/click opens (click after hover pins —
       touch fires both); mouseleave/blur/Escape/outside closes; no focus trap;
       stopPropagation keeps taps/keys off the card radiogroup */
    if (els.termsBtn && els.tooltip) (function (btn, tip) {
      var hov = false;
      function opened() { return !tip.hasAttribute('hidden'); }
      function setTip(on) {
        (on ? show : hide)(tip);
        if (!on) hov = false;
        btn.setAttribute('aria-expanded', String(!!on));
      }
      btn.onclick = function (e) { e.stopPropagation(); if (hov) hov = false; else setTip(!opened()); };
      btn.onkeydown = function (e) { e.stopPropagation(); };
      btn.onmouseenter = function () { if (!opened()) { hov = true; setTip(true); } };
      btn.onmouseleave = function () { if (hov) setTip(false); };
      btn.onfocus = function () { hov = true; setTip(true); };
      btn.onblur = function () { setTip(false); };
      tip.onclick = function (e) { e.stopPropagation(); };
      doc.addEventListener('keydown', function (e) {
        if (opened() && (e.key === 'Escape' || e.keyCode === 27)) setTip(false);
      });
      doc.addEventListener('click', function (e) {
        if (opened() && !tip.contains(e.target)) setTip(false);
      });
    })(els.termsBtn, els.tooltip);

    if (els.atc) {
      els.atc.addEventListener('click', function () {
        /* defensive: re-read the theme's selector for the picked variant */
        syncFromThemeSel();
        if (state.busy || !state.variant) return;
        state.busy = true;
        hide(els.error);
        els.atc.setAttribute('disabled', 'disabled');
        setText(els.atcLabel, ga(els.atc,'data-label-adding'));

        var item = { id: state.variant.id, quantity: state.qty };
        /* B2B parity: never attach a selling plan */
        var subscribing = state.mode !== 'basic' && state.plan && !isB2B();
        if (subscribing) item.selling_plan = state.plan.id;
        track('add_to_cart', tele('A'));

        /* capture acquisition context at click time — state may move on */
        var acq = {
          widgetType: 'TREATMENT_CHOICE',
          experimentKey: state.experimentKey,
          qty: state.qty,
          discountPercent: subscribing
            ? CX.computeSavingsPercent(
                state.variant.priceCents,
                planUnitFor(state.variant, state.plan)
              )
            : null
        };

        request('POST', shopRoot() + 'cart/add.js', { items: [item] }, function (err) {
          state.busy = false;
          if (err) { show(els.error); render(); return; }
          setText(els.atcLabel, ga(els.atc,'data-label-added'));
          els.atc.removeAttribute('disabled');
          /* first-party data: only after the add succeeded, never blocking */
          postCartAttributes(acq);
          win.setTimeout(render, 2000);
          afterCartMutation(false);
        });
      });
    }

    /* Settings shape = DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE (tested in
       widget-settings-contract). {percent}/{weeks} fill from the plan. */
    function cardFor(mode) {
      for (var i = 0; i < els.cards.length; i++) {
        if (ga(els.cards[i], 'data-cxw-mode') === mode) return els.cards[i];
      }
      return null;
    }
    /* Ultra: committed plans must not be reachable through the advanced
       rhythm select either (Liquid-ultra never renders their options; a
       restyled root still carries them, so disable/re-enable in place). */
    function setCommittedOptions(off) {
      if (!els.planSelect) return;
      var opts = els.planSelect.options;
      for (var i = 0; i < opts.length; i++) {
        var isCm = false;
        for (var j = 0; j < state.pools.committed.length && !isCm; j++) {
          isCm = String(state.pools.committed[j].id) === String(opts[i].value);
        }
        if (!isCm) continue;
        if (off) opts[i].setAttribute('disabled', 'disabled');
        else opts[i].removeAttribute('disabled');
      }
    }
    /* Swap between the "choice", "max" and "ultra" presentations in place —
       used when the widget-config style (admin/market targeting) differs
       from what Liquid rendered. Purely visual: plans, prices and qty all
       survive the swap (so does the selected mode, EXCEPT committed → ultra:
       committed never exists in ultra, so the mode falls back to treatment).
       No-op for B2B (they never see plan UI). Liquid-ultra markup carries no
       heading/cards/nudge at all — restyling it to choice/max stays
       card-less (same accepted degradation as the max-rendered DOM's missing
       basic card); every hook below is null-guarded for that. */
    function restyleTo(style) {
      var next = CX.resolveStyle(state.style, style);
      if (next === state.style || isB2B()) return;
      state.style = next;
      root.classList.remove('cxw--choice');
      root.classList.remove('cxw--max');
      root.classList.remove('cxw--ultra');
      root.classList.add('cxw--' + next);
      root.setAttribute('data-cxw-style', next);
      var basicCard = cardFor('basic');
      var canBasic = !state.requiresPlan && state.plans.length > 0;
      if (next === 'ultra') {
        /* the subscription stops being presented as a concept: heading,
           cards (all of them — no radiogroup remains) and nudge disappear;
           the plan price becomes THE price */
        hide(els.heading);
        hide(els.cardsWrap);
        hide(els.nudge);
        if (els.basicLink && canBasic) show(els.basicLink);
        if (state.mode === 'committed') {
          state.mode = 'treatment';
          setPlanFromQty(); /* pool changed: committed → standard */
        }
        setCommittedOptions(true);
      } else {
        show(els.heading);
        show(els.cardsWrap);
        setCommittedOptions(false);
        syncCommitted();
        if (next === 'max') {
          hide(basicCard);
          if (els.basicLink && canBasic) show(els.basicLink);
          if (!state.nudgeInMax) hide(els.nudge);
        } else if (basicCard) {
          show(basicCard);
          hide(els.basicLink);
        } else if (els.basicLink && canBasic) {
          /* max/ultra-rendered DOM has no basic card — keep the quiet link
             so a one-time purchase stays reachable in the choice style too */
          show(els.basicLink);
        }
      }
      render();
    }
    function applySettings(s) {
      function fill(text) {
        var pct = state.plan
          ? CX.computeSavingsPercent(
              state.variant ? state.variant.priceCents : 0,
              planUnitFor(state.variant, state.plan)
            )
          : CX.maxPercentOff(state.plans);
        var weeks = (state.plan && state.plan.intervalWeeks) ||
          CX.cadenceForQuantity(state.qty, state.cadenceDefaults);
        return String(text)
          .split('{percent}').join(String(pct))
          .split('{weeks}').join(String(weeks));
      }
      function applyCard(mode, copy) {
        if (!copy) return;
        var el = cardFor(mode);
        if (!el) return;
        if (copy.label) setText(qs(el, '.cxw-card__title'), fill(copy.label));
        if (copy.badge) setText(qs(el, '.cxw-ribbon'), fill(copy.badge));
        if (copy.bullets && copy.bullets.length) {
          var items = qsa(el, '.cxw-card__bullets li');
          for (var i = 0; i < items.length && i < copy.bullets.length; i++) {
            var bullet = String(copy.bullets[i]);
            if (items[i].hasAttribute('data-cxw-savings-copy') &&
                bullet.indexOf('{percent}') !== -1) {
              items[i].setAttribute(
                'data-cxw-savings-template',
                bullet.split('{percent}').join('__PERCENT__')
              );
            }
            setText(items[i], fill(bullet));
          }
        }
      }
      if (s.title || s.heading) setText(els.heading, fill(s.title || s.heading));
      applyCard('treatment', s.continuous);
      applyCard('basic', s.basic);
      /* committed overrides: enabled:false hides, planIds replaces pool, terms fill {n}/{p} */
      var cm = s.committed;
      if (cm) {
        if (cm.enabled === false) state.cmEnabled = false;
        if (cm.planIds && cm.planIds.length) {
          state.pools = CX.splitPlans(state.plans, cm.planIds, state.cmMatch);
        }
        var fillCm = function (t) {
          return String(t).split('{n}').join(String(cm.minDeliveries || 3))
            .split('{p}').join(String(cm.percentOff || 20));
        };
        if (cm.termsShort && els.cmTerms) setText(els.cmTerms, fillCm(cm.termsShort));
        if (cm.termsFull && els.tooltip) setText(els.tooltip, fillCm(cm.termsFull));
        syncCommitted();
        setPlanFromQty();
      }
      if (s.reassurance) setText(qs(root, '.cxw-assurance'), fill(s.reassurance));
      if (s.savingsCopy) {
        /* legacy override: static copy wins over the template */
        if (els.savingsCopy) els.savingsCopy.removeAttribute('data-cxw-savings-template');
        setText(els.savingsCopy, fill(s.savingsCopy));
      }
      /* style override (admin/market targeting) wins over the Liquid style */
      if (s.style) restyleTo(s.style);
    }

    /* enhancement config via app proxy; Liquid defaults on any failure */
    request(
      'GET',
      PROXY + '/widget-config?product_id=' + encodeURIComponent(state.productId || '') +
        '&visitor=' + encodeURIComponent(visitorKey()) +
        (state.market ? '&market=' + encodeURIComponent(state.market) : ''),
      null,
      function (err, cfg) {
        if (err || !cfg) return;
        try {
          if (cfg.cadenceDefaults) state.cadenceDefaults = cfg.cadenceDefaults;
          if (cfg.experimentKey) state.experimentKey = cfg.experimentKey;
          setPlanFromQty();
          applySettings(cfg.settings || {});
          render();
        } catch (e) { /* never break first paint */ }
      }
    );

    syncCommitted();
    setPlanFromQty();
    render();
    track('impression', tele('A'));
  }

  /* ── Widget F (cart block) ── */

  function initCartConversion(root) {
    if (isB2B()) { hide(root); return; }
    var rows = qsa(root, '[data-cxw-convrow]');
    if (!rows.length) return;
    track('impression', { widget: 'F', rows: rows.length });

    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var btn = qs(row, '[data-cxw-convert]');
        if (!btn) return;
        btn.addEventListener('click', function () {
          if (btn.hasAttribute('disabled')) return;
          btn.setAttribute('disabled', 'disabled');
          var payload = {
            line: parseInt(ga(row,'data-line'), 10),
            quantity: parseInt(ga(row,'data-quantity'), 10),
            selling_plan: parseInt(ga(row,'data-plan-id'), 10)
          };
          request('POST', shopRoot() + 'cart/change.js', payload, function (err) {
            if (err) { btn.removeAttribute('disabled'); return; }
            track('cart_convert', {
              widget: 'F',
              productId: ga(row,'data-product-id'),
              variantId: ga(row,'data-variant-id'),
              planId: ga(row,'data-plan-id'),
              qty: payload.quantity
            });
            /* first-party data: after the conversion succeeded, never blocking */
            postCartAttributes({ widgetType: 'CART_CONVERSION', qty: payload.quantity });
            row.classList.add('is-done');
            setText(qs(row, '.cxw-convrow__line'), btn.getAttribute('data-label-done'));
            hide(btn);
            afterCartMutation(true);
          });
        });
      })(rows[i]);
    }
  }

  /* ── boot ── */

  function boot() {
    var i;
    var choices = qsa(doc, '[data-cxw-choice]');
    var cartRoots = qsa(doc, '[data-cxw-cart]');
    /* first widget impression persists the first-touch context (30 days) */
    if (choices.length || cartRoots.length) firstTouchContext();
    for (i = 0; i < choices.length; i++) {
      if (!choices[i].hasAttribute('data-cxw-ready')) {
        choices[i].setAttribute('data-cxw-ready', '1');
        initChoice(choices[i]);
      }
    }
    for (i = 0; i < cartRoots.length; i++) {
      if (!cartRoots[i].hasAttribute('data-cxw-ready')) {
        cartRoots[i].setAttribute('data-cxw-ready', '1');
        initCartConversion(cartRoots[i]);
      }
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
