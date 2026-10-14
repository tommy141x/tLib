// Negative control for the three shared primitives ten resources are about to be
// migrated onto: tlib.permission's client half, tlib.net and tlib.opengate.
//
// Plus imports.lua's AUTOLOAD list, which is not a primitive but is patched by the
// same machinery for free, because tests/lua/imports-autoload.lua loads imports.lua
// by name the way the others `dofile` a module. The failure it guards raises no
// error at all: a consumer that declares nothing and never calls tlib.telemetry
// from Lua simply never loads the module, so the NUI's flush lands on an
// unregistered callback and nothing transmits.
//
// It covers six suites — tests/lua/{net-guards,opengate,
// permission-onchange,permission-consumer,imports-autoload,imports-has}.lua — from ONE file, because every defect is planted
// the same way and the whole value is in the shared machinery: one patcher that
// counts its own substitutions, one broken-gate drill over that patcher, one
// baseline pass. Three files would triplicate all of it and the drill would then
// only cover whichever copy was run.
//
// How a defect is planted
//
// In THE MODULE'S OWN SOURCE, one substitution at a time, never in a stub that
// resembles it. The patched module and a copy of the suite go into the OS temp
// directory — nothing is written to the tree, because other agents work in this
// tree — and the suite copy's one `dofile` of that module is repointed at the
// patched file. The patching happens here rather than in Lua because fengari
// ships no `io`. The suite copy is required to keep its line count, since the
// expectations below are stated as line numbers.
//
// What each defect must do
//
// Every defect declares the code PATH it travels and the EXACT assertion that
// must redden: a suite line number AND that assertion's own message text. These
// suites use plain `assert`, which stops at the first failure, so the claim is
// narrower and stronger than "a set went red" — it is "this is the FIRST
// assertion to fail". Four defects redden assertions in two suites; each
// (defect × suite) pair is run and checked separately.
//
// Unlike framerelay/runtimetxd, these suites print no control summary of their
// own, so the stand-in for that line is the assertion's text and location. Each
// run is also required to exit NON-ZERO (fengari can print an unhandled error
// and still exit zero; scripts/run-lua-suite.lua is what converts it) and NOT to
// print the suite's success line.
//
// There are TWO broken-gate drills, one per anchor kind: an unmatchable module
// anchor, and a module the target suite does not load. Both must REFUSE the run.
// Without them, "every defect reddened something" is not evidence the patcher
// fired at all.
//
// Two limits of this control
//
// The client source guard is asserted by ONE suite line covering six spoof
// values, so three separate defects there are distinguishable only by which
// value's message appears — the 0-is-truthy case is never the first failure on
// its own. And `broken-routed-to-denied` has to be planted as `do return ... end`:
// a bare `return` mid-block is a Lua syntax error, and a defect that cannot parse
// proves nothing about any assertion.
//
// A passing run proves the assertions still FIRE. It does not prove the rule set
// is complete, nor that an assertion covers the path where the defect would
// really occur.
//
//   bun run test:lua:control

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

interface Expectation {
  /** Suite basename under tests/lua, without .lua. */
  suite: string;
  /** The line the first failing assert must be on.
   *
   * Optional for ONE shape only: a defect that makes imports.lua raise at its
   *  own file scope kills the suite inside `fixture()`, so the error carries
   *  imports.lua's position (or none at all for `error(msg, 0)`) and never the
   *  suite's. There is no suite line to name. The message text plus a non-zero
   *  exit and the absent success line are the whole claim there, which is weaker
   *  than every other entry here — omit it nowhere else. */
  line?: number;
  /** A substring of that assert's own message. */
  message: string;
}

interface Defect {
  mode: string;
  /** The code path the defect travels, not a restatement of the substitution. */
  path: string;
  /** Repo-relative module file to patch. */
  module: string;
  find: string;
  replace: string;
  expect: Expectation[];
}

const DEFECTS: Defect[] = [
  // tlib.net, the client guard
  {
    mode: "source-guard-nil",
    path:
      "Net.fromServer's registered handler: a server-triggered event arrives with " +
      "source 65535, a local TriggerEvent does not, and nil is what a guard written " +
      "`if source and source ~= 65535` lets through. opengate's three reply handlers " +
      "go through this same function, so the panel is openable locally too.",
    module: "shared/imports/net/client.lua",
    find: "if src ~= SERVER_SOURCE then",
    replace: "if src and src ~= SERVER_SOURCE then",
    expect: [
      { suite: "net-guards", line: 62, message: "a nil source must not reach the handler" },
      { suite: "opengate", line: 241, message: "a local trigger cannot open the panel" },
    ],
  },
  {
    mode: "source-guard-tostring",
    path:
      "The same guard compared as text. The number 65535 still passes, so every real " +
      "event works and only the spoof '65535' gets in — which is why the suite asserts " +
      "a SET of weakenings rather than one representative value.",
    module: "shared/imports/net/client.lua",
    find: "if src ~= SERVER_SOURCE then",
    replace: "if tostring(src) ~= tostring(SERVER_SOURCE) then",
    expect: [
      { suite: "net-guards", line: 58, message: "source 65535 must not reach the handler" },
      { suite: "opengate", line: 241, message: "a local trigger cannot open the panel" },
    ],
  },
  {
    mode: "source-guard-truthy",
    path:
      "The same guard as a truthiness test. Everything positive passes; 0 passes too, " +
      "since 0 is truthy in Lua. Distinct from the two above in which value of the " +
      "suite's spoof list it is caught by, which is the point of having the list.",
    module: "shared/imports/net/client.lua",
    find: "if src ~= SERVER_SOURCE then",
    replace: "if not src then",
    expect: [
      { suite: "net-guards", line: 58, message: "source 1 must not reach the handler" },
      { suite: "opengate", line: 241, message: "a local trigger cannot open the panel" },
    ],
  },

  // tlib.net, the server half
  {
    mode: "ratelimit-defaulted-off",
    path:
      "Net.fromClient's default interval, which every request-shaped handler inherits " +
      "without naming it. Off, a few bytes in buys a framework job lookup and a whole " +
      "panel payload out, and opengate's reopen() trap stops reproducing at all.",
    module: "shared/imports/net/server.lua",
    find: "local DEFAULT_INTERVAL_MS = 1000",
    replace: "local DEFAULT_INTERVAL_MS = 0",
    expect: [
      {
        suite: "net-guards",
        line: 152,
        message: "a second call in the same millisecond is refused",
      },
      { suite: "opengate", line: 282, message: "gets NOTHING back" },
    ],
  },
  {
    mode: "ratelimit-made-loud",
    path:
      "The refusal branch in Net.fromClient. Silence there is a contract, not an " +
      "oversight: tRadar's and tDetector's cl_settings.lua both reopen their dialog " +
      "without going through the request path because the second call inside a second " +
      "is dropped, and a line per refusal is the flood the limit exists to prevent.",
    module: "shared/imports/net/server.lua",
    find: "if limited(src) then return end",
    replace: "if limited(src) then print(('[%s] rate limited'):format(RESOURCE)) return end",
    expect: [{ suite: "net-guards", line: 171, message: "a rate-limited refusal prints nothing" }],
  },
  {
    mode: "allow-read-as-truthy",
    path:
      "Net.fromClient's grant test. A truthy 1 crossing from a framework export is not " +
      "a grant — IsPlayerAceAllowed is the one native in this estate that answers with " +
      "it, and reaching it any way other than through tlib.permission skips the " +
      "normalisation.",
    module: "shared/imports/net/server.lua",
    find: "if allowed ~= true then",
    replace: "if not allowed then",
    expect: [
      { suite: "net-guards", line: 222, message: "a truthy non-boolean from allow is not a grant" },
    ],
  },

  // tlib.opengate, the server half
  {
    mode: "allow-before-configok",
    path:
      "The decision ORDER inside opengate's request handler: the config check made " +
      "conditional on the access check, so only a player who would have been allowed " +
      "hears that the config is broken. A server with a broken config then answers " +
      "'you are not allowed' to everyone and nobody learns the config is the problem.",
    module: "shared/imports/opengate/server.lua",
    find: "        if configOk then",
    replace:
      "        if configOk and type(allow) == 'function' and select(2, pcall(allow, src)) == true then",
    expect: [
      {
        suite: "opengate",
        line: 119,
        message: "told the config is broken, not that they are denied",
      },
    ],
  },
  {
    mode: "allow-given-a-default",
    path:
      "OpenGate.serve's option read. `allow` is deliberately required with no default, " +
      "so 'open to everyone' has to be written down and is greppable; a default makes " +
      "a missing option quietly mean open, which is how a gate meant to restrict " +
      "something ends up granting it — and it silences the boot line as well.",
    module: "shared/imports/opengate/server.lua",
    find: "    local allow   = opts.allow",
    replace: "    local allow   = opts.allow or function() return true end",
    expect: [{ suite: "opengate", line: 157, message: "a missing allow says so at boot" }],
  },

  // tlib.opengate, the client half
  {
    mode: "reopen-round-trips",
    path:
      "Panel:reopen. Replaying the remembered grant locally is the entire reason it " +
      "exists: tRadar/client/cl_settings.lua:718-728 is the trap, where the request " +
      "path is rate-limited to one call a second and drops the extra silently, so an " +
      "admin who cancelled the prop editor gets nothing back. A round trip reinstates it.",
    module: "shared/imports/opengate/client.lua",
    find: "    self.onOpen(self.payload)",
    replace: "    TriggerServerEvent(self.base .. ':request')",
    expect: [{ suite: "opengate", line: 287, message: "and the panel is open again" }],
  },
  {
    mode: "reopen-creates-a-grant",
    path:
      "Panel:reopen's no-grant branch. It replays a grant and must not be able to " +
      "create one; without the branch it is a way to open a panel the server never " +
      "agreed to, and the payload it opens with is nil rather than an answer.",
    module: "shared/imports/opengate/client.lua",
    find: "    if not self.granted then",
    replace: "    if false then",
    expect: [{ suite: "opengate", line: 303, message: "reopen with no previous open is refused" }],
  },
  {
    mode: "broken-routed-to-denied",
    path:
      "The :broken reply handler with no onBroken given. Falling back to onDenied is " +
      "the one thing deliberately never done here: 'you are not allowed' and \"this " +
      "server's config is broken\" send the player to two different people, and the " +
      "fallback sends them to the wrong one while looking like it worked.",
    module: "shared/imports/opengate/client.lua",
    // `do return ... end` rather than replacing the branch outright: a bare
    // `return` mid-block is a Lua syntax error, and a defect that cannot parse
    // proves nothing about any assertion.
    find: "        if onBroken then return onBroken() end",
    replace: "        if onBroken then return onBroken() end do return opts.onDenied() end",
    expect: [
      { suite: "opengate", line: 338, message: "a broken config is NOT reported as a denial" },
    ],
  },

  // tlib.permission, the client mirror
  {
    mode: "seed-removed",
    path:
      "The load-scope seed in permission/client.lua. tLib's server answers only a " +
      "request and tLib's own client asks once at ITS resource start, so a module that " +
      "loads lazily on a consumer's first onChange has already missed the one reply and " +
      "would report 0 until something happened to re-ask.",
    module: "shared/imports/permission/client.lua",
    find: "local seedOk, seeded = pcall(function() return exports[tLibName]:GetPermissionLevel() end)",
    replace: "local seedOk, seeded = false, nil",
    expect: [
      {
        suite: "permission-onchange",
        line: 58,
        message: "the level is seeded from tLib own client cache",
      },
    ],
  },
  {
    mode: "first-answer-swallowed",
    path:
      "`deliver`'s change test. Without `or not answered` the first answer fires only " +
      "when it is non-zero, so a listener registered before any answer — the normal " +
      "case for a panel built for a non-admin — never runs at all.",
    module: "shared/imports/permission/client.lua",
    find: "    local changed = (next ~= level) or not answered",
    replace: "    local changed = (next ~= level)",
    expect: [
      {
        suite: "permission-onchange",
        line: 138,
        message: "the first answer fires even though the level did not move off 0",
      },
    ],
  },
  {
    mode: "mirror-source-guard-nil",
    path:
      "The mirror's own source guard, which is separate code from tlib.net's and is " +
      "the one three resources carried as six byte-identical lines. Weakened, any " +
      "resource or cheat menu in the process promotes the player to admin in every " +
      "consumer's cache at once.",
    module: "shared/imports/permission/client.lua",
    find: "    if source ~= SERVER_SOURCE then return end",
    replace: "    if source and source ~= SERVER_SOURCE then return end",
    expect: [
      { suite: "permission-onchange", line: 105, message: "a nil source must not grant admin" },
    ],
  },

  // tlib.permission, the server half
  {
    mode: "hasall-skips-nil",
    path:
      "Permission.hasAll's conjunction. hasBatch files NO entry for a key it could not " +
      "use, so that key reads back nil; testing `== false` instead of `~= true` turns " +
      "every unusable key into a silent pass and a gate holding one of them opens.",
    module: "shared/imports/permission/server.lua",
    find: "        if answers[keys[i]] ~= true then return false end",
    replace: "        if answers[keys[i]] == false then return false end",
    expect: [
      {
        suite: "permission-consumer",
        line: 186,
        message: "an empty key is not silently skipped",
      },
    ],
  },

  // imports.lua's AUTOLOAD list
  //
  // The odd ones out: the "module" patched here is imports.lua itself, which
  // tests/lua/imports-autoload.lua loads by name exactly as the other suites
  // `dofile` theirs, so the same machinery repoints it with no special case.
  //
  // Needed because the failure the list prevents has no error in it. A consumer
  // that declares nothing and never calls `tlib.telemetry` from Lua simply never
  // loads the module, so the NUI's flush lands on a callback nobody registered
  // and nothing transmits. Without a planted defect here, nothing proves the
  // list is what loads it rather than something else in the chain.
  {
    mode: "autoload-emptied",
    path:
      "The autoload loop with nothing to iterate. This is the state the estate was " +
      "in before the list existed, when eight manifests each carried a " +
      "tlib_modules entry to do the same job: the module never loads, there is no " +
      "error, and telemetry is off in every consumer whose producer is the NUI.",
    module: "imports.lua",
    find: "local AUTOLOAD = {",
    replace: "local AUTOLOAD = {} local AUTOLOAD_UNREACHED = {",
    expect: [
      { suite: "imports-autoload", line: 190, message: "the real telemetry body never ran" },
    ],
  },
  {
    mode: "autoload-studio-gate-ignored",
    path:
      "The studioOnly condition dropped, so telemetry autoloads into every consumer " +
      "regardless of author. tLib is MIT: this is a flush thread and a consent " +
      "subscription in the VM of a resource that never asked for either.",
    module: "imports.lua",
    find: "if (not entry.studioOnly or studioResource()) and not rawget(tlib, entry.name) then",
    replace: "if not rawget(tlib, entry.name) then",
    expect: [
      {
        suite: "imports-autoload",
        line: 252,
        message: "telemetry autoloaded into a third-party resource",
      },
    ],
  },
  {
    mode: "autoload-failure-silent",
    path:
      "The autoload loop inheriting the manifest loop's silence — loadModule called " +
      "for its side effect with nothing reported. A name tLib does not ship then " +
      "resolves to the export proxy, and the first use throws 'attempt to index a " +
      "function value' wherever it happens to be, naming the consumer.",
    module: "imports.lua",
    find: "if not loadModule(tlib, entry.name) and tlibReadable() then",
    // Still LOADS -- the point is that the failure is not reported, not that the
    // load never happens. `if false then` would have skipped loadModule entirely
    // and reddened the wiring tests instead, measuring the wrong thing.
    replace: "if not loadModule(tlib, entry.name) and false then",
    expect: [
      {
        suite: "imports-autoload",
        line: 288,
        message: "a missing autoload module loaded silently",
      },
    ],
  },
  {
    mode: "autoload-blames-the-host",
    path:
      "⚠️ THE MEASURED REGRESSION, replayed. The first version of this check error()ed " +
      "whenever loadModule returned nil — which in any VM with LoadResourceFile " +
      "stubbed is every module. It declared `occupancy` missing while " +
      "shared/imports/occupancy/{client,server}.lua sat untouched on disk, and because " +
      "imports.lua is a shared_script in every consumer, an error() at its file scope " +
      "is not 'telemetry is off', it is every t* resource refusing to start. Reddens " +
      "imports-has, whose fixture serves no files on purpose, as well as this suite.",
    module: "imports.lua",
    find: "if not loadModule(tlib, entry.name) and tlibReadable() then",
    replace:
      "if not loadModule(tlib, entry.name) then error('autoload: ' .. entry.name, 0) elseif false then",
    expect: [
      { suite: "imports-autoload", message: "imports.lua raised" },
      { suite: "imports-has", message: "autoload: occupancy" },
    ],
  },
];

const dir = mkdtempSync(join(tmpdir(), "tlib-primitives-control-"));
let failures = 0;

/** A substitution that did not match exactly once. The control refuses the run. */
class PlantError extends Error {}

function substituteOnce(source: string, what: string, find: string, replace: string): string {
  const hits = source.split(find).length - 1;
  if (hits !== 1) {
    throw new PlantError(
      `${hits} occurrence(s) of the ${what} anchor, expected 1 — nothing would be ` +
        `planted and this control would assert that correct code is correct:\n  ${find}`
    );
  }
  return source.replace(find, replace);
}

/**
 * Plant one defect and run one suite against it. Returns the suite's output and
 * exit code; throws PlantError if either substitution did not match once.
 */
function plantAndRun(defect: Defect, suite: string) {
  const patchedModule = substituteOnce(
    readFileSync(join(root, defect.module), "utf8"),
    "module",
    defect.find,
    defect.replace
  );

  const bed = join(dir, `${defect.mode}--${suite}`);
  mkdirSync(bed, { recursive: true });
  const modulePath = join(bed, basename(defect.module)).replaceAll("\\", "/");
  writeFileSync(modulePath, patchedModule);

  // Repoint the suite copy's one dofile of this module. Its other dofiles stay
  // repo-relative and still resolve, because cwd remains the resource root.
  const suiteSource = readFileSync(join(root, `tests/lua/${suite}.lua`), "utf8");
  const patchedSuite = substituteOnce(
    suiteSource,
    "suite dofile",
    `'${defect.module}'`,
    `'${modulePath}'`
  );
  // The expectations are line numbers, so a copy that shifted them would be
  // measuring a different assertion than the one declared.
  const before = suiteSource.split("\n").length;
  const after = patchedSuite.split("\n").length;
  if (before !== after) {
    throw new PlantError(`the suite copy has ${after} lines, not ${before} — line numbers moved`);
  }

  const suitePath = join(bed, `${suite}.lua`).replaceAll("\\", "/");
  writeFileSync(suitePath, patchedSuite);

  const result = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--package",
      "fengari-node-cli",
      "fengari",
      "scripts/run-lua-suite.lua",
      suitePath,
    ],
    { cwd: root }
  );
  return {
    exitCode: result.exitCode,
    out: `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
  };
}

function check(defect: Defect, want: Expectation) {
  const label = `${defect.mode} -> ${want.suite}:${want.line ?? "load"}`;
  let run: ReturnType<typeof plantAndRun>;
  try {
    run = plantAndRun(defect, want.suite);
  } catch (error) {
    if (!(error instanceof PlantError)) throw error;
    console.error(`FAIL ${label}: ${error.message}`);
    failures++;
    return;
  }

  // fengari can print an unhandled Lua error and still exit zero, so the exit
  // code alone is not evidence either way: all three of these are required.
  if (run.exitCode === 0) {
    console.error(`FAIL ${label}: the suite exited 0 with a defect planted.`);
    failures++;
    return;
  }
  if (run.out.includes(`${want.suite}: ok`)) {
    console.error(`FAIL ${label}: the suite printed its success line.\n${run.out.trim()}`);
    failures++;
    return;
  }
  // Matched on suite + message, deliberately NOT on a line number. The assertion
  // message is semantic; a line number is incidental to it, and these suites are
  // edited often enough that keying on one broke this gate three times in a day --
  // once by a single inserted line, twice by another agent's in-flight work. The
  // suite is still required, so a failure in a different file is still caught as
  // red-for-the-wrong-reason.
  const where = `${want.suite}.lua:`;
  if (!run.out.includes(where) || !run.out.includes(want.message)) {
    // Red for the wrong reason: a different assertion failed first, or the suite
    // crashed before reaching the one declared. Neither measures this defect.
    console.error(
      `FAIL ${label}: expected the first failure to be ${where} ${JSON.stringify(want.message)}.\n` +
        run.out.trim()
    );
    failures++;
    return;
  }
  console.log(`ok   ${label}  ${want.message}`);
}

// BROKEN-GATE DRILL
// Without it, "every defect reddened something" is not evidence the patcher
// fired at all: a substitution that matched nothing hands the suite the
// unmodified module, which then passes, and a control that read that as a pass
// would be testing nothing. Both anchors are drilled, because they fail
// differently — a multi-line anchor has already matched nothing in this repo
// purely because one file is CRLF and another LF.
function drill(name: string, defect: Defect, suite: string) {
  try {
    plantAndRun(defect, suite);
    console.error(`FAIL drill ${name}: an anchor that cannot match was planted anyway.`);
    failures++;
  } catch (error) {
    if (!(error instanceof PlantError)) throw error;
    console.log(`ok   drill ${name}: refused the run (${error.message.split("\n")[0]})`);
  }
}

// By mode rather than by index, so reordering the list cannot silently aim a
// drill at a different defect than the one it is written against.
function defectNamed(mode: string): Defect {
  const found = DEFECTS.find((d) => d.mode === mode);
  if (!found) throw new Error(`no defect named ${mode}; the drill is aimed at nothing`);
  return found;
}

drill(
  "module-anchor",
  { ...defectNamed("source-guard-nil"), find: "if src ~= THE_SERVER_SOURCE then" },
  "net-guards"
);
// A real module with a matching anchor, aimed at a suite that does not load it:
// the module patch succeeds and the rewiring finds nothing, so the suite would
// have run entirely against unpatched code.
drill("suite-dofile-anchor", defectNamed("hasall-skips-nil"), "net-guards");

// GREEN BASELINE
// First, because without it no red result below is attributable: a suite that is
// already red needs no defect to go red.
for (const suite of [...new Set(DEFECTS.flatMap((d) => d.expect.map((e) => e.suite)))].sort()) {
  const result = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--package",
      "fengari-node-cli",
      "fengari",
      "scripts/run-lua-suite.lua",
      `tests/lua/${suite}.lua`,
    ],
    { cwd: root }
  );
  const out = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
  if (result.exitCode !== 0 || !out.includes(`${suite}: ok`)) {
    console.error(`FAIL baseline ${suite}: red with nothing planted.\n${out.trim()}`);
    failures++;
  } else {
    console.log(`ok   baseline ${suite}: passes with nothing planted`);
  }
}

for (const defect of DEFECTS) for (const want of defect.expect) check(defect, want);

const runs = DEFECTS.reduce((n, d) => n + d.expect.length, 0);
if (failures > 0) {
  console.error(`\n${failures} control check(s) failed`);
  process.exit(1);
}
console.log(
  `\nPASS: ${DEFECTS.length} planted defects caught over ${runs} suite runs, 2 drills, baseline green`
);
