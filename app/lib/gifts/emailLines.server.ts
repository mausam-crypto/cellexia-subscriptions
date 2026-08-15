import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate } from "~/lib/dates.server";

/**
 * Composes the localized gift "lines" the enriched gift emails render
 * (v1.24.0). The email BODIES are static i18n copy referencing
 * {gift_image_line} / {gift_worth_line} / {gift_date_line} — markdown-lite
 * has no conditionals, so optional content must arrive as a pre-composed var:
 * a localized sentence when the data exists, an empty string when it doesn't
 * (an empty paragraph disappears in formatEmailBody). The sentence templates
 * live in the i18n catalog (email.gift_common.*) so every locale renders its
 * own copy; only the assembly happens here.
 *
 * ALWAYS spread the full result into vars — a missing key would ship the
 * literal "{gift_image_line}" to the customer (unknown placeholders stay
 * visible by design).
 */
export interface GiftEmailLineInput {
  locale: string | null | undefined;
  /** Gift display title — used as the image alt. */
  title: string;
  imageUrl?: string | null;
  retailCents?: number | null;
  currencyCode?: string | null;
  arrivalDate?: Date | null;
  /** Shop IANA timezone — required for arrivalDate formatting. */
  tz?: string | null;
}

export function giftEmailLines(
  input: GiftEmailLineInput,
): Record<string, string> {
  const lines: Record<string, string> = {
    gift_image_line: "",
    gift_worth_line: "",
    gift_date_line: "",
  };
  if (input.imageUrl && /^https:\/\//.test(input.imageUrl)) {
    // The alt rides inside the [image:Alt](url) grammar, whose alt group is
    // [^\]]* — a product title containing brackets (e.g. "Serum [50ml]")
    // would make the whole line unparseable and ship raw markup to the
    // customer. Brackets become parens; alt text is cosmetic.
    const alt =
      input.title.replace(/\[/g, "(").replace(/\]/g, ")").trim() || "Gift";
    lines.gift_image_line = `[image:${alt}](${input.imageUrl})`;
  }
  if (
    input.retailCents != null &&
    input.retailCents > 0 &&
    input.currencyCode
  ) {
    lines.gift_worth_line = t(input.locale, "email.gift_common.worth_line", {
      gift_retail_price: formatMoney(
        input.retailCents,
        input.currencyCode,
        input.locale ?? undefined,
      ),
    });
  }
  if (input.arrivalDate && input.tz) {
    lines.gift_date_line = t(input.locale, "email.gift_common.date_line", {
      gift_arrival_date: formatShopDate(
        input.arrivalDate,
        input.tz,
        input.locale ?? undefined,
      ),
    });
  }
  return lines;
}
