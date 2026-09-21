// Grouping the sites of a large estate on the map: sites that fall within a cell of each other become one
// mark with their count and their status shares, groups whose circles touch join, and a group that would
// sit on a data center moves aside. Kept out of the canvas so it can be checked without a browser.
import type { Verdict } from "./types";

export interface ClusterPoint { code: string; x: number; y: number; verdict: Verdict }
export interface Cluster {
  id: string; x: number; y: number; r: number;
  codes: string[]; n: number;
  crit: number; warn: number; healthy: number; other: number;
  focused: boolean;
}

export const CELL = 38;
const radiusOf = (n: number) => 7 + Math.min(13, Math.log2(n) * 2.4);
export const worstOf = (c: Cluster): Verdict => (c.crit ? "Critical" : c.warn ? "Warning" : c.healthy ? "Healthy" : "Not monitored");

/**
 * @param points the sites to group, already projected to screen pixels
 * @param focused whether that site is in the focus (a group in focus is drawn bright)
 * @param dcs data center positions to keep clear
 */
export function clusterPoints(
  points: ClusterPoint[],
  { focused = () => true, dcs = [], cell = CELL }: { focused?: (code: string) => boolean; dcs?: { x: number; y: number }[]; cell?: number } = {},
): { groups: Cluster[]; of: Map<string, Cluster> } {
  const of = new Map<string, Cluster>();
  const cells = new Map<string, ClusterPoint[]>();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)}|${Math.floor(p.y / cell)}`;
    const l = cells.get(key); if (l) l.push(p); else cells.set(key, [p]);
  }
  const groups: Cluster[] = [];
  cells.forEach((list, key) => {
    if (list.length < 2) return;
    const cl: Cluster = { id: `cluster:${key}`, x: 0, y: 0, r: 0, codes: [], n: list.length, crit: 0, warn: 0, healthy: 0, other: 0, focused: false };
    list.forEach((p) => {
      cl.x += p.x; cl.y += p.y; cl.codes.push(p.code);
      if (p.verdict === "Critical") cl.crit++; else if (p.verdict === "Warning") cl.warn++; else if (p.verdict === "Healthy") cl.healthy++; else cl.other++;
      if (focused(p.code)) cl.focused = true;
      of.set(p.code, cl);
    });
    cl.x /= list.length; cl.y /= list.length; cl.r = radiusOf(list.length);
    groups.push(cl);
  });

  // groups from neighbouring cells can overlap: the larger one takes in any group its circle touches
  const merge = () => {
    groups.sort((p, q) => q.n - p.n);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      for (let j = i + 1; j < groups.length; j++) {
        const o = groups[j];
        if (Math.hypot(g.x - o.x, g.y - o.y) > g.r + o.r + 3) continue;
        const n = g.n + o.n;
        g.x = (g.x * g.n + o.x * o.n) / n; g.y = (g.y * g.n + o.y * o.n) / n;
        g.n = n; g.crit += o.crit; g.warn += o.warn; g.healthy += o.healthy; g.other += o.other; g.focused = g.focused || o.focused;
        g.codes.push(...o.codes); o.codes.forEach((c) => of.set(c, g));
        g.r = radiusOf(n);
        groups.splice(j, 1); j = i; // the grown circle may now touch groups already passed
      }
    }
  };
  // a data center is the anchor of the map: a group that would sit on it moves aside, along the line from
  // the data center (a group's position is only the average of its sites anyway)
  const clearDcs = () => groups.forEach((g) => dcs.forEach((d) => {
    const dx = g.x - d.x, dy = g.y - d.y, dist = Math.hypot(dx, dy), min = g.r + 18;
    if (dist >= min) return;
    const ux = dist ? dx / dist : 0, uy = dist ? dy / dist : -1;
    g.x = d.x + ux * min; g.y = d.y + uy * min;
  }));
  // moving aside can push two groups together, and joining them can land on a data center again
  merge(); clearDcs(); merge(); clearDcs();
  return { groups, of };
}

/** Radius of a bubble holding `n` of `most` devices. Area per device is constant, so a group ten times
 * bigger draws ten times the area — the caption on the tile says "size = devices" and has to be true.
 * The floor keeps a single device visible; it only bites when the largest group is very large. */
export const bubbleRadius = (n: number, most: number, biggest = 88) => Math.max(22, Math.min(180, biggest * Math.sqrt(n / Math.max(1, most))));
