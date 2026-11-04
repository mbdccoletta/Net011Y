# The two OpenPipeline rules that take 14 GB off every load

The app already prefers a metric over a log scan wherever one is declared, checks that the metric
is published *and* covers the window before trusting it, and falls back to the scan otherwise
(`QUERIES[name].metric`, `asMetric()` in `data/useNetwork.ts`). Two reads declare a metric form and
no environment has ever had it. These are the rules that create it.

Routing and extraction apply only to data ingested **after** the rule exists, so the metric starts
empty and the app keeps scanning until it covers the window it is asked for. That is by design: the
coverage probe is what makes the switch safe.

## 1. Syslog and trap records — replaces `deviceLogs` (4.6 GB a load)

The read counts records per device, per kind and per level, in 15-minute buckets. A counter metric
with those three dimensions answers it exactly.

- **Pipeline:** the one that handles `extension:syslog` and `snmptraps`
- **Processor:** counter metric
- **Metric key:** `log.net.syslog.records`
- **Dimensions:** `ip`, `kind`, `loglevel`

`ip` is `coalesce(dt.ingest.source.ip, custom.ingest.source.ip, device.address)`, `kind` is `trap`
when `log.source == "snmptraps"` and `syslog` otherwise, and `loglevel` is the existing field where
it is set, else derived from the severity digit in the Cisco-style prefix (`<= 3` ERROR, `4` WARN,
otherwise INFO) — the same derivation the query does today, moved to ingest.

**Cardinality:** devices × 2 × 4. Measured at 420 devices that is at most 3,360 series.

## 2. NetFlow volume per exporter — replaces `flowTs` (9.4 GB a load)

The read is a five-minute timeseries of flow count and bytes, grouped by exporter only. One
counter and one value metric with a single dimension.

- **Pipeline:** the one that handles the OpenTelemetry NetFlow receiver
  (`otel.scope.name == "otelcol/netflowreceiver"`)
- **Processors:** counter metric and value metric
- **Metric keys:** `log.net.flow.records`, `log.net.flow.bytes` (from `flow.io.bytes`)
- **Dimension:** `exp` = `flow.sampler_address`

**Cardinality:** one series per exporter. Single digits on most estates.

## What this does not cover

`flowNets` and `flowFanIn` stay as log scans. Their groupings are a /24 × /24 × port × interface
matrix and a distinct count of source addresses; neither survives being turned into a metric at a
cardinality anyone would accept. They are deferred to the page that draws them instead (`heavy` in
`data/queries.ts`).

`netChanges` also stays: it parses mnemonics out of the message body and groups by interface name,
which is a parse per record rather than a count.

## Verifying

```dql
metrics from:now()-24h
| filter startsWith(metric.key, "log.net")
| summarize n = count(), by:{metric.key}
```

Once the keys appear, the app's own Settings › Data page names each read that a metric now serves,
and the load cost reported there drops without anything else changing.
