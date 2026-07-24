import { z } from "zod";

/**
 * Typed settings registry. Every operational behavior that the spec says must be
 * "a setting, not an accident" lives here with an explicit default. Values are
 * stored per-shop in the Setting table as JSON; reads fall back to defaults.
 *
 * Read/write via app/lib/settings/settings.server.ts (getSetting / setSetting).
 */

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
      noticeDays: z.number().int().min(7).max(90),
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
      softRetryDays: z.array(z.number().int().min(0)).min(1),
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
    })
    .default({
      contextualPrompts: true,
      allowAddProducts: true,
      otpCodeTtlMinutes: 10,
      sessionTtlDays: 30,
      magicLinkTtlDays: 14,
    }),

  /** Buy box presentation defaults (per-plan overrides on SellingPlanConfig). */
  buyBox: z
    .object({
      savingsFormat: z.enum(["PERCENT", "ABSOLUTE", "BOTH"]),
      subscriptionListedFirst: z.boolean(),
      showReassuranceCopy: z.boolean(), // "Skip, pause or cancel anytime"
    })
    .default({
      savingsFormat: "BOTH",
      subscriptionListedFirst: true,
      showReassuranceCopy: true,
    }),

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
    })
    .default({
      enabled: true,
      finalOfferPct: 25,
      finalOfferCycles: 2,
      finalOfferCooldownDays: 180,
      reasonOfferPctDefault: 15,
      reasonOfferCyclesDefault: 2,
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
    })
    .default({
      enabled: true,
      softTouchOffsetDays: -7,
      perkOffsetDays: 3,
      discountOffsetDays: 21,
      sunsetOffsetDays: 60,
      discountPct: 20,
      discountCycles: 2,
    }),

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
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type SettingsValue<K extends SettingsKey> = z.infer<
  (typeof settingsSchemas)[K]
>;

export function defaultFor<K extends SettingsKey>(key: K): SettingsValue<K> {
  return settingsSchemas[key].parse(undefined) as SettingsValue<K>;
}
