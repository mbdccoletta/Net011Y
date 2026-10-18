// The forecast, from Dynatrace rather than from this app.
//
// `fitLine` in model/ahead.ts draws a straight least-squares line. That is the wrong shape for
// this data: measured on a live environment the busy hour concentrates hard (18h UTC holds 26%
// of every port's own peak), so a straight line absorbs the daily cycle as error, the standard
// error inflates, and the gate `slope - 1.96·se > 0` then refuses rises that are real — 41 of
// the 295 subjects on this estate are silent for exactly that reason.
//
// The platform's GenericForecastAnalyzer models the cycle. Asked for the same port, it returns
// a forecast that changes direction fifteen times in twenty-four hours instead of one slope.
//
// Three things cost an hour to find and are worth stating, because none of them fails loudly:
//
//  · The `from:` inside the expression is ignored. The training window comes from
//    `generalParameters.timeframe`, and its default is the last two hours — which is two points
//    at `interval:1h`, below the analyzer's floor of twenty. It answers 200 OK with no output
//    and `scannedBytes: 0`.
//  · `dt.smartscape.ext_network_interface` is typed `smartscape_id`, not string. Comparing it
//    to a literal returns zero rows with no error, in the analyzer and in plain DQL alike. The
//    port has to be selected by `device.address` and `if.name`, which are text.
//  · The fifty-series ceiling this file used to claim is not one. Asked for two hundred memory
//    series it answered a hundred and thirty-six, in the same five seconds the fifty took.
//    What changes above a handful of series is that the analyzer goes asynchronous — see
//    `forecast` below, which is the part that was missing.
import { useEffect, useRef, useState } from "react";
import { FAMILIES, mk } from "../data/formats";
import type { Subject } from "../model/ahead";

/** How far back "recent" reaches when explaining why a forecast could not be made. */
const RECENT_HOURS = 24;

/** the furthest the platform's own rule allows: training must be at least twice the horizon */
/** The analyzer's own ceiling, from its input schema: forecastHorizon maxValue is 600. */
export const MAX_HORIZON = 600;
/**
 * Half the record, and never more than the analyzer accepts.
 *
 * Two of the four callers clamped this to 600 and two did not, which cost nothing while the
 * record was a fortnight — half of 336 is 168. Lengthening the record to sixty days made the
 * unclamped pair ask for 648 and the analyzer answered nothing at all: twenty-six subjects
 * that had forecasts went to zero. The ceiling belongs here, where every caller gets it.
 */
export const horizonFor = (recordHours: number) => Math.min(MAX_HORIZON, Math.max(6, Math.floor(recordHours / 2)));

export interface DavisForecast {
  /** per cent of the subject's own limit, one value per hour of the horizon */
  point: number[];
  lower: number[];
  upper: number[];
  /** what the analyzer thought of its own answer */
  quality: string;
}

export interface Ask {
  /** a port from its octets, a processor from its saturation, memory from what is in use */
  kind?: "port" | "cpu" | "mem";
  address: string;
  ifName: string;
  family: string;
  /** Mbit/s, to turn octets back into per cent of the line rate */
  speed: number;
  recordHours: number;
}

/**
 * What to ask the platform about one subject, or why it cannot be asked.
 *
 * It lived inside the Ahead dashboard's provider, which meant only that dashboard could ask.
 * The census needs the same question for the same subjects, so the question moved here and
 * the provider calls it like everyone else.
 */
export function askForSubject(x: Subject | undefined): { ask: Ask | null; why: string | null } {
  if (!x) return { ask: null, why: "not in the set" };
  const addr = x.device?.ip;
  if (!addr) return { ask: null, why: "its device publishes no address to ask about" };
  if (x.kind === "device" || x.kind === "memory") {
    const what = x.kind === "device" ? "processor" : "memory";
    /* the family that actually supplied this record, not the one its ports came from */
    const fam = (x.kind === "device" ? x.device?.cpuFamily : x.device?.memFamily)
      ?? x.device?.interfaces.find((i) => i.family)?.family;
    if (!fam) return { ask: null, why: `no extension is identified on this device, so its ${what} metric cannot be named` };
    return { ask: { kind: x.kind === "device" ? "cpu" : "mem", address: addr, ifName: "",
      family: fam, speed: 0, recordHours: x.reading.hist.length }, why: null };
  }
  const name = x.iface?.name, fam = x.iface?.family, sp = x.iface?.speed;
  if (!name || !fam) return { ask: null, why: "no extension is identified on this port" };
  if (!sp || sp <= 0) return { ask: null, why: "it publishes no line rate, so octets cannot be read as per cent of one" };
  return { ask: { kind: "port", address: addr, ifName: name, family: fam, speed: sp,
    recordHours: x.reading.hist.length }, why: null };
}

const ANALYZER = "/platform/davis/analyzers/v1/analyzers/dt.statistics.GenericForecastAnalyzer";
const ENDPOINT = `${ANALYZER}:execute`;
const cache = new Map<string, DavisForecast | null>();

/**
 * One forecast request, waited out.
 *
 * `:execute` answers 202 with a `requestToken` as soon as the batch is more than a few series,
 * and the trap is that the 202 is not empty — it already carries `result.output`. Measured on
 * this environment: a call for sixty memory series came back holding **six** of them, with
 * `executionStatus: "RUNNING"`. Reading that reply and walking away, which is what every
 * forecast in this file used to do, draws six curves and presents them as the estate. Seven
 * polls and thirty-three seconds later the same request holds all sixty, 57 of them OK.
 *
 * So the fifty-series cap on the ranking was never the analyzer refusing work — it was the
 * size at which the analyzer goes asynchronous and this app stopped listening.
 *
 * Two details, each of which fails silently rather than loudly:
 *
 *  · the token is spelled `request-token` in the query string, as it is for the novelty
 *    analyzer — `requestToken` there answers 200 with an empty body for ever;
 *  · every poll mints a *new* token, so the loop follows it instead of resending the first.
 *
 * `timeout-seconds` makes the server hold the connection until it has something to say, so
 * this waits in a handful of polls rather than spinning.
 */
async function forecast(body: unknown, signal: AbortSignal): Promise<any> {
  let j = await fetch(ENDPOINT, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  let token: string | undefined = j?.requestToken;
  /* Twenty ten-second waits is a bound, not a deadline: the loop leaves the moment the
     analyzer says COMPLETED, and whatever partial output it holds is still worth drawing if
     it never does — a subject with no curve says "not analysed", which is true either way. */
  for (let i = 0; token && j?.result?.executionStatus !== "COMPLETED" && i < 20; i++) {
    j = await fetch(`${ANALYZER}:poll?request-token=${encodeURIComponent(token)}&timeout-seconds=10`,
      { signal, headers: { Accept: "application/json" } }).then((r) => r.json());
    token = j?.requestToken ?? token;
  }
  return j;
}

/** the metric the family reports octets on, quoted when its prefix needs it */
function octetKeys(family: string): [string, string] | null {
  const f = FAMILIES.find((x) => x.id === family);
  if (!f || !f.ifIn || !f.ifOut) return null;
  return [mk(f, f.ifIn), mk(f, f.ifOut)];
}

const cacheMany = new Map<string, Map<string, DavisForecast>>();
/**
 * What identifies one answer, and why the kind is in it.
 *
 * A processor and a memory are both asked about by `device.address` alone, so both carry an
 * empty `ifName` and the two used to collide on `addr|` — the second answer silently replaced
 * the first. It never showed while the page asked about fifty subjects that happened to be all
 * memory; asking about the whole estate makes every device with both a processor and a memory
 * reading wrong by exactly one of them.
 */
export const portKey = (a: { kind?: Ask["kind"]; address: string; ifName: string }) =>
  `${a.kind ?? "port"}|${a.address}|${a.ifName}`;

/**
 * Several ports, one call each family.
 *
 * The card above this hook used to draw one subject at a time, because the single-port hook
 * asks for one port at a time. A capacity reader is not comparing a port with nothing: what
 * they need on screen is the handful with the least room, each with its own record and its own
 * forecast, so the one that moves stands out against the ones that do not.
 *
 * The analyzer already answers several series at once — it is how the site card is drawn — so
 * this asks for the whole handful in one request per metric family, which is one request on
 * nearly every estate. The ports are selected by `device.address` and `if.name` for the reason
 * at the top of this file, and each one's octets are divided by its own line rate, so the
 * series arrive in the unit the card is drawn in: per cent of each one's own limit.
 */
/**
 * How many subjects fit in one expression, by kind.
 *
 * Not a performance tuning. The analyzer refuses an expression with more than two hundred and
 * fifty sub-expressions, and a port costs three of them — `(address == "x" and name == "y")` —
 * so fifty ports is already over the line and comes back as `SEVERE: The expression contains
 * too many nested sub-expressions`, with no output and nothing else to say what happened. A
 * processor or a memory costs one, so they fit in far larger batches.
 *
 * The budget is not one per subject. A comparison costs two — the field and the literal — and
 * each `or` costs one, so a batch of n devices is 3n − 1 and the ceiling lands just under
 * eighty-four. Measured: chunks of a hundred came back OK with no output at all, and the page
 * showed 69 of 169 processors and 35 of 135 memories — the two missing hundreds being exactly
 * the first chunk of each. A port costs one more again, for the `and` that joins its address
 * to its name.
 *
 * Sixty and thirty, then, with room to spare, because the failure is silent: the analyzer
 * answers 200 with an empty output and a log line nothing on this page reads.
 */
const CHUNK = { port: 30, cpu: 60, mem: 60 } as const;
const chunk = <T,>(list: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/**
 * One expression per kind and family, from a set of asks.
 *
 * A port is forecast from its octets, a processor from its saturation and memory from what is
 * in use — three shapes, and the same three whether the question is "where is this going" or
 * "did this change". They were written once inside the forecast hook; the census asks the
 * novelty analyzer about the same subjects, and two copies of a DQL builder is how this app
 * ended up with two definitions of a discarding port.
 */
export function expressionsFor(asks: Ask[]): { sort: string; by: string[]; expression: string }[] {
  const esc = (v: string) => v.replace(/"/g, '\\"');
  const byFamily = new Map<string, Ask[]>();
  for (const a of asks) {
    const g = `${a.kind ?? "port"}|${a.family}`;
    byFamily.set(g, [...(byFamily.get(g) ?? []), a]);
  }
  const out: { sort: string; by: string[]; expression: string }[] = [];
  for (const [group, all] of byFamily) {
  for (const ports of chunk(all, CHUNK[group.split("|")[0] as keyof typeof CHUNK] ?? CHUNK.port)) {
    const [sort, family] = group.split("|");
    const f = FAMILIES.find((x) => x.id === family);
    const where = ports.map((a) => `device.address == "${esc(a.address)}"`).join(" or ");
    /* memory comes two ways, as everywhere else in this app: a family that publishes a
       percentage, and one that publishes used and total (or used and free) to divide */
    const memExpr = f?.memPct
      ? `timeseries m = avg(${mk(f, f.memPct)}), by:{device.address}, interval:1h | filter ${where} | limit ${ports.length}`
      : f?.memUsed && (f.memTotal || f.memFree)
        ? `timeseries u = avg(${mk(f, f.memUsed)}), t = avg(${mk(f, (f.memTotal ?? f.memFree)!)}),`
          + ` by:{device.address}, interval:1h | filter ${where}`
          + ` | fieldsAdd m = 100 * u[] / ${f.memTotal ? "t[]" : "(u[] + t[])"} | fieldsRemove u, t | limit ${ports.length}`
        : null;
    const portExpr = (() => {
      const keys = octetKeys(family);
      if (!keys) return null;
      const pw = ports.map((a) => `(device.address == "${esc(a.address)}" and if.name == "${esc(a.ifName)}")`).join(" or ");
      return `timeseries i = sum(${keys[0]}), o = sum(${keys[1]}),`
        + ` by:{device.address, if.name}, interval:1h`
        + ` | filter ${pw}`
        + ` | fieldsAdd b = i[] + o[] | fieldsRemove i, o | limit ${ports.length}`;
    })();
    const expression = sort === "mem" ? memExpr
      : sort === "cpu"
        ? (f?.cpu ? `timeseries c = avg(${mk(f, f.cpu)}), by:{device.address}, interval:1h | filter ${where} | limit ${ports.length}` : null)
        : portExpr;
    if (expression) out.push({ sort, by: sort === "port" ? ["device.address", "if.name"] : ["device.address"], expression });
  }
  }
  return out;
}

export function usePortsForecast(asks: Ask[]): { data: Map<string, DavisForecast>; loading: boolean; error: string | null } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = asks.filter((a) => a.kind !== "port" || a.speed > 0);
  const key = list.map(portKey).sort().join(";");

  useEffect(() => {
    if (!list.length || cacheMany.has(key)) return;
    const ctrl = new AbortController();
    /**
     * The training window is the longest record in the batch, not the shortest.
     *
     * `Math.min` was right while the batch was fifty subjects picked for being tight — they
     * all had the same fortnight. Over the whole estate it is the bug that empties the card:
     * one subject that started reporting this morning drags the window to two days, the
     * analyzer gets two points at `interval:1h` for every other series in the call, and it
     * answers OK with no output. Measured here: 230 of 430 subjects came back, and the
     * hundred memories above eighty per cent — the only ones the page is about — were among
     * the missing, while the same expression asked on its own answered both in full.
     *
     * A subject with a short record simply has fewer points inside the window, which the
     * analyzer already handles by declining that one series rather than the batch.
     */
    const hours = Math.max(...list.map((a) => a.recordHours));
    const built = expressionsFor(list);
    setLoading(true); setError(null);
    Promise.all(built.map(({ sort, expression }) => {
      /* the answer carries which question it answers: a processor's record and a memory
         record are both grouped by the device alone, so nothing in the reply distinguishes
         them */
      return forecast({
        timeSeriesData: { expression },
        forecastHorizon: horizonFor(hours), forecastOffset: 1,
        generalParameters: { timeframe: { startTime: `now-${Math.max(2, Math.round(hours / 24))}d`, endTime: "now" } },
      }, ctrl.signal).then((json) => ({ sort, json }));
    }))
      .then((answers) => {
        const out = new Map<string, DavisForecast>();
        let why: string | null = null;
        for (const answer of answers) {
          if (!answer) continue;
          const { sort, json: j } = answer;
          why = why ?? j?.result?.logs?.[0]?.message ?? null;
          for (const o of (j?.result?.output ?? []) as Record<string, unknown>[]) {
            if (o.analysisStatus !== "OK") continue;
            const rec = (o.timeSeriesDataWithPredictions as { records?: Record<string, unknown>[] })?.records?.[0];
            if (!rec) continue;
            const addr = String(rec["device.address"] ?? ""), nm = String(rec["if.name"] ?? "");
            /* a cpu answer and a memory answer are both grouped by the device alone, so the
               record carries no if.name and the kind has to come from which call it was */
            const kind = sort === "mem" ? "mem" : sort === "cpu" ? "cpu" : "port";
            const ask = list.find((a) => a.address === addr && (a.kind ?? "port") === kind
              && (kind === "port" ? a.ifName === nm : true));
            if (!ask) continue;
            // octets an hour become per cent of the line rate; a processor already is one
            const bits = ask.speed * 1e6 * 3600;
            const pct = (arr: unknown): number[] => (Array.isArray(arr) ? arr : [])
              .filter((v): v is number => typeof v === "number")
              .map((v) => (ask.kind === "port" ? Math.round((v * 8 / bits) * 1000) / 10 : Math.round(v * 10) / 10));
            out.set(portKey(ask), {
              point: pct(rec["dt.davis.forecast:point"]),
              lower: pct(rec["dt.davis.forecast:lower"]),
              upper: pct(rec["dt.davis.forecast:upper"]),
              quality: String((o.forecastQualityAssessment as string) ?? "UNKNOWN"),
            });
          }
        }
        cacheMany.set(key, out);
        if (!out.size) setError(why ?? "the forecast analyzer returned nothing for these ports");
      })
      .catch((e) => { if (e?.name !== "AbortError") setError(String(e?.message ?? e)); })
      .finally(() => { setLoading(false); bump((n) => n + 1); });
    return () => ctrl.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data: cacheMany.get(key) ?? new Map(), loading, error };
}

export function useDavisForecast(ask: Ask | null): { data: DavisForecast | null; loading: boolean; error: string | null } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const key = ask ? `${ask.family}|${ask.address}|${ask.ifName}|${ask.recordHours}` : "";

  useEffect(() => {
    if (!ask || !key || cache.has(key)) return;
    const keys = octetKeys(ask.family);
    if (!keys) { cache.set(key, null); return; }
    const ctrl = new AbortController();
    abort.current?.abort();
    abort.current = ctrl;
    setLoading(true);
    setError(null);
    const esc = (v: string) => v.replace(/"/g, '\\"');
    /**
     * One measure, not two.
     *
     * Asking for `i` and `o` as separate measures makes the analyzer return *two* outputs, one
     * forecast each — and reading only the first forecast the inbound octets while the chart's
     * measured line is inbound plus outbound. On screen that was a line at seventy per cent
     * and a forecast at five, with a gap between them.
     *
     * `sum(a) + sum(b)` is rejected inside `timeseries`, so the two arrays are added after it
     * and the parts removed. The analyzer then sees a single series and returns a single band,
     * which is also the right statistics: the band of a sum is not the sum of two bands.
     */
    const expression = `timeseries i = sum(${keys[0]}), o = sum(${keys[1]}),`
      + ` by:{device.address, if.name}, interval:1h`
      + ` | filter device.address == "${esc(ask.address)}" and if.name == "${esc(ask.ifName)}"`
      + ` | fieldsAdd b = i[] + o[] | fieldsRemove i, o | limit 1`;
    forecast({
      timeSeriesData: { expression },
      forecastHorizon: horizonFor(ask.recordHours),
      forecastOffset: 1,
      generalParameters: { timeframe: { startTime: `now-${Math.max(2, Math.round(ask.recordHours / 24))}d`, endTime: "now" } },
    }, ctrl.signal)
      .then((j) => {
        const out = j?.result?.output?.[0];
        const rec = out?.timeSeriesDataWithPredictions?.records?.[0];
        if (!rec || out?.analysisStatus !== "OK") {
          cache.set(key, null);
          setError(j?.result?.logs?.[0]?.message ?? "the forecast analyzer returned nothing for this subject");
          return;
        }
        // octets an hour back to per cent of the line rate, the same conversion the record used
        const bits = ask.speed * 1e6 * 3600;
        const pct = (arr: unknown): number[] => (Array.isArray(arr) ? arr : [])
          .filter((v): v is number => typeof v === "number")
          .map((v) => Math.round((v * 8 / bits) * 1000) / 10);
        cache.set(key, {
          point: pct(rec["dt.davis.forecast:point"]),
          lower: pct(rec["dt.davis.forecast:lower"]),
          upper: pct(rec["dt.davis.forecast:upper"]),
          quality: out?.forecastQualityAssessment ?? "UNKNOWN",
        });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        cache.set(key, null);
        setError(String((e as { message?: string })?.message ?? e));
      })
      .finally(() => { if (!ctrl.signal.aborted) { setLoading(false); bump((n) => n + 1); } });
    return () => ctrl.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data: key ? cache.get(key) ?? null : null, loading, error };
}


/**
 * The whole network's demand, forecast by Dynatrace.
 *
 * Everything else on this page measures a subject against a limit its owner stated, and on this
 * estate none of them is near one. The estate's own total has no limit to cross — nobody runs
 * every access port at line rate at once, so the sum of the line rates is a capacity that does
 * not exist, which is why the two per-site cards read 0–3% and say nothing. Absolute demand has
 * no such denominator: it is bytes an hour, it is what a capacity plan is actually built on,
 * and it is the one forecast here that is never empty.
 *
 * It is also the one that needs no resampling. The per-subject chart plots a day's busy hour
 * and has to summarise 24 forecast hours into one, which understates a peak — the maximum of
 * expectations is not the expectation of a maximum. Drawn hour against hour, that error does
 * not arise.
 *
 * Measured on a live environment: 168 hours ahead in 2.5 s, quality VALID, and the forecast
 * changes direction 22 times in its first 48 hours, which is the daily cycle a straight line
 * cannot have.
 */
export interface NetworkDemand {
  /** bits per second, one value per hour, oldest first */
  history: number[];
  point: number[];
  lower: number[];
  upper: number[];
  quality: string;
}

const cacheDemand = new Map<string, NetworkDemand | null>();

export function useNetworkDemand(families: string[], hours: number): { data: NetworkDemand | null; loading: boolean; error: string | null } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `demand|${families.slice().sort().join(",")}|${Math.round(hours / 24)}`;

  useEffect(() => {
    if (!families.length || cacheDemand.has(key)) return;
    const parts = families.map((id) => FAMILIES.find((f) => f.id === id))
      .filter((f): f is NonNullable<typeof f> => !!f && !!f.ifIn && !!f.ifOut);
    if (!parts.length) { cacheDemand.set(key, null); return; }
    // one measure per family, added together: an estate is rarely one vendor
    const ins = parts.map((f) => `sum(${mk(f, f.ifIn!)})`).join(" , i");
    void ins;
    const measures = parts.map((f, k) => `a${k} = sum(${mk(f, f.ifIn!)}), b${k} = sum(${mk(f, f.ifOut!)})`).join(", ");
    const total = parts.map((_, k) => `a${k}[] + b${k}[]`).join(" + ");
    const drop = parts.flatMap((_, k) => [`a${k}`, `b${k}`]).join(", ");
    const expression = `timeseries ${measures}, interval:1h | fieldsAdd total = ${total} | fieldsRemove ${drop}`;
    const days = Math.max(2, Math.round(hours / 24));
    const ctrl = new AbortController();
    setLoading(true); setError(null);
    Promise.all([
      fetch("/platform/storage/query/v1/query:execute", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: expression.replace("interval:1h", `from:now()-${days}d, interval:1h`),
          maxResultRecords: 2, requestTimeoutMilliseconds: 20000 }),
      }).then((r) => r.json()),
      forecast({ timeSeriesData: { expression },
        forecastHorizon: horizonFor(hours),
        forecastOffset: 1,
        generalParameters: { timeframe: { startTime: `now-${days}d`, endTime: "now" } } }, ctrl.signal),
    ])
      .then(([h, j]) => {
        const out = j?.result?.output?.[0];
        const rec = out?.timeSeriesDataWithPredictions?.records?.[0];
        if (!rec || out?.analysisStatus !== "OK") {
          cacheDemand.set(key, null);
          /**
           * Why it failed, when the record itself says why.
           *
           * The analyzer answers `analysisStatus: FAILED` with an empty log for the one case
           * that happens most on a real estate: the series does not reach the present. Proved
           * on this environment after it had been deactivated for a few hours — the same
           * expression over `now-13d .. now` came back FAILED and over `now-13d .. now-2d`
           * came back OK, the only difference being the empty hours at the end. "The forecast
           * analyzer returned nothing" sent the reader looking for a fault in the app; the
           * number of hours missing from the end of their own record is the answer, and it is
           * already in the history this call fetched beside the forecast.
           */
          const hist = (h?.result?.records?.[0]?.total ?? []) as (number | null)[];
          /* Not only a gap at the very end: measured here, the hole was thirteen hours sitting
             three hours short of now, and the series resumed before the last bucket. What the
             analyzer cannot work with is a hole among the recent hours, wherever it stops. */
            const recent = hist.slice(-RECENT_HOURS);
          const holes = recent.filter((v) => v == null).length;
          setError(j?.result?.logs?.[0]?.message
            ?? (holes > 0
              ? `the record has ${holes} empty ${holes === 1 ? "hour" : "hours"} in its last ${recent.length}, and the forecast needs an unbroken run up to now — it returns once the ports have been polled through those hours`
              : "the forecast analyzer returned nothing for the estate"));
          return;
        }
        // octets in an hour to bits per second, which is how a network engineer reads demand
        const bps = (arr: unknown): number[] => (Array.isArray(arr) ? arr : [])
          .filter((v): v is number => typeof v === "number").map((v) => (v * 8) / 3600);
        cacheDemand.set(key, {
          history: bps(h?.result?.records?.[0]?.total),
          point: bps(rec["dt.davis.forecast:point"]),
          lower: bps(rec["dt.davis.forecast:lower"]),
          upper: bps(rec["dt.davis.forecast:upper"]),
          quality: out?.forecastQualityAssessment ?? "UNKNOWN",
        });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        cacheDemand.set(key, null);
        setError(String((e as { message?: string })?.message ?? e));
      })
      .finally(() => { if (!ctrl.signal.aborted) { setLoading(false); bump((n) => n + 1); } });
    return () => ctrl.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data: cacheDemand.get(key) ?? null, loading, error };
}



/**
 * Demand per site, forecast by Dynatrace, in the same absolute unit as the estate's.
 *
 * This replaces the two cards that measured a site against the sum of its ports' line rates —
 * a capacity nobody carries, which is why every cell of them read between zero and three per
 * cent and the "reaches 85%" line was never touched. A site has no stated limit, so the honest
 * reading is the same one the estate gets: how much it is carrying, and where that is going.
 *
 * One call covers every site: the hourly metric carries `primary_tags.site`, and an estate has
 * nine or twelve of them, far below the analyzer's fifty-series ceiling. The analyzer returns
 * one output per series, so each is matched back to its site by the dimension it carries.
 */
export interface SiteDemand {
  site: string;
  history: number[];
  point: number[];
  lower: number[];
  upper: number[];
  quality: string;
  /** the highest the forecast goes, or 0 where the analyzer had nothing to say */
  peak: number;
  /** the last measured hour, in bits per second */
  now: number;
  /** the busiest hour of the record — what the site carries when it is working hardest */
  busy: number;
}

const cacheSites = new Map<string, SiteDemand[] | null>();

export function useSiteDemand(families: string[], hours: number): { data: SiteDemand[] | null; loading: boolean; error: string | null } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `sites|${families.slice().sort().join(",")}|${Math.round(hours / 24)}`;

  useEffect(() => {
    if (!families.length || cacheSites.has(key)) return;
    const parts = families.map((id) => FAMILIES.find((f) => f.id === id))
      .filter((f): f is NonNullable<typeof f> => !!f && !!f.ifIn && !!f.ifOut);
    if (!parts.length) { cacheSites.set(key, null); return; }
    const measures = parts.map((f, k) => `a${k} = sum(${mk(f, f.ifIn!)}), b${k} = sum(${mk(f, f.ifOut!)})`).join(", ");
    const total = parts.map((_, k) => `a${k}[] + b${k}[]`).join(" + ");
    const drop = parts.flatMap((_, k) => [`a${k}`, `b${k}`]).join(", ");
    const SITE = "`primary_tags.site`";
    const expression = `timeseries ${measures}, by:{${SITE}}, interval:1h`
      + ` | fieldsAdd total = ${total} | fieldsRemove ${drop} | filter isNotNull(${SITE}) | limit 40`;
    const days = Math.max(2, Math.round(hours / 24));
    const ctrl = new AbortController();
    setLoading(true); setError(null);
    Promise.all([
      fetch("/platform/storage/query/v1/query:execute", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: expression.replace("interval:1h", `from:now()-${days}d, interval:1h`),
          maxResultRecords: 40, requestTimeoutMilliseconds: 25000 }),
      }).then((r) => r.json()),
      forecast({ timeSeriesData: { expression },
        forecastHorizon: horizonFor(hours), forecastOffset: 1,
        generalParameters: { timeframe: { startTime: `now-${days}d`, endTime: "now" } } }, ctrl.signal),
    ])
      .then(([h, j]) => {
        const bps = (arr: unknown): number[] => (Array.isArray(arr) ? arr : [])
          .filter((v): v is number => typeof v === "number").map((v) => (v * 8) / 3600);
        const hist = new Map<string, number[]>();
        for (const r of (h?.result?.records ?? []) as Record<string, unknown>[]) {
          const site = String(r["primary_tags.site"] ?? "");
          if (site) hist.set(site, bps(r.total));
        }
        /**
         * Every site that reported, not only the ones the analyzer accepted.
         *
         * This started from the analyzer's output, so a site whose ports hold too little
         * hourly record vanished entirely — four of thirteen survived here, and the card that
         * drew them could account for five per cent of the estate it sat under. What a site
         * carries is measured and needs no analyzer; only where it is going does. So the list
         * is the measurement, and the forecast is attached where there is one.
         */
        const fc = new Map<string, { point: number[]; lower: number[]; upper: number[]; quality: string }>();
        for (const o of (j?.result?.output ?? []) as Record<string, unknown>[]) {
          if (o.analysisStatus !== "OK") continue;
          const rec = (o.timeSeriesDataWithPredictions as { records?: Record<string, unknown>[] })?.records?.[0];
          const site = String(rec?.["primary_tags.site"] ?? "");
          if (!rec || !site) continue;
          fc.set(site, { point: bps(rec["dt.davis.forecast:point"]), lower: bps(rec["dt.davis.forecast:lower"]),
            upper: bps(rec["dt.davis.forecast:upper"]), quality: String(o.forecastQualityAssessment ?? "UNKNOWN") });
        }
        const out: SiteDemand[] = [];
        for (const [site, history] of hist) {
          const f = fc.get(site);
          out.push({ site, history, point: f?.point ?? [], lower: f?.lower ?? [], upper: f?.upper ?? [],
            quality: f?.quality ?? "NONE", peak: f?.point.length ? Math.max(...f.point) : 0,
            now: history.length ? history[history.length - 1] : 0,
            busy: history.length ? Math.max(...history) : 0 });
        }
        if (!out.length) setError(j?.result?.logs?.[0]?.message ?? "no site reported an hourly record");
        // heaviest first, by what it carries rather than by what was forecast for it
        cacheSites.set(key, out.sort((a, b) => b.busy - a.busy));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        cacheSites.set(key, null);
        setError(String((e as { message?: string })?.message ?? e));
      })
      .finally(() => { if (!ctrl.signal.aborted) { setLoading(false); bump((n) => n + 1); } });
    return () => ctrl.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data: cacheSites.get(key) ?? null, loading, error };
}
