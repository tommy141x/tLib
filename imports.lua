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

-- Don't load into tLib's own VM (it loads modules directly via fxmanifest)
if resourceName == tLibName then return end

local context = IsDuplicityVersion() and 'server' or 'client'

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
