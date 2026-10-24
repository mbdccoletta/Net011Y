/**
 * Placing a site that nobody tagged, anywhere in the world.
 *
 * An estate that has not been through a tagging exercise still says where its sites are: the name
 * is `100 Example Road, Fairview, KS, USA 66000`, or `SDC:A000.00:200 Example
 * Parkway:Brookfield:NC:27000`, or sysLocation reads `Gdansk (Data Center)`. The app used to read exactly one country
 * out of that: one country's states, written by hand. Every estate outside that one country
 * opened on a schematic with two of the three map layouts switched off and nothing saying why.
 *
 * The centre of every admin-1 region on earth is now read instead, from the same Natural Earth
 * data the Regions view draws its outlines from. A site placed this way is marked `approx: "state"`
 * and says so on its own page: it is the centre of a state, not a building, and the point of it is
 * that a reader sees their estate on a map on the first open rather than after a tagging project.
 *
 * Two rules keep it honest:
 *
 *  - A region code is not unique. Of the 562 two-letter codes in the table, 404 belong to more than
 *    one country: `KS` is both Kansas and Kassala, `NC` both North Carolina and Northern Cape.
 *    A code is only resolved when the estate says which country it is in — a country word in the same name, the
 *    country in a device naming convention, or the countries the already-placed sites fall in. With
 *    no anchor, or with an anchor that leaves two candidates, the site stays unplaced. A site in
 *    the wrong hemisphere is worse than a site that is honestly missing.
 *  - The table is fetched, not bundled: a dynamic import, started only when a site needs it. An
 *    estate that tags its coordinates never pays for it.
 */
import { norm } from "../utils/countries";
import type { Centroid } from "./geo/admin1/centroids";

type Table = Record<string, Centroid[]>;

let table: Table | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Start loading the centre of every region, once. Safe to call on every build. */
export function ensurePlaces(): Promise<void> {
  if (table) return Promise.resolve();
  if (!loading) {
    loading = import("./geo/admin1/centroids")
      .then((m) => { table = m.default; version += 1; listeners.forEach((f) => f()); })
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
 * The country a part of a name states, if it states one.
 *
 * Asked of the platform, not of a list in this repository: see utils/countries. Re-exported so a
 * caller placing a site reads the country and the region from the same module.
 */
export { countryCodeOf as countryOf, norm } from "../utils/countries";

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
