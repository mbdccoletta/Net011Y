# NetO11y

A Dynatrace AppEngine app that shows a network the way an operator reads it: sites on a map, devices by
role, WAN reachability and circuits, traffic between sites, and the open problems that explain what is
wrong — with a drill-down into the native apps for the detail.

## The rules the app is built on

**It works in any environment.** The app needs nothing specific to show something useful: a network
monitored by any Dynatrace SNMP extension is enough. Everything more specific — primary tags, circuit tags,
NetFlow, OneAgent network flows — adds to what it shows, and the app says which step adds what.

**It reads only documented formats.** Smartscape network nodes and edges, the metrics of the Dynatrace
network extensions, the problems and events Dynatrace Intelligence raises, ActiveGate syslog, the SNMP
Traps extension, NetFlow through
the OpenTelemetry Collector, OneAgent network metrics and flows. Raw log text in a vendor's own format is
not parsed.

**It does not judge health, and holds no thresholds of its own.** A device, an interface, a link or a site
is red or yellow because Dynatrace Intelligence has an open problem or alert on it. Everything else — CPU,
saturation, errors, retransmissions — is shown as a measurement, and no number in this code decides what
counts as high: that number lives in the customer's alert templates, where it is theirs. The two figures
the app applies are the customer's own — the SLA tagged on a circuit monitor (`sla_ms`), and the
demand-drop threshold they set in Settings.

**Nothing the environment reports disappears.** An alert the app cannot place is still listed, with the
reason.

## Where the data comes from

| What | Works with | Enriched by |
|---|---|---|
| Devices and ports | Any Dynatrace network extension, through Smartscape (`EXT_NETWORK_DEVICE`, `EXT_NETWORK_INTERFACE`) | — |
| Health (CPU, memory, availability, traffic, errors, VLANs) | The common `network_device` metrics and the vendor families: Generic Cisco, generic SNMP, Juniper, Palo Alto, F5 (`app/ui/app/data/formats.ts`) | Vendor extensions (CRC, VLAN tables) |
| Sites | sysLocation, the SNMP autodiscovery group, the management network | Primary tags `site`, `site_name`, `site_type`, `region`, `geo_lat`, `geo_lon`, `hub`, `site_cidr` |
| Map | A schematic layout by region, when nothing can be placed | Coordinates (`geo_lat` / `geo_lon`, or a place the app recognises): geography is then the default, and the bar says how many sites it is drawing. The States view adds the outlines of the admin-1 regions of the countries the sites are in, filled by what stands in each one — one lazily fetched chunk per country, nothing for a reader who does not open it |
| WAN | Reachability per site from any ICMP monitor that pings a device (network coverage monitors included) | Circuit tags on the monitors: `circuit_id`, `circuit_role`, `carrier`, `circuit_tech`, `sla_ms` |
| Topology | Smartscape `calls` between network devices and interfaces | SNMP autodiscovery neighbour discovery (CDP / LLDP) |
| Status | `dt.davis.problems`, `dt.davis.events` (severity, maintenance, root cause); a week of problems says whether any alert watches the polled devices at all | Network alert templates in Infrastructure & Operations |
| Thresholds | None in the app | The alert templates, which hold the customer's own numbers |
| What changed (24 h) | Restarts (sysUpTime stepping down), devices that stopped or started answering, problems opened and closed, circuits down — all included in the subscription | — |
| Events | Syslog, whichever road it takes — the ActiveGate ingest writes `dt.openpipeline.source`, a OneAgent writes the same under `custom.`, and both are read — and the SNMP Traps extension | — |
| Traffic | — | NetFlow / IPFIX through the OpenTelemetry Collector; OneAgent network connection monitoring |
| Fault domain | OneAgent process network metrics, service requests | Real user sessions, `site_cidr` |

The map groups sites that fall close together once an estate passes 600 sites (a click opens a group), and ⌘K
searches every device, address, site and circuit from any page.

Settings › Data documents every item: what each page uses it for, how to send it, a query to verify it,
and the link to the Dynatrace documentation. Settings also lists the next steps for the environment, the
extensions it sends, and the permissions the app needs.

## What it costs to run

Grail bills a query by the bytes it scans, and only for some tables. Of the hundred queries this app
makes, seventy-four are metrics and five are Smartscape: those are included and cost nothing. Fifteen
read logs, events or user sessions, and those are the bill.

Measured on a live environment in October 2026 — 198 devices, 4.4 million NetFlow records an hour
through the OpenTelemetry collector, 1.7 million syslog and trap records every six hours — one
opening of the Live map:

| Read | Window | Scanned |
|---|---|---|
| NetFlow conversations | 1 h | 8.05 GB |
| NetFlow fan-in | 1 h | 8.06 GB |
| Syslog and trap counts | 6 h | 5.19 GB |
| NetFlow timeline (incremental) | 70 min | 1.54 GB |
| Syslog records, neighbours (incremental) | 3 h, 20 min | 0.29 GB |
| Problems, Davis events, user sessions | 24 h – 7 d | 0.29 GB |
| **One load** | | **23.4 GB — US$ 0.076 at list price** |

A hundred people opening it once a working day is about **US$ 168 a month** on an environment of that
shape. The whole app's real billed consumption on that environment over the previous week, with four
people using it, was **US$ 0.33**.

**What drives the figure is log and flow volume, not the size of the estate.** The same hundred users
on an estate of a thousand devices with no NetFlow would cost a fraction of it; the device count moves
metric and Smartscape queries, which are free.

What the app does to keep it down, each measured rather than assumed:

- **a read that a metric can answer uses the metric.** Counting syslog lines per device and flows per
  exporter is arithmetic over a stream, which is what a metric is: where the environment publishes one
  (an OpenPipeline extraction rule — Settings names the rule for each read still being paid for), the
  app uses it and the read becomes free. 13.6 GB of the 23.4 above. It is used only once the metric
  reaches the start of the window, because a rule made this morning has no yesterday;
- **the part of a window already read is not read again.** Kept in the reader's own app state, with an
  expiry equal to the window — never in shared state, because log records carry content another user
  may not be allowed to read, and never in the browser;
- **optional sources are probed once and remembered empty for twelve hours**, in state the whole team
  shares, so the second reader of the day does not re-probe what the first found absent;
- **every read carries a scan limit of 50 GB.** A read that reaches it does not come back smaller, it
  comes back truncated with a warning nothing downstream can see — so the app compares what was scanned
  against the limit it set and reports that read as one it does not have;
- **naming the buckets that hold the network's logs** scopes every log query to them. Settings lists the
  environment's log buckets, and a button reads five minutes of logs to say which ones the records are
  actually in. It needs a bucket and an OpenPipeline routing rule to exist first;
- **per-interface reads stop above 3,000 devices or 40,000 ports** and the app works from per-device
  summaries, fetching one device's interfaces when somebody opens it.

**Dynatrace Intelligence is the other half of the bill, and the larger one per act:** one question costs
three AI units — US$ 0.30 at list price, measured on real calls. Twenty-five questions a day cost more
than all the scanning above.

Settings › Data › What the app reads shows what the current load read, in gigabytes and in dollars, with
the heaviest queries named. `docs/metric-substitution.md` has the per-read analysis: cost, latency, what
a metric can and cannot answer, the measured cardinality of every metric proposed, and the sampling
experiment that was implemented and then refused by its own measurement.

## Running it

The local-dev link only resolves on port 3000.

`environmentUrl` in `app/app.config.json` is committed as the placeholder
`https://ENVIRONMENTID.apps.dynatrace.com`, because no environment this app was built or tested against
belongs in a shared repository. Point `dt-app` at yours with the flag, which leaves the file alone:

```bash
cd app && npm install
npx dt-app dev --environment-url https://<your-environment>.apps.dynatrace.com
```

Editing the file works too, and then the edit must not travel in a commit.

## Deploying

Every deploy needs a **new version**: the platform refuses to install a version it already has, and says
`Failed to install the app` when it does.

```bash
cd app
# 1. raise "version" in app.config.json
npm run build                                                        # optimised bundle
npx dt-app deploy --skip-build --environment-url https://<env>.apps.dynatrace.com
```

Repeat the last line once per environment. The `--environment-url` flag is the only place an environment
is named: the committed `environmentUrl` is a placeholder, so nothing in this repository says which
environments the app runs in.

Green before deploying — the suites take seconds and have caught every serious bug in this app:

```bash
cd app && npm run typecheck && npm run lint
cd scripts/grail && node build.mjs && node validate.mjs && node example_check.mjs
```

`npm run lint` exists for the two mistakes a green type check and a clean build both miss, because both
are about when code runs: a hook called after a conditional return, and a value read above its own
declaration. Each one has shipped — the second killed the live map for a version. Everything else the
lint could say is turned off, so those two are never buried.

Two failures are worth one retry before investigating, because both happen on a healthy environment:
`fetch failed`, and `Failed to install the app` on a version that was already raised. `dt-app` also warns
on any Node other than 24; it deploys anyway.

## Example networks

Settings › General › Data source opens three simulated networks, so the app can be explored before any data
arrives — a Brazilian and American retail group, at the three sizes a reader is likely to be sizing against:

| | Sites | Devices | Interfaces | WAN links |
|---|---|---|---|---|
| `?source=example&scale=mid` | 211 | 1,007 | 2,200 | 282 |
| `?source=example` | 551 | 2,667 | 5,826 | 772 |
| `?source=example&scale=xl` | 4,170 | 20,060 | per-device summaries | 5,762 |

All three carry the same faults in proportion — an outage, a carrier degrading, ports discarding — and
none of them queries Grail: they are built in the browser, so they cost nothing and say nothing about
query cost. The extra-large one is read the way the app reads an estate that size, with per-device
summaries instead of every port.

## How it was built

[docs/how-this-app-was-built.md](docs/how-this-app-was-built.md) is the note for whoever picks the code up:
the rules the app is built on, how data gets from Grail to the screen, what changes at scale, what it costs
to run, how it is tested, and the mistakes that shaped it.

## Checks

```bash
cd scripts/grail
node build.mjs                 # bundles the app's model and queries for the scripts
node generate.mjs              # Grail-shaped fixtures: 62 sites, 494 devices (rebuilt automatically when stale)
node example_check.mjs         # 163 coherence checks on the bundled example, both sizes
node validate.mjs              # 120 scenario checks against the app's own model
node scorecard.mjs proxy       # what the app delivers in the environment the dev server serves
node scorecard.mjs dtctl:<ctx> # the same through a dtctl context
DT_CONTEXT=<dtctl-context> node live_check.mjs
node perf.mjs 20000 10         # scale test: 20k devices through the model
```

`scripts/*.py` and `prototype/` are the earlier prototype, kept only to rebuild the old demo data.
