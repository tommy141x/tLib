-- tLib — Settings module (client-side)
-- Typed settings with KVP persistence and server default fallback.
--
-- Handles the common pattern: "use player's KVP value if they've set one,
-- otherwise fall back to server default, otherwise use hardcoded default."
--
-- Depends on: tlib.kvp
--
-- Usage:
--   local settings = tlib.settings.create({
--       { key = 'tels_emissive',   type = 'float', default = 1.0, clamp = {0.1, 3.0} },
--       { key = 'tels_bloom',      type = 'float', default = 1.0, clamp = {0.1, 3.0} },
--       { key = 'tels_env_quality', type = 'int',  default = 4,   clamp = {0, 4} },
--       { key = 'tels_hud_visible', type = 'bool', default = true },
--       { key = 'tels_hud_layout',  type = 'string', default = 'default' },
--   })
--
--   settings:get('tels_emissive')          -- returns current effective value
--   settings:set('tels_emissive', 1.5)     -- saves to KVP, marks as user-set
--   settings:isUserSet('tels_emissive')    -- true if player explicitly set it
--   settings:applyDefaults({ tels_emissive = 1.2, tels_bloom = 0.8 })  -- server defaults
--   settings:getAll()                      -- { tels_emissive = 1.0, tels_bloom = 1.0, ... }

local settingsMod = {}

--- Create a new settings store.
--- @param defs table[] Array of { key, type, default, clamp? }
--- @return table Settings instance
function settingsMod.create(defs)
    local kvp = tlib.kvp

    -- Internal state per setting
    local meta = {}       -- key → { type, default, clamp }
    local values = {}     -- key → current effective value
    local userSet = {}    -- key → true if player explicitly saved to KVP
    local keyOrder = {}   -- preserve definition order

    local inst = {}

    -- Initialize: load from KVP, track user-set state
    for _, def in ipairs(defs) do
        local key     = def.key
        local typ     = def.type or 'string'
        local default = def.default
        local clamp   = def.clamp  -- { min, max } or nil

        meta[key] = { type = typ, default = default, clamp = clamp }
        keyOrder[#keyOrder + 1] = key

        local hasKvp = kvp.has(key)
        userSet[key] = hasKvp

        if hasKvp then
            if typ == 'float' or typ == 'number' then
                values[key] = tonumber(kvp.getString(key)) or default
            elseif typ == 'int' then
                local v = tonumber(kvp.getString(key))
                values[key] = v and math.floor(v) or default
            elseif typ == 'bool' then
                values[key] = kvp.getBool(key, default)
            elseif typ == 'json' then
                values[key] = kvp.getJson(key, default)
            else
                values[key] = kvp.getString(key, default)
            end
        else
            values[key] = default
        end

        -- Clamp if applicable
        if clamp and type(values[key]) == 'number' then
            values[key] = math.max(clamp[1], math.min(clamp[2], values[key]))
        end
    end

    --- Get the current effective value for a setting.
    function inst:get(key)
        return values[key]
    end

    --- Set a value, save to KVP, and mark as user-set.
    function inst:set(key, value)
        local m = meta[key]
        if not m then return end

        -- Type coercion + clamping
        if m.type == 'float' or m.type == 'number' then
            value = tonumber(value) or m.default
            if m.clamp then value = math.max(m.clamp[1], math.min(m.clamp[2], value)) end
            kvp.setString(key, tostring(value))
        elseif m.type == 'int' then
            value = math.floor(tonumber(value) or m.default)
            if m.clamp then value = math.max(m.clamp[1], math.min(m.clamp[2], value)) end
            kvp.setString(key, tostring(value))
        elseif m.type == 'bool' then
            value = (value == true)
            kvp.setBool(key, value)
        elseif m.type == 'json' then
            kvp.setJson(key, value)
        else
            value = tostring(value)
            kvp.setString(key, value)
        end

        values[key] = value
        userSet[key] = true
    end

    --- Returns true if the player has explicitly saved this setting.
    function inst:isUserSet(key)
        return userSet[key] == true
    end

    --- Apply server defaults. Only affects settings the user hasn't explicitly set.
    --- @param defaults table  { key = value, ... }
    function inst:applyDefaults(defaults)
        for key, value in pairs(defaults) do
            if meta[key] and not userSet[key] then
                local m = meta[key]
                if m.type == 'float' or m.type == 'number' then
                    value = tonumber(value) or m.default
                    if m.clamp then value = math.max(m.clamp[1], math.min(m.clamp[2], value)) end
                elseif m.type == 'int' then
                    value = math.floor(tonumber(value) or m.default)
                    if m.clamp then value = math.max(m.clamp[1], math.min(m.clamp[2], value)) end
                elseif m.type == 'bool' then
                    value = (value == true or value == "true")
                end
                values[key] = value
            end
        end
    end

    --- Get all current values as a table.
    function inst:getAll()
        local out = {}
        for _, key in ipairs(keyOrder) do
            out[key] = values[key]
        end
        return out
    end

    --- Get all defined keys.
    function inst:getKeys()
        return keyOrder
    end

    --- Reset a setting to its default and remove from KVP.
    function inst:reset(key)
        local m = meta[key]
        if not m then return end
        values[key] = m.default
        userSet[key] = false
        kvp.delete(key)
    end

    return inst
end

return settingsMod
