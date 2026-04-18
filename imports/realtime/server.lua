-- tlib.realtime — server-side imports-style facade over tLib's WebSocket realtime layer.
--
-- Consumer usage:
--   shared_scripts { '@tLib/imports.lua' }
--   tlib_module { 'realtime' }
--
--   local info = tlib.realtime:issueToken(playerId, { meta = { hello = 'world' } })
--   -- info = { token = 'abcd...', expiresAt = 1234567890, wsUrl = 'ws://...' }
--   -- pass info.wsUrl and info.token to the NUI shell (via TriggerClientEvent etc.)
--
--   tlib.realtime:setRooms(playerId, { 'radio:freq:154.125', 'radio:patch:857.500' })
--
--   tlib.realtime:onConnect(function(playerId, sessionId, meta) end)
--   tlib.realtime:onDisconnect(function(playerId, sessionId, code, reason) end)
--   tlib.realtime:onEvent('ptt', function(playerId, sessionId, payload) end)
--   tlib.realtime:onEvent(function(playerId, sessionId, type, payload) end) -- wildcard
--
--   tlib.realtime:sendEvent(playerId, 'tone', { file = 'panic.wav' })
--   tlib.realtime:broadcastEvent('radio:freq:154.125', 'talker', { id = 42, on = true })
--   tlib.realtime:publish('radio:freq:154.125', rawBytesString)
--   tlib.realtime:kick(playerId, 'banned')
--
-- The binary voice path does NOT go through Lua — it lives entirely in the
-- iframe<->shell<->ws<->tLib-node path. Lua is only for room decisions,
-- typed events, and lifecycle.

local RT_EVT_CONNECT      = '__tlib:rt:connect'
local RT_EVT_DISCONNECT   = '__tlib:rt:disconnect'
local RT_EVT_EVENT        = '__tlib:rt:event'
local RT_EVT_CTRL_RECV    = '__tlib:rt:control:recv'
local RT_EVT_CTRL_STATE   = '__tlib:rt:control:state'

local realtime          = {}

-- per-consumer-VM state (each resource that imports realtime gets its own)
local connectHandlers   = {}
local disconnectHandlers = {}
local eventHandlers     = {} -- map: eventType -> list of fn
local eventWildcard     = {}
local listenersRegistered = false

local function registerListenersOnce()
    if listenersRegistered then return end
    listenersRegistered = true

    AddEventHandler(RT_EVT_CONNECT, function(playerId, sessionId, metaJson)
        local meta
        if type(metaJson) == 'string' and metaJson ~= '' then
            local ok, parsed = pcall(json.decode, metaJson)
            if ok then meta = parsed end
        end
        for i = 1, #connectHandlers do
            local ok, err = pcall(connectHandlers[i], playerId, sessionId, meta)
            if not ok then print(('[tlib.realtime] onConnect handler error: %s'):format(err)) end
        end
    end)

    AddEventHandler(RT_EVT_DISCONNECT, function(playerId, sessionId, code, reason)
        for i = 1, #disconnectHandlers do
            local ok, err = pcall(disconnectHandlers[i], playerId, sessionId, code, reason)
            if not ok then print(('[tlib.realtime] onDisconnect handler error: %s'):format(err)) end
        end
    end)

    AddEventHandler(RT_EVT_EVENT, function(playerId, sessionId, eventType, payload)
        local list = eventHandlers[eventType]
        if list then
            for i = 1, #list do
                local ok, err = pcall(list[i], playerId, sessionId, payload)
                if not ok then print(('[tlib.realtime] onEvent(%s) handler error: %s'):format(eventType, err)) end
            end
        end
        for i = 1, #eventWildcard do
            local ok, err = pcall(eventWildcard[i], playerId, sessionId, eventType, payload)
            if not ok then print(('[tlib.realtime] onEvent(*) handler error: %s'):format(err)) end
        end
    end)
end

-- ------------------------------------------------------------------
-- session + token
-- ------------------------------------------------------------------

--- Issue a short-lived connect token for a player's iframe.
--- @param playerId number
--- @param opts table? { meta = table? } — meta is surfaced on the onConnect hook
--- @return table { token, expiresAt, wsUrl }
function realtime:issueToken(playerId, opts)
    local meta = opts and opts.meta or nil
    local metaJson = nil
    if meta ~= nil then
        local ok, encoded = pcall(json.encode, meta)
        if ok then metaJson = encoded end
    end
    return exports['tLib']:rtIssueToken(playerId, metaJson)
end

--- { wsUrl, port, host } — useful for logging / health checks.
function realtime:connectionInfo()
    return exports['tLib']:rtConnectionInfo()
end

--- Close all sessions for a player.
--- @return number closed
function realtime:kick(playerId, reason)
    return exports['tLib']:rtKick(playerId, reason or 'kicked')
end

-- ------------------------------------------------------------------
-- rooms
-- ------------------------------------------------------------------

--- Replace a player's room membership. Pass an empty table to remove all.
function realtime:setRooms(playerId, roomIds)
    if type(roomIds) ~= 'table' then roomIds = {} end
    exports['tLib']:rtSetRooms(playerId, roomIds)
end

function realtime:getRooms(playerId)
    return exports['tLib']:rtGetRooms(playerId) or {}
end

-- ------------------------------------------------------------------
-- events (typed, JSON)
-- ------------------------------------------------------------------

--- Deliver a typed event to all of a player's authed sessions.
--- @return number sessionsReached
function realtime:sendEvent(playerId, eventType, payload)
    return exports['tLib']:rtSendEvent(playerId, eventType, payload)
end

--- Broadcast to every session subscribed to a room.
--- @param opts table? { exceptPlayerId = number? }
--- @return number sessionsReached
function realtime:broadcastEvent(roomId, eventType, payload, opts)
    local excl = opts and opts.exceptPlayerId or nil
    return exports['tLib']:rtBroadcastEvent(roomId, eventType, payload, excl)
end

-- ------------------------------------------------------------------
-- binary (server-originated fan-out, rare — voice goes iframe<->ws direct)
-- ------------------------------------------------------------------

--- Publish raw bytes to a room from the server side.
--- senderId on the resulting fanout frame is 0 (= "from server").
--- @param bytes string  raw byte string
--- @return number recipients
function realtime:publish(roomId, bytes)
    return exports['tLib']:rtPublishServer(roomId, bytes)
end

-- ------------------------------------------------------------------
-- handlers
-- ------------------------------------------------------------------

function realtime:onConnect(fn)
    assert(type(fn) == 'function', 'onConnect: fn must be a function')
    registerListenersOnce()
    connectHandlers[#connectHandlers + 1] = fn
end

function realtime:onDisconnect(fn)
    assert(type(fn) == 'function', 'onDisconnect: fn must be a function')
    registerListenersOnce()
    disconnectHandlers[#disconnectHandlers + 1] = fn
end

--- Listen for typed events from clients.
--- Two call styles:
---   onEvent('type', function(playerId, sessionId, payload) end)  -- scoped
---   onEvent(function(playerId, sessionId, type, payload) end)    -- wildcard
function realtime:onEvent(eventType, fn)
    registerListenersOnce()
    if type(eventType) == 'function' and fn == nil then
        eventWildcard[#eventWildcard + 1] = eventType
        return
    end
    assert(type(eventType) == 'string' and type(fn) == 'function',
        'onEvent: (type:string, fn:function) or (fn:function) for wildcard')
    local list = eventHandlers[eventType]
    if not list then
        list = {}
        eventHandlers[eventType] = list
    end
    list[#list + 1] = fn
end

-- ------------------------------------------------------------------
-- misc
-- ------------------------------------------------------------------

function realtime:stats()
    return exports['tLib']:rtStats()
end

-- ------------------------------------------------------------------
-- control client (outbound WS to CF brain)
-- ------------------------------------------------------------------
-- Opens a persistent WebSocket from this customer box to a remote brain
-- (e.g. radio.yourapp.com). Consumer supplies license + token endpoint;
-- tLib handles token fetch, reconnect, heartbeat.
--
-- Envelopes received from upstream fire via onControlRecv(type, data).
-- Envelopes sent upstream go through sendControl(type, data).

local controlRecvHandlers = {}
local controlStateHandlers = {}
local controlListenersRegistered = false

local function registerControlListenersOnce()
    if controlListenersRegistered then return end
    controlListenersRegistered = true

    AddEventHandler(RT_EVT_CTRL_RECV, function(envType, dataJson, n)
        local data = nil
        if type(dataJson) == 'string' and dataJson ~= '' and dataJson ~= 'null' then
            local ok, parsed = pcall(json.decode, dataJson)
            if ok then data = parsed end
        end
        for i = 1, #controlRecvHandlers do
            local ok, err = pcall(controlRecvHandlers[i], envType, data, n)
            if not ok then print(('[tlib.realtime] control recv handler error: %s'):format(err)) end
        end
    end)

    AddEventHandler(RT_EVT_CTRL_STATE, function(state, wsUrl)
        for i = 1, #controlStateHandlers do
            pcall(controlStateHandlers[i], state, wsUrl)
        end
    end)
end

--- Start the upstream control connection.
--- @param cfg table { license = 'tr-...', tokenEndpoint = 'https://.../api/control-token' }
function realtime:startControl(cfg)
    assert(type(cfg) == 'table', 'startControl: cfg table required')
    registerControlListenersOnce()
    return exports['tLib']:rtStartControl(cfg.license, cfg.tokenEndpoint)
end

function realtime:stopControl()
    return exports['tLib']:rtStopControl()
end

--- Send an envelope upstream to the brain.
--- @param typ string      envelope type (e.g. "state:talker")
--- @param data any        payload (any JSON-serialisable value)
--- @param correlation number?  optional reply-id for request/response flows
function realtime:sendControl(typ, data, correlation)
    local dataJson = data ~= nil and json.encode(data) or nil
    return exports['tLib']:rtSendControl(typ, dataJson, correlation)
end

--- Register a handler for incoming upstream envelopes.
--- @param fn fun(type: string, data: any, correlation: number)
function realtime:onControlRecv(fn)
    assert(type(fn) == 'function', 'onControlRecv: fn must be a function')
    registerControlListenersOnce()
    controlRecvHandlers[#controlRecvHandlers + 1] = fn
end

--- Register a handler for connection state changes (idle|connecting|open|closed).
function realtime:onControlState(fn)
    assert(type(fn) == 'function', 'onControlState: fn must be a function')
    registerControlListenersOnce()
    controlStateHandlers[#controlStateHandlers + 1] = fn
end

function realtime:controlState()
    return (exports['tLib']:rtControlState() or {}).state
end

return realtime
