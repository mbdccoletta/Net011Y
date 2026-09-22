// Traffic: where the last hour of traffic came from, which device exported it and where it went (NetFlow
// / IPFIX), how the paths behave for the applications (OneAgent network flows), the findings the flows
// support and Assist to argue them. The sources in use are named on the page, never assumed.
import React, { useMemo, useState } from "react";
import type { Conversation, NetworkModel } from "../model/types";
import { asRoutes, buildJourney } from "../model/journey";
import { environmentFindings } from "../model/traffic";
import { JourneyChart, JOURNEY_LEGEND, type JourneyPick } from "../components/JourneyChart";
import { RouteStrip } from "../components/RouteStrip";
import { PathQualityTile } from "../components/Traffic";
import { TrafficRate } from "../components/TrafficRate";
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
  // the same conversation the other way round, when the exporter reported it: same exporter, same
  // application, the two ends swapped. Without it the table shows one direction and says nothing of the
  // other, which on a WAN link is half the story.
  const reverse = useMemo(() => {
    const m = new Map<string, number>();
    (f?.conversations ?? []).forEach((c) => m.set(`${c.via}|${c.s24}|${c.d24}|${c.proto}|${c.port}`, (m.get(`${c.via}|${c.s24}|${c.d24}|${c.proto}|${c.port}`) ?? 0) + c.bytes));
    return (c: Conversation) => m.get(`${c.via}|${c.d24}|${c.s24}|${c.proto}|${c.port}`) ?? null;
  }, [f]);

  // a device that is alerting now, to outline it wherever the journey draws it
  const alerting = useMemo(() => {
    const m = new Map<string, string>();
    model.devices.forEach((d) => {
      if (!(d.problems ?? []).some((p) => !p.muted)) return;
      m.set(`via:${d.ip}`, d.verdict === "Critical" ? "var(--lm-bad-fill)" : "var(--lm-warn-fill)");
    });
    return m;
  }, [model.devices]);

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
  const J = journey ?? { nodes: [], links: [], routes: [], keyOf: () => ["", "", ""] as [string, string, string], scope: [] as Conversation[] };
  // the drawing follows the data: ranked paths when nothing crosses, the flow diagram when it does
  const strip = asRoutes(J);
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

  // the table lists every conversation, heaviest first; a click on the drawing filters it
  const listed = pick ? selected : [...J.scope].sort((a, b) => b.bytes - a.bytes);

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

      {f?.rate && <Tile tone={TONE.cyan} title="Bandwidth · last hour" right="bits per second, five-minute buckets, per exporter">
        <TrafficRate rate={f.rate} />
      </Tile>}

      {f && <Tile tone={TONE.cyan} title="Who talks to whom · last hour" right={strip ? "every path, heaviest first" : "from · through · to — band width is bytes"}>
        <div className="tr-chart" ref={ref}>
          {!J.nodes.length ? <p className="tr-none">No traffic through {nameOf(site)} in the last hour.</p>
            : strip ? <RouteStrip nodes={J.nodes} routes={J.routes} pick={pick} onPick={setPick} alerting={alerting} />
            : <JourneyChart nodes={J.nodes} links={J.links} width={width} pick={pick} onPick={setPick} alerting={alerting} />}
        </div>
        {!strip && J.nodes.length > 0 && (
          <div className="jr-legend" aria-label="What the colours mean">
            {JOURNEY_LEGEND.map((l) => <span key={l.kind}><i className={`jr-key jr-key--${l.kind}`} />{l.label}</span>)}
            {alerting.size > 0 && <span><i className="jr-key jr-key--alert" />Alerting now</span>}
          </div>
        )}
        <p className="tr-note">
          {strip ? "Click a path to list what it carries." : "Click a band or a box to list what it carries."}
        </p>
      </Tile>}

      {f && J.scope.length > 0 && (
        <Tile title={pick ? (pick.kind === "node" ? nodeOf(pick.id)?.label ?? "Selection" : `${nodeOf(pick.from)?.label ?? "?"} → ${nodeOf(pick.to)?.label ?? "?"}`) : "Top conversations · last hour"}
          right={`${fmtBytes(listed.reduce((a, c) => a + c.bytes, 0))} · ${fmtInt(listed.length)} groups${pick ? "" : " · heaviest first"}`}>
          {pick && <div className="tr-picked"><button type="button" className="tf-link" onClick={() => setPick(null)}>Show every conversation</button></div>}
          <div className="tr-table" role="table">
                <div className="tr-row tr-head" role="row"><span>From</span><span>Through</span><span>To</span><span>Application</span><span>Volume</span><span>Back</span><span>Flows</span></div>
                {listed.slice(0, 12).map((c, i) => (
                  <div key={i} className="tr-row" role="row">
                    <span>{c.fromKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.fromSite!)}>{nameOf(c.fromSite)}</button> : endLabel(c.fromKind, c.fromLabel, c.fromSite, c.s24)}</span>
                    <span>{c.viaName}</span>
                    <span>{c.toKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.toSite!)}>{nameOf(c.toSite)}</button> : endLabel(c.toKind, c.toLabel, c.toSite, c.d24)}</span>
                    <span>{c.app}</span><span>{fmtBytes(c.bytes)}</span>
                    <span title={reverse(c) == null ? "the exporter reported no flow the other way" : "the same two ends, the other way round"}>{reverse(c) == null ? "—" : fmtBytes(reverse(c)!)}</span>
                    <span>{fmtInt(c.count)}</span>
                  </div>
                ))}
          </div>
        </Tile>
      )}

      <PathQualityTile model={model} site={site || undefined} onSite={onSite} />

      {/* the caption says it: measured, not judged. Amber here announced a warning nobody raised. */}
      <Tile tone={TONE.cyan} title={`Findings · ${findings.length}`} right="measured, not judged">
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
