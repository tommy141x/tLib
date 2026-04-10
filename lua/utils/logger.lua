-- tLib/lua/utils/logger.lua
-- levels: 1=DEBUG 2=INFO 3=WARN 4=ERROR

Logger          = {}

local _labels   = { [1] = 'DEBUG', [2] = 'INFO', [3] = 'WARN', [4] = 'ERROR' }
local _minLevel = 2 -- INFO

--- Set the minimum log level globally.  Messages below this level are dropped.
-- @param level  integer  1=DEBUG 2=INFO 3=WARN 4=ERROR
function Logger.setLevel(level)
    assert(type(level) == 'number', '[tLib/logger] setLevel: level must be a number')
    _minLevel = level
end

-- The only context the log body needs to carry.  The runtime (Helix) already
-- stamps [packageName] on every print line; the source label passed to
-- CreateLogger is redundant with that.  Side is the one piece neither runtime
-- nor console adds automatically.

local _side = Platform.getSide()

-- Extract the level from the tail of an args list and return (level, n).
-- If the last element is a number it is consumed as the level; n is adjusted.
local function _extractLevel(args, n)
    local lvl = 2
    if n > 0 and type(args[n]) == 'number' then
        lvl     = args[n]
        args[n] = nil
        n       = n - 1
    end
    return lvl, n
end

-- Format a pre-filtered message into a printable line.
-- Returns the formatted string, or nil if the message body is empty.
-- Produces: [side][LEVEL] message
-- The source label is intentionally omitted — on Helix the runtime already
-- stamps [packageName] on every line; duplicating it (or the logger id) inside
-- the body causes the noise we saw:
--   [tMenu][client]:  [tmenu/INFO] …   ← source redundant with runtime stamp
-- The side is the one piece neither runtime nor FiveM console adds on its own.
local function _format(source, lvl, args, n)
    local parts = {}
    for i = 1, n do
        parts[i] = tostring(args[i])
    end
    local text = table.concat(parts, ' ')

    -- Nothing to print — the call carried only a level with no message body.
    -- This can happen when a cross-VM export call drops the string argument;
    -- silently discard rather than emitting an empty labelled line.
    if text == '' then return nil end

    local label = _labels[lvl] or 'INFO'
    return string.format('[%s][%s] %s', _side, label, text)
end

-- All public surfaces delegate here.
-- source: string or nil
-- ...:    any values; if the last value is a number it is used as the log level
local function _emit(source, ...)
    local args = { ... }
    local n    = #args

    local lvl
    lvl, n     = _extractLevel(args, n)

    -- Filter before doing any string work — os.date and table.concat are skipped
    -- entirely for messages that fall below the minimum level.
    if lvl < _minLevel then return end

    local line = _format(source, lvl, args, n)
    if line then print(line) end
end

--- Emit a log line with no source label.
-- All args are tostring'd and joined with spaces.
-- If the last arg is a number it is treated as the log level (default: 2=INFO).
function Logger.log(...)
    _emit(nil, ...)
end

-- returns a log function pinned to a source name
--
-- @param  source  Non-empty string identifier, e.g. 'tLib/menu' or 'tMenu'
-- @return function(...)
--
-- Example:
--   local log = Logger.create('tLib/menu')
--   log('Player spawned', player)
--   log('Bad value', val, 3)        -- WARN
function Logger.create(source)
    assert(
        type(source) == 'string' and source ~= '',
        '[tLib/logger] create: source must be a non-empty string'
    )
    return function(...)
        _emit(source, ...)
    end
end

--- Register the WebUI event handler that forwards JS log calls to the console.
-- Call once from client.lua, passing the shared WebUI instance.
--
-- Expected event payload from JS:
--   { level: 'debug'|'info'|'warn'|'error', source: string, msg: any }
function Logger.init(ui)
    local levelMap = { debug = 1, info = 2, warn = 3, error = 4 }

    Platform.onUIEvent(ui, 'tLibLog', function(data)
        local rawLevel = type(data) == 'table' and data.level or 'info'
        local source   = type(data) == 'table' and data.source or 'ui'
        local msg      = type(data) == 'table' and data.msg or ''

        local level    = levelMap[tostring(rawLevel):lower()] or 2

        _emit('tLib/' .. tostring(source), tostring(msg), level)
    end)
end

--- Register tLib exports so other packages can emit logs without requiring
-- this file directly.  Called from client.lua (and intentionally NOT from
-- server.lua — see server.lua for the explanation).
--
-- Consuming packages MUST use colon-bracket notation to call these exports.
-- Dot notation silently drops string arguments at the Helix cross-VM boundary.
--
-- Returns a ready-to-call log function bound to a fixed source label.
--
--   local log = exports['tLib']:CreateLogger('tMenu', print)
--   log('Player spawned', player)   -- INFO
--   log('Bad value', val, 3)        -- WARN
--
-- Parameters
--   loggerId  string    Source label embedded in every output line.
--                       Use your package name here so output is attributable,
--                       e.g. 'tMenu', 'hx-inventory'.
--                       Produces lines like:
--                         [tLib][client] [HH:MM:SS] [tMenu/INFO] message
--   printFn   function  The consumer's print function.
--                       On Helix: Platform.wrapExport unwraps any shim key
--                       produced by tLibShim.lua into a live proxy before the
--                       handler sees it — always arrives as type 'function'.
--                       On FiveM: cross-resource function references are
--                       deserialised as a funcref (a callable table/userdata
--                       with a __call metamethod) rather than a plain Lua
--                       function.  Both are accepted as valid printFn values.
--   opts      table|nil Optional configuration:
--               minLevel  number  Override the global minimum log level for
--                                 this logger only. 1=DEBUG 2=INFO 3=WARN 4=ERROR
--
-- Returns a callable log function on both Helix and FiveM.
--   On Helix:  Platform.storeCallback stores the closure in tLib's VM and
--              returns a __tLibCb_ key; the consumer shim's unsanitiseReturn
--              wraps it back into a real callable in the consumer VM.
--   On FiveM:  the closure is returned directly.
--
-- Formats and returns a log line string (including the [package][side] prefix);
-- the caller owns the print call.
--
--   local line = exports['tLib']:Log('tMenu', { 'msg', 2 })
--   if line then print(line) end
--
--   exports['tLib']:SetLogLevel(1)  -- lower minimum level globally
function Logger.registerExports()
    -- Formats args into a fully-prefixed line string.
    -- On Helix the Helix runtime does NOT prepend package/timestamp on its own
    -- for cross-VM print calls that route through a proxy, so we include the
    -- full line (prefix + timestamp + source/level + message) and return it
    -- as-is.  The consumer calls print() on it and sees the complete line.
    -- Returns nil for filtered or empty messages.
    local function _formatForConsumer(loggerId, args)
        if type(args) ~= 'table' then return nil end

        local n = #args
        local lvl
        lvl, n = _extractLevel(args, n)

        if lvl < _minLevel then return nil end

        -- _format already includes the [package][side] [timestamp] prefix.
        return _format(loggerId, lvl, args, n)
    end

    -- Incoming: on Helix, Platform.wrapExport has already unwrapped any shim
    -- key for printFn into a live proxy callable.  On FiveM, cross-resource
    -- function references arrive as a callable funcref (table/userdata with a
    -- __call metamethod) rather than a plain Lua function — both are accepted.
    --
    -- Outgoing: a real Lua closure cannot cross the Helix VM boundary in the
    -- return direction — it would arrive as a dead address string in the
    -- consumer VM.  Platform.storeCallback handles this transparently:
    --   • Helix  — stores the closure in tLib's callback table, returns the key.
    --              tLibShim.lua's unsanitiseReturn wraps the key into a real
    --              callable in the consumer VM.
    --   • FiveM  — returns the closure directly; no key needed.
    -- The consumer always receives a real callable with no special handling.
    Platform.export('tLib', 'CreateLogger', function(loggerId, printFn, opts)
        if type(loggerId) ~= 'string' or loggerId == '' then
            print('[tLib/logger/ERROR] CreateLogger: loggerId must be a non-empty string')
            return nil
        end

        -- On FiveM, cross-resource function references are deserialised as a
        -- funcref — a callable table/userdata, not a plain Lua function.
        -- Accept anything that is either a function or has a __call metamethod.
        local printFnType = type(printFn)
        local printFnCallable = printFnType == 'function'
            or
            (printFnType == 'table' and type(getmetatable(printFn)) == 'table' and type(getmetatable(printFn).__call) == 'function')
            or
            (printFnType == 'userdata' and type(getmetatable(printFn)) == 'table' and type(getmetatable(printFn).__call) == 'function')
        if not printFnCallable then
            print('[tLib/logger/ERROR] CreateLogger: printFn must be a function (got '
                .. printFnType .. ' from logger "' .. loggerId .. '")')
            return nil
        end

        local localMin = (type(opts) == 'table' and type(opts.minLevel) == 'number')
            and opts.minLevel or nil

        -- Build the log closure.  printFn is always a real callable here
        -- (unwrapped from any shim key by Platform.wrapExport).
        local closure = function(...)
            local args = { ... }
            local savedMin
            if localMin then
                savedMin  = _minLevel
                _minLevel = localMin
            end
            local line = _formatForConsumer(loggerId, args)
            if localMin then _minLevel = savedMin end
            if line then printFn(line) end
        end

        -- Platform.storeCallback makes the return value safe across the Helix
        -- VM boundary.  On FiveM it is a transparent pass-through.
        return Platform.storeCallback(closure)
    end)

    Platform.export('tLib', 'Log', function(loggerId, args)
        if type(args) ~= 'table' then
            print(string.format(
                '[tLib/logger/ERROR] Log: args must be a table (got %s from logger "%s") — '
                .. 'use colon-bracket notation: exports["tLib"]:Log(...)',
                type(args), tostring(loggerId)
            ))
            return
        end

        return _formatForConsumer(loggerId, args)
    end)

    Platform.export('tLib', 'SetLogLevel', function(level)
        Logger.setLevel(level)
    end)
end
