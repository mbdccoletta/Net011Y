// Log queries are billed by the data Grail scans, and a window of logs costs the same whatever the filter:
// on a busy environment six hours of logs is close to a hundred gigabytes, read again every time the app
// opens. The part of the window already read does not change, so the browser keeps what it read and the
// next open asks Grail only for what came after it, then puts the two together. The answer is the one the
// full query gives: series are cut in clock-aligned buckets, so a bucket read now replaces the same bucket
// read before; the latest-seen and newest-records queries merge by their keys.
//
// Only the viewer's own browser keeps it (the records can carry log content, and another user may not be
// allowed to read that bucket). Anything unexpected — no storage, a changed query, a cache older than the
// window — runs the full query, as before.
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

type Row = Record<string, unknown>;

export type Incremental =
  /** makeTimeseries by keys: each of `fields` holds one value per `stepMs` bucket (windowMs a multiple of it) */
  | { kind: "series"; windowMs: number; stepMs: number; fields: string[]; keys: string[] }
  /** summarize max(time) by keys: the last time each key was seen */
  | { kind: "latest"; windowMs: number; time: string; keys: string[] }
  /** the newest `limit` records, newest first */
  | { kind: "newest"; windowMs: number; time: string; limit: number };

/** Logs can arrive a few minutes after their timestamp: the part read again covers them. */
const LATE_MS = 10 * 60 * 1000;
const MAX_CHARS = 1_500_000;
// 2: values kept as Grail returned them (0.1.8 turned an empty bucket into 0)
const VERSION = 2;

interface Entry { v: number; q: string; at: number; rows: Row[] }
export interface Plan {
  /** what useDql runs: the full query, or the same query from where the kept part ends */
  query: string;
  /** the full query this plan stands for (the cache key) */
  full: string;
  /** kept rows, when the query is the delta */
  base: Row[] | null;
  /** start of the part read again (ms) */
  from: number | null;
}

const host = () => { try { return new URL(getEnvironmentUrl()).hostname; } catch { return "env"; } };
const keyOf = (name: string) => `net-o11y.cache@${host()}:${name}`;
const toMs = (v: unknown) => {
  const s = String(v ?? "");
  const base = Date.parse(s.slice(0, 19) + "Z");
  const frac = s.match(/^.{19}\.(\d{1,3})/);
  return Number.isNaN(base) ? NaN : base + (frac ? Number(frac[1].padEnd(3, "0")) : 0);
};
const iso = (ms: number) => new Date(ms).toISOString();
const floor = (ms: number, step: number) => Math.floor(ms / step) * step;

function read(name: string): Entry | null {
  try {
    const e = JSON.parse(window.localStorage.getItem(keyOf(name)) ?? "null") as Entry | null;
    return e && e.v === VERSION && Array.isArray(e.rows) ? e : null;
  } catch { return null; }
}
function write(name: string, e: Entry) {
  try {
    const s = JSON.stringify(e);
    if (s.length > MAX_CHARS) { window.localStorage.removeItem(keyOf(name)); return; }
    window.localStorage.setItem(keyOf(name), s);
  } catch { /* no storage: the next open reads the full window */ }
}

/** The query to run now for `name`: from where the kept part ends, or the full window. */
export function planFor(name: string, full: string, inc: Incremental, now = Date.now()): Plan {
  const whole: Plan = { query: full, full, base: null, from: null };
  const e = read(name);
  if (!e || e.q !== full || !/from:now\(\)-\w+/.test(full)) return whole;
  // a kept list of newest records needs no more than this either: if the new part is full it is the answer;
  // if not, it holds everything from `from` on, and the kept part everything newer than its own oldest record
  const from = inc.kind === "series" ? floor(e.at - LATE_MS, inc.stepMs) : e.at - LATE_MS;
  if (from <= now - inc.windowMs) return whole;
  return { query: full.replace(/from:now\(\)-\w+/, `from:"${iso(from)}"`), full, base: e.rows, from };
}

/** The rows the full query would have returned, from what was kept and what was just read. */
export function mergeRows(inc: Incremental, plan: Plan, fresh: Row[], now = Date.now()): Row[] {
  // the full query answered: its rows are the answer, as they came
  if (!plan.base || plan.from == null) return fresh;
  const start = now - inc.windowMs;
  if (inc.kind === "series") return mergeSeries(inc, plan, fresh, now);
  if (inc.kind === "latest") {
    const by = new Map<string, Row>();
    for (const r of [...(plan.base ?? []), ...fresh]) {
      const k = inc.keys.map((f) => String(r[f] ?? "")).join("\u0001");
      const cur = by.get(k);
      if (!cur || toMs(r[inc.time]) > toMs(cur[inc.time])) by.set(k, r);
    }
    return [...by.values()].filter((r) => toMs(r[inc.time]) >= start);
  }
  // the new part holds everything from `from` on; the kept part is used only before it, so nothing is
  // counted twice and nothing that repeats is merged away
  const kept = plan.base.filter((r) => toMs(r[inc.time]) < plan.from!);
  return [...fresh, ...kept]
    .filter((r) => toMs(r[inc.time]) >= start)
    .sort((a, b) => toMs(b[inc.time]) - toMs(a[inc.time]))
    .slice(0, inc.limit);
}

function mergeSeries(inc: Extract<Incremental, { kind: "series" }>, plan: Plan, fresh: Row[], now: number): Row[] {
  const step = inc.stepMs, from = plan.from!;
  // an empty bucket is null in Grail's answer, for a count too, and the model tells null from 0: values are
  // kept exactly as they came, and a bucket nobody reported stays null
  const series = new Map<string, { keys: Row; b: Map<number, unknown[]> }>();
  let last = -Infinity;
  const add = (rows: Row[], fromT: number, toT: number) => rows.forEach((r) => {
    const tf = r.timeframe as { start?: string } | undefined;
    const t0 = toMs(tf?.start);
    if (Number.isNaN(t0)) return;
    const k = inc.keys.map((f) => String(r[f] ?? "")).join("\u0001");
    const s = series.get(k) ?? { keys: Object.fromEntries(inc.keys.map((f) => [f, r[f]])), b: new Map<number, unknown[]>() };
    const len = Math.max(0, ...inc.fields.map((f) => (Array.isArray(r[f]) ? (r[f] as unknown[]).length : 0)));
    for (let i = 0; i < len; i++) {
      const t = t0 + i * step;
      if (t >= fromT && t < toT) s.b.set(t, inc.fields.map((f) => (Array.isArray(r[f]) ? (r[f] as unknown[])[i] ?? null : null)));
    }
    series.set(k, s);
  });
  // the kept part up to where the new part starts, then the new part: a key the new part does not name had nothing there
  add(plan.base!, -Infinity, from);
  add(fresh, from, Infinity);
  fresh.forEach((r) => {
    const t0 = toMs((r.timeframe as { start?: string } | undefined)?.start);
    const len = Math.max(0, ...inc.fields.map((f) => (Array.isArray(r[f]) ? (r[f] as unknown[]).length : 0)));
    if (!Number.isNaN(t0) && len) last = Math.max(last, t0 + (len - 1) * step);
  });
  // the buckets a full query run with the new part would have returned
  if (!Number.isFinite(last)) last = floor(now, step);
  const n = Math.round(inc.windowMs / step) + 1, first = last - (n - 1) * step;
  const out: Row[] = [];
  series.forEach((s) => {
    const cols = inc.fields.map((_, j) => Array.from({ length: n }, (_, i) => (s.b.get(first + i * step)?.[j] ?? null)));
    if (cols.some((c) => c.some((v) => v != null))) {
      out.push({ ...s.keys, ...Object.fromEntries(inc.fields.map((f, j) => [f, cols[j]])), timeframe: { start: iso(first), end: iso(last + step) }, interval: String(step * 1e6) });
    }
  });
  return out;
}

/** Keeps the rows for the next open. */
export function keep(name: string, plan: Plan, rows: Row[], at = Date.now()) {
  write(name, { v: VERSION, q: plan.full, at, rows });
}
