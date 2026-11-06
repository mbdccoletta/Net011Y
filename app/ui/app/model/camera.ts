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
