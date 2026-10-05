-- The runtime TXD lifecycle: created once per resource load, never again.
--
-- CREATE_RUNTIME_TXD permanently consumes and pins one of the game's finite `ytd`
-- streaming slots and has no destructor bound in the engine, so nothing reachable
-- from Lua frees one. Calling it twice under the same name is not merely wasteful:
-- EnsureTxd only assigns m_txd inside `if (!entry.handle)` and a script-created slot
-- never acquires a streaming handle, so the second call either orphans every texture
-- already registered under that name — which is exactly the set AddReplaceTexture is
-- still pointing at — or leaves m_txd null and makes every later
-- CreateRuntimeTexture return 0. NEITHER RAISES, and neither is recoverable.
--
-- THE COUNT IS THE ONLY ORACLE. In game the leak is invisible until the streamer
-- runs out of slots, by which point nothing names the resource that took them.
--
-- The second half is the restart hazard, and it is the one that actually shipped
-- broken: runtime names are process-global and outlive the resource that took them,
-- so a name that does not carry a per-load tag is already taken after a
-- `restart <resource>` for as long as the game client runs. A stub that always
-- succeeds cannot tell a name that is unique per LOAD from one that is unique per
-- PROCESS, and those differ only after a restart — which is exactly when it broke.
-- So this suite models the taken names.
--
-- ── The negative controls ───────────────────────────────────────────────────
--
-- Both plant their defect in THE MODULE'S OWN SOURCE, by substituting one line and
-- `load`ing the result — not by substituting a stub, which would only prove the stub
-- is wrong. Each substitution is asserted to have matched, because a gsub that
-- matched nothing yields the unmodified module and a control that passes having
-- planted nothing.
--
--   RUNTIMETXD_CONTROL=nocache  `ensure` loses its cache and calls the native every
--     time. The create-once assertions must FLIP.
--   RUNTIMETXD_CONTROL=notag    the dictionary and texture names lose the per-load
--     tag. The restart-collision assertions must FLIP.
--
-- Each mode requires an EXACT set of flips and names any that did not happen, so a
-- control whose expected set has gone stale refuses its own run.
--
-- Run via `bun run test:lua`; the controls via `bun run test:lua:control`.

local CONTROL = os.getenv('RUNTIMETXD_CONTROL')
if CONTROL == '' then CONTROL = nil end

local MUST_FLIP = {
    nocache = {
        ['one-dictionary-per-load'] = true,
        ['native-called-once'] = true,
        ['count-reads-one'] = true,
        ['calls-across-two-loads'] = true,
    },
    notag = {
        ['dictionary-name-survives-restart'] = true,
        ['texture-name-survives-restart'] = true,
        ['constant-texture-name-survives-restart'] = true,
        ['texture-name-carries-tag'] = true,
        ['constant-name-carries-tag'] = true,
        ['lazy-tag'] = true,
    },
}

if CONTROL ~= nil and MUST_FLIP[CONTROL] == nil then
    error('RUNTIMETXD_CONTROL must be unset, "nocache" or "notag"; got ' .. tostring(CONTROL), 0)
end

local expectedFlips = MUST_FLIP[CONTROL] or {}
local seenFlips, seenLabels = {}, {}

local function expect(label, ok, message)
    if seenLabels[label] then error('duplicate assertion label: ' .. label, 0) end
    seenLabels[label] = true
    if expectedFlips[label] then
        if ok then
            error(('control %q: %q still passed -- the planted defect was not measured. %s')
                :format(CONTROL, label, message), 0)
        end
        seenFlips[label] = true
        return
    end
    if not ok then error(('%s [%s]'):format(message, label), 0) end
end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local clock = 1000
function GetGameTimer() return clock end

-- Every name CreateRuntimeTxd has ever been handed, in order, across every
-- "resource load" below. The engine's behaviour, not a counter: a second
-- registration of a live name yields a DIFFERENT dictionary, which is the whole
-- problem.
local txdCalls = {}
local handles = 0
function CreateRuntimeTxd(name)
    txdCalls[#txdCalls + 1] = name
    handles = handles + 1
    return 'txd:' .. handles
end

-- ── The module, with the control's defect planted in its own source ─────────
--
-- RUNTIMETXD_SOURCE names the file to load. It is the real module on a normal run; a
-- control run points it at a copy with ONE line substituted. The copy is produced by
-- scripts/runtimetxd-control.ts, outside the repo, because fengari ships no `io` --
-- the patching cannot happen here, and a control that substituted a STUB instead
-- would only prove the stub was wrong.
--
-- The runner asserts each substitution matched exactly once, which is the half that
-- matters: a gsub that matched nothing yields the unmodified module and a control
-- that passes having planted nothing.
local SOURCE_PATH = os.getenv('RUNTIMETXD_SOURCE')
if SOURCE_PATH == nil or SOURCE_PATH == '' then
    SOURCE_PATH = 'shared/imports/runtimetxd/client.lua'
elseif CONTROL == nil then
    error('RUNTIMETXD_SOURCE is set but RUNTIMETXD_CONTROL is not; a patched module '
        .. 'must never be loaded on a normal run', 0)
end

local RuntimeTxd = assert(loadfile(SOURCE_PATH))()

-- ── One dictionary per load, however often it is asked for ──────────────────

local txds = RuntimeTxd.create('tdet_scr_txd')

local first = txds.ensure()
local stable = true
for _ = 1, 20 do
    if txds.ensure() ~= first then stable = false end
end
expect('one-dictionary-per-load', stable,
    'ensure() handed out a second dictionary for the same load')
expect('native-called-once', #txdCalls == 1,
    'CreateRuntimeTxd was called ' .. #txdCalls .. ' times for one resource load')
expect('count-reads-one', txds.count() == 1,
    'the dictionary count reads ' .. tostring(txds.count()) .. ', not 1')

-- The name is stable WITHIN a load. `ensure` caches on it, so a name that changed
-- per call would create a fresh pinned slot every time and `count` would be the only
-- thing that noticed.
local name = txds.name()
local nameStable = true
for _ = 1, 5 do
    if txds.name() ~= name then nameStable = false end
end
expect('name-stable-within-load', nameStable, 'the dictionary name changed within one load')
expect('name-carries-prefix', name:find('^tdet_scr_txd') ~= nil,
    'the dictionary name does not carry its prefix: ' .. name)

-- ── The tag is resolved LAZILY ──────────────────────────────────────────────
--
-- Natives are not reliably callable while a resource's scripts are still being
-- loaded, which is when `create` runs. A tag taken at create time would be whatever
-- GetGameTimer answered then — on some loads, nothing at all.
local lateTagName = (function()
    local before = clock
    clock = -1                    -- as if the native were not answering yet
    local instance = RuntimeTxd.create('tlate')
    clock = before                -- now it is
    return instance.name()
end)()
expect('lazy-tag', lateTagName == ('tlate_%x'):format(clock),
    'the per-load tag was resolved when create() ran rather than on first use: ' .. lateTagName)

-- ── Texture names carry the tag, so they cannot survive a restart ───────────

local texA = txds.textureName('tdet_screen', 1)
local texB = txds.textureName('tdet_screen', 2)
expect('serials-are-distinct', texA ~= texB, 'two serials produced the same texture name')
expect('texture-name-carries-tag', texA:find(txds.tag(), 1, true) ~= nil,
    'a texture name does not carry the per-load tag: ' .. texA)

-- A name with NO serial still carries the tag. This is the case that shipped broken:
-- a texture whose name is otherwise constant collides on EVERY restart without
-- exception, where a serial-suffixed one only collides on the low serials.
local constantName = txds.textureName('tdet_key_lit')
expect('constant-name-carries-tag', constantName:find(txds.tag(), 1, true) ~= nil,
    'a serial-less texture name does not carry the per-load tag: ' .. constantName)

-- ── A RESTART ───────────────────────────────────────────────────────────────
--
-- A new resource load in the SAME game client: GetGameTimer has moved on, so every
-- name this load takes must differ from every name the last one did. Modelled as a
-- second instance, which is what a reloaded script produces.

clock = clock + 60000
local reloaded = RuntimeTxd.create('tdet_scr_txd')
reloaded.ensure()

expect('dictionary-name-survives-restart', reloaded.name() ~= name,
    'a reloaded resource asked for the dictionary name the previous load already took; '
        .. 'AddReplaceTexture would resolve to the dictionary without our textures')
expect('texture-name-survives-restart', reloaded.textureName('tdet_screen', 1) ~= texA,
    'a reloaded resource asked for a texture name the previous load already took; '
        .. 'CreateRuntimeTextureFromDuiHandle returns null and the screen stays baked')
expect('constant-texture-name-survives-restart', reloaded.textureName('tdet_key_lit') ~= constantName,
    'a serial-less texture name collided across a restart')

-- Each LOAD still created exactly one dictionary of its own. Two across two loads is
-- the deliberate cost of tokenising the name — one leaked pinned slot per restart,
-- against a screen that dies on every restart — and it must not be three.
expect('reloaded-count-reads-one', reloaded.count() == 1,
    'the reloaded instance created ' .. tostring(reloaded.count()) .. ' dictionaries')

-- TWO calls, not three: the lazy-tag instance above was created and named but never
-- `ensure`d, and `create` must not reach the native by itself. That is the same
-- property the lazy-tag assertion states, measured from the engine's side.
expect('calls-across-two-loads', #txdCalls == 2,
    'expected 2 CreateRuntimeTxd calls across two loads, got '
        .. #txdCalls .. ': ' .. table.concat(txdCalls, ', '))

-- ── Two prefixes are two dictionaries, and that is the point ────────────────
--
-- Nothing stops a consumer creating a second instance; what stops it being free is
-- that `count` says so. The module's header says ONE dictionary per resource.
local second = RuntimeTxd.create('tdet_other_txd')
second.ensure()
expect('prefixes-are-distinct', second.name() ~= reloaded.name(),
    'two prefixes produced the same dictionary name')

-- ── The prefix is required ──────────────────────────────────────────────────
--
-- Otherwise the name is `_<tag>`, which is a valid-looking dictionary nobody can
-- find in a log.
local junkRejected = not pcall(RuntimeTxd.create)
for _, junk in ipairs({ '', 17, {}, true }) do
    if pcall(RuntimeTxd.create, junk) then junkRejected = false end
end
expect('prefix-is-required', junkRejected, 'create accepted a junk or absent prefix')
expect('stem-is-required', not pcall(second.textureName, ''),
    'textureName accepted an empty stem')

-- ── The control's own bookkeeping ───────────────────────────────────────────

if CONTROL ~= nil then
    local missing, n = {}, 0
    for label in pairs(expectedFlips) do
        n = n + 1
        if not seenFlips[label] then missing[#missing + 1] = label end
    end
    if #missing > 0 then
        error(('control %q: %d of %d expected flips never happened: %s')
            :format(CONTROL, #missing, n, table.concat(missing, ', ')), 0)
    end
    if n == 0 then
        error(('control %q expects no flips, which cannot prove anything'):format(CONTROL), 0)
    end
    error(('CONTROL %s: all %d expected assertions flipped (this exit is the PASS for a control run)')
        :format(CONTROL, n), 0)
end

print('PASS runtimetxd-create-once')
