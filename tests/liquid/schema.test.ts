import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BLOCKS_DIR } from "./harness";

/**
 * {% schema %} VALIDITY GUARDS — mirror of the Shopify CLI's deploy-time
 * validation for theme-app-extension block schemas.
 *
 * Why this exists: v1.7.x was blocked at deploy because
 * blocks/buy-box-embed.liquid carried `"default": ""` on a text setting —
 * the CLI now rejects empty-string defaults on text settings outright, and
 * nothing in the suite knew, because every other Liquid test renders the
 * templates (schema tags are stripped before rendering) and never reads the
 * JSON. These rules re-state the CLI's checks as tests, so an invalid schema
 * fails in CI instead of at `shopify app deploy`.
 *
 * The rules mirrored (each failure message names the consequence):
 *   - the schema parses as STRICT JSON (JSON.parse: no comments, no trailing
 *     commas — Shopify's parser accepts nothing looser);
 *   - no text/textarea setting has an empty-string or null default (absence
 *     of "default" IS the empty default);
 *   - every setting has type + id + label, EXCEPT the informational types
 *     (paragraph/header) which take a "content" string and must have NEITHER
 *     an id NOR a default (newer CLI versions reject ids on informational
 *     settings too);
 *   - setting ids are unique within a block;
 *   - select settings have non-empty options, and a default that is one of
 *     the option values; checkbox defaults are booleans;
 *   - target is one of the values this extension can ship ("section" for the
 *     app block, "body" for the app embed);
 *   - name / label lengths are sane (the theme editor truncates, the CLI
 *     rejects at its own caps).
 */

/** Setting types that are informational: no id, no label, no default. */
const INFORMATIONAL_TYPES = new Set(["paragraph", "header"]);

/** Block targets valid for this extension's files. */
const VALID_TARGETS = new Set(["section", "body"]);

/** Shopify caps the theme-editor block name at 25 characters. */
const MAX_NAME_LENGTH = 25;

/** Generous but real: a label longer than this is a paragraph, not a label. */
const MAX_LABEL_LENGTH = 70;

const REJECTED = "Shopify CLI will reject this at deploy";

interface BlockFile {
  name: string;
  source: string;
}

const blockFiles: BlockFile[] = readdirSync(BLOCKS_DIR)
  .filter((name) => name.endsWith(".liquid"))
  .sort()
  .map((name) => ({
    name,
    source: readFileSync(join(BLOCKS_DIR, name), "utf8"),
  }));

/** The raw text between {% schema %} and {% endschema %} — exactly one. */
function schemaText(block: BlockFile): string {
  const matches = [
    ...block.source.matchAll(
      /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/g,
    ),
  ];
  expect(
    matches.length,
    `${block.name}: a block must carry exactly one {% schema %} — ` +
      `${REJECTED}`,
  ).toBe(1);
  return matches[0][1];
}

function schemaJson(block: BlockFile): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText(block));
  } catch (error) {
    expect.fail(
      `${block.name}: {% schema %} is not strict JSON ` +
        `(${(error as Error).message}) — ${REJECTED}`,
    );
  }
  expect(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    `${block.name}: {% schema %} must be a JSON object — ${REJECTED}`,
  ).toBe(true);
  return parsed as Record<string, unknown>;
}

function settingsOf(block: BlockFile): Array<Record<string, unknown>> {
  const schema = schemaJson(block);
  const settings = schema.settings ?? [];
  expect(
    Array.isArray(settings),
    `${block.name}: "settings" must be an array — ${REJECTED}`,
  ).toBe(true);
  return (settings as unknown[]).map((setting, index) => {
    expect(
      typeof setting === "object" && setting !== null && !Array.isArray(setting),
      `${block.name}: settings[${index}] must be an object — ${REJECTED}`,
    ).toBe(true);
    return setting as Record<string, unknown>;
  });
}

function describeSetting(setting: Record<string, unknown>): string {
  return String(setting.id ?? setting.type ?? "<untyped>");
}

describe("block {% schema %} validity (mirror of Shopify CLI deploy checks)", () => {
  it("finds both block files (non-vacuity)", () => {
    /* The rules below iterate whatever blocks/ contains, so a third block is
       covered the day it lands — but the two we ship must actually be seen,
       or every rule passes over an empty list. */
    const names = blockFiles.map((block) => block.name);
    expect(names).toContain("buy-box.liquid");
    expect(names).toContain("buy-box-embed.liquid");
  });

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: schema parses as strict JSON",
    (_name, block) => {
      schemaJson(block);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: target is valid for a theme app extension block",
    (_name, block) => {
      const schema = schemaJson(block);
      expect(
        VALID_TARGETS.has(String(schema.target)),
        `${block.name}: target "${String(schema.target)}" is not one of ` +
          `${[...VALID_TARGETS].join("/")} — ${REJECTED}`,
      ).toBe(true);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: block name present and within the editor cap",
    (_name, block) => {
      const schema = schemaJson(block);
      const name = schema.name;
      expect(
        typeof name === "string" && name.trim().length > 0,
        `${block.name}: schema "name" must be a non-empty string — ${REJECTED}`,
      ).toBe(true);
      expect(
        (name as string).length,
        `${block.name}: schema "name" exceeds ${MAX_NAME_LENGTH} characters — ` +
          `${REJECTED}`,
      ).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: no text/textarea setting has an empty or null default",
    (_name, block) => {
      const offenders = settingsOf(block)
        .filter((setting) => setting.type === "text" || setting.type === "textarea")
        .filter(
          (setting) =>
            "default" in setting &&
            (setting.default === "" || setting.default === null),
        )
        .map(describeSetting);
      expect(
        offenders,
        `${block.name}: ${offenders.join(", ")} carries an empty/null ` +
          `"default" on a text setting — omit the key (absence IS empty); ` +
          `${REJECTED}`,
      ).toEqual([]);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: no setting of any type has a null default",
    (_name, block) => {
      const offenders = settingsOf(block)
        .filter((setting) => "default" in setting && setting.default === null)
        .map(describeSetting);
      expect(
        offenders,
        `${block.name}: ${offenders.join(", ")} has "default": null — ` +
          `omit the key instead; ${REJECTED}`,
      ).toEqual([]);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: every setting has type+id+label, except informational settings which have neither id nor default",
    (_name, block) => {
      for (const setting of settingsOf(block)) {
        const type = setting.type;
        expect(
          typeof type === "string" && type.length > 0,
          `${block.name}: a setting is missing "type" — ${REJECTED}`,
        ).toBe(true);

        if (INFORMATIONAL_TYPES.has(type as string)) {
          /* paragraph/header are display-only: they take "content" and take
             NO value — an id or a default on one fails CLI validation. */
          expect(
            "id" in setting,
            `${block.name}: informational setting ("${String(type)}") ` +
              `carries an "id" — ${REJECTED}`,
          ).toBe(false);
          expect(
            "default" in setting,
            `${block.name}: informational setting ("${String(type)}") ` +
              `carries a "default" — ${REJECTED}`,
          ).toBe(false);
          expect(
            typeof setting.content === "string" &&
              (setting.content as string).trim().length > 0,
            `${block.name}: informational setting ("${String(type)}") ` +
              `must carry non-empty "content" — ${REJECTED}`,
          ).toBe(true);
          continue;
        }

        expect(
          typeof setting.id === "string" && (setting.id as string).length > 0,
          `${block.name}: setting of type "${String(type)}" is missing ` +
            `"id" — ${REJECTED}`,
        ).toBe(true);
        expect(
          typeof setting.label === "string" &&
            (setting.label as string).trim().length > 0,
          `${block.name}: setting "${describeSetting(setting)}" is missing ` +
            `"label" — ${REJECTED}`,
        ).toBe(true);
        expect(
          (setting.label as string).length,
          `${block.name}: setting "${describeSetting(setting)}" label ` +
            `exceeds ${MAX_LABEL_LENGTH} characters — ${REJECTED}`,
        ).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
      }
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: setting ids are unique within the block",
    (_name, block) => {
      const ids = settingsOf(block)
        .map((setting) => setting.id)
        .filter((id): id is string => typeof id === "string");
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      expect(
        duplicates,
        `${block.name}: duplicate setting ids ${duplicates.join(", ")} — ` +
          `${REJECTED}`,
      ).toEqual([]);
    },
  );

  it.each(blockFiles.map((block) => [block.name, block] as const))(
    "%s: select settings have options and an in-set default; checkbox defaults are booleans",
    (_name, block) => {
      for (const setting of settingsOf(block)) {
        if (setting.type === "select") {
          const options = setting.options;
          expect(
            Array.isArray(options) && options.length > 0,
            `${block.name}: select "${describeSetting(setting)}" has no ` +
              `options — ${REJECTED}`,
          ).toBe(true);
          const values = (options as Array<Record<string, unknown>>).map(
            (option) => {
              expect(
                typeof option.value === "string" &&
                  typeof option.label === "string",
                `${block.name}: select "${describeSetting(setting)}" has an ` +
                  `option without string value+label — ${REJECTED}`,
              ).toBe(true);
              return option.value as string;
            },
          );
          if ("default" in setting) {
            expect(
              values.includes(setting.default as string),
              `${block.name}: select "${describeSetting(setting)}" default ` +
                `"${String(setting.default)}" is not an option value — ` +
                `${REJECTED}`,
            ).toBe(true);
          }
        }
        if (setting.type === "checkbox" && "default" in setting) {
          expect(
            typeof setting.default === "boolean",
            `${block.name}: checkbox "${describeSetting(setting)}" default ` +
              `must be a boolean — ${REJECTED}`,
          ).toBe(true);
        }
      }
    },
  );
});
