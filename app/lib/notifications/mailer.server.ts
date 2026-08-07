import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Direct SMTP delivery for mail that must not depend on Klaviyo:
 * OTP codes, 3DS action requests, admin alerts, import summaries.
 *
 * Env:
 *  - MAIL_PROVIDER: "smtp" | "console" (case-insensitive). "console" logs and
 *    succeeds, keeping dev/test environments mail-free. Anything ELSE (unset,
 *    empty, or a typo like "smpt") falls back to console too — but that
 *    fallback is IMPLICIT, and in production an implicit console provider is a
 *    misconfiguration, not a choice: every OTP / 3DS / admin email would be
 *    console-logged and reported SENT while no customer receives anything.
 *    So in production sendEmail() refuses to deliver via an implicit console
 *    fallback (throws — the send lands as FAILED in NotificationLog) and
 *    verifyMailer() reports it unhealthy so /api/health goes red. An explicit
 *    MAIL_PROVIDER=console remains allowed everywhere (staging opt-in).
 *  - MAIL_FROM: sender, e.g. `Cellexia <care@cellexia.com>`
 *  - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE ("true" for 465)
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __cellexiaMailTransport: Transporter | undefined;
}

interface ProviderResolution {
  provider: "smtp" | "console";
  /**
   * Set when the console provider engaged as an IMPLICIT fallback — the
   * operator never chose it. "unset": MAIL_PROVIDER missing/empty;
   * "unknown_value": set to something that is neither "smtp" nor "console".
   */
  fallback?: "unset" | "unknown_value";
}

function resolveProvider(): ProviderResolution {
  const raw = process.env.MAIL_PROVIDER;
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "smtp") return { provider: "smtp" };
  if (normalized === "console") return { provider: "console" };
  return {
    provider: "console",
    fallback: normalized === "" ? "unset" : "unknown_value",
  };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Human-readable description of an implicit console fallback. */
function fallbackError(resolution: ProviderResolution): string {
  return resolution.fallback === "unset"
    ? "MAIL_PROVIDER is not set (expected \"smtp\" or \"console\") — direct email would be silently console-logged instead of delivered"
    : `MAIL_PROVIDER has unknown value ${JSON.stringify(process.env.MAIL_PROVIDER)} (expected "smtp" or "console") — direct email would be silently console-logged instead of delivered`;
}

function fromAddress(): string {
  return process.env.MAIL_FROM ?? "Cellexia <no-reply@cellexia.com>";
}

function smtpTransport(): Transporter {
  if (global.__cellexiaMailTransport) return global.__cellexiaMailTransport;

  const host = process.env.SMTP_HOST;
  if (!host) throw new Error("MAIL_PROVIDER=smtp but SMTP_HOST is not set");
  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  global.__cellexiaMailTransport = transport;
  return transport;
}

/** Sends one email. Throws on delivery failure — callers decide containment. */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const resolution = resolveProvider();
  if (resolution.provider === "console") {
    // Fail LOUD on an implicit fallback in production: a deploy that forgot
    // (or typo'd) MAIL_PROVIDER must produce FAILED NotificationLog rows and
    // surfaced errors, never SENT rows for mail nobody received.
    if (resolution.fallback && isProduction()) {
      throw new Error(`[mailer] ${fallbackError(resolution)}`);
    }
    console.log(
      `[mailer:console] to=${input.to} subject="${input.subject}" html=${input.html.length} chars`,
    );
    return;
  }

  await smtpTransport().sendMail({
    from: fromAddress(),
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
}

export interface MailerStatus {
  ok: boolean;
  provider: "smtp" | "console";
  /** True only when console engaged implicitly (MAIL_PROVIDER unset/unknown). */
  implicitFallback?: boolean;
  error?: string;
}

/**
 * Health check for /api/health (which surfaces it in its body and folds it
 * into overall health) and boot-time diagnostics. Mirrors sendEmail's policy
 * exactly: any state in which sendEmail would throw reports ok:false.
 *  - smtp: transport verify() round-trip.
 *  - console, explicitly chosen: ok — dev/staging opt-in.
 *  - console via implicit fallback: ok in dev/test, NOT ok in production
 *    (that is the forgot-MAIL_PROVIDER deploy this check exists to catch).
 */
export async function verifyMailer(): Promise<MailerStatus> {
  const resolution = resolveProvider();
  if (resolution.provider === "console") {
    if (resolution.fallback && isProduction()) {
      return {
        ok: false,
        provider: "console",
        implicitFallback: true,
        error: fallbackError(resolution),
      };
    }
    return {
      ok: true,
      provider: "console",
      ...(resolution.fallback ? { implicitFallback: true } : {}),
    };
  }
  try {
    await smtpTransport().verify();
    return { ok: true, provider: "smtp" };
  } catch (err) {
    return {
      ok: false,
      provider: "smtp",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
