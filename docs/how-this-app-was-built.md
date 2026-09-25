# How this app was built

NetO11y is a Dynatrace AppEngine app that shows a network the way an operator reads it. This document is
for whoever picks the code up next: the rules it is built on, how the data gets from Grail to the screen,
what changes at scale, what it costs to run, and the mistakes that shaped it.

It describes decisions, not product documentation. What each data source is and how to send it lives in the
app itself, under Settings › Data, and the short version is in the README.

---

## 1. The four rules

Every design decision below comes from one of these.

**It works in any environment.** A network monitored by any Dynatrace SNMP extension is enough for the app
to show something useful. Everything more specific — primary tags, circuit tags, flow exporters, agents —
adds to what it shows and is never a precondition. Whatever is missing is named on screen with what it
would unlock.

**It reads only documented formats.** Smartscape network nodes and edges, the metrics of the network
extensions, Davis problems and events, ActiveGate syslog, the SNMP traps extension, flow records ingested
through the OpenTelemetry Collector, OneAgent network metrics and flows. No vendor log text is parsed, so
nothing breaks when a device changes its wording.

**It does not judge health, and holds no thresholds.** A device, a port, a link or a site is red or yellow
because the platform has an open problem on it. Everything else — utilisation, errors, retransmissions,
restarts — is shown as a measurement, and no number in this code decides what counts as high: that number
lives in the customer's alert templates, where it is theirs. Two figures the app applies are the customer's
own: the SLA tagged on a circuit monitor, and the demand-drop threshold they set in Settings.

**Nothing the environment reports disappears.** An alert the app cannot place on a device is still listed,
with the reason it could not be placed.

---

## 2. Reading the data

### The query catalogue

Every query the app runs lives in one file, with its row cap and its flags, and nothing queries Grail
outside it. That is what makes the cost measurable and the test suite possible: the checks run the app's
own catalogue against generated records and against a live environment.

Flags a query can carry:

- `complete` — the query must return the whole estate. If it comes back at its row cap, the app says it is
  seeing only part and stops claiming a total. Top-N queries are capped on purpose and are not marked.
- `detail` — per-interface data, which only runs while the estate is small enough (see §5).
- `incremental` — a log query the browser reads in parts (see below).

### The extension families catalogue

Every SNMP extension of the current generation reports a common metric set, and vendor extensions add
their own keys on top; one older family reports only its own and is joined by address. Instead of
branching on vendors through the code, one catalogue describes each family — its metric prefix, the keys
for traffic, errors, CPU, memory and uptime, and the dimensions it names devices and ports with — and the
queries are generated from it. Adding support for another extension is adding an entry.

The model reads the families in catalogue order and lets the first one that reports a measure for a device
win, so a device covered by two extensions is never counted twice.

### Three waves, and gating

Grail runs a limited number of queries per user at a time, so firing everything at once leaves the useful
answers queued behind the slow ones. The app loads in three waves: the inventory, then what every view
needs, then the rest. The first screen renders when the core has settled, or after a few seconds if the
environment is slow, and fills in as the rest lands.

Two gates keep the app from paying for data an environment does not have:

- **Families.** One cheap read of the metric series says which extension families the environment sends;
  only those families' queries run. An environment with no network extension runs none of them. If that
  read fails, every family runs, as before.
- **Optional sources.** Device logs, neighbours, flows and agent flows are each probed once. A source that
  comes back empty is remembered as absent in that browser and not read again for twelve hours, and
  Settings shows what was found empty, when, and a button to look again.

### Reading logs in parts

Log queries are billed by the data scanned, and a window of logs costs the same whatever the filter. The
part of the window already read does not change, so the browser keeps what it read and the next open asks
only for what arrived after it, then puts the two together.

Three shapes are merged, and each has its own rule:

| Shape | Merge rule |
|---|---|
| A series (counts per bucket) | Buckets are clock-aligned, so a bucket read now replaces the same bucket read before |
| Latest-seen per key | One row per key, keeping the newest time, dropping what fell out of the window |
| Newest N records | The new part rules from the cut; the kept part answers only before it |

Two details that took a bug each to learn: an empty bucket comes back as `null`, including for a count, and
the model tells `null` from `0`, so values are kept exactly as they arrive; and records can be ingested a
few minutes after their timestamp, so the part read again starts ten minutes before the last read ended.

Everything is kept in the viewer's own browser. Nothing is shared between users: the records can carry log
content, and another user may not be allowed to read that bucket.

---

## 3. From records to the model

One function turns query results into the model the whole app reads. It runs in milliseconds on twenty
thousand devices, and the order matters:

1. **Devices.** Smartscape nodes, with neighbour-only entries dropped and duplicates merged by name, the
   polled entry winning over the merely discovered one.
2. **Sites.** The customer's own tag wins. Without tags: the location the device reports, then the
   autodiscovery group, then the management network it sits on. A site is never invented from a name.
3. **Health.** CPU, memory, availability, traffic and errors, read per family in catalogue order.
4. **Restarts.** The uptime counter stepping down inside the window.
5. **Interfaces**, VLANs, syslog and trap counts, topology, reachability, circuits.
6. **Alerts.** Davis problems and events matched to devices by Smartscape id, by classic entity id, by the
   interface they name, by the monitor that watches the device, and by name. What matches nothing is kept
   as an unplaced alert with its scope.
7. **Verdicts.** Only now, and only from the alerts.

Everything downstream — causes, the map, the pages, the isolation reading — is derived from that model, so
two views can never disagree.

---

## 4. What the screen does with it

**The shape follows the data.** The traffic view draws ranked paths when there is nothing to cross, and a
flow diagram when there is; the map draws geography when sites have coordinates and a schematic layout of
regions when they do not; a page with nothing to show says what is missing instead of drawing an empty
frame.

**Colour means one thing.** Green, amber and red are status, from the alerts, and nothing else uses them.
Categories get their own hues; traffic is one hue whose weight changes with volume. A band never changes
colour halfway along, because that would suggest a change that did not happen.

**Numbers carry their unit and their window,** and a figure the app is unsure of says so rather than
rounding the doubt away: a port whose counters exceed its own reported speed is marked, and that reading
never becomes the device's utilisation.

**The URL carries the state** — page, selection, filters, data source — so any view can be shared or
reloaded as it was.

---

## 5. Scale

Above a few thousand devices the app stops reading every port of every device (that is hundreds of
thousands of rows) and works from per-device summaries, fetching one device's ports when somebody opens
it. The example network ships in both sizes, the larger one read exactly the way a real estate that size
is read, which is how the scale work got tested at all.

What that exposed, and what fixed it:

- Anything computed per site that scanned every device was quadratic. Devices, circuits and paths are
  indexed by site once per model.
- Grouping by copying a list for each item is quadratic too, and it appeared five times.
- Drawing one element per device does not survive twenty thousand of them: the quiet dots of a large
  bubble became one path per colour, and problem devices stay individual, on the rim where they can be
  pointed at.
- On the map, sites that fall close together on screen become one mark with their count and a ring of
  their status shares, and the routes between groups become one route each. What the selected cause is
  about always stays a site of its own; clicking a group opens it.

After that work, twenty thousand devices draw at the monitor's refresh rate and no interaction blocks the
main thread for more than a frame or two.

---

## 6. What it costs, and what the app does about it

Logs, billable events and sessions are charged by the data a query scans. Metrics, Smartscape and Davis
problems and events are included, which is why the app leans on them: the inventory, health, restarts,
availability and every status come from data that costs nothing to read.

The cost of a log query is **window × how much the bucket holds**, not how much matches the filter. Two
consequences drive the design:

- **Ask for what you can show.** A query that stops as soon as it has its rows is billed for what it
  scanned until then, so the row limit is the price. Asking for three times what the screen can display
  cost three times as much for nothing.
- **A shorter window is a smaller bill.** Where a source writes on a known cycle, the window is a small
  multiple of that cycle rather than a round number.

The app measures itself: every answer reports what Grail scanned, and Settings shows what the load read,
what it costs at the published rate, which queries read most, and — since a log query reads every record
of its buckets — how much smaller the bill would be with the network's logs routed to a bucket of their
own. That last one is also a step in the app's own list, with the environment's numbers in it, because in
a busy environment it is worth more than everything the app can do by itself.

---

## 7. How it is tested

There is no way to unit-test "does this read the network correctly", so the suite works from a generated
estate: sixty-odd sites, several vendors, a carrier outage, a flapping port, muted and maintenance
problems, syslog, traps, flows and user sessions, shaped exactly like the records Grail returns. The app's
own model code then runs over it, and the checks assert what the app promises:

- the scenario reaches the screen: the outage is one cause and not one per circuit, an interface alert
  lands on the device that owns the port, a muted problem is ignored exactly as the platform ignores it;
- nothing is judged that was not alerted;
- an environment with no tags, no location and no naming convention still yields sites and roles;
- the per-device summary and that device's own ports agree on utilisation;
- a log query read in two parts equals the query read whole, nulls included;
- what changed in the last day is what the fixtures say changed, at the moment they say it;
- the map's grouping loses no site, and nothing overlaps;
- what was never measured is not judged: a site that never reported a session reads as not monitored,
  one that stopped reporting reads as a fault;
- a drawing that says a size means a count delivers it: ten times the devices, ten times the area;
- no component calls a hook after an early return.

The example network gets its own audit, because it is what a reader sees before any of their own data
arrives and every screen reads it through the same model: every reference points at something that
exists, a counter equals the series drawn beside it, nothing is dated in the future, a device that stopped
answering is dark in every reading it has, and the situations the screens are built to show are still in
there. Two apparent contradictions are deliberate and are asserted as such: a series comes back shorter
when the device was dark, exactly as the live builder drops the empty buckets, and a site whose primary
link is down while its backup carries it is degraded rather than down.

Alongside it: a script that runs the same catalogue against a live environment and asserts invariants that
must hold whatever it contains; a scorecard that reports what the app can deliver in an environment and
what is missing; a scale test that pushes twenty thousand devices through the model; and a check that
reads the sources for the hook-order mistake.

**Four lessons are baked into the suite**, each after the same bug happened more than once:

1. *A check anchored to the clock lies.* The restart check compared against "two hours ago" and failed
   every time the fixtures aged, which teaches people to ignore the suite. It reads the moment from the
   fixture now — and the fixtures themselves carry moments, so a set left for a day ages out of every
   window the model reads. The suite rebuilds a stale set before it reads anything, rather than going red
   for a reason that has nothing to do with the code.
2. *Two paths to the same number must be checked against each other.* The per-device summary took the
   largest counter delta in a bucket and divided it by the whole bucket, while the per-port series summed
   the deltas of the bucket — a five-fold understatement that nothing caught, because the fixtures had no
   summaries at all. They do now, and the two must agree.
3. *A check that filters an empty list passes on nothing.* Half the example audit read the end-to-end
   path off the site, where it does not live, and reported a clean result over an empty array. Each group
   of checks now asserts first that what it is about is actually there.
4. *A hook after a conditional return breaks the page at runtime,* and neither the type checker nor the
   build sees it. A small script reads the sources and names file, function and line.

---

## 8. Conventions

- **The model is the single source of truth.** A page never re-derives a number from raw records.
- **Comments say why, never what.** The code says what it does; the comment says what it protects against,
  usually an environment that behaved unexpectedly.
- **Copy is written for the person on shift.** Plain sentences, the unit and the window always present, no
  jargon the app itself invented. A figure that is uncertain says so.
- **Design tokens, never literal colours.** Status comes from the platform's status tokens, so the app
  matches the rest of the platform in either theme.
- **One number, one place.** Thousands separators, byte and bit formatting and timestamps all go through
  the same helpers.

---

## 9. Running it

The local development server only resolves on port 3000, and the environment URL in the app config must
point at the environment being opened. One app at a time.

```bash
cd app && npm install && npm start     # development server
npm run typecheck                      # types
npm run build                          # the bundle a deploy ships
npx dt-app deploy --skip-build --environment-url https://<env>.apps.dynatrace.com   # raise the version first
cd scripts/grail
node build.mjs                         # bundle the app's model and queries for the checks
node generate.mjs                      # regenerate the fixtures
node validate.mjs                      # the scenario checks
node example_check.mjs                 # the bundled example, checked against itself
node hooks_after_return.mjs            # the hook-order check
node perf.mjs 20000 10                 # scale test
```

`live_check.mjs` and `scorecard.mjs` run against a live environment through the development server's proxy
or a CLI context; neither writes anything.

---

## 10. If you are picking this up

Read in this order: the query catalogue, the families catalogue, the model builder, then one page. That is
about an hour, and everything else follows from those four files.

Two habits worth keeping. **Check against a real environment, not only the fixtures** — every serious bug
in this app was found by running it against an environment that behaved differently from what the code
assumed, and none of them by reading the code. And **when a new measurement lands on the screen, ask what
it would cost in an environment a hundred times busier**, because the answer is usually a window that can
be smaller or a row limit that can be lower, and it is much cheaper to ask before shipping it.
