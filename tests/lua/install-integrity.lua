-- Run from tLib root: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/install-integrity.lua
--
-- Oracle for the boot-time install check in server/sv_install.lua. tRadio carried the only
-- copy, so a tLib with a missing or damaged bundle was described to tRadio's users and to
-- nobody else, and a file that was PRESENT but cut short (a panel upload tool mangling a
-- binary) passed an existence test and failed later as "syntax error near <\1>".
--
-- The floors are the measured part: the release ships bundle.js at 352,923 bytes, the page
-- script at 574,143 and the stylesheet at 64,357, and each floor sits well under those.

local realPrint = print
local printed = {}
local function out() return table.concat(printed, '\n') end

local passed = 0
local function test(name, fn)
    printed = {}
    print = function(line) printed[#printed + 1] = tostring(line) end
    local ok, err = pcall(fn)
    print = realPrint
    if not ok then
        for _, line in ipairs(printed) do realPrint('  captured: ' .. line) end
        realPrint('FAIL ' .. name .. ': ' .. tostring(err))
        error('suite failed', 0)
    end
    passed = passed + 1
    realPrint('PASS ' .. name)
end

-- The page imports.lua prints to an outdated consumer (imports-min-version.lua pins it there).
-- sv_install.lua once named another account, tommy141, so the boot check linked to a 404.
local RELEASES_URL = 'https://github.com/tommy141x/tLib/releases/latest'

local PAGE = '<script type="module" crossorigin src="./assets/index-39pXhfrw.js"></script>\n'
    .. '<link rel="stylesheet" crossorigin href="./assets/index-_FA5fhix.css">'

--- A complete release, as LoadResourceFile sees it. `override` swaps or removes a file.
local function release(override)
    local files = {
        ['fxmanifest.lua'] = "version '1.1'",
        ['server/dist/bundle.js'] = string.rep('a', 352923),
        ['client/ui/index.html'] = PAGE,
        ['client/ui/assets/index-39pXhfrw.js'] = string.rep('b', 574143),
        ['client/ui/assets/index-_FA5fhix.css'] = string.rep('c', 64357),
        ['client/ui/assets/hud-layout.js'] = string.rep('d', 6450),
    }
    for path, content in pairs(override or {}) do
        if content == false then files[path] = nil else files[path] = content end
    end
    return files
end

--- Load the REAL sv_install.lua against `files`; returns the registered commands.
local function boot(files)
    local commands = {}
    _ENV.GetCurrentResourceName = function() return 'tLib' end
    _ENV.LoadResourceFile = function(_, path) return files[path] end
    _ENV.RegisterCommand = function(name, fn, restricted)
        commands[name] = { fn = fn, restricted = restricted }
    end
    _ENV.GetNumResources = function() return 0 end
    _ENV.GetResourceByFindIndex = function() return nil end
    _ENV.GetNumResourceMetadata = function() return 0 end
    _ENV.GetResourceMetadata = function() return nil end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.GetResourcePath = function() return '/srv/resources/tLib' end
    _ENV.GetConvar = function(_, default) return default end
    _ENV.exports = setmetatable({}, { __index = function() return {} end })
    assert(loadfile('server/sv_install.lua'))()
    return commands
end

test('a complete release says nothing', function()
    boot(release())
    assert(#printed == 0, 'a healthy install must print nothing, got: ' .. out())
end)

test('a source download (no built files) is named as that, with the release page', function()
    boot(release({
        ['server/dist/bundle.js'] = false,
        ['client/ui/assets/index-39pXhfrw.js'] = false,
        ['client/ui/assets/index-_FA5fhix.css'] = false,
        ['client/ui/assets/hud-layout.js'] = false,
    }))
    local text = out()
    assert(text:find('tLib/server/dist/bundle.js: missing', 1, true), text)
    assert(text:find('tLib/client/ui/assets/index-39pXhfrw.js: missing', 1, true), text)
    assert(text:find('green "Code" button', 1, true), text)
    assert(text:find(RELEASES_URL, 1, true), 'expected ' .. RELEASES_URL .. ' in: ' .. text)
    assert(text:find('not "Source code"', 1, true), text)
    assert(text:find('Replace the whole tLib folder, then restart the server', 1, true), text)
end)

test('a bundle that is PRESENT but cut short is damage, not a source download', function()
    -- The velluto case: the file exists and is non-empty, so an existence test passes it.
    boot(release({ ['server/dist/bundle.js'] = string.rep('a', 4096) }))
    local text = out()
    assert(text:find('server/dist/bundle.js: cut short: 4096 bytes', 1, true), text)
    assert(text:find('damaged in transfer', 1, true), text)
    assert(text:find('SFTP', 1, true), text)
    assert(not text:find('green "Code" button', 1, true),
        'a truncated file must not be blamed on the Code button')
end)

test('an empty file is reported as empty', function()
    boot(release({ ['client/ui/assets/index-_FA5fhix.css'] = '' }))
    assert(out():find('index-_FA5fhix.css: empty', 1, true), out())
end)

test('the page script and stylesheet are found through index.html, whatever their hash', function()
    boot(release({
        ['client/ui/index.html'] = PAGE:gsub('39pXhfrw', 'ZZZZZZZZ'),
    }))
    -- The new hash names a file that is not there: that is the point.
    assert(out():find('assets/index-ZZZZZZZZ.js: missing', 1, true), out())
end)

test('the floors are generous: a smaller rebuild of every file still passes', function()
    boot(release({
        ['server/dist/bundle.js'] = string.rep('a', 150000),
        ['client/ui/assets/index-39pXhfrw.js'] = string.rep('b', 200000),
        ['client/ui/assets/index-_FA5fhix.css'] = string.rep('c', 20000),
        ['client/ui/assets/hud-layout.js'] = string.rep('d', 2000),
    }))
    assert(#printed == 0, out())
end)

test('a missing index.html is reported once and does not crash the scan', function()
    boot(release({ ['client/ui/index.html'] = false }))
    assert(out():find('client/ui/index.html: missing', 1, true), out())
end)

test('a VM that cannot read tLib at all stays silent instead of calling a healthy install broken', function()
    local files = release()
    files['fxmanifest.lua'] = nil
    files['server/dist/bundle.js'] = nil
    boot(files)
    assert(#printed == 0, out())
end)

realPrint(('Passed %d install-integrity tests'):format(passed))
