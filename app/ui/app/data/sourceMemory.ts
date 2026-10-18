// What this environment sends, and what it does not, remembered where the environment can see it.
//
// Three notes drive every decision this app makes about what to ask Grail: the sources whose probe came
// back empty, the ones that answered, and the measures a vendor family does not publish. They were kept
// in `window.localStorage`, which makes them one browser's opinion: a colleague opening the same app on
// the same environment re-ran every probe this browser had already settled, and an answer written here
// at nine in the morning was invisible to the person who opened the app at nine-oh-one. They are facts
// about the environment, so they live in the environment, in app state, the same place the drop
// threshold and the log bucket live.
//
// It is a cache, not a setting: nothing is lost if the read fails or the tenant refuses the write. The
// app then asks the questions it would have skipped, which is the behaviour it had before any of this
// existed.
import { useSyncExternalStore } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";

const KEY = "net-o11y.source-memory";

/** A map of name → the moment the note was written. */
export type Stamps = Record<string, number>;
export interface SourceMemory { absent: Stamps; present: Stamps; barren: Stamps }

const EMPTY: SourceMemory = { absent: {}, present: {}, barren: {} };

let memory: SourceMemory = EMPTY;
let loaded = false;
/**
 * Whether anything has been written here since the page opened.
 *
 * The first read and a write can be in flight together, and a read that was asked for before
 * anybody wrote has nothing to say once they have — the same race the drop threshold hit, where a
 * stale read landed second and put the old value back on the screen. Here the loaded document is
 * merged under what is already in memory rather than over it.
 */
let touched = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const stamps = (v: unknown): Stamps => {
  if (!v || typeof v !== "object") return {};
  const out: Stamps = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
  return out;
};

/** The newer note of the two, per name: two browsers writing the same environment both have something to say. */
const merge = (mine: Stamps, theirs: Stamps): Stamps => {
  const out = { ...theirs };
  for (const [k, t] of Object.entries(mine)) out[k] = Math.max(t, out[k] ?? 0);
  return out;
};

function load() {
  if (loaded) return;
  loaded = true;
  stateClient.getAppState({ key: KEY })
    .then((s) => {
      const doc = JSON.parse(s.value) as Partial<SourceMemory>;
      const stored = { absent: stamps(doc?.absent), present: stamps(doc?.present), barren: stamps(doc?.barren) };
      memory = touched
        ? { absent: merge(memory.absent, stored.absent), present: merge(memory.present, stored.present), barren: merge(memory.barren, stored.barren) }
        : stored;
      notify();
    })
    .catch(() => { /* never written, or no permission to read it: the app asks the questions */ });
}

/**
 * Writes are collected and sent once.
 *
 * A load settles half a dozen probes within a second of each other and each one would be a round
 * trip of its own. The note is not urgent — what it saves is the *next* load — so the last state
 * within a second and a half is the one that travels.
 */
let pending: ReturnType<typeof setTimeout> | null = null;
const send = () => {
  if (pending) { clearTimeout(pending); pending = null; }
  stateClient.setAppState({ key: KEY, body: { value: JSON.stringify(memory) } })
    .catch(() => { /* the tenant refused it: this browser keeps the note, the next load re-probes */ });
};
function save() {
  touched = true;
  notify();
  if (pending) clearTimeout(pending);
  pending = setTimeout(send, 1500);
}
/* A note still waiting when the tab goes away is the note the next reader most wants: the probes that
   just settled. The browser cancels a request in flight as the page unloads, so it is sent at the first
   sign the page is leaving rather than at the end of the wait. */
if (typeof document !== "undefined") {
  const flush = () => { if (pending) send(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}

export function sourceMemory(): SourceMemory { load(); return memory; }

export const setAbsent = (absent: Stamps) => { memory = { ...memory, absent }; save(); };
export const setPresent = (present: Stamps) => { memory = { ...memory, present }; save(); };
export const setBarren = (barren: Stamps) => { memory = { ...memory, barren }; save(); };
/** Check again: everything this environment was believed to send, or not to, is asked afresh. */
export const clearSourceMemory = () => { memory = { absent: {}, present: {}, barren: {} }; save(); };

export function useSourceMemory(): SourceMemory {
  load();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => memory);
}
