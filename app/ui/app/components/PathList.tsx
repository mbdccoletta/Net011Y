// The WAN paths as rows, because past three curves the map stops being able to say it.
//
// A hub-and-spoke estate's routes all end at the same few points, so they stack up near the hub
// whatever their number: twenty-three sites in one region picked put twenty-two curves across
// one vertical. A row cannot overlap another row. Both of its ends are written out instead of
// being a pixel the reader has to hover, and the number it carries is on it.
//
// The idiom is `RouteStrip`'s, which made the same argument on the Traffic page and is already
// styled: a ranked list says in a fifth of the space what a bundle of arcs does not say at all.
// Picking a row picks its two ends, so the curve comes back on the map through the focus the
// rest of the page already uses — no second mechanism, and one row is one curve.
import React from "react";
import type { PathRow } from "../model/paths";
import { fmtBps, fmtInt } from "../utils/format";

export function PathList({ rows, picked, onPick }: {
  rows: PathRow[];
  /** the row id currently picked, or null */
  picked: string | null;
  onPick: (id: string | null) => void;
}) {
  const bad = rows.filter((r) => r.verdict === "Critical" || r.verdict === "Warning");
  const max = Math.max(1, ...rows.map((r) => r.bps ?? 0));

  if (!rows.length) {
    return (
      <p className="lm-paths__none">No WAN path is reported between two placed sites. A path appears
        here once a site carries a hub, a cable is reported between two of them, or flow is measured
        across a pair.</p>
    );
  }

  return (
    <div className="lm-paths">
      {/* The count first, because the list is long and the question is almost always "how many
          of them are bad", not "what is the twelfth one". */}
      <h2 className="lm-h">{bad.length ? `${fmtInt(bad.length)} of ${fmtInt(rows.length)} paths alerting` : `${fmtInt(rows.length)} paths, none alerting`}</h2>
      <p className="lm-paths__why">Worst first, then by what it carries. Picking a path puts it on
        the map on its own — the map draws at most three curves at a time, because past that they
        converge on the hub and stop being lines a reader can follow.</p>
      <ol className="rs-list">
        {rows.map((r) => {
          const on = picked === r.id;
          const alerting = r.verdict === "Critical" || r.verdict === "Warning";
          const col = r.verdict === "Critical" ? "var(--lm-bad)" : r.verdict === "Warning" ? "var(--lm-warn)" : undefined;
          return (
            <li key={r.id}>
              <button type="button" className={`rs-row${on ? " is-on" : ""}`} aria-pressed={on}
                onClick={() => onPick(on ? null : r.id)}
                title={`${r.a.label} to ${r.b.label} · ${r.verdict}${r.bps != null ? ` · ${fmtBps(r.bps)}` : " · traffic not measured"}${r.n > 1 ? ` · ${r.n} links` : ""}`}>
                {/* the bar is what it carries, as a share of the busiest path */}
                <span className="rs-bar" style={{ width: `${Math.max(1.5, (100 * (r.bps ?? 0)) / max)}%` }} />
                <span className="rs-path">
                  {/* the status is a word and a mark, never the colour alone */}
                  <b className={alerting ? "rs-alert" : undefined} style={col ? { ["--c" as string]: col } : undefined}>{r.a.label}</b>
                  <i aria-hidden="true">{r.b.dc || r.a.dc ? "⇄" : "→"}</i>
                  <b>{r.b.label}</b>
                </span>
                <span className="rs-val">
                  {r.bps != null ? fmtBps(r.bps) : <small>not measured</small>}
                  {alerting && <small style={{ color: col }}>{r.verdict}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
