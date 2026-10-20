// A setting that belongs to the environment, not to a browser.
//
// Both of the app's settings — how far below its usual traffic an hour has to fall before the app calls
// it a suspicion, and which buckets hold the network's logs — are the customer's numbers, like the SLA
// on a circuit, and they live in app state so the whole team works from the same one. Each was written
// twice, and each copy had the same two holes in it.
//
// The first: the default was handed out as an answer while the tenant was still being asked. An empty
// bucket list does not mean "read every bucket", it means "nobody has told us yet" — and the log queries
// were planned against it, so the first reads of every session scanned every log in the window and then
// ran again, restricted, when the setting arrived. A caller has to be able to tell "not yet" from "not
// set", so `resolved` is part of what this returns and the reads that depend on it wait for it.
//
// The second: a save that the tenant refused left the new value on the screen and the old one in the
// environment, with nothing said. The reader believes their colleagues see what they see. The value
// that did not land is kept here as `unsaved` so the screen can say so and offer it again.
import { stateClient } from "@dynatrace-sdk/client-state";

export interface SettingState<T> {
  value: T;
  /** false until the environment has answered: nothing may act on the default before it has */
  resolved: boolean;
  /** the environment was asked and could not answer — not the same as never having been set */
  unreadable: boolean;
  /** the last value that did not reach the environment, or null when everything here is stored */
  unsaved: T | null;
}

/** A read that fails for this reason means the setting was never written, which is an answer. */
const missing = (e: unknown) => {
  const status = (e as { response?: { status?: number }; status?: number } | null)?.response?.status
    ?? (e as { status?: number } | null)?.status;
  return status === 404;
};

const RETRY_MS = 1200;

export function envSetting<T>(key: string, fallback: T, parse: (raw: string) => T) {
  let state: SettingState<T> = { value: fallback, resolved: false, unreadable: false, unsaved: null };
  let asked = false;
  /** set here since the page opened: an initial read that lands later must not undo it */
  let touched = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const set = (patch: Partial<SettingState<T>>) => { state = { ...state, ...patch }; notify(); };

  const read = (attempt: number): void => {
    stateClient.getAppState({ key })
      .then((s) => set(touched ? { resolved: true } : { value: parse(s.value), resolved: true, unreadable: false }))
      .catch((e) => {
        // never written is an answer; anything else is the environment failing to answer, and one
        // retry separates a lost request from a permission the app does not have
        if (missing(e)) return set({ resolved: true, unreadable: false });
        if (attempt === 0) { setTimeout(() => read(1), RETRY_MS); return; }
        set({ resolved: true, unreadable: true });
      });
  };
  const load = () => { if (asked) return; asked = true; read(0); };

  const store = (next: T): Promise<void> => {
    touched = true;
    set({ value: next, unsaved: null });
    return stateClient.setAppState({ key, body: { value: JSON.stringify(next) } })
      .then(() => set({ unsaved: null }))
      .catch(() => { set({ unsaved: next }); });
  };

  return {
    /** the value as it stands, asking the environment for its copy on the first call */
    get: (): T => { load(); return state.value; },
    /** everything a screen needs to say what is stored and what is not */
    peek: (): SettingState<T> => { load(); return state; },
    save: (next: T) => store(next),
    /** offer the environment the value it refused, again */
    retry: () => (state.unsaved == null ? Promise.resolve() : store(state.unsaved)),
    /* the two halves of useSyncExternalStore, so each setting keeps its own hook with its own name */
    subscribe: (l: () => void) => { load(); listeners.add(l); return () => { listeners.delete(l); }; },
    snapshot: (): SettingState<T> => state,
  };
}
