/**
 * Cellexia Subscriptions — health probe for cron/CI.
 *
 * Fetches {APP_URL}/api/health, pretty-prints the JSON body and exits:
 *   0  healthy
 *   1  unhealthy or unreachable
 *   2  configuration/usage error
 *
 * The base URL comes from --url, else APP_URL, else SHOPIFY_APP_URL (.env is
 * read automatically). Wire it into cron as e.g.:
 *   npx tsx scripts/healthcheck.ts || <alerting hook>
 */
import { parseArgs } from "node:util";
import { loadDotEnv } from "./lib/env";

loadDotEnv();

const USAGE = `Usage:
  npx tsx scripts/healthcheck.ts [--url <base-or-full-url>] [--timeout-ms <ms>]

Options:
  --url         Base app URL or full health URL. Defaults to APP_URL / SHOPIFY_APP_URL.
  --timeout-ms  Request timeout in milliseconds (default 15000).`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function resolveHealthUrl(urlArg: string | undefined): string {
  const base = urlArg ?? process.env.APP_URL ?? process.env.SHOPIFY_APP_URL;
  if (!base) {
    usageError(
      "No URL configured. Pass --url or set APP_URL / SHOPIFY_APP_URL in .env.",
    );
  }
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/api/health") ? trimmed : `${trimmed}/api/health`;
}

/**
 * Defensive health verdict: HTTP 2xx is required; if the body carries a
 * recognizable status field it must also read healthy.
 */
function isHealthy(httpOk: boolean, body: unknown): boolean {
  if (!httpOk) return false;
  if (!body || typeof body !== "object") return true;
  const record = body as Record<string, unknown>;
  if (typeof record.healthy === "boolean") return record.healthy;
  if (typeof record.ok === "boolean") return record.ok;
  const status = record.status ?? record.state;
  if (typeof status === "string") {
    return ["ok", "healthy", "pass", "up", "green"].includes(
      status.toLowerCase(),
    );
  }
  return true;
}

async function main(): Promise<void> {
  let values: { url?: string; "timeout-ms"?: string };
  try {
    values = parseArgs({
      options: {
        url: { type: "string" },
        "timeout-ms": { type: "string" },
      },
    }).values;
  } catch (err) {
    usageError(errorMessage(err));
  }

  const url = resolveHealthUrl(values.url);
  const timeoutMs = Number(values["timeout-ms"] ?? 15_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    usageError(`Invalid --timeout-ms: ${values["timeout-ms"]}`);
  }

  let response: Response;
  const startedAt = Date.now();
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.error(`UNREACHABLE ${url} — ${errorMessage(err)}`);
    process.exit(1);
  }
  const elapsedMs = Date.now() - startedAt;

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON body — shown raw below.
  }

  const healthy = isHealthy(response.ok, body);
  console.log(
    `${healthy ? "HEALTHY" : "UNHEALTHY"} ${url} — HTTP ${response.status} in ${elapsedMs}ms`,
  );
  if (body !== null) {
    console.log(JSON.stringify(body, null, 2));
  } else if (text.trim() !== "") {
    console.log(text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
  }

  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error(`[healthcheck] fatal: ${errorMessage(err)}`);
  process.exit(1);
});
