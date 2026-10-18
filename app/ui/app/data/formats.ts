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

/**
 * How deep the hourly record goes.
 *
 * It was a fortnight, and the fortnight was never a limit of the data: measured on a live
 * tenant, the same metric answers 1441 hourly buckets over sixty days with the first one
 * filled, and a full year at daily resolution — Grail only coarsens the interval past about
 * sixty days, returning 2 h buckets for a ninety-day window. Two weeks is two weekly cycles,
 * which is the least a seasonal detector can work with and the reason the Ahead page can
 * only offer an order of arrival instead of a date: its horizon is twice its record. Sixty
 * days is eight cycles and a four-month horizon.
 *
 * The ceiling on this number is not licence cost — metric queries carry none — it is how
 * much series a browser can hold for an estate of ports.
 */
export const RECORD_DAYS = 60;

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
    ifDiscIn: "if.in.discards.count", ifDiscOut: "if.out.discards.count", cpu: "cpu_usage",
    /**
     * `memory_free`, not `memory_total`, and that is a measurement rather than a preference.
     *
     * This family declared `memTotal`, and the builder prefers a stated total over a free —
     * rightly, since `used / total` counts the buffers that `used + free` leaves out. But the
     * devices have to publish it. Counted on this environment: 150 report `memory_used`, 147
     * report `memory_free`, and **three** report `memory_total`, with no device reporting
     * both a free and a total. So the app was asking 150 devices for a denominator that three
     * of them have, and a hundred and forty-seven switches showed no memory at all while
     * Ahead counted 169 processors against 135 memories.
     *
     * Those three are covered by `network_device_total` below, because a family is how this
     * app asks a question and these devices answer a different one.
     */
    memUsed: "memory_used", memFree: "memory_free", uptime: "sysuptime",
    docs: "https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/extensions/snmp-generic",
  },
  {
    /**
     * The same extension, for the devices that state a total instead of a free.
     *
     * It carries nothing but the memory pair: `BUILD` returns null for every measure whose
     * fields are absent, so this entry generates exactly one query and adds nothing to the
     * interface, CPU or uptime reads. The model takes the first family that answers for a
     * device, so a device reporting a free is served above and never reaches this one.
     */
    id: "network_device_total", devDims: "dt.smartscape.ext_network_device, device.address",
    ifDims: "dt.smartscape.ext_network_interface, if.name, if.speed",
    label: "Network devices reporting a memory total", prefix: "com.dynatrace.extension.network_device",
    memUsed: "memory_used", memTotal: "memory_total",
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
 * The same port, without its speed in the grouping.
 *
 * `if.speed` is a dimension on two of the families, so a port whose speed is reported
 * inconsistently — a flap, a renegotiation, one poll that missed it — becomes two series, each
 * holding part of the record. Measured on a live environment, 198 rows over 6,812 interfaces came
 * back split that way, and because each half is tested for "enough record" on its own, a port with
 * a fortnight of history could be judged on half of it and dropped. The split is silent: the count
 * is simply lower than the number of ports, with nothing to say which were lost.
 *
 * The speed is read as a metric in the same query, so nothing is lost by dropping the dimension.
 */
const portSteady = (f: Family) => `${f.devDims}, ${f.ifDims}`.replace(/,\s*if\.speed\b/, "");

/**
 * The first dimension a query groups by — the only field a sort may safely name.
 *
 * The two hourly reads sorted by `dt.smartscape.ext_network_interface` and
 * `dt.smartscape.ext_network_device`, which the common SNMP families do carry and two families
 * do not: F5 groups its ports by `interface.name` and Palo Alto by `if.descr`, and Palo Alto's
 * devices by `device.address, sys.name` with no Smartscape id at all. Grail answers a sort on a
 * field that is not in the result with 400 FIELD_DOES_NOT_EXIST, so `ifHourly:f5` had been
 * failing on every load — invisibly, because the page it feeds treated an unasked-for read and
 * a failed one the same way. Sorting on a dimension the query itself groups by cannot miss.
 */
const firstDim = (dims: string) => dims.split(",")[0].trim();

/**
 * One query per family and measure, so they run side by side and a family that is absent answers at once.
 * Named "<measure>:<family>"; the model reads them in catalog order, the common set first.
 */
export type Measure = "ifTraffic" | "ifErrors" | "ifSummary" | "errSummary" | "cpu" | "memory" | "uptime" | "reboots"
  | "ifHourly" | "ifHourlyUp" | "cpuHourly" | "memHourly";
/** the model's uplink rule (`isUplink` in buildRealModel), written as a scan-time filter */
const UPLINK = 'toLong(`if.speed`) >= 10000 or startsWith(`if.name`, "Te") or startsWith(`if.name`, "Po")'
  + ' or startsWith(`if.name`, "xe-") or startsWith(`if.name`, "et-") or startsWith(`if.name`, "lc-")';

const BUILD: Record<Measure, (f: Family) => string | null> = {
  // traffic per port, every 5 minutes over 2 h
  ifTraffic: (f) => f.ifIn && f.ifOut
    ? `timeseries {i = sum(${mk(f, f.ifIn)}), o = sum(${mk(f, f.ifOut)})${f.ifSpeedMetric ? `, s = avg(${mk(f, f.ifSpeedMetric)})` : ""}}, by:{${port(f)}}, from:now()-2h, interval:5m | ${tag(f)}` : null,
  // One point per hour for a fortnight, per port, with the port's own speed alongside.
  //
  // It was a month of daily buckets, which gave eighteen points on a real estate and a chart with
  // nothing in it: a line between eighteen dots is a sketch, not telemetry. Hourly over fourteen
  // days gives three hundred, and measured on a live environment it is also *denser* — 90% of the
  // hours report against 41% of the days, because a day counted as missing was usually a day with
  // a few hours of silence in it. One million points came back in seven seconds.
  //
  // Capacity is sized against the peak hour, not the mean day, and only this resolution shows one.
  ifHourly: (f) => f.ifIn && f.ifOut
    ? `timeseries {i = sum(${mk(f, f.ifIn)}), o = sum(${mk(f, f.ifOut)})`
      + `${f.ifSpeedMetric ? `, s = avg(${mk(f, f.ifSpeedMetric)})` : ""}`
      /* Both directions. It counted inbound only, so a port discarding on the way out read as
         a clean port — and when the platform was asked about the same ports it found an
         increase on a series this app's record showed as flat zero. Everything downstream
         rests on this series: the discard state, the ceiling a port has demonstrated, and the
         rate the cause draws. */
      + `${f.ifDiscIn ? `, d = sum(${mk(f, f.ifDiscIn)})` : ""}`
      + `${f.ifDiscOut ? `, d2 = sum(${mk(f, f.ifDiscOut)})` : ""}`
      + `}, by:{${portSteady(f)}}, from:now()-${RECORD_DAYS}d, interval:1h`
      + `${f.ifDiscIn && f.ifDiscOut ? " | fieldsAdd d = d[] + d2[] | fieldsRemove d2" : ""}`
      // A fixed order and a ceiling equal to the reader's own cap (queries.ts), so a cut is the
      // same cut on every load and neither side trims below the other. Measured: 13,137 rows for
      // 6,812 ports on a 181-device estate, so the ceiling binds only well past that size.
      + ` | sort ${firstDim(portSteady(f))} asc | limit 60000 | ${tag(f)}` : null,
  /**
   * The same fortnight of hours, uplinks only — the heaviest read in the app cut to the part
   * the page draws first.
   *
   * Ahead ranks one uplink per device and forecasts those; every other port is wanted only
   * when a reader opens a device in the detail panel. Reading all of them up front made the
   * card wait for the lot: measured here, 14,496 rows in 30.2s against 3,298 rows in 9.3s
   * for the uplinks alone.
   *
   * The filter sits inside `timeseries`, not in a `| filter` after it. Both return the same
   * 3,298 rows; the piped version scans every port first and only then discards them, and
   * took 12.2s against this one's 9.3s.
   *
   * A port the rule misses is not lost. The unfiltered read follows in the last wave and
   * fills it in, because the model keeps whichever series for a port arrives first.
   */
  ifHourlyUp: (f) => {
    const q = BUILD.ifHourly(f);
    return q ? q.replace(`, from:now()-${RECORD_DAYS}d`, `, filter: {${UPLINK}}, from:now()-${RECORD_DAYS}d`) : null;
  },
  // the same fortnight of hours for the processor, whose limit needs no tag and no contract
  cpuHourly: (f) => f.cpu
    ? `timeseries {c = avg(${mk(f, f.cpu)})}, by:{${dev(f)}}, from:now()-${RECORD_DAYS}d, interval:1h`
      + ` | sort ${firstDim(dev(f))} asc | limit 50000 | ${tag(f)}` : null,
  /**
   * The same fortnight of hours for memory in use.
   *
   * The `memory` read above is a snapshot — two hours of five-minute buckets, of which the
   * model kept the last sample — so the app could say what memory is now and nothing about
   * where it is going. A processor and a port both get fourteen days of hours; memory is the
   * third thing a device can run out of and it was the only one with no record.
   *
   * Two shapes, as above: a family that publishes a percentage outright, and one that
   * publishes used and total (or used and free) for this to divide.
   */
  memHourly: (f) => {
    const expr = f.memPct
      ? `timeseries {m = avg(${mk(f, f.memPct)})}, by:{${dev(f)}}, from:now()-${RECORD_DAYS}d, interval:1h`
      : f.memUsed && (f.memTotal || f.memFree)
        ? `timeseries {u = avg(${mk(f, f.memUsed)}), t = avg(${mk(f, (f.memTotal ?? f.memFree)!)})}, by:{${dev(f)}}, from:now()-${RECORD_DAYS}d, interval:1h`
          + ` | fieldsAdd m = 100 * u[] / ${f.memTotal ? "t[]" : "(u[] + t[])"} | fieldsRemove u, t`
        : null;
    return expr ? `${expr} | sort ${firstDim(dev(f))} asc | limit 50000 | ${tag(f)}` : null;
  },
  // errors, discards and CRC per port over 2 h, summed: the ports only need the totals
  ifErrors: (f) => {
    if (!f.ifErrIn) return null;
    const parts = [["ie", f.ifErrIn], ["oe", f.ifErrOut], ["idc", f.ifDiscIn], ["odc", f.ifDiscOut], ["crc", f.ifCrc]].filter(([, m]) => m) as [string, string][];
    return `timeseries {${parts.map(([n, m]) => `${n} = sum(${mk(f, m)})`).join(", ")}}, by:{${port(f)}}, from:now()-2h, interval:5m`
      + ` | fieldsAdd ${parts.map(([n]) => `${n} = arraySum(${n})`).join(", ")} | fieldsRemove timeframe, interval | ${tag(f)}`;
  },
  // Busiest port and port count per device: the only interface data read in a large estate, so it has to
  // measure the same thing the per-port series measures. The counters are deltas per poll: the bucket's
  // bytes are their sum, and bits per second is that sum over the bucket. Taking the largest single delta
  // instead (what this query did until 0.1.17) divides one poll by the whole bucket and understates the
  // utilisation by as many polls as the bucket holds — five-fold at a one-minute poll.
  ifSummary: (f) => f.ifIn && f.ifOut
    ? `timeseries {i = sum(${mk(f, f.ifIn)}), o = sum(${mk(f, f.ifOut)})${f.ifSpeedMetric ? `, s = avg(${mk(f, f.ifSpeedMetric)})` : ""}}, by:{${port(f)}}, from:now()-2h, interval:5m`
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
