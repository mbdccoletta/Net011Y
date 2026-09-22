// What a site talks to, from NetFlow: where the bytes go, which applications carry them, and the
// patterns worth a look. Measured, never judged: the insights say what the flows show and leave the
// verdict to the operator and to Assist.
import React from "react";
import type { AppPath, Device, NetworkModel, SiteTraffic } from "../model/types";
import { portUsers, trafficInsights } from "../model/traffic";
import { fmtBytes, fmtInt } from "../utils/format";
import { Tile, TONE } from "./Visual";

const SPLIT: { key: keyof Pick<SiteTraffic, "toSites" | "internet" | "private" | "local">; label: string; tone: string }[] = [
  { key: "toSites", label: "other sites", tone: "var(--lm-accent)" },
  { key: "internet", label: "Internet", tone: "var(--lm-cyan)" },
  { key: "private", label: "unmapped private", tone: "var(--lm-violet)" },
  { key: "local", label: "inside the site", tone: "var(--lm-neutral)" },
];

export function SiteTrafficTile({ model, code, onSite }: { model: NetworkModel; code: string; onSite: (code: string) => void }) {
  const flows = model.flowMap;
  const t = flows?.sites[code];
  if (!flows || !t) return null;
  const insights = trafficInsights(t, flows, code);
  const nameOf = (c: string) => model.sites[c]?.name ?? c;
  return (
    <Tile tone={TONE.cyan} title="Traffic · last hour" right={`NetFlow · ${t.exporters.join(", ")}`}>
      <div className="tf-head">
        <div><div className="vz-big">{fmtBytes(t.bytes)}</div><div className="vz-cap">{fmtInt(t.flows)} flows</div></div>
        <div className="tf-split" role="img" aria-label={SPLIT.map((s) => `${s.label} ${fmtBytes(t[s.key])}`).join(", ")}>
          {SPLIT.filter((s) => t[s.key] > 0).map((s) => (
            <span key={s.key} style={{ flexGrow: t[s.key], background: s.tone }} title={`${s.label}: ${fmtBytes(t[s.key])}`} />
          ))}
        </div>
        <div className="tf-legend">
          {SPLIT.filter((s) => t[s.key] > 0).map((s) => (
            <span key={s.key}><i style={{ background: s.tone }} />{s.label} <b>{Math.round((100 * t[s.key]) / Math.max(t.bytes, 1))}%</b></span>
          ))}
        </div>
      </div>
      <div className="tf-cols">
        <div>
          <div className="tf-sub">Talks to<small>total · sent ↑ · received ↓</small></div>
          {t.peers.slice(0, 5).map((p) => (
            <div key={p.name} className="tf-row">
              {p.kind === "site" && p.site
                ? <button type="button" className="tf-name tf-link" title={nameOf(p.site)} onClick={() => onSite(p.site!)}>{nameOf(p.site)}</button>
                : <span className="tf-name" title={p.kind === "private" ? `${p.name} · private range no site claims` : p.name}>{p.name}</span>}
              <span className="tf-val" title={p.sent != null || p.received != null ? `${fmtBytes(p.sent ?? 0)} sent · ${fmtBytes(p.received ?? 0)} received` : undefined}>
                {fmtBytes(p.bytes)}
                {(p.sent ?? 0) > 0 && (p.received ?? 0) > 0 && <small className="tf-dir">{fmtBytes(p.sent!)}↑ {fmtBytes(p.received!)}↓</small>}
              </span>
            </div>
          ))}
        </div>
        <div>
          <div className="tf-sub">Applications</div>
          {t.apps.slice(0, 5).map((a) => (
            <div key={`${a.proto}/${a.port}`} className="tf-row">
              <span className="tf-name" title={a.name ? `${a.name} · ${a.proto}/${a.port}` : `${a.proto}/${a.port}`}>{a.name ?? `${a.proto}/${a.port}`}</span>
              <span className="tf-val">{fmtBytes(a.bytes)}</span>
            </div>
          ))}
        </div>
      </div>
      {insights.length > 0 && (
        <ul className="tf-insights">{insights.map((i) => <li key={i}>{i}</li>)}</ul>
      )}
    </Tile>
  );
}

/**
 * Who uses a device's ports, from the flows it exports: the busiest ports first, each with the
 * conversations behind it. Needs the exporter to send the interface index and the SNMP extension to
 * report it; the section says which of the two is missing instead of staying silent.
 */
export function PortUsers({ model, device }: { model: NetworkModel; device: Device }) {
  const f = model.flowMap;
  const exported = f?.conversations.filter((c) => c.viaName === device.name) ?? [];
  if (!exported.length) return null;
  const withPort = exported.filter((c) => c.inIf || c.outIf);
  const ports = [...new Set(withPort.flatMap((c) => [c.inIf, c.outIf]).filter((p): p is string => !!p))]
    .map((p) => ({ name: p, util: device.interfaces.find((i) => i.name === p)?.util ?? null }))
    .sort((a, b) => (b.util ?? -1) - (a.util ?? -1)).slice(0, 3);
  return (
    <section className="pu" aria-labelledby={`pu-${device.name}`}>
      <h5 id={`pu-${device.name}`} className="pu-title">Who uses its ports · NetFlow, last hour</h5>
      {!ports.length ? (
        <p className="tr-note">This device exports flows without the interface index, so they cannot be tied to a port. Include input and output interface in the flow template.</p>
      ) : ports.map((p) => {
        const users = portUsers(model, device, p.name);
        return (
          <div key={p.name} className="pu-port">
            <div className="pu-head"><span className="np-mono">{p.name}</span><span>{p.util != null ? `${Math.round(p.util)}% utilization` : "utilization not reported"}</span></div>
            {users.map((u, i) => (
              <div key={i} className="pu-row">
                <span className="pu-bar" style={{ width: `${Math.max(2, u.share)}%` }} aria-hidden="true" />
                <span className="pu-what">{u.app} · {u.from} → {u.to}</span>
                <span className="pu-val">{u.share}% · {fmtBytes(u.bytes)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** Path quality where the remote end is this site: how the applications reach it, next to how they reach the rest. */
export function SitePathsTile({ model, code }: { model: NetworkModel; code: string }) {
  const paths = (model.paths ?? []).filter((p) => p.remoteSite === code).sort((a, b) => b.conversations - a.conversations).slice(0, 6);
  if (!paths.length) return null;
  const all = model.paths ?? [];
  const elsewhere = (p: AppPath) => {
    const xs = all.filter((o) => o.workload === p.workload && o.port === p.port && o.remoteSite !== code && o.rttP90Ms != null).map((o) => o.rttP90Ms!).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  };
  return (
    <Tile tone={TONE.cyan} title="Applications reaching this site" right="OneAgent · last hour">
      <div className="tr-table" role="table">
        <div className="tr-row tr-row--paths tr-head" role="row"><span>Workload</span><span>Service</span><span>Round trip p90</span><span>Elsewhere</span><span>Retransmitted</span><span>Resets</span></div>
        {paths.map((p, i) => {
          const other = elsewhere(p);
          return (
            <div key={i} className="tr-row tr-row--paths" role="row">
              <span>{p.workload}</span><span>{p.app}</span>
              <span className={other != null && p.rttP90Ms != null && p.rttP90Ms >= 3 * other ? "is-warn" : undefined}>{p.rttP90Ms != null ? `${p.rttP90Ms} ms` : "—"}</span>
              <span>{other != null ? `${other} ms` : "—"}</span>
              <span className={(p.retrPct ?? 0) >= 2 ? "is-warn" : undefined}>{p.retrPct != null ? `${p.retrPct}%` : "—"}</span>
              <span>{fmtInt(p.resets)}</span>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

/** Every path, worst first: slow against its peers, losing packets, or reset. */
export function PathQualityTile({ model, site, onSite }: { model: NetworkModel; site?: string; onSite: (code: string) => void }) {
  const paths = (model.paths ?? []).filter((p) => !site || p.remoteSite === site);
  if (!paths.length) return null;
  const score = (p: AppPath) => (p.retrPct ?? 0) * 10 + (p.rttP90Ms ?? 0) / 10 + p.resets / Math.max(1, p.conversations) * 50;
  const top = [...paths].sort((a, b) => score(b) - score(a)).slice(0, 12);
  const where = (p: AppPath) => p.remoteKind === "site"
    ? <button type="button" className="tf-link" onClick={() => onSite(p.remoteSite!)}>{model.sites[p.remoteSite!]?.name ?? p.remoteSite}</button>
    : p.remoteKind === "internet" ? `Internet · ${p.remoteNet}` : p.remoteNet;
  return (
    <Tile tone={TONE.cyan} title="Path quality · last hour" right="OneAgent network flows · worst first">
      <div className="tr-table" role="table">
        <div className="tr-row tr-row--paths tr-head" role="row"><span>Workload</span><span>Other end</span><span>Service</span><span>Round trip p90</span><span>Retransmitted</span><span>Resets</span></div>
        {top.map((p, i) => (
          <div key={i} className="tr-row tr-row--paths" role="row">
            <span title={p.server ? "serves these connections" : "calls out"}>{p.workload}{p.server ? " ◂" : " ▸"}</span>
            <span>{where(p)}</span><span>{p.app}</span>
            <span>{p.rttP90Ms != null ? `${p.rttP90Ms} ms` : "—"}</span>
            <span className={(p.retrPct ?? 0) >= 2 ? "is-warn" : undefined}>{p.retrPct != null ? `${p.retrPct}%` : "—"}</span>
            <span>{fmtInt(p.resets)}</span>
          </div>
        ))}
      </div>
      <p className="tr-note">▸ the workload calls out · ◂ it serves. The other end is placed at a site through site_cidr or the subnets of the site&apos;s devices.
        With OneAgent&apos;s default reporting only critical connections (reset or timed out) are recorded, so these are the paths where connections fail, not all traffic.</p>
    </Tile>
  );
}

/**
 * Reachability per site from any ICMP monitor that pings a device, tagged or not — the network coverage
 * monitors Dynatrace creates for each SNMP monitoring configuration included. Circuit tags add the carrier
 * and the SLA on top; this is what every environment that monitors its network already has.
 */
export function ReachabilityTile({ model, onSite }: { model: NetworkModel; onSite: (code: string) => void }) {
  const bySite = new Map<string, { ms: number[]; loss: number[]; devices: number; silent: number }>();
  model.devices.filter((d) => d.icmp).forEach((d) => {
    const s = bySite.get(d.site) ?? { ms: [], loss: [], devices: 0, silent: 0 };
    s.devices++;
    if (d.icmp!.rttMs != null) s.ms.push(d.icmp!.rttMs);
    if (d.icmp!.loss != null) s.loss.push(d.icmp!.loss);
    if (d.icmp!.loss != null && d.icmp!.loss >= 100) s.silent++;
    bySite.set(d.site, s);
  });
  if (!bySite.size) return null;
  const med = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const rows = [...bySite].map(([code, s]) => ({ code, name: model.sites[code]?.name ?? code, ...s, rtt: med(s.ms), lossMax: s.loss.length ? Math.max(...s.loss) : null }))
    .sort((a, b) => b.silent - a.silent || (b.lossMax ?? 0) - (a.lossMax ?? 0) || (b.rtt ?? 0) - (a.rtt ?? 0));
  return (
    <Tile tone={rows.some((r) => r.silent) ? TONE.bad : TONE.cyan} title={`Reachability by site · ${rows.length} sites`} right="ICMP monitors · last hour">
      <div className="tr-table" role="table">
        <div className="tr-row tr-row--reach tr-head" role="row"><span>Site</span><span>Devices pinged</span><span>Not answering</span><span>Round trip (median)</span><span>Worst loss</span></div>
        {rows.map((r) => (
          <div key={r.code} className="tr-row tr-row--reach" role="row">
            <span><button type="button" className="tf-link" onClick={() => onSite(r.code)}>{r.name}</button></span>
            <span>{fmtInt(r.devices)}</span>
            <span className={r.silent ? "is-warn" : undefined}>{fmtInt(r.silent)}</span>
            <span>{r.rtt != null ? `${r.rtt} ms` : "—"}</span>
            <span className={(r.lossMax ?? 0) > 0 ? "is-warn" : undefined}>{r.lossMax != null ? `${r.lossMax}%` : "—"}</span>
          </div>
        ))}
      </div>
      <p className="tr-note">From the ICMP monitors that ping the devices, including the network coverage monitors Dynatrace creates for each SNMP configuration.
        Tagging the monitor of each WAN circuit (circuit_id, carrier, sla_ms) turns this into circuits with their carrier and SLA.</p>
    </Tile>
  );
}
