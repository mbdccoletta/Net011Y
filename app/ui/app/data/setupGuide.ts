// How to send each kind of data the app reads to Dynatrace. Shown in Settings next to the live status
// measured by evaluateNeeds. Every name here (extensions, feature sets, fields, tag keys, versions) was
// checked against the Dynatrace documentation and the extension schemas on 2026-09-17.
import type { NeedKey } from "./requirements";

export interface SetupSnippet {
  title: string;
  language: "json" | "yaml" | "dql" | "bash";
  code: string;
}

export interface SetupGuide {
  /** What the app shows with this data */
  uses: string;
  /** Standard Dynatrace mechanism that produces it */
  source: string;
  prerequisites: string[];
  steps: string[];
  snippets?: SetupSnippet[];
  /** DQL to confirm the data arrives */
  verify: string;
  docs: { label: string; href: string }[];
}

const DOCS = {
  snmpCisco: { label: "Generic Cisco Device extension", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/extensions/generic-cisco-router-snmp-extension" },
  snmpGeneric: { label: "Generic network device extension", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/extensions/snmp-generic" },
  networkStart: { label: "Get started with network device monitoring", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks/network-devices/network-devices-get-started-guide" },
  tagsExtensions: { label: "Primary Grail tags for extensions", href: "https://docs.dynatrace.com/docs/manage/tags/tags-domain-extensions" },
  tagsSynthetic: { label: "Primary Grail tags for Synthetic", href: "https://docs.dynatrace.com/docs/observe/digital-experience/synthetic/primary-grail-tags-synthetic" },
  nam: { label: "NAM monitor metrics", href: "https://docs.dynatrace.com/docs/observe/digital-experience/synthetic/synthetic-metrics/nam-monitor-metrics-latest" },
  syslog: { label: "Syslog ingestion with ActiveGate", href: "https://docs.dynatrace.com/docs/analyze-explore-automate/logs/lma-log-ingestion/lma-log-ingestion-syslog" },
  traps: { label: "SNMP Traps extension", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/extensions/snmp-traps-statistics" },
  netflow: { label: "Ingest NetFlow with the OpenTelemetry Collector", href: "https://docs.dynatrace.com/docs/ingest-from/opentelemetry/collector/use-cases/netflow" },
  oneagentFlows: { label: "OneAgent network connection monitoring", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks/network-devices/network-flows/oneagent-network-connection-monitoring" },
  intelligence: { label: "Dynatrace Intelligence", href: "https://docs.dynatrace.com/docs/dynatrace-intelligence" },
  infraops: { label: "Infrastructure & Operations", href: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/infrastructure-and-operations" },
  rum: { label: "Real User Monitoring", href: "https://docs.dynatrace.com/docs/observe/digital-experience/web-applications" },
  rumAnomaly: { label: "Traffic anomaly detection for applications", href: "https://docs.dynatrace.com/docs/observe/digital-experience/web-applications/additional-configuration/adapt-anomaly-detection" },
};

const SNMP_PREREQ = [
  "Environment ActiveGate on Linux with the Extension Execution Controller, reachable from the devices over SNMP (UDP 161).",
  "ActiveGate 1.343 or later, so primary tags reach the device data.",
  "SNMPv3 credentials stored in the Dynatrace credential vault (SNMPv2c works, but isn't recommended).",
];

export const SETUP: Record<NeedKey, SetupGuide> = {
  devices: {
    uses: "Every page: the list of routers, switches, firewalls, load balancers and access points, and their health.",
    source: "SNMP extensions running on an ActiveGate group (Extensions 2.0). They create the Smartscape nodes EXT_NETWORK_DEVICE and EXT_NETWORK_INTERFACE.",
    prerequisites: SNMP_PREREQ,
    steps: [
      "In Extensions, activate the extension that matches each vendor: com.dynatrace.extension.snmp-generic-cisco-device, snmp-generic-juniper, palo-alto-generic, f5.bigip, or snmp-generic-device for any other device.",
      "Create a monitoring configuration on the ActiveGate group and add every device IP address with its SNMP credentials. For large networks, use the SNMP Autodiscovery extension per IP range.",
      "Name devices BR-<state>-<site>-<role><n> (for example BR-RS-POR1-RTR1) or add the site primary tags below. Roles: RTR edge router, CON core, SWT switch, APW access point, WLC wireless controller, FWL firewall, LBL load balancer.",
    ],
    snippets: [{
      title: "Monitoring configuration (excerpt)",
      language: "json",
      code: `{
  "enabled": true,
  "activationContext": "REMOTE",
  "featureSets": ["Health", "Interfaces", "Interfaces 32-bit", "Interfaces 64-bit", "Traffic", "Cisco BGP", "OSPF", "neighbor-discovery"],
  "snmp": {
    "devices": [
      {
        "ip": "10.12.1.1",
        "port": 161,
        "authentication": { "type": "SNMPv3", "useCredentialVault": true, "credentialVaultIdSnmpV3": "CREDENTIALS_VAULT-<id>" }
      }
    ]
  }
}`,
    }],
    verify: "smartscapeNodes EXT_NETWORK_DEVICE\n| summarize devices = count(), by:{device_type, monitoring_mode}",
    docs: [DOCS.networkStart, DOCS.snmpCisco, DOCS.snmpGeneric],
  },
  interfaces: {
    uses: "Device details: interface list with operational and admin status, speed and uplink detection.",
    source: "Interface feature sets of the SNMP extension (IF-MIB ifTable and ifXTable).",
    prerequisites: ["Network devices set up (see above)."],
    steps: ["Enable the feature set Interfaces in each SNMP monitoring configuration."],
    verify: "smartscapeNodes EXT_NETWORK_INTERFACE\n| summarize interfaces = count(), by:{operational_status}",
    docs: [DOCS.snmpCisco],
  },
  traffic: {
    uses: "Device details and the live map: uplink utilization, saturation, errors, discards and CRC errors. The map animation speed and packet count follow this traffic.",
    source: "64-bit and 32-bit interface counters of the SNMP extension.",
    prerequisites: ["Network devices set up.", "Interface speed (ifHighSpeed) reported correctly by the device."],
    steps: [
      "Enable Interfaces 64-bit (octets and ifHighSpeed) and Traffic.",
      "Enable Interfaces 32-bit: error, discard and CRC counters live in this feature set.",
    ],
    verify: "timeseries bytes = sum(`com.dynatrace.extension.snmp-generic-cisco-device.if.hc.in.octets.count`), by:{dt.smartscape.ext_network_device}\n| limit 20",
    docs: [DOCS.snmpCisco],
  },
  cpu: {
    uses: "Device health: CPU above 70% is a warning, above 85% is critical.",
    source: "Default metrics of the SNMP extension (com.dynatrace.extension.network_device.cpu_usage).",
    prerequisites: ["Network devices set up."],
    steps: ["Keep the default or Health feature set enabled. Generic devices that don't expose a CPU MIB show no CPU."],
    verify: "timeseries cpu = avg(com.dynatrace.extension.network_device.cpu_usage), by:{dt.smartscape.ext_network_device}\n| limit 20",
    docs: [DOCS.snmpCisco],
  },
  availability: {
    uses: "Device health and the 24-hour availability strips: a device that stops answering SNMP is marked unavailable.",
    source: "sysUpTime polled every minute by the SNMP extension (com.dynatrace.extension.network_device.sysuptime).",
    prerequisites: ["Network devices set up."],
    steps: ["No extra setting: sysUpTime is part of the default metrics. Keep the polling interval at 1 minute."],
    verify: "timeseries samples = count(com.dynatrace.extension.network_device.sysuptime), by:{dt.smartscape.ext_network_device}, interval:1h",
    docs: [DOCS.snmpCisco],
  },
  icmp: {
    uses: "Reachability and latency of each device, and when a device or link stopped answering (\"not responding since\").",
    source: "Network availability monitors (ICMP) running from a private Synthetic location on an ActiveGate.",
    prerequisites: ["Private Synthetic location on an ActiveGate 1.331 or later, close to the data center.", "ICMP allowed from that ActiveGate to the targets."],
    steps: [
      "Create a network availability monitor per site with an ICMP request to the edge router IP (the same IP used by the SNMP extension).",
      "Run it every 1 to 5 minutes from the private location. The app compares the last 2 hours in 5-minute steps to detect outages.",
    ],
    verify: "timeseries {sent = sum(dt.synthetic.multi_protocol.icmp.packets_sent), received = sum(dt.synthetic.multi_protocol.icmp.packets_received)}, by:{request.target_address}",
    docs: [DOCS.nam],
  },
  wan: {
    uses: "WAN links page, the carrier hop of each site path and carrier outages grouped as one probable cause.",
    source: "One network availability monitor (ICMP) per WAN circuit, carrying the circuit inventory as primary Grail tags.",
    prerequisites: ["Private Synthetic location on an ActiveGate 1.331 or later.", "Carrier-side IP address of each circuit (PE or tunnel endpoint)."],
    steps: [
      "Create one ICMP monitor per circuit that pings the carrier side of the circuit.",
      "Add these primary Grail tags to the monitor. In Synthetic, enter the key without the primary_tags. prefix (up to 10 tags, key up to 50 characters, value up to 200).",
      "site: site code, the same value as the site tag of the devices. circuit_id: unique circuit identifier. circuit_role: primary or backup. carrier: carrier name. circuit_tech: for example MPLS 50 Mbps. sla_ms: latency SLA in milliseconds. bandwidth_mbps: contracted bandwidth.",
    ],
    snippets: [{
      title: "Settings object builtin:synthetic.primary-grail-tags (scope: the monitor)",
      language: "json",
      code: `{
  "tags": [
    { "key": "site", "value": "POR1" },
    { "key": "circuit_id", "value": "CIR-POR1-P" },
    { "key": "circuit_role", "value": "primary" },
    { "key": "carrier", "value": "Carrier B" },
    { "key": "circuit_tech", "value": "MPLS 50 Mbps" },
    { "key": "sla_ms", "value": "80" },
    { "key": "bandwidth_mbps", "value": "50" }
  ]
}`,
    }],
    verify: "timeseries sent = sum(dt.synthetic.multi_protocol.icmp.packets_sent), by:{primary_tags.circuit_id, primary_tags.carrier, primary_tags.circuit_role}",
    docs: [DOCS.tagsSynthetic, DOCS.nam],
  },
  sites: {
    uses: "Live map positions, regions on the Sites page, site names, and which data center each site depends on.",
    source: "Primary Grail tags on each device in the SNMP monitoring configurations. Dynatrace copies them to the device and interface nodes, metrics and logs.",
    prerequisites: ["ActiveGate 1.343 or later running the extensions.", "Enrichment for extensions enabled in the environment (the schema marks it as in development)."],
    steps: [
      "In each SNMP monitoring configuration, add primary tags to every device (up to 20; keys must start with primary_tags.).",
      "primary_tags.site: site code. primary_tags.site_name: display name. primary_tags.site_type: branch or datacenter. primary_tags.region: region. primary_tags.state and primary_tags.city. primary_tags.geo_lat and primary_tags.geo_lon: decimal coordinates. primary_tags.hub: code of the data center the site's WAN terminates on.",
      "Without tags the app falls back to the device naming convention and can't place sites on the map.",
    ],
    snippets: [{
      title: "Device entry with primary tags",
      language: "json",
      code: `{
  "ip": "10.12.1.1",
  "port": 161,
  "authentication": { "type": "SNMPv3", "useCredentialVault": true, "credentialVaultIdSnmpV3": "CREDENTIALS_VAULT-<id>" },
  "primaryTags": [
    { "key": "primary_tags.site", "value": "POR1" },
    { "key": "primary_tags.site_name", "value": "Porto Alegre Store 1" },
    { "key": "primary_tags.site_type", "value": "branch" },
    { "key": "primary_tags.region", "value": "South" },
    { "key": "primary_tags.geo_lat", "value": "-30.03" },
    { "key": "primary_tags.geo_lon", "value": "-51.23" },
    { "key": "primary_tags.hub", "value": "SPO1" }
  ]
}`,
    }],
    verify: "smartscapeNodes EXT_NETWORK_DEVICE\n| summarize devices = count(), by:{primary_tags.site, primary_tags.region}",
    docs: [DOCS.tagsExtensions],
  },
  alerts: {
    uses: "Every status in the app. A device, an interface, a link or a site is only red or yellow here because Dynatrace has an open problem on it; the app adds no threshold of its own, except the SLA you tag on each circuit.",
    source: "Alert templates for network devices in Infrastructure & Operations (Alert templates tab), plus any custom alert you already have on the extension metrics. Both raise Davis problems, which the app reads from dt.davis.problems.",
    prerequisites: [
      "Permission to create alerts in Infrastructure & Operations (the Alert templates page tells you when it is missing).",
      "Network devices already monitored, so the templates have entities to watch.",
    ],
    steps: [
      "Open Infrastructure & Operations › Alert templates › Network devices and create the alerts you want from the 8 templates: interface saturation, traffic low, CRC errors, packet drops, packet errors, operationally going down, flapping, and network reachability degraded.",
      "Keep any custom alert you already use on the extension metrics: the app shows them too, including the ones raised on the environment instead of a device.",
      "Mute what you don't want to see. The app ignores a muted problem exactly like Dynatrace does.",
      "Tag each circuit monitor with sla_ms: latency above that number is the one judgement the app makes by itself.",
    ],
    verify: "fetch dt.davis.problems, from:now()-24h\n| filter event.status == \"ACTIVE\"\n| summarize problems = count(), by:{event.name, event.category}",
    docs: [DOCS.infraops, DOCS.tagsSynthetic],
  },
  syslog: {
    uses: "Device events and evidence of a probable cause (for example BGP neighbor down, power supply failure).",
    source: "Syslog ingestion on an ActiveGate. Records arrive with dt.openpipeline.source = extension:syslog.",
    prerequisites: ["Environment ActiveGate on Linux 1.295 or later (multi-environment ActiveGates don't support syslog)."],
    steps: [
      "Enable syslog ingestion on the ActiveGate. It listens on UDP 514 and TCP 601 (RFC 5424); RFC 3164 needs a receiver change.",
      "Point each device's syslog to the ActiveGate IP. The device must send from the same IP address that the SNMP extension polls: the app links logs to devices by source IP (dt.ingest.source.ip).",
    ],
    verify: "fetch logs, from:now()-1h\n| filter dt.openpipeline.source == \"extension:syslog\"\n| summarize records = count(), by:{dt.ingest.source.ip, loglevel}",
    docs: [DOCS.syslog],
  },
  traps: {
    uses: "Device events and cause evidence (link down, BGP transitions).",
    source: "SNMP Traps extension (com.dynatrace.extension.snmp-traps-generic). Traps arrive as logs with log.source = snmptraps.",
    prerequisites: ["ActiveGate with the extension activated, reachable from the devices on UDP 162."],
    steps: [
      "Activate the SNMP Traps extension on the ActiveGate group and configure the SNMP versions and credentials you use.",
      "Point each device's trap destination to the ActiveGate IP, sending from the polled device IP.",
    ],
    verify: "fetch logs, from:now()-24h\n| filter log.source == \"snmptraps\"\n| summarize traps = count(), by:{device.address, snmp.trap_oid}",
    docs: [DOCS.traps],
  },
  lldp: {
    uses: "Topology between devices when sites have no WAN inventory.",
    source: "neighbor-discovery feature set of the SNMP extension (LLDP and CDP).",
    prerequisites: ["LLDP or CDP enabled on the devices."],
    steps: ["Enable the feature set neighbor-discovery."],
    verify: "fetch metric.series\n| filter endsWith(metric.key, \"lldp_neighbor\")\n| fields sys.name, neighbor.sys.name",
    docs: [DOCS.snmpCisco],
  },
  routing: {
    uses: "Tunnel state on each site path (BGP established or down) and the Internet hop.",
    source: "Cisco BGP and OSPF feature sets of the SNMP extension.",
    prerequisites: ["Network devices set up."],
    steps: ["Enable the feature sets Cisco BGP (or BGP) and OSPF."],
    verify: "fetch metric.series\n| filter contains(metric.key, \"cbgp.peer\") or contains(metric.key, \"ospf.nbr\")\n| fields metric.key, sys.name",
    docs: [DOCS.snmpCisco],
  },
  netflow: {
    uses: "Optional. The app already reads traffic per exporter, protocol and top talkers, but no page shows it yet.",
    source: "OpenTelemetry Collector with the netflow receiver (NetFlow v5, v9, IPFIX or sFlow). Flows arrive as logs with otel.scope.name = otelcol/netflowreceiver.",
    prerequisites: ["Dynatrace OpenTelemetry Collector reachable from the exporters on UDP 2055.", "Platform token with log ingest permission."],
    steps: [
      "Deploy the collector with the configuration below.",
      "Point each router's flow export to the collector. Include the input and output interface index in the template, so flows map to interfaces (flow.in_if, flow.out_if).",
      "If exporters sample, flows carry flow.sampling_rate; volumes in the app aren't scaled by it.",
    ],
    snippets: [{
      title: "Collector configuration",
      language: "yaml",
      code: `receivers:
  netflow:
    hostname: "0.0.0.0"
    scheme: netflow
    port: 2055
    sockets: 2
    workers: 4
exporters:
  otlp_http:
    endpoint: \${env:DT_ENDPOINT}
    headers:
      Authorization: "Bearer \${env:DT_PLATFORM_TOKEN}"
service:
  pipelines:
    logs:
      receivers: [netflow]
      processors: [batch]
      exporters: [otlp_http]`,
    }],
    verify: "fetch logs, from:now()-1h\n| filter otel.scope.name == \"otelcol/netflowreceiver\"\n| summarize flows = count(), by:{flow.sampler_address}",
    docs: [DOCS.netflow],
  },
  appFlows: {
    uses: "Application hop at the end of each site path: conversations and TCP retransmissions of the application hosts.",
    source: "OneAgent network connection monitoring. Flows are stored as events in the bucket default_network_flows.",
    prerequisites: ["OneAgent 1.337 or later on the application hosts (Linux, Windows or AIX)."],
    steps: [
      "Go to Settings > Collect and capture > Infrastructure > Network connection monitoring and enable it for the application hosts.",
      "By default only critical connections are reported, up to 100 records per minute per host; widen the filter if you need full volumes.",
    ],
    verify: "fetch events, from:now()-1h, bucket:{\"default_network_flows\"}\n| summarize conversations = count(), by:{host.name}",
    docs: [DOCS.oneagentFlows],
  },
  sessions: {
    uses: "Isolating the network in or out: whether the people using the applications were still there while the network misbehaved. The app reads session counts only — no application detail, no page or transaction data.",
    source: "Real User Monitoring on the web and mobile applications people use at the sites. Only real user sessions are read; robots and synthetic sessions are filtered out.",
    prerequisites: [
      "RUM enabled on the applications used at the sites (web, mobile or both).",
      "For a reading per site: the client subnet of each site has to be recognizable — either a site_cidr primary tag on the site's SNMP monitoring configuration, or a device at that site in the same /24 as its users.",
      "For the drop itself to be the platform's judgement and not the app's: traffic anomaly detection enabled on those applications.",
    ],
    steps: [
      "Enable Real User Monitoring on the applications people use at the sites.",
      "Add the primary tag site_cidr to each site's monitoring configuration with the user subnets of that site, comma separated (for example 10.174.48.0/24,10.174.56.0/24). Without it, the app only attributes a session to a site when a device at the site sits in the same /24 as the users, and everything else is counted for the environment.",
      "In the application settings, keep anomaly detection for traffic enabled, so Dynatrace raises Unexpected low traffic itself. Without it the app still measures the drop, but says so — it reports a suspicion, not a problem.",
    ],
    snippets: [{
      title: "Sessions per hour, as the app reads them",
      language: "dql",
      code: 'fetch user.sessions, from:now()-24h\n| filter dt.rum.user_type == "real_user"\n| makeTimeseries sessions = count(), interval:1h, by:{dt.rum.application.type}',
    }],
    verify: "Settings shows the sessions received in the last 24 h and whether any client subnet could be matched to a site.",
    docs: [DOCS.rum, DOCS.rumAnomaly],
  },
  requests: {
    uses: "Isolating the network in or out when there is no Real User Monitoring: whether the services the sites reach are still being asked for work. Read as a count per hour only.",
    source: "OneAgent on the services (the built-in metric dt.service.request.count).",
    prerequisites: ["OneAgent on the hosts that run the services people use at the sites."],
    steps: [
      "Nothing to configure beyond OneAgent: the request count is a built-in service metric.",
      "The app reads it for the whole environment. It is used when user sessions are missing; with both, sessions come first because they are the people themselves.",
      "For the drop to be Dynatrace's judgement, keep anomaly detection for load on the services, so Davis raises Unexpected low load itself.",
    ],
    snippets: [{ title: "Requests per hour, as the app reads them", language: "dql", code: "timeseries req = sum(dt.service.request.count), from:now()-24h, interval:1h" }],
    verify: "Settings shows how many requests the services served in the last hour.",
    docs: [],
  },
  assist: {
    uses: "Explanations, impact and next steps written by Dynatrace Intelligence on every page.",
    source: "Dynatrace Assist, called by the app with only the evidence shown on screen.",
    prerequisites: ["Dynatrace Assist enabled in the environment.", "Users allowed to run conversations (davis-copilot:conversations:execute)."],
    steps: [
      "Grant the policy statement ALLOW davis-copilot:conversations:execute to the users of the app.",
      "The app sends device names, roles, status and reasons as context. That context isn't anonymized; IP addresses aren't sent.",
    ],
    verify: "",
    docs: [DOCS.intelligence],
  },
};

/** App-level configuration: permissions requested by the app and why. */
export const APP_PERMISSIONS: { scope: string; why: string }[] = [
  { scope: "storage:smartscape:read", why: "Network devices and interfaces (EXT_NETWORK_DEVICE, EXT_NETWORK_INTERFACE)." },
  { scope: "storage:metrics:read", why: "SNMP traffic, errors, CPU and availability, and synthetic ICMP latency and loss." },
  { scope: "storage:logs:read", why: "Syslog, SNMP traps and NetFlow records." },
  { scope: "storage:events:read", why: "OneAgent network flows in the bucket default_network_flows." },
  { scope: "storage:buckets:read", why: "Reading the buckets that hold the data above." },
  { scope: "storage:system:read", why: "System tables used by DQL." },
  { scope: "davis-copilot:conversations:execute", why: "Explanations by Dynatrace Intelligence." },
];

/** Pages of the app and the data each one reads, in the order the user meets them. */
export const PAGE_NEEDS: { page: string; purpose: string; keys: NeedKey[] }[] = [
  { page: "Live map", purpose: "Sites on the map, WAN routes to the data centers, and the open problems Dynatrace raised on the elements behind each site.", keys: ["alerts", "devices", "sites", "wan", "icmp", "traffic", "syslog", "traps", "lldp", "appFlows", "assist"] },
  { page: "Sites", purpose: "Sites by region and carrier, their status and the problem that explains it.", keys: ["alerts", "devices", "sites", "wan", "icmp", "appFlows", "assist"] },
  { page: "Devices", purpose: "Devices by role, CPU, availability, interfaces and events.", keys: ["alerts", "devices", "interfaces", "traffic", "cpu", "availability", "syslog", "traps", "assist"] },
  { page: "WAN links", purpose: "Every circuit against its SLA, grouped by carrier. The page stays open and explains what to send until circuits exist.", keys: ["alerts", "wan", "icmp", "syslog", "assist"] },
  { page: "Site and device details", purpose: "End-to-end path, device strips, links against SLA, instruments and events.", keys: ["alerts", "devices", "interfaces", "traffic", "cpu", "availability", "icmp", "wan", "syslog", "traps", "lldp", "routing", "appFlows", "assist"] },
];

/** The data types grouped as an operator reads them, in the order they matter for the app. */
export const DATA_GROUPS: { title: string; hint: string; keys: NeedKey[] }[] = [
  { title: "Inventory", hint: "What exists in the network and where it is", keys: ["devices", "sites", "interfaces"] },
  { title: "Health and load", hint: "How each device and interface is doing", keys: ["cpu", "availability", "traffic"] },
  { title: "Reachability and WAN", hint: "Whether sites answer and how their links behave", keys: ["icmp", "wan"] },
  { title: "Alerts and events", hint: "What Dynatrace is alerting on, and what the devices report themselves", keys: ["alerts", "syslog", "traps"] },
  { title: "Topology and routing", hint: "How devices connect to each other", keys: ["lldp", "routing"] },
  { title: "Traffic and applications", hint: "Where the traffic goes and how applications feel it", keys: ["appFlows", "netflow"] },
  { title: "User impact", hint: "Whether what the network did reached the people using the applications", keys: ["sessions", "requests"] },
  { title: "Intelligence", hint: "Explanations written by Dynatrace Intelligence", keys: ["assist"] },
];
