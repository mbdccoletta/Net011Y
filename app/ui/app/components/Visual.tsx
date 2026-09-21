// Shared visual vocabulary of the NetO11y pages (UX Delivery Chain look): tinted tiles
// with corner brackets, KPI tiles, filter chips, the page bar and the visual/table toggle.
import React, { useEffect, useRef, useState } from "react";
import type { NetworkModel, Verdict } from "../model/types";
import { fmtBps, fmtBytes, hhmm } from "../utils/format";
import { MAP_COLORS } from "./LiveMap";

export const TONE = {
  bad: "var(--lm-bad-fill)", warn: "var(--lm-warn-fill)", good: "var(--lm-good-fill)", neutral: "var(--lm-neutral)",
  accent: "var(--lm-accent)", cyan: "var(--lm-cyan)", violet: "var(--lm-violet)",
} as const;

export const verdictTone = (v: Verdict) => MAP_COLORS[v];

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
  return onClick
    ? <button type="button" className={`vz-tile vz-tile--btn${active ? " is-on" : ""} ${className}`} style={style} onClick={onClick} aria-pressed={active} aria-label={label}>{body}</button>
    : <section className={`vz-tile ${className}`} style={style} aria-label={label}>{body}</section>;
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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const picked = chosen(value);
  // a click anywhere else closes it, the way a select does
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
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
  const summary = !picked.length ? `All ${label.toLowerCase()}s`
    : picked.length === 1 ? options.find((o) => o.key === picked[0])?.label ?? picked[0]
      : `${picked.length} of ${options.length}`;
  return (
    <div className="vz-pick" ref={box}>
      <span className="vz-pick__label">{label}</span>
      <button type="button" className={`vz-pick__box${picked.length ? " is-on" : ""}`} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${label}: ${summary}`} onClick={() => setOpen((v) => !v)}>
        <span>{summary}</span><i aria-hidden="true">▾</i>
      </button>
      {open && (
        <div className="vz-pick__menu" role="listbox" aria-multiselectable="true">
          <button type="button" role="option" aria-selected={!picked.length} className={`vz-pick__opt${picked.length ? "" : " is-on"}`}
            onClick={() => { onChange(null); setOpen(false); }}>
            <i aria-hidden="true">{picked.length ? "" : "✓"}</i>All {label.toLowerCase()}s
          </button>
          {options.map((o) => (
            <button key={o.key} type="button" role="option" aria-selected={picked.includes(o.key)}
              className={`vz-pick__opt${picked.includes(o.key) ? " is-on" : ""}`} onClick={() => onChange(toggle(value, o.key))}>
              <i aria-hidden="true">{picked.includes(o.key) ? "✓" : ""}</i>{o.label}{o.count != null && <b>{o.count}</b>}
            </button>
          ))}
        </div>
      )}
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
        ? <button type="button" className="lm-pill lm-pill--warn lm-pill--btn" onClick={onLive}>Example data · back to this environment</button>
        : <span className="lm-pill lm-pill--warn">Example data</span>)}
      {!model.demo && failed.length > 0 && <span className="lm-pill lm-pill--warn" title={failed.join(", ")}>{failed.length} data source(s) unavailable</span>}
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
 * Ring gauge for a percentage. The colour follows the thresholds, unless the caller states the status:
 * a circuit that is down reads 100% of its SLA, which lands exactly on the warning threshold and paints
 * the ring amber for something that is actually critical.
 */
export function Gauge({ value, label, warn, crit, size = 110, verdict }: { value: number | null; label: string; warn: number; crit: number; size?: number; verdict?: Verdict }) {
  const R = 44, C = 2 * Math.PI * R, pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const tone = verdict ? verdictTone(verdict)
    : value == null ? TONE.neutral : value >= crit ? TONE.bad : value >= warn ? TONE.warn : TONE.good;
  // the reading sits alone inside the ring; the caption goes under it, where it has the whole width of
  // the tile and cannot run into the number or over the ring
  return (
    <figure className="vz-gauge">
      <svg viewBox="0 0 110 110" width={size} height={size} role="img" aria-label={`${label} ${value == null ? "not measured" : `${Math.round(pct)}%`}`}>
        <circle cx={55} cy={55} r={R} fill="none" stroke="var(--lm-line)" strokeWidth={11} />
        <circle cx={55} cy={55} r={R} fill="none" stroke={tone} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 55 55)" />
        <text x={55} y={64} textAnchor="middle" fill="var(--lm-ink-hi)" fontSize={24} fontWeight={700} style={{ fontFamily: "var(--lm-sans)" }}>{value == null ? "—" : `${Math.round(pct)}%`}</text>
      </svg>
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
      {volume && <em className="vz-inout__vol">{fmtBytes(vol(inn))}<i>in</i>{fmtBytes(vol(out))}<i>out</i></em>}
    </span>
  );
}

export function Spark({ values, max = 100, unit = "%", w = 84, h = 26 }: { values: number[]; max?: number; unit?: string; w?: number; h?: number }) {
  if (values.length < 2) return <span className="np-muted">—</span>;
  const last = values[values.length - 1];
  const tone = last >= 90 ? TONE.bad : last >= 70 ? TONE.warn : TONE.cyan;
  const top = Math.max(max, ...values);
  // the curve keeps a margin for its end dot; the value sits in its own box beside it, so it can never
  // run into the next column the way a label drawn at the edge of the SVG did
  const x = (i: number) => 2 + (i / (values.length - 1)) * (w - 6);
  const y = (v: number) => h - 3 - (v / top) * (h - 7);
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
export function LimitLine({ values, limit, label }: { values: number[]; limit: number; label: string }) {
  const W = 300, H = 70;
  if (values.length < 2) return <div className="vz-cap">No {label.toLowerCase()} history</div>;
  const max = Math.max(limit * 1.1, ...values);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 4 - (v / max) * (H - 12);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg className="vz-limit" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: last ${Math.round(last)}, limit ${limit}`}>
      <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} stroke={TONE.bad} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={last >= limit ? TONE.bad : TONE.warn} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
