// Drill-downs into the native Dynatrace apps. Each one targets the app and intent registered for that
// kind of component (intent ids and payload properties read from the environment's intent registry),
// with the entity id or query as payload, so the user lands on the exact device, interface, monitor,
// problem or data. Other apps open in a dedicated browser tab, so the user keeps this app; Dynatrace Assist
// opens in the same tab.
import { getAppLink, getIntentLink, openApp, sendIntent, type IntentPayload } from "@dynatrace-sdk/navigation";

const APPS = {
  problems: "dynatrace.davis.problems",
  infra: "dynatrace.infraops",
  logs: "dynatrace.logs",
  notebooks: "dynatrace.notebooks",
  synthetic: "dynatrace.synthetic",
  assist: "dynatrace.davis.copilot",
} as const;

export const APP_ID = "my.net.o11y";

export type NativeApp = keyof typeof APPS;

/** Relative timeframe in the format documented for intents: { from: 'now-2h', to: 'now' }. */
const lastHours = (hours: number) => ({ from: `now-${hours}h`, to: "now" });

/** Links only resolve inside the Dynatrace AppShell; outside it (local detached mode) the SDK returns a placeholder. */
const isEnvironmentLink = (url: string) => /\/ui\//.test(url);

function openInNewTab(url: string, fallback: () => void) {
  if (!isEnvironmentLink(url)) { fallback(); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

function openIntent(payload: IntentPayload, appId: string, intentId: string) {
  openInNewTab(getIntentLink(payload, appId, intentId), () => sendIntent(payload, { recommendedAppId: appId, recommendedIntentId: intentId }));
}

export function openNative(app: NativeApp) {
  openInNewTab(getAppLink(APPS[app]), () => openApp(APPS[app]));
}

/**
 * The network device list in Infrastructure & Operations, on the Network devices explorer and sorted by
 * health: the app home opens on Hosts, which is not what this app's buttons are about.
 */
export function openInfraDevices() {
  const base = getAppLink(APPS.infra);
  if (!isEnvironmentLink(base)) { openApp(APPS.infra); return; }
  openInNewTab(`${base.replace(/\/+$/, "")}/explorer/Network/Network%20devices?perspective=Health&sort=healthIndicators%3Adescending`, () => openApp(APPS.infra));
}

/** Any DQL query: lets the platform offer every app that handles dt.query. */
export function openQuery(query: string) {
  openInNewTab(getIntentLink({ "dt.query": query }), () => sendIntent({ "dt.query": query }));
}

/** A network device in Infrastructure & Operations (Smartscape node EXT_NETWORK_DEVICE-…). */
export function openDevice(nodeId: string, hours = 2) {
  openIntent({ nodeId, "dt.timeframe": lastHours(hours) }, APPS.infra, "view_smartscape_network_device");
}

/** A network interface in Infrastructure & Operations (Smartscape node EXT_NETWORK_INTERFACE-…). */
export function openInterface(nodeId: string, hours = 2) {
  openIntent({ nodeId, "dt.timeframe": lastHours(hours) }, APPS.infra, "view_smartscape_network_interface");
}

/** The ICMP network availability monitor of a WAN circuit or device in Synthetic (MULTIPROTOCOL_MONITOR-…). */
export function openMonitor(monitorId: string, hours = 24) {
  openIntent({ "dt.entity.multiprotocol_monitor": monitorId, "dt.timeframe": lastHours(hours) }, APPS.synthetic, "view_network_availability_monitor");
}

/** A Davis problem in the Problems app. */
export function openProblem(eventId: string, eventKind = "DAVIS_PROBLEM") {
  openIntent({ "event.id": eventId, "event.kind": eventKind }, APPS.problems, "view-problem");
}

/** A log query in the Logs app. */
export function openLogs(query: string, hours?: number) {
  openIntent({ "dt.query": query, ...(hours ? { "dt.timeframe": lastHours(hours) } : {}) }, APPS.logs, "view_query");
}

/** A query in Notebooks. */
export function openNotebook(query: string, title?: string) {
  openIntent({ "dt.query": query, ...(title ? { title } : {}) }, APPS.notebooks, "view-query");
}

/**
 * Continue in Dynatrace Assist (conversation starter): short visible prompt, the evidence as hidden
 * supplementary context (limit 100K characters), and this app as origin. Assist opens in the same tab,
 * as a panel over this app, so the conversation stays next to the evidence.
 */
export function openAssist(prompt: string, context: unknown) {
  sendIntent({
    prompt,
    execute: true,
    contexts: [
      { type: "supplementary", value: JSON.stringify(context).slice(0, 90000) },
      { type: "instruction", value: "Answer as a senior network operations analyst, in short bullet points, from the supplementary context first." },
      { type: "origin-app", value: APP_ID },
    ],
  }, { recommendedAppId: APPS.assist, recommendedIntentId: "ask-question" });
}

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** Hours to look back so the window starts just before `since` (1 to 24 h). */
export function hoursBack(since?: string | null) {
  if (!since) return 3;
  const t = Date.parse(since.length === 17 ? since.replace("Z", ":00Z") : since);
  return Number.isNaN(t) ? 3 : Math.min(24, Math.max(1, Math.ceil((Date.now() - t) / 3.6e6) + 1));
}

/** Syslog and SNMP traps of the given device IPs, same source filters as the app's own queries. */
export function logsQuery(ips: string[], since?: string | null) {
  const list = ips.map(quote).join(", ");
  const bySource = ips.length
    ? ` and (in(dt.ingest.source.ip, array(${list})) or in(device.address, array(${list})))`
    : "";
  return [
    `fetch logs, from:now()-${hoursBack(since)}h`,
    `| filter (dt.openpipeline.source == "extension:syslog" or log.source == "snmptraps")${bySource}`,
    "| sort timestamp desc",
    "| fields timestamp, dt.ingest.source.ip, device.address, loglevel, syslog.appname, snmp.trap_oid, content",
  ].join("\n");
}

/** Synthetic ICMP reachability and round trip of the given target IPs over 24 hours. */
export function deviceMetricsQuery(ips: string[]) {
  const byIp = ips.length ? `\n| filter in(request.target_address, array(${ips.map(quote).join(", ")}))` : "";
  return "timeseries {rtt=avg(dt.synthetic.multi_protocol.icmp.round_trip_time), sent=sum(dt.synthetic.multi_protocol.icmp.packets_sent), recv=sum(dt.synthetic.multi_protocol.icmp.packets_received)}, by:{request.target_address}, from:now()-24h, interval:5m" + byIp;
}

/** CPU of the given devices over the last hours. */
export function deviceHealthQuery(nodeIds: string[], hours = 24) {
  const byId = nodeIds.length ? `, filter:{in(dt.smartscape.ext_network_device, array(${nodeIds.map((id) => `toSmartscapeId(${quote(id)})`).join(", ")}))}` : "";
  return `timeseries cpu = avg(com.dynatrace.extension.network_device.cpu_usage), by:{dt.smartscape.ext_network_device}${byId}, from:now()-${hours}h`;
}

/** Latency, loss and SLA of the given WAN circuits (by circuit tag) over 24 hours. */
export function circuitMetricsQuery(circuitIds: string[]) {
  const byId = circuitIds.length ? `, filter:{in(primary_tags.circuit_id, array(${circuitIds.map(quote).join(", ")}))}` : "";
  return `timeseries {rtt=avg(dt.synthetic.multi_protocol.icmp.round_trip_time), sent=sum(dt.synthetic.multi_protocol.icmp.packets_sent), recv=sum(dt.synthetic.multi_protocol.icmp.packets_received)}, by:{primary_tags.circuit_id, primary_tags.carrier, primary_tags.sla_ms}${byId}, from:now()-24h, interval:5m`;
}
