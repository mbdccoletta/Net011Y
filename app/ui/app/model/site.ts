// Site-level reading of the model: one answer to "how is this site and why",
// reused by the overview, the site list and the site page so they never disagree.
import type { Circuit, Device, E2EPath, Hop, NetworkModel, Site, Verdict } from "./types";
import { ORDER, worst, isBad } from "./verdict";
import { stripDevice } from "../utils/format";

export const ROLE_LABEL: Record<string, string> = {
  core: "Core", edge: "Edge router", firewall: "Firewall", lb: "Load balancer", switch: "Switch", compute: "Compute",
  wlc: "Wireless controller", ap: "Access point", endpoint: "Endpoint", other: "Other",
};
export const ROLE_LAYER: Record<string, string> = {
  core: "Core", edge: "Edge", firewall: "Security", lb: "Security", switch: "Access", compute: "Access", wlc: "Access", ap: "Access", endpoint: "Access", other: "Access",
};

/**
 * Devices, circuits and paths by site, built once per model: an estate of 20,000 devices and 4,000 sites
 * would otherwise scan every device once per site.
 */
interface SiteIndex { devices: Map<string, Device[]>; circuits: Map<string, Circuit[]>; bySite: Map<string, E2EPath>; byStart: Map<string, E2EPath> }
const INDEX = new WeakMap<NetworkModel, SiteIndex>();
function indexOf(m: NetworkModel): SiteIndex {
  let ix = INDEX.get(m);
  if (ix) return ix;
  ix = { devices: new Map(), circuits: new Map(), bySite: new Map(), byStart: new Map() };
  for (const d of m.devices) { const l = ix.devices.get(d.site); if (l) l.push(d); else ix.devices.set(d.site, [d]); }
  for (const c of m.circuits ?? []) { const l = ix.circuits.get(c.site); if (l) l.push(c); else ix.circuits.set(c.site, [c]); }
  // the first path for a site wins, as a scan in order would find it
  for (const p of m.e2e.paths) {
    if (p.site && !ix.bySite.has(p.site)) ix.bySite.set(p.site, p);
    const start = p.hops[0]?.site;
    if (start && !ix.byStart.has(start)) ix.byStart.set(start, p);
  }
  INDEX.set(m, ix);
  return ix;
}
export const devicesAt = (m: NetworkModel, code: string): Device[] => indexOf(m).devices.get(code) ?? [];

/** A path belongs to a site when it was generated for it, or when it starts there. */
export const ownsPath = (p: E2EPath | null | undefined, code: string): p is E2EPath =>
  !!p && (p.site === code || (!p.site && p.hops[0]?.site === code));

export const pathOf = (m: NetworkModel, code: string) => {
  const ix = indexOf(m);
  return ix.bySite.get(code) ?? ix.byStart.get(code) ?? null;
};

export const siteVerdict = (m: NetworkModel, code: string): Verdict =>
  m.siteVerdicts?.[code] ?? worst(devicesAt(m, code).filter((d) => d.verdict !== "Not monitored").map((d) => d.verdict));

/**
 * The name to write on a map, for an estate whose site names are postal addresses.
 *
 * `site_name` is whatever the team tagged, and in a real estate that is often the mailing address of
 * the building — `100 Example Road, Fairview, KS, USA 66000` — or a facility code with the address
 * inside it — `SDC:A000.00:200 Example Parkway:Brookfield:NC:27000`. Written in full on a canvas
 * those are three hundred pixels of text each: the labels collide, the collision pass drops most of
 * them, and the few that survive read as a column of addresses rather than as a map.
 *
 * At map scale the city identifies the site and the street does not, so an address is cut to the
 * city and the region that follow it. Nothing else is touched. A name that is a name — `Durham DC`,
 * `São Paulo, BR` — comes back as it was, because a name the team chose says more than anything
 * this could derive from it, and the full string stays on the hover and on the site page.
 */
// A part of an address, by what it is: the ones that place the site are kept and the rest go.
const POSTAL = /^\d{4,6}(-\d{3,4})?$|^[A-Z]\d[A-Z] ?\d[A-Z]\d$/;
// Three letters and up, never two: `CA`, `IN`, `DE`, `SC` and `MS` are state codes as well as
// country codes, and reading them as countries would drop the state from `Sacramento, CA` while
// keeping it on `Fairview, KS` — the same estate labelled two different ways. A two-letter token is
// a region here, and `London, UK` is then a name with a comma in it, which is left alone.
const COUNTRY = /^(USA|U\.?S\.?A\.?|GBR|CAN|CANADA|MEX|MEXICO|BRA|BRASIL|BRAZIL|DEU|GERMANY|DEUTSCHLAND|FRA|FRANCE|ESP|SPAIN|ITA|ITALY|NLD|NETHERLANDS|IND|INDIA|CHN|CHINA|JPN|JAPAN|AUS|AUSTRALIA|SGP|SINGAPORE|IRL|IRELAND|POL|POLAND|SWE|SWEDEN|CHE|SWITZERLAND|AUT|AUSTRIA)$/i;
const STREET = /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|place|ter|terrace|cir|circle|sq|square|suite|ste|floor|fl|unit|bldg|building|rua|av|avenida|alameda|estrada|rodovia|praca|praça|strasse|straße|str|weg|platz|calle|avenida|carrera)\b\.?/i;
/** A two-letter state, province or prefecture code: the token a city is named against. */
const REGION = /^[A-Z]{2}$/;
/** A facility or room code: upper case with a digit in it, or three to six upper-case letters. */
const CODE = /^(?=[A-Z0-9.\-/]*\d)[A-Z0-9.\-/]{2,12}$|^[A-Z]{3,6}$/;

/** The part with its digits taken out, so `USA 66000` can be read as the country it is. */
const withoutNumbers = (part: string) => part.replace(/\d[\d\-/]*/g, " ").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

/**
 * A site name broken into the fields it is written in.
 *
 * A colon-delimited facility string has three or more parts; everything else reads as commas. Both
 * the map label and the approximate placement read a name this way, so they agree on what the
 * parts of it are.
 */
export const addressParts = (name: string | null | undefined): string[] => {
  const raw = (name ?? "").trim();
  return (raw.split(":").length >= 3 ? raw.split(":") : raw.split(",")).map((p) => p.trim()).filter(Boolean);
};

export function shortSiteName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return raw;
  const parts = addressParts(raw);
  if (parts.length < 2) return raw;
  const postal = (p: string) => POSTAL.test(p);
  const country = (p: string) => COUNTRY.test(withoutNumbers(p).replace(/\./g, ""));
  const street = (p: string) => /\d/.test(p) && STREET.test(p);
  const region = (p: string) => REGION.test(p);
  // Only an address is shortened. Without a postal code, a street or a country in it, the name is
  // just a name with a comma in it and the team's own words are what goes on the map.
  if (!parts.some((p) => postal(p) || street(p) || country(p))) return raw;
  const kept = parts.filter((p) => !postal(p) && !country(p) && !street(p) && (region(p) || !CODE.test(p)));
  if (!kept.length) return raw;
  const i = kept.map(region).lastIndexOf(true);
  if (i > 0) return `${kept[i - 1]}, ${kept[i]}`;
  if (i === 0) return kept[0];
  return kept.slice(-2).join(", ");
}

export interface SiteInfo {
  code: string;
  site: Site;
  verdict: Verdict;
  path: E2EPath | null;
  devices: Device[];
  circuits: Circuit[];
  cause: string | null;
  causeHop: Hop | null;
  causeHopIndex: number | null;
  causeDevice: Device | null;
  causeLayer: string | null;
  incident: string | null;
}

export function siteInfo(m: NetworkModel, code: string): SiteInfo {
  const site = m.sites[code];
  const verdict = siteVerdict(m, code);
  const path = pathOf(m, code);
  const devices = devicesAt(m, code);
  const out: SiteInfo = {
    code, site, verdict, path, devices, circuits: indexOf(m).circuits.get(code) ?? [],
    cause: null, causeHop: null, causeHopIndex: null, causeDevice: null, causeLayer: null, incident: null,
  };
  if (!isBad(verdict)) return out;
  if (ownsPath(path, code) && path.summary.firstBad != null) {
    const h = path.hops[path.summary.firstBad];
    return { ...out, causeHop: h, causeHopIndex: path.summary.firstBad, causeLayer: h.layer, incident: path.summary.incident,
      cause: `${h.title}: ${stripDevice(h.topReason || h.headline.label)}` };
  }
  const d = devices.filter((x) => x.verdict === verdict).sort((a, b) => b.impact - a.impact)[0];
  return d ? { ...out, causeDevice: d, causeLayer: ROLE_LAYER[d.role] ?? "Access", cause: `${d.name}: ${d.reasons[0]?.text ?? ""}`, incident: d.incident ?? null } : out;
}

export const allSites = (m: NetworkModel): SiteInfo[] =>
  Object.keys(m.sites).map((c) => siteInfo(m, c))
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || Number(!!b.site.dc) - Number(!!a.site.dc) || a.site.name.localeCompare(b.site.name));

/** Layers in the order they appear along the paths (Access → … → Application). */
export function layerOrder(m: NetworkModel): string[] {
  const order: string[] = [];
  m.e2e.paths.forEach((p) => p.hops.forEach((h) => { if (!order.includes(h.layer)) order.push(h.layer); }));
  return order;
}

export interface LayerCell {
  verdict: Verdict;
  cause: boolean;
  consequence: boolean;
  hops: Hop[];
}

/** Per site and layer: worst verdict, and whether that layer holds the probable cause or only a consequence. */
export function siteLayerState(info: SiteInfo, layers: string[]): (LayerCell | null)[] {
  const p = ownsPath(info.path, info.code) ? info.path : null;
  return layers.map((layer) => {
    if (!p) return null;
    const idx = p.hops.map((h, k) => (h.layer === layer ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) return null;
    const hops = idx.map((k) => p.hops[k]);
    const verdict = worst(hops.map((h) => h.verdict));
    const cause = isBad(verdict) && idx.includes(p.summary.firstBad ?? -1);
    return { verdict, cause, consequence: isBad(verdict) && !cause && hops.every((h) => h.consequenceOnly || !isBad(h.verdict)), hops };
  });
}
