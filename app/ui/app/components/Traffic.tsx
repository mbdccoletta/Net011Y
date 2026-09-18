// What a site talks to, from NetFlow: where the bytes go, which applications carry them, and the
// patterns worth a look. Measured, never judged: the insights say what the flows show and leave the
// verdict to the operator and to Assist.
import React from "react";
import type { NetworkModel, SiteTraffic } from "../model/types";
import { trafficInsights } from "../model/traffic";
import { fmtBytes, fmtInt } from "../utils/format";
import { Tile, TONE } from "./Visual";

const SPLIT: { key: keyof Pick<SiteTraffic, "toSites" | "internet" | "private" | "local">; label: string; tone: string }[] = [
  { key: "toSites", label: "other sites", tone: "var(--lm-accent)" },
  { key: "internet", label: "Internet", tone: "var(--lm-cyan)" },
  { key: "private", label: "unmapped private", tone: "var(--lm-violet)" },
  { key: "local", label: "inside the site", tone: "var(--lm-neutral)" },
];

export function SiteTrafficTile({ model, code, onSite }: { model: NetworkModel; code: string; onSite: (code: string) => void }) {
  const flows = model.flowMap;
  const t = flows?.sites[code];
  if (!flows || !t) return null;
  const insights = trafficInsights(t, flows, code);
  const nameOf = (c: string) => model.sites[c]?.name ?? c;
  return (
    <Tile tone={insights.length ? TONE.warn : TONE.cyan} title="Traffic · last hour" right={`NetFlow · ${t.exporters.join(", ")}`}>
      <div className="tf-head">
        <div><div className="vz-big">{fmtBytes(t.bytes)}</div><div className="vz-cap">{fmtInt(t.flows)} flows</div></div>
        <div className="tf-split" role="img" aria-label={SPLIT.map((s) => `${s.label} ${fmtBytes(t[s.key])}`).join(", ")}>
          {SPLIT.filter((s) => t[s.key] > 0).map((s) => (
            <span key={s.key} style={{ flexGrow: t[s.key], background: s.tone }} title={`${s.label}: ${fmtBytes(t[s.key])}`} />
          ))}
        </div>
        <div className="tf-legend">
          {SPLIT.filter((s) => t[s.key] > 0).map((s) => (
            <span key={s.key}><i style={{ background: s.tone }} />{s.label} <b>{Math.round((100 * t[s.key]) / Math.max(t.bytes, 1))}%</b></span>
          ))}
        </div>
      </div>
      <div className="tf-cols">
        <div>
          <div className="tf-sub">Talks to</div>
          {t.peers.slice(0, 5).map((p) => (
            <div key={p.name} className="tf-row">
              {p.kind === "site" && p.site
                ? <button type="button" className="tf-name tf-link" onClick={() => onSite(p.site!)}>{nameOf(p.site)}</button>
                : <span className="tf-name" title={p.kind === "private" ? "private range no site claims" : undefined}>{p.name}</span>}
              <span className="tf-val">{fmtBytes(p.bytes)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="tf-sub">Applications</div>
          {t.apps.slice(0, 5).map((a) => (
            <div key={`${a.proto}/${a.port}`} className="tf-row">
              <span className="tf-name" title={`${a.proto}/${a.port}`}>{a.name ?? `${a.proto}/${a.port}`}</span>
              <span className="tf-val">{fmtBytes(a.bytes)}</span>
            </div>
          ))}
        </div>
      </div>
      {insights.length > 0 && (
        <ul className="tf-insights">{insights.map((i) => <li key={i}>{i}</li>)}</ul>
      )}
    </Tile>
  );
}
