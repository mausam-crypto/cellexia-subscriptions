/**
 * Cellexia Buy Box — storefront behaviour. Vanilla JS, zero dependencies,
 * loaded deferred via the block schema (Shopify dedupes across blocks).
 *
 * Responsibilities:
 *  - Sync the selected purchase option into a hidden `selling_plan` input
 *    inside the product form (form[action*="/cart/add"], scoped to this
 *    block's section so pages with several product forms behave).
 *  - Stamp subscription add-to-carts with a hidden line property
 *    `properties[_cx_design]` = the wrapper's data-cx-preset, so the
 *    ORDERS_CREATE webhook can attribute take-rate per design. The property
 *    is disabled (not submitted) whenever one-time purchase is selected.
 *  - Drive all six design presets from the same state machine:
 *    radios (classic/tiles/value_stack/planner), role=tab toggle buttons
 *    (with arrow-key keyboard support), the inline checkbox, and frequency
 *    chips — every control funnels into setMode()/render().
 *  - Re-render prices when the variant changes: product form `change`
 *    events, plus a ?variant= URL fallback (history patch + popstate) for
 *    themes that update the URL without a reachable DOM event. Price nodes
 *    carry stable data-cx-* hooks in every preset (data-cx-sub-price,
 *    data-cx-onetime-price, data-cx-pd-price, data-cx-then, data-cx-save,
 *    data-cx-per-delivery, data-cx-first-label).
 *  - Re-resolve {percent}/{amount}/{frequency} text templates carried in
 *    data-cx-tpl attributes with per-plan values from the JSON island.
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

  /* ── Admin preview (setup mode) ──────────────────────────────────────────
     While the app is in setup mode the block renders [hidden][data-cx-gated]
     for everyone. A signed preview link (?cx_preview=<token>) lets the
     admin — and only the admin's own browser session — reveal it: the token
     is kept in sessionStorage (so PDP → cart navigation keeps preview on)
     and validated server-side via the app proxy before anything is shown.
     Fail closed: any network or validation problem leaves the widget
     hidden. In live mode nothing is gated and this module does no work —
     and never fetches. */

  var PREVIEW_STORAGE_KEY = 'cx_preview_token';
  var PREVIEW_VALIDATE_PATH = '/apps/cellexia-subscriptions/preview/validate';
  var previewValidated = false;

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

  function revealGated() {
    var gated = document.querySelectorAll('[data-cx-gated]');
    Array.prototype.forEach.call(gated, function (el) {
      el.removeAttribute('hidden');
      el.setAttribute('data-cx-preview', 'true');
      var ribbon = el.querySelector('[data-cx-preview-ribbon]');
      if (ribbon) {
        ribbon.removeAttribute('hidden');
      }
    });
  }

  function previewBoot() {
    var fromUrl = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get('cx_preview');
    } catch (err) {
      fromUrl = null;
    }
    if (fromUrl) {
      previewStorageSet(fromUrl);
    }
    var token = previewStorageGet();
    if (!token) {
      return;
    }
    /* Live mode renders without the gate — skip validation entirely. */
    if (!document.querySelector('[data-cx-gated]')) {
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
        /* Server hiccup (non-2xx) → fail closed, keep the token for retry. */
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        if (!data) {
          return;
        }
        if (data.ok === true) {
          previewValidated = true;
          revealGated();
        } else {
          /* Invalid or expired token: forget it so we stop asking. */
          previewStorageClear();
        }
      })
      .catch(function () {
        /* Network error → widget stays hidden. */
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
   * Resolve a {percent}/{amount}/{frequency} template (from data-cx-tpl)
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

  function findProductForm(root) {
    var sectionId = root.getAttribute('data-section-id');
    var scope = null;
    if (sectionId) {
      scope = document.getElementById('shopify-section-' + sectionId);
    }
    if (!scope) {
      scope = root.closest('.shopify-section');
    }
    var forms = collectForms(scope);
    if (!forms.length) {
      forms = collectForms(document);
    }
    return forms.length ? forms[0] : null;
  }

  function init(root) {
    if (root.getAttribute('data-cx-init') === 'true') {
      return;
    }
    root.setAttribute('data-cx-init', 'true');

    var dataEl = root.querySelector('script[data-cx-data]');
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

    var preset = root.getAttribute('data-cx-preset') || 'classic';
    var form = findProductForm(root);
    var radios = qa('input[data-cx-option]');
    var tabs = qa('[data-cx-tab]');
    var tablists = qa('[role="tablist"]');
    var panels = qa('[data-cx-panel]');
    var wraps = qa('[data-cx-option-wrap]');
    var inlineBox = root.querySelector('[data-cx-inline]');
    var freqSelect = root.querySelector('[data-cx-freq]');
    var freqChips = qa('[data-cx-freq-chip]');
    /* Stable data-cx-* hooks — every preset uses these (possibly several
       nodes each), never preset-specific classes. */
    var els = {
      subPrice: qa('[data-cx-sub-price]'),
      firstLabel: qa('[data-cx-first-label]'),
      then: qa('[data-cx-then]'),
      save: qa('[data-cx-save]'),
      saveRow: qa('[data-cx-save-row]'),
      perDelivery: qa('[data-cx-per-delivery]'),
      oneTime: qa('[data-cx-onetime-price]'),
      pdPrice: qa('[data-cx-pd-price]'),
      tpl: qa('[data-cx-tpl]')
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
          return tabs[j].getAttribute('data-cx-tab');
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

    /* Hidden line property stamping the active design on subscription
       add-to-carts (read by the ORDERS_CREATE webhook for take-rate-by-
       design analytics). Disabled — not submitted — for one-time carts. */
    function applyDesignProp(subscriptionSelected) {
      if (!form) {
        return;
      }
      var prop = form.querySelector('input[data-cx-design-prop]');
      if (subscriptionSelected) {
        if (!prop) {
          prop = document.createElement('input');
          prop.type = 'hidden';
          prop.name = 'properties[_cx_design]';
          prop.setAttribute('data-cx-design-prop', '');
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
      var input = form.querySelector(
        'input[name="selling_plan"], select[name="selling_plan"]'
      );
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'selling_plan';
        form.appendChild(input);
      }
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
          wrap.getAttribute('data-cx-option-wrap') === mode
        );
      });
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-cx-tab') === mode;
        tab.classList.toggle('is-selected', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          tab.removeAttribute('tabindex');
        } else {
          tab.setAttribute('tabindex', '-1');
        }
      });
      panels.forEach(function (panel) {
        if (panel.getAttribute('data-cx-panel') === mode) {
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
      if (!plan && variant.plans) {
        /* Selected frequency has no allocation on this variant — fall back to
           the variant's first available plan so subscription stays offerable. */
        var ids = Object.keys(variant.plans);
        if (ids.length) {
          state.planId = ids[0];
          syncFreqControls();
          plan = variant.plans[state.planId];
        }
      }
      var subAvailable = !!plan;
      root.classList.toggle('cx-buybox--no-sub', !subAvailable);

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
        if (el.hasAttribute('data-cx-save')) {
          return;
        }
        var resolved = resolveTpl(el.getAttribute('data-cx-tpl'), vals);
        if (el.textContent !== resolved) {
          el.textContent = resolved;
        }
      });

      if (subAvailable) {
        els.subPrice.forEach(function (el) {
          setPrice(
            el,
            plan.first,
            el.hasAttribute('data-cx-compare') ? variant.oneTime : null
          );
        });
        els.pdPrice.forEach(function (el) {
          el.textContent = plan.pd || plan.first;
        });
        els.then.forEach(function (el) {
          setText(el, plan.then);
        });
        els.save.forEach(function (el) {
          if (el.hasAttribute('data-cx-tpl')) {
            /* Custom savingsTemplate: resolve it, but only while there is a
               real saving to claim. */
            setText(
              el,
              plan.save ? resolveTpl(el.getAttribute('data-cx-tpl'), vals) : ''
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
      } else if (state.mode === 'subscription' && !data.requiresSellingPlan) {
        setMode('one_time');
      }
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
      render();
      /* Force: some themes rebuild form internals on variant change and drop
         our hidden input's value in the process. */
      applySellingPlan(true);
    }

    function onPlanChosen(planId) {
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
       ([data-cx-gated][hidden]) or inside the unmounted [hidden] embed
       wrapper — so nothing external ever acts for a widget the visitor
       cannot see. Namespace note: this page may also carry ANOTHER vendor's
       "cx-*" element ids; we only ever share state through this one guarded
       global, never through DOM ids. */
    try {
      var subs = (window.CellexiaSubs = window.CellexiaSubs || {});
      subs.widgets = subs.widgets || [];
      subs.widgets.push({
        getState: function () {
          if (root.closest('[hidden]')) {
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
        }
      });
      if (!subs.getState) {
        /* First visible widget wins (there is at most one visible: the
           section block suppresses the embed). */
        subs.getState = function () {
          for (var wi = 0; wi < subs.widgets.length; wi++) {
            var widgetState = null;
            try {
              widgetState = subs.widgets[wi].getState();
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
          for (var wj = 0; wj < subs.widgets.length; wj++) {
            try {
              subs.widgets[wj].setVariant(variantId);
            } catch (err) {
              /* never break the page over a variant sync */
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
        setMode(tab.getAttribute('data-cx-tab'));
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
          list.querySelectorAll('[data-cx-tab]')
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
        setMode(listTabs[next].getAttribute('data-cx-tab'));
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

    if (form) {
      form.addEventListener('change', function (event) {
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
          var idInput = form.querySelector('[name="id"]');
          if (idInput) {
            onVariantMaybeChanged(idInput.value);
          }
        }, 0);
      });
      /* Last-moment safety: guarantee the input (and the _cx_design stamp)
         reflects the selection even if a theme script rewrote the form. */
      form.addEventListener(
        'submit',
        function () {
          applySellingPlan(true);
        },
        true
      );
    }

    function onUrlChange() {
      var fromUrl = variantIdFromUrl();
      if (fromUrl) {
        onVariantMaybeChanged(fromUrl);
      }
    }
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('cx:locationchange', onUrlChange);

    /* ── Initial paint + sync (injects the hidden input on load so the very
          first Add to Cart already carries the preselected plan) ─────────── */
    render();
    setMode(state.mode);
    applySellingPlan(true);
  }

  function boot() {
    patchHistory();
    previewBoot();
    var roots = document.querySelectorAll('[data-cx-buybox]');
    Array.prototype.forEach.call(roots, init);
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
        event.target.querySelectorAll('[data-cx-buybox]'),
        init
      );
      /* A re-rendered section comes back gated — re-reveal without refetch. */
      if (previewValidated) {
        revealGated();
      }
    }
  });
})();
