// Draws the Live map outside the app, so a change to it can be looked at without a tenant.
//
// The three decisions that make the map what it is — where the camera sits (`fitView`), how the
// sites group (`clusterPoints`) and which names are written (`placeLabels`) — are the app's own
// functions, bundled in and called here. The painting is this script's: the land outlines and the
// animations are not reproduced, so this answers "are the names readable and in the right place",
// not "is this pixel-identical to the app".
//
//   node map_preview.mjs            # the example estate the app ships
//   node map_preview.mjs > out/map-preview.html
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const esbuild = new URL("../../app/node_modules/.bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [new URL("map_preview_entry.ts", import.meta.url).pathname, "--bundle",
  "--format=iife", "--global-name=NetMap", "--platform=browser", "--outfile=out/map-preview-bundle.js",
  "--log-level=warning"], { stdio: "inherit", cwd: new URL(".", import.meta.url).pathname });
const BUNDLE = readFileSync(new URL("out/map-preview-bundle.js", import.meta.url).pathname, "utf8");

const W = 1366, H = 697;
const INSETS = { top: 24, right: 376, bottom: 28, left: 336 };

const MODE = process.argv[2] === "us" ? "us" : "example";
const page = `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8"><title>Live map preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #141419; color: #e2e8f0;
    font: 13px/1.45 "Bitstream Vera Sans", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .wrap { width: ${W}px; margin: 0 auto; padding: 16px 0 28px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: #9aa1b5; margin: 0 0 14px; }
  .stage { position: relative; width: ${W}px; height: ${H}px; background: #141419;
    border: 1px solid #2b2b3a; border-radius: 10px; overflow: hidden; }
  canvas { display: block; }
  .ghost { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.035);
    border-left: 1px dashed #343449; border-right: 1px dashed #343449; font: 11px/1 monospace;
    color: #6f7590; padding-top: 8px; text-align: center; }
  .ghost.l { left: 0; width: ${INSETS.left}px; } .ghost.r { right: 0; width: ${INSETS.right}px; }
  .facts { margin-top: 12px; color: #9aa1b5; }
  .facts b { color: #e2e8f0; }
</style></head><body><div class="wrap">
<h1>Live map — ${MODE === "us" ? "um estate de 282 sites num país" : "o estate de exemplo"}, desenhado pelas funções do app</h1>
<p class="sub">Câmera, agrupamento e escolha dos nomes vêm de <code>fitView</code>, <code>clusterPoints</code>
e <code>placeLabels</code>. As faixas tracejadas são onde os dois painéis ficam por cima.</p>
<div class="stage"><canvas id="c" width="${W}" height="${H}"></canvas>
  <div class="ghost l">painel esquerdo</div><div class="ghost r">painel direito</div></div>
<p class="facts" id="facts"></p>
<script>${BUNDLE}</script>
<script type="module">
const W=${W}, H=${H}, INS=${JSON.stringify(INSETS)};
const COL={Critical:"#c82d40",Warning:"#d7b43b",Healthy:"#00bb7b","Not monitored":"#7c7f9e"};
const INK="#e2e8f0", HALO="#141419";
const MODE = "${MODE}";
let sites;
if (MODE === "us") {
  // A synthetic estate with the shape that makes the labels work hard: many sites in one country,
  // spread over a couple of dozen regions. The centroids are the app's own; the names are invented,
  // including two of the shape that used to print the same word twice.
  const SPREAD = [["North Carolina",23,"NC"],["Nebraska",29,"NE"],["Kansas",26,"KS"],["Missouri",23,"MO"],
    ["California",20,"CA"],["Wyoming",17,"WY"],["Minnesota",13,"MN"],["Oklahoma",13,"OK"],["Florida",13,"FL"],
    ["Georgia",8,"GA"],["Wisconsin",7,"WI"],["South Dakota",7,"SD"],["Texas",5,"TX"],["Massachusetts",5,"MA"],
    ["North Dakota",4,"ND"],["Idaho",4,"ID"],["Washington",4,"WA"],["South Carolina",3,"SC"],["Oregon",2,"OR"],
    ["Illinois",1,"IL"],["Utah",1,"UT"],["Delaware",1,"DE"],["New Mexico",1,"NM"]];
  const TOWN = ["Fairview","Ashland","Clayton","Milford","Riverton","Oakdale","Bristol","Hartwell",
    "Newport","Glenwood","Summit","Weston","Lakeside","Preston","Kingsley","Dover"];
  await NetMap.ensurePlaces();
  let n = 0;
  sites = [];
  for (const [region, count, code] of SPREAD) {
    const c = NetMap.regionOf(region, ["US"]);
    if (!c) continue;
    for (let i = 0; i < count; i++) {
      const a = (n * 2.399963) % (Math.PI * 2), rad = 0.35 + ((n % 7) / 7) * 1.25;
      // two sites carry a name whose city slot repeats the region code, the shape that printed twice
      const town = i === 0 && (code === "KS" || code === "OK") ? code : TOWN[n % TOWN.length];
      const raw = \`DEPOT:B1\${(n % 90) + 10}.0\${n % 9}:9 Example Road:\${town}:\${code}:1\${1000 + n}\`;
      sites.push({ code: \`\${code}-\${i}\`, name: raw, label: NetMap.shortSiteName(raw),
        lat: c.lat + Math.sin(a) * rad, lon: c.lon + Math.cos(a) * rad * 1.5,
        dc: false, verdict: n % 141 === 0 ? "Critical" : (n % 5 === 0 ? "Healthy" : "Not monitored") });
      n++;
    }
  }
} else {
  const model = NetMap.buildExampleNetwork();
  sites = Object.values(model.sites).filter(s => s.lat != null).map(s => ({
    code: s.code, name: s.name, label: NetMap.shortSiteName(s.name), lat: s.lat, lon: s.lon,
    dc: !!s.dc, verdict: model.siteVerdicts?.[s.code] ?? "Healthy",
  }));
}
const v = NetMap.fitView(sites, W, H, INS);
const ox = INS.left + (W - INS.left - INS.right)/2, oy = INS.top + (H - INS.top - INS.bottom)/2;
const sx = lon => ox + (lon - v.cx) * v.k, sy = lat => oy + (NetMap.projY(lat) - v.cy) * v.k;

const ctx = document.getElementById("c").getContext("2d");
ctx.fillStyle = "#141419"; ctx.fillRect(0,0,W,H);
// a faint graticule stands in for the land outlines, which this preview does not draw
ctx.strokeStyle = "#1e1e2b"; ctx.lineWidth = 1;
for (let lon=-180; lon<=180; lon+=10){ const x=sx(lon); ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
for (let lat=-80; lat<=80; lat+=10){ const y=sy(lat); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

const pts = sites.map(s => ({ code:s.code, x:sx(s.lon), y:sy(s.lat), verdict:s.verdict, dc:s.dc }));
const { groups, of } = NetMap.clusterPoints(pts, { dcs: pts.filter(p=>p.dc) });
const marks = [], reserve = (x,y,r) => marks.push({x0:x-r,y0:y-r,x1:x+r,y1:y+r});

for (const cl of groups) {
  ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r+3, 0, Math.PI*2); ctx.fill();
  let a0 = -Math.PI/2;
  for (const [vd,k] of [["Critical",cl.crit],["Warning",cl.warn],["Healthy",cl.healthy],["Not monitored",cl.other]]) {
    if (!k) continue;
    const a1 = a0 + (k/cl.n)*Math.PI*2;
    ctx.strokeStyle = COL[vd]; ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.arc(cl.x, cl.y, cl.r, a0, a1); ctx.stroke(); a0 = a1;
  }
  ctx.fillStyle = INK; ctx.textAlign="center"; ctx.textBaseline="middle";
  ctx.font = \`600 \${cl.n>=100?9.5:10.5}px ui-monospace, monospace\`;
  ctx.fillText(cl.n>=1000 ? (cl.n/1000).toFixed(1)+"k" : String(cl.n), cl.x, cl.y+0.5);
  ctx.textAlign="start";
  reserve(cl.x, cl.y, cl.r+4);
}
const loose = pts.filter(p => !of.has(p.code));
for (const p of loose) {
  if (p.dc) {
    const half = 8;
    ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(p.x,p.y,half+5,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = COL[p.verdict]; ctx.lineWidth = 2.6;
    ctx.fillStyle = HALO; ctx.fillRect(p.x-half,p.y-half,half*2,half*2); ctx.strokeRect(p.x-half,p.y-half,half*2,half*2);
    ctx.fillStyle = COL[p.verdict]; ctx.beginPath(); ctx.arc(p.x,p.y,half*0.34,0,Math.PI*2); ctx.fill();
    reserve(p.x,p.y,half+5);
  } else {
    const bad = p.verdict==="Critical"||p.verdict==="Warning", r = bad?3.4:2.4;
    ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(p.x,p.y,r+2.4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = COL[p.verdict]; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill();
    reserve(p.x,p.y,r+2.4);
  }
}
const byCode = new Map(sites.map(s=>[s.code,s]));
const measure = (t,dc) => { ctx.font = dc ? "600 12px sans-serif" : "500 11px ui-monospace, monospace"; return ctx.measureText(t).width; };
const cands = loose.sort((a,b)=>Number(b.dc)-Number(a.dc)).slice(0,160)
  .map(p => ({ x:p.x, y:p.y, name: byCode.get(p.code).label ?? byCode.get(p.code).name, code:p.code, dc:p.dc }));
const chosen = NetMap.placeLabels(cands, marks, measure);
ctx.textBaseline = "middle";
for (const l of chosen.placed) {
  ctx.font = l.dc ? "600 12px sans-serif" : "500 11px ui-monospace, monospace";
  ctx.lineWidth = 3.5; ctx.strokeStyle = HALO; ctx.fillStyle = INK;
  ctx.strokeText(l.text, l.x+10, l.y); ctx.fillText(l.text, l.x+10, l.y);
}
// does any name end up written across a mark it does not belong to?
let over = 0;
for (const l of chosen.placed) {
  const wdt = measure(l.text, l.dc), b = {x0:l.x+8,y0:l.y-6,x1:l.x+12+wdt,y1:l.y+6};
  for (const m of marks) {
    const own = m.x0<=l.x && l.x<=m.x1 && m.y0<=l.y && l.y<=m.y1;
    if (!own && b.x0<m.x1 && b.x1>m.x0 && b.y0<m.y1 && b.y1>m.y0) { over++; break; }
  }
}
const f = NetMap.frameFill(sites, W, H, INS);
document.getElementById("facts").innerHTML =
  \`<b>\${sites.length}</b> sites · <b>\${groups.length}</b> agrupamentos · <b>\${chosen.placed.length}</b> nomes escritos de \${cands.length} candidatos · \` +
  \`nomes por cima de uma marca: <b>\${over}</b> · o estate ocupa <b>\${(100*f.across).toFixed(0)}%</b> da largura e <b>\${(100*f.down).toFixed(0)}%</b> da altura\`;
</script></div></body></html>`;

process.stdout.write(page);
