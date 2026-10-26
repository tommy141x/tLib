-- Export/callback boundary. FiveM carries function references across VMs natively.
-- Keep the public methods used by existing consumers without callback-key shims.

-- The pcall is the point: an export that throws returns nil to its caller, and
-- the real error vanishes. The twin is shared/imports/platform/client.lua, which
-- a consumer VM loads; the two must not diverge.
--
-- FiveM infers the resource from the manifest; the argument is retained for
-- callers and used in the error line.
function Platform.wrapExport(resource, name, fn)
    exports(name, function(...)
        local result = table.pack(pcall(fn, ...))
        if result[1] then return table.unpack(result, 2, result.n) end
        print(("^1[%s] export '%s' threw: %s^7"):format(resource or "?", name, tostring(result[2])))
        return nil
    end)
end

function Platform.export(resource, name, fn)
    Platform.wrapExport(resource, name, fn)
end

function Platform.storeCallback(fn)
    return fn
end
