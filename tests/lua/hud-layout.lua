local exports, requests, events, stops, shutdowns, timers = {}, {}, {}, {}, {}, {}
local caller, focused, now, writes, captured = 'alpha', false, 1000, 0, nil
local commands, threads, focusCalls = {}, {}, 0
local ready, pendingDialog, typing = true, false, false
DialogExports = { isActive = function() return pendingDialog end }
MenuInput = { isTyping = function() return typing end }
_TLIB_IS_FIVEM = true
local logLines = {}
Logger = { create = function() return function(message) logLines[#logLines + 1] = tostring(message) end end }
Platform = {
    export = function(_, name, fn) exports[name] = fn end,
    onUIRequest = function(_, name, fn) requests[name] = fn end,
    sendUIEvent = function(_, name, data) events[#events + 1] = { name = name, data = data } end,
    getInvokingResource = function() return caller end,
    isNUIReady = function() return ready end,
    setInputMode = function(_, mode) focused = mode == 1; focusCalls = focusCalls + 1 end,
    setIgnoreMoveInput = function() end, setIgnoreLookInput = function() end,
    onShutdown = function(fn) shutdowns[#shutdowns + 1] = fn end,
    createThread = function(fn) threads[#threads + 1] = coroutine.create(fn) end,
    wait = function() coroutine.yield() end,
    now = function() return now end,
    setTimeout = function(fn) timers[#timers + 1] = fn; return #timers end,
    clearTimeout = function(id) timers[id] = false end,
}
GetConvar = function() return 'test-profile' end
GetHashKey = function() return 123 end
GetResourceKvpString = function() return nil end
SetResourceKvp = function(_, value) writes = writes + 1; captured = value end
json = { encode = function(value) return value end }
GetSafeZoneSize = function() return 1 end
-- The game resolution is the fallback viewport when the editor supplies none.
GetActiveScreenResolution = function() return 1920, 1080 end
IsNuiFocused = function() return focused end
AddEventHandler = function(name, fn) stops[name] = fn end
RegisterCommand = function(name, fn) commands[name] = fn end
local acquired, released = 0, 0
UIEffects = { acquireBlur = function()
    acquired = acquired + 1
    return {}
end, releaseBlur = function() released = released + 1 end }
dofile('client/lib/layout/schema.lua')
dofile('client/cl_layout.lua')
HudLayout.init({})
local checks = 0
local function check(value, message) checks = checks + 1; assert(value, message) end
-- There is deliberately no GetHudLayoutCapabilities export to probe. It was
-- eight hardcoded `true` flags naming tLib releases; only 0.6 ever shipped and it
-- has none of them, so the probe could not distinguish anything reachable. The
-- capabilities it advertised are asserted directly below instead, as behaviour.
check(exports.GetHudLayoutCapabilities == nil,
    'the tLib-version capability probe is gone, not relocated')
local messages = {}
local options = { label = 'Test HUD', width = 200, height = 100,
    defaults = { x = -0.02, y = -0.02, scale = 1, visible = true, anchor = 'bottom-right' } }
check(exports.RegisterHudComponent('test', options, function(data) messages[#messages + 1] = data end))
check(messages[1].phase == 'restore' and messages[1].editing == false)
options.defaults.x = -0.8
check(exports.GetHudLayout('test').x == -0.02, 'Registration must copy defaults')
local copy = exports.GetHudLayout('test'); copy.x = 1
check(exports.GetHudLayout('test').x == -0.02, 'Get must return a copy')
caller = 'beta'
check(exports.GetHudLayout('test') == nil)
check(not exports.UnregisterHudComponent('test'))
caller = nil
check(not exports.RegisterHudComponent('bad', options, function() end))
caller = 'alpha'
focused = true
check(not exports.OpenHudEditor(), 'Other NUI focus prevents editing')
focused = false
check(exports.OpenHudEditor())
check(HudLayout.isEditing() and focused and acquired == 1)
local function latestSession()
    for index = #events, 1, -1 do if events[index].name == 'layoutOpen' then return events[index].data.session end end
end
local session = latestSession()
check(messages[#messages].editing and messages[#messages].phase == 'preview')
local revision = 0
local function request(name, value)
    revision = revision + 1
    if name == 'layoutPreview' and value.revision == nil then value.revision = revision end
    local reply
    requests[name](value, function(result) reply = result end)
    check(reply ~= nil, 'Every request must answer')
    return reply.ok
end
check(not request('layoutPreview', { session = session - 1, key = 'alpha:test', layout = copy }))
local layout = { x = -0.2, y = -0.3, scale = 1.2, visible = false, anchor = 'bottom-right' }
check(request('layoutPreview', { session = session, key = 'alpha:test', layout = layout }))
layout.x = 0.5
check(exports.GetHudLayout('test').x == -0.02 and writes == 0, 'Preview does not commit or alias data')
for _, fn in pairs(timers) do if fn then fn() end end
check(messages[#messages].layout.x == -0.2)
check(request('layoutPreview', { session = session, key = 'alpha:test', layout = copy, revision = 1 }))
for _, fn in pairs(timers) do if fn then fn() end end
check(messages[#messages].layout.x == -0.2, 'Out-of-order preview must not replace the latest draft')
check(not request('layoutPreview', { session = session, key = 'alpha:test', layout = { x = 0/0 } }))
caller = 'beta'
check(not exports.CloseHudEditor(), 'Only the opener can cancel via export')
caller = 'alpha'
check(request('layoutFinish', { session = session, save = true }))
check(not focused and not HudLayout.isEditing() and released == 1)
check(writes == 1 and captured.version == 2 and captured.layouts['alpha:test'].x == -0.2)
check(messages[#messages].phase == 'commit' and not messages[#messages].editing)
check(not request('layoutFinish', { session = session, save = false }), 'Completion only once')
check(exports.OpenHudEditor())
session = latestSession()
check(request('layoutPreview', { session = session, key = 'alpha:test', layout = copy }))
local writer = SetResourceKvp
SetResourceKvp = function() error('test storage failure') end
check(not request('layoutFinish', { session = session, save = true }))
check(focused and HudLayout.isEditing(), 'Storage failure keeps editor open without committing')
SetResourceKvp = writer
check(request('layoutFinish', { session = session, save = false }))
check(exports.GetHudLayout('test').x == -0.2 and writes == 1)
check(messages[#messages].phase == 'rollback' and messages[#messages].layout.x == -0.2)
check(exports.OpenHudEditor())
stops.onClientResourceStop('alpha')
check(not focused and not HudLayout.isEditing())
check(exports.GetHudLayout('test') == nil)
check(exports.OpenHudEditor({ demo = true }))
check(request('layoutReady', { renderer = 'first' }))
check(HudLayout.isEditing(), 'First ready acknowledgement must not cancel a healthy editor')
check(request('layoutReady', { renderer = 'replacement' }))
check(not focused and not HudLayout.isEditing(), 'Renderer replacement rolls back and releases focus')
-- Drive the actual watchdog coroutine, not a reimplementation of its policy.
local function tick(ms)
    now = now + ms
    local ok, err = coroutine.resume(threads[1]); check(ok, err)
end
local function command(action) commands.tlibhud(0, action and { action } or {}) end
ready = false
check(not exports.OpenHudEditor(), 'Cold renderer must not take focus')
ready = true
pendingDialog = true
check(not exports.OpenHudEditor(), 'Pending dialog blocks opening before it takes native focus')
pendingDialog = false
typing = true
check(not exports.OpenHudEditor(), 'Menu typing transition blocks opening')
typing = false
focused = 0
check(exports.OpenHudEditor(), 'Native numeric false must not block opening')
local lostSession, before = latestSession(), focusCalls
focused = false
tick(250)
check(HudLayout.isEditing(), 'One transient unfocused frame does not discard')
focused = 1
tick(250)
check(HudLayout.isEditing(), 'Native numeric true restores healthy state')
focused = false
tick(250)
check(request('layoutHeartbeat', { session = lostSession }))
tick(1500)
check(not HudLayout.isEditing() and focusCalls == before + 1, 'Heartbeat cannot mask focus loss; watchdog only releases, never reacquires')
check(not request('layoutFinish', { session = lostSession, save = true }), 'Late finish cannot commit discarded generation')
command()
check(HudLayout.isEditing() and latestSession() > lostSession, 'Toggle can reopen recovered editor')
local current = latestSession()
check(request('layoutPreview', { session = current, key = 'tLib:demo', layout = copy }))
local queued
for _, fn in pairs(timers) do if fn then queued = fn end end
command()
check(not HudLayout.isEditing() and writes == 1, 'Toggle discards without writing')
command('open')
local newer = latestSession()
if queued then queued() end
check(HudLayout.isEditing() and newer > current, 'Stale preview timer cannot close or replace successor')
check(not request('layoutHeartbeat', { session = current }))
command('cancel')
command('cancel')
check(not HudLayout.isEditing(), 'Emergency cancel is idempotent and never opens')
command('open')
before = focusCalls
pendingDialog = true
tick(250)
check(not HudLayout.isEditing() and focusCalls == before, 'Known local successor is not unlocked by watchdog')
pendingDialog, focused = false, false
command('open')
tick(65001)
check(not HudLayout.isEditing(), 'Dead renderer recovers despite globally focused NUI')
command('open')
local heartSession = latestSession()
tick(30000)
check(request('layoutHeartbeat', { session = heartSession }))
tick(30000)
check(HudLayout.isEditing(), 'Healthy 30s heartbeat maintains editor')
command('cancel')
-- Another resource can own focus while ours is gone. Never issue mode 1 on
-- cancellation, never clear its simulated focus-stack entry, never reopen into it.
local ownFocus, externalFocus = false, false
Platform.setInputMode = function(_, mode) ownFocus = mode == 1; focusCalls = focusCalls + 1 end
IsNuiFocused = function() return ownFocus or externalFocus end
command('open')
externalFocus = true
ownFocus = false
before = focusCalls
command('cancel')
check(externalFocus and not ownFocus and focusCalls == before + 1, 'Cancel drops only tLib focus-stack entry')
check(not exports.OpenHudEditor(), 'External focus blocks reopening')
externalFocus = false
check(exports.OpenHudEditor())
for _, fn in ipairs(shutdowns) do fn() end
check(not exports.OpenHudEditor(), 'Shutdown cannot resurrect editor')
check(not focused and not HudLayout.isEditing() and acquired == released)
GetResourceKvpString = function() return 'saved-test-payload' end
json.decode = function() return captured end
dofile('client/cl_layout.lua')
HudLayout.init({})
check(exports.RegisterHudComponent('test', options, function() end))
check(exports.GetHudLayout('test').x == -0.2, 'Committed layout survives a new library instance')
-- Opt-in consumer persistence must neither restore nor retain an older tLib
-- record. The preceding instance left alpha:test persisted at x=-0.2.
local consumerMessages = {}
local consumerOptions = { label = 'Consumer HUD', width = 200, height = 100, persist = false,
    defaults = { x = -0.4, y = -0.1, scale = 1, visible = true, anchor = 'bottom-right' } }
local consumerCallback = function(data) consumerMessages[#consumerMessages + 1] = data end
local beforeConsumerWrites = writes
consumerOptions.persist = 'false'
check(not exports.RegisterHudComponent('test', consumerOptions, consumerCallback), 'Persistence option must be boolean')
check(exports.GetHudLayout('test').x == -0.2, 'Rejected replacement must preserve saved state')
consumerOptions.persist = false
check(exports.RegisterHudComponent('test', consumerOptions, consumerCallback))
check(writes == beforeConsumerWrites, 'Registration must not write storage')
check(consumerMessages[#consumerMessages].phase == 'restore'
    and consumerMessages[#consumerMessages].layout.x == -0.4, 'Consumer defaults override stale tLib record')
consumerOptions.defaults.x = -0.6
check(exports.GetHudLayout('test').x == -0.4, 'Consumer defaults are copied')
local consumerDraft = { x = -0.7, y = -0.1, scale = 1.1, visible = true, anchor = 'bottom-right' }
check(exports.OpenHudEditor())
session = latestSession()
check(not exports.RegisterHudComponent('test', consumerOptions, consumerCallback), 'Consumer registration still respects transaction lock')
check(request('layoutPreview', { session = session, key = 'alpha:test', layout = consumerDraft }))
for _, fn in pairs(timers) do if fn then fn() end end
check(consumerMessages[#consumerMessages].phase == 'preview' and consumerMessages[#consumerMessages].editing
    and consumerMessages[#consumerMessages].layout.x == -0.7, 'Consumer receives preview normally')
check(exports.GetHudLayout('test').x == -0.4, 'Consumer preview does not change committed state')
check(exports.CloseHudEditor())
check(writes == beforeConsumerWrites, 'Discard does not write or clean up on disk')
check(consumerMessages[#consumerMessages].phase == 'rollback' and not consumerMessages[#consumerMessages].editing
    and consumerMessages[#consumerMessages].layout.x == -0.4, 'Consumer rollback restores supplied state')
check(exports.OpenHudEditor())
session = latestSession()
check(request('layoutPreview', { session = session, key = 'alpha:test', layout = consumerDraft }))
SetResourceKvp = function() error('test storage failure with consumer component') end
check(not request('layoutFinish', { session = session, save = true }))
check(HudLayout.isEditing() and exports.GetHudLayout('test').x == -0.4,
    'Consumer commit also waits for shared transaction storage success')
SetResourceKvp = writer
check(request('layoutFinish', { session = session, save = true }))
check(captured.layouts['alpha:test'] == nil, 'Consumer draft and stale retained record must both be excluded')
check(captured.layouts['tLib:toasts'] ~= nil, 'Default component persistence remains enabled')
check(consumerMessages[#consumerMessages].phase == 'commit' and not consumerMessages[#consumerMessages].editing
    and consumerMessages[#consumerMessages].layout.x == -0.7, 'Consumer receives commit for its own persistence')
check(exports.GetHudLayout('test').x == -0.7, 'Consumer committed layout remains available for this registration')
check(exports.RegisterHudComponent('test', consumerOptions, consumerCallback))
check(exports.GetHudLayout('test').x == -0.6, 'Re-registration reads fresh consumer-owned defaults')

-- A successful save with the consumer unregistered must not retain its retired
-- record. Exercise both unspecified (default) and explicitly enabled persistence.
consumerOptions.persist = true
check(exports.RegisterHudComponent('retired', consumerOptions, function() end))
check(exports.OpenHudEditor())
check(request('layoutFinish', { session = latestSession(), save = true }))
check(captured.layouts['alpha:retired'].x == -0.6, 'Explicit true persists normally')
consumerOptions.persist = false
check(exports.RegisterHudComponent('retired', consumerOptions, function() end))
check(exports.UnregisterHudComponent('retired'))
check(exports.OpenHudEditor())
check(request('layoutFinish', { session = latestSession(), save = true }))
check(captured.layouts['alpha:retired'] == nil, 'Unregister before Finish must not resurrect stale saved state')
check(exports.UnregisterHudComponent('test'))
dofile('client/cl_layout.lua')
HudLayout.init({})
consumerOptions.defaults.x = -0.9
consumerOptions.persist = true
check(exports.RegisterHudComponent('test', consumerOptions, function() end))
check(exports.GetHudLayout('test').x == -0.9, 'Retired consumer record stays absent after restart and opt-in')
check(exports.RegisterHudComponent('retired', consumerOptions, function() end))
check(exports.GetHudLayout('retired').x == -0.9, 'Unregistered retired record stays absent after restart')
local constrainedOptions = { label = 'Radio bounds', width = 630, height = 440,
    minVisiblePixels = 100, minVisibleFraction = 0.35, persist = false,
    defaults = { x = 0, y = 0, scale = 1, visible = true, anchor = 'top-left' } }
local boundsMessages = {}
check(exports.RegisterHudComponent('bounds', constrainedOptions, function(data) boundsMessages[#boundsMessages + 1] = data end))
check(exports.OpenHudEditor())
session = latestSession()
local edge = { x = 4, y = 4, scale = 1, visible = true, anchor = 'top-left' }
local resolution = GetActiveScreenResolution
GetActiveScreenResolution = nil
check(not request('layoutPreview', { session = session, key = 'alpha:bounds', layout = edge }),
    'With no viewport from the editor and none from the game, placement is refused rather than guessed at 1080p')
GetActiveScreenResolution = resolution
check(request('layoutPreview', { session = session, key = 'alpha:bounds', layout = edge }),
    'The game resolution stands in when the editor supplies no viewport')
check(request('layoutPreview', { session = session, key = 'alpha:bounds', layout = edge, viewport = { width = 1920, height = 1080 } }))
for _, fn in pairs(timers) do if fn then fn() end end
local bounded = boundsMessages[#boundsMessages].layout
-- Offsets are reference pixels over 1080 on both axes for a non-centre anchor.
check(math.abs(bounded.x * 1080 - (1920 - 630 * 0.35)) < 1e-8, 'Lua enforces radio fractional width bound')
check(math.abs(bounded.y * 1080 - (1080 - 440 * 0.35)) < 1e-8, 'Lua enforces radio fractional height bound')
check(exports.CloseHudEditor())
local schemaComponent = HudLayoutSchema.component('alpha', 'bounds', constrainedOptions)
for _, vp in ipairs({ { width = 1920, height = 1080 }, { width = 1280, height = 720 }, { width = 3440, height = 1440 } }) do
    for _, anchor in ipairs({ 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center' }) do
        for _, scale in ipairs({ 0.5, 1, 1.5 }) do
            for _, direction in ipairs({ -1, 1 }) do
                local value = HudLayoutSchema.constrain({ x = direction * 4, y = -direction * 4, scale = scale, visible = true, anchor = anchor }, schemaComponent, vp)
                local px = anchor == 'center' and 0.5 or (anchor:find('right') and 1 or 0)
                local py = anchor == 'center' and 0.5 or (anchor:find('bottom') and 1 or 0)
                local w, h = 630 * scale * vp.height / 1080, 440 * scale * vp.height / 1080
                local unitX = anchor == 'center' and vp.width or vp.height
                local left, top = px * (vp.width - w) + value.x * unitX, py * (vp.height - h) + value.y * vp.height
                check(math.min(vp.width, left + w) - math.max(0, left) + 1e-8 >= math.min(w, vp.width, math.max(100, w * 0.35)))
                check(math.min(vp.height, top + h) - math.max(0, top) + 1e-8 >= math.min(h, vp.height, math.max(100, h * 0.35)))
            end
        end
    end
end
constrainedOptions.minVisiblePixels = -1
check(not exports.RegisterHudComponent('invalidBounds', constrainedOptions, function() end))
constrainedOptions.minVisiblePixels, constrainedOptions.minVisibleFraction = 100, 1.1
check(not exports.RegisterHudComponent('invalidBounds', constrainedOptions, function() end))
-- Recovery: reset must work from ANY stored state
--
-- The unrecoverable-HUD bug. A consumer that owns its own storage (persist =
-- false) used to have only one slot to put a placement in, so it passed its
-- SAVED position as `defaults` -- and "Reset this" then restored the very
-- placement the player was trying to escape. `layout` is now where the widget
-- is and `defaults` is where Reset puts it back, and they are validated
-- independently so garbage in either falls through instead of being trusted.
caller = 'alpha'
for _, key in ipairs({ 'test', 'bounds', 'toasts' }) do exports.UnregisterHudComponent(key) end
local resetMessages = {}
local FACTORY = { x = -0.05, y = -0.05, scale = 1, visible = true, anchor = 'bottom-right' }
local CURRENT = { x = -0.9, y = -0.3, scale = 1, visible = true, anchor = 'bottom-right' }
local consumerOptions = { label = 'Consumer owned', width = 300, height = 400, persist = false,
    defaults = FACTORY, layout = CURRENT }
check(exports.RegisterHudComponent('owned', consumerOptions, function(data) resetMessages[#resetMessages + 1] = data end))
check(exports.GetHudLayout('owned').x == -0.9,
    'A consumer-owned component starts from `layout`, not from the factory `defaults`')
check(exports.GetHudLayout('owned').x ~= FACTORY.x, 'MUTATION GUARD: the two placements must actually differ')
local resetCount = exports.ResetHudLayout('owned')
check(resetCount == 1, 'ResetHudLayout reports how many components it restored')
check(exports.GetHudLayout('owned').x == FACTORY.x and exports.GetHudLayout('owned').y == FACTORY.y,
    'Reset restores the FACTORY placement, never the stored one')
check(resetMessages[#resetMessages].phase == 'commit' and resetMessages[#resetMessages].editing == false,
    'Reset tells a consumer that owns its storage to write the factory placement down')

-- Garbage in `layout` falls through to `defaults` rather than poisoning anything.
-- One case per way a record can rot: an older version's missing field, NaN, a
-- value past the schema bound, a negative scale, and an anchor that no longer exists.
local garbage = {
    { y = -0.05, scale = 1, visible = true, anchor = 'bottom-right' },          -- missing x
    { x = 0/0, y = -0.05, scale = 1, visible = true, anchor = 'bottom-right' }, -- NaN
    { x = -99, y = -0.05, scale = 1, visible = true, anchor = 'bottom-right' }, -- past MAX_OFFSET
    { x = -0.05, y = -0.05, scale = -3, visible = true, anchor = 'bottom-right' },
    { x = -0.05, y = -0.05, scale = 1, visible = true, anchor = 'middle-out' },
    { x = -0.05, y = -0.05, scale = 1, visible = 'yes', anchor = 'bottom-right' },
    'not even a table',
}
for index, bad in ipairs(garbage) do
    exports.UnregisterHudComponent('owned')
    consumerOptions.layout = bad
    check(exports.RegisterHudComponent('owned', consumerOptions, function() end),
        ('Stored garbage #%d must not stop the component registering'):format(index))
    local restored = exports.GetHudLayout('owned')
    check(restored.x == FACTORY.x and restored.y == FACTORY.y and restored.scale == FACTORY.scale
        and restored.visible == true and restored.anchor == FACTORY.anchor,
        ('Stored garbage #%d falls through to the factory default'):format(index))
end
-- A component whose FACTORY default is itself garbage is refused outright, which
-- is what makes "reset always lands somewhere sane" true by construction.
consumerOptions.layout = CURRENT
consumerOptions.defaults = { x = 0/0, y = 0, scale = 1, visible = true, anchor = 'bottom-right' }
exports.UnregisterHudComponent('owned')
check(not exports.RegisterHudComponent('owned', consumerOptions, function() end),
    'An unusable factory default is refused at registration, not discovered at Reset')
consumerOptions.defaults = FACTORY

-- Clamp on load
-- A record written at another resolution, or by a version with the wrong units,
-- heals on the way IN. The tool for rescuing a lost widget is the one you cannot
-- see to open, so it must never be needed for this case.
exports.UnregisterHudComponent('owned')
consumerOptions.layout = { x = -4, y = -4, scale = 1, visible = true, anchor = 'bottom-right' }
check(exports.RegisterHudComponent('owned', consumerOptions, function() end))
local healed = exports.GetHudLayout('owned')
check(healed.x > -4, 'MUTATION GUARD: an off-screen record must actually have been moved on load')
do
    -- GetActiveScreenResolution is 1920x1080 in this harness.
    local vw, vh = 1920, 1080
    local w, h = 300 * healed.scale, 400 * healed.scale
    local left, top = (vw - w) + healed.x * vh, (vh - h) + healed.y * vh
    local needX = math.min(w, vw, math.max(96, w * 0.4))
    local needY = math.min(h, vh, math.max(96, h * 0.4))
    check(math.min(vw, left + w) - math.max(0, left) + 1e-8 >= needX,
        'A healed record keeps the minimum visible width on screen')
    check(math.min(vh, top + h) - math.max(0, top) + 1e-8 >= needY,
        'A healed record keeps the minimum visible height on screen')
end

-- The unbrick command
-- /tlibhud reset has to work with the editor shut, with the editor open, and
-- with every widget dragged somewhere the player cannot reach.
consumerOptions.layout = CURRENT
exports.UnregisterHudComponent('owned')
check(exports.RegisterHudComponent('owned', consumerOptions, function() end))
local persisted = { label = 'Persisted', width = 200, height = 100,
    defaults = { x = 0.02, y = 0.02, scale = 1, visible = true, anchor = 'top-left' } }
check(exports.RegisterHudComponent('kept', persisted, function() end))
check(exports.OpenHudEditor())
check(HudLayout.isEditing(), 'MUTATION GUARD: the editor really is open before the reset')
local writesBefore = writes
commands.tlibhud(nil, { 'reset' })
check(not HudLayout.isEditing(), 'reset discards an open session rather than fighting it')
check(exports.GetHudLayout('owned').x == FACTORY.x, 'reset restores every registered component')
check(writes > writesBefore and next(captured.layouts) == nil,
    'reset clears the stored layout table, including records for resources that are not running')
check(exports.ResetHudLayout() >= 2, 'The export with no id resets everything')
-- A reset whose KVP write fails looks fixed and comes back broken on the next load.
-- That is the one outcome the player must not be told was a success: the command
-- used to print "cleared the saved layout" whatever SetResourceKvp did.
do
    local realWrite = SetResourceKvp
    SetResourceKvp = function() error('disk full') end
    local before = #logLines
    local count, stored = HudLayout.resetAll()
    SetResourceKvp = realWrite
    check(count >= 2 and stored == false, 'resetAll reports the write that did not land')
    local said = table.concat(logLines, '\n', before + 1)
    check(said:find('could NOT be cleared') == nil, 'resetAll itself stays quiet; the command reports')
    before = #logLines
    SetResourceKvp = function() error('disk full') end
    commands.tlibhud(nil, { 'reset' })
    SetResourceKvp = realWrite
    said = table.concat(logLines, '\n', before + 1)
    check(said:find('could NOT be cleared') ~= nil,
        '/tlibhud reset says the saved layout survived instead of claiming it was cleared')
    check(said:find('cleared the saved layout') == nil, 'and does not also claim success')
    check(select('#', exports.ResetHudLayout()) == 1, 'the export still answers with exactly a count')
end
exports.UnregisterHudComponent('owned')
exports.UnregisterHudComponent('kept')


-- Live placement: dragging a device by its own background
-- SetHudLayout has to be the editor's Save for one component and nothing
-- looser, because a position a player produced by dragging their remote has to
-- be exactly as recoverable as one produced in the editor.
check(type(exports.SetHudLayout) == 'function', 'live placement is an export, not a capability flag')
local liveMessages = {}
local live = { label = 'Live', width = 220, height = 488,
    defaults = { x = -600 / 1080, y = -40 / 1080, scale = 1, visible = true, anchor = 'bottom-right' } }
check(exports.RegisterHudComponent('live', live, function(data) liveMessages[#liveMessages + 1] = data end))
local DRAGGED = { x = -0.3, y = -0.1, scale = 1, visible = true, anchor = 'bottom-right' }

check(select(1, exports.SetHudLayout('nope', DRAGGED)) == false, 'An unknown component is refused')
check(select(1, exports.SetHudLayout('live', 'not a table')) == false, 'A non-table layout is refused')
check(select(1, exports.SetHudLayout('live', { x = 0, y = 0, scale = 1, visible = true, anchor = 'sideways' })) == false,
    'An invalid anchor is refused')
check(select(1, exports.SetHudLayout('live', { x = 99, y = 0, scale = 1, visible = true, anchor = 'center' })) == false,
    'An out-of-range offset is refused, not clamped into acceptance')
caller = nil
check(select(1, exports.SetHudLayout('live', DRAGGED)) == false, 'An unidentifiable caller is refused')
caller = 'beta'
check(select(1, exports.SetHudLayout('live', DRAGGED)) == false, 'Another resource cannot place this component')
caller = 'alpha'

local before = writes
check(exports.SetHudLayout('live', DRAGGED) == true, 'A valid live placement is accepted')
check(writes == before + 1, 'It writes the SAME KVP record the editor Save writes')
check(captured.version == 2 and captured.layouts['alpha:live'].x == DRAGGED.x,
    'The dragged position is in the stored table under the component key')
check(exports.GetHudLayout('live').x == DRAGGED.x, 'The component now reports the dragged position')
check(liveMessages[#liveMessages].phase == 'commit' and liveMessages[#liveMessages].editing == false,
    "It is announced as 'commit', so a consumer with its own store writes it down too")

-- Healing is not optional on this path either: a position that would strand the
-- device off screen comes back on screen instead of being stored as given.
check(exports.SetHudLayout('live', { x = -3.9, y = 3.9, scale = 1, visible = true, anchor = 'top-left' }) == true)
local healed = exports.GetHudLayout('live')
check(healed.x > -3.9 and healed.y < 3.9, 'A live placement is healed against the live resolution')
check(HudLayoutSchema.constrain(healed, { width = 220, height = 488 }, { width = 1920, height = 1080 }).x == healed.x,
    'What was stored is a placement the shared clamp already agrees with')

-- An open editor is a transaction over every component; a live write inside one
-- would be discarded by Cancel without telling anybody.
check(exports.OpenHudEditor())
check(select(1, exports.SetHudLayout('live', DRAGGED)) == false, 'Refused while the editor is open')
HudLayout.close()
check(exports.SetHudLayout('live', DRAGGED) == true, 'Accepted again once the editor is shut')

-- Reset is still the safety net for a position produced this way.
check(exports.ResetHudLayout('live') == 1)
check(exports.GetHudLayout('live').x == live.defaults.x, 'Reset recovers a dragged position')
check(captured.layouts['alpha:live'] == nil, 'Reset clears the dragged record from storage')
exports.UnregisterHudComponent('live')

print(('PASS: %d shared HUD layout ownership, transaction, validation and cleanup checks'):format(checks))
