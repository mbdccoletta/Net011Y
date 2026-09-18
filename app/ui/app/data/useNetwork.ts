// One hook feeds every screen. "live" runs the validated DQL set in parallel through
// useDql (cached and cancellable by the SDK); "example" returns the bundled, clearly
// labelled simulated network so the experience can be shown at branch scale.
import { useEffect, useMemo, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import type { NetworkModel } from "../model/types";
import { QUERIES } from "./queries";
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
}

const REQUIRED = ["devices", "interfaces"];
// Enough to judge every device; logs and flows refine the views when they arrive (progressive loading).
const CORE = ["devices", "interfaces", "trJuniper", "trCisco", "trGeneric", "errJuniper", "errCisco", "errGeneric", "cpu", "uptime", "icmp", "lldp", "routing"];
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
  const inventory = useDql(
    { query: QUERIES.devices.query, maxResultRecords: QUERIES.devices.maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500 },
    { enabled: live, staleTime: STALE_MS },
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
  const results = NAMES.map((name) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useDql(
      { query: QUERIES[name].query, maxResultRecords: QUERIES[name].maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500 },
      { enabled: live && (!QUERIES[name].detail || detailOk) && waveOf(name) <= phase, staleTime: STALE_MS },
    ),
  );

  const skipped = (i: number) => !!QUERIES[NAMES[i]].detail && !detailOk;
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
    refetch: () => results.forEach((r) => r.refetch()),
  };
}
