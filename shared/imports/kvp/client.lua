-- Typed KVP storage, with TWO independent and separately optional namespaces.
--
--   tlib.kvp.getString('tls_hud_layout', 'default')
--   tlib.kvp.setFloat('tls_hud_scale', 1.5)
--   tlib.kvp.delete('tls_hud_scale')
--
-- Every getter takes an optional default, returned when the key was never set.
--
-- NOTHING HERE IS ISOLATED BY DEFAULT. Read this before writing a comment
-- claiming a key is "per server" -- at least two defects in the estate came from
-- a developer believing one of these layers was automatic, and this file's own
-- header used to say so.
--
--   * The COMMUNITY prefix (below) is the `tlib_community_id` convar, else
--     `sv_projectName`, else NOTHING. Neither is a standard FiveM convar, so a
--     server that has set neither -- which is most of them -- runs with no prefix
--     at all. It separates one OWNER's boxes from another's. It does not separate
--     two servers, and it is not applied unless somebody set it.
--
--   * The SERVER tag (`kvp.serverTag()`) is what separates two servers, and it is
--     opt-in PER KEY: only a key passed `serverScoped = true` gets it. A key
--     without it follows the player to every server running the resource.
--
-- That default is right for a preference the player owns (their radio model) and
-- wrong for anything describing where they are (last channel, callsign) -- which
-- is the "it reset itself" / "it kept my old server's settings" report. The
-- default is NOT changeable: these strings are already persisted on players'
-- machines, so flipping it abandons every stored key in the wild. Deciding per
-- key is the whole contract; forgetting to decide silently means "global".

local kvp = {}

local _prefix = nil

do
    local function sanitize(s)
        return s:gsub("[^%w%-_]", "")
    end

    -- A convar that sanitizes away to nothing has to fall through rather than
    -- win, or a community id of "!!!" selects an empty prefix and quietly turns
    -- namespacing off while sv_projectName sits there unused. The TypeScript
    -- side already fell through; this one didn't, so the same server could
    -- read one namespace from Lua and another from JS.
    for _, convar in ipairs({ "tlib_community_id", "sv_projectName" }) do
        local cleaned = sanitize(GetConvar(convar, ""))
        if cleaned ~= "" then
            _prefix = cleaned
            break
        end
    end
end

--- A stable short id for the server this client is connected to.
---
--- The hash is djb2 over `GetCurrentServerEndpoint()`, reduced mod 2^32 and
--- formatted `%08x`. Do not "improve" it: the output IS part of stored KVP keys,
--- so any change silently abandons every player's saved per-server settings.
---
--- An unresolved endpoint returns `""`, not the hash of the empty string.
local _serverTag = nil
function kvp.serverTag()
    if _serverTag then return _serverTag end
    local endpoint = GetCurrentServerEndpoint() or ""
    if endpoint == "" then return "" end
    local h = 5381
    for i = 1, #endpoint do
        h = (h * 33 + endpoint:byte(i)) % 4294967296
    end
    _serverTag = string.format("%08x", math.floor(h))
    return _serverTag
end

--- Returns the fully namespaced KVP key: `<community>_<opts.prefix><key>_<tag>`,
--- with each of the three parts present only when it applies.
---
--- `opts.prefix` is an extra namespace applied INSIDE the community prefix, for a
--- resource that wants its own keys grouped (`tafk:`). `opts.serverScoped` is what
--- appends this server's tag; WITHOUT IT THE KEY IS SHARED ACROSS EVERY SERVER
--- the player visits, which is this module's default. See the header.
---
--- An empty server tag leaves a scoped key unscoped rather than appending `_`: a
--- dev session that never resolved an endpoint then keeps what the player tuned
--- instead of silently reverting them.
function kvp.key(key, opts)
    if opts then
        if opts.prefix then key = opts.prefix .. key end
        if opts.serverScoped then
            local tag = kvp.serverTag()
            if tag and tag ~= "" then key = key .. "_" .. tag end
        end
    end
    if _prefix then return _prefix .. "_" .. key end
    return key
end

--- The resolved community prefix, or nil when neither convar is set -- which is
--- the usual case. Worth printing in a `<resource>_diag` beside `serverTag()`:
--- together they are the whole of where this player's keys live.
function kvp.getPrefix()
    return _prefix
end

--- Build an accessor set whose keys all carry `opts`.
---
---     local prefs = tlib.kvp.view({ prefix = 'tafk:', nilWhenUnset = true })
---     prefs.getBool('playerDisabled')          --> nil until the player sets it
---
---     local fx = tlib.kvp.view({ serverScoped = true })
---     fx.getJson('radio_setting_fx_overrides') --> this server's tuning only
local function buildAccessors(into, opts)
    local function k(key)
        return kvp.key(key, opts)
    end

    local nilWhenUnset = opts ~= nil and opts.nilWhenUnset == true

    --- True only when the key has actually been written.
    function into.has(key)
        local resolved = k(key)
        local handle = StartFindKvp(resolved)
        if handle == -1 then return false end
        local found = FindKvp(handle)
        EndFindKvp(handle)
        return found == resolved
    end

    --- The value to hand back for a key that was never written. `default` always
    --- wins; `nilWhenUnset` only decides what "no default either" means.
    local function unset(default, zero)
        if default ~= nil then return default end
        if nilWhenUnset then return nil end
        return zero
    end

    function into.getString(key, default)
        local v = GetResourceKvpString(k(key))
        if v and v ~= "" then return v end
        return unset(default, "")
    end

    function into.getFloat(key, default)
        if not into.has(key) then return unset(default, 0.0) end
        return GetResourceKvpFloat(k(key))
    end

    function into.getInt(key, default)
        if not into.has(key) then return unset(default, 0) end
        return GetResourceKvpInt(k(key))
    end

    function into.getBool(key, default)
        local v = GetResourceKvpString(k(key))
        if v == "true" then return true end
        if v == "false" then return false end
        return unset(default, false)
    end

    function into.getJson(key, default)
        local v = GetResourceKvpString(k(key))
        if v and v ~= "" then
            local decoded = json.decode(v)
            if decoded then return decoded end
        end
        return default
    end

    function into.setString(key, value)
        SetResourceKvp(k(key), tostring(value))
    end

    function into.setFloat(key, value)
        SetResourceKvpFloat(k(key), value + 0.0)
    end

    function into.setInt(key, value)
        SetResourceKvpInt(k(key), math.floor(value))
    end

    function into.setBool(key, value)
        SetResourceKvp(k(key), value and "true" or "false")
    end

    function into.setJson(key, value)
        SetResourceKvp(k(key), json.encode(value))
    end

    --- Store by the value's own type.
    function into.set(key, value)
        local t = type(value)
        if t == "boolean" then
            into.setBool(key, value)
        elseif t == "number" then
            if value == math.floor(value) then
                into.setInt(key, value)
            else
                into.setFloat(key, value)
            end
        elseif t == "table" then
            into.setJson(key, value)
        else
            into.setString(key, tostring(value))
        end
    end

    --- Read back, inferring the type from what was stored.
    function into.get(key, default)
        local v = GetResourceKvpString(k(key))
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

    function into.delete(key)
        DeleteResourceKvp(k(key))
    end

    return into
end

--- A view onto the same store with `opts` baked into every key. The way to apply
--- `serverScoped` to a whole group of keys without repeating it at each call.
---
--- `view.key(k)` is the fully resolved key, for the rare caller that has to hand
--- the literal string to something else -- a NUI payload, a diagnostic line.
function kvp.view(opts)
    local view = buildAccessors({}, opts)
    function view.key(key)
        return kvp.key(key, opts)
    end
    return view
end

-- The module's own accessors are a view with no options, so there is exactly one
-- implementation of each getter and setter. `nil` opts is also what makes
-- `tlib.kvp.setString(...)` a community-prefixed, NOT server-scoped key -- the
-- bare module is the unscoped view, and a caller that wants isolation asks for it.
buildAccessors(kvp, nil)

return kvp
