import React from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Device, NetEvent } from "../model/types";
import { fmtInt, hhmm } from "../utils/format";

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
  if (!events.length) {
    // "nothing arrived" and "this device's lines are not among the ones read" are different statements,
    // and saying the first when the second is true contradicts the counters drawn right above: the text
    // comes from the newest lines of the whole environment, the counts from a per-device series.
    const sys = devices.reduce((a, d) => a + d.syslog.ERROR + d.syslog.WARN + d.syslog.INFO, 0);
    const traps = devices.reduce((a, d) => a + d.traps, 0);
    return (
      <p className="np-muted">
        {sys + traps > 0
          ? `No lines from ${devices.length === 1 ? "this device" : "these devices"} among the newest read for the environment (last 3 hours). ${devices.length === 1 ? "Its" : "Their"} counters report ${fmtInt(sys)} syslog message${sys === 1 ? "" : "s"} and ${fmtInt(traps)} trap${traps === 1 ? "" : "s"} in the last 6 hours.`
          : "No syslog messages or traps in the last 3 hours."}
      </p>
    );
  }
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
