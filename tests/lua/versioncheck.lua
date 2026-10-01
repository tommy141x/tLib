-- Run from tLib: bunx --package fengari-node-cli fengari tests/lua/versioncheck.lua
-- Executes the actual Lua module with mocked FiveM metadata, HTTP and timers.
local report = print
local passed = 0

local function fixture(authors, name)
    local clock, jobs, output, handlers, requests = 0, {}, {}, {}, {}
    local metadata = { author = authors or {} }
    function GetCurrentResourceName() return name or 'renamed-resource' end
    function GetNumResourceMetadata(_, key) return #(metadata[key] or {}) end
    function GetResourceMetadata(_, key, index)
        if key == 'version' then return '1.0.0' end
        return (metadata[key] or {})[index + 1]
    end
    function GetResourceState() return 'started' end
    function GetGameTimer() return clock end
    function AddEventHandler(event, fn)
        handlers[event] = handlers[event] or {}
        local handle = { fn = fn }
        table.insert(handlers[event], handle)
        return handle
    end
    function RemoveEventHandler(handle) handle.fn = nil end
    function TriggerEvent(event, ...)
        for _, handle in ipairs(handlers[event] or {}) do
            if handle.fn then handle.fn(...) end
        end
    end
    function CreateThread(fn)
        jobs[#jobs + 1] = { at = clock, thread = coroutine.create(fn) }
    end
    function Wait(ms) return coroutine.yield(ms) end
    function PerformHttpRequest(url, cb, method, body, headers)
        requests[#requests + 1] = { url = url, cb = cb, headers = headers }
    end
    -- The module takes the studio-author rule from tLib's real
    -- shared/sh_branding.lua rather than carrying its own copy. Load that exact
    -- file here, per fixture, so these tests are an oracle for the shared rule
    -- itself -- a mocked stand-in would pass while the banner drifted away from
    -- the menu registry's limit exemption, which is the one thing sharing it
    -- exists to prevent. In FiveM the module fetches the same file through
    -- LoadResourceFile; fengari has no io.open, so pre-loading is how the test
    -- reaches it, and the module's guard is written to accept either.
    StudioBranding = nil
    assert(loadfile('shared/sh_branding.lua'))()
    -- Same story for the studio API host: the module takes it from tLib's real
    -- shared/sh_api.lua so `tmarketplace_base_url` is ONE switch -- pointing it
    -- at a dev worker has to move the version check and its changelog too, not
    -- just marketplace installs. Pre-loaded here for the same reason branding is;
    -- the module's guard accepts either. GetConvar is left undefined by default
    -- so the default host is what these assertions see.
    StudioApi = nil
    GetConvar = nil
    assert(loadfile('shared/sh_api.lua'))()
    print = function(line) output[#output + 1] = line end
    json = { decode = function(body) return body end }
    local vc = assert(loadfile('shared/imports/versioncheck/server.lua'))()
    local function run(untilTime)
        while true do
            table.sort(jobs, function(a, b) return a.at < b.at end)
            if not jobs[1] or jobs[1].at > untilTime then break end
            local job = table.remove(jobs, 1)
            clock = job.at
            local ok, delay = coroutine.resume(job.thread)
            assert(ok, delay)
            if coroutine.status(job.thread) ~= 'dead' then
                job.at = clock + delay
                jobs[#jobs + 1] = job
            end
        end
        clock = untilTime
    end
    return { vc = vc, output = output, requests = requests, run = run, metadata = metadata, handlers = handlers,
        text = function() return table.concat(output, '\n') end }
end

local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        report('FAIL ' .. name .. ': ' .. tostring(err))
        os.exit(1)
    end
    passed = passed + 1
    report('PASS ' .. name)
end

local function contains(text, part) assert(text:find(part, 1, true), 'Missing: ' .. part) end
local function excludes(text, part) assert(not text:find(part, 1, true), 'Unexpected: ' .. part) end
local function current(cb) cb({ version = '1.0.0' }) end

test('manifest author enables art even after resource rename', function()
    local f = fixture({ 'Another author', 'TIMMYG Studios' }, 'renamed-folder')
    assert(#f.vc.lean('tDB') == 5)
    f.vc({ name = 'tDB', current = '1.0.0', banner = 'CUSTOM ASCII', fetch = current })
    f.run(1100)
    contains(f.text(), 'CUSTOM ASCII')
    contains(f.text(), 'up to date')
end)

test('display options cannot grant branding to an unrelated resource', function()
    local f = fixture({ 'Another author' }, 'tLib')
    assert(#f.vc.lean('tDB') == 1)
    f.vc({ name = 'tDB', current = '1.0.0', author = 'TIMMYG Studios', banner = 'CUSTOM ASCII', fetch = current })
    f.run(1100)
    excludes(f.text(), 'CUSTOM ASCII')
    contains(f.text(), 'tDB')
    contains(f.text(), 'up to date')
end)

test('missing authors and substring impostors do not enable art', function()
    for _, authors in ipairs({ {}, { 'Not TIMMYG Studios' } }) do
        local f = fixture(authors)
        assert(#f.vc.lean('tDB') == 1)
    end
end)

test('plural author metadata is supported', function()
    local f = fixture({})
    f.metadata.authors = { 'TIMMYG Studios' }
    assert(#f.vc.lean('tDB') == 5)
end)

test('unpublished GitHub resource does not request or claim up-to-date', function()
    local f = fixture({ 'TIMMYG Studios' })
    f.vc({ name = 'tDB', current = '1.0.0', fetch = f.vc.github(nil) })
    f.run(1100)
    assert(#f.requests == 0)
    contains(f.text(), 'GitHub repository not configured')
    excludes(f.text(), 'up to date')
end)

test('GitHub checks the configured repository and renders its release', function()
    local f = fixture({ 'TIMMYG Studios' })
    f.vc({ name = 'tLib', current = '1.0.0', fetch = f.vc.github('tommy141x/tLib') })
    assert(f.requests[1].url == 'https://api.github.com/repos/tommy141x/tLib/releases/latest')
    f.requests[1].cb(200, { tag_name = 'v1.1.0', body = 'Fixed things', html_url = 'https://github.com/tommy141x/tLib/releases/tag/v1.1.0' })
    f.run(1100)
    contains(f.text(), 'v1.1.0')
    contains(f.text(), 'Fixed things')
end)

test('Studios provider queries each product and resolves once', function()
    for _, product in ipairs({ 'tAFK', 'tELS' }) do
        local f = fixture({ 'TIMMYG Studios' })
        f.vc({ name = product, current = '1.0.0', fetch = f.vc.studios(product, '1.0.0') })
        assert(f.requests[1].url == 'https://timmygstudios.com/api/products/' .. product .. '/changelog?since=1.0.0&limit=10')
        f.requests[1].cb(200, { product = { currentVersion = '1.1.0' }, updates = {
            { publishedAt = '2026-01-01', version = '1.1.0', title = 'Fixed things' }
        } })
        f.run(1100)
        contains(f.text(), 'Fixed things')
        local count = #f.output
        f.run(9000)
        assert(#f.output == count)
    end
end)

-- The whole point of tmarketplace_base_url is pointing every studio call at one
-- local dev server. Before this, the provider below hard-coded the host, so an
-- operator testing marketplace installs against localhost still had their
-- version check and changelog hitting production -- exactly the split the convar
-- exists to remove. github() is asserted UNCHANGED in the same test: that one
-- really does point at GitHub and must never follow this convar.
test('Studios provider follows tmarketplace_base_url; GitHub does not', function()
    local f = fixture({ 'TIMMYG Studios' })
    GetConvar = function(name, default)
        if name == 'tmarketplace_base_url' then return 'http://localhost:8787/' end
        return default
    end
    f.vc({ name = 'tELS', current = '1.0.0', fetch = f.vc.studios('tELS', '1.0.0') })
    assert(f.requests[1].url == 'http://localhost:8787/api/products/tELS/changelog?since=1.0.0&limit=10',
        'studios provider ignored the convar: ' .. tostring(f.requests[1].url))

    local g = fixture({ 'TIMMYG Studios' })
    GetConvar = function(name, default)
        if name == 'tmarketplace_base_url' then return 'http://localhost:8787' end
        return default
    end
    g.vc({ name = 'tLib', current = '1.0.0', fetch = g.vc.github('tommy141x/tLib') })
    assert(g.requests[1].url == 'https://api.github.com/repos/tommy141x/tLib/releases/latest',
        'github provider must not follow the marketplace convar')
    GetConvar = nil
end)

-- A value someone pastes out of a browser address bar. The callers append
-- /api/... themselves, so taking it literally would build
-- .../api/v1/api/products/... -- a 404 that reads as a broken dev server.
test('Studios provider trims a trailing /api path off the convar', function()
    local f = fixture({ 'TIMMYG Studios' })
    GetConvar = function(name, default)
        if name == 'tmarketplace_base_url' then return '  http://localhost:8787/api/v1/  ' end
        return default
    end
    f.vc({ name = 'tELS', current = '1.0.0', fetch = f.vc.studios('tELS', '1.0.0') })
    assert(f.requests[1].url == 'http://localhost:8787/api/products/tELS/changelog?since=1.0.0&limit=10',
        'normalisation drifted from shared/sh_api.lua: ' .. tostring(f.requests[1].url))
    GetConvar = nil
end)

test('Studios timeout prints failure without accepting a late result', function()
    local f = fixture({ 'TIMMYG Studios' })
    f.vc({ name = 'tELS', current = '1.0.0', fetch = f.vc.studios('tELS', '1.0.0') })
    f.run(9000)
    contains(f.text(), 'Could not check for updates')
    local count = #f.output
    f.requests[1].cb(200, { product = { currentVersion = '2.0.0' } })
    assert(#f.output == count)
end)

test('tDB forwards initial and subsequent database status through tLib', function()
    local f = fixture({ 'TIMMYG Studios' })
    tlib = { versioncheck = f.vc }
    assert(loadfile('../tDB/server/utils/version.lua'))()
    TriggerEvent('tdb:startupStatus', 'Database ready')
    -- tDB queries its own repository, not PocketBase's. This asserts the real URL
    -- because the interesting failure is a plausible-looking wrong repo, which a
    -- "some request was made" check would pass.
    assert(#f.requests == 1)
    assert(f.requests[1].url == 'https://api.github.com/repos/tommy141x/tDB/releases/latest')
    f.requests[1].cb(200, { tag_name = 'v1.0.0', body = 'Notes', html_url = 'https://github.com/tommy141x/tDB/releases/tag/v1.0.0' })
    f.run(1100)
    contains(f.text(), 'Database ready')
    -- The status line is tDB's, and it keeps flowing after the version check has
    -- resolved -- the two are independent, which is the point of this test.
    TriggerEvent('tdb:startupStatus', 'Database authentication failed')
    contains(f.text(), 'Database authentication failed')
end)

test('all five shipped manifests explicitly credit TIMMYG Studios', function()
    for _, resource in ipairs({ 'tLib', 'tRadio', 'tELS', 'tAFK', 'tDB' }) do
        local authors = {}
        local function author(value)
            if type(value) == 'table' then
                for _, item in ipairs(value) do authors[#authors + 1] = item end
            else authors[#authors + 1] = value end
        end
        local function ignore() return ignore end
        local env = setmetatable({ author = author, authors = author }, {
            __index = function() return ignore end,
        })
        assert(loadfile('../' .. resource .. '/fxmanifest.lua', 't', env))()
        local found = false
        for _, value in ipairs(authors) do if value == 'TIMMYG Studios' then found = true end end
        assert(found, resource .. ' has no studio author')
    end
end)

test('an empty published version is not reported as up to date', function()
    local f = fixture({ 'TIMMYG Studios' })
    f.vc({ name = 'tAFK', current = '2.0.0', fetch = f.vc.studios('tAFK', '2.0.0') })
    f.requests[1].cb(200, { product = { currentVersion = '' } })
    f.run(1100)
    contains(f.text(), 'No published version available')
    excludes(f.text(), 'up to date')
end)

test('duplicate status events do not satisfy other required startup fields', function()
    local f = fixture({ 'TIMMYG Studios' })
    f.vc({ name = 'tRadio', current = '1.0.0', fetch = current, info = {
        { key = 'Status', event = 'status', required = true },
        { key = 'Panel', event = 'panel', required = true },
    } })
    TriggerEvent('status', 'Starting')
    TriggerEvent('status', 'Ready')
    f.run(1100)
    assert(#f.output == 0)
    TriggerEvent('panel', 'http://localhost:7777/dispatch')
    contains(f.text(), 'http://localhost:7777/dispatch')
end)

test('tAFK and tELS startup scripts use the shared provider and info events', function()
    for _, resource in ipairs({ 'tAFK', 'tELS' }) do
        local f = fixture({ 'TIMMYG Studios' }, resource)
        tlib = { versioncheck = f.vc }
        assert(loadfile('../' .. resource .. '/server/sv_version.lua'))()
        contains(f.requests[1].url, '/api/products/' .. resource .. '/changelog')
        f.requests[1].cb(200, { product = { currentVersion = '1.0.0' } })
        TriggerEvent('tafk:vcInfo:sequences', '42 sequences')
        TriggerEvent('tels:vcInfo:configs', '42 configs')
        f.run(1100)
        contains(f.text(), resource == 'tAFK' and '42 sequences' or '42 configs')
        contains(f.text(), 'up to date')
    end
end)

test('version precedence supports abbreviated tags, prereleases and build metadata', function()
    for _, pair in ipairs({
        { 'v6.3', '6.3.1', true }, { '1.0.0-rc.2', '1.0.0-rc.10', true },
        { '1.0.0-rc.1', '1.0.0', true }, { '1.0.0', '1.0.0-rc.1', false },
        { '1.0+42', '1.0.0+99', false }, { '2.0', '1.9.9', false },
        { '1.0.0-alpha', '1.0.0-alpha.1', true },
        { '1.0.0-1', '1.0.0-alpha', true },
    }) do
        local f = fixture({})
        f.vc({ current = pair[1], fetch = function(cb) cb({ version = pair[2] }) end })
        f.run(1100)
        if pair[3] then excludes(f.text(), 'up to date') else contains(f.text(), 'up to date') end
        excludes(f.text(), 'Could not compare')
    end
end)

test('invalid versions cannot claim current or outdated', function()
    for _, version in ipairs({ '', 'unknown', 'release42', '1..2', '1.2.3.4', '01.2.3', '1.0.0-01' }) do
        local f = fixture({})
        f.vc({ current = '1.0.0', fetch = function(cb) cb({ version = version }) end })
        f.run(1100)
        contains(f.text(), 'Could not compare versions')
        excludes(f.text(), 'up to date')
    end
end)

test('first provider result wins while required events are pending', function()
    local f = fixture({})
    local callback
    f.vc({ current = '1.0.0', fetch = function(cb) callback = cb end,
        info = { { key = 'Ready', event = 'ready', required = true } } })
    callback({ version = '1.0.0' })
    callback({ version = '9.0.0' })
    TriggerEvent('ready', 'yes')
    f.run(1100)
    contains(f.text(), 'up to date')
    excludes(f.text(), 'v9.0.0')
end)

test('timeout freezes provider result even before startup settles', function()
    local f = fixture({})
    local callback
    f.vc({ current = '1.0.0', infoTimeout = 100, fetch = function(cb) callback = cb end })
    f.run(200)
    callback({ version = '9.0.0' })
    f.run(1100)
    contains(f.text(), 'Could not check for updates')
    excludes(f.text(), 'v9.0.0')
end)

test('throwing provider and malformed fields still print', function()
    local f = fixture({})
    f.vc({ current = '1.0.0', fetch = function() error('broken') end })
    f.run(1100)
    contains(f.text(), 'Update provider failed')
    f = fixture({})
    f.vc({ current = '1.0.0', fetch = function(cb) cb({ version = '2.0.0', changelog = {}, url = {} }) end })
    f.run(1100)
    contains(f.text(), 'v2.0.0')
end)

test('missing tLib completion and continuous startup noise are bounded', function()
    local f = fixture({})
    -- Reload after overriding the mocked resource state.
    function GetResourceState() return 'starting' end
    local vc = assert(loadfile('shared/imports/versioncheck/server.lua'))()
    vc({ current = '1.0.0', fetch = current })
    for time = 0, 35000, 200 do
        TriggerEvent('onResourceStart', 'other')
        f.run(time)
    end
    contains(f.text(), 'up to date')
end)

test('info event subscriptions are removed only after output is actually drawn', function()
    local f = fixture({})
    f.vc({ current = '1.0.0', fetch = current,
        info = { { key = 'Info', event = 'info' } } })
    assert(f.handlers.info[1].fn)
    TriggerEvent('info', 'Before draw')
    f.run(1100)
    contains(f.text(), 'Before draw')
    assert(not f.handlers.info[1].fn)
    TriggerEvent('info', 'After draw')
    excludes(f.text(), 'After draw')
end)

test('throwing beforePrint does not suppress the tLib completion event', function()
    local f = fixture({}, 'tLib')
    local done = false
    AddEventHandler('tlib:versioncheckDone', function() done = true end)
    f.vc({ current = '1.0.0', fetch = current, beforePrint = function() error('broken hook') end })
    f.run(1100)
    assert(done)
    contains(f.text(), 'beforePrint failed')
    contains(f.text(), 'up to date')
end)

test('tDetector uses shared unpublished-version handling', function()
    local f = fixture({ 'TIMMYG Studios' }, 'tDetector')
    tlib = { versioncheck = f.vc }
    assert(loadfile('../tDetector/server/sv_version.lua'))()
    contains(f.requests[1].url, '/api/products/tDetector/changelog')
    f.requests[1].cb(200, { product = { currentVersion = '' }, updates = {} })
    f.run(1100)
    contains(f.text(), 'No published version available')
    excludes(f.text(), 'up to date')
end)

test('Studios changelogs retain both title and body', function()
    local f = fixture({})
    f.vc({ current = '1.0', fetch = f.vc.studios('tELS', '1.0') })
    f.requests[1].cb(200, { product = { currentVersion = '1.1' }, updates = {
        { version = '1.1', title = 'Summary', body = 'Important details' },
    } })
    f.run(1100)
    contains(f.text(), 'Summary')
    contains(f.text(), 'Important details')
end)

test('radio Lua bridge renders structured update failure without claiming current', function()
    local f = fixture({ 'TIMMYG Studios' }, 'tRadio')
    local env = setmetatable({
        Config = { exposeWeb = false, isSatelliteServer = false },
        tlib = { versioncheck = f.vc },
        LoadResourceFile = function() return nil end,
        SV_FUNCTIONS_VERSION = 2,
    }, { __index = _G })
    assert(loadfile('../tRadio/server/sv_version.lua', 't', env))()
    TriggerEvent('radio:vcInfo:version', { status = 'Network failure' })
    for _, key in ipairs({ 'status', 'panel', 'admin', 'nacid', 'fxver', 'config', 'warnings' }) do
        TriggerEvent('radio:vcInfo:' .. key, '')
    end
    f.run(40000)
    contains(f.text(), 'Network failure')
    excludes(f.text(), 'up to date')
    excludes(f.text(), 'Update available')
end)

report(('Passed %d versioncheck tests'):format(passed))
