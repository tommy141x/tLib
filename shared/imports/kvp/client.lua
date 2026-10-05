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

--- A stable short id for the server this client is connected to.
---
--- Moved here from tRadio, which needed it because some settings are only
--- meaningful against one server's configuration: its Radio FX overrides are a
--- correction dialled in on top of that server's chain, and carried to the next
--- server they would correct a chain that was never wrong. That is not a tRadio
--- problem — it is true of any per-server tuning — so the scoping belongs in the
--- shared layer rather than being re-derived by each resource that notices.
---
--- ⚠️ The hash is djb2 over `GetCurrentServerEndpoint()`, reduced mod 2^32 and
--- formatted `%08x`. Do not "improve" it: the output IS part of stored KVP keys,
--- so any change silently abandons every player's saved per-server settings.
---
--- ⚠️ An unresolved endpoint returns `""`, not the hash of the empty string.
--- djb2's seed is 5381, so hashing `""` yields the perfectly plausible-looking
--- tag `00001505` — which is what tRadio's copy did, and it meant a client that
--- had not resolved an endpoint yet wrote its per-server settings into a shared
--- bucket named after nothing. The TypeScript half already had the right rule
--- ("an absent server tag leaves a scoped key unscoped rather than dropping
--- it"); this is the Lua half agreeing with it.
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

--- Returns the prefixed KVP key.
---
--- `opts.prefix` is an extra namespace applied inside the community prefix, and
--- `opts.serverScoped` appends `_<serverTag()>`. Both are opt-in: `kvp.key(k)`
--- on its own is byte-for-byte what it always was, which matters because these
--- strings are persisted.
---
--- An empty server tag leaves a scoped key unscoped rather than appending `_`.
--- A dev session or an environment that never resolved an endpoint then keeps
--- what the player tuned instead of silently reverting them — the same
--- single-store behaviour every unscoped setting already has.
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

--- Get the current community prefix (or nil if none).
function kvp.getPrefix()
    return _prefix
end

--- Build an accessor set whose keys all carry `opts`.
---
--- This is the one generalisation Item 2 needed. Two resources had forked the
--- persistence layer, and each fork existed for exactly one missing option:
---
--- - **tRadio** needed per-server scoping, and implemented it twice — once in
---   `client/cl_bridge.lua` as a `SERVER_SCOPED_SETTINGS` set plus a
---   `settingKvpKey` wrapper, and again in TypeScript as `SettingsStore`'s
---   `suffix`. Both sat on top of `tlib.kvp.key`, re-adding what they had just
---   been given.
--- - **tAFK** needed a `tafk:` namespace and reads that return `nil` rather than
---   a type zero, and wrote seven two-line wrappers in `client/cl_prefs.lua` to
---   get it.
---
--- Neither is a different idea about storage; both are the same storage with a
--- different key and a different "never set" answer. So:
---
---     local prefs = tlib.kvp.view({ prefix = 'tafk:', nilWhenUnset = true })
---     prefs.getBool('playerDisabled')          --> nil until the player sets it
---
---     local fx = tlib.kvp.view({ serverScoped = true })
---     fx.getJson('radio_setting_fx_overrides') --> this server's tuning only
---
--- `nilWhenUnset` changes only the never-written answer. An explicit `default`
--- argument still wins over it, so a caller that wants a fallback asks for one.
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

--- A view onto the same store with `opts` baked into every key.
---
--- `view.key(k)` is the fully resolved key, for the rare caller that has to hand
--- one to something else. It is deliberately NOT installed on the module itself:
--- `kvp.key(key, opts)` already takes the options explicitly, and overwriting it
--- with a one-argument form would silently drop every `serverScoped` request.
function kvp.view(opts)
    local view = buildAccessors({}, opts)
    function view.key(key)
        return kvp.key(key, opts)
    end
    return view
end

-- The module's own accessors are a view with no options, so there is exactly one
-- implementation of each and `tlib.kvp.getBool` cannot drift from
-- `tlib.kvp.view({}).getBool`.
buildAccessors(kvp, nil)

return kvp
