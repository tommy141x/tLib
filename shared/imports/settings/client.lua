-- Settings with KVP persistence, resolved player KVP -> server default ->
-- hardcoded default. Requires tlib.kvp.
--
--   local settings = tlib.settings.create({
--       { key = 'tels_emissive',    type = 'float',  default = 1.0, clamp = { 0.1, 3.0 } },
--       { key = 'tels_env_quality', type = 'int',    default = 4,   clamp = { 0, 4 } },
--       { key = 'tels_hud_visible', type = 'bool',   default = true },
--       { key = 'tels_hud_layout',  type = 'string', default = 'default' },
--   })
--
-- A server default only lands on a setting the player has not set themselves.

local settingsMod = {}

function settingsMod.create(defs)
    local kvp = tlib.kvp

    local meta = {}       -- key -> { type, default, clamp }
    local values = {}     -- key -> current effective value
    local userSet = {}    -- key -> player saved it to KVP themselves
    local keyOrder = {}   -- definition order, for getAll/getKeys

    local inst = {}

    for _, def in ipairs(defs) do
        local key     = def.key
        local typ     = def.type or 'string'
        local default = def.default
        local clamp   = def.clamp

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

        if clamp and type(values[key]) == 'number' then
            values[key] = math.max(clamp[1], math.min(clamp[2], values[key]))
        end
    end

    function inst:get(key)
        return values[key]
    end

    --- Saves to KVP and marks the setting user-set, so server defaults stop
    --- applying to it.
    function inst:set(key, value)
        local m = meta[key]
        if not m then return end

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

    function inst:isUserSet(key)
        return userSet[key] == true
    end

    --- Apply `{ key = value }` server defaults, skipping anything the player set.
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

    function inst:getAll()
        local out = {}
        for _, key in ipairs(keyOrder) do
            out[key] = values[key]
        end
        return out
    end

    function inst:getKeys()
        return keyOrder
    end

    --- Back to the default, and no longer user-set.
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
