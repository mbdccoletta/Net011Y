// Drill-down row into the native Dynatrace apps, in context. Each button targets the exact component
// when it's known (the open problem, the device in Infrastructure & Operations, the circuit's monitor in
// Synthetic, the devices' logs and metrics) and opens the app home only when several components compete
// or ids aren't real (example network). Every app opens in a dedicated tab.
import React from "react";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";
import { Menu } from "@dynatrace/strato-components/navigation";
import type { Circuit, Device, DeviceProblem } from "../model/types";
import {
  circuitMetricsQuery, deviceHealthQuery, deviceMetricsQuery, hoursBack, logsQuery,
  openDevice, openInfraDevices, openLogs, openMonitor, openNative, openNotebook, openProblem,
} from "../utils/drilldown";

interface Props {
  /** Devices in scope: their open problems, logs and metrics */
  devices: Device[];
  /** WAN circuits in scope: their open problems, monitors and metrics */
  circuits?: Circuit[];
  /** The device to open in Infrastructure & Operations (probable cause or selected device) */
  focus?: Device | null;
  /** The circuit to open in Synthetic (the failed or selected link) */
  focusCircuit?: Circuit | null;
  since?: string | null;
  /** Example network: entity ids aren't real, so apps open without context */
  demo?: boolean;
  before?: React.ReactNode;
  after?: React.ReactNode;
  showNotebook?: boolean;
}

const uniqueProblems = (list: DeviceProblem[]) => [...new Map(list.map((p) => [p.eventId, p])).values()].sort((a, b) => b.start.localeCompare(a.start));

export function NativeDrill({ devices, circuits = [], focus, focusCircuit, since, demo, before, after, showNotebook = true }: Props) {
  const ips = devices.map((d) => d.ip).filter(Boolean).slice(0, 40);
  // Davis problems only: an event that never became a problem is not something the Problems app opens,
  // and counting thousands of them labelled the button "Problems · 170"
  const problems = demo ? [] : uniqueProblems([...devices.flatMap((d) => d.problems ?? []), ...circuits.flatMap((c) => c.problems ?? [])].filter((p) => !p.muted && p.eventKind === "DAVIS_PROBLEM"));
  const one = problems.length === 1 ? problems[0] : null;
  const device = demo ? null : focus ?? (devices.length === 1 ? devices[0] : null);
  const circuit = demo ? null : focusCircuit ?? (circuits.length === 1 ? circuits[0] : null);
  const monitorId = circuit?.monitorId ?? (device && !circuits.length ? device.icmp?.monitorId : undefined);
  const notebook = circuit
    ? { q: circuitMetricsQuery([circuit.id]), title: `${circuit.siteName} ${circuit.kind} link latency and loss` }
    : circuits.length && !devices.length
    ? { q: circuitMetricsQuery(circuits.map((c) => c.id)), title: "WAN circuits latency and loss" }
    : devices.some((d) => d.icmp) || demo
      ? { q: deviceMetricsQuery(ips), title: "Device reachability and latency" }
      : { q: deviceHealthQuery(devices.map((d) => d.id)), title: "Device CPU" };

  return (
    <div className="lm-drill">
      <span className="lm-drill__lead">Open in Dynatrace</span>
      {demo && <span className="lm-drill__note">Example network: these devices and addresses don&apos;t exist in this environment, so there is nothing to open. Switch to This environment in Settings.</span>}
      {before}
      {problems.length > 1 ? (
        // the Problems app can only be opened on one problem at a time, so list the matching ones
        <Menu>
          <Menu.Trigger>
            <button type="button" className="lm-btn lm-btn--primary" disabled={demo} title={`${problems.length} open problems on these components`}>
              <b>Problems · {problems.length}</b><small>Davis · pick one</small><ExternalLinkIcon />
            </button>
          </Menu.Trigger>
          <Menu.Content>
            <Menu.Label>Open problems</Menu.Label>
            {problems.slice(0, 12).map((p) => (
              <Menu.Item key={p.eventId} onSelect={() => openProblem(p.eventId, p.eventKind)}>{p.displayId} · {p.name}</Menu.Item>
            ))}
          </Menu.Content>
        </Menu>
      ) : one ? (
        <button type="button" className="lm-btn lm-btn--primary" disabled={demo}
          title={demo ? "Simulated data: nothing to open" : `Open ${one.displayId} · ${one.name} in Problems`}
          onClick={() => openProblem(one.eventId, one.eventKind)}>
          <b>{one.displayId ? `Problem ${one.displayId}` : "Alert"}</b>
          <small>this alert in Davis</small><ExternalLinkIcon />
        </button>
      ) : null}
      {devices.length > 0 && (
        <button type="button" className="lm-btn" disabled={demo} title={demo ? "Simulated data: nothing to open" : `Syslog and SNMP traps of ${devices.length === 1 ? devices[0].name : `${devices.length} devices`} in Logs`}
          onClick={() => openLogs(logsQuery(ips, since), hoursBack(since))}>
          <b>Logs</b><small>syslog and traps</small><ExternalLinkIcon />
        </button>
      )}
      <button type="button" className="lm-btn" disabled={demo} title={demo ? "Simulated data: nothing to open" : device ? `Open ${device.name} in Infrastructure & Operations` : "Several devices: open the network device list in Infrastructure & Operations"}
        onClick={() => (device ? openDevice(device.id) : openInfraDevices())}>
        <b>Infra &amp; Ops</b><small>{device ? "this device" : "network devices"}</small><ExternalLinkIcon />
      </button>
      {(monitorId || circuits.length > 0) && (
        <button type="button" className="lm-btn" disabled={demo} title={demo ? "Simulated data: nothing to open" : monitorId ? `Open the monitor of ${circuit ? `${circuit.siteName} · ${circuit.kind} link` : device?.name} in Synthetic` : "Several circuits: open Synthetic"}
          onClick={() => (monitorId ? openMonitor(monitorId) : openNative("synthetic"))}>
          <b>Synthetic</b><small>{monitorId ? "this ICMP monitor" : "monitor list"}</small><ExternalLinkIcon />
        </button>
      )}
      {showNotebook && (
        <button type="button" className="lm-btn" disabled={demo} title={demo ? "Simulated data: nothing to open" : `${notebook.title} in Notebooks`} onClick={() => openNotebook(notebook.q, notebook.title)}>
          <b>Notebook</b><small>editable DQL</small><ExternalLinkIcon />
        </button>
      )}
      {!problems.length && (
        // nothing is open on these components, so Problems is not the next step: it stays last and quiet
        <button type="button" className="lm-btn lm-btn--quiet" disabled={demo}
          title={demo ? "Simulated data: nothing to open" : "No open problem on these components: opens the Problems app, unfiltered"}
          onClick={() => openNative("problems")}>
          <b>Problems</b><small>none open here</small><ExternalLinkIcon />
        </button>
      )}
      {after}
    </div>
  );
}
