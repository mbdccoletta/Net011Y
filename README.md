# NetworkPlane

A Dynatrace AppEngine app that shows a network the way an operator reads it: sites on a map, devices by
role, WAN circuits against their SLA, and the open problems that explain what is wrong — with a drill-down
into the native apps for the detail.

## The rule the app is built on

**The app does not judge health.** A device, an interface, a link or a site is red or yellow here because
Dynatrace has an open problem or alert on it — from Davis, from the alert templates in Infrastructure &
Operations, or from a custom alert on the extension metrics. The app reads `dt.davis.problems` and
`dt.davis.events`, maps what they affect onto the network inventory, and groups it by site, carrier and
data centre.

The **one** number the app checks by itself is the SLA the customer tags on each circuit monitor
(`sla_ms`), because that number is the customer's own input. Everything else — CPU, saturation, packet
errors, availability — is shown as a measurement, never turned into a verdict.

Nothing the environment reports disappears. An alert the app cannot place on the map is still listed,
with the reason and the fix: on a network element outside this inventory, not linked to any entity, or
outside the network domain.

## Where the data comes from

| What | Source |
|---|---|
| Devices, interfaces, sites | SNMP extensions, through Smartscape (`EXT_NETWORK_DEVICE`, `EXT_NETWORK_INTERFACE`) |
| Inventory (site, region, hub, coordinates) | Primary Grail tags on the SNMP monitoring configurations |
| WAN circuits and their SLA | Primary tags on the ICMP network availability monitors (`circuit_id`, `carrier`, `sla_ms`, …) |
| Status | `dt.davis.problems` and `dt.davis.events` |
| Events | Syslog and SNMP traps, matched to devices by source IP |
| Traffic | Interface counters; NetFlow through the OpenTelemetry collector; OneAgent network flows |

Settings › Data documents every item, what each page uses it for, and how to send it.

## Running it

The tenant's local-dev link only resolves on port 3000, and `environmentUrl` in `app/app.config.json`
must point at the tenant being opened.

```bash
cd app && npm install && npm start
```

## Checks

```bash
cd scripts/grail
node build.mjs        # rebuilds the model and query bundles from app/ui/app
node generate.mjs     # writes Grail-shaped fixtures for a 62-site network
node validate.mjs     # 17 scenario checks against the app's own model
node gru_regression.mjs   # the same model against a live tenant, with invariants
node perf.mjs 20000 10    # scale test: 20k devices through the model
```

`scripts/*.py` and `prototype/` are the earlier prototype. They predate the alert-driven model and still
carry its thresholds; they are kept only to rebuild the old demo data.
