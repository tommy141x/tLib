--[[
    tLib/shared/imports/diag — startup diagnostics that an operator can act on.

    Usage in a consumer:
        tlib.diag.fatal('Config does not exist. tRadio cannot start.', {
            cause = 'config/config.lua failed to load. Almost always a Lua syntax error in your edited copy.',
            fix   = { 'Scroll UP: FiveM printed the exact file and line just before this.' },
            once  = 'no-config',
        })

    Why this exists
    ---------------
    Every t* resource had grown its own hand-wrapped console banner: a row of
    dashes, a `^1[tName] ` prefix repeated on every line, and prose broken at
    whatever column the author's editor happened to be at. They were long, they
    drifted apart in shape, and — worst — they lived in `config/`, which is
    `escrow_ignore`'d. A bad upload that took out the config file also took out
    the error message explaining it.

    So the RENDERING lives here, in a module every resource already imports, and
    a caller writes prose instead of print lines. A ten-line block becomes three
    lines of Lua, which is the point: the blocks were not too loud, the source
    was too long, and shortening them by hand meant saying less to the operator.

    Nothing here decides anything. It prints.
]]

local Diag = {}

-- The dashed rule, and the column prose wraps at. 60 is what every existing
-- block in this codebase already used, so re-rendering one produces the same
-- shape rather than a diff in every console.
local RULE_WIDTH = 60
local WRAP_WIDTH = 60

local LEVELS = {
    fatal = { colour = '^1', prefix = 'FATAL: ' },
    error = { colour = '^1', prefix = '' },
    warn  = { colour = '^3', prefix = '' },
    info  = { colour = '^7', prefix = '' },
}

-- Keys already printed, for `once`. Per VM, so a consumer that restarts gets its
-- diagnostics again -- which is correct: a restart is when an operator is looking.
local _said = {}

--- Greedy word wrap. Returns a list of lines, each at most `width` characters.
---
--- `indent` is prepended to every line after the first, which is what makes a
--- bulleted fix item hang under its own dash instead of resetting to column 0.
--- A single word longer than the width is left over-long rather than split: it
--- is nearly always a path, a resource name or a URL, and breaking one of those
--- turns a message an operator can copy into one they cannot.
--- @param text string
--- @param width number
--- @param indent string|nil
--- @return table
function Diag.wrap(text, width, indent)
    indent = indent or ''
    text = tostring(text)
    -- Leading whitespace is meaningful -- it is how a caller writes a bullet
    -- ('  - do the thing') -- and tokenising on %S+ would silently eat it,
    -- un-indenting every bulleted line in the block.
    local lines, line = {}, text:match('^%s*') or ''
    for word in text:gmatch('%S+') do
        local candidate = line:match('^%s*$') and (line .. word) or (line .. ' ' .. word)
        if #candidate > width and not line:match('^%s*$') then
            lines[#lines + 1] = line
            line = indent .. word
        else
            line = candidate
        end
    end
    if line ~= '' then lines[#lines + 1] = line end
    if #lines == 0 then lines[1] = '' end
    return lines
end

--- The lines a block would print, without printing them.
---
--- Split out from say() so a test can assert on the text rather than on a print
--- spy, and so a caller that wants the block somewhere other than the console --
--- a support dump, an admin panel -- can have it.
--- @param level string  'fatal' | 'error' | 'warn' | 'info'
--- @param title string  one sentence, the thing that is wrong
--- @param opts table|nil { cause, fix, detail, scope }
--- @return table lines
function Diag.render(level, title, opts)
    opts = opts or {}
    local spec  = LEVELS[level] or LEVELS.error
    local scope = opts.scope
        or (GetCurrentResourceName and GetCurrentResourceName())
        or 'tLib'

    local body = {}
    local function add(text) body[#body + 1] = text end
    local function blank() body[#body + 1] = '' end

    for _, l in ipairs(Diag.wrap(spec.prefix .. tostring(title), WRAP_WIDTH)) do add(l) end

    if opts.cause then
        blank()
        for _, l in ipairs(Diag.wrap(opts.cause, WRAP_WIDTH)) do add(l) end
    end

    -- A string is one fix, a table is several. Accepting both keeps the common
    -- case -- there is one thing to do -- from needing a table literal.
    local fixes = opts.fix
    if type(fixes) == 'string' then fixes = { fixes } end
    if type(fixes) == 'table' and #fixes > 0 then
        blank()
        add(#fixes > 1 and 'Fix it one of these ways:' or 'To fix:')
        for _, fix in ipairs(fixes) do
            -- Hanging indent of four, so a wrapped fix lines up under its own
            -- text rather than under the dash.
            for _, l in ipairs(Diag.wrap('  - ' .. fix, WRAP_WIDTH, '    ')) do add(l) end
        end
    end

    if opts.detail then
        blank()
        for _, l in ipairs(Diag.wrap(opts.detail, WRAP_WIDTH)) do add(l) end
    end

    local rule  = string.rep('-', RULE_WIDTH)
    local lines = { ('%s[%s] %s^7'):format(spec.colour, scope, rule) }
    for _, l in ipairs(body) do
        -- A blank body line still carries the prefix and a space. Without the
        -- trailing space FiveM's console trims the line and the block loses its
        -- left edge halfway down.
        lines[#lines + 1] = ('%s[%s] %s^7'):format(spec.colour, scope, l == '' and ' ' or l)
    end
    lines[#lines + 1] = ('%s[%s] %s^7'):format(spec.colour, scope, rule)
    return lines
end

--- Print a diagnostic block.
---
--- print(), never a logger: every caller of this is explaining why something is
--- broken, and a log level is exactly the thing an operator in that situation has
--- not configured. Returns true if it printed, false if `once` suppressed it.
--- @param level string
--- @param title string
--- @param opts table|nil  { cause, fix, detail, scope, once }
--- @return boolean printed
function Diag.say(level, title, opts)
    opts = opts or {}
    if opts.once ~= nil then
        local key = tostring(opts.once)
        if _said[key] then return false end
        _said[key] = true
    end
    for _, line in ipairs(Diag.render(level, title, opts)) do print(line) end
    return true
end

function Diag.fatal(title, opts) return Diag.say('fatal', title, opts) end
function Diag.error(title, opts) return Diag.say('error', title, opts) end
function Diag.warn(title, opts) return Diag.say('warn', title, opts) end
function Diag.info(title, opts) return Diag.say('info', title, opts) end

--- Has this `once` key already been used? For a caller that wants to skip the
--- work of BUILDING a message it is about to have suppressed.
--- @param key string
--- @return boolean
function Diag.said(key) return _said[tostring(key)] == true end

--- Forget every `once` key. Tests, and a consumer that deliberately wants a
--- block repeated after some state has changed.
function Diag.reset() _said = {} end

return Diag
