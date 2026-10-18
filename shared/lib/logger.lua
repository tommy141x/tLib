-- Levels: 1=DEBUG 2=INFO 3=WARN 4=ERROR

Logger          = {}

local _labels   = { [1] = 'DEBUG', [2] = 'INFO', [3] = 'WARN', [4] = 'ERROR' }
local _minLevel = 2

function Logger.setLevel(level)
    assert(type(level) == 'number', '[tLib/logger] setLevel: level must be a number')
    _minLevel = level
end

-- Side is the one piece of context the console does not add on its own.
local _side = Platform.getSide()

-- Consumes a trailing numeric argument as the level, returning (level, n).
local function _extractLevel(args, n)
    local lvl = 2
    if n > 0 and type(args[n]) == 'number' then
        lvl     = args[n]
        args[n] = nil
        n       = n - 1
    end
    return lvl, n
end

-- Produces "[source][LEVEL] message" -- or "[side]..." when unpinned -- or nil
-- when the body is empty.
local function _format(source, lvl, args, n)
    local parts = {}
    for i = 1, n do
        parts[i] = tostring(args[i])
    end
    local text = table.concat(parts, ' ')

    -- A call carrying only a level, with no body: discard rather than emitting an
    -- empty labelled line.
    if text == '' then return nil end

    -- `source` when the caller pinned one, `_side` otherwise. It was taken and
    -- then dropped: every `Logger.create('tLib/menu')` line printed `[server]`,
    -- so thirty-odd modules were indistinguishable in the console and the
    -- docstring on `create` described behaviour that did not happen.
    -- `Logger.log` passes nil and still reads `[server]` / `[client]`.
    local label = _labels[lvl] or 'INFO'
    return string.format('[%s][%s] %s', source or _side, label, text)
end

local function _emit(source, ...)
    local args = { ... }
    local n    = #args

    local lvl
    lvl, n     = _extractLevel(args, n)

    -- Filter before any string work.
    if lvl < _minLevel then return end

    local line = _format(source, lvl, args, n)
    if line then print(line) end
end

--- Args are tostring'd and joined with spaces; a trailing number is the level.
function Logger.log(...)
    _emit(nil, ...)
end

--- Returns a log function pinned to a source name:
---   local log = Logger.create('tLib/menu')
---   log('Bad value', val, 3)  -- WARN
function Logger.create(source)
    assert(
        type(source) == 'string' and source ~= '',
        '[tLib/logger] create: source must be a non-empty string'
    )
    return function(...)
        _emit(source, ...)
    end
end

--- Forwards JS log calls to the console. Called once from client.lua with the
--- shared WebUI instance. Payload: { level, source, msg }.
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

--- Log exports for consuming resources. Registered from client.lua only, not
--- server.lua.
---
---   local log = exports['tLib']:CreateLogger('tMenu', print)
---   log('Bad value', val, 3)                      -- WARN
---   local line = exports['tLib']:Log('tMenu', { 'msg', 2 })
---
--- `Log` returns a formatted line and leaves the print call to the caller.
--- CreateLogger's optional `opts.minLevel` overrides the global level for that
--- logger alone.
function Logger.registerExports()
    -- Returns nil for filtered or empty messages.
    local function _formatForConsumer(loggerId, args)
        if type(args) ~= 'table' then return nil end

        local n = #args
        local lvl
        lvl, n = _extractLevel(args, n)

        if lvl < _minLevel then return nil end

        return _format(loggerId, lvl, args, n)
    end

    Platform.export('tLib', 'CreateLogger', function(loggerId, printFn, opts)
        if type(loggerId) ~= 'string' or loggerId == '' then
            print('[tLib/logger/ERROR] CreateLogger: loggerId must be a non-empty string')
            return nil
        end

        -- Cross-resource function references deserialise as a funcref: a callable
        -- table or userdata rather than a plain function.
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
