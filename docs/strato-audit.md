# What the Strato design system already does for us, and what it does not

Audited against the versions installed in `app/node_modules`, with the local mirror of
developer.dynatracelabs.com as the reference for intent and props:

| package | version | what it holds |
|---|---|---|
| `@dynatrace/strato-components` | 3.15.1 | buttons, charts, content, core, editors, filters, forms, layouts, navigation, notifications, overlays, tables, typography |
| `@dynatrace/strato-geo` | 3.15.1 | `MapView` and its layers — **installed, with `maplibre-gl`** |
| `@dynatrace/strato-icons` | 2.6.1 | the icon set |
| `@dynatrace/strato-design-tokens` | 1.8.0 | colour, typography and spacing tokens |
| `@dynatrace/strato-components-preview` | 3.4.1 | **nothing of its own** — every file in it is `export * from '@dynatrace/strato-components/…'`. There is one component surface, not two. |

The app is 19,100 lines of TS/TSX and 2,130 lines of `theme.css`. This is what of that the
platform already owns.

---

## Already on Strato

`AppHeader` · `PageLayout` · `HelpMenu` · `Flex` · `Menu` · `Tabs` · `Modal` · `Sheet` ·
`DataTable` (devices, WAN links, transactions) · `FilterBar` · `Select` · `TextInput` ·
`SearchInput` · `Button` · `EmptyState` · `ProgressCircle` · `Skeleton` / `SkeletonText` ·
`Accordion` · `CodeSnippet` · `HealthIndicator` · `AiLoadingIndicator` / `AiResponse` ·
`ToastContainer` · typography (`Text`, `Heading`, `Paragraph`, `List`, `ExternalLink`) ·
`HoneycombChart` · `TimeseriesChart` · `useCurrentTheme`.

---

## Replace — ranked by what it buys

### 1. `RoomList.tsx` → `DataTable` · 163 lines

Written this session, and it hand-rolls exactly the features `DataTable` ships: `sortable`,
`sortBy` / `defaultSortBy`, `columnPinning` (the sticky Subject column), `resizable`,
`columnVisibility`, `columnOrder`, `pagination`, `DataTableDownload`, line wrap, and
`TextEllipsis` with the hover title. `Tables.tsx` already uses `DataTable` for three other
tables, so this is also the odd one out in our own codebase.

Same for the two other hand-rolled `<table>`s: `Details.tsx` (260 lines) and the evidence
table in `CauseVisuals.tsx`.

### 2. The four Recharts charts → Strato charts

Recharts is a second chart library carried for four components, each with its own tooltip,
legend and axis styling:

| ours | Strato |
|---|---|
| `KpiRow.tsx` — tile + Recharts `LineChart` sparkline + delta | `SingleValueGrid` of `SingleValue`, with `.Sparkline` and `.Trend` built in |
| `RowChart.tsx` — one subject's record + band | `TimeseriesChart` + `.Band` (the pattern `NetworkDemand` now uses) |
| `PriorityMatrix.tsx` — bubbles on two axes | `XYChart.DotSeries` (scatter) |
| `RegionHeatmap.tsx` | `HoneycombChart`, or `XYChart.RectSeries` |
| `ScenarioRunway.tsx` | `MeterBarChart` / `MultiMeterBarChart` |

Dropping Recharts removes a dependency and the `useChartZoom` hook (71 lines) that exists only
because Recharts has no zoom — `TimeseriesChart.Zoom` does.

### 3. Bars and ranked lists → `MeterBarChart`, `TopList`, `ProgressBar`

`SiteDemand.tsx`, `RouteStrip.tsx`, the `.vz-bar` family and the share bars in the site list
are all "a bar for a share of a total". `MeterBarChart` is that component (`value`, `min`,
`max`, auto-formatted `.Min` / `.Max` / `.Value` slots); `TopList` is the ranked-bar list with
the label inside the bar; `ProgressBar` is the non-chart case.

### 4. `Visual.tsx` → `Container` / `Surface` / `Divider` / `Chip` · 285 lines

`Tile`, the `.card` family and the `.vz-tile` corner brackets are a hand-made surface.
`Container` has `variant` (`minimal` / `default` / `emphasized` / `accent`) and `color`
(`primary` / `neutral` / `success` / `warning` / `critical`) — which is also the honest way to
express `TONE`, since our tone constants are already mapped to status. `Surface` is the
floating case, `Divider` replaces the `border-top` separators, `Chip` / `ChipGroup` replaces
`.vz-chip`.

### 5. Typography → `Text` / `Heading` / `Paragraph` with `textStyle`

`theme.css` sets `font-family` or `font:` by hand **50 times**. The families already come from
`--dt-typography-*` tokens, so the values are right; what is hand-made is the decision. `Text`
takes `textStyle` (`base`, `base-emphasized`, `small`, `small-emphasized`) and
`fontStyle` (`text` | `code`) — `fontStyle="code"` is every place we write
`font-family: var(--np-mono)`.

### 6. Smaller, each a clear swap

| ours | Strato |
|---|---|
| `.lm-tip`, `.rc-tip` and the other hover cards | `Tooltip` (overlays) |
| `SearchPalette.tsx` ⌘K handling | `useKeyboardShortcut` + `Modal`, with `KeyboardShortcut` to print the keys |
| `.acx-crumb` | `Breadcrumbs` |
| `NativeDrill.tsx` buttons | `IntentButton`, `AppLink`, and the `Intent` slot that charts and tables already accept |
| the DQL we print in Settings | `DQLEditor` / `CodeEditor` |
| `useElementWidth.ts` | `useContainerSize` / `useThrottledResizeObserver` |
| our expand/collapse text | `ExpandableText`, `TextEllipsis` |
| "Measured today / Could reach" toggle | `ToggleButtonGroup` |
| time range pickers | `TimeframeSelector`, `DateTimeRangePicker` |

---

## Keep — no Strato equivalent

| ours | why it stays |
|---|---|
| `JourneyChart.tsx`, `PathSteps.tsx`, `RouteStrip.tsx` (as a *path*) | end-to-end hop-by-hop path. `SankeyChart` is flow volume between stages, not an ordered path with per-hop status. |
| `DeviceBubbles.tsx` | zoomable circle-packing by role. `TreeMap` is the nearest and is rectangular and hierarchical by value, not a packed bubble field you fly into. |
| `CauseVisuals.tsx` evidence grouping | the model, not the drawing. The table inside it does go to `DataTable`. |
| `source.tsx`, `room.ts`, `useDavisForecast.ts`, `useNovelty.ts`, `model/*` | all of our model and platform-query layer. Strato is presentation only. |
| `RoomComb` grouping, ordering and the `useRoom` reading | `HoneycombChart` draws the tiles; which subjects, in what order, against which limit is ours. |
| `LiveMap.tsx` | **deferred, not ruled out.** The map is not to be touched for now. `strato-geo` could draw the static part of it — the mapping is recorded below — but the animations do not survive its public API, and that is the open question. |
| the topology graph we do **not** have | `NodeGraph` exists in the docs but ships as `@dynatrace-internal/strato-node-graph` — not on the public registry and not installable here. |
| the `--comb-*` style calibration | see the caveat below. |

### For the record: what `strato-geo` would have covered

Kept here because the question will come up again, not as a proposal. `MapView` is installed
with `maplibre-gl` and its tiles come from Dynatrace's own CDN
(`https://dt-cdn.net/scripts/data/worldmap/maps/v006/`), so no third-party host would enter
the CSP. The layers map onto the drawing one to one:

| what the map draws | the layer |
|---|---|
| sites coloured by verdict | `DotLayer` — shapes, Strato icons as markers, icon backgrounds |
| sites sized by traffic | `BubbleLayer` — `radius`, `scale`, `sizeInterpolation` |
| WAN routes between sites | `ConnectionLayer` — `path` of lat/long, `color`, `thickness`, `line`, `directionIndicator`, `curve` |
| regions shaded by share | `ChoroplethLayer` |
| the hover card, zoom, CSV, the scale key | layer `Tooltip`, `MapView.Zoom`, `MapView.DownloadCSV`, the three legends |

### The animations, which are the actual blocker

What the map animates today: packets running along each route (count, speed and size by
volume, two directions parked either side of the curve by its normal, phase per link);
marching ants on Critical links (`lineDashOffset = -(now/70) % 8`); the 1,100 ms eased fly-to;
and the focus glow. All of it off under `prefers-reduced-motion`.

`ConnectionLayer` takes `data`, `color`, `thickness`, `curve`, `line: 'dashed' | 'solid'` and
`directionIndicator: 'start' | 'end' | 'both'` — **no animation prop of any kind**. Its dash is
static and its arrow is static: they state a direction, they do not show flow. And `MapViewRef`
exposes only `element`, `zoomIn` / `zoomOut`, `zoomToFit`, `reset` and `downloadData` — **not the
maplibre instance**.

There is a way through, and its price is the point:

- `strato-geo` mounts `<Map>` from **`@vis.gl/react-maplibre` 8.1.2**, and the children passed to
  `MapView` render *inside* it (`map/components/MapContent.js:186`). A child of ours can therefore
  call `useMap()` and hold the live maplibre map — enough for `setPaintProperty` per frame
  (marching ants), a `CustomLayerInterface` (packets), `easeTo`, and `project()`.
- But that package is a **transitive dependency of `strato-geo`, not ours**. Using it means
  declaring it ourselves and pinning to whatever version `strato-geo` mounts: a different copy
  reads a different React context and `useMap()` comes back empty. A minor bump that swaps the
  library — this ecosystem already went `react-map-gl` → `@vis.gl/react-maplibre` once — kills
  the animation silently.
- The packets are the expensive half: ~40 lines in an already-open 2D canvas today, versus raw
  WebGL or ~600 GeoJSON features rewritten per frame at 100 links.
- The camera is the cheap half and needs no internals: `MapView` has a controlled mode
  (`longitude` / `latitude` / `zoom` as props), so the existing `ease()` drives it directly.
- An overlay `<canvas>` synced by `onViewStateChange` is the middle path, but it needs
  `map.project()` for the dots to sit on the line — the same hatch — or a reimplementation of
  maplibre's transform, where any drift shows as a packet off the route.

The schematic mode that drops the geography has no equivalent either way.

---

## One caveat worth deciding before going further

Strato's chart components paint to **canvas**, so a CSS custom property passed as a colour
(`var(--sel)`) is an invalid `ctx.fillStyle` and is dropped silently. Every colour we hand a
Strato chart has to be resolved to a literal first — `hooks/useToken.ts` exists for that. It
also means a few things cannot be styled at all: `HoneycombChart` hard-codes
`strokeColor: "transparent"` on every tile, which is why the comb's 90% ring could not survive
the migration.

The same applies to the ramp. The platform's sequential `blue` has no step that fades into the
page ground, so the empty end of the comb is a saturated blue rather than near-invisible.
`colorPalette` accepts a custom `string[]`, so our calibrated ramp can be handed to the
platform's component — that is still "using Strato", and it is the call to make.

---

## Suggested order

1. `RoomList` → `DataTable` — small, and it deletes code written this week.
2. `KpiRow` → `SingleValueGrid`, `RowChart` → `TimeseriesChart` — removes Recharts from two of four.
3. `PriorityMatrix` / `RegionHeatmap` / `ScenarioRunway` — removes Recharts and `useChartZoom` entirely.
4. `Visual.tsx` → `Container` / `Divider` / `Chip`, then sweep the 50 `font-family` lines into `Text`.

`LiveMap` is deliberately not in this list. It is deferred, and the animations above are what
has to be answered before it goes in.
