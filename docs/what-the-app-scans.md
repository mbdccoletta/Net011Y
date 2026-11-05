# What the app scans, and what it is charged for

Measured on a live environment with NetFlow and SNMP syslog, 2026-11-04. Every figure below is
`scannedBytes` reported by Grail for the query the app actually sends, not an estimate.

Grail bills a query by the bytes it scans, and only for some tables. Metrics, Smartscape and Davis
problems are included in the subscription and cost nothing however often they are read.

## The hundred reads

| Source | Reads | Charged |
|---|---|---|
| `timeseries` / `metrics` / `fetch metric.series` | 79 | no |
| `smartscapeNodes` / `smartscapeEdges` | 3 | no |
| `fetch dt.davis.problems` / `dt.davis.events` | 3 | no |
| `fetch logs` | 7 | **yes** |
| `fetch events` (OneAgent flows) | 5 | **yes** |
| `fetch user.sessions` | 3 | **yes** |

Eighty-five of a hundred reads are free. The whole bill is the other fifteen, and almost all of it
is five of them.

## What a full load scans

| Read | Scanned | Time | Window |
|---|---|---|---|
| `flowTs` | 9.4 GB | 1.2 s | 70 min of NetFlow |
| `flowNets` | 8.0 GB | 3.7 s | 1 h of NetFlow |
| `flowFanIn` | 8.0 GB | 3.2 s | 1 h of NetFlow |
| `netChanges` | 4.6 GB | — | 6 h of syslog |
| `deviceLogs` | 4.6 GB | — | 6 h of syslog and traps |
| `deviceLogsRecent` | 228 MB | — | recent syslog |
| `neighbors` | 116 MB | — | 30 min of CDP/LLDP |
| `sessionsTypical` | 2.0 MB | — | 7 days |
| `sessions`, `sessionNets` | 388 KB each | — | 24 h |
| the five OneAgent flow reads | 0 B | — | absent in this environment |

**≈ 35 GB, about $0.12 at list price.** NetFlow is 25.4 GB of it — 73%.

## Four things the measurement showed

### 1. The metric substitution is built and dormant

`deviceLogs` and `flowTs` declare a metric form, and the app prefers it whenever the metric exists
and covers the window. On every environment checked, `metrics | filter startsWith(metric.key,
"log.net")` returns nothing: the OpenPipeline extraction rules were never created, so the app falls
back to the log scan every time — correctly, and at full price.

The two rules are in `docs/openpipeline-metrics.md`. They remove 14 GB of the 35 with no loss of
information, because the app checks that the metric covers the window before trusting it.

### 2. Half a Live map load was two reads for a page nobody had opened

`flowTs` (9.4 GB) and `flowFanIn` (8.0 GB) are drawn nowhere but Traffic and the site panel, and
both already said so in `views`. The view rule only applied to reads marked `detail`, so they ran
on every load regardless. `flowFanIn` is the clearest case: its only consumer is
`environmentFindings`, whose only consumer is `trafficContext`, whose only consumer is
`TrafficPage` — 8 GB on the opening screen for context that is read when somebody clicks an
Intelligence question on another page.

Both are now marked `heavy`: a read that names its views and is marked heavy waits for one of
them. The map keeps `flowNets`, which is what draws its routes. Deferred, never dropped — `heavy`
deliberately does not bring the estate-size rule that `detail` carries, so opening Traffic on a
large estate still answers in full.

### 3. Merging the three NetFlow reads: measured, and refused

All three scan the same hour with the same filter, so one pass looked like 9.4 GB in place of
25.4 GB. The faithful version does not fit:

- adding the five-minute bucket `flowTs` needs to the grouping `flowNets` uses takes the result
  from 67,681 rows to **246,257**;
- `flowFanIn` counts *distinct* source addresses, and a distinct count cannot be recovered by
  aggregating a finer grouping.

A one-pass query that drops `in_if`/`out_if` and re-aggregates the distinct count does scan 9.4 GB
in 5.2 s, and it answers a different question. Not done.

### 4. `flowNets` is truncated and nothing says so

Its grouping produces **67,681 rows** and the query ends `limit 5000`. That is the intent — the
top talkers by bytes — but the app only detects truncation by *scan limit*, never by result limit,
so a reader is shown a list with no sign that 93% of the groups are not in it.

Not fixed here. Fixing it means either saying so on the page or raising the limit, and the second
costs transfer rather than scanning.

## Confirmed after the change

Re-measured on the same environment once 0.1.91 was deployed, with `scripts/grail/scan_split.mjs`,
which asks the environment for each billed read and splits them by `readWanted` — the rule the app
itself applies:

| | Reads | Scanned |
|---|---|---|
| billed reads the Live map asks for | 13 | **16.58 GB** |
| billed reads that now wait for Traffic or a site panel | 2 | **13.52 GB** |
| all billed reads | 15 | 30.10 GB |

**45% of the load, gone from the opening screen** — `flowTs` 7.27 GB and `flowFanIn` 6.24 GB.

The totals are lower than the table above because NetFlow volume differs by the hour, and all three
NetFlow reads ask for `now()-1h`: 30.1 GB in this hour against 35 GB in the earlier one. The share
is what to read, not the absolute figure, and a measurement of this is only ever an hour's.

`scan_split.mjs --views traffic` measures the other direction: what opening Traffic asks for.

The behaviour is held by three checks in the suite that call `readWanted` itself rather than
re-stating it — a Live map load asks for neither, Traffic and the site panel ask for both, and the
map load loses exactly those two reads and no third (88 reads → 86).

## What deferring the two reads broke, and what fixed it

Three defects, all the same defect: a read that no longer runs on a page leaves something behind
that was computed as though it had. `pageCoverage` already carries the rule — *unmeasured is null,
not zero* — and it was written for the Ahead reads for exactly this reason. Deferring `flowTs` and
`flowFanIn` created three new instances of it.

**The network's share of the log bill was computed from the syslog count alone.** Two reads count
what they match: `deviceLogs` the syslog records, `flowTs` the NetFlow ones, over a denominator that
is every record those queries scanned. With `flowTs` waiting for Traffic, its half of the numerator
went missing while the denominator kept all of it — so the network looked like a smaller part of the
bucket than it is, and the saving Settings offers for a bucket of its own was overstated by exactly
the part nobody measured. `networkLogShare` (coverage.ts) now answers null unless every count is
accounted for; a count absent from the environment is a real zero and still counts.

**An explanation on the Live map was handed an empty list of traffic findings.** Fan-in comes from
`flowFanIn` and a falling-silent exporter from `flowTs`, and `networkContext` presented the result as
findings — so an answer could say nothing stands out about traffic on evidence nobody had read. The
flow map now records which of the two reads answered (`measured`), told apart from answering with no
rows, and the context names what was not read instead of showing none.

**A deferred read could ask for a far wider window than it meant to.** An incremental plan carries an
absolute `from` — where the kept part ends — so it is only true at the moment it is made. Plans were
all made when the page loaded, `flowTs` among them, and the read then ran whenever Traffic was
opened: an hour on the map made it ask for an hour and a half of NetFlow, a morning on the map made
it ask for the morning, up to the scan limit. Deferring a read made its window grow with how long
the reader waited, which is the opposite of what deferring it was for. A plan is now made when its
read is first wanted (`planWanted`) and never remade, which keeps the other half of the rule: a
remade plan is a new query string, and that fired reads twice for 48 GB.

Found by review on the pull request, not by the suite — the three checks there tested the flags, and
these are consequences a flag cannot show. Four checks were added that ask the functions themselves.

### Three more from the second review

**A metric serving the read is not the same as having its count.** The first fix accepted
`asMetric("flowTs")` as the count being accounted for, on the reasoning that a metric-served read
is no longer a log read. It is not the same thing: the share is over the log records `deviceLogs`
scans, and those still include the NetFlow ones unless the extraction also routed them away — and a
metric answer carries no `scannedRecords` at all, so `matched()` returns null either way. The test
is now whether the figure is in, not whether the read could have produced one, which leaves the
share unmeasured on an environment with the metrics and states it on one without.

**An absence recorded after the cost was computed never reached it.** The `cost` memo depends on
`stamp`, which records each read as answered, failed or skipped. A probe that comes back with no
rows makes its companions skipped through `probeSaysNo` in the same render, so by the time the
effect writes `absent.netflow` the stamp already reads *skipped* for every one of them and the memo
does not run again. The share then stayed unmeasured on an environment that had just proved it sends
no NetFlow — until some unrelated read happened to settle. The absence stamps are in the
dependencies now.

**The pages that do read them are also without them, for a few seconds.** Opening Traffic starts
the two reads it defers, and an explanation asked in that window was written without fan-in and
without the exporter rates. Answers are cached per subject and question, so that answer would have
been handed back for the rest of the visit. Both contexts now carry the same note as the map's, with
wording that covers a read that is waiting, in flight or failed — the context cannot tell them
apart — and the subject an answer is cached under moves when the evidence lands, which drops it.
