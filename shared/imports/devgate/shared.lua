--[[
    tLib/shared/imports/devgate — the internal-feature gate.

    One call per resource, and the resource names its own convar:

        local isInternal = tlib.devgate('your_convar_name')

        if isInternal() then
            RegisterCommand(...)        -- registration, not behaviour
        end

    tLib provides the mechanism and never the name. That split is the whole
    point: the name is a string in the consumer's own file, so putting the call
    in a script that is NOT in that resource's `escrow_ignore` means the switch
    is encrypted in the shipped build. A customer cannot read it out, so there is
    nothing to find and nothing to turn on. Naming the convar in an exempt file
    defeats the module entirely.

    Gate REGISTRATION, not behaviour. No command, no keybind, no menu row, no NUI
    surface, no export. A command that exists and refuses, or a row that renders
    disabled, tells the customer the feature is there and earns a support
    question about a feature they do not have.

    The predicate reads the convar on EVERY call, never once at load: the convar
    is replicated, so a server can flip it mid-session and the next call sees the
    new value. Registration still happens once, wherever the `if` is, so
    off -> on takes a resource restart while on -> off takes effect at the next
    call. Where a surface is rebuilt per use -- a command's sub-command table, a
    payload sent when a panel opens -- put the call there and both directions are
    immediate.

    A client VM only sees a convar written with `setr`. `set` is server-only.
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
