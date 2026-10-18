// Does the hour average hide the congestion?
//
// Three questions a capacity page cannot answer from a trend, asked of a real environment:
//   1. how far above its own mean does an interface's busy hour sit — i.e. how much does
//      planning on the mean understate what the link actually has to carry
//   2. do the busy hours concentrate on particular hours of the day, or are they scattered
//   3. where do discards happen: at high utilisation, where capacity would explain them, or at
//      low utilisation, where only a burst shorter than the bucket can
//
//   node scripts/grail/burst_probe.mjs gru
import { execFileSync } from "node:child_process";
const ctx = process.argv[2] || "gru";
const DAYS = 14;

const run = (q) => {
  const out = execFileSync("dtctl", ["query", q, "--context", ctx, "-o", "json", "--plain", "--chunk-size", "0"],
    { encoding: "utf8", maxBuffer: 1 << 28 });
  const j = JSON.parse(out);
  return j.result?.records ?? j.records ?? j.result ?? [];
};
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (xs) => (xs.length ? pct(xs, 0.5) : null);

const IN = "com.dynatrace.extension.network_device.if.bytes_in.count";
const OUT = "com.dynatrace.extension.network_device.if.bytes_out.count";
const DISC = "com.dynatrace.extension.network_device.if.in.discards.count";
// if.speed is a dimension on these series, not a metric: asking for avg() of it returned
// nothing at all rather than failing, which is the quietest way a query can be wrong
const BY = "`dt.smartscape.ext_network_interface`, `if.name`, `if.speed`";

console.log(`\n══ ${ctx} · ${DAYS} d of hourly buckets ══`);

let rows;
try {
  rows = run(`timeseries i = sum(\`${IN}\`), o = sum(\`${OUT}\`), d = sum(\`${DISC}\`),`
    + ` by:{${BY}}, from:now()-${DAYS}d, interval:1h | limit 4000`);
} catch (e) { console.log("query failed:", String(e.message).slice(0, 180)); process.exit(1); }
console.log(`  ${rows.length} interfaces returned`);

const ratios = [], busyHour = [], hiDisc = [], loDisc = [];
let impossible = 0, sane = 0;
let withSpeed = 0, withDisc = 0;
const start = Date.now() - DAYS * 24 * 3600 * 1000;

for (const r of rows) {
  const sp = Number(r["if.speed"]);
  if (!(sp > 0)) continue;
  withSpeed++;
  const bits = sp * 1e6 * 3600;
  // A missing bucket is not a quiet hour. `Number(v) || 0` turned every gap into a zero, so a
  // day with no collection contributed a peak of zero and dragged the median of daily maxima
  // below the mean — which is arithmetically impossible and was the tell.
  const util = (r.i || []).map((v, k) => {
    const o = (r.o || [])[k];
    if (v == null && o == null) return NaN;
    const b = (Number(v) || 0) + (Number(o) || 0);
    return bits ? (b * 8 / bits) * 100 : NaN;
  });
  const live = util.filter((v) => Number.isFinite(v));
  if (live.some((v) => v > 100)) impossible++; else sane++;
  if (live.length < 48) continue;
  const mean = live.reduce((a, b) => a + b, 0) / live.length;
  // the busy hour of a typical day: the median of the daily maxima. A peak lasting one hour a
  // day is 4% of the hours, so a p95 over hours sits below it — that first version understated
  // the very thing it was meant to measure.
  const peaks = [];
  for (let k = 0; k < util.length; k += 24) {
    const day = util.slice(k, k + 24).filter((v) => Number.isFinite(v));
    if (day.length >= 12) peaks.push(Math.max(...day));   // only days that were actually collected
  }
  const busy = peaks.length ? med(peaks) : pct(live, 0.95);
  if (mean > 0.01 && busy != null) ratios.push(busy / mean);
  if (false) {
    console.log(`    sample · ${String(r["if.name"]).slice(0, 22).padEnd(23)}`
      + ` mean ${mean.toFixed(2)}  busyDay ${busy.toFixed(2)}  p95h ${pct(live, .95).toFixed(2)}`
      + `  max ${Math.max(...live).toFixed(2)}  days ${peaks.length}  hours ${live.length}`);
  }
  // which hour of the day the maximum fell in
  const peakAt = util.indexOf(Math.max(...util));
  if (peakAt >= 0) busyHour.push(new Date(start + peakAt * 3600 * 1000).getUTCHours());
  // discards, against the utilisation of the same bucket
  const dd = r.d || [];
  if (dd.some((v) => Number(v) > 0)) {
    withDisc++;
    dd.forEach((v, k) => {
      if (!(Number(v) > 0)) return;
      (util[k] >= 50 ? hiDisc : loDisc).push(util[k] ?? 0);
    });
  }
}

console.log(`\n0 · sanity: ${impossible} interfaces show an hour over 100% of their line rate, ${sane} do not`);
console.log(`\n1 · busy hour against the mean   (${ratios.length} interfaces with a line rate and a fortnight of hours)`);
if (ratios.length) {
  console.log(`    busy hour ÷ mean hour   median ${med(ratios).toFixed(2)}×   ·   upper quartile ${pct(ratios, 0.75).toFixed(2)}×`
    + `   ·   worst ${Math.max(...ratios).toFixed(1)}×`);
  console.log(`    planning on the mean understates the busy hour by that factor`);
}

console.log(`\n2 · when the busy hour falls        (UTC hour of each interface's own peak)`);
const hist = Array.from({ length: 24 }, (_, h) => busyHour.filter((x) => x === h).length);
const top = hist.indexOf(Math.max(...hist));
hist.forEach((n, h) => { if (n) console.log(`    ${String(h).padStart(2, "0")}h ${"█".repeat(Math.round((n / Math.max(...hist)) * 40))} ${n}`); });
console.log(`    the commonest busy hour is ${String(top).padStart(2, "0")}h UTC, holding ${Math.round(hist[top] / busyHour.length * 100)}% of the peaks`);

console.log(`\n3 · where discards happen          (${withDisc} interfaces discarded in some hour)`);
const all = hiDisc.length + loDisc.length;
if (all) {
  console.log(`    hours with a discard, at or over 50% of the line rate   ${hiDisc.length} (${Math.round(hiDisc.length / all * 100)}%)`);
  console.log(`    hours with a discard, under 50%                         ${loDisc.length} (${Math.round(loDisc.length / all * 100)}%)`);
  if (loDisc.length) console.log(`    median utilisation of a discarding hour under 50%:      ${med(loDisc).toFixed(2)}%`);
  console.log(`    a discard at low utilisation cannot be explained by the hour average — only by`);
  console.log(`    something shorter than the bucket, which is the burst the average cannot see`);
} else console.log(`    no discards in the window`);
console.log(`\n    ${withSpeed} of ${rows.length} interfaces publish a line rate\n`);

// ── 4 · the ceiling each interface sets for itself ──────────────────────────────────────
// The line rate is the limit its owner stated, but it is not the limit the interface behaves
// as if it had. If a port has discarded in some hours and not in others, the utilisation at
// which discarding starts is a ceiling the port itself demonstrated. Planning against the line
// rate on a port that drops at a third of it is planning against the wrong number.
const own = [];
for (const r of rows) {
  const sp = Number(r["if.speed"]);
  if (!(sp > 0)) continue;
  const bits = sp * 1e6 * 3600;
  const util = (r.i || []).map((v, k) => {
    const b = (Number(v) || 0) + (Number((r.o || [])[k]) || 0);
    return bits ? (b * 8 / bits) * 100 : 0;
  });
  const dd = r.d || [];
  const dropAt = [], clean = [];
  util.forEach((u, k) => {
    if (!Number.isFinite(u) || u <= 0) return;
    (Number(dd[k]) > 0 ? dropAt : clean).push(u);
  });
  if (dropAt.length < 3 || clean.length < 24) continue;
  // the lowest utilisation at which it has been seen to discard, robust to one odd hour
  const ceiling = pct(dropAt, 0.10);
  const busy = pct(util.filter((u) => u > 0), 0.95);
  own.push({ name: r["if.name"], ceiling, busy, over: busy >= ceiling });
}
console.log(`4 · the ceiling each port sets for itself   (${own.length} ports that both discard and run clean)`);
if (own.length) {
  const overs = own.filter((x) => x.over);
  console.log(`    median utilisation at which a port first discards        ${med(own.map((x) => x.ceiling)).toFixed(1)}%`);
  console.log(`    median busy hour of the same ports                       ${med(own.map((x) => x.busy)).toFixed(1)}%`);
  console.log(`    ports whose busy hour is already at or past that point   ${overs.length} of ${own.length}`
    + ` (${Math.round(overs.length / own.length * 100)}%)`);
  console.log(`\n    against the line rate these ports have room to spare; against the ceiling they`);
  console.log(`    themselves demonstrated, ${overs.length} of them are already over it\n`);
}

// ── 5 · is a discard an event, or a condition? ─────────────────────────────────────────
// It matters which. A port that discards in a few of its hours is congested in those hours,
// and the burst is the explanation. A port that discards in nearly all of them is not
// congested at all — it is broken, or misconfigured, and no capacity forecast will ever say so.
const share = [];
for (const r of rows) {
  const dd = r.d || [], ii = r.i || [];
  const live = ii.map((v, k) => (Number.isFinite(Number(v)) ? k : -1)).filter((k) => k >= 0);
  if (live.length < 48) continue;
  const bad = live.filter((k) => Number(dd[k]) > 0).length;
  if (bad > 0) share.push(bad / live.length);
}
console.log(`5 · a discard: event or condition?   (${share.length} ports discarded at all)`);
if (share.length) {
  const band = (lo, hi) => share.filter((x) => x >= lo && x < hi).length;
  const rows2 = [["under 5% of its hours", band(0, .05)], ["5–25%", band(.05, .25)],
    ["25–75%", band(.25, .75)], ["75–99%", band(.75, .99)], ["99% or more", band(.99, 1.01)]];
  rows2.forEach(([k, n]) => console.log(`    ${k.padEnd(24)} ${String(n).padStart(4)}`
    + ` ${"█".repeat(Math.round(n / share.length * 40))}`));
  console.log(`    median share of hours with a discard: ${(med(share) * 100).toFixed(0)}%\n`);
}

// ── 6 · do the discarding ports even publish a line rate? ─────────────────────────────
let both = 0, discNoSpeed = 0, speedNoTraffic = 0;
for (const r of rows) {
  const sp = Number(r["if.speed"]);
  const anyDisc = (r.d || []).some((v) => Number(v) > 0);
  const anyTraffic = (r.i || []).some((v) => Number(v) > 0);
  if (anyDisc && !(sp > 0)) discNoSpeed++;
  if (anyDisc && sp > 0) both++;
  if (sp > 0 && !anyTraffic) speedNoTraffic++;
}
console.log(`6 · overlap`);
console.log(`    ports that discard AND publish a line rate   ${both}`);
console.log(`    ports that discard with no line rate         ${discNoSpeed}`);
console.log(`    ports with a line rate and no traffic at all  ${speedNoTraffic}\n`);
