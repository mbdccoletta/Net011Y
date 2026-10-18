// Dynatrace Assist writes every explanation in the app. The app only sends the facts it has
// already computed (cause, impact, evidence, timeline) as supplementary context.
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";
import { CHANGE_LABEL, changesOf } from "../model/changes";
import { aheadSubjects, aheadCensus, clusterChanges, type Subject } from "../model/ahead";
import type { DavisForecast } from "../hooks/useDavisForecast";
import type { DeviceProblem, NetworkModel } from "../model/types";
import type { Cause } from "../model/causes";
import { trafficDrop, type Suspicion } from "../model/suspicion";
import type { Anomaly } from "../hooks/useAnomaly";
import { discardGroups } from "../model/discards";
import type { SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";import { environmentFindings, portUsers, trafficInsights } from "../model/traffic";
import { buildJourney } from "../model/journey";


export interface AssistAnswer {
  text: string;
  status: "SUCCESSFUL" | "SUCCESSFUL_WITH_WARNINGS" | "FAILED";
}

export const INSTRUCTION = [
  // The contract the answers are held to, mirroring how the app itself decides things.
  //
  // Every rule is stated here once and nowhere else. Assist refuses an instruction over 2500
  // characters and counts this one plus the question's own, so a rule written in both places
  // is paid for on every question: the answer shape used to repeat "quote it exactly", "never
  // estimate" and "no hedging" from here, and two questions were over the limit and failing
  // at click time with a message that read as the network being down.
  "You are a senior network operations analyst answering an operator on shift about the screen in front of them.",
  "Use only the supplementary context. If it does not hold what the question needs, name the missing field and stop: never estimate it, never answer from general knowledge of networks, and never hedge with \"appears\", \"likely\" or \"several\" in place of a number.",
  "Status comes only from problems and alerts Dynatrace has open. Counters (CPU, utilization, errors, availability, syslog, traps) are evidence, never a verdict.",
  "The one exception: WAN latency above the sla_ms tag of that circuit is a breach, each carrier judged against its own SLA.",
  "No open alert means not alerting, not proven healthy; no data means not monitored.",
  "Quote every figure with its unit and the window it was measured over, and spell every name, exactly as the context gives them. Do not round, convert, average or add figures together, and never invent devices, sites, carriers, ids, numbers or times.",
  "Answer in the language of the question, briefly.",
].join(" ");

/** Assist refuses an instruction context longer than this (HTTP 400). */
export const INSTRUCTION_LIMIT = 2500;

/** Assist sometimes bullets with "•", which Markdown does not read as a list item: make it one. */
const asMarkdown = (text: string) => (text ?? "").replace(/^\s*[•·▪]\s*/gm, "- ").trim();

export async function askAssist(question: string, context: unknown, abortSignal?: AbortSignal, instruction?: string): Promise<AssistAnswer> {
  const res = await publicClient.recommenderConversation({
    abortSignal,
    body: {
      text: question,
      context: [
        { type: "supplementary", value: JSON.stringify(context) },
        { type: "instruction", value: instruction ? `${INSTRUCTION} ${instruction}` : INSTRUCTION },
        { type: "document-retrieval", value: "disabled" },
      ],
    },
  });
  if (Array.isArray(res)) {
    const text = res.map((e) => {
      const data = (e as { data?: { text?: string; content?: string } }).data;
      return e.event === "content" ? data?.text ?? data?.content ?? "" : "";
    }).join("");
    return { text: asMarkdown(text), status: text ? "SUCCESSFUL" : "FAILED" };
  }
  return { text: asMarkdown(res.text), status: res.status };
}

/**
 * The addresses a network availability monitor pings at a device, and what came back.
 *
 * Every panel that can be asked an availability question needs these, and none of them had
 * them. A monitor alert names the monitor, so without the per-address readings the only
 * honest answer Assist could give was the one the app itself used to print — that the
 * monitor was out — which the record contradicts: the monitor of P-1234567 sent 24 packets
 * to each of its 162 targets in the last interval and 139 answered. The fact that decides
 * what to do is that CORE-001 answers on one of the four addresses pinged at it.
 */
const pingFacts = (d: { icmpTargets?: { ip: string; monitor: string | null; sent: number; recv: number; since: string | null }[] }) => {
  const seen = new Map<string, { ip: string; monitor: string | null; sent: number; answered: number; silentSince: string | null }>();
  (d.icmpTargets ?? []).forEach((t) => {
    const had = seen.get(t.ip);
    if (!had || (had.answered > 0 && t.recv === 0)) {
      seen.set(t.ip, { ip: t.ip, monitor: t.monitor, sent: t.sent, answered: t.recv, silentSince: t.recv === 0 ? t.since : null });
    }
  });
  const all = [...seen.values()];
  if (!all.length) return undefined;
  const silent = all.filter((t) => t.answered === 0);
  return {
    window: "last 2 h",
    addressesPinged: all.length,
    addressesAnswering: all.length - silent.length,
    /* a null `silentSince` on a silent address means it was already silent when the read
       began: there is no observed moment it stopped, and none may be invented */
    notAnswering: silent.map((t) => ({ address: t.ip, packetsSent: t.sent, packetsBack: 0, silentSince: t.silentSince, monitor: t.monitor })),
    answering: all.filter((t) => t.answered > 0).map((t) => ({ address: t.ip, packetsSent: t.sent, packetsBack: t.answered })),
  };
};

/**
 * Every address in the estate that is pinged and answers nothing, counted the way an
 * operator would act on it: by the monitoring configuration that pings them, since that is
 * the unit of the fix, and with the ones that belong to no known device called out — those
 * are either dead hosts or addresses that should not be in the configuration at all.
 */
const estatePing = (model: NetworkModel) => {
  const down = model.pingDown ?? [];
  if (!down.length) return "no ping target in this environment is silent, or no ICMP monitor reports";
  const byMonitor = new Map<string, number>();
  down.forEach((p) => byMonitor.set(p.monitor ?? "no monitor named", (byMonitor.get(p.monitor ?? "no monitor named") ?? 0) + 1));
  return {
    window: "last 2 h",
    addressesPingedWithNoAnswer: down.length,
    onNoKnownDevice: down.filter((p) => !p.device).length,
    byMonitoringConfiguration: Object.fromEntries([...byMonitor].sort((a, b) => b[1] - a[1]).slice(0, 8)),
    examples: down.slice(0, 10).map((p) => ({ address: p.ip, device: p.device, site: p.site, packetsSent: p.sent, silentSince: p.since })),
  };
};

const siteFacts = (s: SiteInfo) => ({
  code: s.code, name: s.site.name, region: s.site.region, status: s.verdict, probableCause: s.cause, incident: s.incident,
  wanLinks: s.circuits.map((c) => ({ circuitId: c.id, kind: c.kind, carrier: c.carrier, tech: c.tech, status: c.status, latencyMs: c.latencyMs, slaMs: c.slaMs, lossPct: c.lossPct, since: c.since })),
});

export function causeContext(model: NetworkModel, cause: Cause) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    cause: { title: cause.title, kind: cause.kind, layer: cause.layer, status: cause.verdict, since: cause.since, incident: cause.incident },
    impact: cause.impact,
    originDevices: cause.devices.slice(0, 10).map((d) => ({ name: d.name, role: d.role, status: d.verdict, reasons: d.reasons.map((r) => r.text), cpu: d.cpuNow, ping: pingFacts(d) })),
    openAlerts: [...new Map(cause.sites.flatMap((s) => s.devices).flatMap((d) => (d.problems ?? []).filter((x) => !x.muted).map((x) => [x.eventId, x] as const))).values()]
      .slice(0, 10).map((x) => ({ id: x.displayId || x.eventId, name: x.name, category: x.category, on: x.on, since: x.start })),
    evidence: cause.evidence.map((e) => ({ time: e.t, source: e.source, level: e.level, text: e.text })),
    timeline: cause.timeline.map((m) => ({ time: m.t, event: m.label, sites: m.sites.length })),
    sites: cause.sites.slice(0, 40).map(siteFacts),
    /**
     * The groups the record separates the ports into, where the cause is about ports.
     *
     * The panel states these as counts and figures and says nothing about what they mean —
     * the reasoning is this question's job, and it has the fields to do it with: errors and
     * CRC on the same port, the port's state, and the busiest hour it reached against its
     * own line rate.
     */
    portGroups: cause.ports?.length ? discardGroups(cause.ports).map((g) => ({
      group: g.label, ports: g.rows.length, figures: g.figures,
      examples: g.rows.slice(0, 6).map((r) => ({
        port: r.iface, device: r.device, discardsOverTheRecord: r.total,
        busiestHourPctOfLineRate: r.busy, crc: r.crc, errors: r.errors,
        operationalState: r.oper, speedMbps: r.speedMbps, uplink: r.uplink,
      })),
    })) : undefined,
  };
}

export function networkContext(model: NetworkModel, infos: SiteInfo[], causes: Cause[]) {
  const open = model.devices.filter((d) => (d.problems ?? []).some((p) => !p.muted)).length;
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    sites: infos.length,
    sitesWithIssues: infos.filter((i) => isBad(i.verdict)).length,
    sitesWithNoPathLeft: infos.filter((i) => i.circuits.length > 0 && i.circuits.every((c) => c.status === "down")).length,
    devices: model.devices.length,
    devicesWithAnOpenAlert: open,
    devicesNotMonitored: model.devices.filter((d) => d.verdict === "Not monitored").length,
    // so an answer can say "nothing is alerting" without implying the network was proven healthy
    alertsNotPlacedOnTheMap: (model.unmappedAlerts ?? []).length,
    reachability: estatePing(model),
    causes: causes.map((c) => ({
      id: c.id, title: c.title, kind: c.kind, status: c.verdict, since: c.since, impact: c.impact, incident: c.incident,
      devices: c.devices.slice(0, 5).map((d) => d.name),
      carriers: [...new Set(c.sites.flatMap((s) => s.circuits.filter((x) => x.status === "down").map((x) => x.carrier)))],
    })),
    // NetFlow of the last hour, reduced to what stands out: the heaviest routes and each site's findings
    traffic: model.flowMap ? {
      window: "last hour",
      routesBetweenSites: model.flowMap.pairs.slice(0, 5).map((p) => ({ between: [model.sites[p.a]?.name ?? p.a, model.sites[p.b]?.name ?? p.b], volume: `${(p.bytes / 1e9).toFixed(2)} GB` })),
      findings: Object.entries(model.flowMap.sites).flatMap(([code, t]) => trafficInsights(t, model.flowMap!, code).map((text) => ({ site: model.sites[code]?.name ?? code, text }))).slice(0, 10),
    } : "no NetFlow in this environment",
  };
}

/**
 * Everything needed to decide whether the network explains what is degraded, and nothing else. Times are
 * kept exactly as the platform reports them, because the order of events is the whole argument.
 */
export function isolationContext(model: NetworkModel, s: Suspicion, info?: SiteInfo, dropPct = 50,
  platform?: { demand?: Anomaly; retransmitted?: Anomaly; roundTrip?: Anomaly }) {
  const demand = platform?.demand;
  const u = model.users;
  const open = (list: DeviceProblem[] | undefined) => (list ?? []).filter((p) => !p.muted)
    .map((p) => ({ id: p.displayId || p.eventId, name: p.name, category: p.category, on: p.on, openedAt: p.start }));
  const networkAlerts = info
    ? [...info.devices.flatMap((d) => open(d.problems).map((p) => ({ ...p, element: d.name }))),
       ...info.circuits.flatMap((c) => open(c.problems).map((p) => ({ ...p, element: `${c.carrier} ${c.kind} link ${c.id}` })))]
    : [...model.devices.flatMap((d) => open(d.problems).map((p) => ({ ...p, element: d.name }))),
       ...(model.circuits ?? []).flatMap((c) => open(c.problems).map((p) => ({ ...p, element: `${c.carrier} ${c.kind} link ${c.id}` })))];
  const outside = (model.unmappedAlerts ?? []).filter((a) => !a.muted && a.scope !== "network" && a.scope !== "environment");

  // Demand as the app measured it, decided rather than left for the model to eyeball: each hour carries
  // its clock label and what that hour usually holds, and the fall is stated as true or false. A raw
  // series with no times let the model call an ordinary night-time dip a drop and number hours itself.
  const drop = trafficDrop(u, dropPct);
  const src = drop.source === "requests" ? u?.requests : u;
  const series = (src?.series ?? []) as (number | null)[];
  const usual = (src?.typical ?? []) as number[];
  const hourLabel = (i: number) => `${String(new Date(Date.now() - (series.length - 1 - i) * 3600000).getUTCHours()).padStart(2, "0")}:00Z`;
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    scope: s.scope === "site"
      ? { site: info?.site.name, code: info?.code, region: info?.site.region }
      : { site: null, note: "the whole environment" },
    networkAlertCount: networkAlerts.length,
    // The app's own finding, not left for the model to rediscover from a sample: the burst of network
    // alerts that came just before an impact, with its window, its size against what is usual, the
    // devices it hit and what began right after. With thousands of alerts open, the first twenty of a
    // list sent the analysis to the wrong router, four hours off.
    networkBurst: s.burst ? (() => {
      const b = s.burst!;
      const clock = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
      const inBurst = [...model.devices.flatMap((d) => (d.problems ?? []).filter((p) => !p.muted).map((p) => ({ d: d.name, p })))]
        .filter(({ p }) => { const t = Date.parse(p.start); return t >= b.from && t <= b.to; });
      const byDevice = new Map<string, number>();
      inBurst.forEach(({ d }) => byDevice.set(d, (byDevice.get(d) ?? 0) + 1));
      return {
        window: `${clock(b.from)}–${clock(b.to)}`, alertsOpened: b.opened, usualForThatLong: Math.round(b.usual),
        thenBegan: `${b.followedBy} at ${clock(b.at)}`,
        devices: [...byDevice].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([name, alerts]) => ({ name, alerts })),
        kindsOfAlert: [...new Set(inBurst.map(({ p }) => p.name))].slice(0, 5),
      };
    })() : null,
    // a sample only, from the burst when there is one, otherwise the most recent
    networkAlertsSample: (s.burst
      ? networkAlerts.filter((a) => { const t = Date.parse(a.openedAt); return t >= s.burst!.from && t <= s.burst!.to; })
      : [...networkAlerts].sort((x, y) => y.openedAt.localeCompare(x.openedAt))).slice(0, 10),
    outsideNetworkAlertCount: outside.length,
    // outside the network the app carries no detail on purpose: what it is about, and when it opened
    outsideNetwork: outside.slice(0, 20).map((a) => ({
      id: a.displayId || a.eventId, kind: a.eventKind === "DAVIS_PROBLEM" ? "problem" : "event",
      about: a.scope, name: a.name, openedAt: a.start,
    })),
    // the network as the applications feel it, decided by the app against the environment's own usual level
    /**
     * Rising is the platform's call, as demand is.
     *
     * It was the app's: this hour against twice the median of the six before it, with a
     * floor of fifty packets. Two numbers this app chose, deciding whether the applications
     * feel the network — which is the strongest single piece of evidence in this whole
     * reading. `AutoAdaptiveAnomalyDetectionAnalyzer` learns the spread of the signal
     * itself and answers the same question without either number.
     */
    retransmissionsRose: platform?.retransmitted?.analysed ? platform.retransmitted.alerted : null,
    roundTripRose: platform?.roundTrip?.analysed ? platform.roundTrip.alerted : null,
    risingVerdictFrom: platform?.retransmitted?.analysed
      ? "Dynatrace AutoAdaptiveAnomalyDetectionAnalyzer, alertCondition ABOVE, on the same series the figures below are read from"
      : "not answered yet: treat the rise as unjudged and never call it rising on your own",
    applicationsNetwork: s.app ? (() => {
      const a = s.app!, n = model.appNet!;
      const clock = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
      const last = n.retrPct.length - 2;
      return {
        source: `OneAgent ${n.source === "flows" ? "network flows" : "process network metrics"} (TCP), whole environment`,
        retransmittedPct: { last10min: a.now, usual: a.usual, rising: a.rising, since: a.startAt ? clock(a.startAt) : null },
        roundTripMs: { measure: n.rttKind === "p90" ? "90th percentile" : "average", last10min: a.rttNow, usual: a.rttUsual, rising: a.rttRising },
        workloadsWhereItRose: a.workloads,
        // settled 10-minute buckets of the last two hours, labelled
        recent: n.retrPct.slice(Math.max(0, last - 11), last + 1).map((v, i) => ({ at: clock(n.start + (Math.max(0, last - 11) + i) * n.interval), retransmittedPct: v })),
      };
    })() : "no OneAgent network flows in this environment",
    /**
     * Whether demand fell is the platform's call, not this app's.
     *
     * It used to be `drop.dropped`: the last complete hour against the median of the same
     * hour over seven days, below a percentage the customer sets. That is a baseline this
     * app invented, and it disagrees with the platform's — measured here while the header
     * read 47% of usual, `SeasonalBaselineAnomalyDetectionAnalyzer` analysed the same series
     * and raised nothing. The percentage below is kept because it is a measurement; the
     * verdict is the analyzer's, and where the analyzer has not answered the field says so
     * rather than falling back to the app's own rule.
     */
    demandFell: demand?.analysed ? demand.alerted : null,
    demandVerdictFrom: demand?.analysed
      ? "Dynatrace SeasonalBaselineAnomalyDetectionAnalyzer, alertCondition BELOW, on the same series"
      : "not answered yet: treat demand as unjudged, and never call the percentage a fall on your own",
    demand: drop.source ? {
      source: drop.source === "sessions" ? "real user sessions" : "requests served by the services",
      counted: s.scope === "site" ? "for the whole environment (no per-site curve yet)" : "for the whole environment",
      seasonalBaselineAlerts: demand?.alerts ?? [],
      lastCompleteHour: {
        hour: hourLabel(src?.nowIndex ?? series.length - 2), value: drop.now, usual: drop.typical, pctOfUsual: drop.pct,
        /* the app's own comparison, kept as a measurement and labelled as one: the median of
           that hour over seven days, which is not the platform's seasonal model */
        againstTheMedianOfThatHourOverSevenDays: drop.pct != null ? `${drop.pct}%` : null,
      },
      // only settled hours: the ones after it are still filling
      hourly: series.slice(0, (src?.nowIndex ?? series.length - 2) + 1).map((v, i) => ({ hour: hourLabel(i), value: v, usual: usual[i] ?? null })),
      trafficAnomalyAlertFired: u?.anomalyWatched ?? false,
    } : "no user sessions and no service requests in this environment",
    // what this reading could and could not use, so "what is missing" names real gaps and not a wish list
    sources: {
      userSessions: u && u.series.length ? "received" : "not received",
      serviceRequests: u?.requests ? "received" : "not received",
      siteAttribution: u && u.total ? `${u.mapped} of ${u.total} sessions map to a site (site_cidr tag or a device /24)` : "not possible without sessions",
      trafficAnomalyDetection: u?.anomalyWatched ? "a traffic anomaly problem is open" : "no traffic anomaly problem open now (detection may still be configured)",
      perSiteDemandCurve: "not available yet: demand is read for the whole environment",
      networkFlowsFromHosts: model.appNet ? "received (OneAgent network flows)" : "not received: OneAgent network monitoring would show whether the applications feel the network",
    },
    appReading: { kind: s.kind, headline: s.headline, facts: s.facts },
  };
}

export function siteContext(model: NetworkModel, info: SiteInfo) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    site: siteFacts(info),
    devices: info.devices.map((d) => ({ name: d.name, role: d.role, status: d.verdict, reasons: d.reasons.map((r) => r.text), unreachableSince: d.unreachableSince, openAlerts: (d.problems ?? []).filter((x) => !x.muted).map((x) => x.name), cpu: d.cpuNow, ping: pingFacts(d) })),
    endToEndPath: info.path?.hops.map((h) => ({ layer: h.layer, title: h.title, status: h.verdict, reason: h.topReason, consequenceOnly: h.consequenceOnly })) ?? [],
    recentEvents: info.devices.flatMap((d) => d.events.map((e) => ({ device: d.name, time: e.t, level: e.level, text: e.text }))).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 20),
    traffic: siteTrafficFacts(model, info.code),
  };
}

/** NetFlow of the last hour at one site, in the units an operator reads, with the app's own findings. */
function siteTrafficFacts(model: NetworkModel, code: string) {
  const f = model.flowMap, t = f?.sites[code];
  if (!f || !t) return "no NetFlow from this site's devices";
  const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
  return {
    window: "last hour", exporters: t.exporters, total: gb(t.bytes), flows: t.flows,
    split: { otherSites: gb(t.toSites), internet: gb(t.internet), privateRangesNoSiteClaims: gb(t.private), insideTheSite: gb(t.local) },
    talksTo: t.peers.map((p) => ({ peer: p.kind === "site" ? model.sites[p.site!]?.name ?? p.name : p.name, kind: p.kind, volume: gb(p.bytes), flows: p.flows })),
    applications: t.apps.map((a) => ({ app: a.name ?? `${a.proto}/${a.port}`, port: `${a.proto}/${a.port}`, volume: gb(a.bytes), flows: a.flows })),
    insights: trafficInsights(t, f, code),
  };
}

/** The Traffic page: sources, heaviest paths, findings, and how the applications feel it. */
export function trafficContext(model: NetworkModel, site?: string) {
  const f = model.flowMap;
  const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
  const j = f ? buildJourney(f.conversations, model.sites, { site }) : null;
  const label = (id: string) => j?.nodes.find((n) => n.id === id)?.label ?? id;
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    scope: site ? { site: model.sites[site]?.name ?? site } : "the whole network",
    window: "last hour",
    sources: {
      netflow: f?.sources.netflow ? `${f.sources.netflow.exporters} exporters, ${gb(f.sources.netflow.bytes)}` : "not received",
      oneAgent: model.appNet ? model.appNet.source : "not received",
      siteAddressRanges: f ? `${f.subnetsTagged} site_cidr ranges tagged, ${f.subnetsKnown} subnets known in total` : "n/a",
    },
    heaviestPaths: j ? j.links.filter((l) => j.nodes.find((n) => n.id === l.from)?.col === 1).sort((a, b) => b.bytes - a.bytes).slice(0, 8)
      .map((l) => ({ through: label(l.from), to: label(l.to), volume: gb(l.bytes), count: l.count })) : [],
    sourcesOfTraffic: j ? j.nodes.filter((n) => n.col === 0).sort((a, b) => b.bytes - a.bytes).map((n) => ({ from: n.label, kind: n.kind, volume: gb(n.bytes) })) : [],
    findings: environmentFindings(model).filter((x) => !site || x.site === site).map((x) => x.text),
    retransmissionsByWorkload: (model.appNet?.workloads ?? []).slice(0, 8).map((w) => ({ workload: w.name, lastHourPct: w.retrNow, usualPct: w.retrUsual })),
    // path quality: each workload and the network at the other end, worst first
    paths: (model.paths ?? []).filter((p) => !site || p.remoteSite === site)
      .sort((a, b) => ((b.retrPct ?? 0) * 10 + (b.rttP90Ms ?? 0) / 10) - ((a.retrPct ?? 0) * 10 + (a.rttP90Ms ?? 0) / 10)).slice(0, 10)
      .map((p) => ({ workload: p.workload, role: p.server ? "serves" : "calls", otherEnd: p.remoteKind === "site" ? model.sites[p.remoteSite!]?.name ?? p.remoteSite : p.remoteKind === "internet" ? `Internet ${p.remoteNet}` : p.remoteNet, service: p.app, conversations: p.conversations, roundTripP90Ms: p.rttP90Ms, retransmittedPct: p.retrPct, resets: p.resets })),
    // the busiest ports, with what the exporter saw on them
    busyPorts: model.devices.flatMap((d) => d.interfaces.filter((i) => (i.util ?? 0) >= 80).map((i) => ({ device: d.name, port: i.name, utilizationPct: Math.round(i.util!), users: portUsers(model, d, i.name).slice(0, 4) }))).filter((p) => p.users.length).slice(0, 6),
  };
}

export function deviceContext(model: NetworkModel, d: NetworkModel["devices"][number], sitesDependingOnIt: number) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    device: { name: d.name, role: d.role, vendor: d.vendor, site: model.sites[d.site]?.name ?? d.site, status: d.verdict, reasons: d.reasons.map((r) => r.text), cpuNow: d.cpuNow, cpuSeries: d.cpu, availabilityPct: d.availPct, unreachableSince: d.unreachableSince, openAlerts: (d.problems ?? []).filter((x) => !x.muted).map((x) => ({ id: x.displayId || x.eventId, name: x.name, category: x.category, on: x.on })), syslogErrors24h: d.syslog.ERROR, traps: d.traps },
    sitesDependingOnIt,
    ping: pingFacts(d),
    interfaces: d.interfaces.filter((i) => i.uplink || i.flag || i.errors || i.crc).map((i) => ({ name: i.name, oper: i.oper, speedMbps: i.speed, utilPct: i.util, errors: i.errors, crc: i.crc })),
    recentEvents: d.events.slice(0, 15).map((e) => ({ time: e.t, level: e.level, mnemonic: e.mnemonic, text: e.text })),
  };
}

/**
 * The device estate as the Devices page shows it, for the questions asked there.
 *
 * The page had one question on it, about syslog, answered from `changeContext` — so the two
 * things the page actually puts on screen, the status counts and the twenty devices that are
 * discovered but never polled, could not be asked about at all. This hands over what the page
 * draws: the roles the bubbles are grouped by, the devices carrying an open alert, and the
 * ones no extension collects from, grouped by the extension that would cover them, which is
 * the only form of that answer a reader can act on.
 */
export function devicesContext(model: NetworkModel, region?: string | null) {
  const inScope = model.devices.filter((d) => !region || (model.sites[d.site]?.region ?? null) === region);
  const by = <T extends string>(pick: (d: NetworkModel["devices"][number]) => T) =>
    Object.fromEntries([...inScope.reduce((m, d) => m.set(pick(d), (m.get(pick(d)) ?? 0) + 1), new Map<T, number>())]);
  const site = (d: NetworkModel["devices"][number]) => model.sites[d.site]?.name ?? d.site;
  const open = (d: NetworkModel["devices"][number]) => (d.problems ?? []).filter((x) => !x.muted && !x.maintenance);
  const alerting = inScope.filter((d) => open(d).length);
  const dark = inScope.filter((d) => d.verdict === "Not monitored");
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    scope: region ? `region ${region}` : "every region",
    devices: inScope.length,
    byStatus: by((d) => d.verdict),
    byRole: by((d) => d.role || "other"),
    byVendor: by((d) => d.vendor || "unknown"),
    /* the alerted ones, worst first, each with what Dynatrace has open on it and how much of
       the estate sits behind it — `impact` is the app's own count of dependent sites */
    alerting: alerting
      .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0))
      .slice(0, 12)
      .map((d) => ({
        device: d.name, role: d.role, vendor: d.vendor, site: site(d), status: d.verdict,
        sitesBehindIt: d.impact ?? 0,
        notRespondingSince: d.unreachableSince ?? null,
        rebootedAt: d.rebootedAt ?? null,
        alerts: open(d).map((x) => ({
          id: x.displayId || x.eventId, name: x.name, category: x.category, since: x.start,
          on: x.on ?? null, rootCause: !!x.rootCause,
          /* the distinction the app refuses to blur: a monitor that stopped running is a
             statement about the measurement, not about the device */
          aboutTheMonitorNotTheDevice: !!x.viaMonitor,
        })),
        interfaceErrors: d.ifStats?.errors ?? null,
        interfaceDiscards: d.ifStats?.discards ?? null,
      })),
    notResponding: inScope.filter((d) => d.unreachableSince)
      .slice(0, 10).map((d) => ({ device: d.name, site: site(d), since: d.unreachableSince })),
    reachability: estatePing(model),
    /**
     * Discovered, never polled — and what would change that.
     *
     * Grouped by the extension the discovery configuration would have used, because that is
     * the unit of the fix: one extension covers every device it found, and a list of twenty
     * device names is not something anybody can act on.
     */
    discoveredNotPolled: {
      devices: dark.length,
      byExtension: Object.fromEntries([...dark.reduce((m, d) => {
        const k = d.defaultExtension || d.discoveredBy || "no extension named";
        return m.set(k, (m.get(k) ?? 0) + 1);
      }, new Map<string, number>())]),
      examples: dark.slice(0, 8).map((d) => ({ device: d.name, role: d.role, vendor: d.vendor, site: site(d), extensionThatWouldCoverIt: d.defaultExtension ?? null })),
      whatItHides: "CPU, memory, ports, availability and alerts: a discovered device reports none of them until its extension polls it",
    },
    /* ports in trouble now, which is the one device-level reading that is a fault rather than
       evidence of load — the page's own bubbles carry it */
    carryingInterfaceErrors: inScope.filter((d) => (d.ifStats?.errors ?? 0) > 0 || (d.ifStats?.discards ?? 0) > 0)
      .sort((a, b) => ((b.ifStats?.errors ?? 0) + (b.ifStats?.discards ?? 0)) - ((a.ifStats?.errors ?? 0) + (a.ifStats?.discards ?? 0)))
      .slice(0, 8)
      .map((d) => ({ device: d.name, site: site(d), errors: d.ifStats?.errors ?? 0, discards: d.ifStats?.discards ?? 0, portsPolled: d.ifStats?.interfaces ?? d.ifCount })),
  };
}

/**
 * What the devices reported as having changed, for the question that replaced the panel.
 *
 * `changesOf` already folds the raw syslog counts into one row per port or device, so this
 * hands over the shortlist and not the thirteen thousand lines it was computed from.
 */
export function changeContext(model: NetworkModel) {
  const all = changesOf(model);
  const counted = all.filter((c) => c.events && c.events > 1);
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    window: "last 24 hours",
    totalChanges: all.reduce((n, c) => n + (c.events ?? c.members?.length ?? 1), 0),
    byKind: Object.fromEntries([...all.reduce((m, c) => m.set(CHANGE_LABEL[c.kind],
      (m.get(CHANGE_LABEL[c.kind]) ?? 0) + (c.events ?? c.members?.length ?? 1)), new Map<string, number>())]),
    busiest: counted.sort((a, b) => (b.events ?? 0) - (a.events ?? 0)).slice(0, 12)
      .map((c) => ({ what: c.title, where: c.detail, times: c.events, lastAt: c.t })),
    alerts: all.filter((c) => c.kind.startsWith("alert")).slice(0, 6)
      .map((c) => ({ what: c.title, where: c.detail, at: c.t })),
  };
}

export function carrierContext(model: NetworkModel, carrier: string | null, circuits: NonNullable<NetworkModel["circuits"]>) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    carrier: carrier ?? "all carriers",
    circuits: circuits.length,
    down: circuits.filter((c) => c.status === "down").map((c) => ({ circuitId: c.id, carrier: c.carrier, site: c.siteName, region: model.sites[c.site]?.region, kind: c.kind, tech: c.tech, since: c.since, incident: c.incident })),
    overSla: circuits.filter((c) => c.status === "up" && isBad(c.verdict)).map((c) => ({ circuitId: c.id, carrier: c.carrier, site: c.siteName, kind: c.kind, latencyMs: c.latencyMs, slaMs: c.slaMs, lossPct: c.lossPct, jitterMs: c.jitterMs })),
    // each carrier against the SLA tagged on its own circuits, so the comparison is like for like
    byCarrier: [...new Set(circuits.map((c) => c.carrier))].map((name) => {
      const own = circuits.filter((c) => c.carrier === name);
      const up = own.filter((c) => c.status === "up" && c.latencyMs != null);
      const ratios = up.map((c) => c.latencyMs! / c.slaMs).sort((a, b) => a - b);
      const ms = up.map((c) => c.latencyMs!).sort((a, b) => a - b);
      const at = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
      const median = at(ratios, 0.5);
      return {
        name, links: own.length,
        down: own.filter((c) => c.status === "down").length,
        overSla: own.filter((c) => c.status === "up" && isBad(c.verdict)).length,
        slaMs: [...new Set(own.map((c) => c.slaMs))],
        medianLatencyMs: at(ms, 0.5), worstLatencyMs: at(ms, 0.95),
        medianPctOfSla: median == null ? null : Math.round(median * 100),
      };
    }),
  };
}

/**
 * What Ahead knows, for Assist to answer out of instead of the page explaining itself in prose.
 *
 * The context carries the counts, the events and the reasons for silence, because the hard part of
 * this page is not the numbers — it is what they are allowed to mean. A level change is not a
 * forecast; a discard counter that stopped rising is not a cure; "nothing to say" is the normal
 * state of a healthy thing and not a gap in the data. Those distinctions were paragraphs on the
 * screen, and a paragraph nobody asked for is a paragraph nobody reads.
 */
export function aheadContext(model: NetworkModel, forecasts: Map<string, DavisForecast> = new Map()) {
  const subjects = aheadSubjects(model);
  const { counts, why, total } = aheadCensus(subjects);
  const { events, singles } = clusterChanges(subjects.filter((s) => s.reading.state === "changed"));
  /**
   * When the analyzer's forecast reaches the limit, and how wide its own band leaves that date.
   *
   * The date here used to come from a least-squares line this app fitted — the same line the
   * page was freed from when it started drawing the platform's forecast, still being quoted to
   * Assist as "between 9 and 14 days". The band is the analyzer's: the soonest date is where
   * its upper bound crosses, the latest where its lower bound does, and a forecast that stays
   * under the limit for its whole horizon says that instead of naming a day.
   */
  const dayAt = (series: number[] | undefined) => {
    const i = series?.findIndex((v) => v >= 100) ?? -1;
    return i < 0 ? null : Math.max(1, Math.ceil((i + 1) / 24));
  };
  const reachesIn = (key: string): string => {
    const f = forecasts.get(key);
    if (!f || !f.point.length) return "the analyzer has no forecast for this one";
    const mid = dayAt(f.point), soon = dayAt(f.upper), late = dayAt(f.lower);
    if (mid == null && soon == null) return "the forecast stays under the limit for its whole horizon";
    if (mid == null) return `the forecast stays under the limit, its upper bound reaches it in ${soon} days`;
    return soon != null && late != null && soon !== late ? `between ${soon} and ${late} days`
      : `in ${mid} days`;
  };
  const say = (s: Subject) => ({
    what: s.name, site: s.site || "untagged", against: s.limit,
    nowPctOfLimit: Math.round(s.reading.now),
    reaches: reachesIn(s.key),
    steppedDaysAgo: s.reading.step ? s.reading.step.ago : null,
    stepPoints: s.reading.step ? Math.round(s.reading.step.to - s.reading.step.from) : null,
    discardsRisenBy: s.reading.drops || null,
  });
  const top = (state: string, n = 6) => subjects.filter((s) => s.reading.state === state).slice(0, n).map(say);
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    window: "30 daily samples per subject",
    method: {
      subjects: "one processor and one uplink per device, each measured against a limit its owner stated: "
        + "saturation for a processor, the published line rate for a port",
      notCovered: "WAN circuits, because a contracted rate exists in no documented Dynatrace format; "
        + "and any port that publishes no line rate, which is roughly half of a real estate",
      step: "a level change is accepted only when two levels explain the record better than one straight line",
      trend: "a slope counts only when it beats its own standard error, and is fitted after any step",
      horizon: "never further ahead than twice the length of the record",
    },
    counts: { ...counts, measured: total },
    dropping: top("dropping"),
    changed: {
      onDays: events.length, alone: singles.length,
      biggest: events.slice(0, 4).map((e) => ({
        daysAgo: e.ago, subjects: e.members.length, sites: e.sites,
        medianPoints: Math.round(e.median), up: e.up, down: e.down,
      })),
    },
    oneJumpAway: top("onejump", 4),
    climbing: top("climbing"),
    silent: why,
    /**
     * The anticipation reading, which the context did not carry.
     *
     * Every question this panel asks is meant to be about getting ahead of a problem, and on an
     * estate with no crossings the only forward-looking quantity that exists for every subject
     * is its room. Without it here the answers could only describe what already happened. Each
     * entry also carries the largest rise the subject has itself shown, because room smaller
     * than a jump it has already made is the one anticipation the record fully supports.
     */
    room: subjects.filter((x) => x.room).sort((a, b) => a.room!.pts - b.room!.pts).slice(0, 12).map((x) => ({
      what: x.name, site: x.site || "untagged", onDevice: x.device?.name ?? x.sub,
      measuredAgainst: x.room!.source === "shown" ? "the level it has been seen to discard at" : x.limit,
      busyHourPctOfLimit: Math.round(x.room!.busy * 10) / 10,
      pointsOfRoomLeft: Math.round(x.room!.pts * 10) / 10,
      biggestRiseItHasShown: Math.round(x.reading.jump * 10) / 10,
      roomSmallerThanItsOwnJump: x.room!.pts < x.reading.jump,
      /* the analyzer's own rise over its first day, not a slope of this app's */
      pointsPerDay: (() => { const f = forecasts.get(x.key); return f && f.point.length > 23 ? Math.round((f.point[23] - f.point[0]) * 100) / 100 : null; })(),
    })),
    roomCovers: subjects.filter((x) => x.room).length,
    /**
     * The site level, which the context did not carry.
     *
     * Every question here is meant to help someone get ahead of a problem, and the answer to
     * "where should capacity go" is usually a place rather than a port — but the panel could
     * only see ports, so it could rank them and never say "the pressure is at LEM". Room has
     * no meaning summed across a site (the sum of line rates is a capacity nobody carries), so
     * what a site gets is the count of tight subjects it holds and the least room among them.
     */
    sites: Object.values(subjects.filter((x) => x.room && x.site).reduce((acc, x) => {
      const k = x.site;
      const at = acc[k] ?? (acc[k] = { site: model.sites[k]?.name || k, subjects: 0, leastRoomPoints: Infinity, tightest: "" });
      at.subjects += 1;
      if (x.room!.pts < at.leastRoomPoints) { at.leastRoomPoints = Math.round(x.room!.pts * 10) / 10; at.tightest = x.name; }
      return acc;
    }, {} as Record<string, { site: string; subjects: number; leastRoomPoints: number; tightest: string }>))
      .sort((a, b) => a.leastRoomPoints - b.leastRoomPoints),
  };
}
