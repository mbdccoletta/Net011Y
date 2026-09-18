// The isolation strip: is what is degraded explained by the network?
//
// It states a suspicion, never a status — the colours of the app keep coming from the problems Dynatrace
// has open. Nothing outside the network is detailed here: the counts say that something else is alerting,
// and the buttons hand that over to the native apps and to Dynatrace Assist.
import React from "react";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";
import type { NetworkModel } from "../model/types";
import { trafficDrop, type Suspicion } from "../model/suspicion";
import { openNative } from "../utils/drilldown";

const TONE: Record<Suspicion["kind"], string> = {
  "network-implicated": "is-net",
  "not-network": "is-out",
  contained: "is-calm",
  watching: "is-calm",
  blind: "is-blind",
};

const MARK: Record<Suspicion["kind"], string> = {
  "network-implicated": "Network implicated",
  "not-network": "Not the network",
  contained: "Contained",
  watching: "Nothing to isolate",
  blind: "Cannot tell",
};

export function SuspicionStrip({ s, users, assist }: { s: Suspicion; users: NetworkModel["users"]; assist?: React.ReactNode }) {
  const outside = s.outside.application + s.outside.service + s.outside.host + s.outside.other;
  const drop = trafficDrop(users, 0);
  const pct = drop.pct;
  return (
    <section className={`sus ${TONE[s.kind]}`} aria-label="Fault domain">
      <div className="sus__head">
        <span className="sus__eyebrow">Fault domain</span>
        <span className="sus__mark">{MARK[s.kind]}</span>
        {s.fromMeasurement && <em className="sus__hint" title="No traffic anomaly alert fired: this comes from the app's own measurement">suspicion, not a problem</em>}
      </div>
      <p className="sus__line">{s.headline}</p>
      <div className="sus__facts">
        <span><b>{s.network}</b>network alert{s.network === 1 ? "" : "s"}</span>
        <span><b>{outside}</b>alerting outside the network</span>
        <span title={s.trafficScope === "environment" ? "Sessions are counted across the environment: this site has no client subnet of its own yet" : undefined}>
          <b>{pct == null ? "—" : `${pct}%`}</b>of the usual {drop.source === "requests" ? "requests" : "sessions"}{s.scope === "site" && s.trafficScope === "environment" ? " (environment)" : ""}
        </span>
        {s.siteSessions != null && <span><b>{s.siteSessions}</b>sessions from this site, 24 h</span>}
      </div>
      <div className="sus__acts">
        {outside > 0 && (
          <button type="button" className="lm-btn" onClick={() => openNative("problems")} title="The detail of what is alerting outside the network lives in the Problems app">
            Problems <ExternalLinkIcon />
          </button>
        )}
      </div>
      {assist}
    </section>
  );
}
