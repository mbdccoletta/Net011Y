// Pilot (?journey=pilot), variant C: the same traffic as one row per path — where it came from, the
// device that saw it, where it went — with a bar for its share of the hour. A flow diagram earns its
// height when paths cross; when a handful of paths carry everything, a ranked list says it in a fifth
// of the space and names every end in full.
import React from "react";
import type { JourneyNode } from "../model/types";
import type { JourneyRoute } from "../model/journey";
import { fmtBytes, fmtInt } from "../utils/format";
import type { JourneyPick } from "./JourneyChart";

const TOP = 8;

export function RouteStrip({ nodes, routes, pick, onPick, alerting }: {
  nodes: JourneyNode[];
  routes: JourneyRoute[];
  pick: JourneyPick;
  onPick: (p: JourneyPick) => void;
  /** node ids whose device has an open alert, and the status colour to mark it with */
  alerting?: Map<string, string>;
}) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const total = Math.max(1, routes.reduce((a, r) => a + r.bytes, 0));
  const shown = routes.slice(0, TOP);
  const rest = routes.slice(TOP);
  const pct = (b: number) => (b / total >= 0.1 ? `${Math.round((100 * b) / total)}%` : `${((100 * b) / total).toFixed(1)}%`);
  const label = (id: string) => by.get(id)?.label ?? id;

  return (
    <div className="rs">
      <ol className="rs-list">
        {shown.map((r) => {
          const on = pick?.kind === "link" && pick.from === r.via && pick.to === r.to;
          const mark = alerting?.get(r.via);
          return (
            <li key={`${r.from}|${r.via}|${r.to}`}>
              <button type="button" className={`rs-row${on ? " is-on" : ""}`} aria-pressed={on}
                onClick={() => onPick(on ? null : { kind: "link", from: r.via, to: r.to })}>
                <span className="rs-bar" style={{ width: `${Math.max(1.5, (100 * r.bytes) / total)}%` }} />
                <span className="rs-path">
                  <b>{label(r.from)}</b>
                  <i aria-hidden="true">→</i>
                  <b className={mark ? "rs-alert" : undefined} style={mark ? { ["--c" as string]: mark } : undefined}>{label(r.via)}</b>
                  <i aria-hidden="true">→</i>
                  <b>{label(r.to)}</b>
                </span>
                <span className="rs-val">{fmtBytes(r.bytes)}<small>{pct(r.bytes)}</small></span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="rs-foot">
        {routes.length > TOP ? `${fmtInt(shown.length)} of ${fmtInt(routes.length)} paths · the rest carries ${pct(rest.reduce((a, r) => a + r.bytes, 0))}` : `${fmtInt(routes.length)} path${routes.length === 1 ? "" : "s"} in the last hour`}
        {" · click a path to list what it carries"}
      </p>
    </div>
  );
}
