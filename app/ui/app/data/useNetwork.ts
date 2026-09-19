// One hook feeds every screen. "live" runs the validated DQL set in parallel through
// useDql (cached and cancellable by the SDK); "example" returns the bundled, clearly
// labelled simulated network so the experience can be shown at branch scale.
import { useEffect, useMemo, useRef, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import type { NetworkModel } from "../model/types";
import { QUERIES } from "./queries";
import { familyOfToken } from "./formats";
import { keep, mergeRows, planFor, type Plan } from "./logCache";
import { inBuckets, useLogBuckets } from "../hooks/useLogBucket";
import { buildRealModel, type QueryResults } from "./buildRealModel";

export type Source = "live" | "example";

export interface NetworkState {
  model: NetworkModel | null;
  loading: boolean;
  done: number;
  total: number;
  failed: string[];
  /** Rows returned per query; null while loading or when the query failed */
  counts: Record<string, number | null>;
  /** Devices in the environment, as soon as the inventory answers */
  estate: number | null;
  /** false in a large estate, where interface detail is fetched per device instead */
  detailLoaded: boolean;
  refetch: () => void;
  /** optional sources found empty, and when: they are not read again until SOURCE_RECHECK_MS has passed */
  absent: Partial<Record<SourceGroup, number>>;
  /** forget what was found empty and read every source again */
  recheck: () => void;
  /** what this load read from Grail, as Dynatrace bills it */
  cost: LoadCost | null;
}

/**
 * The data Grail read for this load. Logs, events and sessions are billed by the data scanned; metrics,
 * Smartscape and Davis problems and events are included, so they are left out.
 */
export interface LoadCost {
  billableGb: number;
  logGb: number;
  eventGb: number;
  sessionGb: number;
  byQuery: { name: string; gb: number }[];
  /**
   * Network records (syslog, traps, NetFlow) as a share of the log records the queries read: a log query
   * reads every record of its buckets in its window, so this is what a bucket of their own would leave.
   * null when the environment sends no network logs.
   */
  networkShare: number | null;
}

const billedAs = (query: string): "logGb" | "eventGb" | "sessionGb" | null =>
  /^fetch logs\b/.test(query) ? "logGb" : /^fetch events\b/.test(query) ? "eventGb" : /^fetch user\.sessions\b/.test(query) ? "sessionGb" : null;

/**
 * The sources a network may or may not send, each read through logs or events, which Grail bills by what
 * it scans. A probe decides: its companions run only when it brings rows, and a source found empty is
 * remembered for this environment and not read again for a while. On an environment without NetFlow,
 * firewall logs or OneAgent flows that is most of the log scanning gone.
 */
export const SOURCE_GROUPS = {
  netflow: { probes: ["flowNets"], then: ["flowFanIn", "flowTs"] },
  deviceLogs: { probes: ["deviceLogs"], then: ["deviceLogsRecent"] },
  neighbors: { probes: ["neighbors"], then: [] },
  oneagentFlows: { probes: ["appNet"], then: ["appNetBy", "appPaths", "cloud", "cloudTop"] },
} as const;
export type SourceGroup = keyof typeof SOURCE_GROUPS;
export const SOURCE_RECHECK_MS = 12 * 3600 * 1000;
const groupOf = (name: string) => (Object.keys(SOURCE_GROUPS) as SourceGroup[]).find((g) => (SOURCE_GROUPS[g].probes as readonly string[]).includes(name) || (SOURCE_GROUPS[g].then as readonly string[]).includes(name));
const ABSENT_KEY = () => { try { return `net-o11y.absent@${new URL(getEnvironmentUrl()).hostname}`; } catch { return "net-o11y.absent"; } };
function readAbsent(): Partial<Record<SourceGroup, number>> {
  try {
    const v = JSON.parse(window.localStorage.getItem(ABSENT_KEY()) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(v).filter(([, t]) => Date.now() - t < SOURCE_RECHECK_MS)) as Partial<Record<SourceGroup, number>>;
  } catch { return {}; }
}
function writeAbsent(v: Partial<Record<SourceGroup, number>>) {
  try { window.localStorage.setItem(ABSENT_KEY(), JSON.stringify(v)); } catch { /* per session only */ }
}

const REQUIRED = ["devices", "interfaces"];
// Enough to judge every device; logs and flows refine the views when they arrive (progressive loading).
// Of the extension families, the common set carries the first screen; vendor families complete it later.
const FAMILY_CORE = Object.keys(QUERIES).filter((k) => /^(ifSummary|errSummary|cpu|memory|uptime):/.test(k) || k === "ifTraffic:network_device" || k === "ifErrors:network_device");
// the alerts are the status of every device: they come with the first screen, so nothing turns red after it
const CORE = ["devices", "interfaces", "families", ...FAMILY_CORE, "problems", "alerts", "icmp", "lldp", "neighbors", "routing"];
const NAMES = Object.keys(QUERIES);
const STALE_MS = 5 * 60 * 1000;
/**
 * Above this many devices the app stops pulling every port of every device (that is hundreds of
 * thousands of rows) and works from the per-device summaries; the ports of one device are fetched
 * when somebody opens it.
 */
export const DETAIL_MAX_DEVICES = 3000;

function tenantName(): string {
  try {
    return new URL(getEnvironmentUrl()).hostname.split(".")[0];
  } catch {
    return "ambiente";
  }
}

const probeStore = new Map<string, number>();
const useProbeRows = () => probeStore;

export function useNetwork(source: Source): NetworkState {
  const live = source === "live";
  // The example network is generated on demand, in its own chunk (keeps main.js small).
  const [demo, setDemo] = useState<NetworkModel | null>(null);
  useEffect(() => {
    if (live || demo) return;
    import("./exampleNetwork").then((m) => setDemo(m.buildExampleNetwork()));
  }, [live, demo]);
  // The query set is static, so the hooks are always called in the same order.
  // the inventory decides whether the per-interface queries run at all
  // runInBackground: the SDK cancels a running query when the tab loses focus and does not start it again,
  // so a user who switched tabs during the load came back to a load that never finished
  const inventory = useDql(
    { query: QUERIES.devices.query, maxResultRecords: QUERIES.devices.maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500 },
    { enabled: live, staleTime: STALE_MS, runInBackground: true },
  );
  const estate = inventory.isSuccess ? (inventory.data?.records ?? []).length : null;
  const detailOk = estate != null && estate <= DETAIL_MAX_DEVICES;
  /**
   * Grail runs a limited number of queries per user at a time, so firing all of them at once leaves the
   * last ones queued behind the slow ones and the app waits on an environment that is already answering.
   * They start in three waves instead: the inventory, then what every view needs, then the rest.
   */
  const [phase, setPhase] = useState(0);
  useEffect(() => { if (inventory.isSuccess && phase < 1) setPhase(1); }, [inventory.isSuccess, phase]);
  const waveOf = (name: string) => (REQUIRED.includes(name) || name === "families" ? 0 : CORE.includes(name) ? 1 : 2);
  const buckets = useLogBuckets();
  const [absent, setAbsent] = useState(readAbsent);
  // probe results decide the companions, so they are looked up by name before the hooks run
  const probeRows = useProbeRows();
  // the families the environment sends: a family query waits for this answer and runs only for a family
  // that is there; if the answer fails, every family runs, as before
  const familiesAt = NAMES.indexOf("families");
  const familiesQ = useDql(
    { query: QUERIES.families.query, maxResultRecords: QUERIES.families.maxResultRecords ?? 100 },
    { enabled: live, staleTime: STALE_MS, runInBackground: true },
  );
  const present = familiesQ.isSuccess ? new Set((familiesQ.data?.records ?? []).map((r) => familyOfToken(String(r?.family ?? ""))).filter(Boolean)) : null;
  const familyOf = (name: string) => (name.includes(":") ? name.split(":")[1] : null);
  const familyWaits = (name: string) => !!familyOf(name) && familiesQ.isLoading;
  const familyAbsent = (name: string) => { const f = familyOf(name); return !!f && !!present && !present.has(f); };
  // the log queries read incrementally: from where this browser's last read ends (logCache.ts); a new
  // plan is made when the app opens and on Refresh, never while a load is running
  const [gen, setGen] = useState(0);
  const bucketKey = buckets.join(",");
  const plans = useMemo(() => Object.fromEntries(NAMES.filter((n) => QUERIES[n].incremental)
    .map((n) => [n, planFor(n, inBuckets(QUERIES[n].query, buckets), QUERIES[n].incremental!)] as const)) as Record<string, Plan>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [gen, bucketKey]);
  const raw = NAMES.map((name, i) => {
    if (i === familiesAt) return familiesQ;
    const g = groupOf(name);
    const isProbe = !!g && (SOURCE_GROUPS[g].probes as readonly string[]).includes(name);
    const gated = !!g && (absent[g] != null || (!isProbe && !(SOURCE_GROUPS[g].probes as readonly string[]).some((p) => (probeRows.get(p) ?? 0) > 0)));
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDql(
      { query: plans[name]?.query ?? inBuckets(QUERIES[name].query, buckets), maxResultRecords: QUERIES[name].maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500 },
      { enabled: live && !gated && !familyWaits(name) && !familyAbsent(name) && (!QUERIES[name].detail || detailOk) && waveOf(name) <= phase, staleTime: STALE_MS, runInBackground: true },
    );
  });
  // what the rest of the app sees of an incremental query is the whole window: the kept part and the new one
  const merged = useRef(new Map<string, { data: unknown; rows: Record<string, unknown>[] }>());
  const results = raw.map((r, i) => {
    const n = NAMES[i], plan = plans[n], inc = QUERIES[n].incremental;
    if (!plan || !inc || !r.isSuccess || !r.data) return r;
    let m = merged.current.get(n);
    if (!m || m.data !== r.data) {
      m = { data: r.data, rows: mergeRows(inc, plan, (r.data.records ?? []).filter(Boolean) as Record<string, unknown>[]) };
      merged.current.set(n, m);
      keep(n, plan, m.rows);
    }
    return { ...r, data: { ...r.data, records: m.rows } } as typeof r;
  });
  NAMES.forEach((n, i) => { if (results[i].isSuccess) probeRows.set(n, (results[i].data?.records ?? []).length); });
  // a source whose probes all came back empty is remembered; one that answered is forgotten
  const probeStamp = (Object.keys(SOURCE_GROUPS) as SourceGroup[]).map((g) => SOURCE_GROUPS[g].probes.map((p) => { const r = results[NAMES.indexOf(p)]; return r.isSuccess ? ((r.data?.records ?? []).length ? "1" : "0") : "-"; }).join("")).join("|");
  useEffect(() => {
    if (!live) return;
    const next = { ...readAbsent() };
    let changed = false;
    (Object.keys(SOURCE_GROUPS) as SourceGroup[]).forEach((g) => {
      const rs = SOURCE_GROUPS[g].probes.map((p) => results[NAMES.indexOf(p)]);
      if (!rs.every((r) => r.isSuccess)) return;
      const empty = rs.every((r) => !(r.data?.records ?? []).length);
      if (empty && next[g] == null) { next[g] = Date.now(); changed = true; }
      if (!empty && next[g] != null) { delete next[g]; changed = true; }
    });
    if (changed) { writeAbsent(next); setAbsent(next); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, probeStamp]);
  const skippedSource = (i: number) => { const g = groupOf(NAMES[i]); return !!g && absent[g] != null; };

  // a query that will not run counts as settled: its source was found empty, or its probe brought nothing
  const probeSaysNo = (i: number) => {
    const g = groupOf(NAMES[i]);
    if (!g || (SOURCE_GROUPS[g].probes as readonly string[]).includes(NAMES[i])) return false;
    const probes = SOURCE_GROUPS[g].probes.map((p) => results[NAMES.indexOf(p)]);
    return probes.every((r) => r.isSuccess || r.isError) && !probes.some((r) => (r.data?.records ?? []).length);
  };
  const skipped = (i: number) => (!!QUERIES[NAMES[i]].detail && !detailOk) || skippedSource(i) || probeSaysNo(i) || familyAbsent(NAMES[i]);
  const settled = results.filter((r, i) => r.isSuccess || r.isError || skipped(i)).length;
  const failed = NAMES.filter((_, i) => results[i].isError);
  const requiredOk = REQUIRED.every((n) => { const i = NAMES.indexOf(n); return results[i].isSuccess || skipped(i); });
  const coreSettled = CORE.every((n) => { const i = NAMES.indexOf(n); const r = results[i]; return r.isSuccess || r.isError || skipped(i); });
  useEffect(() => { if (coreSettled && phase < 2) setPhase(2); }, [coreSettled, phase]);
  const stamp = results.map((r, i) => (r.isSuccess ? 1 : r.isError ? 2 : skipped(i) ? 3 : 0)).join("");

  // A slow environment must not hold the whole app hostage: once the inventory is in and the core has had
  // its time, the app renders with what arrived and fills the rest in as it lands.
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!live || coreSettled) { setOverdue(false); return; }
    const t = setTimeout(() => setOverdue(true), 8000);
    return () => clearTimeout(t);
  }, [live, coreSettled]);

  const model = useMemo<NetworkModel | null>(() => {
    if (!live) return demo;
    if (!requiredOk || (!coreSettled && !overdue)) return null;
    const data: QueryResults = {};
    NAMES.forEach((n, i) => {
      const r = results[i];
      if (r.isSuccess) data[n] = (r.data?.records ?? []).filter(Boolean) as Record<string, unknown>[];
    });
    return buildRealModel(data, tenantName());
    // results change identity on every render; the stamp captures what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, demo, coreSettled, overdue, requiredOk, stamp]);

  const counts = Object.fromEntries(NAMES.map((n, i) => [n, results[i].isSuccess ? (results[i].data?.records ?? []).length : null]));

  // what Grail read, from the metadata of each answer (the part read, for an incremental query)
  const cost = useMemo<LoadCost | null>(() => {
    if (!live) return null;
    const c: LoadCost = { billableGb: 0, logGb: 0, eventGb: 0, sessionGb: 0, byQuery: [], networkShare: null };
    const perHour = (i: number) => {
      const g = raw[i].data?.metadata?.grail, tf = g?.analysisTimeframe;
      const h = tf?.start && tf?.end ? (Date.parse(String(tf.end).slice(0, 23) + "Z") - Date.parse(String(tf.start).slice(0, 23) + "Z")) / 3600e3 : 0;
      return { scanned: (g?.scannedRecords ?? 0) / (h || 1), h: h || 1 };
    };
    NAMES.forEach((n, i) => {
      const kind = billedAs(QUERIES[n].query);
      const gb = (raw[i].isSuccess ? raw[i].data?.metadata?.grail?.scannedBytes ?? 0 : 0) / 1e9;
      if (!kind || !gb) return;
      c[kind] += gb; c.billableGb += gb; c.byQuery.push({ name: n, gb });
    });
    c.byQuery.sort((a, b) => b.gb - a.gb);
    // matched records per hour against records read per hour, from the two queries that count what they match
    const matched = (name: string, field: string) => {
      const i = NAMES.indexOf(name);
      if (i < 0 || !raw[i].isSuccess) return null;
      const n = (raw[i].data?.records ?? []).reduce((a, r) => a + (Array.isArray(r?.[field]) ? (r![field] as unknown[]).reduce<number>((b, v) => b + (Number(v) || 0), 0) : 0), 0);
      const { scanned, h } = perHour(i);
      return scanned ? { net: n / h, all: scanned } : null;
    };
    const logs = matched("deviceLogs", "n"), flows = matched("flowTs", "flows");
    const all = logs?.all ?? flows?.all;
    if (all && (logs?.net || flows?.net)) c.networkShare = Math.min(1, ((logs?.net ?? 0) + (flows?.net ?? 0)) / all);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, stamp]);
  return {
    model,
    counts,
    estate,
    detailLoaded: detailOk,
    loading: live ? settled < NAMES.length : !demo,
    done: live ? settled : NAMES.length,
    total: NAMES.length,
    failed,
    // Refresh means now: refetch would hand back the cached answer for as long as it is fresh (staleTime)
    // an incremental query gets a new plan (from where its last read ends) instead of running the old one again
    refetch: () => {
      inventory.forceRefetch();
      results.forEach((r, i) => {
        const n = NAMES[i], inc = QUERIES[n].incremental;
        if (skipped(i) || (inc && planFor(n, inBuckets(QUERIES[n].query, buckets), inc).query !== plans[n]?.query)) return;
        r.forceRefetch();
      });
      setGen((g) => g + 1);
    },
    absent,
    recheck: () => { writeAbsent({}); setAbsent({}); },
    cost,
  };
}
