// Pulls a few real rows per app query from GRU (read-only) to pin the exact Grail record shapes.
import { QUERIES } from "./out/queries.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
for (const [name, q] of Object.entries(QUERIES)) {
  try {
    const out = execFileSync("dtctl", ["--context", "gru", "query", q.query, "-o", "json", "--plain", "--chunk-size", "0"], { encoding: "utf8", maxBuffer: 512e6 });
    let j = JSON.parse(out); j = j.result ?? j; const recs = Array.isArray(j) ? j : j.records ?? [];
    writeFileSync(`out/gru-samples/${name}.json`, JSON.stringify({ total: recs.length, rows: recs.slice(0, 3) }, null, 1));
    console.log(name, recs.length);
  } catch (e) { console.log(name, "ERR", String(e.stderr ?? e).slice(0, 200)); }
}
