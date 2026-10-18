// Every subject, what it uses of its own limit, and how high the platform says it could get.
//
// The card above this and the list it opens read the same two numbers for the same subjects, so
// they are read once, here. Both call this hook with the same subjects and the forecast cache
// answers the second one without a request.
import { useMemo } from "react";
import { askForSubject, portKey, usePortsForecast } from "../../hooks/useDavisForecast";
import type { Subject } from "../../model/ahead";

/** the three kinds the card separates, because a per cent of one is not a per cent of another */
export type RoomKind = "port" | "cpu" | "mem";

/**
 * Each kind names the quantity its per cent is a per cent *of*, twice.
 *
 * `unit` is the sentence under the card's title, and it used to say "per cent of all it has"
 * — true, and it does not say what "it" is holding. The reader was left with a column of
 * `89.6%` and nothing on the screen naming memory. It names the quantity now.
 *
 * `short` is the same thing at the width of a column heading, because the heading is what a
 * reader is looking at while scanning the column, not the sentence four rows above it.
 */
export const ROOM_KINDS: { id: RoomKind; name: string; unit: string; short: string; noun: string; owner: string }[] = [
  { id: "port", name: "Port traffic", unit: "% of the line rate in use", short: "% of line rate",
    noun: "uplinks", owner: "Device" },
  { id: "cpu", name: "CPU", unit: "% of the processor in use", short: "% of processor",
    noun: "processors", owner: "Site" },
  { id: "mem", name: "Memory", unit: "% of the memory in use", short: "% of memory",
    noun: "memories", owner: "Site" },
];

export const kindOf = (s: Subject): RoomKind =>
  s.kind === "port" ? "port" : s.kind === "memory" ? "mem" : "cpu";

export interface RoomCell {
  s: Subject;
  /** the busy hour it actually reached, in per cent of its own limit */
  now: number;
  /**
   * The highest the analyzer's band goes over the horizon, or null where it did not answer.
   *
   * The upper band and not the point forecast, and that is a correction rather than a taste.
   * Measured on this environment, eighty-six of ninety-five uplinks get a point forecast that
   * is a smooth daily cycle with the spikes taken out: Ethernet1/31 measures a busy hour of
   * 63.6% of its line rate and its point forecast peaks at 11.4%. Reading that as "where it
   * will be" draws a fifty-two point collapse that nothing in the data claims. The point
   * answers what a subject will usually be; the band's top answers how high it could get,
   * which is the only one of the two a capacity reader is asking.
   */
  reach: number | null;
  /** what it is expected to be, kept for the list — the same point forecast, honestly labelled */
  expected: number | null;
}

const peak = (a: number[] | undefined) => {
  let m: number | null = null;
  for (const v of a ?? []) if (Number.isFinite(v) && (m == null || v > m)) m = v;
  return m == null ? null : Math.round(m * 10) / 10;
};

/**
 * A forecast that leaves the quantity's own range is not a forecast of that quantity.
 *
 * Memory, a processor and a port's share of its line rate are all bounded at a hundred by
 * definition — a switch cannot use more memory than it has. Measured here, the analyzer
 * returned a point forecast of 123% and a band reaching 217% for the memory of
 * BR-PR-CWB1-SWA-017, with `forecastQualityAssessment: VALID`, so quality does not catch it.
 * Clamping that to a hundred is the worst of the three options: it turns an impossible number
 * into a plausible one and rings the device as "could reach 90%" on the strength of it.
 *
 * The test is the point forecast, not the band. The point is the central estimate, so a point
 * above the maximum possible value is unambiguous and needs no threshold chosen by this app;
 * a band that reaches past a hundred around a sane point is just a wide band on something
 * genuinely near its ceiling, and clamps.
 */
function reading(point: number[] | undefined, upper: number[] | undefined) {
  const p = peak(point);
  if (p == null || p > 100) return { reach: null, expected: null };
  const u = peak(upper);
  const cap = (v: number | null) => (v == null ? null : Math.min(100, Math.max(0, v)));
  return { reach: cap(u ?? p), expected: cap(p) };
}

/**
 * The cells, by kind, plus whether the platform has finished answering.
 *
 * `now` is measured and never waits: the comb is drawn from the record the moment it is built,
 * and the forecast fills in behind it. A card that renders nothing until four hundred series
 * come back shows an empty frame for the half-minute the analyzer takes.
 */
export function useRoom(subjects: Subject[]): {
  cells: Record<RoomKind, RoomCell[]>;
  /** how many of them the analyzer has answered about */
  answered: number;
  loading: boolean;
  error: string | null;
} {
  const asks = useMemo(() => subjects
    .map((x) => ({ x, ask: askForSubject(x).ask }))
    .filter((p): p is { x: Subject; ask: NonNullable<typeof p.ask> } => !!p.ask), [subjects]);
  const { data, loading, error } = usePortsForecast(useMemo(() => asks.map((a) => a.ask), [asks]));

  return useMemo(() => {
    const byKey = new Map(asks.map(({ x, ask }) => [x.key, ask]));
    const cells: Record<RoomKind, RoomCell[]> = { port: [], cpu: [], mem: [] };
    let answered = 0;
    for (const s of subjects) {
      if (!s.room) continue;              // no published limit, so no per cent of one
      const ask = byKey.get(s.key);
      const fc = ask ? data.get(portKey(ask)) : undefined;
      const { reach, expected } = reading(fc?.point, fc?.upper);
      if (reach != null) answered++;
      cells[kindOf(s)].push({ s, now: Math.round(s.room.busy * 10) / 10, reach, expected });
    }
    return { cells, answered, loading, error };
  }, [subjects, asks, data, loading, error]);
}

/** the move the card is allowed to draw: under this, the band itself is wider than the change */
export const DEAD = 0.4;
/** the one number the card names, and it names it as a place on the scale, not as a verdict */
export const NEAR = 90;

export const moveOf = (c: RoomCell) =>
  (c.reach == null ? null : Math.round((c.reach - c.now) * 10) / 10);
