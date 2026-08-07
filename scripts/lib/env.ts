import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader for operational scripts (no dotenv dependency).
 *
 * Scripts run via tsx outside the Remix/Vite runtime, so nothing loads .env
 * for them. This parses simple KEY=VALUE lines, honours single/double quotes
 * and an optional `export ` prefix, and ignores comments and blank lines.
 * Values already present in process.env always win, so CI / hosted
 * environments stay authoritative.
 */

/** Absolute path to the repository root (scripts/lib lives two levels below it). */
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseValue(raw: string): string {
  let value = raw.trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) {
    const quote = value[0];
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return value;
  }
  // Unquoted: strip a trailing inline comment (" # ...").
  const hashIdx = value.indexOf(" #");
  if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
  return value;
}

/** Loads .env (then .env.local) from the project root into process.env. */
export function loadDotEnv(dir: string = projectRoot): void {
  for (const filename of [".env", ".env.local"]) {
    const filePath = path.join(dir, filename);
    let text: string;
    try {
      if (!fs.existsSync(filePath)) continue;
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = ENV_LINE.exec(line);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] === undefined) {
        process.env[key] = parseValue(match[2]);
      }
    }
  }
}
