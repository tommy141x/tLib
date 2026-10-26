--[[
    tLib/shared/imports/devgate — the internal-feature gate.

        local isInternal = tlib.devgate('your_convar_name')
        if isInternal() then RegisterCommand(...) end

    tLib supplies the mechanism, never the name: the convar name lives only in
    the consumer's own file, so keeping that file out of `escrow_ignore` ships
    it encrypted — naming the convar in an exempt file defeats this entirely.

    Gate REGISTRATION, not behaviour (no command/keybind/menu row/NUI/export),
    since a disabled row or a refusing command still tells the customer the
    feature exists. The predicate re-reads the convar every call, never once
    at load, so off->on needs a resource restart (registration runs once) but
    on->off is immediate wherever a surface is rebuilt per use.

    A client VM only sees a convar written with `setr`; `set` is server-only.
]]

local devgate = {}

-- `ConvertToBool` is not present in every runtime this is loaded into (the
-- off-FiveM Lua suites have no natives at all), and an owner who writes
-- `setr <name> true` must get the feature rather than silence.
local TRUTHY = { ['1'] = true, ['true'] = true, ['yes'] = true, ['on'] = true }

local function read(name)
    if type(GetConvar) ~= 'function' then return false end
    local ok, value = pcall(GetConvar, name, '0')
    if not ok or value == nil then return false end
    return TRUTHY[tostring(value):lower()] == true
end

--- Raises on a bad name instead of returning a predicate that is always false:
--- an unusable name would otherwise be indistinguishable from the feature being
--- switched off, which is the one failure this module cannot report later.
local function gate(_, name)
    if type(name) ~= 'string' or name == '' then
        error('tlib.devgate needs a convar name', 2)
    end
    return function() return read(name) end
end

return setmetatable(devgate, { __call = gate })
