import { createHash } from "node:crypto";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Experiment kernel (v1.24.0) — deterministic customer-level test groups.
 *
 * Design invariants, in the house style of the risk model and the survey
 * holdout:
 *
 * - DETERMINISTIC, NO RNG: the arm is a pure sha256 hash of
 *   (experimentKey, lowercased email) — same customer, same arm, forever,
 *   recomputable offline. Math.random has no place in a system whose results
 *   must be auditable months later.
 * - PER CUSTOMER, NEVER PER CONTRACT: the unit is the email. A customer with
 *   two contracts must never be their own control (the per-contract cooldown
 *   farming bug taught the same lesson).
 * - FROZEN AT EXPOSURE: the first time a decision actually diverges for a
 *   customer, an ExperimentAssignment row freezes their arm. Allocation
 *   changes later never reshuffle already-exposed customers; readouts
 *   resolve arms exclusively from these rows, so "was in the test" always
 *   means "the treatment actually differed for them".
 * - DEFINITIONS LIVE IN CODE: arms, shares and setting overrides are typed
 *   and reviewed here, not free-form JSON. The `experiments` setting stores
 *   only enabled/started/stopped per key (edited on the Experiments page).
 * - A DISABLED (or stopped) experiment always resolves to its control arm
 *   and records nothing.
 *
 * Adding an experiment: append a definition below; wire its decision point
 * through assignedArm/settingOverride; the Experiments page and readout pick
 * it up from the registry automatically.
 */

export interface ExperimentArm {
  key: string;
  /** Percentage share of customers, all arms summing to 100. Control first. */
  share: number;
  description: string;
  /**
   * Numeric setting overrides applied when this arm wins at a decision point
   * wired through settingOverride(), keyed "settingsKey.path". Overrides are
   * CAPS: the resolved value is min(configured, override), never a raise.
   */
  overrides?: Readonly<Record<string, number>>;
}

export interface ExperimentDef {
  key: string;
  name: string;
  hypothesis: string;
  /** Control arm first — the disabled/stopped resolution. */
  arms: readonly ExperimentArm[];
  /** What the readout judges on (shown on the Experiments page). */
  primaryMetric: string;
  /** Enabled before the merchant ever touches the toggle. Reserved for
   * experiments that MUST exist from subscriber #1 or lose their control
   * group forever. */
  defaultEnabled: boolean;
}

export const EXPERIMENTS: readonly ExperimentDef[] = [
  {
    key: "gift2_holdout",
    name: "Cycle-2 surprise gift",
    hypothesis:
      "The unannounced cycle-2 gift pays for its COGS in cycle-2→3 survival (OFFER_PLAYBOOK §5). A standing holdout is the only way to ever measure it — it cannot be added after launch.",
    arms: [
      {
        key: "gift",
        share: 87.5,
        description: "Receives the cycle-2 surprise gift and the teaser email",
      },
      {
        key: "no_gift",
        share: 12.5,
        description:
          "No cycle-2 gift and no teaser — the comparison group the measurement depends on",
      },
    ],
    primaryMetric:
      "Cycle-3 survival and cohort LTGP per subscriber, against gift COGS",
    defaultEnabled: true,
  },
  {
    key: "final_offer_depth",
    name: "Final offer: 25% vs 20%",
    hypothesis:
      "A 20% final offer saves nearly as many cancels as 25% while giving up a fifth less margin on every save.",
    arms: [
      { key: "pct25", share: 50, description: "Control — the configured depth" },
      {
        key: "pct20",
        share: 50,
        description: "Final offer capped at 20%",
        overrides: { "cancelFlow.finalOfferPct": 20 },
      },
    ],
    primaryMetric:
      "Save rate × 90-day stick rate × margin given up per saved subscriber",
    defaultEnabled: false,
  },
  {
    key: "winback_discount_depth",
    name: "Win-back discount: 20% vs 15%",
    hypothesis:
      "Returning customers respond to the invitation more than the number; 15% wins back nearly as many at lower cost.",
    arms: [
      { key: "pct20", share: 50, description: "Control — the configured depth" },
      {
        key: "pct15",
        share: 50,
        description: "Win-back discount capped at 15%",
        overrides: { "winback.discountPct": 15 },
      },
    ],
    primaryMetric: "Reactivation rate × margin given up per win-back",
    defaultEnabled: false,
  },
];

export function experimentByKey(key: string): ExperimentDef | null {
  return EXPERIMENTS.find((d) => d.key === key) ?? null;
}

/** Pure hash → arm, mirroring surveyHoldoutForContract's bucket math. */
export function armForUnit(def: ExperimentDef, unit: string): string {
  const digest = createHash("sha256")
    .update(`experiment:${def.key}:${unit.trim().toLowerCase()}`)
    .digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16) % 10000; // 0..9999 = 0.00%..99.99%
  let acc = 0;
  for (const arm of def.arms) {
    acc += Math.round(arm.share * 100);
    if (bucket < acc) return arm.key;
  }
  return def.arms[def.arms.length - 1].key;
}

async function experimentEnabled(
  shopId: string,
  def: ExperimentDef,
): Promise<boolean> {
  try {
    const settings = await getSetting(shopId, "experiments");
    const entry = settings.entries[def.key];
    if (!entry) return def.defaultEnabled;
    return entry.enabled && !entry.stoppedAt;
  } catch (err) {
    // Settings unreadable — fail to control behavior, never to a treatment.
    console.error("[experiments] settings read failed", def.key, err);
    return false;
  }
}

/**
 * The arm this customer is in, recording first exposure. Call this ONLY at
 * the decision point where treatment actually diverges — exposure rows are
 * the readout's population, and a customer counted before their treatment
 * could differ dilutes every measurement. Disabled experiments resolve to
 * control with no row. Never throws; failures resolve to control.
 */
export async function assignedArm(opts: {
  shopId: string;
  experimentKey: string;
  email: string;
  contractId?: string | null;
}): Promise<string> {
  const def = experimentByKey(opts.experimentKey);
  if (!def) throw new Error(`Unknown experiment: ${opts.experimentKey}`);
  const control = def.arms[0].key;
  try {
    if (!(await experimentEnabled(opts.shopId, def))) return control;
    const unit = opts.email.trim().toLowerCase();
    if (!unit) return control;

    const existing = await prisma.experimentAssignment.findUnique({
      where: {
        shopId_experimentKey_unit: {
          shopId: opts.shopId,
          experimentKey: def.key,
          unit,
        },
      },
    });
    if (existing) return existing.arm;

    const arm = armForUnit(def, unit);
    await prisma.experimentAssignment.upsert({
      where: {
        shopId_experimentKey_unit: {
          shopId: opts.shopId,
          experimentKey: def.key,
          unit,
        },
      },
      update: {},
      create: {
        shopId: opts.shopId,
        experimentKey: def.key,
        unit,
        arm,
        contractId: opts.contractId ?? null,
      },
    });
    await logEvent({
      shopId: opts.shopId,
      contractId: opts.contractId ?? null,
      email: opts.email,
      type: "experiment.exposed",
      source: "SYSTEM",
      actor: "experiment_kernel",
      payload: { experimentKey: def.key, arm },
    });
    return arm;
  } catch (err) {
    console.error("[experiments] assignment failed", def.key, err);
    return control;
  }
}

/**
 * Numeric setting override for a decision point, e.g.
 * settingOverride({..., path: "cancelFlow.finalOfferPct", current: 25}).
 * Scans enabled experiments whose winning arm overrides `path`; first match
 * wins (the registry keeps override paths disjoint across experiments).
 */
export async function settingOverride(opts: {
  shopId: string;
  email: string;
  contractId?: string | null;
  path: string;
  current: number;
}): Promise<number> {
  for (const def of EXPERIMENTS) {
    const hasPath = def.arms.some((a) => a.overrides?.[opts.path] != null);
    if (!hasPath) continue;
    if (!(await experimentEnabled(opts.shopId, def))) continue;
    // Overrides are CAPS, never raises: an arm labeled "capped at 20%" must
    // not hand out a deeper discount than the merchant configured (a
    // configured depth below the arm constant would otherwise invert the
    // experiment's economics). When no arm's cap can actually change the
    // configured value, treatment cannot diverge here — resolve to the
    // configured value WITHOUT recording exposure, or the readout counts
    // customers whose treatment never differed.
    const canDiverge = def.arms.some((a) => {
      const o = a.overrides?.[opts.path];
      return typeof o === "number" && Math.min(o, opts.current) !== opts.current;
    });
    if (!canDiverge) return opts.current;
    const arm = await assignedArm({
      shopId: opts.shopId,
      experimentKey: def.key,
      email: opts.email,
      contractId: opts.contractId,
    });
    const override = def.arms.find((a) => a.key === arm)?.overrides?.[
      opts.path
    ];
    if (typeof override === "number") return Math.min(opts.current, override);
    return opts.current;
  }
  return opts.current;
}

/**
 * The cycle-2 surprise-gift arm for a contract's customer — the gift engine
 * skips the ORDER_INDEX=2 rule grant (and the lifecycle engine the teaser)
 * for "no_gift". Exposure is recorded here because this IS the divergence
 * point.
 */
export async function surpriseGiftArmFor(contract: {
  shopId: string;
  id: string;
  email: string;
}): Promise<"gift" | "no_gift"> {
  const arm = await assignedArm({
    shopId: contract.shopId,
    experimentKey: "gift2_holdout",
    email: contract.email,
    contractId: contract.id,
  });
  return arm === "no_gift" ? "no_gift" : "gift";
}
