/**
 * Klaviyo Events API client (server-to-server).
 *
 * One responsibility: POST a single event to Klaviyo and classify the outcome
 * so the outbox can decide between retry and dead-letter.
 *
 *  - 2xx            → { ok: true }
 *  - 429            → { ok: false, permanent: false }  (rate limited — retry)
 *  - other 4xx      → { ok: false, permanent: true }   (bad payload/key — never retry)
 *  - 5xx / network  → throws KlaviyoServerError        (Klaviyo down — retry)
 *
 * The private API key resolves from two layers (v1.12.0): the per-shop
 * `klaviyo` setting (Admin → Settings → Klaviyo connection; stored encrypted,
 * consulted only when a shopId is supplied) with the KLAVIYO_PRIVATE_API_KEY
 * env var as fallback. A settings-read or decrypt failure degrades to env —
 * settings can improve delivery, never break it. KLAVIYO_API_REVISION stays
 * env-only (Events API revision date, e.g. "2024-10-15").
 */

const KLAVIYO_EVENTS_URL = "https://a.klaviyo.com/api/events/";
const KLAVIYO_ACCOUNTS_URL = "https://a.klaviyo.com/api/accounts/";
const DEFAULT_REVISION = "2024-10-15";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CreateKlaviyoEventInput {
  eventName: string;
  email?: string | null;
  phone?: string | null;
  /** Extra profile attributes (first_name, last_name, ...). */
  profileAttrs?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  eventTime?: Date;
}

export interface KlaviyoSendResult {
  ok: boolean;
  status: number;
  /** true = do not retry (4xx other than 429). */
  permanent?: boolean;
  error?: string;
}

/** Retryable failure — Klaviyo 5xx or a network-level error. */
export class KlaviyoServerError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "KlaviyoServerError";
    this.status = status;
  }
}

export interface KlaviyoAuth {
  apiKey: string | null;
  revision: string;
  /** Where the key came from; null when no key is available anywhere. */
  source: "settings" | "env" | null;
}

/**
 * Resolves the effective Klaviyo credentials: the per-shop setting first
 * (when a shopId is available), the KLAVIYO_PRIVATE_API_KEY env var
 * otherwise. Never throws — any settings/decrypt failure logs and degrades
 * to env.
 */
export async function resolveKlaviyoAuth(shopId?: string): Promise<KlaviyoAuth> {
  const revision = apiRevision();
  if (shopId) {
    try {
      const { getSetting } = await import("~/lib/settings/settings.server");
      const stored = (await getSetting(shopId, "klaviyo")) as {
        privateApiKey?: unknown;
      } | null;
      const raw =
        stored && typeof stored.privateApiKey === "string"
          ? stored.privateApiKey
          : "";
      if (raw) {
        const { revealSecret } = await import("~/lib/crypto/secrets.server");
        const revealed = revealSecret(raw);
        if (revealed.ok && revealed.value) {
          return { apiKey: revealed.value, revision, source: "settings" };
        }
        console.error(
          "[klaviyo] stored private API key could not be decrypted (APP_SIGNING_SECRET rotated?) — falling back to KLAVIYO_PRIVATE_API_KEY; re-enter it on the Settings page",
        );
      }
    } catch (err) {
      console.error(
        "[klaviyo] settings read failed — falling back to KLAVIYO_PRIVATE_API_KEY",
        err,
      );
    }
  }
  const envKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  return envKey
    ? { apiKey: envKey, revision, source: "env" }
    : { apiKey: null, revision, source: null };
}

/**
 * Whether an API key is available for this shop (Settings or env).
 * Async since v1.12.0 — always await it; the un-awaited Promise is truthy,
 * which would silently invert every gate built on this predicate.
 */
export async function isKlaviyoConfigured(shopId?: string): Promise<boolean> {
  return Boolean((await resolveKlaviyoAuth(shopId)).apiKey);
}

function apiKey(): string {
  const key = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!key) throw new Error("KLAVIYO_PRIVATE_API_KEY is not set");
  return key;
}

function apiRevision(): string {
  return process.env.KLAVIYO_API_REVISION || DEFAULT_REVISION;
}

export interface KlaviyoKeyProbeResult {
  ok: boolean;
  detail: string;
}

/**
 * Cheap key validation for the Settings page "Test key" button. Klaviyo has
 * no dry-run for POST /api/events/, so this GETs /api/accounts/ and reads the
 * status: only a 401 proves the key bad — the recommended key is scoped to
 * Events: Full only, so a 403 means "authenticates, lacks accounts:read",
 * which is exactly what a healthy scoped key looks like.
 */
export async function probeKlaviyoKey(
  key: string,
): Promise<KlaviyoKeyProbeResult> {
  let response: Response;
  try {
    response = await fetch(KLAVIYO_ACCOUNTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        revision: apiRevision(),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      detail: `Could not reach Klaviyo to test the key — try again (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  if (response.ok) return { ok: true, detail: "Klaviyo accepted the key." };
  if (response.status === 401) {
    return {
      ok: false,
      detail:
        "Klaviyo rejected the key (401 unauthorized) — check for a copy/paste error or a revoked key.",
    };
  }
  if (response.status === 403) {
    return {
      ok: true,
      detail:
        "Key authenticates (403 on accounts:read is expected for a key scoped to Events only).",
    };
  }
  if (response.status === 429) {
    return {
      ok: true,
      detail: "Key authenticates (Klaviyo rate-limited the test request).",
    };
  }
  return {
    ok: false,
    detail: `Unexpected Klaviyo response (${response.status}) — the key could not be verified.`,
  };
}

/**
 * Sends one event to the Klaviyo Events API.
 * At least one profile identifier (email or phone) is required; without one
 * the call is reported as a permanent failure (Klaviyo would reject it too).
 * `auth` carries the resolved per-shop credentials (resolveKlaviyoAuth);
 * without it the env key is used directly (historical contract).
 */
export async function createKlaviyoEvent(
  input: CreateKlaviyoEventInput,
  auth?: KlaviyoAuth,
): Promise<KlaviyoSendResult> {
  if (!input.email && !input.phone) {
    return {
      ok: false,
      status: 0,
      permanent: true,
      error: "No profile identifier (email or phone) on event",
    };
  }

  const profileAttributes: Record<string, unknown> = {
    ...(input.profileAttrs ?? {}),
  };
  if (input.email) profileAttributes.email = input.email;
  if (input.phone) profileAttributes.phone_number = input.phone;

  const body = {
    data: {
      type: "event",
      attributes: {
        properties: input.properties ?? {},
        time: (input.eventTime ?? new Date()).toISOString(),
        metric: {
          data: {
            type: "metric",
            attributes: { name: input.eventName },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: profileAttributes,
          },
        },
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(KLAVIYO_EVENTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${auth?.apiKey ?? apiKey()}`,
        revision: auth?.revision ?? apiRevision(),
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure / timeout — Klaviyo unreachable, retryable.
    throw new KlaviyoServerError(
      `Klaviyo request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  // Read the error body defensively for diagnostics; never let parsing throw.
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // ignore
  }

  if (response.status >= 500) {
    throw new KlaviyoServerError(
      `Klaviyo ${response.status}: ${detail || response.statusText}`,
      response.status,
    );
  }

  if (response.status === 429) {
    return {
      ok: false,
      status: 429,
      permanent: false,
      error: `Rate limited (429): ${detail || response.statusText}`,
    };
  }

  return {
    ok: false,
    status: response.status,
    permanent: true,
    error: `Klaviyo ${response.status}: ${detail || response.statusText}`,
  };
}
