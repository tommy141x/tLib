-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/modules.lua
--
-- Oracle for tlib.modules — content discovery by `module.json`.
--
-- Two things are under test, and they fail differently:
--
--   1. THE CONTRACT. Every case in tests/fixtures/module-manifest-cases.lua is
--      run through modules.validate. That file is GENERATED from the case list
--      in tests/unit/module-manifest.test.ts, which runs the same cases through
--      the TypeScript validator, so a rule that exists on one side only fails
--      on one side or the other. Do not hand-edit it.
--
--   2. THE SCAN. Discovery itself: the reserved-name guard, kind matching, the
--      cache rules, and the live-read fallback that makes a drop-in install
--      visible without a restart.
--
-- The real shipped file is loaded with mocked natives rather than reimplemented.

local report = print
local passed = 0

local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        report('FAIL ' .. name .. ': ' .. tostring(err))
        error('suite failed', 0)
    end
    passed = passed + 1
    report('PASS ' .. name)
end

-- Host stubs

-- `dirs[base]` is the directory listing; `files[path]` is file content. Two
-- tables rather than one tree because that is exactly the split the runtime
-- sees: a directory listing comes from tLib's Node bundle and file content
-- comes from LoadResourceFile, and the whole live-read question is what happens
-- when the first knows about something the second does not.
local dirs = {}
local files = {}
local liveFiles = {}
local exportsAvailable = true
local popenWorks = false

GetCurrentResourceName = function() return 'tRadio' end
GetResourcePath = function() return '/resources/tRadio' end
LoadResourceFile = function(resource, path)
    assert(resource == 'tRadio', 'unexpected resource: ' .. tostring(resource))
    return files[path]
end

-- Identity codec. What is under test is which manifests are ACCEPTED, so a real
-- serialiser would only add a way for the suite to fail for a reason that is not
-- the thing being measured. `badJson` is the one string that is not a handle.
local encoded = {}
local function encodeTable(value)
    encoded[#encoded + 1] = value
    return '\0json:' .. tostring(#encoded)
end
json = {
    encode = encodeTable,
    decode = function(s)
        local n = tostring(s):match('^\0json:(%d+)$')
        if not n then error('not encoded by this stub: ' .. tostring(s)) end
        return encoded[tonumber(n)]
    end,
}

exports = setmetatable({}, {
    __index = function(_, key)
        assert(key == 'tLib', 'unexpected export target: ' .. tostring(key))
        if not exportsAvailable then error('tLib export not registered yet') end
        return {
            ListResourceDirs = function(_, resource, base)
                assert(resource == 'tRadio')
                return encodeTable(dirs[base] or {})
            end,
            ListResourceFiles = function(_, resource, base)
                assert(resource == 'tRadio')
                local names = {}
                for path in pairs(files) do
                    local name = path:match('^' .. base:gsub('([%-%.])', '%%%1') .. '/([^/]+)$')
                    if name then names[#names + 1] = name end
                end
                for path in pairs(liveFiles) do
                    local name = path:match('^' .. base:gsub('([%-%.])', '%%%1') .. '/([^/]+)$')
                    if name then names[#names + 1] = name end
                end
                return encodeTable(names)
            end,
            ReadResourceFile = function(_, resource, path)
                assert(resource == 'tRadio')
                return liveFiles[path] or files[path] or ''
            end,
        }
    end,
})

-- io.popen is the fallback when the export is absent. Off by default so the
-- export path is what the scan tests exercise.
io.popen = function()
    if not popenWorks then error('directory listing unavailable') end
    return {
        lines = function()
            local index = 0
            local list = dirs['layouts'] or {}
            return function()
                index = index + 1
                return list[index]
            end
        end,
        close = function() end,
    }
end
os.getenv = function() return nil end

local modules = dofile('shared/imports/modules/shared.lua')

local refusals = {}
modules.onRefusal = function(base, id, err)
    refusals[#refusals + 1] = { base = base, id = id, err = err }
end

local function reset()
    dirs, files, liveFiles, refusals = {}, {}, {}, {}
    exportsAvailable, popenWorks = true, false
    modules.clearCache()
end

--- Put a module on disk: visible to both the listing and LoadResourceFile.
local function place(base, id, manifest, extra)
    dirs[base] = dirs[base] or {}
    local list = dirs[base]
    list[#list + 1] = id
    if manifest ~= nil then
        files[base .. '/' .. id .. '/module.json'] = encodeTable(manifest)
    end
    for name, body in pairs(extra or {}) do
        files[base .. '/' .. id .. '/' .. name] = body
    end
end

local function ids(list)
    local out = {}
    for _, entry in ipairs(list) do out[#out + 1] = entry.id end
    return table.concat(out, ',')
end

local function refusalMentioning(needle)
    for _, r in ipairs(refusals) do
        if tostring(r.err):find(needle, 1, true) then return r end
    end
    return nil
end

local LAYOUT = { schema = 1, kind = 'layout', id = 'QRX-720', name = 'QRX-720', version = '1.0.0' }
local function layoutFor(id)
    return { schema = 1, kind = 'layout', id = id, name = id, version = '1.0.0' }
end

-- 1. The shared contract cases

test('every shared contract case gets the same verdict as the TypeScript validator', function()
    local cases = dofile('tests/fixtures/module-manifest-cases.lua')
    assert(#cases >= 40, 'the shared case list looks truncated: ' .. #cases)
    for index, case in ipairs(cases) do
        local manifest, err = modules.validate(case.manifest, case.id, case.kind)
        if case.expect == true then
            assert(manifest ~= nil,
                ('case %d (%s) should be accepted, got: %s'):format(index, case.why, tostring(err)))
        else
            assert(manifest == nil,
                ('case %d (%s) should be refused'):format(index, case.why))
            assert(tostring(err):find(case.expect, 1, true),
                ('case %d (%s): expected a message containing %q, got %q')
                    :format(index, case.why, case.expect, tostring(err)))
        end
    end
end)

-- 2. The reserved-name guard
--
-- This is the collision the module shape exists to remove. Before it, the only
-- reason `layouts/themes` was not picked up as a radio model was that it held no
-- `ui.html`. Now every module folder holds the same `module.json`, so without an
-- explicit guard the category directory IS a candidate.

test('a layout folder literally named "themes" is not discovered as a layout', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    -- A hostile or careless module that took the category directory's name, with
    -- a manifest that is valid in every other respect.
    place('layouts', 'themes', { schema = 1, kind = 'layout', id = 'themes', name = 'Themes', version = '1.0.0' })
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'QRX-720',
        'a module named themes must not appear in the layout scan')
    -- Two independent guards, one assertion each. The line above is satisfied by
    -- modules.validate's reserved check (the shared contract case covers that
    -- directly). This one is satisfied only by the skip inside modules.list: with
    -- the skip gone, the folder is read, validate refuses it, and the refusal is
    -- reported — so an operator would see a complaint about a directory that on
    -- a normal server is supposed to be there.
    assert(#refusals == 0,
        'a reserved name must be skipped before it is read, not read and then complained about')
end)

test('the real themes category directory is skipped silently, not reported as broken', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    -- The genuine article: a directory holding theme modules, with no manifest of
    -- its own. It is supposed to be there.
    dirs['layouts'] = { 'QRX-720', 'themes', 'sounds' }
    modules.scan('layouts', 'layout')
    assert(#refusals == 0, 'the category directories must not produce refusal noise: ' .. #refusals)
end)

test('asking for a reserved name directly is refused by name', function()
    reset()
    place('layouts', 'themes', { schema = 1, kind = 'layout', id = 'themes', name = 'Themes', version = '1.0.0' })
    local manifest, err = modules.read('layouts', 'themes', 'layout')
    assert(manifest == nil, 'modules.read must refuse a reserved id')
    assert(tostring(err):find('reserved', 1, true), 'the message must say why: ' .. tostring(err))
end)

test('both category names are reserved, and only those two', function()
    reset()
    assert(modules.RESERVED.themes == true)
    -- `sounds` is reserved even though a sound is not a module: `layouts/sounds/`
    -- is still a category directory, holding the flat audio files, so a LAYOUT
    -- called `sounds` would shadow every sound on the server.
    assert(modules.RESERVED.sounds == true)
    local count = 0
    for _ in pairs(modules.RESERVED) do count = count + 1 end
    assert(count == 2, 'RESERVED grew without a release note: ' .. count)
    -- A module called `dark` or `default` is ordinary content, not reserved.
    assert(modules.RESERVED.dark == nil and modules.RESERVED.default == nil)
end)

-- 3. Kind matching

test('a theme module sitting in layouts/ is refused with a message naming the mismatch', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    place('layouts', 'dark', { schema = 1, kind = 'theme', id = 'dark', name = 'Dark', version = '1.0.0' })
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'QRX-720')
    local refusal = refusalMentioning('declares kind "theme"')
    assert(refusal ~= nil, 'the mismatch must be reported, not silently dropped')
    assert(refusal.id == 'dark')
end)

test('a folder with no manifest at all is not reported as a refusal', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    dirs['layouts'][#dirs['layouts'] + 1] = 'scratch-copy'
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'QRX-720')
    assert(#refusals == 0, 'a folder that is simply not a module is nobody\'s mistake')
end)

test('a malformed manifest IS reported', function()
    reset()
    dirs['layouts'] = { 'broken' }
    files['layouts/broken/module.json'] = 'badJson'
    assert(#modules.scan('layouts', 'layout') == 0)
    assert(refusalMentioning('not valid JSON') ~= nil, 'unparseable JSON must be said out loud')
end)

test('scan refuses an unknown kind rather than scanning for nothing', function()
    reset()
    local ok = pcall(modules.scan, 'layouts', 'skin')
    assert(not ok, 'an unknown kind is a programming error, not an empty result')
end)

-- 4. What scan returns

test('an empty directory never invents a default', function()
    reset()
    assert(#modules.scan('layouts', 'layout') == 0, 'empty directory must not invent default')
end)

test('an unavailable scanner never invents a default either', function()
    reset()
    exportsAvailable = false
    assert(#modules.scan('layouts', 'layout') == 0, 'unavailable scanner must not invent default')
end)

test('results are sorted, and list carries the manifest so callers need not re-read', function()
    reset()
    place('layouts', 'ZTR-540', layoutFor('ZTR-540'))
    place('layouts', 'DRX-330', layoutFor('DRX-330'))
    place('layouts', 'QRX-720', LAYOUT)
    assert(ids(modules.list('layouts', 'layout')) == 'DRX-330,QRX-720,ZTR-540')
    for _, entry in ipairs(modules.list('layouts', 'layout')) do
        assert(entry.manifest.name == entry.id, 'list must hand back the parsed manifest')
    end
end)

test('a traversal-shaped basePath is refused before any listing', function()
    reset()
    assert(#modules.scan('layouts/../../etc', 'layout') == 0)
end)

test('themes scan from their own directory', function()
    reset()
    place('layouts/themes', 'dark', { schema = 1, kind = 'theme', id = 'dark', name = 'Dark', version = '1.0.0' })
    assert(table.concat(modules.scan('layouts/themes', 'theme'), ',') == 'dark')
end)

-- The asymmetry, asserted from the Lua side.
--
-- A sound is a FLAT AUDIO FILE on a FiveM resource -- `layouts/sounds/ptt.wav` --
-- so an operator can drag a `.wav` in and have it work with no manifest to
-- author. It is a module in the STUDIO and in the MARKETPLACE, where a folder and
-- a `module.json` carry its name, licence, duration and waveform peaks; the
-- installer reads that manifest and writes only the audio, flat.
--
-- So asking this gate to scan for sounds is a programming error, and a studio
-- sound manifest that somehow reached a resource is refused by name. Both are
-- asserted, because "it happens not to find any" and "it refuses to look" are
-- very different answers to a caller holding an empty list.
test('a resource does not read sound modules from disk at all', function()
    reset()
    local ok, err = pcall(modules.scan, 'layouts/sounds', 'sound')
    assert(not ok, 'scanning for sounds must be refused, not answered with {}')
    assert(tostring(err):find('layout, theme', 1, true),
        'the error must name the kinds a resource can use: ' .. tostring(err))

    -- And a studio artefact in the wrong place is refused rather than loaded.
    place('layouts/sounds', 'ptt', {
        schema = 1, kind = 'sound', id = 'ptt', name = 'PTT', version = '1.0.0',
        sound = { file = 'ptt.wav', peaks = { 0, 1 }, toneKeys = { 'PTT' } },
    })
    local manifest, readErr = modules.read('layouts/sounds', 'ptt', nil)
    assert(manifest == nil, 'a sound manifest must not validate against this gate')
    assert(tostring(readErr):find('layout, theme', 1, true), tostring(readErr))
end)

test('a layout or theme manifest carrying sound facts is refused', function()
    -- Not a sound rule -- a LAYOUT rule. A field that does nothing is a field
    -- someone will eventually trust, and a skin author who pastes a `sound` block
    -- in and hears nothing should be told why.
    reset()
    local manifest, err = modules.validate(
        { schema = 1, kind = 'layout', id = 'QRX-720', name = 'QRX-720', version = '1.0.0',
          sound = { file = 'ptt.wav' } }, 'QRX-720', 'layout')
    assert(manifest == nil)
    assert(tostring(err):find('must not carry "sound"', 1, true), tostring(err))
end)

-- 5. The cache, and the live-scan property

test('an empty answer is not cached, so a late-starting tLib export is not fatal', function()
    reset()
    exportsAvailable = false
    assert(#modules.scan('layouts', 'layout') == 0)
    exportsAvailable = true
    place('layouts', 'QRX-720', LAYOUT)
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'QRX-720',
        'caching the empty result would freeze the resource at zero modules')
end)

test('a non-empty answer is cached until clearCache', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    assert(#modules.scan('layouts', 'layout') == 1)
    place('layouts', 'ZTR-540', layoutFor('ZTR-540'))
    assert(#modules.scan('layouts', 'layout') == 1, 'the second scan must come from cache')
    modules.clearCache()
    assert(#modules.scan('layouts', 'layout') == 2)
end)

test('each kind and base caches separately', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    place('layouts/themes', 'dark', { schema = 1, kind = 'theme', id = 'dark', name = 'Dark', version = '1.0.0' })
    assert(#modules.scan('layouts', 'layout') == 1)
    assert(#modules.scan('layouts/themes', 'theme') == 1, 'a cached layout scan must not answer for themes')
end)

test('a module dropped in while the resource runs is discovered without a restart', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT)
    -- A marketplace install, or a folder copied in by hand: the directory listing
    -- sees it because that reads the real filesystem, but LoadResourceFile does
    -- not, because FiveM built the resource's file index at start. If the manifest
    -- could only be read through the index, every drop-in install would be
    -- restart-only — which is the mechanism this has to preserve.
    dirs['layouts'][#dirs['layouts'] + 1] = 'DROPPED-IN'
    liveFiles['layouts/DROPPED-IN/module.json'] = encodeTable(layoutFor('DROPPED-IN'))
    modules.clearCache()
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'DROPPED-IN,QRX-720',
        'a module written after start must still be found')
end)

-- 6. load and hasFile

test('load reads a file out of a module folder', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT, { ['ui.html'] = '<div>QRX</div>' })
    assert(modules.load('layouts', 'QRX-720', 'ui.html') == '<div>QRX</div>')
    assert(modules.load('layouts', 'QRX-720', 'absent.html') == nil)
    assert(modules.load('layouts', 'missing', 'ui.html') == nil)
end)

test('hasFile answers for an optional asset, including one added after start', function()
    reset()
    place('layouts', 'QRX-720', LAYOUT, { ['radio.png'] = 'PNG' })
    place('layouts', 'ZTR-540', layoutFor('ZTR-540'),
        { ['radio.png'] = 'PNG', ['radio-dark.png'] = 'PNG' })
    assert(modules.hasFile('layouts', 'ZTR-540', 'radio-dark.png') == true)
    assert(modules.hasFile('layouts', 'QRX-720', 'radio-dark.png') == false,
        'this is the probe that replaced a second marker-file scan')
    -- Added while running: not in the file index, but on disk.
    liveFiles['layouts/QRX-720/radio-dark.png'] = 'PNG'
    assert(modules.hasFile('layouts', 'QRX-720', 'radio-dark.png') == true,
        'a third-party layout that drops a dark image in is still detected')
end)

test('the io.popen fallback still works where the export is absent', function()
    reset()
    exportsAvailable = false
    popenWorks = true
    place('layouts', 'QRX-720', LAYOUT)
    assert(table.concat(modules.scan('layouts', 'layout'), ',') == 'QRX-720')
end)

report(('PASS: %d tlib.modules assertions'):format(passed))
