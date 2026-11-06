// Where the map's camera sits, as arithmetic rather than as a closure inside the canvas.
//
// It lived in `fitTo` in LiveMap.tsx, which can only be exercised by rendering a canvas — so the
// one thing nobody could ask was the thing a reader judges first: how much of the frame the estate
// actually fills. Measured on a customer's screenshot, 282 sites in 23 US regions filled 59% of the
// width and 27% of the height of the area between the panels. This is that rule, so the suite can
// ask it of any estate.

/** Mercator, the same projection the canvas draws with. */
export const projY = (lat: number) =>
  -Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)) * (180 / Math.PI);

export interface Insets { top: number; right: number; bottom: number; left: number }
export interface View { cx: number; cy: number; k: number }
export interface Placed { lat: number; lon: number }

/** The breathing room around the estate: the frame is this much wider than what it holds. */
export const FIT_MARGIN = 1.35;

/**
 * The frame, from the points it has to hold.
 *
 * `tight` is for a group opened from the map, which can sit inside a fraction of a degree; the
 * floors stop a single site filling the screen at street level.
 */
export function fitView(pts: readonly Placed[], w: number, h: number, ins: Insets, tight = false): View | null {
  if (!pts.length) return null;
  const xs = pts.map((p) => p.lon), ys = pts.map((p) => projY(p.lat));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const fw = Math.max(120, w - ins.left - ins.right), fh = Math.max(120, h - ins.top - ins.bottom);
  const spanX = Math.max(x1 - x0, tight ? 0.3 : 18), spanY = Math.max(y1 - y0, tight ? 0.2 : 10);
  const k = Math.max(1.2, Math.min(260, Math.min(fw / (spanX * FIT_MARGIN), fh / (spanY * FIT_MARGIN))));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k };
}

/**
 * What share of the frame the estate ends up filling, across and down.
 *
 * The number a reader sees before any other: an estate at 59% by 27% reads as a map of an ocean
 * with some dots in it. A fit that is working puts the binding dimension at 1 / FIT_MARGIN = 74%.
 */
export function frameFill(pts: readonly Placed[], w: number, h: number, ins: Insets): { across: number; down: number } | null {
  const v = fitView(pts, w, h, ins);
  if (!v) return null;
  const xs = pts.map((p) => p.lon), ys = pts.map((p) => projY(p.lat));
  const fw = Math.max(120, w - ins.left - ins.right), fh = Math.max(120, h - ins.top - ins.bottom);
  return {
    across: ((Math.max(...xs) - Math.min(...xs)) * v.k) / fw,
    down: ((Math.max(...ys) - Math.min(...ys)) * v.k) / fh,
  };
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface LabelCandidate { x: number; y: number; name: string; code: string; dc?: boolean }
export interface PlacedLabel { x: number; y: number; text: string; dc: boolean }

/**
 * Which names the map writes, and which it drops.
 *
 * Geometry, not a count: a name is written where it does not touch anything already on the canvas.
 * `taken` starts as the marks — the dots, the squares, the cluster rings — because a name written
 * across the ring it belongs to is how a busy map stops being readable, and the rule used to
 * consider only other *names*. A site's own mark, and the cluster it sits inside, are not obstacles
 * to its own name; every other mark is.
 *
 * `measure` is the canvas's own text measurement, passed in, so this can be asked the question
 * without a canvas and answered the same way the canvas answers it.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  marks: readonly Box[],
  measure: (text: string, dc: boolean) => number,
): { placed: PlacedLabel[]; taken: Box[] } {
  const boxes: Box[] = [];
  const placed: PlacedLabel[] = [];
  const hits = (b: Box, t: Box) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0;
  for (const s of candidates) {
    const { x, y } = s, dc = !!s.dc;
    /*
     * Only a *mark* can be forgiven for sitting under the site it belongs to. A name already
     * written is never forgiven, whatever it covers: the first version of this excused any box
     * containing the point, which let a name be written straight over its neighbour's name —
     * the running-together this rule exists to stop. The suite caught it.
     */
    const own = (t: Box) => t.x0 <= x && x <= t.x1 && t.y0 <= y && y <= t.y1;
    const clear = (b: Box) => !marks.some((m) => !own(m) && hits(b, m)) && !boxes.some((t) => hits(b, t));
    // the name is what a reader is after; the code is the fallback for when the name will not fit
    const fits = (t: string) => clear({ x0: x + 8 - 10, y0: y - (dc ? 7 : 6) - 3, x1: x + 12 + measure(t, dc) + 10, y1: y + (dc ? 7 : 6) + 3 });
    const text = fits(s.name) ? s.name : s.code;
    const w = measure(text, dc), h = dc ? 14 : 12;
    const box = { x0: x + 8, y0: y - h / 2, x1: x + 12 + w, y1: y + h / 2 };
    // boxes that merely touch still read as one name — two neighbouring sites ran together into one
    // long string on screen — so a label needs clear space around it, not just no overlap
    const gap = { x0: box.x0 - 10, y0: box.y0 - 3, x1: box.x1 + 10, y1: box.y1 + 3 };
    if (!clear(gap)) continue;
    boxes.push(box);
    placed.push({ x, y, text, dc });
  }
  return { placed, taken: [...marks, ...boxes] };
}
