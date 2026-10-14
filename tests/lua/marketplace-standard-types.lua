-- shared/imports/marketplace: standardTypes, and the overwrite warning that
-- was a broadcast into the void in four resources.
--
-- The bug: installing a sound pack whose slug collides with an existing
-- filename fired `TriggerClientEvent('<prefix>:soundOverwriteWarning', -1, …)`
-- -- to every player, about an admin action -- and in three of the four
-- resources nothing anywhere registered the event. tELS deleted its copy
-- rather than fix it; the honest fix needed the installing admin's id, which
-- tLib now carries as `meta.src`.
--
-- Two properties of the fixed version matter and both are asserted below:
-- the send is TARGETED at `meta.src` and never at -1, and the server log is
-- UNCONDITIONAL -- `src` is nil when the admin disconnected mid-install and the
-- record has to exist whether or not anybody saw a toast.
--
-- NEGATIVE CONTROL: MKT_CONTROL=1 retargets the warning at -1 inside this
-- suite's own copy of the dispatch, the way the four resources had it, and
-- REQUIRES the broadcast assertion to fail. Proving the suite can fail is the
-- point: a dead assertion reports a clean run, and so does a working one.
--
--   bun run test:lua
--   MKT_CONTROL=1 bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/marketplace-standard-types.lua
--
-- Run from the tLib resource root.

local CONTROL = os.getenv('MKT_CONTROL') == '1'

-- Stub host

local registered = {}        -- kind -> installPath
local registerCalls = 0
local registerFails = {}     -- kind -> 'false' | 'throw'
local handlers = {}          -- event -> fn
local clientEvents = {}      -- { event, target, payload }
local notes, warns = {}, {}

exports = {
    tLib = {
        RegisterMarketplaceType = function(_self, kind, opts)
            registerCalls = registerCalls + 1
            local mode = registerFails[kind]
            if mode == 'throw' then error('the marketplace module is not loaded', 0) end
            if mode == 'false' then return false end
            registered[kind] = opts and opts.installPath
            return true
        end,
    },
}

function AddEventHandler(event, fn) handlers[event] = fn end

function TriggerClientEvent(event, target, payload)
    clientEvents[#clientEvents + 1] = { event = event, target = target, payload = payload }
end

local realPrint = print
local failures = {}
local function fail(message)
    failures[#failures + 1] = message
    realPrint('FAIL  ' .. message)
end
local function must(condition, message)
    if not condition then fail(message) end
end

local marketplace = dofile('shared/imports/marketplace/server.lua')

local function note(m) notes[#notes + 1] = m end
local function warn(m) warns[#warns + 1] = m end

local function reset()
    registered, registerCalls, registerFails = {}, 0, {}
    handlers, clientEvents, notes, warns = {}, {}, {}, {}
end

-- registerType: the opt-out a server is allowed to make

reset()
must(marketplace.registerType('ui', 'layouts', warn) == true,
    'a successful registration did not report success')
must(registered.ui == 'layouts', 'the install path was not passed through')
must(#warns == 0, 'a successful registration warned anyway')

-- The Node bridge answers `false` rather than raising when the consumer has not
-- opted into `tlib_module { 'marketplace' }`. A `false` and a throw are the same
-- operator-visible condition and must get the same message.
reset()
registerFails.sound = 'false'
must(marketplace.registerType('sound', 'layouts/sounds', warn) == false,
    'a refused registration reported success')
must(#warns == 1, 'a refused registration did not warn')
must(warns[1]:find('tlib_module', 1, true),
    'the warning did not name the fxmanifest line to add -- two of the four '
    .. 'hand-written copies logged a message that named nothing to do')
must(warns[1]:find('sound', 1, true), 'the warning did not say which type failed')

reset()
registerFails.ui = 'throw'
must(marketplace.registerType('ui', 'layouts', warn) == false,
    'a throwing registration was reported as success')
must(#warns == 1 and warns[1]:find('tlib_module', 1, true),
    'a throwing registration did not produce the same warning as a refused one')

-- No `warn` at all must not raise: a resource with no logger still has to boot.
reset()
registerFails.ui = 'throw'
local ok = pcall(marketplace.registerType, 'ui', 'layouts', nil)
must(ok, 'registerType raised when it had no warn function')

-- standardTypes: both halves, the default paths, the event prefix

reset()
local layoutInstalls, layoutUninstalls = {}, {}
local soundInstalls, soundUninstalls = {}, {}
local conflictToReturn = nil

marketplace.standardTypes('tProbe', {
    note = note,
    warn = warn,
    layouts = {
        installed = function(slug, meta) layoutInstalls[#layoutInstalls + 1] = { slug, meta } end,
        uninstalled = function(slug) layoutUninstalls[#layoutUninstalls + 1] = slug end,
    },
    sounds = {
        warnEvent = 'tprobe:soundOverwriteWarning',
        installed = function(slug, meta)
            soundInstalls[#soundInstalls + 1] = { slug, meta }
            return conflictToReturn
        end,
        uninstalled = function(slug) soundUninstalls[#soundUninstalls + 1] = slug end,
    },
})

must(registerCalls == 2, ('both types were not registered (saw %d call(s))'):format(registerCalls))
must(registered.ui == 'layouts', "the ui type did not default to 'layouts'")
must(registered.sound == 'layouts/sounds', "the sound type did not default to 'layouts/sounds'")

-- The event name is nothing but the resource name plus a suffix, which is the
-- whole reason four resources each wrote this block: the prefix LOOKED like a
-- per-resource decision.
local installed = handlers['tProbe:marketplace:installed']
local uninstalled = handlers['tProbe:marketplace:uninstalled']
must(installed ~= nil, 'the installed handler was never registered under the resource prefix')
must(uninstalled ~= nil, 'the uninstalled handler was never registered')

installed('ui', 'neon-hud', { src = 4 })
must(#layoutInstalls == 1 and layoutInstalls[1][1] == 'neon-hud',
    'a ui install did not reach the layouts callback')
must(layoutInstalls[1][2].src == 4, 'the meta table was not passed to the callback')
must(#soundInstalls == 0, 'a ui install also ran the sounds callback')
must(#notes == 1 and notes[1]:find('neon-hud', 1, true),
    'the install was not logged with its slug')

uninstalled('ui', 'neon-hud')
must(#layoutUninstalls == 1, 'a ui uninstall did not reach the callback')

installed('sound', 'ka-band', { src = 4 })
must(#soundInstalls == 1 and soundInstalls[1][1] == 'ka-band',
    'a sound install did not reach the sounds callback')
must(#clientEvents == 0, 'an install with NO conflict still warned somebody')

uninstalled('sound', 'ka-band')
must(#soundUninstalls == 1, 'a sound uninstall did not reach the callback')

-- An item type neither half claims is ignored rather than mis-dispatched.
local before = #layoutInstalls + #soundInstalls
installed('anim', 'wave', {})
must(#layoutInstalls + #soundInstalls == before,
    'an unknown item type was dispatched to one of the two halves')

-- soundConflict: targeted, logged, and never a broadcast

reset()

-- THE CONTROL'S DEFECT, planted in the path under test rather than beside it.
--
-- The module reads `TriggerClientEvent` as a global at call time, so replacing
-- it here puts the shipped bug back inside `soundConflict`: the send still
-- happens, with the same payload, at `-1`. Everything below then runs against a
-- module that is behaving the way all four resources behaved, and the broadcast
-- assertion has to be the thing that notices.
if CONTROL then
    local realTrigger = TriggerClientEvent
    TriggerClientEvent = function(event, _target, payload)
        realTrigger(event, -1, payload)
    end
end

local told = marketplace.soundConflict('old-tone', 'ka-band', { src = 9 },
    'tprobe:soundOverwriteWarning', warn)

must(told == true, 'the installing admin was not told about an overwrite')
must(#warns == 1, 'the overwrite was not logged on the server')
must(warns[1]:find('old-tone', 1, true) and warns[1]:find('ka%-band%.wav'),
    'the server log did not name both the replaced and the replacing file')
must(#clientEvents == 1, 'the warning did not produce exactly one client send')

local sent = clientEvents[1]
must(sent.event == 'tprobe:soundOverwriteWarning', 'the warning used the wrong event name')
must(sent.payload.filename == 'ka-band.wav', 'the payload did not carry the filename')
must(sent.payload.newSlug == 'ka-band' and sent.payload.oldSlug == 'old-tone',
    'the payload did not carry both slugs')

-- THE BUG, asserted directly. `-1` is every player on the server, for a
-- message about an admin action that, in three of the four resources, nothing
-- could even receive. Under the control these two are the assertions that have
-- to fail, and the verdict refuses the run if they do not.
local caught = 0
local function mustTarget(condition, message)
    if condition then return end
    caught = caught + 1
    if not CONTROL then fail(message) end
end

mustTarget(sent.target ~= -1,
    'the overwrite warning was BROADCAST to -1. That is the bug this module exists '
    .. 'to have fixed once: every player on the server receives a message about an '
    .. 'admin action, and three of the four resources had no handler for it at all.')
mustTarget(sent.target == 9, 'the warning did not go to the installing admin')

-- No conflict: nothing is logged and nothing is sent.
reset()
must(marketplace.soundConflict(nil, 'ka-band', { src = 9 }, 'e', warn) == false,
    'soundConflict acted on a nil conflict')
must(#warns == 0 and #clientEvents == 0, 'a non-conflict produced output')

-- The admin disconnected mid-install, so there is nobody to tell. The LOG is
-- still unconditional: the record has to exist whether or not anyone saw it.
reset()
must(marketplace.soundConflict('old-tone', 'ka-band', nil, 'e', warn) == false,
    'soundConflict claimed it told somebody with no source')
must(#warns == 1, 'the overwrite went unlogged because the admin had disconnected')
must(#clientEvents == 0, 'a warning was sent with no target')

-- A consumer with no client handler declares no warnEvent and gets the log
-- alone. That is tELS's behaviour, now by declaration rather than by a send it
-- deleted.
reset()
must(marketplace.soundConflict('old-tone', 'ka-band', { src = 9 }, nil, warn) == false,
    'a warning was sent for a consumer that declared no event for it')
must(#warns == 1, 'the console record was dropped along with the client send')
must(#clientEvents == 0, 'a client event was fired with no event name')

-- Either half may be absent

reset()
marketplace.standardTypes('tProbeUi', { note = note, warn = warn, sounds = false })
must(registerCalls == 1 and registered.ui == 'layouts' and registered.sound == nil,
    'sounds = false still registered the sound type')
-- And its handler must ignore sound events rather than index a false.
local uiOnly = handlers['tProbeUi:marketplace:installed']
must(pcall(uiOnly, 'sound', 'x', {}), 'a sound event raised in a layouts-only consumer')

reset()
marketplace.standardTypes('tProbeSnd', { note = note, warn = warn, layouts = false })
must(registerCalls == 1 and registered.sound == 'layouts/sounds' and registered.ui == nil,
    'layouts = false still registered the ui type')
local sndOnly = handlers['tProbeSnd:marketplace:installed']
must(pcall(sndOnly, 'ui', 'x', {}), 'a ui event raised in a sounds-only consumer')

-- A non-default install path is honoured, which is what lets a consumer keep
-- its own on-disk layout.
reset()
marketplace.standardTypes('tProbePath', { layouts = { path = 'ui/skins' }, sounds = false })
must(registered.ui == 'ui/skins', 'an explicit install path was ignored')

-- The pre-existing helpers are untouched

local sounds = {}
must(marketplace.upsertSound(sounds, 'ka') == nil, 'upsertSound invented a conflict')
must(#sounds == 1 and sounds[1].filename == 'ka.wav', 'upsertSound did not add the entry')
must(marketplace.removeSound(sounds, {}, 'ka') == 'ka.wav', 'removeSound did not report the file')

-- Verdict

if CONTROL then
    -- Both target assertions must have tripped: the send went to -1 instead of
    -- to player 9. Anything less means the suite is not reading the target.
    if caught ~= 2 or #failures > 0 then
        realPrint(('CONTROL FAILED: %d of 2 target assertions tripped with the -1 broadcast '):format(caught)
            .. 'planted back in, and ' .. tostring(#failures) .. ' unrelated assertion(s) failed.')
        realPrint('This suite cannot detect the bug it exists to pin.')
        os.exit(1)
    end
    realPrint('CONTROL OK: both target assertions tripped with the -1 broadcast planted back '
        .. 'into soundConflict, so the gate above is capable of failing.')
    os.exit(1)
end

if caught > 0 then
    realPrint(('\n%d target assertion(s) failed'):format(caught))
    os.exit(1)
end

if #failures > 0 then
    realPrint(('\n%d assertion(s) failed'):format(#failures))
    os.exit(1)
end

realPrint('marketplace-standard-types: ok')
