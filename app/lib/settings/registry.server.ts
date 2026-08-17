import { z } from "zod";

/**
 * Typed settings registry. Every operational behavior that the spec says must be
 * "a setting, not an accident" lives here with an explicit default. Values are
 * stored per-shop in the Setting table as JSON; reads fall back to defaults.
 *
 * Read/write via app/lib/settings/settings.server.ts (getSetting / setSetting).
 */

/**
 * Bounds for priceChangePolicy.noticeDays — the advance-notice compliance
 * window for repricing stored-credential billing. Exported because the policy
 * value is not the only path to a notice window: createPriceChangeBatch
 * accepts a per-batch override (fed by the app.bulk.tsx form), and every such
 * caller must enforce the SAME bound or a typed "0"/"3" collapses the notice
 * period to same-day repricing that the registry floor exists to prevent.
 */
export const PRICE_CHANGE_NOTICE_DAYS_MIN = 7;
export const PRICE_CHANGE_NOTICE_DAYS_MAX = 90;

/**
 * One Shopify tag value (tagging group). Shopify treats the comma as the tag
 * separator on every surface that renders tags (admin, CSV export, REST), so
 * a comma inside a single tag would silently split into two; 255 chars is
 * Shopify's per-tag limit. Trimmed: tagsRemove matches byte-exact, and an
 * invisible leading space would strand the applied tag unremovable.
 */
const tagValueSchema = z
  .string()
  .trim()
  .min(1, "Tag cannot be empty")
  .max(255, "Shopify tags are limited to 255 characters")
  .refine((v) => !v.includes(","), {
    message: "Shopify tags cannot contain commas",
  });

export const settingsSchemas = {
  /**
   * Launch state — the install-dark safety contract. Installing the app makes
   * NO change visible on the live store until the admin explicitly goes live:
   * while mode is "SETUP", customer-facing jobs are skipped, customer
   * notifications and Klaviyo events are suppressed at source, the public
   * portal is closed and the buy-box block renders hidden (admin preview
   * tokens excepted). A shop metafield (cellexia.launch_status) mirrors mode
   * for Liquid. Only the explicit go-live admin action flips mode to "LIVE".
   */
  launch: z
    .object({
      mode: z.enum(["SETUP", "LIVE"]),
      wentLiveAt: z.string().nullable(),
      confirmedThemeBlock: z.boolean(),
      confirmedKlaviyo: z.boolean(),
      previewedStorefront: z.boolean(),
      previewedPortal: z.boolean(),
    })
    .default({
      mode: "SETUP",
      wentLiveAt: null,
      confirmedThemeBlock: false,
      confirmedKlaviyo: false,
      previewedStorefront: false,
      previewedPortal: false,
    }),

  /**
   * Where the buy box shows (v1.25.0) — market-scoped widget visibility,
   * orthogonal to the launch mode. `all` (default) = every Shopify Market;
   * `selected` = only markets whose handle is listed (exact
   * `localization.market.handle` match — the storefront rule in
   * cx-buybox-core.liquid). Mirrored to the `cellexia.widget_markets` shop
   * metafield (`{v:1, mode, handles}`; ABSENT ⇔ all markets, so a shop that
   * never touched this needs no sync). Machine-readable by the Preview &
   * launch page only — the generic Settings page never renders it. A separate
   * key rather than a field on `launch` on purpose: every `launch` field is
   * required, so a new one would make existing LIVE rows fail to parse and
   * fall back to SETUP. `selected` with zero handles (hidden everywhere) is
   * refused at save time — never what a merchant meant.
   */
  widgetMarkets: z
    .object({
      mode: z.enum(["all", "selected"]).default("all"),
      handles: z
        .array(z.string().trim().min(1).max(255))
        .max(50)
        .default([]),
    })
    .default({ mode: "all", handles: [] }),

  /** Discount stacking rules — subscription discount vs promo codes vs referral credit. */
  discountStacking: z
    .object({
      allowPromoCodesOnFirstOrder: z.boolean(),
      // Codes misbehave on renewals; renewal pricing comes only from plan pricing
      // policies + DiscountGrants. Keep false unless you fully understand the risk.
      allowPromoCodesOnRenewals: z.boolean(),
      referralCreditStacksWithSubscription: z.boolean(),
      maxTotalDiscountPct: z.number().int().min(0).max(90),
    })
    .default({
      allowPromoCodesOnFirstOrder: true,
      allowPromoCodesOnRenewals: false,
      referralCreditStacksWithSubscription: true,
      maxTotalDiscountPct: 45,
    }),

  /** Product price changes: propagate to existing contracts with notice, or grandfather. */
  priceChangePolicy: z
    .object({
      mode: z.enum(["GRANDFATHER", "PROPAGATE_WITH_NOTICE"]),
      noticeDays: z
        .number()
        .int()
        .min(PRICE_CHANGE_NOTICE_DAYS_MIN)
        .max(PRICE_CHANGE_NOTICE_DAYS_MAX),
    })
    .default({ mode: "GRANDFATHER", noticeDays: 30 }),

  /** Out-of-stock on renewal. */
  stockout: z
    .object({
      policy: z.enum(["DELAY", "SKIP_NOTIFY", "SUBSTITUTE"]),
      delayDays: z.number().int().min(1).max(30),
      notifyCustomer: z.boolean(),
      maxDelays: z.number().int().min(1).max(5),
    })
    .default({ policy: "DELAY", delayDays: 7, notifyCustomer: true, maxDelays: 2 }),

  /** Dunning ladder. Days are offsets from the first failure. */
  dunning: z
    .object({
      softRetryDays: z
        .array(z.number().int().min(0))
        .min(1)
        .refine(
          (days) => days.every((d, i) => i === 0 || d > days[i - 1]),
          {
            message:
              "softRetryDays must be strictly increasing (offsets from the first failure)",
          },
        ),
      paydayAlign: z.boolean(),
      paydaysOfMonth: z.array(z.number().int().min(1).max(28)),
      paydaySnapWindowDays: z.number().int().min(0).max(7),
      emailLadderDays: z.array(z.number().int().min(0)),
      smsDay: z.number().int().min(0),
      preExpiryNoticeDays: z.number().int().min(7).max(60),
      backupPaymentFallback: z.boolean(),
      // What happens when the ladder is exhausted.
      exhaustedAction: z.enum(["PAUSE", "CANCEL"]),
      cancelAfterFailedDays: z.number().int().min(7).max(90),
    })
    .default({
      softRetryDays: [0, 3, 7, 14],
      paydayAlign: true,
      paydaysOfMonth: [1, 15, 25],
      paydaySnapWindowDays: 3,
      emailLadderDays: [0, 3, 7],
      smsDay: 8,
      preExpiryNoticeDays: 30,
      backupPaymentFallback: true,
      exhaustedAction: "PAUSE",
      cancelAfterFailedDays: 30,
    }),

  /** Pause behavior. */
  pause: z
    .object({
      maxMonths: z.number().int().min(1).max(6),
      resumeReminderDaysBefore: z.number().int().min(1).max(14),
    })
    .default({ maxMonths: 3, resumeReminderDaysBefore: 7 }),

  /** Customer portal. */
  portal: z
    .object({
      contextualPrompts: z.boolean(),
      allowAddProducts: z.boolean(),
      otpCodeTtlMinutes: z.number().int().min(5).max(30),
      sessionTtlDays: z.number().int().min(1).max(90),
      magicLinkTtlDays: z.number().int().min(1).max(30),
      // Promoted from hardcoded constants (portal audit) so the merchant can
      // tune them without a deploy. Field-level defaults keep previously
      // stored values valid (additive change).
      /** Portal + magic-link mutation ceiling per rolling hour per customer. */
      mutationsPerHour: z.number().int().min(5).max(500).default(30),
      /** How far ahead the customer may move their next order date. */
      nextDateMaxDays: z.number().int().min(7).max(365).default(90),
      /** Max quantity per contract line editable from the portal. */
      maxLineQuantity: z.number().int().min(1).max(100).default(20),
      /** OTP login: code requests per rolling hour per email. */
      otpRequestsPerHour: z.number().int().min(1).max(20).default(3),
      /** OTP login: wrong guesses before a code dies. */
      otpVerifyMaxAttempts: z.number().int().min(3).max(10).default(5),
      /** Contextual "push it back" prompt: predicted-empty buffer (days). */
      contextualPromptBufferDays: z.number().int().min(1).max(60).default(10),
      /** Contextual "push it back" prompt: weeks the one-tap delay applies. */
      contextualPromptDelayWeeks: z.number().int().min(1).max(12).default(3),
      /**
       * Friendly lock-window messaging (v1.19.0, ON by default). The plan
       * lock MECHANIC is untouched either way — this only reframes what the
       * customer reads while it runs. On: the portal shows a "welcome
       * period" progress card (day X of Y, benefit-first copy, what stays
       * available) instead of the plain restriction notice, and the
       * blocked-action toast, magic-link page and SMS reply use matching
       * reassuring copy with the unlock date. Off: the original factual
       * notice everywhere. The friendly copy assumes the locked plan came
       * with an intro/welcome offer ("your welcome price stays protected"),
       * which is the reason lockDays exists — merchants locking plans with
       * no intro pricing should turn this off.
       */
      friendlyLockMessaging: z.boolean().default(true),
    })
    .default({
      contextualPrompts: true,
      allowAddProducts: true,
      otpCodeTtlMinutes: 10,
      sessionTtlDays: 30,
      magicLinkTtlDays: 14,
      mutationsPerHour: 30,
      nextDateMaxDays: 90,
      maxLineQuantity: 20,
      otpRequestsPerHour: 3,
      otpVerifyMaxAttempts: 5,
      contextualPromptBufferDays: 10,
      contextualPromptDelayWeeks: 3,
      friendlyLockMessaging: true,
    }),

  // NOTE deliberately NO "buyBox" group here: buy-box presentation (savings
  // format, option order/preselect, reassurance line) is controlled by the
  // theme-editor block settings the widget actually reads
  // (extensions/cellexia-buy-box/blocks/buy-box.liquid — savings_format,
  // preselect_subscription, show_reassurance) plus the published design
  // presets. A registry group here once shadowed those as admin controls that
  // nothing consumed — live-looking dead toggles; do not re-add one without
  // wiring it into the payload the extension reads. Orphaned Setting rows
  // with key "buyBox" from that era are inert (getSetting never reads them).

  /** Cadence intelligence. */
  cadence: z
    .object({
      fastShippingSkipAlert: z.boolean(),
      // Alert when a subscriber skips >= this fraction of recent cycles (e.g. every 2nd).
      skipRatioThreshold: z.number().min(0.1).max(1),
      skipRatioWindowCycles: z.number().int().min(2).max(12),
    })
    .default({
      fastShippingSkipAlert: true,
      skipRatioThreshold: 0.5,
      skipRatioWindowCycles: 4,
    }),

  /** Shipment consolidation (routine box). */
  consolidation: z
    .object({
      autoMergeAlignedContracts: z.boolean(),
      alignmentWindowDays: z.number().int().min(0).max(7),
    })
    .default({ autoMergeAlignedContracts: true, alignmentWindowDays: 3 }),

  /** Transactional notifications. */
  notifications: z
    .object({
      upcomingOrderDaysBefore: z.number().int().min(1).max(14),
      // One-tap add-on leg of the upcoming-order reminder: attach an
      // `addon_url` magic link (+ title/price properties) suggesting one extra
      // product for the next box. Field-level defaults keep previously stored
      // values valid (additive change).
      addonSuggestionEnabled: z.boolean().default(true),
      // Variant to suggest: full GID, numeric variant ID, or "" for automatic
      // (top subscribable catalog product the customer doesn't already get).
      addonSuggestionVariantId: z
        .string()
        .refine(
          (v) =>
            v === "" ||
            /^\d+$/.test(v) ||
            v.startsWith("gid://shopify/ProductVariant/"),
          {
            message:
              "Use a variant GID (gid://shopify/ProductVariant/…), a numeric variant ID, or leave empty for automatic",
          },
        )
        .default(""),
      channels: z.object({
        email: z.boolean(),
        sms: z.boolean(),
      }),
    })
    .default({
      upcomingOrderDaysBefore: 3,
      addonSuggestionEnabled: true,
      addonSuggestionVariantId: "",
      channels: { email: true, sms: true },
    }),

  /** Cancel flow configuration. */
  cancelFlow: z
    .object({
      enabled: z.boolean(),
      // Final-chance offer, reserved for the very last step only.
      finalOfferPct: z.number().int().min(0).max(40),
      finalOfferCycles: z.number().int().min(1).max(4),
      // A customer can only receive the final offer once per this many days.
      finalOfferCooldownDays: z.number().int().min(30).max(720),
      reasonOfferPctDefault: z.number().int().min(0).max(30),
      reasonOfferCyclesDefault: z.number().int().min(1).max(4),
      // A customer can only accept (or be shown) the reason-matched DISCOUNT
      // save once per this many days — the anti-farming counterpart of
      // finalOfferCooldownDays for the step-3 offer. Field-level defaults keep
      // previously stored values valid (additive change).
      reasonOfferCooldownDays: z.number().int().min(0).max(720).default(90),
      // Behavior knobs promoted from code constants (defaults = old constants).
      maxSavesShown: z.number().int().min(1).max(4).default(2),
      frequencySuggestDeltaWeeks: z.number().int().min(1).max(12).default(2),
      pauseSuggestMonths: z.number().int().min(1).max(6).default(2),
      sessionFreshMinutes: z.number().int().min(15).max(720).default(60),
      // Free-product save (v1.24.0): a dynamically picked gift on the next
      // cycle as a non-price save. Costs COGS instead of face-value margin,
      // so it is the preferred sweetener for non-price cancel reasons
      // (OFFER_PLAYBOOK §2). Requires a non-empty gifts.pool to render.
      // Cooldown is per CUSTOMER (email), not per contract — cancelling and
      // re-subscribing must not reset it. Field-level defaults keep
      // previously stored values valid (additive change).
      giftSaveEnabled: z.boolean().default(true),
      giftSaveCooldownDays: z.number().int().min(0).max(720).default(180),
    })
    .default({
      enabled: true,
      finalOfferPct: 25,
      finalOfferCycles: 2,
      finalOfferCooldownDays: 180,
      reasonOfferPctDefault: 15,
      reasonOfferCyclesDefault: 2,
      reasonOfferCooldownDays: 90,
      maxSavesShown: 2,
      frequencySuggestDeltaWeeks: 2,
      pauseSuggestMonths: 2,
      sessionFreshMinutes: 60,
      giftSaveEnabled: true,
      giftSaveCooldownDays: 180,
    }),

  /** Lifecycle & milestones. */
  lifecycle: z
    .object({
      surpriseGiftOnCycle2: z.boolean(),
      milestoneGiftCycle: z.number().int().min(2).max(24), // e.g. order 6
      anniversaryGiftDays: z.number().int().min(90).max(1000), // e.g. 365
      rewardsUnlockDay: z.number().int().min(30).max(365), // retention milestone dressed as a perk
      earlyCycleIncentivesEnabled: z.boolean(), // extra nudges through cycles 1–2
      // Milestones AFTER milestoneGiftCycle (v1.24.0): the goal-gradient hook
      // must never exhaust — once order 6 is reached there should always be a
      // next rung (12, 18, ...). Consumed by the lifecycle engine (fires the
      // milestone email + a dynamic gift at each rung) and the portal counter
      // (portal/growth.server.ts shows "N boxes until your next reward").
      // Field-level default keeps previously stored values valid.
      milestoneLadder: z
        .array(z.number().int().min(2).max(96))
        .max(12)
        .default([12, 18, 24])
        .refine(
          (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]),
          { message: "Ladder rungs must be strictly increasing" },
        ),
      // Day-90 "rewards unlocked" carries a REAL reward (v1.24.0): a
      // dynamically picked free product on the next cycle. Without it the
      // email is copy with no economics behind it — the truth-in-emails rule
      // (the rewards email only promises the product when a grant exists).
      rewardsGiftEnabled: z.boolean().default(true),
    })
    .default({
      surpriseGiftOnCycle2: true,
      milestoneGiftCycle: 6,
      anniversaryGiftDays: 365,
      rewardsUnlockDay: 90,
      earlyCycleIncentivesEnabled: true,
      milestoneLadder: [12, 18, 24],
      rewardsGiftEnabled: true,
    }),

  /**
   * Dynamic gift pool + affinity ranking (v1.24.0). Consumed by the gift
   * picker (app/lib/gifts/picker.server.ts), which resolves DYNAMIC GiftRule
   * grants, cancel-flow gift saves, win-back perks and the day-90 reward.
   * Structured values (pool rows, pairings) are edited from the Gifts page
   * (app/routes/app.gifts.tsx), never from the generic Settings renderer —
   * the record shapes don't fit its field types. Schema stays permissive on
   * record KEYS (a product deleted later must not corrupt the stored value);
   * live keys are validated at the editing surface, like emails.templates.
   */
  gifts: z
    .object({
      // Products eligible to be picked as gifts. variantTitle is a display
      // cache; unitCostCents is the merchant's COGS override (0 = use
      // Shopify's cost-per-item at pick time). Live price/image/product data
      // is always fetched fresh from Shopify when picking or emailing.
      pool: z
        .array(
          z.object({
            variantId: z
              .string()
              .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
            variantTitle: z.string().nullable().default(null),
            unitCostCents: z.number().int().min(0).max(10_000_000).default(0),
          }),
        )
        .max(50)
        .default([]),
      // Subscribed product GID → gift variant GIDs, best first ("whoever gets
      // the serum most likely wants the night cream"). The strongest ranking
      // signal — the merchant knows the catalog; co-purchase data can sharpen
      // this once real order history exists.
      pairings: z
        .record(z.string(), z.array(z.string()).max(50))
        .default({}),
      // "question:option" (survey answer, e.g. "motive:prevention") → gift
      // variant GIDs, best first. A tiebreaker after pairings; empty by
      // default. Keys follow app/lib/survey/shared.ts option keys.
      surveyPairings: z
        .record(z.string(), z.array(z.string()).max(50))
        .default({}),
      // One box should feel generous, not bought — and two gifts in one
      // parcel doubles the spend at the exact moment one would do.
      maxGiftsPerCycle: z.number().int().min(1).max(3).default(1),
    })
    .default({
      pool: [],
      pairings: {},
      surveyPairings: {},
      maxGiftsPerCycle: 1,
    }),

  /**
   * Experiment switches (v1.24.0). Experiment DEFINITIONS — arms, allocation,
   * decision points, readout — live in code (app/lib/experiments/
   * registry.server.ts); this key stores only which are enabled and when they
   * started/stopped, edited from the Experiments page. Record keys stay
   * permissive on purpose (a retired experiment must never corrupt the stored
   * value — the emails.templates rule); live keys are validated at the
   * editing surface. startedAt/stoppedAt are ISO stamps written on toggle —
   * readouts window their outcome queries by them.
   */
  experiments: z
    .object({
      entries: z
        .record(
          z.string().regex(/^[a-z0-9_]+$/),
          z.object({
            enabled: z.boolean().default(false),
            startedAt: z.string().nullable().default(null),
            stoppedAt: z.string().nullable().default(null),
          }),
        )
        .default({}),
    })
    .default({ entries: {} }),

  /**
   * Design measurement (v1.26.0) — the knobs of the buy-box Results tab
   * (app/routes/app.buy-box_.results.tsx), edited THERE, never from the
   * generic Settings page. Consumed by app/lib/design-measurement/*:
   *
   * - startedAt: ISO date ("2026-09-01") from which readouts count orders by
   *   default (null = all time). The merchant's "measurement began here"
   *   marker; pre-launch test orders live before it.
   * - excludeEmails: staff / test-buyer emails (lowercased at parse). An
   *   order whose checkout email is listed is stamped `staff = true` on its
   *   SubscribableOrder row and left out of every readout; the nightly
   *   design_facts_backfill recomputes the flag over the last 90 days when
   *   the list changes. The email itself is never stored on the fact row.
   * - guardrailMaxOrderDropPct / guardrailMinOrdersPerWeek: the total-orders
   *   guardrail (a design that lifts take rate by depressing checkouts is a
   *   loss): a variant's mean weekly orders (weeks with at least
   *   minOrders) more than maxDropPct below the reference over two or more
   *   weeks is a breach. Merchant-editable per the v1.26.0 decision.
   * - weeklySessions: optional product-page sessions per ISO week
   *   ("2026-W35"), typed in from Shopify Analytics, so the Results tab can
   *   show a conversion rate (orders ÷ sessions) next to the take rate.
   *   Record keys stay permissive beyond the shape regex (a typo is a
   *   harmless extra week, never a corrupted setting).
   */
  designMeasurement: z
    .object({
      startedAt: z.string().nullable().default(null),
      excludeEmails: z
        .array(z.string().trim().toLowerCase().max(254))
        .max(200)
        .default([]),
      guardrailMaxOrderDropPct: z.number().int().min(0).max(90).default(10),
      guardrailMinOrdersPerWeek: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(20),
      weeklySessions: z
        .record(
          z.string().regex(/^\d{4}-W\d{2}$/),
          z.number().int().min(0).max(100000000),
        )
        .default({}),
    })
    .default({
      startedAt: null,
      excludeEmails: [],
      guardrailMaxOrderDropPct: 10,
      guardrailMinOrdersPerWeek: 20,
      weeklySessions: {},
    }),

  /** Win-back for cancelled subscribers, timed to predicted empty date. */
  winback: z
    .object({
      enabled: z.boolean(),
      // Offsets are days relative to predicted empty date.
      softTouchOffsetDays: z.number().int(),
      perkOffsetDays: z.number().int(),
      discountOffsetDays: z.number().int(),
      sunsetOffsetDays: z.number().int(),
      discountPct: z.number().int().min(5).max(30),
      discountCycles: z.number().int().min(1).max(3),
      // Promoted from code constants (defaults = old constants).
      reactivationBillDelayDays: z.number().int().min(1).max(14).default(3),
      linkGraceDays: z.number().int().min(0).max(60).default(14),
    })
    .superRefine((v, ctx) => {
      // The sweep's skip-ahead loop assumes the stages happen in order; a
      // misordered config would silently skip stages, so refuse it here (a
      // stored misordered value falls back to the defaults via getSetting).
      if (
        !(
          v.softTouchOffsetDays < v.perkOffsetDays &&
          v.perkOffsetDays < v.discountOffsetDays &&
          v.discountOffsetDays < v.sunsetOffsetDays
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sunsetOffsetDays"],
          message:
            "Touch offsets must be strictly increasing: soft touch < perk < discount < sunset",
        });
      }
    })
    .default({
      enabled: true,
      softTouchOffsetDays: -7,
      perkOffsetDays: 3,
      discountOffsetDays: 21,
      sunsetOffsetDays: 60,
      discountPct: 20,
      discountCycles: 2,
      reactivationBillDelayDays: 3,
      linkGraceDays: 14,
    }),

  /**
   * Cost model for profitability analytics (LTGP, daily gross profit).
   *
   * This is where COGS, shipping and payment costs are SET — the numbers the
   * Cohorts & LTGP tab subtracts from collected revenue. Nothing here changes
   * billing; it only changes reporting.
   *
   * - paymentFeePct / paymentFeeFixedCents: the processor's per-charge rate
   *   (Shopify Payments CH Basic domestic default: 2.9% + 30¢ — set your real
   *   plan's rate, Shopify plan 2.7%, Advanced 2.5%, intl. cards more).
   * - fulfillmentCostPerShipmentCents: pick/pack/packaging per parcel.
   * - shippingCostPerShipmentCents: what YOU pay the carrier per parcel —
   *   mode "flat" uses flatCents; mode "charged" assumes cost ≈ what the
   *   customer paid for delivery (only sensible when shipping is passed
   *   through at cost; with free shipping "charged" means zero cost, which is
   *   almost certainly wrong — use "flat").
   * - cogsFallbackPctOfPrice: used ONLY for lines with no known unit cost
   *   (no Shopify inventory cost, no per-product override). Every use of the
   *   fallback is counted (DailyRollup/CohortCell.estimatedCogsCents) so the
   *   UI can report COGS coverage and flag partly-estimated LTGP.
   * - vat: VAT / sales tax as a reporting cost. When enabled, both
   *   gross-profit surfaces subtract a flat percentage of each charge's kept
   *   money — kept × rate/100, VAT as a straight expense on revenue
   *   (merchant-defined model, v1.16.0; a £100 charge at 20% books
   *   £20.00 — the default rate is 20% since v1.21.0, previously 8.1%) —
   *   at the contract's delivery-country rate (countryRatesPct,
   *   ISO alpha-2 keys) falling back to defaultRatePct. Captured order tax
   *   (BillingAttempt.taxCents / originOrderTaxCents) keeps being collected
   *   but no longer drives the deduction — it is the tax-extracted-from-
   *   gross figure, a different model. All VAT is rate-derived and is
   *   accumulated into DailyRollup/CohortCell.estimatedVatCents so the
   *   surfaces disclose it as modeled, exactly like estimated COGS.
   *   Field-level default keeps previously stored costModel values valid
   *   (additive change).
   */
  costModel: z
    .object({
      paymentFeePct: z.number().min(0).max(15),
      paymentFeeFixedCents: z.number().int().min(0).max(500),
      fulfillmentCostPerShipmentCents: z.number().int().min(0).max(100_000),
      shippingCostPerShipmentCents: z.object({
        mode: z.enum(["flat", "charged"]),
        flatCents: z.number().int().min(0).max(100_000),
      }),
      cogsFallbackPctOfPrice: z.number().min(0).max(100),
      vat: z
        .object({
          enabled: z.boolean(),
          defaultRatePct: z.number().min(0).max(50),
          countryRatesPct: z.record(
            z
              .string()
              .regex(/^[A-Z]{2}$/, "Use 2-letter ISO country codes (e.g. CH, DE)"),
            z.number().min(0).max(50),
          ),
        })
        .default({ enabled: true, defaultRatePct: 20, countryRatesPct: {} }),
    })
    .default({
      paymentFeePct: 2.9,
      paymentFeeFixedCents: 30,
      fulfillmentCostPerShipmentCents: 0,
      // Flat 0 by default: honest "not configured yet" — the analytics page
      // nudges the merchant to set real per-parcel costs before trusting LTGP.
      shippingCostPerShipmentCents: { mode: "flat", flatCents: 0 },
      cogsFallbackPctOfPrice: 25,
      // ON by default (merchant decision, v1.16.0 — flipped from the v1.15.0
      // off-default before any subscription existed, so nothing is rewritten):
      // VAT is subtracted as a flat 20% of revenue (merchant decision,
      // v1.21.0 — raised from the 8.1% Swiss-rate default; a shop that
      // explicitly SAVED the costModel setting keeps its stored rate, only
      // never-saved shops read the new default) until per-country rates are
      // configured. Both defaults (this one and the field-level one above)
      // must stay in sync.
      vat: { enabled: true, defaultRatePct: 20, countryRatesPct: {} },
    }),

  /**
   * Analytics data-accuracy options (Settings → Analytics data).
   *
   * - excludeRefundedPayments (ON by default, v1.16.0 — merchant decision,
   *   flipped in before any subscription existed): when on, payments with
   *   ANY recorded refund — fully OR partially refunded — are removed from
   *   analytics revenue/gross-profit/LTGP entirely (charge, COGS, fees, VAT,
   *   shipping and billed-cycle count all drop with them), instead of the
   *   off-mode netting (revenue minus refund, full costs kept). Rationale: a
   *   refunded rebill — most often the surprise first renewal that gets
   *   cancelled — is noise the merchant wants out of LTV data, not revenue
   *   to be netted. Consumed by runDailyRollup, computeCohortRows (and
   *   therefore every segment view), getForecast, getSegmentForecast and —
   *   since v1.21.0 — the predicted-LTGP engine (predicted-ltgp.server.ts:
   *   forward predictions apply it as a disclosed expected-refund haircut,
   *   and the accuracy pass applies it to realized actuals) — the five must
   *   stay in lockstep to avoid double-subtraction (see the
   *   estGrossProfitCents doc in rollup.server.ts). The daily rollup
   *   additionally repairs the charge-day rows of refunded payments inside
   *   the standing 90-day window (repairRefundAffectedRollupDays,
   *   flow-columns-only re-upsert) so a refund arriving after its charge's
   *   day closed still removes the payment; TOGGLING this setting repairs
   *   every refund-affected day across all history in both directions
   *   (app.settings.tsx post-save hook), so stored rollup rows always carry
   *   the current mode's semantics.
   *   Contract surfaces (lifetimeRevenueCents, subscriber cockpit) keep
   *   their net-of-refunds meaning regardless — this option shapes derived
   *   analytics only.
   */
  analytics: z
    .object({
      excludeRefundedPayments: z.boolean(),
    })
    .default({ excludeRefundedPayments: true }),

  /**
   * Post-purchase survey (v1.21.0, Settings → Post-purchase survey) — the
   * thank-you / order-status page survey (extensions/cellexia-survey) that
   * feeds churn-risk features and the predicted-LTGP engine.
   *
   * - enabled: master switch consumed by the survey API
   *   (app/routes/api.survey.tsx). OFF = the endpoint's status read reports
   *   disabled (the extension then renders nothing) and answer writes are
   *   refused. Already-stored responses are kept and keep feeding analytics.
   * - holdoutPct: percentage of survey-linked contracts deterministically
   *   assigned surveyHoldout = TRUE at link time (hash of the contract id —
   *   stable, no RNG; app/lib/survey/link.server.ts). Holdout contracts are
   *   excluded from survey-answer-triggered Klaviyo flows (the
   *   `survey_holdout` event property) so each answer segment's measured
   *   churn stays uncontaminated by the interventions the answers trigger.
   *   Changing the percentage only affects FUTURE assignments — an assigned
   *   flag is never reshuffled, or the untreated comparison group would be
   *   worthless.
   *
   * - writesPerHour: abuse ceiling on survey writes per rolling hour across
   *   the shop (the endpoint is public-with-session-token, so any buyer can
   *   reach it; the per-order unique key bounds rows per real order and this
   *   cap bounds synthetic-order spam). Refusals are business-level 200s so
   *   the extension never retry-storms.
   *
   * The question set itself (wording, option keys, version) is deliberately
   * NOT a setting: it is a frozen measurement instrument
   * (SURVEY_QUESTION_SET_VERSION in app/lib/survey/shared.ts, mirrored in
   * the extension source) — editing wording mid-stream would silently pool
   * answers from different instruments.
   */
  survey: z
    .object({
      enabled: z.boolean(),
      holdoutPct: z.number().min(0).max(50),
      writesPerHour: z.number().int().min(100).max(20000),
    })
    .default({ enabled: true, holdoutPct: 15, writesPerHour: 2000 }),

  /**
   * Portal growth features (v1.20.0, all ON by default) — behavioral-design
   * levers on the customer portal, each independently toggleable. All of
   * them reframe or reorder EXISTING mechanics; none removes a customer
   * capability (skip, delay, pause and cancel stay reachable within two
   * taps everywhere — the honesty rules in portal/growth.server.ts are
   * load-bearing).
   *
   * - homeValueCard: the subscriptions-list card leads with member value
   *   (captured savings, milestone proximity) and an add-products CTA
   *   instead of one-tap skip/delay buttons (which advertise skipping);
   *   skip/delay live on the Manage page.
   * - addonUpsell: the add-a-product section opens expanded with
   *   ships-with-your-delivery framing, the one-time "try it" as the
   *   primary action (foot-in-the-door), and a "popular add-on" badge
   *   backed by real cycle.addon_added counts (threshold ≥3, else no badge).
   * - postActionUpsell: after a positive action (unskip, resume, address
   *   update) the success moment offers one add-on — never after a skip.
   * - concessionLadder: the schedule card's quick actions become an ordered
   *   ladder — delay (accented) → deliver less often (kept price/rewards) →
   *   skip (quiet but present) — each row with its concrete consequence
   *   date, milestone note only when truthfully applicable.
   * - cadenceNudge: two or more skips in the trailing 120 days suggests the
   *   plan's next-slower cadence ("your price and rewards stay").
   * - runoutPrompt: when the churn model predicts the customer runs out
   *   BEFORE the next delivery, offer move-it-up / add-one-more — the
   *   inverse of the standing "running low later? push it back" prompt.
   */
  portalGrowth: z
    .object({
      homeValueCard: z.boolean().default(true),
      addonUpsell: z.boolean().default(true),
      postActionUpsell: z.boolean().default(true),
      concessionLadder: z.boolean().default(true),
      cadenceNudge: z.boolean().default(true),
      runoutPrompt: z.boolean().default(true),
    })
    .default({
      homeValueCard: true,
      addonUpsell: true,
      postActionUpsell: true,
      concessionLadder: true,
      cadenceNudge: true,
      runoutPrompt: true,
    }),

  /**
   * Shopify tagging (v1.23.0, ON by default) — mirrors subscription state
   * onto Shopify tags so themes, Shopify Flow, search & discovery filters
   * and third-party apps can key off it without talking to this app.
   *
   * - Customer tag: applied while the customer has ≥1 live (ACTIVE or
   *   PAUSED) contract that is OURS and not demo; removed when their last
   *   live contract ends (cancelled, expired or failed — dunning recovery
   *   re-applies it). The applied value is recorded per customer
   *   (CustomerTagState) so renames swap the old tag for the new one and a
   *   removal can only ever take back a tag this app itself applied.
   * - Order tags: the origin (checkout) order gets the first-order tag at
   *   the proven-ours moment (the contract-create webhook tail); every
   *   renewal order gets the repeat-order tag when its billing attempt
   *   settles. Tags are applied going forward only — orders that predate
   *   the feature (or a rename) keep whatever they have.
   *
   * All writes are suppressed while launch mode is SETUP (install-dark) and
   * contained (a tag failure never breaks a webhook or a billing run).
   * Disabling a toggle stops tag management; already-applied tags are
   * deliberately left in place.
   */
  tagging: z
    .object({
      customerTagEnabled: z.boolean().default(true),
      customerTag: tagValueSchema.default("Active Subscriber"),
      orderTagsEnabled: z.boolean().default(true),
      firstOrderTag: tagValueSchema.default("Subscription First Order"),
      repeatOrderTag: tagValueSchema.default("Subscription Recurring Order"),
    })
    .default({
      customerTagEnabled: true,
      customerTag: "Active Subscriber",
      orderTagsEnabled: true,
      firstOrderTag: "Subscription First Order",
      repeatOrderTag: "Subscription Recurring Order",
    }),

  /**
   * Per-template email customization (v1.16.0, admin Emails tab).
   *
   * `templates` maps a notification TemplateKey to its merchant override:
   * - enabled: false suppresses the send entirely (reason
   *   "template_disabled"). Critical templates ignore it (otp_code,
   *   threeds_action, admin_alert, import_summary — the router bypasses this
   *   the same way it bypasses channel toggles), and the Emails tab refuses
   *   to store it for them.
   * - subject / body: non-empty values replace the built-in copy in BOTH
   *   delivery shapes — the rendered content_subject/content_html/
   *   content_text properties attached to the Klaviyo event (flows render
   *   {{ event.content_html }}), and the direct-SMTP fallback. Empty string
   *   = keep the built-in copy. {placeholders} interpolate from the same
   *   variable set the Klaviyo event carries (skip_url, delay_1w_url,
   *   addon_url, total_estimate, next_date, …).
   *
   * Keys are validated against the real template registry by the Emails tab
   * action; the schema stays permissive (a template retired later must not
   * corrupt the stored value).
   */
  emails: z
    .object({
      templates: z
        .record(
          z.string().regex(/^[a-z0-9_]+$/),
          z.object({
            enabled: z.boolean().default(true),
            subject: z.string().max(300).default(""),
            body: z.string().max(10_000).default(""),
            /**
             * Who delivers this email (v1.17.0):
             * - "auto" — the pre-1.17.0 behavior: Klaviyo event when a key
             *   is configured (the flow owns delivery), direct SMTP
             *   otherwise. Confirmation templates resolve "auto" to their
             *   historical owner (the Klaviyo flow on the state-change
             *   metric) so upgrades change nothing.
             * - "app" — Cellexia renders and sends it via the configured
             *   SMTP transport; the delivery metric is NOT enqueued (the
             *   canonical state-change events keep firing for segments).
             * - "klaviyo" — only the Klaviyo event is emitted; without a
             *   configured key the send is SUPPRESSED honestly
             *   (klaviyo_unconfigured), never silently rerouted.
             */
            sender: z.enum(["auto", "app", "klaviyo"]).default("auto"),
          }),
        )
        .default({}),
    })
    .default({ templates: {} }),

  /**
   * Email brand kit (v1.17.0, admin Emails → Design tab). Drives the shared
   * shell every rendered email uses — direct SMTP and the Klaviyo
   * content_html property alike (app/lib/notifications/format.ts). Defaults
   * reproduce the pre-1.17.0 shell byte-for-byte in spirit: a shop that
   * never opens the Design tab keeps its historical emails.
   */
  emailDesign: z
    .object({
      headerStyle: z.enum(["wordmark", "logo", "none"]).default("wordmark"),
      wordmark: z.string().max(60).default("C E L L E X I A"),
      logoUrl: z
        .string()
        .max(500)
        .refine((v) => v === "" || /^https:\/\//.test(v), {
          message: "Logo URL must start with https://",
        })
        .default(""),
      logoWidth: z.number().int().min(40).max(400).default(140),
      fontFamily: z.enum(["serif", "sans"]).default("serif"),
      backgroundColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#faf8f5"),
      cardBackground: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#ffffff"),
      cardBorderColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#ece7df"),
      textColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#1a1a1a"),
      mutedColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#8a837a"),
      linkColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#1a1a1a"),
      buttonColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#1a1a1a"),
      buttonTextColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#faf8f5"),
      footerText: z
        .string()
        .max(300)
        .default("Cellexia — skincare that keeps its promises."),
      footerNote: z
        .string()
        .max(300)
        .default(
          "You are receiving this email about your Cellexia subscription.",
        ),
    })
    .default({
      headerStyle: "wordmark",
      wordmark: "C E L L E X I A",
      logoUrl: "",
      logoWidth: 140,
      fontFamily: "serif",
      backgroundColor: "#faf8f5",
      cardBackground: "#ffffff",
      cardBorderColor: "#ece7df",
      textColor: "#1a1a1a",
      mutedColor: "#8a837a",
      linkColor: "#1a1a1a",
      buttonColor: "#1a1a1a",
      buttonTextColor: "#faf8f5",
      footerText: "Cellexia — skincare that keeps its promises.",
      footerNote:
        "You are receiving this email about your Cellexia subscription.",
    }),

  /**
   * INTERNAL / MACHINE-WRITTEN — Klaviyo flow coverage cache (v1.18.0).
   * Written by the guided flow setup / verification
   * (app/lib/klaviyo/flows.server.ts) whenever it talks to Klaviyo; read by
   * the Emails overview card and the daily KLAVIYO_FLOW_COVERAGE alert
   * check so neither has to hit Klaviyo's API on every page view or sweep.
   * Not rendered on the Settings page.
   */
  klaviyoFlowSetup: z
    .object({
      /** Last SUCCESSFUL verification. */
      checkedAt: z.string().nullable().default(null),
      /** Last attempt, failed ones included — holds the daily API budget. */
      lastAttemptAt: z.string().nullable().default(null),
      /** Set only by runGuidedSetup — the coverage alert's opt-in gate. */
      setupRanAt: z.string().nullable().default(null),
      rows: z
        .array(
          z.object({
            metric: z.string(),
            status: z.string(),
            flowId: z.string().default(""),
            flowName: z.string().default(""),
            ours: z.boolean().default(false),
            /** Row-level explanation shown under the checklist entry (v1.25.0). */
            detail: z.string().default(""),
          }),
        )
        .default([]),
      /**
       * v1.25.0 — the background verify/setup task record (setup-task.server.ts)
       * so other instances/tabs/reloads can follow a run; report = SetupReport.
       */
      task: z
        .object({
          id: z.string(),
          kind: z.enum(["verify", "setup"]),
          state: z.enum(["running", "done", "failed"]),
          startedAt: z.string(),
          updatedAt: z.string(),
          finishedAt: z.string().nullable().default(null),
          step: z.string().default(""),
          message: z.string().default(""),
          done: z.number().default(0),
          total: z.number().default(0),
          report: z
            .object({
              ok: z.boolean(),
              fatal: z.string().optional(),
              seeded: z.array(z.string()).default([]),
              rows: z.array(
                z.object({
                  key: z.string(),
                  metric: z.string(),
                  name: z.string(),
                  templates: z.array(z.string()).default([]),
                  why: z.string().default(""),
                  status: z.string(),
                  flowId: z.string().default(""),
                  flowName: z.string().default(""),
                  ours: z.boolean().default(false),
                  detail: z.string().default(""),
                }),
              ),
              checkedAt: z.string(),
            })
            .nullable()
            .default(null),
          error: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
    })
    .default({ checkedAt: null, lastAttemptAt: null, setupRanAt: null, rows: [], task: null }),

  /**
   * INTERNAL / MACHINE-WRITTEN — learned churn-risk model state. Written
   * exclusively by the nightly risk_learning_run job
   * (app/lib/analytics/learning.server.ts); never edited by hand and not
   * rendered on the Settings page. Holds the logistic-regression weights,
   * the feature standardization stats (means/stds, aligned with
   * featureNames), the training sample counts, and the time-split holdout
   * evaluation. `promoted` (and mode "learned") is only ever true when the
   * learned model beat the heuristic's holdout AUC by the required margin —
   * risk.server.ts additionally refuses to apply a model whose featureNames
   * don't exactly match the current RISK_FEATURE_NAMES.
   */
  riskModel: z
    .object({
      version: z.literal(1),
      mode: z.enum(["heuristic", "learned"]),
      trainedAt: z.string().nullable(),
      /** Total labeled snapshots the last run produced. */
      sampleCount: z.number().int().min(0),
      /** Distinct contracts with a decided churn outcome. */
      positiveCount: z.number().int().min(0),
      negativeCount: z.number().int().min(0),
      featureNames: z.array(z.string()),
      means: z.array(z.number()),
      stds: z.array(z.number()),
      weights: z.array(z.number()),
      intercept: z.number(),
      evaluation: z
        .object({
          holdoutSize: z.number().int().min(0),
          holdoutPositives: z.number().int().min(0),
          aucLearned: z.number().nullable(),
          aucHeuristic: z.number().nullable(),
          precisionAtTopDecile: z.number().nullable(),
          heuristicPrecisionAtTopDecile: z.number().nullable(),
        })
        .nullable(),
      promoted: z.boolean(),
    })
    .default({
      version: 1,
      mode: "heuristic",
      trainedAt: null,
      sampleCount: 0,
      positiveCount: 0,
      negativeCount: 0,
      featureNames: [],
      means: [],
      stds: [],
      weights: [],
      intercept: 0,
      evaluation: null,
      promoted: false,
    }),

  /**
   * INTERNAL / MACHINE-WRITTEN — predicted-LTGP accuracy ledger. Written
   * exclusively by the nightly predicted_ltgp_run job
   * (app/lib/analytics/predicted-ltgp.server.ts, accuracy pass); never
   * edited by hand and not rendered on the Settings page. For every horizon
   * whose calendar window has fully elapsed for at least one initially-
   * scored contract, compares the FROZEN day-one prediction
   * (SubscriptionContract.predictedLtgpInitial) against the contract's
   * actual realized gross profit over that window: `matured` = contracts
   * measured, `mapePct` = mean absolute percentage error, `biasPct` =
   * signed mean error (positive = the model over-promised). The admin
   * Cohorts & LTGP tab renders these as the honesty chip next to predicted
   * figures — the UI never claims accuracy without matured measurements
   * (the getRiskModelStatus convention).
   */
  ltgpAccuracy: z
    .object({
      version: z.literal(1),
      updatedAt: z.string().nullable(),
      horizons: z
        .record(
          z.enum(["d90", "d180", "y1", "y3", "y5"]),
          z.object({
            matured: z.number().int().min(0),
            mapePct: z.number().nullable(),
            biasPct: z.number().nullable(),
          }),
        )
        .default({}),
    })
    .default({ version: 1, updatedAt: null, horizons: {} }),

  /**
   * INTERNAL / MACHINE-WRITTEN — rolling per-model forecast error history
   * (one entry per ISO week, capped at 26 by the writer). Written by
   * recordForecastAccuracyWeek (app/lib/analytics/forecast.server.ts) on the
   * nightly risk_learning_run tick; never edited by hand and not rendered on
   * the Settings page. `errors` maps forecast model key → that week's
   * out-of-sample one-step holdout APE (mean over MRR + actives, as a
   * fraction; null = model unavailable that week): the error of a forecast
   * trained strictly on earlier weeks, evaluated once on the newest complete
   * week — NOT the mean walk-forward backtest MAPE (the pre-hindsight-audit
   * behavior, whose overlapping folds made consecutive weeks correlated
   * re-measurements of the same history; these entries are independent).
   * getForecast's "auto" selection exponentially weights these entries
   * (recent weeks weigh more) and degrades gracefully when none exist.
   */
  forecastModelHistory: z
    .object({
      version: z.literal(1),
      weeks: z.array(
        z.object({
          /** Monday "yyyy-MM-dd" in the UTC label space of DailyRollup. */
          weekStartIso: z.string(),
          recordedAt: z.string(),
          errors: z.record(z.number().nullable()),
        }),
      ),
    })
    .default({ version: 1, weeks: [] }),

  /**
   * Email transport (direct SMTP) — the admin-panel override of the
   * MAIL_PROVIDER / MAIL_FROM / SMTP_* environment variables. Resolution
   * (app/lib/notifications/mailer.server.ts): provider "" (the default) means
   * "use the environment variables", so an env-only install behaves exactly
   * as before this key existed; provider "smtp"/"console" is an explicit
   * admin choice, with each blank field falling back to its matching env var.
   * smtpPass holds "" or an encrypted blob ("enc:v1:..." —
   * app/lib/crypto/secrets.server.ts); it is redacted from the Settings
   * loader and from settings_updated audit events, never echoed anywhere.
   */
  mailTransport: z
    .object({
      provider: z.enum(["", "smtp", "console"]).default(""),
      /** "" = MAIL_FROM env var (or the built-in default sender). */
      from: z.string().default(""),
      /** "" = SMTP_HOST env var. */
      smtpHost: z.string().default(""),
      /** 0 = SMTP_PORT env var (default 587). */
      smtpPort: z.number().int().min(0).max(65535).default(0),
      /** "" = SMTP_USER env var. */
      smtpUser: z.string().default(""),
      /** "" or encrypted blob; "" = SMTP_PASS env var. */
      smtpPass: z.string().default(""),
      /** auto = implicit TLS on port 465 / SMTP_SECURE env var; else forced. */
      smtpSecure: z.enum(["auto", "always", "never"]).default("auto"),
    })
    .default({
      provider: "",
      from: "",
      smtpHost: "",
      smtpPort: 0,
      smtpUser: "",
      smtpPass: "",
      smtpSecure: "auto",
    }),

  /**
   * Klaviyo connection — the admin-panel override of KLAVIYO_PRIVATE_API_KEY.
   * privateApiKey holds "" or an encrypted blob (see mailTransport note); ""
   * falls back to the environment variable. The API revision stays env-only
   * (KLAVIYO_API_REVISION — docs/INSTALL.md: "only change with a release that
   * says so").
   */
  klaviyo: z
    .object({
      privateApiKey: z.string().default(""),
    })
    .default({ privateApiKey: "" }),

  /** Monitoring & alerting. */
  alerts: z
    .object({
      emailTo: z.array(z.string()),
      failureSpikeThresholdPct: z.number().min(1).max(100),
      churnSpikeThresholdPct: z.number().min(1).max(100),
      stuckContractHours: z.number().int().min(1).max(168),
    })
    .default({
      emailTo: [],
      failureSpikeThresholdPct: 10,
      churnSpikeThresholdPct: 8,
      stuckContractHours: 24,
    }),

  /**
   * INTERNAL / MACHINE-WRITTEN — the latest live self-check report, written
   * by runSelfCheck (app/lib/debug/selfcheck.server.ts) every `selfcheck_run`
   * tick and on every manual run from the Debug page; never edited by hand
   * and not rendered on the Settings page. The Debug page reads it so the
   * report survives restarts and is instantly available without re-probing
   * the live store on page load.
   */
  selfCheck: z
    .object({
      version: z.literal(1),
      lastReport: z
        .object({
          ranAt: z.string(),
          tookMs: z.number().int().nonnegative(),
          trigger: z.enum(["job", "admin"]),
          verdict: z.enum(["HEALTHY", "DEGRADED", "BROKEN"]),
          passCount: z.number().int().nonnegative(),
          warnCount: z.number().int().nonnegative(),
          failCount: z.number().int().nonnegative(),
          skipCount: z.number().int().nonnegative(),
          checks: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              // Loose on purpose: category names are presentation, and a
              // renamed category must not invalidate a stored report.
              category: z.string(),
              status: z.enum(["PASS", "FAIL", "WARN", "SKIP"]),
              detail: z.string(),
              remediation: z.string().optional(),
              ms: z.number().int().nonnegative(),
            }),
          ),
        })
        .nullable(),
    })
    .default({ version: 1, lastReport: null }),
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type SettingsValue<K extends SettingsKey> = z.infer<
  (typeof settingsSchemas)[K]
>;

export function defaultFor<K extends SettingsKey>(key: K): SettingsValue<K> {
  return settingsSchemas[key].parse(undefined) as SettingsValue<K>;
}
