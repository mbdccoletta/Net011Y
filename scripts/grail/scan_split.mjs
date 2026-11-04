// What a Live map load scans, and what it no longer scans.
//
// Every read the app can make is either free or billed by the bytes Grail scans for it. This asks
// the environment for the billed ones and splits them by the rule the app itself applies: a read
// the map asks for, or a read that waits for the page that draws it (`readWanted`, queries.ts).
//
// The figures come from Grail's own metadata, never from the query text — a `limit` says nothing
// about what was scanned to reach it.
//
//   DT_CONTEXT=<dtctl-context> node scan_split.mjs
//   node scan_split.mjs --views traffic     # what opening Traffic adds
import { execFileSync } from "node:child_process";
import { QUERIES, readWanted } from "./out/queries.mjs";

const ctx = process.env.DT_CONTEXT;
if (!ctx) { console.error("set DT_CONTEXT to a dtctl context"); process.exit(2); }
const viewArg = process.argv.indexOf("--views");
const views = viewArg > 0 ? process.argv[viewArg + 1].split(",") : ["map"];

// A read is billed when it scans a Grail table: logs, events, sessions, spans, or a named bucket.
// Metrics, Smartscape and Davis problems are included in the licence however often they run.
const billed = (q) => /fetch\s+(logs|events|user\.sessions|spans|bizevents)/.test(q.query ?? "") || /bucket:\{/.test(q.query ?? "");

const measure = (q) => {
  const t0 = Date.now();
  try {
    const out = execFileSync("dtctl", ["query", q.query, "--context", ctx, "-o", "json",
      "--max-result-records", String(q.maxResultRecords ?? 1000), "--metadata"],
      { encoding: "utf8", maxBuffer: 2e9, stdio: ["ignore", "pipe", "pipe"] });
    const j = JSON.parse(out.slice(out.indexOf("{")));
    const bytes = j.metadata?.grail?.scannedBytes ?? j.metadata?.scannedBytes ?? 0;
    return { gb: bytes / 1e9, rows: (j.records ?? []).length, s: (Date.now() - t0) / 1000 };
  } catch (e) { return { err: String(e.stderr ?? e).trim().split("\n")[0].slice(0, 120) }; }
};

const names = Object.keys(QUERIES).filter((n) => billed(QUERIES[n]));
const rows = [];
for (const n of names) {
  const r = measure(QUERIES[n]);
  rows.push({ name: n, asked: readWanted(QUERIES[n], views), metricForm: !!QUERIES[n].metric, ...r });
  const mark = r.err ? "err" : `${r.gb.toFixed(2)} GB`;
  console.error(`${rows.at(-1).asked ? "asked " : "waits "} ${n.padEnd(18)} ${mark}`);
}

const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.gb ?? 0), 0);
const report = {
  views,
  reads: { all: Object.keys(QUERIES).length, billed: names.length, asked: rows.filter((r) => r.asked).length },
  gb: { asked: +sum((r) => r.asked).toFixed(2), waiting: +sum((r) => !r.asked).toFixed(2), total: +sum(() => true).toFixed(2) },
  waiting: rows.filter((r) => !r.asked).map((r) => `${r.name} ${r.gb?.toFixed(2)} GB`),
  heaviest: [...rows].filter((r) => r.gb).sort((a, b) => b.gb - a.gb).slice(0, 5).map((r) => `${r.name} ${r.gb.toFixed(2)} GB`),
  errors: rows.filter((r) => r.err).map((r) => `${r.name}: ${r.err}`),
};
report.gb.usd = +(report.gb.total / 1.073741824 * 0.0035).toFixed(3);
console.log(JSON.stringify(report, null, 1));
