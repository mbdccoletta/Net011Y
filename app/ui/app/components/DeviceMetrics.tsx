// Every metric this app holds for a device, in one table, each one drawn.
//
// The device panel showed two gauges and a line of chips: CPU and availability had a visual,
// and memory, round trip, loss, syslog, traps and interface utilisation were bare numbers —
// or missing. A reader comparing "is this normal?" had a picture for two of them and a figure
// for the rest, with no window on most.
//
// So the readings are one table, and the table carries the drawings. Each row is a metric:
// what it is, what it reads now, over what window, and its own series beside it. A metric the
// device does not publish keeps its row and says so, because "this switch reports no memory"
// is an answer and an absent row is not.
import React, { useEffect, useMemo, useState } from "react";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { Sparkline, TimeseriesChart } from "@dynatrace/strato-components/charts";
import { Text } from "@dynatrace/strato-components/typography";
import type { Device } from "../model/types";
import { portCounts } from "../model/ports";
import { subjectsOf } from "../model/ahead";
import { useTokens } from "../hooks/useToken";
import { fmtInt, fmtNum } from "../utils/format";

const HOUR = 3600_000;
const DAY = 86400_000;

interface Row {
  id: string;
  metric: string;
  /** what it reads now, already formatted, or null where the device publishes none */
  value: string | null;
  window: string;
  series: number[] | null;
  /** the step between two points of `series` */
  step: number;
  /** what the series is counted in, for the axis and the tooltip of the opened row */
  unit: "%" | "ms" | "count";
}

/** bare arrays become a series by counting back from now at the step the reading was taken */
const tsOf = (xs: number[], step: number) => ({
  name: "", datapoints: xs.map((v, i) => ({
    start: new Date(Date.now() - (xs.length - 1 - i) * step), value: v,
  })),
});

export function DeviceMetrics({ device: d }: { device: Device }) {
  /* canvas: a sparkline handed `var(--obs)` draws nothing at all */
  const [ink, inkRef] = useTokens({ "--obs": "#00afbe" });
  const ports = portCounts(d);

  const rows = useMemo<Row[]>(() => {
    const cpuBusy = subjectsOf(d).find((x) => x.kind === "device")?.room?.busy ?? null;
    const memBusy = subjectsOf(d).find((x) => x.kind === "memory")?.room?.busy ?? null;
    const days = (xs?: number[] | null) => `${Math.floor((xs?.length ?? 0) / 24)} d`;
    return [
      { id: "cpu", metric: "CPU in use", value: d.cpuNow != null ? `${fmtNum(d.cpuNow, 1)}%` : null,
        window: "most recent sample", series: d.cpu.length > 1 ? d.cpu : null, step: HOUR, unit: "%" },
      { id: "cpuBusy", metric: "CPU busy hour", value: cpuBusy != null ? `${fmtNum(cpuBusy, 1)}%` : null,
        window: `median of the daily peaks · ${days(d.cpuHourly)}`, series: d.cpuHourly ?? null, step: HOUR, unit: "%" },
      { id: "mem", metric: "Memory in use", value: d.memNow != null ? `${fmtNum(d.memNow, 0)}%` : null,
        window: "most recent sample", series: d.memHourly ?? null, step: HOUR, unit: "%" },
      { id: "memBusy", metric: "Memory busy hour", value: memBusy != null ? `${fmtNum(memBusy, 1)}%` : null,
        window: `median of the daily peaks · ${days(d.memHourly)}`, series: d.memHourly ?? null, step: HOUR, unit: "%" },
      { id: "avail", metric: "Availability", value: d.availPct != null ? `${fmtNum(d.availPct, 1)}%` : null,
        window: "last 24 h", series: d.availTs ?? null, step: HOUR, unit: "%" },
      { id: "rtt", metric: "ICMP round trip", value: d.icmp?.rttMs != null ? `${fmtNum(d.icmp.rttMs, 1)} ms` : null,
        window: "synthetic monitor", series: d.icmp?.rtt?.length ? d.icmp.rtt : null, step: HOUR, unit: "ms" },
      { id: "loss", metric: "Packet loss", value: d.icmp?.loss != null ? `${fmtNum(d.icmp.loss, 1)}%` : null,
        window: d.icmp?.sent ? `of ${fmtInt(d.icmp.sent)} sent` : "synthetic monitor", series: null, step: HOUR, unit: "%" },
      { id: "ports", metric: "Interfaces up", value: ports.known ? `${ports.up}/${ports.total}` : null,
        window: `${ports.down} enabled and down · ${ports.unused} shut, empty or not a link`, series: null, step: HOUR, unit: "count" },
      { id: "util", metric: "Busiest interface", value: d.ifStats?.maxUtil != null ? `${fmtNum(d.ifStats.maxUtil, 1)}%` : null,
        window: "of its own line rate", series: null, step: HOUR, unit: "%" },
      { id: "syslog", metric: "Syslog errors", value: `${fmtInt(d.syslog.ERROR)}`,
        window: `of ${fmtInt(d.syslog.ERROR + d.syslog.WARN + d.syslog.INFO + d.syslog.NONE)} lines · 6 h`,
        series: d.syslogErrTs?.length ? d.syslogErrTs : null, step: HOUR, unit: "count" },
      { id: "traps", metric: "SNMP traps", value: `${fmtInt(d.traps)}`, window: "last 6 h",
        series: d.trapTs?.length ? d.trapTs : null, step: HOUR, unit: "count" },
      { id: "vlans", metric: "VLANs", value: d.vlans?.length ? `${d.vlans.length}` : null,
        window: "carried on this device", series: null, step: DAY, unit: "count" },
    ];
  }, [d, ports.known, ports.up, ports.total, ports.down, ports.unused]);

  /* the row the reader opened: the same series the sparkline previews, at a height that has
     an axis and a tooltip on it */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /* a different device is a different set of readings: an id left open would open a row of
     another device's table */
  useEffect(() => setOpen({}), [d.name]);

  const columns = useMemo<DataTableColumnDef<Row>[]>(() => [
    { id: "metric", header: "Metric", accessor: "metric", width: 150 },
    {
      id: "value", header: "Now", accessor: (r: Row) => r.value ?? "", width: 92, alignment: "right",
      cell: ({ rowData }) => (rowData.value == null
        /* the device publishes none of this: an answer, and a different one from zero */
        ? <Text textStyle="small" className="rl-none">not reported</Text>
        : <span className="np-mono">{rowData.value}</span>),
    },
    /* the window of a reading can be longer than its column — "0 enabled and down · 0 shut
       or empty" — and an ellipsis with nothing behind it loses the half that qualifies the
       figure beside it */
    { id: "window", header: "Over", accessor: "window", width: 190,
      cell: ({ rowData }) => <Text textStyle="small"><span title={rowData.window}>{rowData.window}</span></Text> },
    {
      id: "series", header: "", accessor: () => "", width: 120, disableSorting: true,
      /* a metric with no series keeps its row and shows an empty cell: the row is the
         statement, the drawing is only the part of it that has a shape */
      cell: ({ rowData }) => (rowData.series && rowData.series.length > 1
        ? <div className="dm-spark"><Sparkline data={tsOf(rowData.series, rowData.step)} color={ink["--obs"]} variant="line" /></div>
        : <span />),
    },
  ], [ink]);

  return (
    <div ref={inkRef}>
      {/**
        * The drawing in the row is a preview; the row opens on the reading itself.
        *
        * Twelve sparklines ninety pixels wide, with no axis, no scale and nothing to hover,
        * answered "is it flat or not" and nothing else — a reader asking "how high did it
        * get, and when" had to leave for Dynatrace. Opening a row draws the same series at a
        * height that carries a y axis and a tooltip, which is the platform's own chart and
        * costs this panel nothing until the reader asks for it.
        */}
      <DataTable data={rows} columns={columns} fullWidth sortable>
        <DataTable.ExpandableRow expandedRows={open} onExpandedRowsChange={setOpen}>
          {({ row }: { row: Row }) => {
            const r = row;
            if (!r.series || r.series.length < 3) {
              return <div className="dm-open dm-open--none">This reading has no series: the device
                reports it as a value, not as a record.</div>;
            }
            const fmt = r.unit === "%" ? (v: number) => `${fmtNum(v, 1)}%`
              : r.unit === "ms" ? (v: number) => `${fmtNum(v, 1)} ms`
              : (v: number) => fmtInt(v);
            return (
              <div className="dm-open">
                <TimeseriesChart data={[]} height={200} curve="linear" pointsDisplay="never" gapPolicy="connect">
                  <TimeseriesChart.YAxis min={r.unit === "%" ? 0 : undefined} formatter={fmt} />
                  <TimeseriesChart.Tooltip variant="shared" />
                  <TimeseriesChart.Zoom />
                  <TimeseriesChart.Line
                    data={{ ...tsOf(r.series, r.step), name: `${r.metric} · ${r.window}`, unit: r.unit === "count" ? undefined : r.unit }}
                    color={ink["--obs"]} />
                </TimeseriesChart>
              </div>
            );
          }}
        </DataTable.ExpandableRow>
      </DataTable>
    </div>
  );
}
