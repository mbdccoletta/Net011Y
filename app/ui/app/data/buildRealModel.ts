// Turns live DQL results into the NetworkModel (ported from scripts/build_data.py).
// Inventory comes from the Smartscape network nodes of any SNMP extension, so the model builds in any
// environment. Sites come from sysLocation, the autodiscovery group or the management network; primary
// tags (site, site_name, region, geo_lat, geo_lon, hub, site_type, site_cidr) and circuit tags on the ICMP
// monitors (circuit_id, circuit_role, carrier, circuit_tech, sla_ms) enrich it when the customer sets them.
import type { AppNetwork, AppPath, Circuit, CloudCluster, Device, DeviceProblem, E2EPath, Hop, Iface, NetEvent, NetworkModel, NonNetworkScope, PathLink, Peer, Site, Users, Verdict } from "../model/types";
import { T, ORDER, worst, deviceVerdict } from "../model/verdict";
import { deviceHop, internetHop, circuitHop, cloudHop, makePath } from "../model/e2e";
import { buildAddressing, isIpv4, type Addressing } from "../model/addressing";
import { appName, buildFlowMap } from "./buildFlowMap";
import { FAMILIES } from "./formats";

type Rec = Record<string, any>;
export type QueryResults = Partial<Record<string, Rec[]>>;

const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const clean = (a: unknown): number[] => (Array.isArray(a) ? a.filter((v) => v != null).map(Number) : []);
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
/** A primary Grail tag (primary_tags.<key>) on a record, or null when the source does not send it. */
const tag = (r: Rec | undefined, key: string): string | null => {
  const v = r?.[`primary_tags.${key}`];
  const x = Array.isArray(v) ? v[0] : v;
  return x == null || x === "" ? null : String(x);
};
/** Start of the trailing run of buckets matching `dead` in a timeseries row, or null when the last bucket is alive. */
const deadSince = (row: Rec, values: unknown[], dead: (i: number) => boolean): string | null => {
  let i = values.length;
  while (i > 0 && dead(i - 1)) i--;
  if (i === values.length || i === 0 && !values.length) return null;
  const start = Date.parse(String(row.timeframe?.start ?? "").replace(/(\.\d{3})\d*Z$/, "$1Z"));
  const step = Number(row.interval) / 1e6;
  return Number.isFinite(start) && Number.isFinite(step) ? new Date(start + i * step).toISOString() : null;
};

// COUNTRY-UF-SITE-ROLE[NNN | -NNN], with or without the DNS domain (BR-PI-URU1-SWA-001.corp.example.com)
const CONVENTION = /^([A-Z]{2})-([A-Z]{2})-([A-Z0-9]{3,5})-([A-Z]{2,5})(?:-?\d+)?$/;
const ROLE_CODES: Record<string, string> = {
  RTR: "edge", RTC: "edge", RTP: "edge", L2L: "edge", CON: "core", COR: "core", SWT: "switch", DISP: "switch", APW: "ap", WLC: "wlc", FWL: "firewall", LBL: "lb",
  SWA: "switch", SWD: "switch", LEF: "switch", SWC: "core", SPN: "core", FWC: "firewall", FW: "firewall",
};

/** Brazilian federative units: the name the region is shown as, and a centre to place a site at when
 *  nothing gives its coordinates. A site placed this way is marked approximate. */
const BR_UF: Record<string, [string, number, number]> = {
  AC: ["Acre", -9.0, -70.5], AL: ["Alagoas", -9.6, -36.6], AP: ["Amapá", 1.4, -51.8], AM: ["Amazonas", -3.4, -64.7], BA: ["Bahia", -12.5, -41.7],
  CE: ["Ceará", -5.2, -39.5], DF: ["Distrito Federal", -15.8, -47.9], ES: ["Espírito Santo", -19.6, -40.6], GO: ["Goiás", -15.9, -49.6], MA: ["Maranhão", -5.0, -45.3],
  MT: ["Mato Grosso", -12.9, -55.9], MS: ["Mato Grosso do Sul", -20.5, -54.8], MG: ["Minas Gerais", -18.5, -44.6], PA: ["Pará", -3.8, -52.5], PB: ["Paraíba", -7.2, -36.8],
  PR: ["Paraná", -24.6, -51.6], PE: ["Pernambuco", -8.4, -37.9], PI: ["Piauí", -7.7, -42.7], RJ: ["Rio de Janeiro", -22.2, -42.7], RN: ["Rio Grande do Norte", -5.8, -36.6],
  RS: ["Rio Grande do Sul", -29.7, -53.2], RO: ["Rondônia", -10.9, -63.0], RR: ["Roraima", 2.0, -61.4], SC: ["Santa Catarina", -27.3, -50.5], SP: ["São Paulo", -22.2, -48.8],
  SE: ["Sergipe", -10.6, -37.4], TO: ["Tocantins", -10.2, -48.3],
};

const slug = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** "City - CODE - Area" in the SNMP sysLocation: the city of a site, when the code in it matches. */
/** sysLocation left at its default ("n/a", "unknown", "-") says nothing about where the device is. */
const DC_NAME = /^DC|data ?cent(er|re)/i;
const PLACEHOLDER = /^(n\/?a|none|null|unknown|not ?set|default|sys ?location|-+)?$/i;
const realLocation = (v: unknown) => { const t = String(v ?? "").trim(); return PLACEHOLDER.test(t) ? null : t; };
/** With nothing that names a place, the devices of one management /16 are grouped: a network, not a guess at a site. */
const subnetSite = (d: Record<string, any>) => {
  const ip = String((Array.isArray(d.ip) ? d.ip[0] : d.ip) ?? d["snmp.ip"] ?? "");
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  return m ? `Network ${m[1]}.${m[2]}.0.0/16` : "Unassigned";
};
/** The SNMP autodiscovery group ("EDE - Gdansk (Data Center)") names the place after the last dash. */
const groupSite = (v: unknown) => realLocation(String(v ?? "").split(/\s+-\s+/).pop()?.replace(/\s*\(.*\)\s*$/, ""));
function parseLocation(location: unknown, code: string | null): { city: string; code: string } | null {
  const parts = String(location ?? "").split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const c = parts[1].toUpperCase();
  if (code ? c !== code : !/^[A-Z0-9]{3,5}$/.test(c)) return null;
  return { city: parts[0], code: c };
}
// What a device is, from the fields every SNMP extension reports (device_type, sysDescr): the product
// lines say it plainly. The name rules below only add what these miss.
const DESCR_ROLES: [RegExp, string][] = [
  [/adaptive security appliance|\basa\b|fortigate|fortios|pan-os|palo ?alto|check ?point|firepower|srx\d|sonicwall/i, "firewall"],
  [/big-?ip|\bf5\b|netscaler|citrix adc|load ?balanc/i, "lb"],
  [/wireless lan controller|\bwlc\b|aireos|mobility controller/i, "wlc"],
  [/access point|aironet|\bap\d{2,}|instant on/i, "ap"],
  [/nexus|catalyst|\bex\d{3,}|\bqfx|arista|switch/i, "switch"],
  [/\b(asr|isr)[\s-]?\d*\b|\bmx\d{2,}|\bptx|router|ios xr|junos/i, "edge"],
];
const ROLE_RULES: [RegExp, string][] = [
  [/core-router/, "core"], [/edge-router/, "edge"], [/firewall|asa|fortigate|paloalto|palo-alto/, "firewall"],
  [/wlc/, "wlc"], [/-ap-|aironet|aruba-ap/, "ap"], [/big-ip|f5/, "lb"], [/switch|nexus|catalyst/, "switch"], [/ucs/, "compute"],
  [/storage|printer|phone|windows|window-/, "endpoint"],
];

// Site coordinates: a site lookup table is the production source (site.code → lat/lon);
// until one exists, well-known location names give the map a position.
const KNOWN_PLACES: [RegExp, number, number, string][] = [
  [/\blon(don)?\b/i, 51.507, -0.128, "Europe"], [/\bnyc\b|new york/i, 40.713, -74.006, "North America"], [/s[aã]o paulo|\bspo\b/i, -23.55, -46.63, "South America"],
  [/frankfurt|\bfra\b/i, 50.11, 8.68, "Europe"], [/amsterdam|\bams\b/i, 52.37, 4.9, "Europe"], [/chicago|\bchi\b/i, 41.88, -87.63, "North America"],
  [/dallas|\bdfw\b/i, 32.78, -96.8, "North America"], [/singapore|\bsin\b/i, 1.35, 103.82, "Asia Pacific"], [/tokyo|\btyo\b/i, 35.68, 139.69, "Asia Pacific"], [/sydney|\bsyd\b/i, -33.87, 151.21, "Asia Pacific"],
];
export function placeOf(code: string, name: string): { lat: number; lon: number; region: string } | null {
  const hit = KNOWN_PLACES.find(([re]) => re.test(code) || re.test(name));
  return hit ? { lat: hit[1], lon: hit[2], region: hit[3] } : null;
}

export function deriveTags(name: string, deviceType?: string): { site: string; role: string; uf?: string; country?: string; matched: boolean } {
  const m = name.split(".")[0].toUpperCase().match(CONVENTION);
  if (m) return { site: m[3], role: ROLE_CODES[m[4]] ?? "other", country: m[1], uf: m[2], matched: true };
  const n = `${name} ${deviceType ?? ""}`.toLowerCase();
  // no convention: the site comes from the standard fields (see the device loop), never from a name fragment
  return { site: "", role: ROLE_RULES.find(([re]) => re.test(n))?.[1] ?? "other", matched: false };
}


/**
 * Every entity a problem or event names, whichever format the environment writes: the classic id lists
 * (affected_entity_ids, smartscape.affected_entity.ids) or the Smartscape objects newer environments use
 * (smartscape.affected_entities: [{ id, type, name }], dt.smartscape_source.id). Reading only the first kind
 * left every problem of such an environment without an entity — a Postgres outage looked like an
 * environment-wide event.
 */
function entitiesOf(r: Rec): { ids: string[]; names: string[]; types: string[] } {
  const objs = ((r["smartscape.affected_entities"] ?? []) as { id?: string; type?: string; name?: string }[]).filter((o) => o && typeof o === "object");
  const ids = [
    ...((r["smartscape.affected_entity.ids"] ?? []) as unknown[]).map(String),
    ...((r.affected_entity_ids ?? []) as unknown[]).map(String),
    ...objs.map((o) => String(o.id ?? "")),
    r["dt.smartscape_source.id"] ? String(r["dt.smartscape_source.id"]) : "",
  ].filter(Boolean);
  const names = [...((r.affected_entity_names ?? []) as unknown[]).map(String), ...objs.map((o) => String(o.name ?? "")).filter(Boolean)];
  return { ids: [...new Set(ids)], names: [...new Set(names)], types: [...new Set(objs.map((o) => String(o.type ?? "")).filter(Boolean))] };
}

const net24 = (ip: string) => ip.split(".").slice(0, 3).join(".");

/**
 * Sessions per hour, what that hour usually looks like, and which client subnets belong to a site.
 * Nothing here is a verdict: it is the measurement the suspicion is built from, and the suspicion is
 * never a status.
 */
/**
 * An hourly count against what each of those hours usually holds, read from a week of the same count.
 * `settle` is how many hours back the reading is taken: the hour still filling is always skipped, and a
 * session is only recorded when it ends, so the hour that has just closed keeps growing for a while
 * (fxz0998d: the same hour went from 1479 to 1968 sessions in forty minutes) and read too early it
 * always looks like a drop. Sessions settle one hour later than requests, which are metrics.
 */
function hourly(day: (number | null)[], week: (number | null)[], settle = 1) {
  const end = Date.now();
  const hourOf = (i: number, len: number) => new Date(end - (len - 1 - i) * 3600000).getUTCHours();
  const buckets = new Map<number, number[]>();
  week.forEach((v, i) => { const h = hourOf(i, week.length); buckets.set(h, [...(buckets.get(h) ?? []), v ?? 0]); });
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const typical = day.map((_, i) => median(buckets.get(hourOf(i, day.length)) ?? []));
  const last = day.length - 1 - settle;
  return { series: day, typical, nowIndex: last, now: last >= 0 ? day[last] ?? null : null, typicalNow: last >= 0 ? typical[last] ?? null : null };
}

function buildUsers(L: (k: string) => Rec[], addressing: Addressing, unmapped: DeviceProblem[]): Users | undefined {
  // sessions, summed across application types
  const rows = L("sessions");
  const hours = Math.max(0, ...rows.map((r) => (r.sessions as unknown[] | undefined)?.length ?? 0));
  const day: (number | null)[] = new Array(hours).fill(null);
  const byType: Record<string, number> = {};
  rows.forEach((r) => {
    const pts = (r.sessions ?? []) as (number | null)[];
    const type = String(r["dt.rum.application.type"] ?? "other");
    pts.forEach((v, i) => { if (v != null) day[i] = (day[i] ?? 0) + v; });
    byType[type] = (byType[type] ?? 0) + pts.reduce<number>((a, v) => a + (v ?? 0), 0);
  });
  const sessions = hours ? hourly(day, (L("sessionsTypical")[0]?.sessions ?? []) as (number | null)[], 2) : null;

  // requests served, for environments monitored through their services rather than their users
  const reqDay = (L("requests")[0]?.req ?? []) as (number | null)[];
  const requests = reqDay.length ? hourly(reqDay, (L("requestsTypical")[0]?.req ?? []) as (number | null)[]) : undefined;

  if (!sessions && !requests) return undefined;

  // which client subnets are a site, and which are just traffic
  const nets = L("sessionNets").map((r) => {
    const ip = String(r.ip ?? "");
    const site = addressing.ownerOf(ip).site;
    return { net: ip, sessions: num(r.sessions) ?? 0, ...(site ? { site } : {}) };
  });
  const total = nets.reduce((a, n) => a + n.sessions, 0);
  const mapped = nets.filter((n) => n.site).reduce((a, n) => a + n.sessions, 0);

  return {
    scope: mapped > 0 ? "site" : "environment",
    series: sessions?.series ?? [], typical: sessions?.typical ?? [], nowIndex: sessions?.nowIndex ?? -1, now: sessions?.now ?? null, typicalNow: sessions?.typicalNow ?? null,
    byType, nets, mapped, total,
    // Davis is watching the traffic itself when it has raised one of its traffic anomalies here
    anomalyWatched: unmapped.some((a) => /traffic|low load/i.test(a.name)),
    ...(requests ? { requests } : {}),
  };
}

/**
 * How the applications feel the network, reduced to what the fault domain reading needs: OneAgent network
 * flows when the environment has them, the classic per-process network metrics otherwise. Undefined when
 * neither arrives.
 */
function buildAppNet(L: (k: string) => Rec[]): AppNetwork | undefined {
  const pct = (r: number, p: number) => (p > 0 ? round((100 * r) / p, 4) : null);
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => num(x) ?? 0) : []);
  const series = (row: Rec) => ({
    start: Date.parse((row.timeframe as { start?: string } | undefined)?.start ?? "") || Date.now() - arr(row.pk).length * 600000,
    interval: (num(row.interval) ?? 6e11) / 1e6,
  });

  const row = L("appNet")[0];
  const conversations = arr(row?.conv);
  if (row && Array.isArray(row.pk) && conversations.some((c) => c > 0)) {
    const pk = arr(row.pk), re = arr(row.re);
    const ms = (v: unknown) => (num(v) == null ? null : round((num(v) as number) / 1e6, 1));
    const groups = new Map<string, { now?: Rec; before?: Rec }>();
    for (const x of L("appNetBy")) {
      const g = groups.get(x.grp ?? "unnamed") ?? {};
      if (x.recent === true || x.recent === "true") g.now = x; else g.before = x;
      groups.set(x.grp ?? "unnamed", g);
    }
    return {
      source: "flows", rttKind: "p90", ...series(row),
      retrPct: pk.map((p, i) => pct(re[i], p)), retransmitted: re,
      rttMs: ((row.rtt as unknown[]) ?? []).map(ms), conversations,
      workloads: [...groups].map(([name, g]) => ({
        name, conversations: num(g.now?.conv) ?? 0,
        retrNow: g.now ? pct(num(g.now.re) ?? 0, num(g.now.pk) ?? 0) : null, retrUsual: g.before ? pct(num(g.before.re) ?? 0, num(g.before.pk) ?? 0) : null,
        rttNow: ms(g.now?.rtt), rttUsual: ms(g.before?.rtt),
      })),
    };
  }

  // no flows: the per-process metrics, packets sent and retransmitted every 10 minutes, per host group per hour
  const proc = L("appNetProc")[0];
  const ppk = arr(proc?.pk);
  if (!proc || !ppk.some((p) => p > 0)) return undefined;
  const pre = arr(proc.re);
  return {
    source: "process metrics", rttKind: "avg", ...series(proc),
    retrPct: ppk.map((p, i) => pct(pre[i], p)), retransmitted: pre,
    rttMs: ((proc.rtt as unknown[]) ?? []).map((v) => (num(v) == null ? null : round(num(v) as number, 1))),
    conversations: ppk.map(() => 0),
    workloads: L("appNetProcBy").map((x) => {
      const pk = arr(x.pk), re = arr(x.re), rtt = (x.rtt as unknown[] ?? []).map((v) => num(v));
      const n = pk.length - 1, sum = (a: number[]) => a.reduce((p, q) => p + q, 0);
      const before = rtt.slice(0, n).filter((v): v is number => v != null);
      return {
        name: String(x["dt.host_group.id"] ?? "no host group"), conversations: 0,
        retrNow: pct(re[n] ?? 0, pk[n] ?? 0), retrUsual: pct(sum(re.slice(0, n)), sum(pk.slice(0, n))),
        rttNow: rtt[n] == null ? null : round(rtt[n] as number, 1), rttUsual: before.length ? round(sum(before) / before.length, 1) : null,
      };
    }),
  };
}

/** OneAgent path quality: each workload and the network at the other end, placed like any address. */
function buildPaths(L: (k: string) => Rec[], addressing: Addressing): AppPath[] | undefined {
  const rows = L("appPaths");
  if (!rows.length) return undefined;
  return rows.map((r) => {
    const net = String(r.r24 ?? ""), owner = addressing.ownerOf(net), port = String(r.port ?? "");
    const pk = num(r.pk) ?? 0, re = num(r.re) ?? 0;
    return {
      workload: String(r.grp ?? "unnamed"), server: r.server === true || r.server === "true",
      remoteKind: owner.kind, remoteSite: owner.site, remoteNet: `${net}/24`,
      app: appName("tcp", port), port, conversations: num(r.conv) ?? 0,
      rttP90Ms: num(r.rtt90) == null ? null : round((num(r.rtt90) as number) / 1e6, 1),
      // a share of a few dozen packets is noise (and can pass 100%: retransmissions and packets are counted apart)
      retrPct: pk >= 1000 ? Math.min(100, round((100 * re) / pk, 3)) : null, packets: pk,
      resets: num(r.resets) ?? 0, timeouts: num(r.timeouts) ?? 0,
    };
  });
}

export function buildRealModel(r: QueryResults, tenant: string): NetworkModel {
  const L = (k: string) => r[k] ?? [];
  // a measure read per extension family ("cpu:network_device", "cpu:cisco" …), in catalog order: the
  // common set first, so it wins where a vendor family reports the same thing
  const LF = (m: string) => [...(r[m] ?? []), ...FAMILIES.flatMap((f) => r[`${m}:${f.id}`] ?? [])];

  // ---------- devices (Extension > Discovery; Neighbor duplicates dropped) ----------
  const byName = new Map<string, Rec>();
  const idAlias = new Map<string, string>();
  for (const d of L("devices")) {
    idAlias.set(d.id, d.name);
    if (d.monitoring_mode === "Neighbor") continue;
    const cur = byName.get(d.name);
    if (!cur || (cur.monitoring_mode !== "Extension" && d.monitoring_mode === "Extension")) byName.set(d.name, d);
  }
  const devices = new Map<string, Device>();
  const siteTags = new Map<string, Rec>();
  // what each site is known by, beyond its code: the city in sysLocation and the UF in the device name
  const siteHints = new Map<string, { cities: string[]; uf?: string; country?: string; dc?: boolean }>();
  for (const [name, d] of byName) {
    const derived = deriveTags(name, d.device_type);
    const location = realLocation(d.location);
    const loc = parseLocation(location, derived.matched ? derived.site : null);
    const code = derived.matched ? derived.site : loc?.code ?? null;
    const tagSite = tag(d, "site");
    // A site tag is the customer's own word and wins; when it names the same place as the code the
    // device already carries (the tag "currais-de-laranjeiras" on devices whose sysLocation is
    // "Currais de Laranjeiras - LRJ1 - …"), the short code is kept so the site is not split in two.
    const site = tagSite && !(code && loc && slug(tagSite) === slug(loc.city)) ? tagSite
      : code ?? location ?? realLocation(d.activation_tag) ?? groupSite(d["autodiscovery.group_label"]) ?? subnetSite(d);
    // the role: the customer's tag, the naming convention when it matched, else what the device says it is
    const described = DESCR_ROLES.find(([re]) => re.test(`${d.device_type ?? ""} ${d.description ?? ""}`))?.[1];
    const role = tag(d, "device_role") ?? (derived.matched || !described ? derived.role : described);
    if (!siteTags.has(site) && tagSite) siteTags.set(site, d);
    const hint = siteHints.get(site) ?? { cities: [] };
    if (loc) hint.cities.push(loc.city);
    hint.uf ??= derived.uf ?? tag(d, "federativeunit") ?? tag(d, "state") ?? tag(d, "uf") ?? undefined;
    if (DC_NAME.test(`${d.activation_tag ?? ""} ${d["autodiscovery.group_label"] ?? ""}`)) hint.dc = true;
    hint.country ??= derived.country ?? tag(d, "country") ?? undefined;
    siteHints.set(site, hint);
    devices.set(name, {
      id: d.id, idClassic: d.id_classic ?? undefined, chassisMac: d.chassis_mac ?? undefined, name, site, role, vendor: d.device_type || "generic",
      ip: (Array.isArray(d.ip) ? d.ip[0] : d.ip) ?? d["snmp.ip"] ?? "", ips: Array.isArray(d.ip) ? d.ip.filter((x: unknown) => isIpv4(String(x))) : undefined, mode: d.monitoring_mode, desc: String(d.description ?? "").slice(0, 160),
      location, ifCount: num(d.interface_count) ?? 0,
      cpu: [], cpuNow: null, availPct: null, availTs: null,
      syslog: { ERROR: 0, WARN: 0, INFO: 0 }, syslogErrTs: new Array(24).fill(0), traps: 0, events: [], interfaces: [],
      reasons: [], verdict: "Healthy", impact: 0, icmp: null,
    });
  }
  const devOf = (sid: string) => devices.get(idAlias.get(sid) ?? "");
  const ipToName = new Map([...devices.values()].filter((d) => d.ip).map((d) => [d.ip, d.name]));
  const chassisToName = new Map([...byName.values()].filter((d) => d.chassis_mac && d.monitoring_mode === "Extension").map((d) => [d.chassis_mac, d.name]));

  // Every extension family names its device its own way: the Smartscape node when it has one, else the
  // polled address, else the system name. The first family that reports a measure for a device wins.
  const addrToName = new Map<string, string>();
  devices.forEach((d) => [d.ip, ...(d.ips ?? [])].forEach((ip) => ip && !addrToName.has(ip) && addrToName.set(ip, d.name)));
  const sysNameTo = new Map([...devices.values()].map((d) => [d.name.toLowerCase().split(".")[0], d.name] as const));
  const devFor = (row: Rec) => devOf(row["dt.smartscape.ext_network_device"])
    ?? devices.get(addrToName.get(String(row["device.address"] ?? "")) ?? "")
    ?? devices.get(sysNameTo.get(String(row["sys.name"] ?? "").toLowerCase().split(".")[0]) ?? "");

  // ---------- CPU, memory and SNMP availability ----------
  for (const row of LF("cpu")) {
    const d = devFor(row);
    if (!d || d.cpu.length) continue;
    d.cpu = clean(row.cpu).map((v) => round(v));
    d.cpuNow = d.cpu.length ? d.cpu[d.cpu.length - 1] : null;
  }
  for (const row of LF("memory")) {
    const d = devFor(row);
    if (!d || d.memNow != null) continue;
    const m = clean(row.mem);
    if (m.length) d.memNow = round(m[m.length - 1]);
  }
  const snmpSilentSince = new Map<string, string>();
  const availDone = new Set<string>();
  for (const row of LF("uptime")) {
    const d = devFor(row);
    if (!d || availDone.has(d.name)) continue;
    availDone.add(d.name);
    const pts: (number | null)[] = (row.c ?? []).slice(0, 24);
    d.availTs = pts.map((v) => (v ? 1 : 0));
    const known = pts.filter((v) => v !== null).length || 24;
    d.availPct = round((100 * pts.filter((v) => v).length) / known, 2);
    const silent = deadSince(row, pts, (i) => !pts[i]);
    if (silent) snmpSilentSince.set(d.name, silent);
  }

  // ---------- interfaces ----------
  const nodes = new Map(L("interfaces").map((n) => [n.id, n]));
  // a port is its Smartscape node when the family reports one, else the device and the port name
  const ifName = (row: Rec) => String(row["if.name"] ?? row["interface.name"] ?? row["if.descr"] ?? "");
  const portKey = (row: Rec, d: Device | undefined) => String(row["dt.smartscape.ext_network_interface"] ?? "") || (d ? `${d.name}|${ifName(row)}` : "");
  const errs = new Map<string, Record<string, number>>();
  for (const row of LF("ifErrors")) {
    const key = portKey(row, devFor(row));
    if (!key || errs.has(key)) continue;
    const e: Record<string, number> = {};
    // totals already summed by the query, or a series to sum
    for (const f of ["ie", "oe", "crc", "idc", "odc"]) if (row[f] != null) e[f] = Array.isArray(row[f]) ? clean(row[f]).reduce((a, b) => a + b, 0) : num(row[f]) ?? 0;
    errs.set(key, e);
  }
  const isUplink = (name: string, speed: number | null) => (speed ?? 0) >= 10000 || /^(te|xe-|et-|po|lc-|hundred|fortygig|tengig)/i.test(name || "");
  const seen = new Set<string>();
  const addIface = (dname: string | undefined, sid: string, ifname: string, speed: number | null, i: unknown, o: unknown) => {
    const d = dname ? devices.get(dname) : undefined;
    if (!d || seen.has(sid)) return;
    const node = nodes.get(sid) ?? {};
    seen.add(sid);
    const bin = clean(i).map((v) => Math.round((v * 8) / 300));
    const bout = clean(o).map((v) => Math.round((v * 8) / 300));
    const util = speed && (bin.length || bout.length) ? round((Math.max(...bin, ...bout) / (speed * 1e6)) * 100) : null;
    const e = errs.get(sid) ?? {};
    const flag: Iface["flag"] = util == null ? null : util > 100 ? "inconsistent" : util >= T.util_crit ? "saturated" : util >= T.util_warn ? "high" : null;
    d.interfaces.push({
      id: sid.startsWith("EXT_NETWORK_INTERFACE") ? sid : undefined, name: ifname || node.name, speed, oper: node.operational_status || "unknown", admin: node.admin_status || "unknown",
      type: node.interface_type, util, in: bin, out: bout,
      errors: (e.ie ?? 0) + (e.oe ?? 0), discards: (e.idc ?? 0) + (e.odc ?? 0), crc: e.crc ?? 0,
      uplink: isUplink(ifname, speed), flag,
    });
  };
  // every family's ports, the first family to report a port winning (network_device comes first)
  for (const row of LF("ifTraffic")) {
    const d = devFor(row);
    const s = clean(row.s);
    const speed = s.length ? s[s.length - 1] : num(row["if.speed"]) || null;
    addIface(d?.name, portKey(row, d), ifName(row), speed, row.i, row.o);
  }
  for (const [sid, node] of nodes) {
    if (seen.has(sid)) continue;
    const dname = chassisToName.get(node["device.chassis_mac"]);
    if (dname) addIface(dname, sid, node.name, num(node.speed), [], []);
  }

  // ---------- VLANs: the extension's VLAN table, then the VLAN interfaces a device carries ----------
  for (const row of L("vlans")) {
    const d = devFor(row);
    if (!d) continue;
    const tag = row["ex.vlan.tag"] != null ? String(row["ex.vlan.tag"]) : null;
    if (tag == null && !row["ex.vlan.name"]) continue; // a table row without a VLAN in it
    (d.vlans ??= []).push({ tag, name: String(row["ex.vlan.name"] ?? "").replace(/^"|"$/g, "") || `VLAN ${tag ?? "?"}`, source: "vlan table" });
  }
  // "Vlan20", "vlan 20", "/DMZ/VLAN_31_DMZ_SERVER", "Vl20": the number right after the word is the tag
  const VLAN_IF = /(?:^|[^a-z])vla?n[\s_.-]*(\d{1,4})(?!\d)|^vl(\d{1,4})$/i;
  devices.forEach((d) => d.interfaces.forEach((i) => {
    const m = VLAN_IF.exec(i.name ?? "");
    if (!m && !/l3ipvlan/i.test(i.type ?? "")) return;
    const tag = m ? m[1] ?? m[2] : null;
    if (tag && (d.vlans ?? []).some((v) => v.tag === tag && v.source === "interface")) return;
    (d.vlans ??= []).push({ tag, name: i.name, source: "interface", iface: i.name, util: i.util });
  }));

  // ---------- syslog and traps ----------
  // 24 h counted per device, kind and level per hour; the records themselves only for the last 3 h
  for (const row of L("deviceLogs")) {
    const d = devices.get(ipToName.get(row.ip) ?? "");
    if (!d) continue;
    const hours = (Array.isArray(row.n) ? row.n : []).slice(-24).map((v: unknown) => num(v) ?? 0);
    const total = hours.reduce((a: number, b: number) => a + b, 0);
    if (row.kind === "trap") {
      d.traps += total;
      d.trapTs = (d.trapTs ?? new Array(24).fill(0)).map((v, i) => v + (hours[i] ?? 0));
    } else {
      if (row.loglevel in d.syslog) d.syslog[row.loglevel as "ERROR"] += total;
      if (row.loglevel === "ERROR") d.syslogErrTs = hours;
    }
  }
  const logRecent = L("deviceLogsRecent");
  for (const row of logRecent.filter((r) => r.kind !== "trap")) {
    const d = devices.get(ipToName.get(row.ip) ?? "");
    if (!d || d.events.length >= 30) continue;
    const app = String(row.app ?? "");
    const m = app.match(/%([A-Z0-9_]+)-(\d)-([A-Z0-9_]+)/);
    d.events.push({ t: String(row.timestamp).slice(0, 19) + "Z", kind: "syslog", level: row.loglevel, mnemonic: app || null, sev: m ? Number(m[2]) : null, text: String(row.content ?? "").slice(0, 180) });
  }
  const trapRows = logRecent.filter((r) => r.kind === "trap");
  const traps = trapRows.map((row) => ({ t: String(row.timestamp).slice(0, 19) + "Z", ip: row.ip, device: ipToName.get(row.ip) ?? null, oid: row.oid }));
  for (const [k, row] of trapRows.entries()) {
    const t = traps[k];
    const d = t.device ? devices.get(t.device) : undefined;
    if (!d) continue;
    if (d.events.filter((e) => e.kind === "trap").length < 5) {
      d.events.push({ t: t.t, kind: "trap", level: "INFO", mnemonic: t.oid, sev: null, text: String(row.content ?? "").replace(/\n/g, " ").slice(0, 160) } as NetEvent);
    }
  }
  devices.forEach((d) => d.events.sort((a, b) => b.t.localeCompare(a.t)));

  // ---------- topology facts ----------
  const links: NetworkModel["links"] = L("lldp").filter((x) => x["neighbor.sys.name"]).map((x) => ({ a: x["sys.name"], b: x["neighbor.sys.name"], kind: "LLDP", label: `remote port ${x["neighbor.port.id"] ?? "?"}` }));
  // the documented topology first: Smartscape "calls" between network devices, or between their interfaces
  const macOwner = new Map<string, string>();
  byName.forEach((d, n) => { if (d.chassis_mac) macOwner.set(String(d.chassis_mac), n); });
  const ifaceOwner = new Map<string, { device: string; name: string }>();
  L("interfaces").forEach((x) => { const dev = macOwner.get(String(x["device.chassis_mac"] ?? "")); if (dev) ifaceOwner.set(String(x.id), { device: dev, name: String(x.name ?? "") }); });
  const devName = (id: string) => { const n = idAlias.get(id); return n && byName.has(n) ? n : undefined; };
  for (const e of L("netEdges")) {
    const iface = e.source_type === "EXT_NETWORK_INTERFACE";
    const a = iface ? ifaceOwner.get(String(e.source_id)) : undefined, b = iface ? ifaceOwner.get(String(e.target_id)) : undefined;
    const from = iface ? a?.device : devName(String(e.source_id)), to = iface ? b?.device : devName(String(e.target_id));
    if (!from || !to || from === to) continue;
    links.push({ a: from, b: to, kind: "Smartscape", label: iface ? `${a!.name} → ${b!.name}` : "device to device", ...(iface ? { ifA: a!.name, ifAId: String(e.source_id), ifB: b!.name } : {}) });
  }
  // the neighbours SNMP autodiscovery records, port to port, resolved to the monitored devices by Smartscape id
  const nameById = new Map<string, string>();
  L("devices").forEach((d) => { const n = idAlias.get(d.id); if (n && byName.has(n)) nameById.set(d.id, n); });
  const seenPort = new Set(links.map((l) => `${l.a}|${l.b}`));
  for (const x of L("neighbors")) {
    const a = nameById.get(x["dt.smartscape.ext_network_device"]), b = nameById.get(x["neighbor.ext_network_device"]) ?? x["neighbor.device.name"];
    if (!a || !b || a === b) continue;
    const key = `${a}|${b}|${x["base.interface.name"]}`;
    if (seenPort.has(key) || seenPort.has(`${a}|${b}`)) continue;
    seenPort.add(key);
    links.push({
      a, b, kind: String(x["neighbor.protocol"] ?? "lldp").toUpperCase(), label: `${x["base.interface.name"] ?? "?"} → ${x["neighbor.interface.name"] ?? "?"}`,
      ifA: x["base.interface.name"] ?? undefined, ifAId: x["dt.smartscape.ext_network_interface"] ?? undefined, ifB: x["neighbor.interface.name"] ?? undefined,
    });
  }
  // one link per cable: Smartscape reports an edge per direction and per interface, and LLDP, CDP and the
  // discovery logs report the same neighbours again. Links on distinct ports stay (a bundle is several
  // cables); a link with no port is kept only when nothing on the pair says which port it is.
  const withPort = new Set<string>(), seenLink = new Set<string>();
  const pairOf = (l: (typeof links)[number]) => [l.a, l.b].sort().join("|");
  links.forEach((l) => { if (l.ifA || l.ifB) withPort.add(pairOf(l)); });
  const uniqueLinks = links.filter((l) => {
    const pair = pairOf(l);
    const key = l.ifA || l.ifB ? [`${l.a}:${l.ifA ?? ""}`, `${l.b}:${l.ifB ?? ""}`].sort().join("|") : pair;
    if ((!l.ifA && !l.ifB && withPort.has(pair)) || seenLink.has(key)) return false;
    seenLink.add(key);
    return true;
  });
  links.length = 0;
  links.push(...uniqueLinks);
  const peerMap = new Map<string, Peer>();
  for (const x of L("routing")) {
    if (x["cbgp.remote.identifier"]) peerMap.set(`bgp|${x["sys.name"]}|${x["cbgp.remote.identifier"]}`, { device: x["sys.name"], proto: "BGP", peer: x["cbgp.remote.identifier"], remoteAs: x["cbgp.remote.as"] ?? null, state: x["cbgp.peer.state"] ?? null });
    else if (String(x["metric.key"]).includes("ospf")) peerMap.set(`ospf|${x["sys.name"]}|${x["ospf.nbr.ip.addr"]}`, { device: x["sys.name"], proto: "OSPF", peer: x["ospf.nbr.ip.addr"] ?? "vizinho", remoteAs: null, state: x["ospf.nbr.state"] ?? null });
  }
  const peers = [...peerMap.values()];

  // ---------- synthetic ICMP reachability per device ----------
  const icmpByIp = new Map<string, { monitorId?: string; rttMs: number | null; rtt: number[]; loss: number | null; sent: number }>();
  for (const row of L("icmp")) {
    const ip = row["request.target_address"];
    const rtt = clean(row.rtt), sent = clean(row.sent).reduce((a, b) => a + b, 0), recv = clean(row.recv).reduce((a, b) => a + b, 0);
    const cur = icmpByIp.get(ip);
    if (cur && cur.sent >= sent) continue;
    icmpByIp.set(ip, { monitorId: row["dt.entity.multiprotocol_monitor"] ?? undefined, rttMs: rtt.length ? round(rtt[rtt.length - 1], 2) : null, rtt: rtt.map((v) => round(v, 3)), loss: sent ? round(100 * (1 - recv / sent), 2) : null, sent });
  }
  devices.forEach((d) => { d.icmp = icmpByIp.get(d.ip) ?? null; });

  // ---------- what stopped answering, and since when (last 2 h in 5-minute steps) ----------
  const icmpDownSince = new Map<string, string>();
  const recent = new Map<string, Rec>();
  for (const row of L("icmpNow")) {
    const sent = (row.sent ?? []).map((v: unknown) => num(v) ?? 0), recv = (row.recv ?? []).map((v: unknown) => num(v) ?? 0);
    const since = deadSince(row, sent, (i) => sent[i] > 0 && recv[i] === 0);
    const key = row["primary_tags.circuit_id"] ?? row["request.target_address"];
    recent.set(key, row);
    if (since && sent.filter((v: number, i: number) => v > 0 && recv[i] === 0).length >= 2) icmpDownSince.set(key, since);
  }
  devices.forEach((d) => {
    const since = icmpDownSince.get(d.ip) ?? (d.icmp ? undefined : snmpSilentSince.get(d.name));
    if (since) d.unreachableSince = since;
  });

  // ---------- WAN circuits from the circuit tags on the ICMP monitors ----------
  const circuitRows = new Map<string, Rec>();
  for (const row of L("icmp")) {
    const id = tag(row, "circuit_id");
    if (!id) continue;
    const cur = circuitRows.get(id);
    if (!cur || clean(row.sent).reduce((a, b) => a + b, 0) > clean(cur.sent).reduce((a, b) => a + b, 0)) circuitRows.set(id, row);
  }
  const circuits: Circuit[] = [...circuitRows].map(([id, row]) => {
    const now = recent.get(id);
    const rtt = clean(now?.rtt ?? row.rtt), since = icmpDownSince.get(id);
    const sent = clean(now?.sent ?? []).slice(-12).reduce((a, b) => a + b, 0), recv = clean(now?.recv ?? []).slice(-12).reduce((a, b) => a + b, 0);
    const mean = rtt.length ? rtt.reduce((a, b) => a + b, 0) / rtt.length : 0;
    const site = tag(row, "site") ?? "—";
    return {
      id, monitorId: row["dt.entity.multiprotocol_monitor"] ?? undefined, site, siteName: site, kind: tag(row, "circuit_role") === "backup" ? "backup" : "primary",
      carrier: tag(row, "carrier") ?? "Unknown carrier", tech: tag(row, "circuit_tech") ?? (tag(row, "bandwidth_mbps") ? `${tag(row, "bandwidth_mbps")} Mbps` : "WAN link"),
      slaMs: num(tag(row, "sla_ms")) ?? 100,
      latencyMs: since ? null : rtt.length ? round(rtt[rtt.length - 1], 1) : null,
      rttTs: Array.isArray(row.rtt) ? (row.rtt as unknown[]).map((v) => (typeof v === "number" ? round(v, 1) : null)) : [],
      lossPct: since ? 100 : sent ? round(100 * (1 - recv / sent), 2) : null,
      jitterMs: since || rtt.length < 2 ? null : round(Math.sqrt(rtt.reduce((a, v) => a + (v - mean) ** 2, 0) / rtt.length), 1),
      status: since ? "down" : "up", ...(since ? { since } : {}), verdict: "Healthy", reasons: [],
    };
  });

  // ---------- consequences: what went dark because something upstream failed ----------
  // A hub router logging that a branch neighbour went down is reporting the branch's WAN failure, not its own.
  const lostPeers = new Set(circuits.filter((c) => c.status === "down").flatMap((c) => [...devices.values()].filter((d) => d.site === c.site && d.role === "edge").map((d) => d.ip)));
  devices.forEach((d) => d.events.forEach((e) => {
    if (e.kind === "syslog" && [...lostPeers].some((ip) => new RegExp(`\\b${ip.replace(/\./g, "\\.")}\\b`).test(e.text))) e.sev = null;
  }));
  const siteCodes = new Set([...devices.values()].map((d) => d.site));
  for (const code of siteCodes) {
    const ds = [...devices.values()].filter((d) => d.site === code);
    const cs = circuits.filter((c) => c.site === code);
    const edge = ds.find((d) => d.role === "edge" && d.unreachableSince);
    const wanDown = cs.length > 0 && cs.every((c) => c.status === "down");
    // SNMP availability is hourly: a device cannot look silent before the link that carries it went down
    const clamp = (d: Device, from?: string | null) => { if (d.unreachableSince && from && d.unreachableSince < from) d.unreachableSince = from; };
    const wanSince = wanDown ? cs.map((c) => c.since ?? "").sort()[0] : null;
    ds.forEach((d) => {
      if (d.unreachableSince && wanDown) clamp(d, wanSince);
      else if (d.unreachableSince && edge && d !== edge) clamp(d, edge.unreachableSince);
    });
  }

  // ---------- per-device interface summary (the only interface data in a large estate) ----------
  // families overlap (the common set and the vendor set count the same ports): the busiest and the most
  // ports any family saw, never their sum
  for (const row of LF("ifSummary")) {
    const d = devFor(row);
    if (!d) continue;
    const cur = d.ifStats ?? { maxUtil: null, interfaces: 0, errors: 0, discards: 0 };
    const util = num(row.maxUtil);
    d.ifStats = { ...cur, maxUtil: util == null ? cur.maxUtil : Math.max(cur.maxUtil ?? 0, util), interfaces: Math.max(cur.interfaces, num(row.interfaces) ?? 0) };
  }
  const errDone = new Set<string>();
  for (const row of LF("errSummary")) {
    const d = devFor(row);
    if (!d || errDone.has(d.name)) continue;
    errDone.add(d.name);
    d.ifStats = { maxUtil: d.ifStats?.maxUtil ?? null, interfaces: d.ifStats?.interfaces ?? 0, errors: num(row.errors) ?? 0, discards: num(row.discards) ?? 0 };
  }

  // ---------- open Davis problems per device and per WAN circuit ----------
  // Devices match by Smartscape or classic id. Circuits match by their monitor; a device matches a monitor
  // only when that monitor pings this device alone (a monitor covering many targets can't point to one device).
  const byEntity = new Map<string, Device>();
  devices.forEach((d) => { byEntity.set(d.id, d); if (d.idClassic) byEntity.set(d.idClassic, d); });
  // alert templates raise most of their problems on interfaces (saturation, CRC, drops, flapping …),
  // so an interface problem is carried by the device that owns the interface, named after it
  const byInterface = new Map<string, { device: Device; iface: string }>();
  devices.forEach((d) => d.interfaces.forEach((i) => { if (i.id) byInterface.set(i.id, { device: d, iface: i.name }); }));
  // An extension alert points at that extension's own custom device (dt.entity.palo-alto:device,
  // dt.entity.snmp:…), which is a different classic id from the one Smartscape carries for the same box.
  // The name Davis reports is the same, so it is the key that actually joins the two.
  const byDeviceName = new Map([...devices.values()].map((d) => [d.name.toLowerCase(), d] as const));
  const circuitByMonitor = new Map(circuits.filter((c) => c.monitorId).map((c) => [c.monitorId!, c]));
  // a monitor problem is about the targets it pings: attach it to every device behind that monitor,
  // unless the monitor belongs to a WAN circuit, where the circuit already carries it
  const devicesByMonitor = new Map<string, Device[]>();
  devices.forEach((d) => {
    const mid = d.icmp?.monitorId;
    if (!mid || circuitByMonitor.has(mid)) return;
    { const l = devicesByMonitor.get(mid); if (l) l.push(d); else devicesByMonitor.set(mid, [d]); }
  });
  // What an alert names when the app cannot place it. Different environments report different things —
  // a monitor nobody tagged as a circuit, a metric event bound to the environment, a host problem — and
  // none of them may disappear from the app just because it has no home on the map.
  const NET_ENTITY = /^(EXT_NETWORK_DEVICE|EXT_NETWORK_INTERFACE|MULTIPROTOCOL_MONITOR|NETWORK_AVAILABILITY_MONITOR|SYNTHETIC_LOCATION)-/;
  // What a problem outside this inventory is about. The app shows no detail of these — it only needs to
  // know that something that is NOT the network is alerting, to isolate the network in or out.
  // classic and Smartscape type names both (measured on fxz0998d: FRONTEND carries the native "Traffic
  // drop", databases are DB_INSTANCE_POSTGRES / DB_INSTANCE_MYSQL, cloud hosts AWS_EC2_INSTANCE)
  const APP_ENTITY = /^(APPLICATION|MOBILE_APPLICATION|CUSTOM_APPLICATION|SYNTHETIC_TEST|HTTP_CHECK|BROWSER_MONITOR|FRONTEND|MOBILE_FRONTEND)-/;
  // databases at any level (instance, database, table, index) and Kubernetes workloads are services here
  const SERVICE_ENTITY = /^(SERVICE|CLOUD_APPLICATION|CLOUD_APPLICATION_INSTANCE|QUEUE|DATABASE|DB_[A-Z]+_[A-Z_]+|AWS_LAMBDA_FUNCTION|AZURE_FUNCTION_APP|GCP_CLOUD_FUNCTION|K8S_DEPLOYMENT|K8S_STATEFULSET|K8S_DAEMONSET|K8S_CRONJOB|K8S_JOB|K8S_POD)-/;
  const HOST_ENTITY = /^(HOST|PROCESS_GROUP|PROCESS_GROUP_INSTANCE|KUBERNETES_NODE|K8S_NODE|K8S_CLUSTER|KUBERNETES_CLUSTER|DISK|CONTAINER_GROUP_INSTANCE|AWS_EC2_INSTANCE|AWS_ECS_CLUSTER|AZURE_VM|GCP_COMPUTE_INSTANCE)-/;
  const scopeOf = (ids: string[]): NonNetworkScope | "network" | "environment" => {
    if (ids.some((id) => NET_ENTITY.test(id))) return "network";
    if (!ids.length || ids.every((id) => id.startsWith("ENVIRONMENT-"))) return "environment";
    if (ids.some((id) => APP_ENTITY.test(id))) return "application";
    if (ids.some((id) => SERVICE_ENTITY.test(id))) return "service";
    if (ids.some((id) => HOST_ENTITY.test(id))) return "host";
    return "other";
  };

  const coveredEventIds = new Set<string>();
  const unmappedAlerts: DeviceProblem[] = [];
  for (const p of L("problems")) {
    ((p["dt.davis.event_ids"] ?? []) as unknown[]).forEach((id) => coveredEventIds.add(String(id)));
    const { ids, names: entityNames } = entitiesOf(p);
    const base = {
      eventId: String(p["event.id"]), eventKind: String(p["event.kind"] ?? "DAVIS_PROBLEM"), displayId: String(p.display_id ?? ""),
      name: String(p["event.name"] ?? ""), start: String(p["event.start"] ?? ""), category: p["event.category"] ? String(p["event.category"]) : undefined,
      muted: String(p["dt.davis.mute.status"] ?? "NOT_MUTED") !== "NOT_MUTED" || p["maintenance.is_under_maintenance"] === true,
      ...(num(p["event.severity"]) != null ? { severity: num(p["event.severity"])! } : {}),
      ...(p["maintenance.is_under_maintenance"] === true ? { maintenance: true } : {}),
    };
    const rootId = (p["root_cause.smartscape_entity"] as { id?: string } | null)?.id ?? null;
    const onDevice = new Map<Device, string | undefined>();
    entityNames.forEach((n) => {
      const d = byDeviceName.get(String(n).toLowerCase());
      if (d) onDevice.set(d, onDevice.get(d));
    });
    ids.forEach((id) => {
      const direct = byEntity.get(id);
      if (direct) onDevice.set(direct, onDevice.get(direct));
      const viaIface = byInterface.get(id);
      if (viaIface) onDevice.set(viaIface.device, viaIface.iface);
      (devicesByMonitor.get(id) ?? []).forEach((d) => onDevice.set(d, onDevice.get(d)));
    });
    const onCircuits = new Set(ids.map((id) => circuitByMonitor.get(id)).filter((c): c is Circuit => !!c));
    if (!onDevice.size && !onCircuits.size) {
      unmappedAlerts.push({ ...base, scope: scopeOf(ids), entities: entityNames });
    }
    onDevice.forEach((on, d) => { (d.problems ??= []).push({ ...base, ...(on ? { on } : {}), ...(rootId && rootId === d.id ? { rootCause: true } : {}) }); });
    onCircuits.forEach((c) => { (c.problems ??= []).push(base); });
  }

  // ---------- every other native mechanism: metric events, anomaly detectors, synthetic and
  // infrastructure events, custom alerts — including the ones Davis never folded into a problem.
  for (const e of L("alerts")) {
    const id = String(e["event.id"] ?? "");
    if (!id || coveredEventIds.has(id)) continue; // already shown through its problem
    const type = String(e["event.type"] ?? "EVENT");
    const alert: DeviceProblem = {
      eventId: id, eventKind: String(e["event.kind"] ?? "DAVIS_EVENT"), displayId: "",
      name: String(e["event.name"] ?? type), start: String(e["event.start"] ?? ""),
      category: e["event.category"] ? String(e["event.category"]) : type,
      muted: String(e["dt.davis.mute.status"] ?? "NOT_MUTED") !== "NOT_MUTED" || e["maintenance.is_under_maintenance"] === true,
      ...(num(e["event.severity"]) != null ? { severity: num(e["event.severity"])! } : {}),
      ...(e["maintenance.is_under_maintenance"] === true ? { maintenance: true } : {}),
    };
    const ids = [
      ...entitiesOf(e).ids,
      e["dt.source_entity"] ? String(e["dt.source_entity"]) : null,
      e["dt.smartscape.ext_network_device"] ? String(e["dt.smartscape.ext_network_device"]) : null,
      e["dt.entity.multiprotocol_monitor"] ? String(e["dt.entity.multiprotocol_monitor"]) : null,
    ].filter((x): x is string => !!x);
    const ifaceId = e["dt.smartscape.ext_network_interface"] ? String(e["dt.smartscape.ext_network_interface"]) : null;

    const hit = new Map<Device, string | undefined>();
    entitiesOf(e).names.forEach((n) => {
      const d = byDeviceName.get(String(n).toLowerCase());
      if (d) hit.set(d, hit.get(d));
    });
    ids.forEach((x) => {
      const direct = byEntity.get(x);
      if (direct) hit.set(direct, hit.get(direct));
      (devicesByMonitor.get(x) ?? []).forEach((d) => hit.set(d, hit.get(d)));
    });
    if (ifaceId) { const via = byInterface.get(ifaceId); if (via) hit.set(via.device, via.iface); }
    const onCircuits = new Set(ids.map((x) => circuitByMonitor.get(x)).filter((c): c is Circuit => !!c));

    if (!hit.size && !onCircuits.size) {
      unmappedAlerts.push({ ...alert, scope: scopeOf([...ids, ...(ifaceId ? [ifaceId] : [])]), entities: entitiesOf(e).names });
      continue;
    }
    hit.forEach((on, d) => { (d.problems ??= []).push(on ? { ...alert, on } : alert); });
    onCircuits.forEach((c) => { (c.problems ??= []).push(alert); });
  }

  // ---------- verdicts (verdict.ts) ----------
  devices.forEach((d) => { [d.verdict, d.reasons, d.impact] = deviceVerdict(d); });
  const devList = [...devices.values()];

  // ---------- application hop from OneAgent network flows ----------
  const clusters: CloudCluster[] = L("cloud").map((x) => {
    const pkts = num(x.pkts) ?? 0;
    return {
      name: x.cluster || (x.cloud ? `${x.cloud} hosts` : "on-premises hosts"), cloud: x.cloud ?? null,
      conv: num(x.conv) ?? 0, hosts: num(x.hosts) ?? 0, procs: num(x.procs) ?? 0, bytes: num(x.bytes) ?? 0,
      retrPct: pkts ? round((100 * (num(x.retr) ?? 0)) / pkts, 3) : null, rttMs: null,
    };
  });

  // ---------- sites (site tags first, then device location and naming) ----------
  const sites: Record<string, Site> = {};
  for (const d of devList) {
    if (!sites[d.site]) sites[d.site] = { code: d.site, name: d.site };
  }
  const mostCommon = (xs: string[]) => [...xs].sort((a, b) => xs.filter((x) => x === b).length - xs.filter((x) => x === a).length)[0];
  for (const code of Object.keys(sites)) {
    const t = siteTags.get(code);
    const hint = siteHints.get(code);
    const city = hint?.cities.length ? mostCommon(hint.cities) : undefined;
    const uf = hint?.uf?.toUpperCase();
    const state = hint?.country && hint.country.toUpperCase() !== "BR" ? undefined : uf ? BR_UF[uf] : undefined;
    if (t) {
      const lat = num(tag(t, "geo_lat")), lon = num(tag(t, "geo_lon"));
      Object.assign(sites[code], {
        name: tag(t, "site_name") ?? city ?? code, city: tag(t, "city") ?? city, uf: tag(t, "state") ?? uf,
        region: tag(t, "region") ?? state?.[0], hub: tag(t, "hub") ?? undefined, dc: tag(t, "site_type") === "datacenter" || DC_NAME.test(code),
        ...(lat != null && lon != null ? { lat, lon } : {}),
      });
      if (sites[code].hub === code) delete sites[code].hub;
    } else {
      // no site tag: the city from sysLocation, else the most common location text
      const locs = devList.filter((d) => d.site === code && d.location).map((d) => String(d.location));
      sites[code].name = city ?? mostCommon(locs) ?? code;
      if (city) sites[code].city = city;
      if (uf) sites[code].uf = uf;
      if (state) sites[code].region = state[0];
      if (DC_NAME.test(code) || DC_NAME.test(sites[code].name) || hint?.dc) sites[code].dc = true;
      const place = placeOf(code, sites[code].name);
      if (place) Object.assign(sites[code], place);
    }
    // nothing gives coordinates: place the site at the centre of its state and say it is approximate
    if (sites[code].lat == null && state) Object.assign(sites[code], { lat: state[1], lon: state[2], approx: "state" as const });
  }
  // sites that share a state centre are spread a little around it, so none hides another
  const byCentre = new Map<string, Site[]>();
  Object.values(sites).filter((x) => x.approx === "state").forEach((x) => { const k = `${x.lat},${x.lon}`; { const l = byCentre.get(k); if (l) l.push(x); else byCentre.set(k, [x]); } });
  byCentre.forEach((group) => {
    if (group.length < 2) return;
    group.sort((a, b) => a.code.localeCompare(b.code)).forEach((x, i) => {
      const a = (2 * Math.PI * i) / group.length;
      x.lat = (x.lat as number) + 1.8 * Math.sin(a); x.lon = (x.lon as number) + 1.8 * Math.cos(a);
    });
  });
  circuits.forEach((c) => { c.siteName = sites[c.site]?.name ?? c.site; });

  // primary tags per site: the most common value of each primary_tags.* key among its devices
  const tagVotes = new Map<string, Map<string, Map<string, number>>>();
  for (const [name, d] of byName) {
    const code = devices.get(name)?.site;
    if (!code) continue;
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith("primary_tags.") || v == null || v === "") continue;
      const value = String(Array.isArray(v) ? v[0] : v);
      const perSite = tagVotes.get(code) ?? new Map<string, Map<string, number>>();
      const perKey = perSite.get(k) ?? new Map<string, number>();
      perKey.set(value, (perKey.get(value) ?? 0) + 1);
      perSite.set(k, perKey); tagVotes.set(code, perSite);
    }
  }
  tagVotes.forEach((perSite, code) => {
    if (!sites[code]) return;
    sites[code].tags = Object.fromEntries([...perSite].map(([k, votes]) => [k, [...votes].sort((a, b) => b[1] - a[1])[0][0]]));
  });

  // ---------- one end-to-end path per site ----------
  const lan = (): PathLink => ({ kind: "lan", verdict: "Not monitored", label: "LAN", facts: [] });
  const cloud = cloudHop(clusters);
  const paths: E2EPath[] = [];
  for (const code of Object.keys(sites)) {
    const site = sites[code];
    const cs = circuits.filter((c) => c.site === code);
    const sitePeers = peers.filter((p) => devices.get(p.device)?.site === code);
    if (!site.dc && (cs.length || site.hub)) {
      // branch: access → edge → WAN links → hub core → hub security → applications
      const hub = site.hub && sites[site.hub] ? site.hub : null;
      const hops = [
        deviceHop(devList, "Access", "Switching and Wi-Fi", code, ["switch", "ap", "wlc", "compute", "endpoint", "other", "core"]),
        deviceHop(devList, "Edge", "Router and firewall", code, ["edge", "firewall", "lb"]),
        cs.length ? circuitHop(cs, code) : null,
        hub ? deviceHop(devList, "Data center", "Concentrator and core", hub, ["core", "edge"]) : null,
        hub ? deviceHop(devList, "Security", "Firewall and load balancer", hub, ["firewall", "lb"]) : null,
        cloud,
      ].filter((h): h is Hop => !!h);
      if (cs.length) site.wanVerdict = hops.find((h) => h.kind === "circuit")!.verdict;
      const bgpUp = sitePeers.filter((p) => p.proto === "BGP").every((p) => (p.state ?? "").startsWith("established"));
      const links = hops.slice(1).map((h, i): PathLink => {
        const prev = hops[i];
        if (h.kind === "circuit") return { kind: "wan", verdict: h.verdict, label: "Access", facts: [cs[0].tech.split(" ")[0]] };
        if (prev.kind === "circuit") return { kind: "wan", verdict: sitePeers.length ? (bgpUp ? "Healthy" : "Critical") : "Not monitored", label: "Tunnel", facts: sitePeers.length ? [`BGP ${bgpUp ? "established" : "down"}`] : [] };
        if (h.kind === "cloud") return { kind: "flow", verdict: h.verdict, label: "Flows", facts: [`${(h.stats.conv ?? 0).toLocaleString("en-US")} conversations`] };
        return lan();
      });
      paths.push(makePath(`site-${code}`, `${site.name} → applications${hub ? ` at ${sites[hub].name}` : ""}`, hops, links, code));
      continue;
    }
    const hops = [
      deviceHop(devList, "Access", "Switching and Wi-Fi", code, ["switch", "ap", "wlc", "compute", "endpoint", "other"]),
      deviceHop(devList, "Core", "Core router", code, ["core"]),
      deviceHop(devList, "Security", "Firewall and LB", code, ["firewall", "lb"]),
      deviceHop(devList, "Edge", "Edge router", code, ["edge"]),
    ].filter((h): h is NonNullable<typeof h> => !!h);
    const links: PathLink[] = hops.slice(1).map(lan);
    const inet = internetHop(sitePeers);
    if (inet) { links.push({ kind: "bgp", verdict: inet.verdict, label: "BGP", facts: [String(inet.headline.value) + " established"] }); hops.push(inet); }
    if (cloud) { links.push({ kind: "flow", verdict: cloud.verdict, label: "Flows", facts: [`${(cloud.stats.conv ?? 0).toLocaleString("en-US")} conversations`] }); hops.push(cloud); }
    if (!hops.length) continue;
    paths.push(makePath(`site-${code}`, `${site.name} → ${inet ? "Internet → " : ""}applications`, hops, links, code));
  }
  const siteVerdicts: Record<string, Verdict> = {};
  for (const p of paths) if (p.site) siteVerdicts[p.site] = worst([p.summary.verdict, ...devList.filter((d) => d.site === p.site).map((d) => d.verdict)]);

  // ---------- NetFlow exporters ----------
  // protocols per exporter come from the conversation groups, not from a query of their own
  const proto = new Map<string, Map<string, { proto: string; gb: number; flows: number }>>();
  for (const x of L("flowNets")) {
    const m = proto.get(x.exp) ?? new Map();
    const p = m.get(x.proto) ?? { proto: x.proto, gb: 0, flows: 0 };
    p.gb += (num(x.bytes) ?? 0) / 1e9; p.flows += num(x.flows) ?? 0;
    m.set(x.proto, p); proto.set(x.exp, m);
  }
  const exporters = L("flowTs").map((x) => ({
    ip: x.exp, device: ipToName.get(x.exp) ?? null, flows5m: clean(x.flows),
    protocols: [...(proto.get(x.exp)?.values() ?? [])].map((p) => ({ ...p, gb: Math.round(p.gb) })).sort((a, b) => b.flows - a.flows).slice(0, 8),
  }));

  // ---------- real user sessions ----------
  // The only thing the app asks of them: were people still using the applications while the network
  // misbehaved. A session is attributed to a site only when its client subnet matches exactly — the
  // site_cidr tag, or the /24 of a device at that site. A looser match (the /16 of a corporate range)
  // would spread one site's users over a whole region, so it is not attempted.
  const addressing = buildAddressing(
    [...siteTags].map(([site, rec]) => ({ site, cidr: tag(rec, "site_cidr") ?? "" })),
    devList.map((d) => ({ site: d.site, ips: [d.ip, ...(d.ips ?? [])].filter(Boolean) })),
  );
  const users = buildUsers(L, addressing, unmappedAlerts);

  return {
    meta: { tenant, generatedAt: new Date().toISOString().slice(0, 16) + "Z", thresholds: T },
    users,
    sites, siteVerdicts,
    devices: devList.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact - a.impact || a.name.localeCompare(b.name)),
    circuits, links, peers, traps, unmappedAlerts,
    extensions: [...new Set(["ifTraffic", "ifSummary", "cpu", "memory", "uptime"].flatMap((k) => LF(k).map((row) => String(row.family ?? ""))).filter(Boolean))],
    flows: {
      exporters,
      top: [],
    },
    appNet: buildAppNet(L),
    paths: buildPaths(L, addressing),
    flowMap: buildFlowMap(L, devList, addressing, sites),
    oneagent: L("cloudTop").map((x) => ({ host: x.host, cluster: x.cluster ?? null, dst: x.dst, dport: String(x.dport ?? ""), bytes: num(x.bytes) ?? 0, retr: num(x.retr) ?? 0, resets: num(x.resets) ?? 0, rttMs: null })),
    e2e: { probe: "synthetic ICMP monitors", paths },
  };
}
