// Rebuilds the two bundles the checks run against, straight from the app's own source.
// Run this before validate.mjs or gru_regression.mjs: a stale bundle is how a suite starts lying
// (out/queries.mjs was three hours behind the app and the live check reported no causes at all).
import { execFileSync } from "node:child_process";

const esbuild = new URL("../../app/node_modules/.bin/esbuild", import.meta.url).pathname;
const build = (entry, out) =>
  execFileSync(esbuild, [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${out}`, "--log-level=warning"], { stdio: "inherit" });

build(new URL("validate_entry.ts", import.meta.url).pathname, "out/app-model.mjs");
build(new URL("../../app/ui/app/data/queries.ts", import.meta.url).pathname, "out/queries.mjs");
console.log("rebuilt out/app-model.mjs and out/queries.mjs from app/ui/app");
