// DataTables for devices, WAN links and application transactions. Row click selects the row;
// the page opens the selection in PageLayout.Details and keeps the current context.
import React, { useMemo } from "react";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import type { AppTransaction, Circuit, Device, NetworkModel } from "../model/types";
import { ROLE_LABEL } from "../model/site";
import { fmtInt, fmtNum, hhmm, speedLabel } from "../utils/format";
import { Status } from "./Status";
import { ORDER } from "../model/verdict";

const Incident = ({ id }: { id?: string | null }) => (id ? <span className="np-chip-incident">{id}</span> : null);

export function DevicesTable({ model, devices, showSite, compact, onSelect }: { model: NetworkModel; devices: Device[]; showSite?: boolean; compact?: boolean; onSelect: (d: Device) => void }) {
  const data = useMemo(
    () => [...devices].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact - a.impact || a.name.localeCompare(b.name)),
    [devices],
  );
  const columns = useMemo<DataTableColumnDef<Device>[]>(() => compact ? [
    { id: "status", header: "Status", accessor: "verdict", width: 130, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    { id: "name", header: "Device", accessor: "name", width: "1fr", cell: ({ rowData }) => <span className="np-mono">{rowData.name}</span> },
    { id: "reason", header: "Main reason", accessor: (d: Device) => d.reasons[0]?.text ?? "Within expected range", width: "1.2fr",
      cell: ({ rowData }) => <span title={rowData.reasons[0]?.text ?? "Within expected range"}>{rowData.reasons[0]?.text ?? "Within expected range"}</span> },
  ] : [
    { id: "status", header: "Status", accessor: "verdict", width: 140, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    { id: "name", header: "Device", accessor: "name", width: "1fr", cell: ({ rowData }) => <span className="np-mono">{rowData.name}</span> },
    ...(showSite ? [{ id: "site", header: "Site", accessor: (d: Device) => model.sites[d.site]?.name ?? d.site, width: 160 } as DataTableColumnDef<Device>] : []),
    { id: "role", header: "Role", accessor: (d: Device) => ROLE_LABEL[d.role] ?? d.role, width: 150 },
    { id: "ip", header: "IP address", accessor: "ip", width: 130, cell: ({ rowData }) => <span className="np-mono">{rowData.ip}</span> },
    { id: "cpu", header: "CPU", accessor: (d: Device) => d.cpuNow ?? -1, width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.cpuNow != null ? `${Math.round(rowData.cpuNow)}%` : "—"}</span> },
    { id: "rtt", header: "ICMP RTT", accessor: (d: Device) => d.icmp?.rttMs ?? -1, width: 100, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.icmp?.rttMs != null ? `${fmtNum(rowData.icmp.rttMs)} ms` : "—"}</span> },
    { id: "loss", header: "Loss", accessor: (d: Device) => d.icmp?.loss ?? -1, width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.icmp?.loss != null ? `${fmtNum(rowData.icmp.loss)}%` : "—"}</span> },
    { id: "reason", header: "Main reason", accessor: (d: Device) => d.reasons[0]?.text ?? "Within expected range", width: "2fr",
      cell: ({ rowData }) => <span title={rowData.reasons[0]?.text ?? "Within expected range"}>{rowData.reasons[0]?.text ?? "Within expected range"} <Incident id={rowData.incident} /></span> },
  ], [model, showSite, compact]);
  return (
    <DataTable data={data} columns={columns} sortable fullWidth interactiveRows
      onActiveRowChange={(rowId) => { if (rowId != null && data[Number(rowId)]) onSelect(data[Number(rowId)]); }} />
  );
}

export function CircuitsTable({ circuits, showSite, onSite }: { circuits: Circuit[]; showSite?: boolean; onSite?: (code: string) => void }) {
  const data = useMemo(() => [...circuits].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.siteName.localeCompare(b.siteName)), [circuits]);
  const columns = useMemo<DataTableColumnDef<Circuit>[]>(() => [
    { id: "status", header: "Status", accessor: "verdict", width: 140, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    ...(showSite ? [{ id: "site", header: "Site", accessor: "siteName", width: 170 } as DataTableColumnDef<Circuit>] : []),
    { id: "kind", header: "Link", accessor: (c: Circuit) => (c.kind === "primary" ? "Primary" : "Backup"), width: 90 },
    { id: "carrier", header: "Carrier and technology", accessor: (c: Circuit) => `${c.carrier} · ${c.tech}`, width: "1.4fr" },
    { id: "latency", header: "Latency", accessor: (c: Circuit) => c.latencyMs ?? -1, width: 100, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.latencyMs != null ? `${fmtNum(rowData.latencyMs)} ms` : "—"}</span> },
    { id: "sla", header: "SLA", accessor: "slaMs", width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.slaMs} ms</span> },
    { id: "loss", header: "Loss", accessor: (c: Circuit) => c.lossPct ?? -1, width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.lossPct != null ? `${fmtNum(rowData.lossPct)}%` : "—"}</span> },
    { id: "jitter", header: "Jitter", accessor: (c: Circuit) => c.jitterMs ?? -1, width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.jitterMs != null ? `${fmtNum(rowData.jitterMs)} ms` : "—"}</span> },
    { id: "reason", header: "Reason", accessor: (c: Circuit) => c.reasons[0]?.text ?? "Within SLA", width: "1.6fr",
      cell: ({ rowData }) => <span>{rowData.reasons[0]?.text ?? "Within SLA"}{rowData.since && rowData.status === "down" ? ` (${hhmm(rowData.since)})` : ""} <Incident id={rowData.incident} /></span> },
  ], [showSite]);
  return (
    <DataTable data={data} columns={columns} sortable fullWidth interactiveRows={!!onSite}
      onActiveRowChange={(rowId) => { if (onSite && rowId != null && data[Number(rowId)]) onSite(data[Number(rowId)].site); }} />
  );
}

export function TransactionsTable({ transactions }: { transactions: AppTransaction[] }) {
  const columns = useMemo<DataTableColumnDef<AppTransaction>[]>(() => [
    { id: "name", header: "Transaction", accessor: "name", width: "1.4fr" },
    { id: "p90", header: "p90", accessor: (t: AppTransaction) => t.p90Ms ?? -1, width: 100, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.p90Ms != null ? `${fmtInt(rowData.p90Ms)} ms` : "—"}</span> },
    { id: "errors", header: "Errors", accessor: (t: AppTransaction) => t.errPct ?? -1, width: 90, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.errPct != null ? `${fmtNum(rowData.errPct)}%` : "—"}</span> },
    { id: "count", header: "Runs · 1h", accessor: "count", width: 100, alignment: "right" },
  ], []);
  return <DataTable data={transactions} columns={columns} fullWidth />;
}

export { speedLabel };
