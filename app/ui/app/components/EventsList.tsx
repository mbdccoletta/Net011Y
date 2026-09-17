import React from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Device, NetEvent } from "../model/types";
import { hhmm } from "../utils/format";

interface Props {
  devices: Device[];
  limit?: number;
  onDevice?: (name: string) => void;
}

/** Syslog and SNMP traps of the given devices, newest first. */
export function EventsList({ devices, limit = 80, onDevice }: Props) {
  const events: { e: NetEvent; device: string }[] = devices
    .flatMap((d) => d.events.map((e) => ({ e, device: d.name })))
    .sort((a, b) => b.e.t.localeCompare(a.e.t))
    .slice(0, limit);
  if (!events.length) return <p className="np-muted">No syslog messages or traps in the last 3 hours.</p>;
  return (
    <ul className="np-events">
      {events.map(({ e, device }, k) => {
        const level = e.kind === "trap" ? "TRAP" : e.level;
        return (
          <li key={`${device}-${e.t}-${k}`}>
            <div className="np-row" style={{ gap: 8 }}>
              <span className={`np-level np-level--${level}`}>{level}</span>
              {e.mnemonic && <span className="np-mono np-small">{e.mnemonic}</span>}
              <span className="np-mono np-small np-muted">{hhmm(e.t)}</span>
              {onDevice && (
                <Button variant="default" size="condensed" onClick={() => onDevice(device)}>{device}</Button>
              )}
            </div>
            <div>{e.text}</div>
          </li>
        );
      })}
    </ul>
  );
}
