/**
 * The post-purchase survey measurement instrument (v1.21.0).
 *
 * Pins two things that must never drift apart or change silently:
 *
 * 1. The frozen instrument itself (app/lib/survey/shared.ts): version,
 *    question keys, option keys AND their order. Churn/LTGP coefficients are
 *    estimated per option key over months of matured labels — an in-place
 *    edit pools answers from different instruments and corrupts both sides
 *    undetectably. Changing ANY of these must bump
 *    SURVEY_QUESTION_SET_VERSION, which this suite forces a human to notice.
 *
 * 2. The extension's bundled mirror (extensions/cellexia-survey/src/
 *    questions.json) — extension sources cannot import app code, so the
 *    vocabulary is duplicated by construction; this suite is what makes the
 *    duplication safe.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SURVEY_QUESTIONS,
  SURVEY_QUESTION_KEYS,
  SURVEY_QUESTION_SET_VERSION,
  isCompleteSurvey,
  isValidSurveyAnswer,
  sanitizeSurveyAnswers,
} from "~/lib/survey/shared";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIRROR_PATH = join(
  REPO_ROOT,
  "extensions",
  "cellexia-survey",
  "src",
  "questions.json",
);

describe("the frozen instrument (version 1)", () => {
  it("pins version, question keys, option keys and order — bump the version to change any of this", () => {
    expect(SURVEY_QUESTION_SET_VERSION).toBe(1);
    expect(
      SURVEY_QUESTIONS.map((q) => ({ key: q.key, options: [...q.options] })),
    ).toEqual([
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
        options: [
          "days",
          "weeks",
          "one_two_months",
          "three_months_plus",
          "not_sure",
        ],
      },
      {
        key: "routine",
        options: ["full", "most_days", "on_off", "minimal"],
      },
    ]);
  });

  it("the extension mirror is byte-equal in version, keys, options and order", () => {
    const mirror = JSON.parse(readFileSync(MIRROR_PATH, "utf8")) as {
      questionSetVersion: number;
      questions: Array<{ key: string; options: string[] }>;
    };
    expect(mirror.questionSetVersion).toBe(SURVEY_QUESTION_SET_VERSION);
    expect(mirror.questions).toEqual(
      SURVEY_QUESTIONS.map((q) => ({ key: q.key, options: [...q.options] })),
    );
  });
});

describe("answer validation + sanitization", () => {
  it("accepts every declared option and rejects unknowns", () => {
    for (const q of SURVEY_QUESTIONS) {
      for (const option of q.options) {
        expect(isValidSurveyAnswer(q.key, option)).toBe(true);
      }
      expect(isValidSurveyAnswer(q.key, "nope")).toBe(false);
    }
    expect(isValidSurveyAnswer("unknownQuestion", "trying")).toBe(false);
  });

  it("sanitize drops unknown questions, invalid options and non-string junk", () => {
    expect(
      sanitizeSurveyAnswers({
        plannedDuration: "trying",
        motive: "not_an_option",
        expectedSpeed: 42,
        routine: "full",
        injected: "value",
      }),
    ).toEqual({ plannedDuration: "trying", routine: "full" });
    expect(sanitizeSurveyAnswers(null)).toEqual({});
    expect(sanitizeSurveyAnswers("string")).toEqual({});
  });

  it("isCompleteSurvey requires a valid answer for every question", () => {
    const complete = {
      plannedDuration: "permanent",
      motive: "prevention",
      expectedSpeed: "three_months_plus",
      routine: "full",
    };
    expect(isCompleteSurvey(complete)).toBe(true);
    expect(isCompleteSurvey({ ...complete, motive: undefined })).toBe(false);
    expect(SURVEY_QUESTION_KEYS).toHaveLength(4);
  });
});
