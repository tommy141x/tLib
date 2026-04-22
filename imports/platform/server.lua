-- detect engine, load the matching server adapter (adapter IS the module)

local engine = "unknown"

-- IsDuplicityVersion is the canonical FiveM server-side check; it exists on
-- both client and server but only returns true on the server. GetCurrentResourceName
-- is also FiveM-specific but exists on both sides.
if type(IsDuplicityVersion) == "function" then
    engine = "fivem"
elseif Server or _G.Server then
    engine = "helix"
end

local path = ("imports/platform/adapters/%s_server.lua"):format(engine)
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
