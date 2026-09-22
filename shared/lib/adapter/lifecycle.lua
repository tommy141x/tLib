-- Host lifecycle: monotonic time, other-resource shutdown, player departure,
-- caller identity and console commands.
--
-- Separate from shutdown.lua, which answers whether tLib itself is going away.
-- These answer the same questions about other resources and about players: when a
-- consumer stops, whatever it registered has to go with it, or the registry keeps
-- serving menus backed by handlers that no longer exist.

local log = Logger.create('tLib/adapter/lifecycle')


-- Milliseconds since host start. Rate limits and cooldowns need it to advance at
-- wall-clock speed; the epoch is irrelevant.
if _TLIB_IS_FIVEM then
    function Platform.now()
        return GetGameTimer()
    end
else
    Platform.now = Platform._stub('now')
end


local _resourceStopCallbacks = {}

--- cb(resourceName) — fires for ANY resource stopping, including tLib itself.
function Platform.onResourceStop(cb)
    if type(cb) ~= 'function' then error('Platform.onResourceStop expects a function', 2) end
    _resourceStopCallbacks[#_resourceStopCallbacks + 1] = cb
end

local function _runResourceStop(name)
    for _, cb in ipairs(_resourceStopCallbacks) do
        local ok, err = pcall(cb, name)
        if not ok then log('onResourceStop callback error: ' .. tostring(err), 4) end
    end
end

if _TLIB_IS_FIVEM then
    if not _TLIB_RESOURCE_STOP_REGISTERED then
        _TLIB_RESOURCE_STOP_REGISTERED = true
        AddEventHandler('onResourceStop', _runResourceStop)
    end
end


local _playerDroppedCallbacks = {}

--- cb(source) — fires when a player disconnects, so per-player state can be freed.
function Platform.onPlayerDropped(cb)
    if type(cb) ~= 'function' then error('Platform.onPlayerDropped expects a function', 2) end
    _playerDroppedCallbacks[#_playerDroppedCallbacks + 1] = cb
end

local function _runPlayerDropped(source)
    for _, cb in ipairs(_playerDroppedCallbacks) do
        local ok, err = pcall(cb, source)
        if not ok then log('onPlayerDropped callback error: ' .. tostring(err), 4) end
    end
end

if _TLIB_SIDE == 'server' then
    if _TLIB_IS_FIVEM then
        if not _TLIB_PLAYER_DROPPED_REGISTERED then
            _TLIB_PLAYER_DROPPED_REGISTERED = true
            -- `source` is the departing player and is only valid inside the handler.
            AddEventHandler('playerDropped', function()
                _runPlayerDropped(source)
            end)
        end
    end
end


--- The resource that invoked the export currently running, or nil if the host
--- cannot tell. nil means unverified, not trusted -- anything keying ownership off
--- this must fall back to an explicitly declared owner.
function Platform.getInvokingResource()
    if _TLIB_IS_FIVEM and type(GetInvokingResource) == 'function' then
        local name = GetInvokingResource()
        -- An export called from tLib's own VM reports no invoker.
        if name and name ~= '' then return name end
    end
    return nil
end

--- Host-side wrapper over shared/sh_branding.lua, where the rule lives so that a
--- consumer VM loading it directly gets the identical answer.
---
--- Branding policy, not an authenticity boundary -- never let it decide who may do
--- something.
function Platform.isStudioResource(resource)
    if not _TLIB_IS_FIVEM then return false end
    if type(StudioBranding) ~= 'table' then return false end
    return StudioBranding.isStudioResource(resource)
end


--- Register a server console command. A `restricted` command is refused when the
--- caller is a player rather than the console; the check lives here so no caller
--- can forget it.
function Platform.registerCommand(name, handler, restricted)
    if type(name) ~= 'string' or type(handler) ~= 'function' then
        error('Platform.registerCommand expects a name and a handler', 2)
    end
    if _TLIB_IS_FIVEM then
        RegisterCommand(name, function(source, args)
            if restricted and tonumber(source) ~= 0 then return end
            handler(tonumber(source) or 0, args or {})
        end, false)
        return true
    end
    log(('console command %q is not available on this platform'):format(name), 3)
    return false
end
