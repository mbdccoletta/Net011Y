// Where the network's own logs live. Grail bills a log query by what it scans, and a filter on log.source
// still reads that column across every log of the window: in a busy environment one hour is ~15 GB. When
// OpenPipeline routes syslog, traps, NetFlow, firewall and autodiscovery records to buckets of their own,
// naming them here makes every log query read only those. Stored in the tenant as app state, like the
// drop threshold, so the whole team shares it.
import { useSyncExternalStore } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";
import { getEnvironmentId } from "@dynatrace-sdk/app-environment";

const KEY = "net-o11y.log-buckets";
const LOCAL_KEY = (() => { try { return `${KEY}@${getEnvironmentId()}`; } catch { return KEY; } })();
const listeners = new Set<() => void>();

let buckets: string[] = [];
let loaded = false;

const notify = () => listeners.forEach((l) => l());
/** Bucket names are lower case letters, digits, dashes and underscores; anything else is dropped. */
export const parseBuckets = (value: string): string[] =>
  [...new Set(value.split(/[,;\s]+/).map((b) => b.trim()).filter((b) => /^[a-z0-9][a-z0-9_-]{2,99}$/.test(b)))];
const parse = (value: string): string[] => { try { const v = JSON.parse(value); return Array.isArray(v) ? parseBuckets(v.join(",")) : []; } catch { return []; } };

function load() {
  if (loaded) return;
  loaded = true;
  try { const v = window.localStorage.getItem(LOCAL_KEY); if (v) buckets = parse(v); } catch { /* storage unavailable */ }
  stateClient.getAppState({ key: KEY })
    .then((s) => { buckets = parse(s.value); try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(buckets)); } catch { /* ignore */ } notify(); })
    .catch(() => { /* not set, or no permission: every bucket is read */ });
}

export async function setLogBuckets(next: string[]) {
  buckets = parseBuckets(next.join(","));
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(buckets)); } catch { /* ignore */ }
  notify();
  try { await stateClient.setAppState({ key: KEY, body: { value: JSON.stringify(buckets) } }); } catch { /* stays local */ }
}

let snapshot = buckets, snapshotKey = "";
export function useLogBuckets(): string[] {
  load();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => {
    const k = buckets.join(",");
    if (k !== snapshotKey) { snapshotKey = k; snapshot = buckets; }
    return snapshot;
  });
}

/** A log query restricted to the named buckets; unchanged when none are set. */
export const inBuckets = (query: string, names: string[]) =>
  names.length ? query.replace(/^fetch logs,/, `fetch logs, bucket:{${names.map((b) => `"${b}"`).join(", ")}},`) : query;
