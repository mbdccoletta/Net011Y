// Runs the app's own queries against whatever environment the local dev server is serving (through its
// proxy on localhost:3000, which carries the dev server's authentication), builds the model with the
// app's code, and prints the fault-domain reading with the facts behind it. No credentials of its own.
import { QUERIES } from "./out/queries.mjs";
import { buildRealModel, suspicionFor } from "./out/app-model.mjs";
const BASE = "http://localhost:3000/platform/storage/query/v1";
async function dql(query, max) {
  let j = await (await fetch(`${BASE}/query:execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, maxResultRecords: max, requestTimeoutMilliseconds: 60000 }) })).json();
  for (let i = 0; i < 90 && !j.result && j.requestToken; i++) {
    await new Promise((r) => setTimeout(r, 800));
    j = await (await fetch(`${BASE}/query:poll?request-token=${encodeURIComponent(j.requestToken)}`)).json();
  }
  return j.result?.records ?? [];
}
const R = {};
for (const [name, q] of Object.entries(QUERIES)) {
  try { R[name] = await dql(q.query, q.maxResultRecords ?? 1000); } catch { R[name] = []; }
}
const model = buildRealModel(R, "via-dev-server");
const s = suspicionFor(model, { dropPct: 50 });
console.log(JSON.stringify({ reading: s.kind, headline: s.headline, network: s.network, outside: s.outside, facts: s.facts }, null, 1));
// the burst analysis, spelled out
const ts = (v) => Date.parse(v);
const net = [...model.devices.flatMap((d) => d.problems ?? []), ...(model.circuits ?? []).flatMap((c) => c.problems ?? [])].filter((p) => !p.muted).map((p) => ({ t: ts(p.start), name: p.name }));
const outside = (model.unmappedAlerts ?? []).filter((a) => !a.muted && a.scope && a.scope !== "network" && a.scope !== "environment").map((a) => ({ t: ts(a.start), name: a.name, scope: a.scope }));
const W = 30 * 60e3;
const rows = outside.map((o) => {
  const inW = net.filter((n) => n.t >= o.t - W && n.t <= o.t + 5 * 60e3).length;
  const before = net.filter((n) => n.t >= o.t - 6 * 3600e3 && n.t < o.t - W).length;
  const usual = before / ((6 * 3600e3 - W) / (W + 5 * 60e3));
  return { at: new Date(o.t).toISOString().slice(11, 16), outside: `${o.scope}: ${o.name}`.slice(0, 48), netInWindow: inW, usual: +usual.toFixed(1), burst: inW > 0 && inW >= Math.max(1, 3 * usual) };
}).sort((a, b) => a.at.localeCompare(b.at));
console.table(rows.filter((r) => r.burst));
console.log(`network alerts: ${net.length} · outside: ${outside.length} · outside impacts with a burst before them: ${rows.filter((r) => r.burst).length}`);
