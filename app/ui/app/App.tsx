// NetworkPlane — network health per site, device and WAN link, with the probable cause.
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
import type { Filters } from "./pages/EntityPages";
import { DevicesVisual, LinksVisual, SitesVisual } from "./pages/VisualPages";
import { LiveMapPage } from "./pages/LiveMapPage";
import { evaluateNeeds, VIEW_NEEDS } from "./data/requirements";
import { DataNeeds } from "./components/DataNeeds";
import { SettingsSheet } from "./components/SettingsSheet";
import { SettingIcon } from "@dynatrace/strato-icons";

const APP_NAME = "NetworkPlane";
const LABEL: Record<Page, string> = { causes: "Live map", sites: "Sites", devices: "Devices", links: "WAN links" };
const NO_FILTERS: Filters = { status: null, region: null, role: null, carrier: null, q: "" };
const DOCS = {
  networks: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks",
  networkDevices: "https://docs.dynatrace.com/docs/observe/infrastructure-observability/networks/network-devices/network-devices-get-started-guide",
};
const hrefOf = (p: Page, source: "live" | "example") => {
  const q = new URLSearchParams();
  if (p !== "causes") q.set("page", p);
  if (source === "example") q.set("source", "example");
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
  const net = useNetwork(url.source);
  const model = net.model;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const infos = useMemo(() => (model ? allSites(model) : []), [model]);
  const needs = useMemo(() => evaluateNeeds(net.counts, model, url.source), [JSON.stringify(net.counts), model, url.source]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const refresh = () => {
    net.refetch();
    showToast({ title: "Refresh started", type: "info" });
  };

  const header = (
    <AppHeader>
      <AppHeader.Navigation>
        <AppHeader.Logo appName={APP_NAME} href={hrefOf("causes", url.source)} onClick={nav("causes")} />
        <AppHeader.NavigationItem isSelected={page === "causes"} href={hrefOf("causes", url.source)} onClick={nav("causes")}>Live map</AppHeader.NavigationItem>
        <AppHeader.NavigationItem isSelected={page === "sites"} href={hrefOf("sites", url.source)} onClick={nav("sites")}>Sites</AppHeader.NavigationItem>
        <AppHeader.NavigationItem isSelected={page === "devices"} href={hrefOf("devices", url.source)} onClick={nav("devices")}>Devices</AppHeader.NavigationItem>
        <AppHeader.NavigationItem isSelected={page === "links"} href={hrefOf("links", url.source)} onClick={nav("links")}>WAN links</AppHeader.NavigationItem>
      </AppHeader.Navigation>
      <AppHeader.ActionItems>
        {url.source === "live" && (
          <AppHeader.ActionButton onClick={refresh} aria-label="Refresh network data">
            {net.loading ? `Loading ${net.done} of ${net.total}` : `Updated ${model?.meta.generatedAt.slice(11, 16) ?? "—"} UTC`}
          </AppHeader.ActionButton>
        )}
        <AppHeader.ActionButton onClick={() => setSettingsOpen(true)} aria-label="Settings" prefixIcon={<SettingIcon />} showLabel={false}>Settings</AppHeader.ActionButton>
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
    <SettingsSheet show={settingsOpen} onDismiss={() => setSettingsOpen(false)} model={model} needs={needs} source={url.source}
      onSource={(source) => setUrl({ source, page: "causes", cause: null, sel: null, ...NO_FILTERS })} />
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
              <Text>{url.source === "example" ? "Building the example network" : `Loading network data · ${net.done} of ${net.total} queries`}</Text>
            </>
          ) : null}
        </div>
        <ToastContainer />
        {settings}
      </>
    );
  }

  const pageProps = { model, infos, filters, onFilters: (patch: Partial<Filters>) => setUrl(patch, false), selected: url.sel, onSelect: select };
  const onExample = url.source === "live" ? () => setUrl({ source: "example", page: "causes", cause: null, sel: null, ...NO_FILTERS }) : undefined;
  const visualProps = { ...pageProps, needs, failed: net.failed, view: url.view, onView: (view: "visual" | "table") => setUrl({ view }, false), onExample };

  return (
    <div className="np-root">
      <PageLayout>
        <PageLayout.Header>{header}</PageLayout.Header>

        <PageLayout.Content>
          {page === "causes" ? (
            <LiveMapPage model={model} infos={infos} causeId={url.cause} failed={net.failed} needs={needs} onExample={onExample} onCause={(cause) => setUrl({ cause }, false)}
              onSite={(code) => select(`site:${code}`)} onDevice={(name) => select(`device:${name}`)}
              onSites={(patch) => setUrl({ page: "sites", sel: null, ...NO_FILTERS, ...patch })} />
          ) : page === "devices" ? <DevicesVisual {...visualProps} /> : page === "links" ? <LinksVisual {...visualProps} /> : <SitesVisual {...visualProps} />}
        </PageLayout.Content>

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
