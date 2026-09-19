// Sites, Devices and WAN links as visual pages: every site is a cell in its region's
// honeycomb, devices are dots grouped by role, circuits sit on a ruler against their SLA.
// A table view of each page stays one click away.
import React, { useMemo, useState } from "react";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";
import type { Circuit, Device, NetworkModel, Verdict } from "../model/types";
import { ROLE_LABEL, type SiteInfo } from "../model/site";
import { isBad, ORDER, T } from "../model/verdict";
import { fmtInt, fmtNum, stripDevice } from "../utils/format";
import { NativeDrill } from "../components/NativeDrill";
import { carrierContext, deviceContext, networkContext } from "../utils/assist";
import { carrierQuestions, deviceQuestions, sitesQuestions } from "../utils/prompts";
import { AssistPanel } from "../components/AssistPanel";
import { DeviceBubbles } from "../components/DeviceBubbles";
import { Chips, Gauge, KpiTile, LimitLine, PageBar, StatusShape, Tile, TONE, verdictTone, type View } from "../components/Visual";
import { DevicesPage, LinksPage, SitesPage, type Filters, type PageProps } from "./EntityPages";
import { buildCauses } from "../model/causes";
import { DataNeeds } from "../components/DataNeeds";
import { PageEmpty } from "../components/PageEmpty";
import { useElementWidth } from "../hooks/useElementWidth";
import { SlaBars } from "../components/EntityDetails";
import { VIEW_NEEDS, type Need, type NeedKey } from "../data/requirements";import { ReachabilityTile } from "../components/Traffic";


interface VisualProps extends PageProps {
  needs: Record<NeedKey, Need>;
  failed: string[];
  view: View;
  onView: (v: View) => void;
  /** Offered when a page has no data yet and the environment is the live one. */
  onExample?: () => void;
  /** Opens Settings › Data on the entry a page is waiting for */
  onSettings?: (key: NeedKey) => void;
  /** leaves the example data for the environment's own */
  onLive?: () => void;
  /** the next step to get more from the app, preferring the one this page needs */
  nextFor?: (keys: NeedKey[]) => React.ComponentProps<typeof DataNeeds>["next"];
}

const STATUS_CHIPS = [
  { key: "Critical", label: "Critical", tone: TONE.bad },
  { key: "Warning", label: "Warning", tone: TONE.warn },
  { key: "Healthy", label: "Healthy", tone: TONE.good },
  { key: "Not monitored", label: "Not monitored", tone: TONE.neutral },
];
const matches = (v: Verdict, status: string | null) => !status || (status === "issues" ? isBad(v) : v === status);
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0) / 4294967295; };
const shortDevice = (name: string) => name.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "");
const count = <X,>(xs: X[], f: (x: X) => boolean) => xs.reduce((a, x) => a + (f(x) ? 1 : 0), 0);


// ------------------------------------------------------------------ Sites

export function SitesVisual(p: VisualProps) {
  const { model, infos, filters, onFilters, selected, onSelect } = p;
  const selCode = selected?.startsWith("site:") ? selected.slice(5) : null;
  const carriers = useMemo(() => [...new Set(infos.flatMap((i) => i.circuits.filter((c) => c.kind === "primary").map((c) => c.carrier)))].sort(), [infos]);
  const kinds = (i: SiteInfo) => (i.site.dc ? "Data center" : i.site.name.split(" · ")[1]?.replace(/ \d+$/, "") ?? "Site");
  const siteKinds = useMemo(() => [...new Set(infos.map(kinds))].sort(), [infos]);
  const [kind, setKind] = useState<string | null>(null);

  const visible = (i: SiteInfo) => matches(i.verdict, filters.status)
    && (!filters.carrier || i.circuits.some((c) => c.kind === "primary" && c.carrier === filters.carrier))
    && (!kind || kinds(i) === kind);
  const groups = useMemo(() => {
    const map = new Map<string, SiteInfo[]>();
    infos.forEach((i) => { const r = i.site.dc ? "Data centers" : i.site.region ?? i.site.name; map.set(r, [...(map.get(r) ?? []), i]); });
    return [...map.entries()].map(([name, sites]) => ({
      name, sites: [...sites].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.code.localeCompare(b.code)),
    })).sort((a, b) => Number(a.name === "Data centers") - Number(b.name === "Data centers") || count(b.sites, (s) => isBad(s.verdict)) / b.sites.length - count(a.sites, (s) => isBad(s.verdict)) / a.sites.length);
  }, [infos]);

  const n = (v: Verdict) => count(infos, (i) => i.verdict === v);
  const offline = count(infos, (i) => i.devices.some((d) => d.role === "edge" && d.unreachableSince) || i.circuits.length > 0 && i.circuits.every((c) => c.status === "down"));
  const topCause = useMemo(() => buildCauses(model, infos).sort((a, b) => b.sites.length - a.sites.length)[0], [model, infos]);
  const setStatus = (s: string) => onFilters({ status: filters.status === s ? null : s });

  return (
    <div className="lm vz">
      <PageBar model={model} failed={p.failed} view={p.view} onView={p.onView} onLive={p.onLive}>
        <span className="lm-pill">{fmtInt(infos.length)} sites · {groups.length} groups</span>
      </PageBar>
      <div className="dn-row"><DataNeeds keys={VIEW_NEEDS.sites} needs={p.needs} compact next={p.nextFor?.(VIEW_NEEDS.sites)} /></div>
      {!infos.length ? (
        <PageEmpty title="No sites yet" onExample={p.onExample} onSettings={p.onSettings} configure="sites" needs={p.needs} keys={VIEW_NEEDS.sites}
          detail="Sites come from the primary tags on the SNMP monitoring configurations. Once the devices carry a site tag, they group here by region and carrier." />
      ) : p.view === "table" ? <div className="vz-table"><SitesPage {...p} /></div> : (
        <div className="vz-body">
          <div className="vz-k4">
            <KpiTile tone={TONE.bad} label="Critical sites" value={n("Critical")} caption={`${offline} dark`} active={filters.status === "Critical"} onClick={() => setStatus("Critical")} />
            <KpiTile tone={TONE.warn} label="Warning" value={n("Warning")} caption={topCause && topCause.sites.length > 1 ? `${topCause.sites.length} behind ${topCause.title}` : "sites degraded"} active={filters.status === "Warning"} onClick={() => setStatus("Warning")} />
            <KpiTile tone={TONE.good} label="Healthy" value={n("Healthy")} caption={`${Math.round((100 * n("Healthy")) / Math.max(1, infos.length))}% of ${fmtInt(infos.length)}`} active={filters.status === "Healthy"} onClick={() => setStatus("Healthy")} />
            <KpiTile tone={TONE.accent} label="Not monitored" value={n("Not monitored")} caption={`${count(model.devices, (d) => d.verdict === "Not monitored")} devices without polling`} active={filters.status === "Not monitored"} onClick={() => setStatus("Not monitored")} />
          </div>
          <div className="vz-filters">
            {carriers.length > 0 && <Chips label="Carrier" options={carriers.map((c) => ({ key: c, label: c }))} value={filters.carrier} onChange={(carrier) => onFilters({ carrier })} />}
            {siteKinds.length > 1 && <Chips label="Type" options={siteKinds.map((k) => ({ key: k, label: k, count: count(infos, (i) => kinds(i) === k) }))} value={kind} onChange={setKind} />}
          </div>
          <div className="vz-regions">
            {groups.map((g) => {
              const crit = count(g.sites, (s) => s.verdict === "Critical"), warn = count(g.sites, (s) => s.verdict === "Warning");
              const shown = count(g.sites, visible);
              const tone = crit ? TONE.bad : warn > g.sites.length / 2 ? TONE.warn : TONE.accent;
              return (
                <Tile key={g.name} tone={tone} title={g.name} right={fmtInt(g.sites.length)} className={`vz-region${g.sites.length > 100 ? " vz-region--wide" : ""}`}>
                  <div className="vz-hex" role="group" aria-label={`${g.name}: ${crit + warn} of ${g.sites.length} sites with issues`}>
                    {g.sites.map((s) => {
                      const on = visible(s);
                      return (
                        <button key={s.code} type="button" className={`vz-cell${selCode === s.code ? " is-sel" : ""}`} disabled={!on}
                          style={{ background: verdictTone(s.verdict), opacity: on ? 1 : 0.14 }} onClick={() => onSelect(`site:${s.code}`)}
                          title={`${s.site.name} (${s.code}) · ${s.verdict}${s.cause ? ` · ${stripDevice(s.cause)}` : ""}`}
                          aria-label={`${s.site.name}, ${s.verdict}`} />
                      );
                    })}
                  </div>
                  <div className="vz-cap">{crit + warn ? `${crit + warn} with issues` : "all healthy"}{shown < g.sites.length ? ` · ${shown} shown` : ""}</div>
                </Tile>
              );
            })}
          </div>
          <Tile tone={TONE.violet} className="vz-assist-row">
            <AssistPanel subject={`sites|${filters.status}|${filters.carrier}|${kind}`} questions={sitesQuestions()} object="sites"
              context={() => ({ ...networkContext(model, infos, buildCauses(model, infos)), filter: { status: filters.status, carrier: filters.carrier, type: kind } })} />
          </Tile>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Devices

function sitesBehind(infos: SiteInfo[], d: Device, model: NetworkModel) {
  return model.sites[d.site]?.dc ? count(infos, (i) => i.site.hub === d.site) : 1;
}

function DeviceInstrument({ model, infos, device, onDetails }: { model: NetworkModel; infos: SiteInfo[]; device: Device; onDetails: () => void }) {
  const upIfs = count(device.interfaces, (i) => i.oper.startsWith("up"));
  const behind = sitesBehind(infos, device, model);
  const cpuSeries = device.cpu.length > 1 ? device.cpu : [];
  return (
    <Tile tone={verdictTone(device.verdict)} title={<><StatusShape verdict={device.verdict} /> {shortDevice(device.name)}</>} right={ROLE_LABEL[device.role] ?? device.role} className="vz-instrument">
      <div className="vz-inst-top">
        <Gauge value={device.cpuNow} label="CPU" warn={T.cpu_warn} crit={T.cpu_crit} />
        <div><div className="vz-big">{fmtInt(behind)}</div><div className="vz-cap">{behind === 1 ? "site depends on it" : "sites depend on it"}</div>
          <div className="vz-cap vz-mono">{model.sites[device.site]?.name ?? device.site} · {device.ip || "—"}</div></div>
      </div>
      <LimitLine values={cpuSeries} limit={T.cpu_crit} label="CPU" />
      <div className="vz-chipline">
        <span className="vz-stat"><b>{upIfs}/{device.interfaces.length}</b>interfaces up</span>
        <span className="vz-stat"><b>{device.availPct != null ? `${fmtNum(device.availPct, 1)}%` : "—"}</b>availability</span>
        <span className="vz-stat"><b>{fmtInt(device.syslog.ERROR)}</b>syslog errors · 6 h</span>
        <span className="vz-stat"><b>{fmtInt(device.traps)}</b>traps</span>
      </div>
      <NativeDrill devices={[device]} focus={device} since={device.unreachableSince} demo={model.demo}
        before={<button type="button" className="lm-btn" onClick={onDetails}><b>Details</b><small>in this app</small></button>} />
      <AssistPanel subject={`device|${device.name}`} questions={deviceQuestions(device.name, device.verdict === "Healthy")} object="device"
        context={() => deviceContext(model, device, behind)} />
    </Tile>
  );
}

const ROLE_ORDER = ["edge", "core", "firewall", "lb", "switch", "wlc", "ap", "compute", "endpoint", "other"];

export function DevicesVisual(p: VisualProps) {
  const { model, infos, filters, onFilters, onSelect } = p;
  const [picked, setPicked] = useState<string | null>(null);
  const regions = useMemo(() => [...new Set(Object.values(model.sites).map((s) => s.region).filter((r): r is string => !!r))].sort(), [model]);
  const visible = (d: Device) => matches(d.verdict, filters.status) && (!filters.region || model.sites[d.site]?.region === filters.region);
  const groups = useMemo(() => {
    const map = new Map<string, Device[]>();
    model.devices.forEach((d) => map.set(d.role, [...(map.get(d.role) ?? []), d]));
    return [...map.entries()].sort((a, b) => ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]))
      .map(([role, devices]) => ({ role, devices: [...devices].sort((a, b) => ORDER[b.verdict] - ORDER[a.verdict]) }));
  }, [model]);
  const worst = useMemo(() => [...model.devices].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact - a.impact || sitesBehind(infos, b, model) - sitesBehind(infos, a, model))[0], [model, infos]);
  const device = model.devices.find((d) => d.name === picked) ?? worst;

  // bubble layout: one circle per role, dots on a sunflower spiral, problems drawn last and larger.
  // Drawn at the measured width of its tile (1 unit = 1 px), so the labels keep their type size on a wide
  // monitor instead of the whole drawing being scaled up.
  const [bubbleRef, bubbleW] = useElementWidth<HTMLDivElement>(640);
  const W = Math.max(480, bubbleW);
  const layout = useMemo(() => {
    const circles = groups.map((g) => ({ ...g, r: Math.max(34, Math.min(120, 16 + Math.sqrt(g.devices.length) * 3.3)) }));
    // A cell is as wide as the bubble or its two lines of text, whichever is wider: "WIRELESS CONTROLLER"
    // is wider than its bubble, and a cell sized to the bubble alone let it run into its neighbour.
    const bad = (c: (typeof circles)[number]) => c.devices.filter((d) => isBad(d.verdict)).length;
    const textW = (c: (typeof circles)[number]) => Math.max(
      (ROLE_LABEL[c.role] ?? c.role).length * 9.2,
      `${c.devices.length}${bad(c) ? ` · ${bad(c)} with issues` : ""}`.length * 6.8,
    );
    const cellW = (c: (typeof circles)[number]) => Math.max(c.r * 2 + 24, textW(c) + 24, 130);
    // rows are tracked by their index: grouping them by cy - r, as before, split a row whenever a radius
    // was fractional, and each piece was centred on its own — on top of the others
    const rows: { items: (typeof circles[number] & { cx: number; cy: number })[]; used: number }[] = [];
    let x = 0, y = 0, rowH = 0;
    let row: (typeof rows)[number] = { items: [], used: 0 };
    circles.forEach((c) => {
      const d = cellW(c);
      if (x + d > W && x > 0) { rows.push(row); row = { items: [], used: 0 }; x = 0; y += rowH; rowH = 0; }
      row.items.push({ ...c, cx: x + d / 2, cy: y + c.r + 8 });
      row.used += d;
      x += d; rowH = Math.max(rowH, c.r * 2 + 60);
    });
    if (row.items.length) rows.push(row);
    rows.forEach((rw) => { const shift = Math.max(0, (W - rw.used) / 2); rw.items.forEach((c) => { c.cx += shift; }); });
    return { placed: rows.flatMap((rw) => rw.items), h: y + rowH };
  }, [groups, W]);

  const n = (v: Verdict) => count(model.devices, (d) => d.verdict === v);
  const setStatus = (s: string) => onFilters({ status: filters.status === s ? null : s });

  return (
    <div className="lm vz">
      <PageBar model={model} failed={p.failed} view={p.view} onView={p.onView} onLive={p.onLive}>
        <span className="lm-pill">{fmtInt(model.devices.length)} devices · {groups.length} roles</span>
      </PageBar>
      <div className="dn-row"><DataNeeds keys={VIEW_NEEDS.devices} needs={p.needs} compact next={p.nextFor?.(VIEW_NEEDS.devices)} /></div>
      {!model.devices.length ? (
        <PageEmpty title="No network devices yet" onExample={p.onExample} onSettings={p.onSettings} configure="devices" needs={p.needs} keys={VIEW_NEEDS.devices}
          detail="Devices come from the SNMP extensions. Each router, switch, firewall and access point they monitor appears here with its interfaces, CPU and events." />
      ) : p.view === "table" ? <div className="vz-table"><DevicesPage {...p} /></div> : (
        <div className="vz-body">
          <div className="vz-k4">
            <KpiTile tone={TONE.bad} label="Critical devices" value={n("Critical")} caption={`${count(model.devices, (d) => !!d.unreachableSince)} not responding`} active={filters.status === "Critical"} onClick={() => setStatus("Critical")} />
            <KpiTile tone={TONE.warn} label="Warning" value={n("Warning")} caption="alerted, not critical" active={filters.status === "Warning"} onClick={() => setStatus("Warning")} />
            <KpiTile tone={TONE.good} label="Healthy" value={fmtInt(n("Healthy"))} caption={`${Math.round((100 * n("Healthy")) / Math.max(1, model.devices.length))}% of devices`} active={filters.status === "Healthy"} onClick={() => setStatus("Healthy")} />
            <KpiTile tone={TONE.accent} label="Not monitored" value={n("Not monitored")} caption="discovered, no polling" active={filters.status === "Not monitored"} onClick={() => setStatus("Not monitored")} />
          </div>
          {regions.length > 0 && <div className="vz-filters"><Chips label="Region" options={regions.map((r) => ({ key: r, label: r }))} value={filters.region} onChange={(region) => onFilters({ region })} /></div>}
          <div className="vz-split">
            <Tile title={`${fmtInt(model.devices.length)} devices by role`} right="size = devices">
              <div className="vz-fluid" ref={bubbleRef}>
                <DeviceBubbles groups={layout.placed} width={W} height={layout.h} visible={visible} selected={device?.name ?? null} onPick={setPicked} />
              </div>
              <div className="vz-top" role="list" aria-label="Most impactful devices">
                {[...model.devices].filter((d) => isBad(d.verdict) && visible(d)).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || sitesBehind(infos, b, model) - sitesBehind(infos, a, model)).slice(0, 6).map((d) => (
                  <button key={d.name} type="button" role="listitem" className={`vz-chip${device?.name === d.name ? " is-on" : ""}`} style={{ "--c": verdictTone(d.verdict) } as React.CSSProperties} onClick={() => setPicked(d.name)}>
                    <i aria-hidden="true" />{shortDevice(d.name)} · {model.sites[d.site]?.name.split(" · ")[0] ?? d.site}
                  </button>
                ))}
              </div>
            </Tile>
            {device && <DeviceInstrument model={model} infos={infos} device={device} onDetails={() => onSelect(`device:${device.name}`)} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ WAN links

export function LinksVisual(p: VisualProps) {
  const { model, filters, onFilters, onSelect } = p;
  const circuits = model.circuits ?? [];
  const carriers = useMemo(() => {
    const map = new Map<string, Circuit[]>();
    circuits.forEach((c) => map.set(c.carrier, [...(map.get(c.carrier) ?? []), c]));
    // Percentiles of the latency as a share of each circuit's own SLA, plus the same in milliseconds:
    // carriers are compared against their own target instead of a single scale that squashes MPLS next
    // to satellite.
    const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
    return [...map.entries()].map(([name, cs]) => {
      const up = cs.filter((c) => c.status === "up" && c.latencyMs != null);
      const ratios = up.map((c) => c.latencyMs! / c.slaMs).sort((a, b) => a - b);
      const ms = up.map((c) => c.latencyMs!).sort((a, b) => a - b);
      const slaCount = new Map<number, number>();
      cs.forEach((c) => slaCount.set(c.slaMs, (slaCount.get(c.slaMs) ?? 0) + 1));
      return {
        name, circuits: cs, down: count(cs, (c) => c.status === "down"), over: count(cs, (c) => c.status === "up" && isBad(c.verdict)),
        backupActive: count(cs, (c) => c.kind === "backup" && c.status === "up" && circuits.some((x) => x.site === c.site && x.kind === "primary" && x.status === "down")),
        tech: [...new Set(cs.map((c) => c.tech.split(" ")[0]))].join(", "),
        median: q(ratios, 0.5), p95: q(ratios, 0.95), medianMs: q(ms, 0.5), p95Ms: q(ms, 0.95),
        sla: [...slaCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        mixedSla: slaCount.size > 1,
        regions: [...new Set(cs.filter((c) => c.status === "down").map((c) => model.sites[c.site]?.region).filter(Boolean))].join(", "),
      };
    }).sort((a, b) => b.down - a.down || b.over - a.over || b.circuits.length - a.circuits.length);
  }, [circuits, model]);

  // One bullet per carrier: bar to the median, whisker to p95, tick where that carrier's SLA sits.
  // Every row uses its own SLA, so the tick lines up and the numbers stay in milliseconds.
  // A meter per carrier: 24 segments that end at the SLA tagged on its circuits, plus a short overflow
  // zone for a carrier whose median is already past the contract. The chart is drawn at the measured
  // width of its tile (1 unit = 1 pixel), so on a wide monitor the meter gets longer instead of the
  // whole drawing being blown up.
  const [chartRef, chartW] = useElementWidth<HTMLDivElement>(760);
  const W = Math.max(520, chartW);
  const rowH = W < 720 ? 52 : 56, top = 20, SEGS = 24, OVER_SEGS = 5;
  const LABEL_W = Math.round(Math.min(240, Math.max(150, W * 0.22)));
  const PILL_W = 104, SLA_LABEL_W = 96;
  const METER_X = LABEL_W + 16;
  const meterSpace = W - METER_X - SLA_LABEL_W - PILL_W - 40;
  const SEG_PITCH = Math.max(6, Math.min(16, Math.floor(meterSpace / (SEGS + OVER_SEGS))));
  const SEG_W = SEG_PITCH - 2;
  const segX = (i: number) => METER_X + i * SEG_PITCH;
  const SLA_X = METER_X + SEGS * SEG_PITCH - 2;
  const PILL_X = W - PILL_W - 8;
  const H = top + carriers.length * rowH + 12;
  const focusCarrier = filters.carrier;

  // What the row above points at: the circuits of the focused carrier, worst first.
  const [allCircuits, setAllCircuits] = useState(false);
  const listed = useMemo(() => circuits
    .filter((c) => (!focusCarrier || c.carrier === focusCarrier)
      && matches(c.verdict, filters.status)
      && (!filters.region || model.sites[c.site]?.region === filters.region))
    .sort((a, b) => Number(b.status === "down") - Number(a.status === "down")
      || (b.latencyMs ?? 0) / b.slaMs - (a.latencyMs ?? 0) / a.slaMs
      || a.siteName.localeCompare(b.siteName)), [circuits, focusCarrier, filters.status, filters.region, model]);
  const shortlist = allCircuits ? listed.slice(0, 60) : listed.slice(0, 6);

  return (
    <div className="lm vz">
      <PageBar model={model} failed={p.failed} view={p.view} onView={p.onView} onLive={p.onLive}>
        <span className="lm-pill">{fmtInt(circuits.length)} circuits · {carriers.length} carriers</span>
      </PageBar>
      <div className="dn-row"><DataNeeds keys={VIEW_NEEDS.links} needs={p.needs} compact next={p.nextFor?.(VIEW_NEEDS.links)} /></div>
      {!circuits.length && model.devices.some((d) => d.icmp) ? (
        // no circuit tags yet: what the ICMP monitors already say, site by site
        <div className="vz-body"><ReachabilityTile model={model} onSite={(code) => p.onSelect(`site:${code}`)} /></div>
      ) : !circuits.length ? (
        <PageEmpty title="No WAN circuits yet" onExample={p.onExample} onSettings={p.onSettings} configure="wan" needs={p.needs} keys={VIEW_NEEDS.links}
          detail="Circuits come from ICMP network availability monitors tagged with site, circuit_id, circuit_role, carrier, circuit_tech and sla_ms. This page shows their latency against the SLA." />
      ) : p.view === "table" ? <div className="vz-table"><LinksPage {...p} /></div> : (
        <div className="vz-body">
          <div className="vz-k4">
            {carriers.map((c) => (
              <KpiTile key={c.name} tone={c.down ? TONE.bad : c.over ? TONE.warn : c.backupActive ? TONE.cyan : TONE.accent}
                label={`${c.name} · ${c.tech}`} active={focusCarrier === c.name} onClick={() => onFilters({ carrier: focusCarrier === c.name ? null : c.name })}
                value={c.down ? `${c.down} down` : c.backupActive ? `${c.backupActive} active` : fmtInt(c.circuits.length)}
                caption={c.down ? `of ${c.circuits.length}${c.regions ? ` · ${c.regions}` : ""}` : c.backupActive ? "sites running on backup" : `links${c.over ? ` · ${c.over} over SLA` : ""}${c.median != null ? ` · median ${Math.round(c.median * 100)}% of SLA` : ""}`} />
            ))}
          </div>
          <Tile title={`Latency against SLA · ${fmtInt(circuits.length)} circuits`} right="each segment = 1/24 of that carrier's SLA">
            <div className="vz-fluid" ref={chartRef}>
              <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="vz-ruler vz-ruler--fit" role="group" aria-label="Median latency per carrier as a meter that ends at the SLA contracted for that carrier">
                <defs>
                  <filter id="vz-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="1.2" result="b" />
                    <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                {carriers.map((g, k) => {
                  const y = top + k * rowH + rowH / 2;
                  const dim = focusCarrier && focusCarrier !== g.name;
                  const ratio = g.median ?? 0;
                  const lit = Math.max(g.median == null ? 0 : 1, Math.min(SEGS, Math.floor(ratio * SEGS)));
                  const partial = g.median == null ? 0 : Math.min(1, ratio * SEGS - Math.floor(ratio * SEGS));
                  const over = ratio > 1 ? Math.min(OVER_SEGS, Math.ceil((ratio - 1) * SEGS)) : 0;
                  const tone = g.median == null ? TONE.neutral : ratio > 1 ? TONE.bad : ratio >= 0.8 ? TONE.warn : TONE.good;
                  const led = g.down ? TONE.bad : g.over ? TONE.warn : g.median == null ? TONE.neutral : TONE.good;
                  const inside = lit > 15;
                  const focus = () => onFilters({ carrier: focusCarrier === g.name ? null : g.name });
                  return (
                    <g key={g.name} opacity={dim ? 0.35 : 1} className="vz-dot" onClick={focus}>
                      {k > 0 && <line x1={0} x2={W} y1={y - rowH / 2} y2={y - rowH / 2} stroke="var(--lm-line)" opacity={0.5} />}
                      <rect x={0} y={y - rowH / 2 + 4} width={W} height={rowH - 8} fill="transparent">
                        <title>{`${g.name}: ${fmtInt(g.circuits.length)} circuits${g.sla ? ` · SLA ${fmtInt(g.sla)} ms${g.mixedSla ? " (most common)" : ""}` : ""}${g.medianMs != null ? ` · median ${fmtInt(g.medianMs)} ms` : ""}${g.p95Ms != null ? ` · p95 ${fmtInt(g.p95Ms)} ms` : ""}`}</title>
                      </rect>
                      <circle cx={8} cy={y - 4} r={4} fill={led} filter="url(#vz-glow)" className={g.down || g.over ? "vz-led vz-led--pulse" : "vz-led"} />
                      <text x={22} y={y - 5} className="vz-svg-label">{g.name.toUpperCase()}</text>
                      <text x={22} y={y + 11} className="vz-svg-cap">{fmtInt(g.circuits.length)} links · {g.tech}</text>

                      {/* the meter: 24 dark segments, the lit ones are the median against this carrier's SLA */}
                      {Array.from({ length: SEGS }, (_, i) => (
                        <rect key={`off${i}`} x={segX(i)} y={y - 7} width={SEG_W} height={14} fill="var(--lm-neutral)" opacity={0.16} />
                      ))}
                      <g filter="url(#vz-glow)">
                        {Array.from({ length: lit }, (_, i) => (
                          <rect key={`on${i}`} x={segX(i)} y={y - 7} width={SEG_W} height={14} fill={tone}
                            opacity={i === lit - 1 && partial > 0 && partial < 0.9 ? 0.45 + partial * 0.5 : 1} />
                        ))}
                        {Array.from({ length: over }, (_, i) => (
                          <rect key={`ov${i}`} x={SLA_X + 8 + i * SEG_PITCH} y={y - 7} width={SEG_W} height={14} fill={TONE.bad} />
                        ))}
                      </g>
                      {/* the value sits at the end of the lit run; on a long meter it moves inside, on its own chip */}
                      {inside && <rect x={segX(lit) - 52} y={y - 8} width={48} height={16} rx={4} fill="var(--lm-bg)" opacity={0.82} />}
                      <text x={inside ? segX(lit) - 8 : segX(lit) + 6} y={y + 4} textAnchor={inside ? "end" : "start"} className="vz-svg-cap">
                        {g.medianMs != null ? `${fmtInt(g.medianMs)} ms` : "not measured"}
                      </text>

                      {/* end of scale: the SLA contracted for this carrier */}
                      <rect x={SLA_X} y={y - 11} width={3} height={22} fill={TONE.warn} filter="url(#vz-glow)" />
                      <text x={SLA_X + 12 + (over ? OVER_SEGS * SEG_PITCH : 0)} y={y + 4} className="vz-svg-cap" fill={TONE.warn}>
                        {g.sla ? `SLA ${fmtInt(g.sla)} ms` : "no SLA tag"}
                      </text>

                      {g.down > 0 ? (
                        <g className="vz-dot" onClick={(e) => { e.stopPropagation(); onFilters({ carrier: g.name, status: "Critical" }); }}>
                          <rect x={PILL_X} y={y - 11} width={PILL_W} height={22} rx={11} fill={TONE.bad} opacity={0.18} stroke={TONE.bad} />
                          <text x={PILL_X + PILL_W / 2} y={y + 4} textAnchor="middle" className="vz-svg-label" fill={TONE.bad}>{g.down} down</text>
                        </g>
                      ) : g.over > 0 ? (
                        <g className="vz-dot" onClick={(e) => { e.stopPropagation(); onFilters({ carrier: g.name, status: "Warning" }); }}>
                          <rect x={PILL_X} y={y - 11} width={PILL_W} height={22} rx={11} fill={TONE.warn} opacity={0.18} stroke={TONE.warn} />
                          <text x={PILL_X + PILL_W / 2} y={y + 4} textAnchor="middle" className="vz-svg-label" fill={TONE.warn}>{g.over} over SLA</text>
                        </g>
                      ) : (
                        <text x={PILL_X + PILL_W / 2} y={y + 4} textAnchor="middle" className="vz-svg-cap">within SLA</text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          </Tile>
          <Tile title={focusCarrier ? `${focusCarrier} · circuits` : "Circuits that need attention"} right="open one for latency and consumption over time">
            <SlaBars circuits={shortlist} onLink={(id) => onSelect(`link:${id}`)}
              nameOf={(c) => `${c.siteName.split(" · ")[0]} · ${c.kind}`} />
            {listed.length > shortlist.length && (
              <button type="button" className="lm-btn" onClick={() => setAllCircuits((v) => !v)}>
                {allCircuits ? "Show fewer" : `Show all ${fmtInt(listed.length)}`}
              </button>
            )}
          </Tile>
          <div className="vz-split vz-split--even">
            <Tile tone={TONE.accent} title="Drill down">
              <Chips label="Status" options={STATUS_CHIPS.slice(0, 3)} value={filters.status} onChange={(status) => onFilters({ status })} />
              <NativeDrill demo={model.demo}
                circuits={circuits.filter((c) => c.status === "down" && (!focusCarrier || c.carrier === focusCarrier))}
                devices={circuits.filter((c) => c.status === "down" && (!focusCarrier || c.carrier === focusCarrier)).map((c) => model.devices.find((d) => d.site === c.site && d.role === "edge")).filter((d): d is Device => !!d).slice(0, 40)} />
            </Tile>
            <Tile tone={TONE.violet}>
              <AssistPanel subject={`carrier|${focusCarrier ?? "all"}`} questions={carrierQuestions(focusCarrier)} object="carriers"
                context={() => carrierContext(model, focusCarrier, circuits.filter((c) => !focusCarrier || c.carrier === focusCarrier))} />
            </Tile>
          </div>
        </div>
      )}
    </div>
  );
}

export type { Filters };
