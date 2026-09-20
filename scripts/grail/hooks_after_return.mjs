// A hook called after a conditional return blows the component up at runtime ("Rendered more hooks than
// during the previous render"), and it has happened three times in this app: the page renders, the early
// return fires on some other environment, and every hook after it shifts. TypeScript does not see it and
// the project has no ESLint, so this reads the source and says where it is.
//   node hooks_after_return.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../app/ui/app/", import.meta.url).pathname;
const HOOK = /\b(useState|useMemo|useEffect|useCallback|useRef|useSyncExternalStore|useElementWidth|useDql|use[A-Z]\w*)\s*\(/;

/** every .tsx under the app, components and pages alike */
function files(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

export function hooksAfterReturn() {
  const bad = [];
  for (const file of files()) {
    const src = readFileSync(file, "utf8");
    // each top-level function: from its signature to the closing brace in column 0
    for (const m of src.matchAll(/^(?:export )?function (\w+)\(/gm)) {
      const start = m.index;
      const endRel = src.slice(start).search(/\n}\s*$/m);
      const body = src.slice(start, endRel > 0 ? start + endRel : undefined);
      // a return that is not the component's last one: inside an if, or guarded on one line
      const early = body.search(/\n {2}(?:if \([^\n]*\)[\s\S]{0,400}?\n {4}return|return [^\n]*;\n {2}\})/);
      if (early < 0) continue;
      const after = body.slice(early + 1);
      // the component's own return, at the end, closes the search: what matters is a hook before it
      const lastReturn = after.lastIndexOf("\n  return");
      const between = lastReturn > 0 ? after.slice(0, lastReturn) : after;
      const hook = between.match(HOOK);
      if (!hook) continue;
      const line = src.slice(0, start + early + 1 + between.indexOf(hook[0])).split("\n").length;
      bad.push({ file: file.replace(ROOT, ""), fn: m[1], hook: hook[1], line });
    }
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bad = hooksAfterReturn();
  bad.forEach((b) => console.error(`${b.file}:${b.line} ${b.fn} calls ${b.hook} after an early return`));
  console.log(bad.length ? `${bad.length} hook(s) after an early return` : "no hook after an early return");
  process.exit(bad.length ? 1 : 0);
}
