-- typed KVP storage, auto-prefixed per community so each server's settings are isolated.
-- prefix comes from convar tlib_community_id → sv_projectName → none
--
--   tlib.kvp.getString('tels_hud_layout', 'default')
--   tlib.kvp.setFloat('tels_hud_scale', 1.5)
--   tlib.kvp.delete('tels_hud_scale')

local kvp = {}

local _prefix = nil

do
    -- Sanitize to alphanumeric + underscore/hyphen so it's safe as a KVP key prefix
    local function sanitize(s)
        return s:gsub("[^%w%-_]", "")
    end

    local cid = GetConvar("tlib_community_id", "")
    if cid ~= "" then
        _prefix = sanitize(cid)
    else
        local proj = GetConvar("sv_projectName", "")
        if proj ~= "" then
            _prefix = sanitize(proj)
        end
    end
    if _prefix == "" then _prefix = nil end
end

--- Returns the prefixed KVP key.
--- @param key string
--- @return string
function kvp.key(key)
    if _prefix then return _prefix .. "_" .. key end
    return key
end

--- Get the current community prefix (or nil if none).
function kvp.getPrefix()
    return _prefix
end

--- @param key string
--- @param default? string
--- @return string
function kvp.getString(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v and v ~= "" then return v end
    return default or ""
end

--- @param key string
--- @param default? number
--- @return number
function kvp.getFloat(key, default)
    local v = GetResourceKvpFloat(kvp.key(key))
    if v ~= 0.0 then return v end
    -- 0.0 could be a real value or "not set" — check if key exists
    local s = GetResourceKvpString(kvp.key(key))
    if s and s ~= "" then return v end
    return default or 0.0
end

--- @param key string
--- @param default? number
--- @return number
function kvp.getInt(key, default)
    local v = GetResourceKvpInt(kvp.key(key))
    if v ~= 0 then return v end
    local s = GetResourceKvpString(kvp.key(key))
    if s and s ~= "" then return v end
    return default or 0
end

--- @param key string
--- @param default? boolean
--- @return boolean
function kvp.getBool(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v == "true" then return true end
    if v == "false" then return false end
    if default == nil then return false end
    return default
end

--- @param key string
--- @param default? table
--- @return table|nil
function kvp.getJson(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if v and v ~= "" then
        local decoded = json.decode(v)
        if decoded then return decoded end
    end
    return default
end

--- Returns true if the key has been explicitly set (not just default).
--- @param key string
--- @return boolean
function kvp.has(key)
    local resolved = kvp.key(key)
    local handle = StartFindKvp(resolved)
    if handle == -1 then return false end
    local found = FindKvp(handle)
    EndFindKvp(handle)
    return found ~= nil
end

--- @param key string
--- @param value string
function kvp.setString(key, value)
    SetResourceKvp(kvp.key(key), tostring(value))
end

--- @param key string
--- @param value number
function kvp.setFloat(key, value)
    SetResourceKvpFloat(kvp.key(key), value + 0.0)
end

--- @param key string
--- @param value number
function kvp.setInt(key, value)
    SetResourceKvpInt(kvp.key(key), math.floor(value))
end

--- @param key string
--- @param value boolean
function kvp.setBool(key, value)
    SetResourceKvp(kvp.key(key), value and "true" or "false")
end

--- @param key string
--- @param value table
function kvp.setJson(key, value)
    SetResourceKvp(kvp.key(key), json.encode(value))
end

--- Auto-detect type and set accordingly.
--- @param key string
--- @param value any
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

--- Auto-detect type and get with default.
--- @param key string
--- @param default any
--- @return any
function kvp.get(key, default)
    local v = GetResourceKvpString(kvp.key(key))
    if not v or v == "" then return default end
    -- Try to infer type from the stored string
    if v == "true" then return true end
    if v == "false" then return false end
    local n = tonumber(v)
    if n then return n end
    -- Try JSON
    if v:sub(1, 1) == "{" or v:sub(1, 1) == "[" then
        local decoded = json.decode(v)
        if decoded then return decoded end
    end
    return v
end

--- @param key string
function kvp.delete(key)
    DeleteResourceKvp(kvp.key(key))
end

return kvp
