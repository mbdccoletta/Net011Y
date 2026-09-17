// Bullets listing the data a view needs and whether this environment sends it.
import React, { useState } from "react";
import { ExternalLink } from "@dynatrace/strato-components/typography";
import type { Need, NeedKey } from "../data/requirements";
import { SETUP } from "../data/setupGuide";
import { ChevronDownIcon, ChevronUpIcon, CriticalIcon, HelpIcon, InformationIcon, RefreshIcon, SuccessIcon, WarningIcon } from "@dynatrace/strato-icons";

const MARK: Record<Need["status"], { sym: React.ReactNode; cls: string; label: string }> = {
  ok: { sym: <SuccessIcon />, cls: "ok", label: "received" },
  partial: { sym: <WarningIcon />, cls: "partial", label: "partly received" },
  missing: { sym: <CriticalIcon />, cls: "missing", label: "missing" },
  loading: { sym: <RefreshIcon />, cls: "loading", label: "loading" },
  simulated: { sym: <InformationIcon />, cls: "sim", label: "simulated" },
  manual: { sym: <HelpIcon />, cls: "manual", label: "checked on use" },
};

interface Props {
  title?: string;
  keys: NeedKey[];
  needs: Record<NeedKey, Need>;
  /** Start expanded; collapsed by default */
  open?: boolean;
  compact?: boolean;
}

export function DataNeeds({ title = "Data this view needs", keys, needs, open, compact }: Props) {
  const list = keys.map((k) => needs[k]).filter(Boolean);
  const missing = list.filter((n) => n.status === "missing" || n.status === "partial").length;
  const received = list.filter((n) => n.status === "ok").length;
  // always starts collapsed unless a caller asks for it open (the empty state does)
  const [expanded, setExpanded] = useState(open ?? false);
  const id = `needs-${keys.join("-")}`;
  return (
    <section className={`dn${compact ? " dn--compact" : ""}`} aria-label={title}>
      <button type="button" className="dn__head" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
        <span className="dn__title">{title}</span>
        <span className="dn__score">
          {list.some((n) => n.status === "simulated") ? "example data" : `${received}/${list.filter((n) => n.status !== "manual").length} received${missing ? ` · ${missing} to send` : ""}`}
        </span>
        <span className="dn__chev" aria-hidden="true">{expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
      </button>
      {expanded && (
        <ul className="dn__list" id={id}>
          {list.map((n) => {
            const m = MARK[n.status];
            return (
              <li key={n.key} className={`dn__item dn__item--${m.cls}`}>
                <span className="dn__mark" role="img" aria-label={m.label}>{m.sym}</span>
                <span className="dn__body">
                  <b>{n.label}</b><em>{n.detail}</em>
                  <span className="dn__how">{n.how}</span>
                  {/* the official documentation for whatever is still missing, so setting it up is one click away */}
                  {n.status !== "ok" && n.status !== "simulated" && (SETUP[n.key]?.docs ?? []).length > 0 && (
                    <span className="dn__docs">
                      {SETUP[n.key].docs.map((d) => <ExternalLink key={d.href} href={d.href}>{d.label}</ExternalLink>)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {expanded && <p className="dn__foot">Step-by-step instructions, queries and examples for every item: Settings › Data.</p>}
    </section>
  );
}
