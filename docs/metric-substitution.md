# Replacing scans with metrics

Grail charges a log or event query for every byte it scans and charges nothing for a metric query.
This is the per-read analysis of which of NetO11y's paid reads a metric can answer, what each one
costs today, what the substitution would cost in correctness, and where the line is.

Nothing here is estimated. Every figure was measured on two live environments in October 2026:

* **eob14444** — about 4.4 million NetFlow records an hour through the OpenTelemetry collector and
  1.7 million syslog and trap records every six hours; no OneAgent network flows.
* **guu84124** — OneAgent network flows (2.1 million events a day), light syslog, no NetFlow.

Cost and latency come from the tenants' own `dt.system.query_executions` and `BILLING_USAGE_EVENT`
records, over the app's real traffic. Cardinality comes from running the grouping of each proposed
metric against the live stream.

## What a read costs today

The app makes 100 queries. Seventy-four are metric queries and five read Smartscape; those are
included and cost nothing. Fifteen are billed. On eob14444, at the 90th percentile:

| Read | What it is | Window | Scanned | Server time |
|---|---|---|---|---|
| `flowTs` | flows and bytes per exporter, 5-minute buckets | 70 min | 10.25 GB | 3.0 s |
| `flowNets` | conversations by /24 and port, heaviest first | 1 h | 8.85 GB | 6.6 s |
| `flowFanIn` | distinct sources reaching one range | 1 h | 8.83 GB | 5.0 s |
| `netChanges` | config changes and link flaps per device | 6 h | 5.35 GB | 2.6 s |
| `deviceLogs` | syslog and trap counts per device and level | 6 h | 5.35 GB | 2.9 s |
| `deviceLogsRecent` | the latest records themselves | 3 h | 0.34 GB | 0.2 s |
| `neighbors` | CDP/LLDP pairs | 20 min | 0.14 GB | 0.06 s |
| `sessions`, `sessionsTypical`, `sessionNets` | user sessions | 24 h / 7 d | ~0 GB | 0.04–0.4 s |
| `appPaths`, `appNet`, `appNetBy`, `cloud`, `cloudTop` | OneAgent flows | 1–24 h | 0 GB here, 10.4 GB on guu84124 | — |

A session that opens the map and the traffic page scans about 39 GB on eob14444 and 11 GB on
guu84124. The three slowest reads in the app are the three most expensive ones, which is not a
coincidence: both numbers are the same scan.

## What a metric can and cannot answer

A metric is a number per dimension tuple per bucket. Four things decide whether a read can become
one.

1. **Is it an aggregation?** A count, a sum or a maximum over a stream is a metric. A list of
   records is not, and neither is a top-N over something that churns.
2. **How many series?** A metric with a few hundred series is free and instant. One that mints
   tens of thousands of new series an hour is a cardinality problem the environment pays for in
   ingest, which is the opposite of the point.
3. **Can the aggregation be recomputed from buckets?** Sums and counts add up across buckets.
   `countDistinct` does not: the distinct hosts of six one-hour buckets are not the distinct hosts
   of the six hours. A percentile does not either, unless the metric stores a distribution.
4. **Does the rule see what the query sees?** The extraction filter has to match the query's
   filter exactly, or the two answers differ and nobody notices which is right.

### Measured, per read

| Read | Aggregation? | Proposed dimensions | Series, measured | Verdict |
|---|---|---|---|---|
| `deviceLogs` | `count()` by device, kind, level | ip, kind, loglevel | **207** in 6 h | **substitute** |
| `flowTs` | `count()`, `sum(bytes)` by exporter | exp | **3** in 70 min | **substitute** |
| `netChanges` | `count()` **and `max(timestamp)`** | fac, mnem, ip, iface | **606** in 6 h | partial — see below |
| `flowNets` | top-N `sum(bytes)` | exp, s24, d24, proto, port | **59,929 in one hour** | keep (sampling tested and refused) |
| `flowFanIn` | `countDistinct(source)` | — | not recomputable | keep |
| `appPaths` | `sum()` by group, remote /24, port | grp, server, r24, port | **5,256 in one hour** | keep |
| `appNet` | sums and `percentile(rtt, 90)` | none (one series) | 1 | partial — percentile |
| `appNetBy` | same, by host group | grp | small | partial — percentile |
| `cloud` | sums **and two `countDistinct`** | cluster, provider | **5** | partial |
| `cloudTop` | top-N sums by host and destination | host, cluster, dst, port | **127,486 in 24 h** | keep |
| `deviceLogsRecent`, `neighbors` | record lists | — | — | keep |
| `sessions*` | already free in practice | — | — | keep |

The two clean substitutions are the two biggest log reads on this environment: 15.6 GB of a 39 GB
session, and 5.9 seconds of its wall clock.

`netChanges` is the interesting near-miss. Its counts are 606 series — perfectly cheap — but it also
returns `max(timestamp)` per group, which the panel shows as "last seen". From a metric that
becomes "the last bucket with a number in it", which is a fifteen-minute answer to a question the
reader asks in minutes. It is substitutable the day the panel accepts bucket resolution, and not
before.

`cloud` and `appNet` are the same shape of near-miss: their sums are metric-able and their
`countDistinct` and `percentile(rtt, 90)` are not. Splitting a read so that half comes from a metric
and half from a scan costs two round trips and still scans the window, so it saves nothing.

## The three ways this breaks consistency, and what is done about each

**A rule has no past.** Metric extraction produces nothing for the time before it was created. A
rule made this morning answers a six-hour question with one hour of data and five hours of silence —
and silence in this app is a statement: "that device logged nothing". The app therefore asks, for
each candidate, whether the metric reaches the oldest bucket of the window the log form would read;
anything other than a clear yes keeps the log form. The probe is itself a metric query, so the check
costs nothing, and the read turns itself over once the metric is as old as the window.

**A rule can see something different from the query.** The extraction filter must be the same filter
the log query uses, including the two roads syslog travels (`dt.openpipeline.source` and
`custom.openpipeline.source`) and the trap source. Settings states the rule in full for each read
still being paid for — pipeline, key, measure, dimensions — rather than offering a setting, because
there is nothing to set in the app: define the rule and the app changes its own behaviour.

**An aggregation can look right and be wrong.** `countDistinct` and percentiles are not recomputable
from buckets. No read whose answer depends on one is substituted, whatever it would save.

## What the platform's own guidance adds

The developer documentation names four levers for a log query — `filter`, `scanLimit`,
`samplingRatio`, `limit` — and the app was using one of them.

**Sampling is the lever this analysis missed.** `fetch logs, samplingRatio: 100` reads one record in
a hundred. Measured on eob14444, the same NetFlow question over the same hour:

| | Scanned | Records | Server time |
|---|---|---|---|
| Unsampled | 8.17 GB | 9,016,985 | 1,044 ms |
| `samplingRatio: 100` | **0.09 GB** | 184,319 | **206 ms** |

Ninety-nine per cent of the cost and eighty per cent of the time, for an answer that is no longer
exact: the result is **not** scaled back up — 4,446,447 flows became 44,103 — so the app has to
multiply by the ratio and say that it did.

That argument was written, implemented, and then tested — and the test refused it. It is kept here
because the refutation is the useful part.

**The experiment.** The same hour of NetFlow, the top conversations by bytes, run both ways:

| Pair | Full | Sampled ×100 | Error |
|---|---|---|---|
| 138.118.0.0 → 200.229.251.0 | 1.29 GB | 8.85 GB | +587% |
| 10.175.5.0 → 13.107.228.0 | 3.21 GB | 5.35 GB | +67% |
| six others in the sampled top eight | not in the real top ten | — | — |

**Two of the eight heaviest conversations survived sampling.** Not because the ratio is too coarse,
but because the quantity is wrong for it: forty-two thousand pairs share four million records, so a
pair holding a few hundred of them is estimated from two or three, and bytes are dominated by a few
large flows that the sample either catches or misses entirely.

Per exporter — three groups instead of forty-two thousand — it looks better, and still fails in the
same place:

| Exporter | Flows, full | Flows, estimated | Bytes, full | Bytes, estimated |
|---|---|---|---|---|
| 10.175.7.101 | 1,830,130 | 1,804,700 (−1.4%) | 94.84 GB | 98.53 GB (+3.9%) |
| 10.175.5.62 | 3,319,397 | 3,288,500 (−0.9%) | 79.09 GB | 81.63 GB (+3.2%) |
| 10.1.20.130 | 70,701 | 68,200 (−3.5%) | 3.11 GB | **0.23 GB (−92.6%)** |

So the rule sampling actually obeys here is not "volume questions are fine". It is:

* a **count** over a large population survives (±1–3.5% in every row above);
* a **sum of a skewed quantity** does not, unless the group is enormous — the third exporter's
  bytes were out by ninety-two per cent on seventy thousand records;
* a **top-N over many groups** does not survive at all;
* a **`countDistinct`** cannot be sampled by definition: a hundredth of the records holds a
  hundredth of the distinct values.

Every number this app shows from NetFlow is bytes — bandwidth is the question the page asks — so
sampling is not used. The implementation was written and removed. It is the right lever for a
different app, and the measurement above is what decides which one you have.

**The scan limit is set to a number that is not a limit.** *(recommended, not implemented)* Every query is sent with
`defaultScanLimitGbytes: 1500`, which on any real environment means "no guard". Its purpose is to
turn a pathological environment into a clear failure instead of a silent bill, and a limit
proportional to what each read should scan would do that.

**Stale-while-revalidate is already in `useDql`, and the app is on the conservative side of it.**
The documentation suggests 15–30 seconds of `staleTime` for logs and 30–60 for metrics; the app uses
five minutes for everything, which costs less and risks only staleness that the clock in the header
and the Refresh button already disclose. Nothing to change, but worth stating: a future page that
lowers it is choosing to pay for it.

**App state can carry a time-to-live.** *(recommended, not implemented)* `setAppState` takes `validUntilTime`, and the platform's own
guide uses it to cache expensive responses. The app's incremental log cache went from the browser to
memory-for-this-session two days ago, which was right about the browser and lost the saving across
sessions; user app state with a TTL would give it back without writing anything into the browser and
without sharing one reader's records with another.

## What is implemented

`deviceLogs` and `flowTs` carry a metric form (0.1.80, with the coverage guard in this change). At
load the app asks the metric catalogue once — a metric query, free — for the keys it knows how to
use; where a key exists and covers the window, the metric form runs in place of the log form. Both
forms return the same records under the same names, which was verified against both on a live
environment: dimensions, an array per measure, a timeframe and an interval. Nothing downstream knows
which one ran, and a read served by a metric is no longer counted as a log read in the load meter.

A substitutable read waits for the catalogue rather than racing it. Paying for the scan and then
discovering the metric was there is the one outcome this mechanism exists to prevent.

## What it saves, measured

On eob14444, with both rules in place and covering their windows:

| | Scanned per session | Query cost per session | Slowest read |
|---|---|---|---|
| Today | 39.1 GB | US$ 0.127 | 6.6 s |
| With the two metrics | 23.5 GB | US$ 0.077 | 6.6 s |
| With the metrics and the network log buckets named | ~7 GB | US$ 0.023 | ~2 s |

The bucket list is the other half and needs no code: 52% of that environment's log volume in the
last hour was `otelcol/netflowreceiver`, and the app's log queries there carry no bucket filter, so
every flow read also scans the 48% that is not flow.

At a hundred people opening the app once a working day, the three rows above are about US$ 280,
US$ 169 and US$ 50 a month. For comparison, one Assist question costs US$ 0.30 — three AI units,
measured — so twenty-five questions a day cost more than all the scanning in either column.

## Where this leaves the app

| Lever | Status | Measured effect on eob14444 |
|---|---|---|
| Metric instead of scan, where the environment publishes one | implemented, 0.1.80–0.1.81 | −15.6 GB and −5.9 s per session |
| Coverage guard, so a young metric is not trusted | implemented, 0.1.81 | correctness, no cost change |
| Naming the network log buckets | available in Settings, unset here | −52% of every log read |
| Sampling the flow reads | tested and refused | would have been −99% and wrong |
| A real scan limit per read | recommended | turns a runaway environment into an error, not a bill |
| Per-user app-state cache with a TTL | recommended | restores the cross-session saving lost when the log cache left the browser |
| Shorter `staleTime` | deliberately not done | the documentation's 15–30 s for logs costs more than the five minutes used here |
