-- tLib/lua/adapter/core.lua
-- Core platform abstractions: threading, timing, events, WebUI, exports,
-- and shutdown hooks.
--
-- Depends on: lua/adapter/init.lua  (_TLIB_IS_HELIX / _TLIB_IS_FIVEM / Platform)
--
-- Surfaces provided:
--
--   Threading
--     Platform.createThread(fn)
--     Platform.wait(ms)
--
--   Timing
--     Platform.setInterval(fn, ms)  → handle
--     Platform.clearInterval(handle)
--     Platform.setTimeout(fn, ms)   → handle
--     Platform.clearTimeout(handle)
--
--   WebUI / NUI
--     Platform.createUI(name, path) → ui handle
--     Platform.sendUIEvent(ui, evt, data)
--     Platform.onUIEvent(ui, evt, cb)
--     Platform.bringUIToFront(ui)
--     Platform.setInputMode(ui, mode)   0=game  1=ui-only
--     Platform.destroyUI(ui)
--
--   Events
--     Platform.TriggerEvent(name, ...)
--     Platform.AddEventHandler(name, cb)
--     Platform.TriggerServerEvent(name, ...)
--     Platform.TriggerClientEvent(name, target, ...)  -- server → client
--
--   NOTE: Platform.onServerEvent and Platform.onClientEvent have been removed.
--   On FiveM both sides use AddEventHandler for local listeners, so
--   Platform.AddEventHandler covers all cases.  The old names are kept as
--   aliases below for backward compatibility.
--
--   Exports
--     Platform.export(resource, name, fn)
--       Helix: passes resource explicitly.
--       FiveM: resource is ignored; FiveM infers it from the manifest.
--
--     NOTE: *calling* exports from other resources is identical on both
--     platforms — use exports['resource']:Method(...) directly everywhere.
--     No Platform wrapper is needed or provided for that direction.
--
--   Callbacks (shim support)
--     Platform.storeCallback(fn)
--       On Helix: stores fn in tLib's internal callback table and returns a
--       __tLibCb_ key string.  Use this when an export needs to RETURN a
--       callable to the consumer — the key string crosses the VM boundary
--       safely, and tLibShim.lua's unsanitiseReturn (Case 1) wraps it back
--       into a real callable in the consumer VM.
--       On FiveM: returns fn unchanged — functions cross the boundary natively
--       so no key is needed.
--       When Helix natively supports functions across export boundaries, change
--       the Helix branch to also return fn unchanged, then delete the shims.
--
--     Platform.invokeCallback (REMOVED — kept as no-op for backward compat)
--       Export handlers now receive real callables via Platform.wrapExport's
--       unwrapping middleware and call them directly.  Platform.invokeCallback
--       compiles and runs without error but does nothing.
--
--   Shutdown
--     Platform.onShutdown(cb)

local log = Logger.create('tLib/adapter/core')

-- ── Threading ─────────────────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.createThread(fn)
        Timer.CreateThread(fn)
    end

    function Platform.wait(ms)
        Timer.Wait(ms)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.createThread(fn)
        Citizen.CreateThread(fn)
    end

    function Platform.wait(ms)
        Citizen.Wait(ms)
    end
else
    Platform.createThread = Platform._stub('createThread')
    Platform.wait         = Platform._stub('wait')
end

-- ── Timing ────────────────────────────────────────────────────────────────────
-- Built on top of Platform.createThread / Platform.wait so no further
-- branching is needed here.

local _timerHandles = {}
local _timerNext    = 0

local function _nextHandle()
    _timerNext = _timerNext + 1
    return _timerNext
end

function Platform.setInterval(fn, ms)
    local handle = _nextHandle()
    _timerHandles[handle] = true
    Platform.createThread(function()
        while _timerHandles[handle] do
            Platform.wait(ms)
            if _timerHandles[handle] then
                fn()
            end
        end
    end)
    return handle
end

function Platform.clearInterval(handle)
    _timerHandles[handle] = nil
end

function Platform.setTimeout(fn, ms)
    local handle = _nextHandle()
    _timerHandles[handle] = true
    Platform.createThread(function()
        Platform.wait(ms)
        if _timerHandles[handle] then
            _timerHandles[handle] = nil
            fn()
        end
    end)
    return handle
end

function Platform.clearTimeout(handle)
    _timerHandles[handle] = nil
end

-- ── WebUI / NUI ────────────────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.createUI(name, path)
        return WebUI(name, path)
    end

    function Platform.sendUIEvent(ui, evt, data)
        if ui then ui:SendEvent(evt, data) end
    end

    function Platform.onUIEvent(ui, evt, cb)
        if ui then ui:RegisterEventHandler(evt, cb) end
    end

    function Platform.bringUIToFront(ui)
        if ui then ui:BringToFront() end
    end

    function Platform.setInputMode(ui, mode)
        _tLibUIFocused = (mode == 1)
        if ui then ui:SetInputMode(mode) end
    end

    function Platform.destroyUI(ui)
        if ui then ui:Destroy() end
    end
elseif _TLIB_IS_FIVEM then
    -- FiveM NUI is global — there is no per-instance handle like Helix's WebUI.
    -- The HTML page is declared in fxmanifest.lua via ui_page; nothing to
    -- construct at runtime.  We return a sentinel table so call-sites can still
    -- do a nil-check without branching on platform.
    function Platform.createUI(name, path)
        return { _fivemNUI = true, name = name, path = path }
    end

    function Platform.sendUIEvent(ui, evt, data)
        -- The JS side (helix.ts useHelixEvent) listens via
        -- window.addEventListener('message', ...) and expects:
        --   event.data = { name: string, args: [payload] }
        -- We must NOT flatten data into the top-level object — wrap it in args[1].
        SendNUIMessage({ name = evt, args = { data } })
    end

    function Platform.onUIEvent(ui, evt, cb)
        RegisterNuiCallbackType(evt)
        AddEventHandler('__cfx_nui:' .. evt, function(body, resultCallback)
            local data = type(body) == 'string' and json.decode(body) or body
            cb(data)
            resultCallback(json.encode('ok'))
        end)
    end

    function Platform.bringUIToFront(ui)
        -- FiveM NUI layering is controlled via SetNuiFocus / CSS z-index.
        -- No explicit bring-to-front call exists in the native API.
    end

    function Platform.setInputMode(ui, mode)
        -- mode 1 → cursor visible + UI receives input
        -- mode 0 → cursor hidden, game receives input
        _tLibNUIFocused = (mode == 1)
        if mode == 1 then
            SetNuiFocus(true, true)
        else
            SetNuiFocus(false, false)
        end
    end

    function Platform.destroyUI(ui)
        -- FiveM NUI pages cannot be destroyed at runtime; signal the page to
        -- hide itself so it stops intercepting input.
        SendNUIMessage({ type = '_tlib_destroy' })
    end
else
    Platform.createUI       = Platform._stub('createUI')
    Platform.sendUIEvent    = Platform._stub('sendUIEvent')
    Platform.onUIEvent      = Platform._stub('onUIEvent')
    Platform.bringUIToFront = Platform._stub('bringUIToFront')
    Platform.setInputMode   = Platform._stub('setInputMode')
    Platform.destroyUI      = Platform._stub('destroyUI')
end

-- ── Events ────────────────────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    -- Helix exposes these as globals; names may vary slightly between versions
    -- so we probe once at load time.
    --
    -- TriggerEvent / AddEventHandler deliberately use the CROSS-PACKAGE API
    -- (TriggerClientEvent / RegisterClientEvent) rather than the local-only
    -- variants (TriggerLocalClientEvent / RegisterLocalClientEvent).
    -- Local events are scoped to a single VM — consumer packages that call
    -- Platform.addEventHandler in their own VM would never receive events fired
    -- via TriggerLocalClientEvent inside tLib's VM.  Cross-package events are
    -- delivered to all VMs that have registered a handler with the same name.
    local _triggerCross = TriggerClientEvent or TriggerEvent or function() end
    local _onCross      = RegisterClientEvent or function() end
    local _triggerSrv   = TriggerServerEvent or function() end
    local _triggerCl    = TriggerClientEvent or function() end

    function Platform.TriggerEvent(name, ...) _triggerCross(name, ...) end

    function Platform.AddEventHandler(name, cb) _onCross(name, cb) end

    function Platform.TriggerServerEvent(name, ...) _triggerSrv(name, ...) end

    function Platform.TriggerClientEvent(name, target, ...) _triggerCl(name, target, ...) end
elseif _TLIB_IS_FIVEM then
    function Platform.TriggerEvent(name, ...)
        TriggerEvent(name, ...)
    end

    function Platform.AddEventHandler(name, cb)
        AddEventHandler(name, cb)
    end

    function Platform.TriggerServerEvent(name, ...)
        TriggerServerEvent(name, ...)
    end

    function Platform.TriggerClientEvent(name, target, ...)
        TriggerClientEvent(name, target, ...)
    end
else
    Platform.TriggerEvent       = Platform._stub('TriggerEvent')
    Platform.AddEventHandler    = Platform._stub('AddEventHandler')
    Platform.TriggerServerEvent = Platform._stub('TriggerServerEvent')
    Platform.TriggerClientEvent = Platform._stub('TriggerClientEvent')
end

-- ── Exports (registering) ─────────────────────────────────────────────────────
-- Calling exports from other resources is identical on both platforms:
--   exports['resource']:Method(...)
-- No wrapper is needed for the call direction — use that syntax directly.

-- ── Shim-key unwrapping middleware (incoming args) ────────────────────────────
-- On Helix, tLibShim.lua (running in the consumer's VM) replaces every function
-- argument with an auto-generated string key ("__tLibCb_<n>_<rand>") before the
-- call crosses the VM boundary.  Platform.wrapExport wraps a handler so that
-- any such key arriving as an argument is transparently replaced with a live
-- proxy callable — a function that, when called with (...), fires
-- TriggerLocalClientEvent('tLib:callback', key, ...) back into the consumer VM
-- where the shim's listener dispatches to the real function.
--
-- The handler therefore always receives real callables and can store / invoke
-- them with plain Lua syntax:
--
--   Platform.export('tLib', 'AddButton', function(menuId, label, onSelect)
--       item.onSelect = onSelect          -- just store it
--   end)
--   -- later:
--   item.onSelect(data)                   -- just call it
--
-- On FiveM no keys are ever generated — arguments arrive as real functions —
-- so the wrapper is a transparent pass-through.
--
-- Platform.export is an alias for Platform.wrapExport so all existing call
-- sites work unchanged.
--
-- ── Returning callables from exports (outgoing return values) ─────────────────
-- The unwrapping middleware above solves the INCOMING direction.  But Helix
-- also cannot carry a function across the boundary in the RETURN direction —
-- a closure returned from an export handler in tLib's VM arrives in the
-- consumer's VM as a dead address string.
--
-- Platform.storeCallback(fn) solves this for the outgoing direction:
--   • On Helix: stores fn in tLib's own internal _tLibCallbacks table under a
--     fresh __tLibCb_ key, registers a one-time tLib:callback listener that
--     dispatches calls to it, and returns the key string.  The key crosses the
--     VM boundary safely; tLibShim.lua's unsanitiseReturn (Case 1) wraps it
--     back into a real callable in the consumer VM.  When the consumer calls
--     that proxy, TriggerLocalClientEvent('tLib:callback', key, ...) fires and
--     tLib's listener invokes the stored closure.
--   • On FiveM: returns fn unchanged — functions cross the boundary natively.
--
-- Usage:
--   Platform.export('tLib', 'CreateLogger', function(id, printFn, opts)
--       local closure = function(...) printFn(...) end
--       return Platform.storeCallback(closure)  -- safe on both platforms
--   end)
--
-- Migration (when Helix fixes function-across-boundary natively):
--   1. Delete all tLibShim.lua files and remove them from package.json lists.
--   2. In core.lua, change the _TLIB_IS_HELIX branch of Platform.storeCallback
--      to simply `return fn` (same as FiveM).
--   3. No other files need to change.

local _SHIM_PREFIX     = '__tLibCb_'
local _SHIM_PREFIX_LEN = #_SHIM_PREFIX

-- The tLib-side key prefix embeds the literal package name 'tLib' so that
-- keys generated here are structurally distinct from any consumer-shim key.
-- Consumer shims use __tLibCb_<consumerPkgName>_<counter>; tLib uses
-- __tLibCb_tLib_<counter>.  No two packages can collide regardless of timing
-- or counter value.
--
-- Why no math.random?
--   Lua 5.4 uses a fixed default seed of 0 when math.randomseed has not been
--   called.  All VMs therefore produce the same pseudo-random sequence from
--   startup, so a random suffix alone cannot prevent cross-VM collisions.
--   Embedding the package name provides a hard structural guarantee at zero cost.
local _TLIB_KEY_PREFIX = _SHIM_PREFIX .. 'tLib_'

-- ── tLib-side callback store (for Platform.storeCallback) ────────────────────
-- Distinct from the consumer-side _callbacks table inside tLibShim.lua.
-- Lives in tLib's VM; keyed by __tLibCb_ strings exactly like the shim's store.
--
-- These are prefixed globals rather than locals so that if core.lua is ever
-- sourced more than once inside the same VM (e.g. a future require path), the
-- second execution reuses the table and counter the first created rather than
-- producing a fresh pair that would cause storeCallback and the
-- RegisterClientEvent handler to disagree on which table to use.
--
-- NOTE: Helix runs the "server" and "client" script lists in completely
-- separate Lua VMs — globals do NOT leak between them.  Each VM initialises
-- its own _tLibSharedCallbacks from scratch.  Only the client VM's table and
-- handler are relevant at runtime; the server VM's copies are inert because no
-- tLib export that calls storeCallback is registered from server.lua.
if not _tLibSharedCallbacks then
    _tLibSharedCallbacks   = {}
    _tLibSharedCbCount     = 0
    _tLibSharedDispatching = false
    _tLibSharedQueue       = {}
end

local function _tLibNextKey()
    _tLibSharedCbCount = _tLibSharedCbCount + 1
    return _TLIB_KEY_PREFIX .. tostring(_tLibSharedCbCount)
end

-- _makeProxy and _unwrapValue are hoisted to file scope so both
-- Platform.wrapExport and the tLib:callback handler can reference them.
-- On FiveM these are never called (functions cross natively), but defining
-- them unconditionally avoids a forward-reference problem.

local function _makeProxy(key)
    return function(...)
        TriggerLocalClientEvent('tLib:callback', key, ...)
    end
end

-- _unwrapValue is fully recursive: it walks tables to any depth so that
-- deeply-nested shim keys (e.g. ops[i].changes.onOpen in BatchUpdate, which
-- sits three levels below the outer argument) are always unwrapped into live
-- proxy callables.  A seen-table guards against reference cycles.
local function _unwrapValue(v, _seen)
    if type(v) == 'string' and v:sub(1, _SHIM_PREFIX_LEN) == _SHIM_PREFIX then
        return _makeProxy(v)
    elseif type(v) == 'table' then
        _seen = _seen or {}
        if _seen[v] then return v end -- cycle guard — return original ref
        _seen[v] = true
        local copy = {}
        for k, val in pairs(v) do
            copy[k] = _unwrapValue(val, _seen)
        end
        return copy
    end
    return v
end

-- On Helix, use native Timer.SetTimeout / Timer.SetInterval instead of the
-- custom createThread+wait approach. Timer.Wait can only be called from inside
-- Timer.CreateThread; using the native timer API avoids that constraint and is
-- the idiomatic Helix pattern shown in the docs.
-- _unwrapValue is available here so shim keys are resolved before scheduling.

if _TLIB_IS_HELIX then
    function Platform.setInterval(fn, ms)
        local realFn = _unwrapValue(fn)
        local handle = _nextHandle()
        _timerHandles[handle] = true
        Timer.SetInterval(function()
            if _timerHandles[handle] then
                realFn()
            else
                Timer.ClearInterval(handle)
            end
        end, ms)
        return handle
    end

    function Platform.clearInterval(handle)
        _timerHandles[handle] = nil
        Timer.ClearInterval(handle)
    end

    function Platform.setTimeout(fn, ms)
        local realFn = _unwrapValue(fn)
        local handle = _nextHandle()
        _timerHandles[handle] = true
        Timer.SetTimeout(function()
            if _timerHandles[handle] then
                _timerHandles[handle] = nil
                realFn()
            end
        end, ms)
        return handle
    end

    function Platform.clearTimeout(handle)
        _timerHandles[handle] = nil
        Timer.ClearTimeout(handle)
    end
end

if _TLIB_IS_HELIX then
    function Platform.wrapExport(resource, name, fn)
        exports(resource, name, function(...)
            local args = { ... }
            for i = 1, #args do
                args[i] = _unwrapValue(args[i])
            end
            return fn(table.unpack(args))
        end)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.wrapExport(resource, name, fn)
        -- On FiveM arguments are already real functions — no unwrapping needed.
        -- The `resource` argument is accepted for API symmetry but ignored;
        -- FiveM infers the resource name from the manifest.
        exports(name, fn)
    end
else
    Platform.wrapExport = Platform._stub('wrapExport')
end

-- Platform.export is an alias for Platform.wrapExport so all existing
-- registration call sites work without modification.
function Platform.export(resource, name, fn)
    Platform.wrapExport(resource, name, fn)
end

-- ── Platform.storeCallback ────────────────────────────────────────────────────
-- Use this when an export handler needs to RETURN a callable to the consumer.
-- On Helix a closure cannot cross the VM boundary in the return direction, so
-- we store it locally and return a key string that the consumer shim's
-- unsanitiseReturn (Case 1) will wrap back into a real proxy callable.
-- On FiveM functions cross natively — return the closure directly.
--
-- When Helix natively fixes function-across-boundary:
--   Change the _TLIB_IS_HELIX branch below to `return fn` (same as FiveM),
--   then delete all tLibShim.lua files.  Nothing else needs to change.

if _TLIB_IS_HELIX then
    -- Register a persistent tLib-side listener for callbacks stored here.
    -- This mirrors the consumer-side listener in tLibShim.lua but lives in
    -- tLib's own VM so it can dispatch to closures that tLib owns.
    -- Args are unwrapped through _unwrapValue before dispatch: when a consumer
    -- calls a Platform proxy callable (e.g. Platform.bindKey), the shim
    -- sanitises any function args to __tLibCb_ key strings before they cross
    -- via TriggerLocalClientEvent. Without unwrapping here those keys would
    -- arrive as raw strings at the stored closure (e.g. Input.BindKey would
    -- receive a string instead of a callable).
    --
    -- The handler is guarded by _tLibSharedHandlerRegistered as a safety net
    -- against core.lua being sourced more than once in the same VM.  In normal
    -- operation each VM runs core.lua exactly once, so the guard is a no-op —
    -- but it costs nothing and prevents a double-fire if the load path changes.
    if not _tLibSharedHandlerRegistered then
        _tLibSharedHandlerRegistered = true

        RegisterClientEvent('tLib:callback', function(key, ...)
            if not _tLibSharedCallbacks[key] then return end

            if _tLibSharedDispatching then
                local args = { ... }
                _tLibSharedQueue[#_tLibSharedQueue + 1] = { key = key, args = args }
                return
            end

            _tLibSharedDispatching = true
            local fn = _tLibSharedCallbacks[key]
            if type(fn) == 'function' then
                local args = { ... }
                for i = 1, #args do
                    args[i] = _unwrapValue(args[i])
                end
                fn(table.unpack(args))
            end

            while #_tLibSharedQueue > 0 do
                local item = table.remove(_tLibSharedQueue, 1)
                local qfn  = _tLibSharedCallbacks[item.key]
                if type(qfn) == 'function' then
                    for i = 1, #item.args do
                        item.args[i] = _unwrapValue(item.args[i])
                    end
                    qfn(table.unpack(item.args))
                end
            end
            _tLibSharedDispatching = false
        end)
    end

    function Platform.storeCallback(fn)
        local key = _tLibNextKey()
        _tLibSharedCallbacks[key] = fn
        return key -- key string is safe across the VM boundary
    end
elseif _TLIB_IS_FIVEM then
    function Platform.storeCallback(fn)
        return fn -- functions cross natively; return as-is
    end
else
    Platform.storeCallback = Platform._stub('storeCallback')
end

-- ── Platform.invokeCallback — backward-compat no-op ──────────────────────────
-- Export handlers previously had to call Platform.invokeCallback(storedKey, ...)
-- instead of storedKey(...).  Now that Platform.wrapExport unwraps all incoming
-- shim keys into live proxy callables before the handler sees them, stored
-- values are always real functions and can be called directly.
-- Platform.invokeCallback is kept so any code that still references it compiles
-- and runs without error, but it does nothing.

function Platform.invokeCallback(key, ...)
    -- Intentional no-op.  Kept for backward compatibility only.
    -- Call stored callbacks directly: if fn then fn(...) end
end

-- ── Shutdown ──────────────────────────────────────────────────────────────────

local _shutdownCallbacks = {}

function Platform.onShutdown(cb)
    table.insert(_shutdownCallbacks, cb)
end

local function _runShutdown()
    for _, cb in ipairs(_shutdownCallbacks) do
        local ok, err = pcall(cb)
        if not ok then
            log('onShutdown callback error: ' .. tostring(err), 4)
        end
    end
end

if _TLIB_IS_HELIX then
    -- Chain into any onShutdown that may already be defined by another module.
    local _prev = type(onShutdown) == 'function' and onShutdown or nil
    function onShutdown()
        _runShutdown()
        if _prev then _prev() end
    end
elseif _TLIB_IS_FIVEM then
    if not _tLibShutdownRegistered then
        _tLibShutdownRegistered = true
        local resourceName = GetCurrentResourceName and GetCurrentResourceName() or 'tLib'
        AddEventHandler('onResourceStop', function(res)
            if res == resourceName then
                _runShutdown()
            end
        end)
    end
end
