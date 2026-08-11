import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Direct SMTP delivery for mail that must not depend on Klaviyo:
 * OTP codes, 3DS action requests, admin alerts, import summaries.
 *
 * Configuration resolves from TWO layers (v1.12.0):
 *
 *  1. The per-shop `mailTransport` setting (Admin → Settings → Email
 *     delivery), consulted only when the caller supplies a shopId. Its
 *     provider field is the master switch: "" (default) = "use the
 *     environment variables" — byte-identical to the pre-settings behavior;
 *     "smtp"/"console" is an explicit admin choice, with each blank field
 *     falling back to its matching env var. The stored SMTP password is an
 *     encrypted blob (app/lib/crypto/secrets.server.ts); a failed decrypt
 *     (rotated APP_SIGNING_SECRET) falls back to SMTP_PASS and logs.
 *     Any settings-read failure (DB down, mocked-away getSetting) degrades
 *     to pure env resolution — settings can improve delivery, never break it.
 *
 *  2. Env: MAIL_PROVIDER "smtp" | "console" (case-insensitive), MAIL_FROM,
 *     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE ("true" for
 *     465). "console" logs and succeeds, keeping dev/test environments
 *     mail-free. Anything ELSE (unset, empty, or a typo like "smpt") falls
 *     back to console too — but that fallback is IMPLICIT, and in production
 *     an implicit console provider is a misconfiguration, not a choice:
 *     every OTP / 3DS / admin email would be console-logged and reported
 *     SENT while no customer receives anything. So in production sendEmail()
 *     refuses to deliver via an implicit console fallback (throws — the send
 *     lands as FAILED in NotificationLog) and verifyMailer() reports it
 *     unhealthy so /api/health goes red. An explicit console choice — env or
 *     settings — remains allowed everywhere (staging opt-in).
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /**
   * Enables the per-shop settings layer. Without it resolution is env-only —
   * the pre-v1.12.0 contract (tests and any shop-less caller rely on this).
   */
  shopId?: string;
}

interface CachedTransport {
  /** Hash of the resolved SMTP config; the transport rebuilds when it changes. */
  key: string;
  transport: Transporter;
}

declare global {
  // eslint-disable-next-line no-var
  var __cellexiaMailTransport: CachedTransport | undefined;
}

export interface ResolvedMailConfig {
  provider: "smtp" | "console";
  /**
   * Set when the console provider engaged as an IMPLICIT fallback — the
   * operator never chose it. "unset": MAIL_PROVIDER missing/empty;
   * "unknown_value": set to something that is neither "smtp" nor "console".
   * Only ever set on env-sourced resolution: a settings provider is always
   * an explicit admin choice.
   */
  fallback?: "unset" | "unknown_value";
  /** Which layer decided the provider. */
  source: "settings" | "env";
  from: string;
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
}

const DEFAULT_FROM = "Cellexia <no-reply@cellexia.com>";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Human-readable description of an implicit console fallback. */
function fallbackError(config: ResolvedMailConfig): string {
  return config.fallback === "unset"
    ? "MAIL_PROVIDER is not set and no transport is chosen on the Settings page (expected \"smtp\" or \"console\") — direct email would be silently console-logged instead of delivered"
    : `MAIL_PROVIDER has unknown value ${JSON.stringify(process.env.MAIL_PROVIDER)} (expected "smtp" or "console") — direct email would be silently console-logged instead of delivered`;
}

/** The stored mailTransport setting, defensively normalized. */
interface MailTransportSetting {
  provider: "" | "smtp" | "console";
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: "auto" | "always" | "never";
}

/**
 * Reads the per-shop mailTransport setting. Returns null on ANY failure —
 * missing modules, DB down, schema drift — so resolution degrades to env.
 * Fields are re-normalized here because test suites mock getSetting to return
 * {} for keys they don't care about.
 */
async function readMailSettings(
  shopId: string,
): Promise<MailTransportSetting | null> {
  try {
    const { getSetting } = await import("~/lib/settings/settings.server");
    const raw = (await getSetting(shopId, "mailTransport")) as Partial<
      MailTransportSetting
    > | null;
    if (!raw || typeof raw !== "object") return null;
    const provider =
      raw.provider === "smtp" || raw.provider === "console" ? raw.provider : "";
    return {
      provider,
      from: typeof raw.from === "string" ? raw.from : "",
      smtpHost: typeof raw.smtpHost === "string" ? raw.smtpHost : "",
      smtpPort:
        typeof raw.smtpPort === "number" && Number.isInteger(raw.smtpPort)
          ? raw.smtpPort
          : 0,
      smtpUser: typeof raw.smtpUser === "string" ? raw.smtpUser : "",
      smtpPass: typeof raw.smtpPass === "string" ? raw.smtpPass : "",
      smtpSecure:
        raw.smtpSecure === "always" || raw.smtpSecure === "never"
          ? raw.smtpSecure
          : "auto",
    };
  } catch (err) {
    console.error(
      "[mailer] mailTransport settings read failed — falling back to environment variables",
      err,
    );
    return null;
  }
}

/**
 * Decrypts the stored SMTP password. ok:false means a stored value EXISTS but
 * cannot be decrypted (rotated APP_SIGNING_SECRET, corrupt blob) — the caller
 * then abandons the whole settings transport for env resolution: an
 * admin-configured host paired with a fallback password for a different
 * relay could never authenticate, while the env transport the merchant
 * migrated from usually still works. "" with ok:true means "nothing stored"
 * (the documented per-field env fallback).
 */
async function revealStoredPass(
  stored: string,
): Promise<{ ok: boolean; value: string }> {
  if (!stored) return { ok: true, value: "" };
  try {
    const { revealSecret } = await import("~/lib/crypto/secrets.server");
    const revealed = revealSecret(stored);
    if (revealed.ok) return { ok: true, value: revealed.value };
    return { ok: false, value: "" };
  } catch {
    return { ok: false, value: "" };
  }
}

function envPort(): number {
  const parsed = Number(process.env.SMTP_PORT ?? 587);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 587;
}

/** Env-only resolution — the exact historical contract. */
function resolveFromEnv(): ResolvedMailConfig {
  const raw = process.env.MAIL_PROVIDER;
  const normalized = (raw ?? "").trim().toLowerCase();
  const port = envPort();
  const base = {
    source: "env" as const,
    from: process.env.MAIL_FROM || DEFAULT_FROM,
    host: process.env.SMTP_HOST || null,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
  };
  if (normalized === "smtp") return { provider: "smtp", ...base };
  if (normalized === "console") return { provider: "console", ...base };
  return {
    provider: "console",
    fallback: normalized === "" ? "unset" : "unknown_value",
    ...base,
  };
}

/**
 * Resolves the effective mail configuration: per-shop settings first (when a
 * shopId is available and the admin picked a provider), env otherwise.
 * Never throws.
 */
export async function resolveMailConfig(
  shopId?: string,
): Promise<ResolvedMailConfig> {
  const stored = shopId ? await readMailSettings(shopId) : null;
  if (!stored || stored.provider === "") return resolveFromEnv();

  let pass: string | null = null;
  if (stored.provider === "smtp") {
    const revealedPass = await revealStoredPass(stored.smtpPass);
    if (!revealedPass.ok) {
      // The stored password exists but cannot be decrypted
      // (APP_SIGNING_SECRET rotated, corrupt blob): abandon the WHOLE
      // settings transport — an admin host paired with a fallback password
      // for a different relay could never authenticate, while the env
      // transport is the one configuration that may still be intact (the
      // "delivery falls back to the env vars" promise in OPERATIONS §10).
      // An explicit console choice is untouched by this: no password is in
      // play there, and the choice must not be overridden by a stale blob.
      console.error(
        "[mailer] stored SMTP password could not be decrypted (APP_SIGNING_SECRET rotated?) — using the environment transport; re-enter the password on the Settings page",
      );
      return resolveFromEnv();
    }
    pass = revealedPass.value || process.env.SMTP_PASS || null;
  }
  const port = stored.smtpPort > 0 ? stored.smtpPort : envPort();
  const secure =
    stored.smtpSecure === "always"
      ? true
      : stored.smtpSecure === "never"
        ? false
        : process.env.SMTP_SECURE === "true" || port === 465;
  return {
    provider: stored.provider,
    source: "settings",
    from: stored.from || process.env.MAIL_FROM || DEFAULT_FROM,
    host: stored.smtpHost || process.env.SMTP_HOST || null,
    port,
    secure,
    user: stored.smtpUser || process.env.SMTP_USER || null,
    pass,
  };
}

function smtpTransport(config: ResolvedMailConfig): Transporter {
  if (!config.host) {
    throw new Error(
      config.source === "settings"
        ? "SMTP transport chosen on the Settings page but no SMTP host is configured (Settings or SMTP_HOST)"
        : "MAIL_PROVIDER=smtp but SMTP_HOST is not set",
    );
  }
  // Keyed by the resolved config so a settings save takes effect on the next
  // send — in THIS process and, because every instance re-derives the same
  // key, on every other instance too (multi-instance hosts are a supported
  // topology; see docs/INSTALL.md).
  const cacheKey = JSON.stringify([
    config.host,
    config.port,
    config.secure,
    config.user,
    config.pass,
  ]);
  const cached = global.__cellexiaMailTransport;
  if (cached && cached.key === cacheKey) return cached.transport;

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.pass
        ? { user: config.user, pass: config.pass }
        : undefined,
    // Nodemailer's defaults (2 min connect, 10 min socket) would let one
    // unreachable relay pin every caller for minutes — since v1.17.0 sends
    // can originate from portal actions and webhook handlers (confirmation
    // bridge), a hung transport must fail fast and land as FAILED instead.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  global.__cellexiaMailTransport = { key: cacheKey, transport };
  return transport;
}

/** Sends one email. Throws on delivery failure — callers decide containment. */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const config = await resolveMailConfig(input.shopId);
  if (config.provider === "console") {
    // Fail LOUD on an implicit fallback in production: a deploy that forgot
    // (or typo'd) MAIL_PROVIDER must produce FAILED NotificationLog rows and
    // surfaced errors, never SENT rows for mail nobody received.
    if (config.fallback && isProduction()) {
      throw new Error(`[mailer] ${fallbackError(config)}`);
    }
    console.log(
      `[mailer:console] to=${input.to} subject="${input.subject}" html=${input.html.length} chars`,
    );
    return;
  }

  await smtpTransport(config).sendMail({
    from: config.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
}

export interface MailerStatus {
  ok: boolean;
  provider: "smtp" | "console";
  /** Which layer decided the provider ("settings" = admin panel). */
  source: "settings" | "env";
  /** True only when console engaged implicitly (MAIL_PROVIDER unset/unknown). */
  implicitFallback?: boolean;
  error?: string;
}

/**
 * Health check for /api/health (which surfaces it in its body and folds it
 * into overall health) and the Debug self-check. Mirrors sendEmail's policy
 * exactly: any state in which sendEmail would throw reports ok:false.
 *  - smtp: transport verify() round-trip.
 *  - console, explicitly chosen (env or Settings): ok — dev/staging opt-in.
 *  - console via implicit fallback: ok in dev/test, NOT ok in production
 *    (that is the forgot-MAIL_PROVIDER deploy this check exists to catch).
 * Pass a shopId to include the per-shop Settings layer; without one the check
 * is env-only. Never throws.
 */
export async function verifyMailer(shopId?: string): Promise<MailerStatus> {
  const config = await resolveMailConfig(shopId);
  if (config.provider === "console") {
    if (config.fallback && isProduction()) {
      return {
        ok: false,
        provider: "console",
        source: config.source,
        implicitFallback: true,
        error: fallbackError(config),
      };
    }
    return {
      ok: true,
      provider: "console",
      source: config.source,
      ...(config.fallback ? { implicitFallback: true } : {}),
    };
  }
  try {
    await smtpTransport(config).verify();
    return { ok: true, provider: "smtp", source: config.source };
  } catch (err) {
    return {
      ok: false,
      provider: "smtp",
      source: config.source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
