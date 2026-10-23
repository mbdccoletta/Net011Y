// The kept part of a log window, against a tenant that stores, a tenant that refuses, and a payload
// too large to send.
//
// What this is about: a log query is billed by the window it scans, and the part already read does
// not change. The app keeps it and asks Grail only for what came after — but where it keeps it is
// the whole question. In the browser it was one reader's copy of data the environment owns; in
// shared app state it would hand one reader's log records to another who may not be allowed to see
// them; in memory alone it is lost the moment the tab closes, which is the saving this exists for.
// User app state is the one place left, and none of its failure modes may cost correctness: a
// refusal, an expiry or an oversized payload all have to come out as "read the whole window", which
// is what the app did before any of this.
import { keep, loadKeptParts, planFor, type Incremental } from "../../../app/ui/app/data/logCache";
import { calls, setFailRead, setFailWrite, userStore } from "./stub_state";

const out: string[] = [];
const ok = (name: string, cond: boolean, detail: string) => out.push(`${cond ? "PASS" : "FAIL"} ${name} — ${detail}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

const WINDOW = 6 * 3600e3;
const inc: Incremental = { kind: "latest", windowMs: WINDOW, time: "t", keys: ["ip"] };
const full = "fetch logs, from:now()-6h | summarize last = max(timestamp), by:{ip}";
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ip: `10.0.0.${i}`, t: new Date().toISOString() }));

async function run() {
  // 1. nothing kept: the whole window is read
  await loadKeptParts(["deviceLogs"]);
  const first = planFor("deviceLogs", full, inc);
  ok("with nothing kept the full window is planned", first.query === full && first.base === null,
    `base=${first.base === null ? "none" : "rows"}`);

  // 2. what was read is kept, for this reader alone and with an expiry
  keep("deviceLogs", first, rows(20), WINDOW);
  await tick();
  const put = calls.userSet.at(-1);
  ok("the kept part goes to the reader's own state", !!put && put.key.includes("log-cache") && put.scope === "user",
    `${put?.scope} ${put?.key}`);
  const ttl = put ? Date.parse(put.validUntilTime ?? "") - Date.now() : 0;
  ok("it expires with the window it belongs to", ttl > WINDOW * 0.9 && ttl < WINDOW * 1.1,
    `${Math.round(ttl / 60000)} min`);

  // 3. the next open reads only what came after
  const second = planFor("deviceLogs", full, inc);
  ok("a kept part makes the next read incremental", second.query !== full && !!second.base && second.from != null,
    `from ${second.from ? new Date(second.from).toISOString().slice(11, 19) : "none"}`);

  // 4. the entry this cache exists for — six hours of syslog counts, measured at 118 KB on a real
  // environment — is stored, and only something far larger is left in memory
  const mid = calls.userSet.length;
  keep("deviceLogs24h", planFor("deviceLogs24h", full, inc), rows(1200), WINDOW);
  await tick();
  ok("an entry the size of a real syslog window is stored", calls.userSet.length === mid + 1,
    `${JSON.stringify(rows(1200)).length / 1024 | 0} KB sent`);

  const before = calls.userSet.length;
  keep("flowTs", planFor("flowTs", full, inc), rows(20000), WINDOW);
  await tick();
  ok("an oversized kept part is not sent to the tenant", calls.userSet.length === before,
    `${calls.userSet.length - before} writes`);
  ok("and it is still used within the session", planFor("flowTs", full, inc).base !== null, "in memory");

  // 5. a tenant that refuses the write costs nothing but the saving
  setFailWrite(true);
  keep("neighbors", planFor("neighbors", full, inc), rows(10), WINDOW);
  await tick();
  ok("a refused write does not throw", true, "no exception");
  setFailWrite(false);

  // 6. a tenant that cannot be read resolves anyway, and what it could not load is read in full
  setFailRead(true);
  userStore.clear();
  let threw = false;
  await loadKeptParts(["netChanges"]).catch(() => { threw = true; });
  const unread = planFor("netChanges", full, inc);
  ok("a tenant that cannot be read does not reject", !threw, "loadKeptParts resolved");
  ok("and what it could not load is read in full", unread.query === full && unread.base === null,
    `base=${unread.base === null ? "none" : "rows"}`);
  setFailRead(false);

  // 7. the kept part is never offered to another reader: it is written to the user scope only
  ok("nothing was written to shared app state", (calls.set as unknown[]).length === 0,
    `${(calls.set as unknown[]).length} shared writes`);

  console.log(out.join("\n"));
  if (out.some((l) => l.startsWith("FAIL"))) process.exitCode = 1;
}
run();
