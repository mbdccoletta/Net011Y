// Dynatrace Assist writes every explanation in the app. The app only sends the facts it has
// already computed (cause, impact, evidence, timeline) as supplementary context.
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";
import type { DeviceProblem, NetworkModel } from "../model/types";
import type { Cause } from "../model/causes";
import { trafficDrop, type Suspicion } from "../model/suspicion";
import type { SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";

export interface AssistAnswer {
  text: string;
  status: "SUCCESSFUL" | "SUCCESSFUL_WITH_WARNINGS" | "FAILED";
}

export const INSTRUCTION = [
  // The contract the answers are held to, mirroring how the app itself decides things. Kept short on
  // purpose: Assist refuses an instruction context over 2500 characters, and each question adds its own.
  "You are a senior network operations analyst answering an operator on shift about the screen in front of them.",
  "Use only the supplementary context; anything missing from it is not reported — say so, never estimate.",
  "Status comes only from problems and alerts Dynatrace has open. Counters (CPU, utilization, errors, availability, syslog, traps) are evidence, never a verdict.",
  "The one exception: WAN latency above the sla_ms tag of that circuit is a breach, each carrier judged against its own SLA.",
  "No open alert means not alerting, not proven healthy; no data means not monitored.",
  "Keep entity names, problem ids, times and units exactly as given, and never invent devices, sites, carriers, ids, numbers or times.",
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
    originDevices: cause.devices.slice(0, 10).map((d) => ({ name: d.name, role: d.role, status: d.verdict, reasons: d.reasons.map((r) => r.text), cpu: d.cpuNow })),
    openAlerts: [...new Map(cause.sites.flatMap((s) => s.devices).flatMap((d) => (d.problems ?? []).filter((x) => !x.muted).map((x) => [x.eventId, x] as const))).values()]
      .slice(0, 10).map((x) => ({ id: x.displayId || x.eventId, name: x.name, category: x.category, on: x.on, since: x.start })),
    evidence: cause.evidence.map((e) => ({ time: e.t, source: e.source, level: e.level, text: e.text })),
    timeline: cause.timeline.map((m) => ({ time: m.t, event: m.label, sites: m.sites.length })),
    sites: cause.sites.slice(0, 40).map(siteFacts),
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
    causes: causes.map((c) => ({
      id: c.id, title: c.title, kind: c.kind, status: c.verdict, since: c.since, impact: c.impact, incident: c.incident,
      devices: c.devices.slice(0, 5).map((d) => d.name),
      carriers: [...new Set(c.sites.flatMap((s) => s.circuits.filter((x) => x.status === "down").map((x) => x.carrier)))],
    })),
  };
}

/**
 * Everything needed to decide whether the network explains what is degraded, and nothing else. Times are
 * kept exactly as the platform reports them, because the order of events is the whole argument.
 */
export function isolationContext(model: NetworkModel, s: Suspicion, info?: SiteInfo, dropPct = 50) {
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
    demandFell: drop.dropped,
    demand: drop.source ? {
      source: drop.source === "sessions" ? "real user sessions" : "requests served by the services",
      counted: s.scope === "site" ? "for the whole environment (no per-site curve yet)" : "for the whole environment",
      threshold: `a fall counts only below ${dropPct}% of what that hour usually holds`,
      lastCompleteHour: {
        hour: hourLabel(series.length - 2), value: drop.now, usual: drop.typical, pctOfUsual: drop.pct, fallBelowThreshold: drop.dropped,
        // said in words as well: left with the numbers alone, the model called 56% of the usual "a fall"
        reading: drop.dropped ? `a fall: below ${dropPct}% of the usual for this hour` : `no fall: at or above ${dropPct}% of the usual for this hour, within the normal range`,
      },
      hourly: series.slice(0, -1).map((v, i) => ({ hour: hourLabel(i), value: v, usual: usual[i] ?? null })),
      trafficAnomalyAlertFired: u?.anomalyWatched ?? false,
    } : "no user sessions and no service requests in this environment",
    // what this reading could and could not use, so "what is missing" names real gaps and not a wish list
    sources: {
      userSessions: u && u.series.length ? "received" : "not received",
      serviceRequests: u?.requests ? "received" : "not received",
      siteAttribution: u && u.total ? `${u.mapped} of ${u.total} sessions map to a site (site_cidr tag or a device /24)` : "not possible without sessions",
      trafficAnomalyDetection: u?.anomalyWatched ? "raising problems" : "not raising problems on these applications",
      perSiteDemandCurve: "not available yet: demand is read for the whole environment",
      networkFlowsFromHosts: "not used in this reading yet",
    },
    appReading: { kind: s.kind, headline: s.headline, facts: s.facts },
  };
}

export function siteContext(model: NetworkModel, info: SiteInfo) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    site: siteFacts(info),
    devices: info.devices.map((d) => ({ name: d.name, role: d.role, status: d.verdict, reasons: d.reasons.map((r) => r.text), unreachableSince: d.unreachableSince, openAlerts: (d.problems ?? []).filter((x) => !x.muted).map((x) => x.name), cpu: d.cpuNow })),
    endToEndPath: info.path?.hops.map((h) => ({ layer: h.layer, title: h.title, status: h.verdict, reason: h.topReason, consequenceOnly: h.consequenceOnly })) ?? [],
    recentEvents: info.devices.flatMap((d) => d.events.map((e) => ({ device: d.name, time: e.t, level: e.level, text: e.text }))).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 20),
  };
}

export function deviceContext(model: NetworkModel, d: NetworkModel["devices"][number], sitesDependingOnIt: number) {
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    device: { name: d.name, role: d.role, vendor: d.vendor, site: model.sites[d.site]?.name ?? d.site, status: d.verdict, reasons: d.reasons.map((r) => r.text), cpuNow: d.cpuNow, cpuSeries: d.cpu, availabilityPct: d.availPct, unreachableSince: d.unreachableSince, openAlerts: (d.problems ?? []).filter((x) => !x.muted).map((x) => ({ id: x.displayId || x.eventId, name: x.name, category: x.category, on: x.on })), syslogErrors24h: d.syslog.ERROR, traps: d.traps },
    sitesDependingOnIt,
    interfaces: d.interfaces.filter((i) => i.uplink || i.flag || i.errors || i.crc).map((i) => ({ name: i.name, oper: i.oper, speedMbps: i.speed, utilPct: i.util, errors: i.errors, crc: i.crc })),
    recentEvents: d.events.slice(0, 15).map((e) => ({ time: e.t, level: e.level, mnemonic: e.mnemonic, text: e.text })),
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
