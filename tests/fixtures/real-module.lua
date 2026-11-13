-- Serves one real tLib source file to a suite whose subject loads it by path
-- through the host's LoadResourceFile and load, as tLib's own VM does for its
-- import modules. fengari has no io.open, so the bytes come from loadfile.
--
--   dofile('tests/fixtures/real-module.lua')(env, 'shared/imports/nui/client.lua')
return function(env, path)
    local marker = 'MARKER:' .. path
    local serve = env.LoadResourceFile
    local compile = env.load or load

    env.LoadResourceFile = function(resource, requested)
        if requested == path then return marker end
        if serve then return serve(resource, requested) end
        return nil
    end
    env.load = function(chunk, name, mode, chunkEnv)
        if chunk == marker then return loadfile(path, 't', env) end
        return compile(chunk, name, mode, chunkEnv)
    end
end
