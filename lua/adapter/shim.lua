-- tLib/lua/adapter/shim.lua
-- callback/export bridge system for cross-VM function passing


local log = Logger.create('tLib/adapter/shim')

-- Calling exports from other resources is identical on both platforms:
--   exports['resource']:Method(...)
-- No wrapper is needed for the call direction — use that syntax directly.

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
-- The unwrapping middleware above solves the INCOMING direction.  But Helix
-- also cannot carry a function across the boundary in the RETURN direction —
-- a closure returned from an export handler in tLib's VM arrives in the
-- consumer's VM as a dead address string.
--
-- Platform.storeCallback(fn) solves this for the outgoing direction:
--   • On Helix: stores fn in tLib's own internal _TLIB_SHARED_CALLBACKS table under a
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

_SHIM_PREFIX     = '__tLibCb_'
_SHIM_PREFIX_LEN = #_SHIM_PREFIX

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
-- its own _TLIB_SHARED_CALLBACKS from scratch.  Only the client VM's table and
-- handler are relevant at runtime; the server VM's copies are inert because no
-- tLib export that calls storeCallback is registered from server.lua.
if not _TLIB_SHARED_CALLBACKS then
    _TLIB_SHARED_CALLBACKS   = {}
    _TLIB_SHARED_CB_COUNT     = 0
    _TLIB_SHARED_DISPATCHING = false
    _TLIB_SHARED_QUEUE       = {}
end

local function _tLibNextKey()
    _TLIB_SHARED_CB_COUNT = _TLIB_SHARED_CB_COUNT + 1
    return _TLIB_KEY_PREFIX .. tostring(_TLIB_SHARED_CB_COUNT)
end

-- _makeProxy and _unwrapValue are hoisted to file scope so both
-- Platform.wrapExport and the tLib:callback handler can reference them.
-- On FiveM these are never called (functions cross natively), but defining
-- them unconditionally avoids a forward-reference problem.
--
-- These are globals (not local) because the timer system in core.lua also
-- needs _unwrapValue to resolve shim keys before scheduling.

function _makeProxy(key)
    return function(...)
        TriggerLocalClientEvent('tLib:callback', key, ...)
    end
end

-- _unwrapValue is fully recursive: it walks tables to any depth so that
-- deeply-nested shim keys (e.g. ops[i].changes.onOpen in BatchUpdate, which
-- sits three levels below the outer argument) are always unwrapped into live
-- proxy callables.  A seen-table guards against reference cycles.
function _unwrapValue(v, _seen)
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
    -- The handler is guarded by _TLIB_SHARED_HANDLER_REGISTERED as a safety net
    -- against core.lua being sourced more than once in the same VM.  In normal
    -- operation each VM runs core.lua exactly once, so the guard is a no-op —
    -- but it costs nothing and prevents a double-fire if the load path changes.
    if not _TLIB_SHARED_HANDLER_REGISTERED then
        _TLIB_SHARED_HANDLER_REGISTERED = true

        RegisterClientEvent('tLib:callback', function(key, ...)
            if not _TLIB_SHARED_CALLBACKS[key] then return end

            if _TLIB_SHARED_DISPATCHING then
                local args = { ... }
                _TLIB_SHARED_QUEUE[#_TLIB_SHARED_QUEUE + 1] = { key = key, args = args }
                return
            end

            _TLIB_SHARED_DISPATCHING = true
            local fn = _TLIB_SHARED_CALLBACKS[key]
            if type(fn) == 'function' then
                local args = { ... }
                for i = 1, #args do
                    args[i] = _unwrapValue(args[i])
                end
                fn(table.unpack(args))
            end

            while #_TLIB_SHARED_QUEUE > 0 do
                local item = table.remove(_TLIB_SHARED_QUEUE, 1)
                local qfn  = _TLIB_SHARED_CALLBACKS[item.key]
                if type(qfn) == 'function' then
                    for i = 1, #item.args do
                        item.args[i] = _unwrapValue(item.args[i])
                    end
                    qfn(table.unpack(item.args))
                end
            end
            _TLIB_SHARED_DISPATCHING = false
        end)
    end

    function Platform.storeCallback(fn)
        local key = _tLibNextKey()
        _TLIB_SHARED_CALLBACKS[key] = fn
        return key -- key string is safe across the VM boundary
    end

    function Platform.releaseCallback(key)
        _TLIB_SHARED_CALLBACKS[key] = nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.storeCallback(fn)
        return fn -- functions cross natively; return as-is
    end
else
    Platform.storeCallback = Platform._stub('storeCallback')
end
