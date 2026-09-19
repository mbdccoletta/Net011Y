// Navigation state lives in the URL so any view can be shared or reloaded as-is
// (Dynatrace guideline: keep entity, filters and active tab in the URL).
import { useCallback, useEffect, useState } from "react";

export type Page = "causes" | "sites" | "devices" | "links" | "traffic";
const PAGES: Page[] = ["causes", "sites", "devices", "links", "traffic"];

export interface UrlState {
  page: Page;
  /** Probable cause shown on the causes page */
  cause: string | null;
  /** Entity open in the details panel: site:CODE, device:NAME or link:ID */
  sel: string | null;
  tab: string;
  status: string | null;
  region: string | null;
  role: string | null;
  carrier: string | null;
  q: string;
  /** Visual or table rendering of the entity pages */
  view: "visual" | "table";
  source: "live" | "example";
  /** size of the example network: the enterprise one, or an extra-large estate of about 20,000 devices */
  scale: "xl" | null;
}

const KEYS = ["cause", "sel", "tab", "status", "region", "role", "carrier", "q"] as const;

function read(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const page = p.get("page") as Page;
  return {
    page: PAGES.includes(page) ? page : "causes",
    cause: p.get("cause"),
    sel: p.get("sel"),
    tab: p.get("tab") || "overview",
    status: p.get("status"),
    region: p.get("region"),
    role: p.get("role"),
    carrier: p.get("carrier"),
    q: p.get("q") ?? "",
    view: p.get("view") === "table" ? "table" : "visual",
    source: p.get("source") === "example" ? "example" : "live",
    scale: p.get("source") === "example" && p.get("scale") === "xl" ? "xl" : null,
  };
}

export function useUrlState() {
  const [state, setState] = useState<UrlState>(read);

  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback((patch: Partial<UrlState>, push = true) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const p = new URLSearchParams();
      if (next.page !== "causes") p.set("page", next.page);
      KEYS.forEach((k) => {
        const v = next[k];
        if (v && !(k === "tab" && (v === "overview" || !next.sel))) p.set(k, v);
      });
      if (next.view === "table" && next.page !== "causes") p.set("view", "table");
      if (next.source === "example") p.set("source", "example");
      if (next.source === "example" && next.scale === "xl") p.set("scale", "xl");
      const url = `${window.location.pathname}${p.toString() ? `?${p}` : ""}`;
      if (push) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
      return next;
    });
  }, []);

  return [state, update] as const;
}
