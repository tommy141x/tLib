-- tLib — Move Mode module (client-side)
-- Generic UI repositioning with KVP persistence.
--
-- Manages enter/exit move mode, NUI focus, and position save/load.
-- The actual drag interaction happens in the NUI/web side (see @tlib/shared/move-mode).
--
-- Usage:
--   local mover = tlib.movemode.create({
--       keys = {
--           right  = 'tels_hud_right',
--           bottom = 'tels_hud_bottom',
--           scale  = 'tels_hud_scale',
--       },
--       defaults = { right = 20.0, bottom = 20.0, scale = 1.0 },
--       scaleRange = { 0.5, 2.0 },   -- optional, for validation
--   })
--
--   mover:load()                      -- load from KVP
--   mover:getPosition()               -- { right, bottom, scale }
--   mover:savePosition(r, b, s)       -- save to KVP
--   mover:resetPosition()             -- reset to defaults and save
--   mover:isActive()                  -- is move mode active?
--   mover:enter()                     -- set active, enable NUI focus
--   mover:exit()                      -- set inactive, disable NUI focus

local movemode = {}

--- Create a new move mode instance.
--- @param opts table
--- @return table Move mode instance
function movemode.create(opts)
    local keys     = opts.keys     -- { right, bottom, scale }
    local defaults = opts.defaults or { right = 20.0, bottom = 20.0, scale = 1.0 }
    local range    = opts.scaleRange or { 0.3, 3.0 }

    local kvp = tlib.kvp  -- depends on the kvp module being loaded

    local active = false
    local position = {
        right  = defaults.right,
        bottom = defaults.bottom,
        scale  = defaults.scale,
    }

    local inst = {}

    --- Load position from KVP. Returns the position table.
    function inst:load()
        if kvp.has(keys.right) or kvp.has(keys.bottom) or kvp.has(keys.scale) then
            position.right  = kvp.getFloat(keys.right,  defaults.right)
            position.bottom = kvp.getFloat(keys.bottom, defaults.bottom)
            position.scale  = kvp.getFloat(keys.scale,  defaults.scale)
        end
        -- Clamp scale to range
        position.scale = math.max(range[1], math.min(range[2], position.scale))
        if position.scale == 0.0 then position.scale = defaults.scale end
        return position
    end

    --- Get the current position.
    function inst:getPosition()
        return position
    end

    --- Save position to KVP.
    function inst:savePosition(right, bottom, scale)
        if right then position.right = right end
        if bottom then position.bottom = bottom end
        if scale then position.scale = math.max(range[1], math.min(range[2], scale)) end
        kvp.setFloat(keys.right,  position.right)
        kvp.setFloat(keys.bottom, position.bottom)
        kvp.setFloat(keys.scale,  position.scale)
    end

    --- Reset position to defaults and save.
    function inst:resetPosition()
        position.right  = defaults.right
        position.bottom = defaults.bottom
        position.scale  = defaults.scale
        inst:savePosition(position.right, position.bottom, position.scale)
    end

    --- Is move mode currently active?
    function inst:isActive()
        return active
    end

    --- Enter move mode (enables NUI cursor).
    function inst:enter()
        active = true
        SetNuiFocus(true, true)
    end

    --- Exit move mode (disables NUI cursor).
    function inst:exit()
        active = false
        SetNuiFocus(false, false)
    end

    --- Toggle move mode.
    function inst:toggle()
        if active then inst:exit() else inst:enter() end
    end

    return inst
end

return movemode
