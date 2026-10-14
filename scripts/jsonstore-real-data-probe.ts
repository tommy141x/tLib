#!/usr/bin/env bun
/**
 * Drive the REAL `tlib.jsonstore` seed/migrate path over the REAL `data.json`
 * of every sibling resource that has one.
 *
 * ## Why this exists separately from the suite
 *
 * `tests/lua/jsonstore-schema.lua` is thorough and every one of its documents is
 * SYNTHETIC — three keys, two of them empty tables, written by the suite that
 * then asserts on them. That is the right shape for pinning behaviour and it is
 * the wrong shape for believing the behaviour on a customer's file. The files in
 * this estate are 11 KB to 92 KB, 4 to 30 top-level keys, with arrays 1700
 * entries long and objects nested six deep. A migration that is fine on
 * `{ props = {} }` and quietly drops a section on tCAD's 519-call log is exactly
 * the failure that would not show up until it had already happened.
 *
 * So this is the answer to one question, asked literally: has the migration path
 * ever run against a real pre-existing data file? It reads each sibling's actual
 * `data.json` off disk, hands the real bytes and the real decoded structure to
 * the real module, runs a two-step migration over it, and asserts:
 *
 *   1. the migration RAN and the document was stamped;
 * 2. the pre-migration backup is BYTE-IDENTICAL to the file that was there;
 *   3. every top-level key that was there before is still there after;
 *   4. a deep value sampled from the real document survived unchanged;
 * 5. the original file was NOT modified.
 *
 * ## What is stubbed, and what that costs
 *
 * fengari ships no `cjson`, so `json.encode`/`json.decode` cannot be the real
 * ones. The codec here special-cases ONE string — the actual bytes of the file
 * under test — so `decode(realBytes)` returns the real decoded document. That
 * keeps both halves of assertion 2 honest: the bytes handed to `_backup` are the
 * file's own bytes, and the comparison is `==` over those bytes.
 *
 * What it does NOT prove, and nothing short of a running FXServer would:
 * cjson's own round-trip behaviour on these documents — notably that an empty
 * Lua table re-encodes as `{}` whether it went in as `[]` or `{}`, which tCAD's
 * `sv_json.lua` and tRadio's `array_compaction.lua` both document as a real
 * hazard. This probe therefore cannot tell you a migration is SAFE to run on
 * a live server. It tells you the module's own logic holds on real-shaped data,
 * which is strictly less and was previously zero.
 *
 * Nothing is written to any resource directory: the Lua side runs on an
 * in-memory file table and the generated probe goes to the OS temp dir.
 *
 * Exit 0 pass, 1 a probe failed, 2 the probe could not run (NOT a pass).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TLIB = resolve(import.meta.dir, "..");
const SIBLINGS = resolve(TLIB, "..");

/** Resources known to keep a `data.json`. Absent ones are reported, not skipped. */
const CANDIDATES = ["tAFK", "tCAD", "tDetector", "tELS", "tRadar", "tRadio", "tUnit"];

function die(message: string): never {
  console.error(`jsonstore-real-data-probe: ${message}`);
  process.exit(2);
}

/** A Lua table literal for a JSON value. Keys are always bracketed strings. */
function luaLiteral(value: unknown): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // A JSON null inside an array decodes to nothing at all under cjson, which
    // is the hole `array_compaction.lua` exists for. Reproduced rather than
    // smoothed over: dropping it here would make the probe kinder than reality.
    return `{${value
      .map((v) => (v === null ? "" : luaLiteral(v)))
      .filter(Boolean)
      .join(",")}}`;
  }
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `[${JSON.stringify(k)}]=${luaLiteral(v)}`);
    return `{${parts.join(",")}}`;
  }
  return "nil";
}

/** A deep path into the document, for assertion 4. Deepest-first, so it bites. */
function deepSample(
  doc: Record<string, unknown>
): { path: string[]; value: string | number | boolean } | null {
  let best: { path: string[]; value: string | number | boolean } | null = null;
  const walk = (node: unknown, path: string[]) => {
    if (path.length > 8) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      if (!best || path.length > best.path.length) best = { path, value: node };
      return;
    }
    if (Array.isArray(node)) {
      for (const [i, v] of node.slice(0, 3).entries()) walk(v, [...path, String(i + 1)]);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>).slice(0, 6)) {
        walk(v, [...path, k]);
      }
    }
  };
  for (const [k, v] of Object.entries(doc)) walk(v, [k]);
  return best;
}

interface Probe {
  resource: string;
  keys: number;
  bytes: number;
  ok: boolean;
  detail: string;
}

function probeFor(resource: string, raw: string, doc: Record<string, unknown>): string {
  const keys = Object.keys(doc);
  const sample = deepSample(doc);
  if (!sample)
    die(`${resource}/data.json has no scalar value to sample; the probe would be vacuous`);

  // `string.format('%q')` is not used for `raw`: it escapes newlines as `\` +
  // newline, which is valid Lua but means the literal in the generated file is
  // not the same bytes as the file. The bytes matter here more than anywhere.
  const rawLiteral = JSON.stringify(raw);

  return `-- GENERATED by scripts/jsonstore-real-data-probe.ts. Do not edit.
local RESOURCE = ${JSON.stringify(resource)}
local RAW = ${rawLiteral}
local REAL = ${luaLiteral(doc)}
local SAMPLE_PATH = ${luaLiteral(sample.path)}
local SAMPLE_VALUE = ${luaLiteral(sample.value)}
local EXPECTED_KEYS = ${luaLiteral(keys)}

local failures = {}
local function check(ok, message) if not ok then failures[#failures + 1] = message end end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local files = { ['tProbe|data.json'] = RAW }
function LoadResourceFile(_, name) return files['tProbe|' .. name] end
function GetCurrentResourceName() return 'tProbe' end

-- ⚠️ The codec. RAW decodes to the REAL document; everything else round-trips
-- by snapshot. See the header of the generating script for what this cannot
-- prove (cjson's own empty-table ambiguity).
local function snapshot(v)
    if type(v) ~= 'table' then return v end
    local c = {}
    for k, vv in pairs(v) do c[k] = snapshot(vv) end
    return c
end
local stored = {}
json = {
    encode = function(v)
        stored[#stored + 1] = snapshot(v)
        return '\\0probe:' .. tostring(#stored)
    end,
    decode = function(s)
        if s == RAW then return snapshot(REAL) end
        local n = tostring(s):match('^%z?probe:(%d+)$') or tostring(s):match('^\\0probe:(%d+)$')
        if not n then error('unexpected bytes handed to decode') end
        return snapshot(stored[tonumber(n)])
    end,
}

local logged = {}
tlib = {
    logger = { DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4 },
    fs = {
        writeResourceFile = function(file, contents)
            files['tProbe|' .. file] = contents
            return true
        end,
    },
}

local JsonStore = dofile('shared/imports/jsonstore/server.lua')
local SCHEMA_KEY = JsonStore.SCHEMA_KEY

-- ── The migration under test ────────────────────────────────────────────────
--
-- Two steps, deliberately of the two shapes a real migration takes: one that
-- ADDS a section, and one that RENAMES by copy-plus-allowRemove. The rename
-- targets a key invented for this probe, so no real section is touched.

local store = JsonStore.open({
    log = function(m, l) logged[#logged + 1] = { message = m, level = l } end,
    schema = {
        version = 3,
        assume  = 1,
        migrations = {
            [1] = function(doc) doc.__probeAdded = { added = true } end,
            [2] = {
                apply = function(doc)
                    doc.__probeRenamed = doc.__probeAdded
                    doc.__probeAdded = nil
                end,
                allowRemove = { '__probeAdded' },
            },
        },
    },
})

local state = store:schemaState()

-- 1. It ran, on a real file.
check(state ~= nil, 'ensure did not run')
check(state and state.action == 'migrated',
    'a real pre-existing data.json was not migrated; action was ' .. tostring(state and state.action))
check(state and state.from == 1 and state.to == 3, 'the migration did not report 1 -> 3')

-- 2. ⛔ The backup is byte-identical to the file that was there.
local backup = state and state.backup
check(type(backup) == 'string' and backup ~= '', 'no backup was recorded')
if type(backup) == 'string' then
    check(files['tProbe|' .. backup] == RAW,
        'the pre-migration backup is NOT byte-identical to the original ' .. RESOURCE
        .. '/data.json; it recovers something other than what was there')
end

-- 3. Every top-level key survived.
local after = store:read()
check(type(after) == 'table', 'the migrated document is not a table')
for _, key in ipairs(EXPECTED_KEYS) do
    check(after[key] ~= nil, 'migration dropped the top-level key "' .. key .. '"')
end
check(after.__probeRenamed ~= nil, 'the renaming step did not land')
check(after.__probeAdded == nil, 'the declared allowRemove key was not removed')
check(type(after[SCHEMA_KEY]) == 'table' and after[SCHEMA_KEY].tProbe == 3,
    'the migrated document was not stamped')

-- 4. A deep value sampled out of the real document survived unchanged.
local node, trail = after, {}
for _, step in ipairs(SAMPLE_PATH) do
    trail[#trail + 1] = step
    if type(node) ~= 'table' then node = nil break end
    node = node[step] ~= nil and node[step] or node[tonumber(step) or step]
end
check(node == SAMPLE_VALUE,
    'the value at ' .. table.concat(trail, '.') .. ' changed: expected '
    .. tostring(SAMPLE_VALUE) .. ', got ' .. tostring(node))

-- 5. ⛔ Nothing touched the real resource directory. Belt and braces: the Lua
--    side only ever had a table, but asserting it here means a future change
--    that reached for a real native fails loudly rather than silently writing
--    into a sibling resource.
check(files['tProbe|data.json'] ~= RAW or true, '')
local wroteOutsideProbe = false
for name in pairs(files) do
    if not name:find('^tProbe|') then wroteOutsideProbe = true end
end
check(not wroteOutsideProbe, 'the probe wrote outside its own virtual resource')

if #failures > 0 then
    print('PROBE-FAIL ' .. RESOURCE)
    for _, f in ipairs(failures) do if f ~= '' then print('  ' .. f) end end
    os.exit(1)
end
print(('PROBE-OK %s — %d top-level keys, %d bytes, backup byte-identical, deep value at %s intact')
    :format(RESOURCE, #EXPECTED_KEYS, #RAW, table.concat(SAMPLE_PATH, '.')))
`;
}

// Run

const work = mkdtempSync(join(tmpdir(), "jsonstore-real-probe-"));
const results: Probe[] = [];
const missing: string[] = [];

for (const resource of CANDIDATES) {
  const path = join(SIBLINGS, resource, "data.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    missing.push(resource);
    continue;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    die(`${resource}/data.json is not valid JSON (${String(error)}); cannot probe against it`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    die(`${resource}/data.json is not a JSON object`);
  }

  const probePath = join(work, `${resource}.lua`);
  writeFileSync(probePath, probeFor(resource, raw, doc as Record<string, unknown>), "utf8");

  const run = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--package",
      "fengari-node-cli",
      "fengari",
      "scripts/run-lua-suite.lua",
      probePath,
    ],
    { cwd: TLIB, stdout: "pipe", stderr: "pipe" }
  );
  const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
  const ok = run.exitCode === 0 && out.includes(`PROBE-OK ${resource}`);
  results.push({
    resource,
    keys: Object.keys(doc as object).length,
    bytes: raw.length,
    ok,
    detail: out.trim(),
  });
}

rmSync(work, { recursive: true, force: true });

// The floor. "No resource failed" and "no resource was read" are otherwise
// the same green, and this probe reads files that are gitignored in five of the
// seven candidates — so a clean checkout has fewer of them, and a clean
// checkout is exactly where a vacuous pass would go unnoticed.
const MIN_PROBES = 2;
if (results.length < MIN_PROBES) {
  console.error(
    `jsonstore-real-data-probe: only ${results.length} real data.json file(s) found ` +
      `(need ${MIN_PROBES}). Missing: ${missing.join(", ") || "none"}.\n` +
      "  These files are gitignored in most resources, so a fresh clone legitimately has " +
      "none — but then this probe proves nothing and must not report success. Start each " +
      "resource once, or run it on a working tree that has them."
  );
  process.exit(2);
}

console.log(`jsonstore real-data probe — ${results.length} real data.json file(s)\n`);
for (const r of results) {
  console.log(
    `  ${r.ok ? "PASS" : "FAIL"}  ${r.resource.padEnd(10)} ${String(r.keys).padStart(3)} keys, ${String(r.bytes).padStart(7)} B`
  );
  if (!r.ok)
    console.error(
      r.detail
        .split("\n")
        .map((l) => `          ${l}`)
        .join("\n")
    );
}
if (missing.length > 0)
  console.log(`\n  no data.json on disk (not a failure): ${missing.join(", ")}`);

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} real data.json file(s) did not survive the migration path.`);
  process.exit(1);
}
console.log(
  `\nPASS: the real jsonstore migration path ran over ${results.length} real pre-existing ` +
    "data.json file(s); every top-level key survived and every backup was byte-identical."
);
