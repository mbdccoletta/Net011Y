// DQL used by NetworkO11y. Every query was validated on guu84124 (2026-09-14).
// Metric keys that contain hyphens must be backticked inside `timeseries`,
// otherwise Grail answers MANDATORY_PARAMETER_HAS_TO_BE.
import { familyQueries, vlanQuery } from "./formats";

export interface NetQuery {
  query: string;
  maxResultRecords?: number;
  /**
   * The query must return the whole estate: if it comes back at its cap, the app is missing elements and
   * says so. Top-N queries (the last traps, the busiest flows) are capped on purpose and are not marked.
   */
  complete?: boolean;
  /**
   * Per-interface detail. In an estate with thousands of devices these are the queries that would pull
   * hundreds of thousands of rows into the browser, so they only run while the estate is small enough;
   * above that the app reads the per-device summaries below and fetches one device's interfaces when
   * somebody opens it.
   */
  detail?: boolean;
}

const CIRCUIT_TAGS = "primary_tags.site, primary_tags.circuit_id, primary_tags.circuit_role, primary_tags.carrier, primary_tags.circuit_tech, primary_tags.sla_ms, primary_tags.bandwidth_mbps";

/** Hours of syslog and traps read on load; the device timeline can ask for 24 h of one device. */
export const DEVICE_LOG_HOURS = 6;
/** The 24 h of one device, run only on request: it scans 24 h of logs like the load used to. */
export const deviceLogs24h = (ip: string) =>
  `fetch logs, from:now()-24h | filter dt.openpipeline.source == "extension:syslog" or log.source == "snmptraps" | fieldsAdd kind = if(log.source == "snmptraps", "trap", else:"syslog"), ip = coalesce(dt.ingest.source.ip, device.address) | filter ip == "${ip.replace(/[^0-9a-fA-F.:]/g, "")}" | makeTimeseries n = count(), by:{kind, loglevel}, interval:1h`;

export const QUERIES: Record<string, NetQuery> = {
  // Open Davis problems, matched to devices by their Smartscape or classic entity id (drill-down to Problems)
  problems: {
    complete: true,
    query: 'fetch dt.davis.problems, from:now()-24h | filter event.status == "ACTIVE" and not(dt.davis.is_duplicate) | fields event.id, event.kind, display_id, event.name, event.start, event.category, dt.davis.mute.status, dt.davis.event_ids, smartscape.affected_entity.ids, smartscape.affected_entities, dt.smartscape_source.id, root_cause.smartscape_entity, event.severity, maintenance.is_under_maintenance, affected_entity_ids, affected_entity_names | sort event.start desc | limit 5000',
    maxResultRecords: 5000,
  },
  // Real user sessions, for the one question this app asks about them: did what the network did reach the
  // people? Robots and synthetic sessions are excluded, because they do not notice an outage.
  // (validated on eob14444, bwm98081 and guu84124, 2026-09-17: `timeseries` is a metric command and fails
  // here, the records have to go through makeTimeseries.)
  sessions: {
    complete: true,
    query: 'fetch user.sessions, from:now()-24h | filter dt.rum.user_type == "real_user" | makeTimeseries sessions = count(), interval:1h, by:{dt.rum.application.type}',
    maxResultRecords: 100,
  },
  // The same count over a week, so "now" can be read against what that hour of the day usually looks like
  sessionsTypical: {
    complete: true,
    query: 'fetch user.sessions, from:now()-7d | filter dt.rum.user_type == "real_user" | makeTimeseries sessions = count(), interval:1h',
    maxResultRecords: 100,
  },
  // Where the sessions come from. The app only attributes a session to a site when the client subnet
  // matches exactly (a site_cidr tag, or the /24 of a device at that site); everything else stays at
  // environment level instead of being guessed.
  sessionNets: {
    query: 'fetch user.sessions, from:now()-24h | filter dt.rum.user_type == "real_user" | summarize sessions = count(), by:{ip = client.ip} | sort sessions desc | limit 200',
    maxResultRecords: 200,
  },
  // Requests served, for environments without Real User Monitoring: the same "is anyone still getting
  // through" question, asked of the services (validated on guu84124 and bwm98081, 2026-09-18).
  requests: {
    complete: true,
    query: "timeseries req = sum(dt.service.request.count), from:now()-24h, interval:1h",
    maxResultRecords: 10,
  },
  requestsTypical: {
    complete: true,
    query: "timeseries req = sum(dt.service.request.count), from:now()-7d, interval:1h",
    maxResultRecords: 10,
  },
  devices: { complete: true, query: "smartscapeNodes EXT_NETWORK_DEVICE", maxResultRecords: 50000 },
  interfaces: { complete: true, query: "smartscapeNodes EXT_NETWORK_INTERFACE", maxResultRecords: 150000, detail: true },
  // Every metric family of the Dynatrace network extensions, from one catalog (formats.ts): one query per
  // family and measure, named "<measure>:<family>", so they run side by side. A family the environment does
  // not send answers at once with nothing.
  ...Object.fromEntries(([
    ["ifTraffic", { complete: true, detail: true, maxResultRecords: 60000 }],
    ["ifErrors", { complete: true, detail: true, maxResultRecords: 60000 }],
    ["ifSummary", { complete: true, maxResultRecords: 50000 }],
    ["errSummary", { complete: true, maxResultRecords: 50000 }],
    ["cpu", { complete: true, maxResultRecords: 50000 }],
    ["memory", { complete: true, maxResultRecords: 50000 }],
    ["uptime", { complete: true, maxResultRecords: 50000 }],
  ] as const).flatMap(([m, opts]) => familyQueries(m).map(([name, query]) => [name, { ...opts, query }]))),
  vlans: { query: vlanQuery(), maxResultRecords: 20000 },
  // Inventory arrives as primary Grail tags: site tags on the SNMP monitoring configurations,
  // circuit tags (carrier, role, SLA) on the ICMP network availability monitor of each WAN circuit.
  alerts: {
    complete: true,
    query: 'fetch dt.davis.events, from:now()-1h | filter event.status == "ACTIVE" and event.kind == "DAVIS_EVENT" and not(event.type == "PROBLEM_UPDATE" or event.type == "CUSTOM_INFO" or event.type == "CUSTOM_ANNOTATION" or event.type == "CUSTOM_DEPLOYMENT" or event.type == "CUSTOM_CONFIGURATION") | fields event.id, event.kind, event.type, event.name, event.category, event.start, event.severity, maintenance.is_under_maintenance, dt.davis.mute.status, dt.source_entity, dt.smartscape_source.id, smartscape.affected_entities, affected_entity_ids, affected_entity_names, dt.smartscape.ext_network_device, dt.smartscape.ext_network_interface, dt.entity.multiprotocol_monitor | sort event.start desc | limit 5000',
    // a busy environment holds thousands of open events (fxz0998d: over 2000 interface events): the cap
    // matches the query's own limit so none is dropped silently
    maxResultRecords: 5000,
  },
  icmp: {
    complete: true,
    query: `timeseries {rtt=avg(dt.synthetic.multi_protocol.icmp.round_trip_time), sent=sum(dt.synthetic.multi_protocol.icmp.packets_sent), recv=sum(dt.synthetic.multi_protocol.icmp.packets_received)}, by:{request.target_address, monitor.name, dt.entity.multiprotocol_monitor, dt.entity.synthetic_location, ${CIRCUIT_TAGS}}, from:now()-24h, interval:1h`,
    maxResultRecords: 40000,
  },
  // The last two hours in 5-minute steps: when a device or circuit stopped answering.
  icmpNow: {
    complete: true,
    query: `timeseries {rtt=avg(dt.synthetic.multi_protocol.icmp.round_trip_time), sent=sum(dt.synthetic.multi_protocol.icmp.packets_sent), recv=sum(dt.synthetic.multi_protocol.icmp.packets_received)}, by:{request.target_address, monitor.name, dt.entity.multiprotocol_monitor, dt.entity.synthetic_location, ${CIRCUIT_TAGS}}, from:now()-2h, interval:5m`,
    maxResultRecords: 40000,
  },
  // What the devices say about themselves: syslog and SNMP traps read once over the last DEVICE_LOG_HOURS,
  // counted per device, kind and level in 15-minute steps (the device timeline and the counters), and once
  // over 3 h for the latest records themselves. Grail bills the whole window whatever the filter, so the
  // 24 h view of one device is read only when someone asks for it (deviceLogs24h).
  deviceLogs: {
    query: 'fetch logs, from:now()-6h | filter dt.openpipeline.source == "extension:syslog" or log.source == "snmptraps" | fieldsAdd kind = if(log.source == "snmptraps", "trap", else:"syslog"), ip = coalesce(dt.ingest.source.ip, device.address) | makeTimeseries n = count(), by:{ip, kind, loglevel}, interval:15m',
    maxResultRecords: 10000,
  },
  deviceLogsRecent: {
    query: 'fetch logs, from:now()-3h | filter (dt.openpipeline.source == "extension:syslog" and dt.ingest.source.ip != "127.0.0.1") or log.source == "snmptraps" | sort timestamp desc | fields timestamp, kind = if(log.source == "snmptraps", "trap", else:"syslog"), ip = coalesce(dt.ingest.source.ip, device.address), loglevel, app = syslog.appname, oid = snmp.trap_oid, content | limit 2000',
    maxResultRecords: 2000,
  },
  // the documented topology of network extensions: Smartscape "calls" between network devices and
  // between network interfaces (filled by extensions that define it); the neighbour logs below add what
  // it does not hold
  netEdges: {
    query: 'smartscapeEdges calls | filter source_type == "EXT_NETWORK_DEVICE" or source_type == "EXT_NETWORK_INTERFACE" | fields source_id, source_type, target_id, target_type',
    maxResultRecords: 50000,
  },
  lldp: {
    query: 'fetch metric.series | filter endsWith(metric.key, "lldp_neighbor") | fields sys.name, neighbor.sys.name, neighbor.port.id',
    maxResultRecords: 2000,
  },
  // who is cabled to whom: the CDP/LLDP neighbours the SNMP autodiscovery records port by port, every
  // 10 minutes (so half an hour holds the latest of each)
  neighbors: {
    query: 'fetch logs, from:now()-30m | filter log.source == "snmp_autodiscovery" and content == "Neighbor discovery" | summarize seen = max(timestamp), by:{dt.smartscape.ext_network_device, dt.smartscape.ext_network_interface, base.interface.name, neighbor.ext_network_device, neighbor.device.name, neighbor.interface.name, neighbor.protocol}',
    maxResultRecords: 20000,
  },
  routing: {
    query: 'fetch metric.series | filter contains(metric.key, "cbgp.peer") or contains(metric.key, "ospf.nbr") | fields metric.key, sys.name, cbgp.remote.identifier, cbgp.remote.as, cbgp.peer.state, ospf.nbr.ip.addr, ospf.nbr.state',
    maxResultRecords: 2000,
  },
  flowTs: {
    query: 'fetch logs, from:now()-70m | filter otel.scope.name == "otelcol/netflowreceiver" | makeTimeseries flows=count(), by:{exp=flow.sampler_address}, interval:5m',
    maxResultRecords: 500,
  },
  // who talks to whom: the last hour of NetFlow by exporter and /24 at each end, heaviest first
  flowNets: {
    query: 'fetch logs, from:now()-1h | filter otel.scope.name == "otelcol/netflowreceiver" | fieldsAdd s24 = ipMask(source.address, 24), d24 = ipMask(destination.address, 24) | summarize bytes = sum(toLong(flow.io.bytes)), flows = count(), by:{exp = flow.sampler_address, s24, d24, proto = network.transport, dport = destination.port, in_if = flow.in_if, out_if = flow.out_if} | sort bytes desc | limit 5000',
    maxResultRecords: 5000,
  },
  // many talking to one: a range reached from an unusual number of distinct Internet sources (a busy
  // internal service reached by every branch is normal, so private sources are left out)
  flowFanIn: {
    query: 'fetch logs, from:now()-1h | filter otel.scope.name == "otelcol/netflowreceiver" | filter not(ipIn(source.address, array("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"))) | summarize srcs = countDistinct(source.address), dsts = countDistinct(destination.address), bytes = sum(toLong(flow.io.bytes)), flows = count(), by:{exp = flow.sampler_address, dst = ipMask(destination.address, 24), dport = destination.port} | filter srcs >= 100 | sort srcs desc | limit 20',
    maxResultRecords: 20,
  },
  // SNMP interface index to port name, from the series metadata (no log scan): it ties a flow's
  // flow.in_if / flow.out_if to the port the app measures
  ifIndex: {
    query: 'fetch metric.series, from:now()-2h | filter isNotNull(if.idx) and (endsWith(metric.key, "if.hc.in.octets.count") or endsWith(metric.key, "if.in.octets.count")) | fields device.address, if.idx, if.name | dedup {device.address, if.idx}',
    maxResultRecords: 50000,
  },
  // the quality of each path: a workload and the network at the other end of its connections, with the
  // service port. The remote end is the source when the process serves, the destination when it calls.
  appPaths: {
    query: 'fetch events, from:now()-1h, bucket:{"default_network_flows"} | filter network_flow.network.type == "IPV4" | fieldsAdd server = network_flow.process_is_server == true | fieldsAdd remote = if(server, network_flow.source.address, else:network_flow.destination.address), grp = coalesce(k8s.cluster.name, dt.host_group.id, host.name), rtt = if(toLong(network_flow.tcp.rtt) > 0, toLong(network_flow.tcp.rtt)), pk = toLong(network_flow.packets.tx) + toLong(network_flow.packets.rx), re = toLong(network_flow.packets.retransmitted.tx) + toLong(network_flow.packets.retransmitted.rx) | summarize conv = count(), rtt90 = percentile(rtt, 90), pk = sum(pk), re = sum(re), resets = sum(toLong(network_flow.tcp.sessions.reset)), timeouts = sum(toLong(network_flow.tcp.sessions.timeout)), by:{grp, server, r24 = ipMask(remote, 24), port = network_flow.destination.port} | sort conv desc | limit 3000',
    maxResultRecords: 3000,
  },
  // how the network feels from the applications: TCP retransmissions and round trip, every 10 minutes
  appNet: {
    query: 'fetch events, from:now()-8h, bucket:{"default_network_flows"} | fieldsAdd pk = toLong(network_flow.packets.tx) + toLong(network_flow.packets.rx), re = toLong(network_flow.packets.retransmitted.tx) + toLong(network_flow.packets.retransmitted.rx), rtt = if(toLong(network_flow.tcp.rtt) > 0, toLong(network_flow.tcp.rtt)) | makeTimeseries {pk = sum(pk), re = sum(re), rtt = percentile(rtt, 90), conv = count()}, interval:10m',
    maxResultRecords: 10,
  },
  // where OneAgent network flows are not enabled, the classic per-process network metrics say the same
  appNetProc: {
    query: 'timeseries {pk = sum(dt.process.network.packets.tx), re = sum(dt.process.network.packets.re_tx), rtt = avg(dt.process.network.round_trip)}, from:now()-8h, interval:10m',
    maxResultRecords: 10,
  },
  appNetProcBy: {
    query: 'timeseries {pk = sum(dt.process.network.packets.tx), re = sum(dt.process.network.packets.re_tx), rtt = avg(dt.process.network.round_trip)}, by:{dt.host_group.id}, from:now()-7h, interval:1h | sort arraySum(pk) desc | limit 200',
    maxResultRecords: 200,
  },
  // the same, per workload (cluster, host group or host): the last hour against the six before it
  appNetBy: {
    query: 'fetch events, from:now()-7h, bucket:{"default_network_flows"} | fieldsAdd pk = toLong(network_flow.packets.tx) + toLong(network_flow.packets.rx), re = toLong(network_flow.packets.retransmitted.tx) + toLong(network_flow.packets.retransmitted.rx), rtt = if(toLong(network_flow.tcp.rtt) > 0, toLong(network_flow.tcp.rtt)), recent = timestamp >= now() - 1h, grp = coalesce(k8s.cluster.name, dt.host_group.id, host.name) | summarize pk = sum(pk), re = sum(re), rtt = percentile(rtt, 90), conv = count(), by:{grp, recent} | sort conv desc | limit 200',
    maxResultRecords: 200,
  },
  cloud: {
    query: 'fetch events, from:now()-24h, bucket:{"default_network_flows"} | summarize conv=count(), hosts=countDistinct(dt.smartscape.host), procs=countDistinct(dt.smartscape.process), bytes=sum(toLong(network_flow.bytes.tx)+toLong(network_flow.bytes.rx)), retr=sum(toLong(network_flow.packets.retransmitted.tx)+toLong(network_flow.packets.retransmitted.rx)), pkts=sum(toLong(network_flow.packets.tx)+toLong(network_flow.packets.rx)), by:{cluster=k8s.cluster.name, cloud=cloud.provider}',
    maxResultRecords: 200,
  },
  cloudTop: {
    query: 'fetch events, from:now()-24h, bucket:{"default_network_flows"} | summarize tx=sum(toLong(network_flow.bytes.tx)), rx=sum(toLong(network_flow.bytes.rx)), retr=sum(toLong(network_flow.packets.retransmitted.tx)), resets=sum(toLong(network_flow.tcp.sessions.reset)), by:{host=host.name, cluster=k8s.cluster.name, dst=network_flow.destination.address, dport=network_flow.destination.port} | fieldsAdd bytes=tx+rx | sort bytes desc | limit 40',
    maxResultRecords: 40,
  },
};

export type QueryName = keyof typeof QUERIES;
