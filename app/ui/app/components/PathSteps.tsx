// End-to-end path as a vertical list of hops, readable in the narrow details panel.
// The first hop with an open problem is labelled, never shown by colour alone.
import React from "react";
import type { E2EPath } from "../model/types";
import { fmtNum, stripDevice } from "../utils/format";
import { Status } from "./Status";

export function PathSteps({ path, selected, onSelect }: { path: E2EPath; selected: number | null; onSelect: (index: number) => void }) {
  return (
    <ol className="np-steps" aria-label={path.name}>
      {path.hops.map((h, i) => {
        const role = i === path.summary.firstBad ? "Probable cause" : null;
        const value = h.headline.value == null || h.headline.value === "—" ? "—" : `${typeof h.headline.value === "number" ? fmtNum(h.headline.value) : h.headline.value}${h.headline.unit ? ` ${h.headline.unit}` : ""}`;
        return (
          <li key={`${h.layer}-${i}`}>
            <button type="button" className={`np-step${selected === i ? " is-selected" : ""}`} aria-pressed={selected === i} onClick={() => onSelect(i)}>
              <Status verdict={h.verdict} label={false} />
              <span className="np-step__main">
                <span className="np-step__title">{h.layer} · {h.title}</span>
                <span className="np-muted np-small">
                  {role && <strong className={role === "Probable cause" ? "np-step__cause" : undefined}>{role} · </strong>}
                  {h.topReason ? stripDevice(h.topReason) : "Within expected range"}
                </span>
              </span>
              <span className="np-step__value">
                <span className="np-mono">{value}</span>
                <span className="np-muted np-small">{h.headline.label}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
