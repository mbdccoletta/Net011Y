// Did this series change? Asked of the platform, not decided here.
//
// The app had its own detectors: a discard rate "rising" when the recent half of the record
// held more than the earlier half, a level change found by splitting the record at its widest
// gap in means, a trend accepted when a least-squares slope beat its own standard error. Each
// was a judgement this app made about a customer's data with a rule nobody agreed to.
//
// The platform ships that judgement. Measured against this environment, the difference is not
// academic: of the twenty ports with the most discards, the app's own rule called every one of
// them rising, and `NoveltyScoreAnalyzer` finds three — two of which are *decreases*.
//
// Two things about this analyzer that the forecast one does not do, both measured:
//
//  · It answers 202 with a `requestToken` and nothing else. The result comes from a second
//    call, and the token is spelled `request-token` in the query string — `requestToken` there
//    returns 200 with an empty body for ever, which looks exactly like an analysis that never
//    finishes.
//  · `timeout-seconds` on the poll makes it wait server-side, so one poll is usually enough.
import { useEffect, useRef, useState } from "react";
import { FAMILIES, mk } from "../data/formats";


const BASE = "/platform/davis/analyzers/v1/analyzers/dt.statistics.NoveltyScoreAnalyzer";

export interface Novelty {
  /** CHANGE_IN_VALUES, TREND_IN_VALUES, SPIKE … as the platform classifies it */
  type: string;
  /** 0–1, the platform's own confidence that this is a novelty */
  score: number;
  /** its own words for what it saw, e.g. "Plateau of increased values" */
  text: string;
  /** when it says the change happened */
  at: string | null;
}

export interface NoveltyAsk {
  /** one DQL expression per metric family, each grouping by the dimensions below */
  expression: string;
  /** the dimensions that identify a series, in the order the key joins them */
  by: string[];
}

export type NoveltyMap = Map<string, Novelty>;
const cache = new Map<string, NoveltyMap>();

/** the key a caller uses to look a series up: its dimension values, joined */
export const noveltyKey = (...values: (string | undefined | null)[]) => values.map((v) => v ?? "").join("|");

async function askOne(ask: NoveltyAsk, days: number, signal: AbortSignal): Promise<NoveltyMap> {
  const out: NoveltyMap = new Map();
  const started = await fetch(`${BASE}:execute`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeSeriesData: { expression: ask.expression },
      analysisNoveltyType: ["CHANGE_IN_VALUES", "TREND_IN_VALUES"],
      detectionMode: "INCREASE",
      generalParameters: { timeframe: { startTime: `now-${days}d`, endTime: "now" } },
    }),
  }).then((r) => r.json());

  let answer = started;
  const token: string | undefined = started?.requestToken;
  for (let i = 0; token && answer?.result?.executionStatus !== "COMPLETED" && i < 6; i++) {
    answer = await fetch(`${BASE}:poll?request-token=${encodeURIComponent(token)}&timeout-seconds=10`,
      { signal, headers: { Accept: "application/json" } }).then((r) => r.json());
  }
  for (const o of (answer?.result?.output ?? []) as Record<string, unknown>[]) {
    if (o.analysisStatus !== "OK") continue;
    const dims = (o.dimensions ?? []) as { key: string; value: string }[];
    const key = noveltyKey(...ask.by.map((d) => dims.find((x) => x.key === d)?.value));
    const list = (o.novelties ?? []) as Record<string, unknown>[];
    /* the strongest one it found: a series can carry a change and a trend at once, and what a
       reader needs is the headline, not the catalogue */
    const best = list.slice().sort((a, b) => Number(b.noveltyScore ?? 0) - Number(a.noveltyScore ?? 0))[0];
    if (!best) continue;
    const d = best.noveltyDescription as { template?: string } | string | undefined;
    out.set(key, {
      type: String(best.noveltyType ?? "NOVELTY"),
      score: Number(best.noveltyScore ?? 0),
      text: String((typeof d === "string" ? d : d?.template) ?? "changed"),
      at: (best.timeframe as { startTime?: string } | undefined)?.startTime ?? null,
    });
  }
  return out;
}

/**
 * One answer for a set of asks, cached by what was asked.
 *
 * `null` data means the platform has not answered yet, and callers are expected to say so
 * rather than fall back to a rule of their own — a page that substitutes its own detector
 * while the real one is in flight shows two different findings over the same seconds.
 */
export function useNovelty(asks: NoveltyAsk[], days: number): { data: NoveltyMap | null; loading: boolean; error: string | null } {
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* the expressions sorted, so the same set of families asked in another order is the same
     question: the model hands them over in discovery order, which is not stable */
  const key = `${days}|${asks.map((a) => a.expression).sort().join("~")}`;
  /**
   * The last answer the platform gave, kept across questions.
   *
   * The question changes while the estate loads — a family appears the first time a device
   * of that make answers, so the set grows several times over the first half minute — and
   * each new question is a cache miss. Reported as "loading" every time, the causes column
   * fell back to its skeleton again and again in front of the reader. An answer about
   * fewer families is still an answer: it stays on screen while the wider one is in flight,
   * and `loading` now means "nothing has been answered yet", which is the only state that
   * justifies showing a skeleton instead of a list.
   */
  const last = useRef<NoveltyMap | null>(null);

  useEffect(() => {
    if (!asks.length || cache.has(key)) return;
    const ctrl = new AbortController();
    /* one run per burst: the families arrive in a flurry, and each run is a POST plus polls
       against the analyzer — without this the page fired five analyses to answer one */
    /* busy from the moment there is a question, not from the moment the request leaves:
       the skeleton exists so the count of causes is not printed before the analyzer has
       spoken, and during the debounce there is still no answer */
    setBusy(true); setError(null);
    const t = setTimeout(() => {
      Promise.all(asks.map((a) => askOne(a, days, ctrl.signal)))
        .then((maps) => {
          const all: NoveltyMap = new Map();
          for (const m of maps) for (const [k, v] of m) all.set(k, v);
          cache.set(key, all);
          last.current = all;
        })
        .catch((e) => { if (e?.name !== "AbortError") setError(String(e?.message ?? e)); })
        .finally(() => { setBusy(false); bump((n) => n + 1); });
    }, 600);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const answered = cache.get(key) ?? null;
  if (answered && last.current !== answered) last.current = answered;
  const data = answered ?? last.current;
  return { data, loading: busy && !data, error };
}

/**
 * The ports whose discards the platform says are rising.
 *
 * The candidates are a fact, not a judgement: every port that discarded anything over the
 * record, heaviest first, capped at the analyzer's fifty per call. Which of them actually
 * changed is the platform's call, and the fifty are ordered by volume so the cap removes the
 * quietest rather than an arbitrary fifty.
 */
export function useDiscardNovelty(families: string[], days: number) {
  const asks: NoveltyAsk[] = families
    .map((id) => FAMILIES.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => !!f && !!f.ifDiscIn && !!f.ifDiscOut)
    .map((f) => ({
      by: ["device.address", "if.name"],
      expression: `timeseries di = sum(${mk(f, f.ifDiscIn!)}), do = sum(${mk(f, f.ifDiscOut!)}),`
        + ` by:{device.address, if.name}, interval:1h`
        + ` | fieldsAdd d = di[] + do[] | fieldsRemove di, do`
        + ` | filter arraySum(d) > 0 | sort arraySum(d) desc | limit 50`,
    }));
  return useNovelty(asks, days);
}
