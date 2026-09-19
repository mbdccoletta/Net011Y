// How much of each page this environment can fill, from the data that arrives. The same measure the
// three-environment comparison used: every page is built on some data, and 1 means all of it arrives.
// It drives the navigation (a page with nothing to show says so before it is opened) and the empty states.
import type { NetworkModel } from "./types";

export type PageKey = "causes" | "sites" | "devices" | "links" | "traffic";

const share = (x: number, of: number) => (of ? Math.min(1, x / of) : 0);

export function pageCoverage(model: NetworkModel | null): Record<PageKey, number> {
  if (!model) return { causes: 0, sites: 0, devices: 0, links: 0, traffic: 0 };
  if (model.demo) return { causes: 1, sites: 1, devices: 1, links: 1, traffic: 1 };
  const devs = model.devices;
  const n = devs.length;
  const sites = Object.values(model.sites);
  const exact = sites.filter((s) => s.lat != null && !s.approx).length, placed = sites.filter((s) => s.lat != null).length;
  const devices = n ? (share(devs.filter((d) => d.cpuNow != null).length, n) + share(devs.filter((d) => d.memNow != null).length, n)
    + share(devs.filter((d) => d.availPct != null).length, n) + (devs.some((d) => d.interfaces.some((i) => i.in.length)) ? 1 : 0)) / 4 : 0;
  const sitesPct = sites.length ? share(exact, sites.length) * 0.5 + share(placed, sites.length) * 0.2 + share(sites.filter((s) => s.region).length, sites.length) * 0.3 : 0;
  const alerting = n ? share(devs.filter((d) => d.availPct != null).length, n) : 0;
  const u = model.users;
  const fault = (u ? 0.4 : 0) + (model.appNet ? (model.appNet.source === "flows" ? 0.3 : 0.2) : 0) + (n ? 0.2 : 0) + (u?.mapped ? 0.1 : 0);
  const f = model.flowMap;
  const traffic = (f ? 0.4 : 0) + ((f?.pairs.length ?? 0) ? 0.2 : 0) + ((model.paths?.length ?? 0) ? 0.25 : 0) + ((model.paths ?? []).some((p) => p.remoteSite) ? 0.15 : 0);
  return {
    causes: (sitesPct + alerting + fault) / 3,
    sites: sitesPct,
    devices,
    // circuits with their carrier and SLA fill the page; untagged monitors already give reachability per site
    links: (model.circuits?.length ?? 0) > 0 ? 1 : devs.some((d) => d.icmp) ? 0.5 : 0,
    traffic,
  };
}
