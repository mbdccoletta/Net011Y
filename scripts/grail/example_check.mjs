// Is the bundled example network coherent with itself?
//
// The example is the app's shop window: it is what a reader sees before any of their own data arrives,
// and every screen reads it through the same model as a live environment. So it has to obey the same
// rules — nothing judged that was not alerted, a total that equals the sum of its parts, no timestamp in
// the future, every reference pointing at something that exists.
//
// This reads the example the app itself builds (no fixtures, no Grail) and asserts those rules. It is
// separate from validate.mjs, which checks the model against generated records.
//   node example_check.mjs            # both sizes
//   node example_check.mjs enterprise # one of them
import { writeFileSync } from "node:fs";
import { buildExampleNetwork, buildCauses, changesOf, allSites, worst, isBad, ORDER } from "./out/app-model.mjs";

const report = { checks: [] };
let scope = "";
const check = (name, ok, detail) => report.checks.push({ scope, ok: !!ok, name, ...(detail == null ? {} : { detail: String(detail).slice(0, 300) }) });

const open = (ps) => (ps ?? []).filter((p) => !p.muted);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;
/** every ISO string anywhere in the model, with the path that led to it */
function isoStrings(node, path = "", out = [], seen = new Set()) {
  if (node == null || typeof node !== "object") {
    if (typeof node === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(node)) out.push([path, node]);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) isoStrings(v, path ? `${path}.${k}` : k, out, seen);
  return out;
}

function audit(size) {
  scope = size;
  const now = new Date();
  const t0 = Date.now();
  const m = buildExampleNetwork(now, size);
  const ms = Date.now() - t0;
  const sites = m.sites ?? {};
  const devices = m.devices ?? [];
  const circuits = m.circuits ?? [];
  const byName = new Map(devices.map((d) => [d.name, d]));

  check("The example builds", devices.length > 0 && Object.keys(sites).length > 0, `${devices.length} devices · ${Object.keys(sites).length} sites · ${ms} ms`);

  // ---------------- references ----------------
  const badSite = devices.filter((d) => !sites[d.site]);
  check("Every device belongs to a site the model knows", !badSite.length, badSite.slice(0, 3).map((d) => `${d.name}→${d.site}`).join(", ") || "none");
  const badCircuit = circuits.filter((c) => !sites[c.site]);
  check("Every circuit belongs to a site the model knows", !badCircuit.length, badCircuit.slice(0, 3).map((c) => c.id).join(", ") || "none");
  const misnamed = circuits.filter((c) => sites[c.site] && c.siteName !== sites[c.site].name);
  check("A circuit carries its site's own name", !misnamed.length, misnamed.slice(0, 3).map((c) => `${c.id}: ${c.siteName} ≠ ${sites[c.site].name}`).join(", ") || "none");
  check("Device names are unique", new Set(devices.map((d) => d.name)).size === devices.length,
    `${devices.length - new Set(devices.map((d) => d.name)).size} repeated`);
  check("Device addresses are unique", new Set(devices.map((d) => d.ip)).size === devices.length,
    `${devices.length - new Set(devices.map((d) => d.ip)).size} repeated`);
  const orphanSites = Object.keys(sites).filter((code) => !devices.some((d) => d.site === code) && !circuits.some((c) => c.site === code));
  check("No site exists without a device or a circuit", !orphanSites.length, orphanSites.slice(0, 5).join(", ") || "none");

  // ---------------- nothing is judged that was not alerted ----------------
  const judgedWithout = devices.filter((d) => isBad(d.verdict) && !open(d.problems).length);
  check("No device is red or amber without an open problem", !judgedWithout.length,
    judgedWithout.slice(0, 3).map((d) => `${d.name}: ${d.verdict}`).join(", ") || "none");
  const mutedOnly = devices.filter((d) => isBad(d.verdict) && (d.problems ?? []).length && !open(d.problems).length);
  check("A muted problem never colours a device", !mutedOnly.length, mutedOnly.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const verdictOff = devices.filter((d) => d.reasons?.length && worst(d.reasons.map((r) => r.level)) !== d.verdict);
  check("A device's verdict is the worst of its own reasons", !verdictOff.length,
    verdictOff.slice(0, 3).map((d) => `${d.name}: ${d.verdict} vs ${worst(d.reasons.map((r) => r.level))}`).join(", ") || "none");
  const circuitOff = circuits.filter((c) => isBad(c.verdict) && !c.reasons?.length);
  check("A circuit that is judged says why", !circuitOff.length, circuitOff.slice(0, 3).map((c) => c.id).join(", ") || "none");

  // ---------------- measurements stay inside their own scale ----------------
  const cpuOut = devices.filter((d) => (d.cpu ?? []).some((v) => v != null && !inRange(v, 0, 100)));
  check("CPU readings are percentages", !cpuOut.length, cpuOut.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const cpuNowOff = devices.filter((d) => d.cpuNow != null && !inRange(d.cpuNow, 0, 100));
  check("The current CPU is a percentage", !cpuNowOff.length, cpuNowOff.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const availOff = devices.filter((d) => d.availPct != null && !inRange(d.availPct, 0, 100));
  check("Availability is a percentage", !availOff.length, availOff.slice(0, 3).map((d) => `${d.name}:${d.availPct}`).join(", ") || "none");
  const memOff = devices.filter((d) => d.memNow != null && !inRange(d.memNow, 0, 100));
  check("Memory in use is a percentage", !memOff.length, memOff.slice(0, 3).map((d) => `${d.name}:${d.memNow}`).join(", ") || "none");
  const negCounts = devices.filter((d) => [d.syslog?.ERROR, d.syslog?.WARN, d.syslog?.INFO, d.traps].some((v) => v != null && v < 0));
  check("No count is negative", !negCounts.length, negCounts.slice(0, 3).map((d) => d.name).join(", ") || "none");

  // ---------------- a total equals the sum of its parts ----------------
  const trapSum = devices.filter((d) => d.trapTs && Math.abs(d.trapTs.reduce((a, b) => a + (b ?? 0), 0) - d.traps) > 0.5);
  check("The trap counter equals its own hourly series", !trapSum.length,
    trapSum.slice(0, 3).map((d) => `${d.name}: ${d.traps} vs ${d.trapTs.reduce((a, b) => a + (b ?? 0), 0)}`).join(", ") || "none");
  const sysSum = devices.filter((d) => d.syslogErrTs?.length && d.syslogErrTs.reduce((a, b) => a + (b ?? 0), 0) > d.syslog.ERROR);
  check("The syslog error series never exceeds the error count", !sysSum.length,
    sysSum.slice(0, 3).map((d) => `${d.name}: ${d.syslogErrTs.reduce((a, b) => a + (b ?? 0), 0)} > ${d.syslog.ERROR}`).join(", ") || "none");
  // "3 syslog errors · 6 h" over a list that says nothing arrived reads as a broken app: an error inside
  // the three hours the app reads records for has to have a line behind it
  const recentErr = (d) => (d.syslogErrTs ?? []).slice(12).reduce((a, b) => a + (b ?? 0), 0);
  const noLines = devices.filter((d) => !d.unreachableSince && recentErr(d) > 0 && !(d.events ?? []).some((e) => e.kind === "syslog"));
  check("A device with syslog errors in the read window has the lines behind them", !noLines.length,
    noLines.slice(0, 3).map((d) => `${d.name}: ${recentErr(d)} errors, no line`).join(", ") || `${devices.filter((d) => recentErr(d) > 0).length} devices with recent errors`);
  const eventsOverCount = devices.filter((d) => (d.events ?? []).filter((e) => e.kind === "trap").length > d.traps);
  check("A device never lists more traps than it counted", !eventsOverCount.length,
    eventsOverCount.slice(0, 3).map((d) => d.name).join(", ") || "none");
  // series are not all the same length on purpose: a device that was dark for three hours returns three
  // readings fewer, exactly as the live builder drops the null buckets. What must hold is the window.
  const tooLong = devices.filter((d) => (d.cpu?.length ?? 0) > 24 || (d.availTs?.length ?? 0) > 24 || (d.syslogErrTs?.length ?? 0) > 24);
  check("No series runs past the window the app reads", !tooLong.length, tooLong.slice(0, 3).map((d) => `${d.name}:${d.cpu.length}`).join(", ") || "24 buckets");
  const polledBlank = devices.filter((d) => d.mode === "Extension" && !d.unreachableSince && !(d.cpu?.length > 0));
  check("A polled device that is answering has a CPU series", !polledBlank.length, polledBlank.slice(0, 3).map((d) => d.name).join(", ") || "none");

  // ---------------- interfaces ----------------
  const withPorts = devices.filter((d) => (d.interfaces ?? []).length);
  const ifCountLow = withPorts.filter((d) => d.ifCount < d.interfaces.length);
  check("A device never reports fewer ports than it lists", !ifCountLow.length,
    ifCountLow.slice(0, 3).map((d) => `${d.name}: ${d.ifCount} < ${d.interfaces.length}`).join(", ") || "none");
  const utilOff = withPorts.flatMap((d) => d.interfaces.filter((i) => i.util != null && !inRange(i.util, 0, 1000)).map((i) => `${d.name}/${i.name}=${i.util}`));
  check("Port utilisation is a percentage of its own speed", !utilOff.length, utilOff.slice(0, 3).join(", ") || "none");
  const speedOff = withPorts.flatMap((d) => d.interfaces.filter((i) => i.speedMbps != null && i.speedMbps <= 0).map((i) => `${d.name}/${i.name}`));
  check("Every port that reports a speed reports a positive one", !speedOff.length, speedOff.slice(0, 3).join(", ") || "none");
  // the bug that cost a release: the summary and the ports it summarises disagreeing
  const summaryOff = withPorts.filter((d) => {
    if (d.ifStats?.maxUtil == null) return false;
    const own = Math.max(0, ...d.interfaces.map((i) => i.util ?? 0));
    return own > 0 && Math.abs(d.ifStats.maxUtil - own) / Math.max(d.ifStats.maxUtil, own) > 0.25;
  });
  check("The per-device summary and that device's own ports agree", !summaryOff.length,
    summaryOff.slice(0, 3).map((d) => `${d.name}: ${d.ifStats.maxUtil} vs ${Math.max(...d.interfaces.map((i) => i.util ?? 0))}`).join(", ") || "none");

  // ---------------- circuits ----------------
  const downNoSince = circuits.filter((c) => c.status === "down" && !c.since);
  check("A circuit that is down says since when", !downNoSince.length, downNoSince.slice(0, 3).map((c) => c.id).join(", ") || "none");
  const downWithLatency = circuits.filter((c) => c.status === "down" && c.latencyMs != null);
  check("A circuit that is down reports no round trip", !downWithLatency.length, downWithLatency.slice(0, 3).map((c) => c.id).join(", ") || "none");
  const lossOff = circuits.filter((c) => c.lossPct != null && !inRange(c.lossPct, 0, 100));
  check("Circuit loss is a percentage", !lossOff.length, lossOff.slice(0, 3).map((c) => `${c.id}:${c.lossPct}`).join(", ") || "none");
  const slaOff = circuits.filter((c) => !num(c.slaMs) || c.slaMs <= 0);
  check("Every circuit carries a positive SLA", !slaOff.length, slaOff.slice(0, 3).map((c) => c.id).join(", ") || "none");
  const rttLen = new Set(circuits.filter((c) => c.rttTs?.length).map((c) => c.rttTs.length));
  check("Every circuit's round-trip series covers the same window", rttLen.size <= 1, [...rttLen].join("/") || "none");
  const primaryDownNotCritical = circuits.filter((c) => c.status === "down" && c.kind === "primary" && c.verdict !== "Critical");
  check("A primary circuit that is down is critical", !primaryDownNotCritical.length,
    primaryDownNotCritical.slice(0, 3).map((c) => `${c.id}:${c.verdict}`).join(", ") || "none");

  // ---------------- time ----------------
  const stamps = isoStrings(m);
  const future = stamps.filter(([, v]) => Date.parse(v) > now.getTime() + 60_000);
  check("Nothing in the example is dated in the future", !future.length, future.slice(0, 3).map(([p, v]) => `${p}=${v}`).join(", ") || `${stamps.length} timestamps`);
  const ancient = stamps.filter(([p, v]) => !/generatedAt/.test(p) && Date.parse(v) < now.getTime() - 30 * 24 * 3600e3);
  check("Nothing is older than the window the app reads", !ancient.length, ancient.slice(0, 3).map(([p, v]) => `${p}=${v}`).join(", ") || "none");
  const rebootOld = devices.filter((d) => d.rebootedAt && Date.parse(d.rebootedAt) < now.getTime() - 25 * 3600e3);
  check("A restart shown as recent happened in the last day", !rebootOld.length, rebootOld.slice(0, 3).map((d) => `${d.name}@${d.rebootedAt}`).join(", ") || "none");
  const silentWrong = devices.filter((d) => d.unreachableSince && Date.parse(d.unreachableSince) > now.getTime());
  check("A device that stopped answering did so in the past", !silentWrong.length, silentWrong.slice(0, 3).map((d) => d.name).join(", ") || "none");

  // ---------------- alerts ----------------
  const probs = devices.flatMap((d) => (d.problems ?? []).map((p) => ({ d, p })));
  const noTitle = probs.filter(({ p }) => !p.name);
  check("Every problem has a name", !noTitle.length, `${probs.length} problems`);
  const unplaced = m.unplacedAlerts ?? [];
  const noScope = unplaced.filter((a) => !a.scope);
  check("An alert the app could not place says what it is about", !noScope.length, `${unplaced.length} unplaced`);

  // ---------------- flows ----------------
  const f = m.flowMap;
  if (f) {
    const conv = f.conversations ?? [];
    const badEnds = conv.filter((c) => (c.fromKind === "site" && !sites[c.fromSite]) || (c.toKind === "site" && !sites[c.toSite]));
    check("Every conversation end that names a site names one that exists", !badEnds.length,
      badEnds.slice(0, 3).map((c) => `${c.fromSite}→${c.toSite}`).join(", ") || `${conv.length} conversations`);
    const emptyConv = conv.filter((c) => !(c.bytes > 0) || !(c.count > 0));
    check("Every conversation carries bytes and flows", !emptyConv.length, emptyConv.slice(0, 3).map((c) => `${c.via}:${c.bytes}/${c.count}`).join(", ") || "none");
    const rate = f.rate;
    if (rate) {
      const lens = new Set((rate.exporters ?? []).map((e) => e.bytes.length));
      check("Every exporter's bandwidth series covers the same buckets", lens.size <= 1, [...lens].join("/"));
      const negative = (rate.exporters ?? []).flatMap((e) => e.bytes.filter((v) => v != null && v < 0));
      check("No bandwidth bucket is negative", !negative.length, `${negative.length} negative`);
    }
    const st = Object.entries(f.sites ?? {});
    const partsOff = st.filter(([, t]) => Math.abs((t.toSites + t.toInternet + t.toPrivate) - t.bytes) > Math.max(2, t.bytes * 0.001));
    check("A site's traffic equals where it went", !partsOff.length,
      partsOff.slice(0, 3).map(([c, t]) => `${c}: ${t.toSites + t.toInternet + t.toPrivate} ≠ ${t.bytes}`).join(", ") || `${st.length} sites`);
    const peersOff = st.filter(([, t]) => (t.peers ?? []).some((p) => p.sent != null && p.received != null && Math.abs(p.sent + p.received - p.bytes) > Math.max(2, p.bytes * 0.001)));
    check("A peer's two directions add up to what it carried", !peersOff.length, peersOff.slice(0, 3).map(([c]) => c).join(", ") || "none");
  }

  // ---------------- the application's side ----------------
  // the application's experience hangs off the end-to-end path, not off the site: reading it from the
  // site left every check below filtering an empty list and passing on nothing
  const paths = m.e2e?.paths ?? [];
  const apps = paths.flatMap((p) => p.hops.map((h) => h.app).filter(Boolean));
  check("The example has end-to-end paths to check", paths.length > 0, `${paths.length} paths`);
  check("The example has an application experience to check", apps.length > 0, `${apps.length} applications`);
  const sessionsOff = apps.filter((a) => a.sessions < 0 || (a.baselineSessions != null && a.baselineSessions < 0));
  check("Session counts are not negative", !sessionsOff.length, `${apps.length} sites with an application`);
  const darkWithTiming = apps.filter((a) => a.sessions === 0 && (a.p90Ms != null || a.errPct != null));
  check("A site with no sessions reports no response time", !darkWithTiming.length, darkWithTiming.slice(0, 3).map((a) => a.name).join(", ") || "none");
  const pathSiteOff = (m.paths ?? []).filter((p) => p.remoteKind === "site" && !sites[p.remoteSite]);
  check("Every application path that names a site names one that exists", !pathSiteOff.length, `${(m.paths ?? []).length} paths`);

  // ---------------- what the screens derive ----------------
  const infos = allSites(m);
  const causes = buildCauses(m, infos);
  const causeSiteOff = causes.flatMap((c) => c.sites.filter((s) => !sites[s.code]).map((s) => `${c.title}→${s.code}`));
  check("Every cause points at sites that exist", !causeSiteOff.length, causeSiteOff.slice(0, 3).join(", ") || `${causes.length} causes`);
  const causeDeviceOff = causes.flatMap((c) => (c.devices ?? []).filter((d) => !byName.has(d.name)).map((d) => `${c.title}→${d.name}`));
  check("Every cause points at devices that exist", !causeDeviceOff.length, causeDeviceOff.slice(0, 3).join(", ") || "none");
  const causeSince = causes.filter((c) => c.since && Date.parse(c.since) > now.getTime() + 60_000);
  check("No cause started in the future", !causeSince.length, causeSince.slice(0, 3).map((c) => c.title).join(", ") || "none");
  const changes = changesOf(m, now);
  const changeOld = changes.filter((c) => Date.parse(c.t) < now.getTime() - 25 * 3600e3 || Date.parse(c.t) > now.getTime() + 60_000);
  check("Everything on the change list happened in the last day", !changeOld.length,
    changeOld.slice(0, 3).map((c) => `${c.title}@${c.t}`).join(", ") || `${changes.length} changes`);

  // ---------------- the end-to-end path ----------------
  // "WAN" is the sentinel the path uses for a hop that sits between sites rather than at one
  const hopSiteOff = paths.flatMap((p) => p.hops.filter((h) => h.site && h.site !== "WAN" && !sites[h.site]).map((h) => `${p.name}/${h.layer}`));
  check("Every hop sits at a site that exists", !hopSiteOff.length, hopSiteOff.slice(0, 3).join(", ") || `${paths.length} paths`);
  const firstBadOff = paths.filter((p) => p.summary?.firstBad != null && (p.summary.firstBad < 0 || p.summary.firstBad >= p.hops.length));
  check("The hop blamed for a path is one of its own hops", !firstBadOff.length, firstBadOff.slice(0, 3).map((p) => p.name).join(", ") || "none");
  const pathVerdictOff = paths.filter((p) => p.verdict && worst(p.hops.map((h) => h.verdict)) !== p.verdict);
  check("A path is as bad as its worst hop", !pathVerdictOff.length,
    pathVerdictOff.slice(0, 3).map((p) => `${p.name}: ${p.verdict} vs ${worst(p.hops.map((h) => h.verdict))}`).join(", ") || "none");
  const headlineOff = paths.flatMap((p) => p.hops.filter((h) => num(h.headline?.value) && h.headline.unit == null).map((h) => `${p.name}/${h.layer}`));
  check("A hop that shows a number shows its unit", !headlineOff.length, headlineOff.slice(0, 3).join(", ") || "none");
  const blamedHealthy = paths.filter((p) => p.summary?.firstBad != null && p.hops[p.summary.firstBad] && !isBad(p.hops[p.summary.firstBad].verdict));
  check("The hop blamed for a path is one that is actually bad", !blamedHealthy.length,
    blamedHealthy.slice(0, 3).map((p) => p.name).join(", ") || "none");

  // ---------------- the scenario is actually in there ----------------
  // a check that filters an empty list passes on nothing, so the example has to prove it still contains
  // the situations the screens are built to show
  const dark = devices.filter((d) => d.unreachableSince);
  const problemDevices = devices.filter((d) => open(d.problems).length);
  const downLinks = circuits.filter((c) => c.status === "down");
  const reboots = devices.filter((d) => d.rebootedAt);
  check("The example still contains devices that stopped answering", dark.length > 0, `${dark.length} dark`);
  check("The example still contains alerted devices", problemDevices.length > 0, `${problemDevices.length} alerted`);
  check("The example still contains a carrier outage", downLinks.length > 0, `${downLinks.length} links down`);
  check("The example still contains a restart", reboots.length > 0, `${reboots.length} restarts`);

  // ---------------- a device that is dark is dark everywhere ----------------
  const darkWithCpu = dark.filter((d) => d.cpuNow != null);
  check("A device that stopped answering reports no current CPU", !darkWithCpu.length, darkWithCpu.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const darkWithRtt = dark.filter((d) => d.icmp?.rttMs != null);
  check("A device that stopped answering reports no round trip", !darkWithRtt.length, darkWithRtt.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const darkFullAvail = dark.filter((d) => d.availPct === 100);
  check("A device that stopped answering is not shown as fully available", !darkFullAvail.length, darkFullAvail.slice(0, 3).map((d) => d.name).join(", ") || "none");
  const availOffSeries = devices.filter((d) => d.availTs?.length && Math.abs((100 * d.availTs.reduce((a, b) => a + (b ?? 0), 0)) / d.availTs.length - d.availPct) > 5);
  check("Availability equals the answers behind it", !availOffSeries.length,
    availOffSeries.slice(0, 3).map((d) => `${d.name}: ${d.availPct}`).join(", ") || "none");

  // ---------------- references the screens follow ----------------
  const linkOff = (m.links ?? []).filter((l) => !byName.has(l.a) || !byName.has(l.b));
  check("Every neighbour link joins two devices that exist", !linkOff.length, linkOff.slice(0, 3).map((l) => `${l.a}–${l.b}`).join(", ") || `${(m.links ?? []).length} links`);
  const peerOff = (m.peers ?? []).filter((p) => !byName.has(p.device));
  check("Every routing peer belongs to a device that exists", !peerOff.length, peerOff.slice(0, 3).map((p) => p.device).join(", ") || `${(m.peers ?? []).length} peers`);
  const trapOff = (m.traps ?? []).filter((t) => t.device && !byName.has(t.device));
  check("Every trap names a device that exists", !trapOff.length, trapOff.slice(0, 3).map((t) => t.device).join(", ") || `${(m.traps ?? []).length} traps`);
  const changeOff = changesOf(m, now).filter((c) => c.device && !byName.has(c.device));
  check("Everything on the change list names a device that exists", !changeOff.length, changeOff.slice(0, 3).map((c) => c.device).join(", ") || "none");
  // a Davis problem can legitimately sit on many devices (one carrier outage, fourteen sites), so what
  // must not repeat is the same problem on the same device
  const ids = devices.flatMap((d) => (d.problems ?? []).map((p) => `${d.name}|${p.eventId}`));
  check("No problem is attached to the same device twice", new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} repeated of ${ids.length}`);
  const noId = devices.flatMap((d) => (d.problems ?? []).filter((p) => !p.eventId || !p.displayId));
  check("Every problem carries the ids that open it in Dynatrace", !noId.length, `${ids.length} problems`);
  const futureProblem = devices.flatMap((d) => (d.problems ?? []).filter((p) => p.start && Date.parse(p.start) > now.getTime() + 60_000));
  check("No problem starts in the future", !futureProblem.length, futureProblem.slice(0, 3).map((p) => p.name).join(", ") || "none");

  // ---------------- what the applications feel ----------------
  const appNetOff = (m.paths ?? []).filter((p) => (p.retrPct != null && !inRange(p.retrPct, 0, 100)) || (p.rttP90Ms != null && p.rttP90Ms < 0) || p.resets < 0);
  check("Path quality readings stay inside their scale", !appNetOff.length, appNetOff.slice(0, 3).map((p) => p.workload).join(", ") || `${(m.paths ?? []).length} paths`);
  const convOff = (m.paths ?? []).filter((p) => p.conversations <= 0);
  check("Every application path carries conversations", !convOff.length, convOff.slice(0, 3).map((p) => p.workload).join(", ") || "none");

  // ---------------- the size the app reads it at ----------------
  if (size === "xl") {
    const withPortLists = devices.filter((d) => (d.interfaces ?? []).length).length;
    check("At extra-large size the ports are read as summaries, not lists",
      withPortLists / devices.length < 0.02 && devices.some((d) => d.ifStats),
      `${withPortLists} of ${devices.length} devices carry a port list`);
  }

  // ---------------- the headline numbers on the map ----------------
  // the map adds up what each cause reports offline. That only equals the number of sites that are
  // offline while no site belongs to two causes, which is the case here and is what this holds to.
  const appOfSite = (s) => paths.find((p) => p.site === s.code)?.hops.find((h) => h.kind === "app");
  const reallyOffline = new Set(infos.filter((s) => (appOfSite(s)?.app?.sessions ?? 1) === 0 || s.devices.some((d) => d.role === "edge" && d.unreachableSince)).map((s) => s.code));
  const headline = causes.reduce((a, c) => a + c.impact.offline, 0);
  check("The sites counted offline on the map are as many as the sites that are offline",
    headline === reallyOffline.size, `${headline} counted · ${reallyOffline.size} sites`);
  const twice = new Map();
  causes.forEach((c) => c.sites.forEach((s) => twice.set(s.code, (twice.get(s.code) ?? 0) + 1)));
  check("No site is claimed by two causes at once", ![...twice.values()].some((n) => n > 1),
    `${[...twice.values()].filter((n) => n > 1).length} sites in more than one cause`);
  const affectedOff = causes.flatMap((c) => c.sites.filter((s) => !isBad(s.verdict)).map((s) => `${c.title}→${s.code}:${s.verdict}`));
  check("Every site a cause claims is a site that is actually judged", !affectedOff.length, affectedOff.slice(0, 3).join(", ") || "none");

  // ---------------- a site is as bad as what stands at it ----------------
  const partsOf = (i) => [...i.devices.map((d) => d.verdict), ...(i.circuits ?? []).map((c) => c.verdict)];
  const onBackup = (i) => (i.circuits ?? []).some((c) => c.kind === "primary" && c.status === "down") && (i.circuits ?? []).some((c) => c.kind === "backup" && c.status === "up");
  const harsher = infos.filter((i) => partsOf(i).length && ORDER[i.verdict] < ORDER[worst(partsOf(i))]);
  check("A site is never worse than the worst thing standing at it", !harsher.length,
    harsher.slice(0, 3).map((i) => `${i.code}: ${i.verdict} vs ${worst(partsOf(i))}`).join(", ") || `${infos.length} sites`);
  // a site whose primary link is down but whose backup is carrying it is degraded, not down: that is the
  // one place the site reads better than a part of it, and it has to be that reason and no other
  const softer = infos.filter((i) => partsOf(i).length && ORDER[i.verdict] > ORDER[worst(partsOf(i))] && !onBackup(i));
  check("A site reads better than its parts only when a backup is carrying it", !softer.length,
    softer.slice(0, 3).map((i) => `${i.code}: ${i.verdict} vs ${worst(partsOf(i))}`).join(", ") || `${infos.filter(onBackup).length} sites on backup`);

  // ---------------- a port's utilisation is its own traffic over its own speed ----------------
  // the app reads utilisation as the busiest bucket of the series over the port's own speed, in bits:
  // the number in the table and the shape drawn beside it have to come from the same reading
  const ownUtil = (i) => (100 * Math.max(0, ...(i.in ?? []), ...(i.out ?? []))) / (i.speed * 1e6);
  const utilVsBytes = withPorts.flatMap((d) => d.interfaces.filter((i) => {
    if (i.util == null || !i.speed || !(i.in?.length || i.out?.length)) return false;
    const own = ownUtil(i);
    return own > 0 && Math.abs(own - i.util) / Math.max(own, i.util) > 0.02;
  }).map((i) => `${d.name}/${i.name}: ${i.util}% vs ${ownUtil(i).toFixed(1)}%`));
  check("A port's utilisation is its own busiest bucket over its own speed", !utilVsBytes.length, utilVsBytes.slice(0, 3).join(", ") || "none");
}

const only = process.argv[2];
for (const size of ["enterprise", "xl"]) {
  if (only && only !== size) continue;
  audit(size);
}

report.summary = {
  passed: report.checks.filter((c) => c.ok).length,
  of: report.checks.length,
  failed: report.checks.filter((c) => !c.ok).map((c) => `${c.scope}: ${c.name} — ${c.detail ?? ""}`),
};
writeFileSync("out/example_check.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
process.exit(report.summary.passed === report.summary.of ? 0 : 1);
