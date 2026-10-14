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
--
-- `serverScoped = true` on a definition stores it under this server's tag, so a
-- value that is only meaningful against one server's configuration does not
-- follow the player to the next one. tRadio's Radio FX overrides are the case
-- that produced it: they are a correction dialled in on top of one server's
-- radioFx chain, and carried elsewhere they correct a chain that was never
-- wrong. tRadio had this as a private `SERVER_SCOPED_SETTINGS` set in
-- `cl_bridge.lua` plus a second copy in TypeScript; the option is the shared
-- form of both.

--- Coerce an incoming value to a setting's declared type, and clamp it.
---
--- ONE ladder, used by both `set` and `applyDefaults`. It was written out
--- twice and the two had drifted into disagreeing: `set` accepted only boolean
--- `true` for a bool while `applyDefaults` also accepted the string "true", and
--- `applyDefaults` had NO `json` branch at all -- so a server default for a json
--- setting was stored raw and every reader got a string where it expected a
--- table. The permissive bool is the one kept: a default arriving from JSON or
--- a convar is a string, and rejecting it silently produced `false`.
---
--- The LOAD path above is deliberately not folded in here. It reads through the
--- store's typed getters rather than coercing a value in hand, which is a
--- different operation that happens to look similar.
local function coerce(m, value)
    local t = m.type
    if t == 'float' or t == 'number' then
        value = tonumber(value) or m.default
    elseif t == 'int' then
        value = math.floor(tonumber(value) or m.default)
    elseif t == 'bool' then
        return value == true or value == "true"
    elseif t == 'json' then
        if type(value) == 'string' then return json.decode(value) or m.default end
        return value
    else
        return tostring(value)
    end
    if m.clamp then value = math.max(m.clamp[1], math.min(m.clamp[2], value)) end
    return value
end

local settingsMod = {}

function settingsMod.create(defs)
    local kvp = tlib.kvp
    -- One view per scope rather than one per definition: the views are
    -- stateless and the only difference is how `key` resolves.
    local scopedKvp = kvp.view({ serverScoped = true })
    local function storeFor(def) return def.serverScoped and scopedKvp or kvp end

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

        meta[key] = { type = typ, default = default, clamp = clamp, store = storeFor(def) }
        keyOrder[#keyOrder + 1] = key

        local store = meta[key].store
        local hasKvp = store.has(key)
        userSet[key] = hasKvp

        if hasKvp then
            if typ == 'float' or typ == 'number' then
                values[key] = tonumber(store.getString(key)) or default
            elseif typ == 'int' then
                local v = tonumber(store.getString(key))
                values[key] = v and math.floor(v) or default
            elseif typ == 'bool' then
                values[key] = store.getBool(key, default)
            elseif typ == 'json' then
                values[key] = store.getJson(key, default)
            else
                values[key] = store.getString(key, default)
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
        local store = m.store

        value = coerce(m, value)

        if m.type == 'bool' then
            store.setBool(key, value)
        elseif m.type == 'json' then
            store.setJson(key, value)
        else
            store.setString(key, tostring(value))
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
                values[key] = coerce(meta[key], value)
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

    --- The resolved KVP key a setting is stored under, scope included. The
    --- engine-side store has to be handed these, and deriving them a second
    --- time is how tRadio's two copies came to need to agree by hand.
    function inst:storageKey(key)
        local m = meta[key]
        if not m then return nil end
        return m.store.key and m.store.key(key) or kvp.key(key)
    end

    --- Back to the default, and no longer user-set.
    function inst:reset(key)
        local m = meta[key]
        if not m then return end
        values[key] = m.default
        userSet[key] = false
        m.store.delete(key)
    end

    return inst
end

return settingsMod
