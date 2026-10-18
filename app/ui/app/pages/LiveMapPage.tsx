// Home: the network breathing on a map. Probable causes on the left, the reasoning behind the
// selected one on the right. Every action drills down into the native Dynatrace apps.
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Device, Iface, NetworkModel, Verdict } from "../model/types";
import type { SiteInfo } from "../model/site";
import { isBad, worst } from "../model/verdict";
import { buildCauses, type Cause } from "../model/causes";
import { LiveMapGeo } from "../components/LiveMapGeo";
import { LiveMap, MAP_COLORS, type Insets, type MapLink, type MapRegion, type MapSite } from "../components/LiveMap";
import { countriesOf, loadRegions, regionAt, type RegionShape } from "../data/geo/admin1/load";
import { fmtInt, hhmm } from "../utils/format";
import { logsQuery, openLogs } from "../utils/drilldown";
import { NativeDrill } from "../components/NativeDrill";
import { SiteTree } from "../components/SiteTree";
import { useSiteHierarchy } from "../hooks/useSiteHierarchy";
import { causeContext, isolationContext, networkContext } from "../utils/assist";
import { causeQuestions, isolationQuestions, networkQuestions } from "../utils/prompts";
import { AssistPanel } from "../components/AssistPanel";
import { appNetExpressions, demandExpression, useAnomaly } from "../hooks/useAnomaly";
import { DataNeeds } from "../components/DataNeeds";
import { PageEmpty } from "../components/PageEmpty";
import { Skeleton, SkeletonText } from "@dynatrace/strato-components/content";
import { SuspicionStrip } from "../components/Suspicion";
import { suspicionFor, trafficDrop } from "../model/suspicion";
import { useDropThreshold } from "../hooks/useDropThreshold";
import { VIEW_NEEDS, type Need, type NeedKey } from "../data/requirements";
import { useDiscardNovelty } from "../hooks/useNovelty";
import { CauseDetail, EvidenceBadges, NetworkStatus } from "../components/CauseVisuals";

interface Props {
  needs: Record<NeedKey, Need>;
  model: NetworkModel;
  infos: SiteInfo[];
  /** Selected cause id, "all" for the whole network, null for the default (largest cause) */
  causeId: string | null;
  /** every read this page states something from has answered (or failed, which is an answer) */
  ready?: boolean;
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

export function LiveMapPage({ needs, model, infos, causeId, failed, onCause, onSite, onDevice, onSites, onExample, onSettings, next, onLive, selectedSite, ready = true }: Props) {
  /* The discard cause is the platform's finding, not this app's: the page asks which ports
     changed and the causes are rebuilt when the answer lands. */
  const families = useMemo(() => [...new Set(model.devices
    .flatMap((d) => d.interfaces.map((i) => i.family))
    .filter((f): f is string => !!f))].sort(), [model]);
  const { data: rising, loading: risingLoading } = useDiscardNovelty(families, 14);
  /* whether demand fell is the platform's call: the same series the strip measures, judged by
     the seasonal baseline detector rather than by a percentage this app picked */
  const platform = {
    demand: useAnomaly("seasonal", demandExpression(model), { condition: "BELOW", days: 7 }),
    /* the two readings that say whether the applications feel the network: the app used to
       decide both against factors of its own */
    retransmitted: useAnomaly("adaptive", appNetExpressions(model)?.retransmitted ?? null, { condition: "ABOVE", days: 1 }),
    roundTrip: useAnomaly("adaptive", appNetExpressions(model)?.roundTrip ?? null, { condition: "ABOVE", days: 1 }),
  };
  const causes = useMemo(() => buildCauses(model, infos, rising), [model, infos, rising]);
  const shared = causes.filter((c) => c.sites.length > 1 || c.kind === "carrier" || c.kind === "datacenter");
  const isolated = causes.filter((c) => !shared.includes(c));
  /**
   * A cause that arrives late does not take the screen from the reader.
   *
   * `?? shared[0]` is how the panel opens on something rather than on nothing, and it was
   * re-evaluated on every render — so a cause that landed after the page had settled became
   * `shared[0]` and the panel jumped to it. Measured on a recording: at 24 s the panel held
   * one cause; at 28 s the discard cause arrived — it comes from the novelty analyzer, which
   * is not one of the queries the loader counts — and the panel was showing it with nobody
   * having asked.
   *
   * Anchoring that to the first *shared* cause was the same bug one step along, and the
   * second recording caught it: there was no shared cause at all until the discard one
   * arrived at twenty-seven seconds, so it still became the default and still took the
   * panel. The anchor is the first render that has **any** cause, which is the moment the
   * page first has something to open on. After that the default never moves; a later arrival
   * shows up in the list, where new information belongs, and the reader picks it or not.
   */
  const firstCause = useRef<string | null>(null);
  if (firstCause.current == null && causes.length) firstCause.current = (shared[0] ?? causes[0]).id;
  const fallback = causes.find((c) => c.id === firstCause.current) ?? null;
  const cause = causeId === "all" ? null : causes.find((c) => c.id === causeId) ?? fallback;

  // map data
  const siteCause = useMemo(() => new Map(causes.flatMap((c) => c.sites.map((s) => [s.code, c.title] as const))), [causes]);
  // Coordinates are an enrichment, not a condition: when fewer than half of the sites have one, every site
  // is drawn in a schematic layout — data centres in the middle, each region a cluster around them — so the
  // map works in any environment. The reader can switch between the two when both make sense.
  const placedShare = infos.length ? infos.filter((i) => i.site.lat != null && i.site.lon != null).length / infos.length : 0;
  const [layout, setLayout] = useState<"geo" | "states" | "schematic" | null>(null);
  // Geography is the default the moment any site can be placed: a reader opens the map to see where the
  // network is. Only an environment that gives no coordinates at all starts on the schematic layout, and
  // when geography would leave sites out, the bar says how many it is drawing.
  const chosen = layout ?? (placedShare > 0 ? "geo" : "schematic");
  const schematic = chosen === "schematic";
  /**
   * The platform's map draws the world; the schematic stays on the canvas.
   *
   * Its coordinates are a layout and not a place — eight discs on a ring, so a geographic map
   * would put Southeast Brazil in the Atlantic. Both components take the same props, and the
   * switch is a component rather than a call so the two keep their own hooks.
   */
  const Stage = schematic ? LiveMap : LiveMapGeo;
  const states = chosen === "states";
  const placedCount = infos.filter((i) => i.site.lat != null && i.site.lon != null).length;
  // The layout returns both what it placed and the groups it placed them in. It used to hand the groups
  // over through a ref, which is how the page came to read a const above its own declaration and die on
  // every render: one value out of one memo cannot go out of step with itself.
  const placed = useMemo<{ sites: MapSite[]; groups: { name: string; lon: number; lat: number; sites: number; bad: number; verdict: Verdict }[] }>(() => {
    const base = (i: SiteInfo) => ({ code: i.code, name: i.site.name, verdict: i.verdict, dc: i.site.dc, region: i.site.region, cause: i.cause ? i.cause : siteCause.get(i.code) ?? null });
    if (!schematic) return { sites: infos.filter((i) => i.site.lat != null && i.site.lon != null).map((i) => ({ ...base(i), lat: i.site.lat!, lon: i.site.lon! })), groups: [] };
    const dcs = infos.filter((i) => i.site.dc), rest = infos.filter((i) => !i.site.dc);
    /**
     * A site that has reported something, now or over the record.
     *
     * The schematic is a picture of the estate, and the middle of it is for the part that
     * answers: a processor read, an availability, a port with a series, or an alert
     * Dynatrace has open. A site whose devices are only discovered has none of those — it
     * exists in the inventory and says nothing — and it was taking the same space as the
     * ones carrying the network.
     */
    const reports = (i: SiteInfo) => i.devices.some((d) => d.cpuNow != null || d.availPct != null
      || d.memNow != null || (d.problems ?? []).length > 0
      || d.interfaces.some((f) => f.in.length || f.out.length || f.hourly?.length));
    const groups = [...new Set(rest.map((i) => i.site.region ?? "No region"))].sort();
    const ring = (n: number, k: number, r: number, cx = 0, cy = 0) => ({ lon: cx + r * Math.cos((2 * Math.PI * k) / Math.max(n, 1) - Math.PI / 2), lat: cy + r * 0.8 * Math.sin((2 * Math.PI * k) / Math.max(n, 1) - Math.PI / 2) });
    const out: MapSite[] = dcs.map((i, k) => ({ ...base(i), ...(dcs.length > 1 ? ring(dcs.length, k, 3) : { lat: 0, lon: 0 }) }));
    // Each group is a disc of its own sites, and the discs must not touch: eight regions on a ring of
    // twenty leave fifteen of space between their centres, and a disc capped at nine across is eighteen
    // wide — so every region overlapped its neighbours and the whole thing read as one undivided ring.
    // The disc grows with the square root of what it holds, as the bubbles do, and the ring that carries
    // them grows with whatever the widest disc needs.
    const members = new Map(groups.map((g) => [g, rest.filter((i) => (i.site.region ?? "No region") === g)]));
    const discOf = (n: number) => Math.max(2.5, Math.min(16, 1.6 + Math.sqrt(n) * 0.75));
    const widest = Math.max(...groups.map((g) => discOf(members.get(g)!.length)), 3);
    const spread = groups.length > 1
      ? Math.max(18, (widest + 2.5) / Math.sin(Math.PI / groups.length))
      : 0;
    /* Two belts, not one: the regions that report sit on the inner ring with the data
       centres, and the ones where nothing has answered sit outside them. Same picture of
       the whole estate — the difference is that the middle of it now means something. */
    const speaks = (g: string) => members.get(g)!.some(reports);
    const inner = groups.filter(speaks), outer = groups.filter((g) => !speaks(g));
    const ringOf = (g: string) => (speaks(g) ? inner : outer);
    const radiusOf = (g: string) => (speaks(g) || !inner.length ? spread : spread * 1.75);
    const placedGroups: { name: string; lon: number; lat: number; sites: number; bad: number; verdict: Verdict }[] = [];
    groups.forEach((g) => {
      const list = members.get(g)!;
      const belt = ringOf(g);
      const c = spread ? ring(belt.length, belt.indexOf(g), radiusOf(g)) : { lat: 0, lon: 0 };
      const disc = discOf(list.length);
      placedGroups.push({ name: g, lon: c.lon, lat: c.lat + disc * 0.8 + 1.6, sites: list.length,
        bad: list.filter((i) => isBad(i.verdict)).length, verdict: worst(list.map((i) => i.verdict)) });
      list.forEach((i, k) => out.push({ ...base(i), ...(list.length > 1 ? ring(list.length, k, disc, c.lon, c.lat) : c) }));
    });
    return { sites: out, groups: placedGroups };
  }, [infos, siteCause, schematic]);
  const mapSites = placed.sites;
  // Only this view fetches them, and only for the countries the sites are in: one chunk per country.
  const [shapes, setShapes] = useState<RegionShape[] | null>(null);
  const regionSites = useRef(new Map<string, Set<string>>());
  // Loaded once was wrong: the first load answered whichever estate was on screen then, and switching
  // data source — this environment to the example, or the example to the extra-large one — brought
  // sites in countries the first answer never covered. A whole continent stayed blank because the map
  // had already decided. It loads what the sites in front of it need, and keeps what it has.
  const loadedCcs = useRef(new Set<string>());
  useEffect(() => {
    if (!states) return;
    const points = infos.filter((i) => i.site.lat != null && i.site.lon != null).map((i) => ({ lat: i.site.lat!, lon: i.site.lon! }));
    const want = countriesOf(points).filter((cc) => !loadedCcs.current.has(cc));
    if (!want.length) { if (!shapes) setShapes([]); return; }
    let live = true;
    want.forEach((cc) => loadedCcs.current.add(cc));
    loadRegions(points).then((r) => { if (live) setShapes(r); });
    return () => { live = false; };
  }, [states, infos, shapes]);

  // what stands in each region: the sites inside its outline, and the worst of them
  const mapRegions = useMemo<MapRegion[]>(() => {
    // in the schematic the groups have no shape, only a place and a name — the label layer draws them
    const split = (xs: { verdict: Verdict }[]) => xs.reduce<Partial<Record<Verdict, number>>>((a, i) => ({ ...a, [i.verdict]: (a[i.verdict] ?? 0) + 1 }), {});
    if (schematic) return placed.groups.map((g) => ({ code: g.name, name: g.name, lon: g.lon, lat: g.lat, rings: [], verdict: g.verdict, sites: g.sites, bad: g.bad, counts: {} }));
    if (!states || !shapes) return [];
    const count = new Map<string, SiteInfo[]>();
    infos.forEach((i) => {
      if (i.site.lat == null || i.site.lon == null) return;
      const r = regionAt(shapes, i.site.lon, i.site.lat);
      if (!r) return;
      const key = `${r.cc}|${r.code}|${r.name}`;
      const l = count.get(key); if (l) l.push(i); else count.set(key, [i]);
    });
    // A box is not a country: France reaches from Guiana to Réunion, so a Brazilian site used to fetch
    // it and draw its hundred and one regions over Europe. Only countries that hold a site are drawn,
    // and inside one the regions without sites stay as outlines, which is the context worth having.
    regionSites.current = new Map([...count].map(([k, v]) => [k.split("|").slice(1).join("|"), new Set(v.map((i) => i.code))]));
    const held = new Set([...count.keys()].map((k) => k.split("|")[0]));
    return shapes.filter((r) => held.has(r.cc)).map((r) => {
      const members = count.get(`${r.cc}|${r.code}|${r.name}`) ?? [];
      return {
        code: r.code, name: r.name, lon: r.lon, lat: r.lat, rings: r.rings,
        verdict: members.length ? worst(members.map((i) => i.verdict)) : ("Not monitored" as const),
        sites: members.length,
        bad: members.filter((i) => isBad(i.verdict)).length,
        counts: split(members),
        /* only the ones that are alerting: the quiet share is the base the outline is drawn
           in, so a healthy site needs no mark of its own */
        marks: members
          .filter((i) => isBad(i.verdict) && i.site.lat != null && i.site.lon != null)
          .map((i) => ({ verdict: i.verdict, lon: i.site.lon!, lat: i.site.lat! })),
      };
    });
  }, [states, shapes, infos, schematic, placed]);

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
  const [leftTab, setLeftTab] = useState<"causes" | "sites">(() => { try { return window.localStorage.getItem("network-pulse.left-tab") === "sites" ? "sites" : "causes"; } catch { return "causes"; } });
  const chooseTab = (t: "causes" | "sites") => { setLeftTab(t); try { window.localStorage.setItem("network-pulse.left-tab", t); } catch { /* per session only */ } };
  const [group, setGroup] = useState<{ id: string; codes: Set<string> } | null>(null);
  /**
   * A default is not a selection, and only a selection moves the map.
   *
   * The panel opens on the first cause so the page is not blank, and that default was also
   * reaching the map as a focus: the camera flew to the two sites of a cause nobody had
   * clicked and everything else went dim. Measured on this environment at 1440 px — the
   * schematic opened on the data centre and one site, with eleven of thirteen off the
   * frame. The whole network stays in view until the reader picks a cause; `causeId` is only
   * set by a click, so it is the one signal that says somebody asked.
   */
  const picked = causeId && causeId !== "all" ? causes.find((c) => c.id === causeId) ?? null : null;
  const causeFocus = useMemo(() => (picked ? new Set(picked.sites.map((s) => s.code)) : null), [picked]);
  const focus = leftTab === "sites" && group ? group.codes : causeFocus;

  // responsive insets: panels float over the map only on wide stages
  const stage = useRef<HTMLDivElement>(null);
  /**
   * The first value is a measurement too, not an assumption.
   *
   * It started at `true`, so on a narrow window the very first frame handed the map the wide
   * layout's insets — 336 left and 376 right on a stage barely six hundred wide, which leaves
   * the camera a negative area to fit into. The observer corrects it a frame later, but a fit
   * that runs inside that frame lands somewhere nobody asked for. The stage is as wide as the
   * window, give or take its padding, so the window is the honest first guess.
   */
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? false : window.innerWidth >= 1100));
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

  /**
   * Nothing is stated until everything this page states from has answered.
   *
   * The page used to assemble itself in front of the reader, and a recording caught how
   * much of it moved: at ten seconds the header read "13 sites · 196 devices" over a map
   * holding two dots, beside "Loading 72 of 97", "3 of 12 received" and "27% of the app in
   * use"; at fifteen seconds the same four numbers read 96, 6 and 62%, with the map filled
   * in; at twenty-seven a second cause appeared and the panel jumped to it.
   *
   * Each of those was true when it was drawn and wrong a moment later, which is the one
   * thing a status page cannot afford. The Ahead page already refuses it — it waits for
   * `hourlyReady` and shows a skeleton — and this is the same rule for the same reason.
   *
   * The analyzer is *not* in this gate, and that is the second half of the same argument.
   * The discard cause comes from `NoveltyScoreAnalyzer`, which answers ten to fifteen
   * seconds after the reads do — waiting for it here held the whole page, map and all, at a
   * skeleton for half a minute, and a page that shows nothing for thirty seconds is its own
   * kind of wrong. It is gated where it is actually spoken: the causes column waits for it,
   * and nothing else does.
   */
  if (!ready) {
    return (
      <div className="lm">
        <div className="lm-bar">
          <span className="lm-pill lm-pill--live"><span className="lm-live" aria-hidden="true" />Reading the network</span>
        </div>
        <div className="lm-boot" aria-busy="true" aria-label="Reading the network">
          <p className="lm-boot__why">A half-read network is a true answer about a few sites and a false one
            about the rest, so nothing is drawn until every read this page speaks from has landed —
            including the analyzer that says which ports changed.</p>
          <Skeleton height="26px" />
          <div style={{ height: 10 }} />
          <SkeletonText lines={3} />
          <div style={{ height: 14 }} />
          <Skeleton height="320px" />
        </div>
      </div>
    );
  }

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
          ? <button type="button" className="lm-pill lm-pill--note lm-pill--btn" onClick={onLive}>Example data · back to this environment</button>
          : <span className="lm-pill lm-pill--note">Example data</span>)}
        {!model.demo && failed.length > 0 && <span className="lm-pill lm-pill--note" title={failed.join(", ")}>{failed.length} data source(s) unavailable</span>}
        <span className="vz-seg" role="group" aria-label="Map layout" title={placedShare < 1 ? `${Math.round(placedShare * 100)}% of the sites have coordinates (geo_lat / geo_lon tags or a known place)` : undefined}>
          <button type="button" className={chosen === "geo" ? "is-on" : ""} aria-pressed={chosen === "geo"} disabled={placedShare === 0} onClick={() => setLayout("geo")}>Geographic</button>
          <button type="button" className={states ? "is-on" : ""} aria-pressed={states} disabled={placedShare === 0}
            /* "States" read as a misspelling of "Status" — and the pill beside this button
               already counts them as regions ("27 regions in 1 countries"), which is also
               the word the rest of the app uses for a subdivision. Same layout, the name the
               app was already using for it. */
            title="States, provinces and prefectures of the countries the sites are in, outlined, with the share of each one that is alerting drawn on its edge. The outlines are fetched when this view is opened, one country at a time."
            onClick={() => setLayout("states")}>Regions</button>
          <button type="button" className={schematic ? "is-on" : ""} aria-pressed={schematic} onClick={() => setLayout("schematic")}>Schematic</button>
        </span>
        {states && (
          <span className="lm-pill" title="The outlines are fetched per country, only for the countries the sites fall in.">
            {shapes === null ? "Loading outlines…"
              : mapRegions.length ? `${new Set(mapRegions.map((r) => r.code)).size} regions in ${new Set(shapes.filter((s2) => mapRegions.some((r) => r.code === s2.code)).map((s2) => s2.cc)).size} countries`
                : "No outlines for these sites"}
          </span>
        )}
        {!schematic && placedShare < 1 && (
          <button type="button" className="lm-pill lm-pill--note lm-pill--btn" onClick={() => setLayout("schematic")}
            title="Sites without geo_lat / geo_lon tags, and whose location the app could not recognise, cannot be drawn on a map. The schematic layout holds every site.">
            {fmtInt(placedCount)} of {fmtInt(infos.length)} sites on the map · see all
          </button>
        )}
        {/**
          * How many connections are drawn, and why there are not more.
          *
          * The schematic is the layout a reader opens to see the shape of the network, and
          * on an estate whose devices report no neighbours it draws almost nothing — which
          * reads as the app failing rather than as the environment being silent. Measured
          * here: no Smartscape edge, no neighbour discovery in the last twenty minutes and
          * no LLDP series, so every line on this map is a pair NetFlow measured.
          *
          * The threshold is the shape of a hub-and-spoke estate: fewer links than sites
          * means most sites are not joined to anything.
          */}
        {mapSites.length > 2 && mapLinks.length < mapSites.length - 1 && (
          <span className="lm-pill lm-pill--note" title={"A line is drawn where something reports the two ends are joined: a neighbour (CDP or LLDP) seen by the devices, a hub tag on the site, or traffic NetFlow measured between them. Settings › Data lists what each one needs."}>
            {fmtInt(mapLinks.length)} connection{mapLinks.length === 1 ? "" : "s"} drawn of {fmtInt(mapSites.length)} sites · no neighbour reported
          </span>
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
          <Stage sites={mapSites} links={mapLinks} focus={focus} insets={insets} onSite={onSite}
            schematic={schematic} regions={mapRegions}
            onRegion={(r) => {
              const codes = regionSites.current.get(`${r.code}|${r.name}`);
              if (!codes?.size) return;
              chooseTab("sites");
              setGroup({ id: `state:${r.code}`, codes });
            }} />
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

        <aside className="lm-panel lm-left" aria-label={leftTab === "sites" ? "Sites" : "Probable causes"}>
          <span className="vz-seg lm-lefttabs" role="group" aria-label="List">
            <button type="button" className={leftTab === "causes" ? "is-on" : ""} aria-pressed={leftTab === "causes"} onClick={() => chooseTab("causes")}>Causes</button>
            <button type="button" className={leftTab === "sites" ? "is-on" : ""} aria-pressed={leftTab === "sites"} onClick={() => chooseTab("sites")}>Sites</button>
          </span>
          {leftTab === "sites" ? (
            <SiteTree infos={infos} levels={levels.length ? levels : defaultLevels} selected={group?.id ?? null}
              onGroup={(id, codes) => setGroup(id && codes ? { id, codes } : null)} onSite={onSite} />
          ) : risingLoading ? (
            /* The column alone waits for the analyzer, because the column alone speaks for it:
               a count of causes printed before `NoveltyScoreAnalyzer` answers is a count that
               grows by one in front of the reader, and the list under it gains a row. The map
               beside this says nothing that the analyzer could contradict, so it is already
               drawn and already usable. */
            <div className="lm-boot" aria-busy="true" aria-label="Asking Dynatrace which ports changed">
              <p className="lm-boot__why">Asking Dynatrace which ports changed. The count of causes waits
                for that answer rather than growing by one once it lands.</p>
              <Skeleton height="22px" />
              <div style={{ height: 10 }} />
              <SkeletonText lines={2} />
              <div style={{ height: 12 }} />
              <Skeleton height="64px" />
            </div>
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
          {/* The two headings sorted the list and said nothing about why. The rule is in the
              code right above — more than one site, or a carrier or a data centre, which are
              shared by what they carry even when one site sits behind them — and it is the
              whole reason this column is ordered the way it is: one action on a shared cause
              reaches every site under it. */}
          {shared.length > 0 && (
            <h3 className="lm-sub">Shared causes · {shared.length}
              <span className="lm-sub__why">one fault under several sites — or on a carrier or a data centre,
                which are shared by what they carry. One action reaches all of them.</span>
            </h3>
          )}
          {byRelevance(shared).map(causeButton)}
          {isolated.length > 0 && (
            <h3 className="lm-sub">Isolated faults · {isolated.length}
              <span className="lm-sub__why">one site each, and nothing else behind them.</span>
            </h3>
          )}
          {byRelevance(isolated).map(causeButton)}
          {/* The alerts the app cannot place are a gap in coverage, not a fault of the
              network, so they are counted here rather than listed as causes — with the one
              thing that would place them, which is what their entries used to say. */}
          {(() => {
            const lost = (model.unmappedAlerts ?? []).filter((a) => !a.muted
              && (a.scope === "network" || a.scope === "environment"));
            if (!lost.length) return null;
            const net = lost.filter((a) => a.scope === "network").length;
            return (
              <p className="lm-gap">{fmtInt(lost.length)} open alert{lost.length === 1 ? "" : "s"} could not be
                placed on this inventory, so {lost.length === 1 ? "it is" : "they are"} not listed above.{" "}
                {net > 0 ? "Tag the monitor with the circuit tags, or point it at the address of a device the SNMP extensions poll. " : ""}
                {lost.length - net > 0 ? "The ones bound to the environment need the entity dimension set on the metric event." : ""}</p>
            );
          })()}
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
              {/* The four-bead chain stood here — origin → sites → devices → app impact. It
                  could not be filled: measured on this environment every cause ends at 0
                  devices red or amber and no reported user impact, because no application
                  telemetry is tied to these sites and the WAN circuits carry no tags. A
                  skeleton of an answer the data cannot complete reads as the app being
                  broken; what follows — the evidence, and what the platform actually saw —
                  is the part that informs. */}
              {/* Everything this alert is, before anything that would ask about it.
                  The Intelligence row sat directly under the title, so the first thing under
                  the name of a fault was three buttons, and the evidence — what the platform
                  reported, the rate, the ports, what to check — began below them. A reader
                  who can see the finding asks a question about it afterwards, not instead of
                  reading it. */}
              <EvidenceBadges cause={cause} onLogs={() => openLogs(logsQuery(ips, cause.since))} />
              <CauseDetail cause={cause} onDevice={onDevice} />
              <AssistPanel subject={cause.id} questions={causeQuestions(cause.title)} object="cause"
                context={() => causeContext(model, cause)} />
            </>
          ) : (
            <>
              <h2 className="lm-title"><span>Whole network</span></h2>
              <NetworkStatus infos={infos} onRegion={(region) => onSites({ status: "issues", region, q: "" })} />
            </>
          )}
          {/* Is what is degraded explained by the network? A suspicion for the whole environment,
              with the analysis handed to Assist. Only shown when there is something to compare
              it against — and only when no cause is open.

              It used to show either way, so opening a cause stacked two panels of the same
              shape: a title, an Intelligence block and a row of drill-outs, once about this
              fault and once about the whole environment. Two Intelligence blocks in one
              column read as the app saying the same thing twice. One subject per view: the
              cause when a cause is open, the environment when none is. */}
          {!cause && suspicion.kind !== "blind" && suspicion.kind !== "watching" && (
            <SuspicionStrip s={suspicion} users={model.users} model={model}
              assist={<AssistPanel subject={`isolate|network`} questions={isolationQuestions("this network")} object="impact"
                context={() => isolationContext(model, suspicion, undefined, dropPct, platform)} />} />
          )}
          <NativeDrill devices={scopeDevices} since={cause?.since} demo={model.demo}
            // a carrier cause spans many routers and links: no single device to open; a device or data center cause has one
            focus={cause && cause.kind !== "carrier" && cause.devices.length === 1 ? cause.devices[0] : null}
            circuits={cause ? cause.sites.flatMap((s) => s.circuits.filter((c) => c.status === "down" || isBad(c.verdict))) : []}
            after={<button type="button" className="lm-btn" onClick={() => onSites({ status: "issues", region: cause?.impact.regions.length === 1 ? cause.impact.regions[0] : null, q: "" })}><b>Sites</b><small>in this app</small></button>} />
          {/* The whole-network Assist stays at the foot, where it is a closing question about
              the page. The one for an open cause moved to the top of the panel: it was here,
              under the evidence, the drill-outs and the suspicion strip, which on a cause
              with forty evidence lines put "explain this" a screen and a half below the
              thing to be explained. */}
          {!cause && (
            <AssistPanel subject="network" questions={networkQuestions()} object="network"
              context={() => networkContext(model, infos, causes)} />
          )}
        </aside>

      </div>
    </div>
  );
}
