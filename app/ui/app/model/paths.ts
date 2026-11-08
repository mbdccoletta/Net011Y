// The WAN paths as rows, and how many of them the map is allowed to draw.
//
// The map drew one curve per link, and a hub-and-spoke estate has one link per site all ending
// at the same few points: 230 spokes on two hubs put 230 curves on screen and left a reader 162
// of them to separate at the worst vertical. `askedAbout` in camera.ts cut that to the routes
// somebody asked about, which fixed the resting map and a single cause — and left two cases
// over: a region picked is 23 routes, and every site picked is 230.
//
// Drawing fewer of them is not the answer past a point, because the bundle is made by the
// convergence rather than by the count. Past the ceiling the information leaves the map and
// becomes rows: a row cannot overlap another row, both of its ends are written out in full, and
// the number it carries is on it rather than in a tooltip. That is what this module builds.
import { ORDER } from "./verdict";
import type { Verdict } from "./types";

/**
 * How many curves a reader can still follow at once.
 *
 * Measured by sweeping every vertical across the stage and counting the curves that cross it
 * (`crossingDepth`). Three is where a line can still be traced from end to end; the estate that
 * prompted all of this was at 162.
 */
export const DRAW_CAP = 3;

export interface PathLink {
  id: string;
  a: string;
  b: string;
  verdict: Verdict;
  bps?: number | null;
}

export interface PathEnd { code: string; label: string; dc: boolean }

export interface PathRow {
  /** the two ends, sorted and joined — the key both maps already group a pair under */
  id: string;
  a: PathEnd;
  b: PathEnd;
  verdict: Verdict;
  /** bits per second, summed over the links the row stands for; null when none of them is measured */
  bps: number | null;
  /** how many links the row stands for */
  n: number;
}

/** Critical first, then Warning, then what is merely unmeasured, then the quiet ones. */
const rank = (v: Verdict) => ORDER[v] ?? 9;

/**
 * One row per pair of sites, worst first and then by what it carries.
 *
 * A pair can arrive more than once — once from the cable the devices report, once from the flow
 * the traffic was measured in — and the map has always treated that as one route. The rows do
 * the same, so the count in a row and the curve on the map are the same thing.
 */
export function pathRows(links: readonly PathLink[], endOf: (code: string) => PathEnd | null): PathRow[] {
  const by = new Map<string, PathRow>();
  for (const l of links) {
    const a = endOf(l.a), b = endOf(l.b);
    if (!a || !b || a.code === b.code) continue;
    const [p, q] = a.code < b.code ? [a, b] : [b, a];
    const id = `${p.code}|${q.code}`;
    const had = by.get(id);
    if (!had) { by.set(id, { id, a: p, b: q, verdict: l.verdict, bps: l.bps ?? null, n: 1 }); continue; }
    had.n++;
    if (rank(l.verdict) < rank(had.verdict)) had.verdict = l.verdict;
    if (l.bps != null) had.bps = (had.bps ?? 0) + l.bps;
  }
  return [...by.values()].sort((x, y) => rank(x.verdict) - rank(y.verdict) || (y.bps ?? -1) - (x.bps ?? -1)
    || x.id.localeCompare(y.id));
}

/**
 * Which of the routes somebody asked about the map actually draws.
 *
 * Under the cap nothing changes: a handful of routes is what the curve is good at, and the
 * estates that have always read well keep reading the same way. Over it, only the routes with
 * something wrong are drawn, worst first — because a reader who picked a region of twenty-three
 * sites is asking which of them is hurting, and three arbitrary healthy arcs answer nothing
 * while costing the same ink that buried the answer before. When nothing in the set is wrong,
 * the map draws none of them and the rows carry the whole of it.
 *
 * Picking a row is picking its two ends, so the route comes back through `askedAbout` with no
 * second mechanism: one row clicked is one curve on the map.
 */
export function routesToDraw<T extends { verdict: Verdict }>(asked: readonly T[], cap = DRAW_CAP): T[] {
  if (asked.length <= cap) return [...asked];
  return [...asked]
    .filter((r) => r.verdict === "Critical" || r.verdict === "Warning")
    .sort((x, y) => rank(x.verdict) - rank(y.verdict))
    .slice(0, cap);
}
