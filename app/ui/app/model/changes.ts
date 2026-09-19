// What changed on the network in the last 24 hours, from data every environment already sends and that
// costs nothing to read: restarts (sysUpTime stepping down), devices that stopped or started answering
// SNMP, Davis problems that opened or closed, and circuits that went down. The app says what happened and
// when; it does not judge it.
import type { NetworkModel } from "./types";

export type ChangeKind = "restart" | "unreachable" | "answering" | "alert-open" | "alert-closed" | "circuit-down";

export interface Change {
  t: string;
  kind: ChangeKind;
  title: string;
  detail: string;
  device?: string;
  site?: string;
  /** a group of the same change within a few minutes: the members, newest first */
  members?: Change[];
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  restart: "Restarts", unreachable: "Stopped answering", answering: "Answering again",
  "alert-open": "Alerts opened", "alert-closed": "Alerts closed", "circuit-down": "Circuits down",
};

const DAY = 24 * 3600e3;
/** the same change on several elements within this window is one event (an outage, a power cut) */
const GROUP_MS = 5 * 60e3;
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
      // hourly SNMP answers: the last hour it answered again after a silent one
      const a = d.availTs;
      for (let j = a.length - 1; j > 0; j--) {
        if (a[j] && !a[j - 1]) {
          const t = new Date(Math.floor(now / 3600e3) * 3600e3 - (a.length - 1 - j) * 3600e3).toISOString();
          if (recent(t)) out.push({ t, kind: "answering", title: `${d.name} answering again`, detail: `${siteName(d.site)} · within that hour`, device: d.name, site: d.site });
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
    if (silent && recent(p.start) && Math.abs(ms(silent.t) - ms(p.start)) <= 15 * 60e3) {
      if (!silent.detail.includes(p.name)) silent.detail += ` · alert: ${p.name}`;
    } else if (recent(p.start)) out.push({ t: p.start, kind: "alert-open", title: p.name, detail: where, device: dev?.name, site: dev?.site });
    if (p.end && recent(p.end)) out.push({ t: p.end, kind: "alert-closed", title: p.name, detail: where, device: dev?.name, site: dev?.site });
  }
  for (const c of model.circuits ?? []) {
    if (c.status === "down" && recent(c.since)) out.push({ t: c.since!, kind: "circuit-down", title: `${c.carrier} ${c.kind} circuit down`, detail: c.siteName, site: c.site });
  }
  // one row per burst: the same change on more than three elements within five minutes of each other
  // (clustered per kind, and per alert name, so bursts of different kinds do not break each other up)
  const keyOf = (c: Change) => (c.kind.startsWith("alert") ? `${c.kind}|${c.title}` : c.kind);
  const byKey = new Map<string, Change[]>();
  out.forEach((c) => { const l = byKey.get(keyOf(c)); if (l) l.push(c); else byKey.set(keyOf(c), [c]); });
  const grouped: Change[] = [];
  byKey.forEach((list) => {
    list.sort((a, b) => ms(b.t) - ms(a.t));
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
  grouped.sort((a, b) => ms(b.t) - ms(a.t));
  return grouped;
}
