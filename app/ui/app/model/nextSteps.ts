// What to do next to get more out of the app, in this environment. Every step is measured on the data
// the environment sends today, says what it unlocks with this environment's own numbers, and points at
// the Settings entry that explains it. The app always shows the best it can with what arrives; these
// steps are how an environment gets from there to everything the app can show.
import type { NetworkModel } from "./types";
import type { Need, NeedKey } from "../data/requirements";

export interface Step {
  id: string;
  /** the Settings entry that explains how */
  need: NeedKey;
  title: string;
  /** what it unlocks, in this environment's numbers */
  unlocks: string;
  done: boolean;
  /** order of value: the first pending step is the one to take next */
  impact: number;
  /** how far along it is, 0 to 1, where the step is a count (devices polled, sites tagged) */
  progress?: number;
}

export function nextSteps(model: NetworkModel | null, needs: Record<NeedKey, Need>, { all = false }: { all?: boolean } = {}): Step[] {
  if (!model || model.demo) return [];
  const steps: Step[] = [];
  const add = (s: Step) => steps.push(s);
  const devs = model.devices;
  const polled = devs.filter((d) => d.cpuNow != null || d.availPct != null || d.interfaces.some((i) => i.in.length));
  const discovered = devs.length - polled.length;
  const sites = Object.values(model.sites);
  const ok = (k: NeedKey) => needs[k]?.status === "ok";

  add(devs.length
    ? { id: "poll", need: "devices", impact: 100, done: discovered === 0, progress: polled.length / devs.length,
      title: "Poll every discovered device with its extension",
      unlocks: discovered ? `${discovered} of ${devs.length} devices are only discovered: CPU, memory, ports, availability and alerts arrive once their vendor extension (or the generic one) polls them` : `all ${devs.length} devices are polled` }
    : { id: "discover", need: "devices", impact: 110, done: false,
      title: "Discover the network with SNMP autodiscovery",
      unlocks: "no network device reaches this environment yet: every page of the app starts from the devices" });

  // alerting is what turns a device red here: a week of polled devices without a single problem means
  // nothing watches them, and the whole app stays green whatever happens
  const al = model.alerting;
  if (al && polled.length) {
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const templates = "The network templates in Infrastructure & Operations cover saturation, errors, drops, flapping and devices going down";
    // one kind of alert on one device is a custom alert someone made, not the network being watched
    const broad = al.problems > 0 && (al.kinds.length > 1 || al.devices > 1);
    add({ id: "alerting", need: "alerts", impact: 90, done: broad, progress: al.problems > 0 ? 0.5 : 0,
      title: "Turn on the network alert templates",
      unlocks: broad
        ? `${plural(al.problems, "network problem")} on ${plural(al.devices, "device")} in ${al.days} days${al.kinds.length ? ` (${al.kinds.slice(0, 3).join(", ")}${al.kinds.length > 3 ? "…" : ""})` : ""}`
        : al.problems > 0
          ? `in ${al.days} days only one alert fired on the network (${al.kinds[0] ?? "a custom alert"}, on ${plural(al.devices, "device")} of ${polled.length} polled): the rest of the devices are not watched and stay green whatever happens. ${templates}`
          : `${plural(polled.length, "polled device")} raised no alert in ${al.days} days: Dynatrace alerts only on what an alert template or custom alert watches, so until one does every device here stays green, whatever happens. ${templates}` });
  }

  const untagged = sites.filter((s) => !s.region || s.lat == null || s.approx);
  add({ id: "sites", need: "sites", impact: 80, done: sites.length > 0 && untagged.length === 0, progress: sites.length ? (sites.length - untagged.length) / sites.length : 0,
    title: "Tag each site: name, region and coordinates",
    unlocks: sites.length ? `${untagged.length} of ${sites.length} sites have no exact position or region: the map, the regions and the site hierarchy then show every site where it is` : "sites appear on the map once devices carry site tags" });

  const monitors = model.devices.filter((d) => d.icmp).length;
  add({ id: "wan", need: "wan", impact: 75, done: (model.circuits?.length ?? 0) > 0,
    title: "Tag the ICMP monitor of each WAN circuit",
    unlocks: (model.circuits?.length ?? 0) > 0 ? `${model.circuits!.length} circuits known`
      : monitors || needs.icmp?.status === "ok" ? "ICMP monitors run but none says which circuit it watches: with circuit_id, carrier and sla_ms the WAN links page, carrier SLAs and link-down causes appear"
      : "an ICMP monitor per circuit, tagged with circuit_id, carrier and sla_ms, gives the WAN links page and carrier SLAs" });

  const u = model.users;
  const unplacedSessions = u && u.total > 0 && !u.mapped;
  const tagged = model.flowMap?.subnetsTagged ?? 0;
  add({ id: "cidr", need: "sites", impact: 60, done: tagged > 0 || (!!u && u.mapped > 0),
    title: "Tag each site's address ranges (site_cidr)",
    unlocks: unplacedSessions ? `${u!.total.toLocaleString("en-US")} user sessions, and the flows and application paths, are counted for the whole environment until the ranges say which site they come from` : "user sessions, flows and application paths are then counted per site" });

  add({ id: "neighbors", need: "lldp", impact: 55, done: model.links.length > 0,
    title: "Turn on neighbour discovery (CDP / LLDP)",
    unlocks: model.links.length ? `${model.links.length} adjacencies known` : "the cabling between devices, and the routes between sites on the map, come from the neighbours the devices report" });

  add({ id: "syslog", need: "syslog", impact: 50, done: ok("syslog"),
    title: "Send device syslog to the ActiveGate",
    unlocks: "device events, the evidence behind each cause, and the syslog line of the device timeline" });
  add({ id: "traps", need: "traps", impact: 40, done: ok("traps"),
    title: "Install the SNMP Traps extension",
    unlocks: "link-down and BGP transitions as they happen, not at the next poll" });

  add({ id: "oneagent", need: "appFlows", impact: 35, done: model.appNet?.source === "flows",
    title: model.appNet ? "Turn on OneAgent network connection monitoring" : "Monitor the application hosts with OneAgent",
    unlocks: model.appNet ? "the quality of each path between an application and a site (round trip, retransmissions, resets), not only the environment total" : "whether the applications feel the network, for the fault domain reading" });

  add({ id: "netflow", need: "netflow", impact: 30, done: ok("netflow") || needs.netflow?.status === "partial",
    title: "Send NetFlow / IPFIX through the OpenTelemetry Collector",
    unlocks: "the traffic journey, who talks to whom between sites, and who fills a busy port" });

  add({ id: "demand", need: "sessions", impact: 20, done: !!u,
    title: "Count user sessions or service requests",
    unlocks: "whether a network fault reached the people using the applications" });

  // with no device yet, the steps that build on devices (sites, circuits, neighbours, syslog, traps, ranges)
  // wait for the first one: listing them now would only bury the one that matters
  const onDevices = new Set(["alerting", "sites", "wan", "cidr", "neighbors", "syslog", "traps"]);
  return steps.filter((s) => all || devs.length > 0 || !onDevices.has(s.id)).sort((a, b) => Number(a.done) - Number(b.done) || b.impact - a.impact);
}

/** Share of the steps taken, weighted by what each unlocks: pass the full list (nextSteps with all). */
export const coverage = (steps: Step[]) => {
  const total = steps.reduce((a, s) => a + s.impact, 0);
  return total ? Math.round((100 * steps.reduce((a, s) => a + s.impact * (s.done ? 1 : s.progress ?? 0), 0)) / total) : 0;
};
