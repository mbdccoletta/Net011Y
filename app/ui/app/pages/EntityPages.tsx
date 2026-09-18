// Entity lists in the Infrastructure & Operations style: a FilterBar on top, a DataTable
// below, and a click on a row opens the entity in the details panel.
import React, { useMemo } from "react";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { FilterBar } from "@dynatrace/strato-components/filters";
import { SearchInput, Select } from "@dynatrace/strato-components/forms";
import type { Circuit, Device, NetworkModel, Verdict } from "../model/types";
import { ROLE_LABEL, type SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";
import { Status } from "../components/Status";
import { Spark } from "../components/Visual";
import { fmtNum, hhmm } from "../utils/format";

export interface Filters {
  status: string | null;
  region: string | null;
  role: string | null;
  carrier: string | null;
  q: string;
}

export interface PageProps {
  model: NetworkModel;
  infos: SiteInfo[];
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  selected: string | null;
  onSelect: (sel: string) => void;
}

const STATUS_OPTIONS: [string, string][] = [["issues", "Critical and warning"], ["Critical", "Critical"], ["Warning", "Warning"], ["Healthy", "Healthy"], ["Not monitored", "Not monitored"]];
const matchStatus = (v: Verdict, status: string | null) => !status || (status === "issues" ? isBad(v) : v === status);
const text = (v: unknown) => (typeof v === "string" && v ? v : null);
const contains = (hay: string, q: string) => !q || hay.toLowerCase().includes(q.trim().toLowerCase());
const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

function Two({ top, bottom, mono }: { top: React.ReactNode; bottom?: React.ReactNode; mono?: boolean }) {
  return (
    <div className="np-cell2">
      <span className={mono ? "np-mono" : undefined}>{top}</span>
      {bottom ? <span className="np-muted np-small">{bottom}</span> : null}
    </div>
  );
}

const Incident = ({ id }: { id?: string | null }) => (id ? <span className="np-chip-incident">{id}</span> : null);

function selectFilter(name: string, label: string, value: string | null, options: [string, string][], placeholder: string) {
  return (
    <FilterBar.Item name={name} label={label}>
      <Select defaultValue={value ?? undefined}>
        <Select.Trigger placeholder={placeholder} />
        <Select.Content>
          {options.map(([v, l]) => <Select.Option key={v} value={v} textValue={l}>{l}</Select.Option>)}
        </Select.Content>
      </Select>
    </FilterBar.Item>
  );
}

function EntityTable<T extends Record<string, unknown>>({ data, columns, activeIndex, onRow, hidden = [] }: { data: T[]; columns: DataTableColumnDef<T>[]; activeIndex: number; onRow: (row: T) => void; hidden?: string[] }) {
  return (
    <DataTable data={data} columns={columns} sortable fullWidth interactiveRows
      defaultColumnVisibility={Object.fromEntries(hidden.map((id) => [id, false]))}
      activeRow={activeIndex >= 0 ? String(activeIndex) : null}
      onActiveRowChange={(rowId) => { if (rowId != null && data[Number(rowId)]) onRow(data[Number(rowId)]); }}>
      <DataTable.Toolbar>
        <DataTable.VisibilitySettings />
      </DataTable.Toolbar>
      <DataTable.Pagination />
    </DataTable>
  );
}

// ---------------- sites ----------------

type SiteRow = SiteInfo & Record<string, unknown>;

function wanCell(i: SiteInfo) {
  const p = i.circuits.find((c) => c.kind === "primary");
  if (!p) return null;
  const b = i.circuits.find((c) => c.kind === "backup");
  if (p.status === "down" && b?.status === "up") return <Status verdict="Warning" label="On backup" />;
  if (p.status === "down") return <Status verdict="Critical" label="Down" />;
  return <Status verdict={p.verdict} label={p.latencyMs != null ? `${fmtNum(p.latencyMs)} ms` : "Not measured"} />;
}

export function SitesPage({ infos, filters, onFilters, selected, onSelect }: PageProps) {
  const regions = useMemo(() => uniq(infos.map((i) => i.site.region)), [infos]);
  const data = useMemo(() => infos.filter((i) =>
    matchStatus(i.verdict, filters.status) && (!filters.region || i.site.region === filters.region)
    && contains(`${i.site.name} ${i.code} ${i.cause ?? ""} ${i.incident ?? ""}`, filters.q)) as SiteRow[], [infos, filters]);
  const hasWan = infos.some((i) => i.circuits.length);
  const hasApp = infos.some((i) => i.path?.hops.some((h) => h.kind === "app"));

  const columns = useMemo<DataTableColumnDef<SiteRow>[]>(() => [
    { id: "status", header: "Status", accessor: (i) => i.verdict, width: 120, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    { id: "site", header: "Site", accessor: (i) => i.site.name, width: "1.5fr", cell: ({ rowData }) => <Two top={rowData.site.name} bottom={rowData.code} /> },
    ...(regions.length ? [{ id: "region", header: "Region", accessor: (i: SiteRow) => i.site.region ?? "—", width: 110 } as DataTableColumnDef<SiteRow>] : []),
    { id: "cause", header: "Probable cause", accessor: (i) => i.cause ?? "", width: "2.2fr",
      cell: ({ rowData }) => rowData.cause ? <Two top={rowData.cause} bottom={<>{rowData.causeLayer}{rowData.incident ? <> · <Incident id={rowData.incident} /></> : null}</>} /> : <span className="np-muted">—</span> },
    ...(hasWan ? [{ id: "wan", header: "Primary WAN link", accessor: (i: SiteRow) => i.circuits.find((c) => c.kind === "primary")?.latencyMs ?? -1, width: 150, cell: ({ rowData }: { rowData: SiteRow }) => wanCell(rowData) } as DataTableColumnDef<SiteRow>] : []),
    ...(hasApp ? [{
      id: "app", header: "App response p90", accessor: (i: SiteRow) => i.path?.hops.find((h) => h.kind === "app")?.stats.p90Ms ?? -1, width: 150, alignment: "right",
      cell: ({ rowData }: { rowData: SiteRow }) => { const v = rowData.path?.hops.find((h) => h.kind === "app")?.stats.p90Ms; return <span className="np-mono">{v != null ? `${fmtNum(v / 1000, 1)} s` : "—"}</span>; },
    } as DataTableColumnDef<SiteRow>] : []),
    { id: "devices", header: "Devices with issues", accessor: (i) => i.devices.filter((d) => isBad(d.verdict)).length, width: 140, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.devices.filter((d) => isBad(d.verdict)).length} / {rowData.devices.length}</span> },
  ], [regions.length, hasWan, hasApp]);

  const active = selected?.startsWith("site:") ? data.findIndex((i) => i.code === selected.slice(5)) : -1;
  return (
    <div className="np-page">
      <FilterBar onFilterChange={(v) => onFilters({ q: String(v.q?.value ?? ""), status: text(v.status?.value), region: text(v.region?.value) })}>
        <FilterBar.Item name="q" label="Search"><SearchInput defaultValue={filters.q} placeholder="Site, code, cause or incident" /></FilterBar.Item>
        {selectFilter("status", "Status", filters.status, STATUS_OPTIONS, "Any status")}
        {regions.length > 0 && selectFilter("region", "Region", filters.region, regions.map((r) => [r, r]), "Any region")}
      </FilterBar>
      <EntityTable data={data} columns={columns} activeIndex={active} onRow={(i) => onSelect(`site:${i.code}`)} />
    </div>
  );
}

// ---------------- devices ----------------

type DeviceRow = Device & Record<string, unknown>;

/** The trend cell sorts on the last reading; the curve itself is drawn by <Spark />. */
const cpuLast = (d: Device) => (d.cpu.length ? d.cpu[d.cpu.length - 1] : -1);

export function DevicesPage({ model, filters, onFilters, selected, onSelect }: PageProps) {
  const regions = useMemo(() => uniq(Object.values(model.sites).map((s) => s.region)), [model]);
  const roles = useMemo(() => uniq(model.devices.map((d) => d.role)), [model]);
  const data = useMemo(() => model.devices.filter((d) =>
    matchStatus(d.verdict, filters.status) && (!filters.role || d.role === filters.role)
    && (!filters.region || model.sites[d.site]?.region === filters.region)
    && contains(`${d.name} ${d.ip} ${model.sites[d.site]?.name ?? ""} ${d.reasons[0]?.text ?? ""}`, filters.q)) as DeviceRow[], [model, filters]);

  const columns = useMemo<DataTableColumnDef<DeviceRow>[]>(() => [
    { id: "status", header: "Status", accessor: (d) => d.verdict, width: 130, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    { id: "name", header: "Device", accessor: (d) => d.name, width: "1.4fr", cell: ({ rowData }) => <Two top={rowData.name} bottom={`${ROLE_LABEL[rowData.role] ?? rowData.role} · ${rowData.ip}`} mono /> },
    { id: "site", header: "Site", accessor: (d) => model.sites[d.site]?.name ?? d.site, width: "1fr" },
    { id: "cpu", header: "CPU", accessor: (d) => d.cpuNow, columnType: "meterbar", config: { min: 0, max: 100 }, width: 130 },
    { id: "cpuTrend", header: "CPU, 24 h", accessor: cpuLast, width: 140, alignment: "right",
      cell: ({ rowData }) => <Spark values={rowData.cpu} /> },
    { id: "avail", header: "Availability", accessor: (d) => d.availPct ?? -1, width: 110, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.availPct != null ? `${fmtNum(rowData.availPct)}%` : "—"}</span> },
    { id: "rtt", header: "ICMP RTT", accessor: (d) => d.icmp?.rttMs ?? -1, width: 100, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.icmp?.rttMs != null ? `${fmtNum(rowData.icmp.rttMs)} ms` : "—"}</span> },
    { id: "reason", header: "Main reason", accessor: (d) => d.reasons[0]?.text ?? "", width: "2fr",
      cell: ({ rowData }) => <span>{rowData.reasons[0]?.text ?? <span className="np-muted">Within expected range</span>} <Incident id={rowData.incident} /></span> },
  ], [model]);

  const active = selected?.startsWith("device:") ? data.findIndex((d) => d.name === selected.slice(7)) : -1;
  return (
    <div className="np-page">
      <FilterBar onFilterChange={(v) => onFilters({ q: String(v.q?.value ?? ""), status: text(v.status?.value), role: text(v.role?.value), region: text(v.region?.value) })}>
        <FilterBar.Item name="q" label="Search"><SearchInput defaultValue={filters.q} placeholder="Device, IP, site or reason" /></FilterBar.Item>
        {selectFilter("status", "Status", filters.status, STATUS_OPTIONS, "Any status")}
        {selectFilter("role", "Role", filters.role, roles.map((r) => [r, ROLE_LABEL[r] ?? r]), "Any role")}
        {regions.length > 0 && selectFilter("region", "Region", filters.region, regions.map((r) => [r, r]), "Any region")}
      </FilterBar>
      <EntityTable data={data} columns={columns} activeIndex={active} onRow={(d) => onSelect(`device:${d.name}`)} hidden={["avail", "rtt"]} />
    </div>
  );
}

// ---------------- WAN links ----------------

type LinkRow = Circuit & Record<string, unknown>;

export function LinksPage({ model, filters, onFilters, selected, onSelect }: PageProps) {
  const circuits = model.circuits ?? [];
  const regions = useMemo(() => uniq(Object.values(model.sites).map((s) => s.region)), [model]);
  const carriers = useMemo(() => uniq(circuits.map((c) => c.carrier)), [circuits]);
  const data = useMemo(() => circuits.filter((c) =>
    matchStatus(c.verdict, filters.status) && (!filters.carrier || c.carrier === filters.carrier)
    && (!filters.region || model.sites[c.site]?.region === filters.region)
    && contains(`${c.siteName} ${c.site} ${c.carrier} ${c.tech} ${c.incident ?? ""}`, filters.q)) as LinkRow[], [circuits, model, filters]);

  const columns = useMemo<DataTableColumnDef<LinkRow>[]>(() => [
    { id: "status", header: "Status", accessor: (c) => c.verdict, width: 130, cell: ({ rowData }) => <Status verdict={rowData.verdict} /> },
    { id: "site", header: "Site", accessor: (c) => c.siteName, width: "1.3fr", cell: ({ rowData }) => <Two top={rowData.siteName} bottom={`${rowData.site} · ${rowData.kind === "primary" ? "Primary" : "Backup"}`} /> },
    { id: "carrier", header: "Carrier", accessor: (c) => c.carrier, width: 110 },
    { id: "tech", header: "Technology", accessor: (c) => c.tech, width: "1fr" },
    { id: "latency", header: "Latency", accessor: (c) => c.latencyMs ?? -1, width: 100, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.latencyMs != null ? `${fmtNum(rowData.latencyMs)} ms` : "—"}</span> },
    { id: "sla", header: "SLA", accessor: (c) => c.slaMs, width: 80, alignment: "right", cell: ({ rowData }) => <span className="np-mono">{rowData.slaMs} ms</span> },
    { id: "loss", header: "Loss", accessor: (c) => c.lossPct ?? -1, width: 80, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.lossPct != null ? `${fmtNum(rowData.lossPct)}%` : "—"}</span> },
    { id: "reason", header: "Reason", accessor: (c) => c.reasons[0]?.text ?? "", width: "1.6fr",
      cell: ({ rowData }) => <span>{rowData.reasons[0]?.text ?? <span className="np-muted">Within SLA</span>}{rowData.since && rowData.status === "down" ? ` (${hhmm(rowData.since)})` : ""} <Incident id={rowData.incident} /></span> },
  ], []);

  const active = selected?.startsWith("link:") ? data.findIndex((c) => c.id === selected.slice(5)) : -1;
  return (
    <div className="np-page">
      <FilterBar onFilterChange={(v) => onFilters({ q: String(v.q?.value ?? ""), status: text(v.status?.value), carrier: text(v.carrier?.value), region: text(v.region?.value) })}>
        <FilterBar.Item name="q" label="Search"><SearchInput defaultValue={filters.q} placeholder="Site, carrier or incident" /></FilterBar.Item>
        {selectFilter("status", "Status", filters.status, STATUS_OPTIONS, "Any status")}
        {selectFilter("carrier", "Carrier", filters.carrier, carriers.map((c) => [c, c]), "Any carrier")}
        {regions.length > 0 && selectFilter("region", "Region", filters.region, regions.map((r) => [r, r]), "Any region")}
      </FilterBar>
      <EntityTable data={data} columns={columns} activeIndex={active} onRow={(c) => onSelect(`link:${c.id}`)} />
    </div>
  );
}
