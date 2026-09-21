// NetO11y — network health per site, device and WAN link, with the probable cause.
//
// Structured like Infrastructure & Operations: AppHeader navigation per entity type, a
// FilterBar and DataTable per page, and the selected entity in PageLayout.Details.
import React, { useEffect, useMemo, useState } from "react";

import { AppHeader, HelpMenu, PageLayout } from "@dynatrace/strato-components/layouts";
import { Button } from "@dynatrace/strato-components/buttons";
import { EmptyState, ProgressCircle } from "@dynatrace/strato-components/content";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Text } from "@dynatrace/strato-components/typography";
import { ToastContainer, showToast } from "@dynatrace/strato-components/notifications";
import "./styles/theme.css";
import { useNetwork } from "./data/useNetwork";
import { useUrlState, type Page } from "./hooks/useUrlState";
import { allSites } from "./model/site";
import { EntityDetails } from "./components/EntityDetails";
import { useLogBuckets } from "./hooks/useLogBucket";
import { SearchPalette } from "./components/SearchPalette";
import type { Filters } from "./pages/EntityPages";
import { DevicesVisual, LinksVisual, SitesVisual } from "./pages/VisualPages";
import { LiveMapPage } from "./pages/LiveMapPage";
import { TrafficPage } from "./pages/TrafficPage";
import { evaluateNeeds, VIEW_NEEDS, type NeedKey } from "./data/requirements";
import { DataNeeds } from "./components/DataNeeds";
import { coverage, nextSteps } from "./model/nextSteps";
import { pageCoverage } from "./model/coverage";
import { SettingsSheet } from "./components/SettingsSheet";
import { MagnifyingGlassIcon, SettingIcon } from "@dynatrace/strato-icons";

const APP_NAME = "NetO11y";
const LABEL: Record<Page, string> = { causes: "Live map", sites: "Sites", devices: "Devices", links: "WAN links", traffic: "Traffic" };
const NO_FILTERS: Filters = { status: null, region: null, role: null, carrier: null, q: "" };
const DOCS = {
  networks: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks",
  networkDevices: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks/network-devices/network-devices-get-started-guide",
};
const PAGES: [Page, string][] = [["causes", "Live map"], ["sites", "Sites"], ["devices", "Devices"], ["links", "WAN links"], ["traffic", "Traffic"]];

const hrefOf = (p: Page, source: "live" | "example", scale: "xl" | null = null) => {
  const q = new URLSearchParams();
  if (p !== "causes") q.set("page", p);
  if (source === "example") q.set("source", "example");
  if (source === "example" && scale === "xl") q.set("scale", "xl");
  return `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
};

/** True once `active` has lasted `ms`: progress indicators wait ~500 ms to avoid flicker (loading pattern). */
function useDelayed(active: boolean, ms: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return shown;
}


export function App() {
  const [url, setUrl] = useUrlState();
  const net = useNetwork(url.source, url.scale);
  const model = net.model;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // a page can ask Settings to open on the data type it is missing, instead of repeating the steps itself
  const [settingsFocus, setSettingsFocus] = useState<NeedKey | null>(null);
  const openSettings = (focus: NeedKey | null = null) => { setSettingsFocus(focus); setSettingsOpen(true); };

  const infos = useMemo(() => (model ? allSites(model) : []), [model]);
  const needs = useMemo(() => evaluateNeeds(net.counts, model, url.source, net.absent), [JSON.stringify(net.counts), model, url.source, JSON.stringify(net.absent)]); // eslint-disable-line react-hooks/exhaustive-deps
  // what to do next to get more from the app, measured on this environment
  const buckets = useLogBuckets();
  const stepOpts = { cost: net.cost, bucketsSet: buckets.length > 0 };
  const steps = useMemo(() => nextSteps(model, needs, stepOpts), [model, needs, net.cost, buckets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // the share of the app in use is about coverage, not cost: the bucket step is left out of it
  const inUse = useMemo(() => coverage(nextSteps(model, needs, { all: true }).filter((s) => s.id !== "bucket")), [model, needs]);
  // how much of each page this environment can fill: shown on the tabs, before a page is opened
  const pageCov = useMemo(() => pageCoverage(model), [model]);
  const tab = (p: Page, text: string) => {
    const v = model ? pageCov[p] : null;
    const level = v == null ? "" : v === 0 ? "none" : v < 0.5 ? "low" : v < 0.9 ? "mid" : "full";
    return (
      <span className={`nav-tab${level === "none" ? " is-empty" : ""}`}
        title={v == null ? undefined : v === 0 ? `${text}: nothing to show yet in this environment — open it to see how to unlock it` : `${text}: ${Math.round(v * 100)}% of what this page can show arrives in this environment`}>
        {text}{level && <i className={`nav-dot nav-dot--${level}`} aria-hidden="true" />}
      </span>
    );
  };
  const page: Page = url.page;
  const filters: Filters = { status: url.status, region: url.region, role: url.role, carrier: url.carrier, q: url.q };

  useEffect(() => { document.title = `${LABEL[page]} · ${APP_NAME}`; }, [page]);

  const go = (p: Page) => setUrl({ page: p, sel: null, tab: "overview", ...NO_FILTERS });
  // Navigation items are links (their URL can be opened or shared); a plain click stays in the app.
  const nav = (p: Page) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(p);
  };
  const showProgress = useDelayed(!model, 500);
  const select = (sel: string | null) => setUrl({ sel, tab: "overview" });
  // search from anywhere: ⌘K / Ctrl+K, or "/" when not typing
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSearchOpen((o) => !o); }
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const refresh = () => {
    net.refetch();
    showToast({ title: "Refresh started", type: "info" });
  };

  const header = (
    <AppHeader>
      <AppHeader.Navigation>
        <AppHeader.Logo appName={APP_NAME} href={hrefOf("causes", url.source, url.scale)} onClick={nav("causes")} />
        {PAGES.map(([p, label]) => (
          <AppHeader.NavigationItem key={p} isSelected={page === p} href={hrefOf(p, url.source, url.scale)} onClick={nav(p)}>{tab(p, label)}</AppHeader.NavigationItem>
        ))}
      </AppHeader.Navigation>
      <AppHeader.ActionItems>
        {url.source === "live" && (
          <AppHeader.ActionButton onClick={refresh} aria-label="Refresh network data">
            {net.loading ? `Loading ${net.done} of ${net.total}` : `Updated ${model?.meta.generatedAt.slice(11, 16) ?? "—"} UTC`}
          </AppHeader.ActionButton>
        )}
        {model && <AppHeader.ActionButton onClick={() => setSearchOpen(true)} aria-label="Search devices, sites and circuits (⌘K)" prefixIcon={<MagnifyingGlassIcon />}>Search</AppHeader.ActionButton>}
        <AppHeader.ActionButton onClick={() => openSettings()} aria-label="Settings" prefixIcon={<SettingIcon />} showLabel={false}>Settings</AppHeader.ActionButton>
      </AppHeader.ActionItems>
      <AppHeader.Menus>
        <HelpMenu entries={{
          whatsNew: "default",
          getStarted: [
            { label: "Set up network monitoring", href: DOCS.networkDevices, target: "_blank" },
            { label: "Explore example network", onSelect: () => setUrl({ source: "example", page: "causes", cause: null, sel: null, ...NO_FILTERS }) },
          ],
          documentation: { href: DOCS.networks, target: "_blank" },
          feedback: { href: "https://community.dynatrace.com", target: "_blank" },
          about: "default",
        }} />
      </AppHeader.Menus>
    </AppHeader>
  );

  const settings = (
    <SettingsSheet show={settingsOpen} onDismiss={() => setSettingsOpen(false)} model={model} needs={needs} source={url.source} scale={url.scale} focus={settingsFocus} steps={steps} inUse={inUse}
      absent={net.absent} cost={net.cost} onFocus={(k) => openSettings(k)} onRecheck={() => { net.recheck(); showToast({ title: "Reading every source again", type: "info" }); }}
      onSource={(source, scale = null) => setUrl({ source, scale, page: "causes", cause: null, sel: null, ...NO_FILTERS })} />
  );

  if (!model) {
    const requiredFailed = net.failed.some((q) => q === "devices" || q === "interfaces");
    return (
      <>
        {header}
        <div className="np-root" style={{ padding: 48, display: "grid", justifyItems: "center", gap: 16 }}>
          {requiredFailed ? (
            <EmptyState>
              <EmptyState.VisualPreset context="query" type="something-wrong" />
              <EmptyState.Title>Couldn't load network data</EmptyState.Title>
              <EmptyState.Details>Check that the app has the storage:smartscape:read and storage:metrics:read permissions, then refresh.</EmptyState.Details>
              <EmptyState.Actions>
                <Button variant="emphasized" onClick={refresh}>Refresh</Button>
                <Button onClick={() => setUrl({ source: "example" })}>Show example</Button>
              </EmptyState.Actions>
            </EmptyState>
          ) : showProgress ? (
            <>
              <ProgressCircle aria-label="Loading network data" />
              <Text>{url.source === "example" ? (url.scale === "xl" ? "Building the extra-large example network · 20,000 devices" : "Building the example network") : `Loading network data · ${net.done} of ${net.total} queries`}</Text>
            </>
          ) : null}
        </div>
        <ToastContainer />
        {settings}
      </>
    );
  }

  const pageProps = { model, infos, filters, onFilters: (patch: Partial<Filters>) => setUrl(patch, false), selected: url.sel, onSelect: select };
  // a preview keeps the page: an empty WAN links page shows what WAN links would look like
  const onExample = url.source === "live" ? () => setUrl({ source: "example", cause: null, sel: null, ...NO_FILTERS }) : undefined;
  const onLive = url.source === "example" ? () => setUrl({ source: "live", cause: null, sel: null, ...NO_FILTERS }) : undefined;
  // each page offers the step it needs itself first, then the most valuable one overall
  const nextFor = (keys: NeedKey[]) => {
    const pending = steps.find((s) => !s.done && keys.includes(s.need)) ?? steps.find((s) => !s.done);
    return pending ? { step: pending, coverage: inUse, onHow: (need: NeedKey) => openSettings(need) } : null;
  };
  const visualProps = { ...pageProps, needs, failed: net.failed, view: url.view, onView: (view: "visual" | "table") => setUrl({ view }, false), onExample, onLive, onSettings: openSettings, nextFor };

  return (
    <div className="np-root">
      <PageLayout>
        <PageLayout.Header>{header}</PageLayout.Header>

        <PageLayout.Content>
          <nav className="np-tabs" aria-label="Pages">
            {PAGES.map(([p, label]) => (
              <a key={p} className={`np-tabs__a${page === p ? " is-on" : ""}`} href={hrefOf(p, url.source, url.scale)}
                onClick={nav(p)} aria-current={page === p ? "page" : undefined}>{label}</a>
            ))}
          </nav>
          {page === "causes" ? (
            <LiveMapPage model={model} infos={infos} causeId={url.cause} failed={net.failed} needs={needs} onExample={onExample} onSettings={openSettings} next={nextFor(VIEW_NEEDS.map)} onLive={onLive} onCause={(cause) => setUrl({ cause }, false)}
              onSite={(code) => select(`site:${code}`)} onDevice={(name) => select(`device:${name}`)}
              onSites={(patch) => setUrl({ page: "sites", sel: null, ...NO_FILTERS, ...patch })} />
          ) : page === "traffic" ? (
            <TrafficPage model={model} needs={needs} onSettings={openSettings} onSite={(code) => select(`site:${code}`)} onExample={onExample} />
          ) : page === "devices" ? <DevicesVisual {...visualProps} /> : page === "links" ? <LinksVisual {...visualProps} /> : <SitesVisual {...visualProps} />}
        </PageLayout.Content>

        <SearchPalette model={model} open={searchOpen} onClose={() => setSearchOpen(false)} onOpen={(sel) => select(sel)} />
        <PageLayout.Details collapsed={!url.sel} defaultWidth="44%" minWidth={460} onCollapsedChange={(collapsed) => { if (collapsed) select(null); }}>
          {url.sel && (
            <EntityDetails model={model} infos={infos} needs={needs} sel={url.sel} tab={url.tab}
              onTab={(tab) => setUrl({ tab }, false)} onSelect={select} onClose={() => select(null)} />
          )}
        </PageLayout.Details>
      </PageLayout>
      <ToastContainer />
      {settings}
    </div>
  );
}
