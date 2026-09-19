// What the app delivers in one environment, and what is missing: runs every app query the way the app
// does (through the dev server proxy, or dtctl with a context), builds the model with the app's code and
// prints a scorecard per page. Read-only.
//   node scorecard.mjs proxy          # the environment the local dev server serves
//   node scorecard.mjs dtctl:<ctx>    # a dtctl context
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { QUERIES } from "./out/queries.mjs";
import { buildRealModel, evaluateNeeds, allSites, buildCauses, suspicionFor, environmentFindings, nextSteps, coverage } from "./out/app-model.mjs";

const via = process.argv[2] ?? "proxy";
const BASE = "http://localhost:3000/platform/storage/query/v1";
async function run(name, q) {
  const t0 = Date.now();
  try {
    if (via.startsWith("dtctl:")) {
      const out = execFileSync("dtctl", ["query", q.query, "--context", via.slice(6), "-o", "json", "--max-result-records", String(q.maxResultRecords ?? 1000), "--metadata"],
        { encoding: "utf8", maxBuffer: 2e9, stdio: ["ignore", "pipe", "pipe"] });
      const j = JSON.parse(out.slice(out.indexOf("{")));
      return { rows: j.records ?? [], gb: (j.metadata?.grail?.scannedBytes ?? 0) / 1e9, s: (Date.now() - t0) / 1000 };
    }
    let j = await (await fetch(`${BASE}/query:execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q.query, maxResultRecords: q.maxResultRecords ?? 1000, requestTimeoutMilliseconds: 60000 }) })).json();
    for (let i = 0; i < 200 && !j.result && j.requestToken; i++) { await new Promise((r) => setTimeout(r, 800)); j = await (await fetch(`${BASE}/query:poll?request-token=${encodeURIComponent(j.requestToken)}`)).json(); }
    if (!j.result) return { rows: null, err: JSON.stringify(j).slice(0, 160), gb: 0, s: 0 };
    return { rows: j.result.records, gb: (j.result.metadata?.grail?.scannedBytes ?? 0) / 1e9, s: (Date.now() - t0) / 1000 };
  } catch (e) { return { rows: null, err: String(e.stderr ?? e).slice(0, 160), gb: 0, s: 0 }; }
}

const R = {}, counts = {}, cost = {};
for (const [name, q] of Object.entries(QUERIES)) {
  const r = await run(name, q);
  R[name] = r.rows ?? []; counts[name] = r.rows ? r.rows.length : null; cost[name] = r.gb;
  if (r.err) console.error(`  ${name}: ${r.err}`);
}
const env = via === "proxy" ? "dev-server" : via.slice(6);
const m = buildRealModel(R, env);
const needs = evaluateNeeds(counts, m, "live");
const infos = allSites(m), causes = buildCauses(m, infos), sus = suspicionFor(m, { dropPct: 50 });
const n = (xs) => xs.length;
const devs = m.devices;
const card = {
  environment: env,
  logGbPerLoad: +Object.values(cost).reduce((a, b) => a + b, 0).toFixed(2),
  inventory: { devices: n(devs), extensionMonitored: n(devs.filter((d) => d.mode === "Extension")), discoveryOnly: n(devs.filter((d) => d.mode === "Discovery")), families: m.extensions },
  health: { withCpu: n(devs.filter((d) => d.cpuNow != null)), withMemory: n(devs.filter((d) => d.memNow != null)), withAvailability: n(devs.filter((d) => d.availPct != null)), portsWithTraffic: devs.reduce((a, d) => a + d.interfaces.filter((i) => i.in.length).length, 0), vlans: devs.reduce((a, d) => a + (d.vlans?.length ?? 0), 0) },
  sites: { sites: n(Object.keys(m.sites)), placedOnMap: n(Object.values(m.sites).filter((s) => s.lat != null)), approximate: n(Object.values(m.sites).filter((s) => s.approx)), withRegion: n(Object.values(m.sites).filter((s) => s.region)), fromTags: n(Object.values(m.sites).filter((s) => s.tags)), dataCenters: n(Object.values(m.sites).filter((s) => s.dc)) },
  wan: { circuits: n(m.circuits ?? []), icmpMonitors: counts.icmp ?? 0 },
  alerts: { openOnNetwork: n(devs.filter((d) => (d.problems ?? []).some((p) => !p.muted))), unplaced: n(m.unmappedAlerts ?? []), causes: n(causes) },
  topology: { links: n(m.links), betweenSites: n(m.links.filter((l) => { const a = devs.find((d) => d.name === l.a), b = devs.find((d) => d.name === l.b); return a && b && a.site !== b.site; })) },
  events: { syslogDevices: n(devs.filter((d) => d.syslog.ERROR + d.syslog.WARN + d.syslog.INFO > 0)), trapDevices: n(devs.filter((d) => d.traps > 0)) },
  traffic: { netflowExporters: m.flowMap?.sources.netflow?.exporters ?? 0, sitePairs: m.flowMap?.pairs.length ?? 0, oneAgent: m.appNet?.source ?? "none", paths: m.paths?.length ?? 0, pathsAtSites: n((m.paths ?? []).filter((p) => p.remoteSite)) },
  users: { sessions: m.users?.series?.length ? "yes" : "no", requests: m.users?.requests ? "yes" : "no", sessionsAtSites: m.users?.mapped ?? 0 },
  faultDomain: sus.kind,
  findings: environmentFindings(m).map((f) => f.kind),
  coverage: coverage(nextSteps(m, needs, { all: true })),
  steps: nextSteps(m, needs).map((s) => `${s.done ? "✓" : "○"} ${s.title} — ${s.unlocks}`),
  needs: Object.fromEntries(Object.entries(needs).map(([k, v]) => [k, `${v.status} · ${v.detail}`])),
};
console.log(JSON.stringify(card, null, 1));
writeFileSync(`out/scorecard-${env}.json`, JSON.stringify(card, null, 1));
