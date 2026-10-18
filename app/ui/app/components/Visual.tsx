// Shared visual vocabulary of the NetO11y pages (UX Delivery Chain look): tinted tiles
// with corner brackets, KPI tiles, filter chips, the page bar and the visual/table toggle.
import React from "react";
import { Container } from "@dynatrace/strato-components/layouts";
import { GaugeChart } from "@dynatrace/strato-components/charts";
import { useTokens } from "../hooks/useToken";
import { Select } from "@dynatrace/strato-components/forms";
import type { NetworkModel, Verdict } from "../model/types";
import { fmtBps, fmtBytes, hhmm } from "../utils/format";
import { MAP_COLORS } from "./LiveMap";

export const TONE = {
  bad: "var(--lm-bad-fill)", warn: "var(--lm-warn-fill)", good: "var(--lm-good-fill)", neutral: "var(--lm-neutral)",
  accent: "var(--lm-accent)", cyan: "var(--lm-series)", violet: "var(--lm-series-2)",
} as const;

export const verdictTone = (v: Verdict) => MAP_COLORS[v];

/**
 * A tile, which is Strato's `Container` with the page's accent on it.
 *
 * It was a hand-built surface: a `<section>` or a `<button>` carrying `.vz-tile`, a border, a
 * radius, a tint and two corner brackets drawn with `::before` / `::after`. `Container` is
 * that object, and it takes `variant` and `color` — but the accent here is not one of the
 * five status colours the component names, it is whichever tone the caller passes, so the
 * tone stays a custom property the stylesheet reads for the left rail.
 */
/**
 * A tile is a neutral surface, whatever its subject's status.
 *
 * The frame used to be painted from `--c`: a border, a gradient and a glow in whatever tone
 * the caller passed. The first correction handed the three status tones to `Container`'s own
 * `color`, which is the right prop — and still the wrong call, because it rings the box as
 * well as the heading. The status pattern says to show the indicator next to the heading and
 * warns in the same breath that over-communicating status overwhelms the reader and that the
 * number of indicators should be reduced; a healthy device does not need a green box around
 * a green dot. The tone survives as `--c` for marks inside a tile that do carry status.
 */

export function Tile({ tone = TONE.accent, title, right, children, className = "", onClick, active, label }: {
  tone?: string; title?: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode; className?: string;
  onClick?: () => void; active?: boolean; label?: string;
}) {
  const style = { "--c": tone } as React.CSSProperties;
  const body = (
    <>
      {(title || right) && <div className="vz-th"><span>{title}</span>{right != null && <span>{right}</span>}</div>}
      {children}
    </>
  );
  return (
    <Container variant={active ? "emphasized" : "default"} style={style} aria-label={label}
      className={`vz-tile${onClick ? " vz-tile--btn" : ""}${active ? " is-on" : ""} ${className}`}
      {...(onClick
        ? { as: "button" as const, type: "button", onClick, "aria-pressed": active }
        : { as: "section" as const })}>
      {body}
    </Container>
  );
}

export function KpiTile({ tone, label, value, caption, active, onClick }: { tone: string; label: string; value: React.ReactNode; caption?: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <Tile tone={tone} title={label} onClick={onClick} active={active} label={`${label}: ${typeof value === "string" || typeof value === "number" ? value : ""}`}>
      <div className="vz-big">{value}</div>
      {caption && <div className="vz-cap">{caption}</div>}
    </Tile>
  );
}

export interface ChipOption { key: string; label: string; count?: number; tone?: string }

/** A filter holds the keys it accepts, comma separated, so the URL and everything reading it stay strings. */
export const chosen = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);
export const inSet = (value: string | null, key: string | undefined | null) => !value || (key != null && chosen(value).includes(key));
const toggle = (value: string | null, key: string) => {
  const set = chosen(value);
  const next = set.includes(key) ? set.filter((k) => k !== key) : [...set, key];
  return next.length ? next.join(",") : null;
};

/**
 * A filter as a select box: one control whatever the environment holds, several values at a time.
 * A row of chips read as buttons rather than as a filter, and it grew with the estate — four carriers
 * fit on the line, twenty pushed it off the page.
 */
export function Chips({ label, options, value, onChange, variant = "select" }: {
  label: string; options: ChipOption[]; value: string | null; onChange: (key: string | null) => void;
  /** "chips" keeps the pressed buttons, for the three status colours that carry meaning of their own */
  variant?: "select" | "chips";
}) {
  const picked = chosen(value);
  /**
   * The status filter stays ours, and that is a limit of the set rather than a preference.
   *
   * These three carry a colour that means something, and the reader picks several at once.
   * `ToggleButtonGroup` is the platform's multi-button control and it holds a single value;
   * `Select` holds several but shows them as a list of words, which drops the colour. So this
   * one keeps its buttons — a hairline and a swatch, never a tinted fill.
   */
  if (variant === "chips") {
    return (
      <div className="vz-chips" role="group" aria-label={label}>
        <span className="vz-chips__label">{label}</span>
        {options.map((o) => {
          const on = picked.includes(o.key);
          return (
            <button key={o.key} type="button" className={`vz-chip${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => onChange(toggle(value, o.key))}
              style={o.tone ? ({ "--c": o.tone } as React.CSSProperties) : undefined}>
              {o.tone && <i aria-hidden="true" />}{o.label}{o.count != null && <b>{o.count}</b>}
            </button>
          );
        })}
      </div>
    );
  }
  /**
   * Everything else is the platform's multi-select.
   *
   * What this replaces is a `<button>` plus a `role="listbox"` of `role="option"` buttons,
   * with its own open state, its own tick glyphs, its own click-away listener and its own
   * Escape handler — a select, re-implemented. `Select` carries all of that, plus a filter
   * box, which the hand-made one never had and which an estate with twenty carriers needs.
   */
  return (
    <div className="vz-pick">
      <span className="vz-pick__label">{label}</span>
      <Select multiple value={picked} clearable
        onChange={(keys) => onChange(keys?.length ? keys.join(",") : null)}>
        <Select.Trigger placeholder={`All ${label.toLowerCase()}s`} aria-label={label} />
        <Select.Content>
          {options.length > 8 && <Select.Filter />}
          {options.map((o) => (
            <Select.Option key={o.key} value={o.key} textValue={o.label}>
              {o.label}{o.count != null && <b> {o.count}</b>}
            </Select.Option>
          ))}
        </Select.Content>
      </Select>
    </div>
  );
}

export type View = "visual" | "table";

export function PageBar({ model, failed, view, onView, onLive, children }: { model: NetworkModel; failed: string[]; view?: View; onView?: (v: View) => void; onLive?: () => void; children?: React.ReactNode }) {
  return (
    <div className="lm-bar">
      <span className="lm-pill lm-pill--live"><span className="lm-live" aria-hidden="true" />Live {hhmm(model.meta.generatedAt)}</span>
      {children}
      {model.demo && (onLive
        ? <button type="button" className="lm-pill lm-pill--note lm-pill--btn" onClick={onLive}>Example data · back to this environment</button>
        : <span className="lm-pill lm-pill--note">Example data</span>)}
      {!model.demo && failed.length > 0 && <span className="lm-pill lm-pill--note" title={failed.join(", ")}>{failed.length} data source(s) unavailable</span>}
      {view && onView && (
        <span className="vz-seg" role="group" aria-label="View">
          <button type="button" className={view === "visual" ? "is-on" : ""} aria-pressed={view === "visual"} onClick={() => onView("visual")}>Visual</button>
          <button type="button" className={view === "table" ? "is-on" : ""} aria-pressed={view === "table"} onClick={() => onView("table")}>Table</button>
        </span>
      )}
    </div>
  );
}

export function StatusShape({ verdict }: { verdict: Verdict }) {
  return <i role="img" className={`lm-marker lm-marker--${verdict === "Critical" ? "crit" : verdict === "Warning" ? "warn" : "ok"}`} style={{ background: MAP_COLORS[verdict] }} aria-label={verdict} />;
}

/**
 * Ring gauge for a percentage. Green, amber and red are the status of an alert and nothing else, so a
 * reading only wears them when the caller passes the verdict it belongs to; on its own it is drawn in the
 * data colour, however high it is. A ring painted amber by a threshold announced a warning nobody raised,
 * and one painted green called a device well when all it knew was that its CPU was low.
 */
/**
 * The largest font at which a string still fits inside a circle of radius `r`, in SVG user units.
 *
 * A reading drawn at a fixed size spills over its ring as soon as it grows a digit — "206.9 ms" ran
 * clean out of a 44-pixel circle on the end-to-end path. The caller keeps the text short (the unit
 * belongs in the caption, where it has the width of the tile); this keeps what is left inside.
 */
export const fitInCircle = (text: string, r: number, max = 15, min = 9) =>
  Math.max(min, Math.min(max, (2 * r - 10) / (Math.max(1, text.length) * 0.62)));

/**
 * A dial, which is Strato's `GaugeChart`.
 *
 * It was an SVG of two circles, a dash array for the arc and a `<text>` whose size was solved
 * for the ring's inner radius — a gauge, hand-drawn, beside a design system that ships one.
 * The caller's shape is unchanged so nothing else had to move: the same `value | null`, the
 * same label, the same optional verdict.
 *
 * `null` is not nought and does not get an arc. A device that publishes no memory would
 * otherwise read as a device with none in use, which is the opposite claim; it gets the same
 * em dash the table gives it, in the same frame so a row of dials keeps its baseline.
 */
export function Gauge({ value, label, size = 110, verdict }: { value: number | null; label: string; warn?: number; crit?: number; size?: number; verdict?: Verdict }) {
  /* canvas: a colour handed to a chart has to be a literal, never a `var()` */
  const [ink, inkRef] = useTokens({
    "--lm-series": "#00afbe", "--lm-bad-fill": "#c82d40", "--lm-warn-fill": "#d7b43b",
    "--lm-good-fill": "#00bb7b", "--lm-neutral": "#7c7f9e",
  });
  const colourOf: Record<Verdict, string> = {
    Critical: ink["--lm-bad-fill"], Warning: ink["--lm-warn-fill"],
    Healthy: ink["--lm-good-fill"], "Not monitored": ink["--lm-neutral"],
  };
  return (
    <figure className="vz-gauge" ref={inkRef}>
      {value == null ? (
        <div className="vz-gauge__none" style={{ width: size, height: size }}
          role="img" aria-label={`${label} not measured`}>—</div>
      ) : (
        /* Keyed on the colour, because the ring is painted once.
           The token cannot be read until the figure is in the DOM, so the first render
           carries the fallback and the real literal arrives on the next one — and the chart
           kept the first. Measured: the arc stayed `#95c0ff` while `--lm-series` at that
           same element resolved to the theme's own value. A key makes the new colour a new
           chart, which is what it is. */
        <GaugeChart key={verdict ? colourOf[verdict] : ink["--lm-series"]}
          value={Math.max(0, Math.min(100, value))} min={0} max={100} unit="%"
          height={size} width={size} color={verdict ? colourOf[verdict] : ink["--lm-series"]}
          formatter={(v: number) => `${Math.round(v)}%`}>
          {/* the caption stays outside: it has the tile's whole width there, and inside the
              ring it competes with the reading for the same few pixels */}
          <GaugeChart.Label>{""}</GaugeChart.Label>
        </GaugeChart>
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/**
 * Table sparkline. Drawn at the cell's own scale (0-100 % for CPU), so two rows can be compared by eye:
 * a grid line at the half, the band under the curve, the run of the series and a lit head on the last
 * reading with the value beside it. The tone comes from that last reading, never from a verdict.
 */
/**
 * Traffic on a port, in and out, drawn the way a network engineer reads it since MRTG: what comes in
 * above the line, what goes out below it, on one scale so the two sides can be compared by eye. Both
 * series come from the interface counters, so this needs nothing but SNMP.
 */
export function InOut({ inn, out, w = 104, h = 30, stepMs = 300e3, volume = false }: { inn: number[]; out: number[]; w?: number; h?: number; stepMs?: number; volume?: boolean }) {
  const n = Math.max(inn.length, out.length);
  if (n < 2) return <span className="np-muted">—</span>;
  const peak = Math.max(1, ...inn, ...out);
  const mid = h / 2;
  const x = (i: number) => 1 + (i / (n - 1)) * (w - 2);
  const up = (v: number) => mid - (v / peak) * (mid - 2);
  const down = (v: number) => mid + (v / peak) * (mid - 2);
  const area = (vals: number[], f: (v: number) => number) =>
    `M${x(0).toFixed(1)},${mid} ${vals.map((v, i) => `L${x(i).toFixed(1)},${f(v ?? 0).toFixed(1)}`).join("")} L${x(vals.length - 1).toFixed(1)},${mid}Z`;
  const lastIn = inn[inn.length - 1] ?? 0, lastOut = out[out.length - 1] ?? 0;
  // bits per second over a bucket is bytes again once multiplied by its seconds: the volume each way
  const vol = (xs: number[]) => xs.reduce((a, v) => a + ((v ?? 0) * stepMs) / 8000, 0);
  const hours = Math.round((n * stepMs) / 3600e3);
  const title = `in ${fmtBps(lastIn)} · out ${fmtBps(lastOut)} · peak ${fmtBps(peak)} · ${fmtBytes(vol(inn))} in and ${fmtBytes(vol(out))} out over ${hours ? `${hours} h` : `${n} buckets`}`;
  return (
    <span className="vz-inout" title={title}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`in ${fmtBps(lastIn)}, out ${fmtBps(lastOut)}`}>
        <path d={area(inn, up)} className="vz-inout__in" />
        <path d={area(out, down)} className="vz-inout__out" />
        <line x1={0} x2={w} y1={mid} y2={mid} className="vz-inout__axis" />
      </svg>
      {/* Two lines, not four. The four pieces were flex items of one column, so "684 MB", "in",
          "26.2 MB" and "out" each took a row and the cell grew four lines tall beside a
          thirty-pixel sparkline. Each direction is its own row now, and neither wraps. */}
      {volume && (
        <em className="vz-inout__vol">
          <span>{fmtBytes(vol(inn))}<i>in</i></span>
          <span>{fmtBytes(vol(out))}<i>out</i></span>
        </em>
      )}
    </span>
  );
}

export function Spark({ values, max = 100, unit = "%", w = 84, h = 26 }: {
  values: number[]; max?: number; unit?: string; w?: number; h?: number;
}) {
  if (values.length < 2) return <span className="np-muted">—</span>;
  const last = values[values.length - 1];
  // one hue for the measurement: the status of the row is already in its own column
  const tone = TONE.cyan;
  const top = Math.max(max, ...values);
  const x = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (w - 6);
  const y = (v: number) => h - 3 - (Math.max(0, v) / top) * (h - 7);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const id = `sp${Math.round(top)}-${values.length}`;
  return (
    <span className="vz-spark" title={`${values.length} h · last ${Math.round(last)}${unit} · peak ${Math.round(Math.max(...values))}${unit}`}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`last ${Math.round(last)}${unit}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.38" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={2} x2={w - 4} y1={y(top / 2)} y2={y(top / 2)} stroke="var(--lm-line)" strokeDasharray="2 3" />
        <path d={`${line} L${x(values.length - 1).toFixed(1)},${h - 3} L2,${h - 3} Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={tone} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(values.length - 1)} cy={y(last)} r={2.4} fill={tone} />
      </svg>
      <b className="vz-spark__v" style={{ color: tone }}>{Math.round(last)}</b>
    </span>
  );
}

/** Line of a series against a limit, e.g. CPU against the critical threshold. */
/**
 * A measurement over its window, with a reference line across it. Nothing here says anything about status:
 * the line was amber for every reading below the limit, so a device at four per cent of its CPU drew the
 * same warning colour as one at eighty-four, and nothing on screen said the drawing was CPU at all.
 */
export function LimitLine({ values, limit, label, unit = "%", hours = 24 }: {
  values: number[]; label: string;
  /** a reference the platform or the customer gave — an SLA, a port's own speed. The app has none of
   *  its own: a dashed line at a number this code invented would be this app judging. */
  limit?: number | null; unit?: string; hours?: number;
}) {
  const W = 300, H = 70;
  if (values.length < 2) return <div className="vz-cap">No {label.toLowerCase()} history</div>;
  const max = Math.max(limit ? limit * 1.1 : 0, ...values, 1);
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => H - 4 - (Math.max(0, v) / max) * (H - 12);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const peak = Math.max(...values);
  return (
    <div>
      <svg className="vz-limit" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${label} over the last ${hours} hours: peak ${Math.round(peak)}${unit}`}>
        {limit != null && <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} stroke="var(--lm-line-2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
        <path d={d} fill="none" stroke={TONE.cyan} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="vz-cap">{label} · last {hours} h · peak {Math.round(peak)}{unit}
        {limit != null ? ` · reference ${limit}${unit}` : ""}</div>
    </div>
  );
}
