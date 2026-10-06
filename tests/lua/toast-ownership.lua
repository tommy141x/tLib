local exports, events, timers, stops, shutdowns = {}, {}, {}, {}, {}
local caller = 'alpha'
Logger = { create = function() return function() end end }
Platform = {
    export = function(_, name, fn) exports[name] = fn end,
    getInvokingResource = function() return caller end,
    sendUIEvent = function(_, name, data) events[#events + 1] = { name = name, data = data } end,
    TriggerEvent = function() end,
    setTimeout = function(fn, delay)
        timers[#timers + 1] = { fn = fn, delay = delay }
        return #timers
    end,
    clearTimeout = function(id) timers[id].cleared = true end,
    onShutdown = function(fn) shutdowns[#shutdowns + 1] = fn end,
}
AddEventHandler = function(name, fn) stops[name] = fn end
dofile('client/lib/toast/exports.lua')
ToastExports.register({})
local checks = 0
local function check(value, message) checks = checks + 1; assert(value, message) end
local function last() return events[#events] end
check(exports.ShowToast('same', 'loading', 'Alpha') == 'same')
local alphaKey = last().data.id
check(#timers == 0, 'Loading is persistent')
caller = 'beta'
check(not exports.UpdateToast('same', { title = 'Stolen' }))
check(not exports.DismissToast('same'))
check(exports.ShowToast('same', 'loading', 'Beta') == 'same')
local betaKey = last().data.id
check(alphaKey ~= betaKey, 'Same producer-local IDs must not collide')
check(exports.DismissAll())
check(last().data.id == betaKey and last().name == 'dismissToast')
caller = 'alpha'
check(exports.UpdateToast('same', { title = 'Still here' }), 'Other owner bulk dismiss preserves alpha')
check(last().data.id == alphaKey)
check(exports.UpdateToast('same', { type = 'success' }))
check(timers[#timers].delay == 4000)
local successTimer = timers[#timers]
check(exports.UpdateToast('same', { duration = 0 }))
check(last().data.changes.duration == 0, 'Zero duration reaches renderer')
check(successTimer.cleared and timers[#timers].delay == 4000)
successTimer.fn()
check(exports.UpdateToast('same', { description = 'Not expired by stale timer' }))
local deadline = #timers
check(exports.UpdateToast('same', { theme = 'neutral' }))
check(#timers == deadline, 'Text/theme patches retain deadline')
check(not exports.UpdateToast('same', { duration = 0/0 }))
check(not exports.UpdateToast('same', { duration = math.huge }))
check(not exports.UpdateToast('same', { duration = -1 }))
local latestTimer = timers[#timers]
check(exports.ShowToast('same', 'loading', 'Replacement') == 'same')
check(latestTimer.cleared)
latestTimer.fn()
check(exports.UpdateToast('same', { title = 'Replacement survived' }))
check(exports.UpdateToast('same', { type = 'warning', duration = 23 }))
check(timers[#timers].delay == 23)
timers[#timers].fn()
check(not exports.UpdateToast('same', { title = 'Expired' }))
check(last().name == 'dismissToast' and last().data.id == alphaKey)
-- The short spellings. `warn` and `err` are what three consumers actually pass
-- (the copy-pasted "Sound Overwritten" notice in tDetector, tRadio and tRadar),
-- and before resolveType mapped them each one fell through to info -- neutral at
-- 4000ms where it had asked for amber at 5000ms. Asserted on BOTH the wire type
-- and the scheduled delay, because the delay alone was already right for `info`
-- and the type alone does not prove the deadline followed it.
check(exports.ShowToast('short-warn', 'warn', 'Aliased') == 'short-warn')
check(last().data.type == 'warning', 'warn maps to warning on the wire')
check(timers[#timers].delay == 5000, 'warn gets warning\'s 5000ms deadline')
check(exports.ShowToast('short-err', 'err', 'Aliased') == 'short-err')
check(last().data.type == 'error', 'err maps to error on the wire')
check(timers[#timers].delay == 6000, 'err gets error\'s 6000ms deadline')
-- A genuine typo is still a typo: it must NOT be mapped to anything, so the
-- aliases cannot quietly become "whatever the caller said".
check(exports.ShowToast('short-bogus', 'warnign', 'Typo') == 'short-bogus')
check(last().data.type == 'info', 'an unknown type still falls back to info')
check(timers[#timers].delay == 4000)
-- UpdateToast shares resolveType, so the alias has to reach it too.
check(exports.UpdateToast('short-bogus', { type = 'warn' }))
check(last().data.changes.type == 'warning', 'UpdateToast resolves the alias too')
check(timers[#timers].delay == 5000)
check(exports.DismissToast('short-warn') and exports.DismissToast('short-err'))
check(exports.DismissToast('short-bogus'))

check(exports.ShowToast('stopping', 'loading', 'Stop cleanup'))
local stoppingKey = last().data.id
stops.onClientResourceStop('alpha')
check(last().name == 'dismissToast' and last().data.id == stoppingKey)
check(not exports.DismissToast('stopping'))
caller = nil
check(exports.ShowToast('unverified', 'info', 'No') == nil)
check(not exports.DismissAll())
caller = 'alpha'
for i = 1, 32 do check(exports.ShowToast('bound' .. i, 'loading', 'Bound')) end
check(exports.ShowToast('overflow', 'loading', 'Bound') == nil)
check(exports.ShowToast('bound1', 'loading', 'Replacement at capacity'))
check(exports.DismissAll())
check(exports.ShowToast(nil, 'info', 'Generated', nil, 0))
check(timers[#timers].delay == 4000)
local shutdownTimer = timers[#timers]
shutdowns[1]()
check(shutdownTimer.cleared and last().name == 'dismissAllToasts')
shutdownTimer.fn()
check(exports.ShowToast(nil, 'info', 'After shutdown') == nil)
check(not exports.UpdateToast('bound1', { title = 'After shutdown' }))
print(('PASS: %d toast ownership, deadlines, bounds and lifecycle checks'):format(checks))
