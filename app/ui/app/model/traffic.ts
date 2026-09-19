// Findings on traffic, stated as measurements: the screen and Assist read the same sentences. Each one
// says what the data shows and what it could mean, never a verdict — flows show volume and pattern, not
// intent, and a steady number is a condition the operator knows better than the app.
import type { AppPath, Conversation, Device, FlowFanIn, FlowMap, NetworkModel, SiteTraffic } from "./types";
import { fmtInt } from "../utils/format";

/** A workload retransmitting at least this share of its TCP packets is losing packets all the time. */
export const CHRONIC_RETR_PCT = 2;

/** A port this busy is worth explaining with the conversations the exporter saw on it. */
export const BUSY_PORT_PCT = 80;
/** A path this many times slower than the same workload's other paths for the same service stands out. */
export const SLOW_PATH_FACTOR = 3;
/** Retransmissions on one path, with enough packets to be more than noise. */
export const PATH_RETR_PCT = 2;
export const PATH_MIN_PACKETS = 1000;

export interface TrafficFinding {
  kind: "fan-in" | "exporter-silent" | "dominant-app" | "unplaced" | "chronic-retransmission" | "unplaced-device" | "busy-port" | "slow-path" | "lossy-path" | "resets";
  text: string;
  site?: string;
}

const fanInText = (f: FlowFanIn) =>
  `${fmtInt(f.sources)} distinct Internet sources reached ${f.hosts > 1 ? `${fmtInt(f.hosts)} hosts in ${f.dst}` : f.dst.replace("/24", "")} on port ${f.port} within the hour — a scan, a flood, or a very popular service`;
const pct = (v: number) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(1)}%`;

const bytesTxt = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const endTxt = (kind: Conversation["fromKind"], label: string, net: string, site: string | undefined, model: NetworkModel) =>
  kind === "site" ? model.sites[site!]?.name ?? label : kind === "internet" ? "the Internet" : `${net}/24`;

/** What the exporter saw on one port of one device in the last hour, heaviest first, with each one's share. */
export function portUsers(model: NetworkModel, device: Device, port: string) {
  const f = model.flowMap;
  if (!f) return [];
  const on = f.conversations.filter((c) => c.viaName === device.name && (c.inIf === port || c.outIf === port));
  const total = on.reduce((a, c) => a + c.bytes, 0);
  const groups = new Map<string, { from: string; to: string; app: string; bytes: number; flows: number }>();
  on.forEach((c) => {
    const from = endTxt(c.fromKind, c.fromLabel, c.s24, c.fromSite, model), to = endTxt(c.toKind, c.toLabel, c.d24, c.toSite, model);
    const k = `${from}|${to}|${c.app}`;
    const g = groups.get(k) ?? { from, to, app: c.app, bytes: 0, flows: 0 };
    g.bytes += c.bytes; g.flows += c.count; groups.set(k, g);
  });
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((g) => ({ ...g, share: total ? Math.round((100 * g.bytes) / total) : 0 }));
}

/** Paths that stand out: slow against the workload's other paths for the same service, losing packets, or reset. */
export function pathFindings(model: NetworkModel): TrafficFinding[] {
  const paths = model.paths ?? [], out: TrafficFinding[] = [];
  const where = (p: AppPath) => (p.remoteKind === "site" ? model.sites[p.remoteSite!]?.name ?? p.remoteSite! : p.remoteKind === "internet" ? `the Internet (${p.remoteNet})` : p.remoteNet);
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  // only sites are compared with sites: the Internet and unplaced ranges sit at any distance, so a
  // cloud workload is always "slower" to them than to its own cluster, which says nothing about the network
  const peers = new Map<string, AppPath[]>();
  paths.filter((p) => p.remoteKind === "site" && p.rttP90Ms != null && p.conversations >= 20).forEach((p) => { const k = `${p.workload}|${p.port}`; peers.set(k, [...(peers.get(k) ?? []), p]); });
  peers.forEach((ps) => {
    if (ps.length < 3) return;
    ps.forEach((p) => {
      const others = median(ps.filter((o) => o !== p).map((o) => o.rttP90Ms!));
      if (p.rttP90Ms! >= Math.max(SLOW_PATH_FACTOR * others, others + 20)) out.push({
        kind: "slow-path", site: p.remoteSite,
        text: `${p.workload} ${p.server ? "answers" : "reaches"} ${where(p)} on ${p.app} at ${p.rttP90Ms} ms (90th percentile), against ${others} ms for its other networks — the path to that network, not the application`,
      });
    });
  });
  paths.filter((p) => p.retrPct != null && p.retrPct >= PATH_RETR_PCT && p.packets >= PATH_MIN_PACKETS).sort((a, b) => b.retrPct! - a.retrPct!).slice(0, 3).forEach((p) => out.push({
    kind: "lossy-path", site: p.remoteSite,
    text: `${p.retrPct}% of the packets between ${p.workload} and ${where(p)} on ${p.app} are retransmitted — loss on that path`,
  }));
  paths.filter((p) => p.resets >= 50 && p.resets >= 0.2 * p.conversations).sort((a, b) => b.resets - a.resets).slice(0, 3).forEach((p) => out.push({
    kind: "resets", site: p.remoteSite,
    text: `${p.resets.toLocaleString("en-US")} TCP sessions reset between ${p.workload} and ${where(p)} on ${p.app} in the hour (${p.conversations.toLocaleString("en-US")} conversations) — a firewall, a load balancer or the application closing them`,
  }));
  return out;
}

/** Busy ports explained by the traffic the exporter saw on them. */
export function busyPortFindings(model: NetworkModel): TrafficFinding[] {
  const out: TrafficFinding[] = [];
  model.devices.forEach((d) => d.interfaces.filter((i) => (i.util ?? 0) >= BUSY_PORT_PCT).forEach((i) => {
    const users = portUsers(model, d, i.name);
    if (!users.length) return;
    const top = users[0];
    out.push({
      kind: "busy-port", site: d.site,
      text: `${d.name} ${i.name} at ${Math.round(i.util!)}%: ${top.app} from ${top.from} to ${top.to} is ${top.share}% of what the exporter saw on it${users[1] ? `, then ${users[1].app} from ${users[1].from} to ${users[1].to} (${users[1].share}%)` : ""} — ${bytesTxt(top.bytes)} in the hour`,
    });
  }));
  return out;
}

/** Plain-language findings for one site. */
export function trafficInsights(t: SiteTraffic, flows: FlowMap, code: string): string[] {
  const out: string[] = [];
  t.fanIn.forEach((f) => out.push(fanInText(f)));
  flows.exporters.filter((e) => e.site === code && e.falling).forEach((e) => out.push(
    `${e.device ?? e.ip} exported ${fmtInt(e.flows5m)} flows in the last 5 minutes, against a usual ${fmtInt(e.usual5m)} — traffic stopped, or the device stopped exporting`,
  ));
  const top = t.apps[0];
  if (top && t.bytes && top.bytes / t.bytes >= 0.9) out.push(`${top.name ?? `${top.proto}/${top.port}`} carries ${Math.round((100 * top.bytes) / t.bytes)}% of the bytes`);
  if (t.private && t.bytes && t.private / t.bytes >= 0.25) out.push(`${Math.round((100 * t.private) / t.bytes)}% of the bytes go to private ranges no site claims: tag the sites with site_cidr to place them`);
  return out;
}

/** Findings for the whole environment, including what no site owns (an exporter no SNMP monitoring places, a host group). */
export function environmentFindings(model: NetworkModel): TrafficFinding[] {
  const f = model.flowMap, out: TrafficFinding[] = [];
  if (f) {
    Object.entries(f.sites).forEach(([code, t]) => t.fanIn.forEach((x) => out.push({ kind: "fan-in", text: fanInText(x), site: code })));
    f.exporters.filter((e) => e.falling).forEach((e) => out.push({
      kind: "exporter-silent", site: e.site ?? undefined,
      text: `${e.device ?? e.ip} exported ${fmtInt(e.flows5m)} flows in the last 5 minutes, against a usual ${fmtInt(e.usual5m)} — traffic stopped, or the device stopped exporting`,
    }));
    const unplaced = [...new Set(f.conversations.filter((c) => !c.viaSite).map((c) => c.viaName))];
    if (unplaced.length) out.push({
      kind: "unplaced-device",
      text: `${unplaced.slice(0, 3).join(", ")}${unplaced.length > 3 ? ` and ${unplaced.length - 3} more` : ""} ${unplaced.length === 1 ? "sends" : "send"} traffic but ${unplaced.length === 1 ? "is" : "are"} not monitored over SNMP, so ${unplaced.length === 1 ? "its" : "their"} traffic is not tied to a site`,
    });
  }
  out.push(...busyPortFindings(model), ...pathFindings(model));
  // a steady high level is not an incident, but it is loss the applications live with every hour
  (model.appNet?.workloads ?? []).filter((w) => w.retrNow != null && w.retrNow >= CHRONIC_RETR_PCT && w.retrUsual != null && w.retrUsual >= CHRONIC_RETR_PCT)
    .sort((a, b) => (b.retrNow ?? 0) - (a.retrNow ?? 0)).slice(0, 3).forEach((w) => out.push({
      kind: "chronic-retransmission",
      text: `${w.name} retransmits ${pct(w.retrNow!)} of its TCP packets, and did the same over the six hours before (${pct(w.retrUsual!)}) — steady loss on its path, not a new incident`,
    }));
  return out;
}
