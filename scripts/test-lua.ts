// Runs tLib's Lua suites: bun run test:lua
//
// These are the menu engine's own oracles. They drive client/lib/menu/*.lua directly
// against stub hosts and know nothing about any consumer, which is the point --
// tLib is the engine, so the suites that say what the engine does belong here
// rather than in whichever resource happens to be the first to use it. The
// consuming resources keep their own suites for their own content.
//
// Discovered off disk rather than listed by hand. A hardcoded list is the one way
// a runner fails silently: it keeps passing while the suite nobody added to it is
// the suite that would have caught the regression.
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const suites = (
  await Array.fromAsync(new Bun.Glob("**/*.lua").scan({ cwd: resolve(root, "tests/lua") }))
).sort();
if (suites.length === 0)
  throw new Error("tests/lua contains no suites; this run would pass vacuously");

for (const suite of suites) {
  // `--package fengari-node-cli`, the same invocation tests/lua/versioncheck.lua
  // documents at its head: the `fengari` package itself ships no executable, and the
  // CLI that does is not a dependency of this resource. Fetched into bunx's own cache
  // rather than installed, so running the suites does not touch package.json or the
  // lockfile of a resource that ships to servers.
  const result = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--package",
      "fengari-node-cli",
      "fengari",
      "scripts/run-lua-suite.lua",
      `tests/lua/${suite}`,
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}

console.log(`PASS: ${suites.length} tLib Lua suites`);
