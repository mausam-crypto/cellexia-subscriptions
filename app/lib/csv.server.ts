/**
 * CSV cell encoding for admin exports (audit log, subscribers).
 *
 * ONE shared implementation on purpose: the audit and subscribers routes each
 * grew an identical private copy, and duplicated escaping is exactly how one
 * surface gets a security fix while the other keeps the hole.
 *
 * Two jobs, in order:
 *
 * 1. FORMULA-INJECTION NEUTRALIZATION (OWASP CSV injection): exported cells
 *    contain customer-controlled text — checkout first/last names, emails,
 *    line titles, event payload JSON — that arrives via webhooks. A value
 *    beginning with `=`, `+`, `-`, `@` (or a tab/CR that hides one) is
 *    evaluated as a FORMULA when the merchant opens the export in
 *    Excel/Sheets/LibreOffice, enabling exfiltration links
 *    (`=HYPERLINK(...)`) or, on DDE-enabled setups, command execution. Such
 *    values are prefixed with a single quote — the spreadsheet convention for
 *    "literal text", which Excel/Sheets do not display as part of the value.
 *    The prefix is applied per OWASP guidance even to values that are merely
 *    negative-number-shaped ("-5"): no export column legitimately starts with
 *    a formula trigger, and a defanged number is a far better failure mode
 *    than an executed formula.
 *
 * 2. RFC-4180 QUOTING: values containing quotes, commas or newlines are
 *    wrapped in double quotes with inner quotes doubled.
 */
export function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  const neutralized = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(neutralized)
    ? `"${neutralized.replace(/"/g, '""')}"`
    : neutralized;
}
