// Every open problem Dynatrace is raising becomes one entry in the list next to the map, with the blast
// radius (network elements, sites, application sessions), the evidence and the propagation timeline.
// The app does not work out the cause: Davis, the alert templates and the custom alerts do that, and the
// app groups what they raise by the sites and elements the problem touches. The only entry the app adds
// by itself is the SLA the customer configured on the circuits — and a link that stopped answering while
// nothing is alerting on it, which is said in those words.
import type { Circuit, Device, DeviceProblem, NetworkModel, Verdict } from "./types";
import { isBad, ORDER, openProblems, problemLevel, worst } from "./verdict";
import type { SiteInfo } from "./site";
import { hhmm, stripDevice } from "../utils/format";

export type CauseKind = "carrier" | "datacenter" | "device" | "application" | "unknown";

export interface CauseElement {
  id: string;
  label: string;
  kind: "circuit" | "device";
  verdict: Verdict;
  site: string;
}

export interface Evidence {
  id: string;
  t: string | null;
  level: Verdict;
  source: "WAN link" | "Syslog" | "SNMP" | "Trap" | "Application" | "Davis";
  text: string;
  device?: string;
}

export interface Moment {
  t: string;
  label: string;
  level: Verdict;
  sites: string[];
}

export interface Cause {
  id: string;
  kind: CauseKind;
  title: string;
  subtitle: string;
  verdict: Verdict;
  since: string | null;
  layer: string;
  incident: string | null;
  sites: SiteInfo[];
  elements: CauseElement[];
  /** Network devices a user would inspect first (drill-down targets) */
  devices: Device[];
  impact: { sites: number; offline: number; devices: number; sessionsLost: number; sessionsSlowed: number; regions: string[] };
  evidence: Evidence[];
  timeline: Moment[];
  /** When each site became affected; missing means before the observed window */
  affectedAt: Record<string, string>;
}

const earliest = (ts: (string | null | undefined)[]) => ts.filter((t): t is string => !!t).sort()[0] ?? null;
const shortDevice = (name: string) => name.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "");

/** The layer a problem belongs to, from the entities it affects and the category Davis gave it. */
function layerOf(kind: CauseKind, category?: string): string {
  if (kind === "carrier") return "Carrier";
  if (kind === "datacenter") return "Data center";
  if (kind === "application") return "Application";
  return category === "SLOWDOWN" ? "Performance" : "Access";
}

interface Scope {
  id: string;
  title: string;
  category?: string;
  start: string | null;
  incident: string | null;
  devices: Device[];
  circuits: Circuit[];
  level: Verdict;
  /** shown under the title, before the site count */
  note?: string;
}

export function buildCauses(model: NetworkModel, infos: SiteInfo[]): Cause[] {
  const byCode = new Map(infos.map((i) => [i.code, i]));
  const circuits = model.circuits ?? [];

  // 1. One scope per open Davis problem, from the entities it affects. Events that never became a problem
  // are grouped by what they are and where they are: an environment whose ports flap raises thousands of
  // "Interface operationally going down" events (fxz0998d: about 4000), and one entry each made a list of
  // four thousand identical lines.
  const groups = new Map<string, { p: DeviceProblem; devices: Device[]; circuits: Circuit[]; events: Set<string>; start: string }>();
  const put = (p: DeviceProblem, owner: string) => {
    const key = p.eventKind === "DAVIS_PROBLEM" ? `problem:${p.eventId}` : `events:${p.name}|${owner}`;
    const g = groups.get(key) ?? { p, devices: [], circuits: [], events: new Set<string>(), start: p.start };
    g.events.add(p.eventId);
    if (p.start && (!g.start || p.start < g.start)) g.start = p.start;
    groups.set(key, g);
    return g;
  };
  model.devices.forEach((d) => openProblems(d.problems).forEach((p) => { const g = put(p, `d:${d.name}`); if (!g.devices.includes(d)) g.devices.push(d); }));
  circuits.forEach((c) => openProblems(c.problems).forEach((p) => { const g = put(p, `c:${c.id}`); if (!g.circuits.includes(c)) g.circuits.push(c); }));

  const scopes: Scope[] = [...groups.entries()].map(([key, { p, devices, circuits: cs, events, start }]) => ({
    id: key.startsWith("problem:") ? `problem:${p.eventId}` : key,
    // an event group names its device (or circuit), or two groups of the same kind read the same
    title: key.startsWith("problem:") ? p.name
      : `${p.name} · ${devices[0] ? shortDevice(devices[0].name) : cs[0] ? `${cs[0].carrier} ${cs[0].kind} link` : "network"}${events.size > 1 ? ` · ${events.size} alerts` : ""}`,
    category: p.category, start: start || null,
    incident: key.startsWith("problem:") ? p.displayId || null : null, devices, circuits: cs, level: problemLevel(p),
  }));

  // 2. links that stopped answering while nothing is alerting on them — the gap is part of the message
  const silent = circuits.filter((c) => c.status === "down" && !openProblems(c.problems).length);
  byCarrier(silent).forEach((cs, carrier) => scopes.push({
    id: `down:${carrier}`, title: `${carrier} links not answering`, start: earliest(cs.map((c) => c.since)),
    incident: cs.map((c) => c.incident).find((x): x is string => !!x) ?? null,
    devices: edgeDevices(model, cs), circuits: cs, level: "Critical",
    note: "No alert is configured for this: the app is reporting what the monitors measured",
  }));

  // 3. the one judgment the app makes: the SLA the customer configured on the monitor
  const overSla = circuits.filter((c) => c.status === "up" && c.latencyMs != null && c.latencyMs > c.slaMs && !openProblems(c.problems).length);
  byCarrier(overSla).forEach((cs, carrier) => scopes.push({
    id: `sla:${carrier}`, title: `${carrier} above the SLA you configured`, start: null, incident: null,
    devices: edgeDevices(model, cs), circuits: cs, level: "Warning",
    note: `${cs.length} circuit${cs.length > 1 ? "s" : ""} slower than their sla_ms tag`,
  }));

  // 4. Everything Dynatrace is raising that the app cannot place on the map still has to be visible, and
  // each reason needs a different fix from the customer, so they are three separate entries rather than
  // one bucket. Environments differ: one has monitors nobody tagged, another has metric events bound to
  // the environment, another alerts on hosts and services this app does not cover.
  const orphans = (model.unmappedAlerts ?? []).filter((a) => !a.muted);
  const unplaced: { scope: NonNullable<DeviceProblem["scope"]>; title: (n: number) => string; note: (names: string) => string }[] = [
    {
      scope: "network",
      title: (n) => `${n} alert${n > 1 ? "s" : ""} on network elements outside this inventory`,
      note: (names) => `Raised on monitors or devices the app cannot match to a site: ${names}. Tag the monitor with the circuit tags, or point it at the address of a device the SNMP extensions poll, and it lands on the map.`,
    },
    {
      scope: "environment",
      title: (n) => `${n} alert${n > 1 ? "s" : ""} not linked to any entity`,
      note: (names) => `Raised on the environment, so nothing says which device they are about: ${names}. Set the entity dimension on the metric event and they land on the device.`,
    },
    {
      scope: "other",
      title: (n) => `${n} alert${n > 1 ? "s" : ""} outside the network domain`,
      note: (names) => `Open on hosts, services or applications: ${names}. They are shown here because this environment is reporting them, not because the network is the cause.`,
    },
  ];
  // everything outside the network is one entry, whatever domain it is in (applications, services,
  // hosts or anything else): splitting the domains for the fault-domain reading must not hide them here
  const OUTSIDE = new Set(["application", "service", "host", "other"]);
  unplaced.forEach(({ scope, title, note }) => {
    const group = orphans.filter((a) => {
      const s = a.scope ?? "environment";
      return scope === "other" ? OUTSIDE.has(s) : s === scope;
    });
    if (!group.length) return;
    const names = [...new Set(group.map((a) => a.name))].slice(0, 4).join(", ");
    scopes.push({
      id: `alerts:${scope}`, title: group.length === 1 ? group[0].name : title(group.length),
      start: group.map((a) => a.start).filter(Boolean).sort()[0] ?? null, incident: null, devices: [], circuits: [],
      level: scope === "other" ? "Warning" : group.some((a) => problemLevel(a) === "Critical") ? "Critical" : "Warning",
      note: note(names),
    });
  });

  return scopes
    .map((scope) => toCause(model, byCode, scope))
    .filter((c) => c.sites.length > 0 || c.elements.length > 0 || c.id.startsWith("alerts:"))
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact.sites - a.impact.sites || (a.since ?? "").localeCompare(b.since ?? ""));
}

const byCarrier = (cs: Circuit[]) => {
  const map = new Map<string, Circuit[]>();
  cs.forEach((c) => map.set(c.carrier, [...(map.get(c.carrier) ?? []), c]));
  return map;
};

const edgeDevices = (model: NetworkModel, cs: Circuit[]) =>
  [...new Set(cs.map((c) => model.devices.find((d) => d.site === c.site && d.role === "edge")).filter((d): d is Device => !!d))];

function kindOf(model: NetworkModel, scope: Scope): CauseKind {
  if (scope.circuits.length && new Set(scope.circuits.map((c) => c.carrier)).size === 1) return "carrier";
  if (scope.devices.length && scope.devices.every((d) => model.sites[d.site]?.dc)) return "datacenter";
  if (scope.devices.length) return "device";
  return "unknown";
}

function toCause(model: NetworkModel, byCode: Map<string, SiteInfo>, scope: Scope): Cause {
  const kind = kindOf(model, scope);
  const codes = [...new Set([...scope.devices.map((d) => d.site), ...scope.circuits.map((c) => c.site)])];
  const sites = codes.map((c) => byCode.get(c)).filter((s): s is SiteInfo => !!s)
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.code.localeCompare(b.code));
  const regions = [...new Set(sites.map((s) => s.site.region).filter((r): r is string => !!r))];
  const appOf = (s: SiteInfo) => s.path?.hops.find((h) => h.kind === "app");

  const elements: CauseElement[] = [
    ...scope.circuits.map((c): CauseElement => ({ id: c.id, label: `${c.site} · ${c.kind}`, kind: "circuit", verdict: c.status === "down" ? "Critical" : c.verdict, site: c.site })),
    ...scope.devices.map((d): CauseElement => ({ id: d.name, label: shortDevice(d.name), kind: "device", verdict: d.verdict, site: d.site })),
  ].slice(0, 60);

  // impact
  const scopedDevices = sites.flatMap((s) => s.devices);
  const offline = sites.filter((s) => (appOf(s)?.app?.sessions ?? 1) === 0 || s.devices.some((d) => d.role === "edge" && d.unreachableSince)).length;
  const sessionsLost = sites.reduce((a, s) => { const app = appOf(s)?.app; return a + (app?.baselineSessions != null ? Math.max(0, app.baselineSessions - app.sessions) : 0); }, 0);
  const sessionsSlowed = sites.reduce((a, s) => { const h = appOf(s); return a + (h && isBad(h.verdict) && h.app && h.app.sessions > 0 ? h.app.sessions : 0); }, 0);

  // evidence: what Dynatrace raised, then what the devices themselves reported around that moment
  const evidence: Evidence[] = [];
  if (scope.id.startsWith("problem:")) {
    evidence.push({ id: "davis", t: scope.start, level: scope.level, source: "Davis",
      text: `${scope.title}${scope.incident ? ` · ${scope.incident}` : ""} · ${scope.devices.length + scope.circuits.length} element(s) affected` });
  }
  if (scope.note) evidence.push({ id: "note", t: null, level: scope.level, source: "Davis", text: scope.note });

  const down = scope.circuits.filter((c) => c.status === "down");
  down.slice(0, 6).forEach((c) => evidence.push({ id: `c-${c.id}`, t: c.since ?? null, level: c.kind === "primary" ? "Critical" : "Warning", source: "WAN link", text: `${c.siteName}: ${c.kind} ${c.tech} not answering` }));
  scope.circuits.filter((c) => c.status === "up" && c.latencyMs != null && c.latencyMs > c.slaMs).slice(0, 6)
    .forEach((c) => evidence.push({ id: `s-${c.id}`, t: null, level: "Warning", source: "WAN link", text: `${c.siteName}: ${c.latencyMs} ms against a ${c.slaMs} ms SLA` }));
  scope.devices.slice(0, 6).forEach((d) => evidence.push({ id: `d-${d.name}`, t: d.unreachableSince ?? null, level: d.verdict, source: "SNMP",
    text: `${shortDevice(d.name)}: ${stripDevice(d.reasons[0]?.text ?? "affected")}`, device: d.name }));

  const hitAt = scope.start ?? earliest([...down.map((c) => c.since), ...scope.devices.map((d) => d.unreachableSince)]);
  const noticeFrom = hitAt ? new Date(Date.parse(hitAt) - 15 * 60e3).toISOString() : null;
  const seen = new Set<string>();
  [...scope.devices, ...scopedDevices].forEach((d) => d.events.forEach((e) => {
    if (e.level === "INFO" && e.kind !== "trap") return;
    if (noticeFrom && e.t < noticeFrom) return;
    const key = `${d.name}|${e.t}|${e.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ id: `e-${key}`, t: e.t, level: e.level === "ERROR" ? "Critical" : "Warning", source: e.kind === "trap" ? "Trap" : "Syslog",
      text: `${shortDevice(d.name)} · ${e.mnemonic ?? e.level}: ${e.text}`, device: d.name });
  }));
  if (sessionsLost) evidence.push({ id: "sessions", t: null, level: "Critical", source: "Application", text: `${sessionsLost.toLocaleString("en-US")} sessions per hour missing from ${offline} site(s)` });
  if (sessionsSlowed) evidence.push({ id: "slow", t: null, level: "Warning", source: "Application", text: `${sessionsSlowed.toLocaleString("en-US")} sessions per hour from affected sites` });
  const orderedEvidence = [...evidence.filter((e) => e.t).sort((a, b) => a.t!.localeCompare(b.t!)), ...evidence.filter((e) => !e.t)].slice(0, 14);

  // when each site was hit, and the propagation moments
  const affectedAt: Record<string, string> = {};
  sites.forEach((s) => {
    const t = earliest([
      scope.start,
      ...s.circuits.filter((c) => c.status === "down").map((c) => c.since),
      ...s.devices.map((d) => d.unreachableSince),
    ]);
    if (t) affectedAt[s.code] = t;
  });
  const moments = new Map<string, Moment>();
  const add = (t: string | null | undefined, label: string, level: Verdict, site?: string) => {
    if (!t) return;
    const key = `${t.slice(0, 16)}|${label}`;
    const m = moments.get(key) ?? { t, label, level, sites: [] };
    if (site && !m.sites.includes(site)) m.sites.push(site);
    m.level = worst([m.level, level]);
    moments.set(key, m);
  };
  add(scope.start, scope.incident ? `${scope.title} · ${scope.incident}` : scope.title, scope.level);
  down.forEach((c) => add(c.since, `${c.carrier} ${c.kind} link stopped answering`, c.kind === "primary" ? "Critical" : "Warning", c.site));
  scope.devices.filter((d) => d.unreachableSince).forEach((d) => add(d.unreachableSince, `${shortDevice(d.name)} stopped responding`, "Critical", d.site));
  orderedEvidence.filter((e) => e.source === "Syslog" || e.source === "Trap").forEach((e) => add(e.t, e.text.split(":")[0], e.level, e.device ? model.devices.find((d) => d.name === e.device)?.site : undefined));
  const timeline = [...moments.values()].sort((a, b) => a.t.localeCompare(b.t));

  const siteName = (code: string) => model.sites[code]?.name ?? code;
  const subtitle = sites.length > 1
    ? `${regions.join(", ") || "network"} · ${sites.length} sites`
    : sites.length === 1 ? `${siteName(sites[0].code)}${sites[0].site.region ? ` · ${sites[0].site.region}` : ""}` : "no site mapped";

  return {
    id: scope.id, kind, title: scope.title, subtitle, layer: layerOf(kind, scope.category),
    verdict: worst([scope.level, ...sites.map((s) => s.verdict)]),
    since: scope.start ?? earliest(Object.values(affectedAt)),
    incident: scope.incident,
    sites, elements, devices: scope.devices.slice(0, 40),
    impact: { sites: sites.length, offline, devices: scopedDevices.filter((d) => isBad(d.verdict)).length, sessionsLost, sessionsSlowed, regions },
    evidence: orderedEvidence, timeline, affectedAt,
  };
}

export const sinceLabel = (c: Cause) => (c.since ? `since ${hhmm(c.since)}` : "ongoing");
