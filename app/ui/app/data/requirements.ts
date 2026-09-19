// What each view needs to be sent to Dynatrace, and whether this environment already sends it.
// Status is measured from the app's own query results, never assumed.
import type { NetworkModel } from "../model/types";
import { QUERIES } from "./queries";

/** the per-family queries of the given measures ("cpu" → "cpu:network_device", "cpu:cisco" …) */
const familyKeys = (...measures: string[]) => Object.keys(QUERIES).filter((k) => measures.some((m) => k.startsWith(`${m}:`)));

export type NeedKey =
  | "devices" | "interfaces" | "traffic" | "cpu" | "availability" | "icmp" | "syslog" | "traps"
  | "lldp" | "routing" | "netflow" | "appFlows" | "wan" | "sites" | "alerts" | "assist" | "sessions" | "requests";

export type NeedStatus = "ok" | "partial" | "missing" | "loading" | "simulated" | "manual";

export interface Need {
  key: NeedKey;
  label: string;
  how: string;
  status: NeedStatus;
  detail: string;
}

const CATALOG: Record<NeedKey, { label: string; how: string; queries?: string[] }> = {
  devices: { label: "Network devices", how: "SNMP extension (generic, Cisco, Juniper, Palo Alto or F5) monitoring each router, switch, firewall and access point", queries: ["devices"] },
  interfaces: { label: "Interfaces", how: "Interface metric group of the SNMP extension (IF-MIB ifTable / ifXTable)", queries: ["interfaces"] },
  traffic: { label: "Interface traffic and errors", how: "Interface counters (octets, errors, discards, CRC) from any Dynatrace network extension: the common network_device set, Generic Cisco, generic SNMP, Juniper, Palo Alto or F5", queries: familyKeys("ifTraffic", "ifErrors") },
  cpu: { label: "Device CPU and memory", how: "CPU and memory as each network extension reports them (network_device, Cisco CPM, Juniper routing engine, Palo Alto management plane, F5 host)", queries: familyKeys("cpu", "memory") },
  availability: { label: "Device availability", how: "sysUpTime polled by the network extension every minute (any family)", queries: familyKeys("uptime") },
  icmp: { label: "Reachability and latency", how: "Synthetic network availability monitors (ICMP) targeting device and WAN circuit IPs", queries: ["icmp", "icmpNow"] },
  syslog: { label: "Syslog", how: "Syslog extension or ActiveGate syslog ingest from each device (dt.openpipeline.source = extension:syslog)", queries: ["deviceLogs", "deviceLogsRecent"] },
  traps: { label: "SNMP traps", how: "SNMP traps extension receiving traps from the devices (log.source = snmptraps)", queries: ["deviceLogs", "deviceLogsRecent"] },
  lldp: { label: "Topology neighbours", how: "Neighbor discovery (CDP and LLDP) in SNMP autodiscovery, or the LLDP metric group of the SNMP extension. The map draws a route between two sites only where a cable between them is reported", queries: ["netEdges", "neighbors", "lldp"] },
  routing: { label: "Routing peers", how: "BGP and OSPF metric groups of the SNMP extension", queries: ["routing"] },
  netflow: { label: "NetFlow / IPFIX", how: "OpenTelemetry Collector netflowreceiver sending flows from the routers and firewalls. The exporter places each flow at a site; the site_cidr tag on each site places the far end, so the map can draw the traffic between sites", queries: ["flowNets", "flowFanIn", "flowTs"] },
  appFlows: { label: "Application traffic", how: "OneAgent on application hosts with network flows enabled (bucket default_network_flows). Their TCP retransmissions tell the fault domain reading whether the applications feel the network", queries: ["appNet", "appNetBy", "appPaths", "cloud", "cloudTop"] },
  wan: { label: "WAN circuits and SLA", how: "One ICMP network availability monitor per circuit with primary tags site, circuit_id, circuit_role, carrier, circuit_tech and sla_ms", queries: [] },
  sites: { label: "Sites, regions and locations", how: "Primary tags on each SNMP monitoring configuration: site, site_name, site_type, region, geo_lat, geo_lon, hub and site_cidr", queries: [] },
  alerts: { label: "Alerts and problems", how: "Alert templates for network devices in Infrastructure & Operations, plus any custom alert on the extension metrics. Every status in this app comes from the problems they raise", queries: [] },
  sessions: { label: "User sessions", how: "Real User Monitoring on the applications people use at the sites. The app reads only how many sessions there are per hour, to tell whether a network fault reached the users", queries: ["sessions", "sessionsTypical"] },
  requests: { label: "Service requests", how: "OneAgent on the services the sites use. Read as a count per hour only, and used in place of user sessions when an environment has no Real User Monitoring", queries: ["requests", "requestsTypical"] },
  assist: { label: "Dynatrace Intelligence", how: "Dynatrace Assist enabled and the app permission davis-copilot:conversations:execute", queries: [] },
};

export const VIEW_NEEDS: Record<string, NeedKey[]> = {
  map: ["alerts", "devices", "sites", "wan", "icmp", "sessions", "requests", "syslog", "traps", "lldp", "appFlows", "assist"],
  sites: ["alerts", "devices", "sites", "wan", "icmp", "sessions", "requests", "appFlows", "assist"],
  devices: ["alerts", "devices", "interfaces", "traffic", "cpu", "availability", "syslog", "traps", "assist"],
  links: ["alerts", "wan", "icmp", "syslog", "assist"],
  traffic: ["netflow", "appFlows", "sites", "assist"],
  site: ["alerts", "devices", "availability", "icmp", "wan", "sessions", "requests", "netflow", "appFlows", "syslog", "assist"],
  device: ["alerts", "interfaces", "traffic", "cpu", "availability", "syslog", "traps", "lldp", "routing", "assist"],
  empty: ["devices", "alerts", "interfaces", "traffic", "cpu", "availability", "icmp", "syslog", "traps", "lldp", "routing", "netflow", "appFlows", "wan", "sites", "sessions", "requests", "assist"],
};

// sources the app stops reading once found empty (see SOURCE_GROUPS): which data type each one feeds
const ABSENT_FEEDS: Partial<Record<NeedKey, string>> = { netflow: "netflow", syslog: "deviceLogs", traps: "deviceLogs", lldp: "neighbors", appFlows: "oneagentFlows" };

export function evaluateNeeds(counts: Record<string, number | null>, model: NetworkModel | null, source: "live" | "example", absent: Record<string, number | undefined> = {}): Record<NeedKey, Need> {
  const out = {} as Record<NeedKey, Need>;
  (Object.keys(CATALOG) as NeedKey[]).forEach((key) => {
    const { label, how, queries = [] } = CATALOG[key];
    let status: NeedStatus, detail: string;
    if (source === "example") { status = "simulated"; detail = "simulated in the example network"; }
    else if (key === "assist") { status = "manual"; detail = "checked when you ask Assist"; }
    else if (key === "wan") {
      const n = model?.circuits?.length ?? 0;
      status = n ? "ok" : "missing"; detail = n ? `${n} circuits` : "no ICMP monitor with circuit tags";
    } else if (key === "alerts") {
      // the app takes its status from here, so what counts is how many network entities Dynatrace is alerting on
      const devices = model?.devices.filter((d) => (d.problems ?? []).some((p) => !p.muted)).length ?? 0;
      const circuits = model?.circuits?.filter((c) => (c.problems ?? []).some((p) => !p.muted)).length ?? 0;
      const ids = new Set([
        ...(model?.devices ?? []).flatMap((d) => (d.problems ?? []).filter((p) => !p.muted).map((p) => p.eventId)),
        ...(model?.circuits ?? []).flatMap((c) => (c.problems ?? []).filter((p) => !p.muted).map((p) => p.eventId)),
      ]);
      status = !model ? "loading" : ids.size ? "ok" : "missing";
      detail = !model ? "loading" : ids.size ? `${ids.size} open problem(s) on ${devices + circuits} network element(s)` : "no alert is raising anything on your network";
    } else if (key === "sites") {
      const sites = model ? Object.values(model.sites) : [];
      const located = sites.filter((s) => s.lat != null).length, regions = sites.filter((s) => s.region).length;
      status = !sites.length ? "missing" : located === sites.length && regions === sites.length ? "ok" : located || regions ? "partial" : "missing";
      detail = sites.length ? `${located}/${sites.length} located · ${regions}/${sites.length} with region` : "no sites";
    } else {
      const values = queries.map((q) => counts[q]);
      if (values.every((v) => v === null || v === undefined)) { status = model ? "missing" : "loading"; detail = model ? "not available" : "loading"; }
      else {
        const rows = values.reduce<number>((a, v) => a + (v ?? 0), 0);
        const some = values.filter((v) => (v ?? 0) > 0).length;
        // a query that came back exactly at its cap is hiding the rest of the estate
        const capped = queries.filter((q) => QUERIES[q]?.complete && (counts[q] ?? 0) >= (QUERIES[q]?.maxResultRecords ?? Infinity));
        if (capped.length) {
          out[key] = { key, label, how, status: "partial", detail: `${rows.toLocaleString("en-US")} rows · truncated at the query limit, this environment has more` };
          return;
        }
        status = rows === 0 ? "missing" : some < values.filter((v) => v != null).length && queries.length > 1 ? "partial" : "ok";
        // the device list is deduplicated (the same device can be discovered by several configurations, and
        // a neighbour entry is not a device of its own): say so rather than silently showing fewer
        const shown = model?.devices.length ?? rows;
        const u = model?.users;
        detail = rows === 0 ? "nothing received"
          : key === "devices" ? (shown === rows ? `${shown} devices` : `${shown} devices · ${rows} nodes discovered, ${rows - shown} merged into the device they belong to`)
          // sessions are read for one purpose, so the status says whether they can answer it
          : key === "requests" && u?.requests ? `${(u.requests.now ?? 0).toLocaleString("en-US")} requests in the last hour${u.series.length ? " · sessions are the source in use" : " · the source in use, since there are no user sessions"}`
          : key === "sessions" && u ? `${u.total.toLocaleString("en-US")} sessions in 24 h · ${
              u.mapped ? `${u.nets.filter((n) => n.site).length} client subnet(s) matched to a site` : "no client subnet matches a site, so the reading is environment-wide"
            }${u.anomalyWatched ? " · a traffic anomaly problem is open" : ""}`
          : `${rows.toLocaleString("en-US")} series/records`;
        if (key === "traffic" && status === "partial") status = "ok";
        if (key === "syslog" && status === "partial") status = "ok";
        if (key === "lldp" && status === "partial") status = "ok";
        // syslog and traps share one read: each is judged by what reached the devices
        if ((key === "syslog" || key === "traps") && model) {
          const n = key === "syslog" ? model.devices.reduce((a, d) => a + d.syslog.ERROR + d.syslog.WARN + d.syslog.INFO, 0) : model.devices.reduce((a, d) => a + d.traps, 0);
          const withIt = model.devices.filter((d) => (key === "syslog" ? d.syslog.ERROR + d.syslog.WARN + d.syslog.INFO : d.traps) > 0).length;
          status = n ? "ok" : "missing";
          detail = n ? `${n.toLocaleString("en-US")} in the last 6 h from ${withIt} device${withIt === 1 ? "" : "s"}` : "nothing received from a monitored device";
        }
        if (key === "netflow" && model?.flowMap) {
          const f = model.flowMap, tied = f.exporters.filter((e) => e.device).length;
          status = tied < f.exporters.length || !f.subnetsTagged ? "partial" : "ok";
          detail = `${tied}/${f.exporters.length} exporters tied to a device · ${f.pairs.length ? `${f.pairs.length} routes between sites` : "no traffic between two sites placed yet"} · ${f.subnetsTagged ? `${f.subnetsTagged} site_cidr ranges` : "no site_cidr tag, so only device subnets place addresses"}`;
        }
        if (key === "appFlows" && model?.appNet) {
          status = "ok";
          const a = model.appNet, last = a.retrPct.length - 2;
          detail = a.source === "flows"
            ? `${a.conversations.reduce((x, y) => x + y, 0).toLocaleString("en-US")} conversations in 8 h · ${a.workloads.length} workloads · ${a.retrPct[last] ?? "?"}% of TCP packets retransmitted in the last 10 minutes`
            : `from the process network metrics (network flows are not enabled) · ${a.workloads.length} host groups · ${a.retrPct[last] ?? "?"}% of TCP packets retransmitted in the last 10 minutes`;
        }
        if (key === "lldp" && model && rows > 0) {
          const siteOf = new Map(model.devices.map((d) => [d.name, d.site]));
          const between = new Set(model.links.filter((l) => siteOf.has(l.a) && siteOf.has(l.b) && siteOf.get(l.a) !== siteOf.get(l.b)).map((l) => [siteOf.get(l.a), siteOf.get(l.b)].sort().join("|")));
          detail = `${model.links.length} port adjacencies · ${between.size ? `${between.size} between sites` : "none between two sites, so the map draws no route"}`;
        }
      }
    }
    // a source found empty is not read again for a while: say when it was checked, not "loading"
    const since = ABSENT_FEEDS[key] ? absent[ABSENT_FEEDS[key]!] : undefined;
    if (since != null && status !== "ok" && status !== "partial") {
      const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
      status = "missing";
      detail = `nothing found at ${clock(since)} UTC · read again after ${clock(since + 12 * 3600000)} UTC, or with Check again`;
    }
    out[key] = { key, label, how, status, detail };
  });
  return out;
}
