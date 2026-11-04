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
