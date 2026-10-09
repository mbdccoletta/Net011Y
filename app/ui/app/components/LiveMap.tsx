// Living network map on canvas: land as a dot matrix, WAN routes that pulse towards the
// data centers, sites coloured by status, and the selected cause glowing on the territory.
// The camera flies to whatever is in focus; drag to pan, Ctrl/Cmd + scroll (or pinch) to zoom, click a site.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MaximizeIcon, MinimizeIcon, MinusIcon, PlusIcon, ZoomToFitIcon } from "@dynatrace/strato-icons";
import type { Verdict } from "../model/types";
import { LAND_BITS, LAND_COLS, LAND_ROWS, LAND_STEP } from "../data/landMask";
import { prefersReducedMotion } from "../utils/format";
import { clusterPoints, worstOf, type Cluster } from "../model/mapClusters";

export interface MapSite {
  code: string;
  name: string;
  lat: number;
  lon: number;
  verdict: Verdict;
  dc?: boolean;
  region?: string;
  cause?: string | null;
}

/** A state, province or prefecture to draw: its outline, and what the sites inside it add up to. */
/** The order the outline is painted in, worst first, so the red sliver always starts at the same point. */
const SHARE_ORDER: Verdict[] = ["Critical", "Warning", "Healthy", "Not monitored"];

export interface MapRegion {
  code: string;
  name: string;
  lon: number;
  lat: number;
  rings: Float64Array[];
  /** the worst status standing in the region: what the label says, never what the shape is washed with */
  verdict: Verdict;
  sites: number;
  /** how many of those sites are red or amber */
  bad: number;
  /** how the sites standing here divide by status, which the outline is drawn in proportion to */
  counts: Partial<Record<Verdict, number>>;
}

export interface MapLink {
  id: string;
  a: string;
  b: string;
  verdict: Verdict;
  /** Current traffic on the link in bits per second (in + out); 0 when nothing flows, null when not measured */
  bps?: number | null;
  /** the same split by direction, when the interface counters say which way it went: b → a and a → b */
  bpsIn?: number | null;
  bpsOut?: number | null;
}

export interface Insets { top: number; right: number; bottom: number; left: number }

interface Props {
  sites: MapSite[];
  links: MapLink[];
  /** Site codes of the selected cause; null shows the whole network */
  focus: Set<string> | null;
  /** Replay: false while a site is not yet affected at the cursor time */
  insets: Insets;
  onSite: (code: string) => void;
  /** sites placed by the app rather than by coordinates: no continents behind them */
  schematic?: boolean;
  /** the state layer: outlines drawn under the sites, filled by what stands in each one */
  regions?: MapRegion[];
  /** a click inside a region that holds sites */
  onRegion?: (r: MapRegion) => void;
}

/** Status colours for DOM and SVG: the Delivery Chain tokens (Strato status fills). */
export const MAP_COLORS: Record<Verdict, string> = { Critical: "var(--lm-bad-fill)", Warning: "var(--lm-warn-fill)", Healthy: "var(--lm-good-fill)", "Not monitored": "var(--lm-neutral)" };

interface Palette { status: Record<Verdict, string>; route: string; land: string; landDot: number; bg: string; ink: string; ink2: string; halo: string; glow: number; dim: number; calm: number; stroke: number; mark: number; siteDim: number }

/** Any CSS colour with an alpha, via the canvas' own colour normalisation. */
const alphaCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

/**
 * Canvas cannot read CSS variables, so the stage tokens are resolved per theme. A value the canvas does
 * not understand is ignored by it silently, and the next stroke then reuses the previous colour: a label
 * halo drew itself white over the site names that way. Every colour is checked and falls back when invalid.
 */
function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const valid = (c: string) => { if (!alphaCtx || !c) return !!c; alphaCtx.fillStyle = "#010203"; alphaCtx.fillStyle = c; return String(alphaCtx.fillStyle) !== "#010203" || c.toLowerCase() === "#010203"; };
  const v = (name: string, fallback: string) => { const c = cs.getPropertyValue(name).trim(); return /^[\d.]+$/.test(c) || valid(c) ? c || fallback : fallback; };
  return {
    status: { Critical: v("--lm-bad-fill", "#c82d40"), Warning: v("--lm-warn-fill", "#d7b43b"), Healthy: v("--lm-good-fill", "#00bb7b"), "Not monitored": v("--lm-neutral", "#7c7f9e") },
    route: v("--lm-route", v("--lm-cyan", "#06b6d4")), land: v("--lm-land", "rgba(173, 176, 255, 0.4)"), bg: v("--lm-bg", "#05080f"),
    ink: v("--lm-ink", "#e2e8f0"), ink2: v("--lm-ink-3", "#b8bfcc"),
    // the halo behind a label and the strength of the hotspot glow differ per theme: a glow that reads
    // on a dark stage turns into a stain on a white one
    halo: v("--lm-halo", v("--lm-bg", "#05080f")), glow: Number(v("--lm-glow", "0.2")) || 0.2,
    // how heavy the dotted continents are drawn: a light stage needs a bigger dot to read as land
    landDot: Number(v("--lm-land-dot", "1")) || 1,
    // How much of the drawing survives when it is not the focus. On a dark stage a route at 4% alpha still
    // glows; on a light one it disappears, so both fades and the stroke width come from the theme.
    dim: Number(v("--lm-dim", "0.22")) || 0.22,
    // how big the site and data-centre marks are drawn, so they stand out from the dotted grid
    mark: Number(v("--lm-mark", "1")) || 1,
    // a site mark is the data itself: it fades far less than a route when it is not in focus
    siteDim: Number(v("--lm-site-dim", "0.75")) || 0.75,
    calm: Number(v("--lm-calm", "0.2")) || 0.2,
    stroke: Number(v("--lm-stroke", "1")) || 1,
  };
}
function withAlpha(color: string, a: number) {
  if (!alphaCtx) return color;
  alphaCtx.fillStyle = "#000"; alphaCtx.fillStyle = color;
  const c = String(alphaCtx.fillStyle);
  if (c.startsWith("#")) return `rgba(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)}, ${a})`;
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const [r, g, b, a0 = "1"] = m[1].split(",").map((x) => x.trim());
  return `rgba(${r}, ${g}, ${b}, ${Number(a0) * a})`;
}

const land = (() => {
  const bin = atob(LAND_BITS);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (row: number, col: number) => {
    const i = row * LAND_COLS + col;
    return (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  };
})();

/** Ray casting over a flat ring of lon/lat pairs. */
function pointInRing(ring: Float64Array, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Web Mercator in degree units: x = longitude, y grows southwards.
const projY = (lat: number) => -Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)) * (180 / Math.PI);
const invY = (y: number) => ((2 * Math.atan(Math.exp((-y * Math.PI) / 180)) - Math.PI / 2) * 180) / Math.PI;

interface View { cx: number; cy: number; k: number }

/**
 * Above this many sites the map groups the sites that fall close together on screen into one mark with
 * their count and a ring of their status shares, and the routes between groups become one route each:
 * 4,000 sites and their links to the data centers otherwise draw a hairball. What the selected cause is
 * about always stays a site of its own; zooming in (or clicking a group) opens the groups up.
 */
const CLUSTER_AT = 600;
/** zoomed in this far, sites are drawn one by one whatever their number */
const CLUSTER_MAX_K = 120;

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0) / 4294967295; };
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** How many names the map tries to place per frame. Past this the pruning below would be the cost. */
const LABEL_TRIES = 240;

export function LiveMap({ sites, links, focus, insets, onSite, schematic = false, regions, onRegion }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const landLayer = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const view = useRef<View>({ cx: -50, cy: projY(-15), k: 8 });
  const tween = useRef<{ from: View; to: View; start: number } | null>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const size = useRef({ w: 800, h: 600 });
  const dirty = useRef(true);
  /** the wheel zooms once the user clicks the map; leaving it at the default zoom releases the page scroll again */
  const armed = useRef(false);
  const [hover, setHover] = useState<{ site: MapSite; x: number; y: number; cluster?: Cluster; region?: MapRegion } | null>(null);
  const clusters = useRef<Cluster[]>([]);
  const hoverCode = useRef<string | null>(null);
  const reduce = prefersReducedMotion();
  const palette = useRef<Palette | null>(null);
  useEffect(() => {
    const refresh = () => { if (wrap.current) { palette.current = readPalette(wrap.current); landLayer.current = null; dirty.current = true; } };
    refresh();
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", refresh);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", refresh); };
  }, []);

  const byCode = useMemo(() => new Map(sites.map((s) => [s.code, s])), [sites]);
  // Full screen, with a fallback. The app runs inside the platform's frame, and a frame that was not
  // given permission cannot enter real full screen — so when the request is refused the map takes over
  // the app's own viewport instead, which always works. Escape leaves either one.
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    const el = wrap.current;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => undefined); setFull(false); return; }
    if (full) { setFull(false); return; }
    el?.requestFullscreen?.().then(() => setFull(true)).catch(() => setFull(true));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && full && !document.fullscreenElement) setFull(false); };
    const onChange = () => { if (!document.fullscreenElement) setFull((v) => (v && !document.fullscreenElement ? false : v)); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("fullscreenchange", onChange); };
  }, [full]);

  const props = useRef({ sites, links, focus, insets, byCode, schematic, regions });
  props.current = { sites, links, focus, insets, byCode, schematic, regions };
  useEffect(() => { dirty.current = true; }, [sites, links, focus, insets, schematic, regions]);

  const fitTo = useCallback((codes: Set<string> | null, animate: boolean, withHubs = true, tight = false) => {
    const { w, h } = size.current;
    const ins = props.current.insets;
    const pts = sites.filter((s) => !codes || codes.has(s.code) || (withHubs && s.dc && links.some((l) => (l.a === s.code && codes.has(l.b)) || (l.b === s.code && codes.has(l.a)))));
    if (!pts.length) return;
    const xs = pts.map((s) => s.lon), ys = pts.map((s) => projY(s.lat));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const fw = Math.max(120, w - ins.left - ins.right), fh = Math.max(120, h - ins.top - ins.bottom);
    // a group of sites opened from the map can sit within a fraction of a degree
    const spanX = Math.max(x1 - x0, tight ? 0.3 : 18), spanY = Math.max(y1 - y0, tight ? 0.2 : 10);
    const k = Math.max(1.2, Math.min(260, Math.min(fw / (spanX * 1.35), fh / (spanY * 1.35))));
    const to = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k };
    if (animate && !reduce) tween.current = { from: { ...view.current }, to, start: performance.now() };
    else { view.current = to; tween.current = null; }
    dirty.current = true;
  }, [sites, links, reduce]);

  // fly to the focus whenever it changes
  const focusKey = focus ? [...focus].sort().join(",") : "*";
  // the floating panels change the usable area (wide vs stacked layout): refit so the network stays in view;
  // also refit when the tab becomes visible again, since drawing pauses while it's hidden
  useEffect(() => { if (size.current.w) fitTo(props.current.focus, false); }, [insets.top, insets.right, insets.bottom, insets.left]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) { fitTo(props.current.focus, false); dirty.current = true; } };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fitTo]);
  const first = useRef(true);
  useEffect(() => { fitTo(focus, !first.current); first.current = false; }, [focusKey, fitTo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      size.current = { w: e.contentRect.width, h: e.contentRect.height };
      const c = canvas.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.round(e.contentRect.width * dpr);
        c.height = Math.round(e.contentRect.height * dpr);
      }
      fitTo(props.current.focus, false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitTo]);

  useEffect(() => {
    let raf = 0;
    const stageStyle = wrap.current ? getComputedStyle(wrap.current) : null;
    const font = stageStyle?.getPropertyValue("--lm-sans").trim() || "DynatraceFlow, Roboto, Helvetica, sans-serif";
    const mono = stageStyle?.getPropertyValue("--lm-mono").trim() || "'Roboto Mono', monospace";
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c || document.hidden) return;
      if (tween.current) {
        const t = Math.min(1, (now - tween.current.start) / 1100), e = ease(t), { from, to } = tween.current;
        const k = from.k * Math.pow(to.k / from.k, e);
        view.current = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, k };
        if (t >= 1) tween.current = null;
        dirty.current = true;
      }
      if (reduce && !dirty.current) return;
      dirty.current = false;

      const { sites: S, links: L, focus: F, insets: ins, byCode: B, regions: RG } = props.current;
      const P = palette.current ?? (wrap.current ? (palette.current = readPalette(wrap.current)) : null);
      if (!P) return;
      const COL = P.status;
      const { w, h } = size.current;
      const dpr = window.devicePixelRatio || 1;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const v = view.current;
      const ox = ins.left + (w - ins.left - ins.right) / 2, oy = ins.top + (h - ins.top - ins.bottom) / 2;
      const sx = (lon: number) => ox + (lon - v.cx) * v.k;
      const sy = (lat: number) => oy + (projY(lat) - v.cy) * v.k;

      const shown = (code: string): Verdict => B.get(code)?.verdict ?? "Not monitored";
      const inFocus = (code: string) => !F || F.has(code) || !!B.get(code)?.dc;

      // land dot matrix, cached per view
      const landKey = `${w}|${h}|${v.cx.toFixed(3)}|${v.cy.toFixed(3)}|${v.k.toFixed(3)}|${ox}|${oy}`;
      if (landLayer.current?.key !== landKey) {
        const lc = landLayer.current?.canvas ?? document.createElement("canvas");
        lc.width = Math.round(w * dpr); lc.height = Math.round(h * dpr);
        const lx = lc.getContext("2d")!;
        lx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lx.clearRect(0, 0, w, h);
        const spacing = LAND_STEP * v.k, stride = Math.max(1, Math.ceil(7 / spacing));
        const r = Math.max(0.7, Math.min(2.6, spacing * stride * 0.17 * P.landDot));
        const lonAt = (x: number) => v.cx + (x - ox) / v.k, latAt = (y: number) => invY(v.cy + (y - oy) / v.k);
        const c0 = Math.max(0, Math.floor((lonAt(0) + 180) / LAND_STEP)), c1 = Math.min(LAND_COLS - 1, Math.ceil((lonAt(w) + 180) / LAND_STEP));
        const r0 = Math.max(0, Math.floor((90 - latAt(0)) / LAND_STEP)), r1 = Math.min(LAND_ROWS - 1, Math.ceil((90 - latAt(h)) / LAND_STEP));
        lx.fillStyle = P.land;
        for (let row = r0 - (r0 % stride); row <= r1; row += stride) {
          const y = sy(90 - (row + 0.5) * LAND_STEP);
          for (let col = c0 - (c0 % stride); col <= c1; col += stride) {
            if (!land(row, col)) continue;
            const x = sx(-180 + (col + 0.5) * LAND_STEP);
            lx.beginPath(); lx.arc(x, y, r, 0, Math.PI * 2); lx.fill();
          }
        }
        landLayer.current = { key: landKey, canvas: lc };
      }
      // hotspot glow behind the affected sites of the focus
      if (F) {
        const hot = S.filter((s) => F.has(s.code));
        if (hot.length) {
          const gx = hot.reduce((a, s) => a + sx(s.lon), 0) / hot.length, gy = hot.reduce((a, s) => a + sy(s.lat), 0) / hot.length;
          const spread = Math.max(50, Math.min(180, Math.max(...hot.map((s) => Math.hypot(sx(s.lon) - gx, sy(s.lat) - gy))) + 50));
          const worstHot = hot.some((s) => s.verdict === "Critical") ? COL.Critical : COL.Warning;
          const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, spread);
          g.addColorStop(0, withAlpha(worstHot, P.glow)); g.addColorStop(1, withAlpha(worstHot, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, spread, 0, Math.PI * 2); ctx.fill();
        }
      }

      if (!props.current.schematic && !RG?.some((r) => r.rings.length)) ctx.drawImage(landLayer.current.canvas, 0, 0, w, h);

      // The state layer. Drawn in place of the dotted land, because two grounds under the same marks
      // read as noise: the fill carries the status of what stands in the region, the border its shape.
      if (RG?.length && RG.some((r) => r.rings.length)) {
        ctx.drawImage(landLayer.current.canvas, 0, 0, w, h);
        ctx.globalAlpha = 1;
        for (const rg of RG) {
          if (!rg.rings.length) continue;
          ctx.beginPath();
          for (const ring of rg.rings) {
            for (let i = 0; i < ring.length; i += 2) {
              const px = sx(ring[i]), py = sy(ring[i + 1]);
              if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
          }
          // A state is a container, not a thing with a status: washing it in the colour of its worst
          // site said "Rio de Janeiro is critical" when three of its hundred and ninety-seven were. The
          // shape is context — the dots on top carry the status, one per site, which is where it is true.
          ctx.fillStyle = withAlpha(P.ink, rg.sites ? 0.07 : 0.025);
          ctx.fill("evenodd");
          ctx.strokeStyle = withAlpha(P.ink, rg.sites ? 0.38 : 0.16);
          ctx.lineWidth = rg.sites ? 1.1 : 0.7;
          ctx.stroke();
          // ...and the outline carries the shares. Washing the shape in the colour of its worst site
          // said "Rio de Janeiro is critical" of three sites in a hundred and ninety-seven; drawing
          // three hundredths of its border red says the true thing instead, and leaves the inside of
          // the state as the context it is. Each ring is stroked once per status, as a single dash as
          // long as that status's share of the perimeter.
          if (rg.sites) {
            for (const ring of rg.rings) {
              let per = 0;
              for (let i = 2; i < ring.length; i += 2) per += Math.hypot(sx(ring[i]) - sx(ring[i - 2]), sy(ring[i + 1]) - sy(ring[i - 1]));
              if (per < 8) continue;
              ctx.beginPath();
              for (let i = 0; i < ring.length; i += 2) { const px = sx(ring[i]), py = sy(ring[i + 1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
              ctx.closePath();
              ctx.lineWidth = 2;
              let at = 0;
              for (const v of SHARE_ORDER) {
                const n = rg.counts[v] ?? 0;
                if (!n) continue;
                // a single alerting site in a large state is a sliver: it never falls below two pixels
                const len = Math.max(2, (n / rg.sites) * per);
                ctx.strokeStyle = COL[v];
                // the share that is fine is the quiet one: it is the default state of the world, and
                // drawn at the weight of an alert it turns every border into decoration. What the eye
                // should find on a green outline is the sliver that is not green.
                ctx.globalAlpha = v === "Critical" ? 0.95 : v === "Warning" ? 0.9 : v === "Healthy" ? 0.3 : 0.2;
                ctx.setLineDash([len, Math.max(1, per - len)]);
                ctx.lineDashOffset = -at;
                ctx.stroke();
                at += len;
              }
              ctx.setLineDash([]);
              ctx.globalAlpha = 1;
            }
          }
        }
      }

      // groups of sites that fall close together on screen (only in a large estate, and not when zoomed in far)
      let clusterOf = new Map<string, Cluster>();
      let groups: Cluster[] = [];
      if (S.length > CLUSTER_AT && v.k < CLUSTER_MAX_K) {
        const points = S.filter((s) => !s.dc && !(F && F.has(s.code) && ["Critical", "Warning"].includes(shown(s.code))))
          .map((s) => ({ code: s.code, x: sx(s.lon), y: sy(s.lat), verdict: shown(s.code) }));
        const out = clusterPoints(points, { focused: inFocus, dcs: S.filter((s) => s.dc).map((s) => ({ x: sx(s.lon), y: sy(s.lat) })) });
        groups = out.groups; clusterOf = out.of;
      }
      clusters.current = groups;
      const posOf = (code: string) => { const cl = clusterOf.get(code); if (cl) return { x: cl.x, y: cl.y, id: cl.id }; const s = B.get(code); return s ? { x: sx(s.lon), y: sy(s.lat), id: code } : null; };

      // routes: one per pair of ends, a group counting as one end; width, packet count and packet speed follow
      // the traffic volume (log scale across routes)
      const RANK: Record<Verdict, number> = { Critical: 3, Warning: 2, Healthy: 1, "Not monitored": 0 };
      const routes = new Map<string, { id: string; x0: number; y0: number; x1: number; y1: number; verdict: Verdict; focused: boolean; bps: number | null; bpsIn: number | null; bpsOut: number | null; n: number }>();
      L.forEach((l) => {
        const a = posOf(l.a), b = posOf(l.b);
        if (!a || !b || a.id === b.id) return;
        const verdict: Verdict = l.verdict;
        const focused = inFocus(l.a) && inFocus(l.b);
        const key = clusterOf.size ? `${a.id}|${b.id}` : l.id;
        const r = routes.get(key);
        if (!r) routes.set(key, { id: l.id, x0: a.x, y0: a.y, x1: b.x, y1: b.y, verdict, focused, bps: l.bps ?? null, bpsIn: l.bpsIn ?? null, bpsOut: l.bpsOut ?? null, n: 1 });
        else {
          r.n++; r.focused = r.focused || focused;
          if (RANK[verdict] > RANK[r.verdict]) r.verdict = verdict;
          if (l.bps != null) r.bps = (r.bps ?? 0) + l.bps;
          if (l.bpsIn != null) r.bpsIn = (r.bpsIn ?? 0) + l.bpsIn;
          if (l.bpsOut != null) r.bpsOut = (r.bpsOut ?? 0) + l.bpsOut;
        }
      });
      ctx.lineCap = "round";
      const vols = [...routes.values()].map((r) => r.bps ?? 0).filter((x) => x > 0);
      const vMin = vols.length ? Math.log10(Math.min(...vols)) : 0, vMax = vols.length ? Math.log10(Math.max(...vols)) : 1;
      const volume = (bps: number | null) => (bps == null ? null : bps <= 0 ? 0 : vMax > vMin ? 0.15 + 0.85 * ((Math.log10(bps) - vMin) / (vMax - vMin)) : 1);
      routes.forEach(({ id, x0, y0, x1, y1, verdict, focused, bps, bpsIn, bpsOut, n }) => {
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
        const cxp = (x0 + x1) / 2 - (dy / len) * len * 0.18, cyp = (y0 + y1) / 2 + (dx / len) * len * 0.18 - len * 0.08;
        const bad = verdict === "Critical" || verdict === "Warning";
        // Out of focus and nothing wrong with it are two reasons to be quiet, and multiplying them
        // punished a calm route twice: 0.22 × 0.2 is four per cent of a one-pixel line. The fade has a
        // floor now, so a route that is merely not the focus still draws.
        const level = verdict === "Critical" ? 0.85 : verdict === "Warning" ? 0.5 : P.calm;
        const alpha = (focused ? 1 : Math.max(P.dim, 0.6)) * level;
        ctx.strokeStyle = bad ? COL[verdict] : P.route;
        ctx.globalAlpha = alpha;
        const vol = volume(bps);
        // a route that stands for a group of links is as much wider as it carries
        ctx.lineWidth = (bad ? 1.5 : 1.1) * (vol == null ? 1 : 0.7 + vol * 1.6) * P.stroke * (n > 1 ? 1 + Math.min(2.2, Math.log2(n) * 0.35) : 1);
        ctx.setLineDash(verdict === "Critical" && !reduce ? [4, 4] : []);
        ctx.lineDashOffset = verdict === "Critical" ? -(now / 70) % 8 : 0;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cxp, cyp, x1, y1); ctx.stroke();
        // packets on the route: towards the data center and back, each stream as many, as fast and as big
        // as that direction carries. Without the interface counters there is one stream, on the volume.
        // Traffic flows on a route whether or not it is the one you asked about, and a line holding
        // still reads as a dead link. Every route carries its packets; the focus shows in how brightly
        // they are drawn (below), not in whether they move at all.
        if (!reduce && vol !== 0) {
          const phase = hash(id), vv = vol ?? 0.3;
          const split = bpsIn != null || bpsOut != null;
          const share = (v: number | null) => (split ? Math.max(0.12, Math.min(1, (v ?? 0) / Math.max(1, (bpsIn ?? 0) + (bpsOut ?? 0)))) : 1);
          const streams: { back: boolean; s: number }[] = split
            ? [{ back: false, s: share(bpsOut) }, { back: true, s: share(bpsIn) }]
            : [{ back: false, s: 1 }];
          streams.forEach(({ back, s: sh }, si) => {
            if (split && sh <= 0.12 && (back ? bpsIn : bpsOut) === 0) return;
            const count = Math.max(1, Math.round((1 + vv * 5) * sh));
            const period = 3400 - vv * 2400;
            // the two streams run on their own side of the curve, so they read as two directions
            const off = split ? (back ? 1 : -1) * (2.2 + vv * 1.6) : 0;
            for (let p = 0; p < count; p++) {
              const t0 = ((now / period) + phase + si * 0.37 + p / count) % 1;
              const t = back ? 1 - t0 : t0, u = 1 - t;
              const px = u * u * x0 + 2 * u * t * cxp + t * t * x1, py = u * u * y0 + 2 * u * t * cyp + t * t * y1;
              // the normal of the curve at t, to park the stream beside the line
              const dxdt = 2 * u * (cxp - x0) + 2 * t * (x1 - cxp), dydt = 2 * u * (cyp - y0) + 2 * t * (y1 - cyp);
              const len2 = Math.hypot(dxdt, dydt) || 1;
              ctx.globalAlpha = focused ? 0.95 : Math.max(0.45, P.dim);
              ctx.fillStyle = bad ? COL[verdict] : P.route;
              ctx.beginPath();
              ctx.arc(px + (-dydt / len2) * off, py + (dxdt / len2) * off, ((bad ? 1.5 : 1.1) + vv * 1.2) * (split ? 0.6 + sh * 0.6 : 1), 0, Math.PI * 2);
              ctx.fill();
            }
          });
        }
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // sites, healthy first so problems stay on top
      // groups: the count in the middle and a ring of status shares (critical, warning, healthy, other)
      groups.forEach((cl) => {
        if (cl.x < -40 || cl.y < -40 || cl.x > w + 40 || cl.y > h + 40) return;
        ctx.globalAlpha = cl.focused ? 1 : P.siteDim;
        if (cl.crit && cl.focused && !reduce) {
          const t = ((now / 1800) + hash(cl.id)) % 1;
          ctx.strokeStyle = COL.Critical; ctx.globalAlpha = 1 - t; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r + 2 + t * 14, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = withAlpha(P.halo, 0.92);
        ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r + 3, 0, Math.PI * 2); ctx.fill();
        let a0 = -Math.PI / 2;
        ([["Critical", cl.crit], ["Warning", cl.warn], ["Healthy", cl.healthy], ["Not monitored", cl.other]] as [Verdict, number][]).forEach(([vd, k]) => {
          if (!k) return;
          const a1 = a0 + (k / cl.n) * Math.PI * 2;
          ctx.strokeStyle = COL[vd]; ctx.lineWidth = 3.2;
          ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r, a0, a1); ctx.stroke();
          a0 = a1;
        });
        if (hoverCode.current === cl.id) { ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r + 5, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = P.ink; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `600 ${cl.n >= 100 ? 9.5 : 10.5}px ${mono}`;
        ctx.fillText(cl.n >= 1000 ? `${(cl.n / 1000).toFixed(1)}k` : String(cl.n), cl.x, cl.y + 0.5);
        ctx.textAlign = "start";
      });
      ctx.globalAlpha = 1;

      // drawn in this order, and named in it too: the data centres a reader looks for first, then what
      // is alerting, then the rest. When the map is busy it is the useful names that survive the pruning.
      const order = [...S].filter((s) => !clusterOf.has(s.code)).sort((p, q) => Number(shown(p.code) !== "Healthy") - Number(shown(q.code) !== "Healthy") || Number(!!p.dc) - Number(!!q.dc));
      const labelled: MapSite[] = [];
      order.forEach((s) => {
        const x = sx(s.lon), y = sy(s.lat);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
        const vd = shown(s.code), focused = inFocus(s.code), color = COL[vd];
        ctx.globalAlpha = focused ? 1 : P.siteDim;
        if (s.dc) {
          // a data centre is the anchor of the map: it gets a halo that clears the dotted grid around it,
          // a filled square in the stage colour and an edge thick enough to read at any zoom
          const half = 8 * P.mark;
          ctx.fillStyle = withAlpha(P.halo, 0.9);
          ctx.beginPath(); ctx.arc(x, y, half + 5, 0, Math.PI * 2); ctx.fill();
          // the edge and the inner dot carry the status, green included, like every other site mark
          ctx.fillStyle = P.halo; ctx.strokeStyle = color; ctx.lineWidth = 2.6;
          ctx.fillRect(x - half, y - half, half * 2, half * 2);
          ctx.strokeRect(x - half, y - half, half * 2, half * 2);
          // an inner dot carries the status even when the square is read as a shape
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(x, y, half * 0.34, 0, Math.PI * 2); ctx.fill();
          labelled.push(s);
          return;
        }
        const bad = vd === "Critical" || vd === "Warning";
        if (bad && focused && !reduce && vd === "Critical") {
          const t = ((now / 1800) + hash(s.code)) % 1;
          ctx.strokeStyle = color; ctx.globalAlpha = 1 - t; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, y, 3 + t * 12, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const r = (bad ? 3.4 : 2.4) * (F && F.has(s.code) ? 1.25 : 1) * P.mark;
        ctx.fillStyle = withAlpha(P.halo, 0.85);
        ctx.beginPath(); ctx.arc(x, y, r + 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        if (hoverCode.current === s.code) { ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke(); }
        // Every site on screen is offered a name. Which ones get one is decided below, by whether the
        // text fits without touching another — geometry, not a count. A map of sixteen sites used to
        // label only the data centres, because the rule was "twelve sites or fewer".
        if (labelled.length < LABEL_TRIES) labelled.push(s);
      });
      ctx.globalAlpha = 1;

      // Labels with a halo in the stage colour. Sites that sit on top of each other would stack their
      // names into an unreadable pile, so a label is skipped when its box overlaps one already drawn —
      // data centres first, because they are the ones a reader is looking for.
      ctx.textBaseline = "middle";
      const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
      // the regions are named first and hold their space: a state's name belongs to the whole shape,
      // and a site's name sitting on top of it would be the one that reads as the region
      // A region label summarises a group. Where the group is one site, the site's own name says more
      // than "SC · 1" does, and the region was taking the space first and leaving the name undrawn —
      // Gaspar only appeared once you had zoomed far enough for the two to come apart. A region with
      // one site waits until the sites have had their turn and takes what is left.
      const drawRegions = (list: MapRegion[]) => {
        ctx.textAlign = "center";
        for (const rg of [...list].sort((a, b) => b.sites - a.sites)) {
          if (!rg.sites) continue;
          const x = sx(rg.lon), y = sy(rg.lat);
          if (x < 0 || y < 0 || x > w || y > h) continue;
          const text = rg.bad ? `${rg.code || rg.name} · ${rg.sites} · ${rg.bad} alerting` : `${rg.code || rg.name} · ${rg.sites}`;
          ctx.font = `600 ${v.k > 6 ? 12 : 11}px ${mono}`;
          const tw = ctx.measureText(text).width;
          const box = { x0: x - tw / 2 - 6, y0: y - 9, x1: x + tw / 2 + 6, y1: y + 9 };
          if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) continue;
          taken.push(box);
          ctx.lineWidth = 3.5; ctx.strokeStyle = withAlpha(P.halo, 0.95);
          // the count is ink; only the words that report alerts wear the status colour
          ctx.fillStyle = rg.bad ? COL[rg.verdict] : P.ink;
          ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
        }
        ctx.textAlign = "start";
      };
      if (RG?.length) drawRegions(RG.filter((rg) => rg.sites > 1));
      [...labelled].sort((a, b) => Number(b.dc) - Number(a.dc)).forEach((s) => {
        const x = sx(s.lon), y = sy(s.lat);
        ctx.font = s.dc ? `600 12px ${font}` : `500 11px ${mono}`;
        // the name is what a reader is after; the code is the fallback for when the name will not fit
        const fits = (t: string) => {
          const tw = ctx.measureText(t).width;
          const b = { x0: x + 8 - 10, y0: y - (s.dc ? 7 : 6) - 3, x1: x + 12 + tw + 10, y1: y + (s.dc ? 7 : 6) + 3 };
          return !taken.some((t2) => b.x0 < t2.x1 && b.x1 > t2.x0 && b.y0 < t2.y1 && b.y1 > t2.y0);
        };
        const text = fits(s.name) ? s.name : s.code;
        const w = ctx.measureText(text).width, h = s.dc ? 14 : 12;
        const box = { x0: x + 8, y0: y - h / 2, x1: x + 12 + w, y1: y + h / 2 };
        // boxes that merely touch still read as one name — two neighbouring sites ran together into one
        // long string on screen — so a label needs clear space around it, not just no overlap
        const gap = { x0: box.x0 - 10, y0: box.y0 - 3, x1: box.x1 + 10, y1: box.y1 + 3 };
        if (taken.some((t) => gap.x0 < t.x1 && gap.x1 > t.x0 && gap.y0 < t.y1 && gap.y1 > t.y0)) return;
        taken.push(box);
        // every label uses the main ink: the subdued one is the same colour as the dotted continents,
        // so a site name written in it disappears into the map. Rank is carried by weight, not by colour.
        ctx.lineWidth = 3.5; ctx.strokeStyle = withAlpha(P.halo, 0.95); ctx.fillStyle = P.ink;
        ctx.strokeText(text, x + 10, y); ctx.fillText(text, x + 10, y);
      });
      if (RG?.length) drawRegions(RG.filter((rg) => rg.sites === 1));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  type Hit = { site: MapSite; x: number; y: number; cluster?: Cluster; region?: MapRegion };

  const siteAt = (clientX: number, clientY: number): Hit | null => {
    const c = canvas.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const { w, h } = size.current, v = view.current, ins = props.current.insets;
    const ox = ins.left + (w - ins.left - ins.right) / 2, oy = ins.top + (h - ins.top - ins.bottom) / 2;
    for (const cl of clusters.current) {
      if (Math.hypot(cl.x - px, cl.y - py) <= cl.r + 4) {
        const bits = [cl.crit ? `${cl.crit} critical` : null, cl.warn ? `${cl.warn} warning` : null, cl.healthy ? `${cl.healthy} healthy` : null].filter(Boolean).join(" · ");
        return { site: { code: cl.id, name: `${cl.n} sites`, lat: 0, lon: 0, verdict: worstOf(cl), cause: `${bits} · click to zoom in` }, x: px, y: py, cluster: cl };
      }
    }
    const grouped = new Set(clusters.current.flatMap((cl) => cl.codes));
    let best: MapSite | null = null, dist = 12;
    props.current.sites.forEach((s) => {
      if (grouped.has(s.code)) return;
      const d = Math.hypot(ox + (s.lon - v.cx) * v.k - px, oy + (projY(s.lat) - v.cy) * v.k - py);
      if (d < dist) { dist = d; best = s; }
    });
    if (best) return { site: best as MapSite, x: px, y: py };
    // no site under the pointer: the region it is over answers instead, so the shape is readable too
    const RG = props.current.regions;
    if (RG?.length) {
      const lon = v.cx + (px - ox) / v.k, lat = invY(v.cy + (py - oy) / v.k);
      for (const rg of RG) {
        if (!rg.rings.length || !rg.rings.some((ring) => pointInRing(ring, lon, lat))) continue;
        return {
          site: {
            code: `region:${rg.code}`, name: rg.name, lat: rg.lat, lon: rg.lon, verdict: rg.verdict,
            cause: rg.sites ? `${rg.sites} site${rg.sites === 1 ? "" : "s"} here · click to see them` : "no site here",
          },
          x: px, y: py, region: rg,
        };
      }
    }
    return null;
  };

  const zoomBy = (f: number, px?: number, py?: number) => {
    const { w, h } = size.current, v = view.current, ins = props.current.insets;
    const ox = ins.left + (w - ins.left - ins.right) / 2, oy = ins.top + (h - ins.top - ins.bottom) / 2;
    const x = px ?? ox, y = py ?? oy;
    const k = Math.max(1.2, Math.min(400, v.k * f));
    const lon = v.cx + (x - ox) / v.k, yy = v.cy + (y - oy) / v.k;
    view.current = { cx: lon - (x - ox) / k, cy: yy - (y - oy) / k, k };
    tween.current = null;
    dirty.current = true;
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!armed.current && !e.ctrlKey && !e.metaKey) return; // let the page scroll until the map is engaged
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={wrap} className={`lm-map${full ? " is-full" : ""}`}>
      <canvas ref={canvas} className="lm-canvas" role="img"
        aria-label={`Map of ${sites.length} sites${focus ? `, ${focus.size} in focus` : ""}. Click the map, then drag to pan and scroll to zoom.`}
        style={{ cursor: hover ? "pointer" : drag.current ? "grabbing" : "grab" }}
        onPointerDown={(e) => { armed.current = true; drag.current = { x: e.clientX, y: e.clientY, view: { ...view.current }, moved: false }; (e.target as Element).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            if (d.moved) { view.current = { ...d.view, cx: d.view.cx - dx / d.view.k, cy: d.view.cy - dy / d.view.k }; tween.current = null; dirty.current = true; }
            return;
          }
          const hit = siteAt(e.clientX, e.clientY);
          if ((hit?.site.code ?? null) !== hoverCode.current) { hoverCode.current = hit?.site.code ?? null; dirty.current = true; }
          setHover(hit);
        }}
        onPointerLeave={() => { hoverCode.current = null; dirty.current = true; setHover(null); if (view.current.k <= 1.01) armed.current = false; }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const hit = siteAt(e.clientX, e.clientY);
            // a group opens up: fly to its sites (not their data centers) until they stand apart
            if (hit?.cluster) fitTo(new Set(hit.cluster.codes), true, false, true);
            else if (hit?.region) { if (hit.region.sites) onRegion?.(hit.region); }
            else if (hit) onSite(hit.site.code);
          }
        }} />
      {hover && (() => {
        // The tip used to sit on the pointer's own line, sixteen pixels to its right, which is exactly
        // where the thing it describes writes its label: hovering a region covered the region's name.
        // It goes below and to the right now, and flips at the edges so it never leaves the map.
        const { w, h } = size.current;
        const x = hover.x > w - 300 ? "calc(-100% - 16px)" : "16px";
        const y = hover.y > h - 96 ? "calc(-100% - 14px)" : "14px";
        return (
        <div className="lm-tip" style={{ left: hover.x, top: hover.y, transform: `translate(${x}, ${y})` }}>
          <b><i style={{ background: MAP_COLORS[hover.site.verdict] }} />{hover.site.name}</b>
          {!hover.cluster && <span>{[hover.site.code, hover.site.region, hover.site.dc ? "Data center" : null].filter(Boolean).join(" · ")}</span>}
          {hover.site.cause && <span className="lm-tip__cause">{hover.site.cause}</span>}
        </div>
        );
      })()}
      <div className="lm-zoom" style={{ right: insets.right + 12, bottom: insets.bottom + 12 }}>
        <button type="button" onClick={() => zoomBy(1.4)} aria-label="Zoom in"><PlusIcon /></button>
        <button type="button" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out"><MinusIcon /></button>
        <button type="button" onClick={() => fitTo(focus, true)} aria-label="Fit to focus"><ZoomToFitIcon /></button>
        <button type="button" onClick={toggleFull} aria-pressed={full} title={full ? "Leave full screen (Esc)" : "Full screen"}
          aria-label={full ? "Leave full screen" : "Show the map full screen"}>{full ? <MinimizeIcon /> : <MaximizeIcon />}</button>
      </div>
    </div>
  );
}
