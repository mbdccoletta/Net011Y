// Content of PageLayout.Details: the selected device, path hop or WAN link.
import React from "react";
import { openInterface } from "../utils/drilldown";
import { ArrowRightIcon, ExternalLinkIcon } from "@dynatrace/strato-icons";
import { Button } from "@dynatrace/strato-components/buttons";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import type { Device, E2EPath, NetworkModel } from "../model/types";
import { T } from "../model/verdict";
import { ROLE_LABEL } from "../model/site";
import { fmtBps, fmtBytes, fmtInt, fmtNum, speedLabel, toneVar } from "../utils/format";
import { Status } from "./Status";
import { CircuitsTable, DevicesTable, TransactionsTable } from "./Tables";
import { useDeviceInterfaces } from "../hooks/useDeviceInterfaces";
import { EventsList } from "./EventsList";
import { useElementWidth } from "../hooks/useElementWidth";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { inBuckets, useLogBuckets } from "../hooks/useLogBucket";
import { DEVICE_LOG_HOURS, deviceLogs24h } from "../data/queries";

export type Selection = { type: "device"; name: string } | { type: "hop"; path: string; index: number };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <Heading level={5}>{title}</Heading>
      {children}
    </section>
  );
}

function Timeline({ model, device }: { model: NetworkModel; device: Device }) {
  const [box, boxW] = useElementWidth<HTMLDivElement>(560);
  // the load reads the last DEVICE_LOG_HOURS in 15-minute steps; 24 h of this device is read on request only
  const [wide, setWide] = React.useState(false);
  const buckets = useLogBuckets();
  const ipOk = /^[0-9a-fA-F.:]+$/.test(device.ip);
  const day = useDql({ query: inBuckets(deviceLogs24h(device.ip), buckets), maxResultRecords: 50 }, { enabled: wide && ipOk && !model.demo, staleTime: 5 * 60 * 1000 });
  React.useEffect(() => { setWide(false); }, [device.name]);
  const dayRows = (day.data?.records ?? []) as { kind?: string; loglevel?: string; n?: (number | null)[] }[];
  const sumBy = (pick: (r: (typeof dayRows)[number]) => boolean) => {
    const out = new Array(24).fill(0);
    dayRows.filter(pick).forEach((r) => (r.n ?? []).slice(-24).forEach((v, i) => { out[i] += Number(v ?? 0); }));
    return out;
  };
  const showDay = wide && day.isSuccess;
  const errTs = showDay ? sumBy((r) => r.kind === "syslog" && r.loglevel === "ERROR") : device.syslogErrTs;
  // traps come counted per step: a mark in every step that had one, labelled with how many
  const trapTs = showDay ? sumBy((r) => r.kind === "trap") : device.trapTs ?? [];
  const span = showDay ? 24 : DEVICE_LOG_HOURS;
  // SNMP availability is hourly over 24 h: the short view shows its last hours, each over its four steps
  const avail = (device.availTs ?? []).slice(showDay ? -24 : -span).flatMap((v) => (showDay ? [v] : [v, v, v, v]));
  const w = Math.max(420, boxW), h = 140, pad = 44, steps = 24;
  const x = (i: number) => pad + (i * (w - pad - 10)) / steps;
  const max = Math.max(...errTs, 1), bw = (w - pad - 10) / steps - 2;
  return (
    <div className="vz-fluid" ref={box}>
    <svg className="np-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`Syslog errors, SNMP availability and traps over ${span} hours`}>
      <line x1={pad} x2={w - 10} y1={90} y2={90} stroke="var(--np-line)" />
      <text x={0} y={30} fontSize={12}>syslog</text><text x={0} y={42} fontSize={12}>{showDay ? "errors/h" : "err/15m"}</text>
      {errTs.map((v, i) => (
        <rect key={i} x={x(i) + 1} y={90 - (v / max) * 64} width={bw} height={(v / max) * 64} fill="var(--np-crit-accent)" opacity={0.55}><title>{`${v} syslog errors`}</title></rect>
      ))}
      <text x={0} y={113} fontSize={12}>SNMP</text>
      {avail.map((v, i) => <rect key={`a${i}`} x={x(i) + 1} y={104} width={bw} height={10} fill={v ? "var(--np-good)" : "var(--np-crit-accent)"} />)}
      <text x={0} y={129} fontSize={12}>traps</text>
      {trapTs.map((n, i) => n > 0 && (
        <line key={`t${i}`} x1={x(i) + bw / 2 + 1} x2={x(i) + bw / 2 + 1} y1={120} y2={132} stroke="var(--np-primary)" strokeWidth={2}><title>{`${n} trap${n === 1 ? "" : "s"}`}</title></line>
      ))}
      {[0, 6, 12, 18, 24].map((i) => <text key={i} x={x(i)} y={h - 1} fontSize={12} textAnchor="middle">{i === 24 ? "now" : `-${((24 - i) * span) / 24}h`}</text>)}
    </svg>
    {!model.demo && ipOk && (
      <div className="np-row" style={{ marginTop: 6 }}>
        {showDay
          ? <Button size="condensed" onClick={() => setWide(false)}>Back to {DEVICE_LOG_HOURS} h</Button>
          : <Button size="condensed" loading={wide && day.isLoading} onClick={() => setWide(true)}>Load 24 h</Button>}
        <Text textStyle="small" className="np-muted">{showDay ? "24 h of this device, read on request" : `Last ${DEVICE_LOG_HOURS} h. Loading 24 h reads a full day of logs, which Grail bills by volume scanned.`}</Text>
      </div>
    )}
    </div>
  );
}

export function DeviceDetails({ model, device, onDevice }: { model: NetworkModel; device: Device; onDevice: (name: string) => void }) {
  const [issuesOnly, setIssuesOnly] = React.useState(true);
  const notMonitored = device.verdict === "Not monitored";
  // In a large estate the ports were not part of the initial load: they are fetched for this device only.
  const ports = useDeviceInterfaces(device, !model.demo);
  const all = ports.interfaces;
  const problem = (i: Device["interfaces"][number]) => !!(i.flag || i.errors || i.crc || (i.uplink && i.oper.startsWith("down") && i.admin.startsWith("up")));
  const ifs = all.filter((i) => !issuesOnly || problem(i)).sort((a, b) => (b.util ?? -1) - (a.util ?? -1)).slice(0, 40);
  const neighbors = [
    ...model.links.filter((l) => l.a === device.name || l.b === device.name).map((l) => ({ proto: "LLDP", peer: l.a === device.name ? l.b : l.a, state: l.label })),
    ...model.peers.filter((p) => p.device === device.name).map((p) => ({ proto: p.proto, peer: `${p.peer}${p.remoteAs ? ` · AS ${p.remoteAs}` : ""}`, state: p.state ?? "" })),
  ];
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="np-row">
        <Status verdict={device.verdict} />
        <Text textStyle="small">{model.sites[device.site]?.name ?? device.site} · {ROLE_LABEL[device.role] ?? device.role} · <span className="np-mono">{device.ip}</span></Text>
        {device.incident && <span className="np-chip-incident">{device.incident}</span>}
      </div>
      <Text textStyle="small" className="np-muted">{device.desc}</Text>

      <Section title={notMonitored ? "Why it isn't monitored" : `Why ${device.verdict.toLowerCase()}`}>
        {device.reasons.length
          ? device.reasons.map((r, k) => <div key={k} className="np-row" style={{ gap: 8 }}><Status verdict={r.level} label={false} /><span>{r.text}</span></div>)
          : <Text>No rule is violated.</Text>}
        {notMonitored && <Text textStyle="small">Enable the matching SNMP extension for {device.ip} to collect CPU, interfaces and availability.</Text>}
      </Section>

      {!notMonitored && (
        <dl className="np-kv">
          <dt>Role</dt><dd>{ROLE_LABEL[device.role] ?? device.role} · {device.vendor}</dd>
          <dt>Availability, 24 h</dt>
          <dd style={{ color: (device.availPct ?? 100) < T.avail_crit ? toneVar("Critical") : undefined }}>{device.availPct != null ? `${fmtNum(device.availPct)}%` : "—"}</dd>
          <dt>CPU now</dt>
          <dd style={{ color: device.cpuNow != null && device.cpuNow >= T.cpu_warn ? toneVar(device.cpuNow >= T.cpu_crit ? "Critical" : "Warning") : undefined }}>{device.cpuNow != null ? `${Math.round(device.cpuNow)}%` : "—"}</dd>
          <dt>ICMP round trip</dt><dd>{device.icmp?.rttMs != null ? `${fmtNum(device.icmp.rttMs)} ms` : "—"} · loss {device.icmp?.loss != null ? `${fmtNum(device.icmp.loss)}%` : "—"}</dd>
          <dt>Interfaces</dt>
          <dd>{ports.loading ? "loading the ports of this device…"
            : all.length ? `${all.filter((i) => i.oper.startsWith("up")).length} up of ${all.length}${ports.fromModel ? "" : " · fetched for this device"}`
            : device.ifStats ? `${device.ifStats.interfaces} ports · max ${fmtNum(device.ifStats.maxUtil ?? 0)}% utilization` : "—"}</dd>
        </dl>
      )}

      <Section title="Syslog, SNMP and traps"><Timeline model={model} device={device} /></Section>

      {!notMonitored && (
        <Section title="Interfaces">
          <div className="np-row">
            <Button variant={issuesOnly ? "emphasized" : "default"} size="condensed" onClick={() => setIssuesOnly(true)}>With issues</Button>
            <Button variant={!issuesOnly ? "emphasized" : "default"} size="condensed" onClick={() => setIssuesOnly(false)}>All</Button>
          </div>
          {ifs.length ? (
            <div className="np-scroll-x">
              <table className="np-simple-table" style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                <thead><tr>{["Interface", "Oper / admin", "Speed", "Max utilization", "Peak in / out", "Errors"].map((c) => <th key={c} style={{ textAlign: "left", padding: "6px 8px", color: "var(--np-muted)", fontSize: 12 }}>{c}</th>)}</tr></thead>
                <tbody>
                  {ifs.map((i) => (
                    <tr key={i.name} style={{ borderTop: "1px solid var(--np-line)" }}>
                      <td className="np-mono" style={{ padding: "6px 8px" }}>
                        {i.id && !model.demo
                          ? <button type="button" className="np-link" onClick={() => openInterface(i.id!)} title={`Open ${i.name} in Infrastructure & Operations`}>{i.name} <ExternalLinkIcon className="np-inline-icon" /></button>
                          : i.name}
                        {i.uplink ? " · uplink" : ""}
                      </td>
                      <td className="np-mono np-small" style={{ padding: "6px 8px" }}>{i.oper} / {i.admin}</td>
                      <td className="np-mono" style={{ padding: "6px 8px" }}>{speedLabel(i.speed)}</td>
                      <td className="np-mono" style={{ padding: "6px 8px", color: i.flag === "saturated" ? "var(--np-crit)" : i.flag ? "var(--np-warn)" : undefined }}>
                        {i.util != null ? `${fmtNum(i.util, 1)}%` : "—"}{i.flag === "inconsistent" ? " · above speed" : ""}
                      </td>
                      <td className="np-mono np-small" style={{ padding: "6px 8px" }}>{i.in.length ? `${fmtBps(Math.max(...i.in))} / ${fmtBps(Math.max(0, ...i.out))}` : "—"}</td>
                      <td className="np-mono" style={{ padding: "6px 8px" }}>{fmtInt(i.errors + i.crc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Text>No interface with issues.</Text>}
        </Section>
      )}

      <Section title="Recent events"><EventsList devices={[device]} limit={20} /></Section>

      {neighbors.length > 0 && (
        <Section title="Neighbors and routing">
          {neighbors.map((n, k) => (
            <div key={k} className="np-row" style={{ gap: 8 }}>
              <span className="np-mono np-small">{n.proto}</span>
              {model.devices.some((d) => d.name === n.peer)
                ? <Button variant="default" size="condensed" onClick={() => onDevice(n.peer)}>{n.peer}</Button>
                : <span>{n.peer}</span>}
              <span className="np-mono np-small np-muted">{n.state}</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

export function HopDetails({ model, path, index, onDevice }: { model: NetworkModel; path: E2EPath; index: number; onDevice: (name: string) => void }) {
  const hop = path.hops[index];
  if (!hop) return null;
  const byName = new Map(model.devices.map((d) => [d.name, d]));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="np-row">
        <Status verdict={hop.verdict} />
        <Text>{hop.topReason ?? hop.headline.label}</Text>
      </div>
      {hop.kind === "devices" && (
        <DevicesTable model={model} compact devices={hop.devices.map((n) => byName.get(n)).filter((d): d is Device => !!d)} onSelect={(d) => onDevice(d.name)} />
      )}
      {hop.kind === "circuit" && hop.circuits && (
        <>
          <CircuitsTable circuits={hop.circuits} />
          <Text textStyle="small">Latency, loss and jitter come from synthetic ICMP between the data center and the site router, per link, compared with each link's SLA.</Text>
        </>
      )}
      {hop.kind === "app" && hop.app && (
        <>
          <TransactionsTable transactions={hop.app.transactions} />
          <Text textStyle="small">Measured by OneAgent on the application servers, filtered by the site's subnets.{hop.app.consequenceOf ? ` No sessions because ${hop.app.consequenceOf} is down.` : ""}</Text>
        </>
      )}
      {hop.kind === "internet" && hop.peers && hop.peers.map((p) => (
        <div key={`${p.device}-${p.peer}`} className="np-row">
          <Status verdict={(p.state || "").startsWith("established") ? "Healthy" : "Critical"} label={p.state ?? "unknown"} />
          <span className="np-mono">{p.peer}</span><span className="np-muted">AS {p.remoteAs}</span>
          <Button variant="default" size="condensed" onClick={() => onDevice(p.device)}>{p.device}</Button>
        </div>
      ))}
      {hop.kind === "cloud" && hop.clusters && (
        <>
          <Section title="Clusters and host groups">
            {hop.clusters.map((c) => (
              <div key={c.name} className="np-row" style={{ justifyContent: "space-between" }}>
                <b>{c.name}</b>
                <span className="np-mono np-small">{fmtInt(c.conv)} conversations · {fmtInt(c.hosts)} hosts · {fmtBytes(c.bytes)} · retransmission {c.retrPct != null ? `${fmtNum(c.retrPct, 3)}%` : "—"}</span>
              </div>
            ))}
          </Section>
          <Section title="Largest conversations">
            {(model.oneagent ?? []).slice(0, 15).map((r, k) => (
              <div key={k} className="np-row" style={{ justifyContent: "space-between" }}>
                <Status verdict={r.retr || r.resets ? "Warning" : "Healthy"} label={r.retr || r.resets ? "Network suspect" : "Network clear"} />
                <span className="np-mono np-small">{r.host} <ArrowRightIcon className="np-inline-icon" aria-label="to" /> {r.dst}:{r.dport}</span>
                <span className="np-mono np-small">{fmtBytes(r.bytes)} · retr {fmtInt(r.retr)}</span>
              </div>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
