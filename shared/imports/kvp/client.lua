-- Typed KVP storage, prefixed per community so one box's servers stay isolated.
-- The prefix is the tlib_community_id convar, else sv_projectName, else nothing.
--
--   tlib.kvp.getString('tels_hud_layout', 'default')
--   tlib.kvp.setFloat('tels_hud_scale', 1.5)
--   tlib.kvp.delete('tels_hud_scale')
--
-- Every getter takes an optional default, returned when the key was never set.

local kvp = {}

local _prefix = nil

do
    local function sanitize(s)
        return s:gsub("[^%w%-_]", "")
    end

    -- A convar that sanitizes away to nothing has to fall through rather than
    -- win, or a community id of "!!!" selects an empty prefix and quietly turns
    -- namespacing off while sv_projectName sits there unused. The TypeScript
    -- side (shared/ts/kvp.ts) already fell through; this one did not, so the same
    -- server could read one namespace from Lua and another from JS.
    for _, convar in ipairs({ "tlib_community_id", "sv_projectName" }) do
        local cleaned = sanitize(GetConvar(convar, ""))
        if cleaned ~= "" then
            _prefix = cleaned
            break
        end
    end
end

--- Returns the prefixed KVP key.
function kvp.key(key)
    if _prefix then return _prefix .. "_" .. key end
    return key
end

--- Get the current community prefix (or nil if none).
function kvp.getPrefix()
    return _prefix
end

function kvp.getString(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v and v ~= "" then return v end
    return default or ""
end

function kvp.getFloat(key, default)
    if not kvp.has(key) then return default or 0.0 end
    return GetResourceKvpFloat(kvp.key(key))
end

function kvp.getInt(key, default)
    if not kvp.has(key) then return default or 0 end
    return GetResourceKvpInt(kvp.key(key))
end

function kvp.getBool(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v == "true" then return true end
    if v == "false" then return false end
    if default == nil then return false end
    return default
end

function kvp.getJson(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v and v ~= "" then
        local decoded = json.decode(v)
        if decoded then return decoded end
    end
    return default
end

--- True only when the key has actually been written.
function kvp.has(key)
    local resolved = kvp.key(key)
    local handle = StartFindKvp(resolved)
    if handle == -1 then return false end
    local found = FindKvp(handle)
    EndFindKvp(handle)
    return found == resolved
end

function kvp.setString(key, value)
    SetResourceKvp(kvp.key(key), tostring(value))
end

function kvp.setFloat(key, value)
    SetResourceKvpFloat(kvp.key(key), value + 0.0)
end

function kvp.setInt(key, value)
    SetResourceKvpInt(kvp.key(key), math.floor(value))
end

function kvp.setBool(key, value)
    SetResourceKvp(kvp.key(key), value and "true" or "false")
end

function kvp.setJson(key, value)
    SetResourceKvp(kvp.key(key), json.encode(value))
end

--- Store by the value's own type.
function kvp.set(key, value)
    local t = type(value)
    if t == "boolean" then
        kvp.setBool(key, value)
    elseif t == "number" then
        if value == math.floor(value) then
            kvp.setInt(key, value)
        else
            kvp.setFloat(key, value)
        end
    elseif t == "table" then
        kvp.setJson(key, value)
    else
        kvp.setString(key, tostring(value))
    end
end

--- Read back, inferring the type from what was stored.
function kvp.get(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if not v or v == "" then return default end
    if v == "true" then return true end
    if v == "false" then return false end
    local n = tonumber(v)
    if n then return n end
    if v:sub(1, 1) == "{" or v:sub(1, 1) == "[" then
        local decoded = json.decode(v)
        if decoded then return decoded end
    end
    return v
end

function kvp.delete(key)
    DeleteResourceKvp(kvp.key(key))
end

return kvp
