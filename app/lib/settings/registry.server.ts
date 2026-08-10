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
    }),

  /** Lifecycle & milestones. */
  lifecycle: z
    .object({
      surpriseGiftOnCycle2: z.boolean(),
      milestoneGiftCycle: z.number().int().min(2).max(24), // e.g. order 6
      anniversaryGiftDays: z.number().int().min(90).max(1000), // e.g. 365
      rewardsUnlockDay: z.number().int().min(30).max(365), // retention milestone dressed as a perk
      earlyCycleIncentivesEnabled: z.boolean(), // extra nudges through cycles 1–2
    })
    .default({
      surpriseGiftOnCycle2: true,
      milestoneGiftCycle: 6,
      anniversaryGiftDays: 365,
      rewardsUnlockDay: 90,
      earlyCycleIncentivesEnabled: true,
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
    })
    .default({
      paymentFeePct: 2.9,
      paymentFeeFixedCents: 30,
      fulfillmentCostPerShipmentCents: 0,
      // Flat 0 by default: honest "not configured yet" — the analytics page
      // nudges the merchant to set real per-parcel costs before trusting LTGP.
      shippingCostPerShipmentCents: { mode: "flat", flatCents: 0 },
      cogsFallbackPctOfPrice: 25,
    }),

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
