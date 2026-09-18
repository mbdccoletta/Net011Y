// Generates a branch network's telemetry the way the standard Dynatrace mechanisms store it in Grail:
//   SNMP extensions (ActiveGate)   -> smartscape EXT_NETWORK_DEVICE / EXT_NETWORK_INTERFACE nodes + extension metrics
//   Syslog extension (ActiveGate)  -> logs with dt.openpipeline.source = extension:syslog
//   SNMP traps extension           -> logs with log.source = snmptraps
//   Synthetic ICMP monitors        -> dt.synthetic.multi_protocol.icmp.* metrics
//   OTel netflowreceiver           -> logs with receiver = netflow
//   OneAgent network flows         -> events in bucket default_network_flows
//   Inventory                      -> primary Grail tags on the SNMP monitoring configurations (site) and ICMP monitors (circuit)
// Field names, value types (longs as strings, timeseries arrays, enum strings such as "up(1)") are copied
// from real GRU records in out/gru-samples. Raw stores go to out/raw; out/results.json holds what each of
// the app's DQL queries returns over those stores.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(`${OUT}raw`, { recursive: true });
mkdirSync(`${OUT}config`, { recursive: true });

let seed = 20260917;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const uni = (a, b) => a + rnd() * (b - a);
const int = (a, b) => Math.floor(uni(a, b + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hex = (s, n = 16) => createHash("sha1").update(s).digest("hex").slice(0, n).toUpperCase();
const NOW = Math.floor(Date.now() / 3600e3) * 3600e3; // aligned to the hour like the hourly queries
const iso = (ms) => new Date(ms).toISOString().replace("Z", "000000Z");
const S = (v) => (v == null ? null : String(v)); // Grail longs arrive as strings

// ---------------- inventory ----------------
const DCS = [
  { code: "SPO1", uf: "SP", city: "São Paulo", lat: -23.55, lon: -46.63, net: "10.0" },
  { code: "CPS1", uf: "SP", city: "Campinas", lat: -22.91, lon: -47.06, net: "10.1" },
];
const CITIES = [
  ["South", "RS", "Porto Alegre", -30.03, -51.23], ["South", "RS", "Caxias do Sul", -29.17, -51.18], ["South", "PR", "Curitiba", -25.43, -49.27],
  ["South", "PR", "Londrina", -23.31, -51.16], ["South", "SC", "Florianópolis", -27.6, -48.55], ["South", "SC", "Joinville", -26.3, -48.85],
  ["Southeast", "SP", "Santos", -23.96, -46.33], ["Southeast", "SP", "Ribeirão Preto", -21.18, -47.81], ["Southeast", "RJ", "Rio de Janeiro", -22.91, -43.17],
  ["Southeast", "MG", "Belo Horizonte", -19.92, -43.94], ["Southeast", "MG", "Uberlândia", -18.92, -48.28], ["Southeast", "ES", "Vitória", -20.32, -40.34],
  ["Midwest", "GO", "Goiânia", -16.69, -49.26], ["Midwest", "DF", "Brasília", -15.79, -47.88], ["Midwest", "MT", "Cuiabá", -15.6, -56.1],
  ["Northeast", "BA", "Salvador", -12.97, -38.5], ["Northeast", "PE", "Recife", -8.05, -34.9], ["Northeast", "CE", "Fortaleza", -3.73, -38.52],
  ["North", "AM", "Manaus", -3.12, -60.02], ["North", "PA", "Belém", -1.46, -48.49],
];
const sites = DCS.map((d) => ({ ...d, dc: true, region: "Southeast", name: `Data Center ${d.city}` }));
for (let i = 0; i < 60; i++) {
  const [region, uf, city, lat, lon] = CITIES[i % CITIES.length];
  const code = `${({ Belém: "BLM" })[city] ?? city.normalize("NFD").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}${Math.floor(i / CITIES.length) + 1}`;
  const size = i % 5 === 0 ? "L" : i % 3 === 0 ? "S" : "M";
  const hub = ["Northeast", "North"].includes(region) ? "CPS1" : "SPO1";
  sites.push({ code, uf, city, region, hub, size, dc: false, name: `Loja ${city} ${Math.floor(i / CITIES.length) + 1}`, lat: +(lat + uni(-0.15, 0.15)).toFixed(3), lon: +(lon + uni(-0.15, 0.15)).toFixed(3), net: `10.${10 + i}` });
}
const carrierOf = (s) => (s.region === "South" ? "Carrier B" : s.region === "North" ? "Carrier D" : pick(["Carrier A", "Carrier A", "Carrier B"]));
const circuits = [];
for (const s of sites.filter((x) => !x.dc)) {
  const carrier = carrierOf(s);
  circuits.push({ circuit_id: `CIR-${s.code}-P`, site: s.code, kind: "primary", carrier, tech: carrier === "Carrier D" ? "Satellite VSAT 10 Mbps" : `MPLS ${s.size === "L" ? 200 : 50} Mbps`, sla_ms: carrier === "Carrier D" ? 700 : 80, bandwidth_mbps: s.size === "L" ? 200 : carrier === "Carrier D" ? 10 : 50, pe_ip: `${s.net}.254.1`, hub: s.hub });
  if (s.size !== "S") circuits.push({ circuit_id: `CIR-${s.code}-B`, site: s.code, kind: "backup", carrier: "Carrier C", tech: "Internet 50 Mbps · SD-WAN", sla_ms: 150, bandwidth_mbps: 50, pe_ip: `${s.net}.254.5`, hub: s.hub });
}

// Inventory travels as primary Grail tags: one SNMP monitoring configuration per site carries the site tags
// (they land on the device and interface nodes, metrics and logs of that configuration), and one ICMP
// network availability monitor per WAN circuit carries the circuit tags (they land on its metrics and events).
const siteTags = (s) => ({
  "primary_tags.site": s.code, "primary_tags.site_name": s.name, "primary_tags.site_type": s.dc ? "datacenter" : "branch",
  "primary_tags.region": s.region, "primary_tags.state": s.uf, "primary_tags.city": s.city,
  "primary_tags.geo_lat": String(s.lat), "primary_tags.geo_lon": String(s.lon), "primary_tags.hub": s.hub ?? s.code,
});
const circuitTags = (c) => ({
  "primary_tags.site": c.site, "primary_tags.circuit_id": c.circuit_id, "primary_tags.circuit_role": c.kind, "primary_tags.carrier": c.carrier,
  "primary_tags.circuit_tech": c.tech, "primary_tags.sla_ms": String(c.sla_ms), "primary_tags.bandwidth_mbps": String(c.bandwidth_mbps),
});
const NO_CIRCUIT = { "primary_tags.circuit_id": null, "primary_tags.circuit_role": null, "primary_tags.carrier": null, "primary_tags.circuit_tech": null, "primary_tags.sla_ms": null, "primary_tags.bandwidth_mbps": null };

// ---------------- scenarios ----------------
// 1) Carrier B outage for 6 South sites since 47 min ago: edge routers stop answering SNMP and ICMP.
const outage = sites.filter((s) => !s.dc && carrierOf(s) === "Carrier B" && s.region === "South").slice(0, 6).map((s) => s.code);
// the outage opens 20 minutes into the hour before last: sessions are read from that settled hour (the
// one after it is still filling), so it is the first low one
const OUTAGE_SINCE = Math.floor(NOW / 3600e3) * 3600e3 - 100 * 60e3;
// 2) Firewall CPU saturation in CPS1. 3) Uplink saturation in one large store. 4) CRC errors on a store switch.
const SAT_SITE = sites.find((s) => s.size === "L" && !outage.includes(s.code)).code;
const CRC_SITE = sites.find((s) => s.size === "M" && s.region === "Southeast").code;

// ---------------- devices and interfaces (smartscape nodes) ----------------
const EXT = {
  // feature sets as named in the Generic Cisco Device docs; error/CRC counters live in "Interfaces 32-bit"
  cisco: { type: "cisco", ext: "snmp-generic-cisco-device", q: "trCisco", features: ["Health", "Interfaces", "Interfaces 32-bit", "Interfaces 64-bit", "Traffic", "Cisco BGP", "OSPF", "neighbor-discovery"] },
  juniper: { type: "juniper", ext: "snmp-generic-juniper", q: "trJuniper", features: ["default"] },
  generic: { type: "generic", ext: "snmp-generic-device", q: "trGeneric", features: ["default"] },
  palo: { type: "palo-alto", ext: "palo-alto-generic", q: null, features: ["default"] },
  f5: { type: "f5-big-ip", ext: "f5.bigip", q: null, features: ["default"] },
};
const devices = [];
const add = (s, role, n, vendor, ifaces, descr) => {
  const name = `BR-${s.uf}-${s.code}-${role}${n}`;
  const ip = `${s.net}.${{ RTR: 1, CON: 1, FWL: 2, LBL: 3, WLC: 4, SWT: 10, APW: 20 }[role]}.${n}`;
  devices.push({ name, site: s, role, vendor, ip, ifaces, descr, id: `EXT_NETWORK_DEVICE-${hex(name)}`, mac: hex(`${name}mac`, 12).match(/../g).join(":") });
};
for (const s of sites) {
  if (s.dc) {
    add(s, "CON", 1, "juniper", 48, "Juniper Networks, Inc. mx480 internet router, kernel JUNOS 22.4R3");
    add(s, "CON", 2, "juniper", 48, "Juniper Networks, Inc. mx480 internet router, kernel JUNOS 22.4R3");
    add(s, "FWL", 1, "palo", 16, "Palo Alto Networks PA-5220 series firewall");
    add(s, "LBL", 1, "f5", 8, "BIG-IP i5800 : Linux 3.10.0 : BIG-IP software release 17.1.1");
    for (let n = 1; n <= 4; n++) add(s, "SWT", n, "cisco", 48, "Cisco NX-OS(tm) n9000, Software (n9000-dk9), Version 10.3(4a)");
    add(s, "WLC", 1, "cisco", 4, "Cisco Controller 9800-40");
  } else {
    add(s, "RTR", 1, "cisco", 6, "Cisco IOS XE Software, ISR4331, Version 17.9.4a");
    const sw = s.size === "L" ? 3 : s.size === "M" ? 2 : 1, ap = s.size === "L" ? 8 : s.size === "M" ? 4 : 2;
    for (let n = 1; n <= sw; n++) add(s, "SWT", n, "cisco", 24, "Cisco IOS Software, C9200L Software (C9200L-UNIVERSALK9-M), Version 17.9.4");
    for (let n = 1; n <= ap; n++) add(s, "APW", n, "generic", 2, "Aruba AP-515, ArubaOS 10.4");
    if (s.size !== "S") add(s, "FWL", 1, "palo", 8, "Palo Alto Networks PA-440 firewall");
  }
}
const deviceNodes = devices.map((d) => ({
  "autodiscovery.config_label": d.site.dc ? `${d.site.code} datacenter` : `${d.site.region} stores`,
  "autodiscovery.default_extension": `com.dynatrace.extension.${EXT[d.vendor].ext}`,
  "autodiscovery.group_label": `${d.site.region} stores`,
  "cdp.device_id": "n/a", chassis_mac: d.mac, contact: "noc@example.com", description: d.descr,
  device_type: EXT[d.vendor].type, "dt.security_context": [], id: d.id, id_classic: `CUSTOM_DEVICE-${hex(d.name + "c")}`,
  interface_count: S(d.ifaces), ip: [d.ip], lifetime: { start: iso(NOW - 90 * 864e5), end: iso(NOW - 4 * 60e3) },
  "lldp.chassis_id": d.mac, location: `${d.site.name}, ${d.site.uf}`, mac: [d.mac], monitoring_mode: "Extension", name: d.name,
  "snmp.ip": d.ip, "snmp.sys_object_id": ".1.3.6.1.4.1.9.1.2068", "troubleshooting.upsert_source": `extension:${EXT[d.vendor].ext}|metric:sysuptime`, type: "EXT_NETWORK_DEVICE",
  ...siteTags(d.site),
}));
const IFNAME = { cisco: (i, d) => (d.role === "RTR" ? ["GigabitEthernet0/0/0", "GigabitEthernet0/0/1", "GigabitEthernet0/0/2", "Tunnel100", "Tunnel200", "Loopback0"][i] : i < 2 ? `TenGigabitEthernet1/1/${i + 1}` : `GigabitEthernet1/0/${i - 1}`), juniper: (i) => (i < 8 ? `xe-0/0/${i}` : `ge-1/0/${i - 8}`), generic: (i) => ["eth0", "radio0"][i] ?? `eth${i}`, palo: (i) => `ethernet1/${i + 1}`, f5: (i) => `1.${i + 1}` };
const ifaces = [];
for (const d of devices) {
  for (let i = 0; i < d.ifaces; i++) {
    const name = IFNAME[d.vendor](i, d);
    const speed = /^(xe-|TenGig)/.test(name) ? 10000 : d.role === "RTR" && i < 2 ? (d.site.size === "L" ? 200 : 50) : /Tunnel|Loopback/.test(name) ? 0 : 1000;
    const down = outage.includes(d.site.code) && d.role === "RTR" && i === 0;
    const used = d.role !== "SWT" || i < 2 || i % 3 === 0;
    ifaces.push({ d, i, name, speed, up: used && !down, id: `EXT_NETWORK_INTERFACE-${hex(d.name + name)}` });
  }
}
const ifaceNodes = ifaces.map((f) => ({
  admin_status: "up(1)", alias: f.d.role === "RTR" && f.i === 0 ? `WAN ${circuits.find((c) => c.site === f.d.site.code)?.circuit_id ?? ""}` : "n/a",
  description: f.name, "device.chassis_mac": f.d.mac, "dt.security_context": [], id: f.id, id_classic: `CUSTOM_DEVICE-${hex(f.id)}`,
  interface_index: S(f.i + 1), interface_type: /Tunnel/.test(f.name) ? "tunnel(131)" : /Loopback/.test(f.name) ? "softwareLoopback(24)" : "ethernetCsmacd(6)",
  lifetime: { start: iso(NOW - 90 * 864e5), end: iso(NOW - 4 * 60e3) }, mac: [f.d.mac], mtu: "1500", name: f.name,
  operational_status: f.up ? "up(1)" : "down(2)", promiscuous_mode: "false(2)", speed: S(f.speed),
  "troubleshooting.upsert_source": `extension:${EXT[f.d.vendor].ext}|metric:if.status`, type: "EXT_NETWORK_INTERFACE",
  ...siteTags(f.d.site),
}));

// ---------------- metrics (as timeseries query results) ----------------
const tf = (bucketMs, n) => ({ timeframe: { start: iso(NOW - bucketMs * n), end: iso(NOW) }, interval: S(bucketMs * 1e6) });
const B5 = 300e3, N5 = 24, B1H = 3600e3, N1H = 24;
const inOutage = (d, bucketStart) => outage.includes(d.site.code) && d.role === "RTR" && bucketStart + B5 > OUTAGE_SINCE;
const siteDark = (d, t) => outage.includes(d.site.code) && !circuits.some((c) => c.site === d.site.code && c.kind === "backup") && t + B5 > OUTAGE_SINCE;
const unreachable = (d, t) => inOutage(d, t) || siteDark(d, t);

const results = { trCisco: [], trJuniper: [], trGeneric: [], errCisco: [], errJuniper: [], errGeneric: [], cpu: [], uptime: [], icmp: [] };
for (const f of ifaces) {
  const q = EXT[f.d.vendor].q;
  if (!q) continue;
  const i = [], o = [], errs = { ie: [], oe: [], idc: [], odc: [], crc: [] };
  for (let k = 0; k < N5; k++) {
    const t = NOW - (N5 - k) * B5;
    if (unreachable(f.d, t)) { i.push(null); o.push(null); Object.values(errs).forEach((a) => a.push(null)); continue; }
    let util = !f.up || !f.speed ? 0 : f.d.role === "RTR" && f.i < 2 ? uni(0.35, 0.6) : f.speed >= 10000 ? uni(0.08, 0.3) : uni(0.01, 0.12);
    if (f.d.site.code === SAT_SITE && f.d.role === "RTR" && f.i === 0 && k > 12) util = uni(0.92, 0.99);
    const bytes = Math.round((util * f.speed * 1e6 * 300) / 8);
    i.push(bytes); o.push(Math.round(bytes * uni(0.2, 0.6)));
    const crc = f.d.site.code === CRC_SITE && f.d.role === "SWT" && f.i === 1 ? int(40, 180) : 0;
    errs.ie.push(crc); errs.crc.push(crc); errs.oe.push(0); errs.idc.push(f.d.site.code === SAT_SITE && f.d.role === "RTR" && k > 12 ? int(200, 900) : 0); errs.odc.push(0);
  }
  const base = { "dt.smartscape.ext_network_device": f.d.id, "dt.smartscape.ext_network_interface": f.id, "if.name": f.name, ...tf(B5, N5) };
  if (q === "trJuniper") {
    results.trJuniper.push({ ...base, "if.speed": S(f.speed), i, o });
    results.errJuniper.push({ "dt.smartscape.ext_network_interface": f.id, ...tf(B5, N5), ie: errs.ie, oe: errs.oe, idc: errs.idc, odc: errs.odc });
  } else {
    results[q].push({ ...base, i, o, s: i.map((v) => (v == null ? null : f.speed)) });
    const e = { "dt.smartscape.ext_network_interface": f.id, ...tf(B5, N5), ie: errs.ie, oe: errs.oe, idc: errs.idc, odc: errs.odc };
    if (q === "trCisco") results.errCisco.push({ ...e, crc: errs.crc }); else results.errGeneric.push(e);
  }
}
for (const d of devices) {
  if (d.vendor !== "generic") {
    const hot = d.site.code === "CPS1" && d.role === "FWL";
    results.cpu.push({ "dt.smartscape.ext_network_device": d.id, ...tf(B5, N5), cpu: Array.from({ length: N5 }, (_, k) => (unreachable(d, NOW - (N5 - k) * B5) ? null : hot && k > 8 ? Math.round(uni(91, 98)) : Math.round(uni(6, d.role === "FWL" ? 45 : 30)))) });
  }
  results.uptime.push({ c: Array.from({ length: N1H }, (_, k) => (unreachable(d, NOW - (N1H - k) * B1H + B1H - B5) ? null : "60")), "dt.smartscape.ext_network_device": d.id, ...tf(B1H, N1H) });
}
// ICMP network availability monitors, run from a private location in each hub (one ping every 5 min):
//  - one per WAN circuit, pinging the carrier side of the circuit, tagged with the circuit inventory;
//  - one per store, pinging the edge router, tagged with the site only.
const LOCS = { SPO1: `SYNTHETIC_LOCATION-${hex("agSPO1")}`, CPS1: `SYNTHETIC_LOCATION-${hex("agCPS1")}` };
results.icmpNow = [];
const probe = (row, rttBase, downFrom) => {
  for (const [key, bucket, n] of [["icmp", B1H, N1H], ["icmpNow", B5, N5]]) {
    const rtt = [], sent = [], recv = [];
    for (let k = 0; k < n; k++) {
      const t = NOW - (n - k) * bucket, per = bucket / B5;
      const lost = downFrom == null ? 0 : Math.max(0, Math.min(t + bucket, NOW) - Math.max(t, downFrom)) / bucket;
      const r = Math.round(per * (1 - lost));
      sent.push(S(per)); recv.push(S(r)); rtt.push(r ? +(rttBase + uni(-1, 4)).toFixed(3) : null);
    }
    results[key].push({ "dt.entity.synthetic_location": row.loc, "dt.entity.multiprotocol_monitor": row.monitor, "monitor.name": row.name, ...tf(bucket, n), recv, "request.target_address": row.target, rtt, sent, ...row.tags });
  }
};
// Two faults nobody alerted on, so the app has to report them on its own terms: one circuit slower than
// the SLA tagged on its monitor, and one that stopped answering while no alert covers it.
const SLOW_SITE = sites.find((s) => !outage.includes(s.code) && s.size === "M" && s.code !== SAT_SITE && s.code !== CRC_SITE).code;
const SILENT_SITE = sites.find((s) => !outage.includes(s.code) && s.code !== SLOW_SITE && s.code !== SAT_SITE
  && circuits.some((c) => c.site === s.code && c.kind === "backup")).code;
for (const c of circuits) {
  const s = sites.find((x) => x.code === c.site);
  const slow = c.site === SLOW_SITE && c.kind === "primary";
  const rttBase = slow ? c.sla_ms * 1.2 : c.carrier === "Carrier D" ? 610 : c.kind === "backup" ? 34 : 12 + Math.hypot(s.lat + 23.5, s.lon + 46.6) * 0.9;
  const down = (outage.includes(s.code) && c.kind === "primary") || (c.site === SILENT_SITE && c.kind === "backup") ? OUTAGE_SINCE : null;
  probe({ loc: LOCS[c.hub], name: `WAN ${c.circuit_id}`, monitor: `MULTIPROTOCOL_MONITOR-${hex(`mon${c.circuit_id}`)}`, target: c.pe_ip, tags: circuitTags(c) }, rttBase, down);
}
for (const s of sites.filter((x) => !x.dc)) {
  const rtr = devices.find((d) => d.site === s && d.role === "RTR");
  const dark = outage.includes(s.code) && !circuits.some((x) => x.site === s.code && x.kind === "backup");
  probe({ loc: LOCS[s.hub], name: `Store ${s.code} edge`, monitor: `MULTIPROTOCOL_MONITOR-${hex(`mon${s.code}`)}`, target: rtr.ip, tags: { "primary_tags.site": s.code, ...NO_CIRCUIT } }, 14 + Math.hypot(s.lat + 23.5, s.lon + 46.6), dark ? OUTAGE_SINCE : null);
}

// ---------------- logs: syslog, traps, netflow; events: OneAgent flows ----------------
const syslog = [], traps = [], netflow = [], flowsOA = [];
const sev2level = (sv) => (sv <= 3 ? "ERROR" : sv === 4 ? "WARN" : "INFO");
const pushSyslog = (d, t, app, sv, content) => syslog.push({
  content, "dt.entity.syslog:device": `CUSTOM_DEVICE-${hex(d.ip)}`, "dt.ingest.port": "514", "dt.ingest.source.ip": d.ip,
  "dt.openpipeline.pipelines": ["logs:pipeline_SyslogPipeline_6275"], "dt.openpipeline.source": "extension:syslog", "dt.source_entity": `CUSTOM_DEVICE-${hex(d.ip)}`,
  facility_text: "local7", loglevel: sev2level(sv), status: sev2level(sv), "syslog.appname": app, "syslog.facility": "23", "syslog.hostname": d.name,
  "syslog.priority": S(184 + sv), "syslog.severity": S(sv), timestamp: iso(t),
});
const ROUTINE = [["%SYS-5-CONFIG_I", 5, "Configured from console by netops on vty0 (10.0.9.14)"], ["%LINEPROTO-5-UPDOWN", 5, "Line protocol on Interface GigabitEthernet1/0/7, changed state to up"], ["%DOT1X-5-SUCCESS", 5, "Authentication successful for client (a4c3.f0aa.0012) on Interface Gi1/0/9"], ["%SEC_LOGIN-5-LOGIN_SUCCESS", 5, "Login Success [user: netops] [Source: 10.0.9.14]"]];
for (const d of devices.filter((x) => x.vendor === "cisco" || x.vendor === "juniper")) {
  for (let n = int(2, 10); n > 0; n--) { const [a, sv, c] = pick(ROUTINE); const t = NOW - uni(0, 24) * B1H; if (!unreachable(d, t)) pushSyslog(d, t, a, sv, c); }
}
const hubCore = (hub) => devices.find((d) => d.site.code === hub && d.name.endsWith("CON1"));
for (const code of outage) {
  const s = sites.find((x) => x.code === code), core = hubCore(s.hub), rtr = devices.find((d) => d.site === s && d.role === "RTR");
  pushSyslog(core, OUTAGE_SINCE + 20e3, "%BGP-5-ADJCHANGE", 3, `neighbor ${rtr.ip} Down BGP Notification sent (hold time expired)`);
  pushSyslog(core, OUTAGE_SINCE + 21e3, "%BGP-3-NOTIFICATION", 3, `sent to neighbor ${rtr.ip} 4/0 (hold time expired) 0 bytes`);
  pushSyslog(core, OUTAGE_SINCE + 5e3, "%TRACK-6-STATE", 4, `100 ip sla 10 reachability Up -> Down (${code} primary circuit)`);
  traps.push({ content: `SNMP trap (IF-MIB::linkDown) reported from src:${core.ip}\n agent:${core.ip}\n ifIndex:${int(9, 40)}`, "device.address": core.ip, "log.source": "snmptraps", "snmp.trap_oid": "IF-MIB::linkDown", timestamp: iso(OUTAGE_SINCE + 3e3) });
  traps.push({ content: `SNMP trap (BGP4-MIB::bgpBackwardTransition) reported from src:${core.ip}\n peer:${rtr.ip}`, "device.address": core.ip, "log.source": "snmptraps", "snmp.trap_oid": "BGP4-MIB::bgpBackwardTransition", timestamp: iso(OUTAGE_SINCE + 20e3) });
}
const fw = devices.find((d) => d.site.code === "CPS1" && d.role === "FWL");
for (let k = 0; k < 14; k++) pushSyslog(fw, NOW - (80 - k * 5) * 60e3, "%PAN-SYSTEM-2-DP_CPU", 2, `Dataplane CPU utilisation above 90% on dp0 (${int(91, 98)}%) · session setup rate ${int(9, 14)}k/s`);
const crcSw = devices.find((d) => d.site.code === CRC_SITE && d.role === "SWT");
for (let k = 0; k < 9; k++) pushSyslog(crcSw, NOW - (170 - k * 18) * 60e3, "%ETHCNTR-3-HALF_DUX_COLLISION_EXCEED_THRESHOLD", 3, "Collisions and CRC errors on TenGigabitEthernet1/1/2 exceed threshold");
for (const d of devices.filter((x) => x.role === "SWT").slice(0, 40)) traps.push({ content: `SNMP trap (IF-MIB::linkUp) reported from src:${d.ip}\n agent:${d.ip}\n ifIndex:${int(3, 24)}`, "device.address": d.ip, "log.source": "snmptraps", "snmp.trap_oid": "IF-MIB::linkUp", timestamp: iso(NOW - uni(0, 23) * B1H) });

// NetFlow from DC cores and large-store routers (exporter = flow.sampler_address, with ifIndex).
const APPS = [["10.0.50.10", "443", "tcp", 9], ["10.0.50.20", "1433", "tcp", 3], ["10.1.60.5", "8443", "tcp", 4], ["52.96.0.10", "443", "tcp", 6], ["10.0.50.30", "53", "udp", 1], ["142.250.0.10", "443", "udp", 2]];
const exporters = devices.filter((d) => d.role === "CON" || (d.role === "RTR" && d.site.size === "L"));
for (const d of exporters) {
  for (let k = 0; k < N5; k++) {
    const t = NOW - (N5 - k) * B5;
    if (unreachable(d, t)) continue;
    for (let n = int(8, 18); n > 0; n--) {
      const [dst, dport, proto, w] = pick(APPS);
      netflow.push({ "otel.scope.name": "otelcol/netflowreceiver", "flow.type": "netflow_v9", "flow.sampler_address": d.ip, "flow.in_if": S(int(1, 4)), "flow.out_if": S(int(1, 4)), "flow.io.bytes": S(Math.round(w * uni(2e6, 8e7) * (d.site.code === SAT_SITE ? 3 : 1))), "network.transport": proto, "source.address": `${d.site.net}.${int(30, 200)}.${int(2, 250)}`, "destination.address": dst, "destination.port": dport, timestamp: iso(t + uni(0, B5)) });
    }
  }
}
// OneAgent network flows on the data-center application hosts.
const HOSTS = [["erp-app-01", "erp-prod"], ["erp-app-02", "erp-prod"], ["pdv-api-01", "pdv-k8s"], ["pdv-api-02", "pdv-k8s"], ["pdv-api-03", "pdv-k8s"]];
for (const [host, cluster] of HOSTS) {
  for (let n = 0; n < 400; n++) {
    const tx = int(2e4, 9e6), pk = Math.round(tx / 900);
    flowsOA.push({ "dt.smartscape.host": `HOST-${hex(host)}`, "dt.smartscape.process": `PROCESS-${hex(host + (n % 6))}`, "host.name": host, "k8s.cluster.name": cluster, "cloud.provider": null, "network_flow.destination.address": pick(["10.0.50.20", "10.1.60.5", `10.${int(10, 69)}.${int(30, 200)}.${int(2, 250)}`]), "network_flow.destination.port": pick(["1433", "8443", "443"]), "network_flow.bytes.tx": S(tx), "network_flow.bytes.rx": S(Math.round(tx * uni(0.1, 2))), "network_flow.packets.tx": S(pk), "network_flow.packets.rx": S(pk), "network_flow.packets.retransmitted.tx": S(host.startsWith("pdv") ? int(0, Math.round(pk * 0.02)) : 0), "network_flow.packets.retransmitted.rx": "0", "network_flow.tcp.sessions.reset": S(int(0, 2)), timestamp: iso(NOW - uni(0, 24) * B1H) });
  }
}

// ---------------- the app's queries over those stores ----------------
const ts = (ms) => Date.parse(ms.replace(/0{6}Z$/, "Z"));
const within = (recs, h) => recs.filter((r) => ts(r.timestamp) >= NOW - h * B1H);
const groupBy = (recs, keyFn) => { const m = new Map(); for (const r of recs) { const k = keyFn(r); m.set(k, [...(m.get(k) ?? []), r]); } return m; };
const makeTs = (recs, key, bucket, n) => [...groupBy(recs, key)].map(([k, rs]) => { const a = new Array(n).fill(null); for (const r of rs) { const b = Math.floor((ts(r.timestamp) - (NOW - bucket * n)) / bucket); if (b >= 0 && b < n) a[b] = (a[b] ?? 0) + 1; } return [k, a]; });

results.devices = deviceNodes;
results.interfaces = ifaceNodes;
results.syslogSum = [...groupBy(within(syslog, 24), (r) => `${r["dt.ingest.source.ip"]}|${r.loglevel}`)].map(([k, rs]) => ({ ip: k.split("|")[0], loglevel: k.split("|")[1], n: S(rs.length) }));
results.syslogTs = makeTs(within(syslog, 24).filter((r) => r.loglevel === "ERROR"), (r) => r["dt.ingest.source.ip"], B1H, N1H).map(([ip, n]) => ({ interval: S(B1H * 1e6), ip, n: n.map(S), timeframe: tf(B1H, N1H).timeframe }));
results.syslogRecent = within(syslog, 3).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 1000).map((r) => ({ app: r["syslog.appname"], content: r.content, ip: r["dt.ingest.source.ip"], loglevel: r.loglevel, timestamp: r.timestamp }));
results.traps = within(traps, 24).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 300).map((r) => ({ content: r.content, "device.address": r["device.address"], "snmp.trap_oid": r["snmp.trap_oid"], timestamp: r.timestamp }));
const cisco = (k) => `com.dynatrace.extension.snmp-generic-cisco-device.${k}`;
results.lldp = devices.flatMap((d) => {
  const up = d.role === "APW" || d.role === "FWL" ? devices.find((x) => x.site === d.site && x.role === "SWT") : d.role === "SWT" ? devices.find((x) => x.site === d.site && (x.role === "RTR" || x.role === "CON")) : null;
  return up ? [{ "neighbor.port.id": `Gi1/0/${int(1, 24)}`, "neighbor.sys.name": up.name, "sys.name": d.name }] : [];
});
results.routing = [
  ...devices.filter((d) => d.role === "RTR").map((d) => ({ "cbgp.peer.state": outage.includes(d.site.code) ? "idle(1)" : "established(6)", "cbgp.remote.as": "65000", "cbgp.remote.identifier": hubCore(d.site.hub).ip, "metric.key": cisco("cbgp.peer.state"), "ospf.nbr.ip.addr": null, "ospf.nbr.state": null, "sys.name": d.name })),
  ...DCS.map((dc) => ({ "cbgp.peer.state": null, "cbgp.remote.as": null, "cbgp.remote.identifier": null, "metric.key": cisco("ospf.nbr.state"), "ospf.nbr.ip.addr": `${dc.net}.1.2`, "ospf.nbr.state": "full(8)", "sys.name": `BR-SP-${dc.code}-CON1` })),
];
const nf2 = within(netflow, 2), nf1 = within(netflow, 1);
results.flowTs = makeTs(nf2, (r) => r["flow.sampler_address"], B5, N5).map(([exp, flows]) => ({ exp, flows: flows.map((v) => v ?? 0), ...tf(B5, N5) })).slice(0, 500);
results.flowProto = [...groupBy(nf1, (r) => `${r["flow.sampler_address"]}|${r["network.transport"]}`)].map(([k, rs]) => ({ exp: k.split("|")[0], flows: S(rs.length), gb: String(rs.reduce((a, r) => a + +r["flow.io.bytes"], 0) / 1e9), proto: k.split("|")[1] })).sort((a, b) => b.flows - a.flows).slice(0, 100);
results.flowTop = [...groupBy(nf1, (r) => [r["flow.sampler_address"], r["source.address"], r["destination.address"], r["network.transport"], r["destination.port"]].join("|"))].map(([k, rs]) => { const [exp, src, dst, proto, dport] = k.split("|"); return { dport, dst, exp, flows: S(rs.length), gb: String(rs.reduce((a, r) => a + +r["flow.io.bytes"], 0) / 1e9), proto, src }; }).sort((a, b) => b.gb - a.gb).slice(0, 60);
results.cloud = [...groupBy(flowsOA, (r) => `${r["k8s.cluster.name"]}|${r["cloud.provider"]}`)].map(([k, rs]) => ({ bytes: S(rs.reduce((a, r) => a + +r["network_flow.bytes.tx"] + +r["network_flow.bytes.rx"], 0)), cloud: null, cluster: k.split("|")[0], conv: S(rs.length), hosts: S(new Set(rs.map((r) => r["dt.smartscape.host"])).size), pkts: S(rs.reduce((a, r) => a + +r["network_flow.packets.tx"] + +r["network_flow.packets.rx"], 0)), procs: S(new Set(rs.map((r) => r["dt.smartscape.process"])).size), retr: S(rs.reduce((a, r) => a + +r["network_flow.packets.retransmitted.tx"] + +r["network_flow.packets.retransmitted.rx"], 0)) }));
results.cloudTop = [...groupBy(flowsOA, (r) => [r["host.name"], r["k8s.cluster.name"], r["network_flow.destination.address"], r["network_flow.destination.port"]].join("|"))].map(([k, rs]) => { const [host, cluster, dst, dport] = k.split("|"); const tx = rs.reduce((a, r) => a + +r["network_flow.bytes.tx"], 0), rx = rs.reduce((a, r) => a + +r["network_flow.bytes.rx"], 0); return { bytes: S(tx + rx), cluster, dport, dst, host, resets: S(rs.reduce((a, r) => a + +r["network_flow.tcp.sessions.reset"], 0)), retr: S(rs.reduce((a, r) => a + +r["network_flow.packets.retransmitted.tx"], 0)), rx: S(rx), tx: S(tx) }; }).sort((a, b) => b.bytes - a.bytes).slice(0, 40);

// ---------------- what Dynatrace is alerting on ----------------
// The app takes every status from here: Davis problems, alert templates and custom alerts on the
// extensions. Each entry below exercises one of the ways an alert names a network element.
const problems = [], alerts = [];
const evid = (k) => `${hex(k)}_${NOW}`;
const problem = (o) => problems.push({ "event.kind": "DAVIS_PROBLEM", "event.status": "ACTIVE", "dt.davis.mute.status": "NOT_MUTED", "dt.davis.event_ids": [], affected_entity_ids: [], affected_entity_names: [], "smartscape.affected_entity.ids": [], ...o });
const alert = (o) => alerts.push({ "event.kind": "DAVIS_EVENT", "event.status": "ACTIVE", "dt.davis.mute.status": "NOT_MUTED", affected_entity_ids: [], affected_entity_names: [], ...o });

// 1. the carrier outage, raised on the monitors of the circuits that stopped answering
const downMonitors = circuits.filter((c) => outage.includes(c.site) && c.kind === "primary").map((c) => `MULTIPROTOCOL_MONITOR-${hex(`mon${c.circuit_id}`)}`);
problem({ "event.id": evid("outage"), display_id: "P-2609001", "event.name": "Network availability monitor global outage · Carrier B",
  "event.start": iso(OUTAGE_SINCE), "event.category": "AVAILABILITY", "smartscape.affected_entity.ids": downMonitors });

// 2. a custom alert from the firewall extension: it names its own custom device, not the Smartscape one,
// so only the entity name joins the two
const fwName = "BR-SP-CPS1-FWL1";
problem({ "event.id": evid("fwcpu"), display_id: "P-2609002", "event.name": "Firewall CPU utilization high", "event.start": iso(NOW - 40 * 60e3),
  "event.category": "CUSTOM_ALERT", affected_entity_ids: [`CUSTOM_DEVICE-${hex("paloalto-own-device")}`], affected_entity_names: [fwName] });

// 3. an alert template firing on one interface of the saturated uplink
const satDevice = devices.find((d) => d.site.code === SAT_SITE && d.role === "RTR");
const satIface = ifaces.find((f) => f.d === satDevice && f.up);
problem({ "event.id": evid("sat"), display_id: "P-2609003", "event.name": "Interface saturation", "event.start": iso(NOW - 50 * 60e3),
  "event.category": "RESOURCE_CONTENTION", "smartscape.affected_entity.ids": [satIface.id] });

// 4. an event that never became a problem, raised straight on the device
const crcDevice = devices.find((d) => d.site.code === CRC_SITE && d.role === "SWT");
alert({ "event.id": evid("crc"), "event.type": "ERROR_EVENT", "event.name": "Interface CRC high rate", "event.category": "ERROR",
  "event.start": iso(NOW - 35 * 60e3), "dt.smartscape.ext_network_device": crcDevice.id });

// 5. a metric event bound to the environment: nothing names a device, so the app must surface it apart
alert({ "event.id": evid("mem"), "event.type": "CUSTOM_ALERT", "event.name": "Cisco Memory Free critical low", "event.category": "CUSTOM_ALERT",
  "event.start": iso(NOW - 3 * 3600e3), "dt.source_entity": "ENVIRONMENT-0000000000000001", affected_entity_ids: ["ENVIRONMENT-0000000000000001"] });

// 6. a muted problem: Dynatrace is not reporting it, so neither does the app
const mutedDevice = devices.find((d) => d.role === "SWT" && d.site.code !== CRC_SITE && !outage.includes(d.site.code));
problem({ "event.id": evid("muted"), display_id: "P-2609004", "event.name": "Interface flapping", "event.start": iso(NOW - 20 * 60e3),
  "event.category": "AVAILABILITY", "dt.davis.mute.status": "MUTED", "smartscape.affected_entity.ids": [mutedDevice.id] });

// 7. the same fault as an event and as the problem that groups it: it must be counted once
const dupEventId = evid("dup-event");
const dupDevice = devices.find((d) => d.role === "APW" && !outage.includes(d.site.code));
problem({ "event.id": evid("dup"), display_id: "P-2609005", "event.name": "Access point unreachable", "event.start": iso(NOW - 15 * 60e3),
  "event.category": "AVAILABILITY", "dt.davis.event_ids": [dupEventId], "smartscape.affected_entity.ids": [dupDevice.id] });
alert({ "event.id": dupEventId, "event.type": "AVAILABILITY_EVENT", "event.name": "Access point unreachable", "event.category": "AVAILABILITY",
  "event.start": iso(NOW - 15 * 60e3), "dt.smartscape.ext_network_device": dupDevice.id });

results.problems = problems;
results.alerts = alerts;

// ---------------- write ----------------
const jsonl = (name, rows) => writeFileSync(`${OUT}raw/${name}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
jsonl("smartscape.ext_network_device", deviceNodes);
jsonl("smartscape.ext_network_interface", ifaceNodes);
jsonl("logs.syslog", syslog);
jsonl("logs.snmptraps", traps);
jsonl("logs.netflow", netflow);
jsonl("events.default_network_flows", flowsOA);
// eslint-disable-next-line no-unused-vars
const csv = (rows) => [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map((v) => (/[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(","))].join("\n") + "\n";
// The standard configuration that produces those tags
const snmpConfigs = [];
for (const hub of DCS.map((d) => d.code)) for (const [vendor, e] of Object.entries(EXT)) {
  const ds = devices.filter((d) => (d.site.hub ?? d.site.code) === hub && d.vendor === vendor);
  if (!ds.length) continue;
  // schema ext:<extension> 4.x: snmp.devices[].primaryTags (max 20, key ^primary_tags\..+$), credential vault id in credentialVaultIdSnmpV3
  snmpConfigs.push({ extensionName: `com.dynatrace.extension.${e.ext}`, scope: `ag_group-network-${hub.toLowerCase()}`, value: {
    enabled: true, description: `Stores and data center behind ${hub}`, activationContext: "REMOTE", featureSets: e.features,
    snmp: { devices: ds.map((d) => ({ ip: d.ip, port: 161, authentication: { type: "SNMPv3", useCredentialVault: true, credentialVaultIdSnmpV3: "CREDENTIALS_VAULT-0123456789ABCDEF" }, primaryTags: Object.entries(siteTags(d.site)).map(([key, value]) => ({ key, value })) })) },
  } });
}
// Synthetic tags (settings schema builtin:synthetic.primary-grail-tags, scope MULTIPROTOCOL_MONITOR): max 10, key <= 50 chars
// WITHOUT the "primary_tags." prefix, value <= 200; they surface in Grail as primary_tags.<key>.
const plain = (tags) => Object.entries(tags).filter(([, v]) => v != null).map(([k, value]) => ({ key: k.replace(/^primary_tags\./, ""), value }));
const monitors = [
  ...circuits.map((c) => ({ name: `WAN ${c.circuit_id}`, type: "MULTI_PROTOCOL", frequencyMin: 5, locations: [LOCS[c.hub]], steps: [{ requestType: "ICMP", targetList: [c.pe_ip], properties: { ICMP_NUMBER_OF_PACKETS: "1" } }], "builtin:synthetic.primary-grail-tags": { tags: plain(circuitTags(c)) } })),
  ...sites.filter((x) => !x.dc).map((s) => ({ name: `Store ${s.code} edge`, type: "MULTI_PROTOCOL", frequencyMin: 5, locations: [LOCS[s.hub]], steps: [{ requestType: "ICMP", targetList: [devices.find((d) => d.site === s && d.role === "RTR").ip] }], "builtin:synthetic.primary-grail-tags": { tags: [{ key: "site", value: s.code }] } })),
];
writeFileSync(`${OUT}config/snmp-monitoring-configurations.json`, JSON.stringify(snmpConfigs, null, 1));
writeFileSync(`${OUT}config/network-availability-monitors.json`, JSON.stringify(monitors, null, 1));
// ---------------- real user sessions ----------------
// The outage takes sites off the air, so the last hours hold a fraction of the usual traffic. No traffic
// anomaly problem is generated on purpose: this is the case where the app reports a suspicion of its own.
const DAY = [22, 14, 9, 7, 8, 14, 34, 62, 88, 104, 112, 118, 121, 116, 110, 108, 104, 96, 84, 70, 58, 46, 36, 28];
const hourNow = new Date(NOW).getUTCHours();
const typicalHour = (i, len) => DAY[(((hourNow - (len - 1 - i)) % 24) + 24) % 24] * 9;
// demand falls from the hour the outage opened in (index 21), never before it
const sessions24 = Array.from({ length: 24 }, (_, i) => Math.round(typicalHour(i, 24) * (i >= 21 ? 0.15 : uni(0.9, 1.1))));
const week = Array.from({ length: 168 }, (_, i) => Math.round(typicalHour(i, 168) * uni(0.92, 1.08)));
results.sessions = [{ "dt.rum.application.type": "web", interval: "3600000000000", sessions: sessions24, timeframe: { start: iso(NOW - 24 * B1H), end: iso(NOW) } }];
results.sessionsTypical = [{ interval: "3600000000000", sessions: week, timeframe: { start: iso(NOW - 168 * B1H), end: iso(NOW) } }];
// requests served by the services: they fall with the outage too, less than the sessions
results.requests = [{ interval: "3600000000000", req: sessions24.map((v, i) => Math.round(v * 400 * (i >= 21 ? 2.6 : 1))), timeframe: { start: iso(NOW - 24 * B1H), end: iso(NOW) } }];
results.requestsTypical = [{ interval: "3600000000000", req: week.map((v) => v * 400), timeframe: { start: iso(NOW - 168 * B1H), end: iso(NOW) } }];
// client subnets: the ones that match a device /24 are the sites, the rest stay unattributed
results.sessionNets = [
  ...sites.filter((x) => !x.dc).slice(0, 8).map((s, i) => {
    const d = devices.find((x) => x.site === s && x.role === "RTR");
    return { ip: `${d.ip.split(".").slice(0, 3).join(".")}.0`, sessions: S(140 - i * 11) };
  }),
  { ip: "172.30.4.0", sessions: S(96) },
  { ip: "172.30.9.0", sessions: S(61) },
];

writeFileSync(`${OUT}results.json`, JSON.stringify(results));
writeFileSync(`${OUT}scenario.json`, JSON.stringify({ generatedFor: iso(NOW), outage: { carrier: "Carrier B", sites: outage, since: iso(OUTAGE_SINCE) },
 firewallCpu: fwName, uplinkSaturation: SAT_SITE, crcErrors: CRC_SITE, slowCircuit: SLOW_SITE, silentCircuit: SILENT_SITE,
 alerts: { satDevice: satDevice.name, satInterface: satIface.name, crcDevice: crcDevice.name, mutedDevice: mutedDevice.name, dupDevice: dupDevice.name, downMonitors: downMonitors.length } }, null, 1));
console.log(JSON.stringify({ sites: sites.length, devices: devices.length, interfaces: ifaces.length, circuits: circuits.length, syslog: syslog.length, traps: traps.length, netflow: netflow.length, oneagentFlows: flowsOA.length, rows: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])), outage }, null, 1));
