/**
 * Static country / region data behind the portal address form's selects
 * (v1.28.0, P2.8 review fix — customers no longer type ISO codes by hand).
 *
 * - `COUNTRY_CODES`: ISO 3166-1 alpha-2 codes Shopify ships to. Names are
 *   NOT stored here: `countryName()` asks `Intl.DisplayNames` for the
 *   customer's locale (Node ships full ICU) and falls back to the code.
 * - `PROVINCES`: the region / state codes Shopify requires for the countries
 *   that carry them (MailingAddressInput.provinceCode). Names are Shopify's
 *   English region names; a country absent from the map has no required
 *   region and the form keeps a free-text field for it.
 *
 * Pure, isomorphic, no I/O — the server validates against the same tables
 * the page renders from, so a select value can never fail Shopify's address
 * validation for being unknown.
 */

export const COUNTRY_CODES: readonly string[] = [
  "AC", "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AR", "AT", "AU", "AW",
  "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM",
  "BN", "BO", "BQ", "BR", "BS", "BT", "BW", "BY", "BZ", "CA", "CC", "CD", "CF",
  "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CV", "CW", "CX", "CY",
  "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES",
  "ET", "FI", "FJ", "FK", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH",
  "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GW", "GY", "HK", "HN",
  "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IS", "IT", "JE",
  "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC",
  "MD", "ME", "MF", "MG", "MK", "ML", "MM", "MN", "MO", "MQ", "MR", "MS", "MT",
  "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL",
  "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL",
  "PM", "PN", "PS", "PT", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB",
  "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR",
  "SS", "ST", "SV", "SX", "SZ", "TA", "TC", "TD", "TF", "TG", "TH", "TJ", "TK",
  "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US",
  "UY", "UZ", "VA", "VC", "VE", "VG", "VN", "VU", "WF", "WS", "XK", "YE", "YT",
  "ZA", "ZM", "ZW",
];

const COUNTRY_SET = new Set(COUNTRY_CODES);

export function isKnownCountry(code: string): boolean {
  return COUNTRY_SET.has(code.toUpperCase());
}

export interface ProvinceOption {
  code: string;
  name: string;
}

/** Shopify's required regions, by country. */
export const PROVINCES: Readonly<Record<string, readonly ProvinceOption[]>> = {
  US: [
    { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
    { code: "AS", name: "American Samoa" }, { code: "AZ", name: "Arizona" },
    { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" },
    { code: "CO", name: "Colorado" }, { code: "CT", name: "Connecticut" },
    { code: "DE", name: "Delaware" }, { code: "DC", name: "District of Columbia" },
    { code: "FM", name: "Micronesia" }, { code: "FL", name: "Florida" },
    { code: "GA", name: "Georgia" }, { code: "GU", name: "Guam" },
    { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
    { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
    { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" },
    { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
    { code: "ME", name: "Maine" }, { code: "MH", name: "Marshall Islands" },
    { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
    { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" },
    { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" },
    { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
    { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" },
    { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" },
    { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
    { code: "ND", name: "North Dakota" }, { code: "MP", name: "Northern Mariana Islands" },
    { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
    { code: "OR", name: "Oregon" }, { code: "PW", name: "Palau" },
    { code: "PA", name: "Pennsylvania" }, { code: "PR", name: "Puerto Rico" },
    { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" },
    { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
    { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
    { code: "VT", name: "Vermont" }, { code: "VI", name: "U.S. Virgin Islands" },
    { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" },
    { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" },
    { code: "WY", name: "Wyoming" }, { code: "AA", name: "Armed Forces Americas" },
    { code: "AE", name: "Armed Forces Europe" }, { code: "AP", name: "Armed Forces Pacific" },
  ],
  CA: [
    { code: "AB", name: "Alberta" }, { code: "BC", name: "British Columbia" },
    { code: "MB", name: "Manitoba" }, { code: "NB", name: "New Brunswick" },
    { code: "NL", name: "Newfoundland and Labrador" }, { code: "NT", name: "Northwest Territories" },
    { code: "NS", name: "Nova Scotia" }, { code: "NU", name: "Nunavut" },
    { code: "ON", name: "Ontario" }, { code: "PE", name: "Prince Edward Island" },
    { code: "QC", name: "Quebec" }, { code: "SK", name: "Saskatchewan" },
    { code: "YT", name: "Yukon" },
  ],
  AU: [
    { code: "ACT", name: "Australian Capital Territory" }, { code: "NSW", name: "New South Wales" },
    { code: "NT", name: "Northern Territory" }, { code: "QLD", name: "Queensland" },
    { code: "SA", name: "South Australia" }, { code: "TAS", name: "Tasmania" },
    { code: "VIC", name: "Victoria" }, { code: "WA", name: "Western Australia" },
  ],
  MX: [
    { code: "AGS", name: "Aguascalientes" }, { code: "BC", name: "Baja California" },
    { code: "BCS", name: "Baja California Sur" }, { code: "CAMP", name: "Campeche" },
    { code: "CHIS", name: "Chiapas" }, { code: "CHIH", name: "Chihuahua" },
    { code: "DF", name: "Ciudad de México" }, { code: "COAH", name: "Coahuila" },
    { code: "COL", name: "Colima" }, { code: "DGO", name: "Durango" },
    { code: "GTO", name: "Guanajuato" }, { code: "GRO", name: "Guerrero" },
    { code: "HGO", name: "Hidalgo" }, { code: "JAL", name: "Jalisco" },
    { code: "MEX", name: "México" }, { code: "MICH", name: "Michoacán" },
    { code: "MOR", name: "Morelos" }, { code: "NAY", name: "Nayarit" },
    { code: "NL", name: "Nuevo León" }, { code: "OAX", name: "Oaxaca" },
    { code: "PUE", name: "Puebla" }, { code: "QRO", name: "Querétaro" },
    { code: "Q ROO", name: "Quintana Roo" }, { code: "SLP", name: "San Luis Potosí" },
    { code: "SIN", name: "Sinaloa" }, { code: "SON", name: "Sonora" },
    { code: "TAB", name: "Tabasco" }, { code: "TAMPS", name: "Tamaulipas" },
    { code: "TLAX", name: "Tlaxcala" }, { code: "VER", name: "Veracruz" },
    { code: "YUC", name: "Yucatán" }, { code: "ZAC", name: "Zacatecas" },
  ],
  BR: [
    { code: "AC", name: "Acre" }, { code: "AL", name: "Alagoas" }, { code: "AP", name: "Amapá" },
    { code: "AM", name: "Amazonas" }, { code: "BA", name: "Bahia" }, { code: "CE", name: "Ceará" },
    { code: "DF", name: "Distrito Federal" }, { code: "ES", name: "Espírito Santo" },
    { code: "GO", name: "Goiás" }, { code: "MA", name: "Maranhão" }, { code: "MT", name: "Mato Grosso" },
    { code: "MS", name: "Mato Grosso do Sul" }, { code: "MG", name: "Minas Gerais" },
    { code: "PA", name: "Pará" }, { code: "PB", name: "Paraíba" }, { code: "PR", name: "Paraná" },
    { code: "PE", name: "Pernambuco" }, { code: "PI", name: "Piauí" }, { code: "RJ", name: "Rio de Janeiro" },
    { code: "RN", name: "Rio Grande do Norte" }, { code: "RS", name: "Rio Grande do Sul" },
    { code: "RO", name: "Rondônia" }, { code: "RR", name: "Roraima" }, { code: "SC", name: "Santa Catarina" },
    { code: "SP", name: "São Paulo" }, { code: "SE", name: "Sergipe" }, { code: "TO", name: "Tocantins" },
  ],
  IE: [
    { code: "CW", name: "Carlow" }, { code: "CN", name: "Cavan" }, { code: "CE", name: "Clare" },
    { code: "CO", name: "Cork" }, { code: "DL", name: "Donegal" }, { code: "D", name: "Dublin" },
    { code: "G", name: "Galway" }, { code: "KY", name: "Kerry" }, { code: "KE", name: "Kildare" },
    { code: "KK", name: "Kilkenny" }, { code: "LS", name: "Laois" }, { code: "LM", name: "Leitrim" },
    { code: "LK", name: "Limerick" }, { code: "LD", name: "Longford" }, { code: "LH", name: "Louth" },
    { code: "MO", name: "Mayo" }, { code: "MH", name: "Meath" }, { code: "MN", name: "Monaghan" },
    { code: "OY", name: "Offaly" }, { code: "RN", name: "Roscommon" }, { code: "SO", name: "Sligo" },
    { code: "TA", name: "Tipperary" }, { code: "WD", name: "Waterford" }, { code: "WH", name: "Westmeath" },
    { code: "WX", name: "Wexford" }, { code: "WW", name: "Wicklow" },
  ],
  IT: [
    { code: "AG", name: "Agrigento" }, { code: "AL", name: "Alessandria" }, { code: "AN", name: "Ancona" },
    { code: "AO", name: "Aosta" }, { code: "AR", name: "Arezzo" }, { code: "AP", name: "Ascoli Piceno" },
    { code: "AT", name: "Asti" }, { code: "AV", name: "Avellino" }, { code: "BA", name: "Bari" },
    { code: "BT", name: "Barletta-Andria-Trani" }, { code: "BL", name: "Belluno" }, { code: "BN", name: "Benevento" },
    { code: "BG", name: "Bergamo" }, { code: "BI", name: "Biella" }, { code: "BO", name: "Bologna" },
    { code: "BZ", name: "Bolzano" }, { code: "BS", name: "Brescia" }, { code: "BR", name: "Brindisi" },
    { code: "CA", name: "Cagliari" }, { code: "CL", name: "Caltanissetta" }, { code: "CB", name: "Campobasso" },
    { code: "CI", name: "Carbonia-Iglesias" }, { code: "CE", name: "Caserta" }, { code: "CT", name: "Catania" },
    { code: "CZ", name: "Catanzaro" }, { code: "CH", name: "Chieti" }, { code: "CO", name: "Como" },
    { code: "CS", name: "Cosenza" }, { code: "CR", name: "Cremona" }, { code: "KR", name: "Crotone" },
    { code: "CN", name: "Cuneo" }, { code: "EN", name: "Enna" }, { code: "FM", name: "Fermo" },
    { code: "FE", name: "Ferrara" }, { code: "FI", name: "Firenze" }, { code: "FG", name: "Foggia" },
    { code: "FC", name: "Forlì-Cesena" }, { code: "FR", name: "Frosinone" }, { code: "GE", name: "Genova" },
    { code: "GO", name: "Gorizia" }, { code: "GR", name: "Grosseto" }, { code: "IM", name: "Imperia" },
    { code: "IS", name: "Isernia" }, { code: "AQ", name: "L'Aquila" }, { code: "SP", name: "La Spezia" },
    { code: "LT", name: "Latina" }, { code: "LE", name: "Lecce" }, { code: "LC", name: "Lecco" },
    { code: "LI", name: "Livorno" }, { code: "LO", name: "Lodi" }, { code: "LU", name: "Lucca" },
    { code: "MC", name: "Macerata" }, { code: "MN", name: "Mantova" }, { code: "MS", name: "Massa-Carrara" },
    { code: "MT", name: "Matera" }, { code: "VS", name: "Medio Campidano" }, { code: "ME", name: "Messina" },
    { code: "MI", name: "Milano" }, { code: "MO", name: "Modena" }, { code: "MB", name: "Monza e Brianza" },
    { code: "NA", name: "Napoli" }, { code: "NO", name: "Novara" }, { code: "NU", name: "Nuoro" },
    { code: "OG", name: "Ogliastra" }, { code: "OT", name: "Olbia-Tempio" }, { code: "OR", name: "Oristano" },
    { code: "PD", name: "Padova" }, { code: "PA", name: "Palermo" }, { code: "PR", name: "Parma" },
    { code: "PV", name: "Pavia" }, { code: "PG", name: "Perugia" }, { code: "PU", name: "Pesaro e Urbino" },
    { code: "PE", name: "Pescara" }, { code: "PC", name: "Piacenza" }, { code: "PI", name: "Pisa" },
    { code: "PT", name: "Pistoia" }, { code: "PN", name: "Pordenone" }, { code: "PZ", name: "Potenza" },
    { code: "PO", name: "Prato" }, { code: "RG", name: "Ragusa" }, { code: "RA", name: "Ravenna" },
    { code: "RC", name: "Reggio Calabria" }, { code: "RE", name: "Reggio Emilia" }, { code: "RI", name: "Rieti" },
    { code: "RN", name: "Rimini" }, { code: "RM", name: "Roma" }, { code: "RO", name: "Rovigo" },
    { code: "SA", name: "Salerno" }, { code: "SS", name: "Sassari" }, { code: "SV", name: "Savona" },
    { code: "SI", name: "Siena" }, { code: "SR", name: "Siracusa" }, { code: "SO", name: "Sondrio" },
    { code: "TA", name: "Taranto" }, { code: "TE", name: "Teramo" }, { code: "TR", name: "Terni" },
    { code: "TO", name: "Torino" }, { code: "TP", name: "Trapani" }, { code: "TN", name: "Trento" },
    { code: "TV", name: "Treviso" }, { code: "TS", name: "Trieste" }, { code: "UD", name: "Udine" },
    { code: "VA", name: "Varese" }, { code: "VE", name: "Venezia" }, { code: "VB", name: "Verbano-Cusio-Ossola" },
    { code: "VC", name: "Vercelli" }, { code: "VR", name: "Verona" }, { code: "VV", name: "Vibo Valentia" },
    { code: "VI", name: "Vicenza" }, { code: "VT", name: "Viterbo" },
  ],
  ES: [
    { code: "C", name: "A Coruña" }, { code: "VI", name: "Álava" }, { code: "AB", name: "Albacete" },
    { code: "A", name: "Alicante" }, { code: "AL", name: "Almería" }, { code: "O", name: "Asturias" },
    { code: "AV", name: "Ávila" }, { code: "BA", name: "Badajoz" }, { code: "PM", name: "Balears" },
    { code: "B", name: "Barcelona" }, { code: "BU", name: "Burgos" }, { code: "CC", name: "Cáceres" },
    { code: "CA", name: "Cádiz" }, { code: "S", name: "Cantabria" }, { code: "CS", name: "Castellón" },
    { code: "CE", name: "Ceuta" }, { code: "CR", name: "Ciudad Real" }, { code: "CO", name: "Córdoba" },
    { code: "CU", name: "Cuenca" }, { code: "GI", name: "Girona" }, { code: "GR", name: "Granada" },
    { code: "GU", name: "Guadalajara" }, { code: "SS", name: "Guipúzcoa" }, { code: "H", name: "Huelva" },
    { code: "HU", name: "Huesca" }, { code: "J", name: "Jaén" }, { code: "LO", name: "La Rioja" },
    { code: "GC", name: "Las Palmas" }, { code: "LE", name: "León" }, { code: "L", name: "Lleida" },
    { code: "LU", name: "Lugo" }, { code: "M", name: "Madrid" }, { code: "MA", name: "Málaga" },
    { code: "ML", name: "Melilla" }, { code: "MU", name: "Murcia" }, { code: "NA", name: "Navarra" },
    { code: "OR", name: "Ourense" }, { code: "P", name: "Palencia" }, { code: "PO", name: "Pontevedra" },
    { code: "SA", name: "Salamanca" }, { code: "TF", name: "Santa Cruz de Tenerife" }, { code: "SG", name: "Segovia" },
    { code: "SE", name: "Sevilla" }, { code: "SO", name: "Soria" }, { code: "T", name: "Tarragona" },
    { code: "TE", name: "Teruel" }, { code: "TO", name: "Toledo" }, { code: "V", name: "Valencia" },
    { code: "VA", name: "Valladolid" }, { code: "BI", name: "Vizcaya" }, { code: "ZA", name: "Zamora" },
    { code: "Z", name: "Zaragoza" },
  ],
  IN: [
    { code: "AN", name: "Andaman and Nicobar Islands" }, { code: "AP", name: "Andhra Pradesh" },
    { code: "AR", name: "Arunachal Pradesh" }, { code: "AS", name: "Assam" }, { code: "BR", name: "Bihar" },
    { code: "CH", name: "Chandigarh" }, { code: "CG", name: "Chhattisgarh" },
    { code: "DN", name: "Dadra and Nagar Haveli" }, { code: "DD", name: "Daman and Diu" },
    { code: "DL", name: "Delhi" }, { code: "GA", name: "Goa" }, { code: "GJ", name: "Gujarat" },
    { code: "HR", name: "Haryana" }, { code: "HP", name: "Himachal Pradesh" }, { code: "JK", name: "Jammu and Kashmir" },
    { code: "JH", name: "Jharkhand" }, { code: "KA", name: "Karnataka" }, { code: "KL", name: "Kerala" },
    { code: "LA", name: "Ladakh" }, { code: "LD", name: "Lakshadweep" }, { code: "MP", name: "Madhya Pradesh" },
    { code: "MH", name: "Maharashtra" }, { code: "MN", name: "Manipur" }, { code: "ML", name: "Meghalaya" },
    { code: "MZ", name: "Mizoram" }, { code: "NL", name: "Nagaland" }, { code: "OR", name: "Odisha" },
    { code: "PY", name: "Puducherry" }, { code: "PB", name: "Punjab" }, { code: "RJ", name: "Rajasthan" },
    { code: "SK", name: "Sikkim" }, { code: "TN", name: "Tamil Nadu" }, { code: "TS", name: "Telangana" },
    { code: "TR", name: "Tripura" }, { code: "UP", name: "Uttar Pradesh" }, { code: "UK", name: "Uttarakhand" },
    { code: "WB", name: "West Bengal" },
  ],
};

/** Regions Shopify requires for `countryCode`, or an empty list. */
export function provincesFor(countryCode: string | null | undefined): readonly ProvinceOption[] {
  if (!countryCode) return [];
  return PROVINCES[countryCode.toUpperCase()] ?? [];
}

/** True when the country carries a required region list. */
export function countryRequiresProvince(countryCode: string | null | undefined): boolean {
  return provincesFor(countryCode).length > 0;
}

/**
 * Normalise a submitted region for `countryCode`: for countries with a
 * required list the value must be one of its codes (case-insensitive; a
 * region NAME typed in the free-text fallback is accepted too and mapped to
 * its code) — otherwise null. Countries without a list keep the trimmed text.
 */
export function normalizeProvinceCode(
  countryCode: string,
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  const text = (raw ?? "").trim();
  const list = provincesFor(countryCode);
  if (list.length === 0) return { ok: true, value: text || null };
  if (!text) return { ok: false };
  const upper = text.toUpperCase();
  const byCode = list.find((p) => p.code.toUpperCase() === upper);
  if (byCode) return { ok: true, value: byCode.code };
  const lower = text.toLowerCase();
  const byName = list.find((p) => p.name.toLowerCase() === lower);
  return byName ? { ok: true, value: byName.code } : { ok: false };
}

// One Intl.DisplayNames per locale (the storefront request path renders the
// country field on every subscription page — v1.28.0 review fix).
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();
function displayNamesFor(locale: string): Intl.DisplayNames | null {
  const hit = displayNamesCache.get(locale);
  if (hit !== undefined) return hit;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale, "en"], { type: "region" });
  } catch {
    names = null;
  }
  displayNamesCache.set(locale, names);
  return names;
}

/** Localised country name (Intl.DisplayNames), falling back to the code. */
export function countryName(code: string, locale: string): string {
  try {
    return displayNamesFor(locale)?.of(code) ?? code;
  } catch {
    return code;
  }
}

// The option list is static per locale — memoised (frozen; callers copy
// before mutating).
const countryOptionsCache = new Map<string, ReadonlyArray<{ code: string; name: string }>>();

/** All countries as {code, name} sorted by the localised name. */
export function countryOptions(
  locale: string,
): ReadonlyArray<{ code: string; name: string }> {
  const hit = countryOptionsCache.get(locale);
  if (hit) return hit;
  const collator = new Intl.Collator(locale);
  const list = Object.freeze(
    COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort(
      (a, b) => collator.compare(a.name, b.name),
    ),
  );
  countryOptionsCache.set(locale, list);
  return list;
}
