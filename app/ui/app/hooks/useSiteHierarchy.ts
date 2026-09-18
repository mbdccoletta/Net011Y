// The sequence of levels that groups sites in the list next to the map (for example
// country › federative unit › site). Stored in the tenant as app state, so every user of the app sees
// the same hierarchy; the browser keeps a copy so the list still works while the tenant call is in
// flight or when the user may not write app state.
import { useSyncExternalStore } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";
import { getEnvironmentId } from "@dynatrace-sdk/app-environment";
import type { NetworkModel, Site } from "../model/types";

const KEY = "net-o11y.site-hierarchy";
// the browser copy is per environment: in local development every tenant shares the same localhost origin,
// and one environment's hierarchy must never show up in another
const LOCAL_KEY = (() => { try { return `${KEY}@${getEnvironmentId()}`; } catch { return KEY; } })();
const listeners = new Set<() => void>();

export type SaveState = "idle" | "saving" | "saved" | "local-only" | "no-permission";

let levels: string[] = [];
let loaded = false;
let saveState: SaveState = "idle";

const notify = () => listeners.forEach((l) => l());
const readLocal = (): string[] => {
  try {
    const v = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
const writeLocal = (v: string[]) => { try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const parse = (value: string): string[] => {
  try { const v = JSON.parse(value); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

/** Reads the hierarchy from the tenant once; falls back to the copy in this browser. */
function load() {
  if (loaded) return;
  loaded = true;
  levels = readLocal();
  stateClient.getAppState({ key: KEY })
    .then((s) => { levels = parse(s.value); writeLocal(levels); notify(); })
    .catch((e: unknown) => {
      const msg = String((e as { message?: string })?.message ?? e);
      // 403 means this user can't read app state; 404 means nobody has set it in this environment yet,
      // so the app starts unset instead of reusing what the browser kept from another environment
      if (/403|permission|forbidden/i.test(msg)) { saveState = "no-permission"; notify(); }
      else if (/404|not found/i.test(msg)) { levels = []; writeLocal(levels); notify(); }
    });
}

export async function setSiteHierarchy(next: string[]) {
  levels = [...next];
  writeLocal(levels);
  saveState = "saving";
  notify();
  try {
    await stateClient.setAppState({ key: KEY, body: { value: JSON.stringify(levels) } });
    saveState = "saved";
  } catch (e) {
    saveState = /403|permission|forbidden/i.test(String((e as { message?: string })?.message ?? e)) ? "no-permission" : "local-only";
  }
  notify();
}

export function useSiteHierarchy(): { levels: string[]; setLevels: (v: string[]) => void; saveState: SaveState } {
  load();
  const state = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => `${saveState}|${levels.join(",")}`,
  );
  const [state0] = state.split("|");
  return { levels, setLevels: (v) => void setSiteHierarchy(v), saveState: state0 as SaveState };
}

/** Site fields the app derives itself, usable as levels when primary tags aren't sent yet. */
const DERIVED: Record<string, (s: Site) => string | undefined> = {
  "site.region": (s) => s.region,
  "site.type": (s) => (s.dc ? "Data center" : "Branch"),
  "site.hub": (s) => s.hub ?? (s.dc ? s.code : undefined),
  "site.state": (s) => s.uf,
  "site.city": (s) => s.city,
};

/** The value of a level for a site: a primary tag, or a field the app derives. */
export const levelValue = (site: Site, key: string): string | undefined =>
  key.startsWith("primary_tags.") ? site.tags?.[key] : DERIVED[key]?.(site);

/** Levels available in this environment: primary tags on the sites plus the fields the app derives. */
export function availableTagKeys(model: NetworkModel | null): { key: string; sites: number; values: number }[] {
  if (!model) return [];
  const stats = new Map<string, { sites: number; values: Set<string> }>();
  Object.values(model.sites).forEach((s) => {
    const entries: [string, string][] = [
      ...Object.entries(s.tags ?? {}),
      ...Object.keys(DERIVED).map((k) => [k, levelValue(s, k)] as [string, string | undefined]).filter((e): e is [string, string] => !!e[1]),
    ];
    entries.forEach(([k, v]) => {
      const st = stats.get(k) ?? { sites: 0, values: new Set<string>() };
      st.sites++; st.values.add(v); stats.set(k, st);
    });
  });
  return [...stats].map(([key, st]) => ({ key, sites: st.sites, values: st.values.size }))
    .sort((a, b) => a.values - b.values || a.key.localeCompare(b.key));
}

export const tagLabel = (key: string) => key.replace(/^primary_tags\.|^site\./, "").replace(/[_-]+/g, " ");

export const isPrimaryTag = (key: string) => key.startsWith("primary_tags.");

/** true when each value of `child` sits under a single value of `parent` (a real sub-level). */
function nestsUnder(sites: Site[], parent: string, child: string, tolerance = 0.9): boolean {
  const parents = new Map<string, Set<string>>();
  for (const s of sites) {
    const c = levelValue(s, child), p = levelValue(s, parent);
    if (c == null || p == null) continue;
    const set = parents.get(c) ?? new Set<string>();
    set.add(p); parents.set(c, set);
  }
  if (!parents.size) return false;
  const nested = [...parents.values()].filter((v) => v.size === 1).length;
  return nested >= parents.size * tolerance;
}

/** true when `key` can sit at the end of `chain` (broader than the last level and nested in all of them). */
export function fitsUnder(model: NetworkModel | null, chain: string[], key: string): boolean {
  const sites = model ? Object.values(model.sites) : [];
  if (!sites.length || !chain.length) return true;
  return chain.every((parent) => parent !== key && nestsUnder(sites, parent, key));
}

/**
 * Suggests a hierarchy from what this environment actually carries: the primary tags the customer put on
 * the devices. Whatever keys they chose (`primary_tags.country`, `primary_tags.bu`, `primary_tags.store` …)
 * are the candidates; the app orders them from the broadest to the most specific, keeping only levels that
 * nest inside the level before them. The fields the app derives from the site codes (region, type, hub,
 * state, city) are used only while no primary tag is on the sites yet, so the suggestion follows the
 * customer's tagging instead of a fixed list of names.
 */
export function suggestHierarchy(model: NetworkModel | null, maxLevels = 4): string[] {
  return suggestHierarchyDetail(model, maxLevels).levels;
}

export interface HierarchySuggestion {
  levels: string[];
  /** where the levels come from: the customer's primary tags, or the fields the app derives */
  source: "primary-tags" | "derived" | "none";
  /** the keys that were considered, so Settings can say what the suggestion was built from */
  considered: string[];
}

export function suggestHierarchyDetail(model: NetworkModel | null, maxLevels = 4): HierarchySuggestion {
  const sites = model ? Object.values(model.sites) : [];
  const none: HierarchySuggestion = { levels: [], source: "none", considered: [] };
  if (sites.length < 2) return none;

  // A level is worth suggesting when it splits the sites into more than one group and is present on most
  // of them. A level with one value per site groups nothing, so it is dropped — except in a small
  // environment, where two sites in two regions is still the grouping the customer wants to see.
  const dropOnePerSite = sites.length > 4;
  const usable = availableTagKeys(model)
    .filter((k) => k.values > 1 && (dropOnePerSite ? k.values < sites.length : k.values <= sites.length) && k.sites >= sites.length * 0.6);
  const tagged = usable.filter((k) => isPrimaryTag(k.key));
  const pool = tagged.length ? tagged : usable; // the customer's own tags win whenever there are any
  if (!pool.length) return none;

  // drop keys that split the sites the same way as a key already kept, whatever the labels
  // (for example primary_tags.region with "southeast" and the derived region with "Southeast")
  const signature = (key: string) => {
    const index = new Map<string, number>();
    return sites.map((s) => {
      const v = (levelValue(s, key) ?? "").toLowerCase();
      if (!index.has(v)) index.set(v, index.size);
      return index.get(v);
    }).join("|");
  };
  const seen = new Set<string>();
  const unique = pool
    .slice()
    .sort((a, b) => a.values - b.values || b.sites - a.sites || a.key.localeCompare(b.key)) // broadest first
    .filter((k) => { const sig = signature(k.key); if (seen.has(sig)) return false; seen.add(sig); return true; });

  // search the best chain instead of taking the first fit: more levels first, then finer detail at the end
  const score = (chain: string[]) => {
    const leaf = unique.find((k) => k.key === chain[chain.length - 1]);
    return chain.length * 1000 + (leaf ? leaf.values : 0);
  };
  let best: string[] = [];
  const grow = (chain: string[], rest: { key: string; values: number }[]) => {
    if (chain.length && score(chain) > score(best)) best = [...chain];
    if (chain.length >= maxLevels) return;
    rest.forEach((k, i) => {
      if (chain.every((parent) => nestsUnder(sites, parent, k.key))) grow([...chain, k.key], rest.slice(i + 1));
    });
  };
  grow([], unique);
  if (!best.length) return none;
  return { levels: best, source: tagged.length ? "primary-tags" : "derived", considered: unique.map((k) => k.key) };
}
