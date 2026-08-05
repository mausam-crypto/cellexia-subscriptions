/**
 * Seed a demo shop + subscriber so the portal and admin can be previewed
 * without a live Shopify store.
 *
 *   DATABASE_URL="file:./dev.sqlite" node scripts/seed-demo.mjs
 *
 * Prints a ready-to-open magic-link URL for the demo customer's portal.
 *
 * Besides the original demo customer (contract 5001, kept intact), this seeds
 * a deterministic fleet of 40 additional contracts (gid 5100-5139) spread over
 * the past 12 months — mixed statuses, realistic billing histories, dunning
 * states, cancellation sessions, score snapshots, acquisition attribution and
 * WIDGET_* telemetry — so the executive dashboard, cohorts, survival curves,
 * subscribers list, retention and dunning screens all render with live-looking
 * data. Fleet creation is skipped when the marker contract (gid .../5100)
 * already exists; every write is an upsert or guarded by an existence check,
 * so the script is safe to re-run.
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

const SHOP = "cellexia-demo.myshopify.com";
const CUSTOMER_ID = "gid://shopify/Customer/9001";
const EMAIL = "demo.customer@example.com";

const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const now = Date.now();

function gid(type, id) {
  return `gid://shopify/${type}/${id}`;
}

// ─────────────────────────── Deterministic PRNG ───────────────────────────
// mulberry32 with a fixed seed: identical fleet on every machine, no
// Math.random side-variance across runs.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eedc311);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) =>
  max <= min ? min : min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;
const round2 = (n) => Math.round(n * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();
const d = (ms) => (ms == null ? null : new Date(ms));

// ─────────────────────────── Fleet vocabulary ─────────────────────────────

const FLEET_SIZE = 40;
const MARKER_CONTRACT_GID = gid("SubscriptionContract", 5100);

const CATALOG = [
  {
    productId: gid("Product", 101),
    variantId: gid("ProductVariant", 201),
    title: "Cellexia Regenerating Serum",
    priceCents: 7900,
  },
  {
    productId: gid("Product", 102),
    variantId: gid("ProductVariant", 202),
    title: "Cellexia Barrier Repair Cream",
    priceCents: 4900,
  },
  {
    productId: gid("Product", 103),
    variantId: gid("ProductVariant", 203),
    title: "Cellexia Clarifying Cleanser",
    priceCents: 3400,
  },
];

const CHANNELS = ["meta-ads", "google", "klaviyo", "organic", "tiktok"];
const LANDING_PAGES = [
  "/pages/firmness-study",
  "/pages/hydration-guide",
  "/products/regenerating-serum",
  "/pages/routine-quiz",
  "/blogs/science/skin-barrier",
];
const CAMPAIGNS = [
  "spring-firmness",
  "summer-glow",
  "retention-q3",
  "brand-search",
  "creator-collab",
  "newsletter-vip",
];
const COUNTRIES = ["FR", "FR", "DE", "NL", "BE", "GB"];
const WIDGET_VERSIONS = ["TREATMENT_CHOICE:v1", "QUANTITY_CADENCE:v1"];

const FIRST_NAMES = [
  "Ava", "Lena", "Chloe", "Ines", "Margaux", "Sofia", "Emma", "Julia",
  "Camille", "Noor", "Elise", "Sarah", "Lucie", "Anna", "Maya", "Zoe",
  "Clara", "Louise", "Alice", "Jeanne",
];
const LAST_NAMES = [
  "Martin", "Dubois", "Keller", "Vandermeer", "Rossi", "Peeters", "Laurent",
  "Novak",
];

// Decline pool for random healthy-cycle failures (code → DeclineCategory).
const DECLINES = [
  ["insufficient_funds", "INSUFFICIENT_FUNDS"],
  ["card_declined", "GENERIC_DECLINE"],
  ["expired_card", "EXPIRED_CARD"],
  ["processing_error", "PROCESSOR_ERROR"],
  ["authentication_required", "AUTHENTICATION_REQUIRED"],
];

// Dunning-episode blueprints per decline category (payment-failure cancels).
const EPISODES = {
  EXPIRED_CARD: {
    code: "expired_card",
    notice: "dunning-card-expired",
    followUp: "dunning-card-expired-final",
    retryOffsets: [4],
    followUpDay: 6,
    exhaustDay: 11,
  },
  INSUFFICIENT_FUNDS: {
    code: "insufficient_funds",
    notice: "dunning-funds-notice",
    followUp: "dunning-funds-update-1",
    retryOffsets: [3, 5],
    followUpDay: 5,
    exhaustDay: 11,
  },
  GENERIC_DECLINE: {
    code: "do_not_honor",
    notice: "dunning-generic-notice",
    followUp: "dunning-generic-update",
    retryOffsets: [2, 4],
    followUpDay: 4,
    exhaustDay: 11,
  },
  PERMANENT_FAILURE: {
    code: "invalid_account",
    notice: "dunning-method-invalid",
    followUp: "dunning-method-grace",
    retryOffsets: [],
    followUpDay: 7,
    exhaustDay: 44,
    pauseDay: 14,
  },
};
const PAY_FAIL_CATEGORIES = [
  "EXPIRED_CARD",
  "INSUFFICIENT_FUNDS",
  "GENERIC_DECLINE",
  "PERMANENT_FAILURE",
];

const VOL_REASONS = [
  "TOO_MUCH_PRODUCT",
  "TOO_EXPENSIVE",
  "NOT_SEEING_IMPROVEMENT",
  "IRRITATION",
  "TRAVELLING",
  "CIRCUMSTANCES_CHANGED",
  "ONLY_WANTED_TO_TRY",
  "OTHER",
];

function offersFor(reason) {
  switch (reason) {
    case "TOO_MUCH_PRODUCT":
      return [
        { type: "CHANGE_FREQUENCY", params: { intervalWeeks: 8 }, costCents: 0 },
        { type: "TEMPORARY_PAUSE", params: { days: 60 }, costCents: 0 },
      ];
    case "TOO_EXPENSIVE":
      return [
        { type: "CHANGE_QUANTITY", params: { quantity: 1 }, costCents: 0 },
        { type: "ACCOUNT_CREDIT", params: { amountCents: 1000 }, costCents: 1000 },
        {
          type: "TEMPORARY_DISCOUNT",
          params: { percentOff: 15, cycles: 2 },
          costCents: 1800,
        },
      ];
    case "IRRITATION":
      return [
        {
          type: "PRODUCT_SWAP",
          params: { toHandle: "barrier-repair-cream" },
          costCents: 0,
        },
        { type: "EDUCATION", params: { article: "patch-testing" }, costCents: 0 },
      ];
    case "TRAVELLING":
      return [
        { type: "TEMPORARY_PAUSE", params: { days: 60 }, costCents: 0 },
        {
          type: "CHANGE_DELIVERY_DATE",
          params: { delayWeeks: 4 },
          costCents: 0,
        },
      ];
    default:
      return [
        {
          type: "EDUCATION",
          params: { article: "continuous-treatment-results" },
          costCents: 0,
        },
        { type: "TEMPORARY_PAUSE", params: { days: 30 }, costCents: 0 },
        {
          type: "TEMPORARY_DISCOUNT",
          params: { percentOff: 10, cycles: 1 },
          costCents: 900,
        },
      ];
  }
}

// Deterministic id counters for Shopify-shaped gids on seeded rows.
let orderSeq = 7000;
let attemptSeq = 8000;

// ─────────────────────────── Fleet spec builder ───────────────────────────
// Everything is generated purely (fixed rand-call order) before any DB write.

function buildSpec(i) {
  const gidNum = 5100 + i;
  const role =
    i < 24 ? "ACTIVE" : i < 28 ? "PAUSED" : i < 36 ? "CANCELLED_VOL" : "CANCELLED_PAY";
  // i 0,1 → active contracts mid-dunning (RETRYING); 36-39 → EXHAUSTED.
  const dunningKind =
    i <= 1 ? "RETRYING" : role === "CANCELLED_PAY" ? "EXHAUSTED" : null;

  const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
  const lastName = LAST_NAMES[i % LAST_NAMES.length];
  const email = `${firstName}.${lastName}${i}@example.com`.toLowerCase();

  let intervalWeeks;
  if (i === 0) intervalWeeks = 4;
  else if (i === 1) intervalWeeks = 6;
  else intervalWeeks = pick([4, 4, 6, 8, 8, 12]);
  const intervalMs = intervalWeeks * 7 * day;

  // Start dates spread over the past 12 months; RETRYING contracts are
  // grid-aligned so their most recent billing cycle failed a few days ago.
  let createdAtMs;
  let cancelledAtMs = null;
  let retryOffsetDays = 0;
  if (i === 0) {
    retryOffsetDays = 3;
    createdAtMs = now - (intervalWeeks * 7 * randInt(3, 7) + retryOffsetDays) * day;
  } else if (i === 1) {
    retryOffsetDays = 4;
    createdAtMs = now - (intervalWeeks * 7 * randInt(2, 5) + retryOffsetDays) * day;
  } else if (role === "ACTIVE") {
    const ageDays =
      i === 12 || i === 13
        ? randInt(120, 300) // old enough for a past pause + resume
        : i >= 20
          ? randInt(10, 60) // a few genuinely fresh subscribers
          : randInt(21, 360);
    createdAtMs = now - ageDays * day;
  } else if (role === "PAUSED") {
    createdAtMs = now - randInt(60, 330) * day;
  } else if (role === "CANCELLED_VOL") {
    if (i >= 33) {
      // Three recent voluntary churns so the default 90-day range shows churn.
      cancelledAtMs = now - randInt(5, 55) * day;
      createdAtMs = cancelledAtMs - randInt(90, 250) * day;
    } else {
      createdAtMs = now - randInt(150, 360) * day;
      const maxLife = Math.floor((now - createdAtMs) / day) - 30;
      cancelledAtMs = createdAtMs + randInt(60, Math.max(61, maxLife)) * day;
    }
  } else {
    createdAtMs = now - randInt(150, 360) * day;
  }

  // 1-3 lines drawn from the three seeded products, quantities 1-3.
  const lineCount = pick([1, 1, 2, 2, 3]);
  const startIdx = randInt(0, 2);
  const lines = [];
  for (let j = 0; j < lineCount; j++) {
    const p = CATALOG[(startIdx + j) % CATALOG.length];
    lines.push({ ...p, quantity: pick([1, 1, 1, 2, 2, 3]) });
  }
  const baseCents = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
  const initialDiscountPercent = pick([0, 0, 10, 15, 20, 25]);
  const firstOrderAovCents = Math.round(
    (baseCents * (100 - initialDiscountPercent)) / 100,
  );

  // Flat acquisition shape — exactly the keys cohortKeyFor picks up.
  const acquisition = {
    channel: pick(CHANNELS),
    landingPage: pick(LANDING_PAGES),
    campaign: pick(CAMPAIGNS),
    device: pick(["mobile", "mobile", "mobile", "desktop", "desktop", "tablet"]),
  };
  const widgetVersion = pick(WIDGET_VERSIONS);
  const country = pick(COUNTRIES);

  let pauseStartMs = null;
  let pausedUntilMs = null;
  if (role === "PAUSED") {
    pauseStartMs = Math.max(createdAtMs + 14 * day, now - randInt(3, 25) * day);
    pausedUntilMs = now + randInt(15, 45) * day;
  }

  // ── Billing history ────────────────────────────────────────────────────
  const attempts = [];
  let successes = 0;
  let failures = 0;
  let revenue = 0;
  let sixthSuccessAtMs = null;
  const cycleAmount = (k) => (k === 0 ? firstOrderAovCents : baseCents);
  const pushSuccess = (k, atMs, isRetry, attemptNumber) => {
    successes++;
    revenue += cycleAmount(k);
    if (successes === 6) sixthSuccessAtMs = atMs;
    attempts.push({
      cycle: k,
      atMs,
      status: "SUCCESS",
      amountCents: cycleAmount(k),
      isRetry,
      attemptNumber,
      orderId: gid("Order", orderSeq++),
      gidNum: attemptSeq++,
    });
  };
  const pushFailure = (k, atMs, errorCode, declineCategory, isRetry, attemptNumber) => {
    failures++;
    attempts.push({
      cycle: k,
      atMs,
      status: "FAILURE",
      amountCents: cycleAmount(k),
      errorCode,
      declineCategory,
      isRetry,
      attemptNumber,
      gidNum: attemptSeq++,
    });
  };
  // First order always paid (checkout); later cycles fail ~9% of the time and
  // ~65% of those recover via an isRetry success 3 days later.
  const healthyCycle = (k, tMs, failChance) => {
    if (k > 0 && chance(failChance)) {
      const [code, cat] = pick(DECLINES);
      pushFailure(k, tMs, code, cat, false, 1);
      if (tMs + 3 * day <= now && chance(0.65)) {
        pushSuccess(k, tMs + 3 * day, true, 2);
      }
    } else {
      pushSuccess(k, tMs, false, 1);
    }
  };

  let dunning = null;

  if (dunningKind === "RETRYING") {
    // Healthy cycles, then the latest cycle failed `retryOffsetDays` ago.
    const failCycle = Math.round(
      (now - retryOffsetDays * day - createdAtMs) / intervalMs,
    );
    for (let k = 0; k < failCycle; k++) {
      healthyCycle(k, createdAtMs + k * intervalMs, 0.06);
    }
    const tFail = createdAtMs + failCycle * intervalMs;
    const category = i === 0 ? "INSUFFICIENT_FUNDS" : "GENERIC_DECLINE";
    const plan = EPISODES[category];
    pushFailure(failCycle, tFail, plan.code, category, false, 1);
    const history = [
      {
        at: iso(tFail),
        type: "EPISODE_START",
        errorCode: plan.code,
        declineCategory: category,
      },
      {
        at: iso(tFail + 2 * hour),
        type: "STEP",
        stepIndex: 0,
        action: "EMAIL",
        template: plan.notice,
      },
    ];
    let retryCount = 0;
    let lastFailureAtMs = tFail;
    if (i === 1) {
      // One scheduled retry already failed two days after the decline.
      const tRetry = tFail + 2 * day;
      pushFailure(failCycle, tRetry, plan.code, category, true, 2);
      history.push(
        {
          at: iso(tRetry),
          type: "STEP",
          stepIndex: 1,
          action: "RETRY",
        },
        {
          at: iso(tRetry + hour),
          type: "RETRY_FAILED",
          errorCode: plan.code,
          declineCategory: category,
        },
      );
      retryCount = 1;
      lastFailureAtMs = tRetry;
    }
    dunning = {
      phase: "RETRYING",
      declineCategory: category,
      retryCount,
      nextRetryAtMs: now + (i === 0 ? 12 * hour : 1 * day),
      lastFailureAtMs,
      history,
    };
  } else if (dunningKind === "EXHAUSTED") {
    const category = PAY_FAIL_CATEGORIES[i - 36];
    const plan = EPISODES[category];
    // The first two exhaust recently (visible in the default 90-day range).
    const targetMs =
      i <= 37 ? now - randInt(60, 75) * day : now - randInt(76, 140) * day;
    const failCycle = Math.max(
      1,
      Math.floor((Math.max(targetMs, createdAtMs + intervalMs) - createdAtMs) / intervalMs),
    );
    for (let k = 0; k < failCycle; k++) {
      healthyCycle(k, createdAtMs + k * intervalMs, 0.05);
    }
    const tFail = createdAtMs + failCycle * intervalMs;
    pushFailure(failCycle, tFail, plan.code, category, false, 1);
    const history = [
      {
        at: iso(tFail),
        type: "EPISODE_START",
        errorCode: plan.code,
        declineCategory: category,
      },
      {
        at: iso(tFail + 2 * hour),
        type: "STEP",
        stepIndex: 0,
        action: "EMAIL",
        template: plan.notice,
      },
    ];
    let stepIndex = 1;
    let attemptNumber = 2;
    let lastFailureAtMs = tFail;
    for (const off of plan.retryOffsets) {
      const tRetry = tFail + off * day;
      pushFailure(failCycle, tRetry, plan.code, category, true, attemptNumber++);
      history.push(
        { at: iso(tRetry), type: "STEP", stepIndex: stepIndex++, action: "RETRY" },
        {
          at: iso(tRetry + hour),
          type: "RETRY_FAILED",
          errorCode: plan.code,
          declineCategory: category,
        },
      );
      lastFailureAtMs = tRetry;
    }
    history.push({
      at: iso(tFail + plan.followUpDay * day + 3 * hour),
      type: "STEP",
      stepIndex: stepIndex++,
      action: "EMAIL",
      template: plan.followUp,
    });
    if (plan.pauseDay != null) {
      history.push({
        at: iso(tFail + plan.pauseDay * day),
        type: "STEP",
        stepIndex: stepIndex++,
        action: "PAUSE",
      });
    }
    cancelledAtMs = tFail + plan.exhaustDay * day;
    history.push({ at: iso(cancelledAtMs), type: "EXHAUSTED" });
    history.sort((a, b) => a.at.localeCompare(b.at));
    dunning = {
      phase: "EXHAUSTED",
      declineCategory: category,
      retryCount: plan.retryOffsets.length,
      nextRetryAtMs: null,
      lastFailureAtMs,
      history,
    };
  } else {
    const endMs =
      role === "PAUSED"
        ? pauseStartMs
        : role === "CANCELLED_VOL"
          ? cancelledAtMs - 5 * day
          : now;
    for (let k = 0; createdAtMs + k * intervalMs <= endMs; k++) {
      healthyCycle(k, createdAtMs + k * intervalMs, 0.09);
    }
  }
  attempts.sort((a, b) => a.atMs - b.atMs);

  // ── Scores ─────────────────────────────────────────────────────────────
  let churn;
  if (i >= 5 && i <= 7) churn = 0.72 + rand() * 0.16; // high-churn-risk band
  else if (i >= 14 && i <= 18) churn = 0.42 + rand() * 0.25; // medium band
  else if (role === "ACTIVE" || role === "PAUSED") churn = 0.06 + rand() * 0.3;
  else churn = 0.55 + rand() * 0.35;
  churn = round2(churn);
  const quality = i === 6 ? 32 : randInt(38, 94);
  const expectedLtvCents = revenue + baseCents * randInt(3, 9);

  // ── Milestones (only what was actually reached before any cancellation) ─
  const lifespanEndMs = cancelledAtMs ?? now;
  const lifespanDays = (lifespanEndMs - createdAtMs) / day;
  const milestones = [{ type: "TREATMENT_STARTED", atMs: createdAtMs }];
  if (lifespanDays >= 30) {
    milestones.push({ type: "FIRST_MONTH", atMs: createdAtMs + 30 * day });
  }
  if (lifespanDays >= 90) {
    milestones.push({ type: "NINETY_DAYS", atMs: createdAtMs + 90 * day });
  }
  if (sixthSuccessAtMs != null) {
    milestones.push({ type: "SIX_DELIVERIES", atMs: sixthSuccessAtMs });
  }

  // ── Add-on items on a few active contracts ─────────────────────────────
  const addOns = [];
  if (i >= 8 && i <= 11) {
    const p = CATALOG[(startIdx + lineCount) % CATALOG.length];
    const shape = [
      { mode: "NEXT_ONLY", source: "portal", remainingDeliveries: null },
      { mode: "N_DELIVERIES", source: "pre-shipment-email", remainingDeliveries: 2 },
      { mode: "NEXT_ONLY", source: "cs-console", remainingDeliveries: null },
      { mode: "RECURRING", source: "portal", remainingDeliveries: null },
    ][i - 8];
    addOns.push({ ...p, quantity: 1, ...shape, createdAtMs: now - randInt(2, 12) * day });
  }

  // ── Cancellation sessions ──────────────────────────────────────────────
  let session = null;
  if (role === "CANCELLED_VOL") {
    const reason = VOL_REASONS[i - 28];
    session = {
      reason,
      reasonDetail:
        reason === "OTHER" ? "Moving abroad next month" : null,
      offersJson: JSON.stringify(offersFor(reason)),
      outcome: "CANCELLED",
      savedByOffer: null,
      saveCostCents: null,
      maxSaveCostCents: randInt(15, 40) * 100,
      startedAtMs: cancelledAtMs - 20 * 60 * 1000,
      resolvedAtMs: cancelledAtMs,
    };
  } else if (i >= 2 && i <= 4) {
    // Three SAVED sessions on contracts that are still active.
    const savedPlan = [
      { reason: "TOO_MUCH_PRODUCT", offer: "CHANGE_FREQUENCY", cost: 0 },
      { reason: "TOO_EXPENSIVE", offer: "ACCOUNT_CREDIT", cost: 1000 },
      { reason: "TRAVELLING", offer: "TEMPORARY_PAUSE", cost: 0 },
    ][i - 2];
    const resolvedAtMs = Math.max(
      createdAtMs + 10 * day,
      now - randInt(5, 45) * day,
    );
    session = {
      reason: savedPlan.reason,
      reasonDetail: null,
      offersJson: JSON.stringify(offersFor(savedPlan.reason)),
      outcome: "SAVED",
      savedByOffer: savedPlan.offer,
      saveCostCents: savedPlan.cost,
      maxSaveCostCents: randInt(20, 45) * 100,
      startedAtMs: resolvedAtMs - 12 * 60 * 1000,
      resolvedAtMs,
    };
  }

  // ── Lifecycle events (AnalyticsEvent warehouse rows) ───────────────────
  const events = [
    {
      name: "SUBSCRIPTION_STARTED",
      atMs: createdAtMs,
      payload: {
        intervalWeeks,
        widgetVersion,
        channel: acquisition.channel,
        firstOrderAovCents,
      },
    },
  ];
  for (const a of attempts) {
    if (a.status === "SUCCESS") {
      events.push({
        name: "CHARGE_COMPLETED",
        atMs: a.atMs,
        payload: {
          amountCents: a.amountCents,
          orderId: a.orderId,
          cycle: a.cycle,
          isRetry: a.isRetry,
        },
      });
    } else {
      events.push({
        name: "CHARGE_FAILED",
        atMs: a.atMs,
        payload: {
          errorCode: a.errorCode,
          declineCategory: a.declineCategory,
          cycle: a.cycle,
          isRetry: a.isRetry,
        },
      });
    }
  }
  if (role === "PAUSED") {
    events.push({
      name: "PAUSE_STARTED",
      atMs: pauseStartMs,
      payload: { resumeDate: iso(pausedUntilMs), source: "portal" },
    });
  }
  if (i === 12 || i === 13) {
    // A completed pause + resume in the past (feeds reactivation rate).
    const t1 = Math.max(createdAtMs + 20 * day, now - randInt(60, 80) * day);
    const t2 = Math.min(t1 + 30 * day, now - day);
    events.push(
      {
        name: "PAUSE_STARTED",
        atMs: t1,
        payload: { resumeDate: iso(t2), source: "portal" },
      },
      { name: "PAUSE_ENDING", atMs: t2, payload: { resumed: true } },
    );
  }
  if (session) {
    events.push({
      name: "CANCELLATION_STARTED",
      atMs: session.startedAtMs,
      payload: { reason: session.reason },
    });
    events.push(
      session.outcome === "CANCELLED"
        ? {
            name: "CANCELLATION_COMPLETED",
            atMs: session.resolvedAtMs,
            payload: { reason: session.reason },
          }
        : {
            name: "CANCELLATION_SAVED",
            atMs: session.resolvedAtMs,
            payload: {
              reason: session.reason,
              savedByOffer: session.savedByOffer,
              saveCostCents: session.saveCostCents,
            },
          },
    );
  }
  for (const addOn of addOns) {
    events.push({
      name: "PRODUCT_ADDED",
      atMs: addOn.createdAtMs,
      payload: { title: addOn.title, mode: addOn.mode, source: addOn.source },
    });
  }
  if (i >= 5 && i <= 7) {
    events.push({
      name: "HIGH_CHURN_RISK",
      atMs: now - randInt(1, 6) * day,
      payload: {
        score: churn,
        factors: { cadenceStrain: 0.4, engagement: 0.3, paymentFailures: 0.2 },
      },
    });
  }

  // ── Score snapshots ────────────────────────────────────────────────────
  const snapAtMs = cancelledAtMs ?? now - randInt(0, 6) * day;
  const snapshots = [
    {
      kind: "QUALITY",
      value: quality,
      factorsJson: JSON.stringify({
        adherence: round2(0.4 + rand() * 0.5),
        cadenceFit: round2(0.3 + rand() * 0.6),
        depletionAlignment: round2(0.2 + rand() * 0.7),
      }),
      atMs: snapAtMs,
    },
    {
      kind: "CHURN_RISK",
      value: churn,
      factorsJson: JSON.stringify({
        paymentFailures: round2(failures / Math.max(1, attempts.length)),
        cadenceStrain: round2(rand() * 0.5),
        engagement: round2(rand() * 0.6),
      }),
      atMs: snapAtMs,
    },
  ];
  if (i % 3 === 0) {
    snapshots.push({
      kind: "LTV",
      value: expectedLtvCents,
      factorsJson: "{}",
      atMs: snapAtMs,
    });
  }

  // Next billing dates: future cycle for active, resume date for paused.
  let nextBillingMs = null;
  let nextDeliveryMs = null;
  if (role === "ACTIVE") {
    const K = Math.floor((now - createdAtMs) / intervalMs) + 1;
    nextBillingMs = createdAtMs + K * intervalMs;
    nextDeliveryMs = nextBillingMs + 3 * day;
  } else if (role === "PAUSED") {
    nextBillingMs = pausedUntilMs;
    nextDeliveryMs = pausedUntilMs + 3 * day;
  }

  return {
    shopifyContractId: gid("SubscriptionContract", gidNum),
    shopifyCustomerId: gid("Customer", 9100 + i),
    email,
    status:
      role === "ACTIVE" ? "ACTIVE" : role === "PAUSED" ? "PAUSED" : "CANCELLED",
    role,
    intervalWeeks,
    createdAtMs,
    cancelledAtMs,
    cancelReason:
      role === "CANCELLED_VOL"
        ? VOL_REASONS[i - 28]
        : role === "CANCELLED_PAY"
          ? "PAYMENT_FAILURE"
          : null,
    pausedUntilMs,
    nextBillingMs,
    nextDeliveryMs,
    address: { countryCode: country, city: "Demo City" },
    cardBrand: pick(["visa", "visa", "mastercard", "amex"]),
    cardLastDigits: String(randInt(1000, 9999)),
    cardExpiryMonth: randInt(1, 12),
    cardExpiryYear: pick([2026, 2027, 2028]),
    lines,
    baseCents,
    initialDiscountPercent,
    firstOrderAovCents,
    acquisitionJson: JSON.stringify(acquisition),
    widgetVersion,
    attempts,
    successfulOrders: successes,
    failedAttempts: failures,
    totalRevenueCents: revenue,
    qualityScore: quality,
    churnRiskScore: churn,
    expectedLtvCents,
    milestones,
    addOns,
    session,
    events,
    snapshots,
    dunning,
  };
}

function buildFleetSpecs() {
  const specs = [];
  for (let i = 0; i < FLEET_SIZE; i++) specs.push(buildSpec(i));
  return specs;
}

// ─────────────────────────── Widget telemetry ─────────────────────────────
// ~300 WIDGET_* rows in EXACTLY the shape proxy.api.events.tsx persists:
// name = "WIDGET_" + EVENT, payloadJson = { event, widgetType, productId,
// variantKey, sellingPlanId, qty, experimentKey } (extractWidgetTelemetry).

function telemetryRow(event, widgetType, { plan = null, qty = 1, experiment = null, variantKey = null, productId = null } = {}) {
  const experimentKey =
    experiment && variantKey ? `${experiment}:${variantKey}` : null;
  return {
    name: `WIDGET_${event}`,
    atMs: now - randInt(1, 85) * day - randInt(0, 1439) * 60 * 1000,
    payload: {
      event,
      widgetType,
      productId: productId ?? pick(["101", "102", "103"]),
      variantKey,
      sellingPlanId: plan,
      qty,
      experimentKey,
    },
  };
}

function buildTelemetrySpecs() {
  const rows = [];
  const variant = () => pick(["v1", "v1", "v2"]);

  // Widget A — TREATMENT_CHOICE (impression → select → add_to_cart).
  for (let j = 0; j < 100; j++) {
    rows.push(
      telemetryRow("IMPRESSION", "TREATMENT_CHOICE", {
        experiment: "treatment-choice",
        variantKey: variant(),
      }),
    );
  }
  for (let j = 0; j < 30; j++) {
    rows.push(
      telemetryRow("SELECT_TREATMENT", "TREATMENT_CHOICE", {
        plan: pick(["301", "302"]),
        qty: pick([1, 1, 2]),
        experiment: "treatment-choice",
        variantKey: variant(),
      }),
    );
  }
  for (let j = 0; j < 10; j++) {
    rows.push(
      telemetryRow("SELECT_BASIC", "TREATMENT_CHOICE", {
        experiment: "treatment-choice",
        variantKey: variant(),
      }),
    );
  }
  for (let j = 0; j < 30; j++) {
    rows.push(
      telemetryRow("ADD_TO_CART", "TREATMENT_CHOICE", {
        plan: j < 22 ? pick(["301", "302"]) : null, // 22 subscription attaches
        qty: pick([1, 1, 2]),
        experiment: "treatment-choice",
        variantKey: variant(),
      }),
    );
  }

  // Widget B — QUANTITY_CADENCE.
  for (let j = 0; j < 70; j++) {
    rows.push(
      telemetryRow("IMPRESSION", "QUANTITY_CADENCE", {
        experiment: "quantity-cadence",
        variantKey: variant(),
      }),
    );
  }
  for (let j = 0; j < 20; j++) {
    rows.push(
      telemetryRow("SELECT_QUANTITY", "QUANTITY_CADENCE", {
        plan: chance(0.6) ? "302" : null,
        qty: pick([1, 2, 2, 3]),
        experiment: "quantity-cadence",
        variantKey: variant(),
      }),
    );
  }
  for (let j = 0; j < 16; j++) {
    rows.push(
      telemetryRow("ADD_TO_CART", "QUANTITY_CADENCE", {
        plan: j < 10 ? "302" : null,
        qty: pick([1, 2, 3]),
        experiment: "quantity-cadence",
        variantKey: variant(),
      }),
    );
  }

  // Widget E — POST_ONE_TIME nudge (feeds one-time → subscription rate).
  for (let j = 0; j < 14; j++) {
    rows.push(telemetryRow("NUDGE_SHOWN", "POST_ONE_TIME"));
  }
  for (let j = 0; j < 5; j++) {
    rows.push(telemetryRow("NUDGE_CONVERTED", "POST_ONE_TIME", { plan: "301" }));
  }

  // Widget F — CART_CONVERSION.
  for (let j = 0; j < 16; j++) {
    rows.push(telemetryRow("IMPRESSION", "CART_CONVERSION"));
  }
  for (let j = 0; j < 5; j++) {
    rows.push(
      telemetryRow("CART_CONVERT", "CART_CONVERSION", { plan: "301", qty: 1 }),
    );
  }

  return rows;
}

// ─────────────────────────── Fleet insertion ──────────────────────────────

async function insertFleetContract(spec) {
  const existing = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: spec.shopifyContractId },
    select: { id: true },
  });
  if (existing) return false;

  const contract = await prisma.subscriptionContract.create({
    data: {
      shop: SHOP,
      shopifyContractId: spec.shopifyContractId,
      shopifyCustomerId: spec.shopifyCustomerId,
      customerEmail: spec.email,
      status: spec.status,
      currencyCode: "EUR",
      intervalWeeks: spec.intervalWeeks,
      nextBillingDate: d(spec.nextBillingMs),
      nextDeliveryDate: d(spec.nextDeliveryMs),
      deliveryAddressJson: JSON.stringify(spec.address),
      cardBrand: spec.cardBrand,
      cardLastDigits: spec.cardLastDigits,
      cardExpiryMonth: spec.cardExpiryMonth,
      cardExpiryYear: spec.cardExpiryYear,
      successfulOrders: spec.successfulOrders,
      failedAttempts: spec.failedAttempts,
      totalRevenueCents: spec.totalRevenueCents,
      treatmentStartedAt: d(spec.createdAtMs),
      pausedUntil: d(spec.pausedUntilMs),
      cancelledAt: d(spec.cancelledAtMs),
      cancelReason: spec.cancelReason,
      qualityScore: spec.qualityScore,
      churnRiskScore: spec.churnRiskScore,
      expectedLtvCents: spec.expectedLtvCents,
      acquisitionJson: spec.acquisitionJson,
      firstOrderAovCents: spec.firstOrderAovCents,
      initialDiscountPercent: spec.initialDiscountPercent,
      widgetVersion: spec.widgetVersion,
      createdAt: d(spec.createdAtMs),
      lines: {
        create: spec.lines.map((l) => ({
          shopifyProductId: l.productId,
          shopifyVariantId: l.variantId,
          title: l.title,
          quantity: l.quantity,
          currentPriceCents: l.priceCents,
          sellingPlanName: `Continuous Treatment — every ${spec.intervalWeeks} weeks`,
          createdAt: d(spec.createdAtMs),
        })),
      },
      milestones: {
        create: spec.milestones.map((m) => ({
          type: m.type,
          achievedAt: d(m.atMs),
          rewardStatus: "GRANTED",
        })),
      },
      addOns: {
        create: spec.addOns.map((a) => ({
          shopifyProductId: a.productId,
          shopifyVariantId: a.variantId,
          title: a.title,
          quantity: a.quantity,
          priceCents: a.priceCents,
          mode: a.mode,
          remainingDeliveries: a.remainingDeliveries,
          source: a.source,
          createdAt: d(a.createdAtMs),
        })),
      },
      ...(spec.dunning
        ? {
            dunningState: {
              create: {
                phase: spec.dunning.phase,
                declineCategory: spec.dunning.declineCategory,
                retryCount: spec.dunning.retryCount,
                nextRetryAt: d(spec.dunning.nextRetryAtMs),
                lastFailureAt: d(spec.dunning.lastFailureAtMs),
                historyJson: JSON.stringify(spec.dunning.history),
              },
            },
          }
        : {}),
    },
  });

  if (spec.attempts.length > 0) {
    await prisma.billingAttempt.createMany({
      data: spec.attempts.map((a) => ({
        shop: SHOP,
        contractId: contract.id,
        shopifyBillingAttemptId: gid("SubscriptionBillingAttempt", a.gidNum),
        idempotencyKey: `bill:${contract.id}:${a.cycle}${
          a.attemptNumber > 1 ? `:${a.attemptNumber - 1}` : ""
        }`,
        status: a.status,
        errorCode: a.errorCode ?? null,
        declineCategory: a.declineCategory ?? null,
        orderId: a.orderId ?? null,
        amountCents: a.amountCents,
        attemptNumber: a.attemptNumber,
        isRetry: a.isRetry,
        occurredAt: d(a.atMs),
      })),
    });
  }

  if (spec.events.length > 0) {
    await prisma.analyticsEvent.createMany({
      data: spec.events.map((e) => ({
        shop: SHOP,
        name: e.name,
        contractId: contract.id,
        shopifyCustomerId: spec.shopifyCustomerId,
        payloadJson: JSON.stringify(e.payload),
        occurredAt: d(e.atMs),
      })),
    });
  }

  if (spec.snapshots.length > 0) {
    await prisma.scoreSnapshot.createMany({
      data: spec.snapshots.map((s) => ({
        shop: SHOP,
        contractId: contract.id,
        kind: s.kind,
        value: s.value,
        factorsJson: s.factorsJson,
        computedAt: d(s.atMs),
      })),
    });
  }

  if (spec.session) {
    await prisma.cancellationSession.create({
      data: {
        shop: SHOP,
        contractId: contract.id,
        reason: spec.session.reason,
        reasonDetail: spec.session.reasonDetail,
        offersJson: spec.session.offersJson,
        outcome: spec.session.outcome,
        savedByOffer: spec.session.savedByOffer,
        saveCostCents: spec.session.saveCostCents,
        maxSaveCostCents: spec.session.maxSaveCostCents,
        startedAt: d(spec.session.startedAtMs),
        resolvedAt: d(spec.session.resolvedAtMs),
      },
    });
  }

  return true;
}

async function seedFleet() {
  const marker = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: MARKER_CONTRACT_GID },
    select: { id: true },
  });
  if (marker) {
    console.log("Fleet marker (contract 5100) found — skipping fleet creation.");
    return;
  }

  const specs = buildFleetSpecs();
  const telemetry = buildTelemetrySpecs();

  // The marker contract (index 0, gid 5100) is inserted LAST so a partially
  // completed run resumes cleanly: every insert is guarded by its own
  // existence check, and the marker only appears once everything else landed.
  const [markerSpec, ...rest] = specs;
  let created = 0;
  for (const spec of rest) {
    if (await insertFleetContract(spec)) created++;
  }

  const widgetRows = await prisma.analyticsEvent.count({
    where: { shop: SHOP, name: { startsWith: "WIDGET_" } },
  });
  if (widgetRows === 0) {
    await prisma.analyticsEvent.createMany({
      data: telemetry.map((t) => ({
        shop: SHOP,
        name: t.name,
        payloadJson: JSON.stringify(t.payload),
        occurredAt: d(t.atMs),
      })),
    });
  }

  if (await insertFleetContract(markerSpec)) created++;
  console.log(`Fleet seeded: ${created} contracts + ${telemetry.length} widget telemetry events.`);
}

// ─────────────────────────── Summary ──────────────────────────────────────

async function printSummary() {
  const [
    contractsByStatus,
    attemptsByStatus,
    sessionsByOutcome,
    dunningByPhase,
    widgetEventCount,
    lifecycleEventCount,
    snapshotCount,
    addOnCount,
    milestoneCount,
    lineCount,
  ] = await Promise.all([
    prisma.subscriptionContract.groupBy({
      by: ["status"],
      where: { shop: SHOP },
      _count: { _all: true },
    }),
    prisma.billingAttempt.groupBy({
      by: ["status"],
      where: { shop: SHOP },
      _count: { _all: true },
    }),
    prisma.cancellationSession.groupBy({
      by: ["outcome"],
      where: { shop: SHOP },
      _count: { _all: true },
    }),
    prisma.dunningState.groupBy({
      by: ["phase"],
      where: { contract: { shop: SHOP } },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.count({
      where: { shop: SHOP, name: { startsWith: "WIDGET_" } },
    }),
    prisma.analyticsEvent.count({
      where: { shop: SHOP, NOT: { name: { startsWith: "WIDGET_" } } },
    }),
    prisma.scoreSnapshot.count({ where: { shop: SHOP } }),
    prisma.addOnItem.count({ where: { contract: { shop: SHOP } } }),
    prisma.milestone.count({ where: { contract: { shop: SHOP } } }),
    prisma.contractLine.count({ where: { contract: { shop: SHOP } } }),
  ]);

  const rows = [];
  for (const g of contractsByStatus) {
    rows.push({ entity: "SubscriptionContract", detail: g.status, count: g._count._all });
  }
  rows.push({ entity: "ContractLine", detail: "all", count: lineCount });
  for (const g of attemptsByStatus) {
    rows.push({ entity: "BillingAttempt", detail: g.status, count: g._count._all });
  }
  for (const g of dunningByPhase) {
    rows.push({ entity: "DunningState", detail: g.phase, count: g._count._all });
  }
  for (const g of sessionsByOutcome) {
    rows.push({ entity: "CancellationSession", detail: g.outcome, count: g._count._all });
  }
  rows.push(
    { entity: "AnalyticsEvent", detail: "WIDGET_*", count: widgetEventCount },
    { entity: "AnalyticsEvent", detail: "lifecycle", count: lifecycleEventCount },
    { entity: "ScoreSnapshot", detail: "all", count: snapshotCount },
    { entity: "AddOnItem", detail: "all", count: addOnCount },
    { entity: "Milestone", detail: "all", count: milestoneCount },
  );
  console.table(rows);
}

// ─────────────────────────── Main ─────────────────────────────────────────

async function main() {
  await prisma.shopSettings.upsert({
    where: { shop: SHOP },
    update: {},
    create: {
      shop: SHOP,
      currencyCode: "EUR",
      settingsJson: JSON.stringify({
        giftThresholdCents: 6000,
        preDunningLeadDays: 10,
        highValueGraceDays: 7,
      }),
    },
  });

  const products = [
    {
      shopifyProductId: gid("Product", 101),
      title: "Cellexia Regenerating Serum",
      handle: "regenerating-serum",
      unitContents: 30,
      defaultDailyUsage: 0.9,
      grossMarginPercent: 0.78,
      unitCostCents: 1080,
      timeOfDay: "BOTH",
      concern: "firmness",
      heroRank: 1,
    },
    {
      shopifyProductId: gid("Product", 102),
      title: "Cellexia Barrier Repair Cream",
      handle: "barrier-repair-cream",
      unitContents: 50,
      defaultDailyUsage: 1.4,
      grossMarginPercent: 0.72,
      unitCostCents: 890,
      timeOfDay: "PM",
      concern: "hydration",
      heroRank: 2,
    },
    {
      shopifyProductId: gid("Product", 103),
      title: "Cellexia Clarifying Cleanser",
      handle: "clarifying-cleanser",
      unitContents: 150,
      defaultDailyUsage: 3.0,
      grossMarginPercent: 0.69,
      unitCostCents: 540,
      timeOfDay: "AM",
      concern: "clarity",
    },
  ];
  for (const p of products) {
    await prisma.productMeta.upsert({
      where: { shop_shopifyProductId: { shop: SHOP, shopifyProductId: p.shopifyProductId } },
      update: p,
      create: { shop: SHOP, ...p },
    });
  }

  const contract = await prisma.subscriptionContract.upsert({
    where: { shopifyContractId: gid("SubscriptionContract", 5001) },
    update: {},
    create: {
      shop: SHOP,
      shopifyContractId: gid("SubscriptionContract", 5001),
      shopifyCustomerId: CUSTOMER_ID,
      customerEmail: EMAIL,
      status: "ACTIVE",
      currencyCode: "EUR",
      intervalWeeks: 4,
      nextBillingDate: new Date(now + 9 * day),
      nextDeliveryDate: new Date(now + 12 * day),
      cardBrand: "visa",
      cardLastDigits: "4242",
      cardExpiryMonth: 11,
      cardExpiryYear: 2027,
      successfulOrders: 3,
      totalRevenueCents: 3 * 12800,
      treatmentStartedAt: new Date(now - 13 * 7 * day),
      qualityScore: 78,
      churnRiskScore: 0.18,
      expectedLtvCents: 61400,
      acquisitionJson: JSON.stringify({
        channel: "meta-ads",
        landingPage: "/pages/firmness-study",
        campaign: "spring-firmness",
        device: "mobile",
      }),
      firstOrderAovCents: 12800,
      widgetVersion: "TREATMENT_CHOICE:v1",
    },
  });

  const existingLines = await prisma.contractLine.count({ where: { contractId: contract.id } });
  if (existingLines === 0) {
    const serum = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyProductId: gid("Product", 101),
        shopifyVariantId: gid("ProductVariant", 201),
        title: "Cellexia Regenerating Serum",
        quantity: 1,
        currentPriceCents: 7900,
        sellingPlanName: "Continuous Treatment — every 4 weeks",
      },
    });
    const cream = await prisma.contractLine.create({
      data: {
        contractId: contract.id,
        shopifyProductId: gid("Product", 102),
        shopifyVariantId: gid("ProductVariant", 202),
        title: "Cellexia Barrier Repair Cream",
        quantity: 1,
        currentPriceCents: 4900,
        sellingPlanName: "Continuous Treatment — every 4 weeks",
      },
    });
    await prisma.depletionEstimate.create({
      data: {
        contractLineId: serum.id,
        estimatedDailyUsage: 0.9,
        lastDeliveryAt: new Date(now - 16 * day),
        unitsOnHand: 15.6,
        predictedRunOutAt: new Date(now + 17 * day),
        confidence: 0.7,
        signalsJson: JSON.stringify([
          { at: new Date(now - 16 * day).toISOString(), signal: "DELIVERY_RECEIVED" },
        ]),
      },
    });
    await prisma.depletionEstimate.create({
      data: {
        contractLineId: cream.id,
        estimatedDailyUsage: 1.4,
        lastDeliveryAt: new Date(now - 16 * day),
        unitsOnHand: 27.6,
        predictedRunOutAt: new Date(now + 20 * day),
        confidence: 0.65,
        signalsJson: "[]",
      },
    });
  }

  for (const type of ["TREATMENT_STARTED", "FIRST_MONTH", "NINETY_DAYS"]) {
    await prisma.milestone.upsert({
      where: { contractId_type: { contractId: contract.id, type } },
      update: {},
      create: { contractId: contract.id, type, rewardStatus: "GRANTED" },
    });
  }

  // Demo fleet — makes analytics, retention and dunning screens look alive.
  await seedFleet();

  // Mint a magic link so the portal can be opened immediately.
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.magicLinkToken.create({
    data: {
      shop: SHOP,
      shopifyCustomerId: CUSTOMER_ID,
      email: EMAIL,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(now + 30 * 60 * 1000),
    },
  });

  await printSummary();

  const base = process.env.PORTAL_BASE_URL || "http://localhost:3901";
  console.log("Demo data ready for", SHOP);
  console.log(`Portal magic link: ${base}/portal/magic/${token}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
