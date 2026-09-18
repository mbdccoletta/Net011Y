import { QUERIES } from "./out/queries.mjs";
import { execFileSync } from "node:child_process";
import { buildRealModel, evaluateNeeds, allSites, buildCauses } from "./out/app-model.mjs";
const R = {};
for (const [n, q] of Object.entries(QUERIES)) {
  const j = JSON.parse(execFileSync("dtctl", ["--context", process.env.DT_CONTEXT ?? "default", "query", q.query, "-o", "json", "--plain", "--chunk-size", "0"], { encoding: "utf8", maxBuffer: 512e6 }));
  R[n] = (j.result ?? j).records ?? j;
}
for (const [n, rows] of Object.entries(R)) if (!Array.isArray(rows)) throw new Error(`query ${n} did not return records: ${JSON.stringify(rows).slice(0, 200)}`);
const m = buildRealModel(R, process.env.DT_CONTEXT ?? "live");
const needs = evaluateNeeds(Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.length])), m, "live");
const causes = buildCauses(m, allSites(m));
// invariants that must hold against the live environment, whatever it happens to contain today
const checks = [];
const ok = (name, cond, detail) => checks.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const open = (x) => (x.problems ?? []).filter((p) => !p.muted);
const alerted = [...m.devices, ...(m.circuits ?? [])].filter((x) => open(x).length);
ok("every alert carries an id and a name", alerted.every((x) => open(x).every((p) => p.eventId && p.name)), `${alerted.length} elements with alerts`);
ok("nothing is critical or warning without an open alert",
  m.devices.every((d) => !["Critical", "Warning"].includes(d.verdict) || open(d).length),
  m.devices.filter((d) => ["Critical", "Warning"].includes(d.verdict) && !open(d).length).map((d) => d.name).join(", ") || "none");
ok("every cause has a title and a level", causes.every((c) => c.title && c.verdict), `${causes.length} causes`);
ok("alerts reported as a data source", needs.alerts.status === (alerted.length || (m.unmappedAlerts ?? []).length ? "ok" : "missing"), `${needs.alerts.status} · ${needs.alerts.detail}`);
// truncation is silent in Grail: a query that fills its own cap may be hiding alerts or devices
// only for the queries that must be complete: the top-N lists are capped on purpose
const MUST_BE_COMPLETE = ["problems", "alerts", "devices", "interfaces", "icmp", "icmpNow", "cpu", "uptime"];
const capOf = (n) => Number((QUERIES[n].query.match(/limit (\d+)\s*$/) ?? [])[1] ?? QUERIES[n].maxResultRecords ?? Infinity);
const capped = MUST_BE_COMPLETE.filter((n) => (R[n]?.length ?? 0) >= capOf(n));
ok("no query hit its own row cap", capped.length === 0, capped.map((n) => `${n}=${R[n].length}`).join(", ") || "none at the cap");
console.log(checks.join("\n"));
console.log({ devices: m.devices.length, sites: Object.keys(m.sites), circuits: m.circuits.length, unreachable: m.devices.filter((d) => d.unreachableSince).map((d) => `${d.name} ${d.unreachableSince}`), causes: causes.map((c) => `${c.kind}: ${c.title} [${c.sites.length}] since ${c.since}`), wan: needs.wan.detail, sitesNeed: needs.sites.detail });
