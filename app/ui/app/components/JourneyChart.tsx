// The traffic journey drawn as a flow diagram: sources on the left, the device that saw the traffic in
// the middle, the application or the Internet on the right. Band width is bytes on one scale for the
// whole chart.
import React, { useMemo } from "react";
import type { JourneyLink, JourneyNode } from "../model/types";
import { fmtBytes, fmtInt } from "../utils/format";

export type JourneyPick = { kind: "node"; id: string } | { kind: "link"; from: string; to: string } | null;

/**
 * Traffic is one colour and only its weight changes, so a band never turns into another colour halfway
 * along; what a box is stays on its stripe; and green, amber and red are left to status, where a box
 * outlined in the status colour means that device is alerting now.
 */
const TONE: Record<JourneyNode["kind"], string> = {
  site: "var(--lm-accent)", internet: "var(--lm-cyan)", private: "var(--lm-neutral)",
  device: "var(--lm-ink)", app: "var(--lm-violet)",
};
export const JOURNEY_LEGEND: { kind: JourneyNode["kind"]; label: string }[] = [
  { kind: "site", label: "Site" }, { kind: "internet", label: "Internet" }, { kind: "private", label: "Private, no site" },
  { kind: "device", label: "Device that saw it" }, { kind: "app", label: "Application" },
];

const BOX_MIN = 36, GAP = 12, PAD_Y = 8;

interface Placed extends JourneyNode { x: number; y: number; h: number; inY: number; outY: number }

export function JourneyChart({ nodes, links, width, pick, onPick, alerting }: {
  nodes: JourneyNode[]; links: JourneyLink[]; width: number; pick: JourneyPick; onPick: (p: JourneyPick) => void;
  /** node ids whose device has an open alert, outlined in the status colour */
  alerting?: Map<string, string>;
}) {
  const W = Math.max(640, width);
  const boxW = Math.min(190, Math.round(W * 0.22));
  const colX = [0, Math.round((W - boxW) / 2), W - boxW];
  const layout = useMemo(() => {
    const cols = [0, 1, 2].map((c) => nodes.filter((n) => n.col === c).sort((a, b) => b.bytes - a.bytes));
    const tallest = Math.max(...cols.map((c) => c.length));
    // a small journey stays small: a drawing of four boxes does not need a screen
    const H = Math.max(150, tallest * (BOX_MIN + GAP) + 40);
    // one scale for every band: the busiest column fills the height left once the gaps are paid
    const maxBytes = Math.max(1, ...cols.map((c) => c.reduce((a, n) => a + n.bytes, 0)));
    const k = (H - PAD_Y * 2 - GAP * (tallest - 1) - tallest * 4) / maxBytes;
    const placed = new Map<string, Placed>();
    // a box never shrinks below its label, so the drawing grows to what the tallest column needs
    const heightsOf = (col: JourneyNode[]) => col.map((n) => Math.max(BOX_MIN, n.bytes * k));
    const needed = Math.max(...cols.map((col) => heightsOf(col).reduce((a, h) => a + h, 0) + GAP * (col.length - 1))) + PAD_Y * 2;
    const height = Math.max(H, needed);
    cols.forEach((col, c) => {
      const heights = heightsOf(col);
      const total = heights.reduce((a, h) => a + h, 0) + GAP * (col.length - 1);
      let y = Math.max(PAD_Y, (height - total) / 2);
      col.forEach((n, i) => { placed.set(n.id, { ...n, x: colX[c], y, h: heights[i], inY: 0, outY: 0 }); y += heights[i] + GAP; });
    });
    // each box stacks its outgoing bands in the order of their targets and its incoming bands in the
    // order of their sources, centred in the box: bands cross only where the traffic really crosses
    const yOf = (id: string) => placed.get(id)?.y ?? 0;
    const offsets = new Map<JourneyLink, { y0: number; y1: number }>();
    const stack = (end: "from" | "to") => {
      const groups = new Map<string, JourneyLink[]>();
      links.forEach((l) => groups.set(l[end], [...(groups.get(l[end]) ?? []), l]));
      groups.forEach((ls, id) => {
        const box = placed.get(id)!;
        ls.sort((a, b) => yOf(end === "from" ? a.to : a.from) - yOf(end === "from" ? b.to : b.from));
        let y = box.y + (box.h - ls.reduce((a, l) => a + l.bytes * k, 0)) / 2;
        ls.forEach((l) => { const o = offsets.get(l) ?? { y0: 0, y1: 0 }; o[end === "from" ? "y0" : "y1"] = y; offsets.set(l, o); y += l.bytes * k; });
      });
    };
    stack("from"); stack("to");
    const bands = links.map((l) => ({ l, a: placed.get(l.from)!, b: placed.get(l.to)!, w: l.bytes * k, ...offsets.get(l)! }));
    return { H: height, placed, bands };
  }, [nodes, links, W, boxW]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalBytes = Math.max(1, nodes.filter((n) => n.col === 1).reduce((a, n) => a + n.bytes, 0));
  const share = (b: number) => `${b / totalBytes >= 0.1 ? Math.round((100 * b) / totalBytes) : ((100 * b) / totalBytes).toFixed(1)}%`;

  const isPicked = (from: string, to: string) => !!pick && (pick.kind === "link" ? pick.from === from && pick.to === to : pick.id === from || pick.id === to);
  const dim = !!pick;
  const band = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    const mx = (x0 + x1) / 2;
    return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + w} C${mx},${y1 + w} ${mx},${y0 + w} ${x0},${y0 + w} Z`;
  };

  return (
    <svg className="jr" width={W} height={layout.H} viewBox={`0 0 ${W} ${layout.H}`} role="img" aria-label="Traffic journey: where the last hour of traffic came from, which device saw it and where it went">
      {layout.bands.map(({ l, a, b, w, y0, y1 }) => {
        const tone = "var(--lm-cyan)";
        const on = isPicked(l.from, l.to);
        const title = `${a.label} → ${b.label}: ${fmtBytes(l.bytes)} · ${fmtInt(l.count)} flows`;
        const select = () => onPick(on && pick?.kind === "link" ? null : { kind: "link", from: l.from, to: l.to });
        return (
          <path key={`${l.from}>${l.to}`} className="jr-band" d={band(a.x + boxW, y0, b.x, y1, Math.max(1, w))} fill={tone}
            opacity={on ? 0.75 : dim ? 0.12 : 0.22 + 0.45 * Math.min(1, l.bytes / totalBytes)} onClick={select}>
            <title>{title}</title>
          </path>
        );
      })}
      {[...layout.placed.values()].map((n) => {
        const on = pick?.kind === "node" && pick.id === n.id;
        return (
          <g key={n.id} className={`jr-node${on ? " is-on" : ""}`} transform={`translate(${n.x},${n.y})`} onClick={() => onPick(on ? null : { kind: "node", id: n.id })}
            role="button" tabIndex={0} aria-label={`${n.label}${n.sub ? `, ${n.sub}` : ""}, ${fmtBytes(n.bytes)}`}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(on ? null : { kind: "node", id: n.id }); } }}>
            <rect width={boxW} height={n.h} rx={4} style={{ ["--t" as string]: TONE[n.kind] }} />
            <rect width={3} height={n.h} rx={1} fill={TONE[n.kind]} />
            {alerting?.get(n.id) && (
              <rect width={boxW} height={n.h} rx={4} fill="none" stroke={alerting.get(n.id)} strokeWidth={1.6}>
                <title>{`${n.label} is alerting`}</title>
              </rect>
            )}
            <text x={10} y={16} className="jr-label">{clip(n.label, boxW)}</text>
            <text x={10} y={30} className="jr-sub">{clip(`${fmtBytes(n.bytes)} · ${share(n.bytes)}${n.sub ? ` · ${n.sub}` : ""}`, boxW)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** SVG text does not wrap: cut to what the box holds (about 7 px per character at 12 px). */
function clip(s: string, boxW: number) {
  const max = Math.floor((boxW - 16) / 7);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
