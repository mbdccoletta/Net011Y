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
import { discardingPorts, type DiscardPort } from "./discards";
import type { NoveltyMap } from "../hooks/useNovelty";

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
  /**
   * The ports this cause is about, when it is about ports, and how many packets they dropped
   * in each hour of the record. A cause that names a count of ports should be able to show
   * them; a cause about a rate over time should be able to draw it.
   */
  ports?: DiscardPort[];
  perHour?: number[];
  /** When each site became affected; missing means before the observed window */
}

const earliest = (ts: (string | null | undefined)[]) => ts.filter((t): t is string => !!t).sort()[0] ?? null;
const shortDevice = (name: string) => name.replace(/^BR-[A-Z]{2}-[A-Z0-9]+-/, "");

const byCarrier = (cs: Circuit[]) => {
  const map = new Map<string, Circuit[]>();
  cs.forEach((c) => { const l = map.get(c.carrier); if (l) l.push(c); else map.set(c.carrier, [c]); });
  return map;
};

const edgeDevices = (model: NetworkModel, cs: Circuit[]) =>
  [...new Set(cs.map((c) => model.devices.find((d) => d.site === c.site && d.role === "edge")).filter((d): d is Device => !!d))];

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
  /** the ports behind a cause built from them, and their hourly rate */
  ports?: DiscardPort[];
  perHour?: number[];
  /**
   * What to say about each device, when the scope knows something the device record does not.
   *
   * The generic line is the device's own first reason, and a device that is only in a cause
   * because of what one of its ports is doing has no reason of its own — so the panel printed
   * "FWC-001: affected" eight times. A scope that was built from a measurement can say what it
   * measured on that device instead.
   */
  deviceNote?: (d: Device) => string;
}

export function buildCauses(model: NetworkModel, infos: SiteInfo[], rising: NoveltyMap | null = null): Cause[] {
  const byCode = new Map(infos.map((i) => [i.code, i]));
  const circuits = model.circuits ?? [];

  // 1. One scope per open Davis problem, from the entities it affects. Events that never became a problem
  // are grouped by what they are and where they are: an environment whose ports flap raises thousands of
  // "Interface operationally going down" events (a large environment: about 4000), and one entry each made a list of
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

  /**
   * 3b. Ports losing packets — one entry for the whole finding.
   *
   * This reading lived on the forecast page, which is where its series happened to be read and
   * not where it belongs: a port discarding at a fraction of its line rate is a fault now, not
   * a capacity problem later, and that page says so in its own verdict.
   *
   * It was one entry per device first, and measuring that is what settled the shape: this
   * estate has seventeen such devices, so the landing page went from two causes to nineteen and
   * the two that were alerting disappeared into the middle of a list. On another environment it
   * would be far worse — discards there are a condition rather than an event (a median of 62% of a
   * discarding port's hours, none below 5%, none above 75%), which is hundreds of devices. One
   * entry, with every device on it, is the only grouping that survives an estate that discards
   * everywhere.
   *
   * The utilisation is carried beside the counter on purpose: losing packets while the busiest
   * hour averaged a few per cent of the line rate rules capacity out and points at the physical
   * layer, a buffer or a policer instead. Without it the number reads as congestion.
   *
   * It appears only where the hourly read happened. That read is `detail`-gated, so on an
   * estate past the device cap it does not run — and an empty list would then say "no port is
   * discarding" about an environment nobody looked at.
   */
  const discarding = discardingPorts(model, rising);
  if (discarding.devices.length) {
    /* Every sentence here is the platform's finding or a measurement of the ports it named.
       The note used to be this app's own arithmetic — "N more discards in the recent half than
       in the earlier half" — which was the detector, not a description of it. */
    const top = discarding.rows[0];
    const byDevice = new Map<string, typeof discarding.rows>();
    for (const r of discarding.rows) byDevice.set(r.device, [...(byDevice.get(r.device) ?? []), r]);
    scopes.push({
      id: "discards",
      title: `${discarding.ports} port${discarding.ports > 1 ? "s" : ""} losing packets`
        + ` on ${discarding.devices.length} device${discarding.devices.length > 1 ? "s" : ""}`,
      start: top?.novelty.at ?? null, incident: null, devices: discarding.devices, circuits: [], level: "Warning",
      ports: discarding.rows, perHour: discarding.perHour,
      note: `Dynatrace: ${top ? `“${top.novelty.text}” on ${top.iface}` : "a change in the discard rate"}`
        + `${top ? ` · novelty ${Math.round(top.novelty.score * 100)}%` : ""}`
        + (discarding.busiest < 50
          ? ` · the busiest hour on any of them reached ${discarding.busiest.toFixed(1)}% of its line rate, too little for capacity to explain`
          : ` · busiest hour ${discarding.busiest.toFixed(1)}% of its line rate`),
      deviceNote: (d) => {
        const rows = byDevice.get(d.name) ?? [];
        if (!rows.length) return "flagged";
        const best = rows[0];
        return `${rows.length} port${rows.length === 1 ? "" : "s"} · ${best.novelty.text.toLowerCase()}`
          + ` · ${rows.map((r) => r.iface).slice(0, 3).join(", ")}`;
      },
    });
  }

  /**
   * Nothing goes in this list that the network has not been shown to have caused.
   *
   * Two entries stood here, for the alerts Dynatrace has open that this app cannot place:
   * ones on network elements its inventory does not contain, and ones bound to the
   * environment with no entity at all. Both were honest about themselves — their own notes
   * told the reader to tag the monitor or set the entity dimension — and neither is a cause:
   * nothing says what they impacted, or that the network impacted anything. A list of faults
   * is not where a coverage gap belongs, and a reader opening one found a panel with no site,
   * no device and nothing the network had done.
   *
   * They are not dropped from the app: the page counts them under the causes as a gap, with
   * the same instruction, and the suspicion panel already counts the ones outside the network
   * domain — which is the right place, because what those are evidence of is that the fault
   * is not here. A third entry for those was removed earlier for the same reason.
   */

  return scopes
    .map((scope) => toCause(model, byCode, scope))
    /* a cause with no site and no element is a cause about nothing */
    .filter((c) => c.sites.length > 0 || c.elements.length > 0)
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.impact.sites - a.impact.sites || (a.since ?? "").localeCompare(b.since ?? ""));
}



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
    ...scope.devices.map((d): CauseElement => ({ id: d.name,
      label: scope.devices.filter((x) => shortDevice(x.name) === shortDevice(d.name)).length > 1 ? d.name : shortDevice(d.name),
      kind: "device", verdict: d.verdict, site: d.site })),
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
  /* Two devices at two sites can share a short name — `shortDevice` takes the site prefix off,
     and the panel then listed "FWC-001" twice with different numbers, which reads as the same
     device contradicting itself. Where the short form is not unique inside this cause, the
     name is written out. */
  const shortCount = new Map<string, number>();
  for (const d of scope.devices) shortCount.set(shortDevice(d.name), (shortCount.get(shortDevice(d.name)) ?? 0) + 1);
  const nameIn = (d: Device) => ((shortCount.get(shortDevice(d.name)) ?? 0) > 1 ? d.name : shortDevice(d.name));
  scope.devices.slice(0, 6).forEach((d) => evidence.push({ id: `d-${d.name}`, t: d.unreachableSince ?? null, level: d.verdict, source: "SNMP",
    text: `${nameIn(d)}: ${scope.deviceNote ? scope.deviceNote(d) : stripDevice(d.reasons[0]?.text ?? "affected")}`, device: d.name }));

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
    evidence: orderedEvidence, timeline, ports: scope.ports, perHour: scope.perHour,
  };
}

export const sinceLabel = (c: Cause) => (c.since ? `since ${hhmm(c.since)}` : "ongoing");
