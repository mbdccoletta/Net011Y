// Visual building blocks of the live map panels: the causal chain, the spread curve synced
// with the replay, evidence badges, and the network status ring with region bars.
import React from "react";
import {
  ApplicationsIcon, DataCenterIcon, EventIcon, FirewallIcon, LinkBrokenIcon, LocationMarkerIcon, LogsIcon, NetworkDevicesIcon, UserSessionsIcon,
} from "@dynatrace/strato-icons";
import type { Verdict } from "../model/types";
import type { Cause, Evidence } from "../model/causes";
import type { SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";
import { fmtInt } from "../utils/format";
import { MAP_COLORS } from "./LiveMap";

const parseTs = (s: string) => Date.parse(s.length === 17 ? s.replace("Z", ":00Z") : s);
const compact = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(0)}k` : fmtInt(n));

function Node({ icon, value, label, tone }: { icon: React.ReactNode; value: string; label: string; tone: Verdict | "neutral" }) {
  const color = tone === "neutral" ? "var(--lm-muted)" : MAP_COLORS[tone];
  return (
    <div className="lm-chain__node" style={{ "--lm-tone": color } as React.CSSProperties} title={`${value} ${label}`}>
      <span className="lm-chain__icon">{icon}</span>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** Origin → sites → devices → application, each with its magnitude. */
export function CauseChain({ cause }: { cause: Cause }) {
  const origin = cause.kind === "carrier" ? <LinkBrokenIcon /> : cause.kind === "datacenter" ? (cause.devices[0]?.role === "firewall" ? <FirewallIcon /> : <DataCenterIcon />) : cause.kind === "application" ? <ApplicationsIcon /> : <NetworkDevicesIcon />;
  const originValue = cause.kind === "carrier" ? String(cause.elements.length || cause.sites.length) : String(Math.max(1, cause.devices.length));
  const p90 = Math.max(0, ...cause.sites.map((s) => s.path?.hops.find((h) => h.kind === "app")?.stats.p90Ms ?? 0));
  const app = cause.impact.sessionsLost ? { v: `−${compact(cause.impact.sessionsLost)}`, l: "sessions/h", t: "Critical" as Verdict }
    : cause.impact.sessionsSlowed ? { v: compact(cause.impact.sessionsSlowed), l: "slow sessions/h", t: "Warning" as Verdict }
      : p90 ? { v: `${(p90 / 1000).toFixed(1)}s`, l: "app p90", t: p90 >= 2000 ? ("Warning" as Verdict) : ("Healthy" as Verdict) } : { v: "—", l: "app impact", t: "neutral" as const };
  const nodes = [
    <Node key="o" icon={origin} value={originValue} label={cause.kind === "carrier" ? "links" : "origin"} tone={cause.verdict} />,
    <Node key="s" icon={<LocationMarkerIcon />} value={fmtInt(cause.impact.sites)} label={cause.impact.offline ? `sites · ${cause.impact.offline} dark` : "sites"} tone={cause.impact.offline ? "Critical" : "Warning"} />,
    <Node key="d" icon={<NetworkDevicesIcon />} value={fmtInt(cause.impact.devices)} label="devices" tone="neutral" />,
    <Node key="a" icon={<UserSessionsIcon />} value={app.v} label={app.l} tone={app.t} />,
  ];
  return (
    <div className="lm-chain" role="img" aria-label={`Cause chain: ${originValue} origin, ${cause.impact.sites} sites, ${cause.impact.devices} devices with issues, application ${app.v} ${app.l}`}>
      {nodes.flatMap((n, k) => (k ? [<span key={`c${k}`} className="lm-chain__link" aria-hidden="true" />, n] : [n]))}
    </div>
  );
}

/** Cumulative sites hit over time, with the replay cursor. */
export function SpreadChart({ cause, start, end, at }: { cause: Cause; start: number; end: number; at: number }) {
  const W = 300, H = 64;
  const times = cause.sites.map((s) => { const t = cause.affectedAt[s.code] ?? cause.since; return t ? parseTs(t) : start; }).sort((a, b) => a - b);
  const x = (t: number) => ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * W;
  const y = (n: number) => H - 4 - (n / Math.max(1, cause.sites.length)) * (H - 10);
  let d = `M0,${y(0)}`, count = 0;
  times.forEach((t) => { count++; d += ` H${x(t).toFixed(1)} V${y(count).toFixed(1)}`; });
  d += ` H${W}`;
  const color = MAP_COLORS[cause.verdict];
  return (
    <svg className="lm-spread" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${cause.sites.length} sites affected over time`}>
      <line x1={0} x2={W} y1={H - 4} y2={H - 4} stroke="var(--lm-line)" />
      {/* Strato area series: flat, translucent fill in the series color */}
      <path d={`${d} V${H - 4} H0 Z`} style={{ fill: color, fillOpacity: 0.2 }} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--lm-cyan)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const SOURCES: { key: Evidence["source"]; icon: React.ReactNode }[] = [
  { key: "WAN link", icon: <LinkBrokenIcon /> },
  { key: "SNMP", icon: <NetworkDevicesIcon /> },
  { key: "Syslog", icon: <LogsIcon /> },
  { key: "Trap", icon: <EventIcon /> },
  { key: "Application", icon: <UserSessionsIcon /> },
];

/** One badge per evidence source; logs open in the native Logs app. */
export function EvidenceBadges({ cause, onLogs }: { cause: Cause; onLogs: () => void }) {
  return (
    <div className="lm-badges">
      {SOURCES.map(({ key, icon }) => {
        const items = cause.evidence.filter((e) => e.source === key);
        if (!items.length) return null;
        const level = items.some((e) => e.level === "Critical") ? "Critical" : items.some((e) => e.level === "Warning") ? "Warning" : "Healthy";
        const clickable = key === "Syslog" || key === "Trap";
        return (
          <button key={key} type="button" className="lm-badge" disabled={!clickable} onClick={clickable ? onLogs : undefined}
            style={{ "--lm-tone": MAP_COLORS[level] } as React.CSSProperties} title={items.map((e) => e.text).join("\n")}
            aria-label={`${items.length} ${key} evidence${clickable ? ", open in Logs" : ""}`}>
            {icon}<b>{items.length}</b><span>{key}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Status ring of all sites plus one stacked bar per region. */
export function NetworkStatus({ infos, onRegion }: { infos: SiteInfo[]; onRegion?: (region: string) => void }) {
  const order: Verdict[] = ["Critical", "Warning", "Healthy", "Not monitored"];
  const count = (list: SiteInfo[], v: Verdict) => list.filter((i) => i.verdict === v).length;
  const R = 44, C = 2 * Math.PI * R;
  let offset = 0;
  const bad = infos.filter((i) => isBad(i.verdict)).length;
  const regions = [...new Set(infos.filter((i) => !i.site.dc).map((i) => i.site.region ?? "Other"))]
    .map((r) => ({ r, list: infos.filter((i) => !i.site.dc && (i.site.region ?? "Other") === r) }))
    .sort((a, b) => b.list.filter((i) => isBad(i.verdict)).length / b.list.length - a.list.filter((i) => isBad(i.verdict)).length / a.list.length);
  const widest = Math.max(1, ...regions.map((g) => g.list.length));
  return (
    <div className="lm-netstatus">
      <svg viewBox="0 0 120 120" className="lm-ring" role="img" aria-label={`${bad} of ${infos.length} sites with issues`}>
        <circle cx={60} cy={60} r={R} fill="none" stroke="var(--lm-line)" strokeWidth={12} />
        {order.map((v) => {
          const n = count(infos, v);
          if (!n) return null;
          const len = (n / infos.length) * C;
          const el = <circle key={v} cx={60} cy={60} r={R} fill="none" stroke={MAP_COLORS[v]} strokeWidth={12} strokeDasharray={`${Math.max(len - 1.5, 1)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />;
          offset += len;
          return el;
        })}
        <text x={60} y={58} textAnchor="middle" fontSize={24} fontWeight={700} fill="var(--lm-ink)">{bad}</text>
        <text x={60} y={76} textAnchor="middle" fontSize={12} fill="var(--lm-muted)">of {fmtInt(infos.length)}</text>
      </svg>
      <div className="lm-regions">
        {regions.map(({ r, list }) => (
          <button key={r} type="button" className="lm-region" onClick={() => onRegion?.(r)} disabled={!onRegion}
            aria-label={`${r}: ${list.filter((i) => isBad(i.verdict)).length} of ${list.length} sites with issues`}>
            <span className="lm-region__name">{r}</span>
            <span className="lm-region__bar" style={{ width: `${(list.length / widest) * 100}%` }}>
              {order.map((v) => { const n = count(list, v); return n ? <i key={v} style={{ flex: n, background: MAP_COLORS[v] }} /> : null; })}
            </span>
            <b>{list.filter((i) => isBad(i.verdict)).length}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
