// Home: the network breathing on a map. Probable causes on the left, the reasoning behind the
// selected one on the right. Every action drills down into the native Dynatrace apps.
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Device, Iface, NetworkModel, Verdict } from "../model/types";
import type { SiteInfo } from "../model/site";
import { ChangesPanel } from "../components/Changes";
import { isBad, worst } from "../model/verdict";
import { buildCauses, type Cause } from "../model/causes";
import { LiveMap, MAP_COLORS, type Insets, type MapLink, type MapSite } from "../components/LiveMap";
import { fmtInt, hhmm } from "../utils/format";
import { logsQuery, openLogs } from "../utils/drilldown";
import { NativeDrill } from "../components/NativeDrill";
import { SiteTree } from "../components/SiteTree";
import { useSiteHierarchy } from "../hooks/useSiteHierarchy";
import { causeContext, isolationContext, networkContext } from "../utils/assist";
import { causeQuestions, isolationQuestions, networkQuestions } from "../utils/prompts";
import { AssistPanel } from "../components/AssistPanel";
import { DataNeeds } from "../components/DataNeeds";
import { PageEmpty } from "../components/PageEmpty";
import { SuspicionStrip } from "../components/Suspicion";
import { suspicionFor, trafficDrop } from "../model/suspicion";
import { useDropThreshold } from "../hooks/useDropThreshold";
import { VIEW_NEEDS, type Need, type NeedKey } from "../data/requirements";
import { CauseChain, EvidenceBadges, NetworkStatus } from "../components/CauseVisuals";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";

interface Props {
  needs: Record<NeedKey, Need>;
  model: NetworkModel;
  infos: SiteInfo[];
  /** Selected cause id, "all" for the whole network, null for the default (largest cause) */
  causeId: string | null;
  failed: string[];
  onCause: (id: string) => void;
  onSite: (code: string) => void;
  onDevice: (name: string) => void;
  onSites: (patch: { status: string; region: string | null; q: string }) => void;
  /** the site whose details are open beside the map, when one is */
  selectedSite?: string | null;
  /** Offered while the environment has no network data yet. */
  onExample?: () => void;
  /** Opens Settings › Data, where every item says what to send and links to its documentation */
  onSettings?: (key: NeedKey) => void;
  /** the next step to get more from the app in this environment */
  next?: React.ComponentProps<typeof DataNeeds>["next"];
  /** leaves the example data for the environment's own */
  onLive?: () => void;
}

const parseTs = (s: string) => Date.parse(s.length === 17 ? s.replace("Z", ":00Z") : s);
const clock = (ms: number) => hhmm(new Date(ms).toISOString()).replace(" UTC", "");

function Marker({ verdict }: { verdict: Verdict }) {
  return <i className={`lm-marker lm-marker--${verdict === "Critical" ? "crit" : verdict === "Warning" ? "warn" : "ok"}`} style={{ background: MAP_COLORS[verdict] }} aria-label={verdict} />;
}

function causeMeta(c: Cause) {
  // the row truncates the title first, so the hover has to carry it
  return [
    c.title,
    c.subtitle,
    c.impact.offline ? `${c.impact.offline} offline` : null,
    c.since ? `since ${clock(parseTs(c.since))}` : null,
  ].filter(Boolean).join(" · ");
}

export function LiveMapPage({ needs, model, infos, causeId, failed, onCause, onSite, onDevice, onSites, onExample, onSettings, next, onLive, selectedSite }: Props) {
  const causes = useMemo(() => buildCauses(model, infos), [model, infos]);
  const shared = causes.filter((c) => c.sites.length > 1 || c.kind === "carrier" || c.kind === "datacenter");
  const isolated = causes.filter((c) => !shared.includes(c));
  const cause = causeId === "all" ? null : causes.find((c) => c.id === causeId) ?? shared[0] ?? null;

  // map data
  const siteCause = useMemo(() => new Map(causes.flatMap((c) => c.sites.map((s) => [s.code, c.title] as const))), [causes]);
  // Coordinates are an enrichment, not a condition: when fewer than half of the sites have one, every site
  // is drawn in a schematic layout — data centres in the middle, each region a cluster around them — so the
  // map works in any environment. The reader can switch between the two when both make sense.
  const placedShare = infos.length ? infos.filter((i) => i.site.lat != null && i.site.lon != null).length / infos.length : 0;
  const [layout, setLayout] = useState<"geo" | "schematic" | null>(null);
  // Geography is the default the moment any site can be placed: a reader opens the map to see where the
  // network is. Only an environment that gives no coordinates at all starts on the schematic layout, and
  // when geography would leave sites out, the bar says how many it is drawing.
  const schematic = (layout ?? (placedShare > 0 ? "geo" : "schematic")) === "schematic";
  const placedCount = infos.filter((i) => i.site.lat != null && i.site.lon != null).length;
  const mapSites = useMemo<MapSite[]>(() => {
    const base = (i: SiteInfo) => ({ code: i.code, name: i.site.name, verdict: i.verdict, dc: i.site.dc, region: i.site.region, cause: i.cause ? i.cause : siteCause.get(i.code) ?? null });
    if (!schematic) return infos.filter((i) => i.site.lat != null && i.site.lon != null).map((i) => ({ ...base(i), lat: i.site.lat!, lon: i.site.lon! }));
    const dcs = infos.filter((i) => i.site.dc), rest = infos.filter((i) => !i.site.dc);
    const groups = [...new Set(rest.map((i) => i.site.region ?? "No region"))].sort();
    const ring = (n: number, k: number, r: number, cx = 0, cy = 0) => ({ lon: cx + r * Math.cos((2 * Math.PI * k) / Math.max(n, 1) - Math.PI / 2), lat: cy + r * 0.8 * Math.sin((2 * Math.PI * k) / Math.max(n, 1) - Math.PI / 2) });
    const out: MapSite[] = dcs.map((i, k) => ({ ...base(i), ...(dcs.length > 1 ? ring(dcs.length, k, 3) : { lat: 0, lon: 0 }) }));
    groups.forEach((g, gi) => {
      const members = rest.filter((i) => (i.site.region ?? "No region") === g);
      const c = groups.length > 1 || dcs.length ? ring(groups.length, gi, 20) : { lat: 0, lon: 0 };
      members.forEach((i, k) => out.push({ ...base(i), ...(members.length > 1 ? ring(members.length, k, Math.min(9, 2 + members.length * 0.6), c.lon, c.lat) : c) }));
    });
    return out;
  }, [infos, siteCause, schematic]);
  const mapLinks = useMemo<MapLink[]>(() => {
    const placed = new Set(mapSites.map((s) => s.code));
    // traffic of a site's WAN: latest in + out of the edge routers' uplinks (bits per second)
    // the site's own devices (SiteInfo), not a scan of the whole estate for every site. The uplink counters
    // know which way the traffic went: what came in from the WAN, and what left towards it.
    const trafficOf = (i: SiteInfo): { total: number; in: number; out: number } | null => {
      const edges = i.devices.filter((d) => d.role === "edge");
      const ifs = edges.flatMap((d) => (d.unreachableSince ? [] : d.interfaces.filter((f) => f.uplink)));
      const measured = ifs.filter((f) => f.in.length || f.out.length);
      if (!measured.length) return edges.some((d) => d.unreachableSince) ? { total: 0, in: 0, out: 0 } : null;
      const last = (xs: number[]) => xs[xs.length - 1] ?? 0;
      const up = measured.filter((f) => f.oper.startsWith("up"));
      const inn = up.reduce((a, f) => a + last(f.in), 0), out = up.reduce((a, f) => a + last(f.out), 0);
      return { total: inn + out, in: inn, out };
    };
    const hubLinks = infos.filter((i) => i.site.hub && placed.has(i.code) && placed.has(i.site.hub)).map((i) => ({
      id: `wan:${i.code}`, a: i.code, b: i.site.hub!, verdict: i.site.wanVerdict ?? (i.causeLayer === "Carrier" ? i.verdict : "Healthy"),
      ...(() => {
        const t = i.circuits.length && i.circuits.every((c) => c.status === "down") ? { total: 0, in: 0, out: 0 } : trafficOf(i);
        return { bps: t?.total ?? null, bpsIn: t?.in ?? null, bpsOut: t?.out ?? null };
      })(),
    }));
    // links the devices themselves report (CDP/LLDP): a cable between two sites is real communication,
    // measured on the port it leaves from
    const devOf = new Map(model.devices.map((d) => [d.name, d]));
    const tagged = new Set(hubLinks.map((l) => [l.a, l.b].sort().join("|")));
    const pairs = new Map<string, { a: string; b: string; ports: Iface[]; unmeasured: number; devs: Device[] }>();
    for (const l of model.links) {
      const a = devOf.get(l.a), b = devOf.get(l.b);
      if (!a || !b || a.site === b.site || !placed.has(a.site) || !placed.has(b.site)) continue;
      const key = [a.site, b.site].sort().join("|");
      if (tagged.has(key)) continue;
      const p = pairs.get(key) ?? { a: a.site, b: b.site, ports: [], unmeasured: 0, devs: [] };
      const port = a.interfaces.find((f) => (l.ifAId && f.id === l.ifAId) || (l.ifA && f.name === l.ifA));
      if (port && (port.in.length || port.out.length)) p.ports.push(port); else p.unmeasured++;
      p.devs.push(a, b);
      pairs.set(key, p);
    }
    const cabled = [...pairs].map(([key, p]) => {
      const down = p.ports.length > 0 && p.ports.every((f) => !f.oper.startsWith("up"));
      const bps = p.ports.length ? p.ports.reduce((s, f) => s + (f.oper.startsWith("up") ? (f.in[f.in.length - 1] ?? 0) + (f.out[f.out.length - 1] ?? 0) : 0), 0) : null;
      return { id: `lldp:${key}`, a: p.a, b: p.b, verdict: down ? "Critical" as Verdict : worst(p.devs.map((d) => d.verdict)), bps: down ? 0 : bps };
    });
    // traffic NetFlow places between two sites: a route with its real volume, even where no cable is
    // reported (a routed WAN hides the far end from CDP and LLDP)
    const flowRate = new Map((model.flowMap?.pairs ?? []).map((p) => [[p.a, p.b].sort().join("|"), (p.bytes * 8) / ((model.flowMap?.windowMs ?? 3600000) / 1000)]));
    const drawn = new Set([...hubLinks, ...cabled].map((l) => [l.a, l.b].sort().join("|")));
    const measured = [...hubLinks, ...cabled].map((l) => (l.bps == null && flowRate.has([l.a, l.b].sort().join("|")) ? { ...l, bps: flowRate.get([l.a, l.b].sort().join("|"))! } : l));
    const flowed = (model.flowMap?.pairs ?? []).filter((p) => placed.has(p.a) && placed.has(p.b) && !drawn.has([p.a, p.b].sort().join("|"))).map((p) => ({
      id: `flow:${p.a}|${p.b}`, a: p.a, b: p.b, verdict: worst(infos.filter((i) => i.code === p.a || i.code === p.b).map((i) => i.verdict)), bps: flowRate.get([p.a, p.b].sort().join("|")) ?? null,
    }));
    return [...measured, ...flowed];
  }, [infos, mapSites, model]);
  // left panel: the problems Dynatrace has open, or sites grouped by the primary tag hierarchy chosen in Settings
  const { levels } = useSiteHierarchy();
  // until levels are chosen in Settings, group by the region the app already knows
  const defaultLevels = useMemo(() => (infos.some((i) => i.site.region) ? ["site.region"] : []), [infos]);
  const [leftTab, setLeftTab] = useState<"causes" | "sites" | "changes">(() => { try { const v = window.localStorage.getItem("network-pulse.left-tab"); return v === "sites" || v === "changes" ? v : "causes"; } catch { return "causes"; } });
  const chooseTab = (t: "causes" | "sites" | "changes") => { setLeftTab(t); try { window.localStorage.setItem("network-pulse.left-tab", t); } catch { /* per session only */ } };
  const [group, setGroup] = useState<{ id: string; codes: Set<string> } | null>(null);
  const causeFocus = useMemo(() => (cause ? new Set(cause.sites.map((s) => s.code)) : null), [cause]);
  const focus = leftTab === "sites" && group ? group.codes : causeFocus;

  // responsive insets: panels float over the map only on wide stages
  const stage = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 1100));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const insets = useMemo<Insets>(
    () => (wide ? { top: 24, left: 336, right: 376, bottom: 28 } : { top: 16, left: 16, right: 16, bottom: 16 }),
    [wide],
  );

  const dropPct = useDropThreshold();
  const suspicion = useMemo(() => suspicionFor(model, { dropPct }), [model, dropPct]);
  const affected = infos.filter((i) => isBad(i.verdict));
  const regions = new Set(infos.map((i) => i.site.region).filter(Boolean)).size;
  const dcs = infos.filter((i) => i.site.dc).length;
  const lost = causes.reduce((a, c) => a + c.impact.sessionsLost, 0);
  const offline = causes.reduce((a, c) => a + c.impact.offline, 0);
  const demand = trafficDrop(model.users, dropPct);
  const scopeDevices = cause ? cause.devices : causes.flatMap((c) => c.devices);
  const ips = scopeDevices.map((d) => d.ip).filter(Boolean).slice(0, 40);
  const maxSites = Math.max(1, ...causes.map((c) => c.sites.length));

  // With a site open beside the map, the list is a wall of alerts that may have nothing to do with it.
  // Every cause that reaches the open site is marked and sorted to the front, so the question a reader
  // asked — does this alert have anything to do with this site? — is answered on the row.
  const touchesOpenSite = (c: Cause) => !!selectedSite && c.sites.some((s) => s.code === selectedSite);
  const openSiteName = selectedSite ? model.sites[selectedSite]?.name ?? selectedSite : null;
  const byRelevance = (list: Cause[]) => (selectedSite ? [...list].sort((a, b) => Number(touchesOpenSite(b)) - Number(touchesOpenSite(a))) : list);

  const causeButton = (c: Cause) => (
    <button key={c.id} type="button" className={`lm-cause${cause?.id === c.id ? " is-on" : ""}${touchesOpenSite(c) ? " is-here" : ""}`} aria-pressed={cause?.id === c.id}
      style={{ "--lm-tone": MAP_COLORS[c.verdict] } as React.CSSProperties} onClick={() => onCause(c.id)}
      title={touchesOpenSite(c) ? `${causeMeta(c)} · includes ${openSiteName}` : selectedSite ? `${causeMeta(c)} · does not reach ${openSiteName}` : causeMeta(c)}>
      <b><Marker verdict={c.verdict} /><span className="lm-cause__title">{c.title}</span>{touchesOpenSite(c) && <i className="lm-cause__here">this site</i>}<em>{c.sites.length}</em></b>
      {/* Davis names a problem after its kind, so seven devices down are seven rows with the same words.
          Where they differ is the site, which the subtitle already holds. */}
      {c.subtitle && <span className="lm-cause__sub">{c.subtitle}</span>}
      <span className="lm-cause__bar" aria-hidden="true"><i style={{ width: `${(c.sites.length / maxSites) * 100}%` }} /></span>
    </button>
  );

  // Nothing has arrived yet: the map explains what to send, while the other pages stay reachable and
  // show whatever their own data allows.
  if (!infos.length) {
    return (
      <div className="lm">
        <div className="lm-bar">
          <span className="lm-pill lm-pill--live"><span className="lm-live" aria-hidden="true" />Live {hhmm(model.meta.generatedAt)}</span>
          <span className="lm-pill">no sites yet</span>
        </div>
        <PageEmpty title="No network data yet" onExample={onExample} onSettings={onSettings} configure="devices" needs={needs} keys={VIEW_NEEDS.empty}
          detail="Send the data below to Dynatrace to fill the app. Every page stays open: each one shows what it can as soon as its data arrives." />
      </div>
    );
  }

  return (
    <div className="lm">
      <div className="lm-bar">
        <span className="lm-pill lm-pill--live"><span className="lm-live" aria-hidden="true" />Live {hhmm(model.meta.generatedAt)}</span>
        <span className="lm-pill">{fmtInt(infos.length)} sites{regions ? ` · ${regions} regions` : ""}{dcs ? ` · ${dcs} data centers` : ""} · {fmtInt(model.devices.length)} devices</span>
        {model.demo && (onLive
          ? <button type="button" className="lm-pill lm-pill--warn lm-pill--btn" onClick={onLive}>Example data · back to this environment</button>
          : <span className="lm-pill lm-pill--warn">Example data</span>)}
        {!model.demo && failed.length > 0 && <span className="lm-pill lm-pill--warn" title={failed.join(", ")}>{failed.length} data source(s) unavailable</span>}
        <span className="vz-seg" role="group" aria-label="Map layout" title={placedShare < 1 ? `${Math.round(placedShare * 100)}% of the sites have coordinates (geo_lat / geo_lon tags or a known place)` : undefined}>
          <button type="button" className={!schematic ? "is-on" : ""} aria-pressed={!schematic} disabled={placedShare === 0} onClick={() => setLayout("geo")}>Geographic</button>
          <button type="button" className={schematic ? "is-on" : ""} aria-pressed={schematic} onClick={() => setLayout("schematic")}>Schematic</button>
        </span>
        {!schematic && placedShare < 1 && (
          <button type="button" className="lm-pill lm-pill--warn lm-pill--btn" onClick={() => setLayout("schematic")}
            title="Sites without geo_lat / geo_lon tags, and whose location the app could not recognise, cannot be drawn on a map. The schematic layout holds every site.">
            {fmtInt(placedCount)} of {fmtInt(infos.length)} sites on the map · see all
          </button>
        )}
        <span className="lm-legend" aria-label="Legend">
          <span><Marker verdict="Critical" />Critical</span>
          <span><Marker verdict="Warning" />Warning</span>
          <span><Marker verdict="Healthy" />Healthy</span>
        </span>
      </div>

      <div className="dn-row"><DataNeeds keys={VIEW_NEEDS.map} needs={needs} compact next={next} /></div>
      <div ref={stage} className={`lm-stage${wide ? " is-wide" : ""}`}>
        {mapSites.length ? (
          <LiveMap sites={mapSites} links={mapLinks} focus={focus} insets={insets} onSite={onSite} schematic={schematic} />
        ) : (
          // no coordinates: the steps live in Settings › Data, so this points there instead of repeating them
          <div className="lm-map lm-map--empty">
            <p>No site has coordinates yet, so there is nothing to place on the map. The sites, devices and alerts of this environment are in the list beside it.</p>
            <span className="lm-map__acts">
              {onSettings && <button type="button" className="lm-btn lm-btn--primary" onClick={() => onSettings("sites")}>Settings › Sites, regions and locations</button>}
              {onExample && <button type="button" className="lm-btn" onClick={onExample}>See it with example data</button>}
            </span>
          </div>
        )}

        <aside className="lm-panel lm-left" aria-label={leftTab === "sites" ? "Sites" : leftTab === "changes" ? "Changes in the last 24 hours" : "Probable causes"}>
          <span className="vz-seg lm-lefttabs" role="group" aria-label="List">
            <button type="button" className={leftTab === "causes" ? "is-on" : ""} aria-pressed={leftTab === "causes"} onClick={() => chooseTab("causes")}>Causes</button>
            <button type="button" className={leftTab === "sites" ? "is-on" : ""} aria-pressed={leftTab === "sites"} onClick={() => chooseTab("sites")}>Sites</button>
            <button type="button" className={leftTab === "changes" ? "is-on" : ""} aria-pressed={leftTab === "changes"} onClick={() => chooseTab("changes")}>Changes</button>
          </span>
          {leftTab === "changes" ? (
            <ChangesPanel model={model} onDevice={onDevice} onSite={onSite} />
          ) : leftTab === "sites" ? (
            <SiteTree infos={infos} levels={levels.length ? levels : defaultLevels} selected={group?.id ?? null}
              onGroup={(id, codes) => setGroup(id && codes ? { id, codes } : null)} onSite={onSite} />
          ) : (<>
          <h2 className="lm-h">{causes.length ? `${fmtInt(causes.length)} cause${causes.length > 1 ? "s" : ""} · ${fmtInt(affected.length)} sites` : "Nothing is alerting on this network"}</h2>
          <div className="lm-stats">
            <span><b style={{ color: offline ? "var(--lm-bad)" : undefined }}>{fmtInt(offline)}</b>sites offline</span>
            {/* demand as measured, when the environment reports it; the example network carries its own loss */}
            {demand.pct != null ? (() => {
              // A median baseline puts half the days above it, so a hundred-and-six per cent is what a
              // quiet network looks like — printed as a headline beside "sites offline" it read as a
              // fault. The number is kept for the readings that mean something: a fall, or a surge.
              const what = demand.source === "requests" ? "requests" : "sessions";
              const usual = demand.pct >= 90 && demand.pct <= 125;
              const tip = `${demand.source === "requests" ? "Requests served" : "User sessions"} in the last complete hour, ${fmtInt(demand.now ?? 0)}, against the median of the same hour over the last seven days, ${fmtInt(demand.typical ?? 0)} — ${demand.pct}%. Whole environment.`;
              return (
                <span title={tip}>
                  {usual
                    ? <><b>Usual</b>{what} this hour</>
                    : <><b style={{ color: demand.dropped ? "var(--lm-bad)" : undefined }}>{demand.pct}%</b>of usual {what}</>}
                </span>
              );
            })() : lost ? (
              <span><b style={{ color: "var(--lm-bad)" }}>−{fmtInt(lost)}</b>sessions/h</span>
            ) : null}
          </div>
          <button type="button" className={`lm-cause lm-cause--all${cause ? "" : " is-on"}`} aria-pressed={!cause} onClick={() => onCause("all")}>
            <b><span className="lm-cause__title">Whole network</span><em>{fmtInt(affected.length)}/{fmtInt(infos.length)}</em></b>
          </button>
          {shared.length > 0 && <h3 className="lm-sub">Shared causes · {shared.length}</h3>}
          {byRelevance(shared).map(causeButton)}
          {isolated.length > 0 && <h3 className="lm-sub">Isolated faults · {isolated.length}</h3>}
          {byRelevance(isolated).map(causeButton)}
          </>)}
        </aside>

        <aside className="lm-panel lm-right" aria-label={cause ? cause.title : "Whole network"}>
          {cause ? (
            <>
              <h2 className="lm-title lm-title--wrap" title={causeMeta(cause)}>
                <Marker verdict={cause.verdict} />
                <span>{cause.title}{cause.subtitle && <small>{cause.subtitle}</small>}</span>
                {cause.since && <em>{clock(parseTs(cause.since))}</em>}
              </h2>
              <CauseChain cause={cause} />
              <EvidenceBadges cause={cause} onLogs={() => openLogs(logsQuery(ips, cause.since))} />
            </>
          ) : (
            <>
              <h2 className="lm-title"><span>Whole network</span></h2>
              <NetworkStatus infos={infos} onRegion={(region) => onSites({ status: "issues", region, q: "" })} />
            </>
          )}
          {/* is what is degraded explained by the network? A suspicion for the whole environment, with the
              analysis handed to Assist. Only shown when there is something to compare it against. */}
          {suspicion.kind !== "blind" && suspicion.kind !== "watching" && (
            <SuspicionStrip s={suspicion} users={model.users} model={model}
              assist={<AssistPanel subject={`isolate|network`} questions={isolationQuestions("this network")} object="impact"
                context={() => isolationContext(model, suspicion, undefined, dropPct)} />} />
          )}
          <NativeDrill devices={scopeDevices} since={cause?.since} demo={model.demo}
            // a carrier cause spans many routers and links: no single device to open; a device or data center cause has one
            focus={cause && cause.kind !== "carrier" && cause.devices.length === 1 ? cause.devices[0] : null}
            circuits={cause ? cause.sites.flatMap((s) => s.circuits.filter((c) => c.status === "down" || isBad(c.verdict))) : []}
            after={<button type="button" className="lm-btn" onClick={() => onSites({ status: "issues", region: cause?.impact.regions.length === 1 ? cause.impact.regions[0] : null, q: "" })}><b>Sites</b><small>in this app</small></button>} />
          <AssistPanel subject={cause?.id ?? "network"}
            questions={cause ? causeQuestions(cause.title) : networkQuestions()}
            object={cause ? "cause" : "network"}
            context={() => (cause ? causeContext(model, cause) : networkContext(model, infos, causes))} />
        </aside>

      </div>
    </div>
  );
}
