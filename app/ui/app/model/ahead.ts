/**
 * What is coming, and how much of it the record can actually carry.
 *
 * This page used to be a trend forecaster: a straight line through thirty days, carried six months
 * forward, announcing a date. Measured against two live environments that was mostly fiction. Of
 * twenty-one series whose rise was confident enough to survive a noise test, nineteen contained a
 * level change and thirteen were flat after it — the slope described an event that had already
 * finished, and the date it produced was an artifact of that event. One host that jumped from 27%
 * to 46% in a day and held there would have been announced as saturating in thirty-nine days.
 *
 * So the module says four things instead of one, ordered by how much the record supports them:
 *
 *   dropping   its discard rate has started rising. Observed, and no stated limit is needed.
 *   changed    it stepped to a new level and stayed. An event, with a date in the past.
 *   one jump   its headroom is smaller than a rise it has already shown. Arithmetic on the
 *              subject's own behaviour, so the app holds no threshold of its own.
 *   climbing   a trend that survives *after* the step, reaching a limit inside a horizon no
 *              longer than twice the record it rests on.
 *
 * Only the last is a forecast, and on a month of daily record it is usually empty. That emptiness
 * is the honest answer, not a gap to fill.
 */
import type { Device, Iface, NetworkModel } from "./types";

/**
 * A number of hours, in the unit a reader would use for it.
 *
 * Every index in this module is an hour since the record went hourly, and printing "312 d" for
 * what is really thirteen days was the kind of error nobody catches by reading code. Under two
 * days it stays in hours, because "30 h" is a different thing from "1 d" to whoever has to act.
 */
export const hrs = (h: number): string => {
  const n = Math.round(h);
  if (!Number.isFinite(n)) return "—";
  if (n < 48) return `${n} h`;
  const d = n / 24;
  return d < 10 ? `${d.toFixed(1)} d` : `${Math.round(d)} d`;
};

/** the furthest the app will ever project, whatever the record length allows */
/** in hours: six months, the furthest the app will ever project whatever the record allows */
export const HORIZON = 180 * 24;
/** a split has to beat this to be a level change; many splits are tried, and the best of many flatters itself */
const STEP_T = 4;
/** a straight line needs this many points before it is a line rather than a mood */
const MIN_POINTS = 24;

export interface Step {
  /** index into the samples where the new level starts, for refitting the regime after it */
  at: number;
  /** how many days ago that was, counted on the calendar and not on the samples */
  /** hours between the step and the end of the record */
  ago: number;
  from: number;
  to: number;
  t: number;
}

export interface Fit {
  slope: number;
  /** standard error of the slope: the rise has to beat its own noise, not merely be positive */
  se: number;
  /** points the line was fitted through — after the step, when there is one */
  points: number;
  /** the furthest this record is allowed to speak for: twice its own length */
  far: number;
  rising: boolean;
  /** why there is no date, when there is none */
  why: string | null;
  at: (days: number) => number;
  band: (days: number) => number;
  /** days until it reaches the limit, or null when the record cannot say */
  mid: number | null;
  lo: number;
  hi: number;
}

export type AheadState = "dropping" | "changed" | "onejump" | "climbing" | "quiet";
export const STATES: AheadState[] = ["dropping", "changed", "onejump", "climbing", "quiet"];

export interface Reading {
  /** the series, as percentages of whatever limit its owner stated */
  hist: number[];
  /** where it stopped being one thing and became another */
  step: Step | null;
  /** where it sits now: the mean of the last three samples, so one spike is not "now" */
  now: number;
  /** the largest rise it has actually shown — its own unit of surprise */
  jump: number;
  /** discards counted in the window, when the rate is rising; zero otherwise */
  drops: number;
  fit: Fit | null;
  state: AheadState;
}

/**
 * Where a series stopped being one thing and became another.
 *
 * Every split is tried and the most separated kept, judged by how far the two means lie apart
 * relative to the scatter inside each. This matters more than the trend, because a level change is
 * easy to see in a month of record while a slope mostly is not — which is exactly backwards from
 * what the first version of this page measured.
 */
export function findStep(hist: number[]): Step | null {
  // The real position of every sample is kept, because a record with holes is the common case —
  // on one live environment 46% of interfaces have gaps inside their own span — and counting
  // samples instead of days would tell a reader something changed twenty-one days ago when the
  // calendar says thirty.
  const pts = hist.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  const y = pts.map(([, v]) => v);
  const n = y.length;
  if (n < 48) return null;
  const last = pts[n - 1][0];
  let best: Step | null = null;
  let bestRss = Infinity;
  /**
   * Every split in one pass, not one pass per split.
   *
   * This sliced the series in two and summed both halves for each of the n candidate cuts:
   * O(n²), with four allocations an iteration. It cost nothing while the record was a
   * fortnight — 336 points — and lengthening it to sixty days put one task of 5.2 seconds on
   * the main thread for twenty-seven subjects, measured, which is the page freezing in front
   * of the reader. Running sums of the values and of their squares give each half's mean and
   * residual sum in constant time, so the loop is linear and allocates nothing. The arithmetic
   * is the same arithmetic: sum((x-m)²) = sum(x²) - sum(x)²/count.
   */
  const sum = new Float64Array(n + 1), sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { sum[i + 1] = sum[i] + y[i]; sq[i + 1] = sq[i] + y[i] * y[i]; }
  const dev = (s: number, q: number, c: number) => Math.max(0, q - (s * s) / c);
  for (let k = 12; k <= n - 12; k++) {
    const sa = sum[k], sb = sum[n] - sum[k];
    const ma = sa / k, mb = sb / (n - k);
    const ss = dev(sa, sq[k], k) + dev(sb, sq[n] - sq[k], n - k);
    const sd = Math.sqrt(ss / (n - 2)) || 1e-9;
    const t = Math.abs(mb - ma) / (sd * Math.sqrt(1 / k + 1 / (n - k)));
    if (!best || t > best.t) { best = { t, at: k, ago: last - pts[k][0], from: ma, to: mb }; bestRss = ss; }
  }
  if (!best || best.t <= STEP_T) return null;
  // A smooth ramp splits into two well-separated halves and looks exactly like a step, which would
  // turn every genuine trend into "something changed" and cost it its forecast — the mirror image
  // of the error this detector exists to prevent. So the step has to beat a straight line, not
  // merely a flat one: it is only a change of level if two levels explain the record better than
  // one slope does.
  const sx = y.reduce((a, _, i) => a + i, 0);
  const sy = y.reduce((a, v) => a + v, 0);
  const sxx = y.reduce((a, _, i) => a + i * i, 0);
  const sxy = y.reduce((a, v, i) => a + i * v, 0);
  const den = n * sxx - sx * sx;
  if (den) {
    const m = (n * sxy - sx * sy) / den;
    const c = (sy - m * sx) / n;
    const lineRss = y.reduce((a, v, i) => a + (v - (c + m * i)) ** 2, 0);
    if (bestRss > lineRss * 0.75) return null;
  }
  return best;
}

/**
 * Least squares through the current regime only.
 *
 * `from` is where that regime starts. Fitting across a step produces a confident slope describing
 * the step rather than the future, so the caller passes the changepoint and the line is drawn only
 * through what has happened since.
 *
 * Two refusals are built in. The slope must be positive *with confidence* — `slope - 1.96·se > 0`
 * — because a rise smaller than the noise it sits in is not a rise. And the horizon is twice the
 * record and no further: projecting a hundred and eighty days from thirty is a six-fold
 * extrapolation whose confidence band quietly assumes the line still holds out there.
 */
export function fitLine(hist: number[], from = 0): Fit | null {
  const pts = hist.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v)).slice(from);
  if (pts.length < MIN_POINTS) return null;
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const resid = pts.reduce((a, [x, y]) => a + (y - (intercept + slope * x)) ** 2, 0);
  const se = Math.sqrt(resid / Math.max(1, n - 2)) / Math.sqrt(sxx - (sx * sx) / n);
  const last = pts[pts.length - 1][0];
  const at = (d: number) => intercept + slope * (last + d);
  const band = (d: number) => 1.96 * se * d;
  const rising = slope - 1.96 * se > 0;
  // Twice the record, measured as the days it covers rather than the samples it holds: a series
  // with holes still has that much history behind it, and the rule is about how far a line may be
  // carried past what has been observed.
  const span = pts[pts.length - 1][0] - pts[0][0] + 1;
  const far = Math.min(HORIZON, span * 2);
  const cross = (s: number) => (s <= 0 ? null : (100 - at(0)) / s);
  const ok = (v: number | null) => (v != null && Number.isFinite(v) && v > 0 && v <= far ? Math.round(v) : null);
  return {
    slope, se, points: n, far, rising, at, band,
    why: rising ? null : slope <= 0 ? "flat or falling" : "the rise is inside the noise",
    mid: rising ? ok(cross(slope)) : null,
    lo: ok(cross(slope + 1.96 * se)) ?? 0,
    hi: ok(cross(slope - 1.96 * se)) ?? far,
  };
}

/** the largest rise the series has actually shown: the subject's own unit of surprise, not ours */
export function jumpOf(hist: number[], step: Step | null): number {
  if (step && step.to > step.from) return step.to - step.from;
  const y = hist.filter((v) => Number.isFinite(v));
  let m = 0;
  for (let i = 1; i < y.length; i++) m = Math.max(m, y[i] - y[i - 1]);
  return m;
}

/**
 * Read a series as a history rather than a number.
 *
 * `drops` is the count of discards the caller believes to be *rising*. A discard counter that has
 * been non-zero for months is a configuration artifact — policing, a duplex mismatch, a QoS drop —
 * and on one live environment forty percent of interfaces carry one. Reporting those as "already
 * hurting" buries the few that matter, so the caller passes zero unless the rate itself moved.
 */
export function read(hist: number[], drops = 0): Reading {
  const y = hist.filter((v) => Number.isFinite(v));
  const step = findStep(hist);
  const now = y.length ? y.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, y.length) : 0;
  const jump = jumpOf(hist, step);
  const fit = fitLine(hist, step ? step.at : 0);
  // "Changed" means something happened and settled. A subject that stepped and is *still* climbing
  // toward a limit has a live forecast, and burying its date under the label of a finished event
  // was the original mistake in reverse: the first version fitted across the step and invented a
  // date, this one found a real date and hid it.
  const climbing = !!fit && fit.rising && fit.mid != null;
  const state: AheadState = !y.length ? "quiet"
    : drops > 0 ? "dropping"
    : step && step.to > step.from && !climbing ? "changed"
    : jump > 0 && now + jump >= 100 ? "onejump"
    : climbing ? "climbing"
    : "quiet";
  return { hist, step, now, jump, drops, fit, state };
}

/** Φ, by Abramowitz–Stegun 7.1.26: enough for a percentage a human reads */
function phi(z: number): number {
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/**
 * The chance this crosses its limit by day `d`.
 *
 * A date hides how sure the line is; a probability carries it. The projected value at day d is
 * normal around the line, widening as the line is carried further, so the chance of being past
 * the limit by then is the mass of that distribution above it. At one day out the spread is
 * almost nothing and the answer is nearly yes or no; at thirty it is a genuine maybe, which is
 * the honest reading and the one a date never gives.
 */
export function chanceBy(f: Fit, d: number): number {
  if (d <= 0) return f.at(0) >= 100 ? 1 : 0;
  const sd = Math.max(1e-6, (f.se * d) / 1.96 * 1.96);
  return Math.min(1, Math.max(0, 1 - phi((100 - f.at(d)) / Math.max(1e-6, sd))));
}

/** the first day the chance passes a half — the "probably by then" a reader can plan against */
export function likelyDay(f: Fit): number | null {
  for (let d = 1; d <= f.far; d++) if (chanceBy(f, d) >= 0.5) return d;
  return null;
}

export interface Backtest {
  /** held-out samples whose actual value fell inside the band the earlier record predicted */
  inBand: number;
  of: number;
  /** median absolute error over the held-out days, in points of the limit */
  error: number;
  grade: "good" | "fair" | "poor";
}

/**
 * Does this method work on this series? Asked of the series itself, before it is trusted.
 *
 * The record is cut two thirds of the way through, a line is fitted to the earlier part alone, and
 * the days it never saw are scored against it. Nothing here is stored or waited for — the test
 * runs on the same month already in hand — and it answers the only question that matters about a
 * forecast before its date arrives: when this method was last asked to predict this thing, how
 * often was it right?
 */
export function backtest(hist: number[], from = 0): Backtest | null {
  const y = hist.filter((v) => Number.isFinite(v)).slice(from);
  if (y.length < 14) return null;
  const cut = Math.floor(y.length * 0.67);
  const f = fitLine(y.slice(0, cut));
  if (!f) return null;
  const held = y.slice(cut);
  let inBand = 0;
  const errs: number[] = [];
  held.forEach((actual, i) => {
    const d = i + 1;
    const mid = f.at(d), half = Math.max(1, f.band(d));
    if (Math.abs(actual - mid) <= half) inBand++;
    errs.push(Math.abs(actual - mid));
  });
  errs.sort((a, b) => a - b);
  const error = errs[errs.length >> 1];
  const share = inBand / held.length;
  return { inBand, of: held.length, error,
    grade: share >= 0.8 && error < 8 ? "good" : share >= 0.5 ? "fair" : "poor" };
}

/**
 * How many days ago this first reached its limit, from the record rather than from a model.
 *
 * The left half of the runway is not a forecast and must not be drawn like one: every point on it
 * is a day the series was actually at or over the line its owner stated. A subject that touched
 * the limit once and fell back has not arrived, so the crossing only counts when the rest of the
 * record mostly stays there.
 */
export function crossedAgo(hist: number[]): number | null {
  const pts = hist.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return null;
  const last = pts[pts.length - 1][0];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][1] < 100) continue;
    const after = pts.slice(i);
    if (after.filter(([, v]) => v >= 100).length >= after.length * 0.6) return last - pts[i][0];
  }
  return null;
}

export interface Subject {
  key: string;
  /** "device" is the processor; "memory" is what the device has in use, both device-level */
  kind: "link" | "port" | "device" | "memory";
  /** what the reader calls it */
  name: string;
  /** the second line: which device, which role */
  sub: string;
  site: string;
  /** the limit in the owner's words — never one the app chose */
  limit: string;
  device?: Device;
  iface?: Iface;
  reading: Reading;
  /** how far its busy hour sits below the ceiling it has shown, or the one its owner stated */
  room?: Headroom | null;
}

/** why a subject has nothing to say, in the words the page counts it under */
export function silence(r: Reading): string {
  if (!r.fit) return "too little record";
  if (!r.fit.rising) return r.fit.why ?? "flat or falling";
  return "reaches the limit beyond what the record can see";
}

/**
 * Every port and processor the model carries, read the same way.
 *
 * A device contributes its processor and the one uplink with the strongest claim — not every
 * uplink, because four ports on ten thousand devices is forty thousand rows nobody reads, and the
 * device page shows the whole faceplate anyway.
 *
 * Circuits are absent on purpose. A WAN circuit's limit is its contracted rate, which exists in no
 * documented Dynatrace format: it is a term of a contract. Until it arrives as a tag the honest
 * thing is to leave circuits out rather than invent a limit for them.
 */

// ── busy-hour headroom ─────────────────────────────────────────────────────────────────────
//
// Why this exists, and why it is not another forecast.
//
// Measured on a live environment, two things are true at once: the trend model finds nothing
// (zero crossings across 295 subjects, and the platform's own analyzer agrees), and the network
// is not actually as idle as that implies. Two reasons, both measured:
//
//   · the busy hour sits 2.93× above the mean hour (p95 of hours ÷ mean, median over 222
//     interfaces). Capacity is sized against the hour a link is busiest, so a reading taken on
//     the central tendency is optimistic by about that factor.
//   · 85% of the hours in which a port discarded a packet were below half its line rate, at a
//     median of 36.6%. An hour average cannot explain a discard at a third of the rate; the
//     line rate is therefore not the ceiling those ports behave as if they had.
//
// So this reports a quantity that exists for every subject, where a crossing date usually does
// not: how far its busy hour sits below the lowest utilisation at which it has been seen to
// discard — or below its stated limit, when it has never discarded. It is a measurement of
// today, not a projection, and it is deliberately not called a forecast.

/** the p-th percentile of the finite values, or null when there are none */
export function quantile(xs: number[], p: number): number | null {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/**
 * The busy hour of a typical day: the median of the daily maxima.
 *
 * Not a percentile over hours, which is the obvious choice and the wrong one. A peak that lasts
 * one hour a day is four per cent of the hours, so the 95th percentile sits *below* it — the
 * first version of this function returned 20 on a series that peaked at 60 every single day,
 * and the suite caught it. The industry's p95 is computed over five-minute samples for billing,
 * which is a different quantity with the same name.
 *
 * The median of the daily maxima is what a capacity planner means by the busy hour: the height
 * of a normal day's peak, robust to one freak day in either direction.
 */
export function busyHour(hist: number[], days = 14): number | null {
  const live = hist.filter((v) => Number.isFinite(v));
  if (!live.length) return null;
  const tail = live.slice(-days * 24);
  const peaks: number[] = [];
  for (let i = 0; i < tail.length; i += 24) {
    const day = tail.slice(i, i + 24);
    if (day.length >= 12) peaks.push(Math.max(...day));
  }
  return peaks.length ? quantile(peaks, 0.5) : quantile(tail, 0.95);
}

/**
 * The ceiling the interface demonstrated, as distinct from the one on its label.
 *
 * Only where the record separates: a port that discarded in some hours and ran clean in many
 * others has shown where its trouble starts. Measured, most discarding ports do not separate —
 * the median discards in 62% of its hours — so this returns null far more often than not, and
 * the caller must fall back to the stated limit rather than invent one.
 */
export function shownCeiling(hist: number[], disc: number[] | undefined): number | null {
  if (!disc || disc.length < 48) return null;
  const bad: number[] = [], good: number[] = [];
  for (let i = 0; i < Math.min(hist.length, disc.length); i++) {
    const u = hist[i];
    if (!Number.isFinite(u) || u <= 0) continue;
    (disc[i] > 0 ? bad : good).push(u);
  }
  // it has to both discard and run clean, often enough that the split means something
  if (bad.length < 5 || good.length < 24) return null;
  const share = bad.length / (bad.length + good.length);
  if (share > 0.8) return null;               // discards in nearly every hour: a condition, not a level
  const starts = quantile(bad, 0.1);
  const clean95 = quantile(good, 0.95);
  if (starts == null || clean95 == null) return null;
  // and the two populations have to actually differ, or the "ceiling" is just the port's range
  return starts > clean95 * 0.6 ? starts : null;
}

export interface Headroom {
  /** the 95th percentile of the recent record: what the link has to carry at its worst hour */
  busy: number;
  /** the ceiling used, and where it came from */
  ceiling: number;
  source: "shown" | "stated";
  /** points between the two; negative means the busy hour is already past the ceiling */
  pts: number;
  /**
   * Where this port starts dropping packets, when that is far below its line rate.
   *
   * A demonstrated ceiling at a few per cent of a gigabit is not a capacity: it is a policer,
   * a shaper, a duplex mismatch or bad optics. The study behind this page measured the line —
   * 85% of the hours in which a port discarded were below half its line rate, which is where
   * capacity stops being able to explain a discard — so a ceiling under half is kept as a
   * fact about the port and not used as the limit its room is measured against. Otherwise a
   * port at 3% of a gigabit outranks one at 85% in a card called "the tightest".
   */
  dropsAt?: number;
}

/**
 * Busy-hour headroom. Defined for every subject with a record, which is the point: an estate
 * with no crossings still has a worst subject by this measure.
 */
/**
 * Room, measured on the regime the subject is in now — not across a level change.
 *
 * The busy hour is a median over a fortnight, and a fortnight can hold two different ports. On
 * this estate `Te1/1/1` carried thirty to fifty per cent for six days, stopped a week ago and
 * has carried nothing since; the median still saw the half of the window where it was alive and
 * reported a busy hour of 35.7%, which ranked it as the tightest subject on the network. It has
 * a hundred points of room, not sixty-four, and the page opened on a chart of a dead port.
 *
 * This app already holds the idea that fixes it: a level change splits the record into two
 * regimes, and the trend is fitted only to the part after it. Room is the same kind of claim
 * about now, so it is measured the same way. A step that leaves too little behind it to measure
 * is ignored rather than trusted — half a day of record is not a busy hour.
 */
export function headroomOf(hist: number[], disc?: number[], step?: Step | null): Headroom | null {
  const after = step && hist.length - step.at >= 24 ? hist.slice(step.at) : hist;
  const busy = busyHour(after);
  if (busy == null) return null;
  const shown = shownCeiling(after, disc && disc.length === hist.length && after !== hist
    ? disc.slice(step!.at) : disc);
  /* half the line rate: the measured point at which capacity stops explaining a discard */
  const credible = shown != null && shown >= 50;
  const ceiling = credible ? shown! : 100;
  return { busy, ceiling, source: credible ? "shown" : "stated", pts: ceiling - busy,
    dropsAt: shown != null && !credible ? shown : undefined };
}

export function subjectsOf(d: Device): Subject[] {
  const rank = (st: AheadState) => STATES.indexOf(st);
  const out: Subject[] = [];
  if (d.cpuHourly?.length) {
    out.push({
      key: `cpu:${d.name}`, kind: "device", name: d.name, sub: d.desc || d.vendor || "device",
      site: d.site ?? "", limit: "saturation on its processor", device: d, reading: read(d.cpuHourly),
      room: headroomOf(d.cpuHourly, undefined, read(d.cpuHourly).step),
    });
  }
  if (d.memHourly?.length) {
    const r = read(d.memHourly);
    out.push({
      key: `mem:${d.name}`, kind: "memory", name: d.name, sub: d.desc || d.vendor || "device",
      site: d.site ?? "", limit: "all the memory it has", device: d, reading: r,
      room: headroomOf(d.memHourly, undefined, r.step),
    });
  }
  const ports = d.interfaces
    .filter((i) => i.uplink && i.hourly && i.hourly.length && i.flag !== "inconsistent")
    .map((i) => ({ i, r: read(i.hourly as number[], i.dropsRising ?? 0) }))
    .sort((a, b) => rank(a.r.state) - rank(b.r.state) || b.r.now - a.r.now);
  const best = ports[0];
  if (best) {
    out.push({
      key: `port:${d.name}:${best.i.name}`, kind: "port",
      name: `${best.i.name}${best.i.speed ? ` · ${best.i.speed >= 1000 ? `${best.i.speed / 1000} Gb/s` : `${best.i.speed} Mb/s`}` : ""}`,
      sub: d.name, site: d.site ?? "", limit: "the line rate of the port",
      device: d, iface: best.i, reading: best.r,
      room: headroomOf(best.i.hourly as number[], best.i.discHourly, best.r.step),
    });
  }
  return out.sort((a, b) => rank(a.reading.state) - rank(b.reading.state) || b.reading.now - a.reading.now);
}

/**
 * Every measured port of one device, not the one the ranking picked.
 *
 * `subjectsOf` keeps a single uplink per device, which is right for a list that has to stand
 * for an estate — and wrong the moment a reader asks what is behind that one row. The hourly
 * read already covers every port (measured: 13,137 rows for 6,812 ports on a 181-device
 * estate), so the device's other ports cost nothing to measure; they were only never asked
 * for. Read here exactly as the ranking reads its own: same reading, same room, same ceiling.
 */
export function deviceSubjects(d: Device): Subject[] {
  const rank = (st: AheadState) => STATES.indexOf(st);
  const out: Subject[] = [];
  if (d.cpuHourly?.length) {
    const r = read(d.cpuHourly);
    out.push({
      key: `cpu:${d.name}`, kind: "device", name: d.name, sub: d.desc || d.vendor || "device",
      site: d.site ?? "", limit: "saturation on its processor", device: d, reading: r,
      room: headroomOf(d.cpuHourly, undefined, r.step),
    });
  }
  if (d.memHourly?.length) {
    const r = read(d.memHourly);
    out.push({
      key: `mem:${d.name}`, kind: "memory", name: d.name, sub: d.desc || d.vendor || "device",
      site: d.site ?? "", limit: "all the memory it has", device: d, reading: r,
      room: headroomOf(d.memHourly, undefined, r.step),
    });
  }
  for (const i of d.interfaces) {
    if (!i.hourly?.length || i.flag === "inconsistent") continue;
    const r = read(i.hourly, i.dropsRising ?? 0);
    out.push({
      key: `port:${d.name}:${i.name}`, kind: "port",
      name: `${i.name}${i.speed ? ` · ${i.speed >= 1000 ? `${i.speed / 1000} Gb/s` : `${i.speed} Mb/s`}` : ""}`,
      sub: d.name, site: d.site ?? "", limit: "the line rate of the port",
      device: d, iface: i, reading: r,
      room: headroomOf(i.hourly, i.discHourly, r.step),
    });
  }
  return out.sort((a, b) => rank(a.reading.state) - rank(b.reading.state) || b.reading.now - a.reading.now);
}

export function aheadSubjects(model: NetworkModel): Subject[] {

  const rank = (st: AheadState) => STATES.indexOf(st);
  return model.devices.flatMap(subjectsOf)
    .sort((a, b) => rank(a.reading.state) - rank(b.reading.state) || b.reading.now - a.reading.now);
}

/**
 * Subjects that changed on the same day are one event, not many.
 *
 * A level change is the commonest thing in a month of record, and listing each one makes a page
 * nobody finishes. But they are not independent: a migration, a failover, an application going
 * live moves dozens of ports at once. Measured, they cluster hard — on one environment sixteen
 * changes fell on seven days with six of them on a single day, and on another every one of the
 * four interface changes landed on the same day.
 *
 * Detection can be a sample out either way, so days within one of each other are the same event.
 * A subject that changed on a day of its own is reported as a single, because calling one port an
 * estate-wide event would be the same overstatement in reverse.
 */
export interface Change {
  /** hours since the step, like every other `ago` in this module */
  ago: number;
  /** hours between the earliest and the latest step in the cluster */
  spread: number;
  members: Subject[];
  sites: number;
  median: number;
  up: number;
  down: number;
}

export function clusterChanges(subjects: Subject[]): { events: Change[]; singles: Subject[] } {
  const withStep = subjects.filter((s) => s.reading.step).sort((a, b) => a.reading.step!.ago - b.reading.step!.ago);
  const groups: Subject[][] = [];
  for (const s of withStep) {
    const last = groups[groups.length - 1];
    const ago = s.reading.step!.ago;
    // A day's worth of hours, not one. `ago` became an hourly index when the window moved from
    // daily to hourly buckets, and this window did not move with it — so "changes a day apart
    // are one event" quietly became "an hour apart", and one estate-wide change split into a
    // dozen singles. The suite missed it because its fixture feeds `ago` in bare numbers.
    if (last && Math.abs(ago - last[0].reading.step!.ago) <= 24) last.push(s);
    else groups.push([s]);
  }
  const events: Change[] = [];
  const singles: Subject[] = [];
  for (const g of groups) {
    if (g.length < 2) { singles.push(g[0]); continue; }
    const sizes = g.map((s) => s.reading.step!.to - s.reading.step!.from).sort((a, b) => a - b);
    const agos = g.map((s) => s.reading.step!.ago);
    events.push({
      ago: Math.min(...agos),
      spread: Math.max(...agos) - Math.min(...agos),
      members: g.slice().sort((a, b) => b.reading.now - a.reading.now),
      sites: new Set(g.map((s) => s.site)).size,
      median: sizes[sizes.length >> 1],
      up: g.filter((s) => s.reading.step!.to > s.reading.step!.from).length,
      down: g.filter((s) => s.reading.step!.to <= s.reading.step!.from).length,
    });
  }
  return {
    events: events.sort((a, b) => b.members.length - a.members.length || a.ago - b.ago),
    singles: singles.sort((a, b) => b.reading.now - a.reading.now),
  };
}

/**
 * Subjects gathered by where they are, for the states whose cause is usually local. Ports
 * discarding at one site are one conversation however many there are; the same count spread over
 * forty sites is forty conversations and means something else entirely.
 */
export interface Place {
  site: string;
  members: Subject[];
  devices: number;
  worst: number;
}

export function bySite(subjects: Subject[]): Place[] {
  const m = new Map<string, Subject[]>();
  for (const s of subjects) m.set(s.site, (m.get(s.site) ?? []).concat(s));
  return [...m.entries()].map(([site, members]) => ({
    site: site || "untagged",
    members: members.sort((a, b) => b.reading.now - a.reading.now),
    devices: new Set(members.map((x) => x.device?.name ?? x.name)).size,
    worst: Math.max(...members.map((x) => x.reading.now)),
  })).sort((a, b) => b.members.length - a.members.length || b.worst - a.worst);
}

export const UNTAGGED = "Not tagged";

export interface Branch {
  value: string;
  subjects: Subject[];
  /** forecasts under it, and when the first of them arrives */
  forecasts: number;
  soonest: number | null;
  /** already at or over a limit, from the record */
  past: number;
  sites: number;
}

/**
 * The estate cut by the sequence of tags the customer configured — country, then federative unit,
 * then site, or whatever they chose in Settings.
 *
 * The resolver is passed in rather than imported so this file stays pure: it is the same code the
 * test suite runs, and it should not drag an SDK client and an environment id behind it.
 *
 * What this buys is navigation and comparison, not accuracy. Summing a parent's ports before
 * fitting them sounds like it should cancel noise, and measured on a live environment it moved the
 * median signal-to-noise from 2.38 to 2.71 — a seventh, not a step change, because ports under one
 * parent share their users, their working day and their peak hour, and correlated noise does not
 * cancel. So the hierarchy answers "where do I look first", and nothing here claims it sharpens a
 * forecast.
 */
export function narrow(
  subjects: Subject[],
  levels: readonly string[],
  path: readonly string[],
  valueOf: (siteCode: string, key: string) => string | undefined,
): Subject[] {
  if (!path.length) return subjects;
  return subjects.filter((s) => path.every((v, i) => (valueOf(s.site, levels[i]) ?? UNTAGGED) === v));
}

export function branchesAt(
  subjects: Subject[],
  levels: readonly string[],
  path: readonly string[],
  valueOf: (siteCode: string, key: string) => string | undefined,
): Branch[] {
  const key = levels[path.length];
  if (!key) return [];
  const here = narrow(subjects, levels, path, valueOf);
  const by = new Map<string, Subject[]>();
  here.forEach((s) => {
    const v = valueOf(s.site, key) ?? UNTAGGED;
    by.set(v, (by.get(v) ?? []).concat(s));
  });
  return [...by.entries()].map(([value, list]): Branch => {
    const dates = list.filter((x) => x.reading.state === "climbing" && x.reading.fit?.mid != null)
      .map((x) => x.reading.fit!.mid as number);
    return {
      value, subjects: list, forecasts: dates.length,
      soonest: dates.length ? Math.min(...dates) : null,
      past: list.filter((x) => crossedAgo(x.reading.hist) != null).length,
      sites: new Set(list.map((x) => x.site)).size,
    };
  }).sort((a, b) =>
    Number(a.value === UNTAGGED) - Number(b.value === UNTAGGED)
    || (b.past - a.past)
    || ((a.soonest ?? 1e9) - (b.soonest ?? 1e9))
    || b.forecasts - a.forecasts
    || a.value.localeCompare(b.value));
}

/** how many subjects sit in each state, and why the quiet ones are quiet */
export function aheadCensus(subjects: Subject[]) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<AheadState, number>;
  const why: Record<string, number> = {};
  for (const s of subjects) {
    counts[s.reading.state]++;
    if (s.reading.state === "quiet") {
      const k = silence(s.reading);
      why[k] = (why[k] ?? 0) + 1;
    }
  }
  return { counts, why, total: subjects.length };
}
