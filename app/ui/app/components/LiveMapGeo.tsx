// The live map, on the platform's own map component.
//
// This is the canvas map's replacement, with the same props so the page did not have to
// change: sites, links, a focus, the state outlines, and the two callbacks. What it is not is
// a reimplementation — `MapView` draws the world, the sites and the routes, and everything
// that moves is a layer of ours mounted inside it.
//
// That is possible because `MapView` renders its children inside `<Map>` from
// `@vis.gl/react-maplibre`, and `setLayersId` passes through anything that is not one of its
// own layers (`if (!isValidLayer(child)) return child`). So `Source` and `Layer` from that
// package mount in the platform's map, and `useMap` reaches the live maplibre instance.
//
// The one thing this costs is a dependency on `@vis.gl/react-maplibre`, which is a transitive
// dependency of `strato-geo`: it is declared in our own package.json pinned to the version
// `strato-geo` mounts, because a second copy would read a different React context and
// `useMap()` would come back empty.
//
// Two things the canvas did are the platform's now and not ours: the land, which is
// Dynatrace's own country GeoJSON rather than our dotted raster, and the camera, which is
// maplibre's drag, wheel and keyboard rather than the handlers we wrote. Two things stay
// ours because the platform's map has no equivalent: the labels, drawn as HTML markers with
// the same collision pass the canvas ran (strato-geo's symbol layers carry `icon-image` only
// and the style configures no glyph source, so the GPU draws no text), and the motion.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapView, DotLayer, ConnectionLayer, type MapViewRef } from "@dynatrace/strato-geo";
import { MaximizeIcon, MinimizeIcon, MinusIcon, PlusIcon, ZoomToFitIcon } from "@dynatrace/strato-icons";
import { Source, Layer, Marker, useMap } from "@vis.gl/react-maplibre";
import type { Verdict } from "../model/types";
import { worst } from "../model/verdict";
import { useTokens } from "../hooks/useToken";
import { pointInRing, type Insets, type MapLink, type MapRegion, type MapSite } from "./LiveMap";

/** which of two verdicts a cluster should take its lead site from */
const RANKED: Verdict[] = ["Critical", "Warning", "Healthy", "Not monitored"];
const isWorse = (a: Verdict, b: Verdict) => RANKED.indexOf(a) < RANKED.indexOf(b);

/** every colour reaching a WebGL layer has to be a literal: `var()` is dropped in silence */
const INK = {
  "--lm-bad-fill": "#c82d40", "--lm-warn-fill": "#d7b43b", "--lm-good-fill": "#00bb7b",
  "--lm-neutral": "#7c7f9e", "--lm-series": "#00afbe", "--lm-ink": "#e2e8f0",
  "--lm-bg": "#141419",
};

type Pt = [number, number];
/** what the camera has to hold: a centre, for the hotspot, and the bounds to fit */
type Box = { lon: number; lat: number; west: number; east: number; south: number; north: number };
type Feat = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: "LineString"; coordinates: Pt[] } | { type: "Point"; coordinates: Pt } | { type: "Polygon"; coordinates: Pt[][] } };
const fc = (features: Feat[]) => ({ type: "FeatureCollection" as const, features });

/** the quadratic the canvas drew between a site and its data centre, as a list of points */
function curve(a: Pt, b: Pt, bend = 0.18, n = 96): Pt[] {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const cx = mx - dy * bend, cy = my + dx * bend;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]] as Pt;
  });
}

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0) / 4294967295; };

const ringPts = (ring: Float64Array): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i += 2) out.push([ring[i], ring[i + 1]]);
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
  return out;
};

/**
 * The region edge, cut into arcs in proportion to what stands inside it.
 *
 * The canvas drew this with `setLineDash` plus `lineDashOffset`, once per alerting site.
 * maplibre has neither: `line-dasharray` carries no offset and is not data-driven, and
 * `line-gradient` is not data-driven either, so nothing in the paint can vary per feature
 * inside one layer. The split moves into the geometry instead — each ring is emitted once
 * as the quiet base and once per alerting site as a short run centred on the point of the
 * outline that faces the site. Same reading; the data carries it rather than a stroke trick.
 */
function shareArcs(rg: MapRegion): Feat[] {
  if (!rg.sites || !rg.rings.length) return [];
  const out: Feat[] = [];
  for (const raw of rg.rings) {
    const ring = ringPts(raw);
    if (ring.length < 4) continue;
    const d = [0];
    for (let i = 1; i < ring.length; i++) d.push(d[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
    const per = d[d.length - 1];
    if (!per) continue;
    const at = (t: number): Pt => {
      const u = ((t % per) + per) % per;
      let i = 1; while (i < d.length - 1 && d[i] < u) i++;
      const k = (u - d[i - 1]) / ((d[i] - d[i - 1]) || 1);
      return [ring[i - 1][0] + (ring[i][0] - ring[i - 1][0]) * k, ring[i - 1][1] + (ring[i][1] - ring[i - 1][1]) * k];
    };
    /* the quiet share is the default state of the world: it is the base the marks sit on,
       drawn thin so what the eye finds on a green border is the piece that is not green */
    out.push({ type: "Feature", properties: { verdict: "base" }, geometry: { type: "LineString", coordinates: ring } });
    for (const m of rg.marks ?? []) {
      /* the angle from the region's centre to the site picks the vertex pointing the same
         way, and the run is centred there: a site in the south paints the southern edge */
      const want = Math.atan2(m.lat - rg.lat, m.lon - rg.lon);
      let mid = 0, bestGap = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const a = Math.atan2(ring[i][1] - rg.lat, ring[i][0] - rg.lon);
        let gap = Math.abs(a - want);
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (gap < bestGap) { bestGap = gap; mid = d[i]; }
      }
      /* one alerting site in a large state is a sliver, and it never falls below a length
         the eye can find — the floor the canvas kept at two pixels */
      const len = Math.max(per * 0.06, per / rg.sites);
      const steps = Math.max(6, Math.ceil((len / per) * ring.length));
      const pts: Pt[] = [];
      for (let k = 0; k <= steps; k++) pts.push(at(mid - len / 2 + (len * k) / steps));
      out.push({ type: "Feature", properties: { verdict: m.verdict }, geometry: { type: "LineString", coordinates: pts } });
    }
  }
  return out;
}

/** How much wider than its sites the frame is drawn, matching the canvas layout. */
const SPAN_MARGIN = 1.35;

type Label = { key: string; kind: "site" | "region"; lon: number; lat: number; text: string; rank: number; dc?: boolean; bad?: boolean; picked?: boolean };

/**
 * The names, and which of them fit.
 *
 * A marker per label and nothing else would stack Guarulhos over São Paulo over SP at every
 * zoom the reader did not choose. The canvas ran a box test in draw order and dropped what
 * collided; the same pass runs here on the settled camera — `map.project` gives the pixel,
 * the element gives the width, and anything overlapping something already taken is hidden.
 * It runs on `moveend` rather than per frame because it reads layout, and a label that
 * reappears mid-drag is worse than one that waits for the camera to stop.
 */
/**
 * How many names can be on the map at once.
 *
 * The collision pass can seat perhaps forty before they touch; this is several times that, so
 * the cap never decides what the reader sees — the pass still does. It decides how many DOM
 * nodes exist to be measured. On the four-thousand-site estate the component mounted a marker
 * per site, 4,170 of them, and then read `offsetWidth` on each one: a forced reflow per label,
 * measured as a single task of six seconds with the page frozen inside it.
 */
const LABEL_BUDGET = 160;

/**
 * The sites, and what to draw where several fall on the same pixel.
 *
 * One dot per site is right for a dozen and a green smear for four thousand: on the
 * twenty-thousand-device estate a city with twelve stores drew twelve fourteen-pixel circles
 * on top of each other, and a region drew a blob with no edges. Past the threshold the sites
 * within a cell of the screen become one mark that says how many it stands for and carries
 * the worst of their verdicts, so the colour still means what it means. The grid is in
 * pixels, not degrees, so it follows the zoom: zooming in splits a cluster into the sites it
 * was hiding, which is the only honest way to make that mark disappear.
 */
const CLUSTER_ABOVE = 300;
/**
 * How far apart two marks have to be to be two marks.
 *
 * A grid was tried here first and it is the wrong shape for the problem: sites cluster around
 * a city, cities do not line up with a lattice, and a tight group straddling a cell boundary
 * comes out as two marks a few pixels apart — which is what made a city of twenty stores read
 * as a spray of green confetti rather than as one place. This absorbs by distance instead: a
 * mark is placed, and anything within the width of a mark belongs to it. Nothing can overlap,
 * at any zoom, whatever the data does.
 */
const MARK_PX = 34;

type Dot = { name: string; code: string; latitude: number; longitude: number; verdict: Verdict; dc: boolean };

/* `DotLayer` carries no click of its own — opening a site is `Motion`'s hit test, which
   works off the site list and is unchanged by the clustering. */
function Dots({ sites, colour }: { sites: MapSite[]; colour: Record<Verdict, string> }) {
  const { current: map } = useMap();
  const [dots, setDots] = useState<(Dot & { of: number })[]>([]);

  const build = useCallback(() => {
    const one = (s: MapSite, of: number, name?: string) => ({
      name: name ?? s.name, code: s.code, latitude: s.lat, longitude: s.lon, verdict: s.verdict, dc: !!s.dc, of,
    });
    if (!map || sites.length <= CLUSTER_ABOVE) { setDots(sites.map((s) => one(s, 1))); return; }
    /* the order decides which site a group is named after and where its mark sits: a data
       centre first, then whatever is worst, so a cluster never hides the reason to look at it */
    const order = sites.slice().sort((a, b) =>
      Number(!!b.dc) - Number(!!a.dc) || RANKED.indexOf(a.verdict) - RANKED.indexOf(b.verdict));
    const marks: { lead: MapSite; x: number; y: number; n: number; v: Verdict[] }[] = [];
    const r2 = MARK_PX * MARK_PX;
    for (const s of order) {
      const p = map.project([s.lon, s.lat]);
      /* a data centre is never absorbed: it is the end of every line on the map */
      const near = s.dc ? undefined
        : marks.find((m) => !m.lead.dc && (m.x - p.x) ** 2 + (m.y - p.y) ** 2 < r2);
      if (near) { near.n++; near.v.push(s.verdict); }
      else marks.push({ lead: s, x: p.x, y: p.y, n: 1, v: [s.verdict] });
    }
    setDots(marks.map(({ lead, n, v }) => ({
      ...one(lead, n, n > 1 ? `${n} sites · worst ${worst(v)}` : lead.name), verdict: worst(v),
    })));
  }, [map, sites]);

  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const t = setTimeout(build, 0);
    m.on("moveend", build); m.on("zoomend", build);
    return () => { clearTimeout(t); m.off("moveend", build); m.off("zoomend", build); };
  }, [map, build]);

  /* `shapeSize` is one number for the whole layer, so the three sizes are three layers: a
     site, a handful and a crowd. Three buckets is enough to tell them apart and keeps the
     mark honest — the number itself is in the tooltip, where it is exact. */
  const band = (lo: number, hi: number) => dots.filter((d) => d.of >= lo && d.of <= hi);
  const layer = (data: (Dot & { of: number })[], size: number, key: string) => (data.length ? (
    <DotLayer<Dot & { of: number }> key={key} data={data} shape="circle" shapeSize={size}
      color={(d) => colour[d.verdict]}>
      <DotLayer.Tooltip>
        {(dot) => <span>{String((dot.data as { name?: string })?.name ?? "")}</span>}
      </DotLayer.Tooltip>
    </DotLayer>
  ) : null);

  return <>{layer(band(1, 1), 14, "one")}{layer(band(2, 9), 20, "few")}{layer(band(10, Infinity), 28, "many")}</>;
}

function Labels({ labels }: { labels: Label[] }) {
  const { current: map } = useMap();
  const els = useRef(new Map<string, HTMLElement>());
  /**
   * The names worth mounting, for where the camera is now.
   *
   * Only what is inside the viewport can be read, and only a few of those will survive the
   * collision pass, so the rest are not rendered at all. The set is recomputed when the camera
   * stops, which is also when the pass runs, so a reader who zooms into a corner of a large
   * estate gets that corner's names — the cap is per view, never per estate.
   */
  const [shown, setShown] = useState<Label[]>([]);
  const hold = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(key, el); else els.current.delete(key);
  }, []);

  /* what is in view, worst and most specific first, capped — run before the pass that hides
     the ones that collide */
  const pick = useCallback(() => {
    if (!map) return;
    const b = map.getMap().getBounds();
    const inView = labels.filter((l) => l.lon >= b.getWest() && l.lon <= b.getEast()
      && l.lat >= b.getSouth() && l.lat <= b.getNorth());
    const rank = (l: Label) => (l.picked ? 0 : l.dc ? 1 : l.bad ? 2 : l.kind === "region" ? 3 : 4);
    const next = inView.sort((x, y) => rank(x) - rank(y) || (y.rank ?? 0) - (x.rank ?? 0)).slice(0, LABEL_BUDGET);
    setShown((prev) => (prev.length === next.length && prev.every((p, i) => p.key === next[i].key) ? prev : next));
  }, [map, labels]);

  const lay = useCallback(() => {
    if (!map) return;
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    /* the order is the canvas's: a region with more than one site is named first, because a
       state's name belongs to the whole shape; then the sites; then the one-site regions,
       where the site's own name says more than "SC · 1" does */
    const order = [
      /* The name the reader just asked for is placed before anything else, including the
         states. Picking a one-site group in the list flew the camera onto that site and then
         dropped its name, because a neighbouring site is half a degree away and was laid
         out first: the ring sat on one dot and the only name on screen belonged to the other.
         A label is dropped when it collides, and the one that must never be the casualty is
         the site the selection is about. */
      ...shown.filter((l) => l.picked),
      ...shown.filter((l) => !l.picked && l.kind === "region" && l.rank > 1).sort((a, b) => b.rank - a.rank),
      ...shown.filter((l) => !l.picked && l.kind === "site").sort((a, b) => Number(b.dc) - Number(a.dc)),
      ...shown.filter((l) => !l.picked && l.kind === "region" && l.rank <= 1),
    ];
    for (const l of order) {
      const el = els.current.get(l.key);
      if (!el) continue;
      const p = map.project([l.lon, l.lat]);
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w) { el.style.visibility = "hidden"; continue; }
      const x = l.kind === "site" ? p.x + 10 : p.x - w / 2;
      const y = p.y - h / 2;
      /* boxes that merely touch still read as one name, so a label needs clear space around
         it rather than only no overlap */
      const box = { x0: x - 8, y0: y - 3, x1: x + w + 8, y1: y + h + 3 };
      const hit = taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0);
      el.style.visibility = hit ? "hidden" : "visible";
      if (!hit) taken.push({ x0: x, y0: y, x1: x + w, y1: y + h });
    }
  }, [map, shown]);

  /* which names exist, recomputed where the camera stops */
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const t = setTimeout(pick, 0);
    m.on("moveend", pick);
    m.on("zoomend", pick);
    return () => { clearTimeout(t); m.off("moveend", pick); m.off("zoomend", pick); };
  }, [map, pick]);

  /* and which of them fit, once they are mounted */
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const t = setTimeout(lay, 0);
    m.on("moveend", lay);
    m.on("zoomend", lay);
    return () => { clearTimeout(t); m.off("moveend", lay); m.off("zoomend", lay); };
  }, [map, lay]);

  return (
    <>
      {shown.map((l) => (
        <Marker key={l.key} longitude={l.lon} latitude={l.lat}
          anchor={l.kind === "site" ? "left" : "center"} offset={l.kind === "site" ? [10, 0] : [0, 0]}>
          <span ref={hold(l.key)}
            className={`lmg-lbl lmg-lbl--${l.kind}${l.dc ? " is-dc" : ""}${l.bad ? " is-bad" : ""}`}>
            {l.text}
          </span>
        </Marker>
      ))}
    </>
  );
}

/**
 * The ground: the hotspot, the states, and their edges.
 *
 * It is a component of its own and not part of `Motion` because of paint order, which in
 * maplibre is mount order. These three belong under the platform's own routes and dots —
 * mounted after them, the state fill covered the estate — so they are a separate child,
 * rendered before `ConnectionLayer`.
 */
function Ground({ regions, share, routes, focus, colour }: {
  regions: Feat[]; share: Feat[]; routes: Feat[];
  /** one point per site in the focus, each of which gets a ring */
  focus: Feat[];
  colour: Record<string, string>;
}) {
  return (
    <>
      {/**
        * The focus is a ring on each site, and it carries no colour.
        *
        * It was a blurred disc at the centre of the focus, which is a point and not a place:
        * with two sites in the focus the centre of them fell in the sea off Santa Catarina,
        * so the mark sat on open water while the two sites it stood for were unmarked. And
        * it was painted in a status colour, which on a focus where nothing is wrong told the
        * reader a fault was there — the drill-down then had nothing to explain it with.
        *
        * A ring on each site says "this is what you picked", in the page's own ink — unless
        * that site carries a status, and then the ring carries it too. Colour on this map
        * means status and nothing else, so the mark either reports one or stays neutral.
        */}
      <Source id="nf-focus" type="geojson" data={fc(focus)}>
        <Layer id="nf-focus" type="circle" paint={{
          "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 1.5,
          "circle-stroke-color": ["match", ["get", "verdict"],
            "Critical", colour.Critical, "Warning", colour.Warning, colour.ink],
          "circle-stroke-opacity": ["match", ["get", "verdict"], "Critical", 0.9, "Warning", 0.9, 0.45],
        }} />
      </Source>
      {/* A state is a container, not a thing with a status: washing it in the colour of its
          worst site said "Rio de Janeiro is critical" of three sites in a hundred and ninety
          seven. The shape is context — the fill is ink, and the status lives on the edge. */}
      <Source id="nf-regions" type="geojson" data={fc(regions)}>
        <Layer id="nf-regions-fill" type="fill"
          paint={{ "fill-color": colour.ink, "fill-opacity": ["case", [">", ["get", "sites"], 0], 0.07, 0.025] }} />
        <Layer id="nf-regions-line" type="line"
          paint={{ "line-color": colour.ink,
            "line-opacity": ["case", [">", ["get", "sites"], 0], 0.38, 0.16],
            "line-width": ["case", [">", ["get", "sites"], 0], 1.1, 0.7] }} />
      </Source>
      <Source id="nf-share" type="geojson" data={fc(share)}>
        <Layer id="nf-share" type="line" paint={{
          "line-color": ["match", ["get", "verdict"], "Critical", colour.Critical, "Warning", colour.Warning, colour.Healthy],
          "line-width": ["match", ["get", "verdict"], "base", 1.4, 3], "line-blur": 0.4,
          "line-opacity": ["match", ["get", "verdict"], "Critical", 0.95, "Warning", 0.9, 0.3],
        }} />
      </Source>
    </>
  );
}

/**
 * The parts that move, and the parts the platform has no layer for.
 *
 * It is one component because all of it needs the same thing: the live map, which only a
 * child of `MapView` can ask for.
 */
function Motion({ routes, hit: hitRegions, all, focus, focusKey, refit, colour, sites, onSite, onRegion, pad }: {
  routes: { id: string; verdict: Verdict; vol: number; path: Pt[] }[];
  hit: MapRegion[];
  /** everything the estate holds, which is the opening view */
  all: Box | null;
  focus: Box | null; focusKey: string;
  /** bumped by the fit button, so the camera goes back to the focus the reader panned away from */
  refit: number;
  colour: Record<string, string>;
  sites: MapSite[];
  onSite: (code: string) => void;
  onRegion?: (r: MapRegion) => void;
  pad: Insets;
}) {
  const { current: map } = useMap();
  /* the hit test reads the regions through a ref so a new list does not re-bind the handler */
  const regionsRef = useRef(hitRegions);
  regionsRef.current = hitRegions;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const live = useRef({ routes, reduce });
  live.current = { routes, reduce };

  /**
   * The camera: the estate while it is still arriving, the focus once it has.
   *
   * Opening on the focus was wrong in the way that matters on a first look — the page picks
   * a cause by itself before the reader has asked anything, and the map opened on one site
   * and its data centre with the other seven off the edge. So the opening view is everything
   * the estate holds, and it keeps up as the sites arrive; the camera starts following the
   * focus only once the count has stood still for a moment, and then only when the reader
   * changes it. The flight is the platform's own ease over the canvas's own frame.
   */
  const [settled, setSettled] = useState(false);
  const n = sites.length;
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 1200);
    return () => clearTimeout(t);
  }, [n]);
  const was = useRef<string | null>(null);
  const anchored = useRef(false);
  useEffect(() => {
    if (!map) return;
    /* Padding is what the floating panels cover, and it can never cost more than the stage
       has: a pair of insets wider than the canvas leaves `fitBounds` a negative area, and it
       answers with a camera that is neither the frame asked for nor centred on anything. Each
       axis keeps at least a third of the stage for the map itself. */
    const { width: cw, height: ch } = map.getMap().getCanvas().getBoundingClientRect();
    const fit = (a: number, b: number, span: number) => {
      const room = Math.max(span * 0.67, 1), over = a + b;
      return over <= room ? [a, b] : [a * room / over, b * room / over];
    };
    const [left, right] = fit(pad.left + 32, pad.right + 32, cw);
    const [top, bottom] = fit(pad.top + 32, pad.bottom + 32, ch);
    const pad4 = { top, right, bottom, left };
    const to = (b: Box, duration: number) => map.fitBounds([[b.west, b.south], [b.east, b.north]], {
      padding: pad4, duration,
      easing: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    });
    const key = `${focusKey}|${refit}`;
    if (!anchored.current) {
      /* the estate, kept in frame as it arrives; when it stops growing the camera stops
         following it and takes the focus of that moment as read, unflown */
      if (settled) { anchored.current = true; was.current = key; return; }
      if (all) to(all, 0);
      return;
    }
    if (!focus || was.current === key) return;
    was.current = key;
    to(focus, reduce ? 0 : 1100);
  }, [map, all, focus, focusKey, refit, settled, reduce, pad]);

  /* the two callbacks the page passes: a click near a site opens it, a click inside a state
     opens the state. Nearest-within-fourteen-pixels is the canvas's own hit test — the
     platform's layers carry an active state of their own but hand us no click */
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    const hit = (e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
      let best: MapSite | null = null, dist = 14;
      for (const s of sites) {
        const p = m.project([s.lon, s.lat]);
        const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
        if (d < dist) { dist = d; best = s; }
      }
      if (best) { onSite(best.code); return; }
      if (!onRegion) return;
      for (const r of regionsRef.current) {
        if (r.sites && r.rings.some((ring) => pointInRing(ring, e.lngLat.lng, e.lngLat.lat))) { onRegion(r); return; }
      }
    };
    m.on("click", hit);
    return () => { m.off("click", hit); };
  }, [map, sites, onSite, onRegion]);

  /**
   * Packets, and the marching ants, on one frame loop.
   *
   * The packets are a GeoJSON source rewritten per frame rather than a WebGL custom layer:
   * it is the smaller of the two and it is enough at this estate's size. If a reader ever
   * opens this on four thousand sites, this is the line to come back to.
   */
  useEffect(() => {
    if (!map) return;
    const m = map.getMap();
    let raf = 0;
    let going = false;
    const at = (path: Pt[], t: number, off: number): Pt => {
      const f = Math.max(0, Math.min(0.999, t)) * (path.length - 1);
      const i = Math.floor(f), k = f - i;
      const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
      const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k;
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      return [x + (-dy / len) * off, y + (dx / len) * off];
    };
    /**
     * The marching ants, as a continuous phase rather than eight canned frames.
     *
     * `line-dasharray` carries no offset, so the dash has to be re-cut every frame, and the
     * prototype stepped through a table of eight — which is fourteen frames a second next to
     * packets running at sixty, and it read as a stutter. The pattern is a dash of three in
     * a period of seven, and it accepts fractions: where the dash does not wrap it is a
     * leading gap of `p`, and where it does, the tail of it opens the pattern.
     */
    /**
     * No element of the pattern may be zero.
     *
     * maplibre builds a dash atlas from these four numbers, and a length of zero gives it a
     * segment with no extent: the lookup comes back null and the renderer throws
     * `Cannot read properties of null (reading 'y')` inside `setConstantDashPositions` —
     * on every frame, because this runs on every frame. Measured on the twenty-thousand
     * device estate: thirty-three thousand uncaught exceptions in one sitting, the map still
     * drawing and the console unusable. Both branches here produce a zero — the first at the
     * head, the second at the tail, and both at p exactly 4 — so each element is floored at a
     * hair above nothing, which the atlas accepts and the eye cannot tell from zero.
     */
    const NIL = 0.001;
    /**
     * A fixed number of phases, because maplibre caches each one for ever.
     *
     * Every distinct `line-dasharray` becomes an entry in maplibre's dash atlas, and the
     * atlas has a fixed height. Cutting the dash to a fraction on every frame — which is what
     * made the motion continuous instead of the prototype's eight canned steps — asks for a
     * pattern it has never seen sixty times a second, so within seconds the atlas is full,
     * `getDash` returns null and the renderer throws `Cannot read properties of null
     * (reading 'y')` on every frame after that. Measured on the twenty-thousand device
     * estate: thirty-three thousand uncaught exceptions in one sitting.
     *
     * Fifty-six phases over the seven-unit period is one step every 20 ms at this speed —
     * smooth to the eye, and fifty-six atlas entries that are written once and then hit.
     */
    const PHASES = 56;
    const dashAt = (p: number) => {
      const q = (Math.round((p / 7) * PHASES) % PHASES) * (7 / PHASES);
      return (q <= 4 ? [0, q, 3, 4 - q] : [q - 4, 4, 7 - q, 0]).map((v) => Math.max(NIL, v));
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      /**
       * Nothing moves until the map says it has loaded, and that is not politeness.
       *
       * Rewriting a GeoJSON source marks it unparsed until the worker answers, so a source
       * rewritten every frame means `isStyleLoaded()` is never true — and the component
       * shows its own spinner for as long as that is the case. The map had a progress ring
       * sitting in the middle of it for the whole session, put there by our own animation.
       * `load` fires once; after it the ring is gone for good. The wait is latched, because
       * our own `setData` is what makes `loaded()` false from the second frame onwards — a
       * plain check would have stopped the animation for the rest of the session.
       */
      if (!going) {
        if (!m.loaded()) return;
        going = true;
      }
      const { routes: rs, reduce: quiet } = live.current;
      const src = m.getSource("nf-packets") as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) {
        const feats: Feat[] = [];
        if (!quiet) {
          for (const r of rs) {
            if (!r.vol) continue;
            const phase = hash(r.id), count = Math.max(1, Math.round(1 + r.vol * 5));
            const period = 3400 - r.vol * 2400;
            for (const back of [false, true]) {
              for (let p = 0; p < count; p++) {
                const t0 = ((now / period) + phase + (back ? 0.37 : 0) + p / count) % 1;
                feats.push({ type: "Feature", properties: { vol: r.vol, verdict: r.verdict },
                  geometry: { type: "Point", coordinates: at(r.path, back ? 1 - t0 : t0, (back ? 1 : -1) * 0.12) } });
              }
            }
          }
        }
        src.setData(fc(feats));
      }
      if (m.getLayer("nf-routes-bad")) {
        m.setPaintProperty("nf-routes-bad", "line-dasharray",
          quiet ? [2, 2] : dashAt(((now / 1200) * 7) % 7));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  return (
    <>
      {/* the routes that are alerting get a layer of their own, because the dash is stepped on it */}
      <Source id="nf-routes-bad" type="geojson" data={fc(routes.filter((r) => r.verdict === "Critical").map((r) => ({
        type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: r.path },
      })))}>
        <Layer id="nf-routes-bad" type="line"
          paint={{ "line-color": colour.Critical, "line-width": 2, "line-blur": 0.5, "line-dasharray": [2, 2] }} />
      </Source>
      <Source id="nf-packets" type="geojson" data={fc([])}>
        <Layer id="nf-packets" type="circle" paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "vol"], 0, 2, 1, 4],
          "circle-color": ["match", ["get", "verdict"], "Critical", colour.Critical, colour.series],
          "circle-opacity": 0.95,
          /* a ring in the ground's own colour, so a packet reads as a packet on the route
             rather than as a bump in the line it rides */
          "circle-stroke-width": 1, "circle-stroke-color": colour.bg, "circle-stroke-opacity": 0.5,
        }} />
      </Source>
    </>
  );
}

export function LiveMapGeo({ sites, links, focus, insets, onSite, regions, onRegion }: {
  sites: MapSite[]; links: MapLink[]; focus: Set<string> | null; insets: Insets;
  onSite: (code: string) => void; schematic?: boolean;
  regions?: MapRegion[]; onRegion?: (r: MapRegion) => void;
}) {
  const [ink, inkRef] = useTokens(INK);
  /**
   * The height in pixels, measured, because the component will not take a percentage.
   *
   * `MapView` passes `height` through `_coerceSizeValue`, which answers for numbers and for
   * `px`; `"100%"` falls through to the four-hundred-pixel default, and the map drew a strip
   * across the top of a stage twice that tall. The stage's own rules place the box — this
   * only reads back what they decided.
   */
  const api = useRef<MapViewRef | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [H, setH] = useState(440);
  const [refit, setRefit] = useState(0);
  /* full screen, the same two ways the canvas offered it: the real one where the frame allows
     it, and the app's own viewport where it does not. Escape leaves either. */
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => undefined); setFull(false); return; }
    if (full) { setFull(false); return; }
    box.current?.requestFullscreen?.().then(() => setFull(true)).catch(() => setFull(true));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && full && !document.fullscreenElement) setFull(false); };
    const onChange = () => { if (!document.fullscreenElement) setFull((v) => (v ? false : v)); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("fullscreenchange", onChange); };
  }, [full]);
  const hold = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    inkRef(el);
  }, [inkRef]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.max(240, Math.round(el.clientHeight))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colour: Record<string, string> = {
    Critical: ink["--lm-bad-fill"], Warning: ink["--lm-warn-fill"],
    Healthy: ink["--lm-good-fill"], "Not monitored": ink["--lm-neutral"],
    series: ink["--lm-series"], ink: ink["--lm-ink"], bg: ink["--lm-bg"],
  };
  const byCode = useMemo(() => new Map(sites.map((s) => [s.code, s])), [sites]);

  /**
   * A route is the curve between the two ends of a link — one curve per pair, not per link.
   *
   * The canvas kept its routes in a map keyed by the sorted pair and merged what landed on
   * the same key. Drawing one curve per link instead put two arcs between the data centre
   * and LEM: the same pair arrives twice, once from the reported cable and once from the
   * flow, and because the bend is taken from the order of the ends the second one curved
   * the other way. Two lines bulging apart read as two circuits, which is a thing this
   * estate does not have.
   */
  /**
   * Above this many links the line stops standing for a site.
   *
   * Four thousand sites each drawn to their data centre is four thousand arcs converging on
   * five points: a solid mass that answers nothing, and an animation the browser cannot keep
   * up with. The estate already learned this lesson for its dots — past a couple of dozen the
   * unit becomes the region — and a line is the same question. Below the threshold nothing
   * changes and every site keeps its own line.
   */
  const ROUTE_BUDGET = 120;

  const routes = useMemo(() => {
    const by = new Map<string, { id: string; verdict: Verdict; vol: number; path: Pt[]; of: number }>();
    /* one line per region and data centre, when there are too many to read one per site: the
       region's end is the mean of the sites it stands for, and the line carries the worst of
       their verdicts and the largest volume measured on any of them */
    const group = links.length > ROUTE_BUDGET;
    const home = new Map<string, { lon: number; lat: number; n: number }>();
    if (group) {
      for (const sIt of sites) {
        const k = sIt.region || "—";
        const h = home.get(k);
        if (h) { h.lon += sIt.lon; h.lat += sIt.lat; h.n++; } else home.set(k, { lon: sIt.lon, lat: sIt.lat, n: 1 });
      }
      home.forEach((h) => { h.lon /= h.n; h.lat /= h.n; });
    }
    for (const l of links) {
      const a0 = byCode.get(l.a), b = byCode.get(l.b);
      if (!a0 || !b) continue;
      /* the far end keeps its own place — it is the data centre, and there are few of them */
      const h = group ? home.get(a0.region || "—") : null;
      const a = h ? { ...a0, lon: h.lon, lat: h.lat, code: a0.region || "—" } : a0;
      const vol = Math.max(0, Math.min(1, (l.bps ?? 0) / 2e9));
      const key = [a.code, b.code].sort().join("|");
      const had = by.get(key);
      if (had) {
        /* the pair carries the worse of what was said about it, and the traffic actually
           measured on it, which is the larger of the two readings */
        had.verdict = worst([had.verdict, l.verdict]);
        had.vol = Math.max(had.vol, vol);
        had.of++;
        continue;
      }
      /* the ends in a fixed order, so the same pair always bends the same way */
      const [p, q] = a.code < b.code ? [a, b] : [b, a];
      by.set(key, { id: key, verdict: l.verdict, vol, of: 1, path: curve([p.lon, p.lat], [q.lon, q.lat]) });
    }
    return [...by.values()];
  }, [links, byCode, sites]);

  /**
   * What the camera has to hold: the focus, the data centres it talks to, and a floor.
   *
   * This is the canvas's own `fitTo`, which is why it is not simply "centre on the focus at
   * a zoom that suits it". Two rules of it matter and both came from use: a site is shown
   * with the data centre its link ends at, because a WAN link with one end off screen is
   * half a picture; and the span never falls below eighteen degrees by ten, so one site is
   * still a part of a country rather than a street map of an empty ground.
   *
   * It is keyed on the codes rather than on the set, because the page builds a new `Set` on
   * every render — an effect that depended on the object eased the camera back between
   * every drag, and the map looked frozen.
   */
  const focusKey = focus ? [...focus].sort().join(",") : "";
  /* one set per key, so the frame, the rings and the labels all read the same selection */
  const focusCodes = useMemo(() => (focusKey ? new Set(focusKey.split(",")) : null), [focusKey]);
  const lastBox = useRef<Record<string, Box | null>>({});
  /** the frame for a set of codes, kept identical while its numbers are */
  const boxOf = useCallback((slot: string, codes: Set<string> | null) => {
    const pts = sites.filter((s) => !codes || codes.has(s.code)
      || (s.dc && links.some((l) => (l.a === s.code && codes.has(l.b)) || (l.b === s.code && codes.has(l.a)))));
    if (!pts.length) return null;
    const lons = pts.map((s) => s.lon), lats = pts.map((s) => s.lat);
    const cx = (Math.min(...lons) + Math.max(...lons)) / 2, cy = (Math.min(...lats) + Math.max(...lats)) / 2;
    /**
     * The sites sit inside the frame, not on its edge.
     *
     * `fitBounds` frames the points it is given, and a site's name hangs ten pixels to the
     * right of its dot and runs on for the length of the name. Measured on an estate of two
     * data centres seventy-five degrees apart: the dots landed on the padded edges and "LON
     * Data Center" ended fifty-five pixels past the end of the canvas. The canvas layout has
     * always inflated the span by a third before fitting; this is the same margin, applied
     * to the measured span only, so a single site still gets exactly the floor below it.
     */
    const dx = Math.max((Math.max(...lons) - Math.min(...lons)) * SPAN_MARGIN, 18) / 2;
    const dy = Math.max((Math.max(...lats) - Math.min(...lats)) * SPAN_MARGIN, 10) / 2;
    const next: Box = { lon: cx, lat: cy, west: cx - dx, east: cx + dx, south: cy - dy, north: cy + dy };
    const had = lastBox.current[slot];
    /* the same frame is the same object: `sites` grows all through the load, and a fresh one
       for an unchanged set re-fitted the camera every few hundred milliseconds */
    if (had && had.west === next.west && had.east === next.east && had.south === next.south && had.north === next.north) return had;
    lastBox.current[slot] = next;
    return next;
  }, [sites, links]);
  /* everything the estate holds: the opening view, and what the camera keeps while the
     sites are still arriving */
  const all = useMemo(() => boxOf("all", null), [boxOf]);
  const frame = useMemo(() => boxOf("focus", focusCodes), [boxOf, focusCodes]);

  /* the generics are pinned by annotating the arrays: without them TypeScript widens the
     rows to `Location` / `Connection` and the colour callbacks no longer match */
  type Conn = { path: { longitude: number; latitude: number }[]; verdict: Verdict };
  /* only the quiet links are the platform's: the alerting ones carry the marching ants, and
     that is a layer of ours with a dash stepped per frame */
  const conns: Conn[] = useMemo(() => routes.filter((r) => r.verdict !== "Critical").map((r) => ({
    path: r.path.map(([longitude, latitude]) => ({ longitude, latitude })), verdict: r.verdict,
  })), [routes]);

  /* the sites the reader picked, each of which gets a ring */
  const focusPoints = useMemo<Feat[]>(() => {
    if (!focusCodes) return [];
    return sites.filter((s) => focusCodes.has(s.code)).map((s) => ({
      type: "Feature" as const, properties: { verdict: s.verdict },
      geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] as Pt },
    }));
  }, [focusCodes, sites]);

  /* the same paths the platform draws, as plain features, for the glow under them */
  const routeFeats = useMemo<Feat[]>(() => routes.map((r) => ({
    type: "Feature" as const, properties: { verdict: r.verdict, vol: r.vol },
    geometry: { type: "LineString" as const, coordinates: r.path },
  })), [routes]);

  const shapes = useMemo<Feat[]>(() => (regions ?? []).filter((r) => r.rings.length).map((r) => ({
    type: "Feature" as const, properties: { sites: r.sites },
    geometry: { type: "Polygon" as const, coordinates: r.rings.map(ringPts) },
  })), [regions]);
  const share = useMemo<Feat[]>(() => (regions ?? []).flatMap(shareArcs), [regions]);

  const labels = useMemo<Label[]>(() => [
    ...sites.map((s) => ({ key: `s:${s.code}`, kind: "site" as const, lon: s.lon, lat: s.lat,
      text: s.name, rank: 0, dc: !!s.dc, picked: !!focusCodes?.has(s.code) })),
    ...(regions ?? []).filter((r) => r.sites).map((r) => ({
      key: `r:${r.code}|${r.name}`, kind: "region" as const, lon: r.lon, lat: r.lat, rank: r.sites,
      /* the count is ink; only the words that report alerts wear the status colour */
      text: r.bad ? `${r.code || r.name} · ${r.sites} · ${r.bad} alerting` : `${r.code || r.name} · ${r.sites}`,
      bad: !!r.bad })),
  ], [sites, regions, focusCodes]);

  return (
    <div className={`lm-map lm-geo${full ? " is-full" : ""}`} ref={hold}>
      <MapView ref={api} height={H} initialViewState={{ longitude: -48, latitude: -17, zoom: 3.3 }}>
        {/* mount order is paint order: the ground, then the platform's routes, then the two
            layers that move, then the sites on top of all of it */}
        {/* the hotspot belongs to a focus, not to the estate: with nothing picked the frame
            is the whole country and a glow in the middle of it points at nothing */}
        <Ground regions={shapes} share={share} routes={routeFeats} focus={focusPoints} colour={colour} />
        {/* the links, drawn by the platform */}
        {/* Every route wears the status of the link it stands for — a healthy one included.
            What the platform's layer cannot carry is the width: the canvas made a route as
            thick as it carries. That reading moves to the glow below, which is interpolated
            on the same volume. */}
        {/* `curve="linear"`, and the curve is ours.
            Asked to smooth, the component runs its own interpolation through the points it
            is given — and through ninety-six samples of a quadratic that is already smooth
            it overshoots between them, so the line arrived scalloped. Worse, its curve is
            then not the curve the glow and the packets ride, and the two geometries beat
            against each other into a shadow alongside the line. One path, drawn straight
            through the samples, is smooth at this density and is the same path for all
            three layers. */}
        {/* thinner as there are more of them: three points is right for a dozen arcs and a
            smear for a hundred, and the line is there to be followed, not to be loud */}
        <ConnectionLayer<Conn> data={conns} curve="linear"
          thickness={routes.length > 24 ? 1 : routes.length > 8 ? 2 : 3}
          color={(c) => colour[c.verdict]} />
        <Motion routes={routes} hit={regions ?? []} all={all} focus={frame} focusKey={focusKey} refit={refit} colour={colour}
          sites={sites} onSite={onSite} onRegion={onRegion} pad={insets} />
        {/* the sites, clustered where several land on the same pixel */}
        <Dots sites={sites} colour={colour} />
        <Labels labels={labels} />
      </MapView>
      {/* The three buttons the canvas drew itself, in the place it drew them.
          `MapView.Toolbar` is the platform's own and it is what a chart carries, but on a
          map that fills the stage under two floating panels it has nowhere to sit that the
          panels do not cover. These call the component's own ref, so it is still the map
          doing the zooming. */}
      <div className="lm-zoom" style={{ right: insets.right + 12, bottom: insets.bottom + 12 }}>
        <button type="button" onClick={() => api.current?.zoomIn()} aria-label="Zoom in"><PlusIcon /></button>
        <button type="button" onClick={() => api.current?.zoomOut()} aria-label="Zoom out"><MinusIcon /></button>
        <button type="button" onClick={() => setRefit((n) => n + 1)}
          aria-label="Fit to focus"><ZoomToFitIcon /></button>
        <button type="button" onClick={toggleFull} aria-pressed={full}
          title={full ? "Leave full screen (Esc)" : "Full screen"}
          aria-label={full ? "Leave full screen" : "Show the map full screen"}>{full ? <MinimizeIcon /> : <MaximizeIcon />}</button>
      </div>
    </div>
  );
}
