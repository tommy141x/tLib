-- Run from tLib root: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/tlib-version.lua
--
-- Oracle for `tlib_version` (server/sv_install.lua): the one line a customer pastes instead
-- of three screenshots. Four builds of tLib all said "1.1", and "tLib says 1.0 not 1.1"
-- could not be told from a stale manifest cache or a second tLib folder without the path.

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

local PAGE = '<script type="module" crossorigin src="./assets/index-1.js"></script>'

local function world()
    return {
        status = {
            door = 'ingress', listenerState = 'disabled', publicUrlState = 'ready',
            publicUrlOverride = 'unset', reachedFromOutside = false,
            publicUrl = 'http://198.51.100.77:30120',
        },
        resources = {
            tLib = { version = '1.1.2', tlib_build = '20261113-aaaaaaaa', tlib_commit = 'abc1234' },
            tRadio = { version = '7.1', tlib_build = '20261110-bbbbbbbb', tlib_min_version = '1.1.2',
                dependency = { 'tLib' }, state = 'started' },
            tDB = { version = '1.0', tlib_min_version = '1.2', dependency = { 'tLib', 'oxmysql' }, state = 'stopped' },
            tLS = { version = '1.1', dependency = { 'tLib' }, state = 'started' },
            chat = { version = '1.0.0', state = 'started' },
        },
        order = { 'chat', 'tRadio', 'tLib', 'tDB', 'tLS' },
        netPort = '30120',
    }
end

--- Load the REAL sv_install.lua into a stubbed server and return its `tlib_version` command.
local function boot(w)
    local commands = {}
    local files = {
        ['fxmanifest.lua'] = 'x',
        ['server/dist/bundle.js'] = string.rep('a', 200000),
        ['client/ui/index.html'] = PAGE,
        ['client/ui/assets/index-1.js'] = string.rep('b', 200000),
        ['client/ui/assets/hud-layout.js'] = string.rep('c', 5000),
    }
    _ENV.GetCurrentResourceName = function() return 'tLib' end
    _ENV.LoadResourceFile = function(_, path) return files[path] end
    _ENV.RegisterCommand = function(name, fn, restricted) commands[name] = { fn = fn, restricted = restricted } end
    _ENV.GetNumResources = function() return #w.order end
    _ENV.GetResourceByFindIndex = function(i) return w.order[i + 1] end
    _ENV.GetNumResourceMetadata = function(res, key)
        local entry = w.resources[res]
        if not entry then error('no such resource: ' .. tostring(res), 0) end
        local v = entry[key]
        return type(v) == 'table' and #v or (v and 1 or 0)
    end
    _ENV.GetResourceMetadata = function(res, key, index)
        local entry = w.resources[res]
        if not entry then error('no such resource: ' .. tostring(res), 0) end
        local v = entry[key]
        if type(v) == 'table' then return v[(index or 0) + 1] end
        return v
    end
    _ENV.GetResourceState = function(res) return w.resources[res] and w.resources[res].state or 'started' end
    _ENV.GetResourcePath = function() return '/srv/resources/[tScripts]/tLib' end
    _ENV.GetConvar = function(name, default) if name == 'netPort' then return w.netPort end return default end
    _ENV.exports = setmetatable({}, { __index = function()
        return { GetHttpStatus = function()
            if not w.status then error('no export', 0) end
            return w.status
        end }
    end })
    assert(loadfile('server/sv_install.lua'))()
    return commands.tlib_version
end

local function run(w, source)
    local command = boot(w)
    printed = {}
    command.fn(source or 0)
    return out()
end

test('it is registered restricted, and a player source prints nothing', function()
    local command = boot(world())
    assert(command and command.restricted == true, 'tlib_version must be a restricted command')
    printed = {}
    command.fn(12)
    assert(#printed == 0, 'the answer holds a path; only the console may have it, got: ' .. out())
end)

test('one line carries the version, build, commit, path and door', function()
    local first = run(world()):match('^[^\n]+')
    assert(first:find('tLib 1.1.2 build 20261113-aaaaaaaa commit abc1234', 1, true), first)
    assert(first:find('@ /srv/resources/[tScripts]/tLib', 1, true), first)
    assert(first:find('door=ingress listener=disabled netPort=30120 publicUrl=detected reachedFromOutside=no', 1, true), first)
end)

test('no address appears anywhere in it, so it is safe to paste', function()
    local text = run(world())
    assert(not text:find('198.51.100.77', 1, true), 'the detected public IP must not be printed: ' .. text)
    assert(not text:find('http://', 1, true), text)
end)

test('a row per resource that needs tLib, with the verdict on its pin', function()
    local text = run(world())
    assert(text:find('tRadio 7.1 build 20261110-bbbbbbbb | needs tLib >= 1.1.2: ok', 1, true), text)
    assert(text:find('tLS 1.1 | no tlib_min_version', 1, true), text)
    assert(not text:find('chat', 1, true), 'a resource that never mentions tLib is not a consumer')
    assert(text:find('tDB', 1, true) < text:find('tLS 1.1', 1, true)
        and text:find('tLS 1.1', 1, true) < text:find('tRadio 7.1', 1, true), 'rows are sorted by name')
end)

test('a stopped consumer that pinned a newer tLib is listed, as stopped and TOO OLD', function()
    -- What a refusal in imports.lua leaves behind: the resource is stopped, so only a listing
    -- that includes stopped resources can show which pin did it.
    local text = run(world())
    assert(text:find('tDB 1.0 | needs tLib >= 1.2: TOO OLD | stopped', 1, true), text)
end)

test('a build id on tLib separates two copies that both say 1.1', function()
    local w = world()
    w.resources.tLib = { version = '1.1', tlib_build = '20261028-6e6b22fa' }
    w.resources.tRadio.tlib_min_version = '1.1.1'
    local text = run(w)
    assert(text:find('tLib 1.1 build 20261028-6e6b22fa', 1, true), text)
    assert(text:find('needs tLib >= 1.1.1: TOO OLD', 1, true), text)
end)

test('a source checkout has no build or commit and says nothing about them', function()
    local w = world()
    w.resources.tLib = { version = '1.1' }
    local first = run(w):match('^[^\n]+')
    assert(first:find('tLib 1.1 @', 1, true), first)
    assert(not first:find('build', 1, true) and not first:find('commit', 1, true), first)
end)

test('a rejected tlib_http_public_url is named, and a reached panel is reported', function()
    local w = world()
    w.status.publicUrlOverride = 'rejected'
    w.status.reachedFromOutside = true
    local first = run(w):match('^[^\n]+')
    assert(first:find('publicUrl=detected (tlib_http_public_url was rejected)', 1, true), first)
    assert(first:find('reachedFromOutside=yes', 1, true), first)
    w.status.publicUrlOverride = 'used'
    assert(run(w):match('^[^\n]+'):find('publicUrl=override', 1, true))
end)

test('no HTTP bridge is reported as unknown, not as a crash', function()
    local w = world()
    w.status = nil
    local text = run(w)
    assert(text:find('door=unknown (the HTTP bridge is not up) netPort=30120', 1, true), text)
    assert(not text:find('failed partway', 1, true), text)
end)

test('a resource whose manifest cannot be read takes only its own row down', function()
    local w = world()
    w.order = { 'tRadio', 'ghost', 'tLib' }
    local text = run(w)
    -- `ghost` raises on every metadata read, like a resource that is not installed.
    assert(text:find('tLib 1.1.2', 1, true), text)
    assert(text:find('tRadio 7.1', 1, true), text)
    assert(not text:find('failed partway', 1, true), text)
end)

-- sv_install.lua carries its own copy of imports.lua's comparison, because imports.lua must
-- run against a tLib too old to have any new file. Two copies agree only if something makes
-- them: every pair below goes through both.
test('the TOO OLD verdict is the one imports.lua would refuse with', function()
    local combos = {
        { '1.1', '1.1' }, { '1.1', '1.1.1' }, { '1.1.1', '1.1' }, { '1.1.2', '1.1.1' },
        { '1.2', '1.1.9' }, { '0.17', '0.6' }, { '0.6', '0.17' }, { '1.0', '1.0.0' },
        { '2.0', '1.9.9' }, { '1.1', '1.10' }, { 'v1.1', '1.1' },
    }
    for _, pair in ipairs(combos) do
        local installed, required = pair[1], pair[2]
        local w = world()
        w.resources.tLib = { version = installed }
        w.resources.tRadio.tlib_min_version = required
        local diagSaysOld = run(w):find('tRadio 7.1 build 20261110-bbbbbbbb | needs tLib >= '
            .. required .. ': TOO OLD', 1, true) ~= nil

        local stopped = false
        _ENV.tlib = nil
        _ENV.GetCurrentResourceName = function() return 'consumer' end
        _ENV.GetResourceState = function() return 'started' end
        _ENV.GetNumResourceMetadata = function() return 0 end
        _ENV.GetResourceMetadata = function(res, key)
            if key == 'tlib_min_version' then return res == 'consumer' and required or nil end
            if key == 'version' then return res == 'tLib' and installed or nil end
        end
        _ENV.LoadResourceFile = function() return nil end
        _ENV.IsDuplicityVersion = function() return true end
        _ENV.StopResource = function() stopped = true end
        _ENV.exports = setmetatable({}, { __index = function() return {} end })
        local capture = print
        print = function() end
        local loaded = pcall(assert(loadfile('imports.lua')))
        print = capture
        assert(not loaded == stopped, 'a refusal must stop the consumer')
        assert(diagSaysOld == stopped,
            ('tLib %s vs pin %s: tlib_version says TOO OLD=%s but imports.lua refuses=%s')
                :format(installed, required, tostring(diagSaysOld), tostring(stopped)))
    end
end)

realPrint(('Passed %d tlib_version tests'):format(passed))
