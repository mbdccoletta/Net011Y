// Settings content: what each page of the app reads, how to send each kind of data to Dynatrace,
// and the configuration the app itself needs. Status per data type comes from the app's own queries.
import React from "react";
import { Accordion, CodeSnippet, HealthIndicator } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { Select, TextInput } from "@dynatrace/strato-components/forms";
import { ExternalLink, Heading, List, Paragraph, Strong, Text } from "@dynatrace/strato-components/typography";
import type { Need, NeedKey, NeedStatus } from "../data/requirements";
import { APP_PERMISSIONS, DATA_GROUPS, NETWORK_BUCKET_MATCHER, NETWORK_BUCKET_STEPS, PAGE_NEEDS, SETUP } from "../data/setupGuide";
import { openNative, openNotebook } from "../utils/drilldown";
import { useDropThreshold, setDropThreshold } from "../hooks/useDropThreshold";
import { DEFAULT_DROP_PCT } from "../model/suspicion";
import { parseBuckets, setLogBuckets, useLogBuckets } from "../hooks/useLogBucket";
import { SOURCE_RECHECK_MS, type LoadCost, type SourceGroup } from "../data/useNetwork";
import { FAMILIES } from "../data/formats";
import type { Step } from "../model/nextSteps";
import type { NetworkModel } from "../model/types";

const SOURCE_LABEL: Record<SourceGroup, string> = {
  netflow: "NetFlow / IPFIX", deviceLogs: "Syslog and SNMP traps",
  neighbors: "CDP / LLDP neighbours", oneagentFlows: "OneAgent network flows",
};

/**
 * What the app reads and what it costs. Log and event queries are billed by what Grail scans, so the app
 * skips sources it found empty and can be pointed at the buckets that hold the network's logs.
 */
/** Dynatrace list price for logs, events and sessions queries; a contract price may differ */
const PRICE_PER_GIB = 0.0035;
const QUERY_LABEL: Record<string, string> = {
  deviceLogs: "Device logs and traps · 6 h", deviceLogsRecent: "Recent device events", flowTs: "NetFlow per exporter · 70 min",
  flowNets: "NetFlow conversations · 1 h", flowFanIn: "NetFlow fan-in · 1 h", neighbors: "CDP / LLDP neighbours · 30 min",
  appNet: "Applications' network · 8 h", appNetBy: "Applications' network by group · 7 h", appPaths: "Application paths · 1 h",
  cloud: "Application clusters · 24 h", cloudTop: "Top application conversations · 24 h",
  sessions: "User sessions · 24 h", sessionNets: "User sessions by network · 24 h", sessionsTypical: "User sessions, usual week · 7 d",
};
const gbText = (gb: number) => (gb >= 100 ? gb.toFixed(0) : gb >= 1 ? gb.toFixed(1) : gb >= 0.01 ? gb.toFixed(2) : "< 0.01");
const usdText = (gb: number) => { const v = (gb / 1.073741824) * PRICE_PER_GIB; return v >= 0.01 ? `$${v.toFixed(2)}` : "< $0.01"; };
const pctText = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)}%` : x >= 0.001 ? `${(x * 100).toFixed(1)}%` : "< 0.1%");
/** a saving is rounded down, so it never reads as all of it */
const savedText = (x: number) => `${Math.min(99, Math.floor(x * 100))}%`;

/** This load's reads, what they cost, and what a bucket of their own would leave of the log part. */
function LoadMeter({ cost, buckets, onHow }: { cost: LoadCost; buckets: string[]; onHow: () => void }) {
  const kinds = [
    { key: "logGb", label: "Logs", gb: cost.logGb, cls: "cs-k--logs" },
    { key: "eventGb", label: "OneAgent flows", gb: cost.eventGb, cls: "cs-k--events" },
    { key: "sessionGb", label: "User sessions", gb: cost.sessionGb, cls: "cs-k--sessions" },
  ].filter((k) => k.gb > 0);
  const top = cost.byQuery.slice(0, 6), max = top[0]?.gb || 1;
  const share = cost.networkShare;
  const bucketGb = share != null ? cost.logGb * share : null;
  const worth = !buckets.length && bucketGb != null && cost.logGb >= 1 && share! < 0.5;
  return (
    <div className="cs">
      <div className="cs-meter">
        <div className="cs-figure">
          <span className="cs-big">{gbText(cost.billableGb)}<small> GB</small></span>
          <span className="cs-cap">read by this load · about {usdText(cost.billableGb)} at list price</span>
        </div>
        {cost.billableGb > 0 && (
          <>
            <div className="cs-stack" role="img" aria-label={kinds.map((k) => `${k.label} ${gbText(k.gb)} GB`).join(", ")}>
              {kinds.map((k) => <span key={k.key} className={`cs-seg ${k.cls}`} style={{ flexGrow: k.gb }} />)}
            </div>
            <div className="cs-legend">
              {kinds.map((k) => <span key={k.key}><i className={`cs-dot ${k.cls}`} />{k.label} <b>{gbText(k.gb)} GB</b></span>)}
            </div>
          </>
        )}
      </div>
      {top.length > 0 && (
        <div className="cs-list" aria-label="Queries by data read">
          {top.map((q) => (
            <div key={q.name} className="cs-row">
              <span className="cs-bar" style={{ width: `${Math.max(2, (100 * q.gb) / max)}%` }} />
              <span className="cs-what">{QUERY_LABEL[q.name] ?? q.name}</span>
              <span className="cs-val">{gbText(q.gb)} GB</span>
            </div>
          ))}
        </div>
      )}
      {worth && (
        <div className="cs-save">
          <div className="cs-save__head">
            <span className="cs-save__pct">−{savedText(1 - share!)}</span>
            <span>of the log reads, with the network&apos;s logs in a bucket of their own{(() => {
              const saved = (cost.logGb - bucketGb!) * 30;
              return saved / 1.073741824 * PRICE_PER_GIB >= 1 ? ` · about ${usdText(saved)} a month at this rate` : "";
            })()}</span>
          </div>
          <Text textStyle="small">
            Network records are {pctText(share!)} of the log records these queries read: a log query reads every record of its bucket in its
            window, whatever it filters. Routed to a bucket of their own and named below, the same load reads about {gbText(bucketGb!)} GB of
            logs instead of {gbText(cost.logGb)} GB. Nothing the app shows changes.
          </Text>
          <div className="cs-compare">
            <span className="cs-compare__label">Today</span><span className="cs-compare__bar"><i style={{ width: "100%" }} /></span><span className="cs-val">{gbText(cost.logGb)} GB</span>
            <span className="cs-compare__label">Own bucket</span><span className="cs-compare__bar cs-compare__bar--after"><i style={{ width: `${Math.max(1, share! * 100)}%` }} /></span><span className="cs-val">{gbText(bucketGb!)} GB</span>
          </div>
          <div><Button onClick={onHow}>How to route them</Button></div>
        </div>
      )}
    </div>
  );
}

export function QueryCostSection({ absent, onRecheck, cost, onHow }: { absent: Partial<Record<SourceGroup, number>>; onRecheck: () => void; cost?: LoadCost | null; onHow?: () => void }) {
  const buckets = useLogBuckets();
  const [draft, setDraft] = React.useState(buckets.join(", "));
  React.useEffect(() => { setDraft(buckets.join(", ")); }, [buckets]);
  const empty = (Object.keys(absent) as SourceGroup[]).filter((g) => absent[g] != null);
  const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
  const parsed = parseBuckets(draft);
  return (
    <section className="ds-block" aria-labelledby="ds-cost">
      <Heading level={5} id="ds-cost">What the app reads</Heading>
      {cost && <LoadMeter cost={cost} buckets={buckets} onHow={onHow ?? (() => undefined)} />}
      <Text textStyle="small">
        Queries on logs, events and sessions are billed by the data Grail scans, not by what they return, and a filter still reads
        every record of the window; metrics, Smartscape and Davis problems are included. The app reads each optional source once; a source that comes back empty is not
        read again for {SOURCE_RECHECK_MS / 3600000} hours. Device logs, traps, neighbours, the NetFlow timeline and the applications&apos;
        network are kept in this browser: the next open reads only what arrived since, with the same result as reading it all.
      </Text>
      {empty.length > 0 ? (
        <List>
          {empty.map((g) => <Text key={g}>{SOURCE_LABEL[g]} — nothing found at {clock(absent[g]!)} UTC, read again after {clock(absent[g]! + SOURCE_RECHECK_MS)} UTC</Text>)}
        </List>
      ) : <Text textStyle="small">Every optional source is read on each load.</Text>}
      {empty.length > 0 && <div><Button onClick={onRecheck}>Check again now</Button></div>}
      <Heading level={6} id="ds-buckets">Buckets that hold the network logs</Heading>
      <Text textStyle="small">
        When OpenPipeline routes syslog, traps, NetFlow and SNMP autodiscovery records to buckets of their own, name them
        here: every log query then reads only those buckets instead of all logs. Leave empty to read all log buckets.
      </Text>
      <div className="ds-row">
        <TextInput value={draft} onChange={(v: string) => setDraft(v)} placeholder="for example network_logs" aria-labelledby="ds-buckets" />
        <Button variant="emphasized" disabled={parsed.join(",") === buckets.join(",")} onClick={() => setLogBuckets(parsed)}>Save</Button>
      </div>
      {draft.trim() && parsed.length === 0 && <Text textStyle="small">Bucket names use lower-case letters, digits, dashes and underscores.</Text>}
    </section>
  );
}

const STATUS: Record<NeedStatus, { status: "ideal" | "good" | "neutral" | "warning" | "critical"; label: string }> = {
  ok: { status: "ideal", label: "Received" },
  partial: { status: "warning", label: "Partly received" },
  missing: { status: "critical", label: "Not received" },
  loading: { status: "neutral", label: "Checking" },
  simulated: { status: "good", label: "Simulated" },
  manual: { status: "neutral", label: "Checked when used" },
};

const ORDER: NeedKey[] = ["alerts", "devices", "sites", "interfaces", "traffic", "cpu", "availability", "icmp", "wan", "syslog", "traps", "lldp", "routing", "netflow", "appFlows", "sessions", "requests", "assist"];

function NeedStatusIndicator({ need }: { need: Need }) {
  const s = STATUS[need.status];
  return (
    <HealthIndicator status={s.status} visual="shape">
      <HealthIndicator.Label>{s.label}</HealthIndicator.Label>
    </HealthIndicator>
  );
}

interface Props {
  needs: Record<NeedKey, Need>;
  source: "live" | "example";
  onSource: (source: "live" | "example", scale?: "xl" | null) => void;
}

export function DataSourceSection({ source, scale, onSource }: Pick<Props, "source" | "onSource"> & { scale: "xl" | null }) {
  const value = source === "example" ? (scale === "xl" ? "example-xl" : "example") : "live";
  return (
      <section className="ds-block" aria-labelledby="ds-source">
        <Heading level={5} id="ds-source">Data source</Heading>
        <Select value={value} onChange={(v) => (v === "example-xl" ? onSource("example", "xl") : v === "example" ? onSource("example", null) : onSource("live", null))}>
          <Select.Trigger placeholder="Data source" />
          <Select.Content>
            <Select.Option value="live" textValue="This environment">This environment</Select.Option>
            <Select.Option value="example" textValue="Example network">Example network (simulated)</Select.Option>
            <Select.Option value="example-xl" textValue="Example network, extra large">Example network, extra large · 20,000 devices (simulated)</Select.Option>
          </Select.Content>
        </Select>
        <Text textStyle="small">
          This environment reads what your Dynatrace environment already stores. The example network is a fictitious retail company with about 400 sites, so you can explore the app before sending data;
          the extra-large one is the same company at about 4,200 sites and 20,000 devices, read the way the app reads an estate that size (per-device summaries, not every port).
        </Text>
      </section>
  );
}

/** The one number the isolation reading uses, kept where the customer can see and change it. */
export function SuspicionSection() {
  const pct = useDropThreshold();
  return (
    <section className="ds-block" aria-labelledby="ds-drop">
      <Heading level={5} id="ds-drop">Traffic drop worth suspecting</Heading>
      <Select value={String(pct)} onChange={(v) => setDropThreshold(Number(v ?? DEFAULT_DROP_PCT))}>
        <Select.Trigger placeholder="Threshold" />
        <Select.Content>
          {[30, 40, 50, 60, 70].map((v) => (
            <Select.Option key={v} value={String(v)} textValue={`${v}% of the usual`}>Below {v}% of the usual</Select.Option>
          ))}
        </Select.Content>
      </Select>
      <Text textStyle="small">
        When an hour holds fewer sessions than this share of what that hour usually holds, the app reports a
        suspicion next to the network alerts — never a status: red and amber keep coming only from the problems
        Dynatrace has open. With traffic anomaly detection enabled on the applications, the drop is Dynatrace&apos;s
        judgement and this number only decides when the app brings it up.
      </Text>
    </section>
  );
}

export function PagesSection({ needs }: Pick<Props, "needs">) {
  // One collapsed row per page: open it to see what that page reads, in the same groups used below.
  return (
      <section className="ds-block" aria-labelledby="ds-pages">
        <Heading level={5} id="ds-pages">What each page uses</Heading>
        <Text textStyle="small">Open a page to see the data it reads and what is already arriving.</Text>
        <Accordion multiple>
          {PAGE_NEEDS.map((p) => {
            const counted = p.keys.filter((k) => needs[k] && needs[k].status !== "manual");
            const received = counted.filter((k) => needs[k].status === "ok" || needs[k].status === "simulated").length;
            const groups = DATA_GROUPS.map((g) => ({ title: g.title, keys: g.keys.filter((k) => p.keys.includes(k)) })).filter((g) => g.keys.length);
            return (
              <Accordion.Section key={p.page} id={p.page}>
                <Accordion.SectionLabel aria-label={`${p.page}, ${received} of ${counted.length} received`}>
                  <span className="ds-label">
                    <span>{p.page}</span>
                    <Text textStyle="small">{received}/{counted.length} received</Text>
                  </span>
                </Accordion.SectionLabel>
                <Accordion.SectionContent>
                  <div className="ds-page">
                    <Text textStyle="small">{p.purpose}</Text>
                    {groups.map((g) => (
                      <div key={g.title} className="ds-page__group">
                        <Text textStyle="small" className="ds-page__grouptitle">{g.title}</Text>
                        <div className="ds-page__needs">
                          {g.keys.map((k) => (
                            <HealthIndicator key={k} status={STATUS[needs[k].status].status} visual="shape">
                              <HealthIndicator.Label>{needs[k].label}</HealthIndicator.Label>
                            </HealthIndicator>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Accordion.SectionContent>
              </Accordion.Section>
            );
          })}
        </Accordion>
      </section>
  );
}

export function SendDataSection({ needs, source, focus }: Pick<Props, "needs" | "source"> & { focus?: NeedKey | null }) {
  const received = ORDER.filter((k) => needs[k]?.status === "ok").length;
  // Opened from a page that is missing this data: that entry is expanded, marked, and placed at the top
  // of the panel. The work hangs off the ref, not off an effect: the sheet attaches this node while its
  // panel is still hidden and can re-attach it when it opens, and a hidden panel cannot be scrolled.
  const target = React.useRef<HTMLSpanElement | null>(null);
  const timer = React.useRef<number | null>(null);
  const place = React.useCallback(() => {
    const el = target.current;
    if (!el || !el.getBoundingClientRect().height) return false;
    let box: HTMLElement | null = el.parentElement;
    while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 4)) box = box.parentElement;
    if (!box) return false;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - 24;
    if (Math.abs(delta) < 8) return true;
    box.scrollTop += delta;
    return Math.abs(el.getBoundingClientRect().top - box.getBoundingClientRect().top - 24) < 8;
  }, []);
  const focusRef = React.useCallback((node: HTMLSpanElement | null) => {
    target.current = node;
    if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
    if (!node) return;
    // the entry is attached while the sheet is still opening, so keep trying until it has a box to place
    let tries = 0;
    timer.current = window.setInterval(() => {
      // a hidden tab throttles timers, so waiting there must not use up the attempts
      if (document.hidden) return;
      if (place() || ++tries > 40) { window.clearInterval(timer.current!); timer.current = null; }
    }, 120);
  }, [place]);
  React.useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);
  return (
      <section className="ds-block" aria-labelledby="ds-send">
        <Heading level={5} id="ds-send">How to send each data type</Heading>
        <Text textStyle="small">
          {source === "example" ? "Status shows the example network. Switch to This environment to check your data." : `${received} of ${ORDER.length} data types arrive in this environment. Open a data type to see how to send it and how to check it.`}
        </Text>
        {DATA_GROUPS.map((group) => (
          <div key={group.title} className="ds-group">
            <Text textStyle="base-emphasized">{group.title}</Text>
            <Text textStyle="small">{group.hint}</Text>
            <Accordion multiple defaultExpanded={focus && group.keys.includes(focus) ? [focus] : []}>
              {group.keys.map((key) => {
                const need = needs[key], guide = SETUP[key];
                if (!need || !guide) return null;
                return (
                  <Accordion.Section key={key} id={key}>
                    <Accordion.SectionLabel aria-label={`${need.label}, ${STATUS[need.status].label}`}>
                      <span className={`ds-label${key === focus ? " ds-label--focus" : ""}`} ref={key === focus ? focusRef : undefined}>
                        <span className="ds-label__name">
                          {need.label}
                          {key === focus && <em className="ds-focus-chip">what you came to configure</em>}
                        </span>
                        <NeedStatusIndicator need={need} />
                      </span>
                    </Accordion.SectionLabel>
                    <Accordion.SectionContent>
                      <div className="ds-guide">
                        {source === "live" && need.detail && <Text textStyle="small">In this environment: {need.detail}</Text>}
                        <Paragraph><Strong>Used for: </Strong>{guide.uses}</Paragraph>
                        <Paragraph><Strong>Sent by: </Strong>{guide.source}</Paragraph>
                        <div>
                          <Text textStyle="base-emphasized">Prerequisites</Text>
                          <List>{guide.prerequisites.map((x) => <span key={x}>{x}</span>)}</List>
                        </div>
                        <div>
                          <Text textStyle="base-emphasized">Configuration</Text>
                          <List ordered>{guide.steps.map((x) => <span key={x}>{x}</span>)}</List>
                        </div>
                        {guide.snippets?.map((sn) => (
                          <div key={sn.title}>
                            <Text textStyle="base-emphasized">{sn.title}</Text>
                            <CodeSnippet language={sn.language} showCopyAction maxHeight={260}>{sn.code}</CodeSnippet>
                          </div>
                        ))}
                        {guide.networkBucket && (
                          <div className="ds-bucket">
                            <Text textStyle="base-emphasized">Lower what the app costs</Text>
                            <Text textStyle="small">
                              A log query reads every record of its buckets in its window, whatever it filters. In their own bucket, the
                              network&apos;s few records are all the app&apos;s queries read; nothing the app shows changes. Settings › Data ›
                              What the app reads shows what this environment would save.
                            </Text>
                            <List ordered>{NETWORK_BUCKET_STEPS.map((x) => <span key={x}>{x}</span>)}</List>
                            <CodeSnippet language="dql" showCopyAction>{NETWORK_BUCKET_MATCHER}</CodeSnippet>
                          </div>
                        )}
                        {guide.verify && (
                          <div>
                            <Text textStyle="base-emphasized">Check that it arrives</Text>
                            <CodeSnippet language="dql" showCopyAction>{guide.verify}</CodeSnippet>
                            <div className="ds-actions">
                              <Button onClick={() => openNotebook(guide.verify)}>Run in Notebooks</Button>
                              {guide.opens && <Button variant="emphasized" onClick={() => openNative(guide.opens!.app)}>{guide.opens.label}</Button>}
                            </div>
                          </div>
                        )}
                        <div className="ds-links">
                          {guide.docs.map((d) => <ExternalLink key={d.href} href={d.href}>{d.label}</ExternalLink>)}
                        </div>
                      </div>
                    </Accordion.SectionContent>
                  </Accordion.Section>
                );
              })}
            </Accordion>
          </div>
        ))}
      </section>
  );
}

/** Every step from what this environment sends to everything the app can show, taken or not. */
export function StepsSection({ steps, inUse }: { steps: Step[]; inUse: number }) {
  const pct = inUse;
  return (
    <section className="ds-block" aria-labelledby="ds-steps">
      <Heading level={5} id="ds-steps">Getting more from NetO11y · {pct}% in use</Heading>
      <Text textStyle="small">
        The app always shows the best it can with what arrives. Each step below is measured on this environment and says what it unlocks;
        the first open one is the most valuable. The entries further down explain how.
      </Text>
      <List>
        {steps.map((s) => (
          <Text key={s.id}>{s.done ? "✓ " : "○ "}<Strong>{s.title}</Strong>{" — "}{s.unlocks}</Text>
        ))}
      </List>
    </section>
  );
}

/** The metric formats the app knows, from the Dynatrace network extensions, and which this environment sends. */
export function ExtensionsSection({ model }: { model: NetworkModel | null }) {
  const sending = new Set(model?.extensions ?? []);
  return (
    <section className="ds-block" aria-labelledby="ds-ext">
      <Heading level={5} id="ds-ext">Network extensions the app reads</Heading>
      <Text textStyle="small">
        The app reads the metrics of every Dynatrace network extension below and uses, per device and port, the first one that reports a
        measure: the common set the current SNMP extensions share, then the vendor&apos;s own. Nothing to configure in the app.
      </Text>
      <List>
        {FAMILIES.map((f) => (
          <Text key={f.id}>
            {sending.has(f.id) ? "● " : "○ "}<ExternalLink href={f.docs}>{f.label}</ExternalLink>
            {" — "}{sending.has(f.id) ? "sending" : "not in this environment"}
          </Text>
        ))}
      </List>
    </section>
  );
}

export function AppConfigSection() {
  return (
      <section className="ds-block" aria-labelledby="ds-app">
        <Heading level={5} id="ds-app">App configuration</Heading>
        <div>
          <Text textStyle="base-emphasized">Permissions the app requests</Text>
          <Text textStyle="small">An administrator accepts them when installing the app. Users also need the matching storage and Dynatrace Assist permissions in their policies.</Text>
          <List>{APP_PERMISSIONS.map((p) => <span key={p.scope}><code className="ds-code">{p.scope}</code>: {p.why}</span>)}</List>
        </div>
        <div>
          <Text textStyle="base-emphasized">Inventory tags</Text>
          <Text textStyle="small">The app joins everything by site. Use the same site code in the device tags (SNMP monitoring configurations) and the circuit tags (ICMP monitors).</Text>
          <List>
            <span>Devices, in the SNMP extension, with prefix: <code className="ds-code">primary_tags.site</code>, <code className="ds-code">site_name</code>, <code className="ds-code">site_type</code>, <code className="ds-code">region</code>, <code className="ds-code">state</code>, <code className="ds-code">city</code>, <code className="ds-code">geo_lat</code>, <code className="ds-code">geo_lon</code>, <code className="ds-code">hub</code></span>
            <span>WAN circuits, in the ICMP monitor, without prefix: <code className="ds-code">site</code>, <code className="ds-code">circuit_id</code>, <code className="ds-code">circuit_role</code>, <code className="ds-code">carrier</code>, <code className="ds-code">circuit_tech</code>, <code className="ds-code">sla_ms</code>, <code className="ds-code">bandwidth_mbps</code></span>
          </List>
        </div>
        <div>
          <Text textStyle="base-emphasized">Minimum versions</Text>
          <List>
            <span>ActiveGate and Extension Execution Controller 1.343 for primary tags on extension data</span>
            <span>ActiveGate 1.331 for private Synthetic locations with primary tags</span>
            <span>ActiveGate 1.295 on Linux for syslog ingestion</span>
            <span>OneAgent 1.337 for network connection monitoring</span>
          </List>
        </div>
        <div>
          <Text textStyle="base-emphasized">How the app judges health</Text>
          <List>
            <span>CPU: warning from 70%, critical from 85%</span>
            <span>Interface utilization: warning from 80%, critical from 95%</span>
            <span>SNMP availability below 99% in 24 hours: critical</span>
            <span>ICMP loss in 24 hours: warning from 2%, critical from 20%</span>
            <span>WAN latency: warning at the SLA, critical at 1.5 times the SLA; loss warning from 2%, critical from 10%</span>
            <span>Syslog severity 3 or lower: warning</span>
          </List>
        </div>
      </section>
  );
}
