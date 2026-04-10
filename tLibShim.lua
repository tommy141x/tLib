-- tLibShim.lua
-- Temporary Helix workaround: makes inline function arguments to exports['tLib']
-- work as expected despite Helix serialising functions to strings at the
-- cross-package VM boundary.
--
-- HOW IT WORKS
--   On Helix, any function passed to exports['tLib']:SomeMethod(...) arrives
--   inside tLib's VM as a string like "function: 0x...". This shim intercepts
--   calls in the CONSUMER's VM before they cross the boundary:
--
--     1. Scans every argument (and nested table values for BatchUpdate ops).
--     2. Replaces each function with an auto-generated string key.
--     3. Stores the real function locally under that key.
--     4. Forwards the sanitised args to the real export.
--
--   Inside tLib, Platform.wrapExport intercepts the registered handler and
--   unwraps any __tLibCb_ key back into a live proxy callable before the
--   handler sees it. The handler can therefore store and invoke callbacks with
--   plain Lua — it never knows keys were involved.
--
--   When tLib fires TriggerLocalClientEvent('tLib:callback', key, ...), this
--   shim's listener calls the stored real function in the consumer VM.
--
--   OUTGOING callables (e.g. the log function returned by CreateLogger, or any
--   function on the Platform table returned by Platform()):
--   tLib calls Platform.storeCallback(closure), which stores the closure in
--   tLib's own VM and returns a __tLibCb_ key string. That key crosses the
--   boundary safely; unsanitiseReturn below wraps it into a proxy callable in
--   the consumer VM. Calling the proxy sanitises its own arguments (so any
--   function args the consumer passes — e.g. the callback to Platform.bindKey)
--   are stored locally and replaced with keys before the call crosses via
--   TriggerLocalClientEvent into tLib's VM where the stored closure is invoked.
--
-- REMOVING THIS SHIM
--   Once Helix natively supports function arguments across export boundaries,
--   delete this file and remove it from each consumer's package.json client
--   list. No other changes are needed — all call sites stay identical.
--
-- USAGE (consumer package.json)
--   "client": [
--     "tLibShim.lua",   -- must be first
--     "client.lua",
--     ...
--   ]
--
--   The shim overwrites exports['tLib'] with a transparent proxy, so all
--   existing call syntax works with zero modifications:
--     exports['tLib']:AddButton('menu', 'btn', 'Label', '', {}, function() ... end)
--     local log = exports['tLib']:CreateLogger('mypkg', print, {})
--     log('hello', 2)
--
-- COPYING THIS SHIM TO A NEW CONSUMER PACKAGE
--   No manual edits are needed — _PKG_ID is auto-detected from _G.__PackageName,
--   which Helix sets to the package's folder name in every VM.  Just drop this
--   file into the new package and add it as the first entry in package.json's
--   client list.

-- Keys have the form:  __tLibCb_<package>_<counter>
--
-- The package name component (_PKG_ID) makes keys from different consumer VMs
-- structurally distinct — no two packages can ever produce the same key
-- regardless of timing, Lua version, or RNG state.  The counter within each VM
-- is strictly monotonic, so keys within a single package are also unique.
--
-- Why not math.random?
--   Lua 5.4 uses a fixed default seed of 0 when math.randomseed has not been
--   called.  Every VM that starts a fresh state therefore produces the same
--   pseudo-random sequence, making a random suffix alone insufficient to
--   prevent collisions across simultaneously-loaded consumer packages.
--   Embedding the package name costs nothing and provides a hard guarantee.

-- _G.__PackageName is always a non-empty string on Helix — it is set by the
-- runtime before any package script runs.
local _PKG_ID         = _G.__PackageName

local _SHIM_PREFIX    = '__tLibCb_'
local _KEY_PREFIX     = _SHIM_PREFIX .. _PKG_ID .. '_'
local _KEY_PREFIX_LEN = #_SHIM_PREFIX -- prefix checked in unsanitiseReturn

local _callbacks      = {}
local _keyCount       = 0

local function storeCallback(fn)
    _keyCount = _keyCount + 1
    local key = _KEY_PREFIX .. tostring(_keyCount)
    _callbacks[key] = fn
    return key
end

-- Walks an argument list and replaces every function value with a string key.
-- Tables are deep-copied recursively so that functions at any nesting depth are
-- captured — this is required for BatchUpdate updateMenu ops where onOpen/onClose
-- sit three levels below the outer argument (ops[i].changes.onOpen).
-- A seen-table guards against reference cycles.

local function sanitiseValue(v, _seen)
    if type(v) == 'function' then
        return storeCallback(v)
    elseif type(v) == 'table' then
        _seen = _seen or {}
        if _seen[v] then return v end -- cycle guard — return original ref
        _seen[v] = true
        local copy = {}
        for k, val in pairs(v) do
            copy[k] = sanitiseValue(val, _seen)
        end
        return copy
    end
    return v
end

local function sanitiseArgs(args)
    local out = {}
    for i = 1, #args do
        out[i] = sanitiseValue(args[i])
    end
    return out
end

-- If an export returns a shim key string, tLib stored a closure under that key
-- and returned it via Platform.storeCallback. Wrap it in a function that fires
-- TriggerLocalClientEvent('tLib:callback', key, ...) so tLib's VM receives the
-- call and dispatches to the stored closure.
--
-- Tables are unwrapped recursively so that a returned table of callbacks (e.g.
-- the Platform table) has all its function-key values unwrapped in one pass.
-- A seen-table guards against reference cycles.
--
-- The prefix check uses _KEY_PREFIX_LEN (= #'__tLibCb_') so that ANY key with
-- the __tLibCb_ prefix — whether from tLib itself (__tLibCb_tLib_*) or from
-- another consumer — is wrapped into a proxy. This is correct: returned keys
-- always originate from tLib's Platform.storeCallback, never from a consumer
-- shim, so the shared prefix is the right discriminator here.

local function unsanitiseReturn(v, _seen)
    if type(v) == 'string' and v:sub(1, _KEY_PREFIX_LEN) == _SHIM_PREFIX then
        local key = v
        return function(...)
            local clean = sanitiseArgs({ ... })
            TriggerLocalClientEvent('tLib:callback', key, table.unpack(clean))
        end
    elseif type(v) == 'table' then
        _seen = _seen or {}
        if _seen[v] then return v end
        _seen[v] = true
        local out = {}
        for k, val in pairs(v) do
            out[k] = unsanitiseReturn(val, _seen)
        end
        return out
    end

    return v
end

-- tLib fires TriggerLocalClientEvent('tLib:callback', key, ...) when it wants
-- to invoke a callback that originated in this package.
-- RegisterClientEvent is Helix's cross-package event API — the same one
-- already used by consumers to receive tLib:item:selected etc.
--
-- Routing is exact: because every key is prefixed with this package's unique
-- _PKG_ID, the `if not _callbacks[key]` guard is airtight — a key minted by
-- any other consumer's shim will never be present in this VM's _callbacks table.

local _dispatching = false
local _queue       = {}

RegisterClientEvent('tLib:callback', function(key, ...)
    -- Ignore keys not owned by this shim — tLib-side keys (__tLibCb_tLib_*)
    -- and other consumers' keys (__tLibCb_<otherPkg>_*) are handled in their
    -- respective VMs.
    if not _callbacks[key] then return end

    if _dispatching then
        local args = { ... }
        _queue[#_queue + 1] = { key = key, args = args }
        return
    end

    _dispatching = true
    local fn = _callbacks[key]
    if type(fn) == 'function' then
        fn(...)
    end

    -- Drain any callbacks queued by nested tLib:callback fires.
    while #_queue > 0 do
        local item = table.remove(_queue, 1)
        local qfn = _callbacks[item.key]
        if type(qfn) == 'function' then
            qfn(table.unpack(item.args))
        end
    end
    _dispatching = false
end)

-- Wraps the real exports['tLib'] table. Unknown methods fall through via
-- __index so non-callback exports (ShowToast, SetItemLabel, etc.) are
-- completely unaffected.

local _real  = exports['tLib']
local _proxy = {}

setmetatable(_proxy, {
    __index = function(_, method)
        -- Return a wrapper that sanitises args then calls the real export.
        local realFn = _real[method]
        if type(realFn) ~= 'function' then
            -- Not a callable — pass the raw value through (e.g. string fields).
            return realFn
        end
        return function(_, ...)
            local clean = sanitiseArgs({ ... })
            return unsanitiseReturn(realFn(_real, table.unpack(clean)))
        end
    end,
    __newindex = function() end, -- ignore writes
})

-- Replace the global exports entry so all existing call sites work unchanged.
exports['tLib'] = _proxy
