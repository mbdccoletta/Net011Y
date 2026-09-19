// Simulated Brazilian retail and distribution network at enterprise scale: five regions,
// ~400 sites, two data centers and four carriers. The extra-large size is the same company at
// ~4,200 sites and ~20,000 devices with four data centers, read the way the app reads an estate
// that size: per-device summaries instead of every port (DETAIL_MAX_DEVICES). Every name and number is fictitious and
// the UI labels it as an example. Health is judged with the same verdict and end-to-end
// rules as live data (model/verdict.ts, model/e2e.ts).
import type { AppExperience, AppTransaction, Circuit, Device, DeviceProblem, E2EPath, Hop, Iface, NetEvent, NetworkModel, PathLink, Site, Verdict } from "../model/types";
import { T, ORDER, worst, deviceVerdict } from "../model/verdict";
import { appHop, circuitHop, deviceHop, makePath } from "../model/e2e";
import { buildAddressing } from "../model/addressing";
import { buildFlowMap } from "./buildFlowMap";
import { DETAIL_MAX_DEVICES } from "./queries";

type Size = "L" | "M" | "S";
type CityRow = [name: string, uf: string, lat: number, lon: number];

const REGIONS: { name: string; sites: number; hub: string; cities: CityRow[] }[] = [
  { name: "Southeast", sites: 150, hub: "SPO1", cities: [
    ["São Paulo", "SP", -23.55, -46.63], ["Campinas", "SP", -22.91, -47.06], ["Santos", "SP", -23.96, -46.33], ["Ribeirão Preto", "SP", -21.18, -47.81],
    ["Sorocaba", "SP", -23.5, -47.46], ["São José dos Campos", "SP", -23.18, -45.89], ["Rio de Janeiro", "RJ", -22.91, -43.17], ["Niterói", "RJ", -22.88, -43.1],
    ["Belo Horizonte", "MG", -19.92, -43.94], ["Uberlândia", "MG", -18.92, -48.28], ["Juiz de Fora", "MG", -21.76, -43.35], ["Vitória", "ES", -20.32, -40.34],
  ] },
  { name: "South", sites: 84, hub: "SPO1", cities: [
    ["Curitiba", "PR", -25.43, -49.27], ["Londrina", "PR", -23.31, -51.16], ["Maringá", "PR", -23.42, -51.94], ["Cascavel", "PR", -24.96, -53.46],
    ["Florianópolis", "SC", -27.6, -48.55], ["Joinville", "SC", -26.3, -48.85], ["Blumenau", "SC", -26.92, -49.07], ["Porto Alegre", "RS", -30.03, -51.23],
    ["Caxias do Sul", "RS", -29.17, -51.18], ["Pelotas", "RS", -31.77, -52.34], ["Passo Fundo", "RS", -28.26, -52.41],
  ] },
  { name: "Midwest", sites: 72, hub: "SPO1", cities: [
    ["Brasília", "DF", -15.79, -47.88], ["Goiânia", "GO", -16.69, -49.26], ["Rio Verde", "GO", -17.79, -50.93], ["Cuiabá", "MT", -15.6, -56.1],
    ["Sorriso", "MT", -12.55, -55.72], ["Rondonópolis", "MT", -16.47, -54.64], ["Campo Grande", "MS", -20.46, -54.62], ["Dourados", "MS", -22.22, -54.81],
  ] },
  { name: "Northeast", sites: 64, hub: "CPS1", cities: [
    ["Salvador", "BA", -12.97, -38.5], ["Feira de Santana", "BA", -12.27, -38.97], ["Recife", "PE", -8.05, -34.88], ["Fortaleza", "CE", -3.73, -38.52],
    ["Natal", "RN", -5.79, -35.21], ["João Pessoa", "PB", -7.12, -34.86], ["Maceió", "AL", -9.67, -35.74], ["São Luís", "MA", -2.53, -44.3],
    ["Teresina", "PI", -5.09, -42.8], ["Petrolina", "PE", -9.39, -40.5],
  ] },
  { name: "North", sites: 38, hub: "CPS1", cities: [
    ["Manaus", "AM", -3.12, -60.02], ["Belém", "PA", -1.46, -48.49], ["Santarém", "PA", -2.44, -54.71], ["Porto Velho", "RO", -8.76, -63.9],
    ["Palmas", "TO", -10.18, -48.33], ["Macapá", "AP", 0.03, -51.07], ["Boa Vista", "RR", 2.82, -60.67],
  ] },
];

type DcSpec = [key: string, role: string, model: string, cpu: number];
const BASE_DCS: { code: string; name: string; uf: string; lat: number; lon: number; specs: DcSpec[] }[] = [
  { code: "SPO1", name: "Data Center São Paulo", uf: "SP", lat: -23.55, lon: -46.63, specs: [
    ["CON1", "core", "Cisco ASR 1002-HX", 46], ["CON2", "core", "Cisco ASR 1002-HX", 39], ["COR1", "core", "Cisco Nexus 9336C", 22],
    ["FWL1", "firewall", "Palo Alto PA-5220", 34], ["FWL2", "firewall", "Palo Alto PA-5220", 29], ["LBL1", "lb", "F5 BIG-IP i5800", 18],
    ["SWT1", "switch", "Cisco Nexus 93180YC", 9], ["SWT2", "switch", "Cisco Nexus 93180YC", 8],
  ] },
  { code: "CPS1", name: "Data Center Campinas", uf: "SP", lat: -22.91, lon: -47.06, specs: [
    ["CON1", "core", "Cisco ASR 1002-HX", 41], ["COR1", "core", "Cisco Nexus 9336C", 24], ["FWL1", "firewall", "Palo Alto PA-3260", 78],
    ["LBL1", "lb", "F5 BIG-IP i4800", 21], ["SWT1", "switch", "Cisco Nexus 93180YC", 10],
  ] },
];
// an estate of the extra-large size runs regional data centers too
const XL_DCS: typeof BASE_DCS = [
  { code: "RIO1", name: "Data Center Rio de Janeiro", uf: "RJ", lat: -22.91, lon: -43.17, specs: [
    ["CON1", "core", "Cisco ASR 1006-X", 44], ["CON2", "core", "Cisco ASR 1006-X", 37], ["COR1", "core", "Cisco Nexus 9364C", 26],
    ["FWL1", "firewall", "Palo Alto PA-5250", 41], ["LBL1", "lb", "F5 BIG-IP i7800", 23], ["SWT1", "switch", "Cisco Nexus 93180YC", 11],
  ] },
  { code: "REC1", name: "Data Center Recife", uf: "PE", lat: -8.05, lon: -34.88, specs: [
    ["CON1", "core", "Cisco ASR 1002-HX", 38], ["COR1", "core", "Cisco Nexus 9336C", 21], ["FWL1", "firewall", "Palo Alto PA-3260", 33],
    ["SWT1", "switch", "Cisco Nexus 93180YC", 9],
  ] },
];
/** Sites per region and single-site scenarios grow by this factor in the extra-large size */
const XL = 10.25;

interface Scenario {
  circuitsDown?: number;
  primaryDown?: number;
  backupDown?: number;
  degraded?: { latencyMs: number; lossPct: number; jitterMs: number };
  routerDown?: number;
  switchDown?: number;
  apDown?: number;
  cpu?: number;
  wanSaturated?: number;
  optic?: boolean;
  routerBlind?: boolean;
  app?: { p90Ms: number; errPct: number };
  incident?: string;
}

const TX: Record<string, [string, number, number][]> = {
  "Store checkout": [["Checkout", 0.6, 2.2], ["Price lookup", 0.4, 3.1], ["Card authorization", 1.1, 2.0], ["Stock query", 0.9, 0.7]],
  WMS: [["Receive goods", 1.0, 0.9], ["Pick list", 0.8, 1.6], ["Ship confirmation", 1.2, 0.8], ["Inventory count", 0.9, 0.5]],
  "SAP ERP": [["SAP GUI login", 0.6, 0.9], ["Stock overview · MMBE", 0.9, 2.2], ["Purchase order · ME21N", 1.2, 0.8], ["Billing · VF01", 1.0, 0.5]],
};

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function buildExampleNetwork(now = new Date(), size: "enterprise" | "xl" = "enterprise"): NetworkModel {
  const xl = size === "xl";
  const K = xl ? XL : 1;
  const DCS = xl ? [...BASE_DCS, ...XL_DCS] : BASE_DCS;
  // which data center a branch's WAN terminates on: the extra-large estate splits the Southeast between
  // São Paulo and Rio and sends the North and Northeast to Recife
  const hubOf = (region: string, k: number) => (!xl ? REGIONS.find((r) => r.name === region)!.hub
    : region === "Southeast" ? (k % 2 ? "RIO1" : "SPO1") : region === "Northeast" || region === "North" ? "REC1" : region === "Midwest" ? "CPS1" : "SPO1");
  const rnd = mulberry32(xl ? 20260919 : 20260914);
  const uni = (a: number, b: number) => a + rnd() * (b - a);
  const int = (a: number, b: number) => Math.floor(uni(a, b + 1));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const t0 = Math.floor(now.getTime() / 60000) * 60000;
  const ago = (min: number) => new Date(t0 - min * 60000).toISOString().slice(0, 19) + "Z";

  const devices: Device[] = [];
  const circuits: Circuit[] = [];
  const sites: Record<string, Site> = {};
  const traps: NetworkModel["traps"] = [];
  const dcEvents: Record<string, NetEvent[]> = {};

  const ev = (min: number, level: string, mnemonic: string, sev: number, text: string): NetEvent => ({ t: ago(min), kind: "syslog", level, mnemonic, sev, text });

  const iface = (name: string, speed: number, utilPct: number, uplink: boolean, oper = "up(1)"): Iface => {
    const bps = (speed * 1e6 * utilPct) / 100;
    const inn = Array.from({ length: 24 }, () => Math.round(bps * uni(0.55, 0.97)));
    const out = Array.from({ length: 24 }, () => Math.round(bps * uni(0.25, 0.6)));
    if (utilPct) inn[int(12, 23)] = Math.round(bps);
    const util = r1((Math.max(...inn, ...out) / (speed * 1e6)) * 100);
    return {
      name, speed, oper, admin: "up(1)", type: "ethernetCsmacd(6)", util, in: inn, out, errors: 0, discards: 0, crc: 0, uplink,
      flag: util >= T.util_crit ? "saturated" : util >= T.util_warn ? "high" : null,
    };
  };

  interface DevOpts { cpu?: number; vendor?: string; blind?: boolean; rtt?: number | null; loss?: number; downMin?: number; incident?: string; events?: NetEvent[]; location?: string }
  const addDevice = (name: string, site: string, role: string, ip: string, hw: string, ifs: Iface[], o: DevOpts = {}) => {
    const cpu = o.cpu ?? r1(uni(4, 30));
    const d: Device = {
      id: `DEMO-${name}`, name, site, role, vendor: o.vendor ?? "cisco", ip, mode: o.blind ? "Discovery" : "Extension",
      desc: `${hw} · simulated device`, location: o.location ?? null, ifCount: ifs.length, cpu: [], cpuNow: null, availPct: null, availTs: null,
      syslog: { ERROR: int(0, 4), WARN: int(1, 12), INFO: int(30, 140) }, syslogErrTs: Array.from({ length: 24 }, () => (rnd() < 0.15 ? 1 : 0)),
      traps: 0, events: o.events ?? [], interfaces: o.blind ? [] : ifs, reasons: [], verdict: "Healthy", impact: 0, icmp: null,
    };
    const down = o.downMin;
    if (!o.blind) {
      const series = Array.from({ length: 24 }, () => r1(Math.max(0, cpu + uni(-2.5, 2.5))));
      series[23] = cpu;
      const hours = down ? Math.max(1, Math.ceil(down / 60)) : 0;
      const avail: number[] = Array(24).fill(1);
      if (hours) avail.fill(0, 24 - hours);
      d.cpu = hours ? series.slice(0, 24 - hours) : series;
      d.cpuNow = hours ? null : cpu;
      d.availTs = avail;
      d.availPct = Math.round((10000 * avail.reduce((a, b) => a + b, 0)) / 24) / 100;
    }
    const rtt = o.rtt ?? 1;
    d.icmp = {
      rttMs: down ? null : o.rtt ?? null,
      rtt: Array.from({ length: 24 }, () => r1(Math.max(0.2, rtt * uni(0.9, 1.12)))),
      loss: down ? Math.round((10000 * Math.min(down, 1440)) / 1440) / 100 : o.loss ?? 0,
      sent: 1440,
    };
    if (down) {
      d.unreachableSince = ago(down);
      d.syslogErrTs.fill(0, 24 - Math.ceil(down / 60));
    }
    if (o.incident) d.incident = o.incident;
    devices.push(d);
    return d;
  };

  DCS.forEach((dc) => {
    sites[dc.code] = { code: dc.code, name: dc.name, city: dc.name.replace("Data Center ", ""), uf: dc.uf, id: String(1001 + DCS.indexOf(dc)), dc: true, lat: dc.lat, lon: dc.lon, region: dc.uf === "PE" ? "Northeast" : "Southeast",
      tags: { "primary_tags.country": "br", "primary_tags.region": dc.uf === "PE" ? "northeast" : "southeast", "primary_tags.federativeunit": dc.uf.toLowerCase(), "primary_tags.city": dc.name.replace("Data Center ", ""), "primary_tags.site_type": "data center", "primary_tags.site": dc.code.toLowerCase() } };
    dcEvents[dc.code] = [ev(int(20, 90), "INFO", "%SYS-5-CONFIG_I", 5, "Configured from console by netops on vty0")];
  });
  const firewallCpuEvent = ev(38, "WARN", "%PAN-4-DP_CPU", 4, "Dataplane CPU above 75% for 30 minutes on FWL1 (SSL decryption)");

  // ---------- site plan ----------
  const specs = REGIONS.flatMap((reg) => Array.from({ length: Math.round(reg.sites * K) }, (_, k) => {
    const [city, uf, lat, lon] = reg.cities[k % reg.cities.length];
    const roll = rnd();
    const size: Size = roll < 0.08 ? "L" : roll < 0.38 ? "M" : "S";
    const carrier = reg.name === "South" ? "Carrier B" : reg.name === "Midwest" ? (rnd() < 0.65 ? "Carrier B" : "Carrier A") : "Carrier A";
    const satellite = reg.name === "North" && size === "S" && rnd() < 0.4;
    return { reg, city, uf, lat: lat + uni(-0.12, 0.12) * Math.sqrt(K), lon: lon + uni(-0.12, 0.12) * Math.sqrt(K), size, carrier, satellite, hub: hubOf(reg.name, k) };
  }));
  type Spec = (typeof specs)[number];

  const scen = new Map<number, Scenario>();
  // a regional outage grows with the estate; single-site faults grow slower, so the causes stay readable
  const pick = (n: number, when: (s: Spec, i: number) => boolean, make: (s: Spec) => Scenario, regional = false) => {
    let left = Math.round(n * (regional ? K : Math.sqrt(K)));
    specs.forEach((s, i) => { if (left > 0 && !scen.has(i) && !s.satellite && when(s, i)) { scen.set(i, make(s)); left--; } });
  };
  // A regional Carrier B outage: sites with a backup run degraded, sites without one go dark.
  pick(14, (s, i) => s.reg.name === "South" && i % 2 === 0, (s) => (s.size === "S" ? { circuitsDown: 47, incident: "INC-DEMO-3101" } : { primaryDown: 47, incident: "INC-DEMO-3101" }), true);
  pick(3, (s, i) => s.reg.name === "Midwest" && s.carrier === "Carrier B" && i % 5 === 1, () => ({ degraded: { latencyMs: 104, lossPct: 4.2, jitterMs: 31 }, app: { p90Ms: 2600, errPct: 1.1 } }));
  pick(1, (s, i) => s.reg.name === "Southeast" && s.size === "M" && i % 7 === 3, () => ({ routerDown: 132, incident: "INC-DEMO-3093" }));
  pick(1, (s, i) => s.reg.name === "Southeast" && i % 11 === 5, () => ({ switchDown: 18, incident: "INC-DEMO-3111" }));
  pick(2, (s, i) => s.reg.name === "Southeast" && i % 13 === 2, () => ({ apDown: 65, incident: "INC-DEMO-3102" }));
  pick(1, (s, i) => s.reg.name === "Southeast" && i % 17 === 9, () => ({ cpu: 88 }));
  pick(1, (s, i) => s.reg.name === "Southeast" && s.size === "L" && i % 3 === 0, () => ({ wanSaturated: 97.6, app: { p90Ms: 4600, errPct: 2.8 } }));
  pick(1, (s, i) => s.reg.name === "Southeast" && i % 19 === 4, () => ({ optic: true }));
  pick(2, (s, i) => s.reg.name === "Southeast" && i % 23 === 7, () => ({ routerBlind: true }));
  pick(1, (s, i) => s.reg.name === "Southeast" && s.size !== "S" && i % 29 === 11, () => ({ backupDown: 260, incident: "INC-DEMO-3076" }));
  pick(1, (s, i) => s.reg.name === "Northeast" && i % 9 === 4, () => ({ routerDown: 75, incident: "INC-DEMO-3120" }));
  pick(1, (s, i) => s.reg.name === "Northeast" && i % 7 === 2, () => ({ apDown: 31 }));
  pick(1, (s, i) => s.reg.name === "North" && i % 5 === 3, () => ({ routerBlind: true }));

  // ---------- branches ----------
  const used = new Set(DCS.map((d) => d.code));
  const codeFor = (city: string) => {
    const words = city.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, "").split(" ").filter((w) => w.length > 2);
    const base = words.length > 1 ? words[0][0] + words[words.length - 1].slice(0, 2) : words[0].slice(0, 3);
    let n = 1;
    while (used.has(`${base}${n}`)) n++;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };
  const perCityKind = new Map<string, number>();
  const branches: { code: string; name: string; hub: string; circ: Circuit[]; app: AppExperience }[] = [];

  specs.forEach((s, i) => {
    const sc = scen.get(i) ?? {};
    const code = codeFor(s.city);
    const kind = s.size === "L" ? "Distribution center" : s.size === "M" && rnd() < 0.3 ? "Office" : "Store";
    const appName = kind === "Distribution center" ? "WMS" : kind === "Office" ? "SAP ERP" : "Store checkout";
    const nth = (perCityKind.get(`${s.city}|${kind}`) ?? 0) + 1;
    perCityKind.set(`${s.city}|${kind}`, nth);
    const name = `${s.city} · ${kind} ${nth}`;
    const hub = DCS.find((d) => d.code === s.hub)!;
    sites[code] = { code, name, city: s.city, uf: s.uf, id: String(2000 + i), dc: false, lat: r2(s.lat), lon: r2(s.lon), region: s.reg.name, hub: hub.code,
      tags: { "primary_tags.country": "br", "primary_tags.region": s.reg.name.toLowerCase(), "primary_tags.federativeunit": s.uf.toLowerCase(), "primary_tags.city": s.city, "primary_tags.site_type": kind.toLowerCase(), "primary_tags.site": code.toLowerCase() } };

    // circuits
    const baseLat = r1(6 + km(s.lat, s.lon, hub.lat, hub.lon) * 0.011 + uni(0, 4));
    const wan = { L: 200, M: 50, S: 20 }[s.size];
    const rttSeries = (base: number, spread = 0.18) => Array.from({ length: 24 }, (_, h) => r1(Math.max(1, base * uni(1 - spread, 1 + spread) * (h > 18 ? 1.06 : 1))));
    const circuit = (kindC: "primary" | "backup", carrier: string, tech: string, slaMs: number, latencyMs: number, lossPct: number, jitterMs: number): Circuit => ({
      id: `${code}-${kindC}`, site: code, siteName: name, kind: kindC, carrier, tech, slaMs, latencyMs, lossPct, jitterMs, rttTs: rttSeries(latencyMs), status: "up", verdict: "Healthy", reasons: [],
    });
    const circ: Circuit[] = [
      s.satellite
        ? circuit("primary", "Carrier D", "Satellite VSAT 10 Mbps", 700, Math.round(uni(600, 650)), 0.8, 42)
        : circuit("primary", s.carrier, `MPLS ${wan} Mbps`, 80, baseLat, r2(uni(0, 0.3)), r1(uni(0.8, 4))),
    ];
    if (s.size !== "S") circ.push(circuit("backup", "Carrier C", "Internet 50 Mbps · SD-WAN", 150, r1(baseLat * 1.4 + 12), r2(uni(0, 0.6)), r1(uni(3, 9))));
    const markDown = (c: Circuit, min: number) => Object.assign(c, {
      status: "down" as const, latencyMs: null, lossPct: 100, jitterMs: null, since: ago(min),
      rttTs: (c.rttTs ?? []).map((v, h) => (h < 24 - Math.ceil(min / 60) ? v : null)),
    });
    if (sc.circuitsDown) { circ.forEach((c) => markDown(c, sc.circuitsDown!)); circ[0].incident = sc.incident; }
    if (sc.primaryDown) { markDown(circ[0], sc.primaryDown); circ[0].incident = sc.incident; }
    if (sc.backupDown && circ[1]) { markDown(circ[1], sc.backupDown); circ[1].incident = sc.incident; }
    if (sc.degraded) { Object.assign(circ[0], sc.degraded); circ[0].rttTs = rttSeries(sc.degraded.latencyMs, 0.12); }
    if (sc.routerDown) circ.forEach((c) => Object.assign(c, { latencyMs: null, lossPct: null, jitterMs: null, rttTs: [], note: "not measured: the branch router is not responding" }));
    circuits.push(...circ);

    const P = `BR-${s.uf}-${code}`;
    const net = `10.${20 + (i >> 8)}.${i & 255}`;
    const allDown = !!sc.circuitsDown;
    const offline = sc.circuitsDown ?? sc.routerDown;
    const root = allDown ? "WAN links" : sc.routerDown ? `${P}-RTR1` : undefined;
    const active = circ.find((c) => c.status === "up" && c.latencyMs != null);
    const latMs = active?.latencyMs ?? null;
    const loss = circ[0].lossPct != null && circ[0].lossPct !== 100 ? circ[0].lossPct : 0;
    const location = `${s.city} · ${s.uf}`;

    // router: a carrier drop shows as lowerLayerDown, which is the carrier's fault, not the router's
    const primaryLost = !!(sc.primaryDown || sc.circuitsDown);
    const rtrIfs = [iface("Gi0/0/0", s.satellite ? 10 : wan, primaryLost ? 0 : sc.wanSaturated ?? r1(uni(25, 60)), true, primaryLost ? "lowerLayerDown(7)" : "up(1)")];
    if (circ[1]) rtrIfs.push(iface("Gi0/0/1", 50, sc.primaryDown ? 58 : sc.backupDown || allDown ? 0 : r1(uni(1, 4)), true, sc.backupDown || allDown ? "lowerLayerDown(7)" : "up(1)"));
    rtrIfs.push(iface("Gi0/1/0", 1000, r1(uni(2, 8)), false));
    const rtrEv = [ev(int(30, 170), "INFO", "%SYS-5-CONFIG_I", 5, "Configured from console by netops on vty0")];
    if (sc.routerDown) rtrEv.unshift(ev(sc.routerDown + 1, "ERROR", "%PLATFORM-2-PS_FAIL", 2, "Power supply 0 failed: input voltage lost"));
    if (sc.primaryDown) rtrEv.unshift(ev(sc.primaryDown, "WARN", "%TRACK-6-STATE", 6, "10 ip sla 10 reachability Up -> Down; traffic moved to Gi0/0/1 (SD-WAN)"));
    if (sc.wanSaturated) rtrEv.unshift(ev(12, "WARN", "%QOS-4-POLICER_DROP", 4, "Gi0/0/0 output policer dropping packets in class BULK"));
    addDevice(`${P}-RTR1`, code, "edge", `${net}.1`, "Cisco ISR 4331", rtrIfs, {
      cpu: sc.cpu ?? r1(uni(8, 35)), blind: sc.routerBlind, rtt: latMs, loss, downMin: offline,
      incident: sc.routerDown ? sc.incident : undefined, events: rtrEv, location,
    });
    if (offline) {
      dcEvents[hub.code].unshift(ev(offline, "WARN", "%BGP-5-ADJCHANGE", 5, `neighbor ${net}.1 Down BGP Notification sent (hold time expired) · ${code}`));
      traps.push({ t: ago(offline), ip: `10.${DCS.indexOf(hub)}.0.11`, device: `BR-${hub.uf}-${hub.code}-CON1`, oid: "IF-MIB::linkDown" });
    }

    // switches
    for (let n = 1; n <= (s.size === "L" ? 2 : 1); n++) {
      const swDown = n === 1 ? sc.switchDown : undefined;
      const swIfs = [iface("Te1/1/1", 10000, r1(uni(1, 5)), true), ...[1, 2, 3, 4].map((p) => iface(`Gi1/0/${p}`, 1000, r1(uni(0, 12)), false, rnd() < 0.2 ? "down(2)" : "up(1)"))];
      const swEv = n === 1 && sc.optic ? [ev(21, "ERROR", "%SFF8472-3-THRESHOLD_VIOLATION", 3, "Te1/1/1: Rx power low warning; operating value -17.8 dBm, threshold -16.0 dBm")] : [];
      addDevice(`${P}-SWT${n}`, code, "switch", `${net}.${1 + n}`, "Cisco Catalyst 9200L", swIfs, {
        cpu: r1(uni(4, 18)), rtt: latMs, loss, downMin: offline ?? swDown, incident: swDown ? sc.incident : undefined, events: swEv, location,
      });
    }
    // access points hang off the first switch
    for (let n = 1; n <= { L: 6, M: 3, S: 2 }[s.size]; n++) {
      const apDown = n === 2 ? sc.apDown : undefined;
      addDevice(`${P}-APW${n}`, code, "ap", `${net}.${10 + n}`, "Cisco Catalyst 9120AX", [iface("Gi0", 1000, r1(uni(1, 9)), false)], {
        cpu: r1(uni(3, 12)), rtt: latMs, loss, downMin: offline ?? sc.switchDown ?? apDown,
        incident: apDown ? sc.incident : undefined, location,
      });
    }
    if (s.size === "L") {
      addDevice(`${P}-FWL1`, code, "firewall", `${net}.4`, "Fortinet FortiGate 100F", [iface("port1", 1000, r1(uni(10, 30)), true)], {
        vendor: "fortinet", cpu: r1(uni(10, 30)), rtt: latMs, loss, downMin: offline, location,
      });
    }

    // the application as experienced from the site
    const sessions = { L: int(180, 260), M: int(70, 140), S: int(20, 50) }[s.size];
    let p90 = s.satellite ? 1850 : int(850, 1450);
    let err = r2(uni(0.1, 0.7));
    if (sc.app) { p90 = sc.app.p90Ms; err = sc.app.errPct; }
    const dark = allDown || !!sc.routerDown || !!sc.switchDown;
    const transactions: AppTransaction[] = TX[appName].map(([tname, mult, share]) => {
      const hist = Array.from({ length: 24 }, () => Math.round(p90 * mult * uni(0.85, 1.08)));
      if (sc.app) hist.fill(Math.round(p90 * mult), 21);
      return { name: tname, p90Ms: dark ? null : Math.round(p90 * mult), errPct: dark ? null : r2(err * uni(0.6, 1.4)), count: dark ? 0 : Math.round(sessions * share), p90Ts: dark ? hist.slice(0, 23) : hist };
    });
    branches.push({
      code, name, hub: hub.code, circ,
      app: { name: appName, baselineSessions: sessions, sessions: dark ? 0 : sessions, p90Ms: dark ? null : p90, errPct: dark ? null : err, consequenceOf: null, transactions },
    });
  });

  // ---------- data centers ----------
  DCS.forEach((dc, k) => {
    dc.specs.forEach(([key, role, hw, cpu], j) => {
      const ifs = [iface("Hu1/0/1", 100000, r1(uni(5, 30)), true), iface("Hu1/0/2", 100000, r1(uni(5, 30)), true)];
      addDevice(`BR-${dc.uf}-${dc.code}-${key}`, dc.code, role, `10.${k}.0.${11 + j}`, hw, ifs, {
        cpu, rtt: 0.4, vendor: role === "firewall" ? "paloalto" : role === "lb" ? "f5" : "cisco",
        events: key === "CON1" ? dcEvents[dc.code] : key === "FWL1" && dc.code === "CPS1" ? [firewallCpuEvent] : undefined, location: `${dc.name.replace("Data Center ", "")} · ${dc.uf}`,
      });
    });
  });

  // ---------- the alerts Dynatrace would be raising on this network ----------
  // The app never judges health by itself, so the example has to carry the same thing a real environment
  // carries: open problems from the network alert templates and from custom alerts on the extensions.
  // Davis raises one problem for a whole incident, not one per element, so the example groups the same
  // way: everything sharing an incident code (or the same failure at the same site) is one problem.
  let pid = 0;
  const problems = new Map<string, DeviceProblem>();
  const problem = (key: string, name: string, category: string, start: string): DeviceProblem => {
    const found = problems.get(key);
    if (found) { if (start < found.start) found.start = start; return found; }
    pid += 1;
    const made: DeviceProblem = { eventId: `demo-${pid}`, eventKind: "DAVIS_PROBLEM", displayId: `P-2609${String(1000 + pid)}`, name, start, category, muted: false };
    problems.set(key, made);
    return made;
  };
  const attach = (target: { problems?: DeviceProblem[] }, p: DeviceProblem, on?: string) => {
    (target.problems ??= []).push(on ? { ...p, on } : p);
  };
  circuits.forEach((c) => {
    if (c.status === "down") {
      attach(c, problem(c.incident ?? `outage:${c.site}`, `Network availability monitor global outage · ${c.carrier}`, "AVAILABILITY", c.since ?? ago(60)));
    } else if (c.latencyMs != null && c.latencyMs > c.slaMs) {
      attach(c, problem(c.incident ?? `slow:${c.carrier}:${c.site}`, "Network availability monitor performance threshold violation", "SLOWDOWN", ago(45)));
    }
  });
  const incidentBy = new Map<string, string>();
  circuits.forEach((c) => { if (c.incident && !incidentBy.has(c.site)) incidentBy.set(c.site, c.incident); });
  const incidentOf = (site: string) => incidentBy.get(site);
  devices.forEach((d) => {
    if (d.unreachableSince) attach(d, problem(incidentOf(d.site) ?? `unreachable:${d.site}`, "Network devices unreachable", "AVAILABILITY", d.unreachableSince));
    if (d.cpuNow != null && d.cpuNow >= T.cpu_crit) attach(d, problem(`cpu:${d.name}`, `${d.vendor === "cisco" ? "Cisco" : "Device"} CPU utilization high`, "CUSTOM_ALERT", ago(35)));
    d.interfaces.filter((i) => i.flag === "saturated").forEach((i) => attach(d, problem(`sat:${d.name}`, "Interface saturation", "RESOURCE_CONTENTION", ago(50)), i.name));
    d.interfaces.filter((i) => i.uplink && (i.errors || i.crc)).forEach((i) => attach(d, problem(`err:${d.name}`, "Interface packet errors high rate", "ERROR", ago(40)), i.name));
    d.interfaces.filter((i) => i.uplink && i.oper.startsWith("down") && i.admin.startsWith("up")).forEach((i) => attach(d, problem(`ifdown:${d.name}`, "Interface operationally going down", "AVAILABILITY", ago(25)), i.name));
  });

  // ---------- an estate this size is read from per-device summaries, as live (DETAIL_MAX_DEVICES) ----------
  if (devices.length > DETAIL_MAX_DEVICES) {
    devices.forEach((d) => {
      if (!d.interfaces.length) return;
      const utils = d.interfaces.filter((i) => i.flag !== "inconsistent").map((i) => i.util).filter((u): u is number => u != null);
      d.ifStats = { maxUtil: utils.length ? Math.max(...utils) : null, interfaces: d.interfaces.length, errors: d.interfaces.reduce((a, i) => a + i.errors + i.crc, 0), discards: d.interfaces.reduce((a, i) => a + i.discards, 0) };
      d.interfaces = [];
    });
  }

  // ---------- verdicts ----------
  const trapsBy = new Map<string, number>();
  traps.forEach((t) => { if (t.device) trapsBy.set(t.device, (trapsBy.get(t.device) ?? 0) + 1); });
  devices.forEach((d) => {
    d.events.sort((a, b) => b.t.localeCompare(a.t));
    d.traps = trapsBy.get(d.name) ?? 0;
    [d.verdict, d.reasons, d.impact] = deviceVerdict(d);
  });

  // ---------- end-to-end paths ----------
  const bySite = new Map<string, Device[]>();
  devices.forEach((d) => { const list = bySite.get(d.site); if (list) list.push(d); else bySite.set(d.site, [d]); });
  const dcHops = new Map(DCS.map((dc) => {
    const ds = bySite.get(dc.code) ?? [];
    return [dc.code, { name: dc.name, core: deviceHop(ds, "Data center", "Concentrator and core", dc.code, ["core"]), sec: deviceHop(ds, "Security", "Firewall and load balancer", dc.code, ["firewall", "lb"]) }];
  }));
  const paths: E2EPath[] = branches.map((b) => {
    const ds = bySite.get(b.code) ?? [];
    const ch = circuitHop(b.circ);
    const ah = appHop(b.app.name, b.hub, b.app);
    const dh = dcHops.get(b.hub)!;
    const hops = [
      deviceHop(ds, "Access", "Switching and Wi-Fi", b.code, ["switch", "ap"]),
      deviceHop(ds, "Edge", ds.some((d) => d.role === "firewall") ? "Router and firewall" : "Branch router", b.code, ["edge", "firewall"]),
      ch, dh.core, dh.sec, ah,
    ].filter((h): h is Hop => !!h);
    const tunnelUp = b.circ.some((c) => c.status === "up" && c.latencyMs != null);
    const links: PathLink[] = [
      { kind: "lan", verdict: "Not monitored", label: "LAN", facts: [] },
      { kind: "wan", verdict: ch.verdict, label: "Access", facts: [b.circ[0].tech.split(" ")[0]] },
      { kind: "wan", verdict: tunnelUp ? "Healthy" : "Critical", label: "Tunnel", facts: [`BGP ${tunnelUp ? "established" : "down"}`] },
      { kind: "lan", verdict: "Not monitored", label: "LAN", facts: [] },
      { kind: "flow", verdict: ah.verdict, label: "Sessions", facts: [`${b.app.sessions}/h`] },
    ].slice(0, hops.length - 1) as PathLink[];
    sites[b.code].wanVerdict = ch.verdict;
    return makePath(`site-${b.code}`, `${b.name} → ${b.app.name} at ${dh.name}`, hops, links, b.code);
  });

  const siteVerdicts: Record<string, Verdict> = {};
  paths.forEach((p) => { siteVerdicts[p.site!] = p.summary.verdict; });
  DCS.forEach((dc) => { siteVerdicts[dc.code] = worst((bySite.get(dc.code) ?? []).map((d) => d.verdict)); });
  paths.sort((a, b) => ORDER[a.summary.verdict] - ORDER[b.summary.verdict] || a.name.localeCompare(b.name));

  // ---------- users, and what is alerting outside the network ----------
  // The example carries them so the isolation reading has something to work on: the carrier outage takes
  // the sites off the air, and the sessions of the last hours fall with it. No traffic anomaly alert is
  // configured here, which is exactly the case where the app reports a suspicion instead of a problem.
  const dayShape = [22, 14, 9, 7, 8, 14, 34, 62, 88, 104, 112, 118, 121, 116, 110, 108, 104, 96, 84, 70, 58, 46, 36, 28];
  const hourNow = new Date(t0).getUTCHours();
  const typical = Array.from({ length: 24 }, (_, i) => Math.round(dayShape[(hourNow - 23 + i + 48) % 24] * 9 * K));
  const sessionSeries = typical.map((v, i) => {
    if (i >= 21) return Math.round(v * 0.18); // the last hours, with sites off the air
    return Math.round(v * (0.92 + ((i * 37) % 17) / 100));
  });
  const outageSites = Object.values(sites).filter((x) => x.wanVerdict === "Critical").slice(0, 6);
  const users: NetworkModel["users"] = {
    scope: outageSites.length ? "site" : "environment",
    series: sessionSeries,
    typical,
    nowIndex: 21,
    now: sessionSeries[21],
    typicalNow: typical[21],
    byType: { web: sessionSeries.reduce((a, b) => a + b, 0), mobile: Math.round(sessionSeries.reduce((a, b) => a + b, 0) * 0.12) },
    nets: outageSites.map((x, i) => ({ net: `10.${40 + i}.0.0`, sessions: 120 - i * 14, site: x.code })),
    mapped: outageSites.reduce((a, _, i) => a + 120 - i * 14, 0),
    total: sessionSeries.reduce((a, b) => a + b, 0),
    anomalyWatched: false,
    // the services keep answering the sites that still reach them, so requests fall less than sessions
    requests: {
      series: typical.map((v, i) => Math.round(v * 410 * (i >= 21 ? 0.42 : 0.95 + ((i * 13) % 9) / 100))),
      typical: typical.map((v) => v * 410),
      nowIndex: 22,
      now: Math.round(typical[22] * 410 * 0.42),
      typicalNow: typical[22] * 410,
    },
  };
  const outsideAlerts: NetworkModel["unmappedAlerts"] = [
    { eventId: "EX-APP-1", eventKind: "DAVIS_PROBLEM", displayId: "P-24011", name: "Failure rate increase", start: new Date(t0 - 40 * 60000).toISOString().slice(0, 16) + "Z", category: "ERROR", scope: "application", entities: ["web frontend"] },
    { eventId: "EX-SVC-1", eventKind: "DAVIS_PROBLEM", displayId: "P-24012", name: "Response time degradation", start: new Date(t0 - 25 * 60000).toISOString().slice(0, 16) + "Z", category: "SLOWDOWN", scope: "service", entities: ["checkout-api"] },
  ];

  // ---------- traffic of the last hour: the core at São Paulo exports what crosses it ----------
  const traffic = (() => {
    const core = devices.find((d) => d.site === "SPO1" && d.role === "core");
    if (!core) return undefined;
    const net24 = (ip: string) => `${ip.split(".").slice(0, 3).join(".")}.0`;
    // one branch in ten, so every region shows up
    const branches = devices.filter((d) => !sites[d.site]?.dc && d.role === "edge").filter((_, i) => i % 10 === 0).slice(0, 30);
    const rows: Record<string, Record<string, unknown>[]> = {
      flowNets: branches.flatMap((d, i) => [
        { exp: core.ip, s24: net24(d.ip), d24: "10.0.50.0", proto: "tcp", dport: "443", bytes: 9e8 + i * 3e7, flows: 4200 + i * 40 },
        { exp: core.ip, s24: net24(d.ip), d24: "10.0.60.0", proto: "tcp", dport: "1433", bytes: 2e8 + i * 1e7, flows: 900 + i * 10 },
        { exp: core.ip, s24: net24(d.ip), d24: "10.1.0.0", proto: "tcp", dport: "445", bytes: 6e7 + i * 2e6, flows: 300 + i * 4 },
      ]),
    };
    const addressing = buildAddressing(DCS.map((dc, k) => ({ site: dc.code, cidr: `10.${k}.0.0/16` })), devices.map((d) => ({ site: d.site, ips: [d.ip] })));
    return buildFlowMap((k) => (rows[k] ?? []) as Record<string, any>[], devices, addressing, sites);
  })();

  // ---------- what changed today: restarts and alerts that already closed, besides what is open ----------
  const healthy = devices.filter((d) => d.verdict === "Healthy" && !sites[d.site]?.dc);
  const restarts = [0.07, 0.31, 0.58, 0.83].map((f, k) => ({ d: healthy[Math.floor(f * healthy.length)], min: [95, 240, 610, 1180][k] })).filter((x) => x.d);
  restarts.forEach(({ d, min }) => { d.rebootedAt = new Date(t0 - min * 60000).toISOString(); });
  const flappy = healthy[Math.floor(0.44 * healthy.length)];
  const closedToday = flappy ? [{ id: "demo-closed-1", name: "Interface flapping", start: ago(310), end: ago(262), device: flappy.name }] : [];
  const firstOn = new Map<string, string>();
  devices.forEach((d) => (d.problems ?? []).forEach((p) => { if (!firstOn.has(p.eventId)) firstOn.set(p.eventId, d.name); }));
  const recent = [...[...problems.values()].map((p) => ({ id: p.eventId, name: p.name, start: p.start, end: null as string | null, device: firstOn.get(p.eventId) ?? null })), ...closedToday]
    .sort((a, b) => (b.end ?? b.start).localeCompare(a.end ?? a.start));

  return {
    demo: true,
    flowMap: traffic,
    users,
    unmappedAlerts: outsideAlerts,
    alerting: { days: 7, problems: problems.size + closedToday.length, devices: devices.filter((d) => d.problems?.length).length, kinds: [...new Set([...problems.values()].map((p) => p.name))].sort(), recent },
    meta: { tenant: "example", generatedAt: new Date(t0).toISOString().slice(0, 16) + "Z", thresholds: T },
    sites, siteVerdicts,
    devices: devices.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact - a.impact || a.name.localeCompare(b.name)),
    circuits, links: [], peers: [], traps,
    flows: { exporters: [], top: [] }, oneagent: [],
    e2e: { probe: "Data centers (simulated)", paths },
  };
}
