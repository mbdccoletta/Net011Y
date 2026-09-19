// Details panel in the Delivery Chain look: a site as its end-to-end trail, its devices as
// 24-hour strips and its WAN links against their SLA; a device as instruments; a link as
// its SLA gauge. Explanations come from Dynatrace Assist; drill-downs open the native apps.
import React, { useEffect, useMemo, useState } from "react";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";
import type { Circuit, Device, E2EPath, Iface, NetworkModel } from "../model/types";
import { ownsPath, ROLE_LABEL, type SiteInfo } from "../model/site";
import { isBad, ORDER, T } from "../model/verdict";
import { fmtInt, fmtNum, hhmm } from "../utils/format";
import { deviceContext, isolationContext, siteContext } from "../utils/assist";
import { deviceQuestions, isolationQuestions, siteQuestions } from "../utils/prompts";
import { NativeDrill } from "./NativeDrill";
import { SuspicionStrip } from "./Suspicion";
import { suspicionFor } from "../model/suspicion";
import { useDropThreshold } from "../hooks/useDropThreshold";
import { AssistPanel } from "./AssistPanel";
import { Gauge, LimitLine, StatusShape, Tile, TONE, verdictTone } from "./Visual";
import { DeviceDetails, HopDetails } from "./Details";
import { DataNeeds } from "./DataNeeds";
import { VIEW_NEEDS, type Need, type NeedKey } from "../data/requirements";
import { useElementWidth } from "../hooks/useElementWidth";
import { SitePathsTile, SiteTrafficTile } from "./Traffic";

interface Props {
  needs: Record<NeedKey, Need>;
  model: NetworkModel;
  infos: SiteInfo[];
  sel: string;
  tab: string;
  onTab: (tab: string) => void;
  onSelect: (sel: string) => void;
  onClose: () => void;
}

const shortDevice = (name: string) => name.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "");

function Head({ title, verdict, subtitle, onClose }: { title: string; verdict: SiteInfo["verdict"]; subtitle: string; onClose: () => void }) {
  return (
    <div className="vz-dhead">
      <div>
        <h2><StatusShape verdict={verdict} />{title}</h2>
        <span className="vz-cap vz-mono">{subtitle}</span>
      </div>
      <button type="button" className="lm-btn" onClick={onClose} aria-label="Close details">Close</button>
    </div>
  );
}


/** The end-to-end path as a trail: the first hop with an open problem glows; what sits behind it is dashed. */
function Trail({ path, selected, onSelect }: { path: E2EPath; selected: number | null; onSelect: (i: number) => void }) {
  const n = path.hops.length;
  const [box, boxW] = useElementWidth<HTMLDivElement>(560);
  const W = Math.max(n * 96, boxW), Y = 46, R = 22;
  const x = (i: number) => 50 + (i * (W - 100)) / Math.max(1, n - 1);
  return (
    <div className="vz-scroll" ref={box}>
      <svg viewBox={`0 0 ${W} 120`} width={W} height={120} className="vz-trail" role="group" aria-label={path.name}>
        <defs><filter id="vz-glow"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        {path.hops.slice(1).map((h, k) => {
          const bad = isBad(h.verdict) || isBad(path.hops[k].verdict);
          const cause = k + 1 === path.summary.firstBad;
          return <line key={`l${k}`} x1={x(k) + R} x2={x(k + 1) - R} y1={Y} y2={Y} stroke={cause ? TONE.bad : bad ? TONE.warn : "var(--lm-line-2)"} strokeWidth={cause ? 4 : 2.5} strokeDasharray={bad ? "7 5" : undefined} filter={cause ? "url(#vz-glow)" : undefined} />;
        })}
        {path.hops.map((h, i) => {
          const cause = i === path.summary.firstBad, cons = false;
          const v = h.headline.value == null || h.headline.value === "—" ? "—" : `${typeof h.headline.value === "number" ? fmtNum(h.headline.value, 1) : h.headline.value}${h.headline.unit === "%" || h.headline.unit === "s" ? h.headline.unit : ""}`;
          const tone = verdictTone(h.verdict);
          return (
            <g key={`${h.layer}-${i}`} className="vz-trail__hop" role="button" tabIndex={0} aria-pressed={selected === i}
              aria-label={`${h.layer}: ${h.verdict}${cause ? ", probable cause" : cons ? ", consequence" : ""}`}
              onClick={() => onSelect(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}>
              {selected === i && <circle cx={x(i)} cy={Y} r={(cause ? R + 6 : R) + 6} fill="none" stroke="var(--lm-ink-hi)" strokeWidth={1.5} />}
              <circle cx={x(i)} cy={Y} r={cause ? R + 6 : R} fill="none"
                stroke={tone} strokeWidth={cause ? 3 : 2.5} strokeDasharray={cons ? "4 3" : undefined} filter={cause ? "url(#vz-glow)" : undefined} />
              <text x={x(i)} y={Y + 5} textAnchor="middle" className="vz-trail__val">{v}</text>
              <text x={x(i)} y={Y + 48} textAnchor="middle" className="vz-svg-label" fill={cause ? "var(--lm-bad)" : undefined}>{h.layer.toUpperCase()}</text>
              {(cause || cons) && <text x={x(i)} y={Y + 63} textAnchor="middle" className="vz-svg-cap" fill={cause ? "var(--lm-bad)" : "var(--lm-warn)"}>{cause ? "probable cause" : "consequence"}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One row per device: 24 hourly cells, red when the device did not answer SNMP. The status mark next to
 * the name is the device verdict, which also counts CPU, interfaces, ICMP loss and events — so a device can
 * be critical with every cell green. */
function DeviceStrips({ devices, onDevice }: { devices: Device[]; onDevice: (name: string) => void }) {
  const [all, setAll] = useState(false);
  const sorted = [...devices].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.name.localeCompare(b.name));
  const shown = all ? sorted : sorted.slice(0, 8);
  return (
    <div className="vz-strips">
      {shown.map((d) => {
        const cells = d.availTs?.length ? d.availTs : null;
        return (
          <button key={d.name} type="button" className="vz-strip" onClick={() => onDevice(d.name)} aria-label={`${d.name}, ${d.verdict}`}
            title={`${d.name} · ${d.verdict}${d.reasons[0] ? ` · ${d.reasons[0].text}` : ""}\nCells: SNMP answered each hour — the status mark also counts CPU, interfaces, ICMP and events`}>
            <span className="vz-strip__name" title={d.name}><StatusShape verdict={d.verdict} /><span className="vz-strip__label">{shortDevice(d.name)}</span></span>
            <span className="vz-strip__cells" aria-hidden="true">
              {cells ? cells.map((c, i) => <i key={i} style={{ background: c ? TONE.good : TONE.bad, opacity: c ? 0.5 : 1 }} />) : <em>not polled</em>}
            </span>
          </button>
        );
      })}
      <div className="vz-strips__axis"><span>−24 h</span><span>now</span></div>
      {sorted.length > 8 && <button type="button" className="lm-btn" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${sorted.length}`}</button>}
    </div>
  );
}

/** A circuit's latency against its SLA as a bar; down links show as a red block. */
export function SlaBars({ circuits, onLink, nameOf }: { circuits: Circuit[]; onLink: (id: string) => void; nameOf?: (c: Circuit) => string }) {
  return (
    <div className="vz-sla">
      {circuits.map((c) => {
        const ratio = c.latencyMs != null ? c.latencyMs / c.slaMs : null;
        const tone = c.status === "down" ? TONE.bad : verdictTone(c.verdict);
        return (
          <button key={c.id} type="button" className="vz-sla__row" onClick={() => onLink(c.id)} aria-label={`${c.kind} link ${c.carrier}, ${c.status === "down" ? "down" : `${c.latencyMs} ms of ${c.slaMs} ms SLA`}`}>
            <span className="vz-sla__name">{nameOf ? nameOf(c) : `${c.kind === "primary" ? "PRIMARY" : "BACKUP"} · ${c.carrier}`}</span>
            <span className="vz-sla__track">
              <i style={{ width: c.status === "down" ? "100%" : `${Math.min(100, ((ratio ?? 0) / 1.5) * 100)}%`, background: tone }} />
              <b style={{ left: `${(1 / 1.5) * 100}%` }} aria-hidden="true" />
            </span>
            <span className="vz-sla__val">{c.status === "down" ? `down ${hhmm(c.since).replace(" UTC", "")}` : c.latencyMs != null ? `${fmtNum(c.latencyMs, 0)}/${c.slaMs} ms` : "—"}</span>
          </button>
        );
      })}
    </div>
  );
}


/** Latency of a circuit per hour over the last 24 h, against its SLA. Gaps are hours with no answer. */
function LatencyOverTime({ series, sla }: { series: (number | null)[]; sla: number }) {
  const [box, W] = useElementWidth<HTMLDivElement>(560);
  const H = 96, padX = 8, padY = 12;
  const known = series.filter((v): v is number => v != null);
  if (!known.length) return <div className="vz-cap">No latency samples in the last 24 hours.</div>;
  const max = Math.max(sla * 1.15, ...known);
  const x = (i: number) => padX + (i / Math.max(1, series.length - 1)) * (W - padX * 2);
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const segments: string[] = [];
  let current: string[] = [];
  series.forEach((v, i) => {
    if (v == null) { if (current.length > 1) segments.push(current.join(" ")); current = []; return; }
    current.push(`${current.length ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));
  const over = series.map((v, i) => (v != null && v > sla ? i : -1)).filter((i) => i >= 0);
  return (
    <div className="vz-fluid" ref={box}>
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="vz-ruler vz-ruler--fit" role="img" aria-label={`Latency per hour over the last 24 hours against an SLA of ${sla} ms`}>
      {series.map((v, i) => (v == null ? <rect key={i} x={x(i) - 6} y={padY} width={12} height={H - padY * 2} fill={TONE.bad} opacity={0.14} /> : null))}
      <line x1={padX} x2={W - padX} y1={y(sla)} y2={y(sla)} stroke={TONE.warn} strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={W - padX} y={y(sla) - 5} textAnchor="end" className="vz-svg-cap" fill={TONE.warn}>SLA {sla} ms</text>
      {segments.map((d, i) => <path key={i} d={d} fill="none" stroke={TONE.good} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
      {over.map((i) => <circle key={i} cx={x(i)} cy={y(series[i] as number)} r={3.5} fill={TONE.warn} />)}
      <text x={padX} y={H - 2} className="vz-svg-cap">−24 h</text>
      <text x={W - padX} y={H - 2} textAnchor="end" className="vz-svg-cap">now</text>
    </svg>
    </div>
  );
}

/** What the site's uplink carried over the last two hours, in and out, against the interface speed. */
function UplinkOverTime({ iface }: { iface: Iface }) {
  const [box, W] = useElementWidth<HTMLDivElement>(560);
  const H = 96, padX = 8, padY = 12;
  const n = Math.max(iface.in.length, iface.out.length);
  if (!n) return <div className="vz-cap">The uplink of this site reports no traffic counters yet.</div>;
  const cap = (iface.speed ?? 0) * 1e6;
  const peak = Math.max(1, ...iface.in, ...iface.out);
  const max = Math.max(peak * 1.1, cap * 0.1);
  const x = (i: number) => padX + (i / Math.max(1, n - 1)) * (W - padX * 2);
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const mbps = (v: number) => `${fmtNum(v / 1e6, v < 1e7 ? 1 : 0)} Mbps`;
  return (
    <>
      <div className="vz-fluid" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="vz-ruler vz-ruler--fit" role="img" aria-label={`Traffic in and out of ${iface.name} over the last two hours`}>
        {cap > 0 && cap <= max && <line x1={padX} x2={W - padX} y1={y(cap)} y2={y(cap)} stroke={TONE.bad} strokeWidth={1.5} strokeDasharray="5 4" />}
        <path d={line(iface.in)} fill="none" stroke={TONE.cyan} strokeWidth={2} strokeLinejoin="round" />
        <path d={line(iface.out)} fill="none" stroke={TONE.violet} strokeWidth={2} strokeLinejoin="round" />
        <text x={padX} y={H - 2} className="vz-svg-cap">−2 h</text>
        <text x={W - padX} y={H - 2} textAnchor="end" className="vz-svg-cap">now</text>
      </svg>
      </div>
      <div className="vz-chipline">
        <span className="vz-stat"><b style={{ color: TONE.cyan }}>{mbps(iface.in[iface.in.length - 1] ?? 0)}</b>in now</span>
        <span className="vz-stat"><b style={{ color: TONE.violet }}>{mbps(iface.out[iface.out.length - 1] ?? 0)}</b>out now</span>
        <span className="vz-stat"><b>{mbps(peak)}</b>peak</span>
        {iface.speed ? <span className="vz-stat"><b>{fmtNum((100 * peak) / cap, 0)}%</b>of {fmtInt(iface.speed)} Mbps</span> : null}
      </div>
    </>
  );
}

function SiteDetails({ model, info, needs, onSelect, onClose }: { model: NetworkModel; info: SiteInfo; needs: Record<NeedKey, Need>; onSelect: (s: string) => void; onClose: () => void }) {
  const path = ownsPath(info.path, info.code) ? info.path : null;
  const [hop, setHop] = useState<number | null>(null);
  useEffect(() => { setHop(null); }, [info.code]);
  const bad = info.devices.filter((d) => isBad(d.verdict)).length;
  const dropPct = useDropThreshold();
  const suspicion = useMemo(() => suspicionFor(model, { site: info, dropPct }), [model, info, dropPct]);
  const demand = useMemo(() => {
    const u = model.users;
    const siteSessions = (u?.nets ?? []).filter((n) => n.site === info.code).reduce((a, n) => a + n.sessions, 0);
    const compact = (v: number | null | undefined) => (v == null ? "—" : v >= 1e6 ? `${fmtNum(v / 1e6, 1)}M` : v >= 1e3 ? `${fmtNum(v / 1e3, 1)}k` : fmtInt(v));
    // a site has its own sessions only when a client subnet maps to it; requests are environment-wide
    return siteSessions
      ? { sessions: compact(siteSessions), requests: compact(u?.requests?.now), caption: "sessions 24 h here · requests/h environment" }
      : { sessions: compact(u?.now), requests: compact(u?.requests?.now), caption: u ? "per hour, whole environment" : "not reported" };
  }, [model, info]);
  const since = info.devices.map((d) => d.unreachableSince).concat(info.circuits.map((c) => c.since)).filter((t): t is string => !!t).sort()[0];
  return (
    <div className="lm vz vz-details">
      <Head title={info.site.name} verdict={info.verdict} onClose={onClose}
        subtitle={[info.code, info.site.region, info.site.dc ? "data center" : info.site.hub ? `via ${model.sites[info.site.hub]?.name ?? info.site.hub}` : null, info.site.approx ? "position approximate: centre of the state" : null, since ? `since ${hhmm(since)}` : null].filter(Boolean).join(" · ")} />
      <div className="vz-k3">
        <Tile tone={bad ? TONE.bad : TONE.good} title="Devices"><div className="vz-big">{bad}<small>/{info.devices.length}</small></div><div className="vz-cap">with issues</div></Tile>
        {/* a site with no circuit tagged says so, rather than reading "0/0 up" */}
        <Tile tone={info.circuits.some((c) => c.status === "down") ? TONE.bad : TONE.accent} title="WAN links">
          {info.circuits.length
            ? <><div className="vz-big">{info.circuits.filter((c) => c.status === "up").length}<small>/{info.circuits.length}</small></div><div className="vz-cap">up</div></>
            : <><div className="vz-big">—</div><div className="vz-cap">no circuit tagged here</div></>}
        </Tile>
        {/* demand, not application detail: how many people and requests are still getting through */}
        <Tile tone={TONE.accent} title="Sessions · requests">
          <div className="vz-big">{demand.sessions}<small> / {demand.requests}</small></div>
          <div className="vz-cap">{demand.caption}</div>
        </Tile>
      </div>
      {path && (
        <Tile tone={verdictTone(info.verdict)} title="End-to-end path" right="select a hop">
          <Trail path={path} selected={hop} onSelect={(i) => setHop(hop === i ? null : i)} />
          {hop != null && path.hops[hop] && <div className="vz-hop"><HopDetails model={model} path={path} index={hop} onDevice={(n) => onSelect(`device:${n}`)} /></div>}
        </Tile>
      )}
      <Tile title={`Devices · ${info.devices.length}`} right="SNMP reachability · last 24 h">
        <DeviceStrips devices={info.devices} onDevice={(n) => onSelect(`device:${n}`)} />
      </Tile>
      {info.circuits.length > 0 && (
        <Tile title="WAN links" right="latency vs SLA">
          <SlaBars circuits={info.circuits} onLink={(id) => onSelect(`link:${id}`)} />
        </Tile>
      )}
      {/* who this site talks to, and what with: NetFlow from its own exporters */}
      <SiteTrafficTile model={model} code={info.code} onSite={(c) => onSelect(`site:${c}`)} />
      <SitePathsTile model={model} code={info.code} />
      {/* is what is degraded here explained by the network? A suspicion, and Assist to argue it */}
      {(model.users || (model.unmappedAlerts ?? []).some((a) => a.scope === "application" || a.scope === "service" || a.scope === "host")) && (
        <Tile title="Fault domain" right="network or not">
          <SuspicionStrip s={suspicion} users={model.users}
            assist={<AssistPanel subject={`isolate|${info.code}`} questions={isolationQuestions(info.site.name)} object="impact"
              context={() => isolationContext(model, suspicion, info, dropPct)} />} />
        </Tile>
      )}
      <Tile tone={TONE.violet}>
        <NativeDrill devices={info.devices} circuits={info.circuits} since={since} demo={model.demo}
          focus={info.causeDevice ?? info.devices.find((d) => d.role === "edge") ?? null}
          focusCircuit={info.circuits.find((c) => c.status === "down") ?? info.circuits.find((c) => isBad(c.verdict)) ?? info.circuits.find((c) => c.kind === "primary") ?? null} />
        <AssistPanel subject={`site|${info.code}`} questions={siteQuestions(info.site.name, info.circuits.some((c) => c.kind === "backup"), !!model.flowMap?.sites[info.code])} object="site"
          context={() => siteContext(model, info)} />
      </Tile>
      <DataNeeds keys={VIEW_NEEDS.site} needs={needs} compact />
    </div>
  );
}

export function EntityDetails(props: Props) {
  const { model, infos, sel, onSelect, onClose, needs } = props;
  const kind = sel.slice(0, sel.indexOf(":"));
  const key = sel.slice(sel.indexOf(":") + 1);

  if (kind === "site") {
    const info = infos.find((i) => i.code === key);
    if (info) return <SiteDetails model={model} info={info} needs={needs} onSelect={onSelect} onClose={onClose} />;
  }

  if (kind === "device") {
    const d = model.devices.find((x) => x.name === key);
    if (d) {
      const behind = model.sites[d.site]?.dc ? infos.filter((i) => i.site.hub === d.site).length : 1;
      return (
        <div className="lm vz vz-details">
          <Head title={shortDevice(d.name)} verdict={d.verdict} onClose={onClose} subtitle={`${d.name} · ${ROLE_LABEL[d.role] ?? d.role} · ${d.ip || "—"}`} />
          <Tile tone={verdictTone(d.verdict)} title={model.sites[d.site]?.name ?? d.site} right={`${behind} ${behind === 1 ? "site" : "sites"} depend on it`}>
            <div className="vz-inst-top">
              <Gauge value={d.cpuNow} label="CPU" warn={T.cpu_warn} crit={T.cpu_crit} />
              <Gauge value={d.availPct} label="Availability" warn={101} crit={101} />
              <div className="vz-chipline vz-chipline--col">
                <span className="vz-stat"><b>{d.interfaces.filter((i) => i.oper.startsWith("up")).length}/{d.interfaces.length}</b>interfaces up</span>
                <span className="vz-stat"><b>{fmtInt(d.syslog.ERROR)}</b>syslog errors · 6 h</span>
                <span className="vz-stat"><b>{fmtInt(d.traps)}</b>traps</span>
                {d.memNow != null && <span className="vz-stat"><b>{Math.round(d.memNow)}%</b>memory in use</span>}
                {(d.vlans?.length ?? 0) > 0 && <span className="vz-stat"><b>{d.vlans!.length}</b>VLANs</span>}
              </div>
            </div>
            <LimitLine values={d.cpu} limit={T.cpu_crit} label="CPU" />
            <button type="button" className="lm-btn" onClick={() => onSelect(`site:${d.site}`)}>Open site {model.sites[d.site]?.name ?? d.site}</button>
          </Tile>
          <Tile tone={TONE.violet}>
            <NativeDrill devices={[d]} focus={d} since={d.unreachableSince} demo={model.demo} />
            <AssistPanel subject={`device|${d.name}`} questions={deviceQuestions(d.name, d.verdict === "Healthy")} object="device" context={() => deviceContext(model, d, behind)} />
          </Tile>
          <DataNeeds keys={VIEW_NEEDS.device} needs={needs} compact />
          <Tile title="Interfaces and events"><div className="vz-legacy"><DeviceDetails model={model} device={d} onDevice={(n) => onSelect(`device:${n}`)} /></div></Tile>
        </div>
      );
    }
  }

  if (kind === "link") {
    const c = model.circuits?.find((x) => x.id === key);
    if (c) {
      const pct = c.latencyMs != null ? (100 * c.latencyMs) / c.slaMs : null;
      // the interface the circuit leaves through: the busiest uplink of the site's edge router
      const uplink = model.devices
        .filter((d) => d.site === c.site && (d.role === "edge" || d.role === "core"))
        .flatMap((d) => d.interfaces.filter((i) => i.uplink && (i.in.length || i.out.length)).map((iface) => ({ device: d.name, iface })))
        .sort((a, b) => (b.iface.util ?? 0) - (a.iface.util ?? 0))[0];
      return (
        <div className="lm vz vz-details">
          <Head title={`${c.siteName} · ${c.kind}`} verdict={c.status === "down" ? "Critical" : c.verdict} onClose={onClose} subtitle={`${c.carrier} · ${c.tech}${c.incident ? ` · ${c.incident}` : ""}`} />
          <Tile tone={c.status === "down" ? TONE.bad : verdictTone(c.verdict)} title="Latency vs SLA" right={c.status === "down" ? `down since ${hhmm(c.since)}` : `${c.slaMs} ms SLA`}>
            <div className="vz-inst-top">
              <Gauge value={c.status === "down" ? 100 : pct} label={c.status === "down" ? "Down" : "Of SLA"} warn={100} crit={150}
                verdict={c.status === "down" ? "Critical" : c.verdict} />
              <div className="vz-chipline vz-chipline--col">
                <span className="vz-stat"><b>{c.latencyMs != null ? `${fmtNum(c.latencyMs, 0)} ms` : "—"}</b>latency</span>
                <span className="vz-stat"><b>{c.lossPct != null ? `${fmtNum(c.lossPct)}%` : "—"}</b>loss</span>
                <span className="vz-stat"><b>{c.jitterMs != null ? `${fmtNum(c.jitterMs)} ms` : "—"}</b>jitter</span>
              </div>
            </div>
            <button type="button" className="lm-btn" onClick={() => onSelect(`site:${c.site}`)}>Open site {c.siteName}</button>
          </Tile>
          <Tile title="Latency over 24 h" right={`${c.carrier} · ${c.tech}`}>
            <LatencyOverTime series={c.rttTs ?? []} sla={c.slaMs} />
          </Tile>
          {uplink && (
            <Tile title="Link consumption · last 2 h" right={`${shortDevice(uplink.device)} · ${uplink.iface.name}`}>
              <UplinkOverTime iface={uplink.iface} />
              <div className="vz-cap">Counters of the uplink interface at this site. The circuit itself is measured by ICMP, so consumption comes from the interface the circuit leaves through.</div>
            </Tile>
          )}
          <NativeDrill devices={model.devices.filter((d) => d.site === c.site && d.role === "edge")} circuits={[c]} focusCircuit={c} since={c.since} demo={model.demo}
            focus={model.devices.find((d) => d.site === c.site && d.role === "edge") ?? null} />
        </div>
      );
    }
  }

  return (
    <div className="lm vz vz-details">
      <Head title="Not found" verdict="Not monitored" onClose={onClose} subtitle="This entity isn't in the current data" />
    </div>
  );
}
