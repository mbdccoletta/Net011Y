// The ports of one device, fetched only when somebody opens it.
// In a large estate the app does not pull every interface of every device on load (that is hundreds of
// thousands of rows); it reads the per-device summary and calls this hook for the device on screen.
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { Device, Iface } from "../model/types";
import { T } from "../model/verdict";

const C = "`com.dynatrace.extension.snmp-generic-cisco-device";
const G = "`com.dynatrace.extension.snmp-generic-device";
const J = "com.dynatrace.extension.juniper.generic";

/** Traffic of every port of one device. Smartscape ids must be wrapped before being compared. */
const seriesQuery = (device: Device) => {
  const id = `toSmartscapeId("${device.id}")`;
  if (device.vendor === "juniper") {
    return `timeseries i=sum(${J}.if.in.octets.count), o=sum(${J}.if.out.octets.count), by:{dt.smartscape.ext_network_interface, if.name, if.speed}, filter:{dt.smartscape.ext_network_device == ${id}}, from:now()-2h, interval:5m`;
  }
  const m = device.vendor === "cisco" ? C : G;
  return `timeseries i=sum(${m}.if.hc.in.octets.count\`), o=sum(${m}.if.hc.out.octets.count\`), s=avg(${m}.if.highspeed\`), by:{dt.smartscape.ext_network_interface, if.name}, filter:{dt.smartscape.ext_network_device == ${id}}, from:now()-2h, interval:5m`;
};

/** The ports themselves: the interface nodes carry the chassis MAC of the device that owns them. */
const nodesQuery = (mac: string) => `smartscapeNodes EXT_NETWORK_INTERFACE | filter device.chassis_mac == "${mac}"`;

const clean = (a: unknown): number[] => (Array.isArray(a) ? a.filter((v) => v != null).map(Number) : []);
const isUplink = (name: string, speed: number | null) => (speed ?? 0) >= 10000 || /^(te|xe-|et-|po|lc-|hundred|fortygig|tengig)/i.test(name || "");

export interface DeviceInterfaces {
  interfaces: Iface[];
  loading: boolean;
  /** true when the device already carries its ports from the initial load */
  fromModel: boolean;
}

export function useDeviceInterfaces(device: Device | null, enabled: boolean): DeviceInterfaces {
  const fromModel = !!device?.interfaces.length;
  const run = !!device && enabled && !fromModel;
  const nodes = useDql(
    { query: device?.chassisMac ? nodesQuery(device.chassisMac) : "smartscapeNodes EXT_NETWORK_INTERFACE | limit 1", maxResultRecords: 2000 },
    { enabled: run && !!device?.chassisMac, staleTime: 5 * 60 * 1000, runInBackground: true },
  );
  const series = useDql(
    { query: device ? seriesQuery(device) : "", maxResultRecords: 2000, defaultScanLimitGbytes: 100 },
    { enabled: run, staleTime: 5 * 60 * 1000, runInBackground: true },
  );

  if (fromModel) return { interfaces: device.interfaces, loading: false, fromModel: true };
  if (!run) return { interfaces: [], loading: false, fromModel: false };

  const nodeById = new Map(((nodes.data?.records ?? []).filter(Boolean) as Record<string, unknown>[]).map((n) => [String(n.id), n]));
  const rows = (series.data?.records ?? []).filter(Boolean) as Record<string, unknown>[];
  const interfaces: Iface[] = rows.map((row): Iface => {
    const id = String(row["dt.smartscape.ext_network_interface"] ?? "");
    const node = nodeById.get(id) ?? {};
    const name = String(row["if.name"] ?? node.name ?? "");
    const avg = clean(row.s);
    const speed = row["if.speed"] != null ? Number(row["if.speed"])
      : avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length)
      : node.speed != null ? Number(node.speed) : null;
    const bin = clean(row.i).map((v) => Math.round((v * 8) / 300));
    const bout = clean(row.o).map((v) => Math.round((v * 8) / 300));
    const util = speed && (bin.length || bout.length) ? Math.round((Math.max(...bin, ...bout) / (speed * 1e6)) * 1000) / 10 : null;
    return {
      id: id || undefined, name, speed,
      oper: String(node.operational_status ?? "unknown"), admin: String(node.admin_status ?? "unknown"),
      type: node.interface_type ? String(node.interface_type) : undefined,
      util, in: bin, out: bout, errors: 0, discards: 0, crc: 0, uplink: isUplink(name, speed),
      flag: (util == null ? null : util > 100 ? "inconsistent" : null) as Iface["flag"],
    };
  }).sort((a, b) => (b.util ?? -1) - (a.util ?? -1));

  return { interfaces, loading: series.isLoading || nodes.isLoading, fromModel: false };
}
