// Search everything the app knows, from anywhere: a device by name or address, a site by name, code or city,
// a circuit by carrier or id. ⌘K / Ctrl+K or "/" opens it; arrows move, Enter opens the details panel.
// In an estate of 20,000 devices people arrive knowing what they are looking for.
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkModel, Verdict } from "../model/types";
import { ROLE_LABEL } from "../model/site";
import { ORDER } from "../model/verdict";
import { verdictTone } from "./Visual";
import { MagnifyingGlassIcon } from "@dynatrace/strato-icons";

interface Hit { sel: string; kind: "Device" | "Site" | "Circuit"; title: string; detail: string; verdict: Verdict; hay: string; exact: string[] }

function indexOf(model: NetworkModel): Hit[] {
  const site = (code: string) => model.sites[code]?.name ?? code;
  const hits: Hit[] = [];
  for (const d of model.devices) {
    const ips = [d.ip, ...(d.ips ?? [])].filter(Boolean);
    hits.push({ sel: `device:${d.name}`, kind: "Device", title: d.name, detail: `${ROLE_LABEL[d.role] ?? d.role} · ${site(d.site)}${d.ip ? ` · ${d.ip}` : ""}`, verdict: d.verdict,
      hay: `${d.name} ${ips.join(" ")} ${site(d.site)} ${d.site} ${d.role} ${d.vendor} ${d.location ?? ""}`.toLowerCase(), exact: [d.name.toLowerCase(), ...ips] });
  }
  for (const [code, s] of Object.entries(model.sites)) {
    hits.push({ sel: `site:${code}`, kind: "Site", title: s.name, detail: [code, s.city, s.region, s.dc ? "data center" : null].filter(Boolean).join(" · "),
      verdict: model.siteVerdicts?.[code] ?? "Healthy", hay: `${s.name} ${code} ${s.city ?? ""} ${s.uf ?? ""} ${s.region ?? ""}`.toLowerCase(), exact: [code.toLowerCase(), s.name.toLowerCase()] });
  }
  for (const c of model.circuits ?? []) {
    hits.push({ sel: `link:${c.id}`, kind: "Circuit", title: `${c.siteName} · ${c.kind}`, detail: `${c.carrier} · ${c.tech}${c.status === "down" ? " · down" : ""}`, verdict: c.verdict,
      hay: `${c.id} ${c.carrier} ${c.tech} ${c.siteName} ${c.site} ${c.kind}`.toLowerCase(), exact: [c.id.toLowerCase()] });
  }
  return hits;
}

const LIMIT = 40;

export function SearchPalette({ model, open, onClose, onOpen }: { model: NetworkModel; open: boolean; onClose: () => void; onOpen: (sel: string) => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // built when the palette first opens, once per model
  const index = useMemo(() => (open ? indexOf(model) : []), [model, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      // nothing typed: what needs attention, worst first
      return index.filter((h) => h.verdict === "Critical" || h.verdict === "Warning").sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]).slice(0, 12);
    }
    const whole = terms.join(" ");
    const scored: { h: Hit; s: number }[] = [];
    for (const h of index) {
      if (!terms.every((t) => h.hay.includes(t))) continue;
      const s = (h.exact.includes(whole) ? 0 : h.exact.some((e) => e.startsWith(whole)) ? 1 : h.title.toLowerCase().includes(whole) ? 2 : 3) * 10 + ORDER[h.verdict];
      scored.push({ h, s });
    }
    return scored.sort((a, b) => a.s - b.s || a.h.title.localeCompare(b.h.title)).slice(0, LIMIT).map((x) => x.h);
  }, [q, index]);

  useEffect(() => { if (open) { setQ(""); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  if (!open) return null;
  const choose = (h?: Hit) => { if (!h) return; onOpen(h.sel); onClose(); };
  return (
    <div className="sp-back" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sp" role="dialog" aria-modal="true" aria-label="Search devices, sites and circuits">
        <div className="sp-field">
          <span aria-hidden="true" className="sp-glass"><MagnifyingGlassIcon /></span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a device, address, site, city or carrier" aria-label="Search"
            aria-controls="sp-results" aria-activedescendant={results[at] ? `sp-${at}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(results[at]); }
            }} />
          <kbd>esc</kbd>
        </div>
        <p className="sp-hint">{q.trim() ? `${results.length === LIMIT ? `First ${LIMIT}` : results.length} match${results.length === 1 ? "" : "es"}` : results.length ? "Needs attention now" : "Type to search devices, sites and circuits"}</p>
        <ol ref={list} id="sp-results" className="sp-list" role="listbox">
          {results.map((h, i) => (
            <li key={h.sel} id={`sp-${i}`} data-i={i} role="option" aria-selected={i === at}>
              <button type="button" className={`sp-row${i === at ? " is-on" : ""}`} style={{ "--c": verdictTone(h.verdict) } as React.CSSProperties}
                onMouseMove={() => setAt(i)} onClick={() => choose(h)}>
                <i aria-hidden="true" />
                <span className="sp-what"><b>{h.title}</b><small>{h.detail}</small></span>
                <em>{h.kind}</em>
              </button>
            </li>
          ))}
          {q.trim() && !results.length && <li className="sp-none">Nothing matches “{q.trim()}”.</li>}
        </ol>
        <p className="sp-keys"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>enter</kbd> open · <kbd>⌘K</kbd> search from anywhere</p>
      </div>
    </div>
  );
}
