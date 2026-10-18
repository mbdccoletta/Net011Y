// How far below its usual traffic an hour has to fall before the app calls it a suspicion. It is the
// customer's number, like the SLA on a circuit: stored in the tenant as app state so the whole team works
// from the same one. Nothing is kept in the browser — a value mirrored there is one user's copy of a
// setting that belongs to the environment, and it outlives the change that replaced it.
import { useSyncExternalStore } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";
import { DEFAULT_DROP_PCT } from "../model/suspicion";

const KEY = "net-o11y.drop-threshold";
const listeners = new Set<() => void>();

let pct = DEFAULT_DROP_PCT;
let loaded = false;

const notify = () => listeners.forEach((l) => l());
const clamp = (v: number) => Math.min(95, Math.max(5, Math.round(v)));
const parse = (value: string): number => { const n = Number(JSON.parse(value)); return Number.isFinite(n) ? clamp(n) : DEFAULT_DROP_PCT; };

function load() {
  if (loaded) return;
  loaded = true;
  stateClient.getAppState({ key: KEY })
    .then((s) => { pct = parse(s.value); notify(); })
    .catch(() => { /* not set, or no permission: the default stands */ });
}

export async function setDropThreshold(next: number) {
  pct = clamp(next);
  notify();
  try { await stateClient.setAppState({ key: KEY, body: { value: JSON.stringify(pct) } }); } catch { /* the tenant refused it: the screen shows the new value, the next load shows the stored one */ }
}

export function useDropThreshold(): number {
  load();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pct);
}
