import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Direct SMTP delivery for mail that must not depend on Klaviyo:
 * OTP codes, 3DS action requests, admin alerts, import summaries.
 *
 * Env:
 *  - MAIL_PROVIDER: "smtp" | "console" (default "console" — logs and succeeds,
 *    keeping dev/test environments mail-free)
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

function provider(): "smtp" | "console" {
  return process.env.MAIL_PROVIDER === "smtp" ? "smtp" : "console";
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
  if (provider() === "console") {
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
  error?: string;
}

/** Health check for /api/health and boot-time diagnostics. */
export async function verifyMailer(): Promise<MailerStatus> {
  const prov = provider();
  if (prov === "console") return { ok: true, provider: prov };
  try {
    await smtpTransport().verify();
    return { ok: true, provider: prov };
  } catch (err) {
    return {
      ok: false,
      provider: prov,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
