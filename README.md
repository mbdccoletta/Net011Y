# NetO11y

A Dynatrace AppEngine app that shows a network the way an operator reads it: sites on a map, devices by
role, WAN reachability and circuits, traffic between sites, and the open problems that explain what is
wrong — with a drill-down into the native apps for the detail.

## The rules the app is built on

**It works in any environment.** The app needs nothing specific to show something useful: a network
monitored by any Dynatrace SNMP extension is enough. Everything more specific — primary tags, circuit tags,
NetFlow, OneAgent network flows — adds to what it shows, and the app says which step adds what.

**It reads only documented formats.** Smartscape network nodes and edges, the metrics of the Dynatrace
network extensions, Davis problems and events, ActiveGate syslog, the SNMP Traps extension, NetFlow through
the OpenTelemetry Collector, OneAgent network metrics and flows. Raw log text in a vendor's own format is
not parsed.

**It does not judge health.** A device, an interface, a link or a site is red or yellow because Dynatrace
has an open problem or alert on it. Everything else — CPU, saturation, errors, retransmissions — is shown
as a measurement, never turned into a verdict. The one number the app checks itself is the SLA the customer
tags on a circuit monitor (`sla_ms`).

**Nothing the environment reports disappears.** An alert the app cannot place is still listed, with the
reason.

## Where the data comes from

| What | Works with | Enriched by |
|---|---|---|
| Devices and ports | Any Dynatrace network extension, through Smartscape (`EXT_NETWORK_DEVICE`, `EXT_NETWORK_INTERFACE`) | — |
| Health (CPU, memory, availability, traffic, errors, VLANs) | The common `network_device` metrics and the vendor families: Generic Cisco, generic SNMP, Juniper, Palo Alto, F5 (`app/ui/app/data/formats.ts`) | Vendor extensions (CRC, VLAN tables) |
| Sites | sysLocation, the SNMP autodiscovery group, the management network | Primary tags `site`, `site_name`, `site_type`, `region`, `geo_lat`, `geo_lon`, `hub`, `site_cidr` |
| Map | A schematic layout by region | Coordinates, for the geographic map |
| WAN | Reachability per site from any ICMP monitor that pings a device (network coverage monitors included) | Circuit tags on the monitors: `circuit_id`, `circuit_role`, `carrier`, `circuit_tech`, `sla_ms` |
| Topology | Smartscape `calls` between network devices and interfaces | SNMP autodiscovery neighbour discovery (CDP / LLDP) |
| Status | `dt.davis.problems`, `dt.davis.events` (severity, maintenance, root cause); a week of problems says whether any alert watches the polled devices at all | Network alert templates in Infrastructure & Operations |
| What changed (24 h) | Restarts (sysUpTime stepping down), devices that stopped or started answering, Davis problems opened and closed, circuits down — all included in the subscription | — |
| Events | ActiveGate syslog, SNMP Traps extension | — |
| Traffic | — | NetFlow / IPFIX through the OpenTelemetry Collector; OneAgent network connection monitoring |
| Fault domain | OneAgent process network metrics, service requests | Real user sessions, `site_cidr` |

The map groups sites that fall close together once an estate passes 600 sites (a click opens a group), and ⌘K
searches every device, address, site and circuit from any page.

Settings › Data documents every item: what each page uses it for, how to send it, a query to verify it,
and the link to the Dynatrace documentation. Settings also lists the next steps for the environment, the
extensions it sends, and the permissions the app needs.

## What it costs to run

Log and event queries are billed by the data Grail scans, and a window of logs costs the same whatever the
filter. The app keeps that low without changing what it shows:

- one read of the metric series says which extension families the environment sends, and only their queries run;
- optional sources (device logs, neighbours, NetFlow, OneAgent flows) are probed and remembered empty for 12 h;
- device logs, traps, neighbours, the NetFlow timeline and the applications' network series are kept in the viewer's
  browser: the next open reads only what arrived since the last one (from ten minutes before it, for late records) and
  puts the two together. Values are kept exactly as Grail returned them, empty buckets included, so the answer is the
  one the full query gives;
- Settings › Data › What the app reads shows what each load read and what it costs at list price, and — since a log
  query reads every record of its buckets in its window — how much a bucket of their own for the network's logs would
  save. The syslog, traps, NetFlow and neighbour guides explain the OpenPipeline route, and Settings takes the bucket names.

## Running it

The local-dev link only resolves on port 3000, and `environmentUrl` in `app/app.config.json` must point at
the environment being opened.

```bash
cd app && npm install && npm start
```

## Example networks

Settings › General › Data source opens two simulated networks, so the app can be explored before any data
arrives: a retail company with about 400 sites and 2,000 devices, and the same company at extra-large scale
(`?source=example&scale=xl`) with about 4,200 sites, 20,000 devices and four data centers, read the way the
app reads an estate that size — per-device summaries instead of every port.

## How it was built

[docs/how-this-app-was-built.md](docs/how-this-app-was-built.md) is the note for whoever picks the code up:
the rules the app is built on, how data gets from Grail to the screen, what changes at scale, what it costs
to run, how it is tested, and the mistakes that shaped it.

## Checks

```bash
cd scripts/grail
node build.mjs                 # bundles the app's model and queries for the scripts
node generate.mjs              # Grail-shaped fixtures for a 62-site network
node validate.mjs              # 70 scenario checks against the app's own model
node scorecard.mjs proxy       # what the app delivers in the environment the dev server serves
node scorecard.mjs dtctl:<ctx> # the same through a dtctl context
DT_CONTEXT=<dtctl-context> node live_check.mjs
node perf.mjs 20000 10         # scale test: 20k devices through the model
```

`scripts/*.py` and `prototype/` are the earlier prototype, kept only to rebuild the old demo data.
