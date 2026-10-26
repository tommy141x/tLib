--[[
    tLib/shared/imports/access — the CLIENT MIRROR.

        local radio = tlib.access.gate({ key = 'radio' })
        if radio:allowed() then showRadioButton() end
        radio:onChange(function(allowed) toggleRadioButton(allowed) end)

    Answers "should I draw the button?", NOT "may this player do the thing" —
    it's a cached copy of a server decision, living in a process the player
    controls. Every privileged net event handler must still call the SERVER
    gate's `:allowed(source)`; two resources adopting this module shipped with
    that check missing (UI greyed out, event behind it accepted anyone). This
    file only keeps the UI from lying to honest players.
]]

local access = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

local Gate = {}
Gate.__index = Gate

--- Last answer the server sent. `false` until the first answer arrives, which is
--- the right way round: a gate that opens while it waits is a gate that flickers
--- open on every spawn.
--- @return boolean
function Gate:allowed()
    return self.value == true
end

--- True once the server has answered at least once. Use it to tell "denied"
--- apart from "have not heard yet" when that distinction matters to the UI.
--- @return boolean
function Gate:known()
    return self.answered
end

--- Ask the server for a fresh answer. Call it after anything that could change
--- the outcome -- going on duty, picking an item up, a job change event.
function Gate:refresh()
    TriggerServerEvent(self.event)
end

--- Run `fn(allowed)` whenever the answer changes, and once immediately if an
--- answer is already known.
--- @param fn fun(allowed: boolean)
function Gate:onChange(fn)
    if type(fn) ~= 'function' then return end
    self.listeners[#self.listeners + 1] = fn
    if self.answered then fn(self.value) end
end

local function deliver(self, value)
    value = value == true
    local changed = (value ~= self.value) or not self.answered
    self.value, self.answered = value, true
    if not changed then return end
    for _, fn in ipairs(self.listeners) do pcall(fn, value) end
end

--- Client-side half of a gate. Takes only `key`, which must match the `key` the
--- server side was built with -- the owner's access block is not read here and
--- must not be, since the client has no business knowing the rule, only the
--- verdict.
---
--- @param opts table { key = 'radio' }
--- @return table gate
function access.gate(opts)
    opts = opts or {}
    local key = opts.key or 'access'

    local self = setmetatable({
        value     = false,
        answered  = false,
        listeners = {},
        event     = ('%s:tlib:access:%s'):format(RESOURCE, key),
    }, Gate)

    RegisterNetEvent(self.event, function(value) deliver(self, value) end)

    -- Ask once now, and again on spawn. The first request can easily land before
    -- the framework has loaded this player's character, which would cache a
    -- "no" for a player who is in fact allowed; the spawn re-ask is what stops
    -- that being permanent.
    self:refresh()
    AddEventHandler('playerSpawned', function() self:refresh() end)

    return self
end

return access
