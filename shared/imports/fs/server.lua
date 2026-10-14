-- Resource file writes that survive FiveM for GTAV Enhanced.
--
--   local ok, err = tlib.fs.writeResourceFile('data.json', encoded)
--   if not ok then log('could not write data.json — ' .. err, tlib.logger.ERROR) end
--
-- Server-only: it writes a resource file, which does not work from a client VM.
--
-- Why this exists
--
-- On Enhanced, `SaveResourceFile` returns false for some resources while Node's
-- `fs` writes the identical path successfully. The cause is still unknown; the
-- workaround is proven. tRadio hit it first, then tELS, then tDetector — and
-- each one shipped its own Node bridge for it, which is why this is a tLib
-- module rather than a fourth copy.
--
-- The bridge is the CALLING resource's own export
--
-- The Node half is `WriteResourceFile`, registered by
-- `registerWriteResourceFile()` from tLib/shared/ts/fs/server.ts. The
-- implementation is shared at BUILD time and every resource registers it in its
-- own server bundle, so this looks it up on the LOCAL resource:
-- `exports[GetCurrentResourceName()]`.
--
-- It used to call `exports.tLib:WriteResourceFile(...)` — one central bridge.
-- That cannot work: FiveM's Node runtime sandboxes each resource to its own
-- directory, so tLib writing into tDetector's folder was refused outright with
-- "Access to this API has been restricted. Use --allow-fs-write". That flag is a
-- server STARTUP ARGUMENT, not a manifest key, so the only fix available to a
-- shipped product is for the write to originate inside the resource it lands in.
--
-- The consequence for a consumer: a resource that calls this must register the
-- export in its own server/main.ts. If it has not, the error below says so by
-- name rather than leaving a silent no-op.
--
-- Untreated the failure is silent and total: the file never changes and every
-- setting the customer saves is gone on restart, while the code that asked for
-- the write logs a cheerful "Saved". Do not drop the returned `err` on the
-- floor; that silence is the whole bug.
--
-- Legacy safety
--
-- The native is tried FIRST and the bridge is consulted only when it fails, so
-- Legacy behaviour is byte-for-byte unchanged and the bridge is never reached
-- there.

local fs = {}

--- Whether SaveResourceFile works, per TARGET resource.
--- nil = not yet determined, true = usable, false = known broken this session.
---
--- Memoised because the answer is a property of the runtime, not of the call: it
--- cannot change while the server is up. Without this, Enhanced would make a
--- futile native call before every single write.
---
--- Keyed by resource rather than held as one flag because writing into ANOTHER
--- resource's folder is a separate permission from writing into our own. One
--- shared flag would let a refused cross-resource write on Legacy divert our own
--- data.json to the bridge — a behaviour change on a platform where nothing is
--- wrong. Each target gets its own verdict.
local nativeWriteUsable = {}

--- SaveResourceFile, falling back to this resource's Node fs bridge when it is
--- refused.
---
--- @param relPath  string   path relative to the target resource's root
--- @param contents string   the bytes to write
--- @param resource string|nil  target resource; defaults to the calling one
--- @param log      function|nil  a tlib.logger.create handle, for the one-time
---                 notice that this environment needs the bridge. Optional
---                 because the caller always gets `err` back either way.
--- @return boolean ok, string|nil err  -- err is a real errno message when available
function fs.writeResourceFile(relPath, contents, resource, log)
    resource = resource or GetCurrentResourceName()

    -- Demo mode: the write is dropped and reported as a success. The caller's
    -- in-memory state is already the live answer for the rest of this resource's
    -- lifetime, and the file on disk stays exactly as it shipped, which is what
    -- makes the next start pristine.
    --
    -- `true`, not an error, is deliberate. Every caller of this treats a failure
    -- as data loss and says so to the player -- correctly, because normally it
    -- is. On a demo server the save did precisely what was asked of it, so
    -- failing it would put a red toast behind every settings change and make a
    -- working demo look broken. The console says once per target what happened.
    if tlib.demo.dropWrite(('%s/%s'):format(resource, relPath)) then return true end

    if nativeWriteUsable[resource] ~= false then
        local ok, native = pcall(SaveResourceFile, resource, relPath, contents, -1)
        -- The native returns a byte count (or true) on success; false/nil on failure.
        if ok and native and native ~= false and (type(native) ~= "number" or native >= 0) then
            nativeWriteUsable[resource] = true
            return true
        end
        -- WARN, not ERROR. tELS's original copy of this said ERROR, which was
        -- right when nothing caught the refusal; now the bridge does, the write
        -- still lands and nothing is lost, so an ERROR here is a red line on a
        -- healthy Enhanced server every boot. It is still said once per target
        -- resource, because "the native is refused here" is worth knowing when
        -- reading any later failure.
        if nativeWriteUsable[resource] == nil and type(log) == "function" then
            log(("SaveResourceFile cannot write to '%s' in this environment "
                .. "(expected on FiveM Enhanced) — using this resource's Node fs bridge for it from now on")
                :format(resource), tlib.logger.WARN)
        end
        nativeWriteUsable[resource] = false
    end

    -- Contract: true on success, or a NON-EMPTY error string. Never false, never
    -- "" — an empty string is truthy in Lua and would read as success.
    -- The LOCAL resource's export, never tLib's: see the header. Resolved on
    -- every call rather than cached, because the handle is cheap and a cached
    -- one would pin this module to whichever VM first used it — it is dofile'd
    -- into each consumer, so there is no single owner to cache for.
    local self = GetCurrentResourceName()
    local ok, res = pcall(function()
        return exports[self]:WriteResourceFile(resource, relPath, contents)
    end)
    if not ok then
        -- The bridge catches its own filesystem errors and answers with a
        -- string, so an error crossing this boundary means the export itself is
        -- not there. Naming it matters: "permission denied" would send the
        -- server owner auditing directory modes for a missing-file problem.
        return false, ("'%s' has no Node fs bridge — its Node fs bridge is unavailable (%s) and "
            .. "SaveResourceFile also failed. Its server bundle must call "
            .. "registerWriteResourceFile() from tLib/shared/ts/fs/server.ts, and "
            .. "server/dist/bundle.js must be rebuilt and loaded")
            :format(self, tostring(res))
    end
    if res == true then return true end
    if type(res) == "string" and res ~= "" then return false, res end
    -- Any other shape is a contract the bridge does not describe; report the
    -- path rather than silently treating an unknown answer as a success.
    return false, ("'%s' Node fs bridge gave an unrecognised answer (%s) for '%s'")
        :format(self, type(res), relPath)
end

return fs
