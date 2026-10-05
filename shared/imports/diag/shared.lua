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


--[[============================================================================
    `<resource>_diag` — the paste-safe status command, once.

        tlib.diag.command({
            name   = 'tradar_diag',
            title  = 'tRadar diagnostics',
            spec   = tradarConfigSpec,
            report = function(ctx)
                ctx.section('config')
                ctx.kv('band', Config.band)
            end,
        })

    ── Why this exists ─────────────────────────────────────────────────────────

    tscripts-config-standard §13 asks every resource for one console command
    that prints a pre-redacted, paste-safe status, because the alternative is
    what actually happens without it: an owner asked "what does your setup look
    like" pastes their whole config file, credentials included, into a public
    Discord.

    EIGHT resources had written that command by hand — tDetector, tRadar, tUnit,
    tAFK, tChirp, tRadio, tCAD and tELS — and tRadio and tCAD shared 54 lines of
    literal copy-paste including byte-identical `meta()` and `convarSet()`
    helpers. The report CONTENT differed for real reasons, and still does: it is
    a callback. Everything else differed for no reason at all, and four of the
    differences were safety properties that one copy had and the others had
    simply not thought of:

      * **Redaction.** tDetector keyed a redactor on the key's NAME rather than
        on a list of known-secret keys, with the reason written down: "the
        failure mode being guarded against is a key added later by somebody who
        did not read §13 — and the whole value of this command is that an owner
        can paste its output without reading it first. A redactor that has to be
        updated to keep working is a redactor that silently stops working."
        tRadio withheld whole validation messages that named one of its secrets.
        tRadar, tUnit, tAFK and tChirp had NO redactor, each justified by "this
        config holds no secrets" — which is exactly the assumption tDetector's
        own comment says is unsafe over time.

        So redaction is ON by default here, in both forms, and it is DERIVED
        rather than hand-listed: `harvest` walks the config for values whose key
        name looks like a credential, and no line containing one of those values
        survives. A resource whose config gains `Config.webhookUrl` next year is
        covered without anybody editing this file or that one.

      * **The pcall guard.** Only tRadar had it, with the reason: "a diagnostic
        that dies mid-report is worse than none: the owner pastes half a page
        and nobody can tell it is half." tAFK and tELS copied it from there; the
        other five would have printed a truncated report with no sign that it
        was truncated. It is the default now, and the partial report is still
        flushed before the failure line — a report that died at line 40 still
        answers thirty-nine questions, and discarding those to print one error
        is the same loss the guard exists to prevent.

      * **Spec-derived key listing.** Only tDetector derived the printed key
        list from the config spec and APPENDED anything the spec did not know
        about; everyone else hand-listed, and a hand-listed dump silently omits
        every key added after it was written. `ctx.configKeys()` is that
        behaviour, available to anyone who passes a `spec`.

      * **ACE gating.** `RegisterCommand(..., true)` — restricted — is applied
        here rather than by the caller, so copy number nine cannot forget it.

    ── Routing: the merge, not a pick ──────────────────────────────────────────

    The eight copies had three routings: the server console only (tRadar, tAFK),
    the console OR `chat:addMessage` depending on the source (tUnit, tRadio,
    tCAD, tChirp), and the console AND a client event (tDetector).

    The default is the union, because each copy's reasoning was right about its
    own half and silent about the other. tDetector's: the console copy is "the
    copy that survives the player disconnecting", so it is unconditional.
    tRadar's report had to OPEN by saying it had printed somewhere else — a line
    that exists only because an in-game caller got silence. So: the console
    always, and the caller too when there was one.

    `route = 'console'` remains, for a client-side command where there is no
    `TriggerClientEvent` to reach anybody with.

    ── What is NOT here ────────────────────────────────────────────────────────

    Any opinion about what a report should say. Section names, ordering, which
    fields matter and which of them are a verdict rather than a value are the
    consumer's, and they are the half of these files that was never duplicated.
==============================================================================]]

-- Keyed on the NAME, not on a list of known-secret keys. See the block above:
-- the guarded failure is a credential key added later by somebody who did not
-- read §13, and a redactor that has to be updated to keep working is a redactor
-- that silently stops working.
Diag.SECRET_PATTERNS = {
    'secret', 'token', 'password', 'passwd', 'apikey', 'api_key',
    'webhook', 'licence', 'license', 'credential', 'privatekey', 'private_key',
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
--- useful fact — "authToken not set" answers most of the tickets that ask for
--- this command — and whose value is never printable.
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
--- raises on a resource that is not installed, and asking about one that might
--- not be is the whole point of a dependency section.
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
--- The pcall is tAFK's, not tRadar's: tRadar called the native bare, so a
--- typo'd dependency name would have taken the whole report down.
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

--- A value rendered for a dump, redacted by key NAME.
---
--- Tables are summarised rather than expanded: a 25-entry coordinate list would
--- bury the four lines somebody is actually looking for. A key/value table is
--- shown one level deep, because those are the sensitivity / bandRange / lockout
--- tables and their numbers are what a range question turns on.
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
--- found under.
---
--- This is what makes redaction derived rather than hand-listed. Nothing names a
--- secret: a key whose NAME reads like one and whose value is a non-trivial
--- string is treated as one, so a config that gains a credential next year is
--- covered without this file or the consumer's changing.
---
--- Short values are skipped deliberately. The scan in `redactor` is a plain
--- substring match over every emitted line, and a three-character "secret" would
--- withhold half the report for no gain — a value that short is not a credential
--- anybody could use. `extraNames` adds keys the pattern list would miss
--- (tRadio's `adminPassword` and `discord.clientSecret` both match; a
--- hypothetical `Config.key` would not).
---
--- Depth-limited and cycle-safe: a config may legitimately contain a cycle, and
--- a diagnostic that hangs is a diagnostic that looks like a crashed server.
--- @param config table|nil
--- @param extraNames table|nil  extra key names to treat as credentials
--- @return table list of { key = string, value = string }
function Diag.harvest(config, extraNames)
    local found, seen = {}, {}

    local extra = {}
    for _, name in ipairs(extraNames or {}) do
        extra[tostring(name):lower()] = true
        -- A dotted path is registered by its leaf too, because that is the key
        -- name the walk below actually sees.
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

--- The line filter a report is passed through.
---
--- Returns function(line) -> line. A line carrying a harvested credential is
--- replaced wholesale rather than patched, because a line that quotes a secret
--- usually quotes it inside prose ("expected a string, got \"hunter2\"") and
--- there is no reliable way to cut the value out of that and leave a sentence an
--- operator can act on. tRadio's hand-written version of this rule said the same
--- thing and withheld the whole message.
---
--- `secrets` is what `harvest` returned. An empty list yields the identity
--- filter, which is the common case and costs nothing.
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

--- The config keys to print, in presentation order, with nothing dropped.
---
--- tDetector's `orderedConfigKeys`, generalised. Three passes, and the third is
--- the one worth having: `order` first, so the dump reads like config.lua rather
--- than like a hash table; then every other key the SPEC declares; then every
--- string key in the table the spec does NOT declare. Those last are the keys
--- the startup validator warned were doing nothing, and they are the most useful
--- lines in the whole dump — "I set that and it had no effect" is the ticket and
--- this is the evidence. They are also why `describe` redacts by key name rather
--- than from a list: a key nobody declared is by definition a key nobody vetted.
---
--- `order` is presentation only. It is NOT the list of what gets printed, which
--- is what a hand-maintained list silently becomes.
--- @param spec table|nil  a tlib.config spec; `spec.keys` is read
--- @param order table|nil
--- @param config table|nil
--- @return table
function Diag.configKeys(spec, order, config)
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
--- For a report produced by a renderer the consumer already owns and that PRINTS
--- rather than returning lines — tELS's `telsReportEnv`, which its startup path
--- shares — where `command`'s line pipeline has nothing to filter and would only
--- be a more expensive pcall. The uniform failure line is the point: "a
--- diagnostic that dies mid-report is worse than none, because the owner pastes
--- half a page and nobody can tell that it is half."
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
---   config   table|nil   the table credentials are harvested from. Defaults to
---                        the global `Config` when there is one; `false`
---                        harvests nothing.
---   spec     table|nil   a tlib.config spec, enabling `ctx.configKeys()`.
---   order    table|nil   presentation order for `ctx.configKeys()`.
---   secrets  table|nil   extra credential key names beyond SECRET_PATTERNS.
---   redact   boolean|nil ⚠️ defaults to TRUE. `false` exists for the suite's
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
---   ctx.section(t)   a '── t ──' divider.
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

        -- Harvested per invocation, not once at registration: `Config` is
        -- mutated after boot — a spec fills its defaults, an admin panel writes
        -- into it — and a credential that arrives afterwards must still be
        -- covered. This runs once per human-typed command, so the walk is free.
        local config = opts.config
        if config == nil then config = rawget(_G, 'Config') end
        local secrets = redact
            and Diag.harvest(type(config) == 'table' and config or nil, opts.secrets)
            or {}
        local filter = redact and Diag.redactor(secrets) or function(line) return line end

        local function emit(text) out[#out + 1] = filter(text) end

        local secretNames = {}
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
        ---
        --- Withheld when it names a credential, which is tRadio's rule and the
        --- reason it existed: these messages quote the offending VALUE by
        --- design, so one about a credential is a disclosure in the one command
        --- whose whole value is that it can be pasted without being read first.
        --- The value filter catches it too; this catches the case where the
        --- message transformed the value — masked it, named its type — and so no
        --- longer contains it literally.
        ---
        --- Newline-continued rather than flattened. tDetector collapsed these to
        --- one line with ' / ' and tRadar with ' | '; both lose the `Cause:` and
        --- `Fix:` paragraphs that the validators go to some trouble to write, and
        --- those paragraphs are the half an operator can act on.
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
