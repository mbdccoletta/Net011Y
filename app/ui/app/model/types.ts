// NetO11y data model. Every screen reads this shape, whether it was built from
// live DQL results (buildRealModel) or from the bundled, clearly labelled example.

export type Verdict = "Critical" | "Warning" | "Healthy" | "Not monitored";

/** What an alert outside the network inventory is about, for isolating the network in or out. */
export type NonNetworkScope = "application" | "service" | "host" | "other";

export interface Reason {
  level: Verdict;
  text: string;
  consequence?: boolean;
  device?: string;
  circuit?: string;
}

/** One side of a site's conversations: another site, the Internet, or a private range no site claims. */
export interface FlowPeer { kind: "site" | "private" | "internet"; name: string; site?: string; bytes: number; flows: number }
export interface FlowApp { proto: string; port: string; name: string | null; bytes: number; flows: number }
/** What a firewall refused in the last hour, by zone pair and port. */
export interface FlowDeny { via: string; viaName: string; site: string | null; from: string; to: string; proto: string; port: string; denies: number; sources: number; destinations: number }
/** One conversation group, whichever source saw it, with both ends already placed. */
export interface Conversation {
  source: "netflow" | "firewall";
  /** the exporter or firewall that saw it: address, name, site and role */
  via: string; viaName: string; viaSite: string | null; viaKind: "exporter" | "firewall";
  fromKind: "site" | "zone" | "internet" | "private"; fromSite?: string; fromLabel: string;
  toKind: "site" | "zone" | "internet" | "private"; toSite?: string; toLabel: string;
  zoneFrom?: string; zoneTo?: string;
  app: string; proto: string; port: string;
  s24: string; d24: string;
  bytes: number; count: number;
}
/** One column entry of the traffic journey (from, through, to). */
export interface JourneyNode { id: string; col: 0 | 1 | 2; label: string; sub?: string; kind: "site" | "zone" | "internet" | "private" | "device" | "app" | "denied"; site?: string; bytes: number }
export interface JourneyLink { from: string; to: string; bytes: number; count: number; source: "netflow" | "firewall" }
/** A destination reached from an unusual number of distinct sources in the last hour. */
export interface FlowFanIn { dst: string; hosts: number; port: string; sources: number; bytes: number; flows: number; exporter: string }
export interface SiteTraffic {
  bytes: number;
  flows: number;
  /** bytes by where the other end is */
  toSites: number;
  internet: number;
  private: number;
  local: number;
  peers: FlowPeer[];
  apps: FlowApp[];
  fanIn: FlowFanIn[];
  exporters: string[];
  denies: FlowDeny[];
}
/** NetFlow / IPFIX over the last hour, attributed to sites through their exporters and address space. */
export interface FlowMap {
  windowMs: number;
  exporters: { ip: string; device: string | null; site: string | null; flows5m: number | null; usual5m: number | null; falling: boolean }[];
  /** traffic between two sites, both ends attributed */
  pairs: { a: string; b: string; bytes: number; flows: number }[];
  sites: Record<string, SiteTraffic>;
  /** bytes seen by exporters that belong to no known device */
  unattributed: number;
  subnetsKnown: number;
  subnetsTagged: number;
  /** which sources fed it, with what they carried */
  sources: { netflow?: { exporters: number; bytes: number }; firewall?: { firewalls: number; bytes: number; connections: number; denies: number; capped: boolean } };
  denies: FlowDeny[];
  /** every conversation group the sources returned, placed: the journey and the filters are built from it */
  conversations: Conversation[];
  /** from → through → to, the heaviest paths, in bytes; denied attempts join as their own destination */
  journey: { nodes: JourneyNode[]; links: JourneyLink[] };
}

export interface AppNetwork {
  /** which OneAgent data it comes from: network flows (events) or the classic per-process network metrics */
  source: "flows" | "process metrics";
  /** what rttMs holds: the 90th percentile of the flows, or the average of the process metrics */
  rttKind: "p90" | "avg";
  /** start of the first 10-minute bucket (ms) and bucket length */
  start: number;
  interval: number;
  /** retransmitted packets as a percentage of all packets, per bucket; null when nothing was sent */
  retrPct: (number | null)[];
  retransmitted: number[];
  /** 90th percentile TCP round trip in milliseconds, per bucket */
  rttMs: (number | null)[];
  conversations: number[];
  /** per workload: the last hour against the six hours before it */
  workloads: { name: string; retrNow: number | null; retrUsual: number | null; rttNow: number | null; rttUsual: number | null; conversations: number }[];
}

export interface Iface {
  /** Smartscape node id (EXT_NETWORK_INTERFACE-…), when known */
  id?: string;
  name: string;
  speed: number | null;
  oper: string;
  admin: string;
  type?: string;
  util: number | null;
  in: number[];
  out: number[];
  errors: number;
  discards: number;
  crc: number;
  uplink: boolean;
  flag: "inconsistent" | "saturated" | "high" | null;
}

export interface NetEvent {
  t: string;
  kind: "syslog" | "trap";
  level: string;
  mnemonic: string | null;
  sev: number | null;
  text: string;
}

export interface Icmp {
  /** Network availability monitor that pings this target (MULTIPROTOCOL_MONITOR-…) */
  monitorId?: string;
  rttMs: number | null;
  rtt: number[];
  loss: number | null;
  sent?: number;
}

/** An open Davis problem or alert affecting an entity (opens in the Problems app). */
export interface DeviceProblem {
  eventId: string;
  eventKind: string;
  displayId: string;
  name: string;
  start: string;
  /** AVAILABILITY, ERROR, SLOWDOWN, RESOURCE_CONTENTION, CUSTOM_ALERT … as Davis classifies it */
  category?: string;
  /** true while the problem is muted in Dynatrace: the app ignores it, like the platform does */
  muted?: boolean;
  /** the affected entity this problem was matched through, e.g. an interface name */
  on?: string;
  /**
   * Why an alert is not on the map, when it is not:
   * "network" — it names a network entity (a monitor, a device, an interface) that this environment's
   *   inventory does not contain, so the app can see it but cannot place it;
   * "environment" — it names no entity at all, typically a metric event bound to the environment;
   * "application" / "service" / "host" / "other" — it belongs to another domain. The app shows no detail
   *   of these: it counts them, so it can say whether something outside the network is alerting too, and
   *   links out to the native app for the detail.
   */
  scope?: "network" | "environment" | NonNetworkScope;
  /** what the alert says it affects, so the app can name it even when it cannot place it */
  entities?: string[];
}

export interface Device {
  id: string;
  /** Classic entity id (CUSTOM_DEVICE-…) that Davis problems may reference */
  idClassic?: string;
  /** Chassis MAC: the interface nodes of this device carry it, so its ports can be fetched on demand */
  chassisMac?: string;
  problems?: DeviceProblem[];
  name: string;
  site: string;
  /** every address the device carries (all interfaces), when autodiscovery lists them */
  ips?: string[];
  role: string;
  vendor: string;
  ip: string;
  mode: string;
  desc: string;
  location?: string | null;
  ifCount: number;
  cpu: number[];
  cpuNow: number | null;
  availPct: number | null;
  availTs?: number[] | null;
  syslog: { ERROR: number; WARN: number; INFO: number };
  syslogErrTs: number[];
  /** traps received per hour over the last 24 h */
  trapTs?: number[];
  traps: number;
  events: NetEvent[];
  interfaces: Iface[];
  /** Per-device interface summary, used when the estate is too large to fetch every port */
  ifStats?: { maxUtil: number | null; interfaces: number; errors: number; discards: number };
  reasons: Reason[];
  verdict: Verdict;
  impact: number;
  icmp: Icmp | null;
  incident?: string;
  unreachableSince?: string;
}

export interface Circuit {
  id: string;
  /** Network availability monitor of the circuit (MULTIPROTOCOL_MONITOR-…) */
  monitorId?: string;
  /** Open Davis problems on the circuit's monitor */
  problems?: DeviceProblem[];
  site: string;
  siteName: string;
  kind: "primary" | "backup";
  carrier: string;
  tech: string;
  slaMs: number;
  latencyMs: number | null;
  /** Round-trip time per hour over the last 24 h; null where the circuit did not answer */
  rttTs?: (number | null)[];
  lossPct: number | null;
  jitterMs: number | null;
  status: "up" | "down";
  since?: string;
  incident?: string;
  note?: string;
  verdict: Verdict;
  reasons: Reason[];
}

export interface Peer {
  device: string;
  proto: "BGP" | "OSPF";
  peer: string;
  remoteAs: string | null;
  state: string | null;
}

export interface HopStats {
  rttMax?: number | null;
  lossMax?: number | null;
  availMin?: number | null;
  cpuMax?: number | null;
  utilMax?: number | null;
  uplErr?: number;
  uplDown?: number;
  blind?: string[];
  critEvents?: number;
  total?: number;
  unreachable?: number;
  p90Ms?: number | null;
  errPct?: number | null;
  sessions?: number | null;
  conv?: number;
  hosts?: number;
  procs?: number;
  up?: number;
  links?: number;
  jitterMax?: number | null;
}

export interface AppTransaction {
  name: string;
  p90Ms: number | null;
  errPct: number | null;
  count: number;
  p90Ts: number[];
}

export interface AppExperience {
  name: string;
  sessions: number;
  /** Typical sessions per hour from the site, used to size what an outage costs */
  baselineSessions?: number;
  p90Ms: number | null;
  errPct: number | null;
  consequenceOf: string | null;
  transactions: AppTransaction[];
}

export interface CloudCluster {
  name: string;
  cloud: string | null;
  conv: number;
  hosts: number;
  procs: number;
  bytes: number;
  retrPct: number | null;
  rttMs: number | null;
}

export interface Hop {
  kind: "devices" | "circuit" | "app" | "internet" | "cloud";
  layer: string;
  title: string;
  site: string;
  verdict: Verdict;
  headline: { value: number | string | null; unit: string; label: string };
  stats: HopStats;
  devices: string[];
  topReason: string | null;
  consequenceOnly?: boolean;
  incidents?: string[];
  circuits?: Circuit[];
  app?: AppExperience;
  peers?: Peer[];
  clusters?: CloudCluster[];
  latVerdict?: Verdict;
}

export interface PathLink {
  kind: "lan" | "wan" | "bgp" | "flow";
  verdict: Verdict;
  label: string;
  facts: string[];
}

export interface PathSummary {
  verdict: Verdict;
  firstBad: number | null;
  consequenceHops: number;
  hops: number;
  healthyHops: number;
  rttMax: number | null;
  lossMax: number | null;
  availMin: number | null;
  blind: string[];
  critEvents: number;
  devices: number;
  incident: string | null;
  latVerdict: Verdict;
}

export interface E2EPath {
  id: string;
  name: string;
  site: string | null;
  hops: Hop[];
  links: PathLink[];
  summary: PathSummary;
}

export interface Site {
  code: string;
  name: string;
  city?: string;
  uf?: string;
  id?: string;
  dc?: boolean;
  /** Region used to group sites (from a site table, tags or known location names). */
  region?: string;
  /** Data center the site's WAN links terminate on. */
  hub?: string;
  x?: number;
  y?: number;
  lat?: number;
  lon?: number;
  /** "state" when nothing gave the site's coordinates and it is drawn at the centre of its state */
  approx?: "state";
  wanVerdict?: Verdict;
  /** Primary Grail tags of the site's devices (primary_tags.<key> → value), most common value per key */
  tags?: Record<string, string>;
}

export interface FlowExporter {
  ip: string;
  device: string | null;
  flows5m: number[];
  protocols: { proto: string; gb: number; flows: number }[];
}

/**
 * Real user sessions, kept deliberately thin: the app does not report on applications, it only needs to
 * know whether people were still using them while the network misbehaved.
 */
export interface Users {
  /** "site" when at least one client subnet maps to a site exactly, "environment" otherwise */
  scope: "site" | "environment";
  /** sessions per hour over the last 24 h, oldest first; null where the hour has no data yet */
  series: (number | null)[];
  /** what that hour of the day usually looks like, from the last 7 days (median per hour of day) */
  typical: number[];
  /** the settled hour the reading is taken from (an index into series), and its sessions and typical */
  nowIndex: number;
  now: number | null;
  typicalNow: number | null;
  /** sessions per application type over 24 h, e.g. { web: 567 } */
  byType: Record<string, number>;
  /** client subnets, with the site each one was matched to when the match is exact */
  nets: { net: string; sessions: number; site?: string; series?: (number | null)[] }[];
  /** how much of the traffic could be attributed to a site at all */
  mapped: number;
  total: number;
  /** true when Dynatrace has traffic anomaly detection raising problems on these applications */
  anomalyWatched: boolean;
  /**
   * Requests served by the services, per hour, for environments where the services are monitored. Read
   * only as a count, like the sessions: whether demand is still getting through, never how the services
   * perform. Environment-wide.
   */
  requests?: { series: (number | null)[]; typical: number[]; nowIndex: number; now: number | null; typicalNow: number | null };
}

export interface NetworkModel {
  /** Real user sessions, for isolating whether a network fault reached the people using the apps */
  users?: Users;
  /** Alerts Dynatrace raised that name no network entity (for example a metric event bound to the environment) */
  unmappedAlerts?: DeviceProblem[];
  demo?: boolean;
  meta: { tenant: string; generatedAt: string; thresholds: Record<string, number> };
  sites: Record<string, Site>;
  siteVerdicts?: Record<string, Verdict>;
  map?: { viewBox: number[]; path: string };
  devices: Device[];
  circuits?: Circuit[];
  /** Physical adjacencies the devices report (CDP/LLDP), by device name; ifA is the local port on a. */
  links: { a: string; b: string; kind: string; label: string; ifA?: string; ifAId?: string; ifB?: string }[];
  peers: Peer[];
  traps: { t: string; ip: string; device: string | null; oid: string }[];
  flows?: {
    exporters: FlowExporter[];
    top: { exp: string; device: string | null; src: string; dst: string; proto: string; dport: string; gb: number; flows: number }[];
  };
  /**
   * The network as the applications feel it, from OneAgent network flows: share of TCP packets
   * retransmitted and the 90th percentile round trip, every 10 minutes over 8 hours, and per workload.
   */
  appNet?: AppNetwork;
  flowMap?: FlowMap;
  oneagent?: { host: string; cluster: string | null; dst: string; dport: string; bytes: number; retr: number; resets: number; rttMs: number | null }[];
  e2e: { probe: string; paths: E2EPath[] };
}
