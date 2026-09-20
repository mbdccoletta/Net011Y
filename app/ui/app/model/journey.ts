// The traffic journey: from where, through which device, to what — the heaviest paths of the last hour,
// in bytes. Built from placed conversations only, so a filter (one site) is a filter on that list.
import type { Conversation, JourneyLink, JourneyNode, NetworkModel } from "./types";

export interface JourneyRoute { from: string; via: string; to: string; bytes: number; count: number }

export interface Journey {
  nodes: JourneyNode[];
  links: JourneyLink[];
  /** the whole path a conversation takes, from source through device to application, heaviest first */
  routes: JourneyRoute[];
  /** the three nodes a conversation passes through, so a click on a band can list what it carries */
  keyOf: (c: Conversation) => [string, string, string];
  /** the conversations in scope */
  scope: Conversation[];
}

/**
 * Which shape says it better, from the shape of the data: with a handful of paths, or one path carrying
 * nearly the whole hour, there is nothing to cross and a ranked list of paths says it in a fifth of the
 * height; with more, the flow diagram shows where traffic crosses, which the list cannot.
 */
export const asRoutes = (j: Pick<Journey, "routes">) => {
  const total = j.routes.reduce((a, r) => a + r.bytes, 0);
  return j.routes.length <= 3 || (total > 0 && j.routes[0].bytes >= 0.8 * total);
};

/** How many entries a column shows before the rest is folded into "Other". */
export const JOURNEY_TOP = 6;

const shortName = (n: string) => n.replace(/\.[a-z][\w-]*(\.[\w-]+)+$/i, "");

export function buildJourney(
  conversations: Conversation[], sites: NetworkModel["sites"], { site }: { site?: string } = {},
): Journey {
  const inScope = site
    ? conversations.filter((c) => c.viaSite === site || c.fromSite === site || c.toSite === site)
    : conversations;
  const nameOf = (code: string) => sites[code]?.name ?? code;
  // with more sites than a column holds, sources are drawn by region: 300 slivers say less than 4 regions
  const sourceSites = new Set(inScope.filter((c) => c.fromKind === "site").map((c) => c.fromSite));
  const byRegion = !site && sourceSites.size > JOURNEY_TOP && [...sourceSites].some((s) => sites[s!]?.region);
  const regionOf = (code: string) => sites[code]?.region ?? "No region";
  const sitesIn = new Map<string, Set<string>>();
  if (byRegion) inScope.forEach((c) => { if (c.fromKind === "site") { const r = regionOf(c.fromSite!); sitesIn.set(r, (sitesIn.get(r) ?? new Set()).add(c.fromSite!)); } });
  const fromKey = (c: Conversation) => (c.fromKind === "site" ? (byRegion ? `region:${regionOf(c.fromSite!)}` : `site:${c.fromSite}`) : c.fromKind);
  const viaKey = (c: Conversation) => `via:${c.via}`;
  // the far end: the application when it lands inside, the Internet when it leaves
  const toKey = (c: Conversation) => (c.toKind === "internet" ? "to:internet" : `app:${c.app}`);

  // rank each column by bytes, keep the top ones, fold the rest
  const rank = (key: (c: Conversation) => string) => {
    const m = new Map<string, number>();
    inScope.forEach((c) => m.set(key(c), (m.get(key(c)) ?? 0) + c.bytes));
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    // under 1% of the bytes is folded too: a column of slivers says nothing
    return new Set([...m].filter(([, b]) => b >= total * 0.01).sort((a, b) => b[1] - a[1]).slice(0, JOURNEY_TOP).map(([k]) => k));
  };
  const keepFrom = rank(fromKey), keepVia = rank(viaKey), keepTo = rank(toKey);
  const f = (c: Conversation) => (keepFrom.has(fromKey(c)) ? fromKey(c) : "from:other");
  const v = (c: Conversation) => (keepVia.has(viaKey(c)) ? viaKey(c) : "via:other");
  const t = (c: Conversation) => (keepTo.has(toKey(c)) ? toKey(c) : "to:other");

  const nodes = new Map<string, JourneyNode>();
  const node = (id: string, init: () => Omit<JourneyNode, "id" | "bytes">, bytes: number) => {
    const n = nodes.get(id) ?? { id, bytes: 0, ...init() };
    n.bytes += bytes; nodes.set(id, n);
  };
  const routes = new Map<string, JourneyRoute>();
  const links = new Map<string, JourneyLink>();
  const link = (from: string, to: string, bytes: number, count: number) => {
    const k = `${from}>${to}`;
    const l = links.get(k) ?? { from, to, bytes: 0, count: 0 };
    l.bytes += bytes; l.count += count; links.set(k, l);
  };

  for (const c of inScope) {
    const a = f(c), b = v(c), z = t(c);
    node(a, () => a === "from:other" ? { col: 0, label: "Other sources", kind: "private" }
      : c.fromKind === "site" && byRegion ? { col: 0, label: regionOf(c.fromSite!), sub: `${sitesIn.get(regionOf(c.fromSite!))?.size ?? 0} sites`, kind: "site" }
      : c.fromKind === "site" ? { col: 0, label: nameOf(c.fromSite!), kind: "site", site: c.fromSite }
      : c.fromKind === "internet" ? { col: 0, label: "Internet", kind: "internet" }
      : { col: 0, label: "Private, no site", sub: "tag site_cidr to place it", kind: "private" }, c.bytes);
    node(b, () => b === "via:other" ? { col: 1, label: "Other devices", kind: "device" }
      : { col: 1, label: shortName(c.viaName), sub: `exporter${c.viaSite ? ` · ${nameOf(c.viaSite)}` : ""}`, kind: "device", site: c.viaSite ?? undefined }, c.bytes);
    node(z, () => z === "to:other" ? { col: 2, label: "Other applications", kind: "app" }
      : c.toKind === "internet" ? { col: 2, label: "Internet", kind: "internet" }
      : { col: 2, label: c.app, sub: c.toKind === "site" ? nameOf(c.toSite!) : undefined, kind: "app" }, c.bytes);
    link(a, b, c.bytes, c.count);
    link(b, z, c.bytes, c.count);
    const rk = `${a}|${b}|${z}`;
    const r = routes.get(rk) ?? { from: a, via: b, to: z, bytes: 0, count: 0 };
    r.bytes += c.bytes; r.count += c.count; routes.set(rk, r);
  }

  return { nodes: [...nodes.values()], links: [...links.values()], routes: [...routes.values()].sort((x, y) => y.bytes - x.bytes), keyOf: (c) => [f(c), v(c), t(c)], scope: inScope };
}
