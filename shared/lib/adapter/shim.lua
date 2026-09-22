-- Export/callback boundary. FiveM carries function references across VMs natively.
-- Keep the public methods used by existing consumers without callback-key shims.

function Platform.wrapExport(resource, name, fn)
    -- FiveM infers the resource from the manifest; retain the argument for callers.
    exports(name, fn)
end

function Platform.export(resource, name, fn)
    Platform.wrapExport(resource, name, fn)
end

function Platform.storeCallback(fn)
    return fn
end
