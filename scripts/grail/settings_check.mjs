// Runs settings/probe.ts against a stubbed app-state client. Its own bundle, because the rest of the
// suite is synchronous over fixtures and this one is about what the app believes while a read is still
// on the wire. Prints one line per behaviour and exits non-zero if any of them fails.
import { execFileSync } from "node:child_process";

const here = new URL(".", import.meta.url).pathname;
const esbuild = new URL("../../app/node_modules/.bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [`${here}settings/probe.ts`, "--bundle", "--format=esm", "--platform=node",
  `--outfile=${here}out/settings-probe.mjs`, "--log-level=warning",
  `--alias:@dynatrace-sdk/client-state=${here}settings/stub_state.ts`], { stdio: "inherit" });
execFileSync(process.execPath, [`${here}out/settings-probe.mjs`], { stdio: "inherit" });

// the kept part of a log window: where it is stored, when it expires, and every way that can fail
execFileSync(esbuild, [`${here}settings/cache_probe.ts`, "--bundle", "--format=esm", "--platform=node",
  `--outfile=${here}out/cache-probe.mjs`, "--log-level=warning",
  `--alias:@dynatrace-sdk/client-state=${here}settings/stub_state.ts`], { stdio: "inherit" });
execFileSync(process.execPath, [`${here}out/cache-probe.mjs`], { stdio: "inherit" });
