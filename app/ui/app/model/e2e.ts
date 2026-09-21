// End-to-end path aggregation (kept 1:1 with scripts/e2e.py). A hop whose only reasons
// are consequences of an upstream outage is never reported as the probable cause.
import type { AppExperience, Circuit, CloudCluster, Device, E2EPath, Hop, PathLink, Peer, Reason, Verdict } from "./types";
import { T, ORDER, worst, isBad, circuitVerdict, appVerdict, openProblems } from "./verdict";

const rootFirst = (rs: Reason[]) => [...rs].sort((a, b) => Number(!!a.consequence) - Number(!!b.consequence) || ORDER[a.level] - ORDER[b.level]);
const maxOf = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.max(...v) : null; };
const minOf = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.min(...v) : null; };

export function deviceHop(devices: Device[], layer: string, title: string, site: string, roles: string[]): Hop | null {
  const ds = devices.filter((d) => d.site === site && roles.includes(d.role));
  if (!ds.length) return null;
  const mon = ds.filter((d) => d.mode === "Extension");
  const upl = mon.flatMap((d) => d.interfaces.filter((i) => i.uplink));
  const reasons = rootFirst(mon.flatMap((d) => d.reasons.map((r) => ({ ...r, device: d.name }))));
  const st = {
    rttMax: maxOf(ds.map((d) => d.icmp?.rttMs)),
    lossMax: maxOf(ds.map((d) => d.icmp?.loss)),
    cpuMax: maxOf(mon.map((d) => d.cpuNow)),
    utilMax: upl.length ? maxOf(upl.filter((i) => i.flag !== "inconsistent").map((i) => i.util)) : maxOf(mon.map((d) => d.ifStats?.maxUtil)),
    uplErr: upl.length ? upl.filter((i) => i.errors || i.crc).length : mon.filter((d) => (d.ifStats?.errors ?? 0) > 0).length,
    uplDown: upl.filter((i) => i.oper.startsWith("down") && i.admin.startsWith("up")).length,
    availMin: minOf(mon.map((d) => d.availPct)),
    total: ds.length,
    blind: ds.filter((d) => d.mode !== "Extension").map((d) => d.name),
    unreachable: ds.filter((d) => d.unreachableSince).length,
    critEvents: ds.reduce((a, d) => a + d.events.filter((e) => e.kind === "syslog" && e.sev != null && e.sev <= T.syslog_sev_warn).length, 0),
  };
  const top = reasons[0];
  // What the hop shows: the alerts open on it first, because that is what decides its status now.
  // Otherwise the first measurement the devices actually have, and a plain reason when they have none.
  const alerts = ds.reduce((a, d) => a + openProblems(d.problems).length, 0);
  let head: Hop["headline"];
  if (alerts) head = { value: alerts, unit: "", label: alerts > 1 ? "open alerts" : "open alert" };
  else if (st.unreachable) head = { value: st.unreachable, unit: "", label: "no response" };
  else if (st.rttMax != null) head = { value: st.rttMax, unit: "ms", label: "max ICMP round trip" };
  else if (st.cpuMax != null) head = { value: Math.round(st.cpuMax), unit: "%", label: "max CPU" };
  else if (st.availMin != null) head = { value: st.availMin, unit: "%", label: "min SNMP availability" };
  else if (st.utilMax != null) head = { value: st.utilMax, unit: "%", label: "max uplink" };
  else if (st.blind.length === st.total) head = { value: "—", unit: "", label: "no polling extension" };
  else head = { value: "—", unit: "", label: "no metric yet" };
  return {
    kind: "devices", layer, title, site, verdict: worst(ds.map((d) => d.verdict)), headline: head, stats: st,
    devices: [...ds].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]).map((d) => d.name),
    topReason: top ? `${top.device}: ${top.text}` : null,
    consequenceOnly: reasons.length > 0 && reasons.every((r) => r.consequence),
    incidents: ds.map((d) => d.incident).filter((x): x is string => !!x),
  };
}

export function circuitHop(circuits: Circuit[], site = "WAN"): Hop {
  circuits.forEach((c) => { [c.verdict, c.reasons] = circuitVerdict(c); });
  const up = circuits.filter((c) => c.status === "up");
  const measured = up.filter((c) => c.latencyMs != null);
  const reasons = rootFirst(circuits.flatMap((c) => c.reasons.filter((r) => r.level !== "Not monitored").map((r) => ({ ...r, circuit: c.id }))));
  let v = worst(circuits.map((c) => c.verdict));
  const primaryDown = circuits.find((c) => c.kind === "primary" && c.status === "down");
  if (v === "Critical" && primaryDown && measured.length) {
    v = "Warning";
    reasons.unshift({ level: "Warning", circuit: measured[0].id, text: `running on backup; primary down since ${(primaryDown.since || "").slice(11, 16)} UTC` });
  }
  const st = {
    rttMax: maxOf(measured.map((c) => c.latencyMs)),
    lossMax: maxOf(circuits.map((c) => c.lossPct)),
    jitterMax: maxOf(measured.map((c) => c.jitterMs)),
    up: up.length, links: circuits.length, availMin: null, blind: [], critEvents: 0, total: 0,
  };
  const top = reasons[0], txt = top?.text ?? "";
  let head: Hop["headline"];
  if (!measured.length && !up.length) head = { value: `0/${circuits.length}`, unit: "", label: "active links" };
  else if (!measured.length) head = { value: "—", unit: "", label: "not measured" };
  else if (top && (txt.includes("down since") || txt.includes("backup"))) head = { value: `${up.length}/${circuits.length}`, unit: "", label: "active links" };
  else if (top && txt.startsWith("packet loss")) head = { value: st.lossMax, unit: "%", label: "link loss" };
  else { const a = measured.find((c) => c.kind === "primary") ?? measured[0]; head = { value: a.latencyMs, unit: "ms", label: `latency · SLA ${a.slaMs} ms` }; }
  const name = (id?: string) => { const c = circuits.find((x) => x.id === id); return c ? `${c.kind === "primary" ? "Primary link" : "Backup link"} (${c.carrier} · ${c.tech})` : "Link"; };
  const latLevels = reasons.filter((r) => r.text.includes("latency")).map((r) => r.level);
  return {
    kind: "circuit", layer: "Carrier", title: "WAN links", site, verdict: v, headline: head, stats: st, circuits, devices: [],
    topReason: top ? `${name(top.circuit)}: ${txt}` : null, consequenceOnly: false,
    incidents: circuits.map((c) => c.incident).filter((x): x is string => !!x),
    latVerdict: latLevels.length ? worst(latLevels) : "Healthy",
  };
}

export function appHop(title: string, site: string, app: AppExperience): Hop {
  const [v, reasons] = appVerdict(app);
  const p90 = app.p90Ms;
  return {
    kind: "app", layer: "Application", title, site, verdict: v,
    headline: p90 != null ? { value: Math.round(p90 / 100) / 10, unit: "s", label: "p90 from the site" } : { value: "—", unit: "", label: "no sessions from the site" },
    stats: { p90Ms: p90, errPct: app.errPct, sessions: app.sessions, rttMax: null, lossMax: null, availMin: null, blind: [], critEvents: 0, total: 0 },
    app, devices: [], topReason: reasons[0]?.text ?? null,
    consequenceOnly: reasons.length > 0 && reasons.every((r) => r.consequence), incidents: [],
  };
}

export function internetHop(peers: Peer[]): Hop | null {
  const bgp = peers.filter((p) => p.proto === "BGP");
  if (!bgp.length) return null;
  const up = bgp.filter((p) => (p.state || "").startsWith("established")).length;
  return {
    kind: "internet", layer: "Internet", title: `Carrier AS ${bgp[0].remoteAs ?? "—"}`, site: "WAN",
    verdict: up === bgp.length ? "Healthy" : "Critical", headline: { value: `${up}/${bgp.length}`, unit: "", label: "BGP peers established" },
    stats: {}, peers: bgp, devices: [], topReason: up === bgp.length ? null : `${bgp.length - up} BGP peer(s) not established`, consequenceOnly: false, incidents: [],
  };
}

export function cloudHop(clusters: CloudCluster[]): Hop | null {
  if (!clusters.length) return null;
  const retr = Math.max(0, ...clusters.map((c) => c.retrPct ?? 0));
  // the number is shown, but alerting on it belongs to Davis: the app does not turn it into a verdict
  const v: Verdict = "Healthy";
  return {
    kind: "cloud", layer: "Application", title: "OneAgent workloads", site: "Cloud", verdict: v,
    headline: { value: Math.round(retr * 1000) / 1000, unit: "%", label: "max TCP retransmission" },
    stats: { conv: clusters.reduce((a, c) => a + c.conv, 0), hosts: clusters.reduce((a, c) => a + c.hosts, 0), procs: clusters.reduce((a, c) => a + c.procs, 0) },
    clusters, devices: [], topReason: null, consequenceOnly: false, incidents: [],
  };
}

export function makePath(id: string, name: string, hops: Hop[], links: PathLink[], site: string | null): E2EPath {
  const bad = hops.map((h, i) => (isBad(h.verdict) ? i : -1)).filter((i) => i >= 0);
  const root = bad.find((i) => !hops[i].consequenceOnly) ?? (bad.length ? bad[0] : null);
  const stats = hops.map((h) => h.stats || {});
  const circuits = hops.filter((h) => h.kind === "circuit");
  return {
    id, name, site, hops, links,
    summary: {
      verdict: worst([...hops.map((h) => h.verdict), ...links.map((l) => l.verdict)]),
      firstBad: root ?? null,
      consequenceHops: bad.filter((i) => hops[i].consequenceOnly).length,
      hops: hops.length,
      healthyHops: hops.filter((h) => h.verdict === "Healthy").length,
      rttMax: maxOf(stats.map((s) => s.rttMax)),
      lossMax: maxOf(stats.map((s) => s.lossMax)),
      availMin: minOf(stats.map((s) => s.availMin)),
      blind: stats.flatMap((s) => s.blind || []),
      critEvents: stats.reduce((a, s) => a + (s.critEvents || 0), 0),
      devices: stats.reduce((a, s) => a + (s.total || 0), 0),
      incident: hops.flatMap((h) => h.incidents || [])[0] ?? null,
      latVerdict: circuits.length ? worst(circuits.map((h) => h.latVerdict || "Healthy")) : "Healthy",
    },
  };
}
