// Would this estate get a map? Answer it before deploying anything to it.
//
// Reads site names, one per line, and reports how many the app would place from the name alone —
// no tags, no coordinates. The estate's countries are learned the way the app learns them: a
// country word in a name anchors the region codes in every other name, so a file of
// "…, <city>, NC, <zip>" lines places nothing while one of them saying USA places all of them.
//
//   node scripts/grail/place_dryrun.mjs sites.txt
//
// The file stays where you put it. Do not copy a customer's site names into this repository.
import { readFileSync } from "node:fs";
import { addressParts, countryOf, regionOf, ensurePlaces } from "./out/app-model.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node place_dryrun.mjs <file with one site name per line>"); process.exit(2); }
await ensurePlaces();

const names = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
const parts = new Map(names.map((n) => [n, addressParts(n)]));
const anchors = new Set();
for (const ps of parts.values()) for (const p of ps) { const cc = countryOf(p); if (cc) anchors.add(cc); }

let placed = 0;
const unplaced = [];
const regions = new Map();
for (const [name, ps] of parts) {
  const own = ps.map(countryOf).filter(Boolean);
  const scope = own.length ? own : [...anchors];
  const hit = scope.length ? ps.map((p) => regionOf(p, scope)).find(Boolean) : null;
  if (hit) { placed += 1; regions.set(`${hit.cc}/${hit.region}`, (regions.get(`${hit.cc}/${hit.region}`) ?? 0) + 1); }
  else unplaced.push(name);
}

console.log(`${names.length} site names · countries found: ${[...anchors].join(", ") || "none"}`);
console.log(`${placed} would be placed (${Math.round((100 * placed) / names.length)}%), in ${regions.size} regions`);
console.log([...regions].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, n]) => `  ${r}: ${n}`).join("\n"));
if (unplaced.length) {
  console.log(`\n${unplaced.length} would not be placed. The first few, and why:`);
  for (const n of unplaced.slice(0, 8)) {
    const ps = parts.get(n);
    console.log(`  ${n}\n    parts: ${ps.join(" | ")} · country in it: ${ps.map(countryOf).filter(Boolean).join(",") || "none"}`);
  }
}
