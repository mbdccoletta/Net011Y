// Does the estate actually support a capacity forecast, and for how much of itself?
//
// The forecast page rests on three gates, and every one of them is a claim about the data rather
// than about the drawing: a subject needs enough daily record, a slope whose own confidence
// interval excludes zero, and a crossing inside the horizon. This asks a real environment how many
// subjects survive each gate, so the page can be designed against the answer instead of a guess.
//
//   node scripts/grail/forecast_probe.mjs gru
//   node scripts/grail/forecast_probe.mjs my-env
import { execFileSync } from "node:child_process";

const ctx = process.argv[2] ?? "gru";
const DAYS = 30, HORIZON = 180, MIN_POINTS = 8;

const run = (query) => {
  const out = execFileSync("dtctl", ["query", query, "--context", ctx, "-o", "json", "--plain", "--chunk-size", "0"],
    { encoding: "utf8", maxBuffer: 2e9, stdio: ["ignore", "pipe", "pipe"] });
  const j = JSON.parse(out.slice(out.indexOf("{")));
  if (j.ok === false) throw new Error(j.error?.message ?? out.slice(0, 200));
  return j.records ?? [];
};

/** least squares, and the standard error of the slope that decides whether it is a slope at all */
function fit(ys) {
  const pts = ys.map((y, i) => [i, y]).filter(([, y]) => y != null && Number.isFinite(y));
  if (pts.length < MIN_POINTS) return { why: "too little record", n: pts.length };
  const n = pts.length, sx = pts.reduce((a, [x]) => a + x, 0), sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0), sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const den = n * sxx - sx * sx;
  if (!den) return { why: "no spread", n };
  const slope = (n * sxy - sx * sy) / den, b = (sy - slope * sx) / n;
  const resid = pts.reduce((a, [x, y]) => a + (y - (b + slope * x)) ** 2, 0);
  const se = Math.sqrt(resid / Math.max(1, n - 2)) / Math.sqrt(sxx - (sx * sx) / n);
  const last = pts[pts.length - 1][0], at0 = b + slope * last;
  // gate 2: the slope has to be positive with confidence, not merely positive
  if (slope - 1.96 * se <= 0) return { why: slope <= 0 ? "flat or falling" : "rise is inside the noise", n, slope, se };
  const cross = (s) => (100 - at0) / s;
  const mid = cross(slope), lo = cross(slope + 1.96 * se), hi = cross(slope - 1.96 * se);
  if (!(mid > 0)) return { why: "already over the limit", n, now: at0 };
  if (mid > HORIZON) return { why: "crosses beyond the horizon", n, mid: Math.round(mid) };
  return { ok: true, n, now: at0, mid: Math.round(mid), lo: Math.round(Math.max(0, lo)), hi: Math.round(hi) };
}

const EXTS = [
  ["network_device", "com.dynatrace.extension.network_device.if.bytes_in.count"],
  ["cisco", "com.dynatrace.extension.snmp-generic-cisco-device.if.in.octets.count"],
  ["juniper", "com.dynatrace.extension.juniper.generic.if.in.octets.count"],
];

console.log(`\n══ ${ctx} · interfaces ══`);
const all = [];
for (const [label, key] of EXTS) {
  let rows;
  try {
    rows = run(`timeseries v = sum(\`${key}\`), by:{\`dt.entity.network:interface\`, \`if.speed\`, \`sys.name\`, \`if.name\`},`
      + ` from:now()-${DAYS}d, interval:1d | limit 4000`);
  } catch (e) { console.log(`  ${label.padEnd(16)} query failed: ${String(e.message).slice(0, 70)}`); continue; }
  const withSpeed = rows.filter((r) => Number(r["if.speed"]) > 0);
  console.log(`  ${label.padEnd(16)} ${String(rows.length).padStart(5)} series · ${String(withSpeed.length).padStart(5)} with a line rate`
    + ` (${rows.length ? Math.round(withSpeed.length / rows.length * 100) : 0}%)`);
  withSpeed.forEach((r) => {
    const speedBps = Number(r["if.speed"]) * 1e6;
    const util = r.v.map((bytes) => (bytes == null ? null : (bytes * 8 / 86400) / speedBps * 100));
    all.push({ dev: r["sys.name"], name: r["if.name"], util, f: fit(util) });
  });
}

const tally = {};
all.forEach((s) => { const k = s.f.ok ? "a date" : s.f.why; tally[k] = (tally[k] ?? 0) + 1; });
console.log(`\n  of ${all.length} interfaces that have a line rate at all:`);
Object.entries(tally).sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log(`    ${String(n).padStart(5)}  ${k}`));

const dated = all.filter((s) => s.f.ok).sort((a, b) => a.f.mid - b.f.mid);
if (dated.length) {
  console.log(`\n  the soonest:`);
  dated.slice(0, 8).forEach((s) => console.log(
    `    ${String(s.f.mid).padStart(4)}d (${s.f.lo}–${s.f.hi})  now ${s.f.now.toFixed(1)}%  ${s.f.n} days of record  ${s.dev} ${s.name}`));
}
const depth = all.map((s) => s.util.filter((v) => v != null).length);
if (depth.length) console.log(`\n  daily record: median ${depth.sort((a, b) => a - b)[depth.length >> 1]} points, max ${Math.max(...depth)}`);
