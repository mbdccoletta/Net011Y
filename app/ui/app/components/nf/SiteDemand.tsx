// Which sites carry the demand, and the way from one of them to its interfaces.
//
// This drew a second time-series chart: the same unit, the same forecast and the same shape as
// the estate card above it, one site at a time. Measured on this environment it accounted for
// 5.5% of what that card drew — four of thirteen sites had enough record for the analyzer, and
// three of those four carried almost nothing — so a reader could not see where the other
// ninety-four per cent was, which is the one question a middle rung exists to answer.
//
// A site publishes no limit, so it has nothing to be "heading towards". What it has is a share
// of the estate's demand and a set of interfaces. So this card is the composition — every site
// that reported, measured, ranked — and every row is the door to that site's ports.
import React from "react";
import { useSiteDemand } from "../../hooks/useDavisForecast";
import { samePick, useSel } from "./source";

const gbps = (v: number) => Math.round((v / 1e9) * 100) / 100;

export default function SiteDemand({ families, hours, ready, nameOf, siteCount }: {
  families: string[]; hours: number; ready: boolean; nameOf: (code: string) => string;
  /** how many sites the estate has, so the card can say how many of them reported */
  siteCount: number;
}) {
  const { data, loading, error } = useSiteDemand(ready ? families : [], hours);
  const { pick, setPick } = useSel();

  if (!ready || (!data && loading)) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-title">Traffic · by site</span>
          <span className="card-unit">{ready ? "asking…" : "waiting for the whole record"}</span>
        </div>
      </div>
    );
  }
  if (error || !data?.length) {
    return (
      <div className="card">
        <div className="card-head"><span className="card-title">Traffic · by site</span></div>
        <div className="nfd-empty">No site reported an hourly record{error ? `: ${error}` : ""}.</div>
      </div>
    );
  }

  const total = data.reduce((a, s) => a + s.busy, 0);
  const top = Math.max(...data.map((s) => s.busy), 1);
  const forecast = data.filter((s) => s.peak > 0).length;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Traffic · by site</span>
        <span className="card-unit">gigabits per second at the busiest hour · {gbps(total)} Gb/s across
          {" "}{data.length} of {siteCount} sites{forecast ? ` · ${forecast} forecast by Dynatrace` : ""}</span>
      </div>
      {/* One row per site: the share it carries, what that is in gigabits, where its own
          forecast puts it when there is one, and the way through to its interfaces. */}
      <ul className="sd-list">
        {data.map((s) => {
          const want = { kind: "site" as const, id: s.site, col: null };
          const on = samePick(pick, want);
          return (
            <li key={s.site} className={`sd-row${on ? " is-on" : ""}`}>
              <button type="button" className="sd-open" aria-pressed={on}
                onClick={() => setPick(on ? null : want)}
                title={`Open the ports and processors at ${nameOf(s.site)}`}>
                <span className="sd-name">{nameOf(s.site)}</span>
                <span className="sd-bar" aria-hidden="true">
                  <i style={{ width: `${(s.busy / top) * 100}%` }} />
                </span>
                <span className="sd-v">{gbps(s.busy)}<small>Gb/s busiest</small></span>
                <span className="sd-v">{total ? Math.round((s.busy / total) * 100) : 0}%<small>of the estate</small></span>
                <span className="sd-v sd-v--fc">{s.peak > 0 ? gbps(s.peak) : "—"}
                  <small>{s.peak > 0 ? "Gb/s forecast peak" : "too little record to forecast"}</small></span>
                <span className="sd-go" aria-hidden="true">›</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="note">A site publishes no limit of its own · pick one for its interfaces</div>
    </div>
  );
}
