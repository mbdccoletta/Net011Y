// Findings on traffic, stated as measurements: the screen and Assist read the same sentences. Each one
// says what the data shows and what it could mean, never a verdict — flows show volume and pattern, not
// intent, and a steady number is a condition the operator knows better than the app.
import type { FlowDeny, FlowFanIn, FlowMap, NetworkModel, SiteTraffic } from "./types";
import { fmtInt } from "../utils/format";

/** Denied attempts in an hour, for one zone pair and port, worth naming. */
export const DENY_NOTABLE = 1000;
/** A workload retransmitting at least this share of its TCP packets is losing packets all the time. */
export const CHRONIC_RETR_PCT = 2;

export interface TrafficFinding {
  kind: "fan-in" | "exporter-silent" | "denies" | "dominant-app" | "unplaced" | "chronic-retransmission" | "unplaced-device";
  text: string;
  site?: string;
}

const fanInText = (f: FlowFanIn) =>
  `${fmtInt(f.sources)} distinct Internet sources reached ${f.hosts > 1 ? `${fmtInt(f.hosts)} hosts in ${f.dst}` : f.dst.replace("/24", "")} on port ${f.port} within the hour — a scan, a flood, or a very popular service`;
// a few hosts retrying is a client or a rule; hundreds of hosts at one door is someone looking for it
const denyText = (d: FlowDeny) =>
  `${d.viaName} denied ${fmtInt(d.denies)} ${d.port === "53" ? "DNS" : `${d.proto}/${d.port}`} attempts from ${d.from} to ${d.to} in the hour, from ${fmtInt(d.sources)} host${d.sources === 1 ? "" : "s"} — ${
    d.sources >= 100 ? "many hosts at one port: a scan, or a service people still expect there" : "a few hosts retrying: a misconfigured client, or a rule missing"}`;
const pct = (v: number) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(1)}%`;

/** Plain-language findings for one site. */
export function trafficInsights(t: SiteTraffic, flows: FlowMap, code: string): string[] {
  const out: string[] = [];
  t.fanIn.forEach((f) => out.push(fanInText(f)));
  flows.exporters.filter((e) => e.site === code && e.falling).forEach((e) => out.push(
    `${e.device ?? e.ip} exported ${fmtInt(e.flows5m)} flows in the last 5 minutes, against a usual ${fmtInt(e.usual5m)} — traffic stopped, or the device stopped exporting`,
  ));
  t.denies.filter((d) => d.denies >= DENY_NOTABLE).slice(0, 3).forEach((d) => out.push(denyText(d)));
  const top = t.apps[0];
  if (top && t.bytes && top.bytes / t.bytes >= 0.9) out.push(`${top.name ?? `${top.proto}/${top.port}`} carries ${Math.round((100 * top.bytes) / t.bytes)}% of the bytes`);
  if (t.private && t.bytes && t.private / t.bytes >= 0.25) out.push(`${Math.round((100 * t.private) / t.bytes)}% of the bytes go to private ranges or zones no site claims: tag the sites with site_cidr to place them`);
  return out;
}

/** Findings for the whole environment, including what no site owns (an unmonitored firewall, a host group). */
export function environmentFindings(model: NetworkModel): TrafficFinding[] {
  const f = model.flowMap, out: TrafficFinding[] = [];
  if (f) {
    f.denies.filter((d) => d.denies >= DENY_NOTABLE).slice(0, 4).forEach((d) => out.push({ kind: "denies", text: denyText(d), site: d.site ?? undefined }));
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
  // a steady high level is not an incident, but it is loss the applications live with every hour
  (model.appNet?.workloads ?? []).filter((w) => w.retrNow != null && w.retrNow >= CHRONIC_RETR_PCT && w.retrUsual != null && w.retrUsual >= CHRONIC_RETR_PCT)
    .sort((a, b) => (b.retrNow ?? 0) - (a.retrNow ?? 0)).slice(0, 3).forEach((w) => out.push({
      kind: "chronic-retransmission",
      text: `${w.name} retransmits ${pct(w.retrNow!)} of its TCP packets, and did the same over the six hours before (${pct(w.retrUsual!)}) — steady loss on its path, not a new incident`,
    }));
  return out;
}
