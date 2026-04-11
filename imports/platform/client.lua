-- detect engine, load the matching adapter directly (adapter IS the module)

local engine = "unknown"

if GetCurrentResourceName then
    engine = "fivem"
elseif Client then
    engine = "helix"
end

local path = ("imports/platform/adapters/%s_client.lua"):format(engine)
local src = LoadResourceFile("tLib", path)

if not src then
    error(("[tLib] No platform adapter found for engine '%s' at %s"):format(engine, path))
end

local fn, err = load(src, ("@@tLib/%s"):format(path))
if not fn then
    error(("[tLib] Failed to load platform adapter: %s"):format(err))
end

local adapter = fn()
adapter._engine = engine

return adapter
