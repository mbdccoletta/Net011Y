// The metric formats of the Dynatrace network extensions, in one place.
//
// Every SNMP extension of the current generation reports a common set under
// com.dynatrace.extension.network_device (interfaces, CPU, memory, sysUpTime), tied to the Smartscape
// network nodes (dt.smartscape.ext_network_device / ext_network_interface). Vendor extensions add their
// own keys on top — CRC errors, sessions, VLANs — and older ones (Palo Alto) report only their own, joined
// by device.address. The app reads every family below that the environment sends and lets the first
// family that reports a measure for a device or port win, so nothing is counted twice.
//
// Adding a family is adding an entry: the queries are generated from this list.

export interface Family {
  id: string;
  label: string;
  /** metric key prefix, as the extension publishes it */
  prefix: string;
  ifIn?: string; ifOut?: string;
  /** interface speed in Mbps: a metric (ifHighSpeed) or a dimension (if.speed) */
  ifSpeedMetric?: string;
  ifErrIn?: string; ifErrOut?: string; ifDiscIn?: string; ifDiscOut?: string; ifCrc?: string;
  /** CPU in percent, or the idle percentage it is derived from */
  cpu?: string; cpuIdle?: string;
  /** memory in percent, or used with total / free */
  memPct?: string; memUsed?: string; memTotal?: string; memFree?: string;
  /** sysUpTime: a device that answers SNMP reports it every poll */
  uptime?: string;
  /** the dimensions this family names the device and the port with (fewer dimensions, smaller answers) */
  devDims: string; ifDims: string;
  docs: string;
}

export const FAMILIES: Family[] = [
  {
    id: "network_device", devDims: "dt.smartscape.ext_network_device, device.address", ifDims: "dt.smartscape.ext_network_interface, if.name, if.speed", label: "Network devices (common set of the SNMP extensions)", prefix: "com.dynatrace.extension.network_device",
    ifIn: "if.bytes_in.count", ifOut: "if.bytes_out.count", ifErrIn: "if.in.errors.count", ifErrOut: "if.out.errors.count",
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", cpu: "cpu_usage", memUsed: "memory_used", memTotal: "memory_total", uptime: "sysuptime",
    docs: "https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/extensions/snmp-generic",
  },
  {
    id: "cisco", devDims: "dt.smartscape.ext_network_device, device.address", ifDims: "dt.smartscape.ext_network_interface, if.name", label: "Generic Cisco Device", prefix: "com.dynatrace.extension.snmp-generic-cisco-device",
    ifIn: "if.hc.in.octets.count", ifOut: "if.hc.out.octets.count", ifSpeedMetric: "if.highspeed", ifErrIn: "if.in.errors.count", ifErrOut: "if.out.errors.count",
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", ifCrc: "if.in.crc_errors.count",
    cpu: "cpm.cpu.total.1min.rev", memUsed: "cpm.cpu.memory.hc.used", memFree: "cpm.cpu.memory.hc.free", uptime: "sys.uptime",
    docs: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/extensions/generic-cisco-router-snmp-extension",
  },
  {
    id: "generic", devDims: "dt.smartscape.ext_network_device, device.address", ifDims: "dt.smartscape.ext_network_interface, if.name", label: "Generic network device", prefix: "com.dynatrace.extension.snmp-generic-device",
    ifIn: "if.hc.in.octets.count", ifOut: "if.hc.out.octets.count", ifSpeedMetric: "if.highspeed", ifErrIn: "if.in.errors.count", ifErrOut: "if.out.errors.count",
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", uptime: "sys.uptime",
    docs: "https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/extensions/snmp-generic",
  },
  {
    id: "juniper", devDims: "dt.smartscape.ext_network_device, device.address", ifDims: "dt.smartscape.ext_network_interface, if.name, if.speed", label: "Juniper", prefix: "com.dynatrace.extension.juniper.generic",
    ifIn: "if.in.octets.count", ifOut: "if.out.octets.count", ifErrIn: "if.in.err.count", ifErrOut: "if.out.err.count",
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", cpu: "routingengine.cpu.utilization", memPct: "routingengine.memory.utilization",
    docs: "https://www.dynatrace.com/hub/?query=juniper",
  },
  {
    id: "paloalto", devDims: "device.address, sys.name", ifDims: "if.descr", label: "Palo Alto firewalls", prefix: "com.dynatrace.extension.palo-alto.generic",
    ifIn: "if.in.octets.count", ifOut: "if.out.octets.count", ifErrIn: "if.in.err.count", ifErrOut: "if.out.err.count",
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", cpu: "cpu.management.utilization", memUsed: "mem.used", memTotal: "mem.size", uptime: "sys.uptime",
    docs: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/extensions/palo-alto-firewalls-1",
  },
  {
    id: "f5", devDims: "dt.smartscape.ext_network_device, device.address", ifDims: "interface.name", label: "F5 BIG-IP", prefix: "com.dynatrace.extension.f5.bigip",
    ifIn: "sys.interface.stat.bytes.in.count", ifOut: "sys.interface.stat.bytes.out.count", ifErrIn: "sys.interface.stat.errors.in.count", ifErrOut: "sys.interface.stat.errors.out.count",
    ifDiscIn: "sys.interface.stat.drops.in.count", ifDiscOut: "sys.interface.stat.drops.out.count", cpuIdle: "sys.global.host.cpu.idle1m",
    memUsed: "sys.host.memory.used", memTotal: "sys.host.memory.total", uptime: "sys.uptime",
    docs: "https://www.dynatrace.com/hub/?query=f5",
  },
];

/** A metric key as DQL wants it: back-quoted when it holds a dash. */
export const mk = (f: Family, m: string) => { const k = `${f.prefix}.${m}`; return k.includes("-") ? `\`${k}\`` : k; };

const tag = (f: Family) => `fieldsAdd family = "${f.id}"`;
const dev = (f: Family) => f.devDims;
const port = (f: Family) => `${f.devDims}, ${f.ifDims}`;

/**
 * One query per family and measure, so they run side by side and a family that is absent answers at once.
 * Named "<measure>:<family>"; the model reads them in catalog order, the common set first.
 */
export type Measure = "ifTraffic" | "ifErrors" | "ifSummary" | "errSummary" | "cpu" | "memory" | "uptime" | "reboots";
const BUILD: Record<Measure, (f: Family) => string | null> = {
  // traffic per port, every 5 minutes over 2 h
  ifTraffic: (f) => f.ifIn && f.ifOut
    ? `timeseries {i = sum(${mk(f, f.ifIn)}), o = sum(${mk(f, f.ifOut)})${f.ifSpeedMetric ? `, s = avg(${mk(f, f.ifSpeedMetric)})` : ""}}, by:{${port(f)}}, from:now()-2h, interval:5m | ${tag(f)}` : null,
  // errors, discards and CRC per port over 2 h, summed: the ports only need the totals
  ifErrors: (f) => {
    if (!f.ifErrIn) return null;
    const parts = [["ie", f.ifErrIn], ["oe", f.ifErrOut], ["idc", f.ifDiscIn], ["odc", f.ifDiscOut], ["crc", f.ifCrc]].filter(([, m]) => m) as [string, string][];
    return `timeseries {${parts.map(([n, m]) => `${n} = sum(${mk(f, m)})`).join(", ")}}, by:{${port(f)}}, from:now()-2h, interval:5m`
      + ` | fieldsAdd ${parts.map(([n]) => `${n} = arraySum(${n})`).join(", ")} | fieldsRemove timeframe, interval | ${tag(f)}`;
  },
  // busiest port and port count per device: the only interface data read in a large estate
  ifSummary: (f) => f.ifIn && f.ifOut
    ? `timeseries {i = max(${mk(f, f.ifIn)}), o = max(${mk(f, f.ifOut)})${f.ifSpeedMetric ? `, s = avg(${mk(f, f.ifSpeedMetric)})` : ""}}, by:{${port(f)}}, from:now()-2h, interval:5m`
      + ` | fieldsAdd peak = arrayMax(arrayConcat(i, o)), speed = ${f.ifSpeedMetric ? "arrayAvg(s)" : f.ifDims.includes("if.speed") ? "toDouble(if.speed)" : "0.0"}`
      + ` | fieldsAdd util = if(speed > 0, peak * 8 / 300 / (speed * 1000000) * 100, else: 0.0)`
      + ` | summarize maxUtil = round(max(util), decimals: 2), interfaces = count(), by:{${dev(f)}} | ${tag(f)}` : null,
  // errors and discards summed per device over 2 h
  errSummary: (f) => {
    if (!f.ifErrIn) return null;
    const e = [f.ifErrIn, f.ifCrc].filter(Boolean) as string[], d = [f.ifDiscIn].filter(Boolean) as string[];
    return `timeseries {${e.map((m, i) => `e${i} = sum(${mk(f, m)})`).concat(d.map((m, i) => `d${i} = sum(${mk(f, m)})`)).join(", ")}}, by:{${dev(f)}}, from:now()-2h, interval:5m`
      + ` | fieldsAdd errors = ${e.map((_, i) => `arraySum(e${i})`).join(" + ")}, discards = ${d.length ? d.map((_, i) => `arraySum(d${i})`).join(" + ") : "0"}`
      + ` | fields ${dev(f)}, errors, discards | ${tag(f)}`;
  },
  // CPU in percent every 5 minutes over 2 h
  cpu: (f) => f.cpu ? `timeseries {cpu = avg(${mk(f, f.cpu)})}, by:{${dev(f)}}, from:now()-2h, interval:5m | ${tag(f)}`
    : f.cpuIdle ? `timeseries {idle = avg(${mk(f, f.cpuIdle)})}, by:{${dev(f)}}, from:now()-2h, interval:5m | fieldsAdd cpu = 100 - idle[] | fieldsRemove idle | ${tag(f)}` : null,
  // memory in percent every 5 minutes over 2 h
  memory: (f) => f.memPct ? `timeseries {mem = avg(${mk(f, f.memPct)})}, by:{${dev(f)}}, from:now()-2h, interval:5m | ${tag(f)}`
    : f.memUsed && (f.memTotal || f.memFree) ? `timeseries {u = avg(${mk(f, f.memUsed)}), t = avg(${mk(f, (f.memTotal ?? f.memFree)!)})}, by:{${dev(f)}}, from:now()-2h, interval:5m`
      + ` | fieldsAdd mem = 100 * u[] / ${f.memTotal ? "t[]" : "(u[] + t[])"} | fieldsRemove u, t | ${tag(f)}` : null,
  // sysUpTime samples per hour over 24 h: an hour with none is an hour the device did not answer
  uptime: (f) => f.uptime ? `timeseries {c = count(${mk(f, f.uptime)})}, by:{${dev(f)}}, from:now()-24h, interval:1h | ${tag(f)}` : null,
  // restarts over 24 h: sysUpTime only grows until the device restarts, so a step down is a restart; only
  // the devices that restarted come back
  reboots: (f) => f.uptime ? `timeseries {u = max(${mk(f, f.uptime)})}, by:{${dev(f)}}, from:now()-24h, interval:15m | fieldsAdd d = arrayDelta(u) | filter arrayMin(d) < 0 | fieldsRemove u | ${tag(f)}` : null,
};

/** Every family query for a measure, as [name, query] in catalog order. */
export const familyQueries = (m: Measure): [string, string][] =>
  FAMILIES.flatMap((f) => { const q = BUILD[m](f); return q ? [[`${m}:${f.id}`, q] as [string, string]] : []; });

/**
 * Which families this environment sends, in one cheap read of the metric series over the longest window
 * any family query uses (24 h, availability): the app then runs only those families' queries. An
 * environment with one vendor runs a sixth of them, and one with no network extension runs none.
 */
export const familiesQuery = () =>
  `fetch metric.series, from:now()-24h | filter ${FAMILIES.map((f) => `startsWith(metric.key, "${f.prefix}.")`).join(" or ")}`
  + ' | fieldsAdd family = splitString(metric.key, ".")[3] | summarize series = count(), by:{family}';
/** The family a row of familiesQuery names (the fourth segment of its metric keys). */
export const familyOfToken = (token: string) => FAMILIES.find((f) => f.prefix.split(".")[3] === token)?.id;

/**
 * VLANs as the extensions describe them: the Juniper VLAN table (name and tag). VLAN interfaces — an F5
 * VLAN, a switch SVI — come with the ports, recognised by type or name.
 */
export const vlanQuery = () =>
  'fetch metric.series, from:now()-2h | filter metric.key == "com.dynatrace.extension.juniper.generic.device.ex.vlan" | fields device.address, sys.name, dt.smartscape.ext_network_device, ex.vlan.name, ex.vlan.tag, ex.vlan.portgroup.instance | dedup {device.address, ex.vlan.tag}';
