--[[
    tLib/shared/imports/diag — startup diagnostics that an operator can act on.

    Usage in a consumer:
        tlib.diag.fatal('Config does not exist. tRadio cannot start.', {
            cause = 'config/config.lua failed to load. Almost always a Lua syntax error in your edited copy.',
            fix   = { 'Scroll UP: FiveM printed the exact file and line just before this.' },
            once  = 'no-config',
        })

    Nothing here decides anything. It prints.
    Design notes: docs/internal/diag-command.md
]]

local Diag = {}

local RULE_WIDTH = 60
local WRAP_WIDTH = 60

local LEVELS = {
    fatal = { colour = '^1', prefix = 'FATAL: ' },
    error = { colour = '^1', prefix = '' },
    warn  = { colour = '^3', prefix = '' },
    info  = { colour = '^7', prefix = '' },
}

local _said = {}

--- Greedy word wrap. Returns a list of lines, each at most `width` characters.
--- `indent` is prepended to every line after the first, so a bulleted fix hangs
--- under its own dash. An over-long single word is left unsplit: it is nearly
--- always a path or a URL, and breaking one makes it uncopyable.
--- @param text string
--- @param width number
--- @param indent string|nil
--- @return table
function Diag.wrap(text, width, indent)
    indent = indent or ''
    text = tostring(text)
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

--- The lines a block would print, without printing them. Split out so a test
--- can assert on the text, and so a support dump or an admin panel can have it.
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

    local fixes = opts.fix
    if type(fixes) == 'string' then fixes = { fixes } end
    if type(fixes) == 'table' and #fixes > 0 then
        blank()
        add(#fixes > 1 and 'Fix it one of these ways:' or 'To fix:')
        for _, fix in ipairs(fixes) do
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
        lines[#lines + 1] = ('%s[%s] %s^7'):format(spec.colour, scope, l == '' and ' ' or l)
    end
    lines[#lines + 1] = ('%s[%s] %s^7'):format(spec.colour, scope, rule)
    return lines
end

--- Print a diagnostic block. print(), never a logger: every caller is
--- explaining why something is broken, and a log level is the thing an operator
--- in that situation has not configured.
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

--- Has this `once` key already been used? For a caller that wants to skip
--- BUILDING a message it is about to have suppressed.
--- @param key string
--- @return boolean
function Diag.said(key) return _said[tostring(key)] == true end

function Diag.reset() _said = {} end


-- Keyed on the key NAME, not a list of known secrets: the guarded failure is a
-- credential key added later by somebody who did not read the standard.
--
-- This list is the SINGLE SOURCE for the commit/release/CI secret gate too.
-- shared/ts/secrets/patterns.ts PARSES the literal below out of this file, and
-- scripts/secret-gate.test.ts asserts the two agree as a set. Keep it a flat
-- list of single-quoted lowercase strings on contiguous lines -- the parser is
-- deliberately strict and refuses any other shape.
Diag.SECRET_PATTERNS = {
    'secret', 'token', 'password', 'passwd', 'apikey', 'api_key',
    'webhook', 'licence', 'license', 'credential', 'privatekey', 'private_key',
    'accesskey', 'access_key', 'privkey', 'passphrase', 'bearer', 'signingkey',
}

--- Does this key name read like a credential?
--- @param name any
--- @return boolean
function Diag.isSecretName(name)
    local lower = tostring(name):lower()
    for _, pattern in ipairs(Diag.SECRET_PATTERNS) do
        if lower:find(pattern, 1, true) then return true end
    end
    return false
end

--- `set` / `not set`, never the value. For a credential whose PRESENCE is the
--- useful fact and whose value is never printable.
--- @param value any
--- @return string
function Diag.presence(value)
    if type(value) == 'string' and value ~= '' then return 'set' end
    if value == nil then return 'not set' end
    if type(value) ~= 'string' then return ('not set (wrong type: %s)'):format(type(value)) end
    return 'not set'
end

--- `set` / `not set` for a convar, without raising where GetConvar is absent.
--- @param name string
--- @return string
function Diag.convarSet(name)
    if type(GetConvar) ~= 'function' then return 'unknown' end
    local ok, value = pcall(GetConvar, name, '')
    return (ok and value ~= '') and 'set' or 'not set'
end

--- A resource's metadata field, or 'unknown'. pcall'd: GetResourceMetadata
--- raises on a resource that is not installed, which is the whole point of a
--- dependency section.
--- @param resource string
--- @param key string|nil  defaults to 'version'
--- @return string
function Diag.meta(resource, key)
    if type(GetResourceMetadata) ~= 'function' then return 'unknown' end
    local ok, value = pcall(GetResourceMetadata, resource, key or 'version', 0)
    if ok and type(value) == 'string' and value ~= '' then return value end
    return 'unknown'
end

--- `started` / `stopped` / `missing`, without raising on an unknown resource.
--- @param name string
--- @return string
function Diag.resourceState(name)
    if type(GetResourceState) ~= 'function' then return 'missing' end
    local ok, state = pcall(GetResourceState, name)
    if not ok or type(state) ~= 'string' or state == '' then return 'missing' end
    return state
end

--- How many entries, for a table reported as a count rather than a listing.
--- @param tbl any
--- @return number
function Diag.count(tbl)
    if type(tbl) ~= 'table' then return 0 end
    local n = 0
    for _ in pairs(tbl) do n = n + 1 end
    return n
end

--- A value rendered for a dump, redacted by key NAME. Tables are summarised
--- rather than expanded, one level deep for a key/value table.
--- @param name any  the key this value was found under
--- @param value any
--- @return string
function Diag.describe(name, value)
    if Diag.isSecretName(name) then return '<redacted>' end

    local kind = type(value)
    if kind == 'string' then return ('%q'):format(value) end
    if kind == 'nil' then return 'not set' end
    if kind == 'function' then return 'a function in config.lua' end
    if kind ~= 'table' then return tostring(value) end

    if #value > 0 then return ('list of %d'):format(#value) end

    local names = {}
    for k in pairs(value) do names[#names + 1] = tostring(k) end
    table.sort(names)
    if #names == 0 then return '{ }' end

    local parts = {}
    for _, k in ipairs(names) do
        local v = value[k]
        if type(v) == 'table' then
            parts[#parts + 1] = ('%s = { %d entries }'):format(k, Diag.count(v))
        else
            parts[#parts + 1] = ('%s = %s'):format(k, Diag.describe(k, v))
        end
    end
    return ('{ %s }'):format(table.concat(parts, ', '))
end

--- Every credential-looking string value in a config table, with the key it was
--- found under. This is what makes redaction derived rather than hand-listed.
--- Depth-limited and cycle-safe; short values are skipped deliberately.
--- @param config table|nil
--- @param extraNames table|nil  extra key names to treat as credentials
--- @return table list of { key = string, value = string }
function Diag.harvest(config, extraNames)
    local found, seen = {}, {}

    local extra = {}
    for _, name in ipairs(extraNames or {}) do
        extra[tostring(name):lower()] = true
        local leaf = tostring(name):match('[^.]+$')
        if leaf then extra[leaf:lower()] = true end
    end

    local function walk(tbl, depth)
        if type(tbl) ~= 'table' or depth > 4 or seen[tbl] then return end
        seen[tbl] = true
        for key, value in pairs(tbl) do
            if type(value) == 'table' then
                walk(value, depth + 1)
            elseif type(value) == 'string' and #value >= 6 then
                if Diag.isSecretName(key) or extra[tostring(key):lower()] then
                    found[#found + 1] = { key = tostring(key), value = value }
                end
            end
        end
    end

    walk(config, 1)
    return found
end

--- The NAMES of every credential-looking key present in a config table,
--- whatever the type of the value. `harvest` cannot supply these: it collects
--- values for the substring filter, and an unquoted credential is a number.
--- @param config table|nil
--- @param extraNames table|nil  extra key names to treat as credentials
--- @return table list of key names, de-duplicated
function Diag.secretKeys(config, extraNames)
    local names, listed, seen = {}, {}, {}

    local extra = {}
    for _, name in ipairs(extraNames or {}) do
        extra[tostring(name):lower()] = true
        local leaf = tostring(name):match('[^.]+$')
        if leaf then extra[leaf:lower()] = true end
    end

    local function walk(tbl, depth)
        if type(tbl) ~= 'table' or depth > 4 or seen[tbl] then return end
        seen[tbl] = true
        for key, value in pairs(tbl) do
            if type(value) == 'table' then
                walk(value, depth + 1)
            elseif value ~= nil and value ~= '' then
                local name = tostring(key)
                if not listed[name] and (Diag.isSecretName(key) or extra[name:lower()]) then
                    listed[name] = true
                    names[#names + 1] = name
                end
            end
        end
    end

    walk(config, 1)
    return names
end

--- The line filter a report is passed through. A line carrying a harvested
--- credential is replaced wholesale rather than patched: a line that quotes a
--- secret usually quotes it inside prose.
--- @param secrets table list of { key, value }
--- @return function
function Diag.redactor(secrets)
    if type(secrets) ~= 'table' or #secrets == 0 then
        return function(line) return line end
    end
    return function(line)
        local text = tostring(line)
        for _, entry in ipairs(secrets) do
            if text:find(entry.value, 1, true) then
                return ('  (withheld: this line contained the value of %s)'):format(entry.key)
            end
        end
        return text
    end
end

--- The config keys to print, in presentation order, with nothing dropped: the
--- third pass lists keys the spec does NOT declare, which are the ones the
--- validator warned were doing nothing. `order` is presentation only, never the
--- list of what gets printed. A `spec` may be a table or a function.
--- @param spec table|function|nil  a tlib.config spec; `spec.keys` is read
--- @param order table|nil
--- @param config table|nil
--- @return table
function Diag.configKeys(spec, order, config)
    if type(spec) == 'function' then
        local ok, built = pcall(spec)
        spec = ok and built or nil
    end
    local keys = (type(spec) == 'table' and type(spec.keys) == 'table') and spec.keys or {}
    local seen, out = {}, {}

    for _, key in ipairs(order or {}) do
        if keys[key] and not seen[key] then
            seen[key] = true
            out[#out + 1] = key
        end
    end

    local rest = {}
    for key in pairs(keys) do
        if not seen[key] then
            seen[key] = true
            rest[#rest + 1] = tostring(key)
        end
    end
    table.sort(rest)
    for _, key in ipairs(rest) do out[#out + 1] = key end

    local extra = {}
    for key in pairs(type(config) == 'table' and config or {}) do
        if type(key) == 'string' and not seen[key] then
            seen[key] = true
            extra[#extra + 1] = key
        end
    end
    table.sort(extra)
    for _, key in ipairs(extra) do out[#out + 1] = key end

    return out
end

--- The strictest half of `command`, on its own: a restricted console command
--- whose body cannot take the report down with it.
---
--- @param name string  the command name; also named in the failure line
--- @param body function  called with (source, args, raw)
--- @param scope string|nil  defaults to the current resource
function Diag.guard(name, body, scope)
    scope = scope or (GetCurrentResourceName and GetCurrentResourceName()) or 'tLib'
    RegisterCommand(name, function(source, args, raw)
        local ok, err = pcall(body, source, args, raw)
        if not ok then
            print(('^1[%s] %s failed partway through: %s^7')
                :format(scope, name, tostring(err)))
        end
    end, true)   -- restricted: the console always, a player needs the ACE
end

--- Register a `<resource>_diag` command.
---
--- @param opts table
---   name     string    the command name. Required.
---   report   function  called with a `ctx` (below) to build the report. Required.
---   title    string|nil  header line; defaults to '<scope> diagnostics'.
---   scope    string|nil  label; defaults to the current resource name.
---   config   table|function|false|nil
---                        the table credentials are harvested from. Defaults to
---                        the global `Config` when there is one; `false`
---                        harvests nothing; a FUNCTION is called per invocation,
---                        for a resource whose state is loaded rather than a
---                        global (tAFK's data.json, tELS's serverDefaults).
---   spec     table|nil   a tlib.config spec, enabling `ctx.configKeys()`.
---   order    table|nil   presentation order for `ctx.configKeys()`.
---   secrets  table|nil   extra credential key names beyond SECRET_PATTERNS.
--- redact boolean|nil defaults to TRUE. `false` exists for the suite's
---                        negative control and for nothing else.
---   route    string|nil  'both' (default) | 'console' | 'caller'.
---   event    string|nil  a client event to deliver the line list on, instead of
---                        chat, for a consumer whose UI renders the report.
---   prefix   string|nil  per-console-line prefix, e.g. '[tRadar] '.
---   footer   string|nil  closing note; defaults to the paste-safety statement.
---
--- The `ctx` handed to `report`:
---   ctx.src          the command source; 0 is the server console.
---   ctx.console      true when the caller IS the console, so a section can be
---                    verbose where chat would be a wall of text (tUnit's rule).
---   ctx.line(fmt,…)  one line, `string.format`ed when given arguments.
---   ctx.blank()      a blank line.
--- ctx.section(t) a ' t ' divider.
---   ctx.kv(k,v,w)    'k   <described v>', redacted by key name.
---   ctx.message(m)   a validation message: indented, newline-continued, and
---                    WITHHELD when it names one of the harvested credentials.
---   ctx.messages(r)  every warning then every error in a tlib.config report, or
---                    'no problems' when there are none.
---   ctx.presence / describe / meta / convarSet / resourceState / count / yesNo
---   ctx.configKeys() the spec-derived key list.
function Diag.command(opts)
    assert(type(opts) == 'table', 'tlib.diag.command: an opts table is required')
    local name = assert(opts.name, 'tlib.diag.command: name is required')
    local build = assert(opts.report, 'tlib.diag.command: a report function is required')
    local scope = opts.scope or (GetCurrentResourceName and GetCurrentResourceName()) or 'tLib'
    local route = opts.route or 'both'
    local prefix = opts.prefix or ''
    local redact = opts.redact ~= false

    RegisterCommand(name, function(source)
        local src = tonumber(source) or 0
        local out = {}

        local config = opts.config
        if config == nil then config = rawget(_G, 'Config') end
        if type(config) == 'function' then
            local ok, loaded = pcall(config)
            config = ok and loaded or nil
        end
        local secrets = redact
            and Diag.harvest(type(config) == 'table' and config or nil, opts.secrets)
            or {}
        local filter = redact and Diag.redactor(secrets) or function(line) return line end

        local function emit(text) out[#out + 1] = filter(text) end

        local secretNames = redact
            and Diag.secretKeys(type(config) == 'table' and config or nil, opts.secrets)
            or {}
        for _, entry in ipairs(secrets) do secretNames[#secretNames + 1] = entry.key end

        local ctx = {
            src = src,
            console = src == 0,
            describe = Diag.describe,
            presence = Diag.presence,
            meta = Diag.meta,
            convarSet = Diag.convarSet,
            resourceState = Diag.resourceState,
            count = Diag.count,
        }

        function ctx.line(fmt, ...)
            emit(select('#', ...) > 0 and tostring(fmt):format(...) or tostring(fmt))
        end

        function ctx.blank() emit('') end

        function ctx.section(text) emit(('── %s ──'):format(tostring(text))) end

        function ctx.kv(key, value, width)
            emit(('  %-' .. tostring(width or 24) .. 's %s')
                :format(tostring(key), Diag.describe(key, value)))
        end

        function ctx.yesNo(value) return value and 'yes' or 'no' end

        function ctx.configKeys() return Diag.configKeys(opts.spec, opts.order, config) end

        --- A validation message, indented and newline-continued.
        function ctx.message(message)
            local text = tostring(message)
            for _, key in ipairs(secretNames) do
                if text:find(key, 1, true) then
                    emit(('  (a problem with %s — withheld here; see the server console)'):format(key))
                    return
                end
            end
            emit('  ' .. (text:gsub('\n%s*', '\n    ')))
        end

        function ctx.messages(report)
            report = type(report) == 'table' and report or {}
            local warnings, errors = report.warnings or {}, report.errors or {}
            if #warnings == 0 and #errors == 0 then
                emit('  no problems.')
                return
            end
            for _, message in ipairs(warnings) do ctx.message('WARN  ' .. tostring(message)) end
            for _, message in ipairs(errors) do ctx.message('ERROR ' .. tostring(message)) end
        end

        emit(('──────── %s ────────'):format(opts.title or (scope .. ' diagnostics')))

        local ok, err = pcall(build, ctx)
        if not ok then
            emit('')
            emit(('^1%s failed partway through: %s^7'):format(name, tostring(err)))
            emit('^1Everything above is accurate; everything after this point is missing.^7')
        end

        emit('')
        emit(opts.footer or 'No credentials appear above; this output is safe to paste.')
        emit('─────────────────────────────────────────')

        if route ~= 'caller' or src == 0 then
            for _, text in ipairs(out) do print(prefix .. text) end
        end

        if src > 0 and route ~= 'console' and type(TriggerClientEvent) == 'function' then
            if opts.event then
                TriggerClientEvent(opts.event, src, out)
            else
                for _, text in ipairs(out) do
                    TriggerClientEvent('chat:addMessage', src, { args = { '[' .. scope .. ']', text } })
                end
            end
        end

        return out
    end, true)   -- restricted: the console always, a player needs the ACE

    return name
end

return Diag
