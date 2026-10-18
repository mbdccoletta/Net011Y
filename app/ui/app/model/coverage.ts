// How much of each page this environment can fill, from the data that arrives. The same measure the
// three-environment comparison used: every page is built on some data, and 1 means all of it arrives.
// It drives the navigation (a page with nothing to show says so before it is opened) and the empty states.
import type { NetworkModel } from "./types";

export type PageKey = "causes" | "sites" | "devices" | "links" | "traffic" | "ahead";

const share = (x: number, of: number) => (of ? Math.min(1, x / of) : 0);

/**
 * `unread` are the queries no open view has asked for yet. A page built on one of them has a coverage
 * nobody has measured, and that is null, not zero: zero is what the navigation shows as "nothing to
 * show yet in this environment", which of a page that was simply never read is not true.
 */
export function pageCoverage(model: NetworkModel | null, unread: readonly string[] = []): Record<PageKey, number | null> {
  if (!model) return { causes: 0, sites: 0, devices: 0, links: 0, traffic: 0, ahead: 0 };
  if (model.demo) return { causes: 1, sites: 1, devices: 1, links: 1, traffic: 1, ahead: 1 };
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
  // Ahead needs a fortnight of hourly record, and a port needs a published line rate before traffic
  // can be a percentage of anything. Half the interfaces in a real estate publish none, so the
  // coverage is what fraction of devices arrived with either series rather than whether any did.
  //
  // Those two reads belong to the Ahead view alone, so on every other page they have not happened
  // and both filters find nothing. Reported as a number that would be zero — which the navigation
  // shows as "nothing to show yet in this environment", a claim about the environment made from
  // a query nobody asked for. Unmeasured is null, exactly as the rule above this function says.
  /**
   * Unmeasured means nothing arrived, not that something is missing.
   *
   * The old test was "any hourly read is unread", which was safe while those reads only ran on
   * the Ahead page: elsewhere none of them had happened and the page rightly claimed nothing.
   * Now that every page is read from the start, the same test fires on a single failure — and
   * `ifHourly:f5` does fail on this environment, which is how it was found. One family of
   * several erroring while the rest fill the page with a fortnight of record is not grounds to
   * say nothing was measured. So: say nothing only when there is nothing *and* a read is
   * missing. Everything arrived and still nothing there is a real zero, and keeps saying so.
   */
  /**
   * Each half answers for itself, because they no longer arrive together.
   *
   * The processors' fortnight runs on every page; the ports' fortnight is the heaviest read
   * in the app and now waits for Ahead, the page that draws it. Averaged as one, that made
   * the figure fall by half everywhere else — a number about the environment moving with
   * the page the reader is on. A half nobody has read yet is unmeasured, not zero; a half
   * that arrived empty is a real zero and still says so.
   */
  const half = (got: (d: typeof devs[number]) => boolean, prefix: string) => {
    if (devs.some(got)) return share(devs.filter(got).length, n);
    return unread.some((q) => q.startsWith(prefix)) ? null : share(0, n);
  };
  const parts = [half((d) => !!d.cpuHourly?.length, "cpuHourly:"),
    half((d) => d.interfaces.some((i) => i.hourly?.length), "ifHourly:")]
    .filter((v): v is number => v != null);
  const ahead = !n ? 0 : parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return {
    causes: (sitesPct + alerting + fault) / 3,
    sites: sitesPct,
    devices,
    ahead,
    // circuits with their carrier and SLA fill the page; untagged monitors already give reachability per site
    links: (model.circuits?.length ?? 0) > 0 ? 1 : devs.some((d) => d.icmp) ? 0.5 : 0,
    traffic: unread.includes("flowNets") && !model.paths?.length ? null : traffic,
  };
}
