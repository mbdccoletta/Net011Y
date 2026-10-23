// One hook feeds every screen. "live" runs the validated DQL set in parallel through
// useDql (cached and cancellable by the SDK); "example" returns the bundled, clearly
// labelled simulated network so the experience can be shown at branch scale.
import { useEffect, useMemo, useRef, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { clearSourceMemory, setAbsent as rememberAbsent, setBarren as rememberBarren, setPresent as rememberPresent, sourceMemory, useSourceMemory, type Stamps } from "./sourceMemory";
import type { NetworkModel } from "../model/types";
import { DETAIL_MAX_DEVICES, QUERIES } from "./queries";
import { familyOfToken } from "./formats";
import { keep, mergeRows, planFor, type Plan } from "./logCache";
import { inBuckets, useLogBuckets, useLogBucketGate } from "../hooks/useLogBucket";
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
  /** queries no open view draws, so they have not been read: an empty count here measured nothing */
  unread: string[];
  /** reads the app is deliberately not making, and why a view that needs them says so */
  blocked: string[];
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
  /**
   * The reads a metric could answer: whether this environment publishes one, and what it would cost
   * to keep paying for the log form. Settings turns this into the rule that would make it free.
   */
  metricReads: { name: string; keys: readonly string[]; served: boolean; listed: boolean }[];
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
/**
 * The other half of the same memory. A source found empty is not read again for a while; a source found
 * sending is not made to prove it again either. Without this the companions of a probe wait a whole
 * round trip for an answer somebody already had — on Traffic that was the probe's ten seconds before
 * the bandwidth read could even start. Same horizon as the absence, and Check again clears both.
 *
 * All three notes live in `sourceMemory`, which keeps them in the environment rather than in this
 * browser: what this environment sends is not one reader's opinion.
 */
const fresh = (v: Stamps, within: number): Stamps =>
  Object.fromEntries(Object.entries(v).filter(([, t]) => Date.now() - t < within));
/**
 * Which family publishes which metric, remembered between loads.
 *
 * The family gate asks "does this environment send Cisco", and the answer here is yes — a
 * hundred and thirty-six Cisco devices report memory. It does not ask whether Cisco reports
 * *interfaces*, and on this estate it does not: `ifHourlyUp:cisco` took 6.2 seconds in the
 * first wave to return nothing, `uptime:generic` 4.1 seconds for nothing, `errSummary:cisco`
 * 2.3. The time is the queue, not the data, so an empty answer costs exactly as much as a
 * full one and buys nothing.
 *
 * So an empty answer is remembered and the question is not asked again for a day. A day,
 * and not for ever, because an extension deployed this afternoon must appear by tomorrow
 * without anyone clearing anything — and Refresh clears it now, for anyone who will not wait.
 */
const BARREN_MS = 24 * 60 * 60 * 1000;
/* Only the questions where "nothing" means "this family does not publish this". A query whose
   emptiness is news — no reboots, no alerts — must keep being asked. */
const BARREN_MEASURES = /^(ifHourly|ifHourlyUp|cpuHourly|memHourly|ifSummary|errSummary|ifTraffic|ifErrors|cpu|memory|uptime):/;

/**
 * How long the query service may hold a request open before answering with a token instead.
 *
 * Measured on a live environment, not chosen: the SDK sends no value and its own documentation
 * says the default is "immediate response", so every read — including the ones Grail answers in
 * a fifth of a second — came back as a token and paid a poll round trip plus the hook's wait
 * before it polls. One of the lighter queries on Traffic, a metric.series filter, took 4.4 s
 * through the app and 204 ms when run by hand with this field set.
 *
 * Two seconds, and the figure was tried rather than reasoned. The dev proxy speaks HTTP/1.1, so
 * the browser holds six connections to it and forty-three of the fifty-eight reads already wait
 * for one; a read that keeps its connection longer makes that queue worse, and a read that gives
 * it up too early pays for a poll. Measured on Ahead: 1 s gave 4.66 s to content and five polls,
 * 2 s gave 3.94 s and two, 3 s gave 4.05 s and two. The NetFlow hour scan takes six to eight
 * seconds whatever this says, and holds a token rather than a connection, which is right.
 */
const INLINE_MS = 2000;

const REQUIRED = ["devices", "interfaces"];
/**
 * Enough to judge every device; logs and flows refine the views when they arrive.
 *
 * `cpu`, `memory` and `uptime` used to be in here, one query per family per metric, and they
 * are the reason Traffic was slow. Measured on this environment: fifteen of the thirty-one
 * reads in the first wave were those three, each taking between 3.3 and 4.2 seconds whatever
 * it returned — `uptime:generic` took 4.1s to return nothing and `cpu:f5` 3.6s to return
 * three rows — because the time is Grail's per-user queue, not the data. Traffic draws none
 * of them, and its own two reads, `flowNets` at 7.1s and `flowFanIn` at 5.5s, were queued
 * behind them.
 *
 * What stays is what the first screen of every page actually needs: the interface summary and
 * the error counters, which is how a link gets its state. The three device metrics are tagged
 * to the views that read them instead, below.
 */
const FAMILY_CORE = Object.keys(QUERIES).filter((k) => /^(ifSummary|errSummary):/.test(k) || k === "ifTraffic:network_device" || k === "ifErrors:network_device");
// the alerts are the status of every device: they come with the first screen, so nothing turns red after it
const CORE = ["devices", "interfaces", "families", ...FAMILY_CORE, "problems", "alerts", "icmp", "lldp", "neighbors", "routing"];
const NAMES = Object.keys(QUERIES);
const STALE_MS = 5 * 60 * 1000;
export { DETAIL_MAX_DEVICES } from "./queries";

function tenantName(): string {
  try {
    return new URL(getEnvironmentUrl()).hostname.split(".")[0];
  } catch {
    return "ambiente";
  }
}

const probeStore = new Map<string, number>();
const useProbeRows = () => probeStore;

export function useNetwork(source: Source, scale: "xl" | null = null, views: readonly string[] = []): NetworkState {
  const live = source === "live";
  // The example network is generated on demand, in its own chunk (keeps main.js small).
  const [built, setBuilt] = useState<{ scale: "xl" | null; model: NetworkModel } | null>(null);
  const demo = built && built.scale === scale ? built.model : null;
  useEffect(() => {
    if (live || demo) return;
    import("./exampleNetwork").then((m) => setBuilt({ scale, model: m.buildExampleNetwork(new Date(), scale === "xl" ? "xl" : "enterprise") }));
  }, [live, demo, scale]);
  // The query set is static, so the hooks are always called in the same order.
  // the inventory decides whether the per-interface queries run at all
  // runInBackground: the SDK cancels a running query when the tab loses focus and does not start it again,
  // so a user who switched tabs during the load came back to a load that never finished
  const inventory = useDql(
    { query: QUERIES.devices.query, maxResultRecords: QUERIES.devices.maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500, requestTimeoutMilliseconds: INLINE_MS },
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
  /**
   * A view that has been opened keeps its queries: leaving the page must not throw away what it read,
   * and coming back must not pay for it again. So this grows and never shrinks for as long as the app
   * is open — the saving is on the pages a reader never visits, which in most sessions is most of them.
   */
  const [opened, setOpened] = useState<readonly string[]>(views);
  const viewKey = views.join(",");
  useEffect(() => {
    setOpened((had) => (views.every((v) => had.includes(v)) ? had : [...new Set([...had, ...views])]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);
  // the view just opened counts from this render, not from the effect that remembers it: a render where
  // the page is on screen and its queries are not yet wanted is a render that says the page has nothing
  const reading = useMemo(() => [...new Set([...opened, ...views])], [opened, viewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * Every page is read, whether or not it has been opened.
   *
   * A view's queries used to wait for the view, so the first visit to each page paid for it and
   * switching tabs meant watching a load. They all run now — but not all at once: what the open
   * page draws stays in the wave behind the core, and every other page's reads go in the last
   * wave, which starts only once the core has settled. So the page in front of the reader is no
   * slower than it was, and the pages behind it are already there when they get there.
   *
   * It is not free, and there is one size at which it stops being worth it. Measured on this
   * environment: a Live map load moved 144 MB, and 75.6 MB of it was the fortnight of hourly
   * buckets for every port — a reading only Ahead and an opened device panel draw. Paying
   * that on a page that never shows it, to make a later visit instant, is the wrong way
   * round at this scale.
   *
   * So the rule is narrow: a query that is marked `detail` *and* names its views waits for
   * one of them. Everything else still runs everywhere, which is what keeps the page
   * switches instant. The absent-source memory still applies, so a source this environment
   * does not send is still not read.
   */
  const viewWants = (name: string) => {
    const q = QUERIES[name];
    return !q.detail || !q.views || q.views.some((v) => reading.includes(v));
  };
  const openNow = (name: string) => { const v = QUERIES[name].views; return !v || v.some((x) => reading.includes(x)); };
  /**
   * `openNow` answers "does the open page need this", and for a query that names no view the
   * answer is yes — which made every untagged query jump from the last wave to the first. Wave
   * one went from six reads to twenty and the page's own reads queued behind them on the six
   * connections the browser allows: eleven seconds to the verdict instead of four. The wave
   * asks a narrower question, and an untagged query stays where it was.
   */
  const waveOf = (name: string) => {
    if (REQUIRED.includes(name) || name === "families") return 0;
    if (CORE.includes(name)) return 1;
    const v = QUERIES[name].views;
    if (!v) return 2;
    return v.some((x) => reading.includes(x)) ? 1 : 2;
  };
  /**
   * The last wave trickles instead of arriving.
   *
   * Holding it until the open page had settled fixed the page and moved the problem: the
   * twenty-five reads for pages nobody had opened were then released in one burst straight
   * into the window where the Ahead analyzers run, and the forecast that used to finish at
   * 66s finished at 88s. Grail queues per user, so a burst is never free — it is only ever
   * taken from whatever else this session is asking for.
   *
   * Three at a time, each starting as the one before it lands. One lane was tried and was no
   * better on any of the three numbers — the run-to-run spread on this tenant is wide enough
   * that a single lane buys nothing measurable and only makes the prefetch take a minute. The
   * prefetch still happens; it just stops being a wall, and nothing the reader is waiting on
   * ever has more than three background reads in front of it.
   */
  const LANES = 3;
  const [done2, setDone2] = useState(0);

  const buckets = useLogBuckets();
  /**
   * A log query runs once the tenant has said which buckets hold the network's logs.
   *
   * It used to run immediately against the empty list, which means every bucket: on an environment
   * with the setting in place that is the whole window scanned for nothing, and then scanned again
   * when the answer landed and the plan changed. The wait is one app-state read.
   */
  const bucketGate = useLogBucketGate();
  const readsLogs = (name: string) => /^fetch logs\b/.test(QUERIES[name].query);
  const waitsForBuckets = (name: string) => !bucketGate.released && readsLogs(name);
  /* held, not pending: a view that draws from these has to say so instead of waiting for a read
     that is not going to be made */
  const blocked = bucketGate.held ? NAMES.filter(readsLogs) : [];
  const remembered = useSourceMemory();
  const absent = fresh(remembered.absent, SOURCE_RECHECK_MS);
  const barren = remembered.barren;
  const isBarren = (name: string) => BARREN_MEASURES.test(name)
    && !REQUIRED.includes(name) && Date.now() - (barren[name] ?? 0) < BARREN_MS;
  const answered = fresh(remembered.present, SOURCE_RECHECK_MS);
  // probe results decide the companions, so they are looked up by name before the hooks run
  const probeRows = useProbeRows();
  // the families the environment sends: a family query waits for this answer and runs only for a family
  // that is there; if the answer fails, every family runs, as before
  const familiesAt = NAMES.indexOf("families");
  const familiesQ = useDql(
    { query: QUERIES.families.query, maxResultRecords: QUERIES.families.maxResultRecords ?? 100, requestTimeoutMilliseconds: INLINE_MS },
    { enabled: live, staleTime: STALE_MS, runInBackground: true },
  );
  const present = familiesQ.isSuccess ? new Set((familiesQ.data?.records ?? []).map((r) => familyOfToken(String(r?.family ?? ""))).filter(Boolean)) : null;
  const familyOf = (name: string) => (name.includes(":") ? name.split(":")[1] : null);
  const familyWaits = (name: string) => !!familyOf(name) && familiesQ.isLoading;
  const familyAbsent = (name: string) => { const f = familyOf(name); return !!f && !!present && !present.has(f); };
  /**
   * The reads that a metric can answer, and whether this environment publishes one.
   *
   * A metric query is not billed and a log query is billed by what it scans, and two of the app's
   * reads are arithmetic over a stream — syslog lines per device and level, flows and bytes per
   * exporter — which is what a metric is. One catalogue read, itself a metric query and so free,
   * says which of them exist here; where one does, the metric form runs instead of the log form and
   * the rows arrive under the same names. Where none does, nothing changes and Settings says which
   * rule would make it free.
   *
   * A substitutable read waits for this answer rather than racing it: paying for the log scan and
   * then discovering the metric existed is the one outcome worth avoiding.
   */
  const metricKeys = useMemo(() => [...new Set(NAMES.flatMap((n) => QUERIES[n].metric?.keys ?? []))], []);
  const catalogQ = useDql(
    /* `summarize by:{...}` with nothing to summarise is TOO_FEW_PARAMETERS_FOR_COMMAND; the count is
       thrown away and only the keys are read */
    { query: `metrics from:now()-24h | filter ${metricKeys.map((k) => `metric.key == "${k}"`).join(" or ")} | summarize n = count(), by:{metric.key}`,
      maxResultRecords: 100, requestTimeoutMilliseconds: INLINE_MS },
    { enabled: live && metricKeys.length > 0, staleTime: STALE_MS, runInBackground: true },
  );
  const published = catalogQ.isSuccess
    ? new Set((catalogQ.data?.records ?? []).map((r) => String(r?.["metric.key"] ?? "")).filter(Boolean))
    : null;
  const listed = (name: string) => {
    const m = QUERIES[name].metric;
    return !!m && !!published && m.keys.every((k) => published.has(k));
  };
  /**
   * A metric is used only once it covers the window the log form reads.
   *
   * An extraction rule produces nothing for the time before it was made, and this app reads six
   * hours of syslog and seventy minutes of flow. A rule created an hour ago would answer with one
   * hour of data and five of silence — and silence here is read as "that device logged nothing",
   * which is the opposite of saving money honestly. The probe asks for the oldest bucket of the
   * window; a number there means the rule was already running then. It is a metric query, so the
   * check itself costs nothing, and anything other than a clear yes keeps the log form.
   */
  const coverNames = useMemo(() => NAMES.filter((n) => QUERIES[n].metric), []);
  const coverQs = coverNames.map((n) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useDql({ query: QUERIES[n].metric!.covers, maxResultRecords: 10, requestTimeoutMilliseconds: INLINE_MS },
      { enabled: live && listed(n), staleTime: STALE_MS, runInBackground: true }));
  const covered = (name: string) => {
    const i = coverNames.indexOf(name);
    if (i < 0) return false;
    const q = coverQs[i];
    if (!q.isSuccess) return false;
    const rows = q.data?.records ?? [];
    return rows.length > 0 && rows.every((r) => r?.oldest != null);
  };
  const asMetric = (name: string) => listed(name) && covered(name);
  /* the log form waits while the catalogue is being read, and while the coverage of a metric the
     catalogue did list is still unknown: paying for the scan and then finding the metric was there
     is the outcome this whole mechanism exists to avoid */
  const metricWaits = (name: string) => {
    const m = QUERIES[name].metric;
    if (!m) return false;
    if (catalogQ.isLoading) return true;
    const i = coverNames.indexOf(name);
    return listed(name) && i >= 0 && coverQs[i].isLoading;
  };
  // the log queries read incrementally: from where this browser's last read ends (logCache.ts); a new
  // plan is made when the app opens and on Refresh, never while a load is running
  const [gen, setGen] = useState(0);
  const bucketKey = buckets.join(",");
  /* a read served by a metric is not read incrementally: there is nothing to save and nothing to keep */
  const plans = useMemo(() => Object.fromEntries(NAMES.filter((n) => QUERIES[n].incremental && !asMetric(n))
    .map((n) => [n, planFor(n, inBuckets(QUERIES[n].query, buckets), QUERIES[n].incremental!)] as const)) as Record<string, Plan>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [gen, bucketKey, published ? [...published].sort().join(",") : ""]);
  /* the queue of the last wave, in the order the registry declares them, and the gate that
     lets a query in once the three ahead of it are out of the way */
  const wave2 = NAMES.filter((n) => waveOf(n) === 2);
  const inLane = (name: string) => {
    if (waveOf(name) !== 2) return true;
    return wave2.indexOf(name) < done2 + LANES;
  };
  const raw = NAMES.map((name, i) => {
    if (i === familiesAt) return familiesQ;
    const g = groupOf(name);
    const isProbe = !!g && (SOURCE_GROUPS[g].probes as readonly string[]).includes(name);
    const gated = !!g && (absent[g] != null
      || (!isProbe && answered[g] == null && !(SOURCE_GROUPS[g].probes as readonly string[]).some((p) => (probeRows.get(p) ?? 0) > 0)));
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDql(
      { query: asMetric(name) ? QUERIES[name].metric!.query : plans[name]?.query ?? inBuckets(QUERIES[name].query, buckets), maxResultRecords: QUERIES[name].maxResultRecords ?? 1000, defaultScanLimitGbytes: 1500, requestTimeoutMilliseconds: INLINE_MS },
      { enabled: live && !gated && !waitsForBuckets(name) && !metricWaits(name) && !familyWaits(name) && !familyAbsent(name) && !isBarren(name) && (!QUERIES[name].detail || detailOk) && viewWants(name) && waveOf(name) <= phase && inLane(name), staleTime: STALE_MS, runInBackground: true },
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
    const next = { ...fresh(sourceMemory().absent, SOURCE_RECHECK_MS) };
    const yes = { ...fresh(sourceMemory().present, SOURCE_RECHECK_MS) };
    let changed = false, alsoChanged = false;
    (Object.keys(SOURCE_GROUPS) as SourceGroup[]).forEach((g) => {
      const rs = SOURCE_GROUPS[g].probes.map((p) => results[NAMES.indexOf(p)]);
      if (!rs.every((r) => r.isSuccess)) return;
      const empty = rs.every((r) => !(r.data?.records ?? []).length);
      if (empty && next[g] == null) { next[g] = Date.now(); changed = true; }
      if (!empty && next[g] != null) { delete next[g]; changed = true; }
      if (!empty && yes[g] == null) { yes[g] = Date.now(); alsoChanged = true; }
      if (empty && yes[g] != null) { delete yes[g]; alsoChanged = true; }
    });
    if (changed) rememberAbsent(next);
    if (alsoChanged) rememberPresent(yes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, probeStamp]);
  /* an empty answer is written down, a full one rubs the note out */
  const barrenStamp = NAMES.map((n, i) => (BARREN_MEASURES.test(n) && results[i].isSuccess
    ? ((results[i].data?.records ?? []).length ? "1" : "0") : "-")).join("");
  useEffect(() => {
    if (!live) return;
    const next = { ...sourceMemory().barren };
    let changed = false;
    NAMES.forEach((n, i) => {
      if (!BARREN_MEASURES.test(n) || !results[i].isSuccess) return;
      const empty = !(results[i].data?.records ?? []).length;
      if (empty && next[n] == null) { next[n] = Date.now(); changed = true; }
      if (!empty && next[n] != null) { delete next[n]; changed = true; }
    });
    if (changed) rememberBarren(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, barrenStamp]);
  const skippedSource = (i: number) => { const g = groupOf(NAMES[i]); return !!g && absent[g] != null; };

  // a query that will not run counts as settled: its source was found empty, or its probe brought nothing
  const probeSaysNo = (i: number) => {
    const g = groupOf(NAMES[i]);
    if (!g || (SOURCE_GROUPS[g].probes as readonly string[]).includes(NAMES[i]) || answered[g] != null) return false;
    const probes = SOURCE_GROUPS[g].probes.map((p) => results[NAMES.indexOf(p)]);
    return probes.every((r) => r.isSuccess || r.isError) && !probes.some((r) => (r.data?.records ?? []).length);
  };
  /**
   * Settled: either the environment cannot answer it, or the open page does not need it to draw.
   *
   * Dropping the second half — now that every page is read rather than only the open one — was
   * a regression I measured before believing: the verdict went from four seconds to twelve,
   * because `coreSettled` is built on this and the model waits on `coreSettled`. The page in
   * front of the reader was being held for reads belonging to pages behind it.
   *
   * So the two questions are separated. This one gates rendering and asks only about the open
   * page; `unread` below asks what this app actually has, and answers for all of them.
   */
  const skipped = (i: number) => (!!QUERIES[NAMES[i]].detail && !detailOk) || skippedSource(i)
    || probeSaysNo(i) || familyAbsent(NAMES[i]) || isBarren(NAMES[i]) || !openNow(NAMES[i]);
  const settled = results.filter((r, i) => r.isSuccess || r.isError || skipped(i)).length;
  /* reset by the same thing that restarts the reads, so a refresh counts up from zero again */
  const highWater = useRef(0);
  highWater.current = settled === 0 ? 0 : Math.max(highWater.current, settled);
  const failed = NAMES.filter((_, i) => results[i].isError);
  const requiredOk = REQUIRED.every((n) => { const i = NAMES.indexOf(n); return results[i].isSuccess || skipped(i); });
  const coreSettled = CORE.every((n) => { const i = NAMES.indexOf(n); const r = results[i]; return r.isSuccess || r.isError || skipped(i); });
  // A slow environment must not hold the whole app hostage: once the inventory is in and the core has had
  // its time, the app renders with what arrived and fills the rest in as it lands.
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!live || coreSettled) { setOverdue(false); return; }
    const t = setTimeout(() => setOverdue(true), 8000);
    return () => clearTimeout(t);
  }, [live, coreSettled]);
  /**
   * The last wave waits for the open page, not just for the core.
   *
   * It waited for `coreSettled`, and the open page's own reads are not in the core — the Ahead
   * hourly series are tagged to the view, so they are wave one but not CORE. The core settled
   * at around eight seconds, phase two released twenty-seven reads belonging to pages nobody
   * had opened, and they landed on top of the heaviest queries on screen: measured on this
   * environment, thirty-six queries in flight at once and wave one finishing at 9.9s instead
   * of the 5s its own slowest read takes. Grail queues per user, so the overlap is not free
   * parallelism — it is the open page waiting behind pages that are not.
   */
  const waveOneSettled = NAMES.every((n, i) =>
    waveOf(n) > 1 || results[i].isSuccess || results[i].isError || skipped(i));
  /* `overdue` is the same escape hatch the model uses: a wave-one read that never answers must
     not keep the rest of the app from ever being fetched */
  useEffect(() => { if ((waveOneSettled || overdue) && phase < 2) setPhase(2); },
    [waveOneSettled, overdue, phase]);
  /* how far the trickle has got: a query that was skipped counts as out of the way, or a
     source this environment does not send would stall the queue behind it for ever */
  const settled2 = wave2.filter((n) => {
    const i = NAMES.indexOf(n);
    return results[i].isSuccess || results[i].isError || skipped(i);
  }).length;
  useEffect(() => { setDone2((had) => (settled2 > had ? settled2 : had)); }, [settled2]);
  const stamp = results.map((r, i) => (r.isSuccess ? 1 : r.isError ? 2 : skipped(i) ? 3 : 0)).join("");

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
  /**
   * Nothing may be claimed from a query that has not answered.
   *
   * This used to be "no open view asked for it", which was the same thing while a page's reads
   * waited for the page. Now that every page is read from the start, that set is empty from the
   * first render — and coverage computed against data still in flight reports a confident 0%
   * instead of "not measured yet", which is the defect this list exists to prevent. Pending and
   * failed, then: both are reads this app does not have.
   */
  const unread = NAMES.filter((n, i) => !results[i].isSuccess
    && !((!!QUERIES[n].detail && !detailOk) || skippedSource(i) || probeSaysNo(i) || familyAbsent(n)
      || isBarren(n)));

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
      // what ran is what is billed: a read served by a metric is not a log read any more
      const kind = asMetric(n) ? null : billedAs(QUERIES[n].query);
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
    unread,
    blocked,
    estate,
    detailLoaded: detailOk,
    loading: live ? settled < NAMES.length : !demo,
    /**
     * The count never goes backwards, because a reader reads it as progress.
     *
     * `settled` mixes two things: a query that answered, and a query that does not apply
     * right now — skipped because its view is closed, its family is absent, its source
     * probe said no, or its bucket came back barren. The second set changes *while* the
     * first grows: a probe answers, a view opens, and something that was counted as out of
     * the way is back in the queue. Measured on a recording, the header went "38 of 97" at
     * four seconds and "37 of 97" at sixteen.
     */
    done: live ? Math.max(highWater.current, settled) : NAMES.length,
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
      rememberBarren({});
      setGen((g) => g + 1);
    },
    metricReads: NAMES.filter((n) => QUERIES[n].metric)
      .map((n) => ({ name: n, keys: QUERIES[n].metric!.keys, served: asMetric(n), listed: listed(n) })),
    absent,
    recheck: () => clearSourceMemory(),
    cost,
  };
}
