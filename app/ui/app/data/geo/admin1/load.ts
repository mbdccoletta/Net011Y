// The state layer of the map: outlines of the admin-1 regions — states, provinces, prefectures — of the
// countries the sites actually fall in.
//
// Each country is a chunk of its own (index.ts holds one dynamic import per country), so a reader who
// never opens the view downloads none of it, and one who does downloads their own country rather than
// the four thousand regions of the world. Which countries to fetch comes from the bounding boxes, not
// from a country tag: an environment that tags nothing still gets its outlines.
import { ADMIN1_BOXES, ADMIN1_LOADERS, type Admin1Country } from "./index";

export interface RegionShape {
  cc: string;
  code: string;
  name: string;
  /** label anchor: the centre of the region's largest ring */
  lon: number;
  lat: number;
  box: readonly [number, number, number, number];
  rings: Float64Array[];
}

/** Quantised deltas, five bits a character, as scripts/admin1.py writes them. */
function decode(s: string): Float64Array {
  const out: number[] = [];
  let x = 0, y = 0, i = 0;
  while (i < s.length) {
    const vals: number[] = [];
    for (let k = 0; k < 2; k++) {
      let v = 0, shift = 0, c: number;
      do {
        c = s.charCodeAt(i++) - 63;
        v |= (c & 31) << shift;
        shift += 5;
      } while (c >= 32);
      vals.push(v & 1 ? -(v >> 1) : v >> 1);
    }
    x += vals[0]; y += vals[1];
    out.push(x / 100, y / 100);
  }
  return new Float64Array(out);
}

const cache = new Map<string, Promise<RegionShape[]>>();

function ofCountry(cc: string): Promise<RegionShape[]> {
  const had = cache.get(cc);
  if (had) return had;
  const load = ADMIN1_LOADERS[cc];
  const p: Promise<RegionShape[]> = load
    ? load().then((m) => {
      const c: Admin1Country = m.default;
      return c.regions.map((r) => ({
        cc, code: r.code, name: r.name, lon: r.lon, lat: r.lat,
        box: r.b as unknown as readonly [number, number, number, number],
        rings: r.d.map(decode),
      }));
    }).catch(() => [])
    : Promise.resolve([]);
  cache.set(cc, p);
  return p;
}

/** The countries these coordinates fall in, by bounding box: a few names, never the whole world. */
export function countriesOf(points: { lat: number; lon: number }[]): string[] {
  const out = new Set<string>();
  for (const p of points) {
    for (const [cc, boxes] of Object.entries(ADMIN1_BOXES)) {
      if (boxes.some((b) => p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3])) out.add(cc);
    }
  }
  return [...out];
}

/** The outlines for a set of sites. Countries already fetched are not fetched again. */
export async function loadRegions(points: { lat: number; lon: number }[]): Promise<RegionShape[]> {
  const ccs = countriesOf(points);
  const all = await Promise.all(ccs.map(ofCountry));
  return all.flat();
}

/** Is the point inside the ring? Ray casting, the ring being closed by construction. */
export function inRing(ring: Float64Array, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** about thirty kilometres: how far outside an outline a site may sit and still belong to it */
const NEAR = 0.3;

/**
 * The region a point sits in, or null. The box is tested first, which is most of the saving.
 *
 * A site just outside every outline is taken by the nearest one within a few tens of kilometres. The
 * outlines are simplified to about five kilometres, so a coastal city — Manhattan was the one that
 * caught this — can fall in the water the simplification left behind, and belongs to the state it is
 * plainly in rather than to nowhere.
 */
export function regionAt(regions: RegionShape[], lon: number, lat: number): RegionShape | null {
  let near: RegionShape | null = null;
  let best = NEAR * NEAR;
  for (const r of regions) {
    if (lon < r.box[0] - NEAR || lon > r.box[2] + NEAR || lat < r.box[1] - NEAR || lat > r.box[3] + NEAR) continue;
    if (lon >= r.box[0] && lon <= r.box[2] && lat >= r.box[1] && lat <= r.box[3]
      && r.rings.some((ring) => inRing(ring, lon, lat))) return r;
    for (const ring of r.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const dx = ring[i] - lon, dy = ring[i + 1] - lat;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; near = r; }
      }
    }
  }
  return near;
}
