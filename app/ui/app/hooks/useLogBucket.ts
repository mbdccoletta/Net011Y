// Where the network's own logs live. Grail bills a log query by what it scans, and a filter on log.source
// still reads that column across every log of the window: in a busy environment one hour is ~15 GB. When
// OpenPipeline routes syslog, traps, NetFlow, firewall and autodiscovery records to buckets of their own,
// naming them here makes every log query read only those. Stored in the tenant as app state, like the
// drop threshold, so the whole team shares it.
//
// An empty list is the one answer this setting must never guess. It means "read every bucket", which is
// the most expensive thing the app can do, and it was what every caller saw while the tenant was still
// being asked: the log queries were planned against it, scanned the whole window, and ran again — against
// the right buckets — when the answer arrived a fifth of a second later. `resolved` is the difference
// between "nobody has set this" and "nobody has answered yet", and the reads wait for it.
import { useSyncExternalStore } from "react";
import { envSetting, type SettingState } from "./envSetting";

/** Bucket names are lower case letters, digits, dashes and underscores; anything else is dropped. */
export const parseBuckets = (value: string): string[] =>
  [...new Set(value.split(/[,;\s]+/).map((b) => b.trim()).filter((b) => /^[a-z0-9][a-z0-9_-]{2,99}$/.test(b)))];
const parse = (value: string): string[] => { try { const v = JSON.parse(value); return Array.isArray(v) ? parseBuckets(v.join(",")) : []; } catch { return []; } };

const setting = envSetting<string[]>("net-o11y.log-buckets", [], parse);

export const setLogBuckets = (next: string[]) => setting.save(parseBuckets(next.join(",")));
/** offer the tenant a list it refused, again */
export const retryLogBuckets = () => setting.retry();

/* the array identity has to be stable or every render re-plans the queries that carry it */
let snapshot: string[] = [], snapshotKey = "";
const stable = (v: string[]) => {
  const k = v.join(",");
  if (k !== snapshotKey) { snapshotKey = k; snapshot = v; }
  return snapshot;
};

export function useLogBuckets(): string[] {
  return stable(useSyncExternalStore(setting.subscribe, setting.snapshot).value);
}

/**
 * An unread setting releases nothing.
 *
 * This asked only whether the read had finished, and a read that *failed* finishes too: two failed
 * attempts leave the fallback empty list, and the empty list means "read every bucket". So the one
 * case the gate exists for — the app not knowing what the tenant restricted — was the case that
 * opened it, and a tenant with a bucket list in place would scan every log it has because the state
 * service blinked or the reader lacks permission on it.
 *
 * Held, then, until the setting is actually known: a value, or a 404 that says nobody ever set one.
 * Nothing is held for ever against the reader's will — Settings offers the read again, and offers to
 * read every bucket anyway, which is the only way this app scans everything without being told to.
 */
let allowedAnyway = false;
const anywayListeners = new Set<() => void>();
export function allowUnrestrictedLogs() {
  allowedAnyway = true;
  anywayListeners.forEach((l) => l());
}
/** ask the tenant again for a bucket list it could not give */
export const retryLogBucketRead = () => setting.retryRead();

export interface LogBucketGate {
  /** the log queries may run: the tenant's list is known, or the reader said to read everything */
  released: boolean;
  /** they are not running and will not start on their own: the setting could not be read */
  held: boolean;
}

export function useLogBucketGate(): LogBucketGate {
  const key = useSyncExternalStore(
    (l) => { anywayListeners.add(l); const off = setting.subscribe(l); return () => { anywayListeners.delete(l); off(); }; },
    () => `${setting.snapshot().resolved}|${setting.snapshot().unreadable}|${allowedAnyway}`,
  );
  const [resolved, unreadable, anyway] = key.split("|").map((v) => v === "true");
  return { released: resolved && (!unreadable || anyway), held: resolved && unreadable && !anyway };
}

/** the list and what the tenant has done with it, for the screen that lets it be changed */
export function useLogBucketState(): SettingState<string[]> {
  return useSyncExternalStore(setting.subscribe, setting.snapshot);
}

/** A log query restricted to the named buckets; unchanged when none are set. */
export const inBuckets = (query: string, names: string[]) =>
  names.length ? query.replace(/^fetch logs,/, `fetch logs, bucket:{${names.map((b) => `"${b}"`).join(", ")}},`) : query;
