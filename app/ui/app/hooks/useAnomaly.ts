// Is this signal outside what the platform considers normal? Asked of it, not decided here.
//
// The app had its own rule: the last complete hour against the median of the same hour over
// seven days, called a fall below a percentage the customer sets. That rule is a baseline the
// app invented — a median ignores the weekday, the holiday and the trend — and it produced a
// verdict the platform does not make. Measured on this environment while the header read
// "47% of usual sessions", `SeasonalBaselineAnomalyDetectionAnalyzer` analysed the same series
// and raised nothing: by the platform's own seasonal model, that hour was within range.
//
// So the percentage stays, because it is a measurement, and the verdict moves here.
//
// Two things about this analyzer, both measured against this tenant:
//
//  · An empty `output` is the answer "nothing anomalous", not a failure. The run reports what
//    it did in `logs` — "Analyzed 1 time series." — which is how the app can tell an answer
//    of "no" from a query that matched nothing.
//  · It takes the app's own session query, `fetch user.sessions … | makeTimeseries`, which
//    the forecast analyzer's documentation does not promise: `timeseries` is a metric command
//    and user sessions are records, so this was the one shape that could work and it does.
import { useEffect, useRef, useState } from "react";
import type { NetworkModel } from "../model/types";
import { QUERIES } from "../data/queries";

/**
 * The detectors this tenant exposes, and what each one owns.
 *
 * Listed from the platform itself (`GET /analyzers`), not from documentation: this
 * environment answers with six, of which the app now uses four. Which one owns a question
 * is the platform's own distinction — seasonal for a signal with a daily shape, adaptive for
 * one with no shape but its own spread, novelty for "did it change at all", forecast for
 * where it is going.
 */
export const ANALYZER = {
  seasonal: "dt.statistics.anomaly_detection.SeasonalBaselineAnomalyDetectionAnalyzer",
  adaptive: "dt.statistics.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer",
  staticThreshold: "dt.statistics.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer",
} as const;
export type AnalyzerKind = keyof typeof ANALYZER;

const url = (kind: AnalyzerKind) => `/platform/davis/analyzers/v1/analyzers/${ANALYZER[kind]}`;

/**
 * The series to judge: the one the app is already measuring.
 *
 * Sessions where this environment has real user monitoring, requests where it does not —
 * the same choice `trafficDrop` makes, so the verdict and the figure beside it are about
 * one series. The expressions are the app's own queries, not a second pair written here.
 */
/**
 * The series the applications feel the network through, as this environment reports them.
 *
 * Two sources answer the same question and the model records which one it used, so the
 * detector is asked about the series the app is actually reading — not a second query
 * written here that might resolve to nothing. Measured on this tenant: the flows bucket
 * returns no records at all, and the analyzer says so in as many words ("There is no input
 * data to analyze"), while the per-process metrics answer.
 */
export function appNetExpressions(model: NetworkModel | null): { retransmitted: string; roundTrip: string } | null {
  if (!model || model.demo || !model.appNet) return null;
  return model.appNet.source === "flows"
    ? {
      retransmitted: 'fetch events, from:now()-8h, bucket:{"default_network_flows"} | fieldsAdd re = toLong(network_flow.packets.retransmitted.tx) + toLong(network_flow.packets.retransmitted.rx) | makeTimeseries retransmitted = sum(re), interval:10m',
      roundTrip: 'fetch events, from:now()-8h, bucket:{"default_network_flows"} | fieldsAdd rtt = if(toLong(network_flow.tcp.rtt) > 0, toLong(network_flow.tcp.rtt)) | makeTimeseries roundTrip = percentile(rtt, 90), interval:10m',
    }
    : {
      retransmitted: "timeseries retransmitted = sum(dt.process.network.packets.re_tx), from:now()-8h, interval:10m",
      roundTrip: "timeseries roundTrip = avg(dt.process.network.round_trip), from:now()-8h, interval:10m",
    };
}

export function demandExpression(model: NetworkModel | null): string | null {
  if (!model || model.demo) return null;
  if (model.users?.typicalNow != null) return QUERIES.sessionsTypical.query;
  if (model.users?.requests?.typicalNow != null) return QUERIES.requestsTypical.query;
  return null;
}

export interface Anomaly {
  /** the platform raised at least one alert on this series in the window */
  alerted: boolean;
  /** when each alert began, as the analyzer labels it */
  alerts: { start: string | null; end: string | null }[];
  /** the analyzer ran and had a series to look at: an empty answer then means "nothing" */
  analysed: boolean;
  loading: boolean;
  error: string | null;
}

const NOTHING: Anomaly = { alerted: false, alerts: [], analysed: false, loading: false, error: null };
const cache = new Map<string, Anomaly>();
/**
 * The runs already in the air, by question.
 *
 * The cache alone is not enough: it is written when a run finishes, so every caller that
 * mounts while one is in flight starts another. Measured on the map, which asks this from
 * two panels and re-asks as the model fills: twelve executions of one analysis. A promise
 * per question means the second caller waits on the first.
 */
const inflight = new Map<string, Promise<Anomaly>>();

/**
 * One ask, cached by the expression, so two panels asking the same question cost one run.
 *
 * `tolerance` is the analyzer's own sensitivity and is left at its default of 4: the app does
 * not tune the platform's detector, because a number this app picked is the thing it is
 * trying to stop shipping.
 */
export function useAnomaly(kind: AnalyzerKind, expression: string | null, opts: {
  /** which side of normal counts; the default is the analyzer's own */
  condition?: "ABOVE" | "BELOW" | "OUTSIDE";
  /** how much history the detector learns from */
  days?: number;
} = {}): Anomaly {
  const { condition = "BELOW", days = 7 } = opts;
  const BASE = url(kind);
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = expression ? `${kind}|${condition}|${days}|${expression}` : "";
  const last = useRef<Anomaly | null>(null);

  useEffect(() => {
    if (!expression || cache.has(key)) return;
    setBusy(true); setError(null);
    let live = true;
    const t = setTimeout(() => {
      const run = inflight.get(key) ?? (async () => {
        const body = {
          timeSeriesData: { expression },
          alertCondition: condition,
          /* the adaptive detector needs its width; the seasonal one ignores it */
          ...(kind === "adaptive" ? { numberOfSignalFluctuations: 1.0, violatingSamples: 3, slidingWindow: 5 } : {}),
          generalParameters: { timeframe: { startTime: `now-${days}d`, endTime: "now" }, logVerbosity: "INFO" },
        };
        const started = await fetch(`${BASE}:execute`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then((r) => r.json());
        let answer = started;
        const token: string | undefined = started?.requestToken;
        for (let i = 0; token && answer?.result?.executionStatus !== "COMPLETED" && i < 6; i++) {
          answer = await fetch(`${BASE}:poll?request-token=${encodeURIComponent(token)}&timeout-seconds=10`,
            { headers: { Accept: "application/json" } }).then((r) => r.json());
        }
        const out = (answer?.result?.output ?? []) as Record<string, unknown>[];
        const logs = (answer?.result?.logs ?? []) as { message?: string }[];
        const alerts = out.flatMap((o) => ((o.raisedAlerts ?? []) as Record<string, unknown>[]).map((a) => ({
          start: ((a.timeframe as { startTime?: string } | undefined)?.startTime) ?? null,
          end: ((a.timeframe as { endTime?: string } | undefined)?.endTime) ?? null,
        })));
        const got: Anomaly = {
          alerted: alerts.length > 0, alerts,
          /* the run says how many series it looked at; none means the query matched nothing,
             which is not the same answer as "nothing is anomalous" */
          analysed: logs.some((l) => /Analyzed [1-9]/.test(l.message ?? "")),
          loading: false, error: null,
        };
        cache.set(key, got);
        return got;
      })();
      inflight.set(key, run);
      run.then((got) => { last.current = got; })
        .catch((e) => { if (live) setError(String((e as Error)?.message ?? e)); })
        .finally(() => { inflight.delete(key); if (live) { setBusy(false); bump((n) => n + 1); } });
    }, 400);
    return () => { clearTimeout(t); live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const answered = key ? cache.get(key) ?? null : null;
  const data = answered ?? last.current ?? NOTHING;
  return { ...data, loading: busy && !answered, error: error ?? data.error };
}
