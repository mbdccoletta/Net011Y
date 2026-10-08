// Why does the app see no NetFlow in an environment whose Logs app is full of flow records?
// Asks the environment what shape its flow logs actually have, instead of guessing: which scope and
// which pipeline source carry them, which attributes each record holds, and whether the app's own
// filter matches a single row. Read-only, and every query is windowed to minutes so it costs little.
//
//   node scripts/grail/netflow_probe.mjs            # the environment the local dev server serves
//   node scripts/grail/netflow_probe.mjs dtctl:<ctx>
import { execFileSync } from "node:child_process";

const via = process.argv[2] ?? "proxy";
const BASE = "http://localhost:3000/platform/storage/query/v1";

async function run(query, max = 50) {
  if (via.startsWith("dtctl:")) {
    const out = execFileSync("dtctl", ["query", query, "--context", via.slice(6), "-o", "json", "--plain", "--chunk-size", "0"],
      { encoding: "utf8", maxBuffer: 2e9, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out.slice(out.indexOf("{"))).records ?? [];
  }
  let j = await (await fetch(`${BASE}/query:execute`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, maxResultRecords: max, requestTimeoutMilliseconds: 60000 }) })).json();
  for (let i = 0; i < 200 && !j.result && j.requestToken; i++) {
    await new Promise((r) => setTimeout(r, 800));
    j = await (await fetch(`${BASE}/query:poll?request-token=${encodeURIComponent(j.requestToken)}`)).json();
  }
  if (!j.result) throw new Error(JSON.stringify(j).slice(0, 300));
  return j.result.records;
}

const show = (title, rows) => {
  console.log(`\n── ${title} — ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  for (const r of rows.slice(0, 25)) console.log("   " + JSON.stringify(r));
};

// 1. where the volume is: every scope and pipeline source in the last few minutes
show("log sources, last 10 min", await run(
  'fetch logs, from:now()-10m | summarize n = count(), by:{scope = otel.scope.name, src = coalesce(dt.openpipeline.source, custom.openpipeline.source), logsource = log.source, type = event.type} | sort n desc | limit 25'));

// 2. the app's own filter, unchanged: does anything match it at all?
show("the app's filter: otel.scope.name == \"otelcol/netflowreceiver\"", await run(
  'fetch logs, from:now()-10m | filter otel.scope.name == "otelcol/netflowreceiver" | summarize n = count(), exporters = countDistinct(flow.sampler_address)'));

// 3. records that look like flows whatever carries them
show("flow-shaped content (src= and dst=), by source", await run(
  'fetch logs, from:now()-10m | filter contains(content, "src=") and contains(content, "dst=") | summarize n = count(), by:{scope = otel.scope.name, src = coalesce(dt.openpipeline.source, custom.openpipeline.source), logsource = log.source} | sort n desc | limit 10'));

// 4. one whole record, every attribute: the field names are the answer
const one = await run('fetch logs, from:now()-10m | filter contains(content, "src=") and contains(content, "dst=") | limit 1', 1);
console.log("\n── one flow-shaped record, every field");
for (const [k, v] of Object.entries(one[0] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`   ${k.padEnd(38)} ${JSON.stringify(v)?.slice(0, 120)}`);
}

// 5. whichever of the fields the app reads exist under some name
show("which flow attributes exist", await run(
  'fetch logs, from:now()-10m | filter contains(content, "src=") and contains(content, "dst=") | limit 2000'
  + ' | summarize sampler = countIf(isNotNull(flow.sampler_address)), srcAddr = countIf(isNotNull(source.address)),'
  + ' dstAddr = countIf(isNotNull(destination.address)), ioBytes = countIf(isNotNull(flow.io.bytes)),'
  + ' transport = countIf(isNotNull(network.transport)), dstPort = countIf(isNotNull(destination.port)),'
  + ' inIf = countIf(isNotNull(flow.in_if)), netSrc = countIf(isNotNull(net.peer.ip)), n = count()'));
