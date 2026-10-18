// The whole network's demand, hour by hour, forecast by Dynatrace.
//
// This is the only forecast on the page that is never empty, because it is the only quantity
// here with no stated limit to be far from: absolute traffic. Every other reading measures a
// subject against a ceiling its owner published, and on this estate nothing is near one.
//
// Drawn by Strato's `TimeseriesChart`. It was a Recharts `ComposedChart` with a hand-rolled
// drag-zoom, a hand-rolled legend and a hand-styled tooltip — about seventy lines of chart
// plumbing to draw a line, a dashed line and a band, which is the shape the platform's own
// component is for. `.Band` is the confidence band, `.Zoom` replaces the drag, and the
// vertical rule at the join is a `.ThresholdIndicator`, so "where the record stops and the
// forecast starts" is marked rather than inferred from the colour change.
import React, { useMemo, useRef } from "react";
import { TimeseriesChart } from "@dynatrace/strato-components/charts";
import { useNetworkDemand } from "../../hooks/useDavisForecast";
import { useTokens } from "../../hooks/useToken";
import { samePick, useSel } from "./source";

/** bits per second at the scale a network engineer reads */
const gbps = (v: number) => Math.round((v / 1e9) * 100) / 100;
const HOUR = 3600_000;

/** a drag that ends inside this many pixels was a click, and a click selects */
const SLOP = 4;

export default function NetworkDemand({ families, hours, ready }: {
  families: string[]; hours: number; ready: boolean;
}) {
  /**
   * Nothing is asked until every hourly read has landed.
   *
   * The model fills in as queries arrive, so for the first few seconds `families` holds one
   * extension and the record holds a handful of interfaces. The forecast asked for that was
   * not wrong — it was a true answer about a fraction of the estate, drawn on an axis topping
   * out at 0.03 Gb/s, and it replaced itself with the real one a moment later. A chart that
   * corrects itself in front of the reader has already told them something false.
   */
  const { data, loading, error } = useNetworkDemand(ready ? families : [], hours);
  /* canvas, so these have to be literals rather than the var() the rest of the app passes —
     and read off the card, because `--obs` and `--fc` are declared on `.ahead .nf`, not on
     :root, where the read would come back empty and leave the dark-theme hard-coded values */
  const [ink, inkRef] = useTokens({ "--obs": "#00afbe", "--fc": "#9f81ff" });
  /**
   * The largest chart on the page, and the last one a click did nothing on.
   *
   * It has no narrower subject of its own — it is the whole network — so it opens the whole
   * set: every port and processor the record covers, tightest first, in the panel every other
   * mark here opens. The sites it divides into are the card directly below.
   */
  const { pick, setPick } = useSel();
  const whole = { kind: "kpi" as const, id: "all" };
  /* the chart owns the drag now, so the click has to say it was not one */
  const down = useRef<{ x: number; y: number } | null>(null);

  /**
   * Hours are turned into instants here, and nowhere upstream.
   *
   * The analyzer is asked for a record ending now with `forecastOffset: 1`, so the last
   * measured hour is the current one and the first forecast hour is the next. That is the
   * whole clock this chart needs, and it is reconstructed rather than carried because the
   * series arrive as bare arrays, oldest first.
   */
  const series = useMemo(() => {
    if (!data) return null;
    const end = Math.floor(Date.now() / HOUR) * HOUR;
    const hist = data.history, pt = data.point;
    const at = (i: number) => new Date(end - (hist.length - 1 - i) * HOUR);
    const ahead = (i: number) => new Date(end + (i + 1) * HOUR);
    /* Every datapoint states the hour it covers, and that is not decoration: a point with only
       a `start` has no duration, so consecutive hours are not contiguous and the chart gaps
       between them — a fortnight of hourly readings came out as a scatter of three hundred and
       thirty-six dots instead of a line. */
    const span = (d: Date) => ({ start: d, end: new Date(d.getTime() + HOUR) });
    return {
      measured: { name: "Measured, every hour", unit: "Gb/s",
        datapoints: hist.map((v, i) => ({ ...span(at(i)), value: gbps(v) })) },
      forecast: { name: "Dynatrace forecast", unit: "Gb/s",
        datapoints: pt.map((v, i) => ({ ...span(ahead(i)), value: gbps(v) })) },
      band: { name: "Where it could be", unit: "Gb/s",
        datapoints: pt.map((_, i) => ({ ...span(ahead(i)),
          y0: gbps(data.lower[i] ?? 0), y1: gbps(data.upper[i] ?? 0) })) },
      peak: pt.length ? gbps(Math.max(...pt)) : 0,
      last: hist.length ? gbps(hist[hist.length - 1]) : 0,
    };
  }, [data]);

  if (!ready) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-title">Traffic · the whole network</span>
          <span className="card-unit">waiting for every port&rsquo;s hourly record before asking</span>
        </div>
        <div className="nfd-empty">The estate forecast is drawn once, from the whole record — not from
          whichever part of it has arrived.</div>
      </div>
    );
  }
  if (!data && !loading && !error) return null;

  return (
    <div className="card" ref={inkRef}>
      <div className="card-head">
        <span className="card-title">Traffic · the whole network</span>
        <span className="card-unit">gigabits per second, hour by hour, every polled port
          {data ? " · forecast by Dynatrace" : loading ? " · asking Dynatrace…" : " · unavailable"}</span>
      </div>
      {error && <div className="nfd-empty">No estate forecast: {error.slice(0, 160)}</div>}
      {!error && (
        <>
          <div style={{ cursor: "pointer" }}
            onMouseDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
            onMouseUp={(e) => {
              const d = down.current;
              down.current = null;
              if (!d || Math.abs(e.clientX - d.x) > SLOP || Math.abs(e.clientY - d.y) > SLOP) return;
              /**
               * A control of the chart's is not a click on the chart.
               *
               * The drag guard above catches the sweep that makes a selection, but the
               * chart then offers "Zoom to selection" in a button inside this very div —
               * and pressing it is a click that never moves, so the panel opened at the
               * same moment the zoom did. Same for the toolbar, the legend and the reset:
               * they are the chart's own controls, and operating one is not asking for
               * the list of what the chart is made of.
               */
              if ((e.target as Element | null)?.closest?.(
                'button, [role="button"], [data-dt-component="Toolbar"], [class*="legend"], svg a')) return;
              setPick(samePick(pick, whole) ? null : whole);
            }}>
            {/* `pointsDisplay` is "never" on purpose. Left on "auto" the chart decided three
                hundred and thirty-six hourly readings were sparse enough to mark, and drew
                the fortnight as a scatter of dots — a shape that says "samples" where the
                data is a continuous hourly record. */}
            <TimeseriesChart data={[]} height={300} loading={loading && !data} curve="linear"
              pointsDisplay="never" gapPolicy="connect">
              <TimeseriesChart.YAxis formatter={(v: number) => `${v} Gb/s`} />
              <TimeseriesChart.Legend position="bottom" />
              <TimeseriesChart.Tooltip variant="shared" />
              <TimeseriesChart.Zoom />
              {/* Each slot is its own child of the chart, and that is load-bearing: the chart
                  collects its series with `Children.forEach`, which walks arrays but not
                  fragments, so the three of them wrapped in a `<>…</>` reached it as one
                  unrecognised child and the card drew "No data available." over a forecast it
                  had already fetched. */}
              {/* the band first, so the two lines are drawn over it rather than under */}
              {series && <TimeseriesChart.Band data={series.band} color={ink["--fc"]} />}
              {series && <TimeseriesChart.Line data={series.measured} color={ink["--obs"]} />}
              {series && <TimeseriesChart.Line data={series.forecast} color={ink["--fc"]} />}
            </TimeseriesChart>
          </div>
          <div className="note">{series
            ? <><b>{series.last} Gb/s</b> now · peak <b>{series.peak} Gb/s</b> ahead · demand, not saturation</>
            : loading ? "Asking Dynatrace…" : null}</div>
        </>
      )}
    </div>
  );
}
