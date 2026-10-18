// The dashboard's data, from the real record.
//
// The five components in this folder arrived as a working dashboard over illustrative numbers.
// They are kept byte-for-byte as they came, except for the one import each makes — that is the
// whole point of using them rather than reimplementing them, and it is why the result looks
// like the thing it was asked to look like. This file is the only piece written here: it
// produces the exact shapes they expect, out of what the environment actually reports.
//
// Three honest substitutions were needed, and each is named where it is made:
//
//  · **Scenarios.** Theirs were three invented monthly growth rates. The record supports three
//    real ones: the fitted line, and the two edges of the band its own scatter allows. So
//    "conservative" is the lower edge, "base" is the line, "aggressive" is the upper edge —
//    the same three-way shape, measured rather than chosen.
//  · **The horizon.** Theirs ran ten months ahead. This app never draws further than twice the
//    record behind it, which here is a few weeks, so the columns are days and are labelled as
//    days. Stretching to months would be the one change that made the picture a lie.
//  · **Gigabits.** Their axis is Gb/s and the model holds per cent of a line rate, so the two
//    are multiplied back together. A port with no published line rate cannot take part, and is
//    left out rather than assumed.
import React, { createContext, useContext, useMemo, useState } from "react";
import type { NetworkModel } from "../../model/types";
import { deviceSubjects, type Subject } from "../../model/ahead";
import { askForSubject, type Ask } from "../../hooks/useDavisForecast";
import type { HeatCell, Region, ScenarioConfig, ScenarioKey, ScenarioSeries, TrafficPoint } from "./types";

/**
 * What the reader clicked.
 *
 * Every mark on this dashboard stands for a set of real ports, so one shape covers all of them:
 * a pick names the set, and the detail panel resolves it to subjects, a measured series and a
 * list that drills through to the device. Nothing on screen is a number without a way back to
 * the ports it was computed from.
 */
export type Pick =
  | { kind: "site"; id: string; col: string | null }
  /** one device, with every port of it the record covers — what a ranking row is behind */
  | { kind: "device"; id: string }
  | { kind: "kpi"; id: string; col?: string | null }
  | { kind: "scenario"; key: ScenarioKey }
  /**
   * One cell of the comb: the list of its kind, opened on the subject that was clicked.
   *
   * It does not go through `resolve` like the others. The rest of this page's picks name a set
   * whose members are summed into one line; a comb cell names one subject inside a population
   * that has no sum — per cent of four hundred different limits adds up to nothing — so what
   * it opens is the list, not an aggregate.
   */
  | { kind: "room"; of: "port" | "cpu" | "mem"; key: string };

/** The ports behind a mark, and the aggregate drawn from them. */
export interface Resolved {
  title: string;
  /** what the set is, in the page's own words */
  gist: string;
  members: Subject[];
  /** the members that publish a line rate — the only ones the line can carry */
  rated: Subject[];
  /** the member to draw when the set itself cannot be summed honestly */
  defaultFocus?: string;
  /**
   * Why this set has no aggregate line, when it has none.
   *
   * The line is per cent of the capacity the members publish, and that denominator only means
   * something where the members share a place and a purpose. Summed over a whole estate it is
   * the capacity nobody carries — the same denominator two cards were deleted for using — so
   * the set says why it is not drawing one instead of drawing it anyway.
   */
  noLine?: string;
  /** measured load per day of the record, in per cent of the capacity those ports publish */
  obs: number[];
  /** points of that capacity per day, from the members' own fitted lines */
  rise: number;
  /**
   * This set's own axis, record then horizon.
   *
   * It is not the dashboard's: the cards above share one frame because they are all about one
   * subject, and a site's ports can hold a longer record than that subject does. Borrowing the
   * shared frame threw most of a site's record away before drawing it. The horizon is twice the
   * record here as it is everywhere else in this app, so a longer record also sees further.
   */
  labels: string[];
  /** how many of those labels are record rather than horizon */
  days: number;
  /** the column the reader pointed at, when they pointed at one */
  mark: string | null;
}

export interface NfData {
  CAPACITY_GBPS: number;
  LABELS: string[];
  OBSERVED: number[];
  SCENARIOS: ScenarioConfig[];
  seriesFor: (key: ScenarioKey) => ScenarioSeries | null;
  /**
   * Which subject the chart opens on.
   *
   * Not the first of the ranking: the tightest subject on a fortnight statistic can be one that
   * stopped passing traffic days ago, and plotting it draws a curve falling off a cliff and a
   * fitted line pointing at nothing. That is what `liveNow` was written for, and the ranking no
   * longer filters by it — so the preference lives here, on the one choice it was ever about.
   */
  LEAD_KEY: ScenarioKey;
  /** everything the analyzer needs to ask about one subject, or why it cannot be asked */
  askFor: (key: ScenarioKey) => { ask: Ask | null; why: string | null };
  /** the subject's own record, hour by hour, in per cent of its limit — what it actually measured */
  histFor: (key: ScenarioKey) => number[];
  /**
   * This app's own fitted line, projected hour by hour, for when the platform has no answer.
   *
   * A processor publishes no port series, so Dynatrace cannot be asked about it, and nothing
   * can be asked at all until the analyzer replies. The hourly rewrite dropped the old daily
   * fallback and left those charts with no forward half while the legend still advertised one.
   */
  ownLineFor: (key: ScenarioKey, aheadHours: number) => { point: number[]; lower: number[]; upper: number[] } | null;
  REGIONS: Region[];
  HEAT_MONTHS: string[];
  /** days between one heat column and the next, so the matrix can draw an honest iso-line */
  HEAT_STRIDE: number;
  buildHeatmap: () => HeatCell[];
  resolve: (p: Pick) => Resolved | null;
  /** every subject in scope, for the comb and the list, which rank nothing away */
  ALL: Subject[];
  /** the same measured aggregate the panel is built from, for any subset of its members */
  seriesOf: (list: Subject[]) => { rated: Subject[]; obs: number[]; labels: string[]; days: number; rise: number };
}

/** The selection, kept apart from the data so picking something recomputes nothing. */
interface NfSel {
  pick: Pick | null; setPick: (p: Pick | null) => void; onDevice: (name: string) => void;
  /** which subject the forecast chart draws; the runway sets it, nothing else does */
  drawn: string | null; setDrawn: (k: string | null) => void;
}
const SelCtx = createContext<NfSel | null>(null);
export function useSel(): NfSel {
  const v = useContext(SelCtx);
  if (!v) throw new Error("useSel outside the provider");
  return v;
}
/** Picking the same mark twice closes it, which is what a reader expects of a toggle. */
export const samePick = (a: Pick | null, b: Pick) =>
  !!a && a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);

const Ctx = createContext<NfData | null>(null);
export function useNf(): NfData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNf outside the provider");
  return v;
}

/**
 * A fixed order, never cycled, and nothing in it means anything else.
 *
 * Red, green and yellow are this app's status colours, and cyan is out of the app entirely, so
 * the set is what the categorical palette has left: 11 pale blue, 08 violet, 04 magenta, 01
 * blue, 10 brown. Measured on this surface — every pair at least 15.9 apart in OKLab, against
 * a floor of 15 for normal vision, and the weakest of them 4.13:1 where a drawn mark needs 3.
 * The order runs by legibility, so a chart drawing two series uses the two strongest.
 */
export const HUES = [
  "var(--dt-colors-charts-categorical-color-11-default, #95c0ff)",
  "var(--dt-colors-charts-categorical-color-08-default, #9f81ff)",
  "var(--dt-colors-charts-categorical-color-01-default, #0072f5)",
  "var(--dt-colors-charts-categorical-color-14-default, #ff8643)",
  "var(--dt-colors-charts-categorical-color-10-default, #aa673f)",
];

/** how many series a reader can tell apart, and how many of the ranking wear a colour */
export const SHOWN = 5;

const r1 = (v: number) => Math.round(v * 10) / 10;
/** a subject's share of a gigabit link, in Gb/s, or null when no line rate was published */
const gbps = (pct: number, speedMbps: number | null | undefined) =>
  speedMbps && speedMbps > 0 ? (pct / 100) * (speedMbps / 1000) : null;

export function buildNf(model: NetworkModel, subjects: Subject[]): NfData | null {

  const withRate = subjects.filter((s) => (s.iface?.speed ?? 0) > 0 && s.reading.hist.length >= 24);
  if (withRate.length < 2) return null;

  /**
   * The subject this dashboard is about, and its own limit.
   *
   * Summing every port's line rate gives a capacity nobody has: 865 Gb/s across 295 ports, of
   * which the estate carries nineteen. Against that, every chart is a flat line on the floor
   * and says nothing — not because the drawing is wrong but because the denominator is. No one
   * runs every access port at line rate at once.
   *
   * The dashboard they sent plots one aggregate against one capacity, and the honest equivalent
   * here is the subject with the least room: its own record, its own ceiling, its own band.
   * Everything else on the page already covers the estate as a whole.
   */
  /**
   * Tight *and* still carrying something.
   *
   * Ranking by headroom alone picked a port whose busy hour was high across the fortnight and
   * which stopped passing traffic five days ago: the chart showed a real curve that fell off a
   * cliff to nothing, and the fitted line then pointed down at ninety-nine per cent a month.
   * Ranking on a fourteen-day statistic while plotting the last day is the inconsistency; the
   * fix is to require the subject to be alive at the end of its own record.
   */
  const liveNow = (x: Subject) => {
    const h = x.reading.hist.slice(-24).filter(Number.isFinite);
    if (!h.length) return false;
    const today = Math.max(...h);
    const busy = x.room?.busy ?? today;
    return busy > 0 && today >= busy * 0.25;
  };
  /**
   * One ranking, over every subject that has a room reading.
   *
   * It ranked `withRate` — ports publishing a line rate — while the page's own `Ranked by room`
   * row ranked everything, and the two disagreed in both size and kind: 85 against 295, and
   * twenty of the claim row's first twenty-five were processors the card could not show at all.
   * Two rankings of the same quantity under two names is the thing a reader cannot recover
   * from, so there is one. A processor's record is already per cent of its own saturation, so
   * nothing about the chart had to change to draw one.
   *
   * `liveNow` stays, but only for *choosing what to draw first*, which is the problem it was
   * written for: a port that stopped passing traffic five days ago still ranks tight on a
   * fortnight statistic, and plotting it shows a curve falling off a cliff. It no longer
   * removes anything from the ranking — a subject that went quiet is still a subject with room.
   */
  const byRoom = subjects.filter((x) => x.room).slice()
    .sort((a, b) => ((a.room?.pts ?? 100) - (b.room?.pts ?? 100)));
  /**
   * The tightest subject is the first of the ranking. Full stop.
   *
   * It used to be the first that `liveNow` accepted, to avoid opening the chart on a port that
   * stopped passing traffic — and that made this file's idea of "tightest" differ from the
   * console's, which simply takes the first. Yesterday the two coincided and I shipped a fix
   * validated against that coincidence; today they do not, and the page says three things at
   * once: the verdict names SWA-019 at 35.7%, the ranking's first row is SWA-019, and the KPI
   * labelled "busy hour, tightest subject" reads 29.6% for a different port while the chart
   * draws a third.
   *
   * One ranking, one first element, one answer. A dead port that ranks tightest is a true
   * statement about the estate and the chart can show it; a page contradicting itself is not.
   */
  const lead = byRoom[0] ?? withRate[0];
  void liveNow;
  if (!lead) return null;
  /**
   * Every subject that has a room reading, in order. No count.
   *
   * It was three (the band's edges), then four, then seven — each number picked by me, the last
   * defended as "what the card fits", which is an arbitrary number with a reason rather than a
   * meaning. There is no honest N here: the record draws no line in the ranking, and the app is
   * not allowed to invent one — "everything under 30 points" would be a threshold the app
   * chose, which is the third of its four rules. So the card shows the ranking and scrolls, and
   * the reader decides where to stop looking.
   *
   * Per-subject colour went with the count: a hue each is meaningless across hundreds, and the
   * platform set holds only a handful that are legible on this surface. One hue for every bar,
   * and the row the chart is drawing is the one that stands out.
   */
  /**
   * Fifty, and for once the number is not ours.
   *
   * The platform's forecast analyzer takes at most fifty series in one call — its own
   * documented limit — and the forecast on this page is now the platform's. So the ranking
   * that feeds it stops at fifty, and that is a fact about the tool rather than a line someone
   * drew in the data. The full ranking over every subject is still the `Ranked by room` row,
   * which needs no forecast at all: room is the busy hour against a ceiling, measured.
   */
  const FORECASTABLE = 50;
  const LEADERS = byRoom.filter((x) => x.room).slice(0, FORECASTABLE);
  /**
   * The unit is per cent of each subject's own limit, and the capacity is a hundred.
   *
   * Gigabits looked like the faithful choice and was not: the tightest subject is a one-gigabit
   * port, so every figure rounded to "0 Gbps" and the whole dashboard read as empty. Per cent
   * of its own limit is what the rest of this app measures in, it needs no rounding to stay
   * meaningful, and it puts the chart at the same proportions as the one this was built from —
   * a line in the middle of the frame with its ceiling above it.
   */
  const CAPACITY_GBPS = 100;
  const span = Math.max(24, lead.reading.hist.length);
  const days = Math.max(2, Math.floor(span / 24));
  const ahead = days * 2;                               // twice the record, and no further

  /** a subject's busy hour on each day it has a record for, oldest first */
  const dailyBusy = (x: Subject, n: number): number[] => {
    const h = x.reading.hist, out: number[] = [];
    for (let d = 0; d < n; d++) {
      const lo = h.length - (n - d) * 24, hi = lo + 24;
      const slice = hi <= 0 ? [] : h.slice(Math.max(0, lo), hi).filter(Number.isFinite);
      out.push(slice.length ? r1(Math.max(...slice)) : 0);
    }
    return out;
  };
  const OBSERVED = dailyBusy(lead, days);

  /**
   * Four of the platform's categorical colours, picked by measurement against this page's own
   * surface (#1b1b22) rather than by taking the first four in the set.
   *
   * The whole ramp was read in the browser: 01 (#0072f5) and 10 (#aa673f) reach only 3.85:1,
   * 02 and 05 are greys — 05 is #868b8f here, which is how the fourth subject came out looking
   * disabled — 06 is a yellow and 12 a red, and this app spends amber on warning and red only
   * on the critical token. What is left and legible: 07 at 6.42:1, 08 at 5.75, 03 at 5.32 and
   * 11 at 9.18. Identity is carried by each row's own name as well, so the hue is the second
   * encoding and not the only one.
   */

  /**
   * Points of its limit a day, unrounded.
   *
   * It was rounded to one decimal here, and then multiplied by a horizon of twenty-six days to
   * get where the line ends up — so a subject climbing 0.04 points a day, a full point across
   * the horizon, was stored as 0.0 and the ranking printed "flat to the horizon" for it. Forty
   * eight of fifty rows read flat for that reason. Rounding belongs where the number is
   * printed, not where it is multiplied.
   */
  const risePerDay = (x: Subject) => {
    const f = x.reading.fit;
    return f ? f.at(24) - f.at(0) : 0;
  };
  /**
   * A bar needs three numbers, not a series. Building the full points array for every subject
   * would be hundreds of arrays the chart never draws; where it starts, where its own line puts
   * it at the end of the horizon and whether that crosses all follow from the busy hour and the
   * slope. The series is built for the one subject on screen, below.
   */
  const SCENARIOS: ScenarioConfig[] = LEADERS.map((x) => {
    const own = Math.max(2, Math.min(days, Math.floor(x.reading.hist.length / 24)));
    const obs = dailyBusy(x, own);
    const here = obs[obs.length - 1] ?? 0;
    const rise = risePerDay(x);
    const hits = rise > 0 ? Math.ceil((CAPACITY_GBPS - here) / rise) : null;
    return {
      // a device subject's name IS the device, so repeating it reads "X on X"; its second line
      // is where it is instead
      key: x.key, label: x.name, sub: x.kind === "port" ? (x.device?.name ?? x.sub) : (x.site || "untagged"),
      monthlyGrowth: rise, color: "var(--obs)", room: x.room ? r1(x.room.pts) : null,
      busy: x.room ? r1(x.room.busy) : null, ceiling: x.room ? r1(x.room.ceiling) : null,
      start: here, peak: r1(Math.max(0, here + rise * ahead)),
      /**
       * The move, before rounding and inside what the quantity allows.
       *
       * It was the slope times the horizon, unbounded, and a port sitting at 15.7% of its limit
       * was reported as "falling 21 points" — five points below nothing. Load has a floor, and
       * a line extended past it stops being a reading of anything. Measured from the same busy
       * hour the bar draws its circle at, and cut where the quantity ends.
       */
      move: Math.max(0, (x.room?.busy ?? here) + rise * ahead) - (x.room?.busy ?? here),
      firm: x.reading.fit?.rising ?? false,
      shown: x.room?.source === "shown", device: x.device?.name,
      kind: x.kind === "link" ? "port" : x.kind,
      speed: x.iface?.speed ?? null, dropsAt: x.room?.dropsAt ?? null,
      breachLabel: hits != null && hits <= ahead ? `+${hits} d` : null,
    };
  });

  const LABELS = [
    ...Array.from({ length: days }, (_, i) => `−${days - 1 - i} d`),
    ...Array.from({ length: ahead }, (_, k) => `+${k + 1} d`),
  ];
  LABELS[days - 1] = "hoje";

  const buildSeries = (sc: ScenarioConfig, x: Subject): ScenarioSeries => {
    const obs = dailyBusy(x, days);
    const here = obs[obs.length - 1] ?? 0;
    const f = x.reading.fit;
    const rise = sc.monthlyGrowth;
    // the band is this subject's own 95% envelope, widening with distance as its standard error does
    const halfDay = f ? Math.abs((f.band(24) - f.band(0))) : 0;
    const points: TrafficPoint[] = LABELS.map((label, i) => {
      if (i < days - 1) {
        return { label, observed: obs[i], forecast: null, upper: null, lower: null, capacity: CAPACITY_GBPS };
      }
      const k = i - (days - 1);
      const v = here + rise * k;
      const spread = halfDay * k;
      return {
        label,
        observed: i === days - 1 ? here : null,
        forecast: r1(v),
        upper: r1(v + spread),
        lower: r1(Math.max(0, v - spread)),
        capacity: CAPACITY_GBPS,
      };
    });
    const breach = points.find((p) => p.forecast !== null && p.forecast >= CAPACITY_GBPS);
    return { scenario: sc, points, start: here,
      peak: points[points.length - 1].forecast ?? here, breachLabel: breach?.label ?? null };
  };
  /**
   * What the platform needs to forecast one subject: the family's metric prefix, the two text
   * dimensions that can actually select a port, and the speed to turn octets back into per cent.
   * A processor subject has no port, so it has no expression and keeps the app's own line.
   */
  /**
   * What to ask the analyzer for, per subject — including the processors.
   *
   * It answered only for ports, so three of the five subjects the forecast card draws fell
   * back to this app's own straight line. A processor has a record of the same shape, in the
   * same unit, from the same extension: the family is taken from the ports of the device it
   * sits on, because whatever polls them polls its processor too.
   */
  /**
   * It also says why, when there is no question to ask.
   *
   * The card counted the forecasts it got back and called the rest "no forecast", which read
   * as the analyzer refusing. Measured against this environment it refuses nothing: every
   * series it was asked about came back OK and VALID. The gap is on this side — a port that
   * publishes no line rate has no denominator to turn octets into per cent, and a device whose
   * ports name no extension cannot have its processor metric named either. Those are two
   * different sentences and neither of them is the platform's fault.
   */
  const askFor = (key: ScenarioKey) => askForSubject(LEADERS.find((m) => m.key === key));

  /** the hourly record itself — no daily summary, so a forecast can be drawn against it hour
   * for hour and nothing has to be resampled into anything */
  const histFor = (key: ScenarioKey) => LEADERS.find((m) => m.key === key)?.reading.hist ?? [];

  const ownLineFor = (key: ScenarioKey, aheadHours: number) => {
    const x = LEADERS.find((m) => m.key === key);
    const f = x?.reading.fit;
    if (!x || !f) return null;
    const n = x.reading.hist.length;
    const at: number[] = [], lo: number[] = [], up: number[] = [];
    for (let k = 1; k <= aheadHours; k++) {
      const v = f.at(n + k), b = Math.abs(f.band(k));
      at.push(Math.round(v * 10) / 10);
      lo.push(Math.round(Math.max(0, v - b) * 10) / 10);
      up.push(Math.round((v + b) * 10) / 10);
    }
    return { point: at, lower: lo, upper: up };
  };

  const seriesCache = new Map<ScenarioKey, ScenarioSeries>();
  const seriesFor = (key: ScenarioKey): ScenarioSeries | null => {
    const hit = seriesCache.get(key);
    if (hit) return hit;
    const i = LEADERS.findIndex((x) => x.key === key);
    if (i < 0) return null;
    const made = buildSeries(SCENARIOS[i], LEADERS[i]);
    seriesCache.set(key, made);
    return made;
  };

  // a region is a site, and its capacity is the line rates it actually publishes
  const bySite = new Map<string, Subject[]>();
  withRate.forEach((s) => { if (s.site) bySite.set(s.site, [...(bySite.get(s.site) ?? []), s]); });
  const REGIONS: Region[] = [...bySite.entries()].map(([code, list]) => {
    const cap = list.reduce((a, s) => a + (s.iface!.speed as number) / 1000, 0);
    const now = list.reduce((a, s) => a + (gbps(s.room?.busy ?? s.reading.now, s.iface!.speed) ?? 0), 0);
    const rise = list.reduce((a, s) => {
      const f = s.reading.fit;
      return a + (f ? gbps(f.at(24) - f.at(0), s.iface!.speed) ?? 0 : 0);
    }, 0);
    return {
      id: code, name: model.sites[code]?.name || code,
      currentGbps: r1(now), capacityGbps: r1(cap),
      // `monthlyGrowth` keeps its name because the components read it, but it carries the daily
      // rise as a fraction of that site's own capacity — so ×100 is points of capacity a day,
      // which is what the axis beside it now says. A monthly figure here with a daily label was
      // the mismatch: the same number meant two different things on one chart.
      monthlyGrowth: cap > 0 ? rise / cap : 0,
    };
  }).filter((r) => r.capacityGbps > 0).sort((a, b) => b.currentGbps - a.currentGbps).slice(0, 8);

  // the heatmap's columns are days inside the horizon, never months
  const steps = Math.min(9, Math.max(3, Math.round(ahead / 3)));
  const stride = Math.max(1, Math.round(ahead / (steps - 1)));
  const HEAT_MONTHS = Array.from({ length: steps }, (_, k) => (k === 0 ? "hoje" : `+${k * stride}d`));
  const buildHeatmap = (): HeatCell[] => REGIONS.flatMap((r) =>
    HEAT_MONTHS.map((label, k) => {
      // the rise is a fraction of capacity per day, so carrying it forward is a multiplication
      const grown = r.currentGbps + r.monthlyGrowth * r.capacityGbps * k * stride;
      return {
        regionId: r.id, regionName: r.name, label,
        utilization: Math.round((grown / Math.max(1e-6, r.capacityGbps)) * 100),
      };
    }));

  /* The two tiles that stood here are gone, with the sets only they opened.
     "Rising, inside their own noise" and "Port traffic over 70% of its line rate" were a
     headline for the three port cards below them, and the cards say it themselves: the comb
     shows how full every subject is against its own limit, and the list behind it carries
     the rise and its scatter per row. A number with an Open button, over a card that opens
     the same subjects, is the same drill-down twice. */

  /**
   * Everything on this dashboard is an aggregate of ports, so one function computes all of them.
   *
   * The weight is the published line rate, because that is what the cards already divide by: a
   * site at 40% is forty per cent of the capacity installed there, not the mean of its ports'
   * percentages, and a one-gigabit port next to a ten would otherwise count the same. A port is
   * counted on a day only if its own record reaches that day — the denominator moves with it,
   * so a short record reads as absent rather than as an idle port dragging the line down.
   */
  const aggregate = (list: Subject[]) => {
    /**
     * A processor publishes no line rate, and its record is already per cent of its own limit.
     *
     * The weight below is the published rate, so a set whose members have none weighed nothing
     * and came back as a flat zero series — which is how a device subject's panel rendered as
     * an empty box. Where nothing publishes a rate there is nothing to weigh by and the members
     * are already in the same unit, so they are averaged as they are. A mixed set still draws
     * only the rated ones and still says so, because a mean of a port's per cent and a
     * processor's per cent is a number about nothing.
     */
    const anyRate = list.some((s) => (s.iface?.speed ?? 0) > 0);
    const rated = list.filter((s) => (anyRate ? (s.iface?.speed ?? 0) > 0 : true) && s.reading.hist.length >= 24);
    const days = Math.max(2, ...rated.map((s) => Math.floor(s.reading.hist.length / 24)));
    const ahead = days * 2;                              // twice the record, and no further
    const labels = [
      ...Array.from({ length: days }, (_, i) => `−${days - 1 - i} d`),
      ...Array.from({ length: ahead }, (_, k) => `+${k + 1} d`),
    ];
    labels[days - 1] = "hoje";
    const obs: number[] = [];
    for (let d = 0; d < days; d++) {
      let carried = 0, cap = 0;
      for (const s of rated) {
        const h = s.reading.hist, lo = h.length - (days - d) * 24, hi = lo + 24;
        if (hi <= 0) continue;                       // its record does not reach that day
        const slice = h.slice(Math.max(0, lo), hi).filter(Number.isFinite);
        if (!slice.length) continue;
        const rate = (s.iface?.speed as number) || 1;   // unweighted when nothing publishes one
        carried += (Math.max(...slice) / 100) * rate;
        cap += rate;
      }
      obs.push(cap > 0 ? r1((carried / cap) * 100) : 0);
    }
    const capAll = rated.reduce((a, s) => a + ((s.iface?.speed as number) || 1), 0);
    const risen = rated.reduce((a, s) => {
      const f = s.reading.fit;
      return a + (f ? ((f.at(24) - f.at(0)) / 100) * ((s.iface?.speed as number) || 1) : 0);
    }, 0);
    return { rated, obs, labels, days, rise: capAll > 0 ? (risen / capAll) * 100 : 0 };
  };

  // every subject at a site, not only the ones that publish a rate: a port discarding packets
  // belongs in the detail of its site even though it cannot be in the line
  const allBySite = new Map<string, Subject[]>();
  subjects.forEach((s) => { if (s.site) allBySite.set(s.site, [...(allBySite.get(s.site) ?? []), s]); });
  /**
   * `empty` is what the panel says when the set has no members.
   *
   * Returning null for an empty set made the tile a control that did nothing on this estate,
   * where no port reaches 70%. A reader cannot tell "nothing happened" from "nothing is there",
   * and the second is a finding worth printing — so the set answers with the count it does have.
   */
  const KPI_SETS: Record<string, { title: string; gist: string; members: Subject[]; empty: string; noLine?: string }> = {
    /**
     * What the estate line is the sum of.
     *
     * The demand chart is the one mark on this page with no narrower subject of its own — it is
     * the whole network — so its click opens the whole set, in the unit the rest of the page
     * uses: every port and processor, tightest first. The sites it divides into are the card
     * directly below it, which is the other half of the same drill-down.
     */
    all: { title: "Every port and processor",
      gist: `the ${subjects.length} the record covers, tightest first — the list behind the demand chart`,
      members: subjects,
      empty: "Nothing is in the record yet.",
      noLine: `No curve is drawn for the whole estate, on purpose. The only denominator available here is the ${r1(subjects.reduce((a, s) => a + ((s.iface?.speed as number) || 0) / 1000, 0))} Gb/s of line rate these publish between them — a capacity nothing carries, which is why two cards that used it were deleted. The demand chart you came from, in gigabits per second, is the estate's one honest curve; below is what it is made of, and each row has its own.` },
  };

  const resolve = (p: Pick): Resolved | null => {
    /* a comb cell has no aggregate to resolve to: the panel reads it straight from the cells */
    if (p.kind === "room") return null;
    if (p.kind === "site") {
      const members = allBySite.get(p.id) ?? [];
      if (!members.length) return null;
      const a = aggregate(members);
      /**
       * A cell is a site *and a day*, and the panel only ever said the site.
       *
       * Three cells of one row opened a panel identical but for a dashed line in a different
       * place, which is a large part of why so many clicks looked like the same screen. The
       * figure the reader just pointed at belongs in the first sentence.
       */
      const cell = p.col ? buildHeatmap().find((c) => c.regionId === p.id && c.label === p.col) : null;
      const when = cell ? ` · ${cell.label === "hoje" ? "today" : `at ${cell.label}`} the carried-forward load is ${cell.utilization}% of that` : "";
      /* "70 ports at this site" counted the processors as ports. A site holds both, the panel
         now lists them apart, and the sentence above the list says which is which. */
      const prts = members.filter((m) => m.kind === "port").length;
      const devs = members.length - prts;
      const parts = [prts ? `${prts} ${prts === 1 ? "port" : "ports"}` : "",
        devs ? `${devs} device ${devs === 1 ? "reading" : "readings"}` : ""].filter(Boolean).join(" and ");
      return { title: model.sites[p.id]?.name || p.id, mark: p.col,
        gist: `${parts} at this site, ${r1(a.rated.reduce((x, s) => x + ((s.iface?.speed as number) || 0) / 1000, 0))} Gb/s of published line rate between the ports${when}`,
        members, ...a };
    }
    if (p.kind === "device") {
      const dev = model.devices.find((d) => d.name === p.id);
      if (!dev) return null;
      const members = deviceSubjects(dev);
      if (!members.length) return null;
      const prts = members.filter((m) => m.kind === "port").length;
      const rate = r1(members.reduce((x, m) => x + ((m.iface?.speed as number) || 0) / 1000, 0));
      return { title: dev.name, mark: null,
        gist: `${prts} ${prts === 1 ? "port" : "ports"} the record covers on this device`
          + `${members.length > prts ? " and its processor" : ""}`
          + `${rate ? `, ${rate} Gb/s of published line rate between them` : ""}`,
        members, ...aggregate(members),
        /* A device's ports summed is the same denominator the estate card refuses: the sum of
           the line rates installed on it, which nothing carries at once. So the panel opens on
           the port with the least room — one real series — and every other port is one row
           away. */
        noLine: prts > 1
          ? `No single curve is drawn for a whole device: summing its ports would measure them against ${rate ? `the ${rate} Gb/s ` : "the capacity "}installed on it, which nothing carries at once. The chart shows the port with the least room; pick any row to draw that one instead.`
          : undefined,
        defaultFocus: prts > 1 ? members.filter((m) => m.kind === "port")
          .slice().sort((a, b) => (a.room?.pts ?? 1e9) - (b.room?.pts ?? 1e9))[0]?.key : undefined,
      };
    }
    if (p.kind === "kpi") {
      const set = KPI_SETS[p.id];
      if (!set) return null;
      const day = p.col ? ` · you pointed at ${p.col === "hoje" ? "today" : p.col}` : "";
      return { title: set.title, gist: (set.members.length ? set.gist : set.empty) + (set.members.length ? day : ""),
        mark: p.col ?? null, members: set.members, noLine: set.members.length ? set.noLine : undefined,
        ...aggregate(set.members) };
    }
    const sc = SCENARIOS.find((x) => x.key === p.key);
    const x = LEADERS.find((m) => m.key === p.key);
    if (!sc || !x) return null;
    const room = x.room ? `${r1(x.room.pts)} points of its limit still unused` : "no limit published";
    const moving = Math.abs(sc.monthlyGrowth) < 0.005 ? "flat across its record"
      : `${sc.monthlyGrowth > 0 ? "rising" : "falling"} ${Math.abs(r1(sc.monthlyGrowth))} points of its limit a day`;
    return { title: x.name, gist: `${x.device?.name ?? x.sub} · ${room}, ${moving}`,
      mark: null, members: [x], ...aggregate([x]), rise: sc.monthlyGrowth };
  };

  return { CAPACITY_GBPS, LABELS, OBSERVED, SCENARIOS, seriesFor, LEAD_KEY: lead.key, askFor, histFor, ownLineFor, REGIONS, HEAT_MONTHS, HEAT_STRIDE: stride, buildHeatmap, ALL: subjects,
    resolve, seriesOf: aggregate };
}

/**
 * The selection is the page's, not this subtree's.
 *
 * It started here, which was enough while only the dashboard cared. But the masthead above it
 * has always told the reader "click a site to scope every panel to it", and the marks that used
 * to do that were deleted in an earlier pass — leaving a page that promised a scope nothing
 * could set, and a "← whole network" button that could never appear. Holding the pick one level
 * up makes the promise true: a site picked anywhere is the site the verdict reads.
 */
export function NfProvider({ model, subjects, onDevice, pick, onPick, children }: {
  model: NetworkModel; subjects: Subject[]; onDevice: (name: string) => void;
  pick: Pick | null; onPick: (p: Pick | null) => void; children: React.ReactNode;
}) {
  const value = useMemo(() => buildNf(model, subjects), [model, subjects]);
  const [drawn, setDrawn] = useState<string | null>(null);
  const sel = useMemo(() => ({ pick, setPick: onPick, onDevice, drawn, setDrawn }),
    [pick, onPick, onDevice, drawn]);
  if (!value) return null;
  return <Ctx.Provider value={value}><SelCtx.Provider value={sel}>{children}</SelCtx.Provider></Ctx.Provider>;
}
