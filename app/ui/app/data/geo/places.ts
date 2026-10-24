/**
 * Placing a site that nobody tagged, anywhere in the world.
 *
 * An estate that has not been through a tagging exercise still says where its sites are: the name
 * is `100 Example Road, Fairview, KS, USA 66000`, or `SDC:A000.00:200 Example
 * Parkway:Brookfield:NC:27000`, or sysLocation reads `Gdansk (Data Center)`. The app used to read exactly one country
 * out of that — a table of 27 Brazilian states, written by hand — and a US estate opened on a
 * schematic with two of three map layouts switched off and nothing saying why.
 *
 * The centre of every admin-1 region on earth is now read instead, from the same Natural Earth
 * data the Regions view draws its outlines from. A site placed this way is marked `approx: "state"`
 * and says so on its own page: it is the centre of a state, not a building, and the point of it is
 * that a reader sees their estate on a map on the first open rather than after a tagging project.
 *
 * Two rules keep it honest:
 *
 *  - A region code is not unique. Of the 562 two-letter codes in the table, 404 belong to more than
 *    one country: `KS` is Kansas and Kassala, `SP` is São Paulo and Sant Pere. A code is only
 *    resolved when the estate says which country it is in — a country word in the same name, the
 *    country in a device naming convention, or the countries the already-placed sites fall in. With
 *    no anchor, or with an anchor that leaves two candidates, the site stays unplaced. A site in
 *    the wrong hemisphere is worse than a site that is honestly missing.
 *  - The table is fetched, not bundled: a dynamic import, started only when a site needs it. An
 *    estate that tags its coordinates never pays for it.
 */
import type { Centroid } from "./admin1/centroids";

type Table = Record<string, Centroid[]>;

let table: Table | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Start loading the centre of every region, once. Safe to call on every build. */
export function ensurePlaces(): Promise<void> {
  if (table) return Promise.resolve();
  if (!loading) {
    loading = import("./admin1/centroids")
      // the country index is built from the countries in the table, so an index built before it
      // arrived holds only the three-letter codes: the first model is built before the fetch
      // returns, it asks for a country, and a memoised empty answer would outlive the table
      .then((m) => { table = m.default; countryNames = null; version += 1; listeners.forEach((f) => f()); })
      // a table that will not load costs the approximate placement and nothing else
      .catch(() => { version += 1; listeners.forEach((f) => f()); });
  }
  return loading;
}

/** Changes once when the table arrives, so a model built without it is built again with it. */
export const placesVersion = () => version;
export const subscribePlaces = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); } };
export const placesReady = () => table !== null;
/** The suite builds a model synchronously; this lets it wait for the table first. */
export const loadedPlaces = () => table;

// ---------------------------------------------------------------- countries

/**
 * A country word to its code, in English and in the reader's own language.
 *
 * `Intl.DisplayNames` already holds every country name the platform knows, so none is written here:
 * a Brazilian reader's `Alemanha` and an English one's `Germany` both reach DE without this file
 * carrying either word.
 */
let countryNames: Map<string, string> | null = null;
function countryIndex(): Map<string, string> {
  if (countryNames) return countryNames;
  const ix = new Map<string, string>();
  const put = (name: string | undefined, cc: string) => { if (name && name.length > 3) ix.set(norm(name), cc); };
  const locales = [...new Set(["en", ...(typeof navigator !== "undefined" ? navigator.languages ?? [] : [])])];
  for (const loc of locales) {
    let dn: Intl.DisplayNames;
    try { dn = new Intl.DisplayNames([loc], { type: "region" }); } catch { continue; }
    for (const cc of Object.keys(table ?? {})) {
      try { put(dn.of(cc), cc); } catch { /* not a region this runtime knows */ }
    }
  }
  // Three-letter codes are written in site names as often as the word is, and no runtime maps them.
  for (const [a3, cc] of Object.entries(ALPHA3)) ix.set(a3.toLowerCase(), cc);
  countryNames = ix;
  return ix;
}

/** ISO 3166-1 alpha-3 for the countries an enterprise estate is most often spread across. */
const ALPHA3: Record<string, string> = {
  USA: "US", CAN: "CA", MEX: "MX", BRA: "BR", ARG: "AR", CHL: "CL", COL: "CO", PER: "PE", URY: "UY",
  GBR: "GB", IRL: "IE", FRA: "FR", DEU: "DE", NLD: "NL", BEL: "BE", LUX: "LU", CHE: "CH", AUT: "AT",
  ESP: "ES", PRT: "PT", ITA: "IT", GRC: "GR", POL: "PL", CZE: "CZ", SVK: "SK", HUN: "HU", ROU: "RO",
  BGR: "BG", HRV: "HR", SVN: "SI", SRB: "RS", UKR: "UA", RUS: "RU", TUR: "TR", DNK: "DK", SWE: "SE",
  NOR: "NO", FIN: "FI", ISL: "IS", EST: "EE", LVA: "LV", LTU: "LT", ISR: "IL", ARE: "AE", SAU: "SA",
  QAT: "QA", KWT: "KW", EGY: "EG", ZAF: "ZA", NGA: "NG", KEN: "KE", MAR: "MA", IND: "IN", PAK: "PK",
  CHN: "CN", HKG: "HK", TWN: "TW", JPN: "JP", KOR: "KR", SGP: "SG", MYS: "MY", THA: "TH", VNM: "VN",
  PHL: "PH", IDN: "ID", AUS: "AU", NZL: "NZ",
};

/** Diacritics out, case down: `São Paulo` and `Sao Paulo` are the same place. */
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * The country a part of a name states, if it states one.
 *
 * Never from two letters — `CA` is California as often as Canada — and never from the digits beside
 * it: the last field of a US address is written `USA 66000`, which is the country and the postal
 * code in one part, and reading it whole found no country at all.
 */
export function countryOf(part: string): string | null {
  const t = part.replace(/\d[\d\-/]*/g, " ").replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  return countryIndex().get(norm(t)) ?? null;
}

// ---------------------------------------------------------------- regions

export interface Placed { lat: number; lon: number; region: string; cc: string; code: string }

/**
 * The region a token names, within the countries the estate is known to be in.
 *
 * Matched on the code (`KS`) and on the name (`Kansas`, `Baviera`), and answered only when the
 * candidates agree on one region. `anchors` empty means nothing is known about the country, and
 * nothing is guessed.
 */
export function regionOf(token: string, anchors: Iterable<string>): Placed | null {
  if (!table) return null;
  const t = token.trim();
  if (t.length < 2) return null;
  const code = t.toUpperCase(), name = norm(t);
  const hits: Placed[] = [];
  for (const cc of new Set(anchors)) {
    for (const [rc, rn, lat, lon] of table[cc] ?? []) {
      if (rc === code || norm(rn) === name) hits.push({ lat, lon, region: rn, cc, code: rc });
    }
  }
  // one region, or several rows of the same one (a country that lists a code twice): otherwise the
  // token belongs to two places and the site is left where it was
  const first = hits[0];
  return first && hits.every((h) => h.cc === first.cc && h.code === first.code) ? first : null;
}

/** Every country the table knows, for an estate that names no country at all. */
export const knownCountries = (): string[] => Object.keys(table ?? {});
