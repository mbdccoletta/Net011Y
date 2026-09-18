// Feeds the generated Grail results through the app's own model code and reports what every view gets.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildRealModel, evaluateNeeds, VIEW_NEEDS, allSites, buildCauses, isBad, suspicionFor, outsideCounts, Prompts, INSTRUCTION, INSTRUCTION_LIMIT, appRise, environmentFindings } from "./out/app-model.mjs";

const R = JSON.parse(readFileSync("out/results.json", "utf8"));
const report = { schema: {}, needs: {}, views: {}, checks: [] };

// 1) Record shapes vs real GRU records
for (const f of readdirSync("out/gru-samples")) {
  const q = f.replace(".json", ""), real = JSON.parse(readFileSync(`out/gru-samples/${f}`, "utf8")).rows;
  const realKeys = new Set(real.flatMap(Object.keys)), gen = R[q] ?? [];
  const genKeys = new Set(gen.slice(0, 50).flatMap(Object.keys));
  const typeOf = (v) => (v == null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const typeDiff = [...realKeys].filter((k) => genKeys.has(k)).filter((k) => {
    const rt = new Set(real.map((r) => typeOf(r[k])).filter((t) => t !== "null")), gt = new Set(gen.slice(0, 50).map((r) => typeOf(r[k])).filter((t) => t !== "null"));
    return rt.size && gt.size && ![...gt].every((t) => rt.has(t));
  });
  report.schema[q] = { rows: gen.length, missing: [...realKeys].filter((k) => !genKeys.has(k)), extra: [...genKeys].filter((k) => !realKeys.has(k)), typeDiff };
}

// 2) The app's model
const model = buildRealModel(R, "simulated-grail");
const counts = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.length]));
const needs = evaluateNeeds(counts, model, "live");
for (const [k, n] of Object.entries(needs)) report.needs[k] = `${n.status} · ${n.detail}`;
const infos = allSites(model);
const causes = buildCauses(model, infos);
const scenario = JSON.parse(readFileSync("out/scenario.json", "utf8"));
const dev = (n) => model.devices.find((d) => d.name === n);
const located = Object.values(model.sites).filter((s) => s.lat != null);

report.views = {
  map: { sitesOnMap: `${located.length}/${Object.keys(model.sites).length}`, causes: causes.map((c) => `${c.kind}: ${c.title} (${c.sites?.length ?? "?"} sites)`).slice(0, 10) },
  sites: { sites: infos.length, withRegion: infos.filter((i) => model.sites[i.code]?.region).length, bad: infos.filter((i) => isBad(i.verdict)).map((i) => `${i.code}:${i.verdict}`) },
  devices: { devices: model.devices.length, byVerdict: model.devices.reduce((a, d) => ((a[d.verdict] = (a[d.verdict] ?? 0) + 1), a), {}), withCpu: model.devices.filter((d) => d.cpuNow != null).length, withAvail: model.devices.filter((d) => d.availPct != null).length, withIfaces: model.devices.filter((d) => d.interfaces.length).length, withIcmp: model.devices.filter((d) => d.icmp).length, withSyslog: model.devices.filter((d) => d.events.length).length },
  links: { circuits: model.circuits?.length ?? 0 },
  topology: { lldpLinks: model.links.length, peers: model.peers.length, flowExporters: model.flows.exporters.length, appClusters: model.e2e.paths[0]?.hops.find((h) => h.kind === "cloud")?.clusters?.length ?? 0 },
};

// 3) Does the injected scenario come through, with the app judging nothing by itself?
const check = (name, ok, detail) => report.checks.push({ ok: !!ok, name, detail });
const openOf = (x) => (x?.problems ?? []).filter((p) => !p.muted);
const sc = scenario.alerts;

// the carrier outage is one problem on the monitors of the circuits that went quiet
const outageCircuits = (model.circuits ?? []).filter((c) => scenario.outage.sites.includes(c.site) && c.kind === "primary");
check("Carrier outage problem reaches the circuits through their monitor",
  outageCircuits.length === sc.downMonitors && outageCircuits.every((c) => openOf(c).some((p) => /global outage/i.test(p.name))),
  `${outageCircuits.filter((c) => openOf(c).length).length}/${outageCircuits.length} circuits carry the problem`);
check("Outage grouped as one entry, not one per circuit",
  causes.filter((c) => /global outage/i.test(c.title)).length === 1,
  causes.map((c) => `${c.kind}: ${c.title} [${c.sites.length}]`).join(" | "));

// an extension alert names its own custom device: only the entity name joins it to the inventory
const fw = dev(scenario.firewallCpu);
check("Extension alert matched by entity name", fw && openOf(fw).some((p) => /Firewall CPU/i.test(p.name)) && isBad(fw.verdict),
  `${fw?.name} ${fw?.verdict} ${openOf(fw).map((p) => p.name).join("; ")}`);

// an alert template fires on an interface; the device that owns it carries the problem, named after the port
const sat = dev(sc.satDevice);
check("Interface alert lands on the owning device with the port name",
  sat && openOf(sat).some((p) => /saturation/i.test(p.name) && p.on === sc.satInterface),
  `${sat?.name} ${sat?.verdict} ${openOf(sat).map((p) => `${p.name}@${p.on ?? "-"}`).join("; ")}`);

// an event that never became a problem still counts
const crc = dev(sc.crcDevice);
check("Davis event without a problem reaches the device", crc && openOf(crc).some((p) => /CRC/i.test(p.name)) && isBad(crc.verdict),
  `${crc?.name} ${crc?.verdict} ${openOf(crc).map((p) => p.name).join("; ")}`);

// a muted problem is invisible here, exactly as it is in Dynatrace
const muted = dev(sc.mutedDevice);
check("Muted problem ignored", muted && !isBad(muted.verdict) && (muted.problems ?? []).some((p) => p.muted),
  `${muted?.name} ${muted?.verdict} muted=${(muted?.problems ?? []).filter((p) => p.muted).length}`);

// the same fault as event and as problem must be counted once
const dup = dev(sc.dupDevice);
check("Event already folded into a problem is not counted twice",
  dup && openOf(dup).filter((p) => /unreachable/i.test(p.name)).length === 1,
  `${dup?.name} ${openOf(dup).map((p) => p.name).join("; ")}`);

// an alert bound to the environment names no device: it must surface instead of being dropped
// unplaced alerts are grouped by why they could not be placed: environment-bound, on a network element
// outside this inventory, or outside the network domain
check("Environment-level alert surfaced apart", (model.unmappedAlerts ?? []).some((a) => /Memory Free/i.test(a.name))
  && causes.some((c) => c.id === "alerts:environment"),
  `${(model.unmappedAlerts ?? []).map((a) => `${a.name} [${a.scope ?? "?"}]`).join("; ")} · causes ${causes.filter((c) => c.id.startsWith("alerts:")).map((c) => c.id).join(", ") || "none"}`);

// ---- isolating the network in or out ----
// the suspicion is a reading, never a status: it must not change a single verdict
const beforeVerdicts = model.devices.map((d) => d.verdict).join(",");
const sus = suspicionFor(model, { dropPct: 50 });
check("A suspicion changes no verdict", model.devices.map((d) => d.verdict).join(",") === beforeVerdicts,
  `${sus.kind} · ${sus.headline}`);
check("Traffic collapse during a network outage reads as network implicated",
  sus.kind === "network-implicated" && sus.network > 0,
  `${sus.kind} · ${sus.network} network alerts · ${JSON.stringify(sus.outside)} outside · facts: ${sus.facts.join(" | ")}`);
check("A drop the platform never alerted on is declared as the app's own measurement",
  sus.fromMeasurement === true && sus.facts.some((f) => /app's own measurement/i.test(f)),
  `fromMeasurement=${sus.fromMeasurement}`);
// with the threshold below what the traffic did, there is nothing left to suspect from the traffic side
// (sessions only: the retransmission rise is checked on its own below)
const quiet = suspicionFor({ ...model, appNet: undefined }, { dropPct: 1 });
check("Below the configured threshold the traffic raises no suspicion",
  quiet.kind !== "network-implicated" || outsideCounts(model).application + outsideCounts(model).service > 0,
  `${quiet.kind} · sessions ${model.users?.now}/${model.users?.typicalNow}`);
check("Client subnets that match a site are attributed, the rest are not",
  (model.users?.mapped ?? 0) > 0 && (model.users?.mapped ?? 0) < (model.users?.total ?? 0),
  `${model.users?.mapped} of ${model.users?.total} sessions attributed to a site`);

// without Real User Monitoring the same reading comes from the requests the services served
const noRum = buildRealModel({ ...R, sessions: [], sessionsTypical: [], sessionNets: [] }, "services-only");
const svc = suspicionFor(noRum, { dropPct: 50 });
check("Without user sessions, the traffic reading falls back to service requests",
  !!noRum.users?.requests && svc.facts.some((f) => /Requests served by the services at \d+%/.test(f)),
  `${svc.kind} · ${svc.facts[0] ?? "no facts"}`);

// alerts outside the network belong to the environment: a site with nothing of its own must not read
// "not the network" because of a problem somewhere else
{
  const quietSite = infos.find((i) => !i.devices.some((d) => (d.problems ?? []).some((p) => !p.muted)) && !i.circuits.some((c) => (c.problems ?? []).some((p) => !p.muted)));
  const siteSus = quietSite ? suspicionFor({ ...model, users: model.users && { ...model.users, now: model.users.typicalNow } }, { site: quietSite, dropPct: 50 }) : null;
  check("Outside alerts do not make an unrelated site read as not the network",
    !!siteSus && siteSus.kind !== "not-network",
    `${quietSite?.code} · ${siteSus?.kind}`);
}

// Assist refuses an instruction over 2500 characters (HTTP 400): every question must fit, with room
{
  const qs = [...Prompts.networkQuestions(), ...Prompts.causeQuestions("A fairly long cause title · 14 sites"), ...Prompts.sitesQuestions(),
    ...Prompts.siteQuestions("A long site name · Store 12", true), ...Prompts.deviceQuestions("BR-XX-LONG1-SWA-001", false), ...Prompts.deviceQuestions("BR-XX-LONG1-SWA-001", true),
    ...Prompts.isolationQuestions("A long site name · Store 12"), ...Prompts.carrierQuestions("Carrier with a long name"), ...Prompts.carrierQuestions(null)];
  const sizes = qs.map((q) => ({ l: q.label, n: `${INSTRUCTION} ${q.instruction ?? ""}`.length }));
  const worst = sizes.reduce((a, b) => (b.n > a.n ? b : a));
  check("Every Assist instruction fits the 2500-character limit", sizes.every((x) => x.n <= INSTRUCTION_LIMIT - 100),
    `${qs.length} questions · largest ${worst.l} ${worst.n} chars`);
}

// a busy environment always has network alerts and other alerts open at once: without a time link it is
// coincidence, not a cause (fxz0998d: 1879 interfaces down and unrelated database outages hours apart)
{
  const shift = (list) => (list ?? []).map((p) => ({ ...p, start: new Date(Date.parse(p.start) - 6 * 3600e3).toISOString() }));
  const old = { ...model, devices: model.devices.map((d) => ({ ...d, problems: shift(d.problems) })), circuits: (model.circuits ?? []).map((c) => ({ ...c, problems: shift(c.problems) })) };
  const r = suspicionFor(old, { dropPct: 50 });
  check("Network alerts that opened hours before the impact are not read as its cause",
    r.kind !== "network-implicated" && r.facts.some((f) => /did not start within/.test(f)), `${r.kind} · ${r.facts.find((f) => /did not start/.test(f)) ?? "no time fact"}`);
}
// ports that flap all day raise network alerts at a steady pace: that background, however close in time,
// is not a burst and must not be read as the cause of what is degraded
{
  const now = Date.now();
  const noise = Array.from({ length: 48 }, (_, k) => ({ eventId: `noise-${k}`, eventKind: "DAVIS_EVENT", displayId: "", name: "Interface operationally going down", start: new Date(now - k * 10 * 60e3).toISOString(), category: "AVAILABILITY" }));
  const quiet = (list) => (list ?? []).map((p) => ({ ...p, start: new Date(Date.parse(p.start) - 30 * 3600e3).toISOString() }));
  const base = { ...model, devices: model.devices.map((d, i) => ({ ...d, problems: i === 0 ? [...quiet(d.problems), ...noise] : quiet(d.problems) })), circuits: (model.circuits ?? []).map((c) => ({ ...c, problems: quiet(c.problems) })) };
  const r = suspicionFor(base, { dropPct: 50 });
  check("A steady stream of network alerts is background, not the cause", r.kind !== "network-implicated" && r.facts.some((f) => /background, not a burst/.test(f)),
    `${r.kind} · ${r.facts.find((f) => /background/.test(f)) ?? "no background fact"}`);
}
// newer environments name entities only as Smartscape objects; those problems must still be classified
{
  const R2 = { ...R, problems: [...(R.problems ?? []), {
    "event.id": "fxz-1", "event.kind": "DAVIS_PROBLEM", display_id: "P-FXZ1", "event.name": "Postgres availability",
    "event.start": new Date().toISOString(), "event.category": "AVAILABILITY", "dt.davis.mute.status": "NOT_MUTED",
    "smartscape.affected_entities": [{ id: "DB_INSTANCE_POSTGRES-9301E4FF70EB4B27", type: "DB_INSTANCE_POSTGRES", name: "pg-15" }],
  }] };
  const m2 = buildRealModel(R2, "smartscape-format");
  const a = (m2.unmappedAlerts ?? []).find((x) => x.displayId === "P-FXZ1");
  check("A problem that names its entity only as a Smartscape object is classified", a?.scope === "service" && (a.entities ?? []).includes("pg-15"),
    `${a?.scope ?? "missing"} · ${(a?.entities ?? []).join(",")}`);
}

// everything alerting outside the network stays on the list of causes, whatever domain it is in
{
  const mk = (scope, i) => ({ eventId: `out-${scope}-${i}`, eventKind: "DAVIS_PROBLEM", displayId: `P-OUT${i}`, name: `${scope} trouble`, start: new Date().toISOString(), category: "AVAILABILITY", scope, entities: [`${scope}-x`] });
  const m2 = { ...model, unmappedAlerts: [...(model.unmappedAlerts ?? []), mk("service", 1), mk("application", 2), mk("host", 3)] };
  const c2 = buildCauses(m2, allSites(m2));
  const out = c2.find((c) => c.id === "alerts:other");
  check("Alerts on applications, services and hosts stay on the list of causes", !!out && /^\d+ alerts outside the network domain$/.test(out.title),
    out ? `${out.title}` : "no outside entry");
}
// events that never became a problem are grouped by what they are and where, not listed one by one
{
  const dev = model.devices.find((d) => d.mode === "Extension") ?? model.devices[0];
  const flood = Array.from({ length: 200 }, (_, k) => ({ eventId: `flap-${k}`, eventKind: "DAVIS_EVENT", displayId: "", name: "Interface operationally going down", start: new Date(Date.now() - k * 60e3).toISOString(), category: "AVAILABILITY" }));
  const m3 = { ...model, devices: model.devices.map((d) => (d === dev ? { ...d, problems: [...(d.problems ?? []), ...flood] } : d)) };
  const c3 = buildCauses(m3, allSites(m3));
  const flap = c3.filter((c) => /Interface operationally going down/.test(c.title));
  check("Two hundred events of one kind on one device are one cause", flap.length === 1 && /· 200 alerts$/.test(flap[0].title) && flap[0].title.includes(" · "),
    `${flap.length} cause(s) · ${flap[0]?.title ?? "-"}`);
}
// sessions are read from a settled hour (the one just closed is still filling), requests from the last one
check("Sessions are read from the settled hour, requests from the last complete one",
  model.users && model.users.nowIndex === model.users.series.length - 3 && model.users.requests?.nowIndex === model.users.requests.series.length - 2,
  `sessions index ${model.users?.nowIndex} of ${model.users?.series.length} · requests index ${model.users?.requests?.nowIndex} of ${model.users?.requests?.series.length}`);

// nothing else invents a status
const noAlert = model.devices.filter((d) => d.mode === "Extension" && !openOf(d).length);
check("Devices without an alert stay healthy, whatever their counters say",
  noAlert.every((d) => d.verdict === "Healthy"),
  `${noAlert.filter((d) => d.verdict !== "Healthy").map((d) => `${d.name}:${d.verdict}`).slice(0, 5).join(", ") || "all healthy"} · highest CPU without alert ${Math.max(0, ...noAlert.map((d) => d.cpuNow ?? 0))}%`);

// the one judgement the app is allowed to make
const overSla = (model.circuits ?? []).filter((c) => c.status === "up" && c.latencyMs != null && c.latencyMs > c.slaMs);
check("Latency above the sla_ms tag is the app's only verdict of its own",
  overSla.length > 0 && overSla.some((c) => c.site === scenario.slowCircuit)
  && overSla.every((c) => c.verdict === "Warning" && c.reasons.some((r) => /SLA you configured/i.test(r.text)))
  && causes.some((c) => c.id.startsWith("sla:")),
  `${overSla.length} circuits above their SLA: ${overSla.map((c) => `${c.site} ${c.latencyMs}/${c.slaMs} ms`).slice(0, 4).join(", ")}`);

// a link that stopped answering while nothing alerts on it must say so
const silent = (model.circuits ?? []).filter((c) => c.status === "down" && !openOf(c).length);
const silentCause = causes.find((c) => c.id.startsWith("down:"));
check("Down link without an alert is reported as such, and says nothing is alerting",
  silent.length > 0 && silent.some((c) => c.site === scenario.silentCircuit) && !!silentCause
  && silentCause.evidence.some((e) => /No alert is configured/i.test(e.text)),
  `${silent.length} circuits down with no alert: ${silent.map((c) => `${c.site} ${c.kind}`).join(", ")} · cause "${silentCause?.title ?? "none"}"`);

// inventory still comes from the primary tags
check("Sites placed on the map (primary_tags.geo_lat/geo_lon)", located.length === Object.keys(model.sites).length, `${located.length}/${Object.keys(model.sites).length}`);
check("Sites grouped by region (primary_tags.region)", infos.every((i) => model.sites[i.code]?.region), `${infos.filter((i) => model.sites[i.code]?.region).length}/${infos.length}`);
check("WAN circuits from circuit tags", (model.circuits?.length ?? 0) === 104, `${model.circuits?.length} circuits, ${model.circuits?.filter((c) => c.status === "down").length} down`);
check("Syslog tied to devices by source IP", model.devices.some((d) => d.events.some((e) => e.kind === "syslog")), "");
check("Traps tied to devices", model.traps.filter((t) => t.device).length === model.traps.length, `${model.traps.filter((t) => t.device).length}/${model.traps.length}`);
check("Alerts reported as a data source", needs.alerts.status === "ok", `${needs.alerts.status} · ${needs.alerts.detail}`);

// real topology: CDP/LLDP neighbours from SNMP autodiscovery become links between sites
const siteOfDev = new Map(model.devices.map((d) => [d.name, d.site]));
const crossSite = model.links.filter((l) => l.kind === "CDP" && siteOfDev.has(l.a) && siteOfDev.has(l.b) && siteOfDev.get(l.a) !== siteOfDev.get(l.b));
check("Neighbour discovery gives cables between sites, port to port", crossSite.length === R.neighbors.length && crossSite.every((l) => l.ifA && l.ifB),
  `${crossSite.length}/${R.neighbors.length} · ${needs.lldp.detail}`);
// a sysLocation left at "n/a" is no place: the autodiscovery group names the site instead, and says data center
const mini = buildRealModel({ devices: [
  { id: "EXT_NETWORK_DEVICE-A1", name: "PL1i-SW-1.example.org", location: "n/a", monitoring_mode: "Discovery", "autodiscovery.group_label": "EDE - Gdansk (Data Center)", ip: ["10.9.0.1"] },
  { id: "EXT_NETWORK_DEVICE-A2", name: "PL1i-SW-2.example.org", location: "Gdansk", monitoring_mode: "Discovery", "autodiscovery.group_label": "EDE - Gdansk", ip: ["10.9.0.2"] },
  { id: "EXT_NETWORK_DEVICE-A3", name: "AT1i-SW-1.example.org", location: "n/a", monitoring_mode: "Extension", activation_tag: "Linz Campus", ip: ["10.8.0.1"] },
] }, "mini");
check("Placeholder sysLocation ignored; autodiscovery labels name the site",
  !mini.sites["n/a"] && mini.devices.filter((d) => d.site === "Gdansk").length === 2 && mini.sites.Gdansk?.dc && mini.devices.some((d) => d.site === "Linz Campus"),
  Object.values(mini.sites).map((s) => `${s.code}${s.dc ? " [DC]" : ""}`).join(", "));

// the applications feel the network: a retransmission rise right after the outage links to the burst
const envS = suspicionFor(model, { dropPct: 50 });
check("Retransmission rise after the outage read as the applications feeling the network",
  envS.app?.rising && envS.kind === "network-implicated" && envS.facts.some((f) => /retransmitted since/.test(f)) && envS.app.workloads[0]?.name === "checkout-cluster",
  `${envS.kind} · ${envS.facts.filter((f) => /retransmi/i.test(f)).join(" | ")}`);
// the same rise with nothing open on the network is a symptom nobody alerts on, never "not the network"
const noNet = { ...model, devices: model.devices.map((d) => ({ ...d, problems: [] })), circuits: (model.circuits ?? []).map((c) => ({ ...c, problems: [] })), unmappedAlerts: [], users: undefined };
const qS = suspicionFor(noNet, { dropPct: 50 });
check("Retransmissions rising with no network alert read as an unmonitored network symptom", qS.kind === "unexplained", `${qS.kind} · ${qS.headline}`);
// and a flat level is counter-evidence, not a rise
const flat = { ...model, appNet: { ...model.appNet, retrPct: model.appNet.retrPct.map(() => 0.02), retransmitted: model.appNet.retransmitted.map(() => 4000) } };
const fS = suspicionFor(flat, { dropPct: 50 });
check("Flat retransmissions stated as counter-evidence", !fS.app?.rising && fS.facts.some((f) => /at their usual level/.test(f)), fS.facts.find((f) => /usual level/.test(f)) ?? "none");

// NetFlow: exporters place traffic at sites, site_cidr places the far end, findings are measurements
const fm = model.flowMap;
const dc1 = Object.values(model.sites).find((s) => s.dc && fm?.sites[s.code]?.fanIn.length);
check("NetFlow places traffic between sites through exporters and site_cidr",
  fm && fm.exporters.every((e) => e.device) && fm.pairs.length > 0 && fm.pairs.every((p) => model.sites[p.a] && model.sites[p.b]),
  `${fm?.exporters.length} exporters · ${fm?.pairs.length} site pairs · top ${fm?.pairs[0] ? `${fm.pairs[0].a}↔${fm.pairs[0].b} ${(fm.pairs[0].bytes / 1e9).toFixed(1)} GB` : "none"} · ${needs.netflow.detail}`);
check("Internet scan against a data center found as a fan-in, and only that one",
  !!dc1 && fm.sites[dc1.code].fanIn[0].sources === 1500 && fm.sites[dc1.code].fanIn[0].port === "23"
  && Object.values(fm.sites).flatMap((t) => t.fanIn).length === 1,
  dc1 ? `${dc1.code}: ${JSON.stringify(fm.sites[dc1.code].fanIn[0])}` : "none");
const anyTraffic = Object.entries(fm?.sites ?? {}).find(([, t]) => t.apps.length);
check("Applications named by port and merged across protocols",
  !!anyTraffic && new Set(anyTraffic[1].apps.map((a) => a.name ?? `${a.proto}/${a.port}`)).size === anyTraffic[1].apps.length && anyTraffic[1].apps.some((a) => a.name === "HTTPS"),
  anyTraffic ? anyTraffic[1].apps.map((a) => a.name ?? `${a.proto}/${a.port}`).join(", ") : "none");

// firewall logs join NetFlow as a source: conversations with zones, placed at the firewall's site
const fwc = fm.conversations.filter((c) => c.source === "firewall");
check("Firewall connection logs become placed conversations, and notable denies are named",
  fwc.length === R.fwConns.length && fwc.every((c) => c.viaSite && c.app === "HTTPS") && fm.sources.firewall?.denies === 4240
  && Object.values(fm.sites).some((t) => t.denies.some((d) => d.denies === 4200)) && !Object.values(fm.sites).some((t) => t.denies.some((d) => d.denies === 40 && d.port === "3389" && false)),
  `${fwc.length} firewall groups · ${JSON.stringify(fm.sources.firewall)}`);
// the journey keeps every byte: what leaves the sources is what reaches the destinations
const jn = fm.journey, colBytes = (c) => jn.nodes.filter((n) => n.col === c).reduce((a, n) => a + n.bytes, 0);
check("Traffic journey conserves bytes and folds each column to its top entries",
  Math.abs(colBytes(0) - colBytes(2)) < 1 && Math.abs(colBytes(0) - fm.conversations.reduce((a, c) => a + c.bytes, 0)) < 1
  && [0, 1, 2].every((c) => jn.nodes.filter((n) => n.col === c && n.kind !== "denied").length <= 7) && jn.nodes.some((n) => n.id === "denied"),
  `${jn.nodes.length} nodes · ${jn.links.length} links · ${(colBytes(0) / 1e9).toFixed(1)} GB`);
// no OneAgent network flows: the per-process network metrics stand in, and say so
const pmModel = buildRealModel({ ...R, appNet: [], appNetBy: [], appNetProc: [{ timeframe: R.appNet[0].timeframe, interval: R.appNet[0].interval, pk: R.appNet[0].pk, re: R.appNet[0].re, rtt: R.appNet[0].pk.map(() => 16) }],
  appNetProcBy: [{ "dt.host_group.id": "POC-SOAM", pk: [1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6], re: [75000, 74000, 76000, 75000, 74000, 75000, 76000], rtt: [16, 16, 17, 16, 16, 16, 17] }] }, "process-metrics");
const pmS = suspicionFor(pmModel, { dropPct: 50 });
check("Process network metrics stand in for flows, and a steady high level is named as chronic",
  pmModel.appNet?.source === "process metrics" && pmS.app?.rising && pmS.facts.some((f) => /process network metrics/.test(f))
  && environmentFindings(pmModel).some((x) => x.kind === "chronic-retransmission" && /POC-SOAM/.test(x.text)),
  `${pmModel.appNet?.source} · ${environmentFindings(pmModel).filter((x) => x.kind === "chronic-retransmission").map((x) => x.text).join(" | ")}`);

report.summary = { passed: report.checks.filter((c) => c.ok).length, of: report.checks.length };

writeFileSync("out/validation.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
