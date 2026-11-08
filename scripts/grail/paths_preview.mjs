// The Paths list rendered at the width it actually gets, because only rendering knows.
//
// The list lives in the map's left panel, which is 338px. Two site names and a figure do not fit
// on one line of that, and nothing in node can say so: the suite can check that a row is built
// and still be looking at a panel that scrolls sideways under rows nobody can reach the end of.
// This writes the real `theme.css` around the real row markup so the geometry can be measured in
// a browser.
//
//   node scripts/grail/paths_preview.mjs    → scripts/grail/out/paths.html
//
// Then, in the browser, what the measurement is for:
//   · the panel must not scroll sideways
//   · no name may be truncated — the far end is what identifies a path
//   · the two lines of a row must not overlap
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const css = readFileSync(new URL("../../app/ui/app/styles/theme.css", import.meta.url).pathname, "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* invented names, long enough to be the hard case: a postal-address estate writes names like
   these, and the short ones are what used to fit while the long ones silently did not */
const ROWS = [
  { a: "Fairview Depot, NC", b: "DC-East", verdict: "Critical", val: "1.8 Gbit/s" },
  { a: "Ashland Distribution Center", b: "DC-East", verdict: "Warning", val: "942 Mbit/s" },
  { a: "Clayton", b: "DC-West", verdict: "Warning", val: "610 Mbit/s" },
  { a: "Milford Regional Warehouse 12B", b: "DC-East", verdict: "Healthy", val: "2.4 Gbit/s" },
  { a: "Riverton", b: "DC-West", verdict: "Healthy", val: "1.1 Gbit/s" },
  { a: "Oakdale", b: "Bristol", verdict: "Healthy", val: "" },
];

const row = (r, i) => {
  const bad = r.verdict === "Critical" || r.verdict === "Warning";
  const col = r.verdict === "Critical" ? "var(--lm-bad)" : r.verdict === "Warning" ? "var(--lm-warn)" : null;
  const mark = bad ? ` class="rs-alert" style="--c:${col}"` : "";
  const word = bad ? `<small style="color:${col}">${r.verdict}</small>` : "";
  const num = r.val ? esc(r.val) : "<small>not measured</small>";
  return `      <li><button type="button" class="rs-row${i === 1 ? " is-on" : ""}">`
    + `<span class="rs-bar" style="width:${Math.max(6, 100 - i * 15)}%"></span>`
    + `<span class="rs-path"><b${mark}>${esc(r.a)}</b><i>⇄</i><b>${esc(r.b)}</b></span>`
    + `<span class="rs-val">${num}${word}</span></button></li>`;
};

const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Paths panel</title>
<style>${css}</style>
<style>
  body { margin: 0; background: var(--lm-map-ground, #111); font-family: var(--lm-sans, system-ui); }
  .lm-stage { position: relative; height: 820px; }
</style></head><body>
<div class="lm-stage is-wide" id="stage">
  <aside class="lm-panel lm-left" id="panel" aria-label="WAN paths">
    <span class="vz-seg lm-lefttabs" role="group" aria-label="List">
      <button type="button">Causes</button><button type="button">Sites</button>
      <button type="button" class="is-on" aria-pressed="true">Paths</button>
    </span>
    <div class="lm-paths">
      <h2 class="lm-h">3 of 6 paths alerting</h2>
      <p class="lm-paths__why">Worst first, then by what it carries. Picking a path puts it on the
        map on its own &mdash; the map draws at most three curves at a time, because past that they
        converge on the hub and stop being lines a reader can follow.</p>
      <ol class="rs-list">
${ROWS.map(row).join("\n")}
      </ol>
    </div>
  </aside>
</div>
</body></html>`;

mkdirSync(new URL("out/", import.meta.url).pathname, { recursive: true });
const at = new URL("out/paths.html", import.meta.url).pathname;
writeFileSync(at, doc);
console.log(at);
