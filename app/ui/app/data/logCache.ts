// Log queries are billed by the data Grail scans, and a window of logs costs the same whatever the filter:
// on a busy environment six hours of logs is close to a hundred gigabytes, read again every time the app
// opens. The part of the window already read does not change, so the browser keeps what it read and the
// next open asks Grail only for what came after it, then puts the two together. The answer is the one the
// full query gives: series are cut in clock-aligned buckets, so a bucket read now replaces the same bucket
// read before; the latest-seen and newest-records queries merge by their keys.
//
// Where it is kept, and why not where it used to be. It was written to `window.localStorage`, which is
// the one kind of state this app does not keep: everything it remembers belongs to the environment. It
// cannot go into *shared* app state either — these rows can carry log content, and another user of the
// same app may not be allowed to read that bucket — so it goes into the state of the one person reading
// it, where the platform keeps it for them alone and expires it on a date this file sets. A reader who
// comes back inside the window pays for the minutes since they left instead of the whole six hours;
// within a session nothing changes, and anything unexpected — a changed query, a kept part older than
// the window, a payload too large to store, a tenant that refuses — runs the full query, as before.

import { stateClient } from "@dynatrace-sdk/client-state";

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

const toMs = (v: unknown) => {
  const s = String(v ?? "");
  const base = Date.parse(s.slice(0, 19) + "Z");
  const frac = s.match(/^.{19}\.(\d{1,3})/);
  return Number.isNaN(base) ? NaN : base + (frac ? Number(frac[1].padEnd(3, "0")) : 0);
};
const iso = (ms: number) => new Date(ms).toISOString();
const floor = (ms: number, step: number) => Math.floor(ms / step) * step;

/** This session's kept parts, by query name. */
const held = new Map<string, Entry>();

/**
 * What the platform will take, and what this file will send it.
 *
 * The documentation names the error — the combined size of one user's app states for one app is
 * capped — without naming the number. The first cap written here was sixty kilobytes, and measuring
 * the entry it exists for showed why that was a guess worth checking: six hours of syslog counts on
 * a real environment is two hundred and seven series and a hundred and eighteen kilobytes, so the
 * saving this cache exists for was the one thing it refused to store. The ceiling is high enough for
 * that entry now, and the budget is respected the only way it can be without a documented figure:
 * the first refusal stops the writing for the rest of the session, because a tenant that said no
 * will say no again.
 */
const STORE_MAX_CHARS = 250_000;
let refused = false;
const KEY = (name: string) => `net-o11y.log-cache.${name}`;
let loaded: Promise<void> | null = null;

/** The kept parts this reader left behind, fetched once per page. Nothing waits on a failure. */
export function loadKeptParts(names: readonly string[]): Promise<void> {
  if (loaded) return loaded;
  loaded = Promise.all(names.map((n) => stateClient.getUserAppState({ key: KEY(n) })
    .then((s) => {
      const e = JSON.parse(s.value) as Entry;
      if (e && e.v === VERSION && Array.isArray(e.rows)) held.set(n, e);
    })
    .catch(() => { /* never stored, expired, or no permission: the full window is read */ })))
    .then(() => undefined);
  return loaded;
}

function read(name: string): Entry | null {
  const e = held.get(name);
  return e && e.v === VERSION && Array.isArray(e.rows) ? e : null;
}
function write(name: string, e: Entry, windowMs: number) {
  // the ceiling stays: a window of logs can be enormous and holding all of it helps nobody
  const s = JSON.stringify(e);
  if (s.length > MAX_CHARS) { held.delete(name); return; }
  held.set(name, e);
  if (s.length > STORE_MAX_CHARS || refused) return;
  /* it expires when it stops being useful: a kept part older than the window it belongs to is of no
     help to the next read, and the platform can drop it rather than hand back something unusable */
  stateClient.setUserAppState({ key: KEY(name), body: { value: s, validUntilTime: new Date(Date.now() + windowMs).toISOString() } })
    .catch(() => { refused = true; /* over the budget or not permitted: this session keeps it in memory */ });
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
export function keep(name: string, plan: Plan, rows: Row[], windowMs: number, at = Date.now()) {
  write(name, { v: VERSION, q: plan.full, at, rows }, windowMs);
}
