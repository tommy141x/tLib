-- Resource file writes that survive FiveM for GTAV Enhanced.
--
--   local ok, err = tlib.fs.writeResourceFile('data.json', encoded)
--   if not ok then log('could not write data.json — ' .. err, tlib.logger.ERROR) end
--
-- Server-only: it writes a resource file, which does not work from a client VM.
--
-- On Enhanced, `SaveResourceFile` returns false for some resources while
-- Node's `fs` writes the identical path successfully (cause unknown; the
-- workaround is proven). tRadio, tLS and tDetector each shipped their own
-- Node bridge for this before it became a tLib module.
--
-- The bridge is the CALLING resource's own export (`exports[resource]:WriteResourceFile`),
-- registered by `registerWriteResourceFile()` from tLib/shared/ts/fs/server.ts
-- in each resource's own bundle. It used to be one central `exports.tLib:...`
-- bridge; that failed because FiveM's Node runtime sandboxes each resource to
-- its own directory, so tLib writing into tDetector's folder was refused with
-- "Access to this API has been restricted. Use --allow-fs-write" (a server
-- startup argument, not a manifest key) -- so the write has to originate
-- inside the resource it lands in. A consumer must therefore register the
-- export in its own server/main.ts, or the error below names that.
--
-- Untreated the failure is silent and total: the file never changes, every
-- saved setting is gone on restart, and the caller still logs "Saved". Do not
-- drop the returned `err` on the floor.
--
-- The native is tried first and the bridge consulted only when it fails, so
-- Legacy behaviour is unchanged and never reaches the bridge.

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

    -- Demo mode: the write is dropped and reported as a success, so the file on
    -- disk stays pristine for the next start while the caller's in-memory state
    -- is already the live answer. Reporting `true` is deliberate -- every other
    -- caller treats a failure as data loss and tells the player so, which would
    -- put a red toast behind every settings change on an otherwise-working demo.
    if tlib.demo.dropWrite(('%s/%s'):format(resource, relPath)) then return true end

    if nativeWriteUsable[resource] ~= false then
        local ok, native = pcall(SaveResourceFile, resource, relPath, contents, -1)
        -- The native returns a byte count (or true) on success; false/nil on failure.
        if ok and native and native ~= false and (type(native) ~= "number" or native >= 0) then
            nativeWriteUsable[resource] = true
            return true
        end
        -- WARN, not ERROR. tLS's original copy of this said ERROR, which was
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
