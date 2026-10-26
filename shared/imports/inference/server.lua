-- Server-side facade over tLib's engine registry.
--
--   shared_scripts { '@tLib/imports.lua' }
--   tlib_module { 'inference' }
--
--   local shared = tlib.inference:lookup('text', 'qwen3-1.7b-q4_k_m')
--   if shared then
--       -- someone else already has these weights loaded; talk to shared.url
--   else
--       local handle = tlib.inference:advertise({
--           capability = 'text',
--           workload   = 'qwen3-1.7b-q4_k_m',
--           url        = 'http://127.0.0.1:18291/v1',
--           model      = 'local',
--       })
--   end
--
-- The field is `url`, not `baseUrl`: server/lib/inference/registry.ts reads
-- `request.url` and rejects an advertisement with no URL by returning '', so a
-- descriptor spelled `baseUrl` advertises nothing and reports it as nil.
--
-- No inference goes through tLib. An advertisement is a note about where an
-- engine is; the bytes go straight between the two resources over loopback.
-- Advertised URLs must be on 127.0.0.1 — the registry rejects anything else.

local inference = {}

--- Announce an engine this resource has running. Returns a handle, or nil if
--- the advertisement was rejected (missing fields, or a non-loopback URL).
function inference:advertise(descriptor)
    assert(type(descriptor) == 'table', 'advertise: descriptor table required')
    local handle = exports['tLib']:InferenceAdvertise(json.encode(descriptor))
    if type(handle) ~= 'string' or handle == '' then return nil end
    return handle
end

--- An engine another resource is already running for this exact workload, or
--- nil. Never returns this resource's own advertisement.
function inference:lookup(capability, workload)
    local encoded = exports['tLib']:InferenceLookup(capability, workload)
    if type(encoded) ~= 'string' or encoded == '' then return nil end
    local ok, parsed = pcall(json.decode, encoded)
    if not ok then return nil end
    return parsed
end

--- Whether a boolean-returning call said yes. A BOOL crossing the FiveM
--- boundary arrives as the NUMBER 1, not `true`, so `== true` is always false;
--- `not not v` is not the fix either, since 0 is truthy in Lua. The full
--- measurement is above `nativeTruth` in platform/client.lua.
local function nativeTruth(v)
    if v == true then return true end
    return type(v) == "number" and v ~= 0
end

--- Drop an advertisement early. Stopping the resource does this anyway.
function inference:withdraw(handle)
    if type(handle) ~= 'string' or handle == '' then return false end
    return nativeTruth(exports['tLib']:InferenceWithdraw(handle))
end

--- Every live advertisement, for diagnostics.
function inference:list()
    local encoded = exports['tLib']:InferenceList()
    if type(encoded) ~= 'string' or encoded == '' then return {} end
    local ok, parsed = pcall(json.decode, encoded)
    if not ok then return {} end
    return parsed
end

return inference
