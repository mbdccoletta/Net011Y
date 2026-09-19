// Devices by role as bubbles you can zoom into: click a bubble to fly into it, scroll to zoom,
// drag to pan, Esc or "All roles" to go back. Zoomed in, problem devices get their names.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Device } from "../model/types";
import { ROLE_LABEL } from "../model/site";
import { isBad } from "../model/verdict";
import { fmtInt, prefersReducedMotion } from "../utils/format";
import { verdictTone } from "./Visual";
import { ArrowLeftIcon, MinusIcon, PlusIcon } from "@dynatrace/strato-icons";

export interface BubbleGroup { role: string; devices: Device[]; r: number; cx: number; cy: number }

interface Props {
  groups: BubbleGroup[];
  width: number;
  height: number;
  visible: (d: Device) => boolean;
  selected: string | null;
  onPick: (name: string) => void;
}

interface View { x: number; y: number; k: number }
const HOME: View = { x: 0, y: 0, k: 1 };
const shortDevice = (name: string) => name.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "");
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
/**
 * Above this many devices in a bubble, the quiet dots (healthy, not selected) are drawn as one path per
 * colour instead of one element each: 20,000 devices stay a few hundred elements, the zoom stays smooth,
 * and a click still opens the dot under the pointer.
 */
const BATCH_AT = 300;

interface Dot { d: Device; x: number; y: number; r: number; problem: boolean }
/** Dot positions on the sunflower spiral, computed once per layout rather than on every frame. */
function placeDots(g: BubbleGroup): { dots: Dot[]; few: boolean; dotR: number } {
  const nDots = g.devices.length;
  // few devices: bigger dots that fill the bubble; many: small dots in a dense sunflower
  const few = nDots <= 12;
  const dotR = few ? Math.max(3, Math.min(11, ((g.r - 10) / Math.sqrt(nDots)) * 0.55)) : Math.max(1.3, Math.min(4.2, ((g.r - 8) / Math.sqrt(nDots)) * 0.75));
  const spread = few ? g.r - 8 - dotR : g.r - 7;
  const dots = g.devices.map((d, i) => {
    const idx = nDots - 1 - i;
    const a = idx * 2.39996 + (few ? -Math.PI / 2 : 0), rad = nDots === 1 ? 0 : Math.sqrt((idx + 0.5) / nDots) * spread;
    const problem = isBad(d.verdict);
    return { d, x: g.cx + Math.cos(a) * rad, y: g.cy + Math.sin(a) * rad, r: problem ? dotR * 1.12 : dotR, problem };
  });
  return { dots, few, dotR };
}
/** Many circles as one path: each dot is two arcs. */
const dotsPath = (dots: Dot[]) => dots.map(({ x, y, r }) => `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0`).join("");

export function DeviceBubbles({ groups, width: W, height: H, visible, selected, onPick }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>(HOME);
  const [focus, setFocus] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ px: number; py: number; view: View; moved: boolean } | null>(null);
  const anim = useRef<number | null>(null);
  // the wheel zooms once the user engages the chart (a click inside, or an existing zoom); otherwise the page scrolls
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  armedRef.current = armed || viewRef.current.k > 1.01;

  // The view is animated through the world point at the centre of the canvas, so zooming keeps
  // what is in the middle in the middle; buttons build on the destination, not the frame in flight.
  const target = useRef<View>(HOME);
  const centreOf = (v: View) => ({ cx: (W / 2 - v.x) / v.k, cy: (H / 2 - v.y) / v.k });
  const fromCentre = (cx: number, cy: number, k: number): View => ({ k, x: W / 2 - cx * k, y: H / 2 - cy * k });
  const animateTo = useCallback((to: View) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    target.current = to;
    if (prefersReducedMotion()) { setView(to); return; }
    const from = viewRef.current, a = centreOf(from), b = centreOf(to), start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 650), e = ease(t);
      setView(fromCentre(a.cx + (b.cx - a.cx) * e, a.cy + (b.cy - a.cy) * e, from.k * Math.pow(to.k / from.k, e)));
      if (t < 1) anim.current = requestAnimationFrame(step); else anim.current = null;
    };
    anim.current = requestAnimationFrame(step);
  }, [W, H]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomBy = (f: number) => {
    const base = anim.current ? target.current : viewRef.current, c = centreOf(base);
    const nk = Math.max(1, Math.min(20, base.k * f));
    if (nk === 1) { setFocus(null); animateTo(HOME); } else animateTo(fromCentre(c.cx, c.cy, nk));
  };

  const zoomInto = (g: BubbleGroup) => {
    const k = Math.min(W / (g.r * 2 + 30), H / (g.r * 2 + 56), 12);
    setFocus(g.role);
    animateTo(fromCentre(g.cx, g.cy + 10, k));
  };
  const reset = () => { setFocus(null); setArmed(false); animateTo(HOME); };

  const toSvg = (clientX: number, clientY: number) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  // the zoom animation must stop when the chart leaves the screen, or its frames keep running
  // against a component that is no longer there
  useEffect(() => () => { if (anim.current) { cancelAnimationFrame(anim.current); anim.current = null; } }, []);

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!armedRef.current && !e.ctrlKey && !e.metaKey) return; // let the page scroll until the chart is engaged
      e.preventDefault();
      if (anim.current) { cancelAnimationFrame(anim.current); anim.current = null; }
      const p = toSvg(e.clientX, e.clientY), v = viewRef.current;
      const k = Math.max(1, Math.min(20, v.k * Math.exp(-e.deltaY * 0.0018)));
      const wx = (p.x - v.x) / v.k, wy = (p.y - v.y) / v.k;
      setView(k === 1 ? HOME : { k, x: p.x - wx * k, y: p.y - wy * k });
      if (k === 1) setFocus(null);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && viewRef.current.k > 1) reset(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const k = view.k;
  const focusGroup = groups.find((g) => g.role === focus);
  const placed = useMemo(() => new Map(groups.map((g) => [g.role, placeDots(g)])), [groups]);
  // the quiet dots of the large bubbles, batched by colour and visibility; rebuilt only when the data,
  // the filters or the selection change, never while zooming
  const batches = useMemo(() => new Map(groups.map((g) => {
    const pl = placed.get(g.role)!;
    if (pl.dots.length <= BATCH_AT) return [g.role, null] as const;
    const byKey = new Map<string, Dot[]>();
    pl.dots.forEach((dot) => {
      if (dot.problem || dot.d.name === selected) return;
      const key = `${dot.d.verdict}|${visible(dot.d) ? 1 : 0}`;
      const l = byKey.get(key); if (l) l.push(dot); else byKey.set(key, [dot]);
    });
    return [g.role, [...byKey.entries()].map(([key, dots]) => ({ key, verdict: key.split("|")[0] as Device["verdict"], on: key.endsWith("|1"), dots, d: dotsPath(dots) }))] as const;
  })), [groups, placed, visible, selected]);
  // a click on a batched path opens the dot nearest the pointer
  const pickNearest = (dots: Dot[], e: React.MouseEvent) => {
    const w = toSvg(e.clientX, e.clientY), v = viewRef.current;
    const x = (w.x - v.x) / v.k, y = (w.y - v.y) / v.k;
    let best: Dot | null = null, bd = Infinity;
    dots.forEach((dot) => { const dd = (dot.x - x) ** 2 + (dot.y - y) ** 2; if (dd < bd) { bd = dd; best = dot; } });
    if (best && !drag.current?.moved) onPick((best as Dot).d.name);
  };

  return (
    <div className="vz-zoom">
      <div className="vz-zoom__bar">
        {k > 1.01 ? (
          <button type="button" className="lm-btn" onClick={reset}><ArrowLeftIcon /> All roles</button>
        ) : <span className="vz-cap">Click a bubble to zoom in · click the chart, then scroll to zoom · drag to pan</span>}
        {focusGroup && k > 1.01 && (
          <span className="vz-cap">{(ROLE_LABEL[focusGroup.role] ?? focusGroup.role).toUpperCase()} · {fmtInt(focusGroup.devices.length)} devices · {focusGroup.devices.filter((d) => isBad(d.verdict)).length} with issues</span>
        )}
        <span className="vz-zoom__btns">
          <button type="button" className="lm-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}><MinusIcon /></button>
          <button type="button" className="lm-btn" aria-label="Zoom in" onClick={() => zoomBy(1.6)}><PlusIcon /></button>
        </span>
      </div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className={`vz-bubbles${drag.current?.moved ? " is-dragging" : ""}`} role="group" aria-label="Devices grouped by role, zoomable"
        onPointerDown={(e) => { setArmed(true); drag.current = { px: e.clientX, py: e.clientY, view: viewRef.current, moved: false }; }}
        onPointerLeave={() => { if (viewRef.current.k <= 1.01) setArmed(false); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || viewRef.current.k <= 1) return;
          const a = toSvg(d.px, d.py), b = toSvg(e.clientX, e.clientY);
          if (!d.moved && Math.hypot(b.x - a.x, b.y - a.y) < 4) return;
          d.moved = true;
          if (anim.current) cancelAnimationFrame(anim.current);
          setView({ ...d.view, x: d.view.x + (b.x - a.x), y: d.view.y + (b.y - a.y) });
        }}
        onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }}>
        <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
          {groups.map((g) => {
            const nDots = g.devices.length;
            const { dots, few } = placed.get(g.role)!;
            const batch = batches.get(g.role);
            const bad = g.devices.filter((d) => isBad(d.verdict)).length;
            const dim = focus && focus !== g.role && k > 1.5;
            // status ring: share of critical, warning, healthy and not monitored devices around the bubble
            const shares = (["Critical", "Warning", "Healthy", "Not monitored"] as const).map((v) => ({ v, n: g.devices.filter((d) => d.verdict === v).length })).filter((x) => x.n);
            const gap = shares.length > 1 ? 1.2 : 0;
            let acc = 0;
            return (
              <g key={g.role} opacity={dim ? 0.25 : 1}>
                <circle cx={g.cx} cy={g.cy} r={g.r} className="vz-bubble" fill="transparent" stroke="color-mix(in srgb, var(--lm-ink-hi) 18%, transparent)"
                  strokeWidth={1 / Math.sqrt(k)} role="button" tabIndex={0} aria-label={`Zoom into ${ROLE_LABEL[g.role] ?? g.role}, ${nDots} devices, ${bad} with issues`}
                  onClick={() => { if (!drag.current?.moved && focus !== g.role) zoomInto(g); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoomInto(g); } }} />
                {shares.map(({ v, n }) => {
                  const len = (n / nDots) * 100;
                  const seg = (
                    <circle key={v} cx={g.cx} cy={g.cy} r={g.r + 5 / Math.sqrt(k)} fill="none" pathLength={100} pointerEvents="none"
                      stroke={verdictTone(v)} strokeWidth={3 / Math.sqrt(k)} strokeLinecap="butt"
                      strokeDasharray={`${Math.max(0.4, len - gap)} ${100 - Math.max(0.4, len - gap)}`} strokeDashoffset={-acc}
                      transform={`rotate(-90 ${g.cx} ${g.cy})`} />
                  );
                  acc += len;
                  return seg;
                })}
                <text x={g.cx} y={g.cy + g.r + 18 / Math.sqrt(k)} textAnchor="middle" className="vz-svg-label" style={{ fontSize: 14 / Math.sqrt(k) }}>{(ROLE_LABEL[g.role] ?? g.role).toUpperCase()}</text>
                <text x={g.cx} y={g.cy + g.r + 34 / Math.sqrt(k)} textAnchor="middle" className="vz-svg-cap" style={{ fontSize: 12 / Math.sqrt(k) }}>{fmtInt(nDots)}{bad ? ` · ${bad} with issues` : ""}</text>
                {batch?.map((b) => (
                  <path key={b.key} d={b.d} fill={verdictTone(b.verdict)} opacity={b.on ? 0.72 : 0.1} className="vz-dot"
                    onClick={(e) => { e.stopPropagation(); if (b.on) pickNearest(b.dots, e); }}>
                    <title>{`${fmtInt(b.dots.length)} ${(ROLE_LABEL[g.role] ?? g.role).toLowerCase()} devices · ${b.verdict} · click a dot to open it`}</title>
                  </path>
                ))}
                {dots.filter((dot) => !batch || dot.problem || dot.d.name === selected).map(({ d, x, y, r, problem }) => {
                  const on = visible(d), sel = selected === d.name;
                  const detailed = r * k >= 7;
                  return (
                    <g key={d.name}>
                      {problem && on && few && (
                        <circle cx={x} cy={y} r={r + 4} fill="none" stroke={verdictTone(d.verdict)} strokeWidth={1.5 / k} pointerEvents="none"
                          className={d.verdict === "Critical" ? "vz-dot-halo vz-dot-halo--pulse" : "vz-dot-halo"} />
                      )}
                      <circle cx={x} cy={y} r={r}
                        fill={verdictTone(d.verdict)} opacity={on ? (problem ? 1 : 0.72) : 0.1} stroke={sel ? "var(--lm-ink-hi)" : "none"} strokeWidth={sel ? 2 / k : 0}
                        className="vz-dot" onClick={(e) => { e.stopPropagation(); if (on && !drag.current?.moved) onPick(d.name); }}>
                        <title>{`${d.name} · ${d.verdict}${d.reasons[0] ? ` · ${d.reasons[0].text}` : ""}`}</title>
                      </circle>
                      {on && (sel || (detailed && problem && focus === g.role)) && k > 1.01 && (
                        <text x={x + r + 2 / k} y={y + 3 / k} className="vz-dot-label" style={{ fontSize: 12 / k, strokeWidth: 3 / k }}>{`${d.site} · ${shortDevice(d.name)}`}</text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
