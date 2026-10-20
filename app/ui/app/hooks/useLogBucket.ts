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
 * Whether the tenant has answered about the buckets.
 *
 * A log query asked before this is true reads every bucket in the environment, so the queries that
 * carry a bucket filter wait for it. The wait is one app-state read — measured at 165 ms on this
 * environment — against a scan of every log in the window.
 */
export function useLogBucketsResolved(): boolean {
  return useSyncExternalStore(setting.subscribe, setting.snapshot).resolved;
}

/** the list and what the tenant has done with it, for the screen that lets it be changed */
export function useLogBucketState(): SettingState<string[]> {
  return useSyncExternalStore(setting.subscribe, setting.snapshot);
}

/** A log query restricted to the named buckets; unchanged when none are set. */
export const inBuckets = (query: string, names: string[]) =>
  names.length ? query.replace(/^fetch logs,/, `fetch logs, bucket:{${names.map((b) => `"${b}"`).join(", ")}},`) : query;
