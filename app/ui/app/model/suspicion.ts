// Isolating the network in, or out.
//
// The app never turns a measurement into a status: red and amber come from the problems Dynatrace has
// open, and nothing here changes them. What this file produces is a SUSPICION — stated as such, with the
// numbers that produced it — answering one question for a site, or for the environment: is what is
// degraded explained by the network?
//
// Two facts decide it. On the network side, the problems the app already carries. Outside the network,
// what the platform itself is alerting on (application, service, host) plus the traffic the users are
// actually generating. The app shows no detail of anything outside the network: it counts it, says
// whether the two coincide, and hands the analysis to Dynatrace Assist.
import type { AppNetwork, DeviceProblem, NetworkModel, NonNetworkScope, Users } from "./types";
import type { SiteInfo } from "./site";
import { openProblems } from "./verdict";

/** Below this share of the usual traffic for that hour, the drop is worth suspecting. The customer's own
 *  number, like the SLA: visible in Settings, never hidden in the code. */
export const DEFAULT_DROP_PCT = 50;

/**
 * How long before an impact began a network alert may have opened and still be read as its cause. A
 * busy environment always has both network alerts and alerts elsewhere open (fxz0998d: 1879 interfaces
 * down, and unrelated database outages hours apart); without a time link the reading was "network
 * implicated" by coincidence alone.
 */
export const LINK_WINDOW_MIN = 30;

/**
 * A network that raises alerts all day long (fxz0998d: about 4000 interface events in 24 h, ports
 * flapping) always has one in any 30-minute window, so the window alone links everything. A network
 * alert counts as a cause only when the window before the impact holds a burst: at least this many times
 * the usual rate of the six hours before it.
 */
export const BURST_FACTOR = 3;

/**
 * The applications feel the network before anyone looks at a switch: TCP retransmissions measured by
 * OneAgent. A rise is read against the environment's own usual level (fxz0998d: about 0.016% of packets;
 * a single AKS cluster: 0.1%), never against a fixed number, and only once enough packets are
 * retransmitted to be more than noise.
 */
export const RETR_FACTOR = 2;
export const RETR_MIN_PACKETS = 50;
export const RTT_FACTOR = 1.5;

export interface AppRise {
  rising: boolean;
  /** start of the first 10-minute bucket of the rise, when rising */
  startAt: number | null;
  now: number | null;
  usual: number | null;
  rttNow: number | null;
  rttUsual: number | null;
  rttRising: boolean;
  /** workloads whose retransmissions in the last hour are at least RETR_FACTOR times their usual */
  workloads: { name: string; now: number; usual: number }[];
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Is the share of retransmitted packets the applications see rising right now, against its usual level? */
export function appRise(a: AppNetwork | undefined): AppRise | null {
  if (!a || a.retrPct.length < 8) return null;
  const last = a.retrPct.length - 2; // the last bucket is still filling
  const baseIdx = (end: number) => Array.from({ length: 36 }, (_, k) => end - 3 - k).filter((k) => k >= 0);
  const usualOf = (xs: (number | null)[], end: number) => median(baseIdx(end).map((k) => xs[k]).filter((v): v is number => v != null));
  const usual = usualOf(a.retrPct, last);
  const high = (k: number) => usual != null && a.retrPct[k] != null && (a.retrPct[k] as number) >= Math.max(RETR_FACTOR * usual, usual + 0.001) && (a.retransmitted[k] ?? 0) >= RETR_MIN_PACKETS;
  let k = last;
  const rising = high(last);
  if (rising) while (k > 0 && high(k - 1)) k--;
  const rttUsual = usualOf(a.rttMs, last), rttNow = a.rttMs[last] ?? null;
  return {
    rising, startAt: rising ? a.start + k * a.interval : null, now: a.retrPct[last] ?? null, usual,
    rttNow, rttUsual, rttRising: rttNow != null && rttUsual != null && rttNow >= RTT_FACTOR * rttUsual,
    workloads: a.workloads
      .filter((w) => w.retrNow != null && w.retrUsual != null && w.retrNow >= RETR_FACTOR * w.retrUsual && w.retrNow > 0)
      .map((w) => ({ name: w.name, now: w.retrNow as number, usual: w.retrUsual as number }))
      .sort((x, y) => y.now / Math.max(y.usual, 1e-6) - x.now / Math.max(x.usual, 1e-6)).slice(0, 3),
  };
}

export type SuspicionKind =
  | "network-implicated"  // users or other domains degraded, and the network is alerting here too
  | "not-network"         // degraded, and nothing is alerting on the network
  | "unexplained"         // the applications feel the network (retransmissions), and no network alert explains it
  | "contained"           // the network is alerting, and nothing outside it shows anything
  | "watching"            // nothing to suspect
  | "blind";              // no way to tell: no session data and no non-network alert

export interface Suspicion {
  kind: SuspicionKind;
  /** one line, in the app's voice: a suspicion, never a verdict */
  headline: string;
  /** the numbers that produced it, each one a fact from the model */
  facts: string[];
  /** scope this was computed for */
  scope: "site" | "environment";
  site?: string;
  /** open problems outside the network, counted by domain — never detailed on screen */
  outside: Record<NonNetworkScope, number>;
  /** network problems that were open at the same time */
  network: number;
  /** true when the drop came from the app's own measurement, not from a platform alert */
  fromMeasurement: boolean;
  /**
   * Whose traffic the percentage is about. The per-hour curve exists for the environment; a site only has
   * the 24 h total of its own subnets, so a site reading borrows the environment curve and says so rather
   * than passing it off as this site's.
   */
  trafficScope: "site" | "environment";
  /** sessions in the last 24 h from the subnets that belong to this site, when it has any */
  siteSessions?: number;
  /** the burst of network alerts that came just before an impact, when the reading found one */
  burst?: { from: number; to: number; opened: number; usual: number; followedBy: string; at: number };
  /** the network as the applications feel it (OneAgent flows), environment-wide */
  app?: AppRise;
}

const EMPTY_OUTSIDE: Record<NonNetworkScope, number> = { application: 0, service: 0, host: 0, other: 0 };

/** What the platform is alerting on outside the network: the one definition every count here uses. */
export function outsideAlerts(model: NetworkModel): DeviceProblem[] {
  return (model.unmappedAlerts ?? []).filter((a) => !a.muted && (a.scope === "application" || a.scope === "service" || a.scope === "host" || a.scope === "other"));
}

/** Those alerts counted by what they are about. */
export function outsideCounts(model: NetworkModel): Record<NonNetworkScope, number> {
  const out = { ...EMPTY_OUTSIDE };
  outsideAlerts(model).forEach((a) => { out[a.scope as NonNetworkScope] += 1; });
  return out;
}

const totalOutside = (o: Record<NonNetworkScope, number>) => o.application + o.service + o.host + o.other;

/**
 * Demand in the last complete hour against what that hour usually holds: user sessions when the
 * environment has them, requests served by the services when it only has those.
 */
export function trafficDrop(users: Users | undefined, dropPct: number): { pct: number | null; dropped: boolean; source: "sessions" | "requests" | null; now: number | null; typical: number | null } {
  const src = users && users.now != null && users.typicalNow ? { source: "sessions" as const, now: users.now, typical: users.typicalNow }
    : users?.requests && users.requests.now != null && users.requests.typicalNow ? { source: "requests" as const, now: users.requests.now, typical: users.requests.typicalNow }
    : null;
  if (!src) return { pct: null, dropped: false, source: null, now: null, typical: null };
  const pct = Math.round((src.now / src.typical) * 100);
  return { pct, dropped: pct < dropPct, ...src };
}

/**
 * When the fall began: the first hour of the run of complete hours, ending with the last one, in which
 * demand sat below the threshold. The hours are aligned the way the series is built (the last point is
 * the hour still filling).
 */
export function fallStart(users: Users | undefined, source: "sessions" | "requests" | null, dropPct: number): number {
  const src = source === "requests" ? users?.requests : users;
  const series = (src?.series ?? []) as (number | null)[];
  const usual = (src?.typical ?? []) as number[];
  let i = src?.nowIndex ?? series.length - 2;
  if (i < 0) return NaN;
  const below = (k: number) => series[k] != null && usual[k] > 0 && ((series[k] as number) / usual[k]) * 100 < dropPct;
  if (!below(i)) return NaN;
  while (i > 0 && below(i - 1)) i--;
  const hourStart = (k: number) => Math.floor((Date.now() - (series.length - 1 - k) * 3600000) / 3600000) * 3600000;
  return hourStart(i);
}

export function suspicionFor(
  model: NetworkModel,
  { site, dropPct = DEFAULT_DROP_PCT }: { site?: SiteInfo; dropPct?: number } = {},
): Suspicion {
  const users = model.users;
  const outside = outsideCounts(model);
  const outsideOpen = totalOutside(outside);
  const netProblems: DeviceProblem[] = site
    ? [...site.devices.flatMap((d) => openProblems(d.problems)), ...site.circuits.flatMap((c) => openProblems(c.problems))]
    : [...model.devices.flatMap((d) => openProblems(d.problems)), ...(model.circuits ?? []).flatMap((c) => openProblems(c.problems))];
  const network = new Set(netProblems.map((p) => p.eventId)).size;
  const scope: "site" | "environment" = site ? "site" : "environment";

  const drop = trafficDrop(users, dropPct);
  const siteNets = site ? (users?.nets ?? []).filter((n) => n.site === site.code) : [];
  const siteSessions = siteNets.length ? siteNets.reduce((a, n) => a + n.sessions, 0) : undefined;
  const trafficScope: "site" | "environment" = "environment";
  const facts: string[] = [];
  if (drop.pct != null) {
    const what = drop.source === "sessions" ? "User sessions" : "Requests served by the services";
    facts.push(`${what} at ${drop.pct}% of the usual for this hour (${drop.now} against ${drop.typical}), counted across the whole environment`);
  }
  if (siteSessions != null) facts.push(`${siteSessions} sessions in 24 h came from this site's subnets (${siteNets.map((n) => n.net).join(", ")})`);
  else if (site && users) facts.push("No client subnet is known to belong to this site, so its users cannot be counted separately");
  else if (!users) facts.push("Neither user sessions nor service requests are reaching this environment");
  if (outsideOpen) {
    // a problem and a raw event are both the platform alerting, but they are not the same thing: say which
    const list = outsideAlerts(model);
    const problems = list.filter((a) => a.eventKind === "DAVIS_PROBLEM").length;
    const events = list.length - problems;
    const label: Record<NonNetworkScope, string> = { application: "applications", service: "services", host: "hosts", other: "other entities" };
    const parts = (Object.keys(outside) as NonNetworkScope[]).filter((k) => outside[k]).map((k) => `${outside[k]} on ${label[k]}`);
    const kinds = [problems ? `${problems} problem${problems > 1 ? "s" : ""}` : "", events ? `${events} event${events > 1 ? "s" : ""} not folded into a problem` : ""].filter(Boolean).join(" and ");
    facts.push(`Dynatrace is alerting outside the network: ${kinds} — ${parts.join(", ")}`);
  }
  if (network) facts.push(`${network} alert(s) open on ${site ? "this site's network" : "the network"}`);
  if (drop.dropped && !users?.anomalyWatched) facts.push("No traffic anomaly problem is open on these applications, so this drop is the app's own measurement");
  if (users && scope === "environment" && users.mapped === 0 && users.total > 0) {
    facts.push(`No client subnet matches a site (${users.total} sessions), so this is the whole environment, not one site`);
  }

  // how the applications feel the network: OneAgent sees every TCP retransmission, whatever caused it
  const app = appRise(model.appNet) ?? undefined;
  const hhmmZ = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
  const pctTxt = (v: number | null) => (v == null ? "?" : `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}%`);
  if (app?.rising) {
    facts.push(`Applications see ${pctTxt(app.now)} of their TCP packets retransmitted since ${hhmmZ(app.startAt!)}, against a usual ${pctTxt(app.usual)} (OneAgent ${model.appNet!.source === "flows" ? "network flows" : "process network metrics"}, whole environment)`);
    if (app.workloads.length) facts.push(`Retransmissions rose most on ${app.workloads.map((w) => `${w.name} (${pctTxt(w.now)}, usually ${pctTxt(w.usual)})`).join(", ")}`);
  } else if (app && network) {
    facts.push(`Applications see TCP retransmissions at their usual level (${pctTxt(app.now)}, usually ${pctTxt(app.usual)}): the network alerts are not reaching them`);
  }
  if (app?.rttRising) facts.push(`Round trip seen by the applications at ${app.rttNow} ms (${model.appNet!.rttKind === "p90" ? "90th percentile" : "average"}), against a usual ${app.rttUsual} ms`);
  const appImpact = !site && !!app?.rising;

  // Alerts outside the network are not tied to a site (the app has no way to place them), so they only
  // make the ENVIRONMENT degraded. A site reading counts them as context, never as this site's impact —
  // otherwise every site in the list would read "not the network" off one database alarm somewhere else.
  const impact = site ? drop.dropped : drop.dropped || outsideOpen > 0 || appImpact;

  // When did the impact begin, and did a network alert open just before it?
  let burst: Suspicion["burst"];
  const ts = (v: string) => Date.parse(v.length === 17 ? v.replace("Z", ":00Z") : v);
  const dropStart = drop.dropped ? fallStart(users, drop.source, dropPct) : NaN;
  // an alert is known to the minute, a fall only to the hour: a network alert that opened at any point of
  // the first low hour can explain that hour, so the fall's window runs to the end of it
  const outsideList = outsideAlerts(model).filter((a) => Number.isFinite(ts(a.start)));
  const impacts = [
    ...(site ? [] : outsideList.map((a) => ({ t: ts(a.start), after: 5 * 60000, what: `${a.name} (${a.scope})` }))),
    ...(Number.isFinite(dropStart) ? [{ t: dropStart, after: 3600000, what: `the fall in ${drop.source === "requests" ? "requests" : "sessions"}` }] : []),
    ...(appImpact ? [{ t: app!.startAt!, after: model.appNet!.interval, what: "the rise in TCP retransmissions" }] : []),
  ];
  const netStarts = netProblems.map((p) => ts(p.start)).filter((t) => Number.isFinite(t));
  const W = LINK_WINDOW_MIN * 60000;
  // the usual rate: how many network alerts a window of this length held over the six hours before it
  const burstAt = (i: number, after: number) => {
    const inWindow = netStarts.filter((n) => n >= i - W && n <= i + after).length;
    const before = netStarts.filter((n) => n >= i - 6 * 3600000 && n < i - W).length;
    const usual = before / ((6 * 3600000 - W) / (W + after));
    return { inWindow, usual, burst: inWindow > 0 && inWindow >= Math.max(1, BURST_FACTOR * usual) };
  };
  const checks = impacts.map(({ t, after, what }) => ({ t, after, what, ...burstAt(t, after) }));
  const linkedPairs = checks.filter((c) => c.burst).flatMap(({ t: i, after }) => netStarts.filter((n) => n >= i - W && n <= i + after).map((n) => [n, i] as const));
  const linked = linkedPairs.length > 0;
  const noisy = checks.find((c) => !c.burst && c.inWindow > 0);
  if (impact && network && !linked && noisy) {
    facts.push(`Network alerts keep opening at their usual pace (${noisy.inWindow} in the ${LINK_WINDOW_MIN} minutes before, about ${Math.round(noisy.usual)} usually) — background, not a burst that would explain it`);
  }
  if (impact && network && !linked && !noisy) facts.push(`The ${network} network alert(s) open did not start within ${LINK_WINDOW_MIN} minutes before what is degraded, so they are not read as its cause`);
  if (impact && linked) {
    // name the burst: how many opened, against what is usual, and what began right after it
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    const b = checks.filter((c) => c.burst).sort((x, y) => y.inWindow - x.inWindow)[0];
    facts.push(`${b.inWindow} network alerts opened in the ${LINK_WINDOW_MIN} minutes before ${b.what} began at ${hhmm(b.t)}Z — about ${Math.round(b.usual)} is usual for that long`);
    burst = { from: b.t - W, to: b.t + b.after, opened: b.inWindow, usual: b.usual, followedBy: b.what, at: b.t };
  }
  if (site && outsideOpen) facts.push(`The ${outsideOpen} alert(s) outside the network are counted for the whole environment; none can be tied to this site`);
  // retransmissions are a network symptom: when they are the only thing degraded and no network alert
  // explains them, the network is not ruled out — it is unmonitored where it hurts
  const onlyApp = appImpact && !drop.dropped && outsideOpen === 0;
  const kind: SuspicionKind = impact && network && linked ? "network-implicated"
    : onlyApp || (appImpact && !linked && !network) ? "unexplained"
    : impact ? "not-network"
    : network ? "contained"
    : !users && !outsideOpen ? "blind"
    : "watching";

  const where = site ? site.site.name : "this environment";
  const qualifier = site ? " (traffic is counted for the whole environment)" : "";
  // the burst came first, but the applications never felt it: said in the same line, not buried in the facts
  const unfelt = kind === "network-implicated" && !!app && !app.rising && !drop.dropped;
  const headline = kind === "network-implicated"
    ? `Suspicion: a burst of network alerts came just before what is degraded in ${where}${qualifier}${unfelt ? " — yet the applications' TCP retransmissions stayed at their usual level, so it may be coincidence" : ""}`
    : kind === "not-network"
    ? network
      ? `Suspicion: what is degraded in ${where} did not start with any network alert — look outside the network`
      : `Suspicion: ${where} is degraded with nothing open on the network — look outside it`
    : kind === "unexplained"
    ? `Suspicion: the applications in ${where} feel the network (more TCP retransmissions) and no network alert explains it — a segment nobody monitors, or the hosts themselves`
    : kind === "contained"
    ? `The network problem in ${where} is not showing up in traffic or in any other domain`
    : kind === "blind"
    ? `Nothing to compare in ${where}: no user sessions and nothing alerting outside the network`
    : `Nothing suspicious in ${where}`;

  return { kind, headline, facts, scope, site: site?.code, outside, network, trafficScope, siteSessions, burst, app, fromMeasurement: drop.dropped && !(users?.anomalyWatched ?? false) };
}
