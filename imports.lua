--[[
    The consumer entry point: `shared_scripts { '@tLib/imports.lua' }`.
    Modules lazy-load on first access of `tlib.<name>`.
    Design notes: docs/internal/imports-entrypoint.md
]]

local resourceName = GetCurrentResourceName()
local tLibName = 'tLib'

if resourceName == tLibName then return end

if GetResourceState(tLibName) ~= 'started' then
    error('^1tLib must be started before this resource.^0', 0)
end

local context = IsDuplicityVersion() and 'server' or 'client'

-- Enforce tlib_min_version *before* anything touches tlib, so an outdated tLib
-- says "update tLib" instead of "No such export X". Duplicated from
-- versioncheck/server.lua: this file runs in consumer VMs, that one in tLib's.
local function parseVer(s)
    if not s then return { 0, 0, 0 } end
    s = s:gsub('^v', '')
    local parts = {}
    for n in s:gmatch('%d+') do parts[#parts + 1] = tonumber(n) end
    while #parts < 3 do parts[#parts + 1] = 0 end
    return parts
end

local requiredVersion = GetResourceMetadata(resourceName, 'tlib_min_version', 0)
if requiredVersion and requiredVersion ~= '' then
    local tlibVersion = GetResourceMetadata(tLibName, 'version', 0) or '0.0.0'
    local req, cur = parseVer(requiredVersion), parseVer(tlibVersion)
    local outdated = false
    for i = 1, 3 do
        if cur[i] < req[i] then outdated = true; break
        elseif cur[i] > req[i] then break end
    end
    if outdated then
        error(('\n^1[%s] requires tLib v%s or newer — installed tLib is v%s. Update tLib.^0')
            :format(resourceName, requiredVersion, tlibVersion), 0)
    end
end

--- The ONE file implementing `name` in this VM, as source plus its path, or nil.
--- `<context>.lua` wins and `shared.lua` is the fallback; they are never
--- concatenated, so a module is context-specific or context-agnostic, not both.
--- Reads files rather than the module cache, so it is also `has`'s honest answer.
local function moduleSource(name)
    if type(name) ~= 'string' or name == '' then return nil end

    local base = 'shared/imports/' .. name .. '/'
    local path = base .. context .. '.lua'
    local source = LoadResourceFile(tLibName, path)

    if not source then
        path = base .. 'shared.lua'
        source = LoadResourceFile(tLibName, path)
    end

    if not source then return nil end
    return source, path
end

local function loadModule(self, name)
    local source, path = moduleSource(name)
    if not source then return nil end

    local body, syntaxError = load(source, '@@tLib/' .. path)
    if not body then
        error(('\n^1tLib module %s will not compile: %s^0'):format(path, syntaxError), 2)
    end

    -- `or true`: a module whose wiring IS its file scope has nothing to return
    -- (shared/imports/hud/client.lua), and caching nil would send the next
    -- access to the export proxy below instead.
    local loaded = body() or true
    self[name] = loaded
    return loaded
end

local function resolve(self, name)
    local module = loadModule(self, name)
    if module then return module end

    -- Not an import module, so treat the name as a tLib export. Cached, so the
    -- metatable answers for a given name exactly once.
    local function forward(...)
        return exports[tLibName][name](nil, ...)
    end

    self[name] = forward
    return forward
end

local tlib = setmetatable({
    name = tLibName,
    context = context,
    resource = resourceName,
    -- `tlib.<anything>` is never falsy -- an unknown name resolves to the
    -- forwarding function above -- so `if tlib.diag then` is not a guard. This
    -- is, and it never runs the module body.
    has = function(name) return moduleSource(name) ~= nil end,
}, { __index = resolve })

_ENV.tlib = tlib

--- Modules whose LOADING IS THEIR WIRING, loaded by tLib itself: their file
--- scope registers the handler, and a consumer may have no Lua call to trigger
--- the lazy load. `studioOnly` is a default, not a permission.
local AUTOLOAD = {
    { name = 'occupancy' },
    { name = 'telemetry', studioOnly = true },
}

--- Does this consumer's manifest credit the studio? Loaded by path into a
--- private env, because sh_branding.lua assigns a global `StudioBranding`.
local isStudio
local function studioResource()
    if isStudio ~= nil then return isStudio end
    isStudio = false
    -- An authorless manifest cannot be the studio, and answering from metadata
    -- avoids compiling sh_branding.lua into every third-party consumer's VM.
    if GetNumResourceMetadata(resourceName, 'author') == 0
        and GetNumResourceMetadata(resourceName, 'authors') == 0 then
        return false
    end
    local chunk = LoadResourceFile(tLibName, 'shared/sh_branding.lua')
    if chunk then
        local fn = load(chunk, '@@tLib/shared/sh_branding.lua', 't',
            setmetatable({}, { __index = _ENV }))
        local ok, branding = pcall(fn)
        if ok and type(branding) == 'table' then
            isStudio = branding.isStudioResource(resourceName) == true
        end
    end
    return isStudio
end

--- Can this VM read tLib's files AT ALL? The discriminator between "one module
--- is missing" and "I cannot read tLib", which have different fixes. Asked only
--- after a module has already failed.
local function tlibReadable()
    return LoadResourceFile(tLibName, 'fxmanifest.lua') ~= nil
end

for _, entry in ipairs(AUTOLOAD) do
    if (not entry.studioOnly or studioResource()) and not rawget(tlib, entry.name) then
        -- These names are tLib's own, so one that resolves to no file is a tLib
        -- packaging bug rather than a consumer typo.
        if not loadModule(tlib, entry.name) and tlibReadable() then
            -- A print, not error(): this is a shared_script in every consumer,
            -- so raising here stops every t* resource on the server at once.
            print(('^1[tLib] cannot load its own module "%s" — no '
                .. 'shared/imports/%s/%s.lua and no shared.lua. tLib v%s is packaged '
                .. 'wrong; %s is running WITHOUT it.^0')
                :format(entry.name, entry.name, context,
                    GetResourceMetadata(tLibName, 'version', 0) or '?', resourceName))
        end
    end
end

-- Eagerly load modules the consumer's manifest declares:
--   tlib_module { 'coords' }   /   tlib_modules { 'coords', 'kvp' }
--
-- Load-bearing only for `realtime`, which tLib's server bundle reads off the
-- manifest to decide whether to install the realtime hub. Otherwise an auditable
-- parts list.
for _, key in ipairs({ 'tlib_module', 'tlib_modules' }) do
    local declared = GetNumResourceMetadata(resourceName, key)
    for index = 0, declared - 1 do
        local name = GetResourceMetadata(resourceName, key, index)
        if name and not rawget(tlib, name) then
            loadModule(tlib, name)
        end
    end
end

