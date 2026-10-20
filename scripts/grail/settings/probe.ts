// The two settings that live in the environment, driven against a tenant that answers, a tenant that
// has never been written to, a tenant that fails, and a tenant that refuses a write.
//
// These are the states the app could not tell apart until now, and none of them can be reached from the
// fixtures the rest of the suite runs on: a setting is a round trip, and what matters is what the app
// believes while the round trip is in flight. Run with `node settings_check.mjs`.
import { envSetting } from "../../../app/ui/app/hooks/envSetting";
import { calls, setBehaviour, setSaveFails } from "./stub_state";

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: string[] = [];
const ok = (name: string, cond: boolean, detail: string) => out.push(`${cond ? "PASS" : "FAIL"} ${name} — ${detail}`);

async function run() {
  // 1. nothing may read as resolved before the tenant answers
  const a = envSetting<number>("k", 7, (raw) => Number(JSON.parse(raw)));
  const before = a.peek();
  ok("unresolved before the answer", before.resolved === false && before.value === 7, `resolved=${before.resolved} value=${before.value}`);
  await tick(); await tick();
  const after = a.peek();
  ok("resolved with the stored value", after.resolved === true && after.value === 42 && !after.unreadable, `resolved=${after.resolved} value=${after.value}`);

  // 2. a setting never written is an answer, and means the default
  setBehaviour("notFound");
  const b = envSetting<number>("k2", 7, (raw) => Number(JSON.parse(raw)));
  b.peek(); await tick(); await tick();
  const nf = b.peek();
  ok("never written resolves to the default", nf.resolved === true && nf.unreadable === false && nf.value === 7, `resolved=${nf.resolved} unreadable=${nf.unreadable}`);

  // 3. a request that fails is retried once, and only then given up on — as unreadable, not as unset
  setBehaviour("brokenOnce");
  calls.get = 0;
  const c = envSetting<number>("k3", 7, (raw) => Number(JSON.parse(raw)));
  c.peek(); await tick(); await tick();
  ok("a lost request is not an answer", c.peek().resolved === false, `resolved=${c.peek().resolved} after the first failure`);
  await wait(1500);
  const retried = c.peek();
  ok("the retry settles it", retried.resolved === true && retried.unreadable === false && retried.value === 42, `gets=${calls.get} value=${retried.value}`);

  setBehaviour("broken");
  const d = envSetting<number>("k4", 7, (raw) => Number(JSON.parse(raw)));
  d.peek(); await wait(1600);
  const dead = d.peek();
  ok("two failures read as unreadable, not as unset", dead.resolved === true && dead.unreadable === true && dead.value === 7, `resolved=${dead.resolved} unreadable=${dead.unreadable}`);

  // 4. a save the tenant refuses is reported, and can be offered again
  setBehaviour("ok"); setSaveFails(true);
  const e = envSetting<number>("k5", 7, (raw) => Number(JSON.parse(raw)));
  e.peek(); await tick(); await tick();
  await e.save(60);
  const failedSave = e.peek();
  ok("a refused save is named", failedSave.unsaved === 60 && failedSave.value === 60, `unsaved=${failedSave.unsaved} onScreen=${failedSave.value}`);
  setSaveFails(false);
  await e.retry();
  const retriedSave = e.peek();
  ok("saving again clears it", retriedSave.unsaved === null && retriedSave.value === 60, `unsaved=${retriedSave.unsaved}`);

  // 5. a read that lands after a save must not undo it
  setBehaviour("ok");
  const f = envSetting<number>("k6", 7, (raw) => Number(JSON.parse(raw)));
  f.peek();                // read in flight
  await f.save(99);        // set before it lands
  await tick(); await tick(); await wait(10);
  ok("a late read does not undo a save", f.peek().value === 99, `value=${f.peek().value}`);

  console.log(out.join("\n"));
  if (out.some((l) => l.startsWith("FAIL"))) process.exitCode = 1;
}
run();
