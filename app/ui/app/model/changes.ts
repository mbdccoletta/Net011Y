// What changed on the network in the last 24 hours, from data every environment already sends and that
// costs nothing to read: restarts (sysUpTime stepping down), devices that stopped or started answering
// SNMP, Davis problems that opened or closed, and circuits that went down. The app says what happened and
// when; it does not judge it.
import type { NetworkModel } from "./types";

export type ChangeKind = "restart" | "unreachable" | "answering" | "alert-open" | "alert-closed" | "circuit-down"
  /* what the devices themselves reported, counted in Grail rather than listed */
  | "flap" | "config" | "secured" | "neighbour";

export interface Change {
  t: string;
  kind: ChangeKind;
  title: string;
  detail: string;
  device?: string;
  site?: string;
  /** a group of the same change within a few minutes: the members, newest first */
  members?: Change[];
  /** how many times it happened, for a change the device counted rather than announced once */
  events?: number;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  restart: "Restarts", unreachable: "Stopped answering", answering: "Answering again",
  "alert-open": "Alerts opened", "alert-closed": "Alerts closed", "circuit-down": "Circuits down",
  flap: "Links going up and down", config: "Configuration written", secured: "Ports shut by the switch",
  neighbour: "Routing neighbours changed",
};

/**
 * The device's own vocabulary, mapped to the four things a reader does something about.
 *
 * A facility and a mnemonic is how a switch names an event — `%LINK-3-UPDOWN`,
 * `%SYS-5-CONFIG_I`. Anything this table does not name is not shown: the point of the panel
 * is the handful of kinds worth acting on, not a syslog tail.
 */
function kindOfLog(fac: string, mnem: string): ChangeKind | null {
  if (mnem === "UPDOWN") return "flap";
  if (mnem === "CONFIG_I") return "config";
  if (mnem === "RESTART" || mnem.includes("RELOAD")) return "restart";
  if (mnem.includes("ERR_DISABLE") || mnem.includes("PSECURE")) return "secured";
  if (mnem.includes("ADJCHG")) return "neighbour";
  void fac;
  return null;
}

const DAY = 24 * 3600e3;
/** the same change on several elements within this window is one event (an outage, a power cut) */
const GROUP_MS = 5 * 60e3;
const fmtTimes = (n: number) => (n === 1 ? "once" : `${n.toLocaleString("en-GB")} times`);
const ms = (s: string | null | undefined) => (s ? Date.parse(s.replace(/(\.\d{3})\d*Z$/, "$1Z")) : NaN);

export function changesOf(model: NetworkModel, now = Date.now()): Change[] {
  const out: Change[] = [];
  const recent = (s?: string | null) => { const t = ms(s); return Number.isFinite(t) && t >= now - DAY && t <= now + 60e3; };
  const siteName = (code: string) => model.sites[code]?.name ?? code;
  for (const d of model.devices) {
    if (d.rebootedAt && recent(d.rebootedAt)) out.push({ t: d.rebootedAt, kind: "restart", title: `${d.name} restarted`, detail: siteName(d.site), device: d.name, site: d.site });
    if (d.unreachableSince && recent(d.unreachableSince)) {
      out.push({ t: d.unreachableSince, kind: "unreachable", title: `${d.name} stopped answering`, detail: siteName(d.site), device: d.name, site: d.site });
    } else if (d.availTs?.length) {
      // the SNMP answers per bucket: the last bucket it answered again after a silent one, placed with the
      // window the query covered (not guessed from the clock)
      const a = d.availTs;
      const win = model.availWindow ?? { start: Math.floor(now / 3600e3) * 3600e3 - (a.length - 1) * 3600e3, stepMs: 3600e3 };
      for (let j = a.length - 1; j > 0; j--) {
        if (a[j] && !a[j - 1]) {
          const t = new Date(win.start + j * win.stepMs).toISOString();
          if (recent(t)) out.push({ t, kind: "answering", title: `${d.name} answering again`, detail: `${siteName(d.site)} · within ${Math.round((model.availWindow?.stepMs ?? 3600e3) / 60e3)} min of it`, device: d.name, site: d.site });
          break;
        }
      }
    }
  }
  const byName = new Map(model.devices.map((d) => [d.name, d] as const));
  // an alert that opened with the silence it reports is the same event: it is named on that row instead
  const silentAt = new Map(out.filter((c) => c.kind === "unreachable" && c.device).map((c) => [c.device!, c] as const));
  for (const p of model.alerting?.recent ?? []) {
    const dev = p.device ? byName.get(p.device) : undefined;
    const where = dev ? `${dev.name} · ${siteName(dev.site)}` : "network";
    const silent = dev ? silentAt.get(dev.name) : undefined;
    // the silence is known to the bucket the SNMP answers are counted in, the alert to the minute: an alert
    // that opened from that bucket on is the same event
    const tol = (model.availWindow?.stepMs ?? 3600e3) + 15 * 60e3;
    if (silent && recent(p.start) && ms(p.start) >= ms(silent.t) - 15 * 60e3 && ms(p.start) <= ms(silent.t) + tol) {
      if (!silent.detail.includes(p.name)) silent.detail += ` · alert: ${p.name}`;
    } else if (recent(p.start)) out.push({ t: p.start, kind: "alert-open", title: p.name, detail: where, device: dev?.name, site: dev?.site });
    if (p.end && recent(p.end)) out.push({ t: p.end, kind: "alert-closed", title: p.name, detail: where, device: dev?.name, site: dev?.site });
  }
  /**
   * What the devices reported, already counted.
   *
   * These do not arrive one per event — two hundred thousand syslog lines a day is not a list
   * — so each row is a port or a device with how many times it happened and when it last did.
   * That is also the only form in which they are useful: one link transition is noise, two
   * thousand on one port in six hours is a fault with an address.
   */
  const byIp = new Map(model.devices.map((d) => [d.ip, d] as const));
  /* the heaviest twenty of each kind. The query already returns them worst-first, and a list
     of three hundred ports that each blinked twice is the tail the panel exists to cut */
  const perKind = new Map<ChangeKind, number>();
  /**
   * One port going down is one change, not two.
   *
   * A switch logs the same transition twice under two facilities — `%LINK-3-UPDOWN` for the
   * interface and `%LINEPROTO-5-UPDOWN` for the protocol on it — and the query counts them
   * separately because it groups by facility. Unmerged, the panel listed
   * GigabitEthernet1/0/17 twice, at 433 and at 410, as if they were different ports.
   */
  const merged = new Map<string, { kind: ChangeKind; ip: string; iface: string | null; events: number;
    last: string; device: string | null; site: string | null }>();
  for (const r of model.netChanges ?? []) {
    const kind = kindOfLog(r.fac, r.mnem);
    if (!kind || !recent(r.last)) continue;
    const k = `${kind}|${r.ip}|${r.iface ?? ""}`;
    const had = merged.get(k);
    if (had) { had.events += r.events; if (ms(r.last) > ms(had.last)) had.last = r.last; }
    else merged.set(k, { kind, ip: r.ip, iface: r.iface, events: r.events, last: r.last, device: r.device, site: r.site });
  }
  for (const r of [...merged.values()].sort((a, b) => b.events - a.events)) {
    const kind = r.kind;
    const seen = perKind.get(kind) ?? 0;
    if (seen >= 20) continue;
    perKind.set(kind, seen + 1);
    const d = r.device ? byName.get(r.device) : byIp.get(r.ip);
    const what = r.iface || d?.name || r.ip;
    out.push({
      t: r.last, kind, events: r.events,
      title: kind === "flap" ? `${what} went up and down ${fmtTimes(r.events)}`
        : kind === "config" ? `${d?.name ?? r.ip} had its configuration written ${fmtTimes(r.events)}`
        : kind === "secured" ? `${what} was shut by the switch ${fmtTimes(r.events)}`
        : kind === "neighbour" ? `${d?.name ?? r.ip} changed routing neighbour ${fmtTimes(r.events)}`
        : `${d?.name ?? r.ip} restarted`,
      detail: d ? `${d.name} · ${siteName(d.site)}` : `${r.ip} · not in the inventory`,
      device: d?.name, site: d?.site,
    });
  }
  for (const c of model.circuits ?? []) {
    if (c.status === "down" && recent(c.since)) out.push({ t: c.since!, kind: "circuit-down", title: `${c.carrier} ${c.kind} circuit down`, detail: c.siteName, site: c.site });
  }
  // one row per burst: the same change on more than three elements within five minutes of each other
  // (clustered per kind, and per alert name, so bursts of different kinds do not break each other up)
  /* A counted change is already a group of its own — "this port, this many times" — so the
     burst rule must not run over it. It did, and wrote `18 × GigabitEthernet2/0/35 went up
     and down 390 times closed`: eighteen ports folded into one row under the wording meant
     for a run of closing alerts. */
  const COUNTED: ChangeKind[] = ["flap", "config", "secured", "neighbour"];
  const keyOf = (c: Change) => (c.kind.startsWith("alert") ? `${c.kind}|${c.title}` : c.kind);
  const byKey = new Map<string, Change[]>();
  out.forEach((c) => { const l = byKey.get(keyOf(c)); if (l) l.push(c); else byKey.set(keyOf(c), [c]); });
  const grouped: Change[] = [];
  byKey.forEach((list, key) => {
    list.sort((a, b) => ms(b.t) - ms(a.t));
    if (COUNTED.includes(list[0].kind)) { grouped.push(...list); return; }
    /**
     * One problem is one row, however long it took to reach every device.
     *
     * The burst rule below groups a run of the same change inside five minutes, which is right
     * for a power cut and wrong for a monitoring outage: measured here, the same
     * "Network availability monitor global outage" arrived on twenty-four devices between
     * 20:30 and 20:41, eleven minutes, so every one of them got its own row and the panel read
     * "86 changes" about one problem. An alert carries its own identity in its name; two of
     * the same name in a day are the same event.
     */
    if (key.startsWith("alert") && list.length > 1) {
      const sites = new Set(list.map((c) => c.site).filter(Boolean));
      const span = Math.max(1, Math.round((ms(list[0].t) - ms(list[list.length - 1].t)) / 60e3));
      grouped.push({ t: list[0].t, kind: list[0].kind, events: list.length,
        title: `${list[0].title} · ${list.length} devices`,
        detail: `${sites.size || "no"} site${sites.size === 1 ? "" : "s"} · over ${span} min`,
        members: list });
      return;
    }
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && ms(list[j - 1].t) - ms(list[j].t) <= GROUP_MS) j++;
      const run = list.slice(i, j);
      if (run.length > 3) {
        const k = run[0].kind, sites = new Set(run.map((c) => c.site).filter(Boolean));
        const what = k === "circuit-down" ? "circuits went down" : k === "restart" ? "devices restarted" : k === "unreachable" ? "devices stopped answering"
          : k === "answering" ? "devices answering again" : k === "alert-open" ? `× ${run[0].title}` : `× ${run[0].title} closed`;
        const span = Math.max(1, Math.round((ms(run[0].t) - ms(run[run.length - 1].t)) / 60e3));
        const where = sites.size ? `${sites.size} site${sites.size === 1 ? "" : "s"} within ${span} min` : `within ${span} min`;
        grouped.push({ t: run[0].t, kind: k, title: `${run.length} ${what}`, detail: where, members: run });
      } else grouped.push(...run);
      i = j;
    }
  });
  /* newest first, and where two land in the same minute the busier one leads: a hundred
     counted rows all end at the window's edge, so time alone leaves them in no order at all */
  grouped.sort((a, b) => ms(b.t) - ms(a.t) || (b.events ?? 1) - (a.events ?? 1));
  return grouped;
}
