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
 * Env: KLAVIYO_PRIVATE_API_KEY (pk_...), KLAVIYO_API_REVISION (Events API
 * revision date, e.g. "2024-10-15").
 */

const KLAVIYO_EVENTS_URL = "https://a.klaviyo.com/api/events/";
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

export function isKlaviyoConfigured(): boolean {
  return Boolean(process.env.KLAVIYO_PRIVATE_API_KEY);
}

function apiKey(): string {
  const key = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!key) throw new Error("KLAVIYO_PRIVATE_API_KEY is not set");
  return key;
}

function apiRevision(): string {
  return process.env.KLAVIYO_API_REVISION || DEFAULT_REVISION;
}

/**
 * Sends one event to the Klaviyo Events API.
 * At least one profile identifier (email or phone) is required; without one
 * the call is reported as a permanent failure (Klaviyo would reject it too).
 */
export async function createKlaviyoEvent(
  input: CreateKlaviyoEventInput,
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
        Authorization: `Klaviyo-API-Key ${apiKey()}`,
        revision: apiRevision(),
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
