// How many names the Live map writes that nobody can read, before and after the rule.
//
// The estate, the camera, the clustering and the placement are the app's own functions. The three
// rectangles are the stage and the two cards, taken from the screenshot the user sent (1640 wide):
// the left card, the right problem panel and the zoom controls. Text width is approximated — the
// canvas is not here — but both runs use the same approximation, so the comparison is fair.
import { buildExampleNetwork, fitView, projY, placeLabels, labelFits, clusterPoints, shortSiteName,
  ensurePlaces, regionOf } from "./out/app-model.mjs";

const MODE = process.argv[2] === "us" ? "us" : "example";

const W = 1608, H = 790;
const INS = { top: 24, right: 376, bottom: 28, left: 336 };
const STAGE = { x0: 0, y0: 0, x1: W, y1: H };
const BLOCKERS = [
  { x0: 20, y0: 20, x1: 359, y1: 300 },     // the Causes / Sites card
  { x0: 1249, y0: 20, x1: 1608, y1: 790 },  // the problem panel
  { x0: 1222, y0: 622, x1: 1248, y1: 755 }, // the zoom controls
];

let sites;
if (MODE === "us") {
  // the shape that makes the names work hard: many sites in one country, over a couple of dozen
  // regions. Centroids are the app's own; the names are invented. Same spread as map_preview.mjs.
  const SPREAD = [["North Carolina",23,"NC"],["Nebraska",29,"NE"],["Kansas",26,"KS"],["Missouri",23,"MO"],
    ["California",20,"CA"],["Wyoming",17,"WY"],["Minnesota",13,"MN"],["Oklahoma",13,"OK"],["Florida",13,"FL"],
    ["Georgia",8,"GA"],["Wisconsin",7,"WI"],["South Dakota",7,"SD"],["Texas",5,"TX"],["Massachusetts",5,"MA"],
    ["North Dakota",4,"ND"],["Idaho",4,"ID"],["Washington",4,"WA"],["South Carolina",3,"SC"],["Oregon",2,"OR"],
    ["Illinois",1,"IL"],["Utah",1,"UT"],["Delaware",1,"DE"],["New Mexico",1,"NM"]];
  const TOWN = ["Fairview","Ashland","Clayton","Milford","Riverton","Oakdale","Bristol","Hartwell",
    "Newport","Glenwood","Summit","Weston","Lakeside","Preston","Kingsley","Dover"];
  await ensurePlaces();
  let n = 0; sites = [];
  for (const [region, count, code] of SPREAD) {
    const c = regionOf(region, ["US"]);
    if (!c) continue;
    for (let i = 0; i < count; i++) {
      const a = (n * 2.399963) % (Math.PI * 2), rad = 0.35 + ((n % 7) / 7) * 1.25;
      const raw = `DEPOT:B1${(n % 90) + 10}.0${n % 9}:9 Example Road:${TOWN[n % TOWN.length]}:${code}:1${1000 + n}`;
      sites.push({ code: `${code}-${i}`, name: raw, label: shortSiteName(raw),
        lat: c.lat + Math.sin(a) * rad, lon: c.lon + Math.cos(a) * rad * 1.5, dc: false,
        verdict: n % 141 === 0 ? "Critical" : (n % 5 === 0 ? "Healthy" : "Not monitored") });
      n++;
    }
  }
} else {
  const model = buildExampleNetwork(new Date(), "mid");
  sites = Object.values(model.sites).filter((s) => s.lat != null).map((s) => ({
    code: s.code, name: s.name, label: shortSiteName(s.name), lat: s.lat, lon: s.lon,
    dc: !!s.dc, verdict: model.siteVerdicts?.[s.code] ?? "Healthy",
  }));
}

const fit = fitView(sites, W, H, INS);

/*
 * Not one camera, but every camera a reader can reach.
 *
 * The opening fit pads for the two panels, so at that one position nothing lands under them and
 * the defect is invisible — which is why looking at the first frame said everything was fine. The
 * reader then pans and zooms, and the guarantee goes with it: the padding was computed once, for
 * the dots, and a name is written to the RIGHT of its dot and runs on for its own length, so a
 * site still inside the band has its name written across the panel beside it. So this sweeps a
 * grid of pans and zooms around the fit and counts over all of them.
 */
const CAMS = [];
for (const z of [0.6, 0.85, 1, 1.4, 2]) for (const dx of [-0.35, -0.15, 0, 0.15, 0.35]) for (const dy of [-0.25, 0, 0.25]) {
  CAMS.push({ k: fit.k * z, cx: fit.cx + dx * (W / fit.k), cy: fit.cy + dy * (H / fit.k) });
}

const measure = (t, dc) => (dc ? 6.6 : 6.3) * t.length;
const byCode = new Map(sites.map((s) => [s.code, s]));

const judge = (placed) => {
  let readable = 0, cut = 0, covered = 0;
  for (const l of placed) {
    const box = { x0: l.x + 8, y0: l.y - (l.dc ? 7 : 6), x1: l.x + 12 + measure(l.text, l.dc), y1: l.y + (l.dc ? 7 : 6) };
    const off = box.x1 > STAGE.x1 || box.x0 < STAGE.x0 || box.y1 > STAGE.y1 || box.y0 < STAGE.y0;
    const hid = BLOCKERS.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    if (off) cut++; else if (hid) covered++; else readable++;
  }
  return { written: placed.length, readable, cut, covered };
};

const sum = { before: { written: 0, readable: 0, cut: 0, covered: 0 }, after: { written: 0, readable: 0, cut: 0, covered: 0 } };
let worstCam = null;
for (const v of CAMS) {
  const ox = INS.left + (W - INS.left - INS.right) / 2, oy = INS.top + (H - INS.top - INS.bottom) / 2;
  const sx = (lon) => ox + (lon - v.cx) * v.k, sy = (lat) => oy + (projY(lat) - v.cy) * v.k;
  const pts = sites.map((s) => ({ code: s.code, x: sx(s.lon), y: sy(s.lat), verdict: s.verdict, dc: s.dc }))
    .filter((p) => p.x > -200 && p.x < W + 200 && p.y > -200 && p.y < H + 200);
  if (!pts.length) continue;
  const { groups, of } = clusterPoints(pts, { dcs: pts.filter((p) => p.dc) });
  const marks = [];
  for (const cl of groups) marks.push({ x0: cl.x - cl.r - 4, y0: cl.y - cl.r - 4, x1: cl.x + cl.r + 4, y1: cl.y + cl.r + 4 });
  const loose = pts.filter((p) => !of.has(p.code));
  for (const p of loose) { const r = p.dc ? 13 : (p.verdict === "Critical" || p.verdict === "Warning" ? 5.8 : 4.8);
    marks.push({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }); }
  const cands = loose.sort((a, b) => Number(b.dc) - Number(a.dc)).slice(0, 160)
    .map((p) => ({ x: p.x, y: p.y, name: byCode.get(p.code).label ?? byCode.get(p.code).name, code: p.code, dc: p.dc }));
  const b = judge(placeLabels(cands, marks, measure).placed);
  const a = judge(placeLabels(cands, marks, measure, { stage: STAGE, blockers: BLOCKERS }).placed);
  for (const k of ["written", "readable", "cut", "covered"]) { sum.before[k] += b[k]; sum.after[k] += a[k]; }
  const bad = b.cut + b.covered;
  if (!worstCam || bad > worstCam.bad) worstCam = { bad, b, a };
}

console.log(`estate ${sites.length} sites · ${CAMS.length} camera positions swept (5 zooms x 5 pans x 3 lifts)\n`);
const row = (k, r) => console.log(`${k.padEnd(7)} written ${String(r.written).padStart(4)} · readable ${String(r.readable).padStart(4)} · cut at the edge ${String(r.cut).padStart(3)} · under a panel ${String(r.covered).padStart(3)}`);
row("before", sum.before); row("after", sum.after);
console.log(`\nnames written that nobody can read: ${sum.before.cut + sum.before.covered} -> ${sum.after.cut + sum.after.covered}`);
console.log(`readable names:                     ${sum.before.readable} -> ${sum.after.readable}  (${sum.after.readable - sum.before.readable >= 0 ? "+" : ""}${sum.after.readable - sum.before.readable})`);
if (worstCam) console.log(`worst single view: ${worstCam.bad} unreadable of ${worstCam.b.written} written -> ${worstCam.a.cut + worstCam.a.covered} of ${worstCam.a.written}, readable ${worstCam.b.readable} -> ${worstCam.a.readable}`);
