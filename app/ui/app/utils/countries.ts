/**
 * Is this word the name of a country, and which one?
 *
 * No country name is written down here. `Intl.DisplayNames` already holds every one of them, in
 * English and in the reader's own language, so the names are asked for rather than listed: a
 * reader whose locale is pt-BR writes `Alemanha` and an English one writes `Germany`, and both
 * reach DE without this repository taking a view on which languages matter.
 *
 * The codes themselves are enumerated — every two-letter combination is offered to the platform,
 * which answers with a name for the ones that are real regions and echoes the code back for the
 * rest. That is 676 lookups, once, and it is the only way to get the list without shipping one.
 */

/** Diacritics out, case down: `Düsseldorf` and `Dusseldorf` are the same word. */
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * ISO 3166-1 alpha-3, which no runtime maps and addresses are full of.
 *
 * This one is a list because there is no alternative to a list: the platform knows `US` and
 * `United States` and has never heard of `USA`. It is not a view on which countries the app serves
 * — every country is reachable by its name and its two-letter code without appearing here.
 */
const ALPHA3: Record<string, string> = {
  ABW: "AW", AFG: "AF", AGO: "AO", ALB: "AL", AND: "AD", ARE: "AE", ARG: "AR", ARM: "AM", ATG: "AG",
  AUS: "AU", AUT: "AT", AZE: "AZ", BDI: "BI", BEL: "BE", BEN: "BJ", BFA: "BF", BGD: "BD", BGR: "BG",
  BHR: "BH", BHS: "BS", BIH: "BA", BLR: "BY", BLZ: "BZ", BOL: "BO", BRA: "BR", BRB: "BB", BRN: "BN",
  BTN: "BT", BWA: "BW", CAF: "CF", CAN: "CA", CHE: "CH", CHL: "CL", CHN: "CN", CIV: "CI", CMR: "CM",
  COD: "CD", COG: "CG", COL: "CO", COM: "KM", CPV: "CV", CRI: "CR", CUB: "CU", CYP: "CY", CZE: "CZ",
  DEU: "DE", DJI: "DJ", DMA: "DM", DNK: "DK", DOM: "DO", DZA: "DZ", ECU: "EC", EGY: "EG", ERI: "ER",
  ESP: "ES", EST: "EE", ETH: "ET", FIN: "FI", FJI: "FJ", FRA: "FR", FSM: "FM", GAB: "GA", GBR: "GB",
  GEO: "GE", GHA: "GH", GIN: "GN", GMB: "GM", GNB: "GW", GNQ: "GQ", GRC: "GR", GRD: "GD", GTM: "GT",
  GUY: "GY", HND: "HN", HRV: "HR", HTI: "HT", HUN: "HU", IDN: "ID", IND: "IN", IRL: "IE", IRN: "IR",
  IRQ: "IQ", ISL: "IS", ISR: "IL", ITA: "IT", JAM: "JM", JOR: "JO", JPN: "JP", KAZ: "KZ", KEN: "KE",
  KGZ: "KG", KHM: "KH", KIR: "KI", KOR: "KR", KWT: "KW", LAO: "LA", LBN: "LB", LBR: "LR", LBY: "LY",
  LCA: "LC", LIE: "LI", LKA: "LK", LSO: "LS", LTU: "LT", LUX: "LU", LVA: "LV", MAR: "MA", MCO: "MC",
  MDA: "MD", MDG: "MG", MDV: "MV", MEX: "MX", MHL: "MH", MKD: "MK", MLI: "ML", MLT: "MT", MMR: "MM",
  MNE: "ME", MNG: "MN", MOZ: "MZ", MRT: "MR", MUS: "MU", MWI: "MW", MYS: "MY", NAM: "NA", NER: "NE",
  NGA: "NG", NIC: "NI", NLD: "NL", NOR: "NO", NPL: "NP", NRU: "NR", NZL: "NZ", OMN: "OM", PAK: "PK",
  PAN: "PA", PER: "PE", PHL: "PH", PLW: "PW", PNG: "PG", POL: "PL", PRK: "KP", PRT: "PT", PRY: "PY",
  QAT: "QA", ROU: "RO", RUS: "RU", RWA: "RW", SAU: "SA", SDN: "SD", SEN: "SN", SGP: "SG", SLB: "SB",
  SLE: "SL", SLV: "SV", SMR: "SM", SOM: "SO", SRB: "RS", SSD: "SS", STP: "ST", SUR: "SR", SVK: "SK",
  SVN: "SI", SWE: "SE", SWZ: "SZ", SYC: "SC", SYR: "SY", TCD: "TD", TGO: "TG", THA: "TH", TJK: "TJ",
  TKM: "TM", TLS: "TL", TON: "TO", TTO: "TT", TUN: "TN", TUR: "TR", TUV: "TV", TWN: "TW", TZA: "TZ",
  UGA: "UG", UKR: "UA", URY: "UY", USA: "US", UZB: "UZ", VCT: "VC", VEN: "VE", VNM: "VN", VUT: "VU",
  WSM: "WS", YEM: "YE", ZAF: "ZA", ZMB: "ZM", ZWE: "ZW",
};

const A = "A".charCodeAt(0);
let index: Map<string, string> | null = null;

function build(): Map<string, string> {
  const ix = new Map<string, string>();
  const locales = [...new Set(["en", ...(typeof navigator !== "undefined" ? navigator.languages ?? [] : [])])];
  for (const loc of locales) {
    let dn: Intl.DisplayNames;
    try { dn = new Intl.DisplayNames([loc], { type: "region" }); } catch { continue; }
    for (let i = 0; i < 26; i += 1) {
      for (let j = 0; j < 26; j += 1) {
        const cc = String.fromCharCode(A + i, A + j);
        let name: string | undefined;
        try { name = dn.of(cc); } catch { continue; }
        // a code the platform does not know comes back as itself
        if (name && name !== cc && name.length > 3) ix.set(norm(name), cc);
      }
    }
  }
  for (const [a3, cc] of Object.entries(ALPHA3)) ix.set(norm(a3), cc);
  return ix;
}

/**
 * The country a word names, or null.
 *
 * Never from two letters — `CA` is California as often as Canada, `IN` is Indiana as often as
 * India — and never from the digits beside it: the last field of a US address is written
 * `USA 66000`, the country and the postal code in one part, and reading it whole finds nothing.
 */
export function countryCodeOf(part: string): string | null {
  const t = part.replace(/\d[\d\-/]*/g, " ").replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  if (!index) index = build();
  return index.get(norm(t)) ?? null;
}

/** Whether this part of a name is a country rather than a place inside one. */
export const isCountryWord = (part: string) => countryCodeOf(part) !== null;
