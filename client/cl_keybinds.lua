--[[ Cross-resource keybind registry: every `tlib.platform.bindKey` call reports
here, the only place two resources' bindings are visible together, since
`platform.keybindConflicts()` only sees its own VM (e.g. tLS's PA Mic and
tRadar's radar keys both claim B/RMENU, invisible to either resource alone).
A default key is a suggestion, not authority — the player's FiveM rebind wins
— so this only warns and never reassigns. The report is deferred
`REPORT_DELAY_MS` because resource start order is not guaranteed. ]]

local log = Logger.create('tLib/keybinds')

--- Every bind reported, keyed `group\1key` -> { {resource=, token=, label=}, ... }
local byKey = {}
--- Flat list, for `GetKeybinds`.
local all = {}

--- Long enough for every consumer to have started and registered; a bind
--- reported after this fires is still recorded, just not printed.
local REPORT_DELAY_MS = 10000

local reported = false

--- Upper-cased, because FiveM accepts either case and a consumer that writes
--- `'q'` would otherwise never match a consumer that writes `'Q'` — a collision
--- the registry reports as two separate, uncontested keys.
local function keyOf(entry)
    return tostring(entry.group or 'keyboard') .. '\1' .. tostring(entry.default or ''):upper()
end

--- Record one bind. Called by `platform.bindKey` in every consumer VM.
---
--- Total, not strict: a malformed entry is dropped, not raised. This runs inside
--- the consumer's bind path, and a keybind registry is not worth breaking a
--- resource's startup over.
local function report(entry)
    if type(entry) ~= 'table' then return end
    if type(entry.token) ~= 'string' or entry.token == '' then return end

    local record = {
        resource = tostring(entry.resource or '?'),
        token    = entry.token,
        label    = tostring(entry.label or entry.token),
        default  = tostring(entry.default or ''),
        group    = tostring(entry.group or 'keyboard'),
    }
    all[#all + 1] = record

    -- An unbound entry has no key to collide on; many share the empty string,
    -- and treating that as a collision would bury the real ones.
    if record.default == '' then return end

    local k = keyOf(record)
    byKey[k] = byKey[k] or {}
    local list = byKey[k]
    list[#list + 1] = record
end

--- Conflicts across every resource that reported.
--- Returns `{ { group =, key =, claims = { {resource=, token=, label=}, ... } }, ... }`
local function conflicts()
    local out = {}
    for k, claims in pairs(byKey) do
        if #claims > 1 then
            -- Two binds from the SAME resource on the same key are that
            -- resource's own business and its own check already reports them.
            -- Only flag it here when more than one product is involved.
            local resources, distinct = {}, 0
            for _, c in ipairs(claims) do
                if not resources[c.resource] then
                    resources[c.resource] = true
                    distinct = distinct + 1
                end
            end
            if distinct > 1 then
                local group, key = k:match('^(.-)\1(.*)$')
                out[#out + 1] = { group = group, key = key, claims = claims }
            end
        end
    end
    return out
end

Platform.export('tLib', 'ReportKeybind', report)
Platform.export('tLib', 'GetKeybinds', function() return all end)
Platform.export('tLib', 'GetKeybindConflicts', conflicts)

CreateThread(function()
    Wait(REPORT_DELAY_MS)
    if reported then return end
    reported = true

    local found = conflicts()
    if #found == 0 then return end

    log(('%d cross-resource keybind conflict(s) — both bindings fire on one press:')
        :format(#found), 2)
    for _, c in ipairs(found) do
        local parts = {}
        for _, claim in ipairs(c.claims) do
            parts[#parts + 1] = ('%s (%s)'):format(claim.label, claim.resource)
        end
        log(('  %s  ->  %s'):format(c.key, table.concat(parts, '  vs  ')), 2)
    end
    log('  A player rebind in GTA Settings > Key Bindings overrides the default.', 2)
end)
