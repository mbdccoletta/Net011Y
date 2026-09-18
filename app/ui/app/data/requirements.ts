// What each view needs to be sent to Dynatrace, and whether this environment already sends it.
// Status is measured from the app's own query results, never assumed.
import type { NetworkModel } from "../model/types";
import { QUERIES } from "./queries";

export type NeedKey =
  | "devices" | "interfaces" | "traffic" | "cpu" | "availability" | "icmp" | "syslog" | "traps"
  | "lldp" | "routing" | "netflow" | "appFlows" | "wan" | "sites" | "alerts" | "assist" | "sessions";

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
  traffic: { label: "Interface traffic and errors", how: "IF-MIB octet, error, discard and CRC counters (64-bit HC counters) in the SNMP extension", queries: ["trJuniper", "trCisco", "trGeneric", "errJuniper", "errCisco", "errGeneric"] },
  cpu: { label: "Device CPU", how: "CPU metric group of the SNMP extension (network_device.cpu_usage)", queries: ["cpu"] },
  availability: { label: "Device availability", how: "sysUpTime polled by the SNMP extension every minute", queries: ["uptime"] },
  icmp: { label: "Reachability and latency", how: "Synthetic network availability monitors (ICMP) targeting device and WAN circuit IPs", queries: ["icmp", "icmpNow"] },
  syslog: { label: "Syslog", how: "Syslog extension or ActiveGate syslog ingest from each device (dt.openpipeline.source = extension:syslog)", queries: ["syslogSum", "syslogTs", "syslogRecent"] },
  traps: { label: "SNMP traps", how: "SNMP traps extension receiving traps from the devices (log.source = snmptraps)", queries: ["traps"] },
  lldp: { label: "Topology neighbours", how: "LLDP or CDP metric group of the SNMP extension", queries: ["lldp"] },
  routing: { label: "Routing peers", how: "BGP and OSPF metric groups of the SNMP extension", queries: ["routing"] },
  netflow: { label: "NetFlow / IPFIX", how: "OpenTelemetry Collector netflowreceiver sending flows with the exporter and interface index", queries: ["flowTs", "flowProto", "flowTop"] },
  appFlows: { label: "Application traffic", how: "OneAgent on application hosts with network flows enabled (bucket default_network_flows)", queries: ["cloud", "cloudTop"] },
  wan: { label: "WAN circuits and SLA", how: "One ICMP network availability monitor per circuit with primary tags site, circuit_id, circuit_role, carrier, circuit_tech and sla_ms", queries: [] },
  sites: { label: "Sites, regions and locations", how: "Primary tags on each SNMP monitoring configuration: site, site_name, site_type, region, geo_lat, geo_lon and hub", queries: [] },
  alerts: { label: "Alerts and problems", how: "Alert templates for network devices in Infrastructure & Operations, plus any custom alert on the extension metrics. Every status in this app comes from the problems they raise", queries: [] },
  sessions: { label: "User sessions", how: "Real User Monitoring on the applications people use at the sites. The app reads only how many sessions there are per hour, to tell whether a network fault reached the users", queries: ["sessions", "sessionsTypical"] },
  assist: { label: "Dynatrace Intelligence", how: "Dynatrace Assist enabled and the app permission davis-copilot:conversations:execute", queries: [] },
};

export const VIEW_NEEDS: Record<string, NeedKey[]> = {
  map: ["alerts", "devices", "sites", "wan", "icmp", "sessions", "syslog", "traps", "lldp", "appFlows", "assist"],
  sites: ["alerts", "devices", "sites", "wan", "icmp", "sessions", "appFlows", "assist"],
  devices: ["alerts", "devices", "interfaces", "traffic", "cpu", "availability", "syslog", "traps", "assist"],
  links: ["alerts", "wan", "icmp", "syslog", "assist"],
  site: ["alerts", "devices", "availability", "icmp", "wan", "sessions", "appFlows", "syslog", "assist"],
  device: ["alerts", "interfaces", "traffic", "cpu", "availability", "syslog", "traps", "lldp", "routing", "assist"],
  empty: ["devices", "alerts", "interfaces", "traffic", "cpu", "availability", "icmp", "syslog", "traps", "lldp", "routing", "netflow", "appFlows", "wan", "sites", "sessions", "assist"],
};

export function evaluateNeeds(counts: Record<string, number | null>, model: NetworkModel | null, source: "live" | "example"): Record<NeedKey, Need> {
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
          : key === "sessions" && u ? `${u.total.toLocaleString("en-US")} sessions in 24 h · ${
              u.mapped ? `${u.nets.filter((n) => n.site).length} client subnet(s) matched to a site` : "no client subnet matches a site, so the reading is environment-wide"
            }${u.anomalyWatched ? "" : " · no traffic anomaly alert is watching them"}`
          : `${rows.toLocaleString("en-US")} series/records`;
        if (key === "traffic" && status === "partial") status = "ok";
        if (key === "syslog" && status === "partial") status = "ok";
        if (key === "netflow" && status === "partial") status = "ok";
      }
    }
    out[key] = { key, label, how, status, detail };
  });
  return out;
}
