// Traffic: where the last hour of traffic came from, which device exported it and where it went (NetFlow
// / IPFIX), how the paths behave for the applications (OneAgent network flows), the findings the flows
// support and Assist to argue them. The sources in use are named on the page, never assumed.
import React, { useMemo, useState } from "react";
import type { Conversation, NetworkModel } from "../model/types";
import { buildJourney } from "../model/journey";
import { environmentFindings } from "../model/traffic";
import { JourneyChart, type JourneyPick } from "../components/JourneyChart";
import { PathQualityTile } from "../components/Traffic";
import { Tile, TONE } from "../components/Visual";
import { PageEmpty } from "../components/PageEmpty";
import { AssistPanel } from "../components/AssistPanel";
import { useElementWidth } from "../hooks/useElementWidth";
import { fmtBytes, fmtInt } from "../utils/format";
import { trafficContext } from "../utils/assist";
import { trafficQuestions } from "../utils/prompts";
import type { Need, NeedKey } from "../data/requirements";

export function TrafficPage({ model, needs, onSettings, onSite, onExample }: {
  model: NetworkModel; needs: Record<NeedKey, Need>; onSettings: (focus: NeedKey | null) => void; onSite: (code: string) => void; onExample?: () => void;
}) {
  const f = model.flowMap;
  const [site, setSite] = useState("");
  const [pick, setPick] = useState<JourneyPick>(null);
  const [ref, width] = useElementWidth<HTMLDivElement>(900);
  const journey = useMemo(() => (f ? buildJourney(f.conversations, model.sites, { site: site || undefined }) : null), [f, site, model.sites]);
  const findings = useMemo(() => environmentFindings(model).filter((x) => !site || x.site === site), [model, site]);
  const siteOptions = useMemo(() => {
    const codes = new Set<string>();
    (f?.conversations ?? []).forEach((c) => [c.viaSite, c.fromSite, c.toSite].forEach((s) => s && codes.add(s)));
    (model.paths ?? []).forEach((p) => p.remoteSite && codes.add(p.remoteSite));
    return [...codes].map((c) => ({ code: c, name: model.sites[c]?.name ?? c })).sort((a, b) => a.name.localeCompare(b.name));
  }, [f, model.sites, model.paths]);

  if ((!f || !journey) && !model.paths?.length) {
    return (
      <PageEmpty title="No traffic data yet" onExample={onExample} onSettings={onSettings} configure="netflow" needs={needs} keys={["netflow", "appFlows"]}
        detail="This page draws who talks to whom from NetFlow / IPFIX and how each path behaves from OneAgent network flows. Neither is arriving in this environment." />
    );
  }

  // path quality alone (OneAgent flows, no NetFlow) still makes a page
  const J = journey ?? { nodes: [], links: [], keyOf: () => ["", "", ""] as [string, string, string], scope: [] as Conversation[] };
  const nodeOf = (id: string) => J.nodes.find((n) => n.id === id);
  // what a click selects: the conversations on that band or through that node, heaviest first
  const selected: Conversation[] = !pick ? [] : J.scope.filter((c) => {
    const [a, b, z] = J.keyOf(c);
    return pick.kind === "node" ? [a, b, z].includes(pick.id) : (a === pick.from && b === pick.to) || (b === pick.from && z === pick.to);
  }).sort((x, y) => y.bytes - x.bytes);
  const nameOf = (code?: string) => (code ? model.sites[code]?.name ?? code : "");
  const endLabel = (kind: Conversation["fromKind"], label: string, code?: string, net?: string) =>
    kind === "site" ? nameOf(code) : kind === "internet" ? `Internet · ${net}/24` : label;
  const s = f?.sources ?? {};

  return (
    <div className="lm vz vz-body tr">
      <div className="tr-bar">
        <div className="tr-sources" aria-label="Sources in use">
          <span className={`tr-src${s.netflow ? " is-on" : ""}`} title="NetFlow / IPFIX through the OpenTelemetry Collector">
            NetFlow {s.netflow ? <b>{fmtInt(s.netflow.exporters)} exporters · {fmtBytes(s.netflow.bytes)}</b> : <button type="button" className="tr-set" onClick={() => onSettings("netflow")}>set up</button>}
          </span>
          <span className={`tr-src${model.appNet ? " is-on" : ""}`} title="How the applications feel the network: TCP retransmissions and round trip">
            OneAgent {model.appNet ? <b>{model.appNet.source}</b> : <button type="button" className="tr-set" onClick={() => onSettings("appFlows")}>set up</button>}
          </span>
        </div>
        <label className="tr-filter">
          <span>Site</span>
          <select value={site} onChange={(e) => { setSite(e.target.value); setPick(null); }}>
            <option value="">All sites</option>
            {siteOptions.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
          </select>
        </label>
      </div>

      {f && <Tile tone={TONE.cyan} title="Traffic journey · last hour" right="from · through · to — band width is bytes">
        <div className="tr-chart" ref={ref}>
          {J.nodes.length
            ? <JourneyChart nodes={J.nodes} links={J.links} width={width} pick={pick} onPick={setPick} />
            : <p className="tr-none">No traffic through {nameOf(site)} in the last hour.</p>}
        </div>
        <p className="tr-note">
          Click a band or a box to list what it carries.
        </p>
      </Tile>}

      {pick && (
        <Tile title={pick.kind === "node" ? nodeOf(pick.id)?.label ?? "Selection" : `${nodeOf(pick.from)?.label ?? "?"} → ${nodeOf(pick.to)?.label ?? "?"}`}
          right={`${fmtBytes(selected.reduce((a, c) => a + c.bytes, 0))} · ${fmtInt(selected.length)} groups`}>
          <div className="tr-table" role="table">
                <div className="tr-row tr-head" role="row"><span>From</span><span>Through</span><span>To</span><span>Application</span><span>Volume</span><span>Flows</span></div>
                {selected.slice(0, 12).map((c, i) => (
                  <div key={i} className="tr-row" role="row">
                    <span>{c.fromKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.fromSite!)}>{nameOf(c.fromSite)}</button> : endLabel(c.fromKind, c.fromLabel, c.fromSite, c.s24)}</span>
                    <span>{c.viaName}</span>
                    <span>{c.toKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.toSite!)}>{nameOf(c.toSite)}</button> : endLabel(c.toKind, c.toLabel, c.toSite, c.d24)}</span>
                    <span>{c.app}</span><span>{fmtBytes(c.bytes)}</span><span>{fmtInt(c.count)}</span>
                  </div>
                ))}
          </div>
        </Tile>
      )}

      <PathQualityTile model={model} site={site || undefined} onSite={onSite} />

      <Tile tone={findings.length ? TONE.warn : TONE.good} title={`Findings · ${findings.length}`} right="measured, not judged">
        {findings.length ? (
          <ul className="tr-findings">
            {findings.map((x) => (
              <li key={x.text}>{x.text}{x.site && !site && <> · <button type="button" className="tf-link" onClick={() => onSite(x.site!)}>{nameOf(x.site)}</button></>}</li>
            ))}
          </ul>
        ) : <p className="tr-none">Nothing stands out in the last hour{site ? ` at ${nameOf(site)}` : ""}.</p>}
        <AssistPanel subject={`traffic|${site}`} questions={trafficQuestions(site ? nameOf(site) : "this network")} object="traffic"
          context={() => trafficContext(model, site || undefined)} />
      </Tile>
    </div>
  );
}
