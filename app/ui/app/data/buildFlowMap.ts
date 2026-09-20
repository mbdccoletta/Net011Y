// Who talks to whom, site by site, from NetFlow / IPFIX as the Dynatrace OpenTelemetry Collector ingests
// it (the netflow receiver: flow.*, source.address, destination.address). The exporter is a device, so
// it sits at a site; each end's address falls in a site's address space (site_cidr tag or a device /24),
// in a private range no site claims, or on the Internet. Nothing is inferred beyond that: an unplaced
// private range is named as such, never assigned to the nearest site. Only documented formats are read:
// firewall logs have none, so their raw text is not parsed.
import type { Conversation, Device, FlowApp, FlowFanIn, FlowMap, FlowPeer, NetworkModel, SiteTraffic } from "../model/types";
import type { Addressing, AddressOwner } from "../model/addressing";
import { buildJourney } from "../model/journey";

type Rec = Record<string, any>;
const num = (v: unknown): number => (v == null || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));

/** A range this many distinct Internet sources reach within the hour is worth naming (a scan, a flood, or a very popular public service). */
export const FAN_IN_SOURCES = 1000;
/** An exporter sending less than this share of its usual flows in the last five minutes is falling silent. */
export const EXPORTER_FALL = 0.2;

const PORTS: Record<string, string> = {
  "20": "FTP data", "21": "FTP", "22": "SSH", "23": "Telnet", "25": "SMTP", "53": "DNS", "67": "DHCP", "80": "HTTP", "110": "POP3", "123": "NTP",
  "135": "RPC", "139": "NetBIOS", "143": "IMAP", "161": "SNMP", "162": "SNMP trap", "179": "BGP", "389": "LDAP", "443": "HTTPS", "445": "SMB",
  "514": "Syslog", "587": "SMTP submission", "636": "LDAPS", "993": "IMAPS", "1433": "SQL Server", "1521": "Oracle", "2055": "NetFlow",
  "3306": "MySQL", "3389": "RDP", "5060": "SIP", "5246": "CAPWAP", "5432": "PostgreSQL", "5985": "WinRM", "6379": "Redis", "8080": "HTTP alt", "8443": "HTTPS alt", "9092": "Kafka",
};
export const appName = (proto: string, port: string) => PORTS[port] ?? `${proto.toLowerCase()}/${port}`;

const empty = (): SiteTraffic => ({ bytes: 0, flows: 0, toSites: 0, internet: 0, private: 0, local: 0, peers: [], apps: [], fanIn: [], exporters: [] });

export function buildFlowMap(L: (k: string) => Rec[], devices: Device[], addressing: Addressing, sitesOf: NetworkModel["sites"]): FlowMap | undefined {
  const nf = L("flowNets");
  if (!nf.length) return undefined;
  const devByIp = new Map<string, Device>();
  devices.forEach((d) => [d.ip, ...(d.ips ?? [])].forEach((ip) => ip && !devByIp.has(ip) && devByIp.set(ip, d)));
  // the device that exported the flows; one nobody monitors over SNMP is still placed by its own address
  const viaOf = (ip: string) => {
    const d = devByIp.get(ip);
    return d ? { via: ip, viaName: d.name, viaSite: d.site as string | null }
      : { via: ip, viaName: `Exporter ${ip}`, viaSite: addressing.ownerOf(ip).site ?? null };
  };
  const end = (o: AddressOwner, net: string) =>
    o.kind === "site" ? { kind: "site" as const, site: o.site, label: o.site! }
    : o.kind === "internet" ? { kind: "internet" as const, site: undefined, label: "Internet" }
    : { kind: "private" as const, site: undefined, label: `${net}/24` };

  // SNMP ifIndex → port name, per polled address; an exporter is looked up through its device
  const ifName = new Map<string, string>();
  L("ifIndex").forEach((r) => ifName.set(`${r["device.address"]}|${r["if.idx"]}`, String(r["if.name"] ?? "")));
  const portOf = (ip: string, idx: unknown) => {
    if (idx == null || idx === "" || idx === "0") return undefined;
    const d = devByIp.get(ip);
    return ifName.get(`${d?.ip ?? ip}|${idx}`) ?? ifName.get(`${ip}|${idx}`) ?? `ifIndex ${idx}`;
  };
  const conversations: Conversation[] = [];
  for (const r of nf) {
    const ip = String(r.exp ?? "");
    const s24 = String(r.s24 ?? ""), d24 = String(r.d24 ?? ""), proto = String(r.proto ?? "").toLowerCase(), port = String(r.dport ?? "");
    const a = end(addressing.ownerOf(s24), s24), b = end(addressing.ownerOf(d24), d24);
    conversations.push({
      ...viaOf(ip),
      fromKind: a.kind, fromSite: a.site, fromLabel: a.label, toKind: b.kind, toSite: b.site, toLabel: b.label,
      app: appName(proto, port), proto, port, s24, d24, bytes: num(r.bytes), count: num(r.flows),
      inIf: portOf(ip, r.in_if), outIf: portOf(ip, r.out_if),
    });
  }

  const sites: Record<string, SiteTraffic> = {};
  const peers = new Map<string, Map<string, FlowPeer>>();
  const addPeer = (site: string, p: Omit<FlowPeer, "bytes" | "flows">, bytes: number, flows: number, sent?: boolean) => {
    const m = peers.get(site) ?? new Map<string, FlowPeer>();
    const cur = m.get(p.name) ?? { ...p, bytes: 0, flows: 0, sent: 0, received: 0 };
    cur.bytes += bytes; cur.flows += flows;
    if (sent === true) cur.sent = (cur.sent ?? 0) + bytes;
    if (sent === false) cur.received = (cur.received ?? 0) + bytes;
    m.set(p.name, cur); peers.set(site, m);
  };
  const pairs = new Map<string, { a: string; b: string; bytes: number; flows: number; aToB: number; bToA: number }>();
  let unattributed = 0;
  for (const c of conversations) {
    // between two sites: the route the map draws, whichever device saw it
    if (c.fromSite && c.toSite && c.fromSite !== c.toSite) {
      const [a, b] = [c.fromSite, c.toSite].sort();
      const p = pairs.get(`${a}|${b}`) ?? { a, b, bytes: 0, flows: 0, aToB: 0, bToA: 0 };
      p.bytes += c.bytes; p.flows += c.count;
      if (c.fromSite === a) p.aToB += c.bytes; else p.bToA += c.bytes;
      pairs.set(`${a}|${b}`, p);
    }
    const here = c.viaSite;
    if (!here) { unattributed += c.bytes; continue; }
    const t = (sites[here] ??= empty());
    t.bytes += c.bytes; t.flows += c.count;
    if (!t.exporters.includes(c.viaName)) t.exporters.push(c.viaName);
    const farSite = [c.fromSite, c.toSite].find((s) => s && s !== here);
    // "sent" is what left this site: the conversation started here
    if (farSite) { t.toSites += c.bytes; addPeer(here, { kind: "site", name: farSite, site: farSite }, c.bytes, c.count, c.fromSite === here); continue; }
    if (c.fromKind === "internet" || c.toKind === "internet") { t.internet += c.bytes; addPeer(here, { kind: "internet", name: "Internet" }, c.bytes, c.count, c.toKind === "internet"); continue; }
    if (c.fromSite === here && c.toSite === here) { t.local += c.bytes; continue; }
    // a private range no site claims: named as it is, never guessed
    const unk = c.toKind === "private" ? c.toLabel : c.fromLabel;
    t.private += c.bytes; addPeer(here, { kind: "private", name: unk }, c.bytes, c.count);
  }

  // applications per site, from the same conversation groups (a query of their own read the same logs twice)
  const siteOfVia = (ip: string) => viaOf(ip).viaSite;
  const apps = new Map<string, Map<string, FlowApp>>();
  for (const c of conversations) {
    if (!c.viaSite) continue;
    const m = apps.get(c.viaSite) ?? new Map<string, FlowApp>();
    const cur = m.get(c.app) ?? { proto: c.proto, port: c.port, name: PORTS[c.port] ?? null, bytes: 0, flows: 0 };
    if (cur.proto !== c.proto && !cur.proto.split("+").includes(c.proto)) cur.proto = `${cur.proto}+${c.proto}`;
    cur.bytes += c.bytes; cur.flows += c.count;
    m.set(c.app, cur); apps.set(c.viaSite, m);
  }

  const fanIn: FlowFanIn[] = L("flowFanIn").map((r) => ({ dst: `${r.dst ?? ""}/24`, hosts: num(r.dsts), port: String(r.dport ?? ""), sources: num(r.srcs), bytes: num(r.bytes), flows: num(r.flows), exporter: String(r.exp ?? "") }));

  for (const [code, t] of Object.entries(sites)) {
    t.peers = [...(peers.get(code)?.values() ?? [])].sort((x, y) => y.bytes - x.bytes).slice(0, 8);
    t.apps = [...(apps.get(code)?.values() ?? [])].sort((x, y) => y.bytes - x.bytes).slice(0, 8);
    t.fanIn = fanIn.filter((f) => siteOfVia(f.exporter) === code && f.sources >= FAN_IN_SOURCES).slice(0, 5);
  }

  // exporters: flows in the last complete five minutes against the hour before
  // bytes per bucket, for the bandwidth over time; the window comes from the answer, not from the clock
  const tsRows = L("flowTs");
  const first = tsRows[0];
  const start = first ? Date.parse(String((first.timeframe as { start?: string } | undefined)?.start ?? "").replace(/(\.\d{3})\d*Z$/, "$1Z")) : NaN;
  const stepMs = first ? Number(first.interval) / 1e6 : NaN;
  const rate = Number.isFinite(start) && Number.isFinite(stepMs) ? {
    start, stepMs,
    exporters: tsRows.map((r) => ({
      ip: String(r.exp ?? ""), device: devByIp.get(String(r.exp ?? ""))?.name ?? null,
      bytes: (Array.isArray(r.bytes) ? r.bytes : []).map((v: unknown) => (v == null ? null : Number(v))) as (number | null)[],
    })).filter((e) => e.bytes.some((v) => v != null)),
  } : undefined;

  const exporters = L("flowTs").map((r) => {
    const xs = (Array.isArray(r.flows) ? r.flows : []).map((v: unknown) => (v == null ? null : Number(v))) as (number | null)[];
    const last = xs.length - 2;
    const prior = xs.slice(Math.max(0, last - 12), last).filter((v): v is number => v != null).sort((p, q) => p - q);
    const usual = prior.length ? prior[Math.floor(prior.length / 2)] : null;
    const now = last >= 0 ? xs[last] ?? 0 : null;
    const d = devByIp.get(String(r.exp ?? ""));
    return { ip: String(r.exp ?? ""), device: d?.name ?? null, site: d?.site ?? null, flows5m: now, usual5m: usual, falling: now != null && usual != null && usual >= 10 && now < EXPORTER_FALL * usual };
  });

  return {
    windowMs: 3600000, exporters, rate, pairs: [...pairs.values()].sort((x, y) => y.bytes - x.bytes), sites, unattributed,
    subnetsKnown: addressing.known, subnetsTagged: addressing.tagged,
    sources: { netflow: { exporters: new Set(conversations.map((c) => c.via)).size, bytes: conversations.reduce((a, c) => a + c.bytes, 0) } },
    conversations,
    journey: buildJourney(conversations, sitesOf),
  };
}
