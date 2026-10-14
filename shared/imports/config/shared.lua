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
-- Why this exists: across the seven tScripts resources, a mistyped config key
-- did nothing at all, forever, without a word. Six of seven had no config
-- validation of any kind, and the ad-hoc guards that did exist substituted a
-- hardcoded fallback for whatever the owner had written -- sometimes a fallback
-- that differed from the shipped default, so the product disagreed with both
-- the file and the docs.
--
-- The rules it enforces are internal/reference/tscripts-config-standard.md §10:
--   * report EVERY problem at once, never just the first
--   * every message names the file, the key, what was expected, what was found,
--     and how to fix it
--   * an unknown key warns and suggests what was probably meant
--   * a missing required value is fatal -- refuse to start rather than fail
--     later in a way that names an innocent file
--   * a rejected value is NEVER silently replaced by the default
--
-- Defaults ARE written into the table for keys the owner omitted, which is what
-- makes a config file optional. The distinction that matters: filling a gap is
-- fine, overwriting a stated intention is not.

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
--- Two rules, because owner mistakes come in two shapes and edit distance only
--- catches one of them:
---
---   * A slip: `detetcionRange`. Close by edit distance. Budget scales with
---     length -- "cfg" vs "cf" is a different kind of near-miss than a
---     20-character key with one letter dropped.
---   * A stale or shortened name: `detectionRnge` for `detectionRangeMeters`.
---     Edit distance 7, because the `Meters` suffix dominates, so the distance
---     rule rejects it outright. But §6 REQUIRES units in key names, which
---     means owners writing the unit-less name they remember is the typo this
---     standard actively manufactures. It is a shared-prefix mistake, so match
---     on the prefix.
---
--- A wrong suggestion is worse than none, so both rules stay conservative and
--- the prefix rule needs a substantial absolute prefix, not just a shared
--- first letter.
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

-- Several resources deliberately use their `Config` table as the LIVE value,
-- not just the configured one -- tRadar's `Config.speedUnit` is rewritten
-- client-side when a player picks a unit, because the conversion path wants the
-- live value. That is coherent, and not a bug to fix here.
--
-- It does break one thing, though. A diagnostic that prints `Config.speedUnit`
-- after that point reports the PLAYER'S pick as though the owner had written
-- it. The owner's configured value is gone, and the one tool they would reach
-- for to check their config confidently tells them something they never wrote.
-- A wrong default is recoverable; a diagnostic that lies is not.
--
-- So validation snapshots what it saw, at the one moment it is guaranteed
-- pristine: startup, before the resource does real work. `<resource>_diag`
-- should print `tlib.config.configured()`, not the live table.
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

return configMod
