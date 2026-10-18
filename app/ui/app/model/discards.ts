// Ports losing packets, as the platform sees them.
//
// This used to hold the app's own detector: a port was "losing packets" when the recent half
// of its record held more discards than the earlier half. That rule called eighty-nine ports
// on this estate; asked about the same data, `NoveltyScoreAnalyzer` finds three, two of them
// decreases. Detection is the platform's job and this file no longer does it — what it does
// is read the record of the ports the platform named, so both pages say the same thing.
import type { Device, NetworkModel } from "./types";
import { noveltyKey, type Novelty, type NoveltyMap } from "../hooks/useNovelty";
import { isUp } from "./ports";

/** one port that is losing packets, with what the record says about it */
export interface DiscardPort {
  device: string;
  site: string;
  iface: string;
  /**
   * What the record holds for this port, or null where the app has no record of it.
   *
   * The platform names ports from the whole estate; this app reads an hourly record for the
   * ports its own queries covered, and the two sets are not the same — the panel printed "0
   * discards · 0%" beside a finding of "plateau of increased values", which reads as the two
   * contradicting each other when in truth one of them simply had nothing to say.
   */
  total: number | null;
  /** the busiest hour this port reached, in per cent of its own line rate */
  busy: number | null;
  /** what the platform called it, and how sure it is */
  novelty: Novelty;
  /** errors and CRC on the same port over the same window: the physical-layer discriminator */
  errors: number;
  crc: number;
  /** the port's state now, and what it is: a drop on a port that is down is a drop from before */
  oper: string;
  speedMbps: number | null;
  uplink: boolean;
}

/**
 * What the record separates these ports into, as counts and figures.
 *
 * No prose: the app states what it measured and leaves the reasoning to Assist, which is
 * handed the same groups. A port that also reports errors is a different problem from one
 * dropping at nought per cent of its line rate, and the difference is four fields the app
 * already holds — so it says which port is in which group and with what numbers, and stops
 * there.
 */
export type DiscardCase = "physical" | "down" | "burstOrPolicy" | "congestion";

export interface DiscardGroup {
  kind: DiscardCase;
  /** what the record shows, named in the app's own words — not a sentence */
  label: string;
  rows: DiscardPort[];
  /** the figures that put these ports in this group, already formatted */
  figures: string[];
}

/** the busiest hour below which the hourly record cannot be called congestion */
const QUIET = 1;
/** at or above this, the hour itself accounts for the drop */
const FULL = 70;
const n0 = (v: number) => v.toLocaleString("en-US");

export function discardCase(r: DiscardPort): DiscardCase {
  if (r.crc > 0 || r.errors > 0) return "physical";
  /* the same predicate the rest of the app uses: the value arrives as `up(1)`, and an
     exact comparison put every one of these ports in the "it is down" case */
  if (!isUp(r)) return "down";
  if (r.busy != null && r.busy >= FULL) return "congestion";
  return "burstOrPolicy";
}

export function discardGroups(rows: DiscardPort[]): DiscardGroup[] {
  const by = new Map<DiscardCase, DiscardPort[]>();
  for (const r of rows) by.set(discardCase(r), [...(by.get(discardCase(r)) ?? []), r]);
  const out: DiscardGroup[] = [];
  const g = (kind: DiscardCase, label: string, figures: (xs: DiscardPort[]) => string[]) => {
    const xs = by.get(kind);
    if (xs?.length) out.push({ kind, label, rows: xs, figures: figures(xs) });
  };
  g("physical", "errors on the same port", (xs) => [
    `${n0(xs.reduce((a, r) => a + r.crc, 0))} CRC`,
    `${n0(xs.reduce((a, r) => a + r.errors, 0))} errors`,
  ]);
  g("down", "port not up", (xs) => [`${xs.length} of ${rows.length}`]);
  g("congestion", `busiest hour at or above ${FULL}% of the line rate`, (xs) => [
    `up to ${Math.round(Math.max(...xs.map((r) => r.busy ?? 0)))}%`,
  ]);
  g("burstOrPolicy", `no error, no hour above ${QUIET}% of the line rate`, (xs) => [
    `${n0(xs.reduce((a, r) => a + (r.total ?? 0), 0))} discards`,
    "hourly record",
  ]);
  return out;
}

export interface Discards {
  /** the devices carrying at least one port the platform flagged */
  devices: Device[];
  /** how many such ports there are in total */
  ports: number;
  /** discards counted over the record on the ports the platform named */
  rise: number;
  /** the busiest hour any of those ports reached, in per cent of its own line rate */
  busiest: number;
  /** every flagged port, strongest first */
  rows: DiscardPort[];
  /** discards per hour summed over all of them, so the panel can say when it is happening */
  perHour: number[];
  /** the platform has not answered yet: the page says that rather than guessing */
  pending: boolean;
}

const EMPTY: Discards = { devices: [], ports: 0, rise: 0, busiest: 0, rows: [], perHour: [], pending: true };

export function discardingPorts(model: NetworkModel, rising: NoveltyMap | null): Discards {
  if (!rising) return EMPTY;
  const devices: Device[] = [];
  const rows: DiscardPort[] = [];
  const perHour: number[] = [];
  let ports = 0, rise = 0, busiest = 0;
  for (const d of model.devices) {
    /**
     * Increases only, and the direction comes from the platform's own words.
     *
     * `detectionMode: "INCREASE"` narrows the trend test but `CHANGE_IN_VALUES` still reports
     * a step down — measured here, the strongest finding on this estate was "Decrease in
     * values" at 96%. A port discarding less is a fact worth having and it is not this cause:
     * a card titled "losing packets" that leads with a fall is wrong about itself.
     */
    const bad = d.interfaces
      .map((i) => ({ i, n: rising.get(noveltyKey(d.ip, i.name)) }))
      .filter((x): x is { i: typeof x.i; n: Novelty } => !!x.n && !/decreas|lower|fall/i.test(x.n.text));
    if (!bad.length) continue;
    devices.push(d);
    ports += bad.length;
    for (const { i, n } of bad) {
      const dh = i.discHourly ?? [];
      const total = dh.length ? Math.round(dh.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)) : null;
      rise += total ?? 0;
      let own: number | null = null;
      for (const v of i.hourly ?? []) if (Number.isFinite(v) && (own == null || v > own)) own = v;
      if (own != null && own > busiest) busiest = own;
      /* The hours are aligned bucket for bucket across every port, so they add up: the sum is
         how many packets this cause dropped in each hour of the record — whether it is getting
         worse, and when it started, which a count of ports cannot say. */
      const off = perHour.length - dh.length;
      dh.forEach((v, k) => {
        const at = off >= 0 ? off + k : k;
        perHour[at] = (perHour[at] ?? 0) + (Number.isFinite(v) ? v : 0);
      });
      rows.push({ device: d.name, site: d.site ?? "", iface: i.name, total, busy: own, novelty: n,
        errors: i.errors ?? 0, crc: i.crc ?? 0, oper: i.oper, speedMbps: i.speed, uplink: !!i.uplink });
    }
  }
  // the platform's own confidence first, then the volume behind it
  rows.sort((a, b) => b.novelty.score - a.novelty.score || (b.total ?? 0) - (a.total ?? 0));
  devices.sort((a, b) => {
    const score = (d: Device) => Math.max(0, ...d.interfaces.map((i) => rising.get(noveltyKey(d.ip, i.name))?.score ?? 0));
    return score(b) - score(a);
  });
  return { devices, ports, rise, busiest, rows, perHour, pending: false };
}
