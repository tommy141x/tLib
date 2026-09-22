-- KVP namespace resolution: tlib_community_id, else sv_projectName, else none.
--
-- Pinned because the algorithm is written out three times — here, in
-- shared/ts/kvp.ts and in tRadio's client bridge — and they had already drifted:
-- a community id that sanitized away to nothing won here and disabled
-- namespacing, while the other two fell through to sv_projectName. The same
-- server could therefore read one namespace from Lua and another from JS.
-- shared/ts/kvp.test.ts asserts the same vectors against the TypeScript copy.

local convars = {}
GetConvar = function(name, default)
    local value = convars[name]
    if value == nil or value == '' then return default end
    return value
end

local function prefixFor(communityId, projectName)
    convars = { tlib_community_id = communityId, sv_projectName = projectName }
    -- Re-loaded per case: the module resolves the prefix once at load time.
    local kvp = dofile('shared/imports/kvp/client.lua')
    return kvp.key('tels_hud_layout')
end

assert(prefixFor('acme', 'Ignored') == 'acme_tels_hud_layout',
    'a usable community id wins')
assert(prefixFor('', 'MyServer') == 'MyServer_tels_hud_layout',
    'no community id falls back to the project name')
assert(prefixFor('!!!', 'MyServer') == 'MyServer_tels_hud_layout',
    'a community id that sanitizes to nothing falls through rather than winning')
assert(prefixFor('', '') == 'tels_hud_layout',
    'neither convar set leaves the key unprefixed')
assert(prefixFor('!!!', '???') == 'tels_hud_layout',
    'nothing usable anywhere leaves the key unprefixed')
assert(prefixFor('My Server! v2', '') == 'MyServerv2_tels_hud_layout',
    'spaces and punctuation are stripped, word characters and -_ kept')
assert(prefixFor('a-b_c', '') == 'a-b_c_tels_hud_layout',
    'hyphen and underscore survive sanitization')

print('PASS: KVP prefix resolution falls through unusable convars and matches the TS copy')
