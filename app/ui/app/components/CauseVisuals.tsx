// Visual building blocks of the live map panels: the causal chain, the spread curve synced
// with the replay, evidence badges, and the network status ring with region bars.
import React from "react";
import {
  EventIcon, LinkBrokenIcon, LogsIcon, NetworkDevicesIcon, UserSessionsIcon,
} from "@dynatrace/strato-icons";
import type { Verdict } from "../model/types";
import type { Cause, Evidence } from "../model/causes";
import type { SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";
import { discardGroups } from "../model/discards";
import { fmtInt } from "../utils/format";
import { MAP_COLORS } from "./LiveMap";
import { fitInCircle } from "./Visual";


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

/**
 * What the cause is made of, which the panel never showed.
 *
 * A cause carried both lists all along — `elements`, the devices and circuits it is on, and
 * `evidence`, what each of them reported — and the panel rendered a count badge whose only
 * detail was a `title` attribute. On screen that is a column of numbers and a verdict with
 * nothing under it: "89 ports losing packets on 23 devices", and no way to learn which 23.
 *
 * Both lists are here now, under the badges and above the interpretation, because the reader
 * should meet the readings before the sentence drawn from them. Each device opens.
 */
export function CauseDetail({ cause, onDevice }: { cause: Cause; onDevice: (name: string) => void }) {
  const devices = cause.elements.filter((e) => e.kind === "device");
  const circuits = cause.elements.filter((e) => e.kind === "circuit");
  /* What the cause is about first, what happened to be logged nearby after it. Unsorted, the
     panel led with "LOGIN_SUCCESS" syslog from a device that happens to be in the set, three
     lines above the discard readings the cause was built from. */
  const RANK: Record<string, number> = { Davis: 0, "WAN link": 1, SNMP: 2, Trap: 3, Application: 4, Syslog: 5 };
  /* `Davis` is the value the evidence carries and the app compares on; what the reader is
     shown is what the rest of the app calls it, which is the same word on the buttons
     beside this list */
  const srcLabel = (src: string) => (src === "Davis" ? "Intelligence" : src);
  /**
   * One fact is one line, however many devices it was recorded on.
   *
   * A monitoring outage writes the same sentence against every device it covers: on this
   * environment, forty lines of "Reachability is not being measured … (P-1234567) · since
   * 16:49", identical but for the hostname they start with. Forty of them pushed the metrics,
   * the logs and the Assist below the fold of a panel whose whole job is to put those in
   * front of a reader — so the list was the reason the panel looked like it said nothing.
   *
   * The device name is the only part that differs, so it is what the fold-up counts.
   */
  const deduped = (() => {
    const by = new Map<string, { e: Evidence; devices: string[] }>();
    for (const e of cause.evidence) {
      if (e.source === "Davis" && e.t) continue;
      /**
       * The sentence with whatever names the device taken off the front.
       *
       * Matching on `e.device` is not enough: the line opens with the short name the device
       * calls itself — `FWC-001:` — while the field holds the inventory's full one,
       * `BR-SP-SPO1-FWC-001`. Any leading unspaced token followed by a colon is that prefix,
       * which is exactly the part that differs between forty copies of one sentence.
       */
      const body = e.text.replace(/^\S+\s*:\s*/, "");
      const k = `${e.source}|${e.level}|${body}`;
      const had = by.get(k);
      if (had) { if (e.device) had.devices.push(e.device); }
      else by.set(k, { e: { ...e, text: body }, devices: e.device ? [e.device] : [] });
    }
    return [...by.values()];
  })();
  const shown = deduped
    .sort((a, b) => (RANK[a.e.source] ?? 9) - (RANK[b.e.source] ?? 9));
  if (!devices.length && !circuits.length && !shown.length) return null;
  const SHOW = 12;

  /**
   * What this is, in one sentence, from the cause's own fields.
   *
   * Not the title again: the title names the fault, this says what it amounts to. For a
   * cause built from a platform alert that is the alert and where it sits; for one built
   * from a measurement it is the measurement. Everything here is a field — nothing is
   * phrased as a likelihood.
   */
  /* the line the lead is built from is not printed again under "What it reported": the same
     sentence twice, eight lines apart, read as the panel repeating itself */
  const lead = cause.ports?.length ? null
    : shown.find((x) => x.e.source === "Davis") ?? shown.find((x) => x.e.source === "SNMP") ?? shown[0];
  const rest = lead ? shown.filter((x) => x !== lead) : shown;
  const summary = cause.ports?.length
    ? `${fmtInt(cause.ports.length)} ${cause.ports.length === 1 ? "port is" : "ports are"} dropping packets`
      + `${cause.perHour?.length ? ` over ${cause.perHour.length} h of record` : ""}.`
    : lead ? lead.e.text : cause.subtitle;
  /* the devices the lead was recorded on, which used to travel with the line in the list */
  const leadOn = lead?.devices ?? [];
  /* what it costs, counted and never estimated; a zero is an answer and says so */
  const cost = [
    /* the estate's own total is not in this component, so the count stands alone rather
       than inventing a denominator */
    `${fmtInt(cause.impact.sites)} site${cause.impact.sites === 1 ? "" : "s"}`,
    cause.impact.offline ? `${fmtInt(cause.impact.offline)} offline` : "none offline",
    cause.impact.sessionsLost ? `${fmtInt(cause.impact.sessionsLost)} sessions/h lost` : "no session loss measured against it",
    cause.since ? `since ${cause.since.slice(11, 16)} UTC` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="lm-detail">
      {/**
        * The answer first, the evidence under it.
        *
        * Opening a cause used to fly the camera and then hand the reader a column that began
        * with raw lines from the devices and ended, far below the fold, with what the record
        * can actually tell apart. A reader who clicks a fault is asking what it is and what
        * to do, and both were computed already — they were just last.
        */}
      <div className="lm-lead">
        <b>{summary}</b>
        {leadOn.length > 0 && (
          <span className="lm-lead__on">on {fmtInt(leadOn.length)} {leadOn.length === 1 ? "device" : "devices"} ·{" "}
            <button type="button" className="lm-detail__go" onClick={() => onDevice(leadOn[0])}>{leadOn[0]}</button>
            {leadOn.length > 1 ? ` and ${fmtInt(leadOn.length - 1)} more` : ""}</span>
        )}
        {cost && <span className="lm-lead__cost">{cost}</span>}
      </div>
      {/**
        * What the record separates the ports into, as counts and figures.
        *
        * This was three sentences of reasoning — what a drop with no error and no
        * congestion could mean, and what to read next. That is an explanation, and the
        * panel beside it exists to write explanations from the same facts. The app states
        * what it measured: the group, how many ports are in it, the figures that put them
        * there, and which ports. Assist is handed the same groups.
        */}
      {cause.ports && cause.ports.length > 0 && (() => {
        const groups = discardGroups(cause.ports);
        if (!groups.length) return null;
        return (
          <>
            <div className="lm-detail__h">What the record separates</div>
            <table className="lm-detail__t lm-cases">
              <thead><tr><th>Group</th><th className="n">Ports</th><th>Figures</th><th>Which</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.kind}>
                    <td>{g.label}</td>
                    <td className="n">{fmtInt(g.rows.length)}</td>
                    <td className="lm-cases__fig">{g.figures.join(" · ")}</td>
                    <td className="lm-cases__which">{g.rows.slice(0, 3).map((r) => `${r.iface} ${r.device.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "")}`).join(", ")}
                      {g.rows.length > 3 ? ` +${g.rows.length - 3}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        );
      })()}
      {/**
        * Which addresses the ping gets nothing back from.
        *
        * An alert raised on a network availability monitor names the monitor, and the panel
        * used to pass that on as "the monitor that pings this device is out". Measured: the
        * monitor of P-1234567 sent twenty-four packets to each of its targets in the last
        * interval and a hundred and thirty-nine answered. Nothing was out. What is true is
        * that CORE-001 answers on one of the four addresses pinged at it, and the other three
        * are the ones somebody has to act on.
        *
        * This was a table of address, device, sent, received and since. Five columns in a
        * panel three hundred and forty pixels wide clipped every row, and the four readings
        * beside each address said one thing between them: nothing comes back. So it is the
        * count and the addresses, in the same chips the devices above already use, and the
        * sentence that joins them is Assist's to write.
        */}
      {(() => {
        /* one entry per address, not per monitor: the same address is pinged by more than one
           monitoring configuration, and two identical readings of it are noise */
        const by = new Map<string, { device: string; recv: number }>();
        cause.devices.forEach((d) => (d.icmpTargets ?? []).forEach((t) => {
          const had = by.get(t.ip);
          if (!had || (had.recv > 0 && t.recv === 0)) by.set(t.ip, { device: d.name, recv: t.recv });
        }));
        const silent = [...by].filter(([, v]) => v.recv === 0).map(([ip]) => ip).sort();
        if (!silent.length) return null;
        return (
          <>
            <div className="lm-detail__h">{fmtInt(silent.length)} of {fmtInt(by.size)} pinged
              address{by.size === 1 ? "" : "es"} answer nothing</div>
            <div className="lm-detail__els">
              {silent.slice(0, SHOW).map((ip) => (
                <span key={ip} className="lm-detail__el lm-ping__ip">{ip}</span>
              ))}
              {silent.length > SHOW && <span className="lm-detail__more">and {fmtInt(silent.length - SHOW)} more</span>}
            </div>
          </>
        );
      })()}
      {rest.length > 0 && (
        <>
          <div className="lm-detail__h">What it reported</div>
          {/* The dot is a severity and the middle column is where the line came from, neither of
              which the rows said out loud: the first was colour alone, which is no answer to a
              reader who cannot see it, and the second looked like part of the sentence. */}
          <ul className="lm-detail__ev">
            <li className="lm-detail__evhead" role="row">
              <span aria-hidden="true" /><span>Source</span><span>What it reported</span>
            </li>
            {rest.slice(0, 8).map(({ e, devices }) => (
              <li key={e.id}>
                <i style={{ background: MAP_COLORS[e.level] }} aria-hidden="true" />
                <span className="lm-detail__src"><span className="vz-sr">{e.level}. </span>{srcLabel(e.source)}</span>
                <span>
                  <span className="lm-detail__txt">{e.text}</span>
                  {devices.length === 1 && (
                    <button type="button" className="lm-detail__go" onClick={() => onDevice(devices[0])}
                      title={`Open ${devices[0]}`}>{devices[0]}</button>
                  )}
                  {devices.length > 1 && (
                    <small className="lm-detail__on">{`on ${devices.length} devices · `}
                      <button type="button" onClick={() => onDevice(devices[0])} title={`Open ${devices[0]}`}>{devices[0]}</button>
                      {` and ${devices.length - 1} more`}</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* The rate, drawn: a count of ports cannot say whether this is getting worse or when it
          started, and the hours are already summed across every port the platform named. */}
      {cause.perHour && cause.perHour.length > 2 && (() => {
        const h = cause.perHour!;
        const top = Math.max(...h, 1);
        const W = 240, H = 26, step = W / h.length;
        return (
          <>
            <div className="lm-detail__h">Discards per hour · {h.length} h of record</div>
            <svg className="lm-detail__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
              role="img" aria-label={`discards per hour, peaking at ${Math.round(top).toLocaleString("en-US")}`}>
              {h.map((v, k) => {
                const bar = Math.max(v > 0 ? 1 : 0, (v / top) * H);
                return <rect key={k} x={k * step} y={H - bar} width={Math.max(0.6, step - 0.4)} height={bar}
                  fill="var(--lm-series)" opacity={0.85} />;
              })}
            </svg>
          </>
        );
      })()}
      {cause.ports && cause.ports.length > 0 && (
        <>
          <div className="lm-detail__h">{fmtInt(cause.ports.length)} {cause.ports.length === 1 ? "port" : "ports"},
            {" "}what each one shows</div>
          <table className="lm-detail__t">
            <thead><tr><th>Port</th><th>Device</th><th>What Dynatrace saw</th><th className="n">Discards</th><th className="n">Busiest</th></tr></thead>
            <tbody>
              {cause.ports.slice(0, 8).map((r) => (
                <tr key={`${r.device}|${r.iface}`}>
                  <td>{r.iface}</td>
                  <td><button type="button" className="lm-detail__go" onClick={() => onDevice(r.device)}>{r.device.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "")}</button></td>
                  <td className="lm-detail__saw">{r.novelty.text.toLowerCase()}
                    <em>{Math.round(r.novelty.score * 100)}%</em></td>
                  {/* a dash is this app saying it has no record of that port, which is not the
                      same as the port showing nothing */}
                  <td className="n">{r.total == null ? "—" : fmtInt(r.total)}</td>
                  <td className="n">{r.busy == null ? "—" : `${Math.round(r.busy)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(devices.length > 0 || circuits.length > 0) && (
        <>
          <div className="lm-detail__h">
            {devices.length > 0 && `${fmtInt(devices.length)} ${devices.length === 1 ? "device" : "devices"}`}
            {devices.length > 0 && circuits.length > 0 ? " and " : ""}
            {circuits.length > 0 && `${fmtInt(circuits.length)} ${circuits.length === 1 ? "link" : "links"}`}
            {" "}it is on
          </div>
          <div className="lm-detail__els">
            {devices.slice(0, SHOW).map((e) => (
              <button type="button" key={e.id} className="lm-detail__el" onClick={() => onDevice(e.id)}
                title={`${e.id} · ${e.verdict}`}>
                <i style={{ background: MAP_COLORS[e.verdict] }} aria-hidden="true" />{e.label}
              </button>
            ))}
            {circuits.slice(0, SHOW).map((e) => (
              <span key={e.id} className="lm-detail__el is-link">
                <i style={{ background: MAP_COLORS[e.verdict] }} aria-hidden="true" />{e.label}
              </span>
            ))}
            {devices.length + circuits.length > SHOW && (
              <span className="lm-detail__more">and {fmtInt(devices.length + circuits.length - SHOW)} more</span>
            )}
          </div>
        </>
      )}
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
        {/* an estate of thousands puts four digits where two were drawn: both lines are sized to the room */}
        <text x={60} y={58} textAnchor="middle" fontSize={fitInCircle(String(bad), R - 6, 24)} fontWeight={700} fill="var(--lm-ink)">{bad}</text>
        <text x={60} y={76} textAnchor="middle" fontSize={fitInCircle(`of ${fmtInt(infos.length)}`, R - 6, 12)} fill="var(--lm-muted)">of {fmtInt(infos.length)}</text>
      </svg>
      <div className="lm-regions">
        <div className="lm-region lm-region--head" role="row" aria-hidden="true">
          <span>Region</span><span>Sites by status</span><b>Bad</b>
        </div>
        {regions.map(({ r, list }) => (
          <button key={r} type="button" className="lm-region" onClick={() => onRegion?.(r)} disabled={!onRegion}
            aria-label={`${r}: ${list.filter((i) => isBad(i.verdict)).length} of ${list.length} sites with issues`}>
            {/* the column is narrower than "Rio Grande do Sul", and an ellipsis with nothing
                behind it is a name the reader cannot read */}
            <span className="lm-region__name" title={r}>{r}</span>
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
