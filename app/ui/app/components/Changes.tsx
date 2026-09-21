// "What changed in the last 24 hours" beside the map: restarts, devices that stopped or started answering,
// alerts that opened or closed and circuits that went down, newest first. A burst of the same change is one
// row that opens into its members; a row opens the device (or the site) it is about.
import React, { useMemo, useState } from "react";
import type { NetworkModel } from "../model/types";
import { CHANGE_LABEL, changesOf, type Change, type ChangeKind } from "../model/changes";
import { fmtInt } from "../utils/format";

const TONE: Record<ChangeKind, string> = {
  restart: "var(--lm-warn)", unreachable: "var(--lm-bad)", answering: "var(--lm-good)",
  "alert-open": "var(--lm-bad)", "alert-closed": "var(--lm-good)", "circuit-down": "var(--lm-bad)",
};
const GLYPH: Record<ChangeKind, string> = { restart: "↻", unreachable: "✕", answering: "✓", "alert-open": "!", "alert-closed": "✓", "circuit-down": "⌁" };
const FILTERS: { key: string; label: string; kinds: ChangeKind[] }[] = [
  { key: "all", label: "All", kinds: ["restart", "unreachable", "answering", "alert-open", "alert-closed", "circuit-down"] },
  { key: "restart", label: "Restarts", kinds: ["restart"] },
  { key: "reach", label: "Reachability", kinds: ["unreachable", "answering"] },
  { key: "alerts", label: "Alerts", kinds: ["alert-open", "alert-closed"] },
  { key: "circuits", label: "Circuits", kinds: ["circuit-down"] },
];
const hhmm = (t: string) => t.slice(11, 16);
const dayOf = (t: string) => t.slice(0, 10);
const count = (c: Change) => c.members?.length ?? 1;

export function ChangesPanel({ model, onDevice, onSite }: { model: NetworkModel; onDevice: (name: string) => void; onSite: (code: string) => void }) {
  const all = useMemo(() => changesOf(model), [model]);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const kinds = FILTERS.find((f) => f.key === filter)!.kinds;
  const shown = all.filter((c) => kinds.includes(c.kind));
  const tally = (ks: ChangeKind[]) => all.filter((c) => ks.includes(c.kind)).reduce((a, c) => a + count(c), 0);
  const today = dayOf(new Date().toISOString());
  const go = (c: Change) => (c.device ? onDevice(c.device) : c.site ? onSite(c.site) : undefined);

  return (
    <div className="lm-chg">
      <h2 className="lm-h">{all.length ? `${fmtInt(tally(FILTERS[0].kinds))} changes · last 24 h` : "Nothing changed in the last 24 h"}</h2>
      <div className="lm-chg__filters" role="group" aria-label="Kind of change">
        {FILTERS.filter((f) => f.key === "all" || tally(f.kinds) > 0).map((f) => (
          <button key={f.key} type="button" className={`lm-chg__chip${filter === f.key ? " is-on" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}<b>{fmtInt(tally(f.kinds))}</b>
          </button>
        ))}
      </div>
      {!all.length && (
        <p className="lm-chg__empty">No restart, no device that stopped answering, no alert opened or closed and no circuit down since this time yesterday.</p>
      )}
      <ol className="lm-chg__list">
        {shown.map((c, i) => {
          const id = `${c.kind}|${c.t}|${c.title}`;
          const isOpen = open === id;
          const newDay = i === 0 || dayOf(shown[i - 1].t) !== dayOf(c.t);
          return (
            <li key={id}>
              {newDay && <span className="lm-chg__day">{dayOf(c.t) === today ? "Today" : "Yesterday"}</span>}
              <button type="button" className={`lm-chg__row${c.members ? " is-group" : ""}${isOpen ? " is-open" : ""}`} style={{ "--c": TONE[c.kind] } as React.CSSProperties}
                aria-expanded={c.members ? isOpen : undefined} title={`${CHANGE_LABEL[c.kind]} · ${c.title}${c.detail ? ` · ${c.detail}` : ""}`}
                onClick={() => (c.members ? setOpen(isOpen ? null : id) : go(c))}>
                <time dateTime={c.t}>{hhmm(c.t)}</time>
                <i aria-hidden="true">{GLYPH[c.kind]}</i>
                <span className="lm-chg__what"><b>{c.title}</b><small>{c.detail}</small></span>
                {c.members && <em aria-hidden="true">{isOpen ? "–" : "+"}</em>}
              </button>
              {c.members && isOpen && (
                <ul className="lm-chg__members">
                  {c.members.slice(0, 60).map((m) => (
                    <li key={`${m.device ?? m.site}|${m.t}`}>
                      <button type="button" title={`${m.device ?? m.title}${m.detail ? ` · ${m.detail}` : ""}`} onClick={() => go(m)}><time dateTime={m.t}>{hhmm(m.t)}</time><span>{m.device ?? m.title}</span><small>{m.detail}</small></button>
                    </li>
                  ))}
                  {c.members.length > 60 && <li className="lm-chg__more">and {fmtInt(c.members.length - 60)} more</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
