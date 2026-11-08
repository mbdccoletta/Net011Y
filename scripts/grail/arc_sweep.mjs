// How many routes the Live map draws, and how many of them a reader has to separate at the
// worst place on the screen.
//
// The number the screenshot was about and a count of routes does not give: routes that
// converge stack up near their shared end whatever their number. The estate is the shape the
// real one has — many spokes, few hubs — because that is the shape that makes the routes work
// hard. The decision is the app's own `askedAbout`; the measurement is the app's own
// `crossingDepth`; the bend is the one `LiveMap` strokes, copied here rather than re-derived.
//
//   node scripts/grail/arc_sweep.mjs
import { fitView, projY, ensurePlaces, regionOf, askedAbout, crossingDepth, routesToDraw, DRAW_CAP } from "./out/app-model.mjs";

const W = 1608, H = 790, INS = { top: 24, right: 376, bottom: 28, left: 336 };
/** the ceiling a line can still be followed at */
export const DEPTH_CEILING = 3;

const SPREAD = [["North Carolina",23,"NC"],["Nebraska",29,"NE"],["Kansas",26,"KS"],["Missouri",23,"MO"],
  ["California",20,"CA"],["Wyoming",17,"WY"],["Minnesota",13,"MN"],["Oklahoma",13,"OK"],["Florida",13,"FL"],
  ["Georgia",8,"GA"],["Wisconsin",7,"WI"],["South Dakota",7,"SD"],["Texas",5,"TX"],["Massachusetts",5,"MA"],
  ["North Dakota",4,"ND"],["Idaho",4,"ID"],["Washington",4,"WA"],["South Carolina",3,"SC"],["Oregon",2,"OR"],
  ["Illinois",1,"IL"],["Utah",1,"UT"],["Delaware",1,"DE"],["New Mexico",1,"NM"]];

export async function estate() {
  await ensurePlaces();
  const sites = []; let n = 0;
  for (const [region, count, code] of SPREAD) {
    const c = regionOf(region, ["US"]);
    if (!c) continue;
    for (let i = 0; i < count; i++) {
      const a = (n * 2.399963) % (Math.PI * 2), rad = 0.35 + ((n % 7) / 7) * 1.25;
      sites.push({ code: `${code}-${i}`, lat: c.lat + Math.sin(a) * rad, lon: c.lon + Math.cos(a) * rad * 1.5,
        dc: false, verdict: n % 29 === 0 ? "Critical" : n % 17 === 0 ? "Warning" : "Healthy" });
      n++;
    }
  }
  // two data centres, east and west: the shape a branch estate really has
  const dcs = [{ code: "DC-E", lat: 39.0, lon: -77.5, dc: true }, { code: "DC-W", lat: 37.4, lon: -121.9, dc: true }];
  sites.push(...dcs);
  const spokes = sites.filter((s) => !s.dc);
  for (const s of spokes) {
    let best = dcs[0], bd = Infinity;
    for (const d of dcs) { const q = (s.lat - d.lat) ** 2 + (s.lon - d.lon) ** 2; if (q < bd) { bd = q; best = d; } }
    s.hub = best.code;
  }
  return { sites, spokes, dcs, links: spokes.map((s) => ({ id: `wan:${s.code}`, a: s.code, b: s.hub })) };
}

/** the curve LiveMap strokes: control point 18% of the chord sideways, 8% of it up */
const SAMPLES = 120;
function bend(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const cxp = (x0 + x1) / 2 - (dy / len) * len * 0.18, cyp = (y0 + y1) / 2 + (dx / len) * len * 0.18 - len * 0.08;
  const pts = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES, u = 1 - t;
    pts.push([u * u * x0 + 2 * u * t * cxp + t * t * x1, u * u * y0 + 2 * u * t * cyp + t * t * y1]);
  }
  return pts;
}

/** what the map puts on screen for a given focus, and how deep it stacks */
export function drawn({ sites, dcs, links }, focus, cap = true) {
  const byCode = new Map(sites.map((s) => [s.code, s]));
  const isDc = (code) => !!byCode.get(code)?.dc;
  const v = fitView(sites, W, H, INS);
  const sx = (lon) => W / 2 + (lon - v.cx) * v.k, sy = (lat) => H / 2 + (projY(lat) - v.cy) * v.k;
  const asked = links.filter((l) => askedAbout(focus, isDc, l.a, l.b))
    .map((l) => ({ ...l, verdict: byCode.get(l.a)?.verdict ?? "Healthy" }));
  const curves = (cap ? routesToDraw(asked) : asked).map((l) => {
    const a = byCode.get(l.a), b = byCode.get(l.b);
    return bend(sx(a.lon), sy(a.lat), sx(b.lon), sy(b.lat));
  });
  return { routes: curves.length, asked: asked.length, ...crossingDepth(curves, W), dots: curves.length * 2 * 4, dcs: dcs.length };
}

/**
 * The same question of the geographic map, which groups its routes by region above
 * `ROUTE_BUDGET` links: a region's end is the mean of the sites it stands for, so a region
 * picked is one route and not twenty-three. Its bend is shallower than the canvas's; the
 * canvas's is used here so the two renderers are compared on the same geometry and only the
 * grouping differs, which is the thing being measured.
 */
const ROUTE_BUDGET = 120;
export function drawnGrouped({ sites, dcs, links }, focus, regionOfCode, cap = true) {
  const byCode = new Map(sites.map((s) => [s.code, s]));
  const isDc = (code) => !!byCode.get(code)?.dc;
  const v = fitView(sites, W, H, INS);
  const sx = (lon) => W / 2 + (lon - v.cx) * v.k, sy = (lat) => H / 2 + (projY(lat) - v.cy) * v.k;
  /* counted over what was asked about, not over the estate: one path picked out of the list
     must be drawn from the site the row names, not from the mean of its region */
  const group = links.filter((l) => askedAbout(focus, isDc, l.a, l.b)).length > ROUTE_BUDGET;
  const home = new Map();
  if (group) {
    for (const s of sites.filter((x) => !x.dc)) {
      const k = regionOfCode(s.code);
      const h = home.get(k);
      if (h) { h.lon += s.lon; h.lat += s.lat; h.n++; } else home.set(k, { lon: s.lon, lat: s.lat, n: 1 });
    }
    home.forEach((h) => { h.lon /= h.n; h.lat /= h.n; });
  }
  const by = new Map();
  for (const l of links) {
    if (!askedAbout(focus, isDc, l.a, l.b)) continue;
    const a0 = byCode.get(l.a), b = byCode.get(l.b);
    const h = group ? home.get(regionOfCode(a0.code)) : null;
    const a = h ? { code: regionOfCode(a0.code), lon: h.lon, lat: h.lat } : a0;
    const key = [a.code, b.code].sort().join("|");
    const had = by.get(key);
    const vd = byCode.get(l.a)?.verdict ?? "Healthy";
    if (!had) by.set(key, { id: key, verdict: vd, path: bend(sx(a.lon), sy(a.lat), sx(b.lon), sy(b.lat)) });
    else if (vd === "Critical" || (vd === "Warning" && had.verdict !== "Critical")) had.verdict = vd;
  }
  const asked = [...by.values()];
  const curves = (cap ? routesToDraw(asked) : asked).map((r) => r.path);
  return { routes: curves.length, asked: asked.length, ...crossingDepth(curves, W), dots: curves.length * 2 * 4 };
}

/** how deep it stacked before the rule: every link, always */
export function all({ sites, links }) {
  const byCode = new Map(sites.map((s) => [s.code, s]));
  const v = fitView(sites, W, H, INS);
  const sx = (lon) => W / 2 + (lon - v.cx) * v.k, sy = (lat) => H / 2 + (projY(lat) - v.cy) * v.k;
  const curves = links.map((l) => {
    const a = byCode.get(l.a), b = byCode.get(l.b);
    return bend(sx(a.lon), sy(a.lat), sx(b.lon), sy(b.lat));
  });
  return { routes: curves.length, ...crossingDepth(curves, W), dots: curves.length * 2 * 4 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = await estate();
  const row = (label, r) =>
    console.log(`${label.padEnd(40)} asked ${String(r.asked ?? r.routes).padStart(3)}   drawn ${String(r.routes).padStart(3)}` +
      `   worst vertical ${String(r.worst).padStart(3)}   dots/frame ${String(r.dots).padStart(4)}` +
      `   ${r.worst <= DEPTH_CEILING ? "PASS" : "FAIL"}`);
  console.log(`estate: ${e.spokes.length} spokes, ${e.dcs.length} hubs, ${e.links.length} links`);
  console.log(`ceiling: at most ${DEPTH_CEILING} distinct curves on any vertical; the map's own cap is ${DRAW_CAP}\n`);
  const rg = (code) => code.split("-")[0];
  const one = new Set([e.spokes[0].code]);
  const cause = new Set([e.spokes[0].code, e.spokes[40].code]);
  const region = new Set(e.spokes.filter((s) => s.code.startsWith("NC-")).map((s) => s.code));
  const every = new Set(e.spokes.map((s) => s.code));
  console.log("before the rule");
  row("  every link, always", all(e));
  console.log("\nthe schematic canvas: no grouping below 600 sites");
  row("  at rest: nothing picked", drawn(e, null));
  row("  one site picked", drawn(e, one));
  row("  a cause: two sites picked", drawn(e, cause));
  row("  a region picked (23 sites)", drawn(e, region));
  row("  every site picked", drawn(e, every));
  console.log("\nthe geographic map: routes grouped by region above 120 links");
  row("  at rest: nothing picked", drawnGrouped(e, null, rg));
  row("  one site picked", drawnGrouped(e, one, rg));
  row("  a cause: two sites picked", drawnGrouped(e, cause, rg));
  row("  a region picked (23 sites)", drawnGrouped(e, region, rg));
  row("  every site picked", drawnGrouped(e, every, rg));
}
