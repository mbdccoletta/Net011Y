// Sites grouped by the primary tag levels chosen in Settings (country › federative unit › site …),
// as an indented tree: each group shows its worst status and how many of its sites have issues.
// Selecting a group focuses its sites on the map; selecting a site opens it.
import React, { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@dynatrace/strato-icons";
import type { Verdict } from "../model/types";
import type { SiteInfo } from "../model/site";
import { isBad, ORDER, worst } from "../model/verdict";
import { levelValue, tagLabel } from "../hooks/useSiteHierarchy";
import { StatusShape } from "./Visual";

interface Group {
  id: string;
  label: string;
  level: number;
  key: string;
  verdict: Verdict;
  sites: SiteInfo[];
  children: Group[];
}

const NOT_TAGGED = "Not tagged";

function build(infos: SiteInfo[], levels: string[], level = 0, parent = ""): Group[] {
  if (level >= levels.length) return [];
  const key = levels[level];
  const byValue = new Map<string, SiteInfo[]>();
  infos.forEach((i) => {
    const v = levelValue(i.site, key) ?? NOT_TAGGED;
    { const l = byValue.get(v); if (l) l.push(i); else byValue.set(v, [i]); }
  });
  return [...byValue].map(([value, sites]): Group => {
    const id = `${parent}/${key}=${value}`;
    return { id, label: value, level, key, sites, verdict: worst(sites.map((s) => s.verdict)), children: build(sites, levels, level + 1, id) };
  }).sort((a, b) => Number(a.label === NOT_TAGGED) - Number(b.label === NOT_TAGGED) || ORDER[a.verdict] - ORDER[b.verdict] || a.label.localeCompare(b.label));
}

interface Props {
  infos: SiteInfo[];
  levels: string[];
  selected: string | null;
  onGroup: (id: string | null, codes: Set<string> | null) => void;
  onSite: (code: string) => void;
}

export function SiteTree({ infos, levels, selected, onGroup, onSite }: Props) {
  const tree = useMemo(() => build(infos, levels), [infos, levels]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.slice(0, 1).map((g) => g.id)));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sortedSites = (sites: SiteInfo[]) => [...sites].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.site.name.localeCompare(b.site.name));

  const siteRow = (i: SiteInfo, depth: number) => (
    <li key={i.code} role="treeitem" aria-level={depth + 1}>
      <button type="button" className="st-row st-row--site" style={{ paddingLeft: 8 + depth * 16 + 18 }} onClick={() => onSite(i.code)}
        title={i.cause ?? `${i.site.name} · ${i.verdict}`}>
        <StatusShape verdict={i.verdict} />
        <span className="st-label">{i.site.name}</span>
        <em className="st-count">{i.code}</em>
      </button>
    </li>
  );

  const groupRow = (g: Group): React.ReactNode => {
    const expanded = open.has(g.id), issues = g.sites.filter((s) => isBad(s.verdict)).length;
    return (
      <li key={g.id} role="treeitem" aria-level={g.level + 1} aria-expanded={expanded}>
        <div className={`st-row st-row--group${selected === g.id ? " is-on" : ""}`} style={{ paddingLeft: 8 + g.level * 16 }}>
          <button type="button" className="st-chev" aria-label={`${expanded ? "Collapse" : "Expand"} ${g.label}`} onClick={() => toggle(g.id)}>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
          <button type="button" className="st-group" aria-pressed={selected === g.id}
            title={`${tagLabel(g.key)} = ${g.label}: focus ${g.sites.length} sites on the map`}
            onClick={() => (selected === g.id ? onGroup(null, null) : onGroup(g.id, new Set(g.sites.map((s) => s.code))))}>
            <StatusShape verdict={g.verdict} />
            <span className="st-label">{g.label}</span>
            <em className="st-count">{issues ? `${issues}/` : ""}{g.sites.length}</em>
          </button>
        </div>
        {expanded && (
          <ul role="group">
            {g.children.length ? g.children.map(groupRow) : sortedSites(g.sites).map((s) => siteRow(s, g.level + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="st">
      {levels.length > 0 && <div className="st-levels">{levels.map(tagLabel).join(" › ")}</div>}
      <ul className="st-tree" role="tree" aria-label="Sites by hierarchy">
        {levels.length ? tree.map(groupRow) : sortedSites(infos).map((s) => siteRow(s, -1))}
      </ul>
      <div className="st-hint">{levels.length ? "Choose the levels in Settings › Site hierarchy." : "No grouping available yet: add primary tags to the sites, then choose the levels in Settings › Site hierarchy."}</div>
    </div>
  );
}
