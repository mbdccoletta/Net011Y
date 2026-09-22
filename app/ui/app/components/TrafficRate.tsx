// Bandwidth over the last hour, per exporter: bits per second in five-minute buckets, drawn as the
// stacked area every flow tool opens with (Kentik, SolarWinds NTA, ntopng, and MRTG before them). It
// comes from the same query that watches whether an exporter stopped sending, so it costs nothing more
// to read. The app draws what the exporters reported and judges none of it.
import React, { useState } from "react";
import type { NetworkModel } from "../model/types";
import { fmtBps } from "../utils/format";

// categorical hues only: an exporter is not a status, and borrowing the amber and green tokens for the
// fourth and fifth band made two of them look like a verdict
const COLORS = ["var(--lm-cyan)", "var(--lm-accent)", "var(--lm-violet)", "var(--lm-cyan-2, #4aa3c7)", "var(--lm-violet-2, #8b7fd4)", "var(--lm-neutral)"];
const W = 1000, H = 120, PAD = 6;

export function TrafficRate({ rate }: { rate: NonNullable<NetworkModel["flowMap"]>["rate"] }) {
  const [at, setAt] = useState<number | null>(null);
  if (!rate || !rate.exporters.length) return null;
  const { start, stepMs } = rate;
  const n = Math.max(...rate.exporters.map((e) => e.bytes.length));
  if (n < 2) return null;
  const bps = rate.exporters.map((e) => Array.from({ length: n }, (_, i) => ((e.bytes[i] ?? 0) * 8) / (stepMs / 1000)));
  const totals = Array.from({ length: n }, (_, i) => bps.reduce((a, e) => a + e[i], 0));
  // the last bucket is still filling while the query runs: it is drawn faded and never sets the scale
  const settled = totals.slice(0, -1);
  const peak = Math.max(1, ...settled);
  const avg = settled.length ? settled.reduce((a, b) => a + b, 0) / settled.length : 0;
  const top = peak * 1.12;
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (n - 1);
  const y = (v: number) => H - PAD - (v / top) * (H - PAD * 2);
  const clock = (i: number) => new Date(start + i * stepMs).toISOString().slice(11, 16);

  // stacked: each exporter's band sits on the sum of the ones below it
  const stacks = bps.map((_, k) => Array.from({ length: n }, (_, i) => bps.slice(0, k + 1).reduce((a, e) => a + e[i], 0)));
  const areaOf = (k: number) => {
    const upper = stacks[k].map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    // back along the band below it (or along the baseline, for the first one)
    const below = (i: number) => (k === 0 ? 0 : stacks[k - 1][i]);
    const lower = Array.from({ length: n }, (_, j) => n - 1 - j).map((i) => `L${x(i).toFixed(1)},${y(below(i)).toFixed(1)}`).join("");
    return `${upper}${lower}Z`;
  };
  // with no pointer, the readout names the last bucket that is complete, not the one still filling
  const read = at ?? Math.max(0, n - 2);

  return (
    <div className="tf-rate">
      <div className="tf-rate__head">
        <span className="tf-rate__peak">{fmtBps(peak)}<small>peak</small></span>
        <span className="tf-rate__avg">{fmtBps(avg)}<small>average</small></span>
        <span className="tf-rate__keys">
          {rate.exporters.slice(0, COLORS.length).map((e, k) => (
            <span key={e.ip}><i style={{ background: COLORS[k % COLORS.length] }} />{e.device ?? e.ip}</span>
          ))}
        </span>
      </div>
      <svg className="tf-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Bandwidth over the last hour: peak ${fmtBps(peak)}, average ${fmtBps(avg)}`}
        onMouseLeave={() => setAt(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
        }}>
        {stacks.map((_, k) => (
          <path key={rate.exporters[k].ip} d={areaOf(k)} fill={COLORS[k % COLORS.length]} fillOpacity={0.55 - k * 0.06} stroke={COLORS[k % COLORS.length]} strokeWidth={1.5} strokeOpacity={0.9} />
        ))}
        {/* the hour's average, so a peak reads against the usual rather than against nothing */}
        <line x1={PAD} x2={W - PAD} y1={y(avg)} y2={y(avg)} className="tf-area__avg" />
        {/* the bucket still filling */}
        <rect x={x(n - 1.5)} y={PAD} width={W - PAD - x(n - 1.5)} height={H - PAD * 2} className="tf-area__open" />
        {at != null && <line x1={x(at)} x2={x(at)} y1={PAD} y2={H - PAD} className="tf-area__cursor" />}
      </svg>
      <div className="tf-rate__axis">
        <span>{clock(0)}</span>
        <span className="tf-rate__read">{clock(read)} · {fmtBps(totals[read])}{read === n - 1 ? " · still filling" : ""}</span>
        <span>now</span>
      </div>
    </div>
  );
}
