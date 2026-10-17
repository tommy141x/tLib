--[[----------------------------------------------------------------------------
    Cross-resource keybind registry.

    Every consumer that binds through `tlib.platform.bindKey` reports the bind
    here. That is the only place in the stack where two different resources'
    bindings are visible at the same time, and it is the reason this file exists.

     Why a per-resource check is not enough

    `platform.keybindConflicts()` runs inside the consumer's own VM, so it can
    only see that resource's own bindings. It catches the case tELS shipped —
    a siren-tone loop running 1..8 while cruise, takedown and traffic advisor
    already held 6, 7 and 8 — but it is structurally blind to the collisions that
    actually reach a player:

        B       tELS  "ELS: PA Mic (hold)"        vs  tRadio "Radio: Push to Talk"
        RMENU   tELS  "ELS: Toggle Rumbler"       vs  tRadar "tRadar: work the radar keys"

    Both are certainties on a police server: one key, two products, both fire.
    Neither VM can see the other, so neither could ever report it.

     Why this warns and does not resolve

    A default key is a *suggestion*; the player's own rebind is authoritative and
    stored by FiveM against the command token. Silently reassigning a default
    would either fight that rebind or change the controls of an install that was
    working. So this prints, and a human decides.

    The report is deferred rather than immediate because resources start in an
    arbitrary order — checking on the first report would compare tELS against an
    empty table. `REPORT_DELAY_MS` is generous for that reason.
------------------------------------------------------------------------------]]

local log = Logger.create('tLib/keybinds')

--- Every bind reported, keyed `group\1key` -> { {resource=, token=, label=}, ... }
local byKey = {}
--- Flat list, for `GetKeybinds` and a future controls UI.
local all = {}

--- Long enough for every consumer to have started and registered.
--- Resource start order is not guaranteed, and a bind reported after the report
--- has run is still recorded — it just misses that printout.
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
--- Deliberately total: a malformed entry is dropped rather than raised. This runs
--- inside the consumer's bind path, and a keybind registry is not worth breaking
--- a resource's startup over.
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

    -- An unbound entry has no key to collide on. Twenty of them share the empty
    -- string, and treating that as a collision would bury the real ones.
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
