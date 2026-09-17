// Shared visual vocabulary of the NetworkPlane pages (UX Delivery Chain look): tinted tiles
// with corner brackets, KPI tiles, filter chips, the page bar and the visual/table toggle.
import React from "react";
import type { NetworkModel, Verdict } from "../model/types";
import { hhmm } from "../utils/format";
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

export function Chips({ label, options, value, onChange }: { label: string; options: ChipOption[]; value: string | null; onChange: (key: string | null) => void }) {
  return (
    <div className="vz-chips" role="group" aria-label={label}>
      <span className="vz-chips__label">{label}</span>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button key={o.key} type="button" className={`vz-chip${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => onChange(on ? null : o.key)}
            style={o.tone ? ({ "--c": o.tone } as React.CSSProperties) : undefined}>
            {o.tone && <i aria-hidden="true" />}{o.label}{o.count != null && <b>{o.count}</b>}
          </button>
        );
      })}
    </div>
  );
}

export type View = "visual" | "table";

export function PageBar({ model, failed, view, onView, children }: { model: NetworkModel; failed: string[]; view?: View; onView?: (v: View) => void; children?: React.ReactNode }) {
  return (
    <div className="lm-bar">
      <span className="lm-pill lm-pill--live"><span className="lm-live" aria-hidden="true" />Live {hhmm(model.meta.generatedAt)}</span>
      {children}
      {model.demo && <span className="lm-pill lm-pill--warn">Example data</span>}
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
  return (
    <svg viewBox="0 0 110 110" width={size} height={size} role="img" aria-label={`${label} ${value == null ? "not measured" : `${Math.round(pct)}%`}`}>
      <circle cx={55} cy={55} r={R} fill="none" stroke="var(--lm-line)" strokeWidth={11} />
      <circle cx={55} cy={55} r={R} fill="none" stroke={tone} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 55 55)" />
      <text x={55} y={59} textAnchor="middle" fill="var(--lm-ink-hi)" fontSize={22} fontWeight={700} style={{ fontFamily: "var(--lm-sans)" }}>{value == null ? "—" : `${Math.round(pct)}%`}</text>
      <text x={55} y={75} textAnchor="middle" fill="var(--lm-ink-3)" fontSize={9}>{label.toUpperCase()}</text>
    </svg>
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
