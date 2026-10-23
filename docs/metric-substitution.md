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
| `flowNets` | top-N `sum(bytes)` | exp, s24, d24, proto, port | **59,929 in one hour** | keep |
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
