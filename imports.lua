--[[
    tLib/imports.lua
    Single entry point for consumer resources.

    Usage in consumer fxmanifest.lua:
        shared_scripts { '@tLib/imports.lua' }

    This sets up a global `tlib` table with lazy-loading:
        tlib.coords   → loads imports/coords/shared.lua (Coords.*)

    Modules are loaded on first access. You can also eagerly load modules
    by listing them in your fxmanifest.lua:
        tlib_module { 'coords' }

    Heavy / stateful systems (Discovery, Menu, Dialog, Toast, Theme) are
    accessed via exports['tLib']:Method() — they run inside tLib's own VM.
]]

local resourceName = GetCurrentResourceName()
local tLibName = 'tLib'

if resourceName == tLibName then return end

if GetResourceState(tLibName) ~= 'started' then
    error('^1tLib must be started before this resource.^0', 0)
end

local context = IsDuplicityVersion() and 'server' or 'client'

-- Apply CFX-idiom polyfills (Citizen, CreateThread, Wait, GetGameTimer) in
-- the consumer VM on Helix so existing FiveM-pattern code keeps running
-- without per-resource changes. Self-contained — does not require Platform.
do
    local polyfill = LoadResourceFile(tLibName, 'lua/adapter/polyfill.lua')
    if polyfill then
        local fn, err = load(polyfill, '@@tLib/lua/adapter/polyfill.lua')
        if fn then pcall(fn) end
    end
end

-- Enforce tlib_min_version *before* anything touches tlib, so an outdated
-- tLib produces a clear "update tLib" message instead of a cryptic
-- "No such export X" when a module added in a later tLib version is used.
-- Duplicated from imports/versioncheck/server.lua because this file runs
-- in consumer resource VMs, while versioncheck runs inside tLib's own VM.
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

local function loadModule(self, module)
    local dir = ('imports/%s'):format(module)
    local chunk = LoadResourceFile(tLibName, ('%s/%s.lua'):format(dir, context))
    local shared = LoadResourceFile(tLibName, ('%s/shared.lua'):format(dir))

    if shared then
        chunk = (chunk and ('%s\n%s'):format(shared, chunk)) or shared
    end

    if chunk then
        local fn, err = load(chunk, ('@@tLib/imports/%s/%s.lua'):format(module, context))

        if not fn or err then
            if shared then
                fn, err = load(shared, ('@@tLib/imports/%s/shared.lua'):format(module))
            end

            if not fn or err then
                return error(('\n^1Error importing tLib module (%s): %s^0'):format(dir, err), 3)
            end
        end

        local result = fn()
        self[module] = result or true
        return self[module]
    end
end

local function call(self, index)
    local module = rawget(self, index)

    if not module then
        module = loadModule(self, index)

        if not module then
            -- Fall through to tLib exports for non-import modules
            local function method(...)
                return exports[tLibName][index](nil, ...)
            end
            self[index] = method
            return method
        end
    end

    return module
end

local tlib = setmetatable({
    name = tLibName,
    context = context,
    resource = resourceName,
}, {
    __index = call,
    __call = call,
})

_ENV.tlib = tlib

-- Eagerly load modules declared in the consumer's fxmanifest:
--   tlib_modules { 'coords' }
for i = 1, GetNumResourceMetadata(resourceName, 'tlib_module') do
    local name = GetResourceMetadata(resourceName, 'tlib_module', i - 1)
    if name and not rawget(tlib, name) then
        loadModule(tlib, name)
    end
end

