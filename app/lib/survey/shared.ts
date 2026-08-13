/**
 * Post-purchase survey — the frozen measurement instrument (v1.21.0).
 *
 * Isomorphic vocabulary: question keys, option keys and the instrument
 * version, shared by the server (api.survey route, survey service, risk
 * features, admin UI labels) and mirrored by the checkout UI extension
 * (extensions/cellexia-survey/src/questions.js — the extension bundles its
 * own copy because extension sources cannot import app code; keep the two in
 * sync, `tests/survey-instrument.test.ts` pins this file's shape and the
 * mirror's equality).
 *
 * THE INSTRUMENT IS FROZEN. Answers are only comparable within one
 * questionSetVersion: churn/LTGP coefficients are estimated per option key
 * over months of matured labels, so editing wording or options in place
 * silently pools answers from different instruments and corrupts both the
 * historical and the new coefficients undetectably. To change ANYTHING
 * customer-visible here, bump SURVEY_QUESTION_SET_VERSION and add new keys —
 * never rename, reorder, merge or "clean up" existing option keys. (Rule
 * documented in docs/DATA_FOUNDATION.md § Post-purchase survey.)
 *
 * Customer-facing WORDING deliberately does not live here: the extension owns
 * its own localized strings (extensions/cellexia-survey/locales/). This file
 * owns the option KEY space — the analytics identity of each answer.
 *
 * No server imports allowed (the ownership shared.ts rule): route components
 * and tests import this file client-side.
 */

export const SURVEY_QUESTION_SET_VERSION = 1;

export const SURVEY_SOURCES = ["THANK_YOU", "ORDER_STATUS"] as const;
export type SurveySource = (typeof SURVEY_SOURCES)[number];

/**
 * Question order is part of the instrument (primacy/order effects): the
 * extension renders in this order, one question per screen.
 *
 * Prediction rationale per question (see docs/OPERATIONS.md § Predicted LTGP):
 * - plannedDuration: stated horizon, monotone with realized tenure.
 * - motive: goals with no completion point (prevention, daily care) retain;
 *   fast-fix and occasion motives terminate.
 * - expectedSpeed: monotone risk — the faster the expectation, the earlier
 *   the disappointment (merchant decision: NO product-relative scoring; no
 *   product performs miracles in days, so "days" is the worst answer on
 *   every product).
 * - routine: existing consistent skincare habit = habit infrastructure and
 *   demonstrated category spend.
 */
export const SURVEY_QUESTIONS = [
  {
    key: "plannedDuration",
    options: ["trying", "few_months", "six_months_plus", "permanent"],
  },
  {
    key: "motive",
    options: ["fast_wrinkles", "prevention", "daily_care", "occasion"],
  },
  {
    key: "expectedSpeed",
    options: ["days", "weeks", "one_two_months", "three_months_plus", "not_sure"],
  },
  {
    key: "routine",
    options: ["full", "most_days", "on_off", "minimal"],
  },
] as const;

export type SurveyQuestionKey = (typeof SURVEY_QUESTIONS)[number]["key"];

export const SURVEY_QUESTION_KEYS: readonly SurveyQuestionKey[] =
  SURVEY_QUESTIONS.map((q) => q.key);

/** Partial by design — answers merge in progressively, one tap at a time. */
export type SurveyAnswers = Partial<Record<SurveyQuestionKey, string>>;

export function isValidSurveyAnswer(
  question: string,
  option: string,
): question is SurveyQuestionKey {
  const def = SURVEY_QUESTIONS.find((q) => q.key === question);
  return def !== undefined && (def.options as readonly string[]).includes(option);
}

/** True when every question has a valid answer key. */
export function isCompleteSurvey(answers: SurveyAnswers): boolean {
  return SURVEY_QUESTIONS.every((q) => {
    const value = answers[q.key];
    return (
      typeof value === "string" &&
      (q.options as readonly string[]).includes(value)
    );
  });
}

/**
 * Normalize an untrusted answers object to the known key/option space —
 * unknown questions and invalid options are dropped, never stored.
 */
export function sanitizeSurveyAnswers(value: unknown): SurveyAnswers {
  if (typeof value !== "object" || value === null) return {};
  const out: SurveyAnswers = {};
  for (const q of SURVEY_QUESTIONS) {
    const candidate = (value as Record<string, unknown>)[q.key];
    if (
      typeof candidate === "string" &&
      (q.options as readonly string[]).includes(candidate)
    ) {
      out[q.key] = candidate;
    }
  }
  return out;
}
