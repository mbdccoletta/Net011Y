// Traffic: where the last hour of traffic came from, which device saw it and where it went, from every
// source that sees conversations (NetFlow exporters, firewall connection logs), with the findings the
// flows support and Assist to argue them. The sources in use are named on the page, never assumed.
import React, { useMemo, useState } from "react";
import type { Conversation, NetworkModel } from "../model/types";
import { buildJourney } from "../model/journey";
import { environmentFindings } from "../model/traffic";
import { JourneyChart, type JourneyPick } from "../components/JourneyChart";
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
  const journey = useMemo(() => (f ? buildJourney(f.conversations, f.denies, model.sites, { site: site || undefined }) : null), [f, site, model.sites]);
  const findings = useMemo(() => environmentFindings(model).filter((x) => !site || x.site === site), [model, site]);
  const siteOptions = useMemo(() => {
    const codes = new Set<string>();
    (f?.conversations ?? []).forEach((c) => [c.viaSite, c.fromSite, c.toSite].forEach((s) => s && codes.add(s)));
    return [...codes].map((c) => ({ code: c, name: model.sites[c]?.name ?? c })).sort((a, b) => a.name.localeCompare(b.name));
  }, [f, model.sites]);

  if (!f || !journey) {
    return (
      <PageEmpty title="No traffic data yet" onExample={onExample} onSettings={onSettings} configure="netflow" needs={needs} keys={["netflow", "firewallLogs", "appFlows"]}
        detail="This page draws who talks to whom from NetFlow / IPFIX exporters or from firewall connection logs. Neither is arriving in this environment." />
    );
  }

  const nodeOf = (id: string) => journey.nodes.find((n) => n.id === id);
  // what a click selects: the conversations on that band or through that node, heaviest first
  const selected: Conversation[] = !pick ? [] : journey.scope.filter((c) => {
    const [a, b, z] = journey.keyOf(c);
    return pick.kind === "node" ? [a, b, z].includes(pick.id) : (a === pick.from && b === pick.to) || (b === pick.from && z === pick.to);
  }).sort((x, y) => y.bytes - x.bytes);
  const deniedPick = pick && (pick.kind === "node" ? pick.id === "denied" : pick.to === "denied");
  const denies = deniedPick ? f.denies.filter((d) => (!site || d.site === site) && (pick!.kind === "node" || pick!.from === `via:${d.via}` || pick!.from === "via:other")) : [];
  const nameOf = (code?: string) => (code ? model.sites[code]?.name ?? code : "");
  const endLabel = (kind: Conversation["fromKind"], label: string, code?: string, net?: string) =>
    kind === "site" ? nameOf(code) : kind === "zone" ? `${label} · ${net}/24` : kind === "internet" ? `Internet · ${net}/24` : label;
  const s = f.sources;

  return (
    <div className="lm vz vz-body tr">
      <div className="tr-bar">
        <div className="tr-sources" aria-label="Sources in use">
          <span className={`tr-src${s.netflow ? " is-on" : ""}`} title="NetFlow / IPFIX through the OpenTelemetry Collector">
            NetFlow {s.netflow ? <b>{fmtInt(s.netflow.exporters)} exporters · {fmtBytes(s.netflow.bytes)}</b> : <button type="button" className="tr-set" onClick={() => onSettings("netflow")}>set up</button>}
          </span>
          <span className={`tr-src${s.firewall ? " is-on" : ""}`} title="Firewall connection and deny logs over syslog">
            Firewall logs {s.firewall ? <b>{fmtInt(s.firewall.firewalls)} firewalls · {fmtInt(s.firewall.connections)} connections · {fmtInt(s.firewall.denies)} denied</b> : <button type="button" className="tr-set" onClick={() => onSettings("firewallLogs")}>set up</button>}
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

      <Tile tone={TONE.cyan} title="Traffic journey · last hour" right="from · through · to — band width is bytes">
        <div className="tr-chart" ref={ref}>
          {journey.nodes.length
            ? <JourneyChart nodes={journey.nodes} links={journey.links} width={width} pick={pick} onPick={setPick} />
            : <p className="tr-none">No traffic through {nameOf(site)} in the last hour.</p>}
        </div>
        <p className="tr-note">
          {s.firewall?.capped ? "The firewall list reached its query limit: the heaviest conversations are drawn, the lightest are left out. " : ""}
          Click a band or a box to list what it carries.
        </p>
      </Tile>

      {pick && (
        <Tile title={pick.kind === "node" ? nodeOf(pick.id)?.label ?? "Selection" : `${nodeOf(pick.from)?.label ?? "?"} → ${nodeOf(pick.to)?.label ?? "?"}`}
          right={deniedPick ? `${fmtInt(denies.reduce((a, d) => a + d.denies, 0))} attempts` : `${fmtBytes(selected.reduce((a, c) => a + c.bytes, 0))} · ${fmtInt(selected.length)} groups`}>
          <div className="tr-table" role="table">
            {deniedPick ? (
              <>
                <div className="tr-row tr-head" role="row"><span>Firewall</span><span>From zone</span><span>To zone</span><span>Port</span><span>Hosts</span><span>Denied</span></div>
                {denies.slice(0, 12).map((d) => (
                  <div key={`${d.via}${d.from}${d.to}${d.proto}${d.port}`} className="tr-row" role="row">
                    <span>{d.viaName}</span><span>{d.from}</span><span>{d.to}</span><span>{d.proto}/{d.port}</span><span>{fmtInt(d.sources)}</span><span>{fmtInt(d.denies)}</span>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="tr-row tr-head" role="row"><span>From</span><span>Through</span><span>To</span><span>Application</span><span>Volume</span><span>{selected[0]?.source === "firewall" ? "Connections" : "Flows"}</span></div>
                {selected.slice(0, 12).map((c, i) => (
                  <div key={i} className="tr-row" role="row">
                    <span>{c.fromKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.fromSite!)}>{nameOf(c.fromSite)}</button> : endLabel(c.fromKind, c.fromLabel, c.fromSite, c.s24)}</span>
                    <span>{c.viaName}</span>
                    <span>{c.toKind === "site" ? <button type="button" className="tf-link" onClick={() => onSite(c.toSite!)}>{nameOf(c.toSite)}</button> : endLabel(c.toKind, c.toLabel, c.toSite, c.d24)}</span>
                    <span>{c.app}</span><span>{fmtBytes(c.bytes)}</span><span>{fmtInt(c.count)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </Tile>
      )}

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
