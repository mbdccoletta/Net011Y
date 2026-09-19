// One hook feeds every screen. "live" runs the validated DQL set in parallel through
// useDql (cached and cancellable by the SDK); "example" returns the bundled, clearly
// labelled simulated network so the experience can be shown at branch scale.
import { useEffect, useMemo, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import type { NetworkModel } from "../model/types";
import { QUERIES } from "./queries";
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
}

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
const CORE = ["devices", "interfaces", ...FAMILY_CORE, "icmp", "lldp", "neighbors", "routing"];
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
  const waveOf = (name: string) => (REQUIRED.includes(name) ? 0 : CORE.includes(name) ? 1 : 2);
  const buckets = useLogBuckets();
  const [absent, setAbsent] = useState(readAbsent);
  // probe results decide the companions, so they are looked up by name before the hooks run
  const probeRows = useProbeRows();
  const results = NAMES.map((name) => {
    const g = groupOf(name);
    const isProbe = !!g && (SOURCE_GROUPS[g].probes as readonly string[]).includes(name);
    const gated = !!g && (absent[g] != null || (!isProbe && !(SOURCE_GROUPS[g].probes as readonly string[]).some((p) => (probeRows.get(p) ?? 0) > 0)));
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDql(
      { query: inBuckets(QUERIES[name].query, buckets), maxResultRecords: QUERIES[name].maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500 },
      { enabled: live && !gated && (!QUERIES[name].detail || detailOk) && waveOf(name) <= phase, staleTime: STALE_MS, runInBackground: true },
    );
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
  const skipped = (i: number) => (!!QUERIES[NAMES[i]].detail && !detailOk) || skippedSource(i) || probeSaysNo(i);
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
    refetch: () => { inventory.forceRefetch(); results.forEach((r, i) => { if (!skipped(i)) r.forceRefetch(); }); },
    absent,
    recheck: () => { writeAbsent({}); setAbsent({}); },
  };
}
