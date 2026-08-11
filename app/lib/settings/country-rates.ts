/**
 * Codec for the "countryRates" settings field type (costModel.vat
 * .countryRatesPct): a record of ISO country code → percentage, edited in
 * the admin as one comma-separated text field. Isomorphic — the settings
 * route uses it on both sides of the form.
 */

/** { CH: 8.1, DE: 19 } → "CH:8.1, DE:19" (stable order for display + diffing). */
export function encodeCountryRates(value: unknown): string {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, rate]) => typeof rate === "number" && Number.isFinite(rate))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, rate]) => `${code}:${rate}`)
    .join(", ");
}

/**
 * "CH:8.1, DE:19" → { CH: 8.1, DE: 19 }. Malformed entries are preserved
 * verbatim (bad code as the key, NaN for an unparseable rate) so the zod
 * schema rejects them with a per-entry message — a typo must never be
 * silently dropped from a tax configuration. A REPEATED country code is a
 * typo too (two rates for one country — last-wins would silently discard
 * the first): the duplicate is keyed "CC (duplicate)", which fails the
 * schema's code regex and surfaces as a per-entry error like any other
 * malformed input.
 */
export function decodeCountryRates(text: string): Record<string, number> {
  const record: Record<string, number> = {};
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    let code = (colon === -1 ? entry : entry.slice(0, colon))
      .trim()
      .toUpperCase();
    const rateText = colon === -1 ? "" : entry.slice(colon + 1).trim();
    if (code in record) code = `${code} (duplicate)`;
    record[code] = rateText === "" ? Number.NaN : Number(rateText);
  }
  return record;
}
