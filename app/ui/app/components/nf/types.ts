/**
 * Which subject a series is about.
 *
 * It used to be one of three literals — "conservative" | "base" | "aggressive" — because the
 * dashboard arrived plotting three invented growth rates. Here those became the fitted line and
 * the two edges of its own 95% band, which meant the forecast card, the runway card and one KPI
 * tile were all about the same port: five marks on the page, one answer behind all of them.
 * A series is a subject now, and the key is that subject's own.
 */
export type ScenarioKey = string;

export interface ScenarioConfig {
  key: ScenarioKey;
  label: string;
  /** the daily rise in points of this subject's own limit */
  monthlyGrowth: number;
  color: string;
  /** the second line: which device it sits on */
  sub?: string;
  /** points of its limit still unused */
  room?: number | null;
  /** its busy hour today, in per cent of its own limit */
  start?: number;
  /**
   * The busy hour the room is measured from, and the ceiling it is measured to.
   *
   * `start` is the most recent day's peak and `room` is the ceiling less the *median* day's
   * peak — two statistics, and the runway drew the first while printing the second. On the
   * tightest row they stood 25 points apart: a circle at 96% beside the words "29.2 points of
   * room". The bar now draws the pair the number comes from.
   */
  busy?: number | null;
  ceiling?: number | null;
  /** points of its limit its own line moves across the whole horizon, signed and unrounded */
  move?: number;
  /** the rise beats its own scatter: a direction the record stands behind */
  firm?: boolean;
  /** the ceiling is one this subject demonstrated, not the one its owner stated */
  shown?: boolean;
  /** the device this row sits on: what its chevron opens */
  device?: string;
  /** what this reading is of: a port's load, a processor's saturation, memory in use */
  kind?: "port" | "device" | "memory";
  /** the port's line rate in Mb/s, so a ceiling can be written in bits as well as per cent */
  speed?: number | null;
  /** where it drops packets, when that is too low to be its capacity */
  dropsAt?: number | null;
  /** where its own line puts it at the end of the horizon */
  peak?: number;
  /** the day it would cross, if it crosses inside the horizon */
  breachLabel?: string | null;
}

export interface TrafficPoint {
  label: string;
  observed: number | null;
  forecast: number | null;
  upper: number | null;
  lower: number | null;
  capacity: number;
}

export interface ScenarioSeries {
  scenario: ScenarioConfig;
  points: TrafficPoint[];
  peak: number;
  breachLabel: string | null;
  /** where this subject's busy hour sits today — each row of the runway starts at its own */
  start: number;
}

export interface Region {
  id: string;
  name: string;
  currentGbps: number;
  capacityGbps: number;
  monthlyGrowth: number;
}

export interface HeatCell {
  regionId: string;
  regionName: string;
  label: string;
  utilization: number;
}

