--[[
    tLib/shared/imports/access — the CLIENT MIRROR.

    Usage in a consumer (client scripts):

        local radio = tlib.access.gate({ key = 'radio' })

        if radio:allowed() then showRadioButton() end
        radio:onChange(function(allowed) toggleRadioButton(allowed) end)

    READ THIS BEFORE USING IT
    -------------------------
    This answers "should I draw the button?" It does NOT answer "may this player
    do the thing." It is a cached copy of a decision the server made, living in a
    process the player controls, and a player who edits it gets a visible button
    and nothing else -- because the server re-checks on the event behind it.

    That re-check is not optional and not implied. Two of the resources adopting
    this module had exactly this bug already, in both cases written in good
    faith: the gate greyed out the UI, and the net event behind it accepted
    anything from anyone. If you write a client check here and no server check
    in Gate:allowed(src), you have written a suggestion, not a gate.

    So: every privileged net event handler calls the SERVER gate's
    `:allowed(source)`. This file exists only so the UI does not lie to honest
    players about what they can do.
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
