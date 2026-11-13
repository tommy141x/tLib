--[[
    tLib/shared/imports/nui -- an NUI callback that always answers.

        tlib.nui.register('saveLayout', function(data, reply)
            saveLayout(data)
            reply({ ok = true })
        end)

    cfx's RegisterNUICallback pcalls the handler and prints a throw, but never
    calls its `cb`, so the page's fetch hangs to its deadline and the F8 line is
    `callback "X" did not answer within 10000ms`. This wrapper owns the `cb`.
]]

local Nui = {}

local RESOURCE = GetCurrentResourceName()

-- Under the 10 s deadline in shared/ts/nui.ts, so a handler that blocks is
-- answered here instead of by the page giving up.
local DEFAULT_TIMEOUT_MS = 8000
local WATCHDOG_POLL_MS = 250
-- One distinct failure is one line; a message carrying a changing value must not
-- be able to fill memory or the console.
local MAX_DISTINCT_FAILURES = 64
local MAX_DETAIL = 200

Nui.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

--- name -> { handler, deferred, timeoutMs }
local registered = {}

--- name \0 kind \0 message -> { name, kind, message, count }
local failures = {}
local failureCount = 0
local suppressedNoted = false

--- in-flight call -> true. Only calls whose handler has not answered live here.
local pending = {}
local watchdogRunning = false

local function clip(text)
    text = tostring(text)
    if #text > MAX_DETAIL then return text:sub(1, MAX_DETAIL) .. '...' end
    return text
end

--- Counts every failure and prints the first of each distinct (name, kind, message).
local function noteFailure(name, kind, message, line)
    local key = name .. '\0' .. kind .. '\0' .. message
    local entry = failures[key]
    if entry then
        entry.count = entry.count + 1
        return
    end
    if failureCount >= MAX_DISTINCT_FAILURES then
        if not suppressedNoted then
            suppressedNoted = true
            print(('^1[%s] tlib.nui: %d distinct callback failures already reported; '
                .. 'further new ones are counted in tlib.nui.failures() but not printed.^7')
                :format(RESOURCE, MAX_DISTINCT_FAILURES))
        end
        return
    end
    failureCount = failureCount + 1
    failures[key] = { name = name, kind = kind, message = message, count = 1 }
    print(line)
end

--- Every distinct failure so far, for a diagnostics line.
--- @return table[] { name, kind ('threw'|'timeout'|'late'), message, count }
function Nui.failures()
    local out = {}
    for _, entry in pairs(failures) do
        out[#out + 1] = { name = entry.name, kind = entry.kind, message = entry.message, count = entry.count }
    end
    table.sort(out, function(a, b)
        if a.name ~= b.name then return a.name < b.name end
        if a.kind ~= b.kind then return a.kind < b.kind end
        return a.message < b.message
    end)
    return out
end

local function capture(err)
    local trace = debug and debug.traceback and debug.traceback('', 2) or ''
    return { message = tostring(err), trace = trace }
end

local function startWatchdog()
    if watchdogRunning then return end
    watchdogRunning = true
    Citizen.CreateThread(function()
        while next(pending) do
            Citizen.Wait(WATCHDOG_POLL_MS)
            local now = GetGameTimer()
            for call in pairs(pending) do
                if now >= call.deadline then
                    call.timedOut = true
                    noteFailure(call.name, 'timeout', tostring(call.timeoutMs), ('^1[%s] tlib.nui: callback "%s" did '
                        .. 'not answer within %dms. The page was answered { ok = false, error = "timeout" } instead '
                        .. 'of hanging. Answer first and do slow work afterwards, or raise timeoutMs.^7')
                        :format(RESOURCE, call.name, call.timeoutMs))
                    call.answer({ ok = false, error = 'timeout',
                        detail = ('callback "%s" did not answer within %dms'):format(call.name, call.timeoutMs) })
                end
            end
        end
        watchdogRunning = false
    end)
end

local function dispatch(name, entry, body, resultCallback, ...)
    local call = {
        name = name,
        timeoutMs = entry.timeoutMs,
        deadline = GetGameTimer() + entry.timeoutMs,
    }

    -- Fire-once: CitizenFX treats a second resultCallback as an error.
    function call.answer(...)
        if call.answered then return false end
        call.answered = true
        pending[call] = nil
        resultCallback(...)
        return true
    end

    local function reply(...)
        if not call.answer(...) and call.timedOut and not call.lateNoted then
            call.lateNoted = true
            noteFailure(name, 'late', tostring(call.timeoutMs), ('^1[%s] tlib.nui: callback "%s" answered after its '
                .. '%dms bound, so the page had already been told "timeout". Its handler is blocking '
                .. 'for too long.^7'):format(RESOURCE, name, call.timeoutMs))
        end
    end

    pending[call] = true
    startWatchdog()

    local ok, result = xpcall(entry.handler, capture, body, reply, ...)
    if not ok then
        noteFailure(name, 'threw', result.message, ('^1[%s] tlib.nui: callback "%s" threw: %s\n%s\nThe page was '
            .. 'answered { ok = false, error = "handler_error" } instead of hanging. Reported once per '
            .. 'distinct error.^7'):format(RESOURCE, name, result.message, result.trace))
        call.answer({ ok = false, error = 'handler_error', detail = clip(result.message) })
        return
    end

    if result == nil and entry.deferred then return end
    reply(result == nil and { ok = true } or result)
end

--- Register an NUI callback that is guaranteed an answer.
---
--- `handler(data, reply)` answers by calling `reply(value)` (once; later calls
--- are ignored), or by RETURNING a value. A handler that finishes without
--- either is answered `{ ok = true }`. A handler that throws is answered
--- `{ ok = false, error = 'handler_error', detail = <message> }` and the error
--- is printed once per distinct message. One that has not answered after
--- `timeoutMs` is answered `{ ok = false, error = 'timeout' }`.
---
--- `opts.deferred = true` is for a handler that returns BEFORE it answers
--- (it hands `reply` to an event or a timer): returning no longer answers, and
--- only `reply` or the timeout does.
---
--- Registering a name twice replaces the first handler; the NUI page has one
--- answer per request, so two handlers could only race to give it.
---
--- @param name string
--- @param handler fun(data: any, reply: fun(value: any))
--- @param opts { deferred?: boolean, timeoutMs?: number }|nil
function Nui.register(name, handler, opts)
    assert(type(name) == 'string' and name ~= '', 'tlib.nui.register: name must be a non-empty string')
    assert(type(handler) == 'function', 'tlib.nui.register: handler must be a function')
    opts = opts or {}
    assert(opts.timeoutMs == nil or (type(opts.timeoutMs) == 'number' and opts.timeoutMs > 0),
        'tlib.nui.register: timeoutMs must be a positive number')

    local entry = {
        handler = handler,
        deferred = opts.deferred == true,
        timeoutMs = opts.timeoutMs or DEFAULT_TIMEOUT_MS,
    }

    local existing = registered[name]
    registered[name] = entry
    if existing then
        print(('^3[%s] tlib.nui.register: "%s" was already registered; the new handler replaces it.^7')
            :format(RESOURCE, name))
        return
    end

    RegisterNuiCallbackType(name)
    AddEventHandler('__cfx_nui:' .. name, function(body, resultCallback, ...)
        dispatch(name, registered[name], body, resultCallback, ...)
    end)
end

return Nui
