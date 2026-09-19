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
  /** makeTimeseries by keys: `field` holds the counts, one per `stepMs` bucket */
  | { kind: "series"; windowMs: number; stepMs: number; field: string; keys: string[] }
  /** summarize max(time) by keys: the last time each key was seen */
  | { kind: "latest"; windowMs: number; time: string; keys: string[] }
  /** the newest `limit` records, newest first */
  | { kind: "newest"; windowMs: number; time: string; limit: number };

/** Logs can arrive a few minutes after their timestamp: the part read again covers them. */
const LATE_MS = 10 * 60 * 1000;
const MAX_CHARS = 1_500_000;
const VERSION = 1;

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
  const kept = (plan.base ?? []).filter((r) => plan.from != null && toMs(r[inc.time]) < plan.from);
  return [...fresh, ...kept]
    .filter((r) => toMs(r[inc.time]) >= start)
    .sort((a, b) => toMs(b[inc.time]) - toMs(a[inc.time]))
    .slice(0, inc.limit);
}

function mergeSeries(inc: Extract<Incremental, { kind: "series" }>, plan: Plan, fresh: Row[], now: number): Row[] {
  const step = inc.stepMs;
  const series = new Map<string, { keys: Row; b: Map<number, number> }>();
  const add = (rows: Row[], from: number) => rows.forEach((r) => {
    const tf = r.timeframe as { start?: string } | undefined;
    const t0 = toMs(tf?.start), vs = Array.isArray(r[inc.field]) ? (r[inc.field] as unknown[]) : [];
    if (Number.isNaN(t0)) return;
    const k = inc.keys.map((f) => String(r[f] ?? "")).join("\u0001");
    const s = series.get(k) ?? { keys: Object.fromEntries(inc.keys.map((f) => [f, r[f]])), b: new Map<number, number>() };
    vs.forEach((v, i) => { const t = t0 + i * step; if (t >= from) s.b.set(t, Number(v ?? 0) || 0); });
    series.set(k, s);
  });
  if (plan.base && plan.from != null) {
    add(plan.base, -Infinity);
    // what was read again replaces what was kept, bucket by bucket: a key the new part does not name had nothing there
    series.forEach((s) => [...s.b.keys()].forEach((t) => { if (t >= plan.from!) s.b.delete(t); }));
  }
  add(fresh, plan.from ?? -Infinity);
  const first = floor(now - inc.windowMs, step), last = floor(now, step);
  const n = Math.round((last - first) / step) + 1;
  const out: Row[] = [];
  series.forEach((s) => {
    const vs = Array.from({ length: n }, (_, i) => s.b.get(first + i * step) ?? 0);
    if (vs.some((v) => v > 0)) out.push({ ...s.keys, [inc.field]: vs, timeframe: { start: iso(first), end: iso(last + step) }, interval: String(step * 1e6) });
  });
  return out;
}

/** Keeps the rows for the next open. */
export function keep(name: string, plan: Plan, rows: Row[], at = Date.now()) {
  write(name, { v: VERSION, q: plan.full, at, rows });
}
