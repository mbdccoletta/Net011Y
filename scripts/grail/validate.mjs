// Feeds the generated Grail results through the app's own model code and reports what every view gets.
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hooksAfterReturn } from "./hooks_after_return.mjs";
import { QUERIES, planWanted, readWanted } from "./out/queries.mjs";
import { causeSummary, causeSiteCount, regionsShown, fitView, frameFill, FIT_MARGIN, placeLabels as NetMap_placeLabels, labelFits as NetMap_labelFits, networkContext, trafficContext, siteContext, measuredKey, networkLogShare, buildRealModel, deriveTags, forecastWindow, evaluateNeeds, VIEW_NEEDS, allSites, shortSiteName, addressParts, ensurePlaces, countryOf, regionOf, placesReady, buildCauses, splitCauses, isBad, appVerdict, deviceVerdict, portCounts, portsDown, suspicionFor, outsideCounts, Prompts, INSTRUCTION, INSTRUCTION_LIMIT, appRise, environmentFindings, portUsers, busyPortFindings, pathFindings, pageCoverage, changesOf, clusterPoints, worstOf, CELL, bubbleRadius, mergeRows, logsSearchQuery, buildJourney, asRoutes, nextSteps, coverage, read, fitLine, findStep, jumpOf, aheadSubjects, aheadCensus, aheadContext, silence, STATES, crossedAgo, chanceBy, backtest, clusterChanges, narrow, branchesAt, busyHour, shownCeiling, headroomOf, quantile } from "./out/app-model.mjs";

// The fixtures carry their own moments — a restart two hours ago, an outage that started at 15:34 — and
// the model only reports what happened in the last day. Left for a day, they age out of every window and
// the suite goes red for a reason that has nothing to do with the code, which is how a suite stops being
// believed. So a stale set is rebuilt before anything is read.
const scenarioAge = () => {
  try { return Date.now() - Date.parse(JSON.parse(readFileSync("out/scenario.json", "utf8")).generatedFor); } catch { return Infinity; }
};
// Half an hour, not a working day: the checks that compare a burst of alerts against the moment of a
// degradation stop holding once the two drift apart, and the suite went red for a set that was only two
// hours old. Generating the whole estate takes a fifth of a second, so there is nothing to save by
// keeping a stale one.
if (scenarioAge() > 30 * 60e3) {
  console.error("fixtures are more than 30 min old — regenerating before the checks");
  // its own report goes nowhere: this script's stdout is the JSON the tooling reads
  execFileSync(process.execPath, [new URL("generate.mjs", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"], cwd: new URL(".", import.meta.url).pathname });
}

// The report goes first, before anything can throw.
//
// A syntax error in this file left the previous run's out/validation.json in place, and reading
// it afterwards showed a green suite that had not run at all. A stale pass is worse than a
// crash, because a crash is visible.
try { rmSync("out/validation.json"); } catch { /* nothing to clear */ }

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
const silenceReason = (r) => (!r.fit ? "too little record" : !r.fit.rising ? r.fit.why : "beyond what the record can see");
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

/**
 * One entry per finding, not one per device it was found on.
 *
 * An alert kind that never becomes a Davis problem used to be keyed by kind *and* device, so a
 * kind raised across an estate made a row per device. Counted on a three-data-centre
 * environment: fifteen devices raising four kinds between them produced forty rows on the
 * landing page, and the two entries that had actually alerted sat in the middle of them. The
 * fixture had one such row in the whole network, so nothing here could see it.
 *
 * The title still names a single device where there is one, because that is what a reader acts
 * on; where there are several it counts them and the panel behind the row holds every one.
 */
{
  const flap = causes.filter((c) => c.title.startsWith("Interface operationally going down"));
  const low = causes.filter((c) => c.title.startsWith("Interface traffic low"));
  const crc = causes.filter((c) => c.title.startsWith("Interface CRC high rate"));
  check("An alert kind raised on many devices is one entry that holds them all",
    flap.length === 1 && flap[0].elements.length === 9 && flap[0].sites.length > 1
    && / · 9 devices · /.test(flap[0].title)
    && low.length === 1 && low[0].elements.length === 4
    /* and a kind found on one device is still named after it, which is what a reader acts on */
    && crc.length === 1 && /SWT/.test(crc[0].title),
    [...flap, ...low, ...crc].map((c) => `${c.title} [${c.elements.length} el · ${c.sites.length} sites]`).join(" | ") || "none");
}

/**
 * The landing page splits its causes by reach, and the heading promises what reach buys.
 *
 * "Shared causes · one fault under several sites. One action reaches all of them." The rule
 * behind it used to be the cause's *kind*: a carrier or a data centre counted whatever it
 * reached. Measured on the extra-large example, 46 of the 48 rows under that heading touched a
 * single site — and on an estate of nothing but data centres it is every row, because `kindOf`
 * calls a cause "datacenter" when every device on it sits at one.
 *
 * The split lived in the page as an inline filter, which is why it was never checked. It is a
 * statement about causes, so it is in the model now and this holds it.
 */
{
  const estates = [["the generated estate", model]];
  const bad = [];
  for (const [label, m] of estates) {
    const { shared, isolated } = splitCauses(buildCauses(m, allSites(m)));
    const all = buildCauses(m, allSites(m));
    if (shared.some((c) => c.sites.length < 2)) bad.push(`${label}: a shared cause reaches one site`);
    if (shared.length + isolated.length !== all.length) bad.push(`${label}: the split loses causes`);
  }
  const { shared, isolated } = splitCauses(causes);
  check("Shared causes are the ones that reach more than one site, and the two lists hold every cause",
    bad.length === 0 && shared.every((c) => c.sites.length > 1) && shared.length + isolated.length === causes.length,
    bad.join(" · ") || `${shared.length} shared · ${isolated.length} isolated of ${causes.length}`);
}

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

// An alert bound to the environment names no device. It is kept — dropping it hides an open alert —
// and it is not a cause: nothing says what it impacted, or that the network impacted anything, and a
// reader who opened that entry found a panel with no site, no device and nothing the network had done.
// The page counts these under the list of causes as a gap in coverage, with the one thing that would
// place them. This check holds both halves: the alert survives the build with the scope that explains
// why it could not be placed, and no entry on the list of faults is made out of it.
{
  const env = (model.unmappedAlerts ?? []).filter((a) => a.scope === "environment");
  check("Environment-level alert kept, and not made into a cause",
    env.some((a) => /Memory Free/i.test(a.name)) && !causes.some((c) => c.id.startsWith("alerts:")),
    `${(model.unmappedAlerts ?? []).map((a) => `${a.name} [${a.scope ?? "?"}]`).join("; ")} · cause entries for them: ${causes.filter((c) => c.id.startsWith("alerts:")).map((c) => c.id).join(", ") || "none"}`);
}

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
// coincidence, not a cause (a large environment: 1879 interfaces down and unrelated database outages hours apart)
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
  const out = outsideCounts(m2);
  const s2 = suspicionFor(m2, { dropPct: 50 });
  const susOutside = Object.values(s2.outside ?? {}).reduce((a, n) => a + n, 0);
  // They are not causes — what an alert outside the network is evidence of is that the fault is not
  // here — so they are counted where that reading is made, and the suspicion has to carry them.
  check("Alerts on applications, services and hosts are counted outside the network",
    out.application >= 1 && out.service >= 1 && out.host >= 1
      && !c2.some((c) => c.id.startsWith("alerts:")) && susOutside >= 3,
    `application ${out.application} · service ${out.service} · host ${out.host} · suspicion outside ${susOutside}`);
}
// events that never became a problem are grouped by what they are and where, not listed one by one
{
  const dev = model.devices.find((d) => d.mode === "Extension") ?? model.devices[0];
  /* a kind of its own: the generated estate now raises "Interface operationally going down" on
     nine devices, and this check is about two hundred of one kind on *one* device collapsing.
     Sharing the name merged the two and the check started measuring the fixture. */
  const flood = Array.from({ length: 200 }, (_, k) => ({ eventId: `flap-${k}`, eventKind: "DAVIS_EVENT", displayId: "", name: "Interface receive errors burst", start: new Date(Date.now() - k * 60e3).toISOString(), category: "AVAILABILITY" }));
  const m3 = { ...model, devices: model.devices.map((d) => (d === dev ? { ...d, problems: [...(d.problems ?? []), ...flood] } : d)) };
  const c3 = buildCauses(m3, allSites(m3));
  const flap = c3.filter((c) => /Interface receive errors burst/.test(c.title));
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
// the Smartscape edges come first; the neighbour logs add the pairs they do not hold
const ssPairs = model.links.filter((l) => l.kind === "Smartscape").length;
check("Neighbour discovery gives cables between sites, port to port", crossSite.length + ssPairs === R.neighbors.length && crossSite.every((l) => l.ifA && l.ifB),
  `${crossSite.length} from the logs + ${ssPairs} from Smartscape of ${R.neighbors.length} · ${needs.lldp.detail}`);
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

// A problem raised on the monitor that pings a device is about the monitor. One monitoring
// configuration covering forty-nine switches turned all forty-nine red while every one of them was
// answering SNMP, and the network team's reading of that screen was that the day was normal.
{
  const d = model.devices.find((x) => x.mode === "Extension");
  const watched = { ...d, problems: [{ eventId: "E", eventKind: "DAVIS_PROBLEM", displayId: "P-1", name: "Network availability monitor outage", start: new Date().toISOString(), category: "AVAILABILITY", viaMonitor: true }] };
  const named = { ...d, problems: [{ ...watched.problems[0], viaMonitor: undefined }] };
  const [vw, rw] = deviceVerdict(watched);
  const [vn] = deviceVerdict(named);
  // The sentence used to open "Reachability is not being measured". Measured against the record that
  // was false — the monitor was sending packets and getting answers from most of its targets — so what
  // the reason says now is where the alert sits, and this asks for that and for no claim about the device.
  check("A monitor outage does not make the device it watches critical",
    vw === "Healthy" && vn === "Critical" && /on the monitoring configuration that pings this device, not on the device/.test(rw[0]?.text ?? ""),
    `through the monitor: ${vw} · on the device: ${vn} · ${rw[0]?.text?.slice(0, 80)}`);
}
// A switch's unpatched and shut ports are not faults, and folding them into one number over a total
// made a healthy switch look half broken.
{
  const withPorts = model.devices.filter((x) => x.interfaces.length);
  // Four states now: a port whose status the app could not read is its own answer, not a failure.
  // And the middle figure has to be the list underneath it — "5 down" over a list of two was a
  // loopback and two tunnels counted as broken links.
  const ok = withPorts.every((x) => {
    const p = portCounts(x);
    return p.up + p.down + p.unused + p.unknown === p.total && p.total === x.interfaces.length
      && p.down === portsDown(x).length;
  });
  const bad = withPorts.find((x) => { const p = portCounts(x); return p.down !== portsDown(x).length; });
  const shut = withPorts.map((x) => portCounts(x)).reduce((a, p) => a + p.unused, 0);
  check("Ports are counted in four states that add up, and down is the list beside it", ok && withPorts.length > 0,
    `${withPorts.length} devices with ports · ${shut} shut, empty or not a link${bad ? ` · ${bad.name} counts ${portCounts(bad).down} down and lists ${portsDown(bad).length}` : ""}`);
}
// A road that classifies nothing still carries lines. An environment collecting its syslog server's
// files through a OneAgent delivers every line as loglevel NONE, the app counted only ERROR, WARN and
// INFO, and a hundred and fifty thousand lines an hour showed up as "0 syslog errors" on every device.
{
  const q = QUERIES.deviceLogs.query;
  const lvl = /loglevel = if\(loglevel == "ERROR"/.test(q) && /INT:sev/.test(q);
  const counted = model.devices.every((d) => typeof d.syslog.NONE === "number");
  check("Syslog reads the protocol's own severity when the pipeline set none",
    lvl && counted, `derived in the query: ${lvl} · fourth bucket on every device: ${counted}`);
}
// and an address that sends but answers to no device is reported rather than skipped
{
  const rows = [{ ip: "203.0.113.7", kind: "syslog", loglevel: "INFO", n: [5, 5] }];
  const m2 = buildRealModel({ ...R, deviceLogs: [...(R.deviceLogs ?? []), ...rows] }, "simulated-grail");
  const n2 = evaluateNeeds({ ...counts, deviceLogs: 1 }, m2, "live").syslog;
  check("Syslog from an address the inventory does not know is still reported",
    (m2.syslogSenders?.unknown ?? 0) >= 1 && /answer to no monitored device/.test(n2.detail),
    `${m2.syslogSenders?.unknown} unknown · ${n2.detail.slice(0, 110)}`);
}
// A device whose syslog arrives from another interface has nothing tagged with the address the
// extension polls. Every Cisco switch in one environment matched and not one of its fifteen Check
// Points, four Fortigates or three F5s did, and the Logs button opened a query that could only
// answer "No logs found".
{
  const d = model.devices[0];
  const search = logsSearchQuery(d.name, [d.ip], null);
  check("A device with no syslog of its own gets a search, not an empty query",
    search.includes(d.name) && search.includes(d.ip) && /contains\(log\.source/.test(search) && /contains\(content/.test(search),
    search.split("\n")[1]?.slice(0, 110));
}
// site_cidr is a fact about the site, and any device standing at it may state it. The app used to
// read the tag off whichever device it met first with a site tag, so tagging one router per site —
// the obvious thing to do — did nothing unless that router happened to be the one it met.
{
  const site = Object.keys(model.sites).find((c) => model.devices.filter((d) => d.site === c).length > 2);
  const at = R.devices.filter((d) => model.devices.find((x) => x.name === d.name)?.site === site);
  if (at.length > 2) {
    const tagged = R.devices.map((d) => (d === at[at.length - 1] ? { ...d, "primary_tags.site_cidr": "198.51.100.0/24" } : d));
    const m2 = buildRealModel({ ...R, devices: tagged }, "simulated-grail");
    check("A range tagged on any device at a site counts for that site",
      (m2.flowMap?.subnetsTagged ?? 0) > (model.flowMap?.subnetsTagged ?? 0),
      `${site}: tagged the last of ${at.length} devices · ${model.flowMap?.subnetsTagged} -> ${m2.flowMap?.subnetsTagged} ranges`);
  } else check("A range tagged on any device at a site counts for that site", false, "no site with three devices in the fixture");
}
// One place must be one site. Forty-eight devices carrying one site tag, one discovery configuration
// and one pair of coordinates drew three markers on the map, because the identity came from the short
// code in each device's own sysLocation: forty-seven said RGR, one said RGR1, and the rest fell back
// to the tag.
{
  const tagged = R.devices.filter((d) => d["primary_tags.site"]);
  const one = tagged[0]?.["primary_tags.site"];
  const peers = tagged.filter((d) => d["primary_tags.site"] === one);
  if (one && peers.length > 2) {
    // give one of them a sysLocation whose code differs, as a typo in the field would
    const bent = R.devices.map((d) => (d === peers[peers.length - 1]
      ? { ...d, location: String(d.location ?? "").replace(/ - ([A-Z]{2,5})\d* - /, " - $1Z9 - ") } : d));
    const m2 = buildRealModel({ ...R, devices: bent }, "simulated-grail");
    const before = model.devices.filter((d) => d.site === model.devices.find((x) => x.name === peers[0].name)?.site).length;
    const after = m2.devices.filter((d) => d.site === m2.devices.find((x) => x.name === peers[0].name)?.site).length;
    check("One site tag is one site, whatever each device's sysLocation says",
      after === before && Object.keys(m2.sites).length === Object.keys(model.sites).length,
      `${one}: ${before} devices before, ${after} after bending one sysLocation · ${Object.keys(model.sites).length} -> ${Object.keys(m2.sites).length} sites`);
  } else check("One site tag is one site, whatever each device's sysLocation says", false, "no tagged site with three devices in the fixture");
}
// The separator inside a primary tag key is whatever the person who typed it chose. The reference
// configuration writes geo_lat; one environment had written geo.lat, and the coordinates of nine
// sites read as absent while the exact position sat in the record under a full stop.
{
  const dotted = R.devices.map((d) => {
    const o = { ...d };
    // only the key, never the primary_tags. prefix, which carries an underscore of its own
    for (const k of Object.keys(o)) if (k.startsWith("primary_tags.") && k.slice(13).includes("_")) { o[`primary_tags.${k.slice(13).replace(/_/g, ".")}`] = o[k]; delete o[k]; }
    return o;
  });
  const m2 = buildRealModel({ ...R, devices: dotted }, "simulated-grail");
  const exact = (m) => Object.values(m.sites).filter((s) => s.lat != null && !s.approx).length;
  check("A primary tag reads the same with a dot or an underscore",
    exact(m2) === exact(model) && exact(model) > 0,
    `${exact(model)} sites placed exactly with underscores, ${exact(m2)} with dots`);
}
// The display name of a site is primary_tags.site_name, and like every other site-level tag it is a
// fact about the site: tagging part of a fleet, a configuration at a time, used to leave the site
// reading whichever half the loop met first.
{
  const withName = R.devices.filter((d) => d["primary_tags.site"]);
  const target = withName[withName.length - 1];
  if (target) {
    const only = R.devices.map((d) => {
      const o = { ...d };
      delete o["primary_tags.site_name"];
      return d === target ? { ...o, "primary_tags.site_name": "Named By One Device" } : o;
    });
    const m2 = buildRealModel({ ...R, devices: only }, "simulated-grail");
    const code = m2.devices.find((x) => x.name === target.name)?.site;
    check("A site takes its name from any device that states it",
      m2.sites[code]?.name === "Named By One Device",
      `${code} reads "${m2.sites[code]?.name}" from the last of ${withName.length} tagged devices`);
  } else check("A site takes its name from any device that states it", false, "no tagged device in the fixture");
}
// NetFlow: exporters place traffic at sites, site_cidr places the far end, findings are measurements
const fm = model.flowMap;
const dc1 = Object.values(model.sites).find((s) => s.dc && fm?.sites[s.code]?.fanIn.length);
check("NetFlow places traffic between sites through exporters and site_cidr",
  fm && fm.exporters.every((e) => e.device) && fm.pairs.length > 0 && fm.pairs.every((p) => model.sites[p.a] && model.sites[p.b]),
  `${fm?.exporters.length} exporters · ${fm?.pairs.length} site pairs · top ${fm?.pairs[0] ? `${fm.pairs[0].a}↔${fm.pairs[0].b} ${(fm.pairs[0].bytes / 1e9).toFixed(1)} GB` : "none"} · ${needs.netflow.detail}`);
// the map draws the routes between sites from these flows, so it has to name the source it draws from:
// an environment whose flows arrive but whose addresses no site claims came up empty and said nothing
check("The map declares NetFlow among the sources it needs",
  VIEW_NEEDS.map.includes("netflow"), VIEW_NEEDS.map.join(", "));
// The exporters are named by the conversations, not by the rate query: flowTs is read only where the
// bandwidth and the falling-silent check are shown, and an environment that has not read it still knows
// who its exporters are. It once reported "0/0 exporters tied to a device" with three of them sending.
{
  const noTs = buildRealModel({ ...R, flowTs: [] }, "simulated-grail");
  const exp = new Set(R.flowNets.map((r) => r.exp));
  check("The exporters are known without the rate query",
    noTs.flowMap?.exporters.length === exp.size
    && evaluateNeeds({ ...counts, flowTs: null }, noTs, "live").netflow.detail.startsWith(`${exp.size}/${exp.size} exporters`),
    `${noTs.flowMap?.exporters.length} of ${exp.size} · ${evaluateNeeds({ ...counts, flowTs: null }, noTs, "live").netflow.detail}`);
}
check("Internet scan against a data center found as a fan-in, and only that one",
  !!dc1 && fm.sites[dc1.code].fanIn[0].sources === 1500 && fm.sites[dc1.code].fanIn[0].port === "23"
  && Object.values(fm.sites).flatMap((t) => t.fanIn).length === 1,
  dc1 ? `${dc1.code}: ${JSON.stringify(fm.sites[dc1.code].fanIn[0])}` : "none");
const anyTraffic = Object.entries(fm?.sites ?? {}).find(([, t]) => t.apps.length);
check("Applications named by port and merged across protocols",
  !!anyTraffic && new Set(anyTraffic[1].apps.map((a) => a.name ?? `${a.proto}/${a.port}`)).size === anyTraffic[1].apps.length && anyTraffic[1].apps.some((a) => a.name === "HTTPS"),
  anyTraffic ? anyTraffic[1].apps.map((a) => a.name ?? `${a.proto}/${a.port}`).join(", ") : "none");

// the journey keeps every byte: what leaves the sources is what reaches the destinations
const jn = fm.journey, colBytes = (c) => jn.nodes.filter((n) => n.col === c).reduce((a, n) => a + n.bytes, 0);
check("Traffic journey conserves bytes and folds each column to its top entries",
  Math.abs(colBytes(0) - colBytes(2)) < 1 && Math.abs(colBytes(0) - fm.conversations.reduce((a, c) => a + c.bytes, 0)) < 1
  && [0, 1, 2].every((c) => jn.nodes.filter((n) => n.col === c).length <= 7),
  `${jn.nodes.length} nodes · ${jn.links.length} links · ${(colBytes(0) / 1e9).toFixed(1)} GB`);
// no OneAgent network flows: the per-process network metrics stand in, and say so
const pmModel = buildRealModel({ ...R, appNet: [], appNetBy: [], appNetProc: [{ timeframe: R.appNet[0].timeframe, interval: R.appNet[0].interval, pk: R.appNet[0].pk, re: R.appNet[0].re, rtt: R.appNet[0].pk.map(() => 16) }],
  appNetProcBy: [{ "dt.host_group.id": "POC-SOAM", pk: [1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6], re: [75000, 74000, 76000, 75000, 74000, 75000, 76000], rtt: [16, 16, 17, 16, 16, 16, 17] }] }, "process-metrics");
const pmS = suspicionFor(pmModel, { dropPct: 50 });
check("Process network metrics stand in for flows, and a steady high level is named as chronic",
  pmModel.appNet?.source === "process metrics" && pmS.app?.rising && pmS.facts.some((f) => /process network metrics/.test(f))
  && environmentFindings(pmModel).some((x) => x.kind === "chronic-retransmission" && /POC-SOAM/.test(x.text)),
  `${pmModel.appNet?.source} · ${environmentFindings(pmModel).filter((x) => x.kind === "chronic-retransmission").map((x) => x.text).join(" | ")}`);

// who fills a port: the exporter's conversations tied to its ports through the SNMP ifIndex
const expDev = model.devices.find((d) => fm.conversations.some((c) => c.viaName === d.name && c.inIf && !c.inIf.startsWith("ifIndex")));
const port = expDev && fm.conversations.find((c) => c.viaName === expDev.name && c.inIf)?.inIf;
const users = port ? portUsers(model, expDev, port) : [];
const busy = expDev ? busyPortFindings({ ...model, devices: model.devices.map((d) => (d === expDev ? { ...d, interfaces: [{ ...(d.interfaces[0] ?? {}), name: port, util: 95 }] } : d)) }) : [];
check("Flows tied to ports by ifIndex explain a busy port",
  !!port && users.length > 0 && users.reduce((a, u) => a + u.share, 0) <= 101 && busy.some((b) => b.text.includes(port) && /95%/.test(b.text)),
  `${expDev?.name} ${port}: ${users.slice(0, 2).map((u) => `${u.app} ${u.share}%`).join(", ")} · ${busy[0]?.text ?? "no finding"}`);
// path quality: one slow branch, one lossy path, one reset path, placed at their sites
const pf = pathFindings(model);
check("Path quality names the slow, the lossy and the reset path, each at its site",
  model.paths?.length === R.appPaths.length && pf.some((x) => x.kind === "slow-path" && /95 ms/.test(x.text)) && pf.some((x) => x.kind === "lossy-path") && pf.some((x) => x.kind === "resets")
  && pf.every((x) => x.site && model.sites[x.site]),
  pf.map((x) => `${x.kind}@${x.site}`).join(", "));

// the documented network topology: Smartscape "calls" between devices become links, ahead of the neighbour logs
const ssLinks = model.links.filter((l) => l.kind === "Smartscape");
check("Smartscape calls between network devices read as topology", ssLinks.length === R.netEdges.length && ssLinks.every((l) => siteOfDev.get(l.a) !== siteOfDev.get(l.b)),
  `${ssLinks.length}/${R.netEdges.length} · ${needs.lldp.detail}`);
// Davis in its current shape: a problem in a maintenance window is muted, with its severity and root cause kept
const maintP = model.devices.flatMap((d) => (d.problems ?? []).map((p) => ({ d, p }))).find(({ p }) => p.displayId === "P-2609006");
check("Maintenance windows mute a problem; severity and root cause are kept",
  !!maintP && maintP.p.muted && maintP.p.maintenance && maintP.p.severity === 2 && maintP.p.rootCause === true,
  maintP ? `${maintP.d.name}: muted=${maintP.p.muted} severity=${maintP.p.severity} rootCause=${maintP.p.rootCause}` : "not found");

// every extension family read through one catalog: a device named by address only still gets its CPU
// and memory, and VLANs come from the VLAN table and from VLAN interfaces
const pa = dev(scenario.paloAlto), vl = dev(scenario.vlanDevice);
check("A family naming devices by address (Palo Alto format) is joined to the device",
  pa?.cpuNow === 37 && pa?.memNow === 64 && (model.extensions ?? []).includes("paloalto"), `${pa?.name}: cpu ${pa?.cpuNow} · memory ${pa?.memNow} · families ${model.extensions?.join(", ")}`);
check("VLANs from the VLAN table and from VLAN interfaces",
  (vl?.vlans ?? []).filter((v) => v.source === "vlan table").map((v) => v.tag).join(",") === "10,20,30" && (vl?.vlans ?? []).some((v) => v.source === "interface" && v.tag === "20"),
  (vl?.vlans ?? []).map((v) => `${v.tag}:${v.name}:${v.source}`).join(" · "));

// each tab says how much of its page the environment fills; an empty model fills nothing
// A page whose reads belong to it alone is not read until it is opened, and until then nothing about
// it has been measured. It announced "nothing to show yet in this environment" on its own tab, and
// "Neither is arriving in this environment" on the page, while the queries were still being fired.
{
  const un = ["flowNets", "flowTs", "flowFanIn"];
  const blind = { ...model, flowMap: undefined, paths: undefined };
  const cov = pageCoverage(blind, un);
  const need = evaluateNeeds({ ...counts, flowNets: null, flowTs: null, flowFanIn: null }, blind, "live", {}, false, un).netflow;
  check("A page nobody has read yet claims nothing about itself",
    cov.traffic === null && need.status === "loading" && !/nothing|not available/.test(need.detail),
    `coverage ${cov.traffic} · ${need.status} · ${need.detail}`);
  // the bandwidth read answers from the browser's cache in under two seconds, the conversations take
  // nine: one answer in hand was enough for the page to announce that nothing arrives
  const half = evaluateNeeds({ ...counts, flowNets: null, flowFanIn: null }, blind, "live", {}, true, []).netflow;
  check("A source half read is still being read",
    half.status === "loading", `${half.status} · ${half.detail}`);
}
const pc = pageCoverage(model), none = pageCoverage({ ...model, devices: [], sites: {}, circuits: [], flowMap: undefined, paths: undefined, appNet: undefined, users: undefined });
check("Page coverage reads the data each page is built on",
  pc.links === 1 && pc.traffic > 0.5 && pc.devices > 0 && pc.sites > 0 && Object.values(none).every((v) => v === 0),
  `${Object.entries(pc).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ")}`);

// an environment with nothing specific: no tags, no location, names in no convention. Devices still get a
// site (their management network) and a role (what sysDescr says they are); nothing is guessed from a name
const bare = buildRealModel({ devices: [
  { id: "EXT_NETWORK_DEVICE-B1", name: "core-sw-01.acme.com", monitoring_mode: "Extension", ip: ["10.9.0.1"], description: "Cisco IOS Software, Catalyst L3 Switch Software (CAT9K_IOSXE)" },
  { id: "EXT_NETWORK_DEVICE-B2", name: "edge-a.acme.com", monitoring_mode: "Extension", ip: ["10.9.1.1"], description: "Cisco IOS XE Software, ASR1000 Software" },
  { id: "EXT_NETWORK_DEVICE-B3", name: "fw1.acme.com", monitoring_mode: "Extension", ip: ["172.20.0.5"], description: "Palo Alto Networks PA-3220 series firewall" },
] }, "bare");
const bd = (n) => bare.devices.find((d) => d.name === n);
check("With nothing specific, devices are grouped by network and typed by what they report",
  bd("core-sw-01.acme.com")?.site === "Network 10.9.0.0/16" && bd("edge-a.acme.com")?.site === "Network 10.9.0.0/16" && bd("fw1.acme.com")?.site === "Network 172.20.0.0/16"
  && bd("core-sw-01.acme.com")?.role === "switch" && bd("edge-a.acme.com")?.role === "edge" && bd("fw1.acme.com")?.role === "firewall" && !bare.sites.CORE,
  bare.devices.map((d) => `${d.name}: ${d.site} · ${d.role}`).join(" | "));

// ---------------- a week of alerting, and what changed in the last 24 h ----------------
const al = model.alerting;
check("A week of Davis problems says whether anything watches the network devices",
  al && al.problems >= 2 && al.devices >= 1 && al.kinds.length >= 2 && al.recent.some((r) => r.end),
  al ? `${al.problems} problems on ${al.devices} devices · ${al.kinds.length} kinds · ${al.recent.filter((r) => r.end).length} closed in 24 h` : "not read");
check("No alerting read at all leaves the app without the week (rather than claiming zero)",
  buildRealModel({ devices: R.devices }, "x").alerting === undefined);

const changes = changesOf(model);
const kinds = (k) => changes.filter((c) => c.kind === k);
const members = (c) => c.members?.length ?? 1;
const total = (k) => kinds(k).reduce((a, c) => a + members(c), 0);
// the expected moment comes from the fixture itself, not from the clock: a suite that fails because the
// fixture aged teaches the team to ignore it
const rebootRow = (R["reboots:network_device"] ?? [])[0];
const rebootAt = rebootRow
  ? Date.parse(String(rebootRow.timeframe.start).replace(/(\.\d{3})\d*Z$/, "$1Z")) + (rebootRow.d.findIndex((v) => v < 0) + 1) * (Number(rebootRow.interval) / 1e6)
  : NaN;
check("A restart is found from sysUpTime stepping down, at the bucket it stepped",
  kinds("restart").length === 1 && Math.abs(Date.parse(kinds("restart")[0].t) - rebootAt) < 60e3,
  kinds("restart").map((c) => `${c.title} at ${c.t}`).join(" · ") + (Number.isFinite(rebootAt) ? ` · fixture says ${new Date(rebootAt).toISOString()}` : " · no fixture"));
check("The outage reaches the changes as devices that stopped answering and circuits that went down",
  total("unreachable") >= 3 && total("circuit-down") >= 1,
  `${total("unreachable")} unreachable · ${total("circuit-down")} circuits · ${total("alert-open")} alerts opened · ${total("alert-closed")} closed`);
check("A burst of the same change is one row that holds its members",
  changes.some((c) => c.members && c.members.length > 3) && changes.every((c) => !c.members || c.members.every((m) => m.kind === c.kind)),
  changes.filter((c) => c.members).map((c) => `${c.title} (${c.members.length})`).join(" · ") || "no burst");
check("An alert that opened with the silence it reports is named on that row, not repeated",
  kinds("unreachable").flatMap((c) => c.members ?? [c]).some((m) => /alert:/.test(m.detail))
  && !kinds("alert-open").flatMap((c) => c.members ?? [c]).some((m) => m.device && kinds("unreachable").flatMap((u) => u.members ?? [u]).some((s) => s.device === m.device)),
  kinds("unreachable").flatMap((c) => c.members ?? [c]).filter((m) => /alert:/.test(m.detail)).length + " folded");
check("Changes are newest first and never older than 24 h",
  changes.every((c, i) => i === 0 || Date.parse(changes[i - 1].t) >= Date.parse(c.t)) && changes.every((c) => Date.now() - Date.parse(c.t) <= 24 * 3600e3 + 60e3),
  `${changes.length} rows · oldest ${changes[changes.length - 1]?.t ?? "-"}`);

// ---------------- the map groups sites without losing any ----------------
const pts = Object.values(model.sites).filter((s) => !s.dc).map((s, i) => ({ code: s.code, x: (i % 40) * 9, y: Math.floor(i / 40) * 9, verdict: model.siteVerdicts?.[s.code] ?? "Healthy" }));
const dcAt = [{ x: 15, y: 15 }];
const { groups, of } = clusterPoints(pts, { dcs: dcAt });
const inGroups = groups.reduce((a, g) => a + g.n, 0);
check("Every site of a group is counted once, and the counts add up",
  groups.length > 0 && inGroups === new Set(groups.flatMap((g) => g.codes)).size && groups.every((g) => g.n === g.codes.length && g.crit + g.warn + g.healthy + g.other === g.n)
  && groups.every((g) => g.codes.every((c) => of.get(c) === g)),
  `${groups.length} groups · ${inGroups} of ${pts.length} sites`);
check("Groups do not overlap each other, and leave the data centers clear",
  groups.every((g, i) => groups.every((o, j) => i === j || Math.hypot(g.x - o.x, g.y - o.y) > g.r + o.r)) && groups.every((g) => dcAt.every((d) => Math.hypot(g.x - d.x, g.y - d.y) >= g.r + 17)),
  `smallest gap ${Math.round(Math.min(...groups.flatMap((g, i) => groups.map((o, j) => (i === j ? Infinity : Math.hypot(g.x - o.x, g.y - o.y) - g.r - o.r)))))} px`);
check("A group carries the worst status of its sites",
  groups.every((g) => worstOf(g) === (g.crit ? "Critical" : g.warn ? "Warning" : g.healthy ? "Healthy" : "Not monitored")) && CELL > 0);

// ---------------- the kept part of a log query plus the new part is the whole answer ----------------
const step = 900e3, win = 6 * 3600e3, n = win / step + 1;
const t0 = Math.floor(Date.now() / step) * step - (n - 1) * step;
const iso2 = (t) => new Date(t).toISOString();
const series = (from, count, vals) => [{ ip: "10.0.0.1", kind: "syslog", loglevel: "ERROR", n: vals, timeframe: { start: iso2(from), end: iso2(from + count * step) }, interval: String(step * 1e6) }];
const whole = Array.from({ length: n }, (_, i) => (i % 5 === 0 ? null : i));
const cut = n - 6; // the last 90 minutes arrive in the new part
const incS = { kind: "series", windowMs: win, stepMs: step, fields: ["n"], keys: ["ip", "kind", "loglevel"] };
const merged = mergeRows(incS, { query: "q", full: "q", base: series(t0, n, whole.slice(0, cut).concat(Array(n - cut).fill(null))), from: t0 + cut * step },
  series(t0 + cut * step, n - cut, whole.slice(cut)));
check("A series read in two parts is the series read whole, nulls included",
  JSON.stringify(merged[0]?.n) === JSON.stringify(whole) && merged[0]?.timeframe.start === iso2(t0),
  `${merged[0]?.n?.length ?? 0} buckets · ${whole.filter((v) => v === null).length} empty`);
const incN = { kind: "newest", windowMs: 3600e3, time: "timestamp", limit: 4 };
const rec = (t, what) => ({ timestamp: iso2(Date.now() - t * 60e3), what });
const kept = [rec(50, "a"), rec(40, "b"), rec(30, "c")], fresh = [rec(5, "e"), rec(15, "d")];
const newest = mergeRows(incN, { query: "q", full: "q", base: kept, from: Date.now() - 20 * 60e3 }, fresh);
check("Newest records: the new part rules from the cut, the kept part answers before it",
  newest.map((r) => r.what).join("") === "edcb" && newest.length === 4,
  newest.map((r) => r.what).join(""));
const incL = { kind: "latest", windowMs: 30 * 60e3, time: "seen", keys: ["a", "b"] };
const latest = mergeRows(incL, { query: "q", full: "q", base: [{ a: "1", b: "x", seen: iso2(Date.now() - 25 * 60e3) }, { a: "2", b: "y", seen: iso2(Date.now() - 40 * 60e3) }], from: Date.now() - 20 * 60e3 },
  [{ a: "1", b: "x", seen: iso2(Date.now() - 2 * 60e3) }]);
check("Latest seen: one row per key, the newest time, and what fell out of the window is gone",
  latest.length === 1 && latest[0].a === "1" && Date.now() - Date.parse(latest[0].seen) < 3 * 60e3,
  latest.map((r) => `${r.a}${r.b}`).join(","));

// ---------------- the journey draws itself after the data ----------------
const convs = model.flowMap?.conversations ?? [];
if (convs.length) {
  const j = buildJourney(convs, model.sites);
  const bytesIn = convs.reduce((a, c) => a + c.bytes, 0), bytesOut = j.routes.reduce((a, r) => a + r.bytes, 0);
  check("Every conversation lands on one path of the journey, and the bytes are kept",
    Math.abs(bytesIn - bytesOut) < 1 && j.routes.every((r) => j.nodes.some((n) => n.id === r.from) && j.nodes.some((n) => n.id === r.via) && j.nodes.some((n) => n.id === r.to)),
    `${j.routes.length} paths · ${Math.round(bytesOut / 1e9)} GB of ${Math.round(bytesIn / 1e9)} GB`);
  const trivial = { routes: [{ bytes: 97 }, { bytes: 3 }] }, crossing = { routes: [30, 25, 20, 15, 10].map((b) => ({ bytes: b })) };
  check("Ranked paths when nothing crosses, the flow diagram when it does",
    asRoutes(trivial) && !asRoutes(crossing) && asRoutes({ routes: [{ bytes: 90 }, { bytes: 4 }, { bytes: 3 }, { bytes: 3 }] }) && !asRoutes(j) === (j.routes.length > 3 && j.routes[0].bytes < 0.8 * bytesOut),
    `this estate: ${j.routes.length} paths, heaviest ${Math.round((100 * j.routes[0].bytes) / bytesOut)}% → ${asRoutes(j) ? "paths" : "flow"}`);
}

// the per-device summary is the only interface data a large estate reads: it has to measure what the
// per-port series measures, or a saturated link reads as a quiet one
const bothKnown = model.devices.filter((d) => d.ifStats?.maxUtil != null && d.interfaces.some((i) => i.util != null && i.util <= 100));
check("The device summary and its own ports agree on utilisation",
  bothKnown.length > 0 && bothKnown.every((d) => {
    const ports = Math.max(...d.interfaces.filter((i) => i.util != null && i.util <= 100).map((i) => i.util));
    return Math.abs(ports - d.ifStats.maxUtil) <= Math.max(1, ports * 0.05);
  }),
  bothKnown.slice(0, 3).map((d) => `${d.name}: summary ${d.ifStats.maxUtil}% vs ports ${Math.max(...d.interfaces.filter((i) => i.util != null && i.util <= 100).map((i) => i.util))}%`).join(" · ") || "no device with both");

// the bucket is a cost step, not a coverage one: it appears with the environment's own numbers, says
// nothing to do when the logs are already the network's, and disappears once the buckets are named
const bucketStep = (opts) => nextSteps(model, needs, opts).find((s) => s.id === "bucket");
const busyBucket = bucketStep({ cost: { logGb: 138, networkShare: 0.0002 } });
check("The bucket recommendation carries this environment's own numbers",
  busyBucket && !busyBucket.done && /138.0 GB/.test(busyBucket.unlocks) && /0.02%/.test(busyBucket.unlocks)
  && bucketStep({ cost: { logGb: 0.3, networkShare: 0.01 } }) === undefined
  && bucketStep({ cost: { logGb: 138, networkShare: 0.0002 }, bucketsSet: true })?.done === true
  && bucketStep({ cost: { logGb: 20, networkShare: 0.8 } })?.done === true,
  busyBucket ? busyBucket.unlocks.slice(0, 120) : "missing");
check("The share of the app in use is not moved by a cost step",
  coverage(nextSteps(model, needs, { all: true, cost: { logGb: 138, networkShare: 0.0002 } }).filter((s) => s.id !== "bucket"))
  === coverage(nextSteps(model, needs, { all: true }).filter((s) => s.id !== "bucket")));

// ---------------- a drawing that says "size = devices" has to mean it ----------------
// A floor on the radius drew three devices and thirty as the same circle, in an environment where that
// was every bubble on the page.
const areaOf = (n, most) => Math.PI * bubbleRadius(n, most) ** 2;
check("A bubble ten times bigger covers ten times the area",
  Math.abs(areaOf(300, 300) / areaOf(30, 300) - 10) < 0.01 && bubbleRadius(1, 4000) >= 22,
  `${(areaOf(300, 300) / areaOf(30, 300)).toFixed(2)}x`);

// ---------------- nothing measured is not the same as nothing wrong ----------------
// A site the environment never reported a session for was drawn red with a dash where the number goes,
// which reads as an outage at a site that is simply not covered by end-user monitoring.
const app = (extra) => ({ name: "x", sessions: 0, p90Ms: null, errPct: null, consequenceOf: null, transactions: [], ...extra });
const never = appVerdict(app({}));
const stopped = appVerdict(app({ baselineSessions: 400 }));
check("A site that never reported sessions is not judged, one that stopped is",
  never[0] === "Not monitored" && stopped[0] === "Critical", `${never[0]} · ${stopped[0]}`);

// ---------------- a hook after a conditional return breaks the page at runtime ----------------
const badHooks = hooksAfterReturn();
check("No component calls a hook after an early return",
  badHooks.length === 0,
  badHooks.map((b) => `${b.file}:${b.line} ${b.fn} · ${b.hook}`).join(" · ") || "none");

// ── Ahead: the refusals, which are the whole point of the module ──────────────────────────────
// Each of these locks in something a live measurement caught the earlier version getting wrong.
const ramp = (n, a, b) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const wobble = (n, mid, amp) => Array.from({ length: n }, (_, i) => mid + amp * Math.sin(i * 2.4));

// Measured on two environments: of 21 series whose rise passed the noise test, 19 held a step and
// 13 were flat after it. A host that jumped 27 → 46 and held would have been called saturating in
// 39 days. The fit has to run on the regime after the change, which here has no slope at all.
//
// These series are hourly, because that is what the app reads: a fortnight of hours per port, not
// a month of days. The detector needs two days of record and twelve hours either side of a split
// before it will name a step, so a thirty-point fixture tests nothing — it is below the floor and
// passes by never being asked. Three days at one level and three at the next is the smallest
// honest version of the same shape.
const stepped = [...wobble(72, 27, 1.5), ...wobble(72, 46, 1.5)];
const sr = read(stepped);
check("A series that steps and then holds is a change, not a forecast",
  sr.state === "changed" && sr.fit && sr.fit.mid === null,
  `${sr.state} · step ${sr.step ? `${sr.step.from.toFixed(0)}→${sr.step.to.toFixed(0)}` : "none"} · date ${sr.fit?.mid ?? "none"}`);

check("The step is found where it happened",
  sr.step && Math.abs(sr.step.at - 72) <= 1, `at ${sr.step?.at}`);

// A rise smaller than the noise it sits in is not a rise. The earlier gate only asked slope > 0.
const noisy = Array.from({ length: 30 }, (_, i) => 50 + i * 0.08 + (i % 2 ? 8 : -8));
const nr = read(noisy);
check("A rise inside the noise produces no date",
  nr.fit && !nr.fit.rising && nr.fit.why === "the rise is inside the noise" && nr.fit.mid === null,
  nr.fit?.why ?? "no fit");

// 180 days from 30 is a six-fold extrapolation whose band assumes the line still holds out there.
const slow = ramp(30, 40, 44);
const sl = fitLine(slow);
check("The horizon never runs past twice the record", sl && sl.far === 60, `far ${sl?.far}`);
check("A crossing beyond that horizon is not reported as a date",
  sl && sl.rising && sl.mid === null, `rising ${sl?.rising} · date ${sl?.mid ?? "none"}`);

// A climb the record can carry still has to produce one.
const fast = ramp(144, 60, 92);
const fr = read(fast);
check("A climb that does reach the limit inside the horizon keeps its date",
  fr.state === "climbing" && fr.fit?.mid != null && fr.fit.mid <= fr.fit.far,
  `${fr.state} · ${fr.fit?.mid ?? "none"}h of ${fr.fit?.far}`);

// The mirror of the step test, and the reason it has to be long enough to reach the detector: a
// smooth ramp splits into two well-separated halves and was called a change, which cost every
// real trend its forecast. The guard is that a split must beat a straight line, not just a
// constant — a check that only means something on a series the detector will look at.
check("A smooth ramp is a trend, not a step", findStep(fast) === null, `${findStep(fast) ? "step found" : "no step"}`);

// "Close" is the subject's own largest rise, never a number the app chose.
const edgy = [...wobble(72, 55, 1), ...wobble(72, 78, 1)];
check("One jump from the limit measures the jump the subject has already made",
  Math.abs(jumpOf(edgy, findStep(edgy)) - 23) < 2 && read(edgy).jump > 20,
  `jump ${jumpOf(edgy, findStep(edgy)).toFixed(1)} pts`);

// 40% of interfaces on one environment carry a discard counter that has been non-zero for months.
const steady = wobble(30, 30, 2);
check("A discard counter that is not rising does not make a subject urgent",
  read(steady, 0).state !== "dropping" && read(steady, 5000).state === "dropping",
  `${read(steady, 0).state} / ${read(steady, 5000).state}`);

// Nothing reported disappears: a subject with no claim still says why.
const hushed = read(wobble(30, 20, 1));
check("A subject with nothing to say still carries a reason",
  hushed.state === "quiet" && !!silenceReason(hushed), silenceReason(hushed));

// "Changed" is a finished event. One that stepped and is still climbing has a live date, and
// hiding it under the label of the past event is the first mistake in reverse.
const steppedThenClimbs = [...wobble(14, 40, 1.2), ...ramp(16, 56, 80)];
const liveStep = read(steppedThenClimbs);
// The invariant the change actually guarantees: a live date is never filed away as a finished
// event. ("Stepped and still climbing" is usually caught by "one jump from a limit" first, because
// a step large enough to detect is usually large enough to arrive on its own — which is a fair
// verdict and a more urgent one.)
check("A subject with a live date is never filed as a finished change",
  liveStep.fit?.mid != null && liveStep.state !== "changed"
  && read([...ramp(30, 60, 92)]).state !== "changed",
  `${liveStep.state} · date ${liveStep.fit?.mid ?? "none"}`);
// "Settles" is the harder half: the regime after the step need not be perfectly flat, it only has
// to be going nowhere that matters. This one drifts a point and a half over its three days — a
// real slope, fitted honestly, arriving at the limit long past the horizon the record allows. It
// is still the change that happened, not a forecast.
const settled = [...wobble(72, 27, 1.5), ...ramp(72, 46, 47.5)];
const sd = read(settled);
check("A step that settles stays a change",
  sd.state === "changed" && sd.fit?.mid === null, `${sd.state} · date ${sd.fit?.mid ?? "none"}`);

// ── Ahead: busy-hour headroom, and the ceilings it refuses to invent ─────────────────────────
// Measured on a live environment: the busy hour sits 2.93× above the mean, and 85% of the hours
// in which a port discarded were below half its line rate. These lock in what the reading may
// and may not conclude from that.
const flatWithPeaks = Array.from({ length: 24 * 10 }, (_, i) => (i % 24 === 18 ? 60 : 20));
check("The busy hour is the busy hour, not the average",
  busyHour(flatWithPeaks) === 60 && Math.abs(quantile(flatWithPeaks, 0.5) - 20) < 0.01,
  `busy ${busyHour(flatWithPeaks)} · median ${quantile(flatWithPeaks, 0.5)}`);

// A port that discards in nearly every hour is not telling you a level; it is telling you it is
// broken. Measured: the median discarding port drops in 62% of its hours, and none in under 5%.
const always = Array.from({ length: 240 }, () => 30);
check("A port that discards in almost every hour demonstrates no ceiling",
  shownCeiling(always, always.map(() => 1)) === null, "null");

// One that separates does: clean below, discarding above.
const split = Array.from({ length: 240 }, (_, i) => (i % 4 === 0 ? 55 : 20));
const splitD = split.map((u) => (u > 50 ? 3 : 0));
const shown = shownCeiling(split, splitD);
check("A port that discards only when loaded shows where its trouble starts",
  shown !== null && shown >= 50 && shown <= 60, `${shown}`);

// And the headroom falls back to the stated limit rather than inventing one.
const idleRun = Array.from({ length: 240 }, () => 12);
const hq = headroomOf(idleRun, undefined);
check("With no discard evidence the ceiling is the one its owner stated",
  hq !== null && hq.source === "stated" && hq.ceiling === 100 && Math.abs(hq.pts - 88) < 1,
  `${hq?.source} · ${hq?.pts.toFixed(0)} pts`);

const hs = headroomOf(split, splitD);
check("A demonstrated ceiling leaves less room than the line rate would",
  hs !== null && hs.source === "shown" && hs.pts < (100 - hs.busy),
  hs ? `${hs.source} · ${hs.pts.toFixed(0)} pts against ${(100 - hs.busy).toFixed(0)} by the line rate` : "none");

// The whole point: a reading that exists where a crossing date does not.
const nothingHappening = Array.from({ length: 240 }, (_, i) => 9 + Math.sin(i / 3) * 0.4);
check("An estate with no crossing still has a headroom for every subject",
  fitLine(nothingHappening)?.mid == null && headroomOf(nothingHappening) !== null,
  `date ${fitLine(nothingHappening)?.mid ?? "none"} · room ${headroomOf(nothingHappening)?.pts.toFixed(0)} pts`);

// An SNMP counter that wraps, or a poll gap that makes one delta cover several intervals,
// arrives as a single enormous hour. Measured: 172 of 397 interfaces with a line rate report at
// least one hour above 100% of it. The busy hour is the median of the daily maxima, so exactly
// one such hour per day is enough to make every daily maximum fiction.
const withArtefact = Array.from({ length: 24 * 8 }, (_, i) => (i % 24 === 5 ? NaN : 20));
check("One impossible hour a day does not become the busy hour",
  busyHour(withArtefact) === 20, `${busyHour(withArtefact)}`);

const roomA = headroomOf(withArtefact);
check("Headroom is measured from the hours that happened",
  roomA !== null && Math.abs(roomA.pts - 80) < 1, `${roomA?.pts.toFixed(0)} pts`);

// ── Ahead: the record half of the runway, and the tag sequence ───────────────────────────────
// The left of the chart is not a forecast, so every point on it has to be a day the series was
// actually over the line. A subject that touched the limit once and fell back has not arrived.
check("A touch of the limit that does not hold is not a crossing",
  crossedAgo([...wobble(20, 60, 3), 104, ...wobble(9, 62, 3)]) === null, "no crossing");
check("A crossing that holds is dated from the record",
  crossedAgo([...wobble(14, 80, 2), ...wobble(16, 107, 2)]) === 15,
  String(crossedAgo([...wobble(14, 80, 2), ...wobble(16, 107, 2)])));

// A probability carries what a date hides: at one day out the answer is nearly yes or no, at
// thirty it is a genuine maybe, and it must never run backwards as the horizon widens.
const climb = fitLine(ramp(30, 60, 92));
check("The chance of crossing only grows with the horizon",
  [1, 5, 10, 20, 30].every((d, i, a) => i === 0 || chanceBy(climb, d) >= chanceBy(climb, a[i - 1])),
  [1, 10, 30].map((d) => `${d}d ${(chanceBy(climb, d) * 100).toFixed(0)}%`).join(" · "));

// The backtest has to be able to fail, or it is decoration. A series that turns after the cut
// is one the earlier record could not have predicted, and the test must say so.
//
// It cuts at two thirds and fits what is behind the cut, so the series has to be long enough that
// the earlier part clears the fit's own floor of twenty-four points. At thirty the cut left
// twenty, no fit was possible, and the test reported "no backtest" — which is not a pass.
const turns = [...ramp(80, 30, 70), ...ramp(40, 70, 20)];
const bt = backtest(turns);
check("A backtest can fail, and does when the series turns", bt && bt.grade === "poor",
  bt ? `${bt.grade} · ${bt.inBand}/${bt.of}` : "no backtest");

// Changes cluster: measured, sixteen fell on seven days with six on one. A change on its own is
// a single, not an estate-wide event.
//
// `ago` is in hours, like every other age in the module, and this fixture used to feed it bare
// numbers that had been written when the window was daily — so the window could silently shrink
// from a day to an hour and the suite stayed green while one estate-wide change split into a
// dozen singles on screen. The hours are explicit now, and the check asserts both sides: what
// belongs to the event, and what is far enough away to be left out of it.
const subjAt = (ago, site) => ({ site, name: `p${ago}${site}`, reading: { now: 50, hist: [], step: { ago, from: 30, to: 50, t: 9 }, state: "changed" } });
const cl = clusterChanges([subjAt(20, "a"), subjAt(26, "b"), subjAt(38, "c"), subjAt(70, "d"), subjAt(200, "e")]);
check("Changes within a day are one event, and one days later is not",
  cl.events.length === 1 && cl.events[0].members.length === 3 && cl.singles.length === 2,
  `${cl.events.length} event of ${cl.events[0]?.members.length} · ${cl.singles.length} singles`);

// The tag sequence narrows without changing what is counted.
const where = { a1: { c: "br", u: "sp" }, a2: { c: "br", u: "rs" }, a3: { c: "us", u: "ga" } };
const mk = (site) => ({ site, name: site, reading: { now: 40, hist: [], step: null, state: "quiet", fit: null } });
const all = [mk("a1"), mk("a2"), mk("a3")];
const resolve = (site, key) => where[site]?.[key === "country" ? "c" : "u"];
check("A tag path narrows the set and nothing else",
  narrow(all, ["country", "uf"], [], resolve).length === 3
  && narrow(all, ["country", "uf"], ["br"], resolve).length === 2
  && narrow(all, ["country", "uf"], ["br", "sp"], resolve).length === 1,
  "3 / 2 / 1");
check("A site with no value for a level is counted, not dropped",
  branchesAt(all.concat(mk("zz")), ["country"], [], resolve).some((b) => b.value === "Not tagged"),
  branchesAt(all.concat(mk("zz")), ["country"], [], resolve).map((b) => b.value).join(" "));

// ── Ahead, over the estate the generator builds ──────────────────────────────────────────────
//
// Everything above this line is the module read on arrays written by hand. That is how it was
// tested until now, and it was not enough: over the generated estate `aheadSubjects` returned
// zero subjects, so the page those arrays stand for — the states, the census, the silences, the
// clustering of changes, the room and the context Assist is given — ran against nothing at all.
// A suite can be green on a module and blind to the page it builds.
//
// The generator now carries the hourly record the page reads, and `scenario.ahead` names the
// subject it built for each state, so these checks say what the estate must come out as.
const subjects = aheadSubjects(model);
const ah = scenario.ahead;
const portOf = (n) => subjects.find((s) => s.key === `port:${ah[n].device}:${ah[n].port}`);
const census = aheadCensus(subjects);

check("The estate reaches the Ahead page, in every state the page can report",
  subjects.length > 0 && STATES.every((st) => census.counts[st] > 0)
  && ["port", "device", "memory"].every((k) => subjects.some((s) => s.kind === k)),
  `${subjects.length} subjects · ${STATES.map((st) => `${st} ${census.counts[st]}`).join(" · ")}`);

// Each state was generated on purpose, from a shape a live environment actually produces. If a
// port generated as a level change arrives as a forecast, one of the two is wrong and the suite
// has to say which.
const WANT = { changedA: "changed", changedB: "changed", changedC: "changed", changedAlone: "changed",
  climbing: "climbing", oneJump: "onejump", dropping: "dropping", beyondHorizon: "quiet",
  insideNoise: "quiet", falling: "quiet", tooShort: "quiet", showsCeiling: "quiet", dropsEarly: "quiet" };
const miscast = Object.entries(WANT).filter(([n, st]) => portOf(n)?.reading.state !== st);
check("Every generated subject arrives in the state it was generated for",
  miscast.length === 0 && subjects.find((s) => s.key === `cpu:${ah.cpuStep}`)?.reading.state === "changed"
  && subjects.find((s) => s.key === `mem:${ah.memClimb}`)?.reading.state === "climbing",
  miscast.map(([n, st]) => `${n}: wanted ${st}, got ${portOf(n)?.reading.state ?? "no subject"}`).join(" · ") || "all 13 ports, the processor and the memory");

// The census is the page's own account of what it measured, so it has to add up to what it has.
const nothingToSay = subjects.filter((s) => s.reading.state === "quiet");
check("The census states partition the subjects, with nothing counted twice and nothing left out",
  census.total === subjects.length
  && STATES.reduce((a, st) => a + census.counts[st], 0) === subjects.length
  && STATES.every((st) => census.counts[st] === subjects.filter((x) => x.reading.state === st).length),
  `${STATES.reduce((a, st) => a + census.counts[st], 0)} counted of ${subjects.length}`);

// A subject with nothing to say is not a gap in the page: it is a reading, and the reason is the
// reading. Every one of the four reasons the module can give is reached by this estate.
check("Every silent subject carries a reason, and the reasons add up to the silence",
  nothingToSay.length > 0 && nothingToSay.every((s) => !!silence(s.reading))
  && nothingToSay.every((s) => census.why[silence(s.reading)] > 0)
  && Object.values(census.why).reduce((a, b) => a + b, 0) === nothingToSay.length
  && ["too little record", "flat or falling", "the rise is inside the noise",
    "reaches the limit beyond what the record can see"].every((w) => census.why[w] > 0),
  Object.entries(census.why).map(([w, n]) => `${w}: ${n}`).join(" · "));

// Measured on one environment: sixteen changes fell on seven days with six of them on a single
// day. Three ports at three sites step within the same hour here, and one steps ten days later.
const estate = clusterChanges(subjects.filter((s) => s.reading.state === "changed"));
const migration = estate.events.find((e) => ["changedA", "changedB", "changedC"]
  .every((n) => e.members.some((m) => m.key === portOf(n)?.key)));
check("Ports that changed together are one event across their sites, and one that changed alone is a single",
  // the three step at one declared moment, but each series is bucketed from its own start, so they
  // can land in adjacent hours — they did align exactly on an earlier estate, and that was the
  // estate's doing, not the clustering's. What the event has to hold is the three of them, at their
  // three sites, inside the window: the spread is checked as small rather than as zero.
  !!migration && migration.members.length === 3 && migration.spread <= 1 && migration.sites === 3
  && Math.abs(migration.ago - ah.changedAgo) <= 24
  && estate.singles.some((s) => s.key === portOf("changedAlone")?.key),
  migration ? `${migration.members.length} members · ${migration.sites} sites · spread ${migration.spread} h · ${migration.ago} h ago · ${estate.singles.length} singles`
    : `no event holds the three: ${estate.events.map((e) => `${e.members.length}@${e.ago}`).join(" ")}`);

// The left half of the runway is the record and not a projection, and a tag path has to carry it
// without losing a subject. A port cannot reach this state — an hour over the line rate is
// dropped as impossible — so the one that has is the processor with a runaway process on it.
const tagOf = (site, key) => (key === "region" ? model.sites[site]?.region : model.sites[site]?.uf);
const branches = branchesAt(subjects, ["region", "uf"], [], tagOf);
const over = subjects.filter((s) => crossedAgo(s.reading.hist) != null);
check("A tag cut keeps every subject and counts the ones the record already shows over a limit",
  branches.reduce((a, b) => a + b.subjects.length, 0) === subjects.length
  && branches.reduce((a, b) => a + b.past, 0) === over.length
  && over.some((s) => s.key === `cpu:${ah.cpuPegged}`),
  `${branches.length} branches · ${over.length} already over a limit · ${over.map((s) => s.key).slice(0, 3).join(", ")}`);

// ── Ahead: every forward number is the analyzer's ────────────────────────────────────────────
//
// The page draws the Dynatrace forecast and says so in its legend. The three numbers behind it
// that were still a least-squares line of this app's own are gone, and the last of them was the
// one Assist was given: "reaches: between 9 and 14 days", from arithmetic of ours, in the one
// place a reader cannot see where a number came from.
//
// So the check is not that the context carries a date. It is that it carries one *only* when the
// analyzer answered, for exactly the subjects it answered for — while the app's own fit still has
// a date for the climbing port and must not be allowed to speak it. The analyzer is an API and
// not a Grail store, so its answer is built here rather than generated: one value an hour, per
// cent of the subject's own limit, with the band a forecast comes back with.
const DAVIS_HRS = 240;
const reaching = (start, at) => Array.from({ length: DAVIS_HRS }, (_, h) => start + ((100 - start) * h) / at);
/* upper crosses in hour 47, the point forecast in 119, lower in 215: day 2 to day 9 */
const answer = { point: reaching(80, 119), upper: reaching(90, 47), lower: reaching(70, 215), quality: "VALID" };
const climber = portOf("climbing");
const ownDays = Math.round((climber?.reading.fit?.mid ?? 0) / 24);
const forward = (ctx) => [...ctx.dropping, ...ctx.oneJumpAway, ...ctx.climbing];

const unanswered = aheadContext(model);
check("With nothing from the analyzer, the context names no day — not even for the subject the app's own line has a date for",
  climber?.reading.fit?.mid != null && forward(unanswered).length > 0
  && forward(unanswered).every((x) => x.reaches === "the analyzer has no forecast for this one")
  && unanswered.room.length > 0 && unanswered.room.every((x) => x.pointsPerDay === null)
  && !/\d+ days/.test(JSON.stringify(forward(unanswered))),
  `${forward(unanswered).length} subjects, none dated · the app's own line puts ${climber?.name} at the limit in ${ownDays} days`);

// Every subject but one is answered for, so the one left out is the whole difference between the
// two sentences the context may say.
const answered = new Map(subjects.filter((s) => s.key !== climber?.key).map((s) => [s.key, answer]));
const partly = aheadContext(model, answered);
const silentOnes = forward(partly).filter((x) => x.reaches === "the analyzer has no forecast for this one");
check("A subject the analyzer answered for is dated from its band, and the one it did not says so",
  silentOnes.length === 1
  && forward(partly).filter((x) => x.reaches !== silentOnes[0].reaches).every((x) => x.reaches === "between 2 and 9 days")
  && ownDays !== 2 && ownDays !== 9,
  `${forward(partly).map((x) => x.reaches).join(" | ")} · the app's own line would have said ${ownDays} days`);

// The rise beside each room is the analyzer's own over its first day, not a slope of this app's.
const fully = aheadContext(model, new Map(subjects.map((s) => [s.key, answer])));
check("The rise per day beside a room is the analyzer's first day, not a slope of the app's",
  fully.room.length > 0 && fully.room.every((x) => x.pointsPerDay === 3.87),
  [...new Set(fully.room.map((x) => String(x.pointsPerDay)))].join(", "));

// The reading that exists where a date does not, measured over the estate rather than one array:
// a room for nearly every subject, against a ceiling the port demonstrated where the record
// separates and against the rate on its label everywhere else.
const shownRooms = subjects.filter((s) => s.room?.source === "shown");
check("Room is measured for the estate, against a demonstrated ceiling only where the record separates",
  subjects.filter((s) => s.room).length >= subjects.length - 1
  && shownRooms.length > 0 && shownRooms.every((s) => s.room.ceiling >= 50)
  && shownRooms.some((s) => s.key === portOf("showsCeiling")?.key)
  && portOf("dropsEarly")?.room?.source === "stated" && portOf("dropsEarly")?.room?.dropsAt < 50,
  `${subjects.filter((s) => s.room).length}/${subjects.length} with a room · ${shownRooms.length} against a ceiling they showed`
  + ` · the policed port drops at ${portOf("dropsEarly")?.room?.dropsAt} and keeps its stated limit`);

// The name the map writes, for an estate whose site names are mailing addresses. Both shapes below
// are the shapes real site_name tags are written in — deliberately not anyone's actual address:
// written in
// full they are three hundred pixels of text, so the map dropped most of its labels and the ones it
// kept read as a column of addresses. The city and the region place the site; the street does not.
const SHORT = [
  ["100 Example Road, Fairview, KS, USA 66000", "Fairview, KS"],
  ["SDC:A000.00:200 Example Parkway:Brookfield:NC:27000", "Brookfield, NC"],
  ["Rua Vergueiro 1000, Sao Paulo, SP, Brasil 04101-000", "Sao Paulo, SP"],
  ["100 Main Street, Springfield, Illinois, USA", "Springfield, Illinois"],
  // the state code and the country code are the same two letters in half the estate: `CA`, `IN`,
  // `DE`, `SC`. Both of these keep their state, or the same estate is labelled two ways.
  ["500 Capitol Mall, Sacramento, CA, USA 95814", "Sacramento, CA"],
  ["1 Monument Circle, Indianapolis, IN, USA 46204", "Indianapolis, IN"],
];
check("An address-shaped site name is cut to the city and the region the map needs",
  SHORT.every(([raw, want]) => shortSiteName(raw) === want),
  SHORT.map(([raw, want]) => `${shortSiteName(raw)}${shortSiteName(raw) === want ? "" : ` (wanted ${want})`}`).join(" · "));

// A name the team chose is better than anything this can derive from it, so only an address is
// touched: no street, no postal code and no country means the string goes to the map as it is.
const KEPT = ["Harbour DC", "Sao Paulo, BR", "HQ", "Fairview, KS", "Dallas Hub, Texas", "Site 42", "", "   "];
check("A site name that is a name reaches the map unchanged",
  KEPT.every((n) => shortSiteName(n) === n.trim()),
  KEPT.filter((n) => shortSiteName(n) !== n.trim()).map((n) => `${n} became ${shortSiteName(n)}`).join(" · ") || "all kept");

// Whatever it returns has to be a name a reader can act on: never empty, never longer than it
// started, and never the postal code or the facility code on its own.
check("The shortened name is shorter, non-empty, and never only a code",
  SHORT.every(([raw]) => {
    const out = shortSiteName(raw);
    return out.length > 0 && out.length < raw.length && !/^\d+$/.test(out) && /[a-z]/.test(out);
  }),
  SHORT.map(([raw]) => `${raw.length} → ${shortSiteName(raw).length}`).join(" · "));

// Placing a site that nobody tagged. The table of every admin-1 centre is fetched on demand, so
// the suite waits for it the way the app rebuilds its model when it lands.
await ensurePlaces();
check("The centre of every region on earth loads", placesReady(), placesReady() ? "loaded" : "not loaded");

const near = (p, lat, lon) => !!p && Math.abs(p.lat - lat) < 0.5 && Math.abs(p.lon - lon) < 0.5;
check("A state code places a site at the centre of that state, anywhere in the world",
  near(regionOf("KS", ["US"]), 39.18, -96.19) && near(regionOf("NC", ["US"]), 35.47, -77.62)
  && near(regionOf("SP", ["BR"]), -22.55, -48.01) && !!regionOf("Bayern", ["DE"]) && !!regionOf("Hokkaido", ["JP"]),
  ["US/KS", "US/NC", "BR/SP", "DE/Bayern", "JP/Hokkaido"].map((k) => {
    const [cc, t] = k.split("/"); const r = regionOf(t, [cc]); return `${k}=${r ? r.region : "none"}`;
  }).join(" · "));

// A code is not unique: KS is Kansas, Kassala, Kasungu, Kissidougou, Krsko and Kalimantan Selatan.
// Resolving it inside the wrong country would put a site in the wrong hemisphere, which is worse
// than leaving it off the map, so two candidates means none.
check("An ambiguous region code is refused rather than guessed",
  regionOf("KS", ["US", "SD"]) === null && regionOf("KS", []) === null && regionOf("SP", ["BR", "IT"]) === null
  && near(regionOf("KS", ["SD"]), 11.2, 29.6),
  `with US+SD ${regionOf("KS", ["US", "SD"]) ? "placed" : "refused"} · with nothing known ${regionOf("KS", []) ? "placed" : "refused"}`
  + ` · with SD alone ${regionOf("KS", ["SD"])?.region ?? "refused"}`);

// The country is read off the same name, digits and all: the last field of a US address is the
// country and the postal code in one part, and reading it whole found no country.
check("The country is read from the name, including when a postal code is stuck to it",
  countryOf("USA 66000") === "US" && countryOf("USA") === "US" && countryOf("U.S.A.") === "US"
  && countryOf("Germany") === "DE" && countryOf("DEU") === "DE" && countryOf("Brazil") === "BR"
  && countryOf("KS") === null && countryOf("CA") === null,
  `USA 66000=${countryOf("USA 66000")} · DEU=${countryOf("DEU")} · two letters refused: ${countryOf("CA") === null}`);

// End to end on the shapes a site name is actually written in: the parts, the country in them, and
// the region those two together resolve to.
const PLACES = [
  ["100 Example Road, Fairview, KS, USA 66000", "US", "Kansas"],
  ["SDC:A000.00:200 Example Parkway:Brookfield:NC:27000", null, "North Carolina"],
  ["Rua Exemplo 100, Centro, SP, Brazil 01000-000", "BR", "São Paulo"],
];
check("A site name that names a state is placed in it, with the country from the name or the estate",
  PLACES.every(([name, cc, want]) => {
    const parts = addressParts(name);
    const own = parts.map(countryOf).filter(Boolean);
    if (cc !== null && own[0] !== cc) return false;
    // the second shape states no country: the estate's own anchor stands in, as it does in the model
    const scope = own.length ? own : ["US"];
    return parts.map((t) => regionOf(t, scope)).find(Boolean)?.region === want;
  }),
  PLACES.map(([name]) => {
    const parts = addressParts(name);
    const own = parts.map(countryOf).filter(Boolean);
    const r = parts.map((t) => regionOf(t, own.length ? own : ["US"])).find(Boolean);
    return r ? `${r.cc}/${r.region}` : "unplaced";
  }).join(" · "));

// A device naming convention is read from whatever subdivision code that country writes. Two
// letters is the United States and Brazil; almost everywhere else is something else, and an estate
// using its own country's codes used to be read as having no convention at all.
const NAMED = [
  ["DE-HE-FRA1-SWT1", "FRA1", "switch"],
  ["GB-MAN-MCR1-RTR1", "MCR1", "edge"],
  ["JP-13-TKY1-CON1", "TKY1", "core"],
  ["MX-BCN-TIJ1-FWL1", "TIJ1", "firewall"],
  ["US-KS-FRV1-SWA-001", "FRV1", "switch"],
];
check("A device naming convention is read whatever subdivision code the country writes",
  NAMED.every(([name, site, role]) => {
    const d = deriveTags(name);
    return d.matched && d.site === site && d.role === role;
  }),
  NAMED.map(([name]) => { const d = deriveTags(name); return `${name}→${d.matched ? `${d.site}/${d.role}` : "no match"}`; }).join(" · "));

// The version the tooling prints is package.json's, and the version the environment installs is
// app.config.json's. They drifted four months apart, and the line a customer saw on their own
// console named a different product at a version that did not exist any more.
const pkg = JSON.parse(readFileSync(new URL("../../app/package.json", import.meta.url), "utf8"));
const appCfg = JSON.parse(readFileSync(new URL("../../app/app.config.json", import.meta.url), "utf8"));
check("The package and the app agree on what this is and which version it is",
  pkg.version === appCfg.app.version && pkg.name === appCfg.app.id.split(".").slice(1).join("-"),
  `package ${pkg.name}@${pkg.version} · app ${appCfg.app.id}@${appCfg.app.version}`);

// Where the forecast window ends, which is the difference between an estate having a forecast and
// being told it has none. Measured on a live environment whose collection had stopped for two days:
// a window ending now answered OK over 49 empty hours followed by 23 recorded ones, and the same
// series cut back to before that gap FAILED, because the shortened window ends inside the outage.
const run = (pattern) => [...pattern].map((c) => (c === "." ? null : 1));
const WINDOWS = [
  // the measured environment: the gap is at the far edge of the last day and the record resumed
  ["gap then a day of record", ".#######################", 0, 24],
  // collection is still down: the empty hours are at the end and have to come off
  ["collection still down", "###################.....", 5, 5],
  // nothing missing: ask for now and never cut
  ["unbroken", "########################", 0, 0],
  // a hole a few hours short of now: ask for now first, and the fallback cuts back to before it
  ["hole near the end", "########.............###", 0, 16],
];
check("The forecast window reaches now unless the empty hours are at the end",
  WINDOWS.every(([, p, ends]) => forecastWindow(run(p)).ends === ends),
  WINDOWS.map(([n, p]) => `${n}: ends ${forecastWindow(run(p)).ends}`).join(" · "));

check("A cut back to before the last gap is kept as the fallback, never as the first ask",
  WINDOWS.every(([, p, ends, before]) => {
    const w = forecastWindow(run(p));
    return w.before === before && w.before >= w.ends;
  }),
  WINDOWS.map(([n, p]) => { const w = forecastWindow(run(p)); return `${n}: ${w.ends}→${w.before}`; }).join(" · "));

// What the Live map costs, and what it pays for a page nobody has opened. Measured on an
// environment with NetFlow: flowTs scans 9.4 GB and flowFanIn 8.0 GB, half of a 35 GB load, and
// neither is drawn anywhere but Traffic and the site panel. A read that says which views show it
// and is marked heavy now waits for one of them; everything else still runs from the first render.
const heavy = Object.keys(QUERIES).filter((n) => QUERIES[n].heavy);
check("Every heavy read names the views that show it, and no view-less read is marked heavy",
  heavy.length > 0 && heavy.every((n) => (QUERIES[n].views ?? []).length > 0),
  heavy.map((n) => `${n} → ${(QUERIES[n].views ?? []).join("/")}`).join(" · "));

// Deferred, not dropped: `detail` brings the estate-size rule with it and `heavy` must not, or a
// large estate would open Traffic and find the reading missing rather than late.
check("A heavy read is deferred by the open view, never by the size of the estate",
  heavy.every((n) => !QUERIES[n].detail),
  heavy.map((n) => `${n}: detail=${!!QUERIES[n].detail}`).join(" · "));

// The Live map draws its routes from NetFlow, so the read that feeds them stays on it.
check("The read the map draws routes from is not deferred",
  !QUERIES.flowNets.heavy && (QUERIES.flowNets.views ?? []).includes("map"),
  `flowNets heavy=${!!QUERIES.flowNets.heavy} views=${(QUERIES.flowNets.views ?? []).join("/")}`);

// The three checks above read the flags. These three ask the rule: `readWanted` is the function
// useNetwork's own viewWants calls, so what it answers here is what a load does. A check that
// re-stated the rule instead would pass a broken one.
const askedOn = (views) => Object.keys(QUERIES).filter((n) => readWanted(QUERIES[n], views));
const onMap = askedOn(["map"]);
check("A Live map load does not ask for the two reads nothing but Traffic and the site panel draws",
  !onMap.includes("flowTs") && !onMap.includes("flowFanIn") && onMap.includes("flowNets"),
  `map asks ${onMap.length} of ${Object.keys(QUERIES).length} reads · flowTs=${onMap.includes("flowTs")} flowFanIn=${onMap.includes("flowFanIn")} flowNets=${onMap.includes("flowNets")}`);

// Late, never missing: the page that draws them must still get them.
const onTraffic = askedOn(["traffic"]), onSite = askedOn(["site"]);
check("Opening Traffic, or a site, asks for both of them",
  ["flowTs", "flowFanIn"].every((n) => onTraffic.includes(n) && onSite.includes(n)),
  `traffic ${onTraffic.length} reads · site ${onSite.length} reads`);

// And nothing else moved. Under the rule as it stood, `heavy` was not consulted at all.
const asWas = (q, views) => !q.detail || !q.views || q.views.some((v) => views.includes(v));
const mapAsWas = Object.keys(QUERIES).filter((n) => asWas(QUERIES[n], ["map"]));
const nowWaiting = mapAsWas.filter((n) => !onMap.includes(n)).sort();
check("The map load loses exactly those two reads, and no third",
  nowWaiting.join(",") === "flowFanIn,flowTs",
  `${mapAsWas.length} → ${onMap.length} reads · now waiting: ${nowWaiting.join(", ") || "none"}`);

// A plan carries an absolute `from`, so it is only true at the moment it is made. A read planned on
// the map and run two hours later asks for those two hours: the window grows with how long the page
// was left open, which is the opposite of deferring it. So the plan waits for the read.
check("A deferred read is not planned until the page that reads it is open",
  !planWanted(QUERIES.flowTs, ["map"], false) && planWanted(QUERIES.flowTs, ["traffic"], false)
    && planWanted(QUERIES.flowTs, ["site"], false),
  `flowTs planned on map=${planWanted(QUERIES.flowTs, ["map"], false)} traffic=${planWanted(QUERIES.flowTs, ["traffic"], false)} site=${planWanted(QUERIES.flowTs, ["site"], false)}`);

// And nothing else waits: a read that runs from the first render is planned from the first render,
// and a read a metric serves is never planned, because it keeps nothing.
check("An un-deferred incremental read is planned at once, and a metric-served one never",
  planWanted(QUERIES.deviceLogs, ["map"], false) && !planWanted(QUERIES.deviceLogs, ["map"], true)
    && !planWanted(QUERIES.flowNets, ["map"], false),
  `deviceLogs=${planWanted(QUERIES.deviceLogs, ["map"], false)} · as metric=${planWanted(QUERIES.deviceLogs, ["map"], true)} · flowNets (not incremental)=${planWanted(QUERIES.flowNets, ["map"], false)}`);

// Unmeasured is null, not zero — the rule pageCoverage is built on, applied to the log bill. The
// share is the network's records over every record those queries read, and flowTs carries half of
// that numerator: counted as zero it makes the network look like a smaller part of the bucket than
// it is, and overstates what a bucket of its own would save by exactly the part nobody read.
const shareBoth = networkLogShare({ net: 300, all: 1000 }, { net: 200, all: 1000 }, { logsCounted: true, flowsCounted: true });
const shareDeferred = networkLogShare({ net: 300, all: 1000 }, null, { logsCounted: true, flowsCounted: false });
const shareAbsent = networkLogShare({ net: 300, all: 1000 }, null, { logsCounted: true, flowsCounted: true });
check("A log share nobody could measure is null, and NetFlow absent from the environment is a real zero",
  shareBoth === 0.5 && shareDeferred === null && shareAbsent === 0.3,
  `both counted ${shareBoth} · flow count unread ${shareDeferred} · no NetFlow in the environment ${shareAbsent}`);

// None of it being the network's is an answer, and the strongest one the bucket step can be given:
// every record those queries read was somebody else's. Nothing scanned at all is not an answer.
const shareNone = networkLogShare({ net: 0, all: 50000 }, { net: 0, all: 50000 }, { logsCounted: true, flowsCounted: true });
const shareNothingRead = networkLogShare({ net: 0, all: 0 }, null, { logsCounted: true, flowsCounted: true });
check("A share of zero is a measurement, and nothing scanned is not",
  shareNone === 0 && shareNothingRead === null,
  `none of it the network's ${shareNone} · nothing scanned ${shareNothingRead}`);

// The same rule where it reaches the reader: an explanation must not be handed an empty list of
// traffic findings for reads that never ran, or it will answer that nothing stands out.
const flowsRead = { ...R }, flowsDeferred = { ...R };
delete flowsDeferred.flowTs; delete flowsDeferred.flowFanIn;
const mRead = buildRealModel(flowsRead, "flows-read"), mDeferred = buildRealModel(flowsDeferred, "flows-deferred");
const ctxRead = networkContext(mRead, infos, causes);
const ctxDeferred = networkContext(mDeferred, infos, causes);
check("An explanation is told which traffic reads did not run, and told nothing when both did",
  !("notMeasuredYet" in ctxRead.traffic) && (ctxDeferred.traffic.notMeasuredYet ?? []).length === 2,
  `both read: ${Object.keys(ctxRead.traffic).join(", ")} · deferred: ${(ctxDeferred.traffic.notMeasuredYet ?? []).length} named`);

// Traffic and the site panel are where the deferred reads do run — and for the seconds after the
// page opens they have not answered yet, which is the same gap under a different name. Both pages
// state findings, so both carry the same note.
const site = infos.find((i) => mRead.flowMap?.sites[i.code])?.code;
const trRead = trafficContext(mRead), trDeferred = trafficContext(mDeferred);
const stRead = siteContext(mRead, infos.find((i) => i.code === site)).traffic;
const stDeferred = siteContext(mDeferred, infos.find((i) => i.code === site)).traffic;
check("The pages that do read them say so too while they are still in flight",
  !("notMeasuredYet" in trRead) && (trDeferred.notMeasuredYet ?? []).length === 2
    && !("notMeasuredYet" in stRead) && (stDeferred.notMeasuredYet ?? []).length === 2,
  `traffic ${(trDeferred.notMeasuredYet ?? []).length} named · site ${site} ${(stDeferred.notMeasuredYet ?? []).length} named`);

// An answer written before the evidence landed must not be handed back after it does: the subject
// an answer is cached under moves when it lands.
const assistSubjects = [measuredKey(mRead.flowMap?.measured), measuredKey(mDeferred.flowMap?.measured), measuredKey(undefined)];
check("The subject an explanation is cached under moves when the traffic evidence lands",
  new Set(assistSubjects).size === 3 && measuredKey(mRead.flowMap?.measured) === measuredKey({ fanIn: true, rate: true }),
  `both read "${assistSubjects[0]}" · neither "${assistSubjects[1]}" · no NetFlow at all "${assistSubjects[2]}"`);

// …on every panel, not only the ones that read them. `reading` keeps every view the reader has
// opened, so the two reads stay in once Traffic has been visited: the Live map and Sites can be
// holding an answer written when they were out. This reads the pages rather than the model, which
// is the only way to check where a subject is composed — and it is how that omission was found.
const CARRIES_NOTE = ["networkContext", "trafficContext", "siteContext"];
const panels = ["pages/LiveMapPage.tsx", "pages/VisualPages.tsx", "pages/TrafficPage.tsx", "components/EntityDetails.tsx"]
  .flatMap((f) => readFileSync(new URL(`../../app/ui/app/${f}`, import.meta.url).pathname, "utf8")
    .split("<AssistPanel").slice(1).map((seg) => ({ file: f, tag: seg.slice(0, seg.indexOf("/>") + 2) })))
  .filter((p) => CARRIES_NOTE.some((c) => p.tag.includes(`${c}(`)));
const unkeyed = panels.filter((p) => !p.tag.includes("measuredKey("));
check("Every explanation whose context can carry the note is cached under the measurement state",
  panels.length >= 4 && unkeyed.length === 0,
  `${panels.length} panels state traffic findings · without the key: ${unkeyed.map((p) => p.file).join(", ") || "none"}`);

// Where the plan is made, and what may not start without one. Both are in the hook, so this reads
// it: a plan written during a render survives a render that is thrown away — with a `reading` that
// never committed — and a read allowed to start before its plan would run the full window and then
// run again with the incremental one, which is the 48 GB this is all guarding.
const hook = readFileSync(new URL("../../app/ui/app/data/useNetwork.ts", import.meta.url).pathname, "utf8");
const effect = hook.slice(hook.indexOf("const plannedUnder"), hook.indexOf("}, [planKey, wantedPlans]);"));
const gate = hook.slice(hook.indexOf("{ enabled: live && !gated"), hook.indexOf("waveOf(name) <= phase"));
// What the panel prints above the cause list. Measured on a live environment: three Critical causes
// stood above "3 causes · 0 sites" and three rows each reading "1", because the count was the sites
// with a bad verdict and an alert on the monitoring configuration that pings a device is
// deliberately not that device's verdict. The number beside a count of causes is now their sites.
const twoCauses = [{ sites: [{ code: "a" }] }, { sites: [{ code: "a" }, { code: "b" }] }];
const two = causeSummary(twoCauses, 0), one = causeSummary([{ sites: [{ code: "a" }] }], 0);
check("The site count beside the causes is the sites those causes name, counted once each",
  causeSiteCount(twoCauses) === 2 && two.headline === "2 causes · 2 sites" && two.sites === 2
    && one.headline === "1 cause · 1 site" && one.sites === 1,
  `${two.headline} · and one: ${one.headline}`);

// "Nothing is alerting on this network" is a claim about the whole network, and it was printed
// whenever no cause could be built — including with sites standing degraded, which is a different
// thing and not that claim.
const allQuiet = causeSummary([], 0), noCause = causeSummary([], 2);
check("Nothing is alerting is said only when nothing is degraded either, and the row agrees with the ring",
  allQuiet.headline === "Nothing is alerting on this network" && allQuiet.sites === 0
    && noCause.headline === "2 sites degraded · no cause named" && noCause.sites === 2
    && causeSummary([], 1).headline === "1 site degraded · no cause named",
  `none: "${allQuiet.headline}" (${allQuiet.sites}) · degraded: "${noCause.headline}" (${noCause.sites})`);

// The region list was unbounded: 23 regions made a 24-row table that pushed the fault domain and
// the drill-downs below the fold. Bounded now — and a region with something alerting is never the
// one left out, however long the tail is.
const region = (n, bad) => ({ list: Array.from({ length: n }, (_, i) => ({ verdict: i < bad ? "Critical" : "Healthy" })) });
const ranked = [region(5, 1), ...Array.from({ length: 22 }, () => region(4, 0)), region(3, 2)];
const regionCut = regionsShown(ranked, 8);
check("The region list is bounded, and never leaves out a region that is alerting",
  regionCut.shown.length === 8 && regionCut.hidden === ranked.length - 8
    && ranked.filter((g) => g.list.some((i) => i.verdict === "Critical")).every((g) => regionCut.shown.includes(g))
    && regionsShown([region(2, 0)], 8).hidden === 0,
  `${ranked.length} regions → ${regionCut.shown.length} shown, ${regionCut.hidden} hidden · alerting kept: ${regionCut.shown.filter((g) => g.list.some((i) => i.verdict === "Critical")).length}`);

// A name that says the same word twice says nothing, at length: "KS, KS" and "OK, OK" were on a
// customer's map, from names whose city slot carries the state code as well.
check("A shortened name never repeats the word it just said",
  shortSiteName("DEPOT:B117.04:9 Example Road:KS:KS:12345") === "KS"
    && shortSiteName("Oklahoma City, OK, OK, USA") === "Oklahoma City, OK"
    && shortSiteName("DEPOT:B117.04:9 Example Road:Wichita:KS:12345") === "Wichita, KS",
  `${shortSiteName("DEPOT:B117.04:9 Example Road:KS:KS:12345")} · ${shortSiteName("Oklahoma City, OK, OK, USA")}`);

// The camera, as arithmetic. A reader judges the map by how much of the frame the estate fills
// before anything else, and that was only observable by rendering a canvas.
const INSETS = { top: 24, right: 376, bottom: 28, left: 336 };
const usPts = [{ lat: 47.5, lon: -122.8 }, { lat: 42.1, lon: -70.8 }, { lat: 25.8, lon: -80.1 }, { lat: 39.2, lon: -96.2 }];
const fill = frameFill(usPts, 1366, 697, INSETS);
check("The frame fits the estate to the width it is designed to leave",
  Math.abs(fill.across - 1 / FIT_MARGIN) < 0.01 && fill.down < fill.across,
  `${(100 * fill.across).toFixed(0)}% across · ${(100 * fill.down).toFixed(0)}% down · target ${(100 / FIT_MARGIN).toFixed(0)}%`);

// And it is the raw extremes that set it, so one far site reframes the map for all the others.
// Named here rather than fixed: which site does it on a given estate is a question for that estate.
const withFarSite = frameFill([...usPts, { lat: 51.5, lon: -0.1 }], 1366, 697, INSETS);
check("One site far from the rest is enough to reframe the map, and the suite says by how much",
  withFarSite.down < fill.down * 0.75 && Math.abs(withFarSite.across - 1 / FIT_MARGIN) < 0.01,
  `without it ${(100 * fill.down).toFixed(0)}% down · with it ${(100 * withFarSite.down).toFixed(0)}%`);

// The camera centres on what it frames, in the strip the panels leave rather than on the canvas.
const v = fitView(usPts, 1366, 697, INSETS);
check("The frame is centred on the estate",
  Math.abs(v.cx - (-96.8)) < 0.05 && v.k > 1.2,
  `centre ${v.cx.toFixed(1)}° · k ${v.k.toFixed(2)}`);

// A name written across the ring it belongs to is how a busy map becomes unreadable. `placeLabels`
// is the rule, so the suite asks it: a name beside a mark it does not own is dropped, and the mark
// the site itself stands on is not an obstacle to its own name.
const wide = (t) => t.length * 7;
const onlyMark = [{ x0: 100, y0: 94, x1: 140, y1: 134 }];
const besideIt = NetMap_placeLabels([{ x: 95, y: 114, name: "Beside a ring", code: "AAA" }], onlyMark, wide);
const insideIt = NetMap_placeLabels([{ x: 120, y: 114, name: "Its own ring", code: "BBB" }], onlyMark, wide);
const twoNames = NetMap_placeLabels(
  [{ x: 10, y: 50, name: "First", code: "A" }, { x: 30, y: 50, name: "Second", code: "B" }], [], wide);
check("A name is never written across a mark, and a site's own mark is not its obstacle",
  besideIt.placed.length === 0 && insideIt.placed.length === 1 && twoNames.placed.length === 1,
  `beside a ring: ${besideIt.placed.length} written · on its own ring: ${insideIt.placed.length} · two names overlapping: ${twoNames.placed.length} of 2`);

/*
 * A name nobody can read is not written — and, above all, does not reserve the space.
 *
 * The placement pass knew only about the other names. It knew nothing about the edges of the stage
 * or about the two cards that float over the map, so two things happened at once and only the
 * first was ever reported: a name beside a site near the edge was written past it and the viewport
 * cut it mid-word, and a name under a panel was written where nobody could see it while still
 * taking its slot, so a name that WOULD have been readable was dropped to make room for one that
 * never appeared. Swept over 75 camera positions on a 230-site estate, 296 of 729 names written
 * were unreadable, and removing them RAISED the readable count from 433 to 449.
 */
const stage300 = { x0: 0, y0: 0, x1: 300, y1: 200 };
const panelLeft = [{ x0: 0, y0: 0, x1: 200, y1: 200 }];
/* A name whose box runs past the stage is not written past it. The rule already had a fallback for
   a name that will not fit — the site's code — and it is the right answer here too: three letters
   inside the stage beat a name the viewport cuts mid-word. Where not even the code fits, nothing
   is written. */
const offEdge = NetMap_placeLabels([{ x: 250, y: 50, name: "A name too long to fit", code: "EDG" }], [],
  wide, { stage: stage300, blockers: [] });
const noRoom = NetMap_placeLabels([{ x: 294, y: 50, name: "A name too long to fit", code: "EDG" }], [],
  wide, { stage: stage300, blockers: [] });
// the panel covers A's name; B is clear of it, and used to be dropped to make room for A
const pair = [{ x: 150, y: 50, name: "Under the panel", code: "AAA" }, { x: 205, y: 50, name: "Beside it", code: "BBB" }];
const unaware = NetMap_placeLabels(pair, [], wide);
const aware = NetMap_placeLabels(pair, [], wide, { stage: stage300, blockers: panelLeft });
check("A name that cannot be read is not written, and does not take the space of one that can",
  offEdge.placed.length === 1 && offEdge.placed[0].text === "EDG" && noRoom.placed.length === 0
  && unaware.placed.length === 1 && unaware.placed[0].text === "Under the panel"
  && aware.placed.length === 1 && aware.placed[0].text === "Beside it",
  `at the stage edge: "${offEdge.placed[0]?.text ?? "none"}" instead of the cut name · with no room at all: ${noRoom.placed.length} written · unaware of the panel: ${unaware.placed.map((l) => l.text).join(", ") || "none"} · aware: ${aware.placed.map((l) => l.text).join(", ") || "none"}`);

// A mark under a site is its own and is forgiven; a panel over a site is not. The distinction is
// the whole point: a name beside its own dot is the normal case, and a panel covering that dot
// covers the name just the same.
const ownMark = NetMap_placeLabels([{ x: 100, y: 50, name: "On its own dot", code: "OWN" }],
  [{ x0: 0, y0: 0, x1: 200, y1: 100 }], wide);
const ownPanel = NetMap_placeLabels([{ x: 100, y: 50, name: "On its own dot", code: "OWN" }], [],
  wide, { stage: stage300, blockers: [{ x0: 0, y0: 0, x1: 200, y1: 100 }] });
check("A panel over a site is never forgiven the way the site's own mark is",
  ownMark.placed.length === 1 && ownPanel.placed.length === 0
  && NetMap_labelFits({ x0: 210, y0: 10, x1: 290, y1: 24 }, { stage: stage300, blockers: panelLeft })
  && !NetMap_labelFits({ x0: 210, y0: 10, x1: 310, y1: 24 }, { stage: stage300, blockers: [] }),
  `over its own mark: ${ownMark.placed.length} written · under a panel on the same spot: ${ownPanel.placed.length}`);

// Both maps ask the rule, and they ask it with the panels they actually have. The rectangles are
// measured from the elements, not derived from the inset column: the cards are shorter than the
// stage, and a column-wide guess would throw away every name below them.
const geoLblSrc = readFileSync(new URL("../../app/ui/app/components/LiveMapGeo.tsx", import.meta.url).pathname, "utf8");
check("Both maps hand the placement the stage and the cards that float over it",
  geoLblSrc.includes("labelFits(") && geoLblSrc.includes("function overlay(")
  && geoLblSrc.includes('querySelectorAll(".lm-panel, .lm-zoom, .lm-tab")')
  && geoLblSrc.includes("over.blockers.some")
  && readFileSync(new URL("../../app/ui/app/components/LiveMap.tsx", import.meta.url).pathname, "utf8")
    .includes('querySelectorAll(".lm-panel, .lm-zoom, .lm-tab")'),
  `regions map asks the rule: ${geoLblSrc.includes("labelFits(")} · budget skips covered sites: ${geoLblSrc.includes("over.blockers.some")}`);

/*
 * The cards can be put away, and the handle stays on the card's edge when they move.
 *
 * On a wide stage the two cards float over the map, so whatever sits under them cannot be dragged
 * into view — the pointer lands on the card. The regions behind the right-hand panel were out of
 * reach altogether. The handle is a sibling of the card, because a card scrolls inside itself and
 * would clip a control hanging on its own inner edge; which means its position is arithmetic on
 * the card's, and the two can drift apart silently. So the suite does the arithmetic.
 */
const tabCss = readFileSync(new URL("../../app/ui/app/styles/theme.css", import.meta.url).pathname, "utf8");
const tabPage = readFileSync(new URL("../../app/ui/app/pages/LiveMapPage.tsx", import.meta.url).pathname, "utf8");
const px = (re) => { const m = tabCss.match(re); return m ? Number(m[1]) : NaN; };
const leftAt = px(/\.lm-stage\.is-wide \.lm-left \{ top: \d+px; left: (\d+)px;/);
const leftW = px(/\.lm-stage\.is-wide \.lm-left \{ top: \d+px; left: \d+px; width: (\d+)px;/);
const rightAt = px(/\.lm-stage\.is-wide \.lm-right \{ top: \d+px; right: (\d+)px;/);
const rightW = px(/\.lm-stage\.is-wide \.lm-right \{ top: \d+px; right: \d+px; width: (\d+)px;/);
const tabL = px(/\.lm-stage\.is-wide \.lm-tab--left \{ left: (\d+)px; \}/);
const tabR = px(/\.lm-stage\.is-wide \.lm-tab--right \{ right: (\d+)px; \}/);
const sits = (tab, at, w) => tab >= at + w && tab <= at + w + 16;
/* The first version of this check passed while the handle sat UNDER the card, because it read the
   declared width — 304 — and the card measured 338: the padding and the hairline live outside a
   content box. A check that restates a declaration proves nothing about the layout. So the panels
   are border-box, which makes the declared number the number on screen, and the check requires it. */
check("Each card's handle sits on the card's own edge, at either width",
  /\.lm-stage\.is-wide \.lm-panel \{[^}]*box-sizing: border-box;/.test(tabCss)
  && sits(tabL, leftAt, leftW) && sits(tabR, rightAt, rightW)
  && /\.lm-tab--left\.is-shut \{ left: 16px; \}/.test(tabCss) && /\.lm-tab--right\.is-shut \{ right: 16px; \}/.test(tabCss),
  `left card ends at ${leftAt + leftW} and its handle is at ${tabL} · right card ends at ${rightAt + rightW} and its handle is at ${tabR} · border-box: ${/box-sizing: border-box/.test(tabCss)}`);

/* And the handle has to be visible on the map it floats over. In the light theme the card surface
   and the map ground are both #ffffff, so neither the fill nor a plain hairline says anything —
   the fill reads 1.00:1 and the hairline 1.68:1. What carries the control is the glyph, measured
   at 13.0:1 on the light ground and 14.9:1 on the dark one, so the glyph wears full ink. A later
   edit that quietens it back down to the muted ink would leave a chip nobody can see. */
check("The handle is carried by its glyph, which is full ink rather than the muted one",
  /\.lm-stage\.is-wide \.lm-tab \{[^}]*color: var\(--lm-ink\);/.test(tabCss)
  && !/\.lm-stage\.is-wide \.lm-tab \{[^}]*color: var\(--lm-ink-3\);/.test(tabCss)
  && /\.lm-stage\.is-wide \.lm-tab \{ border-color: var\(--lm-line-2\); \}/.test(tabCss),
  `glyph in full ink: ${/\.lm-stage\.is-wide \.lm-tab \{[^}]*color: var\(--lm-ink\);/.test(tabCss)} · hairline is the stronger neutral: ${/border-color: var\(--lm-line-2\)/.test(tabCss)}`);

// A card is hidden, never unmounted: the assist panel holds answers the reader asked for, and a
// card that forgets them when it is put away is a card nobody puts away twice. And the map must
// be told the band it has, or the camera keeps padding for a card that is no longer there.
/* The inset is the band the camera keeps clear, so it has to be the card's real extent — margin,
   card, margin — not a number typed next to it. Read from the CSS and compared, because the two
   were already 18px apart before this: the inset said 336 while the card reached 354. */
const insetL = Number(tabPage.match(/shut\.left \? 60 : (\d+)/)?.[1]);
const insetR = Number(tabPage.match(/shut\.right \? 60 : (\d+)/)?.[1]);
check("A card put away is hidden, not unmounted, and the map is told the band it got back",
  /\.lm-panel\.is-shut \{ display: none; \}/.test(tabCss)
  && !/\{\s*!?(shut|hid)\.(left|right)\s*&&\s*<aside/.test(tabPage)
  && insetL === leftAt + leftW + 16 && insetR === rightAt + rightW + 16
  && tabPage.includes("const hid = { left: wide && shut.left, right: wide && shut.right }"),
  `hidden by CSS: ${/\.lm-panel\.is-shut \{ display: none; \}/.test(tabCss)} · the left card reaches ${leftAt + leftW} and the inset keeps ${insetL} · the right card reaches ${rightAt + rightW} and the inset keeps ${insetR} · only ever shut on the wide stage: ${tabPage.includes("wide && shut.left")}`);

/*
 * The reader's zoom is the reader's.
 *
 * Three limits lived in our own code and all three were reported as "it will not zoom out any
 * further": the canvas clamped the wheel to [1.2, 400], where 1.2 puts the whole world in 432px
 * and stops; the regions map inherited whatever maplibre's default happened to be; and opening a
 * cluster flew to at most zoom 11, so a reader pulling a dense group apart was stopped half way.
 * A frame the app chooses for itself — `fitView`, `fitBounds` — may still have a range; a gesture
 * the reader makes may not.
 */
const zoomCanvas = readFileSync(new URL("../../app/ui/app/components/LiveMap.tsx", import.meta.url).pathname, "utf8");
const zoomGeo = readFileSync(new URL("../../app/ui/app/components/LiveMapGeo.tsx", import.meta.url).pathname, "utf8");
const clamp = zoomCanvas.match(/const k = Math\.max\(([\d.]+), Math\.min\(([\d.]+), v\.k \* f\)\);/);
const lo = clamp ? Number(clamp[1]) : NaN, hi = clamp ? Number(clamp[2]) : NaN;
check("The reader's own zoom is not limited by us, on either map",
  lo < 1.2 && hi > 400
  && /m\.setMinZoom\(-2\);/.test(zoomGeo) && /m\.setMaxZoom\(24\);/.test(zoomGeo)
  && !/maxZoom: \d+, duration/.test(zoomGeo),
  `canvas wheel range ${lo} to ${hi} (was 1.2 to 400) · regions map states its own: ${/setMinZoom\(-2\)/.test(zoomGeo)} · a cluster opens without a ceiling: ${!/maxZoom: \d+, duration/.test(zoomGeo)}`);

// And the marks really are handed to it: the canvas seeds `taken` with what it drew.
const mapSrc = readFileSync(new URL("../../app/ui/app/components/LiveMap.tsx", import.meta.url).pathname, "utf8");
check("The canvas reserves every mark it draws and hands them to the rule",
  mapSrc.split("reserve(").length - 1 >= 3 && mapSrc.includes("placeLabels(") && mapSrc.includes("taken, measure"),
  `reserve() call sites: ${mapSrc.split("reserve(").length - 2} · placement delegated: ${mapSrc.includes("placeLabels(")}`);

// The same alpha is not the same contrast on the two stages. Dark ink at 16% over a near-white
// shell lands at 1.34:1 — a line the reader reports as missing — while the light ink of the dark
// stage at the same alpha reads 1.52:1. The shape alphas are tokens per theme for that reason, and
// the light ones have to be the larger of the two or the lesson is lost at the next edit.
const themeSrc = readFileSync(new URL("../../app/ui/app/styles/theme.css", import.meta.url).pathname, "utf8");
const blockOf = (sel) => { const i = themeSrc.indexOf(sel); const j = themeSrc.indexOf("\n}", i); return themeSrc.slice(i, j); };
const alphaIn = (block, name) => Number((block.match(new RegExp(`--lm-${name}:\\s*([0-9.]+)`)) ?? [])[1]);
const darkBlock = blockOf("\n.lm {"), lightBlock = blockOf(':root:not([data-theme="dark"]) .lm {');
const shapes = ["shape-line", "shape-line-empty", "shape-fill", "shape-fill-empty"];
const pairs = shapes.map((n) => ({ n, dark: alphaIn(darkBlock, n), light: alphaIn(lightBlock, n) }));

/*
 * What the two stages have to match is the contrast, not the alpha.
 *
 * The first version of this check required every light alpha to be the larger, which was true
 * while both stages drew the shape in their own text ink. The light stage draws it in black now,
 * and 7% of black carries further than 7% of a near-white on near-black — so the alpha rule
 * started failing on a change that made the line stronger. Blend it and measure instead.
 */
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (fg, bg, a) => fg.map((f, i) => a * f + (1 - a) * bg[i]);
const relLum = (c) => { const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]); };
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const DARK = { ink: hex("#e2e8f0"), bg: hex("#141419") }, LIGHT = { ink: hex("#000000"), bg: hex("#f2f2f5") };
const reading = (stage, a) => contrast(mix(stage.ink, stage.bg, a), stage.bg);
const lines = [["shape-line", "holding sites"], ["shape-line-empty", "holding none"]].map(([n, what]) => ({
  what, dark: reading(DARK, alphaIn(darkBlock, n)), light: reading(LIGHT, alphaIn(lightBlock, n)) }));
check("A region's shape reads at least as strongly on the light stage as on the dark one",
  pairs.every((p) => Number.isFinite(p.dark) && Number.isFinite(p.light)) && lines.every((l) => l.light >= l.dark),
  lines.map((l) => `${l.what}: dark ${l.dark.toFixed(2)}:1 · light ${l.light.toFixed(2)}:1`).join(" · "));

// The numbers existed twice — once in the canvas map, once as literals in the WebGL paint — and
// three releases raised the copy nobody was looking at, because the canvas draws the schematic
// while the reports were all about Regions, which the platform's map draws. Neither file may
// carry the literals again.
const geoSrc = readFileSync(new URL("../../app/ui/app/components/LiveMapGeo.tsx", import.meta.url).pathname, "utf8");
const canvasSrc = readFileSync(new URL("../../app/ui/app/components/LiveMap.tsx", import.meta.url).pathname, "utf8");
const geoPaint = geoSrc.slice(geoSrc.indexOf('id="nf-regions-fill"'), geoSrc.indexOf('id="nf-share"'));
check("Both maps read the shape from the theme, and neither writes the numbers again",
  geoSrc.includes('"--lm-shape-ink"') && canvasSrc.includes('v("--lm-shape-ink"')
    && !/0\.38|0\.16|0\.025/.test(geoPaint) && /shape\.(line|fill|width)/.test(geoPaint),
  `geo paint reads the theme: ${/shape\.(line|fill|width)/.test(geoPaint)} · literals left in it: ${/0\.38|0\.16|0\.025/.test(geoPaint)}`);

// The platform draws the countries itself, in Border.Neutral.Default at one pixel and four tenths
// of one — #dadbe4 on the light shell, 1.26:1, which is not a line. Its layers are repainted with
// the same tokens the region outlines use, so every boundary on the map carries one weight.
// Nothing of ours is drawn over the platform's basemap, and for one release something was: a black
// border on every country in the world. Measured on the live app with it switched off and on, at a
// country's zoom it changed nothing — 352 dark pixels either way — and at world zoom it tripled the
// ink, 746 to 2,728, and the map stopped looking like Dynatrace's. The subdivisions are what the
// complaint was about, and those are ours to draw.
check("The world keeps the platform's own weight; only the subdivisions carry the theme's ink",
  !geoSrc.includes("nf-world-line") && !geoSrc.includes("setPaintProperty(\"geojson-line\"")
    && geoSrc.includes('id="nf-regions-line"') && /shape\.(line|fill|width)/.test(geoPaint),
  `layer of ours over the basemap: ${geoSrc.includes("nf-world-line")} · subdivisions from the theme: ${/shape\.(line|fill|width)/.test(geoPaint)}`);

// The platform's map paints its land in `background-container-neutral-default`, and on the light
// stage that token and the shell are the same #f4f4f6 — land in the colour of the sea, which is a
// wireframe and not a map. It gets the surface to stand on, as it does everywhere else in the
// product. Measured in the running app: with the ground white the land reads as land.
check("The platform's map stands on a surface, not on the shell it would vanish into",
  /--lm-map-ground:\s*var\(--dt-colors-background-surface-default/.test(lightBlock)
    && /--lm-map-ground:\s*var\(--lm-bg\)/.test(darkBlock)
    && /\.lm-geo \{[^}]*background: var\(--lm-map-ground\)/.test(themeSrc),
  `light ground: surface · dark ground: the stage it already separated from`);

// Black on the light stage, asked for after three rounds of raising the alpha of a near-navy ink.
check("The light stage draws the shape in black",
  /--lm-shape-ink:\s*#000000/.test(lightBlock) && alphaIn(lightBlock, "shape-line") >= 0.85,
  `light ink ${(lightBlock.match(/--lm-shape-ink:\s*(\S+);/) ?? [])[1]} at ${alphaIn(lightBlock, "shape-line")}`);

// Which layout the map opens on. Geography opens on the platform's own basemap, whose country
// outlines measure #e4e4e7 on a #f4f4f7 ground on the light stage — not ours to darken, and read
// as a blank map with dots on it. Regions draws the subdivisions the app already knows over the
// same positions; an environment with no coordinates at all still opens on the schematic.
const pageSrc = readFileSync(new URL("../../app/ui/app/pages/LiveMapPage.tsx", import.meta.url).pathname, "utf8");
const defaultLayout = (pageSrc.match(/const chosen = layout \?\? \(placedShare > 0 \? "(\w+)" : "(\w+)"\)/) ?? []).slice(1);
check("The map opens on the regions, and on the schematic where nothing can be placed",
  defaultLayout[0] === "states" && defaultLayout[1] === "schematic",
  `placed → ${defaultLayout[0] ?? "?"} · nothing placed → ${defaultLayout[1] ?? "?"}`);

// The outlines are fetched per country, and the effect that fetches them must not depend on the
// site array: its identity changes on every render, and this app renders on every read that lands,
// so each re-render cancelled the fetch in flight while the country stayed marked as fetched. The
// map then said "No outlines for these sites" about outlines that had been fetched and dropped.
const shapesEffect = pageSrc.slice(pageSrc.indexOf("const ccKey ="), pageSrc.indexOf("}, [states, ccKey]);"));
check("The outlines are refetched when the countries change, not when the array does",
  pageSrc.includes("}, [states, ccKey]);") && shapesEffect.includes("loadCountries(")
    && !shapesEffect.includes("loadedCcs") && !/\}, \[states, infos/.test(pageSrc),
  `keyed on ${pageSrc.includes("}, [states, ccKey];") ? "?" : "the country set"} · loadCountries: ${shapesEffect.includes("loadCountries(")}`);

// And the layout switch keeps its place: it was pushed right by whatever pills the open layout
// brought, so clicking Regions moved Regions out from under the pointer.
const themeSrc2 = readFileSync(new URL("../../app/ui/app/styles/theme.css", import.meta.url).pathname, "utf8");
check("The layout switch does not move when the layout changes",
  themeSrc2.includes(".lm-bar > .vz-seg { margin-left: 0; }") && pageSrc.includes('className="lm-bar__spacer"'),
  `switch unpinned from the right: ${themeSrc2.includes(".lm-bar > .vz-seg { margin-left: 0; }")} · spacer present: ${pageSrc.includes("lm-bar__spacer")}`);

check("The plan is made after the commit, and no incremental read starts without one",
  effect.includes("useEffect(") && effect.includes("planFor(") && hook.split("planFor(").length === 3
    && gate.includes("!QUERIES[name].incremental || asMetric(name) || !!plans[name]"),
  `planFor inside the effect: ${effect.includes("planFor(")} · call sites: ${hook.split("planFor(").length - 1} · gate: ${gate.includes("!!plans[name]")}`);

report.summary = { passed: report.checks.filter((c) => c.ok).length, of: report.checks.length };

writeFileSync("out/validation.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
