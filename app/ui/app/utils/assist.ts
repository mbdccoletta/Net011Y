// Dynatrace Assist writes every explanation in the app. The app only sends the facts it has
// already computed (cause, impact, evidence, timeline) as supplementary context.
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";
import type { NetworkModel } from "../model/types";
import type { Cause } from "../model/causes";
import type { SiteInfo } from "../model/site";
import { isBad } from "../model/verdict";

export interface AssistAnswer {
  text: string;
  status: "SUCCESSFUL" | "SUCCESSFUL_WITH_WARNINGS" | "FAILED";
}

const INSTRUCTION = [
  // The contract the answers are held to. It mirrors how the app itself decides things, so the text on
  // screen and the text from Assist can never contradict each other.
  "You are a senior network operations analyst writing for an operator on shift who is looking at this exact screen.",
  "Answer only from the supplementary context. It is the complete set of facts available; anything not in it is not reported, and you say so instead of estimating, averaging or assuming.",
  "Status comes from the problems and alerts Dynatrace has open on the network entities. Counters (CPU, interface utilization, errors, discards, availability, syslog, traps) are evidence for an alert, never a verdict on their own: never call an element unhealthy because a counter looks high, and never call an alert a false positive.",
  "The single exception is WAN latency against the sla_ms tag the customer set on that circuit: latency above that number is a real breach, and each carrier is judged against its own SLA.",
  "An element with no open alert is not healthy by proof, it is simply not alerting; an element that reports nothing is 'not monitored'. Say which of the two it is.",
  "Name entities exactly as the context spells them, keep problem ids (P-…), timestamps and units as given, and prefer the specific element (this interface, this circuit id, this monitor) over the general one.",
  "Never invent devices, sites, carriers, interfaces, ids, numbers or times. Never recommend enabling data the context shows as already arriving.",
  "Write in the language of the question. Be concrete and short: an operator reads this while the incident is open.",
].join(" ");

export async function askAssist(question: string, context: unknown, abortSignal?: AbortSignal): Promise<AssistAnswer> {
  const res = await publicClient.recommenderConversation({
    abortSignal,
    body: {
      text: question,
      context: [
        { type: "supplementary", value: JSON.stringify(context) },
        { type: "instruction", value: INSTRUCTION },
        { type: "document-retrieval", value: "disabled" },
      ],
    },
  });
  if (Array.isArray(res)) {
    const text = res.map((e) => {
      const data = (e as { data?: { text?: string; content?: string } }).data;
      return e.event === "content" ? data?.text ?? data?.content ?? "" : "";
    }).join("");
    return { text, status: text ? "SUCCESSFUL" : "FAILED" };
  }
  return { text: res.text, status: res.status };
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
