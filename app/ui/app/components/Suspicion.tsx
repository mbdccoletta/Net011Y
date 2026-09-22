// The isolation strip: is what is degraded explained by the network?
//
// It states a suspicion, never a status — the colours of the app keep coming from the problems Dynatrace
// has open. Nothing outside the network is detailed here: the counts say that something else is alerting,
// and the buttons hand that over to the native apps and to Dynatrace Assist.
import React from "react";
import { ExternalLinkIcon } from "@dynatrace/strato-icons";
import { Menu } from "@dynatrace/strato-components/navigation";
import type { NetworkModel } from "../model/types";
import { outsideAlerts, trafficDrop, type Suspicion } from "../model/suspicion";
import { openNative, openProblem } from "../utils/drilldown";

const TONE: Record<Suspicion["kind"], string> = {
  "network-implicated": "is-net",
  "not-network": "is-out",
  unexplained: "is-net",
  contained: "is-calm",
  watching: "is-calm",
  blind: "is-blind",
};

const MARK: Record<Suspicion["kind"], string> = {
  "network-implicated": "Network implicated",
  "not-network": "Not the network",
  unexplained: "Network symptom, no alert",
  contained: "Contained",
  watching: "Nothing to isolate",
  blind: "Cannot tell",
};

export function SuspicionStrip({ s, users, model, assist }: { s: Suspicion; users: NetworkModel["users"]; model?: NetworkModel; assist?: React.ReactNode }) {
  const outside = s.outside.application + s.outside.service + s.outside.host + s.outside.other;
  // only the ones the Problems app can actually open: an event that never became a problem has no page
  const out = model && !model.demo ? outsideAlerts(model).filter((p) => p.eventKind === "DAVIS_PROBLEM" && p.eventId) : [];
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
        {s.app && s.app.now != null && (
          <span className={s.app.rising ? "is-up" : undefined} title={`Share of TCP packets retransmitted, as the applications see it (OneAgent network flows). Usually ${s.app.usual ?? "?"}%`}>
            <b>{s.app.now < 0.1 ? s.app.now.toFixed(3) : s.app.now.toFixed(2)}%</b>TCP retransmitted{s.app.rising ? ` · ${s.app.usual ? `${Math.round(s.app.now / s.app.usual)}×` : "above"} usual` : ""}
          </span>
        )}
      </div>
      <div className="sus__acts">
        {/* The button used to land on the Problems home, where the alerts it had just counted were mixed
            with everything else. The Problems app opens one problem at a time, so one alert opens
            directly and several are listed by name — the same way the device panel does it. */}
        {outside > 0 && (out.length === 1 ? (
          <button type="button" className="lm-btn" onClick={() => openProblem(out[0].eventId, out[0].eventKind)}
            title={`Open ${out[0].displayId ?? "the alert"} · ${out[0].name} in Problems`}>
            {out[0].displayId ? `Problem ${out[0].displayId}` : "The alert outside"} <ExternalLinkIcon />
          </button>
        ) : out.length > 1 ? (
          <Menu>
            <Menu.Trigger>
              <button type="button" className="lm-btn" title={`${out.length} problems open outside the network`}>
                Problems · {out.length} <ExternalLinkIcon />
              </button>
            </Menu.Trigger>
            <Menu.Content>
              <Menu.Label>Alerting outside the network</Menu.Label>
              {out.slice(0, 12).map((p) => (
                <Menu.Item key={p.eventId} onSelect={() => openProblem(p.eventId, p.eventKind)}>
                  {p.displayId ? `${p.displayId} · ` : ""}{p.name}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu>
        ) : (
          <button type="button" className="lm-btn" onClick={() => openNative("problems")}
            title="These alerts are events the Problems app does not open one by one">
            Problems <ExternalLinkIcon />
          </button>
        ))}
      </div>
      {assist}
    </section>
  );
}
