// The way out of a number.
//
// Every mark on this dashboard is an aggregate, and until now the aggregate was the end of the
// road: a cell said 38 and there was nothing to click. This panel is what a pick opens — the
// measured record behind the number, the line it is carried forward on, and the ports it was
// computed from, each of which leads to its device.
//
// It draws the same three marks as the chart above it, in the same colours, because a reader who
// has just learned to read one chart should not have to learn a second.
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { TimeseriesAnnotations, TimeseriesChart } from "@dynatrace/strato-components/charts";
import { useTokens } from "../../hooks/useToken";
import { ROLE_LABEL } from "../../model/site";
import { RowChart, bits, subjectName } from "./RowChart";
import { horizonFor, portKey, usePortsForecast } from "../../hooks/useDavisForecast";
import { useNf, useSel } from "./source";
import RoomList from "./RoomList";
import { useRoom } from "./room";
import { useDetailsSlot } from "../DetailsSlot";
import type { Subject } from "../../model/ahead";

const ROOM_TITLE = { port: "Port traffic", cpu: "CPU", mem: "Memory" } as const;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** A heat column is written `+6d` and the shared axis writes `+6 d`; they name the same day. */
const sameDay = (col: string, label: string) => col.replace(/\s+/g, "") === label.replace(/\s+/g, "");

function busyOf(s: Subject): number {
  return s.room?.busy ?? s.reading.now;
}

/**
 * A row does two different things, so it is two controls.
 *
 * It used to be one button that left for the device — and the chart above it kept showing the
 * aggregate of every port in the set, which is the one thing a reader clicking a single row is
 * not asking about. The row now focuses the chart on that port; the chevron still leaves.
 *
 * A device and a port are not the same row.
 *
 * Both were drawn with the port's four cells, so a device showed an empty second cell — its
 * `sub` is the software banner — and then said its room twice: a processor's room is a hundred
 * less its CPU busy hour, so "27% of its limit" and "73 points left" are one number printed as
 * two. A device's second number is the one the page never showed: memory in use, which its
 * extension reports and which no port has.
 */
function Port({ s, onDevice, onLeave, onFocus, focused }: {
  s: Subject; onDevice: (n: string) => void; onLeave: () => void;
  onFocus: () => void; focused: boolean;
}) {
  const room = s.room;
  const tone = s.reading.state === "dropping" ? "bad" : room && room.pts < 15 ? "warn" : "ok";
  const dev = s.device?.name;
  const isDev = s.kind !== "port";
  const isMem = s.kind === "memory";
  const mem = s.device?.memNow;
  return (
    <div className={`nfd-port${focused ? " is-on" : ""}`}>
      <button type="button" className="nfd-port-main" aria-pressed={focused} onClick={onFocus}
        title={focused ? "Show every port and processor in the set again" : `Draw only ${s.name}`}>
        <span className="nfd-port-n">{s.name}</span>
        {/* A port's second cell is the device it sits on. A device's is what kind of device it
            is, which is what a reader scanning a site's hardware is reading for. */}
        <span className="nfd-port-s">{isDev
          ? [ROLE_LABEL[s.device?.role ?? ""] ?? s.device?.role, s.device?.vendor].filter(Boolean).join(" · ")
          : s.sub}</span>
        <span className="nfd-port-v">{r1(busyOf(s))}%<small>{isMem ? "memory busy hour, of all it has"
          : isDev ? "CPU busy hour, of its limit" : "busy hour, of its limit"}</small></span>
        {isDev
          ? <span className="nfd-port-v">{isMem
              ? (s.room ? `${r1(s.room.pts)} points` : "—")
              : mem != null ? `${Math.round(mem)}%` : "—"}
              <small>{isMem ? "left before it is full"
                : mem != null ? "memory in use" : "memory not reported"}</small></span>
          : <span className="nfd-port-v">{room ? `${r1(room.pts)} points` : "—"}
              <small>{room ? (room.source === "shown" ? "left below the ceiling it showed" : "left of its stated limit") : "no limit published"}</small></span>}
        <span className={`nfd-port-t ${tone}`}>{s.reading.state}</span>
      </button>
      {dev
        ? <button type="button" className="nfd-port-go" onClick={() => { onDevice(dev); onLeave(); }}
            title={`Open ${dev}`} aria-label={`Open ${dev}`}>›</button>
        : <span className="nfd-port-go" />}
    </div>
  );
}

/**
 * Where the detail goes, and the one thing it has to do to look like itself there.
 *
 * PageLayout's fourth region is the platform's answer to this exact question — additional
 * information about what the main view is showing, without leaving the page — and the app
 * already uses it for every entity it selects. This panel used to be a Modal, which was a
 * second answer to the same question and the only place in the app that gave it. It now
 * renders into the region, through the slot App lends out.
 *
 * The region is a portal to a node outside `.ahead`, and every rule this page owns is scoped
 * under that class, so the wrapper puts the cascade back: `.ahead` for the page's rules, `.nf`
 * for the dashboard's palette, which is where --obs, --cap and the rest are declared.
 */
function Shell({ host, title, children }: { host: HTMLElement; title: string; children: React.ReactNode }) {
  return createPortal(
    <div className="lm vz ahead"><div className="nf"><div className="nfd">
      <h2 className="nfd-title">{title}</h2>
      {children}
    </div></div></div>,
    host,
  );
}

export default function NfDetail() {
  const { CAPACITY_GBPS, resolve, seriesOf, SCENARIOS, askFor, histFor, ownLineFor, ALL } = useNf();
  const { pick, setPick, onDevice } = useSel();
  const [focus, setFocus] = useState<string | null>(null);
  /* canvas: every colour handed to a chart has to be a literal, and read off a node inside
     the panel — these live on `.ahead .nf`, so a read against :root comes back empty */
  const [ink, inkRef] = useTokens({ "--obs": "#00afbe", "--fc": "#9f81ff", "--cap": "#c82d40" });
  // a new pick is a new set; a focus held from the last one would name a port that is not in it
  const [of, setOf] = useState<string | null>(null);
  // A pick the data cannot resolve opens nothing, so the region is only claimed once there is
  // something to put in it — never as an empty panel that the reader then has to close.
  const d = pick ? resolve(pick) : null;
  /**
   * A subject picked from the ranking is drawn the way the ranking drew it.
   *
   * The panel's own chart is a daily aggregate carried forward on this app's fitted line —
   * right for a set of ports, wrong for the one subject a reader just picked out of a list
   * whose sparkline came from the platform. Same series, same ceiling, same forecast: the
   * row magnified, not a second opinion.
   */
  const sc = pick?.kind === "scenario" ? SCENARIOS.find((x) => x.key === pick.key) : undefined;
  const oneAsk = sc ? askFor(sc.key).ask : null;
  const { data: oneFc } = usePortsForecast(oneAsk ? [oneAsk] : []);
  /**
   * A comb cell opens the list of its kind, and that is the whole panel.
   *
   * It is read before `resolve`, because `resolve` answers null for this pick on purpose: a
   * population measured against four hundred different limits has no aggregate to draw, so
   * there is no set to resolve and nothing for the chart below to be about.
   */
  const room = useRoom(ALL);
  const isRoom = pick?.kind === "room";
  const host = useDetailsSlot(d != null || isRoom, () => setPick(null));
  const pickKey = JSON.stringify(pick);
  /* A set that cannot be summed honestly names the member to open on — the tightest port of a
     device, say — so the panel still opens on a real series instead of an empty frame. "Show
     all" then clears it, and clearing it means all. */
  if (of !== pickKey) { setOf(pickKey); setFocus(d?.defaultFocus ?? null); }
  if (isRoom && host && pick?.kind === "room") {
    return (
      <Shell host={host} title={ROOM_TITLE[pick.of]}>
        <RoomList of={pick.of} cells={room.cells[pick.of]} focus={pick.key} />
      </Shell>
    );
  }
  if (!d || !host) return null;

  // An empty set has no series and no ports; its answer is the sentence resolve() gave it.
  if (!d.members.length) {
    return (
      <Shell host={host} title={sc ? subjectName(d.title, sc.kind) : d.title}>
        <div className="nfd-empty">{d.gist}</div>
      </Shell>
    );
  }

  // Focused, the chart is that one port's own record and its own line — measured by the same
  // function that produced the set's, so the two are the same reading at different widths.
  const one = focus ? d.members.find((m) => m.key === focus) : null;
  /* The set has no honest aggregate, but one of its members always does: focusing a row is
     exactly how a reader gets a line out of a set that cannot be summed. */
  const noLine = one ? undefined : d.noLine;
  const a = one ? seriesOf([one]) : d;
  const { labels, days } = a;
  const obs = a.obs, rise = one ? a.rise : d.rise;
  const last = obs[obs.length - 1] ?? 0;
  // the band widens with distance exactly as it does on the chart above: this is the same rise,
  // and the same honest statement that a line far out is a wider claim than a line near in
  const spread = Math.abs(rise) * 0.35;
  const data = labels.map((label, i) => {
    if (i < days - 1) return { label, observed: obs[i], forecast: null, band: null };
    const k = i - (days - 1);
    const f = last + rise * k;
    return {
      label,
      observed: i === days - 1 ? last : null,
      forecast: r1(f),
      band: k === 0 ? null : [r1(Math.max(0, f - spread * k)), r1(f + spread * k)] as [number, number],
    };
  });

  /**
   * The frame is the data's, and the limit is drawn only when it is in it.
   *
   * Forcing a hundred into the domain is what the card above does, and there it is right: that
   * chart is about one port whose busy hour reaches a quarter of its limit, so the ceiling and
   * the line share a frame. A site's ports in aggregate run at two per cent of what they publish,
   * and the same rule flattened the whole record onto the axis — thirteen days of movement drawn
   * as one straight line at the bottom of an empty box. So the axis fits what was measured, and
   * where the limit is off that scale the note says so instead of the chart pretending to show it.
   */
  /**
   * Days as instants, which is also what removed the zoom hook.
   *
   * This chart plotted day *labels* — a categorical axis, which recharts gives no domain to
   * narrow, so zooming meant catching pixel positions and slicing the array by index: the same
   * gesture as the other two charts through entirely different mechanics. Index `i` was always
   * `i - (days - 1)` days from today, so the labels were a date all along; stated as one, the
   * axis is a time axis and `TimeseriesChart.Zoom` is the gesture.
   */
  const vals = data.flatMap((p) => [p.observed, p.forecast, p.band?.[1]].filter((n): n is number => n != null));
  const top = Math.max(...vals);
  const inFrame = CAPACITY_GBPS <= top * 1.6;
  const hi = (inFrame ? Math.max(CAPACITY_GBPS, top) : top) * 1.12;
  const lo = Math.max(0, Math.min(...vals) * 0.85);
  const marked = d.mark ? labels.findIndex((l) => sameDay(d.mark!, l)) : -1;
  /* one point per day, each stating the day it covers, counted from today at index days-1 */
  const DAY = 86400_000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  const dayAt = (i: number) => {
    const t = midnight + (i - (days - 1)) * DAY;
    return { start: new Date(t), end: new Date(t + DAY) };
  };
  /**
   * A site is hardware and wiring, and the panel listed them as one run of rows.
   *
   * Drilling into a site — a branch or a data centre — the reader is asking two questions, and
   * they have different answers: how hard the devices are working, and how full the ports are.
   * Mixed into one list ordered by room, a switch at 27% sat between two ports at 26% and 28%
   * with nothing saying they were different kinds of thing. The groups are only drawn when the
   * set actually holds both, so a single port's panel keeps the one list it always had.
   */
  const byRoom = (a: Subject, b: Subject) => (a.room?.pts ?? 1e9) - (b.room?.pts ?? 1e9);
  const devices = d.members.filter((m) => m.kind !== "port").sort(byRoom);
  const ports = d.members.filter((m) => m.kind === "port").sort(byRoom);
  const grouped = devices.length > 0 && ports.length > 0;
  const groups = grouped
    ? [{ key: "dev", label: "Devices", hint: "CPU busy hour and memory in use, hardest working first", rows: devices },
       { key: "port", label: "Ports", hint: "busy hour and the room left, tightest first", rows: ports }]
    : [{ key: "all", label: "", hint: "", rows: d.members.slice().sort(byRoom) }];
  const unrated = d.members.length - d.rated.length;

  return (
    <Shell host={host} title={d.title}>
      <div className="nfd-head" ref={inkRef}>
        {/* the "Whole record" chip stood here to undo a zoom this component kept itself.
            `TimeseriesChart.Zoom` owns the gesture and its own reset. */}
        {/* A site holds processors as well as ports — on LEM, 31 of 58 members publish no line
            rate at all — so "the line rate these ports publish" was wrong for most of them.
            It only says that where every member is in fact a rated port. */}
        {!noLine && <span className="card-unit">{d.members.every((m) => m.kind === "port")
          ? d.members.length === 1
            ? "per cent of the line rate this port publishes"
            : "per cent of the line rate these ports publish"
          : "per cent of each one's own limit — a port's line rate, a processor's saturation"}</span>}
        <span className="nfd-gist">{d.gist}</span>
      </div>
      {one && (
        <div className="nfd-focus">
          Drawing <b>{one.name}</b> alone, of {d.members.length} in this set.
          <button type="button" className="chip" onClick={() => setFocus(null)}>Show all {d.members.length}</button>
        </div>
      )}
      {sc && (() => {
        const hist = histFor(sc.key);
        const fc = oneAsk ? oneFc.get(portKey(oneAsk)) : undefined;
        const fwd = fc ?? ownLineFor(sc.key, Math.max(24, horizonFor(hist.length)));
        const top = sc.ceiling ?? CAPACITY_GBPS;
        const busy = sc.busy ?? sc.start ?? 0;
        const move = fc?.point.length ? fc.point[fc.point.length - 1] - busy : (sc.move ?? 0);
        const crossIdx = fwd ? fwd.point.findIndex((v) => v >= top) : -1;
        const crossing = crossIdx >= 0 ? `+${Math.max(1, Math.round((crossIdx + 1) / 24))} d` : null;
        return (
          <>
            <div className="runway-facts">
              <span><b>{r1(busy)}%</b>busy hour{sc.speed ? ` · ${bits(busy * sc.speed / 100)} of ${bits(sc.speed)}` : ""}</span>
              <span><b>{r1(sc.room ?? 0)} pts</b>room left</span>
              <span><b>{Math.abs(move) < 0.05 ? "flat" : `${move > 0 ? "+" : "−"}${Math.abs(r1(move))} pts`}</b>
                by the horizon{sc.firm || Math.abs(move) < 0.05 ? "" : ", inside its noise"}</span>
              <span className={crossing ? "is-over" : ""}><b>{crossing ?? "—"}</b>
                {crossing ? "the forecast meets the ceiling" : "the forecast stays below it"}</span>
              {sc.dropsAt != null && (
                <span className="is-over"><b>{r1(sc.dropsAt)}%</b>
                  where it drops packets{sc.speed ? ` · ${bits(sc.dropsAt * sc.speed / 100)}` : ""} — a fault, not its capacity</span>
              )}
            </div>
            <RowChart hist={hist} fwd={fwd} ceiling={top} cap={CAPACITY_GBPS} speed={sc.speed} />
          </>
        );
      })()}
      {/* A set whose aggregate would be a number about nothing says so, and shows its parts.
          The reader arrived here from a chart in gigabits per second; a second chart in per
          cent of a capacity nobody carries, falling where the first one rose, answered their
          click with a contradiction. */}
      {noLine && <div className="nfd-empty">{noLine}</div>}
      {!noLine && !sc && <>
      {inFrame && (
        <div className="legend">
          <span><i className="sw" style={{ background: "var(--cap)" }} />The limit its owner stated · {CAPACITY_GBPS}%</span>
        </div>
      )}
      <TimeseriesChart data={[]} height={240} curve="linear" pointsDisplay="never" gapPolicy="connect">
        <TimeseriesChart.YAxis min={r1(lo)} max={r1(hi)} formatter={(v: number) => `${v}%`} />
        <TimeseriesChart.Legend position="bottom" />
        <TimeseriesChart.Tooltip variant="shared" />
        <TimeseriesChart.Zoom />
        {inFrame && (
          <TimeseriesChart.ThresholdIndicator data={{ value: CAPACITY_GBPS }} color={ink["--cap"]}
            label="the limit its owner stated" />
        )}
        {/* each series is its own child of the chart: it collects them with `Children.forEach`,
            which walks arrays but not fragments, and a fragment arrives as one unknown child */}
        <TimeseriesChart.Band color={ink["--fc"]} data={{
          name: "Where the line could be", unit: "%",
          datapoints: data.flatMap((p, i) => (p.band
            ? [{ ...dayAt(i), y0: p.band[0], y1: p.band[1] }] : [])),
        }} />
        <TimeseriesChart.Line color={ink["--obs"]} data={{
          name: "Measured, one busy hour a day", unit: "%",
          datapoints: data.flatMap((p, i) => (p.observed != null
            ? [{ ...dayAt(i), value: r1(p.observed) }] : [])),
        }} />
        <TimeseriesChart.Line color={ink["--fc"]} data={{
          name: "Carried forward on its own line", unit: "%",
          datapoints: data.flatMap((p, i) => (p.forecast != null
            ? [{ ...dayAt(i), value: p.forecast }] : [])),
        }} />
        {/* the day the reader picked, marked on the axis it belongs to */}
        {marked >= 0 && (
          <TimeseriesChart.Annotations>
            <TimeseriesAnnotations.Track>
              <TimeseriesAnnotations.Marker title="the day you picked"
                start={dayAt(marked).start} end={dayAt(marked).end} />
            </TimeseriesAnnotations.Track>
          </TimeseriesChart.Annotations>
        )}
      </TimeseriesChart>
      </>}
      <div className="nfd-ports">
        {groups.map((g) => (
          <React.Fragment key={g.key}>
            {grouped && (
              <div className="nfd-group">{g.label}<span>{g.rows.length}</span><small>{g.hint}</small></div>
            )}
            {g.rows.map((s) => <Port key={s.key} s={s} onDevice={onDevice} onLeave={() => setPick(null)}
              focused={focus === s.key} onFocus={() => setFocus(focus === s.key ? null : s.key)} />)}
          </React.Fragment>
        ))}
      </div>
      <div className="note">
        {noLine
          ? `${d.members.length} in this set, the one with the least room first. ${d.rated.length} of them publish a line rate; the rest are processors and ports that publish none.`
          : one
          ? `Drawing one of ${d.members.length}: ${one.name} on ${one.device?.name ?? one.sub}.`
          : d.members.length === 1
          ? "One port, its own line rate, its own record."
          : d.rated.length === d.members.length
          ? `All ${d.members.length} publish a line rate, so all of them are in the line.`
          : `${d.rated.length} of ${d.members.length} publish a line rate; the line is those ${d.rated.length}${unrated === 1 ? ", and one port is listed but not drawn" : `, and ${unrated} are listed but not drawn`}.`}
        {noLine || inFrame ? "" : ` The limit is ${CAPACITY_GBPS}% and this frame stops at ${r1(hi)}%, so it is not drawn — the room each port has left is in its own row.`}
        {" "}Pick a row to draw that one alone; the chevron opens the device{grouped ? "" : " it sits on"}.
      </div>
    </Shell>
  );
}
