// One subject's record at full height: measured, carried forward by the platform, against the
// ceiling it is actually measured against.
//
// It was a card of its own drawing five subjects the ranking already listed, then a block
// folded into the row, then a column beside the list. All three were places this app invented
// for a detail view while the platform documents one and the rest of the app uses it. It is a
// component now, and it is drawn where every other detail in this app is drawn.
import React, { useMemo } from "react";
import { TimeseriesChart } from "@dynatrace/strato-components/charts";
import { useTokens } from "../../hooks/useToken";

const HOUR = 3600_000;

const r1 = (v: number) => Math.round(v * 10) / 10;
/** Mb/s written the way a network engineer reads it */
/**
 * A reading's name says what is being read.
 *
 * A port carries its own name and its line rate; a processor and a memory are named after the
 * device they sit in, so a row read "BR-BA-LEM1-SWI-001 · 11 points of room" and nothing said
 * whether those points were traffic, CPU or memory. The kind goes first where the name does
 * not already carry it.
 */
export const subjectName = (label: string, kind?: "port" | "device" | "memory") =>
  (kind === "device" ? `CPU · ${label}` : kind === "memory" ? `Memory · ${label}` : label);

export const bits = (mbps: number) => (mbps >= 1000 ? `${r1(mbps / 1000)} Gb/s` : `${r1(mbps)} Mb/s`);

export /**
 * The row, opened.
 *
 * The drill-down is here rather than in a second card: a reader who picks a row wants that
 * subject's record at full height, and the card above used to give it to them two hundred
 * pixels away, for five subjects they had not picked. Same framing as the sparkline in the
 * row — the subject's own ceiling — so opening a row magnifies what it already showed.
 */
function RowChart({ hist, fwd, ceiling, cap, speed }: {
  hist: number[]; fwd: { point: number[]; lower: number[]; upper: number[] } | null;
  ceiling: number; cap: number; speed?: number | null;
}) {
  /* canvas: a series handed `var(--obs)` is an invalid fillStyle and is dropped in silence.
     Read off the legend below, because these are declared on `.ahead .nf` rather than :root. */
  const [ink, inkRef] = useTokens({ "--obs": "#00afbe", "--fc": "#9f81ff", "--cap": "#c82d40" });

  /**
   * Hours become instants here.
   *
   * The arrays arrive bare and oldest-first, with the last measured hour being the current one
   * and the forecast starting at the next. Each point states the hour it covers: a datapoint
   * with only a `start` has no duration, so consecutive hours are not contiguous and the chart
   * gaps between them — which draws a fortnight of readings as a field of dots.
   */
  const series = useMemo(() => {
    const end = Math.floor(Date.now() / HOUR) * HOUR;
    const span = (ms: number) => ({ start: new Date(ms), end: new Date(ms + HOUR) });
    const at = (i: number) => span(end - (hist.length - 1 - i) * HOUR);
    const ahead = (i: number) => span(end + (i + 1) * HOUR);
    const measured = hist
      .map((v, i) => ({ ...at(i), value: Number.isFinite(v) ? r1(v) : NaN }))
      .filter((d) => Number.isFinite(d.value));
    const point = fwd ? fwd.point.map((v, i) => ({ ...ahead(i), value: r1(v) })) : [];
    /* the forecast starts from the last measured hour, so the two lines meet rather than
       leaving a one-hour hole the reader reads as a gap in the record */
    const last = measured.at(-1);
    if (last && point.length) point.unshift({ ...span(last.start.getTime()), value: last.value });
    return {
      measured: { name: "Measured, hour by hour", unit: "%", datapoints: measured },
      ahead: { name: "Ahead", unit: "%", datapoints: point },
      band: fwd && {
        name: "Where it could be", unit: "%",
        datapoints: fwd.point.map((_, i) => ({
          ...ahead(i),
          y0: r1(Math.max(0, fwd.lower[i] ?? 0)),
          y1: r1(fwd.upper[i] ?? 0),
        })),
      },
      count: measured.length + point.length,
    };
  }, [hist, fwd]);

  if (series.count < 3) return null;
  return (
    <>
      <div className="legend" ref={inkRef}>
        <span><i className="sw" style={{ background: "var(--cap)" }} />
          {cap === ceiling ? "the limit its owner stated" : "the ceiling it has shown"}
          {" · "}{r1(ceiling)}%{speed ? ` · ${bits(ceiling * speed / 100)}` : ""}</span>
      </div>
      <TimeseriesChart data={[]} height={210} curve="linear" pointsDisplay="never" gapPolicy="connect">
        <TimeseriesChart.YAxis min={0} formatter={(v: number) => `${v}%`} />
        <TimeseriesChart.Legend position="bottom" />
        <TimeseriesChart.Tooltip variant="shared" />
        {/* the ceiling is a value on the Y axis, which is exactly what a threshold indicator
            draws — the hand-made version was a dashed `ReferenceLine` with its own legend swatch */}
        <TimeseriesChart.ThresholdIndicator data={{ value: r1(ceiling) }} color={ink["--cap"]}
          label={cap === ceiling ? "stated limit" : "ceiling it has shown"} />
        {/* each slot is its own child: the chart collects its series with `Children.forEach`,
            which walks arrays but not fragments */}
        {series.band && <TimeseriesChart.Band data={series.band} color={ink["--fc"]} />}
        <TimeseriesChart.Line data={series.measured} color={ink["--obs"]} />
        {series.ahead.datapoints.length > 0 && (
          <TimeseriesChart.Line data={series.ahead} color={ink["--fc"]} />
        )}
      </TimeseriesChart>
    </>
  );
}
