-- TEMPORARY measurement probe. Delete this file and its fxmanifest entry once
-- the measurements are recorded.
--
-- Exists because both questions are about what happens INSIDE tLib's VM — the
-- VM that issues every write Discovery makes — and nothing else can reach in
-- here to ask.

--- The raw native, with the throw caught, from tLib's runtime.
exports('ProbeFsPerm', function(target, relPath, content)
    local ok, res = pcall(function()
        return SaveResourceFile(target, relPath, content or 'probe', -1)
    end)
    return json.encode({ ok = ok, res = tostring(res), writer = GetCurrentResourceName() })
end)

--- Node `fs`, via the same export the manifest half of the export feature uses.
exports('ProbeNodeFs', function(target, key, path)
    local ok, res = pcall(function()
        return exports[GetCurrentResourceName()]:AppendToManifest(target, key, path)
    end)
    return json.encode({ ok = ok, res = tostring(res) })
end)

--- A real end-to-end Discovery export, owned by tLib so its own local file
--- writes are always permitted. `target` is the resource to export into.
exports('ProbeExport', function(target)
    local disc = Discovery.create({
        metadataKey     = 'tlib_probe_config',
        defaultFileName = 'tlib-probe.json',
        localFile       = 'probe-data.json',
        localSection    = 'models',
        resourceName    = GetCurrentResourceName(),
        logTag          = 'probe',
    })

    disc:getConfigs()['probe_model'] = { siren = { maxHz = 745 }, note = 'probe' }
    local ok, targetPath, info = disc:exportConfig('probe_model', target)
    local staged = info and info.stagedPath and LoadResourceFile(GetCurrentResourceName(), info.stagedPath) or nil

    local out = {
        ok = ok,
        targetPath = targetPath,
        status = info and info.status,
        errorKind = info and info.errorKind,
        error = info and info.error,
        stagedPath = info and info.stagedPath,
        stagedBytes = staged and #staged or 0,
        stagedContents = staged,
        manifestLine = info and info.manifestLine,
        grantLine = info and info.grantLine,
        steps = info and info.steps,
        manifestOk = info and info.manifestOk,
        warnings = info and info.warnings,
        externalSourceAfter = disc:getExternalSource('probe_model'),
    }
    disc:dispose()
    return json.encode(out)
end)
