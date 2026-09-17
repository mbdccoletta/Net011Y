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
  "You are a senior network operations analyst.",
  "Answer only from the supplementary context. Status there comes from the problems and alerts Dynatrace has open on the network entities; the numbers come from SNMP, syslog, traps, synthetic ICMP and application sessions.",
  "Name the open problem that explains the situation, quantify the impact, and give concrete next steps.",
  "Use at most 5 short bullet points in Markdown. Do not invent devices, carriers or numbers.",
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
  wanLinks: s.circuits.map((c) => ({ kind: c.kind, carrier: c.carrier, tech: c.tech, status: c.status, latencyMs: c.latencyMs, slaMs: c.slaMs, lossPct: c.lossPct, since: c.since })),
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
  return {
    dataSource: model.demo ? "simulated example network" : `Dynatrace environment ${model.meta.tenant}`,
    generatedAt: model.meta.generatedAt,
    sites: infos.length,
    sitesWithIssues: infos.filter((i) => isBad(i.verdict)).length,
    devices: model.devices.length,
    causes: causes.map((c) => ({ title: c.title, kind: c.kind, status: c.verdict, since: c.since, impact: c.impact, incident: c.incident })),
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
    down: circuits.filter((c) => c.status === "down").map((c) => ({ site: c.siteName, region: model.sites[c.site]?.region, kind: c.kind, tech: c.tech, since: c.since, incident: c.incident })),
    overSla: circuits.filter((c) => c.status === "up" && isBad(c.verdict)).map((c) => ({ site: c.siteName, kind: c.kind, latencyMs: c.latencyMs, slaMs: c.slaMs, lossPct: c.lossPct, jitterMs: c.jitterMs })),
    byCarrier: [...new Set(circuits.map((c) => c.carrier))].map((name) => ({ name, links: circuits.filter((c) => c.carrier === name).length, down: circuits.filter((c) => c.carrier === name && c.status === "down").length })),
  };
}
