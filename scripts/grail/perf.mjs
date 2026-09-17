// Scale test: builds Grail-shaped records for an xlarge estate and runs the app's own model over them.
// Usage: node perf.mjs [devices] [devicesPerSite]   (default 20000 devices, 10 per site)
import { buildRealModel, evaluateNeeds, allSites, buildCauses } from "./out/app-model.mjs";

const DEVICES = Number(process.argv[2] ?? 20000);
const PER_SITE = Number(process.argv[3] ?? 10);
const SITES = Math.ceil(DEVICES / PER_SITE);
const IFACES_PER_DEVICE = Number(process.env.IFACES ?? 6);
const NOW = Math.floor(Date.now() / 3600e3) * 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "000000Z");
const hex = (n) => n.toString(16).toUpperCase().padStart(16, "0");
const S = String;

const ROLES = ["RTR", "CON", "SWT", "APW", "FWL", "WLC", "LBL", "DISP", "SWT", "APW"];
const REGIONS = ["North", "Northeast", "Midwest", "Southeast", "South"];
const tf = (bucket, n) => ({ timeframe: { start: iso(NOW - n * bucket), end: iso(NOW) }, interval: S(bucket * 1e6) });
const B1H = 3600e3, N1H = 24, B5 = 300e3, N5 = 24;

const t0 = process.hrtime.bigint();
const results = { devices: [], interfaces: [], cpu: [], uptime: [], icmp: [], icmpNow: [], trCisco: [], errCisco: [],
  syslogSum: [], syslogTs: [], syslogRecent: [], traps: [], lldp: [], routing: [], flowTs: [], flowProto: [], flowTop: [],
  cloud: [], cloudTop: [], problems: [], alerts: [] };

for (let s = 0; s < SITES; s++) {
  const code = `S${String(s).padStart(4, "0")}`;
  const region = REGIONS[s % REGIONS.length];
  const tags = {
    "primary_tags.site": code, "primary_tags.site_name": `Site ${code}`, "primary_tags.region": region,
    "primary_tags.geo_lat": S(-33 + (s % 900) / 30), "primary_tags.geo_lon": S(-70 + (s % 1200) / 30),
    "primary_tags.hub": `HUB${s % 8}`, "primary_tags.site_type": s % 20 === 0 ? "distribution center" : "store",
  };
  for (let i = 0; i < PER_SITE && s * PER_SITE + i < DEVICES; i++) {
    const n = s * PER_SITE + i;
    const role = ROLES[i % ROLES.length];
    const name = `BR-XX-${code}-${role}${i}`;
    const id = `EXT_NETWORK_DEVICE-${hex(n)}`;
    results.devices.push({ id, id_classic: `CUSTOM_DEVICE-${hex(n + 1e7)}`, name, "monitoring_mode": "Extension",
      device_type: n % 3 ? "cisco" : "juniper", description: "scale test device", interface_count: S(IFACES_PER_DEVICE),
      ip: [`10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`], location: `Site ${code}`,
      chassis_mac: hex(n).slice(0, 12), ...tags });
    results.cpu.push({ "dt.smartscape.ext_network_device": id, cpu: Array.from({ length: N1H }, (_, k) => S(20 + ((n + k) % 60))), ...tf(B1H, N1H) });
    results.uptime.push({ "dt.smartscape.ext_network_device": id, c: Array.from({ length: N1H }, () => "60"), ...tf(B1H, N1H) });
    for (let f = 0; f < IFACES_PER_DEVICE; f++) {
      const sid = `EXT_NETWORK_INTERFACE-${hex(n * 10 + f)}`;
      results.interfaces.push({ id: sid, id_classic: `CUSTOM_DEVICE-${hex(n * 10 + f + 2e7)}`, name: `Gi0/0/${f}`,
        "device.chassis_mac": hex(n).slice(0, 12), operational_status: "up(1)", admin_status: "up(1)", speed: "1000",
        interface_index: S(f), interface_type: "ethernetCsmacd(6)" });
      results.trCisco.push({ "dt.smartscape.ext_network_device": id, "dt.smartscape.ext_network_interface": sid, "if.name": `Gi0/0/${f}`,
        i: Array.from({ length: N5 }, () => S(2e7 + (n % 1e7))), o: Array.from({ length: N5 }, () => S(1e7)), s: Array.from({ length: N5 }, () => "1000"), ...tf(B5, N5) });
    }
  }
  // one ICMP monitor per site, and a WAN circuit with its own monitor and SLA
  const rtr = `10.${(s * PER_SITE >> 16) & 255}.${((s * PER_SITE) >> 8) & 255}.${(s * PER_SITE) & 255}`;
  const probe = (key, bucket, n, extra) => results[key].push({ "dt.entity.synthetic_location": "SYNTHETIC_LOCATION-1",
    "dt.entity.multiprotocol_monitor": extra.monitor, "monitor.name": extra.name, "request.target_address": extra.target,
    rtt: Array.from({ length: n }, () => S(8 + (s % 40))), sent: Array.from({ length: n }, () => "12"),
    recv: Array.from({ length: n }, () => "12"), ...tf(bucket, n), ...extra.tags });
  const siteTags = { "primary_tags.site": code, "primary_tags.circuit_id": null, "primary_tags.circuit_role": null, "primary_tags.carrier": null, "primary_tags.circuit_tech": null, "primary_tags.sla_ms": null, "primary_tags.bandwidth_mbps": null };
  const circTags = { "primary_tags.site": code, "primary_tags.circuit_id": `CIR-${code}`, "primary_tags.circuit_role": "primary",
    "primary_tags.carrier": `Carrier ${"ABCD"[s % 4]}`, "primary_tags.circuit_tech": "MPLS 50 Mbps", "primary_tags.sla_ms": "80", "primary_tags.bandwidth_mbps": "50" };
  for (const [key, bucket, n] of [["icmp", B1H, N1H], ["icmpNow", B5, N5]]) {
    probe(key, bucket, n, { monitor: `MULTIPROTOCOL_MONITOR-${hex(s)}`, name: `Site ${code}`, target: rtr, tags: siteTags });
    probe(key, bucket, n, { monitor: `MULTIPROTOCOL_MONITOR-${hex(s + 1e6)}`, name: `WAN CIR-${code}`, target: `10.200.${(s >> 8) & 255}.${s & 255}`, tags: circTags });
  }
  results.syslogSum.push({ "dt.ingest.source.ip": rtr, loglevel: "ERROR", n: S(3 + (s % 5)) });
}

// what Dynatrace is alerting on: 1% of the devices, plus interface and monitor level alerts
for (let k = 0; k < Math.ceil(DEVICES / 100); k++) {
  const n = k * 97 % DEVICES;
  results.problems.push({ "event.id": `p${k}_${NOW}`, "event.kind": "DAVIS_PROBLEM", display_id: `P-${900000 + k}`,
    "event.name": k % 3 ? "Interface saturation" : "Network device is unreachable", "event.start": iso(NOW - 30 * 60e3),
    "event.category": k % 3 ? "RESOURCE_CONTENTION" : "AVAILABILITY", "dt.davis.mute.status": "NOT_MUTED", "dt.davis.event_ids": [],
    affected_entity_ids: [], affected_entity_names: [], "smartscape.affected_entity.ids": [k % 3 ? `EXT_NETWORK_INTERFACE-${hex(n * 10)}` : `EXT_NETWORK_DEVICE-${hex(n)}`] });
}
for (let k = 0; k < Math.ceil(DEVICES / 200); k++) {
  results.alerts.push({ "event.id": `e${k}_${NOW}`, "event.kind": "DAVIS_EVENT", "event.type": "ERROR_EVENT", "event.name": "Interface packet errors high rate",
    "event.category": "ERROR", "event.start": iso(NOW - 20 * 60e3), "dt.davis.mute.status": "NOT_MUTED",
    affected_entity_ids: [], affected_entity_names: [], "dt.smartscape.ext_network_device": `EXT_NETWORK_DEVICE-${hex((k * 131) % DEVICES)}` });
}

// worst case for the grouping: one carrier outage covering a quarter of the estate
const bigScope = [];
for (let s = 0; s < Math.ceil(SITES / 4); s++) bigScope.push(`MULTIPROTOCOL_MONITOR-${hex(s + 1e6)}`);
results.problems.push({ "event.id": `pbig_${NOW}`, "event.kind": "DAVIS_PROBLEM", display_id: "P-999999",
  "event.name": "Network availability monitor global outage · Carrier A", "event.start": iso(NOW - 2 * 3600e3),
  "event.category": "AVAILABILITY", "dt.davis.mute.status": "NOT_MUTED", "dt.davis.event_ids": [],
  affected_entity_ids: [], affected_entity_names: [], "smartscape.affected_entity.ids": bigScope });

const t1 = process.hrtime.bigint();
const model = buildRealModel(results, "scale-test");
const t2 = process.hrtime.bigint();
const infos = allSites(model);
const t3 = process.hrtime.bigint();
const causes = buildCauses(model, infos);
const t4 = process.hrtime.bigint();
const needs = evaluateNeeds(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])), model, "live");
const t5 = process.hrtime.bigint();

const ms = (a, b) => Number(b - a) / 1e6;
const mem = process.memoryUsage();
console.log(JSON.stringify({
  input: { devices: results.devices.length, interfaces: results.interfaces.length, sites: SITES, icmpRows: results.icmp.length, problems: results.problems.length, alerts: results.alerts.length,
    records: Object.values(results).reduce((a, v) => a + v.length, 0) },
  model: { devices: model.devices.length, sites: Object.keys(model.sites).length, circuits: model.circuits?.length ?? 0,
    alerted: model.devices.filter((d) => (d.problems ?? []).length).length, unmappedAlerts: (model.unmappedAlerts ?? []).length,
    byVerdict: model.devices.reduce((a, d) => ((a[d.verdict] = (a[d.verdict] ?? 0) + 1), a), {}), causes: causes.length },
  timingMs: { generate: +ms(t0, t1).toFixed(0), buildRealModel: +ms(t1, t2).toFixed(0), allSites: +ms(t2, t3).toFixed(0), buildCauses: +ms(t3, t4).toFixed(0), evaluateNeeds: +ms(t4, t5).toFixed(0), modelTotal: +ms(t1, t5).toFixed(0) },
  memoryMB: { heapUsed: Math.round(mem.heapUsed / 1e6), rss: Math.round(mem.rss / 1e6) },
  needsAlerts: needs.alerts.detail,
}, null, 1));
