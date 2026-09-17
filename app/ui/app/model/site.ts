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

/** A path belongs to a site when it was generated for it, or when it starts there. */
export const ownsPath = (p: E2EPath | null | undefined, code: string): p is E2EPath =>
  !!p && (p.site === code || (!p.site && p.hops[0]?.site === code));

export const pathOf = (m: NetworkModel, code: string) =>
  m.e2e.paths.find((p) => p.site === code) ?? m.e2e.paths.find((p) => p.hops[0]?.site === code) ?? null;

export const siteVerdict = (m: NetworkModel, code: string): Verdict =>
  m.siteVerdicts?.[code] ?? worst(m.devices.filter((d) => d.site === code && d.verdict !== "Not monitored").map((d) => d.verdict));

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
  const devices = m.devices.filter((d) => d.site === code);
  const out: SiteInfo = {
    code, site, verdict, path, devices, circuits: (m.circuits ?? []).filter((c) => c.site === code),
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
