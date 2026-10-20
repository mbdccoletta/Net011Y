// How far below its usual traffic an hour has to fall before the app calls it a suspicion. It is the
// customer's number, like the SLA on a circuit: stored in the tenant as app state so the whole team works
// from the same one. Nothing is kept in the browser — a value mirrored there is one user's copy of a
// setting that belongs to the environment, and it outlives the change that replaced it.
//
// `envSetting` holds the two things this file used to get wrong: a read that lands after a save no longer
// undoes it, and a save the tenant refuses is reported instead of sitting on the screen as if it were
// stored.
import { useSyncExternalStore } from "react";
import { envSetting, type SettingState } from "./envSetting";
import { DEFAULT_DROP_PCT } from "../model/suspicion";

const clamp = (v: number) => Math.min(95, Math.max(5, Math.round(v)));
const parse = (value: string): number => { const n = Number(JSON.parse(value)); return Number.isFinite(n) ? clamp(n) : DEFAULT_DROP_PCT; };

const setting = envSetting<number>("net-o11y.drop-threshold", DEFAULT_DROP_PCT, parse);

export const setDropThreshold = (next: number) => setting.save(clamp(next));
/** offer the tenant a value it refused, again */
export const retryDropThreshold = () => setting.retry();

export function useDropThreshold(): number {
  return useDropThresholdState().value;
}

/** the value and what the tenant has done with it, for the screen that lets it be changed */
export function useDropThresholdState(): SettingState<number> {
  return useSyncExternalStore(setting.subscribe, setting.snapshot);
}
