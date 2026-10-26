-- Startup validation for an owner-edited config.lua.
--
--   local ok = tlib.config.check(Config, {
--       file = 'shared/config.lua',
--       keys = {
--           detectionRangeMeters = { type = 'number', default = 500.0, min = 1, max = 2000 },
--           speedUnit            = { type = 'string', default = 'kmh', oneOf = { 'kmh', 'mph' } },
--           radarResources       = { type = 'list',   default = {} },
--       },
--   })
--   if not ok then return end
--
-- Why this exists: a mistyped config key used to do nothing at all, forever,
-- without a word, and the ad-hoc guards some resources had would silently
-- substitute a hardcoded fallback that could differ from the shipped default.
--
-- Rules enforced: report every problem at once, not just the first; every
-- message names the file, the key, what was expected and how to fix it; an
-- unknown key warns with a suggestion; a missing required value is fatal; a
-- rejected value is NEVER silently replaced by the default. Defaults ARE
-- written in for keys the owner omitted -- filling a gap is fine, overwriting
-- a stated intention is not.

local configMod = {}

-- Formatting helpers

--- Renders a value for an error message: quoted if a string, so `"500"` and
--- `500` are visibly different. That distinction IS the bug in most reports.
local function show(value)
    local t = type(value)
    if t == 'string' then return ('"%s"'):format(value) end
    if t == 'table' then return 'a table' end
    if value == nil then return 'nothing' end
    return tostring(value)
end

local function typeName(value)
    local t = type(value)
    if t == 'boolean' then return 'a boolean' end
    if t == 'number' then return 'a number' end
    if t == 'string' then return 'a string' end
    if t == 'table' then return 'a table' end
    if t == 'nil' then return 'nothing' end
    return 'a ' .. t
end

local function joinQuoted(list)
    local parts = {}
    for i, v in ipairs(list) do parts[i] = ('"%s"'):format(tostring(v)) end
    return table.concat(parts, ', ')
end

--- Whether a table is a sequence (1..n, no holes) -- i.e. a Lua "list".
local function isList(value)
    if type(value) ~= 'table' then return false end
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    for i = 1, count do
        if value[i] == nil then return false end
    end
    return true
end

-- Typo suggestions

--- Levenshtein distance, capped: we only care whether two keys are CLOSE, and
--- an unbounded distance on long keys is wasted work at startup.
local function editDistance(a, b)
    if a == b then return 0 end
    local la, lb = #a, #b
    if la == 0 then return lb end
    if lb == 0 then return la end

    local prev, cur = {}, {}
    for j = 0, lb do prev[j] = j end

    for i = 1, la do
        cur[0] = i
        local ca = a:sub(i, i)
        for j = 1, lb do
            local cost = (ca == b:sub(j, j)) and 0 or 1
            local del, ins, sub = prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost
            local best = del
            if ins < best then best = ins end
            if sub < best then best = sub end
            cur[j] = best
        end
        prev, cur = cur, prev
    end

    return prev[lb]
end

local function commonPrefixLength(a, b)
    local limit = math.min(#a, #b)
    for i = 1, limit do
        if a:sub(i, i) ~= b:sub(i, i) then return i - 1 end
    end
    return limit
end

--- The known key an unknown one was probably meant to be, or nil.
---
--- Two rules: a slip (`detetcionRange`) is caught by edit distance, budgeted by
--- length. A stale/shortened name (`detectionRnge` for `detectionRangeMeters`,
--- edit distance 7) is not -- the required unit suffix dominates the distance,
--- so that case is matched on a substantial shared prefix instead. A wrong
--- suggestion is worse than none, so both rules stay conservative.
local function suggest(unknown, knownKeys)
    local lowerUnknown = unknown:lower()
    local budget = math.max(2, math.floor(#unknown / 4))
    local best, bestDistance = nil, math.huge

    for _, known in ipairs(knownKeys) do
        local lowerKnown = known:lower()
        local distance = editDistance(lowerUnknown, lowerKnown)
        local prefix = commonPrefixLength(lowerUnknown, lowerKnown)

        local credible = distance <= budget
            or (prefix >= 5 and prefix >= math.floor(#lowerUnknown * 0.6))

        if credible and distance < bestDistance then
            best, bestDistance = known, distance
        end
    end

    return best
end

-- Per-key checking

--- Validates one key. Returns an error string, or nil when the value is fine.
--- Never mutates: the caller decides whether a default gets applied, because
--- "the owner omitted this" and "the owner got this wrong" need opposite
--- treatment and only the caller knows which happened.
local function checkValue(prefix, key, value, def)
    local expected = def.type

    if expected == 'list' then
        if not isList(value) then
            if type(value) == 'table' then
                return ('%s.%s must be a list, not a key/value table.\n  Fix: use { "a", "b" } rather than { a = 1 }.')
                    :format(prefix, key)
            end
            return ('%s.%s must be a list. Found %s (%s).\n  Fix: wrap it in braces, e.g. { %s }.')
                :format(prefix, key, show(value), typeName(value), show(value))
        end
        return nil
    end

    if expected == 'number' then
        if type(value) ~= 'number' then
            -- A quoted number is the single most common config mistake in this
            -- ecosystem, and "must be a number, found a string" does not tell
            -- an owner what to do about it. Say it outright.
            if type(value) == 'string' and tonumber(value) then
                return ('%s.%s must be a number, but it is in quotes: %s.\n  Fix: remove the quotes -- write %s, not %s.')
                    :format(prefix, key, show(value), value, show(value))
            end
            return ('%s.%s must be a number. Found %s (%s).\n  Fix: %s')
                :format(prefix, key, show(value), typeName(value),
                    def.fix or ('use a number, e.g. %s.'):format(tostring(def.default or 1)))
        end
        if def.min and value < def.min then
            return ('%s.%s must be at least %s. Found %s.\n  Fix: raise it to %s or more.')
                :format(prefix, key, tostring(def.min), tostring(value), tostring(def.min))
        end
        if def.max and value > def.max then
            return ('%s.%s must be %s or less. Found %s.\n  Fix: lower it to %s or less.')
                :format(prefix, key, tostring(def.max), tostring(value), tostring(def.max))
        end
        return nil
    end

    if expected == 'boolean' then
        if type(value) ~= 'boolean' then
            -- "true" (a string) is TRUTHY in Lua, so this one silently "works"
            -- until something compares against the boolean.
            if value == 'true' or value == 'false' then
                return ('%s.%s must be true or false, but it is in quotes: %s.\n  Fix: remove the quotes -- write %s, not %s.')
                    :format(prefix, key, show(value), value, show(value))
            end
            return ('%s.%s must be true or false. Found %s (%s).\n  Fix: use true or false, without quotes.')
                :format(prefix, key, show(value), typeName(value))
        end
        return nil
    end

    if expected == 'string' then
        if type(value) ~= 'string' then
            return ('%s.%s must be text in quotes. Found %s (%s).\n  Fix: wrap it in quotes, e.g. "%s".')
                :format(prefix, key, show(value), typeName(value), tostring(value))
        end
    end

    if expected == 'table' then
        if type(value) ~= 'table' then
            return ('%s.%s must be a table. Found %s (%s).\n  Fix: use { ... }.')
                :format(prefix, key, show(value), typeName(value))
        end
    end

    if def.oneOf then
        for _, allowed in ipairs(def.oneOf) do
            if value == allowed then return nil end
        end
        return ('%s.%s must be one of: %s. Found %s.\n  Fix: use one of those exact values, in quotes.')
            :format(prefix, key, joinQuoted(def.oneOf), show(value))
    end

    return nil
end

-- Public API

--- Validates `tbl` against `spec`, filling in defaults for omitted keys.
---
--- @param tbl table   the config table (usually the global `Config`)
--- @param spec table  { file, resource?, keys, allowUnknown? }
--- @return table report { ok, errors = {string}, warnings = {string} }
function configMod.validate(tbl, spec)
    local file = spec.file or 'config.lua'
    local resource = spec.resource
        or (GetCurrentResourceName and GetCurrentResourceName())
        or 'resource'
    local prefix = spec.prefix or 'Config'
    local keys = spec.keys or {}

    local errors, warnings = {}, {}

    local function err(message)
        errors[#errors + 1] = ('[%s] %s: %s'):format(resource, file, message)
    end
    local function warn(message)
        warnings[#warnings + 1] = ('[%s] %s: %s'):format(resource, file, message)
    end

    local knownKeyList = {}
    for key in pairs(keys) do knownKeyList[#knownKeyList + 1] = key end
    table.sort(knownKeyList)

    -- Known keys: required, type, range, enum. Defaults fill gaps only.
    for _, key in ipairs(knownKeyList) do
        local def = keys[key]
        local value = tbl[key]

        if value == nil then
            if def.required then
                err(('%s.%s is required but is not set.\n  Fix: %s')
                    :format(prefix, key,
                        def.fix or ('add %s.%s to %s. See the documentation for what it should be.')
                            :format(prefix, key, file)))
            elseif def.default ~= nil then
                tbl[key] = def.default
            end
        else
            local problem = checkValue(prefix, key, value, def)
            if problem then
                -- Deliberately NOT replaced with the default. The owner stated
                -- an intention; running with a different value while telling
                -- them about it is how "I changed the setting and nothing
                -- happened" tickets are made.
                err(problem)
            end
        end
    end

    -- Unknown keys: a warning, with a suggestion when one is credible.
    if not spec.allowUnknown then
        local unknown = {}
        for key in pairs(tbl) do
            if type(key) == 'string' and keys[key] == nil then
                unknown[#unknown + 1] = key
            end
        end
        table.sort(unknown)

        for _, key in ipairs(unknown) do
            local guess = suggest(key, knownKeyList)
            if guess then
                warn(('%s.%s is not a setting this resource reads, so it is doing nothing.\n  Did you mean %s.%s?')
                    :format(prefix, key, prefix, guess))
            else
                warn(('%s.%s is not a setting this resource reads, so it is doing nothing.\n  Fix: check it against the documented settings, or delete it.')
                    :format(prefix, key))
            end
        end
    end

    return { ok = #errors == 0, errors = errors, warnings = warnings }
end

-- What the owner actually configured

-- Some resources deliberately use `Config` as the LIVE value, not just the
-- configured one -- tRadar rewrites `Config.speedUnit` client-side when a
-- player picks a unit. That's coherent, but it means a diagnostic printing
-- `Config.speedUnit` later reports the player's pick as though the owner had
-- written it. So validation snapshots what it saw at startup, before anything
-- mutates it; `<resource>_diag` should print `tlib.config.configured()`, not
-- the live table.
local snapshots = {}

--- Shallow copy. Deliberately NOT deep: the values a diagnostic prints are
--- scalars, and deep-copying a resource's whole zone/alert corpus at every
--- startup to protect values nothing mutates is a real cost for no gain.
--- Nested tables therefore still alias live state -- if a resource mutates one
--- in place and wants the configured version, it must snapshot it itself.
local function shallowCopy(tbl)
    local out = {}
    for k, v in pairs(tbl) do out[k] = v end
    return out
end

--- What the owner's config file contained at startup, after defaults were
--- applied and before anything mutated it.
---
--- @param file string|nil  the spec's `file`; omit when the resource has one config
--- @return table|nil       a copy, or nil if validation has not run
function configMod.configured(file)
    if file then
        local snap = snapshots[file]
        return snap and shallowCopy(snap) or nil
    end

    -- No file named: only unambiguous when exactly one config was validated.
    -- Returning "some config" for a resource with two is how a diagnostic
    -- starts reporting the wrong file's values.
    local found, count = nil, 0
    for _, snap in pairs(snapshots) do
        found, count = snap, count + 1
    end
    if count == 1 then return shallowCopy(found) end
    return nil
end

--- Validates and prints. Warnings print in yellow, errors in red, followed by a
--- single line stating the consequence -- an owner scrolling a busy console
--- needs one line that says whether their server is broken.
---
--- @return boolean ok  false when the config has errors (caller should abort)
function configMod.check(tbl, spec)
    local report = configMod.validate(tbl, spec)

    -- Snapshot even when validation failed: a diagnostic run on a broken config
    -- is exactly when an owner needs to see what the file actually said.
    snapshots[spec.file or 'config.lua'] = shallowCopy(tbl)

    for _, message in ipairs(report.warnings) do
        print('^3' .. message .. '^7')
    end
    for _, message in ipairs(report.errors) do
        print('^1' .. message .. '^7')
    end

    if not report.ok then
        print(('^1[%s] %d configuration error(s) above. Fix them in %s and restart.^7')
            :format(spec.resource or (GetCurrentResourceName and GetCurrentResourceName()) or 'resource',
                #report.errors, spec.file or 'config.lua'))
    end

    return report.ok
end

--[[
    Is an operator-merged file older than this build expects?

    `check` above answers "is what the operator wrote VALID". This answers what no
    validation can reach: is their copy of a file WE ship still the generation
    this build is written against. A merged-forward file can be perfectly valid
    Lua and still be the wrong file -- tRadio's client config has drifted this
    way across renamed hooks (`MakeAnimHandler` -> `RadioMakeAnimHandler`,
    `resolveSirenSystem` -> `RadioResolveSirenMode`, `_k9Hashes` -> `RadioIsK9Ped`),
    where the hook calls a global that no longer exists, the caller pcalls it, and
    the audio goes silent with nothing in any console.

    Shared here because the wording is the part worth sharing across every t*
    resource that ships merge-forward files. THE HONEST LIMIT: it compares two
    numbers, one of which is in a file a human edits -- it cannot detect a rename
    and does not say which call broke, so the caller still reports its own hook
    failures. `declared` goes through tonumber() and never a type test: a copy
    predating the constant has nil, a hand-edited one may have "3", and garbage
    must degrade to "old" rather than throw inside a startup path.
]]

--- @param opts table
---   file      string    the operator-facing path, e.g. 'config/cl_functions.lua'
---   declared  any       the constant the operator's copy declares
---   expected  number    the generation this build is written against
---   detail    string|nil what changed in this bump, in the resource's own words
---   resource  string|nil label; defaults to the current resource
--- @return table verdict { ok, declared, expected, lines }
function configMod.generation(opts)
    assert(type(opts) == 'table', 'tlib.config.generation: an opts table is required')
    local file = opts.file or 'config.lua'
    local resource = opts.resource
        or (GetCurrentResourceName and GetCurrentResourceName())
        or 'resource'
    local expected = tonumber(opts.expected)
    assert(expected, 'tlib.config.generation: expected must be a number')
    local declared = tonumber(opts.declared) or 0

    local verdict = { ok = declared >= expected, declared = declared, expected = expected, lines = {} }
    if verdict.ok and declared == expected then return verdict end

    local function say(text)
        verdict.lines[#verdict.lines + 1] = text
    end

    if declared > expected then
        -- Not a warning about a stale file -- the opposite, and a different fix.
        -- It happens when a resource is rolled back and config/ is not.
        say(('%s is NEWER than this build of %s expects (yours: v%d, this build: v%d).')
            :format(file, resource, declared, expected))
        say('That file came from a later release than the one running. Either finish')
        say('the upgrade or re-merge your edits onto this release\'s copy of it.')
    else
        say(('%s is older than this build of %s expects (yours: v%d, this build: v%d).')
            :format(file, resource, declared, expected))
        say('')
        say('That file ships with every release and is merged forward BY HAND, so')
        say('changes made inside it -- fixes included -- have not reached your copy.')
        say('Re-apply your edits on top of the SHIPPED file rather than carrying')
        say('yours forward.')
    end

    if type(opts.detail) == 'string' and opts.detail ~= '' then
        say('')
        for line in opts.detail:gmatch('[^\r\n]+') do say(line) end
    end

    -- Yellow, not red: the resource still starts and the operator's copy still
    -- works. Printed rather than returned-only, since the shared wording is the
    -- point of this living in tLib.
    print(('^3[%s] %s^7'):format(resource, string.rep('-', 60)))
    for _, line in ipairs(verdict.lines) do
        print(('^3[%s] %s^7'):format(resource, line == '' and ' ' or line))
    end
    print(('^3[%s] %s^7'):format(resource, string.rep('-', 60)))

    return verdict
end

return configMod
