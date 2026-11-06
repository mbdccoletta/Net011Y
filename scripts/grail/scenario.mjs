// The whole Live map screen, at an estate size nobody here has a tenant for.
//
// A customer's screenshot is the only way the app has been seen at 280 sites in one country, and a
// screenshot cannot be changed to see what a fix did. This builds that screen: the two panels with
// the app's own stylesheet, and between them the map drawn by the app's own camera, clustering and
// label placement (`fitView`, `clusterPoints`, `placeLabels`). The painting of the marks and the
// land is this script's, and the estate is synthetic — invented names at the app's own region
// centroids — so nothing of a customer's lands in this repository.
//
//   node scenario.mjs > out/scenario.html
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const esbuild = new URL("../../app/node_modules/.bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [`${here}map_preview_entry.ts`, "--bundle", "--format=iife",
  "--global-name=NetMap", "--platform=browser", "--outfile=out/scenario-bundle.js", "--log-level=warning"],
  { stdio: "inherit", cwd: here });
const BUNDLE = readFileSync(`${here}out/scenario-bundle.js`, "utf8");
const THEME = readFileSync(new URL("../../app/ui/app/styles/theme.css", import.meta.url).pathname, "utf8");

const W = 1366, H = 700;
const INSETS = { top: 24, right: 376, bottom: 28, left: 336 };

const page = `<!doctype html>
<html lang="pt-BR" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>NetO11y</title>
<style>
${THEME}
body { margin: 0; background: var(--lm-bg); color: var(--lm-ink);
  font: 13px/1.45 "Bitstream Vera Sans", Roboto, "Helvetica Neue", Arial, sans-serif; }
.page { width: ${W}px; margin: 0 auto; padding: 14px 0 32px; }
.head { display: flex; align-items: baseline; gap: 12px; padding: 0 16px 10px; }
h1 { font-size: 16px; font-weight: 600; margin: 0; }
.sub { color: var(--lm-muted); margin: 0; }
.swap { margin-left: auto; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; }
.stage { position: relative; width: ${W}px; height: ${H}px; }
canvas { position: absolute; inset: 0; }
.lm-panel { position: absolute; top: 0; width: 302px; max-height: ${H}px; overflow: hidden; margin: 0; }
.lm-left { left: 16px; height: auto; }
.lm-right { right: 16px; width: 338px; }
.facts { padding: 10px 16px 0; color: var(--lm-muted); }
.facts b { color: var(--lm-ink); }
.lm-region--more .lm-region__rest { color: var(--lm-muted); font-size: 11px; }
</style></head><body><div class="lm"><div class="page">
  <div class="head"><h1>NetO11y · Live map</h1>
    <p class="sub">cenário sintético na densidade de um estate de 280 sites num país</p>
    <button class="lm-btn swap" id="swap" type="button">tema claro</button></div>
  <div class="bar" id="pills"></div>
  <div class="stage"><canvas id="c" width="${W}" height="${H}"></canvas>
    <aside class="lm-panel lm-left" id="left"></aside>
    <aside class="lm-panel lm-right" id="right"></aside></div>
  <p class="facts" id="facts"></p>
<script>${BUNDLE}</script>
<script type="module">
const W=${W}, H=${H}, INS=${JSON.stringify(INSETS)};
const COL={Critical:"var(--lm-bad-fill)",Warning:"var(--lm-warn-fill)",Healthy:"var(--lm-good-fill)","Not monitored":"var(--lm-neutral)"};

// ---- a synthetic estate: invented names at the app's own region centroids ----
const SPREAD=[["North Carolina",23,"NC"],["Nebraska",29,"NE"],["Kansas",26,"KS"],["Missouri",23,"MO"],
 ["California",20,"CA"],["Wyoming",17,"WY"],["Minnesota",13,"MN"],["Oklahoma",13,"OK"],["Florida",13,"FL"],
 ["Georgia",8,"GA"],["Wisconsin",7,"WI"],["South Dakota",7,"SD"],["Texas",5,"TX"],["Massachusetts",5,"MA"],
 ["North Dakota",4,"ND"],["Idaho",4,"ID"],["Washington",4,"WA"],["South Carolina",3,"SC"],["Oregon",2,"OR"],
 ["Illinois",1,"IL"],["Utah",1,"UT"],["Delaware",1,"DE"],["New Mexico",1,"NM"]];
const TOWN=["Fairview","Ashland","Clayton","Milford","Riverton","Oakdale","Bristol","Hartwell",
 "Newport","Glenwood","Summit","Weston","Lakeside","Preston","Kingsley","Dover"];
await NetMap.ensurePlaces();
const sites=[]; let n=0;
for (const [region,count,code] of SPREAD){
  const c = NetMap.regionOf(region, ["US"]); if (!c) continue;
  for (let i=0;i<count;i++){
    const a=(n*2.399963)%(Math.PI*2), rad=0.35+((n%7)/7)*1.25;
    const town=TOWN[n%TOWN.length];
    const raw=\`DEPOT:B1\${(n%90)+10}.0\${n%9}:9 Example Road:\${town}:\${code}:1\${1000+n}\`;
    sites.push({code:\`\${code}-\${i}\`,name:raw,label:NetMap.shortSiteName(raw),region,
      lat:c.lat+Math.sin(a)*rad, lon:c.lon+Math.cos(a)*rad*1.5, dc:false,
      verdict: n%141===0 ? "Critical" : (n%5===0 ? "Healthy" : "Not monitored")});
    n++;
  }
}
const bad = sites.filter(s=>s.verdict==="Critical"||s.verdict==="Warning").length;

// ---- the map, drawn by the app's own decisions ----
const ctx=document.getElementById("c").getContext("2d");
const css=k=>getComputedStyle(document.documentElement).getPropertyValue(k).trim();
function drawMap(){
  const v=NetMap.fitView(sites,W,H,INS);
  const ox=INS.left+(W-INS.left-INS.right)/2, oy=INS.top+(H-INS.top-INS.bottom)/2;
  const sx=lon=>ox+(lon-v.cx)*v.k, sy=lat=>oy+(NetMap.projY(lat)-v.cy)*v.k;
  const ink=css("--lm-ink")||"#e2e8f0", halo=css("--lm-bg")||"#141419", line=css("--lm-line-2")||"#2b2b3a";
  const col=Object.fromEntries(Object.entries(COL).map(([k,val])=>[k, css(val.slice(4,-1))||"#7c7f9e"]));
  ctx.clearRect(0,0,W,H);
  ctx.strokeStyle=line; ctx.globalAlpha=.35; ctx.lineWidth=1;
  for(let lon=-180;lon<=180;lon+=10){const x=sx(lon);ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let lat=-80;lat<=80;lat+=10){const y=sy(lat);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  ctx.globalAlpha=1;
  const pts=sites.map(s=>({code:s.code,x:sx(s.lon),y:sy(s.lat),verdict:s.verdict,dc:s.dc}));
  const {groups,of}=NetMap.clusterPoints(pts);
  const marks=[], reserve=(x,y,r)=>marks.push({x0:x-r,y0:y-r,x1:x+r,y1:y+r});
  for(const cl of groups){
    ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(cl.x,cl.y,cl.r+3,0,Math.PI*2); ctx.fill();
    let a0=-Math.PI/2;
    for(const [vd,k] of [["Critical",cl.crit],["Warning",cl.warn],["Healthy",cl.healthy],["Not monitored",cl.other]]){
      if(!k) continue;
      const a1=a0+(k/cl.n)*Math.PI*2;
      ctx.strokeStyle=col[vd]; ctx.lineWidth=3.2;
      ctx.beginPath(); ctx.arc(cl.x,cl.y,cl.r,a0,a1); ctx.stroke(); a0=a1;
    }
    ctx.fillStyle=ink; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.font=\`600 \${cl.n>=100?9.5:10.5}px ui-monospace, monospace\`;
    ctx.fillText(String(cl.n),cl.x,cl.y+0.5); ctx.textAlign="start";
    reserve(cl.x,cl.y,cl.r+4);
  }
  const loose=pts.filter(p=>!of.has(p.code));
  for(const p of loose){
    const isBad=p.verdict==="Critical"||p.verdict==="Warning", r=isBad?3.4:2.4;
    ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(p.x,p.y,r+2.4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=col[p.verdict]; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill();
    reserve(p.x,p.y,r+2.4);
  }
  const byCode=new Map(sites.map(s=>[s.code,s]));
  const measure=(t,dc)=>{ctx.font=dc?"600 12px sans-serif":"500 11px ui-monospace, monospace";return ctx.measureText(t).width;};
  const chosen=NetMap.placeLabels(loose.map(p=>({x:p.x,y:p.y,name:byCode.get(p.code).label,code:p.code,dc:false})),marks,measure);
  ctx.textBaseline="middle";
  for(const l of chosen.placed){
    ctx.font="500 11px ui-monospace, monospace";
    ctx.lineWidth=3.5; ctx.strokeStyle=halo; ctx.fillStyle=ink;
    ctx.strokeText(l.text,l.x+10,l.y); ctx.fillText(l.text,l.x+10,l.y);
  }
  const f=NetMap.frameFill(sites,W,H,INS);
  document.getElementById("facts").innerHTML =
    \`<b>\${sites.length}</b> sites · <b>\${groups.length}</b> agrupamentos · <b>\${chosen.placed.length}</b> nomes escritos · \`+
    \`o estate ocupa <b>\${(100*f.across).toFixed(0)}%</b> da largura e <b>\${(100*f.down).toFixed(0)}%</b> da altura do quadro entre os painéis\`;
}

// ---- the panels, with the app's own stylesheet ----
const regions=[...new Set(sites.map(s=>s.region))]
  .map(r=>({r,list:sites.filter(s=>s.region===r)}))
  .sort((a,b)=>b.list.filter(i=>i.verdict==="Critical").length/b.list.length - a.list.filter(i=>i.verdict==="Critical").length/a.list.length);
const widest=Math.max(...regions.map(g=>g.list.length));
const alerting=regions.filter(g=>g.list.some(i=>i.verdict==="Critical"||i.verdict==="Warning"));
const shown=[...alerting,...regions.filter(g=>!alerting.includes(g)).slice(0,Math.max(0,8-alerting.length))];
const hidden=regions.length-shown.length;
const R=44,C=2*Math.PI*R;
function ring(){
  const order=[["Critical",sites.filter(s=>s.verdict==="Critical").length],["Healthy",sites.filter(s=>s.verdict==="Healthy").length],["Not monitored",sites.filter(s=>s.verdict==="Not monitored").length]];
  let off=0,out="";
  for(const [vd,k] of order){ if(!k) continue;
    const ln=(k/sites.length)*C;
    out+=\`<circle cx="60" cy="60" r="\${R}" fill="none" stroke="\${COL[vd]}" stroke-width="12" stroke-dasharray="\${Math.max(ln-1.5,1).toFixed(2)} \${C.toFixed(2)}" stroke-dashoffset="\${(-off).toFixed(2)}" transform="rotate(-90 60 60)"/>\`;
    off+=ln; }
  return out;
}
document.getElementById("pills").innerHTML =
  \`<span class="lm-pill lm-pill--live">Live 16:50 UTC</span>\`+
  \`<span class="lm-pill">\${sites.length} sites · \${regions.length} regions · 2 data centers · 370 devices</span>\`+
  \`<span class="lm-pill lm-pill--note">\${sites.length} of \${sites.length} sites on the map · see all</span>\`+
  \`<span class="lm-pill lm-pill--note">8 connections drawn of \${sites.length} sites · no neighbour reported</span>\`;
document.getElementById("left").innerHTML =
  \`<h2 class="lm-h">\${bad} sites degraded · no cause named</h2>
   <div class="lm-stats"><span><b>0</b>sites offline</span><span><b style="color:var(--lm-bad)">40%</b>of usual sessions</span></div>
   <button type="button" class="lm-cause lm-cause--all is-on"><b><span class="lm-cause__title">Whole network</span><em>\${bad}/\${sites.length}</em></b></button>
   <p class="lm-gap">117 open alerts could not be placed on this inventory, so they are not listed above.
     Tag the monitor with the circuit tags, or point it at the address of a device the SNMP extensions poll.</p>\`;
document.getElementById("right").innerHTML =
  \`<h2 class="lm-title"><span>Whole network</span></h2>
   <div class="lm-netstatus">
     <svg viewBox="0 0 120 120" class="lm-ring">
       <circle cx="60" cy="60" r="44" fill="none" stroke="var(--lm-line)" stroke-width="12"/>\${ring()}
       <text x="60" y="58" text-anchor="middle" font-size="24" font-weight="700" fill="var(--lm-ink)">\${bad}</text>
       <text x="60" y="76" text-anchor="middle" font-size="12" fill="var(--lm-muted)">of \${sites.length}</text></svg>
     <div class="lm-regions">
       <div class="lm-region lm-region--head"><span>Region</span><span>Sites by status</span><b>Bad</b></div>
       \${shown.map(({r,list})=>{
         const b=list.filter(i=>i.verdict==="Critical"||i.verdict==="Warning").length;
         const h=list.filter(i=>i.verdict==="Healthy").length, nm=list.length-b-h;
         const seg=[["Critical",b],["Healthy",h],["Not monitored",nm]].filter(([,v])=>v)
           .map(([vd,v])=>\`<i style="flex:\${v};background:\${COL[vd]}"></i>\`).join("");
         return \`<button type="button" class="lm-region"><span class="lm-region__name" title="\${r}">\${r}</span>
           <span class="lm-region__bar" style="width:\${(list.length/widest*100).toFixed(1)}%">\${seg}</span><b>\${b}</b></button>\`;
       }).join("")}
       \${hidden?\`<button type="button" class="lm-region lm-region--more"><span class="lm-region__name">\${hidden} more regions</span>
         <span class="lm-region__rest">nothing alerting in them</span><b>0</b></button>\`:""}
     </div>
   </div>
   <section class="sus is-calm" style="margin-top:14px">
     <div class="sus__head"><span class="sus__eyebrow">Fault domain · the whole environment</span><span class="sus__mark">Nothing to isolate</span></div>
     <p style="margin:8px 0 0">A suspeita e as evidências saem dos alertas e sessões do ambiente; este cenário não os tem.</p>
   </section>\`;

drawMap();
document.getElementById("swap").addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  document.getElementById("swap").textContent = dark ? "tema escuro" : "tema claro";
  drawMap();
});
</script></div></div></body></html>`;

process.stdout.write(page);
