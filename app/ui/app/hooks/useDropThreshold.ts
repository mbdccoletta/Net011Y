// How far below its usual traffic an hour has to fall before the app calls it a suspicion. It is the
// customer's number, like the SLA on a circuit: stored in the tenant as app state so the whole team works
// from the same one, with a copy in the browser while the tenant call is in flight.
import { useSyncExternalStore } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";
import { getEnvironmentId } from "@dynatrace-sdk/app-environment";
import { DEFAULT_DROP_PCT } from "../model/suspicion";

const KEY = "net-o11y.drop-threshold";
const LOCAL_KEY = (() => { try { return `${KEY}@${getEnvironmentId()}`; } catch { return KEY; } })();
const listeners = new Set<() => void>();

let pct = DEFAULT_DROP_PCT;
let loaded = false;

const notify = () => listeners.forEach((l) => l());
const clamp = (v: number) => Math.min(95, Math.max(5, Math.round(v)));
const parse = (value: string): number => { const n = Number(JSON.parse(value)); return Number.isFinite(n) ? clamp(n) : DEFAULT_DROP_PCT; };

function load() {
  if (loaded) return;
  loaded = true;
  try { const v = window.localStorage.getItem(LOCAL_KEY); if (v) pct = parse(v); } catch { /* storage unavailable */ }
  stateClient.getAppState({ key: KEY })
    .then((s) => { pct = parse(s.value); try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(pct)); } catch { /* ignore */ } notify(); })
    .catch(() => { /* not set, or no permission: the default stands */ });
}

export async function setDropThreshold(next: number) {
  pct = clamp(next);
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(pct)); } catch { /* ignore */ }
  notify();
  try { await stateClient.setAppState({ key: KEY, body: { value: JSON.stringify(pct) } }); } catch { /* stays local */ }
}

export function useDropThreshold(): number {
  load();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pct);
}
